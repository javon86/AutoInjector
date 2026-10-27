"""Local HTTP server: JSON API + the browser workspace (stdlib only).

Security defaults: binds 127.0.0.1, requires a bearer token (printed at startup and
passed to the browser in the URL fragment), enforces project/branch access on every
read including asset bytes, and never logs manuscript content.
"""
from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import os
import re
import secrets
import sys
import threading
import time
import traceback
import webbrowser
from contextlib import contextmanager
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import CLOSURE_REVISION, CONTRACT_VERSION, __version__
from . import ai_check, calibration, diagnostics, journal, legacy
from .assist import AssistService, supports as assist_supports
from .autobook import AutoBookService, WriteAllService
from .backups import BackupManager
from .canonical import sha256_bytes
from .engine import Engine
from .errors import AkoweError, error
from .health import HealthService
from .jobs import JobStore, clean_retry_settings, DEFAULT_RETRY
from .requests import build_request
from .selftest import SelfTestRunner
from .sets_guide import sets_overview
from .book_path import BookPath, clean_profile, get_profile, save_profile
from . import protagonist
from .review import ReviewService, WorkTracker
from .shelf import shelf as shelf_page
from .book_report import ReportService
from .book_save import SaveService
from .book_open import OpenService
from .compare import CompareService
from .status_push import StatusPusher
from .store import Store, new_id, utcnow, write_private
from .workflow_test import WorkflowTestRunner

log = logging.getLogger("akowe.server")
# 8765 is taken by AutoInjector's extension bridge (server/fake_api_server.py), so Akọwe uses 8780.
DEFAULT_PORT = 8780
WEB_DIR = Path(__file__).resolve().parent / "web"
MAX_BODY = 64 * 1024 * 1024
MAX_JSON_DEPTH = 200  # deeper request JSON is refused before parsing (Python's parser would hit RecursionError)
VERSION_RE = re.compile(r"[0-9]{1,15}")  # ASCII digits only ('²'.isdigit() is True) and small enough for SQLite
# Requests that do not count as "a writer" for the restore/delete gate (they take the exclusive gate themselves or
# only make backups, which BackupManager serialises).
EXCLUSIVE_ROUTES = (("backups",),)


class _NoNaN(ValueError):
    pass


def _reject_constant(name):
    raise _NoNaN(name)


def _too_deep(raw: bytes, limit: int = MAX_JSON_DEPTH) -> bool:
    """True when JSON nests deeper than ``limit`` (brackets inside strings are skipped)."""
    if raw.count(b"[") + raw.count(b"{") <= limit:
        return False  # cannot be that deep: skip the byte-by-byte scan
    depth = 0
    in_str = esc = False
    for b in raw:
        if in_str:
            if esc:
                esc = False
            elif b == 0x5c:
                esc = True
            elif b == 0x22:
                in_str = False
        elif b == 0x22:
            in_str = True
        elif b in (0x5b, 0x7b):
            depth += 1
            if depth > limit:
                return True
        elif b in (0x5d, 0x7d):
            depth -= 1
    return False


def parse_json_body(raw: bytes):
    """Request JSON: strict (no NaN/Infinity, which browsers cannot read back), bounded depth, clean 400s."""
    if _too_deep(raw):
        raise ApiError(400, "INVALID_INPUT", "/body", f"the JSON is nested too deeply (more than {MAX_JSON_DEPTH} "
                       "levels)")
    try:
        return json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
    except _NoNaN as exc:
        raise ApiError(400, "INVALID_INPUT", "/body", f"invalid JSON: {exc} is not allowed (use a number or null)")
    except (ValueError, RecursionError):
        raise ApiError(400, "INVALID_INPUT", "/body", "invalid JSON")


def need_object(body, path: str = "/body") -> dict:
    if not isinstance(body, dict):
        raise ApiError(400, "INVALID_INPUT", path, "the request body must be a JSON object")
    return body


def need_str(body: dict, key: str, path: str | None = None, required: bool = False) -> str | None:
    v = body.get(key)
    if v is None and not required:
        return None
    if not isinstance(v, str):
        raise ApiError(400, "INVALID_INPUT", path or f"/{key}", f"{key} must be text")
    return v


class ApiError(Exception):
    def __init__(self, status: int, code: str, path: str = "", message: str = ""):
        super().__init__(message or code)
        self.status = status
        self.body = {"errors": [error(code, path, message or None)]}


class App:
    """Holds engine/store and implements API routes independent of the HTTP plumbing."""

    def __init__(self, data_dir: str | os.PathLike, token: str | None = None, principal_id: str = "author"):
        self.store = Store(data_dir)
        self.engine = Engine(self.store)
        self.principal_id = principal_id
        self.token = token or self._load_or_create_token(Path(data_dir))
        with self.store.transaction() as tx:
            tx.ensure_principal(principal_id, "Author", sha256_bytes(self.token.encode()))
        self.started = time.monotonic()
        self.selftest = SelfTestRunner(self.store, self.engine.providers, principal_id)
        # S11: background work survives restarts; anything that was running is now "interrupted - Resume".
        self.jobstore = JobStore(self.store)
        self.interrupted = self.jobstore.mark_interrupted()
        self.errors = diagnostics.ErrorLog()
        self.assist = AssistService(self.engine, principal_id, retry_busy=True, jobstore=self.jobstore)
        self.work = WorkTracker()
        self.review = ReviewService(self.engine, self.assist, principal_id, work=self.work, on_change=self.changed)
        self.workflow = WorkflowTestRunner(self.store, self.engine.providers, principal_id)
        self.pusher = StatusPusher(self)
        self.work.on_change = self.changed
        # Writers vs. restore/delete: every request that changes data (and every book step) holds a writer slot;
        # a restore or a book deletion takes the gate exclusively, so neither can start while the other runs.
        self._gate = threading.Lock()
        self._writers = 0
        self._exclusive: str | None = None
        self.backups = BackupManager(self.store, busy=self._restore_busy, exclusive=self.exclusive,
                                     after_restore=self._after_restore)
        self.autobook = AutoBookService(self)
        self.write_all = WriteAllService(self)
        self.ai_check_timeout_s = 45.0  # P37.5 🔁 check again: wait at most this long for the AIs' check-ins
        self.reports = ReportService(self)     # 📊 P13 book reports + whole-book AI reviews
        self.compare = CompareService(self)    # ⚖️ P14 blind comparisons
        self.health = HealthService(self)
        self.backups.on_restored.append(self.health.forget)  # a restored database must be checked afresh
        self.saver = SaveService(self)         # 💾 P20 one folder per book in the books folder
        self.opener = OpenService(self)        # 📂 P21 open a saved book / 🔁 rerun from its book bible
        from .forge import ForgeService  # noqa: PLC0415
        self.forge = ForgeService(self)        # 🗂 B5 Character Forge dossiers (jobs run in self.review)
        from .cover import CoverService  # noqa: PLC0415
        self.cover = CoverService(self)        # 🎨 B3 book covers (art jobs run in self.review)
        self._client = threading.local()       # the address of the request being answered (localhost-only routes)
        self.port: int | None = None
        self._last_project: dict | None = None
        if self.interrupted:  # runs that were working when Akọwe stopped: save how far they got
            threading.Thread(target=self.saver.after_start, name="akowe-save-interrupted", daemon=True).start()

    # ------------------------------------------------------------------ 💾/📂 which computer asks
    def set_client(self, host: str | None):
        self._client.host = host

    def is_local(self) -> bool:
        """True when the request being answered comes from this computer (or is an in-process call). Opening folders
        in the file manager and listing the books folder are only for the computer Akọwe runs on."""
        host = getattr(self._client, "host", None)
        if host is None:
            return True
        h = str(host).lower()
        if h.startswith("::ffff:"):
            h = h[7:]
        return h == "::1" or h == "localhost" or h.startswith("127.")

    # ------------------------------------------------------------------ AutoInjector status link
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port or DEFAULT_PORT}/"

    def changed(self):
        """Something the status summary shows may have changed: let the status pusher look now."""
        self.pusher.wake()

    def is_test_project(self, pid: str) -> bool:
        p = self.store.project(pid)
        if p is None:
            return False
        try:
            settings = json.loads(p["settings"] or "{}")
        except ValueError:
            return False
        return isinstance(settings, dict) and bool(settings.get("workflow_test") or settings.get("selftest"))

    def touch_project(self, pid: str, branch: str):
        """Remember the most recently opened real book (for the AutoInjector status summary)."""
        cur = self._last_project
        if cur and cur["project_id"] == pid and cur["branch_id"] == branch:
            return
        if self.store.project(pid) is None or self.is_test_project(pid):
            return
        self._last_project = {"project_id": pid, "branch_id": branch}
        try:
            self.store.set_setting("last_project", dict(self._last_project, at=utcnow()))
        except Exception:  # noqa: BLE001 - a hint, never a reason to fail the request
            pass
        self.changed()

    def last_project(self) -> dict | None:
        cur = self._last_project or self.store.get_setting("last_project")
        if cur and self.store.project(cur.get("project_id") or "") is not None and \
                not self.is_test_project(cur["project_id"]):
            return cur
        rows = [r for r in self.store.projects_for(self.principal_id) if not self.is_test_project(r["project_id"])]
        return {"project_id": rows[-1]["project_id"], "branch_id": "main"} if rows else None

    def _after_restore(self, name: str):
        """A backup taken while a run was working stores that run as running: nothing runs it now, so it becomes
        "interrupted - Resume" (as after a restart), and the run caches forget the pre-restore state."""
        alive = set()
        for svc in (self.autobook, self.write_all):
            with svc._lock:
                for rid in list(svc._cache):
                    if svc.alive(rid):
                        alive.add(rid)
                    else:
                        svc._cache.pop(rid, None)
        n = self.jobstore.mark_interrupted(
            "Interrupted — your books were restored from a backup made while this was running. Press Resume to "
            "continue from the restored book.", keep=alive)
        if n:
            log.info("after restoring %s: %d job(s) from the backup marked interrupted", name, n)
        self.changed()

    def _restore_busy(self) -> str | None:
        """Why a restore (or deleting a book) must wait: any run, test, book step, AI job or other write."""
        if self.autobook.active():
            return "the Make-a-book run"
        if self.write_all.active():
            return "Write all chapters"
        if self.selftest.running:
            return "Test everything"
        if self.workflow.running:
            return "the workflow test"
        cur = self.work.current(None)
        if cur:
            return f"“{cur['title']}”"
        if any(not j.finished for j in list(self.assist._jobs.values())):
            return "the AI fill (Fill with AI)"
        if any(not j.finished for j in list(self.review._jobs.values())):
            return "the AI review / fix"
        if any(s.busy() for s in list(self.assist._sessions.values())):
            return "the Bible Builder"
        with self._gate:
            if self._writers:
                return "the change that is being saved right now"
        return None

    @contextmanager
    def writer(self):
        """Hold a writer slot; refused (409) while a restore or a book deletion runs."""
        with self._gate:
            if self._exclusive:
                raise ApiError(409, "VERSION_CONFLICT", "", f"{self._exclusive} is running right now; try again in "
                               "a moment")
            self._writers += 1
        try:
            yield
        finally:
            with self._gate:
                self._writers -= 1

    @contextmanager
    def exclusive(self, what: str = "a restore"):
        """No new writer may start while this is held (the caller then checks _restore_busy for running ones)."""
        with self._gate:
            if self._exclusive:
                raise AkoweError("VERSION_CONFLICT", "", f"{self._exclusive} is already running; wait for it",
                                     status="REJECTED")
            self._exclusive = what
        try:
            yield
        finally:
            with self._gate:
                self._exclusive = None

    def ping(self, challenge: str | None = None) -> dict:
        """Unauthenticated liveness answer for AutoInjector: identity and versions only, no project data.

        BF-08: with ?challenge=<16..64 hex chars> it also returns proof = HMAC-SHA256(access token, challenge),
        so a second Akọwe start can tell "my own data folder is already running here" without ever sending
        the token to whatever answers on the port (the answer can't be faked or replayed without the token)."""
        out = {"app": "akowe", "version": __version__, "contract_version": CONTRACT_VERSION}
        if isinstance(challenge, str) and PING_CHALLENGE_RE.match(challenge):
            out["proof"] = ping_proof(self.token, challenge)
        return out

    @staticmethod
    def _load_or_create_token(data_dir: Path) -> str:
        p = data_dir / "local_token"
        try:
            tok = p.read_text().strip()
            if tok:
                return tok
        except OSError:
            pass
        tok = secrets.token_urlsafe(24)
        write_private(p, tok.encode())  # mode 0600 from the first byte
        return tok

    def authenticate(self, header: str | None) -> str:
        if not header or not header.startswith("Bearer "):
            raise ApiError(401, "PERMISSION_DENIED", "", "missing bearer token")
        digest = sha256_bytes(header[7:].strip().encode())
        row = self.store.query_one("SELECT principal_id FROM principals WHERE token_sha256=?", (digest,))
        if not row:
            raise ApiError(401, "PERMISSION_DENIED", "", "invalid token")
        return row["principal_id"]

    # ------------------------------------------------------------------ helpers
    def _require_access(self, principal: str, pid: str, branch: str | None = None):
        if not self.store.has_project_access(principal, pid, branch):
            raise ApiError(403, "PERMISSION_DENIED", "/project_id", "no access")
        if self.store.project(pid) is None:
            raise ApiError(404, "NOT_FOUND", "/project_id", "project not found")
        if branch is not None and not self.store.branch_exists(pid, branch):
            raise ApiError(404, "NOT_FOUND", "/branch_id", "branch not found")

    @staticmethod
    def record_summary(rec: dict) -> dict:
        data = rec.get("data") or {}
        title = None
        for k in ("concept", "premise", "project_name", "style_name", "title", "chapter_id", "scene_id",
                  "entity_id", "schema_id", "canon_id", "operation", "kind", "style_goal"):
            v = data.get(k) if isinstance(data, dict) else None
            if isinstance(v, str) and v:
                title = v
                break
        if title is None and isinstance(data, dict) and isinstance(data.get("text"), str):
            title = data["text"][:80]
        return {"record_id": rec["record_id"], "version": rec["version"], "module_id": rec["module_id"],
                "record_kind": rec["record_kind"], "representation": rec["representation"],
                "lifecycle": rec["lifecycle"], "stale": rec["stale"], "stale_reason": rec["stale_reason"],
                "approved_version": rec["approved_version"], "latest_version": rec["latest_version"],
                "created_at": rec["created_at"], "title": (title or rec.get("label") or rec["record_id"])[:160],
                "ref": rec["ref"], "approved_ref": rec.get("approved_ref"),
                "mime_type": (rec.get("binary") or {}).get("mime_type")}

    # ------------------------------------------------------------------ routes
    def route(self, method: str, path: str, query: dict, body, principal: str, headers) -> tuple[int, object]:
        parts = [unquote(p) for p in path.strip("/").split("/")][1:]  # drop 'api'
        if method == "GET" or tuple(parts[:1]) in EXCLUSIVE_ROUTES or \
                (len(parts) == 3 and parts[0] == "projects" and parts[2] == "delete"):
            return self._route(method, parts, path, query, body, principal, headers)
        with self.writer():
            return self._route(method, parts, path, query, body, principal, headers)

    def _route(self, method: str, parts: list, path: str, query: dict, body, principal: str,
               headers) -> tuple[int, object]:
        if parts == ["session"] and method == "GET":
            return 200, {"principal_id": principal, "contract_version": CONTRACT_VERSION,
                         "closure_revision": CLOSURE_REVISION, "app_version": __version__,
                         "package_sha256": self.engine.contracts.package_sha256}
        if parts == ["operations"] and method == "GET":
            return 200, self.operations()
        if parts == ["sets"] and method == "GET":
            return 200, self.sets(principal, query)
        if len(parts) == 3 and parts[0] == "operations" and parts[2] == "schema" and method == "GET":
            return 200, self.operation_schema(parts[1])
        if parts == ["slots"] and method == "GET":
            return 200, self.engine.providers.slots()
        if parts == ["slots", "connect-autoinjector"] and method == "POST":
            body = body if isinstance(body, dict) else {}
            out = self.engine.providers.connect_autoinjector(body.get("token"), body.get("bridge_url"))
            self.changed()
            return 200, out
        if parts == ["slots", "pair-autoinjector"] and method == "POST":
            return 200, self.pair_autoinjector(body if isinstance(body, dict) else {})
        if len(parts) == 2 and parts[0] == "slots" and method == "PUT":
            return 200, self.engine.providers.configure_slot(parts[1], body or {})
        if parts == ["slots", "states"] and method == "GET":
            # Which AIs work right now (bridge v1.2 state, cached 15 s): {slots: [{slot_id, name, state, word, ...}]}
            prov = self.engine.providers
            return 200, {"slots": [prov.slot_status(s) for s in prov.ai_slots()]}
        if parts == ["ai-check"] and method in ("GET", "POST"):
            # P37.5 before a run: which AIs work, and for each one that does not: what is wrong and how to fix it.
            # POST {probe: true} first asks AutoInjector to check in with each AI ("🔁 I fixed it — check again").
            body = body if isinstance(body, dict) else {}
            pinned = body.get("slot_id") if method == "POST" else (query.get("slot_id") or [None])[0]
            probe = body.get("probe", False) if method == "POST" else False
            if not isinstance(probe, bool):
                raise ApiError(400, "INVALID_INPUT", "/probe", "probe must be true or false")
            return 200, ai_check.check(self.engine.providers, pinned=AssistService._check_slot(pinned), probe=probe,
                                       timeout_s=self.ai_check_timeout_s)
        if parts == ["estimate"] and method == "POST":  # ⏱ P28: AI calls and minutes before a run starts
            from . import costs as costs_mod  # noqa: PLC0415
            return 200, costs_mod.estimate(self, body if isinstance(body, dict) else {})
        if parts == ["reviewer-leniency"] and method == "GET":
            # P36: how generous each AI reviewer has been (numbers only) and the calibration rules
            return 200, {"ais": calibration.table(self.store), "rules": calibration.RULES}
        if len(parts) == 3 and parts[0] == "slots" and parts[2] == "health" and method == "GET":
            return 200, self.engine.providers.health_check(parts[1])
        if parts == ["selftest"] and method == "POST":
            use_ai = (body or {}).get("use_ai", False) if isinstance(body, dict) else False
            if not isinstance(use_ai, bool):
                raise ApiError(400, "INVALID_INPUT", "/use_ai", "use_ai must be true or false")
            started = self.selftest.start(use_ai)
            if started is None:
                raise ApiError(409, "VERSION_CONFLICT", "/selftest", "a self-test is already running; wait for it "
                               "to finish")
            return 202, started
        if parts == ["selftest"] and method == "GET":
            return 200, self.selftest.status()
        if parts == ["selftest", "report"] and method == "GET":
            fmt = (query.get("format") or ["md"])[0]
            if fmt not in ("md", "json"):
                raise ApiError(400, "INVALID_INPUT", "/format", "format must be md or json")
            paths = self.selftest.latest_paths()
            if not paths:
                raise ApiError(404, "NOT_FOUND", "/selftest/report", "no self-test report yet; run Test everything")
            path = paths[0] if fmt == "md" else paths[1]
            mime = "text/markdown; charset=utf-8" if fmt == "md" else "application/json; charset=utf-8"
            disposition = "attachment" if (query.get("download") or ["0"])[0] == "1" else "inline"
            return 200, ("__binary__", mime, path.read_bytes(), path.name, disposition)
        if parts and parts[0] == "workflow-test":
            return self.route_workflow(method, parts, query, body)
        if parts and parts[0] in ("books", "books-folder") or parts[:2] == ["settings", "books-folder"]:
            return self.route_books(method, parts, query, body, principal, headers)
        if parts == ["settings", "image-bridge"] and method in ("GET", "PUT"):  # 🗂 B5: where AutoInjector makes pictures
            from . import forge  # noqa: PLC0415
            return 200, forge.bridge_info(self) if method == "GET" else forge.save_bridge_settings(self, body)
        if parts and parts[0] in ("autobook", "jobs", "health", "diagnostics", "backups", "shelf", "settings",
                                  "story-choices", "lengths", "pipeline", "compare"):
            return self.route_ops(method, parts, query, body, principal)
        if parts and parts[0] in ("assist", "bible-builder"):
            return self.route_ai(method, parts, query, body, principal)
        if parts and parts[0] == "style-card":  # ✒️ P25 (Section 7c) the author's writing style
            from . import style_card  # noqa: PLC0415
            return style_card.route(self, method, parts, body, principal)
        if parts == ["projects"] and method == "GET":
            if (query.get("archived") or ["0"])[0] in ("1", "true", "yes"):
                return 200, [dict(self.project_summary(principal, r["project_id"]), archived=True)
                             for r in self.archived_projects(principal)]
            return 200, [self.project_summary(principal, r["project_id"]) for r in self.store.projects_for(principal)]
        if parts == ["projects"] and method == "POST":
            return 201, self.create_project(principal, need_object({} if body is None else body))
        if parts == ["dispatch"] and method == "POST":
            return 200, self.dispatch(principal, need_object({} if body is None else body))
        if len(parts) >= 2 and parts[0] == "projects":
            pid = parts[1]
            if len(parts) == 2 and method == "GET":
                branch = (query.get("branch") or ["main"])[0]
                self._require_access(principal, pid, branch)
                return 200, self.project_summary(principal, pid, branch)
            if len(parts) == 3 and parts[2] == "branches" and method == "POST":
                return 201, self.create_branch(principal, pid, need_object({} if body is None else body))
            if len(parts) == 3 and parts[2] == "backup" and method == "POST":
                return 200, self.backup(principal, pid)
            if len(parts) == 3 and parts[2] == "archive" and method == "POST":
                return 200, self.archive_project(principal, pid, need_object({} if body is None else body))
            if len(parts) == 3 and parts[2] == "delete" and method == "POST":
                return 200, self.delete_project(principal, pid, need_object({} if body is None else body))
            if len(parts) == 3 and parts[2] == "profile" and method in ("GET", "PUT"):
                self._require_access(principal, pid)
                if method == "GET":
                    return 200, get_profile(self.store, pid)
                return 200, save_profile(self.store, pid, body if isinstance(body, dict) else None)
            if len(parts) >= 4 and parts[2] == "branches":
                branch = parts[3]
                self._require_access(principal, pid, branch)
                rest = parts[4:]
                if rest not in (["save"], ["journal", "note"]):  # the shelf asks every book's save state / Alfred notes an action: not "opening" the book
                    self.touch_project(pid, branch)
                if rest and rest[0] == "review":
                    return self.route_review(method, rest[1:], query, body, principal, pid, branch)
                if rest == ["manifest"] and method == "GET":
                    return 200, self.store.feature_manifest(pid, branch)
                if rest == ["manifest"] and method == "PUT":
                    return 200, self.engine.set_manifest(principal, pid, branch,
                                                         need_object({} if body is None else body))
                if rest == ["records"] and method == "GET":
                    return 200, self.records(pid, branch, query)
                if len(rest) == 2 and rest[0] == "records" and method == "GET":
                    return 200, self.record_detail(pid, branch, rest[1])
                if len(rest) == 3 and rest[0] == "assets" and method == "GET":
                    if not VERSION_RE.fullmatch(rest[2]):
                        raise ApiError(400, "INVALID_INPUT", "/version", "the version must be a whole number")
                    return 200, self.asset(pid, branch, rest[1], int(rest[2]))
                if rest == ["journal"] and method == "GET":
                    return self.journal(pid, branch, query)
                if rest == ["journal", "note"] and method == "POST":  # 🎩 an assistant's action, for the journal
                    return 201, journal.add_note(self.store, pid, branch, body)
                if rest in (["grid"], ["costs"]) and method == "GET":  # 🗂 P27 scene grid · ⏱ P28 time and AI use
                    return self.route_grid_costs(rest[0], query, principal, pid, branch)
                if rest and rest[0] == "report":
                    return self.route_report(method, rest[1:], query, body, principal, pid, branch)
                if rest and rest[0] == "forge":  # 🗂 B5 Character Forge dossiers (forge.py)
                    from . import forge  # noqa: PLC0415
                    return forge.route(self, method, rest[1:], query, body, principal, pid, branch, headers)
                if rest and rest[0] == "pictures":  # 🖼 B3 chapter/scene pictures and the map (pictures.py)
                    from . import pictures  # noqa: PLC0415
                    return pictures.route(self, method, rest[1:], query, body, principal, pid, branch, headers)
                if rest and rest[0] == "cover":  # 🎨 B3 book covers (cover.py)
                    from . import cover  # noqa: PLC0415
                    return cover.route(self, method, rest[1:], query, body, principal, pid, branch, headers)
                if rest and rest[0] == "beta":  # 📖 P23 (Section 7c) beta reader
                    from . import beta_reader  # noqa: PLC0415
                    return beta_reader.route(self, method, rest, body, principal, pid, branch)
                if rest == ["style"]:  # ✒️ P25 (Section 7c) this book's use of the author's style
                    from . import style_card  # noqa: PLC0415
                    return style_card.route_book(self, method, body, principal, pid)
                if rest == ["save"] and method == "POST":  # 💾 P20 save the book now
                    return 202, self.saver.start(pid, branch, kind="manual", reason="you pressed 💾 Save")
                if rest == ["save"] and method == "GET":
                    return 200, dict(self.saver.status(pid, branch), opened=self.opener.opened(pid, branch))
                if rest == ["bible"] and method == "GET":  # 📖 the book bible (summary, or the file)
                    return self.bible(pid, branch, query)
                if rest and rest[0] == "book" and len(rest) >= 2 and rest[1] == "write-all":
                    return self.route_write_all(method, rest[2:], principal, pid, branch)
                if rest == ["uploads"] and method == "POST":
                    return 201, self.upload(principal, pid, branch, body, headers)
                if rest == ["activity"] and method == "GET":
                    return 200, self.activity(pid, branch)
                if rest == ["export"] and method == "GET":
                    return 200, self.export(pid, branch)
                if rest == ["progress"] and method == "GET":
                    return 200, self.progress(pid, branch)
                if rest == ["book"] and method == "GET":
                    return 200, BookPath(self.engine, principal, pid, branch).status()
                if len(rest) == 2 and rest[0] == "book" and method == "POST":
                    return 200, self.book_act(principal, pid, branch, rest[1], body if isinstance(body, dict) else {})
        raise ApiError(404, "NOT_FOUND", path, "no such endpoint")

    BOOK_WORK = {"create": "AI is writing", "write_chapter": "AI is writing a chapter", "setup_format": "Setting up the book format",
                 "assemble": "Putting the book together", "export": "Exporting the book", "check": "Checking the book",
                 "approve": "Approving", "make_character": "AI is making a main character"}

    def book_act(self, principal: str, pid: str, branch: str, action: str, body: dict) -> dict:
        """A "Make my book" step; while it runs the status summary says what Akọwe is working on."""
        title = self.BOOK_WORK.get(action, "Working")
        op = body.get("op") if action == "create" else {"write_chapter": "C02", "setup_format": "I01",
                                                         "assemble": "G01", "export": "G11", "check": "H05",
                                                         "make_character": "A01"}.get(action)
        if action == "create" and body.get("op") in ("B01", "B03", "B11"):
            title = {"B01": "Writing the premise", "B03": "Writing the main plot", "B11": "Planning the chapters"}[body["op"]]
        if action == "write_chapter" and isinstance(body.get("chapter_id"), str):
            title = f"Writing chapter {body['chapter_id'][:30]}"
        with self.writer():  # a restore waits for this step (and this step waits for a running restore)
            if action in ("assemble", "export"):
                self.backups.try_backup(f"before-{action}")  # S9: automatic backup before big steps
            tok = self.work.begin(pid, op, title)
            try:
                if action == "make_character":  # ⚠️ on the outline step: make the missing main character (a draft)
                    bp = BookPath(self.engine, principal, pid, branch)
                    out = protagonist.make_for_book(self.assist, bp, body.get("name"))
                    out["book"] = BookPath(self.engine, principal, pid, branch).status()
                else:
                    out = BookPath(self.engine, principal, pid, branch).act(action, body)
            finally:
                self.work.end(tok)
            if action in ("approve", "assemble", "export", "check", "write_chapter", "create", "make_character"):
                self.saver.auto(pid, branch, reason=f"book step {action}", force=action == "export")
            return out

    # ------------------------------------------------------------------ 💾 P20 save / 📂 P21 open
    def route_books(self, method, parts, query, body, principal, headers):
        sv, op = self.saver, self.opener
        if parts == ["settings", "books-folder"]:
            if method == "GET":
                return 200, dict(sv.check(), local=self.is_local())
            if method == "PUT":
                return 200, dict(sv.save_settings(body if isinstance(body, dict) else {}), local=self.is_local())
        if parts == ["books-folder"] and method == "GET":
            return 200, op.folders()
        if parts == ["books-folder", "show"] and method == "POST":
            b = body if isinstance(body, dict) else {}
            pid = b.get("project_id")
            if pid is not None:
                if not isinstance(pid, str):
                    raise ApiError(400, "INVALID_INPUT", "/project_id", "project_id must be text")
                self._require_access(principal, pid)
            return 200, sv.open_folder(pid, b.get("branch_id") or "main")
        if parts == ["books-folder", "open"] and method == "POST":
            b = body if isinstance(body, dict) else {}
            return 201, op.open_folder(principal, b.get("folder"))
        if parts == ["books-folder", "bible"] and method == "GET":
            from . import book_bible  # noqa: PLC0415
            name = (query.get("folder") or [None])[0]
            return 200, {"folder": name, "summary": book_bible.summary(op.folder_bible(name))}
        if parts == ["books", "open"] and method == "POST":
            return 201, op.upload(principal, body, headers)
        if len(parts) == 3 and parts[:2] == ["books", "bible"] and method == "GET":
            from . import book_bible  # noqa: PLC0415
            b, _src = op.resolve_bible(principal, {"bible_id": parts[2]})
            return 200, {"bible_id": parts[2], "summary": book_bible.summary(b)}
        raise ApiError(404, "NOT_FOUND", "/" + "/".join(parts), "no such endpoint")

    def bible(self, pid, branch, query):
        from . import book_bible  # noqa: PLC0415
        b = book_bible.build(self, pid, branch)
        fmt = (query.get("format") or ["summary"])[0]
        if fmt == "summary":
            return 200, {"summary": book_bible.summary(b)}
        if fmt not in ("json", "md"):
            raise ApiError(400, "INVALID_INPUT", "/format", "format: summary, json or md")
        disposition = "attachment" if (query.get("download") or ["0"])[0] == "1" else "inline"
        if fmt == "json":
            return 200, ("__binary__", "application/json; charset=utf-8",
                         json.dumps(b, ensure_ascii=False, indent=2).encode("utf-8"), "book-bible.json", disposition)
        return 200, ("__binary__", "text/markdown; charset=utf-8", book_bible.render_markdown(b).encode("utf-8"),
                     "book-bible.md", disposition)

    # ------------------------------------------------------------------ 📊 P13 book report
    def route_report(self, method, rest, query, body, principal, pid, branch):
        from . import book_report as br  # noqa: PLC0415
        rp = self.reports
        if rest == [] and method == "GET":
            return 200, rp.overview(principal, pid, branch)
        if rest == [] and method == "POST":
            return 202, rp.start(principal, pid, branch, body if isinstance(body, dict) else {})
        if len(rest) == 2 and rest[0] == "job" and method == "GET":
            return 200, rp.job(principal, rest[1])
        if len(rest) == 1 and method == "GET":
            rep = rp.get(pid, branch, rest[0])
            fmt = (query.get("format") or ["json"])[0]
            if fmt not in ("json", "md", "pdf"):
                raise ApiError(400, "INVALID_INPUT", "/format", "format: json, md or pdf")
            if fmt == "json":
                return 200, rep
            disposition = "attachment" if (query.get("download") or ["0"])[0] == "1" else "inline"
            name = br.file_name(rep.get("title"), rep.get("at"), fmt)
            if fmt == "md":
                return 200, ("__binary__", "text/markdown; charset=utf-8", br.render_markdown(rep).encode("utf-8"),
                             name, disposition)
            return 200, ("__binary__", "application/pdf", br.render_pdf(rep), name, disposition)
        raise ApiError(404, "NOT_FOUND", "/report", "no such endpoint")

    # ------------------------------------------------------------------ S2 write all chapters
    def route_write_all(self, method, rest, principal, pid, branch):
        wa = self.write_all
        if rest == [] and method == "POST":
            return 202, wa.start(principal, pid, branch)
        if rest == [] and method == "GET":
            return 200, {"job": wa.latest(principal, pid, branch)}
        if len(rest) == 1 and method == "GET":
            return 200, wa.public(wa.owned(principal, rest[0]))
        if len(rest) == 2 and rest[1] == "cancel" and method == "POST":
            return 200, wa.cancel(principal, rest[0])
        if len(rest) == 2 and rest[1] == "resume" and method == "POST":
            return 200, wa.resume(principal, rest[0])
        raise ApiError(404, "NOT_FOUND", "/book/write-all", "no such endpoint")

    # ------------------------------------------------------------------ 🗂 P27 scene grid · ⏱ P28 time and AI use
    def route_grid_costs(self, what, query, principal, pid, branch):
        fmt = (query.get("format") or ["json"])[0]
        disposition = "attachment" if (query.get("download") or ["0"])[0] == "1" else "inline"
        if what == "grid":
            from . import scene_grid  # noqa: PLC0415
            g = scene_grid.build(self, principal, pid, branch)
            if fmt == "csv":
                return 200, ("__binary__", "text/csv; charset=utf-8", scene_grid.render_csv(g).encode("utf-8"),
                             f"scene-grid-{pid}.csv", disposition)
            if fmt != "json":
                raise ApiError(400, "INVALID_INPUT", "/format", "format: json or csv")
            return 200, g
        from . import costs as costs_mod  # noqa: PLC0415
        c = costs_mod.book_costs(self, pid, branch)
        if fmt == "md":
            return 200, ("__binary__", "text/markdown; charset=utf-8", costs_mod.render_markdown(c).encode("utf-8"),
                         f"time-and-ai-use-{pid}.md", disposition)
        if fmt != "json":
            raise ApiError(400, "INVALID_INPUT", "/format", "format: json or md")
        return 200, c

    # ------------------------------------------------------------------ journal (R11)
    def journal(self, pid, branch, query):
        step = (query.get("step") or [None])[0] or None
        if step is not None and not re.fullmatch(r"[A-Ka-k](?:[0-9]{2})?", step):
            raise ApiError(400, "INVALID_INPUT", "/step", "step: an operation ID like C02 or a set letter like C")
        probs = (query.get("problems") or ["0"])[0] in ("1", "true", "yes")
        j = journal.build(self, pid, branch, step=step, problems_only=probs)
        if (query.get("format") or ["json"])[0] == "md":
            disposition = "attachment" if (query.get("download") or ["0"])[0] == "1" else "inline"
            name = f"book-journal-{pid}.md"
            return 200, ("__binary__", "text/markdown; charset=utf-8", journal.render_markdown(j).encode("utf-8"),
                         name, disposition)
        return 200, j

    # ------------------------------------------------------------------ R14/S21 runs, S11 jobs, R12, S8, S9, S22
    def route_ops(self, method, parts, query, body, principal):
        body = body if isinstance(body, dict) else {}
        head = parts[0]
        if head == "autobook":
            ab = self.autobook
            if parts == ["autobook"] and method == "GET":
                return 200, {"runs": ab.list(principal), "active": [ab.public(r) for r in ab.active()]}
            if parts == ["autobook"] and method == "POST":
                for k in ("genre", "length", "slot_id", "idea"):
                    if body.get(k) is not None and not isinstance(body.get(k), str):
                        raise ApiError(400, "INVALID_INPUT", f"/{k}", f"{k} must be text")
                return 202, ab.start(principal, body)
            if len(parts) == 2 and method == "GET":
                return 200, ab.public(ab.owned(principal, parts[1]))
            if len(parts) == 3 and method == "POST":
                act = {"pause": ab.pause, "resume": ab.resume, "cancel": ab.cancel}.get(parts[2])
                if act:
                    return 200, act(principal, parts[1])
                if parts[2] == "decide":
                    return 200, ab.decide(principal, parts[1], body)
        if head == "jobs":
            if parts == ["jobs"] and method == "GET":
                pid = (query.get("project_id") or [None])[0]
                items = [j for j in self.jobstore.list(project_id=pid, limit=60) if j.get("principal") in (None, principal)
                         and j.get("status") != "dismissed"]
                return 200, {"jobs": [self.job_summary(j) for j in items],
                             "interrupted": sum(1 for j in items if j.get("status") == "interrupted")}
            if len(parts) == 3 and parts[2] == "resume" and method == "POST":
                return 200, self.resume_job(principal, parts[1])
            if len(parts) == 3 and parts[2] == "dismiss" and method == "POST":
                j = self.jobstore.get(parts[1])
                if not j or j.get("principal") not in (None, principal):
                    raise ApiError(404, "NOT_FOUND", "/job_id", "this job is not known")
                if j.get("status") in ("running", "waiting", "queued", "pausing"):
                    raise ApiError(409, "VERSION_CONFLICT", "/job_id", "it is still running; cancel it first")
                j["status"] = "dismissed"
                self.jobstore.save(j)
                return 200, {"ok": True}
        if parts == ["health"] and method == "GET":
            return 200, self.health.run(force=(query.get("force") or ["0"])[0] == "1")
        if parts == ["diagnostics"] and method in ("GET", "POST"):
            rep = diagnostics.build(self, body.get("client") if method == "POST" else None)
            fmt = (query.get("format") or ["json"])[0]
            if fmt == "text" or (query.get("download") or ["0"])[0] == "1":
                text = diagnostics.render_text(rep) + "\n" + json.dumps(rep, indent=2, ensure_ascii=False)
                disposition = "attachment" if (query.get("download") or ["0"])[0] == "1" else "inline"
                return 200, ("__binary__", "text/plain; charset=utf-8", text.encode("utf-8"),
                             "akowe-diagnostics.txt", disposition)
            return 200, dict(rep, text=diagnostics.render_text(rep))
        if head == "backups":
            bm = self.backups
            if parts == ["backups"] and method == "GET":
                return 200, {"backups": bm.list(), "keep": bm.keep(), "last_error": bm.last_error}
            if parts == ["backups"] and method == "POST":
                return 201, bm.backup("manual")
            if parts == ["backups", "settings"] and method == "PUT":
                return 200, {"keep": bm.set_keep(body.get("keep")), "backups": bm.list()}
            if len(parts) == 3 and parts[2] == "restore" and method == "POST":
                out = bm.restore(parts[1], body)
                self.changed()
                return 200, out
        if parts == ["shelf"] and method == "GET":
            return 200, shelf_page(self, principal=principal)
        if parts == ["settings", "reviewer-ai"]:
            if method == "GET":
                return 200, self.review.reviewer_settings()
            if method == "PUT":
                return 200, self.review.save_reviewer_settings(body)
        if parts == ["lengths"] and method == "GET":  # P15: the length presets
            from .lengths import lengths_table  # noqa: PLC0415
            return 200, lengths_table()
        if parts == ["pipeline"] and method == "GET":  # P14: the pipeline switches and presets
            from .pipeline import field_info as pipeline_info  # noqa: PLC0415
            return 200, pipeline_info()
        if parts == ["settings", "length"]:
            from . import lengths as lengths_mod  # noqa: PLC0415
            if method == "GET":
                return 200, dict(lengths_mod.settings(self.store), limits=lengths_mod.LIMITS)
            if method == "PUT":
                return 200, lengths_mod.save_settings(self.store, body)
        if head == "compare":  # ⚖️ P14 blind comparisons
            cs = self.compare
            if parts == ["compare"] and method == "GET":
                return 200, {"items": cs.list(principal)}
            if parts == ["compare"] and method == "POST":
                return 202, cs.start(principal, body)
            if len(parts) == 3 and parts[1] == "job" and method == "GET":
                return 200, cs.job(principal, parts[2])
            if len(parts) == 2 and method == "GET":
                return 200, cs.get(principal, parts[1])
        if parts == ["story-choices"] and method == "GET":  # P12: labels, ⓘ help and the ending matrix
            from .story_choices import field_info as choices_info  # noqa: PLC0415
            return 200, choices_info()
        if parts == ["settings", "editor"]:
            if method == "GET":
                return 200, self.review.editor.settings()
            if method == "PUT":
                return 200, self.review.editor.save_settings(body)
        if parts == ["settings", "ai-retry"]:
            if method == "GET":
                cur = self.store.get_setting("ai_retry") or {}
                return 200, dict(DEFAULT_RETRY, **(cur if isinstance(cur, dict) else {}))
            if method == "PUT":
                val = clean_retry_settings(body)
                self.store.set_setting("ai_retry", val)
                return 200, val
        raise ApiError(404, "NOT_FOUND", "/" + "/".join(parts), "no such endpoint")

    def job_summary(self, j: dict) -> dict:
        keep = ("id", "kind", "status", "phase", "project_id", "branch_id", "op", "slot", "slot_label", "created_at",
                "updated_at", "finished_at", "error", "problem", "title", "done", "total", "current", "resumed_as")
        out = {k: j.get(k) for k in keep if j.get(k) is not None}
        out["resumable"] = j.get("status") in ("interrupted", "paused", "error") and (
            j.get("kind") in ("autobook", "write_all") or bool(j.get("resume")))
        if j.get("kind") == "autobook":
            out["steps_done"] = sum(1 for s in j.get("steps") or [] if s.get("state") == "done")
            out["steps_total"] = len(j.get("steps") or [])
        if j.get("kind") == "write_all":
            out["done"] = sum(1 for i in j.get("items") or [] if i.get("state") == "done")
            out["total"] = len(j.get("items") or [])
        return out

    def resume_job(self, principal: str, job_id: str) -> dict:
        j = self.jobstore.get(job_id)
        if not j or j.get("principal") not in (None, principal):
            raise ApiError(404, "NOT_FOUND", "/job_id", "this job is not known")
        kind = j.get("kind")
        if kind == "autobook":
            return {"kind": kind, "run": self.autobook.resume(principal, job_id)}
        if kind == "write_all":
            return {"kind": kind, "job": self.write_all.resume(principal, job_id)}
        r = j.get("resume")
        if not r:
            raise ApiError(400, "INVALID_INPUT", "/job_id", "this job has nothing left to resume")
        if kind == "book_review":
            new = self.reports.start(principal, r["project_id"], r["branch_id"], {k: r.get(k) for k in (
                "slots", "ai", "report_id") if r.get(k) is not None})
            j["status"], j["resumed_as"] = "resumed", new.get("id")
            self.jobstore.save(j)
            return {"kind": kind, "job": new}
        if kind == "compare":
            new = self.compare.start(principal, r.get("body") or {})
            j["status"], j["resumed_as"] = "resumed", new.get("id")
            self.jobstore.save(j)
            return {"kind": kind, "job": new}
        if kind == "assist":
            new = self.assist.start_assist(principal, dict(r))
        elif kind in ("review_world_rules", "review_world_texture"):
            new = self.review.start_world_ai(principal, r["project_id"], r["branch_id"], kind.rsplit("_", 1)[-1],
                                             {"slot_id": r.get("slot_id")})
        elif kind in ("review_planned_check", "review_planned_fix"):
            rid = (r.get("record_ids") or [None])[0]
            if not rid:
                raise ApiError(400, "INVALID_INPUT", "/job_id", "this job has nothing left to resume")
            new = self.review.start_planned(principal, r["project_id"], r["branch_id"], rid,
                                            {"slot_id": r.get("slot_id")}, fix=kind.endswith("fix"))
        elif kind in ("review_characters", "review_scenes", "review_scenes_check"):
            rid = (r.get("record_ids") or [None])[0]
            fn = {"characters": self.review.start_character_ai, "scenes": self.review.start_scenes_ai,
                  "scenes_check": self.review.start_scenes_check}.get(r.get("kind"))
            if fn is None or not rid:
                raise ApiError(400, "INVALID_INPUT", "/job_id", "this job has nothing left to resume")
            new = fn(principal, r["project_id"], r["branch_id"], rid, {"slot_id": r.get("slot_id")})
        elif kind in ("review_review", "review_fix", "review_editor", "review_editor_fix"):
            fn = {"review": self.review.start_review, "fix": self.review.start_fix, "editor": self.review.start_editor,
                  "editor_fix": self.review.start_editor_fix}.get(r.get("kind"), self.review.start_fix)
            b = {"record_ids": r.get("record_ids"), "slot_id": r.get("slot_id")} if r.get("kind") == "review" else \
                {"record_id": (r.get("record_ids") or [None])[0], "slot_id": r.get("slot_id")}
            new = fn(principal, r["project_id"], r["branch_id"], b)
        elif kind == "review_forge":  # 🗂 B5 "Invent the rest": only empty fields are filled, so it is safe to rerun
            rid = (r.get("record_ids") or [None])[0]
            if not rid:
                raise ApiError(400, "INVALID_INPUT", "/job_id", "this job has nothing left to resume")
            new = self.forge.start_forge(principal, r["project_id"], r["branch_id"], rid, {"slot_id": r.get("slot_id")})
        elif kind == "bible":
            new = self.assist.create_bible(principal, {"project_id": j.get("project_id"), "branch_id": j.get("branch_id"),
                                                       "idea": r.get("idea"), "counts": r.get("counts"),
                                                       "slot_id": r.get("slot_id")})
        else:
            raise ApiError(400, "INVALID_INPUT", "/job_id", "this kind of job cannot be resumed")
        j["status"], j["resumed_as"] = "resumed", new.get("job_id") or new.get("session_id")
        self.jobstore.save(j)
        return {"kind": kind, "job": new}

    def pair_autoinjector(self, body: dict) -> dict:
        """One-button pairing (#/pair): code -> connection key at the bridge -> all three slots -> health.
        The key never appears in the answer."""
        self.engine.providers.pair_autoinjector(body.get("code"), body.get("bridge_url"))
        slots = []
        for s in self.engine.providers.slots():
            if s["adapter_id"] != "autoinjector":
                continue
            hres = self.engine.providers.health_check(s["slot_id"])
            slots.append({"slot_id": s["slot_id"], "site": s.get("site"), "ok": bool(hres.get("ok")),
                          "message": hres.get("message"), "error": hres.get("error"),
                          "site_ready": hres.get("site_ready"), "site_busy": hres.get("site_busy")})
        self.changed()
        url = next((s.get("bridge_url") for s in self.engine.providers.slots() if s["adapter_id"] == "autoinjector"), None)
        return {"connected": True, "bridge_url": url, "slots": slots,
                "message": "Akọwe is connected to AutoInjector: AI-1 = Claude, AI-2 = ChatGPT, AI-3 = Gemini."}

    def route_review(self, method: str, rest: list, query: dict, body, principal: str, pid: str, branch: str):
        """Review queue, approvals, AI review/fix jobs and the auto-approve setting (see review.py)."""
        rv = self.review
        body = body if isinstance(body, dict) else {}
        try:
            if rest == [] and method == "GET":
                return 200, rv.queue(principal, pid, branch)
            if rest == ["summary"] and method == "GET":
                return 200, rv.summary(principal, pid, branch)
            if rest == ["approve"] and method == "POST":
                out = rv.approve(principal, pid, branch, body)
                self.saver.auto(pid, branch, reason="approval")  # 💾 progress save (at most every 2 minutes)
                return 200, out
            if rest == ["settings"] and method == "GET":
                return 200, rv.settings(pid)
            if rest == ["settings"] and method == "PUT":
                return 200, rv.save_settings(principal, pid, branch, body)
            if rest == ["ai"] and method == "POST":
                return 202, rv.start_review(principal, pid, branch, body)
            if rest == ["fix"] and method == "POST":
                return 202, rv.start_fix(principal, pid, branch, body)
            if rest == ["editor"] and method == "POST":
                return 202, rv.start_editor(principal, pid, branch, body)
            if rest == ["editor", "fix"] and method == "POST":
                return 202, rv.start_editor_fix(principal, pid, branch, body)
            if rest == ["editor", "apply"] and method == "POST":
                return 200, rv.apply_editor_fix(principal, pid, branch, body)
            if len(rest) == 2 and rest[0] == "editor" and method == "GET":
                return 200, rv.editor_info(principal, pid, branch, rest[1])
            if len(rest) == 2 and rest[0] == "ai" and method == "GET":
                return 200, rv.get_job(principal, rest[1])
            if len(rest) == 3 and rest[0] == "ai" and rest[2] == "cancel" and method == "POST":
                return 200, rv.cancel_job(principal, rest[1])
            if len(rest) == 2 and rest[0] == "record" and method == "GET":
                return 200, rv.record_reviews(principal, pid, branch, rest[1])
            # 🎭 character sheets and voice cards (P7/P17)
            if rest == ["characters"] and method == "GET":
                return 200, rv.characters_info(principal, pid, branch)
            if len(rest) == 2 and rest[0] == "characters" and method == "GET":
                return 200, rv.character_info(principal, pid, branch, rest[1])
            if len(rest) == 2 and rest[0] == "characters" and method == "PUT":
                return 200, rv.save_character(principal, pid, branch, rest[1], body)
            if len(rest) == 3 and rest[0] == "characters" and rest[2] == "ai" and method == "POST":
                return 202, rv.start_character_ai(principal, pid, branch, rest[1], body)
            # 🎬 scene cards (P8)
            if len(rest) == 2 and rest[0] == "scenes" and method == "GET":
                return 200, rv.scenes_info(principal, pid, branch, rest[1])
            if len(rest) == 2 and rest[0] == "scenes" and method == "PUT":
                return 200, rv.save_scenes(principal, pid, branch, rest[1], body)
            if len(rest) == 3 and rest[0] == "scenes" and rest[2] == "ai" and method == "POST":
                return 202, rv.start_scenes_ai(principal, pid, branch, rest[1], body)
            if len(rest) == 3 and rest[0] == "scenes" and rest[2] == "check" and method == "POST":
                return 202, rv.start_scenes_check(principal, pid, branch, rest[1], body)
            if len(rest) == 3 and rest[0] == "scenes" and rest[2] == "approve" and method == "POST":
                return 200, rv.approve_scenes(principal, pid, branch, rest[1], body)
            # 📏 story rules (P9) and 🧺 world texture (P10)
            if rest == ["world"] and method == "GET":
                return 200, rv.world_info(principal, pid, branch)
            if rest == ["world", "rules"] and method == "PUT":
                return 200, rv.save_rules(principal, pid, branch, body)
            if rest == ["world", "rules", "proposals"] and method == "POST":
                return 200, rv.decide_rule_proposals(principal, pid, branch, body)
            if rest == ["world", "texture"] and method == "PUT":
                return 200, rv.save_texture(principal, pid, branch, body)
            if len(rest) == 3 and rest[0] == "world" and rest[2] == "ai" and method == "POST":
                return 202, rv.start_world_ai(principal, pid, branch, rest[1], body)
            # 🧭 Section 7 continuity: physical / character state, two readings, version ledger (continuity.py)
            if rest and rest[0] == "continuity":
                from . import continuity  # noqa: PLC0415
                out = continuity.route(self, method, rest[1:], body, principal, pid, branch)
                if out is not None:
                    return out
            # ✅ planned-to-page check (P11)
            if rest == ["planned"] and method == "GET":
                return 200, rv.planned_book(principal, pid, branch)
            if len(rest) == 2 and rest[0] == "planned" and method == "GET":
                return 200, rv.planned_info(principal, pid, branch, rest[1])
            if len(rest) == 3 and rest[0] == "planned" and rest[2] in ("check", "fix") and method == "POST":
                return 202, rv.start_planned(principal, pid, branch, rest[1], body, fix=rest[2] == "fix")
            # 🔎 fact checks: timeline + terms (P26), trade facts (P31), repetition sorter (P30) — fact_checks.py
            if rest and rest[0] == "facts":
                from .fact_checks import route as facts_route  # noqa: PLC0415
                out = facts_route(rv, principal, pid, branch, rest, method, body)
                if out is not None:
                    return out
        except AkoweError as exc:
            from .assist import FIX  # noqa: PLC0415
            for e in exc.errors:
                e.setdefault("fix", FIX.get(e.get("code"), FIX["INTERNAL_ERROR"]))
            raise
        raise ApiError(404, "NOT_FOUND", "/review/" + "/".join(rest), "no such endpoint")

    def route_workflow(self, method: str, parts: list, query: dict, body) -> tuple[int, object]:
        """🧪 Test workflow panel (workflow_test.py)."""
        wf = self.workflow
        if parts == ["workflow-test"] and method == "GET":
            return 200, wf.status()
        if parts == ["workflow-test", "run"] and method == "POST":
            started = wf.start(body if isinstance(body, dict) else {})
            if started is None:
                raise ApiError(409, "VERSION_CONFLICT", "/workflow-test", "a workflow test is already running; wait "
                               "for it or press Stop")
            return 202, started
        if parts == ["workflow-test", "stop"] and method == "POST":
            return 200, wf.stop()
        if parts == ["workflow-test", "report"] and method == "GET":
            fmt = (query.get("format") or ["md"])[0]
            if fmt not in ("md", "json"):
                raise ApiError(400, "INVALID_INPUT", "/format", "format must be md or json")
            paths = wf.latest_paths()
            if not paths:
                raise ApiError(404, "NOT_FOUND", "/workflow-test/report", "no workflow test report yet; press Run all")
            path = paths[0] if fmt == "md" else paths[1]
            mime = "text/markdown; charset=utf-8" if fmt == "md" else "application/json; charset=utf-8"
            disposition = "attachment" if (query.get("download") or ["0"])[0] == "1" else "inline"
            return 200, ("__binary__", mime, path.read_bytes(), path.name, disposition)
        raise ApiError(404, "NOT_FOUND", "/" + "/".join(parts), "no such endpoint")

    def route_ai(self, method: str, parts: list, query: dict, body, principal: str) -> tuple[int, object]:
        """AI assist ("Fill with AI") and Bible Builder endpoints (proposals; see assist.py)."""
        try:
            return self._route_ai(method, parts, query, body, principal)
        except AkoweError as exc:
            from .assist import FIX  # noqa: PLC0415
            for e in exc.errors:  # every refusal carries a plain-English fix for the panel
                code = "NOT_APPLICABLE" if str(e.get("path") or "").startswith("/feature_manifest") else e.get("code")
                e.setdefault("fix", FIX.get(code, FIX["INTERNAL_ERROR"]))
            raise

    def _route_ai(self, method: str, parts: list, query: dict, body, principal: str) -> tuple[int, object]:
        a = self.assist
        body = body if isinstance(body, dict) else {}
        if parts == ["assist"] and method == "POST":
            return 202, a.start_assist(principal, body)
        if len(parts) == 2 and parts[0] == "assist" and method == "GET":
            return 200, a.get_assist(principal, parts[1])
        if len(parts) == 3 and parts[0] == "assist" and parts[2] == "cancel" and method == "POST":
            return 200, a.cancel_assist(principal, parts[1])
        if parts == ["bible-builder"] and method == "POST":
            return 202, a.create_bible(principal, body)
        if parts == ["bible-builder"] and method == "GET":
            pid = (query.get("project_id") or [None])[0]
            branch = (query.get("branch_id") or ["main"])[0]
            return 200, {"session": a.latest_bible(principal, pid, branch),
                         "sections": a.bible_sections(pid, branch)}
        if len(parts) == 2 and parts[0] == "bible-builder" and method == "GET":
            return 200, a.get_bible(principal, parts[1])
        if len(parts) == 3 and parts[0] == "bible-builder" and method == "POST":
            sid, act = parts[1], parts[2]
            if act == "run":
                return 202, a.run_bible(principal, sid, body)
            if act == "regenerate":
                return 202, a.regenerate_bible_item(principal, sid, body)
            if act == "cancel":
                return 200, a.cancel_bible(principal, sid)
            if act == "create":
                return 200, a.create_bible_items(principal, sid, body)
        if len(parts) == 3 and parts[0] == "bible-builder" and parts[2] == "report" and method == "GET":
            fmt = (query.get("format") or ["md"])[0]
            if fmt not in ("md", "json"):
                raise ApiError(400, "INVALID_INPUT", "/format", "format must be md or json")
            md, js = a.bible_report(principal, parts[1])
            path = md if fmt == "md" else js
            mime = "text/markdown; charset=utf-8" if fmt == "md" else "application/json; charset=utf-8"
            disposition = "attachment" if (query.get("download") or ["0"])[0] == "1" else "inline"
            return 200, ("__binary__", mime, path.read_bytes(), path.name, disposition)
        raise ApiError(404, "NOT_FOUND", "/" + "/".join(parts), "no such endpoint")

    def operations(self) -> list[dict]:
        out = []
        for op_id in self.engine.contracts.operation_ids:
            o = self.engine.contracts.operation(op_id)
            out.append({k: o.get(k) for k in ("id", "name", "purpose", "execution", "ai", "routes", "ui_type",
                                               "modes", "create_requires", "legacy_inputs", "specification")}
                       | {"set": op_id[0], "assist": assist_supports(self.engine.contracts, op_id)})
        return out

    def sets(self, principal: str, query: dict) -> dict:
        """The 11 module sets with plain-language guide data; counts and "what's next" for a project."""
        pid = (query.get("project_id") or [None])[0]
        if not pid:
            return sets_overview(self.engine.contracts)
        branch = (query.get("branch_id") or ["main"])[0]
        self._require_access(principal, pid, branch)
        out = sets_overview(self.engine.contracts, self.store.list_records(pid, branch),
                            self.store.feature_manifest(pid, branch))
        out.update(project_id=pid, branch_id=branch)
        return out

    def operation_schema(self, op_id: str) -> dict:
        c = self.engine.contracts
        if c.operation(op_id) is None:
            raise ApiError(404, "NOT_FOUND", "/op", "unknown operation")
        defs = c.schema(op_id)["$defs"]
        # UPDATE payload equals OUTPUT, so output_bindings map OUTPUT fields to permitted producers
        # (pins inside stored data are checked by the same producer rules on validation).
        out_props = set(defs["OUTPUT"].get("properties", {}))
        output_bindings = [b for b in c.bindings(op_id) if b["input_path"].split("/")[2] in out_props]
        return {"create_payload": defs["CREATE"]["properties"]["payload"], "output": defs["OUTPUT"],
                "bindings": c.bindings(op_id), "output_bindings": output_bindings,
                "dependencies": c.dependencies(op_id, "CREATE")}

    def project_summary(self, principal: str, pid: str, branch: str = "main") -> dict:
        p = self.store.project(pid)
        branches = [r["branch_id"] for r in self.store.query(
            "SELECT branch_id FROM branches WHERE project_id=? ORDER BY created_at", (pid,))]
        counts = {r["module_id"]: r["n"] for r in self.store.query(
            "SELECT module_id, COUNT(*) n FROM heads WHERE project_id=? AND branch_id=? GROUP BY module_id", (pid, branch))}
        return {"project_id": pid, "name": p["name"], "owner_id": p["owner_id"], "created_at": p["created_at"],
                "settings": json.loads(p["settings"]), "story_time_unit": p["story_time_unit"],
                "currency": p["currency"], "branches": branches, "record_counts": counts,
                "profile": get_profile(self.store, pid), "test_book": self.is_test_project(pid),
                "branch_id": branch, "manifest": self.store.feature_manifest(pid, branch)}

    def create_project(self, principal: str, body: dict) -> dict:
        name = (need_str(body, "name") or "").strip()
        if not name:
            raise ApiError(400, "MISSING_INPUT", "/name", "project name is required")
        features = body.get("features") or {}
        if not isinstance(features, dict) or any(not isinstance(v, bool) for v in features.values()):
            raise ApiError(400, "INVALID_INPUT", "/features", "features must be booleans")
        for k in ("story_time_unit", "currency"):
            if body.get(k) not in (None, "") and not isinstance(body.get(k), str):
                raise ApiError(400, "INVALID_INPUT", f"/{k}", f"{k} must be text")
        if body.get("settings") is not None and not isinstance(body.get("settings"), dict):
            raise ApiError(400, "INVALID_INPUT", "/settings", "settings must be an object")
        rp = body.get("release_profiles")
        if rp is not None and (not isinstance(rp, list) or not all(isinstance(x, str) for x in rp)):
            raise ApiError(400, "INVALID_INPUT", "/release_profiles", "release_profiles must be a list of names")
        if body.get("profile") is not None:
            clean_profile(body.get("profile"))  # refuse a bad profile before anything is created
        pid = self.engine.bootstrap_project(principal, name, settings=body.get("settings") or {},
                                            features=features, release_profiles=body.get("release_profiles"),
                                            story_time_unit=body.get("story_time_unit") or "seconds",
                                            currency=body.get("currency") or "USD")
        if body.get("profile") is not None:
            save_profile(self.store, pid, body.get("profile"))
        return self.project_summary(principal, pid)

    def create_branch(self, principal: str, pid: str, body: dict) -> dict:
        need_str(body, "parent_branch_id")
        self._require_access(principal, pid, body.get("parent_branch_id") or "main")
        bid = need_str(body, "branch_id") or ""
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", bid):
            raise ApiError(400, "INVALID_INPUT", "/branch_id", "branch id: letters, digits, . _ - (max 64)")
        if self.store.branch_exists(pid, bid):
            raise ApiError(409, "VERSION_CONFLICT", "/branch_id", "branch exists")
        parent = body.get("parent_branch_id") or "main"
        manifest = self.store.feature_manifest(pid, parent)
        with self.store.transaction() as tx:
            tx.create_branch(pid, bid, parent)
            if manifest:
                tx.put_feature_manifest(dict(manifest, branch_id=bid, manifest_id=f"manifest-{pid}-{bid}"))
        return self.project_summary(principal, pid)

    def dispatch(self, principal: str, body: dict) -> dict:
        req = body.get("request")
        if not isinstance(req, dict):
            raise ApiError(400, "MISSING_INPUT", "/request", "request object required")
        full = req if req.get("contract_version") and req.get("deadline") and req.get("request_id") else None
        if full is None:
            for k in ("project_id", "branch_id", "target_operation", "action"):
                if not req.get(k):
                    raise ApiError(400, "MISSING_INPUT", f"/request/{k}", f"{k} is required")
                if not isinstance(req[k], str):
                    raise ApiError(400, "INVALID_INPUT", f"/request/{k}", f"{k} must be text")
            if req.get("idempotency_key") is not None and not isinstance(req["idempotency_key"], str):
                raise ApiError(400, "INVALID_INPUT", "/request/idempotency_key", "idempotency_key must be text")
            for k, typ, what in (("payload", dict, "an object"), ("base_ref", dict, "an object"),
                                 ("input_refs", list, "a list")):
                if req.get(k) is not None and not isinstance(req[k], typ):
                    raise ApiError(400, "INVALID_INPUT", f"/request/{k}", f"{k} must be {what}")
            op = self.engine.contracts.operation(req["target_operation"])
            timeout = op["timeout_ms"] if op else 180000
            full = build_request(project_id=req["project_id"], branch_id=req["branch_id"],
                                 op_id=req["target_operation"], action=req["action"], principal_id=principal,
                                 payload=req.get("payload") or {}, base_ref=req.get("base_ref"),
                                 input_refs=req.get("input_refs") or [], idempotency_key=req.get("idempotency_key"),
                                 timeout_ms=timeout)
        manual = body.get("manual_candidate")
        if manual is not None and not isinstance(manual, dict):
            raise ApiError(400, "INVALID_INPUT", "/manual_candidate", "manual_candidate must be an object")
        resp = self.engine.dispatch(full, principal, manual_candidate=manual)
        self.changed()
        return {"request": full, "response": resp}

    def records(self, pid: str, branch: str, query: dict) -> list[dict]:
        module = (query.get("module") or [None])[0]
        kind = (query.get("kind") or [None])[0]
        sets = (query.get("set") or [None])[0]
        recs = self.store.list_records(pid, branch, module_id=module, record_kind=kind)
        if sets:
            recs = [r for r in recs if r["module_id"][0] == sets]
        labels = self._upload_labels(pid, branch)
        for r in recs:
            r["label"] = labels.get(r["record_id"])
            if r["approved_version"] and r["approved_version"] != r["version"]:
                appr = self.store.get_record(pid, branch, r["record_id"], r["approved_version"])
                r["approved_ref"] = appr["ref"] if appr else None
            elif r["approved_version"]:
                r["approved_ref"] = r["ref"]
        return [self.record_summary(r) for r in recs]

    def _upload_labels(self, pid: str, branch: str) -> dict:
        rows = self.store.query("SELECT payload FROM outbox WHERE project_id=? AND branch_id=? AND "
                                "event_type='file.imported'", (pid, branch))
        out = {}
        for r in rows:
            p = json.loads(r["payload"])
            out[p["ref"]["record_id"]] = p.get("label")
        return out

    def record_detail(self, pid: str, branch: str, record_id: str) -> dict:
        hist = self.store.history(pid, branch, record_id)
        if not hist:
            raise ApiError(404, "NOT_FOUND", "/record_id", "record not found")
        edges = self.store.query("SELECT * FROM dependency_edges WHERE project_id=? AND branch_id=? AND "
                                 "(producer_record_id=? OR consumer_record_id=?) ORDER BY created_at",
                                 (pid, branch, record_id, record_id))
        prov = self.store.query("SELECT * FROM provenance WHERE project_id=? AND branch_id=? AND record_id=? "
                                "ORDER BY version", (pid, branch, record_id))
        return {"versions": [dict(self.record_summary(r), data=r["data"], source_refs=r["source_refs"],
                                  findings=r["findings"], binary=r.get("binary"),
                                  approval_ids=r["approval_ids"]) for r in hist],
                "edges": [dict(e) | {"paths": json.loads(e["paths"])} for e in edges],
                "provenance": [dict(p) | {"input_refs": json.loads(p["input_refs"]),
                                          "resource": json.loads(p["resource"]) if p["resource"] else None}
                               for p in prov]}

    def asset(self, pid, branch, record_id, version):
        rec = self.store.get_record(pid, branch, record_id, version)
        if rec is None or rec["representation"] != "BINARY_ARTIFACT":
            raise ApiError(404, "NOT_FOUND", "/record_id", "asset not found")
        return ("__binary__", rec["binary"]["mime_type"], self.store.read_binary(rec), record_id)

    def upload(self, principal, pid, branch, body, headers) -> dict:
        if not isinstance(body, (bytes, bytearray)) or not body:
            raise ApiError(400, "MISSING_INPUT", "/body", "empty upload")
        mime = (headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip()
        label = unquote(headers.get("X-Filename") or "upload")[:200]
        if not self.store.has_scope(principal, pid, branch, "I01:create"):
            raise ApiError(403, "PERMISSION_DENIED", "", "missing scope I01:create")
        rid = f"I01-{new_id('import').split('-', 1)[1]}"
        with self.store.transaction() as tx:
            ref = tx.insert_binary_record(project_id=pid, branch_id=branch, module_id="I01", record_id=rid, version=1,
                                          data=bytes(body), mime_type=mime, source_refs=[], principal_id=principal,
                                          record_kind="IMPORT")
            tx.insert_audit(project_id=pid, branch_id=branch, request_id=new_id("upload"), attempt_id=new_id("attempt"),
                            operation_id="I01", action="CREATE", principal_id=principal, input_refs=[],
                            output_refs=[ref], outcome="SUCCESS", evidence_type="COMMITTED_OUTPUT")
            tx.insert_outbox(pid, branch, "file.imported", {"ref": ref, "label": label[:200], "mime_type": mime,
                                                            "byte_length": len(body)})
        return {"ref": ref, "mime_type": mime, "byte_length": len(body), "label": label}

    def activity(self, pid, branch) -> dict:
        audit = self.store.query("SELECT audit_id, request_id, operation_id, action, principal_id, outcome, "
                                 "evidence_type, recorded_at, output_refs FROM audit WHERE project_id=? AND branch_id=? "
                                 "ORDER BY recorded_at DESC LIMIT 200", (pid, branch))
        events = self.store.query("SELECT event_id, event_type, payload, created_at FROM outbox WHERE project_id=? AND "
                                  "branch_id=? ORDER BY created_at DESC LIMIT 200", (pid, branch))
        return {"audit": [dict(a) | {"output_refs": json.loads(a["output_refs"])} for a in audit],
                "events": [dict(e) | {"payload": json.loads(e["payload"])} for e in events]}

    def progress(self, pid, branch) -> dict:
        manifest = self.store.feature_manifest(pid, branch) or {}
        rows = self.store.query("SELECT h.module_id, h.record_id, h.latest_version, h.approved_version, l.state, l.stale "
                                "FROM heads h LEFT JOIN lifecycle l ON l.project_id=h.project_id AND "
                                "l.branch_id=h.branch_id AND l.record_id=h.record_id AND l.version=h.latest_version "
                                "WHERE h.project_id=? AND h.branch_id=?", (pid, branch))
        per_op: dict[str, dict] = {}
        for r in rows:
            d = per_op.setdefault(r["module_id"], {"records": 0, "approved": 0, "stale": 0, "draft": 0})
            d["records"] += 1
            d["approved"] += 1 if r["approved_version"] else 0
            d["stale"] += 1 if r["stale"] else 0
            d["draft"] += 1 if r["state"] in ("DRAFT", "VALIDATED") else 0
        return {"required_operations": manifest.get("required_operations", []), "per_operation": per_op,
                "features": manifest.get("features", {}), "release_profiles": manifest.get("release_profiles", [])}

    def export(self, pid, branch) -> dict:
        recs = self.store.query("SELECT * FROM records WHERE project_id=? AND branch_id=? ORDER BY record_id, version",
                                (pid, branch))
        out = []
        for r in recs:
            rec = self.store._row_to_record(r)
            out.append({k: rec[k] for k in ("record_id", "version", "module_id", "owner", "record_kind",
                                            "representation", "content_hash", "lifecycle", "data", "source_refs",
                                            "created_at")} | ({"binary": rec["binary"]} if rec.get("binary") else {}))
        return {"project": self.project_summary(self.principal_id, pid), "branch_id": branch,
                "exported_at": utcnow(), "contract_version": CONTRACT_VERSION, "records": out}

    def backup(self, principal, pid) -> dict:
        """The project page's Back up now: the same pinned, verified backup as Settings → Backups."""
        if not self.store.has_scope(principal, pid, "main", "I11:create"):
            raise ApiError(403, "PERMISSION_DENIED", "", "missing scope for backup")
        b = self.backups.backup("manual")
        return dict(b, path=str(self.backups.dir / b["name"]))

    # ------------------------------------------------------------------ BF-19 archive / delete a book
    def archived_projects(self, principal: str) -> list:
        return self.store.query("SELECT DISTINCT p.* FROM projects p JOIN grants g ON g.project_id IN "
                                "(p.project_id,'*') WHERE g.principal_id=? AND p.archived=1 ORDER BY p.created_at",
                                (principal,))

    def _owned_project(self, principal: str, pid: str):
        p = self.store.project(pid)
        if p is None or not self.store.has_project_access(principal, pid):
            raise ApiError(404, "NOT_FOUND", "/project_id", "this book does not exist")
        if not self.store.has_scope(principal, pid, "main", "K01:create"):
            raise ApiError(403, "PERMISSION_DENIED", "", "only the book's owner can archive or delete it")
        return p

    def archive_project(self, principal: str, pid: str, body: dict) -> dict:
        """Hide a book from the lists (it stays in the data folder and in every backup); archived: false brings it
        back."""
        p = self._owned_project(principal, pid)
        archived = body.get("archived", True)
        if not isinstance(archived, bool):
            raise ApiError(400, "INVALID_INPUT", "/archived", "archived must be true or false")
        with self.store.transaction() as tx:
            tx.execute("UPDATE projects SET archived=? WHERE project_id=?", (int(archived), pid))
        if archived and self._last_project and self._last_project.get("project_id") == pid:
            self._last_project = None
        self.changed()
        word = "archived (hidden from your book list; it is kept and backed up)" if archived else "back in your list"
        return {"project_id": pid, "archived": archived, "message": f"“{p['name']}” is {word}."}

    def delete_project(self, principal: str, pid: str, body: dict) -> dict:
        """Permanently delete a book. Needs author_confirms: true and the book's exact name typed as confirm;
        refused while anything else is working; an automatic safety backup is made first."""
        p = self._owned_project(principal, pid)
        typed = body.get("confirm")
        if body.get("author_confirms") is not True or not isinstance(typed, str) or \
                typed.strip() != (p["name"] or "").strip():
            raise ApiError(400, "APPROVAL_REQUIRED", "/confirm", "deleting a book cannot be undone: type the book's "
                           "exact name to confirm (author_confirms: true)")
        with self.exclusive("deleting a book"):
            why = self._restore_busy()
            if why:
                raise ApiError(409, "VERSION_CONFLICT", "/project_id", f"wait until {why} is finished, then delete")
            safety = self.backups.backup("before-delete")  # refuses (disk full…) before anything is removed
            removed = self.store.delete_project(pid)
        try:
            self.assist.forget_project(pid)  # its Bible Builder reports no longer carry the book's name
        except Exception:  # noqa: BLE001 - the book is deleted either way
            log.exception("could not tidy Bible Builder reports of deleted project %s", pid)
        if self._last_project and self._last_project.get("project_id") == pid:
            self._last_project = None
        self.changed()
        log.info("deleted project %s (%d asset files; safety backup %s)", pid, removed, safety.get("name"))
        return {"deleted": pid, "safety_backup": safety.get("name"), "assets_removed": removed,
                "message": f"“{p['name']}” was deleted. Restoring the backup {safety.get('name')} brings it "
                           "back (that safety copy is kept: automatic rotation never removes it)."}


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"Akowe/{__version__}"

        def log_message(self, fmt, *args):  # no request bodies/content in logs
            log.info("%s %s", self.command, self.path.split("?")[0])

        def _send(self, status: int, payload, content_type="application/json; charset=utf-8", extra=None):
            data = payload if isinstance(payload, (bytes, bytearray)) else json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def _static(self, path: str):
            rel = "index.html" if path in ("/", "") else path[len("/static/"):]
            target = (WEB_DIR / rel).resolve()
            if WEB_DIR.resolve() not in target.parents and target != WEB_DIR.resolve() / "index.html":
                return self._send(404, {"errors": [error("NOT_FOUND", path)]})
            if not target.is_file():
                return self._send(404, {"errors": [error("NOT_FOUND", path)]})
            ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript",):
                ctype += "; charset=utf-8"
            csp = ("default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; "  # media: 🎬 forge clips
                   "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'self' blob:; "
                   "frame-src 'self' blob:")
            self._send(200, target.read_bytes(), ctype, {"Content-Security-Policy": csp})

        def _handle(self, method: str):
            url = urlparse(self.path)
            if not url.path.startswith("/api/"):
                if method == "GET":
                    return self._static(url.path)
                return self._send(405, {"errors": [error("INVALID_INPUT", url.path, "method not allowed")]})
            if url.path == "/api/ping" and method == "GET":
                # No auth and no project data: lets AutoInjector see that Akọwe is running.
                return self._send(200, app.ping((parse_qs(url.query).get("challenge") or [None])[0]))
            try:
                principal = app.authenticate(self.headers.get("Authorization"))
                cl = (self.headers.get("Content-Length") or "0").strip()
                if not re.fullmatch(r"[0-9]{1,15}", cl):
                    self.close_connection = True  # the body cannot be skipped safely
                    raise ApiError(400, "INVALID_INPUT", "/Content-Length", "Content-Length must be a whole number "
                                   "of bytes")
                length = int(cl)
                if length > MAX_BODY:
                    self.close_connection = True
                    raise ApiError(413, "INVALID_INPUT", "/body", "body too large")
                raw = self.rfile.read(length) if length else b""
                body = None
                if raw:
                    ctype = (self.headers.get("Content-Type") or "").split(";")[0]
                    body = parse_json_body(raw) if ctype == "application/json" else raw
                app.set_client(self.client_address[0] if self.client_address else "")
                try:
                    status, payload = app.route(method, url.path, parse_qs(url.query), body, principal, self.headers)
                finally:
                    app.set_client(None)
                if isinstance(payload, tuple) and payload and payload[0] == "__binary__":
                    _, mime, data, name = payload[:4]
                    disposition = payload[4] if len(payload) > 4 else "inline"
                    return self._send(200, data, mime, {"Content-Disposition": content_disposition(disposition,
                                                                                                    name)})
                self._send(status, payload)
            except ApiError as exc:
                app.errors.add(exc.status, method, url.path, exc.body.get("errors"))
                self._send(exc.status, exc.body)
            except AkoweError as exc:
                code = exc.code
                status = {"NOT_FOUND": 404, "PERMISSION_DENIED": 403, "VERSION_CONFLICT": 409,
                          "RATE_LIMITED": 429, "CAPABILITY_UNAVAILABLE": 400}.get(code, 400)
                app.errors.add(status, method, url.path, exc.errors)
                self._send(status, {"errors": exc.errors})
            except Exception as exc:  # noqa: BLE001 - structured answer for the client, details in the log only
                log.error("unhandled error: %s\n%s", exc, traceback.format_exc())
                errs = [error("INTERNAL_ERROR", "", "Akọwe hit an unexpected problem; details are in the "
                              "Akọwe window/log")]
                app.errors.add(500, method, url.path, errs)
                self._send(500, {"errors": errs})

        def do_GET(self):
            self._handle("GET")

        def do_POST(self):
            self._handle("POST")

        def do_PUT(self):
            self._handle("PUT")

        def _not_allowed(self, with_body: bool = True):
            errs = [error("INVALID_INPUT", urlparse(self.path).path, f"the {self.command} method is not supported "
                          "here (use GET, POST or PUT)")]
            self.close_connection = True  # any request body is left unread
            if with_body:
                return self._send(405, {"errors": errs}, extra={"Allow": "GET, POST, PUT"})
            self.send_response(405)
            self.send_header("Allow", "GET, POST, PUT")
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_DELETE(self):
            # 🖼 B3: DELETE …/pictures/<pic_id> is the one place a DELETE means something (other paths stay 405)
            if re.fullmatch(r"/api/projects/[^/]+/branches/[^/]+/pictures/[^/]+", urlparse(self.path).path):
                return self._handle("DELETE")
            self._not_allowed()

        def do_PATCH(self):
            self._not_allowed()

        def do_OPTIONS(self):
            self._not_allowed()

        def do_HEAD(self):
            self._not_allowed(with_body=False)

    return Handler


PING_CHALLENGE_RE = re.compile(r"^[0-9a-f]{16,64}$")


def content_disposition(disposition: str, name: str) -> str:
    """A file name any title can have: an ASCII fallback plus the UTF-8 name (RFC 6266 / 5987)."""
    from urllib.parse import quote as _q  # noqa: PLC0415
    ascii_name = re.sub(r'[^A-Za-z0-9 ._()\-]+', "_", name).strip() or "download"
    if ascii_name == name:
        return f'{disposition}; filename="{name}"'
    return f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{_q(name, safe='')}"


def ping_proof(token: str, challenge: str) -> str:
    import hashlib  # noqa: PLC0415
    import hmac  # noqa: PLC0415
    return hmac.new(token.encode("utf-8"), f"akowe-ping:{challenge}".encode("ascii"), hashlib.sha256).hexdigest()


def already_running(host: str, port: int, token: str) -> bool:
    """True when an Akọwe with this data folder (same access token) already answers on host:port.

    BF-08: the token is never sent. We ask /api/ping (no auth) with a fresh random challenge and check its
    HMAC proof, so another program on that port learns nothing and can't pass as this Akọwe (which
    would make us open the browser with the token in the address)."""
    import hmac  # noqa: PLC0415
    import http.client  # noqa: PLC0415
    challenge = secrets.token_hex(16)
    try:
        conn = http.client.HTTPConnection(host, port, timeout=1.5)
        conn.request("GET", f"/api/ping?challenge={challenge}", headers={"Accept": "application/json"})
        resp = conn.getresponse()
        body = resp.read(65536)
        conn.close()
        if resp.status != 200:
            return False
        data = json.loads(body.decode("utf-8"))
    except (OSError, http.client.HTTPException, ValueError, UnicodeDecodeError):
        return False
    proof = data.get("proof") if isinstance(data, dict) else None
    return (isinstance(proof, str) and data.get("app") in ("akowe", legacy.OLD_APP_ID)
            and hmac.compare_digest(proof, ping_proof(token, challenge)))


def default_data_dir() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        return base / "Akowe"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "akowe"


def resolve_data_dir(given: str | None = None) -> str:
    """--data-dir, else AKOWE_DATA (or the old BOOKFORGE_DATA), else the default folder — which takes over the
    old BookForge data folder on the first start (legacy.migrate_data_dir: moved, or copied and marked)."""
    return given or legacy.env("DATA") or str(legacy.migrate_data_dir(default_data_dir()))


def _safe_console() -> None:
    """Never crash on a console that cannot show a character (Akọwe's ọ on an old Windows code page)."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def main(argv=None):
    _safe_console()
    ap = argparse.ArgumentParser(prog="akowe", description="Akọwe book production workspace")
    ap.add_argument("--data-dir", default=None, help="data folder (default: AKOWE_DATA or the per-user app folder)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(legacy.env("PORT", str(DEFAULT_PORT))))
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    args.data_dir = resolve_data_dir(args.data_dir)
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        log.warning("Binding to %s exposes the workspace beyond this computer; keep the token private.", args.host)
    app = App(args.data_dir)
    port_given = any(a == "--port" or a.startswith("--port=") for a in (argv if argv is not None else sys.argv[1:])) \
        or bool(legacy.env("PORT"))
    if not port_given and already_running(args.host, args.port, app.token):
        url = f"http://{args.host}:{args.port}/#token={app.token}"
        print(f"Akọwe is already running. Opening it: {url}")
        if not args.no_browser:
            webbrowser.open(url)
        return 0
    httpd = None
    ports = [args.port] if port_given else [args.port] + [p for p in range(args.port + 1, args.port + 20)]
    last_exc = None
    for port in ports:
        try:
            httpd = ThreadingHTTPServer((args.host, port), make_handler(app))
            break
        except OSError as exc:
            last_exc = exc
    if httpd is None:
        print(f"Could not start on {args.host}:{args.port}: {last_exc}. Close the program using that port, or "
              f"start with --port 8790.", file=sys.stderr)
        return 2
    if httpd.server_address[1] != args.port:
        print(f"Port {args.port} is busy, so Akọwe uses port {httpd.server_address[1]} instead.")
    args.port = httpd.server_address[1]
    app.port = args.port
    app.pusher.start()  # sends status to AutoInjector only when a slot is connected to it
    # S9: one automatic backup per day, on the first start of the day (in the background).
    threading.Thread(target=app.backups.daily_if_needed, name="akowe-daily-backup", daemon=True).start()
    url = f"http://{args.host}:{args.port}/#token={app.token}"
    print(f"Akọwe {__version__} running. Data: {args.data_dir}")
    print(f"Open: {url}")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("Stopping Akọwe.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
