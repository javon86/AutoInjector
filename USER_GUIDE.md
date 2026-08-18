# AutoInjector — User Guide

Everything this program does, and how to use it. Written for a brand‑new user —
no prior setup knowledge assumed.

> **Status labels** used throughout this guide:
> - ✅ **Works now** — installed and usable out of the box.
> - ⚙️ **Built (backend)** — done and tested, but not yet shown as its own control.
> - 🔌 **Needs a server** — works once you point it at a model/GPU endpoint you provide.
> - ⏸️ **On hold** — present in the code but currently switched off.

---

## Table of contents

1. [What AutoInjector is](#1-what-autoinjector-is)
2. [Before you start](#2-before-you-start)
3. [Install and first launch](#3-install-and-first-launch)
4. [A tour of the window](#4-a-tour-of-the-window)
5. [Sending your first message](#5-sending-your-first-message)
6. [The three ways the AIs talk to each other](#6-the-three-ways-the-ais-talk-to-each-other)
7. [Other sending tools](#7-other-sending-tools)
8. [The Conversation window and your project database](#8-the-conversation-window-and-your-project-database)
9. [Project Memory and Project State panels](#9-project-memory-and-project-state-panels)
10. [Image Studio (Stable Diffusion)](#10-image-studio-stable-diffusion)
11. [The Manager (optional 4th brain)](#11-the-manager-optional-4th-brain)
12. [The Local Supervisor (LSI)](#12-the-local-supervisor-lsi)
13. [Book Governance (ATELIER) — on hold](#13-book-governance-atelier--on-hold)
14. [What you need to run each part](#14-what-you-need-to-run-each-part)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. What AutoInjector is

AutoInjector opens **ChatGPT, Claude and Gemini in one window** and lets them
work together. It does not use paid API keys for those three — instead it
**drives the actual websites**: it types your message into a chat box, clicks
send, waits for the reply to finish, reads it back, and can pass it on to another
AI. Think of it as a puppeteer that turns three separate chatbots into one team.

Everything the AIs say is saved into a local database on your computer, so you
have a permanent, searchable record you can copy, download, or build on.

---

## 2. Before you start

You need two things:

- **Node.js** — this is what runs the app. Get it free from
  [nodejs.org](https://nodejs.org/) (click the **LTS** button) and install with
  the defaults. This is the only required install.
- **Accounts** for the AIs you want to use — ChatGPT
  ([chatgpt.com](https://chatgpt.com)), Claude ([claude.ai](https://claude.ai)),
  and/or Gemini ([gemini.google.com](https://gemini.google.com)). You just need
  to be able to log in normally.

Optional extras (only for the advanced features) are listed in
[section 14](#14-what-you-need-to-run-each-part).

---

## 3. Install and first launch

1. **Get the code.** On the GitHub page, click the green **Code** button →
   **Download ZIP**, then unzip it wherever you like. (If you use git,
   `git clone` works too.)
2. Open the **`desktop-app`** folder.
3. **Double‑click the launcher** for your system:
   - **Windows** → `run-windows.bat`
   - **macOS** → `run-mac.command` (first time: right‑click → **Open** → **Open**
     to get past the "unidentified developer" warning)
   - **Linux** → open a terminal there and run `./run-linux.sh`
4. **First run only:** a black window appears and installs what it needs (a
   minute or two). After that, the same double‑click opens the app in seconds.
5. When the window opens, **sign in** to ChatGPT, Claude and/or Gemini right in
   their panes, exactly like visiting the websites.

Nothing installs system‑wide — it all lives inside the `desktop-app` folder, so
deleting the folder removes it cleanly.

---

## 4. A tour of the window

The window has a **title bar** at the top and one big scrollable area below it.
**If there's more than fits, scroll up and down** — a scrollbar appears on the
right. Most panels have a **⌄ button** in their heading to **minimize** them;
minimizing frees space, and the window keeps scrolling.

From top to bottom you'll typically see:

- **User Panel** *(always visible)* — your main controls:
  - **Compose** — the box where you type a message.
  - **Send / Active** — pick which AIs a message goes to, and which are
    participating.
  - **Attach, Roles, Sequence** — attach a document, assign roles, or build a
    prompt sequence.
  - **Messages to you** — a small feed of replies an AI addressed directly to you.
- **Global** — the master **Auto / Pause / Stop** buttons and the **Tuner**.
- **House Rules** — structured conversation formats (Debate, Brainstorm, …).
- **Prompt Library** — saved prompts you can reuse.
- **Project Memory** — add and search project records *(see §9)*.
- **Project State** — a read‑out of the project's internal state *(see §9)*.
- **Image Studio (Stable Diffusion)** — generate images *(see §10)*.
- **The three AI panes** — ChatGPT, Claude and Gemini live, side by side. Each
  pane can be collapsed to a thin strip.
- **Conversation** — the running transcript, saved to the database *(see §8)*.
- **Activity / Troubleshooting** — a technical log of what the app is doing.
- **Export bar** — **Copy Transcript**, **Download .md**, **Clear Transcript**.

---

## 5. Sending your first message

1. Type into the **Compose** box (e.g. *"Give me three ideas for a short story."*).
2. Under **Send**, choose who receives it — one AI, several, or **→ All**.
3. The app types it into each chosen pane and clicks send. When a reply finishes,
   it appears in that pane's preview and in the **Conversation** window below.

That's the whole basic loop. Everything else is about **what happens to a reply
once it arrives**.

---

## 6. The three ways the AIs talk to each other

This is the heart of the app — making the AIs pass work between themselves.

### a) Roundtable tags — `[TO: X]` ✅ *(always on)*
Every reply is checked for a tag at the **very start**. If an AI writes
`[TO: Claude] …`, its answer is automatically sent to Claude. Use:
- `[TO: ChatGPT]` / `[TO: Claude]` / `[TO: Gemini]` — send to that AI,
- `[TO: ALL]` — send to everyone,
- `[TO: USER]` — "this one's for you" (shows in **Messages to you**).

You can tell the AIs to use these tags, and they'll hand off to each other on
their own.

### b) Auto / mesh routing ✅
Turn on **Auto** (per pane, or **Auto (checked participants)** in Global) and
every reply is forwarded to the other panes automatically — the simplest way to
start a continuous three‑way conversation. **Pause** holds it; **Stop** ends it.

### c) House Rules ✅
Pick a **format** to run a structured session using your Compose text as the
topic:
- **Who Wants to Speak?**, **Debate**, **Free‑for‑All**, **Brainstorm**,
  **Rotation**, **Blind Round**, and (with 3 AIs) **Devil & Angel** and
  **Chargeback**.
Set the number of **Rounds** (0 = keep going), click **Start**, **Stop** to end.

---

## 7. Other sending tools

- **Prompt Library ✅** — save prompts you use often; **+ New** / **Edit** open a
  small editor; **Send** fires the selected one.
- **Prompt Sequence ✅** — **🧵 Sequence** opens an editor where you list prompts
  to fire one after another automatically.
- **Roles ✅** — **🎭 Roles** lets you label each AI (e.g. "critic", "writer") so
  formats and prompts can reference them.
- **Attach a document ✅** — **📎 Attach** picks a file, previews it, and sends its
  contents to the AIs you choose.
- **Tuner ✅** — **🎛️ Run Tuner** tests each AI's connection and every A‑to‑B relay
  path, and tells you exactly which links work.
- **Logins ✅** — you can save and autofill site logins per pane.

---

## 8. The Conversation window and your project database

The **Conversation** window (bottom‑left) is the running transcript. Its heading
shows **"· saved to database (N)"** — because everything is recorded into a local
**SQLite database** as it happens. ✅

- **Copy Transcript / Download .md** — export the whole conversation (handy to
  send to someone).
- **Clear Transcript** — empties the visible transcript.
- **Messages to you** — replies tagged `[TO: USER]` (or with no tag) collect here
  and in a popup.

Under the hood, each message gets a permanent number (`MSG-000124`), replies are
linked to what they answer, and exact duplicates are dropped — so the record
stays clean and complete.

---

## 9. Project Memory and Project State panels

These surface the app's project database directly.

- **Project Memory ✅** — add typed records and search them:
  - Pick a type — **Character, Task, Decision, Fact, Timeline, Status** — type a
    name/title, click **+ Add**.
  - Type in the search box and click **Search** for **full‑text search** across
    every record (also finds saved images by their prompt).
- **Project State ⚙️** — click **Refresh** to see the project's internal state:
  each model's **read position**, the current **baseline**, **artifacts**, and
  **owned tasks**. The tracking behind this is built and tested; the values fill
  in as the project is used.

---

## 10. Image Studio (Stable Diffusion) 🔌

Generate images — and **both you and the AIs can trigger it**. This needs a
Stable Diffusion server (an [Automatic1111](https://github.com/AUTOMATIC1111/stable-diffusion-webui)
instance, local with a GPU or on a RunPod pod).

**Set it up:**
1. Open **Image Studio (Stable Diffusion)**.
2. Put your server address in the box (default `http://127.0.0.1:7860`) and click
   **Test**.
3. Tick **Enable image generation**, and optionally **Let AIs trigger with
   `[IMAGE: …]`**. Click **Save settings**.

**You generate:** type a prompt (and optional negative prompt), click
**Generate**. Or click **↳ ChatGPT / ↳ Claude / ↳ Gemini** to drop that AI's last
reply into the prompt box first. Images appear in the gallery.

**The AIs generate:** with the checkbox on, any AI reply that **starts with**
`[IMAGE: a lighthouse at dusk]` renders that image automatically — the same idea
as `[TO: X]`.

**Saved to the project ✅:** every render is stored as a searchable image record
(prompt, seed, model, a content hash) plus a versioned artifact — find it later
via **Project Memory** search. (Saving works even while you're still setting up
the server.)

---

## 11. The Manager (optional 4th brain) 🔌

The **Manager** is a supervising model that plans a task and delegates pieces to
the three panes, reads what comes back, asks for corrections when they disagree,
and saves results to a folder. Unlike the three chat panes, it uses a real model
endpoint, so you provide one: **Ollama** or **LM Studio** locally, or a **RunPod**
pod (it can even start/stop the pod for you). It stays off until configured.

---

## 12. The Local Supervisor (LSI) 🔌

A small local model that makes the app's **fuzzy judgment calls** — things like
"is this reply just a duplicate 'ok'?" or "does this message need an answer?".
It takes a question in and returns a strict **verdict + confidence**, always
logged. If it's offline, the app simply runs without it (plain‑code mode) — **no
downtime, just less smart filtering**. It needs a local model endpoint to
actually run, and is the foundation for smarter routing and filtering coming
next.

---

## 13. Book Governance (ATELIER) — on hold ⏸️

There's an optional system for using the app to **write a structured book**,
where each AI has a role and may only write certain files (so, for example, the
"auditor" AI can't secretly rewrite a chapter). It is **currently switched off**
and hidden from the interface — the code is kept and can be turned back on later.
It requires Python 3 when active.

---

## 14. What you need to run each part

| Part | What it needs |
| --- | --- |
| **The app + the three AIs** | Node.js, and login accounts. That's it. ✅ |
| **Conversation, database, memory, search** | Nothing extra — built in. ✅ |
| **Manager** | An OpenAI‑compatible model endpoint (Ollama / LM Studio / RunPod). 🔌 |
| **Local Supervisor (LSI)** | An OpenAI‑compatible model endpoint. 🔌 |
| **Image Studio** | An Automatic1111 server with a GPU (local or RunPod). 🔌 |
| **Book Governance (ATELIER)** | Python 3 — but it's on hold, so nothing for now. ⏸️ |

---

## 15. Troubleshooting

- **A reply isn't being read / nothing happens.** Make sure you're **signed in**
  to that site in its pane, and that the pane isn't collapsed. Use **🎛️ Run
  Tuner** to see exactly which connections work.
- **A site changed its layout and injection breaks.** The app keeps several
  fallback ways to find each site's input box and send button; if a site updates,
  this is the first thing that may need a small fix. The **Activity /
  Troubleshooting** log will show the error.
- **A reply won't forward to another AI.** Check whether **Auto** is on for the
  sending pane, or whether a `[TO: X]` tag is present. **Pause/Stop** in Global
  halt all routing.
- **An optional panel says "off" or "not active".** That feature needs its server
  configured — see [section 14](#14-what-you-need-to-run-each-part). Nothing
  breaks; the rest of the app keeps working.
- **The window feels cramped.** **Minimize panels** you aren't using with their
  **⌄** button, and **scroll** — the whole control area scrolls vertically.
- **I want my conversation saved.** It already is — in the database — and you can
  also **Copy Transcript** or **Download .md** at any time from the export bar.

---

*This guide covers the app on the current `main` branch. Features marked 🔌 need a
server you provide; ⚙️ are built and tested but not yet given their own on‑screen
control; ⏸️ are present but switched off.*
