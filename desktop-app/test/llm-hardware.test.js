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
  assert(f.rating === 'excellent' && f.stars === 3 && f.label === '★★★ Excellent fit' && f.runsOn === 'gpu', '7B Q4 on a 12 GB card → ★★★ Excellent');
  assert(f.needMB > 4.7 * 1024 * 1.15 && f.needMB < 4.7 * 1024 * 1.15 + 2000, `need ≈ size×1.15 + KV + 500 MB (${f.needMB} MB)`);
  assert(/graphics card has 12 GB/.test(f.reason) && !/VRAM|KV|quant/i.test(f.reason), `the reason is plain English: "${f.reason}"`);
  f = h.rateFit(8.1 * GB, pc);
  assert(f.rating === 'good' && f.stars === 2 && f.label === '★★ Good fit', '8 GB file on 12 GB → ★★ Good (fits with a little room, not for long chats)');
  f = h.rateFit(20 * GB, pc);
  assert(f.rating === 'slow' && f.stars === 0 && f.label === '🐢 Slow — it runs, but slowly' && f.runsOn === 'gpu+cpu' && /main processor/.test(f.reason), '20 GB on 12 GB + RAM → slow, part offloaded');
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
  assert(h.rateFit(4.7 * GB, mac).rating === 'excellent' && /Mac/.test(h.rateFit(4.7 * GB, mac).reason), 'Apple Silicon wording mentions the Mac');

  console.log('\n== canDownload ==');
  assert(h.canDownload('excellent') && h.canDownload('good') && h.canDownload('ok') && h.canDownload('slow') && h.canDownload('unknown'), 'excellent/good/ok/slow/unknown can download');
  assert(h.canDownload('too-big') === false && h.canDownload({ rating: 'too-big' }) === false, 'too-big cannot (string or fit object)');

  console.log('\n== pickVariant ==');
  const vs = [
    { tag: '1b', sizeBytes: 1.3 * GB }, { tag: '8b', sizeBytes: 4.9 * GB }, { tag: '14b', sizeBytes: 9.0 * GB }, { tag: '70b', sizeBytes: 43 * GB },
  ];
  let p = h.pickVariant(vs, pc);
  assert(p && p.tag === '8b' && p.fit.rating === 'excellent', 'the biggest EXCELLENT variant wins on 12 GB (8b)');
  p = h.pickVariant(vs, { bestVramMB: 24576, ramMB: 65536, freeRamMB: 40000 });
  assert(p.tag === '14b', 'on 24 GB the 14b is excellent and chosen');
  p = h.pickVariant([{ tag: 'a', sizeBytes: 8.2 * GB }, { tag: 'b', sizeBytes: 43 * GB }], pc);
  assert(p && p.tag === 'a' && p.fit.rating === 'ok', 'nothing Excellent or Good → the ★ OK one');
  p = h.pickVariant([{ tag: 'x', sizeBytes: 20 * GB }, { tag: 'y', sizeBytes: 15 * GB }, { tag: 'z', sizeBytes: 300 * GB }], pc);
  assert(p && p.tag === 'y' && p.fit.rating === 'slow', 'only slow ones → the smallest slow (least offloading)');
  assert(h.pickVariant([{ tag: 'z', sizeBytes: 300 * GB }], pc) === null, 'nothing runs → null');
  assert(h.pickVariant([], pc) === null && h.pickVariant(null, pc) === null, 'empty/missing list → null');
  assert(vs[1].fit === undefined, 'the input variants are not mutated');

  console.log('\n== fit tiers at their boundaries (4000 MB file: need 5900 MB normally, 6700 MB for a 16k chat) ==');
  const F4 = 4000 * MB;
  const at = (vram, ram = 65536) => h.rateFit(F4, { bestVramMB: vram, ramMB: ram, freeRamMB: 0 }).rating;
  assert(at(6700 + 1024 + 1) === 'excellent' && at(6700 + 1024 - 1) === 'good', `★★★ Excellent needs the 16k-chat size + 1 GB spare (${at(7725)} / ${at(7723)})`);
  assert(at(5900 + 512 + 1) === 'good' && at(5900 + 512 - 1) === 'ok', `★★ Good needs the normal size + 0.5 GB spare (${at(6413)} / ${at(6411)})`);
  assert(at(5900 + 1) === 'ok' && at(5900 - 1) === 'slow', `★ OK = only just fits; below that it spills to the processor (${at(5901)} / ${at(5899)})`);
  assert(at(2000, 7802) === 'slow' && at(2000, 7796) === 'too-big', 'card + half the RAM is the limit for 🐢 slow; past it ✖ too big');
  const okFit = h.rateFit(F4, { bestVramMB: 6000, ramMB: 32768 });
  assert(okFit.stars === 1 && okFit.label === '★ OK fit' && /only just fits/.test(okFit.reason) && /slow down/.test(okFit.reason), `★ OK says it is tight: "${okFit.reason}"`);
  assert(h.fitUsable('excellent') && h.fitUsable({ rating: 'good' }) && !h.fitUsable('ok') && !h.fitUsable('slow'), 'fitUsable = Excellent or Good');
  assert(h.FIT_RANK.excellent > h.FIT_RANK.good && h.FIT_RANK.good > h.FIT_RANK.ok && h.FIT_RANK.ok > h.FIT_RANK.slow && h.FIT_RANK.slow > h.FIT_RANK['too-big'], 'FIT_RANK orders the tiers');

  console.log('\n== speed estimate ==');
  const rtx3060 = { bestVramMB: 12288, ramMB: 32768, freeRamMB: 20480, gpus: [{ name: 'NVIDIA GeForce RTX 3060', vramMB: 12288 }] };
  const rtx5090 = { bestVramMB: 32768, ramMB: 65536, freeRamMB: 40000, gpus: [{ name: 'NVIDIA GeForce RTX 5090', vramMB: 32768 }] };
  const cpuOnly = { bestVramMB: 0, ramMB: 32768, freeRamMB: 20480, gpus: [] };
  assert(h.gpuBandwidth(rtx3060) === 360 && h.gpuBandwidth(rtx5090) === 1792 && h.gpuBandwidth(cpuOnly) === 0, 'bandwidth table: RTX 3060 360 GB/s, RTX 5090 1792 GB/s, no card 0');
  assert(h.gpuBandwidth({ bestVramMB: 16384, gpus: [{ name: 'NVIDIA GeForce RTX 5070 Ti', vramMB: 16384 }] }) === 896 && h.gpuBandwidth({ bestVramMB: 8192, gpus: [{ name: 'NVIDIA GeForce RTX 5060 Laptop GPU', vramMB: 8192 }] }) === 336, 'RTX 50xx by name (a laptop card counts ¾)');
  assert(h.gpuBandwidth({ bestVramMB: 16384, gpus: [{ name: 'Mystery GPU', vramMB: 16384 }] }) === 500, 'an unknown card is guessed from its memory size');
  const sizes = [1, 2, 4.7, 7, 9, 14, 20];
  const tps = sizes.map((g) => h.estimateSpeed(g * GB, rtx3060).tokensPerSec);
  assert(tps.every((t, i) => i === 0 || t < tps[i - 1]), `monotonic: a bigger model is slower (${tps.join(' > ')} tokens/s)`);
  const s7 = h.estimateSpeed(4.7 * GB, rtx3060);
  assert(s7.tokensPerSec > 30 && s7.tokensPerSec < 70 && s7.estimate && !s7.measured, `7B on an RTX 3060 ≈ ${s7.tokensPerSec} tokens/s (real cards: ~50)`);
  assert(/words\/s/.test(s7.text) && /~300 words/.test(s7.text) && /takes about \d+ s/.test(s7.text) && /estimate/.test(s7.text), `the card text: "${s7.text}"`);
  const c7 = h.estimateSpeed(4.7 * GB, cpuOnly);
  assert(c7.tokensPerSec < s7.tokensPerSec / 3 && c7.tokensPerSec > 2, `the graphics card is much faster than the processor (${s7.tokensPerSec} vs ${c7.tokensPerSec} tokens/s)`);
  assert(h.estimateSpeed(4.7 * GB, rtx5090).tokensPerSec > s7.tokensPerSec, 'an RTX 5090 is faster than an RTX 3060');
  assert(h.estimateSpeed(14 * GB, rtx3060).tokensPerSec < h.estimateSpeed(9 * GB, rtx3060).tokensPerSec, 'spilling more onto the processor is slower');
  const meas = h.estimateSpeed(4.7 * GB, rtx3060, { measured: 12.5 });
  assert(meas.measured && meas.tokensPerSec === 12.5 && /measured on this PC/.test(meas.text) && !/estimate/.test(meas.text), `a measured speed overrides the estimate ("${meas.text}")`);
  assert(h.estimateSpeed(null, rtx3060, { measured: 20 }).tokensPerSec === 20, 'measured works even without a size');
  assert(h.estimateSpeed(43 * GB, rtx3060).tokensPerSec === null && /can't run/.test(h.estimateSpeed(43 * GB, rtx3060).text), 'too big → no speed, says it can\'t run');
  assert(h.estimateSpeed(4.7 * GB, null).tokensPerSec === null && h.estimateSpeed(null, rtx3060).tokensPerSec === null, 'no hardware / no size → "unknown", never a made-up number');
  assert(h.speedClass({ tokensPerSec: 40 }) === 2 && h.speedClass({ tokensPerSec: 10 }) === 1 && h.speedClass({ tokensPerSec: 3 }) === 0 && h.speedClass(null) === 1, 'speed steps: quick / fine / slow (unknown = fine)');

  console.log('\n== good pick for Alfred or not ==');
  const EX = { rating: 'excellent' };
  let v = h.verdictFor({ name: 'qwen2.5', tools: true }, EX, { pullName: 'qwen2.5:7b' });
  assert(v.kind === 'good' && v.label === '✔ Good pick for Alfred', 'Excellent fit + tools + 7B → ✔ Good pick');
  assert(h.verdictFor({ name: 'qwen2.5', tools: true }, { rating: 'good' }, { pullName: 'qwen2.5:7b' }).kind === 'good', 'Good fit counts too');
  v = h.verdictFor({ name: 'nomic-embed-text', embedding: true, tools: false }, EX);
  assert(v.kind === 'bad' && /^✖ Not a good pick: /.test(v.label) && /can't chat/.test(v.label), `embedding model → ✖ ("${v.label}")`);
  assert(h.verdictFor({ name: 'mxbai-embed-large' }, EX).kind === 'bad', 'an "embed" name is caught even without the flag');
  assert(h.verdictFor({ name: 'x/whisper', chat: false, tools: true }, EX).kind === 'bad', 'a model that can\'t chat → ✖');
  v = h.verdictFor({ name: 'llama3.3', tools: true }, { rating: 'too-big' }, { pullName: 'llama3.3:70b' });
  assert(v.kind === 'bad' && /too big/.test(v.label), 'too big → ✖ Not a good pick: too big');
  v = h.verdictFor({ name: 'qwen2.5', tools: true }, EX, { pullName: 'qwen2.5:1.5b', params: 1.5 });
  assert(v.kind === 'mixed' && /^◐ Works, but /.test(v.label) && /very small/.test(v.label) && /wrong tool/.test(v.label), `under 3B → ◐ ("${v.label}")`);
  v = h.verdictFor({ name: 'dolphin3', tools: null }, EX, { pullName: 'dolphin3:8b' });
  assert(v.kind === 'mixed' && /may not be able to use Alfred's tools/.test(v.label), 'tool use unknown → ◐ may not use tools');
  v = h.verdictFor({ name: 'gemma', tools: false }, EX, { pullName: 'gemma:7b' });
  assert(v.kind === 'mixed' && /can't use Alfred's tools/.test(v.label), 'no tools → ◐ can\'t use his tools');
  assert(/only just fits/.test(h.verdictFor({ name: 'q', tools: true }, { rating: 'ok' }, { pullName: 'q:7b' }).label), '★ OK fit → ◐ only just fits');
  assert(/slowly/.test(h.verdictFor({ name: 'q', tools: true }, { rating: 'slow' }, { pullName: 'q:7b' }).label), '🐢 slow → ◐ runs slowly');
  assert(h.verdictFor({ name: 'q', tools: true }, { rating: 'unknown' }, { pullName: 'q:7b' }).kind === 'mixed', 'fit unknown → ◐');
  assert(h.paramsOf('qwen2.5:1.5b') === 1.5 && h.paramsOf(null, 'Llama-3.2-3B-Instruct') === 3 && h.paramsOf('dolphin-mixtral:8x7b') > 40, 'paramsOf reads sizes from names');

  console.log('\n== sorting: good pick, then fit, then speed ==');
  const items = [
    { id: 'bad', verdict: { kind: 'bad' }, fit: { rating: 'too-big' }, speed: null },
    { id: 'mixedEx', verdict: { kind: 'mixed' }, fit: { rating: 'excellent' }, speed: { tokensPerSec: 90 } },
    { id: 'goodGoodSlow', verdict: { kind: 'good' }, fit: { rating: 'good' }, speed: { tokensPerSec: 5 } },
    { id: 'goodExSlow', verdict: { kind: 'good' }, fit: { rating: 'excellent' }, speed: { tokensPerSec: 12 } },
    { id: 'goodExFast', verdict: { kind: 'good' }, fit: { rating: 'excellent' }, speed: { tokensPerSec: 60 } },
  ];
  const order = items.slice().sort(h.compareChoice).map((x) => x.id).join(',');
  assert(order === 'goodExFast,goodExSlow,goodGoodSlow,mixedEx,bad', `✔ before ◐ before ✖, then fit, then speed (${order})`);

  console.log('\n== browser-safe: loads as window.LlmHardware without require ==');
  const fs = require('fs'); const vm = require('vm');
  const sandbox = { window: {} }; sandbox.window.window = sandbox.window;
  vm.runInNewContext(fs.readFileSync(require.resolve('../llm-hardware'), 'utf8'), sandbox);
  assert(sandbox.window.LlmHardware && typeof sandbox.window.LlmHardware.rateFit === 'function', 'window.LlmHardware.rateFit exists in a page');
  assert(sandbox.window.LlmHardware.rateFit(4.7 * GB, pc).rating === 'excellent', 'and rates the same as in Node');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
