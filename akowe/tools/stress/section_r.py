"""Section R — real-world run: the "What the Ice Kept" run of 2026-11-27 (build b4a0402) reproduced on Akọwe's side.

The real log (codes only) showed a web AI (ChatGPT) whose reply could not be read: every request waited the whole
timeout (~894 s), then the late-answer window (LATE_EXPIRED at ~1194 s), then a second try on the SAME AI (-c1-,
TIMEOUT ~295 s, LATE_EXPIRED ~590 s) — 16 TIMEOUTs ≈ 159 min — and three run stops (review ×2, scenes_check ×1) while
Gemini and Claude answered every call. The finished book printed "Unknown author", repeated one long sentence in two
chapters, was 121 % of its length with 0 cuts kept, missed 2 planned details, and the editor read a chapter version
that was not the final one.

What this section adds to the harness (core.py is not edited; nothing in the product is changed):

* ``ClockBridge`` — an in-process AutoInjector bridge (contract v1.2) like core.ChaosBridge, but a ``timeout()`` fault
  behaves like the real one: the prompt WAS typed, the bridge holds the request for the ``timeout_ms`` Akọwe sent and
  answers 504 ``{typed: true, late_window_ms}``; Akọwe's same-request-id re-join is held for the late window and
  answered 504 ``{typed: true, late_expired: true}`` (or, with ``late="arrive"``, the late answer is handed back).
  Nothing really sleeps: every held second goes on a **simulated clock** (``bridge.clock``), together with Akọwe's own
  sleeps in providers.py (the 60 s "ask the same AI once more" wait). "Time waited" in this report is that clock — the
  real-life cost of the faults (an upper bound when two calls wait side by side, like the log's own "≈ 159 min").
* the real failed-slot hold (``FAIL_HOLD_S`` = 15 s; the other sections set it to 0), so routing is as in real life.
* ``author_loop`` — the author comes back and presses 🔁 Try again on every stop while the fault stays (the real
  night), counting stops; then the fault is removed and the run must finish.

Grading (stricter than A–G, the brief's round-2 rules): ✅ finished, nothing lost, no needless wait (a timed-out
call moved to another working AI within ~5 min); 🟡 a stop only when no other AI could have answered; ⚠️ a stop or a
wait > 5 min that another working AI could have avoided, a known problem waited out, or a cosmetic defect in the
finished book; ❌ work lost, a wrong book, a hang, a run that never finishes.
"""
from __future__ import annotations

import io
import json
import re
import threading
import time
import types
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from akowe import providers as prov_mod
from akowe.errors import AkoweError

from autobook_fake import BookFakeAI

from .core import (BRIDGE_KEY, LIKELY, SAFE, SITE_SLOT, SLOT_SITE, UNLIKELY, Harness, Outcome, RawText, Rule,
                   Section, replace, scrub, timeout)

SEC = Section("R", "Real-world run (the “What the Ice Kept” log)", "real-world-run")
SEC.part("1", "one AI times out on every call of one kind while two others work",
         "The log's ChatGPT: the reply could not be read, so every request of that kind timed out (typed, no "
         "answer, late window expired). Claude and Gemini answered everything. Does the step move to a working AI, "
         "or stop the book — and how long does the run wait?")
SEC.part("2", "an answer that arrives late",
         "The prompt was typed, the answer came after the timeout: inside the late-answer window (is it used?) or "
         "only after LATE_EXPIRED (is it thrown away, and what does asking again cost?).")
SEC.part("3", "every AI times out", "No AI can answer: the expected result is a safe stop (🟡) — how long before it?")
SEC.part("4", "a stop while the author is away", "The run stopped on a TIMEOUT at night. How long until anything "
         "happens on its own (no auto-retry, the stand-in vote off by default)?")
SEC.part("5", "the finished book without a pen name", "No pen name was typed: what do the title page, the running "
         "heads and the metadata of the PDF / EPUB / DOCX say?")
SEC.part("6", "a long sentence repeated across chapters", "The same long sentence word for word in chapters 1 and "
         "3: does any check catch it, and is it still in the finished book?")
SEC.part("7", "a book over its length target and the cut pass", "Chapters written well over their share: does the "
         "cut pass keep any of the editor's cuts?")
SEC.part("8", "the editor reads a version that is not the final one", "After the editor's read the chapter changes "
         "again (planned details, cuts, the opening pass): which version did the editor's notes describe?")
SEC.part("9", "planned details missing from the page at the end", "The planned-to-page check keeps finding the "
         "same planned details missing and the rewrites do not add them: what does the finished book / the author "
         "get?")
SEC.part("10", "out of the box: more from the log", "The writer's AI pane broken for hours, the bridge reporting the "
         "stalled AI, ChatGPT failing every kind for the whole night with the author pressing Try again, and the "
         "clean-run score.")

FIVE_MIN = 300.0
NAME = {"AI-1": "Claude", "AI-2": "ChatGPT", "AI-3": "Gemini"}
SOLO_BODY = {}   # three working AIs: no H6 single-AI stop


# ================================================================================================ the clock bridge
class ClockBridge:
    """An AutoInjector bridge (contract v1.2) answering /v1/complete with the harness's ChaosAI. A TIMEOUT fault is
    the real thing (typed, held for timeout_ms, then the late window) on a simulated clock; ``states`` sets a site's
    v1.2 health state (e.g. {"claude": ("broken", "PANE_BROKEN")}) — a site that is not ok answers 503 SITE_NOT_READY.
    ``late``: "expire" (the late window ends with LATE_EXPIRED) or "arrive" (the answer arrives ``arrive_s`` into
    the window and is handed back to the re-join)."""

    LATE_WINDOW_MS = 300000

    def __init__(self, ai, token: str = BRIDGE_KEY, late: str = "expire", arrive_s: float = 120.0):
        self.ai, self.token, self.late, self.arrive_s = ai, token, late, arrive_s
        ai._via_bridge = True
        self.lock = threading.Lock()
        self.clock = 0.0
        self.seq = 0
        self.completes = 0
        self.pending: dict[str, dict] = {}       # request_id -> {site, answer}
        self.log: list[tuple] = []               # (sim seconds, site, request_id tail, outcome)
        self.states: dict[str, tuple] = {}
        self._last: dict = {}
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
                if (self.headers.get("Authorization") or "") != f"Bearer {bridge.token}":
                    self._send(401, {"ok": False, "error": "UNAUTHORIZED"})
                    return False
                return True

            def do_GET(self):
                if not self._auth():
                    return
                now = int(time.time() * 1000)
                sites = {}
                for s in SITE_SLOT:
                    st, prob = bridge.states.get(s, ("ok", None))
                    sites[s] = {"ready": st == "ok", "busy": False, "state": st, "problem": prob, "since": now,
                                "last_probe_ok_at": now if st == "ok" else None}
                self._send(200, {"ok": True, "bridge_version": "1.2", "sites": sites})

            def do_POST(self):
                if not self._auth():
                    return
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if self.path == "/v1/probe":
                    return self._send(202, {"ok": True, "started": body.get("sites") or [], "skipped": {}})
                if self.path != "/v1/complete":
                    return self._send(404, {"ok": False, "error": "NOT_FOUND"})
                return self._send(*bridge.complete(body))

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True, name="stress-clock-bridge").start()

    # ------------------------------------------------------------------ the clock
    def tick(self, seconds: float):
        with self.lock:
            self.clock += float(seconds)

    def note(self, site, rid, outcome):
        with self.lock:
            self.log.append((round(self.clock, 1), site, str(rid or "")[-12:], outcome))

    def outcomes(self, outcome: str) -> int:
        return sum(1 for x in self.log if x[3] == outcome)

    # ------------------------------------------------------------------ /v1/complete
    def _ok(self, body, site, data):
        with self.lock:
            self.seq += 1
            self.completes += 1
            seq = f"{self.seq:04d}"
        reply = data if isinstance(data, RawText) else json.dumps(data, ensure_ascii=False)
        return 200, {"ok": True, "site": site, "request_id": body.get("request_id"), "text": str(reply), "seq": seq,
                     "reply_to": seq, "elapsed_ms": 3, "followup": True}

    def complete(self, body: dict) -> tuple[int, dict]:
        site = body.get("site")
        rid = body.get("request_id")
        tmo = float(body.get("timeout_ms") or 240000)
        st, prob = self.states.get(site, ("ok", None))
        if st != "ok":
            self.note(site, rid, f"NOT_READY:{st}")
            return 503, {"ok": False, "error": "SITE_NOT_READY", "state": st, "problem": prob}
        with self.lock:
            joined = self.pending.pop(rid, None)
        if joined is not None:  # Akọwe's re-join of a typed prompt whose answer was late (same request id)
            if self.late == "arrive" and joined.get("answer") is not None:
                self.tick(min(self.arrive_s, tmo / 1000.0))
                self.note(site, rid, "LATE_OK")
                return self._ok(body, site, joined["answer"])
            self.tick(tmo / 1000.0)
            self.note(site, rid, "LATE_EXPIRED")
            return 504, {"ok": False, "error": "TIMEOUT", "typed": True, "late_expired": True}
        prompt = body.get("prompt") or ""
        try:
            pkg = prompt.split("Project context package (JSON):\n", 1)[1].split("\n\nJSON_SCHEMA:", 1)[0]
            schema = json.loads(prompt.split("JSON_SCHEMA:\n", 1)[1].split("\nEND_JSON_SCHEMA", 1)[0])
        except (IndexError, ValueError):
            pkg, schema = self._last.get(site, ("{}", {"type": "object"}))
        self._last[site] = (pkg, schema)
        slot = {"slot_id": SITE_SLOT.get(site, site), "site": site}
        user = "Project context package (JSON):\n" + pkg
        try:
            data, _ = self.ai.submit(slot, "", user, schema)
        except AkoweError as exc:
            if exc.code == "TIMEOUT":
                answer = None
                if self.late == "arrive":
                    try:
                        answer, _ = BookFakeAI.submit(self.ai, slot, "", user, schema)  # the answer that came late
                    except Exception:  # noqa: BLE001
                        answer = None
                with self.lock:
                    self.pending[rid] = {"site": site, "answer": answer}
                self.tick(tmo / 1000.0)
                self.note(site, rid, "TIMEOUT")
                return 504, {"ok": False, "error": "TIMEOUT", "typed": True,
                             "late_window_ms": min(self.LATE_WINDOW_MS, tmo)}
            self.note(site, rid, exc.code)
            from .core import ChaosBridge  # noqa: PLC0415
            return ChaosBridge._http_error(exc)
        self.note(site, rid, "OK")
        return self._ok(body, site, data)

    def close(self):
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        except Exception:  # noqa: BLE001
            pass


def real_app(h: Harness, late: str = "expire", arrive_s: float = 120.0) -> ClockBridge:
    """Three AutoInjector slots (Claude AI-1, ChatGPT AI-2, Gemini AI-3) through a ClockBridge, the real failed-slot
    hold, and Akọwe's own sleeps in providers.py counted on the simulated clock."""
    b = ClockBridge(h.chaos, late=late, arrive_s=arrive_s)
    h.bridges.append(b)
    h.make_app(wire="bridge", slots=3)
    h.app.engine.providers.health.hold_s = prov_mod.FAIL_HOLD_S
    h.patch(prov_mod, "time", types.SimpleNamespace(sleep=b.tick, monotonic=time.monotonic, time=time.time))
    return b


# ================================================================================================ flows and measures
def mins(s: float) -> str:
    return f"{s / 60:.1f} min" if s < 5400 else f"{s / 3600:.1f} h"


def answered_by(h: Harness, kinds, step=None) -> list[str]:
    ks = {kinds} if isinstance(kinds, str) else set(kinds)
    out = []
    for _n, kind, stp, slot, fault in h.chaos.trace:
        if kind in ks and not fault and (step is None or stp == step) and NAME.get(slot, slot) not in out:
            out.append(NAME.get(slot, slot))
    return out


def faulted_slots(h: Harness) -> list[str]:
    return sorted({NAME.get(t[3], t[3]) for t in h.chaos.trace if t[4]})


def author_loop(h: Harness, body: dict | None = None, max_stops: int = 8, keep_fault: bool = True) -> dict:
    """Start the run; on every stop the author comes back and presses 🔁 Try again (▶ Resume when there is no retry)
    while the fault stays (``keep_fault``). After ``max_stops`` the fault is removed and the run resumed once more.
    Returns {status, stops: [codes], first: problem, hang, final}."""
    out = {"stops": [], "first": {}, "hang": False, "clock_at_stop": []}
    h.start(dict(SOLO_BODY, **(body or {})))
    for _ in range(max_stops + 2):
        if not h.wait():
            out["hang"] = True
            break
        h.settle()
        r = h.raw()
        if r.get("status") != "paused":
            break
        prob = r.get("problem") or {}
        out["stops"].append(str(prob.get("code") or "?") + f"@{prob.get('step') or r.get('current')}")
        out["clock_at_stop"].append(_clock(h))
        if not out["first"]:
            out["first"] = dict(prob)
            pub = h.run()
            out["first_alert"] = pub.get("alert") or {}
        if len(out["stops"]) >= max_stops or not keep_fault:
            h.fix()
        try:
            if "retry" in (prob.get("options") or []):
                h.app.autobook.decide("author", h.run_id, {"action": "retry"})
            else:
                h.app.autobook.resume("author", h.run_id)
        except AkoweError:
            h.app.autobook.resume("author", h.run_id)
    out["status"] = (h.raw() or {}).get("status")
    out["final"] = h.run()
    return out


def _clock(h: Harness) -> float:
    return sum(b.clock for b in h.bridges if isinstance(b, ClockBridge))


def measured(h: Harness, res: dict, kinds=None, step=None) -> str:
    b = next((x for x in h.bridges if isinstance(x, ClockBridge)), None)
    bits = [f"status {res.get('status')}", f"{len(res.get('stops') or [])} stop(s)"
            + (f" ({', '.join(res['stops'])})" if res.get("stops") else ""),
            f"time waited ≈ {mins(_clock(h))} (simulated clock)"]
    if b is not None:
        bits.append(f"{b.outcomes('TIMEOUT')} TIMEOUT / {b.outcomes('LATE_EXPIRED')} LATE_EXPIRED / "
                    f"{b.outcomes('LATE_OK')} late answer(s) used")
    if kinds:
        who = answered_by(h, kinds, step)
        bits.append("answered in the end by " + (", ".join(who) if who else "nobody"))
    return "Measured: " + "; ".join(bits) + "."


def book_issues(h: Harness, res: dict) -> list[str]:
    if res.get("hang"):
        return ["hang: the run did not finish within the time limit"]
    run = res.get("final") or h.run()
    if run.get("status") != "done":
        p = run.get("problem") or {}
        return [f"the book did not finish (status {run.get('status')}, {p.get('code')})"]
    return h.book_check(run)


def grade(h: Harness, o: Outcome, res: dict, *, others_worked: bool, kinds=None, step=None,
          wait_limit: float = FIVE_MIN) -> Outcome:
    """The round-2 grading from the measures (see the module docstring)."""
    o.issues += book_issues(h, res)
    stops = res.get("stops") or []
    o.status = "paused" if stops else (res.get("status") or "")
    o.final_status = res.get("status") or ""
    p = res.get("first") or {}
    o.problem_code = str(p.get("code") or "")
    o.problem_message = scrub(p.get("message"))
    o.problem_fix = scrub(p.get("fix"))
    if stops:
        o.issues += [i for i in h.problem_check(p) if "traceback" in i]
        al = res.get("first_alert") or {}
        o.alert = {k: scrub(al.get(k)) for k in ("category", "label", "wrong", "why", "next") if al.get(k)}
    waited = _clock(h)
    if stops and others_worked:
        o.risks.append(f"{len(stops)} stop(s) for the author ({', '.join(stops)}) although "
                       f"{' and '.join(sorted(set(NAME.values()) - set(faulted_slots(h))))} worked and could have "
                       "answered")
    if waited > wait_limit and others_worked:
        o.risks.append(f"the run waited ≈ {mins(waited)} on the AI that could not answer before anything moved "
                       f"(limit {mins(wait_limit)} when another AI works)")
    if kinds and h.chaos.faults_fired() and not answered_by(h, kinds, step) and others_worked:
        o.risks.append("that check was skipped (the step went on without it) — the working AIs were never asked")
    o.notes.append(measured(h, res, kinds, step))
    o = h.finish_outcome(o)
    if not o.issues and not o.risks and stops:
        o.result = SAFE
    return o


# ================================================================================================ part 1
KIND_CASES = {
    # letter: (log kind, answer kinds, step filter, the AI that gets those calls in a normal run)
    "a": ("review", ("review",), None, "AI-2"),
    "b": ("scenes_check", ("scene_review",), None, "AI-2"),
    "c": ("editor", ("craft",), None, "AI-2"),
    "d": ("planned_check", ("planned",), None, "AI-2"),
    "e": ("writers_room", ("generic",), ("plot", "chapters"), "AI-2"),
    "f": ("bible-fill", ("details",), "bible", "AI-1"),
    "g": ("chapter-writer", ("C02", "scene_prose", "expand"), "chapters", "AI-1"),
}
KIND_BODY = {"e": {"writers_room": True}, "f": {"fill_bible": True}}


def _kind_case(letter: str):
    log_kind, kinds, step, slot = KIND_CASES[letter]

    def fn(h: Harness) -> Outcome:
        real_app(h)
        h.chaos.add(Rule(timeout(), kinds=kinds, step=step, slots=slot))
        res = author_loop(h, KIND_BODY.get(letter))
        o = h.outcome()
        o.happened = (f"{NAME[slot]} timed out on every {log_kind} call (typed, no answer, late window expired); "
                      f"the two other AIs worked. "
                      + (f"The run stopped {len(res['stops'])}× ({', '.join(res['stops'])}); the author pressed 🔁 "
                         "Try again each time, then the fault was removed. " if res["stops"] else
                         "The run never stopped. ")
                      + f"In the end the {log_kind} calls were answered by "
                      + (", ".join(answered_by(h, kinds, step)) or "nobody") + ".")
        return grade(h, o, res, others_worked=True, kinds=kinds, step=step)
    return fn


for _l, (_lk, _k, _s, _slot) in KIND_CASES.items():
    SEC.stress("1", _l, f"{NAME[_slot]} times out on every {_lk} call while the two other AIs work", likely=LIKELY,
               time_limit=240)(_kind_case(_l))


# ================================================================================================ part 2
@SEC.stress("2", "a", "the reviewer's answer arrives 2 min after the timeout, inside the late-answer window",
            likely=LIKELY, time_limit=240)
def r2_a(h: Harness) -> Outcome:
    b = real_app(h, late="arrive", arrive_s=120.0)
    h.chaos.add(Rule(timeout(), kinds="review", slots="AI-2", times=1))
    res = author_loop(h)
    o = h.outcome()
    used = b.outcomes("LATE_OK")
    o.happened = (f"ChatGPT's first review answer came 2 min after the timeout (prompt typed, late window open): "
                  f"Akọwe re-joined the same request and {'USED' if used else 'did NOT use'} the late answer"
                  + (f"; the run stopped {len(res['stops'])}×." if res["stops"] else "; the run never stopped."))
    if not used:
        o.risks.append("the late answer that arrived inside the late window was not used")
    # the wait was the AI really answering (nothing another AI could have done faster without knowing): no wait limit
    return grade(h, o, res, others_worked=True, kinds="review", wait_limit=3 * 3600)


@SEC.stress("2", "b", "the reviewer's answer arrives only after LATE_EXPIRED (too late)", likely=LIKELY,
            time_limit=240)
def r2_b(h: Harness) -> Outcome:
    b = real_app(h, late="expire")
    h.chaos.add(Rule(timeout(), kinds="review", slots="AI-2", times=1))
    res = author_loop(h)
    o = h.outcome()
    after = [x for x in b.log if x[1] == "chatgpt"][:4]
    nxt = next((x for x in after if x[3] == "OK"), None)
    o.happened = ("ChatGPT's first review answer came only after the late window had closed (LATE_EXPIRED): it was "
                  "thrown away (Akọwe forgets the late request; AutoInjector drops a reply after LATE_EXPIRED), and "
                  + ("the same prompt was typed AGAIN into ChatGPT's chat (the -c1- try) "
                     f"{mins(nxt[0])} after the first send; that answer was used" if nxt else
                     "the review went elsewhere")
                  + (f"; the run stopped {len(res['stops'])}×." if res["stops"] else "; the run never stopped."))
    if nxt:
        o.risks.append("the second try went to the SAME AI (ChatGPT, -c1-) after a 60 s wait, typing the whole "
                       "prompt again into a chat that already holds the late answer, while Gemini and Claude were "
                       "free")
    return grade(h, o, res, others_worked=True, kinds="review")


@SEC.stress("2", "c", "the writer's chapter arrives 2 min after the timeout (late window)", likely=LIKELY,
            time_limit=240)
def r2_c(h: Harness) -> Outcome:
    b = real_app(h, late="arrive", arrive_s=120.0)
    h.chaos.add(Rule(timeout(), kinds="C02", slots="AI-1", step="chapters", times=1))
    res = author_loop(h)
    o = h.outcome()
    used = b.outcomes("LATE_OK")
    o.happened = (f"Claude's first chapter came 2 min after the timeout: the late answer was "
                  f"{'used (nothing written twice)' if used else 'NOT used'}"
                  + (f"; the run stopped {len(res['stops'])}×." if res["stops"] else "; the run never stopped."))
    if not used:
        o.risks.append("the late chapter that arrived inside the late window was not used")
    return grade(h, o, res, others_worked=True, kinds="C02", step="chapters", wait_limit=3 * 3600)


# ================================================================================================ part 3
@SEC.stress("3", "a", "every AI times out on every review call (no AI can review)", likely=UNLIKELY, time_limit=240)
def r3_a(h: Harness) -> Outcome:
    real_app(h)
    h.chaos.add(Rule(timeout(), kinds="review"))
    res = author_loop(h, max_stops=1)
    o = h.outcome()
    t = res["clock_at_stop"][0] if res["clock_at_stop"] else _clock(h)
    asked = sorted({NAME[x[3]] for x in h.chaos.trace if x[4] and x[2] == "canon"})
    o.happened = (f"No AI could review. The run stopped {len(res['stops'])}× ({', '.join(res['stops'])}) after "
                  f"≈ {mins(t)} of timeouts; asked before the stop: {', '.join(asked) or 'nobody'}. After the fault was "
                  f"removed, 🔁 Try again finished the book." if res["stops"] else "The run never stopped.")
    if len(asked) < 3:
        o.notes.append(f"Only {', '.join(asked)} was/were asked before the stop (the writer Claude is never a "
                       "reviewer of its own work while another AI works; Gemini was not tried) — still a safe stop "
                       "because no AI could have answered.")
    return grade(h, o, res, others_worked=False, kinds="review")


@SEC.stress("3", "b", "every AI times out on the chapter writer", likely=UNLIKELY, time_limit=240)
def r3_b(h: Harness) -> Outcome:
    real_app(h)
    h.chaos.add(Rule(timeout(), kinds=("C02", "scene_prose", "expand"), step="chapters"))
    res = author_loop(h, max_stops=1)
    o = h.outcome()
    t = res["clock_at_stop"][0] if res["clock_at_stop"] else _clock(h)
    asked = sorted({NAME[x[3]] for x in h.chaos.trace if x[4]})
    o.happened = (f"No AI could write the chapter. The run stopped ({', '.join(res['stops'])}) after ≈ {mins(t)} "
                  f"of timeouts; asked before the stop: {', '.join(asked)}. After the fault was removed, 🔁 Try again "
                  "finished the book." if res["stops"] else "The run never stopped.")
    if t > 3600:
        o.risks.append(f"≈ {mins(t)} of waiting before the safe stop (each AI: the whole timeout + the late window)")
    return grade(h, o, res, others_worked=False, kinds="C02", step="chapters")


# ================================================================================================ part 4
def _away(h: Harness, *, stand_in_cfg: dict | None, chatgpt_votes: bool, vote: str = "other_ai") -> tuple[dict, list]:
    """ChatGPT times out on every review (and, unless ``chatgpt_votes``, on its stand-in vote too: the whole site
    is unreadable). The run stops; the author is away; the stand-in clock ticks at +19 min, +21 min and +5 h."""
    from datetime import datetime  # noqa: PLC0415

    from akowe import stand_in  # noqa: PLC0415
    real_app(h)
    kinds = ("review",) if chatgpt_votes else ("review", "stand_in")
    h.chaos.add(Rule(timeout(), kinds=kinds, slots="AI-2"))
    h.chaos.stand_in_default = {"pick": vote, "confident": 0.9, "why": "The same AI keeps timing out."}
    if stand_in_cfg is not None:
        stand_in.save_settings(h.app.store, stand_in_cfg)
    h.start(SOLO_BODY)
    h.wait()
    r = h.raw()
    seen = []
    if r.get("status") != "paused":
        return {"status": r.get("status"), "stops": [], "first": {}, "final": h.run()}, seen
    prob = r.get("problem") or {}
    at = datetime.fromisoformat(prob["at"].replace("Z", "+00:00")).timestamp()
    for label, dt in (("+19 min", 19 * 60), ("+21 min", 21 * 60), ("+5 h", 5 * 3600)):
        out = stand_in.tick(h.app, now=at + dt)
        if h.app.autobook.alive(h.run_id):
            h.wait()
        rr = h.raw()
        sp = ((h.run().get("stand_in") or {}).get("pending") or {})
        seen.append((label, [x.get("code") for x in out], rr.get("status"), (rr.get("problem") or {}).get("code"),
                     scrub(sp.get("words"))[:160]))
        if rr.get("status") == "done":
            break
    res = {"status": h.raw().get("status"), "stops": [f"{prob.get('code')}@{prob.get('step')}"], "first": prob,
           "first_alert": h.run().get("alert") or {}, "clock_at_stop": [_clock(h)]}
    if res["status"] != "done":  # the author comes back after 5 h: the fault is gone, 🔁 Try again
        h.fix()
        h.app.autobook.decide("author", h.run_id, {"action": "retry"})
        h.wait()
        h.settle()
    res["status"] = h.raw().get("status")
    res["final"] = h.run()
    return res, seen


def _seen_words(seen) -> str:
    return "; ".join(f"{lbl}: {('stand-in ' + ','.join(c)) if c else 'nothing happened'} (run {st}"
                     + (f", {pc}" if pc and st != "done" else "") + ")" for lbl, c, st, pc, _w in seen)


@SEC.stress("4", "a", "a TIMEOUT stop at night with the default settings (stand-in vote off)", likely=LIKELY,
            time_limit=240)
def r4_a(h: Harness) -> Outcome:
    res, seen = _away(h, stand_in_cfg=None, chatgpt_votes=False)
    o = h.outcome()
    o.happened = (f"The run stopped on {res['stops'][0] if res['stops'] else '—'} while Claude and Gemini worked. "
                  f"The author is away: {_seen_words(seen)}. Nothing retries or moves the step on its own: the run "
                  "waits for the author however long that is (the log: ~5 h). When the author came back (fault gone), "
                  "🔁 Try again finished the book.")
    if res["stops"] and all(not c for _l, c, *_ in seen):
        o.risks.append("with the default settings a TIMEOUT stop waits for the author indefinitely (no automatic "
                       "retry, no move to a working AI, the 🗳 stand-in vote is off by default): 5 h in the log")
    return grade(h, o, res, others_worked=True, kinds="review")


@SEC.stress("4", "b", "the same stop with 🗳 “when something goes wrong, the AIs vote” on (after 20 min)",
            likely=LIKELY, time_limit=240)
def r4_b(h: Harness) -> Outcome:
    res, seen = _away(h, stand_in_cfg={"errors": True, "errors_when": "wait", "wait_min": 20}, chatgpt_votes=False)
    o = h.outcome()
    o.happened = (f"The run stopped on {res['stops'][0] if res['stops'] else '—'}; 🗳 on. {_seen_words(seen)}. "
                  "ChatGPT (the AI that cannot answer) is one of the voters, so its vote times out too.")
    words = next((w for _l, c, _s, _p, w in seen if c), "")
    if words:
        o.notes.append(f"Stand-in words: “{words}”.")
    if not any("DECIDED" in (c or []) for _l, c, *_ in seen):
        o.risks.append("the vote can never decide while the AI that cannot answer is one of the voters (its vote "
                       "times out → no decision): the run still waits for the author")
    return grade(h, o, res, others_worked=True, kinds="review")


@SEC.stress("4", "c", "🗳 on and the broken AI can still vote: the AIs agree on “another AI”", likely=UNLIKELY,
            time_limit=240)
def r4_c(h: Harness) -> Outcome:
    res, seen = _away(h, stand_in_cfg={"errors": True, "errors_when": "wait", "wait_min": 20}, chatgpt_votes=True)
    o = h.outcome()
    o.happened = f"The run stopped on {res['stops'][0] if res['stops'] else '—'}; 🗳 on. {_seen_words(seen)}."
    dec = next((n for n, k, *_ in h.chaos.trace if k == "stand_in"), None)
    again = [n for n, k, _s, slot, f in h.chaos.trace if dec and n > dec and k == "review" and slot == "AI-2" and f]
    if dec and again:
        o.happened += (" The AIs all agreed on “try again with another AI”, but the review was given to ChatGPT "
                       f"again ({len(again)} more timed-out call(s)) and the run stopped again on the same problem; "
                       "that stop is not voted on a second time, so it waited for the author.")
        o.risks.append("the stand-in decision “another AI” does not reach the reviewer: the review went back to the "
                       "AI that cannot answer and the run stopped again")
    return grade(h, o, res, others_worked=True, kinds="review")


# ================================================================================================ book helpers
_ADJ = ["grey", "cold", "narrow", "quiet", "salt-white", "broken", "heavy", "pale", "bright", "low", "thin", "wet"]
_NOUN = ["rope", "lamp", "door", "stair", "shutter", "bell", "net", "window", "ledger", "boat", "path", "wall",
         "chain", "kettle", "coat", "oar"]
_VERB = ["creaked", "rattled", "shone", "swung", "dripped", "settled", "shifted", "glinted", "sagged", "hummed",
         "leaned", "cooled"]
_PLACE = ["by the quay", "under the eaves", "at the top of the stairs", "beside the stove", "along the sea wall",
          "in the boat shed", "past the chapel", "behind the counter"]
_TAIL = ["while the tide turned", "as the wind dropped", "before anyone spoke", "after the bell had rung",
         "when the rain eased", "though nobody looked"]


_OWNER = ["the ferryman’s", "the harbourmaster’s", "the widow’s", "the boatwright’s", "the teacher’s",
          "the baker’s", "the pilot’s"]
_TOTAL = len(_ADJ) * len(_NOUN) * len(_VERB) * len(_PLACE) * len(_TAIL)


def gen_sentence(i: int, apos: bool = False) -> str:
    """A distinct plain sentence for index i < _TOTAL (a bijective shuffle, then mixed radix: no two indexes give the
    same sentence, and neighbours differ in every word). ``apos``: with a possessive in a curly apostrophe (’)."""
    j = (i * 7919 + 13) % _TOTAL
    out = []
    for lst in (_ADJ, _NOUN, _VERB, _PLACE, _TAIL):
        out.append(lst[j % len(lst)])
        j //= len(lst)
    head = f"{_OWNER[i % len(_OWNER)][:1].upper()}{_OWNER[i % len(_OWNER)][1:]} {out[0]}" if apos else \
        f"The {out[0]}"
    return f"{head} {out[1]} {out[2]} {out[3]} {out[4]}."


def gen_chapter(num: int, words: int, per_par: int = 5, apos: bool = False) -> str:
    """About ``words`` words of distinct sentences for chapter ``num`` (never the same sentence in two chapters)."""
    sents, n, i = [], 0, num * 3000
    while n < words:
        s = gen_sentence(i, apos)
        i += 1
        sents.append(s)
        n += len(s.split())
    pars = [" ".join(sents[k:k + per_par]) for k in range(0, len(sents), per_par)]
    return "\n\n".join(pars)


def file_bytes(h: Harness, run: dict, fmt: str) -> bytes | None:
    for f in run.get("files") or []:
        if f["format"] == fmt:
            rec = h.app.store.get_record(run["project_id"], run.get("branch_id") or "main", f["record_id"],
                                         f["version"])
            return h.app.store.read_binary(rec)
    return None


def zip_parts(data: bytes | None) -> dict:
    if not data:
        return {}
    z = zipfile.ZipFile(io.BytesIO(data))
    return {n: z.read(n).decode("utf-8", "replace") for n in z.namelist()
            if n.endswith((".xhtml", ".html", ".xml", ".opf", ".ncx"))}


def pdf_pages(data: bytes | None) -> tuple[list[str], dict]:
    if not data:
        return [], {}
    import pypdf  # noqa: PLC0415 - only this scenario reads a PDF back
    r = pypdf.PdfReader(io.BytesIO(data))
    return [p.extract_text() or "" for p in r.pages], dict(r.metadata or {})


def epub_text(h: Harness, run: dict) -> str:
    return "\n".join(zip_parts(file_bytes(h, run, "EPUB")).values())


def finished(h: Harness, body: dict | None = None) -> dict:
    h.start(dict(SOLO_BODY, **(body or {})))
    ok = h.wait()
    h.settle()
    return {"status": h.raw().get("status") if ok else "hang", "stops": [], "first": {}, "hang": not ok,
            "final": h.run()}


def settings_blob(h: Harness, run: dict) -> str:
    pid, br = run["project_id"], run.get("branch_id") or "main"
    rows = h.app.store.query("SELECT key, value FROM settings WHERE key LIKE ?", (f"%{pid}%",))
    return "\n".join(str(r["value"]) for r in rows)


# ================================================================================================ part 5
UA = "Unknown author"


def _ua_counts(h: Harness, run: dict) -> dict:
    pages, meta = pdf_pages(file_bytes(h, run, "PDF"))
    epub, docx = zip_parts(file_bytes(h, run, "EPUB")), zip_parts(file_bytes(h, run, "DOCX"))
    return {"pdf_pages": sum(1 for p in pages if UA in p), "pdf_total": len(pages),
            "pdf_title_page": bool(pages and UA in pages[0]), "pdf_meta": UA in str(meta.get("/Author") or ""),
            "epub": sorted(n for n, t in epub.items() if UA in t), "docx": sorted(n for n, t in docx.items() if UA in t)}


@SEC.stress("5", "a", "no pen name typed: what the PDF / EPUB / DOCX print as the author", likely=LIKELY,
            time_limit=240)
def r5_a(h: Harness) -> Outcome:
    h.make_app()
    h.chaos.chapter_texts = {f"ch{n}": gen_chapter(n, 1400) for n in (1, 2, 3)}  # long enough for running heads
    res = finished(h)
    run = res["final"]
    o = h.outcome()
    c = _ua_counts(h, run) if run.get("status") == "done" else {}
    noted = [e.get("code") for e in (h.raw().get("events") or []) if str(e.get("code") or "").startswith("PEN_")]
    heads = [n for n in c.get("docx") or [] if "header" in n]
    o.happened = (f"No pen name was typed. “{UA}” is printed on {c.get('pdf_pages')} of {c.get('pdf_total')} PDF "
                  f"page(s) (the title page: {'yes' if c.get('pdf_title_page') else 'no'}; this PDF's running heads "
                  f"carry the title and chapter, not the author), in the PDF's Author field "
                  f"({'yes' if c.get('pdf_meta') else 'no'}), in the EPUB ({', '.join(c.get('epub') or []) or 'nowhere'}"
                  f": the title page and the dc:creator metadata) and in the DOCX "
                  f"({', '.join(c.get('docx') or []) or 'nowhere'}"
                  + (f" — {', '.join(heads)} is the running head of every left-hand page" if heads else "") + "). "
                  + ("The run said nothing about the missing pen name." if not noted else
                     f"The run noted: {', '.join(noted)}."))
    if c and (c["pdf_pages"] or c["epub"] or c["docx"]):
        o.risks.append(f"the finished files print the placeholder “{UA}” as the author (title page, running heads, "
                       "metadata) and the run never asked for or mentioned a pen name")
    return grade(h, o, res, others_worked=False)


@SEC.stress("5", "b", "control: a pen name typed for the run", likely=LIKELY, time_limit=240)
def r5_b(h: Harness) -> Outcome:
    h.make_app()
    h.chaos.chapter_texts = {f"ch{n}": gen_chapter(n, 1400) for n in (1, 2, 3)}
    res = finished(h, {"pen_name": "Ada Quillfeather"})
    run = res["final"]
    o = h.outcome()
    c = _ua_counts(h, run) if run.get("status") == "done" else {}
    pages, _m = pdf_pages(file_bytes(h, run, "PDF"))
    named = sum(1 for p in pages if "Ada Quillfeather" in p or "ADA QUILLFEATHER" in p)
    o.happened = (f"With the pen name typed, it is printed on {named} of {len(pages)} PDF page(s); “{UA}” appears "
                  f"on {c.get('pdf_pages', '?')} page(s), EPUB {c.get('epub') or 'nowhere'}, DOCX "
                  f"{c.get('docx') or 'nowhere'}.")
    if c and (c["pdf_pages"] or c["epub"] or c["docx"] or c["pdf_meta"]):
        o.issues.append("the placeholder author is printed although a pen name was typed")
    return grade(h, o, res, others_worked=False)


# ================================================================================================ part 6
REPEAT = ("Somewhere beyond the breakwater a bell kept time with the waves, slow and patient, as if it had been "
          "counting the drowned for a hundred years and meant to go on counting them.")


@SEC.stress("6", "a", "the same long sentence word for word in chapters 1 and 3", likely=LIKELY, time_limit=240)
def r6_a(h: Harness) -> Outcome:
    from autobook_fake import CHAPTER_TEXT  # noqa: PLC0415
    h.make_app()
    texts = {}
    for n in (1, 2, 3):
        paras = list(CHAPTER_TEXT[n])
        if n in (1, 3):
            paras[1] = paras[1] + " " + REPEAT
        texts[f"ch{n}"] = "\n\n".join(paras)
    h.chaos.chapter_texts = texts
    res = finished(h)
    run = res["final"]
    o = h.outcome()
    if run.get("status") == "done":
        book = epub_text(h, run)
        left = book.count("kept time with the waves")
        frag = "kept time with the waves"
        blob = settings_blob(h, run) + json.dumps(h.raw().get("events") or [], ensure_ascii=False) + \
            json.dumps(run.get("report") or {}, ensure_ascii=False)
        flagged = frag in blob or "bell kept time" in blob
        pid = run["project_id"]
        hp = h.app.store.get_setting(f"human_pass:{pid}:{run.get('branch_id') or 'main'}") or {}
        found = []

        def walk(x):
            if isinstance(x, dict):
                if x.get("kind") == "phrase" and isinstance(x.get("message"), str):
                    q = x["message"].split("”", 1)[0].lstrip("“")
                    if q and q.lower() in REPEAT.lower():
                        found.append((x.get("severity"), q))
                for v in x.values():
                    walk(v)
            elif isinstance(x, list):
                for v in x:
                    walk(v)
        walk(hp)
        frags = sorted({q for _s, q in found})
        sev = sorted({s_ for s_, _q in found if s_})
        o.happened = (f"The finished book still has the sentence {left}× (chapters 1 and 3). "
                      + (f"The cross-chapter repeat check reported it only as {len(frags)} separate "
                         f"“same phrase in several chapters” finding(s) of 5-word pieces ({'/'.join(sev)}), e.g. "
                         f"“{frags[0]}” — never as one whole sentence repeated word for word; the end pass offered "
                         "rewrite suggestions; nothing was changed in the book." if frags else
                         "No repeat finding quotes it." if not flagged else
                         "It is quoted in the run's notes, but no repeat finding names it."))
        if left >= 2:
            o.risks.append("a long sentence repeated word for word in two chapters is still in the finished book; "
                           + (f"it is reported only as {len(frags)} minor 5-word phrase repeats" if frags else
                              "nothing told the author"))
    return grade(h, o, res, others_worked=False)


# ================================================================================================ part 7
def _cuts_for(c) -> dict:
    """A tough editor's answer: about 10 % of the chapter as exact one-sentence cuts from the middle paragraphs."""
    text = str((c.ctx or {}).get("chapter_text") or "")
    pars = [p for p in text.split("\n\n") if p.strip()]
    want = int(((c.ctx or {}).get("cut_rules") or {}).get("cut_about_words") or len(text.split()) // 10)
    cuts, n = [], 0
    for p in pars[1:-1]:
        s = re.split(r"(?<=[.!?])\s+", p.strip())
        if len(s) > 2 and n < want:
            cuts.append({"quote": s[1], "label": "padding"})
            n += len(s[1].split())
    return {"cuts": cuts, "fat_percent": 12}


def _cut_rows(h: Harness) -> list[dict]:
    raw = h.raw() or {}
    st = h.app.store.get_setting(f"cut_pass:{raw.get('project_id')}:{raw.get('branch_id') or 'main'}") or {}
    out = []
    for cid, cp in sorted(st.items()):
        if isinstance(cp, dict):
            out.append({"chapter": cp.get("chapter_id") or cid, "kept": bool(cp.get("kept")), "cuts": cp.get("cuts"),
                        "proposed": cp.get("proposed"), "outcome": cp.get("outcome"), "refused": cp.get("refused"),
                        "words": f"{cp.get('words_before')}→{cp.get('words_after')}"})
    return out


@SEC.stress("7", "a", "chapters ~25 % over their share; the editor proposes valid labelled cuts", likely=LIKELY,
            time_limit=240)
def r7_a(h: Harness) -> Outcome:
    h.make_app()
    h.chaos.chapter_texts = {f"ch{n}": gen_chapter(n, 1700) for n in (1, 2, 3)}   # 3 × ~1700 of a 4000-word target
    h.chaos.add(Rule(replace(_cuts_for), kinds="cuts"))
    res = finished(h)
    run = res["final"]
    o = h.outcome()
    rows = _cut_rows(h)
    kept = [r for r in rows if r["kept"]]
    ws = {}
    try:
        ws = h.app.autobook.bp(h.raw()).word_stats()
    except Exception:  # noqa: BLE001
        pass
    tot, tgt = ws.get("words") or 0, ws.get("target_words") or 0
    o.happened = (f"Book {tot} words of a {tgt}-word target ({round(100 * tot / tgt) if tgt else '?'} %). The editor "
                  f"proposed cuts in {sum(1 for r in rows if r.get('proposed'))} chapter(s); the cut pass KEPT cuts in "
                  f"{len(kept)} of {len(rows)} chapter(s)"
                  + (f" ({'; '.join(str(r['chapter']) + ': ' + str(r['cuts']) + ' cut(s)' for r in kept)})" if kept
                     else "") + ".")
    if rows and not kept:
        o.risks.append("the cut pass kept 0 cuts in every chapter although the book is over its target and the "
                       "editor proposed valid, labelled, exact cuts")
    o.notes.append("Cut pass per chapter: " + json.dumps(rows, ensure_ascii=False)[:600])
    return grade(h, o, res, others_worked=False)


@SEC.stress("7", "b", "the Practice AI's own cut pass on a book over its target (no scripted cuts)", likely=LIKELY,
            time_limit=240)
def r7_b(h: Harness) -> Outcome:
    h.make_app()
    h.chaos.chapter_texts = {f"ch{n}": gen_chapter(n, 1700) for n in (1, 2, 3)}
    res = finished(h)
    o = h.outcome()
    rows = _cut_rows(h)
    o.happened = (f"With the Practice AI's editor (it proposes no cuts) the cut pass kept cuts in "
                  f"{sum(1 for r in rows if r['kept'])} of {len(rows)} chapter(s).")
    o.notes.append("The Practice AI never proposes a cut (cut_script empty): a run with it can never show the cut "
                   "pass working — a test of the cut pass needs scripted cuts (R-7-a).")
    return grade(h, o, res, others_worked=False)


# ================================================================================================ part 8
def _versions(h: Harness) -> list[dict]:
    raw = h.raw()
    bp = h.app.autobook.bp(raw)
    pid, br = raw["project_id"], raw.get("branch_id") or "main"
    craft = h.app.store.get_setting(f"craft_reviews:{pid}:{br}") or {}
    read: dict[str, list[int]] = {}
    for k in craft:
        rid, _, v = k.rpartition(":")
        if v.isdigit():
            read.setdefault(rid, []).append(int(v))
    out = []
    outline = bp.outline()
    for ch in bp.outline_chapters(outline):
        _c, latest, appr = bp.chapter_prose(outline, ch["chapter_id"])
        final = (appr or latest or {}).get("version")
        rid = (appr or latest or {}).get("record_id")
        out.append({"chapter": ch["chapter_id"], "final": final, "editor_read": max(read.get(rid) or [0]),
                    "versions": sorted(read.get(rid) or [])})
    return out


@SEC.stress("8", "a", "the chapter changes after the editor's read (planned details worked in, cuts kept)",
            likely=LIKELY, time_limit=240)
def r8_a(h: Harness) -> Outcome:
    h.make_app()
    h.chaos.planned_fix = True
    h.chaos.chapter_texts = {f"ch{n}": gen_chapter(n, 1500) for n in (1, 2, 3)}
    h.chaos.add(Rule(replace(_cuts_for), kinds="cuts"))
    res = finished(h)
    o = h.outcome()
    rows = _versions(h) if res["final"].get("status") == "done" else []
    stale = [r for r in rows if r["editor_read"] and r["editor_read"] != r["final"]]
    o.happened = ("Editor's read vs the final version: " + "; ".join(
        f"{r['chapter']}: editor read v{r['editor_read']}, final v{r['final']}" for r in rows) + ".")
    if stale:
        o.risks.append(f"the editor's notes (and the report's editor lines) describe an earlier version in "
                       f"{len(stale)} chapter(s) ({', '.join(r['chapter'] for r in stale)}): the final text was "
                       "changed after the editor read it and was not read again")
    return grade(h, o, res, others_worked=False)


# ================================================================================================ part 9
def _missing(h: Harness) -> tuple[int, list[str], bool]:
    raw = h.raw()
    rows = raw.get("planned") or {}
    n = sum(len(v.get("missing") or []) for v in rows.values())
    chs = [v.get("chapter_id") for v in rows.values() if v.get("missing")]
    told = any(e.get("code") == "PLANNED_MISSING" for e in raw.get("events") or [])
    return n, chs, told


@SEC.stress("9", "a", "the writer's planned-detail fixes do not match the text (the default Practice AI writer)",
            likely=LIKELY, time_limit=240)
def r9_a(h: Harness) -> Outcome:
    h.make_app()
    res = finished(h)
    o = h.outcome()
    n, chs, told = _missing(h)
    o.happened = (f"{n} planned detail(s) are not on the page in the finished book ({', '.join(chs) or 'none'}); "
                  f"the writer's fixes never matched the text word for word (PLANNED_UNRESOLVED), one round each. "
                  + ("The journal and the report list them (PLANNED_MISSING); the book goes on." if told else
                     "Nothing told the author."))
    if n:
        o.risks.append(f"{n} planned detail(s) missing from the finished book after one failed fix round per chapter "
                       "(no second try, no other AI asked to work them in)")
    return grade(h, o, res, others_worked=False)


@SEC.stress("9", "b", "a writer that does work the planned details in", likely=LIKELY, time_limit=240)
def r9_b(h: Harness) -> Outcome:
    h.make_app()
    h.chaos.planned_fix = True
    res = finished(h)
    o = h.outcome()
    n, chs, told = _missing(h)
    o.happened = (f"With a writer whose fixes match the text: {n} planned detail(s) still missing at the end "
                  f"({', '.join(chs) or 'none'}).")
    if n:
        o.risks.append(f"{n} planned detail(s) still missing although the writer's fixes matched")
    return grade(h, o, res, others_worked=False)


@SEC.stress("7", "c", "the editor's cuts quote the chapter with straight apostrophes where the text has curly ones",
            likely=LIKELY, time_limit=240)
def r7_c(h: Harness) -> Outcome:
    h.make_app()
    h.chaos.chapter_texts = {f"ch{n}": gen_chapter(n, 1700, apos=True) for n in (1, 2, 3)}

    def straight(c):
        out = _cuts_for(c)
        for cut in out["cuts"]:
            cut["quote"] = cut["quote"].replace("’", "'")  # a web AI's JSON answer: the usual typographic drift
        return out
    h.chaos.add(Rule(replace(straight), kinds="cuts"))
    res = finished(h)
    o = h.outcome()
    rows = _cut_rows(h)
    kept = [r for r in rows if r["kept"]]
    refused = {}
    for r in rows:
        for k, v in (r.get("refused") or {}).items():
            refused[k] = refused.get(k, 0) + (v if isinstance(v, int) else 1)
    o.happened = (f"The editor proposed {sum(int(r.get('proposed') or 0) for r in rows)} cut(s), each the exact "
                  "sentence except a straight apostrophe for the chapter's curly one; the cut pass kept cuts in "
                  f"{len(kept)} of {len(rows)} chapter(s)" + (f"; refused: {refused}" if refused else "") + ".")
    if rows and not kept:
        o.risks.append("every cut was refused because its quote differs from the chapter only in typography (’ vs "
                       "'): the book stays over its target with 0 cuts kept — the log's “0 cuts in all 3 chapters”")
    o.notes.append("Cut pass per chapter: " + json.dumps(rows, ensure_ascii=False)[:600])
    return grade(h, o, res, others_worked=False)


# ================================================================================================ part 10
@SEC.stress("10", "a", "Claude's pane broken for the whole run (SEND_NOT_CONFIRMED, pane-broken)", likely=LIKELY,
            time_limit=240)
def r10_a(h: Harness) -> Outcome:
    b = real_app(h)
    b.states["claude"] = ("broken", "SEND_NOT_CONFIRMED")
    res = author_loop(h)
    o = h.outcome()
    wrote = answered_by(h, ("C02", "scene_prose", "expand"), "chapters")
    o.happened = (f"AutoInjector reported Claude's pane as broken (SEND_NOT_CONFIRMED) all run. The writing went to "
                  f"{', '.join(wrote) or 'nobody'}"
                  + (f"; the run stopped {len(res['stops'])}× ({', '.join(res['stops'])})" if res["stops"] else
                     "; the run never stopped") + f"; Claude was sent {sum(1 for x in b.log if x[1] == 'claude')} "
                  "request(s) anyway.")
    return grade(h, o, res, others_worked=True, kinds=("C02", "scene_prose", "expand"), step="chapters")


@SEC.stress("10", "b", "Claude's pane breaks in the middle of the chapters", likely=LIKELY, time_limit=240)
def r10_b(h: Harness) -> Outcome:
    b = real_app(h)
    h.at_step("chapters", before=lambda run: b.states.update(claude=("broken", "SEND_NOT_CONFIRMED")))
    res = author_loop(h)
    o = h.outcome()
    o.happened = ("Claude's pane broke as the chapters began. "
                  + (f"The run stopped {len(res['stops'])}× ({', '.join(res['stops'])})." if res["stops"] else
                     "The run never stopped.") + " Chapters written by "
                  + (", ".join(answered_by(h, ("C02", "scene_prose", "expand"), "chapters")) or "nobody") + ".")
    return grade(h, o, res, others_worked=True, kinds=("C02", "scene_prose", "expand"), step="chapters")


@SEC.stress("10", "c", "the bridge reports ChatGPT as broken once its capture stalls (the suggested AutoInjector "
            "signal)", likely=UNLIKELY, time_limit=240)
def r10_c(h: Harness) -> Outcome:
    b = real_app(h)
    h.chaos.add(Rule(timeout(), kinds="review", slots="AI-2"))
    orig = b.complete

    def complete(body):
        st, out = orig(body)
        if st == 504 and body.get("site") == "chatgpt":
            b.states["chatgpt"] = ("broken", "REPLY_UNREADABLE")   # what capture-stalled could report in /v1/health
        return st, out
    b.complete = complete
    res = author_loop(h)
    o = h.outcome()
    o.happened = ("Simulated hook (AutoInjector does not do this today): after ChatGPT's first stalled reply, the "
                  "bridge's /v1/health says ChatGPT is broken (REPLY_UNREADABLE). "
                  + (f"The run stopped {len(res['stops'])}× ({', '.join(res['stops'])})." if res["stops"] else
                     "The run never stopped.")
                  + f" ChatGPT timed out {b.outcomes('TIMEOUT')}× in all (vs 14× in R-1-a); reviews answered by "
                  + (", ".join(answered_by(h, "review")) or "nobody") + ".")
    o.notes.append("Shows what the fix on AutoInjector's side would buy: the stall becomes a site state Akọwe already "
                   "routes around (P18.9), so only the first request is lost.")
    return grade(h, o, res, others_worked=True, kinds="review")


@SEC.stress("10", "d", "the log's night: ChatGPT cannot be read on ANY call; the author presses Try again on every "
            "stop", likely=LIKELY, time_limit=300)
def r10_d(h: Harness) -> Outcome:
    from akowe import clean_run  # noqa: PLC0415
    b = real_app(h)
    h.chaos.add(Rule(timeout(), slots="AI-2"))
    res = author_loop(h, {"fill_bible": True, "writers_room": True}, max_stops=10)
    o = h.outcome()
    sc = clean_run.score(h.raw()) or {}
    kinds = {}
    for _n, k, _s, slot, f in h.chaos.trace:
        if f:
            kinds[k] = kinds.get(k, 0) + 1
    o.happened = (f"ChatGPT timed out on every call of every kind (Claude and Gemini fine). {b.outcomes('TIMEOUT')} "
                  f"TIMEOUTs ({', '.join(f'{k} ×{v}' for k, v in sorted(kinds.items(), key=lambda kv: -kv[1]))}); "
                  f"{len(res['stops'])} stop(s) for the author ({', '.join(res['stops'])}); clean-run score "
                  f"{sc.get('score')}/10.")
    return grade(h, o, res, others_worked=True)


@SEC.stress("10", "e", "the clean-run score after hours lost to a timed-out AI but no stop", likely=LIKELY,
            time_limit=240)
def r10_e(h: Harness) -> Outcome:
    from akowe import clean_run  # noqa: PLC0415
    real_app(h)
    h.chaos.add(Rule(timeout(), kinds=("craft", "planned"), slots="AI-2"))
    res = author_loop(h)
    o = h.outcome()
    sc = clean_run.score(h.raw()) or {}
    o.happened = (f"The editor and the planned-to-page check timed out on ChatGPT in every chapter (≈ {mins(_clock(h))} "
                  f"lost, both checks skipped), no stop: the clean-run score says {sc.get('score')}/10"
                  + (" “a clean run”" if sc.get("clean") else "") + ".")
    if sc.get("score", 0) >= 9.5:
        o.risks.append(f"the clean-run score reads {sc.get('score')}/10 (“a clean run”) although ≈ {mins(_clock(h))} "
                       "went on timeouts and the editor's read and the planned check were skipped in every chapter: "
                       "TIMEOUTs, skipped checks and failovers cost nothing in the score")
    return grade(h, o, res, others_worked=True, kinds=("craft", "planned"))


@SEC.stress("10", "f", "crew members named by number (“Crewman Two”)", likely=UNLIKELY, time_limit=240)
def r10_f(h: Harness) -> Outcome:
    from akowe import practice_ai  # noqa: PLC0415
    names = {k: list(v) for k, v in practice_ai.NAMES.items()}
    names["A01"] = [("Crewman Two" if n == "Tom Reed" else n) for n in names["A01"]]
    h.patch(practice_ai, "NAMES", names)
    h.make_app()
    from autobook_fake import CHAPTER_TEXT  # noqa: PLC0415
    h.chaos.chapter_texts = {f"ch{n}": "\n\n".join(CHAPTER_TEXT[n]).replace("Tom Reed", "Crewman Two")
                             + "\n\nCrewman Two said nothing more that night." for n in (1, 2, 3)}
    res = finished(h)
    o = h.outcome()
    run = res["final"]
    if run.get("status") == "done":
        book = epub_text(h, run)
        blob = json.dumps(h.raw().get("events") or [], ensure_ascii=False) + settings_blob(h, run)
        flagged = bool(re.search(r"(?i)(named by (a )?number|placeholder name|generic name)", blob))
        o.happened = (f"A character the AI named “Crewman Two” is in the finished book {book.count('Crewman Two')}×; "
                      + ("a check flagged the name." if flagged else "no check flagged a name made of a role and a "
                         "number."))
        if book.count("Crewman Two") and not flagged:
            o.risks.append("a character named by number (“Crewman Two”) reaches the finished book unflagged")
    return grade(h, o, res, others_worked=False)


@SEC.stress("10", "g", "Claude's health reads ok but every send fails (SEND_NOT_CONFIRMED on each request)",
            likely=LIKELY, time_limit=240)
def r10_g(h: Harness) -> Outcome:
    b = real_app(h)
    orig = b.complete
    jobs: set = set()

    def complete(body):
        if body.get("site") == "claude":
            jobs.add(re.sub(r"-\d+-claude-c\d+.*$", "", str(body.get("request_id") or "")))
            b.note("claude", body.get("request_id"), "SEND_NOT_CONFIRMED")
            return 502, {"ok": False, "error": "SEND_NOT_CONFIRMED"}
        return orig(body)
    b.complete = complete
    res = author_loop(h)
    o = h.outcome()
    sent = b.outcomes("SEND_NOT_CONFIRMED")
    o.happened = ("AutoInjector's health said Claude was fine, but every prompt sent to Claude failed "
                  f"(SEND_NOT_CONFIRMED). Claude was tried {sent}× during the run"
                  + (f"; the run stopped {len(res['stops'])}× ({', '.join(res['stops'])})" if res["stops"] else
                     "; the run never stopped") + "; chapters written by "
                  + (", ".join(answered_by(h, ("C02", "scene_prose", "expand"), "chapters")) or "nobody") + ".")
    from akowe.jobs import DEFAULT_RETRY  # noqa: PLC0415
    per = float(DEFAULT_RETRY["max_total_s"])
    o.happened += (f" {len(jobs)} different jobs (checks that want every working AI: cross-check reviews, the editor, "
                   "checkpoints, the book report …) sent to Claude and then WAITED for it (“Waiting for Claude (not "
                   "reachable) — retrying”) because its health still read ok.")
    if len(jobs) > 2:
        o.risks.append(f"{len(jobs)} jobs waited and retried on Claude whose every send failed while its health read "
                       f"ok; with the default retry policy (15/30/60/120 s, up to {per / 60:.0f} min per job) that is "
                       f"up to ≈ {mins(len(jobs) * per)} of waiting in real life (the harness's retry policy is "
                       "milliseconds)")
    o.notes.append(f"Claude was tried {sent}× (a failed slot is put last only for FAIL_HOLD_S = 15 s, so each new "
                   "call starts on the broken pane again; AutoInjector's own 3 send tries per prompt are not "
                   "simulated). The simulated clock holds only Akọwe's 1–4 s provider retries.")
    return grade(h, o, res, others_worked=True, kinds=("C02", "scene_prose", "expand"), step="chapters")


# ================================================================================================ analysed findings
_CHECKER_WHERE = ("akowe/akowe/assist.py `_call_ai_once` (~line 695–745): the checker jobs (review, scenes_check, "
                  "editor, planned_check, writers' room …) pick a slot themselves and call `prov.generate(..., "
                  "slot_id=slot[\"slot_id\"])` (line ~720); in akowe/akowe/providers.py `_generate` (~1590–1660) an "
                  "explicit slot_id means `others=False` (line ~1637), so `_generate_timeout_safe` (~1688) asks the "
                  "SAME web AI once more after TIMEOUT_RETRY_WAIT_S (60 s) instead of moving; back in assist the "
                  "failover branch (line ~733) moves only on UPSTREAM_UNAVAILABLE / AI_DECLINED / unusable — "
                  "`_unusable` explicitly excludes TIMEOUT — so the TIMEOUT is raised")
_CHECKER_CAUSE = ("TIMEOUT is treated as “ambiguous, the author decides” (contract rule from the paid-API days), "
                  "but a web AI whose prompt was typed and whose late window expired (`late_expired` / "
                  "`late_collect_tried`) is not ambiguous any more: nothing more will come. Each such call costs the "
                  "full timeout (~895 s: `AutoInjectorAdapter.timeout_ms` caps at 900 s) + the late window (300 s) "
                  "+ 60 s + the same again on the -c1- try ≈ 41 min, then the checker stops the book or is skipped. "
                  "The failed-slot hold (FAIL_HOLD_S = 15 s) is long over by the next call, so the next call of the "
                  "same kind goes to the same AI again")
_CHECKER_FIX = ("in assist `_call_ai_once`, treat a TIMEOUT whose bridge body says typed + late_expired (or "
                "late_collect_tried) like UPSTREAM_UNAVAILABLE: add the slot to `failed` and move to another working "
                "AI (`_other_ai`), keeping the writer≠reviewer rule; do not do the 60 s same-AI retry when another AI "
                "could take the call; mark the slot failed for much longer than 15 s after a TIMEOUT (e.g. until "
                "its next successful probe), so the next call of any kind starts elsewhere")

for _l in "abcdefg":
    SEC.finding(f"R-1-{_l}", where=_CHECKER_WHERE if _l in "abcde" else
                "akowe/akowe/providers.py `_generate` / `_generate_timeout_safe` (~1590–1710): the registry path (no "
                "slot_id) DOES move a TIMEOUT to the next working AI, but only after the whole timeout + late window "
                "(~20 min for a 900 s deadline, ~11 min for the writer's 355 s), and the bible batch got the 60 s "
                "same-AI retry first (book_bible fill → ~41 min, then BIBLE_FILL_LATER)",
                cause=_CHECKER_CAUSE if _l in "abcde" else
                "there is no early signal: Akọwe waits the full timeout it asked for, then the late window; the "
                "failed-slot hold is 15 s, so each new chapter starts on the AI that timed out again (3 chapters → 3 "
                "full timeouts)", fix=_CHECKER_FIX if _l in "abcde" else
                "after a TIMEOUT with late_expired, keep the slot “failed” until a probe says it answers again "
                "(not 15 s); give the writer's later chapters to the AI that took over; shorten timeout_ms when the "
                "bridge reports a stalled capture (see R-10-c)", severity="blocks the book needlessly",
                likely=LIKELY,
                what={"a": "review: 4 stops while Claude and Gemini worked, ≈ 4.8 h lost (the log's review ×4)",
                      "b": "scenes_check: 3 stops, ≈ 2 h lost (the log's scenes_check stop)",
                      "c": "editor: never stops but each chapter waits ≈ 41 min and then goes on WITHOUT the editor",
                      "d": "planned_check: ≈ 41 min per chapter, then skipped (PLANNED_CHECK_FAILED)",
                      "e": "writers' room: ≈ 41 min per room, ChatGPT's pitch/vote missing",
                      "f": "bible fill: ≈ 41 min on the same AI, then a batch left for later",
                      "g": "chapter writer: moves to another AI, but only after ≈ 11 min per chapter, every chapter"}[_l])

SEC.finding("R-2-b", where="akowe/akowe/providers.py `_generate_timeout_safe` (~1688–1710) and `_post_collecting` "
            "(~1100): after LATE_EXPIRED the late request is forgotten (`_forget_late`) and, with an explicit slot, the "
            "whole prompt is sent again to the SAME AI after 60 s (bridge id -c1-)",
            cause="the answer that arrives after LATE_EXPIRED is dropped by AutoInjector and Akọwe has no way to ask "
            "for it; the second try is a new prompt typed into the chat that already holds the late answer",
            fix="move the second try to another working AI when one exists (see R-1); optionally ask AutoInjector "
            "for a reply that arrived after LATE_EXPIRED under the old request id before typing again",
            severity="blocks the book needlessly", likely=LIKELY,
            what="a late answer after LATE_EXPIRED is thrown away and the same AI is asked again: ≈ 21 min")
SEC.finding("R-4-a", where="akowe/akowe/autobook.py `_pause_problem` (~1588): a TIMEOUT stop is a plain pause "
            "(options [retry]); akowe/akowe/stand_in.py DEFAULTS (`errors`: False) — nothing else ever resumes it",
            cause="no automatic retry or failover for an error stop unless the author switched 🗳 on in Settings › AI",
            fix="for a TIMEOUT stop while another AI works: retry automatically once with another AI after a few "
            "minutes (or make 🗳 “another AI” the default for TIMEOUT); keep the alert", severity="blocks the book "
            "needlessly", likely=LIKELY, what="a TIMEOUT stop at night waits for the author indefinitely (5 h in the "
            "log) while two AIs work")
SEC.finding("R-4-b", where="akowe/akowe/stand_in.py `voters` / `tally` and stand_in_errors.decide: every connected "
            "working AI votes, all must agree; a missing vote = VOTE_MISSING",
            cause="the AI that cannot answer (its replies are unreadable) is itself a voter, so its vote times out "
            "(another ≈ 20–40 min) and the vote can never decide", fix="leave out of the voters the AI whose failure "
            "caused the stop (run['last_failed_slot']) and any slot that timed out in the last hour",
            severity="blocks the book needlessly", likely=LIKELY,
            what="with 🗳 on, the vote fails (VOTE_MISSING) because the broken AI must vote too")
SEC.finding("R-4-c", where="akowe/akowe/stand_in_errors.py `apply` (pick other_ai, ~240–250) → autobook "
            "`_TimedProviders.avoid` (~632): only the run's writer pin / avoid set changes; the reviewer job "
            "(review.py `plan_reviewer`, assist `_choose_slot`) never reads it",
            cause="“try again with another AI” is applied to the run's provider view, not to the checker jobs, so the "
            "review goes back to the AI that timed out and the run stops again; the same stop key is not voted twice",
            fix="pass the avoided slot(s) into the review / checker jobs (job.never_slots or avoid_slots) for the "
            "retried step", severity="blocks the book needlessly", likely=UNLIKELY,
            what="the AIs agree on “another AI”, but the review goes to the broken AI again and the run stops again")
SEC.finding("R-5-a", where="akowe/akowe/book_path.py `title_author` (line ~485): `... or \"Unknown author\"`; "
            "exporters print it on the title page, the EPUB dc:creator, the DOCX core.xml and the DOCX left-hand "
            "running head (word/header2.xml)", cause="an empty pen name is replaced by a placeholder instead of "
            "being left out, and the run never asks for a pen name or warns", fix="leave the author line out when "
            "there is no pen name (no title-page line, title-only running heads, no creator) and add a ⚠️ note "
            "“no pen name — type one in Book profile” to the run summary", severity="cosmetic", likely=LIKELY,
            what="“Unknown author” on the title page, metadata and DOCX running heads when no pen name was typed")
SEC.finding("R-6-a", where="akowe/akowe/human_voice.py `_repeats` (~326–430): phrases are 5-word n-grams; "
            "overlapping grams of one sentence are partly merged (`kept`, ≥ 4 shared words) and reported as minor "
            "“same phrase in several chapters”; no whole-sentence comparison", cause="a repeated SENTENCE is seen "
            "only as several minor phrase repeats and nothing removes it (the end pass only suggests rewrites)",
            fix="add an exact (normalised) sentence match across chapters for sentences of ≥ 12 words, reported as "
            "one major finding and fed to the cut pass / end pass as a must-fix", severity="cosmetic",
            likely=LIKELY, what="a long sentence repeated word for word in chapters 1 and 3 stays in the book")
SEC.finding("R-7-c", where="akowe/akowe/cut_pass.py `validate` (~173–215): `NOT_FOUND` when the quote is not in the "
            "chapter exactly", cause="the match is byte-exact; web AIs routinely answer with straight quotes / "
            "apostrophes / hyphens where the book has typographic ones (or the reverse), so every cut is refused",
            fix="match after normalising quotes, apostrophes, dashes and whitespace (map the hit back to the original "
            "span), like fact_checks does for rewrites; count NOT_FOUND refusals in the journal so a 0-cut pass "
            "says why", severity="cosmetic", likely=LIKELY,
            what="all cuts refused (NOT_FOUND) for a ’ vs ' difference: 0 cuts kept, the book stays over its target")
SEC.finding("R-8-a", where="akowe/akowe/autobook.py `_review_until_approved` order: editor (~2281) → planned pass "
            "(~2460) → cut pass → approval; then opening / improve passes; craft_reviews:<book> keeps the read "
            "version (`<rid>:<version>`)", cause="the chapter changes after the editor's read (planned details "
            "worked in, cuts kept, end rewrites) and the editor never reads the final version; the report shows the "
            "old notes", fix="after a kept planned / cut / end rewrite, re-run the editor's read on the final version "
            "(notes only), or label the report's editor lines “read version N of M”", severity="confusing message",
            likely=LIKELY, what="the editor's notes describe v1–v2, the final chapters are v3–v4")
SEC.finding("R-9-a", where="akowe/akowe/autobook.py `_planned_work` (~2460–2560), planned.ROUNDS", cause="one fix "
            "round; when the writer's replacements do not match the text word for word (PLANNED_UNRESOLVED) "
            "nothing else is tried — no second writer, no looser match", fix="on PLANNED_UNRESOLVED ask once more "
            "with the exact paragraphs to change (or another working AI), and match the replacements' originals "
            "after normalising like R-7-c", severity="cosmetic", likely=LIKELY,
            what="planned details stay off the page after one failed fix round (listed as PLANNED_MISSING)")
SEC.finding("R-10-c", where="cross-side: AutoInjector's `capture-stalled` (3 min, “reply selector matches nothing”) "
            "is not reported to Akọwe; akowe/akowe/providers.py `SlotHealth` / `eligible` already skip a site whose "
            "/v1/health state is broken", cause="today the stall stays inside AutoInjector and the request runs to "
            "its timeout", fix="(simulated here) when the capture stalls, AutoInjector answers the pending request "
            "early (504 typed + late_expired, or 503 SITE_NOT_READY) and reports the site as broken / "
            "REPLY_UNREADABLE in /v1/health until a probe reads a reply again; Akọwe then routes around it",
            severity="blocks the book needlessly", likely=LIKELY,
            what="with the hook: 1 TIMEOUT instead of 14 and no stop — the remaining 15 min is the first timeout")
SEC.finding("R-10-d", where="see R-1 (assist `_call_ai_once`, providers `_generate_timeout_safe`)",
            cause="every ChatGPT call of every kind waits the whole timeout + late window; checks that want every AI "
            "(checkpoints, book review, cross-check reviews) wait on it again in each chapter",
            fix="the R-1 fix plus a long failed-slot hold after a TIMEOUT", severity="blocks the book needlessly",
            likely=LIKELY, what="the log's night: ≈ 13 h of timeouts (38 TIMEOUTs), a stop while two AIs worked")
SEC.finding("R-10-e", where="akowe/akowe/clean_run.py `COST` / `_counts` (line ~7–25)", cause="the score counts "
            "stops, fixes, repairs and waits; TIMEOUTs that moved on or were skipped, skipped checks (EDITOR_FAILED, "
            "PLANNED_CHECK_FAILED) and AI_MOVED cost nothing", fix="count TIMEOUTs, failovers and skipped checks "
            "(e.g. 0.5 each) and show the time lost", severity="confusing message", likely=LIKELY,
            what="10/10 “a clean run” after ≈ 2 h of timeouts and two checks skipped in every chapter")
SEC.finding("R-10-f", where="no check: akowe/akowe/names.py / fresh_names.py / the canon checks never look at the "
            "form of a name", cause="a character named by a role and a number (“Crewman Two”) is accepted like any "
            "name", fix="flag names made of a role word + a number word/digit in the canon check and ask the AI for a "
            "real name (fresh_names)", severity="cosmetic", likely=UNLIKELY,
            what="“Crewman Two” reaches the finished book unflagged (the log: two crew members named by number)")
SEC.finding("R-10-g", where="akowe/akowe/providers.py `_with_retries` (UPSTREAM_UNAVAILABLE without site_state is "
            "retried 3× with 1–4 s sleeps) and akowe/akowe/jobs.py `wait_and_retry` (DEFAULT_RETRY 15/30/60/120 s, "
            "max_total 600 s) for checks that want every AI", cause="the bridge's health says the pane is ok, so "
            "Claude stays a “working” AI; checker jobs that ask every working AI wait and retry on it",
            fix="after N failed sends in a row mark the slot down (like site_state broken) until a probe succeeds; "
            "AutoInjector should report pane-broken in /v1/health", severity="blocks the book needlessly",
            likely=LIKELY, what="a pane whose every send fails but whose health reads ok: 15 jobs wait on it (up to "
            "≈ 2.5 h with the real retry policy)")
