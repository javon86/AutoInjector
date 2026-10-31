"""📖 The Book Bible binder as a Word document (stdlib only, like ``exporters/docx.py``): one Heading 1 per page
(a page break before), one Heading 2 per schema section in the look's accent colour, a two-column table per fact
box (label | value), a table per repeating section, the pictures embedded (PNG / JPEG; an SVG map uses its PNG
copy when there is one), the status of each page and the book's title/author in the document properties."""
from __future__ import annotations

from xml.sax.saxutils import escape as _esc

from .binder import clean_label, schema, section_title
from .binder_html import LOOK_VARS, STATUS_WORDS
from .exporters.book import xml_safe
from .exporters.docx import CT, PKG_REL, R, W, _drawing
from .exporters.ziputil import build_zip

EMU_PER_MM = 36000


def esc(t) -> str:
    return _esc(xml_safe(str(t if t is not None else "")))


def _run(text: str, *, bold=False, italic=False, color: str | None = None, size: int | None = None) -> str:
    rpr = ("<w:b/>" if bold else "") + ("<w:i/>" if italic else "") + \
        (f'<w:color w:val="{color}"/>' if color else "") + (f'<w:sz w:val="{size}"/>' if size else "")
    parts = str(text).split("\n")
    inner = "<w:br/>".join(f'<w:t xml:space="preserve">{esc(p)}</w:t>' for p in parts)
    return f"<w:r>{'<w:rPr>' + rpr + '</w:rPr>' if rpr else ''}{inner}</w:r>"


def _p(inner: str, style: str | None = None, extra: str = "") -> str:
    ppr = (f'<w:pStyle w:val="{style}"/>' if style else "") + extra
    return f"<w:p>{'<w:pPr>' + ppr + '</w:pPr>' if ppr else ''}{inner}</w:p>"


def _cell(inner: str, width: int, shade: str | None = None) -> str:
    sh = f'<w:shd w:val="clear" w:color="auto" w:fill="{shade}"/>' if shade else ""
    return f'<w:tc><w:tcPr><w:tcW w:w="{width}" w:type="dxa"/>{sh}</w:tcPr>{inner or "<w:p/>"}</w:tc>'


def _table(rows: list[list[str]], widths: list[int], border: str) -> str:
    b = "".join(f'<w:{s} w:val="single" w:sz="4" w:space="0" w:color="{border}"/>'
                for s in ("top", "left", "bottom", "right", "insideH", "insideV"))
    grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in widths)
    trs = "".join("<w:tr>" + "".join(r) + "</w:tr>" for r in rows)
    return (f'<w:tbl><w:tblPr><w:tblW w:w="{sum(widths)}" w:type="dxa"/><w:tblBorders>{b}</w:tblBorders>'
            f'</w:tblPr><w:tblGrid>{grid}</w:tblGrid>{trs}</w:tbl>')


class _Media:
    def __init__(self, pic_bytes):
        self.fetch = pic_bytes
        self.media: list = []
        self.rels: list = []
        self.by_url: dict = {}
        self.n = 0

    def drawing(self, url: str | None, alt: str, max_mm: float) -> str:
        from .exporters.images import UnsupportedImage, load_image  # noqa: PLC0415
        if not url:
            return ""
        if url not in self.by_url:
            try:
                data = self.fetch(url) if self.fetch else None
                info = load_image(data) if data else None
            except (UnsupportedImage, ValueError, Exception):  # noqa: BLE001 - an SVG or a broken picture: left out
                info, data = None, None
            if not info or info.mime not in ("image/png", "image/jpeg"):
                self.by_url[url] = None
            else:
                ext = "png" if info.mime == "image/png" else "jpg"
                rid = f"rIdImg{len(self.rels) + 1}"
                name = f"media/binder{len(self.rels) + 1}.{ext}"
                self.media.append((f"word/{name}", data))
                self.rels.append((rid, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
                                  name))
                self.by_url[url] = (rid, info.width, info.height)
        got = self.by_url[url]
        if not got:
            return ""
        rid, w, h = got
        scale = min(1.0, (max_mm * EMU_PER_MM) / max(w * 9525, 1), (max_mm * EMU_PER_MM) / max(h * 9525, 1))
        self.n += 1
        return _drawing(rid, self.n, int(w * 9525 * scale), int(h * 9525 * scale), f"Picture {self.n}", 1, alt)


def _value(f: dict) -> str:
    v = (f or {}).get("value")
    s = "" if v in (None, "") else str(v)
    return "" if s.startswith("/api/") else s


def _field_runs(f: dict, accent: str) -> str:
    v = _value(f)
    if not v:
        return _run("—", color="999999")
    out = _run(v)
    if f.get("status") == "proposed":
        out += _run("  (proposed)", italic=True, color=accent, size=16)
    if f.get("draft"):
        out += _run("  (draft)", italic=True, color="888888", size=16)
    return out


def _pic_paras(media: _Media, pic: dict | None, max_mm: float) -> str:
    if not pic:
        return ""
    items = pic.get("items") or [pic]
    runs = "".join(media.drawing(i.get("png_url") or i.get("url"), i.get("alt") or "", max_mm if len(items) == 1
                                 else 30) for i in items)
    return _p(runs) if runs else ""


def build_docx(data: dict, *, pic_bytes=None) -> bytes:
    look = data["book"]["look"]
    v = LOOK_VARS.get(look) or LOOK_VARS["classic"]
    accent, accent2, rule = v[2].lstrip("#").upper(), v[3].lstrip("#").upper(), v[4].lstrip("#").upper()
    media = _Media(pic_bytes)
    body = []
    first = True
    for p in data["pages"]:
        tpl = schema()[p["template"]]
        brk = "" if first else "<w:pageBreakBefore/>"
        first = False
        body.append(_p(_run(f"{p.get('icon') or ''} {p['title']}".strip(), bold=True, color=accent, size=40), "Heading1",
                       brk))
        body.append(_p(_run(f"{STATUS_WORDS.get(p['status'], p['status'])} · page {p['page']} · "
                            f"{data['book']['title']}", italic=True, color="777777", size=16)))
        for sec in tpl["sections"]:
            code = sec["code"]
            s = p["sections"].get(code) or {"fields": {}}
            body.append(_p(_run(f"{section_title(sec)}  ", bold=True, color=accent, size=26)
                           + _run(code, color=accent2, size=16), "Heading2"))
            if "rows" in s:
                if not s["rows"]:
                    body.append(_p(_run("Nothing here yet.", italic=True, color="999999")))
                    continue
                n = len(sec["fields"])
                w = 9000 // max(n, 1)
                rows = [[_cell(_p(_run(clean_label(fd["label"]), bold=True, size=18)), w, rule) for fd in sec["fields"]]]
                for i, r in enumerate(s["rows"]):
                    cells = []
                    for fd in sec["fields"]:
                        pic = p["pics"].get(f"{fd['id']}#{i + 1}")
                        inner = _pic_paras(media, pic, 25) + _p(_field_runs(r.get(fd["id"]) or {}, accent))
                        cells.append(_cell(inner, w))
                    rows.append(cells)
                body.append(_table(rows, [w] * n, rule))
                continue
            rows = []
            for fd in sec["fields"]:
                f = s["fields"].get(fd["id"]) or {}
                pic = p["pics"].get(fd["id"])
                label = _p(_run(clean_label(fd["label"]), size=18) + _run(f"  {fd['id']}", color="999999", size=14))
                val = _pic_paras(media, pic, 70 if p["template"] in ("1", "9") else 55) + \
                    _p(_field_runs(f, accent) if not (pic and not _value(f)) else "")
                rows.append([_cell(label, 3000, rule), _cell(val, 6000)])
            body.append(_table(rows, [3000, 6000], rule))
    title, author = data["book"]["title"], data["book"].get("author") or ""
    document = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                f'<w:document xmlns:w="{W}" xmlns:r="{R}" '
                'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
                'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
                'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>' + "".join(body)
                + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" '
                  'w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>\n')
    font = "Georgia"
    styles = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
              f'<w:styles xmlns:w="{W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="{font}" '
              f'w:hAnsi="{font}" w:cs="{font}"/><w:sz w:val="20"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>'
              '<w:spacing w:after="40"/></w:pPr></w:pPrDefault></w:docDefaults>'
              '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
              '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>'
              '<w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="120"/><w:outlineLvl w:val="0"/>'
              f'</w:pPr><w:rPr><w:b/><w:color w:val="{accent}"/><w:sz w:val="40"/></w:rPr></w:style>'
              '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>'
              '<w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="1"/>'
              f'</w:pPr><w:rPr><w:b/><w:color w:val="{accent}"/><w:sz w:val="26"/></w:rPr></w:style></w:styles>\n')
    rels = [("rIdStyles", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles", "styles.xml")] \
        + media.rels
    doc_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                f'<Relationships xmlns="{PKG_REL}">' + "".join(
                    f'<Relationship Id="{i}" Type="{t}" Target="{tg}"/>' for i, t, tg in rels) + "</Relationships>\n")
    pkg_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                f'<Relationships xmlns="{PKG_REL}">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
                'officeDocument" Target="word/document.xml"/>'
                '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/'
                'core-properties" Target="docProps/core.xml"/></Relationships>\n')
    core = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            f'<dc:title>{esc(title + " — Book Bible")}</dc:title><dc:creator>{esc(author)}</dc:creator>'
            f'<dc:subject>Book Bible ({esc(look)} look)</dc:subject></cp:coreProperties>\n')
    exts = sorted({n.rsplit(".", 1)[1] for n, _ in media.media})
    types = {"png": "image/png", "jpg": "image/jpeg"}
    ctypes = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
              f'<Types xmlns="{CT}">'
              '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
              '<Default Extension="xml" ContentType="application/xml"/>'
              + "".join(f'<Default Extension="{e}" ContentType="{types[e]}"/>' for e in exts)
              + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.'
                'wordprocessingml.document.main+xml"/>'
              '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.'
              'wordprocessingml.styles+xml"/>'
              '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.'
              'core-properties+xml"/></Types>\n')
    entries = [("[Content_Types].xml", ctypes.encode()), ("_rels/.rels", pkg_rels.encode()),
               ("docProps/core.xml", core.encode("utf-8")), ("word/document.xml", document.encode("utf-8")),
               ("word/styles.xml", styles.encode("utf-8")), ("word/_rels/document.xml.rels", doc_rels.encode())] \
        + media.media
    return build_zip(entries)
