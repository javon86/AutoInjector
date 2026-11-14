'use strict';
// test/alfred-team-ui.test.js — 👥 Alfred's team in the control panel (jsdom, the real controls.html with
// alfred-panel.js + alfred-team.js + alfred-team-ui.js and a stub window.api):
//   - the one-line "team ready" status on the 🤖 AutoInjector tab: only while Alfred is on, the exact words,
//     ⚠ with the fix, hover = each role's model, a click opens his ⚙ settings at the team;
//   - the team panel in his ⚙ settings and in the 🎩 Butler section: one row per role (icon, name, what it is for),
//     a dropdown of the DOWNLOADED models only (+ "the Butler's model"), ★ with the reasons on hover, the 💡
//     suggestion with "Use it", "✨ Pick the best for each role", a non-local brain explained;
//   - who answered, on his replies and on the card ("🎨 Prompt writer (qwen2.5:14b)"), and the busy line per role.
// Run: node test/alfred-team-ui.test.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const team = require('../alfred-team');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GB = 1024 ** 3;
const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const HW = { bestVramMB: 16303, ramMB: 32768, gpus: [{ name: 'NVIDIA GeForce RTX 5070 Ti', vramMB: 16303 }] };
const MODELS = [{ name: 'qwen2.5:14b', sizeBytes: 9 * GB }, { name: 'qwen3:14b', sizeBytes: 9.3 * GB }, { name: 'dolphin3:8b', sizeBytes: 4.9 * GB }, { name: 'qwen2.5:3b', sizeBytes: 1.9 * GB }];
/** A team status like alfred.teamStatus() builds it (the real ratings / suggestions / line). */
function teamStatus({ local = true, chosen = {}, problem = null, run = null, book = { title: 'The Lighthouse Keeper' } } = {}) {
  const ctx = { hw: HW };
  const butler = chosen.butler || 'qwen2.5:14b';
  const roles = team.ROLES.map((info) => {
    const own = info.id === 'butler' ? butler : chosen[info.id] || '';
    const model = own || butler;
    const r = { id: info.id, icon: info.icon, name: info.name, for: info.for, model, own: !!own, chosen: own, loaded: model === butler };
    r.state = problem === info.id ? 'problem' : !local ? 'ok' : own ? 'ok' : 'unset';
    r.fix = r.state === 'problem' ? `${model} isn't downloaded — pick a downloaded one in ⚙ Alfred's team.` : '';
    if (r.state === 'unset') r.note = `uses the Butler's model (${butler})`;
    r.rating = team.rate(info.id, MODELS.find((m) => m.name === model) || { name: model }, ctx);
    r.ratings = {}; for (const m of MODELS) { const x = team.rate(info.id, m, ctx); r.ratings[m.name] = { stars: x.stars, text: x.text }; }
    r.suggestion = local ? team.suggest(info.id, model, MODELS, ctx) : null;
    return r;
  });
  const line = team.teamLine({ enabled: true, local, brainWord: local ? null : 'Claude (web pane)', roles, book, run });
  return { ok: true, enabled: true, local, brain: local ? 'local' : 'pane', brainWord: local ? null : 'Claude (web pane)', ollama: true, roles, line, book, run, hw: { vramMB: 16303, gpu: 'NVIDIA GeForce RTX 5070 Ti' }, models: MODELS.map((m) => ({ name: m.name, sizeBytes: m.sizeBytes, sizeText: team.gbText(m.sizeBytes), loaded: m.name === 'qwen2.5:14b' })) };
}

async function main() {
  const dom = new JSDOM(SRC('controls.html'), { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; const d = w.document;
  const calls = [];
  const listeners = [];
  const alfredState = (extra) => Object.assign({ ok: true, enabled: true, settings: { brain: 'local', local: { endpoint: '', model: 'qwen2.5:14b' }, team: {}, pane: { site: 'chatgpt' }, maxSteps: 8, notices: true, interpreter: false, alwaysAllow: {}, personality: { name: 'Alfred' }, panel: { open: true }, profiles: [] }, chat: [], activity: [], card: null, busy: false, ai: {}, connected: {} }, extra || {});
  let cur = alfredState({ enabled: false });
  let ts = teamStatus();
  w.api = {
    alfredStatus: async () => cur, alfredSetEnabled: async (on) => { cur = alfredState({ enabled: on }); return cur; }, onAlfred: (cb) => { listeners.push(cb); }, syncPanes: async () => { calls.push(['syncPanes']); return { ok: true }; },
    alfredModels: async () => ({ ok: true, models: MODELS.map((m) => m.name) }), alfredSettings: async (p) => { calls.push(['settings', p]); return cur.settings; },
    alfredTeam: async () => { calls.push(['team']); return Object.assign({}, ts, { enabled: cur.enabled }); },
    alfredTeamSet: async (role, model) => { calls.push(['set', role, model]); ts = teamStatus({ chosen: { [role]: model } }); return Object.assign(ts, { message: `${team.byId(role).icon} ${team.byId(role).name}: ${model}.` }); },
    alfredTeamBest: async () => { calls.push(['best']); ts = teamStatus({ chosen: { director: 'qwen3:14b', badboy: 'dolphin3:8b', assistant: 'qwen2.5:14b', prompt: 'qwen2.5:14b' } }); return Object.assign(ts, { message: 'Done — … (Nothing was downloaded.)' }); },
    alfredPanelToggle: async () => ({ ok: true }),
  };
  const emit = (p) => { for (const cb of listeners) cb(p); };
  w.eval(SRC('alfred-format.js'));
  w.eval(SRC('alfred-panel.js'));
  w.eval(SRC('alfred-team.js'));
  w.eval(SRC('alfred-team-ui.js'));
  await sleep(40);

  console.log('\n== the "team ready" line on the 🤖 AutoInjector tab ==');
  const line = d.getElementById('alfred-team-line');
  assert(line && line.parentNode === d.getElementById('wrap') && line.nextElementSibling === d.getElementById('col-userpanel'), 'it sits at the top of the main tab, above the User Panel and the AI windows');
  assert(line.hidden, 'Alfred off: no line');
  cur = alfredState(); emit({ type: 'state', state: cur }); await sleep(40);
  const text = line.querySelector('.atl-text').textContent;
  assert(!line.hidden && text === "🎩 Alfred's team is connected and working for your book “The Lighthouse Keeper”: Butler ✔ · Assistant ⚪ · Director ⚪ · Prompt writer ⚪ · Bad boy ⚪", `Alfred on: "${text}"`);
  assert(line.dataset.tone === 'ok' && /🧰 Assistant: qwen2\.5:14b \(uses the Butler's model/.test(line.title), 'hover: each role and its model');
  assert(calls.some((c) => c[0] === 'syncPanes'), 'the AI windows are re-placed when the line appears');
  ts = teamStatus({ chosen: { director: 'gone:9b' }, problem: 'director' });
  w.AlfredTeamUI.refresh(); await sleep(30);
  assert(/needs a hand/.test(line.querySelector('.atl-text').textContent) && /Director ⚠/.test(line.textContent) && /gone:9b isn't downloaded — pick a downloaded one/.test(line.textContent) && line.dataset.tone === 'warn', `⚠ with a plain fix: ${line.querySelector('.atl-text').textContent}`);
  ts = teamStatus({ run: { title: 'The Lighthouse Keeper', live: true } });
  w.AlfredTeamUI.refresh(); await sleep(30);
  assert(/standing by for your book “The Lighthouse Keeper” while Akọwe writes it/.test(line.textContent), 'a book being written: the team stands by for it');

  console.log('\n== the team panel in his ⚙ settings ==');
  d.getElementById('alfred-team-line-open').click(); await sleep(40);
  const box = d.getElementById('alfred-team');
  assert(box && !d.getElementById('alfred-settings').hidden && box.querySelectorAll('.at-role').length === 5, '"👥 Team" opens his ⚙ settings with the five roles');
  const row = (id) => box.querySelector(`.at-role[data-role="${id}"]`);
  assert(row('badboy').querySelector('.at-ic').textContent === '😈' && /Bad boy/.test(row('badboy').querySelector('.at-name').textContent) && /uncensored/i.test(row('badboy').querySelector('.at-for').textContent), 'a row: icon, name, what it is for');
  const sel = row('director').querySelector('select.at-model');
  const opts = Array.from(sel.options);
  assert(opts.length === MODELS.length + 1 && opts[0].value === '' && /the Butler's model \(Qwen2\.5 14B\)/.test(opts[0].textContent) && opts.slice(1).every((o) => MODELS.some((m) => m.name === o.value)), `downloaded models only, plus "the Butler's model" (${opts.map((o) => o.textContent).join(' | ')})`);
  assert(/Qwen3 14B · 9\.3 GB · ★+☆*/.test(opts.find((o) => o.value === 'qwen3:14b').textContent), 'each model: name, size and its ★ for this role');
  assert(row('butler').querySelector('select.at-model').options[0].value !== '', 'the Butler has no "Butler\'s model" choice');
  const stars = row('badboy').querySelector('.at-stars');
  assert(/^★+☆*$/.test(stars.textContent) && /for the Bad boy: .*Not uncensored: it will refuse/.test(stars.title), `★ with the reasons on hover: "${stars.title.slice(0, 90)}…"`);
  const sug = row('badboy').querySelector('.at-suggest');
  assert(sug && /💡 Dolphin3 8B fits the Bad boy better \(★5 vs ★\d\)/.test(sug.textContent), `💡 suggestion: ${sug && sug.textContent}`);
  sug.querySelector('button.at-use').click(); await sleep(30);
  assert(calls.some((c) => c[0] === 'set' && c[1] === 'badboy' && c[2] === 'dolphin3:8b'), '"Use it" gives the Bad boy that model');
  assert(/😈 Bad boy: dolphin3:8b/.test(box.querySelector('.at-msg').textContent) && box.querySelector('.at-role[data-role="badboy"] .at-state').dataset.state === 'ok', 'said, and the row shows ✔ now');
  const dsel = box.querySelector('.at-role[data-role="director"] select.at-model');
  dsel.value = 'qwen3:14b'; dsel.dispatchEvent(new w.Event('change')); await sleep(30);
  assert(calls.some((c) => c[0] === 'set' && c[1] === 'director' && c[2] === 'qwen3:14b'), 'choosing in the dropdown sets the role\'s model');
  box.querySelector('button.at-best').click(); await sleep(30);
  assert(calls.some((c) => c[0] === 'best') && /Nothing was downloaded/.test(box.querySelector('.at-msg').textContent), '✨ Pick the best for each role (nothing downloaded)');
  const host = d.getElementById('alfred-team-panel');
  assert(host && host.querySelectorAll('.at-role').length === 5, 'the same panel in the 🎩 Butler section');
  assert(/RTX 5070 Ti, 16 GB/.test(box.textContent) && /Only one big model is kept in it at a time/.test(box.textContent), 'the graphics card and the one-big-model rule are explained');

  console.log('\n== a web-pane brain: every role thinks with it ==');
  ts = teamStatus({ local: false });
  w.AlfredTeamUI.refresh(); await sleep(30);
  assert(/every role thinks with it/.test(box.textContent) && box.querySelector('select.at-model').disabled && box.querySelector('button.at-best').disabled, 'explained; the dropdowns and Pick the best wait for a local model');
  assert(/all roles think with Claude \(web pane\)/.test(line.textContent), 'the line says so too');

  console.log('\n== who answered (his replies, the card) and the busy line ==');
  cur = alfredState({ chat: [{ role: 'you', text: 'bad boy, roast me', ts: 1 }, { role: 'alfred', text: 'Wicked words.', ts: 2, by: { role: 'badboy', icon: '😈', name: 'Bad boy', model: 'dolphin3:8b' } }],
    card: { id: 'card-1', by: { role: 'prompt', icon: '🎨', name: 'Prompt writer', model: 'qwen2.5:14b' }, intro: '🎨 Prompt writer (qwen2.5:14b) wrote this prompt: “a fox”', doLabel: '🎨 Make it now', steps: [{ n: 1, tool: 'generate_image', title: 'Generate an image', text: 'Make an image of “a fox”', allowAlways: true, allowKey: 'generate_image' }] } });
  emit({ type: 'state', state: cur }); await sleep(20);
  d.getElementById('alfred-set-close').click(); await sleep(10);
  const by = d.querySelector('#alfred-chat .al-alfred .al-by');
  assert(by && by.textContent === '😈 Bad boy (dolphin3:8b)' && by.dataset.by === 'badboy', `his reply says who: "${by && by.textContent}"`);
  const cby = d.querySelector('#alfred-card .al-by');
  assert(cby && cby.textContent === '🎨 Prompt writer (qwen2.5:14b)', 'the card says who wrote it');
  cur = alfredState({ busy: true, progress: { doing: 'thinking', role: 'director', elapsedMs: 3000, brain: 'local' } });
  emit({ type: 'state', state: cur }); await sleep(20);
  assert(/🎬 The Director is planning…/.test(d.getElementById('alfred-busy-text').textContent), `busy: ${d.getElementById('alfred-busy-text').textContent}`);

  console.log('\n== Alfred off again: the line goes ==');
  cur = alfredState({ enabled: false }); emit({ type: 'state', state: cur }); await sleep(20);
  assert(line.hidden, 'no line while he is off');

  console.log('\n== an older main without alfred:team: nothing breaks ==');
  {
    const dom2 = new JSDOM(SRC('controls.html'), { runScripts: 'outside-only' });
    dom2.window.api = { alfredStatus: async () => alfredState() };
    let err = null; try { dom2.window.eval(SRC('alfred-team.js')); dom2.window.eval(SRC('alfred-team-ui.js')); } catch (e) { err = e; }
    assert(!err && !dom2.window.document.getElementById('alfred-team-line'), 'the script quietly does nothing');
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
