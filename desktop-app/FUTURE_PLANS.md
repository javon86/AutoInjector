# Future Plans

Ideas for later — not built, not scheduled, not specced in detail. This is a
holding pen so they don't get lost, with a reference number on each one so a
future conversation can just say "let's do F-3" instead of re-explaining it.
Multi-part ideas get lettered sub-points (F-2a, F-2b, ...).

---

## F-1. Project template plugins (zip upload on a home screen)

A home screen with a button to upload a `.zip` file that configures the app
for a specific kind of collaborative project, instead of the user hand-
building the Prompt Library / roles / House Rules setup from scratch every
time.

Example given: upload a "book-writing" template zip, and the app sets up
whatever prompts and role assignments are needed for the three AIs to manage
producing a full document/book together — the prompts, the structure, and
"anything else needed for it" bundled into the zip rather than configured by
hand in the UI.

**Open question, needs deciding before this is buildable:** what actually
goes inside the zip (a manifest file plus prompt text? role assignments?
a House Rules format definition?) — there's no defined template format yet.

## F-2. All AI panes collapsible and dockable at the top — Compose is the exception

- **F-2a.** Every AI pane (ChatGPT, Claude, Gemini) should be collapsible,
  the same way individual panes already can be today, but applied uniformly
  across all of them.
- **F-2b.** When collapsed, they should pop up/dock at the top of the window
  like browser tabs, rather than (or in addition to) shrinking to a bar in
  place.
- **F-2c.** The one panel that should *not* collapse this way is the one the
  user sends direct commands through (Compose) — that one stays in place,
  since it's the main way you actually talk to the app.

## F-3. Merge the per-AI Auto/routing buttons into the Compose panel

Right now each AI's column has its own Forward / Auto / Auto→X buttons.
Consolidate those into the same panel where the user types and sends
messages (Compose), instead of having them spread across three separate
columns.

## F-4. Messages addressed directly to the user get their own notification

Right now a `[TO: USER]` message just shows up inline in the Transcript like
everything else — easy to miss in the middle of AI-to-AI back-and-forth.

- **F-4a.** Reword the routing instructions given to the AIs (the
  auto-sent routing-explainer prompt) so it's unambiguous when a message is
  meant for the user directly — something clearer/more explicit than the
  current `[TO: USER]` tag alone.
- **F-4b.** When the system recognizes one, it should still log it in the
  Transcript as normal (nothing lost).
- **F-4c.** *And* it should also surface as a distinct notification/popup —
  with a sound, like the chime that already plays on a captured reply — in
  the merged Compose/commands panel from F-3, so the user actually notices
  when an AI is talking to them specifically, not to another AI.

## F-5. Bring Claude Code and ChatGPT Codex into the app somehow

Not developed yet — flagged as something to think about later. No shape to
this one yet, just noting the idea exists.

## F-6. A shared document the AIs can hand off to each other

Something like a shared, collaboratively-edited document that one AI creates
or edits, then hands off to another (e.g., Claude picks up where ChatGPT
left off) — different from the existing 📎 Attach Document feature, which is
one-way (you send a file you already have *to* an AI). This would be the
AIs themselves generating/editing a document and passing it along.

## F-7. Voice playback controls

Buttons to play an AI's reply back as speech:
- Replay the last one.
- Keep track of all of them individually, per AI, so any past reply can be
  replayed on demand.
- A "play all three in sequence" button — one after another, not layered on
  top of each other.

Note: there's no voice/text-to-speech feature in AutoInjector today (the
existing "chime" is just a short notification sound on a captured reply,
not speech) — so this would be new, not a fix to something already there.
Flagging that in case a different, already-existing voice feature was
meant instead of this.
