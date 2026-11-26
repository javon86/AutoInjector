"""Fix n4 (stress test R4 + R6): an unusable AI answer is asked again, then of another working AI, and the stop is in
plain words; every stop carries the right label (a refusal is not a busy AI, Akọwe's own fault is not an AI problem,
putting the book together uses no AI).

One check per stress ID: ``test_each_id_has_the_right_words_and_label`` (the stop each ID's scenario produces, built
by the same code the run uses), the AI-call mechanics in ``test_assist_*`` / ``test_wait_and_retry_*``, and a few whole
runs through the stress harness (``test_whole_run``), one per path (assist, engine, reviewer, Bible Builder, own
code, a book step).
"""
from __future__ import annotations

import re
import types

import pytest

from akowe import alerts, autobook, stop_words
from akowe.assist import AssistService
from akowe.book_path import StepError
from akowe.errors import AkoweError
from akowe.jobs import RetryPolicy, wait_and_retry

JARGON = re.compile(r"JSON|schema|is a required property|is not of type|is not one of|Last errors|"
                    r"^[A-Z]\d\d could not be created \(|busy or unreachable|Traceback|KeyError|RuntimeError")

STEPS = {"A-2": ("profile", "inventing the book"), "B-3": ("canon", "making the characters"),
         "B-4": ("characters", "making the character sheets"), "B-7": ("world", "making the story rules"),
         "C-8": ("premise", "writing the premise"), "C-9": ("plot", "writing the main plot"),
         "C-10": ("outline", "writing the chapter outline"), "E-12.1": ("chapters", "writing the chapter"),
         "E-12.2": ("chapters", "writing the chapter"), "E-12.3": ("chapters", "reviewing the chapter"),
         "E-12.4": ("chapters", "editing the chapter"), "E-12.10": ("chapters", "writing the ending"),
         "E-12.11": ("chapters", "planning the scenes"), "F-14": ("format", "I01"), "F-15": ("assemble", "G05"),
         "F-16": ("export", "G11"), "F-17": ("check", "H05")}
UNUSABLE = ["A-2-d", "A-2-e", "A-2-o", "B-3-d", "B-3-e", "B-3-o", "C-8-d", "C-8-e", "C-8-l", "C-9-d", "C-9-e",
            "C-9-j", "C-10-d", "C-10-e", "E-12.2-d", "E-12.2-e", "E-12.3-d", "E-12.3-e", "E-12.3-p", "E-12.10-d",
            "E-12.10-e"]
DECLINED = ["A-2-f", "B-3-f", "B-4-f", "B-7-f", "C-8-f", "C-9-f", "C-10-f", "E-12.1-f", "E-12.2-f", "E-12.3-f",
            "E-12.10-f", "E-12.11-f"]
OWN = ["A-2-g", "B-3-g", "B-4-g", "C-8-g", "C-9-g", "C-10-g", "E-12.1-g", "E-12.2-g", "E-12.3-g", "E-12.4-g",
       "F-14-g", "F-15-g", "F-16-g", "F-17-g"]
DISK = ["F-14-c", "F-15-c", "F-17-c"]
REFUSES = ["F-14-f", "F-15-f", "F-17-f"]


def _part(rid: str) -> str:
    return rid.rsplit("-", 1)[0]


def _declined_problem(what: str) -> dict:
    """What the run shows after every AI refused for the whole waiting time (jobs.wait_and_retry → _ai_problem)."""
    def refuse():
        raise AkoweError("AI_DECLINED", "", "Claude declined to answer (it said it can't help with that)")
    with pytest.raises(AkoweError) as e:
        wait_and_retry(refuse, policy=RetryPolicy([1], 2, sleep=lambda s: None), who="Claude")
    svc = autobook.AutoBookService.__new__(autobook.AutoBookService)
    with pytest.raises(autobook.StepProblem) as sp:
        svc._ai_problem(e.value, what)  # noqa: SLF001
    return sp.value.problem


def _unusable_problem(what: str) -> dict:
    err = AkoweError("INTERNAL_ERROR", "", stop_words.unusable_message("Gemini", 3) + " (every working AI was asked)")
    err.try_other_ai = err.unusable = True
    svc = autobook.AutoBookService.__new__(autobook.AutoBookService)
    with pytest.raises(autobook.StepProblem) as sp:
        svc._ai_problem(err, what)  # noqa: SLF001
    return sp.value.problem


def _run_for(problem: dict, step: str) -> dict:
    return {"status": "paused", "pause_reason": "problem", "current": step,
            "problem": dict(problem, step=step, where={"step": step.title()})}


@pytest.mark.parametrize("rid", UNUSABLE + DECLINED + OWN + DISK + REFUSES + ["F-16-c", "F-16-f"])
def test_each_id_has_the_right_words_and_label(rid):
    step, what = STEPS[_part(rid)]
    if rid in UNUSABLE:
        prob, cat = _unusable_problem(what), "ai"
        assert prob["code"] == "AI_UNUSABLE" and prob["fix"] == stop_words.UNUSABLE_FIX
        assert "every working AI was asked" in prob["message"]
    elif rid in DECLINED:
        prob, cat = _declined_problem(what), "ai"
        assert prob["code"] == "AI_DECLINED" and prob["fix"] == autobook.DECLINED_FIX
        assert "declined" in prob["message"] and "AutoInjector" not in prob["fix"]
    elif rid in OWN:
        prob, cat = stop_words.own_error_problem(step.title(), KeyError("x")), "akowe"
        assert prob["message"].startswith("Akọwe hit an unexpected error in “") and "Resume" in prob["message"]
    elif rid in DISK:
        e = StepError(what, {"status": "BLOCKED", "errors": [{"code": "UPSTREAM_UNAVAILABLE",
                                                              "message": "storage unavailable: database or disk is full"}]})
        prob, cat = {"code": e.code, "message": e.message, "fix": stop_words.fix_for(e.message)}, "book"
        assert "the disk is full" in prob["message"] and "Free some space" in prob["fix"]
    elif rid in REFUSES:
        e = StepError(what, {"status": "BLOCKED", "errors": [{"code": "CAPABILITY_UNAVAILABLE",
                                                              "message": "the module refuses"}]})
        prob, cat = {"code": e.code, "message": e.message, "fix": "Press 🔁 Try again."}, "book"
        assert prob["message"].endswith("could not be made: the module refuses.")
    else:  # F-16-c / F-16-f: the export step's own words
        prob, cat = {"code": "INVALID_INPUT", "message": "Some files could not be made: PDF: The PDF file could not "
                     "be saved: the disk is full.", "fix": "Press 🔁 Try again."}, "book"
    assert not JARGON.search(prob["message"] + " " + str(prob.get("fix") or "")), prob
    a = alerts.describe(_run_for(prob, step), "problem")
    assert a["category"] == cat and (a["icon"], a["label"]) == alerts.CATEGORIES[cat], a
    assert "busy or unreachable" not in a["why"] + a["next"]
    if cat != "ai":
        assert "AI" not in a["label"] and "connect or switch an AI" not in a["next"]
    if cat == "akowe":
        assert "not the AI" in a["why"] and [c["action"] for c in a["choices"]] == ["resume"]


def test_older_stored_own_errors_are_still_labelled_akowe():
    run = _run_for({"code": "INTERNAL_ERROR", "message": "Akọwe hit an unexpected problem (KeyError)."}, "premise")
    assert alerts.category_of(run, "problem") == "akowe"
    # an AI adapter's INTERNAL_ERROR stays an AI problem
    run = _run_for({"code": "INTERNAL_ERROR", "message": "provider error 500"}, "premise")
    assert alerts.category_of(run, "problem") == "ai"


# ------------------------------------------------------------------ the AI call: ask again once, then another AI
class _Prov:
    def __init__(self, answers):
        self.answers = answers  # slot -> list of results (exception or data)
        self.calls = []
        self.health = types.SimpleNamespace(notify=lambda info: None)

    def slots(self):
        return [{"slot_id": s, "active_jobs": 0, "max_concurrent": 1, "adapter_id": "anthropic", "model": "m"}
                for s in ("AI-1", "AI-2", "AI-3")]

    def eligible(self, *a, **k):
        return self.slots()

    def down_error(self, down):
        return AkoweError("UPSTREAM_UNAVAILABLE", "", "down")

    def generate(self, ctx, **kw):
        sid = kw["slot_id"]
        self.calls.append(sid)
        r = self.answers[sid].pop(0)
        if isinstance(r, Exception):
            raise r
        return r, {"model": "m"}


def _unusable(reasked=False):
    e = AkoweError("INTERNAL_ERROR", "", stop_words.unusable_message("The Claude API", 1))
    e.try_other_ai = e.unusable = True
    if reasked:
        e.reasked = True
    return e


def _svc(prov):
    svc = AssistService.__new__(AssistService)
    svc._providers = lambda job: prov  # noqa: SLF001
    svc._choose_slot = lambda job, op, needed, exclude: next(s for s in prov.slots()  # noqa: SLF001
                                                              if s["slot_id"] not in exclude)
    svc._slot_label = lambda slot: slot["slot_id"]  # noqa: SLF001
    import threading  # noqa: PLC0415
    svc._lock, svc._slot_sems = threading.Lock(), {}  # noqa: SLF001
    return svc


def _job(pref=None):
    return types.SimpleNamespace(project_id="p", branch_id="b", id="j", calls=0, slot=None, slot_label=None,
                                 model=None, status=None, phase=None, slot_pref=pref, failovers=[], check=lambda: None)


def test_assist_asks_the_same_ai_once_more_then_another_ai():
    prov = _Prov({"AI-1": [_unusable(), _unusable()], "AI-2": [{"ok": 1}], "AI-3": []})
    job = _job()
    out = _svc(prov)._call_ai_once(job, op_for_roles="C02", task="t", schema={}, context={}, protected=[])  # noqa
    assert out == {"ok": 1} and prov.calls == ["AI-1", "AI-1", "AI-2"]
    assert job.failovers and job.failovers[0]["state"] == "unusable"


def test_assist_moves_at_once_when_the_adapter_already_asked_again_and_stops_in_plain_words():
    prov = _Prov({s: [_unusable(reasked=True)] for s in ("AI-1", "AI-2", "AI-3")})
    with pytest.raises(AkoweError) as e:
        _svc(prov)._call_ai_once(_job(), op_for_roles="C02", task="t", schema={}, context={}, protected=[])  # noqa
    assert prov.calls == ["AI-1", "AI-2", "AI-3"]  # every working AI was asked, each once (the adapter re-asked)
    msg = e.value.errors[0]["message"]
    assert "every working AI was asked" in msg and not JARGON.search(msg)


def test_assist_keeps_the_ai_the_author_picked():
    prov = _Prov({"AI-1": [_unusable(reasked=True)], "AI-2": [{"ok": 1}], "AI-3": []})
    with pytest.raises(AkoweError):
        _svc(prov)._call_ai_once(_job(pref="AI-1"), op_for_roles="C02", task="t", schema={}, context={},  # noqa
                                 protected=[])
    assert prov.calls == ["AI-1"]


def test_wait_and_retry_names_a_refusal_as_a_refusal():
    def refuse():
        raise AkoweError("AI_DECLINED", "", "x")
    with pytest.raises(AkoweError) as e:
        wait_and_retry(refuse, policy=RetryPolicy([1], 2, sleep=lambda s: None), who="Gemini")
    assert e.value.code == "AI_DECLINED" and "Gemini declined" in e.value.errors[0]["message"]
    assert "busy or unreachable" not in e.value.errors[0]["message"]


def test_the_adapter_message_has_no_schema_words():
    msg = stop_words.unusable_message("Claude", 3)
    assert stop_words.is_unusable("INTERNAL_ERROR", msg) and not JARGON.search(msg)
    assert stop_words.module_failed("C02", {"status": "BLOCKED", "errors": [
        {"message": "/text: 5 is not of type 'string'"}]}) == ("The chapter could not be made: Akọwe's checks "
                                                               "refused it (the details are below).")


# ------------------------------------------------------------------ whole runs through the stress harness
@pytest.fixture(scope="module")
def harness():
    from tools.stress import core  # noqa: PLC0415
    secs = {}

    def get(letter):
        if letter not in secs:
            secs[letter] = core.load_section(letter)
        core.TMP_BASE.mkdir(parents=True, exist_ok=True)
        return secs[letter]
    yield core, get
    core.cleanup_tmp()


@pytest.mark.parametrize("rid,section", [("A-2-d", "A"), ("A-2-g", "A"), ("B-3-f", "B"), ("C-8-l", "C"),
                                         ("E-12.3-p", "E1"), ("F-14-c", "F"), ("F-16-f", "F")])
def test_whole_run(harness, rid, section):
    core, get = harness
    sec = get(section)
    _s, part, letter = rid.split("-")
    o = core.run_one(sec, sec.stresses[(part, letter)], seed=0, verbose=False)
    assert o.result in (core.SAFE, core.HANDLED), (o.result, o.happened, o.issues, o.risks)
