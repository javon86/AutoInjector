"""🗂 B5 Character Forge dossiers: the model and its storage (codes, revisions, history, readiness), the sync with the
character sheet / voice card / canon record, "Invent the rest" with a fake AI (never over supplied or protected text,
proposals stay proposals), approvals, art through a fake AutoInjector bridge (engine / purpose / view / seed reuse /
error codes / NO_LOCK fallback), uploads, the dossier PDF (pages, landscape plate, headings and letter tags, dark
pages), the Moki Vey example, the chapter-brief helper, the book save and the HTTP API."""
from __future__ import annotations

import base64
import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pypdf
import pypdfium2 as pdfium
import pytest
from PIL import Image

from akowe import characters as chars_mod
from akowe import forge, forge_example, forge_pdf
from akowe.book_path import BookPath
from akowe.errors import AkoweError

from test_failover_review import SlotFake, make_app, no_provider_sleep  # noqa: F401
from test_server import TOKEN, call

BR = "main"


# ====================================================================== helpers
def png(w=60, h=90, color=(120, 130, 140), fmt="PNG") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, fmt)
    return buf.getvalue()


def make_char(app, pid, name, attributes=None):
    bp = BookPath(app.engine, "author", pid, BR)
    sid = name.lower().replace(" ", "_")
    cand = {"concept": name, "attributes": attributes or {}, "linked_refs": [], "protected_fact_flags": [],
            "facts": [{"subject_id": sid, "predicate": "entity.name", "value": name, "assertion_type": "FACT",
                       "effective_from": None, "effective_to": None, "source_refs": []}]}
    ref, _ = bp.create("A01", {"concept": name}, manual_candidate=cand)
    return ref["record_id"]


class ForgeFake(SlotFake):
    """Answers every forge prompt with text per asked key; ``fail_on``: call numbers (1-based) that time out."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.forge_calls: list = []
        self.fail_on: set = set()

    def submit(self, slot, system, user, schema):
        ctx = json.loads(user.split("\n", 1)[1]).get("context") or {}
        props = list((schema.get("properties") or {}))
        with self.lock:
            self.forge_calls.append({"slot": slot["slot_id"], "keys": props, "context": ctx, "system": system})
            n = len(self.forge_calls)
        if n in self.fail_on:
            raise AkoweError("TIMEOUT", "", "the fake AI did not answer in time")
        name = (ctx.get("character") or {}).get("name", "?")
        out = {}
        for k in props:
            if k.startswith("relationship_"):
                out[k] = f"Friend {k[-1]} / CH-00{k[-1]}: knows {name} from the docks, 30."
            elif k.startswith("backstory_"):
                out[k] = f"21{k[-1]}0 / chapter {k[-1]}: something formative happened to {name}."
            elif k == "summary":
                out[k] = "Line one.\nLine two.\nLine three."
            elif k == "tagline":
                out[k] = "The one who invents"
            elif k == "samples":
                out[k] = "\"First line.\"\n\"Second line.\""
            else:
                out[k] = f"Invented {k} for {name}."
        return out, {"model": "fake-forge", "input_tokens": 10, "output_tokens": 20}


@pytest.fixture
def fx(tmp_path):
    fake = ForgeFake()
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    pid = app.engine.bootstrap_project("author", "Forge book")
    return app, fake, pid


def field(d, key):
    return next(f for s in d["sections"] for f in s["fields"] if f["key"] == key)


def put(app, pid, rid, sections, **extra):
    return forge.edit(app.store, pid, BR, rid, dict({"sections": sections}, **extra))


def run_forge(app, pid, rid, body=None):
    j = app.forge.start_forge("author", pid, BR, rid, body or {})
    return forge.wait(app, "author", j["job_id"])


# ====================================================================== model and storage
def test_model_has_the_samples_fourteen_sections_and_letters():
    assert len(forge.SECTIONS) == 14
    titles = [s[1] for s in forge.SECTIONS]
    assert titles[0] == "Character record" and titles[3] == "Voice card" and titles[-1] == "Continuity and reveal reference"
    assert all(forge.KEY_RE.match(k) for k in forge.FIELDS) and len(forge.FIELDS) > 140
    assert forge.FIELDS["supplied_canon"]["letters"] == ["C", "A"] and forge.FIELDS["goals"]["letters"] == ["S", "P"]
    info = forge.field_info()
    assert [x["key"] for x in info["letters"]] == list("CPVAFMKRSE") and len(info["views"]) == 10
    assert forge.clean_letters("s, p, x") == ["S", "P"] and forge.clean_letters([], ["C"]) == ["C"]
    assert forge.split_title("Imani Vey / CH-002: Sister and analyst") == ("Imani Vey / CH-002", "Sister and analyst")
    assert forge.split_title("no colon here") == ("", "no colon here")
    # the machinery is ready for items, places and magic systems
    assert forge.KINDS == {"character": "CH", "item": "AR", "place": "PL", "magic": "MG"}


def test_codes_revisions_history_and_readiness(fx):
    app, _f, pid = fx
    a, b = make_char(app, pid, "Ada Vey"), make_char(app, pid, "Bo Rook")
    d = forge.public(app.store, pid, BR, b)
    assert d["code"] == "CH-002" and d["revision"] == 0 and d["readiness"] == "draft"
    assert [x["code"] for x in forge.list_dossiers(app.store, pid, BR)] == ["CH-001", "CH-002"]
    d = put(app, pid, b, {"inner_life": {"fear": {"text": "Deep water."}}})  # Bo is saved first: keeps CH-002
    assert d["code"] == "CH-002" and d["revision"] == 1 and field(d, "fear")["status"] == "supplied"
    assert d["readiness"] == "ready"  # some text and nothing waiting
    d = put(app, pid, b, {"inner_life": {"fear": {"text": "Deep, cold water.", "protected": True}}}, revision=1)
    assert d["revision"] == 2 and field(d, "fear")["protected"]
    with pytest.raises(AkoweError) as e:
        put(app, pid, b, {"inner_life": {"fear": {"text": "old form"}}}, revision=1)
    assert e.value.code == "VERSION_CONFLICT"
    entry = forge.raw_entry(app.store, pid, BR, b)
    assert [h["what"] for h in entry["history"]] == ["edit", "edit"] and entry["history"][-1]["old"]["fear"] == "Deep water."
    assert forge.public(app.store, pid, BR, a)["code"] == "CH-001"
    out = app.store.query("SELECT payload FROM outbox WHERE project_id=? AND event_type='forge.saved'", (pid,))
    assert len(out) == 2 and "Deep" not in out[0]["payload"]  # numbers and codes only
    for bad in ({"sections": {"nope": {}}}, {"sections": {"record": {"wants": {"text": "x"}}}},
                {"sections": {"inner_life": {"fear": {"text": 5}}}}, {"sections": {"inner_life": {"fear": {"letters": "xyz"}}}},
                {"sections": {"inner_life": {"fear": {"bogus": 1}}}}, "nope"):
        with pytest.raises(AkoweError):
            forge.edit(app.store, pid, BR, b, bad)
    with pytest.raises(AkoweError) as e:
        forge.public(app.store, pid, BR, "A01-nope")
    assert e.value.code == "NOT_FOUND"


def test_dossier_reuses_canon_sheet_and_voice_card(fx):
    app, _f, pid = fx
    rid = make_char(app, pid, "Ada Vey", {"role": "The narrator", "appearance": "Tall, grey coat."})
    chars_mod.save_entry(app.store, pid, BR, rid, sheet={"wants": "the log", "must_show": ["her scar"],
                                                         "relationships": [{"with": "Bo Rook", "tension": "debt",
                                                                            "history": "school"}]},
                         voice={"rhythm": "short", "vocabulary": ["wick", "lens"], "samples": ["One.", "Two."],
                                "under_pressure": "goes quiet"})
    d = forge.public(app.store, pid, BR, rid)
    role = field(d, "role")
    assert role["text"] == "The narrator" and role["readonly"] and role["protected"] and role["source"] == "canon"
    assert field(d, "wants")["text"] == "the log" and field(d, "wants")["source"] == "sheet"
    assert field(d, "vocabulary")["text"] == "wick; lens" and field(d, "samples")["text"] == "One.\nTwo."
    assert field(d, "speech_fear")["text"] == "goes quiet"
    rel = field(d, "relationship_1")
    assert rel["title"] == "Bo Rook" and rel["label"] == "Bo Rook" and rel["text"] == "debt History: school"
    assert field(d, "must_show_1")["text"] == "her scar"
    # the canon record's fields are read-only here
    with pytest.raises(AkoweError) as e:
        put(app, pid, rid, {"record": {"role": {"text": "changed"}}})
    assert e.value.code == "LOCKED_FACT"
    # an author edit in the dossier goes into the sheet / voice card
    put(app, pid, rid, {"inner_life": {"wants": {"text": "the whole log back"}},
                        "voice": {"habits": {"text": "counts exits; taps the lens"},
                                  "speech_anger": {"text": "clipped"}},
                        "relationships": {"relationship_2": {"title": "Imani Vey / CH-002", "text": "sister"},
                                          "must_show_2": {"text": "the lighthouse key"}}})
    e2 = chars_mod.get_entry(app.store, pid, BR, rid)
    assert e2["sheet"]["wants"] == "the whole log back" and e2["voice"]["habits"] == ["counts exits", "taps the lens"]
    assert e2["voice"]["under_pressure"] == "Fear: goes quiet | Anger: clipped"
    assert {r["with"] for r in e2["sheet"]["relationships"]} == {"Bo Rook", "Imani Vey / CH-002"}
    assert e2["sheet"]["must_show"] == ["her scar", "the lighthouse key"]
    d = forge.public(app.store, pid, BR, rid)
    assert field(d, "speech_fear")["text"] == "goes quiet" and field(d, "speech_anger")["text"] == "clipped"
    assert field(d, "relationship_2")["label"] == "Imani Vey / CH-002"
    # an edit on the character page later wins over the dossier's copy
    sheet = dict(e2["sheet"], wants="only the map")
    chars_mod.save_entry(app.store, pid, BR, rid, sheet=sheet, by="author")
    assert field(forge.public(app.store, pid, BR, rid), "wants")["text"] == "only the map"
    # a relationship removed on the character page disappears from the dossier
    chars_mod.save_entry(app.store, pid, BR, rid, sheet=dict(sheet, relationships=[]), by="author")
    d = forge.public(app.store, pid, BR, rid)
    assert not field(d, "relationship_1")["text"] and not field(d, "relationship_2")["text"]
    # a relationship needs a name
    with pytest.raises(AkoweError) as e:
        put(app, pid, rid, {"relationships": {"relationship_3": {"text": "no name given"}}})
    assert e.value.code == "MISSING_INPUT"


# ====================================================================== invent the rest (fake AI)
def test_forge_fills_only_empty_unprotected_fields_as_proposals(fx, no_provider_sleep):  # noqa: F811
    app, fake, pid = fx
    rid = make_char(app, pid, "Moki Vey", {"traits": "Observant."})
    put(app, pid, rid, {"record": {"supplied_canon": {"text": "Small build; platinum twists.", "protected": True}},
                        "inner_life": {"fear": {"text": "Being restrained."}},
                        "fighting": {"stance": {"text": "", "protected": True}}})
    j = run_forge(app, pid, rid)
    assert j["status"] == "done", j
    assert len(fake.forge_calls) == len(forge.GROUPS) and all(c["slot"] == "AI-1" for c in fake.forge_calls)
    asked = {k for c in fake.forge_calls for k in c["keys"]}
    assert not asked & {"supplied_canon", "fear", "stance", "traits"}  # supplied, protected or canon: never asked
    assert {"tagline", "summary"} <= set(fake.forge_calls[0]["keys"])
    ctx = fake.forge_calls[0]["context"]
    assert ctx["dossier"]["supplied_canon"]["protected"] and ctx["code"] == "CH-001" and "fields_to_fill" in ctx
    d = forge.public(app.store, pid, BR, rid)
    assert field(d, "supplied_canon")["text"] == "Small build; platinum twists." and field(d, "supplied_canon")["status"] == "supplied"
    assert field(d, "fear")["text"] == "Being restrained." and field(d, "traits")["text"] == "Observant."
    assert field(d, "stance")["text"] == ""
    assert field(d, "wants")["status"] == "proposed" and field(d, "wants")["text"] == "Invented wants for Moki Vey."
    assert field(d, "relationship_1")["title"] == "Friend 1 / CH-001"
    assert d["tagline"] == "The one who invents" and d["summary"] == ["Line one.", "Line two.", "Line three."]
    assert d["readiness"] == "draft" and d["counts"]["proposed"] > 100 and d["revision"] == 1  # proposals: no bump
    # proposals never reach the character sheet / voice card
    e = chars_mod.get_entry(app.store, pid, BR, rid) or {}
    assert not (e.get("sheet") or {}).get("wants") and not (e.get("voice") or {}).get("rhythm")
    # a second run has nothing to fill and asks nothing
    n = len(fake.forge_calls)
    j = run_forge(app, pid, rid)
    assert j["status"] == "done" and len(fake.forge_calls) == n
    assert "nothing to invent" in j["results"][-1]["message"]


def test_approve_one_then_all_makes_it_ready_and_writes_through(fx, no_provider_sleep):  # noqa: F811
    app, _fake, pid = fx
    rid = make_char(app, pid, "Moki Vey")
    assert run_forge(app, pid, rid)["status"] == "done"
    out = forge.approve(app.store, pid, BR, rid, {"fields": ["inner_life.wants", "rhythm"]})
    assert out["approved"] == ["wants", "rhythm"] and out["revision"] == 2 and out["readiness"] == "draft"
    assert "Approved 2 proposals" in out["message"]
    e = chars_mod.get_entry(app.store, pid, BR, rid)
    assert e["sheet"]["wants"] == "Invented wants for Moki Vey." and e["voice"]["rhythm"] == "Invented rhythm for Moki Vey."
    assert not e["sheet"].get("fear")  # still only proposed
    # ✎ edit of a proposal = approved
    d = put(app, pid, rid, {"inner_life": {"needs": {"text": "Trust."}}})
    assert field(d, "needs")["status"] == "approved" and d["revision"] == 3
    out = forge.approve(app.store, pid, BR, rid, {"all": True})
    assert out["readiness"] == "ready" and out["revision"] == 4 and out["dossier"]["counts"]["proposed"] == 0
    e = chars_mod.get_entry(app.store, pid, BR, rid)
    assert e["sheet"]["fear"] and e["voice"]["samples"] == ['"First line."', '"Second line."']
    assert len(e["sheet"]["relationships"]) == 6 and len(e["sheet"]["must_show"]) == 5
    d = forge.public(app.store, pid, BR, rid)
    assert field(d, "relationship_3")["status"] == "approved"  # still the dossier's text after the round trip
    out = forge.approve(app.store, pid, BR, rid, {"all": True})
    assert out["approved"] == [] and out["revision"] == 4 and "Nothing was waiting" in out["message"]
    for bad in ({}, {"fields": []}, {"fields": ["nope"]}, {"fields": "wants"}):
        with pytest.raises(AkoweError):
            forge.approve(app.store, pid, BR, rid, bad)


def test_forge_failure_keeps_earlier_groups_and_says_so(fx, no_provider_sleep):  # noqa: F811
    app, fake, pid = fx
    rid = make_char(app, pid, "Moki Vey")
    fake.fail_on = {3}
    j = run_forge(app, pid, rid, {"slot_id": "AI-2"})
    assert j["status"] == "error" and j["error"]["code"] == "TIMEOUT"
    assert "invented before this are kept" in j["error"]["message"]
    assert all(c["slot"] == "AI-2" for c in fake.forge_calls)  # the author's pick
    d = forge.public(app.store, pid, BR, rid)
    assert field(d, "wants")["status"] == "proposed" and field(d, "rhythm")["status"] == "proposed"
    assert field(d, "primary_style")["text"] == ""  # the failed group
    # resuming fills only what is still empty
    fake.fail_on = set()
    j = run_forge(app, pid, rid)
    assert j["status"] == "done"
    assert field(forge.public(app.store, pid, BR, rid), "primary_style")["status"] == "proposed"
    # an author edit made while the AI works is never overwritten (apply only fills still-empty fields)
    filled = forge.apply_proposals(app.store, pid, BR, rid, {"wants": "AI again"}, slot="AI-1")
    assert filled == []


def test_clean_answer_tolerates_wrappers_and_lists():
    assert forge.clean_answer({"fields": {"wants": " a  b ", "x": "y"}}, ["wants"]) == {"wants": "a b"}
    assert forge.clean_answer({"habits": ["a", "b"], "samples": ["x", "y"]}, ["habits", "samples"]) == \
        {"habits": "a; b", "samples": "x\ny"}
    assert forge.clean_answer("nope", ["wants"]) == {}
    assert len(forge.clean_answer({"wants": "w" * 5000}, ["wants"])["wants"]) == forge.FIELD_MAX


# ====================================================================== art (fake AutoInjector bridge)
class FakeImageBridge:
    def __init__(self):
        self.requests: list = []
        self.script: dict = {}   # call number (1-based) -> (status, body)
        self.auth: list = []
        bridge = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                bridge.requests.append(body)
                bridge.auth.append(self.headers.get("Authorization"))
                n = len(bridge.requests)
                if self.path != "/image/request":
                    status, out = 404, {"ok": False, "error": "NOT_FOUND"}
                elif n in bridge.script:
                    status, out = bridge.script[n]
                else:
                    seed = body.get("seed") if body.get("seed") is not None else 4000 + n
                    eng = "sd" if body.get("engine") in ("auto", "sd") else "chatgpt"
                    status, out = 200, {"ok": True, "engine": eng, "purpose": body.get("purpose"),
                                        "view": body.get("view"), "seed": seed, "warnings": [],
                                        "images": [{"path": "/nowhere.png", "seed": seed,
                                                    "imageBase64": base64.b64encode(png()).decode()}]}
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


@pytest.fixture
def ib(fx):
    app, fake, pid = fx
    b = FakeImageBridge()
    forge.save_bridge_settings(app, {"url": b.url, "token": "img-token-1"})
    yield app, pid, b
    b.close()


def run_art(app, pid, rid, body):
    j = app.forge.start_art("author", pid, BR, rid, body)
    return forge.wait(app, "author", j["job_id"])


def test_art_views_reuse_the_first_seed_and_store_assets(ib):
    app, pid, b = ib
    rid = make_char(app, pid, "Moki Vey")
    put(app, pid, rid, {"record": {"supplied_canon": {"text": "Small build; dark platinum twists."}},
                        "continuity": {"visual_anchors": {"text": "long charcoal sleeveless coat"}}})
    j = run_art(app, pid, rid, {"what": "views", "engine": "sd"})
    assert j["status"] == "done" and j["total"] == 10 and j["done"] == 10, j
    assert [r["view"] for r in b.requests] == list(forge.VIEW_KEYS)
    first = b.requests[0]
    assert first["engine"] == "sd" and first["purpose"] == "view" and first["characterLock"] == "Moki Vey"
    assert first["from"] == "akowe-forge" and first["returnImage"] is True and "seed" not in first
    assert "Fixed visual anchors: long charcoal sleeveless coat" in first["prompt"] and "platinum twists" in first["prompt"]
    assert all(r["seed"] == 4001 for r in b.requests[1:])  # the first view's seed, reused
    assert set(b.auth) == {"Bearer img-token-1"}
    d = forge.public(app.store, pid, BR, rid)
    assert d["counts"]["views_done"] == 10 and d["art"]["views"]["side"]["seed"] == 4001
    a = d["art"]["views"]["front"]
    rec = app.store.get_record(pid, BR, a["asset_id"], 1)
    assert rec["representation"] == "BINARY_ARTIFACT" and app.store.read_binary(rec) == png()
    # portrait with ChatGPT, then a turnaround sheet
    j = run_art(app, pid, rid, {"what": "portrait", "engine": "chatgpt"})
    assert j["status"] == "done" and b.requests[-1]["purpose"] == "portrait" and b.requests[-1]["engine"] == "chatgpt"
    j = run_art(app, pid, rid, {"what": "sheet", "engine": "chatgpt"})
    assert j["status"] == "done" and b.requests[-1]["purpose"] == "sheet" and "turnaround" in b.requests[-1]["prompt"]
    d = forge.public(app.store, pid, BR, rid)
    assert d["art"]["portrait"]["engine"] == "chatgpt" and d["art"]["sheet"]
    item = next(x for x in forge.list_dossiers(app.store, pid, BR) if x["record_id"] == rid)
    assert item["has_portrait"] and item["views_done"] == 10
    for bad in ({"what": "x"}, {"what": "views", "engine": "dalle"}, {"what": "views", "views": ["top"]}):
        with pytest.raises(AkoweError):
            app.forge.start_art("author", pid, BR, rid, bad)


@pytest.mark.parametrize("code", ["SD_NOT_CONNECTED", "CHATGPT_NOT_READY", "IMAGE_REFUSED", "IMAGE_TIMEOUT",
                                  "IMAGE_LIMIT", "NO_IMAGE_ENGINE"])
def test_art_error_codes_are_plain_and_keep_earlier_pictures(ib, code):
    app, pid, b = ib
    rid = make_char(app, pid, "Moki Vey")
    b.script[3] = (503 if code != "IMAGE_REFUSED" else 200,
                   {"ok": False, "error": code, "message": "short reason", "hint": "do this"})
    j = run_art(app, pid, rid, {"what": "views", "engine": "chatgpt", "views": ["front", "side", "back", "dash"]})
    assert j["status"] == "error" and j["error"]["code"] == code
    assert j["error"]["message"].startswith("short reason") and "2 picture(s) made before are kept" in j["error"]["message"]
    assert j["error"]["fix"] == "do this"
    d = forge.public(app.store, pid, BR, rid)
    assert d["art"]["views"]["front"] and d["art"]["views"]["side"] and not d["art"]["views"]["back"]


def test_art_without_a_lock_unreachable_and_paths_only(ib, tmp_path):
    app, pid, b = ib
    rid = make_char(app, pid, "Moki Vey")
    b.script[1] = (400, {"ok": False, "error": "NO_LOCK", "message": "no lock"})
    j = run_art(app, pid, rid, {"what": "portrait"})
    assert j["status"] == "done" and "characterLock" in b.requests[0] and "characterLock" not in b.requests[1]
    assert b.requests[0]["engine"] == "auto"
    assert "no character lock" in " ".join(forge.public(app.store, pid, BR, rid)["art"]["portrait"]["warnings"])
    # an answer with only a local path (AutoInjector runs on the same computer)
    pic = tmp_path / "made.jpg"
    pic.write_bytes(png(fmt="JPEG"))
    b.script[3] = (200, {"ok": True, "engine": "sd", "paths": [str(pic)], "seed": 7})
    j = run_art(app, pid, rid, {"what": "views", "views": ["idle"]})
    assert j["status"] == "done"
    assert forge.public(app.store, pid, BR, rid)["art"]["views"]["idle"]["mime"] == "image/jpeg"
    # a 200 answer without a picture
    b.script[4] = (200, {"ok": True, "engine": "sd", "images": []})
    j = run_art(app, pid, rid, {"what": "views", "views": ["dash"]})
    assert j["status"] == "error" and j["error"]["code"] == "IMAGE_BAD_ANSWER"
    # a wrong key and an AutoInjector that is not running
    b.script[5] = (401, {"ok": False, "error": "UNAUTHORIZED"})
    assert run_art(app, pid, rid, {"what": "portrait"})["error"]["code"] == "IMAGE_BRIDGE_KEY"
    b.close()
    j = run_art(app, pid, rid, {"what": "portrait"})
    assert j["status"] == "error" and j["error"]["code"] == "IMAGE_BRIDGE_UNREACHABLE"
    b.close = lambda: None  # already closed


def test_image_bridge_settings_are_local_only(fx):
    app, _f, pid = fx
    info = forge.bridge_info(app)
    assert info["url"] == "" and info["default_url"] == forge.DEFAULT_IMAGE_BRIDGE and not info["has_token"]
    with pytest.raises(AkoweError):
        forge.save_bridge_settings(app, {"url": "http://example.com:8765"})
    out = forge.save_bridge_settings(app, {"url": "http://localhost:9999", "token": "abc"})
    assert out["url"] == "http://localhost:9999" and out["has_token"] and out["uses"][0] == "http://localhost:9999"
    assert "abc" not in json.dumps(out)
    assert forge.save_bridge_settings(app, {"url": "", "token": None})["has_token"] is False


def test_first_picture_reads_every_answer_shape(tmp_path):
    raw = png()
    b64 = base64.b64encode(raw).decode()
    assert forge.first_picture({"images": [b64], "seed": 3}) == (raw, 3)
    assert forge.first_picture({"images": [{"base64": "data:image/png;base64," + b64, "seed": 5}]}) == (raw, 5)
    p = tmp_path / "x.png"
    p.write_bytes(raw)
    assert forge.first_picture({"paths": [str(p)]}) == (raw, None)
    with pytest.raises(forge.ArtProblem):
        forge.first_picture({"images": [], "paths": ["/does/not/exist.png"]})


def test_upload_own_picture(fx):
    app, _f, pid = fx
    rid = make_char(app, pid, "Moki Vey")
    out = app.forge.upload("author", pid, BR, rid, "portrait", png(fmt="JPEG"), {})
    assert out["ok"] and out["art"]["portrait"]["source"] == "upload" and out["art"]["portrait"]["mime"] == "image/jpeg"
    out = app.forge.upload("author", pid, BR, rid, "three_quarter_back", png(), {})
    assert out["art"]["views"]["three_quarter_back"]["mime"] == "image/png"
    for slot, data in (("portrait", b"GIF89a....."), ("portrait", b""), ("top", png()), ("portrait", "text")):
        with pytest.raises(AkoweError):
            app.forge.upload("author", pid, BR, rid, slot, data, {})
    assert forge.raw_entry(app.store, pid, BR, rid)["history"][-1]["what"] == "art"


# ====================================================================== the PDF
def pdf_of(app, pid, rid):
    data, name = forge.pdf_bytes(app, pid, BR, rid)
    assert data.startswith(b"%PDF-1.7") and name.endswith(" - Character Forge dossier.pdf")
    return data


def dark(img, xy) -> bool:
    r, g, b = img.getpixel(xy)[:3]
    return abs(r - 27) <= 6 and abs(g - 31) <= 6 and abs(b - 35) <= 6


def test_pdf_of_the_moki_example_looks_like_the_sample(fx):
    app, _f, pid = fx
    out = forge_example.load(app, "author", pid, BR, {})
    rid = out["record_id"]
    data = pdf_of(app, pid, rid)
    r = pypdf.PdfReader(io.BytesIO(data))
    assert 14 <= len(r.pages) <= 20
    w1, h1 = float(r.pages[0].mediabox.width), float(r.pages[0].mediabox.height)
    w2, h2 = float(r.pages[1].mediabox.width), float(r.pages[1].mediabox.height)
    assert h1 > w1 and w2 > h2  # page 2 is the landscape plate
    t1, t2, t3 = (r.pages[i].extract_text() for i in range(3))
    assert "MOKI VEY" in t1 and "THE MAN WHO HOLDS THE LINE" in t1 and "CH-001 | REV 1 | DRAFT | 1" in t1
    assert "MOKI VEY / TEN-VIEW REFERENCE" in t2 and "ATTACK / EMPTY HAND" in t2 and "DRAW / TOOL REACH" in t2
    assert "CHARACTER FORGE / MOKI VEY / PROPOSED CHARACTER DETAILS" in t3 and "01 / Character record" in t3
    assert "[C,A]" in t3 and "Supplied canon:" in t3 and "C Canon" in t3 and "E Essential on-page detail" in t3
    every = "\n".join(p.extract_text() for p in r.pages)
    for n, (_k, title, _f2) in enumerate(forge.SECTIONS, start=1):
        assert f"{n:02d} / {title}" in every
    assert "[S,P] Goals:" in every and "Imani Vey / CH-002:" in every and "2157-2166 / foundations:" in every
    assert sum(1 for p in r.pages if p.get("/Resources") and "/XObject" in p["/Resources"]) == 2  # cover + plate
    doc = pdfium.PdfDocument(data)
    for i in (0, 2):
        img = doc[i].render(scale=0.5).to_pil()
        assert dark(img, (3, 3)) and dark(img, (img.width - 4, img.height - 4)), i
    p3 = doc[2].render(scale=1).to_pil()
    assert dark(p3, (20, p3.height // 2)) and not dark(p3, (p3.width // 2, 115))  # a card is not background
    # a revision bump and READY show in the footer
    forge.approve(app.store, pid, BR, rid, {"all": True})
    t1 = pypdf.PdfReader(io.BytesIO(pdf_of(app, pid, rid))).pages[0].extract_text()
    assert "CH-001 | REV 2 | READY | 1" in t1


def test_pdf_with_no_art_and_very_long_cards_never_overflows(fx):
    app, _f, pid = fx
    rid = make_char(app, pid, "Ọlá Ẹ̀ní Lighthouse-keeper-with-a-very-long-name")
    long = " ".join(f"word{i}" for i in range(120)) + " " + "x" * 250  # just under the 1 200-character field limit
    put(app, pid, rid, {"inner_life": {k: {"text": long} for k in ("wants", "needs", "fear", "secret")},
                        "voice": {"samples": {"text": "\n".join(f"Line {i}" for i in range(30))}}})
    data = pdf_of(app, pid, rid)
    r = pypdf.PdfReader(io.BytesIO(data))
    text = "\n".join(p.extract_text() for p in r.pages)
    assert "OLÁ ENÍ LIGHTHOUSE" in text.upper() and "word119" in text and "Line 29" in text and "?" not in text
    assert "Not filled in yet." in text
    # every text op stays inside the page and above the footer
    d = forge.public(app.store, pid, BR, rid)
    from akowe.exporters import layout as lay
    captured = {}
    real = forge_pdf.render_pdf

    def spy(layout, **kw):
        captured["layout"] = layout
        return real(layout, **kw)
    forge_pdf.render_pdf = spy
    try:
        forge_pdf.render(d, {})
    finally:
        forge_pdf.render_pdf = real
    for pg in captured["layout"].pages[2:]:
        w, _h = pg.size or forge_pdf.PORTRAIT
        for op in pg.ops:
            if op[0] == "text":
                x, y, s = op[3], op[4], op[5]
                assert 0 < x and x + lay.text_width(s, op[1], op[2]) <= w - 30, s[:40]
                assert y >= 20
            if op[0] == "rect":
                assert op[2] >= forge_pdf.FOOT_TOP - 1  # cards never reach into the footer
    doc = pdfium.PdfDocument(data)
    assert dark(doc[1].render(scale=0.5).to_pil(), (3, 3))  # the empty plate is dark with placeholders


def test_pdf_uses_a_sheet_as_the_plate_and_skips_broken_pictures(fx):
    app, _f, pid = fx
    rid = make_char(app, pid, "Bo Rook")
    app.forge.upload("author", pid, BR, rid, "sheet", png(300, 100), {})
    d = forge.public(app.store, pid, BR, rid)
    data = forge_pdf.render(d, {"sheet": png(300, 100), "portrait": b"\x89PNG\r\n\x1a\nbroken"})
    r = pypdf.PdfReader(io.BytesIO(data))
    assert "FRONT" not in r.pages[1].extract_text()  # the sheet replaces the grid
    assert "/XObject" in r.pages[1]["/Resources"] and "/XObject" not in r.pages[0]["/Resources"]


# ====================================================================== the example, the brief, the save, HTTP
def test_example_loads_once_with_art(fx):
    app, _f, pid = fx
    out = forge_example.load(app, "author", pid, BR, {})
    assert out["created"] and out["dossier"]["name"] == "Moki Vey" and out["dossier"]["code"] == "CH-001"
    d = out["dossier"]
    assert field(d, "supplied_canon")["protected"] and field(d, "supplied_canon")["status"] == "supplied"
    assert field(d, "wants")["status"] == "proposed" and d["counts"]["views_done"] == 10 and d["art"]["portrait"]
    assert field(d, "relationship_5")["label"] == "Mother: Amara Vey"
    again = forge_example.load(app, "author", pid, BR, {})
    assert not again["created"] and again["record_id"] == out["record_id"] and "already" in again["message"]
    assert len(chars_mod.canon_characters(app.store, pid, BR)) == 1
    # the example pictures are small, as kept in the repo
    for f in forge_example.EXAMPLE_DIR.iterdir():
        assert f.stat().st_size < 300 * 1024, f.name


def test_chapter_brief_only_accepted_fields_with_the_needed_letters(fx):
    app, _f, pid = fx
    out = forge_example.load(app, "author", pid, BR, {})
    rid = out["record_id"]
    present = [c for c in chars_mod.canon_characters(app.store, pid, BR)]
    b = forge.chapter_brief(app.store, pid, BR, present, {rid: ["A", "E"]})
    assert list(b[0]["details"]) == ["Supplied canon"]  # the author's own; everything else is still proposed
    assert forge.chapter_brief(app.store, pid, BR, present, {rid: ["F"]}) == []
    forge.approve(app.store, pid, BR, rid, {"fields": ["physique", "primary_style", "visual_anchors", "wants"]})
    b = forge.chapter_brief(app.store, pid, BR, present, {rid: ["A", "E"]})
    assert b[0]["name"] == "Moki Vey" and b[0]["code"] == "CH-001"
    labels = set(b[0]["details"])
    assert "Physique" in labels and "Fixed visual anchors" in labels and "Supplied canon" in labels
    assert "Primary style" not in labels and "What they want" not in labels  # F not asked; sheet already in voice cards
    assert forge.letters_for(["They fight on the quay"], True) == ["E", "A", "F"]
    assert forge.letters_for(["a quiet supper"], False) == ["E"]
    forge.approve(app.store, pid, BR, rid, {"all": True})
    big = forge.chapter_brief(app.store, pid, BR, present, {rid: list("CAFMKSE")}, budget=1200)
    assert len(json.dumps(big, ensure_ascii=False)) <= 1200 and big


def test_book_save_includes_the_dossier(fx):
    app, _f, pid = fx
    forge_example.load(app, "author", pid, BR, {})
    files, _info = app.saver.collect(pid, BR)
    names = sorted(k for k in files if k.startswith("Character Forge/"))
    assert "Character Forge/CH-001 Moki Vey - Character Forge dossier.pdf" in names
    assert "Character Forge/CH-001 Moki Vey - Character Forge dossier.json" in names
    assert "Character Forge/CH-001 pictures/portrait.jpg" in names and "Character Forge/CH-001 pictures/dash.jpg" in names
    assert json.loads(files["Character Forge/CH-001 Moki Vey - Character Forge dossier.json"])["code"] == "CH-001"


def test_http_api_contract(fx, no_provider_sleep):  # noqa: F811
    from akowe.server import make_handler
    app, fake, pid = fx
    rid = make_char(app, pid, "Moki Vey")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    base = f"/api/projects/{pid}/branches/{BR}/forge"
    try:
        st, body, _ = call(port, "GET", f"{base}/characters")
        assert st == 200 and body["characters"][0] == {**body["characters"][0], "record_id": rid, "name": "Moki Vey",
                                                       "kind": "character", "code": "CH-001", "revision": 0,
                                                       "readiness": "draft", "has_portrait": False, "views_done": 0}
        st, d, _ = call(port, "GET", f"{base}/characters/{rid}")
        assert st == 200 and set(d) >= {"record_id", "name", "code", "revision", "readiness", "tagline", "summary",
                                        "sections", "art"}
        assert d["sections"][0]["key"] == "record" and d["sections"][0]["n"] == 1
        f0 = d["sections"][0]["fields"][0]
        assert set(f0) >= {"key", "label", "letters", "text", "status", "protected"}
        assert set(d["art"]) == {"portrait", "views", "sheet"} and set(d["art"]["views"]) == set(forge.VIEW_KEYS)
        st, d, _ = call(port, "PUT", f"{base}/characters/{rid}",
                        {"sections": {"record": {"supplied_canon": {"text": "Small build.", "protected": True,
                                                                    "letters": ["C", "A"]}}}})
        assert st == 200 and field(d, "supplied_canon")["protected"]
        st, j, _ = call(port, "POST", f"{base}/characters/{rid}/forge", {})
        assert st == 202 and j["job_id"]
        assert forge.wait(app, "author", j["job_id"])["status"] == "done"
        st, j2, _ = call(port, "GET", f"/api/projects/{pid}/branches/{BR}/review/ai/{j['job_id']}")
        assert st == 200 and j2["status"] == "done"
        st, a, _ = call(port, "POST", f"{base}/characters/{rid}/approve", {"fields": ["wants"]})
        assert st == 200 and {"message", "readiness", "revision"} <= set(a)
        st, a, _ = call(port, "POST", f"{base}/characters/{rid}/approve", {"all": True})
        assert st == 200 and a["readiness"] == "ready"
        st, u, _ = call(port, "PUT", f"{base}/characters/{rid}/art/portrait", png(), content_type="image/png")
        assert st == 200 and u["art"]["portrait"]["asset_id"]
        st, pic, _ = call(port, "GET", u["art"]["portrait"]["url"])
        assert st == 200 and pic == png()
        st, pdf, resp = call(port, "GET", f"{base}/characters/{rid}/pdf?download=1")
        assert st == 200 and pdf.startswith(b"%PDF") and "attachment" in resp.getheader("Content-Disposition")
        st, e, _ = call(port, "POST", f"{base}/characters/{rid}/art", {"what": "nope"})
        assert st == 400 and e["errors"][0]["code"] == "INVALID_INPUT"
        st, e, _ = call(port, "GET", f"{base}/characters/A01-nope")
        assert st == 404
        st, e, _ = call(port, "PUT", f"{base}/characters/{rid}", {"sections": {"record": {"role": {"text": "x"}}}})
        assert st == 200  # role is the dossier's own while the canon record has no role
        st, ex, _ = call(port, "POST", f"{base}/example", {})
        assert st == 201 and ex["record_id"] == rid  # a "Moki Vey" already exists: its dossier is reused
        st, s, _ = call(port, "GET", "/api/settings/image-bridge")
        assert st == 200 and "default_url" in s
        st, s, _ = call(port, "PUT", "/api/settings/image-bridge", {"url": "http://8.8.8.8:1"})
        assert st == 400
        st, _b, _ = call(port, "GET", f"{base}/characters", token="wrong-token")
        assert st == 401
    finally:
        httpd.shutdown()
        httpd.server_close()
