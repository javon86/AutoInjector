"""📖 Book Bible binder in the browser (#/p/<pid>/<b>/bible): the author's template studio design drawn from the binder data
contract (GET …/binder, see pc-work/binder/PLAN.md). The API is served from tests/fixtures/binder_sample.json by
intercepting the request, so these tests do not depend on the Python data side.

Checks: every template (1–12, 8A/8B/8C) renders with its section headings; empty fields show placeholders; the 🎨 Look
switch changes the theme (and every look keeps WCAG AA text contrast and prints on light paper); the print stylesheet hides
the app chrome; search finds a character; the relationship map SVG has typed lines; navigation (contents, prev/next,
one/all pages, deep link); the ⬇ PDF / ⬇ Word buttons show the API's plain error; no horizontal scroll at 390/1280/1920;
no console errors. Screenshots go to $BF_UI_SHOTS (see ui_helpers.shot)."""
from __future__ import annotations

import json
import re
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

from .ui_helpers import ROOT, assert_clean, bad_text, overflow, settle, shot, unnamed_controls, watch

from test_failover_review import SlotFake, make_app
from test_server import TOKEN

FIXTURE = ROOT / "tests" / "fixtures" / "binder_sample.json"
SCHEMA_JS = ROOT / "akowe" / "web" / "binder-schema.js"
LOOKS = ["classic", "fantasy", "scifi", "noir", "romance", "horror", "playful"]


def schema():
    s = SCHEMA_JS.read_text(encoding="utf-8")
    return json.loads(s[s.index("SCHEMA = ") + 9:s.rindex(";")])


@pytest.fixture
def bd(tmp_path):
    from akowe.book_path import save_profile
    from akowe.server import make_handler
    app = make_app(tmp_path, SlotFake(), slots=("AI-1",))
    pid = app.engine.bootstrap_project("author", "Lamplighter UI book")
    save_profile(app.store, pid, {"title": "The Lamplighter's Last Ferry", "author": "Imogen Achterberg", "genre": "Fantasy",
                                  "idea": "A girl who lights the lamps of a drowning city has one night left."})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    yield SimpleNamespace(app=app, pid=pid, base=f"http://127.0.0.1:{port}/", url=f"http://127.0.0.1:{port}/#token={TOKEN}")
    httpd.shutdown()
    httpd.server_close()


def fixture_doc(pid, **book):
    doc = json.loads(FIXTURE.read_text(encoding="utf-8").replace("#/p/PID/", f"#/p/{pid}/"))
    doc["book"].update(book)
    return doc


BOOK_SOURCES = {"auto:series_line": ["series", "series_number"], "auto:themes": ["themes"], "auto:theme_1": ["themes"],
                "auto:theme_2": ["themes"], "auto:theme_3": ["themes"]}


def stored_fields(doc, target):
    """(key, field) pairs of the doc that hold the binder's own 🆕 value `key` of `target` (what PUT …/binder/fields changes)."""
    for p in doc["pages"]:
        page_target = p.get("target") or ("book" if p["template"] in ("1", "2", "3", "4", "10", "12") else None)
        for sec in p["sections"].values():
            for f in sec["fields"].values():
                if f.get("repeat") or f.get("unavailable"):
                    continue
                src = f.get("source", "")
                edit = f.get("edit") or {}
                t = edit.get("target") or (("book" if src in BOOK_SOURCES else page_target) if (src.startswith("new:") or src in BOOK_SOURCES) else None)
                keys = [edit["field"]] if edit.get("target") else [src[4:]] if src.startswith("new:") else BOOK_SOURCES.get(src, [])
                if t == target:
                    for k in keys:
                        yield k, f
            for r in sec.get("rows", []):
                f = r.get("5.8.3")
                if f and (r.get("_meta") or {}).get("target") == target:
                    yield "type", f


class FakeBinderApi:
    """The binder API of the data side, answered from the fixture (a copy that edits, approvals and fills change)."""

    def __init__(self, doc, export=None, status=200):
        self.doc, self.export, self.status = doc, export, status
        self.looks, self.exports, self.puts, self.approves, self.dismisses, self.fills = [], [], [], [], [], []
        self.jobs = {}

    def set(self, target, values, status):
        for k, f in stored_fields(self.doc, target):
            if k not in values:
                continue
            v = values[k]
            if v in (None, "", []):
                f.update(value="", status="empty")
                f.pop("edit", None)
                continue
            f.update(value=" · ".join(v) if isinstance(v, list) else str(v), status=status)
            f["edit"] = {"route": "#/p/x/main/binder", "field": k, "target": target, "api": "PUT …/binder/fields"}

    def series_api(self, req, path, body, ok):
        """📚 GET …/binder/series, POST …/series/find (a job), …/approve, …/dismiss, …/sequel."""
        sv = self.series_view
        self.series_calls = getattr(self, "series_calls", []) + [(req.method, path, body)]
        if req.method == "GET" and path == "/series":
            return ok(sv)
        if req.method == "POST" and path == "/series/find":
            for c in sv["characters"]:
                if c["key"] == "c1":
                    c["strip"][-1]["proposal"] = {"appearance": [{"text": "a burn scar on her right hand"}]}
                    c["strip"][-1]["proposal_words"] = "Appearance: a burn scar on her right hand"
            sv["proposals_here"] = sv["proposals"] = 1
            self.jobs["job-series-1"] = {"job_id": "job-series-1", "kind": "series_changes", "status": "done", "phase": "Finished",
                                         "done": 1, "total": 1, "results": [{"ok": True, "proposed": 1, "message": "The AI proposed changes for 1 character(s). Read them and ✔ approve the ones that are right (nothing is used before you approve)."}]}
            return ok(dict(self.jobs["job-series-1"], status="running", done=0), 202)
        if req.method == "POST" and path in ("/series/approve", "/series/dismiss"):
            for c in sv["characters"]:
                if c["key"] == body.get("key"):
                    b = c["strip"][-1]
                    if path.endswith("approve"):
                        b["changes"], b["words"] = b["proposal"], b["proposal_words"]
                    b["proposal"], b["proposal_words"] = None, ""
            sv["proposals_here"] = sv["proposals"] = 0
            return ok({"ok": True, "key": body.get("key"), "portrait_needed": False})
        if req.method == "POST" and path == "/series/sequel":
            return ok({"run": {"id": "run-seq1"}, "sequel": {"number": 3},
                       "message": "📚 Book 3 has started: “The Ferry Books: Book 3”. Its characters start as they were at the end of “The Lamplighter's Last Ferry”."}, 202)
        return ok({"errors": [{"code": "NOT_FOUND", "path": "/", "message": "not found"}]}, 404)

    def values(self, target):
        out = {}
        for k, f in stored_fields(self.doc, target):
            out.setdefault(k, {"value": f["value"] or None, "status": f["status"] if f["value"] else "supplied", "protected": False, "new": True})
        return out

    def handle(self, route):
        req = route.request
        path = req.url.split("/binder", 1)[-1] if "/binder" in req.url else req.url
        body = json.loads(req.post_data or "{}") if req.method in ("PUT", "POST") else {}
        ok = lambda obj, code=200: route.fulfill(status=code, content_type="application/json", body=json.dumps(obj))  # noqa: E731
        if "/review/ai/" in req.url:
            return ok(self.jobs[req.url.rsplit("/", 1)[-1]])
        if req.method == "PUT" and path == "/look":
            self.looks.append(body)
            return ok({"ok": True, "look": body.get("look")})
        if path.startswith("/export"):
            self.exports.append(req.url)
            err = self.export or {"code": "CAPABILITY_UNAVAILABLE", "path": "/format", "problem": "RENDER_NOT_WIRED",
                                  "message": "Making the PDF needs AutoInjector's page renderer, which is not connected.",
                                  "fix": "Open AutoInjector to make the PDF, or use 🖨 Print → Save as PDF"}
            return ok({"errors": [err]}, 503)
        if path.startswith("/fields?"):
            target = path.split("target=", 1)[1].split("&")[0]
            from urllib.parse import unquote
            target = unquote(target)
            return ok({"target": target, "fields": self.values(target), "info": self.doc["fields_info"]})
        if req.method == "PUT" and path == "/fields":
            self.puts.append(body)
            self.set(body["target"], body["fields"], "supplied")
            return ok({"ok": True, "fields": self.values(body["target"])})
        if req.method == "POST" and path in ("/fields/approve", "/fields/dismiss"):
            (self.approves if path.endswith("approve") else self.dismisses).append(body)
            for k, f in stored_fields(self.doc, body["target"]):
                if k in body.get("fields", []) and f["status"] == "proposed":
                    if path.endswith("approve"):
                        f["status"] = "approved"
                    else:
                        f.update(value="", status="empty")
            return ok({"ok": True})
        if req.method == "POST" and path == "/fill":
            self.fills.append(body)
            for t in body.get("targets") or ["character:rec-maren"]:
                if t == "character:rec-maren":
                    self.set(t, {"height": "1.62 m (5 ft 4 in)", "handedness": "right"}, "proposed")
            jid = f"job-{len(self.fills)}"
            self.jobs[jid] = {"job_id": jid, "kind": "binder_fill", "status": "done", "phase": "Reading Maren Vey", "done": 1, "total": 1,
                              "results": [{"ok": True, "proposed": 2, "message": "2 value(s) proposed from the book. Read them, then ✔ approve or ✎ edit each one."}]}
            return ok(dict(self.jobs[jid], status="running", done=0), 202)
        if req.method == "POST" and path == "/pictures":  # 🖼 Make the rest of the pictures
            self.pictures = getattr(self, "pictures", 0) + 1
            for p in self.doc["pages"]:
                p.pop("pictures_waiting", None)
            jid = f"job-pics-{self.pictures}"
            self.jobs[jid] = {"job_id": jid, "kind": "book_pictures", "status": "done", "phase": "Finished", "done": 5, "total": 5,
                              "results": [{"ok": True, "made": 5, "failed": 0, "message": "5 picture(s) made."}]}
            return ok(dict(self.jobs[jid], status="running", done=0, phase="Making the portrait of “Maren Vey”"), 202)
        if path.startswith("/series"):  # 📚 series progression
            return self.series_api(req, path, body, ok)
        if path.startswith("?as_of=") and getattr(self, "as_of_docs", None):
            self.as_of_calls = getattr(self, "as_of_calls", []) + [path]
            return ok(self.as_of_docs[path.split("=", 1)[1].split("&")[0]])
        if self.status != 200:
            return ok({"errors": [{"code": "NOT_FOUND", "path": "/", "message": "not found"}]}, self.status)
        return ok(self.doc)


def serve_binder(page, pid, doc=None, export=None, status=200):
    """Answer the binder API (GET …/binder, …/look, …/fields, …/fill, …/export, …/review/ai/<job>) from the fixture."""
    fake = FakeBinderApi(doc or fixture_doc(pid), export, status)
    page.route(re.compile(r"/api/projects/[^/]+/branches/[^/]+/(binder(/|\?|$)|review/ai/job-)"), fake.handle)
    return fake


def open_binder(make_context, bd, width=1280, height=900, look=None, mode=None, page_id=None, doc=None, status=200):
    ctx = make_context(width=width, height=height)
    keep = {k: v for k, v in (("look", look), ("mode", mode)) if v}
    if keep:
        ctx.add_init_script(f"try {{ localStorage.setItem('bf:binder:{bd.pid}:main', {json.dumps(json.dumps(keep))}); }} catch (e) {{}}")
    page = watch(ctx.new_page())
    calls = serve_binder(page, bd.pid, doc, status=status)
    page.goto(bd.url)
    page.wait_for_selector("#main h1", timeout=15000)
    settle(page)
    page.evaluate("h => { location.hash = h; }", f"#/p/{bd.pid}/main/bible" + (f"/{page_id}" if page_id else ""))
    if status == 200:
        page.wait_for_selector(".bnd-page" + (f'[data-page-id="{page_id}"]' if page_id else ""), timeout=15000)
    else:
        page.wait_for_selector("#main .state", timeout=15000)
    images_ready(page)
    page.bf_calls = calls
    return page


def images_ready(page):
    page.wait_for_function("() => !document.querySelector('#main .state.loading, [data-img-loading]')", timeout=15000)
    page.wait_for_timeout(150)


def goto_page(page, page_id):
    page.click(f'.bnd-rail a[data-goto="{page_id}"] >> nth=-1')
    page.wait_for_selector(f'.bnd-page[data-page-id="{page_id}"]', timeout=10000)
    images_ready(page)


def heading_words(name):
    """The words of a schema section name without its icon, e.g. '📋 Quick stats' -> 'Quick stats'."""
    return re.sub(r"^[^\w\"]+", "", name).strip()


# ------------------------------------------------------------------------------------------------ the fixture itself
def test_fixture_follows_the_contract():
    sch = schema()
    doc = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert doc["schema_version"] == 1 and set(doc["book"]) >= {"title", "author", "genre", "look", "look_default", "look_stored", "looks"}
    assert set(doc) >= {"pages", "contents", "todo", "counts", "fields_info"}
    assert {p["template"] for p in doc["pages"]} == set(sch), "every template has at least one page"
    for p in doc["pages"]:
        assert p["status"] in ("approved", "draft", "needs_you")
        assert set(p) >= {"template", "entry_id", "title", "page_id", "page", "status", "icon", "sections", "pics"}
        for code, _name, repeat, fields in sch[p["template"]][1]:
            sec = p["sections"][code]
            ids = {f[0] for f in fields}
            assert set(sec["fields"]) == ids, f"{p['page_id']} {code}: every field id is present"
            if repeat:
                assert "rows" in sec, f"{p['page_id']} {code}: a repeating section has rows"
                assert all(f.get("repeat") is True for f in sec["fields"].values()), "placeholders only; the data is in rows"
                for row in sec["rows"]:
                    assert {k for k in row if not k.startswith("_")} == ids
            for f in [f for f in sec["fields"].values() if not f.get("repeat")] + [f for r in sec.get("rows", []) for k, f in r.items() if not k.startswith("_")]:
                assert f["status"] in ("approved", "proposed", "supplied", "empty", "auto")
                assert (f["status"] == "empty") == (f["value"] in ("", [])), f
    assert [c["page"] for c in doc["contents"]] == sorted(c["page"] for c in doc["contents"])


# ------------------------------------------------------------------------------------------------ templates
def test_every_template_renders_with_its_section_headings(make_context, bd):
    sch = schema()
    doc = fixture_doc(bd.pid)
    page = open_binder(make_context, bd, mode="all")
    assert page.get_attribute("[data-testid=binder]", "data-mode") == "all"
    assert page.locator(".bnd-page").count() == len(doc["pages"]) == 22
    seen = set()
    for p in doc["pages"]:
        art = page.locator(f'.bnd-page[data-page-id="{p["page_id"]}"]')
        assert art.count() == 1, p["page_id"]
        assert art.get_attribute("data-template") == p["template"]
        for code, name, _repeat, _fields in sch[p["template"]][1]:
            h3 = art.locator(f'section[data-sec="{code}"] > header h3')
            assert h3.count() == 1, f"{p['page_id']}: section {code} missing"
            assert heading_words(name) in h3.text_content(), f"{p['page_id']} {code}: {h3.text_content()!r}"
        # header strip (book title · page title · status badge) and footer (book title · page number)
        assert "Lamplighter" in art.locator(".bnd-runhead").text_content()
        assert art.locator(".bnd-runhead .bnd-badge").count() == 1
        assert f"Page {doc['pages'].index(p) + 1} of 22" in art.locator(".bnd-foot").inner_text()
        seen.add(p["template"])
    assert seen == set(sch)
    # the designed parts of the studio are there
    odile = page.locator('.bnd-page[data-page-id="ch-odile"]')
    assert odile.locator(".bnd-facts .bnd-fact[data-fid]").count() == 16        # 📋 quick stats fact sheet
    assert odile.locator(".bnd-facts .bnd-fact-role").count() == 1             # + the story role row
    assert odile.locator(".bnd-bar").count() == 5                               # stat bars 1–10
    assert odile.locator('.bnd-bar[data-fid="5.9.9"] .bnd-bar-track i.on').count() == 9
    assert odile.locator(".bnd-rel").count() == 4                               # relationship rows
    assert odile.locator(".bnd-timeline li").count() == 5                       # backstory timeline
    assert odile.locator(".bnd-quote").count() == 2                             # voice card quote boxes
    assert odile.locator(".bnd-band img").count() == 1                          # main portrait
    assert page.locator('.bnd-page[data-page-id="plan"] svg.bnd-plot circle').count() == 8   # plot line
    assert page.locator('.bnd-page[data-page-id="cp-01"] .bnd-scene').count() == 2           # scene cards
    assert page.locator('.bnd-page[data-page-id="mg-wickcraft"] .bnd-sec-rules').count() == 1  # hard rules box
    assert page.locator('.bnd-page[data-page-id="map"] .bnd-pin').count() == 3               # numbered markers
    assert page.locator('.bnd-page[data-page-id="pl-vessmoor"] .bnd-pips i.on').count() == 3  # danger 3/5
    assert page.locator('.bnd-page[data-page-id="cast"] .bnd-card').count() == 5
    # every field value is shown somewhere on its page
    for pid_, fid, text in (("ch-odile", "5.2.5", "1.68 m"), ("ch-odile", "5.7.11", "A lamp's just a promise"),
                            ("ar-ember", "8B.2.4", "Odile Marsh"), ("rules", "12.6.6", "UK"), ("glance", "3.7.5", "Is a memory still yours")):
        assert text in page.locator(f'.bnd-page[data-page-id="{pid_}"] [data-fid="{fid}"]').first.inner_text()
    assert not bad_text(page, "#main"), bad_text(page, "#main")
    assert not unnamed_controls(page)
    assert_clean(page, "all pages")


def test_empty_fields_show_placeholders_and_edit_links(make_context, bd):
    page = open_binder(make_context, bd, page_id="ch-maren")
    art = page.locator('.bnd-page[data-page-id="ch-maren"]')
    txt = art.inner_text()
    assert "Not filled yet — ✨ Fill from the book" in txt
    assert "No portrait yet — 🎨 Make one" in txt
    assert "No backstory events yet — ✨ Fill from the book" in txt
    # every empty field shows a placeholder (never a blank box)
    empties = art.locator(".bnd-f[data-st=empty], .bnd-fact[data-st=empty]")
    assert empties.count() > 60
    assert page.evaluate("""() => [...document.querySelectorAll('.bnd-page .bnd-f[data-st=empty], .bnd-page .bnd-fact[data-st=empty]')]
        .filter(e => !e.querySelector('.bnd-empty')).length""") == 0
    # the placeholder links and the ✏ Edit buttons open the record in Akọwe (the contract's `edit.route`)
    fill = art.locator("a.bnd-fill").first
    assert fill.get_attribute("href") == f"#/p/{bd.pid}/main/forge/rec-maren"
    edits = art.locator("a.bnd-edit")
    assert edits.count() == 14 and edits.first.get_attribute("href") == f"#/p/{bd.pid}/main/forge/rec-maren"
    # status badges: page ⚠ Needs you; an empty section ⚠ Needs you; Odile's proposals ✎ Draft, approved sections ✔ Approved
    assert "Needs you" in art.locator(".bnd-runhead .bnd-badge").text_content()
    assert "Needs you" in art.locator('section[data-sec="5.4"] .bnd-badge').text_content()
    goto_page(page, "ch-odile")
    odile = page.locator('.bnd-page[data-page-id="ch-odile"]')
    assert "Draft" in odile.locator('section[data-sec="5.2"] .bnd-badge').text_content()
    assert "Approved" in odile.locator('section[data-sec="5.5"] .bnd-badge').text_content()
    assert odile.locator('.bnd-fact.is-proposed[data-fid="5.2.5"] .bnd-prop').count() == 1
    # field numbers are hidden until the author asks for them
    fid = odile.locator('.bnd-fact[data-fid="5.2.5"] .bnd-fid').first
    assert not fid.is_visible()
    page.check("[data-testid=binder-fids]")
    assert fid.is_visible() and fid.inner_text() == "5.2.5"
    shot(page, "binder-fields-numbers")
    assert_clean(page, "placeholders")


# ------------------------------------------------------------------------------------------------ looks
def test_look_auto_pick_switch_and_persist(make_context, bd):
    page = open_binder(make_context, bd)
    root = "[data-testid=binder]"
    assert page.get_attribute(root, "data-look") == "fantasy"      # book.look
    paper = lambda: page.evaluate("() => getComputedStyle(document.querySelector('.bnd-page')).backgroundColor")  # noqa: E731
    before = paper()
    page.select_option("[data-testid=binder-look]", "scifi")
    page.wait_for_function("() => document.querySelector('[data-testid=binder]').dataset.look === 'scifi'")
    assert paper() != before
    assert page.bf_calls.looks == [{"look": "scifi"}]
    page.select_option("[data-testid=binder-look]", "fantasy")          # the genre's own look again: stored as null
    page.wait_for_function("() => document.querySelector('[data-testid=binder]').dataset.look === 'fantasy'")
    assert page.bf_calls.looks[-1] == {"look": None}
    page.select_option("[data-testid=binder-look]", "scifi")
    assert page.locator(".bnd-page svg.bnd-corner").count() == 4
    page.reload()
    page.wait_for_selector(".bnd-page", timeout=15000)
    assert page.get_attribute(root, "data-look") == "scifi"          # remembered on this computer meanwhile
    assert_clean(page, "look switch")
    # no stored look: picked from the genre
    for genre, look in (("Mystery", "noir"), ("Children’s picture book", "playful"), ("Science fiction", "scifi"), ("Romance", "romance"),
                        ("Horror", "horror"), ("Historical", "classic"), ("Something new", "classic")):
        p2 = open_binder(make_context, bd, doc=fixture_doc(bd.pid, look="", look_default="", genre=genre))
        assert p2.get_attribute(root, "data-look") == look, genre
        assert "(auto)" in p2.locator("[data-testid=binder-look] option:checked").inner_text()
        assert_clean(p2, genre)
        p2.close()


CONTRAST_JS = """() => {
  const lum = c => { const m = c.match(/[\\d.]+/g).map(Number); const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
    return .2126 * f(m[0]) + .7152 * f(m[1]) + .0722 * f(m[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const el = document.querySelector('[data-testid=binder]'); const probe = document.createElement('i'); el.appendChild(probe);
  const col = v => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color; };
  const pairs = [['--bnd-ink', '--bnd-paper'], ['--bnd-ink', '--bnd-card'], ['--bnd-muted', '--bnd-paper'], ['--bnd-muted', '--bnd-card'],
    ['--bnd-head', '--bnd-paper'], ['--bnd-head', '--bnd-card'], ['--bnd-label', '--bnd-card'], ['--bnd-label', '--bnd-card-2'], ['--bnd-link', '--bnd-card'],
    ['--bnd-gold-ink', '--bnd-paper'], ['--bnd-accent-ink', '--bnd-accent'], ['--bnd-chip-ink', '--bnd-chip-bg'], ['--bnd-ink', '--bnd-hl'],
    ['--bnd-ok', '--bnd-ok-bg'], ['--bnd-draft', '--bnd-draft-bg'], ['--bnd-needs', '--bnd-needs-bg'], ['--bnd-plaque-ink', '--bnd-plaque'],
    ['--bnd-rail-ink', '--bnd-rail'], ['--bnd-rail-on-ink', '--bnd-rail-on'], ['--bnd-desk-ink', '--bnd-desk'],
    ...['family', 'love', 'ally', 'rival', 'enemy', 'mentor', 'other'].map(k => ['--bnd-on-rel', `--bnd-rel-${k}`])];
  const out = pairs.map(([a, b]) => [a + ' on ' + b, Math.round(ratio(col(a), col(b)) * 100) / 100]);
  const paper = lum(col('--bnd-paper'));
  probe.remove();
  return { out, paper };
}"""


def test_every_look_keeps_aa_contrast_and_prints_on_light_paper(make_context, bd):
    page = open_binder(make_context, bd, page_id="ch-odile")
    for look in LOOKS:
        page.select_option("[data-testid=binder-look]", look)
        page.wait_for_function(f"() => document.querySelector('[data-testid=binder]').dataset.look === '{look}'")
        res = page.evaluate(CONTRAST_JS)
        low = [(k, r) for k, r in res["out"] if r < 4.5]
        assert not low, f"{look}: below WCAG AA 4.5:1: {low}"
        page.emulate_media(media="print")
        res = page.evaluate(CONTRAST_JS)
        assert res["paper"] > 0.8, f"{look}: prints on light paper"
        low = [(k, r) for k, r in res["out"] if r < 4.5 and "rail" not in k and "desk" not in k]
        assert not low, f"{look} (print): below 4.5:1: {low}"
        page.emulate_media(media="screen")
    assert_clean(page, "contrast")


# ------------------------------------------------------------------------------------------------ print and exports
def test_print_stylesheet_hides_the_chrome(make_context, bd):
    page = open_binder(make_context, bd, look="horror", mode="all")
    assert page.locator(".bnd-page").count() == 22
    page.emulate_media(media="print")
    for sel in (".topbar", ".bnd-rail", ".bnd-toolbar", ".bnd-pager >> nth=0", ".bnd-apphead", ".bnd-edit >> nth=0", ".bnd-fill >> nth=0"):
        assert not page.is_visible(sel), f"{sel} is printed"
    assert page.is_visible('.bnd-page[data-page-id="cover"]')
    st = page.evaluate("""() => { const p = document.querySelector('.bnd-page'); const cs = getComputedStyle(p);
        return { after: cs.breakAfter, shadow: cs.boxShadow, bg: cs.backgroundColor, css: document.getElementById('bnd-print-style').textContent }; }""")
    assert st["after"] == "page" and st["shadow"] == "none" and st["bg"] == "rgb(255, 255, 255)"
    assert "The Lamplighter's Last Ferry" in st["css"] and "counter(page)" in st["css"]   # running header + page numbers
    shot(page, "binder-print-horror")
    page.emulate_media(media="screen")
    # 🖨 Print in one-page mode asks: this page or the whole binder
    page.click("[data-testid=binder-one]")
    page.evaluate("() => { window.__printed = 0; window.print = () => { window.__printed = document.querySelectorAll('.bnd-page').length; }; }")
    page.click("[data-testid=binder-print]")
    page.click("dialog[open] button:has-text('The whole binder')")
    page.wait_for_function("() => window.__printed > 0")
    assert page.evaluate("window.__printed") == 22
    assert page.locator(".bnd-page").count() == 1   # back to one page afterwards
    assert_clean(page, "print")


def test_pdf_and_word_buttons_show_the_plain_error(make_context, bd):
    page = open_binder(make_context, bd, page_id="cover")
    page.click("[data-testid=binder-pdf]")
    page.wait_for_selector("[data-testid=binder-msg] .bnd-err")
    msg = page.inner_text("[data-testid=binder-msg]")
    assert "⬇ PDF did not work" in msg and "AutoInjector's page renderer, which is not connected" in msg
    assert "🖨 Print" in msg and "Save as PDF" in msg
    page.click("[data-testid=binder-docx]")
    page.wait_for_function("() => document.querySelector('[data-testid=binder-msg]').innerText.includes('Word did not work')")
    assert [u.split("?")[1] for u in page.bf_calls.exports] == ["format=pdf", "format=docx"]
    assert "Open AutoInjector to make the PDF" in msg and page.get_attribute("[data-testid=binder-msg] .bnd-err", "data-problem") == "RENDER_NOT_WIRED"
    probs = [p for p in page.bf_problems if "/binder/export" not in p and "status of 503" not in p]
    page.bf_problems[:] = probs
    assert_clean(page, "exports")


def test_binder_not_ready_when_the_api_is_missing(make_context, bd):
    page = open_binder(make_context, bd, status=404)
    assert "The Book Bible binder is not ready" in page.inner_text("#main")
    assert page.locator("#main a", has_text="📘 Make my book").count() == 1
    page.bf_problems[:] = [p for p in page.bf_problems if "/binder" not in p and "404" not in p]
    assert_clean(page, "not ready")


# ------------------------------------------------------------------------------------------------ navigation
def test_search_finds_a_character_and_a_fact(make_context, bd):
    page = open_binder(make_context, bd, page_id="cover")
    page.fill("[data-testid=binder-search]", "tobiah")
    page.wait_for_selector('.bnd-hit[data-page="ch-tobiah"]')
    first = page.locator(".bnd-hit").first
    assert first.get_attribute("data-page") == "ch-tobiah" and "Tobiah Reed" in first.inner_text()
    first.click()
    page.wait_for_selector('.bnd-page[data-page-id="ch-tobiah"]')
    assert page.evaluate("location.hash").endswith("/bible/ch-tobiah")
    # a fact deep inside a page: jumps to the field and highlights it
    page.fill("[data-testid=binder-search]", "comma-shaped burn")
    page.wait_for_selector('.bnd-hit mark:text-is("comma-shaped")')
    page.locator(".bnd-hit").first.click()
    page.wait_for_selector(".bnd-page .bnd-flash")
    assert "comma-shaped burn" in page.locator(".bnd-flash").first.inner_text()
    page.fill("[data-testid=binder-search]", "zzzz nothing")
    page.wait_for_selector(".bnd-noresult")
    assert_clean(page, "search")


def test_relationship_map_draws_typed_lines(make_context, bd):
    page = open_binder(make_context, bd, page_id="relmap")
    svg = page.locator("svg.bnd-relmap")
    assert svg.count() == 1
    lines = svg.locator("path.bnd-rm-line")
    assert lines.count() == 6
    types = {lines.nth(i).get_attribute("data-type") for i in range(lines.count())}
    assert types == {"family", "love", "ally", "rival", "enemy", "mentor"}
    main = svg.locator(".bnd-rm-node.is-main")
    assert main.get_attribute("data-name") == "Odile Marsh"
    assert main.locator("circle.bnd-rm-ring").get_attribute("cx") == "450"   # centred in the 900-wide map
    assert svg.locator(".bnd-rm-node").count() == 5 and svg.locator(".bnd-rm-node image").count() == 4   # 4 portraits, 1 initials
    assert page.locator(".bnd-legend li").count() == 6
    shot(page, "binder-relmap")
    svg.locator('.bnd-rm-node[data-name="Silas Crane"]').click()
    page.wait_for_selector('.bnd-page[data-page-id="ch-silas"]')
    assert_clean(page, "relationship map")


def test_contents_pager_modes_and_keys(make_context, bd):
    page = open_binder(make_context, bd, page_id="pl-isle")
    assert page.locator(".bnd-page").count() == 1
    assert "Page 13 of 22 · Lantern Isle" in page.inner_text(".bnd-pager >> nth=0")
    page.click("[data-testid=binder-next] >> nth=0")
    page.wait_for_selector('.bnd-page[data-page-id="mg-wickcraft"]')
    page.click("[data-testid=binder-prev] >> nth=0")
    page.wait_for_selector('.bnd-page[data-page-id="pl-isle"]')
    page.locator("body").press("ArrowRight")
    page.wait_for_selector('.bnd-page[data-page-id="mg-wickcraft"]')
    rail = page.locator(".bnd-contents")
    assert rail.locator("a[aria-current=page]").inner_text().strip().startswith("Wickcraft")
    assert "5" in rail.locator("li", has_text="Characters").first.locator(".bnd-cc").inner_text()
    # the Contents page rows and the quick-jump tiles are links into the binder
    goto_page(page, "contents")
    page.locator('.bnd-page a.bnd-toc-row', has_text="Map page").click()
    page.wait_for_selector('.bnd-page[data-page-id="map"]')
    page.locator(".bnd-pin", has_text="Lantern Isle").click()
    page.wait_for_selector('.bnd-page[data-page-id="pl-isle"]')
    page.click("[data-testid=binder-all]")
    page.wait_for_function("() => document.querySelectorAll('.bnd-page').length === 22")
    page.click("[data-testid=binder-one]")
    page.wait_for_function("() => document.querySelectorAll('.bnd-page').length === 1")
    # 4.3 filters on the cast list
    goto_page(page, "cast")
    page.check('.bnd-filters input[type=checkbox]')
    assert page.locator(".bnd-card").count() == 1 and "Maren Vey" in page.inner_text(".bnd-card")
    assert_clean(page, "navigation")


def test_entry_points_book_page_and_more_menu(make_context, bd):
    page = watch(make_context(width=1280, height=900).new_page())
    serve_binder(page, bd.pid)
    page.goto(bd.url)
    page.wait_for_selector("#main h1", timeout=15000)
    page.evaluate("h => { location.hash = h; }", f"#/p/{bd.pid}/main/book")
    page.wait_for_selector("[data-testid=open-binder]", timeout=15000)
    assert page.get_attribute("[data-testid=open-binder]", "href") == f"#/p/{bd.pid}/main/bible"
    assert page.locator("#more-links a", has_text="📖 Book Bible").count() == 1
    page.click("[data-testid=open-binder]")
    page.wait_for_selector(".bnd-page", timeout=15000)
    assert page.inner_text("#main h1") == "📖 Book Bible"
    assert_clean(page, "entry points")


# ------------------------------------------------------------------------------------------------ widths
@pytest.mark.parametrize("width", [390, 1280, 1920])
def test_no_horizontal_scroll(make_context, bd, width):
    page = open_binder(make_context, bd, width=width, page_id="cover")
    for pid_ in ("cover", "contents", "glance", "cast", "ch-odile", "relmap", "pl-vessmoor", "mg-wickcraft", "ar-ember", "wd-guild",
                 "map", "plan", "cp-01", "rules"):
        if pid_ != "cover":
            page.evaluate("h => { location.hash = h; }", f"#/p/{bd.pid}/main/bible/{pid_}")
            page.wait_for_selector(f'.bnd-page[data-page-id="{pid_}"]', timeout=10000)
            images_ready(page)
        assert overflow(page) <= 0, f"{pid_} at {width}px scrolls sideways by {overflow(page)}px"
        if pid_ in ("ch-odile", "relmap", "cover"):
            shot(page, f"binder-{pid_}-{width}")
    if width == 390:
        # stacked boxes on a phone: the fact sheet is one column, the rail sits above the page
        cols = page.evaluate("() => getComputedStyle(document.querySelector('.bnd-facts')).gridTemplateColumns.split(' ').length")
        assert cols == 1
        assert page.evaluate("() => document.querySelector('.bnd-rail').getBoundingClientRect().bottom <= document.querySelector('.bnd-page').getBoundingClientRect().top")
    assert_clean(page, f"widths {width}")


# ------------------------------------------------------------------------------------------------ 🆕 fields
def test_new_fields_inline_editor_saves_validates_and_approves(make_context, bd):
    page = open_binder(make_context, bd, page_id="ch-maren")
    art = page.locator('.bnd-page[data-page-id="ch-maren"]')
    assert "Not stored yet" in art.locator('[data-fid="5.13.10"]').inner_text()          # `unavailable`: a quiet note
    # height: a 🆕 quick stat — ✏️ opens the editor, 💾 Save stores it (PUT …/binder/fields) and the page shows it
    art.locator('.bnd-fact[data-fid="5.2.5"] button.bnd-fedit').click()
    page.wait_for_selector("[data-testid=binder-editor] input")
    page.fill("[data-testid=binder-editor] input", "1.60 m (5 ft 3 in)")
    page.click("[data-testid=binder-ed-save]")
    page.wait_for_function("""() => document.querySelector('.bnd-fact[data-fid="5.2.5"] dd').innerText.includes('1.60 m')""")
    assert page.bf_calls.puts == [{"target": "character:rec-maren", "fields": {"height": "1.60 m (5 ft 3 in)"}}]
    # a stat bar takes a whole number 1-10: a wrong one is explained, not sent
    art.locator('.bnd-bar[data-fid="5.9.7"] button.bnd-fedit').click()
    page.wait_for_selector("[data-testid=binder-editor] input[type=number]")
    page.fill("[data-testid=binder-editor] input", "12")
    page.click("[data-testid=binder-ed-save]")
    assert "whole number from 1 to 10" in page.inner_text(".bnd-ed-msg")
    page.fill("[data-testid=binder-editor] input", "6")
    page.click("[data-testid=binder-ed-save]")
    page.wait_for_function("""() => document.querySelectorAll('.bnd-bar[data-fid="5.9.7"] i.on').length === 6""")
    assert page.bf_calls.puts[-1] == {"target": "character:rec-maren", "fields": {"stat_strength": 6}}
    # the relationship type (a row field): its proposal is approved from the editor
    rel = page.locator('.bnd-page .bnd-reltype[data-fid="5.8.3"]').first
    assert rel.locator(".bnd-prop").count() == 1
    rel.locator("button.bnd-fedit").click()
    page.click("[data-testid=binder-ed-approve]")
    page.wait_for_function("""() => !document.querySelector('.bnd-reltype[data-fid="5.8.3"] .bnd-prop')""")
    assert page.bf_calls.approves == [{"target": "relationship:rec-maren:odile marsh", "fields": ["type"]}]
    # book-level 🆕 fields (At a glance: sub-genre) go to the target "book"
    goto_page(page, "glance")
    page.locator('.bnd-page [data-fid="3.4.2"] button.bnd-fedit').click()
    page.wait_for_selector("[data-testid=binder-editor] input")
    assert page.input_value("[data-testid=binder-editor] input") == "Gaslamp fantasy"
    page.click("[data-testid=binder-ed-dismiss]")
    page.wait_for_function("""() => document.querySelector('.bnd-page [data-fid="3.4.2"]').innerText.includes('Not filled yet')""")
    assert page.bf_calls.dismisses == [{"target": "book", "fields": ["subgenre"]}]
    assert not unnamed_controls(page)
    shot(page, "binder-editor")
    assert_clean(page, "editor")


def test_fill_from_the_book_then_approve_the_proposals(make_context, bd):
    page = open_binder(make_context, bd, page_id="ch-maren")
    art = page.locator('.bnd-page[data-page-id="ch-maren"]')
    assert art.locator("[data-testid=binder-approve-page]").inner_text() == "✔ Approve 1 proposal"   # the relationship type
    # an empty 🆕 field's placeholder asks the AI for this page (a button, not a link)
    assert art.locator('.bnd-fact[data-fid="5.2.5"] button.bnd-fill', has_text="✨ Fill from the book").count() == 1
    art.locator("[data-testid=binder-fill-page]").click()
    page.wait_for_selector("[data-testid=binder-msg] .bnd-ok-msg")
    assert "2 value(s) proposed from the book" in page.inner_text("[data-testid=binder-msg]")
    assert page.bf_calls.fills == [{"targets": ["character:rec-maren"]}]
    page.wait_for_function("""() => document.querySelector('.bnd-fact[data-fid="5.2.5"] dd').innerText.includes('1.62 m')""")
    assert page.locator('.bnd-fact.is-proposed[data-fid="5.2.5"]').count() == 1
    approve = page.locator("[data-testid=binder-approve-page]")
    assert approve.inner_text() == "✔ Approve 3 proposals"
    approve.click()
    page.wait_for_function("() => !document.querySelector('[data-testid=binder-approve-page]')")
    assert sorted(page.bf_calls.approves, key=lambda b: b["target"]) == [
        {"target": "character:rec-maren", "fields": ["height", "handedness"]}, {"target": "relationship:rec-maren:odile marsh", "fields": ["type"]}]
    assert page.locator('.bnd-fact.is-proposed[data-fid="5.2.5"]').count() == 0
    # the toolbar button fills the whole book
    page.click("[data-testid=binder-fill]")
    page.wait_for_function("() => document.querySelector('[data-testid=binder-fill]') && !document.querySelector('[data-testid=binder-fill]').disabled && document.querySelector('[data-testid=binder-msg] .bnd-ok-msg')")
    assert len(page.bf_calls.fills) == 2 and page.bf_calls.fills[-1] == {}
    assert_clean(page, "fill")


# ------------------------------------------------------------------------------------------------ ★ the main character
def test_the_main_character_is_marked_everywhere(make_context, bd):
    page = open_binder(make_context, bd, page_id="cast")
    cast = page.locator('.bnd-page[data-page-id="cast"]')
    cards = cast.locator(".bnd-card")
    assert cast.locator("[data-testid=protagonist-badge]").count() == 1                  # one protagonist only
    first = cards.first
    assert first.get_attribute("data-name") == "Odile Marsh" and "is-protagonist" in first.get_attribute("class")
    assert "★" in first.locator("[data-testid=protagonist-badge]").inner_text() and "Main character" in first.inner_text()
    silas = cast.locator('.bnd-card[data-name="Silas Crane"]')                           # the villain: no ★ badge
    assert silas.locator("[data-testid=protagonist-badge]").count() == 0
    w = lambda sel: page.evaluate("s => document.querySelector(s).getBoundingClientRect().width", sel)  # noqa: E731
    assert w('.bnd-card[data-name="Odile Marsh"]') > w('.bnd-card[data-name="Silas Crane"]') * 1.3        # first, larger card
    heads = [cast.locator(".bnd-group-h").nth(i).inner_text() for i in range(cast.locator(".bnd-group-h").count())]
    assert [h.split(" (")[0].replace("4.1.1", "").strip() for h in heads] == ["★ Main character", "Villains", "Supporting", "Minor & extras"]
    assert silas.locator(".bnd-role").text_content().strip() == "🗡️ Villain"                 # role title + icon
    assert cast.locator('.bnd-card[data-name="Tobiah Reed"] .bnd-role').text_content().strip() == "🦉 Mentor"
    shot(page, "binder-cast-protagonist")
    # the character page: header band + 📋 Quick stats "Story role"
    goto_page(page, "ch-odile")
    odile = page.locator('.bnd-page[data-page-id="ch-odile"]')
    assert odile.locator(".bnd-band [data-testid=protagonist-badge]").count() == 1
    assert odile.locator("[data-testid=story-role] dt").inner_text().strip() == "Story role"
    assert odile.locator("[data-testid=story-role] dd").inner_text().strip() == "★ Main character — protagonist"
    for pid_, want in (("ch-silas", "🗡️ Villain"), ("ch-tobiah", "🦉 Mentor"), ("ch-wren", "🏠 Family"), ("ch-maren", "• Minor character")):
        goto_page(page, pid_)
        art = page.locator(f'.bnd-page[data-page-id="{pid_}"]')
        assert art.locator("[data-testid=story-role] dd").inner_text().strip() == want, pid_
        assert art.locator("[data-testid=protagonist-badge]").count() == 0
    # At a glance (main-cast strip) and the Contents quick-jump tile
    goto_page(page, "glance")
    strip = page.locator('.bnd-page[data-page-id="glance"] .bnd-cast-strip')
    assert strip.locator(".bnd-mini-card").first.locator("[data-testid=protagonist-badge]").count() == 1
    assert strip.locator("[data-testid=protagonist-badge]").count() == 1 and "Odile Marsh" in strip.locator(".bnd-mini-card").first.inner_text()
    goto_page(page, "contents")
    tile = page.locator('.bnd-page[data-page-id="contents"] .bnd-tile.is-protagonist')
    assert tile.count() == 1 and "Odile Marsh" in tile.inner_text() and tile.locator("[data-testid=protagonist-badge]").count() == 1
    assert_clean(page, "protagonist")
    # older data without book.protagonist: the relationship map's centre is the main character
    doc = fixture_doc(bd.pid)
    doc["book"].pop("protagonist")
    for p in doc["pages"]:
        for k in ("story_role", "is_protagonist", "role_label", "role_icon"):
            p.pop(k, None)
    p2 = open_binder(make_context, bd, page_id="ch-odile", doc=doc)
    assert p2.locator('.bnd-page[data-page-id="ch-odile"] [data-testid=story-role] dd').inner_text().strip() == "★ Main character — protagonist"
    assert_clean(p2, "protagonist fallback")


def test_the_main_character_badge_in_every_look_and_print(make_context, bd):
    page = open_binder(make_context, bd, page_id="ch-odile")
    for look in LOOKS:
        page.select_option("[data-testid=binder-look]", look)
        page.wait_for_function(f"() => document.querySelector('[data-testid=binder]').dataset.look === '{look}'")
        for media in ("screen", "print"):
            page.emulate_media(media=media)
            b = page.locator(".bnd-band [data-testid=protagonist-badge]")
            assert b.is_visible(), f"{look} {media}"
            ratio = page.evaluate(CONTRAST_JS.replace("const pairs = [", "const pairs = [['--bnd-accent-ink', '--bnd-accent'], "))["out"][0][1]
            assert ratio >= 4.5, f"{look} {media}: badge contrast {ratio}"
        page.emulate_media(media="screen")
    assert_clean(page, "badge looks")


# ------------------------------------------------------------------------------------------------ At a glance: progress
def test_at_a_glance_has_the_progress_strip(make_context, bd):
    page = open_binder(make_context, bd, page_id="glance")
    bar = page.locator('.bnd-page[data-page-id="glance"] [data-testid=glance-progress]')
    assert bar.count() == 1
    text = bar.inner_text()
    assert "62% approved" in text and "9 draft pages waiting" in text and "7 pictures missing" in text
    assert bar.locator("[role=progressbar]").get_attribute("aria-valuenow") == "62"
    assert page.evaluate("""() => { const b = document.querySelector('[data-testid=glance-progress]');
        const s = document.querySelector('.bnd-page[data-page-id="glance"] .bnd-sec'); return b.getBoundingClientRect().top < s.getBoundingClientRect().top; }""")
    width = page.evaluate("() => document.querySelector('[data-testid=glance-progress] [role=progressbar] > div').style.width")
    assert width == "62%"
    shot_dir("").mkdir(parents=True, exist_ok=True)
    page.locator('.bnd-page[data-page-id="glance"]').screenshot(path=str(shot_dir("") / "binder-glance-progress.png"))
    goto_page(page, "cover")                                                             # the cover keeps its own bar
    assert page.locator('.bnd-page[data-page-id="cover"] .bnd-progress[role=progressbar]').get_attribute("aria-valuenow") == "62"
    assert_clean(page, "glance progress")


# ------------------------------------------------------------------------------------------------ 12.3 timeline strip
@pytest.mark.parametrize("width", [390, 1280, 1920])
def test_rules_timeline_is_a_horizontal_strip(make_context, bd, width):
    doc = fixture_doc(bd.pid)
    rows = next(p for p in doc["pages"] if p["page_id"] == "rules")["sections"]["12.3"]["rows"]
    page = open_binder(make_context, bd, width=width, page_id="rules")
    strip = page.locator('.bnd-page[data-page-id="rules"] [data-testid=timeline-strip]')
    dots = strip.locator(".bnd-tls-dot")
    assert dots.count() == len(rows) == 9
    clashes = strip.locator(".bnd-tls-ev.is-clash")
    assert clashes.count() == sum(1 for r in rows if r["12.3.4"]["value"]) == 2
    rgb = page.evaluate("() => getComputedStyle(document.querySelector('.bnd-tls-ev.is-clash .bnd-tls-dot')).backgroundColor")
    r, g, b = [int(x) for x in re.findall(r"\d+", rgb)[:3]]
    assert r > g + 60 and r > b + 60, f"clash dot is red: {rgb}"
    ok_rgb = page.evaluate("() => getComputedStyle(document.querySelector('.bnd-tls-ev:not(.is-clash) .bnd-tls-dot')).backgroundColor")
    assert ok_rgb != rgb
    assert "40 minutes" in clashes.first.locator(".bnd-tls-note").inner_text()            # the clash note
    assert overflow(page) <= 0, f"rules at {width}px scrolls sideways by {overflow(page)}px"
    # every dot sits on one line (per row): same centre y for the events of a row
    ys = page.evaluate("() => [...document.querySelectorAll('.bnd-tls-dot')].map(d => { const r = d.getBoundingClientRect(); return Math.round(r.top + r.height / 2); })")
    sw = page.evaluate("() => { const s = document.querySelector('[data-testid=timeline-strip]'); return [s.scrollWidth, s.clientWidth]; }")
    if width == 390:
        assert sw[0] <= sw[1] + 1, "wraps into rows on a phone"
        assert len(set(ys)) == (len(rows) + 1) // 2                                         # 2 per row
    else:
        assert len(set(ys)) == 1, ys
        if width == 1280:
            assert sw[0] > sw[1], "a long timeline scrolls inside its own box"
            assert page.evaluate("() => getComputedStyle(document.querySelector('[data-testid=timeline-strip]')).overflowX") == "auto"
    # the same events stay readable as a list / table (screen readers, find in page)
    assert strip.locator("ol > li").count() == len(rows)
    lst = page.locator('.bnd-page[data-page-id="rules"] details.bnd-tls-list')
    lst.locator("summary").click()
    assert lst.locator("tbody tr").count() == len(rows)
    page.emulate_media(media="print")                                                      # print: rows, not a scroller
    sw = page.evaluate("() => { const s = document.querySelector('[data-testid=timeline-strip]'); return [s.scrollWidth, s.clientWidth]; }")
    assert sw[0] <= sw[1] + 1 and not lst.is_visible()
    page.emulate_media(media="screen")
    shot(page, f"binder-rules-timeline-{width}")
    shot_dir("").mkdir(parents=True, exist_ok=True)
    page.locator('.bnd-page[data-page-id="rules"] .bnd-sec[data-sec="12.3"]').screenshot(path=str(shot_dir("") / f"binder-timeline-strip-{width}.png"))
    assert_clean(page, f"timeline {width}")


# ------------------------------------------------------------------------------------------------ the 7 looks differ
LOOK_KEYS_JS = """() => {
  const root = document.querySelector('[data-testid=binder]'); const page = document.querySelector('.bnd-page');
  const cs = getComputedStyle(page); const rs = getComputedStyle(root);
  const sec = getComputedStyle(document.querySelector('.bnd-page .bnd-sec:not(.bnd-sec-plain)'));
  const h = getComputedStyle(document.querySelector('.bnd-page h2'));
  return { paper: cs.backgroundColor, accent: rs.getPropertyValue('--bnd-accent').trim(), head: rs.getPropertyValue('--bnd-head').trim(),
    desk: rs.getPropertyValue('--bnd-desk').trim(), card: sec.backgroundColor, radius: sec.borderTopLeftRadius,
    font: h.fontFamily.split(',')[0].replace(/["']/g, '').trim(), body: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim() };
}"""


def test_the_seven_looks_are_clearly_different(make_context, bd):
    page = open_binder(make_context, bd, page_id="ch-odile")
    got = {}
    for look in LOOKS:
        page.select_option("[data-testid=binder-look]", look)
        page.wait_for_function(f"() => document.querySelector('[data-testid=binder]').dataset.look === '{look}'")
        got[look] = page.evaluate(LOOK_KEYS_JS)
    for i, a in enumerate(LOOKS):
        for b in LOOKS[i + 1:]:
            x, y = got[a], got[b]
            assert x["paper"] != y["paper"], f"{a} and {b} share the page colour {x['paper']}"
            assert x["accent"] != y["accent"], f"{a} and {b} share the accent {x['accent']}"
            assert x["card"] != y["card"] or x["paper"] != y["paper"]
            # each pair differs in at least 4 of: paper, accent, heading colour, desk, section radius, heading font, body font
            diff = sum(x[k] != y[k] for k in ("paper", "accent", "head", "desk", "radius", "font", "body"))
            assert diff >= 4, f"{a} vs {b} differ only in {diff}: {x} / {y}"
    assert_clean(page, "looks differ")


def test_looks_gallery(make_context, bd):
    """Cover, character, cast, relationship map and rules in every look at 1280 (the screenshots go to $BF_UI_SHOTS/looks)."""
    page = open_binder(make_context, bd, page_id="cover")
    for look in LOOKS:
        page.select_option("[data-testid=binder-look]", look)
        page.wait_for_function(f"() => document.querySelector('[data-testid=binder]').dataset.look === '{look}'")
        for pid_ in ("cover", "ch-odile", "cast", "relmap", "rules"):
            page.evaluate("h => { location.hash = h; }", f"#/p/{bd.pid}/main/bible/{pid_}")
            page.wait_for_selector(f'.bnd-page[data-page-id="{pid_}"]', timeout=10000)
            images_ready(page)
            el = page.locator(f'.bnd-page[data-page-id="{pid_}"]')
            box = el.bounding_box()
            (SHOTS_DIR := shot_dir("looks")).mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(SHOTS_DIR / f"{look}-{pid_}.png"), full_page=True,
                            clip={"x": box["x"], "y": box["y"], "width": box["width"], "height": min(box["height"], 1500)})
            assert overflow(page) <= 0
    assert_clean(page, "gallery")


def shot_dir(name):
    from .ui_helpers import SHOTS
    return SHOTS / name


# ------------------------------------------------------------------------------------------------ 🖼 pictures waiting
def test_pictures_waiting_and_make_the_rest(make_context, bd):
    """A character the ⚡ run could not draw shows "🖼 Picture waiting" (page and cast card), and the toolbar's
    🖼 Make the rest of the pictures runs the job, shows its result and redraws the pages without the placeholders."""
    doc = fixture_doc(bd.pid)
    for p in doc["pages"]:
        if p["page_id"] == "ch-maren":
            p["pictures_waiting"] = ["portrait", "front", "side", "back", "sheet"]
    page = open_binder(make_context, bd, page_id="ch-maren", doc=doc)
    art = page.locator('.bnd-page[data-page-id="ch-maren"]')
    assert art.locator("[data-testid=binder-pic-waiting]").count() == 5    # portrait, sheet and the three views
    assert art.locator("[data-testid=binder-pic-waiting]").first.inner_text().startswith("🖼 Picture waiting")
    shot(page, "binder-pictures-waiting")
    goto_page(page, "cast")
    card = page.locator('.bnd-card[data-name="Maren Vey"]')
    assert card.locator("[data-testid=binder-pic-waiting]").count() == 1
    goto_page(page, "ch-maren")
    btn = page.locator("[data-testid=binder-pictures]")
    assert btn.inner_text() == "🖼 Make the rest of the pictures"
    btn.click()
    page.wait_for_selector("[data-testid=binder-msg] .bnd-ok-msg")
    assert "5 picture(s) made." in page.inner_text("[data-testid=binder-msg]")
    assert page.bf_calls.pictures == 1
    page.wait_for_function("() => !document.querySelector('[data-testid=binder-pic-waiting]')")
    assert_clean(page, "pictures")


# ------------------------------------------------------------------------------------------------ 📚 series
def _series_docs(pid):
    """Book 2 of a series: Maren's page has the "Through the series" strip; ?as_of=1 is book 1, read only."""
    doc = fixture_doc(pid)
    pic = next(p for p in doc["pages"] if p["page_id"] == "ch-odile")["pics"]["5.1.1"]["url"]
    books = [{"number": 1, "title": "The Lamplighter's First Night", "exists": True, "current": False},
             {"number": 2, "title": "The Lamplighter's Last Ferry", "exists": True, "current": True}]
    doc["series"] = {"in_series": True, "name": "The Ferry Books", "number": 2, "as_of": 2, "books": books, "problem": None}
    strip = [{"number": 1, "title": books[0]["title"], "exists": True, "in_book": True, "portrait": {"url": pic, "alt": "Maren in book 1"},
              "changes": {"appearance": [{"text": "lost her left eye"}]}, "words": "Appearance: lost her left eye · Gained: the Resonance Key",
              "proposal": None, "proposal_words": "", "portrait_waiting": False},
             {"number": 2, "title": books[1]["title"], "exists": True, "in_book": True, "portrait": None, "changes": None, "words": "",
              "proposal": None, "proposal_words": "", "portrait_waiting": True}]
    for p in doc["pages"]:
        if p["page_id"] == "ch-maren":
            p["series"] = {"key": "c1", "as_of": 2, "strip": strip, "changed": True,
                           "state": {"looks": "Small and wiry. Now: lost her left eye.", "carries": "the Resonance Key"}}
    old = json.loads(json.dumps(doc))
    old["series"].update(as_of=1, viewing={"number": 1, "title": books[0]["title"], "read_only": True},
                         note="You are looking at book 1 (“The Lamplighter's First Night”) — read only here; open that book to change it.")
    old["read_only"] = True
    for p in old["pages"]:
        for sec in p["sections"].values():
            for f in sec["fields"].values():
                f.pop("edit", None)
        if p["page_id"] == "ch-maren":
            p["sections"]["5.6"]["fields"]["5.6.1"].update(value="Small and wiry. Now: lost her left eye.", status="auto", source="series:as_of_book_1")
    view = {"in_series": True, "series_id": "ser-1", "name": "The Ferry Books", "number": 2,
            "books": [dict(b, project_id=f"p{b['number']}") for b in books], "proposals": 0, "proposals_here": 0,
            "portraits_waiting": 0, "next_book": None, "problem": None,
            "characters": [{"key": "c1", "name": "Maren Vey", "record_id": "rec-maren", "first_book": 1, "fixed": {}, "has_voice": True,
                            "start": {}, "end": {}, "strip": json.loads(json.dumps(strip))}]}
    return doc, old, view


def test_series_strip_as_of_book_and_sequel(make_context, bd):
    """📚 A character page of book 2 shows "Through the series" (book 1 → book 2 with what changed); 📖 As of book 1
    loads that book read only (banner, no edit or fill buttons); the 📚 Series panel finds the changes of this book,
    shows the proposal, ✔ approves it, and 📚 Start a sequel asks for consent and starts the new book's run."""
    doc, old, view = _series_docs(bd.pid)
    ctx_page = None
    page = open_binder(make_context, bd, page_id="ch-maren", doc=doc)
    ctx_page = page
    api = page.bf_calls
    api.as_of_docs, api.series_view = {"1": old}, view
    art = page.locator('.bnd-page[data-page-id="ch-maren"]')
    strip = art.locator("[data-testid=binder-series-strip]")
    assert strip.count() == 1
    assert strip.locator(".bnd-series-book").count() == 2
    assert "lost her left eye" in strip.inner_text() and "Book 1" in strip.inner_text()
    assert strip.locator(".bnd-series-book.is-here").get_attribute("data-book") == "2"
    assert "🖼 waiting" in strip.locator('.bnd-series-book[data-book="2"]').inner_text()
    assert "As of the end of book 2" in strip.inner_text() and "Resonance Key" in strip.inner_text()
    shot(page, "binder-series-strip")
    # 📖 As of book 1: that book, read only
    sel = page.locator("[data-testid=binder-as-of]")
    assert sel.is_visible()
    assert [o.strip() for o in sel.locator("option").all_inner_texts()] == ["This book (book 2)", "Book 1: The Lamplighter's First Night"]
    sel.select_option("1")
    page.wait_for_selector("[data-testid=binder-as-of-note] .bnd-asof-banner")
    assert "read only" in page.inner_text("[data-testid=binder-as-of-note]")
    assert api.as_of_calls == ["?as_of=1"]
    art = page.locator('.bnd-page[data-page-id="ch-maren"]')
    assert "lost her left eye" in art.inner_text()
    assert art.locator(".bnd-pagetools").count() == 0
    shot(page, "binder-series-as-of-book-1")
    page.click("[data-testid=binder-as-of-note] button")
    page.wait_for_function("() => !document.querySelector('[data-testid=binder-as-of-note] .bnd-asof-banner')")
    # 📚 the series panel: find what changed, approve
    page.click("[data-testid=binder-series]")
    page.wait_for_selector("[data-testid=binder-series-find]")
    assert "this is book 2" in page.inner_text("[data-testid=binder-series-box]")
    page.click("[data-testid=binder-series-find]")
    page.wait_for_selector("[data-testid=binder-series-proposals]")
    assert "a burn scar on her right hand" in page.inner_text("[data-testid=binder-series-proposals]")
    assert "nothing is used before you approve" in page.inner_text("[data-testid=binder-series-msg]")
    shot(page, "binder-series-panel")
    page.click("[data-testid=binder-series-approve]")
    page.wait_for_selector("[data-testid=binder-series-box] .bnd-series-done")
    assert page.locator("[data-testid=binder-series-proposals]").count() == 0
    assert ("POST", "/series/approve", {"key": "c1"}) in api.series_calls
    assert "a burn scar" in page.inner_text("[data-testid=binder-series-box]")
    # 📚 start a sequel: consent first, Cancel starts nothing
    page.route(re.compile(r"/api/autobook/run-seq1$"), lambda r: r.fulfill(status=200, content_type="application/json", body="null"))
    page.click("[data-testid=binder-series-sequel]")
    page.wait_for_selector("dialog[open] >> text=Start a sequel from this book?")
    page.click("dialog[open] >> text=📚 Start the sequel")
    page.wait_for_selector("[data-testid=binder-series-started]")
    assert "Book 3 has started" in page.inner_text("[data-testid=binder-series-started]")
    assert ("POST", "/series/sequel", {"author_confirms": True}) in api.series_calls
    assert not overflow(ctx_page)
    assert_clean(page, "series")


def test_single_book_has_no_series_strip_or_picker(make_context, bd):
    page = open_binder(make_context, bd, page_id="ch-maren")
    assert page.locator("[data-testid=binder-series-strip]").count() == 0
    assert not page.locator("[data-testid=binder-as-of]").is_visible()
    assert page.locator("[data-testid=binder-series]").is_visible()
    assert_clean(page, "single book")
