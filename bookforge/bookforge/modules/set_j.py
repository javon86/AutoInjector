"""Set J handlers: Canon Refinement Reconciliation (J01-J11).

J owns reconciliation proposals and decision records; it never takes ownership of A/C/E/D
content. Pipeline (field bindings in interface_registry):

  J01/J02 conflicts -> J04 options (+ owner patches) -> J05 ranked RepairPlans -> J07 patch
  proposals -> J08 prepare/commit receipts -> J10 revalidation;  J06 impact, J09 passages,
  J11 bounded user decisions.

Claims are typed Fact assertions (subject_id, predicate, value, assertion_type, effective
interval) found anywhere in a record's data, plus typed events (entity_ids/path/after/branch_id/
story_time; only ACCEPTED events count as FACT). Two claims conflict only for the same subject/
predicate/branch, both FACT, overlapping half-open effective intervals and different typed values.
BELIEF/PLAN and other branches are never automatic conflicts; disjoint intervals are TEMPORAL.

J08 multi-owner commit (single shared storage kernel, the default compatible implementation):
  1. CREATE (prepare): verify the approved J07 proposal, exact base pins (no intervening
     revision), protected authorization (K09/I10 covering the exact proposal; expiry checked),
     apply the patches to copies, check each owner's OUTPUT schema and stage every owner revision
     as a DRAFT candidate of the *owner's* record (ctx.stage_revision keeps owner/module_id) - all
     in ONE transaction. Approved heads are untouched, so nothing becomes visible; a crash leaves
     no staged participant at all.
  2. Each owner VALIDATEs its own staged revision through its own operation (owner rules).
  3. ACCEPT of the J08 record (explicit approval_ref required) re-checks every participant and
     the authorization, then promotes all participants to their approved heads, records
     approvals/audit receipts, invalidates exactly the consumers of changed paths and writes the
     commit receipts - inside the single ACCEPT transaction. Any failure rolls everything back:
     an interrupted commit never exposes a mixed canon/manuscript state.
  4. UPDATE records the outcome as a new J08 revision (COMMITTED with receipts, or COMPENSATED,
     which rejects still-unpromoted staged candidates only when their postconditions match).
"""
from __future__ import annotations

import copy
import json
import re
import unicodedata
from datetime import timedelta

from ..canonical import canonical_bytes, resolve_pointer, sha256_json
from ..errors import BookforgeError
from ..j_approvals import (APPROVAL_MODULES, approval_problem, approval_view, check_approval, covers, now_utc,
                           waiver_applies)
from ..spans import anchored_patches, make_span, occurrences, reanchor, record_text, verify_span
from ..store import new_id
from . import get_handler, register
from .base import Context, OperationHandler, Result

PROSE_MODULES = tuple(f"C{i:02d}" for i in range(2, 12))
PREPARE_NS, COMMIT_NS, ITER_NS, WAIVER_NS = "j08.prepare", "j08.commits", "j10.iterations", "j.waivers"
MAX_REPAIR_ITERATIONS = 3
NEAR_DUP = 0.92
TOKEN_RE = re.compile(r"\w+(?:['’]\w+)*", re.UNICODE)


# ============================================================================== claims
def _esc(k) -> str:
    return str(k).replace("~", "~0").replace("/", "~1")


def walk_claims(value, path=""):
    if isinstance(value, dict):
        keys = set(value)
        if {"subject_id", "predicate", "value", "assertion_type"} <= keys:
            yield "fact", path, value
            return
        if {"event_id", "entity_ids", "path", "after"} <= keys:
            yield "event", path, value
            return
        for k, v in value.items():
            yield from walk_claims(v, f"{path}/{_esc(k)}")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from walk_claims(v, f"{path}/{i}")


def claims_of(rec: dict) -> list[dict]:
    out = []
    for kind, path, obj in walk_claims(rec.get("data")):
        if kind == "fact":
            out.append({"subject": obj["subject_id"], "predicate": obj["predicate"], "value": obj["value"],
                        "kind": obj["assertion_type"], "frm": obj.get("effective_from"),
                        "to": obj.get("effective_to"), "branch": rec["branch_id"], "path": path + "/value",
                        "rec": rec})
        else:
            for ent in obj["entity_ids"]:
                out.append({"subject": ent, "predicate": obj["path"], "value": obj["after"],
                            "kind": "FACT" if obj.get("status") == "ACCEPTED" else "PLAN",
                            "frm": obj.get("story_time"), "to": None, "branch": obj.get("branch_id", rec["branch_id"]),
                            "path": path + "/after", "rec": rec})
    return out


def overlaps(a: dict, b: dict) -> bool:
    lo_ok = a["frm"] is None or b["to"] is None or a["frm"] < b["to"]
    hi_ok = b["frm"] is None or a["to"] is None or b["frm"] < a["to"]
    return lo_ok and hi_ok


def same_value(a, b) -> bool:
    return canonical_bytes(a) == canonical_bytes(b)


def classify(a: dict, b: dict) -> str | None:
    """None when not comparable; else HARD_CONFLICT/TEMPORAL_MISMATCH/BRANCH_MISMATCH/AMBIGUOUS/NON_CONFLICT."""
    if (a["subject"], a["predicate"]) != (b["subject"], b["predicate"]):
        return None
    if same_value(a["value"], b["value"]):
        return "NON_CONFLICT"
    if a["branch"] != b["branch"]:
        return "BRANCH_MISMATCH"
    kinds = {a["kind"], b["kind"]}
    if "UNKNOWN" in kinds:
        return "AMBIGUOUS"
    if kinds != {"FACT"}:
        return "NON_CONFLICT"  # BELIEF/PLAN stay labeled; never an automatic conflict with FACT
    if not overlaps(a, b):
        return "TEMPORAL_MISMATCH"
    return "HARD_CONFLICT"


def claim_key(c: dict) -> str:
    return f"{c['rec']['record_id']}@{c['rec']['version']}#{c['path']}"


def pairs(claims: list[dict]):
    for i in range(len(claims)):
        for j in range(i + 1, len(claims)):
            if claims[i]["rec"]["record_id"] == claims[j]["rec"]["record_id"] and \
                    claims[i]["path"] == claims[j]["path"]:
                continue
            yield claims[i], claims[j]


def describe(c: dict) -> dict:
    return {"record": claim_key(c), "subject": c["subject"], "predicate": c["predicate"], "value": c["value"],
            "assertion_type": c["kind"], "effective": [c["frm"], c["to"]], "branch": c["branch"]}


def scoped(ctx: Context, claims: list[dict]) -> list[dict]:
    scope = ctx.payload.get("branch_scope")
    return [c for c in claims if scope is None or c["branch"] == scope]


def ref_key(ref: dict) -> tuple:
    return ref["record_id"], ref["version"], ref["content_hash"]


def uniq_refs(refs) -> list[dict]:
    seen, out = set(), []
    for r in refs:
        if r is not None and ref_key(r) not in seen:
            seen.add(ref_key(r))
            out.append(r)
    return out


def set_pointer(doc, ptr: str, value):
    """Replace the existing value at ptr in a deep copy of doc (patches never add structure)."""
    out = copy.deepcopy(doc)
    if ptr in ("", "/"):
        raise BookforgeError("INVALID_INPUT", "/path", "whole-record replacement is not a localized patch",
                             status="REJECTED")
    parts = [p.replace("~1", "/").replace("~0", "~") for p in ptr[1:].split("/")]
    cur = out
    try:
        for p in parts[:-1]:
            cur = cur[int(p)] if isinstance(cur, list) else cur[p]
        last = parts[-1]
        if isinstance(cur, list):
            idx = int(last)
            if not 0 <= idx < len(cur):
                raise IndexError(idx)
            cur[idx] = value
        elif isinstance(cur, dict) and last in cur:
            cur[last] = value
        else:
            raise KeyError(last)
    except (KeyError, IndexError, ValueError, TypeError) as exc:
        raise BookforgeError("INVALID_INPUT", "/path", f"patch path {ptr} does not exist in the target",
                             status="REJECTED") from exc
    return out


def authority(rec: dict, claim: dict | None = None) -> int:
    """locked approved canon > approved dated canon > verified E events > accepted manuscript > proposals."""
    lc = rec["lifecycle"]
    approved = lc in ("APPROVED", "LOCKED") and not rec.get("stale")
    if rec["owner"] == "A" and lc == "LOCKED":
        return 5
    if rec["owner"] == "A" and approved:
        return 4
    if rec["owner"] == "E" and approved:
        return 3
    if rec["owner"] == "C" and approved:
        return 2
    return 1


def flagged(rec: dict, path: str) -> bool:
    """True when a patch path touches a fact listed in the record's protected_fact_flags."""
    data = rec.get("data") or {}
    flags = set(data.get("protected_fact_flags") or []) if isinstance(data, dict) else set()
    if not flags:
        return False
    m = re.match(r"^(.*)/value$", path)
    if not m:
        return False
    try:
        f = resolve_pointer(data, m.group(1))
    except (KeyError, IndexError, ValueError):
        return False
    return isinstance(f, dict) and bool({f.get("predicate"), f.get("subject_id"),
                                         f"{f.get('subject_id')}:{f.get('predicate')}", "*"} & flags)


def is_protected(rec: dict, paths: list[str]) -> bool:
    return rec["lifecycle"] == "LOCKED" or any(flagged(rec, p) for p in paths)


def norm_text(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).casefold().split())


def tokset(text: str) -> set:
    return {t for t in TOKEN_RE.findall(norm_text(text))}


def jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


# ============================================================================== base
class JHandler(OperationHandler):
    manual_allowed = True

    def resolve(self, ctx: Context, ref: dict, path: str) -> dict:
        return ctx.engine.resolve_ref(ref, ctx.project_id, ctx.branch_id, path)

    def evidence(self, ctx: Context) -> list[dict]:
        return ctx.field_records("evidence_refs")

    def create(self, ctx: Context) -> Result:
        if ctx.manual_candidate is not None:
            if not self.manual_allowed:
                raise BookforgeError("INVALID_INPUT", "/manual_candidate",
                                     f"{ctx.op_id} is deterministic LOGIC; manual results are not accepted",
                                     status="REJECTED")
            return Result(data=copy.deepcopy(ctx.manual_candidate), transform="MANUAL")
        return self.run(ctx)

    def run(self, ctx: Context) -> Result:  # pragma: no cover - overridden
        raise NotImplementedError

    def validate(self, ctx: Context, record: dict) -> list[dict]:
        out = []
        data = record["data"]
        try:
            pairs_ = anchored_patches({"findings": data.get("findings", []),
                                       "patches": data.get("patches") or data.get("patch_proposals") or []})
        except BookforgeError as exc:
            return [ctx.finding(exc.code, exc.errors[0]["message"], severity="BLOCKING")]
        for p, ev in pairs_:
            try:
                tgt = self.resolve(ctx, p["target_ref"], "/target_ref")
                why = verify_span(record_text(tgt), ev)
            except BookforgeError as exc:
                why = exc.errors[0]["message"]
            if why:
                out.append(ctx.finding("HASH_MISMATCH", f"patch {p['patch_id']}: {why}", severity="BLOCKING"))
        return out


# ============================================================================== J01
@register("J01")
class ContradictionDetector(JHandler):
    def run(self, ctx: Context) -> Result:
        claims = []
        for rec in ctx.field_records("claim_refs"):
            claims.extend(claims_of(rec))
        claims = scoped(ctx, claims)
        cands, findings, skipped = [], [], {}
        for a, b in pairs(claims):
            cls = classify(a, b)
            if cls is None:
                continue
            if cls != "HARD_CONFLICT":
                skipped[cls] = skipped.get(cls, 0) + 1
                continue
            cid = "cc-" + sha256_json(sorted([claim_key(a), claim_key(b)]) + [a["subject"], a["predicate"]])[:16]
            refs = uniq_refs([a["rec"]["ref"], b["rec"]["ref"]])
            cands.append({"id": cid, "source_refs": refs, "decision": "CONFLICT", "confidence": 1.0})
            findings.append(ctx.finding("HARD_CONFLICT", json.dumps({"conflict_id": cid, "claims": [describe(a),
                                        describe(b)]}, sort_keys=True), severity="MAJOR", decision="FAIL",
                                        source_refs=refs, confidence=1.0))
        if skipped:
            findings.append(ctx.finding("NON_CONFLICTS", "compared but not conflicting: " + ", ".join(
                f"{k}={v}" for k, v in sorted(skipped.items())), severity="INFO", decision="PASS"))
        return Result(data={"conflict_candidates": cands, "evidence_refs": [r["ref"] for r in self.evidence(ctx)],
                            "findings": findings, "patches": []})


# ============================================================================== J02
@register("J02")
class CrossBibleChecker(JHandler):
    def run(self, ctx: Context) -> Result:
        recs = ctx.field_records("candidate_refs")
        for i, rec in enumerate(recs):
            if rec["owner"] != "A":
                raise BookforgeError("INVALID_INPUT", f"/payload/candidate_refs/{i}",
                                     "J02 checks A-set (Bible) records against one another", status="REJECTED")
        claims = []
        for rec in recs:
            claims.extend(claims_of(rec))
        claims = scoped(ctx, claims)
        out, findings = [], []
        for a, b in pairs(claims):
            cls = classify(a, b)
            if cls is None or (cls == "NON_CONFLICT" and same_value(a["value"], b["value"])):
                continue
            cid = "cb-" + sha256_json(sorted([claim_key(a), claim_key(b)]))[:16]
            refs = uniq_refs([a["rec"]["ref"], b["rec"]["ref"]])
            out.append({"id": cid, "source_refs": refs, "decision": cls, "confidence": 1.0})
            sev = {"HARD_CONFLICT": "MAJOR", "AMBIGUOUS": "MINOR"}.get(cls, "INFO")
            dec = {"HARD_CONFLICT": "FAIL", "AMBIGUOUS": "UNKNOWN"}.get(cls, "PASS")
            findings.append(ctx.finding(cls, json.dumps({"id": cid, "claims": [describe(a), describe(b)]},
                                                        sort_keys=True), severity=sev, decision=dec,
                                        source_refs=refs, confidence=1.0))
        for rec in recs:
            for j, link in enumerate((rec.get("data") or {}).get("linked_refs") or []):
                try:
                    tgt = self.resolve(ctx, link, f"/linked_refs/{j}")
                except BookforgeError as exc:
                    findings.append(ctx.finding("BROKEN_REFERENCE", f"{rec['record_id']} linked_refs/{j}: "
                                                f"{exc.errors[0]['message']}", severity="MAJOR",
                                                source_refs=[rec["ref"]]))
                    continue
                if tgt["lifecycle"] in ("SUPERSEDED", "REJECTED") or tgt.get("stale"):
                    findings.append(ctx.finding("STALE_REFERENCE", f"{rec['record_id']} links {tgt['record_id']} "
                                                f"v{tgt['version']} which is {tgt['lifecycle']}"
                                                f"{' (stale)' if tgt.get('stale') else ''}", severity="MINOR",
                                                source_refs=[rec["ref"], tgt["ref"]]))
        return Result(data={"classified_conflicts": out, "evidence_refs": [r["ref"] for r in self.evidence(ctx)],
                            "findings": findings, "patches": []})


# ============================================================================== J03
@register("J03")
class DuplicateDetector(JHandler):
    """Exact duplicates: identical normalized fact content (subject, predicate, value, type,
    interval; metadata/source pins excluded) or identical record data. Near duplicates: token
    Jaccard >= 0.92 of record content *excluding* name/concept tokens - names alone never
    establish identity; aliases and retellings stay distinct candidates for review."""

    def run(self, ctx: Context) -> Result:
        recs = ctx.field_records("record_refs")
        out, findings = [], []
        fact_groups: dict[str, list] = {}
        for rec in recs:
            for c in claims_of(rec):
                key = sha256_json([c["subject"], c["predicate"], c["value"], c["kind"], c["frm"], c["to"]])
                fact_groups.setdefault(key, []).append(c)
        for key, group in sorted(fact_groups.items()):
            if len({claim_key(c) for c in group}) < 2:
                continue
            refs = uniq_refs([c["rec"]["ref"] for c in group])
            did = "dup-fact-" + key[:16]
            out.append({"id": did, "source_refs": refs, "decision": "EXACT_DUPLICATE_FACT", "confidence": 1.0})
            findings.append(ctx.finding("EXACT_DUPLICATE_FACT", json.dumps(
                {"id": did, "occurrences": [claim_key(c) for c in group], "fact": describe(group[0])},
                sort_keys=True), severity="MINOR", decision="FAIL", source_refs=refs, confidence=1.0))

        def content(rec):
            data = copy.deepcopy(rec.get("data") or {})
            name = data.pop("concept", None) if isinstance(data, dict) else None
            strings = []
            for kind, _, obj in walk_claims(data):
                if kind == "fact":
                    if obj["predicate"] in ("entity.name", "alias") or obj["predicate"].endswith(".name"):
                        continue
                    strings.append(f"{obj['subject_id']} {obj['predicate']} {json.dumps(obj['value'])}")
            if isinstance(data, dict):
                for v in (data.get("attributes") or {}).values():
                    if isinstance(v, str):
                        strings.append(v)
            return name, data, tokset(" ".join(strings))

        info = [(rec,) + content(rec) for rec in recs]
        for i in range(len(info)):
            for j in range(i + 1, len(info)):
                ra, na, da, ta = info[i]
                rb, nb, db, tb = info[j]
                if ra["record_id"] == rb["record_id"]:
                    continue
                refs = [ra["ref"], rb["ref"]]
                if ra["module_id"] == rb["module_id"] and same_value(ra["data"], rb["data"]):
                    did = "dup-rec-" + sha256_json(sorted([ra["record_id"], rb["record_id"]]))[:16]
                    out.append({"id": did, "source_refs": refs, "decision": "EXACT_DUPLICATE", "confidence": 1.0})
                    findings.append(ctx.finding("EXACT_DUPLICATE", f"{ra['record_id']} and {rb['record_id']} hold "
                                                "identical content", severity="MAJOR", source_refs=refs,
                                                confidence=1.0))
                    continue
                if not ta or not tb:
                    if na and nb and norm_text(str(na)) == norm_text(str(nb)):
                        findings.append(ctx.finding("NAME_ONLY_MATCH", f"{ra['record_id']}/{rb['record_id']} share "
                                                    "only a name; names alone never establish identity",
                                                    severity="INFO", decision="UNKNOWN", source_refs=refs))
                    continue
                score = jaccard(ta, tb)
                if score >= NEAR_DUP:
                    did = "dup-near-" + sha256_json(sorted([ra["record_id"], rb["record_id"]]))[:16]
                    out.append({"id": did, "source_refs": refs, "decision": "NEAR_DUPLICATE_CANDIDATE",
                                "confidence": round(score, 4)})
                    findings.append(ctx.finding("NEAR_DUPLICATE", f"token Jaccard {score:.4f} >= {NEAR_DUP}; "
                                                "candidate only (aliases/retellings stay distinct)",
                                                severity="MINOR", decision="UNKNOWN", source_refs=refs,
                                                confidence=round(score, 4)))
        return Result(data={"duplicate_candidates": out, "evidence_refs": [r["ref"] for r in self.evidence(ctx)],
                            "findings": findings, "patches": []})


# ============================================================================== J04
def conflict_pairs(ctx: Context, handler: JHandler, conflict_rec: dict) -> list[tuple[dict, dict, dict]]:
    """Re-derive hard conflicts (a, b, conflict_rec) from a J01/J02 record's pinned sources."""
    items = conflict_rec["data"].get("conflict_candidates") or conflict_rec["data"].get("classified_conflicts") or []
    out = []
    for item in items:
        if item["decision"] not in ("CONFLICT", "HARD_CONFLICT"):
            continue
        recs = [handler.resolve(ctx, r, "/source_refs") for r in item["source_refs"]]
        claims = []
        for r in recs:
            claims.extend(claims_of(r))
        for a, b in pairs(claims):
            if classify(a, b) == "HARD_CONFLICT":
                out.append((a, b, item))
    return out


@register("J04")
class CanonReconciler(JHandler):
    """Options per confirmed conflict: align the lower-authority claim to the higher (PROPOSED)
    or the reverse (ALTERNATIVE). Authority ties escalate (ESCALATE) instead of silently choosing.
    Each option carries owner patches (patch_id '<option_id>/pN', approval_ref null)."""

    def run(self, ctx: Context) -> Result:
        options, patches, findings = [], [], []
        seen = set()
        for crec in ctx.field_records("conflict_refs"):
            for a, b, item in conflict_pairs(ctx, self, crec):
                key = tuple(sorted([claim_key(a), claim_key(b)]))
                if key in seen:
                    continue
                seen.add(key)
                aa, ab = authority(a["rec"], a), authority(b["rec"], b)
                hi, lo = (a, b) if aa >= ab else (b, a)
                tie = aa == ab
                base = "opt-" + sha256_json(list(key))[:12]
                for suffix, keep, change, decision in (("keep-hi", hi, lo, "ESCALATE" if tie else "PROPOSED"),
                                                      ("keep-lo", lo, hi, "ESCALATE" if tie else "ALTERNATIVE")):
                    oid = f"{base}-{suffix}"
                    options.append({"id": oid, "source_refs": uniq_refs([crec["ref"], change["rec"]["ref"],
                                                                         keep["rec"]["ref"]]),
                                    "decision": decision, "confidence": 1.0})
                    patches.append({"patch_id": f"{oid}/p1", "target_ref": change["rec"]["ref"],
                                    "path": change["path"], "replacement": keep["value"],
                                    "reason": f"align {change['subject']} {change['predicate']} with "
                                              f"{claim_key(keep)} (authority {authority(keep['rec'])} vs "
                                              f"{authority(change['rec'])})", "approval_ref": None})
                if tie:
                    findings.append(ctx.finding("AUTHORITY_TIE", f"equal authority for {key}; route to J11 for a "
                                                "user decision", severity="MAJOR", decision="UNKNOWN",
                                                source_refs=[a["rec"]["ref"], b["rec"]["ref"]]))
        if not options:
            findings.append(ctx.finding("NO_CONFIRMED_CONFLICT", "no hard conflict re-derived from the pinned "
                                        "sources", severity="INFO", decision="PASS"))
        return Result(data={"repair_options": options, "evidence_refs": [r["ref"] for r in self.evidence(ctx)],
                            "findings": findings, "patches": patches})


# ============================================================================== J05
def cost_of(plan: dict) -> int | None:
    if plan["affected_downstream_count"] is None:
        return None
    return (1000 * plan["protected_violations"] + 100 * plan["changed_canon_facts"] + 10 * plan["changed_passages"]
            + plan["affected_downstream_count"])


def rank_key(plan: dict, auto: bool):
    if plan["state"] == "BLOCKED":
        return (3, 0, plan["plan_id"])
    if plan["cost"] is None:
        return (2, 0, plan["plan_id"])
    return (0 if auto else 1, plan["cost"], plan["plan_id"])


@register("J05")
class MinimalChangeSolver(JHandler):
    """cost = 1000*protected_violations + 100*changed_canon_facts + 10*changed_passages +
    affected_downstream_count. Protected changes without explicit unexpired K09/I10 authorization
    are infeasible (state BLOCKED, cost null). affected_downstream_count comes only from J06
    evidence (impact_known=true) pinning every target; otherwise null (unknown) with cost null,
    ranked after every known feasible plan. Ties break by plan_id. If no automatically selectable
    plan remains, the result is BLOCKED with a decision request (J06/J11)."""

    def run(self, ctx: Context) -> Result:
        evidence = self.evidence(ctx)
        impacts = [r for r in evidence if r["module_id"] == "J06"]
        approvals = [r for r in evidence if r["module_id"] in APPROVAL_MODULES]
        plans, findings, unresolved = [], [], []
        auto_ids = set()
        for orec in ctx.field_records("option_refs"):
            conflicts = [r for r in orec["source_refs"] if r["module_id"] in ("J01", "J02")] or [orec["ref"]]
            for opt in orec["data"]["repair_options"]:
                ops = [p for p in orec["data"]["patches"] if p["patch_id"].startswith(opt["id"] + "/")]
                if not ops:
                    findings.append(ctx.finding("NO_PATCHES", f"option {opt['id']} has no owner patches; needs J07 "
                                                "rewriting before ranking", severity="MINOR", decision="UNKNOWN"))
                    continue
                plan = self.plan(ctx, opt, ops, conflicts, impacts, approvals, findings, unresolved)
                plans.append(plan)
                if plan["state"] == "PROPOSED" and plan["cost"] is not None and opt["decision"] in (
                        "PROPOSED", "ALTERNATIVE"):
                    auto_ids.add(plan["plan_id"])
        plans.sort(key=lambda p: rank_key(p, p["plan_id"] in auto_ids))
        summary = [{"plan_id": p["plan_id"], "cost": p["cost"], "state": p["state"]} for p in plans]
        findings.append(ctx.finding("RANKING", json.dumps(summary), severity="INFO", decision="PASS"))
        if not auto_ids:
            findings.append(ctx.finding("DECISION_REQUIRED", "every option is uncertain, infeasible or escalated; "
                                        "a user decision (J11) or impact evidence (J06) is required",
                                        severity="BLOCKING", decision="UNKNOWN"))
            return Result(status="BLOCKED", findings=findings,
                          errors=[{"code": "APPROVAL_REQUIRED", "path": "/payload/option_refs",
                                   "message": "no automatically selectable repair; decision request raised",
                                   "retryable": False}],
                          unresolved=sorted(set(unresolved)) + ["J11:decision_request"])
        return Result(data={"ranked_repairs": plans, "findings": findings, "patches": []})

    def plan(self, ctx, opt, ops, conflicts, impacts, approvals, findings, unresolved) -> dict:
        targets = {}
        for p in ops:
            targets.setdefault(ref_key(p["target_ref"]), (p["target_ref"], []))[1].append(p["path"])
        pv = ccf = cp = 0
        feasible = True
        appr_refs, impact_refs, adc_known = [], [], True
        for ref, paths in targets.values():
            rec = self.resolve(ctx, ref, "/owner_patches/target_ref")
            if rec["owner"] == "A":
                ccf += len(paths)
            if rec["module_id"] in PROSE_MODULES:
                cp += len(paths)
            if is_protected(rec, paths):
                pv += len(paths)
                ok = [a for a in approvals if covers(approval_view(a), ref) and not approval_problem(a)]
                if ok:
                    appr_refs.extend(a["ref"] for a in ok)
                else:
                    feasible = False
                    probs = [approval_problem(a) for a in approvals if covers(approval_view(a), ref)]
                    findings.append(ctx.finding("PROTECTED_CHANGE", f"option {opt['id']} changes protected "
                                                f"{rec['record_id']} without valid authorization"
                                                + (f" ({probs[0][0]})" if probs and probs[0] else ""),
                                                severity="MAJOR", decision="FAIL", source_refs=[ref]))
            imp = [r for r in impacts if r["data"]["impact_known"] and
                   any(ref_key(s) == ref_key(ref) for s in r["source_refs"])]
            if not imp:
                adc_known = False
                unresolved.append(f"J06:impact:{rec['record_id']}")
            for r in imp:
                impact_refs.extend(r["data"]["impact_refs"])
        impact_refs = uniq_refs(impact_refs)
        plan = {"plan_id": opt["id"], "conflict_refs": conflicts, "owner_patches": copy.deepcopy(ops),
                "protected_violations": pv, "changed_canon_facts": ccf, "changed_passages": cp,
                "affected_downstream_count": len(impact_refs) if adc_known else None, "cost": None,
                "approval_refs": uniq_refs(appr_refs), "impact_refs": impact_refs,
                "state": "PROPOSED" if feasible else "BLOCKED"}
        if feasible:
            plan["cost"] = cost_of(plan)
        return plan

    def validate(self, ctx: Context, record: dict) -> list[dict]:
        out = super().validate(ctx, record)
        plans = record["data"]["ranked_repairs"]
        for p in plans:
            if p["affected_downstream_count"] is None and p["cost"] is not None:
                out.append(ctx.finding("UNKNOWN_IMPACT_COST", f"{p['plan_id']}: unknown impact must keep cost null",
                                       severity="BLOCKING"))
            if p["cost"] is not None and p["cost"] != cost_of(p):
                out.append(ctx.finding("COST_FORMULA", f"{p['plan_id']}: cost {p['cost']} != {cost_of(p)}",
                                       severity="BLOCKING"))
            if p["state"] == "BLOCKED" and p["cost"] is not None:
                out.append(ctx.finding("INFEASIBLE_COST", f"{p['plan_id']}: infeasible plans are not costed",
                                       severity="BLOCKING"))
        seen_unknown = False
        for p in plans:
            if p["cost"] is None:
                seen_unknown = True
            elif seen_unknown:
                out.append(ctx.finding("RANK_ORDER", f"{p['plan_id']}: known feasible plan ranked after an "
                                       "uncertain/infeasible one", severity="BLOCKING"))
        return out


# ============================================================================== J06
@register("J06")
class RippleAnalyzer(JHandler):
    """Breadth-first traversal of the kernel dependency_edges over (record, version) with a visited
    set. Changed paths: patches in J04/J07 evidence targeting the changed pin, else the diff
    against the previous version, else the whole record. A consumer is impacted when a changed
    path equals/is ancestor/descendant of its read path; descendants see whole-record change.
    Other branches are never visited. A stale changed pin (newer revision exists) or a dangling
    edge makes impact unknown (refresh required)."""

    manual_allowed = False

    def run(self, ctx: Context) -> Result:
        from ..canonical import changed_pointers, pointers_overlap
        evidence = self.evidence(ctx)
        findings, impact, known = [], [], True
        visited = set()
        for rec in ctx.field_records("changed_refs"):
            if rec["version"] != rec["latest_version"]:
                known = False
                findings.append(ctx.finding("STALE_GRAPH_PIN", f"{rec['record_id']} v{rec['version']} is not the "
                                            f"latest (v{rec['latest_version']}); refresh the impact request",
                                            severity="MAJOR", decision="UNKNOWN", source_refs=[rec["ref"]]))
            patch_paths = [p["path"] for e in evidence if e["module_id"] in ("J04", "J05", "J07")
                           for p in (e["data"].get("patches") or e["data"].get("patch_proposals") or [])
                           if ref_key(p["target_ref"]) == ref_key(rec["ref"])]
            if patch_paths:
                changed, producer_cond = patch_paths, ("producer_version=?", (rec["version"],))
            elif rec["version"] > 1:
                prev = ctx.store.get_record(ctx.project_id, ctx.branch_id, rec["record_id"], rec["version"] - 1)
                changed = changed_pointers(prev["data"], rec["data"]) if prev else [""]
                producer_cond = ("producer_version<?", (rec["version"],))
            else:
                changed, producer_cond = [""], ("producer_version=?", (rec["version"],))
            queue = [(e, changed) for e in ctx.store.query(
                "SELECT * FROM dependency_edges WHERE project_id=? AND branch_id=? AND producer_record_id=? AND "
                + producer_cond[0] + " ORDER BY created_at, edge_id",
                (ctx.project_id, ctx.branch_id, rec["record_id"]) + producer_cond[1])]
            while queue:
                edge, chg = queue.pop(0)
                key = (edge["consumer_record_id"], edge["consumer_version"])
                if key in visited:
                    continue
                if not any(pointers_overlap(c, p) for c in chg for p in json.loads(edge["paths"])):
                    continue
                visited.add(key)
                cons = ctx.store.get_record(ctx.project_id, ctx.branch_id, *key)
                if cons is None:
                    known = False
                    findings.append(ctx.finding("DANGLING_EDGE", f"edge to missing {key}", severity="MAJOR",
                                                decision="UNKNOWN"))
                    continue
                impact.append(cons["ref"])
                for e2 in ctx.store.query("SELECT * FROM dependency_edges WHERE project_id=? AND branch_id=? AND "
                                          "producer_record_id=? AND producer_version=? ORDER BY created_at, edge_id",
                                          (ctx.project_id, ctx.branch_id, key[0], key[1])):
                    queue.append((e2, [""]))
        findings.append(ctx.finding("IMPACT", f"{len(impact)} impacted record revision(s); impact_known={known}",
                                    severity="INFO", decision="PASS" if known else "UNKNOWN"))
        return Result(data={"impact_refs": impact, "impact_known": known, "findings": findings, "patches": []})


# ============================================================================== J07
@register("J07")
class PatchGenerator(JHandler):
    """Localized owner patches for an *approved* J04/J05 option. Structured patches are copied
    from the selected plan with exact base pins; a PATCH_CONTRACT finding per patch records the
    precondition hash (current value), inverse source value and postcondition hash. Text
    rewriting beyond structured values needs AI or a manual candidate."""

    def run(self, ctx: Context) -> Result:
        src = ctx.field_record("approved_option_ref")
        if src["lifecycle"] not in ("APPROVED", "LOCKED"):
            raise BookforgeError("APPROVAL_REQUIRED", "/payload/approved_option_ref",
                                 "the reconciliation option must be approved before patch generation",
                                 unresolved=[f"{src['module_id']}:accept"])
        if src["module_id"] == "J05":
            plans = [p for p in src["data"]["ranked_repairs"] if p["state"] == "PROPOSED" and p["cost"] is not None]
            if not plans:
                raise BookforgeError("APPROVAL_REQUIRED", "/payload/approved_option_ref",
                                     "no feasible known-cost plan", unresolved=["J11:decision_request"])
            patches = plans[0]["owner_patches"]
        else:
            chosen = [o for o in src["data"]["repair_options"] if o["decision"] == "PROPOSED"]
            if len(chosen) != 1:
                raise BookforgeError("APPROVAL_REQUIRED", "/payload/approved_option_ref",
                                     f"{len(chosen)} proposed options; rank them (J05) or decide (J11)",
                                     unresolved=["J05:create", "J11:decision_request"])
            patches = [p for p in src["data"]["patches"] if p["patch_id"].startswith(chosen[0]["id"] + "/")]
        findings, out = [], []
        for p in patches:
            tgt = self.resolve(ctx, p["target_ref"], "/patch_proposals/target_ref")
            if tgt["version"] != tgt["latest_version"]:
                raise BookforgeError("VERSION_CONFLICT", "/payload/approved_option_ref",
                                     f"{tgt['record_id']} moved to v{tgt['latest_version']}; regenerate options",
                                     status="REJECTED")
            current = resolve_pointer(tgt["data"], p["path"])
            set_pointer(tgt["data"], p["path"], p["replacement"])  # path must exist
            out.append(copy.deepcopy(p))
            findings.append(ctx.finding("PATCH_CONTRACT", json.dumps({
                "patch_id": p["patch_id"], "base": {"record_id": tgt["record_id"], "version": tgt["version"],
                                                     "content_hash": tgt["content_hash"]},
                "precondition_hash": sha256_json(current), "inverse": current,
                "postcondition_hash": sha256_json(p["replacement"])}, sort_keys=True), severity="INFO",
                decision="PASS", source_refs=[tgt["ref"]]))
        return Result(data={"patch_proposals": out, "findings": findings})

    def validate(self, ctx: Context, record: dict) -> list[dict]:
        out = super().validate(ctx, record)
        for p in record["data"]["patch_proposals"]:
            try:
                tgt = self.resolve(ctx, p["target_ref"], "/target_ref")
                if tgt["version"] != tgt["latest_version"]:
                    out.append(ctx.finding("VERSION_CONFLICT", f"patch {p['patch_id']}: target moved to "
                                           f"v{tgt['latest_version']}", severity="BLOCKING"))
                    continue
                new = set_pointer(tgt["data"], p["path"], p["replacement"])
                for e in ctx.contracts.check(tgt["module_id"], "OUTPUT", new):
                    out.append(ctx.finding("OWNER_SCHEMA", f"patch {p['patch_id']}: {e['path']} {e['message']}",
                                           severity="BLOCKING"))
            except BookforgeError as exc:
                out.append(ctx.finding(exc.code, f"patch {p['patch_id']}: {exc.errors[0]['message']}",
                                       severity="BLOCKING"))
        return out


# ============================================================================== J08
@register("J08")
class CanonUpdateManager(JHandler):
    manual_allowed = False

    # -- prepare ------------------------------------------------------------------------
    def run(self, ctx: Context) -> Result:
        jp = ctx.field_record("approved_patch_ref")
        if jp["lifecycle"] not in ("APPROVED", "LOCKED") or jp.get("stale"):
            raise BookforgeError("APPROVAL_REQUIRED", "/payload/approved_patch_ref",
                                 "the J07 patch proposal must be approved (and current) before commit",
                                 unresolved=["J07:accept"])
        approvals = [r for r in self.evidence(ctx) if r["module_id"] in APPROVAL_MODULES]
        groups: dict[str, list[dict]] = {}
        for p in jp["data"]["patch_proposals"]:
            groups.setdefault(p["target_ref"]["record_id"], []).append(p)
        if not groups:
            raise BookforgeError("INVALID_INPUT", "/payload/approved_patch_ref", "no patches to commit",
                                 status="REJECTED")
        participants, findings, unresolved = [], [], []
        record_id = ctx.allocate_record_id()
        for rid, ps in sorted(groups.items()):
            pins = {ref_key(p["target_ref"]) for p in ps}
            if len(pins) != 1:
                raise BookforgeError("VERSION_CONFLICT", "/payload/approved_patch_ref",
                                     f"patches pin several revisions of {rid}", status="REJECTED")
            tgt = self.resolve(ctx, ps[0]["target_ref"], "/payload/approved_patch_ref")
            if tgt["version"] != tgt["latest_version"] or (tgt["approved_version"] and
                                                           tgt["approved_version"] != tgt["version"]):
                raise BookforgeError("VERSION_CONFLICT", "/payload/approved_patch_ref",
                                     f"{rid} v{tgt['version']} is no longer the head (latest v{tgt['latest_version']}, "
                                     f"approved v{tgt['approved_version']}); regenerate the repair", status="REJECTED")
            if tgt["record_kind"] != "OUTPUT":
                raise BookforgeError("INVALID_INPUT", "/payload/approved_patch_ref",
                                     f"{rid} is a {tgt['record_kind']} record; J08 commits owner OUTPUT records",
                                     status="REJECTED")
            paths = [p["path"] for p in ps]
            protected = is_protected(tgt, paths)
            used = []
            if protected:
                cover = [a for a in approvals if covers(approval_view(a), jp["ref"]) or
                         covers(approval_view(a), tgt["ref"])]
                if not cover:
                    raise BookforgeError("LOCKED_FACT", "/payload/evidence_refs",
                                         f"{rid} is protected; supply an I10/K09 authorization for this exact repair",
                                         unresolved=["I10:protected_change"])
                for a in cover:
                    check_approval(a, "/payload/evidence_refs")
                used = [a["ref"] for a in cover]
            data = tgt["data"]
            for p in ps:
                data = set_pointer(data, p["path"], p["replacement"])
            errs = ctx.contracts.check(tgt["module_id"], "OUTPUT", data)
            if errs:
                raise BookforgeError("INVALID_INPUT", "/payload/approved_patch_ref",
                                     f"{rid} would violate {tgt['module_id']} OUTPUT at {errs[0]['path']}",
                                     status="REJECTED")
            staged = ctx.stage_revision(tgt, data, source_refs=uniq_refs(list(tgt["source_refs"]) + [jp["ref"]]))
            participants.append({"module_id": tgt["module_id"], "target_ref": tgt["ref"], "staged_ref": staged,
                                 "protected": protected, "approval_refs": used,
                                 "postcondition_hash": sha256_json(data)})
            findings.append(ctx.finding("PREPARED", f"staged {tgt['module_id']} {rid} v{staged['version']} as an "
                                        "owner DRAFT; the owner must VALIDATE it before J08 ACCEPT commits all "
                                        "participants atomically", severity="INFO", decision="PASS",
                                        source_refs=[staged]))
            unresolved.append(f"{tgt['module_id']}:validate:{rid}")
        state = {"participants": participants, "patch_ref": jp["ref"], "conflict_key": jp["record_id"]}
        ctx.on_commit(lambda tx: tx.put_state(ctx.project_id, ctx.branch_id, PREPARE_NS, record_id, state,
                                              expected_revision=0))
        return Result(data={"commit_receipts": [], "transaction_state": "PREPARED", "findings": findings},
                      record_id=record_id, unresolved=unresolved)

    # -- commit (ACCEPT) ------------------------------------------------------------------
    def requires_explicit_approval(self, ctx: Context, record: dict) -> bool:
        return record["data"]["transaction_state"] == "PREPARED"

    def _problems(self, ctx: Context, record: dict, heads=None) -> list[tuple[str, str]]:
        st = ctx.get_state(PREPARE_NS, record["record_id"])
        if not st:
            return [("NOT_FOUND", "no prepared participants for this J08 record")]
        if ctx.get_state(COMMIT_NS, record["record_id"]):
            return [("VERSION_CONFLICT", "repair already committed")]
        out = []
        for part in st["participants"]:
            t, s = part["target_ref"], part["staged_ref"]
            cur = ctx.store.get_record(ctx.project_id, ctx.branch_id, s["record_id"], s["version"])
            if cur is None or cur["content_hash"] != s["content_hash"]:
                out.append(("HASH_MISMATCH", f"staged {s['record_id']} v{s['version']} missing or changed"))
                continue
            if heads is not None:
                lv, av = heads.get(s["record_id"], (None, None))
            else:
                lv, av = cur["latest_version"], cur["approved_version"]
            if lv != s["version"] or av != t["version"]:
                out.append(("VERSION_CONFLICT", f"{s['record_id']}: intervening revision (latest v{lv}, approved "
                            f"v{av}); compensate and regenerate"))
            if cur["lifecycle"] not in ("VALIDATED", "APPROVED"):
                out.append(("OWNER_VALIDATION", f"{part['module_id']} has not validated {s['record_id']} "
                            f"v{s['version']} (lifecycle {cur['lifecycle']})"))
            if cur.get("stale"):
                out.append(("STALE", f"{s['record_id']} v{s['version']} is stale"))
            if part["protected"]:
                ok = False
                for aref in part["approval_refs"]:
                    a = ctx.store.get_record(ctx.project_id, ctx.branch_id, aref["record_id"], aref["version"])
                    prob = approval_problem(a) if a else ("NOT_FOUND", "approval missing")
                    if prob:
                        out.append((prob[0], f"protected {s['record_id']}: {prob[1]}"))
                    else:
                        ok = True
                if not ok and not any(c in ("EXPIRED_APPROVAL", "APPROVAL_REQUIRED") for c, _ in out):
                    out.append(("LOCKED_FACT", f"protected {s['record_id']} lacks authorization"))
        return out

    def accept_gate(self, ctx: Context, record: dict, approval: dict | None) -> list[dict]:
        if record["data"]["transaction_state"] != "PREPARED":
            return []
        return [ctx.finding(code, msg, severity="BLOCKING", decision="FAIL")
                for code, msg in self._problems(ctx, record)]

    def on_accept(self, ctx: Context, record: dict, tx) -> None:
        if record["data"]["transaction_state"] != "PREPARED":
            return
        st = ctx.get_state(PREPARE_NS, record["record_id"])
        heads = {}
        for part in st["participants"]:
            row = tx.execute("SELECT latest_version, approved_version FROM heads WHERE project_id=? AND branch_id=? "
                             "AND record_id=?", (ctx.project_id, ctx.branch_id,
                                                 part["staged_ref"]["record_id"])).fetchone()
            heads[part["staged_ref"]["record_id"]] = (row["latest_version"], row["approved_version"]) if row else (
                None, None)
        probs = self._problems(ctx, record, heads)
        if probs:
            raise BookforgeError(probs[0][0] if probs[0][0] != "OWNER_VALIDATION" else "APPROVAL_REQUIRED",
                                 "/payload/candidate_ref", probs[0][1])
        now = now_utc()
        receipts = []
        for part in st["participants"]:
            s = part["staged_ref"]
            rec = ctx.store.get_record(ctx.project_id, ctx.branch_id, s["record_id"], s["version"])
            body = {"approval_id": new_id("appr"), "subject_ref": s,
                    "action_hash": sha256_json({"action": "J08_COMMIT", "subject": s, "repair": record["ref"]}),
                    "policy_ref": record["ref"], "approver_id": ctx.principal_id,
                    "scopes": [f"{part['module_id']}:accept"], "source_refs": [part["target_ref"], st["patch_ref"]],
                    "issued_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "expires_at": (now + timedelta(days=3650)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "revoked": False, "decision": "APPROVED", "evidence_origin": ctx.evidence_origin}
            tx.insert_approval(body, ctx.project_id, ctx.branch_id)
            audit_id = tx.insert_audit(project_id=ctx.project_id, branch_id=ctx.branch_id,
                                       request_id=ctx.request["request_id"], attempt_id=new_id("attempt"),
                                       operation_id=part["module_id"], action="ACCEPT", principal_id=ctx.principal_id,
                                       input_refs=[part["target_ref"], st["patch_ref"]], output_refs=[s],
                                       outcome="SUCCESS", evidence_type="COMMITTED_OUTPUT",
                                       evidence_origin=ctx.evidence_origin)
            tx.set_lifecycle(s, "APPROVED", approval_id=body["approval_id"])
            prev = tx.set_approved_head(s)
            rec = dict(rec, lifecycle="APPROVED")
            ctx.engine._invalidate_consumers(tx, ctx, rec, prev)
            receipts.append({"receipt_id": audit_id, "operation_id": part["module_id"],
                             "request_id": ctx.request["request_id"], "attempt_id": new_id("attempt"),
                             "output_ref": s, "input_refs": [part["target_ref"], st["patch_ref"]],
                             "validation_ref": s, "approval_refs": part["approval_refs"], "audit_ref": record["ref"],
                             "committed_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                             "evidence_origin": ctx.evidence_origin})
        tx.put_state(ctx.project_id, ctx.branch_id, COMMIT_NS, record["record_id"],
                     {"receipts": receipts, "conflict_key": st["conflict_key"]}, expected_revision=0)
        tx.insert_outbox(ctx.project_id, ctx.branch_id, "reconciliation.committed",
                         {"repair": record["ref"], "participants": [r["output_ref"] for r in receipts]})

    # -- record outcome (UPDATE) ----------------------------------------------------------
    def update(self, ctx: Context) -> Result:
        base = ctx.base
        want = ctx.payload.get("transaction_state")
        commits = ctx.get_state(COMMIT_NS, base["record_id"])
        st = ctx.get_state(PREPARE_NS, base["record_id"]) or {"participants": []}
        if want == "COMMITTED":
            if not commits:
                raise BookforgeError("APPROVAL_REQUIRED", "/payload/transaction_state",
                                     "not committed: ACCEPT the prepared J08 record first; a partially prepared "
                                     "repair is never reported as committed", unresolved=["J08:accept"])
            return Result(data={"commit_receipts": commits["receipts"], "transaction_state": "COMMITTED",
                                "findings": []})
        if want == "COMPENSATED":
            if commits:
                raise BookforgeError("VERSION_CONFLICT", "/payload/transaction_state",
                                     "already committed; a new reconciliation is required to revert",
                                     status="REJECTED")
            for part in st["participants"]:
                s = part["staged_ref"]
                cur = ctx.store.get_record(ctx.project_id, ctx.branch_id, s["record_id"], s["version"])
                if cur is None or cur["latest_version"] != s["version"] or cur["lifecycle"] in ("APPROVED", "LOCKED"):
                    raise BookforgeError("VERSION_CONFLICT", "/payload/transaction_state",
                                         f"{s['record_id']} postcondition no longer matches; escalate (J11)",
                                         status="BLOCKED", unresolved=["J11:decision_request"])
            refs = [p["staged_ref"] for p in st["participants"]]
            ctx.on_commit(lambda tx: [tx.set_lifecycle(r, "REJECTED") for r in refs])
            return Result(data={"commit_receipts": [], "transaction_state": "COMPENSATED", "findings": [
                ctx.finding("COMPENSATED", f"rejected {len(refs)} unpromoted staged revision(s)", severity="INFO",
                            decision="PASS")]})
        raise BookforgeError("INVALID_INPUT", "/payload/transaction_state",
                             "UPDATE records the outcome: COMMITTED or COMPENSATED", status="REJECTED")

    def validate(self, ctx: Context, record: dict) -> list[dict]:
        out = []
        data = record["data"]
        if data["transaction_state"] == "COMMITTED":
            for r in data["commit_receipts"]:
                cur = ctx.store.get_record(ctx.project_id, ctx.branch_id, r["output_ref"]["record_id"],
                                           r["output_ref"]["version"])
                if cur is None or cur["lifecycle"] not in ("APPROVED", "LOCKED", "SUPERSEDED"):
                    out.append(ctx.finding("RECEIPT", f"receipt {r['receipt_id']} output is not committed",
                                           severity="BLOCKING"))
        elif data["transaction_state"] == "PREPARED" and not ctx.get_state(PREPARE_NS, record["record_id"]):
            out.append(ctx.finding("PREPARE_STATE", "prepared participants missing", severity="BLOCKING"))
        return out


# ============================================================================== J09
@register("J09")
class ManuscriptImpactChecker(JHandler):
    """Exact references: string values that a changed fact revision replaced are located in the
    approved C prose heads (whole-word); each occurrence is anchored and gets a literal patch
    proposal (approval_ref null; C decides). Passages without occurrences are not touched. Spans
    from F/J records in evidence_refs that pin an older C revision are re-anchored (ambiguous ->
    SPAN_CONFLICT). Semantic implications need AI/manual review."""

    def run(self, ctx: Context) -> Result:
        changes = []  # (old, new, fact_ref)
        findings, impacts, patches = [], [], []
        for rec in ctx.field_records("changed_fact_refs"):
            if rec["version"] < 2:
                findings.append(ctx.finding("NO_PREVIOUS", f"{rec['record_id']} has no previous revision",
                                            severity="INFO", decision="PASS"))
                continue
            prev = ctx.store.get_record(ctx.project_id, ctx.branch_id, rec["record_id"], rec["version"] - 1)
            old = {(c["subject"], c["predicate"]): c["value"] for c in claims_of(prev)}
            for c in claims_of(rec):
                o = old.get((c["subject"], c["predicate"]))
                if isinstance(o, str) and isinstance(c["value"], str) and o != c["value"] and len(o.strip()) >= 2:
                    changes.append((o, c["value"], rec["ref"]))
        heads = []
        for mod in PROSE_MODULES:
            for r in ctx.records_of(mod, approved_only=True):
                heads.append(r)
        for ms in sorted(heads, key=lambda r: r["record_id"]):
            text = record_text(ms)
            evid, used = [], []
            for old, new, fref in changes:
                for i in occurrences(text, old):
                    e = i + len(old)
                    if (i > 0 and (text[i - 1].isalnum())) or (e < len(text) and text[e].isalnum()):
                        continue
                    span = make_span(ms, i, e)
                    evid.append(span)
                    used.append(fref)
                    patches.append({"patch_id": span["span_id"], "target_ref": ms["ref"], "path": "/text",
                                    "replacement": new, "reason": f"canon changed {old!r} -> {new!r}",
                                    "approval_ref": None})
            if evid:
                refs = uniq_refs([ms["ref"]] + used)
                impacts.append({"id": f"pi-{ms['record_id']}-v{ms['version']}", "source_refs": refs,
                                "decision": "AFFECTED", "confidence": 1.0})
                findings.append(ctx.finding("PASSAGE_REFERENCE", f"{len(evid)} exact reference(s) to changed canon in "
                                            f"{ms['record_id']} v{ms['version']}", severity="MAJOR", decision="FAIL",
                                            evidence=evid, source_refs=refs, confidence=1.0))
        for ev_rec in self.evidence(ctx):
            try:
                anchored = anchored_patches({"findings": ev_rec["data"].get("findings", []),
                                             "patches": ev_rec["data"].get("patches", [])})
            except (BookforgeError, AttributeError):
                continue
            for p, span in anchored:
                old = ctx.store.get_record(ctx.project_id, ctx.branch_id, span["record_ref"]["record_id"],
                                           span["record_ref"]["version"])
                if old is None:
                    continue
                head_v = old["approved_version"] or old["latest_version"]
                if head_v == old["version"]:
                    continue
                head = ctx.store.get_record(ctx.project_id, ctx.branch_id, old["record_id"], head_v)
                try:
                    moved = reanchor(record_text(old), record_text(head), span)
                    findings.append(ctx.finding("REANCHORED", f"{ev_rec['record_id']}:{p['patch_id']} -> "
                                                f"{head['record_id']} v{head['version']} [{moved['start']},"
                                                f"{moved['end']})", severity="INFO", decision="PASS",
                                                evidence=[make_span(head, moved["start"], moved["end"],
                                                                    span_id=span["span_id"])]))
                except BookforgeError as exc:
                    findings.append(ctx.finding(exc.code, f"{ev_rec['record_id']}:{p['patch_id']}: "
                                                f"{exc.errors[0]['message']}", severity="MAJOR",
                                                decision="UNKNOWN"))
        return Result(data={"passage_impacts": impacts, "evidence_refs": [r["ref"] for r in self.evidence(ctx)],
                            "findings": findings, "patches": patches})


# ============================================================================== J10
@register("J10")
class Revalidation(JHandler):
    """Reruns owner validation on every committed participant, re-derives the original conflict
    predicates of impacted J01/J02 consumers against the new heads, lists other stale consumers
    for owner revalidation, applies waivers that bind exact finding/source/action hashes (never
    for nonwaivable rules) and escalates after three failing iterations per repair."""

    manual_allowed = False

    def run(self, ctx: Context) -> Result:
        j08 = ctx.field_record("repair_receipt_ref")
        commits = ctx.get_state(COMMIT_NS, j08["record_id"])
        if not commits:
            raise BookforgeError("APPROVAL_REQUIRED", "/payload/repair_receipt_ref",
                                 "repair is not committed; nothing to revalidate", unresolved=["J08:accept"])
        reports, findings, unresolved, evidence = [], [], [], [j08["ref"]]
        waivers = list(ctx.store.list_state(ctx.project_id, ctx.branch_id, WAIVER_NS).values())
        failed = False
        for r in commits["receipts"]:
            out = r["output_ref"]
            rec = ctx.store.get_record(ctx.project_id, ctx.branch_id, out["record_id"], out["version"])
            evidence.append(out)
            fs = ctx.engine.run_validation(ctx, get_handler(rec["module_id"]), rec)
            blocking = []
            for f in fs:
                if f["severity"] != "BLOCKING" or f["decision"] not in ("FAIL", "UNKNOWN"):
                    continue
                w = [w for w in waivers if waiver_applies(w, f, out, rec["source_refs"])[0]]
                if w:
                    findings.append(ctx.finding("WAIVED", f"{f['rule_id']} waived by {w[0]['waiver_id']}",
                                                severity="INFO", decision="PASS", source_refs=[out]))
                else:
                    blocking.append(f)
            dec = "PASS" if not blocking else "FAIL"
            failed |= bool(blocking)
            reports.append({"id": f"rv-{out['record_id']}-v{out['version']}", "source_refs": [out],
                            "decision": dec, "confidence": 1.0})
            for f in blocking:
                findings.append(ctx.finding(f["rule_id"], f["message"], severity="BLOCKING", decision="FAIL",
                                            source_refs=[out]))
            edges = ctx.store.query("SELECT DISTINCT consumer_record_id, consumer_version, consumer_operation FROM "
                                    "dependency_edges WHERE project_id=? AND branch_id=? AND producer_record_id=? "
                                    "AND producer_version<? ORDER BY consumer_record_id, consumer_version",
                                    (ctx.project_id, ctx.branch_id, out["record_id"], out["version"]))
            for e in edges:
                cons = ctx.store.get_record(ctx.project_id, ctx.branch_id, e["consumer_record_id"],
                                            e["consumer_version"])
                if cons is None or not cons["stale"]:
                    continue
                if cons["module_id"] in ("J01", "J02"):
                    remains = self.rerun_conflicts(ctx, cons)
                    dec2 = "CONFLICT_REMAINS" if remains else "RESOLVED"
                    failed |= bool(remains)
                    reports.append({"id": f"rc-{cons['record_id']}-v{cons['version']}",
                                    "source_refs": [cons["ref"], out], "decision": dec2, "confidence": 1.0})
                    if remains:
                        findings.append(ctx.finding("CONFLICT_REMAINS", f"{remains} conflict(s) of "
                                                    f"{cons['record_id']} still hold on current heads",
                                                    severity="BLOCKING", decision="FAIL",
                                                    source_refs=[cons["ref"]]))
                else:
                    reports.append({"id": f"rq-{cons['record_id']}-v{cons['version']}",
                                    "source_refs": [cons["ref"], out], "decision": "REVALIDATION_QUEUED"})
                    unresolved.append(f"{cons['module_id']}:revalidate:{cons['record_id']}")
        key = commits["conflict_key"]
        count = (ctx.get_state(ITER_NS, key) or {}).get("failures", 0) + (1 if failed else 0)
        if failed:
            ctx.on_commit(lambda tx: tx.put_state(ctx.project_id, ctx.branch_id, ITER_NS, key, {"failures": count}))
            if count >= MAX_REPAIR_ITERATIONS:
                findings.append(ctx.finding("ESCALATE", f"{count} failed repair iterations for {key}; escalate to "
                                            "J11 instead of repairing again", severity="BLOCKING", decision="UNKNOWN"))
                unresolved.append("J11:decision_request")
        return Result(data={"validation_reports": reports, "evidence_refs": uniq_refs(evidence),
                            "findings": findings, "patches": []}, unresolved=sorted(set(unresolved)))

    def rerun_conflicts(self, ctx: Context, cons: dict) -> int:
        claims = []
        for ref in cons["source_refs"]:
            src = ctx.store.get_record(ctx.project_id, ctx.branch_id, ref["record_id"], ref["version"])
            if src is None:
                continue
            head_v = src["approved_version"] or src["latest_version"]
            head = ctx.store.get_record(ctx.project_id, ctx.branch_id, src["record_id"], head_v)
            claims.extend(claims_of(head))
        return sum(1 for a, b in pairs(claims) if classify(a, b) == "HARD_CONFLICT")


# ============================================================================== J11
@register("J11")
class DecisionEscalation(JHandler):
    """Bounded decision request: options, reason, impact, protected facts, source pins, approver
    scope and expiry. Decisions are never fabricated: only authoritative K09/I10 records supplied
    in evidence_refs that cover the exact proposal pin are transcribed into approval_records
    (APPROVED/REJECTED, bound to the proposal action hash). Expired/revoked/mismatched decisions
    are reported and ignored. J11 ACCEPT requires at least one valid recorded decision."""

    manual_allowed = False
    REQUEST_TTL = timedelta(days=7)

    def action_hash(self, proposal: dict) -> str:
        return sha256_json({"action": "RECONCILIATION_DECISION", "proposal": proposal})

    def run(self, ctx: Context) -> Result:
        prop = ctx.field_record("proposal_ref")
        data = prop["data"]
        options, protected, scope, impact = [], [], "J08:accept", {}
        if prop["module_id"] == "J04":
            options = [{"id": o["id"], "decision": o["decision"]} for o in data["repair_options"]]
            targets = [p["target_ref"] for p in data["patches"]]
        elif prop["module_id"] == "J05":
            options = [{"id": p["plan_id"], "cost": p["cost"], "state": p["state"],
                        "protected_violations": p["protected_violations"]} for p in data["ranked_repairs"]]
            targets = [q["target_ref"] for p in data["ranked_repairs"] for q in p["owner_patches"]]
            impact = {p["plan_id"]: p["affected_downstream_count"] for p in data["ranked_repairs"]}
        else:
            options = [{"id": p["patch_id"]} for p in data["patch_proposals"]]
            targets = [p["target_ref"] for p in data["patch_proposals"]]
        for t in uniq_refs(targets):
            rec = ctx.store.get_record(ctx.project_id, ctx.branch_id, t["record_id"], t["version"])
            if rec and rec["lifecycle"] == "LOCKED":
                protected.append(t)
                scope = f"{rec['module_id']}:protected_change"
        expiry = (now_utc() + self.REQUEST_TTL).strftime("%Y-%m-%dT%H:%M:%SZ")
        request = {"proposal": prop["ref"], "action_hash": self.action_hash(prop["ref"]), "options": options,
                   "reason": "automation lacks authority or materially different valid repairs remain",
                   "impact": impact, "protected_facts": protected, "source_refs": prop["source_refs"],
                   "approver_scope": scope, "expires_at": expiry}
        records, findings = [], []
        for a in self.evidence(ctx):
            if a["module_id"] not in APPROVAL_MODULES:
                continue
            view = approval_view(a)
            if not covers(view, prop["ref"]):
                findings.append(ctx.finding("APPROVAL_MISMATCH", f"{a['record_id']} does not cover this exact "
                                            "proposal revision; renewed authorization required", severity="MAJOR",
                                            decision="FAIL", source_refs=[a["ref"]]))
                continue
            if view["decision"] == "APPROVED":
                prob = approval_problem(a, prop["ref"])
                if prob:
                    findings.append(ctx.finding(prob[0], f"{a['record_id']}: {prob[1]}", severity="BLOCKING",
                                                decision="FAIL", source_refs=[a["ref"]]))
                    continue
            elif view["decision"] != "REJECTED":
                findings.append(ctx.finding("NO_DECISION", f"{a['record_id']} decision is {view['decision']}",
                                            severity="MINOR", decision="UNKNOWN", source_refs=[a["ref"]]))
                continue
            records.append({"approval_id": view["approval_id"] or a["record_id"], "subject_ref": prop["ref"],
                            "action_hash": self.action_hash(prop["ref"]), "policy_ref": a["ref"],
                            "approver_id": a["principal_id"], "scopes": [scope], "source_refs": [prop["ref"]],
                            "issued_at": a["created_at"][:19] + "Z",
                            "expires_at": view["expiry"] or expiry, "revoked": False, "decision": view["decision"],
                            "evidence_origin": a["evidence_origin"]})
        unresolved = []
        if not records:
            findings.append(ctx.finding("DECISION_REQUIRED", json.dumps(request, sort_keys=True), severity="MAJOR",
                                        decision="UNKNOWN", source_refs=[prop["ref"]]))
            unresolved.append("J11:user_decision")
        elif any(r["decision"] == "REJECTED" for r in records):
            findings.append(ctx.finding("DECISION_REJECTED", "the user rejected this proposal; commit stops",
                                        severity="BLOCKING", decision="FAIL", source_refs=[prop["ref"]]))
        return Result(data={"approval_records": records, "findings": findings}, unresolved=unresolved)

    def validate(self, ctx: Context, record: dict) -> list[dict]:
        out = []
        for r in record["data"]["approval_records"]:
            if r["decision"] == "APPROVED" and r["expires_at"] <= now_utc().strftime("%Y-%m-%dT%H:%M:%SZ"):
                out.append(ctx.finding("EXPIRED_APPROVAL", f"{r['approval_id']} expired", severity="BLOCKING"))
        return out

    def accept_gate(self, ctx: Context, record: dict, approval: dict | None) -> list[dict]:
        if not record["data"]["approval_records"]:
            return [ctx.finding("DECISION_REQUIRED", "no recorded user decision", severity="BLOCKING",
                                decision="UNKNOWN")]
        return []
