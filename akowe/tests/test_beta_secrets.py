"""🔮 Beta readers count only real secrets as "a twist guessed too early", never the premise (beta_secrets.py).

"The Salt Tuner": all three readers "guessed a twist too early in chapter 1 — 'Teo was under the notes'", but Teo's
voice in the piano IS the premise."""
from __future__ import annotations

import copy

from akowe import beta_reader as beta
from akowe import beta_secrets as bs
from akowe import improve_pass as ip

from test_failover_review import SlotFake, make_app, run_book

INFO = {"premise": "A piano tuner hears her drowned brother Teo singing under the notes of an old piano.",
        "secrets": ["Teo did not drown by accident: Uncle Ade left the sluice open."]}


def _guess(text, ch=1, rv=3):
    return {"guess": text, "guessed_in_chapter": ch, "quote": "", "revealed_in_chapter": rv, "came_true": "yes",
            "verified": False, "in_chapter": False}


def _read(n, guesses):
    return {"n": n, "status": "done", "reader": {"slot": f"AI-{n}", "name": f"AI {n}", "independent": True},
            "persona": {"label": f"reader {n}", "a_label": f"a reader {n}"}, "reactions": [],
            "interest": [{"chapter": c, "score": 7, "would_keep_reading": True} for c in (1, 2, 3)],
            "guesses": guesses, "stop": {"would_finish": True, "chapter": 0, "why": ""}, "overall": None,
            "average_interest": 7}


def test_a_guess_is_a_secret_the_premise_or_unknown():
    assert bs.kind_of("Teo was under the notes", INFO) == "premise"
    assert bs.kind_of("Teo sings under the piano notes", INFO) == "premise"
    assert bs.kind_of("Teo is trapped inside the piano", INFO) == "unknown"         # adds something: still counts
    assert bs.kind_of("Uncle Ade opened the sluice", INFO) == "secret"
    assert bs.kind_of("Teo's drowning was Uncle Ade's doing", INFO) == "secret"   # names both: the secret wins
    assert bs.kind_of("The tuner falls in love with the baker", INFO) == "unknown"
    assert bs.kind_of("Teo was under the notes", None) == "unknown"                 # switched off / unknown


def test_premise_guesses_never_count_as_twists_guessed_too_early():
    reads = [_read(i, [_guess("Teo was under the notes")]) for i in (1, 2, 3)]
    before = beta.compare(copy.deepcopy(reads), 3)
    assert any(g["kind"] == "guessed" and g["count"] == 3 for g in before["agree"])     # the old way: 3 readers
    for r in reads:
        assert bs.mark(r, INFO) == 1 and r["guesses"][0]["premise"] is True
        assert not any(f["id"] == "guessed" for f in beta.findings(r, 3))
    after = beta.compare(reads, 3)
    assert not any(g["kind"] == "guessed" for g in after["agree"]) and not any(
        f["kind"] == "guessed" for f in after["fixes"])
    # a real secret guessed early still counts
    r = _read(1, [_guess("Uncle Ade opened the sluice")])
    bs.mark(r, INFO)
    assert [f["id"] for f in beta.findings(r, 3)] == ["guessed"]


def test_the_reader_is_told_the_premise_is_no_twist_and_the_premise_guess_is_dropped(tmp_path, monkeypatch):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    prem = bs.premise(app.engine, app.store, "author", pid, "main")
    assert prem   # the fake's B01 premise
    words = "The " + " the ".join(sorted(bs.words(prem))[:3])   # a guess that only restates the premise

    def answer(ctx):
        out = fake._beta(ctx)
        out["guesses"] = [dict(out["guesses"][0], guess=words), dict(out["guesses"][0])]
        return out
    fake.beta_script = [answer]
    r = beta.service_of(app).read("author", pid, "main")
    ctx = fake.prompts["beta"][-1][1]
    assert ctx["premise"] == prem and "rules" not in ctx and "outline" not in ctx
    assert bs.RULE in fake.prompts["beta"][-1][0]
    assert r["premise_guesses"] == 1 and r["guesses"][0]["premise"] is True and not r["guesses"][1].get("premise")
    assert any(f["id"] == "guessed" and words not in f["detail"] for f in r["findings"])   # the real guess stays
    # switched off: the old way
    app.store.set_setting(bs.SETTING, {"enabled": False})
    fake.beta_script = [answer]
    r2 = beta.service_of(app).read("author", pid, "main")
    assert "premise" not in fake.prompts["beta"][-1][1] and not r2["guesses"][0].get("premise")


def test_the_improve_pass_ranking_ignores_premise_guesses_of_a_stored_read(tmp_path, monkeypatch):
    app = make_app(tmp_path, SlotFake())
    run = run_book(app, {"slot_id": "AI-1"})
    pid = run["project_id"]
    monkeypatch.setattr(bs, "known", lambda *a, **k: INFO)
    svc = beta.service_of(app)
    reads = [_read(i, [_guess("Teo was under the notes")]) for i in (1, 2, 3)]
    panel = {"id": "beta-panel-x", "kind": "panel", "status": "done", "chapters": 3, "version_key": "v",
             "readers": reads, "comparison": beta.compare(copy.deepcopy(reads), 3), "findings": []}
    assert any(f["kind"] == "guessed" for f in panel["comparison"]["fixes"])   # stored the old way
    svc._store(pid, "main", panel)  # noqa: SLF001
    got = ip._latest_beta(app, pid, "main")  # noqa: SLF001
    assert got is not None and not any(f["kind"] == "guessed" for f in got["fixes"])
