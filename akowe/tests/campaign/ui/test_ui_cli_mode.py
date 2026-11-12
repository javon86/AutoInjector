"""⌨ Command-line mode in the browser: the Settings card (Claude Code and Codex status in plain words, the "Two AIs:
Claude + ChatGPT on command line, Gemini off" preset, back to web windows) and each slot's "Web window / Command line"
choice (saved with the slot; refused for Gemini)."""
from __future__ import annotations

import json

from .ui_helpers import assert_clean, goto, open_app


def test_cli_card_preset_and_slot_choice(make_context, ai_server):
    page = open_app(make_context(), ai_server)
    goto(page, "#/settings")
    card = page.locator("[data-testid=cli-card]")
    card.wait_for(timeout=15000)
    card.locator("[data-testid=cli-status-codex]").wait_for(timeout=15000)
    assert "Command-line mode (try it first)" in card.inner_text()
    assert "Codex" in card.locator("[data-testid=cli-status-codex]").inner_text()
    with page.expect_response(lambda r: r.url.endswith("/api/cli-mode/preset") and r.request.method == "POST",
                              timeout=15000) as resp:
        card.locator("[data-testid=cli-preset]").click()
    assert resp.value.status == 200 and json.loads(resp.value.request.post_data) == {"preset": "two_cli"}
    page.locator("[data-testid=cli-card] [data-testid=cli-slot-AI-2]").filter(has_text="Command line").wait_for(
        timeout=15000)
    card = page.locator("[data-testid=cli-card]")
    # the settings page was drawn again: each slot shows its choice
    mode2 = page.locator("[data-testid=slot-mode-AI-2]")
    mode2.wait_for(timeout=15000)
    assert mode2.input_value() == "cli"
    assert page.locator("[data-testid=slot-mode-AI-1]").input_value() == "cli"
    # AI-2 back to the web window from its own slot form
    form = page.locator("form", has=page.locator("[data-testid=slot-mode-AI-2]"))
    mode2.select_option("web")
    with page.expect_response(lambda r: r.url.endswith("/api/slots/AI-2") and r.request.method == "PUT",
                              timeout=15000) as resp:
        form.locator("button[type=submit]").click()
    sent = json.loads(resp.value.request.post_data)
    assert resp.value.status == 200 and sent["mode"] == "web" and sent["site"] == "chatgpt"
    # a Gemini slot cannot choose the command line
    form3 = page.locator("form", has=page.locator("[data-testid=slot-mode-AI-3]"))
    form3.locator("select").first.select_option("autoinjector")
    form3.locator("#slot-AI-3-site").select_option("gemini")
    assert form3.locator("[data-testid=slot-mode-AI-3] option[value=cli]").is_disabled()
    # all back to web windows
    goto(page, "#/settings")
    card = page.locator("[data-testid=cli-card]")
    card.locator("[data-testid=cli-preset-web]").wait_for(timeout=15000)
    with page.expect_response(lambda r: r.url.endswith("/api/cli-mode/preset"), timeout=15000) as resp:
        card.locator("[data-testid=cli-preset-web]").click()
    assert json.loads(resp.value.request.post_data) == {"preset": "web"}
    page.locator("[data-testid=slot-mode-AI-1]").wait_for(timeout=15000)
    page.wait_for_timeout(300)
    assert page.locator("[data-testid=slot-mode-AI-1]").input_value() == "web"
    assert_clean(page, "command-line mode settings")


def test_open_codex_button_asks_the_server(make_context, ai_server):
    page = open_app(make_context(), ai_server)
    page.route("**/api/cli-mode/window", lambda route: route.fulfill(
        status=200, content_type="application/json",
        body=json.dumps({"ok": True, "kind": "codex", "message": "Codex is open in a new window."})))
    goto(page, "#/settings")
    btn = page.locator("[data-testid=cli-open-codex]")
    btn.wait_for(timeout=15000)
    with page.expect_request(lambda r: r.url.endswith("/api/cli-mode/window") and r.method == "POST", timeout=15000):
        btn.click()
    page.locator("[data-testid=cli-msg]").filter(has_text="open in a new window").wait_for(timeout=5000)
    assert_clean(page, "open codex button")
