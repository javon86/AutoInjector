"""🔁 Repetition sorter (P30): before a repeat is cut, Akọwe decides what kind of repeat it is.

ChatGPT's review of book 2: some repeats are a character's voice ("Right, so" — the way one person starts talking)
or a motif (Odile counting the lamps, "thirty-two, thirty-three …"), others are filler or plain accidents. An editor
that cuts every repeat flattens the voices. So every repeated phrase of the book is sorted, deterministically:

* ``voice``    — it lives in one character's dialogue (≥ 80 % of its uses are in dialogue and every tagged line is
                 the same speaker), or it is one of that character's voice-card phrases (P17);
* ``motif``    — counting runs ("thirty-two, thirty-three"), a world-texture word (P10) or an author's motif, or a phrase
                 that comes back across chapters with distance between its uses;
* ``filler``   — stock filler and gesture phrases ("for a long moment", "let out a breath", the pattern checker's
                 gesture list);
* ``accident`` — everything else that repeats (most often the same words twice within a few paragraphs).

The author can relabel any phrase (settings ``repetition_labels:<project>:<branch>`` = {version, labels: {phrase:
class}}); the author's label always wins.

What may be cut: **only accidental repeats and the excess of the others.** Accident → every use after the first in
a chapter; filler → every use after the first in a chapter; voice → only a second use inside the same paragraph;
motif → only uses crowded within two paragraphs of the previous one. Each occurrence carries ``trim: true|false``.
Voice and motif phrases are *protected*: their exact words go into the keep list of every editor rewrite
(editor.propose, via fact_checks.protected_keep), so a rewrite that removes them is refused (KEEP_LOST) — unless it
is Akọwe's own trim of exactly that excess. Pure Python, no AI; the trim itself is a P5 rewrite (fact_checks).
"""
from __future__ import annotations

import re
from collections import defaultdict

from .prose_audit import _QUOTE, _TAG_AFTER, _TAG_BEFORE, GESTURES, STOP

CLASSES = ("voice", "motif", "filler", "accident")
CLASS_WORDS = {"voice": "Voice (keep)", "motif": "Motif (keep)", "filler": "Filler (trim excess)",
               "accident": "Accidental (cut)"}
MAX_N = 6
MIN_N = 2
MAX_REPEATS = 40
MAX_OCC = 30
MOTIF_GAP = 6          # paragraphs between uses for a phrase to read as a motif rather than an accident
CROWD = 2              # motif uses within this many paragraphs of the previous one are excess
EXCERPT_MAX = 100
FILLER = tuple(dict.fromkeys(GESTURES + (
    "for a moment", "a beat", "seemed to", "began to", "started to", "couldn't help but", "could not help but",
    "in that moment", "let out a breath", "the fact that", "all of a sudden", "for some reason", "at the same time",
    "a long moment", "for a long moment", "for a second", "in the end", "it was as if", "as if to say",
    "without a word", "out of nowhere", "the corner of her eye", "the corner of his eye")))
_NUMW = (r"(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:-(?:one|two|three|four|five|six|seven|"
         r"eight|nine))?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|"
         r"sixteen|seventeen|eighteen|nineteen|hundred|\d{1,3})")
COUNTING = re.compile(rf"\b{_NUMW}(?:\s*(?:,|\.\.\.|…|—|-|;)\s*|\s+)(?:and\s+)?{_NUMW}\b(?:(?:\s*(?:,|\.\.\.|…|—|;)\s*"
                      rf"|\s+){_NUMW}\b)*", re.I)
_PARA = re.compile(r"\n\s*\n")
_SENT = re.compile(r"[^.!?…]+(?:[.!?…]+[\"'”’)]*|$)", re.S)
_TOK = re.compile(r"[A-Za-z’'][A-Za-z’'-]*")
_PRON = {"He", "She", "They", "I", "We"}


def _norm(w: str) -> str:
    return w.lower().replace("’", "'").strip("'-")


def norm_phrase(p: str) -> str:
    return " ".join(_norm(t) for t in _TOK.findall(p or ""))


def paragraphs(text: str) -> list[str]:
    out = []
    for p in _PARA.split(text or ""):
        p = p.strip()
        if p.startswith("#"):
            p = p.split("\n", 1)[1].strip() if "\n" in p else ""
        if p:
            out.append(" ".join(p.split()))
    return out


def _excerpt(par: str, a: int, b: int) -> str:
    if len(par) <= EXCERPT_MAX:
        return par
    mid = (a + b) // 2
    s = max(0, min(mid - EXCERPT_MAX // 2, len(par) - EXCERPT_MAX))
    return ("…" if s else "") + par[s:s + EXCERPT_MAX].strip() + ("…" if s + EXCERPT_MAX < len(par) else "")


def _dialogue(par: str) -> list[tuple[int, int, str | None]]:
    """[(start, end, speaker or None)] of the quoted spans of a paragraph (speaker from a capitalised tag)."""
    out = []
    for m in _QUOTE.finditer(par):
        who = None
        mt = _TAG_AFTER.match(par[m.end() - 1:m.end() + 40])
        if mt:
            who = mt.group(1) or mt.group(4)
        else:
            head = par[max(0, m.start() - 40):m.start() + 1]
            before = list(_TAG_BEFORE.finditer(head))
            if before and before[-1].end() >= len(head) - 1:
                who = before[-1].group(1)
        out.append((m.start(), m.end(), who if who and who[0].isupper() and who not in _PRON else None))
    return out


def _speaker_name(who: str | None, aliases: dict) -> str | None:
    if not who:
        return None
    return aliases.get(who, who)


# ====================================================================== collect
def _occurrences(chapters, names: set, aliases: dict):
    """n-gram -> [occurrence] for every 2..6-word sequence inside one sentence; plus counting runs."""
    grams: dict[str, list] = defaultdict(list)
    counting = []
    for cid, text in chapters:
        for pi, par in enumerate(paragraphs(text)):
            spans = _dialogue(par)

            def where(a, _spans=spans):
                for s, e, who in _spans:
                    if s <= a < e:
                        return True, _speaker_name(who, aliases), a - s <= 2
                return False, None, False
            for m in COUNTING.finditer(par):
                ind, who, _o = where(m.start())
                counting.append({"chapter": cid, "paragraph": pi, "start": m.start(), "end": m.end(),
                                 "surface": m.group(0), "dialogue": ind, "speaker": who, "par": par})
            for sm in _SENT.finditer(par):
                toks = [(t.group(0), sm.start() + t.start(), sm.start() + t.end()) for t in _TOK.finditer(sm.group(0))]
                low = [_norm(t[0]) for t in toks]
                for i in range(len(toks)):
                    for n in range(MIN_N, MAX_N + 1):
                        if i + n > len(toks):
                            break
                        key = " ".join(low[i:i + n])
                        a, b = toks[i][1], toks[i + n - 1][2]
                        ind, who, opener = where(a)
                        grams[key].append({"chapter": cid, "paragraph": pi, "start": a, "end": b,
                                           "surface": par[a:b], "dialogue": ind, "speaker": who,
                                           "opener": opener, "par": par})
    return grams, counting


def _wanted(key: str, occ: list, names: set, filler: set, voice_phrases: set) -> bool:
    ws = key.split()
    content = [w for w in ws if w not in STOP and w not in names and not w.isdigit()]
    if key in filler or key in voice_phrases:
        return True
    if all(w in names or w in STOP for w in ws):
        return False
    if len(ws) == 2:
        # two words: only a line opener in dialogue ("Right, so"); "years old", "brass key" … are just language
        openers = sum(1 for o in occ if o["opener"])
        return openers >= 2
    return len(content) >= 2


def _maximal(cands: dict) -> dict:
    """Drop a phrase when a longer repeated phrase containing it is used as often (keep 'for a long moment', not
    also 'a long moment')."""
    keys = sorted(cands, key=lambda k: -len(k.split()))
    out = {}
    for k in keys:
        n = len(cands[k])
        if any(f" {k} " in f" {big} " and len(cands[big]) >= n for big in out):
            continue
        out[k] = cands[k]
    return out


def _merge(cands: dict) -> dict:
    """Join overlapping windows of one long repeat ("the old brass rail was cold under her hand" is seen as several
    6-word windows used equally often) into one phrase."""
    def sig(occ):
        return tuple((o["chapter"], o["paragraph"]) for o in occ)
    groups: dict[tuple, list] = defaultdict(list)
    for k, occ in cands.items():
        occ.sort(key=lambda o: (o["chapter"], o["paragraph"], o["start"]))
        groups[sig(occ)].append((k, occ))
    out = {}
    for _s, items in groups.items():
        items.sort(key=lambda kv: kv[1][0]["start"])
        cur_k, cur = items[0][0], [dict(o) for o in items[0][1]]
        for k, occ in items[1:]:
            if all(b["start"] <= a["end"] + 1 and b["end"] >= a["start"] for a, b in zip(cur, occ)):
                for a, b in zip(cur, occ):
                    a["start"], a["end"] = min(a["start"], b["start"]), max(a["end"], b["end"])
                    a["surface"] = a["par"][a["start"]:a["end"]]
                cur_k = norm_phrase(cur[0]["surface"])
                continue
            out[cur_k] = cur
            cur_k, cur = k, [dict(o) for o in occ]
        out[cur_k] = cur
    return out


# ====================================================================== classify + trim plan
def sort_repeats(chapters, *, names=(), voices: dict | None = None, motifs=(), labels: dict | None = None) -> dict:
    """``chapters``: [(chapter_id, text)] in book order. ``voices``: characters.voice_words() ({name: {phrases,
    aliases}}); ``motifs``: words/phrases that are motifs by design (world texture, the author's); ``labels``: the
    author's {phrase: class}. Returns {repeats: [...], counts, protected: [surface forms]}."""
    voices = voices or {}
    labels = {norm_phrase(k): v for k, v in (labels or {}).items() if v in CLASSES}
    aliases = {}
    for name, v in voices.items():
        for a in (v or {}).get("aliases") or [name]:
            aliases[a] = name
    name_toks = {_norm(t) for n in list(names) + list(voices) for t in _TOK.findall(n or "")}
    voice_phrases = {}
    for name, v in voices.items():
        for p in (v or {}).get("phrases") or []:
            np_ = norm_phrase(p)
            if len(np_.split()) >= 1 and np_:
                voice_phrases[np_] = name
    motif_set = {norm_phrase(m) for m in motifs or [] if isinstance(m, str) and norm_phrase(m)}
    filler = {norm_phrase(f) for f in FILLER}
    grams, counting = _occurrences(chapters, name_toks, aliases)
    cands = {k: occ for k, occ in grams.items() if len(occ) >= 2 and
             _wanted(k, occ, name_toks, filler, set(voice_phrases))}
    # voice-card phrases of one word (rare) are not n-grams: they are found above only when ≥ 2 words
    cands = _merge(_maximal(cands))
    order = {cid: i for i, (cid, _t) in enumerate(chapters)}
    repeats = []
    for key, occ in cands.items():
        repeats.append(_classify(key, occ, labels, voice_phrases, motif_set, filler, order))
    if len(counting) >= 2:
        repeats.append(_classify("counting", counting, labels, {}, motif_set | {"counting"}, filler, order,
                                 label="counting (" + counting[0]["surface"][:40] + " …)"))
    rank = {"accident": 0, "filler": 1, "voice": 2, "motif": 3}
    repeats.sort(key=lambda r: (rank[r["class"]], -r["trim_count"], -r["count"]))
    repeats = repeats[:MAX_REPEATS]
    for i, r in enumerate(repeats):
        r["id"] = f"rp{i + 1}"
    protected = sorted({o["surface"] for r in repeats if r["class"] in ("voice", "motif")
                        for o in r["occurrences"] if not o["trim"] and o["surface"]}, key=len, reverse=True)
    return {"repeats": repeats, "protected": protected[:40],
            "counts": {c: sum(1 for r in repeats if r["class"] == c) for c in CLASSES}
            | {"trim": sum(r["trim_count"] for r in repeats)}}


def _classify(key, occ, labels, voice_phrases, motif_set, filler, order, label=None) -> dict:
    occ = sorted(occ, key=lambda o: (order.get(o["chapter"], 0), o["paragraph"], o["start"]))
    chapters = list(dict.fromkeys(o["chapter"] for o in occ))
    in_dlg = [o for o in occ if o["dialogue"]]
    speakers = {o["speaker"] for o in in_dlg if o["speaker"]}
    who, why, conf, source = None, "", "high", "auto"

    def within(table):  # the phrase itself, or a labelled phrase inside a longer repeat ("fair enough" in "fair enough she")
        return key if key in table else next((p for p in table if p and f" {p} " in f" {key} "), None)
    lab, vp = within(labels), within(voice_phrases)
    if lab:
        cls, why, source = labels[lab], "your label", "author"
    elif vp:
        cls, who, why = "voice", voice_phrases[vp], f"a phrase from {voice_phrases[vp]}'s voice card"
    elif len(in_dlg) >= 0.8 * len(occ) and len(speakers) <= 1 and in_dlg:
        cls, who = "voice", next(iter(speakers), None)
        why = f"only in {who}'s dialogue" if who else "only in dialogue (one way of talking)"
        if key == "counting" and not who:
            cls, why = "motif", "counting comes back through the book"
    elif key in motif_set or any(m and f" {m} " in f" {key} " for m in motif_set):
        cls, why = "motif", "counting comes back through the book" if key == "counting" else \
            "a world detail or motif by design"
    elif key in filler:
        cls, why = "filler", "a stock filler / gesture phrase"
    else:
        gaps = _gaps(occ)
        spread = len(chapters) >= 2 and (not gaps or min(gaps) >= MOTIF_GAP)
        if spread:
            cls, why = "motif", f"comes back in {len(chapters)} chapters, never crowded"
        else:
            cls = "accident"
            close = [g for g in gaps if g <= 3]
            why = "the same words again within a few paragraphs" if close else "the same words again"
            conf = "high" if close else "low"
    trims = _trim_plan(cls, occ)
    occurrences = [{"chapter": o["chapter"], "paragraph": o["paragraph"] + 1, "excerpt": _excerpt(o["par"], o["start"],
                                                                                                o["end"]),
                    "surface": o["surface"], "sentence": _sentence_at(o["par"], o["start"]),
                    "dialogue": o["dialogue"], "speaker": o["speaker"], "trim": t}
                   for o, t in zip(occ, trims)][:MAX_OCC]
    return {"key": key, "phrase": label or occ[0]["surface"], "class": cls, "why": why, "who": who, "confidence": conf,
            "source": source, "count": len(occ), "chapters": chapters, "occurrences": occurrences,
            "trim_count": sum(1 for o in occurrences if o["trim"])}


def _gaps(occ) -> list[int]:
    """Paragraph distances between consecutive uses inside the same chapter."""
    out = []
    for a, b in zip(occ, occ[1:]):
        if a["chapter"] == b["chapter"]:
            out.append(b["paragraph"] - a["paragraph"])
    return out


def _trim_plan(cls, occ) -> list[bool]:
    out = []
    first_in = set()
    prev = None
    for o in occ:
        t = False
        if cls in ("accident", "filler"):
            t = o["chapter"] in first_in
            first_in.add(o["chapter"])
        elif cls == "voice":
            t = bool(prev and prev["chapter"] == o["chapter"] and prev["paragraph"] == o["paragraph"])
        elif cls == "motif":
            t = bool(prev and prev["chapter"] == o["chapter"] and o["paragraph"] - prev["paragraph"] < CROWD)
        out.append(t)
        if not t:
            prev = o
    return out


def _sentence_at(par: str, pos: int) -> str:
    for m in _SENT.finditer(par):
        if m.start() <= pos < m.end():
            return m.group(0).strip()
    return par[:200]


def for_chapter(sorted_: dict, chapter_id: str) -> dict:
    """The repeats with uses in one chapter (occurrences filtered to it, the class decided on the whole book)."""
    out = []
    for r in sorted_.get("repeats") or []:
        occ = [o for o in r["occurrences"] if o["chapter"] == chapter_id]
        if len(occ) >= 1 and (len(occ) >= 2 or r["class"] in ("voice", "motif")):
            out.append(dict(r, occurrences=occ, here=len(occ), trim_here=sum(1 for o in occ if o["trim"])))
    return {"repeats": out, "counts": {c: sum(1 for r in out if r["class"] == c) for c in CLASSES}
            | {"trim": sum(r["trim_here"] for r in out)}}


def protected_in(sorted_: dict, text: str, *, except_keys=()) -> list[str]:
    """Exact surface forms of voice/motif repeats present in ``text`` (the keep list of a rewrite)."""
    out = []
    for r in sorted_.get("repeats") or []:
        if r["class"] not in ("voice", "motif") or r["key"] in except_keys:
            continue
        for o in r["occurrences"]:
            if o["surface"] and o["surface"] in text and o["surface"] not in out and not o["trim"]:
                out.append(o["surface"])
    return out[:40]


def findings_for(text: str, chapter_rep: dict, limit: int = 12) -> tuple[list[dict], set]:
    """P5 findings (dimension ``repetition``) for the trimmable uses of one chapter: each anchored at its exact,
    unique sentence (never two on one sentence). Returns (findings, keys targeted)."""
    out, used, keys = [], set(), set()
    for r in chapter_rep.get("repeats") or []:
        for o in r["occurrences"]:
            if not o["trim"] or len(out) >= limit:
                continue
            s = o["sentence"][:300]
            if not s or s in used or text.count(s) != 1 or o["surface"] not in s:
                continue
            used.add(s)
            keys.add(r["key"])
            what = CLASS_WORDS[r["class"]].split(" (")[0].lower()
            out.append({"id": f"rep{len(out) + 1}", "repeat": r["id"], "dimension": "repetition", "severity": "minor",
                        "label": "Repeat to trim", "passage": s,
                        "why": f"Repeat of “{o['surface']}” ({what}: {r['why']}); used {r['count']} time(s) in the book",
                        "suggestion": f"Cut or vary “{o['surface']}” in this sentence only; keep its meaning and the "
                                      "voice. Do not touch other repeats.",
                        "keep_nearby": [], "found": True, "located": True})
    return out, keys


# ====================================================================== the author's labels (companion data)
MAX_LABELS = 200


def _key(pid: str, branch: str) -> str:
    return f"repetition_labels:{pid}:{branch}"


def get_labels(store, pid: str, branch: str) -> dict:
    try:
        e = store.get_setting(_key(pid, branch))
    except Exception:  # noqa: BLE001 - guidance only
        return {"version": 0, "labels": {}}
    return e if isinstance(e, dict) and e.get("version") else {"version": 0, "labels": {}}


def save_labels(store, pid: str, branch: str, labels, *, base_version: int | None = None, by: str = "author") -> dict:
    """Merge the author's labels ({phrase: voice|motif|filler|accident, or "" to remove})."""
    from .errors import AkoweError  # noqa: PLC0415
    from .story_rules import _now, conflict, update_single  # noqa: PLC0415
    if not isinstance(labels, dict) or not labels:
        raise AkoweError("INVALID_INPUT", "/labels", "labels: {phrase: voice | motif | filler | accident | \"\"}",
                             status="REJECTED")
    clean = {}
    for k, v in labels.items():
        nk = norm_phrase(k if isinstance(k, str) else "")[:120]
        if not nk:
            continue
        if v not in CLASSES and v not in ("", None):
            raise AkoweError("INVALID_INPUT", "/labels", "a label is voice, motif, filler or accident (or empty to "
                                 "let Akọwe decide)", status="REJECTED")
        clean[nk] = v or ""
    if not clean:
        raise AkoweError("INVALID_INPUT", "/labels", "no phrase to label", status="REJECTED")

    def change(old):
        old = old or {}
        if base_version is not None and int(old.get("version") or 0) != base_version:
            raise conflict("repeat labels", old.get("version"))
        cur = dict(old.get("labels") or {})
        for k, v in clean.items():
            if v:
                cur[k] = v
            else:
                cur.pop(k, None)
        if len(cur) > MAX_LABELS:
            raise AkoweError("INVALID_INPUT", "/labels", f"at most {MAX_LABELS} labels", status="REJECTED")
        return {"version": int(old.get("version") or 0) + 1, "labels": cur, "updated_at": _now(), "by": by}
    return update_single(store, _key(pid, branch), pid, branch, change, (
        "repetition.labels_saved", lambda e: {"version": e["version"], "labels": len(e["labels"]), "by": by,
                                              **{c: sum(1 for v in e["labels"].values() if v == c) for c in CLASSES}}))
