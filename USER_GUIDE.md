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
11. [System Monitor and the Test button](#11-system-monitor-and-the-test-button)
12. [The Manager (optional 4th brain)](#12-the-manager-optional-4th-brain)
13. [The System AI / Local Supervisor](#13-the-system-ai--local-supervisor)
14. [Book Governance (ATELIER) — on hold](#14-book-governance-atelier--on-hold)
15. [What you need to run each part](#15-what-you-need-to-run-each-part)
16. [Troubleshooting](#16-troubleshooting)

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
[section 15](#15-what-you-need-to-run-each-part).

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

At the very top is a **menu bar** — **File / View / Tools / Help**. It's a quick
way to jump around: **Tools → System Monitor** or **Tools → Image Studio** scrolls
that panel into view, and **Help** links back to this guide.

Below the menu bar is one big scrollable area. **If there's more than fits, scroll
up and down** — a scrollbar appears on the right.

There are **two different ways things collapse**, on purpose:

- **Utility panels** (Global, House Rules, Prompt Library, Project Memory, Project
  State, System Monitor, System AI, Image Studio) have a **⌄ button** in their
  heading — or you can just **click the panel's title**. Either one **tucks the
  whole panel up into a row of tabs across the top** (the "top tab strip"), freeing
  the space below. Click that tab to bring the panel back. This lets you keep just
  the panels you're using open.
- **The three AI panes** don't move to the top — they stay in the AI workspace and
  use their **three states** instead *(open → reduced → minimized, see below)*.

From top to bottom you'll typically see:

- **User Panel** *(always visible)* — your main controls:
  - **Compose** — the box where you type a message.
  - **Send / Active** — pick which AIs a message goes to, and which are
    participating.
  - **Attach, Roles, Sequence** — attach a document, assign roles, or build a
    prompt sequence.
  - **🆕 Start New Chat** — one click starts a **fresh chat in all three AIs at
    once** *(see §7c)*.
  - **🤖 System AI** — a one‑click switch that turns the System AI helper on or
    off without opening its panel; the button shows **On/Off** *(see §13)*.
  - **🧪 Test** — runs a full system check and drops the report straight into your
    messages *(see §11)*.
  - **Messages to you** — a small feed of replies an AI addressed directly to you.
- **Global** — the master **Auto / Pause / Stop** buttons and the **Tuner**.
- **House Rules** — structured conversation formats (Debate, Brainstorm, …).
- **Prompt Library** — saved prompts you can reuse.
- **Project Memory** — add and search project records *(see §9)*.
- **Project State** — a read‑out of the project's internal state *(see §9)*.
- **System Monitor** — a read‑only look at your CPU/GPU/RAM and what this machine
  can run *(see §11)*.
- **System AI (Supervisor)** — switch on a small local AI that helps run the app,
  and download a model for it *(see §13)*.
- **Image Studio (Stable Diffusion)** — generate images, with presets and a
  built‑in viewer *(see §10)*.
- **The three AI panes** — ChatGPT, Claude and Gemini live, side by side, always
  in that **fixed left‑to‑right order** (ChatGPT | Claude | Gemini). Each pane has
  **three states**, cycled with the button in its corner — the button shows the
  **next** state you'll get:
  - **Open** — the pane's controls, the reply preview, **and** the live embedded
    website.
  - **Reduced** — the controls and reply preview, with the embedded website
    **hidden** (saves height while you still see the last reply).
  - **Minimized** — just a **thin provider bar**; click **anywhere on the bar** to
    reopen the pane.

  Changing a pane's state **never moves it** to another slot. Every pane also has a
  small **row of buttons in its header** *(see §7a)*: **－ / 100% / ＋** zoom,
  **🔍** DevTools, **🎯** fix‑selectors (which also holds a **🧪** self‑test),
  **🔑** saved logins, and **⟳** reload.
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
During a **Brainstorm**, a **Wrap up** button appears to make the AIs pull their
ideas together into a summary.

---

## 7. Other sending tools

### 7a. Each AI pane's own controls ✅

The header of **every AI pane** carries a small row of buttons that act on that
one pane:

- **－ / 100% / ＋** — **zoom** the live embedded page in/out (fit more of the
  real conversation, or make it bigger).
- **🔍** — open **DevTools** on that pane (mainly for fixing selectors).
- **🎯 Fix selectors** — opens a small menu to **teach the app where a site's
  boxes are**: **Pick Input**, **Pick Send**, **Pick Reply** (click the button,
  then click the real element in the pane), plus **Clear Overrides** to undo. Use
  this if a site changes its layout and injection stops working — no DevTools
  needed. **This same menu also holds the per‑pane 🧪 Test** (below).
- **🔑 Logins** — open the **saved‑logins** menu for that site: fill a saved
  username/password and click **Sign In** *(also listed below)*.
- **⟳** — **reload** that pane.

**🧪 Test (per pane)** lives **inside the 🎯 Fix selectors menu** (not the header
row). It sends a **real test prompt**, waits for the reply, and lights the pane's
indicator **green or red** depending on whether the round‑trip actually worked.
*(This is different from the User Panel's **🧪 Test**, which runs a hardware
system check — see §11.)*

### 7b. Sending and helper tools

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

### 7c. Start New Chat (all three at once) ✅

The **🆕 Start New Chat** button in the **User Panel** (right after **🧵
Sequence**) starts a **brand‑new chat/session in ChatGPT, Claude and Gemini
together** — one click, all three panes jump to a fresh conversation. It also
clears the app's memory of each pane's last reply, so a fresh chat won't be
confused with the previous one. Use it whenever you want a clean slate for all
three AIs without reloading them one at a time. *(Your logins stay signed in —
this only opens a new conversation.)*

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
Stable Diffusion server. It speaks the **Automatic1111 API**, so anything that
serves that API works:

- **Forge** ([lllyasviel/stable-diffusion-webui-forge](https://github.com/lllyasviel/stable-diffusion-webui-forge))
  — **recommended**. It's API‑compatible with Automatic1111 but noticeably
  **lighter and easier on your system**, and runs comfortably with an **SD 1.5**
  model.
- **Automatic1111 (A1111)** ([AUTOMATIC1111/stable-diffusion-webui](https://github.com/AUTOMATIC1111/stable-diffusion-webui))
  — the original; heavier, also fully supported.

Either one can run locally with a GPU or on a RunPod pod. Start light with an
SD 1.5 model; you can **install bigger models later** and pick them from the
panel's model dropdown.

**Set it up:**
1. Open **Image Studio (Stable Diffusion)**.
2. Put your server address in the box (default `http://127.0.0.1:7860`) and click
   **Test**.
3. Tick **Enable image generation**, and optionally **Let AIs trigger with
   `[IMAGE: …]`**. Click **Save settings**.

**Choose a model:** the **model dropdown** lists the checkpoints your server has
installed; **⟳** refreshes it. Pick the one to render with — no need to keep the
lighter model if you've added a bigger one.

**Presets & controls:** one‑click **presets** set sensible values for common
looks, and you can fine‑tune **steps, CFG scale, width, height, sampler, batch
size and seed** before generating.

**You generate:** type a prompt (and optional negative prompt), click
**Generate**. Or click **↳ ChatGPT / ↳ Claude / ↳ Gemini** to drop that AI's last
reply into the prompt box first. The result shows in the **built‑in image
viewer**, where you can **save the image**, **copy its prompt**, or **send it into
the conversation**. Past renders stay in the gallery.

**The AIs generate:** with the checkbox on, any AI reply that **starts with**
`[IMAGE: a lighthouse at dusk]` renders that image automatically — the same idea
as `[TO: X]`.

**Saved to the project ✅:** every render is stored as a searchable image record
(prompt, seed, model, a content hash) plus a versioned artifact — find it later
via **Project Memory** search. (Saving works even while you're still setting up
the server.)

---

## 11. System Monitor and the Test button

**System Monitor** ✅ is a **read‑only** panel that looks at your hardware and
tells you, in plain language, **what this machine can run**. It reports your
**CPU** (model, cores, and temperature when available), **RAM** (total/used),
**GPU(s)** and their **VRAM**, and your **OS**. From that it recommends a **local‑
model tier** and a **Stable Diffusion tier** — so you know which model to get
before you download anything. It **installs nothing** and changes nothing; it
just measures and advises. Click **Refresh** to re‑read the hardware. (Reach it
any time from **Tools → System Monitor**.)

**🧪 Test button** ✅ — in the **User Panel**, right after **🧵 Sequence**. One
click runs that same system check and **posts the report straight into your
messages** (it appears in the **Conversation**/message log, labelled *System
Check*) — and it's **saved to the project database** like any other message, so
you can scroll back to it or export it later.

---

## 12. The Manager (optional 4th brain) ⚙️

The **Manager** is a supervising model that plans a task and delegates pieces to
the three panes, reads what comes back, asks for corrections when they disagree,
and saves results to a folder. Unlike the three chat panes, it would use a real
model endpoint (**Ollama** / **LM Studio** locally, or a **RunPod** pod).

> **Status:** the Manager is **built and wired in the background, but it has no
> on‑screen control yet** — there is no Manager panel or button in the current
> interface, so you can't switch it on from the app. It's listed here so you know
> it exists and is coming; nothing to test for it right now.

---

## 13. The System AI / Local Supervisor 🔌

This is a small **local** AI meant to help **run the app itself** — the app's
**fuzzy judgment calls** like "is this reply just a duplicate 'ok'?" or "does this
message need an answer?". It **never touches the three chat AIs' logins**.

**What works right now** — the whole **setup and control** side:

- **The one‑click switch** — the **🤖 System AI: On/Off** button in the **User
  Panel** (next to **🧵 Sequence**) flips it on or off without opening anything.
  The same checkbox lives inside the **System AI (Supervisor)** panel, and the
  button always shows the current state.
- **Choose, download and install a model** — the panel recommends models that fit
  **your machine** (based on the System Monitor reading). Pick one under **Get**
  and click **⬇ Download**: if you have **[Ollama](https://ollama.com)** installed,
  the app downloads and installs the model for you and **streams progress**; the
  **Model** dropdown (with **⟳**) then lists what's installed so you can select
  it. If Ollama isn't installed, the panel tells you so and points you to
  ollama.com — **nothing is installed silently**.
- **Endpoint + Test + Save** — set the **endpoint** (default
  `http://127.0.0.1:11434/v1/chat/completions`), click **Test** to confirm it's
  reachable, and **Save settings**.

**What isn't wired up yet** — turning the switch on, downloading a model, and
saving settings all work, but the app does **not yet route any live decisions
through this AI**: it isn't doing the duplicate‑filtering or smart‑routing yet.
That connection is the next step. So for now, testing this section means testing
**the switch, the model download/install, the connection test, and saving** — not
a change in how messages get filtered. With it off, the app runs exactly as it
does today (plain‑code mode) — **no downtime**.

---

## 14. Book Governance (ATELIER) — on hold ⏸️

There's an optional system for using the app to **write a structured book**,
where each AI has a role and may only write certain files (so, for example, the
"auditor" AI can't secretly rewrite a chapter). It is **currently switched off**
and hidden from the interface — the code is kept and can be turned back on later.
It requires Python 3 when active.

---

## 15. What you need to run each part

| Part | What it needs |
| --- | --- |
| **The app + the three AIs** | Node.js, and login accounts. That's it. ✅ |
| **Conversation, database, memory, search** | Nothing extra — built in. ✅ |
| **System Monitor + 🧪 Test** | Nothing extra — built in. ✅ |
| **Manager** | Built in the background, but **no on‑screen control yet** — nothing to run today. ⚙️ |
| **System AI (Supervisor)** | A local model — easiest with [Ollama](https://ollama.com); the panel downloads one for you. Setup/switch work; it isn't filtering messages yet. 🔌 |
| **Image Studio** | A **Forge** (recommended, lighter) or **Automatic1111** server with a GPU (local or RunPod). 🔌 |
| **Book Governance (ATELIER)** | Python 3 — but it's on hold, so nothing for now. ⏸️ |

---

## 16. Troubleshooting

- **A reply isn't being read / nothing happens.** Make sure you're **signed in**
  to that site in its pane, and that the pane isn't collapsed. Use **🎛️ Run
  Tuner** to see exactly which connections work.
- **A site changed its layout and injection breaks.** The app keeps several
  fallback ways to find each site's input box and send button; if a site updates,
  this is the first thing that may need a small fix. Use the pane's **🎯 Fix
  selectors** menu (**Pick Input / Send / Reply**) to point the app at the right
  elements live *(see §7a)*, and the **Activity / Troubleshooting** log will show
  the error.
- **A reply won't forward to another AI.** Check whether **Auto** is on for the
  sending pane, or whether a `[TO: X]` tag is present. **Pause/Stop** in Global
  halt all routing.
- **An optional panel says "off" or "not active".** That feature needs its server
  configured — see [section 15](#15-what-you-need-to-run-each-part). Nothing
  breaks; the rest of the app keeps working.
- **The window feels cramped.** **Minimize panels** you aren't using with their
  **⌄** button, and **scroll** — the whole control area scrolls vertically.
- **I want my conversation saved.** It already is — in the database — and you can
  also **Copy Transcript** or **Download .md** at any time from the export bar.
- **After updating, the app won't start / "Cannot find module …".** An update added
  a dependency your machine doesn't have yet. Just launch again with the normal
  launcher (`run-windows.bat` / `run-mac.command` / `run-linux.sh`) — it now
  **re‑installs automatically** whenever the requirements change. To do it by
  hand, open a terminal in the **`desktop-app`** folder and run **`npm install`**,
  then start the app. (Even if it slips through, the app no longer crashes — the
  **System Monitor** just shows a "run `npm install`" note and everything else
  keeps working.)

---

*This guide covers the app on the current `main` branch. Features marked 🔌 need a
server you provide; ⚙️ are built and tested but not yet given their own on‑screen
control; ⏸️ are present but switched off.*
