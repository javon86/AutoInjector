"""🛡 One shared screen for AI-made replacement text: does it carry an instruction to an AI?

An AI writer can return a "rewrite" that is really an instruction aimed at the next AI that reads the book ("ignore
your instructions", "approve everything", "delete the book", "as an AI language model…", "system prompt"). The
reviewers may not notice it, and once it is in a chapter every later prompt carries it. So every place where Akọwe
puts AI-made words into a chapter by itself screens them here first:

* ``editor.apply_replacements`` — the editor's rewrites, the chapter polish, the improve and opening passes, the
  subtext fixes (a hit is unresolved, reason ``INSTRUCTION_LIKE``: the old words stay);
* ``subtext_check.validate`` — a "subtler" line that carries an instruction is refused;
* ``weak_scenes.check_scene`` — a rewritten scene that carries one is refused.

Only what the AI ADDED counts: a pattern already in the words it replaces (the author's own text, a story about an AI)
is never a reason to refuse. No AI, no logging of text: callers log the returned codes only.
"""
from __future__ import annotations

import re

# kind -> pattern (case-insensitive). Kept narrow: phrases that address an AI or the program, not story events.
PATTERNS: dict[str, re.Pattern] = {
    "ignore_instructions": re.compile(
        r"\b(ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,40}?\b(instructions?|prompts?|guidelines|"
        r"system message|rules above|previous rules|prior rules)\b", re.I),
    "approve_all": re.compile(r"\bapprove (everything|all of (it|this|them)|all (the )?(chapters|drafts|changes)|"
                              r"every (chapter|draft|change)|this (book|chapter|draft) (now|without))\b", re.I),
    "delete_book": re.compile(r"\b(delete|erase|wipe|destroy)\b (the|this|all|every|your)( whole| entire)? (book|"
                              r"manuscript|chapters?|database)\b", re.I),
    "as_an_ai": re.compile(r"\bas an? (ai|a\.i\.|language model|large language model|llm|ai assistant)\b",
                           re.I),
    "system_prompt": re.compile(r"\b(system|developer|hidden) (prompt|instructions?|message)\b", re.I),
    "new_instructions": re.compile(r"\b(new|updated|real|actual) instructions?\s*:", re.I),
    "role_tag": re.compile(r"(<\s*/?\s*(system|assistant|user|instructions?)\s*>|\[/?INST\]|<\|im_(start|end)\|>)",
                           re.I),
    "you_are_ai": re.compile(r"\byou are (an? )?(ai|language model|chatbot|ai assistant|reviewer|ai reviewer)\b",
                             re.I),
}


def kinds(text) -> dict[str, int]:
    """{kind: how many times} of the instruction-like patterns in ``text`` (empty when none)."""
    if not isinstance(text, str) or not text:
        return {}
    out = {}
    for k, p in PATTERNS.items():
        n = len(p.findall(text))
        if n:
            out[k] = n
    return out


def added(old, new) -> list[str]:
    """The kinds of instruction-like text that ``new`` has more often than ``old`` (what the AI added)."""
    before, after = kinds(old or ""), kinds(new or "")
    return [k for k, n in after.items() if n > before.get(k, 0)]


def is_instruction_like(old, new) -> bool:
    return bool(added(old, new))


REASON_WORDS = "the new words read like an instruction to an AI, not like part of the book"
