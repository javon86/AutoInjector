"""AI assist ("Fill with AI") and the Bible Builder.

Both are PROPOSAL services: they ask one AI slot for a CREATE payload of a target operation and
return it for the author to review. Nothing here ever commits a record, except the Bible
Builder's explicit "create selected as drafts" step, which goes through ``engine.dispatch``
CREATE like the workspace form does (DRAFT only; never validated or accepted automatically).

Assist (POST /api/assist): one background job per request. The AI task is built from the
operation's purpose and set rule, its CREATE payload schema (reference objects compacted,
author-only fields such as protected_fact_flags removed), the author's prompt, the values the
author already typed (kept unless a rewrite is asked for) and a compact context: the project's
APPROVED/LOCKED Set A canon (names, IDs, key facts; protected facts verbatim), the names of
draft canon, any records the author picked as context, and the predicate conventions of
plan_rules. The AI is called through ``engine.providers.generate`` (same slots, roles, adapters,
retries and JSON re-asks); an explicitly picked slot is honoured or refused with a fix. The
merged proposal is then checked without committing: the kernel CREATE schema validator, every
Reference resolved against this project/branch (invented or foreign ones removed and reported),
and the owner's deterministic checks (Set A: facts, protected flags, linked authority, op rules).

Bible Builder (POST /api/bible-builder): a session per book idea. Sections (A01-A18, A09 only
when the magic feature is on) are run separately or together; every run first asks for a short
world sketch (names, roles, links by name) and then generates each item through the same
proposal path, so names and subject IDs stay consistent and later runs see earlier items. The
author selects items, may edit them, and creates them as DRAFT records in dependency order so
sketch links become real canonical References (linked_refs). A report (Markdown + JSON) is
written under <data_dir>/reports/bible-builder-<stamp>.* after every run and every create.

Jobs and sessions live in memory with caps and expiry. Prompts, replies and the book idea are
never logged or written to reports (only names, counts, lengths and hashes).
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import CONTRACT_VERSION, __version__
from . import plan_rules as pr
from . import characters as chars_mod
from . import providers as providers_mod
from .canonical import json_pointer
from .errors import BookforgeError
from .jobs import RetryPolicy, slot_word, wait_and_retry
from .modules import get_handler
from .modules.base import Context
from .requests import build_request

log = logging.getLogger("bookforge.assist")

A_OPS = tuple(f"A{i:02d}" for i in range(1, 19))
REF_KEYS = ("project_id", "branch_id", "owner", "module_id", "record_id", "version", "content_hash")
# Fields that are an author decision and never come from a model.
AUTHOR_ONLY = {"protected_fact_flags", "feature_selected"}
MAX_RUNNING_JOBS = 8
MAX_JOBS = 200
JOB_TTL_S = 3600
MAX_SESSIONS = 20
SESSION_TTL_S = 6 * 3600
SLOT_WAIT_S = 600
# Deadline of one AI call. For an AutoInjector slot this becomes the bridge's timeout_ms (contract max 900 s); the
# bridge's late window after a timeout is capped separately (jobs.BRIDGE_LATE_WINDOW_S), so a site is never held
# longer than the busy-retry budget (jobs.DEFAULT_RETRY) other requests wait for it.
AI_DEADLINE_S = 900
MAX_SECTION_COUNT = 12
MAX_RUN_ITEMS = 40
MAX_GUIDANCE = 2000

FIX = {
    "CAPABILITY_UNAVAILABLE": "Connect AutoInjector in Settings, or add an API key.",
    "UPSTREAM_UNAVAILABLE": "Start the AutoInjector desktop app, open and log in to the site's pane, then press "
                            "Test connection in Settings and try again.",
    "TIMEOUT": "The AI did not answer in time. Check the site's pane in AutoInjector (logged in and idle?) and press "
               "Regenerate.",
    "RATE_LIMITED": "The AI is busy with other work. Wait a moment and try again, or pick another AI.",
    "CONTEXT_TOO_LARGE": "Pick fewer context records, or choose an AI slot with a larger context limit in Settings.",
    "NOT_APPLICABLE": "This module is switched off for this branch. Turn the feature on in the feature manifest.",
    "PERMISSION_DENIED": "Open the project you have access to and try again.",
    "INVALID_INPUT": "Check the fields you sent and try again.",
    "MISSING_INPUT": "Fill in the missing field and try again.",
    "NOT_FOUND": "Reload the page; the item may have expired.",
    "CANCELLED": "Press Generate to start again.",
    "INTERNAL_ERROR": "The AI answer could not be used. Press Regenerate; if it keeps failing, try another AI.",
}

SECTION_ORDER = ("A03", "A02", "A04", "A05", "A07", "A08", "A09", "A10", "A16", "A17", "A15", "A06", "A11",
                 "A12", "A01", "A13", "A14", "A18")

PLACEHOLDERS = {
    "A01": "a grumpy lighthouse keeper who hides a secret", "A02": "a tide-dwelling species that sings to navigate",
    "A03": "a storm-wrapped archipelago world with two moons", "A04": "a fog-bound harbor town built on stilts",
    "A05": "a council of harbor masters that rules by tide law", "A06": "a smugglers' guild hiding in plain sight",
    "A07": "a fishing culture that names boats after the dead", "A08": "a faith that worships the lighthouse flame",
    "A09": "magic paid for with memories, limited by moonlight", "A10": "clockwork lanterns that store sunlight",
    "A11": "harpoon duelling with strict honour rules", "A12": "a brass key that opens any lock once",
    "A13": "the night the great lighthouse went dark", "A14": "the order of the founding events",
    "A15": "naming rules for island families", "A16": "an economy built on salt and lamp oil",
    "A17": "laws about salvage from wrecks", "A18": "two rival keepers who were once friends",
    "B01": "a lighthouse keeper's apprentice searches for her missing master",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None = None) -> str:
    return (dt or _now()).strftime("%Y-%m-%dT%H:%M:%SZ")


def _err(code: str, message: str, fix: str | None = None, path: str = "") -> dict:
    return {"code": code, "message": message, "fix": fix or FIX.get(code, FIX["INTERNAL_ERROR"]), "path": path}


def _err_of(exc: BookforgeError) -> dict:
    e = exc.errors[0] if exc.errors else {"code": exc.code, "message": str(exc)}
    return _err(e.get("code") or exc.code, e.get("message") or exc.code, path=e.get("path") or "")


def _empty(v) -> bool:
    return v is None or v == [] or v == {} or (isinstance(v, str) and not v.strip())


def _prune(v):
    """Drop empty strings/None inside objects (blank form fields mean 'not supplied')."""
    if isinstance(v, dict):
        return {k: _prune(x) for k, x in v.items() if not (x is None or (isinstance(x, str) and not x.strip()))}
    return copy.deepcopy(v)


def is_ref_schema(s) -> bool:
    return isinstance(s, dict) and isinstance(s.get("properties"), dict) and all(k in s["properties"] for k in REF_KEYS)


def is_ref(v) -> bool:
    return isinstance(v, dict) and all(k in v for k in REF_KEYS)


def _is_ref_field(s) -> bool:
    if is_ref_schema(s):
        return True
    if isinstance(s, dict) and s.get("type") == "array" and is_ref_schema(s.get("items")):
        return True
    for alt in (s.get("oneOf") or s.get("anyOf") or []) if isinstance(s, dict) else []:
        if is_ref_schema(alt):
            return True
    return False


def slugify(name: str, taken: set) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:40] or "item"
    slug, n = base, 2
    while slug in taken:
        slug, n = f"{base}-{n}", n + 1
    taken.add(slug)
    return slug


def sha16(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()[:16]


# ====================================================================== schema helpers
def payload_schema(contracts, op_id: str) -> dict:
    return contracts.definition(op_id, "CREATE")["properties"]["payload"]


def fillable_fields(contracts, op_id: str) -> list[str]:
    props = payload_schema(contracts, op_id).get("properties", {})
    return [k for k, v in props.items() if k not in AUTHOR_ONLY and not _is_ref_field(v)]


# Sets whose creative CREATE inputs (ideas, briefs, instructions, goals) an AI may propose for review.
# E (state from accepted evidence), H/J (evidence-bound findings) and I/K (infrastructure) never are,
# nor are LOGIC operations; G10's inputs are computed geometry, not prose.
ASSIST_SETS = "ABCDFG"
ASSIST_EXCLUDED = {"G10"}


def supports(contracts, op_id: str) -> bool:
    """Set A always; AI/HYBRID operations of B, C, D, F, G whose CREATE payload has fields an AI can propose."""
    op = contracts.operation(op_id)
    if op is None or op_id[0] not in ASSIST_SETS or op_id in ASSIST_EXCLUDED:
        return False
    if op_id[0] == "A":
        return True
    return bool(op["execution"] in ("AI", "HYBRID", "AI/HYBRID") and fillable_fields(contracts, op_id))


COMPACT_REF = {"type": "object", "properties": {"project_id": {"type": "string"}, "branch_id": {"type": "string"},
                                                "owner": {"type": "string"}, "module_id": {"type": "string"},
                                                "record_id": {"type": "string"}, "version": {"type": "integer"},
                                                "content_hash": {"type": "string"}},
               "required": list(REF_KEYS)}


def _compact(schema):
    """Replace every Reference schema with a small one (the kernel re-checks the full one)."""
    if isinstance(schema, list):
        return [_compact(s) for s in schema]
    if not isinstance(schema, dict):
        return schema
    if is_ref_schema(schema):
        return copy.deepcopy(COMPACT_REF)
    return {k: _compact(v) for k, v in schema.items()}


def ai_schema(contracts, op_id: str) -> dict:
    """CREATE payload schema for the model: author-only fields removed, every fillable field (and
    every narrative attribute) required so the model fills the whole form."""
    src = payload_schema(contracts, op_id)
    props = {k: _compact(v) for k, v in src.get("properties", {}).items() if k not in AUTHOR_ONLY}
    attrs = props.get("attributes")
    if isinstance(attrs, dict) and isinstance(attrs.get("properties"), dict):
        attrs["required"] = list(attrs["properties"])
    fill = [k for k in props if not _is_ref_field(src["properties"][k])]
    # Reference fields stay optional for the model: it may only copy a ref it was given.
    return {"type": "object", "additionalProperties": False, "properties": props, "required": sorted(fill)}


# ====================================================================== context helpers
def book_profile_brief(store, pid: str) -> dict:
    """The author's book profile (title, genre, audience, length, tone, idea) for AI context; never logged."""
    from .book_path import get_profile  # noqa: PLC0415
    try:
        prof = get_profile(store, pid)
    except Exception:  # noqa: BLE001 - context is best effort
        return {}
    out = {k: prof[k] for k in ("title", "genre", "audience", "length", "tone", "idea") if prof.get(k)}
    try:  # P12: the author's ending and style choices (only the ones made; "let the AI choose" says nothing)
        from . import story_choices  # noqa: PLC0415
        sc = story_choices.brief(story_choices.of_profile(prof))
        if sc:
            out["story_choices"] = sc
    except Exception:  # noqa: BLE001 - context is best effort
        pass
    return out



def _fact_line(f: dict) -> str:
    v = f.get("value")
    v = json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v
    when = ""
    if f.get("effective_from") is not None or f.get("effective_to") is not None:
        when = f" [{f.get('effective_from')},{f.get('effective_to')})"
    return f"{f['subject_id']} {f['predicate']} = {v[:120]} ({f['assertion_type']}){when}"


def canon_context(engine, pid: str, branch: str, *, max_approved: int = 80, max_drafts: int = 80):
    """Compact view of the project's Set A canon: approved/locked records in full summary (with
    the exact ref so the model may link them), protected facts verbatim, drafts by name only."""
    store, contracts = engine.store, engine.contracts
    approved, drafts, protected = [], [], []
    for r in store.list_records(pid, branch):
        if not r["module_id"].startswith("A") or r["record_kind"] != "OUTPUT":
            continue
        rec = r
        if r.get("approved_version") and r["approved_version"] != r["version"]:
            rec = store.get_record(pid, branch, r["record_id"], r["approved_version"]) or r
        data = rec.get("data") or {}
        facts = [f for f in data.get("facts") or [] if isinstance(f, dict) and "subject_id" in f]
        names = [f.get("value") for f in facts if f.get("predicate") == "entity.name" and isinstance(f.get("value"), str)]
        if rec["lifecycle"] in ("APPROVED", "LOCKED") or r.get("approved_version"):
            if len(approved) >= max_approved:
                continue
            approved.append({
                "module_id": rec["module_id"], "kind": (contracts.operation(rec["module_id"]) or {}).get("name"),
                "record_id": rec["record_id"], "version": rec["version"], "lifecycle": rec["lifecycle"],
                "ref": rec["ref"], "concept": str(data.get("concept") or "")[:200], "names": names[:6],
                "subject_ids": sorted({f["subject_id"] for f in facts})[:12],
                "key_facts": [_fact_line(f) for f in facts if f.get("assertion_type") == "FACT"][:12]})
            for f in pr.protected_facts(data):
                protected.append(dict(f, source=f"{rec['module_id']}:{rec['record_id']} v{rec['version']}"))
        elif r.get("stale") or rec["lifecycle"] in ("REJECTED", "SUPERSEDED"):
            # a draft set aside (BookForge's checks refused it) is not canon: its name is free for the entry made again
            continue
        elif len(drafts) < max_drafts:
            drafts.append({"module_id": rec["module_id"], "record_id": rec["record_id"],
                           "concept": str(data.get("concept") or "")[:120], "names": names[:4],
                           "subject_ids": sorted({f["subject_id"] for f in facts})[:8]})
    return approved, drafts, protected


def summarize_payload(op_id: str, payload: dict) -> dict:
    """Short readable summary of a proposal (names, a line of description, key facts)."""
    payload = payload or {}
    facts = [f for f in payload.get("facts") or [] if isinstance(f, dict) and "predicate" in f]
    attrs = payload.get("attributes") or {}
    first = next((v for v in attrs.values() if isinstance(v, str) and v.strip()), "") if isinstance(attrs, dict) else ""
    title = payload.get("concept") or payload.get("idea") or payload.get("selected_structure") or op_id
    return {"title": str(title)[:160], "summary": str(first)[:300],
            "key_facts": [_fact_line(f) for f in facts[:5] if "subject_id" in f and "assertion_type" in f]}


def note_writer(store, pid: str, branch: str, record_id: str, version: int, slot: str | None):
    """Remember which AI slot wrote exactly this revision when the kernel cannot tell (a Bible Builder proposal is
    saved as the author's candidate). Settings key ``ai_writers:<pid>:<branch>``; used to pick a different AI as
    reviewer (P3.1). Never holds text."""
    if not slot or slot not in ("AI-1", "AI-2", "AI-3"):
        return
    key = f"ai_writers:{pid}:{branch}"
    try:
        cur = store.get_setting(key) or {}
        cur[f"{record_id}:{version}"] = {"slot": slot, "at": _iso()}
        if len(cur) > 2000:
            for k in sorted(cur, key=lambda k: cur[k].get("at") or "")[:len(cur) - 2000]:
                cur.pop(k, None)
        store.set_setting(key, cur)
    except Exception:  # noqa: BLE001 - a hint for the reviewer choice, never a reason to fail
        log.exception("could not note the writer of %s", record_id)


class _AICtx:
    """The minimum providers.generate needs (it never touches storage)."""

    def __init__(self, project_id: str, branch_id: str, op_id: str, request_id: str):
        self.project_id, self.branch_id, self.op_id = project_id, branch_id, op_id
        self.request = {"request_id": request_id, "deadline": _iso(_now() + timedelta(seconds=AI_DEADLINE_S))}


class Cancelled(Exception):
    pass


# ====================================================================== jobs
class Job:
    def __init__(self, kind: str, principal: str, project_id: str, branch_id: str, op_id: str | None,
                 slot_pref: str | None):
        self.id = f"{kind}-{uuid.uuid4().hex[:16]}"
        self.kind = kind
        self.principal = principal
        self.project_id, self.branch_id, self.op_id = project_id, branch_id, op_id
        self.slot_pref = slot_pref
        self.status = "queued"
        self.phase = "Waiting to start"
        self.created = time.time()
        self.started: float | None = None
        self.finished: float | None = None
        self.cancelled = False
        self.slot = None
        self.slot_label = None
        self.model = None
        self.result: dict | None = None
        self.error: dict | None = None
        self.calls = 0
        self.waiting: dict | None = None   # {"code", "attempt", "retry_in_s", "retry_at", "message"} while waiting
        self.retry_busy: bool | None = None  # None: the service default (AssistService.retry_busy)
        # Automatic choice only (no slot_pref): soft preferences. prefer_slots are tried first when they work;
        # avoid_slots / avoid_families are used only when no other AI works (writer != reviewer, P3.1);
        # cross_pin lets the choice use every slot even when the engine is pinned to the book's AI.
        self.prefer_slots: list[str] = []
        self.avoid_slots: list[str] = []
        self.avoid_families: set = set()
        self.cross_pin = False
        self.failovers: list[dict] = []    # calls moved to another AI because one was not working (P18.9)

    def check(self):
        if self.cancelled:
            raise Cancelled()

    def public(self) -> dict:
        now = self.finished or time.time()
        out = {"job_id": self.id, "status": self.status, "phase": self.phase, "target_operation": self.op_id,
               "project_id": self.project_id, "branch_id": self.branch_id, "slot": self.slot,
               "slot_label": self.slot_label, "model": self.model,
               "created_at": _iso(datetime.fromtimestamp(self.created, timezone.utc)),
               "elapsed_ms": int((now - (self.started or self.created)) * 1000) if self.started else 0,
               "proposal": None, "findings": [], "removed_refs": [], "filled_fields": [], "kept_fields": [],
               "valid": None, "error": self.error, "waiting": self.waiting}
        if self.result:
            out.update({k: self.result[k] for k in ("proposal", "findings", "removed_refs", "filled_fields",
                                                     "kept_fields", "valid", "summary", "companion")
                        if k in self.result})
        return out


class AssistService:
    def __init__(self, engine, principal_id: str = "author", reports_dir=None, retry_busy: bool = False,
                 jobstore=None):
        self.engine = engine
        # S10: wait and retry busy/unreachable AI answers (the App turns this on; library callers opt in).
        self.retry_busy = retry_busy
        self.retry_policy: RetryPolicy | None = None  # None: read the ai_retry setting at each call
        self.jobstore = jobstore
        self.store = engine.store
        self.contracts = engine.contracts
        self.principal_id = principal_id
        self.reports_dir = Path(reports_dir) if reports_dir else Path(self.store.data_dir) / "reports"
        self._lock = threading.RLock()
        self._jobs: dict[str, Job] = {}
        self._sessions: dict[str, "BibleSession"] = {}
        self._slot_sems: dict[str, threading.Semaphore] = {}

    # ------------------------------------------------------------------ persistence (S11)
    def persist(self, job: "Job", kind: str | None = None, resume: dict | None = None, **extra):
        """Save a small summary of a job so a restart can show it (never keys or AI replies)."""
        if self.jobstore is None:
            return
        try:
            cur = self.jobstore.get(job.id) or {}
            rec = {"id": job.id, "kind": kind or job.kind, "status": job.status, "phase": job.phase,
                   "project_id": job.project_id, "branch_id": job.branch_id, "op": job.op_id,
                   "slot": job.slot, "slot_label": job.slot_label, "model": job.model,
                   "created_at": _iso(datetime.fromtimestamp(job.created, timezone.utc)),
                   "finished_at": _iso(datetime.fromtimestamp(job.finished, timezone.utc)) if job.finished else None,
                   "error": job.error, "principal": job.principal}
            if resume is not None:
                rec["resume"] = resume
            elif cur.get("resume"):
                rec["resume"] = cur["resume"]
            rec.update(extra)
            self.jobstore.save(rec)
        except Exception:  # noqa: BLE001 - never break the job
            log.exception("could not persist job %s", job.id)

    # ------------------------------------------------------------------ shared checks
    def _access(self, principal: str, pid, branch, op_id: str | None = None):
        if not isinstance(pid, str) or not pid or not isinstance(branch, str) or not branch:
            raise BookforgeError("MISSING_INPUT", "/project_id", "project_id and branch_id are required",
                                 status="REJECTED")
        if not self.store.has_project_access(principal, pid) or self.store.project(pid) is None:
            raise BookforgeError("PERMISSION_DENIED", "/project_id", "no access to this project", status="REJECTED")
        if not self.store.branch_exists(pid, branch):
            raise BookforgeError("NOT_FOUND", "/branch_id", "branch not found", status="REJECTED")
        if op_id and not self.store.has_scope(principal, pid, branch, f"{op_id}:create"):
            raise BookforgeError("PERMISSION_DENIED", "", f"missing scope {op_id}:create", status="REJECTED")

    def _check_op(self, op_id):
        if not isinstance(op_id, str) or self.contracts.operation(op_id) is None:
            raise BookforgeError("NOT_FOUND", "/target_operation", "unknown operation", status="REJECTED")
        if not supports(self.contracts, op_id):
            raise BookforgeError("INVALID_INPUT", "/target_operation", f"{op_id} has no AI fill (Set A and creative "
                                 "Set B planning modules only)", status="REJECTED")

    @staticmethod
    def _check_slot(slot_id):
        if slot_id not in (None, "", "auto", "AI-1", "AI-2", "AI-3"):
            raise BookforgeError("INVALID_INPUT", "/slot_id", "slot_id must be AI-1, AI-2, AI-3 or null (auto)",
                                 status="REJECTED")
        return None if slot_id in (None, "", "auto") else slot_id

    def _not_applicable(self, principal, pid, branch, op_id) -> str | None:
        req = build_request(project_id=pid, branch_id=branch, op_id=op_id, action="CREATE", principal_id=principal,
                            payload={})
        ctx = Context(self.engine, req, principal, action="CREATE")
        na = self.engine._applicability(ctx, get_handler(op_id))
        return na[1] if na else None

    def _purge(self):
        now = time.time()
        for jid, j in list(self._jobs.items()):
            if j.finished and now - j.finished > JOB_TTL_S:
                del self._jobs[jid]
        if len(self._jobs) > MAX_JOBS:
            for jid, j in sorted(self._jobs.items(), key=lambda x: x[1].created)[:len(self._jobs) - MAX_JOBS]:
                if j.finished:
                    del self._jobs[jid]
        for sid, s in list(self._sessions.items()):
            if not s.busy() and now - s.touched > SESSION_TTL_S:
                del self._sessions[sid]

    # ------------------------------------------------------------------ slot choice
    def _slot_label(self, slot: dict) -> str:
        if slot["adapter_id"] == "autoinjector":
            site = {"claude": "Claude", "chatgpt": "ChatGPT", "gemini": "Gemini"}.get(slot.get("site"), slot.get("site"))
            return f"{site} through AutoInjector"
        if slot["adapter_id"] == "anthropic":
            return f"Claude (Anthropic API, {slot.get('model')})"
        return f"{slot['slot_id']} ({slot['adapter_id']})"

    def _usable(self, s: dict, pid: str) -> bool:
        prov = self.engine.providers
        if s["adapter_id"] == "none" or (s["adapter_id"] == "manual" and prov.test_adapter is None):
            return False
        return bool(s.get("healthy", True)) and ("*" in s["authorized_projects"] or pid in s["authorized_projects"])

    def _providers(self, job: Job):
        """The registry a job chooses from: the engine's (maybe pinned to the book's AI), or with ``cross_pin``
        the shared base registry (the AI reviewer may be another AI than the one the book is written with)."""
        prov = self.engine.providers
        if getattr(job, "cross_pin", False) and isinstance(prov, providers_mod.PinnedProviders):
            return prov._base  # never past a gate (the self-test / workflow test registries stay gated)
        return prov

    def _soft_pick(self, job: Job, prov, op_for_roles: str, needed: int, exclude) -> tuple[dict | None, bool]:
        """Automatic choice with the job's soft preferences. Returns (slot, wait): wait=True when the only fitting
        AIs other than the avoided one are just busy (wait for them rather than reuse the avoided one)."""
        elig_op = [x for x in prov.eligible(job.project_id, "text", needed, op_for_roles) if x["slot_id"] not in exclude]
        avoid, fams = set(job.avoid_slots or []), set(job.avoid_families or set())
        if not job.prefer_slots and not avoid and not fams:
            return (elig_op[0] if elig_op else None), False
        elig_all = [x for x in prov.eligible(job.project_id, "text", needed, None) if x["slot_id"] not in exclude]
        for p in job.prefer_slots or []:
            hit = next((x for x in elig_all if x["slot_id"] == p and p not in avoid), None)
            if hit:
                return hit, False
        rank = (lambda x: providers_mod.slot_family(x) in fams)
        for pool in (elig_op, elig_all):
            others = sorted([x for x in pool if x["slot_id"] not in avoid], key=rank)  # stable: keeps K11 order
            if others:
                return others[0], False
        # Only the avoided AI is free: if another working AI is merely busy, wait for it.
        for x in prov.slots():
            if (x["slot_id"] not in avoid and x["slot_id"] not in exclude and self._usable(x, job.project_id)
                    and x["active_jobs"] >= x["max_concurrent"] and prov.available(x)):
                return None, True
        return ((elig_op or elig_all or [None])[0]), False

    def _choose_slot(self, job: Job, op_for_roles: str, needed: int, exclude=()) -> dict:
        """Explicit pick or auto; waits (status 'queued') while the only usable slots are busy. A slot whose site
        is being repaired is skipped; when every fitting AI is being repaired the call waits and tries again
        (UPSTREAM_UNAVAILABLE). ``exclude``: slots that already failed in this call."""
        prov = self._providers(job)
        waited_since = time.monotonic()
        while True:
            job.check()
            slots = prov.slots()
            if job.slot_pref:
                s = next(x for x in slots if x["slot_id"] == job.slot_pref)
                if not self._usable(s, job.project_id):
                    raise BookforgeError("CAPABILITY_UNAVAILABLE", "/slot_id",
                                         f"{job.slot_pref} is not set up for AI (adapter '{s['adapter_id']}')")
                elig = [x for x in prov.eligible(job.project_id, "text", needed, None) if x["slot_id"] == s["slot_id"]]
                if elig:
                    return elig[0]
                if not prov.available(s):
                    raise prov.down_error([s])
                busy = s["active_jobs"] >= s["max_concurrent"]
                if not busy:
                    raise BookforgeError("CAPABILITY_UNAVAILABLE", "/slot_id", f"{job.slot_pref} cannot take this job "
                                         "(unhealthy, missing the text capability, or context limit too small)")
            else:
                pick, wait = self._soft_pick(job, prov, op_for_roles, needed, set(exclude))
                if pick:
                    return pick
                usable = [x for x in slots if self._usable(x, job.project_id) and x["slot_id"] not in exclude]
                busy = [x for x in usable if x["active_jobs"] >= x["max_concurrent"]]
                down = [x for x in usable if not prov.available(x)]
                if usable and not busy and down and not wait:
                    raise prov.down_error(down)
                if not usable or (not busy and not wait):
                    raise BookforgeError("CAPABILITY_UNAVAILABLE", "", "no AI slot is connected and ready")
            if time.monotonic() - waited_since > SLOT_WAIT_S:
                raise BookforgeError("RATE_LIMITED", "", "the AI stayed busy with other jobs for 10 minutes")
            job.status = "queued"
            job.phase = f"Waiting for {job.slot_pref or 'a free AI slot'} to finish another job"
            time.sleep(0.5)

    def _call_ai(self, job: Job, *, op_for_roles: str, task: str, schema: dict, context: dict,
                 protected: list) -> dict:
        """One AI answer for a job; busy/unreachable answers wait and retry (S10) when retry is on."""
        def once():
            return self._call_ai_once(job, op_for_roles=op_for_roles, task=task, schema=schema, context=context,
                                      protected=protected)
        retry = job.retry_busy if getattr(job, "retry_busy", None) is not None else self.retry_busy
        if not retry:
            return once()
        policy = self.retry_policy or RetryPolicy.from_store(self.store)

        def on_wait(info):
            job.waiting = info
            if info:
                job.phase = info["message"]
            else:
                job.phase = f"Asking {job.slot_label or 'the AI'} again"
            cb = getattr(job, "on_wait", None)
            if cb:
                try:
                    cb(info)
                except Exception:  # noqa: BLE001 - progress display only
                    pass
        try:
            return wait_and_retry(once, policy=policy, check=job.check, on_wait=on_wait,
                                  who=lambda: slot_word(job.slot_label))
        finally:
            job.waiting = None

    def _call_ai_once(self, job: Job, *, op_for_roles: str, task: str, schema: dict, context: dict,
                      protected: list) -> dict:
        prov = self._providers(job)
        needed = len(json.dumps(context, ensure_ascii=False)) // 3 + 2000
        failed: list[str] = []  # slots that were not working in THIS call (P18.9: move to the next working AI)
        for _ in range(3 + len(providers_mod.SLOT_IDS)):
            try:
                slot = self._choose_slot(job, op_for_roles, needed, exclude=failed)
            except BookforgeError as exc:
                if failed and exc.code in ("CAPABILITY_UNAVAILABLE",):
                    raise prov.down_error([s for s in prov.slots() if s["slot_id"] in failed]) from None
                raise
            job.slot, job.slot_label = slot["slot_id"], self._slot_label(slot)
            job.model = f"web:{slot.get('site')}" if slot["adapter_id"] == "autoinjector" else slot.get("model")
            job.status = "running"
            job.phase = f"Asking {job.slot_label}"
            sem = self._slot_sem(slot)
            with sem:
                job.check()
                job.calls += 1
                ctx = _AICtx(job.project_id, job.branch_id, op_for_roles, f"{job.id}-{job.calls}")
                try:
                    data, resource = prov.generate(ctx, task=task, output_schema=schema, context=context,
                                                   capability="text", protected_facts=protected,
                                                   slot_id=slot["slot_id"])
                except BookforgeError as exc:
                    s = next(x for x in prov.slots() if x["slot_id"] == slot["slot_id"])
                    if exc.code == "CAPABILITY_UNAVAILABLE" and s["active_jobs"] >= s["max_concurrent"]:
                        continue  # another operation grabbed the slot first: wait for it again
                    if exc.code == "UPSTREAM_UNAVAILABLE" and not job.slot_pref and \
                            self._other_ai(job, prov, op_for_roles, needed, failed + [slot["slot_id"]]):
                        failed.append(slot["slot_id"])
                        job.failovers.append({"from": slot["slot_id"], "from_name": providers_mod.slot_name(slot),
                                              "code": exc.code, "state": getattr(exc, "site_state", None),
                                              "problem": getattr(exc, "site_problem", None)})
                        log.warning("AI slot %s not working (%s); trying another AI", slot["slot_id"],
                                    getattr(exc, "site_problem", None) or exc.code)
                        continue
                    raise
            if failed:
                prov.health.notify({"event": "failover", "from": [f for f in job.failovers
                                                                  if f["from"] in failed],
                                    "to": slot["slot_id"], "to_name": providers_mod.slot_name(slot),
                                    "operation": op_for_roles})
            job.model = resource.get("model") or job.model
            return data
        raise BookforgeError("RATE_LIMITED", "", "the AI slot stayed busy")

    def _other_ai(self, job: Job, prov, op_for_roles: str, needed: int, exclude: list) -> bool:
        """Is there another AI (not in ``exclude``) this call could move to right now?"""
        return bool(prov.eligible(job.project_id, "text", needed, None) and
                    [x for x in prov.eligible(job.project_id, "text", needed, None) if x["slot_id"] not in exclude])

    def _slot_sem(self, slot) -> threading.Semaphore:
        with self._lock:
            sem = self._slot_sems.get(slot["slot_id"])
            if sem is None:
                sem = self._slot_sems[slot["slot_id"]] = threading.Semaphore(max(1, int(slot["max_concurrent"]) or 1))
            return sem

    # ------------------------------------------------------------------ proposal core
    def _task(self, op_id: str, keep: bool, reask: list | None) -> str:
        from .modules.set_a import PURPOSE_RULES  # noqa: PLC0415
        op = self.contracts.operation(op_id)
        parts = [f"Operation {op['id']} - {op['name']}. Purpose: {op['purpose']}"]
        if op_id in PURPOSE_RULES:
            parts.append(f"Set rule: {PURPOSE_RULES[op_id]}")
        parts.append(
            "Task: propose a complete CREATE payload for this module from the author's request (context.author_request,"
            " the author's own instruction). It is a proposal the author reviews; it is not saved. "
            + ("Keep every non-empty value in context.current_values exactly; fill only the empty fields. " if keep
               else "Rewrite the narrative fields freely, but keep references and IDs from context.current_values. ")
            + "Fit the existing world in context.canon (reuse its names and subject IDs, never contradict it or the "
            "protected facts). Narrative descriptions go in 'attributes' (every attribute a non-empty string). Precise "
            "claims go in 'facts' as {subject_id, predicate, value, assertion_type, effective_from, effective_to, "
            "source_refs}: stable lowercase-hyphenated subject IDs (the entity itself first, plus an 'entity.name' "
            "fact with its exact display name), predicates from context.predicate_conventions (registered predicates "
            "or the listed x.* owner extensions; avoid inventing others), scalar or flat-list values, assertion_type "
            "FACT only for intended canon, BELIEF for what characters or societies believe, PLAN for intentions, "
            "UNKNOWN when undecided; effective_from/effective_to are integer story-time ticks with to > from, or null; "
            "source_refs []. A reference (linked_refs, *_ref) may only copy an exact 'ref' object given in "
            "context.canon or context.context_records; otherwise leave it out. Return only the JSON object.")
        if reask:
            parts.append("Your previous proposal was rejected by the validator: " + "; ".join(reask[:8])
                         + ". Return a corrected complete JSON object.")
        return " ".join(parts)

    def propose(self, job: Job, *, prompt: str, current_values: dict | None = None, keep: bool = True,
                context_refs: list | None = None, extra_context: dict | None = None,
                with_companion: bool = True) -> dict:
        """Ask the AI for a CREATE payload of job.op_id and check it without committing."""
        op_id, pid, branch = job.op_id, job.project_id, job.branch_id
        props = payload_schema(self.contracts, op_id).get("properties", {})
        user = {k: _prune(v) for k, v in (current_values or {}).items() if k in props}
        user = {k: v for k, v in user.items() if not _empty(v)}
        approved, drafts, protected = canon_context(self.engine, pid, branch)
        ctx_records = []
        for i, ref in enumerate(context_refs or []):
            try:
                rec = self.engine.resolve_ref(ref, pid, branch, f"/context_refs/{i}")
            except BookforgeError as exc:
                raise BookforgeError(exc.code, f"/context_refs/{i}", "a context record does not resolve in this "
                                     "project/branch", status="REJECTED") from None
            data = json.dumps(rec.get("data"), ensure_ascii=False)
            ctx_records.append({"module_id": rec["module_id"], "record_id": rec["record_id"], "ref": rec["ref"],
                                "lifecycle": rec["lifecycle"], "data_json": data[:6000]})
        manifest = self.store.feature_manifest(pid, branch) or {}
        context = {"author_request": prompt, "current_values": user, "keep_current_values": keep,
                   "operation": {k: (self.contracts.operation(op_id) or {}).get(k) for k in ("id", "name", "purpose", "ai")},
                   "features": manifest.get("features", {}),
                   "canon": {"approved_records": approved, "draft_records": drafts},
                   "context_records": ctx_records,
                   "predicate_conventions": pr.registry_brief(self.contracts.predicate_registry)}
        profile = book_profile_brief(self.store, pid)
        if profile:
            context["book_profile"] = profile
        if extra_context:
            context.update(extra_context)
        schema = ai_schema(self.contracts, op_id)
        companion = op_id == "A01" and with_companion
        if companion:
            # P7/P17: a character proposal also carries its sheet and voice card (companion data, not A01 fields)
            schema = copy.deepcopy(schema)
            # optional: a model that leaves them out still gives a usable character (the sheet is made later)
            schema["properties"].update(chars_mod.COMPANION_SCHEMA["properties"])
        reask = None
        result = None
        sheet = voice = None
        for attempt in range(2):
            job.check()
            task = self._task(op_id, keep, reask) + (" " + chars_mod.COMPANION_TASK if companion else "")
            raw = self._call_ai(job, op_for_roles=op_id, task=task, schema=schema,
                                context=context, protected=protected)
            job.check()
            job.phase = "Checking the proposal"
            if companion:
                sheet, voice = chars_mod.split_companion(raw)
            result = self.check_proposal(job.principal, pid, branch, op_id, raw if isinstance(raw, dict) else {},
                                         user, keep)
            ai_errors = [f["message"] for f in result["findings"]
                         if f["rule_id"] == "SCHEMA" and f.get("_ai_field")]
            if not ai_errors or attempt == 1:
                break
            reask = ai_errors
            job.phase = f"Asking {job.slot_label} again (the first answer did not fit the form)"
        for f in result["findings"]:
            f.pop("_ai_field", None)
        if companion and sheet is not None and voice is not None:
            result["companion"] = {"character_sheet": sheet, "voice_card": voice}
        return result

    # ------------------------------------------------------------------ merge + checks (no commit)
    def merge(self, op_id: str, user: dict, ai: dict, keep: bool) -> tuple[dict, list, list]:
        props = payload_schema(self.contracts, op_id).get("properties", {})
        out, filled, kept = {}, [], []
        for k, s in props.items():
            u, a = user.get(k), ai.get(k)
            if k in AUTHOR_ONLY:
                if not _empty(u):
                    out[k], _ = u, kept.append(k)
                elif s.get("type") == "array":
                    out[k] = []
                continue
            if _is_ref_field(s):
                if isinstance(u, list) or isinstance(a, list) or s.get("type") == "array":
                    refs, seen = [], set()
                    for r in (u if isinstance(u, list) else []) + (a if isinstance(a, list) else []):
                        key = json.dumps(r, sort_keys=True, default=str)
                        if key not in seen:
                            seen.add(key)
                            refs.append(r)
                    out[k] = refs
                    if not _empty(u):
                        kept.append(k)
                    if isinstance(a, list) and len(refs) > len(u or []):
                        filled.append(k)
                elif not _empty(u):
                    out[k] = u
                    kept.append(k)
                elif isinstance(a, dict):
                    out[k] = a
                    filled.append(k)
                continue
            if isinstance(s.get("properties"), dict) and s.get("type") == "object" and k == "attributes":
                ua = u if isinstance(u, dict) else {}
                aa = a if isinstance(a, dict) else {}
                merged = {}
                for ak in s["properties"]:
                    uv, av = ua.get(ak), aa.get(ak)
                    if not _empty(uv) and (keep or _empty(av)):
                        merged[ak] = uv
                    elif not _empty(av):
                        merged[ak] = av
                out[k] = merged
                if ua:
                    kept.append(k)
                if any(ak not in ua or not keep for ak in aa if not _empty(aa.get(ak))):
                    filled.append(k)
                continue
            if k == "facts" and (isinstance(u, list) or isinstance(a, list)):
                uf = u if isinstance(u, list) else []
                af = a if isinstance(a, list) else []
                if keep:
                    have = {(f.get("subject_id"), f.get("predicate")) for f in uf if isinstance(f, dict)}
                    extra = [f for f in af if isinstance(f, dict) and (f.get("subject_id"), f.get("predicate")) not in have]
                    out[k] = uf + extra
                    if uf:
                        kept.append(k)
                    if extra:
                        filled.append(k)
                else:
                    out[k] = af or uf
                    (filled if af else kept).append(k)
                continue
            if not _empty(u) and (keep or _empty(a)):
                out[k] = u
                kept.append(k)
            elif not _empty(a):
                out[k] = a
                filled.append(k)
        return out, filled, kept

    def strip_refs(self, pid: str, branch: str, op_id: str, payload: dict) -> tuple[dict, list]:
        """Resolve every Reference; drop those that are invented, foreign or from a producer this field
        does not accept. Returns (clean payload, removed list)."""
        bindings = {b["input_path"]: b for b in self.contracts.bindings(op_id)}
        removed: list = []

        def bad(ref, ptr) -> str | None:
            if not is_ref(ref):
                return "not a complete reference"
            try:
                self.engine.resolve_ref(ref, pid, branch, ptr)
            except BookforgeError as exc:
                return exc.errors[0]["message"] if exc.errors else exc.code
            except Exception:  # noqa: BLE001 - malformed values
                return "not a valid reference"
            tmpl = "/payload" + "/".join(p for p in ptr.split("/") if not p.isdigit())
            b = bindings.get(tmpl)
            if b and ref["module_id"] not in b["allowed_producers"]:
                return f"{ref['module_id']} is not accepted here"
            return None

        def looks_ref(v):
            return isinstance(v, dict) and ("record_id" in v or "content_hash" in v) and "module_id" in v

        def walk(v, ptr):
            if isinstance(v, list):
                out = []
                for i, item in enumerate(v):
                    if looks_ref(item):
                        why = bad(item, f"{ptr}/{i}")
                        if why:
                            removed.append({"path": f"{ptr}/{i}", "module_id": item.get("module_id"),
                                            "record_id": item.get("record_id"), "version": item.get("version"),
                                            "reason": why})
                            continue
                        out.append(item)
                    else:
                        out.append(walk(item, f"{ptr}/{i}"))
                return out
            if isinstance(v, dict):
                out = {}
                for k, item in v.items():
                    p = f"{ptr}/{k}"
                    if looks_ref(item):
                        why = bad(item, p)
                        if why:
                            removed.append({"path": p, "module_id": item.get("module_id"),
                                            "record_id": item.get("record_id"), "version": item.get("version"),
                                            "reason": why})
                            continue
                    out[k] = walk(item, p)
                return out
            return v

        return walk(payload, ""), removed

    def check_proposal(self, principal: str, pid: str, branch: str, op_id: str, ai: dict, user: dict,
                       keep: bool) -> dict:
        proposal, filled, kept = self.merge(op_id, user, ai, keep)
        proposal, removed = self.strip_refs(pid, branch, op_id, proposal)
        props = payload_schema(self.contracts, op_id).get("properties", {})

        def still_filled(k):  # a link field counts as AI-filled only if an AI link survived the check
            if not _is_ref_field(props.get(k, {})):
                return True
            v = proposal.get(k)
            if isinstance(v, list):
                return len(v) > len(user.get(k) or [])
            return k in proposal and _empty(user.get(k))
        filled = [k for k in filled if still_filled(k)]
        findings = self.dry_check(principal, pid, branch, op_id, proposal, filled)
        if removed:
            findings.insert(0, {"id": f"{op_id}-AI_REF_DROPPED-0", "rule_id": "AI_REF_DROPPED", "severity": "MAJOR",
                                "decision": "UNKNOWN", "message": f"removed {len(removed)} link(s) that are not real "
                                "records of this project/branch; links are never invented", "evidence": [],
                                "source_refs": [], "confidence": None})
        valid = not any(f["rule_id"] == "SCHEMA" for f in findings)
        return {"proposal": proposal, "findings": findings, "removed_refs": removed, "filled_fields": filled,
                "kept_fields": kept, "valid": valid, "summary": summarize_payload(op_id, proposal)}

    def dry_check(self, principal: str, pid: str, branch: str, op_id: str, payload: dict,
                  ai_fields: list | None = None) -> list[dict]:
        req = build_request(project_id=pid, branch_id=branch, op_id=op_id, action="CREATE", principal_id=principal,
                            payload=payload)
        ctx = Context(self.engine, req, principal, action="CREATE")
        findings = []
        schema_errs = [e for e in self.contracts.check(op_id, "CREATE", req) if e["path"].startswith("/payload")]
        for e in schema_errs:
            path = e["path"][len("/payload"):] or "/"
            f = ctx.finding("SCHEMA", f"{e['code']} at {path}: {e['message']}", severity="BLOCKING", decision="FAIL")
            f["path"] = path
            top = path.split("/")[1] if len(path) > 1 else ""
            f["_ai_field"] = bool(ai_fields and top in ai_fields)
            findings.append(f)
        handler = get_handler(op_id)
        from .modules.set_a import CanonHandler, resolve_pins  # noqa: PLC0415
        if isinstance(handler, CanonHandler) and not schema_errs:
            try:
                handler._reject_intervals(payload, "")
            except BookforgeError as exc:
                findings.append(ctx.finding("FACT_INTERVAL", exc.errors[0]["message"] + f" ({exc.errors[0]['path']})",
                                            severity="BLOCKING", decision="FAIL"))
            try:
                findings += handler._check(ctx, payload, None, resolve_pins(ctx, payload.get("linked_refs")))
            except Exception as exc:  # noqa: BLE001 - checks are advisory for a proposal
                findings.append(ctx.finding("CHECK_SKIPPED", f"owner checks could not run: {type(exc).__name__}",
                                            severity="INFO", decision="UNKNOWN"))
        elif not schema_errs:
            def add(rule, msg, severity="MAJOR", decision="FAIL", refs=None):
                findings.append(ctx.finding(rule, msg, severity=severity, decision=decision, source_refs=refs or []))
            pr.check_facts(pr.iter_facts(payload, ""), self.contracts.predicate_registry, add)
        return findings

    # ------------------------------------------------------------------ assist jobs (API)
    def start_assist(self, principal: str, body: dict) -> dict:
        if not isinstance(body, dict):
            raise BookforgeError("INVALID_INPUT", "", "body must be a JSON object", status="REJECTED")
        pid, branch, op_id = body.get("project_id"), body.get("branch_id") or "main", body.get("target_operation")
        self._check_op(op_id)
        self._access(principal, pid, branch, op_id)
        prompt = body.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise BookforgeError("MISSING_INPUT", "/prompt", "type what you want the AI to create", status="REJECTED")
        if len(prompt) > 8000:
            raise BookforgeError("INVALID_INPUT", "/prompt", "the prompt is limited to 8000 characters",
                                 status="REJECTED")
        slot = self._check_slot(body.get("slot_id"))
        cur = body.get("current_values") or {}
        refs = body.get("context_refs") or []
        if not isinstance(cur, dict):
            raise BookforgeError("INVALID_INPUT", "/current_values", "current_values must be an object",
                                 status="REJECTED")
        if not isinstance(refs, list) or len(refs) > 20 or not all(isinstance(r, dict) for r in refs):
            raise BookforgeError("INVALID_INPUT", "/context_refs", "context_refs must be up to 20 references",
                                 status="REJECTED")
        keep = body.get("keep_values", True)
        if not isinstance(keep, bool):
            raise BookforgeError("INVALID_INPUT", "/keep_values", "keep_values must be true or false", status="REJECTED")
        na = self._not_applicable(principal, pid, branch, op_id)
        if na:
            raise BookforgeError("INVALID_INPUT", "/feature_manifest", f"this module is switched off: {na}",
                                 status="REJECTED")
        with self._lock:
            self._purge()
            running = [j for j in self._jobs.values() if j.kind == "assist" and not j.finished]
            if len(running) >= MAX_RUNNING_JOBS:
                raise BookforgeError("RATE_LIMITED", "", f"{MAX_RUNNING_JOBS} AI fills are already running; wait "
                                     "for one to finish", status="REJECTED")
            job = Job("assist", principal, pid, branch, op_id, slot)
            self._jobs[job.id] = job
        self.persist(job, resume={"project_id": pid, "branch_id": branch, "target_operation": op_id, "prompt": prompt,
                                  "slot_id": slot, "current_values": cur, "keep_values": keep, "context_refs": refs})
        threading.Thread(target=self._run_assist, args=(job, prompt, cur, keep, refs), daemon=True,
                         name=f"assist-{job.id}").start()
        return job.public()

    def run_assist_sync(self, principal: str, pid: str, branch: str, op_id: str, prompt: str, *,
                        slot_id: str | None = None, current_values=None, keep=True, context_refs=None) -> dict:
        """Synchronous variant (self-test): returns the job's public dict."""
        job = Job("assist", principal, pid, branch, op_id, slot_id)
        self._run_assist(job, prompt, current_values or {}, keep, context_refs or [])
        return job.public()

    def _run_assist(self, job: Job, prompt, cur, keep, refs):
        job.started = time.time()
        job.status, job.phase = "running", "Preparing the request"
        try:
            job.result = self.propose(job, prompt=prompt, current_values=cur, keep=keep, context_refs=refs)
            job.status, job.phase = "done", "Proposal ready"
        except Cancelled:
            job.status, job.phase = "cancelled", "Cancelled"
            job.error = _err("CANCELLED", "you cancelled this request; nothing was saved")
        except BookforgeError as exc:
            job.status, job.phase, job.error = "error", "Stopped", _err_of(exc)
        except Exception as exc:  # noqa: BLE001
            log.exception("assist job %s failed", job.id)
            job.status, job.phase = "error", "Stopped"
            job.error = _err("INTERNAL_ERROR", f"{type(exc).__name__} while preparing the proposal")
        job.finished = time.time()
        self.persist(job, title=(job.result or {}).get("summary", {}).get("title") if job.result else None)
        log.info("assist job=%s op=%s status=%s slot=%s calls=%s elapsed=%.1fs", job.id, job.op_id, job.status,
                 job.slot, job.calls, job.finished - job.started)

    def _job(self, principal: str, job_id: str) -> Job:
        with self._lock:
            self._purge()
            job = self._jobs.get(job_id)
        if job is None or job.principal != principal:
            raise BookforgeError("NOT_FOUND", "/job_id", "no such AI job (it may have expired)", status="REJECTED")
        return job

    def get_assist(self, principal: str, job_id: str) -> dict:
        try:
            return self._job(principal, job_id).public()
        except BookforgeError:
            saved = self.jobstore.get(job_id) if self.jobstore is not None else None
            if saved and saved.get("kind") == "assist" and saved.get("principal") in (None, principal):
                return {"job_id": job_id, "status": saved.get("status"), "phase": saved.get("phase"),
                        "target_operation": saved.get("op"), "project_id": saved.get("project_id"),
                        "branch_id": saved.get("branch_id"), "slot": saved.get("slot"),
                        "slot_label": saved.get("slot_label"), "model": saved.get("model"),
                        "created_at": saved.get("created_at"), "elapsed_ms": 0, "proposal": None, "findings": [],
                        "removed_refs": [], "filled_fields": [], "kept_fields": [], "valid": None,
                        "error": saved.get("error") or ({"code": "INTERRUPTED", "message": "BookForge was restarted "
                                                         "while this was running; press Resume to run it again.",
                                                         "fix": "Press Resume.", "path": ""}
                                                        if saved.get("status") == "interrupted" else None),
                        "waiting": None, "persisted": True}
            raise

    def cancel_assist(self, principal: str, job_id: str) -> dict:
        job = self._job(principal, job_id)
        job.cancelled = True
        if job.status == "queued":
            job.phase = "Cancelling"
        return job.public()

    # ================================================================== Bible Builder
    def bible_sections(self, pid: str, branch: str) -> list[dict]:
        manifest = self.store.feature_manifest(pid, branch) or {}
        magic = (manifest.get("features") or {}).get("magic") is True or "A09" in (manifest.get("required_operations") or [])
        out = []
        for op_id in A_OPS:
            op = self.contracts.operation(op_id)
            enabled = op_id != "A09" or magic
            out.append({"op": op_id, "name": op["name"], "enabled": enabled,
                        "reason": None if enabled else "magic is switched off in the feature manifest"})
        return out

    def create_bible(self, principal: str, body: dict) -> dict:
        if not isinstance(body, dict):
            raise BookforgeError("INVALID_INPUT", "", "body must be a JSON object", status="REJECTED")
        pid, branch = body.get("project_id"), body.get("branch_id") or "main"
        self._access(principal, pid, branch)
        idea = body.get("idea")
        if not isinstance(idea, str) or not idea.strip():
            raise BookforgeError("MISSING_INPUT", "/idea", "describe your book idea first", status="REJECTED")
        if len(idea) > 8000:
            raise BookforgeError("INVALID_INPUT", "/idea", "the idea is limited to 8000 characters", status="REJECTED")
        slot = self._check_slot(body.get("slot_id"))
        counts = body.get("counts")
        with self._lock:
            self._purge()
            if len(self._sessions) >= MAX_SESSIONS:
                oldest = min((s for s in self._sessions.values() if not s.busy()), key=lambda s: s.touched, default=None)
                if oldest is None:
                    raise BookforgeError("RATE_LIMITED", "", "too many Bible Builder sessions are running",
                                         status="REJECTED")
                del self._sessions[oldest.id]
            sess = BibleSession(self, principal, pid, branch, idea.strip(), slot)
            self._sessions[sess.id] = sess
        if counts:
            sess.enqueue(self._parse_counts(sess, counts), slot, self._guidance(body))
        return sess.public()

    @staticmethod
    def _guidance(body: dict) -> str | None:
        """Optional author guidance for one run (roles/types to cover, tone...). Never logged or reported."""
        g = body.get("guidance")
        if g is None:
            return None
        if not isinstance(g, str):
            raise BookforgeError("INVALID_INPUT", "/guidance", "guidance must be text", status="REJECTED")
        if len(g) > MAX_GUIDANCE:
            raise BookforgeError("INVALID_INPUT", "/guidance", f"guidance is limited to {MAX_GUIDANCE} characters",
                                 status="REJECTED")
        return g.strip() or None

    def _parse_counts(self, sess: "BibleSession", counts) -> dict:
        if not isinstance(counts, dict):
            raise BookforgeError("INVALID_INPUT", "/counts", "counts must map section IDs (A01-A18) to numbers",
                                 status="REJECTED")
        enabled = {s["op"]: s for s in self.bible_sections(sess.project_id, sess.branch_id)}
        out = {}
        for k, v in counts.items():
            if k not in enabled:
                raise BookforgeError("INVALID_INPUT", f"/counts/{k}", "sections are A01-A18", status="REJECTED")
            if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v <= MAX_SECTION_COUNT:
                raise BookforgeError("INVALID_INPUT", f"/counts/{k}", f"how many: a whole number 0-{MAX_SECTION_COUNT}",
                                     status="REJECTED")
            if v == 0:
                continue
            if not enabled[k]["enabled"]:
                sess.note_skip(k, v, enabled[k]["reason"])
                continue
            out[k] = v
        if sum(out.values()) > MAX_RUN_ITEMS:
            raise BookforgeError("INVALID_INPUT", "/counts", f"at most {MAX_RUN_ITEMS} items per run", status="REJECTED")
        return out

    def _session(self, principal: str, sid: str) -> "BibleSession":
        with self._lock:
            self._purge()
            sess = self._sessions.get(sid)
        if sess is None or sess.principal != principal:
            raise BookforgeError("NOT_FOUND", "/session_id", "no such Bible Builder session (it may have expired)",
                                 status="REJECTED")
        sess.touched = time.time()
        return sess

    def get_bible(self, principal: str, sid: str) -> dict:
        return self._session(principal, sid).public()

    def latest_bible(self, principal: str, pid: str, branch: str) -> dict | None:
        self._access(principal, pid, branch)
        with self._lock:
            mine = [s for s in self._sessions.values() if s.principal == principal and s.project_id == pid
                    and s.branch_id == branch]
        return max(mine, key=lambda s: s.created).public() if mine else None

    def run_bible(self, principal: str, sid: str, body: dict) -> dict:
        sess = self._session(principal, sid)
        body = body if isinstance(body, dict) else {}
        if isinstance(body.get("idea"), str) and body["idea"].strip():
            sess.idea = body["idea"].strip()[:8000]
        slot = self._check_slot(body.get("slot_id")) if "slot_id" in body else sess.slot_pref
        counts = self._parse_counts(sess, body.get("sections") if "sections" in body else body.get("counts"))
        if not counts:
            raise BookforgeError("MISSING_INPUT", "/sections", "tick at least one section with a number above 0",
                                 status="REJECTED")
        sess.enqueue(counts, slot, self._guidance(body))
        return sess.public()

    def regenerate_bible_item(self, principal: str, sid: str, body: dict) -> dict:
        sess = self._session(principal, sid)
        body = body if isinstance(body, dict) else {}
        key = body.get("item")
        if key not in sess.items:
            raise BookforgeError("NOT_FOUND", "/item", "no such item in this session", status="REJECTED")
        if sess.items[key].get("created_ref"):
            raise BookforgeError("INVALID_INPUT", "/item", "this item is already created as a draft record; edit "
                                 "that record instead", status="REJECTED")
        note = body.get("prompt") if isinstance(body.get("prompt"), str) else None
        slot = self._check_slot(body.get("slot_id")) if "slot_id" in body else sess.slot_pref
        sess.enqueue_regenerate(key, note, slot)
        return sess.public()

    def cancel_bible(self, principal: str, sid: str) -> dict:
        sess = self._session(principal, sid)
        sess.cancel()
        return sess.public()

    def create_bible_items(self, principal: str, sid: str, body: dict) -> dict:
        sess = self._session(principal, sid)
        body = body if isinstance(body, dict) else {}
        keys = body.get("items")
        edits = body.get("edits") or {}
        if not isinstance(keys, list) or not keys or not all(isinstance(k, str) for k in keys):
            raise BookforgeError("MISSING_INPUT", "/items", "select at least one item to create", status="REJECTED")
        if not isinstance(edits, dict) or not all(isinstance(v, dict) for v in edits.values()):
            raise BookforgeError("INVALID_INPUT", "/edits", "edits must map item keys to payload objects",
                                 status="REJECTED")
        unknown = [k for k in keys + list(edits) if k not in sess.items]
        if unknown:
            raise BookforgeError("NOT_FOUND", "/items", f"unknown item {unknown[0]}", status="REJECTED")
        if sess.busy():
            raise BookforgeError("VERSION_CONFLICT", "/items", "wait for the running sections to finish first",
                                 status="REJECTED")
        return sess.create(keys, edits)

    def bible_report(self, principal: str, sid: str):
        sess = self._session(principal, sid)
        return sess.report_paths or sess.write_report()

    def forget_project(self, pid: str) -> int:
        """A book was deleted: drop its Bible Builder sessions and take its name out of the reports already
        written for it (they then say the book was deleted). Returns the number of reports rewritten."""
        with self._lock:
            for sid, sess in list(self._sessions.items()):
                if sess.project_id == pid:
                    del self._sessions[sid]
        n = 0
        try:
            paths = sorted(self.reports_dir.glob("bible-builder-*.json"))
        except OSError:
            return 0
        for js in paths:
            try:
                rep = json.loads(js.read_text(encoding="utf-8"))
                proj = rep.get("project") if isinstance(rep, dict) else None
                if not isinstance(proj, dict) or proj.get("project_id") != pid:
                    continue
                rep["project"] = {"project_id": pid, "name": None, "deleted": True}
                js.write_text(json.dumps(rep, indent=2, ensure_ascii=False), encoding="utf-8")
                js.with_suffix(".md").write_text(render_markdown(rep), encoding="utf-8")
                n += 1
            except (OSError, ValueError, KeyError, TypeError) as exc:
                log.warning("could not update Bible Builder report %s after a delete: %s", js.name,
                            type(exc).__name__)
        return n


# ====================================================================== Bible Builder session
class BibleSession:
    def __init__(self, svc: AssistService, principal: str, pid: str, branch: str, idea: str, slot_pref):
        self.svc = svc
        self.id = f"bible-{uuid.uuid4().hex[:16]}"
        self.principal, self.project_id, self.branch_id = principal, pid, branch
        self.idea = idea
        self.slot_pref = slot_pref
        self.created = time.time()
        self.touched = self.created
        self.stamp = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + self.id[-6:]
        self.world_summary = ""
        self.sections: dict[str, dict] = {}
        self.items: dict[str, dict] = {}
        self.order: list[str] = []
        self.runs: list[dict] = []
        self.creates: list[dict] = []
        self.skipped: list[dict] = []
        self.queue: list[dict] = []
        self.current: dict | None = None
        self.cancelled = False
        self.report_paths = None
        self._lock = threading.RLock()
        self._worker: threading.Thread | None = None
        self.taken_subjects: set = set()

    # ------------------------------------------------------------------ state
    def busy(self) -> bool:
        return bool(self.queue or self.current)

    def note_skip(self, op_id: str, n: int, reason: str):
        self.skipped.append({"section": op_id, "requested": n, "reason": reason, "at": _iso()})
        sec = self._section(op_id)
        sec.update(status="skipped", message=f"Skipped: {reason}", requested=n)

    def _section(self, op_id: str) -> dict:
        return self.sections.setdefault(op_id, {"op": op_id, "name": self.svc.contracts.operation(op_id)["name"],
                                                "status": "idle", "message": "", "requested": 0, "done": 0,
                                                "failed": 0, "total": 0, "error": None, "runs": 0})

    def public(self) -> dict:
        with self._lock:
            items = []
            for k in self.order:
                it = self.items[k]
                items.append({x: it.get(x) for x in ("key", "op", "name", "subject_id", "role", "links", "status",
                                                     "proposal", "findings", "removed_refs", "error", "slot", "model",
                                                     "elapsed_ms", "created_ref", "create_error", "run", "summary",
                                                     "valid", "message", "companion")})
            cur = self.current
            return {"session_id": self.id, "project_id": self.project_id, "branch_id": self.branch_id,
                    "idea": self.idea, "world_summary": self.world_summary, "slot_pref": self.slot_pref,
                    "busy": self.busy(), "status": "running" if self.busy() else "idle",
                    "current": {"run": cur["run"], "phase": cur.get("phase"), "slot": cur.get("slot"),
                                "slot_label": cur.get("slot_label"), "started_at": cur.get("started_at"),
                                "elapsed_ms": int((time.time() - cur["t0"]) * 1000) if cur.get("t0") else 0}
                    if cur else None,
                    "queued_runs": [{"run": q["run"], "sections": q.get("sections"), "item": q.get("item")}
                                    for q in self.queue],
                    "sections": [self.sections[k] for k in A_OPS if k in self.sections],
                    "available_sections": self.svc.bible_sections(self.project_id, self.branch_id),
                    "items": items, "runs": self.runs, "creates": self.creates, "skipped": self.skipped,
                    "report": self._report_summary()}

    def _report_summary(self):
        if not self.report_paths:
            return None
        return {"markdown": self.report_paths[0].name, "json": self.report_paths[1].name}

    # ------------------------------------------------------------------ queue
    def enqueue(self, counts: dict, slot, guidance: str | None = None):
        with self._lock:
            run_no = len(self.runs) + len(self.queue) + (1 if self.current else 0) + 1
            for op_id, n in counts.items():
                sec = self._section(op_id)
                sec.update(status="queued", message="Queued", requested=n, error=None)
            self.queue.append({"run": run_no, "sections": dict(counts), "slot": slot, "guidance": guidance})
            self.cancelled = False
            self._start()

    def enqueue_regenerate(self, key: str, note, slot):
        with self._lock:
            run_no = len(self.runs) + len(self.queue) + (1 if self.current else 0) + 1
            it = self.items[key]
            it.update(status="queued", message="Queued for regeneration", error=None)
            self.queue.append({"run": run_no, "item": key, "note": note, "slot": slot})
            self.cancelled = False
            self._start()

    def cancel(self):
        with self._lock:
            self.cancelled = True
            for q in self.queue:
                for op_id in (q.get("sections") or {}):
                    self._section(op_id).update(status="cancelled", message="Cancelled before it started")
                if q.get("item"):
                    self.items[q["item"]].update(status="cancelled", message="Cancelled")
            self.queue.clear()

    def _start(self):
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._work, daemon=True, name=f"bible-{self.id}")
            self._worker.start()

    def persist(self, status: str):
        """S11: a small summary of this session so a restart can show (and re-run) unfinished sections."""
        js = self.svc.jobstore
        if js is None:
            return
        try:
            unfinished = {k: v["requested"] for k, v in self.sections.items()
                          if v.get("status") in ("queued", "running", "error", "partial", "cancelled") and v.get("requested")}
            for q in self.queue:
                for k, n in (q.get("sections") or {}).items():
                    unfinished[k] = n
            js.save({"id": self.id, "kind": "bible", "status": status,
                     "phase": (self.current or {}).get("phase") or ("Finished" if status == "done" else status),
                     "project_id": self.project_id, "branch_id": self.branch_id, "principal": self.principal,
                     "created_at": _iso(datetime.fromtimestamp(self.created, timezone.utc)),
                     "sections": {k: {"status": v.get("status"), "done": v.get("done"), "failed": v.get("failed"),
                                      "total": v.get("total")} for k, v in self.sections.items()},
                     "items": len(self.items), "created": sum(1 for i in self.items.values() if i.get("created_ref")),
                     "resume": {"idea": self.idea, "counts": unfinished, "slot_id": self.slot_pref} if unfinished else None})
        except Exception:  # noqa: BLE001
            log.exception("could not persist bible session %s", self.id)

    def _work(self):
        while True:
            with self._lock:
                if not self.queue:
                    self.current = None
                    self.persist("done")
                    return
                task = self.queue.pop(0)
                self.current = dict(task, t0=time.time(), started_at=_iso(), phase="Starting")
            self.persist("running")
            try:
                if task.get("item"):
                    self._run_regenerate(task)
                else:
                    self._run_sections(task)
            except Exception:  # noqa: BLE001 - a broken run must not kill the session
                log.exception("bible builder run failed (session %s)", self.id)
            try:
                self.write_report()
            except OSError:
                log.exception("bible builder report could not be written")

    # ------------------------------------------------------------------ one run
    def _job(self, op_id: str, slot) -> Job:
        job = Job("bible", self.principal, self.project_id, self.branch_id, op_id, slot)
        job.started = time.time()
        job.check = self._check_cancel  # type: ignore[method-assign]
        return job

    def _check_cancel(self):
        if self.cancelled:
            raise Cancelled()

    def _phase(self, text: str, job: Job | None = None):
        if self.current is not None:
            self.current["phase"] = text
            if job is not None:
                self.current["slot"], self.current["slot_label"] = job.slot, job.slot_label

    def _run_sections(self, task: dict):
        counts = task["sections"]
        t0 = time.time()
        run = {"run": task["run"], "kind": "sections", "sections": dict(counts), "started_at": _iso(),
               "finished_at": None, "slot": None, "model": None, "sketch": "pending", "sketch_ms": 0,
               "guided": bool(task.get("guidance")),
               "elapsed_ms": 0, "items": []}
        self.runs.append(run)
        for op_id in counts:
            self._section(op_id).update(status="running", message="Planning names and roles (world sketch)",
                                        done=0, failed=0, total=counts[op_id], runs=self._section(op_id)["runs"] + 1)
        # 1. world sketch: names/roles/links for every new item of this run (one AI call)
        job = self._job("A", task["slot"])
        try:
            self._phase("Asking for a world sketch (names and roles)")
            ts = time.time()
            sketch = self._sketch(job, counts, task.get("guidance"))
            run["sketch"], run["sketch_ms"] = "ok", int((time.time() - ts) * 1000)
            run["slot"], run["model"] = job.slot, job.model
        except (Cancelled, BookforgeError, Exception) as exc:  # noqa: BLE001
            err = (_err("CANCELLED", "cancelled") if isinstance(exc, Cancelled) else
                   _err_of(exc) if isinstance(exc, BookforgeError) else
                   _err("INTERNAL_ERROR", f"{type(exc).__name__} while planning the sketch"))
            run["sketch"], run["error"] = "error", err
            for op_id in counts:
                self._section(op_id).update(status="cancelled" if err["code"] == "CANCELLED" else "error",
                                            message=f"{err['message']}", error=err)
            run["finished_at"], run["elapsed_ms"] = _iso(), int((time.time() - t0) * 1000)
            return
        new_keys = self._add_items(sketch, counts, task["run"])
        run["items"] = list(new_keys)
        # 2. each item, dependency order, so later items see earlier ones
        ordered = sorted(new_keys, key=lambda k: (SECTION_ORDER.index(self.items[k]["op"]), k))
        for op_id in counts:
            self._section(op_id)["message"] = f"0 of {counts[op_id]} done"
        for key in ordered:
            it = self.items[key]
            sec = self._section(it["op"])
            if self.cancelled:
                it.update(status="cancelled", message="Cancelled")
                continue
            sec["message"] = f"Generating “{it['name']}” ({sec['done'] + sec['failed'] + 1} of {sec['total']})"
            self._generate_item(it, task["slot"], task.get("guidance"))
            if it["status"] == "done":
                sec["done"] += 1
            else:
                sec["failed"] += 1
                sec["error"] = it.get("error")
            run["slot"] = run["slot"] or it.get("slot")
            run["model"] = run["model"] or it.get("model")
        for op_id in counts:
            sec = self._section(op_id)
            if self.cancelled and sec["done"] + sec["failed"] < sec["total"]:
                sec.update(status="cancelled", message=f"Cancelled: {sec['done']} of {sec['total']} done")
            elif sec["failed"]:
                sec.update(status="error" if not sec["done"] else "partial",
                           message=f"{sec['done']} of {sec['total']} done, {sec['failed']} failed")
            else:
                sec.update(status="done", message=f"{sec['done']} of {sec['total']} done", error=None)
        run["finished_at"], run["elapsed_ms"] = _iso(), int((time.time() - t0) * 1000)

    def _run_regenerate(self, task: dict):
        t0 = time.time()
        it = self.items[task["item"]]
        run = {"run": task["run"], "kind": "regenerate", "item": it["key"], "sections": {it["op"]: 1},
               "started_at": _iso(), "finished_at": None, "slot": None, "model": None, "sketch": "not needed",
               "elapsed_ms": 0, "items": [it["key"]]}
        self.runs.append(run)
        if not self.cancelled:
            self._generate_item(it, task["slot"], task.get("note"))
        run.update(slot=it.get("slot"), model=it.get("model"), finished_at=_iso(),
                   elapsed_ms=int((time.time() - t0) * 1000))

    # ------------------------------------------------------------------ sketch
    def _known_items(self) -> list[dict]:
        return [{"key": k, "section": self.items[k]["op"], "name": self.items[k]["name"],
                 "subject_id": self.items[k]["subject_id"], "role": self.items[k]["role"][:200],
                 "status": self.items[k]["status"]} for k in self.order]

    def _sketch(self, job: Job, counts: dict, guidance: str | None = None) -> list[dict]:
        svc = self.svc
        sections = {op: svc.contracts.operation(op)["name"] for op in counts}
        schema = {"type": "object", "additionalProperties": False,
                  "properties": {"world_summary": {"type": "string"},
                                 "items": {"type": "array", "items": {
                                     "type": "object", "additionalProperties": False,
                                     "properties": {"section": {"enum": sorted(counts)}, "name": {"type": "string"},
                                                    "role": {"type": "string"},
                                                    "links": {"type": "array", "items": {"type": "string"}}},
                                     "required": ["section", "name", "role", "links"]}}},
                  "required": ["world_summary", "items"]}
        approved, drafts, protected = canon_context(svc.engine, self.project_id, self.branch_id)
        task = ("Bible Builder world sketch. From the book idea, plan the story bible entries requested in "
                "context.requested (section ID -> how many) and return exactly that many items per section. Each item "
                "has a short distinctive display name, a one or two sentence role (who/what it is and why it matters to "
                "the story) and 'links': exact names of other items (new ones in this answer, or entries in "
                "context.existing_items / context.canon) it is tied to - e.g. a character's home location, a faction's "
                "members, a relationship's two characters. Fit the world summary and existing entries; never reuse an "
                "existing name for a different thing. world_summary: two or three sentences describing the world. "
                "Return only the JSON object."
                + (" Follow context.author_guidance for this run (for example cover the listed roles or types, one "
                   "item per listed role where the counts allow)." if guidance else ""))
        context = {"book_idea": self.idea, "requested": counts, "sections": sections,
                   "world_summary_so_far": self.world_summary, "existing_items": self._known_items(),
                   "canon": {"approved_records": [{k: a[k] for k in ("module_id", "kind", "record_id", "names",
                                                                        "concept", "subject_ids")} for a in approved],
                             "draft_records": drafts}}
        if guidance:
            context["author_guidance"] = guidance
        profile = book_profile_brief(svc.store, self.project_id)
        if profile:
            context["book_profile"] = profile
        data = svc._call_ai(job, op_for_roles="A", task=task, schema=schema, context=context, protected=protected)
        self._phase("World sketch ready", job)
        if isinstance(data.get("world_summary"), str) and data["world_summary"].strip() and not self.world_summary:
            self.world_summary = data["world_summary"].strip()[:1500]
        items = [i for i in data.get("items") or [] if isinstance(i, dict) and i.get("section") in counts]
        return items

    def _add_items(self, sketch: list[dict], counts: dict, run_no: int) -> list[str]:
        with self._lock:
            approved, drafts, _ = canon_context(self.svc.engine, self.project_id, self.branch_id)
            if not self.taken_subjects:
                for r in approved + drafts:
                    self.taken_subjects.update(r.get("subject_ids") or [])
            # Names already used (saved canon, this session's entries, earlier rows of this sketch): an AI that
            # suggests the same character twice gets a placeholder instead, so it invents a different one.
            taken_names = {str(n).strip().lower() for r in approved + drafts
                           for n in [r.get("concept")] + list(r.get("names") or []) if str(n or "").strip()}
            taken_names |= {str(i.get("name") or "").strip().lower() for i in self.items.values()
                            if not i.get("placeholder")}
            new = []
            per = {op: [i for i in sketch if i.get("section") == op][:n] for op, n in counts.items()}
            for op_id, n in counts.items():
                label = self.svc.contracts.operation(op_id)["name"]
                rows = per[op_id] + [{"section": op_id, "name": "", "role": "", "links": []}] * (n - len(per[op_id]))
                for row in rows:
                    name = str(row.get("name") or "").strip()[:120]
                    dup = name if name and name.lower() in taken_names else None
                    if dup:
                        name = ""
                    elif name:
                        taken_names.add(name.lower())
                    key = self._new_item(op_id, name, row.get("role"), run_no, label=label,
                                         raw_links=list(row.get("links") or []))
                    item = self.items[key]
                    if dup:
                        item["duplicate_of"] = dup
                        item["message"] = f"“{dup}” is already in the book: the AI makes a different one"
                    new.append(key)
            by_name = {self.items[k]["name"].lower(): k for k in self.order}
            for k in new:
                it = self.items[k]
                links = []
                for nm in it.pop("raw_links"):
                    tgt = by_name.get(str(nm).strip().lower())
                    if tgt and tgt != k and tgt not in links:
                        links.append(tgt)
                it["links"] = links
            return new

    def _new_item(self, op_id: str, name: str, role, run_no: int, *, label: str | None = None,
                  raw_links: list | None = None) -> str:
        label = label or self.svc.contracts.operation(op_id)["name"]
        seq = sum(1 for k in self.items if self.items[k]["op"] == op_id) + 1
        key = f"{op_id}-{seq}"
        item = {"key": key, "op": op_id, "name": name or f"{label} {seq}", "placeholder": not name,
                "role": str(role or "").strip()[:600], "raw_links": list(raw_links or []),
                "links": [], "status": "pending", "message": "Waiting", "proposal": None, "findings": [],
                "removed_refs": [], "error": None, "slot": None, "model": None, "elapsed_ms": None,
                "created_ref": None, "create_error": None, "run": run_no, "summary": None, "valid": None}
        if not self.taken_subjects:
            approved, drafts, _ = canon_context(self.svc.engine, self.project_id, self.branch_id)
            for r in approved + drafts:
                self.taken_subjects.update(r.get("subject_ids") or [])
        item["subject_id"] = slugify(item["name"], self.taken_subjects)
        self.items[key] = item
        self.order.append(key)
        return key

    def add_named(self, op_id: str, name: str, role: str = "") -> str:
        """One entry with a name that is already decided (the book's main character named in the idea, or an entry
        BookForge's checks refused that the AI makes again): no world sketch, the name is kept exactly."""
        with self._lock:
            key = self._new_item(op_id, str(name).strip()[:120], role, len(self.runs) + 1)
            self.items[key].pop("raw_links", None)
            return key

    @staticmethod
    def refusals(it: dict) -> list[str]:
        """What BookForge's checks refuse in this entry's proposal (the form, or a fact interval the save refuses)."""
        if it.get("status") != "done":
            return []
        out = [f"{f.get('rule_id')}: {f.get('message')}" for f in it.get("findings") or []
               if f.get("rule_id") in ("SCHEMA", "FACT_INTERVAL") and f.get("decision") == "FAIL"]
        if it.get("valid") is False and not out:
            out = ["SCHEMA: the entry does not fit BookForge's form"]
        return out

    # ------------------------------------------------------------------ one item
    def _generate_item(self, it: dict, slot, note: str | None):
        svc = self.svc
        it.update(status="running", message="Asking the AI", error=None)
        job = self._job(it["op"], slot)
        t0 = time.time()
        linked = [self.items[k] for k in it["links"] if k in self.items]
        others = [x for x in self._known_items() if x["key"] != it["key"]]
        for x in others:
            src = self.items[x["key"]]
            if src.get("proposal"):
                x["summary"] = summarize_payload(src["op"], src["proposal"])
        extra = {"book_idea": self.idea, "world_summary": self.world_summary,
                 "this_item": {"key": it["key"], "section": it["op"], "name": it["name"], "subject_id": it["subject_id"],
                               "role": it["role"],
                               "linked_items": [{"key": x["key"], "section": x["op"], "name": x["name"],
                                                 "subject_id": x["subject_id"], "role": x["role"][:200]} for x in linked]},
                 "builder_items": others}
        prompt = (f"Create the {svc.contracts.operation(it['op'])['name']} entry "
                  + (f"“{it['name']}”" if not it.get("placeholder") else "(invent a fitting name)")
                  + (f": {it['role']}" if it["role"] else "")
                  + f". Use subject_id '{it['subject_id']}' for this entity and the subject_ids in context.builder_items "
                  "when a fact refers to another entry (e.g. entity.location_id of a character's home place). "
                  "The book idea and world summary are in the context." + (f" Author's note: {note}" if note else ""))
        try:
            self._phase(f"Generating {it['key']} “{it['name']}”", job)
            result = svc.propose(job, prompt=prompt, current_values={}, keep=True, extra_context=extra)
            proposal = result["proposal"]
            if it.get("placeholder") and isinstance(proposal.get("concept"), str) and proposal["concept"].strip():
                it["name"] = proposal["concept"].strip()[:120]
                it["placeholder"] = False
            self._ensure_name_fact(it, proposal)
            it.update(status="done", message="Ready to review", proposal=proposal, findings=result["findings"],
                      removed_refs=result["removed_refs"], valid=result["valid"],
                      summary=summarize_payload(it["op"], proposal), companion=result.get("companion"))
        except Cancelled:
            it.update(status="cancelled", message="Cancelled", error=_err("CANCELLED", "cancelled"))
        except BookforgeError as exc:
            it.update(status="error", message="Failed", error=_err_of(exc))
        except Exception as exc:  # noqa: BLE001
            log.exception("bible item %s failed", it["key"])
            it.update(status="error", message="Failed",
                      error=_err("INTERNAL_ERROR", f"{type(exc).__name__} while generating this item"))
        it.update(slot=job.slot, model=job.model, elapsed_ms=int((time.time() - t0) * 1000))
        self._phase("Item finished", job)

    @staticmethod
    def _ensure_name_fact(it: dict, proposal: dict):
        """Deterministic housekeeping: the entry's own subject ID carries its (AI-given) display name, so
        sketch links resolve to the record that declares that ID."""
        facts = proposal.get("facts")
        if not isinstance(facts, list):
            return
        if not any(isinstance(f, dict) and f.get("subject_id") == it["subject_id"] and f.get("predicate") == "entity.name"
                   for f in facts):
            facts.insert(0, {"subject_id": it["subject_id"], "predicate": "entity.name", "value": it["name"],
                             "assertion_type": "FACT", "effective_from": None, "effective_to": None, "source_refs": []})

    # ------------------------------------------------------------------ create drafts
    def create(self, keys: list[str], edits: dict) -> dict:
        svc = self.svc
        selected = list(dict.fromkeys(keys))
        created, errors, skipped = [], [], []
        # dependency order: link targets first (cycles broken by section order then key)
        order: list[str] = []
        visiting: set = set()

        def visit(k):
            if k in order or k in visiting:
                return
            visiting.add(k)
            for t in sorted(self.items[k]["links"], key=lambda x: (SECTION_ORDER.index(self.items[x]["op"]), x)):
                if t in selected:
                    visit(t)
            visiting.discard(k)
            order.append(k)

        for k in sorted(selected, key=lambda x: (SECTION_ORDER.index(self.items[x]["op"]), x)):
            visit(k)
        t0 = time.time()
        for k in order:
            it = self.items[k]
            if it.get("created_ref"):
                skipped.append({"key": k, "reason": "already created", "ref": it["created_ref"]})
                continue
            payload = edits.get(k) if k in edits else it.get("proposal")
            if not isinstance(payload, dict):
                errors.append(dict(key=k, **_err("MISSING_INPUT", "this item has no proposal yet (generate it first)")))
                continue
            payload = copy.deepcopy(payload)
            if k in edits:
                it["proposal"] = copy.deepcopy(payload)
            payload, removed = svc.strip_refs(self.project_id, self.branch_id, it["op"], payload)
            links_made, links_dropped = [], []
            refs = payload.get("linked_refs") if isinstance(payload.get("linked_refs"), list) else []
            for t in it["links"]:
                tgt = self.items.get(t)
                if tgt and tgt.get("created_ref"):
                    if all(r.get("record_id") != tgt["created_ref"]["record_id"] for r in refs):
                        refs.append(tgt["created_ref"])
                    links_made.append({"to": t, "name": tgt["name"], "record_id": tgt["created_ref"]["record_id"]})
                else:
                    links_dropped.append({"to": t, "name": tgt["name"] if tgt else t,
                                          "reason": "not selected / not created"})
            if "linked_refs" in payload_schema(svc.contracts, it["op"]).get("properties", {}):
                payload["linked_refs"] = refs
            body = json.dumps(payload, sort_keys=True, ensure_ascii=False)
            req = build_request(project_id=self.project_id, branch_id=self.branch_id, op_id=it["op"], action="CREATE",
                                principal_id=self.principal, payload=payload,
                                idempotency_key=f"bible-{self.id}-{k}-{sha16(body)}",
                                timeout_ms=(svc.contracts.operation(it["op"]) or {}).get("timeout_ms") or 180000)
            resp = svc.engine.dispatch(req, self.principal)
            if resp["status"] == "DRAFT" and resp["output_refs"]:
                ref = resp["output_refs"][0]
                if k not in edits and it.get("slot"):
                    note_writer(svc.store, self.project_id, self.branch_id, ref["record_id"], ref["version"],
                                it.get("slot"))
                it.update(created_ref=ref, create_error=None, links_made=links_made, links_dropped=links_dropped,
                          removed_on_create=removed)
                comp = it.get("companion") if it["op"] == "A01" else None
                if isinstance(comp, dict) and comp.get("character_sheet") is not None:
                    try:  # the AI's character sheet and voice card belong to the character just made (P7/P17)
                        chars_mod.save_entry(svc.store, self.project_id, self.branch_id, ref["record_id"],
                                             sheet=comp["character_sheet"], voice=comp.get("voice_card"), by="ai",
                                             slot=it.get("slot"), name=it.get("name"), subject_id=it.get("subject_id"))
                    except Exception:  # noqa: BLE001 - the character is saved; its sheet can be made again later
                        log.exception("could not save the character sheet of %s", ref["record_id"])
                created.append({"key": k, "op": it["op"], "name": it["name"], "ref": ref, "status": resp["status"],
                                "findings": len(resp.get("findings") or []), "links_made": links_made,
                                "links_dropped": links_dropped, "removed_refs": removed})
            else:
                e = (resp.get("errors") or [{}])[0]
                err = dict(key=k, **_err(e.get("code") or resp["status"], e.get("message") or resp["status"],
                                         path=e.get("path") or ""))
                it["create_error"] = err
                errors.append(err)
        entry = {"at": _iso(), "selected": selected, "created": [c["key"] for c in created],
                 "errors": [{"key": e["key"], "code": e["code"], "message": e["message"]} for e in errors],
                 "elapsed_ms": int((time.time() - t0) * 1000)}
        self.creates.append(entry)
        log.info("bible create session=%s selected=%s created=%s errors=%s", self.id, len(selected), len(created),
                 len(errors))
        try:
            self.write_report()
        except OSError:
            log.exception("bible builder report could not be written")
        return {"created": created, "errors": errors, "skipped": skipped, "session": self.public(),
                "next_steps": ["Open each new draft and press Validate, then Accept, to make it canon.",
                               "Then start planning: B01 Premise/Concept Builder (it can use these records as "
                               "canon_refs)."]}

    # ------------------------------------------------------------------ report
    def build_report(self) -> dict:
        proj = self.svc.store.project(self.project_id)
        items = []
        for k in self.order:
            it = self.items[k]
            status = it["status"]
            outcome = ("created" if it.get("created_ref") else
                       "generated, not created" if status == "done" else status)
            items.append({"key": k, "section": it["op"], "name": it["name"], "status": status, "outcome": outcome,
                          "reason": (it.get("error") or {}).get("message"),
                          "create_error": (it.get("create_error") or {}).get("message"),
                          "slot": it.get("slot"), "model": it.get("model"), "elapsed_ms": it.get("elapsed_ms"),
                          "run": it.get("run"), "record_id": (it.get("created_ref") or {}).get("record_id"),
                          "links_planned": [self.items[t]["name"] for t in it["links"] if t in self.items],
                          "links_made": it.get("links_made") or [],
                          "removed_refs": (it.get("removed_refs") or []) + (it.get("removed_on_create") or []),
                          "proposal_chars": len(json.dumps(it["proposal"], ensure_ascii=False)) if it.get("proposal")
                          else 0,
                          "findings": len(it.get("findings") or [])})
        sections = []
        for k in A_OPS:
            if k in self.sections:
                s = self.sections[k]
                its = [i for i in items if i["section"] == k]
                sections.append({"section": k, "name": s["name"], "requested": s["requested"], "status": s["status"],
                                 "generated": sum(1 for i in its if i["status"] == "done" or i["outcome"] == "created"),
                                 "failed": sum(1 for i in its if i["status"] == "error"),
                                 "created": sum(1 for i in its if i["outcome"] == "created"), "message": s["message"]})
        return {"kind": "bible-builder", "session_id": self.id, "bookforge_version": __version__,
                "contract_version": CONTRACT_VERSION, "written_at": _iso(),
                "project": {"project_id": self.project_id, "name": proj["name"] if proj else None}
                | ({} if proj else {"deleted": True}),
                "branch_id": self.branch_id, "idea_chars": len(self.idea), "idea_sha256_16": sha16(self.idea),
                "slot_preference": self.slot_pref or "auto",
                "runs": [{k: v for k, v in r.items() if k != "items"} | {"items": len(r.get("items") or [])}
                         for r in self.runs],
                "sections": sections, "skipped_sections": self.skipped, "items": items, "creates": self.creates,
                "counts": {"generated": sum(1 for i in items if i["status"] == "done" or i["outcome"] == "created"),
                           "failed": sum(1 for i in items if i["status"] == "error"),
                           "created": sum(1 for i in items if i["outcome"] == "created"),
                           "discarded": sum(1 for i in items if i["outcome"] == "generated, not created")}}

    def write_report(self):
        rep = self.build_report()
        self.svc.reports_dir.mkdir(parents=True, exist_ok=True)
        md_path = self.svc.reports_dir / f"bible-builder-{self.stamp}.md"
        js_path = self.svc.reports_dir / f"bible-builder-{self.stamp}.json"
        js_path.write_text(json.dumps(rep, indent=2, ensure_ascii=False), encoding="utf-8")
        md_path.write_text(render_markdown(rep), encoding="utf-8")
        self.report_paths = (md_path, js_path)
        return self.report_paths


def _cell(v) -> str:
    return str("" if v is None else v).replace("|", "\\|").replace("\n", " ")


def _project_label(project: dict) -> str:
    if project.get("deleted") or not project.get("name"):
        return "(a book that was deleted)" if project.get("deleted") else "(unnamed book)"
    return _cell(project["name"])


def render_markdown(rep: dict) -> str:
    c = rep["counts"]
    out = [f"# BookForge Bible Builder report", "",
           f"- Written: {rep['written_at']}", f"- BookForge {rep['bookforge_version']}, contract {rep['contract_version']}",
           f"- Project: {_project_label(rep['project'])} ({rep['project']['project_id']}), branch {rep['branch_id']}",
           f"- Session: {rep['session_id']}", f"- Book idea: {rep['idea_chars']} characters (sha256 {rep['idea_sha256_16']}…;"
           " the text itself is not stored here)", f"- AI choice: {rep['slot_preference']}", "",
           "## Summary", "",
           f"{c['generated']} item(s) generated, {c['failed']} failed, {c['created']} created as drafts, "
           f"{c['discarded']} generated but not created.", "",
           "## Sections", "", "| Section | Requested | Generated | Failed | Created | Status |", "|---|---|---|---|---|---|"]
    for s in rep["sections"]:
        out.append(f"| {s['section']} {_cell(s['name'])} | {s['requested']} | {s['generated']} | {s['failed']} | "
                   f"{s['created']} | {_cell(s['message'] or s['status'])} |")
    out += ["", "## Runs", "", "| Run | Kind | Sections | AI slot | Model | Sketch | Time |", "|---|---|---|---|---|---|---|"]
    for r in rep["runs"]:
        secs = ", ".join(f"{k}×{v}" for k, v in (r.get("sections") or {}).items())
        out.append(f"| {r['run']} | {r['kind']} | {secs} | {r.get('slot') or '-'} | {_cell(r.get('model') or '-')} | "
                   f"{r.get('sketch')} | {(r.get('elapsed_ms') or 0) / 1000:.1f} s |")
    out += ["", "## Items", "", "| Item | Name | Outcome | Record | AI | Time | Links made | Notes |",
            "|---|---|---|---|---|---|---|---|"]
    for i in rep["items"]:
        notes = []
        if i["reason"]:
            notes.append(f"failed: {i['reason']}")
        if i["create_error"]:
            notes.append(f"create failed: {i['create_error']}")
        if i["removed_refs"]:
            notes.append(f"{len(i['removed_refs'])} invented link(s) removed")
        links = ", ".join(f"{l['name']} ({l['record_id']})" for l in i["links_made"]) or "-"
        out.append(f"| {i['key']} | {_cell(i['name'])} | {i['outcome']} | {i['record_id'] or '-'} | "
                   f"{i['slot'] or '-'} {_cell(i['model'] or '')} | {(i['elapsed_ms'] or 0) / 1000:.1f} s | "
                   f"{_cell(links)} | {_cell('; '.join(notes) or '-')} |")
    removed = [(i["key"], r) for i in rep["items"] for r in i["removed_refs"]]
    if removed:
        out += ["", "## Invented links removed", ""]
        out += [f"- {k}: {r.get('module_id')} {r.get('record_id')} v{r.get('version')} at {r.get('path')} — "
                f"{_cell(r.get('reason'))}" for k, r in removed]
    if rep["creates"]:
        out += ["", "## Created as drafts", ""]
        for cr in rep["creates"]:
            out.append(f"- {cr['at']}: selected {len(cr['selected'])}, created {len(cr['created'])}"
                       + (f", errors: " + "; ".join(f"{e['key']} {e['code']}" for e in cr["errors"]) if cr["errors"]
                          else ""))
    out += ["", "Drafts are not approved: validate and accept each record, then plan the book (B01 premise).",
            "This report never contains API keys, connection keys, or the AI prompts and replies.", ""]
    return "\n".join(out)
