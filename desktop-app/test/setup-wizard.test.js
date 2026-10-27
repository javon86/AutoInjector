// test/setup-wizard.test.js — runs the REAL setup-wizard.html/setup-wizard.js in
// jsdom with window.api stubbed the way preload.js exposes it. Focused on the
// Video step (OP-13): it must be a real step — load the saved config, Save it,
// check the address, and run a test render that shows a plain-language reason
// when it fails — not a placeholder. Run: node test/setup-wizard.test.js
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
    imageStatus: async () => ({ ok: true, endpoint: "", enabled: false }),
    videoStatus: async () => { calls.push({ fn: "videoStatus" }); return { ok: true, configured: true, enabled: true, endpoint: "http://127.0.0.1:7862/generate", frames: 24, fps: 12, width: 576, height: 320 }; },
    configureVideo: async (patch) => { calls.push({ fn: "configureVideo", patch }); return { ok: true, enabled: !!(patch && patch.enabled) }; },
    testEndpoint: async (url) => { calls.push({ fn: "testEndpoint", url }); return { reachable: true, base: "http://127.0.0.1:7862" }; },
    videoGenerate: async (prompt) => { calls.push({ fn: "videoGenerate", prompt }); return { ok: true, path: "/out/videos/vid-1.mp4" }; },
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
  console.log("\n== OP-13: the wizard's Video step is a real step, not a placeholder ==");
  let api = makeApi();
  let dom = await loadWizard(api, "?tab=video");
  let doc = dom.window.document;
  const panel = doc.getElementById("panel-video");
  assert(panel && panel.classList.contains("active"), "?tab=video opens the wizard on the Video step");
  assert(!/placeholder|coming next|Planned/i.test(panel.textContent), "the Video step no longer says it is a placeholder / planned");
  assert(/AnimateDiff extension is installed/.test(panel.textContent) && /still images/.test(panel.textContent), "the Video step says the A1111 address needs the AnimateDiff extension (otherwise still images)");
  assert(/🎬 Video/.test(panel.textContent) && /installs and runs inside AutoInjector/.test(panel.textContent) && /Advanced: other video server/.test(panel.textContent), "the Video step points to the in-app 🎬 Video tab and keeps the other video server as Advanced");
  assert(/AnimateDiff extension/.test(doc.getElementById("vd-endpoint").getAttribute("placeholder")), "the endpoint hint says the 7860 address needs the AnimateDiff extension");
  for (const id of ["vd-endpoint", "vd-enabled", "vd-frames", "vd-fps", "vd-width", "vd-height", "btn-vd-save", "btn-vd-check", "btn-vd-test", "vd-msg"]) {
    assert(!!doc.getElementById(id), `the Video step has #${id}`);
  }
  assert(api.calls.some((c) => c.fn === "videoStatus"), "the Video step loads the saved video config");
  assert(doc.getElementById("vd-endpoint").value === "http://127.0.0.1:7862/generate" && doc.getElementById("vd-enabled").checked, "the saved endpoint + on/off fill the fields");
  assert(doc.getElementById("vd-frames").value === "24" && doc.getElementById("vd-fps").value === "12" && doc.getElementById("vd-width").value === "576", "the saved frames/fps/size fill the fields");

  doc.getElementById("vd-endpoint").value = "  http://127.0.0.1:7860/sdapi/v1/txt2img  ";
  doc.getElementById("vd-frames").value = "8";
  click(dom, "btn-vd-save");
  await tick();
  const save = api.calls.filter((c) => c.fn === "configureVideo").pop();
  assert(save && save.patch.endpoint === "http://127.0.0.1:7860/sdapi/v1/txt2img" && save.patch.enabled === true && save.patch.frames === 8, "Save sends the trimmed endpoint, on/off and frames to configureVideo (same path as the Images step)");
  assert(/Saved — video generation is on/.test(doc.getElementById("vd-msg").textContent), "Save confirms in plain words");

  click(dom, "btn-vd-check");
  await tick();
  assert(api.calls.some((c) => c.fn === "testEndpoint" && /7860/.test(c.url)), "Check connection pings the entered address");
  assert(/Reachable ✓/.test(doc.getElementById("vd-msg").textContent) && /Test render/.test(doc.getElementById("vd-msg").textContent), "a reachable backend says so and points to Test render");

  click(dom, "btn-vd-test");
  await tick();
  assert(api.calls.some((c) => c.fn === "videoGenerate"), "Test render makes a real test clip");
  assert(/Rendered ✓ → \/out\/videos\/vid-1\.mp4/.test(doc.getElementById("vd-msg").textContent), "a successful test render shows where the clip was saved");

  console.log("\n== OP-13: failures are explained in plain words ==");
  const NO_VIDEO_MSG = "The server at http://127.0.0.1:7860/sdapi/v1/txt2img answered, but it didn't send back a video, so no working video backend is configured yet.";
  api = makeApi({
    videoStatus: async () => ({ ok: true, configured: false, enabled: false, endpoint: "" }),
    testEndpoint: async (url) => { api.calls.push({ fn: "testEndpoint", url }); return { reachable: false, base: "http://127.0.0.1:7999" }; },
    videoGenerate: async () => ({ ok: false, error: "NO_VIDEO", message: NO_VIDEO_MSG }),
  });
  dom = await loadWizard(api, "?tab=video");
  doc = dom.window.document;
  click(dom, "btn-vd-check");
  await tick();
  assert(/No video backend is set up yet/.test(doc.getElementById("vd-msg").textContent) && !api.calls.some((c) => c.fn === "testEndpoint"), "Check with no address explains no video backend is set up (no network call)");
  click(dom, "btn-vd-test");
  await tick();
  assert(/No video backend is set up yet/.test(doc.getElementById("vd-msg").textContent), "Test render with no address explains the same");
  doc.getElementById("vd-endpoint").value = "http://127.0.0.1:7999/gen";
  click(dom, "btn-vd-check");
  await tick();
  assert(/Nothing is answering at http:\/\/127\.0\.0\.1:7999/.test(doc.getElementById("vd-msg").textContent), "an unreachable address is reported in plain words with the address");
  doc.getElementById("vd-endpoint").value = "http://127.0.0.1:7860/sdapi/v1/txt2img";
  click(dom, "btn-vd-test");
  await tick();
  assert(/Tick "Enable video generation" first/.test(doc.getElementById("vd-msg").textContent) && !api.calls.some((c) => c.fn === "videoGenerate"), "Test render with video switched off says to switch it on (doesn't save it off and fail)");
  doc.getElementById("vd-enabled").checked = true;
  click(dom, "btn-vd-test");
  await tick();
  const msg = doc.getElementById("vd-msg").textContent;
  assert(msg.includes(NO_VIDEO_MSG) && !/^Test failed: NO_VIDEO$/.test(msg), "a NO_VIDEO test render shows the plain-language message, not the bare code");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
