// test/verify-l1-panel.test.js — L1 (round-2 review): with the BookForge bridge
// OFF, AutoInjector must not ping local services in the background unless the
// author EXPANDED the BookForge panel themselves (the default view and the folded
// slim bar count as closed) or pressed Connect / the link test / Start BookForge.
//  A. controls.js bfPanelExpanded(): the renderer's "panel open" decision.
//  B. main.js bookforge:status: pings only with panelOpen, or after Connect.
// Run: node test/verify-l1-panel.test.js
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_BF_APP_CHECK_MS = "50"; // let every status call check (no 30 s throttle)
process.env.AUTOINJECTOR_BOOKFORGE_PORT = String(20000 + Math.floor(Math.random() * 20000));
const APP_PORT = Number(process.env.AUTOINJECTOR_BOOKFORGE_PORT) + 1;
process.env.AUTOINJECTOR_BOOKFORGE_APP_URL = `http://127.0.0.1:${APP_PORT}/api/ping`;

const fs = require("fs");
const path = require("path");
const http = require("http");
const Module = require("module");

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("== A. the renderer's 'panel expanded' decision ==");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "controls.js"), "utf8");
  const m = /function bfPanelExpanded\(panel, state\) \{[\s\S]*?\n\}/.exec(src);
  assert(!!m, "bfPanelExpanded exists in controls.js");
  const f = m ? new Function(`${m[0]}; return bfPanelExpanded;`)() : () => null;
  const panel = (hidden) => ({ classList: { contains: (c) => hidden && c === "hidden-collapsed" } });
  assert(f(panel(false), { collapsed: false, userExpanded: false }) === false, "default view (not expanded by the author) = closed");
  assert(f(panel(false), { collapsed: true, userExpanded: true }) === false, "folded slim bar = closed");
  assert(f(panel(true), { collapsed: false, userExpanded: true }) === false, "minimized to a tab = closed");
  assert(f(null, { collapsed: false, userExpanded: true }) === false, "no panel = closed");
  assert(f(panel(false), { collapsed: false, userExpanded: true }) === true, "expanded by the author = open");
  assert(/bookforgeStatus\(\{ panelOpen \}\)/.test(src) && /const panelOpen = bfPanelExpanded\(/.test(src), "bookforgeRefresh sends bfPanelExpanded() as panelOpen");
  assert(/bfStore\.set\("bf-collapsed", on \? "1" : "0"\)/.test(src), "expanding the panel is remembered as the author's choice");
}

const mockElectronPath = path.join(__dirname, "mock-electron.js");
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return require(mockElectronPath);
  return originalLoad.apply(this, arguments);
};
const mockElectron = require(mockElectronPath);
mockElectron.shell = { openExternal: async () => {}, openPath: async () => "" };
function call(ch, p) { return mockElectron.__ipcHandlers[ch]({}, p); }
function reg(site) { return mockElectron.__registry[site]; }

async function main() {
  const hits = [];
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => { hits.push(req.url); res.writeHead(404); res.end("not bookforge"); });
    s.listen(APP_PORT, "127.0.0.1", () => resolve(s));
  });
  require(path.join(__dirname, "..", "main.js"));
  const t0 = Date.now(); while (!(reg("claude") && reg("gemini")) && Date.now() - t0 < 5000) await sleep(25);

  console.log("\n== B. main: background pings with the bridge OFF ==");
  for (let i = 0; i < 4; i++) { await call("bookforge:status", {}); await call("bookforge:status", { panelOpen: false }); await call("bookforge:status"); await sleep(80); }
  await sleep(300);
  assert(hits.length === 0, `bridge OFF, panel not expanded: no background ping (${hits.length})`);
  await call("bookforge:status", { panelOpen: true });
  await sleep(400);
  assert(hits.length > 0, `panel expanded by the author: BookForge is checked (${hits.length})`);
  // after Connect / the link test the author asked: the status stays current even with the panel folded
  await sleep(100);
  const before = hits.length;
  for (let i = 0; i < 3; i++) { await call("bookforge:status", { panelOpen: false }); await sleep(80); }
  await sleep(300);
  assert(hits.length === before, "panel folded again, nothing pressed: no background ping");
  const r = await call("bookforge:connect");
  await sleep(300);
  const afterConnect = hits.length;
  assert(afterConnect > before, `Connect checks right away (${afterConnect - before})`);
  for (let i = 0; i < 3; i++) { await call("bookforge:status", { panelOpen: false }); await sleep(120); }
  await sleep(300);
  assert(hits.length > afterConnect, "after Connect the background check keeps BookForge's status current");
  try { await call("bookforge:set-enabled", { enabled: false }); } catch (_) {}
  srv.close();
  void r;
}

main().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
