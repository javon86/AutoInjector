"""🚀 A stand-in AI for the launch kit (tests/test_launch_kit.py and the UI test): SlotFake (the book) plus the two
launch-kit answers — the listing (``akowe_task: launch_kit``) and the AI check (``akowe_task: launch_check``). Both
can be scripted (dicts, or callables(ctx)); the default listing uses only the names and plan the context gives."""
from __future__ import annotations

import copy

from test_failover_review import SlotFake


def good_listing(ctx: dict) -> dict:
    names = [c["name"] for c in ctx.get("canon") or [] if c["kind"] == "character"] or ["the keeper"]
    places = [c["name"] for c in ctx.get("canon") or [] if c["kind"] == "place"] or ["the harbor"]
    hero, place = names[0], places[0]
    pen = (ctx.get("book") or {}).get("pen_name") or "the author"
    para = (f"Fog lies over {place}, and the old lighthouse has gone dark. Apprentice keeper {hero} climbs the "
            "steps to find the lamp cold and her master gone, with only a logbook and a line in a hand she does not "
            "know. Every captain in the harbor has a story, and every story has a hole in it. The winter storms are "
            "coming, and without the light the boats will not find their way home. ")
    short = para + (f"To bring the light back, {hero} must question the people she has known all her life, and "
                    "decide who is lying to protect a friend and who is lying to protect themselves. A cozy, eerie "
                    "mystery about loyalty, courage and the small lights we keep burning for each other, perfect "
                    "for readers who love a quiet harbor town with secrets under every roof and a stubborn heroine "
                    "who will not stop asking questions until she knows what happened to the man who taught her "
                    "everything she knows about the sea and the lamp.")
    long_ = "\n\n".join([para.strip(), short.split(para, 1)[1].strip(),
                         ("The harbor is small, and everyone in it knows everyone else. The fishermen mend their nets "
                          "and look away. The innkeeper pours another cup and changes the subject. The fog comes "
                          "in every morning and leaves every evening, and between the two the town keeps its own "
                          "counsel, as it always has, as it always will, unless someone makes it talk."),
                         (f"{hero} is not a detective. She is a keeper, and a keeper's work is to watch, to wait, "
                          "and to notice what has changed. Now she must use every one of those skills on the people "
                          "she loves, before the storms close the harbor for the winter and the trail goes cold "
                          "with the sea. A warm and haunting story of a town, a lamp and one young woman who "
                          "refuses to let the dark win, told with gentle humor, real danger and a heart as steady "
                          "as the beam of a lighthouse on a long night when every boat is still out.")])
    pics = [p["key"] for p in ctx.get("pictures") or []]
    out = {"blurb_short": short, "blurb_long": long_,
           "hook": f"When the lighthouse goes dark, {hero} has until the winter storms to find out who put it out.",
           "author_bio": (f"{pen} writes cozy mysteries with a chill in the air. When not writing, {pen} is "
                          "[what you do when you are not writing] and lives in [where you live]. This is "
                          f"{pen}'s first mystery set by the sea, and there are more on the way for readers who "
                          "like a warm cup and a cold wind."),
           "keywords": ["cozy lighthouse mystery", "small harbor town secrets", "amateur sleuth heroine",
                        "foggy coastal village", "missing mentor mystery", "eerie seaside cozy",
                        "apprentice keeper story"],
           "categories": list((ctx.get("category_choices") or [])[:3]),
           "comps": [{"title": "The Thursday Murder Club", "author": "Richard Osman", "why": "a warm, funny "
                      "community of sleuths"},
                     {"title": "The Lighthouse Witches", "author": "C.J. Cooke", "why": "an eerie coast and a "
                      "lighthouse with secrets"},
                     {"title": "Death at the Seaside", "author": "Frances Brody", "why": "a cozy seaside mystery"}],
           "aplus": [{"headline": f"Welcome to {place}", "text": f"A small harbor where the fog keeps its secrets "
                      f"and {hero} keeps the light.", "image": pics[0] if pics else ""},
                     {"headline": f"Meet {hero}", "text": "An apprentice keeper who notices what has changed.",
                      "image": pics[1] if len(pics) > 1 else ""},
                     {"headline": "A cozy, eerie mystery", "text": "Gentle humor, real danger and a heart as steady "
                      "as the lamp.", "image": ""}]}
    return {f: out[f] for f in ctx.get("fields") or out}


class LaunchFake(SlotFake):
    def __init__(self, **kw):
        super().__init__(**kw)
        self.launch_script: list = []
        self.check_script: list = []
        self.launch_contexts: list = []

    def _answer(self, ctx, props, schema):
        task = ctx.get("akowe_task")
        if task == "launch_kit":
            with self.lock:
                self.launch_contexts.append(copy.deepcopy(ctx))
                s = self.launch_script.pop(0) if self.launch_script else None
            if s is not None:
                out = s(ctx) if callable(s) else copy.deepcopy(s)
                return "launch_kit", {f: out.get(f, good_listing(ctx).get(f)) for f in ctx["fields"]}
            return "launch_kit", good_listing(ctx)
        if task == "launch_check":
            with self.lock:
                self.launch_contexts.append(copy.deepcopy(ctx))
                s = self.check_script.pop(0) if self.check_script else None
            if s is not None:
                return "launch_check", s(ctx) if callable(s) else copy.deepcopy(s)
            return "launch_check", {"issues": []}
        return super()._answer(ctx, props, schema)
