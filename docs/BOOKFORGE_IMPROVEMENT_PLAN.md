# BookForge improvement plan (from the "Lamplighter's Last Round" review)

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

## Section 1 — AIs that always answer (self-repair) and independent review  (Phase 1)

- [x] **P18.1** Check-in probe: a tiny automatic message with a random word, sent to each AI at
  start, every so often while running, and before BookForge starts a book.
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
- [x] **P18.9** BookForge keeps going: work moves to the AIs that are working while one is being
  fixed, and moves back when it recovers.
- [x] **P18.10** Every detection and fix goes into the activity log and diagnostics.
- [x] **P3.1** Writer and reviewer are always different AIs when more than one works.
- [x] **P3.2** ⚠️ "reviews are not independent" when only one AI is available.

## Section 2 — A real editor  (Phase 2)

- [ ] **P4** Craft review after the consistency review: subtext, characters' own goals and
  resistance, distinct voices, obstacles from the world, over-stated theme, repeated patterns and
  gestures, too-neat ending, protected mysteries. Each finding points at the exact passage.
- [ ] **P5** Targeted rewrite of only the flagged passages, with a "keep" list; afterwards check that
  nothing good was lost and no story rule was broken.
- [ ] **P6** Pattern checker (no AI): counts repeated tics ("went very still", "not X, not Y, but Z",
  moral paragraph endings, repeated gestures) and feeds them to the editor.

## Section 3 — Characters who are their own people  (Phase 3a)

- [ ] **P7** Richer character sheets: wants, needs, fears, secrets, false belief, stress behaviour,
  what they would never say; side characters get their own wish.
- [ ] **P17** Voice cards: how each character talks (rhythm, vocabulary, favourite/never words,
  habits, job/era in their words, speech under pressure, what they talk around). Voice test in the
  editor: with names hidden, can you tell who is speaking?
- [ ] **P8** Scene cards before writing: each character's goal and hidden agenda, an obstacle from
  the world, what changes, what stays unsaid.

## Section 4 — A world with rules and texture  (Phase 3b + 4a)

- [ ] **P9** Story-rules ledger: hard rules / things seen to happen / beliefs / protected mysteries.
- [ ] **P10** World-texture list (work, weather, institutions, locals); a detail is used only if it
  causes something, shows skill or gets in the way.
- [ ] **P11** Planned-to-page check (e.g. a narrator's planned name and backstory never shown).
- [ ] **P12** Ending and style choices in the book profile (neat / bittersweet / open; how much is
  explained; how dark), all optional with good defaults.

## Section 5 — Proof, reports and longer books  (Phase 4b + 5)

- [ ] **P13** Automatic book report when a book is done (scores, strengths, weaknesses) and a button to
  send the book to the other AIs for review.
- [ ] **P14** Compare versions: old vs new pipeline, rated blind by the other AIs.
- [ ] **P15** Novella and novel lengths with word targets per chapter and scene.
- [ ] **P16** AutoInjector "Extract this book only" (the full extract mixed in unrelated private
  conversations).

---

## Problems to come back to

- **P18.9 / P3.1 (BookForge side) — not yet tried against the live sites.** Tested with fakes, an in-process
  v1.2 bridge and the desktop app's real `bookforge-bridge.js` (fake host `--site-state`), not with real
  ChatGPT/Claude/Gemini windows. On the first real run check that the run window's "AIs:" line matches the
  AutoInjector panel and that a logged-out site is skipped.
- **P3.1 design choice to confirm:** when a Make-a-book run (or the book profile) names one AI, that AI writes and
  fixes, but the reviewer is still another working AI (the pin no longer means "only this AI is ever asked").
  An explicitly picked AI is never replaced while it is being repaired: that work waits instead of moving.
- ~~**P18.9 — the desktop e2e harness cannot answer check-ins.**~~ **Resolved:** `test/fixtures/fake-chat.html`
  now answers check-ins ("Reply with only this word: X" → X) and teach prompts ("Repeat this number: 1234" → 1234);
  `BOOKFORGE_PRERUN_CHECKIN=0` was removed from `bookforge/tests/campaign/bridge/test_bridge_e2e_autoinjector.py`
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
- **P18 limits to know:** while a teach step runs, nothing else is typed into that AI (sends return
  `SITE_REPAIRING`); the teach step learns "Enter" when the user presses Enter instead of a Send button; a learned
  reply selector is read on its own when it matches (built-in ones only when it doesn't). `test/verify-relay-trace
  .test.js` (not in the unit list) compares against origin/main's relay-trace and already fails there on one
  pre-existing case, unrelated to P18.
