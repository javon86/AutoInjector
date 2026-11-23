# ⚡ Make-a-book stress test — summary (2026-11-23)

588 stresses across the 22 parts (7 sections, 18 subsections): **✅ 310 handled · 🟡 109 safe stops · ❌ 33 problems ·
⚠️ 136 worked but risky.** No product code was changed; every finding below is documented in its section report
(Where / What happens / How to reproduce / Likely cause / Suggested fix / How likely). This page groups them so they can
be fixed later, root cause first.

## 1. The shared root causes (fixing one clears many findings)

| # | Root cause | What the author sees | Findings it explains |
|---|---|---|---|
| R1 | **Save without re-checking after the AI answers** — a step reads a record, waits for the AI, then saves over it | Text the author typed during the AI call is silently replaced | A-2-q · B-4-n · B-7-o (would lose work); E-12.7-l, G-20-m, G-21-m (an edit during a check or re-read is left unapproved / the run reports a rewrite that never reached the book) |
| R2 | **The run never goes back to an earlier step** — format / assemble / export / check run once; a later change (rename, page size, an edited or fixed chapter, a set-aside chapter) leaves the book un-finishable | "Approve every chapter and the book format first" / "Put the book together and approve it first"; Resume can never finish | F-14-j · F-16-k · F-17-k · F-17-l · F-17-m · E-13-m · A-2-u (after renaming) · E-12.2-l (duplicate chapter caught only at the end) |
| R3 | **PDF fonts can't print some scripts and emoji** — the typography check blocks the whole book | "G05 could not be created (BLOCKED)"; Try again fails the same way; EPUB and Word not made either | A-2-u · E-12.2-q · F-15-k · F-15-j · F-15-l. Prints: Yorùbá, Greek, Cyrillic, Vietnamese. Blocks: Arabic, Hebrew, Chinese/Japanese, Hindi, emoji, byte-order mark, NUL |
| R4 | **One AI's unusable answer stops the step** — the call is pinned to one AI; it switches only when that AI is down or refuses, never when its answer is garbage / empty / for the wrong step | The book stops in JSON-schema jargon although other AIs work | A-2-d/e/o · B-3-d/e/o · C-8/9/10-d/e/l · E-12.2-d/e · E-12.3-d/e/p (only one reviewer asked) · E-12.10-d/e |
| R5 | **"Never holds up the book" steps that do** — optional steps whose own errors are not caught | An optional step (planned check, Book Bible fill, looks, world texture, story shape, keep briefs, ending checklist) pauses the whole book | D-11-g/r · E-13-a/f/g · E-12.11-g · B-5-g · B-7-g · C-10.5-g · C-9-k (writers' room crash) |
| R6 | **Wrong labels on messages** — `alerts.py` files Akọwe's own errors (INTERNAL_ERROR) and non-AI steps as "AI problems"; refusals reuse the "busy or unreachable" wording (`jobs.py`) | The author is sent to check AutoInjector and logins for the wrong reason | Every section's g and f stresses; all of F (no AI involved at all); G-18-a…f ("no independent AI was working") |
| R7 | **No size / sanity limits on approved plan records** | A huge premise / plot / obligation is approved, then a later step can't handle it and Resume can never finish | C-8-m · C-9-l · E-12.10-n |
| R8 | **Failed optional work disappears silently** | Something is skipped and no note says so | C-10.2 (promise ledger dropped), A-1-g/j/k/n (no backup; a failed backup "saved"), B-4-d/e/l (no voice cards), E-12.10-g (no ending checklist), G-18-n (a missing chapter), C-10.2-o (a Pause loses the ledger for good) |
| R9 | **Rewrites are kept on score alone** | A higher-scored rewrite can delete a planted clue or change an outcome | G-20-k (chapter 1 loses the planted clue) · G-21-l (the heroine renamed "She" and killed) |
| R10 | **Control / invisible characters are stored as sent** | NUL, ESC, right-to-left and zero-width characters in titles, names, chapters and Bible fields (exports stayed valid) | A-2-l · B-3-m · B-5-l · C-8-o · D-11-o · E-12.2-o · E-12.9-m |

## 2. ❌ Problems, worst first

**Would lose the author's work**
1. A-2-q — the invented profile overwrites the title / idea typed during the AI call (R1)
2. B-4-n — a character sheet overwrites what the author typed in the Character Forge (R1)
3. B-7-o — story rules / world texture overwrite the author's saved version (R1)
4. C-10.2-o — Pause just before the promise ledger loses it for the rest of the book (C-10.3-i: the same on Cancel)
5. G-20-k — the chapter 1 rewrite deletes the clue the ending pays off and is kept (R9)
6. G-21-l — a weakest-scene rewrite renames the heroine "She" and adds her death, and is kept (R9)

**The book can't be finished**
7. F-14-j · F-16-k · F-17-k · F-17-l — a rename, a page-size change or an approved chapter edit after format / assemble / export (R2)
8. E-13-m — a chapter set aside near the end; the stop doesn't name it (R2)
9. A-2-u · E-12.2-q · F-15-k — Arabic / Hebrew / CJK / Hindi / emoji in a title or chapter (R3)
10. E-12.2-l — the same chapter text approved twice; caught only by the final content check (R2)
11. C-8-m · C-9-l · E-12.10-n — an oversized premise / plot / obligation (R7)
12. F-16-d/e/l — a damaged stored export file is reused for ever; Try again never remakes it
13. F-14-d · F-15-d — damaged stored format / assembly settings make Resume loop (also breaks the book page's checklist)
14. C-9-k — the writers' room crashes when every pitch fails (R5)

**Crashes or wrong state**
15. F-17-d — a malformed content-check result raises an unexpected error
16. F-17-m — the run says "done" while the book must be put together again
17. C-10.6-m — a damaged stored trade card is kept; every chapter silently loses the card

**Noise only (the book is fine)**
18. B-3-i · E-12.6-a/d/e/f — tracebacks in the log on Pause / Cancel or on a failed subtext check

## 3. The most likely ⚠️ in real use

- E-13-a/f — one timeout or refusal in the "planned details" check stops the whole book (R5)
- D-11-j — a web AI that leaves out 2 of ~36 fields throws away the whole Book Bible batch (90 calls, nothing filled)
- D-11-a — every Book Bible batch keeps timing out: about 2 hours before chapter 1
- G-18-a/b/c — one timeout / busy answer / short usage limit loses the whole-book review, and then the chapter 1 rewrite and improve pass are skipped too
- B-6-l — a hanging Stable Diffusion holds the book about 20–30 minutes (each picture waits 5 minutes)
- E-12.12-k — one real continuity problem shown as "34 problems need you" (duplicates not merged)
- E-12.12-l — a "small safe fix" that swaps 4 words for a paragraph is approved
- E-12.2-j/k — a book of 7-word chapters ends "done"; a 54,000-word chapter in a short story is approved
- A-1-g/j/k/n — a failed backup leaves the whole book without one, and the finished run doesn't say so
- G-19-j/k — unverified "saw the twist coming" guesses still steer the chapter 1 rewrite

## 4. What held up well

Busy AIs and usage-limit waits; program restarts in every part; pause / resume / cancel; two starts at once; dangerous
file names (`../`, `CON`); prompt injection in ideas and answers (with two exceptions: E-12.4-m, E-12.6-l); the cut pass;
the story doctor; the predictability probe; the who-knows-what grid; the voice test; key scenes written twice; a
60-chapter book (assembled in 1.6 s, exported in 1.2 s); a 1 MB chapter; a read-only books folder; review-score
calibration (a 10/10 with no proof is capped to 7; invented quotes are marked unverified).

## 5. Not testable here (and what was done instead)

- Anything through the Claude Code helpers (they are switched off in the harness).
- A real 1-chapter book: the outline step refuses it (tested as that refusal).
- Real read-only folders and full disks: the container runs as root, so they were simulated (EROFS / ENOSPC / SQLite
  "disk full").
- Stable Diffusion and the render bridge: fakes with shortened waits; the real wait times are stated in the reports.
- The kept-rewrite path of parts 20–22 needed scripted rewrites, because the Practice AI never changes anything there.

## 6. Suggested order for the fixes (later)

1. **R1** — re-read and merge before saving (or save with the version read): stops every "lost your typing" finding.
2. **R2** — redo format → assemble → export → check inside the run when something earlier changed (as
   `improve_pass._export_again` already does): unblocks most stuck books.
3. **R3** — fall back to a font that covers the text, or replace / warn about the unprintable characters instead of
   blocking (name the chapter and the characters).
4. **R5 + R8** — catch every error in the optional steps and always leave a journal / check-later note.
5. **R4** — on an unusable answer, ask another working AI before stopping.
6. **R6** — correct the message labels (internal error ≠ AI problem; refused ≠ busy; non-AI steps).
7. **R9** — keep a rewrite only if planted setups, names and outcomes are still on the page.
8. **R7, R10** and the remaining items.
