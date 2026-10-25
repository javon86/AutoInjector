// 🗂 P27 scene grid and ⏱ P28 time and AI use (+ the estimate before a run). Vanilla ES module; DOM APIs only
// (never innerHTML with server data). app.js hands in its helpers as `ui` (h, api, bpath, plink, …), so this file has
// no state of its own and app.js only needs a few lines to wire it up.

const SEV_ICON = { major: '⚠️', minor: '△', info: 'ⓘ' };
const SEV_ORDER = { major: 0, minor: 1, info: 2 };
const STATE_WORD = { approved: ['✔', 'approved', 'b-ok'], draft: ['✎', 'draft', 'b-info'], unwritten: ['○', 'not written', 'b-muted'] };
const SORTS = [
  ['story', 'Story order'], ['problems', 'Problems first'], ['words_desc', 'Longest scenes first'],
  ['words_asc', 'Shortest scenes first'], ['grade_desc', 'Hardest to read first'], ['pov', 'Point of view'], ['place', 'Place'],
];

function pct(x) { return x == null ? '–' : `${Math.round(100 * x)}%`; }
function num(x) { return x == null ? '–' : Number(x).toLocaleString(); }
function minutes(m) {
  if (m == null) return '–';
  if (m < 1) { const sec = Math.round(m * 60); return sec < 1 ? 'under 1 s' : `${sec} s`; }
  if (m < 90) return `${Math.round(m)} min`;
  return `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;
}

function probChips(ui, probs) {
  const { h } = ui;
  if (!probs || !probs.length) return null;
  return h('ul', { class: 'sg-probs' }, probs.slice().sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])
    .map(p => h('li', { class: `sg-prob sev-${p.severity}`, 'data-code': p.code },
      h('span', { 'aria-hidden': 'true' }, `${SEV_ICON[p.severity] || '•'} `), p.label)));
}

/* ======================================================================= 🗂 P27 scene grid page */
export async function viewSceneGrid(main, ui) {
  const { h, api, bpath, plink, clear, crumbs, stateBox, loadingState, problemBox, toProblem, infoTip } = ui;
  const project = ui.project();
  const title = ui.profileOf().title || project.name;
  const csv = h('button', { type: 'button', class: 'no-print', 'data-testid': 'sg-csv', onclick: async () => {
    try {
      const blob = await api('GET', bpath('/grid?format=csv&download=1'), { blob: true });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `${ui.safeFileStem(title) || 'book'} - scene grid.csv` });
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      ui.toast('Scene grid downloaded');
    } catch (e) { ui.showGlobalProblem(toProblem(e, { step: 'Scene grid' })); }
  } }, '⬇ Spreadsheet (.csv)');
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    crumbs(['Your books', '#/'], [project.name, plink()], ['Make my book', plink('book')], 'Scene grid'), h('h1', null, '🗂 Scene grid')),
  h('div', { class: 'row no-print' }, infoTip('Scene grid',
    h('p', null, 'Every scene of the book on one page, in story order: who tells it, where and when it happens, what each character wants, what gets in the way and what changes — from the scene cards — beside how many words the scene has on the page and how it reads (reading level, dialogue, pace).'),
    h('p', null, 'Problems Akọwe already knows are listed in each row: scene cards without a goal, obstacle or anything unsaid, the scene checker’s notes, very short scenes, chapters far under their length, the editor’s and the planned-to-page check’s open notes.'),
    h('p', null, 'Scenes on the page are told apart by scene-break lines (***). A chapter written in one piece shows its plan only.')),
  h('button', { type: 'button', 'data-testid': 'sg-print', onclick: () => window.print() }, '🖨 Print'), csv,
  h('a', { class: 'btn', href: plink('costs') }, '⏱ Time and AI use'))));
  main.appendChild(h('p', { class: 'muted no-print' }, 'The whole book at a glance: chapters × scenes with the plan, the words on the page, readability and problems. Sort and filter below; on a phone each scene is a card.'));
  const holder = h('div', { 'aria-live': 'polite' }, loadingState('Building the scene grid…'));
  main.appendChild(holder);
  let g;
  const load = async () => {
    try { g = await api('GET', bpath('/grid')); } catch (e) { clear(holder).appendChild(problemBox(toProblem(e, { book: title, step: 'Scene grid' }), { retry: load })); return; }
    draw();
  };
  const sort = h('select', { id: 'sg-sort', 'data-testid': 'sg-sort' }, SORTS.map(([k, l]) => h('option', { value: k }, l)));
  const pov = h('select', { id: 'sg-pov', 'data-testid': 'sg-pov' }, h('option', { value: '' }, 'Everyone'));
  const only = h('input', { type: 'checkbox', id: 'sg-only', 'data-testid': 'sg-only' });
  function rowsOf() {
    const out = [];
    for (const ch of g.chapters) for (const s of ch.scenes) out.push({ ch, s, nprob: s.problems.length + (s.n === 1 ? ch.problems.length : 0),
      worst: Math.min(3, ...s.problems.map(p => SEV_ORDER[p.severity]), ...(s.n === 1 ? ch.problems.map(p => SEV_ORDER[p.severity]) : [])) });
    return out;
  }
  function sorted(rows) {
    const k = sort.value; const by = (f, dir = 1) => rows.slice().sort((a, b) => {
      const x = f(a); const y = f(b);
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * dir || (a.ch.number - b.ch.number) || (a.s.n - b.s.n);
    });
    if (k === 'problems') return by(r => r.worst * 100 - r.nprob);
    if (k === 'words_desc') return by(r => r.s.words, -1);
    if (k === 'words_asc') return by(r => r.s.words);
    if (k === 'grade_desc') return by(r => r.s.grade, -1);
    if (k === 'pov') return by(r => (r.s.pov || '').toLowerCase() || null);
    if (k === 'place') return by(r => (r.s.place || '').toLowerCase() || null);
    return rows;
  }
  function chapterRow(ch) {
    const st = STATE_WORD[ch.state] || STATE_WORD.unwritten;
    return h('tr', { class: 'sg-ch', 'data-chapter': ch.chapter_id }, h('th', { colspan: '8', scope: 'rowgroup' },
      h('div', { class: 'sg-ch-head' },
        h('strong', null, `Chapter ${ch.number}${ch.title ? ` · ${ch.title}` : ''}`), ' ', ui.badge(st[0], st[1], st[2]),
        h('span', { class: 'small' }, ` ${num(ch.words)} of about ${num(ch.target_words)} words`),
        ch.grade != null ? h('span', { class: 'small' }, ` · grade ${ch.grade} · ${pct(ch.dialogue_share)} dialogue · ${ch.pace || '–'}`) : null,
        h('a', { class: 'small no-print', href: plink('scenes', ch.chapter_id) }, ' 🎬 scene cards')),
      ch.objective ? h('div', { class: 'small muted sg-obj' }, ch.objective) : null,
      probChips(ui, ch.problems)));
  }
  function sceneRow(r, withChapter) {
    const { ch, s } = r;
    const td = (label, cls, ...kids) => h('td', { 'data-label': label, class: cls }, ...kids);
    const probs = s.problems.concat(withChapter && s.n === 1 ? ch.problems : []);
    return h('tr', { class: `sg-scene${probs.some(p => p.severity === 'major') ? ' has-major' : probs.length ? ' has-prob' : ''}${s.planned ? '' : ' unplanned'}`, 'data-testid': 'sg-row' },
      h('th', { scope: 'row', 'data-label': 'Scene', class: 'sg-n' }, h('a', { href: plink('scenes', ch.chapter_id), title: `Chapter ${ch.number}, scene ${s.n}` }, `${ch.number}.${s.n}`)),
      td('Point of view', 'sg-pov', s.pov || '–'),
      td('Where · when', 'sg-where', s.place || '–', s.time ? h('span', { class: 'small muted' }, ` · ${s.time}`) : null),
      td('Goals', 'sg-goals', s.goals.length ? h('ul', { class: 'sg-goal-list' }, s.goals.map(x => h('li', null, h('strong', null, `${x.character}: `), x.goal))) : (s.planned ? '–' : h('span', { class: 'muted small' }, 'not planned'))),
      td('Obstacle', 'sg-obst', s.obstacle || '–'),
      td('Change', 'sg-change', s.change || '–'),
      td('Words · reading', 'sg-num', s.words != null ? h('span', null, h('strong', null, num(s.words)), h('span', { class: 'small muted' }, ` · grade ${s.grade ?? '–'} · ${pct(s.dialogue_share)} dlg · ${s.pace || '–'}`)) : h('span', { class: 'muted small' }, s.written ? '–' : 'not on the page')),
      td('Problems', 'sg-pr', probChips(ui, probs) || h('span', { class: 'sg-ok small' }, '✔')));
  }
  function draw() {
    clear(holder);
    if (!g.outline) { holder.appendChild(stateBox('empty', 'No chapter outline yet', h('p', null, 'The grid shows the chapters of the approved outline. Plan the book first (📘 Make my book).'))); return; }
    const t = g.totals;
    holder.appendChild(h('section', { class: 'card sg-summary', 'data-testid': 'sg-summary' },
      h('h2', { class: 'print-only' }, `“${g.title}” — scene grid`),
      h('div', { class: 'rp-kpis' },
        h('div', { class: 'kpi' }, h('strong', null, `${t.chapters}`), h('span', { class: 'small' }, `chapter(s), ${t.written_chapters} written`)),
        h('div', { class: 'kpi' }, h('strong', null, `${t.scenes}`), h('span', { class: 'small' }, `scene row(s), ${t.planned_scenes} planned on scene cards`)),
        h('div', { class: 'kpi' }, h('strong', null, num(t.words)), h('span', { class: 'small' }, `words${g.readability && g.readability.grade != null ? ` · grade ${g.readability.grade} (${g.audience.label.toLowerCase()} books: ${g.audience.grade[0]}–${g.audience.grade[1]})` : ''}`)),
        h('div', { class: 'kpi' }, h('strong', null, `${t.problems}`), h('span', { class: 'small' }, 'problem(s) flagged'))),
      g.scenes_on ? null : h('p', { class: 'small muted' }, 'Scene cards are switched off in this book’s pipeline: the grid shows the scenes on the page only.')));
    clear(pov).appendChild(h('option', { value: '' }, 'Everyone'));
    for (const p of g.povs || []) pov.appendChild(h('option', { value: p }, p));
    holder.appendChild(h('div', { class: 'card row sg-filters no-print' },
      h('label', { for: 'sg-sort' }, 'Sort'), sort, h('label', { for: 'sg-pov' }, 'Point of view'), pov,
      h('span', { class: 'check-row' }, only, h('label', { for: 'sg-only' }, '⚠️ Only scenes with problems'))));
    const body = h('div', { class: 'sg-body' });
    holder.appendChild(body);
    const paint = () => {
      const story = sort.value === 'story';
      let rows = sorted(rowsOf());
      if (pov.value) rows = rows.filter(r => r.s.pov === pov.value);
      if (only.checked) rows = rows.filter(r => r.nprob);
      const tb = h('tbody');
      let last = null;
      for (const r of rows) {
        if (story && r.ch !== last) { tb.appendChild(chapterRow(r.ch)); last = r.ch; }
        tb.appendChild(sceneRow(r, !story));
      }
      clear(body);
      if (!rows.length) { body.appendChild(stateBox('ok', only.checked ? 'No scene with a problem — good news.' : 'No scene matches.')); return; }
      body.appendChild(h('div', { class: 'table-wrap sg-wrap' }, h('table', { class: 'sg-table', 'data-testid': 'sg-table' },
        h('caption', { class: 'small' }, `${rows.length} scene row(s)${pov.value ? ` told by ${pov.value}` : ''}${only.checked ? ' with problems' : ''}. Scene = chapter.scene (opens its scene cards).`),
        h('thead', null, h('tr', null, ['Scene', 'Point of view', 'Where · when', 'Goals', 'Obstacle', 'Change', 'Words · reading', 'Problems'].map(x => h('th', { scope: 'col' }, x)))),
        tb)));
    };
    for (const el of [sort, pov, only]) el.onchange = paint;
    paint();
  }
  await load();
}

/* ======================================================================= ⏱ P28 time and AI use page */
export async function viewCosts(main, ui) {
  const { h, api, bpath, plink, clear, crumbs, stateBox, loadingState, problemBox, toProblem, infoTip } = ui;
  const project = ui.project();
  const title = ui.profileOf().title || project.name;
  const md = h('button', { type: 'button', onclick: async () => {
    try {
      const blob = await api('GET', bpath('/costs?format=md&download=1'), { blob: true });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `${ui.safeFileStem(title) || 'book'} - time and AI use.md` });
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      ui.toast('Downloaded');
    } catch (e) { ui.showGlobalProblem(toProblem(e, { step: 'Time and AI use' })); }
  } }, '⬇ Download (.md)');
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    crumbs(['Your books', '#/'], [project.name, plink()], ['Make my book', plink('book')], 'Time and AI use'), h('h1', null, '⏱ Time and AI use')),
  h('div', { class: 'row no-print' }, infoTip('Time and AI use',
    h('p', null, 'Measured: every AI answer of a ⚡ Make-a-book run is timed — how many answers each AI gave and how many minutes it worked on them, per run and per step.'),
    h('p', null, 'Counted: AI work outside runs (✨ Fill with AI, 🧐 reviews, ✍ Write all chapters, reports) is not timed, but the book journal names the AI of every piece of it.'),
    h('p', null, 'Money: only for AIs with per-token prices (an API key with prices in Settings). Web AIs through AutoInjector cost nothing extra. Nothing here holds your text or the prompts.')),
  md, h('a', { class: 'btn', href: plink('grid') }, '🗂 Scene grid'), h('a', { class: 'btn', href: plink('journal') }, '📜 Journal'))));
  const holder = h('div', { 'aria-live': 'polite' }, loadingState('Adding up the time…'));
  main.appendChild(holder);
  let c;
  try { c = await api('GET', bpath('/costs')); } catch (e) { clear(holder).appendChild(problemBox(toProblem(e, { book: title, step: 'Time and AI use' }), { retry: () => ui.route() })); return; }
  clear(holder);
  const t = c.totals;
  holder.appendChild(h('section', { class: 'card', 'data-testid': 'ct-summary' }, h('div', { class: 'rp-kpis' },
    h('div', { class: 'kpi' }, h('strong', null, `${t.calls}`), h('span', { class: 'small' }, `AI answers in ${t.runs} ⚡ run(s)`)),
    h('div', { class: 'kpi' }, h('strong', null, minutes(t.ai_minutes)), h('span', { class: 'small' }, 'the AIs spent answering')),
    h('div', { class: 'kpi' }, h('strong', null, minutes(t.minutes)), h('span', { class: 'small' }, 'from start to end of the runs (pauses included)')),
    t.cost_minor ? h('div', { class: 'kpi' }, h('strong', null, `${(t.cost_minor / 100).toFixed(2)} ${c.currency || ''}`), h('span', { class: 'small' }, `for ${num(t.tokens)} tokens (API prices)`)) : null)));
  const aiTable = (rows, cols) => h('div', { class: 'table-wrap' }, h('table', { class: 'rp-table ct-table' },
    h('thead', null, h('tr', null, cols.map(([l]) => h('th', { scope: 'col' }, l)))),
    h('tbody', null, rows.map(r => h('tr', null, cols.map(([l, f], i) => i === 0 ? h('th', { scope: 'row' }, f(r)) : h('td', { class: 'num', 'data-label': l }, f(r))))))));
  holder.appendChild(h('section', { class: 'card', 'data-testid': 'ct-by-ai' }, h('h2', null, '🤖 Per AI (measured in runs)'),
    (c.by_ai || []).length ? aiTable(c.by_ai, [['AI', a => a.name], ['Answers', a => num(a.calls)], ['Minutes', a => minutes(a.minutes)], ['Not answered', a => num(a.failed)], ['Per answer', a => a.calls ? `${Math.round(a.seconds / a.calls)} s` : '–']])
      : h('p', { class: 'small muted' }, 'No ⚡ Make-a-book run for this book yet: only runs are timed.')));
  if ((c.runs || []).length) {
    holder.appendChild(h('section', { class: 'card', 'data-testid': 'ct-runs' }, h('h2', null, '⚡ Runs'),
      c.runs.map(r => h('details', { class: 'ct-run' }, h('summary', null, `${ui.fmtTime(r.started_at)} · ${r.status} · ${r.calls} AI answer(s) · ${minutes(r.ai_minutes)} of AI time · ${minutes(r.minutes)} in all`),
        r.ais.length ? aiTable(r.ais, [['AI', a => a.name], ['Answers', a => num(a.calls)], ['Minutes', a => minutes(a.minutes)], ['Not answered', a => num(a.failed)]]) : null,
        r.steps.length ? aiTable(r.steps, [['Step', s => s.title || s.id], ['AI answers', s => num(s.calls)], ['AI minutes', s => minutes(s.ai_minutes)], ['Step minutes', s => minutes(s.minutes)]]) : null,
        r.chapters && r.chapters.timed ? h('p', { class: 'small' }, `${r.chapters.timed} chapter(s) timed: about ${minutes(r.chapters.avg_minutes)} each.`) : null))));
  }
  if ((c.journal || []).length) {
    holder.appendChild(h('section', { class: 'card', 'data-testid': 'ct-journal' }, h('h2', null, '📜 AI work counted from the journal'),
      h('p', { class: 'small muted' }, 'Everything each AI did for this book, in and outside runs (counted, not timed).'),
      aiTable(c.journal, [['AI', j => j.name], ['Pieces of work', j => num(j.total)], ['What', j => Object.entries(j.work).map(([k, v]) => `${k} ${v}`).join(' · ')]])));
  }
  if ((c.tokens || []).some(x => x.input_tokens || x.output_tokens)) {
    holder.appendChild(h('section', { class: 'card', 'data-testid': 'ct-tokens' }, h('h2', null, '🔢 Tokens'),
      aiTable(c.tokens, [['AI', x => x.name], ['Versions written', x => num(x.versions)], ['Tokens in', x => num(x.input_tokens)], ['Tokens out', x => num(x.output_tokens)], ['Cost', x => x.cost_minor ? `${(x.cost_minor / 100).toFixed(2)} ${c.currency || ''}` : '–']])));
  }
  const len = ui.profileOf().length;
  const est = estimateBox(ui, () => ({ length: len || 'short_story' }), { label: `A new ⚡ run of this length (${len || 'short story'}) would take` });
  holder.appendChild(h('section', { class: 'card' }, h('h2', null, '🔮 Before the next run'), est.el));
  est.refresh();
}

/* ======================================================================= ⏱ P28 estimate before a run */
/** {el, refresh}: "⏱ About 40–80 minutes · 60–120 AI answers" for the body getBody() returns ({length, pipeline}). */
export function estimateBox(ui, getBody, { label = 'This run will probably take' } = {}) {
  const { h, api, clear } = ui;
  const el = h('p', { class: 'small mb-estimate', 'data-testid': 'mb-estimate', 'aria-live': 'polite' }, '⏱ Estimating…');
  let seq = 0;
  const refresh = async () => {
    const mine = ++seq;
    let e;
    try { e = await api('POST', '/estimate', { body: getBody() || {} }); } catch { if (mine === seq) clear(el).appendChild(document.createTextNode('⏱ No estimate right now.')); return; }
    if (mine !== seq) return;
    const m = e.minutes; const c = e.calls;
    clear(el).append(h('span', { 'aria-hidden': 'true' }, '⏱ '), `${label}: about ${minutes(m.low)}–${minutes(m.high)} · ${c.low}–${c.high} AI answers`,
      h('span', { class: 'muted' }, ` (${e.chapters} chapters of ~${num(Math.round(e.words / e.chapters))} words${e.scene_by_scene ? ', written scene by scene' : ''}). ${e.about}`));
  };
  return { el, refresh };
}

/* ======================================================================= ⏱ P28 run window line */
/** "🤖 46 AI answers · 12 min of AI time — AI-1 · Claude 23 (6 min) · AI-2 · ChatGPT 19 (5 min)" for a run. */
export function runCostLine(ui, r) {
  const { h } = ui;
  const c = r && r.costs;
  if (!c || !c.calls) return null;
  return h('p', { class: 'small mb-costs', 'data-testid': 'mb-costs' }, h('span', { 'aria-hidden': 'true' }, '🤖 '),
    `${c.calls} AI answer${c.calls === 1 ? '' : 's'} · ${minutes(c.ai_minutes)} of AI time`,
    c.ais.length ? h('span', { class: 'muted' }, ' — ' + c.ais.map(a => `${a.name} ${a.calls} (${minutes(a.minutes)})${a.failed ? `, ${a.failed} not answered` : ''}`).join(' · ')) : null,
    r.project_id ? [' ', h('a', { href: `#/p/${encodeURIComponent(r.project_id)}/${encodeURIComponent(r.branch_id || 'main')}/costs`, class: 'small', onclick: () => ui.closeMakeBook() }, '⏱ details')] : null);
}
