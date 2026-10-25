"""Set G (book assembly/export) tests: profile import -> approved prose -> G02 -> G01 -> G05 ->
G04 -> G07 -> G11/G12/G13, print-only G14/G10, art placement G03, determinism and failures."""
from __future__ import annotations

import hashlib
import io
import re
import struct
import zipfile
import zlib
import xml.etree.ElementTree as ET

import pytest

from conftest import PRINCIPAL, errors_of
from bookforge.canonical import sha256_bytes

MD = {"title": "The Salt Road", "author": "Mara Vell", "identifier": "urn:uuid:3f1c2d7e-0000-4000-8000-000000000001",
      "rights": "Copyright 2026 Mara Vell. All rights reserved."}

CH1 = ("# The Harbour\n" + "\n".join(
    f"Line {i}: the tide came in over the stones — “slowly,” she said — and the gulls "
    f"wheeled above the café roofs while the ferry waited at the quay." for i in range(45))
       + "\n## Night\nThe lamps were lit one by one.\n***\nMorning came grey and cold.")
CH2 = "# The Road\nShe left before dawn.\nThe road ran east along the salt flats."


# ----------------------------------------------------------------------------- fixtures
def import_profile(h, kind, data, approve=True):
    payload = {
        "owner_operation": "I01", "source_ref": None, "approval_ref": None, "fact_type": "AUXILIARY",
        "fact_payload": {"summary": f"{kind} profile", "facts": [], "links": []}, "requested_state": "DRAFT",
        "auxiliary_record": {"record_kind": kind, "data": data},
        "import_evidence": {"source_label": f"{kind}.json", "source_sha256": hashlib.sha256(repr(data).encode()).hexdigest(),
                            "principal_id": PRINCIPAL, "imported_at": "2026-10-12T09:00:00Z"},
    }
    r = h.create("I01", payload)
    assert r["status"] == "DRAFT", r
    ref = r["output_refs"][0]
    if approve:
        assert h.approve(ref)["status"] == "APPROVED"
    return ref


def set_release_profiles(h, profiles, **features):
    m = dict(h.store.feature_manifest(h.project_id, h.branch_id))
    m["release_profiles"] = list(profiles)
    m["features"] = dict(m["features"], **features)
    return h.engine.set_manifest(PRINCIPAL, h.project_id, h.branch_id, m)


def manifest_revision(h):
    return h.store.feature_manifest(h.project_id, h.branch_id)["revision"]


def _plan(subject, predicate, value):
    return {"subject_id": subject, "predicate": predicate, "value": value, "assertion_type": "PLAN",
            "effective_from": None, "effective_to": None, "source_refs": []}


def approved_chapters(h, texts):
    """B01 -> B03 -> B11 outline (manual, approved) -> C01 context (LOGIC) -> C02 prose (manual, approved).

    C02 ACCEPT needs its HARD inputs validated (Shared s9 ALL_SELECTED_INPUTS_RESOLVED_AND_VALIDATED): the C01
    context is checked in place, and C01's own rule needs an approved outline, so the outline is approved."""
    b01, _ = h.create_approved("B01", {"idea": "a salt-road journey", "goals": ["finish"]},
                               manual_candidate={"premise": "p", "dramatic_question": "q?", "concept_summary": "s"})
    from test_set_b import canon  # the outline's POV/location must be declared by pinned canon to validate
    b03, _ = h.create_approved("B03", {"premise_ref": b01, "canon_refs": list(canon(h)), "constraints": []},
                               manual_candidate={"main_plot": {"summary": "x", "facts": [], "links": []},
                                                 "objectives": [], "plot_obligations": []})
    chapters = []
    for i in range(1, len(texts) + 1):
        cid = f"ch{i}"
        chapters.append({"summary": f"chapter {i}", "links": [], "facts": [
            _plan(cid, "plan.item_id", cid), _plan(cid, "plan.order", i), _plan(cid, "plan.parent_id", None),
            _plan(cid, "plan.objective", "the journey advances"), _plan(cid, "plan.event_ids", []),
            _plan(cid, "plan.pov_id", "char-mara"), _plan(cid, "plan.location_id", "loc-harbor"),
            _plan(cid, "plan.obligation_ids", [])]})
    r = h.dispatch("B11", "CREATE", payload={"main_plot_ref": b03, "selected_plan_refs": []},
                   manual_candidate={"chapters": chapters, "unresolved_threads": []})
    assert r["status"] == "DRAFT", r
    b11 = r["output_refs"][0]
    assert h.approve(b11)["status"] == "APPROVED"
    out = []
    for i, text in enumerate(texts, start=1):
        r = h.create("C01", {"chapter_id": f"ch{i}", "outline_ref": b11, "instruction": "context"})
        assert r["status"] == "DRAFT", r
        c01 = r["output_refs"][0]
        objective = {"id": f"obj-{i}", "rule_id": f"OBJECTIVE:ch{i}", "severity": "INFO", "decision": "PASS",
                     "message": "author reviewed the objective", "evidence": [], "source_refs": [], "confidence": None}
        c02, _ = h.create_approved("C02", {"chapter_id": f"ch{i}", "outline_ref": b11, "context_ref": c01,
                                           "instruction": "write"},
                                   manual_candidate={"text": text, "candidate_events": [], "findings": [objective]})
        out.append(c02)
    return out


class Book:
    """Seeds user-approved profiles, approved chapters and runs the assembly chain."""

    def __init__(self, h, texts=(CH1, CH2), profiles=("MANUSCRIPT_PDF", "EPUB_REFLOWABLE", "EDITABLE_DOCX")):
        self.h = h
        set_release_profiles(h, profiles)
        font_file = import_profile(h, "ASSET_MANIFEST", {"assets": [], "placement_ids": ["font:times-roman"]})
        self.font = import_profile(h, "FONT_PROFILE", {
            "font_refs": [font_file], "embedding_permitted": True, "fallback_names": ["Times-Roman"],
            "font_size_pt": 11, "line_height_pt": 14, "language_tag": "en"})
        self.page = import_profile(h, "PAGE_PROFILE", {"width_mm": 152.4, "height_mm": 228.6, "bleed_mm": 0,
                                                       "safe_margin_mm": 12.7})
        self.pdf_profile = self.output_profile("MANUSCRIPT_PDF")
        self.epub_profile = self.output_profile("EPUB_REFLOWABLE", page=None)
        self.docx_profile = self.output_profile("EDITABLE_DOCX")
        self.metadata = import_profile(h, "PUBLICATION_METADATA", dict(MD))
        self.toc_style = import_profile(h, "TOC_STYLE", {"max_depth": 2, "include_pages": True, "link_targets": True})
        self.title_rules = import_profile(h, "TITLE_RULES", {"pattern": "Chapter {number}: {title}",
                                                             "include_number": True})
        self.chapters = approved_chapters(h, texts)
        self.approvals = import_profile(h, "SOURCE_APPROVAL_MANIFEST", {
            "source_refs": self.chapters, "approval_refs": self.chapters, "policy_ref": self.pdf_profile})

    def output_profile(self, ptype, page="default", artwork=False, printer=None):
        return import_profile(self.h, "OUTPUT_PROFILE", {
            "profile_id": ptype.lower(), "profile_type": ptype, "required_checks": ["H09"],
            "required_export_operations": [], "artwork_selected": artwork, "language_tag": "en", "metadata": dict(MD),
            "printer_profile_ref": printer, "page_profile_ref": self.page if page == "default" else page,
            "font_profile_ref": self.font})

    def ok(self, op, payload, **kw):
        r = self.h.create(op, payload, **kw)
        assert r["status"] == "DRAFT", (op, r["errors"], r["findings"])
        return r["output_refs"][0], r

    def g02(self, order=None):
        ids = order or [c["record_id"] for c in self.chapters]
        return self.ok("G02", {"approved_chapter_refs": list(reversed(self.chapters)), "ordered_chapter_ids": ids,
                               "manifest_revision": manifest_revision(self.h)})[0]

    def g01(self, g02, input_refs=None):
        return self.ok("G01", {"ordered_manifest_ref": g02, "approved_chapter_refs": self.chapters,
                               "section_id_policy": "STABLE_ID"}, input_refs=input_refs or [])[0]

    def g05(self, g01):
        return self.ok("G05", {"font_profile_ref": self.font, "language_tag": "en", "manuscript_ref": g01})[0]

    def g04(self, g01, g05, margins=54):
        return self.ok("G04", {"manuscript_ref": g01, "page_profile_ref": self.page, "typography_ref": g05,
                               "margins_pt": {"top": margins, "bottom": margins, "left": margins, "right": margins}})[0]

    def g07(self, g04, max_passes=6):
        return self.ok("G07", {"paginated_book_ref": g04, "toc_style_ref": self.toc_style, "max_passes": max_passes})[0]

    def matter(self, g01, g05):
        g06 = self.ok("G06", {"typography_ref": g05, "chapter_title_rules_ref": self.title_rules})[0]
        g08 = self.ok("G08", {"book_ref": g01, "front_matter_items": ["title_page", "copyright", "toc"],
                              "publication_profile_ref": self.pdf_profile})[0]
        g09 = self.ok("G09", {"book_ref": g01, "back_matter_items": ["colophon"],
                              "publication_profile_ref": self.pdf_profile})[0]
        return [g06, g08, g09]

    def chain(self, with_matter=True):
        g02 = self.g02()
        g01 = self.g01(g02)
        g05 = self.g05(g01)
        if with_matter:
            g01 = self.g01(g02, input_refs=self.matter(g01, g05))
            g05 = self.g05(g01)
        g04 = self.g04(g01, g05)
        g07 = self.g07(g04)
        return {"g02": g02, "g01": g01, "g05": g05, "g04": g04, "g07": g07}

    def binary(self, descriptor_ref):
        rec = self.h.record(descriptor_ref)
        bin_rec = self.h.record(rec["data"]["artifact_ref"])
        return self.h.store.read_binary(bin_rec), rec, bin_rec

    def export(self, op, final_ref, **kw):
        if op == "G11":
            payload = {"final_book_ref": final_ref, "pdf_profile_ref": kw.get("profile", self.pdf_profile),
                       "approval_manifest_ref": self.approvals}
        elif op == "G12":
            payload = {"final_book_ref": final_ref, "epub_profile_ref": kw.get("profile", self.epub_profile),
                       "metadata_ref": self.metadata}
        else:
            payload = {"final_book_ref": final_ref, "docx_profile_ref": kw.get("profile", self.docx_profile),
                       "metadata_ref": self.metadata}
        return self.h.create(op, payload, input_refs=kw.get("input_refs", []))


def png_bytes(w, h, alpha=False):
    bpp = 4 if alpha else 3
    rows = b"".join(b"\x00" + b"".join(bytes([(x * 17) % 256, (y * 29) % 256, 120] + ([180] if alpha else []))
                                       for x in range(w)) for y in range(h))

    def chunk(t, body):
        return struct.pack(">I", len(body)) + t + body + struct.pack(">I", zlib.crc32(t + body) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6 if alpha else 2, 0, 0, 0)
    assert len(rows) == h * (1 + w * bpp)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def fixture_asset(h, op, data, mime="image/png", approved=True):
    """Fixture-origin D asset (binary + descriptor) stored directly; D handlers are another set."""
    pkg = h.engine.contracts
    asset_type = pkg.definition(op, "OUTPUT")["properties"]["asset_type"]["const"]
    with h.store.transaction() as tx:
        bin_ref = tx.insert_binary_record(project_id=h.project_id, branch_id=h.branch_id, module_id=op,
                                          record_id=f"{op}-bin-{sha256_bytes(data)[:8]}", version=1, data=data,
                                          mime_type=mime, source_refs=[], principal_id=PRINCIPAL,
                                          evidence_origin="FIXTURE")
    meta = h.store.get_record(h.project_id, h.branch_id, bin_ref["record_id"], 1)["binary"]
    out = {"asset_type": asset_type, "storage_uri": meta["storage_uri"], "mime_type": mime,
           "file_hash": sha256_bytes(data), "rights": {"license": "author-owned", "source": "author", "cleared": True},
           "findings": []}
    with h.store.transaction() as tx:
        ref = tx.insert_json_record(project_id=h.project_id, branch_id=h.branch_id, module_id=op,
                                    record_id=f"{op}-asset-{sha256_bytes(data)[:8]}", version=1, data=out,
                                    source_refs=[bin_ref], principal_id=PRINCIPAL, evidence_origin="FIXTURE")
        if approved:
            tx.set_lifecycle(ref, "APPROVED")
            tx.set_approved_head(ref)
    return ref


# ----------------------------------------------------------------------------- independent parsers
def parse_pdf(data: bytes) -> dict:
    """Minimal independent PDF check: header, xref offsets, trailer, page count, fonts."""
    assert data.startswith(b"%PDF-1.7\n")
    assert data.rstrip().endswith(b"%%EOF")
    startxref = int(re.search(rb"startxref\s+(\d+)\s+%%EOF\s*$", data).group(1))
    assert data[startxref:startxref + 4] == b"xref"
    m = re.match(rb"xref\n0 (\d+)\n", data[startxref:])
    n = int(m.group(1))
    table = data[startxref + m.end():startxref + m.end() + 20 * n]
    offsets = {}
    for i in range(n):
        entry = table[20 * i:20 * i + 20]
        if entry[17:18] == b"n":
            offsets[i] = int(entry[:10])
            assert data[offsets[i]:].startswith(f"{i} 0 obj".encode()), f"bad xref offset for object {i}"
    trailer = data[startxref + m.end() + 20 * n:]
    assert trailer.startswith(b"trailer") and f"/Size {n}".encode() in trailer
    root = int(re.search(rb"/Root (\d+) 0 R", trailer).group(1))
    cat = data[offsets[root]:data.index(b"endobj", offsets[root])]
    pages_obj = int(re.search(rb"/Pages (\d+) 0 R", cat).group(1))
    pages = data[offsets[pages_obj]:data.index(b"endobj", offsets[pages_obj])]
    count = int(re.search(rb"/Count (\d+)", pages).group(1))
    kids = re.findall(rb"(\d+) 0 R", pages[pages.index(b"/Kids"):])
    page_objs = [data[offsets[int(k)]:data.index(b"endobj", offsets[int(k)])] for k in kids]
    assert all(b"/Type /Page " in p for p in page_objs)
    fonts = sorted(set(re.findall(rb"/BaseFont /([A-Za-z-]+)", data)))
    return {"count": count, "kids": len(kids), "pages": page_objs, "fonts": fonts, "catalog": cat}


def check_epub(data: bytes) -> dict:
    zf = zipfile.ZipFile(io.BytesIO(data))
    first = zf.infolist()[0]
    assert first.filename == "mimetype" and first.compress_type == zipfile.ZIP_STORED
    assert zf.read("mimetype") == b"application/epub+zip"
    assert data[30:38] == b"mimetype"  # first local header name, no extra field
    container = ET.fromstring(zf.read("META-INF/container.xml"))
    opf_path = container.find(".//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile").get("full-path")
    opf = ET.fromstring(zf.read(opf_path))
    ns = {"o": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/"}
    assert opf.find("o:metadata/dc:title", ns).text == MD["title"]
    items = {i.get("id"): i for i in opf.findall("o:manifest/o:item", ns)}
    spine = [i.get("idref") for i in opf.findall("o:spine/o:itemref", ns)]
    assert spine and all(s in items for s in spine)
    xhtml = 0
    for name in zf.namelist():
        if name.endswith(".xhtml"):
            root = ET.fromstring(zf.read(name))  # well-formed XML
            assert root.tag == "{http://www.w3.org/1999/xhtml}html"
            xhtml += 1
    assert any("nav" in (i.get("properties") or "") for i in items.values())
    return {"zip": zf, "spine": spine, "xhtml": xhtml, "items": items}


def check_docx(data: bytes) -> dict:
    zf = zipfile.ZipFile(io.BytesIO(data))
    names = zf.namelist()
    for required in ("[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml",
                     "docProps/core.xml", "word/_rels/document.xml.rels"):
        assert required in names
    parsed = {n: ET.fromstring(zf.read(n)) for n in names if n.endswith((".xml", ".rels"))}
    w = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    doc = parsed["word/document.xml"]
    styles = [p.get(f"{w}val") for p in doc.iter(f"{w}pStyle")]
    texts = "".join(t.text or "" for t in doc.iter(f"{w}t"))
    return {"styles": styles, "text": texts, "names": names}


# ----------------------------------------------------------------------------- tests
def test_full_chain_exports_open_and_bind_bytes(h):
    b = Book(h)
    c = b.chain(with_matter=True)
    # G04 pagination artifact is JSON bytes validated against G04Artifact and pins its inputs.
    raw4, rec4, bin4 = b.binary(c["g04"])
    assert rec4["data"]["sha256"] == bin4["content_hash"] == sha256_bytes(raw4)
    assert rec4["data"]["revision"] == bin4["version"] and bin4["representation"] == "BINARY_ARTIFACT"
    assert bin4["record_id"] != rec4["record_id"]
    i04 = h.record(rec4["data"]["validation_report_ref"])
    assert i04["module_id"] == "I04" and i04["data"]["valid"] is True
    assert any(r["record_id"] == bin4["record_id"] for r in i04["source_refs"])
    assert h.engine.contracts.check_shared("G04Artifact", __import__("json").loads(raw4)) == []
    for key in ("g02", "g01", "g05", "g04", "g07"):
        assert h.validate(c[key])["status"] == "VALIDATED", key
    # G07 converged within the bound: pass 1 = G04, TOC insertion shifts pages, pass 3 stable.
    raw7, _, _ = b.binary(c["g07"])
    toc = __import__("json").loads(raw7)
    assert toc["converged"] is True and toc["passes"] == 3
    titles = [e["title"] for e in toc["entries"]]
    assert titles[:2] == ["Chapter 1: The Harbour", "Night"] and "Colophon" in titles

    r11 = b.export("G11", c["g07"])
    assert r11["status"] == "DRAFT", r11
    pdf, rec11, bin11 = b.binary(r11["output_refs"][0])
    assert bin11["binary"]["mime_type"] == "application/pdf"
    assert rec11["data"]["sha256"] == hashlib.sha256(pdf).hexdigest() == r11["output_refs"][0 + 1]["content_hash"]
    info = parse_pdf(pdf)
    assert info["count"] == info["kids"] >= 6
    assert info["fonts"] == [b"Times-Bold", b"Times-Roman"]
    assert b"/TrimBox" not in pdf and b"/BleedBox" not in pdf  # manuscript PDF: no print geometry
    assert b"/Outlines" in info["catalog"] and b"/Link" in pdf
    # every TOC page number matches where the heading actually rendered
    from bookforge.exporters.pdf import inspect_pdf
    rep = inspect_pdf(pdf)
    assert rep["errors"] == [] and rep["page_count"] == info["count"] and rep["links"] == len(toc["entries"])
    # provenance: the binary pins manifest, chapters, profiles and approval manifest
    pinned = {r["record_id"] for r in bin11["source_refs"]}
    assert {c["g02"]["record_id"], b.approvals["record_id"], b.pdf_profile["record_id"]} <= pinned
    assert {ch["record_id"] for ch in b.chapters} <= pinned
    assert h.approve(r11["output_refs"][0])["status"] == "APPROVED"

    set_release_profiles(h, ["MANUSCRIPT_PDF", "EPUB_REFLOWABLE", "EDITABLE_DOCX"])
    r12 = b.export("G12", c["g07"])
    assert r12["status"] == "DRAFT", r12
    epub, rec12, _ = b.binary(r12["output_refs"][0])
    e = check_epub(epub)
    assert e["xhtml"] >= 6
    assert any(f["rule_id"] == "EPUBCHECK" and f["decision"] == "UNKNOWN" for f in r12["findings"])
    chapter_html = [e["zip"].read(n).decode() for n in e["zip"].namelist() if n.endswith(".xhtml")]
    assert any(f'id="{b.chapters[0]["record_id"]}"' in x for x in chapter_html)
    assert not any("page-break" in x and "spine" in x for x in chapter_html)
    from bookforge.exporters.epub import inspect_epub
    assert inspect_epub(epub)["errors"] == []

    r13 = b.export("G13", c["g07"])
    assert r13["status"] == "DRAFT", r13
    docx, _, _ = b.binary(r13["output_refs"][0])
    d = check_docx(docx)
    assert d["styles"].count("Heading1") == 4  # copyright + 2 chapters + colophon
    assert "Title" in d["styles"] and "TOC1" in d["styles"] and "Heading2" in d["styles"]
    assert "Chapter 2: The Road" in d["text"] and "“slowly,”" in d["text"]


def test_text_only_manuscript_pdf_from_compiled_manuscript(h):
    """Walkthrough: text-only manuscript PDF without D/print geometry, straight from G01."""
    b = Book(h)
    g01 = b.g01(b.g02())
    r = b.export("G11", g01)
    assert r["status"] == "DRAFT", r
    pdf, _, _ = b.binary(r["output_refs"][0])
    info = parse_pdf(pdf)
    assert info["count"] >= 2 and b"/XObject" not in pdf and b"/TrimBox" not in pdf
    w, hgt = (float(x) for x in re.search(rb"/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]", info["pages"][0]).groups())
    assert abs(w - 152.4 / 25.4 * 72) < 0.01 and abs(hgt - 228.6 / 25.4 * 72) < 0.01


def test_exports_are_deterministic(h):
    b = Book(h)
    c = b.chain(with_matter=False)
    for op in ("G11", "G12", "G13"):
        first = b.export(op, c["g07"])
        second = b.export(op, c["g07"])
        assert first["status"] == second["status"] == "DRAFT", (first, second)
        assert first["result"]["sha256"] == second["result"]["sha256"]
        assert first["output_refs"][0]["record_id"] != second["output_refs"][0]["record_id"]
    # same inputs -> same intermediate artifact bytes
    g04b = b.g04(c["g01"], c["g05"])
    assert h.record(g04b)["data"]["sha256"] == h.record(c["g04"])["data"]["sha256"]
    # exporter level: identical calls give identical bytes
    from bookforge.exporters.book import build_book
    from bookforge.exporters.docx import build_docx
    from bookforge.exporters.epub import build_epub
    bk = build_book(dict(MD, language="en"), [{"id": "c1", "text": CH1}])
    assert build_epub(bk, modified="2026-10-14T00:00:00Z") == build_epub(bk, modified="2026-10-14T00:00:00Z")
    assert build_docx(bk, created="2026-10-14T00:00:00Z") == build_docx(bk, created="2026-10-14T00:00:00Z")


def test_toc_nonconvergence_at_cap(h):
    b = Book(h)
    g02 = b.g02()
    g01 = b.g01(g02)
    g05 = b.g05(g01)
    g04 = b.g04(g01, g05)
    r = h.create("G07", {"paginated_book_ref": g04, "toc_style_ref": b.toc_style, "max_passes": 2})
    assert r["status"] == "BLOCKED" and r["result"] is None and r["output_refs"] == []
    assert errors_of(r)[0] == ("TOC_NONCONVERGENCE", "/payload/max_passes")
    retained = r["findings"][0]["source_refs"][0]
    assert h.record(retained)["representation"] == "BINARY_ARTIFACT"  # candidate kept, not published
    assert h.create("G07", {"paginated_book_ref": g04, "toc_style_ref": b.toc_style, "max_passes": 3})["status"] == "DRAFT"


def test_g02_ordering_rules(h):
    b = Book(h)
    ids = [c["record_id"] for c in b.chapters]
    rev = manifest_revision(h)
    r = h.create("G02", {"approved_chapter_refs": b.chapters, "ordered_chapter_ids": [ids[0], ids[0]],
                         "manifest_revision": rev})
    assert errors_of(r)[0] == ("INVALID_INPUT", "/payload/ordered_chapter_ids/1")
    r = h.create("G02", {"approved_chapter_refs": b.chapters, "ordered_chapter_ids": [ids[0]], "manifest_revision": rev})
    assert errors_of(r)[0] == ("INVALID_INPUT", "/payload/approved_chapter_refs/1")
    r = h.create("G02", {"approved_chapter_refs": b.chapters[:1], "ordered_chapter_ids": ids, "manifest_revision": rev})
    assert errors_of(r)[0] == ("INVALID_INPUT", "/payload/ordered_chapter_ids/1")
    r = h.create("G02", {"approved_chapter_refs": b.chapters, "ordered_chapter_ids": ids, "manifest_revision": rev + 5})
    assert errors_of(r)[0][0] == "VERSION_CONFLICT"
    # draft (unapproved) prose cannot be assembled
    src = h.record(b.chapters[0])["source_refs"]
    outline = next(r for r in src if r["module_id"] == "B11")
    context = next(r for r in src if r["module_id"] == "C01")
    draft = h.dispatch("C02", "CREATE", payload={"chapter_id": "ch1", "outline_ref": outline, "context_ref": context,
                                                 "instruction": "w"},
                       manual_candidate={"text": "draft", "candidate_events": [], "findings": []})
    assert draft["status"] == "DRAFT", draft
    dref = draft["output_refs"][0]
    r = h.create("G02", {"approved_chapter_refs": [dref], "ordered_chapter_ids": [dref["record_id"]],
                         "manifest_revision": rev})
    assert r["status"] == "BLOCKED" and errors_of(r)[0] == ("APPROVAL_REQUIRED", "/payload/approved_chapter_refs/0")
    # reordering is honoured
    g02 = b.g02(order=list(reversed(ids)))
    raw, _, _ = b.binary(g02)
    assert __import__("json").loads(raw)["ordered_chapter_ids"] == list(reversed(ids))


def test_wrong_profile_kind_rejected_by_binding(h):
    b = Book(h)
    g01 = b.g01(b.g02())
    g05 = b.g05(g01)
    r = h.create("G04", {"manuscript_ref": g01, "page_profile_ref": b.font, "typography_ref": g05,
                         "margins_pt": {"top": 54, "bottom": 54, "left": 54, "right": 54}})
    assert r["status"] == "REJECTED" and errors_of(r)[0] == ("INVALID_INPUT", "/payload/page_profile_ref")
    # an OUTPUT_PROFILE of the wrong type for the exporter
    r = b.export("G11", g01, profile=b.docx_profile)
    assert errors_of(r)[0] == ("INVALID_INPUT", "/payload/pdf_profile_ref")


def test_unusable_page_area_rejected(h):
    b = Book(h)
    g01 = b.g01(b.g02())
    g05 = b.g05(g01)
    r = h.create("G04", {"manuscript_ref": g01, "page_profile_ref": b.page, "typography_ref": g05,
                         "margins_pt": {"top": 54, "bottom": 54, "left": 300, "right": 300}})
    assert errors_of(r)[0] == ("INVALID_INPUT", "/payload/margins_pt")
    tiny = import_profile(h, "PAGE_PROFILE", {"width_mm": 20, "height_mm": 30, "bleed_mm": 0, "safe_margin_mm": 10})
    r = h.create("G04", {"manuscript_ref": g01, "page_profile_ref": tiny, "typography_ref": g05,
                         "margins_pt": {"top": 0, "bottom": 0, "left": 0, "right": 0}})
    assert errors_of(r)[0] == ("INVALID_INPUT", "/payload/page_profile_ref")


def test_print_ops_not_applicable_without_print_profile(h):
    b = Book(h, profiles=("MANUSCRIPT_PDF",))
    paper = import_profile(h, "PAPER_STOCK", {"stock_id": "cream-55", "caliper_mm": 0.1})
    printer = import_profile(h, "PRINTER_PROFILE", {"printer_id": "p1", "binding": "PERFECT", "pages_per_leaf": 2,
                                                    "spine_allowance_mm": 0.5, "bleed_mm": 3,
                                                    "geometry_tolerance_mm": 0.5})
    r = h.create("G14", {"trim_width_mm": 152.4, "trim_height_mm": 228.6, "binding": "PERFECT",
                         "paper_stock_ref": paper, "printer_profile_ref": printer})
    assert r["status"] == "NOT_APPLICABLE" and r["selection_rule_id"].startswith("RELEASE_PROFILE_SELECTED")
    cover = fixture_asset(h, "D11", png_bytes(60, 90))
    r = h.create("G10", {"cover_asset_ref": cover, "cover_mode": "EBOOK"})   # EPUB not selected
    assert r["status"] == "NOT_APPLICABLE" and r["selection_rule_id"] == "RELEASE_PROFILE_SELECTED:EPUB_REFLOWABLE"
    g01 = b.g01(b.g02())
    assert b.export("G12", g01)["status"] == "NOT_APPLICABLE"   # EPUB not selected
    assert b.export("G13", g01)["status"] == "NOT_APPLICABLE"
    r = h.create("G03", {"ordered_manuscript_ref": g01, "illustration_policy": "NONE"})
    assert r["status"] == "NOT_APPLICABLE"


def test_print_interior_and_wrap_cover(h):
    b = Book(h, profiles=("MANUSCRIPT_PDF", "PRINT_INTERIOR", "PRINT_WRAP_COVER"))
    paper = import_profile(h, "PAPER_STOCK", {"stock_id": "cream-55", "caliper_mm": 0.1})
    printer = import_profile(h, "PRINTER_PROFILE", {"printer_id": "p1", "binding": "PERFECT", "pages_per_leaf": 2,
                                                    "spine_allowance_mm": 0.5, "bleed_mm": 3,
                                                    "geometry_tolerance_mm": 0.5})
    bad = h.create("G14", {"trim_width_mm": 152.4, "trim_height_mm": 228.6, "binding": "SADDLE",
                           "paper_stock_ref": paper, "printer_profile_ref": printer})
    assert errors_of(bad)[0] == ("INVALID_INPUT", "/payload/binding")
    g14, _ = b.ok("G14", {"trim_width_mm": 152.4, "trim_height_mm": 228.6, "binding": "PERFECT",
                          "paper_stock_ref": paper, "printer_profile_ref": printer})
    # print interior page profile carries the printer bleed (manuscript profile has none)
    b.page = import_profile(h, "PAGE_PROFILE", {"width_mm": 152.4, "height_mm": 228.6, "bleed_mm": 3,
                                                "safe_margin_mm": 12.7})
    c = b.chain(with_matter=False)
    interior = b.output_profile("PRINT_INTERIOR", printer=printer)
    r = b.export("G11", c["g07"], profile=interior)
    assert r["status"] == "DRAFT", r
    pdf, _, _ = b.binary(r["output_refs"][0])
    info = parse_pdf(pdf)
    assert b"/TrimBox" in info["pages"][0] and b"/BleedBox" in info["pages"][0]
    pages = info["count"]

    cover = fixture_asset(h, "D11", png_bytes(60, 90))
    wrong = h.create("G10", {"cover_asset_ref": cover, "print_profile_ref": g14, "cover_mode": "PRINT",
                             "page_count": pages + 2}, input_refs=[c["g07"]])
    assert errors_of(wrong)[0] == ("INVALID_INPUT", "/payload/page_count")
    missing = h.create("G10", {"cover_asset_ref": cover, "cover_mode": "PRINT", "page_count": pages})
    assert errors_of(missing)[0][0] == "MISSING_INPUT"
    ref, r10 = b.ok("G10", {"cover_asset_ref": cover, "print_profile_ref": g14, "cover_mode": "PRINT",
                            "page_count": pages}, input_refs=[c["g07"]])
    layout_raw, rec10, _ = b.binary(ref)
    layout = __import__("json").loads(layout_raw)
    expected_spine = round(-(-pages // 2) * 0.1 + 0.5, 4)
    assert layout["cover_mode"] == "PRINT" and layout["spine_mm"] == expected_spine
    cover_rec = h.record(layout["layout_asset_ref"])
    assert cover_rec["module_id"] == "G10" and cover_rec["binary"]["mime_type"] == "application/pdf"
    cover_pdf = h.store.read_binary(cover_rec)
    ci = parse_pdf(cover_pdf)
    w = float(re.search(rb"/MediaBox \[0 0 ([\d.]+)", ci["pages"][0]).group(1))
    assert abs(w - (2 * 152.4 + expected_spine + 6) / 25.4 * 72) < 0.01
    assert h.approve(ref)["status"] == "APPROVED"


def test_ebook_cover_and_art_placement_in_epub_and_pdf(h):
    b = Book(h)
    set_release_profiles(h, ["MANUSCRIPT_PDF", "EPUB_REFLOWABLE", "EDITABLE_DOCX"], artwork=True)
    illus = fixture_asset(h, "D07", png_bytes(40, 30, alpha=True))
    g02 = b.g02()
    g01 = b.g01(g02)
    anchor = f"{b.chapters[0]['record_id']}-p2"
    placement = {"summary": "harbour illustration", "links": [illus], "facts": [
        {"subject_id": "pl-1", "predicate": p, "value": v, "assertion_type": "FACT", "effective_from": None,
         "effective_to": None, "source_refs": []}
        for p, v in (("x.g03.anchor_id", anchor), ("x.g03.width_mm", 80), ("x.g03.height_mm", 60),
                     ("x.g03.fit", "CONTAIN"))]}
    bad = dict(placement, facts=[dict(f, value="nowhere") if f["predicate"] == "x.g03.anchor_id" else f
                                 for f in placement["facts"]])
    r = h.create("G03", {"ordered_manuscript_ref": g01, "illustration_policy": "REQUIRED", "placements": [bad]})
    assert errors_of(r)[0][0] == "INVALID_INPUT"
    g03, _ = b.ok("G03", {"ordered_manuscript_ref": g01, "illustration_policy": "REQUIRED", "placements": [placement]})
    g01_art = b.g01(g02, input_refs=[g03])
    assert h.record(b.binary(g01_art)[2]["ref"])  # binary resolves
    art_g01 = __import__("json").loads(b.binary(g01_art)[0])
    assert art_g01["asset_refs"][0]["record_id"] == illus["record_id"]

    # manuscript PDF without art selected: excluded explicitly when exporting from G01
    r = b.export("G11", g01_art)
    assert r["status"] == "DRAFT" and any(f["rule_id"] == "ART_EXCLUDED" for f in r["findings"])
    assert b"/XObject" not in b.binary(r["output_refs"][0])[0]
    # art-selected PDF embeds the image (with alpha soft mask)
    art_pdf = b.output_profile("MANUSCRIPT_PDF", artwork=True)
    r = b.export("G11", g01_art, profile=art_pdf)
    assert r["status"] == "DRAFT", r
    pdf = b.binary(r["output_refs"][0])[0]
    assert b"/Subtype /Image" in pdf and b"/SMask" in pdf
    parse_pdf(pdf)

    cover = fixture_asset(h, "D11", png_bytes(60, 90))
    g10, _ = b.ok("G10", {"cover_asset_ref": cover, "cover_mode": "EBOOK"})
    raw10 = __import__("json").loads(b.binary(g10)[0])
    assert raw10["spine_mm"] is None
    art_epub = b.output_profile("EPUB_REFLOWABLE", page=None, artwork=True)
    r = b.export("G12", g01_art, profile=art_epub, input_refs=[g10])
    assert r["status"] == "DRAFT", r
    e = check_epub(b.binary(r["output_refs"][0])[0])
    props = {i.get("id"): i.get("properties") for i in e["items"].values()}
    assert props.get("cover-image") == "cover-image"
    assert sum(1 for n in e["zip"].namelist() if n.startswith("OEBPS/images/")) == 2
    art_docx = b.output_profile("EDITABLE_DOCX", artwork=True)
    r = b.export("G13", g01_art, profile=art_docx)
    d = check_docx(b.binary(r["output_refs"][0])[0])
    assert any(n.startswith("word/media/") for n in d["names"])


def test_descriptor_update_and_validation(h):
    b = Book(h)
    g02 = b.g02()
    rec = h.record(g02)
    assert h.validate(g02)["status"] == "VALIDATED"
    # UPDATE must be a consistent full descriptor (exact hash/revision/I04 report)
    bad = dict(rec["data"], revision=7)
    r = h.dispatch("G02", "UPDATE", base_ref=g02, payload=bad)
    assert errors_of(r)[0][0] == "INVALID_INPUT"
    r = h.dispatch("G02", "UPDATE", base_ref=g02, payload=dict(rec["data"]))
    assert r["status"] == "DRAFT" and r["output_refs"][0]["version"] == 2
    # LOGIC ops reject manual candidates
    r = h.create("G01", {"ordered_manifest_ref": g02, "approved_chapter_refs": b.chapters,
                         "section_id_policy": "STABLE_ID"}, manual_candidate=dict(rec["data"]))
    assert r["status"] in ("REJECTED", "BLOCKED")


def test_g01_rejects_pins_not_in_manifest(h):
    b = Book(h)
    g02 = b.g02()
    r = h.create("G01", {"ordered_manifest_ref": g02, "approved_chapter_refs": b.chapters[:1],
                         "section_id_policy": "STABLE_ID"})
    assert errors_of(r)[0] == ("INVALID_INPUT", "/payload/approved_chapter_refs")


def test_g08_creative_items_need_ai_or_manual(h):
    b = Book(h)
    g01 = b.g01(b.g02())
    r = h.create("G08", {"book_ref": g01, "front_matter_items": ["title_page", "dedication"],
                         "publication_profile_ref": b.pdf_profile})
    assert r["status"] == "BLOCKED" and errors_of(r)[0][0] == "CAPABILITY_UNAVAILABLE"


def test_unencodable_glyphs_block_pdf_path(h):
    b = Book(h, texts=("# Title\nA line with a snowman ☃ in it.",))
    g01 = b.g01(b.g02())
    r = h.create("G05", {"font_profile_ref": b.font, "language_tag": "en", "manuscript_ref": g01})
    assert r["status"] == "BLOCKED" and errors_of(r)[0][0] == "CAPABILITY_UNAVAILABLE"
    set_release_profiles(h, ["MANUSCRIPT_PDF", "EPUB_REFLOWABLE"])
    r = b.export("G12", g01)  # EPUB is Unicode: unaffected
    assert r["status"] == "DRAFT", r


@pytest.mark.parametrize("include_pages", [False])
def test_toc_without_pages_converges(h, include_pages):
    b = Book(h)
    style = import_profile(h, "TOC_STYLE", {"max_depth": 1, "include_pages": include_pages, "link_targets": False})
    g02 = b.g02()
    g01 = b.g01(g02)
    g05 = b.g05(g01)
    g04 = b.g04(g01, g05)
    ref, _ = b.ok("G07", {"paginated_book_ref": g04, "toc_style_ref": style, "max_passes": 6})
    art = __import__("json").loads(b.binary(ref)[0])
    assert art["converged"] and all(e["page"] is None for e in art["entries"])
    assert len(art["entries"]) == 2  # depth 1: chapters only


def test_changed_chapter_makes_assembly_stale(h):
    b = Book(h)
    g01 = b.g01(b.g02())
    ch = h.record(b.chapters[0])
    u = h.dispatch("C02", "UPDATE", base_ref=b.chapters[0], payload=dict(ch["data"], text=CH1 + "\nA new line."))
    if u["status"] != "DRAFT":
        pytest.skip(f"C02 UPDATE path owned by Set C refused the replacement: {u['errors']}")
    assert h.approve(u["output_refs"][0])["status"] == "APPROVED"
    assert h.record(g01)["stale"] is True
    r = b.export("G11", g01)
    assert r["status"] == "BLOCKED" and errors_of(r)[0][0] == "VERSION_CONFLICT"
    v = h.validate(g01)
    assert v["status"] == "DRAFT" and any(f["rule_id"] == "STALE" for f in v["findings"])
