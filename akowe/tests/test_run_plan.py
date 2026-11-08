"""⚡ Make a book — planning before the start: ⏱ 3d the estimate (time, answers per AI, usage limits), 📊 3e the usage
meter per AI, ⏰ 3e start later (schedule, restart, the 2-hour ask, cancel, keep-awake status) and 📋 6c the starter
sheet parser. Numbers only in the estimate and the meter; no book text in logs."""
from __future__ import annotations

import json
import logging
import shutil
import subprocess
import threading
import time
import types
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from akowe import ai_activity, run_forecast, run_schedule, starter_sheet, status_push, story_rules, usage_limits, \
    usage_meter
from akowe import providers as prov_mod
from akowe.errors import AkoweError
from akowe.server import make_handler

from test_failover_review import SlotFake, make_app, run_book
from test_server import TOKEN, call

DESKTOP = Path(__file__).resolve().parents[2] / "desktop-app"


@pytest.fixture(autouse=True)
def fresh_meter(monkeypatch):
    usage_meter.reset_for_tests()
    usage_limits.clear()
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))
    yield
    usage_meter.reset_for_tests()


@pytest.fixture
def app(tmp_path):
    a = make_app(tmp_path, SlotFake())
    yield a
    a.store.close()


def est(app, **body):
    return run_forecast.estimate(app, dict({"length": "novella", "chapters": 10}, **body))


def by_family(e):
    return {a["family"]: a for a in e["ais"]}


# ====================================================================== ⏱ 3d the estimate
def test_each_option_moves_the_estimate_the_right_way(app):
    base = est(app)
    assert base["is_estimate"] and base["basis"] == "first_guess" and base["time_words"].startswith("about ")
    assert {a["family"] for a in base["ais"]} == {"claude", "chatgpt", "gemini"} and not base["ais_assumed"]
    # how many AIs check for mistakes: one < two < all
    one, two = est(app, checkers="one"), est(app, checkers="two")
    assert one["calls"]["expected"] < two["calls"]["expected"] < base["calls"]["expected"]
    assert one["minutes"]["expected"] < base["minutes"]["expected"]
    # the writers' room, beta readers, the whole Book Bible: more answers
    assert est(app, writers_room=True)["calls"]["expected"] > base["calls"]["expected"]
    b1, b3 = est(app, beta_reader=True), est(app, beta_reader=True, beta_readers=3)
    assert base["calls"]["expected"] < b1["calls"]["expected"] < b3["calls"]["expected"]
    assert est(app, fill_bible=True)["calls"]["expected"] > base["calls"]["expected"]
    # PR #133's end-of-book pass: about 2 answers, on by default
    off = est(app, human_pass=False)
    assert base["calls"]["expected"] - off["calls"]["expected"] == 2
    assert any(r["step"] == "option:human_pass" and r["calls"] == 2 for r in base["steps"])
    # pictures: Stable Diffusion — time, no AI answers
    p_on, p_off = est(app, pictures=True), est(app, pictures=False)
    assert p_on["calls"]["expected"] == p_off["calls"]["expected"] and p_on["minutes"]["expected"] > p_off["minutes"]["expected"]
    # the Claude Code helpers: their own answers; Claude's pane answers fewer (it does not write here)
    cc = est(app, claude_code=True)
    assert cc["helpers_calls"] > 0 and est(app, claude_code=False)["helpers_calls"] == 0
    assert by_family(cc)["claude"]["calls"] <= by_family(base)["claude"]["calls"]
    assert "claude_code" in by_family(cc)
    # length: a novel takes far longer than a short story
    assert run_forecast.estimate(app, {"length": "novel"})["minutes"]["expected"] > \
        5 * run_forecast.estimate(app, {"length": "short_story"})["minutes"]["expected"]
    # the steps add up to the total; the range holds the expected value
    for e in (base, one, cc, b3):
        assert abs(sum(r["calls"] for r in e["steps"]) - e["calls"]["expected"]) <= len(e["steps"])
        assert e["calls"]["low"] <= e["calls"]["expected"] <= e["calls"]["high"]
        assert e["minutes"]["low"] <= e["minutes"]["expected"] <= e["minutes"]["high"]


def test_writer_gets_the_most_answers_and_a_picked_ai_writes(app):
    e = est(app)
    assert max(e["ais"], key=lambda a: a["calls"])["key"] == "AI-1"  # the first AI writes when none is picked
    e2 = est(app, slot_id="AI-3")
    assert max(e2["ais"], key=lambda a: a["calls"])["key"] == "AI-3"


def test_usage_limits_forecast_pause_and_chapter(app):
    novel = run_forecast.estimate(app, {"length": "novel"})
    claude = by_family(novel)["claude"]
    assert novel["will_hit_limit"] and claude["status"] == "limit" and claude["pauses"]
    assert any("Claude will probably" in x and "chapter" in x for x in novel["limits"])
    assert 1 <= claude["pauses"][0]["chapter"] <= novel["chapters"]
    short = run_forecast.estimate(app, {"length": "short_story"})
    assert not any(a["status"] == "limit" for a in short["ais"])
    # "wait for a second AI" + a picked writer: the pauses make the run as long as they are
    wait = run_forecast.estimate(app, {"length": "novel", "single_ai": "wait", "slot_id": "AI-1"})
    assert wait["wait_minutes"] > novel["wait_minutes"] and wait["minutes"]["expected"] > novel["minutes"]["expected"]
    assert any("pause around chapter" in x for x in wait["limits"])


def test_limits_learned_on_this_pc_and_recent_use_count(app):
    e0 = est(app, length="short_story", chapters=3)
    assert not by_family(e0)["chatgpt"]["pauses"]
    now = time.time()
    for i in range(6):  # ChatGPT stopped after 6 answers here before: that is its limit now
        usage_meter.note_answer("AI-2", "AI-2 · ChatGPT", now=now - 3000 + i)
    usage_meter.note_limit("AI-2", "AI-2 · ChatGPT", now=now - 2900)
    assert usage_meter.learned("chatgpt") == 6
    e1 = est(app, length="short_story", chapters=3)
    gpt = by_family(e1)["chatgpt"]
    assert gpt["typical"] == 6 and gpt["typical_learned"] and gpt["used_now"] == 6 and gpt["status"] == "limit"


def _measured_job(app, per_call_s=12.0, checkers="one", chapters=3, calls=40):
    steps = [{"id": "chapters", "items": [{"id": str(i)} for i in range(chapters)]}]
    job = {"id": f"run-m{per_call_s}{checkers}", "kind": "autobook", "status": "done", "principal": "author",
           "project_id": None, "branch_id": "main", "started_at": "2026-11-01T10:00:00Z",
           "finished_at": "2026-11-01T10:10:00Z", "settings": {"checkers": checkers, "length": "short_story"},
           "steps": steps, "timing": {"calls": calls, "call_s": calls * per_call_s,
                                      "by_ai": {"AI-1": {"calls": calls * 3 // 4, "s": calls * 3 // 4 * per_call_s,
                                                         "failed": 0},
                                                "AI-2": {"calls": calls // 4, "s": calls // 4 * per_call_s,
                                                         "failed": 0}},
                                      "by_step": {"chapters": {"calls": calls - 20, "s": 1.0},
                                                  "outline": {"calls": 20, "s": 1.0}}}}
    app.jobstore.save(job)
    return job


def test_calibrated_from_this_pcs_runs(app):
    first = est(app, length="short_story", chapters=3)
    _measured_job(app, per_call_s=12.0, checkers="one")
    e = est(app, length="short_story", chapters=3, checkers="one")
    assert e["basis"] == "measured" and e["runs_measured"] == 1 and e["per_call_s"] == 12.0
    work, work0 = e["minutes"]["expected"] - e["wait_minutes"], first["minutes"]["expected"] - first["wait_minutes"]
    assert work < work0  # 12 s per answer instead of the 45 s guess
    # the per-AI share of the measured run is used (AI-1 gave 3/4 of the answers)
    a = {x["key"]: x for x in e["ais"]}
    assert a["AI-1"]["calls"] > 2 * a["AI-2"]["calls"] and a["AI-1"]["per_answer_s"] == 12.0
    # the measured run checked with one AI: asking for all adds the difference, the same setting adds nothing
    same = [r for r in e["steps"] if r["step"] == "option:checkers"]
    assert not same or same[0]["calls"] == 0
    more = est(app, length="short_story", chapters=3, checkers="all")
    assert more["calls"]["expected"] > e["calls"]["expected"]


def test_duration_words():
    assert run_forecast.duration_words(40, 80) == "about 40–80 minutes"
    assert run_forecast.duration_words(360, 480) == "about 6–8 hours"
    assert run_forecast.duration_words(3000, 4500) == "about 2–3 days"


# ====================================================================== 📊 3e the usage meter
def _limit_error(reset_at=None):
    e = AkoweError("UPSTREAM_UNAVAILABLE", "", "Claude: usage limit")
    e.site_problem, e.reset_at = "USAGE_LIMIT", reset_at
    return e


def test_meter_counts_answers_limit_hits_and_colours():
    now = time.time()
    for i in range(5):
        usage_meter.note_answer("AI-1", "AI-1 · Claude", now=now - 600 + i)
    r = usage_meter.row("AI-1", "AI-1 · Claude", now=now)
    assert r["today"] == 5 and r["in_window"] == 5 and r["colour"] == "green" and r["family"] == "claude"
    assert r["line"].startswith("used today: 5 answers") and r["typical"] == usage_meter.ASSUMED["claude"][1]
    usage_meter.note_answer("AI-1", "AI-1 · Claude", _limit_error(reset_at=now + 3 * 3600), now=now)
    r = usage_meter.row("AI-1", "AI-1 · Claude", now=now + 60)
    assert r["colour"] == "red" and r["limited"] and r["reset_known"] and "last limit hit at" in r["line"]
    assert "resets ~" in r["line"] and "(a guess)" not in r["line"]
    # the same limit seen again is the same hit
    usage_meter.note_limit("AI-1", "AI-1 · Claude", now=now + 120)
    assert len(usage_meter._STATE["ais"]["AI-1"]["hits"]) == 1
    # it answers again: no longer at its limit, but it hit one today -> amber
    usage_meter.note_answer("AI-1", "AI-1 · Claude", now=now + 4 * 3600)
    r = usage_meter.row("AI-1", "AI-1 · Claude", now=now + 4 * 3600 + 10)
    assert r["colour"] == "amber" and not r["limited"]
    # not connected
    assert usage_meter.row("AI-3", "AI-3 · Gemini", connected=False, now=now)["colour"] == "grey"
    # an API AI has no message limit Akọwe knows of
    assert usage_meter.row("AI-2", "AI-2 · Claude (API)", now=now)["typical"] is None


def test_meter_without_a_reset_time_guesses_one_and_sees_the_site_state():
    now = time.time()
    r = usage_meter.row("AI-2", "AI-2 · ChatGPT", site={"problem": "USAGE_LIMIT", "reset_at": None}, now=now)
    assert r["colour"] == "red" and r["reset_epoch"] and "(a guess)" in r["line"]


def test_meter_listens_to_the_ai_choke_point_and_the_all_limited_note():
    reg = ai_activity.Registry()
    reg.call_started("AI-3", "AI-3 · Gemini")
    reg.call_ended(None)
    reg.call_started("AI-3", "AI-3 · Gemini")
    reg.call_ended(_limit_error())
    a = usage_meter._STATE["ais"]["AI-3"]
    assert len(a["answers"]) == 1 and len(a["hits"]) == 1
    usage_limits.note(["AI-1 · Claude", "AI-2 · ChatGPT"], time.time() + 3600)
    assert usage_meter._STATE["ais"]["AI-1"]["hits"] and usage_meter._STATE["ais"]["AI-2"]["hits"]


def test_meter_is_saved_and_survives_a_restart(tmp_path, caplog):
    a1 = make_app(tmp_path, SlotFake())
    usage_meter.note_answer("AI-1", "AI-1 · Claude")
    usage_meter.note_limit("AI-2", "AI-2 · ChatGPT", time.time() + 1800)
    assert usage_meter.save(force=True)
    a1.store.close()
    usage_meter.reset_for_tests()
    a2 = make_app(tmp_path, SlotFake())  # a new process: loads what was saved
    m = usage_meter.meter(a2)
    rows = {r["key"]: r for r in m["ais"]}
    assert rows["AI-1"]["today"] == 1 and rows["AI-2"]["colour"] == "red"
    assert "do not publish exact limits" in m["about"]
    a2.store.close()


def test_a_book_run_fills_the_meter(app):
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done"
    m = usage_meter.meter(app)
    total = sum(r["today"] for r in m["ais"])
    assert total >= run["costs"]["calls"] * 0.8 and not any(r["colour"] == "red" for r in m["ais"])


# ====================================================================== ⏰ 3e start later
class Clock:
    def __init__(self):
        self.t = time.time()

    def __call__(self):
        return self.t


def _sched(app, clock):
    s = app.scheduler
    s.clock = clock
    return s


BODY = {"author_confirms": True, "length": "short_story", "genre": "Cozy mystery"}


def test_schedule_checks_like_start_and_only_one_at_a_time(app):
    clock = Clock()
    s = _sched(app, clock)
    with pytest.raises(AkoweError) as ei:
        s.create("author", {"at": clock.t - 60, "body": BODY})
    assert ei.value.errors[0]["path"] == "/at" and "passed" in ei.value.errors[0]["message"]
    with pytest.raises(AkoweError) as ei:
        s.create("author", {"at": clock.t + 8 * 86400, "body": BODY})
    assert "7 days" in ei.value.errors[0]["message"]
    with pytest.raises(AkoweError) as ei:
        s.create("author", {"at": clock.t + 3600, "body": {"length": "short_story"}})
    assert ei.value.code == "APPROVAL_REQUIRED"
    with pytest.raises(AkoweError) as ei:  # the same checks as Start: a wrong setting is said now, not at 11 pm
        s.create("author", {"at": clock.t + 3600, "body": dict(BODY, checkers="lots")})
    assert ei.value.errors[0]["path"] == "/checkers"
    with pytest.raises(AkoweError) as ei:
        s.create("author", {"at": "eleven tonight", "body": BODY})
    assert ei.value.errors[0]["path"] == "/at"
    out = s.create("author", {"at": clock.t + 3600, "body": BODY})
    assert out["state"] == "waiting" and 3590 <= out["seconds_left"] <= 3600 and out["what"]["genre"] == "Cozy mystery"
    with pytest.raises(AkoweError) as ei:
        s.create("author", {"at": clock.t + 7200, "body": BODY})
    assert ei.value.code == "VERSION_CONFLICT"


def test_schedule_survives_a_restart_and_starts_on_time(tmp_path):
    clock = Clock()
    a1 = make_app(tmp_path, SlotFake())
    _sched(a1, clock).create("author", {"at": clock.t + 1800, "body": BODY})
    assert a1.scheduler.active()
    a1.store.close()
    a2 = make_app(tmp_path, SlotFake())  # Akọwe restarted: the schedule is still there
    s2 = _sched(a2, clock)
    assert s2.public()["state"] == "waiting"
    assert s2.tick()["state"] == "waiting"  # not yet
    clock.t += 1801
    st = s2.tick()
    assert st["state"] == "started" and st["run_id"]
    a2.autobook.wait_for(st["run_id"], 180)
    run = a2.autobook.get(st["run_id"])
    assert run["settings"]["genre"] == "Cozy mystery" and run["consent"]["by"] == "author"
    assert not s2.active()
    a2.store.close()


def test_more_than_two_hours_late_asks_then_start_now_or_cancel(tmp_path):
    clock = Clock()
    a1 = make_app(tmp_path, SlotFake())
    _sched(a1, clock).create("author", {"at": clock.t + 600, "body": BODY})
    a1.store.close()
    clock.t += 600 + run_schedule.LATE_ASK_S + 60  # Akọwe was closed at 11 pm; opened next morning
    a2 = make_app(tmp_path, SlotFake())
    s2 = _sched(a2, clock)
    st = s2.tick()
    assert st["state"] == "ask" and "not running" in st["message"]
    assert not a2.autobook.active()  # it did NOT start by itself
    assert s2.tick()["state"] == "ask"  # and keeps asking
    pseudo = s2.as_run()
    assert pseudo["state"] == "paused" and pseudo["needs_decision"]  # AutoInjector: "Your book needs you"
    out = s2.start_now("author")
    assert out["state"] == "started" and out["run_id"]
    a2.autobook.wait_for(out["run_id"], 180)
    # a new schedule, then cancel
    s2.create("author", {"at": clock.t + 3600, "body": BODY})
    assert s2.cancel("author")["state"] == "cancelled" and not s2.active()
    assert s2.dismiss("author") == {"state": "none"} and s2.public() == {"state": "none"}
    a2.store.close()


def test_a_schedule_that_cannot_start_says_why(app):
    clock = Clock()
    s = _sched(app, clock)
    s.create("author", {"at": clock.t + 120, "body": BODY})
    app.autobook.start = lambda *a, **k: (_ for _ in ()).throw(  # a run already works
        AkoweError("VERSION_CONFLICT", "/run", "a Make-a-book run is already working", status="REJECTED"))
    clock.t += 121
    st = s.tick()
    assert st["state"] == "failed" and "already working" in st["message"]


def test_scheduled_run_keeps_the_pc_awake_through_the_status_push(app):
    clock = Clock()
    s = _sched(app, clock)
    body = status_push.build_summary(app, "http://127.0.0.1:8787/")
    assert body["run"] is None
    s.create("author", {"at": clock.t + 3600, "body": BODY})
    body = status_push.build_summary(app, "http://127.0.0.1:8787/")
    run = body["run"]
    assert run["state"] == "waiting" and run["status"] == "waiting" and "starts at" in run["state_words"]
    assert len(status_push.encode(body)) < status_push.MAX_BODY
    if not shutil.which("node") or not (DESKTOP / "run-guard.js").exists():
        return
    # AutoInjector's own code: the pushed run summarises as live, and the run guard keeps the PC awake for it
    js = ("const r=require(%s);const g=require(%s);const s=r.summarizeRun(%s);"
          "process.stdout.write(JSON.stringify({live:s.live,state:s.state,busy:g.activityOf({run:s}).busy}))"
          % (json.dumps(str(DESKTOP / "akowe-run.js")), json.dumps(str(DESKTOP / "run-guard.js")), json.dumps(run)))
    out = subprocess.run(["node", "-e", js], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    res = json.loads(out.stdout)
    assert res == {"live": True, "state": "waiting", "busy": True}


def test_schedule_api(tmp_path):
    a = make_app(tmp_path, SlotFake())
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(a))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    try:
        st, out, _ = call(port, "GET", "/api/autobook/schedule")
        assert st == 200 and out == {"state": "none"}
        at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 7200))
        st, out, _ = call(port, "POST", "/api/autobook/schedule", {"at": at, "body": BODY})
        assert st == 201 and out["state"] == "waiting"
        st, lst, _ = call(port, "GET", "/api/autobook")
        assert st == 200 and lst["scheduled"]["state"] == "waiting"
        st, out, _ = call(port, "POST", "/api/autobook/schedule", {"at": "soon", "body": BODY})
        assert st == 400
        st, out, _ = call(port, "POST", "/api/autobook/schedule/cancel", {})
        assert st == 200 and out["state"] == "cancelled"
        st, _o, _ = call(port, "POST", "/api/autobook/schedule/nope", {})
        assert st == 404
        st, e, _ = call(port, "POST", "/api/estimate", {"length": "novel", "checkers": "two"})
        assert st == 200 and e["ais"] and "time_words" in e and e["options"]["checkers"] == "two"
        st, m, _ = call(port, "GET", "/api/usage-meter")
        assert st == 200 and len(m["ais"]) == 3
        st, p, _ = call(port, "POST", "/api/starter-sheet/parse", {"text": SHEET_FENCED})
        assert st == 200 and p["fields"]["length"] == "novella"
        st, _p, _ = call(port, "POST", "/api/starter-sheet/parse", {"text": "  "})
        assert st == 400
    finally:
        httpd.shutdown()
        httpd.server_close()
        a.store.close()


# ====================================================================== 📋 6c the starter sheet parser
SHEET_FENCED = """Here is your plan! I loved this idea — a gothic family story with a twist.

```
🔥 AKỌWE STARTER SHEET 🔥

**1. YOUR IDEA**
▶ A lighthouse keeper's daughter finds a drowned man who keeps waking up at low tide.
He remembers a town that does not exist yet.

**2. GENRE:** Gothic mystery

### 3. LENGTH
Short story / Novelette / ▶ Novella / Novel

4. ENDING: ▶ Bittersweet (she saves the town but loses him)
5. HOW MUCH IS EXPLAINED — Hint
6. DARKNESS AND PERIL
Some danger
(Why: it is a family read.)
7. DIALOGUE: Lots
8. PACE: medium
9. HUMOR: None
10. HOW THE STORY TREATS THE CHARACTERS: Character-led
11. STORY SHAPE: Save the Cat
12. KIND OF STORY: ▶ Voyage and Return
13. RUN OPTIONS
- Character pictures: On
- Fill the whole Book Bible: Off
- AIs checking for mistakes: Two
- Writers' room: ✅ On
- Beta readers: 2
- When only one AI works: Ask me
14. LOCK LIST
- The drowned man is never named.
- Mara is left-handed.
```
Let me know if you want any changes! Happy writing.
"""

SHEET_NO_NUMBERS = """Great — here's everything you need.

## 📚 Akowe Starter Sheet

🌟 **YOUR IDEA:**
Two rival bakers in 1920s Lagos are forced to share one oven after a fire.

🎭 **GENRE:** Historical romance with humour

📏 **LENGTH:**
Novel

🎬 **ENDING:**
- Neat
- ▶ Open
- Dark

❓ **HOW MUCH IS EXPLAINED:** Explain everything

⚠️ **DARKNESS AND PERIL:** Gentle — nobody dies, the stakes are love and money

💬 **DIALOGUE:** A lot — the banter carries it

⏩ **PACE:** Fast

😄 **HUMOUR:** Some (dry, character-based)

🧑 **HOW THE STORY TREATS THE CHARACTERS:** Balanced

📐 **STORY SHAPE:** 3 acts

📚 **KIND OF STORY:** Comedy — misunderstandings that end in a wedding

⚙️ **RUN OPTIONS:**
Character pictures: Yes · Fill the whole Book Bible: ✅ · AIs checking for mistakes: All · Writers' room: No · Beta readers: 3 · When only one AI works: Keep going

🔒 **LOCK LIST:**
1. Adunni's grandmother's recipe is never written down.
2. The fire was an accident.
3. Femi cannot swim.

---
If you'd like, I can also write a blurb for the back cover.
"""

SHEET_PROMPT_QUOTED = """You asked me to use this template:

AKỌWE STARTER SHEET
1. YOUR IDEA: (one paragraph)
2. GENRE: (up to 120 characters)
3. LENGTH: Short story / Novelette / Novella / Novel
4. ENDING: Neat / Bittersweet / Open / Dark / Let the AI choose

Here it is, filled in:

AKỌWE STARTER SHEET
1. YOUR IDEA: A retired astronaut finds her old mission patch on a stranger in a small Welsh village.
2. GENRE: Literary science fiction
3. LENGTH: Novelette
4. ENDING: Let the AI choose
5. HOW MUCH IS EXPLAINED: Leave mysteries
6. DARKNESS AND PERIL: Real danger
7. DIALOGUE: Little
8. PACE: Slow
9. HUMOR: none
10. HOW THE STORY TREATS THE CHARACTERS: Plot-led
11. STORY SHAPE: Let the AI decide
12. KIND OF STORY: The Quest
13. RUN OPTIONS: Character pictures Off · Fill the whole Book Bible On · AIs checking for mistakes One · Writers' room On · Beta readers 1 · When only one AI works Wait
14. LOCK LIST: (none)
"""


def test_parser_reads_a_fenced_sheet_with_commentary():
    r = starter_sheet.parse(SHEET_FENCED)
    f = r["fields"]
    assert r["ok"] and r["found_sheet"] and not r["not_understood"] and not r["missing"] and not r["too_long"]
    assert f["idea"].startswith("A lighthouse keeper's daughter") and "does not exist yet" in f["idea"]
    assert f["genre"] == "Gothic mystery" and f["length"] == "novella"
    assert f["choices"] == {"ending": "bittersweet", "explain": "hint", "darkness": "some", "dialogue": "lots",
                            "pace": "medium", "humor": "none", "characters": "character_led", "shape": "save_the_cat",
                            "kind": "voyage_return"}
    assert f["run"] == {"pictures": True, "fill_bible": False, "checkers": "two", "writers_room": True,
                        "beta_readers": 2, "single_ai": "ask"}
    assert f["locks"] == ["The drowned man is never named.", "Mara is left-handed."]  # not the chatty last line
    assert {x["label"] for x in r["filled"]} >= {"Your idea", "Genre", "Length", "Lock list", "Writers' room"}


def test_parser_reads_emoji_headings_without_numbers_and_variants():
    r = starter_sheet.parse(SHEET_NO_NUMBERS)
    f = r["fields"]
    assert r["found_sheet"] and not r["not_understood"], r["not_understood"]
    assert f["genre"] == "Historical romance with humour" and f["length"] == "novel"
    assert f["choices"] == {"ending": "open", "explain": "explain", "darkness": "gentle", "dialogue": "lots",
                            "pace": "fast", "humor": "some", "characters": "balanced", "shape": "three_acts",
                            "kind": "comedy"}
    assert f["run"] == {"pictures": True, "fill_bible": True, "checkers": "all", "writers_room": False,
                        "beta_readers": 3, "single_ai": "continue"}
    assert f["locks"] == ["Adunni's grandmother's recipe is never written down.", "The fire was an accident.",
                          "Femi cannot swim."]


def test_parser_uses_the_filled_sheet_not_the_quoted_template():
    r = starter_sheet.parse(SHEET_PROMPT_QUOTED)
    f = r["fields"]
    assert f["idea"].startswith("A retired astronaut") and f["length"] == "novelette"
    assert f["choices"]["ending"] == "" and f["choices"]["shape"] == ""   # let the AI choose / decide
    assert f["choices"]["explain"] == "leave" and f["choices"]["darkness"] == "real" and f["choices"]["kind"] == "quest"
    assert f["choices"]["characters"] == "plot_led" and f["choices"]["humor"] == "none"
    assert f["run"] == {"pictures": False, "fill_bible": True, "checkers": "one", "writers_room": True,
                        "beta_readers": 1, "single_ai": "wait"}
    assert f["locks"] == []
    assert any(x["label"] == "Ending" and x["value"] == "Let the AI choose" for x in r["filled"])


def test_parser_warns_when_too_long_and_offers_a_trim():
    idea = " ".join(f"Sentence number {i} tells more of the story." for i in range(60))  # ~2 600 characters
    text = f"AKOWE STARTER SHEET\n1. YOUR IDEA\n{idea}\n2. GENRE: {'Epic ' * 30}\n3. LENGTH: Novel\n"
    r = starter_sheet.parse(text)
    long_ = {t["key"]: t for t in r["too_long"]}
    assert long_["idea"]["length"] > 2000 and len(long_["idea"]["trimmed"]) <= 2000
    assert long_["idea"]["trimmed"].endswith(".")  # cut at the end of a sentence
    assert long_["genre"]["max"] == 120 and len(long_["genre"]["trimmed"]) <= 120
    assert r["fields"]["idea"] == idea  # the full text is kept: the author chooses


def test_parser_lists_what_it_did_not_understand_and_what_is_missing():
    text = """AKỌWE STARTER SHEET
1. YOUR IDEA: A ferry that only sails backwards in time.
3. LENGTH: Something epic and sprawling
4. ENDING: Neat / Bittersweet / Open / Dark / Let the AI choose
8. PACE: Brisk-ish
13. RUN OPTIONS
Character pictures On/Off
Beta readers: plenty
"""
    r = starter_sheet.parse(text)
    bad = {b["label"]: b["text"] for b in r["not_understood"]}
    assert "Length" in bad and "Ending" in bad and "Pace" in bad
    assert "Character pictures" in bad and "Beta readers" in bad
    assert "Genre" in r["missing"] and "Lock list" in r["missing"] and "Humor" in r["missing"]
    assert r["fields"]["length"] is None and "ending" not in r["fields"]["choices"]


def test_parser_without_a_sheet_says_so_plainly():
    r = starter_sheet.parse("Thanks! I'm glad you liked the story. Let me know what else you need.")
    assert not r["ok"] and "STARTER SHEET" in r["message"] and r["fields"]["idea"] is None


def test_parser_never_logs_the_text(caplog):
    caplog.set_level(logging.DEBUG)
    starter_sheet.parse(SHEET_FENCED)
    assert "lighthouse" not in caplog.text


# ====================================================================== 📋 the lock list in a run
def test_lock_list_goes_into_the_story_rules(app):
    with pytest.raises(AkoweError) as ei:
        app.autobook._clean_settings({"locks": "the dog lives"})
    assert ei.value.errors[0]["path"] == "/locks"
    with pytest.raises(AkoweError):
        app.autobook._clean_settings({"locks": ["x" * 301]})
    locks = ["The lighthouse lamp never goes out.", "Mara is left-handed."]
    run = run_book(app, {"length": "short_story", "locks": locks})
    assert run["status"] == "done" and run["settings"]["locks"] == locks
    rules = story_rules.get_entry(app.store, run["project_id"], "main")["rules"]
    mine = [r for r in rules if r["source"] == starter_sheet.LOCK_SOURCE]
    assert [r["text"] for r in mine] == locks and all(r["category"] == "hard_rule" for r in mine)
    assert any("lock list" in (e.get("message") or "").lower() for e in run["events"])
    # seeding twice adds nothing
    assert starter_sheet.seed_locks(app.store, run["project_id"], "main", locks) == 0
