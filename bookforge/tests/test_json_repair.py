"""First real test: ChatGPT answered BookForge's editor and whole-book review with UNFENCED JSON; the chat page rendered
it as Markdown, which strips the backslash from every \\" inside text — so quoted dialogue became ""Say my name…"" and
every ChatGPT answer was refused (the editor never ran, the review failed with INTERNAL_ERROR). The parser now repairs
text-quotes as a last resort, and the prompt asks for a ```json block."""
from __future__ import annotations

import json

from bookforge.providers import AutoInjectorAdapter, extract_json_object, repair_json_quotes

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
