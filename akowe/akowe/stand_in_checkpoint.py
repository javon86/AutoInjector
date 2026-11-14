"""🧑‍⚖️ The stand-in vote on a 🧭 continuity checkpoint question (``CHECKPOINT_WAITING``): the same vote and the same
rule as stand_in.py, for the problems a story check could not fix safely by itself.

**What the author is asked.** A checkpoint (checkpoints.py) pauses the run once when problems are left ``waiting``
(no small, safe fix was offered, the words were not found exactly once, two fixes touch the same words …). The author
answers the checkpoint AS A WHOLE: ▶ Continue (every waiting problem stays in the report, the book goes on) or fix
the chapter themselves first. There is no answer per problem, so a stand-in answers the whole checkpoint too — only
when EVERY waiting problem can be voted on and the AIs all agree on every one. Otherwise the whole checkpoint keeps
waiting for the author (never a part of it).

**One neutral A / B question per waiting problem** (``kind_of``), with the same ballot, letters in a random order per
AI, answer JSON and rule (``stand_in.tally``: at least two AIs, every one voted, all the same, all confident):

* ``fix`` — the checking AI offered a small fix that is safe NOW (an AI-written chapter, the words found exactly once
  in the current text, short): make that fix (``apply_fix``: it goes through the run's normal review loop, like any
  checkpoint fix) or leave the chapter as it is (``leave_as_is``: the problem stays in the report);
* ``go_on`` — any other waiting problem (no safe fix, or the author's own text): leave it as it is for now so the book
  goes on (``leave_as_is``) or stop until the author fixes it (``needs_author``). The AIs never write a fix here.

The stand-in decides only when every problem's vote is a go-ahead (``apply_fix`` / ``leave_as_is``). When the AIs all
agree a problem needs the author, it keeps waiting (``AGREED_WAIT``).

**Never anyone but the author** (``author_only_item``): a problem about the ending (in the book's last chapter, or
about the ending / climax), the plot or the outline (also "strays off its plan"), the main character (named in the
problem or the fix), point of view or tense, the author's content limits, a locked story detail or approved fact
(``checkpoints._locked``), or the lock list; a chapter that cannot be found. More than ``MAX_ITEMS`` waiting problems:
waits too (``TOO_MANY``). In each case the whole checkpoint waits for the author.

**Visible and reversible.** Like stand_in.apply: an event, the run's and the book's decision lists (run window,
decision history, 🏠 Book home), the "Decided for you" notification, the track record (one ``stand_in`` outcome per
voter), the outbox (codes only). ↩ Undo (``undo``): a problem the stand-in left as it is goes back on the author's
list ("Check later" in the report); a fix it made is reversed word for word and saved as a new draft for the author
to approve. The track-record outcomes are turned round. Votes that did not all agree are settled when the author
answers (``settle``): ▶ Continue with the chapter unchanged → ``leave_as_is`` was the author's choice.

Logs: codes and counts only.
"""
from __future__ import annotations

import copy
import logging
import re
import uuid

from . import checker_record
from . import stand_in as si
from .errors import AkoweError

log = logging.getLogger("akowe.stand_in")

CODE = "CHECKPOINT_WAITING"
MAX_ITEMS = 4
EXCERPT = 3000                # characters of the chapter around the quote that a voter reads
KIND_OPTIONS = {"fix": ("apply_fix", "leave_as_is"), "go_on": ("leave_as_is", "needs_author")}
GO_AHEAD = ("apply_fix", "leave_as_is")
_CANON = re.compile(r"\b(locked|book bible|canon|approved (fact|detail|record)s?|established fact)\b", re.I)
_PLAN = re.compile(r"\b(off (its|the) (plan|path)|strays?|planned|its plan|the plan)\b", re.I)
WORDS = {
    "TOO_MANY": "{n} problems wait at this story check — more than {m} for the AIs to vote on, so it waits for you",
    "NO_CHECKPOINT": "the story check it waits on cannot be found, so it waits for you",
    "AGREED_WAIT": "The AIs all agreed chapter {num}'s problem needs you — waiting for you",
}


def enabled(store) -> bool:
    return bool(si.settings(store).get("checkpoints"))


def waiting_on(run: dict) -> bool:
    prob = run.get("problem") or {}
    return run.get("status") == "paused" and run.get("pause_reason") == "problem" and prob.get("code") == CODE


def _branch(run) -> str:
    return run.get("branch_id") or "main"


def _cp_of(app, run, prob) -> dict | None:
    from . import checkpoints  # noqa: PLC0415
    cid = prob.get("checkpoint")
    if not cid:
        return None
    return next((c for c in checkpoints.items(app.store, run["project_id"], _branch(run)) if c.get("id") == cid), None)


def waiting_items(cp: dict | None) -> list[dict]:
    return [p for p in (cp or {}).get("problems") or [] if p.get("status") == "waiting"]


def _chapters(app, run) -> dict:
    from . import checkpoints  # noqa: PLC0415
    try:
        return checkpoints._texts(app.autobook, run)  # noqa: SLF001
    except Exception:  # noqa: BLE001
        return {}


def _words_of(p: dict) -> str:
    """What the problem is about (the problem and the change, never the whole chapter)."""
    return " ".join(str(p.get(k) or "") for k in ("problem", "original", "replacement"))


def _main_names(app, run) -> list[str]:
    try:
        from . import story_roles  # noqa: PLC0415
        prot = story_roles.protagonist_of(app.store, run["project_id"], _branch(run))
    except Exception:  # noqa: BLE001
        return ["?"]  # cannot tell: every problem may be about the main character (the author decides)
    name = str((prot or {}).get("name") or "")
    return [w for w in re.findall(r"[^\W\d_][\w'’-]*", name) if len(w) >= 3]


def touches_locked(words: str, detail: str) -> bool:
    """The problem is about this locked story detail ("Name: field: value", checkpoints._locked): it names whom or
    what the detail is about AND names the field, or shares at least two words of the fixed value."""
    from .review_loop import tokens  # noqa: PLC0415
    parts = str(detail).split(": ", 2)
    if len(parts) < 3:
        return si._touches(words, detail)  # noqa: SLF001
    name, field, value = parts
    tw = tokens(words)
    nt = tokens(name)
    named = len(tw & nt) >= min(2, len(nt)) if nt else name.strip().lower() in words.lower()
    if not named:
        return False
    if field.strip() and re.search(rf"\b{re.escape(field.strip())}\b", words, re.I):
        return True
    vt = tokens(value) - nt  # the value without the name it repeats
    return len(vt) >= 2 and len(tw & vt) >= 2


def author_only_item(app, run: dict, p: dict, chapters: dict, mains: list[str], locked: list[str]) -> str | None:
    """Why only the author may decide this waiting problem (a code of ``stand_in.AUTHOR_ONLY_WORDS``), else None."""
    cid = p.get("chapter_id")
    if not cid or cid not in chapters or p.get("source") == "akowe":
        return "NOT_A_DECISION"
    if si._is_last_chapter(app, run, {"module_id": "C02", "chapter_id": cid}):  # noqa: SLF001
        return "ENDING"
    words = _words_of(p)
    for c in ("POV_TENSE", "CONTENT_LIMIT", "ENDING", "PLOT"):
        if si._TOPIC[c].search(words):  # noqa: SLF001
            return c
    if _PLAN.search(str(p.get("problem") or "")):
        return "PLOT"
    if "?" in mains or any(re.search(rf"\b{re.escape(n)}\b", words, re.I) for n in mains):
        return "MAIN_CHARACTER"
    if _CANON.search(words) or any(touches_locked(words, d) for d in locked):
        return "APPROVED_FACT"
    if any(si._touches(words, lk) for lk in si._locks(run)):  # noqa: SLF001
        return "LOCK_LIST"
    return None


def kind_of(app, run: dict, p: dict, chapters: dict) -> str:
    """``fix`` when the offered fix is safe now (the same tests as checkpoints._fix), else ``go_on``."""
    from .checkpoints import MAX_FIX_ORIGINAL  # noqa: PLC0415
    o, r = str(p.get("original") or ""), str(p.get("replacement") or "")
    ch = chapters.get(p.get("chapter_id")) or {}
    text = str(ch.get("text") or "")
    if not o.strip() or not r.strip() or o.strip() == r.strip() or len(o) > MAX_FIX_ORIGINAL or text.count(o) != 1:
        return "go_on"
    try:
        rec = app.autobook.bp(run).rec(ch.get("record_id")) if ch.get("record_id") else None
        if rec is None or not app.autobook._ai_made(run, rec):  # noqa: SLF001 - never the author's own text
            return "go_on"
    except Exception:  # noqa: BLE001
        return "go_on"
    return "fix"


def _excerpt(text: str, at: str) -> str:
    i = text.find(at) if at else -1
    if i < 0:
        return text[:EXCERPT]
    lo = max(0, i - EXCERPT // 2)
    return text[lo:lo + EXCERPT]


def context_for(app, run: dict, cp: dict, p: dict, chapters: dict, locked: list[str], kind: str) -> dict:
    """The material every voter gets for one waiting problem (the same for each; only the A / B order differs)."""
    text = str((chapters.get(p.get("chapter_id")) or {}).get("text") or "")
    flags = [si._clip(x.get("problem"), 200) for x in cp.get("problems") or []  # noqa: SLF001
             if x.get("source") == "akowe" and x.get("chapter_id") == p.get("chapter_id")][:4]
    ctx = {"subject": f"Chapter {p.get('number')}", "finding": si._clip(p.get("problem"), 400),  # noqa: SLF001
           "quote": si._clip(p.get("quote"), 400), "severity": p.get("severity") or "",  # noqa: SLF001
           "why_it_waits": si._clip(p.get("why"), 200),  # noqa: SLF001
           "reviewer_now": [], "chapter_text": _excerpt(text, p.get("original") or p.get("quote") or ""),
           "story_so_far": si._clip(cp.get("summary"), 1200),  # noqa: SLF001
           "approved_canon": {"locked_details": locked[:30]},
           "no_ai_checks": {"passed": not flags, "problems": flags}}
    if kind == "fix":
        ctx["proposed_fix"] = {"original": si._clip(p.get("original"), 600),  # noqa: SLF001
                               "replacement": si._clip(p.get("replacement"), 900)}  # noqa: SLF001
    return ctx


def decide(app, run: dict, prob: dict, key: str, stg: dict, now: float) -> dict:
    """stand_in.consider for a checkpoint question: vote on every waiting problem; decide only when every vote is a
    unanimous go-ahead. Called with the run lock held, after the wait time and the per-run cap."""
    ab = app.autobook
    run_id = run["id"]
    cp = _cp_of(app, run, prob)
    items = waiting_items(cp)
    if cp is None or not items:
        return si._tried(ab, run, key, "AUTHOR_ONLY:NOT_A_DECISION", WORDS["NO_CHECKPOINT"])  # noqa: SLF001
    if len(items) > MAX_ITEMS:
        return si._tried(ab, run, key, "TOO_MANY", WORDS["TOO_MANY"].format(n=len(items), m=MAX_ITEMS))  # noqa: SLF001
    from . import checkpoints  # noqa: PLC0415
    chapters = _chapters(app, run)
    mains = _main_names(app, run)
    locked = checkpoints._locked(app.store, run["project_id"], _branch(run))  # noqa: SLF001
    for p in items:
        why = author_only_item(app, run, p, chapters, mains, locked)
        if why:
            return si._tried(ab, run, key, "AUTHOR_ONLY:" + why,  # noqa: SLF001
                             f"Only you can decide chapter {p.get('number')}'s problem: "
                             f"{si.AUTHOR_ONLY_WORDS.get(why, why)}")
    vs = si.voters(app, run, prob)
    few = si.too_few(vs)  # the extra 🤖 helper voters never make up the two AIs
    if few:
        return si._tried(ab, run, key, few, si.wait_words(few, [], vs))  # noqa: SLF001
    results = []
    all_votes: list[dict] = []
    for p in items:
        kind = kind_of(app, run, p, chapters)
        base = context_for(app, run, cp, p, chapters, locked, kind)
        votes: list[dict] = []
        for voter in vs:
            ctx, order = si.ballot(base, KIND_OPTIONS[kind])
            votes.append(si.ask(app, run, voter, ctx, order))
            if not si.still_possible(votes):
                break  # this vote already rules a decision out: the others are not asked
        pick, code = si.tally(votes, len(vs))
        ver = (chapters.get(p.get("chapter_id")) or {}).get("version")
        results.append({"id": p["id"], "number": p.get("number"), "chapter_id": p.get("chapter_id"), "kind": kind,
                        "pick": pick, "code": code, "votes": votes, "version": ver,
                        "original": p.get("original") or "", "replacement": p.get("replacement") or "",
                        "problem": si._clip(p.get("problem"), 160)})  # noqa: SLF001
        all_votes += votes
        log.info("stand-in %s: checkpoint vote %s (%s)", run_id, code,
                 ",".join(f"{v['family']}={v['pick'] if v['state'] == 'voted' else v['state']}" for v in votes))
        if pick not in GO_AHEAD:
            break  # this problem keeps the checkpoint waiting: the next ones are not asked
    last = results[-1]
    if last["pick"] in GO_AHEAD and len(results) == len(items):
        return apply(app, run_id, prob, cp["id"], results, vs, now=now, waited_min=stg["wait_min"])
    fresh = ab.get(run_id) or run
    if not waiting_on(fresh) or si._key(fresh.get("problem") or {}) != key:  # noqa: SLF001
        return {"code": "ANSWERED"}  # the author answered while the AIs were voting
    si._state(fresh)["votes"][key] = [{"f": v["family"], "p": v["pick"], "c": r["chapter_id"], "v": r["version"]}  # noqa: SLF001
                                      for r in results for v in r["votes"] if v["state"] == "voted" and v["pick"]]
    if last["pick"] == "needs_author":
        code, words = "AGREED_WAIT", WORDS["AGREED_WAIT"].format(num=last["number"])
    else:
        code, words = last["code"], si.wait_words(last["code"], last["votes"], vs)
        if len(items) > 1:
            words = f"Chapter {last['number']}'s problem: {words[:1].lower()}{words[1:]}"
    return si._tried(ab, fresh, key, code, words, votes=all_votes)  # noqa: SLF001


def agreed_words(results: list[dict]) -> str:
    left = [r for r in results if r["pick"] == "leave_as_is"]
    fixed = [r for r in results if r["pick"] == "apply_fix"]

    def chs(rs):
        nums = sorted({r["number"] for r in rs if r.get("number") is not None})
        return ("chapter " if len(nums) == 1 else "chapters ") + si._and([str(n) for n in nums])  # noqa: SLF001
    parts = []
    if fixed:
        parts.append(f"make the suggested fix{'es' if len(fixed) > 1 else ''} in {chs(fixed)}")
    if left:
        parts.append(f"leave {'the story-check problem' if len(left) == 1 else f'{len(left)} story-check problems'} "
                     f"in {chs(left)} as {'it is' if len(left) == 1 else 'they are'} for now (in the report for you)")
    return " and ".join(parts)


def apply(app, run_id: str, prob: dict, cp_id: str, results: list[dict], vs: list[dict], *, now: float,
          waited_min: int) -> dict:
    """Carry out what every AI agreed on, then resume the run (the checkpoint finishes: the fixes the AIs chose go
    through the normal review loop first)."""
    from . import checkpoints  # noqa: PLC0415
    ab = app.autobook
    run = ab.get(run_id)
    key = si._key(prob)  # noqa: SLF001
    all_votes = [v for r in results for v in r["votes"]]
    if not run or not waiting_on(run) or ab.alive(run_id) or si._key(run.get("problem") or {}) != key:  # noqa: SLF001
        return {"code": "ANSWERED"}
    cp = _cp_of(app, run, prob)
    chapters = _chapters(app, run)
    by_id = {p["id"]: p for p in waiting_items(cp)}
    if cp is None or set(by_id) != {r["id"] for r in results} or any(
            (chapters.get(r["chapter_id"]) or {}).get("version") != r["version"] for r in results):
        return si._tried(ab, run, key, "CHANGED", "The chapters changed while the AIs read them, so it waits "  # noqa: SLF001
                         "for you", votes=all_votes)
    did = "dec-" + uuid.uuid4().hex[:10]
    for r in results:
        p = by_id[r["id"]]
        p["stand_in"] = {"id": did, "choice": r["pick"]}
        if r["pick"] == "apply_fix":
            p["status"], p["why"] = "new", ""  # checkpoints._run_one makes the fix and reviews it on ▶ resume
        else:
            p["why"] = (f"{p.get('why') or 'it needs you'}; your stand-in left it as it is (every AI agreed)")[:300]
    checkpoints._put(app.store, run["project_id"], _branch(run), cp)  # noqa: SLF001
    voters = [v for v in results[0]["votes"]]
    names = [v["name"] for v in voters]
    fams = [v["family"] for v in voters]
    what = agreed_words(results)
    line = (f"{si.who_words(voters)} {'both agreed' if len(names) == 2 else 'all agreed'} to {what} at "
            f"{si._clock(now)} {si.because(waited_min)}, so the book went on.")  # noqa: SLF001
    why = next((v.get("why") for v in all_votes if v.get("why")), "")
    line += f" Why: {why}" if why else ""
    subject = f"the story check after chapter {cp.get('after')}"
    d = {"id": did, "at": si._iso(now), "run_id": run_id, "who": "vote", "family": "+".join(fams),  # noqa: SLF001
         "name": si.who_words(voters), "choice": "checkpoint", "code": CODE,
         "confidence": min(float(v["confident"]) for v in all_votes), "reason": why,
         "votes": si._shown_votes(all_votes), "subject": subject, "record_id": prob.get("record_id"),  # noqa: SLF001
         "chapter_id": prob.get("chapter_id"), "checkpoint": cp_id, "waited_min": waited_min, "line": line,
         "undone": False,
         "items": [{k: r[k] for k in ("id", "number", "chapter_id", "kind", "pick", "original", "replacement",
                                      "problem")} for r in results]}
    sst = si._state(run)  # noqa: SLF001
    sst["count"] = int(sst["count"]) + 1
    sst["decisions"] = (sst["decisions"] + [d])[-20:]
    sst["tried"][key] = {"code": "DECIDED", "at": d["at"]}
    checker_record.note_many(app.store, [(f, "stand_in", "confirmed") for f in fams], ref=did)
    run["notice"] = {"key": did, "title": f"Decided for you: “{si._clip(run.get('title') or 'your book', 60)}”",  # noqa: SLF001
                     "body": si._clip(f"{line} Open Akọwe to undo it.", 300), "at": d["at"]}  # noqa: SLF001
    si._book_put(app.store, run, d)  # noqa: SLF001
    with app.store.transaction() as tx:
        tx.insert_outbox(run["project_id"], _branch(run), "autobook.stand_in_decided",
                         {"record_id": prob.get("record_id"), "run_id": run_id, "decider": "vote", "voters": fams,
                          "choice": "checkpoint", "picks": [r["pick"] for r in results], "checkpoint": cp_id,
                          "confidence": d["confidence"], "decision_id": did,
                          "label": "Decided by the AIs, all agreeing (the author's stand-in, switched on in "
                                   "Settings), because the author did not answer in time; the author can undo it"})
    ab.event(run, "note", f"🧑‍⚖️ {line}", code="STAND_IN_DECIDED", decision_id=did, step="chapters")
    ab.save(run)
    log.info("stand-in %s: decided checkpoint (%s by %s)", run_id, ",".join(r["pick"] for r in results),
             "+".join(fams))
    try:
        ab.resume(run["principal"], run_id)
    except AkoweError as exc:  # e.g. another run works now: the author resumes this one
        log.info("stand-in %s: could not resume (%s)", run_id, exc.code)
        run = ab.get(run_id) or run
        run["problem"] = {"code": "STAND_IN_DECIDED", "message": line, "options": ["retry"],
                          "fix": "Press ▶ Resume to carry on.", "at": si._iso(now)}  # noqa: SLF001
        ab.save(run)
    return {"code": "DECIDED", "decision_id": did, "who": "vote", "voters": fams, "choice": "checkpoint",
            "picks": [r["pick"] for r in results]}


def settle(store, run: dict, prob: dict, action: str | None, chapters: dict | None = None) -> list[tuple]:
    """The author answered a checkpoint the AIs did not all agree on. ▶ Continue with the chapter unchanged: the
    author left it as it is (``leave_as_is`` confirmed, other votes overruled); a chapter the author changed, or
    "I edited it": that vote is dropped uncounted. The caller saves the run. Never raises."""
    try:
        pend = ((run.get("stand_in") or {}).get("votes") or {}).pop(si._key(prob), None)  # noqa: SLF001
        if not pend or action is None:
            return []
        rows = []
        for v in pend:
            ch = (chapters or {}).get(v.get("c")) or {}
            if chapters is not None and ch.get("version") != v.get("v"):
                continue  # the author changed this chapter: their answer is not "leave it as it is"
            rows.append((v["f"], "stand_in", "confirmed" if v.get("p") == "leave_as_is" else "overruled"))
        checker_record.note_many(store, rows)
        return rows
    except Exception:  # noqa: BLE001
        log.debug("could not settle the checkpoint votes", exc_info=True)
        return []


def undo(app, run: dict, d: dict) -> dict:
    """↩ Undo a checkpoint decision: what it left as it is goes back on the author's list; a fix it made is reversed
    word for word as a new draft for the author to approve. All or nothing (nothing changes when one cannot be)."""
    from . import checkpoints  # noqa: PLC0415
    from .book_path import problems  # noqa: PLC0415
    from .review import plain_problem  # noqa: PLC0415
    ab = app.autobook
    cp = _cp_of(app, run, {"checkpoint": d.get("checkpoint")})
    if cp is None:
        raise AkoweError("NOT_FOUND", "/decision_id", "this story check is not there any more (nothing was changed)",
                         status="REJECTED")
    if ab.alive(run["id"]) and cp.get("status") not in ("done", "incomplete"):
        raise AkoweError("VERSION_CONFLICT", "/run", "the run is still working on this story check; pause it first "
                         "(nothing was changed)", status="REJECTED")
    by_id = {p["id"]: p for p in cp.get("problems") or []}
    chapters = _chapters(app, run)
    bp = ab.bp(run)
    reverse: dict[str, list[dict]] = {}
    for it in d.get("items") or []:
        p = by_id.get(it["id"])
        if p is None:
            continue
        if it["pick"] == "apply_fix" and p.get("status") in ("applied", "fixed"):
            reverse.setdefault(it["chapter_id"], []).append(it)
    drafts = []
    for cid, its in reverse.items():
        ch = chapters.get(cid) or {}
        head = bp.rec(ch.get("record_id")) if ch.get("record_id") else None
        data = copy.deepcopy((head or {}).get("data") or {})
        text = str(data.get("text") or "")
        for it in its:
            if not it.get("replacement") or text.count(it["replacement"]) != 1:
                raise AkoweError("VERSION_CONFLICT", "/record_id", f"chapter {it.get('number')} changed since the "
                                 "stand-in's fix; open it and edit it yourself (nothing was changed)", status="REJECTED")
            text = text.replace(it["replacement"], it["original"], 1)
        data["text"] = text
        drafts.append((head, data))
    for head, data in drafts:
        resp = bp.dispatch(head["module_id"], "UPDATE", base_ref=head["ref"], payload=data)
        if resp["status"] != "DRAFT" or not resp.get("output_refs"):
            raise AkoweError("INVALID_INPUT", "/decision_id", "Akọwe's checks refused the chapter without the fix: "
                             + plain_problem(problems(resp)) + " — edit it yourself", status="REJECTED")
    later = run.setdefault("check_later", [])
    for it in d.get("items") or []:
        p = by_id.get(it["id"])
        if p is None:
            continue
        p["stand_in"] = dict(p.get("stand_in") or {}, undone=True)
        if it["pick"] == "apply_fix":
            p.update(status="waiting", why="you undid the stand-in's fix: the words before it are back as a draft "
                                            "for you to approve")
        else:
            p["why"] = "you undid the stand-in's choice to leave it as it is: it waits for you"
        ln = f"Chapter {it.get('number')}: {it.get('problem')} — the stand-in's choice was undone: fix it yourself"
        if ln not in later:
            later.append(ln)
    checkpoints._put(app.store, run["project_id"], _branch(run), cp)  # noqa: SLF001
    fixed = any(it["pick"] == "apply_fix" for it in d.get("items") or [])
    return {"what": ("the chapter without the stand-in's fix is back as a draft for you to approve, and the problems "
                     "are back on your list (🧭 Continuity page)") if fixed else
            "the problems are back on your list (🧭 Continuity page and “Check later”)",
            "version": None}
