# AutoInjector — User guide

This guide is for writers. It explains, in plain words, how to start AutoInjector, make a book with Akọwe, and use
the pictures, video, voice and Alfred. In the app, **❓ Help → 📖 User guide** (top right of the window, or the Help
menu) opens this page. For how the parts work behind the buttons, see
[How AutoInjector works](https://github.com/javon86/AutoInjector/blob/main/docs/HOW_IT_WORKS.md).

> AutoInjector drives the ChatGPT, Claude and Gemini websites with **your own** sign-ins, on your PC. There are no
> API bills. Automating these websites may be against their terms of service; use it at your own discretion.

## 1. Starting the app

**What you need once:**

- [Node.js](https://nodejs.org/) (press the LTS button, keep the default options).
- [Python 3.10 or newer](https://www.python.org/) for Akọwe, the book writer. Tick **"Add python.exe to PATH"**
  when you install it.

**To start:** open the AutoInjector folder, then `desktop-app`, and double-click **`run-windows.bat`**. The first
start installs what it needs (a minute or two). After that the window opens in a few seconds. Akọwe starts by
itself with it — you do not need to start Akọwe separately.

**The window** has four tabs at the top: **🤖 AutoInjector** (the three AIs), **📖 Akọwe** (your books),
**🎨 Images** (pictures) and **🎬 Video** (short clips). On the right of the top bar are **🎤** (talk to the AIs),
**❓ Help** and the **🎩 Alfred** switch.

**Sign in once:** in the 🤖 AutoInjector tab, sign in to ChatGPT, Claude and Gemini inside their own panes. The
sites remember you, so you only do this once.

### ✅ The setup checklist

The first time you start the app, a **✅ Setup checklist** opens. It shows a green tick (✅) or a red cross (❌) for
everything the app can use, and a **Fix it** button next to each one that opens the right place or does the job:

- **Needed for books:** signed in to ChatGPT, Claude and Gemini; Akọwe is running; the content folder
  ("stuff and thing") is chosen; enough free disk space.
- **Optional extras** (⚪ when not set up — nothing is broken): Alfred's AI (Ollama and a model), the voice engine,
  Stable Diffusion for pictures, the video engine, and the Claude Code helpers.

⏳ means "not sure yet" — for example an AI that has not been checked yet. The checklist opens by itself on later
starts only while something needed has a red cross. Tick **"Don't show this by itself again"** to stop that. You can
always open it from **❓ Help → ✅ Setup checklist**.

### 🧭 Guided tours

The first time you open each main page (the AutoInjector page, 📖 Akọwe, 🎨 Images, 🎬 Video and Alfred's panel), a
short tour points at the important parts, one sentence at a time. Press **Next**, **Done** or **Skip**. A tour you
finished or skipped does not come back. **❓ Help → 🧭 Replay tours** shows them again. Akọwe's own My books page has
its own short tour too (Akọwe → ❓ Help → 🧭 Take the tour).

## 2. Talking to the three AIs

- Type in the **Compose** box at the top left, then click an AI's name (**→ ChatGPT**, **→ Claude**, **→ Gemini**) or
  **→ All**. Untick **Active** to leave an AI out.
- Each AI answers in its own pane. The AIs can pass replies to each other; **🛑 Stop AIs Talking** stops that.
- **⟳** on a pane reloads that website. **🆕 New Chat** starts a fresh chat in all three.
- **The AIs repair themselves.** About every 20 minutes AutoInjector sends each idle AI a tiny test message. If an AI
  stops answering, AutoInjector tries to fix it by itself (finding the message box again, reloading the page,
  pressing Stop). If it cannot, it tells you once.
- If a website changed its layout and the AI still does not work, press **🎯 Point at it** and click the message box,
  the Send button or the reply, or press **🔢 Do it for me with a number** and follow the steps.
- **"Akọwe is using this AI":** while Akọwe waits for an answer, that AI's card shows a yellow note. Don't type in that
  AI's window until it is done; use another AI meanwhile.

## 3. Making a book (📖 Akọwe)

Open the **📖 Akọwe** tab. Akọwe's pages show inside AutoInjector. If the page looks stuck, press **↻ Reload** above
it; **⇱ Pop out** gives Akọwe its own window.

### Two ways to make a book

- **➕ New book:** you write the book with the AI, step by step: characters and places, the plan (premise, main plot,
  chapter outline), then the chapters. Every piece the AI makes waits for your OK (**📝 Waiting for your OK**).
- **⚡ AI writes the whole book** (also called ⚡ Make a book): the AIs write the whole book from start to finish. Pressing
  Start is your permission for that one run only; it makes a new book and never touches your other books. You can
  watch, **⏸ Pause**, **▶ Resume** or **✖ Cancel**. A long book takes a day or two.

On the Make-a-book screen you can choose, among other things: the kind of story and the story shape (or leave them
to the AI), **How many AIs check for mistakes**, **Use Claude Code helpers for this book**, and **"✍ At the end,
check that the book sounds like a person wrote it"**.

### While a long book runs

- The PC stays awake while a book is being written. A Windows restart (updates) still stops the run; press
  **▶ Resume** afterwards.
- If you close the window, AutoInjector asks first. **Keep running in the background** hides the window; a small
  AutoInjector icon appears by the clock (it may be under the **^** arrow). Click it to bring the window back.
- **It tells you when it needs you:** a Windows notification and a flashing taskbar button when the run is paused
  or needs a decision, when an AI is logged out or shows an "are you human?" check, or when every AI has reached
  its usage limit.
- When every AI is at its usage limit, Akọwe waits and carries on by itself when a limit resets.
- Fresh chats: after about 15 Akọwe requests in one chat, AutoInjector opens a new chat in that AI's pane so the chat
  never gets too long. Nothing for you to do.

### When your book needs you

When a run stops for you, the run window, the ⚡ button at the top, the desktop notification and Alfred all say the
same five things: **what kind of issue** it is (for example 🧑 Character issue, 🔗 Story continuity, ⏳ Timeline,
📍 Place / world rule, 📖 Chapter quality, ⚠ AI problem, ⏸ Paused by you), **what it is about** ("Ansel Marrant
(character)", "Chapter 3"), **what is wrong** in a sentence or two, **why it stopped**, and **what to do next**.
Click the notification to go straight to it.

If the AI reviewer and the writer keep disagreeing about the same thing, you get **one** question with the exact
change, before → after, and three buttons: **✔ Accept change**, **↩ Keep the original** or **✏️ Let me edit**. The
book carries on after you choose; until then that record is not approved. Your choice counts as your own approval.

### Where the run stops for you

- The reviewer and the writer disagree about the same thing twice, or a fix would change something you already
  approved: one question with before → after (see above).
- A reviewer still says no after two fixes: choose **✔ Approve anyway**, **✏️ Edit it myself** (then Continue) or
  **🔁 Try again**.
- An AI did not answer in time, even after a second try.
- A check found a problem it could not fix safely.
- Akọwe was closed in the middle of a run: the run shows **Interrupted**; **▶ Resume** carries on.

### Finding your way inside a book

The list on the left of a book: **▶ Next step** (exactly what the book needs next), **📝 Waiting for your OK**,
**🏠 Book home**, **🧑 Characters & places**, **🗺 Plan**, **✍ Write**, **📖 Book Bible**, **🖼 Pictures & cover**,
**🎬 Trailer**, **🧭 Fix mistakes** and **📤 Export**. Akọwe starts in Simple view; **Advanced view** adds the expert
tools. **💾 Save** saves the open book into its folder.

### ✍ Writing alongside the AI

On a chapter's page, highlight a passage (or put the cursor somewhere) and press **✍ Continue from here**,
**🔁 Rewrite**, **🎨 Describe more**, **➕ Expand** or **✂ Tighten**. You see the AI's suggestion next to your text.
Nothing changes until you press **✔ Use this**, which saves a new version for you to approve.

For a big decision (a twist, an ending, a character's secret), the **🗳 Writers' room** asks each working AI for one
idea. The AIs rank each other's ideas without knowing whose is whose; using an idea saves it as a draft for you to
approve.

## 4. The Book Bible and the 🗺 Story map

**The 📖 Book Bible** is a binder of your whole book, one page per thing: at a glance, the cast, a page per character,
the relationship map, places, magic and items, the map, the story plan, a page per chapter, and rules and facts. Its
look is picked from the genre (**🎨 Look** changes it). It fills itself before and while the book is written;
**✨ Fill from the book** proposes missing small facts for you to approve. **⬇ PDF** and **⬇ Word** download it (a
copy is also saved in the book's `Book Bible` folder).

**The 🗺 Story map** (📖 Book Bible → 🗺 Story map) is a live map of who and what is connected: family, love and hate,
friends and enemies, who knows which secret, who owns what, who lives where, clues and subplots.

- It fills itself after every chapter. New connections are dotted lines (drafts).
- A connection a chapter shows on the page becomes **🔒 locked**, like every other detail on the page.
- If a later chapter seems to change a locked connection, nothing is changed: the line turns **red** and you choose
  **Keep it as it is** or **Accept the change**.
- You can add, edit, **✔ approve** or delete connections, and add your own secrets, clues and subplots.
- Gap warnings show things like a subplot that has not moved for 5 chapters or a clue that never paid off (tick
  **Only problems**). The **As of chapter** slider shows the map at any point of the book.

**Series:** a character's name, personality and voice stay fixed across a series; looks, belongings and status can
change per book. Before a sequel, **✨ Find what changed in this book** proposes those changes for you to approve.

## 5. How the book is checked

Every chapter is checked several times before it counts as part of the book:

- **Akọwe's own checks** and **two independent reviewers** (the AIs that did not write the chapter). An AI never
  approves its own writing.
- **The editor** reads it for craft and asks for rewrites of exact passages.
- **🔎 All-AI chapter check:** every working AI reads the chapter against its plan, the Book Bible and the running
  notes. What two or more AIs agree on is fixed.
- **Running notes** keep track of injuries, belongings, who is where, the day, secrets and money.
- **Every 5 chapters** a continuity checkpoint rereads the recent chapters and each AI writes a short review.
- **The ending check** after the last chapter: does every setup pay off, does every character get an ending?
- **✍ Sounding human:** the writer is told the AI phrases and habits to avoid, the book's own repeats are counted,
  and at the end Akọwe suggests rewrites of the most machine-sounding lines. Nothing changes until you tick them
  and press **✔ Use**.
- **🔎 Check consistency now** (on the run window, 🏠 Book home and 🧭 Continuity) runs the same all-AI review on the
  chapters you choose, at any time.
- The **📊 Book report** shows the scores, who checked the book and how far they agreed. An optional beta-reader
  step reads the book as 1, 2 or 3 kinds of readers.

### 📊 Who checks, and how good each checker is

- **📊 How good is each checker** (⚙️ Settings, the run window when a book is done, and the 📊 Book report) shows, for
  ChatGPT, Claude, Gemini (and the 🤖 Claude Code helpers and 🎩 Alfred when they check), how often their corrections
  held up, how many were false alarms lately, and how often they missed something another AI found — for example
  "ChatGPT: 87% of its corrections held up · 3 false alarms in the last 50". With fewer than 10 checks behind it, an AI
  says "needs more data": a few lucky or unlucky checks prove nothing. Only numbers are kept, never your book's words.
- **🔢 Which AI checks first** (⚙️ Settings, and "Checkers: … Change" on the ⚡ Make-a-book screen for one book):
  **Automatic** puts the AI with the best track record first once there is enough data; **My own order** lets you
  move them with ↑ ↓; tick **Don't use for checks** to keep an AI from checking (it can still write). The AI that
  wrote a draft never checks it while another AI can. If you switch off so many that too few can check, Akọwe says so,
  for example "Only ChatGPT can check right now because Gemini is switched off for checks and Claude is the writer."
- **🧑‍⚖️ Stand-in when I don't answer** (⚙️ Settings, off until you switch it on): when a book waits for your answer on
  an AI disagreement and you don't answer within the time you picked (10, 20, 30 or 60 minutes), a stand-in decides so
  the book goes on — 🤖 Claude Code, or the AI that was not part of the disagreement, or 🎩 Alfred for small, simple
  corrections only. It never decides the plot, the ending, the main character, point of view or tense, your content
  limits or your lock list; if it is unsure, it keeps waiting for you. Each decision is shown in the run window and on
  🏠 Book home — "🎩 Alfred approved the correction to Ansel Marrant (character) at 10:05 because you didn't answer for
  20 minutes. Why: …" — and the desktop notification says it was decided for you. Press **↩ Undo** to put the other
  choice back for your own approval. At most 5 stand-in decisions per book run.

## 6. Pictures

**In the 🎨 Images tab:**

- Choose the **Engine**: Stable Diffusion on your PC (Forge, A1111, SD.Next or ComfyUI, also through Stability
  Matrix), **ChatGPT** (it draws in its own pane), or **Auto**.
- No Stable Diffusion yet? **⚙ Start & install** finds, starts or installs one.
- Describe the picture and press **🎨 Generate**. Pictures are saved in `stuff and thing/images/`, each with a small
  file of the settings that made it.
- **🔒 Character locks** keep a character's face the same in every picture. **🧩 LoRAs** and **🧩 Add-ons** are for
  extra looks and tools.

**In Akọwe:** 🖼 Pictures & cover makes pictures of characters, places and chapters, and the 🎨 cover. In a ⚡ run each
character gets a portrait, which becomes that character's lock. Pictures never hold up the book.

## 7. Video

**In the 🎬 Video tab:**

- **⚙ Setup & models:** use the **FramePack** you already have (for example from Stability Matrix; nothing is
  downloaded), or install ComfyUI and a **Wan** video model in one click.
- **🎬 Make video:** describe what happens (text → video), or drop a picture (picture → video).
- **🎞 Trailer:** shots and title cards joined into one trailer. Akọwe's 🎬 Trailer page plans the shots from your
  book.
- **🩺 Test pictures & video:** Quick checks that everything is reachable; Full makes one picture, one clip and a tiny
  trailer. Each ❌ says what to try.

Clips are saved in `stuff and thing/videos/` (trailers in `videos/trailers/`). Video on your graphics card is not yet
fully confirmed on your PC; the 🩺 test shows what works.

## 8. Voice and the microphone

- **🎤 at the top:** click it and speak; it turns red and counts the seconds. Click again and your words are typed
  into the AIs for you. The box beside it chooses who hears it: **All**, one AI, or 🎩 Alfred. **Esc** stops without
  sending.
- **🎤 in each AI's header** sends to that AI only.
- **◀ 🔊 ▶ on each AI** steps through its replies; **🔊** reads one aloud and **⏹** stops.
- Speaking to the AIs needs the free **voice engine** (Setup Wizard → 📦 Installs → "Voice engine"). It works offline.
  The first time, it downloads the speech model (about 150 MB).
- Hearing the replies needs nothing: it uses the voices built into Windows. For nicer voices, install a voice
  model (Setup Wizard → 📦 Installs → "Voice model").
- What you say and what is read stay on your PC. The log notes only that something was heard, never the words.

## 9. Files the AIs give you (downloads)

When ChatGPT, Claude or Gemini offers a file and you click it, AutoInjector saves it straight into that AI's folder:
`stuff and thing/ai-work/<the AI>/` (for example `ai-work/claude/`). The AI's column shows the progress, then
**✅ … gave you …** with **📂 Open folder** and **Open file**. The **⬇** button on each AI, and **File → ⬇ Open the
AIs' downloads folder**, open the folder any time. A download that breaks off is tried again by itself.

## 10. 🎩 Alfred, your assistant

- Alfred is **off** until you press **🎩 Alfred: Off** in the top bar. His panel opens on the right, on every tab.
  **Ctrl+Shift+A** shows or hides it; **×** hides it while he stays on.
- **His big buttons:** 🧑 Make a character, 🎨 Make a picture, 🎬 Make a video, 🖼 Design a cover, 📖 My book,
  ✍ Continue / make my book, 🩺 Check everything, ❓ Everything I can do. You can also ask him in your own words.
- **"I will…" cards:** before he changes anything, he shows what he will do. Nothing happens until you press
  **✔ Do it**. He never approves your chapter drafts.
- **His AI ("brain"):** a local model through Ollama (nothing leaves your PC), an AI you connect with a key, or one
  of the ChatGPT / Claude / Gemini panes. Choose it with **⚙** in his panel. The first time, **⚡ Set up** installs
  Ollama and a model that fits your PC (or uses what you already have).
- **🩺 Check everything** checks his AI and the whole app and shows what to fix.

## 11. 🤖 Claude Code helpers (optional — makes books faster)

Claude Code is Anthropic's command-line tool. When it is on your PC and signed in, Akọwe runs small side jobs
through it while the three web AIs do the main writing: research for the chapters ahead, fact checks with sources,
checks side by side, and the "sounds like AI" pass. It uses your own Claude plan, so it shares that plan's usage
limits with the Claude pane.

1. Install it from the official page, https://code.claude.com/docs/en/setup (on Windows: open PowerShell and run
   `irm https://claude.ai/install.ps1 | iex`).
2. Type `claude` in PowerShell once, press Enter and sign in with your Claude account.
3. In Akọwe, **⚙️ Settings → 🤖 Claude Code helpers** should say "✔ Claude Code … found, signed in" (press
   **↻ Check again** after installing). There you can turn it on or off, choose how many helpers work at once (1–5)
   and which jobs they do.

Without it nothing breaks: every job goes to the web AIs, exactly as before. The ✅ Setup checklist shows its state.

## 12. When something goes wrong

- **❓ Help → 🩺 Something's wrong?** looks at the AI panes, Akọwe, a running book, the AIs' usage limits, Ollama,
  Stable Diffusion, the voice engine and the last 24 hours of the activity log, and shows the top problems in plain
  words, each with a fix button. If nothing is wrong, it says so.
- **📄 Make a report for support** (in the same window) saves a file with the last 24 hours of the activity log and
  the message trace, with keys and private folder names removed. Your conversations with the AIs and your own files
  are never put in it. Attach that file when you ask for help.
- **An AI shows ⚠️ Needs you** (logged out, an "are you human?" check, a usage limit): fix it in that AI's pane.
  AutoInjector notices by itself. Meanwhile, Akọwe gives the work to the other AIs.
- **A book run pauses with ⚠️:** read the message on that step; it says what happened and what to do.
- **Pictures or video fail:** run **🩺 Test pictures & video**.
- **To share a log yourself:** **⤓ Extract All** → **Last 24 hours**. Never choose **Everything**: it includes all
  your older, private conversations.

## 13. Where everything is saved

| What | Where |
|---|---|
| Pictures, videos, trailers | `stuff and thing/images/`, `stuff and thing/videos/` |
| Files the AIs give you | `stuff and thing/ai-work/<the AI>/` |
| Models (pictures, video, Ollama…) | `stuff and thing/models/` |
| Reports, test results and support reports | `stuff and thing/logs/` |
| Your books (one folder each) | `Documents\Akowe Books\` (change it in Akọwe → ⚙️ Settings → 📁 Where books are saved) |
| Akọwe's working data and backups | `%LOCALAPPDATA%\Akowe` |
| AutoInjector's settings and sign-ins | `%APPDATA%\autoinjector-desktop\` |

Inside one book's folder: `Book/` (PDF, EPUB, Word), `Chapters/`, `Book Bible/`, `Reports/`, `Log/`, `Cover/`,
`Pictures/`, `Trailer/`, `Launch kit/` and **`book.akowe`** — the whole book in one file, for opening it again, even on
another PC. Your book's text is sent to the AI websites you use (that is how they write it); logs keep what happened,
not your prompts or replies.

## 14. Updating the app

1. Close AutoInjector (if a book is being written, let it finish or pause it first).
2. Open **GitHub Desktop**, choose the **AutoInjector** repository, press **Fetch origin**, then **Pull origin**. (If
   it says there is nothing to pull, you already have the newest version.)
3. Double-click `desktop-app\run-windows.bat` again. It installs anything new by itself, then opens the app.

Your books, settings, sign-ins and the "stuff and thing" folder are kept when you update.

## 15. Words you may see

| Word | Meaning |
|---|---|
| Pane | one AI website inside the window |
| Check-in | a tiny test message that checks an AI still answers |
| Draft / approve | a new piece waits as a draft until you (or a run you started) approve it |
| Canon | everything approved: the book's official truth |
| Locked detail (🔒) | a fact a chapter has used, which later chapters must keep |
| Running notes | injuries, belongings, places, days, secrets and money, kept up to date after each chapter |
| Checkpoint model | a Stable Diffusion picture model (nothing to do with continuity checkpoints) |
| LoRA | a small add-on to a picture model for one look or style |
| "stuff and thing" | the app's folder for pictures, videos, models, downloads and logs |
