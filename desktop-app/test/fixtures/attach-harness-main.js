// attach-harness-main.js — a bare Electron app for test/e2e/file-attach.e2e.js: one window, and two functions the test
// calls through Playwright's app.evaluate(): the NEW attach (file-attach.js, exactly as main.js uses it) and the OLD
// one (build 76b8da7: the first document.querySelector() match of the site's FILE_INPUT_CANDIDATES, else
// NO_FILE_INPUT_FOUND), each on a fixture page loaded fresh.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { attachFile } = require('../../file-attach');
const SITES = require('../../selectors');

let win = null;
async function load(url) {
  if (!win) win = new BrowserWindow({ width: 900, height: 600, show: true, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL(url);
  return win.webContents;
}
global.runAttach = async ({ url, file, opts }) => {
  const wc = await load(url);
  const dbg = wc.debugger;
  dbg.attach('1.3');
  const t0 = Date.now();
  try {
    const r = await attachFile(dbg, file, Object.assign({ composer: SITES.claude.INPUT_CANDIDATES, candidates: SITES.claude.FILE_INPUT_CANDIDATES, verifyMs: 1500, revealWaitMs: 800 }, opts || {}));
    const page = await wc.executeJavaScript('({ got: window.__attach.got, wrong: window.__attach.wrong, ignored: window.__attach.ignored || 0, chips: document.querySelectorAll("[data-testid=file-thumbnail]").length, menuOpen: !!document.querySelector("[role=menu]") })', true);
    return Object.assign({ ms: Date.now() - t0 }, r, { page });
  } finally { try { dbg.detach(); } catch (_) {} }
};
global.runOld = async ({ url, file }) => {
  const wc = await load(url);
  const dbg = wc.debugger;
  dbg.attach('1.3');
  try {
    const expr = `(() => { const CANDIDATES = ${JSON.stringify(SITES.claude.FILE_INPUT_CANDIDATES)}; for (const sel of CANDIDATES) { const n = document.querySelector(sel); if (n) return n; } return null; })()`;
    const ev = await dbg.sendCommand('Runtime.evaluate', { expression: expr, returnByValue: false });
    const objectId = ev && ev.result && ev.result.objectId;
    if (!objectId) return { ok: false, error: 'NO_FILE_INPUT_FOUND' };
    await dbg.sendCommand('DOM.setFileInputFiles', { files: [file], objectId });
    const page = await wc.executeJavaScript('({ got: window.__attach.got })', true);
    return { ok: true, page };
  } finally { try { dbg.detach(); } catch (_) {} }
};
app.whenReady().then(() => load('about:blank'));
app.on('window-all-closed', () => app.quit());
void path;
