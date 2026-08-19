'use strict';
/*
 * system-monitor.js — read-only hardware snapshot + a "what can this machine
 * run" recommendation. Uses `systeminformation` (the one runtime dependency).
 *
 * Everything is best-effort and defensive: it never throws into the caller, and
 * a metric it can't read comes back as null (e.g. CPU temperature is often
 * unavailable without extra drivers; GPU temperature is reliable on NVIDIA).
 */
const si = require('systeminformation');

function n1(x) { return x == null || isNaN(x) ? null : Math.round(x * 10) / 10; }

/** A snapshot of the machine's CPU / RAM / GPU(s) / OS / temperatures. */
async function snapshot() {
  const out = { cpu: {}, mem: {}, gpus: [], os: {}, temps: {}, error: null };
  try {
    const [cpu, mem, graphics, osInfo, temp] = await Promise.all([
      si.cpu(), si.mem(), si.graphics(), si.osInfo(),
      si.cpuTemperature().catch(() => ({})),
    ]);
    out.cpu = {
      brand: `${cpu.manufacturer || ''} ${cpu.brand || ''}`.trim(),
      cores: cpu.cores || null,
      physicalCores: cpu.physicalCores || null,
      speedGHz: n1(cpu.speed),
    };
    const totalGB = n1((mem.total || 0) / 1e9);
    const availGB = n1((mem.available != null ? mem.available : mem.free || 0) / 1e9);
    out.mem = { totalGB, freeGB: availGB, usedGB: totalGB != null && availGB != null ? n1(totalGB - availGB) : null };
    out.gpus = (graphics.controllers || []).map((g) => ({
      model: g.model || g.name || 'GPU',
      vendor: g.vendor || null,
      vramMB: g.vram || null,
      vramGB: g.vram ? n1(g.vram / 1024) : null,
      tempC: g.temperatureGpu != null && g.temperatureGpu > 0 ? n1(g.temperatureGpu) : null,
      utilizationPct: g.utilizationGpu != null ? n1(g.utilizationGpu) : null,
      vramUsedMB: g.memoryUsed != null ? g.memoryUsed : null,
    }));
    out.os = { platform: osInfo.platform, distro: osInfo.distro, release: osInfo.release, arch: osInfo.arch };
    out.temps = { cpuMainC: temp && temp.main != null && temp.main > 0 ? n1(temp.main) : null };
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

// VRAM (GB) -> local-model and Stable-Diffusion capability tiers.
function _llmTier(vram, ram) {
  if (vram >= 24) return { tier: 'Large', detail: 'Up to ~70B quantized, or 13B–34B comfortably.' };
  if (vram >= 16) return { tier: 'High', detail: '13B–34B quantized comfortably; 7B is fast.' };
  if (vram >= 12) return { tier: 'Good', detail: '13B quantized comfortably; great for the Local Supervisor.' };
  if (vram >= 8) return { tier: 'Moderate', detail: '7B–13B quantized (Q4). Solid for the Supervisor/Manager.' };
  if (vram >= 6) return { tier: 'Entry', detail: '7B quantized (Q4). Keep contexts modest.' };
  if (vram >= 4) return { tier: 'Low', detail: '3B–7B small/quantized; expect it to be slower.' };
  if (ram >= 16) return { tier: 'CPU-only', detail: 'No usable GPU — run small 1–3B models on CPU (slow), or use a cloud/RunPod endpoint.' };
  return { tier: 'Cloud recommended', detail: 'Limited local hardware — use a cloud/RunPod model endpoint.' };
}
function _sdTier(vram) {
  if (vram >= 12) return { tier: 'SDXL / Flux', detail: 'SDXL comfortably; Flux with care.' };
  if (vram >= 8) return { tier: 'SDXL', detail: 'SDXL OK; SD 1.5 is fast.' };
  if (vram >= 6) return { tier: 'SD 1.5 (+SDXL on Forge)', detail: 'SD 1.5 comfortably; SDXL via Forge low-VRAM mode.' };
  if (vram >= 4) return { tier: 'SD 1.5', detail: 'SD 1.5 — use Forge for low VRAM.' };
  return { tier: 'SD 1.5 (Forge/CPU) or cloud', detail: 'Little/no GPU VRAM — SD 1.5 on Forge/CPU (slow), or a cloud/RunPod endpoint.' };
}

/**
 * Turn a snapshot into plain recommendations for which local model and which
 * Stable Diffusion setup this machine can handle.
 */
function recommend(snap) {
  snap = snap || {};
  const vram = Math.max(0, ...(snap.gpus || []).map((g) => g.vramGB || 0), 0);
  const ram = (snap.mem && snap.mem.totalGB) || 0;
  const llm = _llmTier(vram, ram);
  const sd = _sdTier(vram);
  const gpuName = (snap.gpus && snap.gpus[0] && snap.gpus[0].model) || 'no dedicated GPU';
  return {
    vramGB: vram || null,
    ramGB: ram || null,
    gpu: gpuName,
    llm, sd,
    summary: `${gpuName}${vram ? ` (${vram} GB VRAM)` : ''}, ${ram} GB RAM → local models: ${llm.tier}; Stable Diffusion: ${sd.tier}.`,
  };
}

/** Snapshot + recommendation together (what the UI asks for). */
async function report() {
  const snap = await snapshot();
  return { snapshot: snap, recommendation: recommend(snap) };
}

module.exports = { snapshot, recommend, report };
