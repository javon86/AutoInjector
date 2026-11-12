/*
 * voice-picker.js — "✨ Better voices" in the 🔊 Voice box (System AI panel), drawn by voice-ui.js.
 *
 *   Free Piper voices   the recommended list (voice-catalog.js): each with ▶ Sample, ⬇ Download (size, progress,
 *                       ✕ Cancel, carries on after a cancel) and "Use for: Alfred / ChatGPT / Claude / Gemini".
 *                       Piper runs on the processor and uses a little of it only while reading.
 *   ✨ Kokoro (optional) "Install best-quality voice (Kokoro, ~350 MB)" with progress; then "Use it", where it runs
 *                       (processor — the default, leaves the graphics card free for pictures and video — or graphics
 *                       card) and a Kokoro voice per speaker with ▶. Any problem: piper reads, then the PC's voices.
 *
 * Nothing goes on the internet unless the user presses ⬇, ▶ on a voice that isn't downloaded yet, or Install.
 * createVoicePicker({ win, doc, api, catalog, labels, play, onChanged }) -> { render(prefs) -> Element, load(), state }.
 * Tested in jsdom by test/voice-picker.test.js.
 */
(function (root) {
  'use strict';
  const WHO = ['butler', 'chatgpt', 'claude', 'gemini'];

  function createVoicePicker(opts) {
    const win = opts.win;
    const doc = opts.doc || win.document;
    const api = opts.api || {};
    const CAT = opts.catalog || win.VoiceCatalog;
    const LABELS = Object.assign({ butler: 'Alfred', chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' }, opts.labels || {});
    const play = typeof opts.play === 'function' ? opts.play : async () => false;
    const onChanged = typeof opts.onChanged === 'function' ? opts.onChanged : () => {};
    const has = (fn) => typeof api[fn] === 'function';
    const st = { voices: [], kokoro: null, engine: 'piper', kokoroDevice: 'cpu', kokoroVoices: {}, prog: {}, msg: {}, prefs: { voices: {} }, loaded: false };
    let box = null;

    function h(tag, attrs, ...kids) {
      const e = doc.createElement(tag);
      if (attrs) for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : String(v));
      }
      for (const k of kids) if (k != null) e.append(k);
      return e;
    }
    const mb = (b) => (CAT && CAT.fmtMB ? CAT.fmtMB(b) : `${Math.round((Number(b) || 0) / 1048576)} MB`);
    const usedBy = (id) => WHO.filter((w) => (st.prefs.voices || {})[w] === id || (!(st.prefs.voices || {})[w] && st.defaults && st.defaults[w] === id && st.installedNames && st.installedNames.length));

    async function load() {
      if (!has('voiceCatalog')) { st.loaded = true; return st; }
      try {
        const r = await api.voiceCatalog();
        if (r && r.ok) {
          st.voices = Array.isArray(r.voices) ? r.voices : [];
          st.kokoro = r.kokoro || null;
          st.engine = r.engine || 'piper';
          st.kokoroDevice = r.kokoroDevice || 'cpu';
          st.kokoroVoices = Object.assign({}, r.kokoroVoices || {});
          st.defaults = r.defaults || {};
          st.installedNames = r.installedNames || [];
          for (const v of st.voices) if (v.downloading && !st.prog[v.id]) st.prog[v.id] = { got: v.partial || 0, total: v.bytes };
          if (st.kokoro && st.kokoro.installing && !st.prog.kokoro) st.prog.kokoro = { message: 'Installing…' };
        }
      } catch (_) { /* keep what we had */ }
      st.loaded = true;
      return st;
    }

    // ---- progress from main (voice-download events) ---------------------------------------------------------
    function onEvent(e) {
      if (!e || !e.id) return;
      const id = e.id;
      if (e.phase === 'start') st.prog[id] = { got: 0, total: e.total || 0 };
      else if (e.phase === 'progress') st.prog[id] = Object.assign({}, st.prog[id], { got: e.got, total: e.total || (st.prog[id] && st.prog[id].total) || 0, file: e.file, message: '' });
      else if (e.phase === 'retry' || e.phase === 'install') st.prog[id] = Object.assign({}, st.prog[id] || {}, { message: e.message });
      else if (e.phase === 'done') { delete st.prog[id]; st.msg[id] = { text: id === 'kokoro' ? e.message : '✓ Downloaded — ready to use.', tone: 'ok' }; }
      else if (e.phase === 'error' || e.phase === 'cancelled') { delete st.prog[id]; st.msg[id] = { text: e.message || 'Stopped.', tone: e.phase === 'error' ? 'error' : '' }; }
      paint(id);
    }
    if (has('onVoiceDownload')) api.onVoiceDownload(onEvent);

    // ---- actions ----------------------------------------------------------------------------------------------
    async function download(id) {
      if (!has('voiceDownload')) return { ok: false };
      st.prog[id] = st.prog[id] || { got: 0, total: (st.voices.find((v) => v.id === id) || {}).bytes || 0 };
      st.msg[id] = null;
      paint(id);
      let r;
      try { r = await api.voiceDownload(id); } catch (e) { r = { ok: false, message: "The download couldn't start." }; }
      delete st.prog[id];
      if (r && r.ok) {
        const v = st.voices.find((x) => x.id === id); if (v) { v.installed = true; v.partial = 0; }
        if (st.installedNames && !st.installedNames.includes(id)) st.installedNames.push(id);
        st.msg[id] = { text: '✓ Downloaded — pick who uses it below, or press ▶.', tone: 'ok' };
        onChanged({ downloaded: id });
      } else if (r) st.msg[id] = { text: r.message || "The download didn't finish. Press ⬇ again.", tone: r.error === 'CANCELLED' ? '' : 'error' };
      paint(id);
      return r;
    }
    async function cancel(id) {
      if (id === 'kokoro') { if (has('voiceKokoroCancel')) { const r = await api.voiceKokoroCancel(); if (r && !r.ok && r.message) { st.msg.kokoro = { text: r.message }; paint('kokoro'); } return r; } return { ok: false }; }
      return has('voiceDownloadCancel') ? api.voiceDownloadCancel(id) : { ok: false };
    }
    async function sample(id) {
      const v = st.voices.find((x) => x.id === id);
      if (!has('voiceSample')) { st.msg[id] = { text: 'Download it to hear it.' }; paint(id); return { ok: false }; }
      st.msg[id] = { text: v && v.installed ? '▶ Playing…' : '▶ Fetching a short sample (about 90 KB)…' };
      paint(id);
      let r;
      try { r = await api.voiceSample(id); } catch (_) { r = null; }
      if (!r || !r.ok || !r.audio) { st.msg[id] = { text: (r && r.message) || 'No sample right now — download the voice to hear it.', tone: 'warn' }; paint(id); return { ok: false }; }
      st.msg[id] = { text: r.from === 'sample' ? '▶ A recording from the voice\'s makers. Download it to use it.' : '▶ Playing with this voice.' };
      paint(id);
      await play(r);
      return { ok: true, from: r.from };
    }
    function useFor(id, who) {
      if (!WHO.includes(who)) return;
      st.prefs.voices = Object.assign({}, st.prefs.voices, { [who]: id });
      if (has('configureVoice')) try { api.configureVoice({ voices: { [who]: id }, browserVoices: { [who]: '' } }); } catch (_) {}
      st.msg[id] = { text: `✓ ${LABELS[who]} now reads with this voice.`, tone: 'ok' };
      onChanged({ voice: id, who });
      paint(id);
    }
    async function installKokoro() {
      if (!has('voiceKokoroInstall')) return { ok: false };
      st.prog.kokoro = { message: 'Starting…' }; st.msg.kokoro = null; paint('kokoro');
      let r;
      try { r = await api.voiceKokoroInstall(); } catch (_) { r = { ok: false, message: "The install couldn't start." }; }
      delete st.prog.kokoro;
      if (r && r.ok) { st.kokoro = Object.assign({}, st.kokoro, { model: true, pkg: true, ready: true }); st.msg.kokoro = { text: '✓ Installed. Tick "Use it" to switch it on.', tone: 'ok' }; }
      else st.msg.kokoro = { text: (r && r.message) || "The install didn't finish. Your other voices still work.", tone: r && r.error === 'CANCELLED' ? '' : 'error' };
      await load();
      paint('kokoro');
      return r;
    }
    function setKokoro(patch) {
      if ('engine' in patch) st.engine = patch.engine;
      if ('kokoroDevice' in patch) st.kokoroDevice = patch.kokoroDevice;
      if (patch.kokoroVoices) st.kokoroVoices = Object.assign({}, st.kokoroVoices, patch.kokoroVoices);
      if (has('configureVoice')) try { api.configureVoice(patch); } catch (_) {}
      onChanged({ kokoro: patch });
      paint('kokoro');
    }
    async function kokoroTest(who) {
      const voice = st.kokoroVoices[who] || (st.kokoro && st.kokoro.defaults && st.kokoro.defaults[who]) || 'af_heart';
      if (!has('voiceSynthesize')) return { ok: false };
      st.msg.kokoro = { text: '▶ Getting it ready (the first time takes a few seconds)…' }; paint('kokoro');
      let r; try { r = await api.voiceSynthesize(`Hello, this is ${LABELS[who]}.`, who, '', voice); } catch (_) { r = null; }
      if (!r || !r.ok || !r.audio) { st.msg.kokoro = { text: (r && r.message) || "Kokoro couldn't read that.", tone: 'warn' }; paint('kokoro'); return { ok: false }; }
      st.msg.kokoro = { text: `▶ ${LABELS[who]} with Kokoro${r.device === 'gpu' ? ' (on the graphics card)' : ' (on the processor)'}.` }; paint('kokoro');
      await play(r);
      return { ok: true };
    }

    // ---- drawing ----------------------------------------------------------------------------------------------
    function msgEl(id) {
      const m = st.msg[id];
      return h('div', { class: 'vp-msg', id: `vp-msg-${id}`, 'data-tone': (m && m.tone) || '', role: 'status' }, m ? m.text : '');
    }
    function progEl(id, p) {
      const pct = p.total ? Math.min(100, Math.floor((p.got / p.total) * 100)) : null;
      const bar = h('progress', { id: `vp-bar-${id}`, max: '100', value: pct == null ? null : String(pct) });
      const txt = p.message ? p.message : pct == null ? 'Starting…' : `${pct}% · ${mb(p.got)} of ${mb(p.total)}`;
      const x = h('button', { type: 'button', class: 'mini', id: `vp-cancel-${id}`, title: 'Stop — press ⬇ later to carry on where it stopped' }, '✕ Cancel');
      x.addEventListener('click', () => cancel(id));
      return h('span', { class: 'vp-prog' }, bar, h('span', { class: 'vp-pct', id: `vp-pct-${id}` }, txt), x);
    }
    function rowFor(v) {
      const p = st.prog[v.id];
      const meta = `${v.langLabel} · ${v.gender} · ${v.quality === 'high' ? 'high quality' : 'good quality'} · ${mb(v.bytes)}`;
      const row = h('div', { class: 'vp-row', id: `vp-row-${v.id}`, 'data-installed': v.installed ? '1' : '0' });
      const users = v.installed ? usedBy(v.id) : [];
      row.append(h('div', { class: 'vp-name' }, h('b', null, v.label), h('span', { class: 'vp-meta' }, ` ${meta}`),
        users.length ? h('span', { class: 'vp-used' }, ` · reads for ${users.map((w) => LABELS[w]).join(', ')}`) : null));
      const acts = h('div', { class: 'vp-actions' });
      const s = h('button', { type: 'button', class: 'mini', id: `vp-play-${v.id}`, title: v.installed ? 'Hear this voice' : 'Hear a short sample (fetched from the internet, about 90 KB)' }, '▶ Sample');
      s.addEventListener('click', () => sample(v.id));
      acts.append(s);
      if (p) acts.append(progEl(v.id, p));
      else if (v.installed) acts.append(h('span', { class: 'vp-ok', id: `vp-dl-${v.id}` }, '✓ Downloaded'));
      else {
        const part = Number(v.partial) || 0;
        const d = h('button', { type: 'button', class: 'mini', id: `vp-dl-${v.id}`, title: 'Download it into the models/voice folder (once; then it works offline)' }, part ? `⬇ Carry on (${mb(part)} of ${mb(v.bytes)} done)` : `⬇ Download (${mb(v.bytes)})`);
        d.addEventListener('click', () => download(v.id));
        acts.append(d);
      }
      const sel = h('select', { id: `vp-use-${v.id}`, 'aria-label': `Who reads with ${v.label}`, title: v.installed ? 'Who reads with this voice' : 'Download it first', disabled: !v.installed });
      sel.append(h('option', { value: '' }, 'Use for…'));
      for (const w of WHO) sel.append(h('option', { value: w }, LABELS[w]));
      sel.addEventListener('change', () => { if (sel.value) useFor(v.id, sel.value); sel.value = ''; });
      acts.append(sel);
      row.append(acts, msgEl(v.id));
      return row;
    }
    function kokoroEl() {
      const k = st.kokoro || {};
      const wrap = h('div', { class: 'vp-kokoro', id: 'vp-kokoro' });
      wrap.append(h('div', { class: 'vrs-title' }, '✨ Best quality (optional): Kokoro'));
      wrap.append(h('div', { class: 'vrs-note' }, `Even more natural voices, about ${k.approxMB || 350} MB. It runs on your processor by default (the graphics card stays free for pictures and video) and works only while reading. Nothing needs it — the voices above work without it.`));
      const p = st.prog.kokoro;
      if (p) wrap.append(h('div', { class: 'vp-actions' }, progEl('kokoro', p)));
      else if (!k.ready && !(k.model && k.pkg !== false)) {
        const b = h('button', { type: 'button', id: 'vp-kokoro-install', title: 'Installs the Kokoro engine into the voice engine, then downloads its voice file' }, `⬇ Install best-quality voice (Kokoro, ~${k.approxMB || 350} MB)`);
        b.addEventListener('click', () => installKokoro());
        wrap.append(h('div', { class: 'vp-actions' }, b));
      } else {
        const use = h('input', { type: 'checkbox', id: 'vp-kokoro-use' });
        use.checked = st.engine === 'kokoro';
        use.addEventListener('change', () => setKokoro({ engine: use.checked ? 'kokoro' : 'piper' }));
        wrap.append(h('label', { class: 'vrs-note', for: 'vp-kokoro-use' }, use, ' Use it for read-aloud (if it has a problem, a piper voice reads instead)'));
        if (!k.ready) wrap.append(h('div', { class: 'vrs-note', id: 'vp-kokoro-wait' }, 'It starts with the voice engine — press ▶ on a speaker below to try it.'));
        const dev = h('select', { id: 'vp-kokoro-device', 'aria-label': 'Where Kokoro runs' });
        dev.append(h('option', { value: 'cpu' }, 'Processor (recommended — leaves the graphics card free)'));
        dev.append(h('option', { value: 'gpu' }, 'Graphics card (faster; pictures and video wait)'));
        dev.value = st.kokoroDevice === 'gpu' ? 'gpu' : 'cpu';
        dev.addEventListener('change', () => setKokoro({ kokoroDevice: dev.value }));
        wrap.append(h('div', { class: 'voice-assign' }, h('span', null, 'Runs on'), dev));
        const list = (k.voices || (CAT && CAT.KOKORO.voices) || []);
        for (const w of WHO) {
          const sel = h('select', { id: `vp-kokoro-voice-${w}`, 'aria-label': `Kokoro voice for ${LABELS[w]}` });
          for (const v of list) sel.append(h('option', { value: v.id }, v.label));
          sel.value = st.kokoroVoices[w] || (k.defaults && k.defaults[w]) || (list[0] && list[0].id) || '';
          sel.addEventListener('change', () => setKokoro({ kokoroVoices: { [w]: sel.value } }));
          const t = h('button', { type: 'button', class: 'mini', id: `vp-kokoro-test-${w}`, title: `Hear ${LABELS[w]} with Kokoro` }, '▶');
          t.addEventListener('click', () => kokoroTest(w));
          wrap.append(h('div', { class: 'voice-assign' }, h('span', null, LABELS[w]), sel, t));
        }
      }
      wrap.append(msgEl('kokoro'));
      return wrap;
    }
    function paint(id) {
      if (!box || !box.isConnected) return;
      if (id === 'kokoro') { const old = doc.getElementById('vp-kokoro'); if (old) old.replaceWith(kokoroEl()); return; }
      const v = st.voices.find((x) => x.id === id);
      const old = doc.getElementById(`vp-row-${id}`);
      if (v && old) old.replaceWith(rowFor(v));
    }
    function render(prefs) {
      if (prefs) st.prefs = prefs;
      box = h('div', { id: 'voice-picker', class: 'vp' });
      box.append(h('div', { class: 'vrs-title' }, '✨ Better voices (free)'));
      box.append(h('div', { class: 'vrs-note' }, 'Download a voice once and it works offline. Piper voices run on your processor and use a little of it only while reading.'));
      if (!st.voices.length) box.append(h('div', { class: 'vrs-note' }, st.loaded ? 'The voice list isn\'t available in this build.' : 'Loading the voice list…'));
      for (const v of st.voices) box.append(rowFor(v));
      if (st.kokoro) box.append(kokoroEl());
      return box;
    }

    return { load, render, onEvent, download, cancel, sample, useFor, installKokoro, setKokoro, kokoroTest, state: st };
  }

  root.createVoicePicker = createVoicePicker;
  if (typeof module === 'object' && module.exports) module.exports = { createVoicePicker };
}(typeof self !== 'undefined' ? self : this));
