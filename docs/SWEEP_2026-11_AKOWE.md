# Akọwe web UI sweep — November 2026 (1920×1080 and 1280×720)

An all-around review of the Akọwe book writer's web UI (`akowe/akowe/web/`) and the server code behind it, looking
for problems before they reach a writer. The desktop app was swept separately.

## How it was done

- **Data.** We used a real server with the fake AI (`tests/autobook_fake.BookFakeAI` behind the UI harness's fake
  AutoInjector bridge) and four setups:
  - a finished fantasy book;
  - its sequel, made with 📚 Start a sequel, so the two books form a series;
  - a third book whose ⚡ Make a book run is paused, waiting for a decision (the review said REVISE, REVISE, REJECT);
  - an empty new install with no AI connected.
- **Pages.** We visited every page at both 1920×1080 and 1280×720. That is 206 routes, or 412 page views:
  - the start screen and the new-book wizard;
  - Your books, the shelf, Pair, Settings (AI slots and Pictures), ✒️ Style, ⚖️ Compare;
  - for each book:
    - the overview and 📘 Make my book;
    - the review queue and step-through, the journal, progress, activity and manifest;
    - world, continuity, the report, the scene grid, time and AI use;
    - the Character Forge (character, item and place lists, two dossiers);
    - 🖼 Pictures, 🎞 Trailer, 🎨 Cover and 📖 Book Bible;
    - the 11 set workspaces;
    - record pages and edit forms for the characters, premise, plot, outline and chapters;
    - the chapter reader with its editor, planned-items and facts cards, and the scene cards;
  - all 142 operation-set forms (A01…K…) in the sidebar;
  - for the sequel: the overview, the book page and the Book Bible (series panel, *As of book N*);
  - for the paused book: the overview, the book page and the review queue.
- **Interactive states.** We drove these with Playwright:
  - ⚡ Make a book:
    - the start form;
    - a live run (the step list, including *Character pictures*);
    - Cancel and its confirmation;
    - the paused decision card (🔁 Try again, ✔ Approve anyway and its confirmation, ✏️ Edit it myself,
      ▶ I edited it);
    - a PROTAGONIST_MISSING decision, made by rewriting the API answer;
  - the Book Bible: all pages in each of the 7 looks, *As of book 1/2*, the 📚 Series panel, ✨ Find what changed,
    and the sequel button;
  - the jump box (Ctrl+K), Tab order and focus rings, Esc.
- **Checks on every page and state.**
  - Screenshots at both sizes, which we also looked at.
  - Console errors, uncaught errors, and promise rejections the page catches itself (the yellow "The page hit a
    problem" bar).
  - Failed requests, horizontal scrolling, controls off screen, overlapping controls, cut-off button text.
  - Stray `null`/`undefined`/`NaN`/`[object Object]` text, raw error codes, stack traces.
- **Double clicks.** We double-clicked every button that starts work on 18 pages and counted the requests it sent.
- **Bad input.** We sent 49 kinds of malformed body to 52 job and save endpoints to look for missing validation
  (any HTTP 500).

## Bugs found and fixed

Each fix has a regression test, either in `akowe/tests/test_sweep_2026_11.py` or in
`akowe/tests/campaign/ui/test_ui_sweep_2026_11.py`.

1. **The 🖋 Editor card broke every premise, main plot and outline page.**
   - *What happened:* the card's pattern check only reads chapters and returns nothing for other drafts. The card
     still tried to add that nothing to the page, which threw an error.
   - *What the writer saw:* the yellow bar "The page hit a problem — Failed to execute 'appendChild'…" on every
     B01/B03/B11 page, and no 🖋 Editor review button, although the server offers the editor for those drafts.
   - *Fix:* the card skips the empty part (`web/app.js` `editorCard`).
2. **A second press of a button that starts AI or picture work started a second job.** This is the same pattern as
   the two "made twice" bugs fixed earlier.
   - *Where:* a double click, or a second tab, on ✨ Invent the rest, 🔎 Check against the book, 🖼 Illustrate every
     chapter, 🎨 Illustrated map, 🖼 Illustrate, ✨ Plan again / 🔎 Check scenes, ✨ Suggest updates / Draft again,
     🧭 Track the chapters, ✨ Suggest readings, 🔎 Check again / ✨ Fix with AI (planned items) and 🤖 Find trade
     facts. Each sent two POSTs and started two jobs.
   - *Effect:* double the AI calls. For pictures, two "every chapter" jobs both saw chapter 1 without a picture and
     made it twice.
   - *Fix:* `ReviewService._start(job, fn, same=…)` now treats a repeat press as the same request. While a job with
     the same kind, book, records and settings is still queued or running, the press gets **that** job back instead
     of starting a second one. Every job start that runs through it now passes `same`:
     - review, fix, editor, editor fix, characters, scenes, world, planned, facts;
     - the Forge (characters, items, places, magic) and its check;
     - pictures, the map, the cover, the trailer, Book Bible fill, the rest of the pictures;
     - the series' Find what changed and portraits;
     - continuity.
   - Jobs whose settings differ (for example, scenes "plan" against "rework", or portrait against views) are still
     separate jobs.
3. **✍ Write all chapters pressed twice at the same moment could start two writers** that wrote every chapter
   twice. The "is one already running?" check and the start were not one step. They now run under the service lock
   (`autobook.WriteAllService.start`).
4. **📊 Make a new report pressed twice at the same moment could make two reports.** It was the same gap between the
   check and the registration. Both now happen under the lock (`book_report.ReportService.start`), the way the beta
   reader already worked.
5. **📚 Start a sequel was offered, and worked, for a book with no chapters.** For example, on the paused book at
   step 2 of 10 with 0 words, it started "Book 2" from a book that has no end yet.
   - The sequel button is now disabled and says in plain words: "This book has no written chapters yet. A sequel
     starts where this book ends, so finish this book first (▶ Continue making this book)…"
   - The server refuses the start with the same words (`series.sequel_status`, `series.sequel_bible`).
6. **A paused Make-a-book run kept counting.** The dialog said "⏱ 9 min 59 s" and the paused step "9 min 59 s",
   still ticking, for a run that had stopped after one second, right next to "under 1 s of AI time". A run that is
   not working (paused, waiting for a decision, interrupted) now stops its clock at its last save. This is fixed in
   the dialog (`runEnd()` in `web/app.js`) and in the API's `elapsed_ms` (`AutoBookService.public`).
7. **Esc did not close the jump box once something was typed.** The search box used the first Esc only to clear its
   text, although the help line says "Esc to close". Esc now always closes it.
8. **⚖️ Compare blind could be pressed with no books, or only one, to compare.** It sent an empty request. With
   exactly one finished book there was no hint at all. The button is now disabled until there are two finished
   books, and a hint says how to get a second version.

## Checked and found fine

- No console errors, failed requests or horizontal scrolling on any of the 412 page views, including all 142
  operation forms at both sizes.
- No leaked `null`/`undefined`/`NaN`/`[object Object]` text, and no stack traces.
- Every visible control has a name.
- The Book Bible: all pages in all 7 looks fit their page at both sizes. *As of book 1* shows its read-only note.
- ✔ Approve anyway asks first. ✖ Cancel asks first. 🗑 Delete asks first.
- PROTAGONIST_MISSING shows plain words, how to fix it, and 🔁 Try again.
- None of the bad-input requests produced an HTTP 500. The bad bodies are refused with plain words.
- Ctrl+K and `/` open the jump box. The Tab order runs left to right with a visible focus ring. The skip link works.
- These buttons already ignored a double click: the editor review buttons, 📊 report, 📨 ask the other AIs,
  📖 beta reader, ⚖️ compare, ✨ Book Bible fill, 🖼 Make the rest, and Find what changed.

## Cosmetic issues, not fixed

Each item says why it was left.

- **Chapter labels show the outline's id**, as in "Chapter ch1" and "…into the chapter ch1", in the ⚡ step list and
  Write-all.
  - *Why left:* the label is reused in many run messages and journal lines that tests and the journal rely on.
    Changing it is a wider wording change, not a sweep fix.
- **"✨ Find what changed" failure text** includes the schema errors and says "Press Regenerate", but the series
  panel has no Regenerate button.
  - *Why left:* the words come from the shared AI-answer error, and the button that is there (✨ Find what changed)
    works for trying again. The fake AI caused this failure because it does not return `thing_changes`; a real AI
    normally does.
- **The paused run shows both "▶ Resume the saved run" and "▶ Continue making this book"** on the book page. Both
  work.
  - *Why left:* they do different things (resume the old run, or start a new run that continues the book), and an
  info tip explains it.
- **The AIs line in the paused run dialog** says "not checked yet" for all three AIs, although they answered during
  the run.
  - *Why left:* it reflects the check made before a start, not use during the run. It is accurate, just terse.
- **Visually hidden labels** (Project/Branch at 1280, "Art style", "Search the Book Bible") are reported as clipped
  by the automatic check. They are screen-reader labels, not cut-off text.

## Numbers

- Regression tests added: 7 server-side tests (`akowe/tests/test_sweep_2026_11.py`, all failing before the fixes)
  and 5 browser tests (`akowe/tests/campaign/ui/test_ui_sweep_2026_11.py`, run at 1920×1080 and 1280×720).
- `cd akowe && python -m pytest -q -k "not ui"`: 2659 passed, 114 skipped, 739 deselected, 2 xfailed.
- Browser tests touched or affected: 83 passed. These were `test_ui_sweep_2026_11`, keyboard, autobook, binder,
  pictures, forge, continuity, crawl and buttons.
