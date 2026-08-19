'use strict';
/*
 * file-downloader.js — stream a URL to a file on disk with progress and cancel.
 *
 * Used by the Setup Wizard's download queue for big files (Stable Diffusion
 * checkpoints, etc.). Deliberately dependency-free (Node's own http/https):
 *   - follows redirects (Hugging Face 302s to a CDN),
 *   - reports {got,total,pct} as bytes arrive,
 *   - writes to a `.part` temp file and renames on success (so a half file is
 *     never mistaken for a complete one),
 *   - is abortable via an AbortSignal (deletes the partial file).
 */
const fs = require('fs');
const path = require('path');

function download(url, destPath, opts = {}) {
  const { onProgress, signal, redirects = 6 } = opts;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('aborted'));
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error(`bad url: ${url}`)); }
    const mod = u.protocol === 'http:' ? require('http') : require('https');
    const tmp = destPath + '.part';

    const req = mod.get(u, (res) => {
      const code = res.statusCode || 0;
      // Redirect — follow it (resolving relative Location against the current URL).
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        return download(next, destPath, { ...opts, redirects: redirects - 1 }).then(resolve, reject);
      }
      if (code !== 200) { res.resume(); return reject(new Error(`HTTP ${code}`)); }

      const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      let got = 0;
      try { fs.mkdirSync(path.dirname(destPath), { recursive: true }); } catch (_) {}
      const out = fs.createWriteStream(tmp);
      const cleanup = () => { try { fs.unlinkSync(tmp); } catch (_) {} };

      res.on('data', (chunk) => {
        got += chunk.length;
        if (typeof onProgress === 'function') {
          onProgress({ got, total, pct: total ? Math.min(100, Math.round((got / total) * 100)) : null });
        }
      });
      res.on('error', (e) => { cleanup(); reject(e); });
      out.on('error', (e) => { cleanup(); reject(e); });
      out.on('finish', () => out.close(() => {
        try { fs.renameSync(tmp, destPath); resolve({ ok: true, path: destPath, bytes: got }); }
        catch (e) { reject(e); }
      }));
      res.pipe(out);
    });

    req.on('error', (e) => reject(e));
    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy(new Error('aborted'));
        try { fs.unlinkSync(tmp); } catch (_) {}
        reject(new Error('aborted'));
      }, { once: true });
    }
  });
}

module.exports = { download };
