"""REAL BookForge <-> REAL AutoInjector bridge end to end (campaign area "bridge").

Runs the AutoInjector desktop app's node test ``desktop-app/test/bookforge-e2e.test.js`` once (module fixture):
this BookForge server (``python -m bookforge``) is paired with AutoInjector's main.js through its own
pair-autoinjector API and makes a short story with ⚡ Make a book for me; the prompts go through the real bridge,
sendTextTo/pollSite and the real automation scripts into three fake chat sites in Chromium, whose answers come from
BookForge's own deterministic test AI (``fake_site_brain.py`` -> ``tests/autobook_fake.py``). Two disturbances
are injected: a request that arrives while Claude answers the user's quick side question (``steal``) and a request
that times out while Gemini answers a slow side question (``timeout``).

Each check of that run is one test below; a known bridge bug would be a strict xfail (KNOWN), so it flips when fixed.

Needs: node, the desktop-app checkout next to this BookForge (or AUTOINJECTOR_DESKTOP_APP=<path>) with its
node_modules (playwright) and Chromium. Skipped otherwise, or with BF_E2E=0. ~1.5-2 min.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
APP = Path(os.environ.get("AUTOINJECTOR_DESKTOP_APP") or (ROOT.parent / "desktop-app"))
E2E = APP / "test" / "bookforge-e2e.test.js"

pytestmark = pytest.mark.skipif(
    os.environ.get("BF_E2E") == "0" or not E2E.is_file() or shutil.which("node") is None
    or not (APP / "node_modules" / "playwright").exists(),
    reason="needs the AutoInjector desktop-app (with node_modules) next to BookForge; BF_E2E=0 skips")

# check id -> why it is expected to fail with the bridge as shipped (strict: flips to XPASS when fixed). Empty: the
# bridge bugs this run pinned (BF-01, BF-02, BF-03, BF-16, NEW-bridge-1 and their consequences) are fixed.
KNOWN: dict[str, str] = {}
CHECKS = ["pair-link", "pair-bridge-url", "pair-api", "pair-no-key", "connected", "idle-relay", "idle-no-bridge",
          "run-start", "run-done", "no-unexpected-pauses", "three-ais", "BF-01", "BF-01-prompt", "BF-01-stored",
          "timeout-forced", "BF-02", "late-window", "no-double-typing", "BF-03", "hop-limit", "BF-16", "no-leak",
          "no-steal", "side-relay", "relay-trace", "bridge-errors", "late-steal", "fake-ai", "stored-canon",
          "stored-chapters", "export", "bridge-status"]


@pytest.fixture(scope="module")
def e2e(tmp_path_factory):
    out = tmp_path_factory.mktemp("bf-e2e") / "run.json"
    env = dict(os.environ, SEED="1", QUIRKS="default", FAULTS="steal,timeout", OUT=str(out), BOOKFORGE_ROOT=str(ROOT))
    env.pop("BF_BRIDGE_IMPL", None)
    # The e2e's fake chat sites answer only BookForge prompts and side questions, not AutoInjector's check-in
    # ("Reply with only this word: …"): a check-in BookForge asks for before the run (POST /v1/probe, P18.9) fails
    # there and ~90 s later the desktop marks every site "repairing", so the run would wait. Until the fake sites
    # answer check-ins, BookForge skips its pre-run check-in here (it is tested in tests/test_failover_review.py).
    env["BOOKFORGE_PRERUN_CHECKIN"] = "0"
    proc = subprocess.run(["node", str(E2E)], cwd=str(APP), env=env, capture_output=True, text=True, timeout=420)
    if not out.exists():
        pytest.fail(f"the e2e run produced no result (exit {proc.returncode}):\n{proc.stdout[-3000:]}\n{proc.stderr[-2000:]}")
    data = json.loads(out.read_text())
    data["_stdout"] = proc.stdout
    return data


@pytest.mark.parametrize("check_id", [
    pytest.param(c, marks=pytest.mark.xfail(strict=True, reason=KNOWN[c])) if c in KNOWN else c for c in CHECKS])
def test_e2e_check(e2e, check_id):
    res = {c["id"]: c for c in e2e["checks"]}
    if check_id not in res:
        pytest.fail(f"check {check_id} did not run:\n{e2e['_stdout'][-3000:]}")
    c = res[check_id]
    assert c["ok"], f"{c['msg']}\n" + "\n".join(f"  - {e}" for e in c["evidence"][:12])
