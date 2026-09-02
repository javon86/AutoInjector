#!/usr/bin/env python3
"""interpreter_shim.py — a tiny bridge so a real Open Interpreter speaks
AutoInjector's contract.

AutoInjector's built-in adapter POSTs {task, auto_run} and reads a stream of
newline-delimited JSON events. Open Interpreter's Python package already streams
events in exactly the shape AutoInjector normalizes ("lmc" chunks:
{role, type, content, format?, start?, end?}), so this shim is almost pure
plumbing: run interpreter.chat(..., stream=True) and forward each chunk as one
JSON line, then a final {"type":"done"}.

No third-party web framework — just the standard library + open-interpreter.

Run it:
    pip install open-interpreter
    python interpreter_shim.py --port 8231

Point it at a LOCAL model (no cloud, matches AutoInjector's ethos), e.g. Ollama:
    INTERPRETER_MODEL=ollama/llama3.1 INTERPRETER_API_BASE=http://localhost:11434 \
        python interpreter_shim.py --port 8231

Then in AutoInjector set AUTOINJECTOR_INTERPRETER_ENDPOINT=http://127.0.0.1:8231/run
(or let AutoInjector auto-spawn this shim — see integrations/open-interpreter/README.md).

Safety: auto_run is OFF unless the request asks for it (or SHIM_AUTO_RUN=1). With
auto_run off, Open Interpreter emits a "confirmation" event and waits — the
caller decides. Bind is localhost-only.
"""
import argparse
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _load_interpreter(auto_run: bool):
    """Import and configure a fresh Open Interpreter instance."""
    try:
        from interpreter import interpreter  # Open Interpreter (Python package)
    except Exception as exc:  # pragma: no cover - depends on the user's install
        raise RuntimeError(
            "open-interpreter is not installed. Run: pip install open-interpreter"
        ) from exc
    interpreter.auto_run = bool(auto_run) or os.environ.get("SHIM_AUTO_RUN") == "1"
    # Optional local-model config, so it can run fully offline via Ollama/LM Studio.
    model = os.environ.get("INTERPRETER_MODEL")
    api_base = os.environ.get("INTERPRETER_API_BASE")
    api_key = os.environ.get("INTERPRETER_API_KEY")
    try:
        if model:
            interpreter.llm.model = model
        if api_base:
            interpreter.llm.api_base = api_base
        if api_key:
            interpreter.llm.api_key = api_key
    except Exception:
        pass  # older/newer OI may name these differently; run with its defaults
    return interpreter


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _headers(self, code=200, ctype="application/x-ndjson"):
        # Close the connection after each response. The /run body is streamed with
        # no Content-Length, so a strict HTTP/1.1 client (e.g. Node's http) would
        # otherwise wait forever for more data on a kept-alive socket. Closing
        # signals end-of-response cleanly to any client.
        self.close_connection = True
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/") in ("", "/health"):
            self._headers(200, "application/json")
            self.wfile.write(b'{"ok":true,"service":"interpreter-shim"}')
        else:
            self._headers(404, "application/json")
            self.wfile.write(b'{"ok":false,"error":"NOT_FOUND"}')

    def do_POST(self):  # noqa: N802
        if self.path.rstrip("/") != "/run":
            self._headers(404, "application/json")
            self.wfile.write(b'{"ok":false,"error":"NOT_FOUND"}')
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._headers(400, "application/json")
            self.wfile.write(b'{"ok":false,"error":"BAD_JSON"}')
            return
        task = (body.get("task") or body.get("text") or "").strip()
        if not task:
            self._headers(400, "application/json")
            self.wfile.write(b'{"ok":false,"error":"NEED_TASK"}')
            return

        self._headers(200)

        def emit(obj):
            try:
                self.wfile.write((json.dumps(obj) + "\n").encode("utf-8"))
                self.wfile.flush()
            except Exception:
                raise

        try:
            interp = _load_interpreter(bool(body.get("auto_run")))
            for chunk in interp.chat(task, stream=True, display=False):
                # Chunks are already AutoInjector's native shape; forward as-is.
                if isinstance(chunk, dict):
                    emit(chunk)
                else:
                    emit({"role": "assistant", "type": "message", "content": str(chunk)})
            emit({"type": "done"})
        except Exception as exc:
            emit({"type": "error", "content": str(exc)})
            emit({"type": "done"})

    def log_message(self, *args):  # silence default request logging
        return


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("SHIM_PORT", "8231")))
    parser.add_argument("--host", default=os.environ.get("SHIM_HOST", "127.0.0.1"))
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"interpreter-shim listening on http://{args.host}:{args.port} (POST /run)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    sys.exit(main())
