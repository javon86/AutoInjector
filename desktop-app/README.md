# AutoInjector Desktop

> 🚧 **Under construction — being updated.** Some sections reference the removed
> book/ATELIER machinery and predate the System AI / butler, tools, memory,
> voice, and image-generation capabilities. See
> [`../UNDER_CONSTRUCTION.md`](../UNDER_CONSTRUCTION.md) for what's parked and
> [`FEATURES.md`](FEATURES.md) / [`MERGE_ROADMAP.md`](MERGE_ROADMAP.md) for the
> current inventory. Nothing here affects how the app runs.

One program, one window: ChatGPT, Claude and Gemini as three real Chromium panes
side by side, with a control panel that lets you route messages between them —
by copy/paste-style DOM automation, no API keys, using your normal logged-in
sessions. It's built for using two (or three) AIs together as thinking partners:
you send them a problem, and route replies between them however you want —
one-off, or on autopilot.

Everything lives in one **Automation** window: the three live panes, the
control panel, the shared Transcript/Activity Log, House Rules, the Prompt
Library — all in one place, with panes and panels you don't need right now
collapsible so the ones you do care about get more screen space. A few
features (editing a Prompt Library entry, previewing a document before
sending it, building a Prompt Sequence) open their own small on-demand popup
window, but there's no separate always-open second window anymore.

By default, every reply any AI sends is read for a `[TO: X]` tag at the very
start — this is **Roundtable v2**, and unlike everything else in this app
it's not a mode you turn on: it's just how the program behaves, all the time,
for as long as it's running. See "Roundtable v2: the always-on baseline"
below for exactly how that works, and how it relates to House Rules.

This is the desktop counterpart to the `AutoInjector/extension` Chrome extension —
same automation idea (type into the chat box, click send, watch for the reply),
just packaged as a standalone app instead of a browser extension, so you don't
need Chrome open with three tabs.

## Requirements

- Node.js — the one thing you need installed. Get it free from
  [nodejs.org](https://nodejs.org/) (pick the **LTS** button), run the installer,
  click through with defaults, done. (This is what actually runs the app — there's
  no separate "AutoInjector install", it's not on an app store.)
- Windows, macOS, or Linux desktop (Electron doesn't run on Android/iOS — see the
  root `README.md` for the Android path, which reuses the browser extension in
  Kiwi Browser instead)

## Quick start (recommended — no typing commands)

1. Get the code onto your computer: on the GitHub page for this repo, click the
   green **Code** button → **Download ZIP**, then unzip it wherever you like.
   (If you already use git, `git clone` works too.)
2. Open the `desktop-app` folder.
3. Double-click:
   - **Windows** → `run-windows.bat`
   - **macOS** → `run-mac.command`
     (macOS will likely warn "unidentified developer" the first time — right-click
     the file → **Open** → **Open** to approve it once. See "macOS Gatekeeper" below
     if you still get blocked.)
   - **Linux** → open a terminal in that folder and run `./run-linux.sh`
     (or double-click it if your file manager runs `.sh` scripts)
4. First time only: a black/terminal window pops up and installs dependencies —
   this takes a minute or two and only happens once. After that it opens the app
   window automatically.
5. Every time after that, the same double-click just opens the app directly
   (a few seconds).
6. **Akọwe starts with it.** The **📖 Akọwe** tab at the top of the window shows
   Akọwe (the book workspace in `../akowe`), signed in and already connected to
   the three AIs — no second launcher, nothing to press. It needs Python 3.10+
   (see "Akọwe inside AutoInjector" below); without Python everything else still
   works and the tab says what to install.

That's the "one click" version — the launcher script handles installing and
starting for you. Nothing gets installed system-wide; it all lives inside the
`desktop-app` folder (well, inside its `node_modules` subfolder), so deleting the
folder removes it cleanly.

### macOS Gatekeeper

If double-clicking `run-mac.command` does nothing or says it's damaged/blocked,
open Terminal, `cd` into the `desktop-app` folder, and run:
```bash
xattr -d com.apple.quarantine run-mac.command
```
then double-click it again.

## Run it manually (if you prefer the terminal)

```bash
cd desktop-app
npm install
npm start
```

On first launch each pane loads its site's normal web login page — sign in to
ChatGPT, Claude and Gemini directly in their panes, the same as any browser tab.
Each site gets its own isolated, persistent session (`persist:chatgpt`,
`persist:claude`, `persist:gemini`), so you only need to sign in once; it's
remembered across restarts. Use each pane's **Reload** button in the control panel
if a pane gets stuck or you need to re-navigate.

## Using it

Each AI gets one merged column: a compact control strip on top (zoom,
status, preview, Forward/Auto/Regenerate buttons), its actual live browser
pane directly below. There's no separate "cards row" and "browser strip" —
unchecking that AI in **Participants** collapses just its pane, but its
control strip (and its last captured reply) stays visible and usable.

1. Sign in to whichever sites you want to include, right in their panes.
2. The moment each pane finishes loading for the first time, the app
   automatically sends it a short routing-explainer prompt (see "Roundtable
   v2" below) explaining the `[TO: X]` … `[FROM: X]` envelope — this happens once per
   app launch, before you do anything else, with no reply expected. It also
   lives in the **Prompt Library** (as "System Prompt (How Routing Works)")
   so you can resend it manually any time an AI seems to have forgotten it.
3. **User Panel** — one shallow, full-width strip at the top that never
   collapses (everything else in the window can shrink out of the way; this
   is the one fixed anchor). Compose is on the left; send buttons,
   participant checkboxes, and 📎 Attach/🎭 Roles/🧵 Sequence are stacked in
   one narrow middle column; a live 💬 **Messages to you** feed sits on the
   right. Spreading these sideways instead of stacking the whole thing
   vertically is what keeps it short — it costs the same modest height
   whether it's doing one job or four.
   - **Participants**: uncheck any AI to sit it out of Auto/"All" — its pane
     collapses too, since there's nothing to watch if it's not in play.
   - **Compose**: type a message and click **→ ChatGPT** / **→ Claude** /
     **→ Gemini** / **→ All** to send it to one, some, or all checked
     participants — this is also how you interject at any point, auto
     running or not. It warns you if a message is long enough that a site
     might choke on it.
   - **💬 Messages to you**: every reply an AI addresses `[TO: USER]` (or
     leaves untagged, which Roundtable v2 also treats as meant for you)
     lands here — not just mixed into the Transcript stream where it's easy
     to miss. The badge shows a running count; the feed inline shows the 3
     most recent (click one, or **see all →**, to open the full list in a
     popup). Purely a read of what the app already captures — no new setup,
     nothing to configure.
   - **🎭 Roles**: opens a popup — give each AI an optional persona (e.g.
     "Skeptical Engineer") that gets prepended to every message sent to it,
     however it's sent (Compose, Forward, Auto, a House Rules format,
     Prompt Library, a Prompt Sequence step). Pick from a preset dropdown
     (Project Manager, Detective, Research Analyst, Editor, Skeptical
     Engineer, Strategist, Devil's Advocate, Fact-Checker, Summarizer) or
     choose **Custom…** to type your own, then click **Apply** — picking a
     preset only fills the field, it doesn't send anything until you
     actually apply it. **Clear** removes it. This only shapes *what* that
     AI contributes — it has no effect on *who* it addresses, which is
     entirely up to its own `[TO: X]` tag choice.
   - **🧵 Prompt Sequence**: opens a small popup window where you build a
     numbered list of prompts, each aimed at a specific AI or **All**. Hit
     **Run Sequence** and it sends step 1, waits for that step's target to
     actually reply (for an **All** step, the *first* of the three to reply
     is enough), then sends step 2, and so on — it never fires everything at
     once. The popup's status line tracks progress ("step 2 of 4…") and the
     Run button disables itself while a sequence is active; **Close** just
     hides the window, it doesn't stop a run in progress. Each step's
     dispatch is stamped with a generation number, so a reply that's still
     in flight for a step the sequence has already advanced past (most
     easily triggered by an **All** step, where the other two replies are
     still coming after the first one advances things) gets recognized as
     stale and discarded rather than misread as satisfying whatever step
     comes next.
4. **Global** and **House Rules** sit below the User Panel, and **Prompt
   Library** below that — see the next sections for what each does. All
   three can collapse (see "Collapsing things" below) to free up room for
   the AI panes; the User Panel never does.
5. The moment a pane's reply finishes streaming (checked every ~1.5s, waits for
   the text to stop changing), a soft chime plays, its column's preview updates,
   and it's logged to the transcript. While waiting on a reply, that column shows
   a pulsing amber dot; the instant it sends something new to another AI, that
   AI's whole column glows briefly so you can actually follow who's talking to
   whom. Forwarded replies are always labeled (`[ChatGPT says] ...`).
6. **Zoom** — each column's header has **－** / **＋** buttons (and a live
   percentage) that zoom the *actual embedded page* in that pane, not just
   the app's own UI — handy for fitting more of a long conversation on
   screen at once. Ranges from 40% to 200%, independent per pane.
7. **Global controls**:
   - **Auto** — turns on full back-and-forth forwarding between every checked
     participant: whatever one says gets forwarded to the others, whose replies
     get forwarded back, and so on — this is the "three-way conversation" mode.
     With 2+ participants it will run indefinitely once started.
   - **Pause** — halts all forwarding but keeps your participant selection, so
     hitting **Auto** again picks up where you left off.
   - **Stop** — halts all forwarding *and* unchecks every participant, forcing a
     deliberate restart.
   - A column's own **Forward**/**Auto → X**/**Auto → Both**/**↻ Regenerate**
     buttons are **always visible and always clickable**, no matter what's
     going on — including while a House Rules format is actively running.
     There's no mode where they hide or get disabled; if you want to
     override or interject on top of whatever House Rules or Roundtable v2
     is doing, you always can. **Auto → Both** is a single toggle that turns
     both of that column's individual Auto routes on (or off) together,
     instead of clicking each one separately.
8. **Prompt Library**: saved, reusable prompts you can fire off with one
   click, without retyping them or going through House Rules. It's a compact
   dropdown (pick a saved prompt by name) plus **Send** / **+ New** / **Edit**
   / **Delete** — no big text boxes cluttering the main window. **+ New** and
   **Edit** open a small separate popup window with the actual editing
   surface: a name field, one text box *per AI* (ChatGPT, Claude, and Gemini
   can each get different wording — leaving a box blank skips that AI
   entirely on Send), and a **→ All** shortcut that copies one shared draft
   into all three boxes at once if you *do* want them all the same. **Save**
   there closes the popup and updates the dropdown back in the main window
   immediately. Ships with two built-ins: **System Test**, a one-click
   sanity check that tells all three AIs this is a diagnostic (not a real
   task) and asks them to confirm they received it and report whether
   messages from the other two are actually arriving; and **System Prompt
   (How Routing Works)**, the same routing-explainer text that's auto-sent
   on startup, so you can resend it any time it's useful. Saved prompts
   persist across restarts, same as the transcript and custom roles.
9. **📎 Attach Document** *(the button lives in the User Panel, next to 🎭
   Roles)*: pick a real file (image, PDF, text, or anything else) via a
   normal file picker, and preview it in its own popup window before
   deciding what to do with it. Images and text get a genuine inline
   preview; PDFs embed via Chromium's built-in viewer; anything else just
   shows the filename — you can still send it either way. For images and
   text, you can **highlight** parts of it (click-drag a rectangle on an
   image, or select text and hit **Mark Selection**) purely as a visual note
   to yourself — highlights never get sent anywhere and never touch the
   actual file, they just help you remember what you meant to mention. When
   you're ready, check off ChatGPT/Claude/Gemini (defaults to whichever are
   currently enabled) and hit **Send** — the real file lands in each
   checked AI's chat the same way it would if you'd dragged it there
   yourself, delivered underneath via the Chrome DevTools Protocol (the same
   technique browser-automation tools use for file uploads), not typed as a
   path. This is genuinely new, less-tested territory — see the note on file
   upload selectors in "How it's built" below.
10. **📌** on any transcript turn pins it, so you can spot it again later without
   scrolling back through everything.
11. **Copy Transcript** / **Download .md** save the running conversation locally
   (pinned turns are marked in the export) so you can share it elsewhere.

### Collapsing things when one screen isn't enough room

Everything that takes up screen space can be shrunk out of the way without
losing anything — nothing closes or resets, it just gets small:

- **Each AI's column** — click the **⌄** button in that column's header
  (next to 🔍 and ⟳) to collapse it down to a short bar; click it again (now
  **›**) to bring it back to full size. This is purely visual — a collapsed
  AI is still enabled, still participating in Auto/House Rules, still
  sending, receiving, and capturing replies exactly as before, it's just out
  of view. Independent per column — collapsing Claude's doesn't touch
  ChatGPT's or Gemini's. Collapsed columns move into their own always-present
  strip just above the AI panes row and share it evenly — one collapsed
  column gets the whole width, two split it in half, three in thirds —
  instead of piling up as separate rows the way a fully expanded column
  would. Whatever's still expanded stays in the main row below, full height,
  side by side. Once all three are collapsed that row is empty, so it
  collapses down to nothing and the Transcript/Activity Log panel grows to
  fill the space instead of leaving it unused.
- **Global, House Rules, and Prompt Library** — each has its own **⌄** in its
  header. Collapsing one doesn't shrink it in place; it moves entirely into a
  row of small tabs at the very top of the window (like folder tabs), and the
  space it was taking gets handed straight to the AI panes below, via the
  same flex layout that already grows the AI row when every pane's own
  Transcript space frees up. Click a tab to bring that panel back to its
  normal spot. The **User Panel** (Compose/Participants/Messages/Roles) is
  the one thing that never does this — it's the fixed anchor everything else
  collapses around.
- **The whole window** — the Automation window has its own **⌄** button in a
  thin titlebar at the very top. Clicking it shrinks the entire window down
  to just that titlebar (same screen position, just much shorter); clicking
  it again (now **›**) restores it to exactly the size and position it had
  before.
- **The Transcript/Activity Log panel** — its own header has a **⌄**
  collapse button too, independent of the AI panes: shrink it out of the way
  when you want the panes to have more room and don't need to watch the log
  right now, and bring it back the same way.

Collapsed panes are moved off-screen rather than shrunk to nothing, on
purpose: a zero-size browser view risks Chromium treating it as hidden and
throttling it, which would quietly break the very automation collapsing is
supposed to leave alone. Whether a column is collapsed individually or the
whole window is collapsed to its titlebar, every AI keeps sending and
receiving in the background exactly the same as when fully visible.

## Roundtable v2: the always-on baseline

This is the program's default, permanent behavior — not a House Rules format
you start and stop. Every reply any AI gives is wrapped in a two-tag
**envelope**: it opens with a `[TO: X]` routing tag on its own line at the very
start — `[TO: CHATGPT]`, `[TO: CLAUDE]`, `[TO: GEMINI]`, `[TO: ALL]`, `[TO:
USER]`, or `[TO: NONE]` — and closes with the sender's own `[FROM: X]` tag at the
very end — `[FROM: CHATGPT]`, `[FROM: CLAUDE]`, or `[FROM: GEMINI]`.

The **`[FROM: X]` closing tag is the completion signal**: the app captures and
routes a reply the instant that tag appears — it no longer waits for the text to
merely stop changing. If a reply ever finishes *without* the closing tag, the app
treats the message as lost, discards it, and automatically re-sends that AI the
messaging protocol asking it to resend the whole message with the envelope
(capped, so a forgetful model can't be nudged forever; a book run waiting on that
pane parks as stalled instead). The app strips **both** tags before showing the
message and routes it by the `[TO: X]` tag:

- **`[TO: CLAUDE]`/`[TO: CHATGPT]`/`[TO: GEMINI]`** — relayed to just that one
  AI. Still shown to you in the transcript, marked with a small "→ Claude"
  style badge so you know who it was for.
- **`[TO: ALL]`** — relayed to both of the other AIs. Badged "→ Everyone".
- **`[TO: USER]`** — meant for you, not another AI. Shown with no badge (this
  is the common case — badging every single message "→ You" would just be
  noise). Nothing gets relayed onward from it — and it also lands in the
  User Panel's 💬 **Messages to you** feed, so it's not something you only
  catch by happening to be watching the Transcript stream.
- **`[TO: NONE]`** — "I have nothing to add." Fully hidden — never shown,
  never relayed.
- **No `[TO: …]` routing tag at the start** — treated as `[TO: USER]` and shown
  as-is (a deliberate fallback for the *routing* tag, not a silent drop). Note
  this fallback is only for the opening routing tag; the `[FROM: …]` *closing*
  tag is still required for the message to be captured at all — a reply missing
  it is re-prompted rather than routed (see above).

This runs unconditionally, on every site, for the entire time the app is
open — there's no "start" button for it and nothing to configure. The one
thing that ever suspends it is a **House Rules format** (see below) actively
running: while one of those seven is active, it drives replies with its own
state machine instead, and a `[TO: X]`-looking line in a reply is just left
as plain text, not parsed as a tag. The moment that format is stopped,
tag-routing resumes automatically underneath — there's no separate action
needed to "turn it back on."

The app auto-sends a short prompt explaining this whole system to all three
AIs the first time each pane finishes loading after the app starts (once per
launch, no reply expected) — see step 2 under "Using it" above. That same
text lives in the Prompt Library as **"System Prompt (How Routing Works)"**
if you ever need to resend it.

**Tag routing and mesh routing (Auto/Auto-Both/manual `routing:set`) don't
double up.** Both can independently point at the same target for the same
reply — full mesh routing on, and the AI's own `[TO: X]` tag also naming a
site already covered by that mesh. If you turn a mesh direction on, tag
routing always takes priority for any target it already covers; mesh only
forwards to whatever's left. This used to genuinely duplicate deliveries (a
target getting sent to twice for one reply — once via mesh with the raw,
un-stripped tag still in the body, once via tag routing with the clean,
stripped version) until it was root-caused and fixed.

### Reliability rules (October 2026)

These came out of the 21 Oct 2026 Extract All and test report. Tracker IDs (TR-xx) match the fix-status doc.

- **A send counts only when it's proven (TR-01).** Every message starts with a unique `[MSG #n]`. The send script types through the browser's editing pipeline (paste as a fallback), and a send is *verified* only when that number appears in the chat outside the message box. A retry first checks whether the last try already landed, so a slow page never gets the same message twice. Once a pane has proven one send, an unproven "box emptied" result is treated as a failure (`SEND_UNVERIFIED`) and retried. Line breaks survive.
- **`[TO: USER]` stays with you under Auto (TR-05).** Auto routing no longer forwards a reply the AI explicitly addressed to the user. A reply with no `[TO:]` tag at all is forwarded as before. House Rules stages keep their own routing.
- **Hop limit (TR-06).** Each automatic hand-off (AI to AI, to the Butler or to the terminal) counts as a hop. After 30 in a row (`AUTOINJECTOR_MAX_AUTO_HOPS`, or the `relay:hop-limit` IPC) relaying pauses until you send something, click Auto, or press Stop AIs Talking. Program-started sends (a prompt, a sequence step, a test, the Butler) start the count over; AI-driven sends (relays, terminal results, missing-tag nudges) don't.
- **Health lights (TR-07).** The light before each AI's name is green only when its last message was delivered and the reply captured; amber while waiting or when a send couldn't be proven; red when a send failed or no reply came for 3 minutes (`AUTOINJECTOR_STALL_MS`). Hover it for the reason. A stall is logged once as `capture-stalled` with what was on the page: no reply found (selector), still "generating", or a reply missing its `[FROM:]` tag.
- **Prompt Sequence (TR-09).** The Sequence window now receives progress updates, "All" means the AIs checked Active, and a run that can't deliver a step stops at once and says why (finished / stopped / no reply in time / couldn't deliver).
- **Butler memory loop (TR-10).** A repeated identical REMEMBER/RECALL in one task is skipped and the Butler is told; the third repeat ends the task with a plain reason.
- **Wrong tags get the full rules (TR-22).** A reply missing its closing `[FROM:]` tag is discarded and the AI is asked to resend; a reply missing its opening `[TO:]` tag is delivered to the user (and forwarded by Auto if it's on) and the AI is flagged. Either way the flag carries the complete how-to-talk guide — the Prompt Library's routing prompt for that AI, including any edits you made to it. At most 2 flags in a row per AI (a correctly tagged reply resets the count); none while Stop AIs Talking is on, during House Rules stages, self-tests, the Feature Test or the relay check.
- **Re-drawn replies (TR-17).** A tagged reply must hold still briefly before it's captured; a reply the page re-draws (Gemini adds paragraph breaks and "PDF"/"+ 1" citation chips seconds later) is recognised as the same reply block and not captured or relayed again. Gemini's chip lines are stripped.
- **Build stamp (TR-19).** Extract All, Help → About and the window title name the commit and branch the app is running from.
- **Reading whole replies (TR-23).** If the reply reader reaches only part of a reply (one paragraph, or just the `[FROM: X]` line), it climbs to the element that holds the whole reply — never into the user's message or two replies, and never re-cutting at a `[TO:]` the AI merely quoted — and stops right after the closing tag.
- **Selector picks (TR-24, P38).** 🎯 → AI's reply saves the reply's container (the site's own reply selector when it recognises one), never the clicked word or paragraph. Bare tag names (`span`, `p`, `div`) are refused when picking and dropped from saved settings on start (logged as `selector-override-dropped`); per-turn test-ids are never used.
- **Busy AIs (TR-25).** A message to an AI that is still writing its last reply (its Stop button is showing) waits for it to finish — up to 5 minutes (`AUTOINJECTOR_SEND_BUSY_WAIT_MS`) — instead of failing; the wait doesn't use up retries, relays to other AIs aren't held up, and Stop AIs Talking cancels it.
- **Relay Trace (TR-13).** `relay-trace.js` follows every `[MSG #n]` through typed → proven → reply started → reply captured → handed on (or held, and why), and reports per AI where messages stop, plus duplicates, retries and timings. Passive; it sends nothing. Shown in every Extract All, in **Tools → Relay Trace report**, and over IPC (`trace:report`, `{ save }` / `{ reset }`).
- **Bucket Brigade (TR-14).** `bucket-brigade.js` — **Tools → Run relay check**. The checked AIs pass a 20-item list round with the normal `[TO:]` relay (Auto is paused during the run and restored after); items stress line breaks, accents, quotes, code, brackets, symbols, a URL and a long paragraph. Each hand-off is scored and blame is split: **app** (delivered, proven, captured, passed on exactly, no duplicates) vs **AI** (right `[TO:]`, kept every item, nothing altered). If an AI breaks the chain the app hands the correct list to the next AI and continues. About 23 messages, 10–20 minutes; the report (with the Relay Trace) opens when done.

## House Rules

Instead of manually wiring up Forward/Auto buttons, **House Rules** (in the
Global area) lets you temporarily layer a structured format on top of the
Roundtable v2 baseline above — pick one, hit **Start**, and it runs itself,
suspending tag-routing for as long as it's active. It uses whatever's typed
in **Compose** as the topic/goal. The manual Forward/Auto buttons stay
visible and clickable the whole time (see "Global controls" above) — Stop
always ends the run and hands control back to tag-routing.

- **Who Wants to Speak?** — each round, every checked AI is asked whether it
  has something worth adding (reply YES or NO). Only the ones that say yes get
  asked for their real point, which then gets recapped to everyone before the
  next round's check-in. Nobody's forced to talk every round.
- **Debate** — a fixed, randomly-shuffled speaking order. Each speaker
  responds to whoever went right before them, then hands off to the next.
  Runs for the **Rounds** you set (0 = until you hit Stop).
- **Free-for-All** — everyone's told the topic and can jump in on each other
  at any point — the open, unstructured version. Runs until you Stop it (no
  rounds limit).
- **Devil & Angel** *(needs all 3 participants checked)* — roles are
  auto-assigned, not user-picked: one AI is **Middle** (has the goal), one is
  **Devil** (attacks it), one is **Angel** (defends it). Middle's statement
  goes to both Devil and Angel; their replies both come back to Middle only —
  Devil and Angel never see each other — and Middle responds to both at once
  before the cycle repeats.
- **Chargeback** *(needs all 3 checked, and a Rounds value)* — two AIs
  (auto-assigned) argue opposite sides of the topic directly with each other;
  the third is a neutral **Referee** who watches everything live but stays
  silent until the rounds run out, then delivers a verdict naming a winner
  (marked with a 🏆 in the transcript).
- **Brainstorm** — collaborative, not adversarial: everyone builds on what's
  already been suggested. Runs like Free-for-All until you click **Wrap Up**,
  at which point one participant (auto-picked) is asked to pull everything
  into one final, fully fleshed-out plan (marked with a ✅ in the transcript).
- **Rotation** *(needs all 3 checked)* — a fixed ChatGPT → Claude → Gemini →
  ChatGPT cycle. Each AI keeps its own full history; only the newest reply
  gets relayed. Whoever's next in the cycle gets it framed as **RESPOND** and
  produces the next visible reply; the third AI (not yet its turn) gets it
  framed as **UPDATE** — told explicitly not to join in yet, just to stay
  caught up — and its one-word `"UPDATED"` acknowledgment is swallowed
  entirely, never shown anywhere. Unlike the other formats, the order is
  fixed on purpose, not shuffled.
- **Blind Round** *(needs all 3 checked)* — for a decision that actually
  matters: all three get the exact same question at the exact same time, and
  none of them can see any answer — not even a hint that the others have
  answered — until all three have independently responded. Only once the
  last one is in does each AI get shown what the *other* two said (never its
  own answer echoed back to it). This exists because three AIs agreeing
  isn't worth much if the second and third only formed their answer after
  seeing the first's — that's anchoring, not independent agreement. It's a
  one-shot technique, not an ongoing mode: it ends itself automatically the
  moment the reveal goes out.

Role assignments show up as a small badge next to that AI's name once a
format with structural roles is running (that's the auto-assigned
Devil/Angel/Referee-style role — not the same thing as the optional Role
Assignment persona feature described above, which you set yourself).

If a reply looks like a rate-limit/usage-cap message (short text matching
phrases like "usage limit" or "try again later"), it's caught **everywhere**
— not just while a House Rules format is active. The turn still shows up in
the transcript (marked ⚠ USAGE LIMIT / `isRateLimited`) so you can see what
happened, but it's never relayed onward: not to routing/Auto's targets, not
into a House Rule's state machine, not as a Prompt Sequence step's reply, not
to a waiting manager task. While a House Rules format is active, it
additionally **auto-pauses** the run (same as before) so you can Resume once
the limit clears; outside one (plain Auto-routing, Prompt Sequence, or no
routing at all), there's nothing structured to pause, so routing/mesh state
is left exactly as it was — only that one message is swallowed.

## Book Governance (ATELIER) — optional, off by default

If you're using the three panes to *build a structured book project*, you can
turn on **ATELIER governance**: each pane's reply is checked against
write-authority rules before it's routed anywhere, so an AI can't silently write
something it shouldn't (e.g. the auditor pane handing back a chapter). A reply
that fails the check is **held** — shown in the Transcript tagged `⛔ HELD`, but
not forwarded. Everything is opt-in; leave it off and the app works exactly as
before. It needs **Python 3** installed (and fails open — passing replies
through — if Python isn't found). Full details, the role→path policy, and setup
steps are in [`ATELIER_INTEGRATION.md`](ATELIER_INTEGRATION.md); the toolkit
itself lives under [`atelier/`](atelier/).

## Manager / Orchestrator (Phase 1 — backend only, no UI panel yet)

A supervisory layer on top of everything above: instead of you deciding
what to send to which AI and reading through the results yourself, a
**manager** — its own model, separate from ChatGPT/Claude/Gemini — plans a
task, delegates pieces of it to whichever of the three fit, watches what
comes back, asks for corrections or a second opinion when something looks
wrong or the AIs disagree, and saves the result to a real project folder on
disk. It's a supervisor, not a fourth worker: it only writes/researches/
analyzes itself when there's genuinely nothing to delegate.

**The one deliberate exception to "no API keys."** Everywhere else in this
app, that rule means "don't call ChatGPT/Claude/Gemini's official APIs —
drive their real web UIs instead," because that's the entire premise of the
project. The manager is a *different* model — one you run yourself, since
this app assumes you don't have local GPU hardware for it — reached via a
real HTTP API: **RunPod** (serverless or a dedicated pod you rent), **Ollama**
or **LM Studio** (if you ever do get local hardware), or any other
OpenAI-compatible chat-completions endpoint. ChatGPT/Claude/Gemini
themselves are still never touched by anything but `sendTextTo()`/
`pollSite()` — the manager delegates to them exactly the same way Forward,
Auto, House Rules, and Prompt Sequence already do.

**Current status: this is backend + IPC only.** There's no Manager panel in
`controls.html` yet — driving it today means calling the IPC handlers below
directly (e.g. from DevTools console via `window.api`). The two-column
Manager Activity Log / Communication panel, the full automatic 0-4 tier
ladder, RunPod pod idle-shutdown automation, and desktop notifications are
all deferred to a later phase, once this core loop has been used for real.
None of it has been run against an actual RunPod/Ollama/LM Studio backend
from this dev environment either — same caveat as every DOM selector in
this app, the shapes are carefully matched to each provider's documented
API, but real verification needs your actual account/instance.

### Configuring it

`window.api.configureManagerProvider({ provider, endpoint, apiKey, model, tier, timeoutMs, podId, approvalMode, maximumTurns, costLimit, adjudicatorSite })`
— `provider` is one of `"runpod-serverless"`, `"runpod-pod"`, or
`"openai-compatible"` (this last one also covers Ollama/LM Studio, since
both already speak the OpenAI chat-completions shape natively). `endpoint`
is the **full URL** to POST to — this app never guesses or constructs a
RunPod endpoint id into a URL itself, since that composition is
worker-template-specific and is your deployment's call, not this app's.
`window.api.testManagerConnection()` sends a trivial request and reports
whether the endpoint is reachable at all, independent of whether the model
actually followed the JSON-only format.

### Running a task

- `window.api.startManagedTask(userRequest)` — starts a new task (rejected
  with `NOT_CONFIGURED` if no endpoint/model is set, `NEEDS_REQUEST` if the
  request is blank, `ALREADY_RUNNING` if one's already in progress). Creates
  a real folder under your **Documents/AutoInjector Projects/** for this
  task (`project.json` checkpoint, `manager-log.jsonl`, `raw-responses/`,
  `working/`, `sources/`, `versions/`, `final/`) — every response any AI
  gives is preserved raw in `raw-responses/` regardless of what the manager
  later does with it, kept separate from whatever ends up in `final/`.
- `window.api.pauseManagedTask()` / `resumeManagedTask()` / `stopManagedTask()`
  — pausing holds the loop exactly where it is (mid-wait-for-a-reply or
  between turns); resuming picks back up from there, not from the start.
- **Approval mode** (`approvalMode: true`) holds every proposed action
  (except one the manager itself flagged `REQUEST_APPROVAL` for, which is
  always held) for a real decision before it does anything — critically,
  *nothing is sent to any AI pane until approved*, not just hidden from
  view. `window.api.approveManagerAction()` / `rejectManagerAction(reason)`.
- `window.api.getManagerState()` (or the `manager`/`managerConfig`/
  `managerLog` fields already included in the regular `getState()`) reads
  current status, plan, assignments, responses, tier, and any pending
  approval. `onManagerState`/`onManagerLog` subscribe to live updates.

### What the manager can actually do

A fixed action vocabulary — `CLASSIFY, PLAN, DELEGATE, SEND, FORWARD,
COMPARE, CRITIQUE, VERIFY, EXTRACT, ASSEMBLE, REVISE, VALIDATE, SAVE,
EXPORT, ESCALATE, WAIT, FINISH, PAUSE, REQUEST_APPROVAL` — nothing else.
Every decision is validated twice before anything executes: once by
`manager-provider.js` (is this valid JSON with a real action name), then
again by `main.js` (are the targets actually chatgpt/claude/gemini, is a
`SAVE`/`EXPORT` path actually a safe relative path inside this task's own
project folder — no `..`, no absolute paths, ever — does any field contain
something that looks like an attempt at code injection or credential
exposure). A decision that fails either check is logged with the specific
reason and never executed; repeated failures escalate the tier rather than
retrying the same broken thing forever, and a `maximumTurns` cap (default
20) or `costLimit` ends the task outright if it truly can't make progress.

### Tiers, simplified for this phase

The full spec's automatic 0-4 ladder (routing cheaper/more-expensive
provider configs to different situations) is deferred — Phase 1 has one
configurable tier (`managerConfig.tier`, default 2) that escalates by
exactly one step on a provider failure or a repeatedly invalid decision,
and an explicit `ESCALATE` action can jump straight to a requested tier.
**Tier 4 is special even in this phase**: instead of calling the configured
RunPod/Ollama/LM Studio endpoint, it routes the specific question straight
to a real ChatGPT/Claude/Gemini pane (`adjudicatorSite`, default Claude) —
matching the spec's "cloud adjudication" — and steps back down toward the
configured baseline tier automatically once a response lands and the task
is making progress again.

## 🎨 Images — Stable Diffusion (checkpoints, LoRAs, character locks)

The **🎨 Images** tab (next to 🤖 AutoInjector and 📖 Akọwe in the title bar) makes pictures with
Stable Diffusion on your own PC. Plain-English setup for Windows (Stability Matrix, the one-click
ComfyUI install, or a standalone Forge/A1111/ComfyUI): **[docs/STABLE_DIFFUSION_SETUP.md](../docs/STABLE_DIFFUSION_SETUP.md)**.

- **Connect:** 🔍 *Find my SD app* checks localhost (Forge/A1111/reForge/SD.Next on 7860–7865,
  ComfyUI on 8188/8000) and says which app answers — "✔ Connected to Forge on :7860 — model X" — or,
  for a WebUI started without `--api`, exactly what to tick in Stability Matrix / put in
  `webui-user.bat`. Or type an address and press *Connect*. *🧪 Test* makes one 512×512 picture.
- **Start / install:** *⚙ Start & install* starts a Stability Matrix package (Forge, reForge, A1111,
  SD.Next, ComfyUI) hidden with the API on, restarts it after a crash and stops it on quit
  ("✔ ComfyUI running on :8188 (managed)"; log without secrets; "Start Stable Diffusion with
  AutoInjector" is off by default) — or *⬇ Install Stable Diffusion* downloads the official ComfyUI
  portable (GPU + disk-space check, resumable, verified) and a starter model.
- **🖌 Generate:** prompt, negative, character lock, LoRA chips with weights (`<lora:name:w>` for the
  WebUIs, LoRA loader nodes for ComfyUI; trigger words added for you), checkpoint, VAE, sampler,
  scheduler, size, steps, CFG, seed, batch; progress + Stop; pictures saved in `stuff and thing/images/`
  with their settings inside the PNG and in a `.json` next to it — *♻ Remake* / *🎲 Variation*.
- **📚 Library:** checkpoints / LoRAs / embeddings / VAEs from Stability Matrix's `Data/Models`, the
  SD app's own lists and folders you add; base model + trigger words from the safetensors header and
  Civitai/Stability Matrix info files (only the header is read; model files are never changed);
  preview pictures; your tags, collections, ★, default weight, notes; red/yellow warning when a LoRA
  doesn't fit the checkpoint. Stored in `<settings folder>/sd-library.json`.
- **🔒 Character locks:** LoRA + trigger words + fixed looks for one book character (same face every
  time). Akọwe can ask for a portrait/cover with one: `POST /image/request` on the service bridge
  ([docs/SD_IMAGE_API.md](../docs/SD_IMAGE_API.md)).
- Code: `sd-backends.js`, `image-provider.js`, `sd-library.js`, `sd-images.js`, `sd-studio.js`,
  `sd-runner.js`, `sd-installer.js`, `sd-api.js` (module API for Alfred), `images-studio.js`; design
  and limits in [STABLE_DIFFUSION_PLAN.md](STABLE_DIFFUSION_PLAN.md). Tests: `test/sd-*.test.js`,
  `test/images-tab.test.js`, `test/e2e/sd-images.e2e.js` (fake servers, nothing real downloaded).

## Akọwe inside AutoInjector (one app, one launcher)

Starting AutoInjector also starts Akọwe (`akowe-server.js`, setting **Start with
AutoInjector** in the 📖 Akọwe tab, on by default):

- **Reuse first** — if an Akọwe already answers on 127.0.0.1:8780–8799 (you
  started `akowe/run-akowe.bat` yourself), AutoInjector uses that one and never
  starts a second. Its access token is read from Akọwe's data folder and only used
  when the ping proof (HMAC) says it belongs to that server. A hand-started Akọwe
  is left running when AutoInjector quits; if it goes away, AutoInjector starts its own.
- **Python** — `AUTOINJECTOR_AKOWE_PYTHON` if set; else the private environment
  the launcher makes (Windows `%LOCALAPPDATA%\Akowe\venv`, elsewhere
  `~/.local/share/akowe/venv`); if missing it is made the same way
  `run-akowe.bat` does (`py -3` / `python` / `python3`, 3.10+, `-m venv`), and
  `requirements.txt` is installed once (only when `jsonschema` is missing; needs
  the internet once). The old `Bookforge` folder is moved over first, like the launcher.
- **Start** — `python -m akowe --no-browser --host 127.0.0.1 --port <free port>`
  from `../akowe` (port 8780, or the next free one), hidden, then a wait for
  `GET /api/ping` (60 s, `AUTOINJECTOR_AKOWE_HEALTH_MS`). The start link
  (`/#token=…`) is read from Akọwe's own "Open:" line and only ever given to the
  Akọwe view — never logged (the server log hides it).
- **Keep alive** — a crash restarts it after 2 s, 5 s, 15 s, 30 s; after 5 crashes
  in a row it stops and the tab shows **↻ Try again** / **📄 Open log**
  (`<stuff and thing>/logs/akowe-server.log`). Two minutes up resets the count.
- **Quit** — AutoInjector stops its own Akọwe cleanly (Ctrl+C, a hard stop after 4 s).
- **Problems** — no Python → "Akọwe needs Python 3.10 or newer" with **⬇ Get
  Python** (python.org) and **↻ Try again**; port busy → the next free port; no
  answer in time → **↻ Try again** + **📄 Open log**. AutoInjector's own start
  never waits for Akọwe.
- **The 📖 Akọwe tab** — a native view (like the AI panes) loaded from the start
  link, so it is signed in. It can only show pages of that local server: any
  other link opens in your browser. **⇱ Pop out** moves it to its own window
  (closing that window, or **⇲ Bring back**, returns it), **↻ Reload** loads the
  start page again. "📚 Open Akọwe" / "✅ Review & approve" in the panel open the
  page in this tab.
- **Connected by itself** — when the server is up, AutoInjector turns the bridge
  on and pairs Akọwe directly (`POST /api/slots/pair-autoinjector` with a
  one-time code; same as Connect, without the browser). It does not switch Akọwe's
  AI slots if you gave them something else (an API key) — **🔗 Connect Akọwe**
  still does it on request. Turning the **Bridge** switch off also stops the
  automatic connect. Connect keeps its browser flow for a hand-started Akọwe
  AutoInjector can't sign in to.
- Logged with tags (System): `akowe-server-start / ready / reuse / crash /
  restart / stop / failed / health-timeout`, `akowe-autopair`, `akowe-view-*` —
  ports, exit codes and versions only. `AUTOINJECTOR_AKOWE_SERVER=0` turns the
  whole thing off (the test harnesses do).

`akowe/run-akowe.bat` / `run-akowe.sh` still work for running Akọwe alone (optional).

## Akọwe (experimental, bridge off by default)

Lets Akọwe (the book-writing tool in this repo) use the ChatGPT, Claude and
Gemini panes as its AI slots, with no API keys. **Caution:** automating these
sites' web UIs may be against their terms of service — use at your own risk.
The contract is `docs/AKOWE_AUTOINJECTOR_BRIDGE.md` (contract v1.2, normative).

**The Akọwe panel** is compact (about a quarter of its old height when
connected) and every ⓘ explains its part in plain words (Esc or a click outside closes it):

- **Header (one line)** — a **health dot** (green = all good, amber = not connected
  yet / waiting, ⚠️ = something needs fixing, grey = bridge off; computed from: bridge
  listening, key present, Akọwe reachable (pinged at most every 30 s), status
  freshness and each Active AI window; click it for the checklist), the **state pill**
  (Off / Starting / Not connected / Connecting / Connected / Working — animated
  purple-blue — / Problem), a one-line summary, **🔗 Connect Akọwe**, the
  **Bridge** switch, **📋 Copy diagnostics** and **▾/▸**.
  - **🔗 Connect Akọwe** — one click: turns the bridge on if it's off,
    checks Akọwe is running (`GET http://127.0.0.1:8780/api/ping`; port from
    `AKOWE_PORT`, or Akọwe's own fallback ports 8781–8799), makes a
    one-time **pairing code** (12 characters, 2 minutes, single use) and opens
    your browser at `http://127.0.0.1:<port>/#/pair?code=<CODE>&bridge=<bridge url>`.
    Akọwe trades the code for the connection key itself (`POST /v1/pair`),
    so **the key never goes into a URL** and you copy nothing. If Akọwe isn't
    running, **▶ Start Akọwe for me** runs `../akowe/run-akowe.bat`
    (`.sh` elsewhere) detached, waits up to 90 s (`AUTOINJECTOR_BF_START_WAIT_MS`)
    and then connects by itself.
  - **Bridge** switch (off = nothing listens; on = `127.0.0.1:17891` only,
    `AUTOINJECTOR_AKOWE_PORT` overrides; remembered).
  - **▾ / ▸** (or click the title) folds the panel into a **slim status bar**: state
    pill · current step · ✅ approvals count · ⚠️ problem count (click = expand and
    show the first problem) · 📚 Open Akọwe. The choice is remembered.
- **Status line** — what Connect is doing and the **Next** step.
- **Your AIs** — ChatGPT / Claude / Gemini side by side (each in its app colour):
  Ready / Not loaded / Busy / Not active, plus the last result.
- **Connection check** — one row of chips (bridge · key · Akọwe running ·
  connected · each AI window · each AI answers through the bridge) with ✔ / … / ○ /
  ✕. **Details ▸** opens the full list (it opens by itself when something fails).
  **🧪 Test the connection** runs the real link test (below) and ticks the same
  chips/rows; **📄 Last report**.
- **Now working on** | **Book checklist**, side by side — the current step
  ("Set B · B03 Main plot"), its state, Akọwe's message, a running clock,
  **N need your OK** with **✅ Review & approve** and **▶ Go to current task**; the
  book's "k/n" bar and a stepper of chips with **module-set letter badges** (A–K,
  one fixed colour each — the palette is documented in `BF_SET_COLORS` in
  `controls.js` so Akọwe can match it), **List ▸** for every part by name,
  **📚 Open Akọwe**. A status older than 90 s gets a ⚠️ "last update X min ago".
- **Footer (folded)** — Activity log, Other ways to connect (📋 Copy connection
  key / Show key / Make a new key), the terms-of-service and routing cautions.

**Problems are shown where they are**: a yellow ⚠️ marker (red ring when it
blocks) sits on the exact element — the Bridge switch, an AI, a check chip, the
"Connected" chip, the stale status note, a failed link-test row, the Connect
button for a failed Connect step, or any button whose action failed. Clicking it
opens **Where / What happened / How to fix** (the technical code folded away) and,
where possible, **🔁 Try again** (restart the bridge, connect again, run the test
again, reload that AI's window, open/start Akọwe). All bridge, pairing,
request-outcome, start-error, Connect and link-test codes map to plain words in one
table (`BF_CODES` in `controls.js`). Every IPC call is wrapped (a failure becomes a
⚠️, never silence) and a window error handler turns a panel bug into a ⚠️ instead of
a broken panel. **📋 Copy diagnostics** (`akowe:copy-diagnostics`) copies a safe
summary — app version, bridge on/port, key present (yes/no only), Akọwe reachable,
connection/Connect phase, health, each AI's readiness and last outcome code,
counters, the last link-test counts and failed step ids, recent problem codes —
**never** the key, pairing codes, prompts, replies or book content; without a
clipboard it shows the text to copy by hand.

The **Activity log** (text-free: who connected, which AI was asked, how long it
took, refused keys/codes) is kept, folded away at the bottom. Only loopback
`http://127.0.0.1` / `http://localhost` pages are ever opened from the panel.

- The key lives in the app's userData folder (`akowe-bridge-token`, mode
  0600), never in the state file, logs, reports or URLs. Pairing codes are never
  logged either — only the outcome of each pairing attempt.
- **🧪 Test the connection** (`akowe-link-test.js`): bridge listening, key file
  present, a wrong key refused (401) and the right one accepted (`/v1/health`),
  then for each Active AI: window ready + a real `POST /v1/complete` round trip
  (request_id `selftest-<stamp>-<site>`, a tiny JSON_SCHEMA prompt whose JSON reply
  must echo a random word), "is Akọwe running?" and "is Akọwe connected?"
  (both SKIPPED with instructions when not). PASS / FAIL / SKIPPED with timing and
  a how-to-fix tip; Stop works mid-run. Reports: `akowe-link-test-<stamp>.md`
  and `.json` in the logs folder (never the key or the prompt; the last 80
  characters of each reply). Reply time limit per AI: 3 min (`AUTOINJECTOR_BF_LINKTEST_MS`).
- Endpoints: `GET /v1/health`, `POST /v1/complete` (`site`, `prompt`, `request_id`,
  `timeout_ms`; one request per pane at a time, 409 otherwise; a repeated
  `request_id` within 15 minutes returns the same result), and in v1.1
  `POST /v1/pair` (no key; code -> key) and `POST /v1/status` (Akọwe's progress,
  sanitized: whitelisted fields, capped strings/lists, loopback URLs only, < 32 KiB).
- A reply to a bridge request is shown in the Conversation panel but is
  **not** relayed to the other AIs (no mesh routing, roundtable, House Rules,
  Prompt Sequence or Manager handling).
- Code: `akowe-bridge.js` (pure Node; also `createPairingCode()`, the latest
  Akọwe status and a text-free event ring in `status()`), `akowe-link-test.js`
  (link-test orchestration + report), main.js IPC `akowe:*` (incl. `connect`,
  `start-app`, `open-url`, `diagnostics`, `copy-diagnostics`; the status snapshot
  carries `health`). Tests: `test/akowe-bridge.test.js`,
  `test/akowe-main.test.js` (Connect flow with a mocked `shell.openExternal`),
  `test/akowe-diagnostics.test.js` (health + diagnostics; a planted key, the
  pairing code, prompt, reply and book content must never appear),
  `test/akowe-link-test.test.js`. `test/fixtures/fake-bridge-host.js` runs the
  real bridge with fake panes for cross-process tests (see its header for the CLI,
  incl. `--pairing-code-file` and `--status-file`).

### AIs that repair themselves (check-ins, self-repair, 🎯 picker, 🔢 number teach)

AutoInjector checks that each Active AI still answers by sending it a tiny **check-in**
(“Reply with only this word: marigold”): once when its page has loaded, every 20 minutes
while it is idle (Akọwe panel → 🤖 Your AIs → *Check-ins*: off / 10 / 20 / 30 / 60 min),
when you press **🩺 Check now**, and when Akọwe asks before a book. Never while you are
typing in that AI or it is busy. Check-ins and their answers are not shown in the
conversation and never passed on to the other AIs.

When a check-in fails, the AI's card says **🔧 Repairing…** and AutoInjector works out why
(can't type / message not sent / can't find replies / reply taken as old / stuck writing /
logged out / “are you human?” check / usage limit / page error) and fixes what it can by
itself: other known ways to find the message box, Send button and replies; searching the
page for the check-in word to learn where replies appear; reloading the window; pressing
Stop on a stuck AI. If that doesn't work the AI shows **✕ Not working** and AutoInjector tells
you **once**, noticeably (its card flashes, the ⚠️ pop-over offers **🎯 Point at it** and **🔢 Do it
for me with a number**, and a short sound plays if you tick **🔔 sound** next to *Check-ins*). It
never starts the teach step by itself and doesn't nag: it re-checks that AI with a plain check-in
after 5, then 15, then every 60 minutes until you act (🎯 Save, 🔢, 🩺 Check now, reload) or a
normal reply shows it works again. **✔ Fixed** when it works again. Logged out, captcha and usage
limits show **⚠️ Needs you** with exactly what to do; it notices by itself when you've done it.
Click any ⚠️ to see what was already tried. Check-in answers (and number-teach answers) are never
relayed and never get a “you forgot your [TO:] tag” reminder, even when they come late.
What it learned is saved per AI (`learnedSelectors` in the state file). Anything it learns is
made **general** (it must match every reply of that kind, not one message: per-message numbers,
ids and `data-…-key` values such as `fallback-turn-7:2:assistant` are stripped — that one becomes
`[data-content-search-unit-key$=":assistant"]` — and when two or more replies are on the page the
selector must match at least two of them). The reader always takes the **whole** reply: if the
node it lands on is only the envelope start (`[TO:`) or much shorter than the AI message it
belongs to, it reads that whole message instead.

#### 🔢 Number teach (“Do it for me with a number”)

From an AI's 🎯 card or its ⚠️ pop-over. A box in the Akọwe panel (and a banner in the AI's
window) says *Type 4827 into ChatGPT's message box and press Send* (a random 4-digit number).
While you do, AutoInjector watches the page: where the digits appear while typing is the message
box, what empties the box is the Send button (or Enter), and the digits in a new block are your
message. Then **AutoInjector itself** sends that AI *“Write the number 4827 backwards, digits
only.”* (with the usual reply envelope; never relayed, never nagged) and learns the reply area from
where **7284** appears in a new block that is neither your message nor the box. All three are saved
like a 🎯 Save, a check-in confirms them, and the box says **✔ Saved — ChatGPT is working again.**
If a part fails it says which one (message box / Send button / reply area), keeps what worked and
offers 🎯 for just that part. Cancel any time; it gives up after 4 minutes with a friendly note and
never starts again by itself.
A saved 🎯 / 🔢 selector wins over one learned before it; one the self-repair learns later (because
the saved one stopped matching) wins over it. Everything it does is in the activity log and 📋 Copy diagnostics (codes
only, never message text). Set `AUTOINJECTOR_CHECKIN=0` to switch the automatic check-ins
off. Details: `docs/AKOWE_AUTOINJECTOR_BRIDGE.md` (contract v1.2) and `self-repair.js`.
Real ChatGPT/Claude/Gemini pages couldn't be tested here — only realistic fake pages.

## Picking up where you left off

Your transcript, any custom Role Assignments, and an in-progress House Rules
run (if one was going) are saved to disk automatically as you go, and
restored the next time you open the app. A restored run always comes back
**paused**, never active — the app will never auto-send anything just because
you relaunched it; you decide when to hit Resume. This is separate from
signing in — each site's own login session is already remembered by the
browser pane itself (see above), independent of this.

Each save writes to a temporary file next to the real one, then renames it
into place — so a crash or power loss mid-write can't leave you with a
corrupted, unreadable state file; the real file only ever gets updated as a
complete write. The transcript itself is capped at the 1,000 most recent
turns (oldest dropped first, on both save and load) so a long-running relay
session can't grow it — or the file it's saved into — without bound.

The saved file lives at:
- **Windows**: `%APPDATA%\autoinjector-desktop\autoinjector-state.json`
- **macOS**: `~/Library/Application Support/autoinjector-desktop/autoinjector-state.json`
- **Linux**: `~/.config/autoinjector-desktop/autoinjector-state.json`

Delete that file (app closed) if you ever want a completely clean slate.

## Troubleshooting

The **Activity / Troubleshooting** panel next to the transcript logs every
internal action live — polls that captured a new reply, sends, forwards, errors,
routing/participant changes — each with a timestamp, so if something isn't
working you can see exactly where it's getting stuck instead of guessing.
Picking a selector and running the connectivity Test both log in detail, not
just "started"/"done": a pick logs which role was requested, and on success
the exact selector it landed on plus a sample of the text/element it actually
captured; a Test run logs the token it sent, when it started waiting on a
reply, and on failure exactly what went wrong — including, for a mismatch,
what text it *did* capture instead of the token, which is usually the
fastest way to tell whether a selector is finding nothing at all versus
finding the wrong element.

That panel only shows the current session, though — if the app crashes or you
close it before catching the problem, that log is gone. A rolling copy is
also written to disk (capped at ~2000 lines) right next to the state file
above, as `autoinjector-debug.log`. If something breaks and you want help
tracking it down, that file plus a description of what you were doing is the
most useful thing you can send.

If a specific AI's card never shows a captured reply even though its pane
clearly has one on screen, or messages seem to stop going out entirely, that
means the DOM selector for reading (or typing into/sending) that site
(`selectors.js`) doesn't match its current layout anymore — sites change
their markup without notice, and this app has no way to detect *why*
something isn't matching, only that it isn't. A send that doesn't actually
go through gets reported distinctly, as `SEND_NOT_CONFIRMED` in the Activity
Log, rather than silently pretending to succeed — `automation.js` checks
that clicking Send (or pressing Enter) actually cleared the input box (now
polled over ~2.5s rather than a single fixed 500ms snapshot, so a
genuinely-slow-but-real send has room to confirm instead of being falsely
flagged), which every real chat UI does the instant a message is genuinely
submitted, instead of just trusting that the click didn't throw an error.
`SEND_NOT_CONFIRMED` used to spike hard under mesh routing (a real session's
Activity Log showed roughly a 50% failure rate) — the actual cause was two
different sites capturing a reply in the same ~1.5s poll cycle and both
routing to the same third target, firing two send scripts against that
target's pane at once and stomping on each other's typing. Every send now
goes through a per-target queue (`sendQueues`/`withSendQueue()` in
`main.js`) so only one send script ever runs against a given pane at a
time; a second concurrent call for the same target simply waits its turn
instead of colliding with the first. The common case (nothing else already
sending to that target) still calls straight through with zero added
overhead — only genuinely concurrent sends to the same site pay for
serialization.

On top of that, `sendTextTo()` retries a failed send automatically, up to 3
total attempts, with a 1.5s backoff between them, before ever reporting it
as a failure. This is aimed specifically at a pattern seen in real runs: a
pane that's cold or still settling (just loaded, just finished a previous
reply) fails the confirmation check on the very first attempt, then sends
cleanly on an immediate retry — a real, transient failure, not a broken
selector or a dead connection, and previously indistinguishable from one in
the Activity Log. Every retried attempt is logged individually as
`send-retry` (with its own attempt number and error), and the eventual
outcome — `sent` or `send-error` — carries the real `attempts` count and,
on success, a `selfRecovered: true` flag whenever it took more than one try,
so a clean first-try send is never conflated with one that only worked
because of the retry. The delivery ledger records the same `attempts` count
on every entry, successful or not. Only a send that fails all 3 attempts is
ever reported as `SEND_NOT_CONFIRMED` — at that point it's a real failure,
not a timing fluke, and retrying further wouldn't change that.

### ⤓ Extract: sharing a log without your other conversations (P16)

**⤓ Extract All** (Activity / Troubleshooting) no longer dumps the app's whole
history in one click. It opens a small dialog that asks what goes into the file:

- **📖 This Akọwe book only** — the default when Akọwe has sent this app
  requests for a book (Akọwe connected, or the book was active in the last
  24 hours). Only the AIs' replies to Akọwe's requests *for that book*, the
  activity events of those requests (by `request_id` / `[MSG #]`), Akọwe bridge
  events inside the book's run windows, and the Relay Trace for just those
  messages. Your own conversations with the AIs — even ones during the run — and
  other books are left out. A picker lists every recorded book.
- **🕒 Time range** — last hour, today, last 24 hours (the default when no book is
  known), or a custom from/to.
- **🗂 Everything** — warns that it *includes all conversations, including older
  private ones*. Never the default.

Tick boxes choose the sections (AI conversation text, activity log, relay
trace — all on by default). Before anything is written the dialog shows the
counts and the first lines of the file; **Save** writes it, **Cancel** writes
nothing. The file starts with a **WHAT IS IN THIS FILE** header (scope, book and
project id, time range / run windows, request count, how many messages, events
and traced messages) and is named after its scope, e.g.
`The Lighthouse Keeper - AutoInjector log - 2026-10-24_11-30-00.txt` or
`AutoInjector log - last 24 h - ….txt`.

Every scope is **redacted**: the Akọwe connection key, the service-bridge
token, pairing codes made this session and any key/token/password in the app's
settings are removed by value; API-key shapes (`sk-…`, `AIza…`, `ghp_…`, `xoxb-…`,
`hf_…`, `AKIA…`), `Bearer …` values, `?code=`/`?token=`/`?key=` URL values and long
hex/base64 strings right after a key/token/secret/password word are removed by
pattern; your home folder is shown as `~`, the app's own folders stay
(`~/…/AutoInjector/…`), and any other path under a home folder becomes
`[private path]`. Ordinary prose, ids and numbers are left alone.

How a reply is tied to a book: when Akọwe pushes `/v1/status` with
`project {id, title}`, the app records every bridge `request_id` that starts while
that project is current (and its `[MSG #]` numbers); a captured reply the bridge
owns is tagged with its request and project. That mapping (ids, sites and times
only — no prompt or reply text) is kept in memory and in
`akowe-extract-books.json` next to the app state, so it survives a restart.
Replies captured before this version have no tag, so they appear only in a time
range / Everything extract.

Code: `log-extract.js` (book tracker, scope selection, header, file name,
redaction; pure Node), `relay-trace.js` `report({ seqs, from, to })`, main.js IPC
`logs:extract-options`, `logs:extract-preview`, `logs:extract-all` (opts
`{ scope, bookId, preset, from, to, include }`; no opts = the safe default).
Tests: `test/log-extract.test.js` (scopes, header, file names, planted secrets and
paths), `test/log-extract-main.test.js` (the real main.js: a private conversation
weeks earlier, an unrelated chat and a second book are kept out of a book
extract), `test/controls.test.js` (the dialog), and the e2e smoke test (opens the
dialog, cancels, then saves the default).

### The delivery ledger: the program's own record of what actually happened

Every send the app ever makes — Compose, Forward, a House Rules dispatch, a
tag-routed relay, a Prompt Sequence step, a manager delegation, all of it —
gets its own entry in a delivery ledger, recorded from one place
(`recordLedgerEntry()`, called from inside `sendTextTo()` itself) so nothing
needs separate bookkeeping to stay covered. Each entry carries a
program-assigned id (`MSG-<n>`), the real source site (or `null` for
something you sent directly), the target, a preview of what was actually
sent, whether it was confirmed delivered or failed (and the specific error
if it failed), and whether it looks like a duplicate of something sent to
the same target within the last 5 seconds. This is deliberately the
program's own record, not any AI's — an AI's own reasoning about whether its
message "got through" is never trustworthy on its own, since it has no real
visibility into browser automation succeeding or failing. The ledger is
available via `state:get` (`ledger`) and broadcasts a `ledger-entry` event
live as each one is recorded, ready for a future UI panel; this pass is
data-only, on purpose — nothing in this app currently injects delivery
status back into what gets sent to an AI, since that's a real behavior
change worth deciding deliberately rather than bundling in silently.

### 🧪 Checking whether it's actually working: the connectivity test

Every AI column has a **🧪 Test** button (inside the 🎯 menu described
below). Click it and the app sends that site a real prompt containing a
fresh, one-off token — but instead of asking for that token back verbatim,
it asks the AI to reply with the token **reversed**. That's deliberate: a
too-broad reply selector that's actually reading the sent prompt back (not
a real reply) would trivially "pass" a plain echo test, since the token is
right there in the outgoing message. Asking for a transformed version and
checking for it — while confirming the *original*, untransformed token is
**absent** — closes that hole. A small dot next to the AI's name turns
**amber** while it's running, **green** the moment a reply containing the
reversed token (and not the original) lands, or **red** with one of four
distinct failure reasons spelled out inline:
- **too broad** — both the original and reversed token came back (almost
  always means the selector is reading the whole thread, prompt included,
  not just the actual reply)
- **echo** — only the original token came back (the selector is very likely
  reading the outgoing message, not any reply at all)
- **mismatch** — something came back, but it matches neither form (reading
  is probably picking up the wrong element entirely)
- **timeout** — nothing came back within 45 seconds

This is the fast way to answer "is this AI actually hooked up right now"
without having to read anything yourself or guess from the Activity Log —
and, unlike a plain token echo, it can't be fooled by a selector that's
merely reading something back.

### 🎛️ The Tuner: testing the whole relay, not just one AI at a time

The 🧪 Test button proves "can I reach this one AI" — it says nothing about
whether a message actually gets from one AI to another. **Run Tuner**
(Global panel) answers that: it runs the connectivity test on all three
sites, then genuinely tests all **6 directed pairs**
(chatgpt→claude, claude→chatgpt, chatgpt→gemini, gemini→chatgpt,
claude→gemini, gemini→claude) — not just whichever routing you currently
have turned on. It takes a few minutes; the Global panel shows live
progress, and every individual check lands in the Activity Log in detail
(`tuner-leg-started`/`-ok`/`-error`), with a one-line pass/fail summary at
the end.

Proving delivery is harder than it sounds: `pollSite()` only ever reads
what an AI's own reply *says*, never what it *received* — there's no way to
directly observe "did B get A's message" without B producing some checkable
reply. Asking a model to relay text literally, without answering it, is
fragile in practice — models tend to answer what's in front of them rather
than pass it through inertly, so a naive version of this test would be
testing "did the AI follow a weird meta-instruction," not "does the relay
work."

The trick that avoids that: each leg asks **one question that works for
both hops**. Source, addressed directly, is asked to reply with `RELAY-TEST
<token>` plus one trailing conditional line: *"if you're seeing this
because it was forwarded to you by another AI, instead reply with
RELAY-RECEIVED `<token>`."* The leg temporarily turns on mesh routing for
just that pair (restored afterward — never touches routing you've set up
yourself), which forwards source's entire reply, conditional instruction
included, to target — now wrapped in the usual "[Source says] ..." framing.
Target, seeing itself addressed via a forward rather than directly, follows
the *else* branch and replies `RELAY-RECEIVED <token>` instead. Neither AI
is ever asked to suppress its own reasoning and blindly forward something —
both just answer the message actually in front of them, and which branch
fires tells you, unambiguously, whether the message actually arrived.

A failed leg is reported with the exact stage it failed at: `source-send`
(couldn't even send to the source), `source-reply` (source never answered
its own half correctly — that's the same class of problem the 🧪 Test
button would catch), `forward-send` (source answered fine, but the internal
mesh forward to target itself never went through — a real send failure on
the relay hop, e.g. `SEND_NOT_CONFIRMED`, nothing to do with target at all),
or `relay` (the forward genuinely sent, but target never replied as
expected — this is the one that actually points at target's own
reply-reading, not the relay path). The `forward-send` check works by
watching the delivery ledger itself (`waitForLedgerEntry()`) for the
program's own record of that internal forward, rather than inferring
anything from target's silence — a leg that times out waiting on target
used to get reported as an undifferentiated `relay` failure even when the
real cause was the forward never sending in the first place; now that's
caught and reported as `forward-send` directly, distinct from target simply
never answering. That's the "what do we need to fix to get to 100%"
breakdown — a broken relay leg looks different from a broken individual
connection, and a forward that never sent looks different from a target
that never answered, so now you can tell exactly which one you're looking
at.

### 🎯 Fixing it yourself: point at it

Click **🎯** on an AI's pane (or **🎯 Point at it** in the Akọwe panel's ⚠️ pop-over) and a
small card opens: **What do you want to point at?** — **Message box** (where you type), **Send
button**, or **AI's reply** (pick the latest answer). Choose ONE and press **OK — point at it**.
The AI's window shows a banner *“Click the … in this window”*; hovering outlines what a click would
pick, and the click itself is swallowed (nothing is sent or opened; Esc or Cancel stops it). Each
item has a chip:

- **blue “Not set”** — nothing saved, AutoInjector's built-in way of finding it is used;
- **green “Picked: …”** — just picked, with a short preview (the first words of the reply / “Send
  button found”), not saved yet;
- **green “✓ Saved 10:42”** — locked in (saved per site, versioned, with the time; 🔢 if the number
  teach saved it);
- **red “⚠️ Saved — not found on the page now”** — saved, but it no longer matches the page.

Every item has its own **Clear** and **Save**: save any ONE at any time — you never have to do all
three. Clear removes a new pick, or (if there is none) the saved one, back to the built-ins.
**Test it** sends a check-in to confirm the AI answers and is read. **🔢 Do it for me with a
number** starts the number teach (above). A reply pick is generalised the same way as everything
the self-repair learns (it matches every reply, never one message). The old round-trip test is the
small **🧪 Test** button in the same card. A pick's preview text is shown only in the card, never
logged.

This replaces needing to open DevTools yourself for the common case (a site
renamed a class or restructured its composer). If picking doesn't land on
the right element (rare, but a heavily nested or virtualized UI can confuse
the "find the nearest meaningful ancestor" heuristic it uses), or if you'd
rather hand me the fix directly, the manual route still works: click the 🔍
button on that AI's card to open Chrome DevTools on that exact pane,
right-click the actual input box, Send button, or a reply bubble →
**Inspect**, and send the element's tag/class/attributes — that's what lets
me fix `selectors.js` itself for real, rather than guessing again.

### 🔑 Saved logins: one click, no typing your password every time

Each AI column has its own **🔑** button. It's entirely manual — nothing is
auto-detected or auto-filled on its own. Click it, click **+ Add Login**,
give it a label (e.g. "Personal", "Work" — you can save more than one per
site, useful if you actually use multiple accounts for the same AI), your
username/email, and your password, then **Save Login**. Next time that
site's login page is showing, click 🔑 → the saved login's name, and it
types your username and password into whatever fields are actually on
screen and clicks Sign In for you.

**Security:** your password is encrypted the instant you save it, using
Electron's `safeStorage` — which hands off to your operating system's own
keychain (macOS Keychain, Windows DPAPI, Linux libsecret/kwallet). It is
never stored as plain text, not even in the app's own state file, and it's
only ever decrypted for the split second a fill you personally clicked
needs it. If your system has no keychain backend available at all (some
minimal Linux setups), saving is refused outright rather than silently
falling back to storing it unencrypted.

**Multi-step logins are expected, not a bug.** ChatGPT, Claude, and
Google's own login pages (which Gemini uses) commonly ask for your email on
one screen and your password on the next, rather than both at once. If a
click only fills in one field and doesn't find a Sign In button yet, that's
normal — the status line says so, and clicking the same saved login again
once the next screen appears fills in the rest. Like every other DOM
selector in this app, exactly which fields it looks for is a best-effort
guess (`LOGIN_USERNAME_CANDIDATES`/`LOGIN_PASSWORD_CANDIDATES`/
`LOGIN_SUBMIT_CANDIDATES` in `selectors.js`) that may need a touch-up if a
site's actual login page doesn't match — same story as the chat selectors,
fixable the same way (send me what the real fields look like).

## How it's built

- `main.js` — Electron main process. Each site's pane is positioned by
  measuring an empty placeholder div (`#pane-slot-<site>`) inside the control
  panel's own HTML and copying its exact on-screen rectangle, so the live pane
  sits directly under that AI's control strip and collapses cleanly when the
  participant is unchecked — no hardcoded split. Polls each pane's latest
  reply every ~1.5s to detect when it's finished streaming, routes messages
  (manual, per-pane auto, the global full-mesh Auto, or a House Rules format)
  between panes, and keeps an in-memory activity log of everything that
  happens. Everything lives in one `BaseWindow` — one `WebContentsView` per
  AI site plus one full-window `WebContentsView` for the control panel —
  plus three on-demand popup windows (Prompt Editor, Document Viewer, Prompt
  Sequence) that only get created the first time they're actually needed. A
  generic `broadcast()` sends every UI update to every open window at once,
  so they all stay in sync. Roundtable v2's `[TO: X]` tag-parsing is the
  program's permanent baseline: `pollSite()` runs it on every captured reply
  from every site unconditionally, *unless* one of the seven House Rules
  "stage" formats (tracked in a `STAGE_MODES` set) is currently active, in
  which case that format's own state machine takes over instead — there's no
  separate "start Roundtable" event, so the instant a stage is stopped,
  tag-routing is simply what runs on the next captured reply, automatically.
  A `[TO: NONE]` reply, or a stage's own internal "swallow" cases
  (Chargeback's Referee acknowledgments, Rotation's `"UPDATED"`
  confirmations), never reach the transcript at all. Each site view gets a
  one-time `did-finish-load` listener that fires
  `sendStartupRoutingPromptOnce()` — sends the routing-explainer prompt
  (Prompt Library id 2) once per app launch, guarded by a `Set` so a later
  manual reload doesn't re-trigger it. A short list of rate-limit/usage-cap
  phrases is checked against every new reply unconditionally, not just while
  a House Rules stage is active — a match is always captured/shown
  (`isRateLimited`) but never relayed onward (routing, House Rules, Prompt
  Sequence, and a waiting manager task all skip it); a House Rules stage
  additionally auto-pauses itself on a match, same as before. Transcript,
  custom roles, saved Prompt Library entries, and paused-run state are
  written to a debounced JSON snapshot in `app.getPath("userData")` on every
  meaningful change (atomically — a temp file is written and renamed into
  place, never an in-place write, so a crash mid-save can't corrupt it) and
  reloaded on startup (always as **paused**, never active — a restart must
  never auto-send). The transcript itself is capped at `MAX_TRANSCRIPT`
  (1,000) entries, oldest evicted first, both on push and on load. Prompt
  Library sends (`prompts:send`) reuse the same
  `sendTextTo()` every other manual send goes through, just once per AI with
  that AI's own text instead of one shared message — an empty/blank field for
  a site is treated as "don't send to it," not "send nothing." Saving or
  deleting a prompt also broadcasts `prompts-changed` to every open window,
  which is how the Automation window's dropdown stays in sync when a save
  actually happened from the separate prompt-editor popup. The **Prompt
  Sequence** backend (`startSequence()`/`sendSequenceStep()`/
  `handleSequenceCapture()`) is a linear queue of `{target, text}` steps,
  sent one at a time — each step's target's next captured reply (or, for an
  "all" step, the first of the three to reply) advances to the next step,
  rather than firing on a timer. Each dispatch stamps `seq.generation` (a
  monotonic counter) into `seq.dispatchGen[site]` for every site it sends
  to; `handleSequenceCapture()` requires a capturing site's own
  `dispatchGen` entry to match the sequence's *current* generation before
  accepting it, discarding (and logging,
  `sequence-stale-capture-ignored`) anything that doesn't — the same
  stale-continuation guard pattern the manager loop uses via `taskId`,
  applied here to stop an in-flight reply for a step the sequence has
  already advanced past from being misread as satisfying whatever step
  comes next. **Zoom** (`site:zoom`) calls
  `webContents.setZoomFactor()` directly on the live site view, clamped to
  [0.4, 2.0] — it zooms the real embedded page, not the app's own UI. The
  **selector picker** (`selector:pick`/`selector:clear`) is the self-service
  alternative to sending me a DevTools screenshot: it runs
  `buildPickScript()` (see `automation.js` below) in the target pane, which
  resolves once the user clicks the real element for that role — and, in
  that same click handler, also resolves `matchCount` (does the generated
  selector actually find the element back), `visible` (is it on-screen with
  real dimensions), and `roleOk` (is it the right kind of element for
  `input`/`send`; always true for `assistant`, which has no fixed tag).
  `selector:pick`'s handler rejects the pick (never saving anything) if any
  of those come back bad, or — for an `assistant` pick specifically — if the
  captured sample `looksLikeEcho()` the last thing actually sent to that
  site (`state.lastSentTo[site]`), the same shared helper the connectivity
  test's echo detection uses. Only once a pick clears all of that does it
  get stored in `state.selectorOverrides[site][role]`
  (`input`/`send`/`assistant`), persisted the same way as everything else.
  `sendTextTo()` and `pollSite()` both pass `state.selectorOverrides[site]`
  into `buildSendScript()`/`buildReadScript()`, which try it *before*
  `selectors.js`'s built-in candidates rather than instead of them, so a bad
  pick never fully locks you out — clearing the override (or just picking
  again) falls straight back to the built-ins. The **connectivity test**
  (`selftest:run`) is a genuine end-to-end check, not a ping: it generates a
  fresh, effectively-unique token and sends a prompt asking that site to
  reply with the token **reversed** — not echoed verbatim — via the same
  `sendTextTo()` every other manual send uses, bypassing routing entirely,
  then polls `state.captured[site]` — which `pollSite()` already keeps
  current on its normal cycle — for a capture at or after the send.
  `waitForTestReply()` classifies whatever lands into one of four outcomes:
  the reversed token present *without* the original is `ok: true`; both
  present is `SELECTOR_TOO_BROAD` (almost always reading the whole thread,
  prompt included); only the original is `REPLY_ECHO` (reading the outgoing
  message, not any reply); neither is `REPLY_MISMATCH` (something came back,
  but it's not a match either way); nothing at all is `TIMEOUT`. Asking for
  a transformation instead of an echo, and requiring the original token's
  *absence*, closes the specific false-positive a plain echo test can't
  catch: a too-broad `assistant` selector that reads the sent prompt back
  would trivially "pass" a verbatim-echo test, since the token is right
  there in what was sent. A `selftestInFlight` set
  keyed by site rejects a second concurrent run for the same site
  (`ALREADY_RUNNING`) rather than crossing two tests' results. The
  connectivity test's own send/wait/log logic is factored out into
  `runConnectivityTest(site)` so the **🎛️ Tuner** (`tuner:run`) can reuse it
  verbatim across all three sites rather than duplicating it. The Tuner's
  own relay-leg check (`runRelayLegTest(source, target)`) proves actual
  A-to-B delivery, not just individual reachability, by temporarily adding
  `target` to `state.routing[source]` (restored in a `finally` block,
  never touching a routing pair that was already there) and asking source
  ONE question whose answer works for both hops: answered directly, source
  replies `RELAY-TEST <token>`; mesh then forwards that whole reply
  (including its own trailing conditional instruction) to target, which —
  seeing itself addressed via a forward rather than directly — follows the
  else-branch and replies `RELAY-RECEIVED <token>` instead. Neither AI is
  ever asked to blindly relay text without answering it, which is the
  fragile approach that tends to fail in practice; both hops just answer
  the message actually in front of them. `tunerInFlight` guards against a
  manual 🧪 Test colliding with a Tuner run touching the same site (checked
  in the `selftest:run` handler, not inside `runConnectivityTest()` itself,
  since the Tuner's own internal calls need to go through even while it's
  the one holding that flag). The **🔑 saved-logins** feature
  (`logins:list`/`logins:save`/`logins:delete`/`logins:fill`) is purely
  manual end to end — nothing auto-detects a login form or auto-triggers a
  fill. `logins:save` refuses outright (`ENCRYPTION_UNAVAILABLE`) unless
  `safeStorage.isEncryptionAvailable()`, then stores only
  `safeStorage.encryptString(password)`'s ciphertext (base64-encoded) in
  `state.savedLogins[site]` — the plaintext password is never held anywhere
  once that call returns, never sent back to the renderer (`sanitizedLogins()`
  strips it before every response), and never appears in `logEvent()` calls
  (`login-saved`/`login-fill-started`/`login-fill-ok`/`login-fill-error` log
  the label and username only). `logins:fill` is the only place the
  ciphertext is ever decrypted, immediately before building and running
  `buildLoginFillScript()` (see `automation.js`) against the live pane —
  which fills whichever of `LOGIN_USERNAME_CANDIDATES`/
  `LOGIN_PASSWORD_CANDIDATES` (per site, in `selectors.js`) are actually
  present on screen right now (never assuming both exist at once, since
  ChatGPT/Claude/Google's own login flows are commonly multi-step) and
  clicks whatever matches `LOGIN_SUBMIT_CANDIDATES`.
  `logEvent()`
  also appends every internal
  event to a capped, rolling debug log file in the same folder, so a real
  crash still leaves something to troubleshoot from. Delivering an actual
  *file* into a pane (📎 Attach Document) can't go through
  `executeJavaScript()` like everything else, since that can only inject
  text — `attachFileToSite()` instead drives the Chrome DevTools Protocol
  directly (`webContents.debugger`), the same underlying technique
  Puppeteer/Playwright use for file uploads: find the page's file input,
  then `DOM.setFileInputFiles` it with the real path, which fires the same
  `input`/`change` events a genuine drag-drop would. The attach/detach cycle
  is scoped to a single Send click, but it shares its underlying CDP slot
  with the 🔍 Inspect DevTools feature — having both attached to the same
  pane at once can make the attach fail (reported as `ATTACH_FAILED`), a
  rare, self-resolving collision rather than something worth special-casing.
  The **manager/orchestrator loop** (`runManagerTurn()`/`executeManagerAction()`/
  `handleManagerCapture()`, see the section above) is event-driven the same
  way Prompt Sequence is: a `DELEGATE`-family action sends via `sendTextTo()`
  and returns immediately, and `handleManagerCapture()` — hooked into
  `pollSite()`'s dispatch exactly like `handleSequenceCapture()` — resumes
  the loop once every pending target has actually replied, rather than
  blocking on a wait. Because `runManagerTurn()`/`handleManagerCapture()`
  are always fire-and-forget from whatever triggers them (`manager:stop`,
  a reject/approve, a captured reply), each one captures its task's id
  before its first `await` and re-checks `state.manager.taskId` (and that
  the task hasn't been stopped) immediately after — otherwise a slow
  provider response arriving after the user stops or replaces the task
  could still go on to mutate whatever task is running *now*.
- `manager-provider.js` — the manager's interchangeable backend
  (`askManager()`), the one deliberate exception to "no API keys" in this
  app (see the Manager section above for why). Every supported provider —
  RunPod Serverless's own OpenAI-compatible workers, a dedicated RunPod pod,
  Ollama, LM Studio, or any other OpenAI-compatible endpoint — speaks the
  same request/response shape, so there's no provider switch in the HTTP
  logic itself, only `config.endpoint`/`config.apiKey` change; a separate
  `startPod`/`getPodStatus`/`waitUntilReady`/`stopPod` group handles a
  dedicated RunPod pod's own lifecycle via RunPod's REST API, kept isolated
  since it's the least-standardized, least-tested part of this file. A
  response is only ever treated as a decision once it round-trips through
  real JSON parsing (recovering a `{...}` block even if the model wrapped it
  in stray prose) and its `action` is confirmed to be one this app actually
  knows — main.js's own, deeper validation (safe paths, real targets, no
  injection attempts) happens on top of this, not instead of it.
- `automation.js` / `selectors.js` — build two small scripts run inside each AI's
  pane via `webContents.executeJavaScript()`: one to type text into the chat box
  and click send, one to just read whatever the latest reply currently says.
  The send script doesn't trust that clicking Send "worked" just because the
  click didn't throw — it checks that the input box actually went empty
  afterward (what every real chat UI does on a genuine submit), retrying via
  Enter if a wrong/disabled button was clicked instead, and only reports
  success once that's confirmed. Mirrors the selectors used by the browser
  extension's `content.js`/`selectors.js`. A third builder,
  `buildFileInputFinderExpression`, is different in kind from the other
  two — it's not run via `executeJavaScript()`, it's the `expression` field
  of a CDP `Runtime.evaluate` call (see `attachFileToSite()` above), since
  that's what hands back the raw `objectId` `DOM.setFileInputFiles` needs.
  Each site's `FILE_INPUT_CANDIDATES` in `selectors.js` are **best-effort
  guesses, not yet verified against the real sites** — same caveat as every
  other selector list here, fix the same way (🔍 Inspect on the live pane,
  find the actual upload input, update the list). A fourth builder,
  `buildPickScript(role)`, backs the 🎯 selector picker: it's an IIFE that
  returns a `Promise`, which `executeJavaScript()` awaits automatically —
  it shows a small on-page banner, then resolves once the user clicks a real
  element in that pane (capturing that click with `preventDefault`/
  `stopImmediatePropagation` so nothing actually submits or navigates), or
  after a 30s timeout with no click. Selector generation prefers
  `data-testid`/`aria-label`/a non-hashed-looking `id`, then a couple of
  short, non-numeric class names, falling back to a bare tag name; for the
  `input`/`send` roles it first walks up to the nearest `textarea`/
  `[contenteditable="true"]` or `button`/`[role="button"]` ancestor (since a
  click usually lands on an inner text node or icon, not the actual editable
  container or button itself), while `assistant` climbs through plain
  single-child wrapper elements so clicking inner reply text still resolves
  to the smallest element containing the *whole* reply.
- `controls.html` / `controls.js` — the Automation window's control panel UI:
  the AI columns (with zoom, the 🎯 selector-picker menu including 🧪 Test and
  its green/amber/red indicator dot, Forward/Auto/Auto-Both, collapse), Role
  Assignment, House Rules, the Prompt Library's compact dropdown +
  Send/New/Edit/Delete, the 🧵 Prompt Sequence trigger, the collapsed-pane
  strip that shares House Rules' unused space, and the collapsible
  Transcript/Activity Log panel. This is the only window now — there's no
  separate always-open Conversation window anymore, so everything that used
  to live there (the transcript, Role Assignment, Send/Start/Pause/Resume/
  Stop-equivalent controls) is here instead.
- `prompt-editor.html` / `prompt-editor.js` — the small, on-demand popup
  window for creating/editing one Prompt Library entry: a name field, one
  text box per AI, a `→ All` shortcut that copies a shared draft into all
  three, and Save/Cancel. Only created the first time `+ New` or `Edit` is
  clicked; re-navigates the same window (via a `?id=<n>` query string, or
  none for a blank prompt) instead of opening a second one if it's already
  open.
- `prompt-sequence.html` / `prompt-sequence.js` — the small, on-demand popup
  for building a Prompt Sequence: an add/remove-able list of `{target, text}`
  step rows (target picked from a dropdown: All/ChatGPT/Claude/Gemini), a
  Run button that calls `runSequence()` and disables itself while active, a
  status line reflecting `sequence-state` broadcasts from `main.js`, and
  Close. This window doesn't run the sequence itself — `main.js` owns all of
  that state, same division of labor as everywhere else in this app.
- `document-viewer.html` / `document-viewer.js` — the on-demand popup for
  previewing a file before sending it, same lazy single-instance pattern as
  the prompt editor (`?path=<encoded path>` query string). Renders
  differently by file type: images get an `<img>` plus a transparent
  `<canvas>` overlay for click-drag highlight rectangles; text files (capped
  at 500KB) render as real, selectable text with a `Mark Selection` button
  that wraps the current selection in a `<mark>`; PDFs embed via an
  `<iframe>` pointed at a `file://` URL, relying on Chromium's built-in PDF
  viewer — **no highlighting support for PDFs in this version**, since doing
  that properly would mean rendering pages to a canvas ourselves (bundling
  pdf.js) instead of using the built-in viewer, a meaningfully bigger lift
  than "a visual note to yourself" called for; anything else just shows the
  filename, no preview, Send still works. Every highlight (canvas rectangles
  or `<mark>` tags) lives only in that page's own memory/DOM — never
  persisted, never sent to any AI, never touches the actual file on disk.
- `preload.js` — the IPC bridge shared by every window (the Automation
  window and all three popups), talking to the main process over
  `ipcRenderer`/`contextBridge` (no direct Node access from either page,
  same as the sites' own panes).

Selectors are best-effort with fallbacks, same caveat as the extension: if a site
redesigns its chat UI, `selectors.js` is the first place to fix — use the 🔍
Inspect button described above to get the real answer instead of guessing.

## Running the test suite

```bash
npm test
```

One app, one launcher (Akọwe started by AutoInjector): `test/akowe-server.test.js`
(the server manager with fake child processes — start + health wait, reuse of a
running Akọwe, crash restart with backoff and a limit, stop on quit, Python
missing, the Windows venv bootstrap, busy ports, no answer), `test/akowe-tab.test.js`
(the 📖 Akọwe tab's notices and buttons, jsdom) and `test/e2e/akowe-oneapp.e2e.js`
(real Electron under xvfb starts the real `../akowe` server with `python3`, shows
the signed-in workspace in the tab, pops out and back, pairs by itself, stops it on
quit; then a run with no Python on PATH shows the notice).

This mocks out Electron itself (`test/mock-electron.js`) — no browser, no display
needed — and requires the real `main.js` against it, driving it through its
actual IPC handlers exactly like the control panel does: simulate a reply
appearing on a site, check what gets sent next. It covers the House Rules state
machines (Debate's turn order and round-ending, Devil & Angel's role isolation
and fan-in, Chargeback's silent Referee and final verdict, Who Wants to Speak's
opt-in filtering, Free-for-All/Brainstorm's mesh setup and teardown, Rotation's
fixed RESPOND/UPDATE cycle and its "UPDATED" acks never reaching the
transcript), Pause/Resume round-tripping routing state, Role Assignment's
persona clause injection, window-collapse bounds math (shrinks to a 44px
titlebar in place and restores the exact original bounds), and a couple of
routing edge cases (disabling a participant mid-run, House Rules' own Stop
button actually clearing the mesh it set up).

It also covers Roundtable v2's always-on baseline: the routing-explainer
prompt getting auto-sent to every site exactly once on startup, before
anything else; routing for every `[TO: X]` tag with no House Rule ever
started (`CLAUDE`/`CHATGPT`/`GEMINI` relay to just that one and strip the tag
before display, `ALL` relays to the other two, `USER` stays purely visible
with no relay, `NONE` never reaches the transcript at all), a missing-tag
reply falling back to `USER` per the routing prompt's own documented
default, case-insensitive tag matching, and an AI addressing itself being a
no-op instead of a self-relay; and — the core of the stage-vs-baseline
model — that starting a House Rules format (e.g. Debate) suspends
tag-parsing entirely (a `[TO: X]`-looking line in a reply during Debate is
left as plain, untouched text, and the format's own state machine drives the
next send instead of a tag-routed relay), and that stopping it hands control
back to tag-routing automatically on the very next captured reply, with no
separate action needed to re-enable it.

It also covers the mesh/tag double-dispatch bugfix directly: with full mesh
routing on (`routing:auto-all`) and a `[TO: CLAUDE]` tag also naming a
mesh-covered target, that target gets exactly one delivery (the clean,
tag-stripped one from tag routing, not the raw mesh copy) while an
unaddressed site in the same mesh still correctly gets its own separate
mesh copy — checked against `sentLog` counts, the actual message content,
and the delivery ledger (exactly one entry, not flagged `duplicate:true`);
and the same for a `[TO: ALL]` reply with full mesh on, where both other
sites still get exactly one copy each, not two.

It also covers the Prompt Sequence backend: `sequence:open`/
`sequence-editor:close` managing a single popup window instance the same way
the other popups do; steps firing one at a time, each waiting for that
step's actual target to reply before advancing (an unaddressed site's reply
is correctly ignored); an "all" step advancing on the *first* of the three
replies rather than waiting for all three; `sequence:run` rejecting a second
run while one's already active (`ALREADY_RUNNING`) and filtering out
malformed steps (bad target, blank-after-trim text) before rejecting an
empty result (`NO_VALID_STEPS`); and `sequence:stop` marking a run inactive
mid-flight. It also covers the `site:zoom` handler: an in-range factor
passing straight through to `webContents.setZoomFactor()`, and out-of-range
values clamping to the documented [0.4, 2.0] range rather than being
rejected outright.

It also covers the 🎯 selector picker, at two levels. A pure unit-level check
on `automation.js` itself (no Electron mocking involved) confirms a picked
override is embedded *ahead* of the built-in candidates in the scripts
`buildSendScript`/`buildReadScript` actually produce, with the built-ins
still present as fallback, and that omitting the overrides argument
entirely doesn't throw. Then, against the mocked `main.js` orchestration
(`test/mock-electron.js` gained a settable `_nextPickResult` and a
`pickCalls` log, recognizing a pick script by its `__AUTOINJECTOR_PICK__`
marker the same way it recognizes a send script via `typeByKeyboard` —
never simulating real DOM, same fidelity as the rest of that mock): a
successful pick stores the override, reflects it in `state:get`, and
survives to the persisted state file; different sites/roles pick
independently without clobbering each other; a timed-out pick reports
`TIMEOUT` and never stores anything; `selector:pick`/`selector:clear` reject
an unknown site or role; and clearing an override actually removes it. A
separate scenario covers the post-pick validation specifically: a
`matchCount: 0` pick is rejected as `NOT_FOUND`; `visible: false` as
`NOT_VISIBLE`; `roleOk: false` as `WRONG_ELEMENT_TYPE`; an `assistant` pick
whose sample echoes `state.lastSentTo[site]` as `LOOKS_LIKE_ECHO`; none of
these ever become a stored override; and a pick that clears every check
still saves normally.

It also covers the 🧪 connectivity test end to end: the sent prompt actually
asks for the token **reversed**, not echoed, and embeds a real one; a reply
containing the reversed token (and not the original) is a pass; a reply
containing *both* forms is `SELECTOR_TOO_BROAD`; a reply containing only the
original (unreversed) token is `REPLY_ECHO`; a reply that arrives but
matches neither form is `REPLY_MISMATCH`, not miscounted as a pass or a
timeout; `test/mock-electron.js` gained a `_forceSendFail` flag (mirroring
the CDP mock's existing `_forceAttachFail`/`_forceSetFilesFail`) so a send
that never actually submits is reported at the `send` stage without the
test needing to wait out anything; an unknown site is rejected; and starting
a second test for a site that already has one in flight is rejected as
`ALREADY_RUNNING` rather than the two crossing results, with the original
run still resolving normally afterward.

It also covers the 🎛️ Tuner end to end: driving a full run means answering
all three connectivity checks AND all 6 relay legs as they're reached, in
the exact order the Tuner issues them (scripted by watching each site's
`sentLog` grow, extracting the real token from what was actually sent, and
replying as the AI would) — checking the relay prompt itself asks for the
self-selecting conditional reply (never a literal "relay this" instruction),
that the target genuinely receives the forwarded reply verbatim, that the
final summary reports all 3 sites and all 6 legs passing, that mesh routing
is fully cleaned up afterward (nothing left on that wasn't already there),
and that both the start and the final tally land in the Activity Log. A
second scenario proves a concurrent second Tuner run is rejected
(`ALREADY_RUNNING`) and, further, that a manual 🧪 Test is refused
(`TUNER_RUNNING`) while one is in flight rather than racing it. A third
scenario proves the `forward-send` vs. `relay` distinction is real: it runs
a full Tuner pass but sabotages just the internal forward on one specific
leg (`chatgpt->claude`, via the mock's `_forceSendFail`) so source answers
its own half correctly but the mesh forward to target never actually sends
— and checks that leg is reported with `stage:"forward-send"` and the real
underlying error, not lumped in with (or mistaken for) target simply never
replying, while the other 5 legs — answered normally — still pass.

It also covers the 🔑 saved-logins feature end to end, with a real
(non-secure, but functionally real) `safeStorage` mock so the actual
encrypt/decrypt round trip runs, not just the plumbing around it: saving
returns the new entry's label/username but never its password or
ciphertext; the raw password never appears anywhere in the persisted state
file, only its encrypted form under a distinctly-named field; a fill
decrypts back to the exact original password and reaches the DOM script
correctly; the Activity Log records saves and fills by label/username only,
confirmed by grepping every log entry's detail for the raw password and
finding nothing; multiple independent logins can be saved for the same
site, and deleting one leaves the others untouched; every validation path
(blank label/username/password, unknown site, a nonexistent saved login,
no keychain backend available) is rejected with its own specific reason,
never a silent no-op or a plaintext fallback; and a multi-step login (only
one field present, or no login form on screen at all) is reported honestly
rather than miscounted as a clean pass or a hard failure. `controls.test.js`
separately covers the UI: adding a login shows it in the list and clears
the password field from the DOM afterward, clicking a saved login is the
ONLY thing that ever calls the fill IPC (loading the window never does),
delete removes just that one entry, and a rejected save (e.g.
`ENCRYPTION_UNAVAILABLE`) shows its specific reason in the status line.

It also covers rate-limit detection outside House Rules: with plain
Auto-routing wired up (no House Rule active), a usage-cap-looking reply is
still captured and marked `isRateLimited`, but never relayed to any routed
target — and, since there's no House Rule to pause, the mesh routing itself
is left untouched rather than being cleared. And it covers the persisted
state file: on load, a transcript longer than `MAX_TRANSCRIPT` (1,000) gets
capped to the newest 1,000 entries, oldest evicted first — checked by
seeding a 1,051-entry file and confirming both the count and which specific
entries survive.

It also covers the per-target send queue deterministically:
`mock-electron.js` gained a `_sendDelayQueue` (an array of ms to
artificially delay each successive send script against a site, shifted per
call) so a test can fire two sends at the SAME target where the first is
slow (300ms) and the second is instant (0ms), and prove they still land in
`sentLog` in the order they were issued — not the order they'd individually
finish in — with the combined wall-clock time showing they ran one after
another rather than in parallel. This is exactly the scenario that used to
produce a real ~50% `SEND_NOT_CONFIRMED` rate under mesh routing before the
queue existed.

It also covers the auto-retry behavior: `mock-electron.js` gained a
`_sendFailQueue` (per-attempt pass/fail overrides, shifted on every real
send AND every retry of it) so a test can script "fails twice, then
succeeds on the 3rd try" precisely — checking the caller only ever sees the
eventual success, exactly one real message actually lands (not three),
both earlier failed attempts are logged individually as `send-retry`, and
the final `sent` log entry and delivery-ledger entry both carry the real
attempt count (3) with `selfRecovered:true`. A second case scripts all 3
attempts failing, confirming it's then reported as a genuine
`SEND_NOT_CONFIRMED` failure (never silently swallowed), nothing was ever
actually sent, all 3 attempts really ran with real backoff between them
(checked against wall-clock time, not just call count), and the ledger and
`send-error` log entry both still carry the real attempt count even for a
total failure.

It also covers the delivery ledger: a successful compose records exactly
one entry with the real target, `source:null`, `status:"delivered"`, and a
program-assigned `MSG-<n>` id; a tag-routed relay records the actual
originating site as `source`, never left null or trusted from anything
inside the message text; a forced `SEND_NOT_CONFIRMED` failure still gets
recorded (with the real error), not silently dropped; and sending the exact
same text to the exact same target twice in quick succession flags the
second entry `duplicate:true` while leaving the first alone.

It also covers Blind Round end to end: refuses to start with fewer than 3
participants enabled; all three get the identical prompt in the same
kickoff, each framed as an independent ask; the first (and second) reply to
land does NOT get shown to anyone — `pendingReplies` in the House Rule
snapshot tracks exactly who's left, verified after each of the first two
answers — until the third and final independent answer arrives, at which
point each site's own reveal is checked to contain the OTHER two answers
(correctly labeled) and specifically NOT its own; and the run marks itself
inactive automatically once the reveal goes out, with no further action
needed to end it.

It also covers the manager/orchestrator loop, stubbing out
`manager-provider.js`'s `askManager()` at the module level (main.js's own
`require("./manager-provider")` resolves to the exact same module-cache
entry, so this intercepts every call main.js makes without touching main.js
itself) so full task lifecycles run against a scripted sequence of
decisions instead of a real backend: a complete classify→delegate→capture
a real reply→finish run, checking that the real project folder, checkpoint
file, and raw response actually land on disk; approval mode holding a
proposed action until approved (with an assertion that nothing was actually
sent while it was pending, not just hidden) or discarded on rejection, with
the rejection itself recorded in the manager's own action history; a
decision that's syntactically valid but targets something outside chatgpt/
claude/gemini being rejected and, if it keeps happening, escalating the
tier and eventually ending the task via `maximumTurns` rather than looping
forever; an explicit `ESCALATE` action jumping straight to a requested
tier, Tier 4 routing to a real AI pane instead of the configured provider
and never touching it while at that tier, then de-escalating back down and
resuming the configured provider once a response lands; a `SAVE` action
writing real content to disk under that task's own `final/` folder, and a
path-traversal attempt being refused rather than ever landing outside it;
and pause/resume/stop leaving an in-flight delegation exactly where it was
rather than re-sending anything. `test/manager-provider.test.js` covers the
provider layer directly with a mocked `global.fetch` (no Electron needed at
all): the exact request shape sent (endpoint, Bearer auth, model/messages),
recovering a JSON decision even when wrapped in stray prose, distinguishing
an unparseable reply, a non-2xx response, a network error, and a timeout
from each other, redacting the API key from every error path, and the
RunPod dedicated-pod lifecycle calls hitting the right REST routes.

It also covers the Prompt Library backend: both built-ins existing by
default ("System Test," with each AI's own version correctly naming the
*other* two; "System Prompt (How Routing Works)," whose text for every AI
actually mentions the `[TO: X]` tag syntax), saving a new prompt with
different text per AI, sending it and confirming each AI got its own exact
text with no forwarding wrapper while a blank field's AI got nothing at all,
rejecting a send where every field is blank/whitespace-only instead of
silently doing nothing, editing an existing prompt in place (no duplicate),
deleting one, and that the deletion actually lands in the persisted state
file on disk. It also covers the standalone prompt-editor popup window
itself at the `main.js` level: opening it targets the right prompt (its id
riding along in the URL as a query string), re-opening while it's already
open re-navigates that same window instead of spawning a second one, saving
from it broadcasts `prompts-changed` so the Automation window's dropdown
picks up the change without polling, and closing it actually destroys the
window.

It also covers the 📎 Attach Document backend, using a mocked
`webContents.debugger` (`test/mock-electron.js` records what CDP command was
sent with what params, the same level of fidelity as the rest of that mock —
real DOM stays Playwright's job): a successful send delivers the file to
exactly the checked targets and nothing to the ones left unchecked;
`NO_FILE_INPUT_FOUND`, `SET_FILES_FAILED`, and `ATTACH_FAILED` are each
reported distinctly rather than one generic failure, and — critically — the
debugger session actually detaches even on the failure paths (proving the
`finally` block runs, not just the happy path); a missing file or an empty
target list are both rejected before any per-site work happens;
`document:read` classifies files correctly by extension (text, including
respecting the 500KB preview cap; image and PDF, both getting a `file://`
URL rather than bytes shuttled through IPC; anything else falling back to
filename-only); and `document:choose` opens the file dialog, then the
viewer window targeting whatever was picked, re-targets that same window
(not a second one) if a different file is chosen while it's still open, and
closing it actually destroys the window.

`npm test` also runs `test/controls.test.js`, the same jsdom approach applied
to `controls.html`/`controls.js`: the collapse feature (each AI column's own
toggle relocating it between the collapsed and expanded strips rather than
just adding a class, and that `#collapsed-strip` is its own always-present
row, specifically **not** nested inside House Rules — House Rules can now
collapse itself too, so a collapsed AI pane needs a home that doesn't
disappear along with it; the Automation window's titlebar toggle; that a
collapse event for a different window id is correctly ignored; the
Transcript/Log panel expanding only once *all three* panes are collapsed;
the Transcript/Log panel's own independent collapse button), the Stop
confirmation prompt, that Roundtable v2 has **no** dropdown option anymore
(it isn't a stage you start/stop) while the seven real stage formats still
are, the `→ Claude`/`→ Everyone`-style routing badge rendering on captured
turns, that the manual Forward/Auto/Auto-Both buttons stay visible *and*
genuinely clickable no matter what a House Rules stage is doing (clicking
Auto mid-stage still calls `setRouting`) — proving the old hide-while-active
behavior is gone for good, the combined Auto → Both toggle (one click turns
both individual routes on together, lights up once both are on, a second
click turns both off), the zoom buttons (clicking calls `setZoom` and the
on-screen percentage label updates to match), the 🎯 selector-picker menu
(collapsed by default and toggles open/closed; Pick Input/Send/Reply call
`pickSelector` with the right site/role and show the returned selector plus
sample text inline as confirmation; a failed/timed-out pick shows the real
error instead of pretending success; Clear Overrides clears all three roles
for that site; 🧪 Test calls `runSelfTest`, flips its indicator dot to
pending immediately and to green/red once the result lands, and a failure
shows the specific reason rather than a bare red light), that the Activity
Log itself renders the rich detail these two features log (role, selector,
captured sample, token, and — on a mismatch — the actual text that was
captured instead) rather than just the bare event name, with a `*-error`
entry visibly styled as an error line, the 🎭 Role Assignment popup
(opens/closes via its trigger button; presets fill the free-text field but
don't call `setRole` until Apply is actually clicked, proving a preset pick
alone is inert; Apply works for both a picked preset and typed custom text;
Clear resets the input, the preset dropdown, and the "current: X" label
together), the 🧵 Prompt Sequence trigger button (now inside the User Panel,
not House Rules) calling `openSequenceEditor`, and the Prompt Library
dropdown — options rendering from the saved list (and a placeholder +
disabled buttons when there are none), Send using the *selected* prompt's
saved text, `+ New`/`Edit` calling `openPromptEditor` with the right id
(`null` for new) rather than editing anything inline, Delete removing the
selected entry, and
a `prompts-changed` event (simulating the popup window having saved
elsewhere) re-rendering the dropdown live.

Also covered: the merged **User Panel** itself — Compose, the three
participant checkboxes, Attach Document, the 🎭 Roles trigger, and the 🧵
Prompt Sequence trigger all genuinely live inside `#col-userpanel` (not
scattered across separate panels the way they used to be), and it has no
collapse button of its own, unlike Global/House Rules/Prompt Library. The
💬 **Messages to you** feed: a captured turn tagged for another AI
(`roundtableTag: "CLAUDE"`) never counts; one tagged `"USER"` increments the
badge, renders inline color-coded by site, and opens the full popup when
clicked; the badge's zero state is visually suppressed via a `data-zero`
attribute; and past the third message, the inline feed caps at the 3 most
recent (newest first) while the popup still lists every one. The
**collapsible yellow panels**: each of Global/House Rules/Prompt Library
collapses independently into its own tab in `#top-tab-strip`, all three can
be collapsed at once, and clicking a tab restores that one panel and removes
just its own tab, leaving the others untouched.

`npm test` also runs `test/prompt-editor.test.js`, the same jsdom approach
applied to the standalone `prompt-editor.html`/`prompt-editor.js` popup:
fields start blank with no `?id=` in the URL, populate correctly from the
matching saved prompt when one's given (and degrade gracefully — blank, no
crash — if that id no longer exists), `→ All` copies one shared draft into
all three per-AI boxes, Save passes the id/name/text to `savePrompt` (`null`
id for a new prompt, the original id for an edit — so it updates in place
instead of duplicating) and then closes the window, an empty name is saved
as "Untitled" rather than blank, and Cancel closes without ever calling
`savePrompt` at all.

`npm test` also runs `test/document-viewer.test.js`, the same jsdom approach
applied to the standalone document-preview popup: a missing `?path=` degrades
gracefully instead of crashing; each `kind` from `document:read` renders the
right thing (image → `<img>` + highlight canvas with Clear Highlights, text →
the real content with a working Mark Selection that wraps a selection in
`<mark>`, oversized text → the size-limit message with no mark tool, PDF →
an iframe with *no* highlight tools since those aren't supported there,
unrecognized types → no preview element at all); the image highlight
interaction (mousedown → mousemove → mouseup on the canvas) wires up without
throwing — deliberately not asserted pixel-by-pixel, since jsdom doesn't
implement a real 2D canvas context and the real rendering only matters
inside actual Chromium anyway, same division of labor as everywhere else in
this suite; Send collects only the checked boxes and calls `sendDocument`
with the real decoded path; and the checkboxes default to whichever
participants are currently enabled.

`npm test` also runs `test/prompt-sequence.test.js`, the same jsdom approach
applied to the standalone `prompt-sequence.html`/`prompt-sequence.js` popup:
starts with a single blank "all" step; `+ Add Step` adds rows and removing
one renumbers the rest so there's never a gap; each step's target dropdown
offers All plus each of the three sites; Run Sequence collects every step
with actual text and calls `runSequence` with the right target/text pairs,
per step; blank/whitespace-only steps are filtered out before that call;
Run with nothing filled in shows a status message instead of ever calling
the backend; a rejected run (e.g. `ALREADY_RUNNING`) re-enables the Run
button and surfaces the real error; `sequence-state` broadcasts drive the
status line's progress text and the Run button's disabled state, both while
running and once finished; and Close calls `closeSequenceEditor`.

Finally, `npm test` runs `test/selectors-sync.test.js`, which loads *both*
copies of the selector config — `desktop-app/selectors.js` (CommonJS) and
`AutoInjector/extension/selectors.js` (loaded via Node's `vm` module with a
fake `window`, since it's written for a browser content script) — and diffs
every `INPUT_CANDIDATES`/`SEND_CANDIDATES`/`ASSISTANT_CANDIDATES` array
between them per site. The two files are hand-maintained copies of the same
information; nothing else catches it if one gets updated and the other
doesn't.

Every one of these runs automatically on push/PR via GitHub Actions
(`.github/workflows/desktop-app-tests.yml`) — a real CI runner (unlike this
dev environment) also has clean network access, so a second job in that
workflow installs Playwright fresh and runs `test:browser` (below) too.

### Optional: real-browser selector tests

```bash
npm install --no-save playwright   # one-time, NOT part of npm install/npm test
npx playwright install chromium    # skip if a browser is already installed
npm run test:browser
```

`test/browser.test.js` runs the *actual* `buildSendScript`/`buildReadScript`
output from `automation.js` inside a real Chromium (via
[Playwright](https://playwright.dev)) against static HTML fixtures in
`test/fixtures/` — as close to Electron's real `WebContentsView` as this
project can get without Electron itself. Unlike the two suites above, this
one exercises real `document.querySelector` matching, real contenteditable
typing, and real click events — the layer jsdom can't fully simulate. Right
now `test/fixtures/claude-reply.html` is a reconstruction of Claude's actual
DOM (captured via DevTools "Copy outerHTML" during troubleshooting the
selector bug) — if ChatGPT or Gemini selectors ever break the same way,
grabbing their outerHTML the same way and adding a fixture here lets this
get verified against real markup too, not just re-read by eye.

It also has one check for `buildFileInputFinderExpression` — confirming its
selector-matching logic actually resolves to a real `<input type="file">`
element against genuine Chromium DOM, not just in theory. That's the limit
of what this suite can verify for 📎 Attach Document, though: the actual CDP
wiring (`Runtime.evaluate` → `DOM.setFileInputFiles`) has no Playwright
equivalent, since `webContents.debugger` is an Electron main-process-only
API — that part is covered by the mocked orchestration tests in
`test/run.js` instead, plus manual testing against the real app.

Playwright is deliberately **not** a listed `devDependency` — if it were,
every user's plain `npm install` (including the one the `run-*.bat`/
`.command`/`.sh` launchers do automatically) would trigger Playwright's own
postinstall browser download, the same multi-hundred-MB download problem
this project already works around for Electron. So this stays a manual,
opt-in step for whoever's actively debugging a selector, not something
regular users ever need to run.

What none of the three suites can fully replace: an actual logged-in session
against the real chatgpt.com/claude.ai/gemini.google.com — login walls, bot
detection, and live UI changes are outside what any local test can see.
These suites are about everything short of that: who gets sent what and in
what order, what the UI actually renders, and whether the DOM-reading logic
matches real markup — which is also where the subtlest bugs turned out to
live.

## Building a real installer (.exe / .dmg / .AppImage)

The `run-*` scripts above are the fastest way to get running (they still need
Node.js once), but if you want an actual double-clickable installer that bundles
Node/Electron so nothing needs to be installed at all, this repo is wired up for
that too, via [electron-builder](https://www.electron.build/):

```bash
cd desktop-app
npm install
npm run dist          # builds for whatever OS you're running this on
# or target a specific OS explicitly:
npm run dist:win      # -> dist/*.exe (NSIS installer)
npm run dist:mac      # -> dist/*.dmg
npm run dist:linux    # -> dist/*.AppImage
```

The output lands in `desktop-app/dist/`. That installer file is the thing you'd
actually hand someone else to install with one double-click, no Node.js required
on their end. Building for an OS other than the one you're on ("cross-building",
e.g. making a `.exe` from macOS/Linux) can need extra platform tooling — building
on the target OS itself is the most reliable option.

I wired up the config but haven't produced/tested an actual build here (this
dev environment can't download the Electron binaries needed to build) — if
`npm run dist` errors out for you, send me the output and I'll fix the config.

## A note on the Electron version

`package.json` pins Electron to `~43.0.0` (patch-level updates only, not
minor/major) rather than the usual `^43.0.0` caret range. `BaseWindow` /
`WebContentsView` — the multi-window architecture this app is built on — is
a newer part of Electron's API surface than the older `BrowserWindow`/
`BrowserView` pattern, so it's worth being deliberate about which minor
version this has actually been built and tested against instead of silently
picking up whatever's newest at install time.
