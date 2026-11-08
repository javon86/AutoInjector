"""📊 Usage meter per AI (3e): how much each AI has been used lately, when it last hit its usage limit, and when that
limit resets (if known).

Honest by design: ChatGPT, Claude and Gemini do not publish exact message limits, and the limits change with the
plan, the model and the length of the messages. So the meter shows what Akọwe itself KNOWS:

* **answers** — every AI answer Akọwe got, per AI (``ai_activity`` tells this module about each finished call: the
  one choke point every AI call passes, ``providers._generate_on``; the 🤖 Claude Code helpers report there too);
* **limit hits** — when a call ended on a usage-limit notice (bridge problem ``USAGE_LIMIT`` / ``SITE_RATE_LIMITED``,
  ``usage_limits.LIMIT_PROBLEMS``), when every AI was held by a limit (``usage_limits.note``), or when the meter
  sees an AI's site state say so (AutoInjector's ``/v1/health``, ``providers.slot_status``) — with the reset time the
  bridge gave (``limit_reset_at``) when it gave one;
* **a status colour** from those: 🔴 at its limit now · 🟠 hit a limit in the last day, or used most of what a plan
  usually allows in its window · 🟢 fine · ⚪ not connected.

The "usually allows" numbers (``ASSUMED``) are rough public guesses, said so in the meter. After a real limit hit on
this computer, the number of answers that AI gave in its window before the hit replaces the guess (``learned``): the
forecast before a run (run_forecast.py) uses the same numbers.

Stored in the setting ``usage_meter`` (numbers and times only — never a prompt, an answer or book text), saved at most
every ``SAVE_GAP_S`` seconds when something changed. Process-wide and thread-safe; never raises into an AI call.
"""
from __future__ import annotations

import copy
import logging
import re
import threading
import time
from datetime import datetime, timezone

log = logging.getLogger("akowe.usage_meter")

SETTING = "usage_meter"
KEEP_ANSWERS_S = 26 * 3600      # answer times kept (the longest window is a day)
KEEP_DAYS = 8                   # per-day counts kept
KEEP_HITS = 12                  # limit hits kept per AI
HIT_DEDUPE_S = 20 * 60          # the same limit seen again within this time is the same hit
LIMITED_FOR_S = 45 * 60         # a hit without a reset time counts as "at its limit" this long
RECENT_HIT_S = 24 * 3600        # a hit in the last day makes the colour amber
SAVE_GAP_S = 30.0
MAX_ANSWERS = 3000
CLAUDE_CODE = "claude-code"     # claude_code_book.PSEUDO_SLOT

# family -> (window in seconds, answers a plan usually allows in it, plain words). Rough public guesses only.
ASSUMED = {
    "claude": (5 * 3600, 40, "Claude's plans allow roughly 40 long messages every 5 hours (a rough guess)"),
    "chatgpt": (3 * 3600, 80, "ChatGPT's plans allow roughly 80 messages every 3 hours (a rough guess)"),
    "gemini": (24 * 3600, 100, "Gemini's plans allow roughly 100 messages a day (a rough guess)"),
    "claude_code": (5 * 3600, 40, "Claude Code shares your Claude plan: roughly 40 jobs every 5 hours (a rough "
                                  "guess)"),
}
FAMILY_NAMES = {"claude": "Claude", "chatgpt": "ChatGPT", "gemini": "Gemini", "claude_code": "Claude Code helpers"}
COLOURS = ("red", "amber", "green", "grey")

_LOCK = threading.RLock()
_STATE: dict = {"ais": {}}
_STORE = {"store": None, "dirty": False, "saved": 0.0}
_clock = time.time


def _now() -> float:
    return float(_clock())


def _iso(t: float | None) -> str | None:
    if not t:
        return None
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _day(t: float) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(t))


def _slot_of(name_or_slot) -> str | None:
    """"AI-2 · ChatGPT" / "AI-2" -> "AI-2"; the Claude Code helpers keep their own key."""
    s = str(name_or_slot or "").strip()
    if not s:
        return None
    if s == CLAUDE_CODE or s.lower().startswith("claude code"):
        return CLAUDE_CODE
    m = re.match(r"(AI-\d)\b", s)
    return m.group(1) if m else s[:40]


def family_of(slot_id: str | None, name: str | None = None) -> str | None:
    """Which AI's limits apply: claude / chatgpt / gemini / claude_code, else None (an API that pays per use, a test
    AI …: no message limit Akọwe knows of)."""
    if slot_id == CLAUDE_CODE:
        return "claude_code"
    low = str(name or "").lower()
    if "(api)" in low:
        return None
    for fam in ("chatgpt", "claude", "gemini"):
        if fam in low:
            return fam
    return None


def _ai(key: str, name: str | None = None) -> dict:
    a = _STATE["ais"].get(key)
    if a is None:
        a = _STATE["ais"][key] = {"name": name or key, "answers": [], "days": {}, "hits": [], "failed": 0}
    if name and (a.get("name") in (None, key) or "·" in str(name)):
        a["name"] = str(name)[:80]
    return a


def _trim(a: dict, now: float) -> None:
    a["answers"] = [t for t in a.get("answers") or [] if now - t < KEEP_ANSWERS_S][-MAX_ANSWERS:]
    days = sorted((a.get("days") or {}).items())[-KEEP_DAYS:]
    a["days"] = dict(days)
    a["hits"] = (a.get("hits") or [])[-KEEP_HITS:]


def _dirty() -> None:
    _STORE["dirty"] = True


# ====================================================================== what happened (never raises)
def note_answer(slot_id: str | None, name: str | None = None, exc: BaseException | None = None,
                now: float | None = None) -> None:
    """One AI call ended (ai_activity listener): an answer is counted; a usage-limit failure is a limit hit."""
    try:
        key = _slot_of(slot_id or name)
        if not key:
            return
        now = _now() if now is None else now
        if exc is None:
            with _LOCK:
                a = _ai(key, name)
                a["answers"].append(now)
                d = _day(now)
                a["days"][d] = int(a["days"].get(d) or 0) + 1
                a["last_ok"] = now
                if a.get("limited_until") and a["limited_until"] > now:
                    a["limited_until"] = None  # it answered: whatever limit there was is over
                _trim(a, now)
                _dirty()
            return
        from . import usage_limits  # noqa: PLC0415
        problem = getattr(exc, "site_problem", None)
        if getattr(exc, "usage_limited", False) or usage_limits.is_limit_problem(problem):
            note_limit(key, name, getattr(exc, "reset_at", None), now=now)
        else:
            with _LOCK:
                _ai(key, name)["failed"] = int(_ai(key, name).get("failed") or 0) + 1
                _dirty()
    except Exception:  # noqa: BLE001 - a meter never breaks an AI call
        log.debug("usage meter could not count a call", exc_info=True)


def note_limit(slot_id: str | None, name: str | None = None, reset_at=None, now: float | None = None) -> None:
    """An AI hit its usage limit (``reset_at``: epoch seconds when it resets, if known)."""
    try:
        key = _slot_of(slot_id or name)
        if not key:
            return
        now = _now() if now is None else now
        reset = float(reset_at) if isinstance(reset_at, (int, float)) and reset_at > now - 60 else None
        with _LOCK:
            a = _ai(key, name)
            fam = family_of(key, a.get("name") or name)
            window = ASSUMED.get(fam, (5 * 3600, 0, ""))[0]
            hits = a.setdefault("hits", [])
            if hits and (now - hits[-1]["at"] < HIT_DEDUPE_S or float(a.get("limited_until") or 0) > now):
                if reset and not hits[-1].get("reset_at"):
                    hits[-1]["reset_at"] = reset
            else:
                used = sum(1 for t in a.get("answers") or [] if now - t < window)
                hits.append({"at": now, "reset_at": reset, "in_window": used})
            a["limited_until"] = reset or max(float(a.get("limited_until") or 0), now + LIMITED_FOR_S)
            _trim(a, now)
            _dirty()
    except Exception:  # noqa: BLE001
        log.debug("usage meter could not note a limit", exc_info=True)


def note_all_limited(names, reset_at=None) -> None:
    """usage_limits.note listener: every AI that could take a call is at its limit."""
    for n in names or []:
        note_limit(None, str(n), reset_at)


def reset_for_tests() -> None:
    with _LOCK:
        _STATE.clear()
        _STATE["ais"] = {}
        _STORE.update(store=None, dirty=False, saved=0.0)


# ====================================================================== storage
def attach(store) -> None:
    """Load what was saved (merged with what this process already counted) and save to this store from now on."""
    try:
        saved = store.get_setting(SETTING)
    except Exception:  # noqa: BLE001
        saved = None
    with _LOCK:
        _STORE["store"] = store
        if isinstance(saved, dict) and isinstance(saved.get("ais"), dict):
            for key, v in saved["ais"].items():
                if not isinstance(v, dict):
                    continue
                a = _ai(str(key)[:40], v.get("name"))
                a["answers"] = sorted(set(a["answers"]) | {float(t) for t in v.get("answers") or []
                                                           if isinstance(t, (int, float))})
                for d, n in (v.get("days") or {}).items():
                    if isinstance(n, int):
                        a["days"][d] = max(int(a["days"].get(d) or 0), n)
                old = [h for h in v.get("hits") or [] if isinstance(h, dict) and isinstance(h.get("at"), (int, float))]
                seen = {h["at"] for h in a["hits"]}
                a["hits"] = sorted(a["hits"] + [h for h in old if h["at"] not in seen], key=lambda h: h["at"])
                for k in ("limited_until", "last_ok"):
                    if isinstance(v.get(k), (int, float)) and not a.get(k):
                        a[k] = v[k]
                _trim(a, _now())


def save(force: bool = False) -> bool:
    store = _STORE.get("store")
    if store is None:
        return False
    with _LOCK:
        if not (_STORE["dirty"] or force) or (not force and _now() - _STORE["saved"] < SAVE_GAP_S):
            return False
        data = copy.deepcopy(_STATE)
        _STORE["dirty"] = False
        _STORE["saved"] = _now()
    try:
        store.set_setting(SETTING, data)
        return True
    except Exception:  # noqa: BLE001 - the meter is a convenience
        log.debug("usage meter could not be saved", exc_info=True)
        with _LOCK:
            _STORE["dirty"] = True
        return False


# ====================================================================== reading
def learned(family: str | None) -> int | None:
    """Answers an AI of this family gave in its window before it hit its limit on this computer (the smallest of the
    recent hits), or None when it never hit one."""
    if not family:
        return None
    vals = []
    with _LOCK:
        for key, a in _STATE["ais"].items():
            if family_of(key, a.get("name")) != family:
                continue
            vals += [int(h["in_window"]) for h in a.get("hits") or [] if int(h.get("in_window") or 0) >= 5]
    return min(vals[-3:]) if vals else None


def limit_of(family: str | None) -> dict | None:
    """{window_s, answers, learned, about} for a family (None: no known message limit)."""
    if family not in ASSUMED:
        return None
    window, n, about = ASSUMED[family]
    lv = learned(family)
    if lv:
        return {"window_s": window, "answers": lv, "learned": True,
                "about": f"{FAMILY_NAMES[family]} stopped after about {lv} answers in {_hours(window)} on this "
                         "computer before"}
    return {"window_s": window, "answers": n, "learned": False, "about": about}


def used(key: str, window_s: float, now: float | None = None) -> int:
    now = _now() if now is None else now
    with _LOCK:
        a = _STATE["ais"].get(key) or {}
        return sum(1 for t in a.get("answers") or [] if now - t < window_s)


def _hours(s: float) -> str:
    h = s / 3600
    return "a day" if h >= 23.5 else f"{h:.0f} hours"


def row(key: str, name: str | None, *, connected: bool = True, site: dict | None = None,
        now: float | None = None) -> dict:
    """One AI's meter: answers today and in its window, the last limit hit, the reset time and a colour."""
    now = _now() if now is None else now
    site = site or {}
    from . import usage_limits  # noqa: PLC0415
    if usage_limits.is_limit_problem(site.get("problem")):
        note_limit(key, name, site.get("reset_at"), now=now)
    with _LOCK:
        a = copy.deepcopy(_STATE["ais"].get(key) or {})
    name = name or a.get("name") or key
    fam = family_of(key, name)
    lim = limit_of(fam)
    today = int((a.get("days") or {}).get(_day(now)) or 0)
    in_window = sum(1 for t in a.get("answers") or [] if lim and now - t < lim["window_s"])
    hits = a.get("hits") or []
    last = hits[-1] if hits else None
    reset = None
    if last and last.get("reset_at") and last["reset_at"] > now:
        reset = last["reset_at"]
    elif last and lim and now - last["at"] < lim["window_s"]:
        reset = last["at"] + lim["window_s"]  # not given: about one window after the hit
    limited_until = float(a.get("limited_until") or 0)
    limited = limited_until > now and not (a.get("last_ok") and last and a["last_ok"] > last["at"])
    share = round(min(1.0, in_window / lim["answers"]), 2) if lim and lim["answers"] else None
    if not connected:
        colour = "grey"
    elif limited:
        colour = "red"
    elif (last and now - last["at"] < RECENT_HIT_S) or (share is not None and share >= 0.75):
        colour = "amber"
    else:
        colour = "green"
    parts = [f"used today: {today} answer{'' if today == 1 else 's'}"]
    if last:
        parts.append(f"last limit hit at {usage_limits.clock(last['at'])}")
    if reset:
        parts.append(f"resets ~{usage_limits.clock(reset)}" + ("" if last and last.get("reset_at") else " (a guess)"))
    word = {"red": "At its usage limit now", "amber": "Close to its limit, or hit one in the last day",
            "green": "Fine", "grey": "Not connected"}[colour]
    return {"key": key, "slot_id": None if key == CLAUDE_CODE else key, "name": name, "family": fam,
            "colour": colour, "word": word, "today": today, "in_window": in_window if lim else None,
            "window_s": lim["window_s"] if lim else None, "typical": lim["answers"] if lim else None,
            "typical_learned": bool(lim and lim["learned"]), "share": share,
            "last_hit_at": _iso(last["at"]) if last else None, "last_hit_epoch": last["at"] if last else None,
            "reset_at": _iso(reset), "reset_epoch": reset, "reset_known": bool(last and last.get("reset_at")),
            "limited": limited, "line": " · ".join(parts),
            "about": (lim["about"] if lim else "No message limit Akọwe knows of for this AI.")}


def meter(app, now: float | None = None) -> dict:
    """Every connected AI (plus the Claude Code helpers when they are switched on or were used)."""
    now = _now() if now is None else now
    rows = []
    prov = app.engine.providers
    try:
        slots = prov.ai_slots()
    except Exception:  # noqa: BLE001
        slots = []
    from .providers import slot_name  # noqa: PLC0415
    for s in slots:
        try:
            st = prov.slot_status(s)
        except Exception:  # noqa: BLE001 - a meter row without the site's view
            st = {"working": True}
        rows.append(row(s["slot_id"], slot_name(s), connected=bool(st.get("working", True)) or
                        bool(st.get("problem")), site=st, now=now))
    cc_on = False
    try:
        from . import claude_code as cc  # noqa: PLC0415
        cc_on = bool(cc.enabled(app.store) and (cc.cached_status() or {}).get("state") == "ready")
    except Exception:  # noqa: BLE001
        cc_on = False
    with _LOCK:
        cc_used = CLAUDE_CODE in _STATE["ais"]
    if cc_on or cc_used:
        rows.append(row(CLAUDE_CODE, "Claude Code helpers", connected=cc_on, now=now))
    save()
    return {"ais": rows, "at": _iso(now),
            "about": "The AI websites do not publish exact limits. This shows what Akọwe saw on this computer: how "
                     "many answers each AI gave, when it last said it hit its usage limit, and when that resets (a "
                     "guess when the site did not say). Numbers only."}


def _listen() -> None:
    from . import ai_activity, usage_limits  # noqa: PLC0415
    ai_activity.on_call_ended(lambda slot, ai, exc: note_answer(slot, ai, exc))
    usage_limits.on_note(note_all_limited)


_listen()
