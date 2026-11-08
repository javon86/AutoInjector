"""🤖 Test helpers: put the fake `claude` CLI (tests/fake_claude/fake_claude.py) on PATH, with its shims."""
from __future__ import annotations

import copy
import os
import stat
import sys
from pathlib import Path

from akowe import claude_code

FAKE = Path(__file__).resolve().parent / "fake_claude" / "fake_claude.py"


def install(tmp_path, monkeypatch, *, keep_path: bool = True, **env) -> Path:
    """A bin folder with `claude` (shebang shim) and `claude.cmd` (Windows shim) first on PATH; the helpers are
    switched back on for this test (the suite switches them off). Extra ``env``: FAKE_CLAUDE_* modes."""
    bindir = Path(tmp_path) / "fakebin"
    bindir.mkdir(parents=True, exist_ok=True)
    sh = bindir / "claude"
    sh.write_text(f"#!{sys.executable}\nimport runpy, sys\nsys.argv[0] = {str(FAKE)!r}\n"
                  f"runpy.run_path({str(FAKE)!r}, run_name='__main__')\n", encoding="utf-8")
    sh.chmod(sh.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    (bindir / "claude.cmd").write_text(f'@"{sys.executable}" "{FAKE}" %*\r\n', encoding="utf-8")
    path = str(bindir) + (os.pathsep + os.environ.get("PATH", "") if keep_path else "")
    monkeypatch.setenv("PATH", path)
    monkeypatch.delenv("AKOWE_CLAUDE_CODE", raising=False)
    monkeypatch.delenv("AKOWE_CLAUDE_PATH", raising=False)
    monkeypatch.setenv("HOME", str(Path(tmp_path) / "home"))  # no real ~/.local/bin/claude is ever found
    monkeypatch.setenv("USERPROFILE", str(Path(tmp_path) / "home"))
    for k, v in env.items():
        monkeypatch.setenv(k, str(v))
    claude_code.forget_status()
    claude_code.GATE.resize(3)
    claude_code.GATE.peak = 0
    return bindir


def remove(tmp_path, monkeypatch) -> None:
    """No Claude Code anywhere: an empty PATH folder and an empty home."""
    empty = Path(tmp_path) / "nobin"
    empty.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("PATH", str(empty) + os.pathsep + os.path.dirname(sys.executable))
    monkeypatch.delenv("AKOWE_CLAUDE_CODE", raising=False)
    monkeypatch.delenv("AKOWE_CLAUDE_PATH", raising=False)
    monkeypatch.setenv("HOME", str(Path(tmp_path) / "home"))
    monkeypatch.setenv("USERPROFILE", str(Path(tmp_path) / "home"))
    monkeypatch.delenv("NPM_CONFIG_PREFIX", raising=False)
    monkeypatch.delenv("npm_config_prefix", raising=False)
    claude_code.forget_status()


class MemStore:
    """Just the settings part of a store."""

    def __init__(self):
        self.d = {}

    def get_setting(self, k, default=None):
        return copy.deepcopy(self.d.get(k, default))

    def set_setting(self, k, v):
        self.d[k] = copy.deepcopy(v)


def calls(logdir) -> list[dict]:
    import json
    out = []
    for p in Path(logdir).glob("*.json"):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except ValueError:
            pass
    return sorted(out, key=lambda c: c["start"])


def max_overlap(rows) -> int:
    ev = sorted([(r["start"], 1) for r in rows] + [(r["end"], -1) for r in rows], key=lambda x: (x[0], x[1]))
    cur = best = 0
    for _t, d in ev:
        cur += d
        best = max(best, cur)
    return best
