// Clipboard helper for the Akọwe workspace: copy and paste with graceful fallbacks.
//  * copyText(text, what)  - navigator.clipboard.writeText, else a hidden <textarea> +
//                            document.execCommand('copy'); toasts "Copied …" or explains what to do.
//  * readText(purpose)     - navigator.clipboard.readText, else (permission denied, http context,
//                            old browser) a small dialog where the author pastes with Ctrl+V / ⌘V.
//                            Resolves to the text, or null when the author cancels.
// Never throws: every failure becomes a friendly message. Nothing here talks to the server.

let notify = msg => { try { console.info(msg); } catch { /* ignore */ } };

/** app.js passes its toast() so messages look like the rest of the workspace. */
export function configureClipboard({ toast } = {}) {
  if (typeof toast === 'function') notify = toast;
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.style.cssText = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;';
  const prev = document.activeElement;
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.select(); ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch { ok = false; }
  ta.remove();
  if (prev && typeof prev.focus === 'function') { try { prev.focus({ preventScroll: true }); } catch { /* ignore */ } }
  return ok;
}

/** Copy text; returns true when it reached the clipboard. */
export async function copyText(text, what = 'Copied') {
  const value = text == null ? '' : String(text);
  let ok = false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext !== false) {
      await navigator.clipboard.writeText(value);
      ok = true;
    }
  } catch { ok = false; }
  if (!ok) ok = legacyCopy(value);
  if (ok) notify(`📋 ${what}`);
  else notify('This browser blocked copying. Select the text yourself and press Ctrl+C (⌘C on a Mac).');
  return ok;
}

/** Fallback paste dialog: resolves to the pasted text or null (cancelled). */
function pasteDialog(purpose, reason) {
  return new Promise(resolve => {
    const prev = document.activeElement;
    const d = document.createElement('dialog');
    d.className = 'selftest-dialog paste-dialog';
    d.setAttribute('aria-labelledby', 'paste-dlg-title');
    const head = document.createElement('div'); head.className = 'st-head';
    const h2 = document.createElement('h2'); h2.id = 'paste-dlg-title'; h2.textContent = '📥 Paste here';
    head.appendChild(h2);
    const p = document.createElement('p');
    p.textContent = `${reason} Click in the box, press Ctrl+V (⌘V on a Mac), then press “Use this”.`;
    const label = document.createElement('label'); label.htmlFor = 'paste-dlg-text'; label.className = 'field-label';
    label.textContent = purpose || 'Text or JSON to paste';
    const ta = document.createElement('textarea'); ta.id = 'paste-dlg-text'; ta.rows = 8; ta.spellcheck = false;
    const row = document.createElement('div'); row.className = 'form-actions';
    const use = document.createElement('button'); use.type = 'button'; use.className = 'primary'; use.textContent = 'Use this';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    row.append(use, cancel);
    d.append(head, p, label, ta, row);
    let done = false;
    const finish = value => {
      if (done) return; done = true;
      try { if (d.open) d.close(); } catch { /* ignore */ }
      d.remove();
      if (prev && typeof prev.focus === 'function') { try { prev.focus(); } catch { /* ignore */ } }
      resolve(value);
    };
    use.addEventListener('click', () => {
      if (!ta.value.trim()) { ta.setAttribute('aria-invalid', 'true'); ta.focus(); return; }
      finish(ta.value);
    });
    cancel.addEventListener('click', () => finish(null));
    d.addEventListener('cancel', ev => { ev.preventDefault(); finish(null); });
    document.body.appendChild(d);
    try { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); } catch { d.setAttribute('open', ''); }
    ta.focus();
  });
}

/** Read the clipboard as text; falls back to a paste box. Resolves to text or null. */
export async function readText(purpose) {
  let reason = 'This browser does not let pages read the clipboard directly.';
  try {
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function' && window.isSecureContext !== false) {
      const text = await navigator.clipboard.readText();
      if (typeof text === 'string' && text.trim()) return text;
      reason = 'The clipboard looks empty (or holds something other than text).';
    }
  } catch {
    reason = 'The browser did not allow reading the clipboard.';
  }
  return pasteDialog(purpose, reason);
}
