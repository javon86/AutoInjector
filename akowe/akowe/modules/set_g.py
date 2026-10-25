"""Set G handlers: Book Assembly (G01-G14).

Every G operation publishes the BF-CLOSURE-1.1 descriptor shape
    {artifact_ref, artifact_type, revision, sha256, validation_report_ref}
where artifact_ref pins a distinct G-owned BINARY_ARTIFACT staged in the same commit
(G01-G10/G14: canonical UTF-8 JSON validated against the shared GxxArtifact schema;
G11/G12/G13: actual PDF/EPUB/DOCX bytes), sha256 == artifact_ref.content_hash,
revision == binary version, and validation_report_ref pins an I04 validation record
({valid, violations, schema_version}, source_refs=[artifact_ref]) produced after the
binary was allocated and before the descriptor can be accepted.

Assembly order (Set G rules): seed I01 profiles -> G02 ordered manifest of approved
chapter pins -> G01 compile -> G05 typography -> (G06/G08/G09/G03 optional, recompiled
into G01 via envelope input_refs) -> G04 pagination -> G07 TOC convergence loop ->
G11/G12/G13 exports for selected release profiles. G10/G14 are print-only.

Conventions decided here (see module report):
* chapter IDs are the stable record IDs of the approved C prose records;
* chapter title = first line "# Title" of the approved prose (book.py conventions);
* optional matter/placements/title rules enter G01 through envelope input_refs
  (G01 CREATE has no payload field for them) and are recorded in matter_refs/asset_refs;
* G04 margins_pt (and, for the converged pass, the rendered TOC entries/style) are not
  representable in G04Artifact, so they are kept as module state keyed by the binary record
  ID and every consumer re-paginates and must reproduce the stored page map exactly;
* G07 publishes its converged pass as a G04 pagination artifact (+I04, +descriptor) and
  points pagination_ref at it, so TOC pages == pagination pages == exported pages;
* G03 placements use registered G-owned extension predicates (PLACEMENT_PREDICATES).
"""
from __future__ import annotations

import json
import math
import unicodedata
from dataclasses import dataclass, field

from .. import CONTRACT_VERSION
from ..canonical import canonical_bytes, sha256_bytes
from ..errors import AkoweError, error
from ..exporters import book as bookmod
from ..exporters.docx import build_docx, inspect_docx
from ..exporters.epub import build_epub, inspect_epub
from ..exporters.images import ImageInfo, UnsupportedImage, load_image, sniff_mime
from ..exporters.layout import (Geometry, LayoutError, Typography, make_geometry, mm_to_pt, paginate,
                                resolve_family, unencodable)
from ..exporters.pdf import inspect_pdf, render_cover_pdf, render_pdf
from . import register
from .base import Context, OperationHandler, Result

ARTIFACT_TYPES = {
    "G01": "compiled_manuscript_ref", "G02": "ordered_manuscript_ref", "G03": "illustrated_manuscript_ref",
    "G04": "laid_out_pages_ref", "G05": "typography_ref", "G06": "chapter_title_pages_ref", "G07": "toc_ref",
    "G08": "front_matter_ref", "G09": "back_matter_ref", "G10": "cover_layout_ref", "G11": "pdf_export_ref",
    "G12": "epub_export_ref", "G13": "docx_export_ref", "G14": "print_spec_ref",
}
JSON_OPS = {"G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09", "G10", "G14"}
EXPORT_MIME = {"G11": "application/pdf", "G12": "application/epub+zip",
               "G13": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
APPROVED = ("APPROVED", "LOCKED")
DEFAULT_MAX_PASSES = 6


def valid_item_id(iid) -> bool:
    """Front/back-matter item IDs become EPUB ids, DOCX bookmarks and PDF destination names: letters (any
    script), combining marks, decimal digits, '_' and '-' only (all valid XML name characters)."""
    return isinstance(iid, str) and bool(iid) and all(
        ch in "_-" or unicodedata.category(ch) in ("Lu", "Ll", "Lt", "Lm", "Lo", "Mn", "Mc", "Nd") for ch in iid)


# Registered G-owned extension predicates for G03 placement SemanticRecords
# (predicate_registry: x.<namespace>.<name> needs type/unit/meaning/owner before automatic use).
PLACEMENT_PREDICATES = {
    "x.g03.anchor_id": {"type": "string", "unit": None, "meaning": "stable manuscript anchor (heading or paragraph ID)",
                        "owner": "G03"},
    "x.g03.width_mm": {"type": "number", "unit": "mm", "meaning": "placement box width", "owner": "G03"},
    "x.g03.height_mm": {"type": "number", "unit": "mm", "meaning": "placement box height", "owner": "G03"},
    "x.g03.fit": {"type": "enum", "values": ["CONTAIN", "COVER"], "unit": None,
                  "meaning": "scale image inside (CONTAIN) or filling and clipped to (COVER) the box", "owner": "G03"},
}

# Release profiles that make an operation applicable (Set G: selected formats only; G10/G14 print).
PROFILE_RULES = {
    "G11": ("MANUSCRIPT_PDF", "PRINT_INTERIOR"),
    "G12": ("EPUB_REFLOWABLE",),
    "G13": ("EDITABLE_DOCX",),
    "G14": ("PRINT_INTERIOR", "PRINT_WRAP_COVER"),
}


def _rej(code: str, path: str, msg: str, status: str = "REJECTED") -> AkoweError:
    return AkoweError(code, path, msg, status=status)


def _blocked(code: str, path: str, msg: str, **kw) -> AkoweError:
    return AkoweError(code, path, msg, status="BLOCKED", **kw)


def _same_pin(a: dict, b: dict) -> bool:
    return (a["record_id"], a["version"], a["content_hash"]) == (b["record_id"], b["version"], b["content_hash"])


def _iso_seconds(ts: str) -> str:
    return ts[:19] + "Z"


# =========================================================================== shared helpers
def aux_data(rec: dict, kind: str, path: str) -> dict:
    aux = (rec.get("data") or {}).get("auxiliary_record") or {}
    if rec["module_id"] != "I01" or aux.get("record_kind") != kind:
        raise _rej("INVALID_INPUT", path, f"requires an imported {kind} profile")
    return aux["data"]


def resolve(ctx: Context, ref: dict, path: str) -> dict:
    return ctx.record(ref) if ref is not None else None


def fresh(rec: dict, path: str) -> dict:
    if rec.get("stale"):
        raise _blocked("VERSION_CONFLICT", path, f"input {rec['module_id']}:{rec['record_id']} v{rec['version']} is "
                       f"stale ({rec.get('stale_reason') or 'an upstream pin changed'}); rebuild it first")
    return rec


def require_approved(rec: dict, path: str, what: str) -> None:
    if rec["lifecycle"] not in APPROVED:
        raise _blocked("APPROVAL_REQUIRED", path, f"{what} {rec['module_id']}:{rec['record_id']} v{rec['version']} is "
                       f"{rec['lifecycle']}; only approved content can be assembled")


def validate_bytes(ctx: Context, op: str, raw: bytes, mime: str | None = None) -> tuple[list[dict], str, dict]:
    """Decode/parse staged bytes; returns (violations, schema_version, parser report)."""
    if op in JSON_OPS:
        try:
            obj = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            return [{"code": "INVALID_INPUT", "path": "", "message": f"artifact is not UTF-8 JSON: {exc}"}], \
                f"{op}Artifact@{CONTRACT_VERSION}", {}
        errs = ctx.contracts.check_shared(f"{op}Artifact", obj)
        return ([{"code": e["code"], "path": e["path"], "message": e["message"]} for e in errs],
                f"{op}Artifact@{CONTRACT_VERSION}", {"decoded": obj})
    if op == "G11":
        rep = inspect_pdf(raw)
        v = [{"code": "INVALID_INPUT", "path": "", "message": m} for m in rep["errors"]]
        if rep["page_count"] < 1:
            v.append({"code": "INVALID_INPUT", "path": "", "message": "PDF has no pages"})
        return v, "PDF-1.7 structure (akowe-pdf-inspect 1)", rep
    if op == "G12":
        rep = inspect_epub(raw)
        return ([{"code": "INVALID_INPUT", "path": "", "message": m} for m in rep["errors"]],
                "EPUB-3.3 OCF/OPF/XHTML structure (akowe-epub-inspect 1; EPUBCheck unavailable)", rep)
    if op == "G13":
        rep = inspect_docx(raw)
        return ([{"code": "INVALID_INPUT", "path": "", "message": m} for m in rep["errors"]],
                "OOXML WordprocessingML package (akowe-docx-inspect 1)", rep)
    raise ValueError(op)


def check_descriptor(ctx: Context, op: str, data: dict) -> list[str]:
    """Owner semantic checks of a descriptor: distinct binary, exact hash/revision, I04 report."""
    out = []
    aref = data.get("artifact_ref") or {}
    if aref.get("module_id") != op:
        return [f"artifact_ref must pin a {op} binary"]
    if data.get("artifact_type") not in (None, ARTIFACT_TYPES[op]):
        out.append("artifact_type mismatch")
    try:
        binrec = ctx.record(aref)
    except AkoweError as exc:
        return [f"artifact_ref unresolved: {exc.errors[0]['message']}"]
    if binrec["representation"] != "BINARY_ARTIFACT":
        return ["artifact_ref must point to a BINARY_ARTIFACT, never to a descriptor"]
    if data.get("sha256") != aref["content_hash"] or binrec["content_hash"] != aref["content_hash"]:
        out.append("sha256 must equal artifact_ref.content_hash and the stored byte hash")
    if data.get("revision") != aref["version"]:
        out.append("revision must equal the binary version")
    raw = ctx.binary(binrec)  # verifies exact bytes
    violations, _, _ = validate_bytes(ctx, op, raw)
    out.extend(f"artifact bytes: {v['path']} {v['message']}" for v in violations)
    try:
        rep = ctx.record(data.get("validation_report_ref"))
    except AkoweError as exc:
        return out + [f"validation_report_ref unresolved: {exc.errors[0]['message']}"]
    if rep["module_id"] != "I04" or rep["record_kind"] != "OUTPUT":
        out.append("validation_report_ref must be an I04 validation record")
    elif not any(_same_pin(r, aref) for r in rep["source_refs"]):
        out.append("I04 report does not validate this exact artifact")
    elif rep["data"].get("valid") is not True:
        out.append("I04 report for this artifact is not valid")
    return out


def load_artifact(ctx: Context, rec: dict, ops: tuple, path: str):
    """Resolve a G record (descriptor or binary) to (decoded artifact or bytes, binary record)."""
    if rec["module_id"] not in ops:
        raise _rej("INVALID_INPUT", path + "/module_id", f"expected one of {ops}, got {rec['module_id']}")
    fresh(rec, path)
    op = rec["module_id"]
    if rec["representation"] == "BINARY_ARTIFACT":
        binrec = rec
    else:
        problems = check_descriptor(ctx, op, rec["data"])
        if problems:
            raise _rej("INVALID_INPUT", path, f"{op} descriptor invalid: {problems[0]}")
        binrec = ctx.record(rec["data"]["artifact_ref"])
    raw = ctx.binary(binrec)
    if op not in JSON_OPS:
        return raw, binrec
    violations, _, rep = validate_bytes(ctx, op, raw)
    if violations:
        raise _rej("INVALID_INPUT", path, f"{op} artifact bytes fail {op}Artifact: {violations[0]['message']}")
    return rep["decoded"], binrec


def asset_bytes(ctx: Context, rec: dict, path: str) -> tuple[bytes, str | None]:
    """Bytes of a D (or other) asset: the record itself when binary, else the stored binary whose
    exact hash equals the descriptor's file_hash (same owner); verified by the store."""
    if rec["representation"] == "BINARY_ARTIFACT":
        return ctx.binary(rec), rec["binary"]["mime_type"]
    data = rec.get("data") or {}
    fh = data.get("file_hash")
    if not fh:
        raise _rej("INVALID_INPUT", path, f"{rec['module_id']} record has no file_hash/binary to place")
    rows = ctx.store.query("SELECT record_id, version FROM records WHERE project_id=? AND branch_id=? AND "
                           "representation='BINARY_ARTIFACT' AND owner=? AND content_hash=? ORDER BY record_id, version",
                           (ctx.project_id, ctx.branch_id, rec["owner"], fh))
    candidates = [ctx.store.get_record(ctx.project_id, ctx.branch_id, r["record_id"], r["version"]) for r in rows]
    preferred = [c for c in candidates if c["binary"]["storage_uri"] == data.get("storage_uri")]
    pick = (preferred or candidates or [None])[0]
    if pick is None:
        raise _blocked("MISSING_INPUT", path, f"no stored {rec['owner']}-owned bytes match file_hash {fh[:12]}...")
    return ctx.binary(pick), data.get("mime_type") or pick["binary"]["mime_type"]


def image_of(raw: bytes, mime: str | None, path: str) -> ImageInfo:
    try:
        return load_image(raw, mime)
    except UnsupportedImage as exc:
        raise _rej("INVALID_INPUT", path, f"asset cannot be placed: {exc}") from exc


@dataclass
class Assembly:
    book: dict
    g01_rec: dict
    g01: dict
    manifest_rec: dict
    chapter_recs: list
    matter: dict = field(default_factory=dict)      # module -> (record, artifact)
    images: dict = field(default_factory=dict)      # key -> (bytes, ImageInfo)
    asset_recs: list = field(default_factory=list)
    excluded_art: bool = False

    def pins(self) -> list[dict]:
        refs = [self.manifest_rec["ref"], self.g01_rec["ref"]] + [r["ref"] for r in self.chapter_recs]
        refs += [rec["ref"] for rec, _ in self.matter.values()] + [r["ref"] for r in self.asset_recs]
        return refs

    def image_dims(self) -> dict:
        return {k: (info.width, info.height) for k, (_, info) in self.images.items()}

    def pdf_images(self) -> dict:
        return {k: info for k, (_, info) in self.images.items()}


def chapters_of(ctx: Context, g01: dict, path: str) -> list[dict]:
    recs = []
    for i, sec in enumerate(g01["sections"]):
        rec = fresh(resolve(ctx, sec["chapter_ref"], f"{path}/sections/{i}/chapter_ref"), path)
        require_approved(rec, path, "chapter")
        if "text" not in (rec.get("data") or {}):
            raise _rej("INVALID_INPUT", path, f"{rec['module_id']} record has no prose text")
        recs.append(rec)
    return recs


def assemble(ctx: Context, g01_rec: dict, path: str, *, meta: dict | None = None, toc: bool = False,
             art: bool = True) -> Assembly:
    g01, _ = load_artifact(ctx, g01_rec, ("G01",), path)
    manifest_rec = resolve(ctx, g01["source_manifest_ref"], path + "/source_manifest_ref")
    chapter_recs = chapters_of(ctx, g01, path)
    matter = {}
    for ref in g01["matter_refs"]:
        rec = resolve(ctx, ref, path + "/matter_refs")
        obj, _ = load_artifact(ctx, rec, ("G03", "G06", "G08", "G09"), path + "/matter_refs")
        matter[rec["module_id"]] = (rec, obj)
    asm = Assembly(book={}, g01_rec=g01_rec, g01=g01, manifest_rec=manifest_rec, chapter_recs=chapter_recs,
                   matter=matter)
    placements = []
    if "G03" in matter:
        if not art:
            asm.excluded_art = True
        else:
            for p in matter["G03"][1]["placements"]:
                arec = fresh(resolve(ctx, p["asset_ref"], path + "/asset_refs"), path)
                require_approved(arec, path + "/asset_refs", "asset")
                raw, mime = asset_bytes(ctx, arec, path + "/asset_refs")
                info = image_of(raw, mime, path + "/asset_refs")
                key = sha256_bytes(raw)
                asm.images[key] = (raw, info)
                asm.asset_recs.append(arec)
                placements.append(dict(p, key=key))
    chapters = [{"id": s["section_id"], "text": r["data"]["text"]} for s, r in zip(g01["sections"], chapter_recs)]
    try:
        asm.book = bookmod.build_book(
            meta or {}, chapters, title_rules=matter["G06"][1] if "G06" in matter else None,
            front=matter["G08"][1]["items"] if "G08" in matter else None,
            back=matter["G09"][1]["items"] if "G09" in matter else None,
            placements=placements, toc=toc)
    except KeyError as exc:
        raise _rej("INVALID_INPUT", path, f"placement anchor {exc} no longer exists in the manuscript") from exc
    return asm


def typography_from(fp: dict, path: str) -> Typography:
    fam = resolve_family(fp["fallback_names"])
    if fam is None:
        raise _blocked("CAPABILITY_UNAVAILABLE", path,
                       "no supported font: the PDF writer renders only base-14 Times/Helvetica/Courier and cannot "
                       "embed the pinned font files; list one of them in fallback_names or supply an embedding-capable "
                       "renderer", unresolved=["G05:font_renderer"])
    return Typography(fam, float(fp["font_size_pt"]), float(fp["line_height_pt"]))


@dataclass
class Paginated:
    asm: Assembly
    geom: Geometry
    typo: Typography
    page: dict
    page_rec: dict
    typo_rec: dict | None
    params: dict
    layout: object
    g04: dict | None = None
    g04_rec: dict | None = None
    toc_entries: list | None = None   # TOC rendered inside this pagination (converged G07 pass)
    toc_style: dict | None = None
    g07: dict | None = None
    g07_rec: dict | None = None


def g04_context(ctx: Context, g04_rec: dict, path: str, *, meta: dict | None = None, toc: bool = False) -> Paginated:
    """Rebuild a G04 pagination from its pinned inputs and stored layout parameters and require
    the exact page map/page count of the artifact (binds the parameters to the bytes)."""
    g04, binrec = load_artifact(ctx, g04_rec, ("G04",), path)
    params = ctx.get_state("G04.layout", binrec["record_id"])
    if not params:
        raise _blocked("MISSING_INPUT", path, "layout parameters for this G04 artifact are unavailable")
    g01_rec = resolve(ctx, g04["source_ref"], path + "/source_ref")
    page_rec = resolve(ctx, g04["profile_ref"], path + "/profile_ref")
    typo_rec = resolve(ctx, g04["typography_ref"], path + "/typography_ref")
    page = aux_data(page_rec, "PAGE_PROFILE", path + "/profile_ref")
    g05, _ = load_artifact(ctx, typo_rec, ("G05",), path + "/typography_ref")
    typo = typography_from(g05, path + "/typography_ref")
    toc_state = params.get("toc")
    asm = assemble(ctx, g01_rec, path + "/source_ref", meta=meta, toc=toc or bool(toc_state))
    geom = make_geometry(page, params["margins_pt"])
    entries = toc_state["entries"] if toc_state else None
    style = toc_state["style"] if toc_state else None
    try:
        layout = paginate(asm.book, geom, typo, toc_entries=entries, toc_style=style, images=asm.image_dims())
    except LayoutError as exc:
        raise _rej("INVALID_INPUT", path, str(exc)) from exc
    if layout.page_count != g04["page_count"] or layout.heading_pages != g04["heading_pages"]:
        raise _rej("INVALID_INPUT", path, "G04 pagination is not reproducible from its pinned inputs")
    return Paginated(asm, geom, typo, page, page_rec, typo_rec, params, layout, g04, g04_rec, entries, style)


def toc_entries(book: dict, page_map: dict, style: dict) -> list[dict]:
    out = []
    for e in bookmod.heading_entries(book, style["max_depth"]):
        out.append({"heading_id": e["heading_id"], "title": e["title"], "level": e["level"],
                    "page": page_map.get(e["heading_id"]) if style["include_pages"] else None})
    return out


def g07_context(ctx: Context, g07_rec: dict, path: str, *, meta: dict | None = None) -> Paginated:
    """Converged TOC -> its final pagination (a G04 artifact whose pages include the TOC)."""
    g07, _ = load_artifact(ctx, g07_rec, ("G07",), path)
    if not g07["converged"]:
        raise _rej("TOC_NONCONVERGENCE", path, "the TOC artifact did not converge; unstable page numbers are never used")
    pag_rec = resolve(ctx, g07["pagination_ref"], path + "/pagination_ref")
    pg = g04_context(ctx, pag_rec, path + "/pagination_ref", meta=meta)
    if pg.toc_entries is None:
        raise _rej("INVALID_INPUT", path + "/pagination_ref", "pagination_ref must be the converged pagination that "
                   "contains this TOC")
    rendered = [(e["heading_id"], e["title"], e["page"]) for e in pg.toc_entries]
    if rendered != [(e["heading_id"], e["title"], e["page"]) for e in g07["entries"]]:
        raise _rej("INVALID_INPUT", path, "TOC entries differ from the TOC rendered in its pagination")
    pages = dict(pg.layout.page_map())
    for e in g07["entries"]:
        if e["page"] is not None and pages.get(e["heading_id"]) != e["page"]:
            raise _rej("TOC_NONCONVERGENCE", path, f"heading {e['heading_id']} is on page {pages.get(e['heading_id'])}"
                       f", TOC says {e['page']}")
    pg.g07, pg.g07_rec = g07, g07_rec
    return pg


def release_profiles(ctx: Context) -> list[str]:
    m = ctx.manifest
    if m is None:
        raise _blocked("MISSING_INPUT", "/feature_manifest", "project has no pinned feature manifest")
    return list(m.get("release_profiles") or [])


# =========================================================================== base handler
class GHandler(OperationHandler):
    """Common descriptor publishing, UPDATE/VALIDATE semantics for Set G."""

    hybrid = False

    def build(self, ctx: Context) -> dict:  # pragma: no cover - abstract
        raise NotImplementedError

    def create(self, ctx: Context) -> Result:
        if ctx.manual_candidate is not None:
            if not self.hybrid:
                raise _rej("INVALID_INPUT", "/manual_candidate", f"{ctx.op_id} is LOGIC: its output is computed "
                           "deterministically; manual candidates are not accepted")
            problems = check_descriptor(ctx, ctx.op_id, ctx.manual_candidate)
            if problems:
                raise _rej("INVALID_INPUT", "/manual_candidate", problems[0])
            return Result(data=ctx.manual_candidate, transform="MANUAL")
        return self.build(ctx)

    def publish(self, ctx: Context, raw: bytes, *, source_refs: list, findings: list | None = None,
                mime: str = "application/json", transform: str = "LOGIC", resource: dict | None = None,
                extra_subjects: list | None = None, extra_violations: list | None = None,
                on_binary=None) -> Result:
        op = ctx.op_id
        bin_ref = ctx.stage_binary(op, raw, mime, source_refs=source_refs)
        violations, schema_version, _ = validate_bytes(ctx, op, raw)
        violations = violations + list(extra_violations or [])
        report = {"valid": not violations, "violations": violations, "schema_version": schema_version}
        rep_ref = ctx.stage_json("I04", report, source_refs=[bin_ref] + list(extra_subjects or []))
        findings = list(findings or [])
        if violations:
            findings.append(ctx.finding("ARTIFACT_VALIDATION", f"{len(violations)} violation(s): "
                                        f"{violations[0]['message']}", severity="BLOCKING", decision="FAIL",
                                        source_refs=[bin_ref, rep_ref]))
        else:
            findings.append(ctx.finding("ARTIFACT_VALIDATION", f"staged bytes validated ({schema_version})",
                                        severity="INFO", decision="PASS", source_refs=[bin_ref, rep_ref]))
        if on_binary:
            on_binary(bin_ref)
        data = {"artifact_ref": bin_ref, "artifact_type": ARTIFACT_TYPES[op], "revision": bin_ref["version"],
                "sha256": bin_ref["content_hash"], "validation_report_ref": rep_ref}
        return Result(data=data, findings=findings, source_refs=list(source_refs), transform=transform,
                      resource=resource)

    def publish_json(self, ctx: Context, artifact: dict, **kw) -> Result:
        return self.publish(ctx, canonical_bytes(artifact), **kw)

    def update(self, ctx: Context) -> Result:
        problems = check_descriptor(ctx, ctx.op_id, ctx.payload)
        if problems:
            raise _rej("INVALID_INPUT", "/payload", problems[0])
        return Result(data=dict(ctx.payload), transform="MANUAL")

    def validate(self, ctx: Context, record: dict) -> list[dict]:
        if record["record_kind"] != "OUTPUT":
            return []
        out = [ctx.finding("DESCRIPTOR", p, severity="BLOCKING") for p in check_descriptor(ctx, ctx.op_id, record["data"])]
        if not out:
            out.extend(self.semantic(ctx, record))
        return out

    def semantic(self, ctx: Context, record: dict) -> list[dict]:
        return []

    def artifact(self, ctx: Context, record: dict):
        binrec = ctx.record(record["data"]["artifact_ref"])
        raw = ctx.binary(binrec)
        return (json.loads(raw) if ctx.op_id in JSON_OPS else raw), binrec


# =========================================================================== G02
@register("G02")
class ChapterOrdering(GHandler):
    """G02 - ordered content manifest from approved chapter pins and a unique ordered ID list.

    Chapter IDs are the stable record IDs of the approved C prose records. Duplicate IDs or
    pins, a selected ID without a pin, or a pin that is not selected fail INVALID_INPUT; an
    unapproved or stale chapter blocks; manifest_revision must equal the pinned feature
    manifest revision (VERSION_CONFLICT otherwise)."""

    def build(self, ctx: Context) -> Result:
        p = ctx.payload
        recs = ctx.field_records("approved_chapter_refs")
        ids = p["ordered_chapter_ids"]
        seen = set()
        for i, cid in enumerate(ids):
            if cid in seen:
                raise _rej("INVALID_INPUT", f"/payload/ordered_chapter_ids/{i}", f"duplicate chapter ID {cid}")
            seen.add(cid)
        by_id = {}
        for i, rec in enumerate(recs):
            path = f"/payload/approved_chapter_refs/{i}"
            if rec["record_id"] in by_id:
                raise _rej("INVALID_INPUT", path, f"duplicate chapter pin {rec['record_id']}")
            fresh(rec, path)
            require_approved(rec, path, "chapter")
            by_id[rec["record_id"]] = rec
        for i, cid in enumerate(ids):
            if cid not in by_id:
                raise _rej("INVALID_INPUT", f"/payload/ordered_chapter_ids/{i}",
                           f"selected chapter ID {cid} has no approved chapter pin")
        for i, rec in enumerate(recs):
            if rec["record_id"] not in seen:
                raise _rej("INVALID_INPUT", f"/payload/approved_chapter_refs/{i}",
                           f"approved chapter {rec['record_id']} is missing from ordered_chapter_ids")
        rev = ctx.manifest["revision"] if ctx.manifest else None
        if p["manifest_revision"] != rev:
            raise _rej("VERSION_CONFLICT", "/payload/manifest_revision",
                       f"manifest_revision {p['manifest_revision']} does not match pinned feature manifest revision {rev}")
        artifact = {"ordered_chapter_ids": list(ids), "chapter_refs": [by_id[c]["ref"] for c in ids],
                    "manifest_revision": p["manifest_revision"]}
        return self.publish_json(ctx, artifact, source_refs=[by_id[c]["ref"] for c in ids])

    def semantic(self, ctx, record):
        art, _ = self.artifact(ctx, record)
        out = []
        for ref in art["chapter_refs"]:
            rec = ctx.record(ref)
            if rec["lifecycle"] not in APPROVED:
                out.append(ctx.finding("CHAPTER_APPROVAL", f"chapter {ref['record_id']} is {rec['lifecycle']}",
                                       severity="BLOCKING", source_refs=[ref]))
        return out


# =========================================================================== G01
@register("G01")
class ManuscriptCompiler(GHandler):
    """G01 - compile the G02 manifest (never a previously compiled book) into ordered sections.

    approved_chapter_refs must be exactly the manifest's pins. Optional G06 title rules, G08
    front matter, G09 back matter and G03 placements are supplied as envelope input_refs
    (descriptors); they are validated, recorded in matter_refs (D assets in asset_refs) and
    included before pagination."""

    def build(self, ctx: Context) -> Result:
        man_rec = ctx.field_record("ordered_manifest_ref")
        manifest, _ = load_artifact(ctx, man_rec, ("G02",), "/payload/ordered_manifest_ref")
        recs = ctx.field_records("approved_chapter_refs")
        given = sorted((r["record_id"], r["version"], r["content_hash"]) for r in recs)
        wanted = sorted((r["record_id"], r["version"], r["content_hash"]) for r in manifest["chapter_refs"])
        if given != wanted:
            raise _rej("INVALID_INPUT", "/payload/approved_chapter_refs",
                       "approved_chapter_refs must be exactly the chapter pins of the ordered manifest")
        for i, rec in enumerate(recs):
            fresh(rec, f"/payload/approved_chapter_refs/{i}")
            require_approved(rec, f"/payload/approved_chapter_refs/{i}", "chapter")
        matter = {}
        for ptr, rec in sorted(ctx.resolved.items()):
            if not ptr.startswith("/input_refs/") or rec["module_id"] not in ("G03", "G06", "G08", "G09"):
                continue
            if rec["module_id"] in matter:
                raise _rej("INVALID_INPUT", ptr, f"only one {rec['module_id']} input may be compiled")
            obj, _ = load_artifact(ctx, rec, (rec["module_id"],), ptr)
            matter[rec["module_id"]] = (ptr, rec, obj)
        asset_refs = []
        if "G03" in matter:
            ptr, rec, g03 = matter["G03"]
            src = resolve(ctx, g03["source_ref"], ptr + "/source_ref")
            src_art, _ = load_artifact(ctx, src, ("G01",), ptr + "/source_ref")
            if [(s["section_id"], s["chapter_ref"]["record_id"], s["chapter_ref"]["version"]) for s in src_art["sections"]] \
                    != [(c, r["record_id"], r["version"]) for c, r in zip(manifest["ordered_chapter_ids"],
                                                                         manifest["chapter_refs"])]:
                raise _rej("INVALID_INPUT", ptr, "G03 placements were anchored on a different manuscript")
            asset_refs = [p["asset_ref"] for p in g03["placements"]]
        sections = [{"section_id": cid, "chapter_ref": ref}
                    for cid, ref in zip(manifest["ordered_chapter_ids"], manifest["chapter_refs"])]
        artifact = {"sections": sections,
                    "matter_refs": [matter[m][1]["ref"] for m in ("G06", "G08", "G09", "G03") if m in matter],
                    "asset_refs": asset_refs, "source_manifest_ref": man_rec["ref"]}
        srcs = [man_rec["ref"]] + manifest["chapter_refs"] + artifact["matter_refs"] + asset_refs
        return self.publish_json(ctx, artifact, source_refs=srcs)

    def semantic(self, ctx, record):
        try:
            assemble(ctx, record, "/payload/candidate_ref")
        except AkoweError as exc:
            return [ctx.finding("COMPILE_INPUTS", exc.errors[0]["message"], severity="BLOCKING",
                                decision="UNKNOWN" if exc.status == "BLOCKED" else "FAIL")]
        return []


# =========================================================================== G03
@register("G03")
class IllustrationPlacement(GHandler):
    """G03 - place selected approved D assets at stable anchors with explicit size/fit.

    Each payload placement is a SemanticRecord whose facts (one subject_id = placement ID,
    assertion_type FACT) use the registered predicates x.g03.anchor_id/width_mm/height_mm/fit
    and whose single link pins the D asset. illustration_policy=NONE, or OPTIONAL with no
    placements, is NOT_APPLICABLE (absent art); REQUIRED without placements is MISSING_INPUT."""

    hybrid = True

    def applicability(self, ctx):
        p = ctx.payload
        rev = ctx.manifest["revision"] if ctx.manifest else None
        if p.get("illustration_policy") == "NONE":
            return "G03:ILLUSTRATION_POLICY_NONE", f"illustration_policy=NONE (feature manifest revision {rev})"
        if p.get("illustration_policy") == "OPTIONAL" and not p.get("placements"):
            return "G03:NO_SELECTED_ART", f"no art selected for placement (feature manifest revision {rev})"
        return None

    def build(self, ctx: Context) -> Result:
        p = ctx.payload
        g01_rec = ctx.field_record("ordered_manuscript_ref")
        placements_in = p.get("placements") or []
        if not placements_in:
            raise _rej("MISSING_INPUT", "/payload/placements", "illustration_policy=REQUIRED needs placements",
                       status="BLOCKED")
        asm = assemble(ctx, g01_rec, "/payload/ordered_manuscript_ref", art=False)
        anchors = bookmod.all_anchors(asm.book)
        out, ids, srcs, findings = [], set(), [g01_rec["ref"]], []
        for i, sr in enumerate(placements_in):
            path = f"/payload/placements/{i}"
            subjects = {f["subject_id"] for f in sr["facts"]}
            if len(subjects) != 1:
                raise _rej("INVALID_INPUT", path + "/facts", "placement facts must share one subject_id (placement ID)")
            pid = subjects.pop()
            if pid in ids:
                raise _rej("INVALID_INPUT", path, f"duplicate placement ID {pid}")
            ids.add(pid)
            vals = {}
            for j, f in enumerate(sr["facts"]):
                if f["predicate"] not in PLACEMENT_PREDICATES:
                    raise _rej("INVALID_INPUT", f"{path}/facts/{j}/predicate",
                               f"unregistered placement predicate {f['predicate']}; use {sorted(PLACEMENT_PREDICATES)}")
                if f["assertion_type"] != "FACT":
                    raise _rej("INVALID_INPUT", f"{path}/facts/{j}/assertion_type", "placements must be FACT assertions")
                vals[f["predicate"]] = (j, f["value"])
            for pred in PLACEMENT_PREDICATES:
                if pred not in vals:
                    raise _rej("MISSING_INPUT", path + "/facts", f"placement {pid} lacks {pred}")
            anchor = vals["x.g03.anchor_id"][1]
            w, h, fit = vals["x.g03.width_mm"][1], vals["x.g03.height_mm"][1], vals["x.g03.fit"][1]
            if not isinstance(anchor, str) or anchor not in anchors:
                raise _rej("INVALID_INPUT", f"{path}/facts/{vals['x.g03.anchor_id'][0]}/value",
                           f"anchor {anchor!r} is not a stable anchor of the manuscript")
            for pred, v in (("x.g03.width_mm", w), ("x.g03.height_mm", h)):
                if isinstance(v, bool) or not isinstance(v, (int, float)) or v <= 0:
                    raise _rej("INVALID_INPUT", f"{path}/facts/{vals[pred][0]}/value", f"{pred} must be a positive number")
            if fit not in ("CONTAIN", "COVER"):
                raise _rej("INVALID_INPUT", f"{path}/facts/{vals['x.g03.fit'][0]}/value", "fit must be CONTAIN or COVER")
            assets = [ref for ref in sr["links"] if ref["owner"] == "D"]
            if len(assets) != 1:
                raise _rej("INVALID_INPUT", path + "/links", "each placement links exactly one D asset")
            arec = fresh(ctx.record(assets[0]), path + "/links")
            require_approved(arec, path + "/links", "asset")
            raw, mime = asset_bytes(ctx, arec, path + "/links")
            image_of(raw, mime, path + "/links")
            out.append({"placement_id": pid, "anchor_id": anchor, "asset_ref": arec["ref"], "width_mm": w,
                        "height_mm": h, "fit": fit})
            srcs.append(arec["ref"])
        return self.publish_json(ctx, {"source_ref": g01_rec["ref"], "placements": out}, source_refs=srcs,
                                 findings=findings)


# =========================================================================== G05
@register("G05")
class TypographyHandler(GHandler):
    """G05 - typography: pins the FONT_PROFILE and language before pagination.

    The renderer sets text in an author-listed base-14 fallback (Times/Helvetica/Courier);
    those need no embedding, so the pinned font_refs files are NOT embedded - recorded as a
    MAJOR/UNKNOWN finding for review. Glyph coverage of the whole manuscript is checked
    against WinAnsi; uncovered characters block (never silently replaced)."""

    def build(self, ctx: Context) -> Result:
        fp_rec = ctx.field_record("font_profile_ref")
        fp = aux_data(fp_rec, "FONT_PROFILE", "/payload/font_profile_ref")
        g01_rec = ctx.field_record("manuscript_ref")
        asm = assemble(ctx, g01_rec, "/payload/manuscript_ref")
        typo = typography_from(fp, "/payload/font_profile_ref/fallback_names")
        bad = unencodable(bookmod.all_text(asm.book))
        if bad:
            raise _blocked("CAPABILITY_UNAVAILABLE", "/payload/manuscript_ref",
                           f"characters not covered by the base-14 WinAnsi fonts: {''.join(bad[:20])!r}",
                           unresolved=["G05:font_coverage"])
        findings = [ctx.finding(
            "FONT_EMBEDDING",
            f"text is set in base-14 {typo.regular}/{typo.bold} (author-listed fallback); base-14 fonts are not "
            f"embedded and the pinned font_refs files are not used (embedding_permitted={fp['embedding_permitted']})",
            severity="MAJOR", decision="UNKNOWN", source_refs=list(fp["font_refs"]))]
        lang = ctx.payload["language_tag"]
        if lang.split("-")[0].lower() != fp["language_tag"].split("-")[0].lower():
            findings.append(ctx.finding("LANGUAGE", f"language_tag {lang} differs from font profile language "
                                        f"{fp['language_tag']}", severity="MAJOR", decision="FAIL"))
        if fp["line_height_pt"] < fp["font_size_pt"]:
            findings.append(ctx.finding("LEADING", "line_height_pt is smaller than font_size_pt (lines overlap)",
                                        severity="MAJOR", decision="FAIL"))
        artifact = {k: fp[k] for k in ("font_refs", "embedding_permitted", "fallback_names", "font_size_pt",
                                       "line_height_pt")}
        artifact["language_tag"] = lang
        return self.publish_json(ctx, artifact, source_refs=[fp_rec["ref"], g01_rec["ref"]], findings=findings)


# =========================================================================== G06
@register("G06")
class ChapterTitlePages(GHandler):
    """G06 - chapter title rules ({number}/{title} pattern) checked against the typography."""

    def build(self, ctx: Context) -> Result:
        rules_rec = ctx.field_record("chapter_title_rules_ref")
        rules = aux_data(rules_rec, "TITLE_RULES", "/payload/chapter_title_rules_ref")
        errs = bookmod.check_title_rules(rules)
        if errs:
            raise _rej("INVALID_INPUT", "/payload/chapter_title_rules_ref", errs[0])
        typo_rec = ctx.field_record("typography_ref")
        g05, _ = load_artifact(ctx, typo_rec, ("G05",), "/payload/typography_ref")
        typography_from(g05, "/payload/typography_ref")
        bad = unencodable(rules["pattern"])
        if bad:
            raise _blocked("CAPABILITY_UNAVAILABLE", "/payload/chapter_title_rules_ref",
                           f"title pattern uses characters the fonts cannot render: {''.join(bad)!r}")
        return self.publish_json(ctx, {"pattern": rules["pattern"], "include_number": rules["include_number"]},
                                 source_refs=[rules_rec["ref"], typo_rec["ref"]])


# =========================================================================== G08 / G09
class _Matter(GHandler):
    hybrid = True
    items_field = ""
    logic_items: tuple = ()
    side = ""

    def logic_item(self, iid: str, md: dict) -> dict:
        raise NotImplementedError

    def build(self, ctx: Context) -> Result:
        p = ctx.payload
        book_rec = ctx.field_record("book_ref")
        load_artifact(ctx, book_rec, ("G01",), "/payload/book_ref")
        prof_rec = ctx.field_record("publication_profile_ref")
        prof = aux_data(prof_rec, "OUTPUT_PROFILE", "/payload/publication_profile_ref")
        md = prof["metadata"]
        wanted = p.get(self.items_field) or []
        for i, iid in enumerate(wanted):
            if wanted.index(iid) != i:
                raise _rej("INVALID_INPUT", f"/payload/{self.items_field}/{i}", f"duplicate item {iid}")
            if not valid_item_id(iid):
                raise _rej("INVALID_INPUT", f"/payload/{self.items_field}/{i}",
                           f"item ID {iid!r}: use only letters, digits, '_' and '-' (it becomes a link target inside "
                           "the PDF, EPUB and DOCX)")
        creative = [i for i in wanted if i not in self.logic_items]
        generated, resource, transform = {}, None, "LOGIC"
        if creative:
            schema = {"type": "object", "additionalProperties": False, "required": ["items"], "properties": {
                "items": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                                     "required": ["item_id", "title", "text"],
                                                     "properties": {"item_id": {"enum": creative},
                                                                    "title": {"type": "string", "minLength": 1},
                                                                    "text": {"type": "string", "minLength": 1}}}}}}
            try:
                out, resource = ctx.ai_generate(
                    task=(f"Write the {self.side} matter items {creative} for the book '{md['title']}' by "
                          f"{md['author']}. Return JSON {{items:[{{item_id,title,text}}]}} only."),
                    output_schema=schema, context={"metadata": md, "requested_items": creative})
            except AkoweError as exc:
                if exc.code == "CAPABILITY_UNAVAILABLE":
                    raise _blocked("CAPABILITY_UNAVAILABLE", f"/payload/{self.items_field}",
                                   f"items {creative} need authored text: configure an AI slot or supply a manual "
                                   f"{ctx.op_id} candidate", unresolved=[f"{ctx.op_id}:manual_candidate"]) from exc
                raise
            for it in out.get("items", []):
                if it.get("item_id") in creative and it.get("title") and it.get("text"):
                    generated[it["item_id"]] = {"item_id": it["item_id"], "title": it["title"], "text": it["text"]}
            missing = [c for c in creative if c not in generated]
            if missing:
                raise _blocked("UPSTREAM_UNAVAILABLE", f"/payload/{self.items_field}",
                               f"generation omitted items {missing}")
            transform = "AI"
        items = [self.logic_item(i, md) if i in self.logic_items else generated[i] for i in wanted]
        bad = unencodable("\n".join(i["title"] + "\n" + i["text"] for i in items))
        findings = []
        if bad:
            findings.append(ctx.finding("GLYPHS", f"characters outside WinAnsi: {''.join(bad[:20])!r} (PDF export will "
                                        "block)", severity="MAJOR", decision="UNKNOWN"))
        return self.publish_json(ctx, {"items": items, "source_ref": book_rec["ref"]},
                                 source_refs=[book_rec["ref"], prof_rec["ref"]], findings=findings,
                                 transform=transform, resource=resource)


@register("G08")
class FrontMatter(_Matter):
    """G08 - front matter. title_page, copyright and toc (TOC position) are derived from the
    OUTPUT_PROFILE metadata; any other item needs authored text (AI slot or manual)."""

    items_field = "front_matter_items"
    logic_items = ("title_page", "copyright", "toc")
    side = "front"

    def logic_item(self, iid, md):
        if iid == "title_page":
            return {"item_id": iid, "title": md["title"], "text": md["author"]}
        if iid == "copyright":
            return {"item_id": iid, "title": "Copyright", "text": f"{md['rights']}\n{md['identifier']}"}
        return {"item_id": iid, "title": "Contents", "text": "Contents"}


@register("G09")
class BackMatter(_Matter):
    """G09 - back matter. 'colophon' is derived from the metadata; other items need authored text."""

    items_field = "back_matter_items"
    logic_items = ("colophon",)
    side = "back"

    def logic_item(self, iid, md):
        return {"item_id": iid, "title": "Colophon",
                "text": f"{md['title']}\n{md['author']}\n{md['rights']}\n{md['identifier']}"}


# =========================================================================== G04
@register("G04")
class PageLayout(GHandler):
    """G04 - paginate the compiled manuscript (no TOC yet) into the PAGE_PROFILE trim with the
    G05 typography. Effective margins are max(margins_pt, safe margin); the usable area must
    be positive. Output: page_count and ordered heading (heading_id, page) map."""

    def build(self, ctx: Context) -> Result:
        g01_rec = ctx.field_record("manuscript_ref")
        page_rec = ctx.field_record("page_profile_ref")
        page = aux_data(page_rec, "PAGE_PROFILE", "/payload/page_profile_ref")
        typo_rec = ctx.field_record("typography_ref")
        g05, _ = load_artifact(ctx, typo_rec, ("G05",), "/payload/typography_ref")
        typo = typography_from(g05, "/payload/typography_ref")
        if page["width_mm"] - 2 * page["safe_margin_mm"] <= 0 or page["height_mm"] - 2 * page["safe_margin_mm"] <= 0:
            raise _rej("INVALID_INPUT", "/payload/page_profile_ref", "safe margins leave no usable page area")
        margins = ctx.payload["margins_pt"]
        geom = make_geometry(page, margins)
        asm = assemble(ctx, g01_rec, "/payload/manuscript_ref")
        bad = unencodable(bookmod.all_text(asm.book))
        if bad:
            raise _blocked("CAPABILITY_UNAVAILABLE", "/payload/manuscript_ref",
                           f"characters not covered by the fonts: {''.join(bad[:20])!r}")
        try:
            layout = paginate(asm.book, geom, typo, images=asm.image_dims())
        except LayoutError as exc:
            raise _rej("INVALID_INPUT", "/payload/margins_pt", str(exc)) from exc
        artifact = {"page_count": layout.page_count, "heading_pages": layout.heading_pages,
                    "source_ref": g01_rec["ref"], "profile_ref": page_rec["ref"], "typography_ref": typo_rec["ref"]}
        params = {"margins_pt": dict(margins), "effective_margins_pt": {
            "top": geom.top, "bottom": geom.bottom, "left": geom.left, "right": geom.right}}

        def keep(bin_ref):
            ctx.on_commit(lambda tx: tx.put_state(ctx.project_id, ctx.branch_id, "G04.layout",
                                                  bin_ref["record_id"], params))

        return self.publish_json(ctx, artifact, source_refs=_dedupe([g01_rec["ref"], page_rec["ref"], typo_rec["ref"]]
                                                                    + asm.pins()), on_binary=keep)

    def semantic(self, ctx, record):
        try:
            g04_context(ctx, record, "/payload/candidate_ref")
        except AkoweError as exc:
            return [ctx.finding("PAGINATION_REPRODUCIBLE", exc.errors[0]["message"], severity="BLOCKING",
                                decision="UNKNOWN" if exc.status == "BLOCKED" else "FAIL")]
        return []


# =========================================================================== G07
@register("G07")
class TableOfContents(GHandler):
    """G07 - TOC convergence: paginate -> regenerate TOC -> paginate until the ordered
    (heading_id, page) map and page count are unchanged for two consecutive passes. The G04
    pagination is pass 1. At max_passes without convergence: TOC_NONCONVERGENCE, the last
    candidate is retained as an unpublished G07 binary (converged=false) and no descriptor
    with unstable page numbers is published."""

    def build(self, ctx: Context) -> Result:
        g04_rec = ctx.field_record("paginated_book_ref")
        style_rec = ctx.field_record("toc_style_ref")
        style = aux_data(style_rec, "TOC_STYLE", "/payload/toc_style_ref")
        max_passes = ctx.payload.get("max_passes", DEFAULT_MAX_PASSES)
        pg = g04_context(ctx, g04_rec, "/payload/paginated_book_ref", toc=True)
        prev = ([(h["heading_id"], h["page"]) for h in pg.g04["heading_pages"]], pg.g04["page_count"])
        passes, converged, entries, layout = 1, False, [], None
        while passes < max_passes:
            entries = toc_entries(pg.asm.book, dict(prev[0]), style)
            layout = paginate(pg.asm.book, pg.geom, pg.typo, toc_entries=entries, toc_style=style,
                              images=pg.asm.image_dims())
            passes += 1
            cur = (layout.page_map(), layout.page_count)
            if cur == prev:
                converged = True
                break
            prev = cur
        srcs = [g04_rec["ref"], style_rec["ref"]]
        art_entries = [{"heading_id": e["heading_id"], "title": e["title"], "page": e["page"],
                        "anchor_id": e["heading_id"]} for e in entries]
        if not converged:
            artifact = {"entries": art_entries, "pagination_ref": g04_rec["ref"], "converged": False,
                        "passes": passes}
            retained = ctx.stage_binary("G07", canonical_bytes(artifact), "application/json", source_refs=srcs)
            f = ctx.finding("TOC_NONCONVERGENCE", f"page map still changing after {passes} passes; candidate retained "
                            "unpublished", severity="BLOCKING", decision="FAIL", source_refs=[retained])
            return Result(data=None, status="BLOCKED", findings=[f], errors=[error(
                "TOC_NONCONVERGENCE", "/payload/max_passes",
                f"TOC/pagination did not converge within max_passes={max_passes}")],
                unresolved=["G07:max_passes"])
        # The converged pass is published as a G04 pagination artifact (page map includes the TOC) so
        # pagination_ref, TOC entries and the exported pages all agree.
        final = {"page_count": layout.page_count, "heading_pages": layout.heading_pages,
                 "source_ref": pg.g04["source_ref"], "profile_ref": pg.g04["profile_ref"],
                 "typography_ref": pg.g04["typography_ref"]}
        fraw = canonical_bytes(final)
        fbin = ctx.stage_binary("G04", fraw, "application/json", source_refs=srcs)
        fviol, fver, _ = validate_bytes(ctx, "G04", fraw)
        frep = ctx.stage_json("I04", {"valid": not fviol, "violations": fviol, "schema_version": fver},
                              source_refs=[fbin])
        fdesc = ctx.stage_json("G04", {"artifact_ref": fbin, "artifact_type": ARTIFACT_TYPES["G04"],
                                       "revision": fbin["version"], "sha256": fbin["content_hash"],
                                       "validation_report_ref": frep}, source_refs=srcs)
        fparams = dict(pg.params, toc={"entries": entries, "style": dict(style)})
        ctx.on_commit(lambda tx: tx.put_state(ctx.project_id, ctx.branch_id, "G04.layout", fbin["record_id"], fparams))
        artifact = {"entries": art_entries, "pagination_ref": fdesc, "converged": True, "passes": passes}
        return self.publish_json(ctx, artifact, source_refs=srcs + [fdesc])

    def semantic(self, ctx, record):
        art, _ = self.artifact(ctx, record)
        if not art["converged"]:
            return [ctx.finding("TOC_NONCONVERGENCE", "TOC did not converge", severity="BLOCKING")]
        return []


# =========================================================================== G14
@register("G14")
class PrintSpec(GHandler):
    """G14 - preliminary print trim/profile (page_count is not a prerequisite). The binding must
    be the printer profile's supported binding; trim must be positive."""

    def applicability(self, ctx):
        return _profile_applicability(ctx)

    def build(self, ctx: Context) -> Result:
        p = ctx.payload
        paper_rec = ctx.field_record("paper_stock_ref")
        printer_rec = ctx.field_record("printer_profile_ref")
        aux_data(paper_rec, "PAPER_STOCK", "/payload/paper_stock_ref")
        printer = aux_data(printer_rec, "PRINTER_PROFILE", "/payload/printer_profile_ref")
        if p["binding"] != printer["binding"]:
            raise _rej("INVALID_INPUT", "/payload/binding", f"printer {printer['printer_id']} supports "
                       f"{printer['binding']} binding, not {p['binding']}")
        tol = printer["geometry_tolerance_mm"]
        if p["trim_width_mm"] <= tol or p["trim_height_mm"] <= tol:
            raise _rej("INVALID_INPUT", "/payload/trim_width_mm", "trim must exceed the printer geometry tolerance")
        artifact = {"trim_width_mm": p["trim_width_mm"], "trim_height_mm": p["trim_height_mm"],
                    "printer_profile_ref": printer_rec["ref"], "paper_stock_ref": paper_rec["ref"],
                    "binding": p["binding"]}
        return self.publish_json(ctx, artifact, source_refs=[paper_rec["ref"], printer_rec["ref"]])


def _profile_applicability(ctx: Context):
    allowed = PROFILE_RULES[ctx.op_id]
    selected = release_profiles(ctx)
    if not any(a in selected for a in allowed):
        return (f"RELEASE_PROFILE_SELECTED:{'|'.join(allowed)}",
                f"{ctx.op_id} applies only when release_profiles selects {' or '.join(allowed)} "
                f"(feature manifest revision {ctx.manifest['revision']} selects {selected})")
    return None


def spine_mm(page_count: int, binding: str, printer: dict, paper: dict) -> float:
    """Printer-profile formula: leaves = ceil(pages / pages_per_leaf); spine = leaves * caliper
    + spine_allowance. Saddle-stitched books have no flat spine (0) and need pages % 4 == 0."""
    if binding == "SADDLE":
        if page_count % 4:
            raise _rej("INVALID_INPUT", "/payload/page_count", "saddle stitching needs a page count divisible by 4")
        return 0.0
    leaves = math.ceil(page_count / printer["pages_per_leaf"])
    return round(leaves * paper["caliper_mm"] + printer["spine_allowance_mm"], 4)


# =========================================================================== G10
@register("G10")
class CoverLayout(GHandler):
    """G10 - final cover geometry. PRINT: wrap cover (back + spine + front, printer bleed) from
    the G14 print spec and the stabilised interior page_count; the spine uses the printer
    profile formula. EBOOK: front cover only, no spine/back panel (spine_mm=null). The cover
    file (PDF wrap or the exact approved image bytes) is staged as its own G10 binary and the
    JSON layout artifact points to it via layout_asset_ref. Cover art must be approved D11
    with cleared rights."""

    hybrid = True

    def applicability(self, ctx):
        mode = ctx.payload.get("cover_mode")
        need = "PRINT_WRAP_COVER" if mode == "PRINT" else "EPUB_REFLOWABLE"
        selected = release_profiles(ctx)
        if need not in selected:
            return (f"RELEASE_PROFILE_SELECTED:{need}",
                    f"G10 {mode} cover applies only when release_profiles selects {need} "
                    f"(feature manifest revision {ctx.manifest['revision']} selects {selected})")
        return None

    def build(self, ctx: Context) -> Result:
        p = ctx.payload
        cover_rec = fresh(ctx.field_record("cover_asset_ref"), "/payload/cover_asset_ref")
        require_approved(cover_rec, "/payload/cover_asset_ref", "cover art")
        rights = (cover_rec.get("data") or {}).get("rights") or {}
        if rights.get("cleared") is not True:
            raise _blocked("APPROVAL_REQUIRED", "/payload/cover_asset_ref/rights", "cover art rights are not cleared")
        raw, mime = asset_bytes(ctx, cover_rec, "/payload/cover_asset_ref")
        img = image_of(raw, mime, "/payload/cover_asset_ref")
        spec_rec = ctx.field_record("print_profile_ref")
        spec = load_artifact(ctx, spec_rec, ("G14",), "/payload/print_profile_ref")[0] if spec_rec else None
        srcs = [cover_rec["ref"]] + ([spec_rec["ref"]] if spec_rec else [])
        md = {"title": "Cover", "language": None}
        extra_violations = []
        if p["cover_mode"] == "PRINT":
            if spec is None:
                raise _rej("MISSING_INPUT", "/payload/print_profile_ref", "a PRINT cover needs the G14 print spec",
                           status="BLOCKED")
            if "page_count" not in p:
                raise _rej("MISSING_INPUT", "/payload/page_count", "a PRINT cover needs the stabilised interior "
                           "page_count", status="BLOCKED")
            self._check_page_count(ctx, p["page_count"])
            printer = aux_data(ctx.record(spec["printer_profile_ref"]), "PRINTER_PROFILE", "/payload/print_profile_ref")
            paper = aux_data(ctx.record(spec["paper_stock_ref"]), "PAPER_STOCK", "/payload/print_profile_ref")
            spine = spine_mm(p["page_count"], spec["binding"], printer, paper)
            tw, th, bleed = spec["trim_width_mm"], spec["trim_height_mm"], printer["bleed_mm"]
            W, H, S, B = mm_to_pt(2 * tw + spine), mm_to_pt(th), mm_to_pt(spine), mm_to_pt(bleed)
            front_x = mm_to_pt(tw + spine)
            cover_file = render_cover_pdf(width=W, height=H, bleed=B, image=img, meta=md,
                                          image_box=(front_x, -B, mm_to_pt(tw) + B, H + 2 * B),
                                          spine=(mm_to_pt(tw), S))
            rep = inspect_pdf(cover_file)
            extra_violations += [{"code": "INVALID_INPUT", "path": "/layout_asset", "message": m} for m in rep["errors"]]
            cover_ref = ctx.stage_binary("G10", cover_file, "application/pdf", source_refs=srcs)
            layout = {"cover_mode": "PRINT", "front_width_mm": tw, "height_mm": th, "spine_mm": spine,
                      "layout_asset_ref": cover_ref, "profile_ref": spec_rec["ref"]}
        else:
            if spec is not None:
                fw, fh = spec["trim_width_mm"], spec["trim_height_mm"]
            else:  # digital cover: nominal size of the approved pixels at 300 ppi
                fw, fh = round(img.width * 25.4 / 300, 3), round(img.height * 25.4 / 300, 3)
            if sniff_mime(raw) is None:
                extra_violations.append({"code": "INVALID_INPUT", "path": "/layout_asset", "message": "not an image"})
            cover_ref = ctx.stage_binary("G10", raw, img.mime, source_refs=srcs)
            layout = {"cover_mode": "EBOOK", "front_width_mm": fw, "height_mm": fh, "spine_mm": None,
                      "layout_asset_ref": cover_ref, "profile_ref": (spec_rec or cover_rec)["ref"]}
        return self.publish_json(ctx, layout, source_refs=srcs, extra_subjects=[cover_ref],
                                 extra_violations=extra_violations)

    def _check_page_count(self, ctx: Context, page_count: int):
        """If a G07/G04 pin is supplied in input_refs, the cover must use its final page count."""
        for ptr, rec in sorted(ctx.resolved.items()):
            if not ptr.startswith("/input_refs/") or rec["module_id"] not in ("G04", "G07"):
                continue
            pg = g07_context(ctx, rec, ptr) if rec["module_id"] == "G07" else g04_context(ctx, rec, ptr)
            count = pg.layout.page_count
            if count != page_count:
                raise _rej("INVALID_INPUT", "/payload/page_count", f"page_count {page_count} differs from the "
                           f"stabilised interior ({count} pages from {rec['module_id']})")

    def semantic(self, ctx, record):
        art, _ = self.artifact(ctx, record)
        try:
            cover = ctx.record(art["layout_asset_ref"])
        except AkoweError as exc:
            return [ctx.finding("COVER_FILE", exc.errors[0]["message"], severity="BLOCKING")]
        if cover["module_id"] != "G10" or cover["representation"] != "BINARY_ARTIFACT":
            return [ctx.finding("COVER_FILE", "layout_asset_ref must pin a staged G10 cover file", severity="BLOCKING")]
        raw = ctx.binary(cover)
        if art["cover_mode"] == "PRINT" and inspect_pdf(raw)["errors"]:
            return [ctx.finding("COVER_FILE", "wrap cover PDF is not structurally valid", severity="BLOCKING")]
        if art["cover_mode"] == "EBOOK" and sniff_mime(raw) is None:
            return [ctx.finding("COVER_FILE", "ebook cover is not a JPEG/PNG image", severity="BLOCKING")]
        return []


# =========================================================================== exports
class _Export(GHandler):
    profile_field = ""
    profile_types: tuple = ()

    def applicability(self, ctx):
        return _profile_applicability(ctx)

    def profile(self, ctx: Context) -> tuple[dict, dict]:
        rec = ctx.field_record(self.profile_field)
        prof = aux_data(rec, "OUTPUT_PROFILE", f"/payload/{self.profile_field}")
        if prof["profile_type"] not in self.profile_types:
            raise _rej("INVALID_INPUT", f"/payload/{self.profile_field}",
                       f"{ctx.op_id} exports {'/'.join(self.profile_types)}, not {prof['profile_type']}")
        if prof["profile_type"] not in release_profiles(ctx):
            raise _rej("INVALID_INPUT", f"/payload/{self.profile_field}",
                       f"profile {prof['profile_type']} is not selected in the feature manifest release_profiles")
        if ctx.op_id != "G13" and prof["profile_type"] != "EPUB_REFLOWABLE" and prof["page_profile_ref"] is None:
            raise _rej("INVALID_INPUT", f"/payload/{self.profile_field}", "page_profile_ref is null only for EPUB")
        if prof["profile_type"].startswith("PRINT") and prof["printer_profile_ref"] is None:
            raise _rej("INVALID_INPUT", f"/payload/{self.profile_field}", "print profiles need printer_profile_ref")
        return rec, prof

    def book_context(self, ctx: Context, meta: dict, *, art: bool):
        """Resolve final_book_ref (G01/G04/G07) -> (assembly, Paginated|None, toc entries|None)."""
        rec = ctx.field_record("final_book_ref")
        path = "/payload/final_book_ref"
        if rec["module_id"] in ("G04", "G07"):
            pg = (g07_context if rec["module_id"] == "G07" else g04_context)(ctx, rec, path, meta=meta)
            return pg.asm, pg, pg.toc_entries
        asm = assemble(ctx, rec, path, meta=meta, art=art)
        return asm, None, None

    def common_findings(self, ctx: Context, asm: Assembly) -> list[dict]:
        out = []
        if asm.excluded_art:
            out.append(ctx.finding("ART_EXCLUDED", "placed art is not selected by this output profile and was "
                                   "excluded (no asset is silently added)", severity="INFO", decision="PASS"))
        return out


@register("G11")
class PdfExport(_Export):
    """G11 - PDF export (MANUSCRIPT_PDF or PRINT_INTERIOR). final_book_ref G07 renders the
    converged TOC and verifies every heading lands on its TOC page; G04 renders without TOC;
    G01 paginates with the profile's page/font profiles at safe margins. Manuscript PDFs carry
    no cover, spine or bleed; print interiors add printer bleed (TrimBox/BleedBox). Every
    chapter pin must be covered by the SOURCE_APPROVAL_MANIFEST. Text uses base-14 fonts
    (no embedding needed); the parse report checks pages/boxes/fonts/links/outline."""

    profile_field = "pdf_profile_ref"
    profile_types = ("MANUSCRIPT_PDF", "PRINT_INTERIOR")

    def build(self, ctx: Context) -> Result:
        prof_rec, prof = self.profile(ctx)
        appr_rec = ctx.field_record("approval_manifest_ref")
        appr = aux_data(appr_rec, "SOURCE_APPROVAL_MANIFEST", "/payload/approval_manifest_ref")
        meta = dict(prof["metadata"], language=prof["language_tag"])
        page_rec = resolve(ctx, prof["page_profile_ref"], "/payload/pdf_profile_ref/page_profile_ref")
        page = aux_data(page_rec, "PAGE_PROFILE", "/payload/pdf_profile_ref/page_profile_ref")
        font_rec = resolve(ctx, prof["font_profile_ref"], "/payload/pdf_profile_ref/font_profile_ref")
        fp = aux_data(font_rec, "FONT_PROFILE", "/payload/pdf_profile_ref/font_profile_ref")
        asm, pg, entries = self.book_context(ctx, meta, art=prof["artwork_selected"])
        if pg is not None:
            if not _same_pin(pg.page_rec["ref"], page_rec["ref"]):
                raise _rej("INVALID_INPUT", "/payload/final_book_ref", "book was paginated with a different "
                           "PAGE_PROFILE than the PDF profile pins")
            g05, _ = load_artifact(ctx, pg.typo_rec, ("G05",), "/payload/final_book_ref")
            for k in ("font_refs", "fallback_names", "font_size_pt", "line_height_pt", "embedding_permitted"):
                if g05[k] != fp[k]:
                    raise _rej("INVALID_INPUT", "/payload/final_book_ref", f"typography {k} differs from the PDF "
                               "profile's FONT_PROFILE")
            if asm.images and not prof["artwork_selected"]:
                raise _rej("INVALID_INPUT", "/payload/final_book_ref", "this pagination includes placed art but the "
                           "profile does not select artwork; paginate a manuscript compiled without G03")
            geom, typo, style = pg.geom, pg.typo, pg.toc_style
        else:
            geom = make_geometry(page, {"top": 0, "bottom": 0, "left": 0, "right": 0})
            typo, style = typography_from(fp, "/payload/pdf_profile_ref/font_profile_ref"), None
        self._approvals(ctx, asm, appr)
        bad = unencodable(bookmod.all_text(asm.book))
        if bad:
            raise _blocked("CAPABILITY_UNAVAILABLE", "/payload/final_book_ref",
                           f"characters not covered by the base-14 fonts: {''.join(bad[:20])!r}")
        try:
            layout = paginate(asm.book, geom, typo, toc_entries=entries, toc_style=style, images=asm.image_dims())
        except LayoutError as exc:
            raise _rej("INVALID_INPUT", "/payload/pdf_profile_ref", str(exc)) from exc
        if entries is not None:
            pages = dict(layout.page_map())
            for e in entries:
                if e["page"] is not None and pages.get(e["heading_id"]) != e["page"]:
                    raise _rej("TOC_NONCONVERGENCE", "/payload/final_book_ref",
                               f"heading {e['heading_id']} renders on page {pages.get(e['heading_id'])}, TOC says "
                               f"{e['page']}")
        # The pinned PAGE_PROFILE bleed is honoured as written (TrimBox/BleedBox when > 0); a manuscript
        # profile normally declares bleed_mm=0. Print interiors must also match the printer bleed.
        bleed = mm_to_pt(page["bleed_mm"])
        findings = self.common_findings(ctx, asm)
        if prof["profile_type"] == "PRINT_INTERIOR":
            printer_rec = resolve(ctx, prof["printer_profile_ref"], "/payload/pdf_profile_ref/printer_profile_ref")
            printer = aux_data(printer_rec, "PRINTER_PROFILE", "/payload/pdf_profile_ref/printer_profile_ref")
            if abs(printer["bleed_mm"] - page["bleed_mm"]) > printer["geometry_tolerance_mm"]:
                raise _rej("INVALID_INPUT", "/payload/pdf_profile_ref", "PAGE_PROFILE bleed differs from the printer "
                           "bleed beyond tolerance")
        pdf = render_pdf(layout, page_width=geom.width, page_height=geom.height, bleed=bleed, meta=meta,
                         images=asm.pdf_images())
        findings.append(ctx.finding("FONT_EMBEDDING", f"fonts {sorted({typo.regular, typo.bold})} are PDF base-14 "
                                    "standard fonts referenced without embedding; pinned font_refs files are not used",
                                    severity="MAJOR", decision="UNKNOWN", source_refs=list(fp["font_refs"])))
        srcs = [ctx.field_record("final_book_ref")["ref"]] + asm.pins() + [prof_rec["ref"], page_rec["ref"],
                                                                            font_rec["ref"], appr_rec["ref"]]
        return self.publish(ctx, pdf, mime=EXPORT_MIME["G11"], source_refs=_dedupe(srcs), findings=findings)

    def _approvals(self, ctx: Context, asm: Assembly, appr: dict):
        covered = appr["source_refs"]
        for rec in asm.chapter_recs:
            if not any(_same_pin(rec["ref"], r) for r in covered):
                raise _blocked("APPROVAL_REQUIRED", "/payload/approval_manifest_ref",
                               f"chapter {rec['record_id']} v{rec['version']} is not in the source approval manifest")
        for i, ref in enumerate(appr["approval_refs"]):
            a = ctx.record(ref)
            data = a.get("data") or {}
            if a["module_id"] == "K09":
                ok = data.get("decision") == "APPROVED"
            elif a["module_id"] == "I10":
                ok = (data.get("approval") or {}).get("decision") == "APPROVED" and not (data.get("approval") or {}).get(
                    "revoked")
            else:
                ok = a["lifecycle"] in APPROVED
            if not ok:
                raise _blocked("APPROVAL_REQUIRED", f"/payload/approval_manifest_ref/approval_refs/{i}",
                               f"approval {ref['record_id']} is not an approved decision")


@register("G12")
class EpubExport(_Export):
    """G12 - EPUB 3 reflowable export: navigation anchors, no print page numbers, art only
    when the profile selects artwork, optional EBOOK cover from a G10 descriptor in
    input_refs. EPUBCheck is not available: reported as UNKNOWN."""

    profile_field = "epub_profile_ref"
    profile_types = ("EPUB_REFLOWABLE",)

    def build(self, ctx: Context) -> Result:
        prof_rec, prof = self.profile(ctx)
        md_rec = ctx.field_record("metadata_ref")
        md = aux_data(md_rec, "PUBLICATION_METADATA", "/payload/metadata_ref")
        meta = dict(md, language=prof["language_tag"])
        asm, pg, entries = self.book_context(ctx, meta, art=prof["artwork_selected"])
        images = asm.images
        findings = self.common_findings(ctx, asm)
        if images and not prof["artwork_selected"]:
            images = {}
            findings.append(ctx.finding("ART_EXCLUDED", "placed art excluded: profile does not select artwork",
                                        severity="INFO", decision="PASS"))
        cover, extra = None, []
        for ptr, rec in sorted(ctx.resolved.items()):
            if ptr.startswith("/input_refs/") and rec["module_id"] == "G10":
                layout, _ = load_artifact(ctx, rec, ("G10",), ptr)
                if layout["cover_mode"] != "EBOOK":
                    raise _rej("INVALID_INPUT", ptr, "only an EBOOK cover can be packaged into an EPUB")
                crec = ctx.record(layout["layout_asset_ref"])
                craw = ctx.binary(crec)
                cover = (craw, image_of(craw, crec["binary"]["mime_type"], ptr))
                extra.append(rec["ref"])
        toc = [dict(e, page=None) for e in entries] if entries is not None else None
        final = ctx.field_record("final_book_ref")
        data = build_epub(asm.book, modified=_iso_seconds(final["created_at"]), toc_entries=toc,
                          images=images, cover=cover)
        findings.append(ctx.finding("EPUBCHECK", "EPUBCheck is not bundled; structural OCF/OPF/XHTML/nav checks "
                                    "passed but conformance remains UNKNOWN until EPUBCheck runs (H09)",
                                    severity="MAJOR", decision="UNKNOWN"))
        srcs = [final["ref"]] + asm.pins() + [prof_rec["ref"], md_rec["ref"]] + extra
        return self.publish(ctx, data, mime=EXPORT_MIME["G12"], source_refs=_dedupe(srcs), findings=findings)


@register("G13")
class DocxExport(_Export):
    """G13 - editable DOCX: structured headings/paragraph styles, bookmarks, a TOC field with
    hyperlinks when final_book_ref is a converged G07, image relationships when art is
    selected; page size from the profile's PAGE_PROFILE when pinned."""

    profile_field = "docx_profile_ref"
    profile_types = ("EDITABLE_DOCX",)

    def build(self, ctx: Context) -> Result:
        prof_rec, prof = self.profile(ctx)
        md_rec = ctx.field_record("metadata_ref")
        md = aux_data(md_rec, "PUBLICATION_METADATA", "/payload/metadata_ref")
        meta = dict(md, language=prof["language_tag"])
        asm, pg, entries = self.book_context(ctx, meta, art=prof["artwork_selected"])
        findings = self.common_findings(ctx, asm)
        images = asm.images
        if images and not prof["artwork_selected"]:
            images = {}
            findings.append(ctx.finding("ART_EXCLUDED", "placed art excluded: profile does not select artwork",
                                        severity="INFO", decision="PASS"))
        font_rec = resolve(ctx, prof["font_profile_ref"], "/payload/docx_profile_ref/font_profile_ref")
        fp = aux_data(font_rec, "FONT_PROFILE", "/payload/docx_profile_ref/font_profile_ref")
        fam = resolve_family(fp["fallback_names"]) or "times"
        page = None
        srcs_extra = [font_rec["ref"]]
        if prof["page_profile_ref"] is not None:
            page_rec = resolve(ctx, prof["page_profile_ref"], "/payload/docx_profile_ref/page_profile_ref")
            page = aux_data(page_rec, "PAGE_PROFILE", "/payload/docx_profile_ref/page_profile_ref")
            srcs_extra.append(page_rec["ref"])
        final = ctx.field_record("final_book_ref")
        toc = [dict(e, page=None) for e in entries] if entries is not None else None
        data = build_docx(asm.book, created=_iso_seconds(final["created_at"]), family=fam,
                          size_pt=float(fp["font_size_pt"]), leading_pt=float(fp["line_height_pt"]),
                          toc_entries=toc, images=images, page=page)
        findings.append(ctx.finding("FONT_REFERENCE", f"document styles name the system font for family '{fam}'; "
                                    "pinned font files are not embedded in the DOCX", severity="MINOR",
                                    decision="UNKNOWN", source_refs=list(fp["font_refs"])))
        srcs = [final["ref"]] + asm.pins() + [prof_rec["ref"], md_rec["ref"]] + srcs_extra
        return self.publish(ctx, data, mime=EXPORT_MIME["G13"], source_refs=_dedupe(srcs), findings=findings)


def _dedupe(refs: list[dict]) -> list[dict]:
    seen, out = set(), []
    for r in refs:
        k = (r["record_id"], r["version"])
        if k not in seen:
            seen.add(k)
            out.append(r)
    return out
