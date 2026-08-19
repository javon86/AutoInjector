// test/system-monitor.test.js — the read-only hardware monitor. The
// recommendation logic is pure and deterministic (tested with synthetic
// snapshots); snapshot() is smoke-tested for shape (real values vary by
// machine). Run: node test/system-monitor.test.js
const sm = require("../system-monitor");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
function snap(vramGB, ramGB) {
  return { cpu: {}, mem: { totalGB: ramGB }, gpus: vramGB ? [{ model: "Test GPU", vramGB }] : [], os: {}, temps: {} };
}

function testRecommendByVram() {
  console.log("\n== recommend(): VRAM maps to sensible local-model and Stable Diffusion tiers ==");
  assert(sm.recommend(snap(24, 64)).llm.tier === "Large", "24 GB VRAM -> Large local models");
  assert(sm.recommend(snap(12, 32)).sd.tier === "SDXL / Flux", "12 GB VRAM -> SDXL/Flux for Stable Diffusion");
  assert(sm.recommend(snap(8, 32)).llm.tier === "Moderate" && sm.recommend(snap(8, 32)).sd.tier === "SDXL", "8 GB VRAM -> Moderate models, SDXL");
  assert(sm.recommend(snap(4, 16)).sd.tier === "SD 1.5", "4 GB VRAM -> SD 1.5 (the light default)");

  const noGpuBigRam = sm.recommend(snap(0, 32));
  assert(noGpuBigRam.llm.tier === "CPU-only", "no GPU + lots of RAM -> CPU-only small models");
  assert(/cloud/i.test(noGpuBigRam.sd.tier + noGpuBigRam.sd.detail), "no GPU -> Stable Diffusion suggests Forge/CPU or cloud");

  const weak = sm.recommend(snap(0, 8));
  assert(weak.llm.tier === "Cloud recommended", "no GPU + little RAM -> cloud recommended");
  assert(weak.vramGB === null && weak.ramGB === 8, "the recommendation echoes the machine's VRAM/RAM");
}

function testRecommendPicksMaxGpu() {
  console.log("\n== recommend(): uses the strongest GPU when there are several ==");
  const s = { cpu: {}, mem: { totalGB: 32 }, gpus: [{ model: "iGPU", vramGB: 1 }, { model: "RTX", vramGB: 16 }], os: {}, temps: {} };
  assert(sm.recommend(s).vramGB === 16 && sm.recommend(s).llm.tier === "High", "picks the 16 GB card, not the 1 GB one");
}

async function testSnapshotShape() {
  console.log("\n== snapshot(): returns a well-formed report on this machine (values vary) ==");
  const rep = await sm.report();
  assert(rep && rep.snapshot && rep.recommendation, "report() returns a snapshot and a recommendation");
  const s = rep.snapshot;
  assert(typeof s.cpu === "object" && typeof s.mem === "object" && Array.isArray(s.gpus), "snapshot has cpu, mem, and a gpus array");
  assert(s.mem.totalGB === null || s.mem.totalGB > 0, "reads total RAM (or null if unreadable)");
  assert(typeof rep.recommendation.summary === "string" && rep.recommendation.summary.length > 0, "produces a human-readable summary line");
}

async function main() {
  testRecommendByVram();
  testRecommendPicksMaxGpu();
  await testSnapshotShape();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
