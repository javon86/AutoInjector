"""BACK BURNER (parked 2026-11-08 by the user's request): not loaded by the app; see docs/AKOWE_IMPROVEMENT_PLAN.md back-burner list.

A deterministic fake AI for 📥 Bring in my book and 📝 Fix it with my notes (tests and the UI test server).

It answers by the shape of the requested schema: the continuity tracker (``tracked_scenes`` + the chapter's ``story``
part with names, people, relationships, time and story-map links), the character reading of book_import
(``fields``: value + quote), the story rules, the continue plan, the notes mapping (``mappings``), the revisions
(``changes``) and the independent check (``problems``). ``malformed`` makes every answer junk of the right top-level
shape (wrong types, quotes that are not in the text) so the cleaners are tested; ``fail`` is a list of error codes
raised before answering, one per call. Every call is recorded (kind, slot) in ``calls``.
"""
from __future__ import annotations

import copy
import json
import re
import threading

from akowe.errors import AkoweError

BOOK = [
    ("Chapter One: The Fog",
     ["Mara Vell climbed the hundred steps of the lighthouse at Gullhaven. Her green eyes stung in the salt wind.",
      "\"Who is there?\" called Tom Reed, her uncle, from the lamp room.",
      "* * *",
      "Mara found the brass locket on the top step, still warm."]),
    ("Chapter Two: The Harbour",
     ["Down in Gullhaven the boats knocked together. Mara asked Nessa Crane about the night the light went dark.",
      "Nessa only whispered that the keeper had gone out to the reef with a stranger."]),
    ("Chapter Three: The Reef",
     ["At low tide Mara walked out to the reef with the brass locket in her fist.",
      "She dreamed of drowned keepers that night, a long dream of lamps under water.",
      "In the morning she lit the great lamp, and Tom Reed wept."]),
]


def book_text(headings=True) -> str:
    out = []
    for title, paras in BOOK:
        if headings:
            out.append(title)
        out.extend(paras)
    return "\n\n".join(out)


class ImportFake:
    def __init__(self):
        self.calls: list[dict] = []
        self.lock = threading.Lock()
        self.malformed = False
        self.fail: list[str] = []
        self.fail_kind: dict[str, list] = {}
        self.details: dict[str, dict] = {
            "Mara Vell": {"eyes": {"value": "Green.", "quote": "Her green eyes stung in the salt wind."},
                          "hair": {"value": "Dark, probably.", "quote": "this quote is not in the book at all"},
                          "relationship_1": {"value": "Tom Reed — her uncle.",
                                             "quote": "called Tom Reed, her uncle, from the lamp room"},
                          "wants": {"value": "To find out why the light went dark.", "quote": ""},
                          "not_a_field": {"value": "x", "quote": ""}},
        }
        self.revise_script: list = []
        self.check_problems: list = []
        self.map_answer = None

    def submit(self, slot, system, user, schema):
        package = json.loads(user.split("\n", 1)[1])
        ctx = package.get("context") or {}
        props = schema.get("properties") or {}
        kind = self._kind(ctx, props)
        with self.lock:
            self.calls.append({"slot": slot["slot_id"], "kind": kind})
            if self.fail:
                raise AkoweError(self.fail.pop(0), "", "fake failure")
            if self.fail_kind.get(kind):
                raise AkoweError(self.fail_kind[kind].pop(0), "", "fake failure")
        out = self._junk(kind) if self.malformed else getattr(self, f"_a_{kind}", lambda c: {})(ctx)
        return out, {"model": "fake-import-model", "input_tokens": 10, "output_tokens": 20}

    def _kind(self, ctx, props) -> str:
        if "tracked_scenes" in props:
            return "track"
        if "fields" in props and "passages" in ctx:
            return "details"
        if "rules" in props:
            return "rules"
        if "chapters" in props and "how_many" in ctx:
            return "plan"
        if "mappings" in props:
            return "map"
        if "changes" in props:
            return "revise"
        if "problems" in props and "revised_text" in ctx:
            return "check"
        if "events" in props:
            return "events"
        return "other"

    def _junk(self, kind):
        return {"track": {"tracked_scenes": "nope", "story": {"names": [{"name": 7, "kind": "alien"}, "x"],
                                                              "people": "no", "links": [{"from": ""}]}},
                "details": {"fields": {"eyes": {"value": 42, "quote": None}, "hair": "a string, not an object",
                                       "face": {"value": "x" * 5000, "quote": ""}, "zzz": None}},
                "rules": {"rules": "none", "notes": 3},
                "plan": {"chapters": [{"title": 3}, "x", {"objective": ""}]},
                "map": {"mappings": [{"note": "n99", "chapters": ["x"]}, {"note": "n1", "chapters": [999],
                                                                          "passages": [{"chapter": 1, "quote": "not in it"}]}]},
                "revise": {"changes": [{"original": "this text is not in the chapter", "replacement": "x",
                                        "why": "", "conflict": ""}, {"original": 5}, "junk"]},
                "check": {"problems": [{"change": "zz", "problem": 4}, "x"]},
                "events": {"events": []}}.get(kind, {})

    # ------------------------------------------------------------------ answers
    def _a_events(self, ctx):
        return {"events": []}

    def _a_track(self, ctx):
        text = ctx.get("chapter_text") or ""
        names = []
        for nm, kind in (("Mara Vell", "person"), ("Tom Reed", "person"), ("Nessa Crane", "person"),
                         ("Gullhaven", "place"), ("brass locket", "thing")):
            if nm.split()[0] in text or nm in text:
                names.append({"name": nm, "kind": kind})
        people = [{"name": n["name"], "status": "alive", "where": "Gullhaven", "injuries": [], "items_gained": [],
                   "items_lost": [], "carrying": [], "magic_cost": ""} for n in names if n["kind"] == "person"]
        links = []
        m = re.search(r"called Tom Reed, her uncle, from the lamp room", text)
        if m:
            links.append({"from": "Mara Vell", "to": "Tom Reed", "kind": "family", "note": "her uncle",
                          "change": "new", "on_page": True, "quote": m.group(0)})
        num = (ctx.get("chapter") or {}).get("number") or 1
        return {"tracked_scenes": [], "story": {
            "summary": [f"Chapter {num} happens."], "people": people, "names": names,
            "time": {"day": f"day {num}", "date": "", "season": "autumn", "since_previous": "the next day"},
            "trips": [], "knowledge": [], "relationships": [{"a": "Mara Vell", "b": "Tom Reed", "line": "uncle"}]
            if "Tom" in text else [], "numbers": [], "links": links}}

    def _a_details(self, ctx):
        return {"fields": copy.deepcopy(self.details.get(ctx.get("character"), {}))}

    def _a_rules(self, ctx):
        return {"rules": [{"id": "", "category": "hard_rule", "text": "The great lamp is lit only from the lamp room.",
                           "scope": "only at the Gullhaven light", "source": "chapter 3", "stated_by": "the narrator"},
                          {"id": "", "category": "belief", "text": "Harbour folk believe drowned keepers guide boats.",
                           "scope": "a belief; never confirmed", "source": "chapter 3", "stated_by": "Mara Vell"}],
                "notes": []}

    def _a_plan(self, ctx):
        k = int(ctx.get("how_many") or 1)
        start = int(ctx.get("from") or 1)
        return {"chapters": [{"title": f"New {start + i}", "objective": f"Mara follows the locket's trail ({i + 1})."}
                             for i in range(k)]}

    def _a_map(self, ctx):
        if self.map_answer is not None:
            return copy.deepcopy(self.map_answer)
        out = []
        for n in ctx.get("notes") or []:
            t = n["text"].lower()
            if "dream" in t:
                out.append({"note": n["id"], "chapters": [3], "passages": [
                    {"chapter": 3, "quote": "She dreamed of drowned keepers that night"}], "why": "the dream"})
            elif "angrier" in t:
                out.append({"note": n["id"], "chapters": [2], "passages": [
                    {"chapter": 2, "quote": "made-up quote that is not in the chapter"}], "why": "the harbour"})
            else:
                out.append({"note": n["id"], "chapters": n.get("guess") or [1], "passages": [], "why": "guess"})
        return {"mappings": out}

    def _a_revise(self, ctx):
        if self.revise_script:
            s = self.revise_script.pop(0)
            return s(ctx) if callable(s) else copy.deepcopy(s)
        text = ctx.get("chapter_text") or ""
        note = (ctx.get("note") or "").lower()
        if "dream" in note and "She dreamed" in text:
            return {"changes": [{"original": "She dreamed of drowned keepers that night, a long dream of lamps under "
                                             "water.", "replacement": "", "why": "the dream is cut", "conflict": ""}]}
        if "angrier" in note and "Mara asked Nessa Crane" in text:
            return {"changes": [{"original": "Mara asked Nessa Crane about the night the light went dark.",
                                 "replacement": "Mara slammed her fist on the net shed and demanded that Nessa Crane "
                                                "tell her about the night the light went dark.",
                                 "why": "angrier", "conflict": ""}]}
        if "eyes" in note and "Her green eyes" in text:
            return {"changes": [{"original": "Her green eyes stung in the salt wind.",
                                 "replacement": "Her grey eyes stung in the salt wind.", "why": "eye colour",
                                 "conflict": ""}]}
        if "locket" in note and "Tom Reed wept" in text:
            return {"changes": [{"original": "In the morning she lit the great lamp, and Tom Reed wept.",
                                 "replacement": "In the morning she opened the brass locket, found the keeper's "
                                                "key inside and lit the great lamp, and Tom Reed wept.",
                                 "why": "payoff for the locket", "conflict": ""}]}
        return {"changes": []}

    def _a_check(self, ctx):
        out = []
        for p in self.check_problems:
            for ch in ctx.get("changes") or []:
                if p["match"] in ch["replacement"]:
                    out.append({"change": ch["id"], "problem": p["problem"], "severity": p.get("severity", "major")})
        return {"problems": out}
