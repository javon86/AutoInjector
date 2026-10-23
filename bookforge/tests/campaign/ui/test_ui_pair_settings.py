"""Connecting the AI from the UI: the #/pair page (bad code, good code, code removed from the address) and the
Settings "Connect AutoInjector" form (empty key, non-local bridge address, valid key -> slots ready, key never shown)."""
from __future__ import annotations

import re

import pytest

from .ui_helpers import assert_clean, goto, open_app, settle, shot


def slots(server):
    return {s["slot_id"]: s for s in server.api("GET", "/slots")}


def test_pair_page_bad_then_good_code(make_context, server, bridge):
    ctx = make_context()
    page = open_app(ctx, server)
    page.goto(server.base + f"#/pair?code=BAD-0000-0000&bridge={bridge.url}")
    # BF-07: nothing is sent until the author confirms (the fake bridge is not on the usual port: warned)
    page.get_by_role("button", name=re.compile(r"^Connect to (AutoInjector|port \d+ anyway)$")).wait_for(timeout=15000)
    assert "not AutoInjector's usual port" in page.inner_text("#main")
    assert all(s["adapter_id"] != "autoinjector" for s in slots(server).values())
    page.get_by_role("button", name=re.compile(r"^Connect to (AutoInjector|port \d+ anyway)$")).click()
    page.wait_for_selector("#main .state.failed", timeout=15000)
    assert "code=" not in page.url, "the one-time code stays in the address bar"
    txt = page.inner_text("#main")
    assert "not connected" in txt and "Press Connect again" in txt, txt
    assert "HTTP 401" not in txt or "code" in txt.lower()
    assert all(s["adapter_id"] != "autoinjector" for s in slots(server).values())
    page.bf_problems.clear()                 # the refused pairing is an expected 4xx
    page.goto(server.base + f"#/pair?code=GOOD-1234-5678&bridge={bridge.url}")
    page.get_by_role("button", name=re.compile(r"^Connect to (AutoInjector|port \d+ anyway)$")).click()
    page.wait_for_selector("#main .state.ok", timeout=15000)
    assert "code=" not in page.url
    assert "Connected to AutoInjector" in page.inner_text("#main")
    sl = slots(server)
    assert {sl[k]["adapter_id"] for k in ("AI-1", "AI-2", "AI-3")} == {"autoinjector"}
    assert {sl[k].get("bridge_url") for k in sl} == {bridge.url}
    # no book yet: the countdown goes to the wizard
    page.wait_for_function("() => location.hash === '#/start'", timeout=12000)
    assert "fake-token" not in page.content()
    assert_clean(page, "pair")


def test_settings_connect_form(make_context, server, bridge):
    page = open_app(make_context(), server, "#/settings")
    form = page.locator("form", has=page.locator("#ai-bridge-token"))
    # empty key: refused at the key field
    form.get_by_role("button", name="Connect AutoInjector (all three slots)").click()
    page.wait_for_timeout(200)
    assert page.get_attribute("#ai-bridge-token", "aria-invalid") == "true"
    assert page.evaluate("document.activeElement.id") == "ai-bridge-token"
    # a non-local bridge address is refused with a message at/near the address field
    page.fill("#ai-bridge-url", "http://example.com:17891")
    page.fill("#ai-bridge-token", "fake-token")
    form.get_by_role("button", name="Connect AutoInjector (all three slots)").click()
    page.wait_for_timeout(800)
    txt = form.inner_text()
    assert "127.0.0.1" in txt or page.get_attribute("#ai-bridge-url", "aria-invalid") == "true", txt
    assert page.get_attribute("#ai-bridge-token", "aria-invalid") != "true", "the key is blamed for the address"
    page.bf_problems.clear()
    # valid: saved, the key field is emptied and never shown again, the slots report ready after a reload
    page.fill("#ai-bridge-url", bridge.url)
    page.fill("#ai-bridge-token", "fake-token")
    form.get_by_role("button", name="Connect AutoInjector (all three slots)").click()
    page.locator("#toast:not([hidden])").wait_for(timeout=10000)
    settle(page, 500)
    page.reload()
    page.wait_for_selector("#ai-bridge-token", timeout=15000)
    settle(page, 800)
    assert page.input_value("#ai-bridge-token") == ""
    assert "fake-token" not in page.content()
    sl = slots(server)
    assert all(sl[k]["adapter_id"] == "autoinjector" for k in ("AI-1", "AI-2", "AI-3"))
    assert_clean(page, "settings connect")


def test_pair_link_needs_confirmation_and_a_local_bridge(make_context, server, bridge):
    """BF-07: a web page can open #/pair links; BookForge never pairs from the address alone."""
    page = open_app(make_context(), server)
    page.goto(server.base + "#/pair?code=GOOD-1234-5678&bridge=http://evil.example:17891")
    page.wait_for_selector("#main .state.failed", timeout=15000)
    assert "not from AutoInjector" in page.inner_text("#main")
    assert "code=" not in page.url
    page.goto(server.base + f"#/pair?code=GOOD-1234-5678&bridge={bridge.url}")
    page.get_by_role("button", name="Cancel").click()
    page.wait_for_selector("#main .state.empty", timeout=5000)
    assert "Nothing was changed" in page.inner_text("#main")
    assert all(s["adapter_id"] != "autoinjector" for s in slots(server).values())
    page.bf_problems.clear()
