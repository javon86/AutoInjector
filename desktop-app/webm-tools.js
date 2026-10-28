'use strict';
/*
 * webm-tools.js — two small, dependency-free WebM (Matroska/EBML) helpers for the 🎞 trailer join:
 *   setWebmDuration(buf, ms) → a new Buffer whose Segment › Info carries a Duration. Chromium's
 *     MediaRecorder writes live WebM without one, so players show "∞" and cannot seek; this adds it.
 *   probeWebm(buf) → { ok, durationMs (the header's, or null), lastMs (the last frame's time, read from
 *     the clusters), timecodeScale, tracks, clusters, blocks } — the real length, read from the frames.
 * Only what MediaRecorder writes is handled (EBML header, one Segment with Info, Tracks and Clusters; sizes
 * known or "unknown"). Never throws: a file it cannot read gives { ok:false, error }.
 */

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966, Duration: 0x4489, TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1,
  Cues: 0x1c53bb6b, SeekHead: 0x114d9b74, Tags: 0x1254c367, Chapters: 0x1043a770, Attachments: 0x1941a469, Void: 0xec,
};
// Elements that end an unknown-size Cluster when they appear (the next Cluster, or a Segment-level element).
const SEGMENT_LEVEL = new Set([ID.Cluster, ID.Cues, ID.SeekHead, ID.Tags, ID.Chapters, ID.Attachments, ID.Info, ID.Tracks]);

// An element ID at off: { id, len } (the marker bits are part of the ID) or null.
function readId(buf, off) {
  if (off >= buf.length) return null;
  const b = buf[off];
  let len = 0;
  if (b & 0x80) len = 1; else if (b & 0x40) len = 2; else if (b & 0x20) len = 3; else if (b & 0x10) len = 4; else return null;
  if (off + len > buf.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[off + i];
  return { id, len };
}
// A size vint at off: { size (null = unknown), len } or null.
function readSize(buf, off) {
  if (off >= buf.length) return null;
  const b = buf[off];
  let len = 1;
  while (len <= 8 && !(b & (0x80 >> (len - 1)))) len++;
  if (len > 8 || off + len > buf.length) return null;
  let v = b & (0xff >> len);
  let allOnes = v === (0xff >> len);
  for (let i = 1; i < len; i++) { v = v * 256 + buf[off + i]; if (buf[off + i] !== 0xff) allOnes = false; }
  return { size: allOnes ? null : v, len };
}
function readUInt(buf, off, len) { let v = 0; for (let i = 0; i < len; i++) v = v * 256 + buf[off + i]; return v; }
function readFloat(buf, off, len) { return len === 4 ? buf.readFloatBE(off) : len === 8 ? buf.readDoubleBE(off) : 0; }
// One element header at off: { id, idLen, size, sizeLen, dataStart, dataEnd (Infinity when unknown) } or null.
function header(buf, off) {
  const i = readId(buf, off); if (!i) return null;
  const s = readSize(buf, off + i.len); if (!s) return null;
  const dataStart = off + i.len + s.len;
  return { id: i.id, idLen: i.len, size: s.size, sizeLen: s.len, dataStart, dataEnd: s.size == null ? Infinity : dataStart + s.size };
}
// The size as an 8-byte vint (0x01 + 7 bytes).
function size8(n) { const b = Buffer.alloc(8); b[0] = 0x01; let v = n; for (let i = 7; i >= 1; i--) { b[i] = v % 256; v = Math.floor(v / 256); } return b; }
// The size re-encoded in exactly `len` bytes (for a known Segment size that grows).
function sizeN(n, len) { const b = Buffer.alloc(len); let v = n; for (let i = len - 1; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256); } b[0] |= (0x80 >> (len - 1)); return b; }

function findSegment(buf) {
  let off = 0;
  const h0 = header(buf, 0);
  if (!h0 || h0.id !== ID.EBML || h0.size == null) return null;
  off = h0.dataEnd;
  while (off < buf.length) {
    const h = header(buf, off); if (!h) return null;
    if (h.id === ID.Segment) return Object.assign({ start: off }, h);
    if (h.size == null) return null;
    off = h.dataEnd;
  }
  return null;
}

/** The WebM with Segment › Info › Duration set to `ms` (TimecodeScale units). Returns the input when it can't. */
function setWebmDuration(input, ms) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  try {
    const seg = findSegment(buf); if (!seg) return buf;
    const segEnd = Math.min(seg.dataEnd, buf.length);
    let off = seg.dataStart;
    while (off < segEnd) {
      const h = header(buf, off); if (!h) return buf;
      if (h.id === ID.Info) {
        if (h.size == null) return buf;
        let scale = 1000000;
        let p = h.dataStart; let durAt = null;
        while (p < h.dataEnd) {
          const c = header(buf, p); if (!c || c.size == null) return buf;
          if (c.id === ID.TimecodeScale) scale = readUInt(buf, c.dataStart, c.size) || 1000000;
          if (c.id === ID.Duration) durAt = c;
          p = c.dataEnd;
        }
        const value = (Number(ms) * 1000000) / scale;
        if (durAt) { // already there: overwrite in place
          const out = Buffer.from(buf);
          if (durAt.size === 4) out.writeFloatBE(value, durAt.dataStart); else if (durAt.size === 8) out.writeDoubleBE(value, durAt.dataStart); else return buf;
          return out;
        }
        const dur = Buffer.alloc(11); dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88; dur.writeDoubleBE(value, 3);
        const children = buf.slice(h.dataStart, h.dataEnd);
        const idBytes = buf.slice(off, off + h.idLen);
        const newInfo = Buffer.concat([idBytes, size8(children.length + dur.length), children, dur]);
        const delta = newInfo.length - (h.dataEnd - off);
        let segHead = buf.slice(seg.start, seg.dataStart);
        if (seg.size != null) segHead = Buffer.concat([buf.slice(seg.start, seg.start + seg.idLen), sizeN(seg.size + delta, seg.sizeLen)]);
        return Buffer.concat([buf.slice(0, seg.start), segHead, buf.slice(seg.dataStart, off), newInfo, buf.slice(h.dataEnd)]);
      }
      if (h.id === ID.Cluster || h.size == null) return buf; // Info always comes before the clusters
      off = h.dataEnd;
    }
  } catch (_) { /* fall through */ }
  return buf;
}

/** What is in a WebM: header duration, the last frame's time, tracks, cluster/block counts. Never throws. */
function probeWebm(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const out = { ok: false, durationMs: null, lastMs: 0, timecodeScale: 1000000, tracks: [], clusters: 0, blocks: 0, keyframes: 0 };
  try {
    const seg = findSegment(buf);
    if (!seg) return Object.assign(out, { error: 'NOT_WEBM' });
    const segEnd = Math.min(seg.dataEnd, buf.length);
    let off = seg.dataStart;
    let rawDuration = null;
    const blockAt = (clusterTc, p, end) => {
      const tn = readSize(buf, p); if (!tn || p + tn.len + 3 > end) return;
      const rel = buf.readInt16BE(p + tn.len);
      const flags = buf[p + tn.len + 2];
      const t = clusterTc + rel;
      out.blocks++;
      if (flags & 0x80) out.keyframes++;
      if (t > out.lastMs) out.lastMs = t;
    };
    while (off < segEnd) {
      const h = header(buf, off); if (!h) break;
      if (h.id === ID.Info && h.size != null) {
        for (let p = h.dataStart; p < h.dataEnd;) {
          const c = header(buf, p); if (!c || c.size == null) break;
          if (c.id === ID.TimecodeScale) out.timecodeScale = readUInt(buf, c.dataStart, c.size) || 1000000;
          if (c.id === ID.Duration) rawDuration = readFloat(buf, c.dataStart, c.size);
          p = c.dataEnd;
        }
      } else if (h.id === ID.Tracks && h.size != null) {
        for (let p = h.dataStart; p < h.dataEnd;) {
          const t = header(buf, p); if (!t || t.size == null) break;
          if (t.id === ID.TrackEntry) {
            const tr = {};
            for (let q = t.dataStart; q < t.dataEnd;) {
              const c = header(buf, q); if (!c || c.size == null) break;
              if (c.id === ID.TrackNumber) tr.number = readUInt(buf, c.dataStart, c.size);
              if (c.id === ID.TrackType) tr.type = readUInt(buf, c.dataStart, c.size) === 1 ? 'video' : readUInt(buf, c.dataStart, c.size) === 2 ? 'audio' : 'other';
              if (c.id === ID.CodecID) tr.codec = buf.slice(c.dataStart, c.dataEnd).toString('latin1');
              q = c.dataEnd;
            }
            out.tracks.push(tr);
          }
          p = t.dataEnd;
        }
      } else if (h.id === ID.Cluster) {
        out.clusters++;
        const end = Math.min(h.dataEnd, buf.length);
        let tc = 0; let p = h.dataStart;
        while (p < end) {
          const c = header(buf, p); if (!c) { p = end; break; }
          if (h.size == null && SEGMENT_LEVEL.has(c.id)) break; // an unknown-size cluster ends here
          const cEnd = Math.min(c.dataEnd, buf.length);
          if (c.id === ID.Timecode) tc = readUInt(buf, c.dataStart, c.size);
          else if (c.id === ID.SimpleBlock) blockAt(tc, c.dataStart, cEnd);
          else if (c.id === ID.BlockGroup) {
            for (let q = c.dataStart; q < cEnd;) { const b = header(buf, q); if (!b || b.size == null) break; if (b.id === ID.Block) blockAt(tc, b.dataStart, Math.min(b.dataEnd, cEnd)); q = b.dataEnd; }
          }
          if (c.size == null) { p = end; break; }
          p = c.dataEnd;
        }
        off = h.size == null ? p : h.dataEnd;
        continue;
      }
      if (h.size == null) break;
      off = h.dataEnd;
    }
    const k = out.timecodeScale / 1000000;
    out.lastMs = Math.round(out.lastMs * k);
    out.durationMs = rawDuration == null ? null : Math.round(rawDuration * k);
    out.ok = out.blocks > 0;
    if (!out.ok) out.error = 'NO_FRAMES';
  } catch (e) { out.ok = false; out.error = String((e && e.message) || e); }
  return out;
}

module.exports = { setWebmDuration, probeWebm, ID };
