'use strict';
// tools/page-structure.js — a READ-ONLY report of how a chat page is built
// (ChatGPT, Claude or Gemini), for fixing AutoInjector when a site changes its page
// (Claude, 2026-10-29). It never includes what anyone wrote: no message text, no
// chat titles, no sidebar entries. Only tags, structural attributes (data-testid,
// data-cds, role, data-*-role, classes), counts, text LENGTHS, and — for the
// visually-hidden headings in each message row — only their first words' kind
// ("You said" / "Claude said" / "other").
//
// Three ways to run it:
//   1. In the app: 🎯 card → "📋 Copy page structure" (copies the report).
//   2. In the AI's DevTools Console (View → Toggle Developer Tools on the pane,
//      or right-click → Inspect): paste the contents of tools/page-check.js and
//      press Enter — the report is copied to the clipboard.
//   3. `node tools/page-structure.js --snippet > tools/page-check.js` regenerates
//      that paste-able file from this one (a test keeps the two in step).
//
// pageStructure() is SELF-CONTAINED (it runs inside the page by source).

const { rowKit, rowConfigFor } = require('../transcript-rows');

function pageStructure(CFG, RK) {
  const out = { ok: true, tool: 'autoinjector-page-structure/1', site: CFG.site, host: String(location.hostname || ''), path: String(location.pathname || '').replace(/[0-9a-f-]{16,}/gi, '<id>').replace(/\d{3,}/g, '<n>'), when: new Date().toISOString() };
  const qsa = (sel, root) => { try { return Array.from((root || document).querySelectorAll(sel)); } catch (_) { return null; } };
  const shown = (e) => { try { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (_) { return false; } };
  const tiny = (e) => { try { const r = e.getBoundingClientRect(); return r.width <= 2 || r.height <= 2; } catch (_) { return false; } };
  const len = (e) => { try { return String(e.innerText != null ? e.innerText : e.textContent || '').trim().length; } catch (_) { return 0; } };
  const mask = (v) => String(v).replace(/[0-9a-f]{8,}/gi, '<id>').replace(/\d+/g, '#').slice(0, 60);
  // UI words that are safe to show (button labels); anything else -> its length only
  const UI = /^(send|send message|send prompt|stop|stop response|stop streaming|copy|copy response|retry|regenerate|edit|edit message|attach|add|more|menu|close|dismiss|share|good response|bad response|give positive feedback|give negative feedback|thumbs up|thumbs down|read aloud|new chat|search|settings|model|options|expand|collapse|scroll to bottom|open sidebar|close sidebar|voice|microphone|upload|tools)$/i;
  const STRUCT = /^(data-testid|data-cds|role|data-message-author-role|data-author-role|data-role|data-author|data-turn|data-sender|data-speaker|data-is-streaming|data-state|data-find-omitted|contenteditable|type|aria-hidden|aria-live|data-test-render-count|disabled|aria-disabled|hidden)$/;
  const TEXTY = /^(aria-label|title|alt|placeholder|aria-description|data-tooltip|mattooltip)$/;
  function attrs(e) {
    const o = {};
    for (const a of Array.from(e.attributes || [])) {
      const n = String(a.name).toLowerCase(); const v = String(a.value == null ? '' : a.value);
      if (n === 'class') { const c = v.split(/\s+/).filter((x) => x && x.length <= 40).map(mask).slice(0, 8).join(' '); if (c) o.class = c; }
      else if (n === 'id') o.id = /^[A-Za-z][\w-]{0,30}$/.test(v) && !/\d{3,}|[0-9a-f]{8,}/i.test(v) ? v : '<' + v.length + ' chars>';
      else if (STRUCT.test(n) || (n.indexOf('data-') === 0 && v.length <= 24 && !/\s/.test(v))) o[n] = mask(v);
      else if (TEXTY.test(n)) o[n] = UI.test(v.trim()) ? v.trim() : '<' + v.length + ' chars>';
      else if (n.indexOf('data-') === 0 || n.indexOf('aria-') === 0) o[n] = '<' + v.length + ' chars>';
    }
    return o;
  }
  const desc = (e) => (e ? Object.assign({ tag: String(e.localName || e.tagName || '').toLowerCase(), shown: shown(e) }, attrs(e)) : null);
  // hidden heading -> only what kind of words it starts with
  function says(h) {
    const t = String(h.textContent || '').slice(0, 40);
    if (/^\s*(you|user)\s+(said|wrote|asked|sent)\b/i.test(t)) return 'You said';
    if (/^\s*(claude|assistant|chatgpt|gemini|ai|model)\s+(said|says|responded|replied|wrote)\b/i.test(t)) { const w = /^\s*(\w+)/.exec(t)[1]; return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() + ' said'; }
    if (/^\s*you\b/i.test(t)) return 'You';
    if (/^\s*(claude|assistant|chatgpt|gemini)\b/i.test(t)) return 'AI name';
    return 'other';
  }

  // 1. the site's selector lists: what each matches right now
  out.selectors = {};
  for (const [kind, list] of Object.entries(CFG.lists || {})) {
    out.selectors[kind] = (list || []).map((s) => {
      const l = qsa(s);
      if (l === null) return { s, error: 'bad selector' };
      const vis = l.filter(shown);
      const last = vis[vis.length - 1] || l[l.length - 1];
      return { s, count: l.length, shown: vis.length, inChrome: l.filter((x) => RK.inChrome(x)).length, last: last ? Object.assign(desc(last), { chars: len(last) }) : null };
    });
  }
  // 2. the message rows and who wrote each (the reader's own rules)
  let info = null; try { info = RK.classify(document); } catch (_) { info = null; }
  if (info && info.rows.length) {
    out.rows = { count: info.rows.length, how: info.how, selector: info.selector, user: info.users, assistant: info.assistants, items: [] };
    for (const r of info.rows.slice(-8)) {
      const heads = (qsa('h1, h2, h3, h4, h5, h6, [role="heading"], [data-find-omitted], .sr-only, .visually-hidden', r.el) || []).slice(0, 4);
      const content = RK.contentIn(r.el);
      out.rows.items.push({
        role: r.role, by: r.why || 'order', node: desc(r.el), chars: len(r.el),
        headings: heads.map((h) => ({ tag: String(h.localName || '').toLowerCase(), hidden: tiny(h) || !shown(h), attrs: Object.keys(attrs(h)), says: says(h), chars: len(h) })),
        content: content.slice(0, 4).map((c) => Object.assign(desc(c), { chars: len(c) })),
        buttons: (qsa('button, [role="button"]', r.el) || []).slice(0, 8).map((b) => { const l = String(b.getAttribute('aria-label') || b.getAttribute('data-testid') || '').trim(); return UI.test(l) || /^[\w-]{1,40}$/.test(l) && b.getAttribute('data-testid') === l ? l : '<' + l.length + ' chars>'; }),
        chain: (() => { const c = []; let e = r.el.parentElement; for (let i = 0; e && i < 4 && e !== document.body; i++, e = e.parentElement) c.push(desc(e)); return c; })()
      });
    }
  } else out.rows = { count: 0, how: null };
  // 3. data-cds / data-testid values on the page (with counts), role-ish attributes
  const tally = (attr) => { const o = {}; for (const e of qsa('[' + attr + ']') || []) { if (RK.inChrome(e)) { o['(in sidebar/header) ' + mask(e.getAttribute(attr))] = (o['(in sidebar/header) ' + mask(e.getAttribute(attr))] || 0) + 1; continue; } const v = mask(e.getAttribute(attr)); o[v] = (o[v] || 0) + 1; } return o; };
  out.dataCds = tally('data-cds');
  out.dataTestid = (() => { const o = {}; for (const e of qsa('[data-testid]') || []) { const v = mask(e.getAttribute('data-testid')); o[v] = (o[v] || 0) + 1; } return o; })();
  out.roleAttrs = {};
  for (const a of ['data-message-author-role', 'data-role', 'data-author', 'data-turn', 'data-is-streaming', 'data-find-omitted']) { const l = qsa('[' + a + ']') || []; if (l.length) out.roleAttrs[a] = tally(a); }
  // 4. hidden headings anywhere (kind of words only)
  out.hiddenHeadings = {};
  for (const h of qsa('[data-find-omitted], .sr-only, .visually-hidden, h1, h2, h3, h4, h5, h6') || []) {
    if (!(tiny(h) || h.hasAttribute('data-find-omitted'))) continue;
    const k = String(h.localName || '').toLowerCase() + (h.hasAttribute('data-find-omitted') ? '[data-find-omitted]' : '') + ' ' + says(h);
    out.hiddenHeadings[k] = (out.hiddenHeadings[k] || 0) + 1;
  }
  // 5. page chrome
  out.chrome = { nav: (qsa('nav') || []).length, aside: (qsa('aside') || []).length, header: (qsa('header') || []).length, sidebarish: (qsa('[data-testid*="sidebar" i], [data-testid*="recents" i], [aria-label*="sidebar" i]') || []).length };
  const ov = document.querySelector('[data-autoinjector-overlay]');
  out.overlay = ov ? { shown: shown(ov) } : null;
  return out;
}

function snippetConfig(SITES, site) {
  const cfg = (SITES && SITES[site]) || {};
  return {
    site,
    lists: { input: cfg.INPUT_CANDIDATES || [], send: cfg.SEND_CANDIDATES || [], stop: cfg.STOP_CANDIDATES || [], assistant: cfg.ASSISTANT_CANDIDATES || [], rows: cfg.ROW_CANDIDATES || [] },
    rk: rowConfigFor(SITES, site)
  };
}
// The script the app runs in a pane (-> the report object).
function buildPageStructureScript(site, SITES) {
  const S = SITES || require('../selectors');
  const c = snippetConfig(S, site);
  return `(() => { const CFG = ${JSON.stringify(c).replace(/</g, '\\u003c')}; const RK = (${rowKit.toString()})(CFG.rk); return (${pageStructure.toString()})(CFG, RK); })()`;
}
// The paste-able DevTools snippet: picks the site from the address, copies the report.
function buildSnippet(SITES) {
  const S = SITES || require('../selectors');
  const all = {}; for (const site of ['chatgpt', 'claude', 'gemini']) all[site] = snippetConfig(S, site);
  return `// AutoInjector page check (generated by tools/page-structure.js --snippet — do not edit by hand).
// Paste into the DevTools Console of a ChatGPT, Claude or Gemini conversation (with at least one
// question and one answer on the page) and press Enter. It only READS the page. The result is
// copied to the clipboard: paste it back to whoever asked. No message text, chat titles or
// sidebar entries are included — only tags, structural attributes, counts and lengths.
(() => {
  const ALL = ${JSON.stringify(all, null, 1).replace(/</g, '\\u003c')};
  const h = String(location.hostname || '');
  const site = /claude\\.ai$/.test(h) ? 'claude' : /gemini\\.google\\.com$/.test(h) ? 'gemini' : 'chatgpt';
  const CFG = ALL[site];
  const RK = (${rowKit.toString()})(CFG.rk);
  const out = (${pageStructure.toString()})(CFG, RK);
  const json = JSON.stringify(out, null, 1);
  try { copy(json); console.log('✔ Copied to the clipboard — paste it back.'); } catch (_) { console.log(json); }
  return out;
})();
`;
}

module.exports = { pageStructure, buildPageStructureScript, buildSnippet, snippetConfig };

if (require.main === module) {
  if (process.argv.includes('--snippet')) process.stdout.write(buildSnippet());
  else process.stdout.write('Usage: node tools/page-structure.js --snippet > tools/page-check.js\n');
}
