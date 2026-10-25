"""Click every visible button on the main pages (fresh page state per click) and check that something visible
happens: navigation, a dialog/popover, a toast, a confirm(), a download or a change of the page. Dead buttons are bugs.
Buttons that ask for confirmation are dismissed (confirm() -> Cancel, <dialog> -> Escape)."""
from __future__ import annotations

import time

import pytest

from .ui_helpers import goto, open_app, settle, shot

OBSERVE = """() => {
  window.__bfMut = 0;
  if (window.__bfObs) window.__bfObs.disconnect();
  const ignore = n => { const el = n.nodeType === 1 ? n : n.parentElement;
    return !el || !!el.closest('#live, #nav-task, .task-slot, .task-card'); };
  window.__bfObs = new MutationObserver(ms => { for (const m of ms) if (!ignore(m.target)) window.__bfMut++; });
  window.__bfObs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
}"""

LIST_BUTTONS = """() => Array.from(document.querySelectorAll('#main button')).filter(b => {
  const r = b.getBoundingClientRect(); return r.width && r.height && !b.disabled && !b.closest('[hidden]') && (!b.checkVisibility || b.checkVisibility({ checkVisibilityCSS: true }));
}).map((b, i) => ({ i, label: (b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) }))"""

TAG = """label => { const bs = Array.from(document.querySelectorAll('#main button')).filter(b => {
  const r = b.getBoundingClientRect(); return r.width && r.height && !b.disabled && !b.closest('[hidden]') && (!b.checkVisibility || b.checkVisibility({ checkVisibilityCSS: true })); });
  const b = bs.find(x => (x.getAttribute('aria-label') || x.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) === label);
  if (!b) return false; b.setAttribute('data-bf-click', '1'); return true; }"""

SKIP = ("Retry", "Try again")   # need a failed state first


CLICKED = []


def click_all(page, route, label_filter=None, max_buttons=18):
    goto(page, route)
    buttons = page.evaluate(LIST_BUTTONS)
    seen, dead = set(), []
    for b in buttons[:max_buttons]:
        if b["label"] in seen or any(s in b["label"] for s in SKIP):
            continue
        if label_filter and not label_filter(b["label"]):
            continue
        seen.add(b["label"])
        goto(page, route)
        url0 = page.url
        page.evaluate(OBSERVE)
        n_dialogs = len(page.bf_dialogs)
        downloads = []
        page.once("download", lambda d: downloads.append(d))
        err = None
        for _attempt in range(3):
            if not page.evaluate(TAG, b["label"]):
                err = "gone"
                break
            try:
                page.locator("[data-bf-click]").click(timeout=1500)
                err = None
                break
            except Exception as e:  # noqa: BLE001 - re-rendered under us: tag again
                err = str(e)[:300]
                page.wait_for_timeout(300)
        if err == "gone":
            continue
        if err:
            dead.append(f"{b['label']!r}: not clickable ({err})")
            shot(page, f"unclickable_{route.split('/')[-1] or 'home'}_{len(dead)}")
            continue
        CLICKED.append((route, b["label"]))
        alive = False
        t0 = time.time()
        while time.time() - t0 < 1.5 and not alive:
            page.wait_for_timeout(100)
            alive = (page.url != url0 or page.evaluate("window.__bfMut || 0") > 0
                     or len(page.bf_dialogs) > n_dialogs or bool(downloads)
                     or page.locator("dialog[open], #toast:not([hidden])").count() > 0)
        if not alive:
            dead.append(f"{b['label']!r}: nothing visible happened")
            shot(page, f"dead_{route.split('/')[-1] or 'home'}_{len(dead)}")
        # close whatever opened (dialogs, Fill-with-AI dock panels, the workflow drawer)
        page.evaluate("""() => { for (const b of document.querySelectorAll('#ai-dock button[aria-label^="Close Fill with AI"]')) b.click();
                                const wf = document.querySelector('#wf-drawer'); if (wf && !wf.hidden) document.querySelector('#wf-btn').click(); }""")
        for _ in range(3):
            if page.locator("dialog[open]").count():
                page.keyboard.press("Escape")
                page.wait_for_timeout(120)
    return seen, dead


@pytest.fixture(scope="module")
def book(ai_server):
    r = ai_server.api("POST", "/autobook", {"author_confirms": True})
    for _ in range(200):
        s = ai_server.api("GET", "/autobook/" + r["id"])
        if s["status"] not in ("queued", "running", "pausing"):
            break
        time.sleep(0.3)
    assert s["status"] == "done", s
    return s["project_id"]


@pytest.fixture(scope="module")
def page(browser, ai_server, book):
    ctx = browser.new_context(viewport={"width": 1366, "height": 900}, accept_downloads=True)
    pg = open_app(ctx, ai_server)
    yield pg
    ctx.close()


PAGES = ["", "/book", "/review", "/journal", "/progress", "/set/A", "/op/A01", "/op/G11"]


@pytest.mark.parametrize("sub", PAGES)
def test_no_dead_buttons_in_book(page, book, sub):
    seen, dead = click_all(page, f"#/p/{book}/main{sub}")
    assert seen, "no buttons found"
    assert not dead, "\n".join(dead)


@pytest.mark.parametrize("route", ["#/", "#/settings", "#/shelf"])
def test_no_dead_buttons_outside_book(page, book, route):
    seen, dead = click_all(page, route,
                           label_filter=lambda lbl: "Restore" not in lbl)  # restore has its own test (typed RESTORE)
    assert not dead, "\n".join(dead)


def test_finished_files_still_verify_after_clicking_everything(page, ai_server, book):
    """After every button above was pressed once, the shelf must still list hash-verified files (UI and API agree)."""
    shelf = ai_server.api("GET", "/shelf")["books"]
    mine = [b for b in shelf if b["project_id"] == book]
    assert mine, shelf
    bad = [(f["format"], f["record_id"]) for f in mine[0]["files"] if not f["verified"]]
    goto(page, "#/shelf")
    ui_problem = page.locator("#main .hazard, #main [class*=hazard]").count()
    if bad or ui_problem:
        shot(page, "shelf_after_clicks")
    assert not bad, f"unverified files after clicking: {bad}; clicked: {CLICKED}"
    assert not ui_problem, f"shelf shows a problem; clicked: {CLICKED}"
