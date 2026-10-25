'use strict';
/*
 * sd-images.js — save generated pictures so any one can be made again.
 *
 * Each PNG goes into the output images/ folder with its settings recorded twice:
 *   • inside the PNG as text chunks — "parameters" in the A1111 infotext format
 *     (so Forge/A1111's PNG Info tab and Civitai read it) and "autoinjector" (JSON);
 *   • next to it as <name>.json (fast for the gallery, easy to read).
 * listGallery() reads those sidecars back, newest first. Electron-free.
 */
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- PNG chunks
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function isPng(buf) { return Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 8).equals(SIG); }

// Insert tEXt/iTXt chunks before IEND. Non-PNG input is returned unchanged.
function addPngText(buf, entries) {
  if (!isPng(buf)) return buf;
  const chunks = [];
  for (const [key, val] of Object.entries(entries || {})) {
    if (val == null) continue;
    const text = String(val);
    // iTXt (UTF-8) so prompts with accents / Yorùbá tone marks survive.
    const data = Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(text, 'utf8')]);
    const type = Buffer.from('iTXt', 'latin1');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
    chunks.push(Buffer.concat([len, type, data, crc]));
  }
  // Find IEND.
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'IEND') return Buffer.concat([buf.subarray(0, off), ...chunks, buf.subarray(off)]);
    off += 12 + len;
  }
  return buf;
}
// Read tEXt / iTXt chunks → { key: text }.
function readPngText(buf) {
  const out = {};
  if (!isPng(buf)) return out;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'tEXt') { const z = data.indexOf(0); if (z > 0) out[data.toString('latin1', 0, z)] = data.toString('latin1', z + 1); }
    else if (type === 'iTXt') {
      const z = data.indexOf(0);
      if (z > 0) {
        const key = data.toString('latin1', 0, z);
        const comp = data[z + 1];
        let p = z + 3; // skip compression flag + method
        const l1 = data.indexOf(0, p); p = l1 + 1; // language tag
        const l2 = data.indexOf(0, p); p = l2 + 1; // translated keyword
        if (!comp && l1 >= 0 && l2 >= 0) out[key] = data.toString('utf8', p);
      }
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return out;
}

// A1111 "infotext" — what PNG Info shows and what Civitai parses.
function infotext(rec) {
  const r = rec || {};
  const lines = [String(r.prompt || '')];
  if (r.negativePrompt) lines.push(`Negative prompt: ${r.negativePrompt}`);
  const kv = [];
  if (r.steps) kv.push(`Steps: ${r.steps}`);
  if (r.sampler) kv.push(`Sampler: ${r.sampler}`);
  if (r.scheduler) kv.push(`Schedule type: ${r.scheduler}`);
  if (r.cfgScale) kv.push(`CFG scale: ${r.cfgScale}`);
  if (r.seed != null) kv.push(`Seed: ${r.seed}`);
  if (r.width && r.height) kv.push(`Size: ${r.width}x${r.height}`);
  if (r.checkpoint) kv.push(`Model: ${String(r.checkpoint).replace(/\s*\[[0-9a-f]+\]$/i, '')}`);
  if (r.vae && !/^(automatic|none)$/i.test(r.vae)) kv.push(`VAE: ${r.vae}`);
  if (Array.isArray(r.loras) && r.loras.length) kv.push(`Lora: "${r.loras.map((l) => `${l.name}:${l.weight}`).join(', ')}"`);
  if (r.backend) kv.push(`Backend: ${r.label || r.backend}`);
  lines.push(kv.join(', '));
  return lines.join('\n');
}

function _stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function _unique(dir, name) {
  const ext = path.extname(name); const stem = path.basename(name, ext);
  let p = path.join(dir, name), i = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${stem}-${i++}${ext}`);
  return p;
}

// Save every image of one generation. record = the settings actually used.
// → [{ path, json, sha256, record }]
function saveGeneration(dir, imagesB64, record, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const crypto = require('crypto');
  const stamp = _stamp();
  const out = [];
  const list = Array.isArray(imagesB64) ? imagesB64 : [imagesB64];
  const seeds = Array.isArray(record && record.seeds) ? record.seeds : null;
  for (let i = 0; i < list.length; i++) {
    const rec = Object.assign({}, record, { index: i, createdAt: new Date().toISOString(), app: 'AutoInjector' });
    if (seeds && seeds[i] != null) rec.seed = seeds[i];
    else if (i > 0 && Number.isFinite(Number(rec.seed)) && Number(rec.seed) >= 0 && rec.backend === 'a1111') rec.seed = Number(rec.seed) + i; // A1111 increments the seed per image
    delete rec.seeds;
    const raw = Buffer.from(String(list[i] || ''), 'base64');
    if (!raw.length) continue;
    const already = readPngText(raw);
    const entries = { autoinjector: JSON.stringify(rec) };
    if (!already.parameters) entries.parameters = infotext(rec);
    const buf = addPngText(raw, entries);
    const name = `${opts.prefix || 'sd'}-${stamp}${list.length > 1 ? `-${i + 1}` : ''}.png`;
    const file = _unique(dir, name);
    fs.writeFileSync(file, buf);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    rec.file = path.basename(file); rec.sha256 = sha256;
    const json = file.replace(/\.png$/i, '.json');
    try { fs.writeFileSync(json, JSON.stringify(rec, null, 1)); } catch { /* the PNG still carries the settings */ }
    out.push({ path: file, json, sha256, record: rec });
  }
  return out;
}

// The gallery: newest first, from the sidecars (falls back to the PNG chunk).
function listGallery(dir, opts = {}) {
  const limit = opts.limit || 60;
  let names; try { names = fs.readdirSync(dir); } catch { return []; }
  const pngs = names.filter((n) => /\.png$/i.test(n)).map((n) => { const p = path.join(dir, n); let t = 0; try { t = fs.statSync(p).mtimeMs; } catch {} return { n, p, t }; })
    .sort((a, b) => b.t - a.t).slice(0, limit);
  const out = [];
  for (const it of pngs) {
    let rec = null;
    const j = it.p.replace(/\.png$/i, '.json');
    try { rec = JSON.parse(fs.readFileSync(j, 'utf8')); } catch {
      if (opts.readChunks !== false) { try { const fd = fs.readFileSync(it.p); const tx = readPngText(fd); if (tx.autoinjector) rec = JSON.parse(tx.autoinjector); else if (tx.parameters) rec = { prompt: tx.parameters.split('\n')[0], infotext: tx.parameters }; } catch {} }
    }
    out.push({ path: it.p, name: it.n, mtime: Math.round(it.t), record: rec });
  }
  return out;
}

// Settings to remake an image (from its sidecar or embedded chunk).
function readRecord(file) {
  try { return JSON.parse(fs.readFileSync(String(file).replace(/\.png$/i, '.json'), 'utf8')); } catch {}
  try { const tx = readPngText(fs.readFileSync(file)); if (tx.autoinjector) return JSON.parse(tx.autoinjector); } catch {}
  return null;
}

module.exports = { crc32, addPngText, readPngText, infotext, saveGeneration, listGallery, readRecord, isPng };
