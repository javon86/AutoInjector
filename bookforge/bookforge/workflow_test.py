"""🧪 Test workflow: test (and re-test) each part of the book process with the real AI, row by row.

Everything runs in a separate, clearly marked throwaway project ("🧪 Workflow test <date time>", project
setting ``workflow_test: true``) so the author's real books are never touched. The rows drive the same code
the author uses: the guided book path (``BookPath``: premise, plot, outline, chapters, format, assembly,
exports, content check), the review queue (``ReviewService``: approve-all and the AI reviewer) and the AI slots
through ``providers.generate``. Approvals in the test book are made by the test runner because the author pressed
Run (the panel says so); they are labelled that way in the test book's activity log.

AI rows (connection, premise, plot, outline, chapter text, AI review) use the slots that pass the health check
of this run (gated like the self-test). Without a ready AI they are SKIPPED with "connect an AI" guidance and a
fixed test text is used instead (manual candidates, like ``selftest.py``) so the other rows still run.

Every run writes ``<data_dir>/reports/workflow-test-<stamp>.md`` and ``.json``: no keys, no prompts, at most a
short excerpt (80 characters) of an AI answer.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

from . import CONTRACT_VERSION, __version__
from . import h_checks as hc
from .assist import AssistService
from .book_path import BookPath, StepError, save_profile
from .engine import Engine
from .review import ReviewService, WorkTracker
from .selftest import (AI_SETUP_FIX, BUG_FIX, SelfTestProviders, StepFailed, StepSkipped, environment, expect, fact,
                       plan_item, slot_summary)

PASS, FAIL, SKIPPED, NOT_RUN, RUNNING = "PASS", "FAIL", "SKIPPED", "not_run", "running"
EXCERPT = 80
CONNECT_AI = ("Connect an AI to test this row for real: in AutoInjector press Connect (or paste the connection key in "
              "Settings), or add an Anthropic API key in Settings. Then press Re-run.")
TEST_TEXT = ("Mara walked from the harbor to the lighthouse in the fog. The lamp room was cold, and the keeper's "
             "logbook lay open beside a cracked lantern. She read the last line twice.")
PROFILE = {"title": "Workflow test book", "author": "BookForge workflow test", "genre": "Mystery",
           "audience": "Adult", "length": "short_story", "chapters": 1, "tone": "Cozy and warm",
           "idea": "A lighthouse keeper's apprentice searches a foggy harbor for her missing master."}
RELEASE = ["MANUSCRIPT_PDF", "EPUB_REFLOWABLE", "EDITABLE_DOCX"]

ROWS = [
    {"id": "ai", "title": "AI connection", "ai": True, "needs": [],
     "about": "Asks every AI slot you set up whether it is reachable right now. Sends no book content."},
    {"id": "premise", "title": "Premise (B01)", "ai": True, "needs": [],
     "about": "Your AI writes a premise for the test book; the test runner approves it."},
    {"id": "plot", "title": "Main plot (B03)", "ai": True, "needs": ["premise"],
     "about": "Your AI writes the main plot from the premise; the test runner approves it."},
    {"id": "outline", "title": "Chapter outline (B11)", "ai": True, "needs": ["plot"],
     "about": "Your AI plans the chapters (a short test book); the test runner approves the outline."},
    {"id": "chapter", "title": "Chapter context and text (C01/C02)", "ai": True, "needs": ["outline"],
     "about": "BookForge gathers the chapter context (no AI), then your AI writes the first chapter. It stays a "
              "draft for the next rows."},
    {"id": "review", "title": "AI review", "ai": True, "needs": ["chapter"],
     "about": "Your AI reviews the chapter draft and answers APPROVE, REVISE or REJECT with reasons. Auto-approve is "
              "off in the test book, so nothing is approved by this row."},
    {"id": "approvals", "title": "Approvals", "ai": False, "needs": ["chapter"],
     "about": "Approves everything waiting in the test book's review queue with one “approve all” (BookForge adds the "
              "extra approval record a chapter needs), then checks the queue is empty."},
    {"id": "format", "title": "Book format", "ai": False, "needs": [],
     "about": "Makes the page size, font and PDF/EPUB/DOCX settings from the test book's profile and approves them."},
    {"id": "assemble", "title": "Assemble (G)", "ai": False, "needs": ["approvals", "format"],
     "about": "Puts the approved chapters in order, lays out the pages and the contents (G02/G01/G05/G04/G07)."},
    {"id": "export", "title": "Export PDF, EPUB and DOCX (G11/G12/G13)", "ai": False, "needs": ["assemble"],
     "about": "Makes the three files and re-reads each one with BookForge's independent file checkers."},
    {"id": "check", "title": "Content check (H05)", "ai": False, "needs": ["assemble"],
     "about": "Checks that every chapter is in the book exactly once and in order."},
]
ROW_IDS = [r["id"] for r in ROWS]
TITLES = {r["id"]: r["title"] for r in ROWS}


def _iso(dt=None) -> str:
    return (dt or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _excerpt(text) -> str | None:
    if not isinstance(text, str) or not text.strip():
        return None
    t = " ".join(text.split())
    return t[:EXCERPT - 1] + "…" if len(t) > EXCERPT else t


def _steperr(exc: StepError) -> str:
    return (exc.message + (": " + "; ".join(exc.problems[:4]) if exc.problems else ""))[:600]


class WorkflowTestRunner:
    """One run at a time in a background thread; rows keep their last result between runs."""

    def __init__(self, store, providers, principal_id: str, reports_dir=None):
        self.store, self.base_providers, self.principal = store, providers, principal_id
        self.reports_dir = Path(reports_dir) if reports_dir else Path(store.data_dir) / "reports"
        self._lock = threading.Lock()
        self._thread = None
        self._stop = False
        self.current = None
        saved = store.get_setting("workflow_test:state") or {}
        self.project = saved.get("project")
        self.have = dict(saved.get("have") or {})
        self.rows = {r["id"]: dict(self._blank(r), **(saved.get("rows") or {}).get(r["id"], {})) for r in ROWS}
        for r in self.rows.values():
            if r["status"] == RUNNING:
                r["status"] = NOT_RUN
        self.report = saved.get("report")
        self.ai_ready: set = set()
        self.slots_info: list = []
        self.ai_problem = None
        self.engine = None

    @staticmethod
    def _blank(r):
        return {"id": r["id"], "title": r["title"], "about": r["about"], "ai_row": r["ai"], "status": NOT_RUN,
                "detail": "", "fix": None, "elapsed_ms": None, "last_run_at": None, "mode": None, "excerpt": None}

    # ------------------------------------------------------------------ public
    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def status(self) -> dict:
        with self._lock:
            return {"running": self.running, "current": self.current, "stopping": self._stop and self.running,
                    "project": self.project, "rows": [dict(self.rows[i]) for i in ROW_IDS], "report": self.report,
                    "order": ROW_IDS}

    def start(self, body) -> dict | None:
        body = body if isinstance(body, dict) else {}
        rows = body.get("rows", "all")
        fresh = rows == "all" or body.get("fresh") is True
        if rows == "all":
            rows = list(ROW_IDS)
        if not isinstance(rows, list) or not rows or any(r not in ROW_IDS for r in rows):
            from .errors import BookforgeError  # noqa: PLC0415
            raise BookforgeError("INVALID_INPUT", "/rows", "rows must be \"all\" or a list of row IDs: "
                                 + ", ".join(ROW_IDS), status="REJECTED")
        rows = [r for r in ROW_IDS if r in rows]  # always in process order
        with self._lock:
            if self.running:
                return None
            self._stop = False
            for r in rows:
                self.rows[r].update(status=RUNNING if r == rows[0] else self.rows[r]["status"])
            self._thread = threading.Thread(target=self._run, args=(rows, fresh), name="bookforge-workflow-test",
                                            daemon=True)
            self._thread.start()
        return self.status()

    def stop(self) -> dict:
        with self._lock:
            if self.running:
                self._stop = True
        return self.status()

    def wait(self, timeout=None):
        t = self._thread
        if t is not None:
            t.join(timeout)

    def latest_paths(self):
        if not self.report:
            return None
        md, js = self.reports_dir / self.report["markdown"], self.reports_dir / self.report["json"]
        return (md, js) if md.exists() and js.exists() else None

    # ------------------------------------------------------------------ run
    def _save(self):
        try:
            self.store.set_setting("workflow_test:state", {"project": self.project, "have": self.have,
                                                           "rows": self.rows, "report": self.report})
        except Exception:  # noqa: BLE001 - persistence of the panel state is best effort
            pass

    def _run(self, rows, fresh):
        try:
            self.providers = SelfTestProviders(self.base_providers)
            self.engine = Engine(self.store, providers=self.providers)
            self.assist = AssistService(self.engine, self.principal, reports_dir=self.reports_dir)
            self.review = ReviewService(self.engine, self.assist, self.principal, work=WorkTracker())
            started = datetime.now(timezone.utc)
            if fresh or not self._project_ok():
                self._new_project()
            self._health()
            ran = []
            for rid in rows:
                if self._stop:
                    with self._lock:
                        for rest in rows[rows.index(rid):]:
                            if self.rows[rest]["status"] == RUNNING:
                                self.rows[rest]["status"] = NOT_RUN
                            self.rows[rest].update(detail="Stopped before this row ran (you pressed Stop).",
                                                   status=SKIPPED, fix="Press Run or Re-run to try it.",
                                                   last_run_at=_iso())
                    break
                self._run_row(rid)
                ran.append(rid)
            self._write_report(started, rows)
        except Exception as exc:  # noqa: BLE001 - never crash the server
            with self._lock:
                for r in rows:
                    if self.rows[r]["status"] == RUNNING:
                        self.rows[r].update(status=FAIL, detail=f"the test could not run: {type(exc).__name__}: "
                                            f"{str(exc)[:200]}", fix=BUG_FIX)
        finally:
            with self._lock:
                self.current = None
            self._save()
            try:
                self.store.close()
            except Exception:  # noqa: BLE001
                pass

    def _run_row(self, rid):
        spec = next(r for r in ROWS if r["id"] == rid)
        with self._lock:
            self.current = rid
            self.rows[rid].update(status=RUNNING, detail="", fix=None, excerpt=None)
        t0 = time.monotonic()
        res = {"status": PASS, "detail": "", "fix": None, "mode": None, "excerpt": None}
        missing = [n for n in spec["needs"] if not self.have.get(n)]
        if missing:
            res.update(status=SKIPPED, detail="Needs " + ", ".join(f"“{TITLES[n]}”" for n in missing)
                       + " to work first.", fix="Press ▶ Run all, or run the rows above first.")
        else:
            try:
                out = getattr(self, f"row_{rid}")()
                if isinstance(out, tuple):
                    res["detail"], res["excerpt"] = out
                else:
                    res["detail"] = out or "ok"
                res["mode"] = getattr(self, "_mode", None)
            except StepSkipped as exc:
                res.update(status=SKIPPED, detail=exc.detail, fix=exc.fix, mode=getattr(self, "_mode", None))
            except StepFailed as exc:
                res.update(status=FAIL, detail=exc.detail, fix=exc.fix or BUG_FIX, mode=getattr(self, "_mode", None))
            except StepError as exc:
                res.update(status=FAIL, detail=_steperr(exc), fix="Look at the problem above; if it says an earlier step "
                           "changed, press ▶ Run all to start a fresh test book.")
            except Exception as exc:  # noqa: BLE001 - a crash in one row must not stop the run
                tb = traceback.extract_tb(exc.__traceback__)[-1]
                res.update(status=FAIL, detail=f"unexpected error {type(exc).__name__}: {str(exc)[:300]} "
                           f"(at {Path(tb.filename).name}:{tb.lineno})", fix=BUG_FIX)
            finally:
                self.providers.ai_on = False
                self._mode = None
        with self._lock:
            self.rows[rid].update(res, elapsed_ms=int((time.monotonic() - t0) * 1000), last_run_at=_iso())
        self._save()

    # ------------------------------------------------------------------ project
    def _project_ok(self) -> bool:
        pid = (self.project or {}).get("id")
        return bool(pid) and self.store.project(pid) is not None

    def _new_project(self):
        old = [r["project_id"] for r in self.store.query("SELECT project_id, settings FROM projects WHERE archived=0")
               if '"workflow_test": true' in (r["settings"] or "")]
        name = f"🧪 Workflow test {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
        pid = self.engine.bootstrap_project(self.principal, name, settings={"workflow_test": True},
                                            features={"character_arcs": False}, release_profiles=list(RELEASE))
        save_profile(self.store, pid, dict(PROFILE))
        if old:  # keep only the newest test book in the project list
            with self.store.transaction() as tx:
                for o in old:
                    tx.conn.execute("UPDATE projects SET archived=1 WHERE project_id=?", (o,))
        self.project = {"id": pid, "name": name, "created_at": _iso()}
        self.have = {}
        bp = self.bp()
        cand = {"concept": "Harbor town", "attributes": {}, "linked_refs": [], "protected_fact_flags": [],
                "facts": [fact("harbor", "entity.name", "Harbor town")]}
        where, _ = bp.create("A04", {"concept": "Harbor town"}, manual_candidate=cand)
        self._approve(bp, where, "the harbor town")
        cand = {"concept": "Mara Vell", "attributes": {}, "linked_refs": [where], "protected_fact_flags": [],
                "facts": [fact("mara", "entity.name", "Mara Vell"), fact("mara", "entity.location_id", "harbor")]}
        who, _ = bp.create("A01", {"concept": "Mara Vell"}, manual_candidate=cand)
        self._approve(self.bp(), who, "the character Mara Vell")
        self._save()

    def bp(self) -> BookPath:
        bp = BookPath(self.engine, self.principal, self.project["id"], "main")
        # The test book uses exactly the slots that passed this run's health check.
        bp.ai_ready = lambda: bool(self.ai_ready)
        return bp

    def _approve(self, bp, ref, what):
        res = bp.approve_ref(ref)
        expect(res["ok"], f"{what} could not be approved: " + "; ".join(res.get("problems") or [])[:400], BUG_FIX)
        return res

    # ------------------------------------------------------------------ AI gating
    def _health(self):
        ready, info = set(), []
        fake = getattr(self.base_providers, "test_adapter", None) is not None
        for s in self.base_providers.slots():
            item = slot_summary(s)
            adapter = s["adapter_id"]
            if adapter == "none":
                item.update(state="NOT_SET_UP", message="not set up")
            elif adapter == "manual":
                item.update(state="MANUAL", message="manual (you write it yourself; no AI)")
            elif adapter == "autoinjector":
                h = self.base_providers.health_check(s["slot_id"])
                item.update(state="READY" if h.get("ok") else "ERROR", message=h.get("message"), error=h.get("error"))
            elif adapter == "anthropic":
                if fake:
                    item.update(state="READY", message="test adapter")
                elif importlib.util.find_spec("anthropic") is None:
                    item.update(state="ERROR", message="the 'anthropic' package is not installed")
                elif not s.get("has_credentials"):
                    item.update(state="ERROR", message="no API key saved")
                else:
                    item.update(state="READY", message="API key present (the premise row is the real test)")
            if item.get("state") == "READY":
                ready.add(s["slot_id"])
            info.append(item)
        self.ai_ready, self.slots_info = ready, info
        self.providers.ready = ready
        configured = [i for i in info if i["state"] not in ("NOT_SET_UP", "MANUAL")]
        if not configured:
            self.ai_problem = "No AI is connected."
        elif not ready:
            self.ai_problem = "No AI slot is reachable right now (" + "; ".join(
                f"{i['slot_id']}: {i['message']}" for i in configured) + ")."
        else:
            self.ai_problem = None
        # The test book follows the AI choice of this run: manual when no AI is ready.
        try:
            save_profile(self.store, self.project["id"], {"ai_slot": "" if ready else "manual"})
        except Exception:  # noqa: BLE001
            pass

    def _ai(self) -> bool:
        if self.ai_ready:
            self._mode = "AI"
            return True
        self._mode = "MANUAL"
        return False

    def _skip_no_ai(self, what):
        raise StepSkipped(f"{self.ai_problem} {what} A fixed test text was used instead so the next rows can still "
                          "run.", CONNECT_AI)

    def _ai_resource(self, ref):
        row = self.store.query_one("SELECT transform, resource FROM provenance WHERE project_id=? AND record_id=? AND "
                                   "version=?", (ref["project_id"], ref["record_id"], ref["version"]))
        res = json.loads(row["resource"]) if row and row["resource"] else {}
        return (row["transform"] if row else None), res

    def _creative(self, op, what, manual_candidate, have_key):
        """Run one creative book-path step with the AI (or a fixed text), approve it, return the details."""
        bp = self.bp()
        use_ai = self._ai()
        body = {"op": op, "manual": not use_ai}
        t0 = time.monotonic()
        if use_ai:
            self.providers.ai_on = True
        try:
            out = bp.a_create(body)
        finally:
            self.providers.ai_on = False
        if out.get("ok"):
            ref = out["created"]
            transform, res = self._ai_resource(ref)
            rec = self.store.get_record(ref["project_id"], ref["branch_id"], ref["record_id"], ref["version"])
            self._approve(self.bp(), ref, what)
            self.have[have_key] = True
            text = json.dumps(rec.get("data"), ensure_ascii=False)
            excerpt = _excerpt((rec.get("data") or {}).get("premise") or (
                ((rec.get("data") or {}).get("main_plot") or {}).get("summary") if isinstance(
                    (rec.get("data") or {}).get("main_plot"), dict) else None) or _title_of(rec))
            return (f"{res.get('ai_slot') or 'AI'} ({res.get('adapter_id')}, {res.get('model')}) wrote the {what} in "
                    f"{time.monotonic() - t0:.1f} s ({len(text)} characters, sha256 "
                    f"{hashlib.sha256(text.encode()).hexdigest()[:12]}). The test runner approved it.", excerpt)
        if not out.get("needs_manual"):
            raise StepFailed(out.get("message") or f"the {what} was not made", BUG_FIX)
        # AI failed (or no AI): a fixed test text keeps the rest of the book going.
        ref, _ = bp.create(op, out["payload"], manual_candidate=manual_candidate)
        self._approve(self.bp(), ref, what)
        self.have[have_key] = True
        if use_ai:
            raise StepFailed(f"The AI could not write the {what}: " + "; ".join(out.get("problems") or [
                out.get("message") or ""])[:400] + ". A fixed test text was used so the next rows can still run.",
                "Check the AI in Settings (Test connection): is AutoInjector running, the site's pane logged in and idle? "
                "Then press Re-run.")
        self._skip_no_ai(f"The {what} needs an AI to test for real.")

    # ------------------------------------------------------------------ rows
    def row_ai(self):
        lines = [f"{i['slot_id']} ({i['adapter']}{'/' + str(i.get('site')) if i.get('site') else ''}): "
                 f"{i['state']} — {i['message']}" for i in self.slots_info]
        if not self.ai_ready:
            configured = [i for i in self.slots_info if i["state"] not in ("NOT_SET_UP", "MANUAL")]
            if not configured:
                raise StepSkipped("No AI is connected, so nothing was sent anywhere. " + " · ".join(lines), CONNECT_AI)
            raise StepFailed("No AI slot answered: " + " · ".join(lines),
                             "Start the AutoInjector desktop app, open and log in to the site's pane, then press Test "
                             "connection in Settings (or press Connect in AutoInjector again). " + AI_SETUP_FIX)
        self._mode = "AI"
        return f"{len(self.ai_ready)} AI slot(s) ready: " + " · ".join(lines)

    def row_premise(self):
        return self._creative("B01", "premise", {
            "premise": "A lighthouse keeper's apprentice searches a foggy harbor for her missing master.",
            "dramatic_question": "Will Mara find the keeper before the winter ferry stops?",
            "concept_summary": "A quiet coastal mystery (workflow test)."}, "premise")

    def row_plot(self):
        return self._creative("B03", "main plot", {
            "main_plot": {"summary": "Mara follows the keeper's trail from the harbor to the lighthouse.", "facts": [],
                          "links": []}, "objectives": [], "plot_obligations": []}, "plot")

    def row_outline(self):
        out = self._creative("B11", "chapter outline", {
            "chapters": [plan_item("ch1", 0, "Mara reaches the lighthouse")], "unresolved_threads": []}, "outline")
        n = len(self.bp().outline_chapters(self.bp().outline()))
        expect(n >= 1, "the approved outline has no chapters BookForge can write", BUG_FIX)
        if isinstance(out, tuple):
            return out[0] + f" It has {n} chapter(s).", out[1]
        return out

    def row_chapter(self):
        bp = self.bp()
        outline = bp.outline()
        expect(outline is not None, "no approved chapter outline", BUG_FIX)
        chapters = bp.outline_chapters(outline)
        use_ai = self._ai()
        notes, excerpt, ai_fail = [], None, None
        for i, ch in enumerate(chapters):
            bp = self.bp()
            _ctx, latest, appr = bp.chapter_prose(outline, ch["chapter_id"])
            if appr or (latest and latest["lifecycle"] in ("DRAFT", "VALIDATED") and not latest.get("stale")):
                continue
            first = i == 0 and use_ai
            if first:
                self.providers.ai_on = True
            t0 = time.monotonic()
            try:
                out = bp.a_write_chapter({"chapter_id": ch["chapter_id"], "manual": not first})
            finally:
                self.providers.ai_on = False
            if out.get("ok"):
                ref = out["created"]
                rec = self.store.get_record(ref["project_id"], ref["branch_id"], ref["record_id"], ref["version"])
                _t, res = self._ai_resource(ref)
                text = (rec.get("data") or {}).get("text") or ""
                excerpt = _excerpt(text)
                notes.append(f"{ch['chapter_id']}: {res.get('ai_slot') or 'AI'} wrote {len(text)} characters in "
                             f"{time.monotonic() - t0:.1f} s")
                continue
            expect(out.get("needs_manual"), out.get("message") or "the chapter was not started", BUG_FIX)
            if first:
                ai_fail = "; ".join(out.get("problems") or [out.get("message") or ""])[:300]
            r = bp.dispatch("C02", "CREATE", payload=out["payload"],
                            manual_candidate={"text": TEST_TEXT, "candidate_events": [], "findings": []})
            expect(r["status"] == "DRAFT", f"chapter {ch['chapter_id']} could not be stored ({r['status']})", BUG_FIX)
            notes.append(f"{ch['chapter_id']}: fixed test text")
        st = {s["id"]: s for s in self.bp().status()["steps"]}["chapters"]
        expect(all(c.get("context_id") for c in st["chapters"]), "a chapter has no context (C01)", BUG_FIX)
        self.have["chapter"] = True
        summary = (f"Context (C01) made for {len(st['chapters'])} chapter(s); " + ("; ".join(notes) or "already written")
                   + ". The chapters stay drafts for the Approvals row.")
        if ai_fail:
            raise StepFailed(f"The AI could not write the chapter: {ai_fail}. " + summary,
                             "Check the AI in Settings (Test connection), then press Re-run.")
        if not use_ai:
            self._skip_no_ai(summary + " The chapter text needs an AI to test for real.")
        return summary, excerpt

    def row_review(self):
        if not self._ai():
            raise StepSkipped(f"{self.ai_problem} The AI review needs an AI.", CONNECT_AI)
        q = self.review.queue(self.principal, self.project["id"], "main")
        item = next((i for i in q["items"] if i["module_id"] == "C02"), None) or (q["items"][0] if q["items"] else None)
        if item is None:
            raise StepSkipped("Nothing is waiting for approval in the test book, so there is nothing to review.",
                              "Press ▶ Run all to start a fresh test book.")
        self.providers.ai_on = True
        try:
            res = self.review.review_sync(self.principal, self.project["id"], "main", item["record_id"])
        except Exception as exc:  # noqa: BLE001 - shown as a failed row
            from .errors import BookforgeError  # noqa: PLC0415
            if isinstance(exc, BookforgeError):
                raise StepFailed(f"The AI review did not work: {exc.code}: {exc.errors[0].get('message')}",
                                 "Check the AI in Settings (Test connection), then press Re-run.") from None
            raise
        finally:
            self.providers.ai_on = False
        rv = res["review"]
        expect(not res.get("auto_approved"), "the draft was approved automatically although auto-approve is off", BUG_FIX)
        conf = f", confidence {rv['confidence']:.2f}" if isinstance(rv.get("confidence"), float) else ""
        return (f"{res.get('slot')} ({res.get('slot_label')}) reviewed “{item['short_title']}” in "
                f"{res['elapsed_ms'] / 1000:.1f} s and said {rv['verdict']}{conf} with {len(rv['reasons'])} reason(s). "
                "Nothing was approved (auto-approve is off in the test book).",
                _excerpt(rv["reasons"][0]) if rv["reasons"] else None)

    def row_approvals(self):
        pid = self.project["id"]
        q = self.review.queue(self.principal, pid, "main")
        if not q["items"]:
            st = {s["id"]: s for s in self.bp().status()["steps"]}
            expect(st["chapters"]["state"] == "done", "nothing is waiting, but the chapters are not approved", BUG_FIX)
            self.have["approvals"] = True
            return "Nothing was waiting for approval (the chapters are already approved)."
        k09 = len(self.store.list_records(pid, "main", module_id="K09"))
        ids = [i["record_id"] for i in q["items"]]
        out = self.review.approve(self.principal, pid, "main", {"record_ids": ids, "author_confirms": True,
                                                                 "how": "workflow_test",
                                                                 "versions": {i["record_id"]: i["version"]
                                                                              for i in q["items"]}})
        bad = [f"{r['record_id']}: {r['message']}" for r in out["results"] if not r.get("ok")]
        expect(not bad, "some drafts could not be approved: " + "; ".join(bad)[:500],
               "Open the test book's review queue to see why; if it says something changed, press ▶ Run all.")
        left = {i["record_id"] for i in self.review.queue(self.principal, pid, "main")["items"]}
        expect(not (left & set(ids)), "approved drafts are still listed in the review queue", BUG_FIX)
        k09_new = len(self.store.list_records(pid, "main", module_id="K09")) - k09
        self.have["approvals"] = True
        return (f"Approved {out['approved']} draft(s) with one “approve all” ({', '.join(sorted({i['module_id'] for i in q['items']}))}); "
                f"BookForge recorded {k09_new} extra approval record(s) (K09) for drafts that need one. The queue is "
                "empty now.")

    def _approve_step(self, step_id):
        st = {s["id"]: s for s in self.bp().status()["steps"]}[step_id]
        ids = [i["record_id"] for i in st.get("approve") or []]
        if ids:
            out = self.review.approve(self.principal, self.project["id"], "main",
                                      {"record_ids": ids, "author_confirms": True, "how": "workflow_test"})
            bad = [f"{r['record_id']}: {r['message']}" for r in out["results"] if not r.get("ok")]
            expect(not bad, "could not approve: " + "; ".join(bad)[:500], BUG_FIX)
        return len(ids)

    def row_format(self):
        out = self.bp().a_setup_format({})
        expect(out.get("ok"), out.get("message") or "the book format was not made", BUG_FIX)
        n = self._approve_step("format")
        st = {s["id"]: s for s in self.bp().status()["steps"]}["format"]
        expect(st["state"] == "done", f"the book format is '{st['state']}' after approving it", BUG_FIX)
        self.have["format"] = True
        return f"{n} format settings made from the test book's profile (6 x 9 inch, Times 11 pt) and approved."

    def row_assemble(self):
        out = self.bp().a_assemble({})
        expect(out.get("ok"), out.get("message") or "the book was not put together", BUG_FIX)
        n = self._approve_step("assemble")
        st = {s["id"]: s for s in self.bp().status()["steps"]}["assemble"]
        expect(st["state"] == "done", f"the assembly is '{st['state']}' after approving it", BUG_FIX)
        self.have["assemble"] = True
        return out["message"] + f" {n} assembly records approved."

    def row_export(self):
        out = self.bp().a_export({})
        expect(out.get("ok") and not out.get("problems"), (out.get("message") or "export failed") + " "
               + "; ".join(out.get("problems") or [])[:400], BUG_FIX)
        st = {s["id"]: s for s in self.bp().status()["steps"]}["export"]
        lines = []
        for f in st.get("files") or []:
            rec = self.store.get_record(self.project["id"], "main", f["record_id"], f["version"])
            data = self.store.read_binary(rec)
            if f["format"] == "PDF":
                doc, issues = hc.pdf_structure(data)
                ok = doc is not None
            elif f["format"] == "EPUB":
                issues, _info = hc.epub_check(data, run_external=False)
                ok = True
            else:
                issues, _info = hc.docx_check(data)
                ok = True
            bad = [i["message"] for i in issues if i.get("decision") == "FAIL" and i.get("severity") in ("BLOCKING", "MAJOR")]
            expect(ok and not bad, f"the {f['format']} file does not read back: " + "; ".join(bad)[:300], BUG_FIX)
            lines.append(f"{f['format']} {len(data)} bytes (sha256 {hashlib.sha256(data).hexdigest()[:12]})")
        expect(len(lines) == 3, f"expected PDF, EPUB and DOCX, got {len(lines)} file(s)", BUG_FIX)
        self.have["export"] = True
        return "Made and re-read: " + "; ".join(lines) + "."

    def row_check(self):
        out = self.bp().a_check({})
        expect(out.get("ok"), (out.get("message") or "check failed") + " " + "; ".join(out.get("problems") or [])[:300],
               BUG_FIX)
        self.have["check"] = True
        return out["message"] + " Every chapter is in the book once and in order."

    # ------------------------------------------------------------------ report
    def _write_report(self, started, rows_run):
        rows = [dict(self.rows[i]) for i in ROW_IDS]
        counts = {k: sum(1 for r in rows if r["status"] == k) for k in (PASS, FAIL, SKIPPED, NOT_RUN)}
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        rep = {"report_kind": "bookforge-workflow-test", "report_version": 1,
               "verdict": "FAIL" if counts[FAIL] else "PASS", "counts": counts,
               "started_at": _iso(started), "finished_at": _iso(), "rows_run": rows_run,
               "project": self.project, "bookforge_version": __version__, "contract_version": CONTRACT_VERSION,
               "ai_slots": self.slots_info, "ai_ready": sorted(self.ai_ready), "environment": environment(self.store),
               "rows": rows, "stamp": stamp,
               "note": "No keys, connection keys or prompts are written here; AI answers appear only as excerpts of at "
                       f"most {EXCERPT} characters."}
        self.reports_dir.mkdir(parents=True, exist_ok=True)
        base, n = f"workflow-test-{stamp}", 1
        while (self.reports_dir / f"{base}.json").exists():
            n += 1
            base = f"workflow-test-{stamp}-{n}"
        md, js = self.reports_dir / f"{base}.md", self.reports_dir / f"{base}.json"
        rep["files"] = {"markdown": md.name, "json": js.name}
        js.write_text(json.dumps(rep, indent=2, ensure_ascii=False), encoding="utf-8")
        md.write_text(render_markdown(rep), encoding="utf-8")
        with self._lock:
            self.report = dict(rep["files"], verdict=rep["verdict"], counts=counts, finished_at=rep["finished_at"])
        return rep


def _title_of(rec) -> str | None:
    d = rec.get("data") or {}
    return d.get("summary") if isinstance(d.get("summary"), str) else None


ICON = {PASS: "PASS ✔", FAIL: "FAIL ✕", SKIPPED: "SKIPPED –", NOT_RUN: "not run", RUNNING: "running"}


def _cell(v) -> str:
    return str(v if v is not None else "").replace("|", "\\|").replace("\n", " ")


def render_markdown(rep: dict) -> str:
    c = rep["counts"]
    p = rep.get("project") or {}
    L = [f"# BookForge workflow test — {rep['verdict']}", "",
         f"- **Date:** {rep['started_at']} (finished {rep['finished_at']})",
         f"- **Result:** {c[PASS]} passed, {c[FAIL]} failed, {c[SKIPPED]} skipped, {c[NOT_RUN]} not run",
         f"- **Rows in this run:** {', '.join(TITLES[r] for r in rep['rows_run'])}",
         f"- **Test book:** {p.get('name')} (`{p.get('id')}`) — a separate project; your books were not touched",
         f"- **BookForge:** {rep['bookforge_version']} · contract {rep['contract_version']}",
         "- Approvals in the test book were made by the test runner because you pressed Run.", "",
         "## AI slots (no keys are ever written here)", "",
         "| Slot | Adapter | Site / model | State | Message |", "|---|---|---|---|---|"]
    for s in rep["ai_slots"]:
        L.append(f"| {s['slot_id']} | {s['adapter']} | {_cell(s.get('site') or s.get('model') or '')} | "
                 f"{_cell(s.get('state'))} | {_cell(s.get('message'))} |")
    L += ["", "## Rows", "", "| Row | Result | Time | Last run |", "|---|---|---|---|"]
    for r in rep["rows"]:
        t = f"{r['elapsed_ms']} ms" if r.get("elapsed_ms") is not None else ""
        L.append(f"| {_cell(r['title'])} | {ICON.get(r['status'], r['status'])} | {t} | {_cell(r.get('last_run_at'))} |")
    L += ["", "## Details", ""]
    for r in rep["rows"]:
        L += [f"### {r['title']}: {ICON.get(r['status'], r['status'])}", "", f"*What it checks:* {r['about']}", ""]
        if r.get("detail"):
            L.append(f"- **What happened:** {r['detail']}")
        if r.get("mode"):
            L.append(f"- **Mode:** {'your AI' if r['mode'] == 'AI' else 'fixed test text (no AI)'}")
        if r.get("excerpt"):
            L.append(f"- **Short excerpt:** “{r['excerpt']}”")
        if r.get("fix") and r["status"] != PASS:
            L.append(f"- **What to do:** {r['fix']}")
        L.append("")
    L += [f"- {rep['note']}", ""]
    return "\n".join(L)
