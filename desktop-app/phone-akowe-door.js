'use strict';
// phone-akowe-door.js — 📱📚 the book app (Akọwe) on the phone: everything Akọwe's own window can do.
//
// Akọwe's web app runs on this PC only (http://127.0.0.1:<port>). The door is a second small server, on the phone
// server's port + 1, that passes the phone's requests on to Akọwe unchanged — so Akọwe's own pages, buttons and
// downloads work on the phone exactly as in its window. Two locks:
//   1. the door cookie: set only by the phone app (GET /api/akowe/link, which needs the pairing key); without it the
//      door answers "open the book app from the phone app";
//   2. Akọwe's own access token (in the link's #token=…): Akọwe itself refuses every request without it.
// Off whenever the phone app is off.

const http = require('http');
const crypto = require('crypto');

const COOKIE = 'ai_book_door';

function doorValue(key) { return crypto.createHmac('sha256', String(key || '')).update('akowe-door').digest('hex').slice(0, 48); }

function cookieOf(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function sameValue(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createAkoweDoor(deps) {
  const d = deps || {};
  const log = d.log || (() => {});
  let server = null;
  let info = null;

  const NOT_PAIRED = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Book app</title><body style="font:16px system-ui,sans-serif;padding:24px;max-width:520px;margin:auto">'
    + '<h1>📚 Open the book app from the phone app</h1><p>For safety, the book app opens only from AutoInjector\'s phone app '
    + 'on a paired phone. Open the phone app and press <b>📚 Book app</b>.</p></body>';

  function handle(req, res) {
    const key = d.key ? d.key() : '';
    if (!sameValue(cookieOf(req.headers.cookie, COOKIE), doorValue(key))) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(NOT_PAIRED);
    }
    const port = d.akowePort ? d.akowePort() : 0;
    if (!port) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(NOT_PAIRED.replace(/<h1>.*<\/p>/, '<h1>📚 The book app isn\'t running on the PC</h1><p>Start it on the PC (it starts with AutoInjector), then try again.</p>'));
    }
    const headers = Object.assign({}, req.headers, { host: `127.0.0.1:${port}` });
    delete headers.cookie; // the door's cookie is for the door only
    delete headers.origin; delete headers.referer;
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (ur) => {
      const h = Object.assign({}, ur.headers);
      if (h.location && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(h.location)) h.location = h.location.replace(/^https?:\/\/[^/]+/i, '');
      res.writeHead(ur.statusCode || 502, h);
      ur.pipe(res);
    });
    up.on('error', (e) => {
      try {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'BOOK_APP_UNREACHABLE', words: 'The book app on the PC did not answer.' }));
      } catch (_) { /* already answering */ }
      log('phone-book-door', { step: 'upstream-error', error: String(e.code || e.message).slice(0, 80) });
    });
    up.setTimeout(10 * 60 * 1000, () => up.destroy(new Error('timeout'))); // a long export may take minutes
    req.pipe(up);
  }

  return {
    start({ port, host } = {}) {
      return new Promise((resolve) => {
        if (server) { resolve({ ok: true, port: info.port, already: true }); return; }
        const s = http.createServer((req, res) => { try { handle(req, res); } catch (e) { try { res.writeHead(500); res.end(); } catch (_) {} } });
        s.headersTimeout = 20000;
        s.once('error', (e) => resolve({ ok: false, error: e.code || 'START_FAILED' }));
        s.listen(port, host || '0.0.0.0', () => {
          server = s;
          info = { port: s.address().port, host: host || '0.0.0.0' };
          log('phone-book-door', { step: 'started', port: info.port });
          resolve({ ok: true, port: info.port });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!server) { resolve({ ok: true }); return; }
        const s = server; server = null; info = null;
        try { if (s.closeAllConnections) s.closeAllConnections(); } catch (_) {}
        s.close(() => resolve({ ok: true }));
      });
    },
    running: () => !!server,
    info: () => (info ? Object.assign({}, info) : null),
    handle,
  };
}

module.exports = { createAkoweDoor, doorValue, cookieOf, COOKIE };
