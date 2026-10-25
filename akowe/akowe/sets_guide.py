"""Set guide: plain-language metadata for the 11 module sets (A-K), served as GET /api/sets.

One table (SET_GUIDE) holds what each set is for, where it fits in the build order, which sets it
depends on, the order its operations are normally worked through, and a few featured actions
written from the set's "Set rules" in package/Specifications/Akowe_Set_<X>_Final.md.

Featured action types (the browser decides how to present them; nothing here runs anything):
  make  - "✨ Make some for me": ask an AI slot for proposals of ``op`` (Set A through the Bible
          Builder, other assist-capable operations through /api/assist). The author reviews every
          proposal; nothing is committed without an explicit Create.
  bible - open the Bible Builder.
  new   - open the New form of ``op`` (creative ops use the AI slot or a manual candidate when the
          author presses Create; LOGIC ops are deterministic code).
  open  - open the operation page of ``op``.
  page  - open a project page (progress, activity, manifest).

Counts come from the stored head records of the active project/branch only; this module never
writes anything and never fabricates approvals.
"""
from __future__ import annotations

from .assist import supports as assist_supports

SET_IDS = tuple("ABCDEFGHIJK")

# The first usable vertical slice from package/Build_Plan.md, in order. "What's next" walks it.
MAIN_PATH = ("A01", "B01", "B03", "B11", "C01", "C02", "E01", "E02", "F01", "F11", "G02", "G01", "G11",
             "H05", "H09", "H10")
# The main writing path through the sets (the remaining sets are optional or always available).
PATH_SETS = ("A", "B", "C", "E", "F", "G", "H")

CHARACTER_ROLES = ["protagonist", "antagonist", "mentor", "sidekick", "rival", "love interest", "comic relief",
                   "mysterious stranger"]
PLACE_KINDS = ["home town", "capital city", "hidden refuge", "dangerous wilderness", "ancient ruin", "harbor",
               "seat of power"]


def _num(letter: str, n: int) -> list[str]:
    return [f"{letter}{i:02d}" for i in range(1, n + 1)]


SET_GUIDE: dict[str, dict] = {
    "A": {
        "name": "Universe & Characters", "short": "Universe", "icon": "🌍",
        "purpose": "Your story bible: characters, places, worlds, cultures and the rules of your world.",
        "about": ("Set A holds the canon of your world. Every entry starts from a short concept; links to other "
                  "entries are optional for a first draft. Precise details go in facts (who, what, value, from "
                  "when). Protected facts such as a character's appearance can only change with an approval. "
                  "Accept an entry to make it canon that planning, writing, art and checks rely on."),
        "build_order": 1, "stage": "Step 1 · Start here — nothing needs to exist first.",
        "depends_on": [],
        "op_order": _num("A", 18),
        "featured": [
            {"id": "make-characters", "type": "make", "op": "A01", "icon": "👥", "count": 3,
             "label": "Make up characters for me", "hints": CHARACTER_ROLES,
             "description": "Your AI invents a cast that fits your book idea — pick how many and which roles. "
                            "You review every character and choose which to keep as drafts."},
            {"id": "make-places", "type": "make", "op": "A04", "icon": "🏞️", "count": 2,
             "label": "Invent places for me", "hints": PLACE_KINDS,
             "description": "Towns, rooms, wilds and landmarks that fit your world, for you to review."},
            {"id": "bible", "type": "bible", "op": None, "icon": "📖", "label": "Build a starter story bible",
             "description": "The Bible Builder drafts characters, places, a world, a culture, a government and a "
                            "magic or technology system together, so names and links stay consistent."},
        ],
    },
    "B": {
        "name": "Story Planning", "short": "Planning", "icon": "🗺️",
        "purpose": "Premise, genre and tone, main plot, character arcs, structure and the chapter outline.",
        "about": ("Set B plans the book before any prose exists. Work in stages: premise (B01), then genre/tone "
                  "and main plot (B02/B03), subplots and arcs (B04/B05), structure and conflicts (B06/B07), the "
                  "story timeline (B10) and the chapter outline (B11); mystery, foreshadowing, scenes and pacing "
                  "refine it, and B14 plans the ending. Mystery and foreshadowing only apply when those features "
                  "are on. Every plot obligation must end up resolved, intentionally open, or flagged."),
        "build_order": 2, "stage": "Step 2 · Plan the story (approved universe entries can be used as canon).",
        "depends_on": ["A"],
        "op_order": ["B01", "B02", "B03", "B04", "B05", "B06", "B07", "B10", "B11", "B08", "B09", "B12", "B13",
                     "B14"],
        "featured": [
            {"id": "make-premise", "type": "make", "op": "B01", "icon": "💡", "count": 3,
             "label": "Draft a premise for me",
             "description": "Describe your idea and get several premise options to choose from."},
            {"id": "make-plot", "type": "make", "op": "B03", "icon": "🧵", "count": 2,
             "label": "Draft the main plot for me",
             "description": "Main plot proposals; link your premise and canon in the form before you create it."},
            {"id": "outline", "type": "new", "op": "B11", "icon": "📑", "label": "Plan the chapters",
             "description": "Open the chapter outline (B11); ✨ Fill with AI is available there."},
        ],
    },
    "C": {
        "name": "Writing", "short": "Writing", "icon": "✍️",
        "purpose": "Turns the outline into chapter and scene prose — written by your AI or by you.",
        "about": ("Set C owns the manuscript. C01 gathers the exact context for a chapter (outline, canon, story "
                  "state and style) without any AI. C02 writes a chapter and C03 a scene; C04-C10 write dialogue, "
                  "description, action, inner thoughts, transitions, openings and endings into a selected spot; "
                  "C11 rewrites a passage and C12 sets the writing style. New prose stays a candidate until its "
                  "checks pass and you accept it. With no AI connected you write the text yourself (manual)."),
        "build_order": 3, "stage": "Step 3 · Write (needs a chapter outline from B11).",
        "depends_on": ["B", "A"],
        "op_order": ["C12", "C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10", "C11"],
        "featured": [
            {"id": "context", "type": "new", "op": "C01", "icon": "📦", "label": "Load chapter context",
             "description": "Collects the outline, canon and state a chapter needs (deterministic, no AI)."},
            {"id": "chapter", "type": "new", "op": "C02", "icon": "📝", "label": "Write a chapter",
             "description": "Your AI slot writes the chapter when you press Create, or write it yourself."},
            {"id": "style", "type": "new", "op": "C12", "icon": "🎚️", "label": "Set the writing style",
             "description": "Voice, tense and style rules that every writer step follows."},
        ],
    },
    "D": {
        "name": "Art & Maps", "short": "Art", "icon": "🎨",
        "purpose": "Visual style, character references, illustrations, cover art and maps.",
        "about": ("Set D only applies when the artwork feature is on. D01 defines the visual style; D02-D06 make "
                  "references for characters, places, creatures and objects from approved canon; D07-D09 plan "
                  "scenes, panels and composition; D10 checks consistency; D11 is cover art and D12 draws maps "
                  "from a deterministic graph. Images are uploaded files whose rights you clear; art never "
                  "changes canon."),
        "build_order": 8, "stage": "Optional · any time after the universe (A), only when artwork is on.",
        "depends_on": ["A"],
        "op_order": _num("D", 12),
        "featured": [
            {"id": "style", "type": "new", "op": "D01", "icon": "🖌️", "label": "Define the visual style",
             "description": "The look every illustration follows."},
            {"id": "map", "type": "new", "op": "D12", "icon": "🗺️", "label": "Make a map",
             "description": "A map drawn exactly from your places and labels."},
            {"id": "cover", "type": "new", "op": "D11", "icon": "🖼️", "label": "Cover artwork",
             "description": "Cover art for the book (the print wrap is laid out later in G10)."},
        ],
    },
    "E": {
        "name": "Story State & Continuity", "short": "State", "icon": "🧭",
        "purpose": "What is true at each point of the story: places, knowledge, injuries, items, threads.",
        "about": ("Set E tracks story state from accepted events in your prose: where characters are, what they "
                  "know, relationships, injuries, inventory, power use, plot threads and open events. Start a "
                  "tracker from approved canon (it may start empty), then apply accepted events. E11 checks "
                  "chapter-to-chapter continuity and E12 compares the manuscript with canon. E never rewrites "
                  "canon or prose."),
        "build_order": 4, "stage": "Step 4 · Track story state from accepted prose.",
        "depends_on": ["C", "A", "B"],
        "op_order": _num("E", 12),
        "featured": [
            {"id": "character", "type": "new", "op": "E01", "icon": "🧍", "label": "Track a character's state",
             "description": "Start or update a character's state (deterministic, no AI)."},
            {"id": "continuity", "type": "new", "op": "E11", "icon": "🔗", "label": "Check chapter continuity",
             "description": "Compares the state at the end of one chapter with the start of the next."},
            {"id": "canon", "type": "new", "op": "E12", "icon": "⚖️", "label": "Check canon vs manuscript",
             "description": "Finds prose claims that disagree with canon or story state."},
        ],
    },
    "F": {
        "name": "Editing", "short": "Editing", "icon": "✂️",
        "purpose": "Reviews and suggested edits; changes reach the manuscript only through Writing.",
        "about": ("Set F reviews the manuscript: developmental notes, structure, pacing, characters, dialogue, "
                  "prose, repetition, clarity, grammar, transitions, line edits and the final polish. Every "
                  "finding points at an exact passage. Edits are proposals: an accepted edit becomes a new "
                  "manuscript revision through Writing (C), and overlapping edits are never silently merged."),
        "build_order": 5, "stage": "Step 5 · Edit the written manuscript.",
        "depends_on": ["C"],
        "op_order": _num("F", 12),
        "featured": [
            {"id": "review", "type": "new", "op": "F01", "icon": "🔎", "label": "Developmental review",
             "description": "Big-picture notes on goals, stakes and arcs."},
            {"id": "repeats", "type": "new", "op": "F07", "icon": "🔁", "label": "Find repeated phrases",
             "description": "Deterministic repetition check (no AI)."},
            {"id": "line", "type": "new", "op": "F11", "icon": "🖊️", "label": "Line edit a passage",
             "description": "Meaning-preserving line edits that keep protected facts unchanged."},
        ],
    },
    "G": {
        "name": "Assemble & Export", "short": "Export", "icon": "📚",
        "purpose": "Orders the approved chapters, lays out the book and exports PDF, EPUB and DOCX.",
        "about": ("Set G builds the book. G02 orders the approved chapters and G01 compiles them; G05 sets the "
                  "typography before G04 lays out the pages; title pages, front and back matter come before the "
                  "final layout and G07 builds the table of contents. G11-G13 export PDF, EPUB and DOCX for the "
                  "release profiles you selected. Exports are exact files that the quality checks inspect."),
        "build_order": 6, "stage": "Step 6 · Assemble and export (needs approved chapters).",
        "depends_on": ["C", "F", "D"],
        "op_order": ["G02", "G01", "G05", "G14", "G03", "G06", "G08", "G09", "G04", "G07", "G10", "G11", "G12",
                     "G13"],
        "featured": [
            {"id": "order", "type": "new", "op": "G02", "icon": "🔢", "label": "Order the chapters",
             "description": "Pick the approved chapters and their order (deterministic)."},
            {"id": "compile", "type": "new", "op": "G01", "icon": "🧩", "label": "Compile the manuscript",
             "description": "Builds one manuscript from the chapter order (deterministic)."},
            {"id": "pdf", "type": "new", "op": "G11", "icon": "📄", "label": "Export a PDF",
             "description": "Exact PDF bytes for the selected release profile."},
        ],
    },
    "H": {
        "name": "Quality Checks", "short": "Quality", "icon": "✅",
        "purpose": "Checks the finished book and its files and says whether it is ready to release.",
        "about": ("Set H inspects the book: read-through, canon, plot resolutions, character arcs, missing or "
                  "duplicate content, art, layout, table of contents and the actual export files. H10 gathers "
                  "the selected checks and reports READY only when all of them pass for the exact files. A "
                  "missing tool is UNKNOWN, never a pass."),
        "build_order": 7, "stage": "Step 7 · Check the exports before release.",
        "depends_on": ["G", "C"],
        "op_order": _num("H", 10),
        "featured": [
            {"id": "content", "type": "new", "op": "H05", "icon": "🧮", "label": "Check missing/duplicate content",
             "description": "Compares the selected chapters and their order (deterministic)."},
            {"id": "files", "type": "new", "op": "H09", "icon": "🗂️", "label": "Check the export files",
             "description": "Re-reads the PDF/EPUB/DOCX bytes and verifies them."},
            {"id": "ready", "type": "new", "op": "H10", "icon": "🏁", "label": "Final readiness report",
             "description": "READY only when every selected check passes."},
        ],
    },
    "I": {
        "name": "Storage & Context", "short": "Storage", "icon": "🗄️",
        "purpose": "Behind the scenes: imports, schemas, search, context packages, approvals and history.",
        "about": ("Set I is the storage layer every other set uses: imported files (I01), schemas and the module "
                  "registry, field validation, missing-information requests, context search and packages, canon "
                  "approval and locks (I10), version history, completion, dependencies, provenance and context "
                  "compression. You rarely need it directly — mostly to import a file or approve/lock canon."),
        "build_order": 10, "stage": "Always available · infrastructure used by every set.",
        "depends_on": [],
        "op_order": _num("I", 15),
        "featured": [
            {"id": "import", "type": "open", "op": "I01", "icon": "📥", "label": "Import a file",
             "description": "Store an image, document or other file as a versioned import."},
            {"id": "search", "type": "new", "op": "I06", "icon": "🔍", "label": "Search the canon",
             "description": "Literal search over your records (deterministic)."},
            {"id": "approve", "type": "new", "op": "I10", "icon": "🔒", "label": "Approve or lock canon",
             "description": "Record an approval or lock for an exact revision."},
        ],
    },
    "J": {
        "name": "Fix Contradictions", "short": "Reconcile", "icon": "⚖️",
        "purpose": "Finds facts that disagree and helps you fix them with the smallest change.",
        "about": ("Set J finds contradictions between canon, story state and the manuscript (same subject, same "
                  "time, same branch), checks duplicates, proposes repair options ranked by authority, picks the "
                  "smallest change, shows its ripple effect and applies an approved repair to every owner at "
                  "once. Protected facts never change without your explicit decision."),
        "build_order": 9, "stage": "As needed · when canon, state and manuscript disagree.",
        "depends_on": ["A", "E", "C"],
        "op_order": _num("J", 11),
        "featured": [
            {"id": "detect", "type": "new", "op": "J01", "icon": "🔦", "label": "Find contradictions",
             "description": "Compares claims about the same subject and time."},
            {"id": "reconcile", "type": "new", "op": "J04", "icon": "🤝", "label": "Propose fixes",
             "description": "Repair options ordered by canon authority."},
            {"id": "decide", "type": "new", "op": "J11", "icon": "🙋", "label": "Ask me to decide",
             "description": "A bounded decision with options and impact."},
        ],
    },
    "K": {
        "name": "Project Control", "short": "Control", "icon": "⚙️",
        "purpose": "Scheduling, the job queue, approvals, pause/resume, AI selection and cost control.",
        "about": ("Set K runs and tracks the work: project settings, the scheduler and router, dependencies, the "
                  "job queue and retries, automatic or manual mode, progress, approval checkpoints (K09), "
                  "pause/resume, choosing an AI or tool, and cost limits. It never edits your story records."),
        "build_order": 11, "stage": "Always available · runs and tracks the work.",
        "depends_on": ["I"],
        "op_order": _num("K", 12),
        "featured": [
            {"id": "progress", "type": "page", "op": None, "page": "progress", "icon": "📊",
             "label": "See progress", "description": "Which required steps have approved records."},
            {"id": "approvals", "type": "new", "op": "K09", "icon": "✔️", "label": "Approval checkpoint",
             "description": "Authorize an exact action (protected changes, polish, release)."},
            {"id": "pause", "type": "new", "op": "K10", "icon": "⏯️", "label": "Pause or resume work",
             "description": "Pause the queue safely and resume later."},
        ],
    },
}

FEATURED_TYPES = ("make", "bible", "new", "open", "page")


def _op_summary(contracts, op_id: str, recs: list[dict], required: set | None) -> dict:
    op = contracts.operation(op_id)
    execution = op.get("execution") or ""
    mine = [r for r in recs if r["module_id"] == op_id]
    latest = max(mine, key=lambda r: (r.get("created_at") or "", r["record_id"]), default=None)
    purpose = op.get("purpose") or ""
    return {"op_id": op_id, "title": op["name"], "purpose": purpose,
            "kind": execution,
            "uses_ai": ("AI" in execution or "HYBRID" in execution) and not execution.startswith("LOGIC"),
            "ai_capable": assist_supports(contracts, op_id),
            "required": None if required is None else op_id in required,
            "record_count": len(mine),
            "approved_count": sum(1 for r in mine if r.get("approved_version")),
            "stale_count": sum(1 for r in mine if r.get("stale")),
            "latest_lifecycle": latest["lifecycle"] if latest else None}


def next_step(per_op: dict, required: set | None) -> dict | None:
    """First operation on the main path (A→B→C→E→F→G→H vertical slice) that is required on this branch
    and has no approved record yet."""
    for op_id in MAIN_PATH:
        if required is not None and op_id not in required:
            continue
        st = per_op.get(op_id)
        if st is None or st["approved_count"]:
            continue
        if st["record_count"]:
            reason = (f"{st['record_count']} draft{'s' if st['record_count'] > 1 else ''}, none approved yet — "
                      "open one, Validate it and Accept it.")
        else:
            reason = "no records yet — create the first one."
        return {"op_id": op_id, "set_id": op_id[0], "title": st["title"], "reason": reason,
                "record_count": st["record_count"]}
    return None


def sets_overview(contracts, records: list[dict] | None = None, manifest: dict | None = None) -> dict:
    """All 11 sets with their operations; counts are taken from ``records`` (head summaries)."""
    recs = records or []
    required = set(manifest.get("required_operations") or []) if manifest else None
    per_op: dict[str, dict] = {}
    sets = []
    for sid in SET_IDS:
        g = SET_GUIDE[sid]
        ops = [_op_summary(contracts, op_id, recs, required) for op_id in g["op_order"]]
        for o in ops:
            per_op[o["op_id"]] = o
        set_recs = [r for r in recs if r["module_id"][0] == sid]
        featured = []
        for f in g["featured"]:
            item = dict(f)
            if f.get("op"):
                item["op_title"] = contracts.operation(f["op"])["name"]
            featured.append(item)
        sets.append({"set_id": sid, "name": g["name"], "short": g["short"], "icon": g["icon"],
                     "purpose": g["purpose"], "about": g["about"], "build_order": g["build_order"],
                     "stage": g["stage"], "depends_on": list(g["depends_on"]), "on_main_path": sid in PATH_SETS,
                     "featured_actions": featured, "operations": ops,
                     "record_count": len(set_recs),
                     "approved_count": sum(1 for r in set_recs if r.get("approved_version")),
                     "stale_count": sum(1 for r in set_recs if r.get("stale")),
                     "ops_with_approved": sum(1 for o in ops if o["approved_count"])})
    return {"sets": sets, "main_path": list(MAIN_PATH), "path_sets": list(PATH_SETS),
            "next_step": next_step(per_op, required) if records is not None else None}
