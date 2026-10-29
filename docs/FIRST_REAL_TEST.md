# First real test — step by step

Everything so far was tested with stand-in (fake) AIs. This is the checklist for the first test on your PC with the
real ChatGPT, Claude and Gemini. Tick each box; if something fails, stop there and send Claude the log
(AutoInjector → 📋 → **Extract: This book only**) plus a screenshot.

## 0. Get the newest version

- [ ] Download / pull the latest `main` (GitHub Desktop: **Fetch origin → Pull**). The repository is wherever
      you cloned it — often `Documents\git\AutoInjector` (or `Documents\GitHub\AutoInjector`); every path below
      (`desktop-app\…`, `akowe\…`) is inside that folder.
- [ ] Close any old AutoInjector and Akọwe windows first.

## 1. Start AutoInjector — Akọwe starts with it

- [ ] `desktop-app/run-windows.bat` → AutoInjector opens with the three AI panes. (One launcher: Akọwe starts by
      itself; you don't need `akowe/run-akowe.bat` any more — it is still there if you want Akọwe alone.)
- [ ] Log in to **ChatGPT, Claude and Gemini** inside their panes (each once).
- [ ] Click the **📖 Akọwe** tab at the top → Akọwe's workspace shows inside AutoInjector (the first start can
      take a minute or two while it prepares Python). If it says Python is missing: install Python 3.10+ from
      python.org (tick "Add python.exe to PATH"), then press **Try again**.
- [ ] The Akọwe panel in AutoInjector says **Connected** by itself — no Connect press (AI-1 Claude, AI-2 ChatGPT,
      AI-3 Gemini). If it doesn't: press **🔗 Connect Akọwe**.

## 2. Check each AI works (one at a time)

For **each** of ChatGPT, Claude, Gemini:

- [ ] Its card shows ✅ (not ⚠️). If ⚠️: read what it says (logged out / captcha / usage limit) and fix that first.
- [ ] Press **🎯** → choose **AI's reply** → **OK** → click the AI's latest answer. The chip turns **green** and shows
      the start of that answer → **Save** (chip shows ✓ Saved).
- [ ] Press **🔢 Do it for me with a number**: type the number it shows into that AI and press Send. It should ask
      the AI to write it backwards and end with **"✔ Saved — … is working again."**
- [ ] Press **Test it** → "answered the check-in and AutoInjector read it — it works."

If 🔢 fails on a part, it names the part (message box / Send button / reply area): use 🎯 for just that part.

## 3. The pre-run check (P37.5)

- [ ] In Akọwe press **⚡ Make a book**. Before it starts you should see the AI check:
      all three ✔ — or a plain notice naming the AI that isn't working, with **I fixed it — check again /
      Start without it / Cancel**.
- [ ] (Optional test) log out of one AI, press ⚡ again → the notice must name that AI and say "log in".

## 4. A short book

- [ ] Make a **short story** (fastest). Let it run; watch the run window.
- [ ] Nothing silently sits out: if an AI stops mid-run you see a ⚠️ notice in the run window, and "works again"
      when it comes back.
- [ ] The editor is tougher (P36): chapters should NOT all pass at 10/10. Look for "asked once more" or a
      ⚠️ flagged review in the run window — that is normal.

## 5. Look at the results

- [ ] **📊 Book report**: scores, 📖 Readability and pacing (reading level vs your audience), "How generous each AI
      reviewer is".
- [ ] **📘 Make my book** → scroll to the **bottom** → **🔎 Timeline, trade facts and repeats** (it shows once the
      characters and places are done; the book's own page also has a **🔎 Timeline, trade facts and repeats** button
      that opens Make my book and scrolls there): trade terms marked "research needed"; mark a couple
      ✔ Verified / ✕ Wrong. Character catchphrases show as *voice* (protected).
- [ ] **💾 Save** the book → a green **✔ Saved … just now** appears next to the button (and a message at the
      bottom); the folder has Book/, Chapters/, Book Bible/, Reports/, Log/.

## 6. Send back

- [ ] The book PDF, AutoInjector log (**This book only** — not "Everything"), and anything that looked wrong.

## Known gaps to watch

- Live ChatGPT/Claude/Gemini page layouts may differ from the built-in lists: that is what 🎯 / 🔢 are for.
  To help fix them for good, press 🎯 → **📋 Copy page structure** on that AI's pane (or run
  `desktop-app/tools/page-check.js` in that AI's DevTools Console — ChatGPT, Claude or Gemini) and send the
  result. It holds no message text.
- Gemini's split reply (P37.2) is only partly confirmed — tell Claude if a Gemini answer is cut short.
- The checks (readability, timeline, repeats) are English-only.
