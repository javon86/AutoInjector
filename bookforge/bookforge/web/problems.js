// The ONE table that turns every known problem code into plain words (R1-R3).
// Kernel codes (errors.py), provider/bridge answers, HTTP failures and "network down" all map here.
// Each entry: title (short, plain), what (what happened, in words a non-technical author understands),
// fix (concrete steps), action (the best button: retry | settings | form | open | reload | backup | none).

export const PROBLEMS = {
  // ---------------------------------------------------------------- kernel error codes (errors.py)
  MISSING_INPUT: { title: 'Something needed is missing', what: 'A required field or choice was left empty.', fix: 'Fill in the field marked ⚠️ and try again.', action: 'form' },
  INVALID_INPUT: { title: 'Something was not accepted', what: 'A value does not fit what this step expects.', fix: 'Look at the field marked ⚠️, correct it, and try again.', action: 'form' },
  NOT_FOUND: { title: 'It is not there any more', what: 'BookForge could not find this item. It may have been replaced by a newer version or the page is out of date.', fix: 'Reload the page. If you followed a link, open the book from Your books.', action: 'reload' },
  VERSION_CONFLICT: { title: 'It changed in the meantime', what: 'Something changed while you were working (or another job is running), so BookForge did not overwrite it.', fix: 'Reload to see the newest version, then try again. If a job is running, wait for it or pause it.', action: 'reload' },
  HASH_MISMATCH: { title: 'A file is damaged or changed', what: 'A stored file does not match its fingerprint, so BookForge refused to use it.', fix: 'Make it again (for an exported book: press 📦 Export my book). If many files are affected, restore a backup in Settings.', action: 'retry' },
  PERMISSION_DENIED: { title: 'Not allowed', what: 'This action is not allowed here (for example an approval outside the run you started, or a missing access token).', fix: 'Open BookForge from its start link and try again from the book you are working on.', action: 'reload' },
  UNSUPPORTED_CONTRACT: { title: 'Version mismatch', what: 'This request was made for a different version of BookForge.', fix: 'Reload the page (BookForge may have been updated).', action: 'reload' },
  UPSTREAM_UNAVAILABLE: { title: 'The AI cannot be reached', what: 'BookForge could not reach the AI (for AutoInjector: the desktop app or the site’s window is not available).', fix: 'Start the AutoInjector desktop app, open and log in to the site’s pane, then press Test connection in Settings. BookForge waits and retries busy AIs on its own.', action: 'settings' },
  CAPABILITY_UNAVAILABLE: { title: 'No AI is ready', what: 'No AI slot is connected (or the chosen one is not set up), so the AI could not do this.', fix: 'Open Settings and connect AutoInjector or add an API key. You can also write this step yourself.', action: 'settings' },
  TIMEOUT: { title: 'The AI did not answer in time', what: 'The AI took too long. Its answer may still arrive, so BookForge does not try again on its own (that could cost twice).', fix: 'Check the AI’s window (AutoInjector: logged in and idle?), then press 🔁 Try again.', action: 'retry' },
  RATE_LIMITED: { title: 'The AI is busy', what: 'The AI is busy with other work right now.', fix: 'BookForge waits and retries busy AIs automatically. If it keeps happening, wait a few minutes or pick another AI.', action: 'retry' },
  INTERNAL_ERROR: { title: 'Something went wrong inside BookForge', what: 'BookForge hit an unexpected problem. Nothing was lost.', fix: 'Press 🔁 Try again. If it keeps happening, press 📋 Copy diagnostics and send it to the developer.', action: 'retry' },
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

  // ---------------------------------------------------------------- BookForge app codes
  NOT_APPLICABLE: { title: 'Switched off for this book', what: 'This step belongs to a feature that is off for this book.', fix: 'Turn the feature on in 🎛️ Book features, or skip this step.', action: 'open' },
  REVIEW_NOT_PASSED: { title: 'The AI reviewer is not happy yet', what: 'The AI reviewer still asks for changes after two AI fixes.', fix: 'Decide: ✔ Approve anyway (your own approval), ✏️ Edit it yourself and continue, or 🔁 Try again (two more AI fixes).', action: 'retry' },
  INTERRUPTED: { title: 'Interrupted', what: 'BookForge was closed or restarted while this was running.', fix: 'Press ▶ Resume to continue where it stopped.', action: 'retry' },
  CANCELLED: { title: 'Cancelled', what: 'You stopped this.', fix: 'Start it again when you are ready.', action: 'retry' },
  SITE_BUSY: { title: 'The AI site is busy', what: 'The AI’s web window is busy with another request.', fix: 'BookForge waits and retries automatically. Keep the AutoInjector window open.', action: 'retry' },
  STALE: { title: 'Out of date', what: 'Something this was built from has changed, so it needs a new version.', fix: 'Open it and make a new version (✏️ Edit, or ask the AI to redo it).', action: 'open' },
  BLOCKED: { title: 'Waiting for an earlier step', what: 'This step needs an earlier step to be done (and approved) first.', fix: 'Do the earlier step first; the checklist shows which one.', action: 'none' },
  REJECTED: { title: 'Not accepted', what: 'BookForge’s checks did not accept this.', fix: 'Open it to see the checks, fix what they say, and try again.', action: 'open' },
  FAILED: { title: 'It did not work', what: 'This step did not finish.', fix: 'Press 🔁 Try again.', action: 'retry' },

  // ---------------------------------------------------------------- network and HTTP
  NETWORK: { title: 'BookForge is not answering', what: 'The page could not reach the BookForge program on this computer.', fix: 'Check that the BookForge window is still open (start it again with run-bookforge if it closed), then press 🔁 Try again.', action: 'retry' },
  HTTP_400: { title: 'Something was not accepted', what: 'BookForge refused the request.', fix: 'Check the fields marked ⚠️ and try again.', action: 'form' },
  HTTP_401: { title: 'Open BookForge from its start link', what: 'This page has no valid access token.', fix: 'Open the link shown in the BookForge window (or its desktop shortcut).', action: 'reload' },
  HTTP_403: { title: 'Not allowed', what: 'You do not have access to this.', fix: 'Open the book from Your books.', action: 'reload' },
  HTTP_404: { title: 'Not found', what: 'This page or item does not exist (any more).', fix: 'Go back to Your books and open it again.', action: 'reload' },
  HTTP_409: { title: 'Busy or changed', what: 'Something else is running or the item changed.', fix: 'Wait a moment and try again.', action: 'retry' },
  HTTP_413: { title: 'Too large', what: 'The file or text is too large.', fix: 'Use a smaller file.', action: 'form' },
  HTTP_429: { title: 'Busy', what: 'Too many things are running at once.', fix: 'Wait a moment and try again.', action: 'retry' },
  HTTP_500: { title: 'Something went wrong inside BookForge', what: 'BookForge hit an unexpected problem (details are in its window).', fix: 'Press 🔁 Try again. If it keeps happening, press 📋 Copy diagnostics.', action: 'retry' },
  HTTP_502: { title: 'The AI bridge is not available', what: 'A helper program did not answer properly.', fix: 'Check AutoInjector, then try again.', action: 'settings' },
  HTTP_503: { title: 'Not available right now', what: 'A service is temporarily unavailable.', fix: 'Wait a moment and try again.', action: 'retry' },
  BROWSER: { title: 'The page hit a problem', what: 'Something unexpected happened in this page.', fix: 'Reload the page. If it keeps happening, press 📋 Copy diagnostics.', action: 'reload' },
};

const FALLBACK = { title: 'Something went wrong', what: 'BookForge could not finish this.', fix: 'Press 🔁 Try again. If it keeps happening, press 📋 Copy diagnostics.', action: 'retry' };

/** Plain words for a code (falls back to the HTTP status, then a generic entry). */
export function problemFor(code, status) {
  if (code && PROBLEMS[code]) return PROBLEMS[code];
  if (status && PROBLEMS[`HTTP_${status}`]) return PROBLEMS[`HTTP_${status}`];
  if (status >= 500) return PROBLEMS.HTTP_500;
  return FALLBACK;
}
