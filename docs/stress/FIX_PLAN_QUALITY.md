# Fix plan — the stress-test findings that affect book quality (not started)

Every finding from the stress test (`docs/stress/`) that changes **what ends up in the book, or how good it is**: 47
finding IDs (31 rows), grouped into **4 batches**. Each batch is one agent's job (small enough to do and test in one go), in its
own branch, with a regression test per ID; the batches touch different files, so they can run in parallel.
**Nothing here is implemented yet — waiting for the go-ahead.**

Conventions for every fix: best workable code with error handling; plain words for the author; logs carry codes only
(never book text); every new check is bounded, never holds up the book unless it would otherwise lose or damage
writing, and only touches AI-made text. After each batch: the IDs' stress scenarios are re-run with
`python -m tools.stress.run --section <X> --parts … --stress …` and must turn ✅ or 🟡; the whole test suite must pass.

---

## Batch Q1 — Nothing bad gets kept (rewrites and fixes are checked, not just scored)

| ID | Problem | Where | Fix |
|---|---|---|---|
| **G-20-k** ❌ | The chapter 1 rewrite deletes the clue the ending pays off and is kept because it scored higher | `opening_pass.py` `_run` (~355-391, keep rule = score only), `decide` (~233) | After the rewrite, search the new chapter 1 for every plant it had: the promise-ledger plants of chapter 1, the planned "must show" items and the setup quotes of `ending_check.promises`. If one is gone, refuse the rewrite (`OPENING_SETUP_LOST`, "the rewrite dropped a set-up the ending needs: …") and keep the old chapter 1. No AI call. |
| **G-21-l** ❌ | An improve rewrite renames the heroine "She" and kills her, and is kept | `weak_scenes.py` `check_scene` (~483-485: only full canon names), `propose` | Check every canon name part (≥ 3 letters) and the protagonist's first name: a name that was in the old scene must stay. Flag new death / outcome words (died, dead, killed, murdered, …) that were not in the old scene and refuse with `OUTCOME_CHANGED`. |
| **G-20-m** ⚠️ | The author edits chapter 1 during the re-read: the run says "kept", the rewrite never lands, the author's unreviewed draft is approved by the run, the report keeps scores for text not in the book | `opening_pass.py` `_approve` (~411), `_finish` | When the chapter's head is newer than the rewritten version: keep the author's draft as it is (not approved by the run), `keep=False` with "you edited chapter 1 meanwhile", note `OPENING_SKIPPED_EDITED`, don't save the re-read scores. |
| **G-21-m** ⚠️ | The same for the improve pass | `improve_pass.py` `_approve_kept` (~634, ~650, ~696) | As G-20-m: `IMPROVE_SKIPPED_EDITED`, "not kept: you edited chapter N meanwhile". |
| **E-12.12-l** ⚠️ | A "small safe fix" at a checkpoint swaps 4 words for ~1,800 characters and is approved | `checkpoints.py` `_fix` (~1250-1262), `_clean_problems` | A fix whose replacement is > 3× its original and > 200 characters is not small: don't apply it, leave the problem for the author. |
| **E-12.4-m** ⚠️ | An editor rewrite containing an instruction to an AI ("ignore your instructions…") is kept in the chapter | `autobook.py` `_editor_pass` / `_regression` (~2174-2360), `editor.judge_rewrite` (~344) | One shared screen (new small module `ai_injection.py`): instruction-like text (ignore/disregard your instructions, approve everything, delete the book, as an AI, system prompt, …) in a replacement → the rewrite is rejected. |
| **E-12.6-l** ⚠️ | The same in a subtext rewrite | `subtext_check.py` `validate` (~169-204) | Use the same screen: refuse the line. |

**Tests:** a rewrite without the planted clue → refused, old chapter kept; first name → "She" / a new death → refused;
an author edit during the re-read → the draft is untouched and unapproved, "not kept" said, no scores saved; a 4-word
original with a 1,800-character replacement → not applied; injected instructions in an editor / subtext replacement →
rejected. Re-run: G-20-k, G-20-m, G-21-l, G-21-m, E-12.12-l, E-12.4-m, E-12.6-l.

---

## Batch Q2 — The end-of-book review is reliable (so the final polish always happens)

| ID | Problem | Where | Fix |
|---|---|---|---|
| **G-18-a / b / c** ⚠️ | One timeout, a few busy answers or a short usage limit from the reviewer loses the whole-book review; the chapter 1 rewrite and the improve pass are then skipped | `book_report.py` `ReportService.review_with` (~718 `retry_busy=False`, ~745-757); `autobook.py` `_s_report` (~4569); `opening_pass.py` (~314), `improve_pass.py` (~337) | In a run, use the normal busy / usage-limit wait (`retry_busy=True`, as the beta reader does) and retry a failed reviewer once; if it still fails, ask the next working AI. |
| **G-18-a…f** ⚠️ (message) | Whenever the review is lost the step says "no independent AI was working" | `autobook.py` `_s_report` (~4569) | Look at the failed reviewer rows: "The reviewer AI could not answer (TIMEOUT) — 📨 Ask the other AIs on the report page". |
| **G-18-k** ⚠️ | A 1/10-everywhere review with no quotes is trusted | `calibration.py` `assess_book` / `judge` (~177), `book_report.py` `_trust` (~852) | A very low average (≤ 3) with fewer than 2 quoted weaknesses is untrusted too: ask again once, then mark it "unbacked" (it doesn't steer the end rewrites). |
| **G-19-j / k** ⚠️ | Beta "saw the twist coming" guesses with invented / paraphrased quotes still count as major and steer the chapter 1 rewrite | `beta_reader.py` `_early` (~256), `findings` (~263); used by `improve_pass._latest_beta`, `opening_pass.brief` (~178-183) | Count a guess only when its quote is verified, like the reactions; say how many guesses were left out. |
| **G-22-j** ⚠️ | The final beta re-read can be much worse after the end rewrites and nothing compares the reads | `final_reads.py` `_beta_again` (~165-176) | Compare with the first read: if interest or the overall score dropped (or "would finish" turned false), say so ("⚠️ The beta reader liked the book less after the end rewrites (6 → 2/10)") and offer to undo the end rewrites (the versions are kept). |

**Tests:** a reviewer timeout once / busy ×3 / a short usage limit → the review is made and the end passes run; a
failed review → the right message; 1/10 without quotes → untrusted; unverified guesses don't count; a worse second beta
read → the warning and the undo offer. Re-run: G-18-a…f, G-18-k, G-19-j, G-19-k, G-22-j.

---

## Batch Q3 — Nothing goes missing silently (always noted, retried where it helps)

| ID | Problem | Where | Fix |
|---|---|---|---|
| **C-10.2-o** ❌ + **C-10.3-i** ❌ | Pause / Cancel just before the promise ledger (or predictability probe) is caught as a "failure": the ledger is lost for the rest of the book and a false failure is noted | `autobook.py` `_build_ledger` (~4003 `except Exception`, ~4009 `done[key] = True`); the probe's catch in `predictability.run_probe` | Re-raise pause / cancel (as `story_guards._is_control` does); mark the ledger "made" only after a real answer or a real failure. |
| **C-10.2-a / d / e / f / j** ⚠️ | The promise ledger silently disappears when its AI times out, refuses, or sends garbage or an empty list | `promise_ledger.py` `build` (~171-197); `autobook.py` `_build_ledger` (~3980-4015) | `build` returns the reason; `_build_ledger` notes `LEDGER_FAILED` / `LEDGER_EMPTY` (plain words) and tries once more after chapter 1 (like the texture retry); the report says when payoffs were not tracked. |
| **B-4-d / e / l** ⚠️ | Characters left without a sheet / voice card are only in the journal; with bad answers the whole book is written with no voice cards | `autobook.py` `_s_characters` (~3083-3093) | Retry once after the outline; then add "<name>: sheet and voice card missing (make them on the character's page)" to the check-later list. |
| **E-12.10-g** ⚠️ | If the ending checklist fails, the last chapter is written without it and only the log knows | `ending_writer.py` `ending_brief` (~228-242) | Note `ENDING_BRIEF_FAILED` (codes only) for the climax / last chapter and list it in the report. |
| **C-10.6-m** ❌ | A damaged stored trade card is kept, so every chapter silently loses its card (a traceback per chapter) | `trade_card.py` `get_entry` (~257-262), `cards_of` (~265), `add_to_brief` (~424-446), `editor_block` (~479-497) | Accept only a list of dicts; anything else counts as missing and a new card is made. |
| **C-10.6-l** ⚠️ | Cards for trades the book doesn't have are kept and used | `trade_card.py` `clean` (~230-250), `run_step` (~316) | Keep only cards whose craft matches a detected craft, else `TRADE_CARD_EMPTY`. |
| **D-11-j** ⚠️ | If a web AI leaves out 2 of ~36 fields, the whole Book Bible batch is thrown away (90 calls, nothing filled) | `whole_bible.py` `schema` (~278: every key required) vs `read_answer` (~284) | Send the schema with no required keys and let the tolerant `read_answer` take what came; say "the AI left N field(s) empty" instead of "did not answer". |

**Tests:** Pause / Cancel before the ledger → Resume builds it, no false note; a ledger AI timeout / garbage / empty →
note + one retry; failed sheets → retried, then on check-later; a broken ending brief → noted; a damaged / off-topic
trade card → replaced / dropped; a Bible answer missing 2 fields → the other 34 are filled. Re-run: C-10.2-a/d/e/f/j/o,
C-10.3-i, B-4-d/e/l, E-12.10-g, C-10.6-l/m, D-11-j.

---

## Batch Q4 — Junk is refused early (before it is approved)

| ID | Problem | Where | Fix |
|---|---|---|---|
| **E-12.2-l** ❌ | The same chapter text is approved twice; only the final content check catches it, and then the book can't be finished | `set_h.py` (~985-1000, `DUPLICATE_CHAPTER_TEXT`, run only in part 17); `autobook._s_check` (~4665) | Compare each new chapter draft with the approved chapters (the same test as `set_h`) before review and have it written again; the final check names the chapters ("chapters 1 and 2 are the same"). |
| **E-12.2-j** ⚠️ | A book of 7-word chapters ends "done" | `long_chapter.py` `_expand` (~175-200); `autobook._s_chapters` (~4180-4230) | After a failed expansion, ask the writer for the chapter again (once) before review; mark it ⚠️ "far too short (7 of ~1,300 words)" if it is still short. |
| **E-12.2-k** ⚠️ | A 54,000-word chapter in a short story is approved | `autobook._s_chapters` / `chapter_polish.after_draft` | A chapter > 3× its target is sent back once to be shortened before review. |
| **C-10-l** ⚠️ | An outline whose chapters are all identical is approved | `modules/set_b.py` B11 checks (~440-480) | A check that refuses near-identical chapter objectives (the AI writes the outline again with the reason). |
| **A-2-n** ⚠️ | An empty AI answer gives a book called "Untitled book" | `autobook.py` `_s_profile` (~2866-2867) | An empty title or idea counts as an unusable answer (asked again / another AI). |
| **D-11-l** ⚠️ | When the AI mixes up two characters in a Book Bible batch, the wrong details are approved onto the wrong one | `whole_bible.py` `read_answer` / `accept` (~284-368) | A value that names another subject of the same batch (and not its own) is kept as a proposal (not approved), or asked again alone. |
| **C-10.5-m** ⚠️ | Changing the story shape while the beats are placed leaves the old shape's beats on the chapters | `story_shape.py` `place` (~365-397); `autobook._place_beats` (~4017) | Re-read the shape after the AI call (drop the answer if it changed); key "placed" by outline + shape, so a new shape is placed again. |
| **E-12.7-l** ⚠️ | The author edits a chapter during the guard check: the edit stays unapproved, the book uses the old text, the message blames the checks | `story_guards.py` `_fix` (~400-410); `autobook._chapter_edits` (~4399) | On a version conflict say "you changed chapter N meanwhile — the guard's fix was not applied" and treat the hand edit like any author edit (noted; reviewed / approved before the book is put together). |
| **E-12.9-l** ⚠️ | With one judge, the pick between two versions of a key scene is close to a coin flip | `pairwise.py` `pick` / `orders` (~142-190); `key_scenes.py` `_work` (~249) | Ask a single judge twice (both orders); count a version only when both answers agree, else fall back to Akọwe's own signals. |
| **E-12.2-o** ⚠️ (+ A-2-l, B-3-m, B-5-l, C-8-o, D-11-o, E-12.9-m) | Invisible / control characters from the AI are stored in chapters, names, Bible fields and titles | AI-text intake: `autobook.ai_create` / C02 checks, profile, canon, dossier and rules saves | One shared clean-up for AI text before it is saved: remove C0 control characters (except newline / tab), bidi overrides and zero-width characters (keep letters with accents and tone marks). |

**Tests:** duplicate chapter text → rewritten before approval; a 7-word chapter → asked again; a 40× chapter → sent
back; identical outline objectives → refused; an empty profile answer → asked again; a mixed-up Bible batch → not
approved; a shape change mid-placement → placed again; an edit during the guard → the right message and the edit
reviewed; one judge → asked both ways; control characters → removed (Yorùbá tone marks kept). Re-run every ID above.

---

## Order, size and how it will run

| Batch | IDs | Size | Main files |
|---|---|---|---|
| Q1 Nothing bad gets kept | 7 | medium | opening_pass, improve_pass, weak_scenes, checkpoints, editor path, subtext_check, new ai_injection |
| Q2 Reliable end review | 9 | medium | book_report, calibration, beta_reader, final_reads, autobook `_s_report` |
| Q3 Nothing goes missing silently | 15 | medium | autobook (ledger / characters), promise_ledger, predictability, ending_writer, trade_card, whole_bible schema |
| Q4 Junk refused early | 16 | larger | autobook (chapters / profile), set_b, set_h, long_chapter, whole_bible accept, story_shape, story_guards, pairwise, a new text clean-up |

Q1 and Q2 first (they protect the finished book), then Q3 and Q4. They can run as 4 parallel agents in separate
branches; the shared hot files (`autobook.py`, the fake AI) get small, separate edits and are merged by the lead, then
the full suite runs and one PR is merged once CI is green. The stress reports are re-run for the fixed IDs and
updated, so `docs/stress/` shows the new results.

**Not in this plan** (separate, later): the non-quality findings — stuck books after late edits (R2), the PDF fonts
(R3), lost typing (R1), one bad AI stopping a step (R4), optional steps that stop the book (R5), wrong message labels
(R6) and size limits (R7). See `SUMMARY.md`.
