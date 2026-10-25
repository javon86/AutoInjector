"""The first real book lost its main character: the profile idea named "Odile Marsh", the Bible Builder proposed her,
Akọwe's own checks refused her entry, and the run went on with the side characters only (the outline had no POV
ID for her, the writer and the editor drifted). These tests reproduce each way a proposed character could silently not
reach approved canon, with the fake AI, and prove the fix:

(a) an entry Akọwe's checks refuse (its form, its save, or VALIDATE) is made again with the exact problems, under
    the same name, at most twice; what still fails is named in an event (CANON_ENTRY_REFUSED);
(b) before the outline the run checks that the main character (named in the idea / proposed as main / needed as a
    viewpoint) is approved canon, makes the entry when it is not, and otherwise stops with PROTAGONIST_MISSING;
(c) the guided path's chapter-outline step shows the missing character with a one-click "make it".
"""
from __future__ import annotations

import time
import types

import pytest

from akowe import assist as assist_mod
from akowe import protagonist
from akowe import providers as prov_mod
from akowe.book_path import BookPath, save_profile

import autobook_fake
from autobook_fake import BookFakeAI, fact
from test_autobook import FAKE_KEY, make_app
from test_autobook import run_book as _run_book


def run_book(app, body=None):
    run = _run_book(app, body)
    return dict(run, _full=app.autobook.get(run["id"]))  # every event (the public view keeps the last 60)


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def approved_names(app, run):
    bp = BookPath(app.engine, "author", run["project_id"], "main")
    return sorted(protagonist.record_names(r)[0] for r in bp.approved("A01"))


def events(run, code=None, kind=None):
    run = run.get("_full") or run
    return [e for e in run["events"] if (code is None or e.get("code") == code) and (kind is None or e["kind"] == kind)]


def canon_requests(fake, name):
    """The author_request text of every character proposal the fake AI was asked for, for this name."""
    return [ctx.get("author_request") or "" for _s, ctx in fake.prompts.get("canon", [])
            if (ctx.get("this_item") or {}).get("name") == name]


# ---------------------------------------------------------------------------------------------- names in the idea
def test_names_in_the_idea_are_people_not_places_or_titles():
    idea = ("Odile Marsh is the last lamplighter of Vell Harbour. When The Lamplighter's Last Ferry stops running, "
            "she and Captain Corvin Haske must cross the bay before the gas fails.")
    assert protagonist.names_in_idea(idea) == ["Odile Marsh", "Corvin Haske"]
    fake_idea = ("When the Gullhaven lighthouse goes dark, apprentice keeper Mara Vell searches the fog-bound harbor "
                 "for her missing master. Every captain hides something.")
    assert protagonist.names_in_idea(fake_idea) == ["Mara Vell"]
    assert protagonist.same_person("Odile Marsh", "Odile") and not protagonist.same_person("Odile Marsh", "Tamsin Reed")


def test_a_refused_outline_pov_names_the_missing_viewpoint_character():
    class Stub:
        pid, branch, profile = "p", "main", {"idea": ""}

        def approved(self, op):
            return [{"data": {"concept": "Tamsin Reed", "facts": [fact("tamsin-reed", "entity.name", "Tamsin Reed")]}}] \
                if op == "A01" else []

        def heads(self, op):
            return [{"module_id": "B11", "record_id": "b11", "lifecycle": "DRAFT", "findings": [
                {"rule_id": "CANON_UNRESOLVED", "message": "/chapters/0/facts/5: plan.pov_id 'odile-marsh' is not "
                 "declared by any pinned A01 canon record"}]}] if op == "B11" else []

        def records(self):
            return []
    miss = protagonist.missing(Stub())
    assert [(m["name"], m["why"]) for m in miss] == [("Odile Marsh", protagonist.POV_WHY)]


# ---------------------------------------------------------------------------------------------- (a) refused entries
def test_reproduce_and_fix_a_proposal_that_does_not_fit_the_form(tmp_path):
    """The protagonist's proposal fails the form twice (the AI's own re-ask included): before the fix it was dropped
    silently and the run went on with the side characters; now the AI is told the exact problems and makes it again."""
    fake = BookFakeAI()
    fake.canon_breaks = {"Mara Vell": ["schema", "schema"]}
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    assert "Mara Vell" in approved_names(app, run)
    fixes = events(run, "CANON_ENTRY_REFUSED", "fix")
    assert fixes and "Mara Vell" in fixes[0]["message"] and "SCHEMA" in fixes[0]["message"]
    asks = canon_requests(fake, "Mara Vell")
    assert any("Akọwe's checks refused your previous proposal" in a and "SCHEMA" in a for a in asks)
    # the outline found her: no CANON_UNRESOLVED viewpoint, nothing for the guard to make
    assert not events(run, "PROTAGONIST_MISSING")


def test_reproduce_and_fix_an_entry_validate_refuses(tmp_path):
    """VALIDATE refuses the protagonist (a home place no pinned A04 declares). Before the fix the AI made "a new
    character" from a fresh sketch, the old name counted as taken (the set-aside draft), so she was replaced by
    someone else. Now the same character is made again, told what was refused."""
    fake = BookFakeAI()
    fake.canon_breaks = {"Mara Vell": ["authority"]}
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    names = approved_names(app, run)
    assert "Mara Vell" in names and not any(n.startswith("Character") for n in names), names
    asks = canon_requests(fake, "Mara Vell")
    assert len(asks) == 2 and "LINKED_AUTHORITY" in asks[1] and "keep exactly this name" in asks[1]


def test_reproduce_and_fix_an_entry_the_save_refuses(tmp_path, monkeypatch):
    """The save (CREATE) refuses the protagonist (a fact interval); before the fix: "1 entry could not be saved and
    was skipped". Now the AI gets the save's exact problem and the entry is made again."""
    real = assist_mod.AssistService.dry_check

    def blind(self, *a, **kw):  # the proposal check misses it, so only the save refuses it
        return [f for f in real(self, *a, **kw) if f["rule_id"] != "FACT_INTERVAL"]
    monkeypatch.setattr(assist_mod.AssistService, "dry_check", blind)
    fake = BookFakeAI()
    fake.canon_breaks = {"Mara Vell": ["interval"]}
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    assert "Mara Vell" in approved_names(app, run)
    fix = [e for e in events(run, "CANON_ENTRY_REFUSED", "fix") if "refused to save" in e["message"]]
    assert fix and "effective" in fix[0]["message"]
    assert any("effective" in a for a in canon_requests(fake, "Mara Vell")[1:])


# ---------------------------------------------------------------------------------------------- (b) the guard
def test_guard_stops_the_run_naming_the_character_then_try_again_makes_her(tmp_path):
    fake = BookFakeAI()
    fake.canon_breaks = {"Mara Vell": ["schema"] * 40}
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "paused"
    prob = run["problem"]
    assert prob["code"] == "PROTAGONIST_MISSING" and prob["character"] == "Mara Vell"
    assert "Mara Vell" in prob["message"] and "named in the book idea" in prob["message"]
    assert "SCHEMA" in prob["message"] and prob["details"] and prob["options"] == ["retry"]
    # never went on silently: no premise, plot or outline was written without her
    assert not {"B01", "B03", "B11"} & set(fake.kinds)
    assert events(run, "CANON_ENTRY_REFUSED", "note")  # the dropped entry was named
    # 🔁 Try again (the AI now gets it right): the run makes her and finishes the book
    fake.canon_breaks = {}
    app.autobook.decide("author", run["id"], {"action": "retry"})
    app.autobook.wait_for(run["id"], 120)
    run = dict(app.autobook.public(app.autobook.get(run["id"])), _full=app.autobook.get(run["id"]))
    assert run["status"] == "done", run.get("problem")
    assert "Mara Vell" in approved_names(app, run)
    assert fake.kinds.index("B11") > max(i for i, k in enumerate(fake.kinds) if k == "canon")


def test_guard_makes_the_idea_s_main_character_the_bible_builder_never_proposed(tmp_path, monkeypatch):
    monkeypatch.setitem(autobook_fake.NAMES, "A01", ["Tom Reed", "Nessa Crane", "Ilse Marrow"])
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    assert "Mara Vell" in approved_names(app, run)
    note = events(run, "PROTAGONIST_MISSING", "note")
    assert note and "Mara Vell" in note[0]["message"]
    ask = canon_requests(fake, "Mara Vell")
    assert ask and "main character" in ask[0]
    # made with the canon, before the premise and the outline were planned
    assert fake.kinds.index("B01") > max(i for i, k in enumerate(fake.kinds) if k == "canon")


# ---------------------------------------------------------------------------------------------- (c) the guided path
def test_guided_outline_step_warns_and_one_click_makes_the_character(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    app.engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic", "api_key": FAKE_KEY})  # the AI is ready
    pid = app.engine.bootstrap_project("author", "Lamplighter")
    save_profile(app.store, pid, {"title": "The Lamplighter's Last Ferry", "length": "short_story",
                                  "idea": "Odile Marsh is the last lamplighter of Vell Harbour."})
    bp = BookPath(app.engine, "author", pid, "main")
    cand = {"concept": "Tamsin Reed", "attributes": {}, "linked_refs": [], "protected_fact_flags": [],
            "facts": [fact("tamsin-reed", "entity.name", "Tamsin Reed")]}
    ref, _ = bp.create("A01", {"concept": "Tamsin Reed"}, manual_candidate=cand)
    assert bp.act("approve", {"record_ids": [ref["record_id"]], "author_confirms": True})["results"][0]["ok"]
    outline = {s["id"]: s for s in BookPath(app.engine, "author", pid, "main").status()["steps"]}["outline"]
    assert [(m["name"], m["why"], m["draft"]) for m in outline["missing_characters"]] == \
        [("Odile Marsh", protagonist.IDEA_WHY, None)]
    out = app.book_act("author", pid, "main", "make_character", {"name": "Odile Marsh"})
    assert out["ok"] and out["created"]["module_id"] == "A01", out
    rec = app.store.get_record(pid, "main", out["created"]["record_id"], out["created"]["version"])
    assert rec["lifecycle"] == "DRAFT" and protagonist.record_names(rec)[0] == "Odile Marsh"  # a draft, never approved
    outline = {s["id"]: s for s in out["book"]["steps"]}["outline"]
    assert outline["missing_characters"][0]["draft"]["record_id"] == rec["record_id"]  # waits for the author
    assert "main character" in canon_requests(fake, "Odile Marsh")[0]
    BookPath(app.engine, "author", pid, "main").act("approve", {"record_ids": [rec["record_id"]],
                                                                "author_confirms": True})
    outline = {s["id"]: s for s in BookPath(app.engine, "author", pid, "main").status()["steps"]}["outline"]
    assert outline["missing_characters"] == []
    # nothing to make for a character who is already there
    again = app.book_act("author", pid, "main", "make_character", {"name": "Odile Marsh"})
    assert again["ok"] and "created" not in again
