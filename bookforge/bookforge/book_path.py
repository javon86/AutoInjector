"""Book profile and the guided "Make my book" path (GET/POST .../book, GET/PUT .../profile).

The book profile (title, author, genre, audience, length, tone, idea, preferred AI) is author data that
no operation schema owns as a whole, so it is kept as a project setting (store settings key
``book_profile:<project_id>``); the parts the contracts do need (B01 idea/goals, publication metadata
for G12/G13 and the output profiles) are derived from it when those records are created.

The book path walks the first usable vertical slice of the build plan in order: canon (A01) ->
premise (B01) -> main plot (B03) -> chapter outline (B11) -> chapters (C01 context + C02 prose per
outline chapter) -> book format (I01 profiles) -> assembly (G02/G01/G05/G04/G07) -> exports
(G11 PDF / G12 EPUB / G13 DOCX for the selected release profiles) -> a content check (H05).

Every step goes through ``engine.dispatch`` exactly like the workspace forms. Rules kept here:
* Creative steps (B01/B03/B11/C02) are CREATE requests without a manual candidate, so the engine uses a
  connected AI slot; with no AI the answer is a prefilled form for the author to write it themselves.
* Nothing is approved without ``author_confirms: true`` from the author's own click. When ACCEPT needs an
  explicit approval, a K09 checkpoint for that exact candidate is recorded on the author's confirmation
  (the same real K09 path the self-test uses) - never silently.
* Deterministic steps (C01, I01 format profiles, assembly, exports, H05) only run when the author presses
  the step's button, and their outputs are drafts until the author approves them.
Step state is recomputed from stored records on every call; refs this path created are remembered in
the settings key ``book_path:<project_id>:<branch_id>`` only to find them again.
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timedelta, timezone

from .errors import BookforgeError
from .requests import build_request, candidate_payload

PROFILE_FIELDS = {"title": 200, "author": 200, "genre": 120, "audience": 120, "length": 20, "tone": 200,
                  "idea": 4000, "ai_slot": 20, "chapters": 3}
LENGTHS = {"short_story": ("Short story", 1, 3), "novella": ("Novella", 6, 10), "novel": ("Novel", 20, 30)}
AI_SLOT_CHOICES = ("", "AI-1", "AI-2", "AI-3", "manual")
FORMAT_KEYS = ("font_file", "font", "page", "pdf_profile", "epub_profile", "docx_profile", "metadata", "toc_style")
ASSEMBLY = ("G02", "G01", "G05", "G04", "G07")
# Rough word targets for the profile length (used for the progress bar only).
WORD_TARGETS = {"short_story": 5000, "novella": 25000, "novel": 80000}
EXPORT_FOR = {"MANUSCRIPT_PDF": ("G11", "PDF", "application/pdf"),
              "EPUB_REFLOWABLE": ("G12", "EPUB", "application/epub+zip"),
              "EDITABLE_DOCX": ("G13", "DOCX",
                                "application/vnd.openxmlformats-officedocument.wordprocessingml.document")}


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _err(code, path, message):
    return BookforgeError(code, path, message, status="REJECTED")


# ---------------------------------------------------------------------------------- profile
def clean_profile(body) -> dict:
    if not isinstance(body, dict):
        raise _err("INVALID_INPUT", "", "the book profile must be a JSON object")
    out = {}
    for k, v in body.items():
        if k not in PROFILE_FIELDS:
            continue  # unknown fields are ignored, not stored
        if k == "chapters":
            if v in (None, ""):
                continue
            if not isinstance(v, int) or isinstance(v, bool) or not 1 <= v <= 60:
                raise _err("INVALID_INPUT", "/chapters", "number of chapters: a whole number from 1 to 60")
            out[k] = v
            continue
        if v is None:
            continue
        if not isinstance(v, str):
            raise _err("INVALID_INPUT", f"/{k}", f"{k} must be text")
        v = v.strip()
        if len(v) > PROFILE_FIELDS[k]:
            raise _err("INVALID_INPUT", f"/{k}", f"{k} is limited to {PROFILE_FIELDS[k]} characters")
        if k == "length" and v and v not in LENGTHS:
            raise _err("INVALID_INPUT", "/length", "length: short_story, novella or novel")
        if k == "ai_slot" and v not in AI_SLOT_CHOICES:
            raise _err("INVALID_INPUT", "/ai_slot", "AI choice: empty (automatic), AI-1, AI-2, AI-3 or manual")
        out[k] = v
    return out


def get_profile(store, pid: str) -> dict:
    prof = store.get_setting(f"book_profile:{pid}")
    if prof is None:
        p = store.project(pid)
        import json  # noqa: PLC0415
        settings = json.loads(p["settings"]) if p and p["settings"] else {}
        prof = settings.get("book_profile") if isinstance(settings, dict) else None
    return prof if isinstance(prof, dict) else {}


def save_profile(store, pid: str, body) -> dict:
    prof = dict(get_profile(store, pid), **clean_profile(body))
    prof["updated_at"] = _now()
    store.set_setting(f"book_profile:{pid}", prof)
    return prof


def chapter_target(prof: dict) -> int:
    if isinstance(prof.get("chapters"), int):
        return prof["chapters"]
    return LENGTHS.get(prof.get("length") or "", (None, 3, 3))[1] or 3


# ---------------------------------------------------------------------------------- path
class BookPath:
    def __init__(self, engine, principal: str, pid: str, branch: str):
        self.engine, self.store, self.principal = engine, engine.store, principal
        self.pid, self.branch = pid, branch
        self.c = engine.contracts
        self.key = f"book_path:{pid}:{branch}"
        self.mem = self.store.get_setting(self.key) or {}
        self.profile = get_profile(self.store, pid)
        self._recs = None

    # ----------------------------------------------------------------- storage helpers
    def save(self):
        self.store.set_setting(self.key, self.mem)

    def records(self):
        if self._recs is None:
            self._recs = self.store.list_records(self.pid, self.branch)
        return self._recs

    def heads(self, op):
        return [r for r in self.records() if r["module_id"] == op]

    def rec(self, rid, version=None):
        if version is None:
            hist = self.store.history(self.pid, self.branch, rid)
            return hist[-1] if hist else None
        return self.store.get_record(self.pid, self.branch, rid, version)

    def approved(self, op):
        """Approved revisions (refs) of an operation, newest record first."""
        out = []
        for r in sorted(self.heads(op), key=lambda x: x.get("created_at") or "", reverse=True):
            if r.get("approved_version") and not r.get("stale"):
                a = self.rec(r["record_id"], r["approved_version"])
                if a and a["lifecycle"] in ("APPROVED", "LOCKED"):
                    out.append(a)
        return out

    def drafts(self, op):
        return [r for r in self.heads(op) if r["lifecycle"] in ("DRAFT", "VALIDATED") and not r.get("approved_version")]

    def ref_ok(self, ref, approved=True):
        if not ref:
            return None
        r = self.rec(ref["record_id"], ref["version"])
        if not r or r.get("stale"):
            return None
        if approved and r["lifecycle"] not in ("APPROVED", "LOCKED"):
            return None
        return r

    # ----------------------------------------------------------------- dispatch helpers (as the forms do)
    def dispatch(self, op, action, *, manual_candidate=None, **kw):
        o = self.c.operation(op)
        kw.setdefault("timeout_ms", (o or {}).get("timeout_ms") or 180000)
        req = build_request(project_id=self.pid, branch_id=self.branch, op_id=op, action=action,
                            principal_id=self.principal, **kw)
        resp = self.engine.dispatch(req, self.principal, manual_candidate=manual_candidate)
        self._recs = None
        return resp

    def create(self, op, payload, **kw):
        r = self.dispatch(op, "CREATE", payload=payload, **kw)
        if r["status"] != "DRAFT" or not r.get("output_refs"):
            raise StepError(op, r)
        return r["output_refs"][0], r

    def k09_for(self, subjects):
        payload = {"action_id": "author-approves-exact-candidates",
                   "impact": {"action_hash": hashlib.sha256(repr(subjects).encode()).hexdigest()[:16],
                              "source_versions": list(subjects), "protected": True},
                   "policy": {"policy_id": "author", "authorized_roles": ["author"], "ttl_seconds": 3600},
                   "base_revision": 1}
        ref, r = self.create("K09", payload)
        expiry = (datetime.now(timezone.utc) + timedelta(minutes=60)).strftime("%Y-%m-%dT%H:%M:%SZ")
        u = self.dispatch("K09", "UPDATE", base_ref=ref, payload=dict(r["result"], decision="APPROVED", expiry=expiry))
        if u["status"] != "DRAFT":
            raise StepError("K09", u)
        return u["output_refs"][0]

    def approve_ref(self, ref) -> dict:
        """VALIDATE then ACCEPT one exact revision; a K09 for exactly it when ACCEPT asks for one."""
        v = self.dispatch(ref["module_id"], "VALIDATE", base_ref=ref, payload=candidate_payload(ref, None))
        if v["status"] not in ("VALIDATED", "APPROVED"):
            return {"record_id": ref["record_id"], "ok": False, "status": v["status"], "problems": problems(v)}
        a = self.dispatch(ref["module_id"], "ACCEPT", base_ref=ref, payload=candidate_payload(ref, None))
        if a["status"] != "APPROVED" and any(e.get("code") == "APPROVAL_REQUIRED" for e in a.get("errors") or []):
            k09 = self.k09_for([ref])
            a = self.dispatch(ref["module_id"], "ACCEPT", base_ref=ref, payload=candidate_payload(ref, k09))
        ok = a["status"] == "APPROVED"
        return {"record_id": ref["record_id"], "module_id": ref["module_id"], "ok": ok, "status": a["status"],
                "problems": [] if ok else problems(a), "ref": (a.get("output_refs") or [ref])[0]}

    def import_profile(self, kind, data, label):
        payload = {"owner_operation": "I01", "source_ref": None, "approval_ref": None, "fact_type": "AUXILIARY",
                   "fact_payload": {"summary": f"{label}", "facts": [], "links": []}, "requested_state": "DRAFT",
                   "auxiliary_record": {"record_kind": kind, "data": data},
                   "import_evidence": {"source_label": f"book-{kind.lower()}.json",
                                       "source_sha256": hashlib.sha256(repr(data).encode()).hexdigest(),
                                       "principal_id": self.principal, "imported_at": _now()}}
        ref, _ = self.create("I01", payload)
        return ref

    # ----------------------------------------------------------------- facts about the book
    def ai_ready(self) -> bool:
        if (self.profile.get("ai_slot") or "") == "manual":
            return False
        for s in self.engine.providers.slots():
            if s.get("adapter_id") in ("anthropic", "autoinjector") and s.get("has_credentials"):
                return True
        return False

    def metadata(self) -> dict:
        if not self.mem.get("identifier"):
            self.mem["identifier"] = f"urn:uuid:{uuid.uuid4()}"
            self.save()
        title = self.profile.get("title") or (self.store.project(self.pid) or {})["name"]
        author = self.profile.get("author") or "Unknown author"
        return {"title": title, "author": author, "identifier": self.mem["identifier"],
                "rights": f"Copyright {datetime.now().year} {author}. All rights reserved."}

    def outline(self):
        a = self.approved("B11")
        return a[0] if a else None

    def outline_chapters(self, outline) -> list[dict]:
        out = []
        for i, item in enumerate((outline or {}).get("data", {}).get("chapters") or []):
            facts = {f.get("predicate"): f.get("value") for f in item.get("facts") or [] if isinstance(f, dict)}
            cid = facts.get("plan.item_id") or (item.get("facts") or [{}])[0].get("subject_id") or f"ch{i + 1}"
            out.append({"chapter_id": str(cid), "order": facts.get("plan.order", i),
                        "objective": facts.get("plan.objective") or item.get("summary") or "",
                        "summary": item.get("summary") or ""})
        return sorted(out, key=lambda x: (x["order"] if isinstance(x["order"], int) else 0, x["chapter_id"]))

    def chapter_prose(self, outline, chapter_id):
        """(context C01 head, newest C02 record built on it, approved C02 revision or None)."""
        ctx_id = (self.mem.get("contexts") or {}).get(f"{outline['record_id']}:{chapter_id}")
        if not ctx_id:
            return None, None, None
        ctx = self.rec(ctx_id)
        rows = self.store.query("SELECT DISTINCT consumer_record_id FROM dependency_edges WHERE project_id=? AND "
                                "branch_id=? AND producer_record_id=? AND consumer_operation='C02'",
                                (self.pid, self.branch, ctx_id))
        prose = [self.rec(r["consumer_record_id"]) for r in rows]
        prose = [p for p in prose if p]
        prose.sort(key=lambda p: p.get("created_at") or "", reverse=True)
        appr = None
        for p in prose:
            head = next((h for h in self.heads("C02") if h["record_id"] == p["record_id"]), None)
            if head and head.get("approved_version") and not head.get("stale"):
                appr = self.rec(p["record_id"], head["approved_version"])
                break
        return ctx, (prose[0] if prose else None), appr

    # ----------------------------------------------------------------- status
    def status(self) -> dict:
        steps = []
        ai = self.ai_ready()
        prof = self.profile

        def step(sid, title, about, state, **kw):
            steps.append(dict({"id": sid, "title": title, "about": about, "state": state, "approve": [],
                               "action": None, "op": None}, **kw))

        def item(r):
            return {"record_id": r["record_id"], "version": r["version"], "module_id": r["module_id"],
                    "title": _title(r), "lifecycle": r["lifecycle"]}

        step("profile", "Book profile", "Title, author, genre, length and your idea in a few words.",
             "done" if prof.get("title") else "needs_you", action="edit_profile")
        # canon
        a01 = self.approved("A01")
        d01 = self.drafts("A01") + self.drafts("A04") + self.drafts("A03")  # what the wizard drafts
        step("canon", "Characters and places", "At least one approved main character (Set A); approve the places "
             "and world you want to use too. More canon can come any time.",
             "done" if a01 else ("needs_you" if d01 else ("ai_can" if ai else "needs_you")),
             op="A01", action="make" if ai else "new", approve=[item(r) for r in d01][:12],
             count=len(a01))
        # planning
        prev_ok = True
        for sid, op, title, about, need in (
                ("premise", "B01", "Premise", "What the book is about in one or two sentences, from your idea.", None),
                ("plot", "B03", "Main plot", "The main storyline, built from the premise and your characters.", "B01"),
                ("outline", "B11", "Chapter outline", "The chapter-by-chapter plan the writing follows.", "B03")):
            appr = self.approved(op)
            drafts = self.drafts(op)
            blocked = need is not None and not self.approved(need)
            state = ("done" if appr else "needs_you" if drafts else "blocked" if blocked
                     else "ai_can" if ai else "needs_you")
            step(sid, title, about, state, op=op, action=None if state in ("done", "blocked") else "create",
                 approve=[item(r) for r in drafts][:6], waiting_for=need if blocked else None)
            prev_ok = prev_ok and bool(appr)
        # chapters
        outline = self.outline()
        chapters = []
        if outline:
            for ch in self.outline_chapters(outline):
                ctx, latest, appr = self.chapter_prose(outline, ch["chapter_id"])
                st = ("done" if appr else "needs_you" if latest and latest["lifecycle"] in ("DRAFT", "VALIDATED")
                      else "ai_can" if ai else "needs_you")
                chapters.append(dict(ch, state=st, context_id=ctx["record_id"] if ctx else None,
                                     prose=item(latest) if latest else None,
                                     approved=item(appr) if appr else None))
        all_written = bool(chapters) and all(c["state"] == "done" for c in chapters)
        step("chapters", "Write the chapters",
             "Each outline chapter gets its context (automatic) and its prose (your AI, or you write it). "
             "Read each chapter and approve it.",
             "blocked" if not outline else "done" if all_written else
             ("needs_you" if any(c["state"] == "needs_you" for c in chapters) else "ai_can"),
             chapters=chapters, waiting_for="B11" if not outline else None, action="write_chapter",
             approve=[c["prose"] for c in chapters if c["state"] == "needs_you" and c["prose"]])
        # format
        fmt = self.mem.get("format") or {}
        fmt_recs = {k: self.ref_ok(fmt.get(k), approved=False) for k in FORMAT_KEYS}
        fmt_have = all(fmt_recs.values())
        fmt_done = fmt_have and all(self.ref_ok(fmt.get(k)) for k in FORMAT_KEYS)
        step("format", "Book format", "Page size, font, contents style and the PDF/EPUB/DOCX settings, made from "
             "your book profile (automatic).",
             "done" if fmt_done else "needs_you" if fmt_have else ("ready" if prof.get("title") else "blocked"),
             action=None if fmt_done else "setup_format" if not fmt_have else None,
             waiting_for=None if prof.get("title") else "profile",
             approve=[item(r) for r in fmt_recs.values() if r and r["lifecycle"] in ("DRAFT", "VALIDATED")])
        # assembly
        asm = self.mem.get("assembly") or {}
        asm_recs = {op: self.ref_ok(asm.get(op), approved=False) for op in ASSEMBLY}
        asm_have = all(asm_recs.values()) and asm.get("chapters") == [c["approved"]["record_id"] + ":" + str(
            c["approved"]["version"]) for c in chapters if c.get("approved")]
        asm_done = asm_have and all(self.ref_ok(asm.get(op)) for op in ASSEMBLY)
        ready_asm = all_written and fmt_done
        step("assemble", "Put the book together", "Chapter order, one manuscript, typography, page layout and table "
             "of contents (automatic), for you to approve.",
             "done" if asm_done else "needs_you" if asm_have else "ready" if ready_asm else "blocked",
             action="assemble" if ready_asm and not asm_have else None,
             waiting_for=None if ready_asm else ("chapters" if not all_written else "format"),
             approve=[item(r) for r in asm_recs.values() if asm_have and r and r["lifecycle"] in ("DRAFT", "VALIDATED")])
        # exports
        exports = self.mem.get("exports") or {}
        wanted = self.release_profiles()
        files = []
        for prof_type in wanted:
            op, fmt_name, mime = EXPORT_FOR[prof_type]
            e = exports.get(prof_type)
            rec = self.ref_ok(e.get("descriptor"), approved=False) if e else None
            g07_id = asm["G07"]["record_id"] if isinstance(asm.get("G07"), dict) else None
            if rec and g07_id and e.get("assembly") == g07_id:
                art = rec["data"].get("artifact_ref")
                files.append({"format": fmt_name, "profile": prof_type, "op": op, "mime_type": mime,
                              "record_id": art["record_id"] if art else None,
                              "version": art["version"] if art else None,
                              "descriptor_id": rec["record_id"], "sha256": rec["data"].get("sha256")})
        exp_done = asm_done and len(files) == len(wanted) and bool(wanted)
        step("export", "Export my book", "Makes the " + ", ".join(EXPORT_FOR[p][1] for p in wanted) +
             " file(s) from the approved book. Pressing it confirms your approved chapters as the source.",
             "done" if exp_done else "ready" if asm_done else "blocked",
             action="export" if asm_done and not exp_done else None,
             waiting_for=None if asm_done else "assemble", files=files)
        # check
        h05 = (self.mem.get("check") or {}).get("H05")
        h05_rec = self.ref_ok(h05, approved=False) if h05 and (self.mem.get("check") or {}).get("assembly") == \
            (asm.get("G01") or {}).get("record_id") else None
        step("check", "Check the book", "A deterministic check that every chapter is present once and in order "
             "(H05). Full release readiness (H10) is in the Quality Checks set.",
             "done" if h05_rec else "ready" if asm_done else "blocked",
             action="check" if asm_done and not h05_rec else None, waiting_for=None if asm_done else "assemble",
             result=(h05_rec["data"].get("status") if h05_rec else None))
        nxt = next((s for s in steps if s["state"] != "done"), None)
        try:
            words = self.word_stats(chapters)
        except Exception:  # noqa: BLE001 - a progress number must never break the checklist
            words = None
        return {"project_id": self.pid, "branch_id": self.branch, "ai_ready": ai, "profile": prof,
                "steps": steps, "next": nxt["id"] if nxt else None, "words": words,
                "done_count": sum(1 for s in steps if s["state"] == "done"), "total": len(steps)}

    def release_profiles(self):
        m = self.store.feature_manifest(self.pid, self.branch) or {}
        return [p for p in (m.get("release_profiles") or ["MANUSCRIPT_PDF"]) if p in EXPORT_FOR] or ["MANUSCRIPT_PDF"]

    # ----------------------------------------------------------------- actions
    def act(self, action: str, body: dict) -> dict:
        fn = {"create": self.a_create, "write_chapter": self.a_write_chapter, "approve": self.a_approve,
              "setup_format": self.a_setup_format, "assemble": self.a_assemble, "export": self.a_export,
              "check": self.a_check}.get(action)
        if fn is None:
            raise _err("NOT_FOUND", "/action", "unknown step action")
        try:
            out = fn(body if isinstance(body, dict) else {})
        except StepError as exc:
            out = {"ok": False, "message": exc.message, "problems": exc.problems, "code": exc.code}
        out["book"] = BookPath(self.engine, self.principal, self.pid, self.branch).status()
        return out

    def _manual(self, op, payload, why):
        return {"ok": False, "needs_manual": True, "op": op, "payload": payload, "message": why}

    def _ai_or_manual(self, op, payload, what, manual=False):
        if manual:
            return self._manual(op, payload, f"The {what} form is ready: write it under “Manual candidate” and "
                                "press Create.")
        if not self.ai_ready():
            return self._manual(op, payload, f"No AI is connected (or you chose to write it yourself), so the {what} "
                                "form is filled in for you: write the text under “Manual candidate” and press Create. "
                                "To let an AI write it, open Settings and connect AutoInjector or add an API key.")
        r = self.dispatch(op, "CREATE", payload=payload)
        if r["status"] == "DRAFT" and r.get("output_refs"):
            return {"ok": True, "message": f"Your AI wrote the {what}. Read it, then approve it.",
                    "created": r["output_refs"][0]}
        codes = {e.get("code") for e in r.get("errors") or []}
        if codes & {"CAPABILITY_UNAVAILABLE", "UPSTREAM_UNAVAILABLE", "TIMEOUT", "RATE_LIMITED"}:
            m = self._manual(op, payload, f"The AI could not write the {what} ({', '.join(sorted(codes))}). "
                             "Check the AI in Settings (Test connection) and try again, or write it yourself in the "
                             "form that opens now.")
            m["problems"] = problems(r)
            return m
        raise StepError(op, r)

    def payload_for(self, op: str) -> dict:
        """The CREATE payload of a planning step (B01/B03/B11), built from the profile and approved records."""
        prof = self.profile
        if op == "B01":
            idea = (prof.get("idea") or "").strip() or prof.get("title") or ""
            if not idea:
                raise StepError.msg("Write your book idea in the book profile first.")
            goals = [g for g in (f"a {LENGTHS.get(prof.get('length') or '', ('book',))[0].lower()}",
                                 f"genre: {prof['genre']}" if prof.get("genre") else None,
                                 f"for {prof['audience']}" if prof.get("audience") else None,
                                 f"tone: {prof['tone']}" if prof.get("tone") else None) if g]
            canon = [r["ref"] for r in (self.approved("A01") + self.approved("A04") + self.approved("A03"))[:20]]
            return {"idea": idea, "goals": goals, "canon_refs": canon}
        if op == "B03":
            b01 = self.approved("B01")
            if not b01:
                raise StepError.msg("Approve a premise first.")
            canon = [r["ref"] for r in (self.approved("A01") + self.approved("A04") + self.approved("A03"))[:20]]
            return {"premise_ref": b01[0]["ref"], "canon_refs": canon, "constraints": []}
        if op == "B11":
            b03 = self.approved("B03")
            if not b03:
                raise StepError.msg("Approve the main plot first.")
            payload = {"main_plot_ref": b03[0]["ref"], "selected_plan_refs": []}
            props = self.c.definition("B11", "CREATE")["properties"]["payload"].get("properties", {})
            if "target_length" in props:
                payload["target_length"] = {"unit": "chapters", "value": chapter_target(prof)}
                errs = [e for e in self.c.check("B11", "CREATE", self._req_for("B11", payload))
                        if e["path"].startswith("/payload/target_length")]
                if errs:
                    payload.pop("target_length")
            return payload
        raise _err("INVALID_INPUT", "/op", "this step creates B01, B03 or B11")

    def a_create(self, body):
        op = body.get("op")
        if op not in ("B01", "B03", "B11"):
            raise _err("INVALID_INPUT", "/op", "this step creates B01, B03 or B11")
        what = {"B01": "premise", "B03": "main plot", "B11": "chapter outline"}[op]
        return self._ai_or_manual(op, self.payload_for(op), what, manual=body.get("manual") is True)

    def _req_for(self, op, payload):
        return build_request(project_id=self.pid, branch_id=self.branch, op_id=op, action="CREATE",
                             principal_id=self.principal, payload=payload)

    def prepare_chapter(self, cid) -> dict:
        """C02 CREATE payload for one outline chapter; makes its C01 context first when needed."""
        outline = self.outline()
        if not outline:
            raise StepError.msg("Approve the chapter outline first.")
        chapters = {c["chapter_id"]: c for c in self.outline_chapters(outline)}
        if cid not in chapters:
            raise _err("INVALID_INPUT", "/chapter_id", "that chapter is not in the approved outline")
        ctx, latest, appr = self.chapter_prose(outline, cid)
        if appr:
            raise StepError.msg("This chapter is already approved.")
        if not ctx or ctx.get("stale"):
            ref, _ = self.create("C01", {"chapter_id": cid, "outline_ref": outline["ref"],
                                         "instruction": f"context for chapter {cid}"})
            self.mem.setdefault("contexts", {})[f"{outline['record_id']}:{cid}"] = ref["record_id"]
            self.save()
            ctx = self.rec(ref["record_id"])
        prof = self.profile
        instruction = (f"Write chapter {cid}: {chapters[cid]['objective']}".strip()
                       + (f". Tone: {prof['tone']}" if prof.get("tone") else "")
                       + (f". Audience: {prof['audience']}" if prof.get("audience") else ""))[:2000]
        return {"chapter_id": cid, "outline_ref": outline["ref"], "context_ref": ctx["ref"], "instruction": instruction}

    def a_write_chapter(self, body):
        cid = body.get("chapter_id")
        payload = self.prepare_chapter(cid)
        out = self._ai_or_manual("C02", payload, f"chapter “{cid}”", manual=body.get("manual") is True)
        if out.get("needs_manual"):
            out["manual_on"] = True
        return out

    # ----------------------------------------------------------------- word count (S5)
    def word_stats(self, chapters: list | None = None) -> dict:
        """Words per chapter (newest draft and approved text) and in total, with a target from the profile length."""
        if chapters is None:
            outline = self.outline()
            chapters = []
            if outline:
                for ch in self.outline_chapters(outline):
                    _ctx, latest, appr = self.chapter_prose(outline, ch["chapter_id"])
                    chapters.append({"chapter_id": ch["chapter_id"],
                                     "prose": {"record_id": latest["record_id"], "version": latest["version"]}
                                     if latest else None,
                                     "approved": {"record_id": appr["record_id"], "version": appr["version"]}
                                     if appr else None})
        rows, draft_total, approved_total = [], 0, 0
        for c in chapters:
            d = a = 0
            if c.get("prose"):
                r = self.rec(c["prose"]["record_id"], c["prose"]["version"])
                d = count_words((r or {}).get("data", {}).get("text") if r else "")
            if c.get("approved"):
                r = self.rec(c["approved"]["record_id"], c["approved"]["version"])
                a = count_words((r or {}).get("data", {}).get("text") if r else "")
            rows.append({"chapter_id": c["chapter_id"], "draft_words": d, "approved_words": a})
            draft_total += d
            approved_total += a
        target = WORD_TARGETS.get(self.profile.get("length") or "", WORD_TARGETS["short_story"])
        best = sum(max(r["draft_words"], r["approved_words"]) for r in rows)
        return {"chapters": rows, "draft_words": draft_total, "approved_words": approved_total, "words": best,
                "target_words": target, "percent": min(100, int(round(100 * best / target))) if target else 0}

    def a_approve(self, body):
        if body.get("author_confirms") is not True:
            raise _err("APPROVAL_REQUIRED", "/author_confirms",
                       "approving needs your explicit confirmation (author_confirms: true)")
        ids = body.get("record_ids")
        if not isinstance(ids, list) or not ids or not all(isinstance(x, str) for x in ids) or len(ids) > 40:
            raise _err("INVALID_INPUT", "/record_ids", "list the records to approve (1-40)")
        results = []
        for rid in dict.fromkeys(ids):
            r = self.rec(rid)
            if r is None:
                results.append({"record_id": rid, "ok": False, "problems": ["record not found"]})
                continue
            if r["lifecycle"] in ("APPROVED", "LOCKED"):
                results.append({"record_id": rid, "ok": True, "status": r["lifecycle"], "problems": []})
                continue
            try:
                results.append(self.approve_ref(r["ref"]))
            except StepError as exc:
                results.append({"record_id": rid, "ok": False, "problems": exc.problems or [exc.message]})
        ok = all(x["ok"] for x in results)
        n = sum(1 for x in results if x["ok"])
        return {"ok": ok, "results": results,
                "message": f"Approved {n} of {len(results)}." + ("" if ok else " Some need fixing — see below.")}

    def a_setup_format(self, body):
        if not self.profile.get("title"):
            raise StepError.msg("Fill in the book profile (at least the title) first.")
        md = self.metadata()
        fmt = {}
        fmt["font_file"] = self.import_profile("ASSET_MANIFEST", {"assets": [], "placement_ids": ["font:times-roman"]},
                                               "Font file list")
        fmt["font"] = self.import_profile("FONT_PROFILE", {"font_refs": [fmt["font_file"]], "embedding_permitted": True,
                                                           "fallback_names": ["Times-Roman"], "font_size_pt": 11,
                                                           "line_height_pt": 14, "language_tag": "en"}, "Font")
        fmt["page"] = self.import_profile("PAGE_PROFILE", {"width_mm": 152.4, "height_mm": 228.6, "bleed_mm": 0,
                                                           "safe_margin_mm": 15}, "Page size 6 x 9 in")
        fmt["pdf_profile"] = self.import_profile("OUTPUT_PROFILE", {
            "profile_id": "manuscript-pdf", "profile_type": "MANUSCRIPT_PDF",
            "required_checks": ["H05", "H09"], "required_export_operations": ["G11"],
            "artwork_selected": False, "language_tag": "en", "metadata": dict(md), "printer_profile_ref": None,
            "page_profile_ref": fmt["page"], "font_profile_ref": fmt["font"]}, "PDF settings")
        for ptype, key, page in (("EPUB_REFLOWABLE", "epub_profile", None), ("EDITABLE_DOCX", "docx_profile", fmt["page"])):
            fmt[key] = self.import_profile("OUTPUT_PROFILE", {
                "profile_id": ptype.lower(), "profile_type": ptype, "required_checks": ["H09"],
                "required_export_operations": [], "artwork_selected": False, "language_tag": "en",
                "metadata": dict(md), "printer_profile_ref": None, "page_profile_ref": page,
                "font_profile_ref": fmt["font"]}, f"{ptype.split('_')[0]} settings")
        fmt["metadata"] = self.import_profile("PUBLICATION_METADATA", dict(md), "Title and author")
        fmt["toc_style"] = self.import_profile("TOC_STYLE", {"max_depth": 1, "include_pages": True,
                                                             "link_targets": True}, "Contents style")
        self.mem["format"] = fmt
        self.save()
        return {"ok": True, "message": "Book format settings made from your profile (6 x 9 inch pages, Times 11 pt). "
                "Approve them to continue."}

    def a_assemble(self, body):
        st = self.status()
        steps = {s["id"]: s for s in st["steps"]}
        if steps["chapters"]["state"] != "done" or steps["format"]["state"] != "done":
            raise StepError.msg("Approve every chapter and the book format first.")
        chapters = [c["approved"] for c in steps["chapters"]["chapters"]]
        refs = [self.rec(c["record_id"], c["version"])["ref"] for c in chapters]
        fmt = self.mem["format"]
        m = self.store.feature_manifest(self.pid, self.branch) or {"revision": 1}
        asm = {}
        asm["G02"], _ = self.create("G02", {"approved_chapter_refs": refs, "ordered_chapter_ids":
                                            [r["record_id"] for r in refs], "manifest_revision": m["revision"]})
        asm["G01"], _ = self.create("G01", {"ordered_manifest_ref": asm["G02"], "approved_chapter_refs": refs,
                                            "section_id_policy": "STABLE_ID"})
        asm["G05"], _ = self.create("G05", {"font_profile_ref": self._appr(fmt["font"]), "language_tag": "en",
                                            "manuscript_ref": asm["G01"]})
        asm["G04"], _ = self.create("G04", {"manuscript_ref": asm["G01"], "page_profile_ref": self._appr(fmt["page"]),
                                            "typography_ref": asm["G05"],
                                            "margins_pt": {"top": 54, "bottom": 54, "left": 54, "right": 54}})
        asm["G07"], _ = self.create("G07", {"paginated_book_ref": asm["G04"],
                                            "toc_style_ref": self._appr(fmt["toc_style"]), "max_passes": 6})
        asm["chapters"] = [f"{c['record_id']}:{c['version']}" for c in chapters]
        self.mem["assembly"] = asm
        self.mem.pop("exports", None)
        self.save()
        return {"ok": True, "message": f"The book is put together from {len(refs)} approved chapter(s). Approve the "
                "assembly to export it."}

    def _appr(self, ref):
        """The approved revision of a record this path created (approval keeps the same version)."""
        r = self.rec(ref["record_id"], ref["version"])
        return r["ref"] if r else ref

    def a_export(self, body):
        st = {s["id"]: s for s in self.status()["steps"]}
        if st["assemble"]["state"] != "done":
            raise StepError.msg("Put the book together and approve it first.")
        asm, fmt = self.mem["assembly"], self.mem["format"]
        chapters = []
        for x in asm["chapters"]:
            rid, ver = x.rsplit(":", 1)
            chapters.append(self.rec(rid, int(ver))["ref"])
        g07 = self._appr(asm["G07"])
        made, problems_ = {}, []
        for prof_type in self.release_profiles():
            op, name, _ = EXPORT_FOR[prof_type]
            try:
                if op == "G11":
                    src = self.import_profile("SOURCE_APPROVAL_MANIFEST", {
                        "source_refs": chapters, "approval_refs": chapters,
                        "policy_ref": self._appr(fmt["pdf_profile"])}, "Approved chapters for this export")
                    res = self.approve_ref(src)
                    if not res["ok"]:
                        raise StepError.msg("The list of approved chapters could not be confirmed: "
                                            + "; ".join(res["problems"])[:300])
                    ref, _ = self.create("G11", {"final_book_ref": g07, "pdf_profile_ref": self._appr(fmt["pdf_profile"]),
                                                 "approval_manifest_ref": res["ref"]})
                elif op == "G12":
                    ref, _ = self.create("G12", {"final_book_ref": g07, "epub_profile_ref": self._appr(fmt["epub_profile"]),
                                                 "metadata_ref": self._appr(fmt["metadata"])})
                else:
                    ref, _ = self.create("G13", {"final_book_ref": g07, "docx_profile_ref": self._appr(fmt["docx_profile"]),
                                                 "metadata_ref": self._appr(fmt["metadata"])})
                made[prof_type] = {"descriptor": ref, "assembly": asm["G07"]["record_id"]}
            except StepError as exc:
                problems_.append(f"{name}: {exc.message}")
        self.mem["exports"] = dict(self.mem.get("exports") or {}, **made)
        self.save()
        if problems_:
            return {"ok": bool(made), "message": "Some files could not be made.", "problems": problems_}
        return {"ok": True, "message": f"Your book is ready: {', '.join(EXPORT_FOR[p][1] for p in made)}. "
                "Use the download buttons."}

    def a_check(self, body):
        asm = self.mem.get("assembly") or {}
        st = {s["id"]: s for s in self.status()["steps"]}
        if st["assemble"]["state"] != "done":
            raise StepError.msg("Put the book together and approve it first.")
        ref, r = self.create("H05", {"manuscript_ref": self._appr(asm["G01"]), "chapter_manifest_ref": self._appr(asm["G02"])})
        self.mem["check"] = {"H05": ref, "assembly": asm["G01"]["record_id"]}
        self.save()
        res = (r.get("result") or {}).get("status")
        return {"ok": res == "PASS", "message": f"Content check: {res}.", "problems": [] if res == "PASS" else
                [f.get("message") for f in (r.get("result") or {}).get("findings") or [] if f.get("decision") == "FAIL"][:8]}


class StepError(Exception):
    def __init__(self, op, resp=None, message=None):
        self.code = None
        if resp is not None:
            errs = resp.get("errors") or []
            self.code = errs[0].get("code") if errs else resp.get("status")
            self.problems = problems(resp)
            self.message = message or f"{op} could not be created ({resp.get('status')})."
        else:
            self.problems = []
            self.message = message or str(op)
        super().__init__(self.message)

    @classmethod
    def msg(cls, text):
        return cls(text, None, text)


def count_words(text) -> int:
    return len(text.split()) if isinstance(text, str) else 0


def problems(resp: dict) -> list[str]:
    out = [f"{e.get('code')}: {e.get('message')}" + (f" (at {e['path']})" if e.get("path") else "")
           for e in resp.get("errors") or []]
    out += [f"{f.get('rule_id')}: {f.get('message')}" for f in resp.get("findings") or []
            if f.get("severity") == "BLOCKING" and f.get("decision") != "PASS"]
    return out[:12]


def _title(r: dict) -> str:
    d = r.get("data") or {}
    if isinstance(d, dict):
        for k in ("concept", "premise", "title", "chapter_id", "kind"):
            if isinstance(d.get(k), str) and d[k]:
                return d[k][:120]
        if isinstance(d.get("text"), str):
            return d["text"][:80]
        if isinstance(d.get("main_plot"), dict) and isinstance(d["main_plot"].get("summary"), str):
            return d["main_plot"]["summary"][:120]
    return r["record_id"]
