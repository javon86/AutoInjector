"""AI assist ("Fill with AI") and the Bible Builder: proposals only, never committed (except the
explicit Bible Builder create step, which makes DRAFT records), invented links removed, explicit
slot honoured, re-asks, concurrency, per-section builder runs, reports, auth and log hygiene."""
from __future__ import annotations

import http.client
import json
import logging
import threading
import time

import pytest

from akowe import providers as prov
from akowe.assist import AssistService, ai_schema, supports
from akowe.server import App, make_handler

from test_autoinjector_adapter import BRIDGE_TOKEN, FakeBridge

PROMPT = "a grumpy lighthouse keeper who hides a secret ZZPROMPT"
SECRET_REPLY = "ZZREPLY-identity-text"


def fact(s, p, v, a="FACT"):
    return {"subject_id": s, "predicate": p, "value": v, "assertion_type": a, "effective_from": None,
            "effective_to": None, "source_refs": []}


class FakeAI:
    """Test adapter: answers sketches from the requested counts and item/form requests from the schema."""

    def __init__(self, delay=0.0, extra=None, bad_first=0, link_name=None):
        self.calls: list[dict] = []
        self.delay = delay
        self.extra = extra or {}
        self.bad_first = bad_first
        self.link_name = link_name
        self.active = 0
        self.max_active = 0
        self.lock = threading.Lock()

    def submit(self, slot, system, user, schema):
        package = json.loads(user.split("\n", 1)[1])
        ctx = package["context"]
        with self.lock:
            self.calls.append({"slot": slot["slot_id"], "system": system, "context": ctx, "schema": schema})
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            if self.delay:
                time.sleep(self.delay)
            props = schema["properties"]
            if "world_summary" in props:
                items = []
                for sec, n in ctx["requested"].items():
                    for i in range(n):
                        links = [self.link_name] if self.link_name and sec == "A01" else []
                        if sec == "A01" and not self.link_name:
                            links = [x["name"] for x in ctx["existing_items"] if x["section"] == "A04"][:1] or \
                                ["Harbor 0"] if "A04" in ctx["requested"] else []
                        items.append({"section": sec, "name": f"{'Harbor' if sec == 'A04' else sec + ' item'} {i}",
                                      "role": f"role of {sec} {i}", "links": links})
                return {"world_summary": "A foggy coast.", "items": items}, {"model": "fake-model"}
            if self.bad_first:
                self.bad_first -= 1
                return {"concept": 123, "attributes": {}, "facts": []}, {"model": "fake-model"}
            this = ctx.get("this_item") or {}
            sid = this.get("subject_id") or "tom"
            name = this.get("name") or "Old Tom"
            out = {}
            if "concept" in props:
                out["concept"] = name
            if "attributes" in props:
                out["attributes"] = {k: f"{k}: {SECRET_REPLY}" for k in props["attributes"]["properties"]}
            if "facts" in props:
                out["facts"] = [fact(sid, "entity.name", name)]
            if "idea" in props:
                out.update(idea="A keeper hears the sea", goals=["finish the book"])
            out.update(self.extra)
            return out, {"model": "fake-model"}
        finally:
            with self.lock:
                self.active -= 1


@pytest.fixture
def svc(h):
    return AssistService(h.engine, h.principal)


def ai_on(h, fake, *slots):
    h.engine.providers.test_adapter = fake
    for s in slots or ("AI-1",):
        h.engine.providers.configure_slot(s, {"adapter_id": "anthropic"})


def wait(fn, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        out = fn()
        if out:
            return out
        time.sleep(0.02)
    raise AssertionError("timed out")


def run_job(svc, h, body):
    j = svc.start_assist(h.principal, dict({"project_id": h.project_id, "branch_id": "main",
                                            "target_operation": "A01", "prompt": PROMPT}, **body))
    return wait(lambda: (lambda x: x if x["status"] in ("done", "error", "cancelled") else None)(
        svc.get_assist(h.principal, j["job_id"])))


def n_records(h):
    return h.store.query_one("SELECT COUNT(*) c FROM records WHERE project_id=?", (h.project_id,))["c"]


# ---------------------------------------------------------------------- assist
def test_a01_proposal_validates_and_is_not_committed(h, svc):
    ai_on(h, FakeAI())
    before = n_records(h)
    j = run_job(svc, h, {})
    assert j["status"] == "done", j
    assert j["valid"] is True and not [f for f in j["findings"] if f["rule_id"] == "SCHEMA"]
    p = j["proposal"]
    assert p["concept"] == "Old Tom" and set(p["attributes"]) == {"identity", "role", "traits", "appearance",
                                                                 "background", "goals", "constraints"}
    assert p["protected_fact_flags"] == [] and p["linked_refs"] == []
    assert h.engine.contracts.check("A01", "OUTPUT", p) == []  # a full, valid form
    assert n_records(h) == before  # nothing saved
    assert j["slot"] == "AI-1" and j["model"] == "fake-model" and j["elapsed_ms"] >= 0


def test_user_values_kept_unless_rewrite(h, svc):
    fake = FakeAI()
    ai_on(h, fake)
    cur = {"concept": "Tom the keeper", "attributes": {"role": "MY ROLE", "traits": ""},
           "protected_fact_flags": ["entity.name"], "facts": [fact("tom", "entity.name", "Tom Keeper")]}
    j = run_job(svc, h, {"current_values": cur})
    p = j["proposal"]
    assert p["concept"] == "Tom the keeper" and p["attributes"]["role"] == "MY ROLE"
    assert p["attributes"]["traits"].startswith("traits:")  # blank filled
    assert p["facts"] == [fact("tom", "entity.name", "Tom Keeper")]  # same subject/predicate kept, not doubled
    assert p["protected_fact_flags"] == ["entity.name"]  # author decision, never from the model
    assert "concept" in j["kept_fields"] and "attributes" in j["filled_fields"]
    assert fake.calls[0]["context"]["current_values"]["attributes"] == {"role": "MY ROLE"}
    assert "protected_fact_flags" not in fake.calls[0]["schema"]["properties"]
    j2 = run_job(svc, h, {"current_values": cur, "keep_values": False})
    assert j2["proposal"]["attributes"]["role"].startswith("role:") and j2["proposal"]["concept"] == "Old Tom"
    assert j2["proposal"]["protected_fact_flags"] == ["entity.name"]


def test_invented_refs_stripped_and_reported_real_ones_kept(h, svc):
    real, _ = h.create_approved("A04", {"concept": "Harbor"}, manual_candidate={
        "concept": "Harbor", "attributes": {}, "linked_refs": [], "protected_fact_flags": [],
        "facts": [fact("harbor", "entity.name", "Harbor")]})
    fake_ref = dict(real, record_id="A04-doesnotexist")
    foreign = dict(real, project_id="proj-other")
    ai_on(h, FakeAI(extra={"linked_refs": [real, fake_ref, foreign],
                           "facts": [dict(fact("tom", "entity.name", "Tom"), source_refs=[fake_ref])]}))
    j = run_job(svc, h, {})
    assert j["proposal"]["linked_refs"] == [real]
    assert j["proposal"]["facts"][0]["source_refs"] == []
    paths = sorted(r["path"] for r in j["removed_refs"])
    assert paths == ["/facts/0/source_refs/0", "/linked_refs/1", "/linked_refs/2"]
    assert any(r["record_id"] == "A04-doesnotexist" and "not found" in r["reason"] for r in j["removed_refs"])
    assert j["findings"][0]["rule_id"] == "AI_REF_DROPPED"


def test_context_has_approved_canon_and_protected_facts(h, svc):
    h.create_approved("A04", {"concept": "Harbor"}, manual_candidate={
        "concept": "Harbor", "attributes": {}, "linked_refs": [], "protected_fact_flags": ["entity.name"],
        "facts": [fact("harbor", "entity.name", "Harbor Town")]})
    h.create("A01", {"concept": "Draft Mara"})
    fake = FakeAI()
    ai_on(h, fake)
    run_job(svc, h, {})
    call = fake.calls[0]
    canon = call["context"]["canon"]
    assert canon["approved_records"][0]["names"] == ["Harbor Town"] and canon["approved_records"][0]["ref"]
    assert canon["draft_records"][0]["concept"] == "Draft Mara"
    assert "predicates" in call["context"]["predicate_conventions"]
    assert "x.a04.parent_id" in call["context"]["predicate_conventions"]["owner_extensions"]
    assert PROMPT == call["context"]["author_request"]
    assert "keep every protected fact" in call["system"] and "Set rule" in call["system"]


def test_explicit_slot_honoured_and_roles_overridden(h, svc):
    fake = FakeAI()
    ai_on(h, fake, "AI-1", "AI-2")
    h.engine.providers.configure_slot("AI-1", {"roles": ["A"]})
    assert run_job(svc, h, {})["slot"] == "AI-1"  # auto: role routing
    assert run_job(svc, h, {"slot_id": "AI-2"})["slot"] == "AI-2"  # explicit pick wins over roles
    j = run_job(svc, h, {"slot_id": "AI-3"})  # not set up
    assert j["status"] == "error" and j["error"]["code"] == "CAPABILITY_UNAVAILABLE"
    assert "AI-3" in j["error"]["message"] and "Settings" in j["error"]["fix"]


def test_no_slot_capability_unavailable_with_fix(h, svc):
    j = run_job(svc, h, {})
    assert j["status"] == "error" and j["error"]["code"] == "CAPABILITY_UNAVAILABLE"
    assert j["error"]["fix"] == "Connect AutoInjector in Settings, or add an API key."
    assert n_records(h) == 0


def test_bad_ai_output_reasked_then_ok(h, svc):
    fake = FakeAI(bad_first=1)
    ai_on(h, fake)
    j = run_job(svc, h, {})
    assert j["status"] == "done" and j["valid"] and len(fake.calls) == 2
    assert "rejected by the validator" in fake.calls[1]["system"] and "/concept" in fake.calls[1]["system"]


def test_autoinjector_bridge_reask_then_ok(h, svc, monkeypatch):
    monkeypatch.setattr(prov.time, "sleep", lambda s: None)
    bridge = FakeBridge()
    try:
        good = {"concept": "Old Tom", "attributes": {k: "x" for k in ("identity", "role", "traits", "appearance",
                                                                       "background", "goals", "constraints")},
                "facts": [fact("tom", "entity.name", "Tom")]}
        bridge.script = [("ok", "no json here"), ("ok", "```json\n" + json.dumps(good) + "\n```")]
        h.engine.providers.configure_slot("AI-1", {"adapter_id": "autoinjector", "site": "claude",
                                                   "bridge_url": bridge.url, "api_key": BRIDGE_TOKEN})
        j = run_job(svc, h, {})
        assert j["status"] == "done", j
        assert j["slot_label"] == "Claude through AutoInjector" and j["model"] == "web:claude"
        assert len(bridge.sends) == 2 and "Your previous answer was rejected" in bridge.sends[1]["prompt"]
        assert j["proposal"]["concept"] == "Old Tom" and j["valid"]
    finally:
        bridge.close()


def test_concurrent_jobs(h, svc):
    fake = FakeAI(delay=0.3)
    ai_on(h, fake, "AI-1", "AI-2")
    ids = [svc.start_assist(h.principal, {"project_id": h.project_id, "branch_id": "main", "target_operation": op,
                                          "prompt": "x"})["job_id"] for op in ("A01", "A04", "A07", "A03")]
    done = wait(lambda: (lambda js: js if all(j["status"] == "done" for j in js) else None)(
        [svc.get_assist(h.principal, i) for i in ids]))
    assert len({j["job_id"] for j in done}) == 4 and fake.max_active >= 2
    assert {j["target_operation"] for j in done} == {"A01", "A04", "A07", "A03"}


def test_refusals_and_supported_ops(h, svc):
    c = h.engine.contracts
    assert all(supports(c, f"A{i:02d}") for i in range(1, 19)) and supports(c, "B01")
    assert not supports(c, "B04") and not supports(c, "B09")  # no AI-fillable fields
    assert supports(c, "C02") and supports(c, "F01") and supports(c, "D07") and supports(c, "G08")
    for op in ("C01", "E11", "E12", "H01", "J04", "I09", "K01", "G10", "G11", "F07"):  # never AI-proposed
        assert not supports(c, op), op
    base = {"project_id": h.project_id, "branch_id": "main", "prompt": "x"}
    with pytest.raises(Exception) as e:
        svc.start_assist(h.principal, dict(base, target_operation="B04"))
    assert e.value.code == "INVALID_INPUT"
    with pytest.raises(Exception) as e:
        svc.start_assist(h.principal, dict(base, target_operation="A09"))  # magic is off
    assert e.value.code == "INVALID_INPUT" and "magic" in str(e.value)
    with pytest.raises(Exception) as e:
        svc.start_assist("intruder", dict(base, target_operation="A01"))
    assert e.value.code == "PERMISSION_DENIED"
    with pytest.raises(Exception) as e:
        svc.start_assist(h.principal, dict(base, target_operation="A01", prompt=" "))
    assert e.value.code == "MISSING_INPUT"
    schema = ai_schema(c, "B03")
    assert "constraints" in schema["required"] and "premise_ref" not in schema["required"]


def test_b01_assist(h, svc):
    ai_on(h, FakeAI())
    j = run_job(svc, h, {"target_operation": "B01"})
    assert j["status"] == "done" and j["proposal"]["idea"] == "A keeper hears the sea" and j["valid"]


def test_cancel(h, svc):
    ai_on(h, FakeAI(delay=0.5))
    j = svc.start_assist(h.principal, {"project_id": h.project_id, "branch_id": "main", "target_operation": "A01",
                                       "prompt": "x"})
    svc.cancel_assist(h.principal, j["job_id"])
    out = wait(lambda: (lambda x: x if x["status"] in ("done", "cancelled", "error") else None)(
        svc.get_assist(h.principal, j["job_id"])))
    assert out["status"] == "cancelled" and out["proposal"] is None
    with pytest.raises(Exception):
        svc.get_assist("someone-else", j["job_id"])


# ---------------------------------------------------------------------- Bible Builder
def bible(svc, h, **body):
    return svc.create_bible(h.principal, dict({"project_id": h.project_id, "branch_id": "main",
                                               "idea": "a lighthouse mystery ZZIDEA"}, **body))


def idle(svc, h, sid):
    return wait(lambda: (lambda s: s if not s["busy"] else None)(svc.get_bible(h.principal, sid)))


def test_bible_builder_end_to_end(h, svc):
    fake = FakeAI()
    ai_on(h, fake)
    s = bible(svc, h, counts={"A04": 1, "A01": 2, "A09": 1, "A07": 0})
    s = idle(svc, h, s["session_id"])
    keys = {i["key"]: i for i in s["items"]}
    assert set(keys) == {"A04-1", "A01-1", "A01-2"}  # A09 skipped (magic off), A07 count 0
    assert s["skipped"][0]["section"] == "A09" and "magic" in s["skipped"][0]["reason"]
    assert all(i["status"] == "done" and i["valid"] for i in s["items"])
    assert keys["A01-1"]["links"] == ["A04-1"]
    sec = {x["op"]: x for x in s["sections"]}
    assert sec["A01"]["status"] == "done" and sec["A01"]["message"] == "2 of 2 done" and "A07" not in sec
    # sketch first (one call), then one call per item; items see the sketch and each other
    assert "world_summary" in fake.calls[0]["schema"]["properties"] and len(fake.calls) == 4
    a01_ctx = [c["context"] for c in fake.calls if (c["context"].get("this_item") or {}).get("key") == "A01-1"][0]
    assert a01_ctx["this_item"]["linked_items"][0]["subject_id"] == keys["A04-1"]["subject_id"]
    assert any(x["key"] == "A04-1" and x.get("summary") for x in a01_ctx["builder_items"])
    before = n_records(h)
    out = svc.create_bible_items(h.principal, s["session_id"], {"items": ["A01-1", "A04-1"],
                                                                "edits": {"A04-1": dict(keys["A04-1"]["proposal"],
                                                                                        concept="Edited Harbor")}})
    assert not out["errors"] and [c["key"] for c in out["created"]] == ["A04-1", "A01-1"]  # dependency order
    assert n_records(h) == before + 2  # A01-2 not selected -> not created
    harbor = h.record(out["created"][0]["ref"])
    mara = h.record(out["created"][1]["ref"])
    assert harbor["data"]["concept"] == "Edited Harbor" and harbor["lifecycle"] == "DRAFT"
    assert mara["lifecycle"] == "DRAFT" and mara["data"]["linked_refs"] == [harbor["ref"]]  # real cross-link
    assert out["created"][1]["links_made"][0]["record_id"] == harbor["record_id"]
    # a link target that was not created is dropped, not invented
    out2 = svc.create_bible_items(h.principal, s["session_id"], {"items": ["A01-2", "A01-1"]})
    assert out2["skipped"][0]["key"] == "A01-1" and out2["created"][0]["links_made"][0]["to"] == "A04-1"
    # never validated or accepted automatically
    assert h.store.query_one("SELECT COUNT(*) c FROM approvals WHERE project_id=?", (h.project_id,))["c"] == 0


def test_bible_magic_included_when_feature_on(h, svc):
    h.set_features(magic=True)
    ai_on(h, FakeAI())
    s = idle(svc, h, bible(svc, h, counts={"A09": 1})["session_id"])
    assert [i["op"] for i in s["items"]] == ["A09"] and not s["skipped"]
    assert any(x["op"] == "A09" and x["enabled"] for x in s["available_sections"])


def test_bible_per_section_runs_accumulate_context(h, svc):
    fake = FakeAI(link_name="Harbor 0")
    ai_on(h, fake)
    s = bible(svc, h)  # no counts: nothing generated yet
    assert s["items"] == [] and not s["busy"] and not fake.calls
    sid = s["session_id"]
    with pytest.raises(Exception) as e:
        svc.run_bible(h.principal, sid, {"sections": {"A01": 0}})  # 0 = skip -> nothing to run
    assert e.value.code == "MISSING_INPUT"
    svc.run_bible(h.principal, sid, {"sections": {"A04": 1}})
    s = idle(svc, h, sid)
    assert [i["key"] for i in s["items"]] == ["A04-1"] and {x["op"] for x in s["sections"]} == {"A04"}
    n_calls = len(fake.calls)
    svc.run_bible(h.principal, sid, {"sections": {"A01": 1}})
    s = idle(svc, h, sid)
    assert [i["key"] for i in s["items"]] == ["A04-1", "A01-1"]
    sketch2 = fake.calls[n_calls]["context"]
    assert sketch2["existing_items"][0]["name"] == "Harbor 0" and sketch2["world_summary_so_far"] == "A foggy coast."
    items = {i["key"]: i for i in s["items"]}
    assert items["A01-1"]["links"] == ["A04-1"]  # later section linked to the earlier run's item
    assert len(s["runs"]) == 2 and [r["sections"] for r in s["runs"]] == [{"A04": 1}, {"A01": 1}]
    # regenerate one item
    svc.regenerate_bible_item(h.principal, sid, {"item": "A01-1", "prompt": "make him kinder"})
    s = idle(svc, h, sid)
    assert s["runs"][-1]["kind"] == "regenerate" and "make him kinder" in fake.calls[-1]["context"]["author_request"]


def test_bible_item_failure_and_report_contents(h, svc):
    fake = FakeAI(extra={"linked_refs": [{"project_id": h.project_id, "branch_id": "main", "owner": "A",
                                          "module_id": "A04", "record_id": "A04-invented", "version": 1,
                                          "content_hash": "0" * 64}]})
    ai_on(h, fake)
    s = idle(svc, h, bible(svc, h, counts={"A04": 2, "A01": 1})["session_id"])
    sid = s["session_id"]
    out = svc.create_bible_items(h.principal, sid, {"items": ["A04-1", "A01-1"]})
    assert len(out["created"]) == 2
    md_path, js_path = svc.bible_report(h.principal, sid)
    assert md_path.parent == h.store.data_dir / "reports" and md_path.name.startswith("bible-builder-")
    rep = json.loads(js_path.read_text())
    sec = {x["section"]: x for x in rep["sections"]}
    assert sec["A04"]["requested"] == 2 and sec["A04"]["generated"] == 2 and sec["A04"]["created"] == 1
    items = {i["key"]: i for i in rep["items"]}
    assert items["A04-2"]["outcome"] == "generated, not created" and rep["counts"]["discarded"] == 1
    assert items["A01-1"]["record_id"] == out["created"][1]["ref"]["record_id"]
    assert items["A01-1"]["links_made"][0]["record_id"] == out["created"][0]["ref"]["record_id"]
    assert items["A04-1"]["removed_refs"][0]["record_id"] == "A04-invented"
    assert rep["runs"][0]["slot"] == "AI-1" and rep["runs"][0]["model"] == "fake-model"
    assert items["A01-1"]["slot"] == "AI-1" and items["A01-1"]["model"] == "fake-model"
    md = md_path.read_text()
    for text in ("# Akọwe Bible Builder report", "## Sections", "## Items", "Invented links removed",
                 "A04-invented", "generated, not created", out["created"][0]["ref"]["record_id"]):
        assert text in md
    for secret in ("ZZIDEA", SECRET_REPLY, "JSON_SCHEMA", "author_request"):
        assert secret not in md and secret not in js_path.read_text()
    # a failed item is reported with its reason
    h.engine.providers.configure_slot("AI-1", {"adapter_id": "none"})
    svc.run_bible(h.principal, sid, {"sections": {"A07": 1}})
    s = idle(svc, h, sid)
    sec = {x["op"]: x for x in s["sections"]}
    assert sec["A07"]["status"] == "error" and sec["A07"]["error"]["code"] == "CAPABILITY_UNAVAILABLE"
    assert "Settings" in sec["A07"]["error"]["fix"]
    rep = json.loads(js_path.read_text())
    assert rep["runs"][-1]["sketch"] == "error"


# ---------------------------------------------------------------------- HTTP + logs
APP_TOKEN = "assist-app-token"


@pytest.fixture
def server(tmp_path):
    app = App(tmp_path / "data", token=APP_TOKEN)
    app.engine.providers.secret_path = tmp_path / "secrets.json"
    from http.server import ThreadingHTTPServer
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield app, httpd.server_address[1]
    httpd.shutdown()
    httpd.server_close()
    app.store.close()


def call(port, method, path, body=None, token=APP_TOKEN):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    c.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
    r = c.getresponse()
    raw = r.read()
    try:
        return r.status, json.loads(raw)
    except ValueError:
        return r.status, raw


def test_endpoints_need_auth_and_work_over_http(server, caplog):
    caplog.set_level(logging.DEBUG)
    app, port = server
    pid = app.engine.bootstrap_project(app.principal_id, "Book")
    fake = FakeAI()
    app.engine.providers.test_adapter = fake
    app.engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})
    body = {"project_id": pid, "branch_id": "main", "target_operation": "A01", "prompt": PROMPT}
    for tok in (None, "wrong"):
        assert call(port, "POST", "/api/assist", body, token=tok)[0] == 401
        assert call(port, "POST", "/api/bible-builder", {"project_id": pid, "idea": "x"}, token=tok)[0] == 401
        assert call(port, "GET", "/api/assist/assist-x", token=tok)[0] == 401
    st, j = call(port, "POST", "/api/assist", body)
    assert st == 202 and j["job_id"]
    j = wait(lambda: (lambda r: r[1] if r[1]["status"] == "done" else None)(call(port, "GET", f"/api/assist/{j['job_id']}")))
    assert j["valid"] and j["proposal"]["concept"] == "Old Tom"
    st, err = call(port, "POST", "/api/assist", dict(body, target_operation="A09"))
    assert st == 400 and err["errors"][0]["path"] == "/feature_manifest"
    assert "feature manifest" in err["errors"][0]["fix"]
    assert call(port, "GET", "/api/assist/assist-unknown")[0] == 404
    ops = {o["id"]: o for o in call(port, "GET", "/api/operations")[1]}
    assert ops["A01"]["assist"] and ops["B01"]["assist"] and ops["C02"]["assist"] and not ops["C01"]["assist"]
    # bible builder over HTTP
    st, s = call(port, "POST", "/api/bible-builder", {"project_id": pid, "branch_id": "main",
                                                      "idea": "ZZIDEA lighthouse", "counts": {"A04": 1}})
    assert st == 202
    s = wait(lambda: (lambda r: r[1] if not r[1]["busy"] else None)(call(port, "GET", f"/api/bible-builder/{s['session_id']}")))
    st, latest = call(port, "GET", f"/api/bible-builder?project_id={pid}&branch_id=main")
    assert latest["session"]["session_id"] == s["session_id"] and len(latest["sections"]) == 18
    st, out = call(port, "POST", f"/api/bible-builder/{s['session_id']}/create", {"items": ["A04-1"]})
    assert st == 200 and out["created"][0]["ref"]["module_id"] == "A04"
    st, md = call(port, "GET", f"/api/bible-builder/{s['session_id']}/report?format=md&download=1")
    assert st == 200 and md.startswith("# Akọwe Bible Builder report".encode("utf-8"))
    assert call(port, "GET", f"/api/bible-builder/{s['session_id']}/report?format=md", token=None)[0] == 401
    # prompts, ideas and replies never reach the logs
    assert "ZZPROMPT" not in caplog.text and SECRET_REPLY not in caplog.text and "ZZIDEA" not in caplog.text
    assert "assist job=" in caplog.text
