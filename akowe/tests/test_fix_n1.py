"""n1 fixes: R1 (the author's typing during an AI call is never overwritten) and R7 (size limits on the plan).

* A-2-q  — a title / idea typed in the book profile while the AI invents the book is kept.
* B-4-n  — a character's "wants" typed in the Character Forge while the AI writes the sheet is kept.
* B-7-o  — story rules / a world-texture detail saved while the AI writes them are kept (the AI's become suggestions;
           a run's consent never retires or rewrites the author's rules).
* C-8-m  — a 2 MB premise is refused by Akọwe's checks (written again), never approved; the book finishes.
* C-9-l  — 500 plot obligations / a 1 MB summary are refused; the book finishes.
* E-12.10-n — one 2 MB plot obligation is refused; the book finishes.
"""
from __future__ import annotations

import copy

from akowe import forge, plan_limits, story_rules
from akowe import texture as texture_mod
from akowe.book_path import get_profile, save_profile

from autobook_fake import BookFakeAI
from test_autobook import make_app, run_book


class HookFake(BookFakeAI):
    """The fake AI with per-kind hooks: ``before[kind](ctx)`` runs while the AI is "working" on that answer (the author
    typing meanwhile); ``change[kind](out) -> out`` replaces the answer (``times`` = how many answers)."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.before, self.change, self.times = {}, {}, {}

    def _answer(self, ctx, props, schema):
        kind, out = super()._answer(ctx, props, schema)
        hook = self.before.pop(kind, None)
        if hook:
            hook(ctx)
        fn = self.change.get(kind)
        if fn and self.times.get(kind, 0) > 0:
            self.times[kind] -= 1
            out = fn(copy.deepcopy(out))
        return kind, out


def _pid(app):
    rows = app.store.query("SELECT project_id FROM projects ORDER BY created_at DESC LIMIT 1")
    return rows[0]["project_id"]


def _approved(app, pid, op):
    recs = [r for r in app.store.list_records(pid, "main") if r["module_id"] == op
            and r.get("approved_version") == r["version"]]
    return recs[0]["data"] if recs else {}


# ------------------------------------------------------------------------------------------------- R1
def test_a2q_profile_typed_during_the_ai_call_is_kept(tmp_path):
    fake = HookFake()
    app = make_app(tmp_path, fake=fake)
    mine = {"title": "Author's Own Title", "idea": "The author's own idea, typed while the AI worked."}
    fake.before["profile"] = lambda ctx: save_profile(app.store, _pid(app), mine)
    run = run_book(app)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    p = get_profile(app.store, run["project_id"])
    assert p["title"] == mine["title"] and p["idea"] == mine["idea"]
    assert p.get("tone") or p.get("genre") is not None  # the AI still filled the rest
    ev = [e for e in app.autobook.get(run["id"])["events"] if e.get("code") == "AUTHOR_TEXT_KEPT"]
    assert ev and "title and idea" in ev[0]["message"]


def test_b4n_wants_typed_in_the_forge_during_the_sheet_call_is_kept(tmp_path):
    fake = HookFake()
    fake.companion = False  # no sheet with the character proposals: the sheet is its own AI call
    app = make_app(tmp_path, fake=fake)
    mine = "The author's own words: to buy back her father's boat."
    seen = {}

    def author_types(ctx):
        from akowe import characters as chars_mod  # noqa: PLC0415
        pid = _pid(app)
        name = (ctx.get("character") or {}).get("name")
        cast = chars_mod.canon_characters(app.store, pid, "main")
        rid = next((c["record_id"] for c in cast if c["name"] == name), None) or cast[0]["record_id"]
        seen["rid"] = rid
        forge.edit(app.store, pid, "main", rid, {"sections": {"inner_life": {"wants": {"text": mine}}}})
    fake.before["sheet"] = author_types
    run = run_book(app)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    d = forge.public(app.store, run["project_id"], "main", seen["rid"])
    txt = next(f["text"] for s in d["sections"] for f in s["fields"] if f["key"] == "wants")
    assert mine in txt
    from akowe import characters as chars_mod  # noqa: PLC0415
    e = chars_mod.get_entry(app.store, run["project_id"], "main", seen["rid"])
    assert e["sheet"]["wants"] == mine and e["sheet"].get("fear")  # the AI filled the empty fields


def test_b7o_rules_and_texture_saved_during_the_ai_call_are_kept(tmp_path):
    fake = HookFake()
    app = make_app(tmp_path, fake=fake)
    rule = [{"id": "", "category": "hard_rule", "text": "The author's own rule: the lamp never lies.", "scope": "",
             "source": "the author", "stated_by": "the author"}]
    item = {"kind": "work", "detail": "The author's own texture: nets dry on the chapel railings.",
            "causes": "custom", "effect": "", "words": ["nets"]}
    fake.before["rules"] = lambda ctx: story_rules.save(app.store, _pid(app), "main", story_rules.clean_rules(rule),
                                                        by="author")
    fake.before["texture"] = lambda ctx: texture_mod.save(app.store, _pid(app), "main",
                                                          texture_mod.clean_items([item]), by="author")
    run = run_book(app)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    e = story_rules.get_entry(app.store, run["project_id"], "main")
    assert any("lamp never lies" in r["text"] for r in story_rules.active(e))
    t = texture_mod.get_entry(app.store, run["project_id"], "main")
    assert any("chapel railings" in i["detail"] for i in t["items"])


def test_b7o_run_consent_never_retires_the_authors_rule(tmp_path):
    app = make_app(tmp_path, fake=BookFakeAI())
    pid = app.engine.bootstrap_project("author", "Rules book")
    mine = story_rules.save(app.store, pid, "main", story_rules.clean_rules([
        {"id": "", "category": "hard_rule", "text": "The lamp never lies.", "scope": "", "source": "me",
         "stated_by": "the narrator"}]), by="author")
    rid = mine["rules"][0]["id"]
    story_rules.propose(app.store, pid, "main", mine, [dict(mine["rules"][0], text="The lamp sometimes lies.")],
                        slot="AI-1", basis_now={}, notes=[])
    e = story_rules.decide_proposals(app.store, pid, "main", accept=None, by="ai", run_id="run-x")
    assert next(r for r in e["rules"] if r["id"] == rid)["text"] == "The lamp never lies."
    # the author deciding it themselves still can
    e = story_rules.get_entry(app.store, pid, "main")
    story_rules.propose(app.store, pid, "main", e, [], slot="AI-1", basis_now={}, notes=[])
    e = story_rules.decide_proposals(app.store, pid, "main", accept=None, by="author")
    assert not story_rules.active(e)


# ------------------------------------------------------------------------------------------------- R7
def test_plan_limits_plain_words():
    assert plan_limits.problems("B01", {"premise": "x" * 300, "dramatic_question": "Will she?",
                                        "concept_summary": "y"}) == []
    big = plan_limits.problems("B01", {"premise": "Ω" * 2_000_000, "dramatic_question": "q", "concept_summary": "s"})
    assert big and "premise is far too long" in big[0] and "_" not in big[0]
    assert plan_limits.problems("B03", {"plot_obligations": [f"o{i}" for i in range(500)]})
    assert plan_limits.problems("B03", {"plot_obligations": ["x" * 2_000_000]})
    assert plan_limits.problems("B03", {"main_plot": {"summary": "s" * 1_000_000}})
    assert plan_limits.problems("B11", {"chapters": [{"objective": "z" * 50_000}]})
    assert plan_limits.problems("B11", None) == []


def test_c8m_a_2mb_premise_is_never_approved(tmp_path):
    fake = HookFake()
    fake.change["B01"] = lambda out: {k: "Ω" * (2 * 1024 * 1024) for k in out}
    fake.times["B01"] = 1
    app = make_app(tmp_path, fake=fake)
    run = run_book(app)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    d = _approved(app, run["project_id"], "B01")
    assert d and max(len(str(v)) for v in d.values()) < 20_000
    assert fake.kinds.count("B01") >= 2  # refused by Akọwe's checks and written again


def test_c9l_500_obligations_and_a_1mb_summary_are_never_approved(tmp_path):
    fake = HookFake()

    def absurd(out):
        mp = out.get("main_plot") if isinstance(out.get("main_plot"), dict) else {}
        mp["summary"] = "Mara Vell fights Mara Vell. " * 40000
        out["main_plot"] = mp
        out["plot_obligations"] = [f"Obligation {i}: Mara Vell must face Mara Vell." for i in range(500)]
        return out
    fake.change["B03"], fake.times["B03"] = absurd, 1
    app = make_app(tmp_path, fake=fake)
    run = run_book(app)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    d = _approved(app, run["project_id"], "B03")
    assert d and len(d.get("plot_obligations") or []) <= plan_limits.LIST_MAX["B03"]["plot_obligations"][0]
    assert fake.kinds.count("B03") >= 2  # refused by Akọwe's checks and written again


def test_e1210n_one_2mb_obligation_is_never_approved(tmp_path):
    fake = HookFake()

    def huge(out):
        out["plot_obligations"] = list(out.get("plot_obligations") or []) + ["x" * (2 * 1024 * 1024)]
        return out
    fake.change["B03"], fake.times["B03"] = huge, 1
    app = make_app(tmp_path, fake=fake)
    run = run_book(app)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    d = _approved(app, run["project_id"], "B03")
    assert d and max((len(o) for o in d.get("plot_obligations") or []), default=0) < 1000
    assert fake.kinds.count("B03") >= 2  # refused by Akọwe's checks and written again
