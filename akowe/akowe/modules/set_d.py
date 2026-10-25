"""Set D handlers: Art / Visual (D01-D12).

Every D OUTPUT is a descriptor of a distinct D-owned BINARY_ARTIFACT staged in the same
commit (see d_assets for the storage_uri scheme). Semantics (Set D "Set rules"):

* D01 style, D09 composition and D10 consistency check are deterministic JSON bytes
  (application/json) computed from the request; no AI and no invented image files.
* D02-D08 and D11 need imagery. With no connected "image" slot they hold with
  CAPABILITY_UNAVAILABLE and accept MANUAL input: the user uploads the image (I01 IMPORT
  binary) and either pins it in input_refs or sends a manual_candidate whose file_hash is the
  upload's SHA-256. The verified bytes are copied into a D-owned binary with provenance.
  An image-capable adapter (d_imaging protocol) is used with durable provider-job checkpoints.
* D08 with supplied panel assets produces a deterministic panel plan (logic part of HYBRID).
* D12 renders a deterministic SVG from a MapGraph (extracted from approved A04 coordinates
  or an existing D12 graph) and stores graph and sidecar as separate D12 auxiliary records.
* Approval needs rights.cleared=true, exact file checksum, approved/current inputs, no
  blocking D10/reviewer finding and visual reviewer/policy evidence for imagery.
"""
from __future__ import annotations

import copy
import json
import re

from ..canonical import canonical_bytes
from .. import d_assets as da
from .. import d_imaging
from .. import d_maps
from ..errors import AkoweError
from . import register
from .base import Context, OperationHandler, Result

APPROVED = ("APPROVED", "LOCKED")
IMAGE_OPS = ("D02", "D03", "D04", "D05", "D06", "D07", "D08", "D11")
JSON_MIME = "application/json"
SVG_MIME = "image/svg+xml"


def _internal_rights(op_id: str) -> dict:
    return {"license": "project-owned", "source": f"akowe:{op_id} deterministic output", "cleared": True}


def _asset_type(ctx: Context) -> str:
    return ctx.contracts.definition(ctx.op_id, "OUTPUT")["properties"]["asset_type"]["const"]


def _blocking(f: dict) -> bool:
    return f["severity"] == "BLOCKING" and f["decision"] in ("FAIL", "UNKNOWN")


def _canon_subjects(rec: dict) -> set:
    return {f["subject_id"] for f in (rec.get("data") or {}).get("facts", [])} | {rec["record_id"]}


def _protected_facts(rec: dict) -> list[dict]:
    """Facts flagged protected (by predicate, subject, subject:predicate or '*'), verbatim."""
    data = rec.get("data") or {}
    flags = set(data.get("protected_fact_flags", []))
    out = []
    for f in data.get("facts", []):
        if {"*", f["predicate"], f["subject_id"], f"{f['subject_id']}:{f['predicate']}"} & flags:
            out.append({k: f[k] for k in ("subject_id", "predicate", "value", "assertion_type")})
    appearance = (data.get("attributes") or {}).get("appearance")
    if appearance and ("appearance" in flags or "*" in flags):
        out.append({"subject_id": rec["record_id"], "predicate": "attributes.appearance", "value": appearance,
                    "assertion_type": "FACT"})
    return out


def _require_subject(rec: dict, subject_id: str, field: str, what: str):
    if subject_id not in _canon_subjects(rec):
        raise AkoweError("INVALID_INPUT", f"/payload/{field}",
                             f"{subject_id!r} is not a {what} in the pinned canon {rec['module_id']}:{rec['record_id']} "
                             f"v{rec['version']}", status="REJECTED")


def _a_sources(ctx: Context, rec: dict) -> list[dict]:
    out = []
    for ref in rec["source_refs"]:
        if ref["owner"] == "A":
            src = ctx.store.get_record(ctx.project_id, ctx.branch_id, ref["record_id"], ref["version"])
            if src is not None:
                out.append(src)
    return out


def _binary_json(ctx: Context, rec: dict) -> dict | None:
    _, blob, problems = da.check_binding(ctx, rec["data"], rec["module_id"])
    if problems or blob is None:
        return None
    try:
        return json.loads(blob.decode("utf-8"))
    except ValueError:
        return None


def _d10_findings(ctx: Context, ref: dict) -> list[tuple[dict, dict]]:
    """(D10 report, finding) pairs whose finding pins this exact asset revision."""
    out = []
    for rep in ctx.store.list_records(ctx.project_id, ctx.branch_id, module_id="D10", record_kind="OUTPUT"):
        if rep["lifecycle"] == "REJECTED":
            continue
        for f in rep["data"].get("findings", []):
            if any(da.same_pin(s, ref) for s in f.get("source_refs", [])):
                out.append((rep, f))
    return out


class DHandler(OperationHandler):
    """Shared D behaviour: applicability, binding validation, rights, input approval checks."""

    computed = False  # True: output bytes are computed by code; manual candidates are refused

    # -- applicability (Shared Contract section 6: artwork=true or an explicit request) --------
    def applicability(self, ctx: Context):
        m = ctx.manifest
        if m is None:
            return None
        if m.get("features", {}).get("artwork") is True or ctx.op_id in m.get("required_operations", []):
            return None
        if ctx.request.get("source_set") == "K":
            # Scheduler-dispatched work for an unselected art operation (text-only project).
            if "artwork" not in m.get("features", {}):
                raise AkoweError("MISSING_INPUT", "/feature_manifest/features/artwork",
                                     "feature 'artwork' state is unknown; set it in the project feature manifest")
            return ("REQUIRED_OR_DIRECT_REQUEST:artwork",
                    f"{ctx.op_id} requires artwork=true or an explicit user request; feature manifest revision "
                    f"{m['revision']} has artwork=false and does not select {ctx.op_id}")
        return None  # an authorized direct user request is an explicit requested asset

    def create(self, ctx: Context) -> Result:
        if self.computed and ctx.manual_candidate is not None:
            raise AkoweError("INVALID_INPUT", "/manual_candidate",
                                 f"{ctx.op_id} output bytes are computed deterministically from the payload; "
                                 "supply the payload fields instead of a manual candidate", status="REJECTED")
        return self.build(ctx)

    def build(self, ctx: Context) -> Result:  # pragma: no cover - overridden
        raise NotImplementedError

    def descriptor(self, ctx: Context, bref: dict, mime: str, rights: dict, findings: list, **extra) -> dict:
        data = {"asset_type": _asset_type(ctx), "storage_uri": da.asset_uri(bref), "mime_type": mime,
                "file_hash": bref["content_hash"], "rights": rights, "findings": findings}
        data.update(extra)
        return data

    def stage_json_asset(self, ctx: Context, doc: dict, source_refs: list) -> dict:
        return ctx.stage_binary(ctx.op_id, canonical_bytes(doc), JSON_MIME, source_refs=source_refs)

    # -- UPDATE: complete replacement that keeps the binary binding honest ---------------------
    def update(self, ctx: Context) -> Result:
        data = copy.deepcopy(ctx.payload)
        extra = self.rebind(ctx, data)
        srcs = [r for r in ctx.base["source_refs"]] + extra
        return Result(data=data, transform="MANUAL", source_refs=srcs)

    def rebind(self, ctx: Context, data: dict) -> list:
        parsed = da.parse_asset_uri(data.get("storage_uri", ""))
        if parsed and parsed["project"] == ctx.project_id and parsed["branch"] == ctx.branch_id:
            rec = ctx.store.get_record(ctx.project_id, ctx.branch_id, parsed["record_id"], parsed["version"])
            if (rec is not None and rec["representation"] == "BINARY_ARTIFACT" and rec["module_id"] == ctx.op_id
                    and rec["content_hash"] == data["file_hash"] == parsed["sha"]):
                if rec["binary"]["mime_type"] != data["mime_type"]:
                    raise AkoweError("INVALID_INPUT", "/payload/mime_type",
                                         "mime_type must equal the stored binary's MIME", status="REJECTED")
                return []
        raise AkoweError("INVALID_INPUT", "/payload/storage_uri",
                             f"storage_uri/file_hash must name this {ctx.op_id} record's own D-owned binary",
                             status="REJECTED")

    # -- VALIDATE ------------------------------------------------------------------------------
    def validate(self, ctx: Context, record: dict) -> list[dict]:
        if record["record_kind"] != "OUTPUT":
            return []
        data = record["data"]
        _, blob, out = da.check_binding(ctx, data, record["module_id"])
        if not data["rights"]["cleared"]:
            out.append(ctx.finding("RIGHTS", f"rights not cleared (license {data['rights']['license']!r}, source "
                                   f"{data['rights']['source']!r}); approval requires rights.cleared=true",
                                   severity="BLOCKING"))
        for f in data.get("findings", []):
            if _blocking(f):
                out.append(ctx.finding("STORED_FINDING", f"unresolved blocking finding {f['rule_id']}: "
                                       f"{f['message']}", severity="BLOCKING", decision=f["decision"],
                                       source_refs=f.get("source_refs", [])))
        if blob is not None:
            out.extend(self.check_bytes(ctx, record, blob))
        return out

    def check_bytes(self, ctx: Context, record: dict, blob: bytes) -> list[dict]:
        return []

    def input_findings(self, ctx: Context, record: dict) -> list[dict]:
        """Supplied A/D inputs must be approved revisions that are still the approved head."""
        out = []
        for ref in record["source_refs"]:
            if ref["owner"] not in ("A", "D") or ref["record_id"] == record["record_id"]:
                continue
            src = ctx.store.get_record(ctx.project_id, ctx.branch_id, ref["record_id"], ref["version"])
            if src is None:
                continue  # kernel SOURCE_PIN finding already blocks
            if src["representation"] == "BINARY_ARTIFACT" or src["record_kind"] != "OUTPUT":
                continue
            if src["lifecycle"] not in APPROVED:
                out.append(ctx.finding("INPUT_APPROVAL", f"input {ref['module_id']}:{ref['record_id']} v{ref['version']} "
                                       f"is {src['lifecycle']}, not an approved interpretation/canon",
                                       severity="BLOCKING", decision="UNKNOWN", source_refs=[ref]))
            elif src["approved_version"] and src["approved_version"] > ref["version"]:
                out.append(ctx.finding("CANON_CURRENT", f"input {ref['module_id']}:{ref['record_id']} approved head "
                                       f"moved to v{src['approved_version']}; asset pins v{ref['version']}",
                                       severity="BLOCKING", source_refs=[ref]))
        return out


# ====================================================================== D01 style
@register("D01")
class VisualStyle(DHandler):
    computed = True

    def build(self, ctx: Context) -> Result:
        p = ctx.payload
        refs, pins = [], []
        for i, rid in enumerate(p.get("reference_asset_ids", [])):
            rec = _resolve_asset_id(ctx, rid, f"/payload/reference_asset_ids/{i}")
            refs.append(rec["ref"])
            pins.append({"asset_id": rid, "ref": rec["ref"]})
        doc = {"kind": "akowe.visual_style", "style_name": p["style_name"], "style_rules": p["style_rules"],
               "publishing_format": p["publishing_format"]}
        if "palette" in p:
            doc["palette"] = p["palette"]
        if "reference_asset_ids" in p:
            doc["reference_assets"] = pins
        bref = self.stage_json_asset(ctx, doc, refs)
        f = ctx.finding("STYLE_BYTES", "style_name/style_rules/publishing_format"
                        + ("/palette" if "palette" in p else "") + " stored in the asset bytes bound by file_hash",
                        severity="INFO", decision="PASS")
        return Result(data=self.descriptor(ctx, bref, JSON_MIME, _internal_rights("D01"), [f]), source_refs=refs)

    def check_bytes(self, ctx, record, blob):
        try:
            doc = json.loads(blob.decode("utf-8"))
            ok = all(isinstance(doc.get(k), str) and doc[k] for k in ("style_name", "style_rules", "publishing_format"))
        except ValueError:
            ok = False
        return [] if ok else [ctx.finding("STYLE_BYTES", "style bytes lack style_name/style_rules/publishing_format",
                                          severity="BLOCKING")]


def _resolve_asset_id(ctx: Context, rid: str, pointer: str) -> dict:
    rec = ctx.store.get_record(ctx.project_id, ctx.branch_id, rid)
    if rec is None or not (rec["owner"] == "D" or (rec["module_id"] == "I01" and rec["representation"] == "BINARY_ARTIFACT")):
        raise AkoweError("INVALID_INPUT", pointer, f"reference asset {rid!r} is not a D asset or uploaded image "
                             "in this project/branch", status="REJECTED")
    return rec


# ====================================================================== imagery D02-D08, D11
class ImageAsset(DHandler):
    """Image-producing operation: manual upload or image-capable slot; never fabricated bytes."""

    def build(self, ctx: Context) -> Result:
        context, extra_refs, findings = self.prepare(ctx)
        manual = ctx.manual_candidate
        imp = da.find_import(ctx, manual["file_hash"] if manual else None, pointer="/manual_candidate/file_hash")
        if manual is not None or imp is not None:
            return self.from_upload(ctx, manual, imp, extra_refs, findings)
        logic = self.logic_result(ctx, context, extra_refs, findings)
        if logic is not None:
            return logic
        request = {"operation": ctx.op_id, "name": ctx.op["name"], "purpose": ctx.op["purpose"],
                   "payload": {k: v for k, v in ctx.payload.items() if not isinstance(v, (dict, list))},
                   **context}
        try:
            got = d_imaging.generate(ctx, request)
        except AkoweError as exc:
            if exc.code == "CAPABILITY_UNAVAILABLE":
                raise AkoweError(
                    "CAPABILITY_UNAVAILABLE", "/payload",
                    f"{ctx.op_id} needs image generation and no connected AI slot offers 'image'. Upload the image "
                    "(I01 import) and pin it in input_refs, or send a manual_candidate whose file_hash is the "
                    "upload's SHA-256.", unresolved=[f"{ctx.op_id}:manual_image"]) from exc
            raise
        if isinstance(got, Result):
            return got
        blob, mime, resource, license_ = got
        bref = ctx.stage_binary(ctx.op_id, blob, mime, source_refs=self._pins(ctx, extra_refs))
        rights = {"license": license_ or "provider terms (unreviewed)",
                  "source": f"{resource['ai_slot']}/{resource['adapter_id']} job {resource['provider_job_id']}",
                  "cleared": False}
        findings = findings + [ctx.finding("RIGHTS_REVIEW", "generated image rights must be reviewed and cleared "
                                           "before approval", severity="MAJOR", decision="UNKNOWN")]
        return Result(data=self.descriptor(ctx, bref, mime, rights, findings), source_refs=extra_refs,
                      resource=resource, transform="AI")

    def _pins(self, ctx: Context, extra: list) -> list:
        seen, out = set(), []
        for r in [rec["ref"] for rec in ctx.resolved.values()] + extra:
            k = (r["record_id"], r["version"])
            if k not in seen:
                seen.add(k)
                out.append(r)
        return out

    def from_upload(self, ctx, manual, imp, extra_refs, findings) -> Result:
        if imp is None:
            raise AkoweError("MISSING_INPUT", "/manual_candidate/file_hash",
                                 "no uploaded image (I01 import) has this file_hash; upload the image first and use "
                                 "its exact SHA-256", status="BLOCKED")
        blob, mime = da.load_import(ctx, imp, manual["mime_type"] if manual else None,
                                    "/manual_candidate/file_hash" if manual else "/input_refs")
        extra_refs = extra_refs + ([imp["ref"]] if all(not da.same_pin(imp["ref"], r) for r in extra_refs) else [])
        bref = ctx.stage_binary(ctx.op_id, blob, mime, source_refs=self._pins(ctx, extra_refs))
        if manual is not None:
            rights = manual["rights"]
            findings = list(manual["findings"]) + findings
        else:
            rights = {"license": "unspecified", "source": f"user upload {imp['record_id']}", "cleared": False}
        findings = findings + [ctx.finding("PROVENANCE", f"bytes copied from uploaded I01 import {imp['record_id']} "
                                           f"v{imp['version']} (sha256 {imp['content_hash']}) into a D-owned binary",
                                           severity="INFO", decision="PASS", source_refs=[imp["ref"]])]
        return Result(data=self.descriptor(ctx, bref, mime, rights, findings), source_refs=extra_refs,
                      transform="MANUAL")

    def prepare(self, ctx: Context) -> tuple[dict, list, list]:
        """Op-specific canon checks; returns (generation context, extra source pins, findings)."""
        return {}, [], []

    def logic_result(self, ctx, context, extra_refs, findings) -> Result | None:
        return None

    def style_context(self, ctx: Context) -> dict:
        style = ctx.field_record("style_ref")
        doc = _binary_json(ctx, style) if style else None
        if style is not None and doc is None:
            raise AkoweError("INVALID_INPUT", "/payload/style_ref", "style asset bytes do not verify",
                                 status="REJECTED")
        return {"style": doc} if doc else {}

    def reference_pins(self, ctx: Context) -> tuple[list, list]:
        refs, ctxs = [], []
        for i, rid in enumerate(ctx.payload.get("reference_asset_ids", [])):
            rec = _resolve_asset_id(ctx, rid, f"/payload/reference_asset_ids/{i}")
            refs.append(rec["ref"])
            ctxs.append({"asset_id": rid, "module_id": rec["module_id"], "content_hash": rec["content_hash"]})
        return refs, ctxs

    # -- UPDATE may replace the image with a newly uploaded one ---------------------------------
    def rebind(self, ctx: Context, data: dict) -> list:
        try:
            return super().rebind(ctx, data)
        except AkoweError:
            imp = da.find_import(ctx, data["file_hash"], pointer="/payload/file_hash")
            if imp is None:
                raise
        blob, mime = da.load_import(ctx, imp, data["mime_type"], "/payload/file_hash")
        bref = ctx.stage_binary(ctx.op_id, blob, mime, source_refs=list(ctx.base["source_refs"]) + [imp["ref"]])
        data["storage_uri"] = da.asset_uri(bref)
        return [imp["ref"]]

    def validate(self, ctx, record):
        out = super().validate(ctx, record)
        if record["record_kind"] != "OUTPUT":
            return out
        out.extend(self.input_findings(ctx, record))
        for rep, f in _d10_findings(ctx, record["ref"]):
            if _blocking(f):
                out.append(ctx.finding("VISUAL_CONSISTENCY", f"D10 {rep['record_id']} v{rep['version']} "
                                       f"{f['rule_id']}: {f['message']}", severity="BLOCKING",
                                       decision=f["decision"], source_refs=f.get("source_refs", [])))
        return out

    def accept_gate(self, ctx, record, approval):
        if record["data"]["mime_type"] == JSON_MIME:  # D08 panel plan: no new imagery to review
            return []
        if approval is not None:
            return []
        reviewed = [(rep, f) for rep, f in _d10_findings(ctx, record["ref"]) if rep["lifecycle"] in APPROVED]
        if reviewed and all(f["decision"] in ("PASS", "NOT_APPLICABLE") for _, f in reviewed):
            return []
        return [ctx.finding("VISUAL_REVIEW", "visual approval needs reviewer/policy evidence: an approval_ref "
                            "(K09/I10) or an approved D10 check whose findings for this exact asset all PASS",
                            severity="BLOCKING", decision="UNKNOWN")]


@register("D02")
class CharacterReference(ImageAsset):
    def prepare(self, ctx):
        canon = ctx.field_record("appearance_canon_ref")
        _require_subject(canon, ctx.payload["character_id"], "character_id", "character")
        refs, rctx = self.reference_pins(ctx)
        context = {**self.style_context(ctx), "character_id": ctx.payload["character_id"],
                   "appearance": (canon["data"].get("attributes") or {}).get("appearance"),
                   "protected_facts": _protected_facts(canon), "reference_assets": rctx}
        return context, refs, []


@register("D03")
class CharacterPose(ImageAsset):
    def prepare(self, ctx):
        ref_rec = ctx.field_record("character_reference_ref")
        canon = [s for s in _a_sources(ctx, ref_rec) if s["module_id"] == "A01"]
        if not canon:
            raise AkoweError("INVALID_INPUT", "/payload/character_reference_ref",
                                 "character reference has no pinned A01 appearance canon", status="REJECTED")
        if not any(ctx.payload["character_id"] in _canon_subjects(c) for c in canon):
            raise AkoweError("INVALID_INPUT", "/payload/character_id",
                                 "character_id does not match the reference's appearance canon", status="REJECTED")
        context = {**self.style_context(ctx), "character_id": ctx.payload["character_id"],
                   "reference_image": {"storage_uri": ref_rec["data"]["storage_uri"],
                                       "file_hash": ref_rec["data"]["file_hash"]},
                   "protected_facts": [f for c in canon for f in _protected_facts(c)]}
        return context, [c["ref"] for c in canon], []


@register("D04")
class EnvironmentArt(ImageAsset):
    def prepare(self, ctx):
        canon = ctx.field_record("location_canon_ref")
        _require_subject(canon, ctx.payload["location_id"], "location_id", "location")
        context = {**self.style_context(ctx), "location_id": ctx.payload["location_id"],
                   "geography": canon["data"].get("attributes"), "protected_facts": _protected_facts(canon)}
        return context, [], []


@register("D05")
class CreatureArt(ImageAsset):
    def prepare(self, ctx):
        canon = ctx.field_record("creature_canon_ref")
        _require_subject(canon, ctx.payload["creature_id"], "creature_id", "creature/species")
        refs, rctx = self.reference_pins(ctx)
        habitat = ctx.field_record("habitat_ref")
        context = {**self.style_context(ctx), "creature_id": ctx.payload["creature_id"],
                   "biology": canon["data"].get("attributes"), "protected_facts": _protected_facts(canon),
                   "habitat": habitat["data"].get("attributes") if habitat else None, "reference_assets": rctx}
        return context, refs, []


@register("D06")
class ItemArt(ImageAsset):
    def prepare(self, ctx):
        canon = ctx.field_record("object_canon_ref")
        _require_subject(canon, ctx.payload["object_id"], "object_id", "object/weapon")
        refs, rctx = self.reference_pins(ctx)
        context = {**self.style_context(ctx), "object_id": ctx.payload["object_id"],
                   "object": canon["data"].get("attributes"), "protected_facts": _protected_facts(canon),
                   "reference_assets": rctx}
        return context, refs, []


@register("D07")
class SceneIllustration(ImageAsset):
    SUBJECT_FIELDS = ("character_asset_refs", "creature_asset_refs", "object_asset_refs")

    def prepare(self, ctx):
        subjects = []
        for field in self.SUBJECT_FIELDS:
            for i, rec in enumerate(ctx.field_records(field)):
                subjects.append((f"/payload/{field}/{i}", rec))
        loc = ctx.field_record("location_asset_ref")
        if loc is not None:
            subjects.append(("/payload/location_asset_ref", loc))
        for ptr, rec in subjects:  # supplied subjects need approved reference interpretations
            if rec["lifecycle"] not in APPROVED:
                raise AkoweError("APPROVAL_REQUIRED", ptr, f"{rec['module_id']}:{rec['record_id']} "
                                     f"v{rec['version']} is {rec['lifecycle']}; depicted subjects need approved "
                                     "reference interpretations", unresolved=[f"{rec['module_id']}:accept"])
        canon = [s for _, rec in subjects for s in _a_sources(ctx, rec)]
        context = {**self.style_context(ctx), "scene_description": ctx.payload["scene_description"],
                   "subjects": [{"field": p, "storage_uri": r["data"]["storage_uri"],
                                 "file_hash": r["data"]["file_hash"]} for p, r in subjects],
                   "protected_facts": [f for c in canon for f in _protected_facts(c)]}
        findings = []
        if not any(ctx.payload.get(f) for f in self.SUBJECT_FIELDS):
            findings.append(ctx.finding("SUBJECTS", "no depicted characters/creatures/objects supplied; scene is "
                                        "illustrated without them" + (" (empty location scene)" if loc else ""),
                                        severity="INFO", decision="PASS"))
        return context, [c["ref"] for c in canon], findings


ORDER_SPLIT = re.compile(r"[\s,;>]+")


@register("D08")
class ComicPanels(ImageAsset):
    def prepare(self, ctx):
        page = da.parse_dimensions(ctx.payload["page_dimensions"], "/payload/page_dimensions")
        panels = ctx.field_records("asset_refs")
        order = self.reading_order(ctx, panels)
        return {**self.style_context(ctx), "page": page, "panel_order": order}, [], []

    @staticmethod
    def reading_order(ctx, panels: list[dict]) -> list[int]:
        """reading_order must be a unique complete ordering of the supplied panels."""
        raw = ctx.payload.get("reading_order")
        if raw is None:
            return list(range(len(panels)))
        if not panels:
            raise AkoweError("INVALID_INPUT", "/payload/reading_order",
                                 "reading_order orders supplied panels; asset_refs is empty", status="REJECTED")
        ids = {p["record_id"]: i for i, p in enumerate(panels)}
        order = []
        for tok in [t for t in ORDER_SPLIT.split(raw.strip()) if t]:
            if tok.isdigit() and 1 <= int(tok) <= len(panels):
                order.append(int(tok) - 1)
            elif tok in ids:
                order.append(ids[tok])
            else:
                raise AkoweError("INVALID_INPUT", "/payload/reading_order",
                                     f"unknown panel {tok!r}; use 1-based positions or panel record IDs",
                                     status="REJECTED")
        if len(order) != len(set(order)):
            raise AkoweError("INVALID_INPUT", "/payload/reading_order", "reading_order repeats a panel",
                                 status="REJECTED")
        if len(order) != len(panels):
            raise AkoweError("INVALID_INPUT", "/payload/reading_order",
                                 f"reading_order lists {len(order)} of {len(panels)} supplied panels",
                                 status="REJECTED")
        return order

    def logic_result(self, ctx, context, extra_refs, findings):
        panels = ctx.field_records("asset_refs")
        if not panels:
            return None
        for i, rec in enumerate(panels):
            if rec["lifecycle"] not in APPROVED:
                raise AkoweError("APPROVAL_REQUIRED", f"/payload/asset_refs/{i}",
                                     f"panel asset {rec['record_id']} v{rec['version']} is not approved",
                                     unresolved=[f"{rec['module_id']}:accept"])
        page, order = context["page"], context["panel_order"]
        n = len(order)
        cols = 1 if n == 1 else 2
        rows = -(-n // cols)
        w, hgt = page["width"] / cols, page["height"] / rows
        layout = []
        for pos, idx in enumerate(order):
            rec = panels[idx]
            r, c = divmod(pos, cols)
            layout.append({"reading_index": pos + 1, "asset_ref": rec["ref"], "file_hash": rec["data"]["file_hash"],
                           "box": {"x": c * w, "y": r * hgt, "width": w, "height": hgt, "unit": page["unit"]}})
        doc = {"kind": "akowe.panel_plan", "panel_brief": ctx.payload["panel_brief"], "page": page,
               "style_ref": ctx.payload["style_ref"], "panels": layout}
        bref = self.stage_json_asset(ctx, doc, self._pins(ctx, extra_refs))
        f = ctx.finding("READING_ORDER", f"{n} supplied panels in a unique complete reading order",
                        severity="INFO", decision="PASS")
        return Result(data=self.descriptor(ctx, bref, JSON_MIME, _internal_rights("D08"), findings + [f]),
                      source_refs=extra_refs)


@register("D11")
class CoverArtwork(ImageAsset):
    def prepare(self, ctx):
        trim = da.parse_dimensions(ctx.payload["trim_dimensions"], "/payload/trim_dimensions")
        refs, rctx = self.reference_pins(ctx)
        context = {**self.style_context(ctx), "trim": trim, "reference_assets": rctx,
                   "note": "front cover artwork only; no spine/wrap geometry"}
        f = ctx.finding("NO_SPINE_GEOMETRY", "cover artwork does not claim final print spine/wrap geometry; G10 "
                        "owns typography and wrap layout", severity="INFO", decision="NOT_APPLICABLE")
        return context, refs, [f]


# ====================================================================== D09 composition
@register("D09")
class Composition(DHandler):
    computed = True
    ANCHORS = {"center": (0.5, 0.5), "centre": (0.5, 0.5), "left": (1 / 3, 0.5), "right": (2 / 3, 0.5),
               "top": (0.5, 1 / 3), "bottom": (0.5, 2 / 3), "upper-left": (1 / 3, 1 / 3),
               "upper-right": (2 / 3, 1 / 3), "lower-left": (1 / 3, 2 / 3), "lower-right": (2 / 3, 2 / 3)}

    def build(self, ctx):
        p = ctx.payload
        canvas = da.parse_dimensions(p["canvas_dimensions"], "/payload/canvas_dimensions")
        W, H = canvas["width"], canvas["height"]
        focal = self.focal(p.get("focal_point"), W, H)
        assets = ctx.field_records("asset_refs")
        n = max(len(assets), 1)
        placements = []
        for i, rec in enumerate(assets):
            placements.append({"asset_ref": rec["ref"], "file_hash": rec["data"]["file_hash"], "z": i,
                               "box": {"x": W * i / n, "y": 0, "width": W / n, "height": H}})
        doc = {"kind": "akowe.composition", "composition_brief": p["composition_brief"], "canvas": canvas,
               "focal_point": {"x": focal[0], "y": focal[1], "source": p.get("focal_point", "rule-of-thirds")},
               "style_ref": p["style_ref"], "placements": placements}
        bref = self.stage_json_asset(ctx, doc, [r["ref"] for r in ctx.resolved.values()])
        f = ctx.finding("CANVAS_FIT", f"{len(placements)} placements fit the {W}x{H} {canvas['unit']} canvas",
                        severity="INFO", decision="PASS")
        return Result(data=self.descriptor(ctx, bref, JSON_MIME, _internal_rights("D09"), [f]))

    def focal(self, text, W, H):
        if text is None:
            return (W / 3, H / 3)
        key = text.strip().lower()
        if key in self.ANCHORS:
            fx, fy = self.ANCHORS[key]
            return (W * fx, H * fy)
        m = re.match(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$", text)
        if not m:
            raise AkoweError("INVALID_INPUT", "/payload/focal_point", "focal_point must be 'x,y' in canvas units "
                                 f"or one of {sorted(self.ANCHORS)}", status="REJECTED")
        x, y = float(m.group(1)), float(m.group(2))
        if not (0 <= x <= W and 0 <= y <= H):
            raise AkoweError("INVALID_INPUT", "/payload/focal_point", "focal point lies outside the canvas",
                                 status="REJECTED")
        return (x, y)

    def check_bytes(self, ctx, record, blob):
        try:
            doc = json.loads(blob.decode("utf-8"))
            W, H = doc["canvas"]["width"], doc["canvas"]["height"]
            ok = W > 0 and H > 0 and all(
                b["x"] >= 0 and b["y"] >= 0 and b["width"] > 0 and b["height"] > 0
                and b["x"] + b["width"] <= W + 1e-9 and b["y"] + b["height"] <= H + 1e-9
                for b in (pl["box"] for pl in doc["placements"]))
        except (ValueError, KeyError, TypeError):
            ok = False
        return [] if ok else [ctx.finding("CANVAS_FIT", "composition placements do not fit a positive canvas",
                                          severity="BLOCKING")]


# ====================================================================== D10 consistency check
@register("D10")
class ConsistencyChecker(DHandler):
    computed = True

    def build(self, ctx):
        assets = ctx.field_records("asset_refs")
        refs = ctx.field_records("reference_revision_refs")
        tol = ctx.payload["tolerance_profile"]
        findings = []
        for a in assets:
            findings.extend(self.check_asset(ctx, a, refs, tol))
        doc = self.document(ctx, assets, refs, tol, findings)
        bref = self.stage_json_asset(ctx, doc, [r["ref"] for r in ctx.resolved.values()])
        return Result(data=self.descriptor(ctx, bref, JSON_MIME, _internal_rights("D10"), findings))

    @staticmethod
    def document(ctx, assets, refs, tol, findings) -> dict:
        def entry(r):
            return {"ref": r["ref"], "file_hash": r["data"]["file_hash"], "mime_type": r["data"]["mime_type"]}
        return {"kind": "akowe.visual_consistency_check", "tolerance_profile": tol,
                "assets": [entry(a) for a in assets], "references": [entry(r) for r in refs], "findings": findings}

    def check_asset(self, ctx, a, refs, tol) -> list[dict]:
        out = []
        aref = a["ref"]
        _, blob, problems = da.check_binding(ctx, a["data"], a["module_id"])
        if problems:
            out.append(ctx.finding("ASSET_FILE", "; ".join(p["message"] for p in problems), severity="BLOCKING",
                                   source_refs=[aref]))
        a_canon = _a_sources(ctx, a)
        for c in a_canon:
            if c["approved_version"] and c["approved_version"] > c["version"]:
                out.append(ctx.finding("CANON_CURRENT", f"asset pins {c['module_id']}:{c['record_id']} v{c['version']}"
                                       f" but approved canon is v{c['approved_version']}", severity="BLOCKING",
                                       source_refs=[aref, c["ref"]]))
        protected = [f for c in a_canon for f in _protected_facts(c)]
        if protected and a["data"]["mime_type"] != JSON_MIME and a["module_id"] != "D12":
            facts = "; ".join(f"{f['subject_id']} {f['predicate']}={f['value']!r}" for f in protected)
            out.append(ctx.finding("PROTECTED_APPEARANCE", f"protected identity facts need zero-deviation visual "
                                   f"confirmation by a reviewer: {facts}", severity="BLOCKING", decision="UNKNOWN",
                                   source_refs=[aref] + [c["ref"] for c in a_canon]))
        for r in refs:
            rref = r["ref"]
            pair = [aref, rref]
            if da.same_pin(aref, rref):
                out.append(ctx.finding("SELF_REFERENCE", "asset is its own reference revision", severity="INFO",
                                       decision="NOT_APPLICABLE", source_refs=pair))
                continue
            if r["lifecycle"] not in APPROVED:
                out.append(ctx.finding("REFERENCE_APPROVED", f"reference {r['record_id']} v{r['version']} is "
                                       f"{r['lifecycle']}; compare against approved references",
                                       severity="MAJOR", decision="UNKNOWN", source_refs=pair))
            drift = False
            for s in a["source_refs"]:
                if s["record_id"] == rref["record_id"] and not da.same_pin(s, rref):
                    drift = True
                    out.append(ctx.finding("REFERENCE_PIN", f"asset was derived from {s['module_id']}:{s['record_id']} "
                                           f"v{s['version']} but the check pins v{rref['version']}",
                                           severity="BLOCKING", source_refs=pair))
            r_canon = {c["record_id"]: c for c in _a_sources(ctx, r)}
            for c in a_canon:
                rc = r_canon.get(c["record_id"])
                if rc is not None and rc["version"] != c["version"]:
                    drift = True
                    out.append(ctx.finding("CANON_PIN", f"asset uses {c['module_id']}:{c['record_id']} v{c['version']}"
                                           f", reference uses v{rc['version']}; protected identity cannot drift",
                                           severity="BLOCKING", source_refs=pair + [c["ref"], rc["ref"]]))
            if a["data"]["file_hash"] == r["data"]["file_hash"] and not problems:
                out.append(ctx.finding("EXACT_MATCH", "asset bytes equal the reference bytes", severity="INFO",
                                       decision="PASS", source_refs=pair))
                continue
            if a["module_id"] == "D12" and r["module_id"] == "D12":
                out.extend(self.map_pair(ctx, a, r, tol, pair))
                continue
            if JSON_MIME in (a["data"]["mime_type"], r["data"]["mime_type"]):
                out.append(ctx.finding("VISUAL_COMPARISON", "metadata JSON asset has no pixels to compare",
                                       severity="INFO", decision="NOT_APPLICABLE", source_refs=pair))
                continue
            if not drift:
                out.append(ctx.finding("VISUAL_TOLERANCE", f"pixel comparison within color_delta_max="
                                       f"{tol['color_delta_max']} and geometry_px_max={tol['geometry_px_max']} needs "
                                       "a vision checker or reviewer", severity="MAJOR", decision="UNKNOWN",
                                       source_refs=pair))
        return out

    def map_pair(self, ctx, a, r, tol, pair) -> list[dict]:
        ga, gr = ctx.record(a["data"]["source_graph_ref"]), ctx.record(r["data"]["source_graph_ref"])
        na = {n["id"]: n for n in ga["data"]["nodes"]}
        nr = {n["id"]: n for n in gr["data"]["nodes"]}
        out = []
        t = tol["geometry_px_max"] if ga["data"]["unit"] == "px" else ga["data"]["geometry_tolerance"]
        for nid in sorted(set(na) | set(nr)):
            x, y = na.get(nid), nr.get(nid)
            if x is None or y is None:
                out.append(ctx.finding("MAP_NODES", f"node {nid} missing from {'asset' if x is None else 'reference'}",
                                       severity="BLOCKING", source_refs=pair))
                continue
            if d_maps.nfc(x["label"]) != d_maps.nfc(y["label"]):
                out.append(ctx.finding("LABEL_EXACT", f"node {nid} label '{x['label']}' vs reference '{y['label']}'",
                                       severity="BLOCKING", source_refs=pair))
            dx, dy = abs(x["x"] - y["x"]), abs(x["y"] - y["y"])
            ok = dx <= t and dy <= t
            out.append(ctx.finding("GEOMETRY", f"node {nid} offset ({dx}, {dy}) vs tolerance {t}",
                                   severity="INFO" if ok else "BLOCKING", decision="PASS" if ok else "FAIL",
                                   source_refs=pair))
        return out

    # Reviewer dispositions arrive as UPDATE; the check bytes are regenerated to retain them.
    def rebind(self, ctx, data):
        base = ctx.base
        doc = _binary_json(ctx, base)
        if doc is None:
            raise AkoweError("INVALID_INPUT", "/base_ref", "base check bytes do not verify", status="REJECTED")
        doc["findings"] = data["findings"]
        doc["reviewed_by"] = ctx.principal_id
        bref = self.stage_json_asset(ctx, doc, list(base["source_refs"]))
        data.update(storage_uri=da.asset_uri(bref), file_hash=bref["content_hash"], mime_type=JSON_MIME)
        return []

    def check_bytes(self, ctx, record, blob):
        try:
            doc = json.loads(blob.decode("utf-8"))
        except ValueError:
            doc = {}
        if doc.get("findings") != record["data"]["findings"]:
            return [ctx.finding("CHECK_BYTES", "check bytes do not retain the reported findings", severity="BLOCKING")]
        return []

    def validate(self, ctx, record):
        # Findings in a check report describe the checked assets, not this report's validity.
        if record["record_kind"] != "OUTPUT":
            return []
        data = record["data"]
        _, blob, out = da.check_binding(ctx, data, "D10")
        if blob is not None:
            out.extend(self.check_bytes(ctx, record, blob))
        return out


# ====================================================================== D12 maps
@register("D12")
class MapArtwork(DHandler):
    computed = True

    def build(self, ctx):
        p = ctx.payload
        src = ctx.field_record("geometry_source_ref")
        labels_recs = ctx.field_records("canonical_label_refs")
        for i, rec in enumerate(labels_recs):
            if rec["lifecycle"] not in APPROVED:
                raise AkoweError("APPROVAL_REQUIRED", f"/payload/canonical_label_refs/{i}",
                                     "canonical labels must come from approved canon",
                                     unresolved=[f"{rec['module_id']}:accept"])
        extra = []
        if src["module_id"] == "A04":
            if src["lifecycle"] not in APPROVED:
                raise AkoweError("APPROVAL_REQUIRED", "/payload/geometry_source_ref",
                                     "initial geometry is extracted from approved A04 coordinates only",
                                     unresolved=["A04:accept"])
            graph, problems = d_maps.extract_graph(src, labels_recs, p.get("projection"))
            if problems:
                raise AkoweError("INVALID_INPUT", "/payload/geometry_source_ref",
                                     "cannot extract map geometry: " + "; ".join(problems), status="REJECTED")
            graph_ref = ctx.stage_json("D12", graph, record_kind="MapGraph",
                                       source_refs=[src["ref"]] + [r["ref"] for r in labels_recs])
            canonical = d_maps.canonical_labels(labels_recs + [src])[0]
        else:
            graph_rec = self.graph_of(ctx, src)
            graph, graph_ref = graph_rec["data"], graph_rec["ref"]
            extra.append(graph_ref)
            gp = d_maps.graph_problems(graph)
            if gp:
                raise AkoweError("INVALID_INPUT", "/payload/geometry_source_ref", "; ".join(gp),
                                     status="REJECTED")
            canonical = d_maps.canonical_labels(labels_recs + self.graph_label_sources(ctx, graph_rec))[0]
        svg = d_maps.render_svg(graph, title=p["map_requirements"], legend=p.get("legend"), scale=p.get("scale"))
        bref = ctx.stage_binary("D12", svg, SVG_MIME, source_refs=[graph_ref])
        sidecar = d_maps.build_sidecar(graph_ref, svg)
        side_ref = ctx.stage_json("D12", sidecar, record_kind="MapSidecar", source_refs=[graph_ref])
        findings = self.findings(ctx, d_maps.compare(graph, sidecar, svg, canonical, graph_ref=graph_ref,
                                                     file_hash=bref["content_hash"]))
        data = self.descriptor(ctx, bref, SVG_MIME, _internal_rights("D12"), findings,
                               source_graph_ref=graph_ref, sidecar_ref=side_ref)
        return Result(data=data, source_refs=extra)

    @staticmethod
    def graph_of(ctx, rec):
        if rec["record_kind"] == "MapGraph":
            return rec
        if rec["record_kind"] == "OUTPUT":
            g = ctx.record(rec["data"]["source_graph_ref"])
            if g is not None and g["record_kind"] == "MapGraph":
                return g
        raise AkoweError("INVALID_INPUT", "/payload/geometry_source_ref",
                             "a D12 geometry source must be a MapGraph record or a D12 map", status="REJECTED")

    @staticmethod
    def graph_label_sources(ctx, graph_rec) -> list[dict]:
        return [s for s in (ctx.store.get_record(ctx.project_id, ctx.branch_id, r["record_id"], r["version"])
                            for r in graph_rec["source_refs"] if r["module_id"] in ("A04", "A15")) if s]

    @staticmethod
    def findings(ctx, results) -> list[dict]:
        out = []
        for rule, ok, msg in results:
            if ok and rule in ("LABEL_EXACT", "GEOMETRY", "CANONICAL_LABEL"):
                continue  # summarized below; failures are listed individually
            out.append(ctx.finding(rule, msg, severity="INFO" if ok else "BLOCKING", decision="PASS" if ok else "FAIL"))
        passed = sum(1 for rule, ok, _ in results if ok and rule in ("LABEL_EXACT", "GEOMETRY", "CANONICAL_LABEL"))
        out.append(ctx.finding("LABELS_GEOMETRY", f"{passed} exact label/geometry/canonical checks passed",
                               severity="INFO", decision="PASS"))
        return out

    def rebind(self, ctx, data):
        super().rebind(ctx, data)
        g, s = ctx.field_record("source_graph_ref"), ctx.field_record("sidecar_ref")
        if g["record_kind"] != "MapGraph" or s["record_kind"] != "MapSidecar":
            raise AkoweError("INVALID_INPUT", "/payload/source_graph_ref",
                                 "source_graph_ref/sidecar_ref must be D12 MapGraph/MapSidecar records",
                                 status="REJECTED")
        if s["data"]["graph_ref"] != g["ref"] or s["data"]["file_hash"] != data["file_hash"]:
            raise AkoweError("INVALID_INPUT", "/payload/sidecar_ref",
                                 "sidecar must pin source_graph_ref and the map file hash", status="REJECTED")
        return []

    def validate(self, ctx, record):
        out = super().validate(ctx, record)
        if record["record_kind"] != "OUTPUT":
            return out
        out.extend(self.input_findings(ctx, record))
        data = record["data"]
        g, s = ctx.record(data["source_graph_ref"]), ctx.record(data["sidecar_ref"])
        if g is None or s is None or g["record_kind"] != "MapGraph" or s["record_kind"] != "MapSidecar":
            out.append(ctx.finding("MAP_RECORDS", "D12 approval requires a MapGraph source_graph_ref and a MapSidecar "
                                   "sidecar_ref", severity="BLOCKING"))
            return out
        _, blob, _ = da.check_binding(ctx, data, "D12")
        svg = blob if blob is not None and data["mime_type"] == SVG_MIME else None
        label_srcs = [ctx.store.get_record(ctx.project_id, ctx.branch_id, r["record_id"], r["version"])
                      for r in record["source_refs"] + g["source_refs"] if r["module_id"] in ("A04", "A15")]
        canonical, _, conflicts = d_maps.canonical_labels([x for x in label_srcs if x])
        for c in conflicts:
            out.append(ctx.finding("CANONICAL_LABEL", f"contradictory canonical labels {c}", severity="BLOCKING",
                                   decision="UNKNOWN"))
        for rule, ok, msg in d_maps.compare(g["data"], s["data"], svg, canonical, graph_ref=g["ref"],
                                            file_hash=data["file_hash"]):
            if not ok:
                out.append(ctx.finding(rule, msg, severity="BLOCKING", source_refs=[g["ref"], s["ref"]]))
        return out
