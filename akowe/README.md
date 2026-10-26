# Akọwe

**Akọwe — your book's scribe.** (Yoruba *akọwe*: scribe, secretary — from *kọ*, write, and *ìwé*, book.)
Formerly BookForge — renamed to Akọwe on 2026-10-25; see [Renamed from BookForge](#renamed-from-bookforge).

Akọwe is a local book-production workspace built from the **Akọwe Final Build Plan**
(contract `BF-IRB-1.0.0`, closure revision `BF-CLOSURE-1.1`). It covers the whole path from
story bible to a release-checked book: universe canon, planning, prose, art, story state,
editing, reconciliation, assembly/export, quality checks, storage and orchestration.

It is one application with **11 independently owned modules (A-K) and all 142 operations**,
sharing a transactional storage kernel. Every operation supports the contract's CREATE /
UPDATE / READ / VALIDATE / ACCEPT actions and can be run directly, without finishing another
module first.

| Set | Workspace | Operations |
|---|---|---|
| A | Universe / bible | characters, species, worlds, locations, governments, factions, cultures, religions, magic, technology, weapons, items, history, timeline, languages, economy, laws, relationships (A01-A18) |
| B | Planning | premise, genre/tone, main plot, subplots, arcs, structure, conflicts, mystery, foreshadowing, story timeline, chapter outline, scenes, pacing, ending (B01-B14) |
| C | Writing | context loader, chapter/scene/dialogue/description/action/emotion/transition/opening/ending writers, rewrite, writing style (C01-C12) |
| D | Art | visual style, character/environment/creature/item art, scene illustration, comic panels, composition, consistency checks, cover art, maps (D01-D12) |
| E | Story state | character, location, timeline, relationship, knowledge, injury, inventory, magic, plot-thread, unresolved-event, continuity and canon-vs-manuscript tracking (E01-E12) |
| F | Editing | developmental, structure, pacing, characterization, dialogue, prose, repetition, clarity, grammar, transition, line edit, final polish (F01-F12) |
| G | Assembly / export | compile, ordering, illustrations, layout, typography, title pages, TOC, front/back matter, cover, **PDF / EPUB / DOCX**, print spec (G01-G14) |
| H | Quality | read-through, canon, plot, arcs, missing/duplicate content, art, layout, TOC, file integrity, final readiness (H01-H10) |
| I | Storage / context | canon DB, schemas, registry, validation, missing info, retrieval, context packages, approvals/locks, history, completion, dependencies, provenance, compression (I01-I15) |
| J | Reconciliation | contradictions, cross-bible checks, duplicates, reconciler, minimal-change solver, ripple analysis, patches, canon updates, impact, revalidation, decisions (J01-J11) |
| K | Orchestration | projects, scheduler, router, dependency resolver, job queue, auto/manual mode, retries, progress, approval checkpoints, pause/resume, model/tool selection, cost control (K01-K12) |

## Run it (Windows)

**Easiest: start AutoInjector** (`desktop-app/run-windows.bat`) — Akọwe starts with it and opens in its
**📖 Akọwe** tab, signed in and connected to the AIs (same Python environment and data folder as below).
The steps below run **Akọwe on its own** (optional; if AutoInjector already runs Akọwe, this just opens it).

1. Double-click **`run-akowe.bat`** in this folder. If Python 3.10+ is missing, the window says
   so and opens python.org: install it, tick **"Add python.exe to PATH"**, then double-click again.
2. The first start makes Akọwe's own Python environment (`%LOCALAPPDATA%\Akowe\venv`) and
   installs the one dependency quietly (needs the internet once).
3. Your browser opens the workspace. If port 8780 is busy, Akọwe picks the next free port; if
   Akọwe is already running, it just opens it again. Keep the window open while you work; close
   it to stop. On a problem the window stays open with a plain explanation.
4. Optional: double-click **`create-shortcut.bat`** once to put an **Akọwe** shortcut on your
   Desktop.

macOS/Linux: `./run-akowe.sh`. Manual start: `python -m pip install -r requirements.txt`
then `python -m akowe` (options: `--port 8780`, `--data-dir PATH`, `--no-browser`).

Your projects are stored privately on this computer (Windows: `%LOCALAPPDATA%\Akowe`;
elsewhere `~/.local/share/akowe`). The server only listens on `127.0.0.1`.

### Renamed from BookForge

Akọwe was called BookForge until 2026-10-25. An existing install keeps everything; nothing is deleted:

- **Data folder**: on the first start `%LOCALAPPDATA%\Bookforge` (elsewhere `~/.local/share/bookforge`) is
  moved to `%LOCALAPPDATA%\Akowe` (`~/.local/share/akowe`), Python environment included — by the launcher, or
  by Akọwe itself. When it cannot be moved it is copied and the old folder gets a `MOVED-TO-AKOWE.txt` note;
  when even that fails Akọwe keeps using the old folder. The database `bookforge.sqlite3` becomes `akowe.sqlite3`
  and backups made before the rename still verify and restore.
- **Books folder**: a folder you chose in Settings stays as it is. Without one, an existing
  `Documents\BookForge Books` keeps being used; only new installs get `Documents\Akowe Books`.
- **Saved books**: `book.bookforge` files and their book folders still open (📂 Open a saved book, or upload);
  the next save of that book writes `book.akowe` in the same folder and removes the old `book.bookforge`.
  Book bibles saved by BookForge open too.
- **Keys**: `~/.bookforge/secrets.json` (AI keys, the AutoInjector connection key) is copied to
  `~/.akowe/secrets.json`, so the pairing with AutoInjector survives; AutoInjector keeps its key as well.
- **Environment variables**: `AKOWE_*` (`AKOWE_PORT`, `AKOWE_DATA`, `AKOWE_BOOKS_DIR`, `AKOWE_AUTOSAVE`,
  `AKOWE_SECRETS`, `AKOWE_EPUBCHECK`, …); the old `BOOKFORGE_*` names are still read when the new one is not set.

## Getting started: Start a new book and Make my book

The first time you open Akọwe (and any time from **🚀 New book** in the top bar) a short
**Start a new book** wizard asks, in plain words: 1) your **book profile** — title, author or pen
name, genre, who it is for, length (short story / novelette / novella / novel), tone and your idea in a
paragraph; 2) which **AI** to use (each slot with its current status, Automatic, or *Manual — I'll
write it myself*); 3) **what to make** (characters, places, the world, premise, plot and outline);
4) review and **Create my book**. With an AI it starts drafting the characters and places right away.

Step 1 also has the optional **🎚️ Ending and style** choices (see below). The **book profile** is shown (and editable) on the Overview. The AI reads it every time it helps,
and the title and author go on the title page and into the exported files. It is stored with the
project (API: `GET/PUT /api/projects/{id}/profile`).

**📘 Make my book** is one checklist for the whole book, in order: book profile → characters and
places → premise → main plot → chapter outline → write each chapter → book format → put the book
together → export (PDF, EPUB, DOCX for the release profiles you chose) → a content check. Each step
says **Done**, **Needs you**, **AI can do it**, **Ready** or **Waiting**, and the big **▶ Do the
next step** button does the next one. Creative steps are written by your AI (or, with no AI, open a
ready-made form for you to write); Akọwe never approves anything for you (the only exception is a ⚡ Make a book for me run you start, see below) — every approval asks
*"Approve as the author?"*, and when a step needs an explicit approval record (for example a chapter
without an objective review) one is recorded for exactly that version because you confirmed. At the
end **⬇ Download my book** gives you the files. Full release readiness (H10) stays in Quality Checks.
API: `GET /api/projects/{id}/branches/{b}/book`, `POST .../book/{create|write_chapter|approve|setup_format|assemble|export|check}`.

## ⚡ Make a book for me

The yellow **⚡ Make a book** button (top bar, Your books, the Overview and Make my book) lets your AI make a
whole **new** book in one go. Quick settings are optional — genre, length (default **short story**), which AI
(or Automatic) and an idea — or press **⚡ Start — let the AI choose everything**. Akọwe first saves a backup,
creates a separate new book (your other books are never touched), and then walks every step of Make my book: the
AI invents the book (title, pen name, genre, readers, tone, idea), drafts the characters and places (Bible
Builder), writes the premise, main plot, chapter outline and every chapter, then Akọwe sets up the book
format, puts the book together, exports **PDF, EPUB and Word** and runs the content check.

**Your consent.** Pressing Start is your consent for *this run only*: each draft is checked by the AI reviewer;
when it says *approve*, the draft is approved and logged as *“approved under your Make-a-book-for-me consent, run
<id>”*. When it asks for changes the AI fixes the draft (at most twice) and it is reviewed again. If it still does
not pass, the run **pauses with a ⚠️** on that step and you decide: **✔ Approve anyway** (your own approval),
**✏️ Edit it myself** then **▶ I edited it — continue**, or **🔁 Try again** (two more AI fixes). Nothing is ever
approved outside a run you started.

**The progress window** shows every step (waiting, working, done, ⏸ paused, ⚠️ problem) with its set and step
code, how long it took and a plain message; chapters and characters are listed one by one. **⏸ Pause**,
**▶ Resume** (continues exactly where it stopped) and **✖ Cancel** are always there. You can close the window — the
run keeps going, and the ⚡ button shows *Making… 4/11*. When it is done you get the download buttons and links to
the book, its journal and your finished books. Runs survive reloading the page and even an Akọwe restart (they
then show *Interrupted — ▶ Resume*).

**When the AI is busy.** If the AI is busy or cannot be reached, Akọwe waits and tries again by itself (15 s,
30 s, 60 s, 120 s … up to about 10 minutes; change it in Settings → *When the AI is busy*) and shows *“Waiting for
Claude (busy) — retrying in 30 s”*. A slow answer (time-out) is never retried automatically, because the first
answer may still arrive: the step pauses with a ⚠️ and **🔁 Try again**.

**When one AI breaks, the others take over.** Before a run starts (and before ✍ Write all chapters and 🧪 Test
workflow) Akọwe asks AutoInjector to check in with every AI (up to a minute) and the window shows **AIs:**
*✔ AI-1 · Claude — working · 🔧 AI-3 · Gemini — being repaired · ⚠️ AI-2 · ChatGPT — needs you (logged out)*.
An AI that AutoInjector is repairing, that needs you (logged out, “are you human?” check, usage limit) or that is
broken is skipped: its work goes to an AI that works (the run notes *“… is being repaired — this went to AI-2 ·
ChatGPT instead”*), and it is used again as soon as it works. If no AI works, the step waits and tries again.

**Writer ≠ reviewer.** The AI reviewer is always a different working AI from the one that wrote the draft (a
different site first; Settings → *Reviewer AI* can name one), and each step shows *“written by AI-1 · Claude ·
reviewed by AI-3 · Gemini”*. An AI fix after *revise* goes back to the AI that wrote it. When only one AI works it
reviews its own writing, and the run window, the review queue, the journal and the run summary say ⚠️ *“Reviews are
not independent — the same AI wrote and reviewed this”*.

## 🖋 The editor (craft, not only consistency)

The AI reviewer checks that a draft fits the plan and the canon. The **editor** reads it like a demanding human
editor, after that review: **subtext** (are feelings shown rather than announced?), **characters with their own
goals** (do side characters resist, bargain, refuse?), **distinct voices**, **obstacles from the world**, **theme
carried, not stated**, **varied prose, no tics**, **real stakes**, **an earned ending** (last chapter only) and
**protected mysteries kept**. Each dimension gets a score from 1 to 10, and every note quotes the exact passage, says
why and suggests a change; the editor also lists what works and must be **kept**. Friction must come from the
characters and the world, never from random accidents. The editor is never the AI that wrote the chapter when
another AI works (⚠️ otherwise, as for reviews).

Before the editor reads, Akọwe's own **pattern check** (no AI) counts repeated habits: stillness and gesture
phrases (“went very still”, “for a long time”, “looked at”…), “Not X. Not Y.”, lists of three, paragraphs that end on
a moral, feelings named in dialogue (“I'm afraid”, “half of me”), fancy dialogue tags, sentences of the same length or
the same opening, overused words, who has the dialogue, and reassurance that removes the risk (“It won't hurt
anyone”). The editor gets these counts; you see them under **🔎 Pattern check** on the chapter page.

- **In ⚡ Make a book for me** (on by default): a chapter whose editor says *revise* goes back to the AI that wrote
  it, which rewrites **only the flagged passages**. Akọwe applies each change word for word (a change that does
  not match the text exactly, or would remove a passage to keep, is left out — never guessed), saves a new version
  and checks it again: Akọwe's checks, the consistency reviewer, the pattern check and the editor. The rewrite is
  kept only if nothing got worse; otherwise the earlier text is put back. At most **2 rounds** per chapter; if the
  editor still has notes then, the chapter is approved under your run consent anyway and marked ⚠️ *“editor still
  had notes”* — the run summary lists those chapters and notes. The editor never holds up the whole book.
- **On a chapter page / in Needs your approval:** **🖋 Editor review** shows the scores bar, the notes and what to
  keep. **✍ Apply editor's fixes** asks the writer for the changes and shows **before → after** for each passage;
  untick what you do not want and **💾 Save the chosen changes as a new version** (you approve it as usual). The
  premise, main plot and outline can be read by the editor too (a lighter rubric, notes only).
- **Settings → 🖋 Editor:** on/off (for runs), **Editor rounds** 0–3 (0 = notes only), **Strictness** gentle /
  normal / strict (when scores and notes count as *revise*: normal = any major note or any score below 6).

The editor's scores and notes are advice stored for exactly that version; the journal shows the verdicts and counts,
never your text. What the editor checks is written in one plain file, `akowe/editor_rubric.py`.

## 🎭 Characters who are their own people, 🎬 scenes planned before writing

- **Character sheet** (every character): what they **want**, what they really **need**, their **fear**, what they
  **hide**, what they **wrongly believe**, what they do **under pressure**, what they would **never say out loud**, a
  **private memory**, how they stand with each other main character (**tension, history**), **how far they can
  change** — and for side characters **a wish of their own** that is not about the main character.
- **Voice card** (every character): sentence **rhythm**, **register**, words from their **job, era and place**,
  **favourite phrases**, words they would **never use**, **habits** in conversation, how they talk under **fear,
  anger or grief**, what they **talk around**, and 2–3 **sample lines**.
- The AI fills both when it makes characters (Bible Builder, ✨ Make up characters, ⚡ Make a book for me, Fill with AI
  on the character form). Open a character (its record page) to read them as a card: **✏️ Change them** (every field
  has an ⓘ), or **✨ Write them again with AI**. A Make-a-book run has a step **Character sheets and voices**; a
  character without them gets them there. Changing a sheet never changes the approved character itself.
- **Scene cards** (every chapter): before a chapter is written its scenes are planned — place and time, who is there,
  what **each** of them wants in the scene and keeps hidden, an **obstacle from the book's world** (weather of the
  place, equipment, an institution or rule, money, work, another person's interest — never a random accident), what
  **changes**, what stays **unsaid**, and which part of the outline it serves. The chapter outline stays the plan of
  the whole chapter. In ⚡ Make a book for me your writer AI plans them, **another AI checks** them (does every scene
  have goals, a real obstacle and something unsaid?), the writer reworks them up to twice, and they are approved
  under your run consent (⚠️ when the checker still had notes — it never holds up the book). On the book page each
  chapter row shows **🎬 n scenes**; **✨ Write it with AI** plans them first when there are none. Open them to read,
  change, check with AI, plan again or **✔ Approve** them.
- **The writer** gets, in every chapter prompt: the scene cards, the voice cards of the characters in that chapter
  (at most four in full, the others in one line), and the narrator's / point-of-view character's **name and planned
  backstory** — so planned details reach the page.
- **The editor** checks **Distinct voices** with the voice cards (“with the names hidden, can you tell who is
  speaking?” — its notes quote the line that sounds like someone else) and, when a chapter has scene cards, **Scene
  plan kept** (goals, the obstacle and the unsaid thing really on the page). The pattern check (no AI) adds a **voice
  check**: per speaker words per line, questions, shared words, favourite phrases used and **never-words** used.

## 🗂 Character Forge: a full dossier for every character

Every character gets a **dossier** (🗂 Character Forge on the character's card, or More ▾ → 🗂 Character Forge): 14
numbered sections — record, inner life, relationships and page essentials, voice card, detailed appearance, fighting
style, weapons and possessions, powers and their rules, skills, physical limits, knowledge, a backstory timeline, the
storyline and a continuity reference — in a dark, gold-and-teal look with the portrait and a **ten-view reference
plate** (front, 3/4 front, side, 3/4 back, back, idle, tool reach, empty-hand attack, dash, defend).

- **Letters** on every entry (C Canon · P Personality · V Voice · A Appearance · F Fighting · M Magic · K Knowledge ·
  R Relationships · S Story · E Essential on-page detail): click letters to see only those cards. Chapters get only the
  approved details whose letters they need (appearance when a character first appears, fighting in a fight…).
- **✨ Invent the rest**: your AI fills the empty fields as **proposals** (a few short AI calls). Your own text and
  🔒 protected fields are never changed. ✔ Approve each proposal, ✎ edit it, or ✔ Approve all proposals; the dossier
  is READY when nothing waits.
- **One truth**: the inner life, relationships, "must reach the page" and the voice card ARE the character sheet and
  voice card (an approved change in one shows in the other); the role, identity, traits… come from the character
  record when it has them.
- **Pictures**: 🎨 Stable Diffusion or 💬 ChatGPT through AutoInjector (portrait, each view, all ten views with one
  seed, or one turnaround sheet), or ⬆ upload your own. Settings → 🎨 Pictures has AutoInjector's address and key.
- **⬇ Dossier PDF**: cover with the portrait, the landscape ten-view plate, then every section as cards — saved with
  the book in `Character Forge/` too.
- **🧪 Load the Moki Vey example** to see a finished dossier straight away. Details: `docs/CHARACTER_FORGE.md`.

## 🌍 Story rules, world texture, the plan on the page, ending and style

- **🎚️ Ending and style (book profile, all optional).** In the 🚀 wizard, the book profile (Edit) and ⚡ Make a book's quick
  settings you can choose the **ending** (neat / bittersweet / open / dark), **how much is explained** (explain
  everything / hint / leave the mysteries), **darkness and peril** (gentle / some danger / real danger) and the style —
  **dialogue** (little / some / lots), **pace** (slow / medium / fast), **humor** (none / some). Everything defaults to
  **Let the AI choose**. Inside, the ending is an *ending-state* table — external plot complete/incomplete, the main
  decision made/deferred/reversed, relationships reconciled/damaged/ambiguous, guilt resolved/reduced/persistent/
  displaced, social consequences settled/pending, the mystery explained/bounded/protected, future identity
  known/uncertain; each simple choice fills it in, and **More ending options** lets you change single rows. The premise,
  plot and outline prompts, the scene plans (peril shapes the obstacles), every chapter prompt (the ending table only in
  the last chapter) and the editor (what it expects of the ending and the mysteries, and how strict it is about them)
  follow your choices.
- **📏 Story rules** (More ▾ → 🌍 Story rules and world, or the book page): what is **law** in this world (a hard rule),
  what people have only **seen happen**, what characters **believe**, and which **mysteries must stay unexplained** —
  each with its **limits** (where, when, how often, at what cost), where it comes from and who states it. Your AI drafts
  them from your characters, places and plan; when those change, **✨ Suggest updates** lists changes you accept or
  reject one by one (⚠️ when the rules may be out of date). A rule or exception without limits gets ⚠️ *not bounded*.
  The writer never breaks a hard rule, never turns a belief or mystery into fact; the editor (**Story rules kept**) and
  the AI reviewer flag violations with the exact passage; plot and outline reviews say when an exception is used but
  not bounded. “Leave the mysteries” in the profile keeps every mystery unexplained; “explain everything” lets the last
  chapter explain them.
- **🧺 World texture**: concrete details of work and trade, weather and sea, institutions, local people and money — each
  with what it can **cause** (it gets in the way, shows skill, or costs something). Scene plans take their obstacles from
  it, the writer gets a few per chapter, and a detail is used only if it causes something, shows skill or gets in the
  way. Akọwe counts how often each one is on the page (⚠️ never used / used too often).
- **✅ Planned to page**: on every chapter page a checklist of what the plan says must reach the reader — the outline
  beat, each scene's obstacle and change, the narrator's / point-of-view character's **name** (in their first chapter)
  and the **must show** details of the character sheets — with ✔ / ⚠️. Akọwe looks for the words first, then an AI
  that did not write the chapter checks what is unclear. **✨ Fix with AI** asks the writer to work only the missing items
  into the right passages; you see before → after and save a new version. The book page lists what is still missing in
  the whole book. In ⚡ Make a book it runs after the editor (one fix round, kept only if the reviewer passes it); what is
  still missing is marked ⚠️ and listed in the run summary — it never holds up the book.
- ⚡ **Make a book for me** has two new steps: **Story rules and world texture** (after the character sheets; the rules
  are updated for the plan after the outline, accepted under your run consent) and **Planned details on the page**
  (before the book is put together).

## 📊 Book report, ⚖️ compare versions and 📏 longer books

- **📊 Book report.** When a ⚡ run finishes (its last step), or from the book page, the shelf or **📊 Book report**,
  Akọwe makes a quality report of the book: scores from 1 to 10 for atmosphere, premise, plot continuity,
  structure, prose clarity, world distinctiveness, character differentiation, psychological complexity, realism, rule
  rigor, peril and uncertainty, subtext and the ending; **strengths and weaknesses with quotes** (⚠️ when a quote is not
  in the book word for word); what the editor, the planned-to-page check and the pattern check found across all
  chapters; words per chapter against the length; **which AI wrote, reviewed and edited what**; and **what to try
  next**. The whole book is read by every working AI that did **not** write most of it (independent); Akọwe shows
  the middle score (median) per dimension and ⚠️ where the AIs are 3 or more points apart. A short book is sent whole;
  a long one as a digest of every chapter (opening, a middle passage, ending). **📨 Ask the other AIs to review this
  book** lets you choose AIs (the writer is marked ⚠️ not independent). **⬇ Markdown** and **⬇ PDF** download it as
  “<Book title> - Akọwe report - <date>”. Reports are kept per book version (⚠️ when a chapter changed since).
- **🧪 Variants and ⚖️ compare.** ⚡ quick settings → *Pipeline (advanced)*: switch off the editor, scene cards, voice
  cards, story rules or the planned-to-page check (preset **Baseline** = all off, like the first automatic book).
  **🧪 Make a variant** (book page, report, shelf) makes the same book — same profile, idea and choices — again with
  other switches. **⚖️ Compare** (shelf, book page, `#/compare`) gives two books or two chapter versions to your AIs
  **blind**: each sees “Version 1” and “Version 2” in its own random order, scores both and picks one; then Akọwe
  reveals which was which and shows a table with the median scores and the winner per dimension.
- **📏 Lengths.** Short story (~3,000–5,000 words, 3–5 chapters), novelette (~10,000–15,000, 5–8), novella
  (~20,000–40,000, 8–15) and novel (~60,000–90,000, 20–35). The outline gets the chapter count and words per chapter,
  the scene plan the number of scenes and words per scene, every chapter prompt its word target. Chapters longer than
  about 2,500 words are **written scene by scene** (one AI answer per scene) so web AIs never hit their reply limit; a
  chapter that comes back far too short is **continued once within its scene plan** — never padded (the editor still
  checks it). The run window shows **⏳ about N min left** (from this run's measured times). Settings → **📏 Long
  chapters**: words per AI answer, continuation rounds, what counts as far too short.

## 💾 Your books folder: save, open again, make again

**Where books are saved.** Every book gets its own folder in your *books folder*: on Windows
`Documents\Akowe Books` (elsewhere `Akowe Books` in your home folder). Change it in **Settings → 📁 Where books
are saved** (Akọwe checks that it can write there; **📂 Open folder** shows it in Explorer). A book's folder is
called “*Book title* (abc123)” and keeps that name even when you rename the book.

**What is in a book's folder** (a `README.txt` in each folder says the same):

| Folder / file | What it holds |
|---|---|
| `Book/` | the finished book: PDF, EPUB and Word (once it is exported) |
| `Chapters/` | every chapter as a text file (`01 - Title.md` …); a chapter not approved yet says **DRAFT** at the top |
| `Book Bible/` | everything the book is built on: profile, ending and style choices, characters with their sheets and voice cards, places and world, premise, plot, outline, scene cards, story rules, world texture — `book-bible.md` to read, `book-bible.json` for Akọwe |
| `Reports/` | the book report (Markdown and PDF), the editor's and the planned-to-page summaries |
| `Log/` | the book journal and `run-events.json` (every step of the run, which AI did what, times, problems — never keys or prompts) |
| `Progress/` | `progress.json`: what is done and what comes next |
| `book.akowe` | the **whole book in one file** (every version and file, with checksums) — to open it again, also on another computer |

**Saving.** Press **💾 Save** on the book page, in the top bar (while a book is open), on a book of 📚 My finished
books or in the ⚡ run window; it says **Saved to …** with the folder (or ⚠️ with what to do, for example when the disk
is full or the folder cannot be written). With **auto-save** (on unless you switch it off in Settings) Akọwe saves
by itself while a book is made — after each step and chapter, at most every 2 minutes — and at once when it is
finished, paused or stopped. Akọwe only ever replaces the files it wrote itself; your own files in the folder stay.

**📂 Open a saved book** (top bar or Your books): pick a book from your books folder, or upload its `book.akowe`.
It always opens as a **new** book (“… (opened)” when you already have one with that title) — nothing is overwritten.
An unfinished book shows **▶ Continue making this book** (the AI does the steps that are left; what is done is kept),
and **▶ Resume the saved run** when its run was stopped half-way.

**🔁 Rerun from the book bible** (book page, 📚 My finished books, or 🔁 in the 📂 folder list): a **new** book with
the same profile, choices, characters (with sheets and voice cards), places, story rules and world texture — and, if
you keep the tick, the same premise, plot, outline and scene cards — with **new chapters**. You can also upload just a
`book-bible.json` (for example one you edited by hand) to make a new book from it. Pressing 🔁 Start is your consent
for that run: the saved characters and plan come into the new book as drafts and the AI reviewer approves each one
there (the run window and the book journal say so).

## ✍ Write all chapters

On Make my book, once the outline is approved, **✍ Write all chapters** writes every unwritten chapter one after
another (context + prose) with a progress list and **✖ Stop after this chapter**. The chapters land in **📝 Needs
your approval** — nothing is approved for you (unless you turned on auto-approve after AI review).

## ⚠️ Problems are shown where they are

Whenever something goes wrong, a yellow **⚠️** appears on the exact thing that has the problem — a step, a set
tile, a step in the side bar, a form field, an AI slot, a test row, a run step or the ❤️ health icon. Click it to
see **Where** (book › set › step › field), **What happened** in plain words (the technical code is folded away),
**How to fix it**, and a button that does it: **🔁 Try again**, **✏️ Open the form** or **⚙️ Open Settings**, plus
**📋 Copy diagnostics**. Form fields the server refuses are highlighted with their own ⚠️ and message. If the page
hits something unexpected (or Akọwe stops answering) a ⚠️ bar appears at the bottom instead of failing silently.

## ❤️ Health, 📋 diagnostics and background work

The **❤️** in the top bar turns **💛** or **⚠️** when something needs attention. Akọwe checks about once a minute
while the page is open: the database (read and write), free disk space, recent backups, each AI slot, the
AutoInjector link and status updates, your exported files (still present and unchanged) and stuck background
work. Click it for the **Health** panel: each check with ✔ or ⚠️, details and how to fix it, **🔁 Run checks now**,
and **🧵 Background work** — runs, Write-all-chapters, Fill with AI, AI reviews and Bible Builder runs, including
ones *interrupted* by a restart, with **▶ Resume** or **Dismiss**.

**📋 Copy diagnostics** (Health panel, every ⚠️, Settings) copies a report you can paste into a message: versions,
system, port, health results, recent error codes, job states and AI slot types. It never contains your keys,
tokens, prompts, AI replies, book titles or book text. **⬇ Download diagnostics** saves it as a file.

## 📜 Book journal

**📜 Book journal** (More menu, Overview, Make my book) is a readable timeline of everything that happened to a
book: who did what, which AI and model, every approval and its kind (*by you*, *auto-approve*, *Make-a-book
consent*), AI reviews and fixes, waits and retries, pauses, problems, backups and exports. Filter by set and show
*⚠️ Problems only*; **⬇ Download (.md)** saves it. It never contains keys, prompts or your text.

## 💾 Automatic backups

Akọwe backs up all your books automatically: once a day (first start), before ⚡ Make a book for me, before
putting a book together and before exporting. Each backup is verified; the newest 10 are kept (change it in
Settings → Backups). **💾 Back up now** makes one any time. **↩ Restore** puts *all* your books back to that backup —
it asks you to tick a box and type **RESTORE**, first saves a safety backup of how things are now (so you can undo
it), and refuses while a run is working. Keys are never part of a backup.

## 📝 Word count and 📚 My finished books

Make my book, the Overview and the Current task card show how many words the book has (approved and in drafts)
against a target from its length (short story ~4,000, novelette ~12,000, novella ~30,000, novel ~75,000), with a progress bar; each
chapter shows its own count. **📚 My finished books** (More menu, Your books, Overview) lists every exported book
across your projects, newest first, with its formats and download buttons; each file is checked against its
fingerprint first (a damaged one shows a ⚠️ with *Export again*).

## A clearer look

The top bar is a dark band, the side bar its own tinted area, and the work area light. Colors mean the same
everywhere: **green = done**, **amber = needs you**, **purple = AI can do it**, **blue = working** (animated),
**grey = waiting**, **yellow ⚠️ = problem**. Every module set A–K has its own color on tiles, the side bar,
breadcrumbs and step chips. The page you are on is highlighted (“👉 You are here”), and the New book wizard and
Make my book show a step rail of the whole flow. It works on phones (390 px) and desktops without sideways scrolling.

## ▶ Current task and 📝 Needs your approval

The left side bar always starts with two things:

* **▶ Current task** — one big button that takes you to exactly the thing your book needs next: the review
  queue at the first draft waiting for you, the chapter to write, the book format to set up, and so on. Under it
  a one-line explanation and where it lives (for example *Set B · B03*). The same card is on the Overview (and on
  phones, where the side bar is behind **Menu**).
* **📝 Needs your approval (N)** — opens the review queue. The number updates after everything you do, and every
  10 seconds while the page is visible.

**The review queue** lists every draft waiting for your approval, in book order (characters and places → planning →
chapters → book format → assembly …), grouped by step, with who made it (your AI and its model, or you) and the AI
reviewer's verdict if you asked for one. Each draft has **Open**, **✅ Approve**, **✏️ Edit**, **⏭ Skip** (for now)
and **🤖 AI review**. **▶ Step through them one by one** shows one draft at a time with big buttons **✅ Approve &
next**, **⏭ Skip**, **✏️ Edit** and **🤖 Ask AI to review**; after each one the next draft opens, until you see
**All caught up** and your next Current task. **✅ Approve all shown (N)** asks once, listing everything it will
approve; drafts that could not be approved are explained in plain words and stay in the list.

**🤖 AI review** sends one draft (with your book profile and the records it was built from) to the AI you pick and
asks it to act as a strict editor: it answers *approve*, *revise* or *reject* with reasons and suggested changes.
It is advice only and is shown on the draft and in the queue. For *revise* you can press **🤖 Ask AI to fix it**
(the AI makes a new version of the draft for you to review) or **✏️ Edit myself**. **🤖 Review all with AI**
reviews the list one draft at a time, with progress and a **Stop** button.

**Auto-approve (optional, off by default).** At the bottom of the review queue you can tick *Auto-approve drafts that
pass the AI review*. Akọwe asks you to confirm and remembers who turned it on and when. While it is on, a draft
whose AI review says *approve* is approved in your name without you reading it; *revise*, *reject* or a failed review
never approve anything. Every automatic approval appears in **Activity**, marked as approved under your standing
setting. Untick it any time.

## 🧪 Test workflow

The **🧪** button in the top bar opens a panel on the right where you can test — and re-test — each part of making a
book with your real AI: AI connection, premise, main plot, chapter outline, chapter context and text, AI review,
approvals, book format, assembly, PDF/EPUB/DOCX export and the content check. Each row has **▶ Run / 🔁 Re-run**,
its result (*Pass*, *Fail*, *Skipped* with the reason), how long it took, when it last ran and **details** with what
happened and what to do. **▶ Run all** runs them in order (rows that need a failed row are skipped); **Stop** stops
after the current row. Everything happens in a separate test book called **“🧪 Workflow test <date>”** — your books are
never touched, and approvals in the test book are made by the test runner because you pressed Run. Without a
connected AI the AI rows say *Skipped — connect an AI* and the other rows still run with a fixed test text. Each run
writes `reports/workflow-test-<stamp>.md` and `.json` (no keys or prompts; at most an 80-character excerpt of an AI
answer); **📄 Open report** shows it. Test books are listed apart from your books on the home page.

## Connect AutoInjector with one button

In the AutoInjector desktop app press **Connect** next to Akọwe: your browser opens Akọwe, which says
*Connecting to AutoInjector…*, connects AI-1 = Claude, AI-2 = ChatGPT and AI-3 = Gemini, checks each one and then
takes you to your Current task. The one-time code in that link works once, for about two minutes, and is removed from
the address immediately; it is not your connection key (the key is stored privately and never shown). If it says the
code expired, press Connect in AutoInjector again. (Akọwe remembers its access token in this browser so that tabs
opened by AutoInjector work; if you never opened Akọwe from its start link in this browser, open it once first.)
Once connected, Akọwe keeps AutoInjector informed with a short status — the book's title, your current task, what
Akọwe is working on and how many drafts wait for you (titles only, never your text) — so AutoInjector can show it
and link back.

## How to get around

* **🧩 Sets** (top bar) opens a launcher of the 11 module sets; the Overview shows the same sets as
  big tiles. Each tile shows its records and how many steps have an approved record.
* Click a set to open its **panel**: what the set is for in plain words, where it fits in the build
  order and which sets it needs or feeds, **quick actions** written from the set's specification
  (for example **Make up characters for me** in Universe & Characters, **Draft a premise for me** in
  Story Planning, **Export a PDF** in Assemble & Export), every step with its status and **Open**,
  **New** and **✨ Make some for me**, and the recent records with Copy/Open. Esc or ✕ closes it.
* **✨ Make some for me** asks your AI for 1–10 proposals (pick the AI per request, add roles or
  anything it should know). Every proposal shows which AI made it; you **Use it in the form**,
  **📋 Copy** it, or (for universe entries) save the ticked ones as drafts. Nothing is saved or
  approved on its own.
* **Breadcrumbs** at the top of every page (Your books › Book › Set › Step › Record) are clickable.
  Step pages have **◀ Previous / Next ▶** buttons in the set's working order (crossing into the next
  set at the end) and a **👉 What's next** hint along the main path A → B → C → E → F → G → H.
* **🔍 Jump** (or **Ctrl+K**, or **/**) finds any step by ID or name (`A01`, `premise`), a set, a page
  or a record; ↑ ↓ and Enter to go. The browser's Back and Forward buttons work everywhere.
* **More ▾** holds Progress, Activity, Book features, the 📖 Bible Builder and 🧪 Test everything.

**Copy and paste.** On a record: **📋 Copy text** (a readable summary), **📋 Copy JSON** (its data),
**📋 Copy ID** and **⧉ Duplicate as new draft** (opens the New form filled with this record; you
review it and press Create). On New and Edit forms, **📥 Paste** reads the clipboard: JSON fills the
matching fields (unknown fields are skipped and listed); plain text goes into the main text field or
becomes the request for ✨ Fill with AI. If the browser does not allow reading the clipboard, a paste
box opens instead (press Ctrl+V there).

## Test everything

Press **🧪 Test everything** (top bar → **More**) (or run `python -m akowe selftest`) to check that
the whole program really works on this computer. It is a real test, not a simulation:

1. It creates a new, separate project named **"Self-test <date time>"** (your projects are not
   touched; open it afterwards to inspect every record, or ignore it).
2. Kernel checks: the contract package loads (and its SHA-256 is recorded), bad input is
   rejected, a repeated request is replayed instead of duplicated, an outsider is refused, and an
   out-of-date edit is rejected.
3. A two-chapter book goes through the real operations, in order: profiles (I01), places and a
   character (A04/A01), an AI fill of the character form (A01, AI mode only; never saved), premise (B01), plot and outline (B03/B11), chapter context and prose
   with story events (C01/C02), story state (E01/E02), an edit pass whose anchored F01 patch is
   applied through C11 (old work is marked stale and replayed), assembly (G02/G01/G05/G04/G07),
   PDF/EPUB/DOCX exports (G11/G12/G13, each file re-read by the independent H09 parsers), quality
   checks (H02/H03/H05/H07/H08/H09), final readiness H10 and the release approval with a K09
   approval of that exact candidate.
4. Each step shows **PASS ✔ / FAIL ✕ / SKIPPED –** with what happened, how long it took, the
   records it made and, when something fails, what to do. One failure never stops the steps
   that do not depend on it; dependent steps say "needs step X".

By default creative steps use fixed text, labelled **MANUAL (no AI)**: nothing is sent anywhere
and the run takes a few seconds. Tick **Use my AI slots too** (CLI: `--ai`) to first health-check
each connected AI slot and then really send the premise (B01) and one chapter draft (C02, plus
its event extraction) to your AI. A slot that is not set up or not reachable makes those steps
SKIPPED with the exact reason and fix; the rest of the book still runs manually.

The report is saved as `reports/selftest-<stamp>.md` and `.json` in your Akọwe data folder
(the dialog offers **View report**, **Download report (.md)** and **Open the Self-test project**).
It lists the date, Akọwe and contract versions, package hash, Python/OS, the AI slots
(without keys), a summary table, every step with details and timings, the exported files' sizes
and hashes, and environment notes. It never contains API keys, connection keys, access tokens or
AI prompts/replies (only their lengths and hashes).

API: `POST /api/selftest {"use_ai": false}` starts a run (409 while one is running),
`GET /api/selftest` returns live progress and the last summary, `GET /api/selftest/report?format=md|json`
returns the latest report (all need the access token). `GET /api/ping` needs no token and only
answers `{"app": "akowe", "version": ..., "contract_version": ...}` so AutoInjector can see that
Akọwe is running.

## Using AI (optional)

Akọwe has exactly three AI slots (AI-1, AI-2, AI-3), configured under **Settings**.
The bundled adapter uses Anthropic's Claude (default model `claude-opus-5-5`); it needs the
optional `anthropic` SDK - a recent release, so install or update it with
`python -m pip install --upgrade anthropic` (it is not in `requirements.txt` because manual and
AutoInjector slots do not need it) - and an API key (entered in Settings - stored in a local
secret file, never in project data or exports - or set `ANTHROPIC_API_KEY`). A missing or too-old
SDK shows a plain "install/upgrade anthropic" message instead of failing the step.

**Cost cap.** When a K12 cost ledger is configured for the current month (for the slot, e.g.
`AI-1`, for the project, or for `default`), every paid AI call first reserves its worst-case cost
(slot prices x estimated input and `max_output_tokens`) and settles the actual cost afterwards. If
the cap does not have room, the work is held with `QUOTA_EXCEEDED` and the AI is not called.

**Experimental: AutoInjector web sessions.** Instead of an API key, a slot can use the
ChatGPT, Claude or Gemini web session you are already logged in to inside the AutoInjector
desktop app (adapter `autoinjector`). In AutoInjector open the **Akọwe bridge panel**, switch
the bridge on and press **Copy connection key**; then in Akọwe **Settings** paste it into
**Connect AutoInjector** (AI-1=Claude, AI-2=ChatGPT, AI-3=Gemini). Each slot shows a status
strip — where it's at (Not set up, Needs connection key, Connected · Ready, Busy, Error) and the
next step in plain words — and the ⓘ buttons explain AutoInjector, the connection key and
**Test connection**. The bridge only listens on `http://127.0.0.1:17891`; the connection key is
stored in the local secret file like an API key and is never shown again. Each slot
may list `roles` (operation IDs such as `C02` or set letters such as `B`) to route that work to
it. Automating these sites' web interfaces may be against their terms of service; use at your
own risk. Contract: `../docs/AKOWE_AUTOINJECTOR_BRIDGE.md`. With AutoInjector's self-repair (bridge 1.2) the
strip and the ❤️ Health panel also show *🔧 Being repaired*, *Needs you* (with the reason, e.g. logged out) or *Not
working*; meanwhile Akọwe sends the work to the other AIs.

Akọwe's default port is **8780** (8765 is used by AutoInjector's extension bridge).

Slots are optional. Without one, every creative operation offers a **Manual candidate**
form so you write that content yourself; deterministic operations (validation, state
tracking, exports, checks) never need AI. Only the selected slot receives a context package,
and paid generation is never silently retried after an ambiguous timeout.

## Fill with AI

On every Universe page (A01-A18) and on every AI or hybrid step of Planning, Writing, Art, Editing and
front/back matter (B, C, D, F, G08/G09) whose form has fields an AI can propose, there is a **✨ Fill
with AI** button next to the New form. Story state (E), quality checks (H), reconciliation (J),
storage (I), orchestration (K) and every deterministic step never take AI proposals.
It opens that module's own panel (several can be open and running at once). Type what you want
(for example "a grumpy lighthouse keeper who hides a secret"), pick an AI (Auto, or AI-1/AI-2/AI-3
with each slot's current status), optionally tick existing records to use as context, and press
**Generate**. While it runs the panel shows what it is doing and for how long (web AIs can take a
few minutes). When it is done you see a readable preview, the checks, and any links the AI made up
that were removed. **Use this in the form** fills the New form for you to review. Nothing is saved
until you press Create.

How it stays consistent: the AI gets the module's purpose and form schema, what you already typed
(kept unless you untick "Keep what I already typed"), a short summary of the project's approved
Set A canon (names, IDs, key facts, protected facts word for word), the names of draft canon, and
the predicate conventions, and the book profile (title, genre, audience, length, tone, idea). The answer is checked without saving anything: the form's schema
validator, every link resolved against this project and branch (made-up links are removed and
listed), and the module's own fact and canon checks. Protected-fact flags are always yours.
With no AI ready you get "Connect AutoInjector in Settings, or add an API key".

API: `POST /api/assist {project_id, branch_id, target_operation, prompt, slot_id?, context_refs?,
current_values?, keep_values?}` -> `{job_id}`; `GET /api/assist/{job_id}` -> status, slot, model,
elapsed_ms, proposal, findings, removed_refs, error {code, message, fix}; `POST /api/assist/{job_id}/cancel`.

## Bible Builder

**📖 Bible Builder** (top bar, and on the Universe workspace) drafts the story bible from your book
idea. Every section (characters, species, worlds, locations, governments, factions, cultures,
religions, magic - only when the magic feature is on - technology, weapons, items, history, timeline,
languages, economy, laws, relationships) has a checkbox, a "how many" number (0 = skip) and its own
**Generate** button with a live status line; **Generate all ticked** runs several together, and
**Tick the starter set** suggests 4 characters, 3 places, a world, a culture, a government and a
magic or technology system. Each run first asks for a short world sketch (names, roles, links) and
then generates every entry, so names stay consistent; later runs build on earlier entries.
Pick the entries to keep (Edit or Regenerate any of them), then **Create selected as drafts**: they
are created as DRAFT records in dependency order, so sketch links (a character's home location, for
example) become real links to the records just created. Nothing is validated or accepted for you.

After every run and every create a report is written to `reports/bible-builder-<stamp>.md` and
`.json` in your Akọwe data folder (View/Download in the panel): sections requested, AI slot and
model, each entry's outcome and timing, created record IDs versus discarded ones, links made and
made-up links removed. It never contains keys, prompts, AI replies or your idea text.

API: `POST /api/bible-builder {project_id, branch_id, idea, counts?, slot_id?}`,
`POST /api/bible-builder/{id}/run {sections: {A01: 4, ...}}`, `.../regenerate {item, prompt?}`,
`.../create {items, edits?}`, `.../cancel`, `GET /api/bible-builder/{id}`,
`GET /api/bible-builder/{id}/report?format=md|json`.

## How work flows

* **CREATE** makes an immutable DRAFT. **VALIDATE** runs the owner's checks and returns
  findings. **ACCEPT** approves the exact revision (some steps - protected canon changes,
  polish, release - also need a K09/I10 approval for that exact candidate). **UPDATE**
  makes a new revision; approved content is never edited in place.
* Every record pins its inputs by version and SHA-256. When an approved input changes, the
  records built from it (and their descendants) are marked **STALE**; unrelated records keep
  their exact hashes.
* Retries are safe: each submit carries an idempotency key.
* The project **feature manifest** selects art, magic, mystery, foreshadowing, character
  arcs and release profiles (manuscript PDF, print interior, print wrap cover, EPUB, DOCX).
  Disabled features answer NOT_APPLICABLE.
* **H10 Final Readiness** reports READY only when every selected mandatory check passes
  against the exact frozen export bytes and sources.

## Known limits

* Exports use the PDF base-14 fonts (Times/Helvetica/Courier) and are not embedded; print
  interiors therefore fail the H09 font-embedding check until font import/embedding is added.
* The official EPUB validator **EPUBCheck** is optional. Without it the EPUB is still checked by
  Akọwe, and the H09 report adds a note "not checked by EPUBCheck" (it does not block the
  release). To add the official check: install Java (11 or newer), download EPUBCheck from
  https://www.w3.org/publishing/epubcheck/ and unzip it into `akowe/tools/` so that
  `akowe/tools/epubcheck-<version>/epubcheck.jar` exists - or set the environment variable
  `AKOWE_EPUBCHECK` to the full path of `epubcheck.jar` (or of an `epubcheck` program).
  Restart Akọwe; the self-test's environment notes say whether it was found.
* No image-generation adapter is bundled: art operations accept uploaded images (rights must
  be cleared by review) and maps are rendered deterministically as SVG.
* Single-author local use; there is no multi-user server or cloud sync.

## For developers

See [DEVELOPING.md](DEVELOPING.md). Tests: `python -m pip install pytest` then
`python -m pytest -q tests`. The original blueprint (specifications, contracts, acceptance
cases) is in `package/`.
