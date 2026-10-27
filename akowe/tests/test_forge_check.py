"""🔎 B5 lane C: "Check against the book" — a dossier's accepted fields against the written chapters, for every kind
(characters too). Akọwe's own checks (ages, eye/hair colours, heights, birth and founding years, stated limits in
numbers, who may hold an item, near-miss spellings) find planted contradictions and leave ordinary sentences alone;
the AI path (schema, quotes re-checked against the chapter, unknown fields dropped, a failing AI keeps the rule
findings); verdicts Fix / Fine / Change dossier ("Change dossier" is a proposal with the old text kept, never a write;
another verdict withdraws it); verdicts survive a re-run; Stop keeps what was found; the real book path (run_book);
the HTTP routes."""
from __future__ import annotations

import threading
import time
from http.server import ThreadingHTTPServer

import pytest

from akowe import forge, forge_check, forge_example, forge_kinds
from akowe.errors import AkoweError

from test_failover_review import make_app, no_provider_sleep, run_book  # noqa: F401
from test_failover_review import SlotFake
from test_forge import BR, make_char
from test_server import call

CH1 = "\n\n".join([
    "Moki Vey was thirty-five years old that winter, and his hands knew every pump on the deck.",
    "Moki rubbed his grey eyes and looked at the intake.",
    "He called on Anchor and held the housing for twelve seconds before the tremor came.",
    "Moki stood 190 cm tall in his boots.",
    "Moky shouted down the stairwell.",
    "It was his fourth burst of Anchor in ten minutes.",
])
CH2 = "\n\n".join([
    "Ten minutes later, Moki used Anchor again.",
    "Moki's brown eyes narrowed at the dark platinum glint of the pipes.",
    "Moki gripped the rescue baton and waited.",
    "Oren Sael gripped the rescue baton and smiled.",
    "Nacre was founded in 2075 by salvage crews, the old songs said.",
    "Moki laughed loudly at every meeting, a man who loved crowds.",
])
CHAPTERS = [{"chapter_id": "ch1", "number": 1, "text": CH1}, {"chapter_id": "ch2", "number": 2, "text": CH2}]


class CheckFake(SlotFake):
    """SlotFake (writes a whole book) + the manuscript check: ``check_answers`` per chapter number (a list of findings), ``check_fail``."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.check_calls: list = []
        self.check_answers: dict = {}
        self.check_fail = False

    def submit(self, slot, system, user, schema):
        if "manuscript check" in (system or "") + (user or ""):
            import json
            ctx = json.loads(user.split("\n", 1)[1]).get("context") or {}
            with self.lock:
                self.check_calls.append({"slot": slot["slot_id"], "context": ctx, "schema": schema})
            if self.check_fail:
                raise AkoweError("TIMEOUT", "", "the fake AI did not answer in time")
            return {"findings": self.check_answers.get(ctx["chapter"]["number"], [])}, {"model": "fake-check"}
        return super().submit(slot, system, user, schema)


@pytest.fixture
def cx(tmp_path, monkeypatch):
    fake = CheckFake()
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    pid = app.engine.bootstrap_project("author", "Check book")
    out = forge_example.load(app, "author", pid, BR, {})
    moki = out["record_id"]
    sael = make_char(app, pid, "Oren Sael")
    forge.approve(app.store, pid, BR, moki, {"all": True})
    world = {w["kind"]: w["record_id"] for w in out["world"]}
    for kind, rid in world.items():
        forge_kinds.approve(app.store, pid, BR, kind, rid, {"all": True})
    chapters = list(CHAPTERS)
    monkeypatch.setattr(forge_check, "book_chapters", lambda _a, _p, _pid, _b: chapters)
    return app, fake, pid, moki, sael, world, chapters


def check(app, pid, kind, rid, body=None):
    j = app.forge.start_check("author", pid, BR, kind, rid, body or {"ai": False})
    j = forge.wait(app, "author", j["job_id"])
    return j, forge_check.public_state(app.store, pid, BR, kind, rid)


def by_check(st):
    out: dict = {}
    for f in st["findings"]:
        out.setdefault(f["check"], []).append(f)
    return out


# ====================================================================== Akọwe's own checks
def test_rule_checks_find_the_planted_contradictions_of_a_character(cx):
    app, _f, pid, moki, _s, _w, _c = cx
    j, st = check(app, pid, "character", moki)
    assert j["status"] == "done" and st["status"] == "done" and st["chapters_done"] == 2, j
    got = by_check(st)
    assert set(got) == {"age", "eyes", "limit", "height", "name"}, [(f["check"], f["quote"]) for f in st["findings"]]
    age = got["age"][0]
    assert age["field"] == "identity" and age["chapter"] == 1 and "35" in age["problem"] and "32" in age["problem"]
    assert age["quote"].startswith("Moki Vey was thirty-five years old") and len(age["quote"]) <= 240
    assert age["dossier_text"].startswith("35;") and age["fix"] and age["source"] == "rule" and age["verdict"] is None
    assert got["eyes"][0]["field"] == "eyes" and "grey" in got["eyes"][0]["problem"]
    assert got["eyes"][0]["dossier_text"].startswith("Deep grey")
    lim = {(f["field"], f["quote"][:20]) for f in got["limit"]}
    assert ("power_effects", "He called on Anchor ") in lim or ("power_ledger", "He called on Anchor ") in lim
    assert any(f["quote"].startswith("It was his fourth burst") for f in got["limit"])
    assert all(f["chapter"] == 1 for f in got["limit"])  # "Ten minutes later, Moki used Anchor again." is fine
    assert got["height"][0]["field"] == "physique" and "190" in got["height"][0]["problem"]
    assert got["name"][0]["quote"].startswith("Moky") and "Moki" in got["name"][0]["problem"]
    assert all(len(f["id"]) == 14 and f["id"].startswith("F-") for f in st["findings"])
    assert [a["mentions"] > 0 for a in st["appearances"]] == [True, True] and not st["ai"]
    assert "disagree" in j["results"][-1]["message"]


def test_rule_checks_for_an_item_a_place_and_a_magic_system(cx):
    app, _f, pid, _m, _s, world, _c = cx
    _j, st = check(app, pid, "item", world["item"])
    got = by_check(st)
    assert list(got) == ["holder"], [(f["check"], f["quote"]) for f in st["findings"]]
    h = got["holder"][0]
    assert h["field"] == "forbidden_users" and h["quote"].startswith("Oren Sael gripped") and "never" in h["problem"]
    _j, st = check(app, pid, "place", world["place"])
    got = by_check(st)
    assert "year" in got and got["year"][0]["field"] == "founding" and "2075" in got["year"][0]["problem"]
    assert got["year"][0]["dossier_text"].startswith("Founded in 2075")
    _j, st = check(app, pid, "magic", world["magic"])
    got = by_check(st)
    assert {f["field"] for f in got["limit"]} == {"hard_limits"} and len(got["limit"]) == 2
    assert {f["quote"][:12] for f in got["limit"]} == {"He called on", "It was his f"}


def test_stated_limits_and_helpers():
    acc = {"hard_limits": {"label": "Hard limits", "text": "Lasts up to eight seconds per burst; three bursts within "
                                                           "ten minutes at most.", "letters": ["M"]},
           "named_power_1": {"label": "Named power 1", "text": "Anchor: braces a load."}}
    lims = forge_check.stated_limits(acc, "magic", ["Tide"])
    assert {(x["family"], x["value"], x["unit"]) for x in lims} == {("time", 8, "seconds"), ("count", 3, "burst")}
    assert all("Anchor" in x["terms"] and "Tide" in x["terms"] for x in lims)
    assert forge_check._dist1("Moky", "Moki") and not forge_check._dist1("Mako", "Moki")
    assert forge_check._dist1("Mokki", "Moki") and not forge_check._dist1("Moki", "Moki")
    assert forge_check.quote_of("x" * 400).endswith("…") and len(forge_check.quote_of("x" * 400)) == 240


def test_nothing_to_compare_and_no_chapters(cx, monkeypatch):
    app, _f, pid, _m, sael, _w, chapters = cx
    j, st = check(app, pid, "character", sael)
    assert j["status"] == "done" and st["findings"] == [] and "accepted text" in st["message"]
    forge.edit(app.store, pid, BR, sael, {"sections": {"record": {"identity": {"text": "51; director."}}}})
    chapters.clear()
    j, st = check(app, pid, "character", sael)
    assert "No chapters are written yet" in st["message"]


# ====================================================================== the AI slot
def test_ai_findings_are_checked_against_the_chapter(cx, no_provider_sleep):  # noqa: F811
    app, fake, pid, moki, _s, _w, _c = cx
    fake.check_answers = {2: [
        {"field": "presence", "quote": "Moki laughed loudly at every meeting, a man who loved crowds.",
         "problem": "The page makes him loud and sociable; the dossier keeps him watchful and contained.",
         "fix": "Make him quiet in the meeting.", "dossier_text": "Loud and sociable in a crowd."},
        {"field": "presence", "quote": "Moki flew over the city.", "problem": "invented", "fix": "x"},
        {"field": "wings", "quote": "Moki gripped the rescue baton and waited.", "problem": "no such field",
         "fix": "x"}]}
    j, st = check(app, pid, "character", moki, {"ai": True, "slot_id": "AI-2"})
    assert j["status"] == "done" and st["ai"] and not st["ai_problem"]
    ai = [f for f in st["findings"] if f["source"] == "ai"]
    assert len(ai) == 1 and ai[0]["field"] == "presence" and ai[0]["field_label"] == "Expressions and overall presence"
    assert ai[0]["chapter"] == 2 and ai[0]["dossier_text"] == "Loud and sociable in a crowd." and ai[0]["check"] == "ai"
    assert "2 AI finding(s) were left out" in st["message"]
    assert len(fake.check_calls) == 2 and all(c["slot"] == "AI-2" for c in fake.check_calls)
    c1 = fake.check_calls[0]
    items = c1["schema"]["properties"]["findings"]["items"]
    assert set(items["required"]) == {"field", "quote", "problem", "fix"} and c1["context"]["chapter"]["number"] == 1
    assert "Moki rubbed his grey eyes" in c1["context"]["chapter"]["text"]
    assert c1["context"]["dossier"]["fields"]["eyes"]["text"].startswith("Deep brown")
    assert {r["field"] for r in c1["context"]["rule_findings"]} >= {"identity", "eyes"}  # already found: not asked again
    assert all(f["status"] in ("supplied", "approved") for s in forge.public(app.store, pid, BR, moki)["sections"]
               for f in s["fields"] if f["text"])  # the check changes nothing in the dossier


def test_a_failing_ai_keeps_the_rule_findings(cx, no_provider_sleep):  # noqa: F811
    app, fake, pid, moki, _s, _w, _c = cx
    fake.check_fail = True
    j, st = check(app, pid, "character", moki, {"ai": True})
    assert j["status"] == "done" and st["status"] == "done"
    assert st["ai_problem"] and "skipped from chapter 1" in st["ai_problem"]
    assert {f["check"] for f in st["findings"]} >= {"age", "eyes"} and len(fake.check_calls) >= 1
    with pytest.raises(AkoweError):
        app.forge.start_check("author", pid, BR, "character", moki, {"ai": "yes"})
    with pytest.raises(AkoweError):
        app.forge.start_check("author", pid, BR, "item", "FK-nope", {})


# ====================================================================== verdicts
def test_verdicts_and_change_dossier_is_a_proposal(cx):
    app, _f, pid, moki, _s, world, _c = cx
    _j, st = check(app, pid, "character", moki)
    got = by_check(st)
    age, eyes = got["age"][0], got["eyes"][0]
    out = forge_check.set_verdict(app.store, pid, BR, "character", moki, age["id"], {"verdict": "fix"})
    assert out["finding"]["verdict"] == "fix" and out["counts"]["fix"] == 1 and "dossier" not in out
    old = next(f for s in forge.public(app.store, pid, BR, moki)["sections"] for f in s["fields"] if f["key"] == "eyes")
    out = forge_check.set_verdict(app.store, pid, BR, "character", moki, eyes["id"], {"verdict": "change_dossier"})
    f = next(x for s in out["dossier"]["sections"] for x in s["fields"] if x["key"] == "eyes")
    assert f["status"] == "proposed" and f["text"].startswith("Deep grey") and f["was"] == old["text"]
    assert f["by"] == {"kind": "check", "finding": eyes["id"]} and out["dossier"]["readiness"] == "draft"
    assert out["finding"]["proposal"]["field"] == "eyes" and "approve" in out["message"]
    assert out["dossier"]["revision"] == forge.public(app.store, pid, BR, moki)["revision"]  # no new revision
    # the accepted text still drives the chapter briefs: the proposal does not
    present = [c for c in forge.chars_mod.canon_characters(app.store, pid, BR) if c["record_id"] == moki]
    brief = forge.chapter_brief(app.store, pid, BR, present, {moki: ["A"]})
    assert "Eyes" not in (brief[0]["details"] if brief else {})
    # another verdict withdraws the proposal: the approved text is back
    forge_check.set_verdict(app.store, pid, BR, "character", moki, eyes["id"], {"verdict": "fine"})
    f = next(x for s in forge.public(app.store, pid, BR, moki)["sections"] for x in s["fields"] if x["key"] == "eyes")
    assert f["text"] == old["text"] and f["status"] == "approved" and "was" not in f
    # the author's own text, then approval
    forge_check.set_verdict(app.store, pid, BR, "character", moki, eyes["id"],
                            {"verdict": "change_dossier", "text": "Grey, flecked with brown."})
    out = forge.approve(app.store, pid, BR, moki, {"fields": ["eyes"]})
    f = next(x for s in out["dossier"]["sections"] for x in s["fields"] if x["key"] == "eyes")
    assert f["text"] == "Grey, flecked with brown." and f["status"] == "approved" and "was" not in f
    # verdicts survive a re-run (stable ids); the corrected eyes are no longer a finding
    _j, st = check(app, pid, "character", moki)
    again = {x["id"]: x for x in st["findings"]}
    assert again[age["id"]]["verdict"] == "fix"
    assert eyes["id"] in again and again[eyes["id"]].get("stale") and again[eyes["id"]]["verdict"] == "change_dossier"
    # protected or unknown: refused
    st2 = forge_check.get_state(app.store, pid, BR, "character", moki)
    st2["findings"].append(dict(age, id="F-000000000000", field="supplied_canon", verdict=None))
    forge_check._save_state(app.store, pid, BR, "character", moki, st2)
    with pytest.raises(AkoweError) as e:
        forge_check.set_verdict(app.store, pid, BR, "character", moki, "F-000000000000",
                                {"verdict": "change_dossier", "text": "x"})
    assert e.value.code == "LOCKED_FACT"
    for bad in ({"verdict": "maybe"}, {"verdict": "fix", "text": 3}):
        with pytest.raises(AkoweError):
            forge_check.set_verdict(app.store, pid, BR, "character", moki, age["id"], bad)
    with pytest.raises(AkoweError) as e:
        forge_check.set_verdict(app.store, pid, BR, "character", moki, "F-nope", {"verdict": "fix"})
    assert e.value.code == "NOT_FOUND"
    # a place: Change dossier -> proposal -> approve
    _j, st = check(app, pid, "place", world["place"])
    y = by_check(st)["year"][0]
    out = forge_check.set_verdict(app.store, pid, BR, "place", world["place"], y["id"], {"verdict": "change_dossier"})
    f = next(x for s in out["dossier"]["sections"] for x in s["fields"] if x["key"] == "founding")
    assert f["status"] == "proposed" and f["text"].startswith("Founded in 2075") and f["was"].startswith("Founded in 2091")
    out = forge_kinds.approve(app.store, pid, BR, "place", world["place"], {"fields": ["founding"]})
    f = next(x for s in out["dossier"]["sections"] for x in s["fields"] if x["key"] == "founding")
    assert f["status"] == "approved" and "was" not in f and f["text"].startswith("Founded in 2075")


def test_stop_keeps_the_findings_so_far(cx, monkeypatch):
    app, _f, pid, moki, _s, _w, chapters = cx
    chapters[:] = [dict(CHAPTERS[0], chapter_id=f"ch{i}", number=i) for i in range(1, 7)]
    real = forge_check.rule_findings

    def slow(*a, **kw):
        time.sleep(0.25)
        return real(*a, **kw)
    monkeypatch.setattr(forge_check, "rule_findings", slow)
    j = app.forge.start_check("author", pid, BR, "character", moki, {"ai": False})
    for _ in range(200):
        if forge_check.get_state(app.store, pid, BR, "character", moki).get("chapters_done", 0) >= 1:
            break
        time.sleep(0.02)
    app.review.cancel_job("author", j["job_id"])
    j = forge.wait(app, "author", j["job_id"])
    st = forge_check.public_state(app.store, pid, BR, "character", moki)
    assert j["status"] == "cancelled" and st["status"] == "stopped" and 1 <= st["chapters_done"] < 6
    assert st["findings"] and "findings so far are kept" in st["message"]


# ====================================================================== the real book (run_book) and HTTP
def test_check_reads_the_written_book(tmp_path, no_provider_sleep):  # noqa: F811
    fake = CheckFake()
    fake.chapter_texts = {"ch1": "# The quay\n\nMara found the brass key in the sand.\n\nThe brass key had been forged "
                                 "in 1820, the smith said.",
                          "ch2": "# The light\n\nMara climbed the stairs of the lighthouse."}
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    pid = run["project_id"]
    rid = forge_kinds.create(app.store, pid, BR, "item", {"name": "Brass key"})["record_id"]
    forge_kinds.edit(app.store, pid, BR, "item", rid, {"sections": {"history": {"made_when": {
        "text": "Forged in 1850 by the harbour smith."}}}})
    j, st = check(app, pid, "item", rid)
    assert j["status"] == "done" and st["chapters_total"] >= 2
    y = [f for f in st["findings"] if f["check"] == "year"]
    assert len(y) == 1 and y[0]["chapter"] == 1 and y[0]["field"] == "made_when" and "1820" in y[0]["quote"]


def test_http_check_routes(cx, no_provider_sleep):  # noqa: F811
    from akowe.server import make_handler
    app, _f, pid, moki, _s, world, _c = cx
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    base = f"/api/projects/{pid}/branches/{BR}/forge"
    try:
        st, body, _ = call(port, "GET", f"{base}/characters/{moki}/check")
        assert st == 200 and body["status"] == "never" and body["findings"] == []
        st, j, _ = call(port, "POST", f"{base}/characters/{moki}/check", {"ai": False})
        assert st == 202 and j["job_id"] and j["kind"] == "forge_check"
        assert forge.wait(app, "author", j["job_id"])["status"] == "done"
        st, j2, _ = call(port, "GET", f"/api/projects/{pid}/branches/{BR}/review/ai/{j['job_id']}")
        assert st == 200 and j2["status"] == "done" and j2["total"] == 2 and j2["done"] == 2
        st, body, _ = call(port, "GET", f"{base}/characters/{moki}/check")
        assert st == 200 and body["status"] == "done" and body["counts"]["open"] == len(body["findings"]) > 3
        f = body["findings"][0]
        assert set(f) >= {"id", "field", "field_label", "chapter", "chapter_id", "quote", "problem", "fix", "verdict"}
        st, out, _ = call(port, "PUT", f"{base}/characters/{moki}/check/{f['id']}", {"verdict": "fine"})
        assert st == 200 and out["finding"]["verdict"] == "fine"
        st, e, _ = call(port, "PUT", f"{base}/characters/{moki}/check/{f['id']}", {"verdict": "maybe"})
        assert st == 400
        st, j, _ = call(port, "POST", f"{base}/places/{world['place']}/check", {"ai": False})
        assert st == 202 and forge.wait(app, "author", j["job_id"])["status"] == "done"
        st, body, _ = call(port, "GET", f"{base}/places/{world['place']}/check")
        y = next(x for x in body["findings"] if x["check"] == "year")
        st, out, _ = call(port, "PUT", f"{base}/places/{world['place']}/check/{y['id']}",
                          {"verdict": "change_dossier", "text": "Founded in 2075 by salvage crews."})
        assert st == 200 and out["dossier"]["counts"]["proposed"] == 1 and out["counts"]["change_dossier"] == 1
        st, e, _ = call(port, "GET", f"{base}/items/FK-nope/check")
        assert st == 404
    finally:
        httpd.shutdown()
        httpd.server_close()
