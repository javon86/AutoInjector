"""⌨ Test helpers: put the fake `codex` (tests/fake_codex/fake_codex.py) and the fake `claude` on PATH."""
from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

from akowe import cli_mode

import cc_fake

FAKE = Path(__file__).resolve().parent / "fake_codex" / "fake_codex.py"


def install(tmp_path, monkeypatch, *, claude: bool = True, codex: bool = True, **env) -> Path:
    """A bin folder with `codex` (and, with ``claude``, the fake `claude`) first on PATH. ``env``: FAKE_* modes."""
    bindir = cc_fake.install(tmp_path, monkeypatch) if claude else Path(tmp_path) / "fakebin"
    bindir.mkdir(parents=True, exist_ok=True)
    if not claude:
        monkeypatch.setenv("PATH", str(bindir) + os.pathsep + os.path.dirname(sys.executable))
        monkeypatch.setenv("HOME", str(Path(tmp_path) / "home"))
        monkeypatch.setenv("USERPROFILE", str(Path(tmp_path) / "home"))
    if codex:
        sh = bindir / "codex"
        sh.write_text(f"#!{sys.executable}\nimport runpy, sys\nsys.argv[0] = {str(FAKE)!r}\n"
                      f"runpy.run_path({str(FAKE)!r}, run_name='__main__')\n", encoding="utf-8")
        sh.chmod(sh.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        (bindir / "codex.cmd").write_text(f'@"{sys.executable}" "{FAKE}" %*\r\n', encoding="utf-8")
    monkeypatch.delenv("AKOWE_CODEX_PATH", raising=False)
    monkeypatch.delenv("NPM_CONFIG_PREFIX", raising=False)
    monkeypatch.delenv("npm_config_prefix", raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, str(v))
    reset()
    return bindir


def reset() -> None:
    cli_mode.forget_status()
    cli_mode.clear_exchanges()
    for g in cli_mode.GATES.values():
        g.resize(cli_mode.DEFAULTS["at_once"])
        g.peak = 0
