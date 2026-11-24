# New step plan — "Play-by-play": the whole book, scene by scene, approved before any chapter is written (not started)

**The idea (the user's):** before the book is generated, one step lays out a play-by-play of what the book is
supposed to be: every chapter, scene by scene, in order. All rewrites happen there, on the plan, where they are
cheap. Only when the play-by-play is approved is the actual book written, and it follows the play-by-play.

## Where it goes

```
Section C — Planning the story
   8  Premise
   9  Main plot
  10  Chapter outline (+ 10.1 story doctor … 10.6 trade card)
  10A Play-by-play   ← NEW
Section D — Optional
  11  Fill the whole Book Bible
Section E — Writing
  12  Write every chapter   ← now follows the approved play-by-play
```
The existing part numbers stay the same; the new step is **10A**, so every stress-test ID and report stays valid.

## What the play-by-play is

One document for the whole book, chapter by chapter, scene by scene. Each scene says:
- **where and when**; **who is there** (only characters and places the book already has);
- **what happens** (the beat), in plain words;
- **each main character's goal**, the **obstacle**, **what changes** by the end, and **what stays unsaid**;
- which **outline beat / story-shape turning point** it delivers;
- which **promises** it plants or pays off (from the promise ledger);
- **who learns which secret** here (from the who-knows-what grid);
- a rough **length** (so the chapter lengths add up to the book's length).

This replaces the per-chapter scene cards being invented one chapter at a time: the existing scene cards
(`scenes.py`) are made from the approved play-by-play, so the writer, the editor and the planned-to-page check keep
working as they do now.

## How it works

1. **Draft.** The AI writes the play-by-play from the approved outline, characters, world rules and the plan checks,
   in batches of a few chapters at a time (so a 60-chapter novel isn't one giant answer).
2. **Akọwe's own checks (no AI):** every outline chapter and turning point covered; no undeclared character or place;
   every planted promise paid off before its last chapter; no secret used before it is learned; no two chapters or
   scenes the same; lengths add up; nothing new starting late in the book.
3. **Story checks on the whole play-by-play (AI):** the story doctor, the predictability probe and the AI-habit checks
   run here, on the whole book's events, instead of only on the outline. An independent AI reviews it like the outline.
4. **Rewrites happen here.** Every problem found in 2 and 3 goes back as a targeted revision of only the scenes
   concerned, then they are checked again (bounded rounds, the best version is kept).
5. **Approval.** You choose at the start of the book:
   - **"Show me the play-by-play first"**: the run pauses on a 📋 Play-by-play page. You read it, edit any scene, ask
     the AI to change a scene ("make chapter 7 darker", "the villain should win here"), and press ✔ Approve; or
   - **"Approve it for me"** (a ⚡ run's normal consent): it is approved once it passes the checks.
6. **Write the book.** Each chapter is written from its approved scenes; after each chapter the planned-to-page check
   confirms the scenes really reached the page (it already exists; it reads from the play-by-play).
7. **If you change the play-by-play later:** only the chapters whose scenes changed are rewritten (the "book never goes
   back" problem R2 is handled for this case).

## Why it helps the quality findings

Many quality problems found in the stress test are caught earlier, on the plan, before any prose exists:
- **duplicate chapters** (E-12.2-l) and **identical outline chapters** (C-10-l): refused in step 2;
- **promises / setups** (C-10.2, G-20-k): each plant and payoff has a scene, so a lost setup is visible and checkable;
- **secrets used too early** and **scope creep** (E-12.7): checked on the plan, not after the chapter is written;
- **ending without its checklist** (E-12.10-g): the ending's scenes are on the plan and approved;
- the **end rewrites** (opening / improve) check their result against the approved scenes (who, what, outcome), which
  is the guard against G-20-k and G-21-l.

## Cost and time

Roughly one AI answer per 3–4 chapters to draft, one review, and a few targeted revisions; for a short story about
3–5 answers, for a novel about 15–25. It saves more than it costs: the per-chapter scene-card calls move here, and
fewer chapters need rewriting later. It is counted in the run forecast. A run setting can switch it off (the book then
works as today).

## Never holds up the book (except when you asked to see it)

An AI that can't make the play-by-play in time → the book goes on the old way (scene cards per chapter), with a ⚠️ note
and a check-later line. Its own errors are caught. Pause / Resume / a restart continue where it stopped.

## How it will be built and tested

- New module `play_by_play.py` (draft, checks, revisions, storage with versions and history), the step `_s_playbyplay`
  in `autobook.py`, the 📋 Play-by-play page in the web app (and in the phone app's Full controls), `scenes.py`
  reading from it, `planned.py` checking against it, the run forecast, and the start-screen choice.
- Tests: a whole ⚡ run with it on (approved for me, and shown first with an edit and a "change this scene" request);
  every check in step 2; a later edit rewriting only the affected chapters; with it off the book is unchanged; plus a
  new stress-test section entry **C-10A** with the standard and out-of-the-box stresses.

## Order with the quality fixes

The play-by-play makes several quality fixes simpler, so the suggested order is:
1. **Play-by-play (10A)**;
2. then the quality fix batches Q1–Q4 from `FIX_PLAN_QUALITY.md`, using it where it fits.

Nothing is started; waiting for the go-ahead.
