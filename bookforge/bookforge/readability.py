"""P24 readability and pacing scores, counted without any AI and matched to the book profile's audience.

``chapter(text)`` measures one chapter, ``book([(chapter_id, text), ...], audience=..., genre=...)`` the whole book
(totals over all its words, one row per chapter and findings against the audience's targets). Pure Python,
deterministic and fast; nothing is stored and no text of the book leaves this module (numbers only).

What is measured:

* reading level      Flesch reading ease (0-100, higher = easier) and Flesch-Kincaid grade (school year), from
                     words per sentence and syllables per word (a vowel-group syllable counter, English only).
* sentence variety   average words per sentence, how much sentence lengths vary (coefficient of variation) and the
                     share of very long (> 30 words) and very short (<= 6 words) sentences.
* dialogue share     the share of words inside quotation marks (“…”, "…").
* paragraphs         average words per paragraph.
* scenes             scenes per chapter (split on scene-break lines such as ``* * *``, ``***``, ``#`` or ``---``),
                     average / shortest / longest scene in words.
* pace               fast / steady / slow, from dialogue share, sentence length and paragraph length together.

Audience targets (``AUDIENCES``): the profile's free-text audience is matched by keywords (children, middle grade,
young adult, adult; adult when nothing matches). A literary genre allows two more grade levels. Findings say when
the book reads harder or simpler than its audience usually expects, when sentence lengths hardly vary, when long
sentences pile up, when dialogue is nearly absent or nearly everything, and which chapters stand out from the rest.

Output of ``book``: ``{"audience": {"key", "label", "grade": [lo, hi]}, "totals": {...}, "chapters": [...],
"findings": [{"id", "label", "severity": info|minor|major, "detail", "advice", "chapters": [...]}]}``.
"""
from __future__ import annotations

import re
import statistics

from .prose_audit import paragraphs, sentences, words

LONG_SENTENCE = 30
SHORT_SENTENCE = 6
MAX_CHAPTER_FINDINGS = 8

# Grade range (Flesch-Kincaid) a book for this audience usually sits in, and how long its sentences usually run.
AUDIENCES = {
    "children": {"label": "Children", "grade": (1.0, 4.5), "sentence_max": 12,
                 "keys": ("child", "kid", "picture book", "early reader", "chapter book", "ages 5", "ages 6", "ages 7")},
    "middle_grade": {"label": "Middle grade", "grade": (3.5, 7.0), "sentence_max": 16,
                     "keys": ("middle grade", "middle-grade", "8-12", "8–12", "9-12", "9–12", "tween")},
    "young_adult": {"label": "Young adult", "grade": (5.0, 9.0), "sentence_max": 20,
                    "keys": ("young adult", "teen", "ya ", " ya", "ya,", "ages 12", "ages 13", "ages 14")},
    "adult": {"label": "Adult", "grade": (5.0, 10.0), "sentence_max": 24, "keys": ()},
}
LITERARY_BONUS = 2.0

_SCENE_BREAK = re.compile(r"^\s*(?:(?:\*\s*){3,}|#{1,3}|(?:[-—–~_=]\s*){3,}|[*#⁂§•·]|(?:•\s*){3,})\s*$", re.M)
_QUOTED = re.compile(r"“[^”]*”|\"[^\"\n]*\"")
_VOWELS = re.compile(r"[aeiouy]+")


def audience_of(audience: str | None, genre: str | None = None) -> dict:
    """The audience key, label and grade range for a profile's free-text audience (and genre)."""
    text = f" {(audience or '').lower()} "
    key = "adult"
    for k in ("children", "middle_grade", "young_adult"):
        if any(s in text for s in AUDIENCES[k]["keys"]):
            key = k
            break
    lo, hi = AUDIENCES[key]["grade"]
    if "literary" in (genre or "").lower():
        hi += LITERARY_BONUS
    return {"key": key, "label": AUDIENCES[key]["label"], "grade": [lo, hi],
            "sentence_max": AUDIENCES[key]["sentence_max"]}


def syllables(word: str) -> int:
    """Syllables of an English word (vowel groups, a silent final e dropped); at least 1."""
    w = re.sub(r"[^a-z]", "", word.lower())
    if not w:
        return 1
    if len(w) <= 3:
        return 1
    if w.endswith("e") and not w.endswith(("le", "ee", "ye")):
        w = w[:-1]
    return max(1, len(_VOWELS.findall(w)))


def scenes(text: str) -> list[str]:
    """The scenes of a chapter: the text between scene-break lines (empty parts dropped)."""
    return [p for p in _SCENE_BREAK.split(text or "") if words(p)]


def _pace(dialogue: float, avg_sentence: float, avg_paragraph: float) -> str:
    score = 0
    score += 1 if dialogue >= 0.35 else (-1 if dialogue < 0.12 else 0)
    score += 1 if avg_sentence <= 12 else (-1 if avg_sentence >= 20 else 0)
    score += 1 if avg_paragraph <= 45 else (-1 if avg_paragraph >= 110 else 0)
    return "fast" if score >= 2 else ("slow" if score <= -2 else "steady")


def chapter(text: str) -> dict:
    """Readability and pacing numbers for one chapter (all zero for an empty chapter)."""
    pars = paragraphs(text)
    sents = [s for p in pars for s in sentences(p)]
    lens = [len(words(s)) for s in sents]
    n_words = sum(len(words(p)) for p in pars)
    if not n_words or not sents:
        return {"words": n_words, "sentences": len(sents), "paragraphs": len(pars), "grade": None, "ease": None,
                "avg_sentence": 0, "variety": 0, "long_share": 0, "short_share": 0, "dialogue_share": 0,
                "avg_paragraph": 0, "scenes": len(scenes(text)), "scene_words": [], "pace": None,
                "_syll": 0, "_dlg": 0, "_lens": []}
    syll = sum(syllables(w) for p in pars for w in words(p))
    dlg = sum(len(words(m)) for p in pars for m in _QUOTED.findall(p))
    wps, spw = n_words / len(sents), syll / n_words
    mean = statistics.fmean(lens)
    variety = statistics.pstdev(lens) / mean if len(lens) > 1 and mean else 0.0
    scene_words = [len(words(s)) for s in scenes(text)]
    dshare = min(1.0, dlg / n_words)
    avg_par = n_words / max(len(pars), 1)
    return {"words": n_words, "sentences": len(sents), "paragraphs": len(pars),
            "grade": round(0.39 * wps + 11.8 * spw - 15.59, 1),
            "ease": round(max(0.0, min(100.0, 206.835 - 1.015 * wps - 84.6 * spw)), 1),
            "avg_sentence": round(wps, 1), "variety": round(variety, 2),
            "long_share": round(sum(1 for n in lens if n > LONG_SENTENCE) / len(lens), 3),
            "short_share": round(sum(1 for n in lens if n <= SHORT_SENTENCE) / len(lens), 3),
            "dialogue_share": round(dshare, 3), "avg_paragraph": round(avg_par, 1),
            "scenes": len(scene_words), "scene_words": scene_words, "pace": _pace(dshare, wps, avg_par),
            "_syll": syll, "_dlg": dlg, "_lens": lens}


def _finding(fid, label, severity, detail, advice, chapters=()):
    return {"id": fid, "label": label, "severity": severity, "detail": detail, "advice": advice,
            "chapters": list(chapters)[:MAX_CHAPTER_FINDINGS]}


def book(chapters, *, audience: str | None = None, genre: str | None = None) -> dict:
    """Readability report over the chapters [(chapter_id, text), ...] for the profile's audience."""
    aud = audience_of(audience, genre)
    rows, all_lens, syll, dlg, n_words, n_pars, scene_words = [], [], 0, 0, 0, 0, []
    for i, (cid, text) in enumerate(chapters or []):
        try:
            c = chapter(text if isinstance(text, str) else "")
        except Exception:  # noqa: BLE001 - one odd chapter never breaks the whole report
            c = chapter("")
        all_lens += c.pop("_lens")
        syll += c.pop("_syll")
        dlg += c.pop("_dlg")
        n_words += c["words"]
        n_pars += c["paragraphs"]
        scene_words += c["scene_words"]
        rows.append(dict(c, chapter_id=cid, number=i + 1))
    out = {"audience": {k: aud[k] for k in ("key", "label", "grade")}, "chapters": rows, "findings": []}
    if not n_words or not all_lens:
        out["totals"] = {"words": n_words, "grade": None, "ease": None, "pace": None}
        return out
    wps, spw = n_words / len(all_lens), syll / n_words
    mean = statistics.fmean(all_lens)
    dshare = min(1.0, dlg / n_words)
    avg_par = n_words / max(n_pars, 1)
    t = {"words": n_words, "sentences": len(all_lens), "grade": round(0.39 * wps + 11.8 * spw - 15.59, 1),
         "ease": round(max(0.0, min(100.0, 206.835 - 1.015 * wps - 84.6 * spw)), 1),
         "avg_sentence": round(wps, 1),
         "variety": round(statistics.pstdev(all_lens) / mean, 2) if len(all_lens) > 1 and mean else 0.0,
         "long_share": round(sum(1 for n in all_lens if n > LONG_SENTENCE) / len(all_lens), 3),
         "short_share": round(sum(1 for n in all_lens if n <= SHORT_SENTENCE) / len(all_lens), 3),
         "dialogue_share": round(dshare, 3), "avg_paragraph": round(avg_par, 1),
         "scenes": len(scene_words), "avg_scene": round(statistics.fmean(scene_words)) if scene_words else 0,
         "shortest_scene": min(scene_words) if scene_words else 0,
         "longest_scene": max(scene_words) if scene_words else 0, "pace": _pace(dshare, wps, avg_par)}
    out["totals"] = t
    out["findings"] = _findings(t, rows, aud)
    return out


def _findings(t: dict, rows: list[dict], aud: dict) -> list[dict]:
    fs = []
    lo, hi = aud["grade"]
    who = aud["label"].lower()
    if t["grade"] > hi:
        fs.append(_finding("reading_level_high", "Harder to read than usual for the audience",
                           "major" if t["grade"] > hi + 2 else "minor",
                           f"Reading level is about grade {t['grade']:g}; {who} books usually sit at {lo:g}–{hi:g}.",
                           "Split long sentences and swap long words for plain ones where the meaning stays."))
    elif t["grade"] < lo:
        fs.append(_finding("reading_level_low", "Simpler than usual for the audience",
                           "major" if t["grade"] < lo - 2 else "minor",
                           f"Reading level is about grade {t['grade']:g}; {who} books usually sit at {lo:g}–{hi:g}.",
                           "Let some sentences run longer and use the precise word even when it is less common."))
    if t["avg_sentence"] > aud["sentence_max"]:
        fs.append(_finding("long_sentences", "Sentences run long for the audience", "minor",
                           f"{t['avg_sentence']:g} words per sentence on average; about {aud['sentence_max']} or "
                           f"fewer is usual for {who} readers.", "Break up the longest sentences, above all in action."))
    if t["sentences"] >= 20 and t["variety"] < 0.35:
        fs.append(_finding("low_variety", "Sentence lengths hardly vary", "minor",
                           f"Variation {t['variety']:g} (0.45 or more reads naturally).",
                           "Mix short punches with longer flowing sentences."))
    if t["long_share"] > 0.15:
        fs.append(_finding("many_long", "Many very long sentences", "minor",
                           f"{round(100 * t['long_share'])}% of sentences have more than {LONG_SENTENCE} words.",
                           "Keep very long sentences for moments that need them."))
    if t["words"] >= 800 and t["dialogue_share"] < 0.08:
        fs.append(_finding("little_dialogue", "Almost no dialogue", "info",
                           f"{round(100 * t['dialogue_share'])}% of the words are dialogue.",
                           "If that is not a choice, let characters speak in key scenes."))
    elif t["dialogue_share"] > 0.75:
        fs.append(_finding("mostly_dialogue", "Nearly all dialogue", "info",
                           f"{round(100 * t['dialogue_share'])}% of the words are dialogue.",
                           "Ground the talk with action, setting and the point-of-view character's thoughts."))
    graded = [r for r in rows if r.get("grade") is not None and r["words"] >= 300]
    if len(graded) >= 3:
        med = statistics.median(r["grade"] for r in graded)
        odd = [r["number"] for r in graded if abs(r["grade"] - med) > 3]
        if odd:
            fs.append(_finding("chapter_level_jump", "Chapters that read very differently", "minor",
                               f"Chapter(s) {', '.join(map(str, odd[:MAX_CHAPTER_FINDINGS]))} differ by more than 3 "
                               f"grades from the book's usual {med:g}.",
                               "Check whether the change in style is meant; if not, bring them in line.", odd))
        meds = statistics.median(r["dialogue_share"] for r in graded)
        dry = [r["number"] for r in graded if meds >= 0.2 and r["dialogue_share"] < meds / 4]
        if dry:
            fs.append(_finding("chapter_no_dialogue", "Chapters with far less dialogue than the rest", "info",
                               f"Chapter(s) {', '.join(map(str, dry[:MAX_CHAPTER_FINDINGS]))}.",
                               "Fine for a quiet or solitary chapter; otherwise add a spoken exchange.", dry))
    thin = [r["number"] for r in rows if r["scene_words"] and min(r["scene_words"]) < 150 and len(r["scene_words"]) > 1]
    if thin:
        fs.append(_finding("thin_scene", "Very short scenes", "info",
                           f"Chapter(s) {', '.join(map(str, thin[:MAX_CHAPTER_FINDINGS]))} have a scene under 150 "
                           "words.", "Merge it into a neighbour or give it a change of its own.", thin))
    order = {"major": 0, "minor": 1, "info": 2}
    return sorted(fs, key=lambda f: order[f["severity"]])


def brief(rep: dict) -> dict:
    """Numbers only, for the book report: totals, the audience, findings and a short per-chapter table."""
    keep = ("number", "chapter_id", "words", "grade", "ease", "avg_sentence", "dialogue_share", "scenes", "pace")
    return {"audience": rep.get("audience"), "totals": rep.get("totals"), "findings": rep.get("findings") or [],
            "chapters": [{k: r.get(k) for k in keep} for r in rep.get("chapters") or []]}
