// test/ollama-manager.test.js — the local-model manager for the System AI.
// recommended() is pure/deterministic; listInstalled() is tested against a
// mocked Ollama API. detect()/pull() shell out to `ollama` and are exercised at
// runtime on a machine that has it. Run: node test/ollama-manager.test.js
const om = require("../ollama-manager");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const realFetch = global.fetch;
function withFetch(impl, fn) { global.fetch = impl; return fn().finally(() => { global.fetch = realFetch; }); }

function testRecommended() {
  console.log("\n== recommended(): heavier machines get bigger local models; light machines get small ones ==");
  assert(om.recommended(24).length >= 1 && /14b|8b|7b/.test(om.recommended(24)[0]), "24 GB VRAM -> a larger model first");
  assert(/8b|7b/.test(om.recommended(8)[0]), "8 GB VRAM -> a mid 7–8B model");
  assert(/1b|0\.5b|1\.5b/.test(om.recommended(0).join(",")), "no GPU -> only tiny models");
  assert(om.recommended(0).length === 3, "always returns a short pick list");
}

async function testListInstalled() {
  console.log("\n== listInstalled(): reads the installed models from the Ollama API ==");
  await withFetch(async (url) => {
    assert(/\/api\/tags$/.test(url), "queries the Ollama /api/tags endpoint");
    return { ok: true, json: async () => ({ models: [{ name: "llama3.2:3b" }, { name: "qwen2.5:7b" }] }) };
  }, async () => {
    const r = await om.listInstalled("http://127.0.0.1:11434");
    assert(r.ok && r.models.length === 2 && r.models[0] === "llama3.2:3b", "returns the installed model names");
  });
  await withFetch(async () => { throw new Error("ECONNREFUSED"); }, async () => {
    const r = await om.listInstalled();
    assert(!r.ok && r.models.length === 0, "Ollama not running -> no models, no crash");
  });
}

async function main() {
  testRecommended();
  await testListInstalled();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
