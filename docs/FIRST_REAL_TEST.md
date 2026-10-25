# First real test — step by step

Everything so far was tested with stand-in (fake) AIs. This is the checklist for the first test on your PC with the
real ChatGPT, Claude and Gemini. Tick each box; if something fails, stop there and send Claude the log
(AutoInjector → 📋 → **Extract: This book only**) plus a screenshot.

## 0. Get the newest version

- [ ] Download / pull the latest `main` (GitHub Desktop: **Fetch origin → Pull**).
- [ ] Close any old AutoInjector and Akọwe windows first.

## 1. Start both apps

- [ ] `desktop-app/run-windows.bat` → AutoInjector opens with the three AI panes.
- [ ] Log in to **ChatGPT, Claude and Gemini** inside their panes (each once).
- [ ] `akowe/run-akowe.bat` → Akọwe opens in your browser.
- [ ] In AutoInjector press **Connect** next to Akọwe → Akọwe says it is connected (AI-1 Claude, AI-2 ChatGPT,
      AI-3 Gemini).

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
- [ ] Book page → **🔎 Timeline, trade facts and repeats**: trade terms marked "research needed"; mark a couple
      ✔ Verified / ✕ Wrong. Character catchphrases show as *voice* (protected).
- [ ] **💾 Save** the book → the folder has Book/, Chapters/, Book Bible/, Reports/, Log/.

## 6. Send back

- [ ] The book PDF, AutoInjector log (**This book only** — not "Everything"), and anything that looked wrong.

## Known gaps to watch

- Live ChatGPT/Claude/Gemini page layouts may differ from the built-in lists: that is what 🎯 / 🔢 are for.
  To help fix them for good, run `desktop-app/tools/chatgpt-page-check.js` in that AI's DevTools Console and send
  the result.
- Gemini's split reply (P37.2) is only partly confirmed — tell Claude if a Gemini answer is cut short.
- The checks (readability, timeline, repeats) are English-only.
