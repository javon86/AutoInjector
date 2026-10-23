"""Keyboard, dialogs, browser history and the clipboard helpers (clipboard.js) in a real browser."""
from __future__ import annotations

import json
import time

import pytest

from .ui_helpers import assert_clean, goto, open_app, settle, shot


@pytest.fixture(scope="module")
def book(ai_server):
    r = ai_server.api("POST", "/autobook", {"author_confirms": True})
    for _ in range(300):
        s = ai_server.api("GET", "/autobook/" + r["id"])
        if s["status"] not in ("queued", "running", "pausing"):
            break
        time.sleep(0.2)
    assert s["status"] == "done", s
    recs = ai_server.api("GET", f"/projects/{s['project_id']}/branches/main/records")
    return {"pid": s["project_id"], "records": recs}


def focused(page):
    return page.evaluate("""() => { const e = document.activeElement; if (!e) return '';
        return (e.id ? '#' + e.id : e.tagName.toLowerCase()) + ' ' + (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 40); }""")


def test_skip_link_and_tab_order(make_context, ai_server, book):
    page = open_app(make_context(), ai_server, f"#/p/{book['pid']}/main")
    page.focus(".skip-link")
    assert page.locator(".skip-link").bounding_box()["y"] >= -1, "the skip link stays off screen when focused"
    page.keyboard.press("Enter")
    page.wait_for_timeout(150)
    assert focused(page).startswith("#main"), focused(page)
    # Tab through the top bar from the brand: every stop is visible and named, left to right
    page.focus(".brand")
    stops = []
    for _ in range(12):
        info = page.evaluate("""() => { const e = document.activeElement; const r = e.getBoundingClientRect();
            return { inTop: !!e.closest('.topbar'), x: r.x, y: r.y, vis: r.width > 0 && r.height > 0,
                     name: (e.getAttribute('aria-label') || e.textContent || e.title || '').trim().slice(0, 30) }; }""")
        stops.append(info)
        page.keyboard.press("Tab")
    top = [s for s in stops if s["inTop"]]
    assert len(top) >= 8, stops
    assert all(s["vis"] and s["name"] for s in top), [s for s in top if not (s["vis"] and s["name"])]
    xs = [s["x"] for s in top]
    assert xs == sorted(xs), f"tab order jumps around the top bar: {[(s['name'], s['x']) for s in top]}"


def test_jump_dialog_keyboard(make_context, ai_server, book):
    page = open_app(make_context(), ai_server, f"#/p/{book['pid']}/main")
    page.keyboard.press("Control+k")
    page.wait_for_selector("#jump-dialog[open]")
    assert focused(page).startswith("#jump-input")
    page.keyboard.press("Escape")
    page.wait_for_timeout(150)
    assert not page.locator("#jump-dialog[open]").count()
    assert focused(page).startswith("#jump-btn") or focused(page).startswith("#main"), focused(page)
    # "/" opens it too; type an op id, Enter goes there
    page.locator("#main").click(position={"x": 5, "y": 5})
    page.keyboard.press("/")
    page.wait_for_selector("#jump-dialog[open]")
    page.keyboard.type("B11")
    page.wait_for_timeout(150)
    page.keyboard.press("Enter")
    page.wait_for_function("() => location.hash.endsWith('/op/B11')", timeout=5000)
    settle(page)
    assert "B11" in page.inner_text("#main h1")
    assert not page.locator("#jump-dialog[open]").count()
    # arrows move the selection
    page.keyboard.press("Control+k")
    page.wait_for_selector("#jump-dialog[open]")
    page.keyboard.type("chapter")
    page.wait_for_timeout(150)
    sel0 = page.locator("#jump-list [aria-selected=true]").inner_text()
    page.keyboard.press("ArrowDown")
    sel1 = page.locator("#jump-list [aria-selected=true]").inner_text()
    assert sel0 != sel1
    page.keyboard.press("Escape")
    assert_clean(page, "jump")


def test_escape_closes_dialogs_and_returns_focus(make_context, ai_server, book):
    page = open_app(make_context(), ai_server, f"#/p/{book['pid']}/main/book")
    for opener, dlg in (("#mab-btn", "#mab-dialog"), ("#health-btn", "#health-dialog")):
        page.focus(opener)
        page.keyboard.press("Enter")
        page.wait_for_selector(f"{dlg}[open]", timeout=5000)
        page.wait_for_timeout(300)
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        assert not page.locator(f"{dlg}[open]").count(), f"{dlg} did not close on Escape"
        assert focused(page).startswith(opener), f"focus after closing {dlg}: {focused(page)}"
    btn = page.get_by_role("button", name="📝 Book profile")
    btn.focus()
    page.keyboard.press("Enter")
    page.wait_for_selector("dialog[open]")
    assert page.evaluate("document.activeElement.tagName") in ("INPUT", "TEXTAREA", "SELECT")
    page.keyboard.press("Escape")
    page.wait_for_timeout(150)
    assert not page.locator("dialog[open]").count()
    assert "Book profile" in focused(page), focused(page)
    # the Sets menu: Enter opens it, Escape closes it, aria-expanded follows
    page.focus("#sets-btn")
    page.keyboard.press("Enter")
    page.wait_for_selector("#sets-pop:not([hidden])")
    assert page.get_attribute("#sets-btn", "aria-expanded") == "true"
    page.keyboard.press("Escape")
    page.wait_for_timeout(150)
    assert page.locator("#sets-pop").is_hidden()
    assert page.get_attribute("#sets-btn", "aria-expanded") == "false"
    assert_clean(page, "dialogs")


def test_back_and_forward_between_routes(make_context, ai_server, book):
    pid = book["pid"]
    page = open_app(make_context(), ai_server)
    trail = [f"#/p/{pid}/main", f"#/p/{pid}/main/set/A", f"#/p/{pid}/main/op/A01", f"#/p/{pid}/main/book", "#/settings"]
    heads = []
    for r in trail:
        page.evaluate("h => { location.hash = h; }", r)
        page.wait_for_function("h => location.hash === h", arg=r)
        settle(page, 300)
        heads.append(page.inner_text("#main h1"))
    for i in range(len(trail) - 2, -1, -1):
        page.go_back()
        page.wait_for_function("h => location.hash === h", arg=trail[i], timeout=5000)
        page.wait_for_function("t => (document.querySelector('#main h1') || {}).textContent === t", arg=heads[i],
                               timeout=8000)
    for i in range(1, len(trail)):
        page.go_forward()
        page.wait_for_function("t => (document.querySelector('#main h1') || {}).textContent === t", arg=heads[i],
                               timeout=8000)
    assert page.evaluate("document.title").startswith(heads[-1])
    assert_clean(page, "history")


def test_copy_buttons_put_the_record_on_the_clipboard(make_context, ai_server, book):
    pid = book["pid"]
    rec = next(r for r in book["records"] if r["module_id"] == "A01")
    detail = ai_server.api("GET", f"/projects/{pid}/branches/main/records/{rec['record_id']}")
    latest = detail["versions"][-1]
    ctx = make_context(permissions=["clipboard-read", "clipboard-write"])
    page = open_app(ctx, ai_server, f"#/p/{pid}/main/rec/{rec['record_id']}")
    page.get_by_role("button", name="📋 Copy JSON").first.click()
    page.locator("#toast:not([hidden])").wait_for(timeout=3000)
    got = json.loads(page.evaluate("navigator.clipboard.readText()"))
    assert got == latest["data"]
    page.get_by_role("button", name="📋 Copy ID").first.click()
    page.wait_for_timeout(200)
    assert page.evaluate("navigator.clipboard.readText()").startswith(f"{rec['record_id']} v{latest['version']} ")
    assert_clean(page, "copy")


def test_paste_fills_the_form_without_saving(make_context, ai_server, book):
    pid = book["pid"]
    rec = next(r for r in book["records"] if r["module_id"] == "B01")
    detail = ai_server.api("GET", f"/projects/{pid}/branches/main/records/{rec['record_id']}")
    n_versions = len(detail["versions"])
    data = dict(detail["versions"][-1]["data"])
    data["premise"] = "PASTED premise about a lighthouse."
    data["not_a_field"] = 1
    ctx = make_context(permissions=["clipboard-read", "clipboard-write"])
    page = open_app(ctx, ai_server, f"#/p/{pid}/main/edit/{rec['record_id']}")
    page.evaluate("t => navigator.clipboard.writeText(t)", json.dumps(data))
    page.locator("#main button.paste-btn").first.click()
    # wait for the paste's own toast (not just any visible toast: an earlier one may still be showing)
    # and for the re-rendered form to hold the pasted value (route() re-renders asynchronously)
    page.wait_for_function("() => { const t = document.querySelector('#toast'); return t && !t.hidden && /Pasted|None of|Nothing/.test(t.textContent); }",
                           timeout=10000)
    toast = page.inner_text("#toast")
    assert "Pasted" in toast and "skipped 1" in toast, toast
    page.wait_for_function("""() => Array.from(document.querySelectorAll('#main form textarea, #main form input'))
                                     .some(e => e.value.includes('PASTED premise'))""", timeout=10000)
    settle(page)
    vals = page.evaluate("Array.from(document.querySelectorAll('#main form textarea, #main form input')).map(e => e.value)")
    assert any("PASTED premise" in v for v in vals), vals
    assert "not_a_field" in page.inner_text("#main")       # the skipped field is named
    detail2 = ai_server.api("GET", f"/projects/{pid}/branches/main/records/{rec['record_id']}")
    assert len(detail2["versions"]) == n_versions, "pasting saved something"
    assert_clean(page, "paste")


def test_paste_fallback_box_without_clipboard_permission(make_context, ai_server, book):
    pid = book["pid"]
    rec = next(r for r in book["records"] if r["module_id"] == "B01")
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/edit/{rec['record_id']}")
    page.evaluate("() => { Object.defineProperty(navigator, 'clipboard', { value: { readText: () => Promise.reject(new Error('denied')), writeText: () => Promise.reject(new Error('denied')) }, configurable: true }); }")
    before = page.evaluate("Array.from(document.querySelectorAll('#main form textarea')).map(e => e.value)")
    page.locator("#main button.paste-btn").first.click()
    box = page.locator("dialog.paste-dialog[open]")
    box.wait_for(timeout=3000)
    assert "did not allow" in box.inner_text()
    assert focused(page).startswith("#paste-dlg-text")
    box.get_by_role("button", name="Use this").click()            # empty: refused, marked invalid
    assert box.locator("textarea[aria-invalid=true]").count() == 1
    page.keyboard.press("Escape")                                 # cancel: nothing changes
    page.wait_for_timeout(200)
    assert not page.locator("dialog.paste-dialog").count()
    assert page.evaluate("Array.from(document.querySelectorAll('#main form textarea')).map(e => e.value)") == before
    page.locator("#main button.paste-btn").first.click()
    box = page.locator("dialog.paste-dialog[open]")
    box.locator("textarea").fill(json.dumps({"premise": "TYPED INTO THE BOX"}))
    box.get_by_role("button", name="Use this").click()
    page.locator("#toast:not([hidden])").wait_for(timeout=5000)
    settle(page)
    vals = page.evaluate("Array.from(document.querySelectorAll('#main form textarea')).map(e => e.value)")
    assert any("TYPED INTO THE BOX" in v for v in vals)
    # copying with a blocked clipboard falls back (execCommand) or explains how to copy by hand
    goto(page, f"#/p/{pid}/main/rec/{rec['record_id']}")
    page.evaluate("() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true }); }")
    page.get_by_role("button", name="📋 Copy ID").first.click()
    page.locator("#toast:not([hidden])").wait_for(timeout=3000)
    t = page.inner_text("#toast")
    assert "Copied" in t or "Ctrl+C" in t, t


def test_success_messages_do_not_claim_an_approval(make_context, ai_server, book):
    proj = ai_server.api("POST", "/projects", {"name": "SR Book", "profile": {"title": "SR Book", "idea": "A keeper vanishes.",
                                                                             "length": "short_story"},
                                               "release_profiles": ["MANUSCRIPT_PDF"]})
    pid = proj["project_id"]
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/book")
    page.locator("#step-premise button", has_text="Let my AI draft it").click()
    page.wait_for_function("() => { const m = document.querySelector('#main .book-msg'); return m && m.querySelector('.state.ok'); }",
                           timeout=20000)
    box = page.locator("#main .book-msg .state.ok h3").first
    spoken = box.text_content()            # includes the visually-hidden prefix a screen reader reads
    assert ai_server.api("GET", f"/projects/{pid}/branches/main/book")["steps"][2]["state"] != "done"
    assert not spoken.lstrip("✔").startswith("Approved:"), spoken


COVERED_JS = """() => { const out = [];
  for (const el of document.querySelectorAll('#main form button, #main form select, #main form input, #main form textarea')) {
    const r0 = el.getBoundingClientRect(); if (!r0.width || !r0.height || el.disabled || el.type === 'hidden' || el.type === 'file') continue;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (hit && !el.contains(hit) && !(el.labels && Array.from(el.labels).some(l => l.contains(hit))) && hit.closest('#ai-dock'))
      out.push((el.id || el.tagName) + ' ' + (el.textContent || '').trim().slice(0, 20));
  }
  return out; }"""


def test_fill_with_ai_panel_does_not_cover_the_form(make_context, ai_server, book):
    pid = book["pid"]
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/op/B11")
    page.locator("#main button.ai-btn", has_text="Fill with AI").first.click()
    page.locator("#ai-dock .ap").first.wait_for(timeout=5000)
    covered = page.evaluate(COVERED_JS)
    if covered:
        shot(page, "NEW-ui-8_ai_panel_covers_form")
    assert not covered, covered


def test_download_name_keeps_accented_title(make_context, ai_server, book, tmp_path):
    pid = book["pid"]
    prof = ai_server.api("GET", f"/projects/{pid}/profile")
    prof["title"] = "Café Ñandú"
    ai_server.api("PUT", f"/projects/{pid}/profile", prof)
    # A file is named after the title it carries (NEW-ui-2): make the format and the files again with the new title
    act = lambda a, body=None: ai_server.api("POST", f"/projects/{pid}/branches/main/book/{a}", body or {})  # noqa: E731
    out = act("setup_format")
    items = next(s for s in out["book"]["steps"] if s["id"] == "format")["approve"]
    assert act("approve", {"record_ids": [i["record_id"] for i in items], "author_confirms": True})["ok"]
    assert act("export")["ok"]
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/book")
    with page.expect_download(timeout=15000) as dl:
        page.locator("#step-export .downloads button", has_text="EPUB").click()
    name = dl.value.suggested_filename
    assert name == "Café Ñandú.epub", name
