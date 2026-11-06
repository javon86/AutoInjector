'use strict';
// downloads.e2e.js — ⬇ a file an AI gives you to download, in the REAL Electron app (xvfb), with the three AI panes
// pointed at test/fixtures/fake-chat.html and a small local web server that sends a "packet" slowly:
//   * a download clicked in Claude's pane lands in <stuff and thing>/ai-work/claude/packet.zip (no Save dialog), the
//     panel shows "⬇ Claude: packet.zip — 45% · …" while it comes in, then "✅ Claude gave you packet.zip" with the
//     folder and 📂 Open folder / Open file
//   * reloading the pane (⟳) while it comes in does not stop it
//   * the app's own reload (self-repair ⟳) right after a click on "Download" — before the site has even answered —
//     waits, so the download still arrives (it used to be cancelled)
//   * a download from a window the pane opened (window.open) lands in that AI's folder, and the empty window goes
//   * a nameless blob: download gets a real name (download.txt)
// Screenshots go to SHOTS (default: the temp folder).
//   TMPDIR=/dev/shm xvfb-run -a node test/e2e/downloads.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { makeAsserts } = require('./helpers');
const electron = require('playwright')._electron;

const SHOTS = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dl-shots-'));
const FIX = path.join(__dirname, '..', 'fixtures', 'fake-chat.html');
const url = (q) => `file://${FIX}?${q}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHUNK = 64 * 1024;

async function main() {
  const { assert, state } = makeAsserts();
  fs.mkdirSync(SHOTS, { recursive: true });
  // /packet.zip?name=x&chunks=n — n × 64 KB, one every 150 ms; /late.zip answers only after 1.5 s
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/late.zip') await sleep(1500);
    const n = Number(u.searchParams.get('chunks')) || 24;
    const name = u.searchParams.get('name') || (u.pathname === '/late.zip' ? 'late.zip' : 'packet.zip');
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': String(n * CHUNK) });
    let i = 0;
    const t = setInterval(() => { if (res.destroyed) return clearInterval(t); res.write(Buffer.alloc(CHUNK, 65 + (i % 26))); if (++i >= n) { clearInterval(t); res.end(); } }, 150);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dl-home-'));
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], cwd: path.join(__dirname, '..', '..'),
    env: Object.assign({}, process.env, {
      HOME: home, AUTOINJECTOR_BRIDGE: '0', AUTOINJECTOR_CHECKIN: '0', AUTOINJECTOR_CONTENT_SCAN: '0', AUTOINJECTOR_AKOWE_SERVER: '0',
      AUTOINJECTOR_AKOWE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ai-nobf-')), AUTOINJECTOR_DOWNLOAD_PROGRESS_MS: '200',
      AUTOINJECTOR_SITE_URL_CHATGPT: url('site=chatgpt&quirks=none'), AUTOINJECTOR_SITE_URL_CLAUDE: url('site=claude&quirks=none'), AUTOINJECTOR_SITE_URL_GEMINI: url('site=gemini&quirks=none'),
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost'
    }),
  });
  const made = [];
  try {
    let controls = null;
    for (let i = 0; i < 100 && !controls; i++) {
      for (const w of app.windows()) { try { if (await w.$('#up-zone-compose')) controls = w; } catch (_) {} }
      if (!controls) await sleep(400);
    }
    assert(!!controls, 'control panel appears');
    if (!controls) return 1;
    await controls.setViewportSize({ width: 1280, height: 720 }).catch(() => {});
    const errors = [];
    controls.on('pageerror', (e) => errors.push(String(e)));
    const waitFor = async (fn, ms, step = 150) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = await fn(); if (r) return r; await sleep(step); } return null; };
    const inPane = (site, js) => app.evaluate(async ({ webContents }, a) => {
      const wc = webContents.getAllWebContents().find((w) => /fake-chat\.html/.test(w.getURL()) && w.getURL().includes(`site=${a.site}`));
      return wc ? wc.executeJavaScript(a.js, true) : null;
    }, { site, js });
    const clickLink = (site, href) => inPane(site, `(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(href)}; document.body.appendChild(a); a.click(); a.remove(); return true; })()`);
    await waitFor(() => inPane('claude', 'document.readyState === "complete"'), 20000);
    const list = () => controls.evaluate(() => window.api.downloadsList());
    const folders = (await list()).folders;
    for (const d of Object.values(folders)) { try { for (const f of fs.readdirSync(d)) fs.unlinkSync(path.join(d, f)); } catch (_) {} }
    const strip = (site) => controls.evaluate((s) => { const b = document.getElementById(`dl-strip-${s}`); return b ? { hidden: b.hidden, items: [...b.querySelectorAll('.dl-item')].map((x) => ({ state: x.dataset.state, text: x.textContent, buttons: [...x.querySelectorAll('button')].map((y) => y.textContent) })) } : null; }, site);
    const shotStrip = async (site, name) => {
      const f = path.join(SHOTS, `${name}.png`);
      const box = await controls.$(`#col-${site} .control-strip`);
      if (box) await box.screenshot({ path: f }).catch(() => {});
      return f;
    };

    console.log('\n== Claude gives you a packet: progress, then where it went ==');
    await clickLink('claude', `${base}/packet.zip?chunks=24`);
    const live = await waitFor(async () => { const s = await strip('claude'); return s && !s.hidden && s.items.find((x) => x.state === 'progressing' && /[1-9]\d*%/.test(x.text)) ? s : null; }, 8000, 100);
    assert(!!live && /⬇ Claude: packet\.zip — [1-9]\d*% · .* of 1\.5 MB/.test(live.items[0].text), `the panel shows it coming in ("${live && live.items[0].text}")`);
    await shotStrip('claude', 'dl_01_claude_progress');
    console.log('\n== ⟳ reloading the pane while it comes in does not stop it ==');
    await controls.evaluate(() => window.api.reloadSite('claude'));
    const fin = await waitFor(async () => { const s = await strip('claude'); return s && s.items.find((x) => x.state !== 'progressing') ? s : null; }, 20000);
    const done = fin && fin.items.find((x) => x.state !== 'progressing');
    assert(done && done.state === 'completed' && /✅ Claude gave you packet\.zip \(1\.5 MB\)\. Saved in:/.test(done.text) && done.text.includes(folders.claude), `the notice says it is saved, with the folder ("${done && done.text}")`);
    assert(done && done.buttons.includes('📂 Open folder') && done.buttons.includes('Open file'), `📂 Open folder and Open file buttons (${done && done.buttons.join(' | ')})`);
    const file = path.join(folders.claude, 'packet.zip'); made.push(file);
    assert(fs.existsSync(file) && fs.statSync(file).size === 24 * CHUNK, `the file is in the folder, whole (${fs.existsSync(file) ? fs.statSync(file).size : 'missing'} bytes)`);
    assert(/ai-work[\\/]claude$/.test(folders.claude) && folders.claude.includes('stuff and thing'), `the folder is stuff and thing/ai-work/claude (${folders.claude})`);
    await shotStrip('claude', 'dl_02_claude_done');

    console.log('\n== the app\'s own reload right after a click on "Download" waits for it ==');
    await clickLink('claude', `${base}/late.zip?chunks=4`);
    await sleep(200);
    const rr = await controls.evaluate(() => window.api.selfRepairReload('claude'));
    const late = await waitFor(async () => { const s = await strip('claude'); return s && s.items.find((x) => /late\.zip/.test(x.text) && x.state === 'completed') ? s : null; }, 15000);
    const lateFile = path.join(folders.claude, 'late.zip'); made.push(lateFile);
    assert(!!late && fs.existsSync(lateFile) && fs.statSync(lateFile).size === 4 * CHUNK, 'late.zip still arrived (the reload waited for the site to answer)');
    assert(rr && rr.ok !== undefined, `the reload itself went ahead afterwards (${JSON.stringify(rr)})`);

    console.log('\n== a download from a window the pane opened ==');
    const winsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await inPane('chatgpt', `(() => { window.open(${JSON.stringify(`${base}/packet.zip?chunks=6&name=from-popup.zip`)}); return true; })()`);
    const pop = await waitFor(async () => { const s = await strip('chatgpt'); return s && s.items.find((x) => /from-popup\.zip/.test(x.text) && x.state === 'completed') ? s : null; }, 15000);
    const popFile = path.join(folders.chatgpt, 'from-popup.zip'); made.push(popFile);
    assert(!!pop && fs.existsSync(popFile) && fs.statSync(popFile).size === 6 * CHUNK, 'it lands in ChatGPT\'s folder and is shown in ChatGPT\'s column');
    const winsAfter = await waitFor(async () => { const n = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length); return n <= winsBefore ? String(n) : null; }, 5000);
    assert(winsAfter !== null, `the empty window that only carried the download is closed (${winsBefore} before)`);

    console.log('\n== a nameless blob: download gets a real name ==');
    await inPane('gemini', `(() => { const b = new Blob(['chapter one'], { type: 'text/plain' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = ''; document.body.appendChild(a); a.click(); a.remove(); return true; })()`);
    const blob = await waitFor(async () => { const s = await strip('gemini'); return s && s.items.find((x) => x.state === 'completed') ? s : null; }, 10000);
    const bItem = blob && blob.items.find((x) => x.state === 'completed');
    const m = bItem && /gave you (\S+) /.exec(bItem.text);
    if (m) made.push(path.join(folders.gemini, m[1]));
    assert(m && /\.txt$/.test(m[1]) && fs.existsSync(path.join(folders.gemini, m[1])) && fs.readFileSync(path.join(folders.gemini, m[1]), 'utf8') === 'chapter one', `saved with a name and the right extension (${m && m[1]})`);
    await shotStrip('gemini', 'dl_03_gemini_blob');

    console.log('\n== ✕ closes a notice; the ⬇ button is in each AI\'s header ==');
    assert(await controls.evaluate(() => ['chatgpt', 'claude', 'gemini'].every((s) => !!document.getElementById(`dl-btn-${s}`))), '⬇ button in all three headers');
    await controls.evaluate(() => { const x = document.querySelector('#dl-strip-gemini .dl-x'); if (x) x.click(); });
    const gs = await strip('gemini');
    assert(gs && gs.hidden && gs.items.length === 0, 'the Gemini notice is closed (the file stays)');
    assert(!errors.length, `no page errors (${errors.join(' | ').slice(0, 300)})`);
    console.log(`  screenshots: ${SHOTS}`);
  } finally {
    for (const f of made) { try { fs.unlinkSync(f); } catch (_) {} }
    await app.close().catch(() => {});
    srv.close();
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  return state.failed ? 1 : 0;
}
main().then((c) => process.exit(c || 0), (e) => { console.error(e); process.exit(1); });
