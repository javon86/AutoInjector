/*
 * voice-ui.js — 🎤 talk to the AIs and 🔊 hear their replies, in the control panel.
 *
 *   Title bar     🎤 + "who hears it" (All · ChatGPT · Claude · Gemini · 🎩 Alfred when he is on) + one short line
 *                 that says what was heard and where it went ("🎤 Heard: “…” → sent to Claude").
 *                 Click 🎤 = record (it turns red with a timer), click again = stop → words. "Check first" (the default):
 *                 the words wait in the Compose box with a → Send button so a misheard name can be fixed; with
 *                 "Send what I say right away" ticked (🔊 Voice box) they go at once. Esc stops
 *                 without sending. The words go through the SAME send as the Compose box (window.api.sendCompose,
 *                 and sendToAlfred for Alfred), so House Rules, relaying and every guard behave the same.
 *   Each AI pane  🎤 in its header (sends to that AI only) and, beside "💬 Last reply", ◀ 🔊 ▶ with "3 / 7":
 *                 pick one of that AI's replies (newest by default, follows new replies) and play / stop it.
 *   🔊 settings   in the System AI panel's 🔊 Voice box: a voice per speaker + speed, ▶ to test each, and
 *                 "✨ Better voices" (voice-picker.js): free Piper voices to ▶ hear / ⬇ download / use, and the optional
 *                 ✨ Kokoro engine (best quality).
 *
 * Speech-to-text is local and offline: the page records (getUserMedia + MediaRecorder, webm/opus), main.js hands
 * the bytes to the voice shim (faster-whisper). Read-aloud uses a piper voice through the shim when one is
 * installed (a WAV this page plays — so ⏹ is instant), else this PC's built-in voices (speechSynthesis; on
 * Windows the Microsoft voices, offline) — each speaker with its own voice. Only one thing speaks at a time.
 *
 * createVoiceUI({ win, doc, api, sites, labels }) builds it (the jsdom test does that with stubs); in the page it
 * starts by itself and is window.VoiceUI.
 */
(function (root) {
  'use strict';
  const MAX_REC_MS = 5 * 60 * 1000;
  const MIN_REC_MS = 500;
  const MIN_BYTES = 1200;

  function createVoiceUI(opts) {
    const win = opts.win;
    const doc = opts.doc || win.document;
    const api = opts.api || {};
    const VR = opts.voiceRead || win.VoiceRead;
    const SITES = opts.sites || ['chatgpt', 'claude', 'gemini'];
    const LABELS = Object.assign({ chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', butler: '🎩 Alfred' }, opts.labels || {});
    const $ = (id) => doc.getElementById(id);
    const has = (fn) => typeof api[fn] === 'function';

    const prefs = { micSendNow: false, micTarget: 'all', rate: 1, voices: {}, browserVoices: {}, micDevice: '', engine: 'piper' };
    try { const t = win.localStorage && win.localStorage.getItem('voice.micTarget'); if (t) prefs.micTarget = t; } catch (_) {}
    let alfredOn = false;

    function h(tag, attrs, ...kids) {
      const e = doc.createElement(tag);
      if (attrs) for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : String(v));
      }
      for (const k of kids) if (k != null) e.append(k);
      return e;
    }

    // ---- the one status line (title bar) -------------------------------------------------------------------
    let sayTimer = null;
    function say(text, o = {}) {
      const box = $('voice-heard');
      if (!box) return;
      if (sayTimer) { win.clearTimeout(sayTimer); sayTimer = null; }
      box.textContent = '';
      box.dataset.tone = o.tone || '';
      if (!text) { box.hidden = true; return; }
      box.hidden = false;
      box.append(h('span', { class: 'vh-text', title: o.title || text }, text));
      for (const a of (o.actions || [])) {
        const b = h('button', { type: 'button', class: 'vh-act', title: a.title || a.label }, a.label);
        b.addEventListener('click', (e) => { e.stopPropagation(); a.run(); });
        box.append(b);
      }
      if (!o.sticky) {
        box.append(h('button', { type: 'button', class: 'vh-act vh-x', title: 'Hide this line', 'aria-label': 'Hide this line' }, '✕'));
        box.lastChild.addEventListener('click', (e) => { e.stopPropagation(); say(''); });
      }
      if (o.autoHideMs) sayTimer = win.setTimeout(() => say(''), o.autoHideMs);
    }
    const setupAction = { label: '🧙 Set up', title: 'Open the Setup Wizard → Installs → "Voice engine" (free, works offline)', run: () => { if (has('openWizard')) api.openWizard('advanced'); } };
    const voicesAction = { label: '🔊 Voices', title: 'Pick a voice per AI and the speed', run: () => openVoiceSettings() };
    function openVoiceSettings() {
      const box = $('voice-read-settings');
      if (!box) return;
      let d = box.closest ? box.closest('details') : null;
      while (d) { d.open = true; d = d.parentElement && d.parentElement.closest ? d.parentElement.closest('details') : null; }
      try { box.scrollIntoView({ block: 'center' }); } catch (_) {}
    }
    const short = (t, n = 90) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

    // ---- who a spoken message goes to (same rules as → All) -------------------------------------------------
    const isChecked = (id, dflt) => { const c = $(id); return c ? !!c.checked : dflt; };
    function resolveTargets(target) {
      if (target === 'butler') return { sites: [], alfred: true };
      if (SITES.includes(target)) return { sites: [target], alfred: false };
      return { sites: SITES.filter((s) => isChecked(`p-${s}`, true)), alfred: isChecked('p-butler', false) };
    }
    const ERR_WORDS = {
      NO_VIEW: "its page isn't open", SITE_REPAIRING: "you're showing AutoInjector its page right now",
      CHATGPT_IMAGE_BUSY: "it's still drawing a picture", CANCELLED: 'it was cancelled', RELAY_STOPPED: 'sending was stopped',
    };
    async function deliver(text, target) {
      const t = resolveTargets(target);
      const quoted = `“${short(text, 70)}”`;
      if (!t.sites.length && !t.alfred) { say(`🎤 Heard: ${quoted} — but no AI is ticked as Active, so nothing was sent.`, { tone: 'warn', title: `Heard: ${text}` }); return { ok: false, error: 'NO_TARGETS' }; }
      const sent = [], failed = [];
      if (t.sites.length) {
        let r = null;
        try { r = has('sendCompose') ? await api.sendCompose(text, t.sites) : { ok: false, error: 'UNAVAILABLE' }; } catch (e) { r = { ok: false, error: String(e) }; }
        if (r && r.ok) {
          for (const s of t.sites) {
            const one = r.results && r.results[s];
            if (one && one.ok === false) failed.push(`${LABELS[s]} (${ERR_WORDS[one.error] || "it didn't go in"})`); else sent.push(LABELS[s]);
          }
        } else for (const s of t.sites) failed.push(`${LABELS[s]} (${ERR_WORDS[r && r.error] || "it didn't go in"})`);
      }
      if (t.alfred) {
        try {
          if (typeof win.sendToAlfred === 'function') { await win.sendToAlfred(text); sent.push(LABELS.butler); }
          else if (has('alfredAsk')) { const r = await api.alfredAsk(text); if (r && r.ok === false) failed.push(`${LABELS.butler} (${short(r.message || r.error, 60)})`); else sent.push(LABELS.butler); }
          else failed.push(`${LABELS.butler} (not available)`);
        } catch (_) { failed.push(`${LABELS.butler} (it didn't go in)`); }
      }
      let line = `🎤 Heard: ${quoted}`;
      if (sent.length) line += ` → sent to ${sent.join(', ')}`;
      if (failed.length) line += `${sent.length ? ' ·' : ' →'} not sent to ${failed.join(', ')}`;
      say(line, { tone: failed.length ? 'warn' : 'ok', title: `Heard: ${text}`, autoHideMs: failed.length ? 0 : 20000 });
      return { ok: sent.length > 0, sent, failed };
    }

    // ---- ✔ check first: the words wait in the Compose box until the user presses → Send ---------------------
    const pending = { text: '', target: 'all' };
    const targetName = (target) => (target === 'all' ? 'everyone ticked' : LABELS[target] || target);
    function composer() { return $('composer-text'); }
    function review(text, target) {
      pending.text = text; pending.target = target;
      const box = composer();
      if (box) {
        const before = String(box.value || '');
        const sep = before && !/\s$/.test(before) ? ' ' : '';
        box.value = before + sep + text;
        try { box.dispatchEvent(new win.Event('input', { bubbles: true })); } catch (_) {}
        try { box.focus(); box.setSelectionRange(before.length + sep.length, box.value.length); } catch (_) {}
      }
      const send = { label: `→ Send to ${targetName(target)}`, title: 'Send the words in the Compose box (fix anything first)', run: () => sendReviewed() };
      const drop = { label: '✕ Clear', title: 'Forget it — nothing is sent', run: () => clearReviewed() };
      say(box ? `🎤 Check what I heard in the Compose box, fix anything, then send: “${short(text, 60)}”`
              : `🎤 Heard: “${short(text, 70)}” — send it?`, { sticky: true, tone: 'ok', title: `Heard: ${text}`, actions: [send, drop] });
      return { ok: true, review: true, text, target };
    }
    async function sendReviewed() {
      const box = composer();
      const text = String(box ? box.value : pending.text).trim();
      if (!text) { say('🎤 The Compose box is empty — nothing was sent.', { tone: 'warn', autoHideMs: 6000 }); return { ok: false, error: 'EMPTY' }; }
      const r = await deliver(text, pending.target);
      if (r && r.ok && box) { box.value = ''; try { box.dispatchEvent(new win.Event('input', { bubbles: true })); } catch (_) {} }
      pending.text = '';
      return r;
    }
    function clearReviewed() {
      const box = composer();
      if (box && pending.text) {
        const v = String(box.value || '');
        const at = v.lastIndexOf(pending.text);
        if (at >= 0) { box.value = (v.slice(0, at) + v.slice(at + pending.text.length)).replace(/\s+$/, ''); try { box.dispatchEvent(new win.Event('input', { bubbles: true })); } catch (_) {} }
      }
      pending.text = '';
      say('🎤 Cleared — nothing was sent.', { autoHideMs: 5000 });
    }

    // ---- 🎤 recording -------------------------------------------------------------------------------------
    const mic = { phase: 'idle', target: 'all', rec: null, stream: null, chunks: [], t0: 0, timer: null, token: 0, mime: '' };
    function paintMic() {
      const b = $('btn-voice-mic');
      const rec = mic.phase === 'recording';
      const busy = mic.phase === 'transcribing';
      if (b) {
        const secs = rec ? Math.floor((Date.now() - mic.t0) / 1000) : 0;
        b.textContent = rec ? `⏺ ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : busy ? '⏳' : '🎤';
        b.classList.toggle('rec', rec);
        b.classList.toggle('busy', busy);
        b.setAttribute('aria-pressed', String(rec));
        b.title = rec ? `Recording for ${mic.target === 'all' ? 'everyone ticked' : LABELS[mic.target]} — click to stop (Esc stops without keeping it)` : busy ? 'Working out what you said…' : 'Talk to the AIs: click, speak, click again — then check the words and press Send (Esc stops without keeping it)';
      }
      for (const s of SITES) {
        const pb = $(`voice-mic-${s}`);
        if (!pb) continue;
        const mine = mic.target === s;
        pb.classList.toggle('rec', rec && mine);
        pb.textContent = rec && mine ? '⏺' : busy && mine ? '⏳' : '🎤';
        pb.setAttribute('aria-pressed', String(rec && mine));
        pb.title = rec && mine ? `Recording for ${LABELS[s]} — click to stop and send` : `Talk to ${LABELS[s]} only: click, speak, click again to send`;
      }
    }
    function pickMime() {
      const MR = win.MediaRecorder;
      for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
        try { if (MR && typeof MR.isTypeSupported === 'function' && MR.isTypeSupported(m)) return m; } catch (_) {}
      }
      return '';
    }
    function micError(e) {
      const n = String((e && e.name) || '');
      if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'The microphone is blocked. In Windows: Settings → Privacy & security → Microphone → turn on "Let desktop apps access your microphone", then try the 🎤 again.';
      if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') return 'No microphone was found. Plug one in (or pick it under 🔊 Voice → Mic) and try again.';
      if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'The microphone is busy in another app (a call or a recorder?). Close that and try the 🎤 again.';
      return "Couldn't start the microphone. Try the 🎤 again.";
    }
    async function micStart(target) {
      const md = win.navigator && win.navigator.mediaDevices;
      if (!md || typeof md.getUserMedia !== 'function' || typeof win.MediaRecorder !== 'function') { say('Recording isn\'t available in this window.', { tone: 'error' }); return { ok: false, error: 'UNAVAILABLE' }; }
      if (speaker.current) speaker.stop(); // don't record the read-aloud
      mic.phase = 'starting'; mic.target = target;
      let stream;
      try {
        const audio = prefs.micDevice ? { deviceId: { ideal: prefs.micDevice } } : true;
        stream = await md.getUserMedia({ audio, video: false });
      } catch (e) {
        mic.phase = 'idle'; paintMic();
        const msg = micError(e);
        say(`🎤 ${msg}`, { tone: 'error' });
        if (has('uiLog')) try { api.uiLog('voice-mic', { step: 'mic-error', error: String((e && e.name) || 'error') }); } catch (_) {}
        return { ok: false, error: String((e && e.name) || 'MIC_ERROR'), message: msg };
      }
      if (mic.phase !== 'starting') { try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {} return { ok: false, error: 'CANCELLED' }; }
      const mime = pickMime();
      let rec;
      try { rec = mime ? new win.MediaRecorder(stream, { mimeType: mime }) : new win.MediaRecorder(stream); }
      catch (e) { try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {} mic.phase = 'idle'; paintMic(); say("🎤 Couldn't start recording. Try again.", { tone: 'error' }); return { ok: false, error: 'RECORDER' }; }
      mic.stream = stream; mic.rec = rec; mic.chunks = []; mic.mime = (rec.mimeType || mime || 'audio/webm');
      rec.ondataavailable = (ev) => { if (ev && ev.data && ev.data.size) mic.chunks.push(ev.data); };
      try { rec.start(250); } catch (_) { try { rec.start(); } catch (_) {} }
      mic.phase = 'recording'; mic.t0 = Date.now();
      mic.timer = win.setInterval(() => { paintMic(); if (Date.now() - mic.t0 > MAX_REC_MS) micStop(true); }, 250);
      paintMic();
      say(`🎤 Listening${target === 'all' ? '' : ` for ${LABELS[target]}`}… click ${target === 'all' || target === 'butler' ? 'the 🎤' : `${LABELS[target]}'s 🎤`} again to send, Esc to stop.`, { sticky: true, tone: 'rec' });
      return { ok: true };
    }
    function stopRecorder() {
      return new Promise((resolve) => {
        const rec = mic.rec;
        if (!rec || rec.state === 'inactive') return resolve();
        let done = false;
        const fin = () => { if (!done) { done = true; resolve(); } };
        rec.onstop = fin;
        try { rec.stop(); } catch (_) { fin(); }
        win.setTimeout(fin, 3000);
      });
    }
    function release() {
      if (mic.timer) { win.clearInterval(mic.timer); mic.timer = null; }
      try { if (mic.stream) mic.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      mic.stream = null; mic.rec = null;
    }
    async function blobToBase64(blob) {
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return win.btoa(bin);
    }
    async function micStop(send) {
      if (mic.phase === 'starting') { mic.phase = 'idle'; paintMic(); say(''); return { ok: false, error: 'CANCELLED' }; }
      if (mic.phase !== 'recording') return { ok: false, error: 'NOT_RECORDING' };
      const ms = Date.now() - mic.t0;
      await stopRecorder();
      release();
      const chunks = mic.chunks; mic.chunks = [];
      const target = mic.target;
      if (!send) { mic.phase = 'idle'; paintMic(); say('🎤 Stopped — nothing was sent.', { autoHideMs: 6000 }); return { ok: false, error: 'CANCELLED' }; }
      const blob = new win.Blob(chunks, { type: mic.mime || 'audio/webm' });
      if (ms < MIN_REC_MS || blob.size < MIN_BYTES) { mic.phase = 'idle'; paintMic(); say("🎤 I didn't hear anything — nothing was sent.", { tone: 'warn', autoHideMs: 8000 }); return { ok: false, error: 'EMPTY' }; }
      mic.phase = 'transcribing';
      const my = ++mic.token;
      paintMic();
      const cancel = { label: '✕ Cancel', title: 'Forget this recording — nothing is sent', run: () => cancelTranscribe() };
      say('🎤 Working out what you said…', { sticky: true, actions: [cancel] });
      let r;
      try {
        const b64 = await blobToBase64(blob);
        r = has('voiceTranscribe') ? await api.voiceTranscribe(b64, (mic.mime || 'audio/webm').split(';')[0]) : { ok: false, error: 'UNAVAILABLE', message: "Talking to the AIs isn't available in this build." };
      } catch (e) { r = { ok: false, error: 'ERROR', message: 'Something went wrong while listening. Try the 🎤 again.' }; }
      if (my !== mic.token) return { ok: false, error: 'CANCELLED' };
      mic.phase = 'idle'; paintMic();
      if (!r || !r.ok) {
        const acts = (r && r.fix && r.fix.action === 'open-setup') ? [setupAction] : [];
        say(`🎤 ${(r && r.message) || "I couldn't make out the words. Try again."}`, { tone: 'error', actions: acts });
        return { ok: false, error: (r && r.error) || 'ERROR' };
      }
      const text = String(r.text || '').trim();
      if (!text || /^[\s.,!?…-]*$/.test(text)) { say("🎤 I didn't catch any words — nothing was sent.", { tone: 'warn', autoHideMs: 8000 }); return { ok: false, error: 'NO_WORDS' }; }
      return prefs.micSendNow ? deliver(text, target) : review(text, target);
    }
    function cancelTranscribe() {
      if (mic.phase !== 'transcribing') return;
      mic.token++; mic.phase = 'idle'; paintMic();
      say('🎤 Cancelled — nothing was sent.', { autoHideMs: 6000 });
    }
    function micToggle(target) {
      if (mic.phase === 'recording') return micStop(true);
      if (mic.phase === 'starting') return micStop(false);
      if (mic.phase === 'transcribing') { say('🎤 Still working out what you said — wait a moment, or cancel.', { sticky: true, actions: [{ label: '✕ Cancel', run: () => cancelTranscribe() }] }); return Promise.resolve({ ok: false, error: 'BUSY' }); }
      return micStart(target || currentTarget());
    }
    function currentTarget() {
      const sel = $('voice-mic-target');
      const v = sel ? sel.value : prefs.micTarget;
      if (v === 'butler' && !alfredOn) return 'all';
      return v || 'all';
    }
    if (has('onVoiceMic')) api.onVoiceMic((p) => {
      if (!p || mic.phase !== 'transcribing') return;
      const cancel = { label: '✕ Cancel', run: () => cancelTranscribe() };
      if (p.phase === 'starting') say('🎤 Starting the voice engine…', { sticky: true, actions: [cancel] });
      else if (p.phase === 'downloading') say(`🎤 Getting the speech model ready — the first time it downloads it (about ${p.mb > 0 ? `${p.mb} MB` : '150 MB'}). This happens only once.`, { sticky: true, actions: [cancel] });
      else if (p.phase === 'loading') say('🎤 Loading the speech model…', { sticky: true, actions: [cancel] });
    });

    // ---- 🔊 one speaker for the whole app ------------------------------------------------------------------
    const speaker = (function () {
      let token = 0, audio = null, pendingDone = null, piperOffUntil = 0;
      const subs = [];
      const sp = { current: null, lastEngine: '' };
      const synth = () => win.speechSynthesis || null;
      function setCurrent(c) { sp.current = c; for (const f of subs) try { f(c); } catch (_) {} }
      function stop() {
        token++;
        if (audio) { try { audio.pause(); } catch (_) {} try { audio.removeAttribute('src'); audio.load && audio.load(); } catch (_) {} audio = null; }
        try { const s = synth(); if (s) s.cancel(); } catch (_) {}
        if (pendingDone) { const f = pendingDone; pendingDone = null; f(); }
        if (sp.current) setCurrent(null);
      }
      function browserVoices() { try { const s = synth(); return s ? s.getVoices() : []; } catch (_) { return []; } }
      function browserVoiceFor(who) {
        const list = browserVoices();
        const want = prefs.browserVoices[who] || VR.pickBrowserVoices(list)[who];
        return list.find((v) => v.name === want) || null;
      }
      function sayBrowser(text, who, my) {
        return new Promise((resolve) => {
          const s = synth();
          const U = win.SpeechSynthesisUtterance;
          if (!s || typeof U !== 'function') return resolve(false);
          const u = new U(text);
          const st = VR.STYLE[who] || VR.STYLE.chatgpt;
          const v = browserVoiceFor(who);
          if (v) { try { u.voice = v; } catch (_) {} try { if (v.lang) u.lang = v.lang; } catch (_) {} }
          u.rate = Math.max(0.3, Math.min(3, (prefs.rate || 1) * st.rate));
          u.pitch = st.pitch;
          let done = false;
          const fin = (ok) => { if (done) return; done = true; if (pendingDone === finStop) pendingDone = null; resolve(ok); };
          const finStop = () => fin(true);
          pendingDone = finStop;
          u.onend = () => fin(true);
          u.onerror = (e) => fin(!!(e && (e.error === 'interrupted' || e.error === 'canceled')) || my !== token);
          try { s.speak(u); } catch (_) { fin(false); }
        });
      }
      function playWav(r, my) {
        return new Promise((resolve) => {
          if (my !== token) return resolve(true);
          const a = new win.Audio(`data:${r.mime || 'audio/wav'};base64,${r.audio}`);
          audio = a;
          try { a.playbackRate = Math.max(0.5, Math.min(2, prefs.rate || 1)); } catch (_) {}
          let done = false;
          const fin = (ok) => { if (done) return; done = true; if (audio === a) audio = null; if (pendingDone === finStop) pendingDone = null; resolve(ok); };
          const finStop = () => fin(true);
          pendingDone = finStop;
          a.onended = () => fin(true);
          a.onerror = () => fin(false);
          try { const p = a.play(); if (p && typeof p.catch === 'function') p.catch(() => fin(false)); } catch (_) { fin(false); }
        });
      }
      async function synthPiper(text, who) {
        if (!has('voiceSynthesize') || Date.now() < piperOffUntil) return null;
        if (prefs.browserVoices[who] && !prefs.voices[who] && prefs.engine !== 'kokoro') return null; // the user picked a built-in voice for them
        try {
          const r = await api.voiceSynthesize(text, who);
          if (r && r.ok && r.audio) return r;
          if (r && (r.error === 'NO_SHIM' || r.error === 'NO_TTS_MODEL' || r.error === 'NO_TTS')) piperOffUntil = Date.now() + 20000;
          return null;
        } catch (_) { return null; }
      }
      async function speak(text, who, meta) {
        try { return await speakInner(text, who, meta); } catch (_) {
          if (sp.current) setCurrent(null);
          return { ok: false, error: 'NO_VOICE' };
        }
      }
      async function speakInner(text, who, meta) {
        stop();
        const my = ++token;
        const chunks = VR.chunkForSpeech(VR.cleanForSpeech(text), 220);
        if (!chunks.length) return { ok: false, error: 'EMPTY' };
        setCurrent(Object.assign({ who }, meta || {}));
        let engine = 'piper';
        let next = synthPiper(chunks[0], who);
        let anySpoke = false;
        for (let i = 0; i < chunks.length; i++) {
          if (my !== token) return { ok: true, stopped: true };
          if (engine === 'piper') {
            const r = await next;
            if (my !== token) return { ok: true, stopped: true };
            if (r) {
              next = i + 1 < chunks.length ? synthPiper(chunks[i + 1], who) : null;
              sp.lastEngine = r.engine === 'kokoro' ? 'kokoro' : 'piper';
              const ok = await playWav(r, my);
              if (ok) { anySpoke = true; continue; }
            }
            engine = 'browser';
          }
          sp.lastEngine = 'browser';
          const ok = await sayBrowser(chunks[i], who, my);
          if (my !== token) return { ok: true, stopped: true };
          if (!ok) {
            if (my === token) setCurrent(null);
            return { ok: false, error: 'NO_VOICE', spoke: anySpoke };
          }
          anySpoke = true;
        }
        if (my === token) setCurrent(null);
        return { ok: true, engine: sp.lastEngine, chunks: chunks.length };
      }
      sp.speak = speak; sp.stop = stop; sp.onChange = (f) => subs.push(f); sp.browserVoices = browserVoices;
      sp.resetPiper = () => { piperOffUntil = 0; };
      // one short clip (a ▶ sample in "Better voices"): same one-speaker rule, ⏹ stops it
      sp.playClip = async (r) => {
        stop();
        const my = ++token;
        setCurrent({ clip: true });
        const ok = await playWav(r, my);
        if (my === token) setCurrent(null);
        return ok;
      };
      return sp;
    }());
    const NO_VOICE_MSG = "🔊 This PC has no voice to read with. Install a free one: Setup Wizard → Installs → \"Voice model\" (or add a voice in Windows Settings → Time & language → Speech).";

    // ---- per-AI replies: ◀ 🔊 ▶ "3 / 7" ---------------------------------------------------------------------
    const replies = {};
    for (const s of SITES) replies[s] = { items: [], idx: -1 };
    function paintReplies(site) {
      const st = replies[site];
      const n = st.items.length;
      const cur = st.idx >= 0 ? st.items[st.idx] : null;
      const lab = $(`voice-count-${site}`), prev = $(`voice-prev-${site}`), next = $(`voice-next-${site}`), play = $(`voice-play-${site}`);
      const speaking = speaker.current && speaker.current.site === site;
      if (lab) {
        lab.textContent = n ? `${st.idx + 1} / ${n}` : '0 / 0';
        lab.title = cur ? `${LABELS[site]}'s reply ${st.idx + 1} of ${n}: “${cur.preview}”` : `No reply from ${LABELS[site]} yet`;
      }
      if (prev) { prev.disabled = !n || st.idx <= 0; prev.title = `Older reply from ${LABELS[site]}`; }
      if (next) { next.disabled = !n || st.idx >= n - 1; next.title = `Newer reply from ${LABELS[site]}`; }
      if (play) {
        play.disabled = !n && !speaking;
        play.textContent = speaking ? '⏹' : '🔊';
        play.classList.toggle('on', !!speaking);
        play.setAttribute('aria-pressed', String(!!speaking));
        play.title = speaking ? 'Stop reading' : cur ? `Read aloud ${LABELS[site]}'s reply ${st.idx + 1} of ${n}: “${cur.preview}”` : `No reply from ${LABELS[site]} to read yet`;
      }
    }
    async function refreshReplies(site) {
      if (!replies[site] || !has('voiceReplies')) return;
      let r = null;
      try { r = await api.voiceReplies(site); } catch (_) { r = null; }
      if (!r || !r.ok || !Array.isArray(r.items)) return;
      const st = replies[site];
      const onNewest = st.idx < 0 || st.idx >= st.items.length - 1;
      const curId = st.idx >= 0 && st.items[st.idx] ? st.items[st.idx].id : null;
      st.items = r.items;
      if (onNewest || curId == null) st.idx = st.items.length - 1;
      else { const i = st.items.findIndex((x) => x.id === curId); st.idx = i >= 0 ? i : Math.min(st.idx, st.items.length - 1); }
      paintReplies(site);
    }
    function step(site, d) {
      const st = replies[site];
      if (!st || !st.items.length) return;
      st.idx = Math.max(0, Math.min(st.items.length - 1, st.idx + d));
      paintReplies(site);
    }
    async function playReply(site) {
      if (speaker.current && speaker.current.site === site) { speaker.stop(); return { ok: true, stopped: true }; }
      const st = replies[site];
      const cur = st && st.idx >= 0 ? st.items[st.idx] : null;
      if (!cur) { say(`🔊 ${LABELS[site]} hasn't replied yet — nothing to read.`, { autoHideMs: 6000 }); return { ok: false, error: 'NO_REPLY' }; }
      let r = null;
      try { r = has('voiceReplyText') ? await api.voiceReplyText(cur.id) : null; } catch (_) { r = null; }
      if (!r || !r.ok) { say(`🔊 ${(r && r.message) || "Couldn't find that reply."}`, { tone: 'warn', autoHideMs: 8000 }); refreshReplies(site); return { ok: false, error: 'NOT_FOUND' }; }
      const out = await speaker.speak(r.text, site, { site, id: cur.id });
      if (!out.ok && out.error === 'NO_VOICE') say(NO_VOICE_MSG, { tone: 'error', actions: [setupAction] });
      else if (!out.ok && out.error === 'EMPTY') say(`🔊 That reply has nothing to read aloud (only code or pictures).`, { autoHideMs: 6000 });
      return out;
    }
    speaker.onChange(() => { for (const s of SITES) paintReplies(s); paintAlfredButtons(); });

    // 🎩 his side-panel messages get a small 🔊 too (alfred-panel.js asks for it)
    function paintAlfredButtons() {
      for (const b of doc.querySelectorAll('.vr-alfred')) {
        const on = !!(speaker.current && speaker.current.alfredKey && speaker.current.alfredKey === b.dataset.key);
        b.dataset.icon = on ? '⏹' : '🔊'; // drawn by CSS (::before) so his message's text stays just his words
        b.title = on ? 'Stop reading' : 'Read this aloud';
        b.setAttribute('aria-label', b.title);
      }
    }
    let alfredKeyN = 0;
    function speakButton(getText, who) {
      const key = `al${++alfredKeyN}`;
      const b = h('button', { type: 'button', class: 'vr-alfred', 'data-key': key, title: 'Read this aloud', 'aria-label': 'Read this aloud', 'data-icon': '🔊' });
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (speaker.current && speaker.current.alfredKey === key) { speaker.stop(); return; }
        const text = typeof getText === 'function' ? getText() : String(getText || '');
        const out = await speaker.speak(text, who || 'butler', { alfredKey: key });
        if (!out.ok && out.error === 'NO_VOICE') say(NO_VOICE_MSG, { tone: 'error', actions: [setupAction] });
      });
      return b;
    }

    // ---- building the buttons ------------------------------------------------------------------------------
    function buildTitleBar() {
      const bar = $('voice-bar');
      if (!bar || bar.dataset.built) return;
      bar.dataset.built = '1';
      const mb = h('button', { id: 'btn-voice-mic', type: 'button', 'aria-label': 'Talk to the AIs (microphone)', 'aria-pressed': 'false' }, '🎤');
      mb.addEventListener('click', () => { micToggle(currentTarget()); });
      const sel = h('select', { id: 'voice-mic-target', title: 'Who hears what you say into the 🎤', 'aria-label': 'Who your spoken message goes to' });
      sel.append(h('option', { value: 'all' }, 'All'));
      for (const s of SITES) sel.append(h('option', { value: s }, LABELS[s]));
      sel.addEventListener('change', () => {
        prefs.micTarget = sel.value;
        try { win.localStorage && win.localStorage.setItem('voice.micTarget', sel.value); } catch (_) {}
        if (has('configureVoice')) try { api.configureVoice({ micTarget: sel.value }); } catch (_) {}
      });
      const heard = h('span', { id: 'voice-heard', role: 'status', 'aria-live': 'polite', hidden: true });
      bar.append(mb, sel, heard);
      paintTargets();
      paintMic();
    }
    function paintTargets() {
      const sel = $('voice-mic-target');
      if (!sel) return;
      let opt = sel.querySelector('option[value="butler"]');
      if (alfredOn && !opt) sel.append(h('option', { value: 'butler' }, LABELS.butler));
      if (!alfredOn && opt) { opt.remove(); opt = null; }
      const want = prefs.micTarget === 'butler' && !alfredOn ? 'all' : prefs.micTarget;
      if ([...sel.options].some((o) => o.value === want)) sel.value = want; else sel.value = 'all';
    }
    function buildPane(site) {
      const col = $(`col-${site}`);
      if (!col || col.dataset.voiceBuilt) return !!col;
      const head = col.querySelector('.card-head');
      const tabs = col.querySelector('.locker-tabs');
      if (!head || !tabs) return false;
      col.dataset.voiceBuilt = '1';
      const pm = h('button', { id: `voice-mic-${site}`, type: 'button', class: 'vmic-btn', 'aria-label': `Talk to ${LABELS[site]} only`, 'aria-pressed': 'false' }, '🎤');
      pm.addEventListener('click', (e) => { e.stopPropagation(); if (mic.phase === 'recording' && mic.target !== site) { micStop(true); return; } micToggle(site); });
      const zoomOut = head.querySelector('.zoom-btn');
      if (zoomOut) head.insertBefore(pm, zoomOut); else head.append(pm);
      const grp = h('span', { class: 'vr-group', id: `voice-read-${site}`, role: 'group', 'aria-label': `Read ${LABELS[site]}'s replies aloud` });
      const prev = h('button', { id: `voice-prev-${site}`, type: 'button', class: 'vr-btn', 'aria-label': `Older reply from ${LABELS[site]}` }, '◀');
      const play = h('button', { id: `voice-play-${site}`, type: 'button', class: 'vr-btn vr-play', 'aria-label': `Read ${LABELS[site]}'s reply aloud` }, '🔊');
      const next = h('button', { id: `voice-next-${site}`, type: 'button', class: 'vr-btn', 'aria-label': `Newer reply from ${LABELS[site]}` }, '▶');
      const count = h('span', { id: `voice-count-${site}`, class: 'vr-count', 'aria-live': 'polite' }, '0 / 0');
      prev.addEventListener('click', (e) => { e.stopPropagation(); step(site, -1); });
      next.addEventListener('click', (e) => { e.stopPropagation(); step(site, +1); });
      play.addEventListener('click', (e) => { e.stopPropagation(); playReply(site); });
      grp.append(prev, play, next, count);
      const rp = $(`reply-tab-${site}`);
      if (rp && rp.parentNode === tabs) rp.after(grp); else tabs.append(grp);
      paintReplies(site);
      return true;
    }

    // ---- 🔊 settings (in the 🔊 Voice box) --------------------------------------------------------------------
    let piperList = [];
    // ✨ Better voices (voice-picker.js, when the page has it)
    const picker = typeof win.createVoicePicker === 'function' ? win.createVoicePicker({
      win, doc, api, catalog: opts.catalog || win.VoiceCatalog, labels: { butler: 'Alfred' },
      play: (r) => speaker.playClip(r),
      onChanged: async (c) => {
        if (c && c.downloaded && has('voicePiperVoices')) { try { const r = await api.voicePiperVoices(); piperList = (r && Array.isArray(r.voices)) ? r.voices : piperList; } catch (_) {} }
        if (c && c.who) { prefs.voices[c.who] = c.voice; prefs.browserVoices[c.who] = ''; }
        if (c && c.kokoro && c.kokoro.engine) prefs.engine = c.kokoro.engine;
        speaker.resetPiper();
        if (c && (c.downloaded || c.who)) buildSettings();
      },
    }) : null;
    function buildSettings() {
      const box = $('voice-read-settings');
      if (!box) return;
      box.textContent = '';
      const now = h('input', { type: 'checkbox', id: 'mic-send-now' });
      now.checked = !!prefs.micSendNow;
      now.addEventListener('change', () => {
        prefs.micSendNow = now.checked;
        if (has('configureVoice')) try { api.configureVoice({ micSendNow: now.checked }); } catch (_) {}
      });
      box.append(h('label', { class: 'vrs-note', for: 'mic-send-now', title: 'Off (the default): what you say waits in the Compose box so you can fix a misheard word, then you press Send' }, now, ' 🎤 Send what I say right away (skip checking it first)'));
      box.append(h('div', { class: 'vrs-title' }, '🔊 Read-aloud voices (the 🔊 on each AI)'));
      const piperNote = piperList.length ? `${piperList.length} piper voice${piperList.length === 1 ? '' : 's'} found.` : `Using this PC's built-in voices. Nicer ones: ${picker ? '✨ Better voices below' : 'Setup Wizard → Installs → "Voice model"'}.`;
      box.append(h('div', { class: 'vrs-note', id: 'vrs-note' }, piperNote));
      const pcVoices = speaker.browserVoices().filter((v) => /^en/i.test(String(v.lang || '')) || !v.lang);
      for (const who of VR.WHO) {
        const sel = h('select', { id: `ra-voice-${who}`, 'aria-label': `Voice for ${LABELS[who]}` });
        sel.append(h('option', { value: '' }, 'Automatic'));
        if (piperList.length) { const g = h('optgroup', { label: 'Piper (offline, nicer)' }); for (const n of piperList) g.append(h('option', { value: `piper:${n}` }, n)); sel.append(g); }
        if (pcVoices.length) { const g = h('optgroup', { label: 'Built into this PC' }); for (const v of pcVoices) g.append(h('option', { value: `pc:${v.name}` }, v.name)); sel.append(g); }
        const cur = prefs.voices[who] ? `piper:${prefs.voices[who]}` : prefs.browserVoices[who] ? `pc:${prefs.browserVoices[who]}` : '';
        if (cur && ![...sel.options].some((o) => o.value === cur)) sel.append(h('option', { value: cur }, cur.replace(/^\w+:/, '')));
        sel.value = cur;
        sel.addEventListener('change', () => saveVoiceChoice(who, sel.value));
        const test = h('button', { type: 'button', class: 'mini', id: `ra-test-${who}`, title: `Test ${LABELS[who]}'s voice` }, '▶︎');
        test.addEventListener('click', () => testVoice(who));
        box.append(h('div', { class: 'voice-assign' }, h('span', null, LABELS[who]), sel, test));
      }
      const rate = h('input', { type: 'range', id: 'ra-rate', min: '0.6', max: '1.6', step: '0.1', value: String(prefs.rate || 1), 'aria-label': 'Reading speed' });
      const rv = h('span', { id: 'ra-rate-value', class: 'vrs-rate' }, `${Number(prefs.rate || 1).toFixed(1)}×`);
      rate.addEventListener('input', () => { rv.textContent = `${Number(rate.value).toFixed(1)}×`; });
      rate.addEventListener('change', () => {
        prefs.rate = Number(rate.value) || 1;
        if (has('configureVoice')) try { api.configureVoice({ rate: prefs.rate }); } catch (_) {}
      });
      const testAll = h('button', { type: 'button', id: 'ra-test', title: 'Hear each speaker once' }, '▶︎ Test voice');
      testAll.addEventListener('click', async () => { for (const who of VR.WHO) { const out = await testVoice(who); if (!out.ok || out.stopped) break; } });
      box.append(h('div', { class: 'voice-assign' }, h('span', null, 'Speed'), rate, rv, testAll));
      if (picker) box.append(picker.render({ voices: prefs.voices }));
    }
    function saveVoiceChoice(who, val) {
      const piper = val.startsWith('piper:') ? val.slice(6) : '';
      const pc = val.startsWith('pc:') ? val.slice(3) : '';
      prefs.voices[who] = piper; prefs.browserVoices[who] = pc;
      const legacy = $(`voice-v-${who}`); if (legacy) legacy.value = piper;
      speaker.resetPiper();
      if (has('configureVoice')) try { api.configureVoice({ voices: { [who]: piper }, browserVoices: { [who]: pc } }); } catch (_) {}
    }
    async function testVoice(who) {
      const out = await speaker.speak(`Hello, this is ${who === 'butler' ? 'Alfred' : LABELS[who]}. This is how I sound when I read my replies.`, who, { test: who });
      const note = $('vrs-note');
      if (!out.ok && out.error === 'NO_VOICE') { if (note) note.textContent = NO_VOICE_MSG.replace(/^🔊 /, ''); say(NO_VOICE_MSG, { tone: 'error', actions: [setupAction] }); }
      else if (note && out.ok) note.textContent = `Played with ${out.engine === 'kokoro' ? 'the best-quality voice (Kokoro)' : out.engine === 'piper' ? 'a piper voice' : "this PC's built-in voice"}.`;
      return out;
    }

    // ---- start -----------------------------------------------------------------------------------------------
    async function loadPrefs() {
      if (has('voiceStatus')) {
        try {
          const s = await api.voiceStatus();
          if (s) {
            if (s.micTarget) prefs.micTarget = s.micTarget;
            prefs.micSendNow = !!s.micSendNow;
            if (Number(s.rate)) prefs.rate = Number(s.rate);
            prefs.voices = Object.assign({}, s.voices || {});
            prefs.browserVoices = Object.assign({}, s.browserVoices || {});
            prefs.micDevice = s.micDevice || '';
            prefs.engine = s.engine === 'kokoro' ? 'kokoro' : 'piper';
          }
        } catch (_) {}
      }
      if (has('voicePiperVoices')) { try { const r = await api.voicePiperVoices(); piperList = (r && Array.isArray(r.voices)) ? r.voices : []; } catch (_) { piperList = []; } }
      if (picker) await picker.load();
      paintTargets();
      buildSettings();
    }
    function onKey(e) {
      if (e.key !== 'Escape') return;
      if (mic.phase === 'recording' || mic.phase === 'starting') { e.preventDefault(); micStop(false); }
      else if (mic.phase === 'transcribing') { e.preventDefault(); cancelTranscribe(); }
    }
    function init() {
      buildTitleBar();
      let missing = SITES.filter((s) => !buildPane(s));
      if (missing.length) { let tries = 0; const t = win.setInterval(() => { missing = missing.filter((s) => !buildPane(s)); if (!missing.length || ++tries > 40) win.clearInterval(t); for (const s of SITES) refreshReplies(s); }, 250); }
      doc.addEventListener('keydown', onKey);
      if (has('onCapture')) api.onCapture((turn) => { if (turn && replies[turn.site]) refreshReplies(turn.site); });
      if (has('alfredStatus')) api.alfredStatus().then((st) => { alfredOn = !!(st && st.enabled); paintTargets(); }).catch(() => {});
      if (has('onAlfred')) api.onAlfred((p) => { if (p && p.type === 'state' && p.state) { alfredOn = !!p.state.enabled; paintTargets(); } });
      const ss = win.speechSynthesis;
      if (ss && typeof ss.addEventListener === 'function') ss.addEventListener('voiceschanged', () => buildSettings());
      // the micDevice can change in the 🔊 Voice box (Save) — pick it up
      const micSel = $('voice-mic');
      if (micSel) micSel.addEventListener('change', () => { prefs.micDevice = micSel.value || ''; });
      for (const s of SITES) refreshReplies(s);
      return loadPrefs();
    }

    return {
      init, say, deliver, review, sendReviewed, clearReviewed, resolveTargets, micToggle, micStart, micStop, cancelTranscribe, refreshReplies, step, playReply, speakButton,
      speaker, prefs, replies, mic, testVoice, openVoiceSettings, picker, _setAlfredOn: (on) => { alfredOn = !!on; paintTargets(); },
    };
  }

  root.createVoiceUI = createVoiceUI;
  if (typeof module === 'object' && module.exports) module.exports = { createVoiceUI };
  else if (root.document && root.api) {
    try { root.VoiceUI = createVoiceUI({ win: root, doc: root.document, api: root.api }); root.VoiceUI.init(); } catch (e) { try { console.error('voice-ui', e); } catch (_) {} }
  }
}(typeof self !== 'undefined' ? self : this));
