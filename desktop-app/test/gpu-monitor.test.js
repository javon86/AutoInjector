// test/gpu-monitor.test.js — the best-effort GPU usage reader. Stubs execFile so
// no real nvidia-smi is needed. Run: node test/gpu-monitor.test.js
const gm = require('../gpu-monitor');
let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

async function main() {
  console.log('\n== parseLine turns an nvidia-smi CSV row into structured usage ==');
  const p = gm.parseLine('NVIDIA GeForce RTX 3090, 42, 6144, 24576');
  assert(p && p.name === 'NVIDIA GeForce RTX 3090', 'the GPU name is parsed');
  assert(p.util === 42 && p.memUsed === 6144 && p.memTotal === 24576, 'util + memory used/total are numbers');
  assert(p.memPct === 25, 'memory percent is derived (6144/24576 = 25%)');
  assert(gm.parseLine('garbage') === null, 'a malformed row -> null');

  console.log('\n== read() reports GPUs when nvidia-smi answers ==');
  gm.configure({ execFile: (bin, args, opts, cb) => { cb(null, 'RTX 3090, 10, 1024, 24576\nRTX 3060, 0, 512, 12288\n'); return { on() {} }; } });
  const r = await gm.read();
  assert(r.available && r.gpus.length === 2, 'both GPUs are reported');
  assert(r.gpus[0].name === 'RTX 3090' && r.gpus[0].util === 10, 'the first GPU carries its live utilization');

  console.log('\n== read() degrades cleanly when nvidia-smi is missing ==');
  gm.configure({ execFile: (bin, args, opts, cb) => { cb(new Error('ENOENT')); return { on() {} }; } });
  const r2 = await gm.read();
  assert(r2.available === false && /not available/.test(r2.reason), 'a missing tool -> available:false with a reason (never throws)');

  gm.configure({ execFile: (bin, args, opts, cb) => { cb(null, ''); return { on() {} }; } });
  const r3 = await gm.read();
  assert(r3.available === false && /no GPU/.test(r3.reason), 'empty output -> available:false (no GPU reported)');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
