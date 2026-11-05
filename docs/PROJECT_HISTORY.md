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
| 2026-11-05 | #126 | 🎩 Alfred talks back and can fetch from the other AIs (user: "he doesn't talk to me … I asked him to get a prompt from one of the AIs and then change it, and he didn't do it"): new tool `ask_ai` (💬, "I will" card, may be always-allowed) types a message into ChatGPT / Claude / Gemini and WAITS for that AI's answer to that [MSG #] (the Akọwe bridge's path: a check-in makes way, proven send, the answering reply — tagged or not — goes to Alfred, shown but never relayed; 3-minute wait; an AI an Akọwe request waits on is refused plainly), so he can rewrite it in the same request. Typed "get a prompt from ChatGPT … and make it …" / "ask Claude to …" / "have Gemini write …": a model that answers in words gets one stricter retry, then a one-click **💬 Ask ChatGPT now** card (also when his AI is down or keeps calling tools that don't exist); after the answer his AI rewrites it, or he shows it and says plainly he couldn't. He always answers: an empty / unusable reply, or only refused tool calls, becomes "I couldn't do that, because … — try …" (`alfred-reply` outcome `empty`, `alfred-empty`). After two struggles in a row with a local model the panel shows a one-line tip: **Use Claude (web pane) as Alfred's brain** / **Use a bigger model** (nothing changes by itself). `alfred-ask-ai` log lines (site, [MSG #], length, outcome — never text) |
| 2026-11-05 | #124 | 🎩 Alfred's big buttons no longer depend on his AI choosing a tool (log 2026-11-04: "🎨 Make a picture" → Ask Alfred, then nothing — a small local model answered in words, five times, and the log could not say what happened): 🎨 Make a picture, 🎬 Make a video, 🖼 Design a cover, 🧑 Make a character and ✍ a new book turn the form straight into the tool call and show the "I will" card at once (✔ Do it still needed, "always allow" still applies); the picture form has a size and "made by" (Stable Diffusion / ChatGPT), the video form a length; the result is said plainly, errors in plain words. 📖 My book / ✍ Continue answered in words (or with his AI down) read the book's status directly, and a stopped run gets a ▶ Resume card. Free text that clearly asks for a picture or a video ("draw me a lighthouse") answered in words is retried once with a plain "use the tool" note, then offered as a one-click "🎨 Make it now" card. The activity log gets `alfred-reply` for every finished request (steps, tools, card, length, time, his AI and model, outcome — never the words), `alfred-no-action` (warning) when a button that asked for an action ended in words only, `alfred-retry` / `alfred-fallback`, and `alfred-tool` with the request and the error code; the Extract's "this book only" keeps them. Alfred's picture tool goes through the same 🎨 Images path as the tab's Generate, so #120's "leave out what Forge doesn't have" applies to him too |
| 2026-11-05 | #123 | Hardening for long books (40–50 chapters), Akọwe side: every AI call has its own time (scene by scene too); a late answer is collected, then the work moves to another AI (or the same one a minute later) before anything pauses; refusals and broken JSON move to another AI, and a re-ask sends only the correction when the chat can continue; when every AI hits its usage limit the run waits and goes on by itself ("resumes by itself at about 3:40 PM", up to 6 h); with only one AI the run keeps going and lists "needs your check later" chapters (setting); check-now / ⚡ run / writers' room no longer fight over the AIs; a hand edit redoes only the checkpoints that read that chapter; backups hard-link unchanged pictures and clips and cap the pinned ones; Akọwe's log rotates (10 MB × 5); the real (OneDrive) Documents folder with a sync warning; a too-long file name is shortened instead of failing the save; the story so far grows with the book. Final hardening pass (same PR): AutoInjector reads when a usage limit resets from the site's notice ("until 3:40 PM", "try again in 2 hours") and Akọwe waits until then; a re-ask's short correction is typed into the same chat only when nothing changed there (else the whole prompt); "📖 Akọwe is using this AI" on the AI's card; each checkpoint saved on its own; plainer time-out / busy messages with a next step; phone-width fixes (beta panel, step arrows), empty "Save readings" explained, a cover change made just before leaving no longer conflicts; the bridge e2e waits while the run makes progress (a short story is now ~75 AI requests) |
| 2026-11-05 | #122 | Long book runs on the PC (desktop side): the PC is kept awake while a book is being written (or a video / picture is made); closing the window while it works asks "Keep it running in the background, or stop it?" (background = a tray icon by the clock opens it again); a Windows notification and a flashing taskbar button when the run pauses, needs your decision, an AI's pane needs you, or every AI hit its usage limit (once, again after 30 min; sound optional); a fresh chat in each AI pane for Akọwe every 15 requests or ~300,000 characters, and at once when the site says "this chat is too long" (new site error "chat full") — only between requests, never in a pane you just used; the AI panes keep full speed when minimised; Akọwe's answers kept short in the conversation list (newest 2,000 kept, older archived to a file, the window shows the newest 300 with "Show older"), and the settings file saved in the background; a test no longer leaves a stray "C:\L\Akowe" folder |
| 2026-11-05 | #121 | 📚 Kind of story — the seven basic plots (Overcoming the Monster, Rags to Riches, The Quest, Voyage and Return, Comedy, Tragedy, Rebirth), or "Let the AI decide" (the AI picks and says which): the plan follows the kind's stages chapter by chapter, each chapter's writer is told its stage, and the ending check makes sure the ending keeps the kind's promise; shown on the plan page, in the Book Bible and the book report |
| 2026-11-05 | #120 | Fixes from the 2026-11-04 log: a slow Gemini is no longer called "broken" — a check-in answer that comes in while self-repair is checking or repairing (for that check-in or an earlier one) stops the repair and marks the AI 🐢 slow; the wait follows each AI's measured check-in times (up to 3 minutes while a reply is still being written) and Stop is never pressed on an AI whose text is still changing; a site's own error notice answering a check-in goes straight to a reload instead of a 90 s wait. Short canned refusals ("I'm having a hard time fulfilling your request. Can I help you with something else instead?", "I can't help with that") are site problems for Akọwe, not answers, and a refused very long prompt is named. A send the page ignores (scripted click / Enter) is sent with a real Enter key or click; a Send button that only appears once the box holds text is no longer called "missing". 🎨 Generate on Forge/A1111 with ADetailer or ControlNet that the WebUI doesn't have makes the picture without it and says what was left out (no UNSUPPORTED_ON_BACKEND dead end). A saved selector that failed 3 times in a row while the built-in one worked is forgotten by itself (said once; ↺ Undo on the 🎯 card), never one set in the last hour |
| 2026-11-04 | #119 | 📖 The 5-chapter review now also answers "Is the story heading the right way?" (toward the planned ending and the book's question) and "Does it make sense?" (events, motives, cause and effect), each scored by every AI |
| 2026-11-04 | #118 | Layout pass: 🔎 Check consistency now moved below the steps on Book home (its review folds away); choices in a row no longer take a whole line; the print preview's spreads side by side; beta readers' setup folds away; the side bar lists the pages of the part you are in (Launch kit, Mockups & ads, Continuity, Book report); "My books" in every breadcrumb; chapter names back on ✍ Write |
| 2026-11-04 | #117 | 🔎 All the AIs check for mistakes and drift: each chapter is reviewed by both AIs that did not write it, then checked by every AI; the checkpoints (with a review of each stretch of chapters) and the ending check are read by every AI; what 2 or more agree on is fixed. New setting "How many AIs check for mistakes", and a 🔎 Check consistency now button (any time; queued between chapters during a run). Report fixes: accented letters and symbols in the report PDF, injuries inside one chapter, beta-reader quotes checked, the writer counts half on the beta panel, "scores lowered N times" per AI, must-fix habits for the editor, tidier report |
| 2026-11-04 | #116 | ⚡ AI activity strip under the top bar: one row per AI at work — what it is doing in plain words ("Writing chapter 7"), its stage, a ticking time and "chapter 7 of 20"; ✔ Done for a few seconds, then it disappears |
| 2026-11-04 | #114 | Story shapes: pick Three acts, Save the Cat, Hero's Journey or Seven-point; each beat is placed on a chapter, written, checked and fixed once if it did not land |
| 2026-11-04 | #114 | ✍ Write alongside me: highlight a passage in a chapter and the AI continues, rewrites, describes more, expands or tightens it; you see a suggestion (with ⚠️ quick checks) and choose to use it as a new version |
| 2026-11-04 | #114 | 🗳 Three-AI writers' room: each AI pitches a twist, they vote blind, you choose (also optional in ⚡ Make a book) |
| 2026-11-04 | #114 | Panel of beta readers: up to 3 AIs read the book as different readers; Akọwe shows where they agree, a chapter heat map and the top 5 fixes |
| 2026-11-04 | #114 | 🚀 Launch kit: blurbs, hook, bio, keywords, categories, comparable titles, age range and A+ plan for the store, checked against the Book Bible (no invented names, no spoilers, KDP keyword rules) |
| 2026-11-04 | #114 | 📣 Mockups & ads: your cover as 3D and phone / e-reader mockups, ads at the stores' exact sizes and 13-second teaser clips, marked out of date when the cover or hook changes |
| 2026-11-04 | #114 | ✨ Originality check: clichés and AI-sounding passages flagged per chapter (no AI), an optional AI "sounds machine-written" rating, and the editor's rewrites aimed at them |
| 2026-11-04 | #115 | Interior themes for the printed book (8 designs tied to the Book Bible looks), page sizes with a growing inside margin, and a print preview on the Book format step |
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
