'use strict';
/*
 * llm-hardware.js — "what can this PC run?" for Alfred's model finder.
 *   • detectHardware(deps?) — graphics card(s) + video memory, RAM, CPU. NVIDIA
 *     via nvidia-smi; other cards on Windows via PowerShell (Win32_VideoController,
 *     plus the registry's HardwareInformation.qwMemorySize because AdapterRAM
 *     stops at 4 GB); Apple Silicon = unified memory (~70% usable as VRAM);
 *     Linux = nvidia-smi / rocm-smi / lspci, best effort. Never throws, times out.
 *   • rateFit(sizeBytes, hw, {contextTokens}) — ★★★ great / ★★ good / ★ slow /
 *     ✖ too big, with a plain-English reason a non-technical user can follow.
 *   • pickVariant(variants, hw) — the best-quality size/quant that runs well here.
 * Electron-free with injectable execFile/os/platform so it's unit-testable. The
 * pure helpers (rateFit, pickVariant, canDownload, describeHardware) are also
 * usable in the renderer: loaded by a <script> tag they appear as
 * window.LlmHardware (child_process / os are only required inside detect).
 */
(function (root) {
  const MB = 1024 * 1024;
  const SPARE_MB = 1536;           // "great" = fits on the card with ≥ 1.5 GB to spare
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
    great: '★★★ Great fit', good: '★★ Good fit', slow: '★ Runs, slowly', 'too-big': '✖ Too big for this PC', unknown: '? Fit unknown',
  };
  const STARS = { great: 3, good: 2, slow: 1, 'too-big': 0, unknown: 0 };
  function result(rating, reason, needMB, runsOn) {
    return { rating, stars: STARS[rating], label: LABELS[rating], reason, needMB: needMB != null ? Math.round(needMB) : null, runsOn };
  }

  /**
   * rateFit(sizeBytes, hw, {contextTokens=8192}) -> { rating, stars, label, reason, needMB, runsOn }
   * need ≈ file × 1.15 + KV cache for the context + ~500 MB.
   */
  function rateFit(sizeBytes, hw, opts) {
    const o = opts || {};
    const ctx = num(o.contextTokens) || 8192;
    const size = num(sizeBytes);
    if (!size || size <= 0) return result('unknown', 'We don\'t know this download\'s size yet, so we can\'t say how well it will run.', null, null);
    const fileMB = size / MB;
    const needMB = fileMB * 1.15 + kvCacheMB(fileMB, ctx) + OVERHEAD_MB;
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
      if (needMB + SPARE_MB <= vram) return result('great', `Needs about ${need}; ${card} has ${gb(vram)}, so it runs fully there with room to spare. Answers will be quick.`, needMB, 'gpu');
      if (needMB <= vram) return result('good', `Needs about ${need}; it fits in ${card} (${gb(vram)}), with little room left. Close other big programs for the best speed.`, needMB, 'gpu');
      if (needMB <= vram + spareRam) return result('slow', `Needs about ${need} but ${card} has ${gb(vram)}, so part of it runs on the main processor. It works, but answers come slowly.`, needMB, 'gpu+cpu');
      return result('too-big', `Needs about ${need}, but this PC has only ${gb(vram)} on ${card} plus about ${gb(spareRam)} of free memory. Pick a smaller size.`, needMB, null);
    }
    if (needMB <= spareRam) return result('slow', `No graphics card it can use, so it runs on the main processor using about ${need} of your ${gb(ram)} memory. Answers will be slow.`, needMB, 'cpu');
    return result('too-big', `Needs about ${need}, but this PC has about ${gb(spareRam)} of memory free and no graphics card it can use. Pick a smaller size.`, needMB, null);
  }

  function canDownload(rating) { return (rating && typeof rating === 'object' ? rating.rating : rating) !== 'too-big'; }

  /**
   * pickVariant(variants, hw) -> the biggest (best-quality) variant rated great,
   * else the biggest good one, else the smallest slow one (least offloading =
   * fastest), else null. The returned object is a copy with .fit set.
   */
  function pickVariant(variants, hw, opts) {
    const list = (Array.isArray(variants) ? variants : []).filter((v) => v && num(v.sizeBytes) > 0)
      .map((v) => Object.assign({}, v, { fit: rateFit(v.sizeBytes, hw, opts) }));
    const by = (r) => list.filter((v) => v.fit.rating === r).sort((a, b) => b.sizeBytes - a.sizeBytes);
    const great = by('great'); if (great.length) return great[0];
    const good = by('good'); if (good.length) return good[0];
    const slow = by('slow'); if (slow.length) return slow[slow.length - 1];
    return null;
  }

  const api = {
    detectHardware, describeHardware, rateFit, canDownload, pickVariant, vendorOf,
    parseNvidiaSmi, parseWindowsVideo, parseRocmSmi, parseLspci, parseMacDisplays, LABELS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.LlmHardware = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
