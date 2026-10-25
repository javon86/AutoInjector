"""Set H (final QC) tests: deterministic parsers, report handlers and the H10 release gate.

Upstream G/C/B/A/K records are inserted directly with evidence_origin="FIXTURE" through a
store transaction (the G exporters and other modules are developed independently). Such
fixtures are valid for isolated tests only: H10 marks them FIXTURE_EVIDENCE and the release
approval gate refuses them, exactly as production approval must. I01 profiles/manifests are
imported through dispatch (the kernel-owned bootstrap path) so they are authoritative.
"""
from __future__ import annotations

import io
import json
import uuid
import zipfile
import zlib
from datetime import datetime, timedelta, timezone

import pytest

from conftest import PRINCIPAL, errors_of
from test_set_i01 import import_profile

from bookforge import h_checks as hc
from bookforge.canonical import sha256_text

PDF_MIME = "application/pdf"
EPUB_MIME = "application/epub+zip"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
FUTURE = (datetime.now(timezone.utc) + timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")


# ====================================================================== byte builders
def build_pdf(pages, *, dests=None, widths=True, bbox=True, embedded=True, mediabox=(0, 0, 432, 648),
              trimbox=None, links=None, compress=False, xref_stream=False, break_xref=False, outline=None):
    """Small but real PDF writer. pages: content stream bytes; dests: {name: page_index0}."""
    objs: dict[int, bytes] = {}
    n = len(pages)
    page_ids = [10 + 2 * i for i in range(n)]
    objs[1] = (b"<< /Type /Catalog /Pages 2 0 R" + (b" /Names << /Dests 6 0 R >>" if dests else b"")
               + (b" /Outlines 7 0 R" if outline else b"") + b" >>")
    kids = b" ".join(b"%d 0 R" % p for p in page_ids)
    objs[2] = b"<< /Type /Pages /Kids [%s] /Count %d /MediaBox [%s] >>" % (
        kids, n, " ".join(map(str, mediabox)).encode())
    font = b"<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+BookSerif"
    if widths:
        font += b" /FirstChar 32 /LastChar 126 /Widths [" + b" ".join([b"500"] * 95) + b"]"
    font += b" /FontDescriptor 4 0 R >>"
    objs[3] = font
    desc = b"<< /Type /FontDescriptor /FontName /ABCDEF+BookSerif /Flags 32"
    if bbox:
        desc += b" /FontBBox [-200 -250 1000 900]"
    if embedded:
        desc += b" /FontFile2 5 0 R"
    objs[4] = desc + b" >>"
    objs[5] = b"<< /Length 4 >>\nstream\nFONT\nendstream"
    if dests:
        arr = b" ".join(b"(%s) [%d 0 R /XYZ 0 600 0]" % (k.encode(), page_ids[v]) for k, v in sorted(dests.items()))
        objs[6] = b"<< /Names [" + arr + b"] >>"
    if outline:
        items = list(outline.items())
        first = 8
        objs[7] = b"<< /Type /Outlines /First %d 0 R /Last %d 0 R /Count %d >>" % (first, first + len(items) - 1,
                                                                                   len(items))
        for j, (name, title) in enumerate(items):
            nxt = b" /Next %d 0 R" % (first + j + 1) if j + 1 < len(items) else b""
            objs[first + j] = b"<< /Title (%s) /Parent 7 0 R /Dest (%s)%s >>" % (title.encode(), name.encode(), nxt)
    for i, c in enumerate(pages):
        pid, cid = page_ids[i], page_ids[i] + 1
        extra = b""
        if trimbox:
            extra += b" /TrimBox [%s]" % " ".join(map(str, trimbox)).encode()
        if links and i in links:
            extra += b" /Annots [<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /Dest (%s) >>]" % links[i].encode()
        objs[pid] = b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R%s >>" % (
            cid, extra)
        data = zlib.compress(c) if compress else c
        objs[cid] = (b"<< /Length %d%s >>\nstream\n" % (len(data), b" /Filter /FlateDecode" if compress else b"")
                     + data + b"\nendstream")
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for k in sorted(objs):
        offsets[k] = len(out)
        out += b"%d 0 obj\n" % k + objs[k] + b"\nendobj\n"
    size = max(objs) + 2
    xref = len(out)
    if xref_stream:
        xid = size - 1
        offsets[xid] = xref
        rows = b"".join(
            (b"\x01" + offsets[k].to_bytes(4, "big") + b"\x00\x00") if k in offsets else b"\x00" * 7
            for k in range(size))
        out += (b"%d 0 obj\n<< /Type /XRef /Size %d /W [1 4 2] /Root 1 0 R /Length %d >>\nstream\n" % (
            xid, size, len(rows)) + rows + b"\nendstream\nendobj\n")
    else:
        out += b"xref\n0 %d\n0000000000 65535 f \n" % size
        for k in range(1, size):
            if k in offsets:
                out += b"%010d 00000 n \n" % (offsets[k] + (7 if break_xref and k == 2 else 0))
            else:
                out += b"0000000000 00000 f \n"
        out += b"trailer\n<< /Size %d /Root 1 0 R >>\n" % size
    out += b"startxref\n%d\n%%%%EOF\n" % xref
    return bytes(out)


def text_page(*lines, x=72, y=560, size=11):
    ops = [b"BT /F1 %d Tf %d %d Td 14 TL" % (size, x, y)]
    for ln in lines:
        ops.append(b"(%s) Tj T*" % ln.encode())
    ops.append(b"ET")
    return b"\n".join(ops)


def good_pdf(**kw):
    return build_pdf([text_page("Chapter One", "It was a cold morning."),
                      text_page("Chapter Two", "The river froze.")],
                     dests={"ch-1": 0, "ch-2": 1}, links={0: "ch-2"}, **kw)


XHTML = ('<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" '
         'xmlns:epub="http://www.idpf.org/2007/ops"><head><title>{t}</title></head><body>{b}</body></html>')


def build_epub(*, mimetype_first=True, compress_mimetype=False, nav=True, missing_file=False, broken_link=False,
               container=True):
    buf = io.BytesIO()
    z = zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED)

    def add_mimetype():
        z.writestr(zipfile.ZipInfo("mimetype"), b"application/epub+zip",
                   compress_type=zipfile.ZIP_DEFLATED if compress_mimetype else zipfile.ZIP_STORED)

    if mimetype_first:
        add_mimetype()
    if container:
        z.writestr("META-INF/container.xml",
                   '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:'
                   'container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/'
                   'oebps-package+xml"/></rootfiles></container>')
    items = ['<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>',
             '<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>']
    if nav:
        items.append('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>')
    if missing_file:
        items.append('<item id="img" href="images/cover.png" media-type="image/png"/>')
    z.writestr("OEBPS/content.opf",
               '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
               'unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
               '<dc:identifier id="uid">urn:uuid:1234</dc:identifier><dc:title>Test Book</dc:title>'
               '<dc:language>en</dc:language></metadata><manifest>' + "".join(items) + '</manifest>'
               '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>')
    link = '<a href="ch2.xhtml#ch-2">next</a>' if not broken_link else '<a href="ch2.xhtml#nowhere">next</a>'
    z.writestr("OEBPS/ch1.xhtml", XHTML.format(t="One", b=f'<h1 id="ch-1">Chapter One</h1><p>Cold. {link}</p>'))
    z.writestr("OEBPS/ch2.xhtml", XHTML.format(t="Two", b='<h1 id="ch-2">Chapter Two</h1><p>River.</p>'))
    if nav:
        z.writestr("OEBPS/nav.xhtml", XHTML.format(
            t="Contents", b='<nav epub:type="toc"><ol><li><a href="ch1.xhtml#ch-1">Chapter One</a></li>'
                            '<li><a href="ch2.xhtml#ch-2">Chapter Two</a></li></ol></nav>'))
    if not mimetype_first:
        add_mimetype()
    z.close()
    return buf.getvalue()


def build_docx(*, content_types=True, broken_rel=False, malformed=False, margins=1440, bookmarks=("ch-1", "ch-2")):
    buf = io.BytesIO()
    z = zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED)
    if content_types:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-'
                   'officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr("_rels/.rels",
               '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
               'relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
               'relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    rels = '<Relationship Id="rId9" Type="http://x/styles" Target="styles.xml"/>' if broken_rel else ""
    z.writestr("word/_rels/document.xml.rels",
               '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
               f'relationships">{rels}</Relationships>')
    w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    body = "".join(f'<w:p><w:bookmarkStart w:id="{i}" w:name="{b}"/><w:r><w:t>Chapter {i}</w:t></w:r>'
                   f'<w:bookmarkEnd w:id="{i}"/></w:p>' for i, b in enumerate(bookmarks))
    sect = (f'<w:sectPr><w:pgSz w:w="8640" w:h="12960"/><w:pgMar w:top="{margins}" w:bottom="{margins}" '
            f'w:left="{margins}" w:right="{margins}"/></w:sectPr>')
    doc = f'<?xml version="1.0"?><w:document {w}><w:body>{body}{sect}</w:body></w:document>'
    z.writestr("word/document.xml", doc[:-20] if malformed else doc)
    z.close()
    return buf.getvalue()


# ====================================================================== fixtures
def fx_json(h, module_id, data, *, record_kind="OUTPUT", source_refs=(), approved=False, origin="FIXTURE"):
    rid = f"{module_id}-fx-{uuid.uuid4().hex[:10]}"
    with h.store.transaction() as tx:
        ref = tx.insert_json_record(project_id=h.project_id, branch_id=h.branch_id, module_id=module_id,
                                    record_id=rid, version=1, data=data, source_refs=list(source_refs),
                                    principal_id=PRINCIPAL, record_kind=record_kind, evidence_origin=origin)
        if approved:
            tx.set_lifecycle(ref, "APPROVED")
            tx.set_approved_head(ref)
    return ref


def fx_binary(h, module_id, data: bytes, mime: str):
    rid = f"{module_id}-bin-{uuid.uuid4().hex[:10]}"
    with h.store.transaction() as tx:
        return tx.insert_binary_record(project_id=h.project_id, branch_id=h.branch_id, module_id=module_id,
                                       record_id=rid, version=1, data=data, mime_type=mime, source_refs=[],
                                       principal_id=PRINCIPAL, evidence_origin="FIXTURE")


def fx_descriptor(h, module_id, data: bytes, mime: str, *, valid=True):
    """G descriptor -> distinct binary record + I04 staged validation (the Set G commit shape)."""
    b = fx_binary(h, module_id, data, mime)
    i04 = fx_json(h, "I04", {"valid": valid, "violations": [], "schema_version": "fixture"}, source_refs=[b])
    return fx_json(h, module_id, {"artifact_ref": b, "revision": 1, "sha256": b["content_hash"],
                                  "validation_report_ref": i04})


def fx_json_artifact(h, module_id, obj):
    return fx_descriptor(h, module_id, json.dumps(obj).encode(), "application/json")


def prose(h, text):
    return fx_json(h, "C02", {"text": text, "candidate_events": [], "findings": []}, approved=True)


def k09(h, pins, decision="APPROVED", expiry=FUTURE):
    return fx_json(h, "K09", {"approval_id": f"appr-{uuid.uuid4().hex[:8]}", "decision": decision, "expiry": expiry},
                   source_refs=pins)


def imported(h, kind, data, approve=True):
    r = import_profile(h, kind, data)
    assert r["status"] == "DRAFT", r
    ref = r["output_refs"][0]
    if approve:
        assert h.approve(ref)["status"] == "APPROVED"
    return ref


CH1 = ("It was a cold morning when the ferry left the harbour without its captain.\n\n"
       "Mara counted the lanterns twice and found one missing from the bow rail.")
CH2 = ("The river froze overnight, and the town woke to a white silence over the water.\n\n"
       "Nobody spoke of the captain again until the thaw came in late spring.")


class Book:
    """A small PDF-only book: two chapters, G02/G01, G04/G07, G11 export, profiles and manifest."""

    def __init__(self, h, *, pdf=None, required_checks=("H05", "H07", "H08", "H09"), profile_type="MANUSCRIPT_PDF",
                 artwork=False, extra_exports=(), auth=True):
        self.h = h
        self.c1, self.c2 = prose(h, CH1), prose(h, CH2)
        self.g02 = fx_json_artifact(h, "G02", {"ordered_chapter_ids": ["ch-1", "ch-2"],
                                               "chapter_refs": [self.c1, self.c2], "manifest_revision": 1})
        self.g01 = fx_json_artifact(h, "G01", {"sections": [{"section_id": "ch-1", "chapter_ref": self.c1},
                                                            {"section_id": "ch-2", "chapter_ref": self.c2}],
                                               "matter_refs": [], "asset_refs": [], "source_manifest_ref": self.g02})
        self.font_bin = fx_binary(h, "G05", b"FONTBYTES", "font/ttf")
        self.page = imported(h, "PAGE_PROFILE", {"width_mm": 152.4, "height_mm": 228.6, "bleed_mm": 0,
                                                 "safe_margin_mm": 15})
        self.font = imported(h, "FONT_PROFILE", {"font_refs": [self.font_bin], "embedding_permitted": True,
                                                 "fallback_names": [], "font_size_pt": 11, "line_height_pt": 14,
                                                 "language_tag": "en"})
        self.profile = imported(h, "OUTPUT_PROFILE", {
            "profile_id": "pdf-1", "profile_type": profile_type, "required_checks": list(required_checks),
            "required_export_operations": ["G11"] if profile_type != "EPUB_REFLOWABLE" else ["G12"],
            "artwork_selected": artwork, "language_tag": "en",
            "metadata": {"title": "Test Book", "author": "A. Author", "identifier": "urn:x", "rights": "(c)"},
            "printer_profile_ref": None,
            "page_profile_ref": None if profile_type == "EPUB_REFLOWABLE" else self.page,
            "font_profile_ref": self.font})
        self.g04 = fx_json_artifact(h, "G04", {"page_count": 2, "heading_pages": [
            {"heading_id": "h-1", "page": 1}, {"heading_id": "h-2", "page": 2}], "source_ref": self.g01,
            "profile_ref": self.profile, "typography_ref": self.font})
        self.g07 = fx_json_artifact(h, "G07", {"entries": [
            {"heading_id": "h-1", "title": "Chapter One", "page": 1, "anchor_id": "ch-1"},
            {"heading_id": "h-2", "title": "Chapter Two", "page": 2, "anchor_id": "ch-2"}],
            "pagination_ref": self.g04, "converged": True, "passes": 2})
        self.pdf_bytes = pdf if pdf is not None else good_pdf()
        self.g11 = fx_descriptor(h, "G11", self.pdf_bytes, PDF_MIME)
        self.exports = [self.g11] + list(extra_exports)
        self.feature = fx_json(h, "K02", {"scheduled_jobs": [], "blocked_jobs": []})
        self.sources = [self.g01, self.g02, self.g07]
        self.auth = k09(h, self.exports + self.sources) if auth else None
        self.manifest = imported(h, "RELEASE_MANIFEST", self.manifest_data(), approve=True)

    def manifest_data(self):
        return {"feature_manifest_ref": self.feature, "source_refs": self.sources, "export_refs": self.exports,
                "profile_refs": [self.profile], "report_refs": [], "policy_ref": self.profile,
                "publication_authorization_ref": self.auth}


def create(h, op, payload, **kw):
    r = h.create(op, payload, **kw)
    assert r["status"] in ("DRAFT", "NOT_APPLICABLE"), r
    return r


def statuses(resp):
    return resp["result"]["status"]


def rules(resp, decision=None):
    return {f["rule_id"] for f in resp["result"]["findings"] if decision is None or f["decision"] == decision}


@pytest.fixture(autouse=True)
def _no_external_validators():
    saved = dict(hc.EXTERNAL_VALIDATORS)
    hc.EXTERNAL_VALIDATORS.clear()
    hc.EXTERNAL_VALIDATORS["epubcheck"] = lambda data: None  # tool absent unless a test installs one
    yield
    hc.EXTERNAL_VALIDATORS.clear()
    hc.EXTERNAL_VALIDATORS.update(saved)


# ====================================================================== h_checks: PDF
def test_pdf_structure_valid_and_navigation():
    for kw in ({}, {"compress": True}, {"xref_stream": True}):
        data = good_pdf(**kw)
        doc, issues = hc.pdf_structure(data)
        assert doc is not None and [i["decision"] for i in issues] == ["PASS"], (kw, issues)
        assert hc.pdf_named_destinations(doc) == {"ch-1": 1, "ch-2": 2}
        assert [(p, hc.pdf_text(d)) for p, d in hc.pdf_internal_links(doc)] == [(1, "ch-2")]


@pytest.mark.parametrize("mutate,rule", [
    (lambda b: b.replace(b"%PDF-1.7", b"%XYZ-1.7"), "PDF_STRUCTURE"),
    (lambda b: b[:-7], "PDF_STRUCTURE"),                                   # %%EOF removed
    (lambda b: b[: len(b) // 2], "PDF_STRUCTURE"),                         # truncated
    (lambda b: b.replace(b"/Type /Catalog", b"/Type /Catalox"), "PDF_STRUCTURE"),
])
def test_pdf_structure_invalid(mutate, rule):
    doc, issues = hc.pdf_structure(mutate(good_pdf()))
    assert any(i["rule"] == rule and i["decision"] == "FAIL" for i in issues), issues


def test_pdf_broken_xref_offset():
    _, issues = hc.pdf_structure(good_pdf(break_xref=True))
    assert any(i["rule"] == "PDF_XREF_OFFSET" for i in issues)
    assert not any(i["decision"] == "PASS" for i in issues)


PAGE = {"width_mm": 152.4, "height_mm": 228.6, "bleed_mm": 0, "safe_margin_mm": 15}


def test_pdf_layout_pass_and_crossing():
    ok = hc.pdf_layout(good_pdf(), PAGE, print_profile=False)
    assert {i["rule"] for i in ok} == {"PAGE_SIZE", "SAFE_MARGIN"} and all(i["decision"] == "PASS" for i in ok)
    bad = build_pdf([text_page("ok"), text_page("This line starts in the margin", x=10)])
    issues = [i for i in hc.pdf_layout(bad, PAGE, print_profile=False) if i["decision"] == "FAIL"]
    assert len(issues) == 1 and issues[0]["rule"] == "SAFE_MARGIN" and issues[0]["message"].startswith("page 2:")
    assert "[10.0" in issues[0]["message"]


def test_pdf_layout_size_and_unverifiable_metrics():
    wrong = build_pdf([text_page("x")], mediabox=(0, 0, 612, 792))
    assert any(i["rule"] == "PAGE_SIZE" and i["decision"] == "FAIL" for i in hc.pdf_layout(wrong, PAGE,
                                                                                           print_profile=False))
    long_line = "word " * 70
    no_metrics = build_pdf([text_page(long_line)], widths=False, bbox=False)
    issues = hc.pdf_layout(no_metrics, PAGE, print_profile=False)
    assert any(i["rule"] == "SAFE_MARGIN_UNVERIFIED" and i["decision"] == "UNKNOWN" for i in issues)
    exact = build_pdf([text_page(long_line)])
    assert any(i["rule"] == "SAFE_MARGIN" and i["decision"] == "FAIL" for i in hc.pdf_layout(exact, PAGE,
                                                                                             print_profile=False))


def test_pdf_layout_bleed_and_trimbox():
    bleed = dict(PAGE, bleed_mm=3.175)  # 9pt
    data = build_pdf([text_page("x", x=80)], mediabox=(0, 0, 450, 666), trimbox=(9, 9, 441, 657))
    assert all(i["decision"] == "PASS" for i in hc.pdf_layout(data, bleed, print_profile=True))
    no_bleed = build_pdf([text_page("x", x=80)], mediabox=(0, 0, 432, 648), trimbox=(0, 0, 432, 648))
    assert any(i["rule"] == "PAGE_BLEED" for i in hc.pdf_layout(no_bleed, bleed, print_profile=True))


# ====================================================================== h_checks: EPUB / DOCX
def test_epub_valid_requires_epubcheck():
    issues, info = hc.epub_check(build_epub())
    assert {i["rule"] for i in issues if i["decision"] != "PASS"} == {"VALIDATOR_UNAVAILABLE"}
    assert [f for _, f, _ in info.nav_links] == ["ch-1", "ch-2"] and "ch-2" in info.ids["OEBPS/ch2.xhtml"]
    hc.EXTERNAL_VALIDATORS["epubcheck"] = lambda data: (True, "epubcheck-fake 0", [])
    issues, info = hc.epub_check(build_epub())
    assert all(i["decision"] == "PASS" for i in issues) and info.validator == "epubcheck-fake 0"
    hc.EXTERNAL_VALIDATORS["epubcheck"] = lambda data: (False, "epubcheck-fake 0", ["ERROR(RSC-005): bad"])
    issues, _ = hc.epub_check(build_epub())
    assert any(i["rule"] == "EPUBCHECK" and i["decision"] == "FAIL" for i in issues)


@pytest.mark.parametrize("kw,rule", [
    ({"mimetype_first": False}, "EPUB_MIMETYPE_FIRST"),
    ({"compress_mimetype": True}, "EPUB_MIMETYPE_STORED"),
    ({"container": False}, "EPUB_CONTAINER"),
    ({"missing_file": True}, "EPUB_MANIFEST_MISSING_FILE"),
    ({"nav": False}, "EPUB_NAV"),
    ({"broken_link": True}, "EPUB_BROKEN_LINK"),
])
def test_epub_invalid(kw, rule):
    issues, _ = hc.epub_check(build_epub(**kw), run_external=False)
    assert any(i["rule"] == rule and i["decision"] == "FAIL" for i in issues), issues


def test_epub_not_a_zip():
    issues, _ = hc.epub_check(b"PK\x03\x04garbage")
    assert issues[0]["decision"] == "FAIL"


def test_docx_valid_and_invalid():
    issues, info = hc.docx_check(build_docx())
    assert all(i["decision"] == "PASS" for i in issues) and info.bookmarks == {"ch-1", "ch-2"}
    assert info.sections == [{"w": 8640, "h": 12960, "top": 1440, "bottom": 1440, "left": 1440, "right": 1440}]
    for kw, rule in (({"content_types": False}, "DOCX_CONTENT_TYPES"), ({"broken_rel": True}, "DOCX_RELS"),
                     ({"malformed": True}, "XML_WELL_FORMED")):
        issues, _ = hc.docx_check(build_docx(**kw))
        assert any(i["rule"] == rule and i["decision"] == "FAIL" for i in issues), (kw, issues)
    assert all(i["decision"] == "PASS" for i in hc.docx_layout(build_docx(), PAGE))
    assert any(i["rule"] == "SAFE_MARGIN" for i in hc.docx_layout(build_docx(margins=200), PAGE))


# ====================================================================== H09
def test_h09_pdf_pass_validates_and_replays(h):
    b = Book(h)
    payload = {"export_refs": [b.g11], "expected_manifest_ref": b.manifest}
    r = create(h, "H09", payload, idempotency_key="h09-key")
    out = r["result"]
    assert out["status"] == "PASS", out["findings"]
    assert out["operation"] == "H09" and out["result_revision"] == 1 and out["policy_ref"] == b.manifest
    assert out["source_refs"] == [b.g11, b.manifest]
    assert any(c["record_id"] == h.record(b.g11)["data"]["artifact_ref"]["record_id"] for c in out["coverage_refs"])
    assert h.validate(r["output_refs"][0])["status"] == "VALIDATED"
    # duplicate delivery returns the same logical result; changed payload under the key conflicts
    again = h.create("H09", payload, idempotency_key="h09-key")
    assert again["output_refs"] == r["output_refs"]
    clash = h.create("H09", {"export_refs": [b.g11, b.g11], "expected_manifest_ref": b.manifest},
                     idempotency_key="h09-key")
    assert errors_of(clash)[0][0] == "IDEMPOTENCY_CONFLICT"
    # permission denial: an unknown principal mutates nothing
    denied = h.dispatch("H09", "CREATE", payload=payload, principal="intruder")
    assert denied["status"] == "REJECTED" and errors_of(denied)[0][0] == "PERMISSION_DENIED"


def test_h09_detects_tampered_bytes_and_stale_validation(h):
    b = Book(h)
    r = create(h, "H09", {"export_refs": [b.g11], "expected_manifest_ref": b.manifest})
    assert statuses(r) == "PASS"
    binrec = h.record(h.record(b.g11)["data"]["artifact_ref"])
    path = h.store.asset_dir / binrec["binary"]["storage_uri"].split("/")[-1]
    raw = bytearray(path.read_bytes())
    raw[-30] ^= 0x01
    path.write_bytes(bytes(raw))
    v = h.validate(r["output_refs"][0])
    assert v["status"] == "DRAFT" and any(f["rule_id"] in ("RERUN_MISMATCH", "RERUN_INPUT") for f in v["findings"])
    r2 = create(h, "H09", {"export_refs": [b.g11], "expected_manifest_ref": b.manifest})
    assert statuses(r2) == "FAIL" and "INPUT" in rules(r2, "FAIL")


def test_h09_manifest_coverage_and_descriptor_checks(h):
    b = Book(h)
    other = fx_descriptor(h, "G11", good_pdf(compress=True), PDF_MIME)
    r = create(h, "H09", {"export_refs": [other], "expected_manifest_ref": b.manifest})
    assert statuses(r) == "FAIL"
    assert {"EXPORT_NOT_IN_MANIFEST", "EXPORT_NOT_CHECKED"} <= rules(r, "FAIL")
    # descriptor whose sha256 disagrees with its artifact pin
    bin_ref = fx_binary(h, "G11", good_pdf(), PDF_MIME)
    i04 = fx_json(h, "I04", {"valid": True, "violations": [], "schema_version": "x"}, source_refs=[bin_ref])
    liar = fx_json(h, "G11", {"artifact_ref": bin_ref, "revision": 1, "sha256": "0" * 64,
                              "validation_report_ref": i04})
    r = create(h, "H09", {"export_refs": [liar], "expected_manifest_ref": b.manifest})
    assert "SHA256_MISMATCH" in rules(r, "FAIL")
    # wrong MIME and failed staged validation
    wrong = fx_descriptor(h, "G11", good_pdf(), "application/octet-stream", valid=False)
    r = create(h, "H09", {"export_refs": [wrong], "expected_manifest_ref": b.manifest})
    assert {"MIME_MISMATCH", "STAGED_VALIDATION"} <= rules(r, "FAIL")
    # broken PDF bytes
    broken = fx_descriptor(h, "G11", good_pdf()[:300], PDF_MIME)
    r = create(h, "H09", {"export_refs": [broken], "expected_manifest_ref": b.manifest})
    assert "PDF_STRUCTURE" in rules(r, "FAIL")


def test_h09_epub_unknown_without_epubcheck_and_docx(h):
    b = Book(h)
    epub = fx_descriptor(h, "G12", build_epub(), EPUB_MIME)
    docx = fx_descriptor(h, "G13", build_docx(), DOCX_MIME)
    man = imported(h, "RELEASE_MANIFEST", dict(b.manifest_data(), export_refs=[b.g11, epub, docx]))
    payload = {"export_refs": [b.g11, epub, docx], "expected_manifest_ref": man}
    r = create(h, "H09", payload)
    # BF-22: without EPUBCheck the EPUB is still checked here; the report says plainly that the official check
    # did not run (MINOR UNKNOWN) instead of holding every release at UNKNOWN forever.
    assert statuses(r) == "PASS" and "VALIDATOR_UNAVAILABLE" in rules(r, "UNKNOWN")
    f = next(f for f in r["result"]["findings"] if f["rule_id"] == "VALIDATOR_UNAVAILABLE")
    assert f["severity"] == "MINOR" and "not checked by EPUBCheck" in f["message"] and "epubcheck.jar" in f["message"]
    assert "epubcheck=unavailable" in r["result"]["checker_version"]
    hc.EXTERNAL_VALIDATORS["epubcheck"] = lambda data: (True, "epubcheck-fake 0", [])
    r = create(h, "H09", payload)
    assert statuses(r) == "PASS", r["result"]["findings"]
    bad_docx = fx_descriptor(h, "G13", build_docx(broken_rel=True), DOCX_MIME)
    man2 = imported(h, "RELEASE_MANIFEST", dict(b.manifest_data(), export_refs=[bad_docx]))
    r = create(h, "H09", {"export_refs": [bad_docx], "expected_manifest_ref": man2})
    assert statuses(r) == "FAIL" and "DOCX_RELS" in rules(r, "FAIL")


def test_h09_print_profile_requires_embedded_fonts(h):
    b = Book(h, pdf=good_pdf(embedded=False))
    r = create(h, "H09", {"export_refs": [b.g11], "expected_manifest_ref": b.manifest})
    f = [x for x in r["result"]["findings"] if x["rule_id"] == "FONT_NOT_EMBEDDED"]
    assert f and f[0]["severity"] == "MINOR" and statuses(r) == "PASS"  # manuscript PDF: visible, nonblocking


# ====================================================================== H05
def test_h05_pass_and_defects(h):
    b = Book(h)
    r = create(h, "H05", {"manuscript_ref": b.g01, "chapter_manifest_ref": b.g02})
    assert statuses(r) == "PASS", r["result"]["findings"]
    assert {b.c1["record_id"], b.c2["record_id"]} <= {c["record_id"] for c in r["result"]["coverage_refs"]}
    assert h.validate(r["output_refs"][0])["status"] == "VALIDATED"
    # missing + reordered + duplicate section
    c3 = prose(h, "A third chapter that the manifest selects but the manuscript forgot to include at all.")
    g02 = fx_json_artifact(h, "G02", {"ordered_chapter_ids": ["ch-1", "ch-2", "ch-3"],
                                      "chapter_refs": [b.c1, b.c2, c3], "manifest_revision": 2})
    g01 = fx_json_artifact(h, "G01", {"sections": [{"section_id": "ch-2", "chapter_ref": b.c2},
                                                   {"section_id": "ch-1", "chapter_ref": b.c1},
                                                   {"section_id": "ch-1", "chapter_ref": b.c1}],
                                      "matter_refs": [], "asset_refs": [], "source_manifest_ref": g02})
    r = create(h, "H05", {"manuscript_ref": g01, "chapter_manifest_ref": g02})
    assert statuses(r) == "FAIL"
    assert {"MISSING_CHAPTER", "ORDER_MISMATCH", "DUPLICATE_SECTION"} <= rules(r, "FAIL")
    # two distinct chapter records with identical text
    dup = prose(h, CH1)
    g02 = fx_json_artifact(h, "G02", {"ordered_chapter_ids": ["ch-1", "ch-2", "ch-3"],
                                      "chapter_refs": [b.c1, b.c2, dup], "manifest_revision": 3})
    g01 = fx_json_artifact(h, "G01", {"sections": [{"section_id": "ch-1", "chapter_ref": b.c1},
                                                   {"section_id": "ch-2", "chapter_ref": b.c2},
                                                   {"section_id": "ch-3", "chapter_ref": dup}],
                                      "matter_refs": [], "asset_refs": [], "source_manifest_ref": g02})
    r = create(h, "H05", {"manuscript_ref": g01, "chapter_manifest_ref": g02})
    assert rules(r, "FAIL") >= {"DUPLICATE_CHAPTER_TEXT"} and "CHAPTER_SET" in rules(r, "PASS")


def test_h05_repeated_paragraph_and_manifest_mismatch(h):
    para = "The lighthouse keeper wrote the same line in his log every night without fail."
    c1 = prose(h, f"{para}\n\n{para}\n\nThen the storm came.")
    c2 = prose(h, "A different chapter entirely, about the harbour and its quiet winter boats.")
    g02 = fx_json_artifact(h, "G02", {"ordered_chapter_ids": ["a", "b"], "chapter_refs": [c1, c2],
                                      "manifest_revision": 1})
    other = fx_json_artifact(h, "G02", {"ordered_chapter_ids": ["a"], "chapter_refs": [c1], "manifest_revision": 9})
    g01 = fx_json_artifact(h, "G01", {"sections": [{"section_id": "a", "chapter_ref": c1},
                                                   {"section_id": "b", "chapter_ref": c2}],
                                      "matter_refs": [], "asset_refs": [], "source_manifest_ref": other})
    r = create(h, "H05", {"manuscript_ref": g01, "chapter_manifest_ref": g02})
    f = [x for x in r["result"]["findings"] if x["rule_id"] == "REPEATED_BLOCK"][0]
    text = h.record(c1)["data"]["text"]
    ev = f["evidence"][1]
    assert text[ev["start"]:ev["end"]] == para and ev["text_hash"] == sha256_text(para)
    assert "MANUSCRIPT_MANIFEST_MISMATCH" in rules(r, "FAIL") and statuses(r) == "FAIL"


def test_h05_deterministic_update_cannot_override(h):
    c1 = prose(h, "Only chapter.")
    g02 = fx_json_artifact(h, "G02", {"ordered_chapter_ids": ["a", "b"], "chapter_refs": [c1, c1],
                                      "manifest_revision": 1})
    r = create(h, "H05", {"manuscript_ref": c1, "chapter_manifest_ref": g02})
    assert statuses(r) == "FAIL"
    forged = copy_out(r)
    forged["findings"] = [f for f in forged["findings"] if f["decision"] == "PASS"] or [
        {"id": "x", "rule_id": "CHAPTER_SET", "severity": "INFO", "decision": "PASS", "message": "ok",
         "evidence": [], "source_refs": [], "confidence": None}]
    forged["status"], forged["result_revision"] = "PASS", 2
    up = h.dispatch("H05", "UPDATE", base_ref=r["output_refs"][0], payload=forged)
    assert up["status"] == "REJECTED" and errors_of(up)[0] == ("INVALID_INPUT", "/payload/findings")


def copy_out(resp):
    return json.loads(json.dumps(resp["result"]))


# ====================================================================== H07
def test_h07_layout_pass_fail_and_epub_not_applicable(h):
    b = Book(h)
    r = create(h, "H07", {"export_ref": b.g11, "layout_profile_ref": b.profile})
    assert statuses(r) == "PASS", r["result"]["findings"]
    assert r["result"]["policy_ref"] == b.profile
    bad = fx_descriptor(h, "G11", build_pdf([text_page("ok"), text_page("margin", x=5)]), PDF_MIME)
    r = create(h, "H07", {"export_ref": bad, "layout_profile_ref": b.profile})
    f = [x for x in r["result"]["findings"] if x["rule_id"] == "SAFE_MARGIN" and x["decision"] == "FAIL"]
    assert statuses(r) == "FAIL" and f and "page 2" in f[0]["message"]
    epub = fx_descriptor(h, "G12", build_epub(), EPUB_MIME)
    na = h.create("H07", {"export_ref": epub, "layout_profile_ref": b.profile})
    assert na["status"] == "NOT_APPLICABLE" and na["selection_rule_id"] == "PROFILE_REFLOWABLE_EPUB"
    docx = fx_descriptor(h, "G13", build_docx(margins=100), DOCX_MIME)
    r = create(h, "H07", {"export_ref": docx, "layout_profile_ref": b.profile})
    assert "PROFILE_FORMAT_MISMATCH" in rules(r, "FAIL") and "SAFE_MARGIN" in rules(r, "FAIL")


# ====================================================================== H08
def test_h08_pdf_toc_targets(h):
    b = Book(h)
    r = create(h, "H08", {"export_ref": b.g11, "toc_manifest_ref": b.g07})
    assert statuses(r) == "PASS", r["result"]["findings"]
    wrong_page = fx_descriptor(h, "G11", build_pdf([text_page("a"), text_page("b")], dests={"ch-1": 0, "ch-2": 0},
                                                   links={1: "ch-9"}), PDF_MIME)
    r = create(h, "H08", {"export_ref": wrong_page, "toc_manifest_ref": b.g07})
    assert {"TOC_PAGE_MISMATCH", "BROKEN_LINK"} <= rules(r, "FAIL")
    unstable = fx_json_artifact(h, "G07", {"entries": [{"heading_id": "h-1", "title": "Chapter One", "page": 1,
                                                        "anchor_id": "ch-1"}], "pagination_ref": b.g04,
                                           "converged": False, "passes": 6})
    r = create(h, "H08", {"export_ref": b.g11, "toc_manifest_ref": unstable})
    assert "TOC_NONCONVERGENCE" in rules(r, "FAIL")
    titled = fx_descriptor(h, "G11", good_pdf(outline={"ch-1": "Chapter 1", "ch-2": "Chapter Two"}), PDF_MIME)
    r = create(h, "H08", {"export_ref": titled, "toc_manifest_ref": b.g07})
    assert rules(r, "FAIL") == {"TOC_TITLE_MISMATCH"}


def test_h08_epub_and_docx_anchors(h):
    b = Book(h)
    epub = fx_descriptor(h, "G12", build_epub(), EPUB_MIME)
    r = create(h, "H08", {"export_ref": epub, "toc_manifest_ref": b.g07})
    assert statuses(r) == "PASS", r["result"]["findings"]
    toc = fx_json_artifact(h, "G07", {"entries": [{"heading_id": "h-1", "title": "Chapter One", "page": None,
                                                   "anchor_id": "ch-1"},
                                                  {"heading_id": "h-3", "title": "Epilogue", "page": None,
                                                   "anchor_id": "ch-3"}], "pagination_ref": b.g04,
                                      "converged": True, "passes": 1})
    r = create(h, "H08", {"export_ref": epub, "toc_manifest_ref": toc})
    assert "NAV_ENTRY_MISSING" in rules(r, "FAIL")
    docx = fx_descriptor(h, "G13", build_docx(bookmarks=("ch-1",)), DOCX_MIME)
    r = create(h, "H08", {"export_ref": docx, "toc_manifest_ref": b.g07})
    assert statuses(r) == "FAIL" and "TOC_ANCHOR_MISSING" in rules(r, "FAIL")


# ====================================================================== semantic (H01-H04, H06)
def goals(h, ids=("resolve-ferry",)):
    return imported(h, "PROJECT_GOALS", {"goals": ["A quiet winter mystery"], "required_obligation_ids": list(ids),
                                         "intentionally_unresolved_ids": [], "approval_refs": []})


def evidence(ref, text, needle):
    s = text.index(needle)
    return {"record_ref": ref, "span_id": f"{ref['record_id']}:{s}", "start": s, "end": s + len(needle),
            "text_hash": sha256_text(needle)}


def finding(rule, decision="PASS", severity="INFO", ev=(), msg=None):
    return {"id": f"m-{rule}", "rule_id": rule, "severity": severity, "decision": decision,
            "message": msg or f"{rule} {decision}", "evidence": list(ev), "source_refs": [], "confidence": None}


def manual(op, findings, coverage, policy):
    return {"operation": op, "status": "UNKNOWN", "source_refs": [], "findings": findings, "result_revision": 1,
            "checker_version": "reviewer", "coverage_refs": coverage, "policy_ref": policy}


def test_h01_without_reviewer_is_unknown(h):
    b = Book(h)
    g = goals(h)
    r = create(h, "H01", {"manuscript_ref": b.g01, "project_goals_ref": g})
    assert statuses(r) == "UNKNOWN" and "VALIDATOR_UNAVAILABLE" in rules(r, "UNKNOWN")
    assert r["result"]["coverage_refs"] and not any(c["module_id"] == "C02" for c in r["result"]["coverage_refs"])


def test_h01_manual_review_pass_and_guards(h):
    b = Book(h)
    g = goals(h)
    payload = {"manuscript_ref": b.g01, "project_goals_ref": g}
    ev = evidence(b.c1, CH1, "left the harbour without its captain")
    full = manual("H01", [finding("GOAL:1"), finding("OBLIGATION:resolve-ferry", ev=[ev]),
                          finding("COVERAGE", msg="forged deterministic finding")], [b.c1, b.c2], g)
    r = create(h, "H01", payload, manual_candidate=full)
    assert statuses(r) == "PASS", r["result"]["findings"]
    assert r["result"]["checker_version"].endswith("+manual-review")
    assert h.validate(r["output_refs"][0])["status"] == "VALIDATED"
    # skipped chapter is never counted as reviewed
    partial = manual("H01", [finding("GOAL:1"), finding("OBLIGATION:resolve-ferry")], [b.c1], g)
    r = create(h, "H01", payload, manual_candidate=partial)
    assert statuses(r) == "UNKNOWN" and "COVERAGE_INCOMPLETE" in rules(r, "UNKNOWN")
    # forged evidence hash and an unassessed obligation
    bad_ev = dict(ev, text_hash="f" * 64)
    forged = manual("H01", [finding("GOAL:1", "FAIL", "MAJOR", ev=[bad_ev])], [b.c1, b.c2], g)
    r = create(h, "H01", payload, manual_candidate=forged)
    assert {"EVIDENCE_INVALID", "OBLIGATION_NOT_ASSESSED"} <= rules(r, "UNKNOWN") and statuses(r) == "FAIL"
    # an unevidenced blocking claim needs evidence
    r = create(h, "H01", payload, manual_candidate=manual(
        "H01", [finding("GOAL:1"), finding("OBLIGATION:resolve-ferry", "FAIL", "MAJOR")], [b.c1, b.c2], g))
    assert "EVIDENCE_REQUIRED" in rules(r, "UNKNOWN")


class FakeAI:
    def __init__(self, skip=()):
        self.skip = set(skip)
        self.calls = 0

    def submit(self, slot, system, user, schema):
        self.calls += 1
        ctxt = json.loads(user.split("\n", 1)[1])["context"]
        chunks = [c for c in ctxt["chunks"] if not any(c["chunk_id"].startswith(s) for s in self.skip)]
        findings = []
        for ob in ctxt["obligations"]:
            c = chunks[0]
            findings.append({"rule_id": ob["id"], "severity": "INFO", "decision": "PASS", "message": "realized",
                             "chunk_id": c["chunk_id"], "start": 0, "end": 10, "confidence": 0.9})
        return {"reviewed_chunk_ids": [c["chunk_id"] for c in chunks], "findings": findings}, {
            "model": "fake", "input_tokens": 10, "output_tokens": 5}


def test_h01_ai_review_and_skipped_window(h):
    b = Book(h)
    g = goals(h)
    h.engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})
    h.engine.providers.test_adapter = FakeAI()
    r = create(h, "H01", {"manuscript_ref": b.g01, "project_goals_ref": g})
    assert statuses(r) == "PASS", r["result"]["findings"]
    assert r["result"]["checker_version"].endswith("+ai:AI-1")
    ev = [f for f in r["result"]["findings"] if f["rule_id"] == "GOAL:1"][0]["evidence"][0]
    assert ev["text_hash"] == sha256_text(CH1[0:10])
    h.engine.providers.test_adapter = FakeAI(skip=("ch-2",))
    r = create(h, "H01", {"manuscript_ref": b.g01, "project_goals_ref": g})
    assert statuses(r) == "UNKNOWN" and "COVERAGE_INCOMPLETE" in rules(r, "UNKNOWN")


def test_semantic_disposition_needs_explicit_approval(h):
    b = Book(h)
    g = goals(h)
    cand = manual("H01", [finding("GOAL:1"), finding("OBLIGATION:resolve-ferry", "UNKNOWN", "MAJOR",
                                                     msg="ending ambiguous")], [b.c1, b.c2], g)
    r = create(h, "H01", {"manuscript_ref": b.g01, "project_goals_ref": g}, manual_candidate=cand)
    assert statuses(r) == "UNKNOWN"
    base = r["output_refs"][0]
    upd = copy_out(r)
    for f in upd["findings"]:
        if f["rule_id"] == "OBLIGATION:resolve-ferry":
            f["decision"], f["severity"], f["message"] = "PASS", "INFO", "reviewer: resolved in chapter 2"
    upd["status"], upd["result_revision"] = "PASS", 2
    # removing deterministic findings is refused
    stripped = dict(upd, findings=[f for f in upd["findings"] if f["rule_id"] != "OBLIGATIONS"])
    bad = h.dispatch("H01", "UPDATE", base_ref=base, payload=stripped)
    assert bad["status"] == "REJECTED"
    ok = h.dispatch("H01", "UPDATE", base_ref=base, payload=upd)
    assert ok["status"] == "DRAFT", ok
    v2 = ok["output_refs"][0]
    assert h.validate(v2)["status"] == "VALIDATED"
    acc = h.accept(v2)
    assert errors_of(acc)[0][0] == "APPROVAL_REQUIRED"
    acc = h.accept(v2, approval_ref=k09(h, [v2]))
    assert acc["status"] == "APPROVED"


def test_semantic_not_applicable_paths(h):
    b = Book(h)
    canon = fx_json(h, "I01", {"canon_id": "c", "revision": 1, "approval_state": "APPROVED"}, approved=True)
    r = create(h, "H02", {"manuscript_ref": b.g01, "canon_snapshot_ref": canon})
    assert statuses(r) == "NOT_APPLICABLE" and f"NOT_APPLICABLE:NO_SELECTED_OBLIGATIONS" in rules(r)
    a01 = fx_json(h, "A01", {"concept": "Mara", "attributes": {}, "linked_refs": [], "protected_fact_flags": [], "facts": [
        {"subject_id": "mara", "predicate": "eye_colour", "value": "grey", "assertion_type": "FACT",
         "effective_from": None, "effective_to": None, "source_refs": []}]}, approved=True)
    canon2 = fx_json(h, "I01", {"canon_id": "c2", "revision": 1, "approval_state": "APPROVED"}, source_refs=[a01],
                     approved=True)
    r = create(h, "H02", {"manuscript_ref": b.g01, "canon_snapshot_ref": canon2})
    assert statuses(r) == "UNKNOWN" and any("FACT:mara:eye_colour" in f["message"] for f in r["result"]["findings"])
    plan = fx_json(h, "B03", {"main_plot": {"summary": "x", "facts": [], "links": []}, "objectives": [],
                              "plot_obligations": []}, approved=True)
    r = create(h, "H03", {"manuscript_ref": b.g01, "plot_plan_ref": plan})
    assert statuses(r) == "NOT_APPLICABLE"
    h.set_features(character_arcs=False)
    arcs = fx_json(h, "B05", {"arcs": []}, approved=True)
    na = h.create("H04", {"manuscript_ref": b.g01, "character_arcs_ref": arcs})
    assert na["status"] == "NOT_APPLICABLE" and na["selection_rule_id"] == "FEATURE_TRUE:character_arcs"
    am = imported(h, "ASSET_MANIFEST", {"assets": [], "placement_ids": []})
    style = fx_json(h, "D01", {"x": 1}, record_kind="STYLE")
    vb = imported(h, "VISUAL_BIBLE", {"style_ref": style, "reference_refs": [], "approval_refs": []})
    na = h.create("H06", {"asset_manifest_ref": am, "approved_visual_bible_ref": vb})
    assert na["status"] == "NOT_APPLICABLE" and na["selection_rule_id"] == "FEATURE_TRUE:artwork"


def test_h06_with_art_needs_vision_reviewer(h):
    h.set_features(artwork=True)
    asset = fx_binary(h, "D05", b"\x89PNG\r\n\x1a\nfake", "image/png")
    style = fx_json(h, "D01", {"x": 1}, record_kind="STYLE")
    am = imported(h, "ASSET_MANIFEST", {"assets": [asset], "placement_ids": ["p1"]})
    vb = imported(h, "VISUAL_BIBLE", {"style_ref": style, "reference_refs": [], "approval_refs": [k09(h, [style])]})
    r = create(h, "H06", {"asset_manifest_ref": am, "approved_visual_bible_ref": vb})
    assert statuses(r) == "FAIL"  # unapproved asset is a hard defect
    assert "ASSET_NOT_APPROVED" in rules(r, "FAIL") and "VALIDATOR_UNAVAILABLE" in rules(r, "UNKNOWN")


# ====================================================================== H10
def qc_reports(h, b, *, h09_manifest=None):
    """Create + validate the reports the PDF-only walkthrough needs."""
    out = {}
    out["H05"] = create(h, "H05", {"manuscript_ref": b.g01, "chapter_manifest_ref": b.g02})["output_refs"][0]
    out["H07"] = create(h, "H07", {"export_ref": b.g11, "layout_profile_ref": b.profile})["output_refs"][0]
    out["H08"] = create(h, "H08", {"export_ref": b.g11, "toc_manifest_ref": b.g07})["output_refs"][0]
    out["H09"] = create(h, "H09", {"export_refs": [b.g11],
                                   "expected_manifest_ref": h09_manifest or b.manifest})["output_refs"][0]
    canon = fx_json(h, "I01", {"canon_id": "c", "revision": 1, "approval_state": "APPROVED"}, approved=True)
    out["H02"] = create(h, "H02", {"manuscript_ref": b.g01, "canon_snapshot_ref": canon})["output_refs"][0]
    plan = fx_json(h, "B03", {"main_plot": {"summary": "x", "facts": [], "links": []}, "objectives": [],
                              "plot_obligations": []}, approved=True)
    out["H03"] = create(h, "H03", {"manuscript_ref": b.g01, "plot_plan_ref": plan})["output_refs"][0]
    for op, ref in out.items():
        assert h.validate(ref)["status"] == "VALIDATED", (op, h.validate(ref))
    return out


def h10(h, b, reports, manifest=None, profile=None):
    return create(h, "H10", {"check_report_refs": list(reports), "release_profile_ref": profile or b.profile,
                             "release_manifest_ref": manifest or b.manifest})


def test_h10_pdf_only_walkthrough_ready_then_one_byte_change_blocks(h):
    h.set_features(character_arcs=False)  # H04 excluded by an explicit manifest predicate
    b = Book(h)
    reps = qc_reports(h, b)
    r = h10(h, b, reps.values())
    res = r["result"]
    assert res["status"] == "READY", [f for f in res["findings"] if f["decision"] != "PASS"]
    assert {"NOT_APPLICABLE_RULE:H04"} <= rules(r)  # H06 not selected (art disabled), H04 by feature predicate
    assert "FIXTURE_EVIDENCE" in rules(r, "UNKNOWN")  # visible: fixtures can never be released
    assert res["policy_ref"] == b.profile
    h10_ref = r["output_refs"][0]
    assert h.validate(h10_ref)["status"] == "VALIDATED"
    # release approval: explicit approval for the exact candidate is required ...
    assert errors_of(h.accept(h10_ref))[0][0] == "APPROVAL_REQUIRED"
    # ... and fixture-origin evidence can never satisfy it
    acc = h.accept(h10_ref, approval_ref=k09(h, [b.g11]))
    # must pin this exact candidate: the kernel refuses an approval bound to another record
    assert acc["status"] == "BLOCKED" and errors_of(acc)[0] == ("APPROVAL_REQUIRED", "/payload/approval_ref")
    acc = h.accept(h10_ref, approval_ref=k09(h, [h10_ref]))
    gate = {f["rule_id"] for f in acc["findings"] if f["severity"] == "BLOCKING"}
    assert acc["status"] == "BLOCKED" and "FIXTURE_EVIDENCE" in gate and "RELEASE_APPROVAL" not in gate
    assert h.record(h10_ref)["lifecycle"] != "APPROVED"
    h05_before = h.record(reps["H05"])["content_hash"]
    # change one export byte -> new export/descriptor -> new frozen manifest revision
    raw = bytearray(b.pdf_bytes)
    raw[raw.index(b"cold")] = ord("C")
    new_g11 = fx_descriptor(h, "G11", bytes(raw), PDF_MIME)
    auth2 = k09(h, [new_g11] + b.sources)
    man_rec = h.record(b.manifest)
    upd = json.loads(json.dumps(man_rec["data"]))
    upd["revision"] = 2
    upd["auxiliary_record"]["data"].update(export_refs=[new_g11], publication_authorization_ref=auth2)
    m2 = h.dispatch("I01", "UPDATE", base_ref=b.manifest, payload=upd)
    assert m2["status"] == "DRAFT", m2
    m2_ref = m2["output_refs"][0]
    assert h.approve(m2_ref)["status"] == "APPROVED"
    r2 = h10(h, b, reps.values(), manifest=m2_ref)
    assert r2["result"]["status"] == "BLOCKED"
    blockers = [f for f in r2["result"]["findings"] if f["decision"] in ("FAIL", "UNKNOWN")
                and f["severity"] in ("MAJOR", "BLOCKING")]
    affected = {f["message"].split(" ")[0] for f in blockers}
    assert {"H07", "H08", "H09"} <= affected, blockers  # exact affected reports are named
    assert "H05" not in affected
    assert any(f["rule_id"] == "STALE_PIN" and f["message"].startswith("H09") for f in blockers)
    assert h.record(reps["H05"])["content_hash"] == h05_before  # unrelated report unchanged
    # approving the new manifest revision invalidated consumers of the old one; no stale report permits release
    assert h.record(h10_ref)["stale"] and h.record(reps["H09"])["stale"]
    assert h.validate(h10_ref)["status"] == "DRAFT"


def test_h10_required_checks_cannot_waive_h09_and_blocks_missing_evidence(h):
    h.set_features(character_arcs=False)
    b = Book(h, required_checks=("H05",))
    reps = qc_reports(h, b)
    without_h09 = [v for k, v in reps.items() if k != "H09"]
    r = h10(h, b, without_h09)
    assert r["result"]["status"] == "BLOCKED"
    assert any(f["rule_id"] == "REPORT_MISSING" and f["message"].startswith("H09") for f in r["result"]["findings"])
    # stale report (kernel stale flag) blocks
    with h.store.transaction() as tx:
        tx.mark_stale(h.project_id, h.branch_id, reps["H05"]["record_id"], 1, "chapter changed")
    r = h10(h, b, reps.values())
    assert r["result"]["status"] == "BLOCKED" and "STALE_REPORT" in rules(r, "UNKNOWN")


def test_h10_blocks_without_authorization_unknown_reports_and_missing_reasons(h):
    b = Book(h, auth=False)
    reps = qc_reports(h, b)
    r = h10(h, b, [v for k, v in reps.items() if k != "H03"])
    found = rules(r, "UNKNOWN")
    assert r["result"]["status"] == "BLOCKED"
    assert {"PUBLICATION_AUTHORIZATION", "NO_OBLIGATION_REASON_MISSING"} <= found  # H03 + H04 lack reasons
    # an EPUB without EPUBCheck no longer holds the release (BF-22): H09 passes with a MINOR UNKNOWN note
    b2 = Book(h, required_checks=("H09",))
    epub = fx_descriptor(h, "G12", build_epub(), EPUB_MIME)
    man = imported(h, "RELEASE_MANIFEST", dict(b2.manifest_data(), export_refs=[b2.g11, epub],
                                               publication_authorization_ref=k09(h, [b2.g11, epub] + b2.sources)))
    h09 = create(h, "H09", {"export_refs": [b2.g11, epub], "expected_manifest_ref": man})
    assert statuses(h09) == "PASS" and "VALIDATOR_UNAVAILABLE" in rules(h09, "UNKNOWN")
    h.validate(h09["output_refs"][0])
    r = h10(h, b2, [h09["output_refs"][0]], manifest=man)
    assert "REPORT_STATUS" not in rules(r)
    # ... but a failing official check does
    hc.EXTERNAL_VALIDATORS["epubcheck"] = lambda data: (False, "epubcheck-fake 0", ["ERROR(RSC-005): bad"])
    h09 = create(h, "H09", {"export_refs": [b2.g11, epub], "expected_manifest_ref": man})
    assert statuses(h09) == "FAIL"
    h.validate(h09["output_refs"][0])
    r = h10(h, b2, [h09["output_refs"][0]], manifest=man)
    assert r["result"]["status"] == "BLOCKED" and "REPORT_STATUS" in rules(r)


def test_h10_art_selected_requires_h06(h):
    h.set_features(character_arcs=False)
    b = Book(h, artwork=True)
    reps = qc_reports(h, b)
    r = h10(h, b, reps.values())
    assert r["result"]["status"] == "BLOCKED"
    assert any(f["rule_id"] == "REPORT_MISSING" and f["message"].startswith("H06") for f in r["result"]["findings"])


def test_h10_semantic_report_must_be_approved(h):
    h.set_features(character_arcs=False)
    b = Book(h, required_checks=("H01", "H05", "H07", "H08", "H09"))
    reps = qc_reports(h, b)
    g = goals(h)
    cand = manual("H01", [finding("GOAL:1"), finding("OBLIGATION:resolve-ferry")], [b.c1, b.c2], g)
    h01 = create(h, "H01", {"manuscript_ref": b.g01, "project_goals_ref": g}, manual_candidate=cand)
    ref = h01["output_refs"][0]
    assert h.validate(ref)["status"] == "VALIDATED"
    r = h10(h, b, list(reps.values()) + [ref])
    assert "REPORT_NOT_REVIEWED" in rules(r, "UNKNOWN") and r["result"]["status"] == "BLOCKED"
    assert h.accept(ref)["status"] == "APPROVED"
    r = h10(h, b, list(reps.values()) + [ref])
    assert r["result"]["status"] == "READY", [f for f in r["result"]["findings"] if f["decision"] != "PASS"]
