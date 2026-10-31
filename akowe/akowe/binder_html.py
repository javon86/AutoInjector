"""📖 The Book Bible binder as ONE self-contained HTML document (inline CSS, pictures as data: URIs, no scripts) —
what AutoInjector prints to PDF (``POST /render/pdf``) and what "⬇ HTML" downloads.

It uses the same template structure as the web page (``binder.build``'s contract: one ``<section class="page">``
per template instance, one ``.box`` per schema section with its fact table or row table, the field ids as
``data-id``) and the 7 looks as CSS variables (``LOOK_VARS``). This is the PRINT version of each look: light paper,
the look's accent colours kept (the dark looks — sci-fi, noir, horror — invert to light paper). System fonts only.
"""
from __future__ import annotations

import base64
from html import escape

from .binder import TEMPLATE_ICONS, clean_label, schema, section_title

# look -> print variables (paper, ink, accent, accent 2, rule, muted, heading font, body font, label font, radius)
LOOK_VARS = {
    "classic": ("#fbf7ee", "#1f2a24", "#1f4d3a", "#b08d3c", "#c9b27a", "#6b6455",
                "Georgia, 'Times New Roman', serif", "Georgia, 'Times New Roman', serif",
                "'Gill Sans', 'Segoe UI', sans-serif", "4px"),
    "fantasy": ("#f6ecd6", "#2b1d14", "#7a1f2b", "#a8873a", "#c7a560", "#6e5a44",
                "'Palatino Linotype', Palatino, 'Book Antiqua', serif", "'Palatino Linotype', Palatino, serif",
                "'Palatino Linotype', Palatino, serif", "2px"),
    "scifi": ("#f4f7f9", "#11161c", "#0a8fa8", "#6c4bd1", "#9fb7c4", "#56636e",
              "'Segoe UI', 'Helvetica Neue', Arial, sans-serif", "'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
              "Consolas, 'Courier New', monospace", "0px"),
    "noir": ("#f5f3ee", "#1b1b1b", "#b3161b", "#3a3a3a", "#8c8c8c", "#5a5a5a",
             "'Courier New', Courier, monospace", "Georgia, 'Times New Roman', serif",
             "'Courier New', Courier, monospace", "0px"),
    "romance": ("#fdf5f3", "#3b2a2e", "#b4516b", "#b9975b", "#e3b8c2", "#7d6468",
                "'Brush Script MT', 'Segoe Script', Georgia, cursive", "Georgia, 'Times New Roman', serif",
                "'Segoe UI', sans-serif", "14px"),
    "horror": ("#f3efe6", "#161212", "#8a0f0f", "#4a3b32", "#a59a8a", "#5e544c",
               "'Arial Narrow', 'Franklin Gothic Medium', Impact, sans-serif", "Georgia, 'Times New Roman', serif",
               "'Arial Narrow', Arial, sans-serif", "1px"),
    "playful": ("#fffdf5", "#24323f", "#ff6b35", "#2ab7ca", "#ffd166", "#5b6b78",
                "'Comic Sans MS', 'Trebuchet MS', 'Segoe UI', sans-serif",
                "'Trebuchet MS', 'Segoe UI', sans-serif", "'Trebuchet MS', 'Segoe UI', sans-serif", "18px"),
}
STATUS_WORDS = {"approved": "✔ Approved", "draft": "✎ Draft", "needs_you": "⚠ Needs you"}
FIELD_MARK = {"proposed": "proposed", "auto": "auto", "approved": "", "supplied": "", "empty": ""}


def css(look: str, page_size: str = "A4") -> str:
    v = LOOK_VARS.get(look) or LOOK_VARS["classic"]
    return f""":root{{--paper:{v[0]};--ink:{v[1]};--accent:{v[2]};--accent2:{v[3]};--rule:{v[4]};--muted:{v[5]};
--head:{v[6]};--body:{v[7]};--label:{v[8]};--radius:{v[9]}}}
@page{{size:{'A4' if page_size != 'Letter' else 'Letter'};margin:14mm 13mm 16mm}}
*{{box-sizing:border-box}}
html,body{{margin:0;background:var(--paper);color:var(--ink);font-family:var(--body);font-size:10pt;line-height:1.35}}
.page{{break-after:page;padding:0 0 8mm;position:relative}}
.page:last-child{{break-after:auto}}
.ph{{display:flex;justify-content:space-between;align-items:baseline;gap:8px;border-bottom:2px solid var(--accent);
padding-bottom:3px;margin-bottom:8px;font-family:var(--label);font-size:8pt;color:var(--muted);text-transform:uppercase;
letter-spacing:.08em}}
.ph .pi{{color:var(--accent);font-weight:bold}}
h1{{font-family:var(--head);color:var(--accent);font-size:22pt;margin:4px 0 10px;border-bottom:1px solid var(--accent2);
padding-bottom:4px}}
.badge{{border:1px solid var(--accent2);border-radius:var(--radius);padding:1px 6px;font-size:7.5pt;text-transform:none;
letter-spacing:0}}
.badge.s-needs_you{{border-color:var(--accent);color:var(--accent)}}
.box{{border:1px solid var(--rule);border-left:4px solid var(--accent2);border-radius:var(--radius);padding:6px 8px;
margin:0 0 8px;break-inside:avoid;background:rgba(255,255,255,.35)}}
.box h3{{font-family:var(--head);color:var(--accent);font-size:11.5pt;margin:0 0 4px;display:flex;
justify-content:space-between}}
.box h3 .code{{font-family:var(--label);color:var(--muted);font-size:7pt;font-weight:normal}}
table{{width:100%;border-collapse:collapse}}
th,td{{text-align:left;vertical-align:top;padding:2px 4px;border-bottom:1px dotted var(--rule)}}
th{{width:32%;font-family:var(--label);font-weight:normal;color:var(--muted);font-size:8.5pt}}
th small{{display:block;font-size:6.5pt;opacity:.7}}
table.rows th{{width:auto;border-bottom:1px solid var(--accent2)}}
td{{white-space:pre-wrap}}
td.empty{{color:var(--muted);opacity:.6}}
.mark{{font-family:var(--label);font-size:6.5pt;color:var(--accent);border:1px solid var(--accent);border-radius:3px;
padding:0 3px;margin-left:4px;white-space:nowrap}}
.new{{color:var(--accent2);border-color:var(--accent2)}}
img.pic{{max-width:100%;max-height:70mm;border:1px solid var(--rule);border-radius:var(--radius);display:block}}
img.thumb{{max-height:22mm;max-width:30mm;border-radius:var(--radius);display:inline-block;margin:0 3px 3px 0}}
.cover{{text-align:center;padding-top:20mm}}
.cover .label{{font-family:var(--label);letter-spacing:.3em;color:var(--accent2);font-size:9pt}}
.cover h1{{font-size:34pt;border:0}}
.cover img.pic{{margin:8mm auto;max-height:110mm}}
.stamp{{display:inline-block;border:2px solid var(--accent);color:var(--accent);padding:4px 10px;transform:rotate(-3deg);
font-family:var(--label);margin-top:8mm}}
.bar{{height:6px;background:var(--rule);border-radius:3px;overflow:hidden;margin-top:2px}}
.bar i{{display:block;height:100%;background:var(--accent)}}
.pf{{position:absolute;bottom:0;left:0;right:0;display:flex;justify-content:space-between;border-top:1px solid var(--rule);
font-family:var(--label);font-size:7pt;color:var(--muted);padding-top:2px}}
.toc td{{border-bottom:1px dotted var(--rule)}}
.toc td.n{{text-align:right;width:12%}}
svg.graph{{width:100%;height:auto;max-height:120mm}}
"""


def _data_uri(data: bytes) -> str | None:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        mime = "image/png"
    elif data[:3] == b"\xff\xd8\xff":
        mime = "image/jpeg"
    elif data.lstrip()[:5] in (b"<?xml", b"<svg ") or b"<svg" in data[:300]:
        mime = "image/svg+xml"
    else:
        return None
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


class _Pics:
    def __init__(self, pic_bytes):
        self.fetch, self.cache = pic_bytes, {}

    def uri(self, url: str | None) -> str | None:
        if not url:
            return None
        if url not in self.cache:
            try:
                data = self.fetch(url) if self.fetch else None
            except Exception:  # noqa: BLE001 - a missing picture is left out
                data = None
            self.cache[url] = _data_uri(data) if data else None
        return self.cache[url]


def _value(f: dict) -> str:
    v = f.get("value")
    return "" if v in (None, "") else str(v)


def _cell(f: dict, pic: dict | None, pics: _Pics, fid: str) -> str:
    if pic:
        items = pic.get("items") or [pic]
        imgs = "".join(f'<img class="{"pic" if len(items) == 1 else "thumb"}" src="{u}" alt="{escape(i.get("alt") or "")}">'
                       for i in items for u in [pics.uri(i.get("png_url") or i.get("url"))] if u)
        if imgs:
            txt = _value(f) if not str(f.get("value") or "").startswith("/api/") else ""
            return f'<td data-id="{fid}">{imgs}{escape(txt)}</td>'
    v = _value(f)
    if str(v).startswith("/api/"):
        v = ""
    marks = ""
    if f.get("status") == "proposed":
        marks += '<span class="mark">proposed</span>'
    if f.get("new"):
        marks += '<span class="mark new">new</span>'
    if f.get("draft"):
        marks += '<span class="mark">draft</span>'
    if not v:
        return f'<td class="empty" data-id="{fid}">—{marks if f.get("new") else ""}</td>'
    if fid == "1.4.1" and v.endswith("%"):
        try:
            pct = max(0, min(100, int(v[:-1])))
            return f'<td data-id="{fid}">{escape(v)}<div class="bar"><i style="width:{pct}%"></i></div></td>'
        except ValueError:
            pass
    if f.get("source", "").startswith("new:stat_") and isinstance(f.get("value"), int):
        pct = f["value"] * 10
        return f'<td data-id="{fid}">{f["value"]} / 10{marks}<div class="bar"><i style="width:{pct}%"></i></div></td>'
    return f'<td data-id="{fid}">{escape(v)}{marks}</td>'


def _graph_svg(g: dict) -> str:
    import math  # noqa: PLC0415
    nodes = g.get("nodes") or []
    if not nodes:
        return ""
    w, h = 600, 380
    cx, cy = w / 2, h / 2
    pos = {}
    rings: dict = {}
    for n in nodes:
        rings.setdefault(n.get("ring", 1), []).append(n)
    for r, ns in rings.items():
        rad = 0 if r == 0 else min(160, 70 * r)
        for i, n in enumerate(ns):
            a = 2 * math.pi * i / max(1, len(ns)) - math.pi / 2
            pos[n["id"]] = (cx + rad * math.cos(a), cy + rad * math.sin(a))
    out = [f'<svg class="graph" viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg">']
    for e in g.get("edges") or []:
        a, b = pos.get(e["from"]), pos.get(e["to"])
        if a and b:
            out.append(f'<line x1="{a[0]:.0f}" y1="{a[1]:.0f}" x2="{b[0]:.0f}" y2="{b[1]:.0f}" '
                       f'stroke="{escape(e.get("colour") or "#888")}" stroke-width="2"/>')
    for n in nodes:
        x, y = pos[n["id"]]
        out.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{22 if n.get("ring") == 0 else 16}" '
                   'fill="var(--paper)" stroke="var(--accent)" stroke-width="2"/>')
        out.append(f'<text x="{x:.0f}" y="{y + 34:.0f}" text-anchor="middle" font-size="12" '
                   f'fill="currentColor">{escape(n["name"])}</text>')
    out.append("</svg>")
    return "".join(out)


def _page(p: dict, data: dict, pics: _Pics) -> str:
    tpl = schema()[p["template"]]
    book = data["book"]
    body = []
    if p["template"] == "1":
        f = {k: v for s in p["sections"].values() for k, v in s["fields"].items()}
        art = pics.uri((p["pics"].get("1.2.1") or {}).get("url"))
        body.append('<div class="cover">'
                    f'<div class="label">{escape(_value(f["1.3.1"]))} · {escape(_value(f["1.3.2"]))}</div>'
                    f'<h1>{escape(_value(f["1.1.1"]))}</h1>'
                    + (f'<div>{escape(_value(f["1.1.2"]))}</div>' if _value(f["1.1.2"]) else "")
                    + f'<div><b>{escape(_value(f["1.1.3"]))}</b></div>'
                    + (f'<div>{escape(_value(f["1.1.4"]))}</div>' if _value(f["1.1.4"]) else "")
                    + (f'<img class="pic" src="{art}" alt="cover art">' if art else
                       f'<div class="stamp">{TEMPLATE_ICONS["1"]} BOOK BIBLE</div>')
                    + "</div>")
    else:
        body.append(f'<h1>{escape(p["title"])}</h1>')
    if p["template"] == "6" and p.get("graph"):
        body.append(f'<div class="box">{_graph_svg(p["graph"])}</div>')
    for sec in tpl["sections"]:
        code = sec["code"]
        s = p["sections"].get(code) or {"fields": {}}
        if p["template"] == "1" and code == "1.1":
            continue
        head = f'<h3>{escape(section_title(sec))}<span class="code">{escape(code)}</span></h3>'
        if code == "2.1":
            rows = "".join(f'<tr><td>{escape(_value(r["2.1.1"]))}</td><td>{escape(_value(r["2.1.2"]))}</td>'
                           f'<td class="n">{escape(_value(r["2.1.3"]))}</td></tr>' for r in s.get("rows") or [])
            body.append(f'<div class="box">{head}<table class="toc">{rows}</table></div>')
            continue
        if "rows" in s:
            labels = "".join(f"<th>{escape(clean_label(fd['label']))}</th>" for fd in sec["fields"])
            trs = []
            for i, r in enumerate(s["rows"]):
                tds = "".join(_cell(r.get(fd["id"]) or {}, p["pics"].get(f"{fd['id']}#{i + 1}"), pics, fd["id"])
                              for fd in sec["fields"])
                trs.append(f"<tr>{tds}</tr>")
            inner = f'<table class="rows"><thead><tr>{labels}</tr></thead><tbody>{"".join(trs)}</tbody></table>' \
                if trs else '<p class="empty">Nothing here yet.</p>'
            body.append(f'<div class="box">{head}{inner}</div>')
            continue
        trs = []
        for fd in sec["fields"]:
            f = s["fields"].get(fd["id"]) or {}
            trs.append(f'<tr><th>{escape(clean_label(fd["label"]))}<small>{fd["id"]}</small></th>'
                       f'{_cell(f, p["pics"].get(fd["id"]), pics, fd["id"])}</tr>')
        body.append(f'<div class="box">{head}<table>{"".join(trs)}</table></div>')
    status = STATUS_WORDS.get(p["status"], p["status"])
    return (f'<section class="page t-{escape(p["template"])}" id="{escape(p["page_id"])}">'
            f'<header class="ph"><span class="bt">{escape(book["title"])}</span>'
            f'<span class="pi">{TEMPLATE_ICONS.get(p["template"], "")} {escape(p["title"])}</span>'
            f'<span class="badge s-{escape(p["status"])}">{escape(status)}</span></header>'
            + "".join(body)
            + f'<footer class="pf"><span>{escape(book["title"])}</span><span>Page {p["page"]}</span>'
              f'<span>Book Bible · updated {escape(data.get("updated_at") or "")}</span></footer></section>')


def render(data: dict, *, pic_bytes=None, page_size: str = "A4") -> str:
    """The whole binder as one HTML document (``data`` = ``binder.build``)."""
    pics = _Pics(pic_bytes)
    look = data["book"]["look"]
    pages = "".join(_page(p, data, pics) for p in data["pages"])
    return ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
            f"<title>{escape(data['book']['title'])} — Book Bible</title>"
            f"<style>{css(look, page_size)}</style></head>"
            f'<body class="look-{escape(look)}" data-look="{escape(look)}" '
            f'data-generated="{escape(data.get("generated_at") or "")}">{pages}</body></html>')
