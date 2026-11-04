# Akọwe improvement plan (from the "Lamplighter's Last Round" review)

> Formerly BookForge — renamed to Akọwe on 2026-10-25.

Source: the first fully automatic book ("The Lamplighter's Last Round", 2026-10-23), ChatGPT's and
Gemini's reviews of it, and the AutoInjector run log. Main findings:

- The book is coherent and atmospheric (9/10 for atmosphere, premise, continuity, structure) but
  "too cooperative": characters say what they feel, nothing resists, the ending absolves everything
  (4-5/10 for subtext, character depth, peril, world texture).
- Only Claude worked in the run (ChatGPT: reply area not found; Gemini: its answer was wrongly
  treated as an old one), so Claude reviewed its own writing.
- The AI reviewer only checks consistency with the plan, never craft. Planned details (the narrator's
  name and backstory) never reached the page.

Legend: `[ ]` to do · `[~]` in progress · `[x]` done · `[!]` problem (see "Problems" at the end)

---

## Status at a glance  (keep this up to date — updated on every add / finish)

- **Done and in `main`:** Sections 1–6 (P3, P4–P18, P20, P21), Section 8 (P36, P37.1, P37.3–P37.5, P38; P37.2 partly [!]),
  Section 7 (P23–P28, P30–P35; P22 skipped by the user, P29 audiobook later), Akọwe GitHub CI, the follow-through fix.
- **Now:** the FIRST REAL TEST on the user's PC — step by step in `docs/FIRST_REAL_TEST.md`. Waiting on the user's
  ChatGPT page check (`desktop-app/tools/page-check.js`, formerly `chatgpt-page-check.js`) to hard-code ChatGPT's live selectors.
- **Latest feedback:** ChatGPT's 2026-10-24 comparison of book 1 vs book 2 — book 2 better on character (5→8), voices (5→8), subtext (5→8), peril (4→7), realism (5→7); weaker on closure (9→6) and scope (9→6); added P30–P35 from it.
- **🎩 Alfred (done 2026-10-25, B4 → app-wide):** the butler grown into the user's assistant for the whole app — chat
  drawer on every tab, a fixed tool registry, "I will" cards before any change, proactive notices; OFF by default
  (🎩 switch); a local model via Ollama or a connected AI. See `docs/ALFRED.md`.
- **🧰 Tool servers / MCP (done 2026-10-28, f10 "mcp"):** in ⚙ More settings → 🧰 Tools, add an outside MCP tool
  server (a command line or a web address, with encrypted keys). Alfred uses it through `mcp_tools` and `mcp_call`
  (always on a card, never "always allowed"), and the butler through USE_TOOL. See `docs/ALFRED.md` → "Tool servers (MCP)".
- **F10 (done 2026-10-28, "do all 10"):** Alfred has exactly two places — the 🎩 Butler section (setup) and his
  docked talk panel (no separate window; Ctrl/Cmd+Shift+A). The old top User Panel butler buttons now drive Alfred, and
  the panel has 8 big action buttons (🧑 character, 🎨 picture, 🎬 video, 🖼 cover, 📖 my book, ✍ continue/make a book,
  🩺 check everything, ❓ everything I can do — a 230-item list in 8 groups). The old Image/Video panels and the setup
  wizard's duplicate forms are gone (one place each: 🎨 Images, 🎬 Video). Also: ebook cover JPG, map PNG in Word,
  style-card delete fix, motion clips for items/places/magic, new characters from scratch, auto-save + update-or-copy +
  big books opened from a folder, MCP tool servers, book trailers (B2).
- **✍ Write alongside me (done 2026-11):** highlight a passage in a chapter and the AI continues, rewrites, describes,
  expands or tightens it; a suggestion with ⚠️ quick checks, used as a new draft version. See "✍ Write alongside me".
- **Back burner (later, by the user's call):** a first real GPU run of video/trailers; the audiobook export (P29).
- **Still to try for real:** everything above has only been tested with stand-in AIs — the first real
  run on the user's PC is the real test (see "Problems to come back to").
- **One app, one launcher (done 2026-10-25):** start AutoInjector — Akọwe starts with it (📖 Akọwe tab, connected
  by itself). `akowe/run-akowe.*` remain optional for Akọwe alone.
- Last updated: 2026-10-28 (F10: all ten unfinished items done — see above). Before: 2026-10-27 (B1 pictures in books, B3 covers (designer + print wrap) and B5 items / places / magic systems + the manuscript check DONE, all usable by 🎩 Alfred; earlier: video, Character Forge, 360 scan; B6 Alfred floating side panel + one-button AI setup + model finder DONE; book #2 next).

## Section 1 — AIs that always answer (self-repair) and independent review  (Phase 1)

- [x] **P18.1** Check-in probe: a tiny automatic message with a random word, sent to each AI at
  start, every so often while running, and before Akọwe starts a book.
- [!] **P18.2** Failure classifier: typing failed / sent but no reply found / reply rejected as old /
  stuck generating / logged out or captcha / usage limit.
- [!] **P18.3** Automatic fix 1: try other known ways (built-in list per site) to find the message box,
  send button and replies.
- [x] **P18.4** Automatic fix 2: search the page for the check-in's random word, learn where replies
  appear, save it and test it again.
- [x] **P18.5** Fix the duplicate check (Gemini's answer was treated as an old one): a reply that
  answers the current message number is new.
- [x] **P18.6** Automatic fix 3: reload the AI's window; unfreeze a stuck AI (stop button, resend).
- [x] **P18.7** Teach step: pop-up asks the user to type "Repeat this number: ####" (random 4 digits);
  AutoInjector learns the message box, send button, the user's message and the reply from where the
  number appears, saves them and confirms with a new check-in. Falls back to the 🎯 picker.
- [x] **P18.8** User-only problems (logged out, captcha, usage limit): ⚠️ says exactly what to do,
  re-checks by itself when fixed.
- [x] **P18.9** Akọwe keeps going: work moves to the AIs that are working while one is being
  fixed, and moves back when it recovers.
- [x] **P18.10** Every detection and fix goes into the activity log and diagnostics.
- [x] **P3.1** Writer and reviewer are always different AIs when more than one works.
- [x] **P3.2** ⚠️ "reviews are not independent" when only one AI is available.

## Section 2 — A real editor  (Phase 2)

- [x] **P4** Craft review after the consistency review: subtext, characters' own goals and
  resistance, distinct voices, obstacles from the world, over-stated theme, repeated patterns and
  gestures, too-neat ending, protected mysteries. Each finding points at the exact passage.
  *(akowe/editor.py + editor_rubric.py: scores 1-10 per dimension, findings with exact quotes, keep list; editor ≠
  writer; Akọwe decides PASS/REVISE by strictness; advice per record+version; chapter page, review queue, run
  window, journal; premise/plot/outline with a lighter rubric on request.)*
- [x] **P5** Targeted rewrite of only the flagged passages, with a "keep" list; afterwards check that
  nothing good was lost and no story rule was broken.
  *(The writer returns exact original → replacement pairs, applied word for word or left unresolved; new version via
  the normal UPDATE; in runs: checks + consistency review + pattern check + editor again, kept only if nothing got
  worse, else the earlier text is restored; max 2 rounds, then ⚠️ "editor still had notes" and the run goes on.
  Outside runs: ✍ Apply editor's fixes with before/after per passage.)*
- [x] **P6** Pattern checker (no AI): counts repeated tics ("went very still", "not X, not Y, but Z",
  moral paragraph endings, repeated gestures) and feeds them to the editor.
  *(akowe/prose_audit.py: 11 checks with passage locations, thresholds per 1 000 words, strictness.)*

## Section 3 — Characters who are their own people  (Phase 3a)

- [x] **P7** Richer character sheets: wants, needs, fears, secrets, false belief, stress behaviour,
  what they would never say; side characters get their own wish.
  *(akowe/characters.py: + private memory, relationships (tension/history) and limits of change; companion data
  `characters:<pid>:<branch>` per A01 record; made with the character (Bible Builder / Make a book / Fill with AI) or
  on request; character page card + edit form with ⓘ; Make-a-book step "Character sheets and voices"; the consistency
  reviewer of a character sees its sheet.)*
- [x] **P17** Voice cards: how each character talks (rhythm, vocabulary, favourite/never words,
  habits, job/era in their words, speech under pressure, what they talk around). Voice test in the
  editor: with names hidden, can you tell who is speaking?
  *(Voice cards of the characters present in every C02 prompt (≤ 4 full + one line each, ≤ 7 000 chars); P6 voice
  check (per-speaker stats, look-alike pairs, never-words); editor `voice_distinction` uses the cards and quotes the
  line that sounds like another character.)*
- [x] **P8** Scene cards before writing: each character's goal and hidden agenda, an obstacle from
  the world, what changes, what stays unsaid.
  *(akowe/scenes.py + chapter_brief.py: writer AI plans, another AI checks (light rubric), rework ≤ 2, approved
  under the run consent; book page row 🎬, scene cards page (read/edit/check/plan again/approve), chapter page card,
  run window; writer follows them, editor `scene_plan` dimension checks them. P11-lite: the POV/narrator's name and
  planned backstory are in every chapter prompt.)*

## Section 4 — A world with rules and texture  (Phase 3b + 4a)

- [x] **P9** Story-rules ledger: hard rules / things seen to happen / beliefs / protected mysteries.
  *(akowe/story_rules.py: category, scope/limits, source, stated by, status; companion data
  `story_rules:<pid>:<branch>`; the AI drafts it from the rule-bearing canon (A03/A09/A08/A17/…) + profile + plan, later
  suggests updates as proposals the author accepts/rejects (a run accepts them under its consent after the outline);
  deterministic "bounded?" lint with ⚠️; bounded rules in the plot/outline prompts and reviews (new planning dimension
  `rules_bounded`), the C02 brief (never break a hard rule, never turn a belief/mystery into fact), the editor (new
  dimension `story_rules`, protected mysteries) and the consistency review; 🌍 page with edit/ⓘ.)*
- [x] **P10** World-texture list (work, weather, institutions, locals); a detail is used only if it
  causes something, shows skill or gets in the way.
  *(akowe/texture.py: kind, detail, causes obstacle/skill/cost, effect, match words; companion data
  `world_texture:<pid>:<branch>`; scene planning takes obstacles from it (cards name the ids), the writer gets ≤ 4 per
  chapter, `world_friction` reads it; deterministic usage counts (pattern check `texture_overused`, unused/overused on
  the 🌍 page).)*
- [x] **P11** Planned-to-page check (e.g. a narrator's planned name and backstory never shown).
  *(akowe/planned.py: beat, scene obstacles/changes, POV name, sheets' new "must show" items, planned details; word
  check, then one independent AI check; ✅ checklist on the chapter page and the book page with ⚠️; ✨ Fix with AI = the
  missing items as anchored findings for the P5 rewrite; in Make a book after the editor (1 round, kept only if checks +
  reviewer pass and fewer items are open), never blocks: ⚠️ + run summary; a book-level report step before assembly.)*
- [x] **P12** Ending and style choices in the book profile (neat / bittersweet / open; how much is
  explained; how dark), all optional with good defaults.
  *(akowe/story_choices.py: ending neat/bittersweet/open/dark, explain/hint/leave, gentle/some/real danger, dialogue,
  pace, humor; "Let the AI choose" by default; the ending-state matrix is the internal form (presets + mystery row +
  row overrides under "More ending options"); wizard, profile card/dialog, ⚡ quick settings; feeds premise/plot/outline,
  scene cards, chapter prompts (matrix in the last chapter), editor questions and thresholds, the ledger's mysteries.)*

## Section 5 — Proof, reports and longer books  (Phase 4b + 5)

- [x] **P13** Automatic book report when a book is done (scores, strengths, weaknesses) and a button to
  send the book to the other AIs for review.
  *(akowe/book_report.py: words vs the length targets, editor / planned-to-page / pattern findings across chapters,
  who wrote / reviewed / edited what, whole-book review by every working AI that did not write most of the book — 13
  criteria, strengths and weaknesses with quotes checked against the book, median per dimension and ⚠️ disagreement,
  what to try next; whole book ≤ 60 000 chars, else a per-chapter digest; stored per book version; last run step
  "Book report" (never blocks); 📊 report page with ⬇ Markdown / PDF and 📨 Ask the other AIs; shelf and book page.)*
- [x] **P14** Compare versions: old vs new pipeline, rated blind by the other AIs.
  *(akowe/pipeline.py: run switches editor / scenes / voices / rules / planned, presets full and baseline, honoured
  by the run, the chapter brief, the outline prompt and Write all chapters; 🧪 Make a variant = the same profile, idea
  and choices made again with other switches; akowe/compare.py: two books or two chapter versions, each reviewer
  sees "Version 1 / Version 2" in its own random order (mapping recorded, no IDs/titles/pipeline names in the prompt),
  Akọwe reveals the mapping: median per dimension, winner per dimension, votes; ⚖️ compare page from the shelf.)*
- [x] **P15** Novella and novel lengths with word targets per chapter and scene.
  *(akowe/lengths.py: short story / novelette / novella / novel presets with words, chapters and scenes per chapter
  → B11 target_length + a length sentence, scene cards (scene count, words per scene), chapter prompts (target words);
  akowe/long_chapter.py: chapters above 2 500 words written scene by scene (one AI call per scene, continuity from
  the previous scene's end), a chapter far under target continued in bounded rounds (never padding); ETA in the run
  window from measured times; Settings › 📏 Long chapters; a 25-chapter novel runs end to end in the tests.)*
- [x] **P16** AutoInjector "Extract this book only" (the full extract mixed in unrelated private
  conversations).

---

## Section 6 — Saving books and covers  (requested after the first five sections)

- [x] **P20** 💾 Save the book: one folder per book (in a chosen books folder) holding the finished book
  (PDF/EPUB/DOCX), the book bible (profile, choices, characters with sheets and voice cards, places/world,
  premise, plot, outline, scene cards, story rules, world texture), the chapters as text, the book report,
  and the book's log (journal, run events, AutoInjector-free); saves automatically when a book finishes and
  as progress while it is being made; a Save button on the book page and the run window.
  *(akowe/book_save.py: Settings › 📁 Where books are saved (default Documents\Akowe Books on Windows, ~/Akọwe
  Books elsewhere; writable check; 📂 Open folder on this computer only); one folder per book “<title> (<id>)” kept
  when the title changes (`book_folder:<pid>:<branch>`); Book/, Chapters/ (DRAFT marked), Book Bible/ (book_bible.py:
  versioned JSON + Markdown), Reports/, Log/ (journal + run-events.json), Progress/, README.txt and book.akowe
  (book_package.py: every row, version and file of the book with checksums); atomic writes, Windows-safe names, paths
  ≤ 200; auto-save (default on) after each run step / chapter / approval at most every 2 minutes and at once when a run
  finishes, pauses, is cancelled or stops; ⚠️ SAVE_* codes, never blocks a run; no keys, tokens or prompts (checked);
  💾 on the book page, top bar, shelf and run window.)*
- [x] **P21** 📂 Open a saved book / rerun: load a saved folder back into Akọwe (as a new book), continue
  an unfinished one, or rerun it from its book bible (same characters, world and plan; new chapters).
  *(akowe/book_open.py + book_package.py: 📂 Open a saved book (top bar / Your books): the books-folder list (this
  computer only) or an upload of book.akowe / book-bible.json; checksums, record hashes and schema_version checked
  (OPEN_BAD_PACKAGE / OPEN_NEWER_VERSION); always a NEW book (new ids, every content hash recomputed, “(opened)” only
  when the title exists); ▶ Continue making this book (a run on that book that skips what is done) and ▶ Resume the
  saved run; 🔁 Rerun from the book bible (book page, shelf, folder list, uploaded bible) = a new book whose canon,
  sheets, voices, rules, texture and — optionally — premise/plot/outline/scene cards come from the bible and are
  approved inside it under the run consent; new chapters.)*
- [x] **F10 (2026-10-28) finished pieces (lane akowe):**
  - 💾 **Quiet 10-minute save**: besides the saves after each step / approval / finished run, every 10 minutes
    (`book_save.PERIODIC_S`) each book whose state changed since its last save is saved (`fingerprint`: records,
    approvals, module state, its own settings) — work done by hand is saved too; an unchanged book is not touched.
    Same Settings switch (on by default).
  - 📂 **A saved book that is already here**: Open asks “⟳ Update the one I have / 📄 Open as a copy” (`mode`); update
    keeps the book's id, folder and last-save note, checks the package as a copy first and is refused while a run works.
  - 📂 **Books bigger than the upload limit** open straight from their folder (`POST /api/books/open-path`, this
    computer only); 📁 Choose the folder uses AutoInjector's picker (`POST /api/books/choose-path` → bridge
    `POST /dialog/choose-path`).
  - 🖨 **Ebook cover JPG** (KDP 1600 × 2560, also 2560 × 4096 / 1000 × 1600 / 625 × 1000) and the **map's PNG copy for
    Word**, drawn by AutoInjector's new `POST /render/image` (offscreen Chromium, no network); the EPUB with cover uses
    the JPG; plain error when AutoInjector is not connected. 🎬 **Motion clips** for items (turntable), places
    (establishing pan) and magic systems (the effect in use). 🧑 **New character** from the Forge / Alfred
    (`POST …/forge/characters`). Fix: deleting the style card answered HTTP 405 (DELETE was only let through for
    pictures).

## Section 8 — Fixes from the book-2 run log  (proposed — do before Section 7)

From the 2026-10-24 AutoInjector log: Claude wrote, Gemini reviewed (independence worked), 48 Akọwe
requests in 16 min; ChatGPT never took part; Gemini's reply reading broke in the evening; Gemini as
editor passed every chapter and scored the book 10/10 on 10 of 13 criteria while ChatGPT's own review
gave 7–8 and found real flaws, so the editor's rewrite loop never ran.

- [x] **P36** Tougher, calibrated reviewer: must name its weakest passages and at least 3 concrete
  problems; reviews with near-perfect scores and no findings are distrusted (re-asked or flagged);
  add trade/logic/timeline checks to the rubric; use two reviewers when available and take the lower
  score; track each AI's leniency over time. Done: `calibration.py` + editor.py — a 9/10 needs a quoted proof and an
  average ≥ 8.5 needs 3 quoted problems, else one stricter re-ask, then ⚠️ flagged, unproven scores count as 7 and
  pattern-check notes are added so the rewrite runs; new rubric points trade_terms / cause_effect / timeline; a second
  editor (not the writer, not the first editor's AI) when one works, lower score per point; leniency per AI in
  `reviewer_leniency` (vs the other editor, the pattern check and whole-book reviewers), lenient AIs lowered by up to 2,
  shown on the 🖋 Editor card and the 📊 Book report. Done: … also whole-book reviews (after the first real book:
  Gemini read 4,500 words in 7.5 s, scored 8–9 on all 13 points with one weakness → "overall 8.6/10 from 1
  reviewer"): the 📊 whole-book review prompt asks for at least 3 quoted weaknesses and a `score_evidence` quote for
  every 9–10 (optional fields, older answers still parse); the same rules from `calibration.py` (`judge` shared by
  `assess` and the new `assess_book`) — unproven 9/10 or a near-perfect average with < 3 weaknesses whose quotes are in
  the book → one stricter re-ask (`book_report.STRICT_REASK`), still untrusted → ⚠️ warning and its unproven high
  scores count as 7 (`scores_raw` keeps what it said); each whole-book review feeds `reviewer_leniency` (vs the median
  of the other reviewers and vs the book's pattern check through `BOOK_AUDIT_DIMS`, flagged/re-asked counted) and gets
  the same discount after 3 observations; the report page, Markdown and PDF show the flag and a one-line "how
  generous" note per reviewer ("How far the reviewers were trusted"). Not done for the ⚖️ P14 blind compare: it has
  no quotes and decides by the difference between two versions scored by the same AI, so caps or a discount would
  hit both sides alike. Tests: `tests/test_book_review_calibration.py`.
- [x] **P37.1** Self-repair page search must learn a selector that matches every reply, not one message
  (ChatGPT learned `div[data-content-search-unit-key="fallback-turn-7:2:assistant"]`). Done: per-message
  numbers/ids/keys are never part of a learned selector (that key becomes `[…$=":assistant"]`), and with
  2+ replies on the page it must match at least two (page search, 🎯 picks and the 🔢 number teach alike).
- [!] **P37.2** Read the whole reply when the page splits it into several nodes (Gemini read only "[TO:").
  Done for split nodes (the reader takes the whole AI message container; tested with fake Gemini DOMs),
  but the live Gemini cause (`parentChars 4`) is still unconfirmed — see "Problems to come back to".
- [x] **P38** 🎯 Picker rebuilt (user's design, done — fake pages only, see Problems): click 🎯 → choose ONE of the three things
  (message box / Send button / reply area) → OK → click it in the AI's window; the chip turns from blue
  to green when something is picked; Clear or Save per item, any one at any time; Save locks it in.
  🔢 Number teach: the user types the shown number into the AI's box and presses Send (AutoInjector
  learns the box, Send and the user's message); AutoInjector then itself asks the AI to write that number
  backwards and learns the reply area from where the reversed number appears; saves it and tells the user.
  Includes P37.1 (selectors that fit every reply) and P37.2 (read the whole split reply).
- [x] **P37.3** Teach step: ask once, make it noticeable (sound/popup), back off after BROKEN, stop the
  probe → repair → teach loop (9 teach timeouts, 192 self-repair events in the log). Done: never started
  automatically; one notice (card flash + ⚠️ with 🎯 / 🔢, optional 🔔 sound); re-checks after 5 → 15 → 60 min.
- [x] **P37.4** Never send "missing [TO:] tag" nags for check-in answers (48 nags to ChatGPT). Done (also
  for late / unproven check-in answers and the number-teach answers; they are held, not relayed).
- [x] **P37.5** Before a book starts: a clear "ChatGPT isn't working — here's why / fix" so the user can fix
  it first instead of the AI silently sitting out. Done: `ai_check.py` + `GET/POST /api/ai-check` (fresh /v1/health,
  🔁 check again = /v1/probe first); every run start (⚡ Make a book, variant, 🔁 rerun, ▶ continue, ✍ Write all) shows
  which AI, what is wrong (LOGGED_OUT, CAPTCHA, USAGE_LIMIT, … in plain words) and how to fix it, with Check again /
  Start without it (roles reassigned, said in the run) / Cancel; the run window shows a ⚠️ notice for every AI not
  working at the start or stopping mid-run (and ✔ when it is back). No desktop-app change was needed.

## Section 7 — Tools for the AIs and better feedback  (proposed, not started — user picks)

- [-] **P22** (SKIPPED — user said don't do the AI tools/skills menu, 2026-10-25) Tool menu for the AIs: the AI can ask Akọwe for a lookup mid-task (T1 look up character /
  place / rule, T2 search earlier chapters, T3 timeline + age calculator, T4 trade/period glossary, T5
  voice-fitting thesaurus, T6 name generator, T7 word count / pacing, T8 fact check against the book bible,
  T9 optional web research); bounded requests per step, all logged.
- [x] **P23** Beta-reader AI: reads as the target audience and marks confusion, boredom, guessed twists.
  Done: akowe/beta_reader.py — one AI (independent by default) reads the book text only as the profile's audience,
  returns reactions/interest/guesses/stop with quotes checked against the book and the chapter; Akọwe derives
  findings (lost, flat stretch, twists guessed early, would stop); 📖 card + button on the 📊 report page, optional
  ⚡ run step "Beta reader" (`beta_reader: true`), never blocks the book.
- [x] **P24** Readability and pacing scores (reading level, sentence variety, dialogue share, scene length)
  matched to the profile's audience.
  *(akowe/readability.py, no AI: Flesch reading ease + grade, words per sentence, variety, long/short share,
  dialogue share, paragraph length, scenes per chapter (scene-break lines), pace fast/steady/slow; audience matched
  from the profile's free text (children / middle grade / young adult / adult, literary +2 grades); findings for
  too hard / too simple, long sentences, low variety, little or only dialogue, chapters that read differently, very
  short scenes; 📖 card + per-chapter table on the 📊 report page, Markdown/PDF section, up to 2 items in What to try
  next; numbers only, never breaks the report.)*
- [x] **P25** Your writing style: learn the narrator's voice from samples of the user's own writing.
  Done: akowe/style_card.py — ✒️ My writing style page (paste/upload samples): numbers counted without AI plus an
  AI summary (quotes checked); a book holds a snapshot (`style_card:<pid>`) that goes into the chapter brief
  (`narrator_style` + a rule) and the editor's context/task; ⚡ run option "Write in my style" (`my_style: true`).
- [x] **P26** Timeline checker + terminology check in the editor (the second book had "wick-key" on a gas
  lamp and age arithmetic to verify). Done: `timeline_check.py` (ages, birth/story years, "N years ago" arithmetic,
  no AI) + the term check of `terms.py`, shown on the chapter/book page and sent to the AI editor as `fact_checks`.
- [x] **P27** Scene-grid / timeline view of the whole book.
  Done: `scene_grid.py` + `GET …/grid[?format=csv]` and the 🗂 Scene grid page (`#/p/…/grid`, web/grid.js): one row per
  scene (POV, place/time, goals, obstacle, change from the scene cards; words and P24 readability per scene; problems),
  sortable/filterable, cards on a phone, 🖨 print stylesheet, ⬇ CSV; no AI, nothing stored.
- [x] **P28** Cost and time per book (calls and minutes per AI; estimate before starting).
  Done: `costs.py`: each run times every AI call per AI and per step (`run.timing.by_ai/by_step`), `GET …/costs[?format=md]`
  + ⏱ Time and AI use page (runs, per AI, journal-counted work, tokens/money), 🤖 line in the run window, and
  `POST /api/estimate` shown as ⏱ "about X–Y min · N–M AI answers" in the Make-a-book setup (length + pipeline).
- [ ] **P29** Read-aloud / audiobook export (later).
- [x] **P30** Repetition sorter: before cutting a repeat, the editor classifies it as voice / motif /
  filler / accident (keep "Right, so" and Odile's counting; trim only excess). Done: `repetition.py` sorts every
  repeat (author can relabel); voice/motif words join every rewrite's keep list; ✨ Trim cuts only accidents/excess.
- [x] **P31** Trade-facts lane: equipment and period terms marked "research needed" until verified
  ("wick-key" on a gas lamp; how gas lamps are lit/extinguished; pressure and isolation). Done: `terms.py` list
  (`trade_terms:<pid>:<branch>`): scan/AI add terms as research needed, AI answers are advice, only the author verifies.
- [x] **P32** Physical state tracker per scene: tide, light, time, footing, hazards, running counts
  (the 32–41 lamp count, the clock, the gauge reading); early hazards must change later actions.
  Done: akowe/physical_state.py + continuity.py — AI + no-AI extraction per scene, checks (count backwards, clock
  backwards, hazard dropped), approved state feeds the next chapter's brief; 🧭 Continuity page.
- [x] **P33** Two-readings test for protected ambiguity: both readings must hold without contradiction;
  flag the weaker one (zero gas pressure vs. "it was the isolator").
  Done: akowe/ambiguity.py — two readings per protected mystery (AI or author), AI test with quotes checked word
  for word, Akọwe marks the weaker reading; the writer's brief keeps both open.
- [x] **P34** Version delta ledger for reruns and variants: retained / replaced / removed / unresolved
  facts, so checkers never "correct" a deliberate change back to the old story.
  Done: akowe/version_ledger.py — fact-by-fact diff against the source bible / variant source, author decisions
  (deliberate / restore), sent to the writer's brief and the consistency review.
- [x] **P35** Character state variables per scene (e.g. duty, guilt, fear of exposure, desire for contact)
  plus what each can observe and falsely assumes; at least one action per main character that serves
  their own goal, not the theme.
  Done: akowe/character_state.py — 0-10 values (book's own list), observes / assumes / own action per scene, checks
  (big jump, no own-goal action), latest state in the next chapter's brief.

## Back burner — later, by the user's call  (don't start until asked)

- [~] **B1** 🖼 Images: hook Akọwe up to image generation — Stable Diffusion (AutoInjector already has
  an Image Generation panel and a Stable Diffusion endpoint setting in its setup wizard) and/or other image
  AIs; pictures stored as book assets with the right permissions.
  Done (AutoInjector side, 2026-10-25): the 🎨 **Images** tab — connects to Forge / A1111 / reForge / SD.Next
  (`/sdapi`) or ComfyUI (built-in workflow + LoRA nodes), finds them on localhost, spots "started without
  `--api`" and says the Stability Matrix fix; checkpoints/VAE/sampler/LoRAs with weights, progress + Stop,
  pictures saved with their settings (Remake); the Model & LoRA library (Stability Matrix `Data/Models`,
  safetensors headers + Civitai/SM sidecars, base-model mismatch warnings, tags/collections/★/notes) and
  **character locks**; it can start Stability Matrix packages itself or install the official ComfyUI portable.
  Full controls (2026-10-25): every A1111/Forge txt2img/img2img field can be reached (58 fields each, 0 unreachable).
  This covers hires fix, the SDXL refiner, img2img and inpaint with a mask brush, ControlNet units, ADetailer, Extras
  upscale, any settings-menu option, and raw extra fields. ComfyUI gets its built-in graph for the main features plus
  saved workflows with named params. `capabilities()` lists 51 operations, and 🎩 Alfred can use all of them, each
  one tested. See `STABLE_DIFFUSION_PLAN.md`.
  Akọwe can ask via `POST /image/request` with a character lock (`docs/SD_IMAGE_API.md`). Setup guide:
  `docs/STABLE_DIFFUSION_SETUP.md`. Still to do: the Akọwe side (store pictures as book assets, UI) — with B3/B5.
- [~] **B2** 🎬 Video: hook up AutoInjector's Video Generation panel for book trailers / scenes (trailers done; a real GPU run open).
  AutoInjector side, DONE 2026-10-27: a real local video engine (`video-studio.js`, `docs/VIDEO_API.md`).
  - It renders with the ComfyUI the app already installs, using Wan 2.2 TI2V 5B (text or picture → video, about 12 GB VRAM) or Wan 2.1 T2V 1.3B (text → video, about 8 GB).
  - In-app model downloads (16.9 GB / 9.2 GB, the shared text encoder fetched once). ComfyUI itself installs first when it is missing. Stability Matrix model folders are supported.
  - A 🎬 Video tab: setup, text → video, picture → video, every Wan setting, progress and Stop, a player and gallery, plain error boxes.
  - 🎞 FramePack engine, DONE 2026-10-29 (`framepack.js`, `integrations/framepack/framepack_runner.py`, docs/VIDEO_API.md §8): the FramePack the author already has (Stability Matrix's Packages\FramePack, or 📂 a chosen folder) makes clips and trailer shots with **no new downloads** — its models from "stuff and thing"/models/video/framepack/hf (else its own hf_download), run offline with its own venv python, kept loaded between videos. Picture → video directly; text → video makes the picture first with 🎨 Images. Auto picks FramePack when it is found and Wan isn't installed. Setup card (found / models ✔✖ / ▶ Load / 🧪 2-second test), Alfred (`generate_video` engine framepack, `video_call` video.framepack.*), trailers (shot key includes the engine), 🩺 health row. Tested with a fake runner (no GPU); a real GPU run is still open.
  - Bridge: `GET /video/backend` and `POST /video/request`. The capability test renders a real 1 s clip.
  - 🎩 Alfred: `video_call` over every video-api method, plus `generate_video` (text, picture or a character's looks) and the dossier `clip`.
  - Checked across the two real programs: an Akọwe clip job → the bridge → video-studio → a ComfyUI stand-in → clip and poster stored with the book.
  - Still open: a first run on a real GPU. Book trailers (several shots joined): done 2026-10-28, see below.
  Akọwe side, first use DONE 2026-10-27: Character Forge **motion clips** — a 4 s picture→video "motion study" per
  dossier through AutoInjector `POST /video/request` (portrait as a temp-file path, idle-motion prompt from the
  appearance / posture / gait / expressions fields, 900 s timeout, plain words for every `VIDEO_*` code), stored with
  its poster as book assets, played on the dossier page, the poster as a MOTION STUDY still in the PDF, in the book
  save (`docs/CHARACTER_FORGE.md` "Motion clip"). Still open: a real GPU run.
  🎞 **Book trailers DONE 2026-10-28** (`docs/VIDEO_API.md` §7): AutoInjector `video-trailer.js` renders the shots one by
  one through the video engine (progress, Stop, finished shots kept and reused), joins them with title cards, fades and
  optional music in a hidden offscreen window (canvas + MediaRecorder → `trailer.webm`, no new dependency), and adds
  `trailer.mp4` when an ffmpeg is found (PATH, ComfyUI folders, imageio-ffmpeg). 🎬 Video → 🎞 Trailer section; video-api
  `trailer.make/status/cancel/list/plan`; bridge `POST /video/trailer`, `GET /video/trailer`, `POST /video/trailer/cancel`.
  Akọwe (`trailer.py`, page `#/p/<pid>/<b>/trailer`): 🎬 Plan a trailer builds 5–8 shots from the book (title and
  logline cards, the main place, key chapters but never the ending, the characters' approved looks + locks, chosen
  chapter pictures / portraits brought to life), the author edits them, 🎞 Make the trailer runs as a job and stores
  the trailer with the book (book save `Trailer/`); plain words for every `VIDEO_*` code. 🎩 Alfred: `make_trailer`.
- [x] **B3 (P19)** 🎨 Book cover and pictures (DONE — covers, interior pictures, map; ebook JPG + Word map 2026-10-28): cover design (title/author on a template,
  AI-generated artwork when an image AI is connected), chapter images/illustrations, maps; placement in
  PDF/EPUB/DOCX; print-ready cover size and spine.
  - 🖼 **Interior pictures DONE 2026-10-27** (`docs/PICTURES.md`): the 🖼 Pictures page — a book-wide art style,
    🖼 Illustrate per chapter or scene card (prompt from the scene card + the characters' approved looks + the
    character lock, ≤ 1 200 characters; `/image/request` `purpose: "illustration"`, 1-3 candidates to pick from),
    upload, caption / alt text / placement (a page before the chapter, under the heading, after scene n, the end),
    the map (SVG drawn from the places, illustrated `purpose: "map"`, or uploaded; before chapter 1), "Illustrate
    every chapter" as a job with Stop. Placed in PDF / EPUB / DOCX with captions (snapshot at "Put the book
    together"). The SVG map is never rasterised (no Pillow): EPUB carries the SVG, the PDF draws it as vectors, the
    DOCX names where it is. In the book save (`Pictures/`). Still open: a real ChatGPT/GPU run.
  - [x] **Covers (lane A), DONE 2026-10-27**: the 🎨 Cover page (`#/p/<pid>/<b>/cover`). It has seven typographic
    templates (light and dark, by genre), colours, title fitting (autoscale, balanced line breaks, safe area 0.375 in),
    scrims over the artwork, and AI art through AutoInjector `/image/request` `purpose:"cover"` (with `size`, `upscale`
    and the character lock), upload, or no art.
    - The ebook cover is a PDF or SVG. The EPUB uses the art as its cover image plus an inline-SVG cover page; the
      DOCX gets a cover page.
    - The print wrap PDF has 0.125 in bleed, a KDP spine (white 0.002252 in / cream 0.0025 in per page), spine text
      from 100 pages (rotated and centred), a back cover with the blurb and author bio, and a blank 2 × 1.2 in barcode
      box.
    - The exported PDF/EPUB/DOCX can be had with the cover, and the book save writes `Cover/`.
    - No Pillow: Akọwe does not rasterise (see `docs/COVERS.md`).
- [x] **B4** 🧭 Local AI book manager — DONE 2026-10-25 as **🎩 Alfred (app-wide)**: not only a book manager but the
  user's assistant for the whole of AutoInjector (books, images, video, the three AI panes, files/logs). A local LLM
  through Ollama (or a connected AI / a web pane) with a FIXED tool registry (direct controls, no free code): book
  status (checklist, steps, events, AI health, problems), ⚡ Make a book for me (the ✔ Do it on his card is the
  consent for that one run), pause/resume/cancel, profile & story choices, character sheets / voice cards, story rules,
  world details, a chapter rewrite with a note (the new version waits for the author's approval), open the book /
  report / scene grid page, make the report, save the book. Read-only tools run directly; anything that changes
  something shows an "I will: …" card first; he never approves drafts or gets around Akọwe's approvals. Every action
  goes to the activity log (codes/titles only) and, for books, to the book journal (🎩 entries). Proactive notices
  (book run paused / needs a decision / finished, an AI broke and was fixed, an image finished). OFF by default
  (🎩 switch). Akọwe side: two small additive endpoints — `POST …/journal/note` (codes/titles only) and an optional
  `note` on `POST …/review/fix`. See `docs/ALFRED.md`.
  - Still open from the original B4 idea: "live changes" mid-run at a safe point (today: pause → change → resume, each
    confirmed), chapter summaries for the user, continuity hints — later, by the user's call.
- [~] **B5** 🗂 Character Forge dossiers — characters DONE 2026-10-26 (`docs/CHARACTER_FORGE.md`): 14-section lettered
  dossiers that reuse the character sheet / voice card / canon record, ✨ Invent the rest as proposals, approvals with
  revisions, portrait + ten views (+ turnaround sheet) through AutoInjector `/image/request` or uploads, the dark
  dossier PDF, letters in chapter prompts, the Moki Vey example. Pictures come from Stable Diffusion **or ChatGPT** (AutoInjector's new ChatGPT image engine draws in its pane; `engine` sd/chatgpt/auto); AutoInjector hands Akọwe the bridge address + token itself; 🎩 Alfred has 5 dossier tools (read, invent the rest, edit, approve, make art). Checked across the two real programs (Akọwe art job → bridge → Stable Diffusion stand-in → book assets → PDF). 🎬 Motion clips DONE 2026-10-27 (with B2): a looping 4 s clip from the portrait via `/video/request`, upload your own, MOTION STUDY still in the PDF, in the book save. Items, places and magic systems DONE 2026-10-27 (lane C,
  `forge_kinds.py`): AR-/PL-/MG- dossiers (8 / 9 / 11 sections, 69-70 lettered fields) with the same proposals,
  approvals, PDF look and art (item portrait + front/side/back/detail turnaround; establishing shot + day/night/interior;
  sigil + in-use scene), "Create dossier" seeded from A04 places / A09 powers / A12 artifacts / the story rules / a
  character's weapon, clickable cross-links between all four kinds (references in the PDFs), the example world (AR-001
  rescue baton, PL-001 Nacre, MG-001 biofilament mutation) and in the book save. 🔎 Check against the book DONE
  (`forge_check.py`, every kind): rule checks (ages, eye/hair colour, height, years, stated limits, who may hold an item,
  near-miss names) + the AI slot (quotes re-checked), findings marked Fix / Fine / Change dossier (a proposal, never a
  write), as a job with progress and Stop. Still open: real ChatGPT/GPU run; motion clips for the other kinds.
  Original idea: Deeper character/item/place/magic-system profiles like
  the ChatGPT 'Character Forge' plugin (sample: Moki Vey dossier): extra sections (detailed appearance, fighting,
  weapons, magic, skills, physical, knowledge, backstory timeline, storyline, continuity), category letters C P V A F
  M K R S E on every entry so scenes only get the letters they need, 'invent the rest' with invented details as
  proposals, illustrated dark/gold PDF per character/item/place/magic system; portrait + ten-view art waits for image
  generation (upload your own meanwhile). Phases: 1 deeper profiles + letters, 2 dossier PDFs, 3 generated art.

- [x] **B6** 🎩 Alfred: the side panel is his home, plus one-button AI setup. DONE 2026-10-27; see `docs/ALFRED.md`.
  - **🤵 Butler section = setup + the log.** At its top:
    - **⚡ Set up Alfred's AI (one button):** hardware → install Ollama (Windows silent installer / macOS / Linux
      app-local, with resume, retries and a disk check) → start → the best recommended model that fits (🔓 prefer
      uncensored) → download with real % progress → use it (Alfred and the Butler) → check (`llm-setup.js`).
    - **🩺 Check everything:** 10 rows, each with a one-click Fix.
    - **🔎 Find a model:** Ollama library + Hugging Face GGUFs (`hf.co/<repo>:<quant>`), rated against this PC's
      graphics card: ★★★ great, ★★ good, ★ slow, ✖ too big. Too-big models can't be downloaded. Has the 🔓
      uncensored filter and ranking, 🛠 tools, an optional HF token (encrypted) and an offline curated list
      (`model-catalog.js`, `llm-hardware.js`).
    - **Personality** (presets + custom; voice only, approvals unchanged) and **saved set-ups** (`alfred-persona-ui.js`).
  - **The side panel = where you talk to him.** (Was a floating window first; see below — now docked only.)
  - **Simplified (2026-10-27, the user's feedback):**
    - His panel is a **side panel again by default**: it moves the app over on every tab, the Video tab included,
      and never covers anything. The separate window is an option in ⚙, and a saved "floating" from the old
      default becomes the side panel.
    - The Butler section is now: the one button and the check at the top; model cards about three to a row;
      personality and saved set-ups stacked in the left half, with ⚙ More settings in the right half; the activity log,
      which now also lists what Alfred and his setup did.
    - The old Butler's goal box, System Check and local-model settings are out of view, replaced by Alfred and the one
      button.
  - **Two Alfred surfaces only (f10-panel, 2026-10-28):** the SETUP panel (🎩 Butler section) and the TALK panel (his
    docked side panel). The separate window is gone (`alfred-window*.js/html` removed; any saved "floating" → docked;
    Ctrl/Cmd+Shift+A still toggles the drawer from every page, AI panes included). The side panel has 8 big buttons
    (🧑 character, 🎨 picture, 🎬 video, 🖼 cover, 📖 my book, ✍ continue / make my book, 🩺 check everything, ❓ everything
    I can do) — small forms first where a detail is needed, plain "Akọwe has no book yet" when there is none — and a
    searchable "❓ Everything I can do" list (`alfred-catalog.js`, IPC `alfred:catalog`, `alfred:books`; "what can you
    do?" opens it). The User Panel's old Butler buttons are Alfred's: → 🎩 Alfred, his status light, 🧠 what he thinks
    with, 🎩 Alfred: On/Off, 🩺 Check Alfred.
    - **Open:** 🧑 Make a character works for characters the book already has (forge_character). Akọwe has no API to
      add a brand-new non-main character, so for a new name Alfred says so plainly — an Akọwe route + tool would close it.
  - Alfred can drive all of it (`llm.*` app controls: status, check, fix, setup-all, search, curated, pull, use, remove…).
  - **Still to try for real:** the installer and the online search have not been run against the live ollama.com /
    huggingface.co, and nothing has been run on a real GPU.

### Other ideas parked from earlier lists (not scheduled)

- [x] Merge Akọwe into the AutoInjector app (one app, one launcher) — DONE 2026-10-25: AutoInjector starts
  Akọwe's server itself (reuses one already running; Python venv made like `run-akowe.bat`; restart on crash;
  clean stop on quit), shows it in its **📖 Akọwe** tab (pop out / back) and pairs it with the bridge by itself.
  `akowe/run-akowe.*` stay for running Akọwe alone. See `desktop-app/README.md` "Akọwe inside AutoInjector".
- Print-ready PDF: embedded fonts, print-on-demand trim sizes, margins/bleed.
- Official EPUB check installed by default (EPUBCheck needs Java).
- Guided first-time tour; notifications when the AI finishes or needs approval; dark mode / larger text.
- Series support: reuse characters and world across books.
- GitHub checks for Akọwe (see Problems).

## Simple top bar and side bar (2026-11, "the toolbar doesn't make any sense to me")

The writer found the top bar a mix of places, actions and developer tools, and asked for a Book Bible button that
makes sense. Done (Group 1, items 1–4 and 6, plus the Book Bible buttons of item 5; the binder's own "At a glance"
page and toolbar are a separate change):

- [x] **Top bar:** `Akọwe · 📚 My books · [book name ▾] · 💾 Save · ⚙️ Settings · ❓ Help · ⋯ More`; outside a book
  `➕ New book` (one entry: ✍ Write it with me = the old wizard, or ⚡ AI writes the whole book = Make a book for me).
  One run chip `#mab-btn`: "⚡ AI working 3/10", "⚡ AI needs you" only when paused, hidden otherwise. ⋯ More grouped
  (This book / Files / Your style / Help). New ❓ Help page (`#/help`).
- [x] **Side bar (simple):** ▶ Next step · 📝 Waiting for your OK (n) · 🏠 Book home · 🧑 Characters & places · 🗺 Plan
  · ✍ Write · 📖 Book Bible (highlighted) · 🖼 Pictures & cover · 🎬 Trailer · 🧭 Fix mistakes · 📤 Export. New small
  section pages `…/people`, `…/plan`, `…/write`, `…/art`, `…/fix`, `…/export` list the existing pages as big buttons.
- [x] **Simple / Advanced view** (`bf:mode` in localStorage, default simple; switch in the side bar and Settings;
  everything with class `adv-only` is hidden in simple view by CSS): A–K sets (names, codes on hover), Branch, Jump,
  Sets, Health, Test workflow, Test everything, Book features, IDs, the old overview's tiles/details/branch form.
  Settings shows "AI connection: ✔ OK". Ctrl+K works in both.
- [x] **Plain names:** Bible Builder → Character & place maker; set A "story bible" → "characters and world";
  Overview removed (`#/p/<pid>/<branch>` opens Book home); Make my book → 🏠 Book home; Rerun from the book bible →
  Make a new book from this one's plan; book-bible.json/.md under ⬇ Download…; Your projects → My books;
  Needs your approval → Waiting for your OK; the book step state "Needs you" → "Your turn"; no "Make a book for me"
  on a book page.
- [x] **📖 Book Bible buttons:** side bar, Book home header (next to ▶ Next step), every book card in My books, and
  the Saved card link.
- [x] **No icon-only buttons** at 1280×720 (the label-hiding CSS is gone; the bar wraps in Advanced view instead).
- Tests: `tests/campaign/ui/test_ui_nav_simple.py`; older UI tests updated (`open_make_book` / `set_mode` helpers).
- *Open:* `binder.js` (owned by the Book Bible change) still says "📘 Make my book" on its not-ready page.

## Story details just in time + "How the story treats the characters" (2026-11)

The writer chose "just in time" (save time and AI messages) over filling ~80 dossier fields per character up front,
and a per-book setting for how strictly the story follows the characters. Done:

- [x] **Before chapter one — essentials only** (⚡ run step "Character looks and voice details", after "Character
  sheets and voices", before "Character pictures"; `akowe/story_details.py`): every approved character gets detailed
  looks (physique with height / weight / build, face, eyes, hair, skin, markings, everyday clothing, posture,
  presence) and speech under fear / anger / grief; main and supporting characters (every story role except minor /
  extra) also "public and private selves" and the Book Bible's 🆕 height, weight, build, handedness (height / weight
  read from the physique so they match); minor characters and extras a short looks set. Places the outline uses get a
  short look and feel and what the place is; items the outline names ("the brass key") their type and one line; magic
  keeps only the core rules the "Story rules and world texture" step sets. Four subjects per AI call. Forge proposals
  (only empty, unprotected fields — never the author's text) approved at once under the run consent; a plain event per
  subject. Character pictures use the detailed looks (forge.art_prompt).
- [x] **During writing — just in time** (before each chapter, where its scene cards and brief are built): a cheap
  deterministic pass over the outline chapter and its scene cards decides what this chapter needs — a fight → the
  fighters' fighting style and primary weapon; magic → the users' power source / effects / costs / limits and ONLY the
  named ability on the book's magic dossier (e.g. "Fog-spell: …"); a skill (lockpicking, sailing, medicine…) →
  practical skills; a keepsake → signature possessions; a place visited for the first time (the chapter's location or
  a scene's place; a new room gets a place dossier of its own) → layout, sounds, smells, light, who is there; an item
  seen / used for the first time → look, condition, holder (+ powers, limits, costs when used). Unclear words
  ("struggle", "power", "glow") become optional fields the AI leaves empty when the chapter does not need them. ONE AI
  call per chapter at most (characters + places + items + magic), never decided twice (ledger
  `story_details:<pid>:<branch>`), logged plainly ("Decided Mara Vell's fighting style and weapon for chapter 2").
  Details the story never needs stay empty (✨ Fill from the book can fill them later).
- [x] **Locked once used:** after a chapter is approved, every dossier part its brief carried (character details,
  `world_details` of places / items / magic, the handedness in a fight) becomes a 🔒 protected field, recorded with the
  chapter; later briefs carry them as `fixed_details` ("must match"). A deterministic check flags chapter text that
  contradicts them (eye / hair colour, the weapon, the weapon hand, an item's metal or colour): a ⚠️ run note, the 🧭
  continuity page's questions, and ✨ Fill from the book asks "the book says X, the sheet says Y — which is right?".
- [x] **AI down / busy / bad answer** → a plain event, the chapter is written anyway, the parts are asked again with
  the next chapter. Pause / cancel / resume safe (no duplicate fills).
- [x] **"How the story treats the characters"** (`akowe/character_mode.py`, stored in the profile's `choices` as
  `characters`): 🧑 Character-led / ⚖ Balanced (default) / 🗺 Plot-led, with plain words and ⓘ on ⚡ Make a book, the
  🚀 wizard and the profile dialog (and a "Characters" row on the profile card). Reaches the premise / plot / outline
  prompts (set_b), the chapter brief (`character_mode` + one rule), the AI reviewer (strict / normal / only big breaks)
  and the AI editor (notes and ±1 minimum score on `character_agency` / `voice_distinction`). Per book; variants,
  reruns from a book bible and 📚 sequels start with the previous book's setting.
- Tests: `tests/test_story_details.py` (fake AI, end to end), `tests/campaign/ui/test_ui_character_mode.py`.
- *Not done:* ✍ Write all chapters (outside a ⚡ run) does not run the just-in-time step yet; contradiction checks
  cover colours, weapons and the weapon hand only (no AI reading); places get no automatic establishing picture.

## Story ledger + continuity checkpoints for long books (2026-11, holes H1 H2 H4 H8 H9 H19 H20 H21)

From `docs/HOLES_2026-11.md` and the wish for 25–50 chapter books. Done (fake AI tests: `tests/test_story_ledger.py`;
the browser: `tests/campaign/ui/test_ui_continuity.py`):

- [x] **📒 Story ledger** (`akowe/story_ledger.py`, setting `story_ledger:<pid>:<branch>`): the continuity tracking
  call (one AI call per approved chapter, as before) also returns the chapter's `story` part — a 2–4 line summary,
  per character injuries (new / healing / healed), `items_gained` / `items_lost` / `carrying` (series.py `CATS`
  names), alive or dead, where they are at the end, lingering magic after-effects; new proper names; story day, date,
  season and time since the last chapter; trips (the travel-time table); who learns / is surprised by a secret;
  one line per relationship; money, prices, distances and counts. Akọwe keeps the last ~1 500 characters of the
  approved text too.
- [x] **H1 handoff:** the next chapter's writer AND its reviewer (and the AI fix) get `previous_chapter_end`,
  `story_so_far` (a few lines per chapter; older chapters one line; a 🧭 checkpoint's summary replaces the chapters it
  covers) and `story_ledger` (the people IN this chapter first). The tracker and the brief choose people by who is in
  the chapter (scene cards, then the text) — the fixed caps (16 names, 8 people, 8 hazards, "cut to 3") are gone;
  when space is short the people not in the chapter go first, then details, then the oldest hazards.
- [x] **H2 / H4 / H8 / H9 / H19 checks** (`story_ledger.check`, after every tracked chapter): limping → running with
  no time to heal, a lost item drawn again, the dead speaking, a near-miss spelling of a known name (forge_check's
  rule) or "Salt Mere" for "Saltmere", a three-day ride arriving next morning, snow then blossom a week later, a day
  number going backwards, someone surprised by a secret they already know, a distance or price that changed. Shown as
  ⚠️ run notes, on the 🧭 Continuity page and in Reports/Continuity.md; fed to the checkpoints.
- [x] **H20:** the editor's rewrites get the same continuity (`editor.propose` → `continuity.review_extra`).
- [x] **H21:** a chapter read while no AI was free keeps Akọwe's keyword reading marked **weak** (a ⚠️ run note, the
  chapter row, the continuity page) and is read again by an AI before the next chapter is tracked and at every
  checkpoint.
- [x] **🧭 Checkpoints** (`akowe/checkpoints.py`, setting `checkpoints:<pid>:<branch>`): every N approved chapters
  (book profile "Check the whole story every N chapters", `checkpoint_every`, default 5, 0 = only at the end), at the
  end of each act when the outline marks acts (`plan.act` / `plan.parent_id`), and a final one that reads the whole
  book. Each reads only its new chapters IN FULL (in parts of ≤ 60 000 characters, a long chapter split at paragraph
  breaks) plus the compact ledger, locked details, earlier summaries and Akọwe's flags; lists every inconsistency with
  a quote and a minimal fix; applies the fix word for word as a new draft of that chapter through the run's normal
  review loop (review, editor, planned check, approval under consent), then tracks it again. Never touches the
  author's own text. Pauses once per checkpoint only for problems it cannot fix safely (▶ Continue goes on). Step
  list: "🧭 Checkpoint after chapter 10: 2 problems fixed, 1 waiting for you" with a link to the report (🧭 Continuity
  page → Checkpoints; GET `/review/continuity/checkpoints`). Pause / resume safe: finished parts are stored at once.
- *Not done:* "Bram" → "Brannock" style renames (not a near-miss spelling) are left to the checkpoint AI;
  ✍ Write all chapters (outside a ⚡ run) does not run checkpoints; the keyword reading is English only.
- [x] **Working with job L2 (checks & approvals), merged 2026-11-04** (`tests/test_merge_l1_l2.py`, 4 tests):
  - *A hand edit (H5):* `continuity.INVALIDATE_HOOKS` now holds `_ledger_hook` and `_checkpoint_hook`. When
    `invalidate_after_chapter` says chapter N changed, the 📒 story ledger entries of chapter N and every later chapter
    are set aside (`story_ledger.invalidate_from`: out of the story so far, the ledger brief and the checks; marked
    `weak_why: "changed"` so `retrack_weak` reads them again; a new reading replaces the entry), and every 🧭 checkpoint
    after N is marked for redo (`checkpoints.invalidate_from`: status `new`, its summary leaves the story so far, the
    old result kept in `redo_of`; the step line says "to be read again (chapter N was changed by hand)"). A
    checkpoint's own fix is noted as the text the book goes on from (`note_written`), so it is never taken for a hand
    edit.
  - *Setups and payoffs at checkpoints (H11):* a checkpoint before the last chapter runs L2's light check
    (`ending_check.check(upto=N, final=False)`, one AI call) when the plan has setups or threads; a setup or thread
    the page already dropped is a 🎯 run note (`CHECKPOINT_SETUPS`) and a line in the checkpoint report. The final
    checkpoint does not: the ONE final ending check is autobook `_ending_pass`.
  - *What was cut (H13):* the continuity part of the brief (`continuity.section`) and the story ledger brief
    (`story_ledger.brief`, `story_so_far`) say what they trimmed through `brief_cuts.note` ("continuity — tracked state
    of characters not in this chapter: …", "story ledger — travel times: …"); it joins the chapter brief's `cut`
    list, so the run's ⚠️ "the instructions were too long" and the chapter page list it.

## 🔢 Book Bible code map + 📖 "Fill the whole Book Bible" (2026-11, the author's design) — done

- **Code map** (`akowe/code_map.py`, the one source of truth): code = KIND letter + SECTION digit (0–9) + FIELD letter
  (`C1c` = a character's eyes); a whole section is its digit doubled (`C11` = all of Looks). Kinds B C P M I G S H W N
  (N = running notes, mapped onto `story_ledger`'s real categories). 79 sections, 558 field codes; every one of the
  480 binder field ids, every Forge field (characters + items / places / magic) and every Book Bible 🆕 value maps to
  exactly one code (`audit()`, tested). `resolve` / `codes_for` / `expand` / `parse` / `format_code` translate binder
  numbers (`5.2.8`), Forge keys (`character:eyes`), ledger categories and the old Forge letters (C P V A F M K R S E).
  Generated: `docs/CODE_MAP.md` and `akowe/web/code-map.js` (`python -m akowe.code_map --write`; a test keeps them in
  sync). Visible: Book Bible ⋯ View options → **Show codes** (each detail and section head), ❓ Help → **🔢 Code map**
  (searchable table, ⬇ Markdown, 🖨 Print), `GET …/binder/codes[?format=md]`. Checks now name the code next to the
  plain words: locked-detail contradictions ("Chapter 9: Mara Vell C1c (eyes) doesn't match — …"), Fill-from-the-book
  questions, story-ledger flags (`(N3a)` …). Not done: the code map as an appendix of the Book Bible PDF (optional).
- **Fill the whole Book Bible** (`akowe/whole_bible.py`, reuses the Forge proposals, `binder_fields` and the
  story-details ledger — no new storage): ⚡ Make a book switch "Fill the whole Book Bible before writing" (run setting
  `fill_bible`, off by default = just in time; step `bible` after the outline, before chapter one; answers approved
  under the run consent; pause/cancel between calls; a resume never re-asks) and the 📖 At a glance button "📖 Fill in
  the whole Book Bible" (`POST …/binder/fill_all`, a job with progress and Stop; answers are proposals that wait for
  the author's ✔; says "N sections filled, M still empty (why)"). Batched by code-map section: ≤ 24 fields of a record
  and ≤ 36 fields per AI call; a second round fills what the first made possible (new relationship rows). Never
  touches text, 🔒 protected fields, read-only mirrors or the author's record fields (supplied canon, record controls …).

## 🧠 Smart memory with chapter needs lists (2026-11, the author's design) — done

- **The planner writes it** (`akowe/needs_list.py`, `scenes.py make`): the scene-plan answer also carries `needs` —
  per named thing {thing, kind, sections: whole-section codes like `C11`, `C55(Tom)`, note}, `earlier` [{chapter,
  moment}] and `notes` (ledger codes `N11(Mara)` …). The planner is given the code sections, the book's place / item /
  magic names, the earlier chapters' summaries and what earlier chapters used without planning it. `clean` validates:
  single-field codes are upgraded to their section, unknown / wrong-kind codes and characters the book lacks are
  dropped — each with a plain note. Stored in the scene-card entry (`entry["needs"]`, kept across the author's edits for
  the same outline revision). Shown as a line with hoverable / expandable codes on the chapter page (✅ Planned to page)
  and the Book Bible chapter page (`web/needs-list.js`).
- **The writer gets exactly that** (`chapter_brief.build`): `needed_details` (accepted values of every field of each
  listed section, each labelled with its code; 🔒 used codes marked `fixed`), `earlier_moments` (the best-matching
  sentences of the named earlier chapters, ≤ 420 chars each), only the asked ledger parts — instead of the guessed
  `character_details` / `world_details` / `fixed_details`, the whole ledger and the world texture (only with `W55`).
  Always on: voice cards, scene cards, POV, story so far + previous chapter end, story rules, book profile, length.
  An empty listed section is filled just in time, exactly that section, once (`jit_subjects` → story_details).
  Without a needs list (older books / plans): the keyword guessing, unchanged.
- **Learning and checks:** after each chapter the text is compared with its list ("🧠 Chapter 1 also used Tom Reed (not
  planned)", event `NEEDS_UNPLANNED`, kept per chapter, fed to the next scene plans, listed by the checkpoint report).
  The chapter reviewer (`needs_list` + `needs_note`) and the checkpoints (`needs_lists`, `CHECK_NOTE`) get the lists;
  Akọwe's own check names the single-field code on a mismatch ("Mara Vell C1c (eyes) doesn't match …").
- **Measured:** every chapter's brief is also built the old way (`measure=True`), stored in c_meta → run chapter row
  ("🧠 needs list: N% smaller instructions"), `needs_list:<pid>:<branch>` and ⏱ Time and AI use ("🧠 Smart memory saved
  ~N% of instruction size", per chapter). Fake-AI sample (novelette, 6 chapters): ~10% smaller with the just-in-time
  Bible (66 178 vs 73 705 characters), ~20% with the whole Book Bible filled (68 649 vs 85 507) — the always-on
  parts (rules, voice cards, scene cards) are most of a brief.
- *Not done:* group (G), world (W, except W55) and book (B/S/H) sections are accepted and shown but add nothing beyond
  the always-on parts; the mismatch check covers eye and hair colour only (the AI checks the rest); the passage search
  is word overlap (English).

## 📐 Story structure templates ("story shape", 2026-11) — done

- **The choice** (`akowe/story_shape.py`): None — let the AI decide (default), Three acts, Save the Cat (15 beats),
  Hero's Journey (12 stages), Seven-point. Each template is data: beat id, plain name, plain description, where it
  usually falls (% of the book). Stored with the ending and style choices (`choices.shape`), so it is picked on ⚡ Make
  a book, the 🚀 wizard and the profile; changed on the plan page (outline step, `set_story_shape`) until a chapter is
  written.
- **Outline:** the B11 planner gets `story_shape` (each beat with its `around_chapter`) and a rule; in a ⚡ run, once
  the outline is approved, one AI call places each beat on a chapter with one sentence of how (`place`). `validate`
  places a beat left out, placed twice, on an unknown chapter, before an earlier beat or far from where it belongs by
  its position instead. Stored per outline revision (`story_shape:<pid>:<branch>`); without a stored placement (outline
  made outside a run, shape changed) the beats are placed by position.
- **Shown** as a strip ("Ch 22 · Dark night of the soul", ✔ / ⚠ once written) on the plan page and the Book Bible's
  story-plan page (S2 Plot line).
- **Checked with the existing machinery:** scene planner + scene checker and the writer brief (`story_beats`, "this
  chapter must deliver the story beat …"), the chapter reviewer (`story_beats` + note), the planned-to-page check
  (kind `story_beat`, required, top priority → its one targeted fix), the checkpoints and the final ending check
  (report + ONE targeted fix via `fix_beats` when the planned-to-page check had not already tried one; the author's own
  text is never changed). ✍ Write all chapters gets the beats in the scene cards and the writer brief (placed by
  position). Books without a shape: unchanged.
- *Not done:* the AI placement runs only inside a ⚡ run (outside, beats are placed by position); a beat's
  "landed" check is the planned-to-page check (word reading + the independent AI), not a structural analysis.

## ✍ Write alongside me (2026-11, the author's request) — done

- **What the author does** (chapter page → ✏️ Change it, or ✍ Write alongside me): highlight a passage in the chapter
  text (or put the cursor) and press ✍ Continue from here · 🔁 Rewrite (with an optional note, e.g. "more tense") ·
  🎨 Describe more · ➕ Expand · ✂ Tighten. "Which AI": Auto asks the chapter's writer first (a soft preference; another
  working AI answers when it is not working), or a chosen AI-1/2/3. Without a highlighted passage only ✍ Continue works;
  the others say in plain words "Highlight the passage first".
- **The focused brief** (`akowe/alongside.py brief`): the passage, ≤ 3 000 characters before and ≤ 1 500 after it, the
  chapter's place in the plan (`editor.chapter_info`), and the passage-relevant parts of `chapter_brief.build` (scene
  cards, the 🧠 needs list and its `needed_details` / `earlier_moments`, voice cards of the characters named around the
  passage plus the narrator, 🔒 `fixed_details`, running notes / tracked state, story rules, the author's choices and
  style), the book profile with the promises (point of view, tense, content limits; `book_promises.instruction`) and
  the protected facts. Whole-chapter parts (length, story so far, must-show, the scene-by-scene rule) are left out.
- **The AI call** is a review job (`ReviewService._start` → `AssistService._call_ai`): busy is waited for, a site error
  moves to another working AI, a timeout stops with a plain error and 🔁 Try again (never retried by itself).
  Routes: POST `…/review/alongside` {record_id, action, text?, start, end, note?, slot_id?} → 202 job (poll
  `…/review/ai/<job>`); the answer `{text, why}` is cleaned (fences, quotes, repeated text) and is only a suggestion.
- **The suggestion** shows the author's text next to the new one (word-level changes marked, `alongside.diff`) with
  ✔ Use this / 🔁 Try again / ✖ Discard, plus Akọwe's quick checks ⚠️ (`alongside.checks`, no AI): a slip into the
  first person or the present tense (or out of the book's first person / present tense), and a locked detail said
  otherwise (`story_details.contradictions`, `needs_list.mismatches`: "Mara: the suggestion says “blue eyes”…").
- **✔ Use this** (POST `…/review/alongside/use`): the chapter as it is in the editor, with the suggestion in place (the
  passage is found again if the author typed elsewhere meanwhile; the words before the cursor for ✍ Continue), saved
  as a NEW DRAFT through the normal UPDATE path — the same as a hand edit: an approved chapter stays in the book until
  the new version is approved, and approving it runs the H5 hand-edit follow-through (`continuity.check_edits`: later
  chapters flagged "check chapter N", running notes read again). Noted in `ai_fixes` (made by "Written alongside you
  by …"); activity event `alongside.used` (numbers only). A suggestion for an older version is refused (VERSION_CONFLICT).
- **Tests:** `tests/test_alongside.py` (13: request checks, brief, joining / diff, job + use + H5 flags, busy, site
  error, timeout, refusals, ⚠️ checks) and `tests/campaign/ui/test_ui_alongside.py` (2: the whole flow in the browser,
  and a phone-width screen). The fake AI answers `akowe_task: write_alongside` (`autobook_fake._alongside`,
  `alongside_script`).
- *Not done:* only in the chapter editor (the reading view's ✍ button opens it); the quick checks cover point of view,
  tense and the colour / weapon / hand locked details only (content limits are left to the reviewer when the new
  version is reviewed); the suggestion is not streamed (it arrives whole).

## 🗳 Three-AI writers' room (2026-11, idea #13) — done

- **Where:** a 🗳 Writers' room button on 🏠 Book home (choose: a twist in the main plot, how a chapter ends or what
  goes wrong, a character's secret or arc turn, or your own question), on a chapter's 🎬 Scene cards page (that
  chapter) and on the record page of the premise / main plot / outline / a character (`web/writers-room.js`).
- **Brief** (`writers_room.brief`): the book profile with content limits, themes, question, POV/tense and style choices
  (`book_profile_brief`), the character mode, the story rules (`story_rules.plan_brief`), premise, main plot, chapter
  list and cast with sheets; for a chapter its plan, neighbours, scene cards and parts of `chapter_brief.build`; for a
  character the whole entry and sheet. Bounded (~14 000 characters).
- **Round 1:** each working AI pitches once, all at the same time (one request per AI): title, 2–4 sentence idea, why
  it fits, what it changes later. Busy answers wait and retry; a timeout or failure is shown per AI and the room goes
  on with what came back. **Round 2:** pitches are shuffled and labelled A/B/C; each AI ranks only the OTHER pitches
  with a one-line reason (its own is left off its ballot). **Tally:** most first places; tie → sum of ranks (unranked =
  last, averaged when a vote is missing); still tied → the author chooses. Results show every pitch, who wrote it,
  every rank and reason, and the winner: ✔ Use the winner / ✔ Use this one / 🔁 Another round (new ideas only).
- **Using a pitch** writes it into the record as a NEW DRAFT version marked "From the writers' room" (plot summary,
  premise concept, that chapter's outline summary, the character's background); the approved version stays until the
  author approves the new one. A free question is noted only, or written into the main plot when ticked.
- **Fewer than two working AIs:** said plainly, with 💡 Brainstorm with one AI (three ideas, no vote).
- **⚡ Make a book** setting "Use the writers' room for the big twists" (`writers_room`, off by default): a room before
  the main plot (the winner goes into the plot's request as a constraint) and before the midpoint and climax chapters
  (the winner reaches the scene planner and the writer's brief, `chapter_decision`). The run's consent picks the winner
  (a tie: the earliest letter), each room is a journal line (`WRITERS_ROOM`); a failed room never holds up the book.
- Stored in `writers_room:<pid>:<branch>` (last 20 rooms). Tests: `tests/test_writers_room.py`,
  `tests/campaign/ui/test_ui_writers_room.py`.
- *Not done:* using a pitch appends it to the record's text; it does not rewrite the plot around it (approve, then ask
  the AI to revise if wanted). Two panes of the same website count as two AIs in the room.

## 👥 Idea #14 Panel of beta readers (2026-11) — done

- **Up to three readers** (`akowe/beta_reader.py`, extends 📖 P23): 1 reader = the single read, stored exactly as before
  (plus the new verdict). 2–3 readers = a panel record (`kind: "panel"`) in the same `beta_reads:<pid>:<branch>` key.
  Default readers from the book profile (`personas`): a typical fan of the genre and age group (= the old persona), a
  picky experienced reader of the genre, a casual reader who gives up on slow starts. The author can rewrite each
  description and pick the AI per reader on the 📊 report page (kept per book in `beta_panel:<pid>`).
- **Each reader a different AI** (`assign`): the author's picks, then working independent AIs, then the writer's AI
  (⚠️ not independent). An AI that is not working, or that fails (site error / timeout / busy too long — assist's usual
  handling, pinned to that AI), is skipped with a note (`skipped`, run event `BETA_SKIPPED`); the others still read.
- **Same marks, plus a verdict:** every reader returns the P23 marks (quotes checked against the book and the
  chapter) and `overall`: would recommend, favourite character (checked against the book), best / worst chapter, a
  1–10 score; "would finish" comes from `stop`. An older read without a verdict still shows.
- **Comparison without AI** (`compare`): strong signals (2–3 readers flag the same chapter for the same thing — lost,
  bored, twist guessed, didn't believe, would stop, worst chapter; "at the same moment" when their quotes overlap),
  disagreements (one liked a chapter another disliked; scores 3+ apart; recommend / finish split), a per-chapter heat
  map of lost / bored readers with each reader's interest, every reader's verdict and the consensus top-5 fixes.
- **Where:** the 📖 Beta readers card on the 📊 report page (how many readers, AI and description per reader, the
  panel page: headline, verdict table, agree / disagree, heat map, what to fix first, each reader's own read); the book
  report's Markdown / PDF and the saved book get a "Beta readers" section (`with_beta` / `report_markdown`).
  ⚡ Make a book: "How many" next to 📖 Beta reader (run setting `beta_readers`, 1 by default = as before).
- **Long books and resuming:** the same bounded book view as before (whole, or the per-chapter digest); readers read
  one after another; the panel is saved after each reader (`incomplete`) and continues with the readers still to read
  (a paused run continues its own panel; the report page shows ▶ Continue the panel).
- *Not done:* readers do not run in parallel; the "same moment" check is word overlap (English); the panel shares the
  single reader's one-call budget per reader (no per-part reading of very long books).

## 🚀 Launch kit (2026-11, idea #16) — done

- **What it is:** a 🚀 Launch kit page per book (`#/p/<pid>/<b>/launch`; 📤 Export → 🚀 Launch kit) with everything
  to list the book on Amazon KDP or another store: back-cover blurb (~150 words) and store description (~300), a
  one-line hook, the author bio (from the pen name; the AI leaves `[brackets]` for facts only the author knows), 7 KDP
  keyword phrases, 3 categories, comparable titles ("for readers of…", always labelled *suggestions to verify*), the
  age range and content notes (from the profile's audience and content limits, no AI) and an A+ content plan (3–5
  modules: headline, text, and which of the book's own pictures to use — the cover, a portrait, the map or a chosen
  chapter picture). Code: `akowe/launch_kit.py`, `web/launch.js`.
- **Versions and approval:** every AI answer and every edit is a new version (a draft) per field
  (`launch_kit:<pid>:<branch>`); only the author approves (✔), ↩ un-approves, or brings back an older version.
- **Cross-check, no AI first** (every page load): names in the blurbs, hook and A+ texts must be in the canon or the
  book ("Captain Varrow" is flagged even though "captain" is a word in the book); numbers the book never uses; claims
  ("bestselling", "award-winning", "#1"); spoilers past the chosen point (default the midpoint; or first act, none):
  a canon name first met after it, a sentence built from the secret chapters' plan / prose or a protected mystery,
  twist words beside a canon name; KDP keyword rules (7 boxes, ≤ 50 characters, no "bestseller"/"free"/"new"/
  "Kindle Unlimited", other authors incl. the comps' authors, trademarks, repeats, the title/pen name); text lengths;
  categories for the right readers (FICTION / YOUNG ADULT FICTION / JUVENILE FICTION). Each ⚠️ has a plain fix.
  **🔎 Check with AI** then reads the listing against the canon and the plan, with the part after the spoiler point
  marked secret (quotes checked against the field; out of date once the kit changes). **🔁 Fix with AI** regenerates a
  field with its problems in the request. The generator never sees the plan after the spoiler point.
- **Export:** the 💾 book save writes `Launch kit/` (launch-kit.md, one .txt per field, A+ module SVGs); ⬇
  launch-kit.md on the page; 📋 Copy per field; 📕 Use on the back cover puts a blurb / the bio into the profile
  (the 🎨 Cover page's back cover).
- *Honest limits:* categories are Akọwe's own small BISAC-style list per genre, not Amazon's live list; comparable
  titles cannot be looked up (the author must check them); the A+ module pictures are simple compositions (the
  picture + the text on a dark panel, SVG made by Akọwe; JPG only when AutoInjector is running to draw it) — a
  starting point, not finished designs; the spoiler check is word-based (English) — the AI check is the deeper one.
- Tests: `tests/test_launch_kit.py` (rules, lengths, canon, spoilers, fake-AI generation, fix, AI check, export),
  `tests/campaign/ui/test_ui_launch_kit.py`, stand-in AI `tests/launch_fake.py`.

## ✨ #20 Originality and "sounds like AI" check (2026-11) — done

- **Akọwe's own check, no AI** (`akowe/originality.py` + the editable list `akowe/ai_tells.json`): extends the P6
  pattern checker (reuses its paragraph / sentence / dialogue helpers; borrows its lists-of-three, abstract
  paragraph-ending and "Not X. Not Y." counts instead of counting them twice) with ~120 AI-tell phrases ("a testament
  to", "tapestry", "delve", "the weight of her …", "couldn't help but", "a symphony of", "little did they know", "a
  breath she didn't know she was holding" …), ~100 clichés, long dashes (—), "It wasn't X. It was Y.", hedging
  (perhaps, somehow, as if …) and paragraphs that open with the narrator's question. Rates per 1 000 words of
  narration against thresholds in the JSON; dialogue is left out unless asked ("Count dialogue too"). Each finding:
  chapter, paragraph, an exact quote, a plain reason and advice; each chapter a 0–100 score and a plain rating.
  Deterministic, ~20 ms per 5 000 words plus the pattern check's own time.
- **Optional AI pass:** an AI that did not write those chapters rates the flagged paragraphs plus one sample per
  chapter 1–5 for "sounds machine-written", with reasons, the machine-sounding words and a suggested rewrite. Every
  quote is checked against the book and its chapter (beta_reader.py's way); unverified ones are shown but not counted.
  Stored as advice in `originality:<pid>:<branch>` (newest 5). API: `GET/POST …/originality`, `GET …/originality/job/<id>`.
- **Wired in:** the editor gets the chapter's AI-sounding passages (`context.ai_sounding`, prose_variety question), so
  its findings and the writer's targeted rewrites go after them; a rewrite is kept only if nothing got worse — and now
  also only if it does not add AI-sounding phrases or clichés (`judge_rewrite`, code `MORE_AI_SOUNDING`). The 📊 book
  report has a one-line summary (and a Markdown section); the report page has the ✨ Originality check card
  (`web/originality.js`): per-chapter scores, the findings, the counts and the AI pass. A ⚡ run notes the line after
  the report. Never blocks the book.
- *Not done:* the AI pass is a button only (not a ⚡ run step); the lists are English; "triplet adjectives" use the
  pattern checker's general lists of three (no part-of-speech tagging).

## 📣 Mockups & ads (2026-11, idea #17) — done

- **Where:** the 📣 Mockups & ads page (`#/p/<pid>/<b>/marketing`, `web/marketing.js`), reached from 🎨 Cover and the
  book home; everything is made from the book's 🎨 cover (the print wrap too when the page count is known, so the
  spine and back are the real ones).
- **3D mockups** (`akowe/marketing.py`, pure-Python SVG): paperback, hardcover, a stack and a series shelf, posed in
  3D through a pin-hole camera; each textured face is cut into small affine cells refined until they are within
  `MAX_CELL_ERROR_PX` of true perspective, with light, a gloss band, page edges and a floor shadow. **Flat mockups:**
  phone, tablet and e-reader (greyscale). Each comes see-through (PNG) and on a background (JPG in the cover's colours).
- **Ads at the stores' exact sizes** (`ADS`): Instagram / Facebook post 1080 × 1080, Story / Reel 1080 × 1920,
  Facebook / X link post 1200 × 628 and the Amazon Ads custom image 1200 × 1200 (no added words, Amazon's rule). The
  hook comes from the 🚀 launch kit, else the cover's tagline, else the one-line idea (or the author types one), plus a
  call to action; text is measured with the cover's font metrics and kept inside each format's text-safe area.
- **Teaser clips** (`CLIPS`, 13 s, tall 1080 × 1920 and square 1080 × 1080): four frames (mockup, hook, cover, end
  card) joined by AutoInjector's trailer maker (`POST /video/trailer` with `still` items: slow zoom / pan; WebM, plus
  MP4 when ffmpeg is found). Optionally the cover is brought to life by 🎬 Video as one shot; when that cannot be done
  the clip uses the still cover and says so. Desktop side: `render-image.js`, `video-trailer.js`,
  `trailer-recorder-page.js` (still items).
- **Pixels** are drawn by AutoInjector (`POST /render/image`); without it every piece still downloads as SVG.
- **Out of date:** each file keeps fingerprints of the cover, the words and `LAYOUT_VERSION`; a changed cover or hook
  marks it out of date with the reason, and 🖼 Make the pictures again makes it new.
- Stored in `marketing:<pid>:<branch>`; the book save writes `Marketing/` (the files and `marketing.json`). API under
  `…/marketing` (GET/PUT settings, `svg/<piece>`, `file/<piece>`, `zip`, POST `make`, POST `clips`, `jobs/<id>`).
- Tests: `tests/test_marketing.py`, `tests/campaign/ui/test_ui_marketing.py`, desktop
  `test/video-trailer.test.js` and `test/service-bridge.test.js`.
- *Not done:* the pictures and clips need AutoInjector running (SVG only without it); the store ad rules are as of
  2026-11 (check the stores' current rules before you pay for an ad).

## Back burner (maybe never)

The author's call on the rest of the 20-idea list: "way back burner, maybe never". Don't start these until asked:

- **8** Talk to your characters
- **10** Writing goals / sprints
- **12** Screenplay / comic version
- **15** Audiobook with voices
- **18** Illustrated editions
- **19** Series wiki
## 🎨 Interior themes and print preview (2026-11, "as polished as Vellum or Atticus") — done

- **Themes** (`akowe/exporters/interior.py`): 8 — one per Book Bible look (classic, fantasy, scifi, noir, romance,
  horror, playful) + `plain`. Book profile `interior_theme` ("" = the genre's look via `binder.look_for_genre`),
  `trim_size` (5x8, 5.25x8, 5.5x8.5, 6x9 default, a5) and `interior_font` (times / helvetica; "" = the theme's).
  Each theme: body + heading font (base-14; letters they lack still go to the bundled DejaVu Serif), chapter number
  style (words / digits / roman / padded / in a circle), title case and size, a rule or ornament, a 2–4 line drop
  cap, small capitals on the first words (also after scene breaks), a scene-break ornament, running headers
  (author/title or title/chapter), page number centre or outer, chapters on a right-hand page (classic, fantasy).
- **PDF** (`paginate(..., interior=spec)` → `paginate_themed`): openers lower on the page, no header or page number
  on openers / blank pages / the title page, mirrored margins (inner = the print-on-demand gutter for the page count
  + 0.25 in; G04 re-paginates until the gutter class is stable), widow/orphan control (never one line alone at a page
  foot or head when the paragraph can move). Ornaments are vector shapes (`poly`/`circle`/`line` ops), never text.
  Spaced capitals use `Tc`; small capitals, UPPER titles and the "CHAPTER SEVEN" heading carry the words as written
  in `/ActualText` (pdfium reads "Chapter 7: Title" and "The night…" exactly), so the text checks see nothing lost or
  extra.
- **Where it is stored:** G04 reads the book profile and keeps the whole spec + margins in its `G04.layout` state, so
  G07 and G11–G13 reproduce the same pages (no contract change). A new trim size makes the book format again
  (`format_out_of_date`); a new theme/font asks to put the book together again (`assembly_out_of_date`). A book
  without a profile (raw engine use, old tests) keeps the plain manuscript layout.
- **EPUB:** `h1.chapter-head` (number + title spans), `p.opening::first-letter` drop cap, `::first-line` small caps,
  `div.scene-break::before` ornament (generated content). **Word (best effort):** theme fonts, the heading as written in
  the theme's look, a real Word drop cap (framePr), small-caps runs, the ornament glyph, a section per chapter (odd page when
  the theme says so) with no header/number on its first page (title / author headers, PAGE field), mirrored margins.
- **Preview** (`book_design.py`, `GET/PUT …/interior`; 🎨 box in Book home → Book format): chapter-opener spread +
  normal spread. Pictures of the real PDF pages when pypdfium2 is installed, else SVG drawn from the same layout
  ops — the note says which. Uses the book's first chapter when it has one, else a sample.
- *Not done:* hyphenation and kerning; true small-caps fonts (scaled capitals instead); Word widow control is Word's
  own; ornaments in the EPUB/Word files are glyphs (◆ ♥ ⁂ …) that depend on the reader's fonts; the preview's
  browser-drawn letters can differ slightly from the PDF; books put together before this change keep their old
  plain layout until they are put together again.

## Prevention pass (2026-10-27, "solve problems before they become problems")

- [x] **Alfred's local AI connection:**
  - It talks to Ollama through Ollama's own `/api/chat`, with a context window sized to the request (8k–32k).
    Alfred's tool list is about 10k tokens, and Ollama's default of 2–4k silently cut it off; that was the likely cause
    of the "BAD_ARGS" errors in the user's log.
  - qwen3 gets `/no_think`, and `<think>` text is removed.
  - A local model gets a timeout of at least 5 minutes.
  - The app's own Ollama runs with a 16k context, keeps the model loaded for 30 minutes, and uses flash attention plus
    an 8-bit cache.
  - A wrong tool call is answered with the right shape.
- [x] **Safe Stable Diffusion requests** (`sd-sanitize.js`), for every caller:
  - Names (sampler, scheduler, checkpoint, VAE, LoRA, upscaler) are matched to the SD app's own lists, unknown ones are
    replaced with a note, and numbers are clamped.
  - It retries once: with the basics after an unexplained 500, smaller after out-of-memory, and with Automatic VAE
    (not in the Images tab, which keeps its button).
- [x] **🩺 Health watch** (`health-watch.js`): warns before things break — Alfred's Ollama or model missing, low disk
  (under 15 GB / 5 GB), Stable Diffusion or Akọwe down, a pane that self-repair gave up on, a huge logs folder.
  - Each warning has a one-click fix and is shown at most once an hour, with an "✔ … again" line when it clears.
  - It shows in Alfred's notices, the Butler activity log and the app log.
  - Alfred has `health.status` and `health.fix`.
- [x] **Weekly live check** (`scripts/live-check.js` + `.github/workflows/live-sites.yml`): every Monday GitHub checks
  the outside sites the app needs and opens an issue if one changed. That covers:
  - the Ollama and Hugging Face search;
  - the Ollama, ComfyUI and model download links (with exact sizes for the video models);
  - the voice files and setup pages.
- [x] **Packaging guard:** `sd-errors.js`, `diagnostics.js` and `log-extract.js` were missing from the installer's file
  list, so an installed copy would have crashed when it reached them. They are added, and `test/build-files.test.js`
  now fails whenever a file the app loads isn't shipped.

- [x] **No downloading twice** (2026-10-27, the user's request):
  - **▶ Start Alfred** uses only what is downloaded: it starts Ollama (on the folder that has the models), picks his
    model or your best one, loads it, and turns him on with his panel. There is an optional "Start him when the app
    opens".
  - **🔍 Find what's installed** looks for Ollama, the running servers' models, the model folders and other apps'
    `.gguf` files, with Use / Use this folder / ➕ Add to Ollama buttons (`ollama create` from the file).
  - **⚡ Set up** keeps ANY capable model you already have, including slow-fit ones and ones not on its list, and the
    app's Ollama starts on Ollama's usual folder when that's where your models are.
  - The model finder is folded, and the activity log sits under ⚙ More settings, so the Butler section is about
    690 px tall instead of about 1,700.

- [x] **One tidy folder system + a new copy keeps your downloads** (2026-10-27, from the user's log: a new clone in
  another folder started with an empty "stuff and thing" and everything was downloaded again).
  - Where "stuff and thing" lives is remembered outside the app folder (`content-home.js`, userData/content-home.json).
    A new copy that is still empty uses an earlier copy's folder by itself. If both copies have things, 🩺 offers "Use
    that folder" (the app restarts), and you can choose "Keep this one".
  - Everything the app installs or downloads now lives inside "stuff and thing" (`folders.js`):
    - `apps/comfyui` (ComfyUI with its picture and video models);
    - `apps/ollama`;
    - `downloads/` (installers and unfinished downloads);
    - `models/`;
    - your creations.

    A ComfyUI installed before keeps working in `%LOCALAPPDATA%\AutoInjector\comfyui` until you press
    **📦 Move ComfyUI into "stuff and thing"**. Very long paths on Windows keep the short place.
  - **📁 Where everything is** (⚙ More settings → Downloads & creations) lists every place with Open buttons. Alfred
    has `folders.map`, `folders.open`, `folders.move_comfy`, `content.roots` and `content.use_root`.
- [x] **ComfyUI crashing on start** (0xC0000005 ×4 in the user's log):
  - The crash and the last lines ComfyUI printed are now recorded and explained in plain words.
  - After the second crash it restarts once with `--disable-cuda-malloc`.
  - It offers "Start on the processor" and "Use the other ComfyUI build" (shares the models).
  - Pressing Start while it is already starting does nothing extra; Start during the install starts it when the
    install finishes.
- [x] **Downloads ride out network drops** (the 18 GB video model failed with ECONNRESET after an hour):
  - One shared downloader with automatic Range-resume retries, up to 8 tries over about 10 minutes, with the count
    reset whenever bytes arrive. After that there is a "↻ Resume download" button.
  - The `.part` file is kept and the size and SHA checks still run.
  - Double presses are ignored.
- [x] **Forgiving `generate_video`:** a picture plus a character uses the picture; seconds are clamped; junk values are
  dropped with notes; and the errors that remain name the field and the allowed values.
- [x] **One way to make pictures and clips (F10 old panels):** the old Image Generation / Video Generation panels in
  the AutoInjector tab are gone. The User Panel's **🎨 Images** / **🎬 Video** buttons open those tabs. What only the
  old panels had (common addresses, 🔍 auto-detect, ✓ check, on/off, the other video server's clip settings) is in
  **🎨 Images → ⚙ Start & install → Advanced: another server** and **🎬 Video → ⚙ Setup & models → Advanced: other
  video server**. The `image:*`, `video:*` and `endpoints:*` channels are unchanged (Alfred, the butler and Akọwe's
  bridge use them). The Setup Wizard's own Images / Video tabs are now short notes whose button closes the wizard and shows
  that tab (`wizard:open-app-tab` {tab} → `app-tab-show`; Alfred: `wizard.open_app_tab`).

## Problems to come back to

- **Video on the user's PC (RTX 5070 Ti 16 GB) — status 2026-11-03:** four real-PC rounds so far.
  1. Stuck at "starting PyTorch": a Windows stdin lock-up in the runner. **Fixed** (#101); PyTorch now starts in about 3 s.
  2. `OfflineModeIsEnabled` on the FramePack model: diffusers asked the Hub about a sharded model. **Fixed** (#103); models load from their local folders, and loading takes 14 s.
  3. xFormers has no kernel for compute capability 12.0. **Fixed** (#104): kernels that can't run are turned off, so PyTorch's own attention is used.
  4. **Open:** confirm on the PC that the first clip, picture → video, text → video, saving and the trailer work. Use the one-press 🩺 Test pictures & video (Full) and `docs/PC_MEDIA_TEST_PROMPT.md` (#105).
- **Main character guarantee (#105):** ten ways a book could lose its main character are fixed, and a guarantee step runs before the chapters and before "done". Known limits:
  - names in an idea written in Chinese or Japanese are not detected (the Bible Builder decides);
  - an outline the author approved without the main character pauses rather than being rewritten;
  - any POV id the AI invents becomes a real, reviewed character.
- **Alfred model ratings (#105):** ★★★ Excellent / ★★ Good / ★ OK / 🐢 Slow / ✖ Too big, with estimated or measured speed and a verdict. Mixture-of-experts models are estimated too slow.
- **Still to do:** the 360° and 1080 sweep of the whole program on the merged build, with fixes.


- **Refinement from the user's 2026-10-25 evening log (FIXED, 2026-10-26)**, one update:
  1. **🎩 Alfred:** "Test my AI" said OK while the model wasn't installed, so every question failed with HTTP 404. It now checks the model, lists the installed ones with **Use …** buttons, and warns about tiny models. Small-model argument slips are forgiven.
  2. **🎨 Images:** after a broken VAE was picked, every Generate failed with a bare HTTP 500 (about 15 clicks).
     - Failures are now explained in plain words (`sd-errors.js`) with a one-click "Use Automatic VAE and retry".
     - Unusable VAE files are flagged in the dropdown.
     - A repeat guard asks before trying the same failure again.
  3. **Old Butler:** it looped 20 turns retrying the same broken image and ignored Claude's decline three times.
     - The same failure twice stops the task.
     - A decline is final.
     - The same invalid step 3 times, or 4 turns without progress, stops it.
     - It warns about tiny models.
     - Prompts in log events are capped at 60 characters.
  4. **Reply capture:** page clutter is removed: "ChatGPT said:", "Claude responded:", "just now", Claude's thinking summary, and Gemini's code labels.
  5. **Gemini self-test:** it no longer fails when Gemini runs code.
  6. **Voice:** a damaged voice file is detected, with a one-click re-download. Partial downloads are no longer kept.
  7. **Log export:** "Everything" needs a second confirmation that says what it includes, and Alfred can never "always allow" it.

- **Stable Diffusion (B1) — used on the user's PC (Forge; see the 2026-10-25 evening log above), the rest not yet tried for real:** at first everything was tested against fake Forge/ComfyUI
  servers, fake processes and a fake download server. Still to try on the PC: Stability Matrix package
  start (venv + launch options + `--api`), ComfyUI portable install/extract (needs 7-Zip or a .7z-capable Windows
  `tar`), Flux/SD3 UNet-only models (not supported by the built-in ComfyUI graph). See
  `desktop-app/STABLE_DIFFUSION_PLAN.md` → "Problems / limits".

- **First real book (2026-10-25, "The Lamplighter's Last Ferry") — ChatGPT's answers lost (FIXED):** ChatGPT answered with
  UNFENCED JSON; the chat page rendered it as Markdown, which strips the backslash from every `\"` in text, so quoted
  dialogue became `""Say my name…""` and every ChatGPT editor / whole-book review answer was refused — the P36 editor
  never ran ("The editor did not read these chapter versions") and the report showed ChatGPT INTERNAL_ERROR.
  `providers.repair_json_quotes` now repairs text-quotes as a last resort (valid JSON unchanged; the broken outer object
  wins over its inner ones) and every bridge prompt asks for one ```json code block.
- **First real book — readability floor (FIXED):** adult/YA/middle-grade lower grade bounds lowered (fiction reads low;
  the book's grade 3.4 was wrongly called "simpler than usual").

- **First real test, 2026-10-25 — outline refused (FIXED):** a web AI wrote `plan.pov_id` 'odile-marsh' (a name) instead
  of the character's canon ID, so the chapter outline failed CANON_UNRESOLVED. `plan_rules.resolve_entity_ids` now maps
  a name-like ID to the ONE matching pinned canon record (same words, or part of the name) right after the AI answers;
  nothing or several matches → still refused as before.
- **First real test ("The Lamplighter's Last Ferry", Make a book with real web AIs) — the main character was lost.
  FIXED (2026-10-25), check on the next real run.** The idea named Odile Marsh; the Bible Builder proposed Odile,
  Tamsin and Corvin; Odile's entry never reached review and the run went on without her (the outline had no POV ID
  for her → `CANON_UNRESOLVED 'odile-marsh'` / Corvin as POV; editor and scene checker kept asking for her). Causes
  found (each reproduced with the fake AI, `tests/test_protagonist_guard.py`): (1) a proposal that did not fit the form
  (`valid: false`) was silently left out of the drafts; (2) a proposal the save refused was only counted ("1 entry could
  not be saved and was skipped"); (3) an entry VALIDATE refused was set aside and replaced from a NEW world sketch, where
  the set-aside draft still counted as "name taken", so the AI invented a different person; (4) nothing checked, before
  the outline, that the main character was approved canon. Fix: (a) refused entries are made again under the same name
  with Akọwe's exact problems (form, save and VALIDATE; at most 2 rounds; what still fails is a ⚠️ event
  `CANON_ENTRY_REFUSED` naming it); set-aside drafts no longer block their name; (b) after the canon step and before the
  outline the run checks the main characters (people named in the idea, the Bible Builder's character with sheet role
  "main", a POV a refused outline needed) and makes any missing one (bounded); if that fails the run stops with
  `PROTAGONIST_MISSING` naming the character and the refusal reasons; (c) the guided "Make my book" outline step shows
  ⚠️ for a missing main character with ✨ Make “name” (a draft for the author to approve) or ✔ Approve its waiting draft
  (`akowe/protagonist.py`). Limits: names in the idea are found by a heuristic (two or more capitalised words, no
  place word like Harbour/Ferry/Street, not an existing place or group); a one-word name ("Odile …") is only caught
  through the Bible Builder's "main" mark or the outline's POV.

- **★ Story roles + "who is the main character" (2026-11-01, branch story-roles).** Every character now has a story
  role (`story_roles.py`: protagonist ★ Main character, deuteragonist, love interest, antagonist, henchman, rival,
  mentor, sidekick, ally, family, supporting, minor, extra — label, one-line meaning, icon). The tag is stored on the
  character's companion entry by A01 record ID (plus the sheet; a new Bible Builder entry also says "Story role: …"
  in `attributes.role`), so a spelling correction or a rename never loses the main character. Every AI step that
  makes or edits characters asks for `story_role` (world sketch, Bible Builder item, sheet-and-voice call, protagonist
  re-make, Make a book) and exactly one protagonist; Akọwe resolves none/several deterministically (author's choice >
  one tag > named in the idea > Bible Builder main mark > most POV chapters > first created) with a plain event
  (`PROTAGONIST_SET`). B01/B03/B11 get `main_character` (+ `cast`); the outline must use the protagonist's canon ID as
  POV (an AI outline without them is refused and redone; still missing → `PROTAGONIST_MISSING`). The guard runs before
  the outline, before the chapters and before the whole-book review. Names are matched by one helper (`names.py`:
  accents/Yoruba marks, case, titles, possessives, initials, close spelling with a clear-winner rule, never a place) in
  the idea check, canon resolution of a POV, scene cards, chapter POV, the guard and the Book Bible. UI: role chips and
  a ⚠️ "no main character set" with ★ Make this the main character on the guided path, a role picker on the character
  page (moving the ★ asks first), titles on the A01 list and the Character Forge. Limits: the A01 `attributes.role`
  text is written once when the entry is made (the companion tag is the truth after an author change); an inferred
  role is a proposal until the AI or the author confirms it; names inside long prose are not fuzzy-matched (only
  name-sized strings of up to 6 words).

- **★ Main character: root-cause hunt + guarantee (2026-11-02, FIXED).** "It doesn't put in the main character for
  some stories." Every way a book could end without its main character as an approved A01 entry tagged protagonist,
  each reproduced with the fake AI first (`akowe/tests/test_main_character_paths.py`), then fixed at the root:
  1. **Mentioned, not made:** a place's or a friend's fact about her ("the harbour's keeper Mara Vell") counted as
     "already in the canon" / "a place of the canon", so no entry was ever made, and the cast picked someone else.
     Now only an entry's OWN names count (`protagonist.own_names`: its own subject's name/aliases + concept), in the
     guard, the cast's name matching (`story_roles.names_of`) and the Bible Builder (`assist.owned_names`).
  2. **Bible Builder placeholder:** the same mentioned names made the world sketch's main character a placeholder
     (an invented stranger). Fixed with (1); a real duplicate ("Mara" for an existing "Mara Vell" — close spelling or
     part of the name; "Mara Holt" is someone else) is a placeholder WITHOUT the ★ claim.
  3. **Count limit:** a sketch that listed more characters than asked cut the protagonist off when she came last; now
     the AI's protagonist and the people the idea names are kept first.
  4. **A guess beat the idea:** when no one claimed the ★, Akọwe's fallback ("the first character made", e.g. the
     mentor) was stored as `resolved`; the idea's main character, made by the guard afterwards, was demoted to second
     lead. The fallback is now marked (`story_role_fallback`, kept by sheet saves) and yields to the person the idea
     names (cast, `role_for_missing`, Bible Builder settle). A tag resolved for a real reason is never re-derived.
  5. **The villain by default:** with no claims and no names, the first-made antagonist became the main character;
     villains, henchmen, rivals, minor characters and extras are now last in the fallback order.
  6. **Other scripts / accents:** the name matcher kept only a–z, so Cyrillic/Greek names never matched (an approved
     "Ольга Петрова" was "missing" for ever); `slugify("Ọlá Adé")` gave "l-ad". Names now match in any script;
     subject IDs strip accents ("ola-ade"; a non-Latin name gets a stable `n-xxxxxxxx` ID).
  7. **POV not declared:** an outline whose viewpoint character the canon does not have (`plan.pov_id 'x' is not
     declared`) was rewritten until the run paused. Now the viewpoint character is made (guided path, approved) and
     the main plot is planned again so it pins them (`_repin_plan`, `PLAN_REPINNED` — the outline sees the canon
     only through the plot's pins; the same was true for a main character the outline step made).
  8. **Book bible / sequel:** a ★ main character the new book's checks refused to take was lost silently; now she is
     remembered by name and made by the guard.
  9. **Chapter brief:** every chapter brief now has `main_character` {name, id, in_this_chapter, is_pov} with a rule to
     keep the exact name and keep them the centre.
  10. **Guarantee step** (`AutoBookService._guarantee_main`): before the chapters are written and again before the
     book is marked done — exactly one stored ★, an approved A01 entry, chapters in the outline, named in every
     chapter brief. Repaired automatically (made via the guided make-the-main-character path, ★ re-tagged by the
     cast); only what cannot be repaired pauses with a plain-words `PROTAGONIST_MISSING` decision; a plain
     `PROTAGONIST_OK` event either way. (Before: a main character thrown away after the chapters still gave a
     "done" book.)
  Limits: names in an idea are still found only when capitalised (CJK names have no capitals, so an idea in Chinese
  or Japanese names no one and the Bible Builder decides); an AI's own explicit ★ claim on someone the idea does not
  name is kept (the AI was told who the idea names); an outline the author approved themselves without the main
  character pauses before the chapters (never rewritten for them).

- **P27 scene grid limits:** (a) scenes on the page are told apart only by scene-break lines (`***`); a chapter written
  in one AI answer usually has none (the whole-chapter prompt does not ask for them), so its row shows the plan only and
  "ⓘ written without scene breaks" — only scene-by-scene chapters (long ones) get words/readability per scene. Asking the
  writer to mark scene breaks would fix it (prompt change, not done here); (b) POV is per chapter (outline `plan.pov_id`),
  scene cards have no POV field; (c) "time" is the card's free text, not a computed story clock (P32 may add one);
  (d) printing uses a global `@media print` block in style.css (hides the top bar/side nav on every page).
- **P28 time/cost limits and choices to confirm:** (a) only ⚡ Make-a-book runs are timed per AI; ✍ Write all chapters
  shows wall time only and ✨ Fill with AI / reviews / reports outside runs are counted from the journal, not timed;
  runs saved before P28 show their calls as "an AI (not recorded which)"; (b) a run's "minutes" is start→end and includes
  pauses; (c) the estimate's calls-per-step model (`costs.STEP_MODEL`, two editors, 25 % fix rounds) was calibrated on
  fake-AI runs only (short story 46 calls measured vs 52 estimated); after real runs the measured calls per step and
  seconds per answer replace it — check it after the first real novel; until then 45 s per web-AI answer is a guess;
  (d) money is only shown for slots with per-token prices (tokens from provenance × today's slot prices), web AIs = 0.
- **P23 beta reader — not tried with real AIs.** Check on the first real book: (1) do web AIs quote word for word
  (many ⓘ "quotes not found" = paraphrase); (2) does the reader really react as the audience or slide back into
  editor talk (then sharpen `beta_reader.TASK`); (3) "guessed it" is judged after reading the whole book at once, not
  truly page by page — an AI that already knows the ending may over- or under-report guesses; (4) long books are read
  as a digest (same budget as the 📊 review), so boredom in a chapter's unseen middle is missed.
- **P23 design choices to confirm:** (a) the run step is OFF by default (one extra AI call; tick 📖 Beta reader in the
  ⚡ form); (b) one reader per read (not several); by default an AI that did not write most of the book; (c) reads are
  advice in settings (`beta_reads:<pid>:<branch>`, newest 5), not in the report's Markdown/PDF; (d) the 📖 job is not
  resumable after a restart (press 📖 again).
- **P25 [!] style numbers are English-only heuristics** (person from pronouns outside quotes, tense from a rough verb
  count, signature words = frequent lower-case words). Tune on real samples.
- **P25 design choices to confirm:** (a) one style card per author (`style_card:author:<principal>`), and a book keeps a
  SNAPSHOT (`style_card:<pid>`) — editing the card does not change a book until it is ticked again (the page shows
  "uses version N"); (b) the style is for the NARRATION only; dialogue keeps the voice cards; (c) the editor gets the
  card and one sentence in its task but no new scored dimension (adding one would change every chapter's rubric);
  (d) samples are stored (≤ 60 000 characters) so the numbers can be redone; they go to an AI only on ✨ Learn my
  style (≤ 12 000 characters); (e) "Write in my style" is pre-ticked in the ⚡ form when a card exists; (f) the AI
  summary call runs without a book (project id none): an AI slot limited to certain projects cannot do it (the
  numbers still work).

- P24 readability: the syllable counter and the reading-level formulas are English-only and approximate;
  audience targets are rules of thumb (not tuned on real books yet).

- **P32–P35 — not tried with real AIs or a real book.** Tested with the deterministic fake AI and the generic mock
  (which answers the tracker with an empty list: then only Akọwe's own reading is kept). On the first real book
  check: (1) does the tracker's scene split match the chapter (it follows `* * *` / `---` breaks and the scene cards);
  (2) `physical_state.extract` is English-only keyword/number patterns (time, light, tide, weather, footing, hazard
  words, "the 32nd lamp", "the gauge read 40 psi") — expect misses and some noise ("two men" is ignored, but any count
  noun in `COUNT_NOUNS` is taken); (3) are the character values (0-10) stable enough between chapters, or does the
  "big jump" check (≥ 5) fire on AI noise; (4) the two-readings test sends the whole book (or the P13 per-chapter
  digest above 60 000 characters) — a digest may miss the passage that contradicts a reading.
- **P32–P35 design choices to confirm:** (a) tracked state is companion data (`physical_state:` /
  `character_state:` / `ambiguity:` / `version_ledger:<pid>:<branch>`), included in book.akowe and in
  Reports/Continuity.md of the book folder, not in book-bible.json (a rerun tracks its new chapters again); (b) only
  APPROVED state reaches the next chapter's writer — a run tracks each chapter right after it is approved (one extra AI
  call per chapter) and approves the state under the run consent; outside runs the author presses ✔ Approve; (c)
  tracking is tied to the pipeline's "scenes" switch (the baseline preset does not track, so P14 comparisons stay
  fair); (d) a busy or failing AI never holds a run up: Akọwe's own reading is kept with a ⚠️ note; (e) the
  two-readings test and the readings are on request only (🧭 Continuity page), not run steps; (f) the ledger starts
  every change as "unresolved" — the writer is still told not to change unresolved items back, only to follow the
  current bible; a variant made from scratch has almost everything "unresolved"; (g) ✍ Write all chapters does not
  track (press 🧭 Track on the page); (h) the AI jobs cannot be resumed after an Akọwe restart (start them again).
- **P18.9 / P3.1 (Akọwe side) — not yet tried against the live sites.** Tested with fakes, an in-process
  v1.2 bridge and the desktop app's real `akowe-bridge.js` (fake host `--site-state`), not with real
  ChatGPT/Claude/Gemini windows. On the first real run check that the run window's "AIs:" line matches the
  AutoInjector panel and that a logged-out site is skipped.
- **P3.1 design choice to confirm:** when a Make-a-book run (or the book profile) names one AI, that AI writes and
  fixes, but the reviewer is still another working AI (the pin no longer means "only this AI is ever asked").
  An explicitly picked AI is never replaced while it is being repaired: that work waits instead of moving.
- ~~**P18.9 — the desktop e2e harness cannot answer check-ins.**~~ **Resolved:** `test/fixtures/fake-chat.html`
  now answers check-ins ("Reply with only this word: X" → X) and teach prompts ("Repeat this number: 1234" → 1234);
  `AKOWE_PRERUN_CHECKIN=0` was removed from `akowe/tests/campaign/bridge/test_bridge_e2e_autoinjector.py`
  and `pytest -q tests/campaign/bridge` passes (42 passed; that e2e file alone 32/32).
- **P18.1–P18.8 (desktop) — not tried against the live sites.** Everything was tested with realistic fake pages
  (jsdom-free fake DOM, real Chromium, and the real Electron app with `fake-chat.html`), not with logged-in
  ChatGPT/Claude/Gemini. On the first real run: watch the start-up check-ins (each AI's card should say "Check-in
  OK"), and if one goes 🔧 / ⚠️, open its ⚠️ and 📋 Copy diagnostics ("Self-repair …" lines) — that shows which
  step worked. Note: a check-in is a real message, so it is visible in the AI's own chat window.
- **P18.2 [!] page signatures are best guesses.** The log-in / captcha / usage-limit / error texts and selectors in
  `self-repair.js` `PAGE_SIGNATURES` come from what these sites have shown before, not from today's live pages.
  If a limit or log-out isn't recognised (the AI shows 🔧 / ✕ instead of ⚠️ Needs you), add its text/URL there.
- **P18.3 [!] alternative selector lists are unverified.** `ALT_SELECTORS` (per site + generic heuristics) were
  written without access to the current live DOMs. The page search (P18.4) and the teach step (P18.7) don't depend
  on them, so a wrong list only costs one step; update the lists from a learned selector that worked
  (`learnedSelectors` in the state file / Copy diagnostics) once seen live.
- **P4 / P5 / P6 — the editor's quality with real AIs is untested.** Everything was tested with the deterministic fake
  AI (it flags a known phrase and returns a replacement) in unit tests, the full Make-a-book flow and Playwright — not
  with Claude/ChatGPT/Gemini. To check on the first real book: (1) do the editor's quotes match the chapter word for
  word (notes marked “not found word for word” and many “could not be fixed word for word” mean the AI paraphrases —
  the rewrite then does nothing; tighten `editor_rubric.REWRITE_TASK` or allow whitespace-normalised matching);
  (2) are the scores stable enough — `judge_rewrite` tolerates a 1-point drop per dimension but not a lower average,
  AI noise may reject good rewrites (see `editor.rewrite_rejected` / SCORE_DROP in the journal); (3) does the editor
  over-flag (strictness normal = any major note): if most chapters end ⚠️ "editor still had notes", try gentle;
  (4) the editor context sends the whole chapter plus canon: very long chapters on web AIs may hit length limits.
- **P6 [!] heuristics are English-only and approximate.** Dialogue tags, speakers, triads and "moral endings" are regex
  heuristics (curly or straight double quotes; no single-quote dialogue). Thresholds are first guesses, calibrated
  only on crafted texts paraphrasing the Lamplighter patterns (`tests/test_prose_audit.py`), not on the real book.
  Run `prose_audit.audit_book` over the Lamplighter chapters and adjust `THRESHOLDS` / `GESTURES` if it under- or
  over-reports.
- **P4/P5 design choices to confirm:** (a) the editor's opinion is stored as advice (settings key), not as Set F
  records (F records are anchored patch proposals that enter the approval queue and need an approval reference);
  (b) a rewrite that is not kept is undone by saving the earlier text again as a NEW version (history keeps the
  rejected rewrite; the copied reviews say `copied_from_version`); (c) when the author's standing auto-approve is on,
  a run now approves chapters after the editor under the run consent instead of the auto-approve label; (d) the
  rewrite only covers chapters (C02) — premise/plot/outline get notes only; (e) "keep" notes that are not exact quotes
  cannot be checked by Akọwe after a rewrite (only quotes are).
- ~~**Desktop e2e flake seen during Section 2 (desktop-app, not changed here).** `tests/campaign/bridge/
  test_bridge_e2e_autoinjector.py` failed in 3 of ~10 runs with the Section 2 code (passes alone 6/7, baseline 4/4 +
  one full run): after the forced TIMEOUT and Resume, the run's pre-run check-in to Gemini and the re-sent chapter
  overlap, and AutoInjector logs `untagged-reply-accepted … a check-in answer` for Gemini's chapter reply, so the
  Akọwe request never gets its answer and the run is still "running" when the 170 s budget ends. The editor adds
  ~5 s of AI calls per run, which shifts timing; the race itself is in the desktop app's check-in/reply matching
  (P18.1/P18.5). Fix there: a reply that answers a pending Akọwe request (or contains JSON) must not be taken as a
  check-in answer.~~ **Resolved:** a check-in now owns a reply only if the Relay Trace says it answers the check-in's
  own [MSG #] (and nothing else) and it holds the word as a whole word (it used to match any reply containing the
  word, e.g. "harbor" in a chapter); bridge requests and check-ins no longer interleave; e2e 10/10 passes.
- **P7 / P17 / P8 — not tried with real AIs.** Tested with the deterministic fake AI (unit, Make-a-book end to end,
  Playwright), not with Claude/ChatGPT/Gemini. On the first real book check: (1) do web AIs fill the optional
  `character_sheet` / `voice_card` of the A01 proposal? If they leave them out, the run's "Character sheets and voices"
  step makes them (one extra call per character) — fine, just slower; (2) are the voice cards really different from
  each other (the first book's problem was one shared calm register) — read them on the character pages; (3) are the
  scene checker's verdicts useful or does it pass everything (then tighten `scenes.REVIEW_TASK`) / send everything back
  (then each chapter costs up to 6 extra calls: plan, check, 2 × rework + check); (4) the chapter prompt grows by up to
  ~15 000 characters (brief) — watch web AIs' length limits on long books.
- **P7/P17/P8 design choices to confirm:** (a) sheets, voice cards and scene cards are companion data in settings (like
  AI verdicts and editor notes), not A01 facts or B12 records — see DEVELOPING.md for why (A01 attributes are closed,
  facts are canon claims re-approved on every edit; C02 cannot pin a B12 and B12 plan items are kernel-checked plans
  without fields for goals/subtext); consequence: they are not versioned records, not in exports, and approving
  scene cards is a companion status (`approved.how = author | run_consent`), not a kernel ACCEPT; (b) outside runs a
  chapter is written with its newest scene cards even when they are not approved (draft) — approval is the author's
  signal, not a gate; (c) scene cards belong to one outline revision: a new outline version makes them out of date
  (not used) until planned again; (d) Write all chapters plans missing scene cards without the AI check.
- **P17 [!] voice heuristics are approximate.** Speakers are only recognised from tags with a capitalised name ("…,"
  Mara said); pronoun tags are ignored, so short chapters may have no voice stats. `voice_sameness` thresholds
  (words per line within 25 %, questions within 20 points, shared content words ≥ 25 % / 40 %) are first guesses
  calibrated on crafted text only; check them on the Lamplighter dialogue (`prose_audit.audit(text, settings={"voices":
  characters.voice_words(...)})`).
- **P9 / P10 / P11 / P12 — not tried with real AIs.** Tested with the deterministic fake AI (unit, Make-a-book end to end,
  Playwright 37/37), not with Claude/ChatGPT/Gemini. On the first real book check: (1) is the ledger short and sharp (4-12
  rules) and are the hard rules really bounded (⚠️ *not bounded* on the 🌍 page)? If the AI writes vague rules, tighten
  `story_rules.RULES_TASK`; (2) do the AI's updates after the outline keep the ids (otherwise every update shows as
  retire + add; harmless but noisy); (3) does the editor's `story_rules` dimension catch "a narrator's inference becomes
  confirmed metaphysics" — read its notes on the last chapters; (4) are texture details really used as obstacles (🌍 page
  usage: many "never used" means the writer ignores them); (5) the planned-to-page word check is strict on scene
  obstacles/changes (paraphrases are "unclear" until the AI checker confirms them with a quote): if most chapters end
  ⚠️ in runs, make `scene_change` optional in `planned.planned_items` or lower the word share; (6) the ending matrix in
  the last chapter's prompt vs. what the editor scores: check that an "open" ending is not reconciled anyway.
- **P9–P12 design choices to confirm:** (a) the ledger and the texture list are companion data (settings), not A/B
  records — see DEVELOPING.md (canon is read FROM, not written TO; no assertion type for "protected mystery"; edits must not
  make chapters stale); consequence: not versioned records, not in exports; (b) outside runs the ledger is NOT updated
  automatically when the plan changes: the 🌍 page shows ⚠️ *may be out of date* and **✨ Suggest updates** (an automatic
  AI call on every approval would spend AI work without the author asking); in runs the update is automatic and accepted
  under the run consent; (c) the planned-to-page check in runs fixes chapter-level items before approval (1 round) and the
  book-level step only REPORTS (fixing an already approved chapter late in the run would need a second approval and a
  new assembly); the book page's list links each missing item to its chapter's ✨ Fix with AI; (d) "must show" is a new
  optional field of the character sheet (the AI is asked to fill it; the narrator's name is always checked anyway);
  (e) Settings › Editor › rounds 0 also turns the planned fix into notes only; (f) the choices are stored in the book
  profile, so `book_profile_brief` carries them into every AI context that has the profile (reviewer, sheets, scenes).
- **P11 [!] word check heuristics are English-only.** Content words ≥ 4 letters, crude suffix stripping (`texture.lemma`);
  names count when the full name or one part (≥ 3 letters) appears. Non-English books will see more "unclear" items
  (the AI checker then decides).
- **P13 / P14 / P15 — not tried with real AIs.** Tested with the deterministic fake AI (unit, Make-a-book end to end incl.
  a 25-chapter novel, Playwright 41/41), not with Claude/ChatGPT/Gemini. On the first real book check: (1) do web AIs
  quote the book word for word in the report (many ⚠️ "quote not found" = they paraphrase); (2) are the whole-book
  scores spread or all 7s (then sharpen `book_report.REVIEW_TASK`); (3) a 60 000-character book prompt plus the schema
  may exceed a web AI's input box — lower `book_report.WHOLE_MAX_CHARS` / `DIGEST_MAX_CHARS` if the bridge refuses it;
  (4) does a web AI really write ~750 words per scene call, and does the continuation add story or repeat (the
  "new text only" filter drops repeated sentences, the pattern check sees the rest); (5) the ETA is an average of the
  chapters so far — the first chapter (scene planning, more fixes) makes it pessimistic at first.
- **P14 [!] blind comparison limits.** Each reviewer sees both versions in one prompt (≤ 30 000 characters each, a
  digest beyond that), so long books are judged on excerpts; position bias is only averaged out across reviewers (each
  gets its own random order), not removed — with one AI the result is one opinion (the page says so). Chapter titles
  and character names are content and stay in the text (two different books can be recognised by them, but not which
  pipeline made which). A variant re-runs the whole Bible Builder, so its characters differ from the original: the
  comparison measures the pipeline plus that variance — compare several pairs before drawing conclusions.
- **P15 [!] long chapters and AI fixes.** Scene-by-scene writing and the continuation happen inside one C02 CREATE (one
  record, every check unchanged), but the consistency reviewer's "Ask AI to fix it" (`ReviewService._run_fix`) still asks
  for the whole chapter back in one answer: a 3 000-word novel chapter may hit a web AI's reply limit there (the editor's
  rewrite is fine — it only returns the changed passages). A failed scene call loses the scenes already written for that
  chapter (the run retries the chapter). The short-story target changed from 5 000 to 4 000 words
  (`tests/test_autobook.py` updated); books without an explicit chapter count now get the preset's default (short
  story 3 instead of 1).
- **P13–P15 design choices to confirm:** (a) reports and comparisons are advice in settings (`book_reports:<pid>:<b>`,
  `comparisons`), not records, like editor notes; (b) the run's report step asks only independent AIs (none → a report
  without AI part and ⚠️); 📨 may ask the writer too, marked ⚠️; (c) a report belongs to the approved chapter versions —
  a new draft does not make it stale, a new approval does; (d) variants keep the original's title (the book list shows
  "(variant: baseline)").
- **P18 limits to know:** while a teach step runs, nothing else is typed into that AI (sends return
  `SITE_REPAIRING`); the teach step learns "Enter" when the user presses Enter instead of a Send button; a learned
  reply selector is read on its own when it matches (built-in ones only when it doesn't). `test/verify-relay-trace
  .test.js` (not in the unit list) compares against origin/main's relay-trace and already fails there on one
  pre-existing case, unrelated to P18.
- **P16 limits to know:** "This Akọwe book only" relies on Akọwe pushing `/v1/status` with `project {id,
  title}` before its requests; requests made before any status go to an unnamed book, and a request is filed under the
  project that was current when it *started* (a book switch mid-request is not split). Replies captured before P16 have
  no book tag, so older runs can only be extracted by time range / Everything. Only the AIs' replies are in the
  conversation section (Akọwe's prompts are never stored by the app). Path redaction covers home-folder paths
  (`~`, `/home/x`, `/Users/x`, `C:\Users\x`); a path outside any home folder (e.g. `D:\Private\…`) is kept, and a
  file name with spaces after the last folder may keep its last word. Not yet tried in a real Akọwe run.
- **P20 / P21 — not tried on a real Windows computer.** Tested on Linux (unit, fake-AI runs, Playwright 27/27). On
  the first Windows run check: (1) the default folder is `%USERPROFILE%\Documents\Akowe Books` — when Documents is
  redirected (OneDrive “Back up my folders”, a company policy) the real Documents known folder may be elsewhere; Akọwe
  does not call `SHGetKnownFolderPath` (it falls back to `~\Akowe Books` only when `%USERPROFILE%\Documents` is
  missing) — change it in Settings if so; (2) 📂 Open folder uses `os.startfile`; (3) antivirus or the search indexer may
  hold a file open: `replace_file` retries for about 2 s, then the save is ⚠️ SAVE_FAILED (the next save tries again);
  (4) paths are kept ≤ 200 characters by shortening the title; a very deep books folder is refused (SAVE_PATH_TOO_LONG).
- **P20 / P21 design choices to confirm:** (a) a book's folder keeps its first name when the title changes (stable,
  never moved behind the author's back); (b) every save rewrites only changed files, but `book.akowe` changes on
  every step, so a progress save of a long novel rewrites a package of several MB each time (at most every 2 minutes);
  (c) the package holds every version of every record and file (exact restore) — opening a saved book on the same
  computer asks: update the one you have, or open it as a copy (F10); (d) an opened book's project name gets “(opened)” only when the name
  exists, its profile title stays (so its exports stay current); (e) an approval's `action_hash` (a hash over the signed
  action) keeps its old value in an opened book — history only, never re-checked for engine approvals, but an
  H-set waiver checked again later would not match (`j_approvals.waiver_action_hash`); (f) an imported unfinished run
  can be resumed with its original consent record (pressing ▶ Resume is a new author action; ▶ Continue starts a new
  run with a new consent instead); (g) a 🔁 rerun keeps the saved story rules but the outline step still asks the AI
  for rule updates for the plan (one call, accepted under the run consent); (h) uploads are limited to 64 MB
  (`MAX_BODY`): a larger book opens straight from its folder (📂 “From a folder on this computer”, F10); (i) auto-save is off in
  the test suite by default (`AKOWE_AUTOSAVE=0` in tests/conftest.py) — only tests/test_section6.py exercises it.
- **P38 / P37.1–P37.4 — not tried against the live sites.** The 🎯 card, pick mode, the 🔢 number teach and the
  general-selector rules were tested on fake pages (fake DOM, jsdom, real Electron with `fake-chat.html`, headless
  Chromium), not on logged-in ChatGPT/Claude/Gemini. On the first real run: (1) 🎯 → AI's reply on each site and check
  the chip preview shows the start of the latest answer and that 📋 Copy diagnostics lists `🎯 saved assistant(pick …)`;
  (2) run 🔢 once per site and check it ends with "✔ Saved — … is working again." — if a part fails, its name is shown;
  (3) look at the saved selector in diagnostics / the state file: it must not contain digits from one message.
- **P37.2 [!] Gemini's "[TO:" with `parentChars 4` is not fully explained.** The reader now takes the whole AI message
  (`MESSAGE_CONTAINERS` in automation.js: `message-content`, `model-response`), joins split nodes, and falls back to
  `textContent` when `innerText` is much shorter (a part the page hasn't laid out). In the log even the parent of the
  matched node had only 4 characters, so the rest of the reply may live outside `model-response` (or be rendered
  lazily). If `reply-unreadable` / `capture-stalled` "the reader only sees the start" comes back, its `nodeInfo` now
  also has `containerChars` — copy that log line so the container list can be fixed; 🎯 → AI's reply on Gemini is the
  workaround meanwhile.
- **P38 design choices to confirm:** (a) the 🎯 "dialog" is a card in the pane's strip (and opened from the Akọwe
  ⚠️), not a modal window — a modal would hide the AI panes, which must stay clickable for pick mode; (b) Clear removes
  a new (unsaved) pick first, and the saved one on the next Clear; (c) a saved 🎯 / 🔢 selector wins over one the
  self-repair learned before it, but a selector learned LATER (because the saved one stopped matching) wins over it —
  the chip then shows red ⚠️ for the saved one; (d) the number teach no longer has the user type "Repeat this number:"
  — just the digits; the old `fake-chat.html` "Repeat this number" answer is kept for older tests; (e) the old 🧪
  round-trip test stays as a small button in the 🎯 card; "Test it" is a check-in; (f) after "not working", automatic
  reasons (a stall, an Akọwe timeout) no longer trigger an immediate check-in — only the 5/15/60-minute re-checks
  and the user's own actions do.
- **P37.4 limit:** a short reply (≤ 300 characters, tags stripped) that holds a check-in word from the last hour is
  treated as a check-in answer (held, not relayed, not nagged) when no Akọwe request is waiting for that AI — a
  genuine short reply that happens to use the same unusual word ("quokka") would be held too.
- **P36 / P37.5 — not tried with the real AIs.** Tested with the fake AI (unit, Make-a-book runs, Playwright
  `tests/campaign/ui/test_ui_section8.py`). On the first real book check: (1) do web AIs fill `score_evidence` and
  `weakest`? If not, every near-perfect review costs one extra re-ask (watch "asked once more" in the run log);
  (2) two editors per chapter means one more AI answer per chapter and per rewrite check (Settings › Editor › "Two
  editors" turns it off); (3) the thresholds (average 8.5, 3 problems, cap 7, discount from +1.0 after 3 reviews, max 2)
  are first guesses — `calibration.py` constants; (4) the pattern-check part of leniency only counts scores ABOVE the
  ceiling, so it can only push an AI towards "generous", never "strict".
- **P36 design choices to confirm:** (a) a flagged review with at least one note is forced to REVISE even when its capped
  scores would pass — with no note at all (no pattern finding either) it stays PASS but ⚠️ flagged; (b) leniency is kept
  per AI family across all books (one global settings key), measured on raw scores (before caps/discount); (c) a lenient
  AI's discount is applied to every score (not only high ones), floor 1; (d) in a rewrite round the earlier round's
  discounts and second editor are reused so the two versions stay comparable; (e) an editor the author picks by hand
  (🖋 with a slot) stays the only editor.
- **P37.5 design choices to confirm:** (a) "Start without it" does not lock the AI out: if it starts working during the
  run Akọwe uses it again (the run says so); (b) when the AI picked to write is skipped, the run switches to Automatic;
  (c) "unknown" from a v1.2 bridge (not checked yet) counts as not ok and the notice offers 🔁 Check again (a probe, up
  to 45 s); an older v1.0/1.1 bridge without states counts as ok; (d) the server does not refuse a start without the
  check (older pages / API) — the run window shows the ⚠️ notice instead.
- ~~**Pre-existing UI test failure (seen during Section 8, not caused by it):** `tests/campaign/ui/test_ui_followthrough.py::
  test_wizard_to_downloaded_book` fails "stuck on Write the chapters: ✔ Done: Approved 1 of 1." on unmodified `main` too
  (the Playwright UI tests only run when the Python `playwright` package is installed, so the normal suite skips them).~~
  **FIXED (2026-10-25).** No click was dropped. The test was wrong: it called the book "stuck" when the step title had
  been the same four times in a row. Writing and approving every chapter all happen under "Write the chapters", so with
  the 3-chapter short story the test gave up after ch1 write/approve and ch2 write/approve, which is normal progress.
  The test now fails only when two presses in a row leave the API's book state (done count, next step, step states,
  waiting approvals, chapter states/versions) unchanged. While checking, a second bug turned up and was fixed in the
  page. The 💾 card's "This book is not finished — next step: …" note was read once when the page opened, so it kept
  showing "Characters and places" while the book moved on. `renderBook` now keeps it in step with the book, and clears
  it once the book is made. The test checks the note after every step.
- **P26 / P30 / P31 (Section 7a) — not tried with real AIs or the real book 2.** Tested with crafted text and the fake
  AI (unit, Make-a-book end to end, HTTP, a Playwright smoke of both cards). On the first real book check: (1) the
  timeline regexes are English-only and only read ages written with an age marker ("twelve years old", "aged forty",
  "the 40-year-old Odile", "turned thirteen") next to a known character name — pronouns ("she was twelve years old")
  are skipped, so some problems are missed; a book spanning years may show `year_arithmetic` notes for chapters that
  mix two times; (2) the term scan uses a small built-in table (`terms.CONFLICTS`, `ANACHRONISMS`, `HEADS`/`MODIFIERS`)
  — it catches a wick on a gas lamp but will add everyday compounds ("gas lamp") as research needed; prune them on the
  book page or tighten `MODIFIERS`; (3) the repetition sorter only looks at 3–6-word phrases (2 words only as a
  dialogue opener like "Right, so"), single repeated words ("Nothing." ×4) are left to the P6 pattern checker; voice
  is decided from tagged dialogue ("…," Tom said) — untagged lines count as dialogue without a speaker; check the
  classes on book 2 ("Right, so" voice, Odile's counting motif) with `repetition.sort_repeats`.
- **P26 / P30 / P31 design choices — CONFIRMED by the user (2026-10-25: "go with the defaults"):** (a) trade facts, the story year and repeat labels are companion data
  (`trade_terms:<pid>:<branch>`, `repetition_labels:<pid>:<branch>`), not records — like the story rules; (b) only the
  author can mark a term verified/wrong (`author_confirms`); an AI's research answer is shown as advice and a Make-a-book
  run never verifies — it adds what it finds as "research needed" and reports ⚠️ `TERMS_RESEARCH_NEEDED` /
  `TERMS_WRONG` / `TIMELINE_PROBLEMS` after the planned-to-page step (never blocks, no automatic rewrite of terms or
  repeats in a run); (c) voice/motif repeats are protected in EVERY editor rewrite (also the run's editor pass): a
  rewrite that removes them is refused word for word (KEEP_LOST) unless it is ✨ Trim's own cut of their excess — so an
  editor note that only says "cut 'Right, so'" can no longer be applied; relabel the phrase as accidental to allow it;
  (d) the timeline checker never edits text (fixing a number needs the author's decision); (e) the writer's chapter
  brief gets the verified/wrong terms (`trade_terms`, ≤ 1 200 chars); research-needed terms only when the plan names
  them; (f) the editor's context gets `fact_checks` as data (no change to `editor_rubric.py`), so the AI editor may or
  may not turn them into findings; (g) the trade-facts list and repeat labels travel inside `book.akowe` (all
  companion settings do) but are now in the book bible too (`trade_terms` with the author's ✔/✕ decisions and the story year, `repeat_labels`), and a 🔁 rerun starts with them (FIXED 2026-10-25).
- **GitHub checks don't cover Akọwe.** *Addressed:* `.github/workflows/akowe-tests.yml` runs on PRs and
  pushes to main that touch `akowe/**` (or the Node bridge files the cross-process tests use). Job `test`
  installs `akowe/requirements.txt` + `requirements-test.txt` on Python 3.13 with Node 22 and runs
  `python -m pytest -q` in `akowe/` (UI tests skip there: no Playwright); job `ui-test` installs Playwright +
  Chromium and runs `tests/campaign/ui`. Still not on CI: the AutoInjector desktop-app bridge e2e
  (`tests/campaign/bridge`, needs `desktop-app/node_modules`), EPUBCheck and LibreOffice checks (skipped there).
  Earlier, `desktop-app-tests.yml` only ran for `desktop-app/**`, so Akọwe-only PRs (Sections 3–5) were merged
  on the full local suite.
- **🖼 Character pictures in the ⚡ run + "Make the rest of the pictures" (2026-11-01).** The Book Bible only
  showed Forge portraits and the run never made any, so every character box was empty. *Built:* a new run step
  "Character pictures" right after "Character sheets and voices" (`akowe/akowe/book_pictures.py`, `_s_pictures` in
  `autobook.py`): every approved character gets a portrait, the ★ protagonist the full set (portrait, front / side /
  back views, character sheet), made through the Character Forge's own path (`forge.run_art`, same prompts and
  `/image/request`), Stable Diffusion (`engine: "sd"`) by default. Each first portrait becomes the character's 🔒 lock
  in AutoInjector (new bridge route `POST /image/locks`, never replaces the author's own lock). Picture maker down or
  a picture failing → the run goes on, the missing pictures go on the book's to-make list (`book_pictures:<pid>:<branch>`)
  with a plain `PICTURES_WAITING` event; resume only makes what is still missing. The Book Bible shows "🖼 Picture
  waiting" in those boxes and has a **🖼 Make the rest of the pictures** button (job with progress and Stop: every
  character's missing full set plus the list; `GET/POST …/binder/pictures`). Settings → Pictures: "Make character
  pictures during ⚡ Make a book" (default on) and the picture maker (Stable Diffusion only, or Stable Diffusion else
  ChatGPT); a run body may also send `pictures: true|false`. Tests: `tests/test_book_pictures.py` (fake picture
  bridge), `test_ui_binder.py::test_pictures_waiting_and_make_the_rest`, `desktop-app/test/sd-studio.test.js`.
  *Not done:* other characters only get a portrait in the run (their views / sheets come from the button); places and
  items get no pictures; the pictures add minutes per character before the chapters are written.
- **📚 Series progression (2026-11-01).** A book bible could be reused for a sequel, but a character's looks,
  belongings and abilities could not change from book to book, and nothing stopped a sequel from rewriting their
  personality or voice. *Built:* `akowe/akowe/series.py`. Two layers per character: **fixed** for the series (name /
  identity, traits = personality, background / origin, the voice card) and **changeable** per book (appearance,
  items gained / lost, abilities gained / lost, relationships, status). A series (`series:<id>`, never keyed by a
  project ID, so deleting one book keeps the others' history) lists its books in order and stores, per book, only each
  character's changes (with the chapter); `state_as_of(series, key, n, "start"|"end")` applies them in order. A single
  book is a series of one (nothing stored until the author acts). **✨ Find what changed in this book** (Book Bible →
  📚 Series, and automatically at the end of a ⚡ run of a book that is in a series): the AI proposes each character's
  changes; nothing is used before ✔ approve; approving merges and never removes; the form has no fixed-layer fields;
  the author can write the changes themselves (`PUT …/binder/series/changes`). **📚 Start a sequel from this book**:
  the book bible at the END of this book (fixed layers copied from the series, appearance / relationships at their end
  state, no plan), the sequel hook as the idea, started as a ⚡ run (`sequel` in the run body) that registers the new
  book as number N+1 and links its characters; their voice cards are marked fixed (`characters.save_entry` keeps them
  on an AI save) and an AI fix of a carried-over character gets the fixed attributes put back word for word
  (`series.protect_fixed` in `review._run_fix`). The writer's chapter brief gets `series_state` (each present
  character as at the start of this book). **Per-book portraits**: approving a new look puts a "book N portrait" on the
  to-make list; it is made with the same 🔒 lock name (prompt = fixed look + this book's changes), earlier portraits
  are kept (`portraits_old`); picture maker down → it waits, and 🖼 Make the rest of the pictures makes it too.
  **Book Bible**: each character page has "📚 Through the series" (book 1 → book 2 …, portrait + what changed + the
  state), and **📖 As of book N** shows the whole binder of that book (its own pages, read only when it is another book,
  each character at the end of that book; cast portraits too); PDF / Word / HTML exports follow the choice
  (`?as_of=N`). The book bible JSON / Markdown carries a `series` block. Routes: `GET/… …/binder/series`,
  `POST …/series/find|approve|dismiss|portraits|sequel`, `PUT …/series/changes|name`. Tests: `tests/test_series.py`,
  `test_ui_binder.py::test_series_strip_as_of_book_and_sequel` / `test_single_book_has_no_series_strip_or_picker`.
  *Not done (at the time):* places, items and groups had no per-book layer; the series was not in `book.akowe`; the
  book page had no sequel button. All three are done in the follow-up below.
- **📚 Series follow-ups (2026-11-01): the world changes too, the sequel button on the book page, the series in the
  book file.**
  - *Places, items and groups* (`akowe/akowe/series_world.py`). The same two layers: **fixed** (name / identity, core
    description, origin; a group's symbol) and **changeable per book** (place: how it looks, state / condition, ruler
    or owner, danger level, who lives there, damaged / rebuilt; item: owner / holder, condition, powers gained /
    lost, where it is; group (every 🌍 8C world page): leader, members, allies, enemies, status). Stored in the series
    record as `things` / `thing_changes` / `thing_proposals` / `thing_pictures` / `thing_picture_waiting` (per-book
    deltas). `state_as_of` works per category mode ("latest" = the last change, "list" = gathered, "gain/lose" =
    an item's powers). ✨ Find what changed in this book asks the AI for `thing_changes` in the same call (proposals
    only; ✔ approve / ✕ dismiss / ✏ edit use the same routes with the thing's key; fixed-layer keys are refused in
    plain words). Approving a character's "gained / lost an item" that has its own page adds the holder change to
    the item in that book (`linked_items`). A place whose look changed (or was damaged / rebuilt) gets an
    establishing picture for that book (`purpose: "scene"`, through AutoInjector; picture maker down → it waits on
    the same to-make list; earlier ones kept). Binder: place / item / group pages (7 / 8B / 8C) get the "📚 Through
    the series" strip and, with 📖 As of book N, the fields that hold the state show it read only (e.g. 7.2.6 ruler,
    7.2.7 danger, 8B.2.4 holder, 8B.8.6 location, 8C.3.3 leaders, 8C.5.x members / allies / enemies; list categories
    are appended, never replace); the place picture of that book goes into 7.1.1. HTML / PDF / Word exports and the
    book bible JSON / Markdown carry them. A sequel links its places / items / groups to the same series keys, so
    they start at the end state; the writer's chapter brief of book 2+ gets `series_world`. (Also fixed: a sequel
    or rerun whose bible had a group / item crashed the canon step — `autobook` sorted the review list with
    `list.index`.)
  - *📚 Start a sequel from the 📘 book page* (`web/app.js` `sequelBox` / `confirmSequel`) and on the ⚡ run's
    "🎉 Your book is made" screen: the same consent dialog and the same route as the Book Bible's
    (`POST …/binder/series/sequel`); `GET …/binder/series/sequel` says whether it can be pressed — the button is
    disabled with the reason in plain words when no AI is connected or book N+1 exists. The Book Bible's 📚 Series
    panel uses the same status (`view.sequel`) and dialog, and lists place / item / group proposals with the
    characters'.
  - *The series in the book file* (`akowe/akowe/series_package.py`, `book_package.py`): a book in a series saves
    `series.json` (the whole series record: every book's order, title, approved changes, proposals, per-book picture
    references) into `book.akowe`. Opening restores it when the series id is new here, else **merges by series id**
    (books by number, people / things by key — a key that names someone else gets a new key —, approved changes:
    the newer one is the base, the other's entries are added where they do not conflict; a one-value category that
    differs is reported in plain words and the newer one kept). The same book opened twice as a copy is not added
    as a second book N (it opens on its own; the changes are merged). The open message says what happened. Old
    files without `series.json` open as before; a damaged one never stops the book from opening. The "update the
    one I have" check copy never touches the series.
  - Tests: `tests/test_series_world.py` (14), `test_ui_binder.py::test_series_place_strip_world_proposals_and_sequel_reason`,
    `::test_book_page_sequel_button_disabled_with_a_reason`, `::test_book_page_sequel_button_asks_consent_and_starts`.
  - *Not done:* the place picture is only made for a place's look (not for items or groups); a picture stored in
    another book of the series travels as a reference only (its bytes are in that book's file); an item's base
    powers are not known (only the changes are shown); the sequel still needs an AI; not tried with a real AI or
    Stable Diffusion.
- **📖 Book Bible: "At a glance" first page + a simpler toolbar (2026-11-03, user: "the Book Bible needs to make
  more sense").** *Built:* the binder now opens on **📖 At a glance** (Cover is the next page; a deep link or ⋯ View
  options → All pages skips it): one line saying what the Book Bible is ("…The AI keeps it up to date; you
  approve."), "N of M pages filled" + a bar and dots (○ empty · ✎ AI draft · ✔ approved) for each of the 12 parts
  (Cover, Contents, Book facts, Cast, Characters, Relationships, Places, World, Map, Story plan, Chapters, Rules &
  facts) — each row opens that part; 🖼 pictures waiting + "Make the rest of the pictures", or "Picture maker is off —
  open Settings"; ✎ facts waiting for your OK + ✨ Fill from the book + "Show me →"; ⬇ PDF · ⬇ Word · 🖨 Print; 📚
  "Book N of M" + 📚 Start a sequel (disabled with the reason); ★ the main character with portrait; 🎨 the look +
  Change look. The numbers are server-side: `binder.glance(data)` over the existing contract (added as `glance` to
  `GET …/binder`, nothing else changed; auto-computed and not-stored fields are not counted; a page under 25 % filled
  is "empty"); `GET …/binder/glance` adds the picture-maker check (`book_pictures.probe`) and the sequel status. The
  page is screen-only: it is not a binder page, so ⬇ PDF / ⬇ Word / the saved Book Bible never contain it and 🖨 Print
  from it prints the whole binder. Template 3 ("At a glance" in the schema) is now shown as **Book facts** (page
  title, contents) so the two are not mixed up. *Toolbar:* only 🎨 Look · 🔍 Search · ⬇ Export (PDF / Word / Print) ·
  📚 Series, plus **⋯ View options** (One page / All pages, 📖 As of book N, Show field numbers); element ids kept.
  Every binder page has **ⓘ What is this page?** (one line per template). Files: `akowe/akowe/binder.py`,
  `web/binder.js`, `web/binder.css`. Tests: `tests/test_binder_glance.py` (11),
  `test_ui_binder.py::test_opens_on_at_a_glance_and_its_rows_jump_to_the_pages`, `::test_at_a_glance_actions`,
  `::test_at_a_glance_picture_maker_off_and_a_series_of_two`, `::test_toolbar_four_tools_and_view_options_at_1280x720`,
  `::test_at_a_glance_in_every_look` (7), `::test_what_is_this_page_on_every_template`. *Not done:* the
  picture-maker check runs once per opening (it is not re-checked while the page stays open).
- **🕳 Holes H7, H15-H18, H22-H26 fixed (2026-11-03, docs/HOLES_2026-11.md, job "L3").** Each one was reproduced with a
  test first.
  - *H7 Sequels:* 📚 Start a sequel now first runs ✨ Find what changed (also for a book on its own, whose run never
    looked); while changes wait for the author it refuses in plain words with "Start without them" (`skip_changes`, an
    explicit skip that is remembered). The new book gets the 🔒 protected facts (worked out again from the entries, not
    wiped), every Character Forge dossier with its locks and the just-in-time details (`book_bible.forge_carry` /
    `seed_forge`, plus the binder's height / weight / handedness), the status, items, abilities and losses at the END of
    the book (in the character's "constraints", the only free canon field), and "What happened in book N" (premise + the
    chapter summaries, `series.story_so_far`). "Exactly as they were at the end" is only said when the changes were
    reviewed. Files: `series.py`, `book_bible.py`, one call in `autobook._seed_canon`, `web/app.js`, `web/binder.js`.
  - *H15 Pictures and 🔒 locks:* every portrait / view / sheet keeps a fingerprint of the description it was made from
    (`forge.looks_fingerprint`); `book_pictures.outdated` lists what is older; At a glance says "🖼 2 pictures are older
    than their description — remake" with 🖼 Remake them (`POST …/binder/pictures/remake`) and 🔒 Replace the lock
    (asks first; `POST …/binder/pictures/lock` with `author_confirms`; AutoInjector's `/image/locks` takes
    `replace: true`, never without it).
  - *H16 Saving:* a part that fails is named ("Not updated: Book Bible.docx (why)") and its file saved before is
    renamed "… (older version)"; a later good save removes it (`book_save.part_failed`, `_mark_older`).
  - *H17 Long books:* the report says "📖 Sampled: the reviewers read about N% …" and 📖 Read the whole book reads it
    in parts (each part whole, ≤ 60 000 characters) and merges each reviewer's findings (median scores,
    `book_report.book_parts` / `merge_part_rows`, `full: true`).
  - *H18 Letters:* DejaVu Serif (free licence, `exporters/fonts/`, 380 kB) is embedded as a subset (pure Python,
    `exporters/unifont.py`) for every run of letters WinAnsi lacks — the book PDF, the dossier PDF, map labels,
    captions and the cover; G05 blocks only letters no font has; a chapter's approval warns at once about those;
    the book profile has a `language` (BCP 47) used by the format profiles and G05 instead of "en".
  - *H22 Chapter pictures* are made from the written chapter (the passage past the scene's middle, the characters it
    names first) and say "Chapter N changed since this picture was made" with 🖼 Remake (`replace: true`).
  - *H23* The cover page compares the blurb / tagline / subtitle / series with the book and the Book Bible (names and
    numbers found nowhere, a cover title or author that is not the book's); a renamed book takes its cover with it
    (`cover.follow_rename`); a Greek / Cyrillic-only title gets its own file name (`cover.file_stem`).
  - *H24* The trailer remembers the book's chapters and the looks it was made from and says which changed.
  - *H25* Alfred's pause / resume / cancel act on the open (or named) book's run, and ask which when several books
    have one (`WHICH_RUN`).
  - *H26* An untagged Akọwe reply whose JSON is still open waits (up to 36 s) instead of being handed over as finished
    (`smart-json.replyLooksCut`); the send script checks the WHOLE pasted text (start, end, length), not its first
    60 characters (`automation.composerHoldsText`).
  - Tests: `akowe/tests/test_holes_l3.py` (8), `test_set_g.py::test_h18_…`, `test_cover.py::test_h18_…`,
    `test_pictures.py::test_h22_…`, `test_trailer.py::test_h24_…`, `test_1080_fixes.py` and `test_binder.py` (H16),
    UI `test_ui_binder.py::test_h7_…` and `::test_h15_…`; desktop `test/sd-studio.test.js`,
    `test/alfred-current-book.test.js`, `test/smart-json.test.js`.
  - *Not done:* a run's own chapter approvals (autobook, another job's area) do not log the letters warning (the book
    page's approve does); the Unicode font has no bold / italic (those runs print in the regular face); a cut-off reply
    is still accepted after 36 s (Akọwe then repairs it or asks again); items / places / magic dossiers are not carried
    into a sequel's Forge (only characters; the series already carries places, items and groups); not tried with a real
    AI, Stable Diffusion or a real PC.
- **🕳 Holes H3 · H5 · H6 · H10 · H11 · H12 · H13 · H14 of `docs/HOLES_2026-11.md` (2026-11-03, job L2 "story
  promises & approvals").** Each hole was first reproduced with the fake AI (`tests/test_holes_l2.py`, 20 tests: 18
  fail on the code before this change, the other 2 test the new modules alone), then fixed at the root:
  - *H3 content limits, themes, central question* (`akowe/akowe/book_promises.py`): they reach every AI that gets the
    book profile (`assist.book_profile_brief`), the chapter writer's context (`set_c` ChapterWriter `book_profile`)
    and the chapter instruction itself (`book_path.prepare_chapter`: "Content limits (never show this): …",
    "Themes: …", "The book's central question: …" — placed so the 2 000-character cut never takes them). The AI
    reviewer is told the rule and has an optional `content_limits_breach`; a breach (or a reason starting "Content
    limits:") turns any verdict into REVISE (`review.promises_kept`) — never approved, never auto-approved. The
    editor's rubric has the dimension **content_limits** ("Respects the author's content limits", only when limits are
    set); any finding there is a REVISE whatever the strictness (`editor_rubric.ALWAYS_REVISE`).
  - *H10 point of view and tense*: decided when the book is invented (the AI's `point_of_view` / `tense`, else the
    genre's default: first person for young adult / romance / memoir, third person otherwise; past tense) and saved
    in the profile (`pov`, `tense`; editable, validated). In every brief and instruction ("Point of view: third
    person, past tense (keep it in every chapter)"). Every chapter review counts pronouns and verbs outside dialogue
    (`book_promises.pov_tense_problem`, the style-card count); a clear switch is a REVISE with the reason in plain
    words.
  - *H6 no self-approval* (`akowe/akowe/approval_trust.py`): an AI's APPROVE approves on its own (run consent or
    standing auto-approve) only when the reviewer is a different AI from the writer, gives at least one reason and
    has confidence ≥ 0.6. Otherwise the run pauses with one plain decision — "Only Claude is working, so nobody else
    checked this chapter — approve it yourself, or wait for another AI" (codes NO_SECOND_AI / NO_REASON /
    LOW_CONFIDENCE; options ✔ Approve it myself · 🔁 Try again). The ⚡ dialog offers "✔ Approve this one" and "✔
    Approve this and trust this AI for the rest of the run" (`for_rest_of_run`; each such approval is listed). The
    standing auto-approve is withheld the same way (`review.auto_approve_withheld`). The test harness now runs with a
    second, different AI by default (`test_autobook.make_app(second_ai=True)`; one-AI tests answer the pause with
    `autobook_fake.trust_one_ai`). The other harnesses got the same second AI: `tests/campaign/flow/flowkit.make_app`,
    `tests/campaign/fault/test_fault_concurrency.make_app` and `fault_server.py`; the "AI is down" story-details test
    keeps one AI (`second_ai=False`). Full non-UI suite: 2 700 passed, 114 skipped, 2 xfailed.
  - *H14 approved without checks*: "Approve anyway", the standing auto-approve and "approve it yourself" are written
    down (`approved_unchecked:<pid>:<branch>`); the editor (craft review only — nothing is rewritten) and the
    planned-to-page check still run afterwards as notes (`autobook._notes_after_approval`, also after a resume), and
    the result is stored with the entry. Listed in the book report (`unchecked` + a ⚠️ warning) and on 🏠 Book home
    (`status.attention`, the new "⚠️ Needs a look" card).
  - *H5 a hand edit to an approved chapter* (`continuity.py`): ONE function, `invalidate_after_chapter(store, pid,
    branch, chapter_id, number=…)` — the chapter's tracked state is set aside (status `out_of_date`, never given to a
    writer or reviewer; `section` also skips a state read from another text), every later chapter already written is
    flagged "⚠ Chapter 5 changed after chapter 6 was written — check chapter 6", and `INVALIDATE_HOOKS` run (for the
    L1 ledgers). `check_edits` finds such edits (tracked / seen version vs the approved version now) from the run,
    the continuity page and Book home; `tracked(…, rec)` is no longer "done" for an out-of-date state, so the run
    tracks it again; on resume a draft of a later chapter written before the edit is set aside and written again
    (`DRAFT_BEFORE_EDIT`). POST `…/review/continuity/recheck/<chapter>/done` = "I checked it".
  - *H11 / H12 the ending keeps the promises* (`akowe/akowe/ending_check.py`): after the last chapter one AI call
    (another AI than the writer when one works) checks each plot obligation / outline thread, each named character
    of some importance who vanished (not seen in the last third), the main character's change (sheet: wants, needs,
    change limits) and the book's question (premise + central question) against the page. Open items with a fix go
    to the last chapter(s) through the editor's rewrite machinery and are reviewed and approved again under the run
    consent (one round, then a second check); what stays open is said in the run and listed on Book home.
    `ending_check.check(review, job, upto=N, final=False)` is the checkpoint L1 can call (stored separately); routes
    GET `…/review/continuity/ending` and POST `…/review/continuity/ending/check` ({upto}).
  - *H13 instruction cuts*: least important first — a full story-rules ledger drops retired rules before new ones
    (`story_rules.decide_proposals`), the planned-to-page items keep the beat and must-shows before scene goals and
    details (`planned.most_important`, also for the AI check). Web AIs get realistic context limits unless the author
    set one (`providers.WEB_CONTEXT_TOKENS`: ChatGPT 32 000, Gemini 32 000, Claude web 100 000 tokens; the API keeps
    200 000). What was cut is said exactly: the chapter brief's meta `cut` (story rules, must-shows, planned details,
    shortened voice cards) and the C01 `OPTIONAL_OMITTED` finding (now lists the facts) → `brief_cuts.py` → a ⚠️
    event in the run ("⚠️ Chapter 3: the instructions were too long, so Akọwe left out — …"), the chapter page
    (planned card) and Book home.
  - *Not done:* (the continuity part of the brief now reports its cuts too — see "Working with job L2" under the
    story ledger section); the POV/tense check is a word count (it cannot see a deliberate second narrator); the ending fix
    adds to the last paragraph(s) only (it does not restructure a chapter); H11's setups come from the plan's
    obligations and threads (a setup that only exists on the page is found only if the AI notices it).
