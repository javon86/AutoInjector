'use strict';
/*
 * video-errors.js — what went wrong with a video, in one plain sentence plus a fix
 * (the same idea as sd-errors.js for pictures). Turns ComfyUI's answers and the
 * low-level codes of sd-backends.request() into the contract's codes:
 *   VIDEO_NOT_SET_UP · VIDEO_MODEL_MISSING (+ model) · VIDEO_OOM · VIDEO_TIMEOUT ·
 *   VIDEO_CANCELLED · VIDEO_FAILED (first useful line from the server) · UNSUPPORTED_ON_BACKEND
 * A missing ComfyUI node (a ComfyUI too old for Wan) is VIDEO_FAILED with cause
 * NODE_MISSING and "update ComfyUI" as the fix.
 *   explainVideoError(result, { base, model, models }) → { code, message, fix, details, cause?, model? }
 * Never throws; no prompt text goes into what it returns.
 */
const sdErrors = require('./sd-errors');

const OOM_RE = /out of memory|OutOfMemory|not enough memory|DefaultCPUAllocator|Allocation on device|Tried to allocate/i;
const NODE_MISSING_RE = /(?:node|class_type)\s+["'`]?(\w+)["'`]?\s+(?:does not exist|not found)|Cannot execute because (?:a )?node (\w+) does not exist|missing_node_type/i;

// A file name the server could not find / load → the catalog model that owns it.
function modelForFile(name, models) {
  const n = String(name || '').replace(/\\/g, '/').split('/').pop();
  for (const m of models || []) if ((m.files || []).some((f) => f.name === n)) return m;
  return null;
}

function explainVideoError(result, ctx = {}) {
  try { return _explain(result || {}, ctx || {}); }
  catch (_) { return { code: 'VIDEO_FAILED', message: 'The video could not be made.', fix: '', details: '' }; }
}

function _explain(r, ctx) {
  const models = ctx.models || [];
  const text = sdErrors.serverText(r);
  const details = text.slice(0, sdErrors.DETAILS_MAX);
  const hay = [text, r.detail, r.raw, r.message].filter(Boolean).map(String).join('\n');
  const where = ctx.base ? ` at ${ctx.base}` : '';
  const out = (code, message, fix, extra) => Object.assign({ code, message, fix: fix || '', details }, extra || {});
  const e = String(r.error || r.code || '');

  if (e === 'CANCELLED' || e === 'VIDEO_CANCELLED') return out('VIDEO_CANCELLED', 'Stopped.', '');
  if (e === 'TIMEOUT' || e === 'VIDEO_TIMEOUT') return out('VIDEO_TIMEOUT', `The video wasn't finished in time${where}.`, 'Video takes long: try fewer seconds, a smaller size (832×480) or fewer steps, or raise the time limit (🎬 Video → Settings). If ComfyUI is stuck, look at its window.');
  if (e === 'REFUSED' || e === 'NO_COMFY' || e === 'VIDEO_NOT_SET_UP') return out('VIDEO_NOT_SET_UP', `ComfyUI isn't answering${where}, so there is nothing to make the video.`, 'Open 🎬 Video and press “▶ Start ComfyUI” (or “Install ComfyUI + video model” if you have none), then try again.');
  if (e === 'ECONNRESET' || e === 'EPIPE' || /socket hang up/i.test(e)) return out('VIDEO_FAILED', `ComfyUI${where} closed the connection — it may have crashed (often: out of memory).`, 'Look at ComfyUI\'s window / log, start it again, and try a smaller size or fewer seconds.');
  if (OOM_RE.test(hay)) {
    return out('VIDEO_OOM', 'Your graphics card ran out of memory making this video.',
      'Try a smaller size (832×480), fewer seconds, or the small model (Wan 2.1 1.3B). Close other programs that use the graphics card. Starting ComfyUI with --lowvram also helps.');
  }
  // A model file ComfyUI doesn't have (value_not_in_list for unet/clip/vae), or one it can't open.
  const notIn = hay.match(/(unet_name|clip_name|vae_name):\s*'([^']+)'\s*not in/) || hay.match(/(?:FileNotFoundError|No such file)[^\n]*?([\w.\-]+\.safetensors)/i);
  if (notIn) {
    const file = notIn[2] || notIn[1];
    const m = modelForFile(file, models) || (ctx.model && models.find((x) => x.id === ctx.model)) || null;
    return out('VIDEO_MODEL_MISSING', `ComfyUI doesn't have the video model file “${String(file).replace(/\\/g, '/').split('/').pop()}”${m ? ` (${m.short || m.id})` : ''}.`,
      `Download it in 🎬 Video → Setup${m ? ` (model ${m.id})` : ''}. If you just downloaded it, ComfyUI sees it straight away — check it went into the same ComfyUI that is running.`, { model: m ? m.id : (ctx.model || null) });
  }
  const nm = hay.match(NODE_MISSING_RE);
  if (nm || /invalid_prompt/.test(hay) && /does not exist/i.test(hay)) {
    const node = nm ? (nm[1] || nm[2] || '') : '';
    return out('VIDEO_FAILED', `This ComfyUI is missing the video node${node ? ` “${node}”` : ''} — it is too old for Wan video.`,
      'Update ComfyUI (portable: run update/update_comfyui.bat; Stability Matrix: the package\'s ⋮ menu → Update), start it again, then try again.', { cause: 'NODE_MISSING', node: node || undefined });
  }
  if (e === 'UNSUPPORTED_ON_BACKEND') return out('UNSUPPORTED_ON_BACKEND', r.message || 'The video server in use can\'t do that.', r.hint || r.fix || '');
  const line = text ? sdErrors.firstUsefulLine(text) : '';
  const msg = line ? `ComfyUI couldn't make the video: ${line}` : (r.message || `The video could not be made${e ? ` (${e})` : ''}.`);
  return out('VIDEO_FAILED', msg, text ? 'Look at ComfyUI\'s window for the full error. If you changed a setting, change it back and try again.' : (r.fix || ''));
}

module.exports = { explainVideoError, modelForFile, OOM_RE };
