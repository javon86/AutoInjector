"""The simple top bar and side bar (2026-11, "the toolbar doesn't make any sense to me"): a writer sees plain places
(📚 My books, the book's name, 💾 Save, ⚙️ Settings, ❓ Help, ⋯ More) and the parts of the book on the left with a
highlighted 📖 Book Bible; 🛠 Advanced view adds the A–K step sets and the expert tools back (nothing removed, only moved).
No icon-only buttons and no sideways scrolling at 1280×720 and 1920×1080; every old route still opens."""
from __future__ import annotations

import re

import pytest

from .ui_helpers import SHOTS, assert_clean, goto, open_app, overflow, set_mode, settle, shot

SIZES = [(1280, 720), (1920, 1080)]
SIDE = ["Book home", "Characters & places", "Plan", "Write", "Book Bible", "Pictures & cover", "Trailer", "Fix mistakes", "Export"]
OLD_ROUTES = ["", "book", "forge", "pictures", "cover", "trailer", "continuity", "journal", "grid", "costs", "activity",
              "progress", "manifest", "world", "review", "bible", "set/A", "op/B01"]
NEW_ROUTES = ["people", "plan", "write", "art", "fix", "export"]

# every visible control in the top bar and the side bar: its visible words (not only an emoji, not only a tooltip)
WORDLESS_JS = """() => {
  const out = [];
  for (const el of document.querySelectorAll('.topbar a, .topbar button, .topbar select, #sidenav a, #sidenav button')) {
    if (el.closest('.tb-pop')) continue;   // closed menus
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true }))) continue;
    if (el.closest('.hz, .hazard, .info-wrap')) continue;   // the small ⚠️ hazard / ⓘ markers carry their own names
    const words = (el.tagName === 'SELECT' ? (el.selectedOptions[0] || {}).textContent : el.innerText) || '';
    if (!/[A-Za-z]{2,}/.test(words)) out.push(el.outerHTML.slice(0, 140));
  }
  return out;
}"""


@pytest.fixture(scope="module")
def nb(ai_server):
    p = ai_server.api("POST", "/projects", {"name": "The Lamplighter", "features": {}, "release_profiles": ["MANUSCRIPT_PDF"],
                                           "story_time_unit": "seconds", "currency": "USD"})
    return p["project_id"]


def view_shot(page, name):
    """What the writer sees on screen (not the whole scrolled page)."""
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SHOTS / f"{name}.png"))


def visible(page, sel):
    loc = page.locator(sel)
    return loc.count() > 0 and loc.first.is_visible()


def check_bar(page, what):
    assert overflow(page) <= 0, f"{what}: the page scrolls sideways by {overflow(page)}px"
    wordless = page.evaluate(WORDLESS_JS)
    assert not wordless, f"{what}: buttons without words: {wordless}"


@pytest.mark.parametrize("width,height", SIZES)
def test_simple_view_shows_only_the_new_bar_and_side_bar(make_context, ai_server, nb, width, height):
    page = open_app(make_context(width, height), ai_server, f"#/p/{nb}/main/book")
    assert page.evaluate("document.documentElement.dataset.mode") == "simple"   # the default
    top = page.inner_text(".topbar")
    for words in ("Akọwe", "My books", "The Lamplighter", "Save", "Settings", "Help", "More"):
        assert words in top or words in page.locator("#project-select").inner_text(), (words, top)
    for sel in ("#sets-btn", "#jump-btn", "#health-btn", "#wf-btn", "#branch-select", "#new-btn"):
        if sel == "#health-btn" and page.get_attribute(sel, "data-state") == "problem":
            continue   # a real problem with the AI connection shows in Simple view too
        assert not visible(page, sel), f"{sel} shows in Simple view inside a book"
    assert not visible(page, "#mab-btn"), "the run chip shows although no AI run is working"
    labels = [x.strip() for x in page.locator("#sidenav .side-link .sl-lab").all_inner_texts()]
    assert labels == SIDE, labels
    nav_task = page.inner_text("#nav-task").lower()
    assert "next step" in nav_task and "waiting for your ok" in nav_task, nav_task
    assert not page.locator("#sidenav .set-group").first.is_visible(), "the A–K sets show in Simple view"
    bible = page.locator("#sidenav .side-bible")
    assert bible.evaluate("e => getComputedStyle(e).backgroundColor") == "rgb(255, 212, 38)", "📖 Book Bible is not highlighted"
    check_bar(page, f"book home {width}")
    shot(page, f"nav_simple_book_home_{width}")
    view_shot(page, f"nav_simple_screen_{width}")
    # ⋯ More: grouped under plain headings
    page.click("#more-btn")
    page.wait_for_selector("#more-pop:not([hidden])")
    heads = page.locator("#more-pop .more-h").all_inner_texts()
    assert [x.strip().lower() for x in heads if x.strip()][:4] == ["this book", "files", "your style", "help"], heads
    more = page.inner_text("#more-pop")
    for words in ("Journal", "Scene grid", "Time and AI use", "Activity", "Open folder", "Open a saved book", "My finished books", "My writing style"):
        assert words in more, (words, more)
    assert "Test everything" not in more and "Book features" not in more
    view_shot(page, f"nav_simple_more_{width}")
    page.keyboard.press("Escape")
    # outside a book: ➕ New book is in the bar, with words
    goto(page, "#/")
    assert page.inner_text("#main h1") == "📚 My books"
    assert visible(page, "#new-btn") and "New book" in page.inner_text("#new-btn")
    check_bar(page, f"my books {width}")
    shot(page, f"nav_simple_my_books_{width}")
    assert_clean(page, "simple view")


@pytest.mark.parametrize("width,height", SIZES)
def test_advanced_view_adds_the_sets_and_expert_tools(make_context, ai_server, nb, width, height):
    page = open_app(make_context(width, height), ai_server, f"#/p/{nb}/main/book")
    page.click("#mode-toggle")
    page.wait_for_function("() => document.documentElement.dataset.mode === 'advanced'")
    assert page.get_attribute("#mode-toggle", "aria-checked") == "true"
    for sel in ("#sets-btn", "#jump-btn", "#health-btn", "#wf-btn", "#branch-select"):
        assert visible(page, sel), f"{sel} is missing in Advanced view"
    assert "Health" in page.inner_text("#health-btn") and "Test workflow" in page.inner_text("#wf-btn")
    groups = page.locator("#sidenav .set-group")
    assert groups.count() == 11 and groups.first.is_visible()
    names = page.locator("#sidenav .set-toggle .set-name").all_inner_texts()
    assert "Universe & Characters" in names and "Storage & Context" in names and "Project Control" in names
    assert page.locator("#sidenav .set-toggle").first.get_attribute("title") == "Set A"   # codes on hover
    assert page.locator("[data-testid=book-adv]").is_visible()   # the old overview's details live on Book home now
    page.click("#more-btn")
    more = page.inner_text("#more-pop")
    assert "Test everything" in more and "Book features" in more and "Character & place maker" in more
    page.keyboard.press("Escape")
    check_bar(page, f"advanced {width}")
    shot(page, f"nav_advanced_book_home_{width}")
    view_shot(page, f"nav_advanced_screen_{width}")
    # remembered: still Advanced after a reload; Ctrl+K jumps in both views
    page.reload()
    page.wait_for_selector("#main h1", timeout=15000)
    assert page.evaluate("document.documentElement.dataset.mode") == "advanced"
    page.click("#mode-toggle")
    page.wait_for_function("() => document.documentElement.dataset.mode === 'simple'")
    page.keyboard.press("Control+k")
    page.wait_for_selector("#jump-dialog[open]")
    page.keyboard.press("Escape")
    assert_clean(page, "advanced view")


def test_settings_has_the_switch_and_the_ai_connection_line(make_context, ai_server, nb):
    page = open_app(make_context(1280, 720), ai_server, "#/settings")
    assert page.inner_text("#main h1") == "⚙️ Settings"
    page.wait_for_function("() => /AI connection: (✔ OK|⚠️)/.test(document.querySelector('[data-testid=ai-conn-line]').textContent)", timeout=15000)
    page.click("#mode-toggle-settings")
    page.wait_for_function("() => document.documentElement.dataset.mode === 'advanced'")
    assert page.get_attribute("#mode-toggle", "aria-checked") == "true"   # the side bar's switch follows
    set_mode(page, "simple")
    check_bar(page, "settings")
    assert_clean(page, "settings")


def test_book_bible_is_one_click_away(make_context, ai_server, nb):
    page = open_app(make_context(1280, 720), ai_server, f"#/p/{nb}/main/book")
    # from Book home: the big button beside ▶ Next step
    head = page.locator("#main .page-head")
    assert head.get_by_role("button", name="▶ Next step").count() == 1
    page.click("[data-testid=home-bible]")
    page.wait_for_function("() => location.hash.endsWith('/bible')", timeout=5000)
    page.wait_for_selector("#main h1", timeout=15000)
    # from the side bar, from any page
    goto(page, f"#/p/{nb}/main/journal")
    page.click("#sidenav .side-bible")
    page.wait_for_function("() => location.hash.endsWith('/bible')", timeout=5000)
    page.wait_for_selector("#main h1", timeout=15000)
    # the side bar is drawn again after the page changes; "#main h1" can still be the old page's heading for a
    # moment (CI raced here), so wait for the highlight itself
    page.wait_for_function("() => document.querySelector('#sidenav .side-bible')?.getAttribute('aria-current') === 'page'", timeout=10000)
    assert page.get_attribute("#sidenav .side-bible", "aria-current") == "page"
    # from My books: every book card has one
    goto(page, "#/")
    card = page.locator(f"#main .book-card[data-pid='{nb}']")
    assert card.locator("[data-testid=card-bible]").inner_text() == "📖 Book Bible"
    card.locator("[data-testid=card-bible]").click()
    page.wait_for_function("() => location.hash.endsWith('/bible')", timeout=5000)
    # the small link in the Saved card stays
    goto(page, f"#/p/{nb}/main/book")
    assert page.get_attribute("[data-testid=open-binder]", "href") == f"#/p/{nb}/main/bible"
    page.bf_problems[:] = [p for p in page.bf_problems if "/binder" not in p]   # the binder API is the binder tests' business
    assert_clean(page, "book bible buttons")


def test_plain_names_and_no_make_a_book_on_a_book_page(make_context, ai_server, nb):
    page = open_app(make_context(1280, 720), ai_server, f"#/p/{nb}/main")
    # the old overview address opens 🏠 Book home
    page.wait_for_function("() => location.hash.endsWith('/main/book')", timeout=5000)
    assert page.inner_text("#main h1") == "🏠 Book home"
    body = page.inner_text("body")
    for old in ("Make a book for me", "Make my book", "Bible Builder", "Overview", "Needs your approval", "Rerun from the book bible",
                "Operation sets", "Module sets", "Your projects"):
        assert old not in body, f"old name on the book page: {old}"
    assert "Make a new book from this one’s plan" in body
    assert page.locator("#main summary", has_text="⬇ Download…").count() == 1   # book-bible.json / .md under Download…
    goto(page, "#/")
    home = page.inner_text("#main")
    assert "Your projects" not in home and "records on main" not in home and nb not in home   # ids only in Advanced view
    assert page.get_by_role("button", name="AI writes the whole book").count() == 1
    assert_clean(page, "plain names")


def test_new_book_is_one_choice(make_context, ai_server):
    page = open_app(make_context(1280, 720), ai_server, "#/")
    page.click("#new-btn")
    page.wait_for_function("() => location.hash === '#/start'")
    settle(page)
    choice = page.inner_text("[data-testid=new-choice]")
    assert "Write it with me" in choice and "AI writes the whole book" in choice
    page.click("[data-testid=start-ai]")
    page.wait_for_selector("#mab-dialog[open]", timeout=10000)
    assert "AI writes the whole book" in page.inner_text("#mab-dialog h2")
    page.keyboard.press("Escape")
    assert_clean(page, "new book")


@pytest.mark.parametrize("width,height", SIZES)
def test_section_pages_and_old_routes_still_open(make_context, ai_server, nb, width, height):
    page = open_app(make_context(width, height), ai_server)
    for r in NEW_ROUTES:
        goto(page, f"#/p/{nb}/main/{r}")
        assert page.locator(f"[data-testid=landing-{r}]").count() == 1, r
        btns = page.locator(f"[data-testid=landing-{r}] .landing-btn")
        assert btns.count() >= 2, r
        for t in btns.all_inner_texts():
            assert re.search(r"[A-Za-z]{3}.*\n?.*[a-z]{3}", t), (r, t)   # a name and a one-line explanation
        cur = page.locator("#sidenav .side-link[aria-current=page]")
        assert cur.count() == 1, r
        check_bar(page, f"{r} {width}")
        if width == 1280:
            shot(page, f"nav_section_{r}")
    for r in OLD_ROUTES:
        goto(page, f"#/p/{nb}/main/{r}" if r else f"#/p/{nb}/main")
        h1 = page.inner_text("#main h1")
        assert h1 and h1 != "Page not found", (r, h1)
    for r in ("#/shelf", "#/style", "#/settings", "#/start", "#/help"):
        goto(page, r)
        assert page.inner_text("#main h1") != "Page not found", r
        check_bar(page, f"{r} {width}")
    shot(page, f"nav_help_{width}")
    page.bf_problems[:] = [p for p in page.bf_problems if "/binder" not in p]
    assert_clean(page, "routes")
