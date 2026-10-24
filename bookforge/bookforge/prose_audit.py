"""P6 pattern checker: repeated tics and habits in chapter prose, counted without any AI.

``audit(text, chapter=...)`` checks one chapter, ``audit_book([(chapter_id, text), ...])`` the whole book (rates over
all its words, passages from every chapter, plus a per-chapter word count). Both are pure Python, deterministic and
fast (a 5 000-word chapter takes a few milliseconds), and never call an AI or store anything.

What is counted (each check has a plain label, a threshold per 1 000 words or a share, and a severity):

* ``gesture``        repeated gesture / stillness phrases ("went very still", "for a long time", "looked at" ...);
                     the list is configurable (``settings["gestures"]``).
* ``not_parallel``   negative parallelism: sentences that start with "Not " and "not X, not Y" / "not X but Y".
* ``triad``          lists of three ("cold, wet, and tired").
* ``moral_ending``   paragraphs that end on an aphorism or moral: a short last sentence that starts with "That was",
                     "It was", "That is", "Some ..." or names abstract nouns (truth, grief, home, light ...).
* ``named_emotion``  dialogue that names the speaker's feelings ("I feel", "I'm afraid", "half of me").
* ``said_bookism``   fancy dialogue tags ("she breathed", "he hissed") against plain ones ("said", "asked").
* ``uniform_length`` sentence lengths that hardly vary (coefficient of variation of words per sentence).
* ``same_opening``   three or more sentences in a row that start with the same word, and openings used over and over.
* ``overused_word``  content words used far more often than usual (per 1 000 words), plus a watch list of filler
                     words ("just", "very", "softly", "something" ...); names of characters are ignored.
* ``dialogue_share`` how much of the dialogue each speaker has (stats; a finding when one voice has nearly all of it).
* ``reassurance``    lines that take the risk away ("It won't hurt anyone", "don't worry", "you're safe").

Output: ``{"words", "paragraphs", "sentences", "findings": [...], "stats": {...}, "summary": {"major", "minor",
"info"}, "strictness"}``. Each finding: ``{"id", "check", "label", "severity": info|minor|major, "count",
"per_1000", "threshold", "detail", "advice", "passages": [{"chapter", "paragraph", "excerpt"}]}`` with paragraph
numbers counted from 1 and excerpts of at most 80 characters (``EXCERPT_MAX``). Only these short excerpts of the
author's text ever leave this module.

Strictness (``gentle`` / ``normal`` / ``strict``) scales every threshold (1.5x / 1x / 0.7x).
"""
from __future__ import annotations

import re
import statistics
from collections import Counter, defaultdict

EXCERPT_MAX = 80
MAX_PASSAGES = 8
STRICTNESS = {"gentle": 1.5, "normal": 1.0, "strict": 0.7}

GESTURES = (
    "went very still", "very still", "went still", "for a long time", "for a long moment", "a long while",
    "looked at", "looked away", "did not answer", "didn't answer", "breathed out", "let out a breath",
    "held her breath", "held his breath", "for a moment", "said nothing", "nodded slowly", "swallowed hard",
    "met her eyes", "met his eyes", "something shifted", "the silence stretched", "waited",
)
WATCH_WORDS = ("just", "very", "really", "still", "quiet", "quietly", "softly", "slowly", "suddenly", "something",
               "somehow", "almost", "seemed", "simply", "gently", "carefully", "perhaps")
EMOTION_PHRASES = (
    "i feel", "i felt", "i'm afraid", "i am afraid", "i was afraid", "i'm scared", "i am scared", "i'm frightened",
    "half of me", "part of me", "i'm angry", "i am angry", "i'm so angry", "i'm sad", "i am sad", "i'm worried",
    "i am worried", "i'm lonely", "i am lonely", "makes me feel", "made me feel", "i'm happy", "i am happy",
    "i'm ashamed", "i am ashamed", "i'm hurt", "it hurts me", "i'm grieving", "my heart is",
)
REASSURANCE = (
    "won't hurt", "will not hurt", "wouldn't hurt", "it's safe", "it is safe", "you're safe", "you are safe",
    "perfectly safe", "nothing bad will happen", "nothing will happen", "it's going to be fine", "it'll be fine",
    "it will be fine", "everything will be fine", "everything will be all right", "it's going to be all right",
    "don't worry", "do not worry", "no need to worry", "nothing to fear", "no danger", "you'll be fine",
    "you will be fine", "no one will be hurt", "no one gets hurt", "nobody will be hurt", "i promise",
)
PLAIN_TAGS = ("said", "says", "asked", "asks", "say", "ask", "replied", "answered", "told")
BOOKISMS = (
    "whispered", "murmured", "hissed", "breathed", "growled", "snapped", "exclaimed", "retorted", "sighed",
    "muttered", "chuckled", "laughed", "gasped", "admitted", "declared", "intoned", "mused", "quipped", "sneered",
    "purred", "barked", "cried", "shouted", "yelled", "snarled", "teased", "pleaded", "begged", "insisted",
    "offered", "ventured", "conceded", "observed", "remarked", "croaked", "rasped", "breathed", "soothed",
    "admonished", "chided", "grunted", "groaned", "moaned", "stammered", "stuttered", "whimpered", "sobbed",
)
ABSTRACT = (
    "truth", "love", "grief", "hope", "memory", "memories", "home", "light", "darkness", "dark", "silence", "time",
    "fear", "kindness", "mercy", "forgiveness", "courage", "loss", "nothing", "everything", "always", "never",
    "heart", "soul", "world", "peace", "promise", "promises", "enough", "remembering", "forgetting", "meaning",
    "belonging", "freedom", "sorrow", "joy", "faith", "trust", "secret", "secrets", "dead", "living", "past",
)
MORAL_STARTS = ("that was", "it was", "that is", "this is", "this was", "that's", "it's", "some ", "sometimes",
                "maybe that", "perhaps that", "and that", "that, too", "such is", "there are", "there is",
                "it had always", "it always", "nothing ", "everything ", "no one ", "everyone ")
STOP = set("""a about above after again against all almost also am an and any are aren't as at be because been before
being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each
few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself
his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not
of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so
some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've
this those through to too under until up upon very was wasn't we we'd we'll we're we've were weren't what what's when
when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your
yours yourself yourselves one two back like into onto said says asked would could will shall must just still even ever
never again away down only then than though through been were what when where which while""".split())

# per check: thresholds per 1 000 words (minor, major) and the minimum count before anything is reported
THRESHOLDS = {
    "gesture": {"min": 2, "minor": 1.5, "major": 3.5},
    "not_parallel": {"min": 2, "minor": 1.5, "major": 3.0},
    "triad": {"min": 3, "minor": 4.0, "major": 8.0},
    "moral_ending": {"min": 2, "minor": 2.0, "major": 4.0},
    "named_emotion": {"min": 2, "minor": 1.0, "major": 2.5},
    "said_bookism": {"min": 3, "minor": 0.4, "major": 0.6},         # share of all dialogue tags
    "uniform_length": {"min": 15, "minor": 0.40, "major": 0.30},    # coefficient of variation (lower = more uniform)
    "same_opening": {"min": 1, "minor": 1.0, "major": 3.0},         # runs per 1 000 words
    "overused_word": {"min": 5, "minor": 6.0, "major": 12.0},
    "watch_word": {"min": 4, "minor": 3.0, "major": 6.0},
    "dialogue_share": {"min": 6, "minor": 0.85, "major": 0.95},     # one speaker's share of dialogue words
    "reassurance": {"min": 1, "minor": 1.0, "major": 2.5},
}
LABELS = {
    "gesture": "Repeated gesture or stillness phrase",
    "not_parallel": "Negative parallelism (“Not X. Not Y.”)",
    "triad": "Lists of three",
    "moral_ending": "Paragraphs that end on a moral or aphorism",
    "named_emotion": "Dialogue that names feelings outright",
    "said_bookism": "Fancy dialogue tags instead of “said”",
    "uniform_length": "Sentences of very similar length",
    "same_opening": "Sentences that start the same way",
    "overused_word": "Overused word",
    "watch_word": "Filler word used often",
    "dialogue_share": "One speaker has almost all the dialogue",
    "reassurance": "Reassurance that removes the risk",
}
ADVICE = {
    "gesture": "Vary or cut the repeated gesture; let a specific action or a line of dialogue carry the moment.",
    "not_parallel": "Say what it is instead of listing what it is not.",
    "triad": "Not every list needs three items; use one precise detail or two.",
    "moral_ending": "End the paragraph on an image or an action and let the reader draw the conclusion.",
    "named_emotion": "Show the feeling through what the character does, avoids or misreads instead of naming it.",
    "said_bookism": "Plain “said”/“asked” disappear; let the words show how they were said.",
    "uniform_length": "Mix short and long sentences so the rhythm follows the scene.",
    "same_opening": "Start sentences differently (an action, an object, a sound, a line of dialogue).",
    "overused_word": "Use this word less often; find the precise word for each place.",
    "watch_word": "Cut the filler word where the sentence works without it.",
    "dialogue_share": "Give the other characters their own lines, wishes and resistance.",
    "reassurance": "Keep the risk real: let the reassurance be wrong, doubted or refused, or cut it.",
}

_PARA_SPLIT = re.compile(r"\n\s*\n")
_SENT = re.compile(r"[^.!?…]+(?:[.!?…]+[\"'”’)]*|$)", re.S)
_WORD = re.compile(r"[A-Za-z’'][A-Za-z’'-]*")
_QUOTE = re.compile(r"[\"“]([^\"“”]{1,1200})[\"”]")
_NOT_PAR = re.compile(r"\bnot\b[^.;!?]{1,60}?,\s*(?:and\s+|but\s+)?not\b|\bnot\b[^.;!?,]{1,40}?\bbut\b", re.I)
_TRIAD = re.compile(r"\b([\w'’-]+(?: [\w'’-]+){0,2}), ([\w'’-]+(?: [\w'’-]+){0,2}),? (?:and|or) ([\w'’-]+(?: [\w'’-]+){0,2})\b")
_TAG_AFTER = re.compile(r"[\"”][,]?\s*(?:([A-Z][\w'’-]+|he|she|they|I|we)\s+([a-z]+)|([a-z]+)\s+([A-Z][\w'’-]+|he|she|they))\b")
_TAG_BEFORE = re.compile(r"\b([A-Z][\w'’-]+|He|She|They|I|We)\s+([a-z]+)(?:\s+\w+)?\s*[,:]\s*[\"“]")


def _norm_q(s: str) -> str:
    return s.replace("’", "'").replace("‘", "'")


def paragraphs(text: str) -> list[str]:
    """Paragraphs of a chapter (blank-line separated); a leading "# Title" line is not a paragraph."""
    out = []
    for p in _PARA_SPLIT.split(text or ""):
        p = p.strip()
        if not p or (p.startswith("#") and "\n" not in p):
            continue
        if p.startswith("#"):
            p = p.split("\n", 1)[1].strip()
            if not p:
                continue
        out.append(" ".join(p.split()))
    return out


def sentences(par: str) -> list[str]:
    return [s.strip() for s in _SENT.findall(par) if s.strip() and _WORD.search(s)]


def words(text: str) -> list[str]:
    return _WORD.findall(text or "")


def excerpt(par: str, start: int = 0, end: int | None = None) -> str:
    """At most EXCERPT_MAX characters around [start, end) of a paragraph."""
    end = len(par) if end is None else end
    if len(par) <= EXCERPT_MAX:
        return par
    mid = (start + end) // 2
    a = max(0, min(mid - EXCERPT_MAX // 2, len(par) - EXCERPT_MAX + 2))
    b = min(len(par), a + EXCERPT_MAX - 2)
    s = par[a:b].strip()
    return (("…" if a > 0 else "") + s + ("…" if b < len(par) else ""))[:EXCERPT_MAX]


def _finding(check, count, rate, thr, passages, detail="", key=None, severity=None):
    return {"id": f"{check}:{key}" if key else check, "check": check, "label": LABELS[check] + (f": “{key}”" if key
            and check in ("gesture", "overused_word", "watch_word") else ""), "severity": severity or "info",
            "count": count, "per_1000": round(rate, 2), "threshold": thr, "detail": detail, "advice": ADVICE[check],
            "passages": passages[:MAX_PASSAGES]}


def _sev(value, thr, *, lower_is_worse=False) -> str | None:
    if lower_is_worse:
        if value <= thr["major"]:
            return "major"
        if value <= thr["minor"]:
            return "minor"
        return None
    if value >= thr["major"]:
        return "major"
    if value >= thr["minor"]:
        return "minor"
    return None


def _thresholds(strictness: str, overrides: dict | None) -> dict:
    f = STRICTNESS.get(strictness or "normal", 1.0)
    out = {}
    for k, v in THRESHOLDS.items():
        v = dict(v, **((overrides or {}).get(k) or {}))
        if k == "uniform_length":  # lower is worse: strict raises the bar, gentle lowers it
            out[k] = dict(v, minor=round(v["minor"] / f, 3), major=round(v["major"] / f, 3))
        elif k in ("said_bookism", "dialogue_share"):
            out[k] = dict(v, minor=min(0.99, round(v["minor"] * (1 + (f - 1) / 2), 3)),
                          major=min(0.995, round(v["major"] * (1 + (f - 1) / 2), 3)))
        else:
            out[k] = dict(v, minor=round(v["minor"] * f, 3), major=round(v["major"] * f, 3))
    return out


def audit(text: str, *, chapter: str | None = None, settings: dict | None = None, names=()) -> dict:
    """Pattern report for one chapter (see the module docstring)."""
    return audit_book([(chapter, text or "")], settings=settings, names=names)


def audit_book(chapters, *, settings: dict | None = None, names=()) -> dict:
    """Pattern report over several chapters [(chapter_id, text), ...]; rates use all their words together."""
    settings = settings or {}
    strictness = settings.get("strictness") if settings.get("strictness") in STRICTNESS else "normal"
    thr = _thresholds(strictness, settings.get("thresholds"))
    gestures = tuple(g.lower() for g in (settings.get("gestures") or GESTURES) if isinstance(g, str) and g.strip())
    ignore = {n.lower() for n in names or () if isinstance(n, str)}
    for n in list(ignore):
        ignore.update(n.split())
    pars: list[tuple[str | None, int, str]] = []
    per_chapter = []
    for cid, text in chapters:
        ps = paragraphs(text)
        per_chapter.append({"chapter": cid, "words": sum(len(words(p)) for p in ps), "paragraphs": len(ps)})
        pars.extend((cid, i + 1, p) for i, p in enumerate(ps))
    n_words = sum(c["words"] for c in per_chapter)
    k = 1000.0 / max(n_words, 1)
    findings: list[dict] = []
    stats: dict = {"chapters": per_chapter}

    def loc(cid, pi, par, a=0, b=None):
        return {"chapter": cid, "paragraph": pi, "excerpt": excerpt(par, a, b)}

    # -- gestures (each phrase on its own; a longer phrase hides the shorter one inside it at the same place)
    g_hits: dict[str, list] = defaultdict(list)
    for cid, pi, par in pars:
        low = _norm_q(par.lower())
        taken: list[tuple[int, int]] = []
        for g in sorted(gestures, key=len, reverse=True):
            for m in re.finditer(r"\b" + re.escape(_norm_q(g)) + r"\b", low):
                if any(a <= m.start() < b for a, b in taken):
                    continue
                taken.append((m.start(), m.end()))
                g_hits[g].append(loc(cid, pi, par, m.start(), m.end()))
    total_g = 0
    for g, hits in sorted(g_hits.items(), key=lambda x: (-len(x[1]), x[0])):
        total_g += len(hits)
        t = thr["gesture"]
        if len(hits) >= t["min"]:
            findings.append(_finding("gesture", len(hits), len(hits) * k, t, hits, f"“{g}” {len(hits)}×", key=g,
                                     severity=_sev(len(hits) * k, t) or "info"))
    stats["gestures"] = {g: len(h) for g, h in g_hits.items()}

    def simple(check, hits, detail):
        t = thr[check]
        if len(hits) >= t["min"]:
            findings.append(_finding(check, len(hits), len(hits) * k, t, hits, detail,
                                     severity=_sev(len(hits) * k, t) or "info"))

    # -- negative parallelism
    hits = []
    for cid, pi, par in pars:
        seen = set()
        for s in sentences(par):
            if re.match(r"^[\"“]?Not\b", s):
                a = par.find(s)
                hits.append(loc(cid, pi, par, a, a + len(s)))
                seen.add(a)
        for m in _NOT_PAR.finditer(par):
            if not any(a <= m.start() < a + 60 for a in seen):
                hits.append(loc(cid, pi, par, m.start(), m.end()))
    simple("not_parallel", hits, f"{len(hits)} sentence(s) say what something is not")

    # -- triads
    hits = []
    for cid, pi, par in pars:
        for m in _TRIAD.finditer(par):
            if sum(len(g.split()) for g in m.groups()) <= 9:
                hits.append(loc(cid, pi, par, m.start(), m.end()))
    simple("triad", hits, f"{len(hits)} list(s) of three")

    # -- paragraph endings that state a moral
    hits = []
    for cid, pi, par in pars:
        ss = sentences(par)
        if len(ss) < 2:
            continue
        last = ss[-1]
        ws = [w.lower() for w in words(last)]
        if not ws or len(ws) > 12 or last.lstrip().startswith(("\"", "“")):
            continue
        low = _norm_q(last.lower().lstrip("\"“ "))
        if low.startswith(MORAL_STARTS) or (sum(1 for w in ws if w in ABSTRACT) >= 1 and len(ws) <= 9 and
                                            any(w in ("is", "was", "are", "were", "had", "has", "be") for w in ws)):
            a = par.rfind(last)
            hits.append(loc(cid, pi, par, a, a + len(last)))
    simple("moral_ending", hits, f"{len(hits)} of {len(pars)} paragraph(s)")

    # -- dialogue: named emotions, reassurance, tags and speakers
    emo, reas = [], []
    tags = Counter()
    bookism_hits = []
    speakers: Counter = Counter()
    dialogue_words = 0
    for cid, pi, par in pars:
        for m in _QUOTE.finditer(par):
            q = _norm_q(m.group(1).lower())
            dialogue_words += len(words(q))
            for ph in EMOTION_PHRASES:
                if re.search(r"\b" + re.escape(ph) + r"\b", q):
                    emo.append(loc(cid, pi, par, m.start(), m.end()))
                    break
            for ph in REASSURANCE:
                if re.search(r"\b" + re.escape(ph) + r"\b", q):
                    reas.append(loc(cid, pi, par, m.start(), m.end()))
                    break
            who = None
            tail = par[m.end():m.end() + 40]
            head = par[max(0, m.start() - 40):m.start() + 1]
            mt = _TAG_AFTER.match(par[m.end() - 1:m.end() + 40])
            verb = None
            if mt:
                if mt.group(1):
                    who, verb = mt.group(1), mt.group(2)
                else:
                    verb, who = mt.group(3), mt.group(4)
            else:
                before = list(_TAG_BEFORE.finditer(head))
                mb = before[-1] if before else None
                if mb and mb.end() >= len(head) - 1:
                    who, verb = mb.group(1), mb.group(2)
            if verb and (verb in PLAIN_TAGS or verb in BOOKISMS):
                tags["plain" if verb in PLAIN_TAGS else "bookism"] += 1
                if verb in BOOKISMS:
                    bookism_hits.append(loc(cid, pi, par, m.start(), min(len(par), m.end() + len(tail))))
            else:
                who = who if who and who[0].isupper() and who not in ("He", "She", "They", "I", "We") else None
            if who and who[0].isupper() and who not in ("He", "She", "They", "I", "We"):
                speakers[who] += len(words(q))
    simple("named_emotion", emo, f"{len(emo)} line(s) of dialogue name a feeling")
    simple("reassurance", reas, f"{len(reas)} line(s) take the risk away")
    n_tags = tags["plain"] + tags["bookism"]
    stats["dialogue_tags"] = {"plain": tags["plain"], "fancy": tags["bookism"]}
    if tags["bookism"] >= thr["said_bookism"]["min"] and n_tags:
        share = tags["bookism"] / n_tags
        sev = _sev(share, thr["said_bookism"])
        if sev:
            f = _finding("said_bookism", tags["bookism"], tags["bookism"] * k, thr["said_bookism"], bookism_hits,
                         f"{tags['bookism']} of {n_tags} dialogue tags ({round(share * 100)}%)", severity=sev)
            f["share"] = round(share, 3)
            findings.append(f)
    total_dw = sum(speakers.values())
    stats["dialogue"] = {"share_of_words": round(dialogue_words / max(n_words, 1), 3),
                         "speakers": {s: {"words": w, "share": round(w / total_dw, 3)} for s, w in speakers.most_common(8)}
                         if total_dw else {}}
    if len(speakers) >= 2 and total_dw:
        top, tw = speakers.most_common(1)[0]
        share = tw / total_dw
        lines = sum(1 for _cid, _pi, par in pars for _m in _QUOTE.finditer(par))
        t = thr["dialogue_share"]
        if lines >= t["min"] and share >= t["minor"]:
            f = _finding("dialogue_share", lines, lines * k, t, [], f"{top} has {round(share * 100)}% of the dialogue",
                         severity="minor" if share >= t["major"] else "info")
            f["share"] = round(share, 3)
            findings.append(f)

    # -- sentence lengths
    sent_lists = [(cid, pi, par, sentences(par)) for cid, pi, par in pars]
    lens = [len(words(s)) for *_x, ss in sent_lists for s in ss]
    stats["sentences"] = {"count": len(lens), "mean": round(statistics.mean(lens), 1) if lens else 0,
                          "stdev": round(statistics.pstdev(lens), 1) if len(lens) > 1 else 0}
    t = thr["uniform_length"]
    if len(lens) >= t["min"]:
        cv = statistics.pstdev(lens) / max(statistics.mean(lens), 1)
        stats["sentences"]["variation"] = round(cv, 3)
        sev = _sev(cv, t, lower_is_worse=True)
        if sev:
            f = _finding("uniform_length", len(lens), 0, t, [], f"average {stats['sentences']['mean']} words, "
                         f"spread {stats['sentences']['stdev']} (variation {round(cv, 2)})", severity=sev)
            findings.append(f)

    # -- same sentence openings: runs of 3+ in one paragraph, and the most used two-word openings
    runs = []
    openings = Counter()
    for cid, pi, par, ss in sent_lists:
        firsts = [(words(s)[0].lower() if words(s) else "") for s in ss]
        for s in ss:
            w = [x.lower() for x in words(s)[:2]]
            if len(w) == 2:
                openings[" ".join(w)] += 1
        i = 0
        while i < len(firsts):
            j = i
            while j + 1 < len(firsts) and firsts[j + 1] == firsts[i] and firsts[i]:
                j += 1
            if j - i + 1 >= 3:
                a = par.find(ss[i])
                runs.append(loc(cid, pi, par, a, a + len(ss[i]) + len(ss[i + 1])))
            i = j + 1
    t = thr["same_opening"]
    if len(runs) >= t["min"]:
        sev = _sev(len(runs) * k, t) or "info"
        findings.append(_finding("same_opening", len(runs), len(runs) * k, t, runs,
                                 f"{len(runs)} run(s) of 3+ sentences starting with the same word", severity=sev))
    stats["top_openings"] = [{"opening": o, "count": c} for o, c in openings.most_common(5) if c >= 3]

    # -- overused words and watch words (names ignored)
    counts = Counter()
    caps = Counter()
    for _cid, _pi, par in pars:
        for w in words(par):
            lw = _norm_q(w.lower()).strip("'")
            counts[lw] += 1
            if w[0].isupper():
                caps[lw] += 1
    word_pass: dict[str, list] = {}

    def where(word):
        if word not in word_pass:
            out = []
            for cid, pi, par in pars:
                m = re.search(r"\b" + re.escape(word) + r"\b", _norm_q(par.lower()))
                if m:
                    out.append(loc(cid, pi, par, m.start(), m.end()))
                if len(out) >= MAX_PASSAGES:
                    break
            word_pass[word] = out
        return word_pass[word]
    watch = {w.lower() for w in (settings.get("watch_words") or WATCH_WORDS)}
    for w, c in counts.most_common(400):
        if w in ignore or caps[w] >= c * 0.6:
            continue
        if w in watch:
            t = thr["watch_word"]
        elif len(w) >= 4 and w not in STOP:
            t = thr["overused_word"]
        else:
            continue
        rate = c * k
        if c >= t["min"]:
            sev = _sev(rate, t)
            if sev:
                check = "watch_word" if w in watch else "overused_word"
                findings.append(_finding(check, c, rate, t, where(w), f"“{w}” {c}× ({round(rate, 1)} per 1 000 words)",
                                         key=w, severity=sev))

    order = {"major": 0, "minor": 1, "info": 2}
    findings.sort(key=lambda f: (order[f["severity"]], -f["count"], f["id"]))
    summary = Counter(f["severity"] for f in findings)
    stats["gesture_total"] = total_g
    return {"words": n_words, "paragraphs": len(pars), "sentences": len(lens), "findings": findings,
            "stats": stats, "summary": {s: summary.get(s, 0) for s in ("major", "minor", "info")},
            "strictness": strictness}


def brief(report: dict, limit: int = 12) -> dict:
    """The part of a pattern report the AI editor gets (no long text): counts, rates and short excerpts."""
    return {"words": report.get("words"), "summary": report.get("summary"), "strictness": report.get("strictness"),
            "findings": [{k: f.get(k) for k in ("id", "label", "severity", "count", "per_1000", "detail")}
                         | {"examples": [p["excerpt"] for p in f.get("passages", [])[:3]]}
                         for f in (report.get("findings") or [])[:limit] if f["severity"] != "info"
                         or f["check"] in ("gesture", "named_emotion", "reassurance")],
            "sentence_stats": (report.get("stats") or {}).get("sentences"),
            "dialogue": (report.get("stats") or {}).get("dialogue")}


def counts_only(report: dict) -> dict:
    """A pattern report without any passage text (for logs, the journal and the activity events)."""
    return {"words": report.get("words"), "summary": report.get("summary"),
            "checks": {f["id"]: {"severity": f["severity"], "count": f["count"]} for f in report.get("findings") or []}}
