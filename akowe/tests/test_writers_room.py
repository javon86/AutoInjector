"""🗳 The three-AI writers' room (writers_room.py): pitches, the blind vote, the tally, partial failures, the
single-AI brainstorm, using a pitch (a new draft, never an approval), the HTTP API and the optional ⚡ run setting.
All on the deterministic fake AI (each AI's pitch names its slot so the fake voter can tell them apart)."""
from __future__ import annotations

import random
import threading
import time
from collections import Counter

import pytest

from akowe import writers_room as wr
from akowe.book_path import BookPath
from akowe.errors import AkoweError

from test_failover_review import SlotFake, make_app, run_book


class RoomFake(SlotFake):
    """SlotFake + answers for the writers' room. Each pitch carries its slot in the title ("Pitch of AI-2"); a voter
    ranks the pitches it gets by ``prefer`` (slot order, best first) unless ``votes`` scripts its answer."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self._tl = threading.local()
        self.prefer = ["AI-1", "AI-2", "AI-3"]
        self.votes: dict = {}          # slot -> callable(ctx) | dict
        self.ballots: dict = {}        # slot -> the letters it was shown
        self.pitch_ctx: dict = {}

    def submit(self, slot, system, user, schema):
        self._tl.slot = slot["slot_id"]
        return super().submit(slot, system, user, schema)

    def _answer(self, ctx, props, schema):
        sid = getattr(self._tl, "slot", "?")
        if set(props) == set(wr.PITCH_PROPS):
            with self.lock:
                self.pitch_ctx[sid] = ctx
            return "room_pitch", {"title": f"Pitch of {sid}", "idea": f"The keeper is alive ({sid}). She hid on the "
                                  "reef.", "why_it_fits": "It fits the dark lighthouse.",
                                  "changes_later": "Mara must choose between them."}
        if set(props) == {"pitches"}:
            return "room_solo", {"pitches": [{"title": f"Idea {i}", "idea": f"Brainstorm idea {i}.",
                                              "why_it_fits": "fits", "changes_later": "later"} for i in (1, 2, 3)]}
        if set(props) == {"ranking"}:
            with self.lock:
                self.ballots[sid] = [p["letter"] for p in ctx.get("pitches") or []]
            v = self.votes.get(sid)
            if v is not None:
                return "room_vote", v(ctx) if callable(v) else v
            def score(p):
                who = p["title"].rsplit(" ", 1)[-1]
                return self.prefer.index(who) if who in self.prefer else 9
            ranked = sorted(ctx.get("pitches") or [], key=score)
            return "room_vote", {"ranking": [{"pitch": p["letter"], "reason": f"{sid} likes it"} for p in ranked]}
        return super()._answer(ctx, props, schema)


@pytest.fixture(scope="module")
def made(tmp_path_factory):
    """One finished book on three working fake AIs (shared by the tests that only read it or add drafts)."""
    fake = RoomFake()
    app = make_app(tmp_path_factory.mktemp("room"), fake)
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", run.get("problem")
    return app, fake, run["project_id"]


# ====================================================================== the pure parts
def _pitches(n=3, failed=()):
    return [{"slot": f"AI-{i}", "name": f"AI {i}", "title": f"T{i}", "idea": f"I{i}",
             "status": "failed" if f"AI-{i}" in failed else "done"} for i in range(1, n + 1)]


def test_anonymise_shuffles_and_letters_only_the_pitches_that_came_back():
    ps = _pitches(3, failed=("AI-2",))
    out = wr.anonymise(ps, random.Random(4))
    assert [p["letter"] for p in out] == ["A", "B"]
    assert {p["slot"] for p in out} == {"AI-1", "AI-3"}
    assert "letter" not in next(p for p in ps if p["slot"] == "AI-2")
    orders = {tuple(p["slot"] for p in wr.anonymise(_pitches(3), random.Random(s))) for s in range(30)}
    assert len(orders) > 1  # really shuffled: the letter does not tell who wrote it


def test_a_voter_never_sees_its_own_pitch_or_who_wrote_the_others():
    lettered = wr.anonymise(_pitches(3), random.Random(1))
    for p in lettered:
        b = wr.ballot(lettered, p["slot"])
        assert p["letter"] not in [x["letter"] for x in b] and len(b) == 2
        assert all("slot" not in x and "name" not in x for x in b)


def test_clean_vote_keeps_allowed_letters_once_in_order():
    raw = {"ranking": [{"pitch": "C", "reason": "own pitch"}, {"pitch": "Pitch B", "reason": "best"},
                       {"pitch": "b", "reason": "again"}, {"pitch": "Z", "reason": "unknown"},
                       {"pitch": "A", "reason": "ok"}, "junk"]}
    assert wr.clean_vote(raw, ["A", "B"]) == [{"letter": "B", "rank": 1, "reason": "best"},
                                              {"letter": "A", "rank": 2, "reason": "ok"}]
    assert wr.clean_vote(None, ["A"]) == [] and wr.clean_vote({"ranking": "x"}, ["A"]) == []


def _vote(slot, *letters, status="done"):
    return {"slot": slot, "status": status, "ranking": [{"letter": L, "rank": i + 1} for i, L in enumerate(letters)]}


LET = [{"letter": "A", "slot": "AI-1"}, {"letter": "B", "slot": "AI-2"}, {"letter": "C", "slot": "AI-3"}]


def test_tally_most_first_places_wins():
    t = wr.tally(LET, [_vote("AI-1", "B", "C"), _vote("AI-2", "A", "C"), _vote("AI-3", "B", "A")])
    assert t["winner"] == "B" and t["how"] == "votes"
    rows = {r["letter"]: r for r in t["rows"]}
    assert rows["B"]["first"] == 2 and rows["B"]["ballots"] == 2 and rows["C"]["rank_sum"] == 4


def test_tally_three_way_tie_goes_to_the_author():
    # each pitch gets one first place and one second place: the sums of ranks are equal too
    t = wr.tally(LET, [_vote("AI-1", "C", "B"), _vote("AI-2", "A", "C"), _vote("AI-3", "B", "A")])
    assert t["how"] == "tie" and t["winner"] is None and sorted(t["tie"]) == ["A", "B", "C"]
    assert wr.how_words(t).endswith("you choose.")
    # two pitches only (2 AIs): each votes for the other -> a tie, the author chooses
    t = wr.tally(LET[:2], [_vote("AI-1", "B"), _vote("AI-2", "A")])
    assert t["winner"] is None and t["how"] == "tie"


def test_tally_first_place_tie_is_broken_by_the_sum_of_ranks():
    # AI-3's vote is missing: B and C get one first place each; B is 1st on its only ballot, C is 1st and 2nd
    t = wr.tally(LET, [_vote("AI-1", "B", "C"), _vote("AI-2", "C", "A"), _vote("AI-3", "A", status="failed")])
    rows = {r["letter"]: r for r in t["rows"]}
    assert (rows["B"]["first"], rows["C"]["first"]) == (1, 1)
    assert (rows["B"]["rank_sum"], rows["C"]["rank_sum"]) == (1, 3) and rows["C"]["ballots"] == 2
    assert rows["A"]["ballots"] == 1
    assert t["winner"] == "B" and t["how"] == "rank_sum" and "sum of ranks" in wr.how_words(t)
    # a pitch left unranked counts as that voter's last
    t = wr.tally(LET, [{"slot": "AI-1", "status": "done", "ranking": [{"letter": "C", "rank": 1}]},
                       _vote("AI-2", "C", "A"), _vote("AI-3", "B", "A")])
    rows = {r["letter"]: r for r in t["rows"]}
    assert rows["B"]["rank_sum"] == 2 + 1 and t["winner"] == "C" and t["how"] == "votes"


def test_tally_with_no_votes():
    t = wr.tally(LET, [_vote("AI-1", "B", "C", status="failed")])
    assert t["winner"] is None and t["how"] == "no_votes" and wr.tally([], [])["how"] == "no_pitches"


def test_big_chapters():
    assert wr.big_chapters(6) == {5: "the climax", 3: "the midpoint"}
    assert wr.big_chapters(3) == {3: "the climax", 2: "the midpoint"}
    assert wr.big_chapters(1) == {1: "the climax"} and wr.big_chapters(0) == {}


# ====================================================================== a real room on the fake AIs
def test_room_on_the_plot_with_three_ais(made):
    app, fake, pid = made
    svc = wr.service_of(app)
    bp = BookPath(app.engine, "author", pid, "main")
    target = wr.resolve_target(bp, {"topic": "plot"})
    assert target["module_id"] == "B03"
    room = svc.hold("author", pid, "main", target, rng=random.Random(7))
    assert room["status"] == "done", room
    assert sorted(p["letter"] for p in room["pitches"]) == ["A", "B", "C"]
    own = {p["slot"]: p["letter"] for p in room["pitches"]}
    for slot, letters in fake.ballots.items():
        assert own[slot] not in letters and len(letters) == 2  # own pitch never on its ballot
    # the brief carries the book's promises and rules
    ctx = fake.pitch_ctx["AI-2"]["brief"]
    assert {"book_profile", "character_mode", "premise", "main_plot", "chapters", "characters"} <= set(ctx)
    assert "point_of_view" in ctx["book_profile"]
    # prefer AI-1 first: AI-2 and AI-3 put AI-1's pitch first -> it wins with two first places
    assert room["winner"] == own["AI-1"] and room["tally"]["how"] == "votes"
    assert all(v["status"] == "done" and v["ranking"][0]["reason"] for v in room["votes"])
    assert svc.room(pid, "main", room["id"])["winner"] == room["winner"]


def test_a_timeout_on_one_pitch_still_holds_the_room(made):
    app, fake, pid = made
    fake.fail_kind("room_pitch", AkoweError("TIMEOUT", "", "no answer in time"))
    svc = wr.service_of(app)
    room = svc.hold("author", pid, "main", {"topic": "question", "question": "What does the reef hide?",
                                            "label": "What does the reef hide?", "ask": "an answer"})
    assert room["status"] == "partial"
    failed = [p for p in room["pitches"] if p["status"] == "failed"]
    assert len(failed) == 1 and failed[0]["error"] == "TIMEOUT" and "did not answer in time" in room["message"]
    assert len([p for p in room["pitches"] if p.get("letter")]) == 2
    assert len([v for v in room["votes"] if v["status"] == "done"]) == 2
    # each of the two votes for the other: a tie, the author chooses
    assert room["winner"] is None and room["tally"]["how"] == "tie"


def test_only_one_pitch_back_means_no_vote(made):
    app, fake, pid = made
    fake.fail_kind("room_pitch", AkoweError("TIMEOUT", "", "x"), AkoweError("TIMEOUT", "", "y"))
    room = wr.service_of(app).hold("author", pid, "main", {"topic": "question", "question": "q?", "label": "q?",
                                                           "ask": "q"})
    assert room["status"] == "partial" and not room["votes"] and "nothing to vote on" in room["message"]


def test_a_busy_ai_is_waited_for_and_retried(made):
    app, fake, pid = made
    fake.fail_kind("room_pitch", AkoweError("RATE_LIMITED", "", "busy"))
    room = wr.service_of(app).hold("author", pid, "main", {"topic": "question", "question": "q?", "label": "q?",
                                                           "ask": "q"})
    assert room["status"] == "done" and len([p for p in room["pitches"] if p.get("letter")]) == 3


def test_using_a_pitch_makes_a_new_draft_and_never_approves(made):
    app, fake, pid = made
    svc = wr.service_of(app)
    bp = BookPath(app.engine, "author", pid, "main")
    plot = bp.approved("B03")[0]
    room = svc.hold("author", pid, "main", wr.resolve_target(bp, {"topic": "plot"}))
    out = svc.use("author", pid, "main", room["id"], {})
    ap = out["applied"]
    assert ap["module_id"] == "B03" and ap["version"] == plot["version"] + 1 and ap["had_approved"]
    bp = BookPath(app.engine, "author", pid, "main")
    new = bp.rec(plot["record_id"])
    assert new["lifecycle"] in ("DRAFT", "VALIDATED") and wr.NOTE in new["data"]["main_plot"]["summary"]
    assert bp.approved("B03")[0]["version"] == plot["version"]  # the approved text is untouched
    assert "approved version stays" in out["message"]
    assert svc.room(pid, "main", room["id"])["decided"]["letter"] == room["winner"]
    # pick another pitch: another new draft
    other = next(p["letter"] for p in room["pitches"] if p.get("letter") and p["letter"] != room["winner"])
    out2 = svc.use("author", pid, "main", room["id"], {"letter": other})
    assert out2["applied"]["version"] == ap["version"] + 1
    with pytest.raises(AkoweError):
        svc.use("author", pid, "main", room["id"], {"letter": "Z"})


def test_using_a_pitch_on_a_chapter_and_on_a_character(made):
    app, fake, pid = made
    svc = wr.service_of(app)
    bp = BookPath(app.engine, "author", pid, "main")
    outline = bp.outline()
    chs = bp.outline_chapters(outline)
    t = wr.resolve_target(bp, {"topic": "chapter", "chapter_id": chs[1]["chapter_id"]})
    assert t["number"] == 2
    room = svc.hold("author", pid, "main", t)
    assert "this_chapter" in fake.pitch_ctx["AI-1"]["brief"]
    out = svc.use("author", pid, "main", room["id"], {"letter": "A"})
    new = BookPath(app.engine, "author", pid, "main").rec(outline["record_id"])
    i = wr._chapter_index(new, chs[1]["chapter_id"])
    assert wr.NOTE in new["data"]["chapters"][i]["summary"] and out["applied"]["module_id"] == "B11"
    assert all(wr.NOTE not in c.get("summary", "") for j, c in enumerate(new["data"]["chapters"]) if j != i)
    hero = bp.approved("A01")[0]
    t = wr.resolve_target(bp, {"topic": "character", "record_id": hero["record_id"]})
    room = svc.hold("author", pid, "main", t)
    assert fake.pitch_ctx["AI-3"]["brief"]["this_character"]["name"] == t["name"]
    svc.use("author", pid, "main", room["id"], {"letter": "B"})
    rec = BookPath(app.engine, "author", pid, "main").rec(hero["record_id"])
    assert wr.NOTE in rec["data"]["attributes"]["background"] and rec["lifecycle"] != "APPROVED"
    # a free question: noted only, or written into the main plot when asked
    q = svc.hold("author", pid, "main", wr.resolve_target(bp, {"topic": "question", "question": "Who lit the lamp?"}))
    assert svc.use("author", pid, "main", q["id"], {"letter": "A"})["applied"] is None
    assert svc.use("author", pid, "main", q["id"], {"letter": "A", "into": "plot"})["applied"]["module_id"] == "B03"


def test_targets_are_checked(made):
    app, fake, pid = made
    bp = BookPath(app.engine, "author", pid, "main")
    for body in ({"topic": "nope"}, {"topic": "chapter", "chapter_id": "zzz"}, {"topic": "character"},
                 {"topic": "question", "question": " "}):
        with pytest.raises(AkoweError):
            wr.resolve_target(bp, body)


def test_room_api_and_job(made):
    app, fake, pid = made
    base = f"/api/projects/{pid}/branches/main/room"
    code, ov = app.route("GET", base, {}, None, "author", {})
    assert code == 200 and ov["has_plot"] and ov["chapters"] and ov["characters"]
    assert sum(1 for a in ov["ais"] if a["working"]) == 3
    code, job = app.route("POST", base, {}, {"topic": "plot"}, "author", {})
    assert code == 202
    for _ in range(400):
        code, j = app.route("GET", f"{base}/job/{job['id']}", {}, None, "author", {})
        if j["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    assert j["status"] == "done", j
    code, room = app.route("GET", f"{base}/{j['room_id']}", {}, None, "author", {})
    assert code == 200 and room["target"]["topic"] == "plot"
    code, nxt = app.route("POST", base, {}, {"round_of": room["id"]}, "author", {})
    for _ in range(400):
        code, j2 = app.route("GET", f"{base}/job/{nxt['id']}", {}, None, "author", {})
        if j2["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    code, r2 = app.route("GET", f"{base}/{j2['room_id']}", {}, None, "author", {})
    assert r2["round"] == room["round"] + 1 and set(r2["already_pitched"]) >= {p["title"] for p in room["pitches"]
                                                                                if p.get("title")}
    assert fake.pitch_ctx["AI-1"]["already_pitched"]
    code, used = app.route("POST", f"{base}/{room['id']}/use", {}, {"letter": "A"}, "author", {})
    assert code == 200 and used["applied"]["module_id"] == "B03"
    with pytest.raises(AkoweError):
        app.route("POST", base, {}, {"topic": "plot", "slot_id": 7}, "author", {})


# ====================================================================== fewer than two AIs
def test_one_ai_explains_and_offers_a_brainstorm(tmp_path):
    fake = RoomFake()
    app = make_app(tmp_path, fake, slots=("AI-1",))
    run = run_book(app, {"slot_id": "AI-1"})
    pid = run["project_id"]
    svc = wr.service_of(app)
    t = wr.resolve_target(BookPath(app.engine, "author", pid, "main"), {"topic": "plot"})
    room = svc.hold("author", pid, "main", t)
    assert room["status"] == "too_few" and "Only one AI is working" in room["message"]
    assert "Brainstorm with one AI" in room["message"] and "room_pitch" not in Counter(fake.kinds)
    solo = svc.hold("author", pid, "main", t, mode="solo")
    assert solo["status"] == "done" and [p["letter"] for p in solo["pitches"]] == ["A", "B", "C"]
    assert solo["tally"]["how"] == "solo" and solo["winner"] is None
    assert svc.use("author", pid, "main", solo["id"], {"letter": "C"})["applied"]["module_id"] == "B03"


# ====================================================================== inside ⚡ Make a book
def test_run_without_the_setting_holds_no_room(made):
    app, fake, pid = made
    # the shared book was made without the setting: its run held no room
    assert not [r for r in wr.service_of(app).rooms(pid, "main") if r.get("made_by") == "run"]


def test_run_with_the_writers_room(tmp_path):
    fake = RoomFake()
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1", "writers_room": True})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    rooms = [r for r in wr.service_of(app).rooms(pid, "main") if r.get("made_by") == "run"]
    topics = [r["target"]["topic"] for r in rooms]
    assert topics[0] == "plot" and topics.count("chapter") == 2
    assert all(r["decided"] and r["decided"]["by"] == "run" for r in rooms)
    evs = [e for e in run["events"] if e.get("code") == "WRITERS_ROOM"]
    assert len(evs) == 3 and "under your Make-a-book consent" in evs[0]["message"]
    # the plot was written with the winning twist as a constraint
    plot_ctx = fake.prompts["B03"][0][1]
    cons = plot_ctx["request_payload"]["constraints"]
    assert cons and wr.NOTE in cons[0]
    # the midpoint / climax chapters' scene plans got the decision
    chapter_rooms = [r for r in rooms if r["target"]["topic"] == "chapter"]
    cids = {r["target"]["chapter_id"] for r in chapter_rooms}
    planned = [c for _s, c in fake.prompts.get("scenes", []) if c.get("writers_room")] + \
        [c for k, v in fake.prompts.items() for _s, c in v if isinstance(c, dict) and c.get("writers_room")]
    assert planned, "the scene planner never got the writers' room decision"
    assert {wr.chapter_decision(app.store, pid, "main", c)["title"] for c in cids}
