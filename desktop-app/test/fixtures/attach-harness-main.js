// attach-harness-main.js — a bare Electron app for test/e2e/file-attach.e2e.js: one window, and two functions the test
// calls through Playwright's app.evaluate(): the NEW attach (file-attach.js, exactly as main.js uses it) and the OLD
// one (build 76b8da7: the first document.querySelector() match of the site's FILE_INPUT_CANDIDATES, else
// NO_FILE_INPUT_FOUND), each on a fixture page loaded fresh.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { attachFile } = require('../../file-attach');
const SITES = require('../../selectors');

let win = null;
let ready = null; // the start-up load of about:blank; every test call waits for it first (a call that raced it was
                  // cut off by that load under load — "Script failed to execute" on the first step)
async function load(url) {
  if (ready) await ready;
  if (!win) win = new BrowserWindow({ width: 900, height: 600, show: true, webPreferences: { sandbox: true, contextIsolation: true } });
  // a fixture page can fail to load (ERR_FAILED) on a very busy machine (seen with 5 test runs at once); try again
  for (let i = 0; ; i++) {
    try { await win.loadURL(url); break; } catch (e) { if (i >= 2) throw e; await new Promise((r) => setTimeout(r, 500)); }
  }
  return win.webContents;
}
global.runAttach = async (a) => { try { return await runAttach(a); } catch (e) { return { ok: false, error: 'HARNESS', detail: String(e && e.stack || e).slice(0, 600) }; } };
async function runAttach({ url, file, opts }) {
  const wc = await load(url);
  const dbg = wc.debugger;
  dbg.attach('1.3');
  const t0 = Date.now();
  try {
    const r = await attachFile(dbg, file, Object.assign({ composer: SITES.claude.INPUT_CANDIDATES, candidates: SITES.claude.FILE_INPUT_CANDIDATES, verifyMs: 1500, revealWaitMs: 800 }, opts || {}));
    const page = await wc.executeJavaScript('({ got: window.__attach.got, wrong: window.__attach.wrong, ignored: window.__attach.ignored || 0, chips: document.querySelectorAll("[data-testid=file-thumbnail]").length, menuOpen: !!document.querySelector("[role=menu]") })', true);
    return Object.assign({ ms: Date.now() - t0 }, r, { page });
  } finally { try { dbg.detach(); } catch (_) {} }
}
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
ready = app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 900, height: 600, show: true, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
void path;
