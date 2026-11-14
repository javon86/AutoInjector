// money-lab-ui.js — 🧪 Money lab window (lab.html): set the mission, start / stop the sandbox, answer the AIs' asks,
// see what they are doing and what they made. Plain data in, DOM out (textContent only — the asks and summaries
// are written by the AIs and are never parsed as HTML). model() is a plain function, unit-tested in node.
(function (root) {
  'use strict';

  const PHASE_WORDS = {
    off: 'Closed', opening: 'Opening Windows Sandbox…', 'setting-up': 'Setting up (first time takes a few minutes)', starting: 'Starting',
    waiting: 'Waiting for the mission', 'signing-in': 'Signing in', working: 'Working', finished: 'Finished',
    'needs-sign-in': 'Needs sign-in', error: 'Stopped with a problem', closed: 'Closed',
  };
  const KIND_WORDS = { account: '🔑 Make an account', post: '📣 Post / sell in public', message: '✉ Message someone', money: '💳 Something that costs money', other: '❔ Something else' };

  function clock(ms) {
    if (!ms) return '';
    try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; }
  }
  function left(ms, now) {
    if (!ms) return '';
    const m = Math.round((ms - now) / 60000);
    if (m <= 0) return 'time is up';
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`;
  }
  const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

  /** What the window shows, from lab:status. */
  function model(data, now) {
    const d = data || {};
    const av = d.available || { ok: false, words: 'Checking…', steps: [] };
    const st = d.status || { alive: false, phase: 'off', words: '', agents: [] };
    const running = !!st.alive && !['finished', 'needs-sign-in', 'error', 'closed', 'off'].includes(st.phase);
    const asks = (d.asks || []).map((q) => ({
      id: q.id, who: q.label || q.agent, kind: KIND_WORDS[q.kind] || q.kind, site: q.site || '', what: q.what, why: q.why || '',
      when: clock(q.at), open: !q.answer,
      answer: q.answer ? `${q.answer.allow ? '✔ You said yes' : '✖ You said no'}${q.answer.note ? ` — “${q.answer.note}”` : ''}` : '',
    }));
    return {
      available: !!av.ok, availWords: av.words || '', steps: av.steps || [], notWindows: av.code === 'NOT_WINDOWS',
      phase: PHASE_WORDS[st.phase] || st.phase, words: st.words || '', running, alive: !!st.alive,
      round: st.round || 0, timeLeft: running ? left(st.endsAt, now) : '', roundLeft: running ? left(st.roundEndsAt, now) : '',
      agents: (st.agents || []).map((a) => ({ id: a.id, label: `${a.label} (${a.tool})`, words: a.words, last: a.last, money: money(a.money), rounds: a.rounds, state: a.state })),
      moneyClaimed: money(st.moneyClaimed || 0),
      openAsks: asks.filter((q) => q.open), answeredAsks: asks.filter((q) => !q.open).slice(0, 30),
      ledger: d.ledger || [], products: d.products || {}, workshop: d.workshop || '',
      settings: d.settings || null,
      canStart: !!av.ok && !running, canStop: running,
    };
  }

  function node(doc, tag, attrs, text) {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'text') e.textContent = String(v); else e.setAttribute(k, v === true ? '' : String(v));
    }
    if (text != null) e.textContent = String(text);
    return e;
  }

  // ---- the form (settings) ----
  function readForm(doc) {
    const v = (id) => { const e = doc.getElementById(id); return e ? e.value : ''; };
    const c = (id) => { const e = doc.getElementById(id); return !!(e && e.checked); };
    return { mission: v('lab-mission'), agents: { claude: c('lab-ai-claude'), codex: c('lab-ai-codex') }, hours: Number(v('lab-hours')), roundMinutes: Number(v('lab-round')), style: v('lab-style'), autoStart: c('lab-autostart') };
  }
  function fillForm(doc, s) {
    if (!s) return;
    const set = (id, val) => { const e = doc.getElementById(id); if (e) e.value = String(val); };
    const chk = (id, on) => { const e = doc.getElementById(id); if (e) e.checked = !!on; };
    set('lab-mission', s.mission); set('lab-hours', s.hours); set('lab-round', s.roundMinutes); set('lab-style', s.style);
    chk('lab-ai-claude', s.agents && s.agents.claude); chk('lab-ai-codex', s.agents && s.agents.codex); chk('lab-autostart', s.autoStart);
  }

  function say(doc, words, tone) {
    const m = doc.getElementById('lab-msg');
    if (!m) return;
    m.textContent = words || '';
    m.dataset.tone = tone || 'info';
  }

  // ---- render ----
  function render(doc, data, api, now) {
    const m = model(data, now || Date.now());
    const $ = (id) => doc.getElementById(id);
    if ($('lab-avail')) {
      $('lab-avail').hidden = m.available;
      if (!m.available) {
        $('lab-avail-words').textContent = m.availWords;
        const ol = $('lab-avail-steps'); ol.textContent = '';
        for (const s of m.steps) ol.appendChild(node(doc, 'li', { text: s }));
        if ($('lab-enable')) $('lab-enable').hidden = m.notWindows;
      }
    }
    if ($('lab-phase')) $('lab-phase').textContent = m.phase;
    if ($('lab-phase')) $('lab-phase').dataset.running = m.running ? '1' : '0';
    if ($('lab-words')) $('lab-words').textContent = [m.words, m.round ? `Round ${m.round}` : '', m.roundLeft ? `this round: ${m.roundLeft}` : '', m.timeLeft ? `whole run: ${m.timeLeft}` : ''].filter(Boolean).join(' · ');
    if ($('lab-start')) $('lab-start').disabled = !m.canStart;
    if ($('lab-stop')) $('lab-stop').disabled = !m.canStop;
    if ($('lab-close')) $('lab-close').disabled = !m.alive;
    if ($('lab-money')) $('lab-money').textContent = `What they say they've earned: ${m.moneyClaimed} (check the proof in the ledger yourself)`;

    const ag = $('lab-agents');
    if (ag) {
      ag.textContent = '';
      if (!m.agents.length) ag.appendChild(node(doc, 'p', { class: 'lab-dim', text: 'Nothing yet — press ▶ Start the lab.' }));
      for (const a of m.agents) {
        const card = node(doc, 'div', { class: 'lab-agent', 'data-state': a.state, 'data-testid': `lab-agent-${a.id}` });
        card.appendChild(node(doc, 'h3', { text: a.label }));
        card.appendChild(node(doc, 'p', { class: 'lab-agent-words', text: `${a.words}${a.rounds ? ` · ${a.rounds} round${a.rounds === 1 ? '' : 's'}` : ''} · says earned ${a.money}` }));
        if (a.last) card.appendChild(node(doc, 'pre', { class: 'lab-agent-last', text: a.last }));
        ag.appendChild(card);
      }
    }

    const asks = $('lab-asks');
    if (asks) {
      const typing = asks.contains(doc.activeElement) && doc.activeElement && doc.activeElement.tagName === 'INPUT';
      const key = JSON.stringify(m.openAsks.map((q) => q.id));
      if (!typing || asks.dataset.key !== key) {
        asks.dataset.key = key;
        asks.textContent = '';
        if (!m.openAsks.length) asks.appendChild(node(doc, 'p', { class: 'lab-dim', text: 'No questions waiting.' }));
        for (const q of m.openAsks) {
          const card = node(doc, 'div', { class: 'lab-ask', 'data-id': q.id, 'data-testid': 'lab-ask' });
          card.appendChild(node(doc, 'div', { class: 'lab-ask-head', text: [q.who, q.kind, q.site ? `on ${q.site}` : '', q.when].filter(Boolean).join(' · ') }));
          card.appendChild(node(doc, 'p', { class: 'lab-ask-what', text: q.what }));
          if (q.why) card.appendChild(node(doc, 'p', { class: 'lab-ask-why', text: `Why: ${q.why}` }));
          const note = node(doc, 'input', { type: 'text', class: 'lab-ask-note', placeholder: 'A note for them (optional)', 'aria-label': 'A note for them', maxlength: '500' });
          card.appendChild(note);
          const row = node(doc, 'div', { class: 'lab-ask-row' });
          const yes = node(doc, 'button', { type: 'button', class: 'lab-yes', 'data-testid': 'lab-ask-yes' }, '✔ Yes, go ahead');
          const no = node(doc, 'button', { type: 'button', class: 'lab-no', 'data-testid': 'lab-ask-no' }, '✖ No');
          const answer = async (allow) => {
            yes.disabled = true; no.disabled = true;
            try { const r = await api.labAnswer(q.id, allow, note.value); say(doc, r && r.words, r && r.ok ? 'ok' : 'warn'); } catch (e) { say(doc, `Couldn't send your answer: ${e && e.message}`, 'warn'); }
            if (root && root.MoneyLabUi && root.MoneyLabUi.refresh) root.MoneyLabUi.refresh();
          };
          yes.addEventListener('click', () => answer(true));
          no.addEventListener('click', () => answer(false));
          row.appendChild(yes); row.appendChild(no);
          card.appendChild(row);
          asks.appendChild(card);
        }
      }
    }
    const done = $('lab-asks-done');
    if (done) {
      done.textContent = '';
      for (const q of m.answeredAsks) done.appendChild(node(doc, 'li', { text: `${q.who} · ${q.kind}${q.site ? ` on ${q.site}` : ''}: ${q.what} — ${q.answer}` }));
    }
    if ($('lab-asks-count')) $('lab-asks-count').textContent = m.openAsks.length ? ` (${m.openAsks.length} waiting)` : '';

    const led = $('lab-ledger');
    if (led) {
      led.textContent = '';
      if (!m.ledger.length) led.appendChild(node(doc, 'li', { class: 'lab-dim', text: 'No money in the ledger yet.' }));
      for (const l of m.ledger) led.appendChild(node(doc, 'li', { text: l }));
    }
    const pr = $('lab-products');
    if (pr) {
      pr.textContent = '';
      for (const [id, label] of [['claude', 'Claude'], ['codex', 'ChatGPT']]) {
        const files = m.products[id] || [];
        const li = node(doc, 'li', {});
        li.appendChild(node(doc, 'strong', { text: `${label}: ` }));
        li.appendChild(doc.createTextNode(files.length ? files.join(', ') : 'nothing yet'));
        const b = node(doc, 'button', { type: 'button', class: 'lab-small' }, '📂 Open');
        b.addEventListener('click', () => api.labOpen(id));
        li.appendChild(b);
        pr.appendChild(li);
      }
    }
    return m;
  }

  // ---- the window ----
  let timer = null;
  let filled = false;
  function start(doc, api) {
    const refresh = async () => {
      try {
        const data = await api.labStatus();
        if (!filled && data && data.settings) { fillForm(doc, data.settings); filled = true; }
        render(doc, data, api, Date.now());
      } catch (e) { say(doc, `Couldn't read the lab: ${e && e.message}`, 'warn'); }
    };
    out.refresh = refresh;
    const on = (id, fn) => { const e = doc.getElementById(id); if (e) e.addEventListener('click', fn); };
    const act = async (fn, busyWords) => {
      say(doc, busyWords, 'info');
      try { const r = await fn(); say(doc, r && r.words, r && r.ok ? 'ok' : 'warn'); } catch (e) { say(doc, `That didn't work: ${e && e.message}`, 'warn'); }
      refresh();
    };
    on('lab-save', () => act(() => api.labSave(readForm(doc)).then((r) => Object.assign({ words: r && r.ok ? 'Saved.' : (r && r.words) }, r)), 'Saving…'));
    on('lab-start', () => act(() => api.labStart(readForm(doc)), 'Opening Windows Sandbox…'));
    on('lab-stop', () => act(() => api.labStop(), 'Asking them to stop after this round…'));
    on('lab-close', () => { if (root.confirm && !root.confirm('Close the sandbox now? Anything not saved in the workshop folder is lost.')) return; act(() => api.labClose(), 'Closing the sandbox…'); });
    on('lab-open-workshop', () => api.labOpen('workshop'));
    on('lab-enable', () => act(() => api.labEnable(), 'Asking Windows to turn on Windows Sandbox…'));
    refresh();
    timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }

  const out = { model, render, readForm, fillForm, start, refresh: null };
  if (typeof module !== 'undefined' && module.exports) module.exports = out;
  if (root) root.MoneyLabUi = out;
})(typeof window !== 'undefined' ? window : null);
