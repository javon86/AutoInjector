"""🧭 The journey's main screens in the browser, on REAL data (tests/test_journey_e2e.py's fake AI and fake AutoInjector):
a fantasy book made with ⚡ Make a book (pictures, 🔒 locks), the Character Forge art of a supporting character, an item,
a group and a magic system, ✨ Find what changed approved and 📚 a sequel (book 2).

At 1920×1080 and at a narrow 1280×720 every screen — the book page, ⚡ Make a book, 🗂 Character Forge, 📖 Book Bible (each
of the 7 looks), the 📚 Series panel and 🖼 Pictures — has no console errors or failed requests, no sideways scrolling,
and no button that overlaps another or is cut off. Screenshots go to $BF_UI_SHOTS (see ui_helpers.shot)."""
from __future__ import annotations

import threading
import time
import types
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from .ui_helpers import assert_clean, bad_text, goto, open_make_book, overflow, settle, shot, watch

from test_autobook import make_app, run_book
from test_journey_e2e import BR, LOOKS, JourneyBridge, _fact, name_of
from test_server import TOKEN
from test_series import wait_job

SIZES = [(1920, 1080), (1280, 720)]

# Visible buttons (and button-like links) of the screen that overlap each other or are cut off: outside the window
# sideways, clipped by an ancestor that hides its overflow, or with their own label clipped.
LAYOUT_JS = """(root) => {
  const sel = 'button, [role=button], a.btn, a.button, select, input[type=button], input[type=submit]';
  const els = [];
  for (const el of (document.querySelector(root) || document).querySelectorAll(sel)) {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    if (el.closest('[hidden], dialog:not([open]), details:not([open]) > :not(summary)')) continue;
    if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) continue;
    if (cs.position === 'fixed' && el.closest('.toast, [role=status]')) continue;
    els.push(el);
  }
  const name = el => ((el.getAttribute('aria-label') || el.textContent || el.value || el.tagName) + '').trim()
    .replace(/\\s+/g, ' ').slice(0, 40) + (el.dataset.testid ? ` [${el.dataset.testid}]` : '');
  const out = [];
  const W = document.documentElement.clientWidth;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.left < -1 || r.right > W + 1) out.push(`cut off by the window: ${name(el)} (${Math.round(r.left)}..${Math.round(r.right)} of ${W})`);
    if (el.tagName === 'BUTTON' && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible')
      out.push(`label clipped: ${name(el)} (${el.scrollWidth} > ${el.clientWidth})`);
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const ac = getComputedStyle(a);
      if (ac.overflowX === 'hidden' || ac.overflowY === 'hidden' || ac.overflow === 'hidden' || ac.overflow === 'clip') {
        const ar = a.getBoundingClientRect();
        if (r.right > ar.right + 1 || r.left < ar.left - 1 || r.bottom > ar.bottom + 1 || r.top < ar.top - 1) {
          out.push(`cut off by its box: ${name(el)} in ${a.tagName.toLowerCase()}.${(a.className + '').split(' ')[0]}`);
          break;
        }
      }
    }
  }
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
    const a = els[i], b = els[j];
    if (a.contains(b) || b.contains(a)) continue;
    const r = a.getBoundingClientRect(), s = b.getBoundingClientRect();
    const w = Math.min(r.right, s.right) - Math.max(r.left, s.left), h = Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top);
    if (w > 2 && h > 2) out.push(`overlap: ${name(a)} × ${name(b)} (${Math.round(w)}×${Math.round(h)} px)`);
  }
  return out;
}"""


def layout_problems(page, root="#main"):
    return page.evaluate(LAYOUT_JS, root)


def check_screen(page, what, root="#main"):
    settle(page, 300)
    probs = layout_problems(page, root)
    w = page.viewport_size["width"]
    shot(page, f"journey-{what}-{w}")
    assert overflow(page) <= 1, f"{what} at {w}: sideways scrolling"
    assert not probs, f"{what} at {w}:\n" + "\n".join(probs)
    assert not bad_text(page), f"{what} at {w}: {bad_text(page)}"
    assert_clean(page, f"{what} at {w}")


@pytest.fixture(scope="module")
def jw(tmp_path_factory):
    from akowe import book_pictures, forge, forge_kinds, series
    from akowe import providers as prov_mod
    from akowe.book_path import BookPath
    from akowe.server import make_handler
    from autobook_fake import BookFakeAI
    mp = pytest.MonkeyPatch()
    mp.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic, time=time.time))
    tmp = tmp_path_factory.mktemp("journey-ui")
    fake = BookFakeAI()
    app = make_app(tmp, fake=fake)
    b = JourneyBridge()
    forge.save_bridge_settings(app, {"url": b.url})
    app.saver.save_settings({"path": str(tmp / "books")})
    b.down_after = 3  # Stable Diffusion goes away after 3 pictures: the rest wait on the to-make list
    run = run_book(app, {"genre": "Fantasy", "length": "short_story"}, timeout=240)
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    b.down_after = None
    prot = book_pictures.protagonist_id(app.store, pid, BR)
    bp = BookPath(app.engine, "author", pid, BR)
    side = next(r["record_id"] for r in bp.approved("A01") if r["record_id"] != prot)
    for what in ("portrait", "views", "sheet"):
        j = app.forge.start_art("author", pid, BR, side, {"what": what, "engine": "sd"})
        assert forge.wait(app, "author", j["job_id"], 60)["status"] == "done"
    bp.create("A12", {"concept": "The Lamp Key"}, manual_candidate={
        "concept": "The Lamp Key", "attributes": {"properties": "A brass key that wakes the harbour light"},
        "linked_refs": [], "protected_fact_flags": [], "facts": [_fact("lamp-key", "The Lamp Key")]})
    bp.create("A06", {"concept": "The Lamplighters' Guild"}, manual_candidate={
        "concept": "The Lamplighters' Guild", "attributes": {"goals": "Keep the lights burning"},
        "linked_refs": [], "protected_fact_flags": [], "facts": [_fact("lamp-guild", "The Lamplighters' Guild")]})
    forge_kinds.create(app.store, pid, BR, "magic", {"name": "The Lamp-Song"})
    assert wait_job(app, series.start_find(app, "author", pid, BR))["status"] == "done"
    s = series.linked(app.store, series.of_book(app.store, pid, BR))
    mara = next(k for k, c in s["characters"].items() if c["name"] == name_of(app, pid, prot))
    series.approve(app.store, pid, BR, {"key": mara})
    series.make_portraits(app, "author", pid, BR)
    sq = series.start_sequel(app, "author", pid, BR, {"author_confirms": True, "pictures": False})
    app.autobook.wait_for(sq["run"]["id"], 240)
    run2 = app.autobook.get(sq["run"]["id"])
    assert run2["status"] == "done", run2.get("problem")
    pid2 = run2["project_id"]
    # book 1 still has pictures waiting? No: make the rest now so book 1 is complete; book 2's are on the list
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    yield SimpleNamespace(app=app, pid=pid, pid2=pid2, side=side, prot=prot, bridge=b,
                          url=f"http://127.0.0.1:{port}/#token={TOKEN}")
    httpd.shutdown()
    httpd.server_close()
    b.close()
    mp.undo()


def open_page(make_context, jw, width, height):
    page = watch(make_context(width=width, height=height).new_page())
    page.goto(jw.url)
    page.wait_for_selector("#main h1", timeout=15000)
    settle(page)
    return page


def open_bible(page, pid, page_id=None):
    page.evaluate("h => { location.hash = h; }", f"#/p/{pid}/main/bible" + (f"/{page_id}" if page_id else ""))
    page.wait_for_selector(".bnd-page", timeout=20000)
    page.wait_for_function("() => !document.querySelector('#main .state.loading, [data-img-loading]')", timeout=20000)
    page.wait_for_timeout(200)


@pytest.mark.parametrize("width,height", SIZES)
def test_book_page_make_a_book_forge_and_pictures(make_context, jw, width, height):
    page = open_page(make_context, jw, width, height)
    # the book page
    goto(page, f"#/p/{jw.pid}/main/book")
    check_screen(page, "book-page", root="body")  # the top bar and the side bar too
    # ⚡ Make a book: the finished run's window
    open_make_book(page)
    page.locator("#mab-dialog").wait_for(timeout=10000)
    check_screen(page, "make-a-book", root="#mab-dialog")
    page.keyboard.press("Escape")
    # 🗂 Character Forge: the supporting character with portrait, ten views and a sheet
    goto(page, f"#/p/{jw.pid}/main/forge/{jw.side}")
    page.wait_for_selector("[data-testid=forge-page] .forge-name", timeout=15000)
    page.wait_for_function("() => document.querySelectorAll('[data-testid=forge-views] img').length === 10", timeout=15000)
    check_screen(page, "forge")
    # 🖼 Pictures
    goto(page, f"#/p/{jw.pid}/main/pictures")
    page.wait_for_selector("[data-testid=pictures-page]", timeout=20000)
    check_screen(page, "pictures")


@pytest.mark.parametrize("width,height", SIZES)
def test_book_bible_every_look_and_the_series_panel(make_context, jw, width, height):
    page = open_page(make_context, jw, width, height)
    open_bible(page, jw.pid2)
    for look in LOOKS:
        page.select_option("[data-testid=binder-look]", look)
        page.wait_for_function("l => document.querySelector('[data-testid=binder]').dataset.look === l", arg=look)
        check_screen(page, f"bible-{look}")
    # a character page with the "Through the series" strip, and 📖 As of book 1
    page.select_option("[data-testid=binder-look]", "fantasy")
    sel = page.locator("[data-testid=binder-as-of]")
    assert sel.is_visible()
    sel.select_option("1")
    page.wait_for_selector("[data-testid=binder-as-of-note] .bnd-asof-banner", timeout=15000)
    check_screen(page, "bible-as-of-1")
    page.click("[data-testid=binder-as-of-note] button")
    page.wait_for_function("() => !document.querySelector('[data-testid=binder-as-of-note] .bnd-asof-banner')")
    # 📚 the Series panel
    page.click("[data-testid=binder-series]")
    page.wait_for_selector("[data-testid=binder-series-box]", timeout=15000)
    check_screen(page, "series-panel")
