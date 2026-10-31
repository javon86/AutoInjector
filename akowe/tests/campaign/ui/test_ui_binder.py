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
    assert odile.locator(".bnd-facts .bnd-fact").count() == 16                  # 📋 quick stats fact sheet
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
