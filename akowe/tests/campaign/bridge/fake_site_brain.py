"""The "brain" behind the fake chat sites of AutoInjector's BookForge end-to-end test
(desktop-app/test/bookforge-e2e.test.js).

The fake sites are web pages in a real Chromium; when one of them receives a BookForge prompt (the text the
AutoInjector adapter builds: system, "Project context package (JSON):" + one JSON line, JSON_SCHEMA ...
END_JSON_SCHEMA, instructions, optional validation errors) the node test hands the prompt to this process, which
answers it exactly like BookForge's own deterministic test AI (tests/autobook_fake.py BookFakeAI) would: same
answer kinds, same content, schema-valid.

Protocol: one JSON object per line on stdin {"id", "prompt"} -> one JSON line on stdout
{"id", "ok": true, "kind", "json": "<the answer object as one line>"} or {"id", "ok": false, "error"}.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
ROOT = HERE.parents[3]          # .../bookforge (repo folder with the bookforge package)
TESTS = HERE.parents[2]         # .../bookforge/tests
for p in (str(ROOT), str(TESTS)):
    if p not in sys.path:
        sys.path.insert(0, p)

from autobook_fake import BookFakeAI  # noqa: E402


def split_prompt(prompt: str) -> tuple[str, str, dict]:
    """(system, user, schema) from an AutoInjectorAdapter.build_prompt() text."""
    i = prompt.find("\nJSON_SCHEMA:\n")
    if i < 0:
        raise ValueError("no JSON_SCHEMA block")
    j = prompt.find("\nEND_JSON_SCHEMA", i)
    schema = json.loads(prompt[i + len("\nJSON_SCHEMA:\n"):j].strip())
    before = prompt[:i]
    lines = before.split("\n")
    k = next((n for n, line in enumerate(lines) if line.startswith("Project context package")), None)
    if k is None or k + 1 >= len(lines):
        k = max(n for n, line in enumerate(lines) if line.startswith("{")) - 1
    user = lines[k] + "\n" + lines[k + 1]
    system = "\n".join(lines[:k]).strip()
    return system, user, schema


def main() -> int:
    ai = BookFakeAI()
    slot = {"slot_id": "web"}
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        msg = json.loads(raw)
        try:
            system, user, schema = split_prompt(msg["prompt"])
            out, _usage = ai.submit(slot, system, user, schema)
            kind = ai.kinds[-1] if ai.kinds else "?"
            resp = {"id": msg.get("id"), "ok": True, "kind": kind, "json": json.dumps(out, ensure_ascii=False)}
        except Exception as exc:  # noqa: BLE001 - reported to the node side
            resp = {"id": msg.get("id"), "ok": False, "error": f"{type(exc).__name__}: {exc}"[:500]}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
