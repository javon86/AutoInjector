"""📜 Book journal (R11): a readable timeline of everything that happened to one book.

Built on demand (nothing new is stored) from the kernel's audit log (who ran which step and with what outcome),
the provenance of each new revision (which AI slot/model wrote it, or the author, or Akọwe itself), the outbox
activity events (AI review verdicts, AI fixes, approvals and their kind, auto-approve changes, imports) and the
events of background work for this book (Make-a-book runs and Write-all-chapters: retries, waits, pauses,
problems, backups, exports).

Entries: {at, kind, step: {set, op, name}, who, ai, what, outcome, approval, problem: {code, message}, run_id}.
They never contain API keys, connection keys, prompts, AI replies or book text: only step names, record IDs,
verdict words, error codes and Akọwe's own messages.

Order: entries happen-before each other in the order they were stored (SQLite rowid for the audit log and the
activity events, list order for a job's events), not in wall-clock text order: timestamps are normalised to
microseconds (a job event "…:05Z" sorts before a step at "…:05.3Z") and a stamp that goes BACKWARDS within one
source (the system clock was set back) is held at the previous one, so a later step is never listed first.

Filters: ``step`` (an operation ID like C02 or a set letter like C) and ``problems`` (only entries with a problem or
a failed outcome). ``render_markdown`` gives the downloadable .md version.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone

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
             "finished": "run", "ai": "ai", "done": "step", "project": "run", "note": "note", "failover": "note",
             "probe": "note", "editor": "editor", "rewrite": "editor", "scenes": "scenes", "characters": "characters"}
NOT_INDEPENDENT = "Reviews are not independent — the same AI wrote and reviewed this"
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
                         "ORDER BY rowid", (pid, branch))
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
    clock = _Monotonic()
    for a in store.query("SELECT operation_id, action, principal_id, outcome, recorded_at, output_refs FROM audit "
                         "WHERE project_id=? AND branch_id=? ORDER BY rowid", (pid, branch)):
        if a["action"] in ("READ",) or (a["action"] == "VALIDATE" and a["outcome"] == "SUCCESS"):
            continue
        try:
            outs = json.loads(a["output_refs"]) or []
        except ValueError:
            outs = []
        ref = outs[0] if outs else {}
        op = a["operation_id"]
        ent = {"at": a["recorded_at"], "kind": "step", "step": _step(contracts, op), "who": "you" if a["principal_id"]
               else "Akọwe", "ai": None, "outcome": a["outcome"], "record_id": ref.get("record_id"),
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
                ent["who"] = "Akọwe"
                ent["what"] = f"Akọwe {ACTION_WORDS.get(a['action'], a['action'].lower())} {name} " \
                              f"({ref.get('record_id')} v{ref.get('version')})"
            ent["kind"] = "ai" if transform == "AI" else "step"
        elif a["action"] == "ACCEPT":
            kind, p = approval_of.get(ref.get("record_id"), ("author", {}))
            ent["kind"] = "approval"
            ent["approval"] = kind
            ent["who"] = {"run_consent": "Akọwe (your Make-a-book consent)",
                          "standing_auto_approve": "Akọwe (your auto-approve setting)",
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
        ent["_key"] = clock(a["recorded_at"])
        entries.append(ent)
    clock = _Monotonic()
    review_counts = {"independent": 0, "same_ai": 0}
    for e in events:
        et = e["event_type"]
        try:
            p = json.loads(e["payload"])
        except ValueError:
            p = {}
        ent = None
        if et == "review.ai_verdict":
            same = p.get("independent") is False
            who_wrote = f"written by {p.get('writer_slot')}" if p.get("writer_slot") else None
            ent = {"kind": "ai_review", "step": _step(contracts, p.get("module_id")), "who": "AI",
                   "ai": {"slot": p.get("ai_slot"), "writer_slot": p.get("writer_slot")},
                   "what": f"AI review: {p.get('verdict')} ({p.get('record_id')} v{p.get('version')})"
                   + (f" · {who_wrote} · reviewed by {p.get('ai_slot')}" if who_wrote else "")
                   + (f" ⚠️ {NOT_INDEPENDENT}" if same else ""), "outcome": p.get("verdict"),
                   "warning": NOT_INDEPENDENT if same else None}
            if "independent" in p:
                review_counts["same_ai" if same else "independent"] += 1
        elif et == "editor.craft_review":
            sc = p.get("scores") or {}
            low = min(sc.items(), key=lambda kv: kv[1]) if sc else None
            same = p.get("independent") is False
            ent = {"kind": "editor", "step": _step(contracts, p.get("module_id")), "who": "AI",
                   "ai": {"slot": p.get("ai_slot"), "writer_slot": p.get("writer_slot")},
                   "what": f"Editor: {p.get('verdict')} ({p.get('record_id')} v{p.get('version')})"
                   + (f", round {p.get('round')}" if p.get("round") else "")
                   + f" · {p.get('major', 0)} major / {p.get('minor', 0)} minor note(s)"
                   + (f" · lowest score {low[0].replace('_', ' ')} {low[1]}" if low else "")
                   + (f" ⚠️ {NOT_INDEPENDENT}" if same else ""),
                   "outcome": p.get("verdict"), "scores": sc, "warning": NOT_INDEPENDENT if same else None}
        elif et == "editor.rewrite":
            ent = {"kind": "editor", "step": _step(contracts, p.get("module_id")), "who": "AI",
                   "ai": {"slot": p.get("ai_slot")},
                   "what": f"Editor's fixes applied: version {p.get('to_version')} of {p.get('record_id')} "
                   f"({p.get('applied', 0)} passage(s) rewritten, {p.get('unresolved', 0)} not)"
                   + (" by you" if p.get("how") == "author" else " inside the run"), "outcome": "SUCCESS"}
        elif et == "editor.rewrite_rejected":
            ent = {"kind": "editor", "step": _step(contracts, p.get("module_id")), "who": "Akọwe",
                   "what": f"The editor's rewrite (v{p.get('rejected_version')}) was not kept — version "
                   f"{p.get('restored_from')} is back as v{p.get('to_version')} ({p.get('why')})",
                   "outcome": "REJECTED", "problem": {"code": "EDITOR_REWRITE_REJECTED",
                                                      "message": "the rewrite was not better, so it was not kept"}}
        elif et == "characters.sheet_saved":
            ent = {"kind": "characters", "step": _step(contracts, "A01"), "who": "AI" if p.get("by") == "ai" else "you",
                   "ai": {"slot": p.get("ai_slot")} if p.get("ai_slot") else None,
                   "what": f"Character sheet and voice card of {p.get('record_id')}: version {p.get('version')} "
                   f"({p.get('sheet_fields', 0)} sheet field(s), {p.get('voice_fields', 0)} voice field(s), "
                   f"{p.get('relationships', 0)} relationship(s))", "outcome": "SUCCESS"}
        elif et == "scenes.saved":
            ent = {"kind": "scenes", "step": _step(contracts, "C02"), "who": "AI" if p.get("by") == "ai" else "you",
                   "ai": {"slot": p.get("ai_slot")} if p.get("ai_slot") else None,
                   "what": f"Scene cards of chapter {p.get('chapter_id')}: version {p.get('version')} "
                   f"({p.get('scenes', 0)} scene(s), {p.get('how') or 'made'})", "outcome": "SUCCESS"}
        elif et == "scenes.reviewed":
            same = p.get("independent") is False
            ent = {"kind": "ai_review", "step": _step(contracts, "C02"), "who": "AI",
                   "ai": {"slot": p.get("ai_slot"), "writer_slot": p.get("writer_slot")},
                   "what": f"Scene check of chapter {p.get('chapter_id')} v{p.get('version')}: {p.get('verdict')}"
                   + (f" ({p.get('failing')} scene(s) to rework)" if p.get("failing") else "")
                   + (f" ⚠️ {NOT_INDEPENDENT}" if same else ""), "outcome": p.get("verdict"),
                   "warning": NOT_INDEPENDENT if same else None}
        elif et == "scenes.approved":
            how = p.get("how") or "author"
            ent = {"kind": "approval", "step": _step(contracts, "C02"), "who": "you" if how == "author" else "Akọwe",
                   "what": f"Scene cards of chapter {p.get('chapter_id')} v{p.get('version')}: "
                   + (p.get("label") or "approved"), "outcome": "APPROVED", "approval": how,
                   "problem": {"code": "SCENES_NOTES", "message": "the scene checker still had notes"}
                   if p.get("flagged") else None}
        elif et == "rules.saved":
            ent = {"kind": "world", "step": _step(contracts, "A03"), "who": "AI" if p.get("by") == "ai" else "you",
                   "ai": {"slot": p.get("ai_slot")} if p.get("ai_slot") else None,
                   "what": f"Story rules: version {p.get('version')} ({p.get('rules', 0)} rule(s), {p.get('how') or 'made'})",
                   "outcome": "SUCCESS"}
        elif et == "rules.proposed":
            ent = {"kind": "world", "step": _step(contracts, "A03"), "who": "AI",
                   "ai": {"slot": p.get("ai_slot")} if p.get("ai_slot") else None,
                   "what": f"Story rules: the AI suggested {p.get('proposals', 0)} update(s) ({p.get('add', 0)} new, "
                   f"{p.get('change', 0)} changed, {p.get('retire', 0)} retired)", "outcome": "SUCCESS"}
        elif et == "rules.proposals_decided":
            how = p.get("how") or "author"
            ent = {"kind": "approval", "step": _step(contracts, "A03"), "who": "you" if how == "author" else "Akọwe",
                   "what": f"Story rules updates: {p.get('accepted', 0)} accepted, {p.get('rejected', 0)} rejected"
                   + (f" (under your Make-a-book-for-me consent, run {p.get('run_id')})" if p.get("run_id") else ""),
                   "outcome": "APPROVED", "approval": how}
        elif et == "texture.saved":
            ent = {"kind": "world", "step": _step(contracts, "A04"), "who": "AI" if p.get("by") == "ai" else "you",
                   "ai": {"slot": p.get("ai_slot")} if p.get("ai_slot") else None,
                   "what": f"World texture: version {p.get('version')} ({p.get('items', 0)} detail(s), "
                   f"{p.get('how') or 'made'})", "outcome": "SUCCESS"}
        elif et == "planned.checked":
            miss = int(p.get("missing") or 0) + int(p.get("unclear") or 0)
            same = p.get("independent") is False
            ent = {"kind": "planned", "step": _step(contracts, "C02"), "who": "AI" if p.get("ai_slot") else "Akọwe",
                   "ai": {"slot": p.get("ai_slot")} if p.get("ai_slot") else None,
                   "what": f"Planned to page, chapter {p.get('chapter_id')} v{p.get('version')}: {p.get('on_page', 0)} "
                   f"of {p.get('items', 0)} item(s) on the page" + (f", ⚠️ {miss} required missing" if miss else "")
                   + (f" ⚠️ {NOT_INDEPENDENT}" if same else ""), "outcome": "PROBLEM" if miss else "SUCCESS",
                   "problem": {"code": "PLANNED_MISSING", "message": "planned but not on the page"} if miss else None}
        elif et == "review.ai_fix":
            ent = {"kind": "ai_fix", "step": _step(contracts, p.get("module_id")), "who": "AI",
                   "ai": {"slot": p.get("ai_slot")}, "what": f"AI fix: new version {p.get('to_version')} of "
                   f"{p.get('record_id')} (it waits for approval)", "outcome": "SUCCESS"}
        elif et in ("review.auto_approve_failed", "autobook.approve_failed"):
            ent = {"kind": "problem", "step": _step(contracts, p.get("module_id")), "who": "Akọwe",
                   "what": p.get("label") or "An automatic approval was refused", "outcome": "REJECTED",
                   "problem": {"code": "APPROVAL_REQUIRED", "message": "Akọwe's checks refused the approval"}}
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
        elif et == "assistant.action":  # 🎩 Alfred (AutoInjector's assistant) did something for the author
            ent = {"kind": "assistant", "step": _step(contracts, None), "who": "Alfred (AutoInjector)",
                   "what": f"Alfred: {SAFE_TEXT.sub(' ', str(p.get('title') or p.get('code') or 'an action'))[:160]}",
                   "outcome": "SUCCESS", "code": p.get("code")}
        elif et == "manifest.changed":
            ent = {"kind": "setting", "step": _step(contracts, None), "who": "you",
                   "what": "Book features changed", "outcome": "SUCCESS"}
        if ent:
            ent.setdefault("ai", None)
            ent.setdefault("problem", None)
            ent.setdefault("approval", None)
            ent["at"] = e["created_at"]
            ent["_key"] = clock(e["created_at"])
            entries.append(ent)
        else:
            clock(e["created_at"])
    for j in app.jobstore.list(project_id=pid, limit=100):
        if j.get("branch_id") not in (None, branch):
            continue
        label = {"autobook": "Make a book for me", "write_all": "Write all chapters", "assist": "Fill with AI",
                 "review_review": "AI review", "review_fix": "AI fix", "bible": "Bible Builder"}.get(j.get("kind"),
                                                                                                 j.get("kind"))
        clock = _Monotonic()
        if j.get("kind") in ("autobook", "write_all"):
            step_ops = {s["id"]: s.get("op") for s in j.get("steps") or []}
            for ev in j.get("events") or []:
                key = clock(_iso_fix(ev.get("at")))
                if ev.get("kind") in ("done",):
                    continue
                op = step_ops.get(ev.get("step")) or ev.get("module_id")
                kind = STEP_KIND.get(ev.get("kind"), "run")
                if ev.get("kind") == "approve":
                    continue  # the approval itself is listed from the audit log with its kind
                ent = {"at": _iso_fix(ev.get("at")), "kind": kind, "step": _step(contracts, op),
                       "who": "AI" if kind in ("ai", "ai_review", "ai_fix") else "Akọwe",
                       "ai": {"slot": ev.get("slot")} if ev.get("slot") else None,
                       "what": f"{label}: {SAFE_TEXT.sub(' ', str(ev.get('message') or ''))[:300]}",
                       "outcome": ev.get("verdict") or ("PROBLEM" if kind == "problem" else None),
                       "approval": None, "run_id": j.get("id"),
                       "problem": {"code": ev.get("code"), "message": ev.get("message")}
                       if kind in ("problem",) or (kind == "retry" and ev.get("code"))
                       or ev.get("code") in ("EDITOR_NOTES", "EDITOR_REWRITE_REJECTED") else None}
                if ent["kind"] in ("ai", "ai_review", "ai_fix", "editor") and ev.get("kind") in (
                        "review", "fix", "fix_done", "editor", "rewrite"):
                    continue  # the verdict/fix/editor review itself comes from the activity log
                if ent["kind"] == "ai" and ev.get("module_id"):
                    continue  # the record creation comes from the audit log with its AI slot
                ent["_key"] = key
                entries.append(ent)
        elif j.get("status") in ("error", "interrupted"):
            err = j.get("error") or {}
            entries.append({"at": _iso_fix(j.get("updated_at")), "kind": "problem", "step": _step(contracts, j.get("op")),
                            "who": "Akọwe", "ai": {"slot": j.get("slot")} if j.get("slot") else None,
                            "what": f"{label}: {j.get('status')}", "outcome": j.get("status"), "approval": None,
                            "problem": {"code": err.get("code") or j.get("status").upper(),
                                        "message": err.get("message") or j.get("phase")},
                            "_key": clock(_iso_fix(j.get("updated_at")))})
    entries.sort(key=lambda x: x["_key"])  # stable: equal keys keep their stored order
    for x in entries:
        del x["_key"]
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
            "reviews": dict(review_counts, warning=NOT_INDEPENDENT if review_counts["same_ai"] else None),
            "filters": {"step": step, "problems": problems_only}}


def _iso_fix(v):
    return v if isinstance(v, str) else None


def _norm(v) -> str:
    """A stamp as fixed-width UTC text with microseconds ('…:05Z' -> '…:05.000000Z'); '' when unknown."""
    if not isinstance(v, str) or not v:
        return ""
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            t = datetime.strptime(v, fmt)
        except ValueError:
            continue
        if t.tzinfo is not None:
            t = t.astimezone(timezone.utc).replace(tzinfo=None)
        return t.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    return v


class _Monotonic:
    """Sort keys for one source in stored order: a stamp earlier than the previous one is held at the previous."""

    def __init__(self):
        self.last = ""

    def __call__(self, v) -> str:
        n = _norm(v)
        if n and n > self.last:
            self.last = n
        return self.last


ICON = {"ai": "🤖", "ai_review": "🧐", "ai_fix": "🛠", "approval": "✅", "problem": "⚠️", "retry": "⏳",
        "pause": "⏸", "resume": "▶", "backup": "💾", "export": "📦", "run": "⚡", "step": "•", "setting": "⚙",
        "import": "📥", "cancel": "✖", "note": "ℹ", "editor": "🖋", "assistant": "🎩"}


def render_markdown(j: dict) -> str:
    out = [f"# 📜 Book journal — {j['title']}", "",
           f"- Book: {j['project_id']} (branch {j['branch_id']})", f"- Entries: {j['count']}"]
    if j["filters"].get("step") or j["filters"].get("problems"):
        out.append(f"- Filter: step {j['filters'].get('step') or 'all'}"
                   + (", problems only" if j["filters"].get("problems") else ""))
    rv = j.get("reviews") or {}
    if rv.get("independent") or rv.get("same_ai"):
        out.append(f"- AI reviews: {rv.get('independent', 0)} by a different AI than the writer, "
                   f"{rv.get('same_ai', 0)} by the same AI" + (f" — ⚠️ {rv['warning']}" if rv.get("warning") else ""))
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


NOTE_SOURCES = ("alfred",)
NOTE_CODE = re.compile(r"[a-z][a-z0-9_]{0,39}")


def add_note(store, pid: str, branch: str, body) -> dict:
    """🎩 An assistant (AutoInjector's Alfred) records an action it did for this book. Codes and titles only —
    never prompts, AI replies or book text: ``{"source": "alfred", "code": "edit_profile", "title": "Edit book
    profile"}``. Additive: it only adds an ``assistant.action`` activity event, shown in the journal."""
    from .errors import AkoweError  # noqa: PLC0415
    b = body if isinstance(body, dict) else {}
    if b.get("source") not in NOTE_SOURCES:
        raise AkoweError("INVALID_INPUT", "/source", "source: alfred", status="REJECTED")
    code = b.get("code")
    if not isinstance(code, str) or not NOTE_CODE.fullmatch(code):
        raise AkoweError("INVALID_INPUT", "/code", "code: the tool name (lower-case letters, digits, _)", status="REJECTED")
    title = b.get("title")
    if not isinstance(title, str) or not title.strip() or len(title) > 160:
        raise AkoweError("INVALID_INPUT", "/title", "title: up to 160 characters", status="REJECTED")
    with store.transaction() as tx:
        event_id = tx.insert_outbox(pid, branch, "assistant.action",
                                    {"source": b["source"], "code": code, "title": SAFE_TEXT.sub(" ", title.strip())})
    return {"ok": True, "event_id": event_id}
