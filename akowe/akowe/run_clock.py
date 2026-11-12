"""⏳ The run's clock: how far along a ⚡ Make-a-book run is, how long is left and when it should finish.

The author asked: "How long is it going to take? I want that up there so I can see where I'm at in the estimate."

* **At the start** (``plan_run``) the run keeps the plan's estimate (run_forecast.estimate, the same numbers the
  ⚡ window showed before the start): the total and a share per run step — the AI answers of every step and option
  (checkers, writers' room, story doctor, chapter 1 rewritten last, the 🎯 weakest scenes / improve pass, the final
  reads, beta readers, the chapter polish, character pictures, usage-limit waits) mapped onto the step that does them.
* **The clock** (``clock_start`` / ``clock_stop``) counts only the time the run works. A run that waits for the author
  (paused, a decision, a problem, Akọwe closed) stops its clock, so a night spent waiting for an answer never makes
  the estimate look wrong. Waiting for an AI (a usage limit, a second AI) is part of the run and counts.
* **While it runs** (``progress``) the time left = the estimated time of the steps still to do, corrected by how fast
  THIS run went so far (measured ÷ estimated for the finished steps and chapters, clamped 0.5–2×, trusted fully once
  about a quarter of the work is done). The chapters use their measured average (P15 ``_eta``) once one is written.
* **At the end** (``finish``) the run keeps its real working time next to the estimate; ``learned_ratio`` lets the
  next estimate learn from it (run_forecast applies it).

Numbers only — never book text. Never raises into the run: every entry point is safe to call.
"""
from __future__ import annotations

import logging
import statistics
from datetime import datetime, timezone

log = logging.getLogger("akowe.run_clock")

RATIO_MIN, RATIO_MAX = 0.5, 2.0          # how much this run's own speed may change the estimate
TRUST_SHARE = 0.25                        # the run's own speed is fully trusted once this share of the work is done
MIN_MEASURED_S = 60.0                     # less measured work than this says nothing about the run's speed
LEARN_MIN_S = 300.0                       # a finished run shorter than this (a test AI) teaches nothing
LEARN_RUNS = 5                            # the last N finished runs teach the next estimate
LEARN_MIN, LEARN_MAX = 0.6, 1.8
AUTHOR_WAIT = ("paused", "needs_decision", "problem", "interrupted")
MOVING = ("working", "waiting", "pausing")
# Akọwe's own steps without AI answers (seconds, before scaling to the plan's total)
FIXED_S = {"backup": 15, "format": 5, "assemble": 20, "export": 45, "check": 10, "looks": 60}
# run_forecast's option rows -> the run step that does that work
OPTION_STEP = {"checkers": "chapters", "writers_room": "plot", "beta": "beta", "bible": "bible",
               "human_pass": "report", "improve": "improve", "opening": "opening", "first_page": "chapters",
               "chapter_polish": "chapters", "reread": "reread", "story_doctor": "outline",
               "voice_contrast": "characters", "stand_in": "chapters", "trade_card": "outline",
               "fresh_names": "profile"}


def _now() -> float:
    return datetime.now(timezone.utc).timestamp()


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _ts(iso) -> float | None:
    if not iso:
        return None
    try:
        return datetime.strptime(str(iso), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


# ====================================================================== the clock (working time only)
def clock_start(run: dict, now: float | None = None) -> None:
    """The run (re)starts working. A clock left running by a crash counts up to the run's last save."""
    now = _now() if now is None else now
    c = run.setdefault("clock", {"active_s": 0.0, "since": None, "stopped_at": None})
    since = _ts(c.get("since"))
    if since is not None:  # Akọwe was closed while it worked: the time up to its last save counted
        end = _ts(run.get("updated_at")) or since
        c["active_s"] = round(float(c.get("active_s") or 0) + max(0.0, min(end, now) - since), 1)
    c["since"], c["stopped_at"] = _iso(now), None


def clock_stop(run: dict, now: float | None = None) -> None:
    """The run stopped working (finished, paused, waiting for the author, cancelled)."""
    c = run.get("clock")
    if not isinstance(c, dict):
        return
    now = _now() if now is None else now
    since = _ts(c.get("since"))
    if since is not None:
        c["active_s"] = round(float(c.get("active_s") or 0) + max(0.0, now - since), 1)
        c["since"] = None
        c["stopped_at"] = _iso(now)


def active_s(run: dict, alive: bool = True, now: float | None = None) -> float:
    """Seconds the run has worked (the author's waiting time left out)."""
    now = _now() if now is None else now
    c = run.get("clock")
    if not isinstance(c, dict):  # a run made before the clock: its wall time
        start = _ts(run.get("started_at"))
        if start is None:
            return 0.0
        end = _ts(run.get("finished_at")) or (now if alive else _ts(run.get("updated_at")) or now)
        return max(0.0, end - start)
    out = float(c.get("active_s") or 0)
    since = _ts(c.get("since"))
    if since is not None:
        end = now if alive else (_ts(run.get("updated_at")) or since)
        out += max(0.0, end - since)
    return out


def step_start(run: dict, st: dict, now: float | None = None) -> None:
    if st.get("clock0") is None:
        st["clock0"] = round(active_s(run, True, now), 1)


def step_done(run: dict, st: dict, now: float | None = None) -> None:
    if st.get("clock0") is not None:
        st["active_s"] = round(max(0.0, active_s(run, True, now) - float(st["clock0"])), 1)


# ====================================================================== the estimate kept at the start
def plan_of(est: dict) -> dict:
    """The estimate (run_forecast.estimate) as seconds per run step, scaled to its expected total."""
    per = float(est.get("per_call_s") or 45.0) * float(est.get("overhead") or 1.15)
    steps: dict[str, float] = {}
    for row in est.get("steps") or []:
        sid = str(row.get("step") or "")
        if sid.startswith("option:"):
            sid = OPTION_STEP.get(sid.split(":", 1)[1], "")
        if sid:
            steps[sid] = steps.get(sid, 0.0) + float(row.get("calls") or 0) * per
    opts = est.get("options") or {}
    if opts.get("pictures"):
        from .run_forecast import PICTURE_MIN, PICTURES  # noqa: PLC0415
        steps["pictures"] = steps.get("pictures", 0.0) + PICTURES * PICTURE_MIN * 60
    if est.get("wait_minutes"):
        steps["chapters"] = steps.get("chapters", 0.0) + float(est["wait_minutes"]) * 60
    for sid, s in FIXED_S.items():
        steps[sid] = steps.get(sid, 0.0) + s
    steps = {k: max(0.0, v) for k, v in steps.items()}
    total = float(((est.get("minutes") or {}).get("expected") or 0) * 60) or sum(steps.values())
    have = sum(steps.values())
    scale = total / have if have > 0 else 1.0
    ratio = float((est.get("learned") or {}).get("ratio") or 1.0)
    return {"total_s": int(round(total)), "raw_total_s": int(round(total / ratio)) if ratio > 0 else int(total),
            "learned_ratio": ratio, "steps": {k: int(round(v * scale)) for k, v in steps.items() if v * scale >= 1},
            "chapters": int(est.get("chapters") or 0), "time_words": str(est.get("time_words") or "")[:60],
            "at": _iso(_now())}


def plan_run(app, run: dict) -> None:
    """Keep the plan's estimate on the run (once; a run resumed after an update gets one then). Never raises."""
    if run.get("forecast"):
        return
    try:
        from . import run_forecast  # noqa: PLC0415
        run["forecast"] = plan_of(run_forecast.estimate(app, dict(run.get("settings") or {})))
        log.info("run %s estimate kept: %s s, %s steps", run.get("id"), run["forecast"]["total_s"],
                 len(run["forecast"]["steps"]))
    except Exception:  # noqa: BLE001 - the run goes on without an estimate (the strip shows the steps only)
        log.exception("could not keep the run's estimate")


def finish(run: dict, now: float | None = None) -> None:
    """The run finished: stop the clock and keep its real working time beside the estimate."""
    clock_stop(run, now)
    fc = run.get("forecast")
    if isinstance(fc, dict):
        fc["actual_s"] = int(round(active_s(run, False, now)))
        log.info("run %s finished: %s s worked, %s s estimated", run.get("id"), fc["actual_s"], fc.get("total_s"))


def learned_ratio(app) -> dict:
    """How long the last finished runs really worked against what was estimated before them (before this
    correction): {ratio, runs}. 1.0 without such runs."""
    out = []
    try:
        jobs = app.jobstore.list(kind="autobook", limit=100)
    except Exception:  # noqa: BLE001
        jobs = []
    for j in jobs:
        fc = j.get("forecast") or {}
        raw, act = float(fc.get("raw_total_s") or 0), float(fc.get("actual_s") or 0)
        if j.get("status") != "done" or (j.get("settings") or {}).get("continue") or raw < LEARN_MIN_S \
                or act < LEARN_MIN_S:
            continue
        out.append(act / raw)
        if len(out) >= LEARN_RUNS:
            break
    if not out:
        return {"ratio": 1.0, "runs": 0}
    return {"ratio": round(min(LEARN_MAX, max(LEARN_MIN, statistics.median(out))), 2), "runs": len(out)}


# ====================================================================== where the run stands now
def _relevant(run: dict) -> list[dict]:
    """The steps this run really does (not switched off, not an extra it did not ask for)."""
    from .autobook import STEP_FLAGS, STEP_OPTIONAL  # noqa: PLC0415
    s = run.get("settings") or {}
    flags = (s.get("pipeline") or {}).get("flags") or {}
    out = []
    for st in run.get("steps") or []:
        sid = st.get("id")
        if st.get("state") == "skipped" or (STEP_FLAGS.get(sid) and not flags.get(STEP_FLAGS[sid], True)):
            continue
        if STEP_OPTIONAL.get(sid) and not s.get(STEP_OPTIONAL[sid]):
            continue
        out.append(st)
    return out


def _label(st: dict | None) -> str:
    if not st:
        return ""
    from .autobook import STEP_DOING  # noqa: PLC0415
    if st.get("id") == "chapters":
        items = st.get("items") or []
        if items:
            k = next((i for i, it in enumerate(items) if it.get("state") != "done"), len(items) - 1)
            return f"Writing chapter {k + 1} of {len(items)}"
    return STEP_DOING.get(st.get("id"), st.get("title") or "")


def ratio_of(run: dict, plan: dict, now_active: float | None = None) -> float:
    """This run's speed against the estimate (measured ÷ estimated for its finished steps and chapters), clamped
    and weighted by how much of the work it has seen."""
    est = plan.get("steps") or {}
    total = float(plan.get("total_s") or 0)
    done_est = done_act = 0.0
    for st in run.get("steps") or []:
        e = float(est.get(st.get("id"), 0))
        if st.get("state") == "done" and st.get("active_s") is not None and e > 0:
            done_est += e
            done_act += float(st["active_s"])
        elif st.get("id") == "chapters" and st.get("state") != "done" and e > 0:
            n = len(st.get("items") or []) or int(plan.get("chapters") or 0)
            secs = [float(x) for x in ((run.get("timing") or {}).get("chapter_s") or [])
                    if isinstance(x, (int, float))][-max(1, n):] if n else []
            if n and secs:
                done_est += e * min(len(secs), n) / n
                done_act += sum(secs)
    if done_est < MIN_MEASURED_S or total <= 0:
        return 1.0
    raw = min(RATIO_MAX, max(RATIO_MIN, done_act / done_est))
    w = min(1.0, done_est / max(1.0, TRUST_SHARE * total))
    return 1.0 + w * (raw - 1.0)


def progress(run: dict, alive: bool, state: str, now: float | None = None) -> dict:
    """The fields of the always-visible progress strip (top bar of Akọwe and AutoInjector):
    total_estimate_s, elapsed_active_s, left_s, finish_at, percent, step_index, step_total, step_label,
    waiting_since, speed_ratio, actual_s (finished runs)."""
    now = _now() if now is None else now
    plan = run.get("forecast") if isinstance(run.get("forecast"), dict) else {}
    est = plan.get("steps") or {}
    act = active_s(run, alive, now)
    steps = _relevant(run)
    cur = next((s for s in steps if s.get("id") == run.get("current") and s.get("state") not in ("done",)), None) \
        or next((s for s in steps if s.get("state") not in ("done", "cancelled")), None)
    out = {"total_estimate_s": plan.get("total_s"), "elapsed_active_s": int(round(act)), "left_s": None,
           "finish_at": None, "percent": None, "step_index": None, "step_total": len(steps) or None,
           "step_label": _label(cur), "waiting_since": None, "speed_ratio": None, "actual_s": plan.get("actual_s")}
    if steps:
        out["step_index"] = (steps.index(cur) + 1) if cur in steps else len(steps)
    if state in AUTHOR_WAIT:
        c = run.get("clock") or {}
        out["waiting_since"] = c.get("stopped_at") or run.get("updated_at")
    if state == "done":
        out.update(left_s=0, percent=100, step_label="Finished", actual_s=plan.get("actual_s") or int(round(act)))
        return out
    left = None
    if est:
        ratio = ratio_of(run, plan)
        out["speed_ratio"] = round(ratio, 2)
        left = 0.0
        after = False
        for st in steps:
            if st.get("state") == "done":
                continue
            e = float(est.get(st.get("id"), 0)) * ratio
            if st is cur and not after:
                after = True
                spent = max(0.0, act - float(st.get("clock0") if st.get("clock0") is not None else act))
                left += _left_in(run, st, e, spent)
            else:
                left += e
    elif (run.get("eta") or {}).get("seconds_left") is not None:  # no estimate kept: the measured chapters (P15)
        left = float(run["eta"]["seconds_left"])
    if left is not None:
        out["left_s"] = int(round(left))
        whole = act + left
        out["percent"] = min(99, int(act * 100 / whole)) if whole > 0 else 0
        if state in MOVING:
            out["finish_at"] = _iso(now + left)
    return out


def _left_in(run: dict, st: dict, e: float, spent: float) -> float:
    """Time left in the step the run is on: the chapters by their measured average once one is written (P15),
    any other step by its estimate minus the time it took so far (at least a tenth of it while it works)."""
    if st.get("id") == "chapters":
        items = st.get("items") or []
        secs = [float(x) for x in ((run.get("timing") or {}).get("chapter_s") or []) if isinstance(x, (int, float))]
        n_done = sum(1 for i in items if i.get("state") == "done")
        if items and secs:
            avg = sum(secs[-10:]) / len(secs[-10:])
            return max(0.0, (len(items) - n_done) * avg)
    return max(e - spent, 0.1 * e)
