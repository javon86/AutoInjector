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
  ChatGPT page check (`desktop-app/tools/chatgpt-page-check.js`) to hard-code ChatGPT's live selectors.
- **Latest feedback:** ChatGPT's 2026-10-24 comparison of book 1 vs book 2 — book 2 better on character (5→8), voices (5→8), subtext (5→8), peril (4→7), realism (5→7); weaker on closure (9→6) and scope (9→6); added P30–P35 from it.
- **🎩 Alfred (done 2026-10-25, B4 → app-wide):** the butler grown into the user's assistant for the whole app — chat
  drawer on every tab, a fixed tool registry, "I will" cards before any change, proactive notices; OFF by default
  (🎩 switch); a local model via Ollama or a connected AI. See `docs/ALFRED.md`.
- **Back burner (later, by the user's call):** images + Stable Diffusion (B1: AutoInjector side done — 🎨 Images tab),
  video (B2), covers and pictures (B3), Character Forge dossiers (B5).
- **Still to try for real:** everything above has only been tested with stand-in AIs — the first real
  run on the user's PC is the real test (see "Problems to come back to").
- **One app, one launcher (done 2026-10-25):** start AutoInjector — Akọwe starts with it (📖 Akọwe tab, connected
  by itself). `akowe/run-akowe.*` remain optional for Akọwe alone.
- Last updated: 2026-10-27 (B1 pictures in books, B3 covers (designer + print wrap) and B5 items / places / magic systems + the manuscript check DONE, all usable by 🎩 Alfred; earlier: video, Character Forge, 360 scan; book #2 next).

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
- [~] **B2** 🎬 Video: hook up AutoInjector's Video Generation panel for book trailers / scenes.
  AutoInjector side, DONE 2026-10-27: a real local video engine (`video-studio.js`, `docs/VIDEO_API.md`).
  - It renders with the ComfyUI the app already installs, using Wan 2.2 TI2V 5B (text or picture → video, about 12 GB VRAM) or Wan 2.1 T2V 1.3B (text → video, about 8 GB).
  - In-app model downloads (16.9 GB / 9.2 GB, the shared text encoder fetched once). ComfyUI itself installs first when it is missing. Stability Matrix model folders are supported.
  - A 🎬 Video tab: setup, text → video, picture → video, every Wan setting, progress and Stop, a player and gallery, plain error boxes.
  - Bridge: `GET /video/backend` and `POST /video/request`. The capability test renders a real 1 s clip.
  - 🎩 Alfred: `video_call` over every video-api method, plus `generate_video` (text, picture or a character's looks) and the dossier `clip`.
  - Checked across the two real programs: an Akọwe clip job → the bridge → video-studio → a ComfyUI stand-in → clip and poster stored with the book.
  - Still open: a first run on a real GPU, and book trailers (several shots joined).
  Akọwe side, first use DONE 2026-10-27: Character Forge **motion clips** — a 4 s picture→video "motion study" per
  dossier through AutoInjector `POST /video/request` (portrait as a temp-file path, idle-motion prompt from the
  appearance / posture / gait / expressions fields, 900 s timeout, plain words for every `VIDEO_*` code), stored with
  its poster as book assets, played on the dossier page, the poster as a MOTION STUDY still in the PDF, in the book
  save (`docs/CHARACTER_FORGE.md` "Motion clip"). Still open: book trailers / scene clips; a real GPU run.
- [ ] **B3 (P19)** 🎨 Book cover and pictures (LATER — not started): cover design (title/author on a template,
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

## Problems to come back to

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

- **Stable Diffusion (B1) — not yet tried on a real GPU:** everything was tested against fake Forge/ComfyUI
  servers, fake processes and a fake download server. First real run on the user's PC: Stability Matrix package
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
  computer copies all of it again as a new book; (d) an opened book's project name gets “(opened)” only when the name
  exists, its profile title stays (so its exports stay current); (e) an approval's `action_hash` (a hash over the signed
  action) keeps its old value in an opened book — history only, never re-checked for engine approvals, but an
  H-set waiver checked again later would not match (`j_approvals.waiver_action_hash`); (f) an imported unfinished run
  can be resumed with its original consent record (pressing ▶ Resume is a new author action; ▶ Continue starts a new
  run with a new consent instead); (g) a 🔁 rerun keeps the saved story rules but the outline step still asks the AI
  for rule updates for the plan (one call, accepted under the run consent); (h) uploads are limited to 64 MB
  (`MAX_BODY`): a larger book must be copied into the books folder and opened from the list; (i) auto-save is off in
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
