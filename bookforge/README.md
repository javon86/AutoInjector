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

## Using AI (optional)

Bookforge has exactly three AI slots (AI-1, AI-2, AI-3), configured under **Settings**.
The bundled adapter uses Anthropic's Claude (default model `claude-opus-5-5`); it needs
`python -m pip install anthropic` and an API key (entered in Settings - stored in a local
secret file, never in project data or exports - or set `ANTHROPIC_API_KEY`).

**Experimental: AutoInjector web sessions.** Instead of an API key, a slot can use the
ChatGPT, Claude or Gemini web session you are already logged in to inside the AutoInjector
desktop app (adapter `autoinjector`). Enable the BookForge bridge in the desktop app, copy its
token, then in **Settings** use **Connect AutoInjector (all three)** (AI-1=Claude,
AI-2=ChatGPT, AI-3=Gemini) and **Test connection**. The bridge only listens on
`http://127.0.0.1:17891`; the token is stored in the local secret file like an API key. Each slot
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
