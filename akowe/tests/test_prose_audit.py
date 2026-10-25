"""P6 pattern checker (prose_audit.py): counts, passage locations, thresholds, strictness — no AI.

The fixture paraphrases the habits ChatGPT's review found in "The Lamplighter's Last Round": stillness gestures,
"Not to X. Not to Y.", aphoristic paragraph endings, feelings named in dialogue, reassurance that removes the risk."""
from __future__ import annotations

import time

from akowe import prose_audit as pa

LAMPLIGHTER = """# The Last Round

Edda went very still. The lamp hissed above her, and for a long time she did not answer.

"I'm afraid," Tobin whispered. "Half of me wants to stay, and half of me wants to run."

She looked at him. She looked at the lamp. She looked at the dark street beyond the glass. Not to the square. Not to the river. Not to anywhere he could follow.

"It won't hurt anyone at all," she murmured. "Don't worry."

He went very still. Light was a promise. That was the truth of it.

The wind, the rain, and the dark pressed against the glass. Edda breathed out. For a long time nobody spoke. That was what the lamps were for.

Tobin looked at the floor. He did not answer. He went very still again, and the silence stretched.
"""

CLEAN = """# Market Day

The fish cart lost a wheel at the bottom of Rope Street, and Harl swore at it in two languages.

"Hold the tarp," he said. Mira held it while he knocked the pin back with the heel of his boot. Gulls circled, patient as debt collectors, and a boy from the tannery tried to lift a mackerel and got a slap for his trouble.

By noon the price of cod had doubled. Nobody could say why. Harl blamed the harbour master, the harbour master blamed the weather, and the weather said nothing at all.

Mira counted the coins twice. She was short three pennies, and she knew exactly which customer had done it.
"""


def by_id(rep):
    return {f["id"]: f for f in rep["findings"]}


def test_lamplighter_patterns_are_counted_with_locations():
    rep = pa.audit(LAMPLIGHTER, chapter="ch1")
    f = by_id(rep)
    g = f["gesture:went very still"]
    assert g["count"] == 3 and g["severity"] == "major"
    # paragraph numbers count from 1 (the "# Title" line is not a paragraph); excerpts are short
    assert [p["paragraph"] for p in g["passages"]] == [1, 5, 7]
    assert all(p["chapter"] == "ch1" and len(p["excerpt"]) <= pa.EXCERPT_MAX for p in g["passages"])
    assert "went very still" in g["passages"][1]["excerpt"]
    # the shorter "very still" is not counted again inside "went very still"
    assert "gesture:very still" not in f
    assert f["gesture:looked at"]["count"] == 4
    assert f["not_parallel"]["count"] == 3 and f["not_parallel"]["passages"][0]["paragraph"] == 3
    assert f["moral_ending"]["count"] == 2
    assert {p["paragraph"] for p in f["moral_ending"]["passages"]} == {5, 6}
    assert f["named_emotion"]["count"] == 2
    assert f["reassurance"]["count"] == 1 or f["reassurance"]["count"] == 2
    assert "won't hurt" in f["reassurance"]["passages"][0]["excerpt"]
    assert f["same_opening"]["count"] >= 1 and f["same_opening"]["passages"][0]["paragraph"] == 3
    assert rep["summary"]["major"] >= 5 and rep["words"] > 100 and rep["paragraphs"] == 7
    assert rep["stats"]["gestures"]["went very still"] == 3


def test_clean_prose_has_no_major_findings():
    rep = pa.audit(CLEAN)
    assert rep["summary"]["major"] == 0, [(f["id"], f["severity"]) for f in rep["findings"]]
    assert not any(f["check"] in ("named_emotion", "reassurance", "not_parallel", "moral_ending")
                   for f in rep["findings"])


def test_minimum_counts_and_thresholds_per_1000_words():
    one = "Edda went very still. " + " ".join(["The street was wet and the carts were slow."] * 30)
    assert "gesture:went very still" not in by_id(pa.audit(one))  # one use is never a tic
    two = "Edda went very still.\n\n" + " ".join(["The street was wet and the carts were slow."] * 200) + \
        "\n\nTobin went very still."
    f = by_id(pa.audit(two))["gesture:went very still"]
    assert f["count"] == 2 and f["per_1000"] < 1.5 and f["severity"] == "info"  # rare in a long text: info only
    short = "Edda went very still.\n\nTobin went very still."
    assert by_id(pa.audit(short))["gesture:went very still"]["severity"] == "major"


def test_strictness_scales_the_thresholds():
    # 3 uses in ~1 400 words: about 2.1 per 1 000 words
    filler = " ".join(["The carts rolled past the chandler's shop and the rain kept on."] * 40)
    text = "\n\n".join([f"Edda went very still. {filler}", f"Tobin went very still. {filler}",
                        f"Nessa went very still. {filler}"])
    sev = {s: by_id(pa.audit(text, settings={"strictness": s}))["gesture:went very still"]["severity"]
           for s in ("gentle", "normal", "strict")}
    assert sev["gentle"] == "minor" or sev["gentle"] == "info"
    assert sev["normal"] == "minor"
    assert sev["strict"] == "minor" or sev["strict"] == "major"
    assert pa._thresholds("strict", None)["gesture"]["minor"] < pa._thresholds("gentle", None)["gesture"]["minor"]
    assert pa.audit(text, settings={"strictness": "nonsense"})["strictness"] == "normal"


def test_configurable_gesture_list_and_overrides():
    text = "She tapped the glass.\n\nHe tapped the glass.\n\nThey tapped the glass."
    assert "gesture:tapped the glass" not in by_id(pa.audit(text))
    rep = pa.audit(text, settings={"gestures": ["tapped the glass"]})
    assert by_id(rep)["gesture:tapped the glass"]["count"] == 3
    rep = pa.audit(LAMPLIGHTER, settings={"thresholds": {"gesture": {"min": 5}}})
    assert "gesture:went very still" not in by_id(rep)


def test_said_bookisms_against_plain_tags():
    text = "\n\n".join([
        '"Come here," she hissed.', '"Why?" he breathed.', '"Because," she purred.', '"Fine," he growled.',
        '"Now," Mara said.'])
    f = by_id(pa.audit(text))["said_bookism"]
    assert f["count"] == 4 and f["share"] == 0.8 and f["severity"] == "major"
    plain = "\n\n".join(['"Come here," she said.', '"Why?" he asked.', '"Because," she said.', '"Fine," he said.'])
    assert "said_bookism" not in by_id(pa.audit(plain))


def test_uniform_sentence_length_and_varied_rhythm():
    same = " ".join(["The keeper climbed the stairs to the lamp."] * 20)
    f = by_id(pa.audit(same))["uniform_length"]
    assert f["severity"] == "major" and f["passages"] == []
    varied = ("Rain. The keeper climbed the long stairs with the oil can knocking against her knee at every step. "
              "She stopped. Below, the harbour lights went out one by one as the fishermen gave up on the night and "
              "went home to their wives and their debts. Wind. Then the bell.") * 3
    assert "uniform_length" not in by_id(pa.audit(varied))


def test_overused_words_ignore_character_names():
    text = " ".join(["Mara lifted the lantern and Mara swung the lantern toward the lantern hooks."] * 6)
    rep = pa.audit(text, names=["Mara Vell"])
    f = by_id(rep)
    assert f["overused_word:lantern"]["count"] == 18
    assert "overused_word:mara" not in f
    assert f["overused_word:lantern"]["passages"][0]["paragraph"] == 1


def test_dialogue_share_per_speaker():
    lines = ['"We sail at dawn," Harl said.'] * 7 + ['"Fine," Mira said.']
    rep = pa.audit("\n\n".join(lines))
    sp = rep["stats"]["dialogue"]["speakers"]
    assert sp["Harl"]["words"] == 28 and sp["Mira"]["words"] == 1
    assert by_id(rep)["dialogue_share"]["detail"].startswith("Harl has 97%")


def test_whole_book_rates_and_chapters():
    rep = pa.audit_book([("ch1", LAMPLIGHTER), ("ch2", CLEAN)])
    g = by_id(rep)["gesture:went very still"]
    assert {p["chapter"] for p in g["passages"]} == {"ch1"}
    assert [c["chapter"] for c in rep["stats"]["chapters"]] == ["ch1", "ch2"]
    assert rep["words"] == sum(c["words"] for c in rep["stats"]["chapters"])
    alone = by_id(pa.audit(LAMPLIGHTER))["gesture:went very still"]["per_1000"]
    assert g["per_1000"] < alone  # the clean chapter dilutes the rate


def test_counts_only_and_brief_hold_no_prose():
    rep = pa.audit(LAMPLIGHTER)
    co = pa.counts_only(rep)
    assert "went very still" in str(co["checks"])  # the check id names the phrase …
    assert "lamp hissed" not in str(co) and "excerpt" not in str(co)  # … but no text of the book
    br = pa.brief(rep)
    assert br["findings"] and all(len(e) <= pa.EXCERPT_MAX for f in br["findings"] for e in f["examples"])


def test_empty_and_odd_input():
    for t in ("", "# Only a title", "\n\n\n", "…", '"', "Not."):
        rep = pa.audit(t)
        assert rep["summary"]["major"] == 0 and isinstance(rep["findings"], list)


def test_fast_on_a_long_chapter():
    text = "\n\n".join([LAMPLIGHTER, CLEAN] * 20)
    t0 = time.perf_counter()
    rep = pa.audit(text)
    assert time.perf_counter() - t0 < 2.0 and rep["words"] > 4000
