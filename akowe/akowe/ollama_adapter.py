"""🖥 A local model through Ollama (adapter ``ollama``): real writing, free, on the author's own PC.

Ollama (https://ollama.com) runs open models such as ``llama3.1:8b`` or ``qwen2.5:14b`` on this computer and answers
on a small local web address (default ``http://localhost:11434``). This adapter uses its HTTP API with the standard
library only (urllib, no new dependency):

* ``POST {base_url}/api/chat`` with ``model``, ``messages`` (system + user), ``stream: false``, ``format: <the JSON
  schema>`` (Ollama's structured outputs: the model can only answer in that shape) and ``options`` (``num_ctx``,
  ``num_predict``, ``temperature``). The answer's ``message.content`` is the JSON; ``submit`` returns
  ``(parsed_json, usage)`` like every other adapter.
* ``GET {base_url}/api/tags`` lists the installed models: "Test connection" says whether Ollama runs and whether the
  slot's model is installed.

Errors are Akọwe's codes with a plain fix: Ollama not running / not reachable and a model that is not installed are
CAPABILITY_UNAVAILABLE ("Start Ollama, then run: ollama pull <model>"), no answer within the slot's time limit is
TIMEOUT, an answer that is not JSON is INTERNAL_ERROR (as for the Anthropic adapter), an answer cut off at the slot's
output limit is CONTEXT_TOO_LARGE. Logs carry codes only, never prompts or answers.

The address is checked by ``validate_ollama_url``: http(s) only, and by default only this computer or the home network
(localhost, 127.x, ::1, private 10.x / 172.16-31.x / 192.168.x addresses, plain computer names, *.local / *.lan
names). Another address on the internet is taken only when the author ticks "I trust this address"
(``confirm_internet_host``).
"""
from __future__ import annotations

import ipaddress
import json
import logging
import socket
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlparse

from .errors import AkoweError

log = logging.getLogger("akowe.ollama")

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_OLLAMA_MODEL = "llama3.1:8b"
SUGGESTED_MODELS = ("llama3.1:8b", "qwen2.5:14b", "mistral-nemo:12b")
DEFAULT_TIMEOUT_S = 900          # a local model writing a chapter on a home PC can take many minutes
MIN_TIMEOUT_S = 1
MAX_TIMEOUT_S = 6 * 3600
# What a local model takes by default when the author set no limits for the slot (tokens): prompt + answer fit in
# a 32 000-token window, which an 8B-14B model runs on a normal PC. Larger instructions are cut to fit, visibly (H13).
DEFAULT_CONTEXT_TOKENS = 24000
DEFAULT_OUTPUT_TOKENS = 8000
MAX_NUM_CTX = 131072
TAGS_TIMEOUT_S = 5.0
LOCAL_SUFFIXES = (".local", ".lan", ".home", ".internal", ".localhost", ".home.arpa")


def _host_is_local(host: str) -> bool:
    """This computer or the home network: loopback / private / link-local IPs, a plain computer name ("mypc"),
    localhost, or a *.local / *.lan-style name. Anything else is a host on the internet."""
    h = (host or "").strip().lower().rstrip(".")
    if not h:
        return False
    if h == "localhost" or h.endswith(LOCAL_SUFFIXES):
        return True
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        return "." not in h  # a plain computer name on the home network
    return ip.is_loopback or ip.is_private or ip.is_link_local


def validate_ollama_url(url: Any, confirm_internet_host: bool = False) -> str:
    """The Ollama address, cleaned: http(s)://host[:port] (no path, query or password). Only this PC / the home
    network unless ``confirm_internet_host`` (the author ticked "I trust this address")."""
    if not isinstance(url, str) or not url.strip():
        raise AkoweError("INVALID_INPUT", "/base_url", "Type the Ollama address, for example "
                         f"{DEFAULT_OLLAMA_URL}", status="REJECTED")
    url = url.strip().rstrip("/")
    try:
        u = urlparse(url)
        port = u.port
    except ValueError as exc:
        raise AkoweError("INVALID_INPUT", "/base_url", "The Ollama address is not a valid web address (example: "
                         f"{DEFAULT_OLLAMA_URL})", status="REJECTED") from exc
    if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password \
            or u.path not in ("", "/") or u.query or u.fragment or u.params:
        raise AkoweError("INVALID_INPUT", "/base_url", "The Ollama address must look like "
                         f"{DEFAULT_OLLAMA_URL} (http:// or https://, a computer name or number, and a port)",
                         status="REJECTED")
    if not _host_is_local(u.hostname) and not confirm_internet_host:
        raise AkoweError("INVALID_INPUT", "/base_url", f"{u.hostname} is on the internet, not on this PC or your "
                         "home network. If you really run Ollama there, tick “I trust this address” and save again.",
                         status="REJECTED")
    host = f"[{u.hostname}]" if ":" in u.hostname else u.hostname
    return f"{u.scheme}://{host}" + (f":{port}" if port else "")


def validate_model(model: Any) -> str:
    if not isinstance(model, str) or not model.strip():
        raise AkoweError("INVALID_INPUT", "/model", f"Type the Ollama model name, for example {DEFAULT_OLLAMA_MODEL}",
                         status="REJECTED")
    m = model.strip()
    if len(m) > 200 or any(c.isspace() for c in m):
        raise AkoweError("INVALID_INPUT", "/model", "The model name has no spaces, for example "
                         f"{DEFAULT_OLLAMA_MODEL}", status="REJECTED")
    return m


def validate_timeout(v: Any) -> int:
    if not isinstance(v, int) or isinstance(v, bool) or not MIN_TIMEOUT_S <= v <= MAX_TIMEOUT_S:
        raise AkoweError("INVALID_INPUT", "/timeout_s", f"The time limit is a whole number of seconds from "
                         f"{MIN_TIMEOUT_S} to {MAX_TIMEOUT_S}", status="REJECTED")
    return v


def model_installed(model: str, names: list[str]) -> bool:
    """Ollama names a model "name:tag"; a model typed without a tag means its ":latest"."""
    m = (model or "").strip()
    want = {m} if ":" in m else {m, f"{m}:latest"}
    return any(n in want for n in names)


def start_fix(model: str | None) -> str:
    return f"Start Ollama, then run: ollama pull {model or DEFAULT_OLLAMA_MODEL}"


def pull_fix(model: str | None) -> str:
    return f"Open a terminal (Command Prompt) and run: ollama pull {model or DEFAULT_OLLAMA_MODEL}"


class OllamaAdapter:
    """One Ollama server. ``submit`` = one chat request (no retries here: the registry's retry policy applies)."""
    adapter_id = "ollama"

    def __init__(self, base_url: str = DEFAULT_OLLAMA_URL, timeout_s: float = DEFAULT_TIMEOUT_S):
        self.base_url = (base_url or DEFAULT_OLLAMA_URL).rstrip("/")
        self.timeout_s = float(timeout_s or DEFAULT_TIMEOUT_S)
        host = urlparse(self.base_url).hostname or ""
        # A local Ollama is never reached through an HTTP(S) proxy from the environment.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({})) if _host_is_local(host) \
            else urllib.request.build_opener()

    def capabilities(self) -> list[str]:
        return ["text", "json"]

    # ------------------------------------------------------------------ HTTP
    def _request(self, method: str, path: str, body: dict | None, timeout_s: float, model: str | None) -> dict:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json; charset=utf-8")
        try:
            with self._opener.open(req, timeout=timeout_s) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            raise self._http_error(exc, model) from None
        except (socket.timeout, TimeoutError) as exc:
            raise self._timeout(timeout_s) from exc
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, (socket.timeout, TimeoutError)):
                raise self._timeout(timeout_s) from exc
            raise self._not_running(model, exc) from exc
        except (ConnectionError, OSError) as exc:
            raise self._not_running(model, exc) from exc
        try:
            out = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise AkoweError("UPSTREAM_UNAVAILABLE", "", f"The program at {self.base_url} did not answer like "
                             "Ollama. Check the address in Settings.") from exc
        if not isinstance(out, dict):
            raise AkoweError("UPSTREAM_UNAVAILABLE", "", f"The program at {self.base_url} did not answer like "
                             "Ollama. Check the address in Settings.")
        return out

    def _timeout(self, timeout_s: float) -> AkoweError:
        return AkoweError("TIMEOUT", "", f"The local model did not answer within {int(timeout_s)} seconds. A big "
                          "model on a home PC can be slow: give it more time in Settings (Time limit), or choose "
                          "a smaller model.")

    def _not_running(self, model: str | None, exc: BaseException) -> AkoweError:
        log.info("ollama not reachable at %s: %s", self.base_url, type(getattr(exc, "reason", exc)).__name__)
        err = AkoweError("CAPABILITY_UNAVAILABLE", "", f"Ollama is not running at {self.base_url} (or this PC "
                         f"cannot reach it). {start_fix(model)}")
        err.fix = start_fix(model)
        return err

    def _http_error(self, exc: urllib.error.HTTPError, model: str | None) -> AkoweError:
        detail = ""
        try:
            body = json.loads(exc.read(65536).decode("utf-8"))
            if isinstance(body, dict) and isinstance(body.get("error"), str):
                detail = body["error"].strip()[:300]
        except Exception:  # noqa: BLE001 - the status code is enough
            pass
        low = detail.lower()
        log.info("ollama answered HTTP %s", exc.code)
        if exc.code == 404 or ("not found" in low and "model" in low):
            err = AkoweError("CAPABILITY_UNAVAILABLE", "", f"The model {model or ''} is not installed in Ollama. "
                             f"{pull_fix(model)}")
            err.fix = pull_fix(model)
            return err
        if "memory" in low:
            return AkoweError("CAPABILITY_UNAVAILABLE", "", f"This PC does not have enough memory for the model "
                              f"{model}. Choose a smaller model (for example {DEFAULT_OLLAMA_MODEL}) in Settings.")
        if exc.code in (400, 422):
            return AkoweError("INVALID_INPUT", "", "Ollama refused the request"
                              + (f" ({detail})" if detail else "") + ". If Ollama is old, update it from ollama.com "
                              "(Akọwe needs structured outputs, Ollama 0.5 or newer).", status="REJECTED")
        if exc.code in (408, 504):
            return self._timeout(self.timeout_s)
        if exc.code in (429, 503):
            return AkoweError("UPSTREAM_UNAVAILABLE", "", "Ollama is busy right now; Akọwe waits and tries again.")
        if exc.code >= 500:
            return AkoweError("UPSTREAM_UNAVAILABLE", "", f"Ollama had a problem (error {exc.code})"
                              + (f": {detail}" if detail else "") + ". Akọwe waits and tries again.")
        return AkoweError("INTERNAL_ERROR", "", f"Ollama answered with error {exc.code}"
                          + (f": {detail}" if detail else ""))

    # ------------------------------------------------------------------ health
    def tags(self, timeout_s: float = TAGS_TIMEOUT_S, model: str | None = None) -> list[str]:
        out = self._request("GET", "/api/tags", None, timeout_s, model)
        names = []
        for m in out.get("models") or []:
            if isinstance(m, dict):
                n = m.get("name") or m.get("model")
                if isinstance(n, str) and n:
                    names.append(n)
        return names

    def health(self, model: str | None, timeout_s: float = TAGS_TIMEOUT_S) -> dict:
        """{ok, running, model, model_installed, models, message, error, fix} in plain words. Never raises for
        Ollama problems (only a broken setting)."""
        model = (model or "").strip() or None
        base = {"base_url": self.base_url, "model": model, "models": [], "running": False, "model_installed": False}
        try:
            names = self.tags(timeout_s, model)
        except AkoweError as exc:
            return dict(base, ok=False, error=exc.code, message=exc.errors[0]["message"],
                        fix=getattr(exc, "fix", None) or start_fix(model))
        installed = bool(model) and model_installed(model, names)
        out = dict(base, running=True, models=sorted(names)[:50], model_installed=installed)
        if installed:
            return dict(out, ok=True, error=None, fix=None,
                        message=f"Ollama is running at {self.base_url} and the model {model} is installed.")
        have = (" Installed now: " + ", ".join(sorted(names)[:8]) + ".") if names else " No model is installed yet."
        return dict(out, ok=False, error="MODEL_NOT_INSTALLED", fix=pull_fix(model),
                    message=f"Ollama is running at {self.base_url}, but the model {model or '(none chosen)'} is not "
                            f"installed.{have} {pull_fix(model)}")

    # ------------------------------------------------------------------ one answer
    def submit(self, slot: dict, system: str, user: str, schema: dict) -> tuple[dict, dict]:
        """One attempt. Returns (parsed_json, usage). Raises classified AkoweError."""
        model = str(slot.get("model") or DEFAULT_OLLAMA_MODEL)
        ctx_tokens = int(slot.get("context_limit_tokens") or DEFAULT_CONTEXT_TOKENS)
        out_tokens = int(slot.get("max_output_tokens") or DEFAULT_OUTPUT_TOKENS)
        timeout_s = float(slot.get("timeout_s") or self.timeout_s)
        body = {"model": model, "stream": False, "format": schema,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                "options": {"num_ctx": max(2048, min(ctx_tokens + out_tokens, MAX_NUM_CTX)),
                            "num_predict": max(256, out_tokens), "temperature": 0.7}}
        res = self._request("POST", "/api/chat", body, timeout_s, model)
        if isinstance(res.get("error"), str):
            low = res["error"].lower()
            if "not found" in low and "model" in low:
                err = AkoweError("CAPABILITY_UNAVAILABLE", "", f"The model {model} is not installed in Ollama. "
                                 f"{pull_fix(model)}")
                err.fix = pull_fix(model)
                raise err
            raise AkoweError("UPSTREAM_UNAVAILABLE", "", "Ollama had a problem answering. Akọwe waits and tries "
                             "again.")
        msg = res.get("message") if isinstance(res.get("message"), dict) else {}
        text = msg.get("content") if isinstance(msg.get("content"), str) else ""
        if res.get("done_reason") == "length":
            raise AkoweError("CONTEXT_TOO_LARGE", "", "The local model's answer was cut off at the slot's Max "
                             "output; raise Max output (tokens) in Settings or choose a model with a larger window.")
        data = None
        try:
            data = json.loads(text)
        except ValueError:
            from .providers import extract_json_object  # noqa: PLC0415 - a model that wrapped the JSON in prose
            data = extract_json_object(text)
            if data is None:
                err = AkoweError("INTERNAL_ERROR", "", "The local model returned invalid JSON. Try again, or "
                                 "choose a larger model in Settings.")
                err.try_other_ai = True
                raise err from None
        if not isinstance(data, dict):
            err = AkoweError("INTERNAL_ERROR", "", "The local model returned JSON that is not an object. Try again, "
                             "or choose a larger model in Settings.")
            err.try_other_ai = True
            raise err
        usage = {"input_tokens": int(res.get("prompt_eval_count") or 0), "output_tokens": int(res.get("eval_count")
                                                                                               or 0),
                 "model": res.get("model") if isinstance(res.get("model"), str) else model,
                 "provider_request_id": None}
        return data, usage
