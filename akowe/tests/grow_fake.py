"""A deterministic fake AI for 📖 Grow my start into a novel (grow_novel.py): the stock Make-a-book fake
(autobook_fake.BookFakeAI) plus the grow flow's own three requests — the reading of the author's chapters
(``chapter_summaries``: story, cast with quoted looks, places, world, story rules with a STRUCTURED magic rule, open
threads), the voices + style request (``voices``: voice cards from the characters' real lines, the narrator's style
with one quote from the prose and one that is not in it) and the plan of the rest (``how_many`` / ``from_chapter``).
"""
from __future__ import annotations

import copy

from autobook_fake import BookFakeAI, voice_for

# The author's own opening: two chapters with a magic system (blinking costs tide-stones)
OPENING = [
    ("Chapter One: The Dark Light",
     ["Mara Vell climbed the hundred steps of the old light at Gullhaven Harbor. Her green eyes stung in the salt "
      "wind, and the lamp above her was dark for the first time in forty years.",
      "\"Who signed the log?\" Mara asked. Tom Reed only shook his head and said, \"Not a keeper's hand, girl. Not "
      "one I know.\"",
      "In her coat she carried three tide-stones, smooth and grey, the only things her master had left her."]),
    ("Chapter Two: The Blink",
     ["At the harbour wall Mara held two tide-stones in her fist and blinked across the water to the net sheds. "
      "The stones crumbled to sand, and her nose bled onto her collar.",
      "\"Mind yourself,\" said Nessa Crane, gutting knife in hand. \"Talk costs a herring, love.\"",
      "Nessa would say only that the keeper had gone out to the reef with a stranger, and that only the stranger "
      "came back. Mara had one tide-stone left."]),
]

UNDERSTOOD = {
    "title": "The Keeper's Stones", "genre": "Fantasy mystery", "audience": "Adult", "tone": "Eerie and warm",
    "premise": "When the Gullhaven light goes dark, apprentice Mara Vell uses her last tide-stones to find out what "
               "happened to her master on the reef.",
    "dramatic_question": "Will Mara learn the truth about the reef before her tide-stones run out?",
    "concept": "A coastal mystery with a costly gift.",
    "story_kind": "quest", "story_kind_why": "A search for a lost master.",
    "chapter_summaries": [{"number": 1, "summary": "Mara climbs the dark lighthouse and finds a stranger's hand in "
                                                   "the log."},
                          {"number": 2, "summary": "Mara blinks across the harbour with two tide-stones and learns "
                                                   "about the stranger on the reef."}],
    "characters": [
        {"name": "Mara Vell", "story_role": "protagonist", "about": "The apprentice keeper.",
         "wants": "To find her master.", "fear": "Being left alone with the dark light.", "secret": "",
         "looks": {"eyes": {"value": "Green eyes.", "quote": "Her green eyes stung in the salt wind"},
                   "hair": {"value": "Dark hair, maybe.", "quote": "a quote that is not in the chapters"},
                   "physique": {"value": "", "quote": ""}, "face": {"value": "", "quote": ""},
                   "skin": {"value": "", "quote": ""}, "markings": {"value": "", "quote": ""},
                   "clothing": {"value": "A coat with deep pockets.", "quote": ""},
                   "posture": {"value": "", "quote": ""}}},
        {"name": "Tom Reed", "story_role": "mentor", "about": "The old keeper of the harbour lamp.",
         "wants": "To keep the harbour safe.", "fear": "The reef.", "secret": "He knows who signed the log.",
         "looks": {}},
        {"name": "Nessa Crane", "story_role": "ally", "about": "A fish-gutter at the net sheds who sells answers.",
         "wants": "A fair price.", "fear": "", "secret": "She saw the stranger.", "looks": {}},
    ],
    "places": [{"name": "Gullhaven Harbor", "about": "A fog-bound harbour town."},
               {"name": "The Old Light", "about": "The lighthouse above the harbour."}],
    "world": {"name": "The Grey Coast", "about": "A cold coast of lighthouses where a few people can blink."},
    "rules": [
        {"category": "hard_rule", "text": "Blinking carries a person across open water and uses up tide-stones.",
         "scope": "across water only; costs stones", "source": "chapter 2", "stated_by": "the narrator",
         "magic": {"name": "Blinking", "does": "Carries the user across open water in an instant.",
                   "requires": ["2 tide-stones"], "limits": ["3 times a day"], "price": "a nosebleed",
                   "who": "Mara Vell", "exceptions": "", "start": "Mara Vell: 3 tide-stones"}},
        {"category": "mystery", "text": "Who the stranger on the reef was.", "scope": "", "source": "chapter 2",
         "stated_by": "Nessa Crane"},
        {"category": "belief", "text": "Harbour folk believe the drowned keepers guide the light.", "scope": "",
         "source": "chapter 1", "stated_by": "Tom Reed"},
    ],
    "open_threads": ["Who signed the log?", "What happened on the reef?"],
}


class GrowFakeAI(BookFakeAI):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.understood = copy.deepcopy(UNDERSTOOD)
        self.plan_contexts: list[dict] = []
        self.understand_contexts: list[dict] = []
        self.voice_contexts: list[dict] = []

    def _answer(self, ctx, props, schema):
        kind, out = self._grow(ctx, props, schema)
        if kind.startswith("grow"):  # the real AIs' answers are checked against the schema: so are the fake's
            import jsonschema  # noqa: PLC0415
            jsonschema.validate(out, schema)
        return kind, out

    def _grow(self, ctx, props, schema):
        if "chapter_summaries" in props:  # 📖 the reading of the author's chapters
            self.understand_contexts.append(ctx)
            return "grow_understand", copy.deepcopy(self.understood)
        if "voices" in props and "narration" in ctx:  # 📖 voice cards from real lines + the narrator's style
            self.voice_contexts.append(ctx)
            voices = []
            for c in ctx.get("characters") or []:
                v = voice_for(c["name"])
                v["samples"] = ["A line nobody on the page ever said."]
                voices.append({"name": c["name"], "voice_card": v})
            return "grow_voices", {"voices": voices, "style": {
                "voice_summary": "Plain, salt-worn close third person.", "rhythm": "Short sentences, then a long one.",
                "diction": "Working words of the sea.", "imagery": "Weather and stone.", "narration": "Close third.",
                "do": ["Name the work of hands"], "avoid": ["Explaining feelings"],
                "example_moves": [{"move": "Ends a paragraph on an object", "quote": "smooth and grey, the only things "
                                                                                      "her master had left her"},
                                  {"move": "An invented move", "quote": "words the author never wrote here"}]}}
        if "how_many" in ctx and "from_chapter" in ctx and "main_plot" in props:  # 📖 the plan of the rest
            self.plan_contexts.append(ctx)
            k, start = int(ctx["how_many"]), int(ctx["from_chapter"])
            return "grow_plan", {
                "premise": ctx.get("premise") or "", "dramatic_question": ctx.get("dramatic_question") or "",
                "main_plot": "Mara climbs the dark light, blinks across the harbour, then follows the stranger's "
                             "trail to the reef and lights the lamp again.",
                "ending": "Mara relights the lamp; the stranger stays a mystery.",
                "setups": ["Who signed the log?"],
                "chapters": [{"title": f"Chapter {start + i}", "objective": f"Mara follows the stranger's trail "
                              f"toward the reef (step {i + 1}).", "pov": "Mara Vell",
                              "place": "Gullhaven Harbor"} for i in range(k)]}
        return super()._answer(ctx, props, schema)


def opening_text(headings: bool = True) -> str:
    out = []
    for title, paras in OPENING:
        if headings:
            out.append(title)
        out.extend(paras)
    return "\n\n".join(out)
