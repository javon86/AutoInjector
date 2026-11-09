"""🔔 Every "needs you" alert, in plain words: what kind of issue, what it is about, what is wrong, why it stopped,
and what happens next.

Before, the desktop notification and Akọwe's banner only said "“<book>” needs your decision (step 3 of 19). Open
Akọwe to decide" — the author could not tell a character problem from a usage limit without opening everything.
Now a ⚡ Make-a-book run that waits for the author carries an ``alert`` (``AutoBookService.public``), the same one
for Akọwe's run window, the status push to AutoInjector (its notification, its Akọwe-tab line) and Alfred:

    {"category": "character", "icon": "🧑", "label": "Character issue",
     "what": "Ansel Marrant (character)",
     "wrong": "His background has a timeline contradiction: …",
     "why": "The reviewer and the writer disagreed twice about the same thing, so it needs you.",
     "next": "Pick one: accept the change, keep the original, or edit it yourself. The book carries on after you choose.",
     "choices": [{"action": "accept_change", "label": "✔ Accept change"}, …],
     "change": {"field", "before", "after"} | null, "key": "…", "code": "REVIEW_DECISION"}

The category comes from where the stop came from — the problem's code, the record kind (module), the run step — never
from asking an AI (``category_of``). The fixed list is ``CATEGORIES``. ``what`` / ``wrong`` may quote a few words of
the author's own book (shown to the author only); logs keep codes only.
"""
from __future__ import annotations

import re

from .review_loop import CHOICE_WORDS, NEG, clip

# The fixed list (order = how the docs list them).
CATEGORIES = {
    "character": ("🧑", "Character issue"),
    "continuity": ("🔗", "Story continuity"),
    "timeline": ("⏳", "Timeline"),
    "place": ("📍", "Place / world rule"),
    "item": ("📦", "Item"),
    "story_map": ("🗺", "Story map connection"),
    "chapter": ("📖", "Chapter quality"),
    "plot": ("🧭", "Plot / outline"),
    "style": ("✍", "Style / sounds like AI"),
    "approval": ("✔", "Approval needed"),
    "picture": ("🎨", "Picture"),
    "paused": ("⏸", "Paused by you"),
    "ai": ("⚠", "AI problem"),
}
# record kind (module) -> category
MODULE_CAT = {"A01": "character", "A02": "place", "A03": "place", "A04": "place", "A05": "place", "A06": "place",
              "A07": "place", "A08": "place", "A09": "place", "A10": "place", "A11": "item", "A12": "item",
              "A13": "timeline", "A14": "timeline", "B01": "plot", "B03": "plot", "B05": "plot", "B11": "plot",
              "C02": "chapter"}
# record kind -> the word after a name: "Ansel Marrant (character)"
KIND_WORD = {"A01": "character", "A02": "species", "A03": "world", "A04": "place", "A05": "government",
             "A06": "group", "A07": "culture", "A08": "religion", "A09": "magic", "A10": "technology",
             "A11": "weapon", "A12": "item", "A13": "history", "A14": "timeline"}
# run step -> category (when the problem names no record)
STEP_CAT = {"canon": "character", "characters": "character", "looks": "character", "pictures": "picture",
            "world": "place", "premise": "plot", "plot": "plot", "outline": "plot", "bible": "character",
            "chapters": "chapter", "planned": "chapter", "report": "chapter", "beta": "chapter", "human": "style"}
AI_CODES = {"TIMEOUT", "UPSTREAM_UNAVAILABLE", "RATE_LIMITED", "CAPABILITY_UNAVAILABLE", "USAGE_LIMIT", "SITE_BUSY",
            "SITE_NOT_READY", "NETWORK", "INTERNAL_ERROR", "LOGGED_OUT", "CAPTCHA", "AI_REFUSED"}
TRUST_CODES = {"NO_SECOND_AI", "NO_REASON", "LOW_CONFIDENCE"}
# words in a problem CODE (never in the book text) -> category
CODE_CAT = (("TIMELINE", "timeline"), ("STORY_MAP", "story_map"), ("MAP_LINK", "story_map"),
            ("CHECKPOINT", "continuity"), ("CONTINUITY", "continuity"), ("PHYSICAL", "continuity"),
            ("HUMAN", "style"), ("ORIGINALITY", "style"), ("STYLE", "style"), ("AI_TELL", "style"),
            ("PICTURE", "picture"), ("IMAGE", "picture"), ("PORTRAIT", "picture"))

WHY = {
    "REVIEW_NOT_PASSED": "The AI reviewer still asked for changes after two fixes, so it needs you.",
    "CHECKS_REFUSED": "Akọwe's own checks refused it, and the AI could not make one that passes.",
    "PROTAGONIST_MISSING": "Akọwe's own checks refused it: the main character is missing.",
    "NO_SECOND_AI": "Only one AI is working, so no other AI could check it.",
    "NO_REASON": "The reviewer said OK without giving a reason, so that OK does not count.",
    "LOW_CONFIDENCE": "The reviewer was not sure enough for its OK to count.",
    "CHECKPOINT_WAITING": "A story check found something it could not fix safely by itself.",
}


def chapter_words(cid) -> str:
    m = re.search(r"(\d+)\D*$", str(cid or ""))
    return f"Chapter {int(m.group(1))}" if m else f"Chapter {cid}"


def category_of(run: dict, state: str) -> str:
    """The category from the stop's SOURCE: who paused, the problem's code, the record kind, the step."""
    prob = run.get("problem") or {}
    code = str(prob.get("code") or "")
    if state == "paused" or (run.get("status") == "paused" and run.get("pause_reason") == "author"):
        return "paused"
    if state == "interrupted":
        return "ai"
    if code in TRUST_CODES:
        return "approval"
    if code in AI_CODES or code.startswith("HTTP_"):
        return "ai"
    for word, cat in CODE_CAT:
        if word in code:
            return cat
    mod = str(prob.get("module_id") or (prob.get("where") or {}).get("op") or "")
    if prob.get("chapter_id") and mod in ("", "C01", "C02"):
        return "chapter"
    if mod in MODULE_CAT:
        return MODULE_CAT[mod]
    step = str(prob.get("step") or run.get("current") or "")
    if step in STEP_CAT:
        return STEP_CAT[step]
    return "approval" if prob.get("options") else "ai"


def _first_problem(prob: dict) -> str:
    reasons = [str(x) for x in prob.get("reasons") or [] if str(x).strip()]
    neg = [r for r in reasons if NEG.search(r)]
    if neg or reasons:
        return (neg or reasons)[0]
    det = [str(x) for x in prob.get("details") or [] if str(x).strip()]
    return det[0] if det else str(prob.get("message") or "")


def describe(run: dict, state: str) -> dict | None:
    """The alert for a run that waits for the author (None while it works or once it is finished)."""
    if state not in ("paused", "needs_decision", "problem", "interrupted"):
        return None
    prob = run.get("problem") or {}
    code = str(prob.get("code") or "")
    cat = category_of(run, state)
    icon, label = CATEGORIES[cat]
    step_title = (prob.get("where") or {}).get("step") or ""
    what = prob.get("subject") or (chapter_words(prob["chapter_id"]) if prob.get("chapter_id") else "") \
        or step_title or "the book"
    dec = prob.get("decision") if isinstance(prob.get("decision"), dict) else None
    opts = [o for o in prob.get("options") or [] if isinstance(o, str)]
    change = None
    if cat == "paused":
        wrong, why = "Nothing is wrong.", "You pressed Pause."
        nxt, opts = "Press ▶ Resume when you are ready. The book carries on from where it stopped.", ["resume"]
    elif state == "interrupted":
        wrong, why = "Nothing is lost.", "Akọwe was closed while it worked."
        nxt, opts = "Press ▶ Resume to carry on from where it stopped.", ["resume"]
    elif dec:
        change = dec.get("change")
        wrong, why = dec.get("wrong") or prob.get("message") or "", dec.get("stop") or ""
        nxt = (f"Pick one: accept the change, keep the original, or edit it yourself. The book carries on after you "
               f"choose; until then {what} is not approved.") if "keep_original" in opts else \
            (f"Pick one: accept the change, or edit it yourself. The book carries on after you choose; until then "
             f"{what} is not approved.")
    elif cat == "ai":
        wrong = str(prob.get("message") or "The AI could not answer.")
        why = "The AI could not do this step (a usage limit, the connection or an error)."
        nxt = "Press 🔁 Try again (connect or switch an AI first if it says so). Nothing written so far is lost."
    else:
        wrong = _first_problem(prob)
        why = WHY.get(code) or "This step stopped on a problem."
        if code in TRUST_CODES:
            nxt = "Pick one: approve it yourself, or let the AI try again. The book carries on after you choose."
        elif {"approve_anyway", "edit"} <= set(opts):
            nxt = ("Pick one: approve it anyway, edit it yourself, or let the AI try again. The book carries on after "
                   "you choose.")
        elif code == "CHECKPOINT_WAITING":
            nxt = "Read it on the 🧭 Continuity page, fix it if you agree, then press ▶ Continue."
        else:
            nxt = "Press 🔁 Try again, or edit it yourself and then continue."
    opts = opts or ["retry"]  # every stop can at least be tried again (the run window's 🔁 Try again)
    choices = [{"action": o, "label": CHOICE_WORDS.get(o, "▶ Resume" if o == "resume" else o)} for o in opts]
    if "edit" in opts:
        choices.append({"action": "edited", "label": "▶ I edited it — continue"})
    return {"category": cat, "icon": icon, "label": label, "what": clip(what, 80), "wrong": clip(wrong, 220),
            "why": clip(why, 160), "next": clip(nxt, 220), "choices": choices, "change": change, "code": code or None,
            "key": f"{cat}:{code or state}:{prob.get('record_id') or prob.get('step') or ''}"
                   f":{prob.get('version') or ''}"}


def with_stand_in(alert: dict, view: dict | None) -> dict:
    """🧑‍⚖️ The alert mentions the stand-in decider (stand_in.py): when it steps in if the author does not answer, why
    it does not (only the author may decide this one, it was unsure …), and the last decision it made in this run."""
    if not alert or not view:
        return alert
    out = dict(alert)
    pend = view.get("pending") or {}
    if pend.get("state") in ("waiting", "waits", "cap") and pend.get("words"):
        out["next"] = clip(f"{out.get('next') or ''} {pend['words']}".strip(), 320)
        out["stand_in_words"] = clip(pend["words"], 220)
    last = next((d for d in reversed(view.get("decisions") or []) if not d.get("undone")), None)
    if last:
        out["stand_in"] = {"line": clip(last.get("line"), 300), "id": last.get("id")}
    return out
