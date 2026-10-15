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

1. Install **Python 3.10 or newer** from python.org (tick "Add python.exe to PATH").
2. Double-click **`run-bookforge.bat`** in this folder. The first run installs the one
   dependency (`jsonschema`).
3. Your browser opens the workspace. Keep the console window open while you work; close it to
   stop. The console prints the link (with your private access token) if you need to reopen it.

macOS/Linux: `./run-bookforge.sh`. Manual start: `python -m pip install -r requirements.txt`
then `python -m bookforge` (options: `--port 8780`, `--data-dir PATH`, `--no-browser`).

Your projects are stored privately on this computer (Windows: `%LOCALAPPDATA%\Bookforge`;
elsewhere `~/.local/share/bookforge`). The server only listens on `127.0.0.1`.

## Test everything

Press **🧪 Test everything** in the top bar (or run `python -m bookforge selftest`) to check that
the whole program really works on this computer. It is a real test, not a simulation:

1. It creates a new, separate project named **"Self-test <date time>"** (your projects are not
   touched; open it afterwards to inspect every record, or ignore it).
2. Kernel checks: the contract package loads (and its SHA-256 is recorded), bad input is
   rejected, a repeated request is replayed instead of duplicated, an outsider is refused, and an
   out-of-date edit is rejected.
3. A two-chapter book goes through the real operations, in order: profiles (I01), places and a
   character (A04/A01), premise (B01), plot and outline (B03/B11), chapter context and prose
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
