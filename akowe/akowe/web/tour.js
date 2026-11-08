// 🧭 A short guided tour of Akọwe's home page (My books): a highlight, an arrow and one sentence per step, with
// Skip / Next / Done. It opens by itself the first time My books is shown, and ❓ Help → 🧭 Take the tour replays
// it. "Seen" is remembered in this browser (localStorage). It never opens by itself under browser automation
// (navigator.webdriver), so the UI tests are not interrupted; tests can force it with localStorage
// 'akowe:tour-force' = '1'. Vanilla, no libraries; built with DOM APIs only.
const SEEN_KEY = 'akowe:tour-seen';
const FORCE_KEY = 'akowe:tour-force';

export const TOUR_STEPS = [
  { sel: '#tb-books', text: '📚 My books: all your books. Open one to work on it.' },
  { sel: '#new-btn', text: '➕ New book: write a book with the AI, step by step.' },
  { sel: '.mab-cta', text: '⚡ AI writes the whole book: the AI writes it from start to finish, and you can watch, pause or cancel.' },
  { sel: '.tb-settings', text: '⚙️ Settings: your AI connection and how Akọwe works, including the 🤖 Claude Code helpers.' },
  { sel: '.tb-help', text: '❓ Help explains every part of Akọwe. You can take this tour again from there.' },
];

const CSS = `
#ak-tour { position: fixed; inset: 0; z-index: 2000; pointer-events: none; }
#ak-tour .ak-tour-hole { position: fixed; border-radius: 8px; box-shadow: 0 0 0 9999px rgba(0, 0, 0, .5); outline: 2px solid #e0b84a; }
#ak-tour .ak-tour-tip { position: fixed; width: min(320px, calc(100vw - 24px)); background: #fff; color: #1b1b1b; border: 1px solid #7c5ce0;
  border-radius: 9px; padding: 10px 12px; font-size: 14px; line-height: 1.45; pointer-events: auto; box-shadow: 0 8px 28px rgba(0, 0, 0, .35); }
#ak-tour .ak-tour-tip::before { content: ''; position: absolute; top: -7px; left: var(--ax, 20px); width: 12px; height: 12px; background: #fff;
  border-left: 1px solid #7c5ce0; border-top: 1px solid #7c5ce0; transform: rotate(45deg); }
#ak-tour .ak-tour-n { font-size: 12px; opacity: .7; margin-bottom: 2px; }
#ak-tour .ak-tour-btns { display: flex; gap: 6px; margin-top: 8px; }
#ak-tour .ak-tour-btns .sp { flex: 1 1 auto; }
`;

let current = null;

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'onclick') e.addEventListener('click', v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}
function store(key, val) {
  try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch { /* private mode */ }
  return null;
}
const shown = (n) => { if (!n) return false; const r = n.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(n).visibility !== 'hidden'; };

function draw() {
  const t = current; if (!t) return;
  const s = t.steps[t.i];
  const target = document.querySelector(s.sel);
  const r = target ? target.getBoundingClientRect() : { left: 20, top: 20, width: 80, height: 30, bottom: 50 };
  Object.assign(t.hole.style, { left: `${Math.round(r.left - 4)}px`, top: `${Math.round(r.top - 4)}px`, width: `${Math.round(r.width + 8)}px`, height: `${Math.round(r.height + 8)}px` });
  const last = t.i === t.steps.length - 1;
  t.tip.replaceChildren(
    el('div', { class: 'ak-tour-n' }, `Akọwe · ${t.i + 1} of ${t.steps.length}`),
    el('div', { 'data-testid': 'tour-text' }, s.text),
    el('div', { class: 'ak-tour-btns' },
      el('button', { type: 'button', class: 'small', 'data-testid': 'tour-skip', onclick: () => end(true) }, 'Skip'),
      el('span', { class: 'sp' }),
      last ? el('button', { type: 'button', class: 'small primary', 'data-testid': 'tour-done', onclick: () => end(true) }, 'Done')
        : el('button', { type: 'button', class: 'small primary', 'data-testid': 'tour-next', onclick: () => { t.i += 1; draw(); } }, 'Next')));
  const W = window.innerWidth;
  const tw = Math.min(320, W - 24);
  const left = Math.max(12, Math.min(r.left + Math.min(r.width / 2, 140) - 24, W - tw - 12));
  t.tip.style.top = `${Math.round(r.bottom + 12)}px`;
  t.tip.style.left = `${Math.round(left)}px`;
  t.tip.style.setProperty('--ax', `${Math.round(Math.max(12, Math.min(tw - 24, r.left + Math.min(r.width / 2, 140) - left - 6)))}px`);
  const b = t.tip.querySelector('.primary'); if (b) b.focus({ preventScroll: true });
}

function end(markSeen) {
  if (!current) return;
  current.root.remove();
  window.removeEventListener('resize', draw);
  document.removeEventListener('keydown', onKey);
  current = null;
  if (markSeen) store(SEEN_KEY, '1');
}
function onKey(e) { if (e.key === 'Escape') end(true); }

/** Start the tour now (the targets must be on the page). Returns true when it started. */
export function startTour() {
  if (current) end(false);
  const steps = TOUR_STEPS.filter((s) => shown(document.querySelector(s.sel)));
  if (!steps.length) return false;
  if (!document.getElementById('ak-tour-css')) { const st = el('style', { id: 'ak-tour-css' }); st.textContent = CSS; document.head.appendChild(st); }
  const root = el('div', { id: 'ak-tour', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Guided tour of Akọwe', 'data-testid': 'tour' });
  const hole = el('div', { class: 'ak-tour-hole' });
  const tip = el('div', { class: 'ak-tour-tip' });
  root.append(hole, tip);
  document.body.appendChild(root);
  current = { steps, i: 0, root, hole, tip };
  window.addEventListener('resize', draw);
  document.addEventListener('keydown', onKey);
  draw();
  return true;
}

/** The first time My books shows: start the tour (never under automation unless forced). */
export function maybeStartTour() {
  try {
    if (store(SEEN_KEY) === '1' || current) return false;
    if (navigator.webdriver && store(FORCE_KEY) !== '1') return false;
  } catch { return false; }
  setTimeout(() => { if (!current && (location.hash || '#/').replace(/^#\/?$/, '') === '') startTour(); }, 400);
  return true;
}

/** ❓ Help → 🧭 Take the tour: go to My books and play it again. */
export function replayTour() {
  try { localStorage.removeItem(SEEN_KEY); } catch { /* ignore */ }
  if ((location.hash || '#/').replace(/^#\/?$/, '') !== '') location.hash = '#/';
  setTimeout(() => startTour(), 600);
}
