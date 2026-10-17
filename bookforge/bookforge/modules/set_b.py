"""Set B handlers: Story Plot (B01-B14), staged planning.

Stage order B01 -> B02/B03 -> provisional B04/B05 -> B06/B07 -> provisional B10 -> B11 ->
selected B08/B09, B12/B13 -> revised B11/B14 is honored by optional pins only: no CREATE
waits for a later stage, and selected mystery/foreshadowing plans gate final outline
ACCEPT (revision feedback) rather than its first draft.

Creative content (premise, plots, arcs, acts, chapters, scenes, endings) comes only from
an AI slot or a manual candidate; code never invents it. B10 chronology and B13 pacing
are logic when the pinned inputs carry the machine values. VALIDATE (and CREATE as a
preview) runs the deterministic closure rules of Shared Contract section 10:

* every fact: half-open interval, registered predicate type, unregistered -> UNKNOWN,
  contradictions; entity/POV/location IDs must be declared by pinned A canon;
* plan items: plan.item_id == subject_id, unique IDs, unique plan.order within
  plan.parent_id, plan.objective (unknown blocks); chapters/scenes declare plan.event_ids,
  plan.pov_id, plan.location_id, plan.obligation_ids; null POV/location blocks approval
  when the manifest selects a prose job that reads it;
* references to known IDs: obligations (B03), events (B10 authoritative, else B03 trace),
  acts (B06), chapters (B11); causal predecessors acyclic and not later in story time;
* B08/B09 feature_selected consistency and selected-only plan refs; B11 target_length;
  B13 deterministic pacing warnings; B14 resolved/unresolved obligations partition the
  known obligations and planned resolutions stay separate from observed thread status.
"""
from __future__ import annotations

import copy

from .. import plan_rules as pr
from ..errors import BookforgeError
from . import register
from .base import Context, OperationHandler, Result, normalize_to_output
from .set_a import historical_events, resolve_pins

B_OPS = tuple(f"B{i:02d}" for i in range(1, 15))

# Output fields only an AI slot or a manual candidate may author.
CREATIVE = {
    "B01": ["premise", "dramatic_question", "concept_summary"],
    "B02": ["genre_tags", "tone_profile", "style_constraints"],
    "B03": ["main_plot", "objectives", "plot_obligations"],
    "B04": ["subplots"], "B05": ["arcs"], "B06": ["acts"], "B07": ["conflicts"], "B08": ["reveals"],
    "B09": ["foreshadow_links"], "B10": ["events"], "B11": ["chapters", "unresolved_threads"],
    "B12": ["scenes"], "B13": [], "B14": ["ending", "resolved_obligation_ids", "unresolved_obligation_ids"],
}

# Plan-item list fields: (field, unit item = chapter/scene, event item).
ITEM_FIELDS = {
    "B04": ("subplots", False, False), "B05": ("arcs", False, False), "B06": ("acts", False, False),
    "B07": ("conflicts", False, False), "B08": ("reveals", False, False),
    "B09": ("foreshadow_links", False, False), "B10": ("events", False, True),
    "B11": ("chapters", True, False), "B12": ("scenes", True, False),
}

FEATURE_OPS = {"B08": "mystery", "B09": "foreshadowing"}

TASKS = {
    "B01": "Write the central premise, the core dramatic question (a question) and a concise concept summary from "
           "the idea and goals. Respect pinned canon.",
    "B02": "Choose genre_tags, a tone_profile SemanticRecord (summary prose; facts only for precise tonal "
           "constraints) and style_constraints from the premise, preferences and project metadata.",
    "B03": "Design the primary causal plot. main_plot.summary is prose; main_plot.facts declare planned events as "
           "subjects with plan.item_id/plan.objective/plan.predecessor_ids (assertion_type PLAN). plot_obligations "
           "are stable obligation IDs (e.g. 'obl-...') every ending must resolve or intentionally leave open.",
    "B04": "Create secondary plotlines tied to characters/themes without displacing the main plot.",
    "B05": "Plan character arcs: initial state, pressures, turning points and intended end state.",
    "B06": "Map main-plot events to acts of the selected structure; each act lists its plan.event_ids.",
    "B07": "Design internal, interpersonal and external conflicts driving the planned events.",
    "B08": "Plan hidden information, clues and reveal timing; clue items precede reveals via plan.predecessor_ids.",
    "B09": "Create setup/payoff links: a payoff item lists its setup item IDs in plan.predecessor_ids.",
    "B10": "Order story events: one item per event with plan.item_id (story time in that fact's effective_from), "
           "plan.order (narrative order) and plan.predecessor_ids (causal, acyclic). Reuse the known event IDs.",
    "B11": "Partition the plot into chapters. Each chapter declares plan.item_id, plan.order, plan.parent_id (act ID "
           "or null), plan.objective, plan.event_ids, plan.pov_id, plan.location_id and plan.obligation_ids. "
           "List obligations deliberately left open in unresolved_threads. Honor target_length when given.",
    "B12": "Break the outline chapter(s) into scenes; plan.parent_id is the chapter ID; each scene declares "
           "plan.objective, plan.event_ids (subset of its chapter), plan.pov_id, plan.location_id, "
           "plan.obligation_ids. Entry/exit state belong in summary or entity.* PLAN facts.",
    "B13": "Interpret pacing qualitatively against the supplied targets only; never invent universal scores.",
    "B14": "Design climax and denouement. Put every known obligation ID in exactly one of resolved_obligation_ids "
           "(planned resolved) or unresolved_obligation_ids (intentionally unresolved). Ending facts may use "
           "plan.resolution (PLANNED_RESOLVED / INTENTIONALLY_UNRESOLVED); never claim observed thread.resolution.",
}

_PROSE_CONSUMERS: set | None = None


def prose_consumers(contracts) -> set:
    """C prose jobs that read B11/B12 plans (they need decided POV/location)."""
    global _PROSE_CONSUMERS
    if _PROSE_CONSUMERS is None:
        out = set()
        for op in contracts.operation_ids:
            if not op.startswith("C") or op in ("C01", "C12"):
                continue
            for b in contracts.bindings(op):
                ap = b["allowed_producers"]
                if len(ap) < 10 and ("B11" in ap or "B12" in ap):
                    out.add(op)
        _PROSE_CONSUMERS = out
    return _PROSE_CONSUMERS


class Sources:
    """Pinned input records available to a plan check (create: resolved; validate: source pins)."""

    def __init__(self, ctx: Context, records: list[dict], exclude: str | None = None):
        self.ctx = ctx
        seen, self.records = set(), []
        for r in records:
            k = (r["record_id"], r["version"])
            if k in seen or r["record_id"] == exclude:
                continue
            seen.add(k)
            self.records.append(r)

    def of(self, *modules: str) -> list[dict]:
        return [r for r in self.records if r["module_id"] in modules]

    def canon(self, depth: int = 2) -> list[dict]:
        """A records pinned directly or through the pins of pinned inputs (up to depth)."""
        out, seen, frontier = [], set(), list(self.records)
        for level in range(depth + 1):
            nxt = []
            for r in frontier:
                k = (r["record_id"], r["version"])
                if k in seen:
                    continue
                seen.add(k)
                if r["module_id"].startswith("A"):
                    out.append(r)
                elif level < depth:
                    nxt += resolve_pins(self.ctx, r.get("source_refs"))
            frontier = nxt
        return out


def items_of(rec: dict, unit=False, events=False) -> list[pr.PlanItem]:
    """Plan items of a pinned B record (silently skipping malformed items)."""
    spec = ITEM_FIELDS.get(rec["module_id"])
    if not spec or not isinstance(rec.get("data"), dict):
        return []
    return pr.plan_items(rec["data"].get(spec[0]) or [], spec[0], lambda *a, **k: None)


def plot_events(main: dict) -> list[str]:
    """Event IDs a B03 main plot declares, in first-appearance order: plan.item_id subjects,
    plan.event_ids values, and causal predecessors (listed before their successor)."""
    out: list[str] = []
    for _, f in pr.iter_facts((main.get("data") or {}).get("main_plot")):
        vals = []
        if f["predicate"] == "plan.item_id":
            vals = [f["subject_id"]]
        elif f["predicate"] == "plan.event_ids":
            vals = pr.as_list(f.get("value"))
        elif f["predicate"] == "plan.predecessor_ids":
            vals = pr.as_list(f.get("value")) + [f["subject_id"]]
        for v in vals:
            if isinstance(v, str) and v not in out:
                out.append(v)
    return out


def outline_events(outline: dict) -> list[str]:
    out: list[str] = []
    for it in sorted(items_of(outline), key=lambda i: (i.get("plan.order") if isinstance(i.get("plan.order"), int)
                                                       else 1 << 30, i.item_id)):
        for e in pr.as_list(it.get("plan.event_ids")):
            if isinstance(e, str) and e not in out:
                out.append(e)
    return out


def known_obligations(src: Sources) -> set | None:
    mains = src.of("B03")
    if not mains:
        return None
    return {o for m in mains for o in (m.get("data") or {}).get("plot_obligations") or []}


@register(*B_OPS)
class PlanHandler(OperationHandler):
    """Shared B-set behavior; per-op rules live in _rules_<op>, derivations in _derive_<op>."""

    creative = True

    # -- CREATE / UPDATE -----------------------------------------------------------------
    def create(self, ctx: Context) -> Result:
        self._precheck(ctx)
        resource, findings, transform = None, [], "LOGIC"
        partial, _ = normalize_to_output(ctx.payload, ctx.contracts.definition(ctx.op_id, "OUTPUT"))
        partial = {k: v for k, v in partial.items() if k not in CREATIVE[self.op_id]}
        if ctx.manual_candidate is not None:
            data, transform = copy.deepcopy(ctx.manual_candidate), "MANUAL"
            self._check_manual(ctx, data)
        else:
            derive = getattr(self, f"_derive_{self.op_id.lower()}", None)
            data = derive(ctx, partial) if derive else None
            if data is None:
                fields = [f for f in CREATIVE[self.op_id] if f not in partial]
                data, resource, findings = pr.ai_complete(
                    ctx, partial, fields, task=self.ai_task(ctx), context=self.ai_context(ctx),
                    protected=self._protected(ctx))
                transform = "AI"
        record_id = None
        if self.op_id == "B11":
            record_id = ctx.allocate_record_id()
            target = ctx.payload.get("target_length")
            ctx.on_commit(lambda tx: tx.put_state(ctx.project_id, ctx.branch_id, "B11", f"target_length/{record_id}",
                                                  target))
        src = Sources(ctx, [r for p, r in ctx.resolved.items() if p != "/base_ref"])
        findings += self._check(ctx, data, src, record_id)
        return Result(data=data, transform=transform, resource=resource, findings=findings, record_id=record_id)

    def update(self, ctx: Context) -> Result:
        data = copy.deepcopy(ctx.payload)
        base = ctx.base
        # Keep the lineage's input pins so later VALIDATE checks the same planning context.
        pins = [r for r in base["source_refs"] if r["record_id"] != base["record_id"]]
        src = Sources(ctx, resolve_pins(ctx, pins), exclude=base["record_id"])
        return Result(data=data, transform="MANUAL", source_refs=pins,
                      findings=self._check(ctx, data, src, base["record_id"]))

    def _precheck(self, ctx: Context):
        """Reject feature/selection contradictions before any generation (Set B rules)."""
        feats = (ctx.manifest or {}).get("features") or {}
        p = ctx.payload
        if self.op_id in FEATURE_OPS:
            feature = FEATURE_OPS[self.op_id]
            if p.get("feature_selected") is not feats.get(feature):
                raise BookforgeError("INVALID_INPUT", "/payload/feature_selected",
                                     f"feature_selected={p.get('feature_selected')} contradicts {feature}="
                                     f"{feats.get(feature)} in the pinned feature manifest", status="REJECTED")
        for field in ("selected_plan_refs", "plot_refs", "reveal_refs"):
            for i, ref in enumerate(p.get(field) or []):
                feature = FEATURE_OPS.get(ref["module_id"])
                if feature and feats.get(feature) is not True:
                    raise BookforgeError("INVALID_INPUT", f"/payload/{field}/{i}",
                                         f"{ref['module_id']} output is not selected ({feature} is not true); "
                                         "only selected plan outputs may be used", status="REJECTED")
        if self.op_id == "B11":
            ids = [r["record_id"] for r in p.get("selected_plan_refs") or []]
            if len(ids) != len(set(ids)):
                raise BookforgeError("INVALID_INPUT", "/payload/selected_plan_refs",
                                     "pin each selected plan record once", status="REJECTED")

    def _check_manual(self, ctx: Context, data: dict):
        if self.op_id == "B06" and data["structure_model"] != ctx.payload["selected_structure"]:
            raise BookforgeError("INVALID_INPUT", "/manual_candidate/structure_model",
                                 f"structure_model must be the selected structure "
                                 f"'{ctx.payload['selected_structure']}'", status="REJECTED")

    # -- VALIDATE / ACCEPT ----------------------------------------------------------------
    def validate(self, ctx: Context, record: dict) -> list[dict]:
        src = Sources(ctx, resolve_pins(ctx, record["source_refs"]), exclude=record["record_id"])
        return self._check(ctx, record["data"], src, record["record_id"])

    def accept_gate(self, ctx: Context, record: dict, approval) -> list[dict]:
        if self.op_id != "B11":
            return []
        out = []
        feats = (ctx.manifest or {}).get("features") or {}
        pins = resolve_pins(ctx, record["source_refs"])
        for op, feature in FEATURE_OPS.items():
            if feats.get(feature) is not True:
                continue
            if not any(r["module_id"] == op and r["lifecycle"] in ("APPROVED", "LOCKED") for r in pins):
                out.append(ctx.finding("SELECTED_PLAN_MISSING", f"{feature}=true: an approved {op} plan must be "
                                       "incorporated (selected_plan_refs) before final outline approval",
                                       severity="BLOCKING", decision="UNKNOWN"))
        return out

    # -- deterministic checks -------------------------------------------------------------
    def _check(self, ctx: Context, data: dict, src: Sources, record_id: str | None) -> list[dict]:
        out: list[dict] = []

        def add(rule, msg, severity="MAJOR", decision="FAIL", refs=None):
            out.append(ctx.finding(rule, msg, severity=severity, decision=decision, source_refs=refs or []))

        pr.check_facts(pr.iter_facts(data), ctx.contracts.predicate_registry, add)
        items = []
        if self.op_id in ITEM_FIELDS:
            field, unit, events = ITEM_FIELDS[self.op_id]
            items = pr.plan_items(data.get(field) or [], field, add, unit=unit, events=events)
            if unit:
                self._check_undecided(ctx, items, field, add)
        self._check_canon(ctx, data, src, add)
        rule = getattr(self, f"_rules_{self.op_id.lower()}", None)
        if rule:
            rule(ctx, data, items, src, add, record_id)
        return out

    def _check_undecided(self, ctx: Context, items: list, field: str, add):
        required = set((ctx.manifest or {}).get("required_operations") or []) & prose_consumers(ctx.contracts)
        for it in items:
            for pred in ("plan.pov_id", "plan.location_id"):
                if it.has(pred) and it.get(pred) is None:
                    if required:
                        add("PLAN_UNDECIDED", f"/{field}/{it.index}: {pred} of '{it.item_id}' is undecided; selected "
                            f"job(s) {', '.join(sorted(required))} need it before approval", "BLOCKING", "UNKNOWN")
                    else:
                        add("PLAN_UNDECIDED", f"/{field}/{it.index}: {pred} of '{it.item_id}' is undecided",
                            "INFO", "UNKNOWN")

    def _check_canon(self, ctx: Context, data: dict, src: Sources, add):
        """Asserted entities must resolve to pinned canon authority before approval (section 4)."""
        canon = src.canon()
        governed = dict(pr.AUTHORITY, **{"plan.pov_id": ("A01",), "plan.location_id": ("A04",)})
        for ptr, f in pr.iter_facts(data):
            modules = governed.get(f["predicate"])
            if not modules or f["assertion_type"] not in ("FACT", "PLAN"):
                continue
            recs = [r for r in canon if r["module_id"] in modules]
            known = set().union(*(pr.declared_ids(r) for r in recs)) if recs else set()
            for v in pr.as_list(f.get("value")):
                if isinstance(v, str) and v not in known:
                    add("CANON_UNRESOLVED", f"{ptr}: {f['predicate']} '{v}' is not declared by any pinned "
                        f"{'/'.join(modules)} canon record; pin that authority before approval",
                        "BLOCKING", "UNKNOWN", [r["ref"] for r in recs])

    # -- per-operation rules ---------------------------------------------------------------
    def _rules_b02(self, ctx, data, items, src, add, rid):
        tags = data.get("genre_tags") or []
        if len(tags) != len(set(tags)):
            add("GENRE_DUPLICATE", "genre_tags contain duplicates", "MINOR", "FAIL")

    def _rules_b03(self, ctx, data, items, src, add, rid):
        obl = data.get("plot_obligations") or []
        dups = sorted({o for o in obl if obl.count(o) > 1})
        if dups:
            add("OBLIGATION_DUPLICATE", f"plot_obligations must be unique stable IDs: {dups}", "BLOCKING", "FAIL")
        main = data.get("main_plot") or {}
        times, preds = {}, {}
        for ptr, f in pr.iter_facts(main, "/main_plot"):
            if f["predicate"] == "plan.item_id" and f.get("value") != f["subject_id"]:
                add("PLAN_ITEM_ID", f"{ptr}: plan.item_id value must equal subject_id", "BLOCKING", "FAIL")
            if f["predicate"] == "plan.obligation_ids":
                for o in pr.as_list(f.get("value")):
                    if o not in obl:
                        add("PLAN_REF_UNKNOWN", f"{ptr}: obligation '{o}' is not in plot_obligations", "BLOCKING",
                            "FAIL")
            if f["predicate"] == "plan.item_id":
                times[f["subject_id"]] = f.get("effective_from")
            if f["predicate"] == "plan.predecessor_ids":
                preds[f["subject_id"]] = [v for v in pr.as_list(f.get("value")) if isinstance(v, str)]
        for e in plot_events({"data": data}):
            times.setdefault(e, None)
        pr.check_precedence(times, preds, add, what="planned event")

    def _check_obligations_events(self, items, field, src, add):
        pr.check_known(items, "plan.obligation_ids", known_obligations(src), field, add, what="B03 plot obligation",
                       authoritative=True)
        mains = src.of("B03")
        catalog = {e for m in mains for e in plot_events(m)} if mains else None
        pr.check_known(items, "plan.event_ids", catalog or None, field, add, what="main-plot event",
                       authoritative=False)

    def _rules_b04(self, ctx, data, items, src, add, rid):
        self._check_obligations_events(items, "subplots", src, add)

    def _rules_b05(self, ctx, data, items, src, add, rid):
        self._check_obligations_events(items, "arcs", src, add)

    def _rules_b07(self, ctx, data, items, src, add, rid):
        self._check_obligations_events(items, "conflicts", src, add)

    def _rules_b06(self, ctx, data, items, src, add, rid):
        self._check_obligations_events(items, "acts", src, add)
        pr.check_parents(items, {i.item_id for i in items}, "acts", add, what="act of this structure")

    def _rules_b08(self, ctx, data, items, src, add, rid):
        self._check_obligations_events(items, "reveals", src, add)
        external = {e for m in src.of("B03") for e in plot_events(m)}
        pr.check_precedence({i.item_id: i.time() for i in items},
                            {i.item_id: pr.as_list(i.get("plan.predecessor_ids")) for i in items},
                            add, what="clue/reveal", known_external=external)

    def _rules_b09(self, ctx, data, items, src, add, rid):
        self._check_obligations_events(items, "foreshadow_links", src, add)
        external = {e for m in src.of("B03") for e in plot_events(m)}
        for r in src.of("B08", "B11"):
            external |= {i.item_id for i in items_of(r)}
        pr.check_precedence({i.item_id: i.time() for i in items},
                            {i.item_id: pr.as_list(i.get("plan.predecessor_ids")) for i in items},
                            add, what="setup/payoff", known_external=external)

    def _rules_b10(self, ctx, data, items, src, add, rid):
        pr.check_known(items, "plan.obligation_ids", known_obligations(src), "events", add,
                       what="B03 plot obligation", authoritative=True)
        hist = {}
        for r in src.of(*[f"A{i:02d}" for i in range(1, 19)]):
            if r["module_id"] == "A13":
                hist.update({k: v["time"] for k, v in historical_events(r).items()})
        nodes = dict(hist, **{i.item_id: i.time() for i in items})
        pr.check_precedence(nodes, {i.item_id: pr.as_list(i.get("plan.predecessor_ids")) for i in items},
                            add, what="planned event")
        ids = {i.item_id for i in items}
        expected = [e for m in src.of("B03") for e in plot_events(m)] + \
                   [e for o in src.of("B11") for e in outline_events(o)]
        missing = sorted({e for e in expected if e not in ids})
        if missing:
            add("EVENT_ID_MISSING", f"planned events {missing} are declared by the pinned plot/outline but not "
                "ordered here; B10 must use the same stable event IDs", "MAJOR", "UNKNOWN")

    def _rules_b11(self, ctx, data, items, src, add, rid):
        obligations = known_obligations(src)
        b10 = src.of("B10")
        if b10:
            catalog, authoritative = {i.item_id for r in b10 for i in items_of(r)}, True
        else:
            catalog = {e for m in src.of("B03") for e in plot_events(m)} or None
            authoritative = False
        pr.check_known(items, "plan.event_ids", catalog, "chapters", add, what="planned event",
                       authoritative=authoritative)
        pr.check_known(items, "plan.obligation_ids", obligations, "chapters", add, what="B03 plot obligation",
                       authoritative=True)
        structure = src.of("B06")
        if structure:
            acts = {i.item_id for r in structure for i in items_of(r)}
            pr.check_parents(items, acts, "chapters", add, what="B06 act")
        else:
            for it in items:
                if it.get("plan.parent_id") is not None:
                    add("PLAN_PARENT_UNKNOWN", f"/chapters/{it.index}: parent '{it.get('plan.parent_id')}' cannot be "
                        "checked without a pinned B06 structure", "MAJOR", "UNKNOWN")
        assigned_obl = {o for it in items for o in pr.as_list(it.get("plan.obligation_ids"))}
        threads = set(data.get("unresolved_threads") or [])
        if obligations is not None:
            for o in sorted(obligations - assigned_obl - threads):
                add("OBLIGATION_UNPLACED", f"obligation '{o}' is assigned to no chapter and not listed in "
                    "unresolved_threads", "MAJOR", "UNKNOWN")
            for t in sorted(threads - obligations):
                add("THREAD_UNKNOWN", f"unresolved thread '{t}' is not a known B03 obligation", "MINOR", "UNKNOWN")
        if catalog:
            assigned_ev = {e for it in items for e in pr.as_list(it.get("plan.event_ids"))}
            for e in sorted(catalog - assigned_ev):
                add("EVENT_UNPLACED", f"planned event '{e}' is not assigned to any chapter", "MAJOR", "UNKNOWN")
        for r in src.records:
            feature = FEATURE_OPS.get(r["module_id"])
            if feature and ((ctx.manifest or {}).get("features") or {}).get(feature) is not True:
                add("UNSELECTED_PLAN", f"{r['module_id']} is pinned but {feature} is not selected", "BLOCKING", "FAIL",
                    [r["ref"]])
        if ctx.action == "CREATE":
            target = ctx.payload.get("target_length")
        else:
            target = ctx.get_state("B11", f"target_length/{rid}") if rid else None
        if target is None:
            add("PROPOSED_LENGTH", f"no target length supplied; proposed chapter count {len(items)} awaits approval",
                "INFO", "PASS")
        elif target["unit"] == "chapters" and len(data.get("chapters") or []) != target["value"]:
            add("TARGET_LENGTH", f"outline has {len(data.get('chapters') or [])} chapters but target_length is "
                f"{target['value']} chapters", "BLOCKING", "FAIL")
        elif target["unit"] == "words":
            add("TARGET_LENGTH", f"word target {target['value']} is measured on prose, not on the outline",
                "INFO", "UNKNOWN")

    def _rules_b12(self, ctx, data, items, src, add, rid):
        outlines = src.of("B11")
        chapters = {i.item_id: i for o in outlines for i in items_of(o)}
        main_obl = set()
        for o in outlines:
            main_obl |= known_obligations(Sources(ctx, resolve_pins(ctx, o.get("source_refs")))) or set()
        for it in items:
            where = f"/scenes/{it.index}"
            parent = it.get("plan.parent_id")
            if not outlines:
                break
            if parent not in chapters:
                add("SCENE_PARENT", f"{where}: scene '{it.item_id}' must name a chapter of the pinned outline as "
                    f"plan.parent_id (got {parent!r})", "BLOCKING", "FAIL")
                continue
            ch = chapters[parent]
            ch_events = set(pr.as_list(ch.get("plan.event_ids")))
            for e in pr.as_list(it.get("plan.event_ids")):
                if e not in ch_events:
                    add("SCENE_EVENT", f"{where}: event '{e}' is not planned for chapter '{parent}'", "BLOCKING", "FAIL")
            known = set(pr.as_list(ch.get("plan.obligation_ids"))) | main_obl
            for o in pr.as_list(it.get("plan.obligation_ids")):
                if o not in known:
                    add("PLAN_REF_UNKNOWN", f"{where}: obligation '{o}' is not known to chapter '{parent}' or the "
                        "main plot", "BLOCKING", "FAIL")

    def _rules_b13(self, ctx, data, items, src, add, rid):
        targets = data.get("pacing_targets") or []
        warnings, unsupported = self._pacing(targets, src)
        for pred in unsupported:
            add("PREDICATE_UNSUPPORTED", f"pacing target predicate '{pred}' has no automatic metric; review "
                "manually", "MAJOR", "UNKNOWN")
        stored = set(data.get("pacing_warnings") or [])
        for w in warnings:
            if w not in stored:
                add("PACING_WARNING_MISSING", f"deterministic pacing warning missing: {w}", "BLOCKING", "FAIL")

    def _rules_b14(self, ctx, data, items, src, add, rid):
        resolved = data.get("resolved_obligation_ids") or []
        unresolved = data.get("unresolved_obligation_ids") or []
        for name, ids in (("resolved_obligation_ids", resolved), ("unresolved_obligation_ids", unresolved)):
            dups = sorted({o for o in ids if ids.count(o) > 1})
            if dups:
                add("OBLIGATION_DUPLICATE", f"{name} repeats {dups}", "BLOCKING", "FAIL")
        both = sorted(set(resolved) & set(unresolved))
        if both:
            add("OBLIGATION_PARTITION", f"obligations {both} are both resolved and unresolved", "BLOCKING", "FAIL")
        known = self._ending_obligations(ctx, src)
        listed = set(resolved) | set(unresolved)
        for o in sorted(known - listed):
            add("OBLIGATION_UNPLANNED", f"obligation '{o}' is neither planned resolved nor intentionally unresolved; "
                "a final ending cannot leave it open silently", "BLOCKING", "FAIL")
        for o in sorted(listed - known):
            add("OBLIGATION_UNKNOWN", f"obligation '{o}' is not declared by the pinned plot/arc plans",
                "BLOCKING", "FAIL")
        if unresolved:
            add("INTENTIONALLY_UNRESOLVED", f"obligations {sorted(unresolved)} stay intentionally unresolved; author "
                "acceptance records that approval", "INFO", "PASS")
        planned = {}
        for ptr, f in pr.iter_facts(data.get("ending")):
            if f["predicate"] == "thread.resolution":
                add("OBSERVED_CLAIM", f"/ending{ptr}: thread.resolution is observed manuscript state; B14 records "
                    "only planned plan.resolution", "BLOCKING", "FAIL")
            if f["predicate"] == "plan.resolution":
                planned[f["subject_id"]] = f.get("value")
                expect = ("PLANNED_RESOLVED" if f["subject_id"] in resolved else
                          "INTENTIONALLY_UNRESOLVED" if f["subject_id"] in unresolved else None)
                if f.get("value") == "UNKNOWN":
                    add("RESOLUTION_UNKNOWN", f"/ending{ptr}: resolution of '{f['subject_id']}' is UNKNOWN",
                        "BLOCKING", "UNKNOWN")
                elif expect and f.get("value") != expect:
                    add("RESOLUTION_MISMATCH", f"/ending{ptr}: {f['subject_id']} is {f.get('value')} but listed as "
                        f"{expect}", "BLOCKING", "FAIL")
        # Observed E state is reported against the plan, never merged into it.
        for rec in src.of(*[f"E{i:02d}" for i in range(1, 13)]):
            for _, f in pr.iter_facts(rec.get("data")):
                if f["predicate"] != "thread.resolution":
                    continue
                subj, value = f["subject_id"], f.get("value")
                if subj in resolved and value == "UNRESOLVED":
                    add("OBSERVED_MISMATCH", f"'{subj}' is planned resolved but observed UNRESOLVED in "
                        f"{rec['module_id']}:{rec['record_id']} v{rec['version']}", "MAJOR", "FAIL", [rec["ref"]])
                elif subj in unresolved and value == "OBSERVED_RESOLVED":
                    add("OBSERVED_MISMATCH", f"'{subj}' is planned unresolved but observed resolved in "
                        f"{rec['module_id']}:{rec['record_id']} v{rec['version']}", "MAJOR", "UNKNOWN", [rec["ref"]])

    @staticmethod
    def _ending_obligations(ctx: Context, src: Sources) -> set:
        known = known_obligations(src) or set()
        for rec in src.of("B03", "B04", "B05", "B07", "B08", "B09", "B10"):
            for _, f in pr.iter_facts(rec.get("data")):
                if f["predicate"] == "plan.obligation_ids":
                    known |= {o for o in pr.as_list(f.get("value")) if isinstance(o, str)}
        return known

    # -- deterministic derivations -----------------------------------------------------------
    def _derive_b06(self, ctx: Context, partial: dict):
        partial["structure_model"] = ctx.payload["selected_structure"]
        return None  # acts still need an AI slot or a manual candidate

    def _derive_b10(self, ctx: Context, partial: dict):
        """Order planned events from machine values already pinned in the plot/outline."""
        main = ctx.field_record("main_plot_ref")
        outline = ctx.field_record("outline_ref")
        order = outline_events(outline) if outline else []
        for e in plot_events(main):
            if e not in order:
                order.append(e)
        if not order:
            return None
        main_facts = [f for _, f in pr.iter_facts(main["data"]["main_plot"])]
        events = []
        for n, eid in enumerate(order):
            facts = [copy.deepcopy(f) for f in main_facts if f["subject_id"] == eid]
            preds = {f["predicate"] for f in facts}
            times = [f["effective_from"] for f in facts if f.get("effective_from") is not None]
            when = min(times) if times else None
            if "plan.item_id" not in preds:
                facts.insert(0, self._plan_fact(eid, "plan.item_id", eid, when, main["ref"]))
            if "plan.order" not in preds:
                facts.append(self._plan_fact(eid, "plan.order", n, None, main["ref"]))
            objective = next((f.get("value") for f in facts if f["predicate"] == "plan.objective"), None)
            events.append({"summary": objective if isinstance(objective, str) else "", "facts": facts, "links": []})
        return dict(partial, events=events)

    @staticmethod
    def _plan_fact(subject, predicate, value, when, ref):
        return {"subject_id": subject, "predicate": predicate, "value": value, "assertion_type": "PLAN",
                "effective_from": when, "effective_to": None, "source_refs": [ref]}

    def _derive_b13(self, ctx: Context, partial: dict):
        targets = [ctx.payload["length_targets"]]
        src = Sources(ctx, [r for p, r in ctx.resolved.items() if p != "/base_ref"])
        warnings, _ = self._pacing(targets, src)
        return dict(partial, pacing_targets=targets, pacing_warnings=warnings)

    @staticmethod
    def _pacing(targets: list, src: Sources) -> tuple[list[str], list[str]]:
        """Deterministic distribution warnings against supplied x.b13.* targets only."""
        chapters = [i for o in src.of("B11") for i in items_of(o)]
        scene_recs = src.of("B12")
        scenes: dict[str, int] | None = None
        if scene_recs:
            scenes = {}
            for r in scene_recs:
                for s in items_of(r):
                    scenes[s.get("plan.parent_id")] = scenes.get(s.get("plan.parent_id"), 0) + 1
        warnings, unsupported = [], []
        ids = {c.item_id for c in chapters}
        for rec in targets:
            for f in rec.get("facts") or []:
                pred, subj, val = f["predicate"], f["subject_id"], f.get("value")
                if pred not in ("x.b13.min_events", "x.b13.max_events", "x.b13.min_scenes", "x.b13.max_scenes"):
                    if pred not in unsupported:
                        unsupported.append(pred)
                    continue
                if not isinstance(val, int) or isinstance(val, bool):
                    continue
                if subj != "*" and subj not in ids:
                    warnings.append(f"target {pred} names unknown chapter '{subj}'")
                    continue
                metric = "events" if "events" in pred else "scenes"
                if metric == "scenes" and scenes is None:
                    msg = "scene counts unknown: no B12 scene plans pinned"
                    if msg not in warnings:
                        warnings.append(msg)
                    continue
                for ch in chapters:
                    if subj not in ("*", ch.item_id):
                        continue
                    n = len(pr.as_list(ch.get("plan.event_ids"))) if metric == "events" else scenes.get(ch.item_id, 0)
                    if pred.endswith(f"min_{metric}") and n < val:
                        warnings.append(f"chapter '{ch.item_id}': {n} {metric} below {pred}={val}")
                    if pred.endswith(f"max_{metric}") and n > val:
                        warnings.append(f"chapter '{ch.item_id}': {n} {metric} above {pred}={val}")
        return sorted(set(warnings)), unsupported

    # -- AI instructions -----------------------------------------------------------------------
    def _protected(self, ctx: Context) -> list[dict]:
        src = Sources(ctx, list(ctx.resolved.values()))
        out = []
        for rec in src.canon():
            if isinstance(rec.get("data"), dict):
                out += [dict(f, source=f"{rec['module_id']}:{rec['record_id']} v{rec['version']}")
                        for f in pr.protected_facts(rec["data"])]
        return out

    def ai_task(self, ctx: Context) -> str:
        op = ctx.op
        return (
            f"Operation {op['id']} - {op['name']}. {op['purpose']} {TASKS[self.op_id]} "
            "Plan records are SemanticRecords {summary, facts, links}: summary is prose and never establishes machine "
            "values. Each plan item is one SemanticRecord whose facts use its stable item ID as subject_id and "
            "include plan.item_id (value equal to subject_id), plan.order (integer, unique within plan.parent_id), "
            "plan.parent_id (string or null) and plan.objective (observable outcome). Use only predicates from "
            "predicate_conventions, assertion_type PLAN, integer story-time ticks or null with effective_to > "
            "effective_from, source_refs [] and links [] unless citing a provided pin. Reuse known_ids exactly; "
            "use null for an undecided POV/location rather than guessing. Never contradict protected facts. "
            "Return only JSON matching the output schema.")

    def ai_context(self, ctx: Context) -> dict:
        base = super().ai_context(ctx)
        src = Sources(ctx, list(ctx.resolved.values()))
        canon = src.canon()
        known = {
            "obligation_ids": sorted(known_obligations(src) or []),
            "event_ids": sorted({e for m in src.of("B03") for e in plot_events(m)}
                                | {i.item_id for r in src.of("B10") for i in items_of(r)}),
            "act_ids": sorted({i.item_id for r in src.of("B06") for i in items_of(r)}),
            "chapter_ids": sorted({i.item_id for r in src.of("B11") for i in items_of(r)}),
            "character_ids": sorted({i for r in canon if r["module_id"] == "A01" for i in pr.declared_ids(r)}),
            "location_ids": sorted({i for r in canon if r["module_id"] == "A04" for i in pr.declared_ids(r)}),
        }
        base["known_ids"] = known
        base["predicate_conventions"] = pr.registry_brief(ctx.contracts.predicate_registry)
        base["selected_features"] = (ctx.manifest or {}).get("features") or {}
        return base
