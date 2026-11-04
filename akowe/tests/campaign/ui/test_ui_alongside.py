"""✍ Write alongside me in the browser: on a chapter, ✍ Write alongside me opens the text; with nothing highlighted
🔁 Rewrite says in plain words to highlight a passage first; with a sentence highlighted and a note, the suggestion
shows the old text next to the new one (changes marked) and changes nothing; a suggestion that slips into the first
person gets a ⚠️ note; 🔁 Try again asks again; ✖ Discard throws it away; ✔ Use this saves the chapter as a new
version waiting for approval while the approved one stays in the book."""
from __future__ import annotations

from .test_ui_followthrough import autobook
from .ui_helpers import assert_clean, open_app, settle, shot, unnamed_controls


def select_sentence(page, word="Mara"):
    """Highlight the first sentence of the chapter text that contains ``word`` (as the mouse would)."""
    return page.evaluate("""w => { const t = document.querySelector('#sd-text'); const v = t.value;
        const i = v.indexOf(w); const j = v.indexOf('.', i) + 1; t.focus(); t.setSelectionRange(i, j);
        t.dispatchEvent(new Event('select')); return v.slice(i, j); }""", word)


def test_write_alongside_suggests_checks_and_saves_a_new_version(make_context, ai_server, bridge):
    pid = autobook(ai_server)
    book = ai_server.api("GET", f"/projects/{pid}/branches/main/book")
    ch = next(s for s in book["steps"] if s["id"] == "chapters")["chapters"][0]
    rid = ch["approved"]["record_id"]
    before = ai_server.api("GET", f"/projects/{pid}/branches/main/records/{rid}")["versions"][-1]
    page = open_app(make_context(), ai_server, f"#/p/{pid}/main/write/{rid}")
    page.click("[data-testid=wa-open]")
    page.wait_for_selector("#sd-text", timeout=10000)
    card = page.locator("[data-testid=alongside]")
    card.wait_for(timeout=5000)
    assert not unnamed_controls(page)
    # nothing highlighted: a plain message, no AI asked
    page.evaluate("() => { const t = document.querySelector('#sd-text'); t.focus(); t.setSelectionRange(5, 5); }")
    card.get_by_role("button", name="🔁 Rewrite").click()
    card.get_by_text("Highlight the passage first").wait_for(timeout=5000)
    # a sentence highlighted, with a note
    passage = select_sentence(page)
    page.fill("#wa-note", "more tense")
    card.get_by_role("button", name="🔁 Rewrite").click()
    sug = page.locator("[data-testid=wa-suggestion]")
    sug.wait_for(timeout=30000)
    assert page.inner_text("[data-testid=wa-before]").strip() == passage.strip()
    assert page.locator("[data-testid=wa-after] ins", has_text="Her heart hammered.").count() == 1
    assert "Nothing in your chapter has changed yet" in sug.inner_text()
    shot(page, "alongside-suggestion")
    assert ai_server.api("GET", f"/projects/{pid}/branches/main/records/{rid}")["versions"][-1]["version"] == \
        before["version"]
    page.click("[data-testid=wa-discard]")
    page.wait_for_function("() => !document.querySelector('[data-testid=wa-suggestion]')", timeout=5000)
    # a suggestion in the first person in a third-person book: a ⚠️ note from Akọwe's quick checks
    bridge.ai.alongside_script = [{"text": "I climb the steps and I hold my lantern high. I am cold and the door is "
                                           "open. I see the lens and I wait."}]
    select_sentence(page)
    page.fill("#wa-note", "")
    card.get_by_role("button", name="🎨 Describe more").click()
    page.locator("[data-testid=wa-notes]").wait_for(timeout=30000)
    notes = page.inner_text("[data-testid=wa-notes]")
    assert "first person" in notes and "third person" in notes, notes
    # 🔁 Try again: the same request, a new answer (the fake's own, without the slip)
    page.click("[data-testid=wa-again]")
    page.wait_for_function("() => /Salt stung her lips/.test((document.querySelector('[data-testid=wa-after]') || {}).innerText || '')",
                           timeout=30000)
    assert not page.locator("[data-testid=wa-notes]").count()
    # ✔ Use this: a new version, waiting for approval; the approved one stays
    page.click("[data-testid=wa-use]")
    page.wait_for_function("() => /New version, waiting for your approval/.test(document.querySelector('#main').innerText)",
                           timeout=15000)
    settle(page)
    det = ai_server.api("GET", f"/projects/{pid}/branches/main/records/{rid}")
    new = det["versions"][-1]
    assert new["version"] == before["version"] + 1 and new["lifecycle"] == "DRAFT"
    assert "Salt stung her lips" in new["data"]["text"] and passage in new["data"]["text"]
    assert "Salt stung her lips" in page.input_value("#sd-text")  # back in the editor, on the new version
    book = ai_server.api("GET", f"/projects/{pid}/branches/main/book")
    ch = next(s for s in book["steps"] if s["id"] == "chapters")["chapters"][0]
    assert ch["approved"]["version"] == before["version"]  # the approved text is still the book's
    assert_clean(page, "write alongside")


def test_write_alongside_fits_a_phone_screen(make_context, ai_server):
    pid = autobook(ai_server)
    book = ai_server.api("GET", f"/projects/{pid}/branches/main/book")
    rid = next(s for s in book["steps"] if s["id"] == "chapters")["chapters"][0]["approved"]["record_id"]
    page = open_app(make_context(width=390, height=844), ai_server, f"#/p/{pid}/main/write/{rid}/edit")
    page.wait_for_selector("[data-testid=alongside]", timeout=10000)
    select_sentence(page)
    page.locator("[data-testid=alongside]").get_by_role("button", name="✂ Tighten").click()
    page.locator("[data-testid=wa-suggestion]").wait_for(timeout=30000)
    assert page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") <= 1
    assert_clean(page, "write alongside (phone)")
