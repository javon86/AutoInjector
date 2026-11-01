"""📚 The series inside the book file (``book.akowe``): ``series.json`` in the package, merged back when it is opened.

Saving a book that belongs to a series puts the WHOLE series record into the package (``export_record``): every
book's order, title and approved changes (characters, places, items, groups), the proposals waiting, and the per-book
picture references (the pictures stored in THIS book travel as its own assets; one stored in another book keeps its
reference and shows once that book is here too).

Opening the package (``restore``, called by ``book_package.import_package``) never duplicates or overwrites a series:

* no series with that id here: the series is restored as it was saved (books not on this computer are listed as
  "not in this Akọwe" and keep their history);
* the same series is here already: it is MERGED by series id — books by number, characters / places / items / groups
  by key (one that means someone else gets a new key), approved changes per book and per person or thing. Where both
  copies have a change, the newer approved one is the base and the other one's entries are added where they do not
  conflict; a one-value category (a status, a ruler, a holder, a leader…) that says two different things is a
  conflict: the newer one is kept and the conflict is reported in plain words. Nothing already here is removed.
* the opened book's number is already taken here by ANOTHER book that is still in this Akọwe (the same book opened
  twice as a copy): the copy is not added as a second book N — it opens as a book on its own, the series' changes
  are still merged, and the report says so.

An old book file (no ``series.json``) opens as before. A broken ``series.json`` never stops the book from opening: the
report says the series could not be restored.
"""
from __future__ import annotations

import copy
import json
import logging
import re
import uuid

from . import series as series_mod
from . import series_world as world
from .jobs import now_iso

log = logging.getLogger("akowe.series_package")

FORMAT = "akowe-series"
SCHEMA_VERSION = 1
FILE = "series.json"
SID_RE = re.compile(r"ser-[0-9a-f]{6,40}")
MAX_BOOKS = 200
MAX_PEOPLE = 2000
CHAR_SINGLE = {"status"}


def export_record(store, pid: str) -> dict | None:
    """The series of a book for its package (None: the book is not in a series)."""
    m = series_mod.member(store, pid)
    s = series_mod.get(store, m["series_id"]) if m else None
    if s is None:
        return None
    rec = copy.deepcopy(s)
    rec.pop("virtual", None)
    rec.pop("problem", None)
    return {"format": FORMAT, "schema_version": SCHEMA_VERSION, "saved_at": now_iso(), "project_id": pid,
            "number": series_mod.number_of(s, pid), "series": rec}


class SeriesProblem(Exception):
    pass


def clean_record(raw) -> dict:
    """A series.json read from a file (another computer, maybe hand-edited): the shape is checked, the series is
    returned. Raises SeriesProblem (plain words)."""
    if not isinstance(raw, dict) or raw.get("format") != FORMAT:
        raise SeriesProblem("the series part of the book file is not readable")
    sv = raw.get("schema_version")
    if not isinstance(sv, int) or isinstance(sv, bool) or sv < 1:
        raise SeriesProblem("the series part of the book file has no valid version")
    if sv > SCHEMA_VERSION:
        raise SeriesProblem("the series part was saved by a newer Akọwe")
    s = raw.get("series")
    if not isinstance(s, dict) or not isinstance(s.get("id"), str) or not SID_RE.fullmatch(s["id"]):
        raise SeriesProblem("the series part of the book file has no valid series id")
    bl = s.get("books")
    if not isinstance(bl, list) or len(bl) > MAX_BOOKS:
        raise SeriesProblem("the series part of the book file has no readable book list")
    books = []
    for b in bl:
        if isinstance(b, dict) and isinstance(b.get("number"), int) and not isinstance(b["number"], bool) and \
                0 < b["number"] < 1000 and isinstance(b.get("project_id"), str):
            books.append({"number": b["number"], "project_id": b["project_id"][:80],
                          "branch_id": str(b.get("branch_id") or "main")[:80],
                          "title": str(b.get("title") or f"Book {b['number']}")[:200],
                          **({"previous": str(b["previous"])[:80]} if b.get("previous") else {})})
    out = {"id": s["id"], "name": str(s.get("name") or "My series")[:200], "created_at": s.get("created_at"),
           "updated_at": s.get("updated_at"), "books": books}
    for k in ("characters", "changes", "proposals", "portraits", "portrait_waiting", "things", "thing_changes",
              "thing_proposals", "thing_pictures", "thing_picture_waiting"):
        v = s.get(k)
        out[k] = copy.deepcopy(v) if isinstance(v, dict) else {}
    if len(out["characters"]) + len(out["things"]) > MAX_PEOPLE:
        raise SeriesProblem("the series part of the book file is too large")
    out["characters"] = {k: v for k, v in out["characters"].items() if isinstance(k, str) and isinstance(v, dict)}
    out["things"] = {k: v for k, v in out["things"].items() if isinstance(k, str) and isinstance(v, dict) and
                     v.get("kind") in world.KINDS}
    old = s.get("portraits_old")
    out["portraits_old"] = [x for x in old if isinstance(x, dict)][-100:] if isinstance(old, list) else []
    return out


def _swap_pid(rec: dict, old_pid: str, new_pid: str) -> dict:
    if not old_pid or old_pid == new_pid:
        return rec
    return json.loads(json.dumps(rec, ensure_ascii=False).replace(old_pid, new_pid))


# ====================================================================== merging two copies of one series
def _merge_entry(kind: str | None, a: dict, b: dict, who: str, n: str, conflicts: list) -> dict:
    """Two approved changes of one person / thing in one book: the newer one is the base, the older one's entries
    are added where they do not conflict (a one-value category that differs is a conflict: the newer one stays)."""
    newer, older = (a, b) if str(a.get("at") or "") >= str(b.get("at") or "") else (b, a)
    if kind is None:
        dn, do = series_mod.clean_delta(newer.get("delta")), series_mod.clean_delta(older.get("delta"))
        single, label = CHAR_SINGLE, (lambda c: dict((k, lab) for k, lab, _h in series_mod.CATS).get(c, c))
    else:
        dn, do = world.clean_delta(kind, newer.get("delta")), world.clean_delta(kind, older.get("delta"))
        single, label = world.single_cats(kind), (lambda c: world.label(kind, c))
    if dn == do:
        return newer
    out = copy.deepcopy(dn)
    for c, items in do.items():
        if c in single and out.get(c) and items:
            if series_mod.norm(out[c][-1]["text"]) != series_mod.norm(items[-1]["text"]):
                conflicts.append(f"Book {n}, {who}, {label(c).lower()}: kept “{out[c][-1]['text']}” (the newer "
                                 f"change); the other copy said “{items[-1]['text']}”.")
            continue
        have = {(series_mod.norm(e.get("with")), series_mod.norm(e["text"])) for e in out.get(c) or []}
        for e in items:
            sig = (series_mod.norm(e.get("with")), series_mod.norm(e["text"]))
            if sig not in have and len(out.setdefault(c, [])) < series_mod.PER_CAT:
                out[c].append(e)
                have.add(sig)
    return dict(newer, delta=out, merged_at=now_iso())


def _remap(inc: dict, coll: str, rename: dict) -> None:
    """Renames keys of ``inc[coll]`` and every per-book dict that is keyed by them."""
    if not rename:
        return
    per_book = ("changes", "proposals", "portraits", "portrait_waiting") if coll == "characters" else \
        ("thing_changes", "thing_proposals", "thing_pictures", "thing_picture_waiting")
    inc[coll] = {rename.get(k, k): v for k, v in inc[coll].items()}
    for pb in per_book:
        inc[pb] = {n: {rename.get(k, k): v for k, v in (d or {}).items()} for n, d in (inc.get(pb) or {}).items()}


def _match_people(cur: dict, inc: dict, coll: str) -> list[str]:
    """Same key + same name (or alias) = the same one; a key that names someone else here gets a new key."""
    rename, added = {}, []
    names = lambda x: {series_mod.norm(x.get("name"))} | {series_mod.norm(a) for a in x.get("aliases") or []}  # noqa: E731
    for k, v in inc[coll].items():
        here = cur[coll].get(k)
        if here is not None and (names(here) & names(v)) and (coll == "characters" or here.get("kind") ==
                                                               v.get("kind")):
            continue
        same = next((ck for ck, cv in cur[coll].items() if (names(cv) & names(v)) and
                     (coll == "characters" or cv.get("kind") == v.get("kind"))), None)
        if same:
            rename[k] = same
            continue
        if here is not None:  # the key means someone else here: a new key for the incoming one
            nk = f"{k}{uuid.uuid4().hex[:4]}"
            while nk in cur[coll] or nk in inc[coll]:
                nk = f"{k}{uuid.uuid4().hex[:4]}"
            rename[k] = nk
        added.append(v.get("name") or k)
    _remap(inc, coll, rename)
    return added


def merge(store, cur: dict, inc: dict, new_pid: str) -> tuple[dict, list[str], list[str], bool]:
    """(merged series, conflicts, notes, joined) — ``inc`` merged into ``cur`` (both cleaned, same id). ``joined``:
    the opened book took its place in the series' book list."""
    out = copy.deepcopy(cur)
    inc = copy.deepcopy(inc)
    world.defaults(out)
    conflicts, notes = [], []
    if inc.get("name") and series_mod.norm(inc["name"]) != series_mod.norm(out.get("name")):
        notes.append(f"The series is called “{out.get('name')}” on this computer; the opened book called it "
                     f"“{inc['name']}”. The name here was kept.")
    # books by number
    joined = True
    for b in inc.get("books") or []:
        here = next((x for x in out["books"] if x.get("number") == b["number"]), None)
        if here is None:
            out["books"].append(b)
            continue
        if here.get("project_id") == b["project_id"]:
            continue
        if b["project_id"] == new_pid:
            if series_mod._exists(store, here.get("project_id")):  # noqa: SLF001 - another book is book N here
                joined = False
                notes.append(f"Book {b['number']} of this series is already in this Akọwe (“{here.get('title')}”), "
                             "so the opened copy was not added as a second book "
                             f"{b['number']}: it opens as a book on its own. The series' changes were merged.")
            else:
                out["books"] = [x for x in out["books"] if x is not here] + [b]
        elif not series_mod._exists(store, here.get("project_id")) and series_mod._exists(store, b["project_id"]):  # noqa: SLF001
            out["books"] = [x for x in out["books"] if x is not here] + [b]
    # people and things by key
    for coll in ("characters", "things"):
        _match_people(out, inc, coll)
        for k, v in inc[coll].items():
            here = out[coll].get(k)
            if here is None:
                out[coll][k] = v
                continue
            recs = dict(v.get("records") or {})
            recs.update(here.get("records") or {})
            here["records"] = recs
            if coll == "things":
                rids = dict(v.get("rids") or {})
                rids.update(here.get("rids") or {})
                here["rids"] = rids
            for a in v.get("aliases") or []:
                if a not in (here.get("aliases") or []) and series_mod.norm(a) != series_mod.norm(here.get("name")):
                    here.setdefault("aliases", []).append(a)
            if not here.get("fixed") and v.get("fixed"):
                here["fixed"], here["base"] = v["fixed"], v.get("base") or {}
    # approved changes
    for coll, ch_key, label_of in (("characters", "changes", None), ("things", "thing_changes", "things")):
        for n, per in (inc.get(ch_key) or {}).items():
            for k, e in (per or {}).items():
                if not isinstance(e, dict):
                    continue
                dest = out[ch_key].setdefault(n, {})
                if k not in dest:
                    dest[k] = e
                    continue
                who = (out[coll].get(k) or {}).get("name") or k
                kind = (out[coll].get(k) or {}).get("kind") if label_of else None
                dest[k] = _merge_entry(kind, dest[k], e, who, n, conflicts)
    # proposals: only where nothing waits here yet
    for p_key in ("proposals", "thing_proposals"):
        for n, per in (inc.get(p_key) or {}).items():
            dest = out[p_key].setdefault(n, {})
            for k, e in (per or {}).items():
                dest.setdefault(k, e)
    # pictures: kept where this copy has none; the waiting lists are joined
    for pic_key, wait_key in (("portraits", "portrait_waiting"), ("thing_pictures", "thing_picture_waiting")):
        for n, per in (inc.get(pic_key) or {}).items():
            dest = out[pic_key].setdefault(n, {})
            for k, e in (per or {}).items():
                dest.setdefault(k, e)
        for n, per in (inc.get(wait_key) or {}).items():
            dest = out[wait_key].setdefault(n, {})
            for k, e in (per or {}).items():
                if k not in (out[pic_key].get(n) or {}):
                    dest.setdefault(k, e)
    seen = {json.dumps(x, sort_keys=True) for x in out.get("portraits_old") or []}
    out["portraits_old"] = (list(out.get("portraits_old") or []) + [x for x in inc.get("portraits_old") or []
                                                                     if json.dumps(x, sort_keys=True) not in seen])[-100:]
    return out, conflicts, notes, joined


# ====================================================================== restore when a book file is opened
def restore(store, raw, old_pid: str, new_pid: str, branch: str = "main") -> dict:
    """The series of an opened book file: restored, or merged into the one here. Never raises.
    -> {action: restored | merged | none | failed, series_id, name, conflicts, notes, message}."""
    if raw is None:
        return {"action": "none", "message": ""}
    try:
        inc = _swap_pid(clean_record(raw), old_pid, new_pid)
    except SeriesProblem as exc:
        _drop_link(store, new_pid)
        return {"action": "failed", "conflicts": [], "notes": [],
                "message": f"📚 The book opened, but its series could not be restored ({exc}). The book works as a "
                           "book on its own."}
    except Exception:  # noqa: BLE001
        log.exception("series: reading the series of an opened book")
        _drop_link(store, new_pid)
        return {"action": "failed", "conflicts": [], "notes": [],
                "message": "📚 The book opened, but its series could not be restored (its series part is damaged). "
                           "The book works as a book on its own."}
    try:
        with series_mod._LOCK:  # noqa: SLF001
            cur = series_mod.get(store, inc["id"])
            number = next((b["number"] for b in inc["books"] if b["project_id"] == new_pid), None)
            if cur is None:
                world.defaults(inc)
                inc["imported_at"] = now_iso()
                series_mod._save(store, inc)  # noqa: SLF001
                joined, conflicts, notes, action = number is not None, [], [], "restored"
                s = inc
            else:
                s, conflicts, notes, joined = merge(store, cur, inc, new_pid)
                joined = joined and number is not None
                series_mod._save(store, s)  # noqa: SLF001
                action = "merged"
            if joined:
                store.set_setting(series_mod.MEMBER_KEY.format(pid=new_pid), {"series_id": s["id"], "number": number})
            else:
                _drop_link(store, new_pid)
    except Exception:  # noqa: BLE001 - the book is open; the series is an extra
        log.exception("series: restoring the series of an opened book")
        return {"action": "failed", "conflicts": [], "notes": [],
                "message": "📚 The book opened, but its series could not be restored right now. Nothing in the "
                           "series already here was changed."}
    n_books = len(s.get("books") or [])
    if action == "restored":
        msg = (f"📚 Its series “{s.get('name')}” came with it ({n_books} book{'s' if n_books != 1 else ''}"
               + (f"; this is book {number}" if joined else "") + ").")
    else:
        msg = f"📚 Its series “{s.get('name')}” was already on this computer: the two were merged."
    if conflicts:
        msg += f" {len(conflicts)} change{'s' if len(conflicts) != 1 else ''} did not agree; the newer one was kept: " \
               + " ".join(conflicts[:5])
    if notes:
        msg += " " + " ".join(notes)
    return {"action": action, "series_id": s["id"], "name": s.get("name"), "number": number if joined else None,
            "conflicts": conflicts, "notes": notes, "message": msg}


def _drop_link(store, pid: str) -> None:
    try:
        cur = series_mod.member(store, pid)
        if cur is not None:
            with store.transaction() as tx:
                tx.execute("DELETE FROM settings WHERE key=?", (series_mod.MEMBER_KEY.format(pid=pid),))
    except Exception:  # noqa: BLE001
        log.exception("series: removing the series link of %s", pid)
