"""🧪 Test workflow runner: a separate test book, row by row, with and without an AI (fake adapter)."""
from __future__ import annotations

import json

from bookforge.selftest import plan_item
from bookforge.workflow_test import ROW_IDS, WorkflowTestRunner

from test_server import call, server  # noqa: F401


class SchemaFakeAI:
    """Answers each AI task by the shape of its output schema (premise, plot, outline, prose, events, review)."""

    def __init__(self):
        self.ops = []

    def submit(self, slot, system, user, schema):
        props = schema.get("properties") or {}
        usage = {"model": "fake-model", "input_tokens": 10, "output_tokens": 10}
        if "verdict" in props:
            self.ops.append("review")
            return {"verdict": "REVISE", "reasons": ["The opening could be stronger."], "suggested_changes": ["x"],
                    "confidence": 0.7}, usage
        if "premise" in props:
            self.ops.append("B01")
            return {"premise": "An apprentice keeper looks for her master in the fog.", "dramatic_question": "Will she?",
                    "concept_summary": "A short mystery."}, usage
        if "main_plot" in props:
            self.ops.append("B03")
            return {"main_plot": {"summary": "She follows clues to the lighthouse.", "facts": [], "links": []},
                    "objectives": [], "plot_obligations": []}, usage
        if "chapters" in props:
            self.ops.append("B11")
            return {"chapters": [plan_item("ch1", 0, "Mara reaches the lighthouse")], "unresolved_threads": []}, usage
        if "objective_assessments" in props:
            self.ops.append("C02")
            return {"text": "Mara climbed to the lamp room and found the keeper's log.",
                    "objective_assessments": [{"item_id": "ch1", "decision": "PASS", "message": "reached"}]}, usage
        if "events" in props:
            self.ops.append("events")
            return {"events": []}, usage
        raise AssertionError(f"unexpected schema {sorted(props)}")


def run(runner, body):
    assert runner.start(body) is not None
    runner.wait(120)
    return {r["id"]: r for r in runner.status()["rows"]}


def test_run_all_without_ai(engine, tmp_path):
    store = engine.store
    real = engine.bootstrap_project("author-1", "My real book")
    before = len(store.list_records(real, "main"))
    runner = WorkflowTestRunner(store, engine.providers, "author-1", reports_dir=tmp_path / "reports")
    rows = run(runner, {"rows": "all"})
    assert set(rows) == set(ROW_IDS)
    for rid in ("ai", "premise", "plot", "outline", "chapter", "review"):
        assert rows[rid]["status"] == "SKIPPED", (rid, rows[rid])
        assert "connect" in (rows[rid]["fix"] or "").lower() or "AI" in rows[rid]["detail"]
    for rid in ("approvals", "format", "assemble", "export", "check"):
        assert rows[rid]["status"] == "PASS", (rid, rows[rid])
        assert rows[rid]["elapsed_ms"] is not None and rows[rid]["last_run_at"]
    st = runner.status()
    pid = st["project"]["id"]
    assert st["project"]["name"].startswith("🧪 Workflow test ")
    assert json.loads(store.project(pid)["settings"])["workflow_test"] is True
    assert len(store.list_records(real, "main")) == before  # the real book was not touched
    md, js = runner.latest_paths()
    rep = json.loads(js.read_text())
    assert rep["counts"]["PASS"] == 5 and rep["counts"]["SKIPPED"] == 6 and md.read_text().startswith("# BookForge")
    assert "api_key" not in js.read_text() and "token" not in js.read_text().lower()
    # re-run one row in the same test book
    rows = run(runner, {"rows": ["check"]})
    assert rows["check"]["status"] == "PASS" and runner.status()["project"]["id"] == pid
    # a new Run all makes a fresh test book and archives the old one
    run(runner, {"rows": "all"})
    assert runner.status()["project"]["id"] != pid and store.project(pid)["archived"] == 1


def test_run_all_with_fake_ai(engine, tmp_path):
    fake = SchemaFakeAI()
    engine.providers.test_adapter = fake
    engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})
    runner = WorkflowTestRunner(engine.store, engine.providers, "author-1", reports_dir=tmp_path / "reports")
    rows = run(runner, {"rows": "all"})
    bad = {k: (v["status"], v["detail"]) for k, v in rows.items() if v["status"] != "PASS"}
    assert not bad, bad
    assert {"B01", "B03", "B11", "C02", "review"} <= set(fake.ops)
    assert "REVISE" in rows["review"]["detail"] and rows["premise"]["mode"] == "AI"
    assert rows["premise"]["excerpt"] and len(rows["premise"]["excerpt"]) <= 80
    rep = json.loads(runner.latest_paths()[1].read_text())
    assert rep["verdict"] == "PASS" and rep["ai_ready"] == ["AI-1"]


def test_unknown_rows_and_http(server, tmp_path):  # noqa: F811
    app, port = server
    status, body, _ = call(port, "POST", "/api/workflow-test/run", {"rows": ["nope"]})
    assert status == 400
    status, st, _ = call(port, "GET", "/api/workflow-test")
    assert status == 200 and [r["id"] for r in st["rows"]] == ROW_IDS and all(r["status"] == "not_run" for r in st["rows"])
    assert call(port, "GET", "/api/workflow-test/report")[0] == 404
    status, st, _ = call(port, "POST", "/api/workflow-test/run", {"rows": ["ai", "format"]})
    assert status == 202
    app.workflow.wait(60)
    status, st, _ = call(port, "GET", "/api/workflow-test")
    rows = {r["id"]: r for r in st["rows"]}
    assert rows["ai"]["status"] == "SKIPPED" and rows["format"]["status"] == "PASS"
    status, md, resp = call(port, "GET", "/api/workflow-test/report?format=md")
    assert status == 200 and md.startswith(b"# BookForge workflow test")
    assert call(port, "GET", "/api/workflow-test", token=None)[0] == 401
    # the test book is marked, so the project list can keep it apart from real books
    status, projects, _ = call(port, "GET", "/api/projects")
    assert any(p["test_book"] for p in projects)
