"""Status push to the AutoInjector desktop app (BookForge side of the shared contract).

When any AI slot uses the ``autoinjector`` adapter with a saved connection key, a daemon thread sends a small
summary of where the most recently opened book stands to ``POST <bridge_url>/v1/status`` with
``Authorization: Bearer <key>``:

    {"app": "bookforge", "version": 1, "bookforge_url": "http://127.0.0.1:<port>/",
     "project": {"id", "title"} | null,
     "current_task": {"set", "op", "title", "state", "message", "url"},
     "working_on": {"op", "title", "started_at"} | null,
     "approvals": {"count", "items": [{"op", "set", "title"}] (max 20), "url"},
     "checklist": [{"id", "title", "set", "state"}], "done", "total", "words": {"total", "target"}, "updated_at"}

Titles only - never chapter text, prompts or keys (canon entries are named by their concept, every other draft by
its step name). Sent on change (at most every 5 s) and as a heartbeat every 30 s; the body stays below 32 KiB.
Errors never reach the author: connection refused/timeouts back off quietly (up to 60 s), HTTP 401 stops pushing
with that key until a new key is saved (pairing again).
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from .providers import DEFAULT_BRIDGE_URL, validate_bridge_url

log = logging.getLogger("bookforge.status_push")

MAX_BODY = 32 * 1024
MIN_GAP_S = 5.0
HEARTBEAT_S = 30.0
MAX_BACKOFF_S = 60.0
STEP_SET = {"profile": None, "canon": "A", "premise": "B", "plot": "B", "outline": "B", "chapters": "C",
            "format": "I", "assemble": "G", "export": "G", "check": "H"}
CHECK_STATE = {"blocked": "waiting"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_summary(app, base_url: str) -> dict:
    """The status body for the most recently opened (non-test) book."""
    base = base_url.rstrip("/") + "/"
    last = app.last_project()
    body = {"app": "bookforge", "version": 1, "bookforge_url": base, "project": None,
            "current_task": {"set": None, "op": None, "title": "Start a new book", "state": "needs_you",
                             "message": "No book is open yet. Open BookForge and start a new book.",
                             "url": base + "#/start"},
            "working_on": app.work.current(None), "approvals": {"count": 0, "items": [], "url": base + "#/"},
            "checklist": [], "done": 0, "total": 0, "updated_at": _now_iso()}
    if not last:
        return body
    pid, branch = last["project_id"], last.get("branch_id") or "main"
    from .book_path import BookPath, get_profile  # noqa: PLC0415
    proj = app.store.project(pid)
    if proj is None:
        return body
    prof = get_profile(app.store, pid)
    status = BookPath(app.engine, app.principal_id, pid, branch).status()
    q = app.review.queue(app.principal_id, pid, branch, status=status)
    task = q["current_task"]
    from urllib.parse import quote  # noqa: PLC0415
    review_url = base + "#/" + "/".join(quote(x, safe="") for x in ("p", pid, branch, "review"))
    body.update({
        "project": {"id": pid, "title": str(prof.get("title") or proj["name"])[:120]},
        "current_task": {"set": task.get("set"), "op": task.get("op"), "title": str(task.get("title"))[:120],
                         "state": task.get("state"), "message": str(task.get("message"))[:300],
                         "url": base + task["hash"].lstrip("/") if task.get("hash") else base},
        "working_on": app.work.current(pid),
        "approvals": {"count": q["count"],
                      "items": [{"op": i["module_id"], "set": i["set"], "title": i["short_title"]}
                                for i in q["items"][:20]], "url": review_url},
        "checklist": [{"id": s["id"], "title": s["title"], "set": STEP_SET.get(s["id"]),
                       "state": CHECK_STATE.get(s["state"], s["state"])} for s in status["steps"]],
        "done": status.get("done_count") or 0, "total": status.get("total") or 0,
        "words": {"total": (status.get("words") or {}).get("words", 0),
                  "target": (status.get("words") or {}).get("target_words", 0)}})
    if body["current_task"]["state"] in ("ai_can", "needs_you") and body["working_on"]:
        body["current_task"]["state"] = "working"
    return body


def encode(body: dict) -> bytes:
    """Compact JSON under 32 KiB (drops approval items and shortens titles if ever needed)."""
    data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) < MAX_BODY:
        return data
    b = json.loads(json.dumps(body))
    for it in b["approvals"]["items"]:
        it["title"] = it["title"][:40]
    for it in b["checklist"]:
        it["title"] = it["title"][:40]
    while len(json.dumps(b, ensure_ascii=False, separators=(",", ":")).encode()) >= MAX_BODY and b["approvals"]["items"]:
        b["approvals"]["items"].pop()
    b["current_task"]["message"] = b["current_task"]["message"][:200]
    return json.dumps(b, ensure_ascii=False, separators=(",", ":")).encode("utf-8")[:MAX_BODY - 1]


class _Target:
    def __init__(self):
        self.sig = None
        self.last = 0.0
        self.fails = 0
        self.next_try = 0.0
        self.stopped = False


class StatusPusher:
    def __init__(self, app, *, interval: float = 1.0, min_gap: float = MIN_GAP_S, heartbeat: float = HEARTBEAT_S,
                 timeout: float = 3.0):
        self.app = app
        self.interval, self.min_gap, self.heartbeat, self.timeout = interval, min_gap, heartbeat, timeout
        self._event = threading.Event()
        self._stop = threading.Event()
        self._thread = None
        self._targets: dict[tuple, _Target] = {}
        self.sent = 0
        self.last_error = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, name="bookforge-status-push", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._event.set()
        if self._thread:
            self._thread.join(5)

    def wake(self):
        self._event.set()

    def targets(self) -> list[tuple[str, str]]:
        prov = self.app.engine.providers
        out = []
        for s in prov.slots():
            if s["adapter_id"] != "autoinjector" or not s.get("has_credentials"):
                continue
            tok = prov._api_key(s["slot_id"])
            try:
                url = validate_bridge_url(s.get("bridge_url") or DEFAULT_BRIDGE_URL)
            except Exception:  # noqa: BLE001
                continue
            if tok and (url, tok) not in out:
                out.append((url, tok))
        return out

    def _loop(self):
        while not self._stop.is_set():
            self._event.wait(self.interval)
            self._event.clear()
            if self._stop.is_set():
                break
            try:
                self.tick()
            except Exception as exc:  # noqa: BLE001 - status is a convenience; never crash
                log.debug("status push skipped: %s", type(exc).__name__)
        try:
            self.app.store.close()
        except Exception:  # noqa: BLE001
            pass

    def tick(self, now: float | None = None) -> int:
        """One round: push to every target that is due. Returns how many pushes were sent."""
        targets = self.targets()
        if not targets:
            return 0
        now = time.monotonic() if now is None else now
        body = build_summary(self.app, self.app.base_url())
        sig = hashlib.sha256(json.dumps({k: v for k, v in body.items() if k != "updated_at"}, sort_keys=True,
                                        default=str).encode()).hexdigest()
        data = encode(body)
        sent = 0
        live = set()
        for url, tok in targets:
            key = (url, hashlib.sha256(tok.encode()).hexdigest()[:16])
            live.add(key)
            st = self._targets.setdefault(key, _Target())
            if st.stopped or now < st.next_try:
                continue
            due = (sig != st.sig and now - st.last >= self.min_gap) or now - st.last >= self.heartbeat or st.last == 0
            if not due:
                continue
            code = self._post(url, tok, data)
            if code == 200 or (code is not None and 200 <= code < 300):
                st.sig, st.last, st.fails, st.next_try = sig, now, 0, 0.0
                sent += 1
                self.sent += 1
            elif code == 401:
                st.stopped = True
                log.info("AutoInjector refused the connection key for status updates; they stay off until you connect "
                         "again")
            else:
                st.fails += 1
                st.next_try = now + min(MAX_BACKOFF_S, 2.0 ** st.fails)
        for k in list(self._targets):
            if k not in live:
                del self._targets[k]
        return sent

    def _post(self, url: str, tok: str, data: bytes) -> int | None:
        req = urllib.request.Request(url + "/v1/status", data=data, method="POST")
        req.add_header("Authorization", f"Bearer {tok}")
        req.add_header("Content-Type", "application/json; charset=utf-8")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(req, timeout=self.timeout) as resp:
                resp.read(4096)
                self.last_error = None
                return resp.status
        except urllib.error.HTTPError as exc:
            self.last_error = f"HTTP {exc.code}"
            return exc.code
        except Exception as exc:  # noqa: BLE001 - refused/timeout: quiet back-off
            self.last_error = type(exc).__name__
            return None
