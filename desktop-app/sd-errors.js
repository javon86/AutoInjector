'use strict';
/*
 * sd-errors.js — read what the Stable Diffusion app said when a picture failed
 * and turn it into ONE known cause, a plain-English message and a fix.
 *
 * The real-world case this was built for: A1111 answered every Generate with
 *   HTTP 500 {"error":"RuntimeError","detail":"","body":"","errors":"Error(s) in
 *   loading state_dict for AutoencoderKL: Missing key(s) in state_dict:
 *   \"encoder.conv_in.weight\", …"}
 * after the user picked a VAE file that isn't a full VAE. The Images tab only
 * said "HTTP_500", so they clicked Generate fifteen times. Now it says which
 * VAE can't be loaded and offers "Use Automatic VAE and retry".
 *
 * explainSdError(result, ctx) understands:
 *   • A1111 / Forge / SD.Next error bodies {error, detail, body, errors}
 *     (and FastAPI's {detail:[…]}), plain-text / HTML 500 pages;
 *   • ComfyUI's /prompt 400 {error, node_errors} and /history execution_error;
 *   • the low-level codes of sd-backends.request() (REFUSED …).
 * → { known, code, message, fix, actions:[{id,label}], details }
 *   code: VAE_LOAD_FAILED | OOM | NAN | CHECKPOINT_LOAD_FAILED | LORA_MISSING |
 *         EMBEDDING_MISSING | CONNECTION_REFUSED | SD_ERROR | <the result's own code>
 *   details: the first ~600 chars of what the server said (for a "details" box).
 * ctx: { vae, checkpoint, base, backend, vaeInfo } — names for the message;
 *   vaeInfo is the library's header check of that VAE file (sd-library vaeCheck).
 *
 * Never throws. No prompt text goes into anything this returns.
 * Electron-free and dependency-free (sd-backends requires it, not the other way).
 */
const DETAILS_MAX = 600;

function _s(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// What the server said, decoded to readable text (not escaped JSON).
function serverText(r) {
  if (!r || typeof r !== 'object') return typeof r === 'string' ? r : '';
  let j = r.json && typeof r.json === 'object' ? r.json : null;
  const raw = typeof r.raw === 'string' ? r.raw : (typeof r.text === 'string' ? r.text : '');
  if (!j && raw && /^\s*[[{]/.test(raw)) { try { j = JSON.parse(raw); } catch { j = null; } }
  const parts = [];
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    // A1111: {error:"RuntimeError", errors:"Error(s) in loading …"} → "RuntimeError: Error(s) in loading …"
    const head = typeof j.error === 'string' ? j.error : '';
    const body = [j.errors, j.detail, j.body, j.message, j.msg].map((v) => (Array.isArray(v) ? v.map((x) => (x && (x.msg || x.message)) || _s(x)).join('; ') : (v && typeof v === 'object' ? (v.message || v.msg || _s(v)) : v)))
      .filter((v) => v != null && String(v).trim()).map(String);
    if (head || body.length) parts.push([head, ...body].filter(Boolean).join(': '));
    // ComfyUI: {error:{type,message,details}, node_errors:{id:{class_type, errors:[…]}}}
    if (j.error && typeof j.error === 'object') parts.push([j.error.type, j.error.message, j.error.details].filter(Boolean).join(': '));
    if (j.node_errors && typeof j.node_errors === 'object') {
      for (const [id, ne] of Object.entries(j.node_errors)) for (const e of (ne && ne.errors) || []) parts.push(`${(ne && ne.class_type) || 'node'} #${id}: ${[e.type, e.message, e.details].filter(Boolean).join(' — ')}`);
    }
    // ComfyUI history execution_error: {node_type, exception_type, exception_message}
    if (j.exception_message || j.node_type) parts.push(`${j.node_type || 'node'}: ${[j.exception_type, j.exception_message].filter(Boolean).join(': ')}`);
  } else if (raw) parts.push(raw.replace(/<[^>]+>/g, ' '));
  if (!parts.length && r.detail) parts.push(String(r.detail));
  return parts.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// The first line worth showing: the Python exception line, else the first real line.
function firstUsefulLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/Traceback \(most recent call last\)/.test(l) && !/^File "/.test(l) && !/^\^+$/.test(l));
  // Python prints the exception LAST, under the traceback.
  const exc = [...lines].reverse().find((l) => /\b\w*(Error|Exception)\b\s*:/.test(l));
  return String(exc || lines[0] || '').slice(0, 220);
}

const _q = (s) => `“${String(s).replace(/\s*\[[0-9a-f]{6,}\]$/i, '')}”`;
const AUTO_VAE = (vae) => !vae || /^(automatic|none|auto)$/i.test(String(vae).trim());
const VAE_ACTION = { id: 'vae-automatic', label: 'Use Automatic VAE and retry' };

// One table of known causes; the first match wins (order matters: the VAE
// state_dict error is a "loading state_dict" error too, so it comes first).
const RULES = [
  { code: 'VAE_LOAD_FAILED', test: (h) => /AutoencoderKL|first_stage_model/i.test(h) && /state_dict|missing key|unexpected key|size mismatch/i.test(h) },
  { code: 'OOM', test: (h) => /out of memory|OutOfMemory|not enough memory|DefaultCPUAllocator|allocation on device|Tried to allocate/i.test(h) },
  { code: 'NAN', test: (h) => /tensor with all NaNs|NansException|all NaNs|produced NaN/i.test(h) },
  { code: 'VAE_LOAD_FAILED', test: (h) => /VAELoader|vae_name/.test(h) || (/\bvae\b/i.test(h) && /state_dict|deserializ|SafetensorError|HeaderTooLarge|can't load|cannot load|failed to load|not found/i.test(h)) },
  { code: 'LORA_MISSING', test: (h) => /couldn't find (?:lora|network)|LoraLoader|lora_name|\blora\b.{0,40}(?:not found|missing|doesn't exist)/i.test(h) },
  { code: 'EMBEDDING_MISSING', test: (h) => /(?:embedding|textual inversion).{0,40}(?:not found|missing|couldn't|doesn't exist)/i.test(h) },
  { code: 'CHECKPOINT_LOAD_FAILED', test: (h) => /state_dict for (?:LatentDiffusion|DiffusionEngine|UNet|SDXL|BaseModel|DiffusionWrapper)|Error loading (?:model|checkpoint)|failed to load (?:model|checkpoint)|SafetensorError|Error while deserializing header|HeaderTooLarge|CheckpointLoaderSimple|ckpt_name|checkpoint.{0,40}not found|No checkpoints found|model failed to load|could not (?:detect|load) model/i.test(h) },
];

function _name(h, re) { const m = String(h || '').match(re); return m ? m[1].replace(/["'\\]+/g, '').trim() : ''; }

function explainSdError(result, ctx = {}) {
  try { return _explain(result || {}, ctx || {}); }
  catch (e) { return { known: false, code: 'SD_ERROR', message: 'Image generation failed.', fix: '', actions: [], details: '' }; }
}

function _explain(r, ctx) {
  const text = serverText(r);
  const details = text.slice(0, DETAILS_MAX);
  const hay = [text, r.detail, r.raw, r.error === 'REFUSED' ? '' : r.error].filter(Boolean).map(String).join('\n');
  const where = ctx.base ? ` at ${ctx.base}` : '';
  const out = (code, message, fix, actions) => ({ known: true, code, message, fix: fix || '', actions: actions || [], details });

  if (r.error === 'REFUSED' || /ECONNREFUSED|connection refused/i.test(String(r.error || ''))) {
    return out('CONNECTION_REFUSED', `Nothing is answering${where} — your Stable Diffusion app isn't running (or is on another port).`,
      'Start it (Stability Matrix → Launch, or webui-user.bat / ComfyUI), wait until it says it is running, then press Connect and try again.');
  }
  const rule = text || r.detail ? RULES.find((x) => x.test(hay)) : null;
  if (rule) {
    const code = rule.code;
    // ComfyUI "value_not_in_list": the file is missing (not broken) — sd-backends already
    // wrote "ComfyUI doesn't have “x” … press Refresh"; keep that sentence, add code + fix.
    if (/value_not_in_list|' not in \[/.test(hay) && r.message && code !== 'OOM' && code !== 'NAN') {
      const fixes = { VAE_LOAD_FAILED: 'Set VAE to Automatic, or put the file into ComfyUI\'s models/vae folder and press Refresh.', LORA_MISSING: 'Put the file into the Lora folder and press Refresh, or remove that LoRA.', CHECKPOINT_LOAD_FAILED: 'Pick a checkpoint from the list (press Refresh first).' };
      return out(code, r.message, fixes[code] || 'Press Refresh and pick one from the list.', code === 'VAE_LOAD_FAILED' ? [VAE_ACTION] : []);
    }
    if (code === 'VAE_LOAD_FAILED') {
      const vae = !AUTO_VAE(ctx.vae) ? ctx.vae : _name(hay, /vae_name:\s*'([^']+)'/);
      const who = vae ? `The VAE you picked (${_q(vae)})` : 'The VAE your SD app is set to';
      const lib = ctx.vaeInfo && ctx.vaeInfo.problem ? ` AutoInjector checked the file: ${ctx.vaeInfo.problem}.` : '';
      return out(code, `${who} can't be loaded. It isn't a full VAE or doesn't match this model.${lib}`,
        'Set VAE to Automatic (or None). If you want a VAE, use a full one made for this model (e.g. vae-ft-mse-840000 for SD1.5, sdxl_vae for SDXL) — not a TAESD / decoder-only file or a LoRA.', [VAE_ACTION]);
    }
    if (code === 'OOM') {
      return out(code, 'Your graphics card ran out of memory making this picture.',
        'Try a smaller size (512×512 for SD1.5, 1024×1024 for SDXL), batch size 1 and batch count 1, hires fix off, or fewer LoRAs / ControlNet units. In A1111 add --medvram (or --lowvram) to the launch options (Forge manages memory by itself). Close other programs that use the GPU.');
    }
    if (code === 'NAN') {
      const unet = /in Unet/i.test(hay);
      return out(code, `Stable Diffusion made an empty (all-NaN) picture${unet ? ' in the model (UNet)' : ' in the VAE'}.`,
        unet ? 'Add --no-half (or --upcast-sampling) to the launch options, or try another checkpoint.' : 'Pick another VAE (or Automatic), or add --no-half-vae to the launch options (Stability Matrix: Launch Options; standalone: COMMANDLINE_ARGS in webui-user.bat).',
        !unet && !AUTO_VAE(ctx.vae) ? [VAE_ACTION] : []);
    }
    if (code === 'LORA_MISSING') {
      const nm = _name(hay, /couldn't find (?:lora|network) with name ([^\s"',)]+)/i) || _name(hay, /lora_name:\s*'([^']+)'/i);
      return out(code, `Your SD app can't find the LoRA ${nm ? _q(nm) : '(one of the chosen LoRAs)'}.`,
        'Put the file into the Lora folder (Stability Matrix: Data/Models/Lora), press Refresh, or remove that LoRA chip / <lora:…> tag.');
    }
    if (code === 'EMBEDDING_MISSING') {
      return out(code, 'Your SD app can\'t find an embedding used in the prompt.', 'Put the file into the embeddings folder (Stability Matrix: Data/Models/Embeddings) and press Refresh, or remove it from the prompt.');
    }
    if (code === 'CHECKPOINT_LOAD_FAILED') {
      const ck = ctx.checkpoint || _name(hay, /ckpt_name:\s*'([^']+)'/);
      return out(code, `The checkpoint ${ck ? `(${_q(ck)}) ` : ''}couldn't be loaded.`,
        'The file may be broken or only half downloaded, not a checkpoint at all (a LoRA or VAE in the checkpoint folder), or a type this app can\'t load (Flux / SD3 need Forge or ComfyUI). Pick another checkpoint and press Refresh, or download it again.');
    }
  }
  // Unknown cause: keep the caller's own message when it has one, else the first useful server line.
  const line = text ? firstUsefulLine(text) : '';
  const message = r.message || (line ? `The image server reported an error${r.status ? ` (${r.status})` : ''}: ${line}` : '');
  return { known: false, code: r.code || (text ? 'SD_ERROR' : r.error) || 'FAILED', message, fix: r.hint || r.fix || (text ? 'Look at your SD app\'s window for the full error. If you just changed the checkpoint, VAE or an extension setting, change it back and try again.' : ''), actions: [], details };
}

// Fold the explanation into a failed result (keeps its own `error`, adds code /
// message / fix / actions / serverError). An unknown cause keeps the result's own
// message; plain validation answers (INVALID_PARAM, BUSY, …) are left alone.
function annotate(result, ctx) {
  if (!result || result.ok) return result;
  const ex = explainSdError(result, ctx);
  if (ex.details) result.serverError = ex.details;
  if (!ex.known) {
    if (!result.code && ex.details) result.code = ex.code;
    if (!result.message && ex.message) result.message = ex.message;
    if (!result.fix && ex.details && ex.fix) result.fix = ex.fix;
    return result;
  }
  result.code = ex.code;
  result.message = ex.message;
  result.fix = ex.fix;
  if (ex.actions.length) result.actions = ex.actions;
  return result;
}

module.exports = { explainSdError, annotate, serverText, firstUsefulLine, DETAILS_MAX, VAE_ACTION };
