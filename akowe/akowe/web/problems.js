// The ONE table that turns every known problem code into plain words (R1-R3).
// Kernel codes (errors.py), provider/bridge answers, HTTP failures and "network down" all map here.
// Each entry: title (short, plain), what (what happened, in words a non-technical author understands),
// fix (concrete steps), action (the best button: retry | settings | form | open | reload | backup | none).

export const PROBLEMS = {
  // ---------------------------------------------------------------- kernel error codes (errors.py)
  MISSING_INPUT: { title: 'Something needed is missing', what: 'A required field or choice was left empty.', fix: 'Fill in the field marked ⚠️ and try again.', action: 'form' },
  INVALID_INPUT: { title: 'Something was not accepted', what: 'A value does not fit what this step expects.', fix: 'Look at the field marked ⚠️, correct it, and try again.', action: 'form' },
  NOT_FOUND: { title: 'It is not there any more', what: 'Akọwe could not find this item. It may have been replaced by a newer version or the page is out of date.', fix: 'Reload the page. If you followed a link, open the book from Your books.', action: 'reload' },
  VERSION_CONFLICT: { title: 'It changed in the meantime', what: 'Something changed while you were working (or another job is running), so Akọwe did not overwrite it.', fix: 'Reload to see the newest version, then try again. If a job is running, wait for it or pause it.', action: 'reload' },
  HASH_MISMATCH: { title: 'A file is damaged or changed', what: 'A stored file does not match its fingerprint, so Akọwe refused to use it.', fix: 'Make it again (for an exported book: press 📦 Export my book). If many files are affected, restore a backup in Settings.', action: 'retry' },
  PERMISSION_DENIED: { title: 'Not allowed', what: 'This action is not allowed here (for example an approval outside the run you started, or a missing access token).', fix: 'Open Akọwe from its start link and try again from the book you are working on.', action: 'reload' },
  UNSUPPORTED_CONTRACT: { title: 'Version mismatch', what: 'This request was made for a different version of Akọwe.', fix: 'Reload the page (Akọwe may have been updated).', action: 'reload' },
  UPSTREAM_UNAVAILABLE: { title: 'The AI cannot be reached', what: 'Akọwe could not reach the AI (for AutoInjector: the desktop app or the site’s window is not available).', fix: 'Start the AutoInjector desktop app, open and log in to the site’s pane, then press Test connection in Settings. Akọwe waits and retries busy AIs on its own.', action: 'settings' },
  CAPABILITY_UNAVAILABLE: { title: 'No AI is ready', what: 'No AI slot is connected (or the chosen one is not set up), so the AI could not do this.', fix: 'Open Settings and connect AutoInjector or add an API key. You can also write this step yourself.', action: 'settings' },
  TIMEOUT: { title: 'The AI did not answer in time', what: 'The AI took too long. Its answer may still arrive, so Akọwe does not try again on its own (that could cost twice).', fix: 'Check the AI’s window (AutoInjector: logged in and idle?), then press 🔁 Try again.', action: 'retry' },
  RATE_LIMITED: { title: 'The AI is busy', what: 'The AI is busy with other work right now.', fix: 'Akọwe waits and retries busy AIs automatically. If it keeps happening, wait a few minutes or pick another AI.', action: 'retry' },
  INTERNAL_ERROR: { title: 'Something went wrong inside Akọwe', what: 'Akọwe hit an unexpected problem. Nothing was lost.', fix: 'Press 🔁 Try again. If it keeps happening, press 📋 Copy diagnostics and send it to the developer.', action: 'retry' },
  IDEMPOTENCY_CONFLICT: { title: 'Already sent', what: 'This exact request was already sent with different content.', fix: 'Reload the page and try again.', action: 'reload' },
  EVENT_CONFLICT: { title: 'Duplicate event', what: 'An event with the same ID but different content was refused.', fix: 'Reload the page and try again.', action: 'reload' },
  APPROVAL_REQUIRED: { title: 'Needs your approval', what: 'This needs an explicit approval from you first.', fix: 'Press ✔ Approve (and confirm), or open it and press Accept.', action: 'open' },
  EXPIRED_APPROVAL: { title: 'The approval or code expired', what: 'An approval or one-time code is too old to use.', fix: 'Approve again (or press Connect in AutoInjector again for a new code).', action: 'retry' },
  LOCKED_FACT: { title: 'A protected fact', what: 'This would change a fact you marked as protected.', fix: 'Keep the protected fact as it is, or unprotect it in the record first.', action: 'open' },
  SPAN_CONFLICT: { title: 'The text moved', what: 'The text this change points at has changed since it was suggested.', fix: 'Make the edit again on the newest version of the chapter.', action: 'open' },
  PATCH_OVERLAP: { title: 'Two changes overlap', what: 'Two suggested changes touch the same words.', fix: 'Apply one of them, then make the other again.', action: 'open' },
  DEPENDENCY_CYCLE: { title: 'Circular links', what: 'These items depend on each other in a circle.', fix: 'Remove one of the links so they no longer point at each other.', action: 'form' },
  LEASE_EXPIRED: { title: 'The job took too long', what: 'A background job lost its turn because it took too long.', fix: 'Press 🔁 Try again.', action: 'retry' },
  QUOTA_EXCEEDED: { title: 'Budget reached', what: 'The cost or usage limit for this project was reached.', fix: 'Raise the limit in Project Control (K12), or wait until it resets.', action: 'open' },
  CONTEXT_TOO_LARGE: { title: 'Too much for the AI at once', what: 'The material sent to the AI is larger than it can read at once.', fix: 'Pick fewer context records, or choose an AI with a larger limit in Settings.', action: 'settings' },
  VALIDATOR_UNAVAILABLE: { title: 'A checker is missing', what: 'An external checking tool (for example EPUBCheck) is not installed, so this check is UNKNOWN.', fix: 'Install the tool if you need this check, or ignore it for drafts.', action: 'none' },
  TOC_NONCONVERGENCE: { title: 'Contents did not settle', what: 'The table of contents page numbers kept changing.', fix: 'Press 🔁 Try again; if it repeats, change the page or font settings slightly.', action: 'retry' },

  // ---------------------------------------------------------------- Akọwe app codes
  NOT_APPLICABLE: { title: 'Switched off for this book', what: 'This step belongs to a feature that is off for this book.', fix: 'Turn the feature on in 🎛️ Book features, or skip this step.', action: 'open' },
  REVIEW_NOT_PASSED: { title: 'The AI reviewer is not happy yet', what: 'The AI reviewer still asks for changes after two AI fixes.', fix: 'Decide: ✔ Approve anyway (your own approval), ✏️ Edit it yourself and continue, or 🔁 Try again (two more AI fixes).', action: 'retry' },
  INTERRUPTED: { title: 'Interrupted', what: 'Akọwe was closed or restarted while this was running.', fix: 'Press ▶ Resume to continue where it stopped.', action: 'retry' },
  CANCELLED: { title: 'Cancelled', what: 'You stopped this.', fix: 'Start it again when you are ready.', action: 'retry' },
  SITE_NOT_READY: { title: 'An AI is being repaired', what: 'AutoInjector says this AI’s window is not working right now (it is being repaired, needs you, or is broken).', fix: 'Akọwe sends the work to the AIs that work and uses this one again when it works. If it says it needs you, open AutoInjector and look at that AI’s window.', action: 'settings' },
  AI_MOVED: { title: 'Work moved to another AI', what: 'One AI was not working, so Akọwe gave this step to another AI that works.', fix: 'Nothing to do. Akọwe uses the first AI again when it works.', action: 'none' },
  REVIEW_NOT_INDEPENDENT: { title: 'Reviews are not independent', what: 'Only one AI worked, so the same AI wrote and reviewed this draft. A second opinion catches more.', fix: 'Fix the other AIs in AutoInjector (or connect another AI in Settings); later reviews then use a different AI. You can also read the draft yourself.', action: 'settings' },
  EDITOR_NOTES: { title: 'The editor still had notes', what: 'The AI editor still found things to improve after its rewrite rounds (or its rewrite was not kept). The chapter was approved under your Make-a-book consent so the book was not held up.', fix: 'Open the chapter: read the editor’s notes and press ✍ Apply editor’s fixes, or change it yourself. You can also raise “Editor rounds” in Settings.', action: 'open' },
  EDITOR_FAILED: { title: 'The editor could not read it', what: 'The AI editor did not give a usable answer (or the writer could not rework the notes), so this part went on without the editor’s opinion.', fix: 'Open the chapter and press 🖋 Editor review to try again.', action: 'open' },
  EDITOR_UNTRUSTED: { title: 'The editor’s review was too clean to trust', what: 'The AI editor gave near-perfect scores without quoting proof or naming enough problems — even after Akọwe asked it once more with a stricter prompt. Its unproven scores count as 7 and, when nothing was left to fix, Akọwe’s own pattern notes were added so the rewrite could still run.', fix: 'Open the chapter’s 🖋 Editor card: read “Each editor’s own scores”. When another AI works, a second editor reads too (the lower score counts). The 📊 Book report shows how generous each AI is.', action: 'open' },
  EDITOR_REASKED: { title: 'The editor was asked for proof', what: 'The AI editor’s first review gave near-perfect scores without quotes, so Akọwe asked once more with a stricter prompt. Its second answer is the one used.', fix: 'Nothing to do.', action: 'none' },
  AI_NOT_READY: { title: 'An AI isn’t working', what: 'Akọwe asked AutoInjector before the run: this AI is logged out, blocked, at its usage limit, being repaired or not reachable. The other AIs do its work meanwhile.', fix: 'Open AutoInjector and fix it (log in, complete the check, or press 🔢 Fix with a number / 🎯 on its card). Akọwe uses it again as soon as it works.', action: 'settings' },
  AI_STOPPED: { title: 'An AI stopped working during the run', what: 'This AI worked when the run started but stopped answering (AutoInjector says it is logged out, blocked, at a limit, being repaired or broken). Its work goes to the other AIs meanwhile; nothing was lost.', fix: 'Open AutoInjector and fix it (log in, complete the check, or press 🔢 Fix with a number / 🎯 on its card). Akọwe uses it again as soon as it works.', action: 'settings' },
  AI_SKIPPED: { title: 'You started without an AI', what: 'Before the run you chose to start without an AI that wasn’t working. The other AIs do its work.', fix: 'Fix it in AutoInjector whenever you like: Akọwe uses it again as soon as it works.', action: 'none' },
  AI_BACK: { title: 'An AI works again', what: 'An AI that was not working answers again, so Akọwe uses it again.', fix: 'Nothing to do.', action: 'none' },
  EDITOR_REWRITE_REJECTED: { title: 'The rewrite was not kept', what: 'The writer reworked the flagged passages, but the result was not better (lower scores, lost a passage to keep, or the consistency reviewer objected), so the earlier text is used.', fix: 'Nothing to do. Read the editor’s notes on the chapter page if you want to change it yourself.', action: 'open' },
  SCENES_NOTES: { title: 'The scene checker still had notes', what: 'An AI checked the scene cards of this chapter (does every scene have a goal for every character, a real obstacle from the world and something unsaid?) and still had notes after two reworks. The cards were used as they are so the book was not held up.', fix: 'Open the chapter’s 🎬 scene cards: read the checker’s notes, change the cards yourself, or press ✨ Plan again with AI.', action: 'open' },
  SCENES_FAILED: { title: 'The scenes could not be planned', what: 'The AI’s scene plan for this chapter could not be made or checked (no usable answer), so the chapter was written from the outline alone.', fix: 'Open the chapter’s 🎬 scene cards and press ✨ Plan the scenes with AI, or write the cards yourself. The next time the chapter is written the writer follows them.', action: 'open' },
  SCENES_OUT_OF_DATE: { title: 'The scene cards are for an older outline', what: 'The chapter outline changed after these scene cards were made, so the writer does not use them any more.', fix: 'Open the chapter’s 🎬 scene cards and plan them again (✨ with AI or by hand).', action: 'open' },
  CHARACTER_SHEET_FAILED: { title: 'A character sheet could not be made', what: 'The AI did not give a usable character sheet and voice card for this character, so the book went on without them (the writer knows less about how this character talks).', fix: 'Open the character’s page and press ✨ Write the sheet and voice with AI, or fill them in yourself.', action: 'open' },
  PROTAGONIST_MISSING: { title: 'A main character is missing', what: 'A main character — named in your book idea, proposed as the main character, or needed as a viewpoint by the chapter outline — is not one of your approved characters. Without them the outline cannot give them their chapters, so the writer and the editor lose track of who the story is about.', fix: 'Press ✨ Make it (the AI makes the character and is told exactly what Akọwe refused before), or write the character yourself under Characters and places. Then approve it and make the chapter outline.', action: 'retry' },
  CANON_ENTRY_REFUSED: { title: 'A character or place was refused', what: 'Akọwe’s checks refused an entry the AI proposed (it did not fit the form, or a fact in it could not be saved). The AI was asked to make it again, told exactly what was wrong; an entry that still failed is named here.', fix: 'Nothing to do if the book went on. To add it yourself, open Characters and places and press ✍️ Write one myself (or ✨ Make up characters).', action: 'open' },
  CHARACTER_SHEET_MISSING: { title: 'No sheet or voice card yet', what: 'This character has no character sheet or voice card yet, so the writer cannot give them their own way of talking.', fix: 'Press ✨ Write the sheet and voice with AI, or fill in the fields yourself and press 💾 Save.', action: 'open' },
  // ---------------------------------------------------------------- Section 4: story rules, world texture, planned to page
  RULES_FAILED: { title: 'The story rules could not be made', what: 'The AI did not give a usable story-rules ledger (or its update for the plan), so the book went on without it (or with the earlier rules).', fix: 'Open 🌍 Story rules and world on the book page and press ✨ Draft with AI, or write the rules yourself.', action: 'open' },
  RULES_OUT_OF_DATE: { title: 'The story rules may be out of date', what: 'The characters and places or the premise, plot or outline changed since the story rules were made.', fix: 'Open 🌍 Story rules and world and press ✨ Suggest updates: the AI suggests changes you accept or reject one by one.', action: 'open' },
  RULE_NOT_BOUNDED: { title: 'A rule is not bounded', what: 'This rule (or an exception in it) has no limits: the story could use it for anything — a special object, power or exception that solves problems whenever needed.', fix: 'Fill in “Scope and limits”: where and when it works, how often, at what cost, and what it can never do.', action: 'open' },
  TEXTURE_FAILED: { title: 'The world-texture list could not be made', what: 'The AI did not give a usable list of world details, so scenes took their obstacles from the canon alone.', fix: 'Open 🌍 Story rules and world and press ✨ Draft with AI, or add the details yourself.', action: 'open' },
  TEXTURE_UNUSED: { title: 'A world detail is never used', what: 'This detail of the world-texture list does not appear in any chapter (Akọwe counted its words).', fix: 'Use it where it can cause something (an obstacle, a skill moment, a cost), or remove it from the list.', action: 'open' },
  TEXTURE_OVERUSED: { title: 'A world detail is used too often', what: 'This detail appears so often that it turns into decoration.', fix: 'Keep it where it causes something, shows skill or gets in the way; cut the repeats and use other details of the list.', action: 'open' },
  PLANNED_MISSING: { title: 'Planned but not on the page', what: 'Something the plan says must reach the reader (an outline beat, a scene’s obstacle or change, a name or a “must show” detail) is not in the chapter text. In a Make-a-book run the chapter was approved anyway so the book was not held up.', fix: 'Open the chapter: the ✅ Planned to page list shows what is missing. Press ✨ Fix with AI (the writer works it into the right passage; you choose and save), or add it yourself.', action: 'open' },
  PLANNED_CHECK_FAILED: { title: 'The planned-to-page check did not work', what: 'The AI checker gave no usable answer, so only Akọwe’s own word check was used.', fix: 'Open the chapter and press 🔎 Check again with AI.', action: 'open' },
  PLANNED_UNRESOLVED: { title: 'The planned details could not be worked in', what: 'The writer’s changes did not match the chapter word for word, so nothing was changed (Akọwe never guesses).', fix: 'Open the chapter and press ✨ Fix with AI again, or add the missing details yourself.', action: 'open' },
  PLANNED_FIX_REJECTED: { title: 'The fix for planned details was not kept', what: 'The writer worked the missing details in, but the reviewer did not pass the new text (or nothing improved), so the earlier text is used.', fix: 'Open the chapter and press ✨ Fix with AI, or add the missing details yourself.', action: 'open' },
  // ---------------------------------------------------------------- 🗂 B5 Character Forge: pictures through AutoInjector
  SD_NOT_CONNECTED: { title: 'Stable Diffusion is not connected', what: 'AutoInjector has no Stable Diffusion app connected, so it could not make the picture.', fix: 'Open AutoInjector → 🎨 Images and connect your Stable Diffusion app (Forge, A1111 or ComfyUI), or press 💬 ChatGPT instead.', action: 'retry' },
  CHATGPT_NOT_READY: { title: 'ChatGPT is not ready', what: 'The ChatGPT pane in AutoInjector is missing or logged out, so it could not make the picture.', fix: 'Open AutoInjector, open the ChatGPT pane and log in, then press 🔁 Try again.', action: 'retry' },
  IMAGE_REFUSED: { title: 'ChatGPT declined the picture', what: 'ChatGPT would not make this picture (its short reason is shown).', fix: 'Change the appearance text (nothing that reads as a real person, gore or violence), then try again — or use Stable Diffusion, or upload your own picture.', action: 'retry' },
  IMAGE_TIMEOUT: { title: 'The picture took too long', what: 'No picture came back in time (a ChatGPT picture takes 1–3 minutes; the first Stable Diffusion picture after a start loads the model).', fix: 'Press 🔁 Try again. The pictures made before are kept.', action: 'retry' },
  IMAGE_LIMIT: { title: 'The picture limit is reached', what: 'ChatGPT says its picture limit for now is used up.', fix: 'Wait until ChatGPT allows pictures again, or use Stable Diffusion, or upload your own picture.', action: 'retry' },
  NO_IMAGE_ENGINE: { title: 'No picture maker is available', what: 'Neither Stable Diffusion nor the ChatGPT pane is available in AutoInjector.', fix: 'Connect Stable Diffusion in AutoInjector → 🎨 Images, or open and log in to the ChatGPT pane. You can always upload your own picture.', action: 'retry' },
  IMAGE_BRIDGE_UNREACHABLE: { title: 'AutoInjector cannot be reached', what: 'Akọwe could not reach AutoInjector to ask for the picture.', fix: 'Start the AutoInjector desktop app (its bridge must be on). The address and key are in Settings → 🎨 Pictures.', action: 'settings' },
  IMAGE_BRIDGE_KEY: { title: 'AutoInjector did not accept the key', what: 'AutoInjector refused the picture request because the bridge key is missing or wrong.', fix: 'In AutoInjector copy the bridge token, then paste it into Akọwe Settings → 🎨 Pictures.', action: 'settings' },
  IMAGE_NOT_WIRED: { title: 'This AutoInjector cannot make pictures', what: 'The AutoInjector that answered has no picture module.', fix: 'Update AutoInjector to a version with 🎨 Images, or upload your own pictures.', action: 'none' },
  IMAGE_BAD_ANSWER: { title: 'No usable picture came back', what: 'AutoInjector answered, but without a picture Akọwe can store (PNG or JPEG).', fix: 'Try again. If it repeats, make the picture in AutoInjector and upload it here.', action: 'retry' },
  NO_LOCK: { title: 'No character lock', what: 'AutoInjector has no character lock with this name.', fix: 'Make one in AutoInjector → 🎨 Images → 🔒 Character locks (Akọwe also tries without one).', action: 'none' },
  // ---------------------------------------------------------------- Section 7a: timeline, trade facts, repeats (P26/P30/P31)
  TIMELINE_PROBLEMS: { title: 'Ages or years do not add up', what: 'Akọwe read the ages and years in the chapters and some do not agree (two ages for one person, someone getting younger, a birth year plus an age that is not the story’s year).', fix: 'Open the book page → 🔎 Timeline, trade facts and repeats: each problem quotes the sentences. Decide the right number and change the others.', action: 'open' },
  TERMS_WRONG: { title: 'A wrong or out-of-place term', what: 'A chapter uses a term you marked wrong, equipment that does not fit (a wick on a gas lamp) or a word from a later time than the story.', fix: 'Open the chapter → 🔎 Timeline, trade facts and repeats → ✨ Fix the wrong terms with AI, or change the words yourself.', action: 'open' },
  TERMS_RESEARCH_NEEDED: { title: 'Trade facts not verified yet', what: 'Equipment, procedures and period words stay “research needed” until you have checked them. A run never verifies them for you.', fix: 'Open the book page → 🔎 Timeline, trade facts and repeats. Check each term (🤖 an AI can suggest an answer) and mark it ✔ Verified or ✕ Wrong.', action: 'open' },
  REPEATS_TO_TRIM: { title: 'Repeats that could be trimmed', what: 'Some phrases come back by accident (or too often). Voice and motif repeats are kept on purpose.', fix: 'Open a chapter → 🔎 Timeline, trade facts and repeats → ✨ Trim accidental repeats with AI. Relabel a phrase if Akọwe sorted it wrongly.', action: 'open' },
  FACTS_CHECK_FAILED: { title: 'The fact checks did not run', what: 'Akọwe could not finish the timeline, trade-facts and repeat checks at the end of the run (the book itself is fine).', fix: 'Open the book page → 🔎 Timeline, trade facts and repeats to run them again.', action: 'open' },
  // ---------------------------------------------------------------- Section 5: book report, compare, longer books
  REPORT_FAILED: { title: 'The book report could not be made', what: 'Akọwe could not finish the book report at the end of the run (the book itself is made and its files are ready).', fix: 'Open the book’s 📊 Book report page and press 📊 Make the report.', action: 'open' },
  REPORT_NOT_INDEPENDENT: { title: 'No independent AI read the whole book', what: 'Only the AI that wrote most of the book was working (or none), so no other AI reviewed the whole book. A writer grading its own book is not an independent opinion.', fix: 'When another AI works (AutoInjector: log in to its window), open 📊 Book report and press 📨 Ask the other AIs to review this book.', action: 'open' },
  REPORT_DISAGREE: { title: 'The reviewers disagree', what: 'The AIs that read the whole book are 3 or more points apart on this dimension, so the median is uncertain.', fix: 'Read each reviewer’s notes on it. Ask one more AI (📨) for a tie-breaker, or judge it yourself.', action: 'none' },
  REPORT_STALE: { title: 'The report is for an older version', what: 'A chapter changed (or was approved) since this report was made, so its numbers describe the earlier version.', fix: 'Press 📊 Make a new report.', action: 'retry' },
  QUOTE_NOT_FOUND: { title: 'Quote not found in the book', what: 'The AI quoted a passage as evidence, but Akọwe could not find it word for word in the book: the AI may have paraphrased or misremembered.', fix: 'Treat this point with care, or search the chapter for the words yourself.', action: 'none' },
  // ---------------------------------------------------------------- Section 7c: P23 beta reader, P25 your writing style
  BETA_FAILED: { title: 'The beta reader could not read the book', what: 'The AI beta reader did not give a usable answer (or no AI was working), so there is no beta read this time. The book itself is fine.', fix: 'Open the 📊 report page and press 📖 Ask a beta reader (pick another AI if one keeps failing).', action: 'retry' },
  BETA_NOTES: { title: 'The beta reader had problems with the book', what: 'The AI that read the book as its target reader got lost, bored, guessed a twist early or would not finish it.', fix: 'Open the 📊 report page: the 📖 Beta reader card lists the chapters, with quotes.', action: 'open' },
  STYLE_APPLIED: { title: 'Written in your style', what: 'This book’s narration follows your style card (✒️ My writing style).', fix: 'Nothing to do. Switch it off for this book on ✒️ My writing style.', action: 'none' },
  STYLE_MISSING: { title: 'No style card yet', what: 'You asked for the book to be written in your own style, but there is no style card yet, so it was written without one.', fix: 'Open ✒️ My writing style (More menu), paste a few samples of your writing and press 💾 Save and count; then tick the book there.', action: 'open' },
  STYLE_FAILED: { title: 'The AI could not describe your style', what: 'The AI did not give a usable description of your samples. The numbers Akọwe counted itself are kept and already used.', fix: 'Press ✨ Learn my style with AI again (another AI may answer better).', action: 'retry' },
  COMPARE_NOT_INDEPENDENT: { title: 'The comparison is not independent', what: 'Every AI that compared the two versions also wrote one of them, and an AI may prefer its own writing.', fix: 'Compare again when an AI that wrote neither version works (choose it under Which AIs).', action: 'retry' },
  COMPARE_FAILED: { title: 'An AI could not compare the versions', what: 'This AI gave no usable answer (or was not working), so it is left out of the table.', fix: 'Press 🔁 Compare again, or choose other AIs.', action: 'retry' },
  // ---------------------------------------------------------------- Section 6: 💾 save the book (P20), 📂 open / 🔁 rerun (P21)
  SAVE_FAILED: { title: 'The book could not be saved', what: 'Akọwe could not write the book’s folder this time. Your book is safe inside Akọwe; only the copy in your books folder is not up to date.', fix: 'Press 💾 Save again. If it keeps failing, press 📋 Copy diagnostics and send it to the developer.', action: 'retry' },
  SAVE_FOLDER_NOT_WRITABLE: { title: 'Akọwe may not write into the books folder', what: 'The folder where books are saved does not exist any more, is read-only, or belongs to someone else (for example a removed USB stick or a protected system folder).', fix: 'Open Settings › 📁 Where books are saved and choose another folder (for example your Documents folder), then press 💾 Save again.', action: 'settings' },
  SAVE_PATH_TOO_LONG: { title: 'The folder path is too long', what: 'Windows allows file paths of only about 200–260 characters. The books folder, the book’s folder and its file names together would be longer.', fix: 'Choose a books folder with a shorter path in Settings › 📁 Where books are saved (for example C:\\Books), then press 💾 Save again.', action: 'settings' },
  SAVE_DISK_FULL: { title: 'The disk is full', what: 'There is no free space left on the disk with the books folder, so the book could not be saved there.', fix: 'Free some space (empty the Recycle Bin, delete large files you do not need), or choose a books folder on another disk in Settings, then press 💾 Save again.', action: 'settings' },
  OPEN_NOT_LOCAL: { title: 'Only on the computer Akọwe runs on', what: 'Folders can only be listed and shown on the computer where Akọwe itself runs (you are using Akọwe from another device).', fix: 'Copy the folder path shown here and open it on that computer, or upload the book.akowe file instead.', action: 'none' },
  OPEN_FAILED: { title: 'The book could not be opened', what: 'Something went wrong while Akọwe opened the saved book. Nothing was changed: your other books are untouched.', fix: 'Press 📂 Open a saved book and try again. If it keeps failing, press 📋 Copy diagnostics.', action: 'retry' },
  OPEN_BAD_PACKAGE: { title: 'This is not a usable saved book', what: 'The file is not an Akọwe book (book.akowe), or it is damaged: a checksum does not match or a part is missing (for example it was not copied completely).', fix: 'Use the book.akowe file exactly as Akọwe saved it — copy the whole book folder again — then try again.', action: 'none' },
  OPEN_NEWER_VERSION: { title: 'Saved by a newer Akọwe', what: 'This book (or book bible) was saved by a newer version of Akọwe, which this version cannot read safely.', fix: 'Update Akọwe on this computer to the newest version, then open the book again.', action: 'none' },
  OPEN_TOO_LARGE: { title: 'The file is too large to upload', what: 'This saved book is larger than an upload may be.', fix: 'Copy the book’s whole folder into your books folder (Settings › 📁 Where books are saved) and open it from the list instead.', action: 'none' },
  OPEN_NOT_FOUND: { title: 'The saved book is not there', what: 'The folder (or the uploaded book bible) Akọwe was asked to open is not there any more — it may have been moved, renamed or deleted.', fix: 'Press 🔄 Refresh in 📂 Open a saved book, or check Settings › 📁 Where books are saved.', action: 'reload' },
  BIBLE_BAD: { title: 'This book bible cannot be used', what: 'The book-bible.json is not an Akọwe book bible, or a part of it is not readable (for example after editing it by hand a comma or quote is missing).', fix: 'Use the book-bible.json from a saved book’s “Book Bible” folder. If you edited it, check it in a JSON checker and fix the marked line.', action: 'none' },
  BIBLE_RERUN: { title: 'Made from a saved book bible', what: 'This run makes a NEW book from a saved book bible. Its characters, places, rules and texture (and the plan, when kept) come into the new book as drafts; each one is reviewed and approved there under your consent for this run.', fix: 'Nothing to do. The book the bible came from is not changed.', action: 'none' },
  BIBLE_ENTRY_REFUSED: { title: 'Part of the book bible was not used', what: 'Akọwe’s checks refused an entry of the book bible in the new book (for example it refers to something that is not there), so the AI made what was missing instead.', fix: 'Nothing to do; read the new book’s characters and world. To keep it exactly, fix the entry in book-bible.json and rerun.', action: 'none' },
  BIBLE_PLAN_REFUSED: { title: 'The saved plan was not used', what: 'The premise, main plot or outline of the book bible did not pass Akọwe’s checks in the new book (for example a different number of chapters), so the AI wrote a new one.', fix: 'Nothing to do. To keep the saved plan, make the length and chapter count the same as in the saved book.', action: 'none' },
  BOOK_TOO_SHORT: { title: 'The book is much shorter than planned', what: 'The written chapters together have far fewer words than the length chosen in the book profile.', fix: 'Rewrite chapters longer (🔁 Redo with AI — the writer now gets a word target per chapter and continues a chapter that comes back far too short), or choose a shorter length in the book profile.', action: 'open' },
  CHAPTER_UNDER_TARGET: { title: 'This chapter is far under its target', what: 'The chapter has much fewer words than its target (the book’s length divided by its chapters). The writer was asked to continue it within the scene plan, but the result is still short.', fix: 'Press 🔁 Redo with AI, or add scenes yourself. Never pad: more goals, obstacles and consequences, not more description.', action: 'open' },
  LENGTH_EXPAND_FAILED: { title: 'The chapter could not be continued', what: 'The chapter came back far under its word target and the writer’s continuation failed (no usable answer), so the chapter was kept as written.', fix: 'Nothing is lost. Redo the chapter with AI later, or extend it yourself.', action: 'open' },
  EDITOR_UNRESOLVED: { title: 'A fix did not match the text', what: 'The writer’s change did not quote the chapter word for word (or would have removed a passage to keep), so Akọwe did not guess where it belongs.', fix: 'Ask the writer again (✍ Apply editor’s fixes), or change that passage yourself.', action: 'open' },
  SITE_BUSY: { title: 'The AI site is busy', what: 'The AI’s web window is busy with another request.', fix: 'Akọwe waits and retries automatically. Keep the AutoInjector window open.', action: 'retry' },
  STALE: { title: 'Out of date', what: 'Something this was built from has changed, so it needs a new version.', fix: 'Open it and make a new version (✏️ Edit, or ask the AI to redo it).', action: 'open' },
  BLOCKED: { title: 'Waiting for an earlier step', what: 'This step needs an earlier step to be done (and approved) first.', fix: 'Do the earlier step first; the checklist shows which one.', action: 'none' },
  REJECTED: { title: 'Not accepted', what: 'Akọwe’s checks did not accept this.', fix: 'Open it to see the checks, fix what they say, and try again.', action: 'open' },
  FAILED: { title: 'It did not work', what: 'This step did not finish.', fix: 'Press 🔁 Try again.', action: 'retry' },

  // ---------------------------------------------------------------- network and HTTP
  NETWORK: { title: 'Akọwe is not answering', what: 'The page could not reach the Akọwe program on this computer.', fix: 'Check that the Akọwe window is still open (start it again with run-akowe if it closed), then press 🔁 Try again.', action: 'retry' },
  HTTP_400: { title: 'Something was not accepted', what: 'Akọwe refused the request.', fix: 'Check the fields marked ⚠️ and try again.', action: 'form' },
  HTTP_401: { title: 'Open Akọwe from its start link', what: 'This page has no valid access token.', fix: 'Open the link shown in the Akọwe window (or its desktop shortcut).', action: 'reload' },
  HTTP_403: { title: 'Not allowed', what: 'You do not have access to this.', fix: 'Open the book from Your books.', action: 'reload' },
  HTTP_404: { title: 'Not found', what: 'This page or item does not exist (any more).', fix: 'Go back to Your books and open it again.', action: 'reload' },
  HTTP_409: { title: 'Busy or changed', what: 'Something else is running or the item changed.', fix: 'Wait a moment and try again.', action: 'retry' },
  HTTP_413: { title: 'Too large', what: 'The file or text is too large.', fix: 'Use a smaller file.', action: 'form' },
  HTTP_429: { title: 'Busy', what: 'Too many things are running at once.', fix: 'Wait a moment and try again.', action: 'retry' },
  HTTP_500: { title: 'Something went wrong inside Akọwe', what: 'Akọwe hit an unexpected problem (details are in its window).', fix: 'Press 🔁 Try again. If it keeps happening, press 📋 Copy diagnostics.', action: 'retry' },
  HTTP_502: { title: 'The AI bridge is not available', what: 'A helper program did not answer properly.', fix: 'Check AutoInjector, then try again.', action: 'settings' },
  HTTP_503: { title: 'Not available right now', what: 'A service is temporarily unavailable.', fix: 'Wait a moment and try again.', action: 'retry' },
  BROWSER: { title: 'The page hit a problem', what: 'Something unexpected happened in this page.', fix: 'Reload the page. If it keeps happening, press 📋 Copy diagnostics.', action: 'reload' },
};

// ---------------------------------------------------------------- AutoInjector site problems (bridge v1.2 "problem")
// Why an AI's window is not working, as AutoInjector reports it in /v1/health and SITE_NOT_READY answers.
export const SITE_PROBLEMS = {
  // the codes AutoInjector's self-repair reports (desktop-app/self-repair.js, P18.2)
  TYPE_FAILED: 'message box could not be found or typed into — AutoInjector is trying other ways',
  SEND_NOT_CONFIRMED: 'message was typed but did not go out — AutoInjector is looking for the Send button',
  NO_REPLY_FOUND: 'answered, but the answer was not found on the page — AutoInjector is looking for it',
  FALSE_DUPLICATE: 'gave a new answer that was mistaken for an old one — AutoInjector is fixing the check',
  STUCK_GENERATING: 'seems stuck while writing — AutoInjector is unfreezing it',
  LOGGED_OUT: 'is logged out — log in to it in AutoInjector',
  CAPTCHA: 'shows an “are you human?” check — complete it in AutoInjector',
  USAGE_LIMIT: 'reached its usage limit — wait until it resets (AutoInjector checks again by itself)',
  NETWORK_ERROR: 'page did not load (no internet, or the site is down)',
  PAGE_ERROR: 'page shows an error (“something went wrong”) — AutoInjector is reloading it',
  UNKNOWN: 'did not answer a check-in and AutoInjector could not tell why',
  // older / other names
  SIGNED_OUT: 'is logged out — log in to it in AutoInjector',
  RATE_LIMIT: 'says “too many requests” — it waits a little',
  TYPING_FAILED: 'message box could not be found or typed into — AutoInjector is trying other ways',
  SEND_FAILED: 'could not get the message sent — AutoInjector is trying other ways',
  INPUT_NOT_FOUND: 'message box was not found on the page — AutoInjector is looking for it',
  REPLY_NOT_FOUND: 'answered, but the answer was not found on the page — AutoInjector is looking for it',
  PANE_NOT_READY: 'window is not open or not loaded — open it in AutoInjector',
  NEEDS_TEACHING: 'needs to be shown where to type and read — use “Teach” in AutoInjector',
};
/** Plain words for a site problem code ("LOGGED_OUT" -> "is logged out — log in to it in AutoInjector"). */
export function siteProblemWords(code) {
  if (!code) return '';
  const c = String(code).toUpperCase();
  return SITE_PROBLEMS[c] || `has a problem AutoInjector calls “${c.replace(/_/g, ' ').toLowerCase()}”`;
}
/** One AI's state in plain words + icon: state ok|repairing|needs_user|broken|checking|unknown. */
export const AI_STATE = {
  ok: ['✔', 'working', 'b-ok'], repairing: ['🔧', 'being repaired', 'b-warn'], needs_user: ['⚠️', 'needs you', 'b-bad'],
  broken: ['⚠️', 'not working', 'b-bad'], checking: ['⏳', 'being checked', 'b-info'], unknown: ['○', 'not checked yet', 'b-muted'],
};

const FALLBACK = { title: 'Something went wrong', what: 'Akọwe could not finish this.', fix: 'Press 🔁 Try again. If it keeps happening, press 📋 Copy diagnostics.', action: 'retry' };

/** Plain words for a code (falls back to the HTTP status, then a generic entry). */
export function problemFor(code, status) {
  if (code && PROBLEMS[code]) return PROBLEMS[code];
  if (status && PROBLEMS[`HTTP_${status}`]) return PROBLEMS[`HTTP_${status}`];
  if (status >= 500) return PROBLEMS.HTTP_500;
  return FALLBACK;
}

// ---------------------------------------------------------------- check findings ("RULE_ID: message" strings)
// What Akọwe's checks say about a draft (book path `problems`, refused approvals), in plain words. The raw
// rule text stays available behind 🔧 Details; this table only decides what the author reads.
const PART = { chapters: 'Chapter', scenes: 'Scene', events: 'Event', main_plot: 'The main plot', arcs: 'Arc' };
const WHAT = {
  'plan.location_id': ['place', 'one of your book’s places'], 'plan.pov_id': ['point-of-view character', 'one of your characters'],
  'plan.character_ids': ['character', 'one of your characters'], 'plan.obligation_ids': ['plot thread', 'a thread of the main plot'],
  'plan.event_ids': ['event', 'an event of the main plot'], 'plan.parent_id': ['chapter', 'a chapter of the outline'],
  'plan.objective': ['goal', 'a goal'],
};
/** "gullhaven-harbor" -> "Gullhaven Harbor" (ids the AI made up read as names). */
export function slugName(v) {
  const s = String(v ?? '').trim();
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(s) || /^[A-K]\d\d-[0-9a-f]{8,}$/i.test(s)) return s;
  return s.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
/** Where a finding points, in words: "/chapters/0/facts/6" -> "Chapter 1"; unknown -> ''. */
export function partName(ptr) {
  const m = /^\/?(?:[a-z_]+\/)*?(chapters|scenes|events|arcs)\/(\d+)/.exec(String(ptr || ''));
  if (m) return `${PART[m[1]]} ${parseInt(m[2], 10) + 1}`;
  if (/^\/?main_plot/.test(String(ptr || ''))) return PART.main_plot;
  return '';
}
const OUT_OF_DATE = 'It was made from a plan or other inputs that changed since, so it is out of date: editing it cannot fix '
  + 'that. Approve the current version of what it was made from (for example the chapter outline or the characters), then '
  + 'make it again from them (🔁 Redo with AI, or write it again yourself).';
/** A short check message in plainer words ("/chapters/2/summary is too long" -> "Summary is too long"), or '' when it
 * is too long or too technical to show the author (then only 🔧 Details has it). */
function shortPlain(msg) {
  let m = String(msg || '').replace(/\s*\(at [^)]*\)\s*$/, '').trim();
  m = m.replace(/^\/((?:[^\s/:]+\/)*)([^\s/:]+):?(?=\s)/, (_all, _dirs, last) => (/^\d+$/.test(last) ? 'it' : last.replace(/_/g, ' ')));
  if (!m || m.length > 140 || /[{}[\]<>]|\b[A-K]\d\d-[0-9a-f]{6,}|Traceback|\bNone\b/.test(m) || !/[a-z]{3}/i.test(m)) return '';
  m = m.charAt(0).toUpperCase() + m.slice(1);
  return /[.!?]$/.test(m) ? m : `${m}.`;
}
const CHECKS = {
  CANON_UNRESOLVED: m => {
    const x = /^(\S*): ([\w.]+) '([^']*)' is not declared/.exec(m);
    if (!x) return 'It names someone or something that is not in your story bible yet.';
    const [what, known] = WHAT[x[2]] || ['name', 'in your story bible'];
    const where = partName(x[1]);
    return `${where || 'It'} names a ${what}, “${slugName(x[3])}”, that is not ${known}. Pick one of yours for it (or leave it open), or let the AI write it again.`;
  },
  PLAN_UNDECIDED: m => {
    const x = /^(\S*): ([\w.]+) of '([^']*)'/.exec(m);
    const [what] = (x && WHAT[x[2]]) || ['detail'];
    return `${(x && partName(x[1])) || 'A chapter'} has no ${what} chosen yet. Choose one before approving.`;
  },
  PLAN_FIELD_MISSING: m => `${partName(m) || 'A chapter'} is missing part of its plan (what happens, who tells it or where). Fill it in.`,
  PLAN_OBJECTIVE_UNKNOWN: m => `${partName(m) || 'A chapter'} does not say what happens in it yet. Write a sentence for it.`,
  PLAN_REF_UNKNOWN: m => {
    const x = /^(\S*): ([\w.]+) '([^']*)'/.exec(m);
    const [what, known] = (x && WHAT[x[2]]) || ['name', 'in the plan it builds on'];
    return `${(x && partName(x[1])) || 'It'} mentions a ${what}${x ? ` “${slugName(x[3])}”` : ''} that is not ${known}.`;
  },
  PLAN_REF_UNTRACED: m => CHECKS.PLAN_REF_UNKNOWN(m),
  PLAN_ITEM_DUPLICATE: m => `${partName(m) || 'A chapter'} uses the same name as another one. Give each chapter its own.`,
  PLAN_ORDER_DUPLICATE: m => `${partName(m) || 'Two chapters'} share the same place in the order.`,
  PLAN_PARENT_UNKNOWN: m => `${partName(m) || 'A scene'} belongs to a chapter that is not in the outline.`,
  TARGET_LENGTH: () => 'The number of chapters does not match the length you chose for the book.',
  // Out of date / inputs not approved: editing this draft cannot help (the same advice as the server's
  // book_path.refusal_advice and autobook STALE_FIX).
  STALE: () => OUT_OF_DATE,
  SOURCE_PIN: () => OUT_OF_DATE,
  INPUT_STALE: () => OUT_OF_DATE,
  STALE_PIN: () => OUT_OF_DATE,
  INPUT_NOT_VALIDATED: () => 'Something it was made from is not approved yet: approve that first, then approve this again.',
  CANON_NOT_APPROVED: () => 'It uses characters or places that are not approved yet. Approve them first.',
  FACT_CONTRADICTION: m => `${partName(m) || 'It'} says two different things about the same detail.`,
};
/**
 * Plain words for one check problem ("RULE_ID: message (at /path)" or a kernel "CODE: message").
 * Returns { text, raw }: text for the author, raw for 🔧 Details.
 */
export function plainCheck(s) {
  const raw = String(s ?? '');
  const x = /^([A-Z][A-Z0-9_]*(?::[\w-]+)?): ([\s\S]*)$/.exec(raw);
  if (!x) return { text: raw, raw: '' };
  const code = x[1].split(':')[0];
  const msg = x[2];
  if (CHECKS[code]) return { text: CHECKS[code](msg), raw };
  if (PROBLEMS[code]) return { text: `${PROBLEMS[code].what} ${PROBLEMS[code].fix}`, raw };
  const where = partName(msg) || partName((/\(at ([^)]+)\)/.exec(msg) || [])[1]);
  const said = shortPlain(msg);
  if (said) return { text: `${where ? `${where}: ` : ''}${said} Edit it so Akọwe’s checks pass, or let the AI write it again.`, raw };
  return { text: `${where ? `${where}: s` : 'S'}omething here does not pass Akọwe’s checks. Edit it, or let the AI write it again.`, raw };
}
