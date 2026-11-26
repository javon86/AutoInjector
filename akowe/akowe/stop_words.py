"""🗣 Plain words for a stop: an AI's unusable answer, an AI that refuses, a fault in Akọwe's own code, and a book
step (format / assemble / export / check) whose module refused its work.

Why (stress test R4 / R6, Nov 2026): the author was shown programmer's words ("…did not return JSON matching the
output schema… Last errors: /: 'title' is a required property"), refusals were explained as "busy or unreachable",
a bug in Akọwe itself and a full disk while the book was put together were both filed as "AI problem", and a module
refusing showed only its code ("I01 could not be created (BLOCKED).").

Everything here is text work, no AI call. Messages never carry book text the author did not see already; the
technical detail (schema pointers, exception type) stays in logs / diagnostics only.
"""
from __future__ import annotations

import re

# The adapters' message for an answer that stayed unusable after the re-asks (providers.AutoInjectorAdapter, the
# Anthropic / Ollama adapters). ``is_unusable`` finds it again in a dispatch response's errors.
UNUSABLE_MARK = "did not give a usable answer"
UNUSABLE_CODE = "AI_UNUSABLE"   # the run problem's code for it (the AkoweError stays INTERNAL_ERROR, its contract code)
OWN_MARK = "Akọwe hit an unexpected"

UNUSABLE_FIX = ("Press 🔁 Try again: Akọwe asks the AIs again. If it keeps happening, look at the AI's window in "
                "AutoInjector (a cut-off answer, or a chat that is too long — press the site's New chat), or pick "
                "another AI for the book in the run's settings.")
OWN_FIX = ("Press ▶ Resume to try this step again — nothing written so far is lost. If it happens again, use 📋 Copy "
           "diagnostics and send it in.")
DISK_FIX = "Free some space on the disk Akọwe saves to, then press 🔁 Try again. Nothing written so far is lost."

# what each book module makes, for "… could not be made"
OP_WORDS = {"I01": "The book format", "G01": "The manuscript", "G02": "The chapter list", "G04": "The table of contents",
            "G05": "The typeset book", "G06": "The front and back matter", "G07": "The assembled book",
            "G08": "The page layout", "G11": "The PDF file", "G12": "The EPUB file", "G13": "The Word file",
            "H05": "The content check", "A01": "The character", "B01": "The premise", "B03": "The main plot",
            "B11": "The chapter outline", "C02": "The chapter"}
_DISK = re.compile(r"disk is full|no space left|ENOSPC|disk quota", re.I)
_JARGON = re.compile(r"is a required property|is not of type|is not one of|[Aa]dditional properties|\bschema\b|"
                     r"^/|Traceback|File \"", re.M)
_STORAGE = re.compile(r"storage unavailable|read-only file system|database is locked|unable to open database", re.I)


def unusable_message(name: str, tries: int) -> str:
    """The adapter's message for an answer still unusable after ``tries`` tries (no schema words)."""
    return (f"{name} {UNUSABLE_MARK} (its answer was not in the form Akọwe asked for) after {tries} "
            f"{'try' if tries == 1 else 'tries'}; nothing was saved")


def is_unusable(code, message) -> bool:
    return str(code or "") == "INTERNAL_ERROR" and UNUSABLE_MARK in str(message or "")


def exc_unusable(exc) -> bool:
    """An AkoweError for an AI answer that could not be used (not a refusal, not a busy or missing AI)."""
    if getattr(exc, "unusable", False):
        return True
    errs = getattr(exc, "errors", None) or [{}]
    return is_unusable(getattr(exc, "code", None), errs[0].get("message"))


def unusable_problem(message: str, what: str) -> tuple[str, str, str]:
    """(code, message, fix) for a stop on unusable answers while ``what`` ("writing the premise")."""
    msg = str(message or "").strip().rstrip(".")
    what = re.sub(r"\bchapter ch(\d+)\b", r"chapter \1", str(what or "this step"))  # "chapter 1", not its id
    return (UNUSABLE_CODE, f"The AI's answers could not be used while {what}: {msg}." if msg else
            f"The AI's answers could not be used while {what}.", UNUSABLE_FIX)


def declined_message(what: str = "") -> str:
    return ("The AIs declined to write this" + (f" ({what})" if what else "") +
            ": they said they can't help with that, several times.")


def own_error_problem(step_title: str, exc: BaseException | None = None) -> dict:
    """A crash in Akọwe's own code inside a step: a plain safe stop (the exception type for diagnostics only)."""
    where = f" in “{step_title}”" if step_title else ""
    out = {"code": "INTERNAL_ERROR", "source": "akowe",
           "message": f"{OWN_MARK} error{where} — press ▶ Resume to try again.", "fix": OWN_FIX}
    if exc is not None:
        out["error_type"] = type(exc).__name__
    return out


def is_own_error(prob: dict) -> bool:
    """Akọwe's own code failed (never the AI, never the book): new problems say so, older ones by their words."""
    return prob.get("source") == "akowe" or (str(prob.get("code") or "") == "INTERNAL_ERROR"
                                              and str(prob.get("message") or "").startswith(OWN_MARK))


def _reason(resp: dict) -> str:
    """The first error / blocking finding of a module's response, in its own words (no code, no path)."""
    for e in resp.get("errors") or []:
        m = str(e.get("message") or "").strip()
        if m:
            return m
    for f in resp.get("findings") or []:
        if f.get("severity") == "BLOCKING" and f.get("decision") != "PASS" and str(f.get("message") or "").strip():
            return str(f["message"]).strip()
    return ""


def module_failed(op: str, resp: dict) -> str:
    """Plain words for a book module that refused or failed ("The book format could not be made: …")."""
    thing = OP_WORDS.get(str(op), "This part of the book")
    why = _reason(resp)
    if _DISK.search(why):
        return f"{thing} could not be saved: the disk is full."
    if _STORAGE.search(why):
        return f"{thing} could not be saved: Akọwe could not write to its data folder."
    why = re.sub(r"^storage unavailable:\s*", "", why).strip().rstrip(".")
    if why and _JARGON.search(why):
        return f"{thing} could not be made: Akọwe's checks refused it (the details are below)."
    if why:
        return f"{thing} could not be made: {why[:240]}."
    status = str(resp.get("status") or "").lower()
    return f"{thing} could not be made" + (f" (it was {status})." if status else ".")


def fix_for(message: str) -> str | None:
    """A better fix than the generic one for a known cause (a full disk), else None."""
    return DISK_FIX if "the disk is full" in str(message or "") else None
