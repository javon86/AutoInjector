// AutoInjector page check: paste into the DevTools Console of a ChatGPT conversation (with at least one
// question and one answer on the page) and press Enter. It only READS the page. The result is copied to the
// clipboard: paste it back to Claude. Message text is NOT included: only lengths and the first/last 3 words.
(() => {
  const SEL = {
    input: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'textarea[name="prompt-textarea"]', 'form [contenteditable="true"][role="textbox"]', 'form textarea[placeholder]', '[contenteditable="true"]', 'textarea'],
    send: ['#composer-submit-button', 'button[data-testid="send-button"]', 'button[data-testid="composer-send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label*="Send"]', 'form button[type="submit"]'],
    stop: ['button[data-testid="stop-button"]', '#composer-submit-button[aria-label*="Stop"]', 'button[aria-label*="Stop"]'],
    assistant: ['div[data-message-author-role="assistant"]', '[data-message-author-role="assistant"] .markdown', 'article[data-turn="assistant"]', '[data-turn="assistant"]', 'article[data-testid^="conversation-turn"] .markdown', 'div.markdown.prose', '.agent-turn .markdown', '[data-message-id]', '[data-testid^="conversation-turn"]', 'article', '.markdown'],
    user: ['[data-message-author-role="user"]', 'article[data-turn="user"]', '[data-turn="user"]']
  };
  const peek = (t) => { const w = String(t || '').trim().split(/\s+/); return w.length <= 6 ? `(${w.length} words)` : `${w.slice(0, 3).join(' ')} … ${w.slice(-3).join(' ')}`; };
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const desc = (e) => {
    const attrs = [...e.attributes].filter(a => !/^style$|^nonce$/.test(a.name)).map(a => `${a.name}="${String(a.value).slice(0, 60)}"`).join(' ');
    return `<${e.tagName.toLowerCase()} ${attrs}>`.slice(0, 300);
  };
  const out = { url: location.pathname.replace(/[0-9a-f-]{20,}/g, '<id>'), when: new Date().toISOString(), selectors: {}, live: [], overlay: null, turns: [] };
  for (const [kind, list] of Object.entries(SEL)) {
    out.selectors[kind] = list.map(s => {
      let l = []; try { l = [...document.querySelectorAll(s)]; } catch { return { s, error: 'bad selector' }; }
      const last = l.filter(shown).pop();
      return { s, count: l.length, shown: l.filter(shown).length, last: last ? { tag: desc(last).slice(0, 200), chars: (last.innerText || last.value || '').length, peek: peek(last.innerText || last.value) } : null };
    });
  }
  for (const e of document.querySelectorAll('[aria-live], [role="status"]')) out.live.push({ tag: desc(e).slice(0, 160), text: (e.innerText || '').slice(0, 80) });
  const ov = document.querySelector('[data-autoinjector-overlay]');
  out.overlay = ov ? { shown: shown(ov), text: (ov.innerText || '').replace(/\d{4}/g, '####').slice(0, 120) } : null;
  // the last 4 message-like blocks, walking up from text nodes inside <main>
  const main = document.querySelector('main') || document.body;
  const blocks = [...main.querySelectorAll('[data-message-author-role], [data-turn], article, [data-message-id]')].filter(shown).slice(-6);
  for (const b of blocks) {
    const chain = []; let e = b;
    for (let i = 0; i < 4 && e && e !== main; i++, e = e.parentElement) chain.push(desc(e).slice(0, 180));
    out.turns.push({ chars: (b.innerText || '').length, peek: peek(b.innerText), chain });
  }
  const json = JSON.stringify(out, null, 1);
  try { copy(json); console.log('✔ Copied to the clipboard — paste it back to Claude.'); } catch { console.log(json); }
  return out;
})();
