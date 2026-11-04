# What we built, and when (project history)

A plain-words record of every big change, newest first, so that if something breaks we can see what changed and go back.

- **How the program works today:** [HOW_IT_WORKS.md](HOW_IT_WORKS.md)
- **The Book Bible section codes** (`C1c` = eyes, `C11` = all of Looks): [CODE_MAP.md](CODE_MAP.md)
- **The full plan and the status of every item:** [AKOWE_IMPROVEMENT_PLAN.md](AKOWE_IMPROVEMENT_PLAN.md)
- **The 26 story-drift holes and how each was fixed:** [HOLES_2026-11.md](HOLES_2026-11.md)

## How to go back if something breaks

- Every change below is one numbered pull request (PR), such as #112. Each one is a single "merge" on GitHub, so it can be undone on its own.
- Each PR's page on GitHub, `https://github.com/javon86/AutoInjector/pull/<number>`, lists every file it changed and why.
- **To undo one change:** ask Claude to "revert PR #N". This adds a new change that takes it back out and keeps everything after it. Nothing is deleted from history.
- **To see an old version of a file:** on GitHub, open the file and press **History**.
- **On your PC:** in GitHub Desktop, the **History** tab shows the same list.

## The important systems, and the PR that added each

| System | What it does | PR |
|---|---|---|
| **Smart memory (needs lists)** | Before writing a chapter, the planner lists the Book Bible sections it needs, as whole-section codes such as `C11` or `P22`. The writer is sent exactly those sections, plus quotes from earlier chapters. About 10–20% less is sent. | #112 |
| **Book Bible code map** | Every section and detail has a code: KIND letter, then a section number from 0 to 9, then a detail letter. `C1c` = a character's eyes. A whole section repeats the number: `C11` = all of Looks. Corrections name the exact code. | #111 |
| **"Fill the whole Book Bible" switch** | On the Make-a-book start screen (off by default) and as a button on the Book Bible's At a glance page. It fills every section before chapter one instead of as needed. | #111 |
| **Continuity checkpoints** | Every 5 chapters by default, plus a final whole-book read, for 25–50 chapter books. | #110 |
| **Running notes (story ledger)** | Kept after every chapter: injuries, what each person carries, who is alive and where, who knows which secret, story day and season, money, the name list, and the story so far. | #110 |
| **Just-in-time story details** | Looks and speech are decided before chapter one. Fighting, weapons, powers, place interiors, items and spells are decided when a chapter first needs them, then locked. | #109 |
| **How the story treats the characters** | Character-led, Balanced (the default) or Plot-led. | #109 |
| **New top bar and sidebar, Simple/Advanced, Book Bible "At a glance"** | Akọwe in plain names, with the 📖 Book Bible one click away. | #108 |
| **Series progression** | Sequels, per-book character changes and portraits, and an "As of book N" Book Bible. | #100, #102 |
| **Book Bible binder** | 12 templates, 7 genre looks, and PDF and Word export. | #95, #96 |
| **FramePack video** | Uses your FramePack for clips and trailers. Includes the RTX 50-series fixes. | #92, #101, #103, #104 |
| **Media self-test** | 🩺 tests pictures, video and the trailer in one press. | #105 |
| **Alfred** | The app-wide assistant: tools, a side panel, one-button AI setup, a model finder with star ratings. | #74, #82, #84, #86, #105 |
| **Stable Diffusion pictures** | Forge, A1111 or ComfyUI, with character locks and a LoRA library. | #73, #75, #91 |
| **Wan video on ComfyUI** | Local video made through ComfyUI. | #78 |
| **Character Forge dossiers** | Per-character dossiers, and pictures from ChatGPT's image engine. | #77 |
| **Covers, chapter pictures, maps, place/item/magic dossiers** | | #80 |
| **One app, one launcher** | AutoInjector starts Akọwe and shows it in its own tab. | #72 |
| **BookForge renamed to Akọwe** | Existing data was moved over. | #71 |

## Every change, newest first

| Date | PR | What changed |
|---|---|---|
| 2026-11-04 | #? | Story shapes: pick Three acts, Save the Cat, Hero's Journey or Seven-point; each beat is placed on a chapter, written, checked and fixed once if it did not land |
| 2026-11-03 | #112 | Smart memory: per-chapter needs lists, so the writer gets exactly what the chapter needs |
| 2026-11-03 | #111 | Book Bible code map, plus the "Fill the whole Book Bible" switch and button |
| 2026-11-03 | #110 | All 26 continuity and process holes fixed, continuity checkpoints for long books, and HOW_IT_WORKS.md |
| 2026-11-03 | #109 | Story details decided just in time, plus "How the story treats the characters" |
| 2026-11-03 | #108 | Akọwe made understandable: simple top bar and sidebar, Simple/Advanced view, plain names, Book Bible "At a glance" |
| 2026-11-02 | #107 | Extract: "Last 24 hours" after a restart now includes what happened before the restart |
| 2026-11-02 | #106 | 360/1080 sweep: 17 bugs fixed across the desktop app and Akọwe |
| 2026-11-02 | #105 | Model star ratings and speed, the 🩺 media self-test, main character never missing, a whole-journey book test |
| 2026-11-02 | #104 | FramePack on RTX 50-series: switch off attention add-ons that can't run there; honest status after a failed clip |
| 2026-11-02 | #103 | FramePack loads its models from local folders (fixes "OfflineModeIsEnabled") |
| 2026-11-01 | #102 | Series extras: places, items and groups change per book; sequel button; series kept inside the book file |
| 2026-11-01 | #101 | FramePack: fix loading stuck at "starting PyTorch"; timer, real Stop, honest Ready light |
| 2026-11-01 | #100 | Series progression: sequels, per-book portraits, "As of book N" Book Bible |
| 2026-11-01 | #99 | Character pictures during Make a book, plus "Make the rest of the pictures" |
| 2026-11-01 | #98 | Five log problems fixed: duplicate character IDs, site errors, idle carry-on, the event limit, Alfred's stale book |
| 2026-11-01 | #97 | READMEs brought up to date |
| 2026-10-31 | #96 | Story-role titles for every character, spelling-proof ★ main character, Book Bible polish |
| 2026-10-31 | #95 | Book Bible binder: 12 templates, 7 genre looks, PDF and Word |
| 2026-10-30 | #94 | After a check-in, a busy AI is asked to carry on where it left off |
| 2026-10-29 | #93 | Claude's new page layout handled, plus two real timing bugs |
| 2026-10-29 | #92 | FramePack video engine |
| 2026-10-29 | #91 | One model folder in "stuff and thing", shared by all the picture programs |
| 2026-10-28 | #90 | Fixes from the first real-PC test |
| 2026-10-28 | #89 | UI tidy-up (AI windows 25% taller) |
| 2026-10-28 | #88 | Ten open items finished: Alfred's buttons, one place for pictures and video, trailers, tool servers |
| 2026-10-27 | #87 | One tidy folder system, downloads kept and resumed, ComfyUI crash fixes |
| 2026-10-27 | #86 | ▶ Start Alfred, 🔍 Find what's installed, never download twice |
| 2026-10-27 | #85 | Prevention pass: Alfred's memory size, safe picture requests, health watch, weekly live-site check |
| 2026-10-27 | #84 | Alfred side panel by default |
| 2026-10-27 | #83 | Model finder reads the live Ollama library |
| 2026-10-27 | #82 | Alfred's one-button AI setup, model finder, floating panel, personality |
| 2026-10-27 | #80 | Book covers, chapter pictures and maps, item/place/magic dossiers |
| 2026-10-27 | #79 | Nine fixes from the 360 scan |
| 2026-10-26 | #78 | Local video: Wan on ComfyUI and the Video tab |
| 2026-10-26 | #77 | Character Forge dossiers and ChatGPT image engine |
| 2026-10-25 | #76 | Fixes from the 2026-10-25 real-use log |
| 2026-10-25 | #75 | Full Stable Diffusion controls, all driven by Alfred |
| 2026-10-25 | #74 | Alfred: app-wide assistant with 35 tools |
| 2026-10-25 | #73 | Stable Diffusion for real, LoRA library, character locks |
| 2026-10-25 | #72 | One app, one launcher: AutoInjector starts Akọwe |
| 2026-10-25 | #71 | BookForge renamed to Akọwe |
| 2026-10-25 | #68–#70 | First real book fixes: main character kept, tougher reviews, ChatGPT answers no longer lost |
| 2026-10-25 | #65–#67 | Tougher editor, readability, fact checks, continuity, scene grid, beta reader, "your writing style" |
| 2026-10-24 | #62–#64 | 🎯 target picker rebuilt and 🔢 number teach; plan status pages |
| before 2026-10-24 | — | The first builds: the AutoInjector desktop app, the book writer (then called BookForge), the bridge between them, and the self-tests. See the git history. |

New changes are added at the top of this list each time one is merged.
