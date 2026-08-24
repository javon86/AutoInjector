# AutoInjector — Feature List

Everything built and shipped so far, and the real mechanism behind each
one — not the marketing version. Lives next to `README.md` (which has the
full detail on each item) and `FUTURE_PLANS.md` (what's *not* built yet).

---

## 1. The Relay Engine

The part underneath everything else: how a message actually gets typed into
ChatGPT, Claude, or Gemini's real page, and how the app knows a reply came
back — no APIs, no keys, just driving the real web UI the same way you
would by hand.

- **Sending** (`sendTextTo()`) — injects a script into that site's live pane
  that types the message into its real input box and clicks its real Send
  button (or presses Enter) — the same DOM elements you'd use yourself.
- **Confirmed delivery, not assumed delivery** — a send only counts once
  the app watches the input box actually clear, polled over ~2.5 seconds
  rather than one fixed snapshot, so a genuinely slow-but-real send has
  room to land instead of being falsely flagged.
- **Reading replies** (`pollSite()`) — every pane is checked roughly every
  1.5 seconds for new text, and waits for that text to stop changing before
  treating it as a finished reply, so a still-streaming answer never gets
  captured half-written.
- **Per-target send queue** — every send to a given site is serialized, so
  two different sources trying to message the same AI at once queue up
  instead of typing into the same box simultaneously and corrupting each
  other. This was the actual cause of a real session's ~50% failure rate
  under mesh routing.
- **Automatic retry** (3 attempts, 1.5s backoff) — a send that fails
  confirmation is retried automatically before it's ever reported as
  broken. Logged individually as `send-retry`; the eventual result carries
  the real attempt count and a `selfRecovered` flag.
- **The delivery ledger** (`state.ledger`) — every send the app ever makes
  gets its own permanent record: target, what was sent, delivered or
  failed, real attempt count, and a duplicate flag if the same text hit the
  same target within five seconds. The program's own account of what
  happened, independent of what any AI believes.

## 2. Roundtable & Routing

How a message decides where it goes next — automatically, by hand, or both.

- **Roundtable v2 — tag-based self-routing envelope** (`[TO: X]` … `[FROM: X]`)
  — the permanent, always-on baseline. Every reply is wrapped in a two-tag
  envelope: it opens with a routing tag on its own line (`CHATGPT` / `CLAUDE` /
  `GEMINI` / `ALL` / `USER` / `NONE`) and closes with the sender's own tag
  (`[FROM: CHATGPT]` / `[FROM: CLAUDE]` / `[FROM: GEMINI]`). The **closing tag is
  the completion signal** — a reply is captured the instant `[FROM: …]` appears,
  with no stability timer. The app strips both tags and routes accordingly; a
  missing routing tag defaults to `USER` rather than vanishing. If a reply
  finishes with no `[FROM: …]` tag, it's treated as lost and the AI is
  auto-nudged (capped) to resend the whole message with the envelope. Explained
  to every AI automatically, once per launch, the moment its pane first loads.
- **Manual Compose & Forward** — type a message and send it to one, some,
  or all participants directly at any point; also how you interject on top
  of anything else running.
- **Auto / Auto-Both / mesh routing** — per-column toggles that turn on
  standing forward rules between panes, indefinitely, until paused or
  stopped.
- **Tag routing vs. mesh: no double-send** — when a mesh rule and an AI's
  own tag both point at the same target for one reply, tag routing wins for
  that target and mesh only forwards whatever's left. Fixed after this
  genuinely duplicated a delivery in a live session.
- **Role Assignment** — an optional persona per AI (e.g. "Skeptical
  Engineer") prepended to everything sent to it, however it's sent. Shapes
  what it contributes, never who it addresses.

## 3. House Rules

Eight structured formats you can lay on top of the baseline for a run — pick
one, hit Start, it drives itself and suspends tag-routing until you Stop.

| Format | What it does |
|---|---|
| **Who Wants to Speak?** | Each round, everyone's asked yes/no first — only the ones with something real get asked for it. |
| **Debate** | A shuffled, fixed speaking order; each speaker answers whoever went right before them. |
| **Free-for-All** | Open floor, no turn order, runs until stopped. |
| **Devil & Angel** *(needs all 3)* | One AI states a goal, one attacks it, one defends it — the attacker and defender never see each other. |
| **Chargeback** *(needs all 3 + rounds)* | Two AIs argue opposite sides directly; the third watches silently as Referee and delivers a verdict when rounds run out. |
| **Brainstorm** | Collaborative, not adversarial — click Wrap Up and one AI folds everything into a final plan. |
| **Rotation** *(needs all 3)* | Fixed ChatGPT→Claude→Gemini cycle; whoever isn't up yet gets a silent, swallowed "stay caught up" update instead of speaking out of turn. |
| **Blind Round** *(needs all 3)* | All three get the identical question at once and can't see anything — not even that the others answered — until all three are in. One-shot, ends itself after the reveal. |

- **Rate-limit protection** (`⚠ USAGE LIMIT`) — a usage-cap message is
  caught everywhere, not just during a House Rules run, and is never
  relayed onward as if it were a real reply.

## 4. Diagnostics

Ways to actually check whether the automation is working, instead of
guessing from the transcript.

- **🧪 Connectivity test** — sends a fresh one-off token and asks for it
  back *reversed*, then checks the reversed form arrived and the original
  did not, so a plain echo can't fake a pass. Reports one of four specific
  failure reasons: too broad, echo, mismatch, or timeout.
- **🎛️ The Tuner** — runs the connectivity test on all three sites, then
  genuinely tests all six directed relay pairs. Each leg asks one question
  that works for both hops (`RELAY-TEST` if answered directly,
  `RELAY-RECEIVED` if answered because it arrived via forward), so which
  one comes back proves whether the message actually got there. A failed
  leg names its exact stage: `source-send`, `source-reply`,
  `forward-send` (the internal relay hop itself never sent), or `relay`
  (it sent, target just never answered right).
- **🎯 Selector picker** — click Pick Input / Pick Send / Pick Reply, then
  click the real element live in the pane. The app works out a selector and
  validates it against the page in the same click before saving anything.

## 5. Saved Logins

Manual, on purpose — never auto-detected or auto-triggered.

- **🔑 One-click sign-in** — save multiple named credential profiles per
  site. Click one from the list and it fills whatever login fields are
  actually on screen and clicks sign in — nothing happens until you click.
- **Encryption** — passwords are encrypted via the operating system's own
  keychain (Keychain / DPAPI / libsecret) before they ever touch disk. The
  raw password is never written anywhere in plaintext, and the Activity Log
  records saves and fills by label only.

## 6. Prompt Tools

- **🧵 Prompt Sequence** — build a numbered list of prompts, each aimed at
  one AI or all three. Runs one step at a time, waiting for that step's
  real reply before sending the next. Each step is stamped with a
  generation number, so a late reply for a step already passed is
  recognized as stale and discarded.
- **Prompt Library** — saved, reusable prompts, one click to fire. Ships
  with a one-click System Test and the routing-explainer prompt, resendable
  any time.

## 7. Documents

- **📎 Attach Document** — pick a real file and preview it before sending.
  The file lands in each checked AI's chat as an actual upload, delivered
  via the Chrome DevTools Protocol — never typed in as a path.

## 8. The Manager

Phase 1, backend + IPC only — no panel in the UI yet. A supervisory layer
above everything else.

- **A fourth model, supervising the other three** — a separate model
  (RunPod, Ollama, LM Studio, or anything OpenAI-compatible) plans a task,
  delegates pieces to whichever of ChatGPT/Claude/Gemini fit, and saves
  results to a real project folder on disk.
- **Fixed action vocabulary** (18 actions) — CLASSIFY, PLAN, DELEGATE,
  SEND, COMPARE, VERIFY, SAVE, ESCALATE, WAIT, FINISH, and others; every
  decision is validated twice before anything executes.
- **Approval mode** — holds every proposed action for a real yes/no before
  it touches any AI's pane.

## 9. Workspace & Safety

- **Collapsing panes, zoom, pinning** — any column, the Transcript panel,
  or the whole window can shrink out of the way without stopping anything
  running behind it. Collapsed panes stay off-screen, never zero-size, so
  Chromium never throttles them into silently breaking. Each pane also
  zooms independently, 40%–200%.
- **Atomic state writes** — every save goes temp-file-then-rename, so a
  crash mid-write can't corrupt everything at once.
- **Bounded transcript** (cap 1,000) — the persisted transcript is capped
  and trimmed oldest-first on load.

---

A living document — this reflects what's actually shipped and tested as of
the most recent build, not what's planned (see `FUTURE_PLANS.md` for that).
