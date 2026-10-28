// test/setup-wizard.test.js — runs the REAL setup-wizard.html/setup-wizard.js in
// jsdom with window.api stubbed the way preload.js exposes it. The wizard's Images and
// Video tabs are short notes now: pictures and videos are set up in the main window's
// 🎨 Images / 🎬 Video tabs (one place). Their button closes the wizard and shows that
// tab (wizard:open-app-tab). Run: node test/setup-wizard.test.js
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function makeApi(over = {}) {
  const calls = [];
  const api = {
    calls,
    wizardCatalog: async () => ({ ok: true, ollama: { available: true }, models: [], installers: {} }),
    setupList: async () => ({ ok: true, targets: [], status: {} }),
    imageStatus: async () => { calls.push({ fn: "imageStatus" }); return { ok: true, endpoint: "", enabled: false }; },
    videoStatus: async () => { calls.push({ fn: "videoStatus" }); return { ok: true, configured: false, enabled: false, endpoint: "" }; },
    openAppTab: async (tab) => { calls.push({ fn: "openAppTab", tab }); return { ok: true, tab }; },
    ...over,
  };
  return api;
}

async function loadWizard(api, query = "") {
  const html = fs.readFileSync(path.join(__dirname, "..", "setup-wizard.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: `http://localhost/setup-wizard.html${query}` });
  dom.window.api = api;
  dom.window.eval(fs.readFileSync(path.join(__dirname, "..", "setup-wizard.js"), "utf8"));
  await tick();
  return dom;
}
function click(dom, id) { dom.window.document.getElementById(id).dispatchEvent(new dom.window.Event("click", { bubbles: true })); }

async function main() {
  console.log("\n== the wizard's Images tab is a note that opens the 🎨 Images tab ==");
  let api = makeApi();
  let dom = await loadWizard(api, "?tab=images");
  let doc = dom.window.document;
  let panel = doc.getElementById("panel-images");
  assert(panel && panel.classList.contains("active"), "?tab=images opens the wizard on the Images note");
  assert(/Pictures are set up in the 🎨 Images tab of the main window/.test(panel.textContent) && /Advanced: another server/.test(panel.textContent), "it says pictures are set up in the 🎨 Images tab (and where the other-server setting is)");
  for (const id of ["sd-endpoint", "sd-enabled", "btn-sd-save", "btn-sd-test", "sd-steps"]) assert(!doc.getElementById(id), `the old duplicate #${id} is gone`);
  assert(!api.calls.some((c) => c.fn === "imageStatus" || c.fn === "videoStatus"), "the wizard no longer loads image/video settings of its own");
  click(dom, "btn-wz-open-images");
  await tick();
  assert(api.calls.some((c) => c.fn === "openAppTab" && c.tab === "images"), "🎨 Open the Images tab asks main to close the wizard and show the Images tab");

  console.log("\n== the wizard's Video tab is a note that opens the 🎬 Video tab ==");
  dom = await loadWizard(api, "?tab=video");
  doc = dom.window.document;
  panel = doc.getElementById("panel-video");
  assert(panel && panel.classList.contains("active"), "?tab=video opens the wizard on the Video note");
  assert(/Videos are set up in the 🎬 Video tab of the main window/.test(panel.textContent) && /Advanced: other video server/.test(panel.textContent), "it says videos are set up in the 🎬 Video tab (and where the other video server is)");
  for (const id of ["vd-endpoint", "vd-enabled", "vd-frames", "btn-vd-save", "btn-vd-check", "btn-vd-test"]) assert(!doc.getElementById(id), `the old duplicate #${id} is gone`);
  click(dom, "btn-wz-open-video");
  await tick();
  assert(api.calls.some((c) => c.fn === "openAppTab" && c.tab === "video"), "🎬 Open the Video tab asks main to show the Video tab");

  console.log("\n== if switching fails, it says what to do ==");
  api = makeApi({ openAppTab: async () => ({ ok: false, error: "BAD_TAB", message: "not a tab" }) });
  dom = await loadWizard(api, "?tab=images");
  doc = dom.window.document;
  click(dom, "btn-wz-open-images");
  await tick();
  assert(/Couldn't switch the main window: not a tab/.test(doc.getElementById("wz-images-msg").textContent) && /click the tab at the top of the main window/.test(doc.getElementById("wz-images-msg").textContent), "a failed switch explains it and says what to do instead");
  api = makeApi(); delete api.openAppTab;
  dom = await loadWizard(api, "?tab=video");
  doc = dom.window.document;
  click(dom, "btn-wz-open-video");
  await tick();
  assert(/Close this window and click the tab/.test(doc.getElementById("wz-video-msg").textContent), "an older app without the switch says what to do instead");

  console.log("\n== the rest of the wizard is unchanged ==");
  dom = await loadWizard(makeApi());
  doc = dom.window.document;
  assert(doc.getElementById("panel-localai").classList.contains("active") && !!doc.querySelector('.tab[data-tab="advanced"]') && !!doc.getElementById("btn-setup-auto"), "Local AI opens first; the Installs tab and 🚀 Auto-setup are still there");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
