"""A deterministic fake AI for Make-a-book tests (and the UI test server).

The answers themselves are the Practice AI's (``akowe/practice_ai.py``, adapter ``practice``): ``BookFakeAI`` is that
class plus the test-only hooks, so the fake the tests use and the Practice AI the author can pick never drift apart.
See practice_ai.py for what each kind of request gets (and the ``*_script`` lists that script particular answers).

Test-only hooks kept here:
* scripted failures: ``fail_next(*errors)`` raises them before answering, one per call; ``fail_kind(kind, *errors)``
  raises them instead of that kind of answer;
* ``gate`` (a threading.Event every call waits for; ``waiting`` is set once a call is blocked) and ``delay``;
* what was asked: ``calls`` (slot + schema keys), ``kinds`` (the answer kinds in order), ``prompts`` (kind ->
  [(task text, context)]) and ``craft_contexts`` (what the editor was sent);
* usage reads ``fake-book-model`` with 10 / 20 tokens;
* ``VOICES`` / ``sheet_for`` / ``NAMES`` / ``OBJECTIVES`` are this module's names (tests patch them here).
"""
from __future__ import annotations

import copy
import json
import threading

from akowe import practice_ai as _practice
from akowe.errors import AkoweError
from akowe.practice_ai import (  # noqa: F401 - re-exported for the tests
    CHAPTER_TEXT, DETAILS, GUARD_FIX, NAMES, OBJECTIVES, OPENING_A, OPENING_B, REVISE_NOTES, RULES, SCENE_PLACES,
    STORY_ROLES, TEXTURE, VOICES, PracticeAI, fact, plan_item, plan_review, sheet_for, trade_card_for,
)


def voice_for(name):
    """This module's VOICES (a test may replace it), else the Practice AI's default card for an unknown name."""
    v = VOICES.get(name)
    return copy.deepcopy(v) if v is not None else _practice.voice_for(name)


def trust_one_ai(app, run_id, timeout=120):
    """H6: with only one AI the run pauses at its first draft (nobody else checked it). Answer like an author who
    trusts that AI: ✔ approve it yourself, and the rest of this run too. Returns the stored run."""
    run = app.autobook.get(run_id)
    if run.get("status") == "paused" and (run.get("problem") or {}).get("code") == "NO_SECOND_AI":
        app.autobook.decide("author", run_id, {"action": "approve_anyway", "author_confirms": True,
                                               "for_rest_of_run": True})
        app.autobook.wait_for(run_id, timeout)
    return app.autobook.get(run_id)



class BookFakeAI(PracticeAI):
    def __init__(self, verdicts=None, default_verdict="APPROVE"):
        super().__init__(verdicts, default_verdict)
        self.max_chapters = 6                    # B11: short outlines keep the test runs fast (P15 tests raise it)
        self.calls: list[dict] = []
        self.failures: list[AkoweError] = []  # raised before answering, one per call
        self.kind_failures: dict[str, list] = {}  # answer kind -> errors raised instead of that answer
        self.gate = None  # threading.Event: when set to an unset Event, every call waits for it
        self.waiting = threading.Event()  # set once a call is blocked on the gate (tests wait on this, not a sleep)
        self.delay = 0.0
        self.kinds: list[str] = []
        self.craft_contexts: list[dict] = []     # what the editor was sent (tests check the pattern report etc.)
        self.prompts: dict[str, list] = {}       # answer kind -> [(task text, context)] (prompt checks in tests)

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

    # the test hooks: this module's names, looked up at call time (tests monkeypatch them here)
    def _seen_craft(self, ctx):
        self.craft_contexts.append(ctx)

    def _sheet_for(self, name, others=(), story_role=None):
        return sheet_for(name, others, story_role)

    def _voice_for(self, name):
        return voice_for(name)

    def _objectives(self):
        return self.objectives or OBJECTIVES
