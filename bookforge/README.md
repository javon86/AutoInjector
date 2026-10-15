# Bookforge

Bookforge is a local book-production workspace built from the **BookForge Final Build Plan**
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

1. Double-click **`run-bookforge.bat`** in this folder. If Python 3.10+ is missing, the window says
   so and opens python.org: install it, tick **"Add python.exe to PATH"**, then double-click again.
2. The first start makes BookForge's own Python environment (`%LOCALAPPDATA%\Bookforge\venv`) and
   installs the one dependency quietly (needs the internet once).
3. Your browser opens the workspace. If port 8780 is busy, BookForge picks the next free port; if
   BookForge is already running, it just opens it again. Keep the window open while you work; close
   it to stop. On a problem the window stays open with a plain explanation.
4. Optional: double-click **`create-shortcut.bat`** once to put a **BookForge** shortcut on your
   Desktop.

macOS/Linux: `./run-bookforge.sh`. Manual start: `python -m pip install -r requirements.txt`
then `python -m bookforge` (options: `--port 8780`, `--data-dir PATH`, `--no-browser`).

Your projects are stored privately on this computer (Windows: `%LOCALAPPDATA%\Bookforge`;
elsewhere `~/.local/share/bookforge`). The server only listens on `127.0.0.1`.

## Getting started: Start a new book and Make my book

The first time you open BookForge (and any time from **🚀 New book** in the top bar) a short
**Start a new book** wizard asks, in plain words: 1) your **book profile** — title, author or pen
name, genre, who it is for, length (short story / novella / novel), tone and your idea in a
paragraph; 2) which **AI** to use (each slot with its current status, Automatic, or *Manual — I'll
write it myself*); 3) **what to make** (characters, places, the world, premise, plot and outline);
4) review and **Create my book**. With an AI it starts drafting the characters and places right away.

The **book profile** is shown (and editable) on the Overview. The AI reads it every time it helps,
and the title and author go on the title page and into the exported files. It is stored with the
project (API: `GET/PUT /api/projects/{id}/profile`).

**📘 Make my book** is one checklist for the whole book, in order: book profile → characters and
places → premise → main plot → chapter outline → write each chapter → book format → put the book
together → export (PDF, EPUB, DOCX for the release profiles you chose) → a content check. Each step
says **Done**, **Needs you**, **AI can do it**, **Ready** or **Waiting**, and the big **▶ Do the
next step** button does the next one. Creative steps are written by your AI (or, with no AI, open a
ready-made form for you to write); BookForge never approves anything for you — every approval asks
*"Approve as the author?"*, and when a step needs an explicit approval record (for example a chapter
without an objective review) one is recorded for exactly that version because you confirmed. At the
end **⬇ Download my book** gives you the files. Full release readiness (H10) stays in Quality Checks.
API: `GET /api/projects/{id}/branches/{b}/book`, `POST .../book/{create|write_chapter|approve|setup_format|assemble|export|check}`.

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

Press **🧪 Test everything** (top bar → **More**) (or run `python -m bookforge selftest`) to check that
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

The report is saved as `reports/selftest-<stamp>.md` and `.json` in your BookForge data folder
(the dialog offers **View report**, **Download report (.md)** and **Open the Self-test project**).
It lists the date, BookForge and contract versions, package hash, Python/OS, the AI slots
(without keys), a summary table, every step with details and timings, the exported files' sizes
and hashes, and environment notes. It never contains API keys, connection keys, access tokens or
AI prompts/replies (only their lengths and hashes).

API: `POST /api/selftest {"use_ai": false}` starts a run (409 while one is running),
`GET /api/selftest` returns live progress and the last summary, `GET /api/selftest/report?format=md|json`
returns the latest report (all need the access token). `GET /api/ping` needs no token and only
answers `{"app": "bookforge", "version": ..., "contract_version": ...}` so AutoInjector can see that
BookForge is running.

## Using AI (optional)

Bookforge has exactly three AI slots (AI-1, AI-2, AI-3), configured under **Settings**.
The bundled adapter uses Anthropic's Claude (default model `claude-opus-5-5`); it needs
`python -m pip install anthropic` and an API key (entered in Settings - stored in a local
secret file, never in project data or exports - or set `ANTHROPIC_API_KEY`).

**Experimental: AutoInjector web sessions.** Instead of an API key, a slot can use the
ChatGPT, Claude or Gemini web session you are already logged in to inside the AutoInjector
desktop app (adapter `autoinjector`). In AutoInjector open the **BookForge bridge panel**, switch
the bridge on and press **Copy connection key**; then in BookForge **Settings** paste it into
**Connect AutoInjector** (AI-1=Claude, AI-2=ChatGPT, AI-3=Gemini). Each slot shows a status
strip — where it's at (Not set up, Needs connection key, Connected · Ready, Busy, Error) and the
next step in plain words — and the ⓘ buttons explain AutoInjector, the connection key and
**Test connection**. The bridge only listens on `http://127.0.0.1:17891`; the connection key is
stored in the local secret file like an API key and is never shown again. Each slot
may list `roles` (operation IDs such as `C02` or set letters such as `B`) to route that work to
it. Automating these sites' web interfaces may be against their terms of service; use at your
own risk. Contract: `../docs/BOOKFORGE_AUTOINJECTOR_BRIDGE.md`.

BookForge's default port is **8780** (8765 is used by AutoInjector's extension bridge).

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
`.json` in your BookForge data folder (View/Download in the panel): sections requested, AI slot and
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
* EPUB conformance needs the external **EPUBCheck** tool; without it H09 reports UNKNOWN for
  EPUB output, so an EPUB release cannot reach READY.
* No image-generation adapter is bundled: art operations accept uploaded images (rights must
  be cleared by review) and maps are rendered deterministically as SVG.
* Single-author local use; there is no multi-user server or cloud sync.

## For developers

See [DEVELOPING.md](DEVELOPING.md). Tests: `python -m pip install pytest` then
`python -m pytest -q tests`. The original blueprint (specifications, contracts, acceptance
cases) is in `package/`.
