'use strict';
// mcp.e2e.js — 🧰 Tool servers (MCP) in the REAL Electron app: ⚙ More settings → 🧰 Tools.
//   1. Off by default: "None yet", nothing runs.
//   2. ➕ Add a tool server (the fake stdio MCP server, test/fixtures/fake-mcp-server.js, with a key):
//      the row says "connected · 8 tools", lists the tools, shows the key only by name.
//   3. The butler's tool list (USE_TOOL) shows its tools as mcp:files/<tool>.
//   4. ■ Stop → stopped; ▶ Start → connected again.
//   5. A bad command → the row explains in plain words.
//   6. Screenshot → shots/tool-servers.png; quitting the app stops the server process.
//   xvfb-run -a node test/e2e/mcp.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeAsserts, APP_DIR } = require('./helpers');
const electron = require('playwright')._electron;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS || path.join(__dirname, '__screenshots__', 'mcp');
async function until(fn, ms, every = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(every); }
  return null;
}
const FAKE = path.join(APP_DIR, 'test', 'fixtures', 'fake-mcp-server.js');
function fakePids() { try { return execFileSync('pgrep', ['-f', FAKE], { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch (_) { return []; } }

async function main() {
  const { assert, state } = makeAsserts();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-home-'));
  const fake = 'file://' + path.join(APP_DIR, 'test', 'fixtures', 'fake-chat.html');
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], cwd: APP_DIR,
    env: Object.assign({}, process.env, {
      HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      AUTOINJECTOR_AKOWE_SERVER: '0', AUTOINJECTOR_CHECKIN: '0', AUTOINJECTOR_BRIDGE: '0', AUTOINJECTOR_HEALTH: '0',
      AUTOINJECTOR_SD_AUTOSTART: '0', AUTOINJECTOR_SD_HOME: path.join(home, 'sdhome'), AUTOINJECTOR_SD_MODEL_DIRS: path.join(home, 'models'),
      AUTOINJECTOR_SITE_URL_CHATGPT: fake, AUTOINJECTOR_SITE_URL_CLAUDE: fake, AUTOINJECTOR_SITE_URL_GEMINI: fake,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    }),
  });
  let closed = false;
  try {
    const controls = await until(async () => { for (const w of app.windows()) { if (await w.$('#tools-sec').catch(() => null)) return w; } return null; }, 40000, 400);
    assert(!!controls, 'the control panel appears with the 🧰 Tools section');
    if (!controls) return 1;
    await controls.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
    if (!(await controls.isVisible('#tools-sec'))) { await controls.click('#btn-collapse-systemai').catch(() => {}); await sleep(300); }
    await controls.evaluate(() => { document.getElementById('tools-sec').open = true; });
    await controls.locator('#tools-sec').scrollIntoViewIfNeeded();

    console.log('\n== off by default ==');
    const none = await until(async () => /None yet/.test(await controls.textContent('#mcp-servers')), 8000);
    assert(!!none && fakePids().length === 0, 'no tool servers and nothing running until one is added');

    console.log('\n== ➕ Add a tool server ==');
    await controls.click('#mcp-add-box > summary');
    await controls.fill('#mcp-name', 'files');
    await controls.fill('#mcp-line', `"${process.execPath}" "${FAKE}"`);
    await controls.fill('#mcp-secrets', 'FAKE_TOKEN=e2e-SECRET-24680');
    await controls.click('#btn-mcp-add');
    const row = await until(async () => { const t = await controls.textContent('#mcp-servers .mcp-server .mcp-summary'); return /connected · 8 tools/.test(t) ? t : null; }, 30000);
    assert(!!row, `the row says "connected · 8 tools" (${row || await controls.textContent('#mcp-servers')})`);
    const msg = await controls.textContent('#mcp-msg');
    assert(/Added “?"?files/.test(msg) || /Added/.test(msg), `a plain message (${msg})`);
    const rowText = await controls.textContent('#mcp-servers');
    assert(/FAKE_TOKEN/.test(rowText) && !/e2e-SECRET-24680/.test(rowText), 'the key is shown by name only');
    assert(await controls.inputValue('#mcp-secrets') === '', 'the key field is cleared after adding');
    await controls.click('#mcp-servers .mcp-server details > summary');
    const tools = await controls.textContent('#mcp-servers .mcp-tools');
    assert(/• echo — Say the text back\./.test(tools) && /• add — Add two numbers\./.test(tools), 'its tools are listed with their descriptions');
    const tl = await until(async () => { const t = await controls.textContent('#jarvis-tools'); return /mcp:files\/echo/.test(t) ? t : null; }, 8000);
    assert(!!tl, 'the butler\'s tool list (USE_TOOL) shows them as mcp:files/<tool>');
    const disk = fs.readFileSync(path.join(home, '.config', 'autoinjector-desktop', 'autoinjector-mcp-servers.json'), 'utf8');
    assert(!/e2e-SECRET-24680/.test(disk), 'the saved list never holds the key in plain text');
    const call = await controls.evaluate(() => window.api.toolsRun('mcp:files/echo', { text: 'from the butler' }));
    assert(call && call.ok && call.message === 'echo: from the butler', 'the butler path reaches the server');

    console.log('\n== screenshot ==');
    fs.mkdirSync(SHOTS, { recursive: true });
    const file = path.join(SHOTS, 'tool-servers.png');
    await controls.locator('#tools-sec').screenshot({ path: file });
    assert(fs.existsSync(file) && fs.statSync(file).size > 5000, `screenshot of the 🧰 Tools section (${path.relative(APP_DIR, file)})`);
    try { fs.copyFileSync(file, path.join(APP_DIR, '..', 'shots', 'tool-servers.png')); } catch (_) {}

    console.log('\n== ■ Stop / ▶ Start ==');
    await controls.click('#mcp-servers .mcp-server button:has-text("Stop")');
    assert(!!(await until(async () => /stopped/.test(await controls.textContent('#mcp-servers .mcp-summary')), 10000)), 'Stop → "stopped"');
    assert(!!(await until(() => fakePids().length === 0, 5000)), 'the server process is gone');
    await controls.click('#mcp-servers .mcp-server button:has-text("Start")');
    assert(!!(await until(async () => /connected · 8 tools/.test(await controls.textContent('#mcp-servers .mcp-summary')), 20000)), 'Start → connected again');

    console.log('\n== a command that is not there ==');
    await controls.fill('#mcp-name', 'broken');
    await controls.fill('#mcp-line', 'definitely-not-a-program-xyz --flag');
    await controls.click('#btn-mcp-add');
    const err = await until(async () => { const t = await controls.textContent('#mcp-servers .mcp-server[data-id="broken"] .mcp-error').catch(() => ''); return /isn't installed/.test(t) ? t : null; }, 15000);
    assert(!!err, `the row explains it in plain words (${err})`);

    console.log('\n== quitting stops the server ==');
    assert(fakePids().length >= 1, 'the server runs before quitting');
    await app.close(); closed = true;
    assert(!!(await until(() => fakePids().length === 0, 8000)), 'after quitting no tool server process is left');
  } catch (e) {
    assert(false, `unexpected error: ${e && e.stack}`);
  } finally {
    if (!closed) await app.close().catch(() => {});
  }
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  return state.failed ? 1 : 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
