"""DOCX (WordprocessingML / OPC) writer and structural inspector (stdlib only).

Produces an editable, structured document: Title/Subtitle for the title page, Heading1
(page break before) per section with a bookmark at its stable heading ID, Heading2
sub-headings, BodyText/FirstParagraph paragraphs, centred scene breaks, inline images
through relationships, and - when a converged TOC is supplied - a real TOC field whose
cached result is hyperlinks to the heading bookmarks (Word can refresh page numbers).
No pages are flattened. docProps/core.xml carries title/creator/language/rights and a
caller-supplied deterministic timestamp; the zip is deterministic (ziputil).

`inspect_docx(data)` verifies the package: [Content_Types].xml covers every part,
package and document relationships resolve, all XML parts are well-formed and every
r:id/r:embed in the document has a relationship.
"""
from __future__ import annotations

import posixpath
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape as _escape
from xml.sax.saxutils import quoteattr as _quoteattr

from .book import xml_safe
from .ziputil import build_zip, read_zip

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
EMU_PER_MM = 36000
DOCX_FONTS = {"times": "Times New Roman", "helvetica": "Arial", "courier": "Courier New"}


def escape(text: str) -> str:
    return _escape(xml_safe(text))


def quoteattr(text: str) -> str:
    return _quoteattr(xml_safe(text))


_RPR = {"i": "<w:rPr><w:i/><w:iCs/></w:rPr>", "b": "<w:rPr><w:b/><w:bCs/></w:rPr>",
        "bi": "<w:rPr><w:b/><w:bCs/><w:i/><w:iCs/></w:rPr>"}


def _t(text: str, style: str = "") -> str:
    return f"<w:r>{_RPR.get(style, '')}<w:t xml:space=\"preserve\">{escape(text)}</w:t></w:r>"


def _runs(block: dict) -> str:
    """Paragraph runs: plain text, or italic/bold runs for inline emphasis."""
    if not block.get("runs"):
        return _t(block["text"])
    return "".join(_t(text, style) for text, style in block["runs"])


def _p(style: str, inner: str, ppr_extra: str = "") -> str:
    return f"<w:p><w:pPr><w:pStyle w:val=\"{style}\"/>{ppr_extra}</w:pPr>{inner}</w:p>"


def _styles(family: str, size_pt: float, leading_pt: float) -> str:
    font = DOCX_FONTS.get(family, "Times New Roman")
    hp = int(round(size_pt * 2))
    line = int(round(leading_pt * 20))

    def style(sid, name, ppr="", rpr="", based="Normal", kind="paragraph", nxt=None):
        b = f"<w:basedOn w:val=\"{based}\"/>" if based else ""
        n = f"<w:next w:val=\"{nxt}\"/>" if nxt else ""
        return (f"<w:style w:type=\"{kind}\" w:styleId=\"{sid}\"><w:name w:val=\"{name}\"/>{b}{n}<w:qFormat/>"
                f"<w:pPr>{ppr}</w:pPr><w:rPr>{rpr}</w:rPr></w:style>")

    return ("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
            f"<w:styles xmlns:w=\"{W}\">"
            "<w:docDefaults><w:rPrDefault><w:rPr>"
            f"<w:rFonts w:ascii={quoteattr(font)} w:hAnsi={quoteattr(font)} w:cs={quoteattr(font)} w:eastAsia={quoteattr(font)}/>"
            f"<w:sz w:val=\"{hp}\"/><w:szCs w:val=\"{hp}\"/></w:rPr></w:rPrDefault>"
            f"<w:pPrDefault><w:pPr><w:spacing w:after=\"0\" w:line=\"{line}\" w:lineRule=\"exact\"/></w:pPr>"
            "</w:pPrDefault></w:docDefaults>"
            + style("Normal", "Normal", based=None)
            + style("BodyText", "Body Text", "<w:ind w:firstLine=\"360\"/><w:jc w:val=\"both\"/>")
            + style("FirstParagraph", "First Paragraph", "<w:jc w:val=\"both\"/>", nxt="BodyText")
            + style("Title", "Title", "<w:jc w:val=\"center\"/><w:spacing w:before=\"2880\" w:after=\"480\" w:line=\"240\" "
                    "w:lineRule=\"auto\"/>", f"<w:b/><w:sz w:val=\"{hp * 2}\"/>")
            + style("Subtitle", "Subtitle", "<w:jc w:val=\"center\"/><w:spacing w:after=\"240\"/>",
                    f"<w:sz w:val=\"{int(hp * 1.2)}\"/>")
            + style("Heading1", "heading 1", "<w:keepNext/><w:pageBreakBefore/><w:jc w:val=\"center\"/>"
                    "<w:spacing w:before=\"720\" w:after=\"360\" w:line=\"240\" w:lineRule=\"auto\"/><w:outlineLvl w:val=\"0\"/>",
                    f"<w:b/><w:sz w:val=\"{int(hp * 1.6)}\"/>", nxt="FirstParagraph")
            + style("Heading2", "heading 2", "<w:keepNext/><w:spacing w:before=\"240\" w:after=\"120\" w:line=\"240\" "
                    "w:lineRule=\"auto\"/><w:outlineLvl w:val=\"1\"/>", f"<w:b/><w:sz w:val=\"{int(hp * 1.2)}\"/>",
                    nxt="FirstParagraph")
            + style("TOCHeading", "TOC Heading", "<w:keepNext/><w:pageBreakBefore/><w:jc w:val=\"center\"/>"
                    "<w:spacing w:before=\"720\" w:after=\"360\"/>", f"<w:b/><w:sz w:val=\"{int(hp * 1.6)}\"/>")
            + style("TOC1", "toc 1")
            + style("TOC2", "toc 2", "<w:ind w:left=\"360\"/>")
            + style("SceneBreak", "Scene Break", "<w:jc w:val=\"center\"/><w:spacing w:before=\"240\" w:after=\"240\"/>")
            + style("MetaLine", "Meta Line", "<w:jc w:val=\"center\"/>")
            + style("Figure", "Figure", "<w:jc w:val=\"center\"/><w:spacing w:before=\"120\" w:after=\"120\" "
                    "w:line=\"240\" w:lineRule=\"auto\"/>")
            + "<w:style w:type=\"character\" w:styleId=\"Hyperlink\"><w:name w:val=\"Hyperlink\"/>"
              "<w:rPr><w:color w:val=\"0563C1\"/><w:u w:val=\"single\"/></w:rPr></w:style>"
            + "</w:styles>\n")


# EXIF orientation -> DrawingML (rotation in 60000ths of a degree, horizontal flip, vertical flip); flips are
# applied before the rotation. Word/LibreOffice show the stored pixels, so the camera orientation is applied here.
_ORIENT = {1: (0, False, False), 2: (0, True, False), 3: (10800000, False, False), 4: (0, False, True),
           5: (16200000, True, False), 6: (5400000, False, False), 7: (5400000, True, False),
           8: (16200000, False, False)}


def _drawing(rid: str, n: int, cx: int, cy: int, name: str, orientation: int = 1) -> str:
    """Inline picture shown at cx x cy EMU (display size, after the EXIF orientation)."""
    rot, flip_h, flip_v = _ORIENT.get(orientation, (0, False, False))
    fx, fy = (cy, cx) if orientation in (5, 6, 7, 8) else (cx, cy)  # frame before rotation
    xattrs = (f" rot=\"{rot}\"" if rot else "") + (" flipH=\"1\"" if flip_h else "") + (" flipV=\"1\"" if flip_v else "")
    # As Word writes a rotated inline picture: extent = the frame before rotation, effectExtent = what the
    # rotation adds/removes on each side so the line reserves the rotated (display) box.
    ex, ey = (cx - fx) // 2, (cy - fy) // 2
    effect = f"<wp:effectExtent l=\"{ex}\" t=\"{ey}\" r=\"{ex}\" b=\"{ey}\"/>" if (ex or ey) else ""
    return ("<w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">"
            f"<wp:extent cx=\"{fx}\" cy=\"{fy}\"/>{effect}<wp:docPr id=\"{n}\" name={quoteattr(name)} descr=\"\"/>"
            "<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr>"
            "<a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">"
            f"<pic:pic><pic:nvPicPr><pic:cNvPr id=\"{n}\" name={quoteattr(name)}/><pic:cNvPicPr/></pic:nvPicPr>"
            f"<pic:blipFill><a:blip r:embed=\"{rid}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>"
            f"<pic:spPr><a:xfrm{xattrs}><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{fx}\" cy=\"{fy}\"/></a:xfrm>"
            "<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>"
            "</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>")


def build_docx(book: dict, *, created: str, family: str = "times", size_pt: float = 11.0, leading_pt: float = 14.0,
               toc_entries: list[dict] | None = None, images: dict | None = None,
               page: dict | None = None) -> bytes:
    """images: key -> (bytes, ImageInfo); page: PAGE_PROFILE (mm) for section size/margins or None."""
    meta = book["meta"]
    images = images or {}
    rels: list[tuple[str, str, str]] = [
        ("rId1", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles", "styles.xml"),
        ("rId2", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings", "settings.xml"),
    ]
    media: list[tuple[str, bytes]] = []
    img_rid: dict[str, str] = {}
    bookmarks: dict[str, str] = {}
    bm_counter = [0]

    def bookmark(hid: str, inner: str) -> str:
        if hid not in bookmarks:  # bookmark name = stable heading/anchor ID (shared with PDF/EPUB anchors)
            bm_counter[0] += 1
            bookmarks[hid] = hid
        n = list(bookmarks).index(hid)
        name = bookmarks[hid]
        return (f"<w:bookmarkStart w:id=\"{n}\" w:name=\"{name}\"/>{inner}<w:bookmarkEnd w:id=\"{n}\"/>")

    # Pre-assign bookmarks in document order so TOC hyperlinks can target them.
    for s in book["sections"]:
        bookmark(s["id"], "")
        for b in s["blocks"]:
            if b["t"] == "h2":
                bookmark(b["id"], "")

    body: list[str] = []
    drawing_n = 0
    for s in book["sections"]:
        if s["kind"] == "toc" and toc_entries is None:
            continue
        if s["kind"] == "title_page":
            body.append(_p("Title", bookmark(s["id"], _t(s["heading"]))))
            for b in s["blocks"]:
                body.append(_p("Subtitle", _t(b["text"])))
            continue
        if s["kind"] == "toc":
            body.append(_p("TOCHeading", bookmark(s["id"], _t(s["heading"]))))
            entries = toc_entries or []
            for i, e in enumerate(entries):
                runs = ""
                if i == 0:
                    runs += ("<w:r><w:fldChar w:fldCharType=\"begin\"/></w:r><w:r><w:instrText xml:space=\"preserve\">"
                             " TOC \\o \"1-2\" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>")
                anchor = bookmarks.get(e["heading_id"])
                link = (f"<w:hyperlink w:anchor=\"{anchor}\" w:history=\"1\"><w:r><w:rPr><w:rStyle w:val=\"Hyperlink\"/>"
                        f"</w:rPr><w:t xml:space=\"preserve\">{escape(e['title'])}</w:t></w:r></w:hyperlink>"
                        if anchor else _t(e["title"]))
                runs += link
                if i == len(entries) - 1:
                    runs += "<w:r><w:fldChar w:fldCharType=\"end\"/></w:r>"
                body.append(_p(f"TOC{min(e.get('level', 1), 2)}", runs))
            continue
        body.append(_p("Heading1", bookmark(s["id"], _t(s["heading"]))))
        for b in s["blocks"]:
            t = b["t"]
            if t == "p":
                body.append(_p("FirstParagraph" if b.get("first") else "BodyText", _runs(b)))
            elif t == "meta":
                body.append(_p("MetaLine", _t(b["text"])))
            elif t == "h2":
                body.append(_p("Heading2", bookmark(b["id"], _t(b["text"]))))
            elif t == "break":
                body.append(_p("SceneBreak", _t("* * *")))
            elif t == "img" and b["key"] in images:
                data, info = images[b["key"]]
                if b["key"] not in img_rid:
                    rid = f"rId{len(rels) + 1}"
                    target = f"media/image{len(media) + 1}.{info.ext}"
                    rels.append((rid, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", target))
                    media.append((f"word/{target}", data))
                    img_rid[b["key"]] = rid
                drawing_n += 1
                box_w, box_h = b["w_mm"] * EMU_PER_MM, b["h_mm"] * EMU_PER_MM
                if page:  # same rule as the PDF: the box never exceeds the usable page width/height
                    usable_w = (page["width_mm"] - 2 * page["safe_margin_mm"]) * EMU_PER_MM
                    usable_h = (page["height_mm"] - 2 * page["safe_margin_mm"]) * EMU_PER_MM * 0.95
                    k = min(1.0, usable_w / box_w, usable_h / box_h)
                    box_w, box_h = box_w * k, box_h * k
                s_ = min(box_w / info.width, box_h / info.height)
                body.append(_p("Figure", _drawing(img_rid[b["key"]], drawing_n, int(info.width * s_),
                                                  int(info.height * s_), b["id"], info.orientation)))
    sect = ""
    if page:
        tw = lambda mm: int(round(mm * 1440 / 25.4))  # noqa: E731 - twentieths of a point
        m = tw(page["safe_margin_mm"])
        sect = (f"<w:sectPr><w:pgSz w:w=\"{tw(page['width_mm'])}\" w:h=\"{tw(page['height_mm'])}\"/>"
                f"<w:pgMar w:top=\"{m}\" w:right=\"{m}\" w:bottom=\"{m}\" w:left=\"{m}\" w:header=\"0\" "
                f"w:footer=\"0\" w:gutter=\"0\"/></w:sectPr>")
    document = ("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
                f"<w:document xmlns:w=\"{W}\" xmlns:r=\"{R}\" "
                "xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" "
                "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" "
                "xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">"
                "<w:body>" + "".join(body) + sect + "</w:body></w:document>\n")
    lang = meta.get("language") or "und"
    settings = ("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
                f"<w:settings xmlns:w=\"{W}\"><w:updateFields w:val=\"{'true' if toc_entries else 'false'}\"/>"
                f"<w:themeFontLang w:val={quoteattr(lang)}/></w:settings>\n")
    doc_rels = ("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
                f"<Relationships xmlns=\"{PKG_REL}\">"
                + "".join(f"<Relationship Id=\"{i}\" Type=\"{t}\" Target=\"{tg}\"/>" for i, t, tg in rels)
                + "</Relationships>\n")
    pkg_rels = ("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
                f"<Relationships xmlns=\"{PKG_REL}\">"
                "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
                "officeDocument\" Target=\"word/document.xml\"/>"
                "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/"
                "core-properties\" Target=\"docProps/core.xml\"/>"
                "<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
                "extended-properties\" Target=\"docProps/app.xml\"/></Relationships>\n")
    core = ("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
            "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" "
            "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" "
            "xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">"
            f"<dc:title>{escape(meta.get('title', ''))}</dc:title><dc:creator>{escape(meta.get('author', ''))}</dc:creator>"
            f"<dc:language>{escape(lang)}</dc:language><dc:identifier>{escape(meta.get('identifier', ''))}</dc:identifier>"
            f"<dc:rights>{escape(meta.get('rights', ''))}</dc:rights>"
            f"<dcterms:created xsi:type=\"dcterms:W3CDTF\">{escape(created)}</dcterms:created>"
            f"<dcterms:modified xsi:type=\"dcterms:W3CDTF\">{escape(created)}</dcterms:modified>"
            "</cp:coreProperties>\n")
    app = ("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
           "<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\">"
           "<Application>Akowe DOCX writer 1</Application></Properties>\n")
    exts = sorted({posixpath.splitext(n)[1][1:] for n, _ in media})
    img_types = {"png": "image/png", "jpg": "image/jpeg"}
    ctypes = ("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
              f"<Types xmlns=\"{CT}\">"
              "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
              "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
              + "".join(f"<Default Extension=\"{e}\" ContentType=\"{img_types[e]}\"/>" for e in exts)
              + "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument."
                "wordprocessingml.document.main+xml\"/>"
              "<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument."
              "wordprocessingml.styles+xml\"/>"
              "<Override PartName=\"/word/settings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument."
              "wordprocessingml.settings+xml\"/>"
              "<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package."
              "core-properties+xml\"/>"
              "<Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument."
              "extended-properties+xml\"/></Types>\n")
    entries = [("[Content_Types].xml", ctypes.encode("utf-8")), ("_rels/.rels", pkg_rels.encode("utf-8")),
               ("docProps/core.xml", core.encode("utf-8")), ("docProps/app.xml", app.encode("utf-8")),
               ("word/document.xml", document.encode("utf-8")),
               ("word/styles.xml", _styles(family, size_pt, leading_pt).encode("utf-8")),
               ("word/settings.xml", settings.encode("utf-8")),
               ("word/_rels/document.xml.rels", doc_rels.encode("utf-8"))] + media
    return build_zip(entries)


def inspect_docx(data: bytes) -> dict:
    errors: list[str] = []
    report = {"paragraphs": 0, "headings": 0, "images": 0, "hyperlinks": 0, "title": None, "errors": errors}
    try:
        zf = read_zip(data)
    except Exception as exc:  # noqa: BLE001
        errors.append(f"not a zip archive: {exc}")
        return report
    names = set(zf.namelist())
    if "[Content_Types].xml" not in names:
        errors.append("missing [Content_Types].xml")
        return report
    parsed = {}
    for n in sorted(names):
        if n.endswith((".xml", ".rels")):
            try:
                parsed[n] = ET.fromstring(zf.read(n))
            except ET.ParseError as exc:
                errors.append(f"{n} is not well-formed XML: {exc}")
    ct = parsed.get("[Content_Types].xml")
    if ct is None:
        return report
    defaults = {d.get("Extension").lower(): d.get("ContentType") for d in ct.findall(f"{{{CT}}}Default")}
    overrides = {o.get("PartName"): o.get("ContentType") for o in ct.findall(f"{{{CT}}}Override")}
    for n in names:
        if n == "[Content_Types].xml" or n.endswith("/"):
            continue
        ext = n.rsplit("/", 1)[-1].rsplit(".", 1)[-1].lower() if "." in n.rsplit("/", 1)[-1] else ""
        if "/" + n not in overrides and ext not in defaults:
            errors.append(f"part {n} has no content type")
    for part in overrides:
        if part[1:] not in names:
            errors.append(f"override for missing part {part}")

    def rels_of(rel_path: str, source_dir: str) -> dict:
        out = {}
        root = parsed.get(rel_path)
        if root is None:
            return out
        for r in root.findall(f"{{{PKG_REL}}}Relationship"):
            target = r.get("Target")
            if r.get("TargetMode") == "External":
                continue
            full = posixpath.normpath(posixpath.join(source_dir, target)).lstrip("/")
            if full not in names:
                errors.append(f"{rel_path}: relationship {r.get('Id')} targets missing {full}")
            out[r.get("Id")] = (r.get("Type"), full)
        return out

    pkg = rels_of("_rels/.rels", "")
    main = [full for t, full in pkg.values() if t.endswith("/officeDocument")]
    if len(main) != 1:
        errors.append("package must have one officeDocument relationship")
        return report
    doc_path = main[0]
    if overrides.get("/" + doc_path) != ("application/vnd.openxmlformats-officedocument."
                                         "wordprocessingml.document.main+xml"):
        errors.append("main document has the wrong content type")
    doc_rels = rels_of(posixpath.join(posixpath.dirname(doc_path), "_rels", posixpath.basename(doc_path) + ".rels"),
                       posixpath.dirname(doc_path))
    doc = parsed.get(doc_path)
    if doc is None:
        errors.append("main document unreadable")
        return report
    body = doc.find(f"{{{W}}}body")
    if body is None:
        errors.append("document has no w:body")
        return report
    bookmarks = {b.get(f"{{{W}}}name") for b in doc.iter(f"{{{W}}}bookmarkStart")}
    for p in doc.iter(f"{{{W}}}p"):
        report["paragraphs"] += 1
        st = p.find(f"{{{W}}}pPr/{{{W}}}pStyle")
        if st is not None and st.get(f"{{{W}}}val", "").startswith("Heading"):
            report["headings"] += 1
    for el in doc.iter():
        for attr in (f"{{{R}}}id", f"{{{R}}}embed"):
            rid = el.get(attr)
            if rid is not None:
                if rid not in doc_rels:
                    errors.append(f"document references unknown relationship {rid}")
                elif attr.endswith("embed"):
                    report["images"] += 1
        if el.tag == f"{{{W}}}hyperlink" and el.get(f"{{{W}}}anchor"):
            report["hyperlinks"] += 1
            if el.get(f"{{{W}}}anchor") not in bookmarks:
                errors.append(f"hyperlink anchor {el.get(f'{{{W}}}anchor')} has no bookmark")
    core = next((full for t, full in pkg.values() if t.endswith("/core-properties")), None)
    if core and core in parsed:
        t = parsed[core].find("{http://purl.org/dc/elements/1.1/}title")
        report["title"] = t.text if t is not None else None
    return report
