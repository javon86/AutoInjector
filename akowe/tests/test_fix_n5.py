"""n5 (stress-test fixes R5 + R8 + log noise): optional steps never stop the book, and what they could not do is
always said (a ⚠️ journal note and, where the author must act, a check-later line). One test per finding ID."""
from __future__ import annotations

import errno
import logging
import time
import types
from pathlib import Path

import pytest

from akowe import book_pictures, checkpoints, forge, keep_brief, story_details, subtext_check, writers_room
from akowe import texture as texture_mod
from akowe.autobook import STEPS, AutoBookService, RunPaused
from akowe.backups import DISK_MESSAGE, failure_code
from akowe.errors import AkoweError
from akowe.store import Store

from test_failover_review import SlotFake, make_app, run_book

OFF = {"length": "short_story", "improve_pass": False, "first_page": False, "opening_pass": False,
       "human_pass": False, "idea": "A lighthouse keeper's apprentice and a brass key"}


def _codes(run):
    return [e.get("code") for e in run["events"]]


def _later(app, run):
    return app.autobook.get(run["id"]).get("check_later") or []


def _errors(caplog):
    return [r for r in caplog.records if r.levelno >= logging.ERROR]


# ====================================================================== A-1 the safety backup
def _backup_step(app):
    run, st = {"id": "run-x", "events": [], "current": "backup"}, {}
    app.autobook._s_backup(run, st)  # noqa: SLF001
    return run, st


def _disk_full(*_a, **_k):
    try:
        raise OSError(errno.ENOSPC, "No space left on device")
    except OSError as exc:
        raise AkoweError("INTERNAL_ERROR", "/backup", DISK_MESSAGE) from exc


def test_a1g_a_backup_that_raises_is_noted_and_listed(tmp_path, monkeypatch):
    app = make_app(tmp_path, SlotFake())
    monkeypatch.setattr(app.backups, "backup", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    run, st = _backup_step(app)
    assert "saved" not in st["message"] and st["message"].startswith("⚠️")
    assert _codes(run) == ["BACKUP_FAILED"]
    assert any(x.startswith("Safety backup:") for x in run["check_later"])


def test_a1j_disk_full_says_so_and_the_book_goes_on(tmp_path, monkeypatch):
    app = make_app(tmp_path, SlotFake())
    monkeypatch.setattr(app.backups, "backup", _disk_full)
    run = run_book(app, dict(OFF))
    assert run["status"] == "done", run.get("problem")
    assert "BACKUP_FAILED" in _codes(run)
    line = next(x for x in _later(app, run) if x.startswith("Safety backup:"))
    assert "disk is full" in line and "free some disk space" in line


def test_a1k_backups_folder_blocked(tmp_path):
    app = make_app(tmp_path, SlotFake())
    folder = Path(app.backups.dir)
    folder.parent.mkdir(parents=True, exist_ok=True)
    if folder.exists():
        import shutil
        shutil.rmtree(folder)
    folder.write_text("not a folder", encoding="utf-8")
    run, st = _backup_step(app)
    assert _codes(run) == ["BACKUP_FAILED"]
    assert "backups folder could not be made" in st["message"]
    assert failure_code(_wrapped(FileExistsError(errno.EEXIST, "exists"))) == "FOLDER_BLOCKED"


def _wrapped(os_err):
    try:
        try:
            raise os_err
        except OSError as exc:
            raise AkoweError("INTERNAL_ERROR", "/backup", DISK_MESSAGE) from exc
    except AkoweError as outer:
        return outer


def test_a1n_an_unverified_backup_is_not_called_saved(tmp_path, monkeypatch):
    app = make_app(tmp_path, SlotFake())
    monkeypatch.setattr(Store, "verify_backup", staticmethod(lambda dest: ["a file differs"]))
    run, st = _backup_step(app)
    assert "did not verify" in st["message"] and "saved" not in st["message"]
    assert _codes(run) == ["BACKUP_UNVERIFIED"]
    assert any("did not verify" in x for x in run["check_later"])


# ====================================================================== B-3-i pause during the characters: no traceback
def test_b3i_pause_inside_a_bible_item_is_not_an_error(caplog):
    from akowe.assist import BibleSession

    def propose(*_a, **_k):
        raise RunPaused()
    stub = types.SimpleNamespace(
        svc=types.SimpleNamespace(propose=propose, contracts=types.SimpleNamespace(operation=lambda op: {"name": "x"})),
        _job=lambda op, slot: types.SimpleNamespace(slot="AI-1", model="m"), items={}, _known_items=lambda: [],
        idea="", world_summary="", _phase=lambda *a, **k: None, _cast=lambda: [])
    it = {"key": "A01-1", "op": "A01", "links": [], "name": "Ada", "subject_id": "ada", "role": "", "placeholder": False}
    with caplog.at_level(logging.INFO):
        BibleSession._generate_item(stub, it, "AI-1", None)  # noqa: SLF001
    assert it["status"] == "cancelled"
    assert not _errors(caplog)


# ====================================================================== B-5 the looks step
def test_b5g_a_bug_saving_the_looks_never_stops_the_book(tmp_path, monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("bug")
    monkeypatch.setattr(story_details, "_accept", boom)
    app = make_app(tmp_path, SlotFake())
    run = run_book(app, dict(OFF))
    assert run["status"] == "done", run.get("problem")
    assert "DETAILS_LATER" in _codes(run)


def test_b5n_the_looks_step_does_not_promise_places_before_the_outline():
    text = next(s[4] for s in STEPS if s[0] == "looks")
    assert "short look for the places" not in text
    assert "just in time" in text and "Places and items" in text


# ====================================================================== B-6 pictures
def _no_store_app():
    return types.SimpleNamespace(store=object())  # have() then finds no pictures (never raises)


def test_b6g_a_bug_in_the_picture_code_puts_the_pictures_on_the_list(monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("bug")
    monkeypatch.setattr(forge, "run_art", boom)
    out = book_pictures._make_for(_no_store_app(), "author", "p", "main", "r1", book_pictures.FULL, "sd",  # noqa: SLF001
                                  None, None)
    assert out["failed"] == list(book_pictures.FULL) and out["code"] == "PICTURE_ERROR" and not out["made"]


def test_b6g_control_still_stops(monkeypatch):
    def pause(*_a, **_k):
        raise RunPaused()
    monkeypatch.setattr(forge, "run_art", pause)
    with pytest.raises(RunPaused):
        book_pictures._make_for(_no_store_app(), "author", "p", "main", "r1", ["portrait"], "sd", None, None)  # noqa: SLF001


def test_b6l_a_hanging_picture_maker_is_given_up_after_the_first_hang(monkeypatch):
    calls = []

    def hang(*_a, **_k):
        calls.append(1)
        raise forge.ArtProblem("IMAGE_TIMEOUT")
    monkeypatch.setattr(forge, "run_art", hang)
    out = book_pictures._make_for(_no_store_app(), "author", "p", "main", "r1", book_pictures.FULL, "sd",  # noqa: SLF001
                                  None, None, hang_is_down=True)
    assert len(calls) == 1 and out["down"] and set(out["failed"]) == set(book_pictures.FULL)
    calls.clear()
    out = book_pictures._make_for(_no_store_app(), "author", "p", "main", "r1", book_pictures.FULL, "sd",  # noqa: SLF001
                                  None, None)  # 🖼 Make the rest keeps trying every group
    assert len(calls) == 3 and not out["down"]
    assert 0 < book_pictures.RUN_BUDGET_S <= 30 * 60


def test_b6m_pause_lets_go_of_a_slow_picture(monkeypatch):
    monkeypatch.setattr(forge, "request_image", lambda app, body: time.sleep(5) or {})
    t0 = time.monotonic()

    def check():
        if time.monotonic() - t0 > 0.3:
            raise RunPaused()
    with pytest.raises(RunPaused):
        forge._request_watched(None, {}, types.SimpleNamespace(check=check))  # noqa: SLF001
    assert time.monotonic() - t0 < 2.0
    monkeypatch.setattr(forge, "request_image", lambda app, body: {"ok": True})
    assert forge._request_watched(None, {}, types.SimpleNamespace(check=lambda: None)) == {"ok": True}  # noqa: SLF001


# ====================================================================== B-7 world texture
def test_b7g_a_bug_in_the_texture_code_never_stops_the_book(tmp_path, monkeypatch):
    def boom(*_a, **_k):
        raise ValueError("bug")
    monkeypatch.setattr(texture_mod, "generate", boom)
    app = make_app(tmp_path, SlotFake())
    run = run_book(app, dict(OFF))
    assert run["status"] == "done", run.get("problem")
    codes = _codes(run)
    assert "TEXTURE_LATER" in codes and "TEXTURE_FAILED" in codes
    assert any("World texture" in x for x in _later(app, run))


def test_b7l_an_unusable_texture_is_tried_again_and_listed(tmp_path):
    fake = SlotFake()
    fake.fail_kind("texture", *[AkoweError("INTERNAL_ERROR", "", "not json") for _ in range(40)])
    app = make_app(tmp_path, fake)
    run = run_book(app, dict(OFF))
    assert run["status"] == "done", run.get("problem")
    codes = _codes(run)
    assert "TEXTURE_LATER" in codes and "TEXTURE_FAILED" in codes
    assert any("World texture" in x for x in _later(app, run))


def test_b7k_the_check_later_box_gives_no_wrong_reason():
    js = (Path(__file__).resolve().parents[1] / "akowe" / "web" / "app.js").read_text(encoding="utf-8")
    assert "Needs your check later (only one AI was working" not in js
    assert "Needs your check later: ${r.check_later.join('; ')}." in js


# ====================================================================== C-9-k the writers' room with no idea back
def test_c9k_a_room_where_every_pitch_failed_does_not_crash(monkeypatch):
    room = {"id": "room-1", "pitches": [{"status": "failed", "slot": "AI-1"}, {"status": "failed", "slot": "AI-2"}],
            "votes": [], "tally": {}, "message": "no idea came back"}
    monkeypatch.setattr(writers_room, "service_of", lambda app: types.SimpleNamespace(hold=lambda *a, **k: room))
    events = []
    runner = types.SimpleNamespace(app=None, _assist=None, save=lambda run: None, check=lambda run: None,
                                   event=lambda run, kind, msg, **k: events.append(k.get("code")))
    run = {"id": "run-1", "principal": "author", "project_id": "p", "branch_id": "main"}
    out = writers_room._run_room(runner, run, {}, {"label": "A twist"}, "the main plot", ())  # noqa: SLF001
    assert out is None and events == ["WRITERS_ROOM_FAILED"]


# ====================================================================== C-10.5-g story shape / kind placement
@pytest.mark.parametrize("which", ["story_shape", "story_kind"])
def test_c105g_a_bug_in_the_placement_never_stops_the_book(monkeypatch, which):
    import importlib
    mod = importlib.import_module(f"akowe.{which}")

    def boom(*_a, **_k):
        raise RuntimeError("bug")
    monkeypatch.setattr(mod, "of_store", lambda *a, **k: True)
    monkeypatch.setattr(mod, "place", boom)
    monkeypatch.setattr(mod, "mapping", boom)
    events = []
    outline = {"record_id": "o1", "version": 1}
    stub = types.SimpleNamespace(store=None, _review=None, save=lambda run: None,
                                 bp=lambda run: types.SimpleNamespace(outline=lambda: outline),
                                 _sub_job=lambda *a, **k: None,
                                 event=lambda run, kind, msg, **k: events.append(k.get("code")))
    stub._fallback_mapping = lambda run, m, o: AutoBookService._fallback_mapping(stub, run, m, o)  # noqa: SLF001
    run = {"id": "run-1", "project_id": "p", "branch_id": "main", "settings": {}}
    fn = AutoBookService._place_beats if which == "story_shape" else AutoBookService._place_stages  # noqa: SLF001
    fn(stub, run, {})
    assert events == ["SHAPE_FAILED" if which == "story_shape" else "KIND_FAILED"]


# ====================================================================== E-12.6 the subtext check: no traceback
@pytest.mark.parametrize("code", ["TIMEOUT", "INVALID_INPUT", "AI_DECLINED", "INTERNAL_ERROR"])
def test_e126_an_ai_failure_of_the_subtext_check_is_one_quiet_line(monkeypatch, caplog, code):
    head = {"record_id": "c1", "module_id": "C02", "version": 2}

    def fail(*_a, **_k):
        raise AkoweError(code, "", "no")
    monkeypatch.setattr(subtext_check, "_pass", fail)
    events = []
    svc = types.SimpleNamespace(bp=lambda run: types.SimpleNamespace(rec=lambda rid: head), save=lambda run: None,
                                event=lambda run, kind, msg, **k: events.append(k.get("code")))
    run = {"settings": {}}
    with caplog.at_level(logging.INFO):
        out = subtext_check.chapter_pass(svc, run, {}, "c1", "chapter 1", "ch1")
    assert out is head and events == ["SUBTEXT_CHECK_FAILED"]
    assert not _errors(caplog)


def test_e126_a_bug_still_logs_its_traceback(monkeypatch, caplog):
    head = {"record_id": "c1", "module_id": "C02", "version": 2}
    monkeypatch.setattr(subtext_check, "_pass", lambda *a, **k: {}["missing"])
    svc = types.SimpleNamespace(bp=lambda run: types.SimpleNamespace(rec=lambda rid: head), save=lambda run: None,
                                event=lambda *a, **k: None)
    subtext_check.chapter_pass(svc, {"settings": {}}, {}, "c1", "chapter 1", "ch1")
    assert _errors(caplog)


# ====================================================================== E-12.11-g the keep-brief check
def test_e1211g_a_bug_in_the_keep_check_lets_the_fix_through(monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("bug")
    monkeypatch.setattr(keep_brief, "cosmetic", boom)
    job = types.SimpleNamespace(keep_kind="fix", keep_label="chapter 1")
    rec = {"module_id": "C02", "data": {"text": "One two three."}}
    assert keep_brief.guard_fix(job, rec, {"text": "One two three!"}, [], {}) is None


def test_e1211g_the_deliberate_refusals_still_refuse():
    job = types.SimpleNamespace(keep_kind="fix", keep_label="chapter 1")
    rec = {"module_id": "C02", "data": {"text": "Keep this line. Then more."}}
    with pytest.raises(AkoweError):
        keep_brief.guard_fix(job, rec, {"text": "Then more and more."}, ["Keep this line."], {})
    with pytest.raises(AkoweError):
        keep_brief.guard_fix(job, rec, {"text": "Keep this line; then more."}, [], {})


# ====================================================================== E-12.12-k checkpoint problems merged
def test_e1212k_the_same_problem_reported_many_times_is_one_problem():
    base = {"chapter": 2, "problem": "The stair count differs from chapter 1.", "quote": "nine stairs",
            "original": "nine stairs", "replacement": "twelve stairs"}
    probs = [dict(base, chapter=n) for n in (0, -5, 999, True)] + [dict(base, chapter="two"), dict(base, problem="")]
    probs += [dict(base)] * 34 + [dict(base, quote=" Nine  stairs ")] + [dict(base, original="x" * 5000)]
    part = {"chapter_ids": ["ch1", "ch2", "ch3"]}
    out = checkpoints._clean_problems({"problems": probs}, part, {}, ["ch1", "ch2", "ch3"])  # noqa: SLF001
    assert len(out) == 2  # the problem (35 reports) + the one with another (too big) fix
    assert out[0]["chapter_id"] == "ch2" and out[0]["reports"] == 35
    assert all(p["number"] == 2 for p in out)


# ====================================================================== E-13 the planned-details check
class _Always(list):
    """A fake AI's failure list that never runs out."""

    def __init__(self, exc):
        super().__init__([exc])

    def pop(self, *_a):
        return self[0]


@pytest.mark.parametrize("code", ["TIMEOUT", "AI_DECLINED"])
def test_e13af_a_planned_check_without_an_answer_never_stops_the_book(tmp_path, code):
    fake = SlotFake()
    fake.kind_failures["planned"] = _Always(AkoweError(code, "", "no"))  # every AI, every time
    app = make_app(tmp_path, fake)
    run = run_book(app, dict(OFF))
    assert run["status"] == "done", run.get("problem")
    assert "PLANNED_CHECK_FAILED" in _codes(run)  # (a refusal by every AI is reported under the failover's code)


def test_e13g_a_bug_in_the_planned_check_never_stops_the_book(tmp_path, monkeypatch):
    from akowe.planned import PlannedChecker
    app = make_app(tmp_path, SlotFake())

    def boom(*_a, **_k):
        raise RuntimeError("bug")
    monkeypatch.setattr(PlannedChecker, "check", boom)
    run = run_book(app, dict(OFF))
    assert run["status"] == "done", run.get("problem")
    assert any(e.get("code") == "PLANNED_CHECK_FAILED" and "INTERNAL_ERROR" in e["message"] for e in run["events"])
