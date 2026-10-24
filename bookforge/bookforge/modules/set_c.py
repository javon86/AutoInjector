"""Set C handlers: Writing (C01-C12) and C-owned manuscript acceptance.

C01 is LOGIC: a deterministic context package from the pinned B11 outline plus approved A
canon, accepted E state and approved C12 text style, with protected facts copied verbatim and
a pinned output schema record. C02-C11 produce prose (AI slot or manual candidate) whose
OUTPUT candidate_events is always []; extracted events go to a separate C-owned CEventBundle
(see bookforge/c_events.py for the two commit paths). C12 is the text style controller; it is
never a visual style (D01).

C owns the accepted manuscript: ACCEPT records the accepted prose ref for its chapter/scene/
passage key in module state ``c_manuscript``. A C11 rewrite of accepted prose needs explicit
approval of the exact candidate, supersedes the replaced passage revision, marks its readers
(E snapshots, bundles, F/G/H consumers) stale and announces the superseded event IDs so E can
replay.
"""
from __future__ import annotations

import copy

from ..c_events import (BUNDLE_KIND, EXTRACTION_NS, PROSE_OPS, ai_extract, build_bundle, extraction_key,
                        find_bundles, predict_output_ref)
from ..canonical import canonical_bytes
from ..errors import BookforgeError
from ..providers import estimate_tokens
from . import register
from .base import Context, OperationHandler, Result

META_NS = "c_meta"            # record_id -> creation metadata (unit IDs, plan pins, rule pins)
MANUSCRIPT_NS = "c_manuscript"  # manuscript key -> accepted prose ref
STYLE_NS = "c_style"          # C12 scope_id -> accepted style ref
APPROVED = ("APPROVED", "LOCKED")
A_MODULES = tuple(f"A{i:02d}" for i in range(1, 19))
E_MODULES = tuple(f"E{i:02d}" for i in range(1, 13))
STYLE_SCOPES_FOR_CHAPTER = ("project", "book")
SCHEMA_RECORD_KIND = "OutputSchema"


# ====================================================================== plan helpers
def fact_value(item: dict, subject: str, predicate: str, default=None):
    for f in item.get("facts", []):
        if f["subject_id"] == subject and f["predicate"] == predicate:
            return f["value"]
    return default


def item_id_of(item: dict) -> str | None:
    for f in item.get("facts", []):
        if f["predicate"] == "plan.item_id" and f["value"] == f["subject_id"]:
            return f["subject_id"]
    return None


def find_item(items: list, item_id: str) -> tuple[int, dict] | None:
    for i, it in enumerate(items):
        if item_id_of(it) == item_id:
            return i, it
    return None


def siblings_in_order(items: list, item_id: str) -> list[str]:
    """IDs of plan items sharing item_id's plan.parent_id, ordered by plan.order then position."""
    hit = find_item(items, item_id)
    parent = fact_value(hit[1], item_id, "plan.parent_id") if hit else None
    rows = []
    for i, it in enumerate(items):
        iid = item_id_of(it)
        if iid is None or fact_value(it, iid, "plan.parent_id") != parent:
            continue
        order = fact_value(it, iid, "plan.order")
        rows.append((order if isinstance(order, int) else i, i, iid))
    return [r[2] for r in sorted(rows)]


def expected_position(items: list, item_id: str) -> str:
    seq = siblings_in_order(items, item_id)
    if len(seq) == 1:
        return "ONLY"
    idx = seq.index(item_id)
    return "FIRST" if idx == 0 else "LAST" if idx == len(seq) - 1 else "MIDDLE"


def facts_of(rec: dict) -> list[dict]:
    d = rec.get("data") or {}
    m = rec["module_id"]
    if m[0] == "A":
        return list(d.get("facts") or [])
    if m[0] == "E":
        return list((d.get("snapshot") or {}).get("facts") or [])
    if m == "C12":
        return list((d.get("style_profile") or {}).get("facts") or [])
    if m == "C01":
        return list(d.get("facts") or []) + list(d.get("protected_facts") or [])
    return []


def is_protected(rec: dict, fact: dict) -> bool:
    """A fact is protected when its record is LOCKED or an A protected_fact_flags entry names it
    (by predicate, subject_id, 'subject:predicate' or 'subject/predicate')."""
    if rec["lifecycle"] == "LOCKED":
        return True
    flags = set((rec.get("data") or {}).get("protected_fact_flags") or [])
    s, p = fact["subject_id"], fact["predicate"]
    return bool(flags & {p, s, f"{s}:{p}", f"{s}/{p}"})


def approval_covers(store, appr: dict | None, ref: dict) -> bool:
    """An I10/K09 approval names this exact candidate pin (prior source approval never counts).

    I10 names it as approval.subject_ref; a K09 checkpoint binds it in impact.source_versions,
    which are the source pins of the checkpoint's opening revision (decisions are later
    revisions of the same record).
    """
    if appr is None:
        return False
    if appr["module_id"] == "I10":
        return ((appr.get("data") or {}).get("approval") or {}).get("subject_ref") == ref
    if appr["module_id"] == "K09":
        return any(ref in (rev.get("source_refs") or [])
                   for rev in store.history(appr["project_id"], appr["branch_id"], appr["record_id"])
                   if rev["version"] <= appr["version"])
    return False


def _require_output(rec: dict | None, path: str):
    if rec is not None and rec["record_kind"] != "OUTPUT":
        raise BookforgeError("INVALID_INPUT", path, f"{path.rsplit('/', 1)[-1]} must pin a producer OUTPUT record, "
                             f"not a {rec['record_kind']} (an event bundle is not a manuscript input)",
                             status="REJECTED")


def _state_rev(ctx: Context, ns: str, key: str) -> int:
    row = ctx.store.query_one("SELECT revision FROM module_state WHERE project_id=? AND branch_id=? AND namespace=? "
                              "AND key=?", (ctx.project_id, ctx.branch_id, ns, key))
    return row["revision"] if row else 0


# ====================================================================== C01
@register("C01")
class ChapterContextLoader(OperationHandler):
    """C01 - deterministic, bounded context package (LOGIC; never calls an AI slot).

    facts: the chapter's plan facts (mandatory) followed by non-protected facts from records
    the chapter links, approved A canon about the chapter's subjects (chapter, POV, location,
    events, obligations), accepted E state heads for those subjects and approved C12 style for
    the chapter/project scope. protected_facts: verbatim copies of protected/locked canon.
    output_schema_ref pins a C01-owned schema record holding the prose OUTPUT schema.
    token_count is a deterministic estimate of the package. When a connected text slot exists,
    optional facts are omitted (with a finding) to fit its context; mandatory content that
    cannot fit blocks with CONTEXT_TOO_LARGE.
    """

    def create(self, ctx: Context) -> Result:
        if ctx.manual_candidate is not None:
            raise BookforgeError("INVALID_INPUT", "/manual_candidate", "C01 is deterministic; it accepts no manual "
                                 "context output", status="REJECTED")
        p = ctx.payload
        chapter_id = p["chapter_id"]
        outline = ctx.field_record("outline_ref")
        _require_output(outline, "/payload/outline_ref")
        chapters = outline["data"]["chapters"]
        hit = find_item(chapters, chapter_id)
        if hit is None:
            raise BookforgeError("INVALID_INPUT", "/payload/chapter_id", f"chapter {chapter_id!r} has no plan item "
                                 "(plan.item_id) in the pinned outline", status="REJECTED")
        idx, chapter = hit
        subjects = {chapter_id}
        for pred in ("plan.pov_id", "plan.location_id", "plan.event_ids", "plan.obligation_ids"):
            v = fact_value(chapter, chapter_id, pred)
            for x in (v if isinstance(v, list) else [v]):
                if isinstance(x, str) and x:
                    subjects.add(x)

        seen: set[bytes] = set()
        mandatory: list[dict] = []
        protected: list[dict] = []
        optional: list[dict] = []
        used: dict[tuple, dict] = {}
        findings: list[dict] = []

        def add(fact: dict, rec: dict | None, bucket: list):
            key = canonical_bytes(fact)
            if key in seen:
                return
            seen.add(key)
            if rec is not None:
                used[(rec["record_id"], rec["version"])] = rec["ref"]
                if bucket is optional and is_protected(rec, fact):
                    bucket = protected
            bucket.append(copy.deepcopy(fact))

        for f in chapter.get("facts", []):
            add(f, None, mandatory)

        def take(rec: dict, only_subjects: bool):
            for f in facts_of(rec):
                if not only_subjects or f["subject_id"] in subjects:
                    add(f, rec, optional)

        for i, link in enumerate(chapter.get("links", [])):
            try:
                rec = ctx.engine.resolve_ref(link, ctx.project_id, ctx.branch_id,
                                             f"/payload/outline_ref/chapters/{idx}/links/{i}")
            except BookforgeError as exc:
                raise BookforgeError("MISSING_INPUT", "/payload/outline_ref",
                                     f"outline link {i} of chapter {chapter_id} does not resolve: "
                                     f"{exc.errors[0]['message']}") from exc
            if rec["record_kind"] != "OUTPUT" or rec["module_id"][0] not in "ACE":
                continue
            if rec["lifecycle"] not in APPROVED:
                findings.append(ctx.finding("UNAPPROVED_SOURCE", f"linked {rec['module_id']} {rec['record_id']} "
                                            f"v{rec['version']} is {rec['lifecycle']}; excluded from context",
                                            severity="MAJOR", decision="UNKNOWN", source_refs=[rec["ref"]]))
                continue
            take(rec, only_subjects=False)
        for m in A_MODULES:
            for rec in ctx.records_of(m, approved_only=True):
                take(rec, only_subjects=True)
        heads = ctx.store.list_state(ctx.project_id, ctx.branch_id, "e_head")
        for key in sorted(heads):
            ref = (heads[key] or {}).get("ref")
            rec = ctx.store.get_record(ctx.project_id, ctx.branch_id, ref["record_id"], ref["version"]) if ref else None
            if rec and rec["data"]["entity_id"] in subjects:
                take(rec, only_subjects=True)
        styles = ctx.store.list_state(ctx.project_id, ctx.branch_id, STYLE_NS)
        for scope in (chapter_id,) + STYLE_SCOPES_FOR_CHAPTER:
            ref = (styles.get(scope) or {}).get("ref")
            if ref:
                rec = ctx.store.get_record(ctx.project_id, ctx.branch_id, ref["record_id"], ref["version"])
                if rec and rec["lifecycle"] in APPROVED:
                    take(rec, only_subjects=False)

        schema_ref = self._schema_ref(ctx)
        facts, token_count = self._fit_budget(ctx, mandatory, protected, optional, findings)
        rid = ctx.allocate_record_id()
        meta = {"op": "C01", "chapter_id": chapter_id, "outline_ref": outline["ref"]}
        ctx.on_commit(lambda tx: tx.put_state(ctx.project_id, ctx.branch_id, META_NS, rid, meta))
        return Result(data={"facts": facts, "protected_facts": protected, "output_schema_ref": schema_ref,
                            "token_count": token_count},
                      findings=findings, source_refs=list(used.values()), record_id=rid, transform="LOGIC")

    def _schema_ref(self, ctx: Context) -> dict:
        data = {"schema_kind": "C_PROSE_OUTPUT", "target_operations": list(PROSE_OPS),
                "output_schema": ctx.contracts.definition("C02", "OUTPUT")}
        for rec in ctx.store.list_records(ctx.project_id, ctx.branch_id, module_id="C01",
                                          record_kind=SCHEMA_RECORD_KIND):
            if rec["data"] == data:
                return rec["ref"]
        return ctx.stage_json("C01", data, record_kind=SCHEMA_RECORD_KIND)

    def _fit_budget(self, ctx: Context, mandatory, protected, optional, findings) -> tuple[list, int]:
        p = ctx.payload
        schema = ctx.contracts.definition("C02", "OUTPUT")

        def count(facts):
            return estimate_tokens(canonical_bytes({"facts": facts, "protected_facts": protected,
                                                    "instruction": p["instruction"],
                                                    "constraints": p.get("constraints", []),
                                                    "output_schema": schema}).decode("utf-8"))
        limits = [s["context_limit_tokens"] - s["max_output_tokens"] for s in ctx.engine.providers.slots()
                  if s["connected"] and s["healthy"] and "text" in s["capabilities"]]
        budget = max(limits) if limits else None
        facts = mandatory + optional
        if budget is None or count(facts) <= budget:
            return facts, count(facts)
        if count(mandatory) > budget:
            raise BookforgeError("CONTEXT_TOO_LARGE", "/payload/chapter_id",
                                 f"mandatory/protected context (~{count(mandatory)} tokens) exceeds the largest "
                                 f"connected slot budget ({budget}); split the job on scene boundaries")
        kept = list(optional)
        while kept and count(mandatory + kept) > budget:
            kept.pop()
        omitted = len(optional) - len(kept)
        findings.append(ctx.finding("OPTIONAL_OMITTED", f"{omitted} optional fact(s) omitted to fit {budget} tokens",
                                    severity="INFO", decision="PASS"))
        return mandatory + kept, count(mandatory + kept)

    def validate(self, ctx: Context, record: dict) -> list[dict]:
        out = []
        meta = ctx.get_state(META_NS, record["record_id"]) or {}
        oref = meta.get("outline_ref")
        outline = ctx.store.get_record(ctx.project_id, ctx.branch_id, oref["record_id"], oref["version"]) if oref else None
        if outline is None or outline["lifecycle"] not in APPROVED + ("SUPERSEDED",):
            out.append(ctx.finding("OUTLINE_APPROVAL", "context must be built from an approved outline revision",
                                   severity="BLOCKING", decision="FAIL", source_refs=[oref] if oref else []))
        known: set[bytes] = set()
        for ref in record["source_refs"]:
            src = ctx.store.get_record(ctx.project_id, ctx.branch_id, ref["record_id"], ref["version"])
            if src is not None:
                known.update(canonical_bytes(f) for f in facts_of(src))
        for i, f in enumerate(record["data"]["protected_facts"]):
            if canonical_bytes(f) not in known:
                out.append(ctx.finding("PROTECTED_VERBATIM", f"protected_facts/{i} is not a verbatim copy of a pinned "
                                       "source fact", severity="BLOCKING", decision="FAIL"))
        sref = record["data"]["output_schema_ref"]
        srec = ctx.store.get_record(ctx.project_id, ctx.branch_id, sref["record_id"], sref["version"])
        if srec is None or srec["module_id"] != "C01" or srec["record_kind"] != SCHEMA_RECORD_KIND:
            out.append(ctx.finding("OUTPUT_SCHEMA", "output_schema_ref must pin a C01 output schema record",
                                   severity="BLOCKING", decision="FAIL"))
        return out


# ====================================================================== C02-C11 prose
PROSE_TASK_SCHEMA = {
    "type": "object",
    "properties": {
        "text": {"type": "string"},
        "objective_assessments": {"type": "array", "items": {
            "type": "object",
            "properties": {"item_id": {"type": "string"}, "decision": {"enum": ["PASS", "FAIL", "UNKNOWN"]},
                           "message": {"type": "string"}},
            "required": ["item_id", "decision", "message"]}},
    },
    "required": ["text", "objective_assessments"],
}


class ProseWriter(OperationHandler):
    """Shared C02-C11 behavior: preconditions, prose production, event bundle, acceptance."""

    creative = True
    unit_field = "scene_id"
    plan_field: str | None = None    # payload field pinning the B plan
    plan_list: str | None = None     # list in the plan OUTPUT holding the unit's plan item
    manuscript_prefix = "scene"
    objectives_apply = False         # complete chapter/scene writers must satisfy plan objectives

    # ---------------------------------------------------------------- preconditions
    def unit_id(self, ctx: Context) -> str:
        return ctx.payload[self.unit_field]

    def plan_item(self, ctx: Context) -> tuple[dict | None, dict | None]:
        if not self.plan_field:
            return None, None
        rec = ctx.field_record(self.plan_field)
        if rec is None:
            return None, None
        _require_output(rec, f"/payload/{self.plan_field}")
        lst = self.items_list(rec)
        items = (rec["data"] or {}).get(lst) if lst else None
        if items is None:
            return rec, None
        hit = find_item(items, self.unit_id(ctx))
        if hit is None:
            raise BookforgeError("INVALID_INPUT", f"/payload/{self.unit_field}",
                                 f"{self.unit_id(ctx)!r} has no plan item in the pinned {rec['module_id']} plan",
                                 status="REJECTED")
        return rec, hit[1]

    def items_list(self, rec: dict) -> str | None:
        return self.plan_list

    def preconditions(self, ctx: Context) -> dict:
        plan_rec, _ = self.plan_item(ctx)
        ctxrec = ctx.field_record("context_ref")
        _require_output(ctxrec, "/payload/context_ref")
        meta = {"op": ctx.op_id, "unit_id": self.unit_id(ctx), "manuscript_key": self.manuscript_key(ctx),
                "plan_ref": plan_rec["ref"] if plan_rec else None,
                "plan_list": self.items_list(plan_rec) if plan_rec else None,
                "context_ref": ctxrec["ref"] if ctxrec else None}
        return meta

    def manuscript_key(self, ctx: Context) -> str:
        return f"{self.manuscript_prefix}:{self.unit_id(ctx)}"

    # ---------------------------------------------------------------- CREATE
    def create(self, ctx: Context) -> Result:
        meta = self.preconditions(ctx)
        data, transform, resource = self.produce(ctx)
        rid = ctx.allocate_record_id()
        result = Result(data=data, transform=transform, resource=resource, record_id=rid)
        prose_ref = predict_output_ref(ctx, result)
        bundle_ref, bundle, findings, pending = None, None, [], None
        try:
            raw, _res = ai_extract(ctx, data["text"], op_id=ctx.op_id, hints={"unit_id": meta["unit_id"]})
            bundle, findings = build_bundle(ctx, prose_ref, data["text"], raw, op_id=ctx.op_id)
            bundle_ref = ctx.stage_json(ctx.op_id, bundle, record_kind=BUNDLE_KIND, source_refs=[prose_ref])
        except BookforgeError as exc:
            pending = exc.errors[0]
        if bundle_ref:
            findings.append(ctx.finding("EVENT_BUNDLE", f"{len(bundle['events'])} candidate event(s) stored in "
                                        f"bundle {bundle_ref['record_id']}", severity="INFO", decision="PASS",
                                        source_refs=[bundle_ref]))
        else:
            findings.append(ctx.finding(
                "EVENT_EXTRACTION_PENDING", f"prose kept as DRAFT checkpoint with candidate_events=[]; event "
                f"extraction pending ({pending['code']}: {pending['message']}); retry extraction without "
                "regenerating prose", severity="MINOR", decision="UNKNOWN"))
            result.unresolved = [f"{ctx.op_id}:event_extraction"]
        result.findings = findings
        key = extraction_key(prose_ref)
        state = {"status": "DONE", "bundle_ref": bundle_ref,
                 "response": ctx.engine._response(ctx.request["request_id"], "attempt-in-create", "DRAFT",
                                                  [bundle_ref], bundle, findings, [], [prose_ref], [], None)} \
            if bundle_ref else {"status": "PENDING", "error": pending}

        def commit(tx):
            row = tx.execute("SELECT content_hash FROM records WHERE project_id=? AND branch_id=? AND record_id=? "
                             "AND version=1", (ctx.project_id, ctx.branch_id, rid)).fetchone()
            if row is None or row["content_hash"] != prose_ref["content_hash"]:
                raise BookforgeError("INTERNAL_ERROR", "", "prose pin cited by the event bundle does not match the "
                                     "stored prose record")
            tx.put_state(ctx.project_id, ctx.branch_id, META_NS, rid, meta)
            tx.put_state(ctx.project_id, ctx.branch_id, EXTRACTION_NS, key, state)
            if bundle_ref:
                tx.insert_edge(project_id=ctx.project_id, branch_id=ctx.branch_id, producer_ref=prose_ref,
                               consumer_operation=ctx.op_id, consumer_ref=bundle_ref, paths=["/text"], kind="HARD",
                               stage="DRAFT")
        ctx.on_commit(commit)
        return result

    def produce(self, ctx: Context) -> tuple[dict, str, dict | None]:
        if ctx.manual_candidate is not None:
            data = copy.deepcopy(ctx.manual_candidate)
            if not data["text"].strip():
                raise BookforgeError("INVALID_INPUT", "/manual_candidate/text", "prose text must be nonempty",
                                     status="REJECTED")
            return data, "MANUAL", None
        ctxrec = ctx.field_record("context_ref")
        protected = list((ctxrec or {}).get("data", {}).get("protected_facts") or []) if ctxrec else []
        context = self.ai_context(ctx)
        _, item = self.plan_item(ctx)
        context["plan_item"] = item
        try:
            out, resource = ctx.ai_generate(task=self.ai_task(ctx) + " Assess each plan objective of the unit "
                                            "(PASS/FAIL/UNKNOWN) in objective_assessments.",
                                            output_schema=PROSE_TASK_SCHEMA, context=context,
                                            protected_facts=protected)
        except BookforgeError as exc:
            if exc.code == "CAPABILITY_UNAVAILABLE":
                raise BookforgeError("CAPABILITY_UNAVAILABLE", "/payload", f"{ctx.op_id} prose needs an AI slot; "
                                     "configure AI-1..AI-3 or supply a manual candidate",
                                     unresolved=[f"{ctx.op_id}:manual_candidate"]) from exc
            raise
        text = out.get("text") if isinstance(out, dict) else None
        if not isinstance(text, str) or not text.strip():
            # A content problem, not a connection problem: the AI answered, but with no text. INVALID_INPUT is not
            # busy-retried (re-asking a paid model in a loop) and tells the author what actually happened.
            raise BookforgeError("INVALID_INPUT", "/text", "the AI answered with no chapter text (empty prose), so "
                                 "nothing was saved; ask it again or write the chapter yourself", status="REJECTED")
        findings = []
        plan_ref = [ctx.field_record(self.plan_field)["ref"]] if self.plan_field and ctx.field_record(
            self.plan_field) else []
        for n, a in enumerate(out.get("objective_assessments") or []):
            if not isinstance(a, dict) or a.get("decision") not in ("PASS", "FAIL", "UNKNOWN"):
                continue
            findings.append({"id": f"{ctx.op_id}-OBJ-{n + 1}", "rule_id": f"OBJECTIVE:{a.get('item_id') or '?'}",
                             "severity": "INFO" if a["decision"] == "PASS" else "MAJOR", "decision": a["decision"],
                             "message": str(a.get("message") or "objective assessment")[:2000] or "assessment",
                             "evidence": [], "source_refs": plan_ref, "confidence": None})
        return {"text": text, "candidate_events": [], "findings": findings}, "AI", resource

    # ---------------------------------------------------------------- VALIDATE / ACCEPT
    def _review_items(self, ctx: Context, record: dict) -> tuple[list[dict], bool]:
        """Owner semantic findings plus whether an explicit review/approval is required."""
        out, review = [], False
        data = record["data"]
        meta = ctx.get_state(META_NS, record["record_id"]) or {}
        own = {f["rule_id"]: f for f in data.get("findings", [])}
        for f in data.get("findings", []):
            if f["rule_id"].startswith("PROTECTED") and f["decision"] == "FAIL":
                out.append(ctx.finding("PROTECTED_CONTRADICTION", f"prose contradicts a protected fact: {f['message']}",
                                       severity="BLOCKING", decision="FAIL", evidence=f["evidence"]))
            elif f["rule_id"].startswith("PROTECTED") and f["decision"] == "UNKNOWN":
                review = True
        if self.objectives_apply and meta.get("plan_ref"):
            pref = meta["plan_ref"]
            plan = ctx.store.get_record(ctx.project_id, ctx.branch_id, pref["record_id"], pref["version"])
            hit = find_item((plan or {}).get("data", {}).get(meta.get("plan_list") or "", []) or [], meta["unit_id"])
            objective = fact_value(hit[1], meta["unit_id"], "plan.objective") if hit else None
            if objective is not None:
                a = own.get(f"OBJECTIVE:{meta['unit_id']}")
                if a is None or a["decision"] == "UNKNOWN":
                    review = True
                    out.append(ctx.finding("OBJECTIVE_REVIEW", f"objective {objective!r} is not assessed as "
                                           "satisfied; an explicit review approval of this candidate is required",
                                           severity="MAJOR", decision="UNKNOWN", source_refs=[pref]))
                elif a["decision"] == "FAIL":
                    out.append(ctx.finding("OBJECTIVE_UNSATISFIED", f"objective {objective!r} unsatisfied: "
                                           f"{a['message']}", severity="BLOCKING", decision="FAIL",
                                           source_refs=[pref]))
                else:
                    out.append(ctx.finding("OBJECTIVE", f"objective {objective!r} satisfied", severity="INFO",
                                           decision="PASS", source_refs=[pref]))
        state = ctx.get_state(EXTRACTION_NS, extraction_key(record["ref"])) or {}
        if state.get("status") != "DONE":
            out.append(ctx.finding("EVENT_EXTRACTION_PENDING", "no event bundle for this prose revision yet; E state "
                                   "acceptance waits for extraction", severity="MINOR", decision="UNKNOWN"))
        return out, review

    def validate(self, ctx: Context, record: dict) -> list[dict]:
        return self._review_items(ctx, record)[0]

    def requires_explicit_approval(self, ctx: Context, record: dict) -> bool:
        return self._review_items(ctx, record)[1]

    def accept_gate(self, ctx: Context, record: dict, approval: dict | None) -> list[dict]:
        appr = ctx.resolved.get("/payload/approval_ref")
        if appr is not None and self.requires_explicit_approval(ctx, record) and not approval_covers(ctx.store, appr, record["ref"]):
            return [ctx.finding("APPROVAL_SUBJECT", "the approval must name this exact candidate revision; prior "
                                "source approval cannot authorize changed output", severity="BLOCKING",
                                decision="FAIL", source_refs=[appr["ref"]])]
        return []

    def on_accept(self, ctx: Context, record: dict, tx) -> None:
        meta = ctx.get_state(META_NS, record["record_id"]) or {}
        key = meta.get("manuscript_key") or f"{record['module_id']}:{record['record_id']}"
        tx.put_state(ctx.project_id, ctx.branch_id, MANUSCRIPT_NS, key,
                     {"ref": record["ref"], "op": record["module_id"], "unit_id": meta.get("unit_id")})


@register("C02")
class ChapterWriter(ProseWriter):
    unit_field = "chapter_id"
    plan_field = "outline_ref"
    plan_list = "chapters"
    manuscript_prefix = "chapter"
    objectives_apply = True

    def preconditions(self, ctx: Context) -> dict:
        meta = super().preconditions(ctx)
        ctxrec = ctx.field_record("context_ref")
        if ctxrec and ctxrec["module_id"] == "C01":
            cmeta = ctx.get_state(META_NS, ctxrec["record_id"]) or {}
            if cmeta and (cmeta.get("chapter_id") != ctx.payload["chapter_id"]
                          or cmeta.get("outline_ref") != ctx.payload["outline_ref"]):
                raise BookforgeError("INVALID_INPUT", "/payload/context_ref", "context package was built for a "
                                     "different chapter or outline revision", status="REJECTED")
        if ctx.manual_candidate is None:
            # The writing brief (P7/P8/P17/P11-lite): voice cards of the characters present, the scene cards, the
            # POV character's name and planned backstory. Read once here; only IDs and numbers go into the meta.
            from ..chapter_brief import build as build_brief  # noqa: PLC0415
            brief, info = build_brief(ctx.store, ctx.project_id, ctx.branch_id, ctx.field_record("outline_ref"),
                                      ctx.payload["chapter_id"])
            ctx.writing_brief = brief
            meta["brief"] = info
        return meta

    def ai_context(self, ctx: Context) -> dict:
        out = super().ai_context(ctx)
        brief = getattr(ctx, "writing_brief", None)
        if brief:
            out["writing_brief"] = brief
        return out

    def ai_task(self, ctx: Context) -> str:
        task = super().ai_task(ctx)
        brief = getattr(ctx, "writing_brief", None)
        if brief and brief.get("rules"):
            task += (" context.writing_brief is the plan for HOW to write this chapter: " + " ".join(brief["rules"]))
        return task


@register("C03")
class SceneWriter(ProseWriter):
    plan_field = "scene_plan_ref"
    plan_list = "scenes"
    objectives_apply = True


@register("C04")
class DialogueWriter(ProseWriter):
    plan_field = "scene_plan_ref"
    plan_list = "scenes"

    def manuscript_key(self, ctx):
        return f"dialogue:{self.unit_id(ctx)}"


@register("C05")
class DescriptionWriter(ProseWriter):
    plan_field = "scene_plan_ref"
    plan_list = "scenes"

    def manuscript_key(self, ctx):
        return f"description:{self.unit_id(ctx)}"


@register("C06")
class ActionWriter(ProseWriter):
    """Action/combat: A09 power rules only when uses_magic=true, A11 only when is_combat=true.

    Nonmagical action needs neither the magic feature nor an A09 record. An applicable rule
    record must be approved canon before the prose can be accepted.
    """
    plan_field = "action_plan_ref"

    def manuscript_key(self, ctx):
        return f"action:{self.unit_id(ctx)}"

    def items_list(self, rec):
        return "scenes" if rec["module_id"] == "B12" else None

    def preconditions(self, ctx: Context) -> dict:
        p = ctx.payload
        meta = super().preconditions(ctx)
        rules = []
        for flag, field, producer in (("uses_magic", "power_rules_ref", "A09"), ("is_combat", "combat_rules_ref", "A11")):
            rec = ctx.field_record(field)
            if p.get(flag) is True:
                if rec is None:
                    raise BookforgeError("MISSING_INPUT", f"/payload/{field}", f"{flag}=true requires {producer} rules")
                _require_output(rec, f"/payload/{field}")
                rules.append(rec["ref"])
        meta["rule_refs"] = rules
        return meta

    def _review_items(self, ctx, record):
        out, review = super()._review_items(ctx, record)
        meta = ctx.get_state(META_NS, record["record_id"]) or {}
        for ref in meta.get("rule_refs", []):
            rec = ctx.store.get_record(ctx.project_id, ctx.branch_id, ref["record_id"], ref["version"])
            if rec is None or rec["lifecycle"] not in APPROVED:
                out.append(ctx.finding("RULE_AUTHORITY", f"{ref['module_id']} rules {ref['record_id']} "
                                       f"v{ref['version']} must be approved canon", severity="BLOCKING",
                                       decision="FAIL", source_refs=[ref]))
        return out, review


@register("C07")
class InteriorWriter(ProseWriter):
    plan_field = "emotion_plan_ref"

    def manuscript_key(self, ctx):
        return f"interior:{self.unit_id(ctx)}"

    def items_list(self, rec):
        return "scenes" if rec["module_id"] == "B12" else None


@register("C08")
class TransitionWriter(ProseWriter):
    """Transitions connect two distinct scenes and never introduce intervening events
    (any extracted event is flagged for review in the bundle)."""

    def unit_id(self, ctx):
        return f"{ctx.payload['from_scene_id']}->{ctx.payload['to_scene_id']}"

    def manuscript_key(self, ctx):
        return f"transition:{self.unit_id(ctx)}"

    def preconditions(self, ctx):
        if ctx.payload["from_scene_id"] == ctx.payload["to_scene_id"]:
            raise BookforgeError("INVALID_INPUT", "/payload/to_scene_id", "a transition joins two different scenes",
                                 status="REJECTED")
        return super().preconditions(ctx)


class BoundaryWriter(ProseWriter):
    """C09/C10 chapter boundaries checked against the pinned outline order."""
    unit_field = "chapter_id"
    plan_field = "outline_ref"
    plan_list = "chapters"
    neighbour_field = ""
    forbidden_for: tuple = ()

    def preconditions(self, ctx):
        meta = super().preconditions(ctx)
        p = ctx.payload
        pos = p["chapter_position"]
        outline = ctx.field_record("outline_ref")
        expected = expected_position(outline["data"]["chapters"], p["chapter_id"])
        if pos != expected:
            raise BookforgeError("INVALID_INPUT", "/payload/chapter_position", f"outline places {p['chapter_id']} "
                                 f"as {expected}, not {pos}", status="REJECTED")
        neighbour = ctx.field_record(self.neighbour_field)
        if pos in self.forbidden_for and self.neighbour_field in p:
            raise BookforgeError("INVALID_INPUT", f"/payload/{self.neighbour_field}",
                                 f"a {pos} chapter has no {self.neighbour_field.removesuffix('_ref')}",
                                 status="REJECTED")
        if pos not in self.forbidden_for and neighbour is None:
            raise BookforgeError("MISSING_INPUT", f"/payload/{self.neighbour_field}",
                                 f"a {pos} chapter needs {self.neighbour_field}")
        if neighbour is not None and neighbour["module_id"][0] == "C":
            _require_output(neighbour, f"/payload/{self.neighbour_field}")
        return meta


@register("C09")
class OpeningWriter(BoundaryWriter):
    neighbour_field = "previous_ending_ref"
    forbidden_for = ("FIRST", "ONLY")

    def manuscript_key(self, ctx):
        return f"opening:{self.unit_id(ctx)}"


@register("C10")
class EndingWriter(BoundaryWriter):
    neighbour_field = "next_chapter_ref"
    forbidden_for = ("LAST", "ONLY")

    def manuscript_key(self, ctx):
        return f"ending:{self.unit_id(ctx)}"


@register("C11")
class RewriteWriter(ProseWriter):
    """Bounded rewrite of one stored C passage (passage_id must name passage_ref's record).

    Replacing accepted prose needs explicit approval of the exact candidate; ACCEPT then
    supersedes the replaced revision, takes over its manuscript key, marks its readers stale
    and announces superseded event IDs for E replay.
    """
    unit_field = "passage_id"

    def preconditions(self, ctx):
        meta = super().preconditions(ctx)
        passage = ctx.field_record("passage_ref")
        _require_output(passage, "/payload/passage_ref")
        if ctx.payload["passage_id"] != passage["record_id"]:
            raise BookforgeError("INVALID_INPUT", "/payload/passage_id", "passage_id must name the pinned passage "
                                 "record (matching base text)", status="REJECTED")
        if not (passage["data"].get("text") or "").strip():
            raise BookforgeError("INVALID_INPUT", "/payload/passage_ref", "passage has no base text to rewrite",
                                 status="REJECTED")
        pmeta = ctx.get_state(META_NS, passage["record_id"]) or {}
        meta["passage_ref"] = passage["ref"]
        meta["manuscript_key"] = pmeta.get("manuscript_key") or f"passage:{passage['record_id']}"
        return meta

    def _review_items(self, ctx, record):
        out, review = super()._review_items(ctx, record)
        meta = ctx.get_state(META_NS, record["record_id"]) or {}
        pref = meta.get("passage_ref")
        if pref:
            old = ctx.store.get_record(ctx.project_id, ctx.branch_id, pref["record_id"], pref["version"])
            if old and old["lifecycle"] in APPROVED:
                review = True
                out.append(ctx.finding("REPLACES_ACCEPTED", "replaces accepted prose; needs approval of this exact "
                                       "candidate and E replay of derived events", severity="MAJOR",
                                       decision="UNKNOWN", source_refs=[pref]))
        return out, review

    def on_accept(self, ctx, record, tx):
        super().on_accept(ctx, record, tx)
        meta = ctx.get_state(META_NS, record["record_id"]) or {}
        pref = meta.get("passage_ref")
        if not pref:
            return
        old = ctx.store.get_record(ctx.project_id, ctx.branch_id, pref["record_id"], pref["version"])
        if old and old["lifecycle"] in APPROVED:
            tx.set_lifecycle(pref, "SUPERSEDED")
        stale = []
        for e in tx.execute("SELECT * FROM dependency_edges WHERE project_id=? AND branch_id=? AND producer_record_id=? "
                            "AND producer_version=?", (ctx.project_id, ctx.branch_id, pref["record_id"],
                                                       pref["version"])).fetchall():
            if e["consumer_record_id"] == record["record_id"]:
                continue
            tx.mark_stale(ctx.project_id, ctx.branch_id, e["consumer_record_id"], e["consumer_version"],
                          f"source passage {pref['record_id']} v{pref['version']} replaced by C11 "
                          f"{record['record_id']}")
            stale.append({"record_id": e["consumer_record_id"], "version": e["consumer_version"],
                          "operation": e["consumer_operation"]})
        superseded = sorted({ev["event_id"] for b in find_bundles(ctx.store, ctx.project_id, ctx.branch_id, pref)
                             for ev in b["data"]["events"]})
        tx.insert_outbox(ctx.project_id, ctx.branch_id, "c.prose_replaced",
                         {"replaced": pref, "replacement": record["ref"], "superseded_event_ids": superseded,
                          "stale": stale})


# ====================================================================== C12
@register("C12")
class WritingStyleController(OperationHandler):
    """C12 text style profile for one scope (never a visual style; D01 owns those).

    HYBRID: the style profile comes from the AI slot or a manual candidate; style_goal must
    match the request. AI output cannot invent references (links/source pins are cleared).
    Acceptance publishes the profile as the scope's current style; only its consumers are
    affected by later changes.
    """
    creative = True

    def create(self, ctx: Context) -> Result:
        result = super().create(ctx)
        data = result.data
        if data.get("style_goal") != ctx.payload["style_goal"]:
            raise BookforgeError("INVALID_INPUT", "/manual_candidate/style_goal",
                                 "style_goal must equal the requested style goal", status="REJECTED")
        if result.transform == "AI":
            prof = data.get("style_profile") or {}
            prof["links"] = []
            for f in prof.get("facts", []):
                f["source_refs"] = []
        rid = ctx.allocate_record_id()
        result.record_id = rid
        meta = {"op": "C12", "scope_id": ctx.payload["scope_id"]}
        ctx.on_commit(lambda tx: tx.put_state(ctx.project_id, ctx.branch_id, META_NS, rid, meta))
        return result

    def validate(self, ctx: Context, record: dict) -> list[dict]:
        out = []
        prof = record["data"]["style_profile"]
        for i, link in enumerate(prof.get("links", [])):
            if link["owner"] == "D":
                out.append(ctx.finding("VISUAL_STYLE", f"style_profile/links/{i} pins D-owned visual content; C12 is "
                                       "a text style and cannot substitute for D01", severity="BLOCKING",
                                       decision="FAIL"))
        if not prof.get("summary", "").strip():
            out.append(ctx.finding("STYLE_SUMMARY", "style profile summary must state the rules", severity="BLOCKING",
                                   decision="FAIL"))
        return out

    def on_accept(self, ctx: Context, record: dict, tx) -> None:
        meta = ctx.get_state(META_NS, record["record_id"]) or {}
        scope = meta.get("scope_id")
        if scope:
            tx.put_state(ctx.project_id, ctx.branch_id, STYLE_NS, scope, {"ref": record["ref"]},
                         expected_revision=_state_rev(ctx, STYLE_NS, scope))
