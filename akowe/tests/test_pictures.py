"""🖼 B3 interior pictures (pictures.py, docs/PICTURES.md): the prompt builder (scene card, approved looks, the
character lock, the book's art style, ≤ 1 200 characters), the illustrate job against a fake AutoInjector bridge
(purpose "illustration", characterLock, every error code, the NO_LOCK fallback), candidates and choosing one, the
"Illustrate every chapter" batch with Stop (chapters that have a chosen picture are skipped), the map (SVG from the
places and the illustrated map), the placement in the PDF / EPUB / DOCX exports, the book save and the HTTP API."""
from __future__ import annotations

import base64
import io
import json
import re
import threading
import time
import types
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pypdf
import pytest
from PIL import Image, ImageDraw

from akowe import forge, pictures
from akowe import providers as prov_mod
from akowe.book_path import BookPath
from akowe.errors import AkoweError
from akowe.exporters import book as bookmod
from akowe.exporters.docx import build_docx, inspect_docx
from akowe.exporters.epub import build_epub, inspect_epub
from akowe.exporters.images import load_image
from akowe.exporters.layout import Typography, make_geometry, paginate
from akowe.exporters.pdf import inspect_pdf, render_pdf

from test_failover_review import SlotFake, make_app, run_book
from test_server import call

BR = "main"


# ====================================================================== helpers
def art(w=320, h=200, hue=0, fmt="PNG") -> bytes:
    """A small picture with something in it (a sky, a sea and a sun) so a rendered page shows it."""
    im = Image.new("RGB", (w, h), (40 + hue % 80, 70, 120))
    d = ImageDraw.Draw(im)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=(60 + y * 120 // h, 90 + (hue * 3 + y) % 90, 150 - y * 60 // h))
    d.rectangle([0, h * 2 // 3, w, h], fill=(20, 60 + hue % 60, 90))
    d.ellipse([w * 3 // 5, h // 6, w * 3 // 5 + h // 4, h // 6 + h // 4], fill=(250, 210, 120))
    buf = io.BytesIO()
    im.save(buf, fmt)
    return buf.getvalue()


class Bridge:
    """A fake AutoInjector POST /image/request: records each body; ``script`` = {call n: (status, body)};
    ``hold`` = {call n: threading.Event} blocks that call until the event is set."""

    def __init__(self):
        self.requests: list = []
        self.script: dict = {}
        self.hold: dict = {}
        self.arrived: dict = {}
        bridge = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                bridge.requests.append(body)
                n = len(bridge.requests)
                if n in bridge.arrived:
                    bridge.arrived[n].set()
                if n in bridge.hold:
                    bridge.hold[n].wait(20)
                if n in bridge.script:
                    status, out = bridge.script[n]
                else:
                    eng = "sd" if body.get("engine") in ("auto", "sd") else "chatgpt"
                    status, out = 200, {"ok": True, "engine": eng, "purpose": body.get("purpose"), "seed": 900 + n,
                                        "images": [{"imageBase64": base64.b64encode(art(hue=n * 37)).decode(),
                                                    "seed": 900 + n}]}
                data = json.dumps(out).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def wait(app, job_id, timeout=30.0):
    return forge.wait(app, "author", job_id, timeout)


@pytest.fixture(scope="module")
def made(tmp_path_factory):
    """One finished Make-a-book run (fake AIs: 3 chapters with scene cards, two characters, one place)."""
    mp = pytest.MonkeyPatch()
    mp.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic, time=time.time))
    app = make_app(tmp_path_factory.mktemp("pictures"), SlotFake())
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    b = Bridge()
    forge.save_bridge_settings(app, {"url": b.url, "token": "pic-token"})
    yield app, run["project_id"], b
    b.close()
    mp.undo()


@pytest.fixture
def bk(made):
    """The made book with an empty Pictures page and a fresh bridge script."""
    app, pid, b = made
    app.store.set_setting(pictures._key(pid, BR), pictures._empty())  # noqa: SLF001
    b.requests.clear()
    b.script.clear()
    b.hold.clear()
    b.arrived.clear()
    return app, pid, b


def chs(app, pid):
    return pictures.chapters(app, "author", pid, BR)


def illustrate(app, pid, body):
    j = pictures.start_illustrate(app, "author", pid, BR, body)
    return wait(app, j["job_id"]), j


def pic(app, pid, pic_id):
    return pictures.public_picture(pid, BR, pictures.doc(app.store, pid, BR)["pictures"][pic_id])


def mara(app, pid):
    return next(c for c in forge.list_dossiers(app.store, pid, BR) if c["name"] == "Mara Vell")["record_id"]


# ====================================================================== the prompt
def test_build_prompt_has_style_moment_looks_and_lock_and_is_capped():
    ctx = {"number": 2, "scene": 1, "place": "the reef at low tide", "time": "dusk",
           "moment": "Mara finds the brass key", "characters": [{"name": "Mara Vell"}, {"name": "Tom Reed"}]}
    p = pictures.build_prompt(ctx, {"Mara Vell": "silver scar over the left brow; oilskin coat"}, "ink wash",
                              "Mara Vell")
    assert p.startswith("Art style: ink wash. Book illustration for chapter 2, scene 1: Mara finds the brass key.")
    assert "Setting: the reef at low tide, dusk." in p and "Mara Vell (silver scar over the left brow; oilskin coat)" in p
    assert "Tom Reed" in p and "Character lock: Mara Vell." in p and "No text" in p
    long = {n: "very " * 400 + "long look" for n in ("Mara Vell", "Tom Reed")}
    ctx2 = dict(ctx, moment="m " * 600, place="p " * 300, characters=[{"name": f"Person {i}"} for i in range(4)])
    p2 = pictures.build_prompt(ctx2, {**long, **{f"Person {i}": "tall " * 300 for i in range(4)}}, "x" * 500, "Mara")
    assert len(p2) <= pictures.PROMPT_MAX and "Character lock: Mara." in p2 and p2.endswith("watermark in the picture.")
    assert all(f"Person {i}" in p2 for i in range(4))  # every character keeps a place, each look is shortened
    assert pictures.build_prompt({"number": 1, "characters": []}, {}, "").startswith(
        "Art style: detailed book illustration. Book illustration for chapter 1.")


def test_prompt_uses_the_scene_card_approved_looks_and_never_proposals(bk):
    app, pid, _b = bk
    rid = mara(app, pid)
    forge.edit(app.store, pid, BR, rid, {"sections": {"continuity": {"visual_anchors": {
        "text": "a silver scar over the left brow; a yellow oilskin coat"}}}})
    forge.apply_proposals(app.store, pid, BR, rid, {"hair": "PROPOSED green hair"}, slot="AI-1")
    pictures.set_style(app.store, pid, BR, {"style": "ink wash"})
    c2 = chs(app, pid)[1]
    out = pictures.prompt_for(app, "author", pid, BR, c2["chapter_id"], 2)
    p = out["prompt"]
    assert out["lock"] == "Mara Vell" and out["characters"][0] == "Mara Vell"
    assert p.startswith("Art style: ink wash. Book illustration for chapter 2, scene 2:")
    assert c2["cards"][1]["place"] in p and c2["cards"][1]["time"] in p and c2["cards"][1]["moment"] in p
    assert "Fixed" not in p and "silver scar over the left brow" in p and "PROPOSED" not in p
    assert len(p) <= pictures.PROMPT_MAX
    with pytest.raises(AkoweError):
        pictures.prompt_for(app, "author", pid, BR, c2["chapter_id"], 6)  # no 6th scene card


# ====================================================================== the illustrate job
def test_illustrate_calls_the_bridge_and_chooses_the_single_picture(bk):
    app, pid, b = bk
    pictures.set_style(app.store, pid, BR, {"style": "painterly"})
    c1 = chs(app, pid)[0]
    j, start = illustrate(app, pid, {"chapter_id": c1["chapter_id"], "engine": "sd"})
    assert j["status"] == "done" and j["done"] == 1 and j["total"] == 1 and start["pic_id"] == j["pic_id"]
    body = b.requests[0]
    assert body["purpose"] == "illustration" and body["engine"] == "sd" and body["characterLock"] == "Mara Vell"
    assert body["from"] == "akowe-pictures" and body["returnImage"] is True and body["book"]
    assert body["prompt"].startswith("Art style: painterly.") and len(body["prompt"]) <= pictures.PROMPT_MAX
    p = pic(app, pid, j["pic_id"])
    assert p["kind"] == "chapter" and p["chapter_id"] == c1["chapter_id"] and p["scene"] is None
    assert p["chosen"] == 0 and p["picture"]["source"] == "sd" and p["picture"]["seed"] == 901
    assert p["placement"] == {"where": "start", "scene": None} and p["prompt"] == body["prompt"]
    rec = app.store.get_record(pid, BR, p["picture"]["asset_id"], 1)
    assert app.store.read_binary(rec) == art(hue=37)
    # the same chapter again: a new candidate on the SAME picture; the chosen one stays until the author picks
    j2, _ = illustrate(app, pid, {"chapter_id": c1["chapter_id"], "engine": "chatgpt", "count": 2})
    assert j2["status"] == "done" and j2["pic_id"] == j["pic_id"] and j2["done"] == 2
    assert [r["engine"] for r in b.requests[1:]] == ["chatgpt", "chatgpt"]
    p = pic(app, pid, j["pic_id"])
    assert len(p["candidates"]) == 3 and p["chosen"] == 0 and "pick the one" in j2["results"][-1]["message"]
    for bad in ({"chapter_id": "nope"}, {"chapter_id": c1["chapter_id"], "engine": "dalle"},
                {"chapter_id": c1["chapter_id"], "count": 4}, {"chapter_id": c1["chapter_id"], "scene": 9}):
        with pytest.raises(AkoweError):
            pictures.start_illustrate(app, "author", pid, BR, bad)


def test_candidates_pick_one_caption_alt_placement_and_delete(bk):
    app, pid, _b = bk
    c2 = chs(app, pid)[1]
    j, _ = illustrate(app, pid, {"chapter_id": c2["chapter_id"], "scene": 2, "count": 3})
    assert j["status"] == "done" and j["done"] == 3
    p = pic(app, pid, j["pic_id"])
    assert p["scene"] == 2 and len(p["candidates"]) == 3 and p["chosen"] is None and p["picture"] is None
    assert p["placement"] == {"where": "after_scene", "scene": 1}  # at the start of scene 2
    out = pictures.update(app.store, pid, BR, p["id"], {"chosen": 2, "caption": "Dusk on the reef",
                                                        "alt": "Mara on the wet reef at dusk",
                                                        "placement": {"where": "end"}})
    q = out["picture"]
    assert q["chosen"] == 2 and q["picture"]["index"] == 2 and q["picture"]["chosen"]
    assert q["caption"] == "Dusk on the reef" and q["alt"].startswith("Mara") and q["placement"]["where"] == "end"
    for bad in ({"chosen": 3}, {"chosen": True}, {"placement": {"where": "middle"}},
                {"placement": {"where": "after_scene"}}, {"caption": "x" * 301}, {"bogus": 1}, {}):
        with pytest.raises(AkoweError):
            pictures.update(app.store, pid, BR, p["id"], bad)
    assert pictures.update(app.store, pid, BR, p["id"], {"chosen": None})["picture"]["picture"] is None
    # never more than MAX_CANDIDATES; the chosen one is kept
    pictures.update(app.store, pid, BR, p["id"], {"chosen": 0})
    first = pic(app, pid, p["id"])["candidates"][0]["asset_id"]
    for _ in range(2):
        illustrate(app, pid, {"chapter_id": c2["chapter_id"], "scene": 2, "count": 3})
    q = pic(app, pid, p["id"])
    assert len(q["candidates"]) == pictures.MAX_CANDIDATES and q["picture"]["asset_id"] == first
    assert pictures.delete(app.store, pid, BR, p["id"])["ok"]
    with pytest.raises(AkoweError):
        pictures.delete(app.store, pid, BR, p["id"])


@pytest.mark.parametrize("code", ["SD_NOT_CONNECTED", "CHATGPT_NOT_READY", "IMAGE_REFUSED", "IMAGE_TIMEOUT",
                                  "IMAGE_LIMIT", "NO_IMAGE_ENGINE"])
def test_illustrate_error_codes_are_plain_and_keep_earlier_candidates(bk, code):
    app, pid, b = bk
    b.script[2] = (503 if code != "IMAGE_REFUSED" else 200, {"ok": False, "error": code, "message": "short reason"})
    j, _ = illustrate(app, pid, {"chapter_id": chs(app, pid)[0]["chapter_id"], "count": 3})
    assert j["status"] == "error" and j["error"]["code"] == code
    assert "1 picture(s) made before are kept" in j["error"]["message"]
    assert j["error"]["fix"] == forge.ART_PROBLEMS[code][1]
    assert len(pic(app, pid, j["pic_id"])["candidates"]) == 1


def test_no_lock_fallback_bad_answer_wrong_key_and_unreachable(bk):
    app, pid, b = bk
    cid = chs(app, pid)[0]["chapter_id"]
    b.script[1] = (400, {"ok": False, "error": "NO_LOCK", "message": "no lock"})
    j, _ = illustrate(app, pid, {"chapter_id": cid})
    assert j["status"] == "done" and "characterLock" in b.requests[0] and "characterLock" not in b.requests[1]
    assert "no character lock named Mara Vell" in pic(app, pid, j["pic_id"])["picture"]["warnings"]
    b.script[3] = (200, {"ok": True, "engine": "sd", "images": []})
    assert illustrate(app, pid, {"chapter_id": cid})[0]["error"]["code"] == "IMAGE_BAD_ANSWER"
    b.script[4] = (401, {"ok": False, "error": "UNAUTHORIZED"})
    assert illustrate(app, pid, {"chapter_id": cid})[0]["error"]["code"] == "IMAGE_BRIDGE_KEY"
    good = b.url
    forge.save_bridge_settings(app, {"url": "http://127.0.0.1:9"})
    try:
        assert illustrate(app, pid, {"chapter_id": cid})[0]["error"]["code"] == "IMAGE_BRIDGE_UNREACHABLE"
    finally:
        forge.save_bridge_settings(app, {"url": good})


# ====================================================================== the batch
def test_illustrate_every_chapter_skips_chosen_ones_and_stops(bk):
    app, pid, b = bk
    c = chs(app, pid)
    assert len(c) == 3
    pictures.upload(app, "author", pid, BR, {"chapter": [c[0]["chapter_id"]]}, art(hue=5))  # chapter 1: own picture
    b.arrived[1], b.hold[1] = threading.Event(), threading.Event()
    j = pictures.start_illustrate_all(app, "author", pid, BR, {"engine": "sd"})
    assert j["total"] == 2  # chapters 2 and 3
    assert b.arrived[1].wait(10)
    stopped = app.review.cancel_job("author", j["job_id"])
    assert stopped["phase"].startswith("Stopping")
    b.hold[1].set()
    j = wait(app, j["job_id"])
    assert j["status"] == "cancelled" and j["done"] == 1 and len(b.requests) == 1
    d = pictures.doc(app.store, pid, BR)
    assert pictures.has_chosen(d, c[1]["chapter_id"]) and not pictures.has_chosen(d, c[2]["chapter_id"])
    assert b.requests[0]["purpose"] == "illustration" and "chapter 2" in b.requests[0]["prompt"]
    # again: only chapter 3 is left
    j = wait(app, pictures.start_illustrate_all(app, "author", pid, BR, {"engine": "sd"})["job_id"])
    assert j["status"] == "done" and j["total"] == 1 and len(b.requests) == 2 and "chapter 3" in b.requests[1]["prompt"]
    assert "2 chapter(s) already had a picture" in j["results"][-1]["message"]
    first = pictures.public_picture(pid, BR, pictures._find(pictures.doc(app.store, pid, BR), "chapter",  # noqa: SLF001
                                                            c[0]["chapter_id"], None))
    assert first["picture"]["source"] == "upload"  # never replaced
    # nothing left: an empty job
    j = wait(app, pictures.start_illustrate_all(app, "author", pid, BR, {})["job_id"])
    assert j["status"] == "done" and j["total"] == 0 and len(b.requests) == 2
    # an error stops the batch and keeps what was made
    pictures.delete(app.store, pid, BR, first["id"])
    b.script[3] = (503, {"ok": False, "error": "SD_NOT_CONNECTED"})
    j = wait(app, pictures.start_illustrate_all(app, "author", pid, BR, {})["job_id"])
    assert j["status"] == "error" and j["error"]["code"] == "SD_NOT_CONNECTED"


# ====================================================================== the map
def test_svg_map_from_the_places_and_the_illustrated_map(bk):
    app, pid, b = bk
    out = pictures.make_svg_map(app, "author", pid, BR)
    m = out["picture"]
    assert m["kind"] == "map" and m["chosen"] == 0 and m["picture"]["vector"] and m["picture"]["mime"] == "image/svg+xml"
    assert m["placement"] == {"where": "before", "scene": None}
    svg = app.store.read_binary(app.store.get_record(pid, BR, m["picture"]["asset_id"], 1))
    labels, _edges = pictures.d_maps.read_svg(svg)
    assert [x["rendered_text"] for x in labels] == ["Gullhaven Harbor"] and b"<script" not in svg
    vb = [float(v) for v in re.search(rb'viewBox="([^"]+)"', svg).group(1).split()]
    assert vb[2] > 0.3  # widened (from 0.2) so the name is not cut off
    j = wait(app, pictures.start_map_illustrated(app, "author", pid, BR, {"engine": "chatgpt"})["job_id"])
    assert j["status"] == "done"
    body = b.requests[-1]
    assert body["purpose"] == "map" and body["engine"] == "chatgpt" and "characterLock" not in body
    assert "Gullhaven Harbor" in body["prompt"] and "top-down" in body["prompt"] and len(body["prompt"]) <= 1200
    m = pic(app, pid, m["id"])
    assert len(m["candidates"]) == 2 and m["chosen"] == 1 and not m["picture"]["vector"]
    with pytest.raises(AkoweError):
        pictures.start_map_illustrated(app, "author", pid, BR, {"engine": "x"})


def test_map_route_layout_and_own_coordinates():
    places = [{"subject_id": s, "name": n} for s, n in (("a", "Ash"), ("b", "Birch"), ("c", "Cedar"))]
    app = types.SimpleNamespace()
    recs = []
    for i, p in enumerate(places):
        facts = [{"subject_id": p["subject_id"], "predicate": "entity.name", "value": p["name"],
                  "assertion_type": "FACT", "effective_to": None}]
        if i < 3:
            facts += [{"subject_id": p["subject_id"], "predicate": pr, "value": v, "assertion_type": "FACT",
                       "effective_to": None} for pr, v in (("x.map.x", i * 10), ("x.map.y", 5))]
        recs.append({"data": {"facts": facts}, "ref": {"record_id": f"A04-{i}"}})
    graph, problems = pictures.d_maps.extract_graph({"data": {"facts": [f for r in recs for f in r["data"]["facts"]]},
                                                     "ref": recs[0]["ref"]}, recs, None)
    assert not problems and [n["x"] for n in graph["nodes"]] == [0, 10, 20]
    svg = pictures._fit_labels(pictures.d_maps.render_svg(graph, title="t"), graph)  # noqa: SLF001
    assert [x["rendered_text"] for x in pictures.d_maps.read_svg(svg)[0]] == ["Ash", "Birch", "Cedar"]
    assert app is not None


# ====================================================================== exporters (unit)
def _tiny_book():
    chapters = [{"id": "c1", "text": "# One\nFirst para.\nSecond.\n***\nScene two.\n***\nScene three."},
                {"id": "c2", "text": "# Two\nOnly scene."}]
    return bookmod.build_book({"title": "T", "author": "A", "language": "en", "identifier": "urn:x"}, chapters)


def test_place_pictures_modes_and_plates_stay_out_of_the_contents():
    book = _tiny_book()
    blk = lambda i: {"t": "img", "id": i, "key": "k", "w_mm": 100, "h_mm": 60, "fit": "CONTAIN"}  # noqa: E731
    bookmod.place_pictures(book["sections"], [
        {"block": blk("m"), "section_id": "c1", "where": "before"},
        {"block": blk("s1"), "section_id": "c1", "where": "start"},
        {"block": blk("s2"), "section_id": "c1", "where": "start"},
        {"block": blk("a1"), "section_id": "c1", "where": "after_scene", "scene": 1},
        {"block": blk("a9"), "section_id": "c1", "where": "after_scene", "scene": 9},
        {"block": blk("e"), "section_id": "c2", "where": "end"},
        {"block": blk("x"), "section_id": "nope", "where": "end"}])
    kinds = [(s["id"], s["kind"]) for s in book["sections"]]
    assert kinds == [("plate-m", "plate"), ("c1", "chapter"), ("c2", "chapter")]
    seq = [b.get("id") if b["t"] == "img" else b["t"] for b in book["sections"][1]["blocks"]]
    assert seq == ["s1", "s2", "p", "p", "a1", "break", "p", "break", "p", "a9"]
    assert [b.get("id") for b in book["sections"][2]["blocks"]][-1] == "e"
    assert [e["heading_id"] for e in bookmod.heading_entries(book)] == ["c1", "c2"]


def test_pdf_epub_docx_place_pictures_with_captions_and_the_vector_map():
    book = _tiny_book()
    raw = art()
    info = load_image(raw, "image/png")
    svg = pictures._fit_labels(pictures.d_maps.render_svg(  # noqa: SLF001
        {"coordinate_system": "c", "unit": "world_units", "edges": [{"id": "a->b", "from": "a", "to": "b"}],
         "nodes": [{"id": "a", "x": 0, "y": 0, "label": "Ashport"}, {"id": "b", "x": 100, "y": 40, "label": "Ōbridge"}]},
        title="Map"), {"nodes": [{"x": 0, "y": 0, "label": "Ashport"}, {"x": 100, "y": 40, "label": "Ōbridge"}]})
    bookmod.place_pictures(book["sections"], [
        {"block": {"t": "vmap", "id": "map", "svg": svg.decode(), "w_mm": 150, "h_mm": 120, "caption": "The coast"},
         "section_id": "c1", "where": "before"},
        {"block": {"t": "img", "id": "p1", "key": "k1", "w_mm": 120, "h_mm": 75, "fit": "CONTAIN",
                   "caption": "Mara on the stair", "alt": "A woman climbing"}, "section_id": "c1", "where": "start"}])
    page = {"width_mm": 152.4, "height_mm": 228.6, "bleed_mm": 0, "safe_margin_mm": 15}
    geom = make_geometry(page, {"top": 54, "bottom": 54, "left": 54, "right": 54})
    layout = paginate(book, geom, Typography("times", 11, 14), images={"k1": (info.width, info.height)})
    pdf = render_pdf(layout, page_width=geom.width, page_height=geom.height, meta=book["meta"], images={"k1": info})
    assert not inspect_pdf(pdf)["errors"]
    r = pypdf.PdfReader(io.BytesIO(pdf))
    txt = [p.extract_text() for p in r.pages]
    assert "Ashport" in txt[0] and "Obridge" in txt[0] and "The coast" in txt[0] and "One" not in txt[0]
    assert not r.pages[0]["/Resources"].get("/XObject")  # the map is vector, not a picture
    assert b" c\n" in r.pages[0].get_contents().get_data() or b" c " in r.pages[0].get_contents().get_data()
    assert "One" in txt[1] and "Mara on the stair" in txt[1] and r.pages[1]["/Resources"]["/XObject"]
    ep = build_epub(book, modified="2026-10-27T00:00:00Z", images={"k1": (raw, info)})
    assert not inspect_epub(ep)["errors"]
    z = zipfile.ZipFile(io.BytesIO(ep))
    opf = z.read("OEBPS/content.opf").decode()
    assert 'media-type="image/svg+xml"' in opf and 'media-type="image/png"' in opf
    plate = z.read("OEBPS/text/s001.xhtml").decode()
    assert 'class="plate"' in plate and "<figcaption>The coast</figcaption>" in plate and 'class="map"' in plate
    ch1 = z.read("OEBPS/text/s002.xhtml").decode()
    assert 'alt="A woman climbing"' in ch1 and "<figcaption>Mara on the stair</figcaption>" in ch1
    assert "Ōbridge".encode() in z.read([n for n in z.namelist() if n.endswith(".svg")][0])
    dx = build_docx(book, created="2026-10-27T00:00:00Z", images={"k1": (raw, info)}, page=page)
    assert not inspect_docx(dx)["errors"]
    doc = zipfile.ZipFile(io.BytesIO(dx)).read("word/document.xml").decode()
    assert doc.count("<w:drawing>") == 1 and 'descr="A woman climbing"' in doc
    assert "Mara on the stair" in doc and "the map is in the PDF and EPUB editions" in doc


# ====================================================================== the real exports
def _status(app, pid):
    return {s["id"]: s for s in BookPath(app.engine, "author", pid, BR).status()["steps"]}


def assemble_and_export(app, pid) -> dict:
    bp = BookPath(app.engine, "author", pid, BR)
    out = bp.act("assemble", {})
    assert out["ok"], out
    ids = [i["record_id"] for i in _status(app, pid)["assemble"].get("approve") or []]
    out = BookPath(app.engine, "author", pid, BR).act("approve", {"author_confirms": True, "record_ids": ids})
    assert out["ok"], out
    out = BookPath(app.engine, "author", pid, BR).act("export", {})
    assert out["ok"] and not out.get("problems"), out
    files = {}
    for f in _status(app, pid)["export"]["files"]:
        assert not f["out_of_date"]
        files[f["format"]] = app.store.read_binary(app.store.get_record(pid, BR, f["record_id"], f["version"]))
    return files


def _pages_with_images(pdf: bytes) -> list[int]:
    r = pypdf.PdfReader(io.BytesIO(pdf))
    return [i for i, p in enumerate(r.pages) if (p["/Resources"].get("/XObject") or {})]


def test_exports_place_the_chosen_pictures_with_captions(bk):
    app, pid, b = bk
    c = chs(app, pid)
    j1, _ = illustrate(app, pid, {"chapter_id": c[0]["chapter_id"]})
    pictures.update(app.store, pid, BR, j1["pic_id"], {"caption": "Mara climbs to the dark lamp room",
                                                        "alt": "A woman on a spiral stair"})
    j2, _ = illustrate(app, pid, {"chapter_id": c[1]["chapter_id"], "scene": 2, "count": 2})
    pictures.update(app.store, pid, BR, j2["pic_id"], {"chosen": 1, "caption": "Dusk on the harbour wall"})
    illustrate(app, pid, {"chapter_id": c[2]["chapter_id"], "count": 2})  # nothing chosen: not placed
    m = pictures.make_svg_map(app, "author", pid, BR)["picture"]
    pictures.update(app.store, pid, BR, m["id"], {"caption": "The coast of Gullhaven"})
    assert "pictures changed" in (_status(app, pid)["assemble"].get("reason") or "")
    files = assemble_and_export(app, pid)
    assert not _status(app, pid)["assemble"].get("out_of_date")
    # PDF: the map plate (vector, no picture) right before chapter 1, chapter 1's picture on its first page,
    # chapter 2's scene picture on a page of chapter 2; nothing for chapter 3
    pdf = files["PDF"]
    r = pypdf.PdfReader(io.BytesIO(pdf))
    texts = [p.extract_text() for p in r.pages]
    heads = [next(i for i, t in enumerate(texts) if t.startswith(f"Chapter {n}\n")) for n in (1, 2, 3)]
    assert "The coast of Gullhaven" in texts[heads[0] - 1] and "Gullhaven Harbor" in texts[heads[0] - 1]
    assert not (r.pages[heads[0] - 1]["/Resources"].get("/XObject") or {})
    imgs = _pages_with_images(pdf)
    assert len(imgs) == 2 and imgs[0] == heads[0] and heads[1] <= imgs[1] < heads[2], (imgs, heads)
    assert "Mara climbs to the dark lamp room" in texts[heads[0]]
    assert "Dusk on the harbour wall" in texts[imgs[1]]
    assert len({o for i in imgs for o in r.pages[i]["/Resources"]["/XObject"]}) >= 1
    # EPUB: two pictures (+ the SVG map) with captions and alt text
    z = zipfile.ZipFile(io.BytesIO(files["EPUB"]))
    opf = z.read("OEBPS/content.opf").decode()
    assert opf.count('media-type="image/png"') == 2 and opf.count('media-type="image/svg+xml"') == 1
    xhtml = "".join(z.read(n).decode() for n in z.namelist() if n.endswith(".xhtml"))
    assert "<figcaption>Mara climbs to the dark lamp room</figcaption>" in xhtml
    assert 'alt="A woman on a spiral stair"' in xhtml and "<figcaption>Dusk on the harbour wall</figcaption>" in xhtml
    assert "<figcaption>The coast of Gullhaven</figcaption>" in xhtml and 'class="plate"' in xhtml
    # DOCX: two drawings with captions; the SVG map is named, not drawn
    doc = zipfile.ZipFile(io.BytesIO(files["DOCX"])).read("word/document.xml").decode()
    assert doc.count("<w:drawing>") == 2 and "Dusk on the harbour wall" in doc
    assert "the map is in the PDF and EPUB editions" in doc
    # the illustrated map instead: a picture in all three
    wait(app, pictures.start_map_illustrated(app, "author", pid, BR, {"engine": "sd"})["job_id"])
    files = assemble_and_export(app, pid)
    assert len(_pages_with_images(files["PDF"])) == 3
    assert zipfile.ZipFile(io.BytesIO(files["DOCX"])).read("word/document.xml").decode().count("<w:drawing>") == 3
    assert 'media-type="image/svg+xml"' not in zipfile.ZipFile(io.BytesIO(files["EPUB"])).read(
        "OEBPS/content.opf").decode()
    # no pictures at all again: the book is exactly as before (no picture, no plate)
    app.store.set_setting(pictures._key(pid, BR), pictures._empty())  # noqa: SLF001
    assert _status(app, pid)["assemble"]["out_of_date"]
    files = assemble_and_export(app, pid)
    assert _pages_with_images(files["PDF"]) == []


# ====================================================================== book save
def test_book_save_has_the_pictures_folder(bk):
    app, pid, _b = bk
    c = chs(app, pid)
    illustrate(app, pid, {"chapter_id": c[0]["chapter_id"]})
    illustrate(app, pid, {"chapter_id": c[1]["chapter_id"], "scene": 2})
    pictures.make_svg_map(app, "author", pid, BR)
    pictures.set_style(app.store, pid, BR, {"style": "woodcut"})
    files, _info = app.saver.collect(pid, BR)
    pics = sorted(k for k in files if k.startswith("Pictures/"))
    assert "Pictures/pictures.json" in pics and "Pictures/map.svg" in pics
    assert any(re.match(r"Pictures/ch01 pic-\d{3}\.png$", k) for k in pics)
    assert any(re.match(r"Pictures/ch02 scene 2 pic-\d{3}\.png$", k) for k in pics)
    assert all(len(k) <= 60 for k in pics)
    listing = json.loads(files["Pictures/pictures.json"])
    assert listing["style"] == "woodcut" and len(listing["pictures"]) == 3
    assert all(p.get("file") for p in listing["pictures"])
    res = app.saver.save_now(pid, BR)
    assert res["ok"]


# ====================================================================== HTTP
def test_http_api_contract(bk):
    from akowe.server import make_handler
    app, pid, b = bk
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    base = f"/api/projects/{pid}/branches/{BR}/pictures"
    try:
        st, d, _ = call(port, "GET", base)
        assert st == 200 and d["style"] == "" and len(d["chapters"]) == 3 and d["map"] is None and d["places"] == 1
        assert set(d["chapters"][0]) >= {"chapter_id", "number", "title", "scenes", "cards", "state", "pictures"}
        assert d["where"] == list(pictures.WHERE) and d["image_bridge"]["uses"] == [b.url]
        cid = d["chapters"][0]["chapter_id"]
        st, s, _ = call(port, "PUT", f"{base}/style", {"style": "manga"})
        assert st == 200 and s["style"] == "manga"
        st, pr, _ = call(port, "GET", f"{base}/prompt?chapter={cid}&scene=1")
        assert st == 200 and pr["prompt"].startswith("Art style: manga.") and pr["lock"] == "Mara Vell"
        st, j, _ = call(port, "POST", f"{base}/illustrate", {"chapter_id": cid, "engine": "sd"})
        assert st == 202 and j["job_id"] and j["pic_id"]
        assert wait(app, j["job_id"])["status"] == "done"
        st, j2, _ = call(port, "GET", f"/api/projects/{pid}/branches/{BR}/review/ai/{j['job_id']}")
        assert st == 200 and j2["status"] == "done" and j2["total"] == 1
        st, p, _ = call(port, "PUT", f"{base}/{j['pic_id']}", {"caption": "Up the stair",
                                                                "placement": {"where": "after_scene", "scene": 1}})
        assert st == 200 and p["picture"]["caption"] == "Up the stair"
        st, u, _ = call(port, "PUT", f"{base}/upload?chapter={cid}", art(fmt="JPEG"), content_type="image/jpeg")
        assert st == 200 and u["picture"]["picture"]["source"] == "upload" and u["picture"]["chosen"] == 1
        st, img, _ = call(port, "GET", u["picture"]["picture"]["url"])
        assert st == 200 and img == art(fmt="JPEG")
        st, mp, _ = call(port, "POST", f"{base}/map", {"kind": "svg"})
        assert st == 200 and mp["picture"]["picture"]["vector"]
        st, mj, _ = call(port, "POST", f"{base}/map", {"kind": "illustrated", "engine": "sd"})
        assert st == 202 and wait(app, mj["job_id"])["status"] == "done"
        st, ja, _ = call(port, "POST", f"{base}/illustrate-all", {"engine": "sd"})
        assert st == 202 and wait(app, ja["job_id"])["status"] == "done"
        st, d, _ = call(port, "GET", base)
        assert d["counts"]["chapters_with_picture"] == 3 and d["map"]["chosen"] == 1
        assert d["chapters"][0]["pictures"][0]["placement"] == {"where": "after_scene", "scene": 1}
        st, e, _ = call(port, "PUT", f"{base}/upload?chapter=map", b"GIF89a....", content_type="image/gif")
        assert st == 400
        st, e, _ = call(port, "POST", f"{base}/illustrate", {"chapter_id": "nope"})
        assert st == 400 and e["errors"][0]["code"] == "INVALID_INPUT"
        st, e, _ = call(port, "POST", f"{base}/map", {"kind": "3d"})
        assert st == 400
        st, e, _ = call(port, "PUT", f"{base}/style", {"style": 5})
        assert st == 400
        st, dl, _ = call(port, "DELETE", f"{base}/{j['pic_id']}")
        assert st == 200 and dl["ok"]
        st, e, _ = call(port, "DELETE", f"{base}/{j['pic_id']}")
        assert st == 404
        st, _x, _ = call(port, "GET", base, token="wrong-token")
        assert st == 401
    finally:
        httpd.shutdown()
        httpd.server_close()
