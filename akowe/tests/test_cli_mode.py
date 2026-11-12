"""⌨ Command-line mode (cli_mode.py): an AI slot runs Claude Code / Codex on this computer instead of its web window.

Fake `claude` (tests/fake_claude) and fake `codex` (tests/fake_codex) executables on PATH: slot routing, answers,
the verified Codex flags, time-outs, usage-limit / sign-out mapping, cancel, the picture path, the preset, the HTTP
routes and a whole ⚡ Make-a-book run with both slots on the command line."""
from __future__ import annotations

import json
import logging
import os
import struct
import threading
import time
import types
import zlib
from pathlib import Path

import pytest

from akowe import claude_code, cli_mode, providers as prov_mod
from akowe.errors import AkoweError
from akowe.server import App

import cc_fake
import cli_fake
from test_server import TOKEN

SCHEMA = {"type": "object", "properties": {"title": {"type": "string"}, "count": {"type": "integer"}},
          "required": ["title"]}
PIC_SCHEMA = {"type": "object", "properties": {"verdict": {"type": "string"}, "saw": {"type": "integer"}},
              "required": ["verdict", "saw"]}
SECRET_TASK = "Write the SECRET-PLOT-TWIST-123 scene"


@pytest.fixture(autouse=True)
def _fast(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))
    cli_fake.reset()
    yield
    cli_mode.cancel()
    cli_fake.reset()
    claude_code.forget_status()


def make_app(tmp_path):
    app = App(tmp_path / "data", token=TOKEN)
    app.engine.providers.secret_path = tmp_path / "secrets.json"
    return app


def ctx(pid="book-1"):
    return types.SimpleNamespace(project_id=pid, branch_id=None, request={"request_id": "req-1"}, op_id="B01")


def gen(prov, slot_id=None, images=None, schema=SCHEMA, task=SECRET_TASK):
    return prov.generate(ctx(), task=task, output_schema=schema, context={"x": 1}, capability="json",
                         protected_facts=[], slot_id=slot_id, images=images)


def calls(d):
    return cc_fake.calls(d)


def png(path: Path) -> Path:
    raw = b"\x00\xff\x00\x00"
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    return path


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:  # a zombie (killed, not yet reaped by its parent) is not alive
        with open(f"/proc/{pid}/stat") as f:
            return f.read().split()[2] != "Z"
    except OSError:
        return True


# ---------------------------------------------------------------------------------------------- settings / routing
def test_mode_defaults_to_web_and_the_preset_sets_two_cli_ais(tmp_path):
    app = make_app(tmp_path)
    prov = app.engine.providers
    assert all(s["mode"] == "web" for s in prov.slots())
    slots = cli_mode.apply_preset(prov, "two_cli")
    by = {s["slot_id"]: s for s in slots}
    assert (by["AI-1"]["site"], by["AI-1"]["mode"]) == ("claude", "cli")
    assert (by["AI-2"]["site"], by["AI-2"]["mode"]) == ("chatgpt", "cli")
    assert by["AI-3"]["adapter_id"] == "none"
    assert prov_mod.slot_name(by["AI-1"]) == "AI-1 · Claude (command line)"
    assert prov_mod.slot_name(by["AI-2"]) == "AI-2 · ChatGPT (command line)"
    # same family as the web window: a CLI Claude may not review a web Claude's draft
    assert prov_mod.slot_family(by["AI-1"]) == "claude"
    # no key needed, no per-use bill, the big context of a command-line tool
    assert by["AI-1"]["has_credentials"] and by["AI-1"]["input_cost_minor_per_mtok"] == 0
    assert by["AI-2"]["context_limit_tokens"] == cli_mode.CLI_CONTEXT_TOKENS["chatgpt"]
    assert isinstance(prov.adapter(by["AI-1"]), cli_mode.CliAdapter)
    assert isinstance(prov.adapter(by["AI-2"]), cli_mode.CliAdapter)
    # back to web windows
    slots = cli_mode.apply_preset(prov, "web")
    assert all(s["mode"] == "web" and s["adapter_id"] == "autoinjector" for s in slots)
    assert isinstance(prov.adapter(slots[0]), prov_mod.AutoInjectorAdapter)


def test_gemini_and_bad_modes_are_refused(tmp_path):
    prov = make_app(tmp_path).engine.providers
    with pytest.raises(AkoweError) as e:
        prov.configure_slot("AI-3", {"adapter_id": "autoinjector", "site": "gemini", "mode": "cli"})
    assert e.value.code == "INVALID_INPUT" and "Gemini" in str(e.value)
    with pytest.raises(AkoweError):
        prov.configure_slot("AI-1", {"adapter_id": "autoinjector", "site": "claude", "mode": "terminal"})
    with pytest.raises(AkoweError):
        cli_mode.apply_preset(prov, "nope")


# ---------------------------------------------------------------------------------------------- answers
def test_claude_slot_on_the_command_line_answers(tmp_path, monkeypatch):
    cli_fake.install(tmp_path, monkeypatch, FAKE_CLAUDE_LOG=str(tmp_path))
    prov = make_app(tmp_path).engine.providers
    cli_mode.apply_preset(prov, "two_cli")
    data, res = gen(prov, "AI-1")
    assert isinstance(data["title"], str) and data["title"]
    assert res["ai_slot"] == "AI-1" and res["model"] == "cli:claude"
    c = [x for x in calls(tmp_path) if x["job"] == "slot"][0]
    assert "-p" in c["argv"] and "--permission-mode" in c["argv"] and "--no-session-persistence" in c["argv"]
    deny = c["argv"][c["argv"].index("--disallowedTools") + 1]
    assert "Read" in deny and "Bash" in deny and "WebSearch" in deny and "--allowedTools" not in c["argv"]
    assert c["argv_chars"] < 2000 and c["stdin_chars"] > 100  # the prompt goes in on stdin only
    assert c["cwd_files"] == []  # a fresh, empty work folder
    ex = cli_mode.exchanges()
    assert ex[-1]["outcome"] == "ok" and ex[-1]["tool"] == "claude" and "SECRET-PLOT-TWIST" in ex[-1]["task"]


def test_codex_slot_uses_the_verified_flags_and_the_chatgpt_plan(tmp_path, monkeypatch):
    log_dir = tmp_path / "codex-log"
    log_dir.mkdir()
    cli_fake.install(tmp_path, monkeypatch, FAKE_CODEX_LOG=str(log_dir), OPENAI_API_KEY="sk-should-not-pass",
                     CODEX_API_KEY="ck-should-not-pass")
    prov = make_app(tmp_path).engine.providers
    cli_mode.apply_preset(prov, "two_cli")
    data, res = gen(prov, "AI-2")
    assert data["title"] and res["model"] == "cli:codex"
    c = calls(log_dir)[0]
    a = c["argv"]
    assert a[0] == "exec" and a[-1] == "-"
    for flag in ("--skip-git-repo-check", "--ephemeral", "-o", "-C"):
        assert flag in a
    assert a[a.index("--sandbox") + 1] == "read-only" and a[a.index("--color") + 1] == "never"
    assert c["stdin_chars"] > 100 and sum(len(x) for x in a) < 2000
    assert c["cwd_files"] == [] and c["env_keys"] == []  # empty folder; no API key: the ChatGPT plan is used


def test_old_codex_without_the_new_flags_is_asked_again_with_the_basic_ones(tmp_path, monkeypatch):
    log_dir = tmp_path / "codex-log"
    log_dir.mkdir()
    cli_fake.install(tmp_path, monkeypatch, FAKE_CODEX_MODE="old", FAKE_CODEX_LOG=str(log_dir))
    prov = make_app(tmp_path).engine.providers
    cli_mode.apply_preset(prov, "two_cli")
    data, _ = gen(prov, "AI-2")
    assert data["title"]
    assert "--ephemeral" not in calls(log_dir)[-1]["argv"]


def test_a_malformed_answer_is_reasked_then_given_to_another_ai(tmp_path, monkeypatch):
    log_dir = tmp_path / "codex-log"
    log_dir.mkdir()
    cli_fake.install(tmp_path, monkeypatch, FAKE_CODEX_MODE="malformed", FAKE_CODEX_LOG=str(log_dir))
    prov = make_app(tmp_path).engine.providers
    cli_mode.apply_preset(prov, "two_cli")
    with pytest.raises(AkoweError) as e:
        gen(prov, "AI-2")
    assert e.value.code == "INTERNAL_ERROR" and getattr(e.value, "try_other_ai", False)
    assert len(calls(log_dir)) == cli_mode.MAX_REASKS + 1  # one fresh process per ask
    # no slot pinned, Codex first (B01 is its role): Codex fails, the call moves to Claude on the command line
    prov.configure_slot("AI-2", {"roles": ["B"]})
    data, res = gen(prov)
    assert res["ai_slot"] == "AI-1" and data["title"]


# ---------------------------------------------------------------------------------------------- limits / sign-out
def test_codex_usage_limit_is_rate_limited_and_the_work_moves_to_claude(tmp_path, monkeypatch):
    cli_fake.install(tmp_path, monkeypatch, FAKE_CODEX_MODE="limit")
    prov = make_app(tmp_path).engine.providers
    cli_mode.apply_preset(prov, "two_cli")
    with pytest.raises(AkoweError) as e:
        gen(prov, "AI-2")
    err = e.value
    assert err.code == "RATE_LIMITED" and err.site_problem == "USAGE_LIMIT" and err.reset_at
    assert "usage limit" in str(err) and "ChatGPT" in str(err)
    st = prov.slot_status(next(s for s in prov.slots() if s["slot_id"] == "AI-2"))
    assert st["state"] == "needs_user" and st["problem"] == "USAGE_LIMIT" and not st["working"]
    # AI-2 is no longer eligible; unpinned work goes to Claude (command line)
    assert [s["slot_id"] for s in prov.eligible("book-1", "json", 10)] == ["AI-1"]
    _, res = gen(prov)
    assert res["ai_slot"] == "AI-1"


def test_both_at_their_limit_is_a_usage_limit_wait(tmp_path, monkeypatch):
    cli_fake.install(tmp_path, monkeypatch, FAKE_CODEX_MODE="limit", FAKE_CLAUDE_MODE="limit")
    prov = make_app(tmp_path).engine.providers
    cli_mode.apply_preset(prov, "two_cli")
    with pytest.raises(AkoweError) as e:
        gen(prov)
    assert e.value.code in ("RATE_LIMITED", "UPSTREAM_UNAVAILABLE")
    assert getattr(e.value, "usage_limited", False)


def test_signed_out_maps_to_capability_unavailable_with_plain_words(tmp_path, monkeypatch):
    cli_fake.install(tmp_path, monkeypatch, FAKE_CODEX_MODE="logged_out", FAKE_CLAUDE_MODE="logged_out")
    prov = make_app(tmp_path).engine.providers
    cli_mode.apply_preset(prov, "two_cli")
    for sid, tool in (("AI-2", "Codex"), ("AI-1", "Claude Code")):
        cli_mode.forget_status()
        claude_code.forget_status()
        with pytest.raises(AkoweError) as e:
            gen(prov, sid)
        assert e.value.code == "CAPABILITY_UNAVAILABLE" and e.value.site_problem == "SIGNED_OUT"
        assert f"Open {tool}" in str(e.value) and "sign in" in str(e.value)
    st = cli_mode.detect(prov.store, "codex", force=True)
    assert st["state"] == "signed_out" and "codex login" in st["words"]


def test_not_installed(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    cli_fake.reset()
    prov = make_app(tmp_path).engine.providers
    cli_mode.apply_preset(prov, "two_cli")
    with pytest.raises(AkoweError) as e:
        gen(prov, "AI-2")
    assert e.value.code == "CAPABILITY_UNAVAILABLE" and e.value.site_problem == "NOT_INSTALLED"
    st = cli_mode.detect(prov.store, "codex", force=True)
    assert st["state"] == "not_installed"


# ---------------------------------------------------------------------------------------------- timeout / cancel
def test_a_timeout_kills_the_process_and_says_so(tmp_path, monkeypatch):
    pids = tmp_path / "pids"
    cli_fake.install(tmp_path, monkeypatch, FAKE_CODEX_MODE="slow", FAKE_CODEX_PIDS=str(pids), FAKE_CODEX_SLOW=60)
    app = make_app(tmp_path)
    prov = app.engine.providers
    cli_mode.apply_preset(prov, "two_cli")
    app.store.set_setting("cli_mode", {"timeout_s": 2})
    t0 = time.monotonic()
    adapter = prov.adapter(next(s for s in prov.slots() if s["slot_id"] == "AI-2"))
    with pytest.raises(AkoweError) as e:
        adapter.submit({"slot_id": "AI-2"}, "sys", "Project context package (JSON):\n{}", SCHEMA)
    assert time.monotonic() - t0 < 20
    assert e.value.code == "TIMEOUT" and getattr(e.value, "late_collect_tried", False)
    assert not alive(int(pids.read_text().split()[0]))
    assert cli_mode.running() == 0


def test_cancel_stops_the_command_line_ai_at_once(tmp_path, monkeypatch):
    pids = tmp_path / "pids"
    cli_fake.install(tmp_path, monkeypatch, FAKE_CODEX_MODE="slow", FAKE_CODEX_PIDS=str(pids), FAKE_CODEX_SLOW=60)
    prov = make_app(tmp_path).engine.providers
    cli_mode.apply_preset(prov, "two_cli")
    out = {}

    def go():
        from akowe import ai_activity
        with ai_activity.doing("Writing", run_id="run-7", book_id="book-1"):
            try:
                gen(prov, "AI-2")
            except AkoweError as exc:
                out["err"] = exc
    t = threading.Thread(target=go)
    t0 = time.monotonic()
    t.start()
    while not pids.exists() and time.monotonic() - t0 < 20:
        time.sleep(0.05)
    assert cli_mode.running() == 1
    assert cli_mode.cancel(run_id="other-run") == 0
    assert cli_mode.cancel(run_id="run-7") == 1
    t.join(20)
    assert not t.is_alive() and time.monotonic() - t0 < 20
    assert out["err"].code == "CAPABILITY_UNAVAILABLE" and out["err"].site_problem == "CANCELLED"
    assert not alive(int(pids.read_text().split()[0]))


def test_at_most_n_processes_at_once(tmp_path, monkeypatch):
    log_dir = tmp_path / "codex-log"
    log_dir.mkdir()
    cli_fake.install(tmp_path, monkeypatch, FAKE_CODEX_LOG=str(log_dir))
    app = make_app(tmp_path)
    prov = app.engine.providers
    cli_mode.apply_preset(prov, "two_cli")
    cli_mode.save_settings(app.store, {"at_once": 1})
    prov.configure_slot("AI-2", {"max_concurrent": 3})
    adapter = prov.adapter(next(s for s in prov.slots() if s["slot_id"] == "AI-2"))
    user = "Project context package (JSON):\n" + json.dumps({"protected_facts": [], "context": {}})
    ts = [threading.Thread(target=adapter.submit, args=({"slot_id": "AI-2"}, "sys", user, SCHEMA)) for _ in range(3)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(60)
    assert cli_mode.GATES["codex"].peak == 1
    assert cc_fake.max_overlap(calls(log_dir)) == 1


# ---------------------------------------------------------------------------------------------- pictures
def test_pictures_go_to_the_command_line_tools(tmp_path, monkeypatch):
    log_dir = tmp_path / "codex-log"
    log_dir.mkdir()
    cli_fake.install(tmp_path, monkeypatch, FAKE_CODEX_LOG=str(log_dir), FAKE_CLAUDE_LOG=str(tmp_path))
    pic = png(tmp_path / "cover.png")
    prov = make_app(tmp_path).engine.providers
    cli_mode.apply_preset(prov, "two_cli")
    data, _ = gen(prov, "AI-2", images=[str(pic)], schema=PIC_SCHEMA, task="Judge the picture")
    assert data == {"verdict": "keep", "saw": 1}
    a = calls(log_dir)[-1]
    assert a["images"] == [str(Path(a["cwd"]) / "cover.png")] and a["images_exist"] == [True]
    data, _ = gen(prov, "AI-1", images=[str(pic)], schema=PIC_SCHEMA, task="Judge the picture")
    assert data["saw"] == 1
    c = [x for x in calls(tmp_path) if x["job"] == "slot"][-1]
    assert c["argv"][c["argv"].index("--allowedTools") + 1] == "Read" and c["cwd_files"] == ["cover.png"]
    assert "Read" not in c["argv"][c["argv"].index("--disallowedTools") + 1].split(",")


def test_pictures_need_a_command_line_ai_and_a_tool_that_refuses_them_moves_on(tmp_path, monkeypatch):
    cli_fake.install(tmp_path, monkeypatch, FAKE_CODEX_MODE="no_images")
    pic = png(tmp_path / "p.png")
    prov = make_app(tmp_path).engine.providers
    cli_mode.apply_preset(prov, "web")  # web windows only: no AI here can take a picture file
    with pytest.raises(AkoweError) as e:
        gen(prov, images=[str(pic)], schema=PIC_SCHEMA)
    assert e.value.code == "CAPABILITY_UNAVAILABLE" and "picture" in str(e.value)
    cli_mode.apply_preset(prov, "two_cli")
    prov.configure_slot("AI-2", {"roles": ["B"]})  # Codex first (B01 is its role); it refuses -i
    with pytest.raises(AkoweError) as e:
        gen(prov, "AI-2", images=[str(pic)], schema=PIC_SCHEMA)
    assert e.value.site_problem == "NO_PICTURES" and e.value.try_other_ai
    data, res = gen(prov, images=[str(pic)], schema=PIC_SCHEMA)
    assert res["ai_slot"] == "AI-1" and data["saw"] == 1
    assert any(x["outcome"] == "NO_PICTURES" for x in cli_mode.exchanges())


# ---------------------------------------------------------------------------------------------- detection / health
def test_detection_and_test_connection(tmp_path, monkeypatch):
    cli_fake.install(tmp_path, monkeypatch)
    prov = make_app(tmp_path).engine.providers
    cli_mode.apply_preset(prov, "two_cli")
    st = cli_mode.detect(prov.store, "codex", force=True)
    assert st["state"] == "ready" and st["version"] == "0.167.2"
    h = prov.health_check("AI-2")
    assert h["ok"] and h["mode"] == "cli" and h["tool"] == "codex"
    h = prov.health_check("AI-1")
    assert h["ok"] and h["tool"] == "claude"


def test_logs_hold_codes_only_never_prompts_or_answers(tmp_path, monkeypatch, caplog):
    cli_fake.install(tmp_path, monkeypatch)
    prov = make_app(tmp_path).engine.providers
    cli_mode.apply_preset(prov, "two_cli")
    with caplog.at_level(logging.DEBUG):
        gen(prov, "AI-2")
        gen(prov, "AI-1")
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "cli-mode tool=codex" in text and "cli-mode tool=claude" in text
    assert "SECRET-PLOT-TWIST" not in text and "Project context" not in text


# ---------------------------------------------------------------------------------------------- HTTP
def test_http_routes(tmp_path, monkeypatch):
    cli_fake.install(tmp_path, monkeypatch)
    app = make_app(tmp_path)
    code, out = app.route("POST", "/api/cli-mode/preset", {}, {"preset": "two_cli"}, "author", {})
    assert code == 200 and [s["mode"] for s in out["slots"]] == ["cli", "cli", "web"]
    assert out["slots"][2]["can_cli"] is False
    code, out = app.route("POST", "/api/cli-mode/check", {}, {}, "author", {})
    assert out["tools"]["codex"]["state"] == "ready" and out["tools"]["claude"]["state"] == "ready"
    assert "path" not in out["tools"]["codex"]
    code, out = app.route("PUT", "/api/cli-mode", {}, {"timeout_s": 300, "at_once": 3}, "author", {})
    assert out["settings"]["timeout_s"] == 300 and out["settings"]["at_once"] == 3
    with pytest.raises(AkoweError):
        app.route("PUT", "/api/cli-mode", {}, {"timeout_s": 5}, "author", {})
    gen(app.engine.providers, "AI-2")
    code, out = app.route("GET", "/api/cli-mode", {"after": ["0"]}, None, "author", {})
    assert len(out["exchanges"]) == 1 and out["exchanges"][0]["outcome"] == "ok"
    last = out["exchanges"][0]["id"]
    code, out = app.route("GET", "/api/cli-mode", {"after": [str(last)]}, None, "author", {})
    assert out["exchanges"] == []


def test_open_codex_window(tmp_path, monkeypatch):
    from akowe import claude_code_window as ccw
    cli_fake.install(tmp_path, monkeypatch)
    app = make_app(tmp_path)
    seen = {}
    monkeypatch.setenv("OPENAI_API_KEY", "sk-not-for-codex")
    monkeypatch.setattr(ccw, "commands", lambda kind, cli, **kw: ["terminal", cli, *kw.get("args", ())])
    out = cli_mode.open_codex_window(app.store, local=True,
                                     launcher=lambda cmd, cwd, env: seen.update(cmd=cmd, env=env))
    assert out["ok"] and seen["cmd"][1].endswith("codex") and seen["cmd"][-1] == "login"
    assert "OPENAI_API_KEY" not in seen["env"]
    with pytest.raises(ccw.WindowError) as e:
        cli_mode.open_codex_window(app.store, local=False)
    assert e.value.code == "LOCAL_ONLY"
    monkeypatch.undo()
    assert ccw.commands("claude", r"C:\codex.cmd", os_name="nt", args=("login",)) == \
        ["cmd.exe", "/k", r"C:\codex.cmd", "login"]


# ---------------------------------------------------------------------------------------------- ⚡ a whole book
def test_make_a_book_with_claude_and_chatgpt_on_the_command_line(tmp_path, monkeypatch):
    from autobook_fake import trust_one_ai
    from akowe.jobs import RetryPolicy
    cli_fake.install(tmp_path, monkeypatch)
    monkeypatch.setenv("AKOWE_PRERUN_CHECKIN", "0")
    app = make_app(tmp_path)
    fast = RetryPolicy([0.01, 0.02], 5)
    app.autobook.retry_policy = app.write_all.retry_policy = app.assist.retry_policy = fast
    cli_mode.apply_preset(app.engine.providers, "two_cli")
    r = app.autobook.start("author", {"author_confirms": True, "idea": "a lighthouse keeper's apprentice",
                                      "chapters": 2})
    app.autobook.wait_for(r["id"], 600)
    trust_one_ai(app, r["id"], 600)
    run = app.autobook.public(app.autobook.get(r["id"]))
    assert run["status"] == "done", (run["status"], run.get("phase"), run.get("error"))
    ex = cli_mode.exchanges()
    tools = {x["tool"] for x in ex}
    assert tools == {"claude", "codex"}, tools  # both command-line AIs did work
    assert all(x["outcome"] in ("ok", "SCHEMA") for x in ex)


def test_cancel_in_a_make_a_book_run_stops_the_command_line_ai(tmp_path, monkeypatch):
    from akowe.jobs import RetryPolicy
    cli_fake.install(tmp_path, monkeypatch, FAKE_CODEX_MODE="slow", FAKE_CLAUDE_MODE="slow", FAKE_CODEX_SLOW=120,
                     FAKE_CLAUDE_SLOW=120)
    monkeypatch.setenv("AKOWE_PRERUN_CHECKIN", "0")
    app = make_app(tmp_path)
    app.autobook.retry_policy = RetryPolicy([0.01, 0.02], 5)
    cli_mode.apply_preset(app.engine.providers, "two_cli")
    r = app.autobook.start("author", {"author_confirms": True, "idea": "a lighthouse", "chapters": 2})
    t0 = time.monotonic()
    while cli_mode.running() == 0 and time.monotonic() - t0 < 60:
        time.sleep(0.05)
    assert cli_mode.running() >= 1
    time.sleep(0.5)  # the process has started
    t1 = time.monotonic()
    app.autobook.cancel("author", r["id"])
    app.autobook.wait_for(r["id"], 60)
    run = app.autobook.public(app.autobook.get(r["id"]))
    assert run["status"] == "cancelled", (run["status"], run.get("phase"))
    assert time.monotonic() - t1 < 30  # not the 120 s the fake AI would have taken
    assert cli_mode.running() == 0
