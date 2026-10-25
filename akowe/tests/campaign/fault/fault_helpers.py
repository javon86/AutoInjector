"""Shared helpers for the fault-injection campaign: subprocess servers, HTTP calls, and the storage invariant check."""
from __future__ import annotations

import hashlib
import http.client
import json
import signal
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER = HERE / "fault_server.py"
TOKEN = "fault-token-0123456789"
LIVE = ("queued", "running", "waiting", "pausing")


# ---------------------------------------------------------------------------------------------- subprocess server
class Proc:
    def __init__(self, data_dir: Path, *extra: str, count_file: Path | None = None):
        args = [sys.executable, str(SERVER), str(data_dir), TOKEN, *extra]
        if count_file is not None:
            args += ["--count-file", str(count_file)]
        self.p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        line = self.p.stdout.readline()
        if not line.startswith("PORT "):
            self.p.kill()
            raise RuntimeError(f"server did not start: {line!r}")
        self.port = int(line.split()[1])

    def call(self, method, path, body=None, token=TOKEN, timeout=10):
        return call(self.port, method, path, body, token=token, timeout=timeout)

    def wait_dead(self, timeout: float) -> bool:
        try:
            self.p.wait(timeout)
            return True
        except subprocess.TimeoutExpired:
            return False

    def kill(self):
        if self.p.poll() is None:
            self.p.send_signal(signal.SIGKILL)
            self.p.wait(10)
        try:
            self.p.stdout.close()
        except Exception:  # noqa: BLE001
            pass


def call(port, method, path, body=None, token=TOKEN, timeout=10, raw=None, content_type="application/json",
         headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    hdrs = dict(headers or {})
    if token:
        hdrs["Authorization"] = f"Bearer {token}"
    data = raw
    if data is None and body is not None:
        data = json.dumps(body).encode()
    if data is not None:
        hdrs["Content-Type"] = content_type
    conn.request(method, path, body=data, headers=hdrs)
    resp = conn.getresponse()
    out = resp.read()
    conn.close()
    ctype = resp.getheader("Content-Type") or ""
    if ctype.startswith("application/json"):
        try:
            return resp.status, json.loads(out)
        except ValueError:
            return resp.status, out
    return resp.status, out


# ---------------------------------------------------------------------------------------------- invariants
def check_store(data_dir: Path, *, check_assets: bool = True) -> list[str]:
    """Everything that must hold for an Akọwe data folder after any crash. Returns a list of problems."""
    probs: list[str] = []
    db = Path(data_dir) / "akowe.sqlite3"
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    try:
        ic = [r[0] for r in conn.execute("PRAGMA integrity_check")]
        if ic != ["ok"]:
            probs.append(f"integrity_check: {ic[:3]}")
        heads = {(r["project_id"], r["branch_id"], r["record_id"]): r for r in conn.execute("SELECT * FROM heads")}
        versions: dict = {}
        for r in conn.execute("SELECT project_id, branch_id, record_id, version, representation, content, "
                              "content_hash, module_id FROM records"):
            key = (r["project_id"], r["branch_id"], r["record_id"])
            versions.setdefault(key, []).append(r["version"])
            if r["representation"] == "JSON_RECORD" and hashlib.sha256(r["content"]).hexdigest() != r["content_hash"]:
                probs.append(f"record hash mismatch {key}@{r['version']}")
        for key, vs in versions.items():
            h = heads.get(key)
            if h is None:
                probs.append(f"record without head {key}")
                continue
            if sorted(vs) != list(range(1, len(vs) + 1)):
                probs.append(f"broken version chain {key}: {sorted(vs)}")
            if h["latest_version"] != max(vs):
                probs.append(f"head latest {h['latest_version']} != max version {max(vs)} for {key}")
        for key, h in heads.items():
            if key not in versions:
                probs.append(f"head without records {key}")
            av = h["approved_version"]
            if av is not None:
                lc = conn.execute("SELECT state FROM lifecycle WHERE project_id=? AND branch_id=? AND record_id=? AND "
                                  "version=?", (*key, av)).fetchone()
                if lc is None or lc["state"] not in ("APPROVED", "LOCKED"):
                    probs.append(f"approved head {key}@{av} has lifecycle {lc and lc['state']}")
        n_lc = conn.execute("SELECT COUNT(*) FROM records r LEFT JOIN lifecycle l USING(project_id, branch_id, "
                            "record_id, version) WHERE l.state IS NULL").fetchone()[0]
        if n_lc:
            probs.append(f"{n_lc} record versions without lifecycle")
        rec_keys = {(r[0], r[1], r[2], r[3]) for r in conn.execute(
            "SELECT project_id, branch_id, record_id, version FROM records")}
        for r in conn.execute("SELECT project_id, branch_id, output_refs FROM audit"):
            for ref in json.loads(r["output_refs"]) or []:
                if (ref["project_id"], ref["branch_id"], ref["record_id"], ref["version"]) not in rec_keys:
                    probs.append(f"audit names a missing record {ref['record_id']}@{ref['version']}")
        for r in conn.execute("SELECT response FROM receipts"):
            for ref in json.loads(r["response"]).get("output_refs") or []:
                if (ref["project_id"], ref["branch_id"], ref["record_id"], ref["version"]) not in rec_keys:
                    probs.append(f"receipt names a missing record {ref['record_id']}@{ref['version']}")
        for r in conn.execute("SELECT p.project_id FROM projects p LEFT JOIN branches b ON b.project_id=p.project_id "
                              "AND b.branch_id='main' WHERE b.branch_id IS NULL"):
            probs.append(f"project without main branch {r[0]}")
        for r in conn.execute("SELECT p.project_id FROM projects p WHERE NOT EXISTS (SELECT 1 FROM feature_manifests f "
                              "WHERE f.project_id=p.project_id)"):
            probs.append(f"project without manifest {r[0]}")
        if check_assets:
            for r in conn.execute("SELECT storage_uri, content_hash FROM binaries"):
                p = Path(data_dir) / "assets" / r["storage_uri"].split("/")[-1]
                if not p.exists():
                    probs.append(f"missing asset {p.name}")
                elif hashlib.sha256(p.read_bytes()).hexdigest() != r["content_hash"]:
                    probs.append(f"asset hash mismatch {p.name}")
    finally:
        conn.close()
    return probs


def jobs(data_dir: Path) -> list[dict]:
    conn = sqlite3.connect(Path(data_dir) / "akowe.sqlite3")
    try:
        return [json.loads(r[0]) for r in conn.execute("SELECT value FROM settings WHERE key LIKE 'job:%'")]
    finally:
        conn.close()


def poll(fn, timeout: float, interval: float = 0.1):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last
