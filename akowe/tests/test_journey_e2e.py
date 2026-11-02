"""🧭 One author's whole journey, end to end, with a fake AI and a fake AutoInjector (pictures, 🔒 locks, PDF printing).

1. A fantasy book from an idea: ⚡ Make a book runs every step incl. Character pictures, the book is saved to its folder.
2. One AI site shows its own error notice (SITE_ERROR) mid-run: the call moves to the other AI, and when both show it
   the run waits (the site's hint, 30 s) and asks again; the run finishes.
3. Stable Diffusion goes away part-way through the pictures: the rest wait on the to-make list, 🖼 Make the rest fills
   it and nothing is made twice.
4. 🗂 Character Forge on a supporting character: portrait → views → sheet; the Book Bible shows them.
5. 📖 Book Bible: every template in all 7 looks, field ids unchanged, PDF through the fake renderer.
6. ✨ Find what changed → approve a character, a place and an item → 📚 Start a sequel → book 2 is made; "as of book
   1" and "as of book 2" differ as they should; the fixed layer is untouched; a per-book portrait is made.
7. Book 2 saved → opened in a fresh Akọwe (another computer) → the series is restored; opened again → merged.
8. Pause / resume / cancel at 3 seeded points never loses work or duplicates entries or pictures.
"""
from __future__ import annotations

import base64
import copy
import json
import random
import re
import threading
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from akowe import binder, binder_html, forge_kinds, book_package, book_pictures, forge, series, series_world as sw
from akowe import providers as prov_mod
from akowe.book_path import BookPath
from akowe.jobs import RetryPolicy

from autobook_fake import BookFakeAI
from test_autobook import make_app, no_provider_sleep, run_book, steps  # noqa: F401
from test_book_pictures import png
from test_series import wait_job

BR = "main"
PDF = b"%PDF-1.7\n% fake journey pdf\n%%EOF\n"
LOOKS = tuple(binder_html.LOOK_VARS)


# ---------------------------------------------------------------------------------------------- fakes
class JourneyBridge:
    """A fake AutoInjector: GET /image/backend, POST /image/request, POST /image/locks, POST /render/pdf.
    ``down``: Stable Diffusion is not connected; ``down_after``: SD goes away after this many pictures were made."""

    def __init__(self):
        self.down = False
        self.down_after: int | None = None
        self.requests: list = []
        self.ok: list = []
        self.locks: dict = {}
        self.lock_posts: list = []
        self.pdf_calls: list = []
        self.on_request = None  # callable(n) run before each picture is answered (pause points)
        bridge = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, status, out):
                data = json.dumps(out).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _sd(self):
                return not bridge.down and not (bridge.down_after is not None and len(bridge.ok) >= bridge.down_after)

            def do_GET(self):
                if self.path == "/image/backend":
                    on = self._sd()
                    return self._send(200, {"ok": True, "connected": on,
                                            "engines": {"sd": {"connected": on}, "chatgpt": {"ready": False}}})
                return self._send(404, {"ok": False, "error": "NOT_FOUND"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if self.path == "/render/pdf":
                    bridge.pdf_calls.append(body)
                    return self._send(200, {"ok": True, "mime": "application/pdf", "bytes": len(PDF), "pages": 2,
                                            "pdfBase64": base64.b64encode(PDF).decode()})
                if self.path == "/image/locks":
                    bridge.lock_posts.append(body)
                    k = body["character"].lower()
                    if k in bridge.locks:
                        return self._send(200, {"ok": True, "created": False, "lock": bridge.locks[k]})
                    bridge.locks[k] = dict(body, id=f"lock-{len(bridge.locks) + 1}")
                    return self._send(200, {"ok": True, "created": True, "lock": bridge.locks[k]})
                if self.path != "/image/request":
                    return self._send(404, {"ok": False, "error": "NOT_FOUND"})
                bridge.requests.append(body)
                n = len(bridge.requests)
                if bridge.on_request:
                    bridge.on_request(n)
                if not self._sd():
                    return self._send(503, {"ok": False, "engine": "sd", "error": "SD_NOT_CONNECTED",
                                            "message": "No Stable Diffusion app is connected."})
                lock = bridge.locks.get(str(body.get("characterLock") or "").lower())
                seed = body.get("seed") if body.get("seed") is not None else (
                    lock["seed"] if lock and lock.get("seed") is not None else 7000 + n)
                bridge.ok.append(body)
                return self._send(200, {"ok": True, "engine": "sd", "purpose": body.get("purpose"),
                                        "view": body.get("view"), "seed": seed, "warnings": [],
                                        "images": [{"seed": seed, "imageBase64": base64.b64encode(png()).decode()}]})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def made(self):
        """(character or place, what) -> how many times it was made."""
        return Counter((r.get("characterLock") or r.get("prompt", "")[:40], r.get("view") or r.get("purpose"))
                       for r in self.ok)

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class SiteErrorAI(BookFakeAI):
    """The fake AI behind two slots (AI-1, AI-2). ``site_errors``: [(from call number, {slots})]: from that answered
    call on, the first call to each named slot shows the site's own error notice instead of an answer (AutoInjector's
    503 SITE_ERROR, classified by the real adapter code)."""

    def __init__(self):
        super().__init__()
        self.site_errors: list = []
        self.n = 0
        self.site_hits: list = []
        self.on_call = None  # callable(n) before each answer (pause points)

    def submit(self, slot, system, user, schema):
        with self.lock:
            n = self.n + 1
            hit = False
            for i, (frm, slots) in enumerate(self.site_errors):
                if n >= frm and slot["slot_id"] in slots:
                    self.site_errors[i] = (frm, slots - {slot["slot_id"]})
                    hit = True
                    break
            if not hit:
                self.n = n
        if hit:
            self.site_hits.append((n, slot["slot_id"]))
            raise prov_mod.AutoInjectorAdapter._classify_http(  # noqa: SLF001 - the real 503 SITE_ERROR mapping
                503, "", {"error": "SITE_ERROR", "site_error": "error", "retry_after_s": 30}, "claude")
        if self.on_call:
            self.on_call(n)
        return super().submit(slot, system, user, schema)


def a01_names(app, pid):
    return [r["data"].get("concept") or "" for r in BookPath(app.engine, "author", pid, BR).approved("A01")]


def char_ids(app, pid):
    return {r["record_id"]: r for r in BookPath(app.engine, "author", pid, BR).approved("A01")}


def name_of(app, pid, rid):
    return forge.public(app.store, pid, BR, rid)["name"]


@pytest.fixture
def journey(tmp_path, no_provider_sleep):  # noqa: F811
    fake = SiteErrorAI()
    app = make_app(tmp_path, fake=fake)
    app.engine.providers.configure_slot("AI-2", {"adapter_id": "anthropic"})
    slept: list = []
    app.autobook.retry_policy = RetryPolicy([15, 30, 60, 120], 600, sleep=slept.append)
    b = JourneyBridge()
    forge.save_bridge_settings(app, {"url": b.url})
    app.saver.save_settings({"path": str(tmp_path / "books")})
    yield app, fake, b, slept, tmp_path
    b.close()


# ---------------------------------------------------------------------------------------------- the journey
def test_the_whole_journey(journey):
    app, fake, b, slept, tmp_path = journey

    # ---- 1 + 2 + 3: Make a book (fantasy, from an idea); a site error mid-run; SD goes away after 3 pictures
    fake.site_errors = [(6, {"AI-1"}), (12, {"AI-1", "AI-2"})]
    b.down_after = 3
    run = run_book(app, {"genre": "Fantasy", "length": "short_story",
                         "idea": "A lamplighter's apprentice finds that the harbour light keeps a drowned city "
                                 "asleep, and someone has put it out."}, timeout=240)
    assert run["status"] == "done", (run["phase"], run.get("problem"),
                                     [(s["id"], s["state"]) for s in run["steps"]])
    pid = run["project_id"]
    assert all(s["state"] in ("done", "skipped") for s in run["steps"]), [(s["id"], s["state"]) for s in run["steps"]]
    st = steps(run)
    assert st["pictures"]["state"] == "done" and st["chapters"]["state"] == "done"
    # 2: AI-1's notice moved call 6 to AI-2; both showing it on call 12 -> the run waited the site's 30 s, then asked
    hits = [h[1] for h in fake.site_hits]
    assert sorted(hits) == ["AI-1", "AI-1", "AI-2"], fake.site_hits  # each notice seen once: no quick re-asks
    assert 30 <= sum(slept) < 60, slept
    evs = app.autobook.get(run["id"])["events"]
    assert any("retrying in 30 s" in (e.get("message") or "") for e in evs), [e["message"] for e in evs][-40:]
    # 1: the profile took the genre and idea
    chars = char_ids(app, pid)
    assert len(chars) >= 2
    assert len(set(a01_names(app, pid))) == len(a01_names(app, pid)), a01_names(app, pid)  # no duplicate people
    prot = book_pictures.protagonist_id(app.store, pid, BR)
    assert prot in chars
    # 3: the protagonist's portrait + 2 views were made before SD went away; the rest are waiting
    waiting = book_pictures.waiting_by_record(app.store, pid, BR)
    assert len(b.ok) == 3
    assert set(waiting) == set(chars), (waiting, list(chars))
    summ = book_pictures.summary(app.store, pid, BR)
    assert summ["missing"] == 5 * len(chars) - 3, summ  # Make the rest gives everyone the full set
    assert waiting[prot] == ["back", "sheet"] and all(waiting[r] == ["portrait"] for r in chars if r != prot), waiting
    data = binder.build(app, pid, BR)
    assert data["pictures"]["waiting_count"] == 2 + (len(chars) - 1)
    # 🖼 Make the rest of the pictures: SD is back
    b.down_after = None
    job = book_pictures.start_rest(app, "author", pid, BR)
    out = forge.wait(app, "author", job["job_id"], 60)
    assert out["status"] == "done" and out["results"][-1]["ok"], out
    for rid in chars:
        assert book_pictures.have(app.store, pid, BR, rid) == set(book_pictures.FULL), rid
    assert not book_pictures.state(app.store, pid, BR)["waiting"]
    made = b.made()
    assert all(n == 1 for n in made.values()), made  # nothing made twice
    assert sum(1 for k in made if k[1] == "portrait") == len(chars)
    # 🔒 every character has a lock (one post each, never twice)
    assert sorted(p["character"].lower() for p in b.lock_posts) == sorted(
        name_of(app, pid, rid).lower() for rid in chars)
    data = binder.build(app, pid, BR)
    assert data["pictures"]["waiting_count"] == 0
    assert all(p["pics"].get("5.1.1") for p in data["pages"] if p["template"] == "5")

    # 1: saved to its folder
    res = app.saver.save_now(pid, BR)
    folder = tmp_path / "books" / res["folder"]
    for f in ("book.akowe", "Book Bible/book-bible.json", "Book Bible/book-bible.md", "Book Bible/Book Bible.docx",
              "Book Bible/Book Bible.pdf"):
        assert (folder / f).is_file() and (folder / f).stat().st_size > 0, f
    assert (folder / "Book Bible" / "Book Bible.pdf").read_bytes() == PDF and not res.get("not_made")
    bible = json.loads((folder / "Book Bible" / "book-bible.json").read_text("utf-8"))
    assert "fantasy" in json.dumps(bible.get("profile") or {}).lower()

    # ---- 4: 🗂 Character Forge on a supporting character: portrait -> views -> sheet
    side = next(rid for rid in chars if rid != prot)
    side_name = name_of(app, pid, side)
    before = len(b.ok)
    for what in ("portrait", "views", "sheet"):
        j = app.forge.start_art("author", pid, BR, side, {"what": what, "engine": "sd"})
        jj = forge.wait(app, "author", j["job_id"], 60)
        assert jj["status"] == "done", (what, jj)
    asked = b.ok[before:]
    assert [r.get("purpose") for r in asked][0] == "portrait" and asked[-1]["purpose"] == "sheet"
    assert len(asked) == 1 + len(forge.VIEW_KEYS) + 1 and all(r.get("characterLock") == side_name for r in asked)
    d = forge.public(app.store, pid, BR, side)
    assert d["art"]["portrait"] and d["art"]["sheet"] and d["counts"]["views_done"] == len(forge.VIEW_KEYS)
    data = binder.build(app, pid, BR)
    page = next(p for p in data["pages"] if p["template"] == "5" and p.get("entry_id") == side)
    for fid, key in (("5.1.1", "portrait"), ("5.3.1", "sheet")):
        assert d["art"][key]["asset_id"] in page["pics"][fid]["url"], (fid, page["pics"].get(fid))
    for fid, view in (("5.3.2", "front"), ("5.3.3", "side"), ("5.3.4", "back")):
        assert d["art"]["views"][view]["asset_id"] in page["pics"][fid]["url"], (fid, page["pics"].get(fid))
    assert len(page["pics"]["5.3.5"]["items"]) == 6

    # ---- 4b: the author types in an item and a group, and starts a magic system in the Forge
    bp = BookPath(app.engine, "author", pid, BR)
    bp.create("A12", {"concept": "The Lamp Key"}, manual_candidate={
        "concept": "The Lamp Key", "attributes": {"properties": "A brass key that wakes the harbour light",
                                                  "origin": "Forged by the first lamplighter"},
        "linked_refs": [], "protected_fact_flags": [], "facts": [_fact("lamp-key", "The Lamp Key")]})
    bp.create("A06", {"concept": "The Lamplighters' Guild"}, manual_candidate={
        "concept": "The Lamplighters' Guild", "attributes": {"membership": "Every lamplighter of the coast",
                                                             "goals": "Keep the lights burning"},
        "linked_refs": [], "protected_fact_flags": [], "facts": [_fact("lamp-guild", "The Lamplighters' Guild")]})
    forge_kinds.create(app.store, pid, BR, "magic", {"name": "The Lamp-Song"})

    # ---- 5: 📖 the binder: every template in all 7 looks; field ids unchanged; PDF through the fake renderer
    base = binder.build(app, pid, BR)
    sch = binder.schema()
    assert {p["template"] for p in base["pages"]} == set(sch)
    ids0 = field_ids(base)
    assert ids0 == {t: sorted(f["id"] for sec in sch[t]["sections"] for f in sec["fields"]) for t in sch}
    html_ids = None
    for look in LOOKS:
        html, dd = binder.export_html(app, pid, BR, look=look)
        assert html.startswith("<!doctype html>") and f'data-look="{look}"' in html, look
        assert field_ids(dd) == ids0, look
        got = set(re.findall(r'data-id="([^"]+)"', html))
        html_ids = got if html_ids is None else html_ids
        assert got == html_ids, look  # the same fields in every look
        docx, _n = binder.export_docx(app, pid, BR, look=look)
        assert docx[:2] == b"PK", look
    assert {fid for t in ids0.values() for fid in t} & html_ids
    n0 = len(b.pdf_calls)
    pdf, name = binder.export_pdf(app, pid, BR, look="fantasy")
    assert pdf == PDF and name.endswith("Book Bible.pdf") and len(b.pdf_calls) == n0 + 1
    sent = b.pdf_calls[-1]["html"]
    assert "<script" not in sent and 'src="/api/' not in sent and 'data-look="fantasy"' in sent
    assert binder.build(app, pid, BR)["book"]["look"] == "fantasy"  # the genre's look

    # ---- 6: ✨ Find what changed -> approve character + place + item -> 📚 Start a sequel
    bp = BookPath(app.engine, "author", pid, BR)
    place_name = bp.rec(next(r["record_id"] for r in bp.approved("A04")))["data"].get("concept")
    prot_name = name_of(app, pid, prot)
    fake.series_script = [{"character_changes": [
        {"name": prot_name, "appearance": [{"text": "a silver burn across the left palm", "chapter": "ch3"}],
         "items_gained": [{"text": "The Lamp Key", "chapter": "ch3"}], "items_lost": [], "abilities_gained": [],
         "abilities_lost": [], "relationships": [], "status": [{"text": "keeper of the harbour light"}]}],
        "thing_changes": [
            {"name": place_name, "kind": "place", "changes": [
                {"category": "ruler", "text": "the Lamplighters' Guild", "chapter": "ch3"}]},
            {"name": "The Lamp Key", "kind": "item", "changes": [
                {"category": "location", "text": "the drowned vault", "chapter": "ch3"}]}]}]
    j = wait_job(app, series.start_find(app, "author", pid, BR))
    assert j["status"] == "done", j
    s = series.linked(app.store, series.of_book(app.store, pid, BR))
    mara = next(k for k, c in s["characters"].items() if c["name"] == prot_name)
    place = next(k for k, t in s["things"].items() if t["kind"] == "place" and t["name"] == place_name)
    item = next(k for k, t in s["things"].items() if t["kind"] == "item" and t["name"] == "The Lamp Key")
    fixed_before = copy.deepcopy(s["characters"][mara]["fixed"])
    sv = series.of_book(app.store, pid, BR)
    assert sv["proposals"]["1"].get(mara) and sv["thing_proposals"]["1"].get(place) and \
        sv["thing_proposals"]["1"].get(item), (sv["proposals"], sv["thing_proposals"])
    assert not sv["changes"] and not sv["thing_changes"]  # nothing used before the author approves
    out = series.approve(app.store, pid, BR, {"key": mara})
    assert out["ok"] and out["portrait_needed"]
    for k in (place, item):
        assert series.approve(app.store, pid, BR, {"key": k})["ok"]
    sv = series.of_book(app.store, pid, BR)
    assert sw.state_as_of(sv, item, 1, "end")["now"]["holder"]["text"] == prot_name  # linked: the ★ holds it
    # the new look: a portrait for book 1 with the same 🔒 lock
    n_ok = len(b.ok)
    pr = series.make_portraits(app, "author", pid, BR)
    assert pr["made"] == 1 and not pr.get("down"), pr
    assert b.ok[n_ok]["characterLock"] == prot_name and "silver burn" in b.ok[n_ok]["prompt"]
    sv = series.of_book(app.store, pid, BR)
    assert sv["portraits"]["1"][mara]["lock"] == prot_name and not (sv.get("portrait_waiting") or {}).get("1")
    # 📚 Start a sequel (pictures on: book 2's own run makes its pictures)
    n_ok, n_locks, lock_before = len(b.ok), len(b.lock_posts), b.locks[prot_name.lower()]["id"]
    sq = series.start_sequel(app, "author", pid, BR, {"author_confirms": True})
    app.autobook.wait_for(sq["run"]["id"], 240)
    run2 = app.autobook.get(sq["run"]["id"])
    assert run2["status"] == "done", (run2["phase"], run2.get("problem"))
    pid2 = run2["project_id"]
    s2 = series.linked(app.store, series.of_book(app.store, pid2, BR))
    assert [x["number"] for x in series.books(s2)] == [1, 2]
    assert s2["characters"][mara]["fixed"] == fixed_before  # the fixed layer is untouched
    prot2 = series.of_book(app.store, pid2, BR)["characters"][mara]["records"][pid2]
    names2 = a01_names(app, pid2)
    assert names2 and len(set(names2)) == len(names2), names2
    assert pid2 in s2["things"][place]["records"] and pid2 in s2["things"][item]["records"]
    # as of book 1 vs as of book 2 (seen from book 2)
    d1 = binder.build(app, pid2, BR, as_of=1)
    d2 = binder.build(app, pid2, BR, as_of=2)
    assert d1["series"]["viewing"]["number"] == 1 and d1["read_only"]
    pg1 = next(p for p in d1["pages"] if p["template"] == "5" and p["title"] == prot_name)
    pg2 = next(p for p in d2["pages"] if p["template"] == "5" and p["title"] == prot_name)
    look1 = pg1["sections"]["5.6"]["fields"]["5.6.1"]
    assert "silver burn" in look1["value"] and look1["source"] == "series:as_of_book_1"
    assert "Lamp Key" in pg1["sections"]["5.10"]["fields"]["5.10.3"]["value"]
    pp1 = next(p for p in d1["pages"] if p["template"] == "7" and p["title"] == place_name)
    assert pp1["sections"]["7.2"]["fields"]["7.2.6"]["value"] == "the Lamplighters' Guild"
    ip1 = next(p for p in d1["pages"] if p["template"] == "8B" and p["title"] == "The Lamp Key")
    assert ip1["sections"]["8B.8"]["fields"]["8B.8.6"]["value"] == "the drowned vault"
    assert ip1["sections"]["8B.2"]["fields"]["8B.2.4"]["value"] == prot_name
    assert [x["number"] for x in pg2["series"]["strip"]] == [1, 2]
    assert pg1["pics"]["5.1.1"]["url"] != pg2["pics"]["5.1.1"]["url"]  # book 1's new-look portrait vs book 2's
    assert sw.state_as_of(s2, place, 2, "start")["now"]["ruler"]["text"] == "the Lamplighters' Guild"
    assert series.state_as_of(s2, mara, 2, "start")["changed"]
    # the sequel's own run: a portrait for every character, the full set for the ★, nothing made twice, and the
    # ★ keeps her 🔒 lock (never a second one)
    for rid in char_ids(app, pid2):
        assert "portrait" in book_pictures.have(app.store, pid2, BR, rid), rid
    assert book_pictures.protagonist_id(app.store, pid2, BR) == prot2  # the ★ of book 1 is the ★ of book 2
    assert book_pictures.have(app.store, pid2, BR, prot2) == set(book_pictures.FULL)
    assert not book_pictures.state(app.store, pid2, BR)["waiting"]
    made2 = Counter((r.get("characterLock"), r.get("view") or r.get("purpose")) for r in b.ok[n_ok:])
    assert made2 and all(n == 1 for n in made2.values()), made2
    p2 = next(r for r in b.ok[n_ok:] if r.get("characterLock") == prot_name and r.get("purpose") == "portrait")
    assert "silver burn" in p2["prompt"], p2["prompt"]  # book 2 starts with the look book 1 left her
    assert b.locks[prot_name.lower()]["id"] == lock_before and all(
        p["character"].lower() != prot_name.lower() or "seed" in p for p in b.lock_posts[n_locks:])
    assert len(b.locks) == len({n.lower() for n in a01_names(app, pid) + names2})

    # ---- 7: book 2 saved -> opened on another computer -> the series is restored; opened again -> merged
    res2 = app.saver.save_now(pid2, BR)
    folder2 = tmp_path / "books" / res2["folder"]
    assert (folder2 / "Book Bible" / "Book Bible.pdf").read_bytes() == PDF
    data2 = (folder2 / "book.akowe").read_bytes()
    other = make_app(tmp_path, name="other-computer")
    r1 = book_package.import_package(other, data2, "author")
    assert r1["series"]["action"] == "restored", r1["series"]
    o_s = series.of_book(other.store, r1["project_id"], BR)
    assert o_s["id"] == s2["id"] and series.number_of(o_s, r1["project_id"]) == 2 and not o_s.get("virtual")
    assert series.state_as_of(o_s, mara, 1, "end")["changed"]
    assert sw.state_as_of(o_s, place, 1, "end")["now"]["ruler"]["text"] == "the Lamplighters' Guild"
    od1 = binder.build(other, r1["project_id"], BR, as_of=1)  # book 1 is not on this computer: still readable
    opg = next(p for p in od1["pages"] if p["template"] == "5" and p["title"] == prot_name)
    assert "silver burn" in opg["sections"]["5.6"]["fields"]["5.6.1"]["value"]
    r2 = book_package.import_package(other, data2, "author")
    assert r2["series"]["action"] == "merged", r2["series"]
    keys = [r["key"] for r in other.store.query("SELECT key FROM settings WHERE key LIKE 'series:%'")]
    assert keys == [f"series:{s2['id']}"]
    o_s = series.get(other.store, s2["id"])
    here = series.of_book(app.store, pid2, BR)
    assert set(o_s["characters"]) == set(here["characters"]) and set(o_s.get("things") or {}) == set(
        here.get("things") or {})
    assert [x["number"] for x in series.books(o_s)] == [1, 2]
    assert json.dumps(o_s["changes"], sort_keys=True) == json.dumps(here["changes"], sort_keys=True)


# ---------------------------------------------------------------------------------------------- 8: pause / resume / cancel
def _book_shape(app, pid):
    """What the book holds: approved names per module, chapters (id -> times in the outline), pictures per character."""
    bp = BookPath(app.engine, "author", pid, BR)
    names = {op: sorted(r["data"].get("concept") or "" for r in bp.approved(op)) for op in ("A01", "A04")}
    outline = bp.outline()
    chs = Counter(c["chapter_id"] for c in bp.outline_chapters(outline)) if outline else Counter()
    pics = {name_of(app, pid, rid): sorted(book_pictures.have(app.store, pid, BR, rid)) for rid in char_ids(app, pid)}
    return names, chs, pics


def _drive(app, run_id, timeout=240):
    """Wait for the run; press ▶ Resume when it paused. Returns the run when it is done or cancelled."""
    for _ in range(20):
        app.autobook.wait_for(run_id, timeout)
        run = app.autobook.get(run_id)
        if run["status"] == "paused":
            app.autobook.resume("author", run_id)
            continue
        return run
    raise AssertionError("the run kept pausing")


@pytest.mark.parametrize("seed", [3, 11, 2026])
def test_pause_resume_cancel_at_three_seeded_points_never_loses_or_doubles(journey, seed):
    app, fake, b, _slept, _tmp = journey
    # a calibration run: how many AI answers and picture requests a whole run has
    events = {"n": 0}

    def count(_n):
        with fake.lock:
            events["n"] += 1
    fake.on_call = count
    b.on_request = count
    cal = run_book(app, {"genre": "Fantasy", "length": "short_story"}, timeout=240)
    assert cal["status"] == "done"
    total = events["n"]
    shape0 = _book_shape(app, cal["project_id"])
    pics_per_book = len(b.ok)
    # three points: pause, pause, cancel (seeded); the run is resumed after each pause, continued after the cancel
    rng = random.Random(seed)
    points = sorted(rng.sample(range(2, total - 1), 3))
    actions = dict(zip(points, ("pause", "pause", "cancel")))
    done: list = []
    events["n"] = 0
    state = {"run": None}

    def hook(_n):
        with fake.lock:
            events["n"] += 1
            act = actions.pop(events["n"], None)
        if act and state["run"]:
            done.append((events["n"], act))
            (app.autobook.pause if act == "pause" else app.autobook.cancel)("author", state["run"])
    fake.on_call = hook
    b.on_request = hook
    ok0, locks0 = len(b.ok), len(b.locks)
    r = app.autobook.start("author", {"author_confirms": True, "genre": "Fantasy", "length": "short_story"})
    state["run"] = r["id"]
    run = _drive(app, r["id"])
    assert run["status"] == "cancelled", (seed, points, done, run["status"], run.get("problem"))
    pid = run["project_id"]
    assert pid, "the book made before the cancel stays"
    kept = _book_shape(app, pid)
    # ▶ Continue making this book: what was made is kept and skipped
    r2 = app.autobook.start("author", {"author_confirms": True, "continue_project": pid})
    state["run"] = None
    run2 = _drive(app, r2["id"])
    assert run2["status"] == "done", (seed, points, done, run2["phase"], run2.get("problem"))
    assert [d[1] for d in done] == ["pause", "pause", "cancel"], (points, done)
    names, chs, pics = _book_shape(app, pid)
    # nothing lost: everything the cancelled run had approved is still there
    for op, got in kept[0].items():
        assert set(got) <= set(names[op]), (op, got, names[op])
    # nothing doubled: the same book as an uninterrupted run (one of each person and place, each chapter once,
    # the same pictures), and no picture was made twice
    assert names == shape0[0], (seed, points, names, shape0[0])
    assert all(n == 1 for n in chs.values()) and len(chs) == len(shape0[1]), chs
    assert pics == shape0[2], (seed, points, pics, shape0[2])
    made = Counter((x.get("characterLock"), x.get("view") or x.get("purpose")) for x in b.ok[ok0:])
    assert all(n == 1 for n in made.values()), (seed, points, made)
    assert len(b.ok) - ok0 == pics_per_book, (seed, points, len(b.ok) - ok0, pics_per_book)
    assert len(b.locks) == locks0  # the same names: every lock was already there, none made again
    assert not book_pictures.state(app.store, pid, BR)["waiting"]
    # every chapter is written (approved prose) and its continuity tracked, as in the uninterrupted book
    bp = BookPath(app.engine, "author", pid, BR)
    outline = bp.outline()
    for c in bp.outline_chapters(outline):
        assert bp.chapter_prose(outline, c["chapter_id"])[2], c["chapter_id"]
    assert _tracked(app, pid) == _tracked(app, cal["project_id"]), (seed, points, done)
    evs = [e for e in app.autobook.get(r["id"])["events"] + app.autobook.get(r2["id"])["events"]
           if e.get("code") == "CONTINUITY_FAILED"]
    assert not evs, evs  # a Pause / Cancel is never reported as "the continuity could not be tracked"


def test_pause_while_continuity_is_tracked_is_a_pause_and_the_chapter_is_tracked_on_resume(journey):
    """Regression: Pause pressed while the AI tracked a chapter's continuity was swallowed as "the continuity of
    chapter … could not be tracked (RunCancelled/RunPaused); the book goes on", and after ▶ Resume the approved
    chapter was skipped, so its continuity was never tracked."""
    app, fake, _b, _slept, _tmp = journey
    state = {"run": None, "paused": 0}
    orig = fake.submit

    def submit(slot, system, user, schema):
        if "tracked_scenes" in (schema.get("properties") or {}) and not state["paused"]:
            state["paused"] += 1
            app.autobook.pause("author", state["run"])
        return orig(slot, system, user, schema)
    fake.submit = submit
    r = app.autobook.start("author", {"author_confirms": True, "length": "short_story", "pictures": False})
    state["run"] = r["id"]
    app.autobook.wait_for(r["id"], 120)
    run = app.autobook.get(r["id"])
    assert state["paused"] == 1 and run["status"] == "paused", run["status"]
    assert steps(run)["chapters"]["state"] == "paused"
    assert not [e for e in run["events"] if e.get("code") == "CONTINUITY_FAILED"], "a pause is not a failure"
    app.autobook.resume("author", r["id"])
    app.autobook.wait_for(r["id"], 120)
    run = app.autobook.get(r["id"])
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    assert all(_tracked(app, run["project_id"])), _tracked(app, run["project_id"])


def _tracked(app, pid):
    from akowe import continuity
    bp = BookPath(app.engine, "author", pid, BR)
    return [continuity.tracked(app.store, pid, BR, c["chapter_id"]) for c in bp.outline_chapters(bp.outline())]


def _fact(subject, name):
    return {"subject_id": subject, "predicate": "entity.name", "value": name, "assertion_type": "FACT",
            "effective_from": None, "effective_to": None, "source_refs": []}


def field_ids(data):
    out = {}
    for p in data["pages"]:
        out.setdefault(p["template"], set()).update(
            fid for sec in p["sections"].values() for fid in sec["fields"])
    return {k: sorted(v) for k, v in out.items()}
