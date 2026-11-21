"""🧼 The clean-run score: how cleanly a Make-a-book run went (stops, fixes, repairs, waits), for the book report and
the log. Built from the run's tally (``AutoBookService.event`` counts every journal line by kind and code, so a long
run whose journal was trimmed is still counted whole); an older run without a tally falls back to its journal."""
from __future__ import annotations

# what each counted thing costs out of 10 (a stop for the author costs most: that is what an unattended run is for)
COST = {"stops": 2.0, "restored": 1.0, "fix_failed": 0.5, "repairs": 0.25, "rewrites": 0.5, "fixes": 0.1,
        "waits": 0.05}


def _counts(run: dict) -> dict:
    tally = run.get("tally") if isinstance(run.get("tally"), dict) else None
    if tally is None:  # an older run: count its journal
        tally = {}
        for e in run.get("events") or []:
            for k in (f"kind:{e.get('kind')}", f"code:{e.get('code')}" if e.get("code") else None):
                if k:
                    tally[k] = tally.get(k, 0) + 1
            if e.get("kind") == "fix" and "write it again" in str(e.get("message") or ""):
                tally["rewrite"] = tally.get("rewrite", 0) + 1
    g = lambda k: int(tally.get(k) or 0)  # noqa: E731
    return {"stops": g("kind:problem"), "fixes": max(0, g("kind:fix") - g("rewrite")), "rewrites": g("rewrite"),
            "fix_failed": g("kind:fix_failed"), "repairs": g("kind:repair"), "restored": g("code:FIX_UNDONE"),
            "waits": g("kind:wait"), "resumes": g("kind:resume")}


def score(run: dict | None) -> dict | None:
    """{score (0–10), clean (no stop and nothing put back), counts, line} or None without a run."""
    if not isinstance(run, dict):
        return None
    c = _counts(run)
    lost = sum(COST[k] * c[k] for k in COST)
    s = max(0.0, round(10.0 - lost, 1))
    clean = c["stops"] == 0 and c["restored"] == 0
    bits = [f"{c['stops']} stop{'s' if c['stops'] != 1 else ''} for you",
            f"{c['fixes']} AI fix{'es' if c['fixes'] != 1 else ''}"]
    if c["repairs"]:
        bits.append(f"{c['repairs']} repaired after Akọwe's checks")
    if c["restored"]:
        bits.append(f"{c['restored']} fix{'es' if c['restored'] != 1 else ''} undone")
    if c["rewrites"]:
        bits.append(f"{c['rewrites']} draft{'s' if c['rewrites'] != 1 else ''} written again")
    if c["fix_failed"]:
        bits.append(f"{c['fix_failed']} fix{'es' if c['fix_failed'] != 1 else ''} refused")
    if c["waits"]:
        bits.append(f"{c['waits']} wait{'s' if c['waits'] != 1 else ''} for an AI")
    line = f"🧼 Clean-run score: {s:g}/10 — " + ("a clean run: " if clean else "") + ", ".join(bits) + "."
    return {"score": s, "clean": clean, "counts": c, "line": line}


def log_line(run: dict) -> str:
    """The code-only line for akowe.log (numbers only, never the book's text)."""
    sc = score(run) or {}
    c = sc.get("counts") or {}
    return "clean-run run=%s score=%s clean=%s %s" % (run.get("id"), sc.get("score"), sc.get("clean"),
                                                     " ".join(f"{k}={v}" for k, v in sorted(c.items())))
