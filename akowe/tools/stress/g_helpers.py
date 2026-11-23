"""Helpers for Section G (Quality at the end) of the stress harness — kept out of core.py on purpose.

* ``Kept``: a "the end rewrites are kept" scaffold for the Practice AI. By default the Practice AI's opening rewrite
  changes nothing and its weakest-scene rewrites are refused (NO_CHANGE), so the opening / improve / reread parts never
  reach their re-read, approval, re-export and second-read code. ``Kept`` scripts small, valid rewrites (each with its
  own marker word) and whole-book reviews that score a book one point higher per marker it contains, so a rewrite is
  KEPT and the whole path runs. It is installed by wrapping ``ChaosAI.__init__`` for the duration of a stress, so the
  nested harnesses of the generic a–i stresses get it too. It is never a fault: ``h.fix()`` does not remove it.
* small readers of the finished book (chapter texts, the latest report, the beta reads) for the checks.
"""
from __future__ import annotations

import contextlib
import copy

from . import core

OPEN_MARK = "salt-bitten"     # the opening pass's rewrite adds this word to chapter 1
SCENE_MARK = "unhurried"      # a weakest-scene rewrite adds this word
MARKS = (OPEN_MARK, SCENE_MARK)


class Forever(list):
    """A script list that never runs out (the Practice AI pops scripted answers from a list)."""

    def __init__(self, fn):
        super().__init__([fn])
        self.fn = fn

    def pop(self, *_):  # noqa: D401
        return self.fn

    def __bool__(self):
        return True


def opening_rewrite(ctx: dict) -> dict:
    """Rework the opening stretch: one sentence with the marker added after its first paragraph (every original word
    kept, so the editor's keep list never refuses it)."""
    fs = ctx.get("findings") or []
    f = next((x for x in fs if x.get("dimension") == "opening" and x.get("passage")), None)
    if not f:
        return {"replacements": []}
    p = f["passage"]
    add = f"The {OPEN_MARK} wind had found the stairwell."
    new = p.replace("\n\n", f"\n\n{add} ", 1) if "\n\n" in p else p + " " + add
    return {"replacements": [{"finding_id": f["id"], "original": p, "replacement": new}]}


def weak_scene(ctx: dict) -> dict:
    t = str((ctx.get("scene") or {}).get("text") or "")
    if not t.strip():
        return {"rewritten_scene": ""}
    body = t.rstrip()
    end = body[-1] if body[-1:] in ".!?" else ""
    return {"rewritten_scene": (body[:-1] if end else body) + f", {SCENE_MARK}{end or '.'}",
            "what_changed": ["a calmer rhythm"]}


def chapter_rewrite(ctx: dict) -> dict:
    """The improve pass's whole-chapter mode (editor rewrite): one replacement adding a marker sentence."""
    text = str(ctx.get("chapter_text") or "")
    for f in ctx.get("findings") or []:
        p = f.get("passage") or ""
        if p and text.count(p) == 1:
            return {"replacements": [{"finding_id": f["id"], "original": p,
                                      "replacement": p + f" The {SCENE_MARK} tide turned."}]}
    fs = ctx.get("findings") or []
    paras = [x for x in text.split("\n\n") if x.strip() and text.count(x) == 1 and len(x) <= 500]
    if fs and paras:
        return {"replacements": [{"finding_id": fs[0]["id"], "original": paras[-1],
                                  "replacement": paras[-1] + f" The {SCENE_MARK} tide turned."}]}
    return {"replacements": []}


def book_text(ctx: dict) -> str:
    chs = (ctx.get("book") or {}).get("chapters") or []
    return " ".join(str(c.get("text") or c.get("opening") or "") + " " + str(c.get("middle") or "") + " " +
                    str(c.get("ending") or "") for c in chs)


def make_review(ai, delta_fn=None):
    """A whole-book review that is one point higher per marker in the book (or ``delta_fn(ctx, base)``)."""
    base_fn = type(ai)._book_review

    def review(ctx, props=None):
        props = props or {"book_scores": {"properties": {d: {} for d in __import__(
            "akowe.book_report", fromlist=["DIM_KEYS"]).DIM_KEYS}}}
        out = base_fn(ai, ctx, props)
        txt = book_text(ctx)
        d = delta_fn(ctx, out) if delta_fn else sum(1 for m in MARKS if m in txt)
        # one point up per marker, never past 8 (a near-perfect review would be capped by the trust check) and the
        # 9s stay 9s: the overall still goes up with every kept rewrite
        out["book_scores"] = {k: (v if v >= 9 else int(max(1, min(8, v + d)))) for k, v in out["book_scores"].items()}
        dims = list(out["book_scores"])
        q = out["strengths"][0]["quote"] if out.get("strengths") else ""
        out["score_evidence"] = [{"dimension": k, "quote": q, "why": "shown"} for k in dims
                                 if out["book_scores"][k] >= 9 and q]
        return out
    return review


def install(ai, delta_fn=None, opening=True, scenes=True):
    """Give one ChaosAI the kept-rewrite scaffold now (no class patch)."""
    if opening:
        ai.opening_rewrite_script = Forever(opening_rewrite)
    if scenes:
        ai.weak_scene_script = Forever(weak_scene)
    ai.book_review_script = Forever(make_review(ai, delta_fn))


@contextlib.contextmanager
def kept(delta_fn=None, opening=True, scenes=True, ai=None):
    """While active, every new ChaosAI (also those of nested harnesses) gets the kept-rewrite scaffold; ``ai`` (the
    running harness's ChaosAI, made before the stress function runs) gets it at once."""
    orig = core.ChaosAI.__init__

    def install(self):
        if opening:
            self.opening_rewrite_script = Forever(opening_rewrite)
        if scenes:
            self.weak_scene_script = Forever(weak_scene)
        self.book_review_script = Forever(make_review(self, delta_fn))

    def init(self, *a, **kw):
        orig(self, *a, **kw)
        install(self)
    if ai is not None:
        install(ai)
    core.ChaosAI.__init__ = init
    try:
        yield
    finally:
        core.ChaosAI.__init__ = orig


def with_kept(fn, **kw):
    """Wrap a stress function so it runs with the scaffold."""
    def wrapped(h):
        with kept(ai=h.chaos, **kw):
            return fn(h)
    wrapped.__name__ = getattr(fn, "__name__", "kept")
    return wrapped


# ---------------------------------------------------------------------------------------------- readers
def chapters(h) -> list[dict]:
    from akowe.book_report import book_chapters  # noqa: PLC0415
    run = h.raw() or {}
    if not run.get("project_id"):
        return []
    return book_chapters(h.app.autobook.bp(run))


def report(h) -> dict:
    run = h.raw() or {}
    rp = getattr(h.app, "reports", None)
    return (rp.latest(run["project_id"], run["branch_id"]) if rp and run.get("project_id") else None) or {}


def beta_reads(h) -> list[dict]:
    from akowe import beta_reader  # noqa: PLC0415
    run = h.raw() or {}
    if not run.get("project_id"):
        return []
    return beta_reader.service_of(h.app).reads(run["project_id"], run["branch_id"]) or []


def step(h, sid: str) -> dict:
    return next((s for s in h.run().get("steps") or [] if s["id"] == sid), {})


def codes(h) -> list[str]:
    return [e.get("code") for e in (h.raw() or {}).get("events") or [] if e.get("code")]


def mem(h, key: str) -> dict:
    return copy.deepcopy((h.raw() or {}).get(key) or {})
