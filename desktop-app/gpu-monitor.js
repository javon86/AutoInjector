'use strict';
/*
 * gpu-monitor.js — a tiny, best-effort read of how hard the GPU is working, so
 * the app can show "how much GPU are we using" while Stable Diffusion / local
 * models run. NVIDIA only for now (nvidia-smi), which is what the local-AI /
 * Stable Diffusion crowd runs; if it isn't present we say so and no-op rather
 * than guess. Electron-free + injectable execFile so it's unit-testable.
 */
const child_process = require('child_process');

const deps = { execFile: child_process.execFile };
function configure(patch) { if (patch && typeof patch.execFile === 'function') deps.execFile = patch.execFile; }

function _smiBin() { return process.env.NVIDIA_SMI || 'nvidia-smi'; }

// Parse one CSV line: "name, util, memUsed, memTotal" (nounits → plain numbers).
function parseLine(line) {
  const parts = String(line).split(',').map((s) => s.trim());
  if (parts.length < 4) return null;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const memUsed = num(parts[2]);
  const memTotal = num(parts[3]);
  return {
    name: parts[0] || 'GPU',
    util: num(parts[1]),           // % GPU utilization
    memUsed,                       // MB
    memTotal,                      // MB
    memPct: (memUsed != null && memTotal) ? Math.round((memUsed / memTotal) * 100) : null,
  };
}

/**
 * read() -> { available, gpus:[{name,util,memUsed,memTotal,memPct}], reason? }
 * Never throws; resolves { available:false, reason } when nvidia-smi is absent
 * or errors. Bounded by a short timeout so a hung tool can't stall the UI.
 */
function read() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const args = ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'];
    let child;
    try {
      child = deps.execFile(_smiBin(), args, { timeout: 4000, windowsHide: true }, (err, stdout) => {
        if (err) return finish({ available: false, reason: 'nvidia-smi not available' });
        const gpus = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).map(parseLine).filter(Boolean);
        if (!gpus.length) return finish({ available: false, reason: 'no GPU reported' });
        finish({ available: true, gpus });
      });
      if (child && child.on) child.on('error', () => finish({ available: false, reason: 'nvidia-smi not available' }));
    } catch (e) { finish({ available: false, reason: String((e && e.message) || e) }); }
  });
}

module.exports = { configure, read, parseLine };
