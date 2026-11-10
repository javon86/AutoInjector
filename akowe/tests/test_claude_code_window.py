"""🤖 ⌨ Settings › Claude Code helpers › "Open Claude Code" / "Install Claude Code" (claude_code_window.py)."""
from __future__ import annotations

import pytest

from akowe import claude_code
from akowe import claude_code_window as ccw
from akowe.server import ApiError, App

TOKEN = "t" * 32
_REAL_COMMANDS = ccw.commands


@pytest.fixture(autouse=True)
def _as_on_windows(monkeypatch):
    """open_window builds the command for this computer; the tests build the Windows one (the user's PC), so they
    pass on a test machine without a terminal too."""
    monkeypatch.setattr(ccw, "commands", lambda kind, cli: _REAL_COMMANDS(kind, cli, os_name="nt"))


class _Store:
    def __init__(self):
        self.s = {}

    def get_setting(self, k):
        return self.s.get(k)

    def set_setting(self, k, v):
        self.s[k] = v


def test_windows_runs_the_found_claude_in_a_new_cmd_that_stays_open():
    cmd = _REAL_COMMANDS("claude", r"C:\Users\me\.local\bin\claude.exe", os_name="nt")
    assert cmd == ["cmd.exe", "/k", r"C:\Users\me\.local\bin\claude.exe"]


def test_windows_install_runs_the_official_installer_in_powershell_that_stays_open():
    cmd = _REAL_COMMANDS("install", None, os_name="nt")
    assert cmd[0] == "powershell.exe" and "-NoExit" in cmd and cmd[-1].endswith(ccw.INSTALL_WIN)


def test_mac_uses_terminal_and_quotes_the_path():
    cmd = _REAL_COMMANDS("claude", '/Users/me/my "odd" dir/claude', os_name="posix", platform="darwin")
    assert cmd[0] == "osascript" and 'do script' in cmd[2] and '\\"odd\\"' in cmd[2]


def test_linux_uses_the_first_terminal_found_and_says_what_to_type_when_none():
    found = {"gnome-terminal": "/usr/bin/gnome-terminal"}
    cmd = _REAL_COMMANDS("claude", "/home/me/.local/bin/claude", os_name="posix", platform="linux", which=found.get)
    assert cmd[:2] == ["/usr/bin/gnome-terminal", "--"] and "'/home/me/.local/bin/claude'" in cmd[-1]
    with pytest.raises(ccw.WindowError) as e:
        _REAL_COMMANDS("claude", "/x/claude", os_name="posix", platform="linux", which=lambda _n: None)
    assert e.value.code == "NO_TERMINAL" and "claude" in e.value.message


def test_only_this_computer_may_open_a_window():
    launched = []
    with pytest.raises(ccw.WindowError) as e:
        ccw.open_window(_Store(), local=False, launcher=lambda *a: launched.append(a),
                        finder=lambda _p: ("path", "/x/claude"))
    assert e.value.code == "LOCAL_ONLY" and not launched


def test_not_installed_asks_to_install_first_and_install_always_works():
    launched = []
    with pytest.raises(ccw.WindowError) as e:
        ccw.open_window(_Store(), local=True, launcher=lambda *a: launched.append(a), finder=lambda _p: None)
    assert e.value.code == "NOT_INSTALLED" and not launched
    out = ccw.open_window(_Store(), local=True, install=True, launcher=lambda *a: launched.append(a),
                          finder=lambda _p: None)
    assert out["ok"] and out["kind"] == "install" and len(launched) == 1


def test_open_uses_the_found_claude_the_home_folder_and_no_api_billing_keys(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-pass")
    monkeypatch.delenv("AKOWE_CLAUDE_USE_API_KEY", raising=False)
    seen = {}

    def launcher(cmd, cwd, env):
        seen.update(cmd=cmd, cwd=cwd, env=env)

    store = _Store()
    out = ccw.open_window(store, local=True, launcher=launcher, finder=lambda p: ("path", "/opt/claude/claude"))
    assert out["kind"] == "claude" and "sign in" in out["message"]
    assert any("/opt/claude/claude" in part for part in seen["cmd"])
    assert "ANTHROPIC_API_KEY" not in seen["env"] and seen["cwd"]


def test_the_saved_path_setting_is_what_is_looked_for():
    store = _Store()
    store.set_setting(claude_code.SETTINGS_KEY, {"path": "/custom/claude"})
    asked = []
    ccw.open_window(store, local=True, launcher=lambda *a: None, finder=lambda p: asked.append(p) or ("override", p))
    assert asked == ["/custom/claude"]


def test_a_window_that_cannot_open_says_what_to_type():
    def boom(*_a):
        raise OSError("no")

    with pytest.raises(ccw.WindowError) as e:
        ccw.open_window(_Store(), local=True, launcher=boom, finder=lambda _p: ("path", "/x/claude"))
    assert e.value.code == "OPEN_FAILED" and "claude" in e.value.message


def test_the_route_refuses_another_device_and_opens_on_this_one(tmp_path, monkeypatch):
    app = App(tmp_path / "data", token=TOKEN)
    calls = []
    monkeypatch.setattr(ccw, "_launch", lambda cmd, cwd, env: calls.append(cmd))
    monkeypatch.setattr(claude_code, "find_cli", lambda p="", **_k: ("path", "/x/claude"))
    app.set_client("192.168.1.20")
    try:
        with pytest.raises(ApiError) as e:
            app.route("POST", "/api/settings/claude-code/window", {}, {}, "author", {})
        assert e.value.status == 403 and e.value.body["errors"][0]["code"] == "PERMISSION_DENIED"
    finally:
        app.set_client(None)
    assert not calls
    st, out = app.route("POST", "/api/settings/claude-code/window", {}, {}, "author", {})
    assert st == 200 and out["kind"] == "claude" and len(calls) == 1
    monkeypatch.setattr(claude_code, "find_cli", lambda p="", **_k: None)
    with pytest.raises(ApiError) as e:
        app.route("POST", "/api/settings/claude-code/window", {}, {}, "author", {})
    assert e.value.status == 409 and "Install" in e.value.body["errors"][0]["message"]
    st, out = app.route("POST", "/api/settings/claude-code/window", {}, {"install": True}, "author", {})
    assert st == 200 and out["kind"] == "install" and len(calls) == 2
