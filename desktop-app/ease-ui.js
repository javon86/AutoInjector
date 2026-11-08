// ease-ui.js — ✅ Setup checklist, 🩺 Something's wrong?, 🧭 guided tours and the ❓ Help button in the title bar.
// Vanilla JS, no libraries. It talks to main only through window.api.ease (ease-main.js) and a few existing
// window.api calls (open the Setup Wizard, sync the AI panes). The AI panes and the Akọwe page are native views
// that float above this page: each pop-up here is role="dialog", so main hides those views while it is open
// (pane-layout.js), and we ask for a re-sync whenever one opens or closes.
//
//   createEaseUI(api, doc?) -> { openChecklist, openProblems, closeOverlay, startTour, replayTours, runFix, TOURS, state }
//   (it starts by itself once window.api is there; the unit test calls createEaseUI with a stub api)
(function () {
  'use strict';

  const CSS = `
  #btn-ease-help { flex:0 0 auto; font-size:12px; padding:3px 10px; margin-right:8px; border-radius:7px; border:1px solid #2a2a2a; background:#151515; color:#cfcfcf; cursor:pointer; white-space:nowrap; }
  #btn-ease-help:hover { border-color:#3a3a3a; background:#1d1d1d; }
  #btn-ease-help:focus-visible, .ease-menu button:focus-visible, .ease-box button:focus-visible { outline:2px solid #7c5ce0; outline-offset:1px; }
  .ease-menu { position:fixed; z-index:10050; min-width:220px; background:#1a1a1a; border:1px solid #333; border-radius:8px; padding:4px; box-shadow:0 8px 24px rgba(0,0,0,.5); }
  .ease-menu button { display:block; width:100%; text-align:left; background:none; border:0; color:#e8e8e8; padding:6px 10px; border-radius:6px; font-size:13px; cursor:pointer; }
  .ease-menu button:hover { background:#262626; }
  .ease-overlay { position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,.6); display:flex; align-items:center; justify-content:center; padding:16px; }
  .ease-box { width:min(980px, 100%); max-height:calc(100vh - 32px); display:flex; flex-direction:column; background:#151515; border:1px solid #333; border-radius:10px; box-shadow:0 12px 40px rgba(0,0,0,.6); color:#eee; }
  .ease-head { display:flex; align-items:center; gap:10px; padding:10px 14px; border-bottom:1px solid #2a2a2a; }
  .ease-head h2 { margin:0; font-size:15.5px; flex:1 1 auto; }
  .ease-sum { font-size:12.5px; opacity:.9; }
  .ease-body { overflow:auto; padding:6px 14px 8px; flex:1 1 auto; min-height:0; }
  .ease-group { margin:6px 0 1px; font-size:11.5px; letter-spacing:.04em; text-transform:uppercase; color:#9fb0a4; }
  .ease-row { display:flex; align-items:center; gap:10px; padding:4px 8px; border:1px solid #242424; border-radius:7px; margin:3px 0; background:#181818; }
  .ease-row[data-optional="true"][data-ok="false"] { border-color:#3a3a3a; background:#181818; }
  .ease-row[data-ok="true"] { border-color:#24402c; }
  .ease-row[data-ok="false"] { border-color:#5a2a2a; background:#1d1515; }
  .ease-ic { flex:0 0 22px; font-size:15px; text-align:center; }
  .ease-txt { flex:1 1 auto; min-width:0; font-size:12.5px; line-height:1.35; }
  .ease-txt b { font-size:13px; }
  .ease-txt .ease-msg { color:#f3dfa6; }
  .ease-row button, .ease-foot button { flex:0 0 auto; font-size:12px; padding:4px 10px; border-radius:6px; border:1px solid #3a3a3a; background:#202020; color:#eee; cursor:pointer; white-space:nowrap; }
  .ease-row button.primary, .ease-foot button.primary { background:#1f3a28; border-color:#3f6b4c; }
  .ease-foot { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:9px 14px; border-top:1px solid #2a2a2a; font-size:12.5px; }
  .ease-foot .sp { flex:1 1 auto; }
  .ease-foot label { display:inline-flex; align-items:center; gap:5px; cursor:pointer; }
  .ease-x { background:none; border:0; color:#ccc; font-size:16px; cursor:pointer; padding:2px 6px; }
  .ease-none { padding:16px 6px; font-size:14px; color:#9fe7b5; }
  .ease-report { font-size:12px; word-break:break-all; }
  #ease-toast { position:fixed; z-index:10060; left:50%; bottom:22px; transform:translateX(-50%); max-width:min(640px, calc(100vw - 32px)); background:#1d2a20; border:1px solid #3f6b4c; color:#e9fff0; padding:8px 14px; border-radius:8px; font-size:13px; box-shadow:0 6px 20px rgba(0,0,0,.5); }
  #ease-toast[hidden] { display:none; }
  .ease-flash { outline:3px solid #e0b84a !important; outline-offset:-3px; }
  #ease-tour { position:fixed; inset:0; z-index:10040; pointer-events:none; }
  #ease-tour .ease-hole { position:fixed; border-radius:8px; box-shadow:0 0 0 9999px rgba(0,0,0,.55); outline:2px solid #e0b84a; pointer-events:none; transition:all .15s ease; }
  #ease-tour .ease-tip { position:fixed; width:min(320px, calc(100vw - 24px)); background:#1b1b26; border:1px solid #7c5ce0; border-radius:9px; padding:10px 12px; color:#f0f0f0; font-size:13px; line-height:1.45; pointer-events:auto; box-shadow:0 8px 28px rgba(0,0,0,.6); }
  #ease-tour .ease-tip::before { content:''; position:absolute; width:12px; height:12px; background:#1b1b26; border-left:1px solid #7c5ce0; border-top:1px solid #7c5ce0; transform:rotate(45deg); left:var(--ax, 20px); }
  #ease-tour .ease-tip[data-side="below"]::before { top:-7px; }
  #ease-tour .ease-tip[data-side="above"]::before { bottom:-7px; transform:rotate(225deg); }
  #ease-tour .ease-tip-n { font-size:11px; opacity:.75; margin-bottom:3px; }
  #ease-tour .ease-tip-btns { display:flex; gap:6px; margin-top:8px; align-items:center; }
  #ease-tour .ease-tip-btns .sp { flex:1 1 auto; }
  #ease-tour .ease-tip-btns button { font-size:12px; padding:3px 10px; border-radius:6px; border:1px solid #3a3a3a; background:#232331; color:#eee; cursor:pointer; }
  #ease-tour .ease-tip-btns button.primary { background:#3b2f73; border-color:#7c5ce0; }
  @media (prefers-reduced-motion: reduce) { #ease-tour .ease-hole { transition:none; } }
  `;

  // One sentence per step; a step whose target is not on the screen is left out.
  const TOURS = {
    main: { title: 'AutoInjector', steps: [
      { sel: '#up-zone-compose', text: 'Type your message here, then click an AI\'s name (or → All) to send it.' },
      { sel: '#send-active-grid', text: 'Send to one AI or to all of them. Untick Active to leave an AI out.' },
      { sel: '#ai-row', text: 'These are the real ChatGPT, Claude and Gemini websites. Sign in once in each; they remember you.' },
      { sel: '#app-tabs', text: '📖 Akọwe writes your books, 🎨 Images makes pictures and 🎬 Video makes short clips.' },
      { sel: '#btn-ease-help', text: 'Stuck? ❓ Help has the setup checklist, "Something\'s wrong?" and the user guide.' },
    ] },
    akowe: { title: '📖 Akọwe', steps: [
      { sel: '#tab-app-akowe', text: 'This is Akọwe, the book writer. It starts together with AutoInjector.' },
      { sel: '#akowe-tab-state', text: 'This line says whether Akọwe is running.' },
      { sel: '#akowe-slot', text: 'Akọwe\'s own pages show here: start one with ➕ New book, or let the AI write it all with ⚡ AI writes the whole book.' },
      { sel: '#btn-akowe-reload', text: 'If the page looks stuck, press ↻ Reload. ⇱ Pop out gives Akọwe its own window.' },
    ] },
    images: { title: '🎨 Images', steps: [
      { sel: '#sd-engine', text: 'Choose who draws: Stable Diffusion on your PC, ChatGPT, or Auto.' },
      { sel: '#sd-prompt', text: 'Describe the picture you want here.' },
      { sel: '#btn-sd-generate', text: 'Press 🎨 Generate to make it. Pictures are saved in "stuff and thing/images".' },
      { sel: '#sd-sub-setup', text: 'No Stable Diffusion yet? ⚙ Start & install finds, starts or installs one.' },
    ] },
    video: { title: '🎬 Video', steps: [
      { sel: '#vd-sub-setup', text: '⚙ Setup & models: connect FramePack or install ComfyUI and a Wan video model.' },
      { sel: '#vd-prompt', text: 'Describe what happens in the clip.' },
      { sel: '#btn-vd-generate', text: 'Press 🎬 Make video. Clips are saved in "stuff and thing/videos".' },
      { sel: '#vd-sub-trailer', text: '🎞 Trailer joins shots and title cards into a book trailer.' },
      { sel: '#vd-sub-selftest', text: '🩺 Test pictures & video checks that everything works, with tips for anything that fails.' },
    ] },
    alfred: { title: '🎩 Alfred', steps: [
      { sel: '#alfred-actions', text: 'Alfred\'s big buttons: a picture, a video, a cover, a character, your book.' },
      { sel: '#alfred-input', text: 'Or ask him in your own words. He shows an "I will…" card before he changes anything.' },
      { sel: '#alfred-btn-settings', text: '⚙ chooses his AI: Ollama on this PC, an AI you connect with a key, or one of the AI panes.' },
      { sel: '#alfred-btn-hide', text: '× hides the panel; Alfred stays on. Ctrl+Shift+A brings it back.' },
    ] },
  };

  function createEaseUI(api, docArg) {
    const doc = docArg || document;
    const win = doc.defaultView || window;
    const ease = api && api.ease;
    const state = { prefs: { toursSeen: {}, auto: false }, overlay: null, tour: null, pendingTour: null, timer: null, last: null };
    const $ = (id) => doc.getElementById(id);
    function h(tag, attrs, ...kids) {
      const e = doc.createElement(tag);
      for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null || v === false) continue;
        if (k === 'onclick' || k === 'onchange' || k === 'onkeydown') e.addEventListener(k.slice(2), v);
        else if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else e.setAttribute(k, v === true ? '' : String(v));
      }
      for (const c of kids.flat()) if (c != null && c !== false) e.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
      return e;
    }
    const sync = () => { try { if (api && typeof api.syncPanes === 'function') { const p = api.syncPanes(); if (p && p.catch) p.catch(() => {}); } } catch (_) {} };
    const uiLog = (action, detail) => { try { if (api && api.uiLog) { const p = api.uiLog(`ease-${action}`, detail || {}); if (p && p.catch) p.catch(() => {}); } } catch (_) {} };

    // ---------------------------------------------------------------- style + the ❓ Help button
    if (!$('ease-style')) { const st = h('style', { id: 'ease-style' }); st.textContent = CSS; (doc.head || doc.body).appendChild(st); }
    const toast = $('ease-toast') || doc.body.appendChild(h('div', { id: 'ease-toast', role: 'status', 'aria-live': 'polite', hidden: true }));
    function say(text, ms = 6000) {
      toast.textContent = text; toast.hidden = false;
      clearTimeout(say.t); say.t = setTimeout(() => { toast.hidden = true; }, ms);
    }
    let menu = null;
    function closeMenu() { if (menu) { menu.remove(); menu = null; } }
    function openMenu(anchor) {
      closeMenu();
      const r = anchor.getBoundingClientRect();
      menu = h('div', { class: 'ease-menu', role: 'menu', 'aria-label': 'Help' },
        h('button', { role: 'menuitem', id: 'ease-m-checklist', onclick: () => { closeMenu(); openChecklist(); } }, '✅ Setup checklist'),
        h('button', { role: 'menuitem', id: 'ease-m-problems', onclick: () => { closeMenu(); openProblems(); } }, "🩺 Something's wrong?"),
        h('button', { role: 'menuitem', id: 'ease-m-guide', onclick: () => { closeMenu(); openGuide(); } }, '📖 User guide'),
        h('button', { role: 'menuitem', id: 'ease-m-tours', onclick: () => { closeMenu(); replayTours(); } }, '🧭 Replay tours'));
      doc.body.appendChild(menu);
      const w = menu.getBoundingClientRect().width || 220;
      menu.style.top = `${Math.round(r.bottom + 4)}px`;
      menu.style.left = `${Math.max(8, Math.min(Math.round(r.right - w), (win.innerWidth || 1280) - w - 8))}px`;
      const first = menu.querySelector('button'); if (first) first.focus();
    }
    doc.addEventListener('click', (e) => { if (menu && !menu.contains(e.target) && e.target !== $('btn-ease-help')) closeMenu(); }, true);
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (menu) closeMenu(); else if (state.tour) endTour(false); else if (state.overlay) closeOverlay(); } });
    let helpBtn = $('btn-ease-help');
    if (!helpBtn) {
      const bar = $('window-titlebar');
      if (bar) { helpBtn = h('button', { id: 'btn-ease-help', type: 'button' }, '❓ Help'); bar.insertBefore(helpBtn, $('btn-collapse-window') || null); }
    }
    if (helpBtn) {
      helpBtn.setAttribute('aria-haspopup', 'menu');
      if (!helpBtn.title) helpBtn.title = "Setup checklist, Something's wrong?, the user guide and the guided tours";
      helpBtn.addEventListener('click', (e) => { e.preventDefault(); if (menu) closeMenu(); else openMenu(helpBtn); });
    }

    // ---------------------------------------------------------------- the pop-up frame
    function openOverlay(kind, title, labelId) {
      closeOverlay(true);
      if (state.tour) endTour(false, true);
      const box = h('div', { class: 'ease-box' });
      const ov = h('div', { class: 'ease-overlay', id: `ease-${kind}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelId }, box);
      ov.addEventListener('click', (e) => { if (e.target === ov) closeOverlay(); });
      box.appendChild(h('div', { class: 'ease-head' }, h('h2', { id: labelId }, title), h('span', { class: 'ease-sum', id: `ease-${kind}-sum`, role: 'status', 'aria-live': 'polite' }), h('button', { class: 'ease-x', type: 'button', title: 'Close', 'aria-label': 'Close', onclick: () => closeOverlay() }, '✕')));
      const body = h('div', { class: 'ease-body', id: `ease-${kind}-body` });
      const foot = h('div', { class: 'ease-foot', id: `ease-${kind}-foot` });
      box.appendChild(body); box.appendChild(foot);
      doc.body.appendChild(ov);
      state.overlay = { kind, el: ov, body, foot };
      sync();
      return state.overlay;
    }
    function closeOverlay(quiet) {
      clearInterval(state.timer); state.timer = null;
      if (!state.overlay) return;
      const kind = state.overlay.kind;
      state.overlay.el.remove();
      state.overlay = null;
      sync();
      if (!quiet) {
        uiLog('close', { what: kind });
        const next = state.pendingTour || (kind === 'checklist' ? currentTab() : null);
        state.pendingTour = null;
        if (next) setTimeout(() => maybeTour(next), 400);
      }
    }

    // ---------------------------------------------------------------- ✅ the checklist
    // optional extras that are not set up are not an error: ⚪, not ❌
    const icon = (ok, optional) => (ok === true ? '✅' : ok === false ? (optional ? '⚪' : '❌') : '⏳');
    function rowFor(item) {
      const msg = h('div', { class: 'ease-msg', hidden: true });
      const optional = item.group === 'optional';
      const btn = item.fix ? h('button', { type: 'button', class: item.ok === false && !optional ? 'primary' : '', 'data-fix': item.fix.action, onclick: async () => {
        btn.disabled = true;
        const r = await runFix(item.fix);
        btn.disabled = false;
        if (r && r.message) { msg.textContent = r.message; msg.hidden = false; }
        if (state.overlay && state.overlay.kind === 'checklist' && !(r && r.closed)) setTimeout(() => refreshChecklist(), 1500);
      } }, item.fix.label || 'Fix it') : null;
      return h('div', { class: 'ease-row', 'data-id': item.id, 'data-ok': String(item.ok), 'data-optional': String(optional) },
        h('span', { class: 'ease-ic', 'aria-label': item.icon ? item.title : item.ok === true ? 'ready' : item.ok === false ? (optional ? 'not set up (optional)' : 'needs fixing') : 'not sure yet' }, item.icon || icon(item.ok, optional)),
        h('div', { class: 'ease-txt' }, h('b', null, item.title), h('br'), h('span', null, item.text || ''), msg),
        btn);
    }
    function drawChecklist(cl) {
      const o = state.overlay; if (!o || o.kind !== 'checklist') return;
      o.body.textContent = '';
      if (!cl || !cl.ok) { o.body.appendChild(h('p', null, (cl && cl.message) || 'The checklist could not be made. Press ↻ Check again.')); return; }
      state.last = cl;
      $('ease-checklist-sum').textContent = cl.summary || '';
      const groups = [['needed', 'Needed for books'], ['optional', 'Optional extras']];
      for (const [g, label] of groups) {
        const rows = (cl.items || []).filter((i) => i.group === g);
        if (!rows.length) continue;
        o.body.appendChild(h('div', { class: 'ease-group' }, label));
        for (const it of rows) o.body.appendChild(rowFor(it));
      }
    }
    async function refreshChecklist() {
      if (!ease) return null;
      let cl;
      try { cl = await ease.checklist(); } catch (_) { cl = { ok: false }; }
      drawChecklist(cl);
      return cl;
    }
    async function openChecklist(pre) {
      const o = openOverlay('checklist', '✅ Setup checklist', 'ease-checklist-title');
      o.body.appendChild(h('p', { class: 'ease-sum' }, 'Checking what is ready…'));
      const dont = h('input', { type: 'checkbox', id: 'ease-dont-show' });
      dont.checked = !!state.prefs.dontShowChecklist;
      dont.addEventListener('change', () => { state.prefs.dontShowChecklist = dont.checked; try { const p = ease.setPrefs({ dontShowChecklist: dont.checked }); if (p && p.catch) p.catch(() => {}); } catch (_) {} });
      o.foot.appendChild(h('label', { title: 'It still opens from ❓ Help → ✅ Setup checklist' }, dont, "Don't show this by itself again"));
      o.foot.appendChild(h('span', { class: 'sp' }));
      o.foot.appendChild(h('button', { type: 'button', id: 'ease-checklist-recheck', onclick: () => refreshChecklist() }, '↻ Check again'));
      o.foot.appendChild(h('button', { type: 'button', class: 'primary', id: 'ease-checklist-close', onclick: () => closeOverlay() }, 'Close'));
      try { const p = ease && ease.setPrefs({ checklistShown: true }); if (p && p.catch) p.catch(() => {}); } catch (_) {}
      uiLog('open', { what: 'checklist' });
      if (pre && pre.items) drawChecklist(pre); else await refreshChecklist();
      clearInterval(state.timer);
      state.timer = setInterval(() => { if (state.overlay && state.overlay.kind === 'checklist') refreshChecklist(); }, 8000);
      return state.overlay;
    }

    // ---------------------------------------------------------------- 🩺 Something's wrong?
    async function openProblems() {
      const o = openOverlay('problems', "🩺 Something's wrong?", 'ease-problems-title');
      o.body.appendChild(h('p', { class: 'ease-sum' }, 'Looking at the AI panes, Akọwe, your book, the AI limits, the services and the last 24 hours of the log…'));
      const out = h('span', { class: 'ease-report', id: 'ease-report-msg', role: 'status', 'aria-live': 'polite' });
      const rep = h('button', { type: 'button', id: 'ease-report', title: 'A file for support with the last 24 hours of the activity log, keys and private folders removed. Your conversations and files are never included.', onclick: async () => {
        rep.disabled = true; out.textContent = 'Making the report…';
        let r; try { r = await ease.report(); } catch (_) { r = { ok: false }; }
        rep.disabled = false;
        out.textContent = r && r.ok ? `✔ Saved: ${r.file} — attach this file when you ask for help.` : `✖ ${(r && r.message) || 'The report could not be made.'}`;
      } }, '📄 Make a report for support');
      o.foot.appendChild(rep); o.foot.appendChild(out); o.foot.appendChild(h('span', { class: 'sp' }));
      o.foot.appendChild(h('button', { type: 'button', id: 'ease-problems-again', onclick: () => loadProblems() }, '↻ Look again'));
      o.foot.appendChild(h('button', { type: 'button', class: 'primary', onclick: () => closeOverlay() }, 'Close'));
      uiLog('open', { what: 'problems' });
      await loadProblems();
      return state.overlay;
    }
    async function loadProblems() {
      const o = state.overlay; if (!o || o.kind !== 'problems' || !ease) return null;
      let r; try { r = await ease.problems(); } catch (_) { r = { ok: false }; }
      if (!state.overlay || state.overlay.kind !== 'problems') return r;
      o.body.textContent = '';
      if (!r || !r.ok) { o.body.appendChild(h('p', null, 'The check could not finish. Press ↻ Look again.')); return r; }
      const list = r.problems || [];
      $('ease-problems-sum').textContent = list.length ? `${list.length} thing${list.length === 1 ? '' : 's'} found` : '';
      if (!list.length) { o.body.appendChild(h('div', { class: 'ease-none', id: 'ease-nothing' }, '✔ Nothing looks wrong right now. If something still misbehaves, make a report for support below.')); return r; }
      for (const p of list) o.body.appendChild(rowFor({ id: p.id, ok: false, icon: p.severity === 'urgent' ? '🔴' : '🟠', title: p.severity === 'urgent' ? 'Needs you now' : 'Worth a look', text: p.text, fix: p.fix }));
      return r;
    }

    // ---------------------------------------------------------------- the Fix it buttons
    function showTab(tab) {
      const id = tab === 'main' ? 'tab-app-main' : `tab-app-${tab}`;
      const b = $(id); if (b) b.click();
    }
    async function runFix(f) {
      if (!f || !f.action) return { ok: false };
      const a = f.action, args = f.args || {};
      uiLog('fix', { action: a });
      try {
        if (a === 'tab') { closeOverlay(true); showTab(args.tab); return { ok: true, closed: true }; }
        if (a === 'wizard') { if (api.openWizard) await api.openWizard(args.tab); return { ok: true, message: 'The Setup Wizard is open in its own window.' }; }
        if (a === 'pane-open') {
          closeOverlay(true); showTab('main');
          const col = $(`col-${args.site}`);
          if (col) { try { col.scrollIntoView({ block: 'nearest' }); } catch (_) {} col.classList.add('ease-flash'); setTimeout(() => col.classList.remove('ease-flash'), 4000); }
          say('Do it in that AI\'s window (sign in, or answer its check). AutoInjector notices by itself when it works again.');
          return { ok: true, closed: true };
        }
        if (!ease) return { ok: false };
        const r = await ease.fix(a, args);
        if (a === 'claude-code' && r && r.ok) { closeOverlay(true); return { ok: true, closed: true }; }
        if (r && r.ok && !r.message) return Object.assign({}, r, { message: a === 'pane-check' ? 'Checking now… this can take a minute.' : 'Done.' });
        return r || { ok: false };
      } catch (_) { return { ok: false, message: 'That did not work. Try again.' }; }
    }

    async function openGuide() {
      try { const r = await ease.guide(); if (!r || !r.ok) say('The user guide could not be opened.'); } catch (_) { say('The user guide could not be opened.'); }
    }

    // ---------------------------------------------------------------- 🧭 guided tours
    const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return false; const cs = win.getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
    function currentTab() {
      const t = doc.body.dataset.appTab || 'main';
      return ['main', 'akowe', 'images', 'video'].includes(t) ? t : 'main';
    }
    function startTour(id, { force } = {}) {
      const def = TOURS[id];
      if (!def) return false;
      if (state.overlay) { state.pendingTour = id; return false; }
      if (state.tour) endTour(false, true);
      const steps = def.steps.filter((s) => visible(doc.querySelector(s.sel)));
      if (!steps.length) return false;
      const root = h('div', { id: 'ease-tour', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Guided tour: ${def.title}`, 'data-tour': id });
      const hole = h('div', { class: 'ease-hole' });
      const tip = h('div', { class: 'ease-tip' });
      root.appendChild(hole); root.appendChild(tip);
      doc.body.appendChild(root);
      state.tour = { id, steps, i: 0, root, hole, tip, force: !!force };
      uiLog('tour', { tour: id, step: 'start' });
      sync();
      drawStep();
      return true;
    }
    function drawStep() {
      const t = state.tour; if (!t) return;
      const s = t.steps[t.i];
      const el = doc.querySelector(s.sel);
      const r = el ? el.getBoundingClientRect() : { left: 20, top: 60, width: 100, height: 30, right: 120, bottom: 90 };
      const pad = 4;
      Object.assign(t.hole.style, { left: `${Math.round(r.left - pad)}px`, top: `${Math.round(r.top - pad)}px`, width: `${Math.round(r.width + pad * 2)}px`, height: `${Math.round(r.height + pad * 2)}px` });
      const last = t.i === t.steps.length - 1;
      t.tip.textContent = '';
      t.tip.appendChild(h('div', { class: 'ease-tip-n' }, `${TOURS[t.id].title} · ${t.i + 1} of ${t.steps.length}`));
      t.tip.appendChild(h('div', { class: 'ease-tip-text', id: 'ease-tip-text' }, s.text));
      t.tip.appendChild(h('div', { class: 'ease-tip-btns' },
        h('button', { type: 'button', id: 'ease-tour-skip', onclick: () => endTour(true) }, 'Skip'),
        h('span', { class: 'sp' }),
        last ? h('button', { type: 'button', class: 'primary', id: 'ease-tour-done', onclick: () => endTour(true) }, 'Done')
          : h('button', { type: 'button', class: 'primary', id: 'ease-tour-next', onclick: () => { t.i++; drawStep(); } }, 'Next')));
      // place the bubble below the target, else above; keep it on the screen
      const W = win.innerWidth || 1280, H = win.innerHeight || 720;
      const tw = Math.min(320, W - 24);
      const th = t.tip.getBoundingClientRect().height || 120;
      const below = r.bottom + 12 + th < H || r.top - 12 - th < 0;
      const top = below ? Math.min(r.bottom + 12, H - th - 8) : Math.max(8, r.top - 12 - th);
      const left = Math.max(12, Math.min(r.left + Math.min(r.width / 2, 160) - 24, W - tw - 12));
      t.tip.dataset.side = below ? 'below' : 'above';
      t.tip.style.top = `${Math.round(top)}px`; t.tip.style.left = `${Math.round(left)}px`;
      t.tip.style.setProperty('--ax', `${Math.round(Math.max(12, Math.min(tw - 24, r.left + Math.min(r.width / 2, 160) - left - 6)))}px`);
      const btn = t.tip.querySelector('button.primary'); if (btn) { try { btn.focus(); } catch (_) {} }
    }
    function endTour(markSeen, quiet) {
      const t = state.tour; if (!t) return;
      t.root.remove(); state.tour = null; sync();
      if (markSeen) {
        state.prefs.toursSeen = Object.assign({}, state.prefs.toursSeen, { [t.id]: true });
        try { const p = ease && ease.setPrefs({ tourSeen: t.id }); if (p && p.catch) p.catch(() => {}); } catch (_) {}
      }
      if (!quiet) uiLog('tour', { tour: t.id, step: markSeen ? 'end' : 'closed', at: t.i + 1 });
    }
    function maybeTour(id) {
      if (!state.prefs.auto || (state.prefs.toursSeen || {})[id] || state.tour) return false;
      if (state.overlay) { state.pendingTour = id; return false; }
      return startTour(id);
    }
    async function replayTours() {
      try { const p = await ease.setPrefs({ resetTours: true }); if (p && p.toursSeen) state.prefs.toursSeen = p.toursSeen; else state.prefs.toursSeen = {}; } catch (_) { state.prefs.toursSeen = {}; }
      const open = doc.body.classList.contains('alfred-open') && currentTab() === 'main' ? 'main' : currentTab();
      if (!startTour(open, { force: true })) say('Tours are reset: each page shows its tour again the next time you open it.');
      else say('Each page shows its tour again the next time you open it.', 4000);
    }
    win.addEventListener('resize', () => { if (state.tour) drawStep(); if (menu) closeMenu(); });

    // first time a tab opens / Alfred's panel opens -> its tour
    try {
      let lastTab = currentTab();
      let alfredWas = doc.body.classList.contains('alfred-open');
      new win.MutationObserver(() => {
        const t = currentTab();
        if (t !== lastTab) { lastTab = t; if (state.tour) endTour(false, true); setTimeout(() => { if (currentTab() === t) maybeTour(t); }, 700); }
        const al = doc.body.classList.contains('alfred-open');
        if (al && !alfredWas) setTimeout(() => { if (doc.body.classList.contains('alfred-open')) maybeTour('alfred'); }, 900);
        alfredWas = al;
      }).observe(doc.body, { attributes: true, attributeFilter: ['data-app-tab', 'class'] });
    } catch (_) {}

    if (ease && typeof ease.onShow === 'function') {
      ease.onShow((p) => {
        const what = p && p.what;
        if (what === 'checklist') openChecklist();
        else if (what === 'problems') openProblems();
        else if (what === 'tours') replayTours();
      });
    }

    // startup: the checklist on the first start (and while something needed is ✖), else the main tour
    async function boot(delayMs) {
      if (!ease) return;
      try { state.prefs = Object.assign({ toursSeen: {} }, await ease.prefs()); } catch (_) { return; }
      if (!state.prefs.auto) return;
      setTimeout(async () => {
        let cl = null;
        try { cl = await ease.checklist(); } catch (_) { cl = null; }
        if (cl && cl.autoOpen && !state.overlay) openChecklist(cl);
        else maybeTour(currentTab());
      }, delayMs == null ? 2500 : delayMs);
    }

    return { openChecklist, openProblems, closeOverlay, refreshChecklist, loadProblems, startTour, endTour, maybeTour, replayTours, runFix, boot, TOURS, state };
  }

  window.createEaseUI = createEaseUI;
  window.EASE_TOURS = TOURS;
  function start() {
    if (window.__EASE_NO_AUTOSTART) return true; // the unit test starts it itself
    if (window.EaseUI || !window.api || !window.api.ease) return false;
    try { window.EaseUI = createEaseUI(window.api, document); window.EaseUI.boot(); } catch (e) { try { console.error('ease ui init failed', e); } catch (_) {} }
    return true;
  }
  if (!start()) { let n = 0; const t = setInterval(() => { if (start() || ++n > 50) clearInterval(t); }, 200); }
})();
