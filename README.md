# AutoInjector

AutoInjector is one desktop program that puts **ChatGPT, Claude and Gemini side by side** and lets them work
together. It uses the websites you are already signed in to — no API keys. Around those three AIs it adds a
book writer (**📖 Akọwe**), an assistant (**🎩 Alfred**), pictures (**🎨 Images**) and video (**🎬 Video**).

> 🧭 New here? **[How AutoInjector works](docs/HOW_IT_WORKS.md)** explains how all the parts fit together, in plain words.

> Automating these sites' web pages may be against their terms of service. AutoInjector only drives sessions
> where *you* are signed in, on *your* computer. Use it at your own discretion and risk.

> 📖 Using the app? The **[User guide](docs/USER_GUIDE.md)** explains it in plain words (also in the app: ❓ Help → 📖 User guide).

## What's new (October 2026)

- **📖 Book Bible binder** — every character, place, world entry and chapter of your book on its own page:
  12 page templates, 7 looks picked by genre, ✨ Fill from the book, ⬇ PDF and ⬇ Word.
- **★ Story roles** — every character has a title (★ Main character, Villain, Mentor, Extra…). Each book has
  exactly one main character, and Akọwe keeps track of them even when a name is spelled differently.
- **🎬 FramePack** — a second video engine. It uses the FramePack you already have; nothing is downloaded.
- **🎞 Book trailers** — shots and title cards joined into one trailer, with optional music.
- **📦 Your models** — the "stuff and thing" folder now has one model folder per kind, named like Stability
  Matrix's. **🧩 Let ComfyUI use these models** points ComfyUI at them.
- **🧰 Tool servers (MCP)** — add outside tools (files, databases, web services) for Alfred to use.
- **🎩 Alfred** lives in a docked side panel (Ctrl/Cmd+Shift+A) with 8 big buttons and a one-button AI setup.
- **Claude's new page layout** (29 October) is read correctly. New buttons on the 🎯 card:
  **↺ Forget what I taught** and **📋 Copy page structure**.
- **Check-ins carry on** — after a quick check-in, an AI that was busy is asked to continue where it left off.
- **Akọwe**: ebook cover as a JPG, the map in the Word file, motion clips for items, places and magic,
  new characters from scratch, a quiet save every 10 minutes, and big books opened straight from a folder.

## Start it

You need [Node.js](https://nodejs.org/) (the LTS button) once. For Akọwe you also need
[Python 3.10 or newer](https://www.python.org/) (tick "Add python.exe to PATH").

1. Download the repo (green **Code** button → **Download ZIP**) and unzip it, or clone it.
2. Open the `desktop-app` folder and double-click:
   - **Windows:** [`desktop-app/run-windows.bat`](desktop-app/run-windows.bat)
   - **macOS:** [`desktop-app/run-mac.command`](desktop-app/run-mac.command) (right-click → **Open** the first time)
   - **Linux:** [`desktop-app/run-linux.sh`](desktop-app/run-linux.sh)
3. The first start installs what it needs (a minute or two). After that it opens in a few seconds.
4. Sign in to ChatGPT, Claude and Gemini inside their panes, once. They stay signed in.

**One app, one launcher:** Akọwe starts with AutoInjector and is already connected. You don't need
`akowe/run-akowe.bat` any more (it still works if you want Akọwe on its own).

Trying it for the first time with the real AIs? Follow [`docs/FIRST_REAL_TEST.md`](docs/FIRST_REAL_TEST.md).

## What it does

The window has four tabs at the top: **🤖 AutoInjector**, **📖 Akọwe**, **🎨 Images** and **🎬 Video**.

### 🤖 Three AIs in one window

- ChatGPT, Claude and Gemini each get a live pane. You watch them answer.
- Send a message to one, some or all of them. Pass replies between them by hand or on autopilot.
- Every AI can address the others (`[TO: CLAUDE]`), so they can talk among themselves.
- One running transcript you can copy or download. House Rules, Roles, Prompt Library and Prompt Sequences
  help you steer the conversation.

### 📖 Akọwe — the book writer (its own tab)

- Akọwe turns an idea into a finished book: characters, places, plot, outline, chapters, then **PDF, EPUB and
  Word**. The three AIs do the writing; you approve.
- **⚡ Make a book for me** does the whole book in one go. One AI writes, a different one reviews.
- 🗂 Character Forge dossiers, 🎨 Cover, 🖼 Pictures, 🎞 Trailer, a 📊 book report and a 💾 books folder.
- Guide: [`akowe/README.md`](akowe/README.md).

### 📖 The Book Bible binder

- One binder for the whole book: cover, contents, at a glance, cast list, a page per character, relationship
  map, a page per place, magic systems, items, other world entries, the map, story plan, a page per chapter,
  rules & facts. That is **12 page templates**.
- **7 looks** (Classic, Fantasy, Science fiction, Noir case file, Romance, Horror, Playful). Akọwe picks one
  from the genre; **🎨 Look** changes it.
- **✨ Fill from the book** — the AI proposes the small facts that are missing. You approve each one.
- **⬇ PDF** and **⬇ Word**. Both are also saved in the book's folder, under `Book Bible/`.

### ★ Story roles and the main character

- Every character has a story role: ★ Main character, Second lead, Love interest, Villain, Henchman, Rival,
  Mentor, Sidekick, Ally, Family, Supporting character, Minor character or Extra.
- A book has exactly one ★ main character. Akọwe warns when none is set and asks before moving the ★.
- The outline and chapters always follow the main character.

### 🎩 Alfred — your assistant (off until you turn him on)

- Press **🎩 Alfred: Off** in the title bar. His panel docks on the right, on every tab.
  **Ctrl+Shift+A** (Cmd+Shift+A on a Mac) shows or hides it.
- **One-button AI setup:** ▶ Start Alfred, or ⚡ Set up (first time). It installs Ollama and a model that fits
  your PC, or uses what you already have.
- **8 big buttons:** 🧑 Make a character, 🎨 Make a picture, 🎬 Make a video, 🖼 Design a cover, 📖 My book,
  ✍ Continue / make my book, 🩺 Check everything, ❓ Everything I can do.
- Before he changes anything he shows an **"I will…"** card. Nothing happens until you press **✔ Do it**.
- Guide: [`docs/ALFRED.md`](docs/ALFRED.md).

### 🎨 Images

- Makes pictures with Stable Diffusion on your own PC: **Forge, A1111, SD.Next or ComfyUI** (also through
  Stability Matrix). It can find, start or install one for you.
- **🔒 Character locks** keep a character's face the same in every picture.
- **ChatGPT picture engine:** ChatGPT can draw too, in its own pane. Choose Stable Diffusion, ChatGPT or Auto.
- Guide: [`docs/STABLE_DIFFUSION_SETUP.md`](docs/STABLE_DIFFUSION_SETUP.md).

### 🎬 Video

- **Wan** on ComfyUI: text → video and picture → video. The models download inside the app.
- **FramePack:** uses the FramePack already on your PC (for example from Stability Matrix). No downloads.
- **🎞 Trailer:** several shots and title cards joined into one trailer (WebM, plus MP4 when ffmpeg is found).
- Details: [`docs/VIDEO_API.md`](docs/VIDEO_API.md).

### 📁 "stuff and thing" and 📦 Your models

- One folder, `stuff and thing`, inside the AutoInjector folder holds everything the app makes or downloads.
- Its `models/` folder has one subfolder per kind (checkpoints, LoRAs, VAEs, embeddings, ControlNet, upscalers,
  text encoders, FramePack…), named to match Stability Matrix's `Data\Models`.
- **⚙ More settings → 📁 Downloads & creations → 📦 Your models** shows what is in each folder.
  **🧩 Let ComfyUI use these models** lets ComfyUI read them too.

### 🧰 Tool servers (MCP)

- Add an outside tool server (a program or a web address) in **🎩 Butler → ⚙ More settings → 🧰 Tools**.
- Alfred can then use its tools. Every use shows an "I will" card first.

### 🔧 AIs that repair themselves

- AutoInjector sends each AI a tiny **check-in** now and then. If an AI stops answering, it tries to fix itself.
- If it can't, it tells you once. **🎯 Point at it** or **🔢 Do it for me with a number** teach it again.
- After a check-in, an AI that was in the middle of something is asked to **carry on where it left off**.

## Where things are saved

| What | Where |
|---|---|
| Pictures, videos, trailers, downloaded models | `stuff and thing/` inside the AutoInjector folder (`images/`, `videos/`, `models/`) |
| Your books (one folder each) | `Documents\Akowe Books\` — change it in Akọwe → Settings → 📁 Where books are saved |
| Akọwe's projects and settings | `%LOCALAPPDATA%\Akowe` (Windows), `~/.local/share/akowe` (elsewhere) |
| AutoInjector's transcript and settings | `%APPDATA%\autoinjector-desktop\` (Windows) |

## More to read

- [`desktop-app/README.md`](desktop-app/README.md) — the full AutoInjector guide.
- [`akowe/README.md`](akowe/README.md) — the full Akọwe guide.
- [`docs/ALFRED.md`](docs/ALFRED.md) — Alfred, his AI and tool servers.
- [`docs/STABLE_DIFFUSION_SETUP.md`](docs/STABLE_DIFFUSION_SETUP.md) — set up pictures on Windows.
- [`docs/VIDEO_API.md`](docs/VIDEO_API.md) — video, trailers and FramePack.
- [`docs/CHARACTER_FORGE.md`](docs/CHARACTER_FORGE.md), [`docs/COVERS.md`](docs/COVERS.md),
  [`docs/PICTURES.md`](docs/PICTURES.md) — dossiers, covers and pictures in books.
- [`docs/FIRST_REAL_TEST.md`](docs/FIRST_REAL_TEST.md) — the first test with the real AIs.
- [`docs/AKOWE_IMPROVEMENT_PLAN.md`](docs/AKOWE_IMPROVEMENT_PLAN.md) — what is done and what is next.
- [`desktop-app/SERVICE_BRIDGE.md`](desktop-app/SERVICE_BRIDGE.md) — the local service other programs can call.
- [`docs/AKOWE_AUTOINJECTOR_BRIDGE.md`](docs/AKOWE_AUTOINJECTOR_BRIDGE.md) — how Akọwe talks to the AIs.

## Other ways to run it

**Chrome extension** ([`AutoInjector/extension/`](AutoInjector/extension/)): an older, simpler version with a
fixed turn order. Open `chrome://extensions`, turn on **Developer mode**, **Load unpacked** and pick that folder.
Then click the AutoInjector icon → **Open AI Roundtable**. Sign in to the three sites in normal tabs first.

**Android:** phones can't run the desktop app. Install [Kiwi Browser](https://kiwibrowser.com/) and load the
same extension folder there (Extensions → Developer mode → Load unpacked).

**Fake OpenAI bridge** ([`AutoInjector/server/`](AutoInjector/server/)): a local server that lets an
OpenAI-style program talk to the ChatGPT web page. Start it with `start_server.bat`. It only works with the
extension.
