"""EPUB 3 writer and structural inspector (stdlib only).

Package layout: `mimetype` (first entry, STORED, exact bytes), META-INF/container.xml,
OEBPS/content.opf (dc:identifier/title/language/creator/rights, dcterms:modified, manifest,
spine), OEBPS/nav.xhtml (toc + landmarks navigation, no page numbers), one XHTML file per
section with stable id anchors, OEBPS/style.css and relative image assets. Reflowable: no
print page geometry, cover or spine values unless an EBOOK cover is supplied.

`inspect_epub(data)` checks the OCF container rules, parses every XML/XHTML file, verifies
manifest hrefs exist, spine idrefs, the nav document, relative links/anchors and image
references. The official EPUBCheck is run by h_checks (H09) when it is installed.
"""
from __future__ import annotations

import posixpath
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape as _escape
from xml.sax.saxutils import quoteattr as _quoteattr

from .book import xml_safe
from .ziputil import build_zip, read_zip


def escape(text: str) -> str:
    return _escape(xml_safe(text))


def quoteattr(text: str) -> str:
    return _quoteattr(xml_safe(text))


_EMPH_TAGS = {"i": ("<em>", "</em>"), "b": ("<strong>", "</strong>"), "bi": ("<strong><em>", "</em></strong>")}


def inline_xhtml(block: dict) -> str:
    """Paragraph content: plain text, or <em>/<strong> runs for inline emphasis."""
    if not block.get("runs"):
        return escape(block["text"])
    out = []
    for text, style in block["runs"]:
        open_, close = _EMPH_TAGS.get(style, ("", ""))
        out.append(f"{open_}{escape(text)}{close}")
    return "".join(out)

MIMETYPE = b"application/epub+zip"
NS = {"opf": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/",
      "x": "http://www.w3.org/1999/xhtml", "epub": "http://www.idpf.org/2007/ops",
      "c": "urn:oasis:names:tc:opendocument:xmlns:container"}

CSS = """body { font-family: serif; line-height: 1.4; margin: 0 5%; }
h1 { text-align: center; margin: 3em 0 1.5em; page-break-before: always; }
h2 { margin: 1.5em 0 0.5em; }
p { margin: 0; text-indent: 1.5em; text-align: justify; }
p.first, p.meta { text-indent: 0; }
p.meta { text-align: center; margin: 0.5em 0; }
p.scene-break { text-indent: 0; text-align: center; margin: 1em 0; }
section.title-page h1 { margin-top: 30%; font-size: 2em; }
figure { margin: 1em 0; text-align: center; }
figure img { max-width: 100%; height: auto; }
figure img.map { width: 100%; }
figcaption { font-style: italic; font-size: 0.9em; margin-top: 0.4em; text-align: center; }
section.plate figure { margin-top: 10%; }
nav ol { list-style: none; padding-left: 1em; }
"""


def _xhtml(title: str, lang: str, body: str) -> bytes:
    return ("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n"
            f"<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" "
            f"lang={quoteattr(lang)} xml:lang={quoteattr(lang)}>\n<head>\n<meta charset=\"utf-8\"/>\n"
            f"<title>{escape(title)}</title>\n<link rel=\"stylesheet\" type=\"text/css\" href=\"../style.css\"/>\n"
            f"</head>\n<body>\n{body}</body>\n</html>\n").encode("utf-8")


def build_epub(book: dict, *, modified: str, toc_entries: list[dict] | None = None, images: dict | None = None,
               cover: tuple | None = None) -> bytes:
    """images: key -> (bytes, ImageInfo); cover: (bytes, ImageInfo) or None.
    modified: RFC3339 UTC 'YYYY-MM-DDThh:mm:ssZ' (caller supplies a deterministic value)."""
    meta = book["meta"]
    lang = meta.get("language") or "und"
    images = images or {}
    files: list[tuple[str, bytes]] = []
    manifest: list[tuple[str, str, str, str]] = []  # id, href, media-type, properties
    spine: list[str] = []
    file_of: dict[str, str] = {}  # anchor id -> href

    sections = [s for s in book["sections"] if not (s["kind"] == "toc" and toc_entries is None)]
    names = {}
    for i, s in enumerate(sections, start=1):
        names[s["id"]] = f"text/s{i:03d}.xhtml"
        file_of[s["id"]] = names[s["id"]]
        for b in s["blocks"]:
            if b.get("id"):
                file_of[b["id"]] = names[s["id"]]
    img_href = {}
    for k in sorted(images):
        data, info = images[k]
        img_href[k] = f"images/{k[:16]}.{info.ext}"
    used_imgs = set()
    vmaps: dict[str, bytes] = {}  # 🖼 B3 href -> SVG map bytes

    if cover is not None:
        cdata, cinfo = cover
        files.append((f"OEBPS/images/cover.{cinfo.ext}", cdata))
        manifest.append(("cover-image", f"images/cover.{cinfo.ext}", cinfo.mime, "cover-image"))
        body = (f"<section epub:type=\"cover\" class=\"cover\"><figure><img src=\"../images/cover.{cinfo.ext}\" "
                f"alt={quoteattr('Cover: ' + meta.get('title', ''))}/></figure></section>\n")
        files.append(("OEBPS/text/cover.xhtml", _xhtml(meta.get("title", "Cover"), lang, body)))
        manifest.append(("cover", "text/cover.xhtml", "application/xhtml+xml", ""))
        spine.append("cover")

    for i, s in enumerate(sections, start=1):
        sid = f"s{i:03d}"
        cls = s["kind"].replace("_", "-")
        if s["kind"] == "plate":  # 🖼 B3: a picture on a page of its own (no heading, not in the contents)
            parts = [f"<section class=\"plate\" id={quoteattr(s['id'])}>\n"]
        else:
            kind = {"title_page": "titlepage", "front": "frontmatter", "toc": "toc", "chapter": "chapter",
                    "back": "backmatter"}[s["kind"]]
            parts = [f"<section epub:type=\"{kind}\" class=\"{cls}\" aria-labelledby={quoteattr(s['id'])}>\n",
                     f"<h1 id={quoteattr(s['id'])}>{escape(s['heading'])}</h1>\n"]
        if s["kind"] == "toc":
            parts.append("<ol>\n")
            for e in toc_entries or []:
                href = posixpath.relpath(file_of.get(e["heading_id"], names[s["id"]]), posixpath.dirname(names[s["id"]]))
                parts.append(f"<li class=\"level{e.get('level', 1)}\"><a href={quoteattr(href + '#' + e['heading_id'])}>"
                             f"{escape(e['title'])}</a></li>\n")
            parts.append("</ol>\n")
        for b in s["blocks"]:
            t = b["t"]
            if t == "p":
                cls_attr = " class=\"first\"" if b.get("first") else ""
                parts.append(f"<p id={quoteattr(b['id'])}{cls_attr}>{inline_xhtml(b)}</p>\n")
            elif t == "meta":
                parts.append(f"<p class=\"meta\">{escape(b['text'])}</p>\n")
            elif t == "h2":
                parts.append(f"<h2 id={quoteattr(b['id'])}>{escape(b['text'])}</h2>\n")
            elif t == "break":
                parts.append("<p class=\"scene-break\" role=\"separator\">* * *</p>\n")
            elif t == "img":
                if b["key"] not in img_href:
                    continue
                used_imgs.add(b["key"])
                cap = f"<figcaption>{escape(b['caption'])}</figcaption>" if b.get("caption") else ""
                parts.append(f"<figure id={quoteattr(b['id'])}><img src=\"../{img_href[b['key']]}\" "
                             f"alt={quoteattr(b.get('alt') or '')}/>{cap}</figure>\n")
            elif t == "vmap":  # 🖼 B3: the SVG map itself (an EPUB 3 core media type)
                href = f"images/map-{b['id'][:24]}.svg"
                if href not in vmaps:
                    vmaps[href] = b["svg"].encode("utf-8") if isinstance(b["svg"], str) else bytes(b["svg"])
                cap = f"<figcaption>{escape(b['caption'])}</figcaption>" if b.get("caption") else ""
                parts.append(f"<figure id={quoteattr(b['id'])}><img class=\"map\" src=\"../{href}\" "
                             f"alt={quoteattr(b.get('alt') or b.get('caption') or 'Map')}/>{cap}</figure>\n")
        parts.append("</section>\n")
        files.append((f"OEBPS/{names[s['id']]}", _xhtml(s["heading"] or "Illustration", lang, "".join(parts))))
        manifest.append((sid, names[s["id"]], "application/xhtml+xml", ""))
        spine.append(sid)

    for k in sorted(used_imgs):
        data, info = images[k]
        files.append((f"OEBPS/{img_href[k]}", data))
        manifest.append((f"img-{k[:16]}", img_href[k], info.mime, ""))
    for i, href in enumerate(sorted(vmaps), start=1):
        files.append((f"OEBPS/{href}", vmaps[href]))
        manifest.append((f"map-{i}", href, "image/svg+xml", ""))

    # Navigation document: hierarchical toc from headings (or the converged G07 entries).
    from .book import heading_entries
    entries = toc_entries if toc_entries is not None else heading_entries(book)
    nav = ["<nav epub:type=\"toc\" id=\"toc\" role=\"doc-toc\">\n<h1>Contents</h1>\n<ol>\n"]
    groups: list = []
    for e in entries:
        if e.get("level", 1) == 1 or not groups:
            groups.append((e, []))
        else:
            groups[-1][1].append(e)

    def link(e):
        href = f"{file_of.get(e['heading_id'], '')}#{e['heading_id']}"
        return f"<a href={quoteattr(href)}>{escape(e['title'])}</a>"

    for head, children in groups:
        nav.append("<li>" + link(head))
        if children:
            nav.append("\n<ol>\n" + "".join(f"<li>{link(c)}</li>\n" for c in children) + "</ol>\n")
        nav.append("</li>\n")
    if not groups and sections:  # an empty <ol> is invalid: point at the first page instead
        nav.append(f"<li><a href={quoteattr(names[sections[0]['id']] + '#' + sections[0]['id'])}>"
                   f"{escape(sections[0]['heading'] or meta.get('title', 'Start'))}</a></li>\n")
    nav.append("</ol>\n</nav>\n")
    first_chapter = next((s for s in sections if s["kind"] == "chapter"), None)
    toc_section = next((s for s in sections if s["kind"] == "toc"), None)
    title_section = next((s for s in sections if s["kind"] == "title_page"), None)
    # Landmarks may only point into spine documents (EPUBCheck RSC-011): the nav document itself is not in the
    # spine, so the "toc" landmark targets the book's Contents page when there is one.
    marks = [(kind, sec) for kind, sec in (("titlepage", title_section), ("toc", toc_section),
                                           ("bodymatter", first_chapter)) if sec is not None]
    if marks:
        nav.append("<nav epub:type=\"landmarks\" id=\"landmarks\" hidden=\"\">\n<ol>\n")
        for kind, sec in marks:
            nav.append(f"<li><a epub:type=\"{kind}\" href={quoteattr(names[sec['id']] + '#' + sec['id'])}>"
                       f"{escape(sec['heading'])}</a></li>\n")
        nav.append("</ol>\n</nav>\n")
    nav_doc = _xhtml("Contents", lang, "".join(nav)).replace(b"href=\"../style.css\"", b"href=\"style.css\"")
    files.append(("OEBPS/nav.xhtml", nav_doc))
    manifest.append(("nav", "nav.xhtml", "application/xhtml+xml", "nav"))
    files.append(("OEBPS/style.css", CSS.encode("utf-8")))
    manifest.append(("css", "style.css", "text/css", ""))

    opf = ["<?xml version=\"1.0\" encoding=\"utf-8\"?>\n",
           f"<package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" unique-identifier=\"bookid\" "
           f"xml:lang={quoteattr(lang)}>\n",
           "<metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n",
           f"<dc:identifier id=\"bookid\">{escape(meta.get('identifier', 'urn:akowe:unknown'))}</dc:identifier>\n",
           f"<dc:title>{escape(meta.get('title', 'Untitled'))}</dc:title>\n",
           f"<dc:language>{escape(lang)}</dc:language>\n"]
    if meta.get("author"):
        opf.append(f"<dc:creator>{escape(meta['author'])}</dc:creator>\n")
    if meta.get("rights"):
        opf.append(f"<dc:rights>{escape(meta['rights'])}</dc:rights>\n")
    opf.append(f"<meta property=\"dcterms:modified\">{escape(modified)}</meta>\n")
    if cover is not None:
        opf.append("<meta name=\"cover\" content=\"cover-image\"/>\n")
    opf.append("</metadata>\n<manifest>\n")
    for mid, href, mt, props in manifest:
        p = f" properties=\"{props}\"" if props else ""
        opf.append(f"<item id=\"{mid}\" href={quoteattr(href)} media-type=\"{mt}\"{p}/>\n")
    opf.append("</manifest>\n<spine>\n")
    for idref in spine:
        opf.append(f"<itemref idref=\"{idref}\"/>\n")
    opf.append("</spine>\n</package>\n")
    container = ("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
                 "<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">\n"
                 "<rootfiles>\n<rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/>\n"
                 "</rootfiles>\n</container>\n")
    entries_out = [("mimetype", MIMETYPE), ("META-INF/container.xml", container.encode("utf-8")),
                   ("OEBPS/content.opf", "".join(opf).encode("utf-8"))] + files
    return build_zip(entries_out)


def inspect_epub(data: bytes) -> dict:
    errors: list[str] = []
    report = {"spine": [], "manifest": 0, "xhtml": 0, "nav": False, "title": None, "language": None,
              "identifier": None, "images": 0, "errors": errors, "epubcheck": "UNAVAILABLE"}
    try:
        zf = read_zip(data)
    except Exception as exc:  # noqa: BLE001
        errors.append(f"not a zip archive: {exc}")
        return report
    infos = zf.infolist()
    if not infos or infos[0].filename != "mimetype":
        errors.append("mimetype is not the first entry")
    elif infos[0].compress_type != 0 or infos[0].extra:
        errors.append("mimetype must be stored uncompressed without extra field")
    elif zf.read("mimetype") != MIMETYPE:
        errors.append("mimetype content is not application/epub+zip")
    if data[30:38] != b"mimetype":
        errors.append("mimetype local header is not at offset 0")
    names = set(zf.namelist())
    if "META-INF/container.xml" not in names:
        errors.append("missing META-INF/container.xml")
        return report
    try:
        container = ET.fromstring(zf.read("META-INF/container.xml"))
        rootfile = container.find("c:rootfiles/c:rootfile", NS)
        opf_path = rootfile.get("full-path")
        opf = ET.fromstring(zf.read(opf_path))
    except Exception as exc:  # noqa: BLE001
        errors.append(f"container/OPF unreadable: {exc}")
        return report
    if opf.get("version") != "3.0":
        errors.append("package version is not 3.0")
    base = posixpath.dirname(opf_path)
    md = opf.find("opf:metadata", NS)
    uid = opf.get("unique-identifier")
    ident = md.find(f"dc:identifier[@id='{uid}']", NS) if md is not None else None
    for tag in ("title", "language"):
        el = md.find(f"dc:{tag}", NS) if md is not None else None
        if el is None or not (el.text or "").strip():
            errors.append(f"missing dc:{tag}")
        else:
            report[tag] = el.text
    if ident is None or not (ident.text or "").strip():
        errors.append("missing unique dc:identifier")
    else:
        report["identifier"] = ident.text
    mod = [m for m in (md.findall("opf:meta", NS) if md is not None else []) if m.get("property") == "dcterms:modified"]
    if len(mod) != 1:
        errors.append("exactly one dcterms:modified is required")
    items = {}
    for it in opf.findall("opf:manifest/opf:item", NS):
        href = posixpath.normpath(posixpath.join(base, it.get("href")))
        items[it.get("id")] = (href, it.get("media-type"), (it.get("properties") or "").split())
        if href not in names:
            errors.append(f"manifest item {it.get('href')} missing from container")
    report["manifest"] = len(items)
    for ir in opf.findall("opf:spine/opf:itemref", NS):
        idref = ir.get("idref")
        if idref not in items:
            errors.append(f"spine idref {idref} not in manifest")
        report["spine"].append(idref)
    if not report["spine"]:
        errors.append("empty spine")
    navs = [v for v in items.values() if "nav" in v[2]]
    if len(navs) != 1:
        errors.append("exactly one nav document is required")
    ids_by_file: dict[str, set] = {}
    links: list[tuple[str, str]] = []
    for mid, (href, mt, props) in items.items():
        if mt == "application/xhtml+xml" and href in names:
            report["xhtml"] += 1
            try:
                root = ET.fromstring(zf.read(href))
            except ET.ParseError as exc:
                errors.append(f"{href} is not well-formed XHTML: {exc}")
                continue
            if root.tag != f"{{{NS['x']}}}html":
                errors.append(f"{href} root is not XHTML html")
            ids_by_file[href] = {el.get("id") for el in root.iter() if el.get("id")}
            for el in root.iter():
                for attr in ("href", "src"):
                    v = el.get(attr)
                    if v and not v.startswith(("http:", "https:", "mailto:")):
                        links.append((href, v))
            if "nav" in props:
                report["nav"] = root.find(".//x:nav", NS) is not None
        elif mt.startswith("image/"):
            report["images"] += 1
    for src, target in links:
        path, _, frag = target.partition("#")
        full = posixpath.normpath(posixpath.join(posixpath.dirname(src), path)) if path else src
        if full not in names:
            errors.append(f"{src}: broken relative link {target}")
        elif frag and full in ids_by_file and frag not in ids_by_file[full]:
            errors.append(f"{src}: anchor #{frag} not found in {full}")
    return report
