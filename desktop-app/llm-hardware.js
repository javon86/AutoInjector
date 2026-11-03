'use strict';
/*
 * llm-hardware.js — "what can this PC run?" for Alfred's model finder.
 *   • detectHardware(deps?) — graphics card(s) + video memory, RAM, CPU. NVIDIA
 *     via nvidia-smi; other cards on Windows via PowerShell (Win32_VideoController,
 *     plus the registry's HardwareInformation.qwMemorySize because AdapterRAM
 *     stops at 4 GB); Apple Silicon = unified memory (~70% usable as VRAM);
 *     Linux = nvidia-smi / rocm-smi / lspci, best effort. Never throws, times out.
 *   • rateFit(sizeBytes, hw, {contextTokens}) — ★★★ Excellent / ★★ Good / ★ OK /
 *     🐢 Slow / ✖ too big, with a plain-English reason a non-technical user can follow.
 *   • pickVariant(variants, hw) — the best-quality size/quant that runs well here.
 *   • estimateSpeed(sizeBytes, hw, {measured}) — about how many words a second it
 *     answers on THIS PC (a documented memory-bandwidth heuristic, or the speed
 *     Alfred really measured when he has used the model).
 *   • verdictFor(model, fit) — ✔ Good pick for Alfred / ◐ Works, but … / ✖ Not a good pick: …
 * Electron-free with injectable execFile/os/platform so it's unit-testable. The
 * pure helpers (rateFit, pickVariant, canDownload, describeHardware) are also
 * usable in the renderer: loaded by a <script> tag they appear as
 * window.LlmHardware (child_process / os are only required inside detect).
 */
(function (root) {
  const MB = 1024 * 1024;
  // Fit tiers (all about the graphics card's memory, "VRAM"):
  //   need(8k)  = file × 1.15 + KV cache for an 8k-token chat + 500 MB   (a normal chat)
  //   need(16k) = the same with a 16k-token context                      (Alfred's own chats: his tool list alone is ~11k tokens)
  //   ★★★ Excellent  need(16k) + 1 GB ≤ VRAM     long chats fit, with room to spare
  //   ★★  Good       need(8k) + 0.5 GB ≤ VRAM    fits with a little room; very long chats may spill a bit
  //   ★   OK         need(8k) ≤ VRAM             only just fits; long chats spill to the processor and slow down
  //   🐢  Slow       need(8k) ≤ VRAM + spare RAM part (or all, with no usable card) runs on the processor
  //   ✖   Too big    more than the card and the free memory together
  const EXCELLENT_SPARE_MB = 1024;
  const GOOD_SPARE_MB = 512;
  const LONG_CONTEXT = 16384;
  const OVERHEAD_MB = 500;         // runtime + buffers
  const APPLE_VRAM_SHARE = 0.7;    // macOS lets the GPU use ~70% of unified memory

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  function gb(mb) { const g = mb / 1024; return g >= 10 ? `${Math.round(g)} GB` : `${(Math.round(g * 10) / 10)} GB`; }

  function vendorOf(name) {
    const n = String(name || '').toLowerCase();
    if (/nvidia|geforce|quadro|tesla|rtx|gtx|titan/.test(n)) return 'nvidia';
    if (/\bamd\b|radeon|\bati\b|instinct|firepro/.test(n)) return 'amd';
    if (/apple|\bm[1-9]\b/.test(n)) return 'apple';
    if (/intel|iris|uhd graphics|\barc\b/.test(n)) return 'intel';
    return 'other';
  }

  // ---------------------------------------------------------------- running tools
  function run(deps, bin, args, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = (v) => { if (!done) { done = true; if (timer) clearTimeout(timer); resolve(v); } };
      // Belt and braces: a tool that never calls back can't hang detection.
      timer = setTimeout(() => finish({ ok: false, error: 'timed out' }), timeoutMs + 500);
      try {
        const child = deps.execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * MB }, (err, stdout) => {
          if (err) return finish({ ok: false, error: String((err && err.message) || err) });
          finish({ ok: true, stdout: String(stdout || '') });
        });
        if (child && typeof child.on === 'function') child.on('error', (e) => finish({ ok: false, error: String((e && e.message) || e) }));
      } catch (e) { finish({ ok: false, error: String((e && e.message) || e) }); }
    });
  }

  // "NVIDIA GeForce RTX 3060, 12288" (nounits) per line.
  function parseNvidiaSmi(stdout) {
    return String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const parts = l.split(',').map((s) => s.trim());
      if (parts.length < 2) return null;
      const vram = num(parts[1]);
      return { name: parts[0] || 'NVIDIA GPU', vendor: 'nvidia', vramMB: vram != null ? Math.round(vram) : null };
    }).filter(Boolean);
  }

  // PowerShell prints {"v":[{Name, AdapterRAM}], "r":[{DriverDesc, qw}]} (either may be a lone object).
  function parseWindowsVideo(stdout) {
    let data;
    try { data = JSON.parse(String(stdout || '').trim() || 'null'); } catch (_) { return { gpus: [], capped: false }; }
    if (!data) return { gpus: [], capped: false };
    const list = (x) => (Array.isArray(x) ? x : (x ? [x] : []));
    const reg = list(data.r).map((r) => ({ name: String(r.DriverDesc || ''), bytes: num(r.qw != null ? r.qw : r['HardwareInformation.qwMemorySize']) }))
      .filter((r) => r.name);
    let capped = false;
    const gpus = list(data.v).map((v) => {
      const name = String(v.Name || '').trim();
      if (!name) return null;
      let bytes = num(v.AdapterRAM);
      // AdapterRAM is a 32-bit field: anything ≥ 4 GB reads as ~4 GB (or wraps negative).
      const hit = reg.find((r) => r.name === name && r.bytes);
      if (hit && hit.bytes) bytes = hit.bytes;
      else if (bytes != null && (bytes < 0 || bytes >= 4 * 1024 * MB - MB)) capped = true;
      if (bytes != null && bytes < 0) bytes = 4 * 1024 * MB;
      return { name, vendor: vendorOf(name), vramMB: bytes ? Math.round(bytes / MB) : null };
    }).filter(Boolean);
    return { gpus, capped };
  }

  // rocm-smi --showproductname --showmeminfo vram --json → {"card0":{"Card series":"…","VRAM Total Memory (B)":"…"}}
  function parseRocmSmi(stdout) {
    let data;
    try { data = JSON.parse(String(stdout || '').trim() || 'null'); } catch (_) { return []; }
    if (!data || typeof data !== 'object') return [];
    return Object.keys(data).filter((k) => /^card/i.test(k)).map((k) => {
      const c = data[k] || {};
      let name = '', bytes = null;
      for (const key of Object.keys(c)) {
        if (/vram total memory/i.test(key)) bytes = num(c[key]);
        else if (/card series|card model|marketing name/i.test(key) && !name) name = String(c[key]);
      }
      return { name: name || 'AMD GPU', vendor: 'amd', vramMB: bytes ? Math.round(bytes / MB) : null };
    });
  }

  // lspci lines: "01:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 22 [Radeon RX 6700 XT]"
  function parseLspci(stdout) {
    return String(stdout || '').split('\n').filter((l) => /(VGA compatible controller|3D controller|Display controller)/i.test(l)).map((l) => {
      const name = l.replace(/^.*?(VGA compatible controller|3D controller|Display controller)\s*(\[[0-9a-f]+\])?:\s*/i, '').replace(/\s*\(rev [^)]*\)\s*$/i, '').trim();
      return { name: name || 'Graphics card', vendor: vendorOf(name), vramMB: null };
    });
  }

  // system_profiler SPDisplaysDataType -json (Intel Macs): {"SPDisplaysDataType":[{"sppci_model":"…","spdisplays_vram":"4 GB"}]}
  function parseMacDisplays(stdout) {
    let data;
    try { data = JSON.parse(String(stdout || '').trim() || 'null'); } catch (_) { return []; }
    const list = (data && Array.isArray(data.SPDisplaysDataType)) ? data.SPDisplaysDataType : [];
    return list.map((d) => {
      const name = String(d.sppci_model || d._name || 'Graphics');
      const v = String(d.spdisplays_vram || d.spdisplays_vram_shared || '');
      const m = /([\d.]+)\s*(GB|MB)/i.exec(v);
      const vramMB = m ? Math.round(Number(m[1]) * (/gb/i.test(m[2]) ? 1024 : 1)) : null;
      return { name, vendor: vendorOf(name), vramMB };
    });
  }

  const WIN_PS = [
    '$ErrorActionPreference="SilentlyContinue";',
    '$v=@(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM);',
    '$r=@(Get-ItemProperty "HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*" |',
    ' ForEach-Object { [pscustomobject]@{DriverDesc=$_.DriverDesc; qw=$_."HardwareInformation.qwMemorySize"} });',
    '@{v=$v;r=$r} | ConvertTo-Json -Depth 3 -Compress',
  ].join(' ');

  /**
   * detectHardware(deps?) -> Promise<{ ok, gpus, bestVramMB, ramMB, freeRamMB, cpu, cores, platform, appleSilicon, notes }>
   * deps: { execFile, os, platform, arch, env, timeoutMs }. Never throws.
   */
  async function detectHardware(deps) {
    const d = Object.assign({}, deps || {});
    try {
      if (!d.execFile) d.execFile = require('child_process').execFile;
      if (!d.os) d.os = require('os');
    } catch (_) {}
    const os = d.os || {};
    const platform = d.platform || (typeof process !== 'undefined' ? process.platform : 'unknown');
    const arch = d.arch || (typeof os.arch === 'function' ? os.arch() : (typeof process !== 'undefined' ? process.arch : ''));
    const env = d.env || (typeof process !== 'undefined' ? process.env : {});
    const timeoutMs = Math.max(500, d.timeoutMs || 6000);
    const notes = [];
    const safe = (fn, dflt) => { try { const v = fn(); return v == null ? dflt : v; } catch (_) { return dflt; } };

    const ramMB = Math.round(safe(() => os.totalmem(), 0) / MB) || null;
    const freeRamMB = Math.round(safe(() => os.freemem(), 0) / MB) || null;
    const cpus = safe(() => os.cpus(), []) || [];
    const cpu = (cpus[0] && String(cpus[0].model || '').trim()) || '';
    const cores = cpus.length || null;
    const appleSilicon = platform === 'darwin' && (arch === 'arm64' || /apple/i.test(cpu));

    let gpus = [];
    try {
      if (appleSilicon) {
        const vram = ramMB ? Math.round(ramMB * APPLE_VRAM_SHARE) : null;
        gpus.push({ name: cpu ? `${cpu} graphics` : 'Apple Silicon graphics', vendor: 'apple', vramMB: vram });
        notes.push('Apple Silicon shares one pool of memory between the processor and graphics; about 70% of it can hold a model.');
      } else {
        const smi = await run(d, env.NVIDIA_SMI || 'nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], timeoutMs);
        if (smi.ok) gpus = parseNvidiaSmi(smi.stdout);
        if (platform === 'win32') {
          const ps = await run(d, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PS], timeoutMs);
          if (ps.ok) {
            const w = parseWindowsVideo(ps.stdout);
            for (const g of w.gpus) {
              if (g.vendor === 'nvidia' && gpus.some((x) => x.vendor === 'nvidia')) continue; // nvidia-smi is exact
              gpus.push(g);
            }
            if (w.capped && w.gpus.some((g) => g.vendor !== 'nvidia' && g.vramMB && g.vramMB >= 4000)) {
              notes.push('Windows only reports up to 4 GB for some graphics cards, so your card may have more memory than shown.');
            }
          } else if (!gpus.length) notes.push('Could not ask Windows about the graphics card.');
        } else if (platform === 'linux') {
          if (!gpus.length) {
            const rocm = await run(d, 'rocm-smi', ['--showproductname', '--showmeminfo', 'vram', '--json'], timeoutMs);
            if (rocm.ok) gpus = parseRocmSmi(rocm.stdout);
          }
          if (!gpus.length) {
            const lspci = await run(d, 'lspci', [], timeoutMs);
            if (lspci.ok) {
              gpus = parseLspci(lspci.stdout);
              if (gpus.some((g) => g.vendor === 'nvidia' || g.vendor === 'amd')) notes.push('Found a graphics card but could not read how much memory it has (install the NVIDIA or AMD driver tools).');
            }
          }
        } else if (platform === 'darwin') {
          const sp = await run(d, 'system_profiler', ['SPDisplaysDataType', '-json'], timeoutMs);
          if (sp.ok) gpus = parseMacDisplays(sp.stdout);
          if (gpus.length) notes.push('On Intel Macs local models mostly run on the processor.');
        }
      }
    } catch (e) { notes.push('Could not check the graphics card.'); }

    // Only cards Ollama can actually run models on count toward "VRAM".
    const usable = gpus.filter((g) => g.vramMB && (g.vendor === 'nvidia' || g.vendor === 'amd' || g.vendor === 'apple'));
    const bestVramMB = usable.reduce((m, g) => Math.max(m, g.vramMB), 0) || 0;
    if (!gpus.length) notes.push('No graphics card found, so models will run on the processor (slower).');
    else if (!bestVramMB) notes.push('This graphics card is not one local models can use, so they will run on the processor (slower).');
    return { ok: true, gpus, bestVramMB, ramMB, freeRamMB, cpu, cores, platform, appleSilicon, notes };
  }

  /** "RTX 3060 12 GB · 32 GB RAM" */
  function describeHardware(hw) {
    if (!hw || (!hw.ramMB && !(hw.gpus && hw.gpus.length))) return 'Could not check this PC';
    const parts = [];
    const best = (hw.gpus || []).slice().sort((a, b) => (b.vramMB || 0) - (a.vramMB || 0))[0];
    if (hw.appleSilicon) parts.push(`${best ? best.name.replace(/ graphics$/, '') : 'Apple Silicon'} · ${gb(hw.ramMB || 0)} shared memory`);
    else {
      if (best) parts.push(`${String(best.name).replace(/^NVIDIA\s+|^AMD\s+/i, '').replace(/^GeForce\s+/i, '')}${best.vramMB ? ` ${gb(best.vramMB)}` : ''}`);
      else parts.push('No graphics card');
      if (hw.ramMB) parts.push(`${gb(hw.ramMB)} RAM`);
    }
    return parts.join(' · ');
  }

  // KV cache for the context window: grows with model size; ~1 GB for an 8B at 8k tokens.
  function kvCacheMB(fileMB, contextTokens) {
    const per8k = Math.min(2500, Math.max(150, fileMB * 0.2));
    return per8k * (Math.max(512, contextTokens) / 8192);
  }

  const LABELS = {
    excellent: '★★★ Excellent fit', good: '★★ Good fit', ok: '★ OK fit', slow: '🐢 Slow — it runs, but slowly',
    'too-big': '✖ Too big for this PC', unknown: '? Fit unknown',
  };
  const STARS = { excellent: 3, good: 2, ok: 1, slow: 0, 'too-big': 0, unknown: 0 };
  /** Higher = better; used for sorting everywhere (too-big is always last). */
  const FIT_RANK = { excellent: 5, good: 4, ok: 3, slow: 2, unknown: 1, 'too-big': 0 };
  function result(rating, reason, needMB, runsOn) {
    return { rating, stars: STARS[rating], label: LABELS[rating], reason, needMB: needMB != null ? Math.round(needMB) : null, runsOn };
  }

  /**
   * rateFit(sizeBytes, hw, {contextTokens=8192}) -> { rating, stars, label, reason, needMB, runsOn }
   * need ≈ file × 1.15 + KV cache for the context + ~500 MB. Tiers: see the table at the top.
   */
  function rateFit(sizeBytes, hw, opts) {
    const o = opts || {};
    const ctx = num(o.contextTokens) || 8192;
    const size = num(sizeBytes);
    if (!size || size <= 0) return result('unknown', 'We don\'t know this download\'s size yet, so we can\'t say how well it will run.', null, null);
    const fileMB = size / MB;
    const needMB = fileMB * 1.15 + kvCacheMB(fileMB, ctx) + OVERHEAD_MB;
    const longMB = fileMB * 1.15 + kvCacheMB(fileMB, Math.max(ctx, LONG_CONTEXT)) + OVERHEAD_MB;
    const need = gb(needMB);
    if (!hw || (!hw.ramMB && !hw.bestVramMB)) return result('unknown', `Needs about ${need} of memory. We couldn't check this PC, so we can't say how well it will run.`, needMB, null);
    const vram = num(hw.bestVramMB) || 0;
    const ram = num(hw.ramMB) || 0;
    // Memory free for the part that doesn't fit on the card: what's free now, or
    // (since other programs can give some back) at least half of the total.
    let spareRam = Math.max(num(hw.freeRamMB) || 0, ram * 0.5);
    if (hw.appleSilicon) spareRam = Math.max(0, ram * 0.85 - vram); // unified memory: same pool
    const card = hw.appleSilicon ? 'the memory your Mac can give to graphics' : 'your graphics card';

    if (vram > 0) {
      if (longMB + EXCELLENT_SPARE_MB <= vram) return result('excellent', `Needs about ${need}; ${card} has ${gb(vram)}, so it runs fully there with room to spare, even in long chats. Answers will be quick.`, needMB, 'gpu');
      if (needMB + GOOD_SPARE_MB <= vram) return result('good', `Needs about ${need}; it fits in ${card} (${gb(vram)}) with a little room left. Very long chats may slow it down a bit.`, needMB, 'gpu');
      if (needMB <= vram) return result('ok', `Needs about ${need}; it only just fits in ${card} (${gb(vram)}). Long chats may spill onto the main processor and slow down, so close other big programs for the best speed.`, needMB, 'gpu');
      if (needMB <= vram + spareRam) return result('slow', `Needs about ${need} but ${card} has ${gb(vram)}, so part of it runs on the main processor. It works, but answers come slowly.`, needMB, 'gpu+cpu');
      return result('too-big', `Needs about ${need}, but this PC has only ${gb(vram)} on ${card} plus about ${gb(spareRam)} of free memory. Pick a smaller size.`, needMB, null);
    }
    if (needMB <= spareRam) return result('slow', `No graphics card it can use, so it runs on the main processor using about ${need} of your ${gb(ram)} memory. Answers will be slow.`, needMB, 'cpu');
    return result('too-big', `Needs about ${need}, but this PC has about ${gb(spareRam)} of memory free and no graphics card it can use. Pick a smaller size.`, needMB, null);
  }

  function canDownload(rating) { return (rating && typeof rating === 'object' ? rating.rating : rating) !== 'too-big'; }
  /** Excellent or Good: the tiers ⚡ Set up chooses first. */
  function fitUsable(fit) { const r = fit && typeof fit === 'object' ? fit.rating : fit; return r === 'excellent' || r === 'good'; }

  /**
   * pickVariant(variants, hw) -> the biggest (best-quality) variant rated excellent,
   * else the biggest good one, else the biggest OK one, else the smallest slow one
   * (least offloading = fastest), else null. The returned object is a copy with .fit set.
   */
  function pickVariant(variants, hw, opts) {
    const list = (Array.isArray(variants) ? variants : []).filter((v) => v && num(v.sizeBytes) > 0)
      .map((v) => Object.assign({}, v, { fit: rateFit(v.sizeBytes, hw, opts) }));
    const by = (r) => list.filter((v) => v.fit.rating === r).sort((a, b) => b.sizeBytes - a.sizeBytes);
    for (const r of ['excellent', 'good', 'ok']) { const l = by(r); if (l.length) return l[0]; }
    const slow = by('slow'); if (slow.length) return slow[slow.length - 1];
    return null;
  }

  // ---------------------------------------------------------------- speed estimate
  // Writing an answer is limited by memory speed: for every word-piece ("token") the model reads all of its
  // weights once. So tokens/second ≈ efficiency × memory bandwidth (GB/s) ÷ model size (GB). The bandwidths below
  // are the makers' published figures (GB/s) for common cards; any other card is guessed from its memory size.
  // Real programs reach about 60% of the paper figure. A model split between the card and the main processor
  // pays for each part at its own speed. This is an ESTIMATE (±50%); a speed Alfred measured always wins.
  const GPU_BANDWIDTH = [
    // NVIDIA RTX 50xx / 40xx / 30xx / 20xx, GTX, workstation
    [/rtx\s*5090/i, 1792], [/rtx\s*5080/i, 960], [/rtx\s*5070\s*ti/i, 896], [/rtx\s*5070/i, 672], [/rtx\s*5060\s*ti/i, 448], [/rtx\s*5060/i, 448], [/rtx\s*5050/i, 320],
    [/rtx\s*4090/i, 1008], [/rtx\s*4080/i, 720], [/rtx\s*4070\s*ti\s*super/i, 672], [/rtx\s*4070/i, 504], [/rtx\s*4060\s*ti/i, 288], [/rtx\s*4060/i, 272], [/rtx\s*4050/i, 192],
    [/rtx\s*3090/i, 936], [/rtx\s*3080\s*ti/i, 912], [/rtx\s*3080/i, 760], [/rtx\s*3070\s*ti/i, 608], [/rtx\s*3070/i, 448], [/rtx\s*3060\s*ti/i, 448], [/rtx\s*3060/i, 360], [/rtx\s*3050/i, 224],
    [/rtx\s*2080\s*ti/i, 616], [/rtx\s*20[78]0/i, 448], [/rtx\s*2060/i, 336], [/gtx\s*1080\s*ti/i, 484], [/gtx\s*1080/i, 320], [/gtx\s*16[56]0/i, 192], [/gtx\s*10[67]0/i, 224],
    [/rtx\s*a6000|rtx\s*6000/i, 768], [/rtx\s*a5000|rtx\s*5000/i, 640], [/rtx\s*a4000|rtx\s*4000/i, 448], [/\bh100\b/i, 3350], [/\ba100\b/i, 1555], [/\bl40/i, 864],
    // AMD Radeon
    [/rx\s*9070/i, 640], [/rx\s*9060/i, 320], [/rx\s*7900\s*xtx/i, 960], [/rx\s*7900/i, 800], [/rx\s*7800/i, 624], [/rx\s*7700/i, 432], [/rx\s*7600/i, 288],
    [/rx\s*69[05]0/i, 512], [/rx\s*6800/i, 512], [/rx\s*6700/i, 384], [/rx\s*6600/i, 224],
    // Apple Silicon (unified memory)
    [/m[1-4]\s*ultra/i, 800], [/m4\s*max/i, 546], [/m[1-3]\s*max/i, 400], [/m4\s*pro/i, 273], [/m3\s*pro/i, 150], [/m[12]\s*pro/i, 200],
    [/\bm4\b/i, 120], [/\bm[23]\b/i, 100], [/\bm1\b/i, 68],
  ];
  const CPU_BANDWIDTH = 50;     // GB/s: ordinary dual-channel DDR4/DDR5 desktop or laptop memory
  const SPEED_EFFICIENCY = 0.6; // real programs reach ~60% of the paper bandwidth
  const WORDS_PER_TOKEN = 0.75; // an English word is ~1⅓ word-pieces
  const ANSWER_WORDS = 300;     // "a typical answer"
  function bestGpu(hw) {
    return ((hw && hw.gpus) || []).filter((g) => g && g.vramMB).sort((a, b) => (b.vramMB || 0) - (a.vramMB || 0))[0] || null;
  }
  /** Graphics memory bandwidth in GB/s for this PC's best card: from the table by name, else a guess by memory size. 0 = no usable card. */
  function gpuBandwidth(hw) {
    const vram = num(hw && hw.bestVramMB) || 0;
    if (!vram) return 0;
    const g = bestGpu(hw);
    const name = String((g && g.name) || '');
    for (const [re, bw] of GPU_BANDWIDTH) if (re.test(name)) return /laptop|mobile|max-q/i.test(name) ? Math.round(bw * 0.75) : bw;
    if (hw.appleSilicon) return 100;
    const gbv = vram / 1024;
    return gbv >= 20 ? 700 : gbv >= 14 ? 500 : gbv >= 10 ? 360 : gbv >= 7 ? 300 : gbv >= 5 ? 200 : 120;
  }
  function cpuBandwidth(hw) { return hw && hw.appleSilicon ? (gpuBandwidth(hw) || 100) : CPU_BANDWIDTH; }
  function secondsText(s) {
    if (s < 1.5) return 'about 1 s';
    if (s < 90) return `about ${Math.round(s)} s`;
    const m = s / 60; return m < 10 ? `about ${Math.round(m * 2) / 2} min` : `about ${Math.round(m)} min`;
  }
  /**
   * estimateSpeed(sizeBytes, hw, {fit?, measured?}) ->
   *   { tokensPerSec, wordsPerSec, answerSeconds, measured, estimate, short, text }   (tokensPerSec null = can't tell)
   * `measured` (tokens/second Alfred saw on real replies) replaces the estimate.
   */
  function estimateSpeed(sizeBytes, hw, opts) {
    const o = opts || {};
    const measured = num(o.measured);
    const out = (tps, isMeasured) => {
      const t = Math.max(0.1, Math.min(400, tps));
      const words = t * WORDS_PER_TOKEN;
      const secs = ANSWER_WORDS / words;
      const w = words >= 10 ? Math.round(words) : Math.round(words * 10) / 10;
      return {
        tokensPerSec: Math.round(t * 10) / 10, wordsPerSec: w, answerSeconds: Math.max(1, Math.round(secs)), measured: !!isMeasured, estimate: !isMeasured,
        short: `${isMeasured ? '' : '≈ '}${w} words/s`,
        text: `⚡ ${isMeasured ? '' : '≈ '}${w} words/s (${t >= 10 ? Math.round(t) : Math.round(t * 10) / 10} tokens/s): a typical answer (~${ANSWER_WORDS} words) takes ${secondsText(secs)} · ${isMeasured ? 'measured on this PC' : 'estimate'}`,
      };
    };
    if (measured && measured > 0) return out(measured, true);
    const size = num(sizeBytes);
    const none = (why) => ({ tokensPerSec: null, wordsPerSec: null, answerSeconds: null, measured: false, estimate: true, short: 'speed ?', text: `⚡ Speed: ${why}` });
    if (!size || size <= 0) return none('unknown (we don\'t know the download size)');
    if (!hw || (!hw.ramMB && !hw.bestVramMB)) return none('unknown (we couldn\'t check this PC)');
    const fit = o.fit || rateFit(size, hw);
    if (fit && fit.rating === 'too-big') return none('it can\'t run on this PC');
    const fileMB = size / MB;
    const sizeGB = fileMB / 1024;
    const gpuBw = gpuBandwidth(hw);
    const cpuBw = cpuBandwidth(hw);
    let onGpu = 0; // share of the model that sits on the graphics card
    if (gpuBw > 0) {
      const room = (num(hw.bestVramMB) || 0) - kvCacheMB(fileMB, 8192) - OVERHEAD_MB;
      onGpu = Math.max(0, Math.min(1, room / (fileMB * 1.15)));
    }
    const secPerToken = (onGpu > 0 ? (sizeGB * onGpu) / (gpuBw * SPEED_EFFICIENCY) : 0) + (sizeGB * (1 - onGpu)) / (cpuBw * SPEED_EFFICIENCY);
    return out(1 / secPerToken, false);
  }
  /** 2 = quick (≥ 25 tokens/s), 1 = fine (8–25) or unknown, 0 = slow (< 8). Speed counts in steps, so a slightly quicker tiny model never jumps ahead of a better one. */
  function speedClass(speed) {
    const t = speed ? num(speed.tokensPerSec) : null;
    if (t == null) return 1;
    return t >= 25 ? 2 : t >= 8 ? 1 : 0;
  }

  // ---------------------------------------------------------------- good choice or not
  /** 8 / "8b" / "qwen2.5:1.5b" / "Llama-3.2-3B-Instruct" -> billions of parameters (first one found), or null. */
  function paramsOf(...texts) {
    for (const t of texts) {
      if (typeof t === 'number') { if (t > 0) return t; continue; }
      const s = String(t == null ? '' : t);
      const moe = /(?:^|[^a-z0-9.])(\d+)x(\d+(?:\.\d+)?)b(?![a-z])/i.exec(s);
      if (moe) return Math.round(Number(moe[1]) * Number(moe[2]) * 0.83 * 10) / 10;
      const b = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*b(?![a-z])/i.exec(s);
      if (b) return Number(b[1]);
      const m = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*m(?![a-z])/i.exec(s);
      if (m) return Number(m[1]) / 1000;
    }
    return null;
  }
  const VERDICT_RANK = { good: 2, mixed: 1, bad: 0 };
  /**
   * verdictFor(model, fit?, variant?) -> { kind:'good'|'mixed'|'bad', label, reasons[] }
   *   ✔ Good pick for Alfred   Excellent/Good fit, can use tools, at least 3B (size unknown counts as fine)
   *   ◐ Works, but …           OK fit, slow, fit unknown, no (known) tool use, or under 3B (he may pick the wrong tool)
   *   ✖ Not a good pick: …     too big, an embedding-only model, or one that can't chat
   */
  function verdictFor(model, fit, variant) {
    const m = model || {};
    const v = variant || {};
    const f = fit || v.fit || m.fit || {};
    const name = [m.name, m.pullName, v.pullName, v.tag].filter(Boolean).join(' ');
    const bad = [];
    if (m.embedding || /(^|[^a-z])embed/i.test(name)) bad.push('it only makes search "embeddings" and can\'t chat');
    else if (m.chat === false) bad.push('it can\'t chat');
    if (f.rating === 'too-big') bad.push('it is too big for this PC');
    if (bad.length) return { kind: 'bad', reasons: bad, label: `✖ Not a good pick: ${bad.join('; ')}` };
    const but = [];
    if (f.rating === 'ok') but.push('it only just fits, so long chats may slow down');
    else if (f.rating === 'slow') but.push('it runs slowly on this PC');
    else if (!f.rating || f.rating === 'unknown') but.push('we couldn\'t check how well it fits this PC');
    if (m.tools === false) but.push('it can\'t use Alfred\'s tools');
    else if (m.tools !== true) but.push('it may not be able to use Alfred\'s tools');
    const p = paramsOf(v.params, v.tag, v.pullName, m.params, m.pullName, m.name);
    if (p != null && p < 3) but.push('it is very small, so he may pick the wrong tool');
    if (but.length) return { kind: 'mixed', reasons: but, label: `◐ Works, but ${but.join('; ')}` };
    return { kind: 'good', reasons: [], label: '✔ Good pick for Alfred' };
  }
  /** Sort comparator for model cards: ✔ before ◐ before ✖, then fit, then speed (in steps). Items carry { verdict, fit, speed }. */
  function compareChoice(a, b) {
    return (VERDICT_RANK[(b.verdict && b.verdict.kind) || 'mixed'] - VERDICT_RANK[(a.verdict && a.verdict.kind) || 'mixed'])
      || ((FIT_RANK[(b.fit && b.fit.rating) || 'unknown'] || 0) - (FIT_RANK[(a.fit && a.fit.rating) || 'unknown'] || 0))
      || (speedClass(b.speed) - speedClass(a.speed));
  }

  const api = {
    detectHardware, describeHardware, rateFit, canDownload, pickVariant, vendorOf, fitUsable,
    estimateSpeed, gpuBandwidth, cpuBandwidth, speedClass, verdictFor, compareChoice, paramsOf,
    parseNvidiaSmi, parseWindowsVideo, parseRocmSmi, parseLspci, parseMacDisplays, LABELS, STARS, FIT_RANK, VERDICT_RANK, GPU_BANDWIDTH,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.LlmHardware = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
