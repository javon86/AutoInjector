"""A deterministic fake AI for Make-a-book tests (and the UI test server).

It answers every AI task BookForge sends by the shape of the requested output schema: the invented book profile,
the Bible Builder world sketch and its Set A proposals, premise B01, main plot B03, outline B11 (as many chapters as
the outline asks for), chapter prose C02 (with objective assessments for the requested chapter), story events,
AI review verdicts (scriptable) and AI fixes (the draft returned with a revised sentence, references untouched).
Scripted failures (BookforgeError instances) are raised before answering, in order.

The AI editor (P4) and the writer's targeted rewrite (P5) are answered deterministically too: ``editor_flags`` maps
a phrase to its replacement. A craft review flags (major, subtext score 4) every sentence of the chapter that holds
one of those phrases and keeps the chapter's first sentence; with no flagged phrase it passes (all scores 8). A
rewrite request replaces the phrase inside each flagged sentence. ``craft_script`` / ``rewrite_script`` hold whole
answers (dicts, or callables(ctx) -> dict) used first, one per call.
"""
from __future__ import annotations

import copy
import json
import threading

from bookforge.errors import BookforgeError

CHAPTER_TEXT = {
    1: ["The fog rolled in over Gullhaven before dawn, and Mara Vell climbed the hundred and twelve steps of the old "
        "lighthouse with a lantern in one hand and her master's last letter in the other.",
        "The lamp room was cold. Tom Reed's logbook lay open beside a cracked lens, and the final line was written in "
        "a hand she did not know."],
    2: ["Down in the harbor the fishing boats knocked together like restless teeth. Mara asked every captain about "
        "the night the light went dark, and every captain looked away.",
        "Only old Nessa at the net sheds would talk, and only in a whisper: the keeper had gone out to the reef with "
        "a stranger, and only the stranger had come back."],
    3: ["At low tide the reef rose out of the water like the spine of something sleeping. Mara found the keeper's "
        "brass key wedged between two stones, still warm from the sun.",
        "When she turned it in the lighthouse door that night, the great lamp blazed for the first time in a week, "
        "and far out on the water a small boat turned for home."],
}


def fact(s, p, v, a="FACT"):
    return {"subject_id": s, "predicate": p, "value": v, "assertion_type": a, "effective_from": None,
            "effective_to": None, "source_refs": []}


def plan_item(item_id, order, objective, pov="mara-vell", loc="gullhaven-harbor"):
    facts = [fact(item_id, "plan.item_id", item_id, "PLAN"), fact(item_id, "plan.order", order, "PLAN"),
             fact(item_id, "plan.parent_id", None, "PLAN"), fact(item_id, "plan.objective", objective, "PLAN"),
             fact(item_id, "plan.event_ids", [], "PLAN"), fact(item_id, "plan.pov_id", pov, "PLAN"),
             fact(item_id, "plan.location_id", loc, "PLAN"), fact(item_id, "plan.obligation_ids", [], "PLAN")]
    return {"summary": f"{item_id}: {objective}", "facts": facts, "links": []}


OBJECTIVES = ["Mara climbs to the dark lighthouse and finds the keeper's log",
              "Mara questions the harbor and learns about the stranger",
              "Mara finds the brass key on the reef and relights the lamp"]
NAMES = {"A01": ["Mara Vell", "Tom Reed", "Nessa Crane", "Ilse Marrow"], "A04": ["Gullhaven Harbor", "The Old Light",
                                                                                 "Widow's Reef"],
         "A03": ["The Grey Coast"]}


class BookFakeAI:
    def __init__(self, verdicts=None, default_verdict="APPROVE"):
        self.calls: list[dict] = []
        self.verdicts = list(verdicts or [])  # consumed one per review call
        self.default_verdict = default_verdict
        self.failures: list[BookforgeError] = []  # raised before answering, one per call
        self.kind_failures: dict[str, list] = {}  # answer kind -> errors raised instead of that answer
        self.gate = None  # threading.Event: when set to an unset Event, every call waits for it
        self.waiting = threading.Event()  # set once a call is blocked on the gate (tests wait on this, not a sleep)
        self.delay = 0.0
        self.lock = threading.Lock()
        self.kinds: list[str] = []
        self.editor_flags: dict[str, str] = {}   # phrase -> replacement (P4/P5)
        self.craft_script: list = []             # scripted editor answers, one per craft review
        self.rewrite_script: list = []           # scripted writer answers, one per rewrite request
        self.craft_contexts: list[dict] = []     # what the editor was sent (tests check the pattern report etc.)

    def fail_next(self, *excs):
        self.failures.extend(excs)

    def fail_kind(self, kind, *excs):
        self.kind_failures.setdefault(kind, []).extend(excs)

    def submit(self, slot, system, user, schema):
        package = json.loads(user.split("\n", 1)[1])
        ctx = package.get("context") or {}
        props = schema.get("properties") or {}
        usage = {"model": "fake-book-model", "input_tokens": 10, "output_tokens": 20}
        with self.lock:
            self.calls.append({"slot": slot["slot_id"], "props": sorted(props)})
            if self.failures:
                exc = self.failures.pop(0)
                self.kinds.append(f"fail:{exc.code}")
                raise exc
        gate = self.gate
        if gate is not None:
            self.waiting.set()
            gate.wait(30)
        if self.delay:
            import time  # noqa: PLC0415
            time.sleep(self.delay)
        kind, out = self._answer(ctx, props, schema)
        with self.lock:
            pending = self.kind_failures.get(kind)
            if pending:
                exc = pending.pop(0)
                self.kinds.append(f"fail:{kind}:{exc.code}")
                raise exc
            self.kinds.append(kind)
        return out, usage

    # ------------------------------------------------------------------ answers
    def _answer(self, ctx, props, schema):
        if "scores" in props:  # 🖋 the AI editor (craft review)
            with self.lock:
                self.craft_contexts.append(ctx)
                scripted = self.craft_script.pop(0) if self.craft_script else None
            if scripted is not None:
                return "craft", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "craft", self._craft(ctx, list((props["scores"].get("properties") or {}).keys()))
        if "replacements" in props:  # ✍ the writer reworks the flagged passages
            with self.lock:
                scripted = self.rewrite_script.pop(0) if self.rewrite_script else None
            if scripted is not None:
                return "rewrite", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "rewrite", self._rewrite(ctx)
        if "verdict" in props:
            with self.lock:
                v = self.verdicts.pop(0) if self.verdicts else self.default_verdict
            return "review", {"verdict": v, "reasons": ["It fits the book profile and the plan." if v == "APPROVE"
                                                        else "The opening could name the place sooner."],
                              "suggested_changes": [] if v == "APPROVE" else ["Name the harbor in the first line."],
                              "confidence": 0.8}
        if "draft" in ctx and "review" in ctx:  # "Ask AI to fix it": the whole draft, one sentence revised
            data = json.loads(ctx["draft"]["data_json"])
            return "fix", self._revise(data)
        if {"title", "author", "genre", "audience", "tone", "idea"} <= set(props):
            w = ctx.get("wishes") or {}
            return "profile", {"title": "The Keeper of Gullhaven", "author": "Rowan Ashby",
                               "genre": w.get("genre") or "Mystery", "audience": "Adult", "tone": "Cozy and eerie",
                               "idea": "When the Gullhaven lighthouse goes dark, apprentice keeper Mara Vell searches "
                                       "the fog-bound harbor for her missing master. Every captain hides something, "
                                       "and the only clue is a brass key that should not exist."}
        if "world_summary" in props:
            items = []
            for sec, n in (ctx.get("requested") or {}).items():
                for i in range(n):
                    names = NAMES.get(sec) or [f"{sec} item"]
                    name = names[i % len(names)] + ("" if i < len(names) else f" {i}")
                    links = [NAMES["A04"][0]] if sec == "A01" and "A04" in ctx.get("requested", {}) else []
                    items.append({"section": sec, "name": name, "role": f"An important {sec} entry: {name}.",
                                  "links": links})
            return "sketch", {"world_summary": "A fog-bound coast of lighthouses and fishing towns.", "items": items}
        if "concept" in props:  # Set A proposal (Bible Builder item)
            this = ctx.get("this_item") or {}
            sid = this.get("subject_id") or "entity"
            name = this.get("name") or "Entity"
            out = {"concept": name}
            if "attributes" in props:
                out["attributes"] = {k: f"{name}: {k.replace('_', ' ')} fitting the story."
                                     for k in (props["attributes"].get("properties") or {})}
            if "facts" in props:
                out["facts"] = [fact(sid, "entity.name", name)]
            return "canon", out
        if "premise" in props:
            return "B01", {"premise": "An apprentice keeper searches a fog-bound harbor for her vanished master.",
                           "dramatic_question": "Will Mara bring the light back before the winter storms?",
                           "concept_summary": "A cozy, eerie coastal mystery."}
        if "main_plot" in props:
            return "B03", {"main_plot": {"summary": "Mara follows the keeper's trail from the dark lighthouse through "
                                                    "the harbor to the reef.", "facts": [], "links": []},
                           "objectives": [], "plot_obligations": []}
        if "chapters" in props:
            req = ctx.get("request_payload") or {}
            n = ((req.get("target_length") or {}).get("value")) or 3
            n = max(1, min(int(n), 6))
            pov, loc = self._canon_ids(ctx)
            return "B11", {"chapters": [plan_item(f"ch{i + 1}", i, OBJECTIVES[i % 3], pov, loc) for i in range(n)],
                           "unresolved_threads": []}
        if "objective_assessments" in props:
            req = ctx.get("request_payload") or {}
            cid = req.get("chapter_id") or "ch1"
            num = int(cid[2:]) if cid[2:].isdigit() else 1
            paras = CHAPTER_TEXT[((num - 1) % 3) + 1]
            return "C02", {"text": "\n\n".join(paras),
                           "objective_assessments": [{"item_id": cid, "decision": "PASS", "message": "reached"}]}
        if "events" in props:
            return "events", {"events": []}
        return "generic", self._from_schema(schema)

    @staticmethod
    def sentences(text):
        import re  # noqa: PLC0415
        return [x.strip() for x in re.findall(r"[^.!?]+[.!?]+", text or "") if x.strip()]

    def _craft(self, ctx, dims):
        text = ctx.get("chapter_text") or ctx.get("draft_json") or ""
        body = text.split("\n", 1)[1] if text.startswith("#") and "\n" in text else text
        flagged = []
        for s in self.sentences(body):
            for ph in self.editor_flags:
                if ph in s and s not in [f[0] for f in flagged]:
                    flagged.append((s, ph))
        first = (self.sentences(body) or [""])[0]
        scores = {d: 8 for d in dims}
        findings = []
        for i, (s, ph) in enumerate(flagged):
            scores["subtext"] = 4 if "subtext" in scores else scores.get("subtext")
            findings.append({"id": f"f{i + 1}", "dimension": "subtext" if "subtext" in dims else dims[0],
                             "severity": "major", "passage": s[:200],
                             "why": f"“{ph}” tells the reader what to think instead of showing it.",
                             "suggestion": "Show it through what the characters do.", "keep_nearby": []})
        scores = {k: v for k, v in scores.items() if v is not None}
        return {"scores": scores, "findings": findings, "keep": [first[:200]] if first else [],
                "verdict": "REVISE" if findings else "PASS"}

    def _rewrite(self, ctx):
        out = []
        for f in ctx.get("findings") or []:
            p = f.get("passage") or ""
            for ph, rep in self.editor_flags.items():
                if ph in p:
                    out.append({"finding_id": f["id"], "original": p, "replacement": p.replace(ph, rep)})
                    break
        return {"replacements": out}

    def _canon_ids(self, ctx):
        pov, loc = "mara-vell", "gullhaven-harbor"
        for rec in (ctx.get("resolved_inputs") or {}).values():
            for f in ((rec or {}).get("data") or {}).get("facts") or []:
                if isinstance(f, dict) and f.get("predicate") == "entity.name":
                    if rec.get("module_id") == "A01":
                        pov = f["subject_id"]
                    if rec.get("module_id") == "A04":
                        loc = f["subject_id"]
        return pov, loc

    @staticmethod
    def _revise(data):
        data = copy.deepcopy(data)
        for key in ("text", "premise", "concept_summary"):
            if isinstance(data.get(key), str):
                data[key] = data[key].rstrip() + (" The harbor was called Gullhaven." if key == "text" else
                                                  " (revised)")
                return data
        if isinstance(data.get("main_plot"), dict) and isinstance(data["main_plot"].get("summary"), str):
            data["main_plot"]["summary"] += " (revised)"
            return data
        if isinstance(data.get("attributes"), dict):
            for k, v in data["attributes"].items():
                if isinstance(v, str):
                    data["attributes"][k] = v + " (revised)"
                    break
        return data

    def _from_schema(self, schema):
        def gen(s):
            if not isinstance(s, dict):
                return None
            t = s.get("type")
            if "enum" in s:
                return s["enum"][0]
            if t == "object" or "properties" in s:
                return {k: gen(v) for k, v in (s.get("properties") or {}).items() if k in (s.get("required") or [])}
            if t == "array":
                return []
            if t == "string":
                return "text"
            if t in ("integer", "number"):
                return 0
            if t == "boolean":
                return False
            return None
        return gen(schema)
