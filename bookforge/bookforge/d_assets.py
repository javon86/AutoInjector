"""Set D asset helpers: storage URIs, MIME sniffing, binary binding and manual image import.

Every D OUTPUT is a *descriptor* (asset_type, storage_uri, mime_type, file_hash, rights,
findings). The bytes live in a distinct D-owned BINARY_ARTIFACT record staged by the same
operation (Shared Contract sections 9 and 10). The descriptor never points to itself.

storage_uri scheme
------------------
``bookforge-asset://<project>/<branch>/<sha256>.bin#<binary record_id>@v<version>``

The part before ``#`` is byte-for-byte the content-addressed ``storage_uri`` that the storage
kernel writes into the binary's metadata (store.insert_binary_record), so any code that knows
the kernel scheme can fetch the file. The fragment names the exact binary record revision,
because content addressing alone cannot tell two records with identical bytes apart (for
example an I01 upload and the D-owned copy). Consumers resolve the fragment, then verify
module ownership, kind=BINARY_ARTIFACT, MIME and the exact byte hash before using the file.
"""
from __future__ import annotations

import re

from .canonical import make_reference
from .errors import BookforgeError

URI_RE = re.compile(r"^bookforge-asset://(?P<project>[^/#]+)/(?P<branch>[^/#]+)/(?P<sha>[a-f0-9]{64})\.bin"
                    r"#(?P<record_id>[^@#/]+)@v(?P<version>[1-9][0-9]*)$")

IMAGE_MIMES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/tiff", "image/svg+xml",
               "application/pdf"}


def asset_uri(ref: dict) -> str:
    """Stable storage URI for a staged/stored binary Reference."""
    return (f"bookforge-asset://{ref['project_id']}/{ref['branch_id']}/{ref['content_hash']}.bin"
            f"#{ref['record_id']}@v{ref['version']}")


def parse_asset_uri(uri: str) -> dict | None:
    m = URI_RE.match(uri or "")
    if not m:
        return None
    d = m.groupdict()
    d["version"] = int(d["version"])
    return d


def sniff_mime(data: bytes) -> str | None:
    """Identify supported image/document formats from their magic bytes (never from labels)."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith((b"II*\x00", b"MM\x00*")):
        return "image/tiff"
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    head = data[:4096].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if head.startswith(b"<svg") or (head.startswith(b"<?xml") and b"<svg" in head):
        low = data.lower()
        if b"<script" in low or b"javascript:" in low or b"<foreignobject" in low:
            return None  # active SVG content is not an accepted art file
        return "image/svg+xml"
    return None


def check_binding(ctx, data: dict, module_id: str) -> tuple[dict | None, bytes | None, list[dict]]:
    """Resolve data.storage_uri to the D-owned binary and verify kind, owner, MIME and bytes.

    Returns (binary_record, bytes, findings); findings are BLOCKING FAIL on any mismatch.
    """
    out = []
    parsed = parse_asset_uri(data.get("storage_uri", ""))
    if parsed is None:
        out.append(ctx.finding("STORAGE_URI", "storage_uri is not a bookforge-asset URI naming a binary record "
                               "revision", severity="BLOCKING"))
        return None, None, out
    if parsed["project"] != ctx.project_id or parsed["branch"] != ctx.branch_id:
        out.append(ctx.finding("STORAGE_URI", "storage_uri names a foreign project/branch", severity="BLOCKING"))
        return None, None, out
    rec = ctx.store.get_record(ctx.project_id, ctx.branch_id, parsed["record_id"], parsed["version"])
    if rec is None:
        out.append(ctx.finding("STORAGE_URI", f"binary {parsed['record_id']} v{parsed['version']} not found",
                               severity="BLOCKING"))
        return None, None, out
    if rec["representation"] != "BINARY_ARTIFACT":
        out.append(ctx.finding("BINARY_KIND", "storage_uri must name a BINARY_ARTIFACT, not a JSON record",
                               severity="BLOCKING", source_refs=[rec["ref"]]))
        return None, None, out
    if rec["module_id"] != module_id:
        out.append(ctx.finding("ASSET_OWNERSHIP", f"asset bytes are owned by {rec['module_id']}, not {module_id}; "
                               "D assets must be D-owned copies with provenance", severity="BLOCKING",
                               source_refs=[rec["ref"]]))
    if rec["content_hash"] != parsed["sha"] or rec["content_hash"] != data.get("file_hash"):
        out.append(ctx.finding("FILE_HASH", "file_hash does not equal the binary's exact byte SHA-256",
                               severity="BLOCKING", source_refs=[rec["ref"]]))
    if (rec.get("binary") or {}).get("mime_type") != data.get("mime_type"):
        out.append(ctx.finding("MIME_TYPE", "mime_type differs from the stored binary metadata",
                               severity="BLOCKING", source_refs=[rec["ref"]]))
    try:
        blob = ctx.binary(rec)
    except (BookforgeError, OSError) as exc:
        out.append(ctx.finding("FILE_BYTES", f"stored bytes unreadable or corrupt: {exc}", severity="BLOCKING",
                               source_refs=[rec["ref"]]))
        return rec, None, out
    return rec, blob, out


def find_import(ctx, file_hash: str | None, *, pointer: str) -> dict | None:
    """Locate the user's I01 IMPORT binary: pinned in input_refs first, else by exact hash."""
    pinned = [r for p, r in sorted(ctx.resolved.items()) if p.startswith("/input_refs/")
              and r["module_id"] == "I01" and r["representation"] == "BINARY_ARTIFACT"]
    if file_hash:
        pinned = [r for r in pinned if r["content_hash"] == file_hash]
    if len(pinned) > 1 and len({r["content_hash"] for r in pinned}) > 1:
        raise BookforgeError("INVALID_INPUT", "/input_refs", "several different uploaded images are pinned; "
                             "pin exactly one image import", status="REJECTED")
    if pinned:
        return pinned[0]
    if not file_hash:
        return None
    for rec in ctx.store.list_records(ctx.project_id, ctx.branch_id, module_id="I01", record_kind="IMPORT"):
        if rec["representation"] == "BINARY_ARTIFACT" and rec["content_hash"] == file_hash:
            return rec
    return None


def load_import(ctx, rec: dict, mime_hint: str | None, pointer: str) -> tuple[bytes, str]:
    """Verified bytes and sniffed MIME of an uploaded image; refuses non-image or mislabelled files."""
    blob = ctx.binary(rec)
    sniffed = sniff_mime(blob)
    if sniffed is None:
        raise BookforgeError("INVALID_INPUT", pointer, "uploaded file is not a supported image (PNG, JPEG, GIF, "
                             "WebP, TIFF, static SVG or PDF)", status="REJECTED")
    if mime_hint and mime_hint != sniffed:
        raise BookforgeError("INVALID_INPUT", pointer.rsplit("/", 1)[0] + "/mime_type",
                             f"declared {mime_hint} but the uploaded bytes are {sniffed}", status="REJECTED")
    return blob, sniffed


def ref_of(rec_or_ref: dict) -> dict:
    r = rec_or_ref.get("ref", rec_or_ref)
    return make_reference(r["project_id"], r["branch_id"], r["module_id"], r["record_id"], r["version"],
                          r["content_hash"])


def same_pin(a: dict, b: dict) -> bool:
    return (a["record_id"], a["version"], a["content_hash"]) == (b["record_id"], b["version"], b["content_hash"])


DIM_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*[x×X]\s*(\d+(?:\.\d+)?)\s*(mm|cm|in|pt|px)\s*$")


def parse_dimensions(text: str, pointer: str) -> dict:
    """'170x260 mm' -> {width, height, unit}; units are explicit and dimensions positive."""
    m = DIM_RE.match(text or "")
    if not m:
        raise BookforgeError("INVALID_INPUT", pointer, "dimensions must look like '<width>x<height> <unit>' with "
                             "unit mm, cm, in, pt or px", status="REJECTED")
    w, hgt = float(m.group(1)), float(m.group(2))
    if w <= 0 or hgt <= 0:
        raise BookforgeError("INVALID_INPUT", pointer, "dimensions must be positive", status="REJECTED")
    num = lambda v: int(v) if v.is_integer() else v  # noqa: E731
    return {"width": num(w), "height": num(hgt), "unit": m.group(3)}
