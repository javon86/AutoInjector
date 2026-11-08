"""🖥 Local AI backup (plan item 5c): Alfred's on-PC AI keeps the checks going while the online AIs are limited.

A long book runs out of ChatGPT / Claude / Gemini usage (usage_limits.py). Before, Akọwe then waited up to 6 hours.
Now, while EVERY web AI is at its usage limit, the cheaper structured jobs go to the local model that AutoInjector's
🎩 Alfred uses (Ollama, on this PC):

* **What it may do (on by default when a model of 7B or more is installed):** the per-chapter consistency review,
  the scene-plan and planned-details checks, the continuity checkpoints and the ending check, the running notes,
  the story-map placement (story shape / kind of story), the trade-fact finder and the research tidy-up, the
  "sounds like AI" read (``CHECK_KINDS``).
* **What it must NOT do by default: write.** Chapters, fixes, rewrites and every other creative job keep waiting for
  an online AI. The setting "Let the local AI write when all online AIs are limited" (``allow_write``, default
  off) changes that, with a plain warning: local models write noticeably worse prose.
* **A private fourth reviewer** (``fourth_reviewer``, default off): after each chapter review by an online AI, the
  local model reads the chapter too. Its opinion is shown next to the review, marked 🖥, and never changes the
  verdict.

**Where the model is.** AutoInjector's service bridge answers ``GET /llm/local`` (Alfred's Ollama address, the
model Alfred uses, its size and its fit rating for this PC — llm-setup.js / llm-hardware.js). Without AutoInjector
Akọwe asks Ollama itself (``AKOWE_OLLAMA_URL`` / ``OLLAMA_HOST``, default http://127.0.0.1:11434, ``GET /api/tags``)
and picks the biggest model between 7B and 14B (14B still fits a 16 GB graphics card), else the biggest one.

**How it answers.** Ollama's OpenAI-compatible endpoint (``POST /v1/chat/completions``, JSON mode). The answer is
checked with the very same JSON schema as an online AI's; a broken answer is asked again ONCE with the errors; still
broken → the job falls back to waiting for the online AIs, exactly as before.

**Marked everywhere.** Its results carry the slot ``LOCAL`` and the name "🖥 Local AI" (reviews, reports, the
activity strip: "🖥 Local AI is doing the checks while Claude rests until 3:45 PM"). It is its own AI family, so the
writer-can't-review rule holds: the local model never reviews what it wrote itself.

Never logs prompts, answers or book text — only model names, sizes, codes and timings.
"""
from __future__ import annotations

import contextvars
import json
import logging
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager

from . import ai_activity, usage_limits
from .errors import AkoweError

log = logging.getLogger("akowe.local_ai")

LOCAL_SLOT = "LOCAL"
LOCAL_FAMILY = "local"
LOCAL_NAME = "🖥 Local AI"
DEFAULT_OLLAMA = "http://127.0.0.1:11434"
SETTINGS_KEY = "local_ai"
MIN_PARAMS_B = 7.0            # recommended size for the checks
MAX_AUTO_PARAMS_B = 14.0      # the automatic pick stays at or under this (fits a 16 GB card at 4 bits)
STATUS_TTL_S = 60.0
CALL_TIMEOUT_S = 600.0        # a local 7-14B model reading a chapter can take minutes on a mid-range card
PROBE_TIMEOUT_S = 2.5
USABLE_FITS = ("excellent", "good", "ok")
WRITE_WARNING = ("Local models write noticeably worse prose than ChatGPT, Claude or Gemini. Turn this on only if "
                 "you would rather have a weaker chapter now than wait for an online AI to reset.")

# The jobs the local model may take while every online AI is limited (job kinds of assist.Job / review.ReviewJob).
CHECK_KINDS = frozenset((
    "review",            # the per-chapter consistency review (and a draft's review)
    "scenes_check",      # checking scene plans
    "planned_check",     # checking a chapter against its plan (no-AI + light-AI check)
    "checkpoint",        # continuity checkpoints and the all-AI chapter checks
    "ending_check",      # the open promises at the end
    "continuity_track",  # the running notes
    "story_shape", "story_kind",   # story-map tracking: where the beats / stages fall
    "facts_find", "facts_research",  # trade facts and the research note tidy-up
    "originality_read",  # the "sounds like AI" read
))
CHECK_WORDS = "the checks"

_lock = threading.RLock()
_cache: dict = {}
_in_assist: contextvars.ContextVar[bool] = contextvars.ContextVar("akowe_local_in_assist", default=False)


# ====================================================================== settings
def settings(store) -> dict:
    s = store.get_setting(SETTINGS_KEY) or {}
    s = s if isinstance(s, dict) else {}
    return {"enabled": s.get("enabled") if isinstance(s.get("enabled"), bool) else None,
            "model": s.get("model") if isinstance(s.get("model"), str) and s.get("model") else None,
            "allow_write": bool(s.get("allow_write")), "fourth_reviewer": bool(s.get("fourth_reviewer"))}


def save_settings(store, body) -> dict:
    if not isinstance(body, dict):
        raise AkoweError("INVALID_INPUT", "", "the Local AI backup settings must be an object", status="REJECTED")
    cur = settings(store)
    for k in ("enabled", "allow_write", "fourth_reviewer"):
        if k in body:
            if body[k] is None and k == "enabled":
                cur[k] = None  # back to automatic
                continue
            if not isinstance(body[k], bool):
                raise AkoweError("INVALID_INPUT", f"/{k}", f"{k}: true or false", status="REJECTED")
            cur[k] = body[k]
    if "model" in body:
        m = body["model"]
        if m in (None, ""):
            cur["model"] = None
        elif not isinstance(m, str) or len(m) > 120 or not re.fullmatch(r"[A-Za-z0-9._:/\-]+", m):
            raise AkoweError("INVALID_INPUT", "/model", "model: an Ollama model name such as qwen2.5:7b",
                             status="REJECTED")
        else:
            cur["model"] = m
    if cur["allow_write"] and body.get("allow_write") is True and body.get("author_confirms") is not True:
        raise AkoweError("APPROVAL_REQUIRED", "/author_confirms", "letting the local AI write needs your explicit "
                         "confirmation (author_confirms: true): " + WRITE_WARNING, status="REJECTED")
    store.set_setting(SETTINGS_KEY, dict(cur, at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
    forget()
    return cur


# ====================================================================== finding Ollama and the model
def params_of(name: str, details: dict | None = None) -> float | None:
    """Billions of parameters from Ollama's ``details.parameter_size`` ("7.6B", "500M") or the name ("qwen2.5:14b")."""
    ps = (details or {}).get("parameter_size") if isinstance(details, dict) else None
    for src in (ps, name):
        if not isinstance(src, str):
            continue
        m = re.search(r"(\d+(?:\.\d+)?)\s*([bm])\b", src.lower())
        if m:
            v = float(m.group(1))
            return round(v / 1000.0, 2) if m.group(2) == "m" else v
    return None


def ollama_base() -> str:
    raw = os.environ.get("AKOWE_OLLAMA_URL") or os.environ.get("OLLAMA_HOST") or DEFAULT_OLLAMA
    raw = raw.strip().rstrip("/")
    if not raw.startswith("http"):
        raw = "http://" + raw
    if raw.endswith("/v1"):
        raw = raw[:-3]
    return raw


def _local_url(url: str) -> str | None:
    """Only addresses on this computer (the local model never leaves the PC)."""
    try:
        from urllib.parse import urlparse  # noqa: PLC0415
        u = urlparse(url)
        if u.scheme == "http" and u.hostname in ("127.0.0.1", "localhost", "::1") and not u.username:
            return f"http://{u.hostname}" + (f":{u.port}" if u.port else "")
    except ValueError:
        pass
    return None


def _get_json(url: str, timeout: float, token: str | None = None) -> dict | None:
    req = urllib.request.Request(url, method="GET", headers={"Accept": "application/json"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as r:
            out = json.loads(r.read(4 * 1024 * 1024).decode("utf-8"))
            return out if isinstance(out, dict) else None
    except (urllib.error.URLError, OSError, ValueError, socket.timeout, TimeoutError, UnicodeDecodeError):
        return None


def _from_bridge(app) -> dict | None:
    """AutoInjector's view (``GET /llm/local``): Alfred's endpoint, model, size and fit rating, or None."""
    try:
        from . import forge  # noqa: PLC0415
        targets = forge.bridge_targets(app)
    except Exception:  # noqa: BLE001 - a hint only
        return None
    for url, token in targets:
        d = _get_json(url + "/llm/local", PROBE_TIMEOUT_S, token)
        if d and d.get("ok") is not False and "found" in d:
            return d
    return None


def _from_ollama(base: str) -> dict:
    d = _get_json(base + "/api/tags", PROBE_TIMEOUT_S)
    if d is None:
        return {"found": False, "endpoint": base, "models": []}
    models = []
    for m in d.get("models") or []:
        if isinstance(m, dict) and isinstance(m.get("name") or m.get("model"), str):
            name = m.get("name") or m.get("model")
            if "embed" in name.lower():
                continue  # an embedding model cannot answer
            models.append({"name": name, "params_b": params_of(name, m.get("details")), "fit": None})
    return {"found": True, "endpoint": base, "models": models}


def _pick(models: list[dict], prefer: str | None) -> dict | None:
    if not models:
        return None
    if prefer:
        hit = next((m for m in models if m["name"] == prefer), None)
        if hit:
            return hit

    def size(m):
        return m.get("params_b") or 0.0
    usable = [m for m in models if not (m.get("fit") or {}).get("rating") in ("too-big", "slow")]
    pool = usable or models
    mid = [m for m in pool if MIN_PARAMS_B <= size(m) <= MAX_AUTO_PARAMS_B]
    if mid:
        return max(mid, key=size)
    return max(pool, key=size)


def forget() -> None:
    with _lock:
        _cache.clear()


def status(app, *, fresh: bool = False) -> dict:
    """Is Ollama there, which model, is it good enough, is the backup on? Cached for a minute. Never raises."""
    with _lock:
        hit = _cache.get("status")
        if hit and not fresh and time.monotonic() - hit[0] < STATUS_TTL_S:
            return dict(hit[1], settings=settings(app.store))
    s = settings(app.store)
    br = _from_bridge(app)
    alfred_model = None
    if br and br.get("found"):
        endpoint = _local_url(str(br.get("endpoint") or "").rstrip("/").removesuffix("/v1")) or ollama_base()
        models = [{"name": m.get("name"), "params_b": m.get("params_b") if isinstance(m.get("params_b"), (int, float))
                   else params_of(str(m.get("name") or "")), "fit": m.get("fit") if isinstance(m.get("fit"), dict)
                   else None} for m in (br.get("models") or []) if isinstance(m, dict) and m.get("name")]
        alfred_model = br.get("model") if isinstance(br.get("model"), str) else None
        if alfred_model and not any(m["name"] == alfred_model for m in models):
            models.append({"name": alfred_model, "params_b": br.get("params_b") or params_of(alfred_model),
                           "fit": br.get("fit") if isinstance(br.get("fit"), dict) else None})
        found = {"found": True, "endpoint": endpoint, "models": models, "source": "autoinjector"}
    else:
        found = dict(_from_ollama(ollama_base()), source="ollama")
    pick = _pick(found["models"], s["model"] or alfred_model)
    params = pick.get("params_b") if pick else None
    fit = (pick or {}).get("fit") or None
    good = bool(pick) and (params or 0) >= MIN_PARAMS_B and (not fit or fit.get("rating") in USABLE_FITS + ("unknown",))
    enabled = s["enabled"] if s["enabled"] is not None else good
    out = {"found": bool(found["found"]), "endpoint": found["endpoint"], "source": found.get("source"),
           "model": pick["name"] if pick else None, "params_b": params, "fit": fit, "alfred_model": alfred_model,
           "models": found["models"][:30], "good_enough": good, "enabled": bool(enabled and pick),
           "min_params_b": MIN_PARAMS_B, "write_warning": WRITE_WARNING, "words": _words(found, pick, good, enabled)}
    with _lock:
        _cache["status"] = (time.monotonic(), out)
    return dict(out, settings=s)


def _words(found, pick, good, enabled) -> str:
    if not found["found"]:
        return ("Ollama was not found on this PC, so there is no local AI backup. In AutoInjector: 🎩 Alfred → "
                "Set up Alfred's brain (it installs Ollama and a model).")
    if not pick:
        return ("Ollama is running but has no model yet. In AutoInjector: 🎩 Alfred → Set up Alfred's brain → "
                "download a model (7B or bigger is recommended for the checks).")
    size = f" ({pick['params_b']:g}B)" if pick.get("params_b") else ""
    if not good:
        return (f"The local model {pick['name']}{size} is small: checks made with it are weak. A model of "
                f"{MIN_PARAMS_B:g}B or more is recommended (🎩 Alfred → models).")
    return (f"Ready: {pick['name']}{size} can do the checks while the online AIs are limited."
            + ("" if enabled else " (switched off)"))


# ====================================================================== asking the local model
def chat_json(st: dict, system: str, user: str, schema: dict, *, timeout_s: float = CALL_TIMEOUT_S) -> tuple:
    """One JSON answer from the local model, checked with ``schema``; a broken answer is asked again once.
    Returns (data, usage) or raises AkoweError (LOCAL_UNREACHABLE / LOCAL_BAD_JSON)."""
    from .providers import AutoInjectorAdapter, _sanitize_schema, extract_json_object, schema_errors  # noqa: PLC0415
    import copy  # noqa: PLC0415
    schema = _sanitize_schema(copy.deepcopy(schema))
    errors: list[str] = []
    t0 = time.monotonic()
    for attempt in range(2):
        prompt = AutoInjectorAdapter.build_prompt(system, user, schema, errors or None)
        text = _complete(st, prompt, timeout_s)
        data = extract_json_object(text)
        errors = ["/: the reply contained no JSON object"] if data is None else schema_errors(schema, data)
        log.info("local AI model=%s attempt=%s chars_out=%s outcome=%s elapsed=%.1fs", st.get("model"), attempt + 1,
                 len(text), "ok" if not errors else "schema_invalid", time.monotonic() - t0)
        if not errors:
            return data, {"model": f"ollama:{st.get('model')}", "input_tokens": len(prompt) // 4,
                          "output_tokens": len(text) // 4, "provider_request_id": None}
    raise AkoweError("INTERNAL_ERROR", "", "the local AI did not return JSON matching the output schema after 2 "
                     "tries; Akọwe waits for an online AI instead. Last errors: " + "; ".join(errors[:3]))


def _complete(st: dict, prompt: str, timeout_s: float) -> str:
    base = _local_url(st.get("endpoint") or "") or ollama_base()
    body = {"model": st.get("model"), "stream": False, "temperature": 0.2,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": "You answer with one JSON object only."},
                         {"role": "user", "content": prompt}]}
    req = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps(body).encode("utf-8"),
                                 method="POST", headers={"Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout_s) as r:
            out = json.loads(r.read(16 * 1024 * 1024).decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise AkoweError("UPSTREAM_UNAVAILABLE", "", f"the local AI answered HTTP {exc.code}") from None
    except (urllib.error.URLError, OSError, socket.timeout, TimeoutError):
        raise AkoweError("UPSTREAM_UNAVAILABLE", "", "the local AI (Ollama) could not be reached") from None
    except (ValueError, UnicodeDecodeError):
        raise AkoweError("INTERNAL_ERROR", "", "the local AI sent an unreadable answer") from None
    try:
        text = out["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        text = None
    if not isinstance(text, str):
        raise AkoweError("INTERNAL_ERROR", "", "the local AI sent an answer without text")
    return text


# ====================================================================== covering for the online AIs
def limited(exc, prov=None) -> dict | None:
    """The usage-limit record when this error means "every online AI is at its usage limit", else None."""
    if not isinstance(exc, AkoweError) or exc.code not in ("UPSTREAM_UNAVAILABLE", "RATE_LIMITED"):
        return None
    lim = usage_limits.of_error(exc)
    if lim is not None:
        return lim
    if prov is None:
        return None
    try:  # no fresh note (the work never reached a call): read the slots' own states
        rows = [prov.slot_status(s) for s in prov.ai_slots()]
    except Exception:  # noqa: BLE001
        return None
    if rows and all(usage_limits.is_limit_problem(r.get("problem")) for r in rows):
        resets = [r.get("reset_at") for r in rows if isinstance(r.get("reset_at"), (int, float))]
        return {"names": [r["name"] for r in rows], "reset_at": min(resets) if resets else None}
    return None


def cover_message(lim: dict | None, what: str = CHECK_WORDS) -> str:
    names = [str(n).split(" · ")[-1] for n in (lim or {}).get("names") or []]
    who = names[0] if len(names) == 1 else "the online AIs" if not names else ", ".join(names[:-1]) + " and " + names[-1]
    verb = "rests" if len(names) == 1 else "rest"
    reset = (lim or {}).get("reset_at")
    until = f" until {usage_limits.clock(reset)}" if isinstance(reset, (int, float)) and reset > time.time() else ""
    return f"{LOCAL_NAME} is doing {what} while {who} {verb}{until}"


@contextmanager
def assist_scope():
    """Inside an assist job: the job-level cover decides (providers.generate does not cover again)."""
    tok = _in_assist.set(True)
    try:
        yield
    finally:
        _in_assist.reset(tok)


def in_assist() -> bool:
    return _in_assist.get()


def _ask(app_like, st: dict, system: str, user: str, schema: dict, lim: dict | None, what: str):
    ai_activity.call_started(LOCAL_SLOT, f"{LOCAL_NAME} ({st.get('model')})")
    _safe_note(cover_message(lim, what))
    try:
        out = chat_json(st, system, user, schema)
    except BaseException as exc:
        ai_activity.call_ended(exc)
        raise
    ai_activity.call_ended(None)
    return out


def _safe_note(message: str) -> None:
    try:
        ai_activity.note_local(message)
    except Exception:  # noqa: BLE001 - a display hint
        pass


def _prompt(task: str, context: dict, protected: list) -> tuple[str, str]:
    from .providers import ProviderRegistry  # noqa: PLC0415
    return ProviderRegistry.build_messages(task, context, protected)


def cover_job(assist, job, exc, *, op_for_roles: str, task: str, schema: dict, context: dict,
              protected: list) -> dict | None:
    """An assist / review job whose AI call failed because every online AI is limited: the local model answers when
    the job may use it. Returns the data, or None (the caller raises the original error: the work waits)."""
    try:
        prov = assist._providers(job)  # noqa: SLF001
    except Exception:  # noqa: BLE001
        prov = None
    lim = limited(exc, prov)
    if lim is None:
        return None
    store = assist.store
    st = status(_AppView(assist))
    if not st["enabled"] or not st["model"]:
        return None
    writing = job.kind not in CHECK_KINDS
    if writing and not st["settings"]["allow_write"]:
        log.info("local AI: job kind %s is writing; it waits for an online AI (the setting is off)", job.kind)
        return None
    if LOCAL_SLOT in (getattr(job, "avoid_slots", None) or []) or LOCAL_FAMILY in (getattr(job, "avoid_families",
                                                                                         None) or set()):
        log.info("local AI: it wrote this draft, so it does not review it (writer-can't-review rule)")
        return None
    system, user = _prompt(task, context, protected)
    try:
        data, usage = _ask(store, st, system, user, schema, lim, "the writing" if writing else CHECK_WORDS)
    except AkoweError as e:
        log.warning("local AI could not cover %s (%s); waiting for an online AI", job.kind, e.code)
        return None
    job.slot, job.slot_label, job.model = LOCAL_SLOT, f"{LOCAL_NAME} ({st['model']})", usage["model"]
    job.local_ai = True
    job.calls = getattr(job, "calls", 0) + 1
    return data


def cover_generate(registry, ctx, exc, *, task: str, output_schema: dict, context: dict,
                   protected_facts: list) -> tuple | None:
    """providers.generate outside an assist job (an engine operation: a chapter, the premise …) — that is writing,
    so only with ``allow_write``. Returns (data, resource) or None."""
    if in_assist():
        return None
    lim = limited(exc, registry)
    if lim is None:
        return None
    st = status(_AppView(registry))
    if not (st["enabled"] and st["model"] and st["settings"]["allow_write"]):
        return None
    system, user = _prompt(task, context, protected_facts)
    try:
        data, usage = _ask(registry.store, st, system, user, output_schema, lim, "the writing")
    except AkoweError as e:
        log.warning("local AI could not write %s (%s); waiting for an online AI", getattr(ctx, "op_id", "?"), e.code)
        return None
    from .providers import estimate_tokens, utcnow  # noqa: PLC0415
    resource = {"resource_kind": "AI", "ai_slot": LOCAL_SLOT, "adapter_id": "ollama", "model": usage["model"],
                "input_tokens": usage["input_tokens"], "output_tokens": usage["output_tokens"],
                "context_tokens_estimate": estimate_tokens(system + user), "provider_request_id": None,
                "local_ai": True, "at": utcnow()}
    return data, resource


def private_review(store, app_like, *, task: str, schema: dict, context: dict, protected: list,
                   writer_slot: str | None) -> dict | None:
    """🖥 The optional private fourth reviewer: the local model's own read of a chapter, kept next to the review and
    never changing its verdict. None when it is off, missing, or it wrote the chapter."""
    if not settings(store)["fourth_reviewer"] or writer_slot == LOCAL_SLOT:
        return None  # off (the default) — no look for Ollama at all
    st = status(app_like)
    if not (st["settings"]["fourth_reviewer"] and st["model"] and st["found"]):
        return None
    if writer_slot == LOCAL_SLOT:
        return None  # writer-can't-review
    system, user = _prompt(task, context, protected)
    try:
        data, usage = _ask(store, st, system, user, schema, None, "a private second read")
    except AkoweError as e:
        log.warning("the private local review was skipped (%s)", e.code)
        return {"skipped": True, "local_ai": True, "reviewer": LOCAL_NAME,
                "message": "The local AI could not read this chapter this time (no usable answer)."}
    keep = {k: data.get(k) for k in ("verdict", "summary", "reasons", "suggested_changes", "confidence")
            if k in data}
    return dict(keep, local_ai=True, private=True, reviewer=f"{LOCAL_NAME} ({st['model']})", model=usage["model"],
                at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))


class _AppView:
    """status() needs ``store`` and the bridge settings (``engine.providers``): give it from a service."""

    def __init__(self, svc):
        eng = getattr(svc, "engine", None)
        self.store = svc.store
        if eng is None:  # a ProviderRegistry
            self.engine = type("E", (), {"providers": svc})()
        else:
            self.engine = eng


def app_view(svc) -> _AppView:
    return _AppView(svc)


# ====================================================================== the 🖥 Local AI backup card
def route(app, method: str, rest: list, body) -> tuple[int, dict]:
    """/api/settings/local-ai (GET: status + settings; PUT: settings; POST /check: look again now)."""
    if rest == [] and method == "GET":
        return 200, status(app)
    if rest == [] and method == "PUT":
        save_settings(app.store, body)
        return 200, status(app, fresh=True)
    if rest == ["check"] and method == "POST":
        return 200, status(app, fresh=True)
    raise AkoweError("NOT_FOUND", "/settings/local-ai", "no such Local AI endpoint", status="REJECTED")
