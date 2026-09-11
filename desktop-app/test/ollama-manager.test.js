// test/ollama-manager.test.js — the local-model manager for the System AI.
// recommended() is pure/deterministic; listInstalled() is tested against a
// mocked Ollama API. detect()/pull() shell out to `ollama` and are exercised at
// runtime on a machine that has it. Run: node test/ollama-manager.test.js
const om = require("../ollama-manager");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

function testDefaultStoreDir() {
  console.log("\n== defaultStoreDir(): where models already downloaded actually live ==");
  assert(om.defaultStoreDir({ OLLAMA_MODELS: "/custom/store" }) === "/custom/store", "OLLAMA_MODELS wins when set");
  const win = om.defaultStoreDir({ USERPROFILE: "C:\\Users\\javon" });
  assert(/\.ollama/.test(win) && /models$/.test(win), "falls back to the per-user .ollama/models store");
}

function testManagedServer() {
  console.log("\n== the app's own Ollama server: pointed at the shared folder ==");
  // A fake spawn so no real Ollama is needed — we just check the args + env.
  const spawned = [];
  const fakeChild = { killed: false, stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() { this.killed = true; } };
  const spawnFn = (bin, args, o) => { spawned.push({ bin, args, o }); return fakeChild; };
  om.stopManaged();
  const r = om.startManaged({ modelsDir: "/app/stuff and thing/models/llm", host: "127.0.0.1:11435", bin: "ollama", spawnFn });
  assert(r.ok && spawned.length === 1, "startManaged spawns one server");
  assert(spawned[0].args[0] === "serve", "runs `ollama serve`");
  assert(spawned[0].o.env.OLLAMA_MODELS === "/app/stuff and thing/models/llm", "server's OLLAMA_MODELS points at the stuff-and-thing llm folder");
  assert(spawned[0].o.env.OLLAMA_HOST === "127.0.0.1:11435", "server binds the dedicated managed host/port");
  const st = om.managedStatus();
  assert(st.running && st.host === "127.0.0.1:11435" && st.endpoint === "http://127.0.0.1:11435", "managedStatus reports it running with an endpoint");
  const r2 = om.startManaged({ modelsDir: "/x", spawnFn });
  assert(r2.already === true && spawned.length === 1, "a second start is a no-op while one is running");
  om.stopManaged();
  assert(om.managedStatus().running === false, "stopManaged tears it down");
}

function testPullTargetsHost() {
  console.log("\n== pull(host): downloads are routed to the app's server ==");
  const p = om.pull("llama3.2:1b", null, { host: "127.0.0.1:11435" });
  // We can't run a real ollama here; just prove the call shape is accepted and
  // returns the {child, done} contract without throwing.
  assert(p && typeof p.done.then === "function", "pull returns a { child, done } handle even with a host");
  try { p.child && p.child.kill && p.child.kill(); } catch (_) {}
}

function testMigrateStore() {
  console.log("\n== migrateStore(): move already-downloaded models into stuff and thing ==");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "om-migrate-"));
  const from = path.join(base, "dot-ollama", "models");
  const to = path.join(base, "stuff and thing", "models", "llm");
  fs.mkdirSync(path.join(from, "blobs"), { recursive: true });
  fs.mkdirSync(path.join(from, "manifests", "registry.ollama.ai", "library", "llama3.2"), { recursive: true });
  fs.writeFileSync(path.join(from, "blobs", "sha256-aaa"), "weights-a");
  fs.writeFileSync(path.join(from, "blobs", "sha256-bbb"), "weights-b");
  fs.writeFileSync(path.join(from, "manifests", "registry.ollama.ai", "library", "llama3.2", "1b"), "{}");
  // Pre-seed one identical blob at the destination so we exercise the skip path.
  fs.mkdirSync(path.join(to, "blobs"), { recursive: true });
  fs.writeFileSync(path.join(to, "blobs", "sha256-aaa"), "weights-a");

  const r = om.migrateStore({ from, to });
  assert(r.ok, "migration succeeds");
  assert(r.moved === 2 && r.skipped === 1, `moves the new blobs + manifest, skips the one already there (moved=${r.moved}, skipped=${r.skipped})`);
  assert(fs.existsSync(path.join(to, "blobs", "sha256-bbb")), "the new blob is now in the stuff-and-thing store");
  assert(fs.existsSync(path.join(to, "manifests", "registry.ollama.ai", "library", "llama3.2", "1b")), "the manifest tree is recreated under the destination");
  assert(!fs.existsSync(path.join(from, "blobs", "sha256-bbb")), "the moved blob is gone from the old store (moved, not copied)");

  const same = om.migrateStore({ from: to, to });
  assert(same.ok && same.moved === 0 && /already/.test(same.note || ""), "migrating a folder onto itself is a safe no-op");
  const missing = om.migrateStore({ from: path.join(base, "nope"), to });
  assert(!missing.ok && /does not exist/.test(missing.error), "a missing source reports cleanly instead of throwing");
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
}

async function main() {
  testRecommended();
  await testListInstalled();
  testDefaultStoreDir();
  testManagedServer();
  testPullTargetsHost();
  testMigrateStore();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
