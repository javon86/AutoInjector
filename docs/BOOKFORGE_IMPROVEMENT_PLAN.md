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

- [ ] **P18.1** Check-in probe: a tiny automatic message with a random word, sent to each AI at
  start, every so often while running, and before BookForge starts a book.
- [ ] **P18.2** Failure classifier: typing failed / sent but no reply found / reply rejected as old /
  stuck generating / logged out or captcha / usage limit.
- [ ] **P18.3** Automatic fix 1: try other known ways (built-in list per site) to find the message box,
  send button and replies.
- [ ] **P18.4** Automatic fix 2: search the page for the check-in's random word, learn where replies
  appear, save it and test it again.
- [ ] **P18.5** Fix the duplicate check (Gemini's answer was treated as an old one): a reply that
  answers the current message number is new.
- [ ] **P18.6** Automatic fix 3: reload the AI's window; unfreeze a stuck AI (stop button, resend).
- [ ] **P18.7** Teach step: pop-up asks the user to type "Repeat this number: ####" (random 4 digits);
  AutoInjector learns the message box, send button, the user's message and the reply from where the
  number appears, saves them and confirms with a new check-in. Falls back to the 🎯 picker.
- [ ] **P18.8** User-only problems (logged out, captcha, usage limit): ⚠️ says exactly what to do,
  re-checks by itself when fixed.
- [ ] **P18.9** BookForge keeps going: work moves to the AIs that are working while one is being
  fixed, and moves back when it recovers.
- [ ] **P18.10** Every detection and fix goes into the activity log and diagnostics.
- [ ] **P3.1** Writer and reviewer are always different AIs when more than one works.
- [ ] **P3.2** ⚠️ "reviews are not independent" when only one AI is available.

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

_(none yet)_
