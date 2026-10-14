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
import traceback
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import CLOSURE_REVISION, CONTRACT_VERSION, __version__
from .canonical import sha256_bytes
from .engine import Engine
from .errors import BookforgeError, error
from .requests import build_request
from .store import Store, new_id, utcnow

log = logging.getLogger("bookforge.server")
WEB_DIR = Path(__file__).resolve().parent / "web"
MAX_BODY = 64 * 1024 * 1024


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
        p.write_text(tok)
        try:
            os.chmod(p, 0o600)
        except OSError:
            pass
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
                "created_at": rec["created_at"], "title": (title or rec["record_id"])[:160], "ref": rec["ref"],
                "mime_type": (rec.get("binary") or {}).get("mime_type")}

    # ------------------------------------------------------------------ routes
    def route(self, method: str, path: str, query: dict, body, principal: str, headers) -> tuple[int, object]:
        parts = [unquote(p) for p in path.strip("/").split("/")][1:]  # drop 'api'
        if parts == ["session"] and method == "GET":
            return 200, {"principal_id": principal, "contract_version": CONTRACT_VERSION,
                         "closure_revision": CLOSURE_REVISION, "app_version": __version__,
                         "package_sha256": self.engine.contracts.package_sha256}
        if parts == ["operations"] and method == "GET":
            return 200, self.operations()
        if len(parts) == 3 and parts[0] == "operations" and parts[2] == "schema" and method == "GET":
            return 200, self.operation_schema(parts[1])
        if parts == ["slots"] and method == "GET":
            return 200, self.engine.providers.slots()
        if len(parts) == 2 and parts[0] == "slots" and method == "PUT":
            return 200, self.engine.providers.configure_slot(parts[1], body or {})
        if parts == ["projects"] and method == "GET":
            return 200, [self.project_summary(principal, r["project_id"]) for r in self.store.projects_for(principal)]
        if parts == ["projects"] and method == "POST":
            return 201, self.create_project(principal, body or {})
        if parts == ["dispatch"] and method == "POST":
            return 200, self.dispatch(principal, body or {})
        if len(parts) >= 2 and parts[0] == "projects":
            pid = parts[1]
            if len(parts) == 2 and method == "GET":
                self._require_access(principal, pid)
                return 200, self.project_summary(principal, pid)
            if len(parts) == 3 and parts[2] == "branches" and method == "POST":
                return 201, self.create_branch(principal, pid, body or {})
            if len(parts) == 3 and parts[2] == "backup" and method == "POST":
                return 200, self.backup(principal, pid)
            if len(parts) >= 4 and parts[2] == "branches":
                branch = parts[3]
                self._require_access(principal, pid, branch)
                rest = parts[4:]
                if rest == ["manifest"] and method == "GET":
                    return 200, self.store.feature_manifest(pid, branch)
                if rest == ["manifest"] and method == "PUT":
                    return 200, self.engine.set_manifest(principal, pid, branch, body or {})
                if rest == ["records"] and method == "GET":
                    return 200, self.records(pid, branch, query)
                if len(rest) == 2 and rest[0] == "records" and method == "GET":
                    return 200, self.record_detail(pid, branch, rest[1])
                if len(rest) == 3 and rest[0] == "assets" and method == "GET":
                    return 200, self.asset(pid, branch, rest[1], int(rest[2]))
                if rest == ["uploads"] and method == "POST":
                    return 201, self.upload(principal, pid, branch, body, headers)
                if rest == ["activity"] and method == "GET":
                    return 200, self.activity(pid, branch)
                if rest == ["export"] and method == "GET":
                    return 200, self.export(pid, branch)
                if rest == ["progress"] and method == "GET":
                    return 200, self.progress(pid, branch)
        raise ApiError(404, "NOT_FOUND", path, "no such endpoint")

    def operations(self) -> list[dict]:
        out = []
        for op_id in self.engine.contracts.operation_ids:
            o = self.engine.contracts.operation(op_id)
            out.append({k: o.get(k) for k in ("id", "name", "purpose", "execution", "ai", "routes", "ui_type",
                                               "modes", "create_requires", "legacy_inputs", "specification")}
                       | {"set": op_id[0]})
        return out

    def operation_schema(self, op_id: str) -> dict:
        c = self.engine.contracts
        if c.operation(op_id) is None:
            raise ApiError(404, "NOT_FOUND", "/op", "unknown operation")
        defs = c.schema(op_id)["$defs"]
        return {"create_payload": defs["CREATE"]["properties"]["payload"], "output": defs["OUTPUT"],
                "bindings": c.bindings(op_id), "dependencies": c.dependencies(op_id, "CREATE")}

    def project_summary(self, principal: str, pid: str) -> dict:
        p = self.store.project(pid)
        branches = [r["branch_id"] for r in self.store.query(
            "SELECT branch_id FROM branches WHERE project_id=? ORDER BY created_at", (pid,))]
        counts = {r["module_id"]: r["n"] for r in self.store.query(
            "SELECT module_id, COUNT(*) n FROM heads WHERE project_id=? AND branch_id='main' GROUP BY module_id", (pid,))}
        return {"project_id": pid, "name": p["name"], "owner_id": p["owner_id"], "created_at": p["created_at"],
                "settings": json.loads(p["settings"]), "story_time_unit": p["story_time_unit"],
                "currency": p["currency"], "branches": branches, "record_counts": counts,
                "manifest": self.store.feature_manifest(pid, "main")}

    def create_project(self, principal: str, body: dict) -> dict:
        name = (body.get("name") or "").strip()
        if not name:
            raise ApiError(400, "MISSING_INPUT", "/name", "project name is required")
        features = body.get("features") or {}
        if not isinstance(features, dict) or any(not isinstance(v, bool) for v in features.values()):
            raise ApiError(400, "INVALID_INPUT", "/features", "features must be booleans")
        pid = self.engine.bootstrap_project(principal, name, settings=body.get("settings") or {},
                                            features=features, release_profiles=body.get("release_profiles"),
                                            story_time_unit=body.get("story_time_unit") or "seconds",
                                            currency=body.get("currency") or "USD")
        return self.project_summary(principal, pid)

    def create_branch(self, principal: str, pid: str, body: dict) -> dict:
        self._require_access(principal, pid, body.get("parent_branch_id") or "main")
        bid = body.get("branch_id") or ""
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
        return {"request": full, "response": self.engine.dispatch(full, principal, manual_candidate=manual)}

    def records(self, pid: str, branch: str, query: dict) -> list[dict]:
        module = (query.get("module") or [None])[0]
        kind = (query.get("kind") or [None])[0]
        sets = (query.get("set") or [None])[0]
        recs = self.store.list_records(pid, branch, module_id=module, record_kind=kind)
        if sets:
            recs = [r for r in recs if r["module_id"][0] == sets]
        return [self.record_summary(r) for r in recs]

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
        label = headers.get("X-Filename") or "upload"
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
        if not self.store.has_scope(principal, pid, "main", "I11:create"):
            raise ApiError(403, "PERMISSION_DENIED", "", "missing scope for backup")
        dest = self.store.data_dir / "backups" / utcnow().replace(":", "").replace(".", "")
        manifest = self.store.backup(dest)
        problems = Store.verify_backup(dest)
        return {"path": str(dest), "manifest": manifest, "verified": not problems, "problems": problems}


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"Bookforge/{__version__}"

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
            csp = ("default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; "
                   "script-src 'self'; connect-src 'self'; object-src 'self' blob:; frame-src 'self' blob:")
            self._send(200, target.read_bytes(), ctype, {"Content-Security-Policy": csp})

        def _handle(self, method: str):
            url = urlparse(self.path)
            if not url.path.startswith("/api/"):
                if method == "GET":
                    return self._static(url.path)
                return self._send(405, {"errors": [error("INVALID_INPUT", url.path, "method not allowed")]})
            try:
                principal = app.authenticate(self.headers.get("Authorization"))
                length = int(self.headers.get("Content-Length") or 0)
                if length > MAX_BODY:
                    raise ApiError(413, "INVALID_INPUT", "/body", "body too large")
                raw = self.rfile.read(length) if length else b""
                body = None
                if raw:
                    ctype = (self.headers.get("Content-Type") or "").split(";")[0]
                    if ctype == "application/json":
                        try:
                            body = json.loads(raw.decode("utf-8"))
                        except ValueError:
                            raise ApiError(400, "INVALID_INPUT", "/body", "invalid JSON")
                    else:
                        body = raw
                status, payload = app.route(method, url.path, parse_qs(url.query), body, principal, self.headers)
                if isinstance(payload, tuple) and payload and payload[0] == "__binary__":
                    _, mime, data, name = payload
                    return self._send(200, data, mime, {"Content-Disposition": f'inline; filename="{name}"'})
                self._send(status, payload)
            except ApiError as exc:
                self._send(exc.status, exc.body)
            except BookforgeError as exc:
                code = exc.code
                status = {"NOT_FOUND": 404, "PERMISSION_DENIED": 403, "VERSION_CONFLICT": 409}.get(code, 400)
                self._send(status, {"errors": exc.errors})
            except Exception as exc:  # noqa: BLE001
                log.error("unhandled error: %s\n%s", exc, traceback.format_exc())
                self._send(500, {"errors": [error("INTERNAL_ERROR", "", "internal error; see server log")]})

        def do_GET(self):
            self._handle("GET")

        def do_POST(self):
            self._handle("POST")

        def do_PUT(self):
            self._handle("PUT")

    return Handler


def default_data_dir() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        return base / "Bookforge"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "bookforge"


def main(argv=None):
    ap = argparse.ArgumentParser(prog="bookforge", description="Bookforge book production workspace")
    ap.add_argument("--data-dir", default=os.environ.get("BOOKFORGE_DATA") or str(default_data_dir()))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("BOOKFORGE_PORT", "8765")))
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        log.warning("Binding to %s exposes the workspace beyond this computer; keep the token private.", args.host)
    app = App(args.data_dir)
    try:
        httpd = ThreadingHTTPServer((args.host, args.port), make_handler(app))
    except OSError as exc:
        print(f"Could not start on {args.host}:{args.port}: {exc}. Try --port 8766.", file=sys.stderr)
        return 2
    url = f"http://{args.host}:{args.port}/#token={app.token}"
    print(f"Bookforge {__version__} running. Data: {args.data_dir}")
    print(f"Open: {url}")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("Stopping Bookforge.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
