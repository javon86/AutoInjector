// test/llm-hardware.test.js — "what can this PC run?": GPU/VRAM/RAM detection on
// each platform (stubbed execFile + os, no real tools), the fit rating rules and
// their plain-English wording, canDownload, and pickVariant.
// Run: node test/llm-hardware.test.js
const h = require('../llm-hardware');
let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const MB = 1024 * 1024, GB = 1024 * MB;

function fakeOs({ ramGB = 32, freeGB = 20, cpu = 'AMD Ryzen 7 5800X 8-Core Processor', cores = 16, arch = 'x64' } = {}) {
  return { totalmem: () => ramGB * GB, freemem: () => freeGB * GB, cpus: () => Array.from({ length: cores }, () => ({ model: cpu })), arch: () => arch };
}
// tools: { 'nvidia-smi': stdout | Error, ... } — anything missing fails like ENOENT.
function fakeExec(tools, calls) {
  return (bin, args, opts, cb) => {
    if (calls) calls.push([bin, args, opts]);
    const key = Object.keys(tools).find((k) => bin === k || bin.endsWith(k));
    setImmediate(() => {
      const out = key ? tools[key] : new Error('ENOENT');
      if (out instanceof Error) cb(out); else cb(null, out);
    });
    return { on() {} };
  };
}

async function main() {
  console.log('\n== NVIDIA via nvidia-smi (Linux) ==');
  const calls = [];
  let hw = await h.detectHardware({ platform: 'linux', os: fakeOs(), execFile: fakeExec({ 'nvidia-smi': 'NVIDIA GeForce RTX 3060, 12288\n' }, calls), env: {} });
  assert(hw.ok === true, 'detectHardware resolves ok');
  assert(hw.gpus.length === 1 && hw.gpus[0].vendor === 'nvidia' && hw.gpus[0].vramMB === 12288, 'the RTX 3060 and its 12 GB are found');
  assert(hw.bestVramMB === 12288, 'bestVramMB = the biggest usable card');
  assert(hw.ramMB === 32768 && hw.freeRamMB === 20480, 'RAM total and free in MB');
  assert(hw.cores === 16 && /Ryzen/.test(hw.cpu), 'CPU model + core count');
  assert(hw.appleSilicon === false && hw.platform === 'linux', 'platform recorded, not Apple Silicon');
  assert(calls[0][2].timeout > 0 && calls[0][2].windowsHide === true, 'tools run with a timeout and hidden window');
  assert(h.describeHardware(hw) === 'RTX 3060 12 GB · 32 GB RAM', `the one-line summary reads "${h.describeHardware(hw)}"`);

  console.log('\n== Linux AMD via rocm-smi, then lspci fallback ==');
  const rocm = JSON.stringify({ card0: { 'Card series': 'Radeon RX 7900 XTX', 'VRAM Total Memory (B)': String(24 * GB), 'VRAM Total Used Memory (B)': '1000' } });
  hw = await h.detectHardware({ platform: 'linux', os: fakeOs(), execFile: fakeExec({ 'rocm-smi': rocm }), env: {} });
  assert(hw.gpus[0].vendor === 'amd' && hw.gpus[0].vramMB === 24576 && hw.bestVramMB === 24576, 'rocm-smi JSON → AMD card with 24 GB');
  hw = await h.detectHardware({ platform: 'linux', os: fakeOs(), execFile: fakeExec({ lspci: '00:02.0 VGA compatible controller: Intel Corporation UHD Graphics 630 (rev 02)\n01:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 22 [Radeon RX 6700 XT] (rev c1)\n' }), env: {} });
  assert(hw.gpus.length === 2 && hw.gpus[1].vendor === 'amd' && hw.gpus[1].vramMB === null, 'lspci lists cards by name (memory unknown)');
  assert(hw.bestVramMB === 0 && hw.notes.some((n) => /could not read how much memory/i.test(n)), 'unknown VRAM → 0 with a plain note');

  console.log('\n== Nothing found → CPU only, never throws ==');
  hw = await h.detectHardware({ platform: 'linux', os: fakeOs({ ramGB: 16, freeGB: 8 }), execFile: fakeExec({}), env: {} });
  assert(hw.ok && hw.gpus.length === 0 && hw.bestVramMB === 0, 'no tools → no GPUs');
  assert(hw.notes.some((n) => /No graphics card found/.test(n)), 'says models will run on the processor');
  hw = await h.detectHardware({ platform: 'linux', os: fakeOs(), execFile: () => { throw new Error('spawn blew up'); }, env: {} });
  assert(hw.ok === true && hw.gpus.length === 0, 'an execFile that throws is survived');
  const t0 = Date.now();
  hw = await h.detectHardware({ platform: 'linux', os: fakeOs(), execFile: () => ({ on() {} }), env: {}, timeoutMs: 500 });
  assert(hw.ok && Date.now() - t0 < 5000, 'a tool that never answers times out');

  console.log('\n== Windows: nvidia-smi + Win32_VideoController + registry qwMemorySize ==');
  const winJson = JSON.stringify({
    v: [{ Name: 'NVIDIA GeForce RTX 4090', AdapterRAM: 4293918720 }, { Name: 'AMD Radeon RX 6800 XT', AdapterRAM: 4293918720 }, { Name: 'Intel(R) UHD Graphics 770', AdapterRAM: 1073741824 }],
    r: [{ DriverDesc: 'AMD Radeon RX 6800 XT', qw: 16 * GB }, { DriverDesc: 'NVIDIA GeForce RTX 4090', qw: 24 * GB }],
  });
  const wcalls = [];
  hw = await h.detectHardware({ platform: 'win32', os: fakeOs({ ramGB: 64 }), execFile: fakeExec({ 'nvidia-smi': 'NVIDIA GeForce RTX 4090, 24564\n', 'powershell.exe': winJson }, wcalls), env: {} });
  assert(wcalls.some((c) => /powershell/i.test(c[0]) && /Win32_VideoController/.test(c[1].join(' ')) && /qwMemorySize/.test(c[1].join(' '))), 'PowerShell asks for the video controllers AND the registry memory size');
  assert(hw.gpus.filter((g) => g.vendor === 'nvidia').length === 1, 'the NVIDIA card is not listed twice');
  const amd = hw.gpus.find((g) => g.vendor === 'amd');
  assert(amd && amd.vramMB === 16384, 'the registry fixes AMD\'s 4 GB AdapterRAM cap → 16 GB');
  assert(hw.gpus.some((g) => g.vendor === 'intel') && hw.bestVramMB === 24564, 'Intel iGPU listed but not counted; best = 4090');
  const capped = h.parseWindowsVideo(JSON.stringify({ v: { Name: 'AMD Radeon RX 7800 XT', AdapterRAM: 4293918720 }, r: null }));
  assert(capped.capped === true && capped.gpus[0].vramMB === 4095, 'without the registry the 4 GB cap is flagged');
  hw = await h.detectHardware({ platform: 'win32', os: fakeOs(), execFile: fakeExec({ 'powershell.exe': JSON.stringify({ v: { Name: 'AMD Radeon RX 7800 XT', AdapterRAM: 4293918720 }, r: null }) }), env: {} });
  assert(hw.notes.some((n) => /up to 4 GB/.test(n)), 'and the user is told the card may have more memory than shown');
  assert(h.parseWindowsVideo('not json').gpus.length === 0, 'garbage PowerShell output → no cards, no throw');

  console.log('\n== macOS ==');
  hw = await h.detectHardware({ platform: 'darwin', arch: 'arm64', os: fakeOs({ ramGB: 32, cpu: 'Apple M2 Pro' }), execFile: fakeExec({}), env: {} });
  assert(hw.appleSilicon === true && hw.gpus[0].vendor === 'apple', 'Apple Silicon detected');
  assert(hw.bestVramMB === Math.round(32768 * 0.7), 'unified memory: ~70% of RAM usable as VRAM');
  assert(/shared memory/.test(h.describeHardware(hw)), `summary: "${h.describeHardware(hw)}"`);
  hw = await h.detectHardware({ platform: 'darwin', arch: 'x64', os: fakeOs({ cpu: 'Intel(R) Core(TM) i9' }), execFile: fakeExec({ system_profiler: JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'AMD Radeon Pro 5500M', spdisplays_vram: '8 GB' }] }) }), env: {} });
  assert(hw.appleSilicon === false && hw.gpus[0].vramMB === 8192 && hw.gpus[0].vendor === 'amd', 'Intel Mac: system_profiler card + VRAM');

  console.log('\n== rateFit rules ==');
  const pc = { bestVramMB: 12288, ramMB: 32768, freeRamMB: 20480 };
  let f = h.rateFit(4.7 * GB, pc);
  assert(f.rating === 'great' && f.stars === 3 && f.label === '★★★ Great fit' && f.runsOn === 'gpu', '7B Q4 on a 12 GB card → great');
  assert(f.needMB > 4.7 * 1024 * 1.15 && f.needMB < 4.7 * 1024 * 1.15 + 2000, `need ≈ size×1.15 + KV + 500 MB (${f.needMB} MB)`);
  assert(/graphics card has 12 GB/.test(f.reason) && !/VRAM|KV|quant/i.test(f.reason), `the reason is plain English: "${f.reason}"`);
  f = h.rateFit(8.1 * GB, pc);
  assert(f.rating === 'good' && f.stars === 2 && f.label === '★★ Good fit', '8 GB file on 12 GB → good (fits, < 1.5 GB spare)');
  f = h.rateFit(20 * GB, pc);
  assert(f.rating === 'slow' && f.stars === 1 && f.runsOn === 'gpu+cpu' && /main processor/.test(f.reason), '20 GB on 12 GB + RAM → slow, part offloaded');
  f = h.rateFit(43 * GB, pc);
  assert(f.rating === 'too-big' && f.stars === 0 && f.label === '✖ Too big for this PC' && /smaller/.test(f.reason), '70B on this PC → too big, suggests smaller');
  f = h.rateFit(4.7 * GB, { bestVramMB: 0, ramMB: 16384, freeRamMB: 9000 });
  assert(f.rating === 'slow' && f.runsOn === 'cpu' && /processor/.test(f.reason), 'no GPU but enough RAM → slow on the CPU');
  f = h.rateFit(20 * GB, { bestVramMB: 0, ramMB: 16384, freeRamMB: 9000 });
  assert(f.rating === 'too-big', 'no GPU and not enough RAM → too big');
  f = h.rateFit(null, pc);
  assert(f.rating === 'unknown' && /don't know/.test(f.reason), 'unknown size → unknown');
  f = h.rateFit(4 * GB, null);
  assert(f.rating === 'unknown', 'no hardware info → unknown (never too-big)');
  const small = h.rateFit(4.7 * GB, pc, { contextTokens: 2048 }).needMB;
  const big = h.rateFit(4.7 * GB, pc, { contextTokens: 32768 }).needMB;
  assert(big > small, 'a longer context needs more memory');
  const mac = { bestVramMB: Math.round(16384 * 0.7), ramMB: 16384, freeRamMB: 4000, appleSilicon: true };
  assert(h.rateFit(4.7 * GB, mac).rating === 'great' && /Mac/.test(h.rateFit(4.7 * GB, mac).reason), 'Apple Silicon wording mentions the Mac');

  console.log('\n== canDownload ==');
  assert(h.canDownload('great') && h.canDownload('good') && h.canDownload('slow') && h.canDownload('unknown'), 'great/good/slow/unknown can download');
  assert(h.canDownload('too-big') === false && h.canDownload({ rating: 'too-big' }) === false, 'too-big cannot (string or fit object)');

  console.log('\n== pickVariant ==');
  const vs = [
    { tag: '1b', sizeBytes: 1.3 * GB }, { tag: '8b', sizeBytes: 4.9 * GB }, { tag: '14b', sizeBytes: 9.0 * GB }, { tag: '70b', sizeBytes: 43 * GB },
  ];
  let p = h.pickVariant(vs, pc);
  assert(p && p.tag === '8b' && p.fit.rating === 'great', 'the biggest GREAT variant wins on 12 GB (8b)');
  p = h.pickVariant(vs, { bestVramMB: 24576, ramMB: 65536, freeRamMB: 40000 });
  assert(p.tag === '14b', 'on 24 GB the 14b is great and chosen');
  p = h.pickVariant([{ tag: 'a', sizeBytes: 8.2 * GB }, { tag: 'b', sizeBytes: 43 * GB }], pc);
  assert(p && p.tag === 'a' && p.fit.rating === 'good', 'no great → the good one');
  p = h.pickVariant([{ tag: 'x', sizeBytes: 20 * GB }, { tag: 'y', sizeBytes: 15 * GB }, { tag: 'z', sizeBytes: 300 * GB }], pc);
  assert(p && p.tag === 'y' && p.fit.rating === 'slow', 'only slow ones → the smallest slow (least offloading)');
  assert(h.pickVariant([{ tag: 'z', sizeBytes: 300 * GB }], pc) === null, 'nothing runs → null');
  assert(h.pickVariant([], pc) === null && h.pickVariant(null, pc) === null, 'empty/missing list → null');
  assert(vs[1].fit === undefined, 'the input variants are not mutated');

  console.log('\n== browser-safe: loads as window.LlmHardware without require ==');
  const fs = require('fs'); const vm = require('vm');
  const sandbox = { window: {} }; sandbox.window.window = sandbox.window;
  vm.runInNewContext(fs.readFileSync(require.resolve('../llm-hardware'), 'utf8'), sandbox);
  assert(sandbox.window.LlmHardware && typeof sandbox.window.LlmHardware.rateFit === 'function', 'window.LlmHardware.rateFit exists in a page');
  assert(sandbox.window.LlmHardware.rateFit(4.7 * GB, pc).rating === 'great', 'and rates the same as in Node');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
