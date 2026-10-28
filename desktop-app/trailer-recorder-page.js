'use strict';
/*
 * trailer-recorder-page.js — runs in the hidden 🎞 trailer-recorder window (trailer-recorder.js). It plays the
 * trailer's timeline onto a <canvas> in real time — each shot (a video clip, cover-cropped to the frame) and each
 * title card (text drawn on black), with short fades through black between them — and records the canvas (plus
 * the optional music, mixed in with WebAudio and faded out at the end) with MediaRecorder as WebM (VP9, else VP8).
 * The recording goes back to main in chunks (window.trailerHost, trailer-recorder-preload.js).
 * The plan: { width, height, fps, fade, total, items:[{ kind:'clip'|'card', start, seconds, src | text, subtitle }],
 *             music:{ src, volume, fadeOut } | null, videoBitsPerSecond }
 */
(function () {
  const host = window.trailerHost;
  if (!host) return;
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  let stopped = false;
  let failed = false;
  const fail = (code, message) => { if (failed) return; failed = true; try { host.fail({ code, message }); } catch (_) {} };

  function waitMedia(el, what, ms) {
    return new Promise((resolve, reject) => {
      let done = false;
      const ok = () => { if (!done) { done = true; resolve(); } };
      const bad = () => { if (!done) { done = true; reject(new Error(`${what} could not be read (${el.error ? `media error ${el.error.code}` : 'unknown format'})`)); } };
      el.addEventListener(el.tagName === 'AUDIO' ? 'canplay' : 'loadeddata', ok, { once: true });
      el.addEventListener('error', bad, { once: true });
      setTimeout(() => { if (!done) { done = true; reject(new Error(`${what} took too long to load`)); } }, ms);
      if (el.readyState >= 2) ok();
    });
  }

  // Text wrapped to a width: lines.
  function wrap(text, maxW) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = []; let line = '';
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    return lines;
  }
  function drawCard(it, W, H) {
    ctx.fillStyle = it.background || '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const big = Math.round(H * (it.text && it.text.length > 40 ? 0.075 : 0.1));
    const small = Math.round(H * 0.045);
    ctx.font = `600 ${big}px Georgia, "Times New Roman", serif`;
    const tl = wrap(it.text, W * 0.82).slice(0, 4);
    ctx.font = `400 ${small}px Georgia, "Times New Roman", serif`;
    const sl = it.subtitle ? wrap(it.subtitle, W * 0.8).slice(0, 3) : [];
    const blockH = tl.length * big * 1.2 + (sl.length ? small * 0.8 + sl.length * small * 1.35 : 0);
    let y = (H - blockH) / 2 + big * 0.6;
    ctx.fillStyle = it.color || '#f5efe2';
    ctx.font = `600 ${big}px Georgia, "Times New Roman", serif`;
    for (const l of tl) { ctx.fillText(l, W / 2, y); y += big * 1.2; }
    if (sl.length) {
      y += small * 0.5;
      ctx.fillStyle = it.subtitleColor || '#cdb882';
      ctx.font = `400 ${small}px Georgia, "Times New Roman", serif`;
      for (const l of sl) { ctx.fillText(l, W / 2, y); y += small * 1.35; }
    }
  }
  function drawClip(v, W, H) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const vw = v.videoWidth || W; const vh = v.videoHeight || H;
    const k = Math.max(W / vw, H / vh); // cover: fill the frame, crop the overflow
    const dw = vw * k; const dh = vh * k;
    try { ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh); } catch (_) { /* a frame that isn't ready yet stays black */ }
  }

  async function run(plan) {
    const W = Math.max(64, Math.round(plan.width || 1280)); const H = Math.max(64, Math.round(plan.height || 720));
    canvas.width = W; canvas.height = H;
    const fps = Math.min(60, Math.max(5, Math.round(plan.fps || 24)));
    const fade = Math.max(0, Number(plan.fade) || 0);
    const items = plan.items || [];
    const total = Number(plan.total) || items.reduce((n, it) => n + it.seconds, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    // load every clip (and the music) before the clock starts
    const vids = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== 'clip') { vids.push(null); continue; }
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = it.src;
      try { await waitMedia(v, `Shot ${it.number || i + 1}`, 30000); } catch (e) { fail('CLIP_UNREADABLE', `${e.message}.`); return; }
      vids.push(v);
    }
    let audio = null; let gain = null; let actx = null; let aDest = null;
    if (plan.music && plan.music.src) {
      audio = document.createElement('audio');
      audio.src = plan.music.src; audio.preload = 'auto'; audio.loop = true;
      try { await waitMedia(audio, 'The music', 30000); } catch (e) { fail('MUSIC_UNREADABLE', `${e.message}.`); return; }
      try {
        actx = new AudioContext();
        const src = actx.createMediaElementSource(audio);
        gain = actx.createGain();
        gain.gain.value = Math.min(1, Math.max(0, plan.music.volume == null ? 0.8 : Number(plan.music.volume)));
        aDest = actx.createMediaStreamDestination();
        src.connect(gain); gain.connect(aDest);
      } catch (e) { fail('MUSIC_UNREADABLE', `The music could not be mixed (${e.message}).`); return; }
    }
    if (stopped) return;
    const stream = canvas.captureStream(fps);
    if (aDest) for (const t of aDest.stream.getAudioTracks()) stream.addTrack(t);
    const wants = aDest ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'] : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mime = wants.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    if (!mime) { fail('NO_RECORDER', 'This computer cannot record WebM video (MediaRecorder).'); return; }
    let rec;
    try { rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: plan.videoBitsPerSecond || 6000000 }); } catch (e) { fail('NO_RECORDER', `The recorder could not start (${e.message}).`); return; }
    // chunks go back in order
    let chain = Promise.resolve();
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chain = chain.then(async () => { const b = new Uint8Array(await e.data.arrayBuffer()); host.chunk(b); }); };
    let t0 = 0;
    rec.onstop = () => { const ms = performance.now() - t0; chain.then(() => { if (!failed) host.done({ ms: Math.round(ms), mime, width: W, height: H, fps, stopped }); }); };
    rec.onerror = (e) => fail('RECORD_FAILED', `Recording failed (${(e && e.error && e.error.name) || 'error'}).`);

    let cur = -1;
    let lastProgress = 0;
    const startAt = (i) => {
      if (cur >= 0 && vids[cur]) { try { vids[cur].pause(); } catch (_) {} }
      cur = i;
      const v = vids[i];
      if (v) { try { v.currentTime = 0; } catch (_) {} const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    };
    const draw = (t) => {
      let i = items.findIndex((it) => t >= it.start && t < it.start + it.seconds);
      if (i < 0) i = items.length - 1;
      if (i !== cur) startAt(i);
      const it = items[i];
      if (it.kind === 'clip') drawClip(vids[i], W, H); else drawCard(it, W, H);
      if (fade > 0) { // fade through black at both ends of every shot / card
        const local = t - it.start;
        const a = Math.min(1, local / fade, (it.seconds - local) / fade);
        if (a < 1) { ctx.fillStyle = `rgba(0,0,0,${Math.max(0, Math.min(1, 1 - a)).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
      }
    };
    draw(0);
    rec.start(500);
    t0 = performance.now();
    if (audio) {
      try { await actx.resume(); } catch (_) {}
      try { await audio.play(); } catch (_) {}
      const fo = Math.min(Math.max(0, Number(plan.music.fadeOut == null ? 1.5 : plan.music.fadeOut)), total);
      try { const now = actx.currentTime; gain.gain.setValueAtTime(gain.gain.value, now + Math.max(0, total - fo)); gain.gain.linearRampToValueAtTime(0.0001, now + total); } catch (_) {}
    }
    const frameMs = 1000 / fps;
    const tick = () => {
      if (failed) return;
      const t = (performance.now() - t0) / 1000;
      if (stopped || t >= total) {
        draw(Math.min(t, Math.max(0, total - 0.001)));
        try { if (audio) audio.pause(); } catch (_) {}
        try { if (cur >= 0 && vids[cur]) vids[cur].pause(); } catch (_) {}
        try { rec.requestData(); } catch (_) {}
        setTimeout(() => { try { rec.stop(); } catch (_) {} }, 30);
        return;
      }
      draw(t);
      if (t - lastProgress >= 0.25) { lastProgress = t; host.progress({ t: Math.round(t * 100) / 100, total, item: cur }); }
      setTimeout(tick, Math.max(1, frameMs - ((performance.now() - t0) % frameMs)));
    };
    setTimeout(tick, frameMs);
  }

  host.onStop(() => { stopped = true; });
  host.onPlan((plan) => { run(plan).catch((e) => fail('RECORD_FAILED', `Something went wrong while recording: ${(e && e.message) || e}`)); });
  host.ready();
})();
