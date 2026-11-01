"""🖼 Character pictures for the whole book: the ⚡ Make-a-book run's "Character pictures" step and the Book Bible's
"🖼 Make the rest of the pictures" button.

* **During the run** (``run_step``): every approved character gets at least a portrait, made from its dossier by the
  Character Forge's own picture path (``forge.run_art``: the same prompts, the same AutoInjector ``/image/request``).
  The book's ★ protagonist gets the full set: portrait, the front / side / back views and the turnaround sheet.
* **Engine**: Stable Diffusion first (``engine: "sd"``, the most consistent look). The setting ``book_pictures``
  (``{run: bool, engine: "sd" | "auto"}``; default ``{run: true, engine: "sd"}``) can switch the run's pictures off,
  or allow AutoInjector's "auto" (Stable Diffusion, else ChatGPT).
* **Character locks**: a character's first portrait becomes its 🔒 character lock in AutoInjector (``POST
  /image/locks``: its looks and the seed), so later pictures keep the same face. A lock the author already made with
  that name is never replaced. An older AutoInjector without the route: a note, nothing else.
* **Never blocks the book**: when the picture maker is not there (AutoInjector not running, Stable Diffusion not
  connected …) or a picture fails, the missing pictures go on the book's **to-make list** (settings key
  ``book_pictures:<pid>:<branch>``), a plain event is logged and the run goes on. Pause / cancel are honoured between
  pictures; a resumed run only makes what is still missing (finished pictures are on the dossier and are skipped).
* **Make the rest** (``start_rest``): a job (polled like every review job, ``…/review/ai/<job_id>``, with Stop) that
  makes every missing picture of every character's full set plus the to-make list, with progress and plain results.
"""
from __future__ import annotations

import logging
import threading
import types

from .errors import AkoweError
from .jobs import now_iso

log = logging.getLogger("akowe.book_pictures")

SETTING = "book_pictures"
KEY = "book_pictures:{pid}:{branch}"
ENGINES = ("sd", "auto")
DEFAULTS = {"run": True, "engine": "sd"}
PORTRAIT = ("portrait",)
FULL = ("portrait", "front", "side", "back", "sheet")
VIEW_SLOTS = ("front", "side", "back")
WORDS = {"portrait": "portrait", "front": "front view", "side": "side view", "back": "back view",
         "sheet": "character sheet"}
# The picture maker is not there at all: every other picture would fail the same way (stop trying for now)
ENGINE_DOWN = frozenset(("IMAGE_BRIDGE_UNREACHABLE", "IMAGE_NOT_WIRED", "IMAGE_BRIDGE_KEY", "SD_NOT_CONNECTED",
                         "NO_IMAGE_ENGINE", "CHATGPT_NOT_READY", "IMAGE_LIMIT", "NO_ENDPOINT", "IMAGE_DISABLED"))
PROBE_TIMEOUT_S = 8.0
_LOCK = threading.RLock()


# ====================================================================== settings and the per-book state
def settings(store) -> dict:
    s = store.get_setting(SETTING) or {}
    s = s if isinstance(s, dict) else {}
    out = dict(DEFAULTS)
    if isinstance(s.get("run"), bool):
        out["run"] = s["run"]
    if s.get("engine") in ENGINES:
        out["engine"] = s["engine"]
    return out


def save_settings(store, body) -> dict:
    body = body if isinstance(body, dict) else {}
    out = settings(store)
    if "run" in body:
        if not isinstance(body["run"], bool):
            raise AkoweError("INVALID_INPUT", "/run_pictures/run", "run: true or false", status="REJECTED")
        out["run"] = body["run"]
    if "engine" in body:
        if body["engine"] not in ENGINES:
            raise AkoweError("INVALID_INPUT", "/run_pictures/engine", "engine: sd (Stable Diffusion only) or auto "
                             "(Stable Diffusion, else ChatGPT)", status="REJECTED")
        out["engine"] = body["engine"]
    store.set_setting(SETTING, out)
    return out


def _key(pid, branch) -> str:
    return KEY.format(pid=pid, branch=branch)


def state(store, pid: str, branch: str) -> dict:
    """{waiting: {rid: {name, slots: [...], code, why, at}}, locks: {rid: {name, seed, created, at}}, made: int}."""
    s = store.get_setting(_key(pid, branch)) or {}
    s = s if isinstance(s, dict) else {}
    return {"waiting": dict(s.get("waiting") or {}), "locks": dict(s.get("locks") or {}),
            "made": int(s.get("made") or 0), "updated_at": s.get("updated_at")}


def _update(store, pid, branch, fn) -> dict:
    with _LOCK:
        s = state(store, pid, branch)
        fn(s)
        s["waiting"] = {rid: w for rid, w in s["waiting"].items() if w.get("slots")}
        s["updated_at"] = now_iso()
        store.set_setting(_key(pid, branch), s)
        return s


def note_waiting(store, pid, branch, rid: str, name: str, slots, code: str, why: str):
    def fn(s):
        w = s["waiting"].get(rid) or {"name": name, "slots": []}
        w["slots"] = [x for x in FULL if x in set(w.get("slots") or []) | set(slots)]
        w.update(name=name, code=code, why=why[:300], at=now_iso())
        s["waiting"][rid] = w
    _update(store, pid, branch, fn)


def note_made(store, pid, branch, rid: str, slots):
    def fn(s):
        w = s["waiting"].get(rid)
        if w:
            w["slots"] = [x for x in w.get("slots") or [] if x not in set(slots)]
        s["made"] = int(s.get("made") or 0) + len(slots)
    _update(store, pid, branch, fn)


# ====================================================================== what each character has / still needs
def have(store, pid, branch, rid) -> set:
    from . import forge  # noqa: PLC0415
    try:
        art = (forge.raw_entry(store, pid, branch, rid) or {}).get("art") or {}
    except Exception:  # noqa: BLE001 - a character without a dossier has no pictures
        return set()
    out = {s for s in ("portrait", "sheet") if isinstance(art.get(s), dict) and art[s].get("asset_id")}
    views = art.get("views") or {}
    out |= {v for v in VIEW_SLOTS if isinstance(views.get(v), dict) and views[v].get("asset_id")}
    return out


def missing(store, pid, branch, rid, want) -> list[str]:
    got = have(store, pid, branch, rid)
    return [s for s in FULL if s in want and s not in got]


def protagonist_id(store, pid, branch) -> str | None:
    from . import story_roles  # noqa: PLC0415
    try:
        p = story_roles.protagonist_of(store, pid, branch)
    except Exception:  # noqa: BLE001
        log.exception("could not read the protagonist")
        return None
    return p["record_id"] if p else None


def waiting_by_record(store, pid, branch) -> dict:
    """{rid: [slots still waiting]} — the to-make list, minus pictures made since (the binder's "picture waiting")."""
    out = {}
    for rid, w in state(store, pid, branch)["waiting"].items():
        left = missing(store, pid, branch, rid, w.get("slots") or [])
        if left:
            out[rid] = left
    return out


# ====================================================================== making pictures (Character Forge's path)
def probe(app, engine: str) -> tuple[bool, str, str]:
    """(ok, code, plain words): is a picture maker there for this engine? One quick GET /image/backend."""
    from . import forge  # noqa: PLC0415
    targets = forge.bridge_targets(app)
    if not targets:
        return False, "IMAGE_BRIDGE_UNREACHABLE", "no local AutoInjector address is set"
    last = ("IMAGE_BRIDGE_UNREACHABLE", "AutoInjector is not reachable")
    for url, token in targets:
        try:
            b = forge._post(url, token, {}, PROBE_TIMEOUT_S, route="/image/backend", method="GET")  # noqa: SLF001
        except forge.ArtProblem as exc:
            if exc.code in ("IMAGE_BRIDGE_UNREACHABLE", "IMAGE_NOT_WIRED"):
                last = (exc.code, exc.message)
                continue
            return False, exc.code, exc.message
        eng = b.get("engines") if isinstance(b.get("engines"), dict) else {}
        sd = eng.get("sd") if isinstance(eng.get("sd"), dict) else {"connected": b.get("connected"),
                                                                        "noModels": b.get("noModels")}
        sd_ok = bool(sd.get("connected")) and not sd.get("noModels")
        cg_ok = bool((eng.get("chatgpt") or {}).get("ready"))
        if sd_ok or (engine == "auto" and cg_ok):
            return True, "", ""
        if engine == "sd":
            return False, "SD_NOT_CONNECTED", ("Stable Diffusion has no picture model yet" if sd.get("connected")
                                               else "Stable Diffusion (Forge) is not connected in AutoInjector")
        return False, "NO_IMAGE_ENGINE", "neither Stable Diffusion nor ChatGPT can make pictures right now"
    return False, last[0], last[1]


def _shim(principal, check, on_phase=None):
    job = types.SimpleNamespace(principal=principal, phase="", total=0, done=0, results=[])

    def chk():
        if check:
            check()
        if on_phase and job.phase:
            on_phase(job.phase)
    job.check = chk
    return job


def ensure_lock(app, pid, branch, rid) -> dict | None:
    """The character's first portrait -> its 🔒 character lock in AutoInjector (looks + seed). Never replaces the
    author's own lock (AutoInjector keeps one with that name). Returns the bridge's answer or None (not possible)."""
    from . import forge  # noqa: PLC0415
    from .book_path import get_profile  # noqa: PLC0415
    store = app.store
    d = forge.public(store, pid, branch, rid)
    pt = (forge.raw_entry(store, pid, branch, rid).get("art") or {}).get("portrait") or {}
    seed = pt.get("seed") if isinstance(pt.get("seed"), int) and pt.get("source") != "chatgpt" else None
    body = {"character": d["name"], "book": (get_profile(store, pid) or {}).get("title") or "",
            "prompt": forge.art_prompt(d, "lock"), "from": "akowe"}
    if seed is not None:
        body["seed"] = seed
    out = None
    for url, token in forge.bridge_targets(app):
        try:
            out = forge._post(url, token, body, PROBE_TIMEOUT_S, route="/image/locks")  # noqa: SLF001
            break
        except forge.ArtProblem as exc:
            if exc.code in ("IMAGE_BRIDGE_UNREACHABLE",):
                continue
            log.info("character lock for %s not saved (%s)", rid, exc.code)
            return None
    if not out:
        return None
    lk = out.get("lock") if isinstance(out.get("lock"), dict) else {}

    def fn(s):
        s["locks"][rid] = {"name": d["name"], "seed": lk.get("seed", seed), "created": bool(out.get("created")),
                           "lock_id": lk.get("id"), "at": now_iso()}
    _update(store, pid, branch, fn)
    return out


def make_for(app, principal, pid, branch, rid, want, engine: str, check=None, on_phase=None) -> dict:
    """Make the character's missing pictures among ``want`` (portrait first, then the views, then the sheet).
    -> {made: [...], failed: [...], code, message, down: bool, lock: dict|None}. Raises only what ``check`` raises
    (pause / cancel)."""
    from . import forge  # noqa: PLC0415
    store = app.store
    todo = missing(store, pid, branch, rid, want)
    out = {"made": [], "failed": [], "code": "", "message": "", "down": False, "lock": None}
    groups = []
    if "portrait" in todo:
        groups.append(("portrait", ["portrait"]))
    views = [v for v in VIEW_SLOTS if v in todo]
    if views:
        groups.append(("views", views))
    if "sheet" in todo:
        groups.append(("sheet", ["sheet"]))
    for what, slots in groups:
        if check:
            check()
        before = have(store, pid, branch, rid)
        job = _shim(principal, check, on_phase)
        try:
            forge.run_art(app, job, pid, branch, rid, what, engine, views if what == "views" else [])
        except forge.ArtProblem as exc:
            after = have(store, pid, branch, rid)
            got = [s for s in slots if s in after and s not in before]
            out["made"] += got
            out["failed"] += [s for s in slots if s not in got]
            out["code"], out["message"] = exc.code, exc.message
            if exc.code in ENGINE_DOWN:
                out["down"] = True
                done = set(out["made"]) | set(out["failed"])
                out["failed"] += [s for _w, ss in groups for s in ss if s not in done]
                break
            continue
        except AkoweError as exc:  # e.g. the picture could not be stored
            out["failed"] += slots
            out["code"], out["message"] = exc.code, (exc.errors[0].get("message") if exc.errors else exc.code)
            continue
        out["made"] += slots
        if what == "portrait":
            try:
                out["lock"] = ensure_lock(app, pid, branch, rid)
            except Exception:  # noqa: BLE001 - a lock is a nicety, never a failure
                log.exception("character lock for %s", rid)
    return out


# ====================================================================== the run's step
def run_step(svc, run, st) -> None:
    """⚡ "Character pictures": a portrait for everyone, the full set for the ★ protagonist. Never raises a problem
    (only pause / cancel through ``svc.check``)."""
    app = svc.app
    store = app.store
    pid, branch = run["project_id"], run["branch_id"]
    conf = settings(store)
    want_on = (run.get("settings") or {}).get("pictures")
    if want_on is False or (want_on is None and not conf["run"]):
        st["message"] = "Off (Settings → Pictures): make them later with 🖼 Make the rest of the pictures"
        return
    engine = conf["engine"]
    people = svc.bp(run).approved("A01")
    prot = protagonist_id(store, pid, branch)
    from .review import safe_title  # noqa: PLC0415
    label = lambda r: safe_title(app.engine.contracts, r)  # noqa: E731
    plan = []
    for r in sorted(people, key=lambda r: r["record_id"] != prot):  # the protagonist first
        plan.append((r["record_id"], label(r), FULL if r["record_id"] == prot else PORTRAIT))
    st["items"] = [{"id": rid, "label": name, "state": "pending",
                    "note": "portrait, views and sheet" if want == FULL else "portrait"} for rid, name, want in plan]
    todo = [(i, rid, name, want, missing(store, pid, branch, rid, want)) for i, (rid, name, want) in enumerate(plan)]
    for i, rid, name, want, left in todo:
        if not left:
            st["items"][i].update(state="done", note="already made")
    left_total = sum(len(x[4]) for x in todo)
    if not left_total:
        st["message"] = f"{len(plan)} character(s) already have their pictures"
        return
    ok, code, why = probe(app, engine)
    made = failed = 0
    down = None if ok else (code, why)
    for i, rid, name, want, left in todo:
        if not left:
            continue
        item = st["items"][i]
        if down:
            note_waiting(store, pid, branch, rid, name, left, down[0], down[1])
            failed += len(left)
            item.update(state="later", note="on the to-make list")
            continue
        svc.check(run)
        item["state"] = "running"
        st["message"] = f"Making the {', '.join(WORDS[s] for s in left)} of “{name}”"
        run["phase"] = st["message"]
        svc.save(run)

        def phase(p, _name=name):
            run["phase"] = f"{_name}: {p}"
        res = make_for(app, run["principal"], pid, branch, rid, left, engine, check=lambda: svc.check(run),
                       on_phase=phase)
        made += len(res["made"])
        if res["made"]:
            note_made(store, pid, branch, rid, res["made"])
            svc.event(run, "pictures", f"🖼 Made the {', '.join(WORDS[s] for s in res['made'])} of “{name}”",
                      step="pictures", record_id=rid)
        if res["lock"] and res["lock"].get("created"):
            svc.event(run, "pictures", f"🔒 “{name}”'s portrait is now their character lock in AutoInjector, so "
                      "later pictures keep the same face", step="pictures", record_id=rid)
        if res["failed"]:
            failed += len(res["failed"])
            note_waiting(store, pid, branch, rid, name, res["failed"], res["code"], res["message"])
            item.update(state="later" if not res["made"] else "done",
                        note=f"{len(res['failed'])} on the to-make list")
            if res["down"]:
                down = (res["code"], res["message"])
        else:
            item.update(state="done", note="made now")
        svc.save(run)
    if failed:
        why = (down or ("", ""))[1] or "some pictures could not be made"
        svc.event(run, "note", f"🖼 {failed} picture(s) could not be made now ({why}); they are on the book's "
                  "to-make list — the book goes on. Open the 📖 Book Bible and press 🖼 Make the rest of the pictures "
                  "when the picture maker (Stable Diffusion in AutoInjector) is running.", step="pictures",
                  code="PICTURES_WAITING")
    st["message"] = (f"{made} picture(s) made" if made else "No pictures made") + (
        f" · {failed} waiting on the to-make list" if failed else "")


# ====================================================================== 🖼 Make the rest of the pictures (a job)
def rest_plan(store, pid, branch) -> list[tuple[str, str, list]]:
    """[(rid, name, missing slots)] — every character's full set plus the to-make list."""
    from . import characters as chars_mod  # noqa: PLC0415
    prot = protagonist_id(store, pid, branch)
    chars = chars_mod.canon_characters(store, pid, branch)
    chars.sort(key=lambda c: c["record_id"] != prot)
    out = []
    for c in chars:  # the to-make list only ever holds slots of the full set, so it is inside this
        left = missing(store, pid, branch, c["record_id"], FULL)
        if left:
            out.append((c["record_id"], c["name"], left))
    return out


def series_waiting(store, pid, branch) -> int:
    """📚 per-book portraits of the series still to make (series.py) — on the same to-make list."""
    from . import series as series_mod  # noqa: PLC0415
    try:
        s = series_mod.of_book(store, pid, branch)
        return 0 if s.get("virtual") else len(series_mod.portrait_plan(store, s))
    except Exception:  # noqa: BLE001
        log.exception("series portraits waiting")
        return 0


def summary(store, pid, branch) -> dict:
    plan = rest_plan(store, pid, branch)
    s = state(store, pid, branch)
    return {"missing": sum(len(x[2]) for x in plan), "characters": len(plan),
            "series_portraits": series_waiting(store, pid, branch),
            "waiting": waiting_by_record(store, pid, branch), "locks": s["locks"], "settings": settings(store)}


def start_rest(app, principal: str, pid: str, branch: str, body=None) -> dict:
    """POST …/binder/pictures -> 202 job (poll …/review/ai/<job_id>, stop with …/cancel)."""
    from .review import ReviewJob  # noqa: PLC0415
    if not app.store.has_scope(principal, pid, branch, "I01:create"):
        raise AkoweError("PERMISSION_DENIED", "", "missing scope I01:create", status="REJECTED")
    plan = rest_plan(app.store, pid, branch)

    class PicturesJob(ReviewJob):
        total = 1

        def public(self):
            out = super().public()
            out["total"] = self.total
            return out
    job = PicturesJob("book_pictures", principal, pid, branch, [r for r, _n, _s in plan], None)
    job.total = max(1, sum(len(s) for _r, _n, s in plan) + series_waiting(app.store, pid, branch))
    return app.review._start(job, lambda j: run_rest(app, j, pid, branch))  # noqa: SLF001


def run_rest(app, job, pid, branch) -> None:
    store = app.store
    engine = settings(store)["engine"]
    plan = rest_plan(store, pid, branch)
    extra = series_waiting(store, pid, branch)
    job.total = max(1, sum(len(s) for _r, _n, s in plan) + extra)
    if not plan and not extra:
        job.results.append({"ok": True, "message": "Every character already has all their pictures."})
        return
    if not plan:
        job.phase = "Making the series portraits…"
        sp = _series_portraits(app, job, pid, branch)
        job.done = job.total
        job.results.append({"ok": not sp["failed"], "made": sp["made"], "failed": sp["failed"],
                            "message": _series_words(sp) or "Done."})
        return
    job.phase = "Checking the picture maker…"
    ok, code, why = probe(app, engine)
    if not ok:
        for rid, name, left in plan:
            note_waiting(store, pid, branch, rid, name, left, code, why)
        job.results.append({"ok": False, "code": code, "message": f"No pictures could be made: {why}. Start Stable "
                            "Diffusion (Forge) in AutoInjector → 🎨 Images, then press 🖼 Make the rest of the "
                            "pictures again."})
        return
    made = failed = 0
    last = ""
    for rid, name, left in plan:
        job.check()
        job.current = rid
        job.phase = f"Making the {', '.join(WORDS[s] for s in left)} of “{name}”"

        def phase(p, _name=name):
            job.phase = f"{_name}: {p}"
        res = make_for(app, job.principal, pid, branch, rid, left, engine, check=job.check, on_phase=phase)
        made += len(res["made"])
        job.done = made + failed
        if res["made"]:
            note_made(store, pid, branch, rid, res["made"])
        if res["failed"]:
            failed += len(res["failed"])
            job.done = made + failed
            last = res["message"] or res["code"]
            note_waiting(store, pid, branch, rid, name, res["failed"], res["code"], res["message"])
        job.results.append({"ok": not res["failed"], "record_id": rid, "made": res["made"], "failed": res["failed"],
                            "message": f"{name}: {len(res['made'])} made" + (
                                f", {len(res['failed'])} still waiting" if res["failed"] else "")})
        if res["down"]:
            for rid2, name2, left2 in plan[plan.index((rid, name, left)) + 1:]:
                note_waiting(store, pid, branch, rid2, name2, left2, res["code"], res["message"])
                failed += len(left2)
            break
    # 📚 the series portraits on the same list (make_portraits checks the picture maker itself; down -> they wait)
    sp = _series_portraits(app, job, pid, branch) if extra else {"made": 0, "failed": 0}
    job.done = job.total
    msg = f"{made} picture(s) made." if made else "No pictures were made."
    if failed:
        msg += f" {failed} still waiting ({last}) — they stay on the to-make list; press the button again later."
    if extra:
        msg += " " + _series_words(sp)
    job.results.append({"ok": not failed and not sp["failed"], "made": made + sp["made"],
                        "failed": failed + sp["failed"], "message": msg.strip()})


def _series_portraits(app, job, pid, branch) -> dict:
    from . import series as series_mod  # noqa: PLC0415
    try:
        return series_mod.make_portraits(app, job.principal, pid, branch, check=job.check,
                                         on_phase=lambda p: setattr(job, "phase", p))
    except AkoweError as exc:
        return {"made": 0, "failed": 1, "message": exc.errors[0].get("message") if exc.errors else exc.code}


def _series_words(sp: dict) -> str:
    out = f"📚 {sp['made']} series portrait(s) made." if sp.get("made") else ""
    if sp.get("failed"):
        out += f" 📚 {sp['failed']} series portrait(s) still waiting ({sp.get('message') or sp.get('code') or ''})."
    return out.strip()
