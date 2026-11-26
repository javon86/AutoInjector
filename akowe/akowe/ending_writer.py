"""🎬 The ending writer and the fact-citing plan: the climax and the last chapter are written against their own
checklist, and every chapter's writer is first shown the established facts its plan relies on, each with its source.

Why (docs: "AI novel quality beyond eight", recommendation 9): AI endings default to the calm, upward-turning arc and
the climax comes out thin (Tian et al.); giving the ending its own writer with its own instructions about the
ending's job was preferred by human readers (Agents' Room). And a writer that first quotes the specific earlier facts
and events its chapter builds on, then plans, then drafts, beat the alternatives in almost every comparison (Gurung &
Lapata) — the steps can be copied with ordinary instructions.

What it adds in a ⚡ Make-a-book run (no AI call of its own; plain reads of what the book already holds):

* **The ending brief** (run setting ``ending_writer``, on unless switched off): the last chapter — and the climax
  chapter of the author's story shape — gets ``writing_brief.ending_brief``: its role (ending / climax) and the whole
  ending checklist: every 📜 promise-ledger set-up not yet paid off (promise_ledger.py), the main plot's obligations,
  the main character's want / need / how far they may change, the book's question, the kind of story's promise, and
  the AI-habit list as "Must hold:" lines (ai_defaults.py: no calm, tidy "everyone accepts it" scene, an antagonist
  who keeps their conviction, a theme never stated, a choice that costs something). One rule tells the writer to
  check every line before and after drafting. The chapter reviewer gets the same checklist (``review_extra``), so
  the normal review of that chapter is also a review against the checklist (REVISE when one line fails), and the
  review fix sees it too; the final 🎯 ending check (ending_check.py) still reads the whole book afterwards.
* **The facts to cite** (run setting ``fact_plan``, on unless switched off): every chapter after the first gets
  ``writing_brief.facts_to_cite`` — at most ``MAX_FACTS`` established facts its plan relies on, each with the chapter
  it comes from: the set-ups of earlier chapters whose payoff window is open here, and the 📒 story ledger's facts of
  earlier chapters (what happened, who learned what, what someone gained, lost or suffered, relationships, numbers)
  that share the plan's names and words (not when the chapter has a 🧠 needs list: its earlier moments already
  quote the earlier chapters). The rule: plan the chapter on these facts first, never contradict one.
  What the story ledger, the needs list and the continuity part already give in full stays as it is — this is the
  short, cited list on top.

Off outside a ⚡ run (the run notes its choice for the book, ``note_run``); never raises into the writer's brief.
Logs carry counts only.
"""
from __future__ import annotations

import logging
import re

log = logging.getLogger("akowe.ending_writer")

FLAG_KEY = "ending_writer:{pid}:{branch}"
SETTINGS = ("ending_writer", "fact_plan")
MAX_PAYOFFS = 8
MAX_OBLIGATIONS = 6
MAX_FACTS = 8
LINE_MAX = 260
FACT_MAX = 220
CHECKLIST_BUDGET = 2600
FACTS_BUDGET = 1600
HABITS = ("ending_not_calm", "antagonist_conviction", "theme_unstated", "costly_choice")

ENDING_RULE = (
    "This chapter is the book's ENDING (context.writing_brief.ending_brief). Before you write, go through every line "
    "of ending_brief.checklist and plan how the page delivers it; after drafting, check each one again. Every “Pay "
    "off:” line pays off ON THE PAGE, in action, and costs or changes something — never as a summary. Each plot "
    "obligation is settled (or deliberately, visibly left open). The main character changes exactly as far as their "
    "sheet allows — not more, not less. The ending answers the book's question, or leaves it deliberately open on the "
    "page. Every “Must hold:” line holds — the habits of AI-written endings are avoided: no calm closing scene where "
    "everyone accepts what happened and every loose end is tied; something stays hard, costly or open.")
CLIMAX_RULE = (
    "This chapter is the book's CLIMAX (context.writing_brief.ending_brief): the biggest, hardest moment of the book. "
    "Before you write, go through ending_brief.checklist: the “Pay off:” lines may be paid off here, the main "
    "character makes the choice that costs them most, the opposing force keeps its conviction and is at its "
    "strongest, nothing is solved by luck or by someone else. Every “Must hold:” line holds.")
REVIEW_NOTE = (
    "context.ending_brief is the checklist this chapter was written against (the book's ending or climax). Check the "
    "chapter against every line; when one is not met on the page (a payoff missing or only summarised, a calm tidy "
    "acceptance ending, a stated theme, an antagonist who softens, a change beyond what the sheet allows), say so in "
    "reasons and suggested_changes (REVISE).")
FACT_RULE = (
    "Facts this chapter relies on (context.writing_brief.facts_to_cite): established facts from the earlier chapters "
    "and the plan, each with the chapter it comes from. Before you write, plan the chapter on them: each scene agrees "
    "with every fact (the same names, objects, injuries, who knows what, how people stand with each other), and a fact "
    "the plan builds on is shown or referred to on the page — never contradicted, never forgotten.")

_WORD = re.compile(r"[A-Za-z][A-Za-z'’-]{2,}")
_STOP3 = {"the", "and", "but", "for", "was", "had", "has", "her", "his", "she", "him", "you", "not", "are", "all",
          "one", "out", "who", "its", "off", "now", "got", "did", "can", "say", "see", "get", "too", "yet", "any",
          "our", "how", "why", "let", "own", "may", "via", "per", "set"}


# ====================================================================== settings
def clean_run_option(body: dict) -> dict:
    """``ending_writer`` and ``fact_plan`` from a ⚡ start body: on unless switched off."""
    from .errors import AkoweError  # noqa: PLC0415
    out = {}
    for k in SETTINGS:
        v = (body or {}).get(k, True)
        if not isinstance(v, bool):
            raise AkoweError("INVALID_INPUT", f"/{k}", f"{k} must be true or false", status="REJECTED")
        out[k] = v
    return out


def note_run(store, run: dict) -> None:
    """Remember for the book what this run chose (the writer's brief and the reviewer read it). Never raises."""
    try:
        s = run.get("settings") or {}
        store.set_setting(FLAG_KEY.format(pid=run["project_id"], branch=run["branch_id"]),
                          {k: s.get(k) is not False for k in SETTINGS} | {"run": run.get("id")})
        key = FAULT_KEY.format(pid=run["project_id"], branch=run["branch_id"])
        cur = store.get_setting(key)
        if not isinstance(cur, dict) or cur.get("run") != run.get("id"):
            store.set_setting(key, {"run": run.get("id")})  # a new run: the faults of an older one are forgotten
    except Exception:  # noqa: BLE001
        log.exception("could not note the ending-writer settings")


def flags(store, pid: str, branch: str) -> dict:
    """{ending_writer, fact_plan}: both False unless a ⚡ run turned them on for this book."""
    try:
        v = store.get_setting(FLAG_KEY.format(pid=pid, branch=branch))
    except Exception:  # noqa: BLE001
        v = None
    v = v if isinstance(v, dict) else {}
    return {k: v.get(k) is True for k in SETTINGS}


# ====================================================================== helpers
def _clip(v, n: int = LINE_MAX) -> str:
    s = re.sub(r"\s+", " ", str(v or "")).strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _order(outline: dict | None) -> list[str]:
    from .book_path import BookPath  # noqa: PLC0415
    return [c["chapter_id"] for c in BookPath.outline_chapters(None, outline)] if outline else []


def _approved(store, pid: str, branch: str, op: str) -> dict:
    try:
        heads = [r for r in store.list_records(pid, branch) if r["module_id"] == op and r.get("approved_version")
                 and not r.get("stale")]
        rec = store.get_record(pid, branch, heads[-1]["record_id"], heads[-1]["approved_version"]) if heads else None
        return (rec or {}).get("data") or {}
    except Exception:  # noqa: BLE001
        return {}


def _text_of(x) -> str:
    from .ending_check import _text_of as text_of  # noqa: PLC0415
    return text_of(x)


def _fit(lines: list[str], budget: int) -> list[str]:
    out, used = [], 0
    for x in lines:
        if used + len(x) > budget:
            break
        out.append(x)
        used += len(x)
    return out


# ====================================================================== 🎬 the ending brief
def chapter_role(store, pid: str, branch: str, outline: dict | None, chapter_id: str) -> tuple[str, int, int] | None:
    """("ending" | "climax", chapter number, chapters) — the last chapter, or the chapter the story shape's climax
    beat is placed on (not the last); None for every other chapter."""
    order = _order(outline)
    if chapter_id not in order or len(order) < 2:
        return None
    n, num = len(order), order.index(chapter_id) + 1
    if num == n:
        return "ending", num, n
    try:
        from . import story_shape  # noqa: PLC0415
        m = story_shape.mapping(store, pid, branch, outline) or {}
        if any(b.get("id") == "climax" and b.get("chapter_id") == chapter_id for b in m.get("beats") or []):
            return "climax", num, n
    except Exception:  # noqa: BLE001
        log.exception("climax chapter")
    return None


def checklist(store, pid: str, branch: str, outline: dict | None, role: str, number: int) -> list[str]:
    """The ending checklist in plain lines (payoffs first, then the plot, the main character, the question, the kind
    of story's promise and the AI habits to avoid), within ``CHECKLIST_BUDGET`` characters."""
    pay, rest = [], []
    try:
        from . import promise_ledger  # noqa: PLC0415
        for r in promise_ledger.status(store, pid, branch, outline):
            if r["status"] == "resolved" or (role == "climax" and r["payoff_from"] > number):
                continue
            pay.append(_clip(f"Pay off: {r['payoff']} (set up in chapter {r['plant']}: {r['promise']})"))
    except Exception:  # noqa: BLE001
        log.exception("ending brief: the promise ledger")
    plot = _approved(store, pid, branch, "B03")
    for x in (plot.get("plot_obligations") or [])[:MAX_OBLIGATIONS]:
        t = _clip(_text_of(x), 220)
        if t:
            rest.append(f"Plot obligation{' to settle' if role == 'ending' else ''}: {t}")
    try:
        from . import characters as chars_mod  # noqa: PLC0415
        from . import story_roles  # noqa: PLC0415
        prot = story_roles.protagonist_of(store, pid, branch)
        if prot:
            sheet = ((chars_mod.all_entries(store, pid, branch).get(prot["record_id"]) or {}).get("sheet")) or {}
            bits = [f"wants {_clip(sheet.get('wants') or sheet.get('want'), 160)}" if sheet.get("wants") or
                    sheet.get("want") else "",
                    f"needs {_clip(sheet.get('needs') or sheet.get('need'), 160)}" if sheet.get("needs") or
                    sheet.get("need") else "",
                    f"may change only this far: {_clip(sheet.get('change_limits'), 200)}"
                    if sheet.get("change_limits") else ""]
            bits = [b for b in bits if b]
            if bits:
                rest.append(_clip(f"The main character, {prot['name']}: " + "; ".join(bits), 420))
    except Exception:  # noqa: BLE001
        log.exception("ending brief: the main character")
    try:
        from .book_path import get_profile  # noqa: PLC0415
        prem = _approved(store, pid, branch, "B01")
        q = [x for x in (_clip(prem.get("dramatic_question"), 300), _clip(get_profile(store, pid).get(
            "central_question"), 300)) if x]
        if q:
            rest.append("The book's question (answer it on the page, or leave it deliberately open on the page): "
                        + " / ".join(dict.fromkeys(q)))
    except Exception:  # noqa: BLE001
        log.exception("ending brief: the question")
    try:
        from . import story_kind  # noqa: PLC0415
        kp = story_kind.ending_promise(store, pid, final=True)
        if kp and kp.get("label"):
            rest.append(_clip(f"The kind of story's promise: {kp['label']}", 320))
    except Exception:  # noqa: BLE001
        log.exception("ending brief: the kind of story")
    from . import ai_defaults  # noqa: PLC0415
    habits = [f"Must hold: {c[3]}" for c in ai_defaults.CHECKS if c[0] in HABITS and c[3]
              and not (role == "climax" and c[0] == "ending_not_calm")]
    pay = pay[:MAX_PAYOFFS]
    return _fit(pay + rest + habits, CHECKLIST_BUDGET)


def ending_brief(store, pid: str, branch: str, outline: dict | None, chapter_id: str) -> dict | None:
    """{role, chapter, chapters, checklist} for the last / climax chapter of a book whose run uses the ending writer,
    else None. Never raises: a fault while the checklist is made is remembered for the chapter (``_fault``) and the
    run says it once the chapter is written (``after_write``)."""
    role = number = None
    try:
        if not flags(store, pid, branch)["ending_writer"]:
            return None
        r = chapter_role(store, pid, branch, outline, chapter_id)
        if not r:
            return None
        role, number, n = r
        lines = checklist(store, pid, branch, outline, role, number)
        return {"role": role, "chapter": number, "chapters": n, "checklist": lines} if lines else None
    except Exception as exc:  # noqa: BLE001
        log.exception("ending brief")
        if role:
            _fault(store, pid, branch, chapter_id, role, number, type(exc).__name__)
        return None


# ====================================================================== a checklist that could not be made: said
FAULT_KEY = "ending_writer_faults:{pid}:{branch}"


def _fault(store, pid: str, branch: str, chapter_id: str, role: str, number, code: str) -> None:
    """Remember that the ending checklist of this chapter could not be made (codes only). Never raises."""
    try:
        key = FAULT_KEY.format(pid=pid, branch=branch)
        cur = store.get_setting(key)
        cur = cur if isinstance(cur, dict) else {}
        if not isinstance(cur.get(chapter_id), dict):
            cur[chapter_id] = {"role": role, "chapter": number, "code": str(code)[:60], "said": False}
            store.set_setting(key, cur)
    except Exception:  # noqa: BLE001
        log.exception("could not note the ending brief fault")


def after_write(svc, run: dict, chapter_id: str) -> None:
    """After a chapter is written: if its ending checklist could not be made, say so once (a ⚠️ journal note,
    ENDING_BRIEF_FAILED) and list it for the author's check later. Never raises except the run's pause / cancel."""
    try:
        pid, branch = run["project_id"], run["branch_id"]
        key = FAULT_KEY.format(pid=pid, branch=branch)
        cur = svc.store.get_setting(key)
        f = cur.get(chapter_id) if isinstance(cur, dict) and chapter_id != "run" else None
        if not isinstance(f, dict) or f.get("said"):
            return
        what = "the climax" if f.get("role") == "climax" else "the last chapter"
        num = f.get("chapter")
        svc.event(run, "note", f"⚠️ The ending checklist of {what} (chapter {num}) could not be made ({f.get('code')}); "
                  "the chapter was written without it — the final ending check still reads the whole book, and it "
                  "is listed for you to check later", step="chapters", code="ENDING_BRIEF_FAILED")
        later = run.setdefault("check_later", [])
        line = f"Chapter {num}: written without its ending checklist (check that the ending pays off what the book " \
               "set up)"
        if line not in later:
            later.append(line)
        f["said"] = True
        svc.store.set_setting(key, cur)
        svc.save(run)
    except Exception as exc:  # noqa: BLE001
        if getattr(exc, "control", False):
            raise
        log.exception("could not say the ending brief fault")


# ====================================================================== 📌 the facts to cite
def _lemmas(text: str) -> set[str]:
    from .planned import _STOP  # noqa: PLC0415
    from .texture import lemma  # noqa: PLC0415
    return {lemma(w) for w in _WORD.findall(text or "") if w.lower() not in _STOP and w.lower() not in _STOP3}


def _names(text: str) -> set[str]:
    from .texture import lemma  # noqa: PLC0415
    return {lemma(w) for w in re.findall(r"\b[A-Z][a-z]{3,}", text or "")}


def _ledger_facts(e: dict) -> list[str]:
    """One story-ledger entry → plain fact lines."""
    out = [str(x) for x in e.get("summary") or [] if str(x).strip()]
    for k in e.get("knowledge") or []:
        out.append(f"{k.get('who')} {'is surprised to learn' if k.get('how') == 'surprised' else 'learns'}: "
                   f"{k.get('what')}")
    for r in e.get("relationships") or []:
        out.append(f"{r.get('a')} and {r.get('b')}: {r.get('line')}")
    for p in e.get("people") or []:
        name = p.get("name")
        if p.get("status") == "dead":
            out.append(f"{name} is dead")
        for i in p.get("injuries") or []:
            out.append(f"{name} is hurt: {i.get('what')} ({i.get('status') or 'new'})")
        for it in p.get("items_gained") or []:
            out.append(f"{name} gains {it}")
        for it in p.get("items_lost") or []:
            out.append(f"{name} loses {it}")
    for x in e.get("numbers") or []:
        out.append(f"{x.get('what')}: {x.get('value')}")
    return [_clip(x, FACT_MAX) for x in out if x.strip()]


def facts_to_cite(store, pid: str, branch: str, outline: dict | None, chapter_id: str, plan_texts, *,
                  ledger: bool = True) -> list[str]:
    """At most ``MAX_FACTS`` cited facts this chapter's plan relies on: the open set-ups of earlier chapters first,
    then the story ledger's facts that share the plan's names and rarer words (most shared first, newest first).
    [] for chapter 1, a book without earlier facts, or a run with the fact plan off. ``ledger=False`` (the chapter has
    a 🧠 needs list, whose earlier moments already quote the earlier chapters): the set-ups only. Never raises."""
    try:
        if not flags(store, pid, branch)["fact_plan"]:
            return []
        order = _order(outline)
        if chapter_id not in order:
            return []
        idx = order.index(chapter_id)
        if idx == 0:
            return []
        plan = " ".join(str(t) for t in plan_texts or [] if t)
        want, want_names = _lemmas(plan), _names(plan)
        lines: list[str] = []
        try:
            from . import promise_ledger  # noqa: PLC0415
            led = promise_ledger.current(store, pid, branch, outline) or {}
            plants = {e["id"]: e for e in led.get("entries") or []}
            for it in promise_ledger.chapter_items(store, pid, branch, outline, chapter_id):
                e = plants.get(it["id"])
                if it["kind"] == promise_ledger.KIND_PAYOFF and e and e["plant"] <= idx:
                    lines.append(_clip(f"Chapter {e['plant']} (set-up): {e['promise']}", FACT_MAX + 30))
        except Exception:  # noqa: BLE001
            log.exception("facts to cite: the promise ledger")
        from . import story_ledger  # noqa: PLC0415
        cands = [(int(e.get("number") or i + 1), f) for i, e in enumerate(story_ledger.ordered(
            store, pid, branch, order[:idx])) for f in _ledger_facts(e)]
        if ledger and cands and (want or want_names):
            lem = [_lemmas(f) for _n, f in cands]
            df: dict = {}
            for s in lem:
                for w in s:
                    df[w] = df.get(w, 0) + 1
            common = {w for w, c in df.items() if c > max(2, len(cands) // 2)}
            scored = []
            for (num, f), s in zip(cands, lem):
                hits = (s & want) - common
                score = len(hits) + len((_names(f) & want_names) - common)
                if score >= 2:
                    scored.append((score, num, f))
            seen = {x.split(": ", 1)[-1].lower() for x in lines}
            for _score, num, f in sorted(scored, key=lambda x: (-x[0], -x[1])):
                if f.lower() in seen:
                    continue
                seen.add(f.lower())
                lines.append(f"Chapter {num}: {f}")
        return _fit(lines[:MAX_FACTS], FACTS_BUDGET)
    except Exception:  # noqa: BLE001
        log.exception("facts to cite")
        return []


# ====================================================================== the writer's brief and the reviewer
def writer_parts(store, pid: str, branch: str, outline: dict | None, chapter_id: str, plan_texts, *,
                 needs: bool = False) -> tuple[dict, list[str]]:
    """For chapter_brief.build: ({ending_brief?, facts_to_cite?}, their rules). Never raises."""
    parts, rules = {}, []
    eb = ending_brief(store, pid, branch, outline, chapter_id)
    if eb:
        parts["ending_brief"] = eb
        rules.append(ENDING_RULE if eb["role"] == "ending" else CLIMAX_RULE)
    facts = facts_to_cite(store, pid, branch, outline, chapter_id, plan_texts, ledger=not needs)
    if facts:
        parts["facts_to_cite"] = facts
        rules.append(FACT_RULE)
    if eb or facts:
        log.info("ending writer: chapter %s role=%s checklist=%s facts=%s", chapter_id, (eb or {}).get("role"),
                 len((eb or {}).get("checklist") or []), len(facts))
    return parts, rules


def review_extra(store, pid: str, branch: str, rec: dict) -> dict:
    """For the chapter reviewer: {"ending_brief": …, "ending_note": REVIEW_NOTE} for the last / climax chapter of a
    run with the ending writer on, else {} (never raises)."""
    try:
        if rec.get("module_id") != "C02":
            return {}
        meta = store.get_state(pid, branch, "c_meta", rec["record_id"]) or {}
        cid = meta.get("chapter_id") or meta.get("unit_id") or (rec.get("data") or {}).get("chapter_id")
        from .needs_list import _outline_of  # noqa: PLC0415
        eb = ending_brief(store, pid, branch, _outline_of(store, pid, branch), cid) if cid else None
        return {"ending_brief": eb, "ending_note": REVIEW_NOTE} if eb else {}
    except Exception:  # noqa: BLE001
        log.exception("ending brief for the review")
        return {}
