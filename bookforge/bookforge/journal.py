"""📜 Book journal (R11): a readable timeline of everything that happened to one book.

Built on demand (nothing new is stored) from the kernel's audit log (who ran which step and with what outcome),
the provenance of each new revision (which AI slot/model wrote it, or the author, or BookForge itself), the outbox
activity events (AI review verdicts, AI fixes, approvals and their kind, auto-approve changes, imports) and the
events of background work for this book (Make-a-book runs and Write-all-chapters: retries, waits, pauses,
problems, backups, exports).

Entries: {at, kind, step: {set, op, name}, who, ai, what, outcome, approval, problem: {code, message}, run_id}.
They never contain API keys, connection keys, prompts, AI replies or book text: only step names, record IDs,
verdict words, error codes and BookForge's own messages. Filters: ``step`` (an operation ID like C02 or a set
letter like C) and ``problems`` (only entries with a problem or a failed outcome). ``render_markdown`` gives the
downloadable .md version.
"""
from __future__ import annotations

import json
import re

from .sets_guide import SET_GUIDE

APPROVAL_EVENTS = {
    "review.approved_by_author": "author",
    "review.auto_approved": "standing_auto_approve",
    "autobook.approved_under_consent": "run_consent",
}
APPROVAL_WORDS = {"author": "approved by you", "standing_auto_approve": "approved under your standing auto-approve "
                  "setting", "run_consent": "approved under your Make-a-book-for-me consent",
                  "workflow_test": "approved by the workflow test runner"}
ACTION_WORDS = {"CREATE": "made", "UPDATE": "made a new version of", "ACCEPT": "approved", "VALIDATE": "checked",
                "LOCK": "locked"}
STEP_KIND = {"backup": "backup", "export": "export", "wait": "retry", "retry": "retry", "pause": "pause",
             "resume": "resume", "problem": "problem", "cancel": "cancel", "review": "ai_review", "fix": "ai_fix",
             "fix_done": "ai_fix", "fix_failed": "problem", "approve": "approval", "start": "run",
             "finished": "run", "ai": "ai", "done": "step", "project": "run", "note": "note"}
SAFE_TEXT = re.compile(r"[\x00-\x1f]")


def _op_name(contracts, op: str | None) -> str | None:
    o = contracts.operation(op) if op else None
    return o["name"] if o else None


def _step(contracts, op: str | None) -> dict:
    if not op:
        return {"set": None, "op": None, "name": None}
    return {"set": op[0], "op": op, "name": _op_name(contracts, op),
            "set_name": SET_GUIDE.get(op[0], {}).get("name")}


def build(app, pid: str, branch: str, *, step: str | None = None, problems_only: bool = False,
          limit: int = 2000) -> dict:
    store, contracts = app.store, app.engine.contracts
    entries: list[dict] = []
    # approvals by record (from activity events) to label ACCEPT audit rows with their kind
    approval_of: dict[str, tuple[str, dict]] = {}
    events = store.query("SELECT event_type, payload, created_at FROM outbox WHERE project_id=? AND branch_id=? "
                         "ORDER BY created_at", (pid, branch))
    for e in events:
        try:
            p = json.loads(e["payload"])
        except ValueError:
            p = {}
        et = e["event_type"]
        if et in APPROVAL_EVENTS:
            kind = APPROVAL_EVENTS[et]
            if et == "review.approved_by_author" and p.get("how") == "workflow_test":
                kind = "workflow_test"
            for rid in p.get("record_ids") or ([p.get("record_id")] if p.get("record_id") else []):
                approval_of[rid] = (kind, p)
    prov = {}
    for r in store.query("SELECT record_id, version, transform, resource FROM provenance WHERE project_id=? AND "
                         "branch_id=?", (pid, branch)):
        try:
            res = json.loads(r["resource"]) if r["resource"] else {}
        except ValueError:
            res = {}
        prov[(r["record_id"], r["version"])] = (r["transform"], res)
    for a in store.query("SELECT operation_id, action, principal_id, outcome, recorded_at, output_refs FROM audit "
                         "WHERE project_id=? AND branch_id=? ORDER BY recorded_at", (pid, branch)):
        if a["action"] in ("READ",) or (a["action"] == "VALIDATE" and a["outcome"] == "SUCCESS"):
            continue
        try:
            outs = json.loads(a["output_refs"]) or []
        except ValueError:
            outs = []
        ref = outs[0] if outs else {}
        op = a["operation_id"]
        ent = {"at": a["recorded_at"], "kind": "step", "step": _step(contracts, op), "who": "you" if a["principal_id"]
               else "BookForge", "ai": None, "outcome": a["outcome"], "record_id": ref.get("record_id"),
               "version": ref.get("version"), "approval": None, "problem": None}
        name = _op_name(contracts, op) or op
        if a["action"] in ("CREATE", "UPDATE") and ref:
            transform, res = prov.get((ref.get("record_id"), ref.get("version")), (None, {}))
            if transform == "AI":
                ent["who"] = "AI"
                ent["ai"] = {"slot": res.get("ai_slot"), "model": res.get("model"), "adapter": res.get("adapter_id")}
                ent["what"] = f"{res.get('ai_slot') or 'AI'} wrote {name} ({ref.get('record_id')} v{ref.get('version')})"
            elif transform == "MANUAL":
                ent["what"] = f"You wrote {name} ({ref.get('record_id')} v{ref.get('version')})"
            else:
                ent["who"] = "BookForge"
                ent["what"] = f"BookForge {ACTION_WORDS.get(a['action'], a['action'].lower())} {name} " \
                              f"({ref.get('record_id')} v{ref.get('version')})"
            ent["kind"] = "ai" if transform == "AI" else "step"
        elif a["action"] == "ACCEPT":
            kind, p = approval_of.get(ref.get("record_id"), ("author", {}))
            ent["kind"] = "approval"
            ent["approval"] = kind
            ent["who"] = {"run_consent": "BookForge (your Make-a-book consent)",
                          "standing_auto_approve": "BookForge (your auto-approve setting)",
                          "workflow_test": "Workflow test runner"}.get(kind, "you")
            if kind == "run_consent":
                ent["run_id"] = p.get("run_id")
            ent["what"] = f"{name} ({ref.get('record_id')} v{ref.get('version')}) {APPROVAL_WORDS.get(kind, 'approved')}" \
                          + (f", run {p.get('run_id')}" if kind == "run_consent" and p.get("run_id") else "")
            if a["outcome"] != "SUCCESS":
                ent["what"] = f"Approval of {name} was refused ({a['outcome']})"
        else:
            ent["what"] = f"{name}: {a['action'].lower()} ({a['outcome']})"
        if a["outcome"] not in ("SUCCESS",):
            ent["problem"] = {"code": a["outcome"], "message": f"{a['action']} {a['outcome'].lower()}"}
        entries.append(ent)
    for e in events:
        et = e["event_type"]
        try:
            p = json.loads(e["payload"])
        except ValueError:
            p = {}
        ent = None
        if et == "review.ai_verdict":
            ent = {"kind": "ai_review", "step": _step(contracts, p.get("module_id")), "who": "AI",
                   "ai": {"slot": p.get("ai_slot")}, "what": f"AI review: {p.get('verdict')} "
                   f"({p.get('record_id')} v{p.get('version')})", "outcome": p.get("verdict")}
        elif et == "review.ai_fix":
            ent = {"kind": "ai_fix", "step": _step(contracts, p.get("module_id")), "who": "AI",
                   "ai": {"slot": p.get("ai_slot")}, "what": f"AI fix: new version {p.get('to_version')} of "
                   f"{p.get('record_id')} (it waits for approval)", "outcome": "SUCCESS"}
        elif et in ("review.auto_approve_failed", "autobook.approve_failed"):
            ent = {"kind": "problem", "step": _step(contracts, p.get("module_id")), "who": "BookForge",
                   "what": p.get("label") or "An automatic approval was refused", "outcome": "REJECTED",
                   "problem": {"code": "APPROVAL_REQUIRED", "message": "BookForge's checks refused the approval"}}
        elif et in ("review.auto_approve_on", "review.auto_approve_off"):
            ent = {"kind": "setting", "step": _step(contracts, None), "who": "you", "what": p.get("label") or et,
                   "outcome": "SUCCESS"}
        elif et == "project.created":
            ent = {"kind": "run", "step": _step(contracts, None), "who": "you",
                   "what": "The book was created", "outcome": "SUCCESS"}
        elif et == "file.imported":
            ent = {"kind": "import", "step": _step(contracts, "I01"), "who": "you",
                   "what": f"You uploaded a file ({p.get('mime_type')}, {p.get('byte_length')} bytes)",
                   "outcome": "SUCCESS"}
        elif et == "manifest.changed":
            ent = {"kind": "setting", "step": _step(contracts, None), "who": "you",
                   "what": "Book features changed", "outcome": "SUCCESS"}
        if ent:
            ent.setdefault("ai", None)
            ent.setdefault("problem", None)
            ent.setdefault("approval", None)
            ent["at"] = e["created_at"]
            entries.append(ent)
    for j in app.jobstore.list(project_id=pid, limit=100):
        if j.get("branch_id") not in (None, branch):
            continue
        label = {"autobook": "Make a book for me", "write_all": "Write all chapters", "assist": "Fill with AI",
                 "review_review": "AI review", "review_fix": "AI fix", "bible": "Bible Builder"}.get(j.get("kind"),
                                                                                                 j.get("kind"))
        if j.get("kind") in ("autobook", "write_all"):
            step_ops = {s["id"]: s.get("op") for s in j.get("steps") or []}
            for ev in j.get("events") or []:
                if ev.get("kind") in ("done",):
                    continue
                op = step_ops.get(ev.get("step")) or ev.get("module_id")
                kind = STEP_KIND.get(ev.get("kind"), "run")
                if ev.get("kind") == "approve":
                    continue  # the approval itself is listed from the audit log with its kind
                ent = {"at": _iso_fix(ev.get("at")), "kind": kind, "step": _step(contracts, op),
                       "who": "AI" if kind in ("ai", "ai_review", "ai_fix") else "BookForge",
                       "ai": {"slot": ev.get("slot")} if ev.get("slot") else None,
                       "what": f"{label}: {SAFE_TEXT.sub(' ', str(ev.get('message') or ''))[:300]}",
                       "outcome": ev.get("verdict") or ("PROBLEM" if kind == "problem" else None),
                       "approval": None, "run_id": j.get("id"),
                       "problem": {"code": ev.get("code"), "message": ev.get("message")}
                       if kind in ("problem",) or (kind == "retry" and ev.get("code")) else None}
                if ent["kind"] in ("ai", "ai_review", "ai_fix") and ev.get("kind") in ("review", "fix", "fix_done"):
                    continue  # the verdict/fix itself comes from the activity log
                if ent["kind"] == "ai" and ev.get("module_id"):
                    continue  # the record creation comes from the audit log with its AI slot
                entries.append(ent)
        elif j.get("status") in ("error", "interrupted"):
            err = j.get("error") or {}
            entries.append({"at": _iso_fix(j.get("updated_at")), "kind": "problem", "step": _step(contracts, j.get("op")),
                            "who": "BookForge", "ai": {"slot": j.get("slot")} if j.get("slot") else None,
                            "what": f"{label}: {j.get('status')}", "outcome": j.get("status"), "approval": None,
                            "problem": {"code": err.get("code") or j.get("status").upper(),
                                        "message": err.get("message") or j.get("phase")}})
    entries.sort(key=lambda x: x.get("at") or "")
    if step:
        s = step.upper()
        entries = [x for x in entries if (x["step"].get("op") or "") == s or (len(s) == 1 and x["step"].get("set") == s)]
    if problems_only:
        entries = [x for x in entries if x.get("problem") or x.get("kind") in ("problem", "retry", "pause")]
    proj = store.project(pid)
    from .book_path import get_profile  # noqa: PLC0415
    prof = get_profile(store, pid)
    counts = {}
    for x in entries:
        counts[x["kind"]] = counts.get(x["kind"], 0) + 1
    return {"project_id": pid, "branch_id": branch, "title": prof.get("title") or (proj["name"] if proj else pid),
            "entries": entries[-limit:], "count": len(entries), "counts": counts,
            "filters": {"step": step, "problems": problems_only}}


def _iso_fix(v):
    return v if isinstance(v, str) else None


ICON = {"ai": "🤖", "ai_review": "🧐", "ai_fix": "🛠", "approval": "✅", "problem": "⚠️", "retry": "⏳",
        "pause": "⏸", "resume": "▶", "backup": "💾", "export": "📦", "run": "⚡", "step": "•", "setting": "⚙",
        "import": "📥", "cancel": "✖", "note": "ℹ"}


def render_markdown(j: dict) -> str:
    out = [f"# 📜 Book journal — {j['title']}", "",
           f"- Book: {j['project_id']} (branch {j['branch_id']})", f"- Entries: {j['count']}"]
    if j["filters"].get("step") or j["filters"].get("problems"):
        out.append(f"- Filter: step {j['filters'].get('step') or 'all'}"
                   + (", problems only" if j["filters"].get("problems") else ""))
    out += ["- This journal never contains keys, prompts, AI replies or your book's text.", "",
            "| When (UTC) | What happened | Step | Who | Outcome |", "|---|---|---|---|---|"]
    for e in j["entries"]:
        st = e.get("step") or {}
        step = f"{st.get('op') or ''} {st.get('name') or ''}".strip() or "-"
        who = e.get("who") or "-"
        if e.get("ai") and e["ai"].get("slot"):
            who += f" ({e['ai']['slot']}{' · ' + e['ai']['model'] if e['ai'].get('model') else ''})"
        what = f"{ICON.get(e.get('kind'), '•')} {e.get('what') or ''}"
        if e.get("problem") and e["problem"].get("code"):
            what += f" — ⚠️ {e['problem']['code']}"
        out.append(f"| {(e.get('at') or '')[:19].replace('T', ' ')} | {_cell(what)} | {_cell(step)} | {_cell(who)} | "
                   f"{_cell(e.get('outcome') or '')} |")
    out.append("")
    return "\n".join(out)


def _cell(v) -> str:
    return str(v).replace("|", "\\|").replace("\n", " ")
