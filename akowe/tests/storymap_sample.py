"""🗺 A realistic sample book for the story map's browser test and screenshots: fifteen characters (★ a main character,
a villain, leads, minor people), places, items and groups, twelve chapters tracked in the story ledger, and a story map
with locked, approved and draft links, a conflict from a chapter, a link about a removed character and every kind of
gap warning. Built in-process (BookPath manual drafts + story_map's own functions), no AI."""
from __future__ import annotations

from akowe import story_ledger as sl
from akowe import story_map as sm
from akowe import story_roles
from akowe.book_path import BookPath

BR = "main"
CHARS = [("Adaeze Okafor", "protagonist"), ("Kunle Bello", "deuteragonist"), ("Ifeoma Nwosu", "love_interest"),
         ("Baba Lanre", "mentor"), ("Chief Oduya", "antagonist"), ("Tunde Okafor", "family"),
         ("Mama Ronke", "family"), ("Sola Ade", "sidekick"), ("Emeka Obi", "rival"), ("Zainab Musa", "ally"),
         ("The Masked Ferryman", "henchman"), ("Yemi Cole", "supporting"), ("Old Nkem", "minor"),
         ("Dapo the Tailor", "minor"), ("Captain Ike", "supporting")]
PLACES = ["Lagos Lagoon", "The Iron Market", "Oduya Compound", "The Old Ferry Pier"]
ITEMS = ["The Bronze Mask", "Mama Ronke's Ledger"]
GROUPS = ["The Ferrymen's Guild", "The Night Council"]


def _fact(s, p, v):
    return {"subject_id": s, "predicate": p, "value": v, "assertion_type": "FACT", "effective_from": None,
            "effective_to": None, "source_refs": []}


def _make(bp, op, name):
    sid = "".join(ch for ch in name.lower() if ch.isalnum())[:30]
    cand = {"concept": name, "attributes": {}, "linked_refs": [], "protected_fact_flags": [],
            "facts": [_fact(sid, "entity.name", name)]}
    rec, _ = bp.create(op, {"concept": name}, manual_candidate=cand)
    return rec["record_id"]


def chapter_text(n: int) -> str:
    return (f"Chapter {n}. The lagoon was grey at dawn. Adaeze Okafor walked to the Iron Market with Sola Ade. "
            "Baba Lanre, Adaeze Okafor's teacher, waited by the pier. Tunde Okafor, Adaeze Okafor's brother, kept "
            "the ferry ropes. Kunle Bello swore he would never work for Chief Oduya again.")


def build(app, title: str = "The Lagoon Ledger") -> str:
    store = app.store
    pid = app.engine.bootstrap_project("author", title)
    bp = BookPath(app.engine, "author", pid, BR)
    rid = {name: _make(bp, "A01", name) for name, _r in CHARS}
    for name, role in CHARS:
        story_roles.set_role(store, pid, BR, rid[name], role, by="author", name=name)
    for p in PLACES:
        _make(bp, "A04", p)
    for i in ITEMS:
        _make(bp, "A12", i)
    for g in GROUPS:
        _make(bp, "A06", g)
    for n in range(1, 13):  # twelve chapters written (the ledger says so)
        sl.save_chapter(store, pid, BR, {"chapter_id": f"ch{n}", "number": n, "text": chapter_text(n)},
                        {"summary": [f"Chapter {n} happened."]}, made_by="ai")
    v = sm.view(store, pid, BR)
    ids = {n["name"]: n["id"] for n in v["nodes"]}

    def link(a, b, kind, note="", since=None, status="approved", quote=None):
        lk = sm.add_link(store, pid, BR, {"from": ids[a], "to": ids[b], "kind": kind, "note": note, "since": since,
                                          "status": "draft" if status == "draft" else "approved"})
        if status == "locked":  # as a chapter would: on the page
            cur = sm.get(store, pid, BR)
            x = cur["links"][lk["id"]]
            x.update(status="locked", source="ai", evidence=[{"chapter": since or 1, "chapter_id": f"ch{since or 1}",
                                                             "quote": quote or chapter_text(since or 1)[:120]}])
            store.set_setting(sm.KEY.format(pid=pid, branch=BR), cur)
        return lk["id"]
    for node in (("secret", "Who sank the night ferry"), ("clue", "The torn guild badge"),
                 ("thread", "The ferrymen's strike"), ("clue", "Mama Ronke's missing page")):
        out = sm.add_node(store, pid, BR, {"kind": node[0], "name": node[1],
                                           "payoff_chapter": 6 if node[1].startswith("The torn") else None})
        ids[node[1]] = out["id"]
    link("Adaeze Okafor", "Tunde Okafor", "family", "her older brother", 1, "locked",
         "Tunde Okafor, Adaeze Okafor's brother, kept the ferry ropes.")
    link("Adaeze Okafor", "Mama Ronke", "family", "her grandmother", 1, "locked")
    link("Baba Lanre", "Adaeze Okafor", "mentor", "teaches her the river songs", 1, "locked")
    link("Baba Lanre", "Sola Ade", "mentor", "", 2, "draft")
    link("Adaeze Okafor", "Sola Ade", "ally", "best friend since school", 1, "locked")
    link("Adaeze Okafor", "Ifeoma Nwosu", "loves", "", 4, "draft")
    link("Kunle Bello", "Adaeze Okafor", "ally", "", 3)
    link("Kunle Bello", "Chief Oduya", "works_for", "used to", 2, "locked")
    link("Chief Oduya", "Adaeze Okafor", "hates", "she saw the ledger", 5)
    link("The Masked Ferryman", "Chief Oduya", "works_for", "", 3, "draft")
    link("The Masked Ferryman", "The Bronze Mask", "owns", "", 3, "locked")
    link("Emeka Obi", "Adaeze Okafor", "rivals", "the guild apprenticeship", 2)
    link("Zainab Musa", "The Ferrymen's Guild", "member_of", "", 1)
    link("Captain Ike", "The Ferrymen's Guild", "member_of", "", 1, "draft")
    link("Yemi Cole", "Kunle Bello", "family", "cousins", 7, "draft")
    link("Yemi Cole", "Kunle Bello", "strangers", "", 8, "draft")
    link("Mama Ronke", "Mama Ronke's Ledger", "owns", "", 1, "locked")
    link("Chief Oduya", "Oduya Compound", "lives_at", "", 1, "locked")
    link("Adaeze Okafor", "Lagos Lagoon", "lives_at", "", 1)
    link("Chief Oduya", "The Night Council", "member_of", "", 6)
    link("Adaeze Okafor", "Who sank the night ferry", "knows_secret", "", 11, "draft")
    link("The torn guild badge", "Who sank the night ferry", "clue_for", "", 2)
    link("Sola Ade", "The ferrymen's strike", "thread", "", 2)
    link("Tunde Okafor", "The Old Ferry Pier", "lives_at", "", 9)
    link("Ifeoma Nwosu", "Kunle Bello", "rivals", "", 12, "draft")
    # a chapter that changes a locked link (a conflict) — exactly as the tracker would deliver it
    sm.from_chapter(store, pid, BR, {"chapter_id": "ch12", "number": 12,
                                     "text": chapter_text(12) + " Adaeze Okafor stared at Tunde Okafor as if he "
                                                                "were a stranger she had never met."},
                    {"links": [{"from": "Adaeze Okafor", "to": "Tunde Okafor", "kind": "strangers", "note": "",
                                "change": "changed", "on_page": True,
                                "quote": "Adaeze Okafor stared at Tunde Okafor as if he were a stranger she had never "
                                         "met."}]})
    # a link about a character who was deleted from the Book Bible
    cur = sm.get(store, pid, BR)
    lid = sm._new_link_id(cur)  # noqa: SLF001
    cur["links"][lid] = {"from": ids["Captain Ike"], "to": "C:deleted-ghost", "to_name": "Ferry Boy Wale",
                         "to_kind": "character", "kind": "mentor", "note": "", "since": 3, "status": "approved",
                         "source": "user", "evidence": [], "history": []}
    store.set_setting(sm.KEY.format(pid=pid, branch=BR), cur)
    return pid
