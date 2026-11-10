"""A deterministic fake AI for Make-a-book tests (and the UI test server).

It answers every AI task Akọwe sends by the shape of the requested output schema: the invented book profile,
the Bible Builder world sketch and its Set A proposals, premise B01, main plot B03, outline B11 (as many chapters as
the outline asks for), chapter prose C02 (with objective assessments for the requested chapter), story events,
AI review verdicts (scriptable) and AI fixes (the draft returned with a revised sentence, references untouched).
Scripted failures (AkoweError instances) are raised before answering, in order.

The AI editor (P4) and the writer's targeted rewrite (P5) are answered deterministically too: ``editor_flags`` maps
a phrase to its replacement. A craft review flags (major, subtext score 4) every sentence of the chapter that holds
one of those phrases and keeps the chapter's first sentence; with no flagged phrase it passes (all scores 8). A
rewrite request replaces the phrase inside each flagged sentence. ``craft_script`` / ``rewrite_script`` hold whole
answers (dicts, or callables(ctx) -> dict) used first, one per call.

Section 4: the story-rules ledger (``RULES``; an update answer adds one rule and changes another), the world-texture
list (``TEXTURE``; scene plans then take their obstacles from it and name the texture ids), the planned-to-page checker
(an item is on the page when a sentence of the chapter holds one of its words; ``planned_script`` overrides), the
writer's fix of planned items (``planned_fix``: the anchor sentence gets the item appended) and editor notes for story
rules (``rule_flags``: phrase -> dimension, e.g. a sentence that explains a protected mystery).

Section 7a: the trade-facts finder (hyphenated "-key/-cock/-valve/-pole" words of the chapter; ``terms_script``
overrides), research answers (a wick term is "wrong", the rest "plausible") and the fact fixes (a terminology finding
replaces the term with its "use:" text, a repetition finding drops the repeated words from the sentence).
"""
from __future__ import annotations

import copy
import json
import threading

from akowe.errors import AkoweError

# ✍ two first pages (first_page.py): about 150 words each, different ways in
OPENING_A = ("Mara Vell was forty steps up the old lighthouse when the lantern went out in her hand. " + " ".join(
    ["She stood still on the iron stair and listened to the fog breathe against the glass, counting the steps "
     "she had left and the reasons she had to climb them."] * 5))
OPENING_B = ("The lens in the lamp room of Gullhaven light was cracked from rim to centre, and Mara Vell knew at once "
             "that no storm had done it. " + " ".join(["Her master's letter was folded in her coat, and the logbook "
                                                      "lay open on the desk where he had left it a week ago."] * 5))
CHAPTER_TEXT = {
    1: ["The fog rolled in over Gullhaven before dawn, and Mara Vell climbed the hundred and twelve steps of the old "
        "lighthouse with a lantern in one hand and her master's last letter in the other.",
        "The lamp room was cold. Tom Reed's logbook lay open beside a cracked lens, and the final line was written in "
        "a hand she did not know."],
    2: ["Down in the harbor the fishing boats knocked together like restless teeth. Mara asked every captain about "
        "the night the light went dark, and every captain looked away.",
        "Only old Nessa at the net sheds would talk, and only in a whisper: the keeper had gone out to the reef with "
        "a stranger, and only the stranger had come back."],
    3: ["At low tide the reef rose out of the water like the spine of something sleeping. Mara found the keeper's "
        "brass key wedged between two stones, still warm from the sun.",
        "When she turned it in the lighthouse door that night, the great lamp blazed for the first time in a week, "
        "and far out on the water a small boat turned for home."],
}


def fact(s, p, v, a="FACT"):
    return {"subject_id": s, "predicate": p, "value": v, "assertion_type": a, "effective_from": None,
            "effective_to": None, "source_refs": []}


def plan_item(item_id, order, objective, pov="mara-vell", loc="gullhaven-harbor"):
    facts = [fact(item_id, "plan.item_id", item_id, "PLAN"), fact(item_id, "plan.order", order, "PLAN"),
             fact(item_id, "plan.parent_id", None, "PLAN"), fact(item_id, "plan.objective", objective, "PLAN"),
             fact(item_id, "plan.event_ids", [], "PLAN"), fact(item_id, "plan.pov_id", pov, "PLAN"),
             fact(item_id, "plan.location_id", loc, "PLAN"), fact(item_id, "plan.obligation_ids", [], "PLAN")]
    return {"summary": f"{item_id}: {objective}", "facts": facts, "links": []}


OBJECTIVES = ["Mara climbs to the dark lighthouse and finds the keeper's log",
              "Mara questions the harbor and learns about the stranger",
              "Mara finds the brass key on the reef and relights the lamp"]
NAMES = {"A01": ["Mara Vell", "Tom Reed", "Nessa Crane", "Ilse Marrow"], "A04": ["Gullhaven Harbor", "The Old Light",
                                                                                 "Widow's Reef"],
         "A03": ["The Grey Coast"]}


# P17: every character talks their own way (the fake's voice cards are clearly different from each other)
VOICES = {
    "Mara Vell": {"rhythm": "short, blunt sentences; questions she answers herself", "register": "plain, working",
                  "vocabulary": ["wick", "lens", "log", "tide-table"], "phrases": ["Fair enough."],
                  "never_words": ["perhaps", "darling"], "habits": ["answers a question with a question"],
                  "under_pressure": "goes quiet, then one hard question", "talks_around": "her master's absence",
                  "samples": ["Who signed the log?", "Fair enough. Then show me the reef."]},
    "Tom Reed": {"rhythm": "long, wandering sentences that circle back", "register": "old-fashioned, educated",
                 "vocabulary": ["fathom", "almanac", "providence"], "phrases": ["as the old keepers said"],
                 "never_words": ["okay", "yeah"], "habits": ["changes the subject to the weather"],
                 "under_pressure": "lectures, piles up clauses", "talks_around": "the stranger on the reef",
                 "samples": ["As the old keepers said, a lamp that is watched never fails, and yet here we are."]},
    "Nessa Crane": {"rhythm": "clipped whispers, half-sentences", "register": "slangy harbour talk",
                    "vocabulary": ["nets", "gutting knife", "the Point"], "phrases": ["mind yourself"],
                    "never_words": ["indeed", "providence"], "habits": ["jokes when nervous", "asks a price"],
                    "under_pressure": "laughs too loud, names a price", "talks_around": "what she saw that night",
                    "samples": ["Mind yourself. Talk costs a herring, love."]},
}
# ⏱ story details the fake decides (story_details.py)
DETAILS = {
    "physique": "1.68 m (5 ft 6 in), 61 kg (134 lb); lean and wiry, long arms", "face": "a narrow, weathered face",
    "eyes": "storm-grey eyes", "hair": "black hair cut short at the jaw", "skin": "wind-burned olive skin",
    "markings": "a rope scar across the left palm", "clothing": "an oilskin coat over a wool jumper",
    "posture": "stands square, weight on the back foot", "presence": "watchful; smiles late",
    "speech_fear": "Fear: short questions, one at a time", "speech_anger": "Anger: very quiet, very precise",
    "speech_grief": "Grief: talks about work instead", "public_private": "Public: brisk. Private: unsure of herself",
    "height": "1.68 m (5 ft 6 in)", "weight": "61 kg (134 lb)", "build": "lean", "handedness": "left",
    "primary_style": "{name} fights close and dirty, using the footing of the rocks",
    "primary_weapon": "a short curved sabre carried on the left hip",
    "power_source": "{name}: a tide-gift from the drowned keepers", "power_effects": "calls fog for a minute",
    "power_costs": "leaves the hands numb for an hour", "power_limits": "only within sight of the sea",
    "practical_skills": "{name} can pick a ship's lock and splice rope", "signature_possessions": "a bone locket",
    "place_type": "a working place", "one_line": "{name}, cold and salt-worn", "first_impression": "wind and gulls",
    "sights": "lamplight on wet stone", "mood": "watchful", "signature_detail": "the smell of lamp oil",
    "layout": "{name}: one long room with a ladder to a loft", "sounds": "the sea against the walls",
    "smells": "tar and fish", "light": "grey by day, lamp-yellow at night", "population": "two keepers and a boy",
    "item_type": "a key", "overall_look": "a heavy brass key, green at the teeth", "condition": "worn but whole",
    "current_holder": "Mara Vell", "abilities": "opens the lamp room door and wakes the great lamp",
    "limits": "works only in the Old Light's door", "costs": "the lamp burns a night's oil at once",
}
SCENE_PLACES = ["the lamp room of the old light", "the net sheds on the harbour wall", "the reef at low tide"]

# Section 4 (P9/P10): the fake's story rules and world texture
RULES = [
    {"id": "", "category": "hard_rule", "text": "The great lamp lights only when the brass key turns in the door.",
     "scope": "only at the Old Light; once per night; the key does nothing anywhere else", "source": "The Old Light",
     "stated_by": "the canon"},
    {"id": "", "category": "seen", "text": "Boats turn for home when the lamp blazes.", "scope": "",
     "source": "chapter 3 of the outline", "stated_by": "the narrator"},
    {"id": "", "category": "belief", "text": "Harbour folk believe the drowned keepers guide the light.",
     "scope": "a superstition; never confirmed", "source": "Gullhaven Harbor", "stated_by": "Nessa Crane"},
    {"id": "", "category": "mystery", "text": "Who the stranger on the reef was.", "scope": "", "source": "the premise",
     "stated_by": "the canon"},
]
TEXTURE = [
    {"kind": "work", "detail": "Keepers trim the wick with brass scissors before dusk", "causes": "skill",
     "effect": "Mara's trimming shows years of practice", "words": ["wick", "brass scissors"]},
    {"kind": "weather", "detail": "The evening tide floods the lighthouse steps", "causes": "obstacle",
     "effect": "the way up is cut off for an hour", "words": ["tide", "flooded steps"]},
    {"kind": "institution", "detail": "The harbour board seals any building it inspects", "causes": "obstacle",
     "effect": "a door Mara needs is sealed for a day", "words": ["harbour board", "seal"]},
    {"kind": "people", "detail": "Nessa Crane wants a herring for every answer", "causes": "cost",
     "effect": "information costs Mara her supper", "words": ["herring"]},
    {"kind": "economy", "detail": "Lamp oil is rationed by the board", "causes": "cost",
     "effect": "every night lit costs oil Mara cannot spare", "words": ["lamp oil", "ration"]},
]


# 🔁 the plain REVISE answers, one after another: different findings (the same one twice in a row is a loop)
REVISE_NOTES = [("The opening could name the place sooner.", "Name the harbor in the first line."),
                ("The motive is unclear in the middle.", "Give the keeper a clearer motive."),
                ("The weather arrives too late.", "Show the fog earlier on."),
                ("One sentence runs far too long.", "Shorten the long middle sentence."),
                ("Nothing can be heard in it.", "Add one concrete sound."),
                ("The ending lands softly.", "Make the last line land harder.")]


def voice_for(name):
    v = VOICES.get(name)
    if v is None:
        v = {"rhythm": f"{name}'s own measured rhythm", "register": "plain", "vocabulary": [f"{name.split()[0]}-word"],
             "phrases": [f"{name.split()[0]} says so"], "never_words": ["whatever"], "habits": ["goes quiet"],
             "under_pressure": "stammers", "talks_around": "money", "samples": [f"{name} will not say it."]}
    return copy.deepcopy(v)


# ★ the story role the fake gives each character (anyone else: supporting); Mara Vell is the protagonist
STORY_ROLES = {"Mara Vell": "protagonist", "Tom Reed": "mentor", "Nessa Crane": "ally", "Ilse Marrow": "antagonist"}


def sheet_for(name, others=(), story_role=None):
    side = name not in ("Mara Vell",)
    out = {"role": "side" if side else "main", "wants": f"{name} wants the light kept on their own terms",
            "needs": f"{name} needs to admit what happened", "fear": f"{name} fears the harbour board",
            "secret": f"{name} kept the stranger's letter", "false_belief": f"{name} believes the sea forgives",
            "stress": "lies, then bargains", "never_say": "I was afraid", "private_memory": "a burned logbook page",
            "relationships": [{"with": o, "tension": "owes them money", "history": "grew up on the same quay"}
                              for o in others if o != name][:3],
            "change_limits": "can learn to ask for help; will never leave the coast",
            "own_wish": f"{name} wants a boat of their own" if side else "",
            "must_show": [] if side else ["Her master taught her to read the tide-tables by candlelight"]}
    if story_role is False:  # False: an AI that gives no role at all (neither story_role nor main/side)
        out.pop("role")
    else:
        out["story_role"] = story_role or STORY_ROLES.get(name, "supporting")
    return out


def trust_one_ai(app, run_id, timeout=120):
    """H6: with only one AI the run pauses at its first draft (nobody else checked it). Answer like an author who
    trusts that AI: ✔ approve it yourself, and the rest of this run too. Returns the stored run."""
    run = app.autobook.get(run_id)
    if run.get("status") == "paused" and (run.get("problem") or {}).get("code") == "NO_SECOND_AI":
        app.autobook.decide("author", run_id, {"action": "approve_anyway", "author_confirms": True,
                                               "for_rest_of_run": True})
        app.autobook.wait_for(run_id, timeout)
    return app.autobook.get(run_id)


class BookFakeAI:
    def __init__(self, verdicts=None, default_verdict="APPROVE"):
        self.calls: list[dict] = []
        self.verdicts = list(verdicts or [])  # consumed one per review call
        self.revise_n = 0                     # which REVISE_NOTES entry the next plain REVISE uses
        self.default_verdict = default_verdict
        self.failures: list[AkoweError] = []  # raised before answering, one per call
        self.kind_failures: dict[str, list] = {}  # answer kind -> errors raised instead of that answer
        self.gate = None  # threading.Event: when set to an unset Event, every call waits for it
        self.waiting = threading.Event()  # set once a call is blocked on the gate (tests wait on this, not a sleep)
        self.delay = 0.0
        self.lock = threading.Lock()
        self.kinds: list[str] = []
        self.editor_flags: dict[str, str] = {}   # phrase -> replacement (P4/P5)
        self.craft_script: list = []             # scripted editor answers, one per craft review
        self.rewrite_script: list = []           # scripted writer answers, one per rewrite request
        self.craft_contexts: list[dict] = []     # what the editor was sent (tests check the pattern report etc.)
        self.companion = True                    # P7/P17: character proposals carry a sheet and a voice card
        self.prompts: dict[str, list] = {}       # answer kind -> [(task text, context)] (prompt checks in tests)
        self.scene_verdicts: list = []           # scripted scene-plan checks ("PASS"/"REVISE" or dicts), one per call
        self.scene_script: list = []             # scripted scene plans (dicts or callables(ctx)), one per call
        self.chapter_texts: dict[str, str] = {}  # chapter id -> the prose the fake writer returns for it
        self.rules_script: list = []             # scripted story-rules answers (P9), one per call
        self.texture_script: list = []           # scripted world-texture answers (P10), one per call
        self.planned_script: list = []           # scripted planned-to-page checks (P11), one per call
        self.planned_fix = False                 # P11: the writer works missing planned items into the anchor
        self.rule_flags: dict[str, str] = {}     # phrase -> editor dimension (P9 story_rules / protected_mysteries)
        self.max_chapters = 6                    # B11: at most this many chapters (P15 tests raise it)
        self.expand_text = False                 # P15: the writer's continuation adds a paragraph (default: nothing)
        self.book_review_script: list = []       # P13: scripted whole-book reviews (dicts or callables(ctx))
        self.compare_script: list = []           # P14: scripted blind comparisons (dicts or callables(ctx))
        self.terms_script: list = []             # P31: scripted "which trade facts to check" answers
        self.beta_script: list = []              # P23: scripted beta reads (dicts or callables(ctx))
        self.originality_script: list = []       # ✨ #20: scripted "sounds machine-written" ratings
        self.voice = None                        # ✍ the narrator_voice the invent step returns (when asked), a dict
        self.human_script: list = []             # ✍ scripted end-of-book rewrite answers (dicts or callables(ctx))
        # Character entries that break an Akọwe check: name -> kinds, one consumed per proposal of that name
        # ("interval": a fact whose effective_to is not after effective_from (the save is refused); "authority": a
        # home place no pinned A04 declares (VALIDATE refuses it); "schema": a fact missing its fields (the proposal
        # does not fit the form)).
        self.canon_breaks: dict[str, list] = {}
        self.no_roles = False                    # ★ an AI that gives no story_role anywhere (sketch, sheets)
        self.role_override: dict[str, str] = {}  # ★ name -> the story_role the fake gives instead (e.g. 2 protagonists)
        self.pov_name = None                     # ★ B11: write this (e.g. a misspelt name) as every chapter's POV
        self.series_script: list = []            # 📚 scripted "what changed in this book" answers
        self.objectives = None                   # B11: the chapters' objectives (default OBJECTIVES, cycled)
        self.details: dict[str, str] = {}        # ⏱ story details: field -> the text the fake decides
        # 📒 story ledger / 🧭 checkpoints (story_ledger.py, checkpoints.py)
        self.story_ledger = False                # the continuity tracker also returns the chapter's story part
        self.confirm_flags = False               # a checkpoint confirms Akọwe's ledger flags (with a fix when it can)
        self.checkpoint_script: list = []        # scripted checkpoint answers (dicts or callables(ctx)), one per call
        self.checkpoint_extra: list = []         # extra problems a checkpoint reports: {chapter, quote, problem,
        #                                          original, replacement} (only for chapters in that call)
        self.ending_script: list = []            # 🎯 H11/H12: scripted ending checks (dicts or callables(ctx))
        self.ending_fix = True                   # 🎯 the writer adds an ending finding's suggestion after the passage
        self.plot_obligations: list = []         # 🎯 the main plot's setups (B03 plot_obligations) the ending must keep
        self.needs = None                        # 🧠 a needs list returned with every scene plan (dict or callable(ctx))
        self.shape_script: list = []             # 📐 scripted beat placements (dicts or callables(ctx)), one per call
        self.kind_script: list = []              # 📚 scripted stage placements (dicts or callables(ctx)), one per call
        self.kind_pick = None                    # 📚 the kind of story the invent step picks (when asked), e.g. "quest"
        self.alongside_script: list = []         # ✍ Write alongside me: scripted answers (dicts or callables(ctx))
        # 🧑‍⚖️ the stand-in vote (stand_in.py): answers per slot ({slot: answer or [answers]}) or one per call (in
        # call order); an answer is {"pick": option code, "confident", "why"} (put on the voter's own random A / B),
        # any other dict / text as it is, or a callable(ctx). Default: the "accept" option, confident.
        self.stand_in_by_slot: dict = {}
        # ✍ two first pages (first_page.py) and chapter 1 rewritten last (opening_pass.py)
        self.openings_script: list = []          # scripted "two openings" answers (dicts or callables(ctx))
        self.pick_script: list = []              # scripted picks ({pick, why} or callables(ctx)); default B
        self.opening_rewrite_script: list = []   # scripted opening-pass rewrites (dicts or callables(ctx))
        self.use_first_page = False              # the chapter writer starts chapter 1 with the chosen first page
        # 📏 chapter polish (chapter_polish.py): scripted answers (dicts or callables(ctx)) used first; by default a
        # reading-level passage gets its sentences joined and a repeat passage gets ``polish_swaps`` (phrase -> new)
        self.polish_script: list = []
        self.polish_swaps: dict[str, str] = {}
        self.stand_in_script: list = []
        self.stand_in_default = {"pick": "accept", "confident": 0.9,
                                 "why": "The correction answers the reviewer's finding and agrees with the canon."}

    def fail_next(self, *excs):
        self.failures.extend(excs)

    def fail_kind(self, kind, *excs):
        self.kind_failures.setdefault(kind, []).extend(excs)

    def submit(self, slot, system, user, schema):
        package = json.loads(user.split("\n", 1)[1])
        ctx = package.get("context") or {}
        props = schema.get("properties") or {}
        usage = {"model": "fake-book-model", "input_tokens": 10, "output_tokens": 20}
        with self.lock:
            self.calls.append({"slot": slot["slot_id"], "props": sorted(props)})
            if self.failures:
                exc = self.failures.pop(0)
                self.kinds.append(f"fail:{exc.code}")
                raise exc
        gate = self.gate
        if gate is not None:
            self.waiting.set()
            gate.wait(30)
        if self.delay:
            import time  # noqa: PLC0415
            time.sleep(self.delay)
        if ctx.get("akowe_task") == "stand_in":
            kind, out = "stand_in", self._stand_in(slot["slot_id"], ctx)
        else:
            kind, out = self._answer(ctx, props, schema)
        with self.lock:
            self.prompts.setdefault(kind, []).append((system, ctx))
            pending = self.kind_failures.get(kind)
            if pending:
                exc = pending.pop(0)
                self.kinds.append(f"fail:{kind}:{exc.code}")
                raise exc
            self.kinds.append(kind)
        return out, usage

    def _stand_in(self, slot_id, ctx):
        """🧑‍⚖️ One vote: the scripted answer for this slot (or the next in call order), the option code put on the
        letter this voter sees (the order is random per voter)."""
        from akowe.stand_in import OPTION_WORDS  # noqa: PLC0415
        with self.lock:
            per = self.stand_in_by_slot.get(slot_id)
            if isinstance(per, list):
                a = per.pop(0) if per else None
            else:
                a = per
            if a is None and self.stand_in_script:
                a = self.stand_in_script.pop(0)
        a = copy.deepcopy(self.stand_in_default) if a is None else a
        a = a(ctx) if callable(a) else copy.deepcopy(a)
        if not isinstance(a, dict) or "pick" not in a:
            return a
        letters = {o["does"]: o["letter"] for o in ctx.get("options") or []}
        code_of = {OPTION_WORDS[c]: c for c in OPTION_WORDS}
        by_code = {code_of.get(d): letter for d, letter in letters.items()}
        pick = a.pop("pick")
        if pick == "accept":
            pick = "accept_change" if "accept_change" in by_code else "approve_anyway"
        a["choice"] = "unsure" if pick == "unsure" else by_code[pick]
        return a

    # ------------------------------------------------------------------ answers
    def _answer(self, ctx, props, schema):
        if "openings" in props:  # ✍ the writer's two first pages for chapter 1 (one answer)
            with self.lock:
                scripted = self.openings_script.pop(0) if self.openings_script else None
            if scripted is not None:
                return "openings", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "openings", {"openings": [{"approach": "in the middle of the climb", "text": OPENING_A},
                                             {"approach": "on the cracked lens", "text": OPENING_B}]}
        if "pick" in props and "openings" in ctx:  # ✍ one reviewer picks the better first page
            with self.lock:
                scripted = self.pick_script.pop(0) if self.pick_script else None
            if scripted is not None:
                return "first_page_pick", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "first_page_pick", {"pick": "B", "why": "B opens on a concrete moment and says who and where."}
        if "replacements" in props and ctx.get("polish_rules"):  # 📏 one line-level polish of a fresh draft
            with self.lock:
                scripted = self.polish_script.pop(0) if self.polish_script else None
            if scripted is not None:
                return "polish", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "polish", self._polish(ctx)
        if "replacements" in props and ctx.get("opening_brief"):  # ✍ chapter 1 rewritten last
            with self.lock:
                scripted = self.opening_rewrite_script.pop(0) if self.opening_rewrite_script else None
            if scripted is not None:
                return "opening_rewrite", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "opening_rewrite", {"replacements": []}
        if ctx.get("akowe_task") == "story_details":  # ⏱ story details (essentials / just in time)
            return "details", self._details(ctx)
        if "placements" in props and "story_kind" in ctx:  # 📚 place where each stage of the kind of story begins
            with self.lock:
                scripted = self.kind_script.pop(0) if self.kind_script else None
            if scripted is not None:
                return "kind", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            chs = ctx.get("chapters") or []
            out = []
            for b in (ctx["story_kind"] or {}).get("stages") or []:
                n = int(b.get("around_chapter") or 1)
                obj = next((c.get("objective") for c in chs if c.get("chapter") == n), "") or ""
                out.append({"beat": b["stage"], "chapter": n, "how": f"{obj} ({b['name']})"})
            return "kind", {"placements": out}
        if "placements" in props and "story_shape" in ctx:  # 📐 place the story shape's beats on the chapters
            with self.lock:
                scripted = self.shape_script.pop(0) if self.shape_script else None
            if scripted is not None:
                return "shape", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            chs = ctx.get("chapters") or []
            out = []
            for b in (ctx["story_shape"] or {}).get("beats") or []:
                n = int(b.get("around_chapter") or 1)
                obj = next((c.get("objective") for c in chs if c.get("chapter") == n), "") or ""
                out.append({"beat": b["beat"], "chapter": n, "how": f"{obj} ({b['name']})"})
            return "shape", {"placements": out}
        if ctx.get("akowe_task") == "write_alongside":  # ✍ Write alongside me: one passage
            with self.lock:
                scripted = self.alongside_script.pop(0) if self.alongside_script else None
            if scripted is not None:
                return "alongside", scripted(ctx) if callable(scripted) else scripted
            return "alongside", self._alongside(ctx)
        if "arc" in props and "question" in props:  # 🎯 H11 / H12: does the ending keep the book's promises?
            with self.lock:
                scripted = self.ending_script.pop(0) if self.ending_script else None
            if scripted is not None:
                return "ending", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "ending", {"items": [{"id": p["id"], "kept": True, "where": "", "note": "Paid off.", "fix": ""}
                                        for p in ctx.get("promises") or []],
                              "arc": {"kept": True, "note": "She asks for help at last.", "fix": ""},
                              "question": {"kept": True, "note": "The light is back.", "fix": ""}}
        if "character_changes" in props:  # 📚 series: what changed for each character in this book
            with self.lock:
                scripted = self.series_script.pop(0) if getattr(self, "series_script", None) else None
            if scripted is not None:
                return "series_changes", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            people = ctx.get("characters") or []
            first = ((ctx.get("chapters") or [{}])[-1]).get("chapter_id") or ""
            out = []
            for i, c in enumerate(people[:2]):
                empty = {k: [] for k in ("appearance", "items_gained", "items_lost", "abilities_gained",
                                         "abilities_lost", "relationships", "status")}
                if i == 0:
                    empty.update(appearance=[{"text": "a pale scar across the left cheek", "chapter": first}],
                                 items_gained=[{"text": "the keeper's brass key", "chapter": first}],
                                 status=[{"text": "keeper of the Old Light", "chapter": first}],
                                 personality=[{"text": "now cruel", "chapter": first}])  # never kept (fixed layer)
                out.append(dict(empty, name=c.get("name")))
            out.append(dict({k: [] for k in ("appearance", "items_gained", "items_lost", "abilities_gained",
                                             "abilities_lost", "relationships", "status")}, name="Nobody Here",
                            items_gained=[{"text": "a ghost", "chapter": first}]))
            return "series_changes", {"character_changes": out}
        if "reactions" in props:  # 📖 P23 (Section 7c): beta reader
            with self.lock:
                scripted = self.beta_script.pop(0) if getattr(self, "beta_script", None) else None
            if scripted is not None:
                return "beta", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "beta", self._beta(ctx)
        if "lines" in props and "spots" in ctx:  # ✍ the end-of-book pass: better lines for the worst spots
            with self.lock:
                scripted = self.human_script.pop(0) if self.human_script else None
            if scripted is not None:
                return "human_rewrite", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "human_rewrite", {"lines": [{"id": sp["id"], "quote": sp["quote"],
                                                "rewrite": self.plain_line(sp["quote"])} for sp in ctx["spots"]]}
        if "machine_ratings" in props:  # ✨ #20: does it sound machine-written? (a real quote, then an invented one)
            with self.lock:
                scripted = self.originality_script.pop(0) if getattr(self, "originality_script", None) else None
            if scripted is not None:
                return "originality", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            out = []
            for i, p in enumerate(ctx.get("passages") or []):
                q = next((s for s in self.sentences(str(p.get("text") or "")) if len(s) > 12), "")[:160]
                out.append({"passage_id": p["id"], "machine_score": 4 if i == 0 else 2,
                            "reasons": ["stock phrases" if i == 0 else "specific details"],
                            "quote": q if i == 0 else ("A line that is not in the book at all." if i == 1 else ""),
                            "rewrite": "Mara counted the boats." if i == 0 else ""})
            return "originality", {"machine_ratings": out, "summary": "Mostly human, a few stock phrases."}
        if "voice_summary" in props:  # ✒️ P25 (Section 7c): the author's style card
            return "style", self._style(ctx)
        if "scene_text" in props:  # 📏 P15: one scene of a long chapter
            return "scene_prose", self._scene_prose(ctx, props)
        if "continuation" in props:  # 📏 P15: expand a chapter far under its target
            return "expand", self._expand(ctx)
        if "book_scores" in props:  # 📊 P13: whole-book review
            with self.lock:
                scripted = self.book_review_script.pop(0) if self.book_review_script else None
            if scripted is not None:
                return "book_review", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "book_review", self._book_review(ctx, props)
        if "version_1" in props and "version_2" in props:  # ⚖️ P14: blind comparison
            with self.lock:
                scripted = self.compare_script.pop(0) if self.compare_script else None
            if scripted is not None:
                return "compare", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "compare", self._compare(ctx, props)
        if "scores" in props:  # 🖋 the AI editor (craft review)
            with self.lock:
                self.craft_contexts.append(ctx)
                scripted = self.craft_script.pop(0) if self.craft_script else None
            if scripted is not None:
                return "craft", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "craft", self._craft(ctx, list((props["scores"].get("properties") or {}).keys()))
        if "replacements" in props and ctx.get("findings") and all(
                f.get("dimension") == "planned_to_page" for f in ctx["findings"]):  # ✅ P11: work planned items in
            return "planned_rewrite", self._rewrite(ctx)
        if "replacements" in props and ctx.get("findings") and all(
                f.get("dimension") in ("terminology", "repetition") for f in ctx["findings"]):  # 🔎 P26/P30 fixes
            return "fact_rewrite", self._fact_rewrite(ctx)
        if "terms" in props and "chapter_text" in ctx:  # 🔧 P31: which trade facts to check
            with self.lock:
                scripted = self.terms_script.pop(0) if self.terms_script else None
            if scripted is not None:
                return "terms_find", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            import re  # noqa: PLC0415
            found = re.findall(r"\b[a-z]+-(?:key|cock|valve|pole)\b", ctx.get("chapter_text") or "")
            return "terms_find", {"terms": [{"term": t, "kind": "equipment", "question": f"How is a {t} used?"}
                                            for t in dict.fromkeys(found)][:5]}
        if "answers" in props and "terms" in ctx:  # 🔧 P31: research answers (advice)
            return "terms_research", {"answers": [
                {"id": t["id"], "verdict": "wrong" if "wick" in t["term"] else "plausible",
                 "answer": "Gas street lamps had no wick; the lamplighter opened the gas cock and lit the burner "
                           "with a lighting pole." if "wick" in t["term"] else "That fits the trade and the period.",
                 "use_instead": "lighting pole" if "wick" in t["term"] else ""} for t in ctx["terms"]]}
        if "replacements" in props:  # ✍ the writer reworks the flagged passages
            with self.lock:
                scripted = self.rewrite_script.pop(0) if self.rewrite_script else None
            if scripted is not None:
                return "rewrite", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "rewrite", self._rewrite(ctx)
        if "rules" in props and "notes" in props:  # 📏 the story-rules ledger (P9)
            with self.lock:
                scripted = self.rules_script.pop(0) if self.rules_script else None
            if scripted is not None:
                return "rules", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "rules", self._rules(ctx)
        if "texture" in props:  # 🧺 the world-texture list (P10)
            with self.lock:
                scripted = self.texture_script.pop(0) if self.texture_script else None
            if scripted is not None:
                return "texture", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "texture", {"texture": copy.deepcopy(TEXTURE)}
        if "items" in props and "planned" in ctx:  # ✅ the planned-to-page checker (P11)
            with self.lock:
                scripted = self.planned_script.pop(0) if self.planned_script else None
            if scripted is not None:
                return "planned", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "planned", self._planned(ctx)
        if "scenes" in props and "verdict" in props:  # 🎬 the light check of a scene plan (P8)
            with self.lock:
                v = self.scene_verdicts.pop(0) if self.scene_verdicts else "PASS"
            if isinstance(v, dict):
                return "scene_review", copy.deepcopy(v)
            n = len(ctx.get("scene_cards") or [])
            ok = v == "PASS"
            return "scene_review", {"verdict": v, "scenes": [{"scene": i + 1, "goal": True, "obstacle_from_world": ok,
                                                             "unsaid": True, "note": "" if ok else
                                                             "The fog is weather out of nowhere: use the harbour board."}
                                                            for i in range(n)],
                                    "notes": [] if ok else ["Let the obstacle come from the harbour board."]}
        if "scenes" in props:  # 🎬 the writer plans a chapter's scenes (P8)
            with self.lock:
                scripted = self.scene_script.pop(0) if self.scene_script else None
            out = (scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)) if scripted is not None \
                else self._scenes(ctx)
            if self.needs is not None and isinstance(out, dict) and "needs" not in out:  # 🧠 the chapter's needs list
                out["needs"] = self.needs(ctx) if callable(self.needs) else copy.deepcopy(self.needs)
            return "scenes", out
        if "character_sheet" in props and "concept" not in props:  # P7/P17 for an existing character
            name = (ctx.get("character") or {}).get("name") or "Someone"
            others = [o.get("name") for o in ctx.get("other_characters") or []]
            return "sheet", {"character_sheet": sheet_for(name, others, self._role(name)), "voice_card": voice_for(name)}
        if "verdict" in props:
            with self.lock:
                v = self.verdicts.pop(0) if self.verdicts else self.default_verdict
            if callable(v):  # a scripted answer that looks at what the reviewer was sent
                v = v(ctx)
            if isinstance(v, dict):  # a whole scripted review (H6: no reasons, low confidence, H3: limits …)
                return "review", dict({"verdict": "APPROVE", "reasons": [], "suggested_changes": [],
                                       "confidence": 0.8}, **v)
            if v == "APPROVE":
                return "review", {"verdict": v, "reasons": ["It fits the book profile and the plan."],
                                  "suggested_changes": [], "confidence": 0.8}
            with self.lock:  # 🔁 each REVISE asks for something different (the same finding twice = a loop)
                reason, change = REVISE_NOTES[self.revise_n % len(REVISE_NOTES)]
                self.revise_n += 1
            return "review", {"verdict": v, "reasons": [reason], "suggested_changes": [change], "confidence": 0.8}
        if "draft" in ctx and "review" in ctx:  # "Ask AI to fix it": the whole draft, one sentence revised
            data = json.loads(ctx["draft"]["data_json"])
            return "fix", self._revise(data)
        if {"title", "author", "genre", "audience", "tone", "idea"} <= set(props):
            w = ctx.get("wishes") or {}
            out = {"title": "The Keeper of Gullhaven", "author": "Rowan Ashby",
                   "genre": w.get("genre") or "Mystery", "audience": "Adult", "tone": "Cozy and eerie",
                   "idea": "When the Gullhaven lighthouse goes dark, apprentice keeper Mara Vell searches "
                           "the fog-bound harbor for her missing master. Every captain hides something, "
                           "and the only clue is a brass key that should not exist."}
            if "narrator_voice" in props and self.voice:  # ✍ the book's own narrator voice (folded in)
                out["narrator_voice"] = copy.deepcopy(self.voice)
            if "story_kind" in props and self.kind_pick:  # 📚 "Let the AI decide": the AI picks the kind
                out.update(story_kind=self.kind_pick, story_kind_why="A search across a strange, dangerous harbor "
                                                                     "for a lost master.")
            return "profile", out
        if "world_summary" in props:
            items = []
            for sec, n in (ctx.get("requested") or {}).items():
                for i in range(n):
                    names = NAMES.get(sec) or [f"{sec} item"]
                    name = names[i % len(names)] + ("" if i < len(names) else f" {i}")
                    links = [NAMES["A04"][0]] if sec == "A01" and "A04" in ctx.get("requested", {}) else []
                    item = {"section": sec, "name": name, "role": f"An important {sec} entry: {name}.",
                            "links": links}
                    if not self.no_roles:
                        item["story_role"] = (self._role(name) or STORY_ROLES.get(name, "supporting")) \
                            if sec == "A01" else ""
                    items.append(item)
            return "sketch", {"world_summary": "A fog-bound coast of lighthouses and fishing towns.", "items": items}
        if "concept" in props:  # Set A proposal (Bible Builder item)
            this = ctx.get("this_item") or {}
            sid = this.get("subject_id") or "entity"
            name = this.get("name") or "Entity"
            out = {"concept": name}
            if "attributes" in props:
                out["attributes"] = {k: f"{name}: {k.replace('_', ' ')} fitting the story."
                                     for k in (props["attributes"].get("properties") or {})}
            if "facts" in props:
                out["facts"] = [fact(sid, "entity.name", name)]
            if "character_sheet" in props and self.companion:
                others = [i.get("name") for i in ctx.get("builder_items") or [] if i.get("section") == "A01"]
                out["character_sheet"] = sheet_for(name, others, self._role(name, this.get("story_role")))
                out["voice_card"] = voice_for(name)
            with self.lock:
                breaks = self.canon_breaks.get(name)
                kind = breaks.pop(0) if breaks else None
            if kind and "facts" in out:
                self._break_canon(out, sid, kind)
            return "canon", out
        if "premise" in props:
            return "B01", {"premise": "An apprentice keeper searches a fog-bound harbor for her vanished master.",
                           "dramatic_question": "Will Mara bring the light back before the winter storms?",
                           "concept_summary": "A cozy, eerie coastal mystery."}
        if "main_plot" in props:
            return "B03", {"main_plot": {"summary": "Mara follows the keeper's trail from the dark lighthouse through "
                                                    "the harbor to the reef.", "facts": [], "links": []},
                           "objectives": [], "plot_obligations": list(self.plot_obligations)}
        if "chapters" in props:
            req = ctx.get("request_payload") or {}
            n = ((req.get("target_length") or {}).get("value")) or 3
            n = max(1, min(int(n), self.max_chapters))
            pov, loc = self._canon_ids(ctx)
            if self.pov_name:
                pov = self.pov_name
            objs = self.objectives or OBJECTIVES
            return "B11", {"chapters": [plan_item(f"ch{i + 1}", i, objs[i % len(objs)], pov, loc) for i in range(n)],
                           "unresolved_threads": []}
        if "objective_assessments" in props:
            req = ctx.get("request_payload") or {}
            cid = req.get("chapter_id") or "ch1"
            num = int(cid[2:]) if cid[2:].isdigit() else 1
            paras = CHAPTER_TEXT[((num - 1) % 3) + 1]
            if num > 3:  # chapters past the third get their own sentence (the content check refuses duplicates)
                paras = [p + f" That was night {num} of the search." for p in paras]
            text = self.chapter_texts.get(cid) or "\n\n".join(paras)
            fp = (ctx.get("writing_brief") or {}).get("first_page") or {}
            if self.use_first_page and fp.get("text"):  # ✍ the chapter starts from the chosen first page
                text = fp["text"] + "\n\n" + text
            return "C02", {"text": text,
                           "objective_assessments": [{"item_id": cid, "decision": "PASS", "message": "reached"}]}
        if "events" in props:
            return "events", {"events": []}
        if "tracked_scenes" in props and self.story_ledger:  # 📒 the chapter's story part (keyword reading)
            from akowe import story_ledger  # noqa: PLC0415
            story = story_ledger.extract(ctx.get("chapter_text") or "", ctx.get("characters") or [])
            return "track", {"tracked_scenes": [], "story": story}
        if "problems" in props and "checkpoint" in ctx:  # 🧭 a continuity checkpoint
            with self.lock:
                scripted = self.checkpoint_script.pop(0) if self.checkpoint_script else None
            if scripted is not None:
                return "checkpoint", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "checkpoint", self._checkpoint(ctx)
        return "generic", self._from_schema(schema)

    FIX_WORDS = [(r"\bran\b", "limped"), (r"\bdrew her knife\b", "reached for the knife she had lost, and found only "
                                                                 "the empty sheath")]

    def _checkpoint(self, ctx):
        """Confirms Akọwe's ledger flags (``confirm_flags``) with a small fix when one of FIX_WORDS fits the quote,
        plus ``checkpoint_extra`` problems of the chapters in this call."""
        import re  # noqa: PLC0415
        nums = {c.get("number") for c in ctx.get("chapters") or []}
        probs = []
        if self.confirm_flags:
            for f in ctx.get("akowe_flags") or []:
                q = f.get("quote") or ""
                rep = q
                for pat, new in self.FIX_WORDS:
                    rep = re.sub(pat, new, rep)
                probs.append({"chapter": f.get("number"), "quote": q, "problem": f.get("message") or "",
                              "original": q if rep != q else "", "replacement": rep if rep != q else ""})
        for x in self.checkpoint_extra:
            if x.get("chapter") in nums:
                probs.append(dict({"quote": "", "original": "", "replacement": ""}, **x))
        first = sorted(n for n in nums if isinstance(n, int))
        out = {"problems": probs, "summary": f"Chapters {first[0]}–{first[-1]}: Mara keeps searching." if first
               else ""}
        if ctx.get("stretch"):  # 📖 PR #117: the review of the stretch of chapters
            out["stretch_review"] = {"pacing": "It moves.", "arc": "Mara gets closer to the truth.", "drift": "None.",
                                     "direction": "It heads toward the lighthouse ending.",
                                     "sense": "Mara's choices add up.",
                                     "working": ["The harbour feels real"],
                                     "not_working": [f"Chapter {first[-1] if first else 1}: the harbour talk drags"],
                                     "scores": {"pacing": 7, "arc_progress": 7, "continuity": 8, "characters": 7,
                                                "direction": 8, "makes_sense": 7, "human": 6},
                                     # ✍ does it sound like a person? and Akọwe's repeat findings, confirmed
                                     "human": "Mostly a person's voice; the same gestures come back too often.",
                                     "human_quotes": [next((s for c in ctx.get("chapters") or []
                                                            for s in self.sentences(c.get("text") or "")
                                                            if len(s) > 20), "")][:1],
                                     "repeats": [{"id": f["id"], "verdict": "confirmed", "why": "A reader notices."}
                                                 for f in (ctx["stretch"].get("repeats_found") or [])]}
        return out

    PLAIN = (("a testament to", "proof of"), ("couldn't help but smile", "smiled"), ("a tapestry of", "a mess of"),
             ("let out a breath she didn't know she was holding", "breathed out"), ("jaw tightened", "jaw set"),
             ("let out a breath", "breathed out"))

    def plain_line(self, quote: str) -> str:
        """✍ A fake "plainer" rewrite: swaps the stock phrases it knows, else trims the line's last clause."""
        out = quote
        for a, b in self.PLAIN:
            out = out.replace(a, b)
        if out == quote:
            out = quote.rstrip(".") + ", and nothing more."
        return out

    def _details(self, ctx):
        out = {}
        for s in ctx.get("subjects") or []:
            for k in list(s.get("fields") or {}) + list(s.get("optional") or {}):
                field = k.split("__", 1)[1]
                text = self.details.get(field) or DETAILS.get(field) or f"{s.get('name')}: {field.replace('_', ' ')}"
                out[k] = text.replace("{name}", str(s.get("name") or ""))
        return out

    @staticmethod
    def _break_canon(out, sid, kind):
        if kind == "interval":
            out["facts"][0].update(effective_from=5, effective_to=2)
        elif kind == "authority":
            out["facts"].append(fact(sid, "entity.location_id", "nowhere-harbour"))
        elif kind == "schema":
            out["facts"].append({"subject_id": sid})

    def _scene_prose(self, ctx, props):
        sw = ctx.get("scene_writing") or {}
        req = ctx.get("request_payload") or {}
        cid = req.get("chapter_id") or "ch1"
        num = int(cid[2:]) if cid[2:].isdigit() else 1
        paras = CHAPTER_TEXT[((num - 1) % 3) + 1]
        i = int(sw.get("scene") or 1)
        card = sw.get("card") or {}
        body = paras[(i - 1) % len(paras)] + (f" At {card['place']} the {card.get('time') or 'hour'} pressed on."
                                               if card.get("place") else f" Scene {i} went on.")
        text = (f"# Part of {cid}\n\n" if sw.get("first") else "") + body
        out = {"scene_text": text}
        if "objective_assessments" in props:
            out["objective_assessments"] = [{"item_id": cid, "decision": "PASS", "message": "reached"}]
        return out

    def _expand(self, ctx):
        if not self.expand_text:
            return {"continuation": ""}
        n = int(ctx.get("words_so_far") or 0)
        return {"continuation": f"The night went on, and Mara counted the cost of every step she had taken so far: "
                                f"the oil, the herring, the hours at the sheds, the questions nobody answered "
                                f"({n} words in, she still had the brass key and no one to give it to)."}

    BOOK_DIMS_DEFAULT = 7

    def _beta(self, ctx):
        """P23: a deterministic beta read — confused in chapter 1 (a real quote), bored in the middle, a twist guessed
        in chapter 1 and revealed in the last chapter, and one invented quote."""
        chs = (ctx.get("book") or {}).get("chapters") or []
        n = max(1, len(chs))
        first = str(chs[0].get("text") or chs[0].get("opening") or "") if chs else ""
        q1 = next((s for s in self.sentences(first.split("\n", 1)[-1]) if len(s) > 20), "")[:160]
        who = (ctx.get("reader") or {}).get("who") or "typical"
        out = {"reactions": [{"chapter": 1, "kind": "confused", "quote": q1, "note": "Who wrote the last line?"},
                             {"chapter": 1, "kind": "hooked", "quote": q1, "note": "I want to know."},
                             {"chapter": n, "kind": "bored", "quote": "A sentence that is not in the book at all.",
                              "note": "Dragged."}],
               "interest": [{"chapter": i + 1, "score": 8 if i == 0 else 5, "would_keep_reading": True}
                            for i in range(n)],
               "guesses": [{"guess": "The key opens the lighthouse", "guessed_in_chapter": 1, "quote": q1,
                            "revealed_in_chapter": n, "came_true": "yes"}],
               "stop": {"would_finish": True, "chapter": 0, "why": ""},
               "overall": {"would_recommend": True, "favourite_character": "Mara", "best_chapter": 1,
                           "worst_chapter": n, "score": 7, "why": "Cosy and atmospheric."},
               "summary": "A cosy read; I guessed the key early."}
        # 👥 idea #14: the panel's other readers — the picky one agrees on chapter 1 (lost, twist guessed) and finds
        # chapter 2 slow; the casual one gets lost in chapter 1 too, is bored in chapter 2 and would stop there
        if who == "picky":
            out["reactions"] = out["reactions"][:1] + [{"chapter": min(2, n), "kind": "bored", "quote": "",
                                                        "note": "Seen this before."}]
            out["interest"] = [dict(i, score=3 if i["chapter"] == 2 else 6) for i in out["interest"]]
            out["overall"] = dict(out["overall"], would_recommend=False, score=4, best_chapter=n, worst_chapter=min(2, n))
            out["summary"] = "Competent but familiar; I saw the key coming."
        elif who == "casual":
            out["reactions"] = out["reactions"][:1]
            out["guesses"] = []
            out["interest"] = [dict(i, score=2 if i["chapter"] == 2 else 7,
                                    would_keep_reading=i["chapter"] != 2) for i in out["interest"]]
            out["stop"] = {"would_finish": False, "chapter": min(2, n), "why": "Too slow in the middle."}
            out["overall"] = dict(out["overall"], score=6, worst_chapter=min(2, n))
            out["summary"] = "Good start, then it slowed down."
        return out

    def _style(self, ctx):
        samples = ctx.get("samples") or []
        text = " ".join(str(s.get("text") or "") for s in samples)
        q = next((s for s in self.sentences(text) if len(s) > 20), "")[:160]
        return {"voice_summary": "Plain, wry first-person narration.", "rhythm": "short sentences, some long",
                "diction": "everyday words", "imagery": "kitchen and weather images", "narration": "first person, past",
                "do": ["Undercut big moments with a dry aside."], "avoid": ["Adverbs on dialogue tags."],
                "example_moves": [{"quote": q, "move": "a dry aside"},
                                  {"quote": "Not in the samples at all, this one.", "move": "invented"}]}

    def _book_review(self, ctx, props):
        dims = list((props["book_scores"].get("properties") or {}).keys())
        book = ctx.get("book") or {}
        chs = book.get("chapters") or []
        text = " ".join(str(c.get("text") or c.get("opening") or "") for c in chs)
        quote = (self.sentences(text) or [""])[0][:160]
        return {"book_scores": {d: (9 if d in ("atmosphere", "premise") else 5 if d in ("peril_uncertainty", "subtext")
                                    else 7) for d in dims},
                "strengths": [{"point": "The fog-bound harbour is vivid.", "quote": quote}],
                "weaknesses": [{"point": "Helpers hand Mara what she needs.", "quote": "Only old Nessa at the net sheds "
                                "would talk"}, {"point": "An invented line.", "quote": "This sentence is not in the "
                                                                               "book at all."}],
                "try_next": ["Let Nessa ask a real price."], "summary": "Atmospheric but too cooperative.",
                # P36: a quoted proof for each 9 (so the fake's whole-book review is trusted)
                "score_evidence": [{"dimension": d, "quote": quote, "why": "vivid"} for d in ("atmosphere", "premise")
                                   if d in dims]}

    def _compare(self, ctx, props):
        dims = list((props["version_1"].get("properties") or {}).keys())
        v1 = " ".join(str(c.get("text") or c.get("opening") or "") for c in (ctx.get("version_1") or {}).get(
            "chapters") or [])
        v2 = " ".join(str(c.get("text") or c.get("opening") or "") for c in (ctx.get("version_2") or {}).get(
            "chapters") or [])
        # deterministic: the longer version is "better" by one point everywhere
        better = "version_1" if len(v1) >= len(v2) else "version_2"
        s1 = {d: 7 + (1 if better == "version_1" else 0) for d in dims}
        s2 = {d: 7 + (1 if better == "version_2" else 0) for d in dims}
        return {"version_1": s1, "version_2": s2, "preferred": better,
                "reasons": [f"{better.replace('_', ' ').title()} has more concrete obstacles."]}

    def _scenes(self, ctx):
        ch = ctx.get("chapter") or {}
        num = int(ch.get("number") or 1)
        people = [c.get("name") for c in ctx.get("characters") or [] if c.get("name")] or ["Mara Vell"]
        pov = ch.get("pov") or people[0]
        other = next((p for p in people if p != pov), None)
        cast = [pov] + ([other] if other else [])
        fix = bool(ctx.get("review_notes"))
        tex = [t for t in ctx.get("world_texture") or [] if t.get("causes") == "obstacle"]
        scenes = []
        for i in range(2):
            scenes.append({"place": SCENE_PLACES[(num - 1 + i) % 3], "time": "dusk" if i else "before dawn",
                           "characters": cast,
                           "goals": [{"character": c, "goal": f"{c} wants the keeper's log" if c == pov else
                                      f"{c} wants payment for what they know",
                                      "hidden_agenda": f"{c} hides the stranger's letter"} for c in cast],
                           "obstacle": (tex[i % len(tex)]["detail"] if tex else
                                        "the harbour board has sealed the lamp room" if fix or i else
                                        "the evening tide floods the steps"),
                           "obstacle_source": "institution" if fix or i else "weather",
                           **({"texture": [tex[i % len(tex)]["id"]]} if tex else {}),
                           "change": f"{pov} learns who signed the log" if i else f"{pov} loses the lantern",
                           "unsaid": f"{pov} suspects her master left on purpose",
                           "beat": str(ch.get("objective") or "the chapter objective")[:120]})
        return {"scenes": scenes}

    @staticmethod
    def sentences(text):
        import re  # noqa: PLC0415
        return [x.strip() for x in re.findall(r"[^.!?]+[.!?]+", text or "") if x.strip()]

    def _craft(self, ctx, dims):
        text = ctx.get("chapter_text") or ctx.get("draft_json") or ""
        body = text.split("\n", 1)[1] if text.startswith("#") and "\n" in text else text
        flagged = []
        for s in self.sentences(body):
            for ph in self.editor_flags:
                if ph in s and s not in [f[0] for f in flagged]:
                    flagged.append((s, ph))
        first = (self.sentences(body) or [""])[0]
        scores = {d: 8 for d in dims}
        findings = []
        for i, (s, ph) in enumerate(flagged):
            scores["subtext"] = 4 if "subtext" in scores else scores.get("subtext")
            findings.append({"id": f"f{i + 1}", "dimension": "subtext" if "subtext" in dims else dims[0],
                             "severity": "major", "passage": s[:200],
                             "why": f"“{ph}” tells the reader what to think instead of showing it.",
                             "suggestion": "Show it through what the characters do.", "keep_nearby": []})
        # P17: two speakers the pattern report finds alike -> a voice_distinction finding quoting the line
        voices = ((ctx.get("pattern_report") or {}).get("voices") or {})
        for pair in voices.get("pairs") or []:
            if not pair.get("similar") or "voice_distinction" not in dims:
                continue
            import re  # noqa: PLC0415
            who = pair["b"].split()[0]
            m = re.search(r'[“"]([^”"]{8,200})[,.?!]?[”"],? ' + re.escape(who) + r'\b', body)
            if m:
                scores["voice_distinction"] = 4
                findings.append({"id": f"f{len(findings) + 1}", "dimension": "voice_distinction", "severity": "major",
                                 "passage": m.group(1)[:200],
                                 "why": f"With the names hidden this line of {pair['b']} sounds like {pair['a']}.",
                                 "suggestion": f"Let {pair['b']} say it in their own rhythm and words (voice card).",
                                 "keep_nearby": []})
                break
        # P9: a sentence that explains a protected mystery / states a belief as fact
        for s_ in self.sentences(body):
            for ph, dim in self.rule_flags.items():
                if ph in s_ and dim in dims and not any(f["passage"] == s_[:200] for f in findings):
                    scores[dim] = 3
                    findings.append({"id": f"f{len(findings) + 1}", "dimension": dim, "severity": "major",
                                     "passage": s_[:200], "why": "This breaks the story rules: "
                                     + ("it explains a protected mystery." if dim == "protected_mysteries" else
                                        "a belief is stated as confirmed fact."),
                                     "suggestion": "Keep it unexplained / keep it a belief.", "keep_nearby": []})
        scores = {k: v for k, v in scores.items() if v is not None}
        return {"scores": scores, "findings": findings, "keep": [first[:200]] if first else [],
                "verdict": "REVISE" if findings else "PASS"}

    def _rewrite(self, ctx):
        out = []
        for f in ctx.get("findings") or []:
            p = f.get("passage") or ""
            if f.get("dimension") == "ending_promises":  # 🎯 the open promise is added after the last paragraph
                if self.ending_fix:
                    out.append({"finding_id": f["id"], "original": p,
                                "replacement": p + " " + str(f.get("suggestion") or "").strip()})
                continue
            if f.get("dimension") == "planned_to_page":
                if self.planned_fix:
                    sug = str(f.get("suggestion") or "")
                    what = sug.split("): ", 1)[-1]
                    if "the name “" in what:
                        what = "Her name was " + what.split("the name “", 1)[1].split("”")[0]
                    what = what.strip().rstrip(".")
                    out.append({"finding_id": f["id"], "original": p,
                                "replacement": p + " " + what[:1].upper() + what[1:] + "."})
                continue
            ruled = next((ph for ph in self.rule_flags if ph in p and f.get("dimension") in ("story_rules",
                                                                                           "protected_mysteries")), None)
            if ruled:
                out.append({"finding_id": f["id"], "original": p, "replacement": p.replace(ruled, "nobody knew")})
                continue
            for ph, rep in self.editor_flags.items():
                if ph in p:
                    out.append({"finding_id": f["id"], "original": p, "replacement": p.replace(ph, rep)})
                    break
        return {"replacements": out}

    JOIN_LOWER = ("The", "She", "He", "It", "They", "Her", "His", "A", "An", "There", "Then")

    def _polish(self, ctx):
        """📏 Join the sentences of a reading-level passage; swap ``polish_swaps`` phrases in a repeat passage."""
        import re  # noqa: PLC0415
        out = []
        for f in ctx.get("findings") or []:
            p = f.get("passage") or ""
            new = p
            if f.get("dimension") == "reading_level":
                new = re.sub(r"\. ([A-Z][a-z]*)", lambda m: ", and " + (m.group(1).lower() if m.group(1) in
                                                                       self.JOIN_LOWER else m.group(1)), p)
            for ph, rep in self.polish_swaps.items():
                new = new.replace(ph, rep)
            if new != p:
                out.append({"finding_id": f["id"], "original": p, "replacement": new})
        return {"replacements": out}

    def _fact_rewrite(self, ctx):
        """P26: replace the flagged term (with its 'use:' text when given); P30: drop the repeated words."""
        out = []
        for f in ctx.get("findings") or []:
            p = f.get("passage") or ""
            if f.get("dimension") == "terminology":
                sug = str(f.get("suggestion") or "")
                term = sug.split("“", 1)[1].split("”", 1)[0] if "“" in sug else ""
                use = sug.split("(use: ", 1)[1].split(")", 1)[0].split(";")[0].strip() if "(use: " in sug else "pole"
                if term and term in p:
                    out.append({"finding_id": f["id"], "original": p, "replacement": p.replace(term, use, 1)})
            else:
                why = str(f.get("why") or "")
                ph = why.split("“", 1)[1].split("”", 1)[0] if "“" in why else ""
                if ph and ph in p:
                    rep = " ".join(p.replace(ph, "", 1).split())
                    rep = rep[:1].upper() + rep[1:] if rep else "It was so."
                    out.append({"finding_id": f["id"], "original": p, "replacement": rep})
        return {"replacements": out}

    def _rules(self, ctx):
        rules = copy.deepcopy(RULES)
        cur = ctx.get("current_rules")
        if cur:  # an update for the plan: keep the ids, change the seen effect's scope, add one rule
            by_text = {r["text"]: r["id"] for r in cur}
            for r in rules:
                r["id"] = by_text.get(r["text"], "")
                if r["category"] == "seen":
                    r["scope"] = "only on clear nights"
            rules.append({"id": "", "category": "hard_rule", "text": "The harbour board can seal a building for one "
                          "day only.", "scope": "one day; only buildings it inspected", "source": "the main plot",
                          "stated_by": "the canon"})
        return {"rules": rules, "notes": [] if cur else ["The seen effect has no limits yet."]}

    def _planned(self, ctx):
        text = ctx.get("chapter_text") or ""
        sents = self.sentences(text)
        out = []
        for it in ctx.get("planned") or []:
            what = str(it.get("what") or "")
            import re  # noqa: PLC0415
            ws = [w.lower() for w in re.findall(r"[A-Za-z]{5,}", what.replace("the name ", ""))]
            hit = next((x for x in sents if ws and sum(1 for w in ws if w in x.lower()) >= max(1, len(ws) // 2)), None)
            out.append({"id": it["id"], "on_page": bool(hit), "quote": (hit or "")[:200]})
        return {"items": out}

    def _role(self, name, given=None):
        """The story role this fake AI answers for a character (False = none at all)."""
        if self.no_roles:
            return False
        return self.role_override.get(name) or given or None

    def _canon_ids(self, ctx):
        pov, loc = "mara-vell", "gullhaven-harbor"
        for rec in (ctx.get("resolved_inputs") or {}).values():
            for f in ((rec or {}).get("data") or {}).get("facts") or []:
                if isinstance(f, dict) and f.get("predicate") == "entity.name":
                    if rec.get("module_id") == "A01":
                        pov = f["subject_id"]
                    if rec.get("module_id") == "A04":
                        loc = f["subject_id"]
        mc = ctx.get("main_character") or {}
        if mc.get("pov_id"):  # ★ the outline follows the book's main character (as a real AI is told to)
            pov = mc["pov_id"]
        return pov, loc

    @staticmethod
    def _alongside(ctx):
        """✍ A deterministic suggestion per action (third person, past tense, like the fake chapters)."""
        p = str(ctx.get("passage") or "").strip()
        act = ctx.get("action")
        if act == "continue":
            t = "Mara stepped onto the wet boards of the jetty. The lamp behind her hissed, and the fog closed in."
        elif act == "tighten":
            t = (p.split(". ")[0].rstrip(".") + ".") if ". " in p else " ".join(p.split()[:max(3, len(p.split()) // 2)])
        elif act == "describe":
            t = p + " Salt stung her lips, the planks were cold and slick under her hands, and a gull cried somewhere."
        elif act == "expand":
            t = p + " She waited, counting her breaths, while the tide pulled at the pilings below."
        else:
            note = str(ctx.get("author_note") or "")
            t = ("Her heart hammered. " if "tense" in note else "") + p.replace(" and ", ", and then ", 1) + \
                ("" if "tense" in note else " (said again)")
        return {"text": t, "why": f"fake {act}"}

    @staticmethod
    def _revise(data):
        data = copy.deepcopy(data)
        for key in ("text", "premise", "concept_summary"):
            if isinstance(data.get(key), str):
                data[key] = data[key].rstrip() + (" The harbor was called Gullhaven." if key == "text" else
                                                  " (revised)")
                return data
        if isinstance(data.get("main_plot"), dict) and isinstance(data["main_plot"].get("summary"), str):
            data["main_plot"]["summary"] += " (revised)"
            return data
        if isinstance(data.get("attributes"), dict):
            for k, v in data["attributes"].items():
                if isinstance(v, str):
                    data["attributes"][k] = v + " (revised)"
                    break
        return data

    def _from_schema(self, schema):
        def gen(s):
            if not isinstance(s, dict):
                return None
            t = s.get("type")
            if "enum" in s:
                return s["enum"][0]
            if t == "object" or "properties" in s:
                return {k: gen(v) for k, v in (s.get("properties") or {}).items() if k in (s.get("required") or [])}
            if t == "array":
                return []
            if t == "string":
                return "text"
            if t in ("integer", "number"):
                return 0
            if t == "boolean":
                return False
            return None
        return gen(schema)
