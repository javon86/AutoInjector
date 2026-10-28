# 🎩 Alfred — your assistant inside AutoInjector

Alfred is the butler grown up: an assistant who can use **everything in the app** for you — your
Akọwe books, images (Stable Diffusion), video, the three AI panes (ChatGPT, Claude, Gemini), the
output folders and the logs. You talk to him in plain words; he uses the app's own controls to do it.

He is **off by default**. Nothing about him runs, and the app works exactly as before, until you
turn him on.

## Turning him on

1. Start AutoInjector as usual.
2. In the title bar (top right) press **🎩 Alfred: Off** — it becomes **🎩 Alfred: On** and his
   side panel opens on the right; the app moves over to make room. It stays available on every tab
   (🤖 AutoInjector, 📖 Akọwe, 🎨 Images, 🎬 Video). **▸ Panel** (or Ctrl+Shift+A) hides/shows the panel
   while he stays on. (The User Panel's **🎩 Alfred: Off/On** button does the same as the switch.)
3. He needs an AI to think with (see the next section). If he can't reach it, he says so plainly —
   everything else in the app keeps working.

Press the switch again to turn him **off**: the panel disappears, he stops what he was doing, and
he makes no more calls.

### Two places: the TALK panel and the SETUP panel

- **Talk to him** in his **side panel** (below). **Set him up** in the **🎩 Butler section** of the main tab
  (one-button setup, the check, models, personality, the activity log). There is no other Alfred window.

### His side panel (it moves the app over, on every tab)

- His panel sits on the **right** of the window. The app **makes room** for it: the AI panes, 📖 Akọwe,
  🎨 Images and 🎬 Video are all laid out beside it, never under it. It stays there when you change tabs.
  The title-bar **▸ Panel / ◂ Panel** button hides / shows it.
- **Ctrl+Shift+A** (**Cmd+Shift+A** on a Mac) shows / hides it from anywhere in the app, even from inside an
  AI pane. Hiding the panel does not turn Alfred off.
- **Eight big buttons** do something real for you through Alfred (he still shows an "I will" card before he
  changes anything):
  - **🧑 Make a character** — asks the name and a line about them, then Alfred opens their Character Forge
    dossier and invents the rest as proposals you approve. (Akọwe makes the book's characters itself —
    outline / Characters and places; when the name is not in the book yet, Alfred says so plainly.)
  - **🎨 Make a picture** / **🎬 Make a video** — asks what it should show, then Alfred makes it.
  - **🖼 Design a cover** — what the cover picture should show (optional), then the cover design and art.
  - **📖 My book** — where your book is (checklist, the "Make a book for me" run, problems).
  - **✍ Continue / make my book** — resumes the "Make a book for me" run; with no book yet it asks for your
    idea and starts one.
  - **🩺 Check everything** — his AI and the whole app (disk, Stable Diffusion, Akọwe, the AI panes, logs),
    with a one-click fix where there is one. Needs no AI.
  - **❓ Everything I can do** — a searchable list of everything Alfred can do, grouped (📖 Books,
    🧑 Characters & world, 🎨 Pictures & covers, 🎬 Video, 💬 The three AIs, 🧠 His AI & setup,
    📁 Files & folders, ⚙ App settings & tools), each with one plain line and **▶ Try it**, which puts an
    example request in his box. Typing **"what can you do?"** opens it too.
  The book buttons say plainly when Akọwe has no book yet (or is not running).
- The list in the header switches between saved set-ups, 💾 saves the current one, ⚙ has his AI settings
  and **🛠 Set up his AI** (opens the 🎩 Butler section).

### The User Panel buttons (top of the main tab)

The old Butler's buttons up there are Alfred's now:
- **→ 🎩 Alfred** sends what you typed to Alfred (his panel opens; he is turned on if he was off). His
  **Active** box includes him in **→ All**.
- The **status light** shows his state — off, idle, working, or *needs you* (a card is waiting). Click it to
  open his panel.
- **🧠 Auto / Local / Connected AI / Web AI** — what he thinks with (click to change).
- **🎩 Alfred: On/Off** — the same as the title-bar switch.
- **🩺 Check Alfred** — the 🩺 check above (in his panel; in the Activity Log while he is off).

### The 🎩 Butler section (set-up + activity)

From top to bottom:
1. **Alfred's AI:** the one button, 🩺 Check everything, Start/Stop Ollama, and the models on this PC.
2. **🔎 Find a model:** compact cards, about three to a row.
3. **Personality and saved set-ups**, stacked one under the other on the left half. **⚙ More settings**
   (the downloads folder, safeguards, tools and voice) is on the right half.
4. On the far right, the **activity log**: what Alfred did and what his AI setup did.

The old Butler's own controls are gone from view, because Alfred and the one button replace them:
- the "Tell the butler what to do" box;
- System Check, Install Missing and Send Intro;
- the old "Local model settings".
The one button also sets the Butler's local model.

### His personality and saved set-ups (🎩 Butler section)

- **Personality**: Butler (default), Friendly, Brief, Witty, Coach or Custom (your own words, up to 1500
  characters); his name; a tone; chattiness 1–5. It changes **how he talks only** — never what he may do:
  every change still goes on the "I will" card and waits for ✔ Do it (that is enforced by the app, not by
  his instructions, so no personality text can switch it off).
- **Saved set-ups**: his AI, model, web AI, max steps and personality under a name (up to 20). Save the
  current one as…, use, rename, delete — here, or switch from his side panel.

## His AI (choose in the panel's ⚙)

| Choice | What it is |
|---|---|
| **Automatic** (default) | the local model through Ollama when it answers, otherwise the connected AI |
| **Local model (Ollama)** | a model on your own PC — free, private, works offline. Address `http://127.0.0.1:11434/v1` by default |
| **The connected AI** | the AI already set up for the butler/manager (RunPod, LM Studio, any OpenAI-compatible address + key) |
| **A web AI pane** | ChatGPT, Claude or Gemini in their pane — no install needed, but slower, and the replies show in that pane |

**Test my AI** in ⚙ checks the connection (it sends no question) **and that the model is really installed** in Ollama. If it isn't, it lists the installed models with a **Use …** button for each. Very small models (under 3B, e.g. `qwen2.5:0.5b`) work but often pick the wrong tool, and he says so. Small slips by the model (arguments wrapped twice, extra arguments, numbers sent as text) are forgiven; extra arguments are dropped and he is told which.

### Starting his AI (🎩 Butler section)

Everything for getting him running is at the top of the **🎩 Butler** section. You talk to him in his side panel.

- **▶ Start Alfred** (the everyday button). It uses only what is **already downloaded** and never downloads:
  1. It finds Ollama and starts it. If your models are in Ollama's usual folder rather than AutoInjector's, it starts
     Ollama on that folder.
  2. It picks your model: the one he already uses, or else the best one you have.
  3. It loads the model into memory, turns Alfred on and opens his panel.

  Tick **Start him when the app opens** and you don't need to click at all.
- **🔍 Find what's installed** looks on this PC for:
  - Ollama itself;
  - every running Ollama and its models, each with a **Use** button;
  - other Ollama model folders that already have models, each with a **Use this folder** button;
  - model files (`.gguf`) that LM Studio, GPT4All, Jan or your Downloads folder already have, each with a
    **➕ Add to Ollama** button. Ollama reads the file it already has; nothing is downloaded.
- **⚡ Set up (first time)** is only needed once, or for a better model:
  1. It installs Ollama if it's missing (on Windows the official installer runs silently; on macOS it goes into
     ~/Applications; on Linux into the app's own folder, no admin needed).
  2. If you already have a capable model, it **uses it and downloads nothing**. Otherwise it downloads one that
     fits your PC.
  3. It ends with the check.

  Tick **🔓 Prefer uncensored** first if you want an uncensored model.
- **🩺 Check everything** shows ✔, ⚠ or ✖ lines with one-click **Fix** buttons. **Start / Stop Ollama** are next
  to it. **📦 Models on this PC** lists your models with **Use** and **Remove** buttons.
- **🔎 Find & download more models** is folded so it doesn't take up space; click it to open it, and it remembers.
  - It searches the Ollama library and Hugging Face.
  - Every result is rated for your PC (★★★ / ★★ / ★ / ✖), and models that are too big can't be downloaded.
  - The 🔓 filter brings uncensored models to the top.
  - You can connect an optional Hugging Face token.
- **Personality** and **saved set-ups** are on the left. **⚙ More settings** and the **activity log** are on the
  right.

You can also ask him: "check your AI", "find me an uncensored 8B model that fits", or "download it and use it".

**Doing it by hand** (if the one button can't install, e.g. your PC blocks installers): get Ollama from
**https://ollama.com/download**, run it, then use **🔎 Find a model** → **Download** → **Use**. Or, in Command
Prompt: `ollama pull qwen2.5:7b`. Alfred's tool list is long, so a bigger context helps: set the user
environment variable `OLLAMA_CONTEXT_LENGTH` = `16384` and restart Ollama.

No local model? Choose **The connected AI** (if you set one up for the butler) or **A web AI pane**.

## What he can do

Tools are a **fixed list** of direct controls (he cannot run arbitrary code unless you allow Open
Interpreter, below). 🔍 = just looks, runs directly. ✋ = changes or creates something: he first shows
an **"I will: …"** card and does it only after you press **✔ Do it**.

**📖 Akọwe / books** (through Akọwe's own API, with the key AutoInjector already holds)
- 🔍 status of your books and the current run: checklist, steps, recent events, the AIs' health, problems
- 🔍 list your books · 🔍 open a page in the 📖 Akọwe tab (book checklist, report, scene grid, journal, world, review)
- ✋ start **⚡ Make a book for me** from an idea (genre, length) — your ✔ Do it is the consent for that one run,
  exactly like pressing the button in Akọwe
- ✋ pause / resume / cancel the run
- ✋ edit the book profile and story choices
- ✋ edit a character sheet or voice card (other fields are kept)
- ✋ add or change a story rule, add or change a world detail
- ✋ ask for a chapter rewrite with your note — the new version **waits for your approval** in Akọwe
- ✋ make the book report · ✋ save the book

He never approves drafts for you and never gets around Akọwe's approvals: a run that pauses for
your decision stays yours to decide in Akọwe.

**🎨 Images** (through the 🎨 Images module, `sd-api.js`)
- ✋ make an image (description, size, style, a character — their saved **character lock** is used, LoRAs)
- 🔍 recent images · 🔍 is Stable Diffusion connected / running? · 🔍 search the model & LoRA library ·
  🔍 character locks · ✋ start / stop the Stable Diffusion app AutoInjector knows about

**🎬 Video:**
- 🔍 Status, models, progress and gallery run without a card.
- ✋ `generate_video` makes a clip from a description, brings a picture to life (`image`), or keeps a character's looks (`character`).
- ✋ `video_call` reaches every setting of the 🎬 Video module (size, seconds, fps, model, steps, CFG, seed, sampler, scheduler, shift) and the model installs.
- It uses ComfyUI with Wan; see `docs/VIDEO_API.md`.
- The Character Forge `make_character_art` with `what:"clip"` makes a dossier's motion study.

**💬 AI panes** — ✋ send a message to ChatGPT / Claude / Gemini / all · 🔍 read the latest reply ·
🔍 their health · ✋ run the self-repair check-in.

**📁 Files / logs** — 🔍 list the output folders (images, videos, books, logs, uploads) · ✋ open a file
from them (never programs or scripts) · ✋ export the logs ("this book only", the last day, or everything;
secrets are taken out).

**🧰 Everything else in the app** — two tools reach every other control of AutoInjector through a fixed
catalog (`desktop-app/alfred-app-actions.js`, 151 actions, each with a title, an argument schema and
"changes things?"): `app_info` for looking (pane health, the app state, the butler's state and memory, lockers,
the database, models, logs, setup, voice/image settings, self-repair, Akọwe connection, the Images tab's lists …)
and `app_control` for doing (routing / Auto / hop limit / roles / active AIs, House Rules, prompt sequences and the
prompt library, tests and checks, the butler's tasks and settings, lockers, the terminal connection, setup and
downloads, voice, image/video settings, self-repair and the 🎯 picker, the Akọwe bridge/server/view, the Images
tab's settings, library folders, collections and character locks, which tab is shown …). `app_help` explains any
action. They call the very same handlers as the buttons. A few things are deliberately **not** reachable, each
with its reason in the file: saved passwords and connection keys, the phone/LAN switch, opening any web address,
free command execution (the terminal's run/approve, the butler's run-command tool), developer tools and window
chrome.

**🗂 Character Forge dossiers** (the dark "Moki Vey" profile look, see `docs/CHARACTER_FORGE.md`):
- `character_dossier` reads them: the list, one dossier's state, or one section in full.
- `forge_character` fills empty fields as **proposals**. Nothing the author wrote or locked changes.
- `edit_dossier` writes fields in the author's words, optionally locked.
- `approve_dossier` approves proposals. It always shows its card and can never be "always allowed".
- `make_character_art` makes the portrait, any of the ten reference views, or one turnaround sheet. It draws with Stable Diffusion (`engine: "sd"`, using the character lock), with ChatGPT in its pane (`"chatgpt"`), or `"auto"`.
- `open_akowe_page` with `page: "forge"` (plus `character`) shows the dossier.

**🎨 Every Stable Diffusion setting** — `sd_call` reaches every method of the 🎨 Images module (`sd-api.js`):
`images.generate` with all generation fields (prompt, negative, LoRAs, character lock, size, steps, CFG, sampler,
scheduler, seed, checkpoint, VAE, count, init image, denoise …), status / progress / cancel / gallery / test,
connect / detect / start / stop, the installer, and the model library. It is built from the module itself: when the
module lists its operations (`capabilities()` — the full-controls build with hires fix, upscalers, ControlNet,
inpainting, refiner, ADetailer, A1111 options, ComfyUI workflows and raw `extra` payload fields), those appear in
`sd_call` automatically with their own schemas. This build has them (51 operations): the coverage test drives every
one through Alfred against fake Forge and ComfyUI servers. That covers hires fix, per-picture setting overrides,
raw A1111 fields (checked against the server's `/openapi.json`), img2img and inpaint, upscale, reading and changing
settings-menu options, lists, interrupt, skip and refresh, plus ComfyUI workflows (save, list, get, run with named
params, delete), node info, queue, upload and freeing VRAM. A setting the connected app can't do comes back as
`UNSUPPORTED_ON_BACKEND`, with a hint.

**🧪 Open Interpreter (optional)** — off unless you tick it in ⚙. Even then he always shows the
**exact code** on the card and asks first, can never be "always allowed", and refuses it when a direct
tool exists (images, books, the AIs, video, logs).

## Safety, in short

- **I will cards:** every change is listed step by step; ✔ Do it or ✖ No. For harmless ones
  (make an image, save the book, make the report, run the check-in, open/export a file, start/stop SD)
  you can tick **Always allow** — undo with ⚙ → **Forget "always allow"**.
- **Bounded:** at most 8 AI steps per request (⚙ Max steps), timeouts on every call, **■ Stop** at any time.
- **Records:** every action goes to the Activity log (the tool's name, a fixed title and ok/error —
  never your words, prompts, book text or keys) and, for book actions, to the book's journal in Akọwe
  (🎩 entries). The panel's **What Alfred did** lists them in full.
- **Unknown tools** or wrong arguments from his AI are refused before anything runs.

## Notices

With "Tell me when something happens" on (⚙), he mentions — without asking any AI — when an AI pane
broke or was fixed, a book run paused / needs your decision / finished / stopped, or an image finished.
At most one of each every 5 minutes and 6 in 10 minutes.

## For developers

| File | What |
|---|---|
| `desktop-app/alfred.js` | the core: switch, settings (`alfred-settings.json` in the app data folder), the loop, cards, cancel, watcher |
| `desktop-app/alfred-tools.js` | the fixed tool registry: name, title, description, JSON schema, `changes`, `allowAlways`, `describe`, `run` |
| `desktop-app/alfred-app-actions.js` | the catalog of every other app control (→ `app_info` / `app_control`) and the EXCLUDED list with reasons |
| `desktop-app/alfred-ai.js` | his AI: OpenAI-compatible tool calling (Ollama `/v1`, the connected AI), the JSON text protocol (web panes / models without tools) |
| `desktop-app/alfred-image.js` | the ONE image adapter (sd-api `images.generate`; falls back to image-provider) |
| `desktop-app/alfred-main.js` | wiring into Electron: tool context, IPC `alfred:*`, app events → watcher |
| `desktop-app/alfred-panel.js` | his side panel (built only when on), docked in `controls.html`: the 8 big buttons and their forms, ❓ the catalog, chat, cards, settings, set-ups. Ctrl/Cmd+Shift+A is caught in main (`alfred-main.js`, `before-input-event` on every page) and sent as `toggle-panel` |
| `desktop-app/alfred-catalog.js` | "❓ Everything I can do": the grouped list built from `alfred-tools.publicList()` + `alfred-app-actions.ACTIONS` (one plain line + an example request each) |
| `desktop-app/controls.js` (🎩 Alfred in the User Panel) | → 🎩 Alfred, the status light, 🧠, 🎩 Alfred: On/Off, 🩺 Check Alfred (the old Butler's ids, kept) |
| `desktop-app/alfred-persona-ui.js` | personality editor + saved set-ups in `<div id="alfred-persona">` (🤵 Butler section) |
| IPC (B6) | `alfred:personality` (get / set, clamped with plain notes), `alfred:profiles`, `alfred:profile-save` `{name, renameFrom?}`, `alfred:profile-use` `{name}`, `alfred:profile-delete` `{name}`, `alfred:panel` (get: `{mode:'docked', open, shortcut}`), `alfred:panel-toggle` `{open?}`, `alfred:show-butler`, `alfred:catalog` (read-only: the grouped list), `alfred:books` (read-only: `{akowe, books:[{project_id,title}]}` for the big buttons); events on `alfred` also: `toggle-panel`, `show-butler` |
| hooks | `captureIpc(ipcMain)` right after Electron is required + one marked block in `main.js`, `preload.js` (`alfred*`), the switch + script tag in `controls.html`, `alfred-` log tag in `log-tags.js` |
| Akọwe | `POST /api/projects/{id}/branches/{b}/journal/note` `{source:"alfred", code, title}`; optional `note` on `POST …/review/fix` |

**Can he really control everything?** `desktop-app/test/alfred-coverage.test.js` (part of `npm run test:unit`)
keeps an explicit inventory of every capability — all IPC channels the window, tabs and menus use, the live
events, the butler's decision actions, the service-bridge and Akọwe-bridge routes, the Images-module methods, the
Akọwe API Alfred uses, the menu items and tabs — and fails when the code has one the inventory doesn't, or when
one is neither mapped to an Alfred tool nor excluded with a reason. It then drives **every Alfred tool, every app
action and every Images-module method** from a fake model's tool call: against the real main.js (mock Electron,
fake panes), a fake Forge and a fake ComfyUI through the real sd-api, and a fake Akọwe API — checking the effect
and that anything that changes something waits for ✔ Do it — and prints the coverage table.

Tests: `desktop-app/test/alfred.test.js` (fake Ollama/OpenAI server, fake Akọwe API) and
`desktop-app/test/e2e/alfred.e2e.js` (the real app under xvfb with the real Akọwe server, a fake model and
a fake Forge); Akọwe side: `akowe/tests/test_alfred_hooks.py`.

Not yet tried with a real local model on the user's PC — the fake model follows the OpenAI tool-calling
format exactly, but smaller real models may need the text-protocol fallback (built in).
