"""Cross-process integration: real BookForge (Python) -> real AutoInjector bridge (Node).

Spawns desktop-app/test/fixtures/fake-bridge-host.js, which runs the actual
bookforge-bridge.js HTTP server with three fake site panes (no browser, no logins),
and drives BookForge operations through engine.dispatch against it. Skipped when Node
or the desktop app is not available.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

import bookforge.providers as prov

REPO = Path(__file__).resolve().parents[2]
HOST = REPO / "desktop-app" / "test" / "fixtures" / "fake-bridge-host.js"
TOKEN = "cross-process-token-0123456789abcdef"

pytestmark = pytest.mark.skipif(shutil.which("node") is None or not HOST.exists(),
                                reason="needs node and desktop-app/test/fixtures/fake-bridge-host.js")


class Host:
    """A running fake-bridge-host child process."""

    def __init__(self, tmp_path: Path, mode: str = "valid", extra: list[str] | None = None):
        self.record = tmp_path / f"prompts-{mode}.jsonl"
        args = ["node", str(HOST), "--port", "0", "--token", TOKEN, "--mode", mode,
                "--delay-ms", "20", "--record-file", str(self.record)] + list(extra or [])
        self.proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        line = self.proc.stdout.readline().strip()
        if not line.startswith("READY "):
            self.close()
            raise RuntimeError(f"fake bridge host did not start: {line!r} {self.proc.stderr.read()}")
        self.port = int(line.split()[1])
        self.url = f"http://127.0.0.1:{self.port}"

    def prompts(self) -> list[dict]:
        if not self.record.exists():
            return []
        return [json.loads(x) for x in self.record.read_text().splitlines() if x.strip()]

    def close(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


@pytest.fixture
def host_factory(tmp_path):
    hosts = []

    def make(mode="valid", extra=None):
        hst = Host(tmp_path, mode, extra)
        hosts.append(hst)
        return hst

    yield make
    for hst in hosts:
        hst.close()


@pytest.fixture(autouse=True)
def fast_retries(monkeypatch):
    monkeypatch.setattr(prov.time, "sleep", lambda s: None)


def b01(h):
    return h.create("B01", {"idea": "a lighthouse keeper hears the sea", "goals": ["finish draft one"]})


def resource_of(h, ref):
    row = h.store.query_one("SELECT resource FROM provenance WHERE record_id=?", (ref["record_id"],))
    return json.loads(row["resource"])


def test_connect_all_three_and_health(h, host_factory):
    host = host_factory()
    slots = h.engine.providers.connect_autoinjector(TOKEN, host.url)
    assert [(s["slot_id"], s["site"]) for s in slots] == [("AI-1", "claude"), ("AI-2", "chatgpt"),
                                                            ("AI-3", "gemini")]
    health = h.engine.providers.health_check("AI-1")
    assert health["ok"] is True and health["site_ready"] is True and health["site_busy"] is False
    assert set(health["sites"]) == {"chatgpt", "claude", "gemini"}


def test_creative_operation_runs_through_the_real_bridge(h, host_factory):
    host = host_factory()
    h.engine.providers.connect_autoinjector(TOKEN, host.url)
    r = b01(h)
    assert r["status"] == "DRAFT", r["errors"]
    res = resource_of(h, r["output_refs"][0])
    assert res["ai_slot"] == "AI-1" and res["model"] == "web:claude"
    sent = host.prompts()
    assert len(sent) == 1 and sent[0]["site"] == "claude"
    assert "JSON_SCHEMA:" in sent[0]["prompt"] and "END_JSON_SCHEMA" in sent[0]["prompt"]
    assert sent[0]["request_id"].startswith("bf-")
    # The stored premise is real validated OUTPUT, and the record approves normally.
    assert h.approve(r["output_refs"][0])["status"] == "APPROVED"


def test_roles_send_planning_to_gemini(h, host_factory):
    host = host_factory()
    h.engine.providers.connect_autoinjector(TOKEN, host.url)
    h.engine.providers.configure_slot("AI-3", {"roles": ["B"]})
    r = b01(h)
    assert r["status"] == "DRAFT", r["errors"]
    assert resource_of(h, r["output_refs"][0])["model"] == "web:gemini"
    assert [p["site"] for p in host.prompts()] == ["gemini"]


def test_invalid_reply_is_re_asked_then_accepted(h, host_factory):
    host = host_factory("invalid-then-valid")
    h.engine.providers.connect_autoinjector(TOKEN, host.url)
    r = b01(h)
    assert r["status"] == "DRAFT", r["errors"]
    sent = host.prompts()
    assert len(sent) == 2 and sent[0]["request_id"] != sent[1]["request_id"]
    assert "invalid_sample" in sent[1]["prompt"] or "error" in sent[1]["prompt"].lower()


def test_timeout_asks_the_user_and_saves_nothing(h, host_factory):
    host = host_factory("timeout", ["--time-scale", "0.005"])
    h.engine.providers.connect_autoinjector(TOKEN, host.url)
    r = b01(h)
    assert r["output_refs"] == [] and r["errors"][0]["code"] == "TIMEOUT"
    assert any(u.startswith("user_decision:") for u in r["unresolved_requests"])
    assert h.store.query_one("SELECT COUNT(*) c FROM records")["c"] == 0


def test_busy_site_is_reported_after_retries(h, host_factory):
    host = host_factory("busy")
    h.engine.providers.connect_autoinjector(TOKEN, host.url)
    r = b01(h)
    assert r["output_refs"] == [] and r["errors"][0]["code"] == "RATE_LIMITED"
    assert host.prompts() == []


def test_wrong_token_is_capability_unavailable(h, host_factory):
    host = host_factory()
    h.engine.providers.connect_autoinjector("wrong-token-wrong-token-wrong", host.url)
    r = b01(h)
    assert r["errors"][0]["code"] == "CAPABILITY_UNAVAILABLE"
    assert host.prompts() == []
    assert h.engine.providers.health_check("AI-1")["ok"] is False
