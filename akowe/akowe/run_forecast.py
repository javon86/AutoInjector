"""⏱ 3d An estimate before a book starts: how long, how many answers per AI, and whether a usage limit will stop it.

Built on ``costs.estimate`` (P28: AI calls per run step, calibrated from this computer's finished runs, and seconds
per AI answer measured in them). This module adds what the Make-a-book screen's options change and what P28 did not
count yet, splits the answers per AI, and lays them over each AI's usage limit (usage_meter.py) to say whether — and
around which chapter — a limit will probably pause it:

* **options** (``OPTION_MODEL``): how many AIs check for mistakes (all / two / one), the writers' room, beta readers,
  character pictures (Stable Diffusion: time, no AI answers), "fill the whole Book Bible", the end-of-book "sounds like
  a person" pass (PR #133: about 2 answers), the 🔁 final improve pass (rounds × (rewrites + the reviewers' re-read)
  + the kept chapters' reviews), the 🤖 Claude Code helpers and "when only one AI works". With measured
  runs, the options whose answers fall inside the measured steps (the checkers, the writers' room and the end pass)
  count only as the DIFFERENCE from the options those runs had (they are already in the measured numbers), and the
  optional steps P28 does not model (beta readers, the whole Book Bible) use their own measured answers when there
  are some;
* **per AI**: the writer (the AI picked, else the first) writes, the other AIs review and check; measured runs' share
  of answers per AI replaces that guess; option answers go where the option sends them (the checkers to every AI,
  beta readers and the end pass to the AIs that did not write, the helpers to Claude Code);
* **limits**: each AI's answers spread over the run; an AI that would give more answers in its window than its plan
  usually allows (``usage_meter.limit_of``: a rough public guess, or what this computer saw before) hits its limit
  — the forecast says roughly when (which chapter) and for how long. Answers already used in the current window
  (the meter) count. When another AI can carry on (more than one AI, not "wait for a second AI", the writer not
  pinned), only part of that pause makes the run longer.

Everything is an estimate and is labelled so. Numbers only: no prompt, answer or book text.
"""
from __future__ import annotations

import logging
import math

from . import costs as costs_mod
from . import usage_meter

log = logging.getLogger("akowe.run_forecast")

CHECKER_LIMIT = {"all": 3, "two": 2, "one": 1}
SINGLE_AI = ("continue", "wait", "ask")
WRITER_SHARE = 0.55            # share of the run's answers the writer gives (before any run was measured)
PICTURE_MIN = 1.0              # minutes per character picture (Stable Diffusion)
PICTURES = costs_mod.CHARACTERS - 1 + 5   # a portrait each, the full set (5) for the main character
CARRY_ON_SHARE = 0.25          # share of a limit pause that still makes the run longer when another AI carries on
CHAPTERS_FROM, CHAPTERS_TO = 0.15, 0.9   # where the chapters lie in the run's time (the rest: planning, the end)
DEFAULT_AIS = (("AI-1", "AI-1 · Claude", "claude"), ("AI-2", "AI-2 · ChatGPT", "chatgpt"),
               ("AI-3", "AI-3 · Gemini", "gemini"))
INSIDE_MEASURED = ("checkers", "writers_room", "human_pass")   # their answers are inside costs' measured steps
OWN_STEP = {"beta": "beta", "bible": "bible", "improve": "improve"}   # option -> its own run step (measured when made)


# ====================================================================== the options of a run
def options_of(app, body: dict | None) -> dict:
    """The run options this estimate is for, from a ⚡ Make-a-book start body (defaults like the run's)."""
    b = body if isinstance(body, dict) else {}
    ck = b.get("checkers") if b.get("checkers") in CHECKER_LIMIT else "all"
    n_beta = 0
    if b.get("beta_reader") is True:
        n = b.get("beta_readers", 1)
        n_beta = n if isinstance(n, int) and not isinstance(n, bool) and 1 <= n <= 3 else 1
    pics = b.get("pictures")
    if not isinstance(pics, bool):
        try:
            from . import book_pictures  # noqa: PLC0415
            pics = bool(book_pictures.settings(app.store)["run"])
        except Exception:  # noqa: BLE001
            pics = True
    cc_on = b.get("claude_code")
    if not isinstance(cc_on, bool):
        try:
            from . import claude_code as cc  # noqa: PLC0415
            cc_on = bool(cc.enabled(app.store) and (cc.cached_status() or {}).get("state") == "ready")
        except Exception:  # noqa: BLE001
            cc_on = False
    return {"checkers": ck, "writers_room": b.get("writers_room") is True, "beta_readers": n_beta,
            "pictures": pics, "fill_bible": b.get("fill_bible") is True, "human_pass": b.get("human_pass") is not False,
            "improve_pass": b.get("improve_pass") is not False,
            "improve_rounds": b.get("improve_rounds") if isinstance(b.get("improve_rounds"), int)
            and not isinstance(b.get("improve_rounds"), bool) and 1 <= b.get("improve_rounds") <= 3 else 2,
            "claude_code": cc_on, "single_ai": b.get("single_ai") if b.get("single_ai") in SINGLE_AI else "continue",
            "slot_id": b.get("slot_id") if isinstance(b.get("slot_id"), str) and b.get("slot_id") else None}


def option_calls(opts: dict, n: int, ais: int) -> dict:
    """AI answers each option adds to a run of ``n`` chapters with ``ais`` different AIs:
    {option: {"calls", "to" (writer / others / all / helpers), "label", "minutes" (extra time without answers)}}."""
    n, ais = max(1, int(n)), max(1, int(ais))
    out = {}
    k = max(0, min(CHECKER_LIMIT[opts.get("checkers") or "all"], ais) - 1)  # checkers beyond the first
    out["checkers"] = {"calls": k * (2 * n + math.ceil(n / 5) + 1), "to": "all",
                       "label": f"More AIs checking for mistakes ({k + 1} AI{'s' if k else ''})"}
    rooms = 3 if n >= 3 else 1
    out["writers_room"] = {"calls": (rooms * (2 * ais if ais >= 2 else 1)) if opts.get("writers_room") else 0,
                           "to": "all", "label": "Writers' room for the big twists"}
    out["beta"] = {"calls": int(opts.get("beta_readers") or 0), "to": "others", "label": "Beta readers"}
    out["bible"] = {"calls": (6 + int(round(0.4 * n))) if opts.get("fill_bible") else 0, "to": "writer",
                    "label": "Fill the whole Book Bible"}
    hp = 2 if opts.get("human_pass") else 0   # PR #133: the AI read + the rewrites
    out["human_pass"] = {"calls": hp, "to": "others", "label": "End-of-book “sounds like a person” pass"}
    # 🔁 the final improve pass (improve_pass.py): per round one rewrite per chapter worked on (≤ 3) and the same
    # reviewers' re-read (the AIs that did not write it); a kept round adds each chapter's review and editor read
    if opts.get("improve_pass"):
        c, r = min(3, n), max(1, min(ais - 1, 3)) if ais > 1 else 1
        rounds = int(opts.get("improve_rounds") or 2)
        out["improve"] = {"calls": rounds * (c + r) + 3 * c, "to": "all",
                          "label": f"Improve until better (up to {rounds} round{'s' if rounds != 1 else ''})"}
    else:
        out["improve"] = {"calls": 0, "to": "all", "label": "Improve until better"}
    out["pictures"] = {"calls": 0, "to": "none", "label": "Character pictures (Stable Diffusion: no AI answers)",
                       "minutes": PICTURES * PICTURE_MIN if opts.get("pictures") else 0}
    helpers = (3 * n + 2 * math.ceil(n / 5)) if opts.get("claude_code") else 0
    out["helpers"] = {"calls": helpers, "to": "helpers", "label": "Claude Code helpers (research, fact checks, "
                      "“sounds like AI” pass)"}
    return out


# ====================================================================== calibration from this computer's runs
def _measured_runs(app) -> list[dict]:
    try:
        jobs = app.jobstore.list(kind="autobook", limit=200)
    except Exception:  # noqa: BLE001
        return []
    out = []
    for j in jobs:
        t = j.get("timing") or {}
        if j.get("status") != "done" or int(t.get("calls") or 0) < costs_mod.MIN_CALLS_FOR_AVG:
            continue
        out.append(j)
        if len(out) >= costs_mod.RUNS_MEASURED:
            break
    return out


def _run_chapters(j: dict) -> int:
    return max(1, len([i for s in j.get("steps") or [] if s.get("id") == "chapters" for i in s.get("items") or []]))


def _run_opts(j: dict) -> dict:
    s = j.get("settings") or {}
    return {"checkers": s.get("checkers") or "all", "writers_room": bool(s.get("writers_room")),
            "human_pass": s.get("human_pass") is not False, "beta_readers": (s.get("beta_readers") or 1)
            if s.get("beta_reader") else 0, "fill_bible": bool(s.get("fill_bible")),
            "improve_pass": bool(s.get("improve_pass")), "improve_rounds": s.get("improve_rounds") or 2}


def calibration(app, n: int, opts: dict, ais: int) -> dict:
    """Per option: the calls to ADD to costs.estimate for this run ({option: calls}), and per-AI shares and seconds
    per answer from the measured runs."""
    runs = _measured_runs(app)
    want = option_calls(opts, n, ais)
    add = {k: float(v["calls"]) for k, v in want.items()}
    shares: dict[str, float] = {}
    secs: dict[str, list] = {}
    if not runs:
        return {"add": add, "shares": {}, "per_ai_s": {}, "runs": 0}
    base = {k: 0.0 for k in INSIDE_MEASURED}
    own = {k: [] for k in OWN_STEP}
    for j in runs:
        rn = _run_chapters(j)
        by_ai = (j.get("timing") or {}).get("by_ai") or {}
        r_ais = max(1, len([s for s in by_ai if s not in (costs_mod.UNKNOWN_AI, usage_meter.CLAUDE_CODE)]))
        had = option_calls(dict(_run_opts(j), pictures=False, claude_code=False), rn, r_ais)
        for k in INSIDE_MEASURED:  # per chapter, so a run of another length still compares
            base[k] += had[k]["calls"] / rn
        steps = (j.get("timing") or {}).get("by_step") or {}
        for k, step in OWN_STEP.items():
            m = steps.get(step) or {}
            if m.get("calls") and had[k]["calls"]:
                own[k].append(float(m["calls"]) / had[k]["calls"])  # measured answers per modelled answer
        total = sum(int(v.get("calls") or 0) for s, v in by_ai.items() if s != costs_mod.UNKNOWN_AI)
        for s, v in by_ai.items():
            if s == costs_mod.UNKNOWN_AI or not total:
                continue
            shares[s] = shares.get(s, 0.0) + int(v.get("calls") or 0) / total / len(runs)
            if int(v.get("calls") or 0):
                secs.setdefault(s, []).append(float(v.get("s") or 0) / int(v["calls"]))
    for k in INSIDE_MEASURED:
        add[k] = want[k]["calls"] - base[k] / len(runs) * n
    for k, ratios in own.items():
        if ratios and add[k]:
            add[k] = add[k] * sum(ratios) / len(ratios)
    return {"add": add, "shares": shares, "per_ai_s": {s: round(sum(v) / len(v), 1) for s, v in secs.items() if v},
            "runs": len(runs)}


# ====================================================================== the AIs
def ais_of(app) -> tuple[list[dict], bool]:
    """One entry per different AI (two slots on the same website are the same AI): [{key, name, family}], and whether
    they are assumed (no AI connected yet: Claude, ChatGPT and Gemini)."""
    from .providers import slot_family, slot_name  # noqa: PLC0415
    try:
        slots = app.engine.providers.ai_slots()
    except Exception:  # noqa: BLE001
        slots = []
    out, seen = [], set()
    for s in slots:
        fam = slot_family(s) or s["slot_id"]
        if fam in seen:
            continue
        seen.add(fam)
        name = slot_name(s)
        out.append({"key": s["slot_id"], "name": name, "family": usage_meter.family_of(s["slot_id"], name)})
    if out:
        return out, False
    return [{"key": k, "name": n, "family": f} for k, n, f in DEFAULT_AIS], True


def _split(total: float, to: str, ais: list[dict], writer: str, shares: dict | None = None) -> dict:
    keys = [a["key"] for a in ais]
    if not keys or total <= 0:
        return {}
    others = [k for k in keys if k != writer] or [writer]
    if to == "writer":
        return {writer: total}
    if to == "others":
        return {k: total / len(others) for k in others}
    if to == "all":
        return {k: total / len(keys) for k in keys}
    # the run's own answers: measured shares when they name these AIs, else the writer writes and the others check
    sh = {k: v for k, v in (shares or {}).items() if k in keys}
    if sh and sum(sh.values()) > 0.5:
        s = sum(sh.values())
        return {k: total * v / s for k, v in sh.items()}
    if len(keys) == 1:
        return {writer: total}
    out = {writer: total * WRITER_SHARE}
    for k in others:
        out[k] = total * (1 - WRITER_SHARE) / len(others)
    return out


# ====================================================================== limits over the run
def _pauses(calls: float, run_min: float, lim: dict | None, used_now: int) -> list[dict]:
    """When (share of the run's working time) this AI hits its limit and how long it waits each time."""
    if not lim or calls <= 0 or run_min <= 0:
        return []
    W = lim["window_s"] / 60.0
    L = max(1, int(lim["answers"]))
    r = calls / run_min                       # answers per minute of working time
    remaining, t_run, clock, w_end = calls, 0.0, 0.0, W
    cap = max(0, L - used_now)
    out = []
    for _ in range(60):
        to_end = max(0.0, w_end - clock)
        if remaining <= cap and remaining / r <= to_end + 1e-9:
            break
        if cap / r < to_end:                 # the allowance runs out before the window resets: a pause
            t_run += cap / r
            remaining -= cap
            out.append({"at": min(1.0, t_run / run_min), "minutes": round(w_end - (clock + cap / r)),
                        "left": round(remaining)})
            clock = w_end
        else:                                # the window resets first
            t_run += to_end
            remaining -= r * to_end
            clock = w_end
        w_end = clock + W
        cap = L
        if remaining <= 0:
            break
    return [p for p in out if p["minutes"] > 0 and p["left"] >= 3]  # a last answer or two: absorbed, no pause


def chapter_at(frac: float, n: int) -> int | None:
    if frac < CHAPTERS_FROM:
        return None
    return max(1, min(n, int(round((frac - CHAPTERS_FROM) / (CHAPTERS_TO - CHAPTERS_FROM) * n)) + 1))


def hours_words(minutes: float) -> str:
    h = minutes / 60.0
    if h < 1:
        return f"~{max(5, int(round(minutes / 5.0)) * 5)}-minute"
    return f"~{h:.0f}-hour" if h >= 1.5 else "~1-hour"


def duration_words(lo: float, hi: float) -> str:
    """'about 40–80 minutes' / 'about 6–8 hours' / 'about 2–3 days' (plain, rounded)."""
    lo, hi = max(1.0, float(lo)), max(1.0, float(hi))
    if hi < 90:
        return f"about {int(round(lo))}–{int(round(hi))} minutes"
    if hi < 48 * 60:
        a, b = max(1, int(math.floor(lo / 60))), max(1, int(math.ceil(hi / 60)))
        return f"about {a} hour{'s' if b > 1 else ''}" if a == b else f"about {a}–{b} hours"
    a, b = max(1, int(round(lo / 1440))), max(1, int(round(hi / 1440)))
    return f"about {a} day{'s' if b > 1 else ''}" if a == b else f"about {a}–{b} days"


# ====================================================================== the estimate
def estimate(app, body: dict | None) -> dict:
    """costs.estimate plus the run options, the answers per AI and the usage-limit forecast (an estimate)."""
    body = body if isinstance(body, dict) else {}
    base = costs_mod.estimate(app, body)
    opts = options_of(app, body)
    ais, assumed = ais_of(app)
    n = int(base["chapters"])
    cal = calibration(app, n, opts, len(ais))
    want = option_calls(opts, n, len(ais))
    writer = opts["slot_id"] if opts["slot_id"] in {a["key"] for a in ais} else ais[0]["key"]
    per_call, overhead = float(base["per_call_s"]), float(base["overhead"])
    # ---- answers per AI
    per_ai: dict[str, float] = {}
    for k, v in _split(base["calls"]["expected"], "run", ais, writer, cal["shares"]).items():
        per_ai[k] = per_ai.get(k, 0.0) + v
    rows = list(base["steps"])
    extra_calls, helpers = 0.0, 0.0
    for k, v in want.items():
        add = cal["add"].get(k, 0.0)
        if k == "helpers":
            helpers = add
            continue
        if abs(add) >= 0.5:
            rows.append({"step": f"option:{k}", "label": v["label"], "calls": int(round(add)),
                         "basis": "measured" if cal["runs"] and k in INSIDE_MEASURED else "model"})
        extra_calls += add
        for key, c in _split(add, v["to"], ais, writer).items():
            per_ai[key] = max(0.0, per_ai.get(key, 0.0) + c)
    # the helpers read for Claude in the per-chapter check (when Claude did not write): fewer answers in Claude's pane
    claude = next((a["key"] for a in ais if a["family"] == "claude"), None)
    if helpers and claude and claude != writer:
        per_ai[claude] = max(0.0, per_ai.get(claude, 0.0) - n)
    calls = max(1, int(round(base["calls"]["expected"] + extra_calls)))
    # ---- time (the helpers run beside the web AIs: they add no time and save some of the checks' waiting)
    work_min = base["minutes"]["expected"] + extra_calls * per_call * overhead / 60.0 + want["pictures"].get("minutes", 0)
    if helpers:
        work_min -= 0.5 * n * per_call / 60.0
    work_min = max(1.0, work_min)
    # ---- limits
    limits, wait_min = [], 0.0
    out_ais = []
    many = len(ais) >= 2 and opts["single_ai"] != "wait"
    entries = [(a, per_ai.get(a["key"], 0.0)) for a in ais]
    if helpers:
        entries.append(({"key": usage_meter.CLAUDE_CODE, "name": "Claude Code helpers", "family": "claude_code"},
                        helpers))
    for a, c in entries:
        lim = usage_meter.limit_of(a["family"])
        used_now = usage_meter.used(a["key"], lim["window_s"]) if lim else 0
        pauses = _pauses(c, work_min, lim, used_now)
        carry = many and not (opts["slot_id"] and a["key"] == writer) and a["key"] != usage_meter.CLAUDE_CODE
        name = usage_meter.FAMILY_NAMES.get(a["family"]) or a["name"]
        status, line = "ok", f"{name}: about {int(round(c))} answers"
        if lim and not pauses and c + used_now > 0.8 * lim["answers"] * max(1.0, work_min / (lim["window_s"] / 60)):
            status = "close"
            line += " — close to its usual limit, but should get through"
        elif lim and not pauses:
            line += " — should stay within its usual limit"
        elif not lim:
            line += " — no message limit Akọwe knows of"
        for p in pauses:
            ch = chapter_at(p["at"], n)
            p.update(chapter=ch, hours=round(p["minutes"] / 60.0, 1))
            if carry:
                wait_min += CARRY_ON_SHARE * p["minutes"]
            else:
                wait_min += p["minutes"]
        if pauses:
            status = "limit"
            p = pauses[0]
            ch = p["chapter"]
            where = f"around chapter {ch}" if ch else "before the chapters start"
            more = f" (and {len(pauses) - 1} more time{'s' if len(pauses) > 2 else ''} later)" if len(pauses) > 1 else ""
            if carry:
                sent = (f"{name} will probably reach its limit {where}{more}; the other AIs carry on and it is back "
                        f"about {max(1, round(p['minutes'] / 60))} hour(s) later")
            else:
                sent = f"{name} will probably need a {hours_words(p['minutes'])} pause {where}{more}"
            limits.append(sent)
            line += " — " + sent[len(name) + 1:]
        out_ais.append({"key": a["key"], "name": a["name"], "family": a["family"], "calls": int(round(c)),
                        "used_now": used_now, "typical": lim["answers"] if lim else None,
                        "window_s": lim["window_s"] if lim else None, "typical_learned": bool(lim and lim["learned"]),
                        "status": status, "pauses": pauses, "line": line,
                        "per_answer_s": cal["per_ai_s"].get(a["key"])})
    exp = work_min + wait_min
    lo_r, hi_r = costs_mod.RANGE
    lo, hi = work_min * lo_r + 0.5 * wait_min, work_min * hi_r + wait_min
    out = dict(base)
    out.update({
        "calls": {"expected": calls, "low": int(math.floor(calls * lo_r)), "high": int(math.ceil(calls * hi_r))},
        "minutes": {"expected": int(round(exp)), "low": max(1, int(math.floor(lo))), "high": max(1, int(math.ceil(hi)))},
        "time_words": duration_words(lo, hi), "steps": rows, "options": opts, "ais": out_ais, "ais_assumed": assumed,
        "helpers_calls": int(round(helpers)), "limits": limits, "will_hit_limit": bool(limits),
        "wait_minutes": int(round(wait_min)), "is_estimate": True,
        "about": base["about"] + (" Per AI: from your earlier runs." if cal["shares"] else "") +
        " Usage limits: rough guesses (the AI sites do not publish them), or what this computer saw before.",
    })
    out.update(pen_name_check(app, body))
    return out


def pen_name_check(app, body: dict) -> dict:
    """✒️ The plan check of the pen name: which one the new book gets (typed here, else the saved one, else none) and
    a ⚠️ when it is also a character's name in another book on the shelf (or the book this run is a variant of)."""
    from . import pen_name  # noqa: PLC0415
    try:
        name, how = pen_name.for_new_book(app.store, body.get("pen_name"))
        warn = pen_name.warning(app.store, None, name) if name else None
    except Exception:  # noqa: BLE001 - a plan hint never breaks the estimate
        return {"pen_name": {"name": "", "from": ""}, "warnings": []}
    return {"pen_name": {"name": name, "from": how, "saved": pen_name.saved(app.store)},
            "warnings": [warn] if warn else []}
