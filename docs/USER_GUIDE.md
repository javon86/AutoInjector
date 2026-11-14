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
- **"Claude's page changed; AutoInjector stopped using an old saved setting that no longer fits."** You may see
  this line under the Compose box. It means a part you (or AutoInjector) once saved with 🎯 no longer matches that
  website, so AutoInjector went back to its built-in way, which works. It does this after the old part did not fit on
  3 starts of the app (2 if it never found a single reply). One you saved in the last hour is left alone. Nothing to
  do. If things got worse after it,
  press **↩ Put it back**; **✕** just hides the line.
- **"Akọwe is using this AI":** while Akọwe waits for an answer, that AI's card shows a yellow note. Don't type in that
  AI's window until it is done; use another AI meanwhile.

### 💾 Save state / 📂 Load state — come back to where you were

- **💾 Save state** (top bar): type a name, for example *Salt Keeper ch 12*, and press **💾 Save**. AutoInjector
  remembers the chat each AI is on (ChatGPT, Claude and Gemini), a copy of their recent replies, what is in the
  Compose box, which AIs are **Active** (and whether 🎩 Alfred is in **→ All**), the open tab, how big each pane is,
  the folded panels, the window size, who forwards to whom, the AIs' roles, your 🧵 prompt sequence and the 📖 book
  that was open. Saving again with the same name asks before it replaces the old one.
- **📂 Load state** shows your saves with their name, date and time. **📂 Load** sends all three AIs back to their
  saved chats at once, so you can keep talking where you stopped, and puts everything else back. A loaded 🧵
  sequence waits in **🧵 Sequence** — nothing is sent until you press Run there.
- **If a chat is gone** (deleted on the site, the site opened a new chat instead, or you are signed out), the result
  says so in plain words and shows **the saved copy** of that chat's replies to read (you cannot change it).
  **📜 Saved text** shows a save's copy any time.
- **✎ Rename** and **🗑 Delete** are on each save. AutoInjector keeps up to 200 saves.
- If a book is being written, or a picture or video is being made, **📂 Load** asks first ("Load it anyway?"),
  because moving the AIs to other chats could spoil that work.
- You can also ask 🎩 Alfred: "save this as Salt Keeper ch 12", "load Salt Keeper ch 12". Before he loads one he
  shows an "I will…" card.
- Saves stay on your PC (`%APPDATA%\autoinjector-desktop\saved-states\`, one file each). Nothing is sent anywhere.
  A save only ever opens chats on chatgpt.com, chat.openai.com, claude.ai and gemini.google.com.

## 3. Making a book (📖 Akọwe)

Open the **📖 Akọwe** tab. Akọwe's pages show inside AutoInjector. If the page looks stuck, press **↻ Reload** above
it; **⇱ Pop out** gives Akọwe its own window.

### Two ways to make a book

- **➕ New book:** you write the book with the AI, step by step: characters and places, the plan (premise, main plot,
  chapter outline), then the chapters. Every piece the AI makes waits for your OK (**📝 Waiting for your OK**).
- **⚡ AI writes the whole book** (also called ⚡ Make a book): the AIs write the whole book from start to finish. Pressing
  Start is your permission for that one run only; it makes a new book and never touches your other books. You can
  watch, **⏸ Pause**, **▶ Resume** or **✖ Cancel**. A long book takes a day or two.

On the Make-a-book screen you can choose, among other things: your **Pen name** (printed on the title page and the
cover; the AI never makes one up — leave it empty to use the pen name you typed last, or none; the plan check warns
if it is also the name of one of your characters), the kind of story and the story shape (or leave them to the AI), **How many AIs check for mistakes**, **Use Claude Code helpers for this book**, and **"✍ At the end,
check that the book sounds like a person wrote it"**.

💡 **Tip:** for the best book, pick the strongest model in each AI window (ChatGPT, Claude, Gemini) before you press
Start — for example a "thinking" model if your plan has one. The tip by Start (and above the AI cards in AutoInjector)
goes away for good when you press ✕.

If you have not filled in **✒️ My writing style** yet, the plan shows a short tip: "Tip: paste a few paragraphs of your
own writing into ✒️ My writing style so every AI writes in your voice". Click the link to go there, or **Don't show
again** to hide it. It never stops you from starting.

**🤫 Hide the twist better** (⚙️ Settings, on unless you switch it off): when the AI plans the book, every clue to a
secret also gets an innocent explanation, there is at least one fair red herring, and readers should not be able to
work out the twist before about two-thirds of the book. The chapters before that point are told not to give the
secret away or hint at it too hard. This costs no extra AI work.

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
- Every **new book** also starts in a fresh chat in each AI, so nothing from your last book (a character's name,
  story details) can slip into it. Resuming the same book keeps its chat. If you are typing in an AI's window
  yourself, AutoInjector waits and does it a bit later. To switch it off: 📖 Akọwe panel → untick **and for every
  new book**.

### ⏳ How long is my book going to take?

Before you press Start, the ⚡ screen shows an estimate ("about 4–6 hours"). Once the run starts, Akọwe keeps that
estimate and shows where you are in it **at the top of every page**, in one line:

> 📖 “The Salt Road” · Step 12 of 19 — Writing chapter 2 of 10 · ⏳ about 1 h 40 m left (estimate at start: 4 h 10 m)
> · started 9:21 · should finish around 11:05

with a thin bar under it (how much of the estimated time is done). Click the line to open the run window.

- **The time left gets better as the run goes.** It counts every step still to do — the chapters and also the end
  steps (✍ chapter 1 rewritten last, 🎯 the weakest scenes, 🔁 the final read, beta readers, 🩺 the story doctor, 📏
  the chapter polish). If your AIs are faster or slower than expected, the time left follows how fast this run really
  went (at most twice as long, or half).
- **Waiting for you does not count.** When the run waits for you (a decision, a pause, Akọwe was closed), the line says
  so plainly — "⏸ waiting for you since 9:33 — the clock is paused" — and the clock starts again when you answer.
  Waiting for an AI's usage limit does count: it is part of making the book.
- **More than one run?** The line shows the one that is working, with "+1 more" to see the next.
- **When it is finished** the line says, for a few hours, "✔ “The Salt Road” finished in 5 h 2 m (estimated 4 h 10 m)"
  (✕ hides it). Akọwe remembers how long your runs really took, so the next estimate is closer.
- **In AutoInjector** the same line sits in the title bar, next to 💾 / 📂 / ❓ Help (shorter on a smaller window:
  "⏳ 1 h 40 m left · ~11:05 · 12/19", then "⏳ 1 h 40 m"). Hover it for the whole line; click it to open the run in
  the 📖 Akọwe tab.

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
  **🔁 Try again**. With ✔ Approve anyway your approval stands, and the editor's major notes on that chapter (and the
  reviewer's reasons) are not thrown away: they wait for the final **🔁 Improve until better** pass.
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
  step reads the book as 1, 2 or 3 kinds of readers. If an AI declines to review the book ("I can't help with
  that" — a sad or dark story sometimes trips its safety filter by mistake), Akọwe tells it once that the book is
  fiction under review; if it still declines, another AI (or the 🤖 Claude Code helper) reads the book instead, and
  the report says who declined and who stood in.
- **🕰️ Clock, days and tide check:** Akọwe works out the times, days and tides the book states ("high water at
  18:06") and flags one that cannot be true ("the tide was going out at 14:30" — before high water the tide comes
  in). It also counts the days: "On Sunday … the next morning, Saturday", a Friday "four days later" that is not
  four days later, or "Monday, 6 January" and "Friday, 14 January" in the same book are flagged. The editor and the
  reviewer must fix it, and the next chapter's writer is told the tide times so far.
- **💬 Dialogue in any style:** Akọwe recognises dialogue in "double quotes", “curly quotes”, 'single quotes' (the
  British way) and lines that start with a dash (— Where are you going?), and tells it apart from apostrophes
  (don't, Teo's, the '90s). So the report's dialogue share is right, and the sentence polish never changes a line of
  dialogue, whatever style your book uses.
- **📏 Special rules:** a ghost, magic, a curse or a strange device in the story rules must say where and when it
  works (scope), what it costs and what it can never do (limits). If one does not, the AI fills them in once, before
  the plan is written.
- **✨ Magic rules kept:** an ability, spell or magical device can have a rule Akọwe checks in every chapter (see
  "How to write a magic rule" below). A use that breaks its rule is a must-fix note for the editor before the
  chapter is approved, and the book report says "✨ Magic rules kept: 7 uses, 0 broken".

### ✨ How to write a magic rule

If your book has magic, the book must follow the rules of the magic. Open **🌍 Story rules and world**, press
**✏️ Change them**, and in the rule tick **✨ This rule is an ability, spell or magical device**. Then fill in plain
words, for example teleportation that needs two anchor stones:

| Field | Example |
|---|---|
| Name | Teleportation |
| What it does | Mara steps from where she is to a place she can see. |
| What it needs (one per line) | 2 anchor stones · line of sight · at night only |
| Limits (one per line) | 3 times a day · cooldown 1 hour |
| Side effect or price | a nosebleed |
| Who can use it | Mara |
| Exceptions | (leave empty: there are none) |
| Who holds what at the start | Mara: 3 anchor stones |

- **Things with a number are counted.** "2 anchor stones" is used up at every use (write "2 anchor stones (kept)"
  when they are not used up). Akọwe keeps a **ledger**: who used what in which chapter, what it cost, and what
  people still hold ("Mara found one anchor stone" adds one). You see it on the Story rules page under **✨ Magic
  rules**.
- **Every use is checked**, with no extra AI: enough of what it needs (on the page and in the ledger), the right time
  of day, not too often on one day, not again in the same scene before the cooldown, only by who may use it, and the
  price shown. A broken rule becomes a must-fix note in plain words — "Mara uses Teleportation in chapter 3 with only
  one anchor stone; the rule needs 2." Things Akọwe cannot count (line of sight) are checked by the editor and the
  reviewer, who get the rules too.
- **Breaking a rule on purpose:** write "deliberate twist" (or "breaks the rule") and the ability's name in that
  chapter's outline, or add it under **🎭 Deliberate rule-breaks** on the Story rules page. It is then allowed and
  shown as a deliberate twist.
- The writer of each chapter gets the rules of the abilities the chapter uses and the ledger so far.
- When the AI drafts your story rules, it fills these fields in from your premise; you can change them. An older
  rule written as one sentence ("Teleportation requires two anchor stones; at most three times a day") still works:
  Akọwe reads it the same way when it can.
- Switch it off with the tick box **Check the magic rules in every chapter** on the same page (or the "Story rules
  and world texture" switch of the pipeline).

### 🩺 Plan check: the story doctor, and voices that differ

Most of what reviewers dislike in a finished book — a rule whose numbers do not add up, a final mistake that is hard
to believe, a middle that sags — is already in the plan. A plan is cheap to fix while no chapter exists yet. So,
under **🩺 Plan check** on the ⚡ Make-a-book screen (all on by default; switch any of them off there):

- **Story doctor:** as soon as the plan (premise, main plot, chapter outline) is made, every working AI scores it on
  the same points as the book report, quotes its weaknesses and suggests a fix for each. The AIs must prove a 9 or 10
  with a quote, or it counts as 7 — the same strict rules as the book report. If the plan scores under your aim
  (8.5 unless you pick 8 or 9), the chapter outline is revised with their fixes, checked, reviewed and approved as
  usual, and scored again — at most 2 times unless you pick 1 or 3. The best-scoring plan is kept. Your own idea and
  your lock list are never replaced, and an outline you wrote yourself is only scored. The run window says what
  happened, e.g. "🩺 Plan scored 7.4 → 8.6 after 1 revision", and so does the book report. About 3 to 8 more AI
  answers. It also runs when you approved the outline yourself (✔ Approve anyway or accept the change).
- **Fewer stops on the plan:** when the AI reviewer keeps objecting to the AI's main plot or chapter outline, the
  run does not stop to ask you any more: the story doctor revises the outline with those objections, and the
  revision is reviewed again. You are still asked about your own text, point of view, tense, content limits, a change
  to an approved fact, or when the doctor's revision cannot settle it. To be asked every time, switch off "Let the
  story doctor settle the plan reviewer's objections".
- **Make sure every character sounds different:** each character already gets a voice card (how they talk: sentence
  length, words, favourite phrases, what they never say, how they dodge a question). Akọwe now compares the cards
  without AI; only when two sound alike or one is too thin does the AI make them distinct, in one answer. Cards you
  wrote yourself are never changed. Each chapter's writer gets the cards of the characters in it, and the editor
  checks that every character sounds like their own card.
- **🔧 Get the main characters' trade right:** when your story centres on a trade or craft (a piano tuner, a
  lamplighter, a lighthouse keeper, glassblowing…), Akọwe spots it in the idea, the characters and the chapter plan
  (no AI) and asks for ONE short "how it's really done" card: the right tools, the steps in order, the trade words,
  the mistakes writers usually make (such as turning a tuning pin a quarter-turn) and a few sensory details. When
  🤖 Claude Code is ready it researches the card on the web and lists its sources; otherwise a web AI writes it. You
  find the card in the 📖 Book Bible (World details, and the saved bible file). The writer of every chapter that shows
  the work gets it, and the editor checks those chapters against it: a wrong tool or step is a major note that must
  be fixed. 1–2 more AI answers; none when the story has no trade.
- **🔁 Keep it fresh:** Akọwe remembers short labels of your last 8 books — title words, the main characters' first
  names, the kind of setting, the main motifs (tides, fog, grief…) and the kind of story; never their text. When the
  AI invents your title, names and setting, it is asked to avoid these and to pick a different setting and kind of
  story than your last books. If a title word or a main character's first name still repeats, it is renamed once.
  What you typed yourself (your idea, genre, lock list, choices) is never changed — if your idea says "a coastal
  town", it stays a coastal town. The run window says it, e.g. "🔁 Kept fresh: avoided Odile, Salt, coastal town".
  At most 2 more AI answers, usually none.

### ✍ Chapter 1: two first pages, and rewritten last

Chapter 1 is written before the rest of the book exists, and readers decide on the first page. So, under **✍ Chapter
1** on the ⚡ Make-a-book screen (both on by default; switch either off there):

- **Two first pages, keep the better one:** before chapter 1 is written, the writer drafts two different first pages
  and another AI picks the one that hooks a reader better. Chapter 1 is written on from it. The run window says which
  was picked and why. If that cannot be done (for example only one AI works), chapter 1 is simply written the usual
  way. About 2 more AI answers.
- **Rewrite chapter 1 last:** when the whole book is written, the writer reworks chapter 1 once, now knowing the
  ending, the setups it must plant for later, where the twist must stay hidden, and what the beta readers and
  reviewers said about it. It keeps every name, fact, the plot and the main character. The same AI reviewers read
  the book again: the new chapter 1 is **kept only if the score is at least as good** (if the score is the same, only
  if they found fewer problems in chapter 1). Otherwise your chapter 1 stays exactly as it was. A chapter 1 you wrote
  yourself is never touched. The run window and the report say what happened: "✍ Chapter 1 rewritten with the whole
  book in view: kept (7.6 → 7.8/10)". About 3 to 4 more AI answers.

### 🔁 Improve until better, and 📈 your books over time

- **🔁 Improve until better** (on the ⚡ Make-a-book screen, on by default): when the book is made, Akọwe finds the
  **🎯 3 weakest scenes** and rewrites only those. Every complaint — the reviewers' quoted weak spots, the beta
  readers' top fixes, the editor's major notes and Akọwe's own checks (clock and tide times, the same phrase in
  several chapters) — is matched to the scene it is about; the scenes with the most and most serious complaints win
  (complaints about your book's lowest scores count most). The writer rewrites each of those scenes once, seeing its
  complaints, its scene card, the lines just before and after it, the characters' voices and your style. A rewritten
  scene may be at most 10% longer, and must keep every name and every line the editor said to keep — otherwise it
  stays as it was. The report then says, for example, "🎯 Rewrote 3 weakest scenes (ch1 opening, ch2 photograph
  investigation, ch3 final miscalculation): 7.9 → 8.4 (kept)". 1 round by default (you can pick 2); about 6 more AI
  answers per round. Prefer the older way? Pick "Whole chapters" next to the switch: the writer then reworks the
  chapters with the most to fix (1 or 2 rounds). The **same** AI reviewers then read the book again. The change is **kept only if the score went up and
  nothing dropped by more than a point**; otherwise your book stays exactly as it was. Kept chapters are checked and
  approved like every chapter, and the PDF, EPUB and Word files are made again. The run window, the journal and the
  report show both numbers: "🔁 Improve pass: 7.6 → 8.1/10 (kept)". Chapters you wrote yourself are never touched.
- **📏 Sentence polish** (on the ⚡ Make-a-book screen, on by default): as soon as a chapter is written, Akọwe
  checks — without any AI — whether it reads too simply for your readers (for adult books, under reading grade 5),
  which phrases it repeats from earlier chapters ("water ran off his elbows" again) and whether it has too many lists
  of three ("cold, wet, and tired" more than 3 times per 1,000 words). Only when it does, the writer polishes that
  chapter once: it joins some short sentences into longer, precise ones, says repeated phrases in a new way and breaks
  up some lists of three ("cold and wet", or one exact detail). The story, the facts, the names, the numbers and every line of dialogue stay exactly as they were. The
  polish is kept only if Akọwe's checks got better; otherwise the chapter stays as written. The run window shows both
  numbers ("📏 Reading level 2.9 → 5.4 after polish in chapters 1, 3"), and so does the 📊 report. The same switch
  lets the improve pass keep its repeated-phrase fixes on their own when the rest of its changes are not kept (those
  chapters are checked and approved again like every chapter). At most one more AI answer per chapter, only for the
  chapters that need it. Switch it off to write the chapters the old way.
- **📏 Keep the book's length** (under "Extras" on the ⚡ Make-a-book screen, on by default): Akọwe's own rewrites
  (the editor's rewrites, the sentence polish, chapter 1 rewritten last, the improve pass) may make a chapter at most
  about 10 % longer and never make the book more than about 115 % of its target length. The writer is told the word
  budget and asked to cut repeated explanation rather than add. The run window and the report say the finished
  book's length and each chapter's length against its share: "📏 Length: 4,310 words (108% of the 4,000-word
  target) · chapters against their ~1,333-word share: ch1 1,300 (98%), ch2 1,600 (120% ⚠️), …".
  Each chapter is also written to its share from the start: the writer is told "about 1,333 words — between 1,200
  and 1,466". A chapter that still comes out more than 15 % too long is trimmed in its sentence polish (repeated
  explanation and summary go; dialogue and what happens stay). And when the book is already at its limit, the 🎯
  weakest scenes are still rewritten — the writer is told the exact number of words to stay within (the same length
  or shorter), and a scene that comes back too long is asked once to cut back before it is left as it was.
- **🔁 Read the final book again** (under "Extras", on by default): when chapter 1 is rewritten last or the improve
  pass changes chapters, the final whole-book continuity check reads those chapters again at the very end (it says
  "read again after Akọwe's own rewrites"; Akọwe's own changes are never called "changed by hand"), and — if you
  asked for beta readers — they read the finished book once more, so the report is about the book you get. A
  separate switch turns the beta readers' second read off. Nothing extra happens when nothing changed. The number of
  beta readers is 1 unless you choose 2 or 3 next to "📖 Beta reader at the end".
- **🔮 Beta readers and the premise:** what your premise and blurb say is known from page 1, so a beta reader who
  "guesses" it is not counted as guessing a twist too early. Readers are told the premise; Akọwe keeps the real
  secrets to itself and only counts a guess that is one of them (or one it cannot place). The 🔁 improve pass does not
  treat such a "guess" as a complaint either.
- **📈 Your books over time** (🏠 Book home and the 📊 Book report): "7.6/10 — down 0.4 from your last book",
  "Rule rigor is your weakest area for 3 books", and which scores are falling. Only numbers are kept for this,
  never your book's words.
- **🧠 Lessons for the next book:** your weakest areas and habits from the last books (for example "Every special
  rule needs scope, cost and limits", "Check all clock, tide and date arithmetic") are given to the next book's
  planners and to the writer of every chapter. Inside a book, each new chapter's writer is also told what the
  chapters before already used (a simile, a phrase, "went" 26 times) so it is not repeated, the tide and day facts so
  far, and the reading level to aim for (adult books: at least grade 5).

### 📊 Who checks, and how good each checker is

- **📊 How good is each checker** (⚙️ Settings, the run window when a book is done, and the 📊 Book report) shows, for
  ChatGPT, Claude, Gemini (and the 🤖 Claude Code helpers and 🎩 Alfred when they check), how often their corrections
  held up, how many were false alarms lately, and how often they missed something another AI found — for example
  "ChatGPT: 87% of its corrections held up · 3 false alarms in the last 50". With fewer than 10 checks behind it, an AI
  says "needs more data": a few lucky or unlucky checks prove nothing. Only numbers are kept, never your book's words.
- **🏆 Who writes best** (⚙️ Settings): the editor scores every chapter, and Akọwe keeps each AI's average — for
  example "Claude: its chapters score 8.1/10 on average (12 chapters)". When you let ⚡ Make-a-book choose the AI,
  the AI whose chapters score best writes most chapters, once at least two AIs have 3 scored chapters each; every 4th
  chapter still goes to another AI so the comparison stays fair. An AI that is busy or at its limit is never chosen.
  If you pick an AI yourself in "Which AI", your choice always wins. The run window says who writes and why: "🏆 Claude
  writes most chapters: its chapters score 8.1 vs ChatGPT 7.4". Untick **Let the AI whose chapters score best write
  most chapters** to switch it off. Only numbers are kept, never your book's words.
- **🔢 Which AI checks first** (⚙️ Settings, and "Checkers: … Change" on the ⚡ Make-a-book screen for one book):
  **Automatic** puts the AI with the best track record first once there is enough data; **My own order** lets you
  move them with ↑ ↓; tick **Don't use for checks** to keep an AI from checking (it can still write). The AI that
  wrote a draft never checks it while another AI can. If you switch off so many that too few can check, Akọwe says so,
  for example "Only ChatGPT can check right now because Gemini is switched off for checks and Claude is the writer."
- **🧑‍⚖️ Stand-in when I don't answer** (⚙️ Settings, off until you switch it on): when a book waits for your answer on
  an AI disagreement — the reviewer and the writer went round in circles, or the reviewer still objects to a chapter
  after the fixes — and you don't answer within the time you picked (10, 20, 30 or 60 minutes), every working AI is
  asked the same question. **They decide only if they all agree:** with two AIs both must agree, with three all three
  must. If only one AI is working, or any AI picks the other option, is unsure or doesn't answer, the book keeps
  waiting for you. The Claude Code helper may vote for Claude when the Claude window isn't working (still one vote for
  Claude). It never decides the plot, the ending, the main character, point of view or tense, approved facts, your
  content limits or your lock list. Each decision is shown in the run window and on 🏠 Book home — "ChatGPT, Claude
  and Gemini all agreed to accept the correction to Ansel Marrant (character) at 03:12 because you didn't answer for
  20 minutes. Why: …" — and the desktop notification says it was decided for you. When they don't agree you see how
  each voted, for example "The AIs didn't all agree (ChatGPT: accept, Gemini: keep) — waiting for you." Press
  **↩ Undo** to put the other choice back for your own approval. At most 5 stand-in decisions per book run.
- **🗳 When something goes wrong, let the AIs vote instead of stopping** (⚙️ Settings › AI, in the same card; off
  until you switch it on). A book run that stops on an error and asks you to choose — an AI timed out or failed,
  Akọwe's checks refused a draft, a reviewer's OK did not count — asks the working AIs instead, **right away** or
  **after the usual wait time** (you pick). They choose between plain options: try again, let another AI do it, skip
  this step (only the optional steps that never hold up the book, like the beta reader), or wait for you — and the
  same rule holds: they decide only if they **all** agree. With it on, the review disagreements and story checks
  above are voted on too, and up to 10 decisions per run (unless you set your own number). **Claude's agents vote
  too:** pick 0–3 extra Claude Code helpers (default 1), each voting on its own with its own reviewer persona. Because
  every voter must agree, an extra helper can only stop a decision, never force one — and the helpers never count as
  one of the two AIs a decision needs. Signing in to an AI's site, "only one AI checked it", the main character, the
  plot, the ending, point of view or tense, approved facts, content limits and your lock list always wait for you.
  Each decision shows who voted, for example "🗳 ChatGPT, Claude, Gemini and 1 Claude Code helper all agreed: try
  again with another AI (the AI did not answer in time while reviewing chapter 3) … ↩ Undo". Undo gives the run its
  AI choice back or puts a skipped step back on the run's list; a "try again" that already happened can't be taken
  back, but Undo still counts the votes as overruled. The run forecast counts these votes (at most).
  It also covers the 🧭 **story checks** (continuity checkpoints) that wait for you overnight — switch off "Also the
  story checks" in the same card to keep those for yourself. For each problem the check couldn't fix, the AIs choose
  between "leave it as it is for now" (the book goes on and the problem stays in the report) and "it needs you" — or,
  when a small safe fix was offered, between "make the fix" and "leave it". The book goes on only if they all agree
  on every problem. A problem about the ending, the plot, the main character, point of view, tense, your content
  limits, a locked detail or your lock list always waits for you. ↩ Undo puts the problems back on your list (and
  takes a fix back out as a draft for you to approve).

## 6. Pictures

**In the 🎨 Images tab:**

- Choose the **Engine**: Stable Diffusion on your PC (Forge, A1111, SD.Next or ComfyUI, also through Stability
  Matrix), **ChatGPT** (it draws in its own pane), or **Auto**.
- No Stable Diffusion yet? **⚙ Start & install** finds, starts or installs one.
- Describe the picture and press **🎨 Generate**. Pictures are saved in `stuff and thing/images/`, each with a small
  file of the settings that made it.
- **🔒 Character locks** keep a character's face the same in every picture. **🧩 LoRAs** and **🧩 Add-ons** are for
  extra looks and tools.
- **🧑‍⚖️ Judge** and **🔁 Make it better** ask an AI to look at the picture. When the Claude or ChatGPT pane is the
  judge, AutoInjector puts the picture into a new chat by itself (with the **+** / attach button, or by pasting it) and
  checks it really shows there before asking. If it can't, nothing is sent and you see why. If a round of Make it
  better fails, its card shows ✖ and the reason in plain words.

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
- Hearing the replies needs nothing: it uses the voices built into Windows. For nicer voices, see **Better voices**
  below.
- What you say and what is read stay on your PC. The log notes only that something was heard, never the words.

### Better voices (free)

Open **System AI → 🔊 Voice** and scroll to **✨ Better voices**. It lists good, free voices (British and American,
men and women), each with its size:

- **▶ Sample** plays a short recording of it (about 90 KB, fetched only when you press ▶). Once a voice is downloaded,
  ▶ plays the voice itself.
- **⬇ Download** saves it into `stuff and thing/models/voice` (about 60–115 MB each, once; then it works offline).
  You see how far it is; **✕ Cancel** stops it, and pressing ⬇ again carries on where it stopped. A file you already
  have there is never replaced.
- **Use for…** picks who reads with it: Alfred, ChatGPT, Claude or Gemini. Without a choice each one gets a different
  good voice by itself (Alfred a British butler, ChatGPT Lessac, Claude Ryan, Gemini Alba) as soon as it is
  downloaded.
- These voices (Piper) run on your processor and use a little of it only while reading — your graphics card stays
  free for pictures and video. Reading needs the voice engine (Setup Wizard → 📦 Installs → "Voice engine"); without
  it the PC's own voices read.

**✨ Best quality (optional): Kokoro.** Even more natural voices. Press **Install best-quality voice (Kokoro,
~350 MB)** — it adds the Kokoro engine to the voice engine and downloads its voice file, with progress, then checks
that the voice engine finds it (if not, it says so and your other voices keep working). Then tick
**Use it**, choose where it runs — **Processor** (recommended: it leaves the graphics card free for pictures and
video) or **Graphics card** (faster, but pictures and video wait) — and a Kokoro voice for each speaker, with ▶ to try
it. Nothing needs Kokoro: if it has any problem, a Piper voice reads instead, and if that fails too, the PC's own
voices do. Untick **Use it** to go back.

Nothing in this box goes on the internet unless you press ▶ on a voice you haven't downloaded, ⬇, or Install.

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
- **Saved states:** "save this as …", "load …", "what saves do I have?", "rename …", "delete …" (see 💾 Save state
  in section 2).

## 11. 🤖 Claude Code helpers (optional — makes books faster)

Claude Code is Anthropic's command-line tool. When it is on your PC and signed in, Akọwe runs small side jobs
through it while the three web AIs do the main writing: research for the chapters ahead, fact checks with sources,
checks side by side, and the "sounds like AI" pass. It uses your own Claude plan, so it shares that plan's usage
limits with the Claude pane.

1. In Akọwe, open **⚙️ Settings → 🤖 Claude Code helpers**. If Claude Code is not installed yet, press
   **⬇ Install Claude Code**: a PowerShell window opens and runs Anthropic's official installer (the same command as
   the official page, https://code.claude.com/docs/en/setup). Close it when it says it is done.
2. Press **⌨ Open Claude Code**: a command window opens with `claude` already started. The first time, follow its
   steps to sign in with your Claude account. You can also use Claude Code yourself in that window; close it when you
   are finished. (Both buttons only work on the computer Akọwe runs on, never from a phone.)
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
- **"The picture couldn't be uploaded to the Claude (web pane)":** open that pane and check you are signed in and a
  new chat is showing, then judge again. If it keeps saying the picture "never showed as attached" although you can
  see it in the chat, untick **Web pane: check the picture shows in the chat before asking** (🎨 Images → 🧑‍⚖️ AI judge
  settings).
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
| Your 💾 saved states (one file each) | `%APPDATA%\autoinjector-desktop\saved-states\` |

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
