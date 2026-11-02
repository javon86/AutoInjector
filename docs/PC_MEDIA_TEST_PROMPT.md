# Prompt for the PC helper: one pictures & video test round

Copy everything below the line and give it to the AI that helps on the Windows PC.

---

Please run one test round of AutoInjector's pictures and video on this PC and send me the results. Steps:

1. **Update AutoInjector.** Open **GitHub Desktop**, choose the **AutoInjector** repository, press
   **Fetch origin**, then **Pull origin** (if it says there is nothing to pull, that is fine).
2. **Start it.** Close AutoInjector if it is open. Then double-click
   `C:\Users\javon\Documents\git\AutoInjector\desktop-app\run-windows.bat` and wait until the window is up.
3. **Start Forge** (Stability Matrix → Forge → Launch) if it is not running, and wait until it says
   "Running on local URL". In AutoInjector, 🎨 Images should say "✔ Connected to Forge".
4. **Run the test.** Click the **🎬 Video** tab → **🩺 Test pictures & video** → **▶ Full**.
   Leave "Unload FramePack afterwards" ticked. Do not tick the ChatGPT box unless I ask.
   Wait until the summary line appears ("🩺 Pictures & video self-test (Full, …)"). It takes a few minutes; the
   first FramePack load can take longer. Do not use the PC's graphics card for anything else meanwhile.
   If it seems stuck on one step for more than 20 minutes, press **⏹ Stop** (that is a result too).
5. **Take a screenshot of every ❌ step** (the red lines with "Exact error" and "What to try").
6. **Copy the report.** Press **📋 Copy report** and paste it into your reply. The same report is saved in
   `stuff and thing\logs\media-selftest-<date>-<time>.md` (and `.json`) — attach those two files if you can.
7. **Export the log.** In the main window press **⤓ Extract All** (the 📋 log export), choose **A time range → Last 24 hours**, then **⤓ Save**.
   **NEVER choose "Everything"** — it contains private documents and old conversations. Attach the saved file.
8. Send me: the pasted report, the two report files, the Extract file and the screenshots of any ❌.

Please do not change settings or install/download anything to "fix" a ❌ — the report already says what to try,
and I want to see the original result first.
