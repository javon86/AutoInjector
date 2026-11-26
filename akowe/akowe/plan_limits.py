"""📏 Size limits for the story plan (Set B records: premise, main plot, outline …).

Every later planning and writing step carries the approved premise, main plot and plot obligations as context it
cannot leave out. A plan record that is absurdly large (a 2 MB premise, 500 plot obligations, a 1 MB summary) would
be approved and then make every later step stop with "the context is too large" — and ▶ Resume could never get past
it. So Akọwe's own checks refuse such a record before it is reviewed or approved: an AI draft is written again (told
what was too big), the author's own edit is kept and handed back to them to shorten.

The limits are generous for a real book (a premise is a few paragraphs, a novel has a few dozen plot obligations);
they only catch sizes no later step could read. No AI here; pure functions.
"""
from __future__ import annotations

import json

RULE = "PLAN_TOO_LARGE"

# one text field anywhere in a plan record (chapter objectives, fact values, summaries …)
MAX_TEXT = 20_000
# the whole record, as stored (JSON characters)
MAX_RECORD = 300_000
# the fields every later step carries: tighter limits (characters)
FIELD_MAX = {
    "B01": {"premise": 4_000, "dramatic_question": 1_000, "concept_summary": 4_000},
}
# lists of short items: (most items, longest item)
LIST_MAX = {
    "B03": {"plot_obligations": (40, 500), "objectives": (40, 1_000)},
}
SUMMARY_MAX = {"B03": 12_000}  # main_plot.summary

LABELS = {"premise": "premise", "dramatic_question": "dramatic question", "concept_summary": "concept summary",
          "plot_obligations": "list of plot obligations", "objectives": "list of objectives",
          "summary": "main plot summary"}


def _n(x: int) -> str:
    return f"{x:,}".replace(",", " ")


def _label(key: str) -> str:
    return LABELS.get(key, key.replace("_", " "))


def _longest_text(o, depth: int = 0) -> int:
    """The length of the longest string anywhere in ``o`` (bounded depth: plan records are shallow)."""
    if isinstance(o, str):
        return len(o)
    if depth > 12:
        return 0
    if isinstance(o, dict):
        return max((_longest_text(v, depth + 1) for v in o.values()), default=0)
    if isinstance(o, list):
        return max((_longest_text(v, depth + 1) for v in o), default=0)
    return 0


def problems(op_id: str, data) -> list[str]:
    """Plain-words problems with the size of one plan record ([] = fine). Never raises."""
    if not isinstance(data, dict):
        return []
    out: list[str] = []
    try:
        for key, most in (FIELD_MAX.get(op_id) or {}).items():
            v = data.get(key)
            if isinstance(v, str) and len(v) > most:
                out.append(f"the {_label(key)} is far too long ({_n(len(v))} characters; at most {_n(most)}): "
                           "write it shorter")
        for key, (count, each) in (LIST_MAX.get(op_id) or {}).items():
            v = data.get(key)
            if not isinstance(v, list):
                continue
            if len(v) > count:
                out.append(f"the {_label(key)} is far too long ({_n(len(v))} items; at most {_n(count)}): keep the "
                           "ones that matter most")
            longest = max((len(x) for x in v if isinstance(x, str)), default=0)
            if longest > each:
                out.append(f"one item in the {_label(key)} is far too long ({_n(longest)} characters; at most "
                           f"{_n(each)}): write it shorter")
        if op_id in SUMMARY_MAX:
            mp = data.get("main_plot")
            s = mp.get("summary") if isinstance(mp, dict) else None
            if isinstance(s, str) and len(s) > SUMMARY_MAX[op_id]:
                out.append(f"the {_label('summary')} is far too long ({_n(len(s))} characters; at most "
                           f"{_n(SUMMARY_MAX[op_id])}): write it shorter")
        if not out:
            longest = _longest_text(data)
            if longest > MAX_TEXT:
                out.append(f"one part of it is far too long ({_n(longest)} characters; at most {_n(MAX_TEXT)}): "
                           "write it shorter")
        if not out:
            size = len(json.dumps(data, ensure_ascii=False))
            if size > MAX_RECORD:
                out.append(f"it is far too large as a whole ({_n(size)} characters; at most {_n(MAX_RECORD)}): "
                           "the later steps could not read it — make it shorter")
    except Exception:  # noqa: BLE001 - a size check never breaks the step it guards
        return []
    return out


def check(op_id: str, data, add) -> None:
    """Add one blocking finding per size problem (``add(rule, message, severity, decision)`` from set_b)."""
    for msg in problems(op_id, data):
        add(RULE, msg + " — later steps carry it in full and could not read it", "BLOCKING", "FAIL")


PLAIN_MESSAGE = ("It is far too long for the later steps to read (Akọwe's size limit for the story plan). Press 🔁 Try "
                 "again for a shorter one, or ✏️ Edit it shorter.")
