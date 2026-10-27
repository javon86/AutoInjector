"""🗂 B5 lane C: item (AR-), place (PL-) and magic-system (MG-) dossiers on the Character Forge machinery — the model
(sections, fields, letters, codes, revisions, history), edits, "Invent the rest" with a fake AI, approvals, the art
request bodies per kind through a fake AutoInjector bridge, uploads, the PDF of each kind (pages, headings, letters,
the plate, a dark background), cross-links between all four kinds, seeding from the book's own records (A04 places,
the story rules, a character's weapon), the example world, the book save and the HTTP API (characters unchanged)."""
from __future__ import annotations

import io
import json
import threading
from http.server import ThreadingHTTPServer

import pypdf
import pypdfium2 as pdfium
import pytest

from akowe import forge, forge_example, forge_kinds, forge_pdf
from akowe.book_path import BookPath
from akowe.errors import AkoweError
from akowe.forge_kinds_spec import SPECS

from test_failover_review import no_provider_sleep  # noqa: F401
from test_forge import BR, FakeImageBridge, ForgeFake, dark, fx, make_char, png  # noqa: F401
from test_server import call

KINDS = ("item", "place", "magic")


def mk(app, pid, kind, name, **body):
    return forge_kinds.create(app.store, pid, BR, kind, dict({"name": name}, **body))


def fld(d, key):
    return next(f for s in d["sections"] for f in s["fields"] if f["key"] == key)


def section_of(kind, key):
    return SPECS[kind]["fields"][key]["section"]


def put(app, pid, kind, rid, changes: dict, **extra):
    secs: dict = {}
    for k, v in changes.items():
        secs.setdefault(section_of(kind, k), {})[k] = v
    return forge_kinds.edit(app.store, pid, BR, kind, rid, dict({"sections": secs}, **extra))


# ====================================================================== the model
def test_each_kind_has_a_deep_lettered_model():
    want = {"item": ["Item record", "Appearance and materials", "History and provenance", "Powers and limits",
                     "Use and maintenance", "Ownership", "Appearances in the story", "Continuity ledger"],
            "place": ["Place record", "Geography and layout", "Atmosphere and senses", "History", "People and factions",
                      "Rules and dangers", "Routes and connections", "Appearances in the story", "Continuity ledger"],
            "magic": ["Source and nature", "Access and cost", "Rules and hard limits", "Practitioners and training",
                      "Named powers and techniques", "Visible and sensory signs", "Failure and backlash",
                      "History and lore", "Society's view", "Appearances in the story", "Continuity ledger"]}
    for kind, sp in SPECS.items():
        assert [s[1] for s in sp["sections"]] == want[kind]
        assert 8 <= len(sp["sections"]) <= 12 and 50 <= len(sp["fields"]) <= 90, kind
        for f in sp["fields"].values():
            assert f["letters"] and set(f["letters"]) <= set(forge.LETTER_KEYS) and forge.KEY_RE.match(f["key"])
        assert sp["prefix"] == forge.KINDS[kind]
        info = forge_kinds.field_info(kind)
        assert [x["key"] for x in info["letters"]] == list("CPVAFMKRSE") and info["hero"]["key"] == sp["art"]["hero"]
    assert SPECS["item"]["fields"]["supplied_canon"]["letters"] == ["C", "A"]
    assert SPECS["magic"]["fields"]["hard_limits"]["letters"] == ["M", "C"]
    assert {k: v["segment"] for k, v in SPECS.items()} == {"item": "items", "place": "places", "magic": "magic"}


@pytest.mark.parametrize("kind", KINDS)
def test_codes_edits_revisions_history_and_readiness(fx, kind):
    app, _f, pid = fx
    prefix = SPECS[kind]["prefix"]
    a = mk(app, pid, kind, "First one", aliases=["the first", "First one"])
    b = mk(app, pid, kind, "Second one")
    assert a["created"] and a["dossier"]["code"] == f"{prefix}-001" and b["dossier"]["code"] == f"{prefix}-002"
    d = a["dossier"]
    assert d["kind"] == kind and d["revision"] == 1 and d["readiness"] == "draft" and d["aliases"] == ["the first"]
    assert d["counts"]["fields"] == len(SPECS[kind]["fields"]) and d["counts"]["views_total"] == len(
        SPECS[kind]["art"]["views"])
    with pytest.raises(AkoweError) as e:
        mk(app, pid, kind, "first ONE")
    assert e.value.code == "INVALID_INPUT"
    with pytest.raises(AkoweError):
        mk(app, pid, kind, "  ")
    rid = a["record_id"]
    d = put(app, pid, kind, rid, {"supplied_canon": {"text": "The author's own words.", "protected": True},
                                  "one_line": {"text": "One line."}}, revision=1)
    assert d["revision"] == 2 and d["readiness"] == "ready"
    assert fld(d, "supplied_canon")["protected"] and fld(d, "one_line")["status"] == "supplied"
    with pytest.raises(AkoweError) as e:
        put(app, pid, kind, rid, {"one_line": {"text": "late"}}, revision=1)
    assert e.value.code == "VERSION_CONFLICT"
    for bad in ({"sections": {"nope": {}}}, {"sections": {"continuity": {"supplied_canon": {"text": "x"}}}},
                {"sections": {section_of(kind, "one_line"): {"one_line": {"text": 3}}}}, {"name": ""}, "text"):
        with pytest.raises(AkoweError):
            forge_kinds.edit(app.store, pid, BR, kind, rid, bad)
    d = forge_kinds.edit(app.store, pid, BR, kind, rid, {"name": "Renamed", "aliases": "alpha; beta", "tagline": "T",
                                                          "summary": "a\nb\nc\nd"})
    assert d["name"] == "Renamed" and d["aliases"] == ["alpha", "beta"] and d["summary"] == ["a", "b", "c"]
    e = forge_kinds.raw_entry(app.store, pid, BR, kind, rid)
    assert [h["what"] for h in e["history"]][-2:] == ["edit", "edit"] and e["revision"] == 3
    out = forge_kinds.delete(app.store, pid, BR, kind, b["record_id"])
    assert out["ok"] and len(forge_kinds.list_dossiers(app.store, pid, BR, kind)) == 1
    assert mk(app, pid, kind, "Third one")["dossier"]["code"] == f"{prefix}-002"  # the lowest free number again
    with pytest.raises(AkoweError) as e:
        forge_kinds.public(app.store, pid, BR, kind, b["record_id"])
    assert e.value.code == "NOT_FOUND"


def test_invent_fills_only_empty_unprotected_fields_then_approve(fx, no_provider_sleep):  # noqa: F811
    app, fake, pid = fx
    rid = mk(app, pid, "item", "Brass key")["record_id"]
    put(app, pid, "item", rid, {"supplied_canon": {"text": "A brass key, the author's.", "protected": True},
                                "limits": {"text": "", "protected": True}, "materials": {"text": "Brass."}})
    j = app.forge.start_kind_forge("author", pid, BR, "item", rid, {"slot_id": "AI-2"})
    j = forge.wait(app, "author", j["job_id"])
    assert j["status"] == "done" and j["total"] == len(SPECS["item"]["groups"]), j
    asked = [k for c in fake.forge_calls for k in c["keys"]]
    assert "supplied_canon" not in asked and "materials" not in asked and "limits" not in asked
    assert "tagline" in fake.forge_calls[0]["keys"] and all(c["slot"] == "AI-2" for c in fake.forge_calls)
    ctx = fake.forge_calls[0]["context"]
    assert ctx["record"]["kind"] == "item" and ctx["dossier"]["supplied_canon"]["protected"]
    assert "Item Forge" in fake.forge_calls[0]["system"] or "Item Forge" in json.dumps(fake.forge_calls[0])
    d = forge_kinds.public(app.store, pid, BR, "item", rid)
    assert fld(d, "overall_look")["status"] == "proposed" and fld(d, "materials")["text"] == "Brass."
    assert fld(d, "limits")["text"] == "" and d["tagline"] == "The one who invents" and len(d["summary"]) == 3
    assert d["revision"] == 2 and d["readiness"] == "draft"  # proposals never bump the revision
    out = forge_kinds.approve(app.store, pid, BR, "item", rid, {"fields": ["powers.abilities"]})
    assert out["approved"] == ["abilities"] and out["revision"] == 3
    out = forge_kinds.approve(app.store, pid, BR, "item", rid, {"all": True})
    assert out["readiness"] == "ready" and "ready" in out["message"]
    with pytest.raises(AkoweError):
        forge_kinds.approve(app.store, pid, BR, "item", rid, {"fields": ["nope"]})
    # an edit of a proposal approves it
    j = forge.wait(app, "author", app.forge.start_kind_forge("author", pid, BR, "item", rid, {})["job_id"])
    assert j["status"] == "done" and "nothing to invent" in j["results"][-1]["message"]


# ====================================================================== art (fake AutoInjector bridge)
@pytest.fixture
def ib(fx):
    app, fake, pid = fx
    b = FakeImageBridge()
    forge.save_bridge_settings(app, {"url": b.url, "token": "img-token-1"})
    yield app, pid, b
    b.close()


def art(app, pid, kind, rid, body):
    return forge.wait(app, "author", app.forge.start_kind_art("author", pid, BR, kind, rid, body)["job_id"])


def test_art_request_bodies_per_kind(ib):
    app, pid, b = ib
    item = mk(app, pid, "item", "Rescue baton")["record_id"]
    put(app, pid, "item", item, {"visual_anchors": {"text": "faded orange band"}, "materials": {"text": "ceramic"}})
    j = art(app, pid, "item", item, {"what": "portrait", "engine": "chatgpt"})
    assert j["status"] == "done", j
    r = b.requests[-1]
    assert r["purpose"] == "portrait" and r["engine"] == "chatgpt" and "characterLock" not in r and "view" not in r
    assert r["from"] == "akowe-forge" and r["returnImage"] is True and "seed" not in r
    assert r["prompt"].startswith("Rescue baton (item). Fixed visual anchors: faded orange band") and "ceramic" in r["prompt"]
    assert "a single object" in r["prompt"]
    j = art(app, pid, "item", item, {"what": "views", "engine": "sd"})
    assert j["status"] == "done" and j["total"] == 4
    vr = b.requests[-4:]
    assert [x["purpose"] for x in vr] == ["illustration"] * 4 and "seed" not in vr[0]
    assert [x["seed"] for x in vr[1:]] == [4002] * 3  # the first view's seed (call 2), reused
    assert "from the front" in vr[0]["prompt"] and "(profile)" in vr[1]["prompt"] and "close-up" in vr[3]["prompt"]
    d = forge_kinds.public(app.store, pid, BR, "item", item)
    assert d["art"]["portrait"]["engine"] == "chatgpt" and d["counts"]["views_done"] == 4
    place = mk(app, pid, "place", "Nacre")["record_id"]
    assert art(app, pid, "place", place, {"what": "establishing"})["status"] == "done"
    assert b.requests[-1]["purpose"] == "scene" and b.requests[-1]["engine"] == "auto"
    assert "establishing shot" in b.requests[-1]["prompt"]
    assert art(app, pid, "place", place, {"what": "views", "views": ["night"]})["status"] == "done"
    assert b.requests[-1]["purpose"] == "scene" and "at night" in b.requests[-1]["prompt"]
    magic = mk(app, pid, "magic", "Tide-calling")["record_id"]
    assert art(app, pid, "magic", magic, {"what": "sigil"})["status"] == "done"
    assert b.requests[-1]["purpose"] == "illustration" and "sigil" in b.requests[-1]["prompt"]
    assert art(app, pid, "magic", magic, {"what": "views"})["status"] == "done"
    assert b.requests[-1]["purpose"] == "scene" and "in use" in b.requests[-1]["prompt"]
    assert set(b.auth) == {"Bearer img-token-1"}
    for bad in ({"what": "portrait"}, {"what": "views", "views": ["front"]}, {"what": "sigil", "engine": "dalle"}):
        with pytest.raises(AkoweError):
            app.forge.start_kind_art("author", pid, BR, "magic", magic, bad)


@pytest.mark.parametrize("code", ["SD_NOT_CONNECTED", "IMAGE_REFUSED", "IMAGE_LIMIT"])
def test_art_errors_are_plain_and_keep_earlier_pictures(ib, code):
    app, pid, b = ib
    rid = mk(app, pid, "place", "Harbour")["record_id"]
    b.script[2] = (503, {"ok": False, "error": code, "message": "short reason", "hint": "do this"})
    j = art(app, pid, "place", rid, {"what": "views", "engine": "chatgpt"})
    assert j["status"] == "error" and j["error"]["code"] == code and j["error"]["fix"] == "do this"
    assert "1 picture(s) made before are kept" in j["error"]["message"]
    d = forge_kinds.public(app.store, pid, BR, "place", rid)
    assert d["art"]["views"]["day"] and not d["art"]["views"]["night"]


def test_upload_own_picture_per_slot(fx):
    app, _f, pid = fx
    rid = mk(app, pid, "magic", "Tide-calling")["record_id"]
    out = app.forge.upload_kind("author", pid, BR, "magic", rid, "sigil", png(fmt="JPEG"))
    assert out["art"]["sigil"]["source"] == "upload" and out["art"]["sigil"]["mime"] == "image/jpeg"
    out = app.forge.upload_kind("author", pid, BR, "magic", rid, "in_use", png())
    assert out["art"]["views"]["in_use"]["mime"] == "image/png"
    for slot, data in (("portrait", png()), ("sigil", b"GIF89a"), ("sigil", "text")):
        with pytest.raises(AkoweError):
            app.forge.upload_kind("author", pid, BR, "magic", rid, slot, data)


# ====================================================================== the PDF
@pytest.mark.parametrize("kind,word,plate,labels", [
    ("item", "ITEM", "TURNAROUND REFERENCE", ["FRONT", "SIDE", "BACK", "DETAIL"]),
    ("place", "PLACE", "MOOD VIEWS", ["DAY", "NIGHT", "INTERIOR / DETAIL"]),
    ("magic", "MAGIC", "IN USE", ["IN USE"])])
def test_pdf_of_each_kind_has_the_dossier_look(fx, kind, word, plate, labels):
    app, _f, pid = fx
    out = forge_example.load(app, "author", pid, BR, {})
    w = next(x for x in out["world"] if x["kind"] == kind)
    data, name = forge_kinds.pdf_bytes(app, pid, BR, kind, w["record_id"])
    assert data.startswith(b"%PDF") and name.startswith(f"{w['code']} ") and name.endswith("Forge dossier.pdf")
    r = pypdf.PdfReader(io.BytesIO(data))
    assert 6 <= len(r.pages) <= 14
    assert float(r.pages[0].mediabox.height) > float(r.pages[0].mediabox.width)
    assert float(r.pages[1].mediabox.width) > float(r.pages[1].mediabox.height)  # the landscape plate
    t1, t2, t3 = (r.pages[i].extract_text() for i in range(3))
    assert w["name"].upper() in t1 and f"{word} FORGE" in t1 and f"{w['code']} | REV 1 | DRAFT | 1" in t1
    assert f"{w['name'].upper()} / {plate}" in t2 and all(lb in t2 for lb in labels)
    assert f"{word} FORGE / {w['name'].upper()} / PROPOSED" in t3 and "01 / " in t3
    assert "[C,A]" in t3 or "[C,M]" in t3
    assert "C Canon" in t3 and "E Essential on-page detail" in t3
    every = "\n".join(p.extract_text() for p in r.pages)
    for n, (_k, title, _fs) in enumerate(SPECS[kind]["sections"], start=1):
        assert f"{n:02d} / {title}" in every
    assert "Linked records" in every and "CH-001 Moki Vey" in every
    assert "/XObject" in r.pages[0]["/Resources"]  # the example's hero picture
    doc = pdfium.PdfDocument(data)
    for i in (0, 1, 2):
        img = doc[i].render(scale=0.5).to_pil()
        assert dark(img, (3, 3)) and dark(img, (img.width - 4, img.height - 4)), i


def test_pdf_without_art_never_overflows(fx):
    app, _f, pid = fx
    rid = mk(app, pid, "place", "Ọ̀yọ́ the very long-named harbour district of the north")["record_id"]
    long = " ".join(f"word{i}" for i in range(150))
    put(app, pid, "place", rid, {k: {"text": long} for k in ("sights", "sounds", "smells", "touch", "light")})
    d = forge_kinds.public(app.store, pid, BR, "place", rid)
    captured = {}
    real = forge_pdf.render_pdf

    def spy(layout, **kw):
        captured["layout"] = layout
        return real(layout, **kw)
    forge_pdf.render_pdf = spy
    try:
        data = forge_pdf.render(d, {}, spec=forge_kinds.pdf_spec("place"))
    finally:
        forge_pdf.render_pdf = real
    text = "\n".join(p.extract_text() for p in pypdf.PdfReader(io.BytesIO(data)).pages)
    assert "word149" in text and "ESTABLISHING SHOT" in text and "Not filled in yet." in text and "?" not in text
    for pg in captured["layout"].pages[2:]:
        for op in pg.ops:
            if op[0] == "rect":
                assert op[2] >= forge_pdf.FOOT_TOP - 1


# ====================================================================== cross-links
def test_cross_links_between_all_four_kinds(fx):
    app, _f, pid = fx
    out = forge_example.load(app, "author", pid, BR, {})
    moki = out["record_id"]
    codes = {w["kind"]: w["code"] for w in out["world"]}
    assert codes == {"item": "AR-001", "place": "PL-001", "magic": "MG-001"}
    d = forge_kinds.attach_links(app.store, pid, BR, forge.public(app.store, pid, BR, moki))
    by = {x["code"]: x for x in d["links"]}
    assert set(by) >= {"AR-001", "PL-001", "MG-001"}
    assert "Primary option" in by["AR-001"]["fields"]          # possessions -> items
    assert "Identity" in by["PL-001"]["fields"]                # where he lives / comes from -> places
    assert "Source and type" in by["MG-001"]["fields"]         # powers -> magic systems
    assert by["AR-001"]["segment"] == "items" and by["MG-001"]["segment"] == "magic"
    assert [x["code"] for x in fld(d, "primary_weapon")["links"]] == ["AR-001"]
    item = next(w for w in out["world"] if w["kind"] == "item")["record_id"]
    di = forge_kinds.attach_links(app.store, pid, BR, forge_kinds.public(app.store, pid, BR, "item", item))
    assert [x["code"] for x in fld(di, "current_holder")["links"]] == ["CH-001"]
    back = {x["code"]: x["fields"] for x in di["backlinks"]}
    assert "Primary option" in back["CH-001"]
    assert forge_kinds.find_links("no names here", forge_kinds.link_index(app.store, pid, BR)) == []
    # a one-word name matches as written (not inside other words, not lowercase); codes always match
    idx = forge_kinds.link_index(app.store, pid, BR)
    assert [x["code"] for x in forge_kinds.find_links("the nacre of a shell; Nacreous; MG-001", idx)] == ["MG-001"]
    # the character PDF lists them as references
    data, _ = forge.pdf_bytes(app, pid, BR, moki)
    every = "\n".join(p.extract_text() for p in pypdf.PdfReader(io.BytesIO(data)).pages)
    assert "-> AR-001 Rescue baton" in every and "Linked records" in every


# ====================================================================== seeding from the book's records
def _fact(s, p, v, a="FACT"):
    return {"subject_id": s, "predicate": p, "value": v, "assertion_type": a, "effective_from": None,
            "effective_to": None, "source_refs": []}


def test_create_dossier_seeds_from_world_records(fx):
    app, _f, pid = fx
    bp = BookPath(app.engine, "author", pid, BR)
    cand = {"concept": "Harbor town", "attributes": {"geography": "A fog-bound bay; fog most mornings.",
                                                  "description": "A harbor town on stilts.",
                                                  "travel": "Two hours by ferry from the mainland."},
            "linked_refs": [], "protected_fact_flags": [],
            "facts": [_fact("harbor", "entity.name", "Harbor"), _fact("lighthouse", "entity.name", "The Old Light")]}
    ref, _ = bp.create("A04", {"concept": "Harbor town"}, manual_candidate=cand)
    cands = forge_kinds.candidates(app.store, pid, BR, "place")
    assert [c["name"] for c in cands] == ["Harbor", "The Old Light"] and cands[0]["from"] == "place record"
    out = forge_kinds.create(app.store, pid, BR, "place", {"from": cands[1]["source_id"]})
    d = out["dossier"]
    assert out["created"] and d["name"] == "The Old Light" and d["source"]["record_id"] == ref["record_id"]
    assert fld(d, "location")["text"] == "A fog-bound bay; fog most mornings."
    assert fld(d, "location")["status"] == "supplied" and fld(d, "location")["by"]["kind"] == "canon"
    assert fld(d, "routes")["text"] == "Two hours by ferry from the mainland."
    assert "Harbor town" in fld(d, "supplied_canon")["text"]
    assert "Description: A harbor town on stilts." in fld(d, "supplied_canon")["text"]
    assert "filled from your book" in out["message"]
    again = forge_kinds.create(app.store, pid, BR, "place", {"from": cands[1]["source_id"]})
    assert not again["created"] and again["record_id"] == out["record_id"]
    assert [c["name"] for c in forge_kinds.candidates(app.store, pid, BR, "place")] == ["Harbor"]
    with pytest.raises(AkoweError):
        forge_kinds.create(app.store, pid, BR, "place", {"from": "A04:nope:x"})
    # magic from the story rules
    from akowe import story_rules
    rules = story_rules.clean_rules([
        {"category": "hard_rule", "text": "Tide magic needs salt water within reach.", "scope": "At most three "
         "castings a day; never on dry land.", "source": "canon", "stated_by": "the canon"},
        {"category": "belief", "text": "Fishers believe the magic drowns liars.", "scope": "", "source": "ch1",
         "stated_by": "Mara"},
        {"category": "hard_rule", "text": "The ferry leaves at dawn.", "scope": "every day", "source": "canon",
         "stated_by": "the canon"}])
    story_rules.save(app.store, pid, BR, rules, by="author")
    mc = forge_kinds.candidates(app.store, pid, BR, "magic")
    assert [c["source_id"] for c in mc] == ["rules"] and "2 story rule(s)" in mc[0]["summary"]
    d = forge_kinds.create(app.store, pid, BR, "magic", {"from": "rules", "name": "Tide magic"})["dossier"]
    assert d["name"] == "Tide magic" and "salt water" in fld(d, "core_rules")["text"]
    assert "three castings a day" in fld(d, "hard_limits")["text"] and "Mara" in fld(d, "public_view")["text"]
    assert "ferry" not in json.dumps(d)
    # an item from a character's weapon
    rid = make_char(app, pid, "Tom Reed")
    forge.edit(app.store, pid, BR, rid, {"sections": {"weapons": {
        "primary_weapon": {"text": "Harpoon gun, old and rusty."},
        "weapon_maintenance": {"text": "Oiled every night."}}}})
    ic = forge_kinds.candidates(app.store, pid, BR, "item")
    assert [(c["name"], c["from"]) for c in ic] == [("Harpoon gun", "Tom Reed's primary option")]
    d = forge_kinds.create(app.store, pid, BR, "item", {"from": ic[0]["source_id"]})["dossier"]
    assert fld(d, "maintenance")["text"] == "Oiled every night." and "Tom Reed / CH-001" in fld(d, "current_holder")["text"]
    assert fld(d, "overall_look")["text"].startswith("Harpoon gun")


def test_example_world_loads_once_with_art(fx):
    app, _f, pid = fx
    out = forge_example.load(app, "author", pid, BR, {})
    assert [w["created"] for w in out["world"]] == [True, True, True] and "Nacre" in out["message"]
    again = forge_example.load(app, "author", pid, BR, {})
    assert [w["created"] for w in again["world"]] == [False, False, False]
    assert [w["record_id"] for w in again["world"]] == [w["record_id"] for w in out["world"]]
    for w in out["world"]:
        d = forge_kinds.public(app.store, pid, BR, w["kind"], w["record_id"])
        assert fld(d, "supplied_canon")["protected"] and fld(d, "supplied_canon")["status"] == "supplied"
        assert d["counts"]["proposed"] > 50 and d["art"][SPECS[w["kind"]]["art"]["hero"]]
        assert d["tagline"] and len(d["summary"]) == 3
    item = forge_kinds.public(app.store, pid, BR, "item", out["world"][0]["record_id"])
    assert item["counts"]["views_done"] == 4


def test_book_save_includes_every_kind(fx):
    app, _f, pid = fx
    forge_example.load(app, "author", pid, BR, {})
    files, _info = app.saver.collect(pid, BR)
    names = sorted(k for k in files if k.startswith("Character Forge/"))
    for base in ("AR-001 Rescue baton", "PL-001 Nacre", "MG-001 Biofilament mutation"):
        assert f"Character Forge/{base} - dossier.pdf" in names and f"Character Forge/{base} - dossier.json" in names
    assert "Character Forge/AR-001 pictures/portrait.jpg" in names and "Character Forge/AR-001 pictures/detail.jpg" in names
    assert "Character Forge/PL-001 pictures/establishing.jpg" in names and "Character Forge/MG-001 pictures/sigil.jpg" in names
    assert all(len(k) <= 60 for k in names), [k for k in names if len(k) > 60]
    j = json.loads(files["Character Forge/PL-001 Nacre - dossier.json"])
    assert j["code"] == "PL-001" and j["links"] and "history" not in j
    assert files["Character Forge/MG-001 Biofilament mutation - dossier.pdf"].startswith(b"%PDF")


# ====================================================================== HTTP
def test_http_api_for_the_kinds(fx, no_provider_sleep):  # noqa: F811
    from akowe.server import make_handler
    app, _fake, pid = fx
    rid_c = make_char(app, pid, "Moki Vey")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    base = f"/api/projects/{pid}/branches/{BR}/forge"
    try:
        st, body, _ = call(port, "GET", f"{base}/items")
        assert st == 200 and body["items"] == [] and body["candidates"] == [] and body["kind"] == "item"
        assert len(body["fields"]["sections"]) == 8 and body["fields"]["hero"]["key"] == "portrait"
        st, out, _ = call(port, "POST", f"{base}/items", {"name": "Rescue baton"})
        assert st == 201 and out["dossier"]["code"] == "AR-001"
        rid = out["record_id"]
        st, d, _ = call(port, "GET", f"{base}/items/{rid}")
        assert st == 200 and set(d) >= {"record_id", "name", "code", "revision", "readiness", "sections", "art",
                                        "links", "backlinks", "aliases"}
        assert set(d["art"]) == {"portrait", "views"} and set(d["art"]["views"]) == {"front", "side", "back", "detail"}
        st, d, _ = call(port, "PUT", f"{base}/items/{rid}", {"sections": {"ownership": {
            "current_holder": {"text": "Moki Vey / CH-001"}}}, "revision": 1})
        assert st == 200 and d["revision"] == 2 and fld(d, "current_holder")["links"][0]["record_id"] == rid_c
        st, e, _ = call(port, "PUT", f"{base}/items/{rid}", {"sections": {"ownership": {"owner": {"text": "x"}}},
                                                             "revision": 1})
        assert st == 409 and e["errors"][0]["code"] == "VERSION_CONFLICT"
        st, j, _ = call(port, "POST", f"{base}/items/{rid}/forge", {})
        assert st == 202 and forge.wait(app, "author", j["job_id"])["status"] == "done"
        st, j2, _ = call(port, "GET", f"{base}/items/{rid}/jobs/{j['job_id']}")
        assert st == 200 and j2["status"] == "done"
        st, a, _ = call(port, "POST", f"{base}/items/{rid}/approve", {"all": True})
        assert st == 200 and a["readiness"] == "ready" and "links" in a["dossier"]
        st, u, _ = call(port, "PUT", f"{base}/items/{rid}/art/detail", png(), content_type="image/png")
        assert st == 200 and u["art"]["views"]["detail"]["asset_id"]
        st, pdf, resp = call(port, "GET", f"{base}/items/{rid}/pdf?download=1")
        assert st == 200 and pdf.startswith(b"%PDF") and "attachment" in resp.getheader("Content-Disposition")
        st, e, _ = call(port, "POST", f"{base}/items/{rid}/art", {"what": "sigil"})
        assert st == 400 and e["errors"][0]["code"] == "INVALID_INPUT"
        st, out, _ = call(port, "POST", f"{base}/places", {"name": "Nacre"})
        assert st == 201 and out["dossier"]["code"] == "PL-001" and out["dossier"]["art"]["establishing"] is None
        st, out, _ = call(port, "POST", f"{base}/magic", {"name": "Tide-calling"})
        assert st == 201 and out["dossier"]["code"] == "MG-001"
        st, e, _ = call(port, "POST", f"{base}/magic", {})
        assert st == 400 and e["errors"][0]["code"] == "MISSING_INPUT"
        st, e, _ = call(port, "GET", f"{base}/places/FK-nope")
        assert st == 404
        st, e, _ = call(port, "GET", f"{base}/potions")
        assert st == 404
        st, dl, _ = call(port, "POST", f"{base}/magic/{out['record_id']}/delete", {})
        assert st == 200 and dl["ok"]
        # /forge/characters is unchanged (plus the links of the dossier view)
        st, body, _ = call(port, "GET", f"{base}/characters")
        assert st == 200 and body["characters"][0]["record_id"] == rid_c and body["characters"][0]["code"] == "CH-001"
        st, dc, _ = call(port, "GET", f"{base}/characters/{rid_c}")
        assert st == 200 and dc["kind"] == "character" and set(dc["art"]) == {"portrait", "views", "sheet", "clip"}
        assert [x["code"] for x in dc["backlinks"]] == ["AR-001"]
        st, _b, _ = call(port, "GET", f"{base}/items", token="wrong-token")
        assert st == 401
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_magic_seeds_from_a_power_record_and_the_rules_that_name_it(fx, monkeypatch):
    """A09 needs the book's magic feature (off in a test book), so its record is given here as the store keeps it."""
    app, _f, pid = fx
    rec = {"record_id": "A09-tide", "module_id": "A09", "data": {
        "concept": "Tide magic", "attributes": {"powers": "Calls the tide in.", "costs": "A day of thirst per use.",
                                                "limits": "Three castings a day.", "prerequisites": "Born at sea.",
                                                "exceptions": "None."},
        "facts": [_fact("tide", "entity.name", "Tide-calling"), _fact("tide", "x.a09.limit", "Never on dry land")]}}
    real = forge_kinds._heads
    monkeypatch.setattr(forge_kinds, "_heads", lambda s, p, b, op: [rec] if op == "A09" else real(s, p, b, op))
    from akowe import story_rules
    story_rules.save(app.store, pid, BR, story_rules.clean_rules([
        {"category": "hard_rule", "text": "Tide-calling fails in fresh water.", "scope": "always", "source": "canon",
         "stated_by": "the canon"}]), by="author")
    cands = forge_kinds.candidates(app.store, pid, BR, "magic")
    # (the rule names no magic word, so it is no "rules" candidate of its own; it names the system: its ledger gets it)
    assert [c["source_id"] for c in cands] == ["A09:A09-tide:tide"] and cands[0]["from"] == "power record"
    d = forge_kinds.create(app.store, pid, BR, "magic", {"from": cands[0]["source_id"]})["dossier"]
    assert d["name"] == "Tide-calling" and fld(d, "nature")["text"] == "Calls the tide in."
    assert fld(d, "cost")["text"] == "A day of thirst per use." and fld(d, "how_gained")["text"] == "Born at sea."
    assert fld(d, "hard_limits")["text"] == "Three castings a day.; Never on dry land"
    assert "fresh water" in fld(d, "rules_ledger")["text"] and fld(d, "supplied_canon")["text"] == "Tide magic"
