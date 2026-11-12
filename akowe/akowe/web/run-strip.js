/* ⏳ The run progress strip: one line at the top of every page while a ⚡ Make-a-book run works, waits or is paused —
 *   "📖 <title> · Step 12 of 19 — Writing chapter 2 · ⏳ about 1 h 40 m left (estimate at start: 4 h 10 m)
 *    · started 9:21 · should finish around 11:05"  and a thin bar (% of the estimated total, not just steps).
 * Waiting for the author says so plainly ("⏸ waiting for you since 9:33 — the clock is paused"); a finished run says
 * "✔ <title> finished in 5 h 2 m (estimated 4 h 10 m)" for a while. Clicking opens the run window. Several runs:
 * the working one first, "+1 more" shows the next. The numbers come from the run status API (run_clock.py) that the
 * ⚡ button already polls (GET /api/autobook); nothing is logged. */

const MOVING = ['working', 'waiting', 'pausing'];
const FOR_YOU = ['paused', 'needs_decision', 'problem', 'interrupted'];
const FINISHED_SHOW_MS = 3 * 3600 * 1000;   // a finished run's line stays this long (or until ✕)
const RS = { box: null, h: null, open: null, idx: 0, runs: [], hidden: new Set() };

export function durWords(s) {
  s = Math.max(0, Math.round(Number(s) || 0));
  if (s < 60) return `${Math.max(1, s)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} m` : `${h} h`;
}
export function clockWords(iso) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return '';
  try {
    const d = new Date(t), now = new Date();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return time;
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString()) return `${time} tomorrow`;
    return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  } catch { return ''; }
}
function hiddenKey(id) { return `akowe.runStrip.hidden.${id}`; }
function isHidden(id) {
  if (RS.hidden.has(id)) return true;
  try { return localStorage.getItem(hiddenKey(id)) === '1'; } catch { return false; }
}

/** The runs worth a line, the one to show first: working, then waiting for you, then just finished. */
export function stripRuns(out, now = Date.now()) {
  const seen = new Set(), list = [];
  for (const r of [...((out && out.active) || []), ...((out && out.runs) || [])]) {
    if (!r || !r.id || seen.has(r.id) || r.replaced_by) continue;
    seen.add(r.id);
    const st = r.state || '';
    if (MOVING.includes(st) || FOR_YOU.includes(st)) list.push(r);
    else if (st === 'done' && r.finished_at && now - Date.parse(r.finished_at) < FINISHED_SHOW_MS && !isHidden(r.id)) list.push(r);
  }
  const rank = r => (MOVING.includes(r.state) ? 0 : FOR_YOU.includes(r.state) ? 1 : 2);
  const stamp = r => String(r.updated_at || r.finished_at || r.started_at || '');
  return list.sort((a, b) => rank(a) - rank(b) || stamp(b).localeCompare(stamp(a)));
}

/** The words of one run's line: [{text, cls}] parts (cls "rs-minor" ones go first on a phone). */
export function stripParts(r) {
  const title = r.title ? `“${r.title}”` : 'A new book';
  if (r.state === 'done') {
    const took = r.actual_s != null ? r.actual_s : r.elapsed_active_s;
    return [{ text: `✔ ${title} finished` }, took != null ? { text: ` in ${durWords(took)}` } : null,
      r.total_estimate_s ? { text: ` (estimated ${durWords(r.total_estimate_s)})` } : null].filter(Boolean);
  }
  const parts = [{ text: `📖 ${title}` }];
  if (r.step_index && r.step_total) parts.push({ text: ` · Step ${r.step_index} of ${r.step_total}${r.step_label ? ` — ${r.step_label}` : ''}` });
  else if (r.step_label) parts.push({ text: ` · ${r.step_label}` });
  if (FOR_YOU.includes(r.state)) {
    const since = clockWords(r.waiting_since);
    const why = r.state === 'interrupted' ? 'stopped when Akọwe closed' : r.state === 'paused' ? 'paused' : 'waiting for you';
    parts.push({ text: ` · ⏸ ${why}${since ? ` since ${since}` : ''} — the clock is paused`, cls: 'rs-wait' });
    if (r.left_s != null) parts.push({ text: ` · about ${durWords(r.left_s)} left after that`, cls: 'rs-minor' });
    return parts;
  }
  if (r.state === 'waiting') parts.push({ text: ' · waiting for an AI', cls: 'rs-minor' });
  if (r.left_s != null) {
    parts.push({ text: ` · ⏳ about ${durWords(r.left_s)} left`, cls: 'rs-left' });
    if (r.total_estimate_s) parts.push({ text: ` (estimate at start: ${durWords(r.total_estimate_s)})`, cls: 'rs-minor' });
  }
  const st = clockWords(r.started_at);
  if (st) parts.push({ text: ` · started ${st}`, cls: 'rs-minor' });
  const fin = clockWords(r.finish_at);
  if (fin) parts.push({ text: ` · should finish around ${fin}` });
  return parts;
}

function percentOf(r) {
  if (r.state === 'done') return 100;
  if (r.percent != null) return Math.max(0, Math.min(100, r.percent));
  return r.steps_total ? Math.round(100 * (r.steps_done || 0) / r.steps_total) : 0;
}

function render() {
  const { box, h } = RS;
  if (!box || !h) return;
  const runs = RS.runs;
  if (!runs.length) { box.hidden = true; box.replaceChildren(); document.documentElement.classList.remove('has-run-strip'); return; }
  if (RS.idx >= runs.length) RS.idx = 0;
  const r = runs[RS.idx];
  const parts = stripParts(r);
  const words = parts.map(p => p.text).join('');
  const pct = percentOf(r);
  const tone = r.state === 'done' ? 'ok' : FOR_YOU.includes(r.state) ? 'warn' : 'work';
  const main = h('button', { type: 'button', class: 'rs-main', 'data-testid': 'run-strip-open', title: `${words}\nClick to open the run window.`,
    onclick: () => { if (RS.open) RS.open(r.id); } },
  h('span', { class: 'rs-text', 'data-testid': 'run-strip-text' }, ...parts.map(p => h('span', { class: p.cls || null }, p.text))));
  const more = runs.length > 1 ? h('button', { type: 'button', class: 'rs-more', 'data-testid': 'run-strip-more',
    title: `Other runs: ${runs.filter(x => x !== r).map(x => x.title || 'a new book').join(', ')} — click to show the next one`,
    onclick: () => { RS.idx = (RS.idx + 1) % runs.length; render(); } }, `+${runs.length - 1} more`) : null;
  const close = r.state === 'done' ? h('button', { type: 'button', class: 'rs-x', 'aria-label': 'Hide this line', title: 'Hide this line',
    'data-testid': 'run-strip-hide', onclick: () => { RS.hidden.add(r.id); try { localStorage.setItem(hiddenKey(r.id), '1'); } catch { /* this visit only */ }
      RS.runs = RS.runs.filter(x => x.id !== r.id); render(); } }, '✕') : null;
  const bar = h('div', { class: 'rs-bar', role: 'progressbar', 'aria-label': 'How far the book is, against the estimate', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'data-testid': 'run-strip-bar' },
    h('div', { class: 'rs-fill', style: `width:${pct}%` }));
  box.dataset.tone = tone;
  box.dataset.state = r.state || '';
  box.replaceChildren(h('div', { class: 'rs-row' }, main, more, close), bar);
  box.hidden = false;
  document.documentElement.classList.add('has-run-strip');
}

/** Called once: where the line goes and what a click does (open(runId) opens the run window). */
export function init({ h, open }) {
  RS.h = h; RS.open = open;
  RS.box = document.getElementById('run-strip');
}
/** Every poll of GET /api/autobook (the ⚡ button's own poll): redraw the line. */
export function update(out) {
  const keep = RS.runs[RS.idx] && RS.runs[RS.idx].id;
  RS.runs = stripRuns(out);
  const i = keep ? RS.runs.findIndex(r => r.id === keep) : -1;
  RS.idx = i >= 0 && RS.runs[0] && MOVING.includes(RS.runs[0].state) === MOVING.includes(RS.runs[i].state) ? i : 0;
  render();
}
