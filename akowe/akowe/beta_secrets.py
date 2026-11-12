"""🔮 What a beta reader may "guess too early": only the book's real secrets, never its premise (no AI).

In "The Salt Tuner" all three beta readers "guessed a twist too early in chapter 1 — 'Teo was under the notes'", but
Teo's voice in the piano IS the premise: the blurb says it before page 1. So:

* the reader's brief gets the book's premise (``premise``: the B01 premise, dramatic question and concept summary,
  else the profile's idea and blurb) with one rule (``RULE``): what the premise / blurb establishes is known from the
  start and is never a guess or a twist. The readers still never see the outline, the story rules or the reveal plan
  (a beta reader must not know the twists in advance), so the book's secrets stay with Akọwe;
* every guess (and every "guessed" reaction) is matched without AI (``kind_of``) against the book's protected secrets
  (``secrets``: the story rules' protected mysteries, twist_guard.secrets, and the reveal plan's reveals, B08) and the
  premise, by the content words they share. A guess that clearly restates the premise (at least ``PREMISE_SHARE`` of its
  content words are the premise's) and matches no secret better is marked
  ``premise`` and never counts as "a twist guessed too early" (beta_reader._early) — not in a reader's findings, the
  panel's agreement and top fixes, nor the improve pass / weakest-scenes ranking (``refilter`` re-checks a stored read
  there). A guess that matches neither still counts (Akọwe cannot tell, so it keeps the reader's word).

Setting ``beta_premise_guard`` ({"enabled": bool}, default on) switches it off. Pure reads; never raises.
Logs: counts only.
"""
from __future__ import annotations

import logging
import re

log = logging.getLogger("akowe.beta_secrets")

SETTING = "beta_premise_guard"
PREMISE_CHARS = 900
MAX_SECRETS = 12
MIN_SHARED = 2          # content words a guess must share with the premise to count as the premise …
PREMISE_SHARE = 0.7     # … and that share of its own content words (only a clear restatement of the premise)
RULE = ("context.premise is what the book's blurb tells every reader before page 1: it is known from the start. "
        "Never report it, or anything it establishes, as a guess or a twist guessed too early — only what the book "
        "is still hiding from you.")
_STOP = set("""the a an and or but of to in on at by for with from that this these those was were is are be been
being it its as he she they them his her hers their theirs him who whom whose what when where which why how into out
up down over under not no yes there here than then so if just had has have having do did does doing about after
before again all any some one two very can could would should will shall may might must also only own same such too
each other more most much many our ours your yours my mine me we you i still even ever never always really""".split())


def settings(store) -> dict:
    try:
        cur = store.get_setting(SETTING) if store is not None else None
    except Exception:  # noqa: BLE001
        cur = None
    on = cur.get("enabled") if isinstance(cur, dict) else None
    return {"enabled": True if on is None else bool(on)}


def _texts(v) -> list[str]:
    """Every string inside a record's data (dicts / lists walked)."""
    if isinstance(v, str):
        return [v]
    if isinstance(v, dict):
        return [t for x in v.values() for t in _texts(x)]
    if isinstance(v, list):
        return [t for x in v for t in _texts(x)]
    return []


def _latest(bp, op: str) -> dict | None:
    appr = bp.approved(op)
    if appr:
        return appr[0]
    drafts = sorted(bp.drafts(op), key=lambda r: r.get("created_at") or "", reverse=True)
    return drafts[0] if drafts else None


def premise(engine, store, principal, pid: str, branch: str) -> str:
    """The premise every reader knows from the start ("" when unknown)."""
    parts: list[str] = []
    try:
        from .book_path import BookPath  # noqa: PLC0415
        rec = _latest(BookPath(engine, principal, pid, branch), "B01")
        data = (rec or {}).get("data") or {}
        for k in ("premise", "dramatic_question", "concept_summary"):
            parts += _texts(data.get(k))
    except Exception:  # noqa: BLE001
        log.debug("could not read the premise", exc_info=True)
    try:
        from .book_path import get_profile  # noqa: PLC0415
        prof = get_profile(store, pid) or {}
        for k in ("idea", "blurb", "logline"):
            if isinstance(prof.get(k), str):
                parts.append(prof[k])
    except Exception:  # noqa: BLE001
        log.debug("could not read the profile", exc_info=True)
    return " ".join(" ".join(p.split()) for p in parts if p and p.strip())[:PREMISE_CHARS].strip()


def secrets(engine, store, principal, pid: str, branch: str) -> list[str]:
    """The book's protected secrets: the story rules' mysteries (twist_guard.secrets) and the reveal plan (B08)."""
    out: list[str] = []
    try:
        from . import twist_guard  # noqa: PLC0415
        out += twist_guard.secrets(store, pid, branch)
    except Exception:  # noqa: BLE001
        log.debug("could not read the protected mysteries", exc_info=True)
    try:
        from .book_path import BookPath  # noqa: PLC0415
        rec = _latest(BookPath(engine, principal, pid, branch), "B08")
        for item in ((rec or {}).get("data") or {}).get("reveals") or []:
            t = " ".join(_texts(item.get("summary") if isinstance(item, dict) and item.get("summary") else item))
            if t.strip():
                out.append(" ".join(t.split())[:300])
    except Exception:  # noqa: BLE001
        log.debug("could not read the reveal plan", exc_info=True)
    return list(dict.fromkeys(s for s in out if s))[:MAX_SECRETS]


def known(engine, store, principal, pid: str, branch: str) -> dict | None:
    """{premise, secrets} for one book; None when switched off. Never raises."""
    try:
        if not settings(store)["enabled"]:
            return None
        return {"premise": premise(engine, store, principal, pid, branch),
                "secrets": secrets(engine, store, principal, pid, branch)}
    except Exception:  # noqa: BLE001
        log.debug("could not read what the book keeps secret", exc_info=True)
        return None


def words(text) -> set[str]:
    """Content words (3+ letters, no common words; "Teo's" -> "teo", "notes" -> "note")."""
    out = set()
    for w in re.findall(r"[a-z0-9]+(?:['’][a-z]+)?", str(text or "").lower()):
        w = re.sub(r"['’]s$", "", w).replace("’", "'")
        if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        if len(w) >= 3 and w not in _STOP:
            out.add(w)
    return out


def kind_of(guess: str, info: dict | None) -> str:
    """"secret" (it is one of the book's secrets), "premise" (it is only what the premise says) or "unknown"."""
    if not info:
        return "unknown"
    g = words(guess)
    if not g:
        return "unknown"
    best = 0
    hit = False
    for s in info.get("secrets") or []:
        sw = words(s)
        n = len(g & sw)
        best = max(best, n)
        if sw and n >= min(MIN_SHARED, len(sw)):
            hit = True
    prem = len(g & words(info.get("premise"))) if info.get("premise") else 0
    if hit and best >= prem:
        return "secret"
    if prem >= MIN_SHARED and prem >= PREMISE_SHARE * len(g):
        return "premise"
    return "unknown"


def mark(read: dict, info: dict | None) -> int:
    """Mark the read's guesses and "guessed" reactions that only restate the premise (``premise: True``; they never
    count as a twist guessed too early). Returns how many were marked."""
    if not info or not isinstance(read, dict):
        return 0
    n = 0
    for g in read.get("guesses") or []:
        k = kind_of(g.get("guess"), info)
        g["premise"] = k == "premise"
        if k == "secret":
            g["secret"] = True
        n += g["premise"]
    for r in read.get("reactions") or []:
        if r.get("kind") == "guessed":
            r["premise"] = kind_of(f"{r.get('note') or ''}", info) == "premise"
            n += r["premise"]
    return n
