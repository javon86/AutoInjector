"""🤖 AI-default story checks: the habits AI-written novels fall into, checked on the plan and on the finished book.

Why (docs: "AI novel quality beyond eight", recommendation 3): readers and editors who score AI novels at 7-8 name the
same few habits again and again — every subplot dropped, no choice that really costs the hero anything, a narrator
who spells out the theme, helpers who always agree, a villain who softens or apologises at the end, a calm
"everyone accepts it" ending, and a book told strictly in order with nothing withheld. Each habit is cheap to fix in
the plan and expensive once the chapters exist.

Where the checks go:

* **The plan** (🩺 story_doctor.py): every plan reviewer answers each ``PLAN`` check (passed + one concrete fix). A
  check that the reviewers fail becomes a fix of the doctor's revision note — first in the list — and two or more
  failed checks make the doctor revise the outline once even when its score already reaches the target.
* **The finished book** (🎯 ending_check.py, final check only): the ``DRAFT`` checks are added to the promises the
  ending check reads, with the same vote, fix and report as a setup that never paid off.

Plain data only; logs carry the check ids, never book text.
"""
from __future__ import annotations

# (id, plain label, the plan question, the finished-book question — None when it can only be judged on the plan)
CHECKS = (
    ("subplot", "A live subplot",
     "Is there at least one subplot with its own want and turns that runs through the middle and is resolved (not "
     "dropped) before or at the end?",
     "At least one subplot runs through the middle of the book and is resolved on the page (not dropped or summed "
     "up in a line)."),
    ("costly_choice", "A choice that costs something",
     "Does the main character face at least one choice between two things they value, where either answer costs "
     "them something real that the plan shows?",
     "The main character makes at least one choice on the page that costs them something they value, and the cost "
     "stays (it is not undone or waved away)."),
    ("theme_unstated", "The theme is shown, never stated",
     "Does the plan avoid a moment where the narrator or a character spells out the book's lesson or theme in so "
     "many words (a speech, a closing reflection, a moral)?",
     "Neither the narrator nor a character states the book's lesson or theme outright (no closing moral, no "
     "speech that explains what it all meant)."),
    ("allies_push_back", "Allies who push back",
     "Do the main character's allies have their own wants and at least once refuse, argue or act against the main "
     "character's plan (not only help and agree)?",
     "The main character's allies push back at least once — they refuse, argue or act on their own wants — instead "
     "of always helping and agreeing."),
    ("antagonist_conviction", "An antagonist with conviction",
     "Does the antagonist (or opposing force) keep their conviction to the end and are they right about something "
     "— no sudden apology, softening or explaining away?",
     "The antagonist keeps their conviction to the end and is shown to be right about something; they do not "
     "suddenly soften, apologise or explain themselves away."),
    ("ending_not_calm", "No calm, tidy acceptance",
     "Does the ending avoid a calm scene where everyone accepts what happened and every loose end is tied — does "
     "something stay hard, costly or unresolved?",
     "The ending is not a calm scene where everyone accepts what happened and every loose end is neatly tied: "
     "something stays hard, costly or open."),
    ("out_of_order", "Something withheld",
     "Does the plan withhold at least one important fact from the reader and reveal it later (an out-of-order "
     "reveal, a secret, a flashback that changes what came before)?",
     None),
)
IDS = tuple(c[0] for c in CHECKS)
LABELS = {c[0]: c[1] for c in CHECKS}
FORCE_REVISION = 2        # failed plan checks that make the doctor revise once even over its target

PLAN_TASK = (
    " ai_defaults: the habits AI-written books fall into (context.ai_default_checks). For EACH check give {check "
    "(its id), passed (true when the plan clearly avoids the habit), fix (when not passed: ONE concrete change to "
    "the plan — which chapter, what happens instead; empty when passed)}.")
DRAFT_TASK = (
    " Promises of kind ai_default are habits AI-written books fall into: kept is true when the book clearly avoids "
    "the habit as described; when not kept, the fix is one or two concrete sentences for the ending chapters that "
    "repair it with what the book already has.")

_S = {"type": "string"}
PLAN_SCHEMA_PART = {"type": "array", "maxItems": len(CHECKS), "items": {
    "type": "object", "additionalProperties": False, "required": ["check", "passed", "fix"],
    "properties": {"check": {"type": "string", "enum": list(IDS)}, "passed": {"type": "boolean"}, "fix": _S}}}


def plan_checks() -> list[dict]:
    """For the plan reviewers' context: [{check, label, question}]."""
    return [{"check": i, "label": label, "question": q} for i, label, q, _d in CHECKS]


def draft_items(start: int = 1) -> list[dict]:
    """For the final ending check: the finished-book checks as promises of kind ``ai_default``."""
    out = []
    for i, label, _q, d in CHECKS:
        if d:
            out.append({"id": f"a{start + len(out)}", "kind": "ai_default", "check": i, "label": f"{label}: {d}"})
    return out


def clean_answers(raw) -> list[dict]:
    """One reviewer's ai_defaults answer → [{check, passed, fix}] (known ids only, first answer per id)."""
    out, seen = [], set()
    for a in raw if isinstance(raw, list) else []:
        if not isinstance(a, dict) or a.get("check") not in IDS or a["check"] in seen \
                or not isinstance(a.get("passed"), bool):
            continue
        seen.add(a["check"])
        fix = " ".join(str(a.get("fix") or "").split())[:300]
        out.append({"check": a["check"], "passed": a["passed"], "fix": "" if a["passed"] else fix})
    return out


def failed(rows: list[dict]) -> list[dict]:
    """The plan checks the reviewers fail: a check fails when at least half of the reviewers who answered it say so
    (one reviewer: its answer). [{check, label, fix, by}] in the order of CHECKS."""
    out = []
    for cid in IDS:
        answers = [(r.get("name"), a) for r in rows for a in r.get("ai_defaults") or [] if a["check"] == cid]
        if not answers:
            continue
        no = [(n, a) for n, a in answers if not a["passed"]]
        if no and 2 * len(no) >= len(answers):
            fix = next((a["fix"] for _n, a in no if a["fix"]), "")
            out.append({"check": cid, "label": LABELS[cid], "fix": fix, "by": [n for n, _a in no if n]})
    return out
