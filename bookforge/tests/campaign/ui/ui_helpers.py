"""Helpers for the browser-level UI tests (fixtures are re-exported by conftest.py): a real BookForge server (subprocess, temp data dir), an in-process fake AutoInjector
bridge answering with tests/autobook_fake.BookFakeAI, and Playwright Chromium (sync API).

Every `page` is watched: console errors, uncaught exceptions/promise rejections and failed (>=400 / aborted)
requests are collected in `page.bf_problems`; tests call `assert_clean(page)` where a page must be clean.
Screenshots of failures go to $BF_UI_SHOTS (default: <scratchpad>/bft-ui/shots).
"""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]          # bookforge/ (repo dir with bookforge/ package and tests/)
TESTS = ROOT / "tests"
for p in (str(ROOT), str(TESTS)):
    if p not in sys.path:
        sys.path.insert(0, p)

try:
    import playwright.sync_api as pw_sync
except ImportError:  # conftest.py then ignores the UI tests
    pw_sync = None
CHROMIUM = os.environ.get("BF_CHROMIUM", "/opt/pw-browsers/chromium")
SHOTS = Path(os.environ.get("BF_UI_SHOTS", str(ROOT.parent / "shots")))
AVAILABLE = pw_sync is not None and Path(CHROMIUM).exists()

BAD_TEXT = re.compile(r"\bundefined\b|\[object Object\]|\bNaN\b|(?<![\w(-])null(?![\w)-])")
# deliberate wording in the generic forms ("— none (null) —", "Leave empty for null (unknown …)") is BF-11 jargon
OK_NULL = re.compile(r"for null|none \(null\)|null \(unknown")


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ------------------------------------------------------------------------------------------------ fake bridge
class FakeBridge:
    """AutoInjector bridge contract v1 (GET /v1/health, POST /v1/pair, /v1/complete, /v1/status)."""

    def __init__(self):
        from autobook_fake import BookFakeAI  # noqa: PLC0415

        class PoliteFake(BookFakeAI):
            # The B11 prompt says "use null for an undecided POV/location rather than guessing"; the stock fake invents
            # 'gullhaven-harbor' when no place is in context, which approval (rightly) refuses. Follow the prompt.
            def _canon_ids(self, ctx):
                pov, _ = super()._canon_ids(ctx)
                known = ctx.get("known_ids") or {}
                locs = known.get("location_ids") or []
                return pov, (locs[0] if locs else None)
        self.ai = PoliteFake()
        self.delay = 0.0
        self.gate: threading.Event | None = None   # when set to an unset Event, /v1/complete waits for it
        self.completes = 0
        self.statuses: list[dict] = []
        self.prompts: list[str] = []
        self.errors: list[str] = []
        self.cache: dict = {}
        self.lock = threading.Lock()
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        bridge = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                b = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_GET(self):
                if self.path == "/v1/health":
                    return self._send(200, {"ok": True, "bridge_version": "1.1", "sites": {
                        s: {"ready": True, "busy": False} for s in ("chatgpt", "claude", "gemini")}})
                self._send(404, {"ok": False, "error": "NOT_FOUND"})

            def do_POST(self):
                n = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(n) or b"{}")
                if self.path == "/v1/pair":
                    if str(body.get("code", "")).startswith("BAD"):
                        return self._send(401, {"ok": False, "error": "EXPIRED"})
                    return self._send(200, {"ok": True, "token": "fake-token"})
                if self.path == "/v1/status":
                    bridge.statuses.append(body)
                    return self._send(200, {"ok": True})
                if self.path != "/v1/complete":
                    return self._send(404, {"ok": False, "error": "NOT_FOUND"})
                rid = body.get("request_id")
                with bridge.lock:
                    if rid in bridge.cache:
                        return self._send(200, bridge.cache[rid])
                if bridge.gate is not None:
                    bridge.gate.wait(30)
                if bridge.delay:
                    time.sleep(bridge.delay)
                bridge.prompts.append(body.get("prompt", ""))
                try:
                    user, schema = parse_prompt(body["prompt"])
                    out, _ = bridge.ai.submit({"slot_id": body.get("site")}, "", user, schema)
                except Exception as e:  # noqa: BLE001
                    bridge.errors.append(f"{type(e).__name__}: {e}")
                    return self._send(500, {"ok": False, "error": "INTERNAL", "message": str(e)[:200]})
                resp = {"ok": True, "site": body.get("site"), "request_id": rid,
                        "text": "```json\n" + json.dumps(out) + "\n```", "seq": "0001", "elapsed_ms": 1}
                with bridge.lock:
                    bridge.cache[rid] = resp
                    bridge.completes += 1
                self._send(200, resp)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", self.port), H)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        if self.gate is not None:
            self.gate.set()
        self.httpd.shutdown()


def parse_prompt(prompt: str):
    a = prompt.index("\nJSON_SCHEMA:\n")
    b = prompt.index("\nEND_JSON_SCHEMA")
    schema = json.loads(prompt[a + len("\nJSON_SCHEMA:\n"):b])
    pre = prompt[:a]
    marker = "Project context package (JSON):\n"
    i = pre.find(marker)
    dec = json.JSONDecoder()
    pkg = None
    if i >= 0:
        pkg, _ = dec.raw_decode(pre[i + len(marker):])
    else:
        idx = 0
        while True:
            idx = pre.find("\n{", idx)
            if idx < 0:
                break
            try:
                pkg, _ = dec.raw_decode(pre[idx + 1:])
                break
            except ValueError:
                idx += 1
    return "x\n" + json.dumps(pkg or {}), schema


# ------------------------------------------------------------------------------------------------ server
class Server:
    def __init__(self, data_dir: Path, bridge: FakeBridge | None):
        self.data_dir = data_dir
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}/"
        env = dict(os.environ, PYTHONPATH=str(ROOT), PYTHONDONTWRITEBYTECODE="1")
        env.pop("BOOKFORGE_PORT", None)
        self.log = open(data_dir.parent / f"server-{self.port}.log", "w")
        self.proc = subprocess.Popen([sys.executable, "-m", "bookforge", "--port", str(self.port), "--data-dir",
                                      str(data_dir), "--no-browser"], cwd=str(ROOT), env=env,
                                     stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(self.base + "api/ping", timeout=1) as r:
                    if r.status == 200:
                        break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("server did not start: " + (data_dir.parent / f"server-{self.port}.log").read_text())
        self.token = (data_dir / "local_token").read_text().strip()
        if bridge is not None:
            self.api("POST", "/slots/connect-autoinjector", {"token": "fake-token", "bridge_url": bridge.url})

    def api(self, method, path, body=None, expect_ok=True):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + "api" + path, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.token)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(req, timeout=30) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            if expect_ok:
                raise AssertionError(f"{method} {path} -> {e.code}: {e.read()[:500]!r}") from None
            return {"_status": e.code, **json.loads(e.read() or b"{}")}

    @property
    def start_url(self):
        return f"{self.base}#token={self.token}"

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log.close()


@pytest.fixture(scope="session")
def bridge():
    b = FakeBridge()
    yield b
    b.close()


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    """A server with NO AI connected (manual path)."""
    s = Server(tmp_path_factory.mktemp("bfui") / "data", None)
    yield s
    s.close()


@pytest.fixture(scope="module")
def ai_server(tmp_path_factory, bridge):
    """A server whose three AI slots are connected to the fake AutoInjector bridge."""
    s = Server(tmp_path_factory.mktemp("bfui-ai") / "data", bridge)
    yield s
    s.close()


# ------------------------------------------------------------------------------------------------ browser
@pytest.fixture(scope="session")
def browser():
    with pw_sync.sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=CHROMIUM, args=CHROME_ARGS)
        yield b
        b.close()


CHROME_ARGS = ["--no-sandbox", "--no-proxy-server", "--disable-background-networking", "--disable-component-update",
               "--disable-sync", "--disable-default-apps", "--no-first-run", "--disable-features=Translate,AutofillServerCommunication"]
IGNORED_URL = re.compile(r"/favicon")


def watch(page):
    page.bf_problems = []

    def on_console(m):
        if m.type == "error":
            page.bf_problems.append(f"console.error: {m.text}")

    def on_response(r):
        if r.status >= 400 and not IGNORED_URL.search(r.url):
            page.bf_problems.append(f"HTTP {r.status} {r.request.method} {r.url}")

    def on_failed(rq):
        err = rq.failure or ""
        if "ERR_ABORTED" in err:   # navigation-cancelled fetches (AbortController) are expected
            return
        page.bf_problems.append(f"request failed {rq.method} {rq.url}: {err}")

    page.on("console", on_console)
    page.on("pageerror", lambda e: page.bf_problems.append(f"pageerror: {e}"))
    page.on("response", on_response)
    page.on("requestfailed", on_failed)
    page.on("dialog", lambda d: page.bf_dialogs.append(d.message) or d.dismiss())
    page.bf_dialogs = []
    return page


@pytest.fixture
def make_context(browser):
    ctxs = []

    def mk(width=1366, height=900, **kw):
        ctx = browser.new_context(viewport={"width": width, "height": height}, accept_downloads=True, **kw)
        ctxs.append(ctx)
        return ctx
    yield mk
    for c in ctxs:
        c.close()


def open_app(ctx, server, hash_="#/"):
    page = watch(ctx.new_page())
    page.goto(server.start_url)
    page.wait_for_selector("#main h1", timeout=15000)
    if hash_ and hash_ != "#/":
        goto(page, hash_)
    return page


def goto(page, hash_):
    """Route to hash_ and wait until the new view replaced the old one (h1 present, no loading placeholder)."""
    page.evaluate("""h => { for (const c of document.querySelectorAll('#main > *')) c.setAttribute('data-bf-old', '1');
                          if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange'));
                          else location.hash = h; }""", hash_)
    page.wait_for_function("() => !document.querySelector('#main > [data-bf-old]') && document.querySelector('#main h1')",
                           timeout=15000)
    settle(page)


def settle(page, ms=200):
    """Wait until the main view finished rendering (no loading placeholder / spinner in main), then a short pause."""
    page.wait_for_function("() => !document.querySelector('#main .state-loading, #main .state.loading')", timeout=15000)
    page.wait_for_timeout(ms)


def shot(page, name):
    SHOTS.mkdir(parents=True, exist_ok=True)
    p = SHOTS / f"{name}.png"
    page.screenshot(path=str(p), full_page=True)
    return str(p)


def bad_text(page, root="body"):
    """Visible text fragments that look like leaked JS values."""
    txt = page.inner_text(root)
    hits = []
    for m in BAD_TEXT.finditer(txt):
        s = max(0, m.start() - 50)
        if OK_NULL.search(txt[max(0, m.start() - 9):m.end() + 10]):
            continue
        hits.append(txt[s:m.end() + 50].replace("\n", " ⏎ "))
    return hits


def overflow(page):
    return page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")


UNNAMED_JS = """() => {
  const out = [];
  for (const el of document.querySelectorAll('button, a[href], [role=button], input, select, textarea')) {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (!r.width || !r.height || cs.visibility === 'hidden' || el.closest('[hidden], dialog:not([open])')) continue;
    if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) continue;
    if (el.type === 'hidden') continue;
    let name = (el.getAttribute('aria-label') || '').trim();
    if (!name && el.getAttribute('aria-labelledby')) name = el.getAttribute('aria-labelledby').split(/\\s+/)
        .map(id => (document.getElementById(id) || {}).textContent || '').join(' ').trim();
    if (!name && el.labels && el.labels.length) name = Array.from(el.labels).map(l => l.textContent).join(' ').trim();
    if (!name) name = (el.textContent || '').trim();
    if (!name) name = (el.getAttribute('title') || '').trim();
    if (!name && el.tagName === 'INPUT' && ['submit','button'].includes(el.type)) name = el.value;
    if (!name) name = (el.getAttribute('placeholder') || '').trim();
    if (!name) out.push(el.outerHTML.slice(0, 160));
  }
  return out;
}"""


def unnamed_controls(page):
    return page.evaluate(UNNAMED_JS)


def assert_clean(page, what=""):
    probs = list(page.bf_problems)
    page.bf_problems.clear()
    assert not probs, f"{what}: browser problems:\n" + "\n".join(probs)
