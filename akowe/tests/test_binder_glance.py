"""📖 Book Bible "At a glance" (binder.glance): the plain-words status page in front of the Cover — how many pages are
filled, a bar and dots per part (empty / AI draft / approved), the pictures waiting (and whether the picture maker is
there), the facts waiting for the author's OK, the series (book N of M, can a sequel start), the main character and the
look. The numbers come from the binder contract itself; the page is screen-only (never in the PDF / Word exports)."""
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest

from akowe import binder, binder_html, forge

from test_failover_review import SlotFake, make_app

BR = "main"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "binder_sample.json"


# ---------------------------------------------------------------------------------------------- helpers
def _page(tid, page_id, status="draft", filled=0, total=4, *, proposed=0, auto=0, unavailable=0, rows=None, **extra):
    fields = {}
    for i in range(total):
        fid = f"{tid}.1.{i + 1}"
        if i < filled:
            fields[fid] = {"value": f"value {i}", "status": "proposed" if i < proposed else "supplied", "source": "x"}
        else:
            fields[fid] = {"value": "", "status": "empty", "source": "x"}
    for i in range(auto):   # worked out by Akọwe: never counted
        fields[f"{tid}.2.{i + 1}"] = {"value": "3 chapters", "status": "auto", "source": "auto:x"}
    for i in range(unavailable):
        fields[f"{tid}.3.{i + 1}"] = {"value": "", "status": "empty", "source": "none", "unavailable": "not stored"}
    sections = {f"{tid}.1": {"fields": fields}}
    if rows is not None:
        sections[f"{tid}.9"] = {"fields": {f"{tid}.9.1": {"value": "", "status": "auto", "source": "rows", "repeat": True}},
                                "rows": rows}
    return dict({"template": tid, "page_id": page_id, "title": extra.pop("title", page_id), "status": status,
                 "sections": sections, "pics": {}}, **extra)


def _doc(pages, **more):
    return dict({"book": {"title": "T", "look": "noir"}, "pages": pages}, **more)


def _part(g, key):
    return next(p for p in g["parts"] if p["key"] == key)


# ---------------------------------------------------------------------------------------------- pure numbers
def test_empty_book_on_a_new_project(tmp_path):
    app = make_app(tmp_path, SlotFake(), slots=("AI-1",))
    pid = app.engine.bootstrap_project("author", "Brand new book")
    data = binder.build(app, pid, BR)
    g = data["glance"]
    assert g["what"].startswith("Your Book Bible is the reference binder for everything in your book")
    assert g["pages_total"] == len(data["pages"]) == 7          # cover, contents, book facts, cast, map, plan, rules
    assert g["pages_filled"] <= 1                                # only the contents list has something
    assert [p["key"] for p in g["parts"]] == ["cover", "contents", "facts", "cast", "characters", "relationships", "places",
                                              "world", "map", "plan", "chapters", "rules"]
    chars = _part(g, "characters")
    assert chars["pages"] == 0 and chars["page_id"] is None and chars["percent"] == 0 and chars["dots"] == []
    assert _part(g, "facts")["title"] == "Book facts" and _part(g, "facts")["page_id"] == "glance"
    assert g["facts"]["waiting"] == 0 and g["pictures"]["waiting"] == 0 and g["pictures"]["engine"] is None
    assert g["main"] is None and g["look"] == data["book"]["look"]
    assert g["series"]["in_series"] is False and g["series"]["books"] == 1 and g["series"]["number"] == 1
    assert g["series"]["sequel"]["possible"] is False and "no written chapters" in g["series"]["sequel"]["why"]
    # the page itself is not a binder page: the contract's pages are unchanged
    assert all(p["page_id"] != "at-a-glance" for p in data["pages"])
    assert next(p for p in data["pages"] if p["template"] == "3")["title"] == "Book facts"


def test_half_filled_book_counts_pages_parts_and_dots():
    pages = [_page("1", "cover", "approved", 4, 4), _page("2", "contents", "approved", 1, 4),     # 1/4 = filled (25%)
             _page("5", "ch-a", "draft", 3, 4, proposed=2, title="Ada"), _page("5", "ch-b", "draft", 0, 4, title="Bo"),
             _page("5", "ch-c", "needs_you", 4, 4, title="Cy"), _page("12", "rules", "draft", 0, 4, auto=6, unavailable=3)]
    g = binder.glance(_doc(pages))
    assert (g["pages_filled"], g["pages_total"]) == (4, 6)
    ch = _part(g, "characters")
    assert ch["pages"] == 3 and ch["page_id"] == "ch-a" and ch["percent"] == round(100 * 7 / 12)
    assert [d["state"] for d in ch["dots"]] == ["draft", "empty", "draft"] and [d["title"] for d in ch["dots"]] == ["Ada", "Bo", "Cy"]
    assert ch["states"] == {"empty": 1, "draft": 2, "approved": 0}
    rules = _part(g, "rules")   # auto and not-stored fields are not boxes to fill
    assert rules["percent"] == 0 and rules["dots"][0]["state"] == "empty"
    assert _part(g, "cover")["dots"][0] == {"page_id": "cover", "title": "Cover", "state": "approved"}
    assert g["facts"] == {"waiting": 2, "page_id": "ch-a", "values": 0}


def test_full_book_every_page_approved():
    pages = [_page(t, f"p-{t}", "approved", 5, 5) for t in ("1", "2", "3", "4", "5", "6", "7", "8A", "8B", "8C", "9", "10", "11", "12")]
    pages.append(_page("4", "cast-rows", "approved", 0, 0, rows=[{"4.9.1": {"value": "x", "status": "supplied"}}]))
    g = binder.glance(_doc(pages))
    assert g["pages_filled"] == g["pages_total"] == 15
    assert all(p["percent"] == 100 and all(d["state"] == "approved" for d in p["dots"]) for p in g["parts"])
    world = _part(g, "world")
    assert world["pages"] == 3 and world["templates"] == ["8A", "8B", "8C"]
    assert _part(g, "cast")["pages"] == 2   # a page with only a repeating section: one box, filled by its row
    assert g["facts"]["waiting"] == 0 and g["facts"]["page_id"] is None


def test_the_sample_binder():
    doc = json.loads(FIXTURE.read_text(encoding="utf-8"))
    g = binder.glance(doc)
    assert g["pages_total"] == 22 and 0 < g["pages_filled"] < 22
    assert sum(p["pages"] for p in g["parts"]) == 22
    assert g["main"]["name"] == "Odile Marsh" and g["main"]["page_id"] == "ch-odile" and g["main"]["portrait"]["url"]
    assert g["pictures"]["missing"] == 7 and g["look"] == "fantasy"


def test_pictures_waiting_and_the_picture_maker():
    pages = [_page("5", "ch-a", pictures_waiting=["portrait", "front"]), _page("5", "ch-b", pictures_waiting=["portrait"])]
    g = binder.glance(_doc(pages, pictures={"rest": 6}, progress={"missing_pictures": 2}))
    assert g["pictures"] == {"waiting": 6, "missing": 2, "engine": None}
    g = binder.glance(_doc(pages, pictures={"rest": 0}))      # the to-make list of the run counts too
    assert g["pictures"]["waiting"] == 3
    off = {"ready": False, "code": "IMAGE_BRIDGE_UNREACHABLE", "why": "AutoInjector is not reachable"}
    assert binder.glance(_doc(pages), engine=off)["pictures"]["engine"] == off


def test_series_of_two_books():
    sr = {"in_series": True, "name": "The Ferry Books", "number": 1,
          "books": [{"number": 1, "title": "One", "current": True}, {"number": 2, "title": "Two", "current": False}]}
    seq = {"possible": False, "why": "Book 2 of this series already exists.", "next_number": 2,
           "next_book": {"number": 2, "title": "Two", "project_id": "p2"}, "proposals_here": 0}
    g = binder.glance(_doc([_page("1", "cover")], series=sr), sequel=seq)
    assert g["series"] == {"in_series": True, "name": "The Ferry Books", "number": 1, "books": 2,
                           "sequel": {"possible": False, "why": "Book 2 of this series already exists.", "next_number": 2,
                                      "next_book": {"number": 2, "title": "Two", "project_id": "p2"}}}
    g = binder.glance(_doc([_page("1", "cover")], series=dict(sr, number=2)), sequel={"possible": True, "next_number": 3})
    assert g["series"]["number"] == 2 and g["series"]["books"] == 2 and g["series"]["sequel"]["possible"] is True


# ---------------------------------------------------------------------------------------------- the route and the exports
def test_glance_route_checks_the_picture_maker_and_exports_leave_it_out(tmp_path):
    app = make_app(tmp_path, SlotFake(), slots=("AI-1",))
    pid = app.engine.bootstrap_project("author", "Glance route book")
    forge.save_bridge_settings(app, {"url": "http://127.0.0.1:9"})   # nothing listens there: no picture maker

    def call(path, query=None):
        return app.route("GET", f"/api/projects/{pid}/branches/{BR}/binder{path}", query or {}, None, "author", {})
    st, g = call("/glance")
    assert st == 200 and g["pictures"]["engine"]["ready"] is False and g["pictures"]["engine"]["code"]
    assert g["pages_total"] == 7 and g["series"]["sequel"] is not None
    st, data = call("")
    assert data["glance"]["pictures"]["engine"] is None           # the binder itself never waits for the check
    assert data["glance"]["pages_total"] == g["pages_total"]
    # the exports are the binder pages only (the screen-only At a glance page is never in them)
    html = binder_html.render(data, pic_bytes=lambda u: None)
    st, dx = call("/export", {"format": ["docx"]})
    doc_xml = zipfile.ZipFile(io.BytesIO(dx[2])).read("word/document.xml").decode("utf-8")
    for text in (binder.GLANCE_WHAT[:40], "pages filled", "At a glance"):
        assert text not in html and text not in doc_xml, text
    assert "Book facts" in html and "Book facts" in doc_xml
    st, as_of = call("", {"as_of": ["1"]})
    assert as_of["glance"]["pages_total"] == len(as_of["pages"])


@pytest.mark.parametrize("bad", [None, {}, {"pages": None}, {"pages": [None, 3, {"template": "5"}]}])
def test_glance_never_breaks_on_odd_data(bad):
    g = binder.glance(bad or {})
    assert g["pages_total"] in (0, 1) and len(g["parts"]) == 12
