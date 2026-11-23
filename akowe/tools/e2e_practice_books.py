#!/usr/bin/env python3
# Usage (from the akowe folder): python tools/e2e_practice_books.py .
"""End-to-end check: the real Akọwe HTTP server, Practice AI slots, whole books of every length and option set,
then every read page of each book. Prints PASS/FAIL lines; exit 1 on any failure."""
import json
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from akowe.server import App, make_handler  # noqa: E402

FAILS = []


def ok(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -- {detail}"), flush=True)
    if not cond:
        FAILS.append(name)


data = Path(tempfile.mkdtemp(prefix="e2e-akowe-", dir="/dev/shm"))
app = App(data)
httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
app.port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{app.port}/api"
TOK = app.token


def api(method, path, body=None, raw=False):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            b = r.read()
            if raw:
                return r.status, b
            try:
                return r.status, (json.loads(b) if b else None)
            except ValueError:
                return r.status, b[:300]
    except urllib.error.HTTPError as e:
        b = e.read()
        try:
            return e.code, json.loads(b)
        except Exception:  # noqa: BLE001
            return e.code, b[:300]


# ---------------------------------------------------------------- slots: three Practice AIs
for sid in ("AI-1", "AI-2", "AI-3"):
    st, out = api("PUT", f"/slots/{sid}", {"adapter_id": "practice"})
    ok(f"configure {sid} practice", st == 200, f"{st} {out}")
st, out = api("GET", "/slots")
ok("slots list", st == 200)
for sid in ("AI-1", "AI-2"):
    st, out = api("GET", f"/slots/{sid}/health")
    ok(f"health {sid}", st == 200, f"{st} {out}")


def wait_run(rid, limit=2400):
    t0 = time.time()
    while time.time() - t0 < limit:
        st, r = api("GET", f"/autobook/{rid}")
        if st != 200:
            return None
        s = r.get("status")
        if s == "paused" and (r.get("problem") or {}).get("code") == "NO_SECOND_AI":
            api("POST", f"/autobook/{rid}/decide", {"choice": "approve_anyway"})
        if s in ("done", "cancelled", "failed") or (s == "paused" and r.get("problem")):
            return r
        time.sleep(0.5)
    return api("GET", f"/autobook/{rid}")[1]


READS = ["book", "progress", "export", "journal", "activity", "costs", "grid", "chapters", "chapters/1", "report",
         "binder", "bible", "save", "storymap", "style"]


def check_book(label, run):
    pid, branch = run["project_id"], run.get("branch_id") or "main"
    for r in READS:
        st, out = api("GET", f"/projects/{pid}/branches/{branch}/{r}")
        ok(f"{label}: GET {r}", st in (200, 404) and st != 500, f"{st} {str(out)[:200]}")
    st, rep = api("GET", f"/projects/{pid}/branches/{branch}/report")
    if st == 200 and isinstance(rep, dict):
        txt = json.dumps(rep)
        ok(f"{label}: report says Practice AI", "Practice AI" in txt, "no Practice AI mention")
    st, chs = api("GET", f"/projects/{pid}/branches/{branch}/chapters")
    n = len((chs or {}).get("chapters") or []) if isinstance(chs, dict) else 0
    ok(f"{label}: has chapters", n >= 1, f"{st} {str(chs)[:200]}")
    return n


SCENARIOS = [
    ("short story, defaults", {"length": "short_story"}),
    ("novelette, five turning points + quest", {"length": "novelette", "choices": {"shape": "turning_points",
                                                                                   "kind": "quest"}}),
    ("novella, save the cat + every quality step", {"length": "novella", "choices": {"shape": "save_the_cat"}}),
    ("novel", {"length": "novel", "choices": {"shape": "turning_points"}}),
    ("short story, every new quality step off",
     {"length": "short_story", "story_doctor": False, "cut_pass": False, "voice_test": False, "subtext_check": False,
      "keep_briefs": False, "ending_writer": False, "scope_guard": False, "knowledge_grid": False,
      "predictability_probe": False, "key_scene_versions": False, "pairwise": False, "promise_ledger": False}),
]

for label, extra in SCENARIOS:
    body = dict({"author_confirms": True, "idea": "A lighthouse keeper's apprentice finds a brass key", "genre": ""},
                **extra)
    t0 = time.time()
    try:
        st, r = api("POST", "/autobook", body)
        ok(f"{label}: start", st == 202, f"{st} {r}")
        if st != 202:
            continue
        run = wait_run(r["id"])
        dt = round(time.time() - t0, 1)
        status = (run or {}).get("status")
        ok(f"{label}: finished done ({dt}s)", status == "done",
           f"status={status} problem={json.dumps((run or {}).get('problem'))[:400]}")
        if run and run.get("project_id"):
            n = check_book(label, run)
            print(f"     {label}: {n} chapter(s), {dt}s", flush=True)
    except Exception:  # noqa: BLE001
        ok(f"{label}: no exception", False, traceback.format_exc()[-600:])

# ---------------------------------------------------------------- pause / resume / cancel on a live run
st, r = api("POST", "/autobook", {"author_confirms": True, "length": "novella", "idea": "Pause test"})
if st == 202:
    rid = r["id"]
    time.sleep(1.0)
    st1, _ = api("POST", f"/autobook/{rid}/pause")
    ok("pause answers", st1 == 200)
    t0 = time.time()
    while time.time() - t0 < 60 and api("GET", f"/autobook/{rid}")[1].get("status") not in ("paused", "done"):
        time.sleep(0.3)
    s = api("GET", f"/autobook/{rid}")[1].get("status")
    ok("run pauses", s in ("paused", "done"), s)
    st2, _ = api("POST", f"/autobook/{rid}/resume")
    ok("resume answers", st2 == 200)
    time.sleep(1.0)
    st3, _ = api("POST", f"/autobook/{rid}/cancel")
    ok("cancel answers", st3 == 200)
    t0 = time.time()
    while time.time() - t0 < 60 and api("GET", f"/autobook/{rid}")[1].get("status") not in ("cancelled", "done"):
        time.sleep(0.3)
    ok("run cancels", api("GET", f"/autobook/{rid}")[1].get("status") in ("cancelled", "done"))

# ---------------------------------------------------------------- built-in self-test and workflow test
st, _ = api("POST", "/selftest", {"use_ai": True})
ok("self-test starts", st == 202, st)
t0 = time.time()
while time.time() - t0 < 600:
    s = api("GET", "/selftest")[1]
    if not s.get("running"):
        break
    time.sleep(1)
st, rep = api("GET", "/selftest")
rep = (rep or {}).get("last_report") if isinstance(rep, dict) else rep
verdict = (rep or {}).get("verdict") if isinstance(rep, dict) else None
print("     self-test status:", json.dumps(rep)[:300] if isinstance(rep, dict) else rep, flush=True)
ok("self-test verdict PASS", verdict == "PASS",
   f"{verdict} {[ (x['id'], x.get('detail')) for x in (rep or {}).get('steps', []) if x.get('status') == 'FAIL'][:5]}")

st, _ = api("POST", "/workflow-test/run", {})
ok("workflow test starts", st == 202, st)
t0 = time.time()
while time.time() - t0 < 900:
    s = api("GET", "/workflow-test")[1]
    if not s.get("running"):
        break
    time.sleep(1)
st, wf = api("GET", "/workflow-test")
rows = (wf or {}).get("rows") or [] if isinstance(wf, dict) else []
print("     workflow rows:", [(r.get("id"), r.get("status") or r.get("state")) for r in rows], flush=True)
bad_rows = [r for r in rows if str(r.get("status") or r.get("state")).lower() in ("fail", "failed", "error")]
ok("workflow test: no failed row", rows and not bad_rows, str(bad_rows)[:600])

# ---------------------------------------------------------------- the log: no tracebacks
logs = list(data.rglob("*.log"))
bad = []
for lf in logs:
    for line in lf.read_text(errors="replace").splitlines():
        if "Traceback" in line or " ERROR " in line:
            bad.append(f"{lf.name}: {line[:200]}")
ok("no ERROR / Traceback in akowe logs", not bad, "\n      ".join(bad[:15]))
print(f"\nRESULT: {len(FAILS)} failure(s)" + (": " + ", ".join(FAILS) if FAILS else ""), flush=True)
print(f"data dir: {data}")
httpd.shutdown()
sys.exit(1 if FAILS else 0)
