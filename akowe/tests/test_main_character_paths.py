"""★ Every way a book could end up without its main character (a proper A01 entry tagged protagonist), each
reproduced with the fake AI and fixed at its root; plus the run's guarantee step (before the chapters are written and
before the book is marked done: exactly one protagonist, an approved A01 entry, in the outline and in every chapter
brief — repaired automatically, else a plain-words pause; never a finished book without one).

Causes covered here (see docs/AKOWE_IMPROVEMENT_PLAN.md, "Main character: root-cause hunt"):
 1. the main character only MENTIONED in another record's facts (a place's fact about her, a friend's relationship
    fact) counted as "already in the canon" / "a place", so no entry was ever made for her;
 2. the Bible Builder's name check used those mentioned names too: the world sketch's main character became a
    placeholder ("Character 1", an invented stranger) — and a real duplicate kept the protagonist claim;
 3. the world sketch's count limit cut the protagonist off when the AI listed her after the others;
 4. Akọwe's own fallback guess ("the first character made", tag ``resolved``) beat the main character named in the
    idea when she was made later, so she was made but never tagged ★;
 5. a book with no claims at all made the villain (first created) the main character;
 6. non-Latin names (Cyrillic, Greek) never matched anything (the name matcher kept only a-z), so an approved
    main character counted as missing again and again; accented names lost letters in their subject IDs;
 7. a chapter outline whose viewpoint character is not in the canon (CANON_UNRESOLVED "plan.pov_id … is not
    declared") was rewritten until the run paused: the viewpoint character is now made (and pinned) first;
 8. a book bible / sequel whose ★ main character could not be put into the new book lost her silently;
 9. the chapter brief never named the book's main character;
10. nothing checked the main character again before the book was marked done.
"""
from __future__ import annotations

import time
import types

import pytest

from akowe import assist as assist_mod
from akowe import chapter_brief
from akowe import characters as chars_mod
from akowe import names
from akowe import protagonist
from akowe import providers as prov_mod
from akowe import story_roles
from akowe.assist import BibleSession
from akowe.book_path import BookPath, save_profile

import autobook_fake
from autobook_fake import BookFakeAI, fact
from test_autobook import make_app
from test_autobook import run_book as _run_book


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def run_book(app, body=None):
    run = _run_book(app, body)
    return dict(run, _full=app.autobook.get(run["id"]))


def events(run, code=None, kind=None):
    run = run.get("_full") or run
    return [e for e in run["events"] if (code is None or e.get("code") == code) and (kind is None or e["kind"] == kind)]


def prot_name(app, run):
    p = story_roles.protagonist_of(app.store, run["project_id"], "main")
    return p and p["name"]


def tagged_name(app, run):
    rid = story_roles.tagged_protagonist(app.store, run["project_id"], "main")
    c = next((c for c in chars_mod.canon_characters(app.store, run["project_id"], "main") if c["record_id"] == rid),
             None)
    return c and c["name"]


def approved_names(app, run):
    bp = BookPath(app.engine, "author", run["project_id"], "main")
    return sorted(chars_mod._name_and_subject(r)[0] for r in bp.approved("A01"))  # noqa: SLF001


class MentionFake(BookFakeAI):
    """A fake AI whose place entries speak about people (a resident, the keeper) by name and subject ID, as a real AI
    does: ``mentions`` maps an entry name -> [(subject_id, name)] facts added to its proposal."""

    def __init__(self, mentions, **kw):
        super().__init__(**kw)
        self.mentions = mentions

    def _answer(self, ctx, props, schema):
        kind, out = super()._answer(ctx, props, schema)
        if kind == "canon" and isinstance(out.get("facts"), list):
            for sid, nm in self.mentions.get(out.get("concept"), []):
                out["facts"].append(fact(sid, "entity.name", nm))
        return kind, out


def _book(tmp_path, idea="Mara Vell keeps the Gullhaven light.", fake=None):
    app = make_app(tmp_path, fake=fake or BookFakeAI())
    pid = app.engine.bootstrap_project("author", "Gullhaven")
    save_profile(app.store, pid, {"title": "The Keeper", "length": "short_story", "idea": idea})
    return app, pid, BookPath(app.engine, "author", pid, "main")


def _approve(bp, op, name, extra_facts=(), sid=None):
    sid = sid or "-".join(names.tokens(name)) or "x"
    cand = {"concept": name, "attributes": {}, "linked_refs": [], "protected_fact_flags": [],
            "facts": [fact(sid, "entity.name", name)] + [fact(s, "entity.name", n) for s, n in extra_facts]}
    ref, _ = bp.create(op, {"concept": name}, manual_candidate=cand)
    assert bp.act("approve", {"record_ids": [ref["record_id"]], "author_confirms": True})["results"][0]["ok"]
    return ref["record_id"]


# ============================================================================ 1. mentioned only in other records
def test_main_character_mentioned_only_in_other_records_is_still_missing(tmp_path):
    app, pid, bp = _book(tmp_path)
    _approve(bp, "A04", "Gullhaven Harbor", [("mara-vell", "Mara Vell")])  # the harbour's keeper, by name
    _approve(bp, "A01", "Tom Reed", [("mara-vell", "Mara Vell")])  # Tom's apprentice, by name
    miss = protagonist.missing(bp, store=app.store)
    assert [(m["name"], m["why"]) for m in miss] == [("Mara Vell", protagonist.IDEA_WHY)]


def test_make_a_book_makes_the_idea_s_main_character_a_place_only_mentions(tmp_path, monkeypatch):
    """The sketch never proposes Mara; the harbour entry speaks about her. Before the fix she counted as "a place of
    the canon" and the book was made with Tom as its main character."""
    monkeypatch.setitem(autobook_fake.NAMES, "A01", ["Tom Reed", "Nessa Crane", "Ilse Marrow"])
    fake = MentionFake({"Gullhaven Harbor": [("mara-vell", "Mara Vell")]})
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    assert "Mara Vell" in approved_names(app, run)
    assert tagged_name(app, run) == "Mara Vell"  # ★ and tagged, not only made
    mara = story_roles.protagonist_of(app.store, run["project_id"], "main")
    assert mara["subject_id"] == "mara-vell"  # the ID the canon already used (never "mara-vell-2")
    povs = story_roles.outline_povs(app.store, run["project_id"], "main")
    assert povs and set(povs) == {"mara-vell"}


# ============================================================================ 4. a fallback guess beat the idea
def test_the_idea_s_main_character_made_later_is_tagged_not_the_first_made(tmp_path, monkeypatch):
    """The sketch proposes Tom (mentor) and Nessa (ally) and no one as main: Akọwe's fallback guessed Tom ("the first
    character made"); the idea's Mara, made by the guard afterwards, was demoted to a second lead."""
    monkeypatch.setitem(autobook_fake.NAMES, "A01", ["Tom Reed", "Nessa Crane", "Ilse Marrow"])
    app = make_app(tmp_path, fake=BookFakeAI())
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    assert tagged_name(app, run) == "Mara Vell"
    roles = {c["name"]: c["story_role"] for c in story_roles.cast(app.store, run["project_id"], "main")["characters"]}
    assert roles["Mara Vell"] == "protagonist" and roles["Tom Reed"] != "protagonist"


def test_a_resolved_guess_never_beats_the_character_the_idea_names():
    chars = [{"record_id": "a", "name": "Tom Reed", "subject_id": "tom-reed", "approved": True, "attributes": {},
              "facts": []},
             {"record_id": "b", "name": "Mara Vell", "subject_id": "mara-vell", "approved": True, "attributes": {},
              "facts": []}]
    entries = {"a": {"story_role": "protagonist", "story_role_by": "resolved", "story_role_fallback": True},
               "b": {"story_role": "deuteragonist", "story_role_by": "resolved"}}
    k = story_roles.cast(_NoStore(), "p", "main", chars=chars, entries=entries, idea="Mara Vell keeps the light.",
                         povs=[])
    assert k["protagonist"] == "b"
    # a tag resolved for a real reason (e.g. the idea named them before a rename) is never re-derived from text
    entries["a"].pop("story_role_fallback")
    assert story_roles.cast(_NoStore(), "p", "main", chars=chars, entries=entries, idea="Mara Vell keeps the light.",
                            povs=[])["protagonist"] == "a"
    entries["a"]["story_role_fallback"] = True
    # an AI's or the author's own claim is kept
    entries["a"]["story_role_by"] = "author"
    assert story_roles.cast(_NoStore(), "p", "main", chars=chars, entries=entries, idea="Mara Vell keeps the light.",
                            povs=[])["protagonist"] == "a"


class _NoStore:
    def get_setting(self, key):
        return None


# ============================================================================ 5. never the villain by default
def test_with_no_claims_and_no_names_the_villain_is_not_the_main_character():
    chars = [{"record_id": r, "name": n, "subject_id": r, "approved": True, "attributes": {"role": t}, "facts": []}
             for r, n, t in (("a", "Silas Crane", ""), ("b", "Pip Hale", ""), ("c", "June Ash", ""))]
    entries = {"a": {"story_role": "antagonist", "story_role_by": "ai"},
               "b": {"story_role": "extra", "story_role_by": "ai"},
               "c": {"story_role": "ally", "story_role_by": "ai"}}
    k = story_roles.cast(_NoStore(), "p", "main", chars=chars, entries=entries, idea="A story about a lighthouse.",
                         povs=[])
    assert k["protagonist"] == "c"


# ============================================================================ 2./3. the Bible Builder's names
def _session(app, pid, idea="Mara Vell keeps the Gullhaven light."):
    return BibleSession(app.assist, "author", pid, "main", idea, None)


def test_sketch_keeps_the_main_character_a_place_only_mentions(tmp_path):
    app, pid, bp = _book(tmp_path)
    _approve(bp, "A04", "Gullhaven Harbor", [("mara-vell", "Mara Vell")])
    sess = _session(app, pid)
    keys = sess._add_items([{"section": "A01", "name": "Mara Vell", "role": "the keeper", "links": [],
                             "story_role": "protagonist"}], {"A01": 1}, 1)
    it = sess.items[keys[0]]
    assert it["name"] == "Mara Vell" and not it["placeholder"] and it["story_role"] == "protagonist"
    assert it["subject_id"] == "mara-vell"


def test_sketch_duplicate_of_an_existing_character_is_a_placeholder_without_the_star(tmp_path):
    app, pid, bp = _book(tmp_path)
    _approve(bp, "A01", "Mara Vell")
    sess = _session(app, pid)
    keys = sess._add_items([{"section": "A01", "name": "Mara", "role": "the keeper", "links": [],
                             "story_role": "protagonist"},
                            {"section": "A01", "name": "Mara Holt", "role": "a cousin", "links": [],
                             "story_role": "family"}], {"A01": 2}, 1)
    dup, cousin = (sess.items[k] for k in keys)
    assert dup["placeholder"] and dup.get("duplicate_of") == "Mara" and dup["story_role"] == ""  # no 2nd ★ stranger
    assert cousin["name"] == "Mara Holt" and not cousin["placeholder"]  # a shared first name is another person


def test_sketch_count_limit_never_cuts_off_the_main_character(tmp_path):
    app, pid, _bp = _book(tmp_path, idea="A story about a lighthouse.")
    sess = _session(app, pid, "A story about a lighthouse.")
    rows = [{"section": "A01", "name": n, "role": "", "links": [], "story_role": r}
            for n, r in (("Tom Reed", "mentor"), ("Nessa Crane", "ally"), ("Ilse Marrow", "antagonist"),
                         ("June Ash", "protagonist"))]
    keys = sess._add_items(rows, {"A01": 2}, 1)
    assert [sess.items[k]["name"] for k in keys] == ["June Ash", "Tom Reed"]


def test_sketch_count_limit_keeps_the_character_the_idea_names(tmp_path):
    app, pid, _bp = _book(tmp_path)
    sess = _session(app, pid)
    rows = [{"section": "A01", "name": n, "role": "", "links": []} for n in ("Tom Reed", "Nessa Crane", "Mara Vell")]
    keys = sess._add_items(rows, {"A01": 2}, 1)
    assert "Mara Vell" in [sess.items[k]["name"] for k in keys]


# ============================================================================ 6. names in any script
def test_names_in_other_scripts_and_with_accents_match():
    assert names.same_person("Ольга Петрова", "Ольга")
    assert names.same_person("Капитан Ольга Петрова", "ольга петрова") or names.same_person("Ольга Петрова",
                                                                                          "ольга петрова")
    assert not names.same_person("Ольга Петрова", "Ирина Петрова")
    assert names.same_person("Νίκος Παππάς", "Νικος Παππας")
    assert protagonist.names_in_idea("Ольга Петрова ищет пропавшего смотрителя.") == ["Ольга Петрова"]
    assert assist_mod.slugify("Ọlá Adé", set()) == "ola-ade"
    assert assist_mod.slugify("Ольга Петрова", set()) not in ("", "-")


def test_an_approved_main_character_with_a_cyrillic_name_is_not_missing(tmp_path):
    app, pid, bp = _book(tmp_path, idea="Ольга Петрова ищет пропавшего смотрителя маяка.")
    _approve(bp, "A01", "Ольга Петрова", sid="olga")
    assert protagonist.missing(bp, store=app.store) == []
    assert story_roles.protagonist_of(app.store, pid, "main")["name"] == "Ольга Петрова"


# ============================================================================ 7. a viewpoint not in the canon
def test_an_outline_viewpoint_character_not_in_the_canon_is_made_and_pinned(tmp_path):
    """The AI's outline gives every chapter the viewpoint 'corvin-haske', a person the canon does not have. Before the
    fix the outline was rewritten until the run paused (CANON_UNRESOLVED, "plan.pov_id … is not declared")."""
    fake = BookFakeAI()
    fake.pov_name = "corvin-haske"
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    assert "Corvin Haske" in approved_names(app, run)
    assert tagged_name(app, run) == "Mara Vell"  # the viewpoint character is not the main character
    bp = BookPath(app.engine, "author", run["project_id"], "main")
    outline = bp.outline()
    corvin = next(c for c in chars_mod.canon_characters(app.store, run["project_id"], "main")
                  if c["name"] == "Corvin Haske")
    plot = bp.approved("B03")[0]  # the plan was made again so the outline's canon check sees him (pinned)
    assert corvin["record_id"] in {r.get("record_id") for r in plot.get("source_refs") or []}
    assert any(r.get("record_id") == plot["record_id"] for r in outline.get("source_refs") or [])
    assert events(run, "PLAN_REPINNED") and "Corvin Haske" in events(run, "PLAN_REPINNED")[0]["message"]
    assert events(run, "PROTAGONIST_MISSING", "note")  # said plainly that the viewpoint character was made
    assert protagonist.check(bp)["ok"]


# ============================================================================ 9./10. the guarantee
def test_every_chapter_brief_names_the_main_character(tmp_path):
    app = make_app(tmp_path, fake=BookFakeAI())
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    bp = BookPath(app.engine, "author", run["project_id"], "main")
    outline = bp.outline()
    prot = story_roles.protagonist_of(app.store, run["project_id"], "main")
    for ch in bp.outline_chapters(outline):
        brief, meta = chapter_brief.build(app.store, run["project_id"], "main", outline, ch["chapter_id"])
        assert brief["main_character"]["name"] == "Mara Vell"
        assert brief["main_character"]["id"] == prot["subject_id"]
        assert meta["protagonist"] == prot["record_id"]
    ok = events(run, "PROTAGONIST_OK")
    assert any("before the chapters are written" in e["message"] for e in ok)
    assert any("before the book is marked done" in e["message"] for e in ok)
    assert all("Mara Vell" in e["message"] for e in ok)


def test_guarantee_repairs_a_lost_tag_before_the_book_is_done(tmp_path):
    """After the chapters, the story-role tags are lost (an old companion save, a restore): the guarantee puts the ★
    back on the idea's main character before the book is marked done, and says so."""
    app = make_app(tmp_path, fake=BookFakeAI())
    ab = app.autobook
    real = ab._s_check

    def damaged(run, st):
        key = chars_mod._key(run["project_id"], run["branch_id"])  # noqa: SLF001
        cur = app.store.get_setting(key) or {}
        for e in cur.values():
            for k in ("story_role", "story_role_by", "story_role_at", "role"):
                e.pop(k, None)
            if isinstance(e.get("sheet"), dict):
                e["sheet"].pop("story_role", None)
                e["sheet"]["role"] = "side"
        app.store.set_setting(key, cur)
        return real(run, st)
    ab._s_check = damaged
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    assert tagged_name(app, run) == "Mara Vell"
    final = [e for e in events(run, "PROTAGONIST_OK") if "before the book is marked done" in e["message"]]
    assert final and "Mara Vell" in final[0]["message"]


def test_guarantee_pauses_in_plain_words_when_the_main_character_cannot_be_made(tmp_path):
    """After the chapters the main character's entry is set aside and the AI cannot make her again: the run never
    finishes silently without her — it pauses with a plain-words decision naming her."""
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    ab = app.autobook
    real = ab._s_check

    def lose_her(run, st):
        bp = ab.bp(run)
        prot = story_roles.protagonist_of(app.store, run["project_id"], "main")
        rec = bp.rec(prot["record_id"])
        with app.store.transaction() as tx:  # the author threw her entry away while the run was paused
            tx.set_lifecycle(rec["ref"], "REJECTED")
            tx.conn.execute("UPDATE heads SET approved_version=NULL WHERE record_id=?", (rec["record_id"],))
        fake.canon_breaks = {"Mara Vell": ["schema"] * 40}
        return real(run, st)
    ab._s_check = lose_her
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "paused", run["status"]
    prob = run["problem"]
    assert prob["code"] == "PROTAGONIST_MISSING" and "Mara Vell" in prob["message"]
    assert prob.get("fix")


# ============================================================================ 8. a book bible's main character
def test_a_book_bible_main_character_that_cannot_be_seeded_is_made_by_name(tmp_path, monkeypatch):
    from akowe import autobook as ab_mod  # noqa: PLC0415
    run = {"settings": {}, "main_names": []}
    ab_mod.AutoBookService._note_refused_main(run, {"module_id": "A01", "name": "Odile Marsh", "story_role": "protagonist"})
    ab_mod.AutoBookService._note_refused_main(run, {"module_id": "A01", "name": "Tamsin Reed", "story_role": "mentor"})
    assert run["main_names"] == ["Odile Marsh"]
