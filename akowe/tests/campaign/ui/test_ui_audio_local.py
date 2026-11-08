"""🎧 5b Make audiobook and 🖥 5c Local AI backup in the browser.

The 📤 Export page of a made book shows the 🎧 Audiobook card: the voice engine is found (a fake voice shim), the
narrator voice is chosen and ▶ plays a sample, "Character voices for dialogue" opens the small table (Book Bible
hints, a voice each, ▶), 🎧 Make audiobook shows "chapter n of N" and ends with the files; with no voice engine the
card says so in plain words with the setup hint. Settings shows the 🖥 Local AI backup card (a fake Ollama): the
model and whether it is good enough, the switches, and "Let the local AI write" asks first and warns. No browser
problems, no unnamed controls, no sideways scrolling on a phone. Screenshots go to $BF_UI_SHOTS."""
from __future__ import annotations

import threading
import time
import types
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from .ui_helpers import assert_clean, bad_text, goto, overflow, settle, shot, unnamed_controls, watch

from audio_fakes import FakeOllama, FakeVoice, free_port
from test_failover_review import SlotFake, make_app, run_book
from test_server import TOKEN


@pytest.fixture(scope="module")
def ab(tmp_path_factory):
    from akowe import audiobook, forge, local_ai
    from akowe import providers as prov_mod
    from akowe.server import make_handler
    mp = pytest.MonkeyPatch()
    mp.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic, time=time.time))
    tmp = tmp_path_factory.mktemp("audio-ui")
    app = make_app(tmp, SlotFake())
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    forge.save_bridge_settings(app, {"url": f"http://127.0.0.1:{free_port()}"})
    voice = FakeVoice()
    voice.delay = 0.03  # slow enough to see the progress
    ollama = FakeOllama()
    mp.setenv("AKOWE_VOICE_URL", voice.url)
    mp.setenv("AKOWE_OLLAMA_URL", ollama.url)
    mp.setattr(audiobook, "OUT_ROOT", tmp / "books")
    mp.setattr(audiobook, "find_ffmpeg", lambda: None)
    local_ai.forget()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    yield SimpleNamespace(app=app, pid=run["project_id"], voice=voice, ollama=ollama, mp=mp,
                          url=f"http://127.0.0.1:{port}/#token={TOKEN}")
    httpd.shutdown()
    httpd.server_close()
    voice.close()
    ollama.close()
    local_ai.forget()
    mp.undo()


def open_at(make_context, ab, hash_, wait, **kw):
    page = watch(make_context(**kw).new_page())
    page.goto(ab.url)
    page.wait_for_selector("#main h1", timeout=15000)
    settle(page)
    goto(page, hash_)
    page.wait_for_selector(wait, timeout=20000)
    return page


def test_make_audiobook_card_voices_test_dialogue_table_and_progress(make_context, ab):
    page = open_at(make_context, ab, f"#/p/{ab.pid}/main/export", "[data-testid=audiobook-card] [data-testid=ab-engine]")
    card = page.locator("[data-testid=audiobook-card]")
    assert "3 voices installed" in card.locator("[data-testid=ab-engine]").inner_text()
    assert "WAV" in card.locator("[data-testid=ab-format]").inner_text()   # no ffmpeg on this PC
    assert card.locator("[data-testid=ab-narrator]").input_value() == "en_US-amy-medium"
    # ▶ a sample of the narrator voice
    n = len(ab.voice.requests)
    card.locator("[data-testid=ab-test-narrator]").click()
    page.wait_for_function("() => (document.querySelector('[data-testid=ab-test-status]') || {}).textContent.includes('Playing a sample')",
                           timeout=10000)
    assert ab.voice.requests[n]["text"].startswith("This is how the narrator")
    # another narrator, then the character voices
    card.locator("[data-testid=ab-narrator]").select_option("en_GB-alan-medium")
    page.wait_for_function("() => document.querySelector('[data-testid=ab-narrator]') && document.querySelector('[data-testid=ab-narrator]').value === 'en_GB-alan-medium'",
                           timeout=10000)
    card.locator("[data-testid=ab-dialogue]").check()
    page.wait_for_selector("[data-testid=ab-voices] [data-testid=ab-voice-row]", timeout=10000)
    rows = card.locator("[data-testid=ab-voice-row]")
    assert rows.count() >= 2 and "Mara Vell" in card.locator("[data-testid=ab-voices]").text_content()
    rows.first.locator("[data-testid=ab-voice-select]").select_option("en_US-ryan-medium")
    page.wait_for_function("() => document.querySelector('[data-testid=ab-voice-select]').value === 'en_US-ryan-medium'", timeout=10000)
    from akowe import audiobook
    t0 = time.time()
    while "en_US-ryan-medium" not in audiobook.settings(ab.app.store, ab.pid, "main")["character_voices"].values():
        assert time.time() - t0 < 10
        time.sleep(0.05)
    settle(page, 400)  # the card is drawn again with the saved choice
    s = audiobook.settings(ab.app.store, ab.pid, "main")
    assert s["narrator"] == "en_GB-alan-medium" and s["dialogue"] is True and "en_US-ryan-medium" in s["character_voices"].values()
    n = len(ab.voice.requests)
    page.locator("[data-testid=ab-voice-row]").first.locator("[data-testid=ab-test-voice]").click()
    page.wait_for_function("() => document.querySelector('[data-testid=ab-test-status]').textContent.includes('en_US-ryan-medium')", timeout=10000)
    assert ab.voice.requests[n]["text"].startswith("Hello. I am")
    assert not bad_text(page) and not unnamed_controls(page)
    shot(page, "audiobook-card")
    # 🎧 Make audiobook: chapter n of N, then the files
    page.click("[data-testid=ab-make]")
    page.wait_for_function("() => /chapter \\d of 3/.test((document.querySelector('[data-testid=ab-phase]') || {}).textContent || '')",
                           timeout=15000)
    assert page.locator("[data-testid=ab-cancel]").is_visible()
    page.wait_for_selector("[data-testid=ab-done]", timeout=60000)
    files = page.inner_text("[data-testid=ab-files]")
    assert "01 - " in files and "(whole book).wav" in files
    assert "3 of 3 chapters already made" in page.inner_text("[data-testid=ab-chapters]")
    page.locator("[data-testid=ab-retail] summary").click()
    retail = page.inner_text("[data-testid=ab-retail]")
    assert "information, not a guarantee" in retail and "ACX" in retail and "AI-made voices" in retail
    settle(page, 300)
    shot(page, "audiobook-done")
    assert_clean(page, "audiobook card")


def test_cancel_and_the_no_engine_message(make_context, ab):
    from akowe import audiobook
    ab.app.store.set_setting(f"audiobook:{ab.pid}:main", {"narrator": "en_US-ryan-medium"})  # every chapter again
    ab.voice.delay = 0.2
    try:
        page = open_at(make_context, ab, f"#/p/{ab.pid}/main/export", "[data-testid=ab-make]")
        page.click("[data-testid=ab-make]")
        page.locator("[data-testid=ab-cancel]").wait_for(timeout=15000)
        page.click("[data-testid=ab-cancel]")
        page.wait_for_selector("[data-testid=ab-progress] [data-testid=ab-problem]", timeout=30000)
        txt = page.inner_text("[data-testid=ab-progress]")
        assert "The audiobook was stopped" in txt and "finished chapters are kept" in txt
    finally:
        ab.voice.delay = 0.03
    ab.mp.setenv("AKOWE_VOICE_URL", f"http://127.0.0.1:{free_port()}")
    try:
        page = open_at(make_context, ab, f"#/p/{ab.pid}/main/export", "[data-testid=audiobook-card] [data-testid=ab-problem]")
        txt = page.inner_text("[data-testid=audiobook-card] [data-testid=ab-problem]")
        assert "No voice engine is ready on this PC" in txt and "Setup Wizard → Installs" in txt and "Voice models" in txt
        assert page.locator("[data-testid=ab-make]").count() == 0 and page.locator("[data-testid=ab-retry]").count() == 1
        assert not bad_text(page)
        shot(page, "audiobook-no-engine")
        assert_clean(page, "no engine")
    finally:
        ab.mp.setenv("AKOWE_VOICE_URL", ab.voice.url)
        audiobook._JOBS.clear()


def test_local_ai_backup_card(make_context, ab):
    from akowe import local_ai
    local_ai.forget()
    page = open_at(make_context, ab, "#/settings", "[data-testid=local-ai-card] [data-testid=la-status]")
    card = page.locator("[data-testid=local-ai-card]")
    assert "Ready: qwen2.5:7b (7.6B)" in card.locator("[data-testid=la-status]").inner_text()
    facts = card.locator("[data-testid=la-facts]").inner_text()
    assert "Ollama: found" in facts and "qwen2.5:7b" in facts and "Good enough for the checks: yes" in facts
    assert card.locator("[data-testid=la-enabled]").is_checked()          # automatic: on with a 7B model
    assert not card.locator("[data-testid=la-write]").is_checked()        # never writes by default
    assert "worse prose" in card.locator("[data-testid=la-write-warning]").inner_text()
    card.locator("[data-testid=la-fourth]").check()
    page.wait_for_function("() => document.querySelector('[data-testid=la-fourth]') && document.querySelector('[data-testid=la-fourth]').checked", timeout=10000)
    settle(page, 300)
    assert local_ai.settings(ab.app.store)["fourth_reviewer"] is True
    # letting it write asks first; Cancel keeps it off
    page.locator("[data-testid=la-write]").check()
    page.wait_for_selector("dialog.choice-dialog[open]", timeout=10000)
    assert "worse prose" in page.inner_text("dialog.choice-dialog[open]")
    shot(page, "local-ai-write-confirm")
    page.locator("dialog.choice-dialog[open] button", has_text="Yes, let it write").click()
    page.wait_for_function("() => document.querySelector('[data-testid=la-write]') && document.querySelector('[data-testid=la-write]').checked", timeout=10000)
    settle(page, 300)
    assert local_ai.settings(ab.app.store)["allow_write"] is True
    card.locator("[data-testid=la-write]").uncheck()
    settle(page, 500)
    assert local_ai.settings(ab.app.store)["allow_write"] is False
    page.click("[data-testid=la-check]")
    settle(page, 300)
    assert not bad_text(page) and not unnamed_controls(page)
    card.scroll_into_view_if_needed()
    shot(page, "local-ai-card")
    assert_clean(page, "local AI card")


def test_both_cards_fit_a_phone(make_context, ab):
    page = open_at(make_context, ab, f"#/p/{ab.pid}/main/export", "[data-testid=audiobook-card] [data-testid=ab-engine]",
                   width=390, height=844)
    settle(page, 400)
    assert overflow(page) <= 1
    shot(page, "audiobook-phone")
    goto(page, "#/settings")
    page.wait_for_selector("[data-testid=local-ai-card] [data-testid=la-status]", timeout=20000)
    settle(page, 400)
    assert overflow(page) <= 1
    assert_clean(page, "phone")
