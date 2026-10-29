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
  // Forge / A1111 with NO checkpoint loaded (PC test: Forge "connected", its Checkpoint list empty, every picture
  // failed "Failed to find available model"). Before the checkpoint rules: it is not a broken file, there is none.
  { code: 'NO_MODEL', test: (h) => /Failed to find available model|You do not have any model|No checkpoints found|no checkpoint(?:s)? (?:is |was )?(?:loaded|available|found)|model_data\.sd_model is None|sd_model is None/i.test(h) },
  { code: 'VAE_LOAD_FAILED', test: (h) => /AutoencoderKL|first_stage_model/i.test(h) && /state_dict|missing key|unexpected key|size mismatch/i.test(h) },
  { code: 'OOM', test: (h) => /out of memory|OutOfMemory|not enough memory|DefaultCPUAllocator|allocation on device|Tried to allocate/i.test(h) },
  { code: 'NAN', test: (h) => /tensor with all NaNs|NansException|all NaNs|produced NaN/i.test(h) },
  { code: 'VAE_LOAD_FAILED', test: (h) => /VAELoader|vae_name/.test(h) || (/\bvae\b/i.test(h) && /state_dict|deserializ|SafetensorError|HeaderTooLarge|can't load|cannot load|failed to load|not found/i.test(h)) },
  { code: 'LORA_MISSING', test: (h) => /couldn't find (?:lora|network)|LoraLoader|lora_name|\blora\b.{0,40}(?:not found|missing|doesn't exist)/i.test(h) },
  { code: 'EMBEDDING_MISSING', test: (h) => /(?:embedding|textual inversion).{0,40}(?:not found|missing|couldn't|doesn't exist)/i.test(h) },
  { code: 'CHECKPOINT_LOAD_FAILED', test: (h) => /state_dict for (?:LatentDiffusion|DiffusionEngine|UNet|SDXL|BaseModel|DiffusionWrapper)|Error loading (?:model|checkpoint)|failed to load (?:model|checkpoint)|SafetensorError|Error while deserializing header|HeaderTooLarge|CheckpointLoaderSimple|ckpt_name|checkpoint.{0,40}not found|No checkpoints found|model failed to load|could not (?:detect|load) model/i.test(h) },
];

// "Connected, but Forge has no picture model loaded" — in plain words, with what to do (ctx.modelHelp: the
// folders on this PC that hold models, found by the library — sd-studio.js modelHelp()).
const NO_MODEL_MESSAGE = (ctx) => `${(ctx && ctx.label) || 'Your Stable Diffusion app'} is running, but it has no picture model (checkpoint) loaded, so it can't make pictures. (It said: “Failed to find available model”.)`;
function NO_MODEL_FIX(ctx) {
  const h = ctx && ctx.modelHelp;
  if (h && h.fix) return h.fix;
  return 'Put a model file (.safetensors) into its checkpoint folder (Stability Matrix: Data/Models/StableDiffusion), or start it with --ckpt-dir "<the folder with your models>" (Stability Matrix: the package\'s ⚙ Launch Options), then press Refresh on the Images tab. No model yet? Images → Setup → download a starter model.';
}
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
    if (code === 'NO_MODEL') return out(code, NO_MODEL_MESSAGE(ctx), NO_MODEL_FIX(ctx));
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

// ------------------------------------------------------------------ the SD app itself crashed
// explainExit(code, ctx) — why the Stable Diffusion app (ComfyUI, Forge …) that
// AutoInjector started stopped by itself, in plain English, from its exit code
// and the last lines it printed. Windows reports crashes as NTSTATUS codes
// (Node gives them unsigned: 0xC0000005 = 3221225477).
//   ctx: { tail (its last output lines), gpu: { vendor, name }, kind ('comfy'…),
//          canCpu (offer "Start on the processor"), otherBuild ({build,label}|null) }
// → { known, code, exitCode, hex, message, fix, actions:[{id,label}], line }
//   code: ACCESS_VIOLATION | STACK_BUFFER_OVERRUN | DLL_NOT_FOUND | DLL_INIT_FAILED |
//         ILLEGAL_INSTRUCTION | NO_MEMORY | CLOSED | WRONG_BUILD | DRIVER_OLD |
//         OOM | MISSING_MODULE | PORT_IN_USE | PYTHON_ERROR | EXITED
const START_CPU_ACTION = { id: 'sd-start-cpu', label: 'Start on the processor (slow, but works on any PC)' };
const OTHER_BUILD_ACTION = { id: 'sd-other-build', label: 'Use the other ComfyUI build' };
const OPEN_LOG_ACTION = { id: 'sd-open-log', label: 'Open the log' };
const VCREDIST = 'Install the Microsoft Visual C++ Redistributable (x64, free from Microsoft: aka.ms/vs/17/release/vc_redist.x64.exe), restart the PC, then press Start again.';
const NT = {
  0xC0000005: 'ACCESS_VIOLATION', 0xC0000409: 'STACK_BUFFER_OVERRUN', 0xC0000135: 'DLL_NOT_FOUND', 0xC0000142: 'DLL_INIT_FAILED',
  0xC000001D: 'ILLEGAL_INSTRUCTION', 0xC0000017: 'NO_MEMORY', 0xC000012D: 'NO_MEMORY', 0xC000013A: 'CLOSED',
};
function hexOf(code) { const n = Number(code); if (!Number.isFinite(n)) return ''; return `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`; }
function _gpuFix(ctx) {
  const g = (ctx && ctx.gpu) || {};
  const name = String(g.name || '');
  const vendor = String(g.vendor || '').toLowerCase();
  const steps = [];
  steps.push(`Update the graphics driver${vendor === 'amd' ? ' (AMD Adrenalin, from amd.com)' : vendor === 'intel' ? ' (Intel Arc driver, from intel.com)' : ' (NVIDIA: nvidia.com/drivers or the NVIDIA app; AMD: Adrenalin)'} and restart the PC.`);
  if (/RTX\s*50\d\d/i.test(name)) steps.push(`Your ${name} (RTX 50-series) needs the newest NVIDIA build of ComfyUI (PyTorch with CUDA 12.8 or newer — “cu128”/nightly); older builds crash on it.`);
  else if (vendor === 'amd' || vendor === 'intel') steps.push(`Your ${vendor === 'amd' ? 'AMD' : 'Intel'} card needs ComfyUI's ${vendor === 'amd' ? 'AMD' : 'Intel'} build (or the DirectML / CPU version) — the NVIDIA build crashes on it.`);
  else steps.push('Your graphics card may need a different ComfyUI build: RTX 50-series cards need the newest NVIDIA build (CUDA 12.8+, “cu128”/nightly), GTX 10xx and older need the cu126 build, AMD and Intel cards need their own build (or DirectML / CPU).');
  steps.push(VCREDIST.replace(', then press Start again.', '.'));
  if (ctx && ctx.canCpu !== false && (!ctx.kind || ctx.kind === 'comfy')) steps.push('Or press “Start on the processor (slow)” — it works on any PC, a picture just takes minutes.');
  return steps.map((s, i) => `${i + 1}) ${s}`).join(' ');
}
function _actions(ctx, gpuRelated) {
  const a = [];
  const canCpu = ctx.canCpu !== undefined ? !!ctx.canCpu : (ctx.kind ? ctx.kind === 'comfy' : true);
  if (gpuRelated && canCpu) a.push(START_CPU_ACTION);
  if (gpuRelated && ctx.otherBuild) a.push(Object.assign({}, OTHER_BUILD_ACTION, ctx.otherBuild.label ? { label: `Use the other ComfyUI build (${ctx.otherBuild.label})` } : {}));
  a.push(OPEN_LOG_ACTION);
  return a;
}
// Rules on what it printed (checked before the bare exit code: a Python error says more).
const TAIL_RULES = [
  { code: 'WRONG_BUILD', re: /no kernel image is available|is not compatible with the current PyTorch|CUDA capability sm_\d+ is not compatible|Torch not compiled with CUDA enabled|not compiled with (?:CUDA|ROCm)/i },
  { code: 'DRIVER_OLD', re: /CUDA driver version is insufficient|Found no NVIDIA driver|NVIDIA driver on your system is too old|driver (?:version )?is too old/i },
  { code: 'DLL_NOT_FOUND', re: /WinError 126|DLL load failed|Error loading ".*\.dll"|c10\.dll|fbgemm\.dll|The specified module could not be found/i },
  { code: 'OOM', re: /out of memory|OutOfMemoryError|DefaultCPUAllocator|not enough memory/i },
  { code: 'PORT_IN_USE', re: /address already in use|WinError 10048|Errno 98|only one usage of each socket address/i },
  { code: 'MISSING_MODULE', re: /ModuleNotFoundError|No module named/i },
];
function explainExit(code, ctx = {}) {
  try { return _explainExit(code, ctx || {}); }
  catch { return { known: false, code: 'EXITED', exitCode: code, hex: hexOf(code), message: 'It stopped unexpectedly.', fix: '', actions: [OPEN_LOG_ACTION], line: '' }; }
}
// The line of a crash's output worth showing: the Python exception, else the last real line.
function importantLine(tail) {
  const lines = String(tail || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/Traceback \(most recent call last\)/.test(l) && !/^File "/.test(l) && !/^\^+$/.test(l) && !/^\[AutoInjector\]/.test(l));
  const exc = [...lines].reverse().find((l) => /\b\w*(Error|Exception)\b\s*:|^Error\b|\bfailed\b/i.test(l));
  return String(exc || lines[lines.length - 1] || '').slice(0, 220);
}
function _explainExit(exitCode, ctx) {
  const tail = String(ctx.tail || '');
  const line = tail ? importantLine(tail) : '';
  const n = Number(exitCode);
  const u = Number.isFinite(n) ? n >>> 0 : null;
  const hex = u != null && u > 0xFFFF ? hexOf(u) : '';
  const nt = u != null ? NT[u] : null;
  const app = ctx.label || 'Stable Diffusion';
  const said = line ? ` It last said: “${line}”.` : '';
  const out = (code, message, fix, gpuRelated) => ({ known: true, code, exitCode: exitCode == null ? null : exitCode, hex, message, fix, actions: _actions(ctx, gpuRelated), line });
  const rule = tail ? TAIL_RULES.find((r) => r.re.test(tail)) : null;
  // A Windows crash code says more than a stray line, except for the "wrong build" family.
  if (rule && (!nt || rule.code === 'WRONG_BUILD' || rule.code === 'DRIVER_OLD')) {
    if (rule.code === 'WRONG_BUILD') return out('WRONG_BUILD', `${app} can't use your graphics card with this build (its PyTorch doesn't support the card).${said}`, _gpuFix(ctx), true);
    if (rule.code === 'DRIVER_OLD') return out('DRIVER_OLD', `${app} needs a newer graphics driver.${said}`, _gpuFix(ctx), true);
    if (rule.code === 'DLL_NOT_FOUND') return out('DLL_NOT_FOUND', `${app} could not load a Windows file it needs (a DLL).${said}`, VCREDIST, false);
    if (rule.code === 'OOM') return out('OOM', `${app} ran out of memory while starting.${said}`, 'Close other programs (games, browsers with many tabs, other AI apps), then press Start again. With little graphics memory, use small SD 1.5 models.', true);
    if (rule.code === 'PORT_IN_USE') return out('PORT_IN_USE', `Another program is already using ${app}'s port.${said}`, 'Close the other copy (e.g. a ComfyUI window or Stability Matrix), or restart the PC, then press Start again.', false);
    if (rule.code === 'MISSING_MODULE') return out('MISSING_MODULE', `A part of ${app} is missing.${said}`, 'If you added custom nodes, remove the last one you added. Otherwise the install is incomplete: install it again (your models are kept).', false);
  }
  if (nt === 'ACCESS_VIOLATION') return out(nt, `${app} crashed while starting (Windows error ${hex}, “access violation”). This happens inside the graphics driver or PyTorch's GPU code — it is not something you did.${said}`, _gpuFix(ctx), true);
  if (nt === 'STACK_BUFFER_OVERRUN') return out(nt, `${app} was stopped by a Windows safety check (error ${hex}). Usually a DLL that doesn't match: an old Visual C++ runtime, a graphics driver that doesn't match the build, or another program hooking into Python (overlays, antivirus).${said}`, _gpuFix(ctx), true);
  if (nt === 'DLL_NOT_FOUND' || nt === 'DLL_INIT_FAILED') return out(nt, `${app} could not start because a Windows file it needs is missing (error ${hex}${nt === 'DLL_NOT_FOUND' ? ', a DLL was not found' : ', a DLL failed to load'}) — usually the Microsoft Visual C++ Redistributable.${said}`, VCREDIST, false);
  if (nt === 'ILLEGAL_INSTRUCTION') return out(nt, `${app} needs a processor feature (AVX) this PC doesn't have (error ${hex}).`, 'This PC is too old for this build of PyTorch. Use a newer PC, or ChatGPT as the image engine.', false);
  if (nt === 'NO_MEMORY') return out(nt, `Windows ran out of memory starting ${app} (error ${hex}).`, 'Close other programs and make sure Windows manages the page file automatically (System → About → Advanced system settings → Performance → Virtual memory), then press Start again.', true);
  if (nt === 'CLOSED') return out(nt, `${app} was closed (its window was closed or Ctrl+C was pressed).`, 'Press Start again.', false);
  if (u === 1 || line) return { known: !!line, code: 'PYTHON_ERROR', exitCode, hex, message: line ? `${app} stopped with an error: ${line}` : `${app} stopped with an error (exit code 1).`, fix: 'Open the log to see the whole message. If it started after you added a custom node or changed a launch option, undo that and press Start again.', actions: _actions(ctx, false), line };
  return { known: false, code: 'EXITED', exitCode, hex, message: `${app} stopped unexpectedly (exit ${hex || (exitCode == null ? 'unknown' : exitCode)}).`, fix: 'Open the log to see why, then press Start again.', actions: _actions(ctx, false), line };
}

module.exports = { explainSdError, annotate, NO_MODEL_MESSAGE, NO_MODEL_FIX, serverText, firstUsefulLine, DETAILS_MAX, VAE_ACTION, explainExit, importantLine, hexOf, START_CPU_ACTION, OTHER_BUILD_ACTION, OPEN_LOG_ACTION };
