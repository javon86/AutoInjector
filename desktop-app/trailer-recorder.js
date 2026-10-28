'use strict';
/*
 * trailer-recorder.js — the 🎞 trailer join in the main process, with no new dependency: a hidden, offscreen
 * BrowserWindow (trailer-recorder.html + trailer-recorder-page.js) plays the timeline onto a <canvas> in real
 * time and records it with MediaRecorder (WebM, VP9/VP8, the music mixed in with WebAudio). The chunks arrive
 * here and are written to the .webm; then the WebM gets its Duration (webm-tools.js) so players can seek.
 *
 *   const rec = createTrailerRecorder({ electron: require('electron'), dir: __dirname, log });
 *   const job = rec.record(plan, 'C:/…/trailer.webm', { onProgress });   // plan: video-trailer.js joinPlan()
 *   job.stop();                                                            // stops early (keeps what was recorded)
 *   const r = await job.done;   // { ok, path, ms, mime, bytes, width, height, fps, stopped } | { ok:false, code, message }
 *
 * The page talks over ipcMain.on channels trailer-rec:* (one hidden window per recording, matched by a token).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { setWebmDuration, probeWebm } = require('./webm-tools');

function createTrailerRecorder(d = {}) {
  const electron = d.electron;
  const log = d.log || (() => {});
  const dir = d.dir || __dirname;
  const sessions = new Map();
  let wired = false;

  function wire() {
    if (wired) return;
    wired = true;
    const { ipcMain } = electron;
    const of = (e, tok) => { const s = sessions.get(tok); return s && s.win && !s.win.isDestroyed() && e.sender === s.win.webContents ? s : null; };
    ipcMain.on('trailer-rec:ready', (e, tok) => { const s = of(e, tok); if (s) s.win.webContents.send('trailer-rec:plan', s.plan); });
    ipcMain.on('trailer-rec:chunk', (e, tok, bytes) => {
      const s = of(e, tok); if (!s || s.finished) return;
      try { const b = Buffer.from(bytes.buffer ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes); fs.writeSync(s.fd, b); s.bytes += b.length; } catch (err) { s.finish({ ok: false, code: 'RECORD_FAILED', message: `The trailer could not be written (${err.code || err.message}).` }); }
    });
    ipcMain.on('trailer-rec:progress', (e, tok, p) => { const s = of(e, tok); if (s && s.onProgress) { try { s.onProgress(p || {}); } catch (_) {} } });
    ipcMain.on('trailer-rec:done', (e, tok, info) => { const s = of(e, tok); if (s) s.finish(Object.assign({ ok: true }, info || {})); });
    ipcMain.on('trailer-rec:fail', (e, tok, err) => { const s = of(e, tok); if (s) s.finish({ ok: false, code: (err && err.code) || 'RECORD_FAILED', message: (err && err.message) || 'The trailer could not be recorded.' }); });
  }

  function record(plan, outPath, o = {}) {
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const token = crypto.randomBytes(12).toString('hex');
    const total = Number(plan && plan.total) || 0;
    const s = { plan, onProgress: o.onProgress, bytes: 0, finished: false, win: null, fd: null, timer: null };
    const finish = (r) => {
      if (s.finished) return;
      s.finished = true;
      if (s.timer) clearTimeout(s.timer);
      try { if (s.fd != null) fs.closeSync(s.fd); } catch (_) {}
      try { if (s.win && !s.win.isDestroyed()) s.win.destroy(); } catch (_) {}
      sessions.delete(token);
      let out = r;
      if (r.ok) {
        try {
          const raw = fs.readFileSync(outPath);
          const pr = probeWebm(raw);
          if (!pr.ok) out = { ok: false, code: 'RECORD_FAILED', message: 'The recording came out empty (no video frames).' };
          else {
            const ms = Math.max(pr.lastMs, Math.min(Number(r.ms) || pr.lastMs, pr.lastMs + 1000));
            const fixed = setWebmDuration(raw, ms);
            fs.writeFileSync(outPath, fixed);
            out = Object.assign({}, r, { path: outPath, bytes: fixed.length, ms, seconds: Math.round(ms / 10) / 100, tracks: pr.tracks });
          }
        } catch (e) { out = { ok: false, code: 'RECORD_FAILED', message: `The trailer could not be finished (${e.code || e.message}).` }; }
      } else { try { fs.unlinkSync(outPath); } catch (_) {} }
      log('trailer-record', { ok: !!out.ok, code: out.ok ? undefined : out.code, bytes: out.bytes, ms: out.ms });
      resolveDone(out);
    };
    s.finish = finish;
    try {
      wire();
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      s.fd = fs.openSync(outPath, 'w');
      const { BrowserWindow } = electron;
      s.win = new BrowserWindow({
        show: false, width: Math.max(320, Math.round((plan && plan.width) || 1280)), height: Math.max(240, Math.round((plan && plan.height) || 720)),
        paintWhenInitiallyHidden: true, skipTaskbar: true, focusable: false,
        webPreferences: {
          offscreen: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
          contextIsolation: true, nodeIntegration: false, sandbox: false,
          // the page only loads this app's own file and the local clips; without this the canvas would be
          // "tainted" by file:// video and MediaRecorder would get no frames
          webSecurity: false,
          preload: path.join(dir, 'trailer-recorder-preload.js'), additionalArguments: [`--trailer-token=${token}`],
        },
      });
      sessions.set(token, s);
      s.win.webContents.on('render-process-gone', (_e, det) => finish({ ok: false, code: 'RECORD_FAILED', message: `The recorder stopped (${(det && det.reason) || 'crashed'}).` }));
      s.win.webContents.on('did-fail-load', (_e, code, desc) => finish({ ok: false, code: 'RECORD_FAILED', message: `The recorder page did not load (${desc || code}).` }));
      // a hard limit: the trailer's length + loading time
      s.timer = setTimeout(() => finish({ ok: false, code: 'RECORD_TIMEOUT', message: 'Recording the trailer took far longer than the trailer itself.' }), Math.round(total * 1000 * 3 + (o.loadMs || 120000)));
      s.win.loadFile(path.join(dir, 'trailer-recorder.html')).catch((e) => finish({ ok: false, code: 'RECORD_FAILED', message: `The recorder page did not load (${e.message}).` }));
    } catch (e) {
      finish({ ok: false, code: 'RECORD_FAILED', message: `The recorder could not start (${e.message}).` });
    }
    return {
      done,
      stop: () => { if (!s.finished && s.win && !s.win.isDestroyed()) { try { s.win.webContents.send('trailer-rec:stop'); } catch (_) {} } },
      abort: () => finish({ ok: false, code: 'VIDEO_CANCELLED', message: 'Stopped.' }),
    };
  }

  return { record };
}

module.exports = { createTrailerRecorder };
