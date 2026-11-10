"""🤖 ⌨ Open Claude Code in its own window: Settings › Claude Code helpers › "Open Claude Code".

The person presses the button and a command window opens on this computer with ``claude`` already typed and started,
so they can sign in (the first time) or use Claude Code themselves. When Claude Code is not installed, the button says
"Install Claude Code" instead and the window runs Anthropic's official installer, so everything they see happens in
plain view and they can close it at any time.

**Only this computer.** Akọwe can be reached from another device (a phone on the home network), but a window must
never be opened on the PC by someone else: a request that does not come from this computer is refused
(``LOCAL_ONLY``).

**Fixed commands only.** Nothing from the request reaches the command line: the program is the Claude Code Akọwe
already found (``claude_code.find_cli``) or the installer's fixed command. The window starts in the person's home
folder and without the API-billing keys (``claude_code.child_env``), so Claude Code signs in to the Claude plan, the
same as the helpers.

Windows: a new ``cmd`` console (``/k`` keeps it open after Claude Code ends); the installer runs in PowerShell.
macOS: Terminal (osascript). Linux: the first terminal found (x-terminal-emulator, gnome-terminal, konsole, xfce4-
terminal, xterm). Anything else: a plain message that says what to type.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path

from . import claude_code

log = logging.getLogger("akowe.claude_code_window")

# Anthropic's official one-line installers (https://code.claude.com/docs/en/setup).
INSTALL_WIN = "irm https://claude.ai/install.ps1 | iex"
INSTALL_UNIX = "curl -fsSL https://claude.ai/install.sh | bash"

CREATE_NEW_CONSOLE = 0x00000010
LINUX_TERMINALS = (("x-terminal-emulator", ["-e"]), ("gnome-terminal", ["--"]), ("konsole", ["-e"]),
                   ("xfce4-terminal", ["-x"]), ("xterm", ["-e"]))


class WindowError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _home() -> str:
    try:
        return str(Path.home())
    except Exception:  # noqa: BLE001
        return os.getcwd()


def _applescript_quote(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _sh_quote(s: str) -> str:
    return "'" + s.replace("'", "'\"'\"'") + "'"


def commands(kind: str, cli: str | None, os_name: str | None = None, platform: str | None = None,
             which=shutil.which) -> list[str]:
    """The fixed command that opens the window. ``kind``: "claude" (run ``cli``) or "install". Raises WindowError
    NO_TERMINAL when this computer has no terminal Akọwe knows how to open."""
    os_name = os_name or os.name
    platform = platform or sys.platform
    if os_name == "nt":
        if kind == "install":
            return ["powershell.exe", "-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                    "Write-Host 'Installing Claude Code (Anthropic''s installer). When it says it is done, close this "
                    "window and press Open Claude Code in Akowe.'; " + INSTALL_WIN]
        return ["cmd.exe", "/k", cli]
    line = INSTALL_UNIX if kind == "install" else _sh_quote(cli or "claude")
    if platform == "darwin":
        return ["osascript", "-e", f'tell application "Terminal" to do script {_applescript_quote(line)}',
                "-e", 'tell application "Terminal" to activate']
    for name, flag in LINUX_TERMINALS:
        exe = which(name)
        if exe:
            return [exe, *flag, "bash", "-lc", line + "; exec bash"]
    raise WindowError("NO_TERMINAL", "This computer has no terminal window Akọwe knows how to open. Open one yourself "
                                     "and type: " + ("claude" if kind != "install" else INSTALL_UNIX))


def _launch(cmd: list[str], cwd: str, env: dict, os_name: str | None = None):
    kw = {"cwd": cwd, "env": env, "stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL,
          "stderr": subprocess.DEVNULL, "close_fds": True}
    if (os_name or os.name) == "nt":
        kw["creationflags"] = CREATE_NEW_CONSOLE
    else:
        kw["start_new_session"] = True
    return subprocess.Popen(cmd, **kw)  # noqa: S603 - fixed commands only (see the module docstring)


def open_window(store, *, local: bool, install: bool = False, launcher=None, finder=None) -> dict:
    """Open the window. {ok, kind, message} or raises WindowError (LOCAL_ONLY, NOT_INSTALLED, NO_TERMINAL,
    OPEN_FAILED)."""
    if not local:
        raise WindowError("LOCAL_ONLY", "Claude Code can only be opened on the computer Akọwe runs on.")
    st = claude_code.settings(store)
    found = (finder or claude_code.find_cli)(st.get("path") or "")
    if install:
        kind, cli = "install", None
    elif found:
        kind, cli = "claude", found[1]
    else:
        raise WindowError("NOT_INSTALLED", "Claude Code is not installed yet. Press “Install Claude Code” first.")
    cmd = commands(kind, cli)
    try:
        (launcher or _launch)(cmd, _home(), claude_code.child_env())
    except WindowError:
        raise
    except Exception as exc:  # noqa: BLE001
        log.warning("cc-window open failed: %s", type(exc).__name__)
        raise WindowError("OPEN_FAILED", "The window could not be opened (" + type(exc).__name__ + "). Open a command "
                          "prompt yourself and type: " + ("claude" if kind == "claude" else INSTALL_WIN)) from exc
    log.info("cc-window opened kind=%s", kind)
    if kind == "install":
        msg = ("The installer is running in a new window. When it says it is done, close it and press "
               "“⌨ Open Claude Code” to sign in.")
    else:
        msg = ("Claude Code is open in a new window. The first time, follow its steps to sign in with your Claude "
               "account, then come back and press “↻ Check again”.")
    return {"ok": True, "kind": kind, "message": msg}
