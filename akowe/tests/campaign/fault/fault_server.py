"""Subprocess BookForge server for crash tests: the real App + HTTP handler with the deterministic fake AI.

Usage: python fault_server.py <data_dir> <token> [--kill-after-commit N] [--kill-before-commit N] [--kill-when SQL]
Prints "PORT <n>" when it listens. With --kill-after-commit N the process SIGKILLs itself right after the N-th
committed SQLite transaction (counted from the moment the HTTP server is up); --kill-before-commit N kills it inside
the N-th transaction just before COMMIT (the WAL then holds an uncommitted transaction); --kill-when SQL kills it
after the first commit for which the SQL's first column is true (a deterministic "crash exactly here")."""
from __future__ import annotations

import argparse
import os
import signal
import sys
import threading
import time
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
TESTS = HERE.parent.parent
ROOT = TESTS.parent
for p in (str(ROOT), str(TESTS)):
    if p not in sys.path:
        sys.path.insert(0, p)

from http.server import ThreadingHTTPServer  # noqa: E402

from bookforge import providers as prov_mod  # noqa: E402
from bookforge.jobs import RetryPolicy  # noqa: E402
from bookforge.server import App, make_handler  # noqa: E402

from autobook_fake import BookFakeAI  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data_dir")
    ap.add_argument("token")
    ap.add_argument("--kill-after-commit", type=int, default=0)
    ap.add_argument("--kill-before-commit", type=int, default=0)
    ap.add_argument("--count-file", default="")
    ap.add_argument("--kill-when", default="", help="SQL whose first column is checked after every commit")
    a = ap.parse_args()
    prov_mod.time = types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic, time=time.time)
    app = App(a.data_dir, token=a.token)
    app.engine.providers.secret_path = Path(a.data_dir) / "secrets-test.json"
    app.engine.providers.test_adapter = BookFakeAI()
    app.engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})
    fast = RetryPolicy([0.01, 0.02], 5)
    app.autobook.retry_policy = fast
    app.write_all.retry_policy = fast
    app.assist.retry_policy = fast

    lock = threading.Lock()
    counts = {"after_commit": 0, "before_commit": 0}

    def hook(point):
        with lock:
            counts[point] += 1
            n = counts[point]
            if a.count_file and point == "after_commit":
                Path(a.count_file).write_text(str(n))
        if point == "after_commit" and a.kill_after_commit and n == a.kill_after_commit:
            os.kill(os.getpid(), signal.SIGKILL)
        if point == "after_commit" and a.kill_when and app.store.query_one(a.kill_when)[0]:
            os.kill(os.getpid(), signal.SIGKILL)
        if point == "before_commit" and a.kill_before_commit and n == a.kill_before_commit:
            os.kill(os.getpid(), signal.SIGKILL)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    app.port = httpd.server_address[1]
    app.store.fault_hook = hook
    print(f"PORT {app.port}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
