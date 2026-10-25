"""Follow-through helpers for the "flow" campaign: a tracing fake AI, a text-level (AutoInjector-style) fake that
can mangle answers like a real web model, export text extraction (PDF/EPUB/DOCX) and record lookups."""
from __future__ import annotations

import copy
import io
import json
import re
import sqlite3
import shutil
import sys
import time
import types
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TESTS = HERE.parent.parent
for p in (str(TESTS), str(TESTS.parent)):
    if p not in sys.path:
        sys.path.insert(0, p)

from autobook_fake import BookFakeAI, fact  # noqa: E402

from akowe import providers as prov_mod  # noqa: E402
from akowe.book_path import BookPath  # noqa: E402
from akowe.exporters.book import parse_chapter  # noqa: E402
from akowe.jobs import RetryPolicy  # noqa: E402
from akowe.providers import AutoInjectorAdapter  # noqa: E402
from akowe.server import App  # noqa: E402

TOKEN = "flow-test-token-0123456789"


def quiet_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def plan_item(item_id, order, objective, pov, loc):
    facts = [fact(item_id, "plan.item_id", item_id, "PLAN"), fact(item_id, "plan.order", order, "PLAN"),
             fact(item_id, "plan.parent_id", None, "PLAN"), fact(item_id, "plan.objective", objective, "PLAN"),
             fact(item_id, "plan.event_ids", [], "PLAN"), fact(item_id, "plan.pov_id", pov, "PLAN"),
             fact(item_id, "plan.location_id", loc, "PLAN"), fact(item_id, "plan.obligation_ids", [], "PLAN")]
    return {"summary": f"{item_id}: {objective}", "facts": facts, "links": []}


def objective_marker(cid):
    return f"OBJ-{cid}-MARK"


class TraceAI(BookFakeAI):
    """BookFakeAI whose outline objectives carry markers and whose chapters echo the chapter id and the objective
    marker they were asked to write (so the outline -> prose -> export chain can be traced).

    overrides: kind -> callable(ctx, default_out) -> out (replace an answer); outline_n forces the chapter count.
    """

    def __init__(self, verdicts=None, default_verdict="APPROVE", outline_n=None, overrides=None):
        super().__init__(verdicts, default_verdict)
        self.outline_n = outline_n
        self.overrides = dict(overrides or {})
        self.contexts: list[tuple[str, dict]] = []
        self.chapter_versions: dict[str, int] = {}

    def _answer(self, ctx, props, schema):
        kind, out = self._trace_answer(ctx, props, schema)
        with self.lock:
            self.contexts.append((kind, ctx))
        fn = self.overrides.get(kind)
        if fn is not None:
            out = fn(ctx, copy.deepcopy(out))
        return kind, out

    def _trace_answer(self, ctx, props, schema):
        if "verdict" in props:
            return super()._answer(ctx, props, schema)
        if "chapters" in props and "objective_assessments" not in props and "verdict" not in props \
                and "draft" not in ctx:
            req = ctx.get("request_payload") or {}
            n = self.outline_n or ((req.get("target_length") or {}).get("value")) or 3
            pov, loc = self._canon_ids(ctx)
            return "B11", {"chapters": [plan_item(f"ch{i + 1}", i, f"{objective_marker(f'ch{i + 1}')} Mara takes "
                                                  f"step {i + 1} of the search", pov, loc) for i in range(int(n))],
                           "unresolved_threads": []}
        if "objective_assessments" in props:
            req = ctx.get("request_payload") or {}
            cid = req.get("chapter_id") or "ch1"
            instr = req.get("instruction") or ""
            m = re.search(r"OBJ-[A-Za-z0-9_-]+-MARK", instr)
            mark = m.group(0) if m else "NO-OBJECTIVE-MARKER"
            with self.lock:
                self.chapter_versions[cid] = self.chapter_versions.get(cid, 0) + 1
            paras = [f"[{cid}/p1] {mark}. The fog rolled over Gullhaven as Mara climbed toward the light.",
                     f"[{cid}/p2] She counted the steps and listened to the sea below the reef.",
                     f"[{cid}/p3] By nightfall the harbor knew what she had found."]
            return "C02", {"text": "\n\n".join(paras),
                           "objective_assessments": [{"item_id": cid, "decision": "PASS", "message": "reached"}]}
        return super()._answer(ctx, props, schema)


class TextBridgeAI(AutoInjectorAdapter):
    """A web-model stand-in: answers come back as TEXT and go through the real AutoInjector parsing (JSON
    extraction from prose/fences, schema check, re-asks). render(kind, data, reask) -> text mangles answers."""

    def __init__(self, brain: BookFakeAI, render=None):
        super().__init__("fake-token-xxxxxxxx", "http://127.0.0.1:17891")
        self.brain = brain
        self.render = render or (lambda kind, data, reask: json.dumps(data, ensure_ascii=False))
        self.texts: list[tuple[str, str]] = []
        self._cur = None

    def submit(self, slot, system, user, schema, *, request_id=None, attempt=0, deadline=None, call=0):
        self._cur = (slot, system, user, schema)
        slot = dict(slot, site=slot.get("site") or "claude")  # answer like a logged-in web site
        return super().submit(slot, system, user, schema, request_id=request_id, attempt=attempt, deadline=deadline,
                              call=call)

    def _call(self, method, path, body, timeout_s):
        slot, system, user, schema = self._cur
        reask = "Your previous answer was rejected" in (body or {}).get("prompt", "")
        data, _usage = self.brain.submit(slot, system, user, schema)
        kind = self.brain.kinds[-1] if self.brain.kinds else "?"
        text = self.render(kind, data, reask)
        self.texts.append((kind, text))
        # like the real bridge: the [MSG #] the prompt was typed as, and the one the reply answers (BF-01)
        seq = f"{len(self.texts):04d}"
        return {"ok": True, "text": text, "seq": seq, "reply_to": seq}


def make_app(tmp_path, name="data", fake=None):
    app = App(tmp_path / name, token=TOKEN)
    app.engine.providers.secret_path = tmp_path / "secrets.json"
    if fake is not None:
        app.engine.providers.test_adapter = fake
        app.engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic", "api_key": "sk-fake-flow-key"})
    fast = RetryPolicy([0.01, 0.02], 1)
    app.autobook.retry_policy = fast
    app.write_all.retry_policy = fast
    app.assist.retry_policy = fast
    return app


def run_book(app, body=None, timeout=120):
    r = app.autobook.start("author", dict({"author_confirms": True}, **(body or {})))
    app.autobook.wait_for(r["id"], timeout)
    return app.autobook.public(app.autobook.get(r["id"]))


def wait_run(app, run_id, timeout=120):
    app.autobook.wait_for(run_id, timeout)
    return app.autobook.public(app.autobook.get(run_id))


def steps_of(run):
    return {s["id"]: s for s in run["steps"]}


def bp_of(app, pid, principal="author"):
    return BookPath(app.engine, principal, pid, "main")


def heads(app, pid, op):
    return [r for r in app.store.list_records(pid, "main") if r["module_id"] == op]


def snapshot_data(app, src: Path, dst: Path):
    """A crash-consistent copy of a live data folder (committed SQLite state + asset files), as if the power went
    off at this moment."""
    dst.mkdir(parents=True, exist_ok=True)
    (dst / "assets").mkdir(exist_ok=True)
    for f in (src / "assets").iterdir():
        shutil.copy2(f, dst / "assets" / f.name)
    s = sqlite3.connect(src / "akowe.sqlite3", timeout=30)
    d = sqlite3.connect(dst / "akowe.sqlite3")
    s.backup(d)
    d.close()
    s.close()


# ------------------------------------------------------------------------------------------- exports
def norm(s: str) -> str:
    return " ".join((s or "").split())


def approved_chapters(app, pid):
    """[(chapter_id, approved C02 record)] in outline order, from the book path."""
    bp = bp_of(app, pid)
    st = {s["id"]: s for s in bp.status()["steps"]}
    out = []
    for c in st["chapters"].get("chapters") or []:
        a = c.get("approved")
        out.append((c["chapter_id"], bp.rec(a["record_id"], a["version"]) if a else None))
    return out


def expected_paragraphs(text: str) -> list[str]:
    _title, blocks = parse_chapter("x", text)
    return [norm(b["text"]) for b in blocks if b["t"] in ("p", "h2")]


def export_files(app, pid, run_files=None):
    bp = bp_of(app, pid)
    files = run_files
    if files is None:
        files = {s["id"]: s for s in bp.status()["steps"]}["export"]["files"]
    out = {}
    for f in files:
        rec = app.store.get_record(pid, "main", f["record_id"], f["version"])
        out[f["format"]] = app.store.read_binary(rec)
    return out


def pdf_info(data: bytes) -> dict:
    from pypdf import PdfReader  # noqa: PLC0415
    r = PdfReader(io.BytesIO(data))
    pages = [p.extract_text() or "" for p in r.pages]
    return {"pages": pages, "text": norm(" ".join(pages)), "meta": dict(r.metadata or {})}


def epub_info(data: bytes) -> dict:
    from lxml import etree  # noqa: PLC0415
    z = zipfile.ZipFile(io.BytesIO(data))
    ns = {"opf": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/",
          "x": "http://www.w3.org/1999/xhtml", "epub": "http://www.idpf.org/2007/ops"}
    opf_name = next(n for n in z.namelist() if n.endswith(".opf"))
    opf = etree.fromstring(z.read(opf_name))
    base = opf_name.rsplit("/", 1)[0] + "/" if "/" in opf_name else ""
    manifest = {i.get("id"): i.get("href") for i in opf.findall(".//opf:manifest/opf:item", ns)}
    spine = [manifest[i.get("idref")] for i in opf.findall(".//opf:spine/opf:itemref", ns)]
    chapters, paras, scripts = [], [], 0
    for href in spine:
        doc = etree.fromstring(z.read(base + href))
        scripts += len(doc.findall(".//x:script", ns))
        for sec in doc.findall(".//x:section", ns):
            if sec.get("{http://www.idpf.org/2007/ops}type") == "chapter":
                h = sec.find("x:h1", ns)
                ps = [norm("".join(p.itertext())) for p in sec.iter("{http://www.w3.org/1999/xhtml}p",
                                                                      "{http://www.w3.org/1999/xhtml}h2")]
                chapters.append({"href": href, "heading": norm("".join(h.itertext())) if h is not None else None,
                                 "paras": ps})
                paras += ps
    nav_href = next(i.get("href") for i in opf.findall(".//opf:manifest/opf:item", ns)
                    if "nav" in (i.get("properties") or ""))
    nav = etree.fromstring(z.read(base + nav_href))
    toc = nav.find(".//x:nav[@epub:type='toc']", ns)
    nav_entries = [(norm("".join(a.itertext())), a.get("href")) for a in toc.iter("{http://www.w3.org/1999/xhtml}a")]
    meta = {"title": [norm(t.text) for t in opf.findall(".//dc:title", ns)],
            "creator": [norm(t.text) for t in opf.findall(".//dc:creator", ns)]}
    return {"spine": spine, "chapters": chapters, "paras": paras, "nav": nav_entries, "meta": meta,
            "scripts": scripts, "names": z.namelist()}


def docx_info(data: bytes) -> dict:
    import docx  # noqa: PLC0415
    d = docx.Document(io.BytesIO(data))
    paras = [(p.style.name if p.style is not None else "", norm(p.text)) for p in d.paragraphs]
    return {"paras": paras, "texts": [t for _s, t in paras if t],
            "headings": [t for s, t in paras if s.lower().startswith("heading") and t],
            "meta": {"title": d.core_properties.title, "author": d.core_properties.author}}


def count_sub(haystack: list[str], needle: list[str]) -> int:
    """How many times the paragraph sequence `needle` appears contiguously in `haystack`."""
    n, k = len(haystack), len(needle)
    return sum(1 for i in range(n - k + 1) if haystack[i:i + k] == needle) if k else 0
