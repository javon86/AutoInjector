// llm-setup-ui.js — 🎩 Alfred's AI in the 🤵 Butler section: the ONE button ("⚡ Set up Alfred's AI"),
// "🩺 Check everything" (✔ / ⚠ / ✖ rows, each with a Fix button), Start/Stop Ollama, a progress bar +
// log lines, the models on this PC (size, fit, Use / Remove) and the current model.
// Renders into <div id="llm-setup">. Talks to main only through window.api.llm* (preload.js, main.js
// "B6 llm:*" block); does nothing harmful when those are missing (an older build): it says so.
(function () {
  'use strict';
  const root = document.getElementById('llm-setup');
  if (!root) return;
  const api = window.api || {};

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.appendChild(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  }
  const $ = (id) => document.getElementById(id);
  const call = async (name, ...args) => {
    if (typeof api[name] !== 'function') return { ok: false, error: 'This build has no such control yet.' };
    try { const r = await api[name](...args); return r || { ok: false, error: 'No answer.' }; } catch (_) { return { ok: false, error: 'Something went wrong — please try again.' }; }
  };
  const store = {
    get(k) { try { return window.localStorage ? window.localStorage.getItem(k) : null; } catch (_) { return null; } },
    set(k, v) { try { if (window.localStorage) window.localStorage.setItem(k, v); } catch (_) {} },
  };
  function gb(bytes) {
    if (!bytes && bytes !== 0) return '';
    const g = bytes / (1024 ** 3);
    return g >= 10 ? `${Math.round(g)} GB` : g >= 1 ? `${g.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / (1024 ** 2)))} MB`;
  }

  root.classList.add('llm-setup');
  root.textContent = '';
  if (typeof api.llmStatus !== 'function') {
    root.appendChild(h('div', { class: 'llm-sub' }, '🧠 One-button AI setup isn\'t available in this build — use ⚙️ Local model settings below.'));
    return;
  }

  // ------------------------------------------------------------------ layout
  root.append(
    h('div', { class: 'llm-head' },
      h('b', null, '🧠 Alfred\'s AI'),
      h('span', { id: 'llm-current', class: 'llm-current' }, 'Checking…')),
    h('div', { id: 'llm-hw', class: 'llm-sub' }),
    h('div', { class: 'btns llm-btns' },
      h('button', { id: 'llm-btn-go', class: 'primary llm-big', title: 'Uses what you already downloaded — never downloads: starts Ollama, picks your model, loads it, turns Alfred on and opens his panel.' }, '▶ Start Alfred'),
      h('button', { id: 'llm-btn-setup', class: 'llm-setup-btn', title: 'First time only (or for a new model): installs Ollama if needed, then downloads one model that fits this PC — but if you already have a model it uses that and downloads nothing.' }, '⚡ Set up (first time)'),
      h('button', { id: 'llm-btn-scan', title: 'Looks on this PC for Ollama, its model folders, the models it has, and model files (.gguf) other apps downloaded — so nothing gets downloaded twice' }, '🔍 Find what\'s installed'),
      h('label', { class: 'llm-unc', title: 'Pick an uncensored model that still follows instructions (🔓)' }, h('input', { type: 'checkbox', id: 'llm-uncensored' }), ' 🔓 Prefer uncensored'),
      h('label', { class: 'llm-unc', title: 'Every time AutoInjector opens, start Alfred with the model you already have (no download, no clicks)' }, h('input', { type: 'checkbox', id: 'llm-autostart' }), ' Start him when the app opens'),
      h('button', { id: 'llm-btn-check', title: 'Confirm Ollama is installed and running, the model is there, answers and can use tools' }, '🩺 Check everything'),
      h('button', { id: 'llm-btn-start' }, '▶ Start Ollama'),
      h('button', { id: 'llm-btn-stop' }, '⏹ Stop Ollama'),
      h('button', { id: 'llm-btn-cancel', class: 'danger', hidden: true }, '✖ Cancel')),
    h('div', { id: 'llm-progress', class: 'llm-progress', hidden: true },
      h('div', { class: 'llm-bar' }, h('div', { id: 'llm-progress-fill', class: 'llm-fill', style: 'width:0%' })),
      h('div', { id: 'llm-progress-text', class: 'llm-sub' })),
    h('ol', { id: 'llm-steps', class: 'llm-steps' }),
    h('div', { id: 'llm-msg', class: 'llm-msg', role: 'status', 'aria-live': 'polite' }),
    h('div', { id: 'llm-scan', class: 'llm-scan', hidden: true }),
    h('ul', { id: 'llm-check-rows', class: 'llm-rows' }),
    h('details', { id: 'llm-installed-wrap', class: 'llm-installed-wrap' },
      h('summary', null, '📦 Models on this PC'),
      h('div', { id: 'llm-installed', class: 'llm-installed' })),
    h('div', { id: 'llm-log', class: 'llm-log' }));

  const unc = $('llm-uncensored');
  unc.checked = store.get('llm-prefer-uncensored') === '1';
  unc.addEventListener('change', () => store.set('llm-prefer-uncensored', unc.checked ? '1' : '0'));

  // ------------------------------------------------------------------ state + rendering
  let busy = false;
  let last = null;
  function setBusy(on) {
    busy = !!on;
    for (const id of ['llm-btn-go', 'llm-btn-scan', 'llm-btn-setup', 'llm-btn-check', 'llm-btn-start', 'llm-btn-stop']) { const b = $(id); if (b) b.disabled = busy; }
    for (const b of root.querySelectorAll('.llm-fix, .llm-use, .llm-remove, .llm-scan button')) b.disabled = busy;
    $('llm-btn-cancel').hidden = !busy;
    if (!busy) $('llm-progress').hidden = true;
  }
  function msg(text, kind) {
    const m = $('llm-msg');
    m.textContent = text || '';
    m.className = `llm-msg${kind ? ` llm-${kind}` : ''}`;
  }
  function logLine(text, level) {
    if (!text) return;
    const box = $('llm-log');
    box.appendChild(h('div', { class: `llm-line${level ? ` llm-${level}` : ''}` }, String(text)));
    while (box.childNodes.length > 40) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
  function progress(p) {
    const wrap = $('llm-progress');
    wrap.hidden = false;
    const fill = $('llm-progress-fill');
    if (p.percent != null) { fill.style.width = `${Math.max(0, Math.min(100, p.percent))}%`; fill.classList.remove('llm-indet'); }
    else fill.classList.add('llm-indet');
    $('llm-progress-text').textContent = p.message || '';
  }
  const ICON = { done: '✔', failed: '✖', running: '⏳' };
  function renderStep(ev) {
    const list = $('llm-steps');
    let li = list.querySelector(`[data-step="${ev.step}"]`);
    if (!li) { li = h('li', { 'data-step': ev.step }); list.appendChild(li); }
    li.className = `llm-step llm-${ev.state}`;
    li.textContent = `${ICON[ev.state] || '•'} ${ev.label}${ev.message ? ` — ${ev.message}` : ''}`;
  }
  function renderRows(result) {
    const ul = $('llm-check-rows');
    ul.textContent = '';
    if (!result || !Array.isArray(result.rows)) return;
    for (const r of result.rows) {
      const icon = r.ok === true ? '✔' : r.ok === false ? '✖' : '⚠';
      const cls = r.ok === true ? 'ok' : r.ok === false ? 'bad' : 'warn';
      const li = h('li', { class: `llm-row llm-${cls}`, 'data-row': r.id },
        h('span', { class: 'llm-icon', 'aria-hidden': 'true' }, icon), ' ',
        h('b', null, r.label), r.detail ? h('span', { class: 'llm-detail' }, ` — ${r.detail}`) : null);
      if (r.fix && r.fix.action) {
        li.appendChild(document.createTextNode(' '));
        li.appendChild(h('button', { class: 'llm-fix', 'data-action': r.fix.action, onclick: () => runFix(r.fix) }, r.fix.label || 'Fix'));
      }
      ul.appendChild(li);
    }
    if (result.summary) msg(result.summary, result.ok ? 'good' : 'warn');
    if (result.hardware) $('llm-hw').textContent = result.hardware;
  }
  function renderStatus(s) {
    last = s;
    if (!s || s.ok === false) { $('llm-current').textContent = (s && s.error) || 'Status unavailable.'; return; }
    const parts = [];
    parts.push(s.alfred && s.alfred.model ? `model: ${s.alfred.model}` : 'no model chosen');
    parts.push(!s.ollama || !s.ollama.installed ? 'Ollama not installed' : s.server && s.server.running ? `Ollama ${s.ollama.version || ''} running`.replace('  ', ' ') : 'Ollama not running');
    $('llm-current').textContent = parts.join(' · ');
    if (s.hardware) $('llm-hw').textContent = s.hardware;
    $('llm-btn-start').hidden = !!(s.server && s.server.running);
    $('llm-btn-stop').hidden = !(s.server && s.server.running);
    const box = $('llm-installed');
    box.textContent = '';
    const models = Array.isArray(s.models) ? s.models : [];
    if (!models.length) box.appendChild(h('div', { class: 'llm-sub' }, s.server && s.server.running ? 'No models downloaded yet — press ⚡ Set up (first time), or find one below.' : 'Start Ollama to see the models on this PC.'));
    const mine = s.alfred && s.alfred.model;
    const key = (m) => { const t = String(m || '').toLowerCase(); return t.includes(':') ? t : `${t}:latest`; };
    for (const m of models) {
      const current = mine && key(m.name) === key(mine);
      box.appendChild(h('div', { class: `llm-model${current ? ' llm-current-model' : ''}`, 'data-model': m.name },
        h('span', { class: 'llm-mname' }, `${current ? '★ ' : ''}${m.name}`),
        m.uncensored ? h('span', { class: 'llm-badge', title: 'uncensored' }, '🔓') : null,
        h('span', { class: 'llm-sub' }, ` ${m.sizeText || gb(m.sizeBytes)}${m.params ? ` · ${m.params}` : ''}`),
        m.fit ? h('span', { class: `llm-fit llm-fit-${m.fit.rating}`, title: m.fit.reason || '' }, ` ${m.fit.label}`) : null,
        h('span', { class: 'spacer' }),
        current ? h('span', { class: 'llm-sub' }, ' in use') : h('button', { class: 'llm-use', onclick: () => useModel(m.name) }, 'Use'),
        h('button', { class: 'llm-remove', title: `Delete ${m.name} from this PC`, onclick: () => removeModel(m.name) }, 'Remove')));
    }
    if (s.busy && !busy) setBusy(true);
    if (!s.busy && busy && !running) setBusy(false);
  }

  // ------------------------------------------------------------------ actions
  let running = false;
  async function refresh() { renderStatus(await call('llmStatus')); }
  let refreshTimer = null;
  function refreshSoon() { if (refreshTimer) clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 300); }
  async function task(fn) {
    if (running) return null;
    running = true; setBusy(true);
    try { return await fn(); } finally { running = false; setBusy(false); refresh(); }
  }
  async function setupAll() {
    $('llm-steps').textContent = '';
    $('llm-check-rows').textContent = '';
    msg('Setting up Alfred\'s AI — this can take a while the first time (it downloads a few GB).');
    const r = await task(() => call('llmSetupAll', { uncensored: unc.checked }));
    if (!r) return;
    if (r.check) renderRows(r.check);
    msg(r.ok ? (r.summary || '✓ Ready.') : (r.error || r.summary || 'The setup stopped.'), r.ok ? 'good' : 'bad');
    if (!r.ok && r.fix && r.fix.action) {
      const m = $('llm-msg');
      m.appendChild(document.createTextNode(' '));
      m.appendChild(h('button', { class: 'llm-fix', 'data-action': r.fix.action, onclick: () => runFix(r.fix) }, r.fix.label || 'Try again'));
    }
  }
  async function check() {
    msg('Checking everything…');
    const r = await task(() => call('llmCheck'));
    if (!r) return;
    if (Array.isArray(r.rows)) renderRows(r); else msg(r.error || r.summary || 'The check didn\'t finish.', 'bad');
  }
  async function runFix(fix) {
    msg(`${fix.label || 'Fixing'}…`);
    const r = await task(() => call('llmFix', fix));
    if (!r) return;
    msg(r.ok ? (r.message || r.summary || '✓ Done.') : (r.error || 'That didn\'t work.'), r.ok ? 'good' : 'bad');
    if (r.ok) { const c = await task(() => call('llmCheck', { quick: false })); if (c && Array.isArray(c.rows)) renderRows(c); }
  }
  async function start() { const r = await task(() => call('llmStart')); if (r) msg(r.ok ? r.message : r.error, r.ok ? 'good' : 'bad'); }
  async function stop() { const r = await task(() => call('llmStop')); if (r) msg(r.ok ? r.message : r.error, r.ok ? 'good' : 'bad'); }
  async function useModel(name) {
    msg(`Switching Alfred to ${name}…`);
    const r = await task(() => call('llmUse', { name }));
    if (r) msg(r.ok ? r.message : (r.error || r.message), r.ok ? 'good' : 'bad');
  }
  async function removeModel(name) {
    let sure = true;
    try { if (typeof window.confirm === 'function') sure = window.confirm(`Delete ${name} from this PC? You can download it again later.`); } catch (_) { sure = true; }
    if (!sure) return;
    const r = await task(() => call('llmRemove', name));
    if (r) msg(r.ok ? r.message : r.error, r.ok ? 'good' : 'bad');
  }

  async function go() {
    $('llm-steps').textContent = '';
    msg('Starting Alfred with what you already have…');
    const r = await task(() => call('llmStartAlfred'));
    if (!r) return;
    msg(r.ok ? r.message : (r.error || 'Alfred didn\'t start.'), r.ok ? 'good' : 'bad');
    if (!r.ok && r.fix && r.fix.action) {
      const m = $('llm-msg');
      m.appendChild(document.createTextNode(' '));
      m.appendChild(h('button', { class: 'llm-fix', 'data-action': r.fix.action, onclick: () => (r.fix.action === 'setup' ? setupAll() : runFix(r.fix)) }, r.fix.label || 'Fix'));
    }
  }
  // 🔍 what is already on this PC — every find has a button to use it (nothing is downloaded)
  function renderScan(r) {
    const box = $('llm-scan');
    box.textContent = '';
    box.hidden = false;
    box.append(h('div', { class: 'llm-scan-head' }, h('b', null, '🔍 Already on this PC'), ' ', h('span', { class: 'llm-sub' }, r.summary || ''), h('span', { class: 'spacer' }), h('button', { class: 'llm-scan-close', title: 'Hide', onclick: () => { box.hidden = true; } }, '×')));
    if (!r.ollama || !r.ollama.installed) box.append(h('div', { class: 'llm-sub' }, '✖ Ollama isn\'t installed — ', h('button', { onclick: setupAll }, '⚡ Set up (first time)')));
    else box.append(h('div', { class: 'llm-sub' }, `✔ Ollama ${r.ollama.version || ''}${r.ollama.bin ? ` — ${r.ollama.bin}` : ''}`));
    const mine = r.alfredModel;
    const key = (m) => { const t = String(m || '').toLowerCase(); return t.includes(':') ? t : `${t}:latest`; };
    for (const sv of r.servers || []) {
      box.append(h('div', { class: 'llm-scan-group' }, `🟢 ${sv.where}: ${sv.models.length} model${sv.models.length === 1 ? '' : 's'}`));
      for (const m of sv.models) {
        const cur = mine && key(m.name) === key(mine);
        box.append(h('div', { class: 'llm-model', 'data-scan-model': m.name },
          h('span', { class: 'llm-mname' }, `${cur ? '★ ' : ''}${m.name}`), h('span', { class: 'llm-sub' }, ` ${m.sizeText || gb(m.sizeBytes)}`),
          m.fit ? h('span', { class: `llm-fit llm-fit-${m.fit.rating}`, title: m.fit.reason || '' }, ` ${m.fit.label}`) : null,
          h('span', { class: 'spacer' }),
          cur ? h('span', { class: 'llm-sub' }, 'in use') : h('button', { class: 'llm-use', onclick: () => useModel(m.name) }, 'Use')));
      }
    }
    for (const st of (r.stores || []).filter((x) => x.hasModels && !x.inUse)) {
      box.append(h('div', { class: 'llm-model', 'data-scan-store': st.dir },
        h('span', { class: 'llm-mname' }, `📁 ${st.label}`), h('span', { class: 'llm-sub' }, ` ${st.dir}`), h('span', { class: 'spacer' }),
        h('button', { title: 'Run AutoInjector\'s Ollama on this folder, so its models are ready without downloading', onclick: async () => { msg('Switching to that folder…'); const x = await task(() => call('llmUseStore', st.dir)); if (x) { msg(x.ok ? x.message : x.error, x.ok ? 'good' : 'bad'); if (x.ok) scan(); } } }, 'Use this folder')));
    }
    if ((r.ggufs || []).length) box.append(h('div', { class: 'llm-scan-group' }, '📄 Model files other apps downloaded (Ollama can take them in — no download):'));
    for (const g of r.ggufs || []) {
      box.append(h('div', { class: 'llm-model', 'data-scan-gguf': g.path },
        h('span', { class: 'llm-mname', title: g.path }, g.file), h('span', { class: 'llm-sub' }, ` ${g.sizeText || gb(g.sizeBytes)} · ${g.from}`), h('span', { class: 'spacer' }),
        h('button', { onclick: async () => { msg(`Adding ${g.file} to Ollama…`); const x = await task(() => call('llmImportGguf', g.path, g.suggestedName)); if (x) { msg(x.ok ? x.message : x.error, x.ok ? 'good' : 'bad'); if (x.ok) scan(); } } }, '➕ Add to Ollama')));
    }
  }
  async function scan() {
    msg('Looking for what is already installed on this PC…');
    const r = await task(() => call('llmScan'));
    if (!r) return;
    if (r.ok === false) { msg(r.error || 'I couldn\'t look.', 'bad'); return; }
    renderScan(r);
    msg(r.summary, 'good');
  }
  $('llm-btn-scan').addEventListener('click', scan);
  $('llm-btn-go').addEventListener('click', go);
  const auto = $('llm-autostart');
  if (typeof api.alfredStatus === 'function') Promise.resolve(api.alfredStatus()).then((st) => { auto.checked = !!(st && st.settings && st.settings.autoStart); }).catch(() => {});
  auto.addEventListener('change', () => { if (typeof api.alfredSettings === 'function') Promise.resolve(api.alfredSettings({ autoStart: auto.checked })).catch(() => {}); msg(auto.checked ? '✓ Alfred will start by himself when AutoInjector opens (with the model you already have).' : 'Alfred won\'t start by himself.', 'good'); });
  $('llm-btn-setup').addEventListener('click', setupAll);
  $('llm-btn-check').addEventListener('click', check);
  $('llm-btn-start').addEventListener('click', start);
  $('llm-btn-stop').addEventListener('click', stop);
  $('llm-btn-cancel').addEventListener('click', () => { call('llmCancel'); msg('Cancelling…'); });

  // ------------------------------------------------------------------ live events from main
  if (typeof api.onLlm === 'function') {
    api.onLlm((ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'progress') progress(ev);
      else if (ev.type === 'step' && ev.task === 'start-alfred') msg(ev.message);
      else if (ev.type === 'step') { renderStep(ev); if (ev.state === 'running') msg(ev.message); }
      else if (ev.type === 'log') logLine(ev.message, ev.level);
      else if (ev.type === 'done') {
        logLine(ev.message, ev.ok ? 'good' : 'bad'); refreshSoon();
        if (ev.message && typeof window.appendButlerLine === 'function') { try { window.appendButlerLine({ cls: 'bl-butler', who: '🧠 His AI', text: `${ev.ok ? '✔' : '✖'} ${ev.message}` }); } catch (_) {} }
      }
      else if (ev.type === 'check' && ev.result && !running) renderRows(ev.result);
      else if (ev.type === 'models-changed' || ev.type === 'model-changed' || ev.type === 'server') refreshSoon();
    });
  }

  // 📁 Downloads in ANOTHER AutoInjector folder (an earlier copy): use them instead of downloading again.
  async function renderContentOthers(fresh) {
    const box = document.getElementById('content-others');
    if (!box || typeof api.contentRoots !== 'function') return null;
    const r = await call('contentRoots', !!fresh);
    box.textContent = '';
    const others = (r && r.ok && Array.isArray(r.others)) ? r.others : [];
    box.hidden = !others.length;
    if (!others.length) return r;
    box.append(h('div', null, h('b', null, '📁 Your downloads are also in another AutoInjector folder'), ' — use it so nothing has to be downloaded again:'));
    for (const o of others) {
      box.append(h('div', { class: 'co-row', 'data-root': o.root },
        h('span', { title: o.dir }, o.dir), h('span', { class: 'llm-sub' }, ` ${(o.what || []).join(', ')}${o.bytes ? ` · ${gb(o.bytes)}` : ''}`),
        h('button', { class: 'co-use', onclick: async () => {
          let sure = true; try { if (typeof window.confirm === 'function') sure = window.confirm(`Use ${o.dir} for downloads and creations? AutoInjector restarts.`); } catch (_) { sure = true; }
          if (!sure) return;
          const x = await call('contentUseRoot', o.root);
          msg(x && x.ok ? x.message : ((x && x.error) || 'That didn\'t work.'), x && x.ok ? 'good' : 'bad');
        } }, 'Use this folder (restarts)')));
    }
    box.append(h('div', { class: 'co-row' }, h('span', { class: 'llm-sub' }, `In use now: ${r.dir}`),
      h('button', { class: 'co-keep', onclick: async () => { const x = await call('contentUseRoot', r.current, true); if (x && x.ok) { box.hidden = true; msg('✓ Keeping the folder in use now.', 'good'); } } }, 'Keep this one')));
    return r;
  }
  renderContentOthers(false);

  // 📁 Where everything is (in ⚙ More settings → Downloads & creations folder): every place, with Open.
  async function renderFolders() {
    const box = document.getElementById('folders-map');
    if (!box || typeof api.foldersMap !== 'function') return;
    box.textContent = 'Looking…';
    const r = await call('foldersMap');
    box.textContent = '';
    if (!r || !r.ok) { box.append(h('div', { class: 'llm-sub' }, (r && r.error) || 'I couldn\'t list the folders.')); return; }
    for (const row of r.rows || []) {
      box.append(h('div', { class: `fm-row${row.inStuff ? '' : ' fm-out'}`, 'data-folder': row.path },
        h('b', null, row.what), row.bytes ? h('span', { class: 'llm-sub' }, ` ${gb(row.bytes)}`) : null,
        h('span', { class: 'fm-path' }, row.path),
        row.exists ? h('button', { onclick: () => call('foldersOpen', row.path) }, 'Open') : h('span', { class: 'llm-sub' }, '(not made yet)'),
        row.note ? h('div', { class: 'llm-sub', style: 'flex-basis:100%' }, row.note) : null));
    }
    if (r.comfy && r.comfy.where === 'legacy') {
      box.append(h('div', { class: 'fm-row' }, h('button', { class: 'primary', onclick: async () => {
        let sure = true; try { if (typeof window.confirm === 'function') sure = window.confirm('Move ComfyUI and its models into "stuff and thing"? Stop ComfyUI first. AutoInjector restarts afterwards.'); } catch (_) { sure = true; }
        if (!sure) return;
        const x = await call('foldersMoveComfy');
        msg(x && x.ok ? x.message : ((x && x.error) || 'The move didn\'t work.'), x && x.ok ? 'good' : 'bad');
        renderFolders();
      } }, '📦 Move ComfyUI into "stuff and thing"')));
    }
  }
  const fmWrap = document.getElementById('folders-map-wrap');
  if (fmWrap) fmWrap.addEventListener('toggle', () => { if (fmWrap.open) renderFolders(); });

  // Other panels (🎩 "⚙ Set up his AI", the model finder) can ask for a refresh / a check.
  window.llmSetupUI = { refresh, check, setupAll, start: go, scan, contentOthers: renderContentOthers, folders: renderFolders, status: () => last };
  refresh();
})();
