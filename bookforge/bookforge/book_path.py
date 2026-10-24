"""Book profile and the guided "Make my book" path (GET/POST .../book, GET/PUT .../profile).

The book profile (title, author, genre, audience, length, tone, idea, preferred AI) is author data that
no operation schema owns as a whole, so it is kept as a project setting (store settings key
``book_profile:<project_id>``); the parts the contracts do need (B01 idea/goals, publication metadata
for G12/G13 and the output profiles) are derived from it when those records are created.

The book path walks the first usable vertical slice of the build plan in order: canon (A01) ->
premise (B01) -> main plot (B03) -> chapter outline (B11) -> chapters (C01 context + C02 prose per
outline chapter) -> book format (I01 profiles) -> assembly (G02/G01/G05, G06 chapter headings + G08 title
page compiled in, G04/G07) -> exports
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
import json
import threading
import uuid
from datetime import datetime, timedelta, timezone

from .errors import BookforgeError
from .requests import build_request, candidate_payload

PROFILE_FIELDS = {"title": 200, "author": 200, "genre": 120, "audience": 120, "length": 20, "tone": 200,
                  "idea": 4000, "ai_slot": 20, "chapters": 3}
LENGTHS = {"short_story": ("Short story", 1, 3), "novella": ("Novella", 6, 10), "novel": ("Novel", 20, 30)}
AI_SLOT_CHOICES = ("", "AI-1", "AI-2", "AI-3", "manual")
FORMAT_KEYS = ("font_file", "font", "page", "pdf_profile", "epub_profile", "docx_profile", "metadata", "toc_style")
# Assembly records the author approves, in dependency order: chapter order (G02), chapter title rules (G06) and
# the title page (G08) compiled into the manuscript (G01), its typography (G05), page layout (G04) and contents
# (G07). G06/G08 are built on a plain first compile (kept as working drafts "G01_plain"/"G05_plain").
ASSEMBLY = ("G02", "G06", "G08", "G01", "G05", "G04", "G07")
# Chapter headings: "Chapter 3: <title>", the title being the "# Title" line the chapter prose starts with
# (the C02 prose task asks for it); a chapter without one is headed "Chapter 3".
CHAPTER_TITLE_RULES = {"pattern": "Chapter {number}: {title}", "include_number": True}
# Rough word targets for the profile length (the progress bar, and the "much shorter than planned" warning).
WORD_TARGETS = {"short_story": 5000, "novella": 25000, "novel": 80000}
# A written book with fewer words than this share of its target is flagged as far below its length.
SHORT_SHARE = 0.25
# Profile fields that must not be blank once given (the wizard insists on a title; so does the profile dialog).
REQUIRED_PROFILE = ("title",)
# Steps whose AI work must not run twice at once for the same book (pressing a button twice, two tabs).
_STEP_LOCKS: dict[str, threading.Lock] = {}
_STEP_LOCKS_GUARD = threading.Lock()


def _step_lock(key: str) -> threading.Lock:
    with _STEP_LOCKS_GUARD:
        return _STEP_LOCKS.setdefault(key, threading.Lock())
# How the author gets a refused AI draft redone from the book page (the step action and its body).
REDO_FOR = {"B01": {"action": "create", "op": "B01"}, "B03": {"action": "create", "op": "B03"},
            "B11": {"action": "create", "op": "B11"}, "C02": {"action": "write_chapter"}}
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
        if k in REQUIRED_PROFILE and not v:
            raise _err("MISSING_INPUT", f"/{k}", f"the book needs a {k}: it cannot be empty or only spaces")
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
        settings = json.loads(p["settings"]) if p and p["settings"] else {}
        prof = settings.get("book_profile") if isinstance(settings, dict) else None
    return prof if isinstance(prof, dict) else {}


def save_profile(store, pid: str, body) -> dict:
    """Save the book profile (merged into the stored one). A new title also renames the book everywhere it is
    listed (Your books, the book picker, the breadcrumb), in the same transaction: never one without the other."""
    clean = clean_profile(body)
    with store.transaction() as tx:  # read-merge-write in one transaction: two saves at once keep both changes
        old = get_profile(store, pid)
        prof = dict(old, **clean)
        prof["updated_at"] = _now()
        store.set_setting(f"book_profile:{pid}", prof)
        if clean.get("title") and old.get("title") and clean["title"] != old["title"]:
            tx.execute("UPDATE projects SET name=? WHERE project_id=?", (clean["title"], pid))
    return prof


def chapter_target(prof: dict) -> int:
    if isinstance(prof.get("chapters"), int):
        return prof["chapters"]
    return LENGTHS.get(prof.get("length") or "", (None, 3, 3))[1] or 3


# ---------------------------------------------------------------------------------- path
def pinned_engine(engine, slot: str | None):
    """The engine that sends every AI step of a book to the AI chosen for it (profile ``ai_slot`` AI-1/AI-2/AI-3).

    "Automatic" (empty) keeps the shared engine: each AI step goes to the slot whose Settings roles name that step
    (an operation such as C02, or its set letter such as C); with no role match, to the cheapest connected slot,
    then the least busy one, then AI-1 before AI-2 before AI-3. So parallel work (Write all chapters, reviews, a
    second book) spreads to another slot while one is busy, and roles let the author send e.g. chapters to one AI
    and planning to another. "manual" means no AI at all (handled by ai_ready)."""
    from .engine import Engine  # noqa: PLC0415 - engine imports this module's helpers indirectly
    from .providers import PinnedProviders  # noqa: PLC0415
    if slot not in ("AI-1", "AI-2", "AI-3"):
        return engine
    cur = engine.providers
    if getattr(cur, "pinned", None) == slot:
        return engine
    return Engine(engine.store, engine.contracts, providers=PinnedProviders(cur, slot))


class BookPath:
    def __init__(self, engine, principal: str, pid: str, branch: str):
        self.store, self.principal = engine.store, principal
        self.pid, self.branch = pid, branch
        self.c = engine.contracts
        self.key = f"book_path:{pid}:{branch}"
        self.mem = self.store.get_setting(self.key) or {}
        self.profile = get_profile(self.store, pid)
        # The AI the author chose for this book (wizard / book profile) writes every AI step of it.
        self.ai_slot = self.profile.get("ai_slot") or ""
        self.engine = pinned_engine(engine, self.ai_slot)
        self._recs = None

    # ----------------------------------------------------------------- storage helpers
    def remember(self, change):
        """Change this book's path memory atomically: re-read the stored memory inside one write transaction, apply
        change(mem) to it and write it back. Two book actions at the same time (two tabs, Write-all + a manual
        step) therefore each keep their own result instead of the last writer replacing the whole memory."""
        with self.store.transaction() as tx:
            row = tx.conn.execute("SELECT value FROM settings WHERE key=?", (self.key,)).fetchone()
            mem = json.loads(row["value"]) if row else {}
            mem = mem if isinstance(mem, dict) else {}
            change(mem)
            self.store.set_setting(self.key, mem)
        self.mem = mem
        return mem

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
        """Unapproved drafts waiting for the author (drafts set aside or out of date are not waiting)."""
        return [r for r in self.heads(op) if r["lifecycle"] in ("DRAFT", "VALIDATED") and not r.get("approved_version")
                and not r.get("stale")]

    def set_aside(self, rec, reason: str):
        """Take an unapproved draft out of the approval queue (marked out of date, kept in its history), e.g. an AI
        draft BookForge's checks refused and the AI is asked to redo."""
        with self.store.transaction() as tx:
            tx.mark_stale(self.pid, self.branch, rec["record_id"], rec["version"], reason[:300])
            tx.insert_outbox(self.pid, self.branch, "book_path.draft_set_aside",
                             {"record_id": rec["record_id"], "version": rec["version"],
                              "module_id": rec["module_id"], "reason": reason[:300]})
        self._recs = None

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
        if self.ai_slot == "manual":
            return False
        for s in self.engine.providers.slots():
            if self.ai_slot and s["slot_id"] != self.ai_slot:
                continue  # the book is pinned to one AI: only that one counts
            if s.get("adapter_id") in ("anthropic", "autoinjector") and s.get("has_credentials"):
                return True
        return False

    def no_ai_reason(self) -> str:
        if self.ai_slot == "manual":
            return "the book profile says you write it yourself"
        if self.ai_slot:
            return (f"the AI chosen for this book ({self.ai_slot}) is not set up: set it up in Settings, or choose "
                    "another AI (or Automatic) in the book profile")
        return "no AI is connected"

    def title_author(self) -> tuple[str, str]:
        title = self.profile.get("title") or (self.store.project(self.pid) or {"name": "Untitled book"})["name"]
        return title, self.profile.get("author") or "Unknown author"

    def metadata(self) -> dict:
        if not self.mem.get("identifier"):
            self.remember(lambda m: m.setdefault("identifier", f"urn:uuid:{uuid.uuid4()}"))
        title, author = self.title_author()
        return {"title": title, "author": author, "identifier": self.mem["identifier"],
                "rights": f"Copyright {datetime.now().year} {author}. All rights reserved."}

    @staticmethod
    def format_title_author(meta_rec) -> tuple | None:
        """(title, author) carried by the book format's PUBLICATION_METADATA record, or None when unknown."""
        data = (meta_rec or {}).get("data") or {}
        aux = data.get("auxiliary_record") if isinstance(data.get("auxiliary_record"), dict) else None
        md = (aux or {}).get("data") if aux else data
        if not isinstance(md, dict) or "title" not in md:
            return None
        return md.get("title"), md.get("author")

    def format_out_of_date(self, fmt_recs: dict) -> bool:
        """True when the title/author in the book format (and so in the files) differ from the book profile."""
        ta = self.format_title_author(fmt_recs.get("metadata"))
        return ta is not None and ta != self.title_author()

    def assembly_out_of_date(self, asm: dict, fmt_recs: dict) -> str | None:
        """Why an existing assembly no longer matches the book (plain words), or None. The title page (G08) and the
        chapter headings (G06) are made when the book is put together, so a book put together before BookForge added
        them, or before the book format changed (a new title or author), must be put together again."""
        if not asm.get("G01"):
            return None
        if not asm.get("G06") or not asm.get("G08"):
            return ("BookForge now adds a title page and chapter headings: put the book together again "
                    "(nothing you wrote changes).")
        made_with = asm.get("title_page")
        cur = self.format_title_author(fmt_recs.get("metadata"))
        if asm.get("format_changed") or (made_with and cur and tuple(made_with) != tuple(cur)):
            return ("The book format changed since the book was put together (for example a new title or author): "
                    "put it together again so the title page shows it.")
        return None

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

        def item(r, chapter_id=None):
            out = {"record_id": r["record_id"], "version": r["version"], "module_id": r["module_id"],
                   "title": _title(r), "lifecycle": r["lifecycle"]}
            # What BookForge's checks found blocking when this draft was last checked: the page offers to redo or
            # edit it instead of only "approve" (which would be refused again).
            blocking = [f"{f.get('rule_id')}: {f.get('message')}" for f in r.get("findings") or []
                        if f.get("severity") == "BLOCKING" and f.get("decision") in ("FAIL", "UNKNOWN")]
            if blocking and r["lifecycle"] in ("DRAFT", "VALIDATED"):
                redo = REDO_FOR.get(r["module_id"])
                if redo and r["module_id"] == "C02":
                    redo = dict(redo, chapter_id=chapter_id) if chapter_id else None
                out.update(problems=blocking[:6], redo=redo, fix=refusal_advice(blocking, redo))
            return out

        step("profile", "Book profile", "Title, author, genre, length and your idea in a few words.",
             "done" if prof.get("title") else "needs_you", action="edit_profile")
        # canon
        a01 = self.approved("A01")
        d01 = self.drafts("A01") + self.drafts("A04") + self.drafts("A03")  # what the wizard drafts
        try:  # P7/P17: how many characters have a sheet and a voice card the writer can use
            from . import characters as chars_mod  # noqa: PLC0415
            ents = chars_mod.all_entries(self.store, self.pid, self.branch)
            sheets = {"complete": sum(1 for r in a01 if chars_mod.complete(ents.get(r["record_id"]))),
                      "total": len(a01)}
        except Exception:  # noqa: BLE001 - a count must never break the checklist
            sheets = None
        step("canon", "Characters and places", "At least one approved main character (Set A); approve the places "
             "and world you want to use too. More canon can come any time.",
             "done" if a01 else ("needs_you" if d01 else ("ai_can" if ai else "needs_you")),
             op="A01", action="make" if ai else "new", approve=[item(r) for r in d01][:12],
             count=len(a01), sheets=sheets)
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
        try:  # P8: the scene cards of each chapter (numbers only)
            from . import scenes as scenes_mod  # noqa: PLC0415
            scene_entries = scenes_mod.all_entries(self.store, self.pid, self.branch) if outline else {}
        except Exception:  # noqa: BLE001 - never break the checklist
            scenes_mod, scene_entries = None, {}
        if outline:
            for ch in self.outline_chapters(outline):
                ctx, latest, appr = self.chapter_prose(outline, ch["chapter_id"])
                if latest and latest.get("stale") and not appr:
                    latest = None  # set aside (e.g. redone): not waiting for the author
                # A newer revision of an approved chapter (the author edited it, or asked for changes) waits for
                # approval: the chapter is not done until it is approved, and the book made from the older text
                # becomes out of date once it is (the assembly pins the approved chapter versions).
                revision = bool(appr and latest and latest["lifecycle"] in ("DRAFT", "VALIDATED")
                                and not latest.get("stale")
                                and (latest["record_id"], latest["version"]) != (appr["record_id"], appr["version"]))
                st = ("needs_you" if revision else "done" if appr else
                      "needs_you" if latest and latest["lifecycle"] in ("DRAFT", "VALIDATED")
                      else "ai_can" if ai else "needs_you")
                sc = scenes_mod.summary(scene_entries.get(scenes_mod.ekey(outline["record_id"], ch["chapter_id"])),
                                        outline) if scenes_mod else None
                chapters.append(dict(ch, state=st, context_id=ctx["record_id"] if ctx else None,
                                     prose=item(latest, ch["chapter_id"]) if latest else None,
                                     approved=item(appr) if appr else None, revision_waiting=revision, scenes=sc))
        all_written = bool(chapters) and all(c["state"] == "done" for c in chapters)
        # The book is put together from APPROVED chapter texts only: a waiting revision of an approved chapter keeps
        # the chapters step open (Approve) without stopping the author from re-assembling the approved book.
        all_approved = bool(chapters) and all(c.get("approved") for c in chapters)
        revised = [c["chapter_id"] for c in chapters if c.get("revision_waiting")]
        step("chapters", "Write the chapters",
             "Each outline chapter gets its context (automatic) and its prose (your AI, or you write it). "
             "Read each chapter and approve it." +
             (f" Your changes to chapter(s) {', '.join(revised)} wait for your approval: the book you can download "
              "still has the earlier text until you approve them and put the book together again." if revised else ""),
             "blocked" if not outline else "done" if all_written else
             ("needs_you" if any(c["state"] == "needs_you" for c in chapters) else "ai_can"),
             chapters=chapters, waiting_for="B11" if not outline else None, action="write_chapter",
             approve=[c["prose"] for c in chapters if c["state"] == "needs_you" and c["prose"]])
        # format
        fmt = self.mem.get("format") or {}
        fmt_recs = {k: self.ref_ok(fmt.get(k), approved=False) for k in FORMAT_KEYS}
        fmt_have = all(fmt_recs.values())
        fmt_old = fmt_have and self.format_out_of_date(fmt_recs)
        fmt_have = fmt_have and not fmt_old
        fmt_done = fmt_have and all(self.ref_ok(fmt.get(k)) for k in FORMAT_KEYS)
        step("format", "Book format", "Page size, font, contents style and the PDF/EPUB/DOCX settings, made from "
             "your book profile (automatic)." + (" The title or author changed in the book profile since the format "
                                                 "was made: make it again so the files carry the new ones."
                                                 if fmt_old else ""),
             "done" if fmt_done else "needs_you" if fmt_have else ("ready" if prof.get("title") else "blocked"),
             action=None if fmt_done else "setup_format" if not fmt_have else None,
             waiting_for=None if prof.get("title") else "profile", out_of_date=fmt_old,
             approve=[item(r) for r in fmt_recs.values() if fmt_have and r and r["lifecycle"] in ("DRAFT", "VALIDATED")])
        # assembly
        asm = self.mem.get("assembly") or {}
        asm_recs = {op: self.ref_ok(asm.get(op), approved=False) for op in ASSEMBLY}
        asm_why = self.assembly_out_of_date(asm, fmt_recs)
        asm_have = all(asm_recs.values()) and asm.get("chapters") == [c["approved"]["record_id"] + ":" + str(
            c["approved"]["version"]) for c in chapters if c.get("approved")] and not asm_why
        asm_done = asm_have and all(self.ref_ok(asm.get(op)) for op in ASSEMBLY)
        ready_asm = all_approved and fmt_done
        if not asm_why and asm.get("G01") and not asm_have:
            asm_why = ("An approved chapter (or something else the book is made from) changed since the book was put "
                       "together: put it together again so the files carry the new text.")
        step("assemble", "Put the book together", "Chapter order, one manuscript, typography, page layout and table "
             "of contents (automatic), for you to approve." + (f" {asm_why}" if asm_why else ""),
             "done" if asm_done else "needs_you" if asm_have else "ready" if ready_asm else "blocked",
             action="assemble" if ready_asm and not asm_have else None,
             waiting_for=None if ready_asm else ("chapters" if not all_approved else "format"),
             out_of_date=bool(asm_why), reason=asm_why or None,
             approve=[item(r) for r in asm_recs.values() if asm_have and r and r["lifecycle"] in ("DRAFT", "VALIDATED")])
        # exports
        exports = self.mem.get("exports") or {}
        wanted = self.release_profiles()
        files = []
        meta_id = (fmt.get("metadata") or {}).get("record_id") if fmt_done else None
        cur_title, cur_author = self.title_author()
        for prof_type in wanted:
            op, fmt_name, mime = EXPORT_FOR[prof_type]
            e = exports.get(prof_type)
            rec = self.ref_ok(e.get("descriptor"), approved=False) if e else None
            g07_id = asm["G07"]["record_id"] if isinstance(asm.get("G07"), dict) else None
            if rec and g07_id and e.get("assembly") == g07_id:
                art = rec["data"].get("artifact_ref")
                # A file made before the title/author changed is still offered (it is what exists), marked out of
                # date and named after the title it carries, and the export step asks to make it again.
                old = (not meta_id or not asm_done
                       or (e.get("title", cur_title), e.get("author", cur_author)) != (cur_title, cur_author))
                files.append({"format": fmt_name, "profile": prof_type, "op": op, "mime_type": mime,
                              "record_id": art["record_id"] if art else None,
                              "version": art["version"] if art else None,
                              "descriptor_id": rec["record_id"], "sha256": rec["data"].get("sha256"),
                              "title": e.get("title"), "author": e.get("author"), "out_of_date": bool(old)})
        current = [f for f in files if not f["out_of_date"]]
        exp_done = asm_done and fmt_done and len(current) == len(wanted) and bool(wanted)
        exp_ready = asm_done and fmt_done
        step("export", "Export my book", "Makes the " + ", ".join(EXPORT_FOR[p][1] for p in wanted) +
             " file(s) from the approved book. Pressing it confirms your approved chapters as the source." +
             (" The files below were made from an earlier version of the book (" +
              ("put the book together again, then export again" if not asm_done else "an older title or author: "
               "export again") + ")." if files and not exp_done and len(current) < len(files) else ""),
             "done" if exp_done else "ready" if exp_ready else "blocked",
             action="export" if exp_ready and not exp_done else None,
             waiting_for=None if exp_ready else ("assemble" if not asm_done else "format"), files=files)
        # check
        h05 = (self.mem.get("check") or {}).get("H05")
        h05_rec = self.ref_ok(h05, approved=False) if h05 and (self.mem.get("check") or {}).get("assembly") == \
            (asm.get("G01") or {}).get("record_id") else None
        step("check", "Check the book", "A deterministic check that every chapter is present once and in order "
             "(H05). Full release readiness (H10) is in the Quality Checks set.",
             "done" if h05_rec and asm_done else "ready" if asm_done else "blocked",
             action="check" if asm_done and not h05_rec else None, waiting_for=None if asm_done else "assemble",
             result=(h05_rec["data"].get("status") if h05_rec and asm_done else None))
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
            return self._manual(op, payload, f"No AI can write it ({self.no_ai_reason()}), so the {what} "
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
        manual, redo = body.get("manual") is True, body.get("redo") is True
        with _step_lock(f"{self.key}:{op}"):  # a second press waits for the first, then finds its draft
            self._recs = None
            if self.approved(op):
                raise StepError.msg(f"The {what} is already approved. To change it, open it and edit it.")
            drafts = sorted(self.drafts(op), key=lambda r: r.get("created_at") or "", reverse=True)
            if drafts and redo and not manual:
                for d in drafts:
                    self.set_aside(d, f"replaced: the author asked the AI to write the {what} again")
            elif drafts and not manual:
                return {"ok": True, "existing": True, "created": drafts[0]["ref"],
                        "message": f"The {what} is already written and waits for you: read it and approve it (or "
                                   "press 🔁 Redo with AI for a new one)."}
            return self._ai_or_manual(op, self.payload_for(op), what, manual=manual)

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
            key = f"{outline['record_id']}:{cid}"
            self.remember(lambda m: m.setdefault("contexts", {}).__setitem__(key, ref["record_id"]))
            ctx = self.rec(ref["record_id"])
        prof = self.profile
        instruction = (f"Write chapter {cid}: {chapters[cid]['objective']}".strip()
                       + (f". Tone: {prof['tone']}" if prof.get("tone") else "")
                       + (f". Audience: {prof['audience']}" if prof.get("audience") else ""))[:2000]
        return {"chapter_id": cid, "outline_ref": outline["ref"], "context_ref": ctx["ref"], "instruction": instruction}

    def a_write_chapter(self, body):
        cid = body.get("chapter_id")
        manual, redo = body.get("manual") is True, body.get("redo") is True
        with _step_lock(f"{self.key}:C02:{cid}"):
            outline = self.outline()
            if outline and isinstance(cid, str) and not manual:
                _ctx, latest, appr = self.chapter_prose(outline, cid)
                if not appr and latest and latest["lifecycle"] in ("DRAFT", "VALIDATED") and not latest.get("stale"):
                    if not redo:
                        return {"ok": True, "existing": True, "created": latest["ref"],
                                "message": f"Chapter “{cid}” is already written and waits for you: read it and "
                                           "approve it (or press 🔁 Redo with AI for a new one)."}
                    self.set_aside(latest, f"replaced: the author asked the AI to write chapter {cid} again")
            payload = self.prepare_chapter(cid)
            out = self._ai_or_manual("C02", payload, f"chapter “{cid}”", manual=manual)
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
            prose, appr = c.get("prose"), c.get("approved")
            # The newest prose of an approved chapter usually IS the approved text: it is not also "in drafts".
            same = bool(prose and appr and prose["record_id"] == appr["record_id"]
                        and prose["version"] == appr["version"])
            if prose and not same:
                r = self.rec(prose["record_id"], prose["version"])
                if r and r["lifecycle"] in ("DRAFT", "VALIDATED") and not r.get("stale"):
                    d = count_words((r.get("data") or {}).get("text"))
            if appr:
                r = self.rec(appr["record_id"], appr["version"])
                a = count_words((r or {}).get("data", {}).get("text") if r else "")
            rows.append({"chapter_id": c["chapter_id"], "draft_words": d, "approved_words": a})
            draft_total += d
            approved_total += a
        length = self.profile.get("length") or ""
        target = WORD_TARGETS.get(length, WORD_TARGETS["short_story"])
        best = sum(max(r["draft_words"], r["approved_words"]) for r in rows)
        written = bool(rows) and all(r["approved_words"] or r["draft_words"] for r in rows)
        short = bool(target and written and best < target * SHORT_SHARE)
        warning = None
        if short:
            what = LENGTHS.get(length, ("book",))[0].lower()
            warning = (f"This book is much shorter than planned: {best:,} words, where a {what} is about "
                       f"{target:,} words. Ask the AI to write longer chapters, or change the length in the book "
                       "profile.")
        return {"chapters": rows, "draft_words": draft_total, "approved_words": approved_total, "words": best,
                "target_words": target, "percent": min(100, int(round(100 * best / target))) if target else 0,
                "short": short, "warning": warning}

    def a_approve(self, body):
        if body.get("author_confirms") is not True:
            raise _err("APPROVAL_REQUIRED", "/author_confirms",
                       "approving needs your explicit confirmation (author_confirms: true)")
        ids = body.get("record_ids")
        if not isinstance(ids, list) or not ids or not all(isinstance(x, str) for x in ids) or len(ids) > 40:
            raise _err("INVALID_INPUT", "/record_ids", "list the records to approve (1-40)")
        versions = body.get("versions") if isinstance(body.get("versions"), dict) else {}
        results = []
        for rid in dict.fromkeys(ids):
            seen = versions.get(rid)  # the exact version the author looked at, when the caller knows it
            seen = seen if isinstance(seen, int) and not isinstance(seen, bool) else None
            r = self.rec(rid, seen)
            if r is None:
                results.append({"record_id": rid, "ok": False, "problems": ["record not found"]})
                continue
            if seen is not None and r["version"] != r["latest_version"]:
                results.append({"record_id": rid, "ok": False, "version": r["latest_version"], "problems": [
                    f"This draft changed since you looked at it (it is now version {r['latest_version']}). "
                    "Open it again before approving."]})
                continue
            if r["lifecycle"] in ("APPROVED", "LOCKED"):
                results.append({"record_id": rid, "ok": True, "status": r["lifecycle"], "problems": []})
                continue
            try:
                res = self.approve_ref(r["ref"])
            except StepError as exc:
                res = {"record_id": rid, "ok": False, "problems": exc.problems or [exc.message]}
            if not res["ok"]:
                # BookForge's own checks refused it: pressing approve again cannot help. Say how to get past it.
                redo = REDO_FOR.get(r["module_id"])
                if redo and r["module_id"] == "C02":
                    cid = self._chapter_of(rid)
                    redo = dict(redo, chapter_id=cid) if cid else None
                res.update(module_id=r["module_id"], redo=redo, fix=refusal_advice(res.get("problems") or [], redo))
            results.append(res)
        ok = all(x["ok"] for x in results)
        n = sum(1 for x in results if x["ok"])
        return {"ok": ok, "results": results,
                "message": f"Approved {n} of {len(results)}." + ("" if ok else " Some need fixing — see below.")}

    def _chapter_of(self, rid: str) -> str | None:
        outline = self.outline()
        for ch in self.outline_chapters(outline) if outline else []:
            _ctx, latest, _appr = self.chapter_prose(outline, ch["chapter_id"])
            if latest and latest["record_id"] == rid:
                return ch["chapter_id"]
        return None

    def a_setup_format(self, body):
        if not self.profile.get("title"):
            raise StepError.msg("Fill in the book profile (at least the title) first.")
        md = self.metadata()
        old = self.mem.get("format") or {}
        # Remaking the format after the title/author changed: keep the font, page and contents style the assembled
        # book was laid out with; only the records that carry the title/author are made again.
        keep = {k: old[k] for k in ("font_file", "font", "page", "toc_style")
                if self.ref_ok(old.get(k), approved=False)}
        refresh = len(keep) == 4
        fmt = dict(keep) if refresh else {}
        if not refresh:
            fmt["font_file"] = self.import_profile("ASSET_MANIFEST", {"assets": [],
                                                                      "placement_ids": ["font:times-roman"]},
                                                   "Font file list")
            fmt["font"] = self.import_profile("FONT_PROFILE", {"font_refs": [fmt["font_file"]],
                                                               "embedding_permitted": True,
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
        if not refresh:
            fmt["toc_style"] = self.import_profile("TOC_STYLE", {"max_depth": 1, "include_pages": True,
                                                                 "link_targets": True}, "Contents style")
        old_ta = self.format_title_author(self.ref_ok(old.get("metadata"), approved=False))
        changed = not refresh or old_ta is None or tuple(old_ta) != (md["title"], md["author"])

        def put(m):
            m["format"] = fmt
            if changed and isinstance(m.get("assembly"), dict) and m["assembly"].get("G01"):
                # The title page (or the layout) of the assembled book came from the old format: put it together
                # again. Remaking the format with the same title, author, font and page changes nothing.
                m["assembly"]["format_changed"] = True
        self.remember(put)
        if refresh:
            return {"ok": True, "message": f"The book format now carries “{md['title']}” by {md['author']}. Approve "
                    "it, then put the book together again (the title page shows the new title) and export it again."}
        return {"ok": True, "message": "Book format settings made from your profile (6 x 9 inch pages, Times 11 pt). "
                "Approve them to continue."}

    def a_assemble(self, body):
        st = self.status()
        steps = {s["id"]: s for s in st["steps"]}
        if not steps["chapters"].get("chapters") or not all(c.get("approved") for c in steps["chapters"]["chapters"]) \
                or steps["format"]["state"] != "done":
            raise StepError.msg("Approve every chapter and the book format first.")
        chapters = [c["approved"] for c in steps["chapters"]["chapters"]]
        refs = [self.rec(c["record_id"], c["version"])["ref"] for c in chapters]
        fmt = self.mem["format"]
        m = self.store.feature_manifest(self.pid, self.branch) or {"revision": 1}
        asm = {}
        asm["G02"], _ = self.create("G02", {"approved_chapter_refs": refs, "ordered_chapter_ids":
                                            [r["record_id"] for r in refs], "manifest_revision": m["revision"]})
        compile_payload = {"ordered_manifest_ref": asm["G02"], "approved_chapter_refs": refs,
                           "section_id_policy": "STABLE_ID"}
        asm["G01_plain"], _ = self.create("G01", compile_payload)
        asm["G05_plain"], _ = self.create("G05", {"font_profile_ref": self._appr(fmt["font"]), "language_tag": "en",
                                                  "manuscript_ref": asm["G01_plain"]})
        # Title page (title and author from the book profile) and chapter headings, compiled into the manuscript.
        asm["G06"], _ = self.create("G06", {"typography_ref": asm["G05_plain"],
                                            "chapter_title_rules_ref": self._title_rules()})
        asm["G08"], _ = self.create("G08", {"book_ref": asm["G01_plain"], "front_matter_items": ["title_page"],
                                            "publication_profile_ref": self._appr(fmt["pdf_profile"])})
        asm["G01"], _ = self.create("G01", compile_payload, input_refs=[asm["G06"], asm["G08"]])
        asm["G05"], _ = self.create("G05", {"font_profile_ref": self._appr(fmt["font"]), "language_tag": "en",
                                            "manuscript_ref": asm["G01"]})
        asm["G04"], _ = self.create("G04", {"manuscript_ref": asm["G01"], "page_profile_ref": self._appr(fmt["page"]),
                                            "typography_ref": asm["G05"],
                                            "margins_pt": {"top": 54, "bottom": 54, "left": 54, "right": 54}})
        asm["G07"], _ = self.create("G07", {"paginated_book_ref": asm["G04"],
                                            "toc_style_ref": self._appr(fmt["toc_style"]), "max_passes": 6})
        asm["chapters"] = [f"{c['record_id']}:{c['version']}" for c in chapters]
        # the title page was made with this title/author (from the approved book format)
        asm["title_page"] = list(self.format_title_author(self.rec(fmt["metadata"]["record_id"])) or
                                 self.title_author())

        def put(m):
            m["assembly"] = asm
            m.pop("exports", None)
        self.remember(put)
        return {"ok": True, "message": f"The book is put together from {len(refs)} approved chapter(s). Approve the "
                "assembly to export it."}

    def _title_rules(self):
        """The TITLE_RULES record for chapter headings (made once, reused while it is current)."""
        ref = self.mem.get("title_rules")
        if not self.ref_ok(ref, approved=False):
            ref = self.import_profile("TITLE_RULES", dict(CHAPTER_TITLE_RULES), "Chapter headings")
            self.remember(lambda m: m.__setitem__("title_rules", ref))
        return ref

    def _appr(self, ref):
        """The approved revision of a record this path created (approval keeps the same version)."""
        r = self.rec(ref["record_id"], ref["version"])
        return r["ref"] if r else ref

    def a_export(self, body):
        st = {s["id"]: s for s in self.status()["steps"]}
        if st["assemble"]["state"] != "done":
            raise StepError.msg("Put the book together and approve it first.")
        if st["format"]["state"] != "done":
            raise StepError.msg("The book format is out of date (the title or author changed): make it again and "
                                "approve it first.")
        asm, fmt = self.mem["assembly"], self.mem["format"]
        title, author = self.title_author()
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
                made[prof_type] = {"descriptor": ref, "assembly": asm["G07"]["record_id"],
                                   "metadata": fmt["metadata"]["record_id"], "title": title, "author": author}
            except StepError as exc:
                problems_.append(f"{name}: {exc.message}")
        self.remember(lambda m: m.__setitem__("exports", dict(m.get("exports") or {}, **made)))
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
        self.remember(lambda m: m.__setitem__("check", {"H05": ref, "assembly": asm["G01"]["record_id"]}))
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


def refusal_advice(probs: list, redo=None) -> str:
    """What the author can do about a draft BookForge's checks refused, in plain words. Editing only helps when the
    text itself is wrong: a draft made from a plan or inputs that changed since (STALE, SOURCE_PIN) stays out of date
    whatever is typed into it, and one whose inputs are not approved yet waits for those inputs."""
    rules = {str(p).split(":", 1)[0].strip() for p in probs or []}
    again = " (🔁 Redo with AI, or write it again yourself)" if redo else ""
    if rules and rules <= {"STALE", "SOURCE_PIN", "INPUT_NOT_VALIDATED"}:
        if rules & {"STALE", "SOURCE_PIN"}:
            return ("It was made from a plan or other inputs that changed since, so it is out of date: editing it "
                    "cannot fix that. Approve the current version of what it was made from (for example the chapter "
                    "outline or the characters), then make it again from them" + again + ".")
        return ("Something it was made from is not approved yet (see the problem above): approve that first, then "
                "approve this again.")
    return ("Edit it so the checks pass, or let the AI write it again (🔁 Redo with AI)." if redo else
            "Edit it so the checks pass.")


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
