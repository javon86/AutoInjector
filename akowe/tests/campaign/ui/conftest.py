"""Fixtures for the browser-level UI tests (implementation in ui_helpers.py)."""
from .ui_helpers import AVAILABLE, ai_server, bridge, browser, make_context, server  # noqa: F401

if not AVAILABLE:  # no Playwright / Chromium here: skip the browser tests instead of failing
    collect_ignore_glob = ["test_ui_*.py"]
