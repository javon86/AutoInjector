"""Set K runtime helpers: clock, revisioned module state, quota ledger and project bootstrap.

Handlers in modules/set_k.py stay pure decision code; they read durable state here and
stage compare-and-set writes through ctx.on_commit so every queue/lease/quota mutation is
atomic with the operation's own record, audit, receipt and outbox (Shared Contract s5).

The quota ledger (K12) is trusted storage: limits are configured by an authorized
principal through configure_quota(); caller-supplied balances are never used.
Settlement/cancellation follow the K set rules (integer minor units, explicit currency).
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from .canonical import sha256_json
from .errors import BookforgeError
from .store import new_id, utcnow

NS_JOBS = "K05.jobs"
NS_JOBIDX = "K05.jobidx"
NS_CTRL = "K05.control"
CTRL_KEY = "queue"
NS_K07 = "K07.decisions"
NS_K07_ATTEMPTS = "K07.attempts"
NS_K09 = "K09.checkpoints"
NS_K01 = "K01.project"
NS_LEDGER = "K12.ledger"

LEASE_SECONDS = 60
HEARTBEAT_SECONDS = 20
DEFAULT_SETTINGS = {"locale": "en-US", "default_mode": "MANUAL", "max_parallel_jobs": 1}


def now() -> datetime:
    """Queue/approval clock (tests monkeypatch this to simulate lease expiry)."""
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


# ---------------------------------------------------------------------- revisioned state
def read_state(store, project_id: str, branch_id: str, namespace: str, key: str):
    """Return (value, revision); (None, 0) when absent."""
    row = store.query_one("SELECT value, revision FROM module_state WHERE project_id=? AND branch_id=? AND "
                          "namespace=? AND key=?", (project_id, branch_id, namespace, key))
    return (json.loads(row["value"]), row["revision"]) if row else (None, 0)


def tx_read_state(tx, project_id: str, branch_id: str, namespace: str, key: str):
    """Same as read_state but inside a commit transaction (BEGIN IMMEDIATE holds the write lock)."""
    row = tx.conn.execute("SELECT value, revision FROM module_state WHERE project_id=? AND branch_id=? AND "
                          "namespace=? AND key=?", (project_id, branch_id, namespace, key)).fetchone()
    return (json.loads(row["value"]), row["revision"]) if row else (None, 0)


def tx_list_state(tx, project_id: str, branch_id: str, namespace: str) -> dict:
    rows = tx.conn.execute("SELECT key, value FROM module_state WHERE project_id=? AND branch_id=? AND namespace=? "
                           "ORDER BY key", (project_id, branch_id, namespace)).fetchall()
    return {r["key"]: json.loads(r["value"]) for r in rows}


def queue_control(store, project_id: str, branch_id: str):
    v, rev = read_state(store, project_id, branch_id, NS_CTRL, CTRL_KEY)
    return (v or {"paused": False, "generation": 0}), rev


def project_settings(store, project_id: str, branch_id: str) -> dict:
    for b in (branch_id, "main"):
        v, _ = read_state(store, project_id, b, NS_K01, "identity")
        if v:
            return dict(DEFAULT_SETTINGS, **v.get("settings", {}))
    return dict(DEFAULT_SETTINGS)


def k09_checkpoint(store, project_id: str, branch_id: str, record_id: str) -> dict | None:
    """Binding of a K09 approval (action hash, source versions, policy, requester)."""
    v, _ = read_state(store, project_id, branch_id, NS_K09, record_id)
    return v


def check_k09_authorization(store, rec: dict, subject_ref: dict | None, path: str) -> dict:
    """A K09 authorization must be the CURRENT head, APPROVED, unexpired and bind the subject pin."""
    latest = store.get_record(rec["project_id"], rec["branch_id"], rec["record_id"])
    if latest is None or latest["version"] != rec["version"]:
        raise BookforgeError("APPROVAL_REQUIRED", path, "authorization has a newer revision (revoked/expired?); "
                             "pin the current K09 decision")
    data = rec.get("data") or {}
    if data.get("decision") != "APPROVED":
        raise BookforgeError("APPROVAL_REQUIRED", path, f"authorization decision is {data.get('decision')}")
    if not data.get("expiry") or parse_time(data["expiry"]) <= now():
        raise BookforgeError("EXPIRED_APPROVAL", path, "authorization has expired")
    binding = k09_checkpoint(store, rec["project_id"], rec["branch_id"], rec["record_id"]) or {}
    if subject_ref is not None:
        pins = {(r["record_id"], r["version"], r["content_hash"]) for r in binding.get("impact", {}).get(
            "source_versions", [])}
        if (subject_ref["record_id"], subject_ref["version"], subject_ref["content_hash"]) not in pins:
            raise BookforgeError("APPROVAL_REQUIRED", path, "authorization does not bind this exact subject revision")
    return binding


# ---------------------------------------------------------------------- quota ledger
def ledger_key(account_id: str, period: str) -> str:
    return f"{account_id}|{period}"


def configure_quota(store, principal_id: str, project_id: str, branch_id: str, *, account_id: str, period: str,
                    limit: int, currency: str) -> dict:
    """Trusted quota configuration (an admin action). Keeps spent/reserved; never lowers below them silently."""
    if not store.has_scope(principal_id, project_id, branch_id, "K12:update"):
        raise BookforgeError("PERMISSION_DENIED", "", "missing scope K12:update", status="REJECTED")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 0:
        raise BookforgeError("INVALID_INPUT", "/limit", "limit is a non-negative integer of minor units",
                             status="REJECTED")
    if not (isinstance(currency, str) and len(currency) == 3 and currency.isupper()):
        raise BookforgeError("INVALID_INPUT", "/currency", "ISO currency code required", status="REJECTED")
    key = ledger_key(account_id, period)
    with store.transaction() as tx:
        cur, rev = tx_read_state(tx, project_id, branch_id, NS_LEDGER, key)
        if cur and cur["currency"] != currency:
            raise BookforgeError("INVALID_INPUT", "/currency", "ledger currency cannot change (no conversion)",
                                 status="REJECTED")
        led = cur or {"account_id": account_id, "period": period, "currency": currency, "spent": 0,
                      "reserved": 0, "reservations": {}}
        led["limit"] = limit
        tx.put_state(project_id, branch_id, NS_LEDGER, key, led, expected_revision=rev)
        _ledger_audit(tx, project_id, branch_id, principal_id, "CONFIGURE", {"key": key, "limit": limit})
    return led


def _ledger_audit(tx, project_id, branch_id, principal_id, action, detail):
    tx.insert_audit(project_id=project_id, branch_id=branch_id, request_id=new_id("ledger"),
                    attempt_id=new_id("attempt"), operation_id="K12", action=f"LEDGER_{action}",
                    principal_id=principal_id, input_refs=[], output_refs=[], outcome="SUCCESS",
                    evidence_type="LEDGER", evidence_origin="AUTHORITATIVE")
    tx.insert_outbox(project_id, branch_id, f"quota.{action.lower()}", detail)


def get_ledger(store, project_id, branch_id, account_id, period):
    return read_state(store, project_id, branch_id, NS_LEDGER, ledger_key(account_id, period))


def current_period() -> str:
    """Quota period used for automatic AI dispatch reservations: the UTC calendar month (YYYY-MM)."""
    return now().strftime("%Y-%m")


def reserve(store, principal_id, project_id, branch_id, *, account_id, period, job_id: str, amount: int,
            currency: str | None = None) -> dict | None:
    """Atomically reserve `amount` minor units before paid work (K12 rule spent+reserved+estimate <= limit).

    Returns the reservation ({account_id, period, reservation_id, amount}), or None when no ledger is configured
    for this account/period. Raises QUOTA_EXCEEDED (work held, nothing reserved) when the quota is insufficient.
    """
    if not isinstance(amount, int) or isinstance(amount, bool) or amount < 0:
        raise BookforgeError("INVALID_INPUT", "/estimated_cost", "estimate is integer minor units", status="REJECTED")
    key = ledger_key(account_id, period)
    with store.transaction() as tx:
        led, rev = tx_read_state(tx, project_id, branch_id, NS_LEDGER, key)
        if led is None:
            return None
        if currency is not None and led["currency"] != currency:
            raise BookforgeError("QUOTA_EXCEEDED", "", f"the cost cap for {account_id} ({period}) is in "
                                 f"{led['currency']} but this work is priced in {currency}; BookForge does not "
                                 "convert currencies, so the work is held")
        if led["spent"] + led["reserved"] + amount > led["limit"]:
            left = max(0, led["limit"] - led["spent"] - led["reserved"])
            raise BookforgeError("QUOTA_EXCEEDED", "", f"the cost cap for {account_id} ({period}) is reached: this "
                                 f"AI call may cost up to {amount} and only {left} of {led['limit']} "
                                 f"{led['currency']} minor units remain. The work is held; raise the cap or wait for "
                                 "the next period, or write this part yourself.",
                                 unresolved=["user_decision:quota_exceeded"])
        reservation_id = new_id("resv")
        led["reserved"] += amount
        led["reservations"][reservation_id] = {"job_id": job_id, "amount": amount, "state": "RESERVED",
                                               "currency": led["currency"], "account_id": account_id,
                                               "period": period, "at": iso(now())}
        tx.put_state(project_id, branch_id, NS_LEDGER, key, led, expected_revision=rev)
        _ledger_audit(tx, project_id, branch_id, principal_id, "RESERVE",
                      {"key": key, "reservation_id": reservation_id, "amount": amount, "job_id": job_id})
    return {"account_id": account_id, "period": period, "reservation_id": reservation_id, "amount": amount}


def _find_reservation(led: dict, reservation_id: str) -> dict:
    res = led["reservations"].get(reservation_id)
    if res is None:
        raise BookforgeError("NOT_FOUND", "/reservation_id", "unknown reservation", status="REJECTED")
    return res


def settle(store, principal_id, project_id, branch_id, *, account_id, period, reservation_id,
           actual: int, ambiguous: bool = False) -> dict:
    """Release a reservation and record actual usage atomically.

    actual > reserved amount: the incurred charge is recorded in full (never pretended away) and
    the result says hold_next_work when the ledger is now over its limit. ambiguous=True keeps
    the reservation until the provider status reconciles.
    """
    if not isinstance(actual, int) or isinstance(actual, bool) or actual < 0:
        raise BookforgeError("INVALID_INPUT", "/actual", "actual usage is integer minor units", status="REJECTED")
    key = ledger_key(account_id, period)
    with store.transaction() as tx:
        led, rev = tx_read_state(tx, project_id, branch_id, NS_LEDGER, key)
        if led is None:
            raise BookforgeError("NOT_FOUND", "/account_id", "quota not configured")
        res = _find_reservation(led, reservation_id)
        if res["state"] not in ("RESERVED", "AMBIGUOUS"):
            raise BookforgeError("VERSION_CONFLICT", "/reservation_id", f"reservation already {res['state']}",
                                 status="REJECTED")
        if ambiguous:
            res["state"] = "AMBIGUOUS"
        else:
            led["reserved"] -= res["amount"]
            led["spent"] += actual
            res.update(state="SETTLED", actual=actual, settled_at=utcnow())
        tx.put_state(project_id, branch_id, NS_LEDGER, key, led, expected_revision=rev)
        _ledger_audit(tx, project_id, branch_id, principal_id, "SETTLE",
                      {"key": key, "reservation_id": reservation_id, "actual": actual, "ambiguous": ambiguous})
    overrun = max(0, actual - res["amount"]) if not ambiguous else 0
    return {"ledger": led, "overrun": overrun,
            "hold_next_work": led["spent"] + led["reserved"] >= led["limit"] or overrun > 0}


def cancel_reservation(store, principal_id, project_id, branch_id, *, account_id, period, reservation_id,
                       spent: int = 0) -> dict:
    """Cancellation refunds only the unspent part of the reservation."""
    key = ledger_key(account_id, period)
    with store.transaction() as tx:
        led, rev = tx_read_state(tx, project_id, branch_id, NS_LEDGER, key)
        if led is None:
            raise BookforgeError("NOT_FOUND", "/account_id", "quota not configured")
        res = _find_reservation(led, reservation_id)
        if res["state"] != "RESERVED":
            raise BookforgeError("VERSION_CONFLICT", "/reservation_id", f"reservation is {res['state']}",
                                 status="REJECTED")
        led["reserved"] -= res["amount"]
        led["spent"] += spent
        res.update(state="CANCELLED", actual=spent, settled_at=utcnow())
        tx.put_state(project_id, branch_id, NS_LEDGER, key, led, expected_revision=rev)
        _ledger_audit(tx, project_id, branch_id, principal_id, "CANCEL",
                      {"key": key, "reservation_id": reservation_id, "spent": spent})
    return led


# ---------------------------------------------------------------------- project bootstrap (K01)
def create_project(engine, principal_id: str, name: str, settings: dict | None = None, **kw) -> tuple[str, dict]:
    """K01 path: kernel bootstrap (identity, main branch, owner grants, manifest) + K01 settings record."""
    from .requests import build_request
    settings = dict(DEFAULT_SETTINGS, **(settings or {}))
    pid = engine.bootstrap_project(principal_id, name, settings=settings, **kw)
    req = build_request(project_id=pid, branch_id="main", op_id="K01", action="CREATE", principal_id=principal_id,
                        payload={"project_name": name, "settings": settings, "owner_id": principal_id})
    return pid, engine.dispatch(req, principal_id)


def deterministic_fraction(*parts) -> float:
    return int(sha256_json(list(parts))[:8], 16) / float(2 ** 32)


def lease_expiry(at: datetime) -> str:
    return iso(at + timedelta(seconds=LEASE_SECONDS))
