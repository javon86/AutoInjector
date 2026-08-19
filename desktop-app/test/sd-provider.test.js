// test/sd-provider.test.js — Stable Diffusion provider. Mocks the network
// boundary (global.fetch) so the Automatic1111 request/response shape, error
// mapping, image saving, gallery, settings, and the [IMAGE: ...] tag parser are
// all verified without a real GPU backend. Run: node test/sd-provider.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const sd = require("../sd-provider");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const realFetch = global.fetch;
function withFetch(impl, fn) { global.fetch = impl; return fn().finally(() => { global.fetch = realFetch; }); }
function res({ ok = true, status = 200, jsonBody, textBody } = {}) {
  return { ok, status, json: async () => { if (jsonBody === undefined) throw new Error("no json"); return jsonBody; }, text: async () => (textBody !== undefined ? textBody : JSON.stringify(jsonBody || {})) };
}
// a 1x1 png, base64
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function initTmp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-")); sd.init(dir); return dir; }

function testTagParser() {
  console.log("\n== parseImageTag: recognises an [IMAGE: ...] tag at the start of a reply ==");
  assert(sd.parseImageTag("[IMAGE: a red lighthouse] and here's why") === "a red lighthouse", "extracts the prompt from a leading [IMAGE: ...] tag");
  assert(sd.parseImageTag("here is [IMAGE: nope]") === null, "a tag not at the start is ignored");
  assert(sd.parseImageTag("no tag here") === null, "plain text returns null");
}

async function testDisabledAndValidation() {
  console.log("\n== generate: refuses when disabled or prompt missing, without hitting the network ==");
  initTmp();
  sd.setSettings({ enabled: false });
  let called = false;
  await withFetch(async () => { called = true; return res({ jsonBody: {} }); }, async () => {
    const r = await sd.generate({ prompt: "x" });
    assert(!r.ok && r.error === "DISABLED" && !called, "disabled -> DISABLED, no network call");
  });
  sd.setSettings({ enabled: true, endpoint: "http://sd.local:7860" });
  const r2 = await sd.generate({ prompt: "   " });
  assert(!r2.ok && r2.error === "NO_PROMPT", "empty prompt -> NO_PROMPT");
}

async function testGenerateHappyPath() {
  console.log("\n== generate: posts A1111 txt2img, saves the image, returns a data URI, records the gallery ==");
  initTmp();
  sd.setSettings({ enabled: true, endpoint: "http://sd.local:7860", steps: 20, width: 640, height: 384 });
  let seen = null;
  await withFetch(async (url, opts) => { seen = { url, opts }; return res({ jsonBody: { images: [PNG_B64], info: JSON.stringify({ seed: 12345 }) } }); }, async () => {
    const r = await sd.generate({ prompt: "a lighthouse at dusk", from: "claude" });
    assert(r.ok && r.dataUri.startsWith("data:image/png;base64,"), "returns a data URI for the image");
    assert(r.seed === 12345 && r.from === "claude", "surfaces the seed and the requester");
    assert(r.file && fs.existsSync(r.file), "the PNG is written to disk");
  });
  assert(seen.url === "http://sd.local:7860/sdapi/v1/txt2img" && seen.opts.method === "POST", "posts to the A1111 txt2img route");
  const body = JSON.parse(seen.opts.body);
  assert(body.prompt === "a lighthouse at dusk" && body.steps === 20 && body.width === 640 && body.height === 384, "request body carries the prompt and configured settings");
  const g = sd.gallery(10);
  assert(g.length === 1 && g[0].prompt === "a lighthouse at dusk" && g[0].dataUri, "the render lands in the gallery with its prompt");
}

async function testModelSamplerBatch() {
  console.log("\n== generate: model override, sampler, and a batch of images ==");
  initTmp();
  sd.setSettings({ enabled: true, endpoint: "http://sd.local:7860", sampler: "Euler a" });
  let seen = null;
  await withFetch(async (url, opts) => { seen = opts; return res({ jsonBody: { images: [PNG_B64, PNG_B64], info: JSON.stringify({ seed: 7 }) } }); }, async () => {
    const r = await sd.generate({ prompt: "two lighthouses", model: "sd15.safetensors", sampler: "DDIM", batch: 2 });
    assert(r.ok && r.count === 2 && r.images.length === 2, "a batch of 2 returns 2 images");
    assert(r.images.every((i) => i.dataUri && i.file), "each image has its own data URI and saved file");
  });
  const body = JSON.parse(seen.body);
  assert(body.batch_size === 2, "batch_size reflects the requested batch");
  assert(body.sampler_name === "DDIM", "the chosen sampler is sent");
  assert(body.override_settings && body.override_settings.sd_model_checkpoint === "sd15.safetensors", "the model override selects the checkpoint (SD 1.5 vs SDXL etc.)");
  assert(sd.gallery(10).length === 2, "both images land in the gallery");
}

async function testListModels() {
  console.log("\n== listModels: reports the server's checkpoints for the Model picker ==");
  initTmp();
  sd.setSettings({ enabled: true, endpoint: "http://sd.local:7860" });
  await withFetch(async () => res({ jsonBody: [{ model_name: "sd_v1-5" }, { model_name: "sdxl_base" }] }), async () => {
    const r = await sd.listModels();
    assert(r.ok && r.models.length === 2 && r.models[0] === "sd_v1-5", "returns the model names");
  });
  await withFetch(async () => { throw new Error("ECONNREFUSED"); }, async () => {
    const r = await sd.listModels();
    assert(!r.ok && r.models.length === 0, "an unreachable server returns no models, not a crash");
  });
}

async function testErrorMapping() {
  console.log("\n== generate: HTTP/timeout/no-image failures are reported distinctly ==");
  initTmp();
  sd.setSettings({ enabled: true, endpoint: "http://sd.local:7860", apiKey: "sk-secret" });
  await withFetch(async () => res({ ok: false, status: 500, textBody: "boom sk-secret" }), async () => {
    const r = await sd.generate({ prompt: "x" });
    assert(!r.ok && r.error === "HTTP_500", "a non-2xx maps to HTTP_<status>");
    assert(!r.detail.includes("sk-secret"), "the api key is redacted from error detail");
  });
  await withFetch(async () => res({ jsonBody: { images: [] } }), async () => {
    const r = await sd.generate({ prompt: "x" });
    assert(!r.ok && r.error === "NO_IMAGE_RETURNED", "an empty image array -> NO_IMAGE_RETURNED");
  });
  await withFetch(async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }, async () => {
    const r = await sd.generate({ prompt: "x" });
    assert(!r.ok && r.error === "TIMEOUT", "an aborted request -> TIMEOUT");
  });
}

async function testSettingsAndConnection() {
  console.log("\n== settings persist (apiKey never leaked) and testConnection maps reachability ==");
  const dir = initTmp();
  sd.setSettings({ enabled: true, endpoint: "http://sd.local:7860", apiKey: "sk-xyz" });
  const s = sd.getSettings();
  assert(s.hasApiKey === true && s.apiKey === undefined, "getSettings reports hasApiKey but never returns the key itself");
  sd.init(dir); // reload from disk
  assert(sd.getSettings().endpoint === "http://sd.local:7860", "settings survive a reload");
  await withFetch(async () => res({ jsonBody: [{ title: "sdxl" }, { title: "sd15" }] }), async () => {
    const r = await sd.testConnection();
    assert(r.ok && r.models === 2, "testConnection reports reachable + model count");
  });
  await withFetch(async () => { throw new Error("ECONNREFUSED"); }, async () => {
    const r = await sd.testConnection();
    assert(!r.ok && /NETWORK_ERROR/.test(r.error), "a refused connection is reported as not connected");
  });
}

async function main() {
  testTagParser();
  await testDisabledAndValidation();
  await testGenerateHappyPath();
  await testModelSamplerBatch();
  await testListModels();
  await testErrorMapping();
  await testSettingsAndConnection();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
