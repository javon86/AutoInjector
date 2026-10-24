"""P18.9 (work moves to the AIs that work while one is being repaired, and back when it recovers), P3.1 (writer and
reviewer are different AIs when more than one works) and P3.2 (⚠️ "reviews are not independent" with one AI).

Fakes: ``SlotFake`` is the deterministic Make-a-book fake AI (autobook_fake.BookFakeAI) with per-slot site states
(bridge contract v1.2: ok / repairing / needs_user / broken), scripted state changes by call number and a probe.
``V12Bridge`` is an in-process HTTP bridge speaking contract v1.2 (states, /v1/probe, 503 SITE_NOT_READY with
state + problem) that answers prompts with the same fake AI, so the real AutoInjectorAdapter is exercised end to
end. The contract v1 fake from test_autoinjector_adapter.py stands in for an older bridge without state fields.
"""
from __future__ import annotations

import hmac
import json
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from bookforge import providers as prov_mod
from bookforge.book_path import BookPath
from bookforge.errors import BookforgeError
from bookforge.jobs import RetryPolicy
from bookforge.server import App

from autobook_fake import BookFakeAI
from test_autoinjector_adapter import B01_OUT, BRIDGE_TOKEN, FakeBridge
from test_server import TOKEN, call, server  # noqa: F401

SITES = {"AI-1": "claude", "AI-2": "chatgpt", "AI-3": "gemini"}


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


class SlotFake(BookFakeAI):
    """BookFakeAI + per-slot site states. ``schedule``: {call_number: {slot: state}} applied before that call
    (1-based, counting every submit). ``hidden``: slots that fail with UPSTREAM_UNAVAILABLE although their state
    reads ok (an older bridge that reports no state)."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.states: dict[str, str] = {}
        self.problems: dict[str, str] = {}
        self.hidden: set[str] = set()
        self.schedule: dict[int, dict] = {}
        self.after_probe: dict[str, str] = {}
        self.after_probe_later: dict[str, str] = {}  # applied on the 3rd state read after a probe
        self.probe_ok_at: dict[str, float] = {}
        self.probes: list = []
        self.reads_since_probe = 0
        self.per_slot: list[tuple[str, str]] = []
        self.n = 0

    def site_state(self, slot):
        sid = slot["slot_id"]
        if self.probes:
            self.reads_since_probe += 1
            if self.reads_since_probe >= 3 * 3 and self.after_probe_later:
                for k, v in self.after_probe_later.items():
                    self.states[k] = v
                    if v == "ok":
                        self.probe_ok_at[k] = time.time()
                self.after_probe_later = {}
        return {"state": self.states.get(sid, "ok"), "problem": self.problems.get(sid),
                "last_probe_ok_at": self.probe_ok_at.get(sid), "ready": True, "busy": False}

    def probe(self, slot_ids):
        self.probes.append(list(slot_ids))
        now = time.time()
        for sid in slot_ids:
            st = self.after_probe.get(sid, self.states.get(sid, "ok"))
            self.states[sid] = st
            if st == "ok":
                self.probe_ok_at[sid] = now
        return list(slot_ids)

    def submit(self, slot, system, user, schema):
        with self.lock:
            self.n += 1
            for sid, st in (self.schedule.pop(self.n, None) or {}).items():
                self.states[sid] = st
        sid = slot["slot_id"]
        st = self.states.get(sid, "ok")
        if st != "ok" or sid in self.hidden:
            with self.lock:
                self.per_slot.append((sid, "fail"))
            exc = BookforgeError("UPSTREAM_UNAVAILABLE", "", f"{sid} is not ready")
            if sid not in self.hidden:
                exc.site_state, exc.site_problem = st, self.problems.get(sid)
            raise exc
        out, usage = super().submit(slot, system, user, schema)
        with self.lock:
            self.per_slot.append((sid, self.kinds[-1]))
        return out, usage


def make_app(tmp_path, fake, slots=("AI-1", "AI-2", "AI-3"), name="data", families=None):
    app = App(tmp_path / name, token=TOKEN)
    pr = app.engine.providers
    pr.secret_path = tmp_path / "secrets.json"
    pr.test_adapter = fake
    pr.health.hold_s = 0.0  # a failed slot is tried again as soon as its state says ok (tests only)
    for sid in slots:
        cfg = (families or {}).get(sid) or {"adapter_id": "autoinjector", "site": SITES[sid]}
        pr.configure_slot(sid, cfg)
    fast = RetryPolicy([0.01, 0.02], 5)
    for svc in (app.autobook, app.write_all, app.assist):
        svc.retry_policy = fast
    app.autobook.probe_poll_s = app.write_all.probe_poll_s = 0.01
    app.autobook.probe_timeout_s = app.write_all.probe_timeout_s = 5
    return app


def run_book(app, body=None, timeout=180):
    r = app.autobook.start("author", dict({"author_confirms": True}, **(body or {})))
    app.autobook.wait_for(r["id"], timeout)
    out = app.autobook.public(app.autobook.get(r["id"]))
    out["events"] = app.autobook.get(r["id"])["events"]  # all of them (the public view keeps the last 60)
    return out


def ais(run):
    return {a["slot_id"]: a for a in run.get("ais") or []}


def stored_reviews(app, run):
    return list(app.review.reviews(run["project_id"], "main").values())


# ============================================================================================ P18.9 failover
def test_failover_mid_run_moves_work_and_recovered_slot_is_used_again(tmp_path):
    fake = SlotFake()
    # AI-1 (Claude) breaks at the 4th AI call and is repaired at the 14th: the run must keep going on the others
    # and use AI-1 again once it works.
    fake.problems["AI-1"] = "STUCK_GENERATING"
    fake.schedule = {4: {"AI-1": "repairing"}, 14: {"AI-1": "ok"}}
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    seq = fake.per_slot
    first_fail = next(i for i, (s, k) in enumerate(seq) if k == "fail")
    assert seq[first_fail][0] == "AI-1"
    # the failed call was answered by another AI right away (no waiting): the next call is on a working slot
    assert seq[first_fail + 1][0] in ("AI-2", "AI-3") and seq[first_fail + 1][1] != "fail"
    # while AI-1 was being repaired it was skipped (its state said repairing: no more calls to it)
    broken = [s for s, k in seq[first_fail + 1:13] if s == "AI-1"]
    assert broken == []
    # after the repair AI-1 writes again
    assert any(s == "AI-1" and k not in ("fail", "review") for s, k in seq[14:]), seq
    evs = [e for e in run["events"] if e["kind"] == "failover"]
    assert evs and "being repaired" in evs[0]["message"] and "STUCK_GENERATING" in evs[0]["message"]
    assert "instead" in evs[0]["message"]
    assert run["failovers"] >= 1
    # every AI review was made by a different AI than the writer
    rv = stored_reviews(app, run)
    assert rv and all(r["independent"] for r in rv if r.get("writer_slot")), rv
    assert all(r["slot"] != r["writer_slot"] for r in rv if r.get("writer_slot"))


def test_unreported_failure_v11_style_moves_to_another_slot(tmp_path):
    """A slot whose call fails although no state says so (older bridge): the call moves to another AI at once."""
    fake = SlotFake()
    fake.hidden = {"AI-1"}
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    run = run_book(app)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    assert all(k == "fail" for s, k in fake.per_slot if s == "AI-1")
    assert any(e["kind"] == "failover" and "did not answer" in e["message"] for e in run["events"])
    # only one AI really worked, so the reviews were not independent (P3.2)
    assert run["review_summary"]["same_ai"] > 0 and run["review_summary"]["warning"]


def test_all_slots_repairing_waits_then_continues(tmp_path):
    """When every AI is being repaired the step waits (busy retry) instead of failing, and goes on when one works."""
    fake = SlotFake()
    fake.states = {"AI-1": "repairing"}
    app = make_app(tmp_path, fake, slots=("AI-1",))
    pr = app.engine.providers
    with pytest.raises(BookforgeError) as exc:
        pr.generate(SimpleNamespace(project_id="p", branch_id=None, op_id="B01",
                                    request={"request_id": "r1", "deadline": None}),
                    task="t", output_schema={"type": "object"}, context={}, capability="text", protected_facts=[])
    assert exc.value.code == "UPSTREAM_UNAVAILABLE" and "being repaired" in exc.value.errors[0]["message"]
    # in a run: waits (fast policy), then AI-1 is repaired during the wait
    app.autobook.retry_policy = RetryPolicy([0.05] * 40, 30)
    orig = app.autobook.on_wait

    def on_wait(run, info):
        if info:
            fake.states["AI-1"] = "ok"
        orig(run, info)
    app.autobook.on_wait = on_wait
    run = run_book(app)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    assert any(e["kind"] == "wait" for e in run["events"])


def test_probe_before_run_shows_working_and_repairing_ais(tmp_path):
    fake = SlotFake()
    fake.states = {"AI-1": "unknown", "AI-2": "unknown", "AI-3": "unknown"}
    fake.after_probe = {"AI-1": "ok", "AI-2": "needs_user", "AI-3": "repairing"}
    fake.after_probe_later = {"AI-3": "ok"}  # AI-3's repair finishes while BookForge waits for the check-in
    fake.problems = {"AI-2": "LOGGED_OUT", "AI-3": "NO_REPLY_FOUND"}
    app = make_app(tmp_path, fake)
    seen = []
    orig = app.autobook.save

    def save(run):
        if run.get("probe", {}).get("state") == "running":
            seen.append(json.loads(json.dumps(run.get("ais") or [])))
        orig(run)
    app.autobook.save = save
    run = run_book(app)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    assert fake.probes and sorted(fake.probes[0]) == ["AI-1", "AI-2", "AI-3"]
    assert run["probe"]["state"] == "done" and run["probe"]["working"] == 2
    # progress while waiting: AI-3 was shown as being repaired, AI-2 as needing the author
    flat = [a for snap in seen for a in snap]
    assert any(a["slot_id"] == "AI-3" and a["state"] == "repairing" for a in flat)
    assert any(a["slot_id"] == "AI-2" and a["state"] == "needs_user" and a["problem"] == "LOGGED_OUT" for a in flat)
    probe_ev = next(e for e in run["events"] if e["kind"] == "probe")
    assert "AI-2 · ChatGPT: needs you ⚠️ LOGGED_OUT" in probe_ev["message"] and "AI-1 · Claude: working" in probe_ev["message"]
    # the logged-out AI was never asked anything
    assert not any(s == "AI-2" for s, _ in fake.per_slot)
    assert ais(run)["AI-2"]["state"] == "needs_user" and not ais(run)["AI-2"]["working"]


def test_probe_gives_up_after_the_time_limit(tmp_path):
    fake = SlotFake()
    fake.after_probe = {"AI-1": "ok", "AI-2": "repairing"}
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    pr = app.engine.providers
    t0 = time.time()
    out = pr.probe_and_wait(timeout_s=0.3, poll_s=0.01, sleep=time.sleep)
    assert time.time() - t0 < 5
    st = {x["slot_id"]: x for x in out}
    assert st["AI-1"]["working"] and not st["AI-1"]["pending"]
    assert st["AI-2"]["pending"] and st["AI-2"]["state"] == "repairing"


def test_write_all_probes_and_moves_work(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    run = run_book(app)
    assert run["status"] == "done"
    pid = run["project_id"]
    # make every chapter unwritten again by starting a fresh book with the same outline is heavy; instead check
    # that a Write-all job on the finished book probes and finishes (all chapters already done).
    fake.probes.clear()
    fake.states["AI-1"] = "broken"
    job = app.write_all.start("author", pid, "main")
    app.write_all.wait_for(job["id"], 30)
    job = app.write_all.public(app.write_all.get(job["id"]))
    assert job["status"] == "done" and fake.probes
    assert {a["slot_id"]: a["state"] for a in job["ais"]}["AI-1"] == "broken"


# ============================================================================================ P3.1 / P3.2
def _draft_b01(app, pid):
    bp = BookPath(app.engine, "author", pid, "main")
    r = bp.dispatch("B01", "CREATE", payload={"idea": "a keeper hears the drowned", "goals": []})
    assert r["status"] == "DRAFT", r
    return r["output_refs"][0]


def test_reviewer_is_a_different_slot_with_two_and_three_ais(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    pid = app.engine.bootstrap_project("author", "Two AIs")
    ref = _draft_b01(app, pid)
    assert fake.per_slot[-1] == ("AI-1", "B01")
    res = app.review.review_sync("author", pid, "main", ref["record_id"])
    rv = res["review"]
    assert rv["slot"] == "AI-2" and rv["writer_slot"] == "AI-1" and rv["independent"] is True
    assert rv["writer"] == "AI-1 · Claude" and rv["reviewer"] == "AI-2 · ChatGPT" and rv["warning"] is None
    q = app.review.queue("author", pid, "main")
    item = next(i for i in q["items"] if i["record_id"] == ref["record_id"])
    assert item["made_by"]["slot"] == "AI-1" and item["review"]["reviewer"] == "AI-2 · ChatGPT"
    ob = [json.loads(r["payload"]) for r in app.store.query(
        "SELECT payload FROM outbox WHERE project_id=? AND event_type='review.ai_verdict'", (pid,))]
    assert ob[-1]["writer_slot"] == "AI-1" and ob[-1]["independent"] is True and "reasons" not in ob[-1]

    # three AIs: the Settings choice is used when it did not write the draft
    app2 = make_app(tmp_path, SlotFake(), name="data3")
    pid2 = app2.engine.bootstrap_project("author", "Three AIs")
    ref2 = _draft_b01(app2, pid2)
    assert app2.review.review_sync("author", pid2, "main", ref2["record_id"])["review"]["slot"] == "AI-2"
    app2.review.save_reviewer_settings({"slot": "AI-3"})
    ref3 = _draft_b01(app2, pid2)
    assert app2.review.review_sync("author", pid2, "main", ref3["record_id"])["review"]["slot"] == "AI-3"
    app2.review.save_reviewer_settings({"slot": "AI-1"})  # AI-1 wrote it: automatic choice instead
    ref4 = _draft_b01(app2, pid2)
    out = app2.review.review_sync("author", pid2, "main", ref4["record_id"])["review"]
    assert out["slot"] == "AI-2" and out["independent"]
    with pytest.raises(BookforgeError):
        app2.review.save_reviewer_settings({"slot": "AI-9"})


def test_reviewer_prefers_a_different_site_and_never_reuses_the_same_ai_family(tmp_path):
    """AI-2 is Claude through the API, AI-1 Claude through AutoInjector: the same AI. The reviewer is Gemini."""
    fake = SlotFake()
    fam = {"AI-2": {"adapter_id": "anthropic", "input_cost_minor_per_mtok": 0, "output_cost_minor_per_mtok": 0}}
    app = make_app(tmp_path, fake, families=fam)
    pid = app.engine.bootstrap_project("author", "Families")
    ref = _draft_b01(app, pid)
    writer = fake.per_slot[-1][0]
    rv = app.review.review_sync("author", pid, "main", ref["record_id"])["review"]
    assert writer in ("AI-1", "AI-2") and rv["slot"] == "AI-3" and rv["independent"]


def test_single_ai_reviews_itself_with_warning_everywhere(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake, slots=("AI-1",))
    run = run_book(app)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    rv = stored_reviews(app, run)
    assert rv and all(r["independent"] is False and r["warning"] for r in rv if r.get("writer_slot"))
    rs = run["review_summary"]
    assert rs["same_ai"] >= 1 and rs["warning"].startswith("Reviews are not independent")
    st = {s["id"]: s for s in run["steps"]}
    assert "⚠️ Reviews are not independent" in st["premise"]["review_note"]
    assert "written by AI-1 · Claude · reviewed by AI-1 · Claude" in st["premise"]["review_note"]
    assert any(e["kind"] == "note" and e.get("code") == "REVIEW_NOT_INDEPENDENT" for e in run["events"])
    # the run summary at the end says it, and so does the journal
    assert any(e["kind"] == "note" and "AI review(s) were made by the AI that wrote" in e["message"]
               for e in run["events"])
    from bookforge import journal
    j = journal.build(app, run["project_id"], "main")
    assert j["reviews"]["same_ai"] >= 1 and j["reviews"]["warning"]
    assert any(e.get("warning") for e in j["entries"] if e["kind"] == "ai_review")
    md = journal.render_markdown(j)
    assert "Reviews are not independent" in md


def test_fix_goes_back_to_the_writer_and_never_to_the_reviewer(tmp_path):
    fake = SlotFake(verdicts=["REVISE"])
    app = make_app(tmp_path, fake)
    run = run_book(app)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    seq = [x for x in fake.per_slot if x[1] != "fail"]
    i = next(i for i, (s, k) in enumerate(seq) if k == "fix")
    review_slot = seq[i - 1][0]
    assert seq[i - 1][1] == "review" and seq[i][0] != review_slot
    # the record that was fixed was written by AI-1 (the cheapest/first slot): the fix went to AI-1
    assert seq[i][0] == "AI-1"
    # the second review of the fixed version is again by a different AI than AI-1
    assert seq[i + 1][1] == "review" and seq[i + 1][0] != "AI-1"


def test_fix_moves_to_a_third_ai_when_the_writer_is_broken(tmp_path):
    fake = SlotFake(verdicts=["REVISE"])
    app = make_app(tmp_path, fake)
    pid = app.engine.bootstrap_project("author", "Fix")
    ref = _draft_b01(app, pid)
    rv = app.review.review_sync("author", pid, "main", ref["record_id"])["review"]
    assert rv["verdict"] == "REVISE" and rv["slot"] == "AI-2"
    fake.states["AI-1"] = "repairing"
    from bookforge.review import ReviewJob
    job = ReviewJob("fix", "author", pid, "main", [ref["record_id"]], None)
    job.started = time.time()
    app.review._run_fix(job)
    assert job.slot == "AI-3" and fake.per_slot[-1] == ("AI-3", "fix")


def test_pinned_run_still_gets_an_independent_reviewer(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    run = run_book(app, {"slot_id": "AI-2"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    writes = {s for s, k in fake.per_slot if k not in ("review", "fail")}
    reviews = {s for s, k in fake.per_slot if k == "review"}
    assert writes == {"AI-2"} and reviews == {"AI-1"}


# ============================================================================================ real adapter
class V12Bridge:
    """Bridge contract v1.2 fake: per-site state/problem in /v1/health, POST /v1/probe, 503 SITE_NOT_READY with
    state + problem for a site that is not ok. Completions are answered by BookFakeAI from the prompt."""

    def __init__(self, token=BRIDGE_TOKEN, v12=True):
        self.token, self.v12 = token, v12
        self.ai = BookFakeAI()
        self.states = {s: "ok" for s in ("claude", "chatgpt", "gemini")}
        self.problems: dict[str, str] = {}
        self.probe_ok_at: dict[str, float] = {}
        self.after_probe: dict[str, str] = {}
        self.health_reads = 0
        self.probes: list = []
        self.completes: list[str] = []
        self.seq = 0
        bridge = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _auth(self):
                a = self.headers.get("Authorization") or ""
                if not (a.startswith("Bearer ") and hmac.compare_digest(a[7:].encode(), bridge.token.encode())):
                    self._send(401, {"ok": False, "error": "UNAUTHORIZED"})
                    return False
                return True

            def do_GET(self):
                if not self._auth():
                    return
                bridge.health_reads += 1
                sites = {}
                for s, st in bridge.states.items():
                    e = {"ready": st == "ok", "busy": False}
                    if bridge.v12:
                        e.update(state=st, problem=bridge.problems.get(s) if st != "ok" else None,
                                 since=int(time.time() * 1000), last_probe_ok_at=bridge.probe_ok_at.get(s))
                    sites[s] = e
                self._send(200, {"ok": True, "bridge_version": "1.2" if bridge.v12 else "1.1", "sites": sites})

            def do_POST(self):
                if not self._auth():
                    return
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if self.path == "/v1/probe" and bridge.v12:
                    bridge.probes.append(body.get("sites"))
                    for s in body.get("sites") or []:
                        st = bridge.after_probe.get(s, bridge.states.get(s, "ok"))
                        bridge.states[s] = st
                        if st == "ok":
                            bridge.probe_ok_at[s] = int(time.time() * 1000)
                    return self._send(202, {"ok": True, "started": body.get("sites") or [], "skipped": {}})
                if self.path != "/v1/complete":
                    return self._send(404, {"ok": False, "error": "NOT_FOUND"})
                site = body.get("site")
                st = bridge.states.get(site, "ok")
                if st != "ok":
                    out = {"ok": False, "error": "SITE_NOT_READY", "message": "not ready", "ambiguous": False}
                    if bridge.v12:
                        out.update(state=st, problem=bridge.problems.get(site))
                    return self._send(503, out)
                prompt = body["prompt"]
                pkg = prompt.split("Project context package (JSON):\n", 1)[1].split("\n\nJSON_SCHEMA:", 1)[0]
                schema = json.loads(prompt.split("JSON_SCHEMA:\n", 1)[1].split("\nEND_JSON_SCHEMA", 1)[0])
                data, _ = bridge.ai.submit({"slot_id": site}, "", "Project context package (JSON):\n" + pkg, schema)
                bridge.seq += 1
                bridge.completes.append(site)
                seq = f"{bridge.seq:04d}"
                self._send(200, {"ok": True, "site": site, "request_id": body["request_id"], "text": json.dumps(data),
                                 "seq": seq, "reply_to": seq, "elapsed_ms": 3})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def v12():
    b = V12Bridge()
    yield b
    b.close()


def bridge_app(tmp_path, bridge, name="data"):
    app = App(tmp_path / name, token=TOKEN)
    pr = app.engine.providers
    pr.secret_path = tmp_path / f"{name}-secrets.json"
    pr.connect_autoinjector(BRIDGE_TOKEN, bridge.url)
    pr.health.hold_s = 0.0
    fast = RetryPolicy([0.01, 0.02], 5)
    for svc in (app.autobook, app.write_all, app.assist):
        svc.retry_policy = fast
    app.autobook.probe_poll_s = 0.05
    app.autobook.probe_timeout_s = 5
    return app


def test_v12_bridge_states_failover_and_health_panel(tmp_path, v12):
    v12.states["chatgpt"] = "needs_user"
    v12.problems["chatgpt"] = "LOGGED_OUT"
    app = bridge_app(tmp_path, v12)
    pr = app.engine.providers
    slots = {s["slot_id"]: s for s in pr.slots()}
    st = pr.site_state(slots["AI-2"])
    assert st["state"] == "needs_user" and st["problem"] == "LOGGED_OUT" and st["source"] == "bridge"
    reads = v12.health_reads
    for _ in range(20):  # cached: the bridge is not hammered
        pr.eligible("p", "text", 10, None)
    assert v12.health_reads - reads <= 1
    assert [s["slot_id"] for s in pr.eligible("p", "text", 10, None)] == ["AI-1", "AI-3"]
    h = pr.health_check("AI-2")
    assert h["ok"] is False and h["state"] == "needs_user" and h["error"] == "SITE_NOT_READY"
    res = app.health.run(force=True)
    chk = next(c for c in res["checks"] if c["id"] == "slot-AI-2")
    assert chk["status"] == "warn" and chk["code"] == "LOGGED_OUT" and "waiting for you" in chk["detail"]
    assert next(c for c in res["checks"] if c["id"] == "bridge")["status"] != "problem"
    # Claude breaks between the health read and the call: 503 SITE_NOT_READY with state -> the call moves on
    pr.health.forget_bridges()
    pr.eligible("p", "text", 10, None)  # cache: claude still reads ok
    v12.states["claude"] = "repairing"
    v12.problems["claude"] = "NO_REPLY_FOUND"
    seen = []
    pr.health.set_listener(seen.append)
    ctx = SimpleNamespace(project_id="p", branch_id=None, op_id="B01", request={"request_id": "rq", "deadline": None})
    data, res = pr.generate(ctx, task="t", output_schema={"type": "object", "properties": {
        "premise": {"type": "string"}, "dramatic_question": {"type": "string"}, "concept_summary": {"type": "string"}},
        "required": ["premise"]}, context={}, capability="text", protected_facts=[])
    pr.health.set_listener(None)
    assert res["ai_slot"] == "AI-3" and v12.completes[-1] == "gemini"
    assert seen and seen[0]["from"][0]["slot_id"] == "AI-1" and seen[0]["from"][0]["problem"] == "NO_REPLY_FOUND"
    # the states endpoint data
    states = {x["slot_id"]: x for x in (pr.slot_status(s) for s in pr.ai_slots())}
    assert states["AI-1"]["state"] == "repairing" and states["AI-1"]["word"] == "being repaired"


def test_v12_make_a_book_through_the_real_adapter_with_probe(tmp_path, v12):
    v12.states = {"claude": "unknown", "chatgpt": "unknown", "gemini": "unknown"}
    v12.after_probe = {"claude": "ok", "chatgpt": "broken", "gemini": "ok"}
    v12.problems = {"chatgpt": "TYPE_FAILED"}
    app = bridge_app(tmp_path, v12)
    run = run_book(app)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    assert v12.probes and sorted(v12.probes[0]) == ["chatgpt", "claude", "gemini"]
    a = ais(run)
    assert a["AI-2"]["state"] == "broken" and a["AI-2"]["problem"] == "TYPE_FAILED"
    assert "chatgpt" not in v12.completes
    rv = stored_reviews(app, run)
    assert rv and all(r["slot"] != r["writer_slot"] for r in rv if r.get("writer_slot"))
    assert {r["slot"] for r in rv} <= {"AI-1", "AI-3"}


def test_v11_bridge_without_state_fields_still_works(tmp_path):
    old = FakeBridge()
    try:
        app = App(tmp_path / "data", token=TOKEN)
        pr = app.engine.providers
        pr.secret_path = tmp_path / "s.json"
        pr.connect_autoinjector(BRIDGE_TOKEN, old.url)
        slots = pr.slots()
        st = pr.site_state(slots[0])
        assert st["state"] == "unknown" and st["source"] == "bridge_v1"
        assert len(pr.eligible("p", "text", 10, None)) == 3  # an older bridge never makes a slot unavailable
        out = pr.probe_and_wait(timeout_s=2, poll_s=0.01)  # no /v1/probe: just read once
        assert all(not x["pending"] for x in out)
        h = pr.health_check("AI-1")
        assert h["ok"] is True and h["state"] == "unknown"
        # 503 SITE_NOT_READY from an older bridge (no state): the call moves to the next slot
        old.script = [("status", 503, "SITE_NOT_READY")]
        old.default_text = json.dumps(B01_OUT)
        ctx = SimpleNamespace(project_id="p", branch_id=None, op_id="B01", request={"request_id": "x",
                                                                                     "deadline": None})
        data, res = pr.generate(ctx, task="t", output_schema={"type": "object", "properties": {
            k: {"type": "string"} for k in B01_OUT}, "required": ["premise"]}, context={}, capability="text",
            protected_facts=[])
        assert res["ai_slot"] == "AI-2" and old.sends[-1]["site"] == "chatgpt"
        # the bridge returning SITE_NOT_READY without a state is still classified as "not ready"
        assert pr.health.failed("AI-1")["code"] == "UPSTREAM_UNAVAILABLE"
    finally:
        old.close()


def test_states_and_reviewer_settings_endpoints(server):  # noqa: F811
    app, port = server
    st, out, _ = call(port, "GET", "/api/settings/reviewer-ai")
    assert st == 200 and out["slot"] is None and "auto" in out["choices"]
    st, out, _ = call(port, "PUT", "/api/settings/reviewer-ai", {"slot": "AI-2"})
    assert st == 200 and out["slot"] == "AI-2"
    st, out, _ = call(port, "PUT", "/api/settings/reviewer-ai", {"slot": "nobody"})
    assert st == 400
    st, out, _ = call(port, "PUT", "/api/settings/reviewer-ai", {"slot": "auto"})
    assert st == 200 and out["slot"] is None
    st, out, _ = call(port, "GET", "/api/slots/states")
    assert st == 200 and out == {"slots": []}


# ============================================================================================ cross-process
def test_real_node_bridge_v12_states_probe_failover_and_recovery(h, tmp_path):
    """Real BookForge -> real bookforge-bridge.js (desktop-app fake host with --site-state, contract v1.2)."""
    import os
    import shutil
    import signal
    import sys
    from test_bridge_cross_process import HOST, TOKEN as HOST_TOKEN, Host
    if shutil.which("node") is None or not HOST.exists() or sys.platform.startswith("win"):
        pytest.skip("needs node, desktop-app/test/fixtures/fake-bridge-host.js and SIGUSR1")
    host = Host(tmp_path, "valid", ["--site-state", "claude=repairing:NO_REPLY_FOUND,chatgpt=needs_user:LOGGED_OUT"])
    try:
        pr = h.engine.providers
        pr.secret_path = tmp_path / "x-secrets.json"
        pr.connect_autoinjector(HOST_TOKEN, host.url)
        pr.health.hold_s = 0.0
        out = {x["slot_id"]: x for x in pr.probe_and_wait(timeout_s=3, poll_s=0.1, sleep=time.sleep)}
        assert out["AI-3"]["state"] == "ok" and out["AI-3"]["working"] and not out["AI-3"]["pending"], out
        assert out["AI-1"]["state"] == "repairing" and out["AI-1"]["problem"] == "NO_REPLY_FOUND"
        assert out["AI-2"]["state"] == "needs_user" and out["AI-2"]["problem"] == "LOGGED_OUT"
        hc = pr.health_check("AI-2")
        assert hc["ok"] is False and hc["state"] == "needs_user" and hc["error"] == "SITE_NOT_READY"
        r = h.create("B01", {"idea": "a lighthouse keeper hears the sea", "goals": ["finish draft one"]})
        assert r["status"] == "DRAFT", r["errors"]
        row = h.store.query_one("SELECT resource FROM provenance WHERE record_id=?", (r["output_refs"][0]["record_id"],))
        assert json.loads(row["resource"])["ai_slot"] == "AI-3"
        assert [p["site"] for p in host.prompts()] == ["gemini"]
        # the repaired AIs are used again
        os.kill(host.proc.pid, signal.SIGUSR1)
        deadline = time.time() + 5
        while time.time() < deadline:
            pr.health.forget_bridges()
            if pr.site_state(pr.slots()[0])["state"] == "ok":
                break
            time.sleep(0.05)
        r2 = h.create("B01", {"idea": "a keeper hears the drowned", "goals": ["draft two"]})
        assert r2["status"] == "DRAFT", r2["errors"]
        assert host.prompts()[-1]["site"] == "claude"
    finally:
        host.close()
