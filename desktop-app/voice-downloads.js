'use strict';
/*
 * voice-downloads.js — downloads read-aloud voice files when the user presses ⬇ (🔊 Voice box → Better voices).
 *
 *   start({ id, dir, files:[{ name, url, bytes?, minBytes?, json? }] })
 *       downloads each file into dir. Small files (the .onnx.json settings) go first, so a missing one fails before
 *       100 MB are fetched. While it runs:
 *         - progress goes to emit({ id, phase:'progress', file, got, total, pct }) a few times a second;
 *         - each file is written to "<name>.part" and renamed only when complete and checked (size floor, exact size
 *           when known, a .json must parse) — a broken download never looks like a voice;
 *         - a dropped connection is retried (a few times) and RESUMES where it stopped (HTTP Range), also on the next
 *           press of ⬇ after a cancel or an app restart;
 *         - a file that is already there is never overwritten: a good one is kept ("already there"), a damaged one is
 *           left alone with a plain message saying what to do.
 *   cancel(id)      stops it; the .part file stays so the next ⬇ continues from there.
 *   active()        what is downloading now.
 *   fetchSmall(url) a short sample recording (▶ before downloading), size-capped, kept in memory only.
 *
 * Only https (and http to this computer, for the tests). Logs carry the id, file NAME, sizes and codes only.
 * Electron-free; unit-tested in test/voice-downloads.test.js with a fake server.
 */
const fsReal = require('fs');
const path = require('path');
const httpsReal = require('https');
const httpReal = require('http');

const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;

function mb(n) { const m = (Number(n) || 0) / (1024 * 1024); return m >= 10 ? `${Math.round(m)} MB` : `${m.toFixed(1)} MB`; }

function createVoiceDownloads(opts = {}) {
  const fs = opts.fs || fsReal;
  const libs = { 'https:': opts.https || httpsReal, 'http:': opts.http || httpReal };
  const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : 3;
  const retryDelayMs = Number.isFinite(opts.retryDelayMs) ? opts.retryDelayMs : 1500;
  const progressMs = Number.isFinite(opts.progressMs) ? opts.progressMs : 250;
  const jobs = new Map(); // id -> { cancelled, req, file, got, total }

  function urlOk(u) {
    let url; try { url = new URL(u); } catch (_) { return null; }
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && LOCAL.has(url.hostname)) return url;
    return null;
  }

  /** Is a finished file broken? -> a short reason, or ''. */
  function fileProblem(p, f) {
    let st; try { st = fs.statSync(p); } catch (_) { return 'missing'; }
    if (!st.size) return 'empty';
    if (f.bytes && st.size !== f.bytes) return `${st.size} bytes, expected ${f.bytes}`;
    if (f.minBytes && st.size < f.minBytes) return `only ${st.size} bytes`;
    if (f.json) { try { JSON.parse(String(fs.readFileSync(p, 'utf8'))); } catch (_) { return 'not valid settings (JSON)'; } }
    return '';
  }

  // One HTTP GET into <part>, resuming from its current size. -> { ok, got, total } | { ok:false, error, retry }
  function getOnce(job, f, part, fileUrl, redirects) {
    return new Promise((resolve) => {
      const url = urlOk(fileUrl);
      if (!url) return resolve({ ok: false, error: 'BAD_URL', retry: false });
      let have = 0; try { have = fs.statSync(part).size; } catch (_) { have = 0; }
      const headers = { 'User-Agent': 'AutoInjector-voices', Accept: '*/*' };
      if (have > 0) headers.Range = `bytes=${have}-`;
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; job.req = null; resolve(r); } };
      let req;
      try {
        req = libs[url.protocol].get({ hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, headers, timeout: 30000 }, (res) => {
          const sc = res.statusCode || 0;
          if (sc >= 300 && sc < 400 && res.headers.location) {
            res.resume();
            if (redirects >= 6) return done({ ok: false, error: 'TOO_MANY_REDIRECTS', retry: false });
            let next; try { next = new URL(res.headers.location, url).toString(); } catch (_) { return done({ ok: false, error: 'BAD_URL', retry: false }); }
            return getOnce(job, f, part, next, redirects + 1).then(done);
          }
          if (sc === 416 && have > 0) { // asked past the end: the .part is already whole (or junk)
            res.resume();
            if (f.bytes && have === f.bytes) return done({ ok: true, got: have, total: have });
            try { fs.unlinkSync(part); } catch (_) {}
            return done({ ok: false, error: 'RESTART', retry: true, now: true });
          }
          if (sc !== 200 && sc !== 206) { res.resume(); return done({ ok: false, error: `HTTP_${sc}`, retry: sc >= 500 || sc === 429 }); }
          const append = sc === 206 && have > 0;
          let total = 0;
          if (sc === 206) { const m = /\/(\d+)\s*$/.exec(String(res.headers['content-range'] || '')); total = m ? Number(m[1]) : 0; }
          else total = Number(res.headers['content-length']) || 0;
          if (!total && f.bytes) total = f.bytes;
          let got = append ? have : 0;
          let out;
          try { out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' }); } catch (e) { res.resume(); return done({ ok: false, error: `WRITE: ${(e && e.code) || e}`, retry: false }); }
          job.file = f.name; job.total = total; job.got = got;
          let lastAt = 0;
          res.on('data', (c) => {
            got += c.length; job.got = got;
            const now = Date.now();
            if (now - lastAt >= progressMs) { lastAt = now; emit({ id: job.id, phase: 'progress', file: f.name, got, total, pct: total ? Math.min(100, Math.floor((got / total) * 100)) : null }); }
          });
          res.pipe(out);
          // the result is decided when the file is closed, so a retry never writes while this one is still flushing
          let failure = null;
          const broke = (why) => { if (!failure) failure = { ok: false, error: job.cancelled ? 'CANCELLED' : why, retry: !job.cancelled }; try { res.unpipe(out); } catch (_) {} try { out.end(); } catch (_) {} };
          res.on('aborted', () => broke('CONNECTION_DROPPED'));
          res.on('error', (e) => broke(String((e && e.code) || 'CONNECTION_DROPPED')));
          out.on('error', (e) => { failure = { ok: false, error: `WRITE: ${(e && e.code) || e}`, retry: false }; try { res.destroy(); } catch (_) {} });
          out.on('close', () => {
            if (failure) return done(failure);
            if (job.cancelled) return done({ ok: false, error: 'CANCELLED', retry: false });
            if (total && got < total) return done({ ok: false, error: 'CONNECTION_DROPPED', retry: true });
            done({ ok: true, got, total: total || got });
          });
        });
      } catch (e) { return done({ ok: false, error: String((e && e.code) || e), retry: true }); }
      job.req = req;
      req.on('timeout', () => { try { req.destroy(new Error('TIMEOUT')); } catch (_) {} });
      req.on('error', (e) => done({ ok: false, error: job.cancelled ? 'CANCELLED' : String((e && e.code) || (e && e.message) || e), retry: !job.cancelled }));
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function oneFile(job, dir, f) {
    const dest = path.join(dir, f.name);
    const part = `${dest}.part`;
    if (fs.existsSync(dest)) {
      const why = fileProblem(dest, f);
      if (!why) { emit({ id: job.id, phase: 'file-done', file: f.name, already: true }); return { ok: true, already: true, path: dest }; }
      return { ok: false, error: 'FILE_IN_THE_WAY', file: f.name, message: `A file called ${f.name} is already in the voice folder but looks incomplete (${why}). It was left alone — delete it from the models/voice folder and press ⬇ again.` };
    }
    let tries = 0;
    for (;;) {
      if (job.cancelled) return { ok: false, error: 'CANCELLED' };
      const r = await getOnce(job, f, part, f.url, 0);
      if (r.ok) break;
      if (r.error === 'CANCELLED' || job.cancelled) return { ok: false, error: 'CANCELLED' };
      if (!r.retry || tries >= maxRetries) {
        log('voice-download', { id: job.id, file: f.name, step: 'failed', error: r.error });
        return { ok: false, error: r.error, file: f.name };
      }
      tries++;
      if (!r.now) {
        emit({ id: job.id, phase: 'retry', file: f.name, attempt: tries, message: `The connection dropped — trying again (${tries} of ${maxRetries}), carrying on where it stopped…` });
        await sleep(retryDelayMs * tries);
      }
    }
    const why = fileProblem(part, f);
    if (why) { try { fs.unlinkSync(part); } catch (_) {} return { ok: false, error: 'DAMAGED', file: f.name, message: `${f.name} arrived damaged (${why}). Press ⬇ to try again.` }; }
    if (fs.existsSync(dest)) return { ok: false, error: 'FILE_IN_THE_WAY', file: f.name, message: `A file called ${f.name} appeared in the voice folder while downloading; it was left alone.` };
    try { fs.renameSync(part, dest); } catch (e) { return { ok: false, error: `WRITE: ${(e && e.code) || e}`, file: f.name }; }
    emit({ id: job.id, phase: 'file-done', file: f.name });
    return { ok: true, path: dest };
  }

  function plain(r) {
    const e = String(r.error || '');
    if (r.message) return r.message;
    if (e === 'CANCELLED') return 'Download stopped. Press ⬇ again to carry on where it stopped.';
    if (e === 'HTTP_404') return `${r.file || 'A file'} isn't on the download site any more. Pick another voice.`;
    if (/^HTTP_/.test(e)) return `The download site answered with an error (${e.replace('_', ' ')}). Try again later.`;
    if (/^WRITE/.test(e)) return "Couldn't save the file — is the disk full? Free some space and press ⬇ again.";
    if (e === 'BAD_URL' || e === 'BAD_NAME') return "That voice's download address isn't valid.";
    return "The download didn't finish (the internet connection dropped?). Press ⬇ again — it carries on where it stopped.";
  }

  async function start(spec) {
    const s = spec || {};
    const id = String(s.id || '');
    if (!id) return { ok: false, error: 'NO_ID', message: 'Nothing to download.' };
    if (jobs.has(id)) return { ok: false, error: 'ALREADY_RUNNING', id, message: 'That voice is already downloading.' };
    const files = Array.isArray(s.files) ? s.files.slice() : [];
    if (!files.length || !files.every((f) => f && SAFE_NAME.test(String(f.name || '')) && !/\.\./.test(f.name) && urlOk(f.url))) return { ok: false, error: 'BAD_NAME', id, message: plain({ error: 'BAD_NAME' }) };
    let dir = s.dir;
    try { if (typeof dir === 'function') dir = dir(); fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: 'NO_FOLDER', id, message: "Couldn't open the voice folder." }; }
    files.sort((a, b) => (a.json ? 0 : 1) - (b.json ? 0 : 1)); // the small settings file first
    const job = { id, cancelled: false, req: null, file: '', got: 0, total: 0, bytes: files.reduce((n, f) => n + (f.bytes || 0), 0) };
    jobs.set(id, job);
    emit({ id, phase: 'start', total: job.bytes });
    log('voice-download', { id, step: 'start', mb: Math.round(job.bytes / 1048576) });
    const saved = [];
    try {
      for (const f of files) {
        const r = await oneFile(job, dir, f);
        if (!r.ok) {
          const out = { ok: false, id, error: r.error, file: r.file || f.name, message: plain(r) };
          emit({ id, phase: r.error === 'CANCELLED' ? 'cancelled' : 'error', file: out.file, error: out.error, message: out.message });
          log('voice-download', { id, step: r.error === 'CANCELLED' ? 'cancelled' : 'error', file: out.file, error: out.error });
          return out;
        }
        saved.push(r.path);
      }
    } finally { jobs.delete(id); }
    const message = `Ready (${mb(job.bytes)}).`;
    emit({ id, phase: 'done', message });
    log('voice-download', { id, step: 'done' });
    return { ok: true, id, paths: saved, message };
  }

  function cancel(id) {
    const job = jobs.get(String(id || ''));
    if (!job) return { ok: false, error: 'NOT_RUNNING' };
    job.cancelled = true;
    try { if (job.req) job.req.destroy(); } catch (_) {}
    return { ok: true };
  }
  function active() { return [...jobs.values()].map((j) => ({ id: j.id, file: j.file, got: j.got, total: j.total })); }
  /** Bytes already fetched for a file (a .part to resume), for "carries on from 40 MB". */
  function partial(dir, name) { try { return fs.statSync(path.join(dir, `${name}.part`)).size; } catch (_) { return 0; } }

  // A short sample recording, kept in memory (never saved), capped in size.
  function fetchSmall(fileUrl, maxBytes = 1024 * 1024, redirects = 0) {
    return new Promise((resolve) => {
      const url = urlOk(fileUrl);
      if (!url) return resolve({ ok: false, error: 'BAD_URL' });
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      let req;
      try {
        req = libs[url.protocol].get({ hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, headers: { 'User-Agent': 'AutoInjector-voices' }, timeout: 15000 }, (res) => {
          const sc = res.statusCode || 0;
          if (sc >= 300 && sc < 400 && res.headers.location && redirects < 6) { res.resume(); let n; try { n = new URL(res.headers.location, url).toString(); } catch (_) { return done({ ok: false, error: 'BAD_URL' }); } return fetchSmall(n, maxBytes, redirects + 1).then(done); }
          if (sc !== 200) { res.resume(); return done({ ok: false, error: `HTTP_${sc}` }); }
          const parts = []; let n = 0;
          res.on('data', (c) => { n += c.length; if (n > maxBytes) { try { req.destroy(); } catch (_) {} return done({ ok: false, error: 'TOO_BIG' }); } parts.push(c); });
          res.on('end', () => done({ ok: true, buffer: Buffer.concat(parts), mime: String(res.headers['content-type'] || 'audio/mpeg').split(';')[0] }));
          res.on('error', () => done({ ok: false, error: 'CONNECTION_DROPPED' }));
        });
      } catch (e) { return done({ ok: false, error: String((e && e.code) || e) }); }
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} done({ ok: false, error: 'TIMEOUT' }); });
      req.on('error', (e) => done({ ok: false, error: String((e && e.code) || e) }));
    });
  }

  return { start, cancel, active, partial, fetchSmall, fileProblem };
}

module.exports = { createVoiceDownloads };
