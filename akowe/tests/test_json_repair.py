"""First real test: ChatGPT answered Akọwe's editor and whole-book review with UNFENCED JSON; the chat page rendered
it as Markdown, which strips the backslash from every \\" inside text — so quoted dialogue became ""Say my name…"" and
every ChatGPT answer was refused (the editor never ran, the review failed with INTERNAL_ERROR). The parser now repairs
text-quotes as a last resort, and the prompt asks for a ```json block."""
from __future__ import annotations

import json

from akowe.providers import AutoInjectorAdapter, extract_json_object, repair_json_quotes

# shapes copied from the real replies (shortened)
REVIEW = '''ChatGPT said:

{
"book_scores": {
"atmosphere": 9,
"premise": 8
},
"strengths": [
{
"point": "Tamsin's desire for recognition gives the premise an intimate emotional center.",
"quote": ""Say my name, then. Only that. Say it back and I'll go.""
},
{
"point": "Odile's confession is restrained.",
"quote": ""I watched the last four go out. I watched them, and I didn't get up.""
}
],
"weaknesses": [
{
"point": "The final resolution arrives quickly.",
"quote": ""Tamsin Reed," Odile said."
}
],
"try_next": ["Keep Corvin upriver."],
"summary": "A quiet book."
}'''
EDITOR = '''ChatGPT said:

{
"scores": {"subtext": 8, "prose_variety": 6},
"findings": [
{"passage": ""The salt-boat's in." Pell Harrow dragged the skiff alongside, panting.", "why": "x"}
],
"keep": [
""Their mate was at Garner's Wharf four days back.",
""I've had no letter.""
],
"verdict": "REVISE"
}'''


def test_real_chatgpt_shapes_parse():
    r = extract_json_object(REVIEW)
    assert r["book_scores"] == {"atmosphere": 9, "premise": 8}
    assert r["strengths"][0]["quote"] == '"Say my name, then. Only that. Say it back and I\'ll go."'
    assert r["weaknesses"][0]["quote"] == '"Tamsin Reed," Odile said.'
    e = extract_json_object(EDITOR)
    assert e["verdict"] == "REVISE" and e["scores"]["prose_variety"] == 6
    assert e["findings"][0]["passage"].startswith('"The salt-boat\'s in." Pell')
    assert e["keep"] == ['"Their mate was at Garner\'s Wharf four days back.', '"I\'ve had no letter."']


def test_valid_json_is_never_changed():
    for obj in ({"a": 'he said "hi", then left', "b": [1, -2, True, None], "c": {"d": "x:y", "e": "line\nbreak"}},
                {"quote": '"Push," she said.'}, {}):
        txt = json.dumps(obj)
        assert repair_json_quotes(txt) == txt
        assert extract_json_object(txt) == obj
        assert extract_json_object("```json\n" + json.dumps(obj, indent=2) + "\n```") == obj


def test_hopeless_text_still_returns_none():
    assert extract_json_object("no json here") is None
    assert extract_json_object('{"a": "unterminated') is None


def test_prompt_asks_for_a_json_code_block():
    p = AutoInjectorAdapter.build_prompt("sys", "user", {"type": "object"})
    assert "```json code block" in p


# ---------------------------------------------------------------------- first real PC test (problem 1): Claude's site
# renders a short unfenced answer as prose and turns its JSON quote marks curly. Copied in shape from the saved report.
CLAUDE_SHORT = "{“ok”: true, “site”: “claude”, “number”: 7}"
CLAUDE_REVIEW = ("Claude said:\n\n{“verdict”: “REVISE”, “reasons”: [“The line "
                 "“Can they save the line?” is told, not shown.”, “The Lamplighter’s ferry "
                 "never costs anything — add a price.”], “score”: –2, “notes”: "
                 "{“keep”: [‘Odile’s silence’]}}\n\nLet me know if you’d like more.")


def test_claude_curly_quotes_short_answer_parses():
    assert extract_json_object(CLAUDE_SHORT) == {"ok": True, "site": "claude", "number": 7}


def test_claude_curly_quotes_keep_prose_quotes_inside_values():
    r = extract_json_object(CLAUDE_REVIEW)
    assert r["verdict"] == "REVISE" and r["score"] == -2
    # curly quotes and apostrophes that are part of the text stay exactly as written
    assert r["reasons"][0] == "The line “Can they save the line?” is told, not shown."
    assert r["reasons"][1] == "The Lamplighter’s ferry never costs anything — add a price."
    assert r["notes"] == {"keep": ["Odile’s silence"]}


def test_curly_quotes_are_only_touched_when_strict_parsing_fails():
    obj = {"quote": "“Can they save the line?”", "who": "Odile’s"}
    assert extract_json_object(json.dumps(obj, ensure_ascii=False)) == obj
    assert extract_json_object("Here:\n" + json.dumps(obj, ensure_ascii=False) + "\nDone.") == obj
    assert extract_json_object("He said “hello” and left.") is None


def test_claude_curly_answer_through_the_bridge(h):
    from test_autoinjector_adapter import B01_OUT, FakeBridge, b01, connect  # noqa: PLC0415
    bridge = FakeBridge()
    try:
        connect(h, bridge.url)
        curly = json.dumps(B01_OUT, ensure_ascii=False).replace('"', "”").replace("”", "“", 1)
        bridge.script = [("ok", curly)]
        r = b01(h)
        assert r["status"] == "DRAFT", r
        assert h.record(r["output_refs"][0])["data"] == B01_OUT and len(bridge.sends) == 1
    finally:
        bridge.close()
