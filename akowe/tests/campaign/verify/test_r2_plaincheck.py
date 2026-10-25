"""Round-2 review: problems.js plainCheck turns a check refusal into the author's words. For rules it does not know,
it drops the message and says "Edit it, or let the AI write it again" - wrong advice for INPUT_NOT_VALIDATED (an
input is not approved yet: editing this draft cannot help, the server's own refusal_advice says "approve that
first") and SOURCE_PIN (out of date), and it hides what is wrong ("is too long") unless 🔧 Details is on."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

WEB = Path(__file__).resolve().parents[3] / "akowe" / "web" / "problems.js"


def plain(s: str) -> str:
    if not shutil.which("node"):
        pytest.skip("node not installed")
    js = f"import {{ plainCheck }} from {json.dumps(WEB.as_uri())}; console.log(plainCheck({json.dumps(s)}).text);"
    out = subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    return out.stdout.strip()


def test_input_not_validated_does_not_say_edit_it():
    t = plain("INPUT_NOT_VALIDATED: required input outline is still DRAFT; approve it first")
    assert "Edit it" not in t and "approv" in t.lower(), t


def test_source_pin_does_not_say_edit_it():
    t = plain("SOURCE_PIN: source B11-0123abcd v2 unresolved")
    assert "Edit it" not in t, t


def test_unknown_rule_keeps_what_is_wrong():
    t = plain("SCHEMA: /chapters/2/summary is too long")
    assert "too long" in t, t


@pytest.mark.parametrize("rule", ["STALE", "INPUT_STALE", "STALE_PIN", "SOURCE_PIN"])
def test_out_of_date_rules_match_the_server_advice(rule):
    from akowe.book_path import refusal_advice
    t = plain(f"{rule}: input pins changed")
    assert "out of date" in t and "editing it cannot fix" in t and "Edit it so" not in t, t
    assert "editing it cannot fix" in refusal_advice([f"{'STALE' if rule != 'SOURCE_PIN' else rule}: x"], None)


@pytest.mark.parametrize("msg", ["{'a': [1, 2]} is not valid under any of the given schemas",
                                 "x" * 200, "B11-0123abcdef v2 unresolved"])
def test_technical_or_long_messages_stay_behind_details(msg):
    t = plain(f"SCHEMA: {msg}")
    assert t.startswith("Something here does not pass"), t
