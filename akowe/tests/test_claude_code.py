"""🤖 Claude Code helpers, unit level: finding the CLI, the signed-in check, running jobs safely (stdin, temp folder,
no file or shell tools, timeout kills the tree, cancel, at most N at once, one retry), the error states in plain
words, the job schemas and cleaning rules, and no book text in the logs. A fake `claude` (tests/fake_claude) stands in
for the real CLI, which is not installed here."""
from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime
from pathlib import Path

import pytest

from akowe import claude_code as cc
from akowe import claude_code_jobs as jobs

from cc_fake import MemStore, calls, install, max_overlap, remove

BOOK = ("Mara climbed the lighthouse stairs in 1871. The lamp room was cold and Tom Reed's logbook lay open. "
        "She did not cry. Not then. Not ever. The SECRET-BOOK-LINE-42 stayed in the drawer.")


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:  # a zombie (killed, not yet reaped by its parent) counts as gone
        with open(f"/proc/{pid}/stat", encoding="utf-8") as f:
            return f.read().split(")")[-1].split()[0] != "Z"
    except OSError:
        return True


# ============================================================================================ finding the CLI
def test_candidates_order_posix_and_windows(tmp_path):
    env = {"PATH": "", "HOME": str(tmp_path), "NPM_CONFIG_PREFIX": "/opt/npm"}
    got = cc.candidates("", env=env, os_name="posix")
    assert [w for w, _p in got][:1] == ["native"] and got[0][1].endswith(os.path.join(".local", "bin", "claude"))
    assert ("npm", "/opt/npm/bin/claude") in got
    win = {"PATH": "", "USERPROFILE": r"C:\Users\Ada", "APPDATA": r"C:\Users\Ada\AppData\Roaming"}
    got = cc.candidates("", env=win, os_name="nt")
    paths = [p.replace("\\", "/") for _w, p in got]
    assert paths[0].endswith(".local/bin/claude.exe")
    assert any(p.endswith("AppData/Roaming/npm/claude.cmd") for p in paths)
    over = cc.candidates(r"D:\tools\claude.exe", env=dict(win, AKOWE_CLAUDE_PATH=r"E:\x\claude.exe"), os_name="nt")
    assert over[0] == ("override", r"E:\x\claude.exe") and over[1][1] == r"D:\tools\claude.exe"


def test_find_cli_on_path_native_npm_and_override(tmp_path):
    home = tmp_path / "home"
    (home / ".local" / "bin").mkdir(parents=True)
    native = home / ".local" / "bin" / "claude"
    native.write_text("x")
    env = {"PATH": str(tmp_path / "nothing"), "HOME": str(home)}
    assert cc.find_cli("", env=env, os_name="posix") == ("native", str(native))
    onpath = tmp_path / "bin"
    onpath.mkdir()
    exe = onpath / "claude"
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)
    assert cc.find_cli("", env=dict(env, PATH=str(onpath)), os_name="posix") == ("path", str(exe))
    npm = tmp_path / "npm"
    (npm / "bin").mkdir(parents=True)
    (npm / "bin" / "claude").write_text("x")
    assert cc.find_cli("", env={"PATH": "", "HOME": str(tmp_path / "empty"), "NPM_CONFIG_PREFIX": str(npm)},
                       os_name="posix")[0] == "npm"
    other = tmp_path / "mine.exe"
    other.write_text("x")
    assert cc.find_cli(str(other), env=env, os_name="posix") == ("override", str(other))
    # an override that does not exist is skipped: the others are still found
    assert cc.find_cli(str(tmp_path / "missing"), env=env, os_name="posix") == ("native", str(native))
    assert cc.find_cli("", env={"PATH": "", "HOME": str(tmp_path / "empty")}, os_name="posix") is None


def test_detect_ready_with_version_and_signed_in(tmp_path, monkeypatch):
    install(tmp_path, monkeypatch)
    st = cc.detect(MemStore(), force=True)
    assert st["state"] == "ready" and st["version"] == "2.1.300" and st["where"] == "path"
    assert st["words"] == "✔ Claude Code 2.1.300 found, signed in"
    assert cc.available(MemStore()) is not None


def test_detect_through_the_override_setting(tmp_path, monkeypatch):
    bindir = install(tmp_path, monkeypatch)
    remove(tmp_path, monkeypatch)
    store = MemStore()
    assert cc.detect(store, force=True)["state"] == "not_installed"
    cc.save_settings(store, {"path": str(bindir / "claude")})
    st = cc.detect(store, force=True)
    assert st["state"] == "ready" and st["where"] == "override"


@pytest.mark.parametrize("mode,state,words", [
    ("logged_out", "signed_out", "Signed out: open a terminal (PowerShell), run `claude` once and sign in"),
    ("limit", "limited", "usage limit until about 3:45 PM"),
    ("crash", "failing", "Found, but not working right now"),
])
def test_detect_signed_out_limited_failing(tmp_path, monkeypatch, mode, state, words):
    install(tmp_path, monkeypatch, FAKE_CLAUDE_MODE=mode)
    st = cc.detect(MemStore(), force=True)
    assert st["state"] == state, st
    assert words in st["words"]
    assert cc.available(MemStore()) is None


def test_not_installed_says_how_to_install(tmp_path, monkeypatch):
    remove(tmp_path, monkeypatch)
    st = cc.detect(MemStore(), force=True)
    assert st["state"] == "not_installed" and cc.INSTALL_URL in st["words"] and st["install_url"] == cc.INSTALL_URL
    assert cc.INSTALL_URL.startswith("https://code.claude.com/")


def test_switched_off_by_env_and_by_setting(tmp_path, monkeypatch):
    install(tmp_path, monkeypatch)
    store = MemStore()
    cc.save_settings(store, {"enabled": False})
    assert not cc.enabled(store) and cc.available(store) is None
    cc.save_settings(store, {"enabled": None})
    monkeypatch.setenv("AKOWE_CLAUDE_CODE", "off")
    assert cc.detect(store, force=True)["state"] == "off" and not cc.enabled(store)


def test_settings_are_checked(tmp_path):
    from akowe.errors import AkoweError
    store = MemStore()
    assert cc.settings(store)["helpers"] == 3 and cc.settings(store)["enabled"] is None
    for bad in ({"helpers": 0}, {"helpers": 6}, {"helpers": "3"}, {"enabled": "yes"}, {"jobs": {"poetry": True}},
                {"timeout_s": 5}, {"model": "x; rm -rf"}):
        with pytest.raises(AkoweError):
            cc.save_settings(store, bad)
    out = cc.save_settings(store, {"helpers": 5, "jobs": {"ai_tells": False}})
    assert out["helpers"] == 5 and out["jobs"]["ai_tells"] is False and out["jobs"]["research"] is True


# ============================================================================================ running a job
def test_job_prompt_goes_by_stdin_in_an_empty_temp_folder_without_file_tools(tmp_path, monkeypatch):
    log = tmp_path / "log"
    log.mkdir()
    install(tmp_path, monkeypatch, FAKE_CLAUDE_LOG=log)
    store = MemStore()
    big = BOOK * 400 + " Zelda wrote one unique closing line here."  # ~70 000 characters: beyond a Windows command line
    res = cc.run_job(store, kind="ai_tells", prompt=jobs.prompt("ai_tells", "task", jobs.TELLS_SCHEMA,
                                                                {"chapter_text": big}), schema=jobs.TELLS_SCHEMA)
    assert res["data"]["lines"] and res["attempts"] == 1 and res["cost_usd"] == 0.01
    (c,) = calls(log)
    assert c["stdin_chars"] > 60000 and c["argv_chars"] < 1000 and "SECRET-BOOK-LINE-42" not in " ".join(c["argv"])
    assert c["cwd_files"] == [] and Path(c["cwd"]).name.startswith("akowe-cc-") and not Path(c["cwd"]).exists()
    argv = c["argv"]
    deny = argv[argv.index("--disallowedTools") + 1].split(",")
    assert {"Bash", "Edit", "Write", "NotebookEdit", "WebSearch", "WebFetch", "mcp__*"} <= set(deny)
    assert "--allowedTools" not in argv
    assert argv[argv.index("--output-format") + 1] == "json" and "-p" in argv
    assert argv[argv.index("--permission-mode") + 1] == "dontAsk"


def test_web_jobs_may_only_search_and_fetch():
    cmd = cc.command("claude", tools="web", max_turns=30)
    deny = cmd[cmd.index("--disallowedTools") + 1].split(",")
    assert cmd[cmd.index("--allowedTools") + 1] == "WebSearch,WebFetch"
    assert "WebSearch" not in deny and {"Bash", "Edit", "Write"} <= set(deny)


def test_answer_in_a_code_fence_is_still_read(tmp_path, monkeypatch):
    install(tmp_path, monkeypatch, FAKE_CLAUDE_FENCE="1")
    res = cc.run_job(MemStore(), kind="ai_tells", prompt="JOB: ai_tells\nCONTEXT (JSON):\n{\"chapter_text\": "
                     "\"Mara climbed the lighthouse stairs slowly.\"}", schema=jobs.TELLS_SCHEMA)
    assert res["data"]["lines"][0]["quote"].startswith("Mara climbed")


def test_malformed_answer_is_retried_once_then_falls_back(tmp_path, monkeypatch):
    log = tmp_path / "log"
    log.mkdir()
    install(tmp_path, monkeypatch, FAKE_CLAUDE_MODE="malformed", FAKE_CLAUDE_LOG=log)
    with pytest.raises(cc.CCError) as e:
        cc.run_job(MemStore(), kind="voice", prompt="JOB: voice\n", schema=jobs.CHECK_SCHEMA)
    assert e.value.detail == "BAD_JSON" and len(calls(log)) == 2


def test_a_crash_is_retried_once_and_the_second_try_counts(tmp_path, monkeypatch):
    install(tmp_path, monkeypatch, FAKE_CLAUDE_MODE="flaky", FAKE_CLAUDE_STATE=tmp_path / "state")
    res = cc.run_job(MemStore(), kind="voice", prompt="JOB: voice\n", schema=jobs.CHECK_SCHEMA)
    assert res["attempts"] == 2 and res["data"]["problems"] == []


def test_an_answer_with_the_wrong_shape_is_refused(tmp_path, monkeypatch):
    install(tmp_path, monkeypatch)
    with pytest.raises(cc.CCError) as e:  # the fake answers a research job; the schema wants problems
        cc.run_job(MemStore(), kind="voice", prompt="JOB: research\nCONTEXT (JSON):\n{\"chapters\": []}",
                   schema=jobs.CHECK_SCHEMA, retry=False)
    assert e.value.detail == "SCHEMA"


def test_an_older_cli_without_a_flag_is_asked_with_the_basic_flags(tmp_path, monkeypatch):
    log = tmp_path / "log"
    log.mkdir()
    install(tmp_path, monkeypatch, FAKE_CLAUDE_MODE="unknown_flag", FAKE_CLAUDE_LOG=log)
    res = cc.run_job(MemStore(), kind="voice", prompt="JOB: voice\n", schema=jobs.CHECK_SCHEMA)
    rows = calls(log)
    assert res["data"] == {"problems": [], "summary": "voice checked"} and len(rows) == 2
    assert "--permission-mode" not in rows[-1]["argv"] and "--disallowedTools" in rows[-1]["argv"]


def test_timeout_kills_the_whole_process_tree(tmp_path, monkeypatch):
    pids = tmp_path / "pids"
    install(tmp_path, monkeypatch, FAKE_CLAUDE_MODE="slow_tree", FAKE_CLAUDE_PIDS=pids, FAKE_CLAUDE_SLOW=60)
    t0 = time.monotonic()
    with pytest.raises(cc.CCError) as e:
        cc.run_job(MemStore(), kind="voice", prompt="JOB: voice\n", timeout_s=2, retry=False)
    assert e.value.code == "TIMEOUT" and time.monotonic() - t0 < 20
    me, child = (int(x) for x in pids.read_text().split())
    deadline = time.time() + 5
    while time.time() < deadline and (_alive(me) or _alive(child)):
        time.sleep(0.1)
    assert not _alive(me) and not _alive(child)


def test_cancel_stops_the_job(tmp_path, monkeypatch):
    pids = tmp_path / "pids"
    install(tmp_path, monkeypatch, FAKE_CLAUDE_MODE="slow", FAKE_CLAUDE_PIDS=pids, FAKE_CLAUDE_SLOW=60)
    stop = threading.Event()
    threading.Timer(1.0, stop.set).start()
    with pytest.raises(cc.CCError) as e:
        cc.run_job(MemStore(), kind="voice", prompt="JOB: voice\n", cancel=stop.is_set, retry=False)
    assert e.value.detail == "CANCELLED"
    me = int(pids.read_text().split()[0])
    time.sleep(0.3)
    assert not _alive(me)


@pytest.mark.parametrize("n", [2, 3])
def test_at_most_n_helpers_run_at_once(tmp_path, monkeypatch, n):
    log = tmp_path / "log"
    log.mkdir()
    install(tmp_path, monkeypatch, FAKE_CLAUDE_DELAY=0.6, FAKE_CLAUDE_LOG=log)
    store = MemStore()
    cc.save_settings(store, {"helpers": n})
    errs = []

    def one():
        try:
            cc.run_job(store, kind="voice", prompt="JOB: voice\n", schema=jobs.CHECK_SCHEMA)
        except Exception as exc:  # noqa: BLE001
            errs.append(exc)
    ts = [threading.Thread(target=one) for _ in range(7)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(60)
    assert not errs
    assert max_overlap(calls(log)) == n  # the cap is honoured, and it is really used
    assert cc.GATE.peak == n


# ============================================================================================ errors in plain words
def test_every_error_maps_to_plain_words_and_app_codes():
    seen = {}
    for rc, res, err in [
        (1, {"is_error": True, "result": "Not logged in · Please run /login"}, ""),
        (1, {"is_error": True, "result": "Login expired · Please run /login"}, ""),
        (1, {"is_error": True, "result": "You've hit your weekly limit · resets Mon 12:00am"}, ""),
        (1, {"is_error": True, "result": "API Error", "api_error_status": 429}, ""),
        (3, None, "boom"),
        (0, None, ""),
        (1, None, "error: unknown option '--permission-mode'"),
        (1, {"is_error": True, "subtype": "error_during_execution"}, ""),
        (1, {"is_error": True, "subtype": "error_max_turns"}, ""),
    ]:
        e = cc.classify(rc, res, err)
        assert isinstance(e, cc.CCError)
        seen[e.detail] = e
        assert e.code in ("PERMISSION_DENIED", "RATE_LIMITED", "UPSTREAM_UNAVAILABLE")
        assert "_" not in str(e).split("(")[0] or "`" in str(e)  # words, not codes
    assert seen["NOT_LOGGED_IN"].state == "signed_out" and seen["USAGE_LIMIT"].usage_limited
    assert seen["CRASH"].transient and seen["NO_RESULT"].transient and not seen["UNKNOWN_FLAG"].transient
    assert seen["ERROR_DURING_EXECUTION"].transient and not seen["ERROR_MAX_TURNS"].transient
    assert cc.classify(0, {"is_error": False, "subtype": "success", "result": "{}"}, "") is None
    for state in ("ready", "not_installed", "signed_out", "limited", "failing", "off"):
        w = cc.status_words({"state": state, "version": "2.1.3", "code": "TIMEOUT"})
        assert w and "{" not in w


def test_usage_limit_reset_times():
    now = datetime(2026, 11, 8, 14, 0)  # a Sunday
    t = datetime.fromtimestamp(cc.parse_reset("You've hit your session limit · resets 3:45pm", now))
    assert (t.day, t.hour, t.minute) == (8, 15, 45)
    t = datetime.fromtimestamp(cc.parse_reset("resets 9am", now))
    assert (t.day, t.hour) == (9, 9)
    t = datetime.fromtimestamp(cc.parse_reset("You've hit your weekly limit · resets Mon 12:00am", now))
    assert (t.weekday(), t.hour, t.day) == (0, 0, 9)
    assert cc.parse_reset("no time here") is None
    assert "about 3:45 PM" in cc.limit_words(datetime(2026, 11, 8, 15, 45).timestamp())


def test_a_limit_or_sign_out_found_by_a_job_stops_later_jobs_at_once(tmp_path, monkeypatch):
    log = tmp_path / "log"
    log.mkdir()
    install(tmp_path, monkeypatch, FAKE_CLAUDE_MODE="limit", FAKE_CLAUDE_LOG=log)
    store = MemStore()
    with pytest.raises(cc.CCError) as e:
        cc.run_job(store, kind="voice", prompt="JOB: voice\n")
    assert e.value.state == "limited" and e.value.reset_at
    with pytest.raises(cc.CCError):
        cc.run_job(store, kind="voice", prompt="JOB: voice\n")
    assert len(calls(log)) == 1  # the second job never started a process
    assert cc.available(store) is None


# ============================================================================================ no book text in the logs
def test_logs_hold_codes_counts_and_timings_only(tmp_path, monkeypatch, caplog):
    install(tmp_path, monkeypatch)
    caplog.set_level(logging.DEBUG)
    store = MemStore()
    cc.run_job(store, kind="ai_tells", prompt=jobs.prompt("ai_tells", "t", jobs.TELLS_SCHEMA, {"chapter_text": BOOK}),
               schema=jobs.TELLS_SCHEMA)
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "malformed")
    with pytest.raises(cc.CCError):
        cc.run_job(store, kind="ai_tells", prompt="JOB: ai_tells\n" + BOOK, schema=jobs.TELLS_SCHEMA)
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "Claude Code job ai_tells" in text
    for secret in ("SECRET-BOOK-LINE-42", "lighthouse", "Mara"):
        assert secret not in text


# ============================================================================================ the jobs' rules
def test_research_notes_without_a_source_are_dropped_and_labels_are_plain():
    raw = {"notes": [
        {"chapter": 2, "topic": "Lenses", "note": "Fresnel lens, 1823.", "label": "established",
         "source_url": "https://example.org/a"},
        {"chapter": 2, "topic": "Ghost", "note": "Folk tale.", "label": "legend", "source_url": "not a url"},
        {"chapter": 2, "topic": "Lamp oil", "note": "Invented brand.", "label": "invented"},
        {"chapter": 9, "topic": "x", "note": "y", "label": "invented"}]}
    out = jobs.clean_research(raw, [2, 3])
    assert [n["topic"] for n in out[2]] == ["Lenses", "Lamp oil"] and out[3] == []
    assert out[2][0]["label_words"] == "established fact" and out[2][1]["label_words"] == "invented for the story"


def test_fact_claims_need_their_quote_and_a_source():
    raw = {"claims": [
        {"quote": "the lighthouse stairs in 1871", "claim": "date", "verdict": "wrong", "label": "established", "severity": "major",
         "source_url": "https://example.org/x", "original": "in 1871", "replacement": "in 1881"},
        {"quote": "never said", "claim": "x", "verdict": "correct", "label": "established",
         "source_url": "https://example.org/y"},
        {"quote": "The lamp room was cold", "claim": "lamp", "verdict": "wrong", "label": "established"}]}
    fc = jobs.clean_facts(raw, BOOK)
    assert len(fc["claims"]) == 2
    assert fc["claims"][0]["original"] == "in 1871" and fc["claims"][1]["verdict"] == "unverifiable"
    probs = jobs.fact_problems(fc, "ch1", 1)
    assert len(probs) == 1 and probs[0]["severity"] == "major" and "example.org/x" in probs[0]["problem"]
    assert probs[0]["replacement"] == "in 1881"


def test_ai_tell_rewrites_keep_names_numbers_and_locked_details():
    raw = {"lines": [
        {"quote": "She did not cry. Not then. Not ever.", "problem": "Not X. Not Y.", "rewrite": "She kept her eyes dry."},
        {"quote": "Mara climbed the lighthouse stairs in 1871.", "problem": "x", "rewrite": "She climbed in 1880."},
        {"quote": "Tom Reed's logbook lay open", "problem": "x", "rewrite": "the logbook lay open"},
        {"quote": "The lamp room was cold", "problem": "x", "rewrite": "The lamp room was warm"},
        {"quote": "not in the chapter", "problem": "x", "rewrite": "y"},
        {"quote": "The lamp room was cold and", "problem": "x", "rewrite": "same"}]}
    out = jobs.clean_tells(raw, BOOK, keep_exactly=["The lamp room: temperature: cold"])
    assert [o["quote"] for o in out] == ["She did not cry. Not then. Not ever."] and out[0]["id"] == "t1"


def test_check_problems_use_the_checks_format():
    raw = {"problems": [{"chapter": 4, "quote": "x", "problem": "Tom's knee is healed again", "severity": "major",
                         "original": "Tom ran", "replacement": "Tom limped"},
                        {"chapter": 9, "quote": "x", "problem": "not in this part"}]}
    out = jobs.clean_problems(raw, {4: "ch4"}, {"ch4": "Then Tom ran down."}, "continuity")
    assert out == [{"chapter_id": "ch4", "number": 4, "quote": "x", "problem": "Tom's knee is healed again",
                    "original": "Tom ran", "replacement": "Tom limped", "kind": "continuity", "severity": "major"}]


def test_the_ai_tell_checklist_adds_what_the_lists_miss():
    earlier = ["The rain had not stopped. He waited.", "The rain had not stopped for days. She waited."]
    chk = jobs.checklist(BOOK + " Her jaw tightened. It was enough.", earlier)
    assert {"jaw tightened", "it was enough"} <= set(chk["more_stock_phrases"])
    assert chk["book_echoes"]["openings"] == ["The rain had not stopped.", "The rain had not stopped for days."]
    assert chk["book_echoes"]["this_opening"].startswith("Mara climbed")
    assert "patterns" in chk and "must_fix" in chk


def test_make_a_book_option_is_checked(tmp_path):
    from akowe import claude_code_book as ccb
    from akowe.errors import AkoweError
    assert ccb.clean_run_option({}) == {} and ccb.clean_run_option({"claude_code": False}) == {"claude_code": False}
    with pytest.raises(AkoweError):
        ccb.clean_run_option({"claude_code": "yes"})
