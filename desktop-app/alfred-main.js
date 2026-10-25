'use strict';
/*
 * alfred-main.js — wires 🎩 Alfred into the Electron main process. main.js calls
 * installAlfred(hooks) once (one small, clearly marked block) and hands over the app's own
 * functions; everything Alfred does goes through them:
 *   Akọwe            hooks.akoweApi (Akọwe's HTTP API with the token AutoInjector already holds)
 *   images           alfred-image.js (the one adapter over image-provider — re-point it later)
 *   video            video-provider.js (reported as not available until a backend is set up)
 *   AI panes         sendTextTo + the captured replies, the self-repair check-in, pane health
 *   files / logs     the output folders, the log Extract ("This book only")
 *   Open Interpreter interpreter-provider.js (only when turned on in Alfred's settings)
 * IPC: alfred:* handlers; UI events go out on the "alfred" channel.
 */
const fs = require('fs');
const path = require('path');
const { createAlfred } = require('./alfred');
const { createImageAdapter } = require('./alfred-image');

const NEVER_OPEN = /\.(exe|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|lnk|jar|sh|bash|py|pyw|app|command|reg|hta|cpl|dll)$/i;

function installAlfred(h) {
  const { ipcMain, shell } = h;
  const image = createImageAdapter({ imageProvider: h.imageProvider, outputManager: h.outputManager, dbService: h.dbService });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SITE_IDS = h.siteIds;

  function listOutputs(category, limit) {
    let dir;
    try { dir = h.outputManager.dir(category); } catch (_) { return []; }
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return []; }
    return names.map((n) => { const p = path.join(dir, n); try { const st = fs.statSync(p); return st.isFile() ? { name: n, path: p, size: st.size, modified: new Date(st.mtimeMs).toISOString(), mtime: st.mtimeMs } : null; } catch (_) { return null; } })
      .filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, Math.max(1, Math.min(100, limit || 20))).map(({ mtime, ...rest }) => rest);
  }
  async function openOutput(p) {
    const root = h.outputManager.root();
    if (!root) return { ok: false, error: 'NO_OUTPUT_FOLDER' };
    const full = path.resolve(path.isAbsolute(p) ? p : path.join(root, p));
    const rel = path.relative(root, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'OUTSIDE_OUTPUTS', message: 'I only open files from the app\'s output folders.' };
    if (NEVER_OPEN.test(full)) return { ok: false, error: 'NOT_ALLOWED', message: 'I never open programs or scripts.' };
    if (!fs.existsSync(full)) return { ok: false, error: 'NOT_FOUND', message: 'That file does not exist.' };
    try { const err = await shell.openPath(full); return err ? { ok: false, error: 'OPEN_FAILED' } : { ok: true }; } catch (_) { return { ok: false, error: 'OPEN_FAILED' }; }
  }
  function exportLogs({ scope, bookId }) {
    const opts = scope === 'day' ? { scope: 'time', preset: 'day' } : scope === 'everything' ? { scope: 'everything' } : { scope: 'book', bookId };
    const r = h.buildExtract(opts);
    if (!r.ok) return { ok: false, error: r.error };
    const file = h.outputManager.saveBuffer(h.outputManager.logsDir(), r.fileName, r.text);
    h.logEvent('extract-all', { scope: r.scope, book: r.book ? r.book.id : undefined, messages: r.counts.messages, logEntries: r.counts.events, redactions: r.redactions, via: 'alfred' });
    return { ok: true, file };
  }
  async function generateVideo(prompt) {
    const r = await h.videoProvider.generate(prompt, {});
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'FAILED', message: r && r.message };
    if (r.videoBase64) {
      try { return { ok: true, path: h.outputManager.saveBuffer(h.outputManager.videosDir(), `vid-${Date.now()}.mp4`, Buffer.from(r.videoBase64, 'base64')) }; }
      catch (_) { return { ok: false, error: 'SAVE_FAILED' }; }
    }
    return { ok: true, url: r.videoUrl || null };
  }
  async function sendToAi(sites, text) {
    const out = {};
    for (const s of sites) {
      if (!h.state.enabled[s]) { out[s] = { ok: false, error: 'TURNED_OFF' }; continue; }
      try { out[s] = await h.sendTextTo(s, h.withEnvelope(String(text), s), null); } catch (e) { out[s] = { ok: false, error: 'SEND_FAILED' }; }
    }
    return out;
  }
  function latestReply(site) {
    const t = (h.state.transcript || []).filter((x) => x.site === site).pop();
    return t ? { text: t.text, ts: t.ts } : null;
  }
  function aiHealth() {
    const sr = h.selfRepairStatus();
    const out = {};
    for (const s of SITE_IDS) {
      const x = (sr.sites && sr.sites[s]) || {};
      const p = x.problem;
      out[s] = { name: x.label || s, active: !!x.active, state: x.state || 'unknown', problem: p ? (p.say || p.code || String(p)).toString().slice(0, 200) : null };
    }
    return out;
  }
  function runCheckin(sites) {
    const want = sites && sites.length ? sites.filter((s) => SITE_IDS.includes(s)) : null;
    for (const s of (want || SITE_IDS)) { try { h.selfRepair.userActed(s); } catch (_) {} }
    const r = h.selfRepair.probeMany(want, 'alfred', 'demand');
    h.logEvent('self-repair', { step: 'check', reason: 'alfred', outcome: `started:${(r.started || []).length}` });
    return r;
  }
  async function openAkowePage(hash) {
    const base = h.akoweServerBase();
    if (!base) return { ok: false, error: 'AKOWE_NOT_READY' };
    const url = `${base.replace(/\/$/, '')}/${hash}`;
    let ok = false;
    try { ok = h.akoweShowInTab(url); } catch (_) {}
    if (!ok) { try { h.akoweLoadView(true); await sleep(300); ok = h.akoweShowInTab(url); } catch (_) {} }
    return { ok: !!ok };
  }
  /** A web AI pane as Alfred's brain: type the prompt, wait for the next captured reply. */
  async function paneAsk(site, text, { timeoutMs, signal } = {}) {
    if (!h.state.enabled[site]) return { ok: false, error: 'TURNED_OFF' };
    const sentTs = Date.now();
    const r = await h.sendTextTo(site, h.withEnvelope(String(text), site), null);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'SEND_FAILED' };
    const end = Date.now() + (timeoutMs || 180000);
    while (Date.now() < end) {
      if (signal && signal.aborted) return { ok: false, error: 'CANCELLED' };
      const t = (h.state.transcript || []).filter((x) => x.site === site && x.ts >= sentTs).pop();
      if (t && t.text) return { ok: true, text: t.text };
      await sleep(400);
    }
    return { ok: false, error: 'TIMEOUT' };
  }

  const ctx = {
    akowe: (method, p, body) => h.akoweApi(method, p, body, 20000),
    openAkowePage,
    generateImage: (o) => image.generate(o),
    listOutputs: async (cat, limit) => listOutputs(cat, limit),
    videoStatus: () => h.videoProvider.status(),
    generateVideo,
    sendToAi, latestReply, aiHealth, runCheckin,
    openOutput, exportLogs: async (o) => exportLogs(o),
    interpreterRun: (task) => {
      const st = h.interpreterProvider.status();
      if (!st.enabled || !st.configured) return Promise.resolve({ ok: false, error: 'INTERPRETER_NOT_SET_UP' });
      return h.interpreterProvider.run(task, { onEvent: () => {} });
    },
  };

  const alfred = createAlfred({
    settingsFile: path.join(h.userDataDir(), 'alfred-settings.json'),
    ctx,
    log: (kind, detail) => h.logEvent(kind, detail),
    emit: (payload) => h.broadcast('alfred', payload),
    journal: (pid, code, title) => h.akoweApi('POST', `/api/projects/${encodeURIComponent(pid)}/branches/main/journal/note`, { source: 'alfred', code, title }, 8000),
    managerConfig: () => { const c = h.state.managerConfig || {}; return c.endpoint && c.model ? { endpoint: c.endpoint, apiKey: c.apiKey, model: c.model } : null; },
    managedOllama: () => { try { return h.ollamaManager.managedStatus(); } catch (_) { return null; } },
    paneAsk,
    akoweReady: () => !!h.akoweServerBase(),
    connected: () => {
      const im = h.imageProvider.status(); const vi = h.videoProvider.status(); const oi = h.interpreterProvider.status();
      return { akowe: !!h.akoweServerBase(), images: !!(im.enabled && im.configured), video: !!(vi.enabled && vi.configured), panes: SITE_IDS.filter((s) => h.state.enabled[s]).length, interpreter: !!(oi.enabled && oi.configured) };
    },
  });

  // App events -> the watcher (ignored while Alfred is off; the listener itself does nothing then).
  h.broadcastListeners.add((channel, payload) => {
    if (channel === 'alfred') return;
    if (channel === 'self-repair' || channel === 'manager-log') { try { alfred.onAppEvent(channel, payload); } catch (_) {} }
  });

  ipcMain.handle('alfred:status', () => alfred.status());
  ipcMain.handle('alfred:set-enabled', (_e, p) => alfred.setEnabled(!!(p && p.on)));
  ipcMain.handle('alfred:settings', (_e, patch) => alfred.setSettings(patch || {}));
  ipcMain.handle('alfred:ask', async (_e, p) => { try { return await alfred.ask(p && p.text); } catch (e) { return { ok: false, error: 'ERROR', message: 'Something went wrong on my side.' }; } });
  ipcMain.handle('alfred:confirm', async (_e, p) => { try { return await alfred.confirm(p && p.id, { alwaysAllow: p && p.alwaysAllow }); } catch (e) { return { ok: false, error: 'ERROR' }; } });
  ipcMain.handle('alfred:reject', (_e, p) => alfred.reject(p && p.id));
  ipcMain.handle('alfred:cancel', () => alfred.cancel());
  ipcMain.handle('alfred:clear', () => alfred.clearChat());
  ipcMain.handle('alfred:test-ai', async () => { try { return await alfred.testAi(); } catch (_) { return { ok: false }; } });
  ipcMain.handle('alfred:models', async () => {
    const s = alfred.getSettings();
    const base = (s.local.endpoint || 'http://127.0.0.1:11434/v1').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    try { return await h.ollamaManager.listInstalled(base, 3000); } catch (_) { return { ok: false, models: [] }; }
  });
  ipcMain.handle('alfred:open-path', async (_e, p) => openOutput(String((p && p.path) || '')));
  return alfred;
}

module.exports = { installAlfred };
