'use strict';
/*
 * sd-workflows.js — run ANY ComfyUI workflow, with named parameters.
 *
 * A workflow is ComfyUI's "API format" JSON (ComfyUI → ⚙ / Workflow menu →
 * "Save (API Format)" / "Export (API)"): { "<node id>": { class_type, inputs } }.
 * The normal UI save ({ nodes:[…], links:[…] }) is refused with that hint.
 *
 * Named parameters reach node inputs in four ways (first match wins):
 *   1. "<node id>.<input>"      e.g. { "6.text": "a cat" }           (always works)
 *   2. explicit bindings saved with the workflow:
 *        { "prompt": [{ "node": "6", "input": "text" }], "seed": [{ "node": "3", "input": "seed" }] }
 *   3. {{placeholders}} inside string inputs: "text": "{{prompt}}, masterpiece"
 *   4. auto-detected standard names — prompt / negativePrompt (the CLIPTextEncode
 *      feeding the sampler's positive / negative), seed, steps, cfgScale, sampler,
 *      scheduler, denoise, width, height, batchSize, checkpoint, image, mask.
 * Unknown names are refused (UNKNOWN_PARAM, with the names this workflow has).
 *
 * createWorkflowStore({ dir }) keeps saved workflows as <dir>/<id>.json.
 * createWorkflowStore({ dir, extraDir }) also lists every plain ComfyUI workflow .json in extraDir ("stuff and
 * thing"/workflows — e.g. the ones moved from Stability Matrix's Data\Workflows): an "Export (API)" one can be
 * run like a saved one (id "folder:<file name>"); a normal (UI) save is listed with the hint to open it in
 * ComfyUI (or export it as API there), never changed.
 */
const fs = require('fs');
const path = require('path');

const SAMPLERS = ['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced'];
const LATENTS = ['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyHunyuanLatentVideo'];
const CKPTS = ['CheckpointLoaderSimple', 'CheckpointLoader', 'UNETLoader'];
const ALIASES = { negative: 'negativePrompt', negative_prompt: 'negativePrompt', cfg: 'cfgScale', cfg_scale: 'cfgScale', sampler_name: 'sampler', batch_size: 'batchSize', ckpt: 'checkpoint', model: 'checkpoint', noise_seed: 'seed' };

function isUiFormat(wf) { return !!(wf && typeof wf === 'object' && Array.isArray(wf.nodes) && Array.isArray(wf.links)); }
function checkWorkflow(wf) {
  if (typeof wf === 'string') { try { wf = JSON.parse(wf); } catch (e) { return { ok: false, error: 'BAD_WORKFLOW', code: 'BAD_WORKFLOW', message: `That isn't valid JSON: ${e.message}` }; } }
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) return { ok: false, error: 'BAD_WORKFLOW', code: 'BAD_WORKFLOW', message: 'A workflow must be a JSON object.' };
  if (wf.prompt && typeof wf.prompt === 'object' && !wf.class_type) wf = wf.prompt; // a /prompt body pasted whole
  if (isUiFormat(wf)) return { ok: false, error: 'UI_FORMAT', code: 'UI_FORMAT', message: 'This is ComfyUI\'s normal (UI) save. AutoInjector needs the API format.', hint: 'In ComfyUI open the workflow, then Workflow → Export (API) — older versions: ⚙ Settings → enable Dev mode, then “Save (API Format)”.' };
  const ids = Object.keys(wf);
  if (!ids.length) return { ok: false, error: 'BAD_WORKFLOW', code: 'BAD_WORKFLOW', message: 'The workflow is empty.' };
  for (const id of ids) {
    const n = wf[id];
    if (!n || typeof n !== 'object' || typeof n.class_type !== 'string' || !n.inputs || typeof n.inputs !== 'object') return { ok: false, error: 'BAD_WORKFLOW', code: 'BAD_WORKFLOW', message: `Node “${id}” has no class_type / inputs — is this the API format?`, hint: 'Export it with “Save (API Format)”.' };
    for (const [k, v] of Object.entries(n.inputs)) if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]) && !wf[v[0]]) return { ok: false, error: 'BAD_WORKFLOW', code: 'BAD_WORKFLOW', message: `Node “${id}” input “${k}” points to node “${v[0]}”, which isn't in the workflow.` };
  }
  return { ok: true, workflow: wf };
}

const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]);
// Follow a conditioning link back to the CLIPTextEncode that made it.
function _textNode(wf, link, depth = 0) {
  if (!isLink(link) || depth > 12) return null;
  const n = wf[link[0]];
  if (!n) return null;
  if (/CLIPTextEncode/.test(n.class_type)) { const key = typeof n.inputs.text === 'string' ? 'text' : (typeof n.inputs.text_g === 'string' ? 'text_g' : null); return key ? { node: link[0], input: key } : null; }
  // Pass-through nodes (ControlNetApply*, ConditioningCombine, …): follow positive/negative/conditioning.
  const idx = link[1];
  const pref = idx === 1 ? ['negative', 'conditioning', 'conditioning_1'] : ['positive', 'conditioning', 'conditioning_1', 'conditioning_to'];
  for (const k of pref) if (isLink(n.inputs[k])) { const r = _textNode(wf, n.inputs[k], depth + 1); if (r) return r; }
  return null;
}
// Standard name → targets, from the graph itself.
function detectBindings(wf) {
  const b = {};
  const add = (name, node, input) => { if (!wf[node] || isLink(wf[node].inputs[input]) || wf[node].inputs[input] === undefined) return; (b[name] = b[name] || []).some((t) => t.node === node && t.input === input) || b[name].push({ node, input }); };
  const ids = Object.keys(wf).sort((a, b2) => (Number(a) - Number(b2)) || a.localeCompare(b2));
  const sampler = ids.find((id) => SAMPLERS.includes(wf[id].class_type));
  if (sampler) {
    const s = wf[sampler].inputs;
    const pos = _textNode(wf, s.positive); const neg = _textNode(wf, s.negative);
    if (pos) add('prompt', pos.node, pos.input);
    if (neg) add('negativePrompt', neg.node, neg.input);
  }
  for (const id of ids) {
    const n = wf[id]; const c = n.class_type;
    if (SAMPLERS.includes(c) || c === 'RandomNoise') {
      if ('seed' in n.inputs) add('seed', id, 'seed');
      if ('noise_seed' in n.inputs) add('seed', id, 'noise_seed');
      if (id === sampler) { for (const [k, nm] of [['steps', 'steps'], ['cfg', 'cfgScale'], ['sampler_name', 'sampler'], ['scheduler', 'scheduler'], ['denoise', 'denoise']]) if (k in n.inputs) add(nm, id, k); }
    }
    if (LATENTS.includes(c)) { add('width', id, 'width'); add('height', id, 'height'); add('batchSize', id, 'batch_size'); }
    if (CKPTS.includes(c) && !b.checkpoint) add('checkpoint', id, c === 'UNETLoader' ? 'unet_name' : 'ckpt_name');
    if (c === 'LoadImage' && !b.image) add('image', id, 'image');
    if (c === 'LoadImageMask' && !b.mask) add('mask', id, 'image');
  }
  if (!sampler) { const t = ids.find((id) => /CLIPTextEncode/.test(wf[id].class_type) && typeof wf[id].inputs.text === 'string'); if (t) add('prompt', t, 'text'); }
  return b;
}
function placeholders(wf) {
  const out = new Set();
  for (const n of Object.values(wf)) for (const v of Object.values(n.inputs || {})) if (typeof v === 'string') for (const m of v.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) out.add(m[1]);
  return [...out];
}
function paramNames(wf, bindings) { return [...new Set([...Object.keys(bindings || {}), ...Object.keys(detectBindings(wf)), ...placeholders(wf)])]; }

// Where does param `name` go? → [{ node, input, via }]
function resolveTargets(wf, name, bindings) {
  const m = String(name).match(/^([^.]+)\.([\w-]+)$/);
  if (m && wf[m[1]]) return [{ node: m[1], input: m[2], via: 'node.input' }];
  const key = ALIASES[name] || name;
  const exp = (bindings && (bindings[name] || bindings[key])) || null;
  if (exp && exp.length) return exp.map((t) => ({ node: String(t.node), input: t.input, via: 'binding' }));
  const ph = [];
  for (const [id, n] of Object.entries(wf)) for (const [k, v] of Object.entries(n.inputs || {})) if (typeof v === 'string' && new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`).test(v)) ph.push({ node: id, input: k, via: 'placeholder' });
  if (ph.length) return ph;
  const det = detectBindings(wf)[key];
  return det ? det.map((t) => Object.assign({}, t, { via: 'detected' })) : [];
}

// Put params into a copy of the workflow. Image values must already be uploaded
// file names (image-provider uploads them first). → { ok, workflow, applied } | error
function substitute(wf, params, bindings, opts = {}) {
  const chk = checkWorkflow(wf);
  if (!chk.ok) return chk;
  const g = JSON.parse(JSON.stringify(chk.workflow));
  const applied = [];
  for (const [name, raw] of Object.entries(params || {})) {
    if (raw === undefined) continue;
    const targets = resolveTargets(g, name, bindings);
    if (!targets.length) return { ok: false, error: 'UNKNOWN_PARAM', code: 'UNKNOWN_PARAM', field: name, message: `This workflow has no parameter “${name}”.`, hint: `It has: ${paramNames(g, bindings).join(', ') || '(none — use "<node id>.<input>")'}` };
    let value = raw;
    if ((ALIASES[name] || name) === 'seed' && Number(value) < 0) value = opts.randomSeed ? opts.randomSeed() : Math.floor(Math.random() * 4294967295);
    for (const t of targets) {
      const n = g[t.node];
      if (!n) return { ok: false, error: 'UNKNOWN_PARAM', code: 'UNKNOWN_PARAM', field: name, message: `Binding for “${name}” points to node “${t.node}”, which isn't in the workflow.` };
      let v = value;
      if (t.input === 'sampler_name' && opts.mapSampler) v = opts.mapSampler(value);
      if (t.via === 'placeholder') {
        const cur = String(n.inputs[t.input]);
        const re = new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g');
        v = cur.replace(/\s/g, '') === `{{${name}}}` ? value : cur.replace(re, String(value));
      }
      n.inputs[t.input] = v;
      applied.push({ param: name, node: t.node, input: t.input, via: t.via });
    }
  }
  const left = placeholders(g);
  if (left.length) return { ok: false, error: 'MISSING_PARAM', code: 'MISSING_PARAM', field: left[0], message: `The workflow needs: ${left.join(', ')}.`, hint: 'Pass them in params.' };
  return { ok: true, workflow: g, applied };
}

function _slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || `workflow-${Date.now().toString(36)}`; }

function createWorkflowStore(o = {}) {
  const dir = o.dir;
  const extraDir = typeof o.extraDir === 'function' ? o.extraDir : () => o.extraDir || null;
  const FOLDER = 'folder:';
  // Plain workflow files in the extra folder → records (API ones runnable; UI ones listed with a hint).
  function readFolder() {
    const d = extraDir();
    if (!d) return [];
    let names = []; try { names = fs.readdirSync(d).filter((n) => /\.json$/i.test(n)); } catch { return []; }
    const out = [];
    for (const n of names) {
      const file = path.join(d, n);
      let j = null; try { const st = fs.statSync(file); if (st.size > 20 * 1024 * 1024) continue; j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { j = null; }
      const base = { id: FOLDER + n, name: n.replace(/\.json$/i, ''), file, folder: true, description: '' };
      if (j && j.workflow && typeof j.workflow === 'object' && !isUiFormat(j.workflow)) { const c = checkWorkflow(j.workflow); if (c.ok) { out.push(Object.assign(base, { name: j.name || base.name, description: j.description || '', workflow: c.workflow, bindings: j.bindings || {} })); continue; } }
      if (isUiFormat(j)) { out.push(Object.assign(base, { ui: true, workflow: null, bindings: {} })); continue; }
      const c = j ? checkWorkflow(j) : null;
      if (c && c.ok) out.push(Object.assign(base, { workflow: c.workflow, bindings: {} }));
      else out.push(Object.assign(base, { broken: true, workflow: null, bindings: {} }));
    }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  function folderSummary(r) {
    if (r.workflow) return Object.assign(summary(r), { folder: true, file: r.file });
    return { id: r.id, name: r.name, description: r.ui ? 'Saved in ComfyUI\'s normal format — open it in ComfyUI, or there use Workflow → Export (API) and put that file here to run it from AutoInjector.' : 'Not a ComfyUI workflow AutoInjector can read.', savedAt: null, nodes: 0, params: [], outputs: 0, folder: true, file: r.file, ui: !!r.ui, runnable: false };
  }
  const file = (id) => path.join(dir, `${_slug(id)}.json`);
  function readAll() {
    let names = []; try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const n of names) { try { const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); if (r && r.workflow) out.push(r); } catch { /* skip a broken file */ } }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  function summary(r) { return { id: r.id, name: r.name, description: r.description || '', savedAt: r.savedAt, nodes: Object.keys(r.workflow).length, params: paramNames(r.workflow, r.bindings), outputs: Object.values(r.workflow).filter((n) => /Save|Preview/.test(n.class_type)).length }; }
  return {
    dir,
    extraDir,
    list() { return { ok: true, workflows: readAll().map(summary).concat(readFolder().map(folderSummary)), folder: extraDir() || null }; },
    get(idOrName) {
      const k = String(idOrName || '');
      if (k.startsWith(FOLDER)) {
        const f = readFolder().find((x) => x.id === k);
        if (!f) return { ok: false, error: 'NO_WORKFLOW', code: 'NO_WORKFLOW', message: `There's no workflow file “${k.slice(FOLDER.length)}” in the workflows folder.` };
        if (!f.workflow) return f.ui ? { ok: false, error: 'UI_FORMAT', code: 'UI_FORMAT', message: `“${f.name}” is ComfyUI's normal (UI) save, so AutoInjector can't run it.`, hint: 'Open it in ComfyUI (drag the file in), then Workflow → Export (API) and put that file in the workflows folder.' } : { ok: false, error: 'BAD_WORKFLOW', code: 'BAD_WORKFLOW', message: `“${f.name}” is not a ComfyUI workflow.` };
        return Object.assign({ ok: true }, f, { params: paramNames(f.workflow, f.bindings) });
      }
      const r = readAll().find((x) => x.id === k || x.id === _slug(k) || String(x.name).toLowerCase() === k.toLowerCase());
      return r ? Object.assign({ ok: true }, r, { params: paramNames(r.workflow, r.bindings) }) : { ok: false, error: 'NO_WORKFLOW', code: 'NO_WORKFLOW', message: `There's no saved workflow called “${k}”.`, hint: 'sd.workflows.list() shows the saved ones.' };
    },
    save(rec) {
      const r = rec || {};
      if (!String(r.name || '').trim()) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'name', message: 'Give the workflow a name.' };
      const chk = checkWorkflow(r.workflow);
      if (!chk.ok) return chk;
      if (r.bindings != null && (typeof r.bindings !== 'object' || Array.isArray(r.bindings))) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'bindings', message: 'bindings must be { "name": [{ "node": "6", "input": "text" }] }.' };
      for (const [k, ts] of Object.entries(r.bindings || {})) {
        if (!Array.isArray(ts) || ts.some((t) => !t || !chk.workflow[String(t.node)] || !t.input)) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: `bindings.${k}`, message: `Binding “${k}” must list { node, input } of nodes in this workflow.` };
      }
      const id = _slug(r.id || r.name);
      const out = { id, name: String(r.name).trim().slice(0, 120), description: String(r.description || '').slice(0, 1000), workflow: chk.workflow, bindings: r.bindings || {}, savedAt: new Date().toISOString() };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file(id), JSON.stringify(out, null, 1));
      return { ok: true, workflow: summary(out) };
    },
    remove(id) {
      if (String(id || '').startsWith(FOLDER)) return { ok: false, error: 'IN_FOLDER', code: 'IN_FOLDER', message: 'That workflow is a file in the "stuff and thing"/workflows folder — remove it there (📂 Open workflows folder).' };
      const g = this.get(id);
      if (!g.ok) return g;
      try { fs.unlinkSync(file(g.id)); } catch (e) { return { ok: false, error: 'DELETE_FAILED', message: String(e.message || e) }; }
      return { ok: true, id: g.id };
    },
  };
}

module.exports = { isUiFormat, checkWorkflow, detectBindings, placeholders, paramNames, resolveTargets, substitute, createWorkflowStore, ALIASES };
