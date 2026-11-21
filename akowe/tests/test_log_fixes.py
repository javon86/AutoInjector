"""PR #153, from the PC log report:

* 9. Gemini answers failed the JSON schema once in 30 of 231 requests: the prompt now names every required top-level
  key (all AIs) and Gemini gets a short checklist; akowe.log says WHERE an answer failed (JSON pointers only);
* 12. 🧼 the clean-run score: how cleanly a Make-a-book run went (stops, fixes, repairs, waits), counted over the
  whole run (not just the journal's newest lines), in the journal, in akowe.log and in the book report.
"""
from __future__ import annotations

import logging

from akowe import clean_run
from akowe.providers import AutoInjectorAdapter

from autobook_fake import BookFakeAI
from test_autobook import make_app, run_book

SCHEMA = {"type": "object", "required": ["verdict", "reasons", "confidence"],
          "properties": {"verdict": {"enum": ["APPROVE", "REVISE"]}, "reasons": {"type": "array"},
                         "confidence": {"type": "number"}}}


def test_the_prompt_names_the_required_keys_and_gemini_gets_a_checklist():
    p = AutoInjectorAdapter.build_prompt("sys", "user", SCHEMA)
    assert "every one of these top-level keys: verdict, reasons, confidence." in p
    assert "Check before you answer" not in p
    g = AutoInjectorAdapter.build_prompt("sys", "user", SCHEMA, site="gemini")
    assert "Check before you answer" in g and "enum values spelled exactly" in g
    assert "top-level keys" not in AutoInjectorAdapter.build_prompt("s", "u", {"type": "object"})


def test_clean_run_score_counts_the_whole_run():
    run = {"id": "run-x", "tally": {"kind:problem": 1, "kind:fix": 3, "kind:repair": 2, "code:FIX_UNDONE": 1,
                                    "kind:wait": 4, "rewrite": 1, "kind:fix_failed": 0}}
    sc = clean_run.score(run)
    assert sc["counts"]["stops"] == 1 and sc["counts"]["fixes"] == 2 and sc["counts"]["rewrites"] == 1
    assert sc["clean"] is False and 0 <= sc["score"] < 10
    assert "1 stop for you" in sc["line"] and "2 repaired" in sc["line"] and "1 fix undone" in sc["line"]
    clean = clean_run.score({"id": "r", "tally": {"kind:fix": 1}})
    assert clean["clean"] and clean["score"] == 9.9 and "a clean run" in clean["line"]
    # an older run without a tally: its journal is counted
    old = clean_run.score({"id": "o", "events": [{"kind": "problem"}, {"kind": "fix", "message": "x"}]})
    assert old["counts"]["stops"] == 1 and old["counts"]["fixes"] == 1
    assert clean_run.score(None) is None
    line = clean_run.log_line(run)
    assert line.startswith("clean-run run=run-x score=") and "stops=1" in line


def test_a_finished_run_says_its_score_in_the_journal_and_the_log(tmp_path, caplog):
    fake = BookFakeAI(verdicts=["REVISE"])
    app = make_app(tmp_path, fake=fake)
    with caplog.at_level(logging.INFO, logger="akowe.autobook"):
        run = run_book(app)
    assert run["status"] == "done"
    full = app.autobook.get(run["id"])
    assert full["tally"]["kind:fix"] >= 1 and full["tally"]["kind:review"] >= 1
    ev = [e for e in full["events"] if e.get("code") == "CLEAN_RUN_SCORE"]
    assert ev and ev[-1]["message"].startswith("🧼 Clean-run score: ") and "1 AI fix" in ev[-1]["message"]
    assert any(r.getMessage().startswith(f"clean-run run={run['id']} score=") for r in caplog.records)


def test_the_book_report_shows_the_clean_run_score(tmp_path):
    from akowe import book_report  # noqa: PLC0415
    app = make_app(tmp_path, fake=BookFakeAI())
    run = run_book(app)
    assert run["status"] == "done"
    rep = app.reports.make("author", run["project_id"], "main", ai=False, run_id=run["id"])
    assert rep["clean_run"]["clean"] and rep["clean_run"]["counts"]["stops"] == 0
    md = book_report.render_markdown(rep)
    assert "🧼 Clean-run score: " in md and "a clean run" in md
