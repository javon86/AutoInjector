"""🩺 P37.5 "ChatGPT isn't working — here's why and how to fix it", before a book run starts and while it runs.

Before a Make-a-book run (⚡ Make a book for me, a pipeline variant, 🔁 rerun from a book bible, ▶ continue a book) or
✍ Write all chapters starts, the page asks ``GET /api/ai-check`` (``check``): BookForge reads the AutoInjector bridge's
``/v1/health`` (contract v1.2, fresh, not the 15-second cache) for EVERY AI slot the run may use — a run uses all
working AIs for reviewing, even when one AI is picked to write. Each AI that is not ``ok`` comes back with plain words:
which AI, what is wrong (the bridge state ``repairing`` / ``needs_user`` / ``broken`` / ``unknown`` and AutoInjector's
classifier code such as ``LOGGED_OUT``, ``CAPTCHA``, ``USAGE_LIMIT``, ``NETWORK_ERROR``) and how to fix it. The page
then offers 🔁 I fixed it — check again (``POST /api/ai-check`` with ``probe: true``: AutoInjector sends each AI a
check-in first, bridge ``/v1/probe``), ▶ Start without it, or ✖ Cancel.

"Start without it" sends ``ai_check: {"skipped": [slot ids]}`` with the start request; the run records the choice and
says in its window which AIs take over (``start_note``). BookForge does not lock the skipped AI out: when it starts
working during the run, it is used again (also said). A run started without the check (an older page, the API) still
shows every AI that is not working at its start as a ⚠️ notice — no AI ever sits out silently — and an AI that stops
working DURING the run gets a visible notice in the run window too (``alert_rows``), cleared when it works again.

The bridge gives only states and codes (never free text from the site); every sentence here is BookForge's own.
"""
from __future__ import annotations

import logging

from . import providers as providers_mod

log = logging.getLogger("bookforge.ai_check")

FIX_NUMBER = "open AutoInjector and press 🔢 Fix with a number on {ai}'s card (or 🎯 to point at the part that moved)"

# AutoInjector's classifier codes (desktop-app/self-repair.js) -> (what is wrong, how to fix it)
PROBLEM_WORDS = {
    "LOGGED_OUT": ("{ai} is logged out.",
                   ["Open {ai}'s window in AutoInjector and log in.",
                    "AutoInjector notices when you are back; then press 🔁 Check again here."]),
    "CAPTCHA": ("{ai} is showing an “are you a human?” check.",
                ["Open {ai}'s window in AutoInjector and complete the check (tick the box or solve the puzzle).",
                 "Then press 🔁 Check again here."]),
    "USAGE_LIMIT": ("{ai} says you have reached its usage limit.",
                    ["Wait until the time {ai} shows in its window, or switch to another account or plan.",
                     "Or start without it: your other AIs do its work."]),
    "NETWORK_ERROR": ("{ai}'s page did not load (no internet, or the site is down).",
                      ["Check your internet connection.", "In AutoInjector, reload {ai}'s window.",
                       "Then press 🔁 Check again here."]),
    "PAGE_ERROR": ("{ai}'s page shows an error (“something went wrong”).",
                   ["In AutoInjector, reload {ai}'s window.", "Then press 🔁 Check again here."]),
    "TYPE_FAILED": ("AutoInjector can't find or type into {ai}'s message box.",
                    ["To fix it, " + FIX_NUMBER + ".", "Then press 🔁 Check again here."]),
    "SEND_NOT_CONFIRMED": ("AutoInjector typed into {ai}, but the message did not go out (the Send button may have "
                           "moved).", ["To fix it, " + FIX_NUMBER + ".", "Then press 🔁 Check again here."]),
    "NO_REPLY_FOUND": ("{ai} answers, but AutoInjector can't find its replies on the page.",
                       ["To fix it, " + FIX_NUMBER + ".", "Then press 🔁 Check again here."]),
    "FALSE_DUPLICATE": ("{ai}'s new replies are mistaken for old ones.",
                        ["To fix it, " + FIX_NUMBER + ".", "Then press 🔁 Check again here."]),
    "STUCK_GENERATING": ("{ai} seems stuck — it keeps “writing” and never finishes.",
                         ["In AutoInjector, press Stop in {ai}'s window or reload it.",
                          "Then press 🔁 Check again here."]),
    "UNKNOWN": ("{ai} did not answer AutoInjector's check-in and AutoInjector could not tell why.",
                ["Look at {ai}'s window in AutoInjector (logged in? a pop-up in the way?).",
                 "If it looks fine, " + FIX_NUMBER + ".", "Then press 🔁 Check again here."]),
}
# Bridge states without a classifier code
STATE_WORDS = {
    "repairing": ("AutoInjector is repairing {ai} right now.",
                  ["Wait a minute: AutoInjector usually fixes this by itself. Then press 🔁 Check again.",
                   "If it stays like this, " + FIX_NUMBER + "."]),
    "needs_user": ("{ai} needs you in AutoInjector.",
                   ["Open AutoInjector and look at {ai}'s card (⚠️ Needs you): it says what to do.",
                    "Then press 🔁 Check again here."]),
    "broken": ("{ai} isn't working and AutoInjector could not repair it by itself.",
               ["To fix it, " + FIX_NUMBER + ".", "Then press 🔁 Check again here."]),
    "unknown": ("AutoInjector has not checked {ai} yet.",
                ["Press 🔁 Check again: BookForge asks AutoInjector to check {ai} now (takes up to a minute)."]),
}
# Why a slot could not be read at all (slot_status "source")
SOURCE_WORDS = {
    "not_connected": ("{ai} is not connected to BookForge.",
                      ["Open ⚙️ Settings › AI, connect AutoInjector (pairing code) and press Test connection.",
                       "Then press 🔁 Check again here."]),
    "bridge_error": ("BookForge can't reach the AutoInjector app, so it can't use {ai}.",
                     ["Start the AutoInjector desktop app (or check that it is still running).",
                      "Then press 🔁 Check again here."]),
}
STATE_TITLES = {"repairing": "being repaired", "needs_user": "needs you", "broken": "not working",
                "unknown": "not checked yet"}


def ai_word(st: dict) -> str:
    """The AI's plain name: "ChatGPT", "Claude (API)", or the slot id."""
    site = st.get("site")
    if st.get("adapter_id") == "autoinjector" and site:
        return providers_mod.SITE_NAMES.get(site, site)
    if st.get("adapter_id") == "anthropic":
        return "Claude (API)"
    return str(st.get("name") or st.get("slot_id") or "An AI")


def is_ok(st: dict) -> bool:
    """Working for a run: state ok, or an older bridge (v1.0/1.1) that cannot report a state but did not fail."""
    if st.get("state") == "ok":
        return True
    return st.get("state") == "unknown" and st.get("source") in ("bridge_v1", "none", "test")


def describe(st: dict) -> dict:
    """One slot_status row (providers.slot_status) -> {slot_id, ai, name, ok, state, problem, title, what, fix}."""
    ai = ai_word(st)
    state, problem, source = st.get("state") or "unknown", st.get("problem"), st.get("source")
    row = {"slot_id": st.get("slot_id"), "ai": ai, "name": st.get("name") or ai, "state": state,
           "problem": problem, "ok": is_ok(st), "source": source}
    if row["ok"]:
        return dict(row, title=f"{ai} works", what=None, fix=[])
    if state == "unknown" and source in SOURCE_WORDS:
        what, fix = SOURCE_WORDS[source]
        title = f"{ai} can't be reached"
    elif problem in PROBLEM_WORDS:
        what, fix = PROBLEM_WORDS[problem]
        title = f"{ai} isn't working — {STATE_TITLES.get(state, state)}"
    else:
        what, fix = STATE_WORDS.get(state, STATE_WORDS["broken"])
        title = f"{ai} isn't working — {STATE_TITLES.get(state, state)}"
    fmt = {"ai": ai}
    return dict(row, title=title, what=what.format(**fmt), fix=[f.format(**fmt) for f in fix])


def check(prov, *, pinned: str | None = None, probe: bool = False, timeout_s: float = 45.0,
          poll_s: float | None = None) -> dict:
    """Which of the AIs a run will use work right now. ``probe``: ask AutoInjector to check in with each AI first
    (bridge /v1/probe, waits up to ``timeout_s``). Never raises for bridge problems."""
    slots = prov.ai_slots()
    if probe:
        statuses = prov.probe_and_wait(timeout_s=timeout_s, poll_s=poll_s or providers_mod.PROBE_POLL_S)
    else:
        prov.health.forget_bridges()  # a fresh /v1/health, not the 15-second cache
        statuses = [prov.slot_status(s, fresh=True) for s in slots]
    rows = [describe(st) for st in statuses]
    bad = [r for r in rows if not r["ok"]]
    good = [r for r in rows if r["ok"]]
    pin = next((r for r in rows if r["slot_id"] == pinned), None) if pinned else None
    out = {"ok": not bad and bool(rows), "ais": rows, "working": [r["ai"] for r in good],
           "not_working": [r["ai"] for r in bad], "any_working": bool(good), "pinned": pinned,
           "pinned_ok": pin["ok"] if pin else None, "probed": bool(probe),
           "if_skipped": start_note([r["ai"] for r in bad], [r["ai"] for r in good])}
    if pin and not pin["ok"] and good:
        out["if_skipped"] += (f" You picked {pin['ai']} to write: without it, the best working AI writes instead "
                              "(Automatic).")
    if not rows:
        out["message"] = "No AI is connected. Open ⚙️ Settings › AI and connect AutoInjector or add an API key."
    elif not bad:
        out["message"] = "All your AIs work: " + ", ".join(out["working"]) + "."
    elif not good:
        out["message"] = ("None of your AIs works right now (" + ", ".join(out["not_working"]) + "). Fix at least one "
                          "of them, then check again — a book cannot be made without an AI.")
    else:
        out["message"] = (" and ".join(out["not_working"]) + (" isn't" if len(bad) == 1 else " aren't")
                          + " working. " + start_note(out["not_working"], out["working"]))
    return out


def start_note(skipped: list[str], working: list[str]) -> str:
    """What "Start without it" means, in one sentence the run window repeats."""
    if not skipped:
        return ""
    if not working:
        return "No other AI works, so the run would wait for one."
    who = " and ".join(working)
    lone = len(working) == 1
    return (f"Without {' and '.join(skipped)}, {who} {'does' if lone else 'do'} all the work — writing, reviewing and "
            "editing" + (" (one AI then reviews its own writing ⚠️)" if lone else "") + ". If "
            + ("it starts" if len(skipped) == 1 else "they start") + " working during the run, BookForge uses "
            + ("it" if len(skipped) == 1 else "them") + " again.")


def clean_choice(v, slot_ids) -> dict | None:
    """The page's ``ai_check`` part of a start request: {"skipped": [slot ids]} (unknown ids dropped)."""
    if v in (None, "", {}):
        return None
    if not isinstance(v, dict):
        return None
    sk = v.get("skipped") or []
    if not isinstance(sk, list):
        return None
    return {"skipped": [s for s in sk if isinstance(s, str) and s in slot_ids][:3], "checked": True}


def alert_rows(rows: list[dict], previous: list | None, skipped=()) -> tuple[list[dict], list[dict], list[dict]]:
    """The run window's AI notices from its "which AIs work" rows (autobook._Runner._ai_row): returns
    (alerts now, newly broken, working again). ``skipped``: slots the author chose to start without."""
    prev = {a.get("slot_id"): a for a in previous or []}
    now, new, back = [], [], []
    for r in rows:
        sid = r.get("slot_id")
        if r.get("state") in providers_mod.UNAVAILABLE_STATES:
            name = str(r.get("name") or sid or "An AI").split(" · ")[-1]  # "AI-2 · ChatGPT" -> "ChatGPT"
            d = describe({"slot_id": sid, "name": name, "state": r.get("state"), "problem": r.get("problem"),
                          "source": "bridge"})
            d["chosen"] = sid in skipped
            d["since"] = (prev.get(sid) or {}).get("since") or r.get("at")
            now.append(d)
            if sid not in prev:
                new.append(d)
    ids = {a["slot_id"] for a in now}
    back = [a for sid, a in prev.items() if sid not in ids]
    return now, new, back
