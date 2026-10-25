"""Set F handlers: Editing Refinement (F01-F12).

F owns findings and patch *proposals*; F output is never a manuscript and never mutates C
prose, A canon or E state (Shared Contract sections 4 and 10).

Anchored patch convention (all F operations)
--------------------------------------------
* Every finding cites exact evidence spans {record_ref, span_id, start, end, text_hash} with
  Unicode code-point offsets into the pinned C prose record's data.text (akowe/spans.py).
* A textual patch has path "/text", target_ref = the exact manuscript pin, replacement = the new
  text for its anchor, and patch_id = the span_id of exactly one evidence span in the same
  record (the anchor). approval_ref names the authority under which the proposal is made: an
  explicit K09/I10 decision (F12 approval_ref or one supplied in input_refs) or, failing that,
  the approved manuscript pin itself. Without either, patches are withheld (findings only).
* CREATE/UPDATE reject unanchored, mismatched or overlapping patches (SPAN_CONFLICT,
  HASH_MISMATCH, PATCH_OVERLAP); a stale manuscript pin is VERSION_CONFLICT.
* VALIDATE re-checks every evidence span and patch anchor against the stored manuscript text,
  re-anchors against a newer manuscript revision (ambiguous -> SPAN_CONFLICT) and enforces
  protected names/facts. ACCEPT claims the patch spans for that manuscript revision in
  module_state ("f.patch_claims"); overlapping claims from another F record are PATCH_OVERLAP
  (queued for merge/review, never last-writer-wins).

Flow to C: the C owner merges accepted proposals with spans.build_replacement(manuscript,
[F records]) -> new text + inverse, submits it as a complete C replacement candidate against the
same base pin and accepts it. For F12, C acceptance of that replacement additionally requires an
I10/K09 authorization whose subject is that exact candidate (prior source approval cannot
authorize changed output); F12 itself only needs approval_ref when one is already known.
Accepting the new C revision lets the kernel invalidate exactly the consumers (G/H/F) that read
it, so final polish renews downstream evidence.
"""
from __future__ import annotations

import copy
import json
import re
import statistics
import unicodedata

from ..errors import AkoweError
from ..j_approvals import APPROVAL_MODULES, approval_problem, check_approval
from ..spans import (TEXT_PATH, anchored_patches, find_overlaps, make_span, occurrences, record_text, reanchor,
                     verify_span)
from . import register
from .base import Context, OperationHandler, Result

PROSE_MODULES = tuple(f"C{i:02d}" for i in range(2, 12))
WORD_RE = re.compile(r"\w+(?:['’]\w+)*", re.UNICODE)
SEVERITIES = ("INFO", "MINOR", "MAJOR", "BLOCKING")
CLAIMS_NS = "f.patch_claims"
CONTEXT_NS = "f.context"

AI_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "quote": {"type": ["string", "null"]},
                    "rule_id": {"type": "string"},
                    "severity": {"enum": list(SEVERITIES)},
                    "message": {"type": "string"},
                    "confidence": {"type": ["number", "null"]},
                    "replacement": {"type": ["string", "null"]},
                },
                "required": ["quote", "rule_id", "severity", "message", "confidence", "replacement"],
            },
        }
    },
    "required": ["items"],
}


def norm(text: str) -> str:
    """NFC + casefold + whitespace-normalized comparison text."""
    return " ".join(unicodedata.normalize("NFC", text).casefold().split())


def tokens(text: str) -> list[tuple[str, int, int]]:
    return [(norm(m.group(0)), m.start(), m.end()) for m in WORD_RE.finditer(text)]


def jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def is_current(rec: dict) -> bool:
    """A pin is current when it is the approved head, or the latest revision with no newer approval."""
    if rec.get("stale") or rec["lifecycle"] in ("SUPERSEDED", "REJECTED"):
        return False
    if rec.get("approved_version"):
        if rec["version"] == rec["approved_version"]:
            return True
        return rec["version"] == rec["latest_version"] and rec["version"] > rec["approved_version"]
    return rec["version"] == rec["latest_version"]


def head_of(ctx: Context, rec: dict) -> dict:
    v = rec.get("approved_version") or rec["latest_version"]
    return ctx.store.get_record(ctx.project_id, ctx.branch_id, rec["record_id"], v)


# ------------------------------------------------------------------------------ protected terms
def fact_list(data) -> list[dict]:
    """All Fact objects nested anywhere in a record's data."""
    out = []
    if isinstance(data, dict):
        if {"subject_id", "predicate", "value", "assertion_type"} <= set(data):
            out.append(data)
        else:
            for v in data.values():
                out.extend(fact_list(v))
    elif isinstance(data, list):
        for v in data:
            out.extend(fact_list(v))
    return out


def _strings(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str)]
    return []


def protected_names(rec: dict | None) -> list[str]:
    """F09: canonical spellings from an A15 language/naming record (never 'corrected')."""
    if not rec:
        return []
    data = rec.get("data") or {}
    names = set()
    for f in fact_list(data):
        if f["assertion_type"] == "FACT" and (f["predicate"] in ("entity.name", "alias") or
                                              f["predicate"].endswith(".name") or f["predicate"].endswith("alias")):
            names.update(_strings(f["value"]))
    terms = ((data.get("attributes") or {}).get("terms") or "")
    names.update(t.strip() for t in re.split(r"[,;\n]", terms))
    return sorted(n for n in names if len(n.strip()) >= 2)


def protected_facts(rec: dict | None) -> list[str]:
    """F11/F12: string values of protected FACT assertions in an A record."""
    if not rec:
        return []
    data = rec.get("data") or {}
    flags = set(data.get("protected_fact_flags") or [])
    out = set()
    for f in fact_list(data):
        if f["assertion_type"] != "FACT":
            continue
        if flags and not ({f["predicate"], f["subject_id"], f"{f['subject_id']}:{f['predicate']}", "*"} & flags):
            continue
        out.update(_strings(f["value"]))
    return sorted(v for v in out if len(v.strip()) >= 2)


def protected_violation(text: str, start: int, end: int, replacement: str, terms: list[str]) -> str | None:
    """A patch may not cut through, drop or add a protected term."""
    sub = text[start:end]
    for t in terms:
        for ts in occurrences(text, t):
            te = ts + len(t)
            if ts < end and start < te and not (start <= ts and te <= end):
                return f"edit boundary cuts protected term {t!r}"
        if sub.count(t) != replacement.count(t):
            return f"protected term {t!r} would change"
    return None


def nonempty_edit(text: str, start: int, end: int, rep: str) -> tuple[int, int, str] | None:
    """F patch replacements must be non-empty: express a deletion by widening the anchor by one
    neighbouring code point that the replacement keeps."""
    if rep != "":
        return start, end, rep
    if end < len(text):
        return start, end + 1, text[end]
    if start > 0:
        return start - 1, end, text[start - 1]
    return None


# ------------------------------------------------------------------------------ base handler
class FHandler(OperationHandler):
    """Common F behavior: manuscript resolution, anchoring, patch authority and validation."""

    kind = ""
    deterministic = False  # LOGIC part available without an AI slot
    protected_field: str | None = None  # payload field naming a protected-terms record

    # -- inputs -------------------------------------------------------------------------
    def manuscript(self, ctx: Context) -> dict:
        ms = ctx.field_record("manuscript_ref")
        if ms is None:
            raise AkoweError("MISSING_INPUT", "/payload/manuscript_ref", "manuscript_ref is required")
        if ms["module_id"] not in PROSE_MODULES:
            raise AkoweError("INVALID_INPUT", "/payload/manuscript_ref/module_id",
                                 "manuscript_ref must pin C-owned prose; F proposals are never manuscripts",
                                 status="REJECTED")
        record_text(ms)
        if not is_current(ms):
            raise AkoweError("VERSION_CONFLICT", "/payload/manuscript_ref",
                                 f"manuscript {ms['record_id']} v{ms['version']} is stale "
                                 f"(head v{ms['approved_version'] or ms['latest_version']}); review the current "
                                 "revision", status="REJECTED")
        return ms

    def protected_terms(self, ctx: Context, rec: dict | None = None) -> list[str]:
        return []

    def precheck(self, ctx: Context, ms: dict) -> None:
        return None

    def patch_authority(self, ctx: Context, ms: dict) -> dict | None:
        """Explicit approval (payload approval_ref or K09/I10 in input_refs) else the approved base pin."""
        candidates = []
        ap = ctx.field_record("approval_ref")
        if ap is not None:
            candidates.append(("/payload/approval_ref", ap))
        for i, _ in enumerate(ctx.request.get("input_refs") or []):
            rec = ctx.resolved.get(f"/input_refs/{i}")
            if rec is not None and rec["module_id"] in APPROVAL_MODULES:
                candidates.append((f"/input_refs/{i}", rec))
        for path, rec in candidates:
            check_approval(rec, path)
            return rec["ref"]
        if ms["lifecycle"] in ("APPROVED", "LOCKED"):
            return ms["ref"]
        return None

    # -- CREATE -------------------------------------------------------------------------
    def create(self, ctx: Context) -> Result:
        ms = self.manuscript(ctx)
        self.precheck(ctx, ms)
        terms = self.protected_terms(ctx)
        record_id = ctx.allocate_record_id()
        resource, transform = None, "LOGIC"
        if ctx.manual_candidate is not None:
            data = copy.deepcopy(ctx.manual_candidate)
            transform = "MANUAL"
            self.check_output(ctx, data, ms, terms, strict=True)
        else:
            authority = self.patch_authority(ctx, ms)
            findings, patches = self.analyze(ctx, ms, terms, authority)
            if self.creative:
                ai_f, ai_p, resource = self.ai_review(ctx, ms, terms, authority)
                findings += ai_f
                patches += ai_p
                transform = "AI"
            findings, patches = self.filter_spans(ctx, findings, patches)
            if patches is None:
                patches = []
            if authority is None and getattr(ctx, "f_withheld", 0):
                findings.append(ctx.finding("PATCHES_WITHHELD", f"{ctx.f_withheld} repair(s) not emitted as patches: "
                                            "no approval reference (approve the manuscript or supply a K09/I10 "
                                            "decision in input_refs)", severity="INFO", decision="UNKNOWN"))
            data = {"kind": self.kind, "findings": findings, "patches": patches}
            self.check_output(ctx, data, ms, terms, strict=True)
        self._remember(ctx, record_id, ms)
        return Result(data=data, transform=transform, resource=resource, record_id=record_id)

    def _remember(self, ctx: Context, record_id: str, ms: dict):
        prot = ctx.field_record(self.protected_field) if self.protected_field else None
        value = {"manuscript_ref": ms["ref"], "protected_ref": prot["ref"] if prot else None}
        ctx.on_commit(lambda tx: tx.put_state(ctx.project_id, ctx.branch_id, CONTEXT_NS, record_id, value))

    def analyze(self, ctx: Context, ms: dict, terms: list[str], authority: dict | None):
        """Deterministic (LOGIC) findings/patches. Default: none."""
        ctx.f_withheld = 0
        return [], []

    def filter_spans(self, ctx: Context, findings: list, patches: list):
        wanted = set(ctx.payload.get("span_ids") or [])
        if not wanted:
            return findings, patches
        keep = [f for f in findings if not f["evidence"] or {e["span_id"] for e in f["evidence"]} & wanted]
        return keep, [p for p in patches if p["patch_id"] in wanted]

    def make_patch(self, ctx: Context, ms: dict, span: dict, replacement: str, reason: str,
                   authority: dict | None) -> dict | None:
        if authority is None:
            ctx.f_withheld = getattr(ctx, "f_withheld", 0) + 1
            return None
        return {"patch_id": span["span_id"], "target_ref": ms["ref"], "path": TEXT_PATH,
                "replacement": replacement, "reason": reason[:2000] or "edit", "approval_ref": authority}

    # -- AI path ------------------------------------------------------------------------
    def ai_inputs(self, ctx: Context) -> dict:
        out = {}
        for ptr, rec in ctx.resolved.items():
            if ptr in ("/payload/manuscript_ref",) or rec.get("data") is None:
                continue
            out[ptr] = {"module_id": rec["module_id"], "record_id": rec["record_id"], "version": rec["version"],
                        "data": rec["data"]}
        return out

    def ai_review(self, ctx: Context, ms: dict, terms: list[str], authority: dict | None):
        text = record_text(ms)
        task = (f"Operation {ctx.op_id} - {ctx.op['name']}. {ctx.op['purpose']} Review the manuscript text and "
                "return review items. Each item quotes the exact passage it concerns (quote, copied verbatim and "
                "long enough to be unique; null for whole-manuscript remarks), a short rule_id criterion, severity, "
                "message with the suggested repair, confidence 0..1, and replacement text for the quoted passage "
                "when a concrete edit is proposed (else null). Never alter protected facts or names.")
        context = {"instruction": ctx.payload.get("instruction"), "request_payload": {
            k: v for k, v in ctx.payload.items() if not k.endswith("_ref") and not k.endswith("_refs")},
            "manuscript": {"record_id": ms["record_id"], "version": ms["version"], "text": text},
            "inputs": self.ai_inputs(ctx)}
        try:
            out, resource = ctx.ai_generate(task=task, output_schema=AI_ITEM_SCHEMA, context=context,
                                            protected_facts=terms)
        except AkoweError as exc:
            if exc.code == "CAPABILITY_UNAVAILABLE":
                raise AkoweError("CAPABILITY_UNAVAILABLE", "/payload",
                                     f"{ctx.op_id} needs an AI slot for semantic review; configure AI-1..AI-3 or "
                                     "supply a manual candidate", unresolved=[f"{ctx.op_id}:manual_candidate"]) from exc
            raise
        findings, patches = [], []
        for item in (out or {}).get("items", []):
            f, p = self._anchor_item(ctx, ms, text, item, terms, authority)
            findings.append(f)
            if p:
                patches.append(p)
        patches = self._drop_overlaps(ctx, findings, patches)
        return findings, patches, resource

    def _anchor_item(self, ctx, ms, text, item, terms, authority):
        sev = item.get("severity") if item.get("severity") in SEVERITIES else "MINOR"
        conf = item.get("confidence")
        conf = None if not isinstance(conf, (int, float)) else max(0.0, min(1.0, float(conf)))
        rule = re.sub(r"[^A-Za-z0-9_.:-]", "_", str(item.get("rule_id") or "REVIEW"))[:64] or "REVIEW"
        msg = str(item.get("message") or rule)
        quote = item.get("quote")
        if not quote:
            return ctx.finding(rule, msg, severity=sev, decision="FAIL", confidence=conf), None
        hits = occurrences(text, quote)
        if len(hits) != 1:
            why = "not found in the pinned text" if not hits else f"ambiguous ({len(hits)} matches; SPAN_CONFLICT)"
            return ctx.finding(rule, f"{msg} [unanchored: quote {why}]", severity=sev, decision="UNKNOWN",
                               confidence=conf), None
        start, end = hits[0], hits[0] + len(quote)
        rep = item.get("replacement")
        if isinstance(rep, str) and rep != quote:
            edit = nonempty_edit(text, start, end, rep)
            if edit is None:
                rep = None
            else:
                start, end, rep = edit
        span = make_span(ms, start, end)
        f = ctx.finding(rule, msg, severity=sev, decision="FAIL", evidence=[span], confidence=conf)
        if not isinstance(rep, str) or rep == quote:
            return f, None
        bad = protected_violation(text, span["start"], span["end"], rep, terms)
        if bad:
            return ctx.finding("PROTECTED_FACT_CHANGE", f"{msg} [suggested edit rejected: {bad}]", severity="MAJOR",
                               decision="UNKNOWN", evidence=[span], confidence=conf), None
        return f, self.make_patch(ctx, ms, span, rep, msg, authority)

    def _drop_overlaps(self, ctx, findings, patches):
        spans = {}
        for f in findings:
            for e in f["evidence"]:
                spans[e["span_id"]] = e
        kept, taken = [], []
        for p in sorted(patches, key=lambda p: (spans[p["patch_id"]]["start"], spans[p["patch_id"]]["end"])):
            s = spans[p["patch_id"]]
            if any(p["patch_id"] == q or find_overlaps([("a", s["start"], s["end"]), ("b", a, b)])
                   for q, a, b in taken):
                findings.append(ctx.finding("PATCH_OVERLAP", f"suggested edit {p['patch_id']} overlaps another "
                                            "suggestion; queued for review instead of choosing one",
                                            severity="MINOR", decision="UNKNOWN", evidence=[s]))
                continue
            taken.append((p["patch_id"], s["start"], s["end"]))
            kept.append(p)
        return kept

    # -- output checks (CREATE/UPDATE strict, VALIDATE as findings) ----------------------
    def check_output(self, ctx: Context, data: dict, ms: dict | None, terms: list[str], strict: bool) -> list[dict]:
        out: list[dict] = []

        def bad(code, msg, sev="BLOCKING"):
            if strict:
                raise AkoweError(code, "/manual_candidate" if ctx.manual_candidate is not None else "/payload",
                                     msg, status="REJECTED")
            out.append(ctx.finding(code, msg, severity=sev, decision="FAIL"))

        if data.get("kind") != self.kind:
            bad("INVALID_INPUT", f"kind must be {self.kind}")
        texts: dict[tuple, str] = {}

        def text_of(ref):
            key = (ref["record_id"], ref["version"])
            if key not in texts:
                rec = ctx.engine.resolve_ref(ref, ctx.project_id, ctx.branch_id, "/record_ref")
                if rec["module_id"] not in PROSE_MODULES:
                    raise AkoweError("INVALID_INPUT", "/record_ref", "evidence must cite C prose",
                                         status="REJECTED")
                texts[key] = record_text(rec)
            return texts[key]

        for f in data.get("findings", []):
            for ev in f["evidence"]:
                try:
                    reason = verify_span(text_of(ev["record_ref"]), ev)
                except AkoweError as exc:
                    reason = exc.errors[0]["message"]
                if reason:
                    bad("HASH_MISMATCH", f"finding {f['id']} span {ev['span_id']}: {reason}")
        for i, p in enumerate(data.get("patches", [])):
            if p["path"] != TEXT_PATH:
                bad("INVALID_INPUT", f"patch {p['patch_id']}: F proposes text edits only (path {TEXT_PATH})")
            if p["target_ref"]["module_id"] not in PROSE_MODULES:
                bad("INVALID_INPUT", f"patch {p['patch_id']}: target must be C prose; F never edits canon/state")
            if ms is not None and (p["target_ref"]["record_id"], p["target_ref"]["version"],
                                   p["target_ref"]["content_hash"]) != (ms["record_id"], ms["version"],
                                                                        ms["content_hash"]):
                bad("VERSION_CONFLICT", f"patch {p['patch_id']}: target must be the reviewed manuscript pin")
            try:
                appr = ctx.engine.resolve_ref(p["approval_ref"], ctx.project_id, ctx.branch_id, "/approval_ref")
                if appr["module_id"] in APPROVAL_MODULES:
                    prob = approval_problem(appr)
                    if prob:
                        bad(prob[0], f"patch {p['patch_id']}: {prob[1]}")
            except AkoweError as exc:
                bad(exc.code, f"patch {p['patch_id']} approval_ref: {exc.errors[0]['message']}")
        try:
            pairs = anchored_patches(data)
        except AkoweError as exc:
            bad(exc.code, exc.errors[0]["message"])
            pairs = []
        overl = find_overlaps([(p["patch_id"], ev["start"], ev["end"]) for p, ev in pairs])
        if overl:
            bad("PATCH_OVERLAP", f"patches {overl[0][0]} and {overl[0][1]} overlap; merge them or queue review")
        for p, ev in pairs:
            try:
                text = text_of(ev["record_ref"])
            except AkoweError:
                continue
            if verify_span(text, ev):
                continue
            why = protected_violation(text, ev["start"], ev["end"], p["replacement"], terms)
            if why:
                bad("PROTECTED_FACT_CHANGE", f"patch {p['patch_id']}: {why}")
        return out

    # -- UPDATE -------------------------------------------------------------------------
    def update(self, ctx: Context) -> Result:
        data = copy.deepcopy(ctx.payload)
        st = ctx.get_state(CONTEXT_NS, ctx.base["record_id"]) or {}
        ms = None
        if st.get("manuscript_ref"):
            ms = ctx.engine.resolve_ref(st["manuscript_ref"], ctx.project_id, ctx.branch_id, "/base_ref")
        self.check_output(ctx, data, ms, self._stored_terms(ctx, st), strict=True)
        return Result(data=data, transform="MANUAL")

    def _stored_terms(self, ctx: Context, st: dict) -> list[str]:
        ref = st.get("protected_ref")
        if not ref:
            return []
        try:
            rec = ctx.engine.resolve_ref(ref, ctx.project_id, ctx.branch_id, "/protected_ref")
        except AkoweError:
            return []
        return self.protected_terms(ctx, rec)

    # -- VALIDATE -----------------------------------------------------------------------
    def validate(self, ctx: Context, record: dict) -> list[dict]:
        data = record["data"]
        st = ctx.get_state(CONTEXT_NS, record["record_id"]) or {}
        terms = self._stored_terms(ctx, st)
        try:
            findings = self.check_output(ctx, data, None, terms, strict=False)
        except AkoweError as exc:
            return [ctx.finding(exc.code, exc.errors[0]["message"], severity="BLOCKING", decision="FAIL")]
        findings += self.check_currency(ctx, data)
        return findings

    def check_currency(self, ctx: Context, data: dict) -> list[dict]:
        """Patches against a superseded manuscript: report re-anchoring (or SPAN_CONFLICT)."""
        out = []
        try:
            pairs = anchored_patches(data)
        except AkoweError:
            return out
        for p, ev in pairs:
            tgt = ctx.store.get_record(ctx.project_id, ctx.branch_id, p["target_ref"]["record_id"],
                                       p["target_ref"]["version"])
            if tgt is None or is_current(tgt):
                continue
            head = head_of(ctx, tgt)
            try:
                moved = reanchor(record_text(tgt), record_text(head), ev)
                out.append(ctx.finding("VERSION_CONFLICT", f"patch {p['patch_id']} pins v{tgt['version']}; manuscript "
                                       f"is now v{head['version']}; anchor re-located at [{moved['start']},"
                                       f"{moved['end']}) - submit an UPDATE against the new pin",
                                       severity="BLOCKING", decision="FAIL"))
            except AkoweError as exc:
                out.append(ctx.finding(exc.code if exc.code == "SPAN_CONFLICT" else "VERSION_CONFLICT",
                                       f"patch {p['patch_id']}: {exc.errors[0]['message']}", severity="BLOCKING",
                                       decision="FAIL"))
        return out

    # -- ACCEPT: concurrent-editor overlap ledger ----------------------------------------
    def _claims(self, record: dict) -> dict[str, list[dict]]:
        out: dict[str, list[dict]] = {}
        for p, ev in anchored_patches(record["data"]):
            key = f"{p['target_ref']['record_id']}@{p['target_ref']['version']}"
            out.setdefault(key, []).append({"owner": record["record_id"], "version": record["version"],
                                            "patch_id": p["patch_id"], "start": ev["start"], "end": ev["end"]})
        return out

    @staticmethod
    def _conflicts(existing: list[dict], mine: list[dict], owner: str) -> list[str]:
        others = [c for c in existing if c["owner"] != owner]
        items = [("o:" + c["owner"] + ":" + c["patch_id"], c["start"], c["end"]) for c in others]
        items += [("m:" + c["patch_id"], c["start"], c["end"]) for c in mine]
        return [f"{a} / {b}" for a, b in find_overlaps(items) if a[0] != b[0]]

    def accept_gate(self, ctx: Context, record: dict, approval: dict | None) -> list[dict]:
        out = []
        for key, mine in self._claims(record).items():
            existing = (ctx.get_state(CLAIMS_NS, key) or {}).get("claims", [])
            for c in self._conflicts(existing, mine, record["record_id"]):
                out.append(ctx.finding("PATCH_OVERLAP", f"overlaps an accepted proposal on {key}: {c}; queue a "
                                       "merge/review", severity="BLOCKING", decision="FAIL"))
        return out

    def on_accept(self, ctx: Context, record: dict, tx) -> None:
        for key, mine in self._claims(record).items():
            row = tx.execute("SELECT value, revision FROM module_state WHERE project_id=? AND branch_id=? AND "
                             "namespace=? AND key=?", (ctx.project_id, ctx.branch_id, CLAIMS_NS, key)).fetchone()
            existing = json.loads(row["value"])["claims"] if row else []
            conflicts = self._conflicts(existing, mine, record["record_id"])
            if conflicts:
                raise AkoweError("PATCH_OVERLAP", "/payload/candidate_ref",
                                     f"concurrent accepted proposal overlaps: {conflicts[0]}", status="REJECTED")
            merged = [c for c in existing if c["owner"] != record["record_id"]] + mine
            tx.put_state(ctx.project_id, ctx.branch_id, CLAIMS_NS, key, {"claims": merged},
                         expected_revision=row["revision"] if row else 0)


# ------------------------------------------------------------------------------ AI review ops
@register("F01")
class DevelopmentalEditor(FHandler):
    kind = "narrative_findings"
    creative = True


@register("F04")
class CharacterizationEditor(FHandler):
    kind = "character_findings"
    creative = True


@register("F05")
class DialogueEditor(FHandler):
    kind = "dialogue_findings"
    creative = True


@register("F06")
class ProseStyleEditor(FHandler):
    kind = "prose_findings"
    creative = True


@register("F08")
class ClarityEditor(FHandler):
    kind = "clarity_findings"
    creative = True


@register("F10")
class TransitionEditor(FHandler):
    kind = "transition_findings"
    creative = True

    def precheck(self, ctx: Context, ms: dict) -> None:
        pos = ctx.payload["chapter_position"]
        if pos in ("first", "only") and "previous_chapter_ref" in ctx.payload:
            raise AkoweError("INVALID_INPUT", "/payload/previous_chapter_ref",
                                 f"chapter_position {pos} has no previous chapter", status="REJECTED")
        if pos in ("last", "only") and "next_chapter_ref" in ctx.payload:
            raise AkoweError("INVALID_INPUT", "/payload/next_chapter_ref",
                                 f"chapter_position {pos} has no next chapter", status="REJECTED")


@register("F11")
class LineEditor(FHandler):
    kind = "line_edit_findings"
    creative = True
    protected_field = "protected_facts_ref"

    def protected_terms(self, ctx: Context, rec: dict | None = None) -> list[str]:
        return protected_facts(rec or ctx.field_record("protected_facts_ref"))

    def precheck(self, ctx: Context, ms: dict) -> None:
        if ctx.payload.get("meaning_preservation") is not True:
            raise AkoweError("INVALID_INPUT", "/payload/meaning_preservation", "line edits must preserve meaning",
                                 status="REJECTED")


@register("F12")
class FinalPolish(FHandler):
    """Final polish proposal. Requires no unresolved blockers and pinned approved manuscript/canon;
    approval_ref is optional at CREATE (preview). C must obtain authorization for the exact
    polished replacement before accepting it (see module docstring)."""

    kind = "polish_findings"
    creative = True
    protected_field = "locked_canon_ref"

    def protected_terms(self, ctx: Context, rec: dict | None = None) -> list[str]:
        return protected_facts(rec or ctx.field_record("locked_canon_ref"))

    def precheck(self, ctx: Context, ms: dict) -> None:
        appr_ms = ctx.field_record("approved_manuscript_ref")
        if appr_ms["lifecycle"] not in ("APPROVED", "LOCKED") or appr_ms["version"] != appr_ms["approved_version"]:
            raise AkoweError("APPROVAL_REQUIRED", "/payload/approved_manuscript_ref",
                                 "final polish needs the approved manuscript head", unresolved=["C:accept"])
        if (ms["record_id"], ms["version"]) != (appr_ms["record_id"], appr_ms["version"]):
            raise AkoweError("VERSION_CONFLICT", "/payload/manuscript_ref",
                                 "manuscript_ref must pin the approved manuscript revision", status="REJECTED")
        canon = ctx.field_record("locked_canon_ref")
        if canon["lifecycle"] not in ("APPROVED", "LOCKED") or canon.get("stale"):
            raise AkoweError("APPROVAL_REQUIRED", "/payload/locked_canon_ref",
                                 "final polish needs approved/locked canon", unresolved=["A:accept"])
        blockers = ctx.field_record("unresolved_blockers")
        open_ = [f for f in list(blockers.get("findings") or []) + list((blockers.get("data") or {}).get("findings")
                                                                        or [])
                 if isinstance(f, dict) and f.get("severity") == "BLOCKING" and f.get("decision") in ("FAIL", "UNKNOWN")]
        if open_ or blockers.get("stale"):
            raise AkoweError("APPROVAL_REQUIRED", "/payload/unresolved_blockers",
                                 f"{len(open_)} unresolved blocking finding(s) remain"
                                 + ("; blocker report is stale" if blockers.get("stale") else ""),
                                 unresolved=[f"{blockers['module_id']}:resolve_blockers"])
        ap = ctx.field_record("approval_ref")
        if ap is not None:
            check_approval(ap, "/payload/approval_ref")


# ------------------------------------------------------------------------------ logic ops
@register("F02")
class StructureEditor(FHandler):
    """Structural order vs the approved beat map (plan.order/plan.parent_id facts)."""

    kind = "structure_findings"
    deterministic = True

    def analyze(self, ctx, ms, terms, authority):
        ctx.f_withheld = 0
        order = ctx.payload["chapter_order"]
        out = []
        seen = set()
        for i, cid in enumerate(order):
            if cid in seen:
                out.append(ctx.finding("DUPLICATE_CHAPTER", f"chapter {cid!r} appears more than once (position {i})",
                                       severity="MAJOR", decision="FAIL", confidence=1.0))
            seen.add(cid)
        bm = ctx.field_record("beat_map_ref")
        if bm is None:
            out.append(ctx.finding("NO_BEAT_MAP", "no beat map supplied; only internal order checks ran",
                                   severity="INFO", decision="UNKNOWN"))
            return out, []
        plan_order, parent = {}, {}
        for f in fact_list(bm.get("data")):
            if f["predicate"] == "plan.order" and isinstance(f["value"], int):
                plan_order[f["subject_id"]] = f["value"]
            elif f["predicate"] == "plan.parent_id":
                parent[f["subject_id"]] = f["value"]
        known = [c for c in order if c in plan_order]
        for c in order:
            if c not in plan_order:
                out.append(ctx.finding("UNPLANNED_CHAPTER", f"chapter {c!r} has no plan.order in the beat map",
                                       severity="MAJOR", decision="UNKNOWN", source_refs=[bm["ref"]]))
        parents = {parent.get(c) for c in known}
        siblings = [s for s in plan_order if parent.get(s) in parents and s not in seen] if known else []
        for s in sorted(siblings, key=lambda s: (plan_order[s], s)):
            out.append(ctx.finding("MISSING_STRUCTURAL_FUNCTION", f"planned item {s!r} (plan.order "
                                   f"{plan_order[s]}) is missing from chapter_order", severity="MAJOR",
                                   decision="FAIL", source_refs=[bm["ref"]], confidence=1.0))
        expected = sorted(known, key=lambda c: (plan_order[c], c))
        for pos, (got, want) in enumerate(zip(known, expected)):
            if got != want:
                out.append(ctx.finding("MISPLACED_CHAPTER", f"position {pos}: found {got!r}, beat map expects "
                                       f"{want!r}", severity="MAJOR", decision="FAIL", source_refs=[bm["ref"]],
                                       confidence=1.0))
        if not out:
            out.append(ctx.finding("STRUCTURE_ORDER", "chapter order matches the beat map", severity="INFO",
                                   decision="PASS", source_refs=[bm["ref"]], confidence=1.0))
        return out, []


SCENE_BREAK = re.compile(r"(?m)^[ \t]*(?:\*[ \t]*\*[ \t]*\*|#|~~~)[ \t]*$")


def scene_spans(text: str) -> list[tuple[int, int]]:
    out, cursor = [], 0
    bounds = [(m.start(), m.end()) for m in SCENE_BREAK.finditer(text)] + [(len(text), len(text))]
    for s, e in bounds:
        seg = text[cursor:s]
        lead = len(seg) - len(seg.lstrip())
        trail = len(seg.rstrip())
        if trail > lead:
            out.append((cursor + lead, cursor + trail))
        cursor = e
    return out


def parse_targets(spec: str) -> tuple[dict, list[str]]:
    targets, unknown = {}, []
    for part in [p for p in re.split(r"[,;\s]+", spec.strip()) if p]:
        m = re.fullmatch(r"(\d+)-(\d+)", part)
        kv = re.fullmatch(r"(min|max|max_ratio)[=:]([0-9]+(?:\.[0-9]+)?)", part)
        if m:
            targets["min"], targets["max"] = int(m.group(1)), int(m.group(2))
        elif kv:
            targets[kv.group(1)] = float(kv.group(2)) if kv.group(1) == "max_ratio" else int(float(kv.group(2)))
        else:
            unknown.append(part)
    return targets, unknown


@register("F03")
class PacingEditor(FHandler):
    """Deterministic pacing metrics from scene_lengths (words) against pacing_targets.

    pacing_targets grammar: "MIN-MAX", "min=N", "max=N", "max_ratio=R" (adjacent scene ratio),
    separated by commas/semicolons/spaces. Other text is reported UNKNOWN for qualitative review.
    Scenes are anchored to the text when scene-break lines (***, #, ~~~) split it into exactly
    len(scene_lengths) segments; declared vs measured word counts are then compared.
    """

    kind = "pacing_findings"
    deterministic = True

    def analyze(self, ctx, ms, terms, authority):
        ctx.f_withheld = 0
        lengths = ctx.payload["scene_lengths"]
        text = record_text(ms)
        out = []
        spans = scene_spans(text)
        anchored = len(spans) == len(lengths)
        ev = [[make_span(ms, s, e)] if anchored else [] for s, e in (spans if anchored else [(0, 0)] * len(lengths))]
        if not anchored:
            out.append(ctx.finding("SCENE_ANCHOR", f"text has {len(spans)} scene segment(s) but {len(lengths)} "
                                   "lengths were declared; metrics use the declared lengths", severity="MINOR",
                                   decision="UNKNOWN"))
        else:
            for i, (s, e) in enumerate(spans):
                measured = len(WORD_RE.findall(text[s:e]))
                if measured != lengths[i]:
                    out.append(ctx.finding("DECLARED_LENGTH", f"scene {i}: declared {lengths[i]} words, measured "
                                           f"{measured}", severity="MINOR", decision="FAIL", evidence=ev[i],
                                           confidence=1.0))
        for i, n in enumerate(lengths):
            if n == 0:
                out.append(ctx.finding("EMPTY_SCENE", f"scene {i} has zero length", severity="MAJOR", decision="FAIL",
                                       evidence=ev[i], confidence=1.0))
        spec = ctx.payload.get("pacing_targets")
        targets, unknown = parse_targets(spec) if spec else ({}, [])
        for i, n in enumerate(lengths):
            if "min" in targets and n < targets["min"]:
                out.append(ctx.finding("BELOW_TARGET", f"scene {i}: {n} words < min {targets['min']}",
                                       severity="MAJOR", decision="FAIL", evidence=ev[i], confidence=1.0))
            if "max" in targets and n > targets["max"]:
                out.append(ctx.finding("ABOVE_TARGET", f"scene {i}: {n} words > max {targets['max']}",
                                       severity="MAJOR", decision="FAIL", evidence=ev[i], confidence=1.0))
        if "max_ratio" in targets:
            for i in range(1, len(lengths)):
                a, b = lengths[i - 1], lengths[i]
                if min(a, b) > 0 and max(a, b) / min(a, b) > targets["max_ratio"]:
                    out.append(ctx.finding("ABRUPT_SHIFT", f"scenes {i - 1}->{i}: length ratio "
                                           f"{max(a, b) / min(a, b):.2f} > {targets['max_ratio']}", severity="MINOR",
                                           decision="FAIL", evidence=ev[i - 1] + ev[i], confidence=1.0))
        if unknown:
            out.append(ctx.finding("QUALITATIVE_TARGET", f"pacing target terms {unknown} are not machine-checkable; "
                                   "qualitative pacing needs review", severity="INFO", decision="UNKNOWN"))
        if lengths:
            out.append(ctx.finding("PACING_STATS", f"scenes={len(lengths)} total={sum(lengths)} "
                                   f"mean={statistics.mean(lengths):.1f} median={statistics.median(lengths)} "
                                   f"min={min(lengths)} max={max(lengths)}", severity="INFO", decision="PASS",
                                   confidence=1.0))
        return out, []


SENTENCE_RE = re.compile(r"[^.!?…\n]+(?:[.!?…]+|(?=\n)|$)")


def sentences(text: str) -> list[tuple[int, int]]:
    out = []
    for m in SENTENCE_RE.finditer(text):
        seg = m.group(0)
        lead = len(seg) - len(seg.lstrip())
        trail = len(seg.rstrip())
        if trail > lead and WORD_RE.search(seg):
            out.append((m.start() + lead, m.start() + trail))
    return out


@register("F07")
class RepetitionDetector(FHandler):
    """Fully deterministic lexical repetition (no AI).

    Units: comparison_scope 'chapter' compares within manuscript_ref; 'book' also compares the
    other C prose records supplied in input_refs. Exact repeats: sentences, then maximal word
    n-grams (3..8 tokens), compared as NFC/casefolded/whitespace-normalized text, reported when
    occurring >= exact_min_occurrences times; units containing an excluded term are skipped (the
    term is removed from sentence comparison text). Near repeats: sentence pairs whose token
    Jaccard >= similarity_threshold (empty/empty=1, one-empty=0) that are not exact repeats are
    flagged as candidates (decision UNKNOWN). Nothing is deleted; no patches are proposed.
    """

    kind = "repetition_findings"
    deterministic = True
    MIN_N, MAX_N = 3, 8

    def analyze(self, ctx, ms, terms, authority):
        ctx.f_withheld = 0
        p = ctx.payload
        k, thr = p["exact_min_occurrences"], p["similarity_threshold"]
        excluded = [norm(t) for t in p["excluded_terms"] if norm(t)]
        units = [ms]
        if p["comparison_scope"] == "book":
            for i, _ in enumerate(ctx.request.get("input_refs") or []):
                rec = ctx.resolved.get(f"/input_refs/{i}")
                if rec and rec["module_id"] in PROSE_MODULES and rec["record_id"] != ms["record_id"]:
                    units.append(rec)
        out = []

        def strip_excluded(s: str) -> str:
            for t in excluded:
                s = re.sub(r"(?<!\w)" + re.escape(t) + r"(?!\w)", " ", s)
            return " ".join(s.split())

        def has_excluded(s: str) -> bool:
            return any(re.search(r"(?<!\w)" + re.escape(t) + r"(?!\w)", s) for t in excluded)

        # sentences
        sents = []  # (rec, start, end, normalized, token set)
        for rec in units:
            text = record_text(rec)
            for s, e in sentences(text):
                n = strip_excluded(norm(text[s:e]))
                toks = {t for t, _, _ in tokens(n)}
                sents.append((rec, s, e, n, toks))
        groups: dict[str, list] = {}
        for item in sents:
            if item[3]:
                groups.setdefault(item[3], []).append(item)
        covered: dict[str, list[tuple[int, int]]] = {}
        exact_keys = set()
        for key, items in sorted(groups.items(), key=lambda kv: (kv[1][0][0]["record_id"], kv[1][0][1])):
            if len(items) >= k:
                exact_keys.add(key)
                ev = [make_span(r, s, e) for r, s, e, _, _ in items]
                for r, s, e, _, _ in items:
                    covered.setdefault(r["record_id"], []).append((s, e))
                out.append(ctx.finding("EXACT_SENTENCE", f"sentence repeated {len(items)} times: "
                                       f"{record_text(items[0][0])[items[0][1]:items[0][2]][:200]!r}",
                                       severity="MINOR", decision="FAIL", evidence=ev, confidence=1.0))
        # maximal n-grams
        toks_by = {rec["record_id"]: tokens(record_text(rec)) for rec in units}
        by_id = {rec["record_id"]: rec for rec in units}
        claimed: dict[str, set] = {rid: set() for rid in toks_by}
        for n in range(self.MAX_N, self.MIN_N - 1, -1):
            grams: dict[tuple, list] = {}
            for rid, toks in toks_by.items():
                for i in range(len(toks) - n + 1):
                    gram = tuple(t for t, _, _ in toks[i:i + n])
                    if has_excluded(" ".join(gram)):
                        continue
                    grams.setdefault(gram, []).append((rid, i))
            for gram, occ in sorted(grams.items(), key=lambda kv: (kv[1][0][0], kv[1][0][1])):
                # non-overlapping occurrences only
                occ2, last = [], {}
                for rid, i in occ:
                    if i >= last.get(rid, -1):
                        occ2.append((rid, i))
                        last[rid] = i + n
                if len(occ2) < k:
                    continue
                spans = [(rid, toks_by[rid][i][1], toks_by[rid][i + n - 1][2], i) for rid, i in occ2]
                inside = all(any(cs <= s and e <= ce for cs, ce in covered.get(rid, [])) for rid, s, e, _ in spans)
                maximal = all(all(j in claimed[rid] for j in range(i, i + n)) for rid, _, _, i in spans)
                if inside or maximal:
                    continue
                for rid, _, _, i in spans:
                    claimed[rid].update(range(i, i + n))
                ev = [make_span(by_id[rid], s, e) for rid, s, e, _ in spans]
                out.append(ctx.finding("EXACT_PHRASE", f"{n}-word phrase repeated {len(spans)} times: "
                                       f"{' '.join(gram)!r}", severity="MINOR", decision="FAIL", evidence=ev,
                                       confidence=1.0))
        # near repeats
        for i in range(len(sents)):
            for j in range(i + 1, len(sents)):
                a, b = sents[i], sents[j]
                if a[3] == b[3] and a[3] in exact_keys:
                    continue
                score = jaccard(a[4], b[4])
                if score >= thr and a[3] != b[3]:
                    out.append(ctx.finding("NEAR_REPEAT", f"similar sentences (token Jaccard {score:.4f} >= {thr}); "
                                           "candidate only, nothing removed", severity="INFO", decision="UNKNOWN",
                                           evidence=[make_span(a[0], a[1], a[2]), make_span(b[0], b[1], b[2])],
                                           confidence=round(score, 4)))
        return out, []


@register("F09")
class GrammarSpelling(FHandler):
    """Deterministic language checks; protected names (A15) are never 'corrected'.

    Rules: repeated adjacent word, doubled spaces, space before punctuation (skipped for fr*).
    A finding whose confidence is below confidence_floor is UNKNOWN (review) and gets no patch.
    Spelling/ambiguous grammar beyond these rules needs an AI pass or manual candidate.
    """

    kind = "grammar_findings"
    deterministic = True
    protected_field = "protected_names_ref"
    LEGIT_DOUBLES = {"en": {"had", "that", "is", "do", "very"}}

    def protected_terms(self, ctx: Context, rec: dict | None = None) -> list[str]:
        return protected_names(rec or ctx.field_record("protected_names_ref"))

    def analyze(self, ctx, ms, terms, authority):
        ctx.f_withheld = 0
        text = record_text(ms)
        floor = ctx.payload["confidence_floor"]
        lang = ctx.payload["language_tag"].lower()
        legit = self.LEGIT_DOUBLES.get(lang.split("-")[0], set())
        cands = []  # (rule, start, end, replacement, confidence, message)
        toks = list(WORD_RE.finditer(text))
        for a, b in zip(toks, toks[1:]):
            gap = text[a.end():b.start()]
            if gap and gap.isspace() and "\n\n" not in gap and norm(a.group(0)) == norm(b.group(0)):
                conf = 0.5 if norm(a.group(0)) in legit else 0.9
                cands.append(("REPEATED_WORD", a.start(), b.end(), a.group(0), conf,
                              f"repeated word {a.group(0)!r}"))
        for m in re.finditer(r"(?<=\S)( {2,})(?=\S)", text):
            cands.append(("DOUBLE_SPACE", m.start(1), m.end(1), " ", 0.99, "multiple spaces between words"))
        if not lang.startswith("fr"):
            for m in re.finditer(r"(?<=\w)( +)(?=[,.;:!?])", text):
                cands.append(("SPACE_BEFORE_PUNCT", m.start(1), m.end(1), "", 0.8, "space before punctuation"))
        out, patches = [], []
        for rule, s, e, rep, conf, msg in sorted(cands, key=lambda c: (c[1], c[2], c[0])):
            s, e, rep = nonempty_edit(text, s, e, rep) or (s, e, rep)
            span = make_span(ms, s, e)
            if protected_violation(text, s, e, rep, terms) or any(
                    norm(text[s:e]).find(norm(t)) >= 0 for t in terms):
                out.append(ctx.finding("PROTECTED_NAME", f"{msg} involves a protected name; not corrected",
                                       severity="INFO", decision="UNKNOWN", evidence=[span], confidence=conf))
                continue
            if conf < floor:
                out.append(ctx.finding(rule, f"{msg} (confidence {conf} below floor {floor}; review)",
                                       severity="MINOR", decision="UNKNOWN", evidence=[span], confidence=conf))
                continue
            out.append(ctx.finding(rule, msg, severity="MINOR", decision="FAIL", evidence=[span], confidence=conf))
            p = self.make_patch(ctx, ms, span, rep, msg, authority)
            if p:
                patches.append(p)
        return out, patches
