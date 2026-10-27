# 🎩 Alfred — your assistant inside AutoInjector

Alfred is the butler grown up: an assistant who can use **everything in the app** for you — your
Akọwe books, images (Stable Diffusion), video, the three AI panes (ChatGPT, Claude, Gemini), the
output folders and the logs. You talk to him in plain words; he uses the app's own controls to do it.

He is **off by default**. Nothing about him runs, and the app works exactly as before, until you
turn him on.

## Turning him on

1. Start AutoInjector as usual.
2. In the title bar (top right) press **🎩 Alfred: Off** — it becomes **🎩 Alfred: On** and his
   panel opens on the right. It stays available on every tab (🤖 AutoInjector, 📖 Akọwe, 🎨 Images).
   **▸ Panel** hides/shows the panel while he stays on.
3. He needs an AI to think with (see the next section). If he can't reach it, he says so plainly —
   everything else in the app keeps working.

Press the switch again to turn him **off**: the panel disappears, he stops what he was doing, and
he makes no more calls.

## His AI (choose in the panel's ⚙)

| Choice | What it is |
|---|---|
| **Automatic** (default) | the local model through Ollama when it answers, otherwise the connected AI |
| **Local model (Ollama)** | a model on your own PC — free, private, works offline. Address `http://127.0.0.1:11434/v1` by default |
| **The connected AI** | the AI already set up for the butler/manager (RunPod, LM Studio, any OpenAI-compatible address + key) |
| **A web AI pane** | ChatGPT, Claude or Gemini in their pane — no install needed, but slower, and the replies show in that pane |

**Test my AI** in ⚙ checks the connection (it sends no question) **and that the model is really installed** in Ollama. If it isn't, it lists the installed models with a **Use …** button for each. Very small models (under 3B, e.g. `qwen2.5:0.5b`) work but often pick the wrong tool, and he says so. Small slips by the model (arguments wrapped twice, extra arguments, numbers sent as text) are forgiven; extra arguments are dropped and he is told which.

### Installing a local model on Windows (plain steps)

1. Go to **https://ollama.com/download**, download **Ollama for Windows** and run the installer
   (Next → Install). Ollama then runs in the background (a llama icon near the clock).
2. Open **Command Prompt** (press the Windows key, type `cmd`, press Enter).
3. Type this and press Enter (it downloads about 4.7 GB once):

   ```
   ollama pull qwen2.5:7b
   ```

   Optional but recommended (Alfred's tool list is long): give Ollama a bigger memory window — Windows key →
   "Edit the system environment variables" → Environment Variables → New (user variable):
   name `OLLAMA_CONTEXT_LENGTH`, value `16384` → OK, then quit Ollama from the tray icon and start it again.

   **Recommended:** `qwen2.5:7b` — good at tool calling, fits graphics cards with 8 GB of memory
   (it also runs, slower, without one). Alternatives: `llama3.1:8b` (8 GB), `qwen3:8b`
   (newer, 8 GB); on a small card (4–6 GB) `qwen2.5:3b` or `llama3.2:3b` (less reliable with tools);
   on a big card (16–24 GB) `qwen2.5:14b`.
4. In AutoInjector: 🎩 → ⚙ → **His AI: Local model (Ollama)** (or leave Automatic), **Model**:
   `qwen2.5:7b` → **Save** → **Test my AI**. It should say "My AI answers".

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
| `desktop-app/alfred-panel.js` | the drawer UI (built only when on) |
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
