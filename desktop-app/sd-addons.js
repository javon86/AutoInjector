'use strict';
/*
 * sd-addons.js — 🧩 Add-ons (extensions) for the Stable Diffusion app on this PC
 * (Forge / reForge / Automatic1111 / SD.Next "extensions", ComfyUI "custom nodes").
 * Electron-free; main.js wires it to the 🎨 Images tab (ipc "sd:addons*").
 *
 *   resolveInstall({ chosen, runner, targets, connected, targetId }) → where the app is installed
 *       { ok, dir, kind, label, extDir, source, chosen } | { ok:false, error:'NO_PATH', message, fix }
 *       (the folder the person chose, the package AutoInjector started, the Stability Matrix packages)
 *   inspectFolder(path)   → the same shape for a folder the person picked (a package folder, its
 *                           extensions / custom_nodes folder, Stability Matrix's Data or Packages folder,
 *                           the ComfyUI portable root)
 *   overview({ install, base, backend, label }) → what is installed (the folder + the app's own API:
 *       /sdapi/v1/extensions, else /sdapi/v1/scripts; ComfyUI-Manager's /customnode/installed) and the
 *       curated list (CATALOG / COMFY_CATALOG) with a state each: installed | restart | builtin | missing | not-for
 *   validateRepoUrl(url)  → { ok, url, host, owner, repo, name } — https github.com / gitlab.com only
 *   install(install, { id } | { url }, deps) — git clone --depth 1 <url> into the extensions folder
 *       (a temporary folder first, renamed at the end), or — with no git — the repo's zip from GitHub/GitLab
 *   update(install, name, deps)  — git pull --ff-only (or a fresh zip for a zip install)
 *   remove(install, name, deps)  — moved to <app folder>/_removed/<name>-<time> (never deleted)
 *   findGit({ env, libraries }) — AUTOINJECTOR_GIT, Stability Matrix's PortableGit, Git for Windows, PATH
 *   createAddonManager({ resolve, connection, git, download, extract, log, onProgress }) — one job at a time
 *
 * Nothing here runs an add-on's code: files are only placed. The app (Forge) sets an add-on up
 * itself the next time it starts (its install.py), which is why a restart is offered afterwards.
 */
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

const LABEL = { comfy: 'ComfyUI', forge: 'Forge', reforge: 'reForge', a1111: 'Automatic1111', sdnext: 'SD.Next' };
const WEBUI = ['forge', 'reforge', 'a1111', 'sdnext'];

// ------------------------------------------------------------ the curated lists
// for: the apps it works in. builtin: { kind: [folder names in extensions-builtin] } — nothing to install there.
const CATALOG = [
  { id: 'adetailer', name: 'ADetailer', what: 'Fixes faces and hands by itself after each picture (a second, closer pass on each face).', url: 'https://github.com/Bing-su/adetailer', folder: 'adetailer', script: /^adetailer$/i, for: WEBUI },
  { id: 'controlnet', name: 'ControlNet', what: 'Copies a pose, an outline or the depth from a picture you give it, so the new picture follows it.', url: 'https://github.com/Mikubill/sd-webui-controlnet', folder: 'sd-webui-controlnet', script: /^controlnet$/i, for: ['a1111'],
    builtin: { forge: ['sd_forge_controlnet'], reforge: ['sd_forge_controlnet'], sdnext: [] }, builtinNote: 'ControlNet is built into {app} already — nothing to install.' },
  { id: 'regional-prompter', name: 'Regional Prompter', what: 'Different words for different parts of the picture (for example one person on the left, another on the right).', url: 'https://github.com/hako-mikan/sd-webui-regional-prompter', folder: 'sd-webui-regional-prompter', script: /regional prompter/i, for: WEBUI },
  { id: 'dynamic-prompts', name: 'Dynamic Prompts', what: 'Random choices inside a prompt, like {red|blue|green} dress, so every picture comes out a bit different.', url: 'https://github.com/adieyal/sd-dynamic-prompts', folder: 'sd-dynamic-prompts', script: /dynamic prompts/i, for: WEBUI },
  { id: 'tiled-diffusion', name: 'Tiled Diffusion (MultiDiffusion)', what: 'Makes very large pictures, and upscales them, in tiles — so the graphics card does not run out of memory.', url: 'https://github.com/pkuliyi2015/multidiffusion-upscaler-for-automatic1111', folder: 'multidiffusion-upscaler-for-automatic1111', script: /tiled (diffusion|vae)|multidiffusion/i, for: ['a1111', 'sdnext'],
    builtin: { forge: ['sd_forge_multidiffusion'], reforge: ['sd_forge_multidiffusion'] }, builtinNote: '{app} has its own built in (“MultiDiffusion Integrated”) — the A1111 one does not work there.' },
  { id: 'ultimate-upscale', name: 'Ultimate SD Upscale', what: 'Makes a picture 2× or 4× bigger and adds fine detail, piece by piece.', url: 'https://github.com/Coyote-A/ultimate-upscale-for-automatic1111', folder: 'ultimate-upscale-for-automatic1111', script: /ultimate sd upscale/i, for: WEBUI },
  { id: 'reactor', name: 'ReActor (face swap)', what: 'Puts a face from one picture onto another. Only use faces of people who said yes — never to fake, embarrass or impersonate anyone.', url: 'https://github.com/Gourieff/sd-webui-reactor-sfw', folder: 'sd-webui-reactor-sfw', aliases: ['sd-webui-reactor'], script: /reactor/i, for: WEBUI, consent: true },
];
const COMFY_CATALOG = [
  { id: 'comfyui-manager', name: 'ComfyUI-Manager', what: 'ComfyUI\'s own add-on shop: installs and updates custom nodes from inside ComfyUI (a “Manager” button).', url: 'https://github.com/ltdrdata/ComfyUI-Manager', folder: 'ComfyUI-Manager', aliases: ['comfyui-manager'], for: ['comfy'] },
  { id: 'impact-pack', name: 'Impact Pack (Face Detailer)', what: 'Fixes faces and hands (FaceDetailer) — the ComfyUI version of ADetailer.', url: 'https://github.com/ltdrdata/ComfyUI-Impact-Pack', folder: 'ComfyUI-Impact-Pack', for: ['comfy'] },
  { id: 'controlnet-aux', name: 'ControlNet preprocessors', what: 'Turns a picture into a pose, an outline or a depth map for ControlNet (ControlNet itself is built into ComfyUI).', url: 'https://github.com/Fannovel16/comfyui_controlnet_aux', folder: 'comfyui_controlnet_aux', for: ['comfy'] },
  { id: 'ultimate-upscale', name: 'Ultimate SD Upscale', what: 'Makes a picture 2× or 4× bigger and adds fine detail, piece by piece.', url: 'https://github.com/ssitu/ComfyUI_UltimateSDUpscale', folder: 'ComfyUI_UltimateSDUpscale', for: ['comfy'] },
  { id: 'dynamic-prompts', name: 'Dynamic Prompts', what: 'Random choices inside a prompt, like {red|blue|green} dress.', url: 'https://github.com/adieyal/comfyui-dynamicprompts', folder: 'comfyui-dynamicprompts', for: ['comfy'] },
  { id: 'reactor', name: 'ReActor (face swap)', what: 'Puts a face from one picture onto another. Only use faces of people who said yes — never to fake, embarrass or impersonate anyone.', url: 'https://github.com/Gourieff/ComfyUI-ReActor', folder: 'ComfyUI-ReActor', for: ['comfy'], consent: true },
];
// "ADetailer was left out" (sd-control EXT_SKIP fields) → the add-on that brings it.
const FOR_FIELD = { adetailer: 'adetailer', controlnet: 'controlnet' };

function catalogFor(kind) { return kind === 'comfy' ? COMFY_CATALOG : CATALOG; }
function err(code, message, extra) { return Object.assign({ ok: false, error: code, code, message }, extra || {}); }
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
function stamp(now) { const d = new Date(now || Date.now()); const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; }
function appName(kind) { return LABEL[kind] || 'Stable Diffusion'; }
function kindFromLabel(label) {
  const s = String(label || '').toLowerCase();
  if (/comfy/.test(s)) return 'comfy';
  if (/reforge/.test(s)) return 'reforge';
  if (/forge/.test(s)) return 'forge';
  if (/sd\.?next/.test(s)) return 'sdnext';
  if (/automatic|a1111/.test(s)) return 'a1111';
  return null;
}

// ------------------------------------------------------------ links
// Only https github.com / gitlab.com repository links. Browser links (…/tree/main, …/blob/…) are accepted
// and reduced to the repository. → { ok, url (…/owner/repo.git), web, host, owner, repo, name }
const SEG = /^[A-Za-z0-9._-]+$/;
function validateRepoUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const bad = (m) => err('BAD_LINK', m, { hint: 'Paste the add-on\'s GitHub page, for example https://github.com/Bing-su/adetailer' });
  if (!s) return bad('Paste the add-on\'s link first.');
  let u;
  try { u = new URL(s); } catch { return bad('That isn\'t a web link. It should start with https://github.com/'); }
  if (u.protocol !== 'https:') return bad('Only https:// links are accepted (https://github.com/… or https://gitlab.com/…).');
  if (u.username || u.password) return bad('Links with a name or password in them are not accepted.');
  if (u.port) return bad('Only plain github.com or gitlab.com links are accepted.');
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'github.com' && host !== 'gitlab.com') return bad(`Only add-ons from GitHub or GitLab can be installed here (that link is on ${host}).`);
  let parts = u.pathname.split('/').filter(Boolean);
  if (host === 'github.com') parts = parts.slice(0, 2);
  else { const i = parts.indexOf('-'); if (i >= 0) parts = parts.slice(0, i); }
  if (parts.length < 2) return bad('That link is not an add-on\'s page — it needs the owner and the name, like https://github.com/owner/add-on');
  if (host === 'gitlab.com' && parts.length > 4) return bad('That GitLab link is too deep — use the project\'s main page.');
  parts[parts.length - 1] = parts[parts.length - 1].replace(/\.git$/i, '');
  if (parts.some((p) => !SEG.test(p) || p === '.' || p === '..' || p.startsWith('.'))) return bad('That link has characters an add-on name can\'t have.');
  const repo = parts[parts.length - 1];
  const owner = parts.slice(0, -1).join('/');
  if (host === 'github.com' && ['orgs', 'settings', 'marketplace', 'topics', 'search', 'explore', 'login', 'sponsors'].includes(parts[0].toLowerCase())) return bad('That link is a GitHub page, not an add-on.');
  const web = `https://${host}/${parts.join('/')}`;
  return { ok: true, url: `${web}.git`, web, host, owner, repo, name: repo };
}
function repoKey(url) { const v = validateRepoUrl(url); return v.ok ? `${v.host}/${v.owner}/${v.repo}`.toLowerCase() : ''; }
function zipUrlFor(url) {
  const v = validateRepoUrl(url);
  if (!v.ok) return null;
  if (v.host === 'github.com') return `https://codeload.github.com/${v.owner}/${v.repo}/zip/HEAD`;
  return `https://gitlab.com/${v.owner}/${v.repo}/-/archive/HEAD/${v.repo}-HEAD.zip`;
}

// ------------------------------------------------------------ where the app is
function webuiKind(dir) {
  const s = path.basename(dir).toLowerCase();
  if (/reforge/.test(s)) return 'reforge';
  if (/forge/.test(s) || exists(path.join(dir, 'modules_forge'))) return 'forge';
  if (/sd\.?next|^automatic$|vlad/.test(s)) return 'sdnext';
  return 'a1111';
}
function looksComfy(d) { return exists(path.join(d, 'main.py')) && (isDir(path.join(d, 'comfy')) || isDir(path.join(d, 'custom_nodes'))); }
function looksWebui(d) { return (exists(path.join(d, 'launch.py')) || exists(path.join(d, 'webui.py'))) && (isDir(path.join(d, 'modules')) || isDir(path.join(d, 'extensions'))); }
function described(d, kind) { return { ok: true, dir: d, kind, label: appName(kind), extDir: path.join(d, kind === 'comfy' ? 'custom_nodes' : 'extensions'), builtinDir: kind === 'comfy' ? null : path.join(d, 'extensions-builtin') }; }
function inspectFolder(p, depth = 0) {
  if (!p || typeof p !== 'string') return err('NO_FOLDER', 'No folder was given.');
  let d = path.resolve(p);
  if (!isDir(d)) return err('NO_FOLDER', `The folder ${d} does not exist (any more).`);
  const base = path.basename(d).toLowerCase();
  if ((base === 'extensions' || base === 'custom_nodes') && (looksWebui(path.dirname(d)) || looksComfy(path.dirname(d)))) d = path.dirname(d);
  if (looksComfy(path.join(d, 'ComfyUI'))) d = path.join(d, 'ComfyUI'); // the ComfyUI portable's root
  if (looksComfy(d)) return described(d, 'comfy');
  if (looksWebui(d)) return described(d, webuiKind(d));
  // Stability Matrix's Data folder (or its Packages folder): the WebUI inside (Forge first).
  const pk = base === 'packages' ? d : path.join(d, 'Packages');
  if (depth === 0 && isDir(pk)) {
    let found = [];
    try { found = fs.readdirSync(pk, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => inspectFolder(path.join(pk, e.name), 1)).filter((x) => x.ok); } catch {}
    const rank = { forge: 0, reforge: 1, a1111: 2, sdnext: 3, comfy: 4 };
    found.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
    if (found.length) return Object.assign({}, found[0], { others: found.slice(1).map((x) => ({ dir: x.dir, kind: x.kind, label: x.label })) });
  }
  return err('NOT_SD_FOLDER', `That folder doesn't look like Forge, Automatic1111, SD.Next or ComfyUI (there is no launch.py or main.py in it).`, { hint: 'Choose the folder that has launch.py in it. With Stability Matrix it is in its Data folder: Data\\Packages\\stable-diffusion-webui-forge.' });
}
function noPathHelp(kind) {
  const app = appName(kind || 'forge');
  const comfy = kind === 'comfy';
  return {
    message: `AutoInjector doesn't know where ${app} is installed on this PC yet, so it can't put add-ons into it.`,
    fix: comfy
      ? 'Press “📂 Choose the folder…” and pick ComfyUI\'s folder (the one with main.py and custom_nodes in it). AutoInjector remembers it.'
      : `Press “📂 Choose the folder…” and pick ${app}'s folder — the one with launch.py and an “extensions” folder in it. With Stability Matrix it is inside Stability Matrix's Data folder: Data\\Packages\\stable-diffusion-webui-forge (Stability Matrix can open it for you: the ⋮ menu on ${app}'s card). Choosing the whole Data folder works too. AutoInjector remembers it.`,
  };
}
/**
 * Where the add-ons go. o: { chosen (remembered folder), runner (sd-runner status), targets (sd-runner targets()),
 * connected ({ backend, label, base }), targetId }.
 */
function resolveInstall(o = {}) {
  const conn = o.connected || {};
  const wantComfy = conn.backend === 'comfy' ? true : conn.backend === 'a1111' ? false : null;
  const flavor = kindFromLabel(conn.label);
  const cands = [];
  let chosenProblem = null;
  if (o.chosen) {
    const x = inspectFolder(o.chosen);
    if (x.ok) cands.push(Object.assign(x, { source: 'the folder you chose', chosen: true, prio: 3 }));
    else chosenProblem = x;
  }
  const dirOf = (t) => (t && t.dir ? (t.portable ? path.join(t.dir, 'ComfyUI') : t.dir) : null);
  const rt = o.runner && o.runner.target;
  if (rt && rt.dir && o.runner.phase && o.runner.phase !== 'idle') {
    const x = inspectFolder(dirOf(rt), 1);
    if (x.ok) cands.push(Object.assign(x, { source: 'started by AutoInjector', prio: 2, targetId: rt.id }));
  }
  for (const t of o.targets || []) {
    if (!t || t.supported === false) continue;
    const x = inspectFolder(dirOf(t), 1);
    if (x.ok) cands.push(Object.assign(x, { source: t.source || 'found on this PC', prio: t.id && t.id === o.targetId ? 1 : 0, targetId: t.id }));
  }
  const seen = new Set();
  const uniq = cands.filter((c) => { const k = path.resolve(c.dir).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  const fits = (c) => (wantComfy == null ? 1 : (c.kind === 'comfy') === wantComfy ? 1 : 0);
  const flav = (c) => (flavor && c.kind === flavor ? 1 : 0);
  uniq.sort((a, b) => (fits(b) - fits(a)) || (b.prio - a.prio) || (flav(b) - flav(a)) || ((a.kind === 'forge' ? 0 : 1) - (b.kind === 'forge' ? 0 : 1)));
  const best = uniq[0];
  if (!best || !fits(best)) {
    const kind = wantComfy ? 'comfy' : (flavor || 'forge');
    const h = noPathHelp(kind);
    return err('NO_PATH', chosenProblem ? `${chosenProblem.message} ${h.message}` : h.message, { fix: h.fix, kind, label: appName(kind) });
  }
  const others = uniq.slice(1).filter(fits).map((c) => ({ dir: c.dir, kind: c.kind, label: c.label, source: c.source }));
  const out = Object.assign({}, best, { others });
  delete out.prio;
  return out;
}

// ------------------------------------------------------------ what is installed
function gitRemote(dir) {
  let txt = '';
  try { txt = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8'); } catch { return ''; }
  const m = txt.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
  return m ? m[1].trim() : '';
}
const META = '.autoinjector-addon.json';
// What the WebUI ships with (its extensions-builtin) — /sdapi/v1/extensions lists these too; they aren't add-ons.
const BUILTIN_NAMES = new Set(['ldsr', 'lora', 'scunet', 'swinir', 'canvas-zoom-and-pan', 'extra-options-section', 'hypertile', 'mobile', 'postprocessing-for-training', 'prompt-bracket-checker', 'soft-inpainting']);
function isBuiltinName(n) { const s = String(n || '').toLowerCase(); return BUILTIN_NAMES.has(s) || /^(sd_forge_|forge_|forge-|sd-forge-)/.test(s); }
function scanInstalled(inst) {
  const items = [];
  const builtins = [];
  if (!inst || !inst.ok) return { items, builtins };
  let cfg = {};
  if (inst.kind !== 'comfy') cfg = readJson(path.join(inst.dir, 'config.json')) || {};
  const disabled = new Set(Array.isArray(cfg.disabled_extensions) ? cfg.disabled_extensions : []);
  let ents = [];
  try { ents = fs.readdirSync(inst.extDir, { withFileTypes: true }); } catch {}
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === '__pycache__' || e.name === '_removed') continue;
    const p = path.join(inst.extDir, e.name);
    const git = isDir(path.join(p, '.git')) || exists(path.join(p, '.git'));
    const meta = readJson(path.join(p, META)) || {};
    const url = gitRemote(p) || meta.url || '';
    const off = disabled.has(e.name) || /\.disabled$/i.test(e.name);
    items.push({ name: e.name, path: p, git, url, via: git ? 'git' : (meta.via || 'folder'), enabled: !off });
  }
  if (inst.builtinDir) { try { for (const e of fs.readdirSync(inst.builtinDir, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) builtins.push(e.name); } catch {} }
  return { items, builtins };
}
// The app's own list. → { via:'extensions'|'scripts'|'manager'|null, names:[lower], items:[{name,url,enabled}], scripts:[lower] }
async function apiList(base, backend, getJson) {
  const out = { via: null, names: [], items: [], scripts: [] };
  if (!base || typeof getJson !== 'function') return out;
  try {
    if (backend === 'comfy') {
      for (const p of ['/customnode/installed', '/v2/customnode/installed']) {
        const r = await getJson(`${base}${p}`, 6000);
        if (r && r.ok && r.json && typeof r.json === 'object') {
          const ent = Array.isArray(r.json) ? r.json.map((x) => [x && (x.name || x.title || x.id), x]) : Object.entries(r.json);
          out.via = 'manager';
          for (const [k, v] of ent) if (k) { out.items.push({ name: String(k), url: (v && (v.url || v.repository)) || '', enabled: !(v && v.enabled === false) }); out.names.push(String(k).toLowerCase()); }
          return out;
        }
      }
      return out;
    }
    const r = await getJson(`${base}/sdapi/v1/extensions`, 8000);
    if (r && r.ok && Array.isArray(r.json)) {
      out.via = 'extensions';
      for (const x of r.json) if (x && x.name) { out.items.push({ name: String(x.name), url: x.remote || '', enabled: x.enabled !== false, version: x.version || x.commit_hash || '' }); out.names.push(String(x.name).toLowerCase()); }
    }
    const s = await getJson(`${base}/sdapi/v1/scripts`, 8000);
    if (s && s.ok && s.json && typeof s.json === 'object') {
      out.scripts = [...(s.json.txt2img || []), ...(s.json.img2img || [])].map((n) => String(n).toLowerCase());
      if (!out.via) out.via = 'scripts';
    }
  } catch {}
  return out;
}
function matchesCatalog(c, name, url) {
  const n = String(name || '').toLowerCase().replace(/\.disabled$/, '');
  if (n && (n === c.folder.toLowerCase() || (c.aliases || []).includes(n) || n === repoKey(c.url).split('/').pop())) return true;
  const k = url ? repoKey(url) : '';
  return !!k && k === repoKey(c.url);
}

/** What is installed + the curated list. o: { install, base, backend, label, getJson }. */
async function overview(o = {}) {
  const inst = o.install && o.install.ok ? o.install : null;
  const backend = o.backend || (inst ? (inst.kind === 'comfy' ? 'comfy' : 'a1111') : '');
  let kind = inst ? inst.kind : (backend === 'comfy' ? 'comfy' : kindFromLabel(o.label) || (backend ? 'a1111' : 'forge'));
  if (inst && backend && (backend === 'comfy') !== (inst.kind === 'comfy')) kind = backend === 'comfy' ? 'comfy' : (kindFromLabel(o.label) || 'a1111');
  const useDisk = inst && (inst.kind === 'comfy') === (kind === 'comfy');
  const disk = useDisk ? scanInstalled(inst) : { items: [], builtins: [] };
  const api = await apiList(o.base, backend || (kind === 'comfy' ? 'comfy' : 'a1111'), o.getJson);
  const app = useDisk ? inst.label : (kindFromLabel(o.label) ? appName(kindFromLabel(o.label)) : appName(kind));
  const live = api.via === 'extensions' || api.via === 'manager';
  // the installed list: the folder's, plus what only the app listed
  const byName = new Map();
  for (const it of disk.items) byName.set(it.name.toLowerCase(), Object.assign({}, it, { onDisk: true, inApp: live ? api.names.includes(it.name.toLowerCase()) : null }));
  for (const it of api.items) if (!byName.has(it.name.toLowerCase()) && !disk.builtins.includes(it.name) && !isBuiltinName(it.name)) byName.set(it.name.toLowerCase(), Object.assign({}, it, { onDisk: false, inApp: true, git: false }));
  const installed = [...byName.values()].map((it) => {
    const c = catalogFor(kind).find((x) => matchesCatalog(x, it.name, it.url));
    const state = !it.enabled ? 'off' : (it.onDisk && it.inApp === false ? 'restart' : 'on');
    return Object.assign(it, { catalogId: c ? c.id : null, title: c ? c.name : it.name, state, canUpdate: !!it.onDisk, canRemove: !!it.onDisk });
  }).sort((a, b) => a.title.localeCompare(b.title));
  const catalog = catalogFor(kind).map((c) => {
    const row = { id: c.id, name: c.name, what: c.what, url: c.url.replace(/\.git$/, ''), consent: !!c.consent };
    const bi = c.builtin && Object.prototype.hasOwnProperty.call(c.builtin, kind) ? c.builtin[kind] : null;
    // (Forge / reForge / SD.Next ship these themselves — their extensions-builtin folder, or SD.Next's own code)
    if (bi) return Object.assign(row, { state: 'builtin', note: c.builtinNote.replace(/\{app\}/g, app) });
    const it = installed.find((x) => x.catalogId === c.id);
    if (it) return Object.assign(row, { state: it.state === 'restart' ? 'restart' : it.state === 'off' ? 'off' : 'installed', folder: it.name, onDisk: it.onDisk });
    if (!live && api.scripts.length && c.script && api.scripts.some((s) => c.script.test(s))) return Object.assign(row, { state: 'installed', folder: '' });
    if (!c.for.includes(kind)) return Object.assign(row, { state: 'not-for', note: `This one is for ${c.for.map(appName).join(' / ')}, not ${app}.` });
    return Object.assign(row, { state: 'missing' });
  });
  const help = inst ? null : (o.install && o.install.error ? { error: o.install.error, message: o.install.message, fix: o.install.fix } : Object.assign({ error: 'NO_PATH' }, noPathHelp(kind)));
  return {
    ok: true, kind, app, backend: backend || (kind === 'comfy' ? 'comfy' : 'a1111'),
    install: useDisk ? { dir: inst.dir, extDir: inst.extDir, kind: inst.kind, label: inst.label, source: inst.source, chosen: !!inst.chosen, others: inst.others || [] } : null,
    help: useDisk ? null : (help || Object.assign({ error: 'NO_PATH' }, noPathHelp(kind))),
    apiVia: api.via, connected: !!o.base,
    installed, catalog, restartNeeded: installed.some((x) => x.state === 'restart'),
  };
}

// ------------------------------------------------------------ git
function findGit(o = {}) {
  const env = o.env || process.env;
  const win = (o.platform || process.platform) === 'win32';
  const ex = o.exists || exists;
  const c = [];
  if (env.AUTOINJECTOR_GIT) c.push(env.AUTOINJECTOR_GIT);
  for (const lib of o.libraries || []) { const l = typeof lib === 'string' ? lib : lib && lib.library; if (l) c.push(path.join(l, 'PortableGit', 'bin', win ? 'git.exe' : 'git'), path.join(l, 'Assets', 'PortableGit', 'bin', win ? 'git.exe' : 'git')); }
  if (win) {
    for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean)) c.push(path.join(pf, 'Git', 'cmd', 'git.exe'), path.join(pf, 'Git', 'bin', 'git.exe'));
    if (env.LOCALAPPDATA) c.push(path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'));
  }
  for (const d of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) c.push(path.join(d, win ? 'git.exe' : 'git'));
  return c.find((p) => { try { return ex(p); } catch { return false; } }) || null;
}
const PROGRESS_RE = /(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files):\s+(\d+)%/;
const STEP_WORDS = { 'Counting objects': 'Getting ready', 'Compressing objects': 'Getting ready', 'Receiving objects': 'Downloading', 'Resolving deltas': 'Unpacking', 'Updating files': 'Unpacking' };
function runGit(git, args, o = {}) {
  return new Promise((resolve) => {
    let out = '';
    let c;
    const env = Object.assign({}, o.env || process.env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' });
    try { c = (o.spawn || child_process.spawn)(git, args, { cwd: o.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ ok: false, code: null, out: String(e.message || e), spawnError: e.code || 'SPAWN_FAILED' }); }
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { try { c.kill(); } catch {} finish({ ok: false, code: null, out, timedOut: true }); }, o.timeoutMs || 10 * 60 * 1000);
    const add = (b) => {
      const t = b.toString('utf8');
      out = (out + t).slice(-6000);
      if (o.onProgress) for (const line of t.split(/[\r\n]+/)) { const m = line.match(PROGRESS_RE); if (m) o.onProgress({ step: STEP_WORDS[m[1]] || m[1], pct: Number(m[2]) / 100 }); }
    };
    if (c.stdout) c.stdout.on('data', add);
    if (c.stderr) c.stderr.on('data', add);
    c.on('error', (e) => finish({ ok: false, code: null, out: String(e.code || e.message), spawnError: e.code || 'SPAWN_FAILED' }));
    c.on('close', (code) => finish({ ok: code === 0, code, out }));
  });
}
function gitProblem(r, what) {
  const t = String((r && r.out) || '');
  if (r && r.timedOut) return err('TIMEOUT', `${what} took more than 10 minutes, so it was stopped. Check the internet connection and try again.`);
  if (/could not read Username|Repository not found|not found|terminal prompts disabled|Authentication failed/i.test(t)) return err('NOT_FOUND', `GitHub says that add-on doesn't exist (or it is private, or was taken down). Check the link — open it in your browser to see.`, { detail: lastLine(t) });
  if (/Could not resolve host|unable to access|Failed to connect|timed out|Connection (reset|refused)|SSL/i.test(t)) return err('NO_INTERNET', `${what} couldn't reach the internet (GitHub). Check the connection, then try again.`, { detail: lastLine(t) });
  if (/would be overwritten|Not possible to fast-forward|diverging|local changes|uncommitted|unmerged/i.test(t)) return err('LOCAL_CHANGES', `${what} stopped: the add-on's files were changed on this PC, so it can't update itself safely. To get the newest version: Remove it (it is kept in the _removed folder), then Install it again.`, { detail: lastLine(t) });
  if (/Filename too long/i.test(t)) return err('PATH_TOO_LONG', `${what} failed: Windows says a file name is too long. Move Stability Matrix to a shorter folder (for example C:\\SM), or turn on long paths in Windows, then try again.`, { detail: lastLine(t) });
  if (/No space left|not enough space|disk full/i.test(t)) return err('NO_SPACE', `${what} failed: the drive is full. Free some space, then try again.`, { detail: lastLine(t) });
  return err('GIT_FAILED', `${what} failed: ${lastLine(t) || 'git stopped with an error'}.`, { detail: t.slice(-600) });
}
function lastLine(t) { const l = String(t || '').split(/[\r\n]+/).map((x) => x.trim()).filter((x) => x && !PROGRESS_RE.test(x)); return (l[l.length - 1] || '').replace(/^fatal:\s*/i, '').slice(0, 240); }

// ------------------------------------------------------------ zip (no git on this PC)
function extractZip(zip, dest, o = {}) {
  const win = (o.platform || process.platform) === 'win32';
  const tries = win ? [[path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest]]] : [['unzip', ['-q', '-o', zip, '-d', dest]], ['tar', ['-xf', zip, '-C', dest]]];
  return (async () => {
    fs.mkdirSync(dest, { recursive: true });
    let last = '';
    for (const [cmd, args] of tries) { const r = await runGit(cmd, args, { spawn: o.spawn, timeoutMs: 5 * 60 * 1000 }); if (r.ok) return { ok: true }; last = lastLine(r.out) || r.spawnError || ''; }
    return err('UNZIP_FAILED', `The add-on was downloaded but couldn't be unpacked (${last || 'no unzip tool'}).`);
  })();
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
// Move a folder; Windows refuses while files are open (Forge running) → a plain message.
function moveDir(from, to, app) {
  try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); return { ok: true }; }
  catch (e) {
    if (e && (e.code === 'EXDEV')) { try { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); return { ok: true }; } catch (e2) { e = e2; } }
    if (e && /EPERM|EBUSY|EACCES/.test(e.code || '')) return err('IN_USE', `Windows says some of its files are in use. Stop ${app} first (in Stability Matrix, or ⏹ Stop SD here), then try again.`, { detail: e.code });
    return err('MOVE_FAILED', `The folder couldn't be moved (${(e && e.code) || e}).`, { detail: String((e && e.message) || e) });
  }
}
async function fetchByZip(url, into, deps, onProgress) {
  const zurl = zipUrlFor(url);
  if (!zurl) return err('NO_GIT', 'Git is not on this PC, and this add-on can\'t be downloaded as a zip. Install Git for Windows (free, git-scm.com) — or let Stability Matrix install the add-on — then try again.');
  if (typeof deps.download !== 'function') return err('NO_GIT', 'Git is not on this PC. Install Git for Windows (free, git-scm.com), then try again.');
  const work = `${into}.zipwork`;
  rmrf(work);
  fs.mkdirSync(work, { recursive: true });
  const zip = path.join(work, 'addon.zip');
  const d = await deps.download(zurl, zip, { onProgress: (p) => onProgress && onProgress({ step: 'Downloading', pct: p && p.pct }) });
  if (!d || !d.ok) { rmrf(work); return err((d && d.error) || 'DOWNLOAD_FAILED', `The add-on couldn't be downloaded${d && d.message ? `: ${d.message}` : '. Check the internet connection and try again.'}`); }
  if (onProgress) onProgress({ step: 'Unpacking', pct: 1 });
  const unz = path.join(work, 'x');
  const x = await (deps.extract || extractZip)(zip, unz, deps);
  if (!x || !x.ok) { rmrf(work); return x || err('UNZIP_FAILED', 'The add-on couldn\'t be unpacked.'); }
  let top = unz;
  try { const e = fs.readdirSync(unz, { withFileTypes: true }); if (e.length === 1 && e[0].isDirectory()) top = path.join(unz, e[0].name); } catch {}
  const mv = moveDir(top, into, 'the app');
  rmrf(work);
  if (!mv.ok) return mv;
  try { fs.writeFileSync(path.join(into, META), JSON.stringify({ url: url.replace(/\.git$/, ''), via: 'zip', installedAt: new Date().toISOString() }, null, 2)); } catch {}
  return { ok: true, via: 'zip' };
}

// ------------------------------------------------------------ install / update / remove
function safeName(n) { return typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(n) && !n.includes('..'); }
function noInstall(inst) {
  if (inst && inst.error) return err(inst.error, inst.message, { fix: inst.fix });
  const h = noPathHelp('forge');
  return err('NO_PATH', h.message, { fix: h.fix });
}
function tmpDir(inst, name) { return path.join(inst.dir, '_removed', '.incoming', `${name}-${Date.now().toString(36)}`); }
/** what: { id } (from the curated list) or { url } (a link the person pasted). deps: { git, spawn, download, extract, onProgress, now } */
async function install(inst, what = {}, deps = {}) {
  if (!inst || !inst.ok) return noInstall(inst);
  const app = inst.label;
  let url, name, title;
  if (what.id) {
    const c = catalogFor(inst.kind).find((x) => x.id === what.id);
    if (!c) return err('UNKNOWN_ADDON', `There is no add-on “${what.id}” in the list for ${app}.`);
    const bi = c.builtin && c.builtin[inst.kind];
    if (bi) return err('BUILT_IN', `${c.name}: ${c.builtinNote.replace(/\{app\}/g, app)}`);
    if (!c.for.includes(inst.kind)) return err('NOT_FOR', `${c.name} is for ${c.for.map(appName).join(' / ')}, not ${app}.`);
    url = c.url; name = c.folder; title = c.name;
  } else {
    const v = validateRepoUrl(what.url);
    if (!v.ok) return v;
    url = v.url; name = v.name; title = `${v.owner}/${v.repo}`;
  }
  if (!safeName(name)) return err('BAD_LINK', 'That add-on\'s name has characters a folder can\'t have.');
  try { fs.mkdirSync(inst.extDir, { recursive: true }); } catch (e) { return err('NO_ACCESS', `AutoInjector can't write into ${inst.extDir} (${e.code || e}).`); }
  const dest = path.join(inst.extDir, name);
  const key = repoKey(url);
  const already = scanInstalled(inst).items.find((it) => it.name.toLowerCase() === name.toLowerCase() || (key && it.url && repoKey(it.url) === key));
  if (already || exists(dest)) return err('ALREADY_INSTALLED', `${title} is already installed (folder “${(already && already.name) || name}”). Use Update to get its newest version.`, { name: (already && already.name) || name });
  const onP = deps.onProgress || (() => {});
  const tmp = tmpDir(inst, name);
  rmrf(tmp);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  let via = 'git';
  if (deps.git) {
    onP({ step: 'Downloading', pct: 0 });
    const r = await runGit(deps.git, ['-c', 'core.longpaths=true', '-c', 'advice.detachedHead=false', 'clone', '--depth', '1', '--progress', '--', url, tmp], { spawn: deps.spawn, env: deps.env, timeoutMs: deps.timeoutMs, onProgress: onP });
    if (!r.ok && !r.spawnError) { rmrf(tmp); return gitProblem(r, `Installing ${title}`); }
    if (!r.ok) via = 'zip';
  } else via = 'zip';
  if (via === 'zip') {
    rmrf(tmp);
    const z = await fetchByZip(url, tmp, deps, onP);
    if (!z.ok) { rmrf(tmp); return z; }
  }
  const mv = moveDir(tmp, dest, app);
  rmrf(path.join(inst.dir, '_removed', '.incoming'));
  if (!mv.ok) { rmrf(tmp); return mv; }
  onP({ step: 'Done', pct: 1 });
  return { ok: true, name, title, dir: dest, via, restartNeeded: true, message: `✔ ${title} is installed. Restart ${app} to turn it on — the first start after an install can take a few minutes while ${app} sets it up.` };
}
function itemDir(inst, name) {
  if (!safeName(name)) return null;
  const p = path.join(inst.extDir, name);
  return path.dirname(p) === path.resolve(inst.extDir) && isDir(p) ? p : null;
}
async function update(inst, name, deps = {}) {
  if (!inst || !inst.ok) return noInstall(inst);
  const app = inst.label;
  const dir = itemDir(inst, name);
  if (!dir) return err('NOT_INSTALLED', `“${name}” is not in ${app}'s add-ons folder.`);
  const onP = deps.onProgress || (() => {});
  const hasGit = exists(path.join(dir, '.git'));
  if (hasGit && deps.git) {
    onP({ step: 'Downloading', pct: 0 });
    const r = await runGit(deps.git, ['-C', dir, 'pull', '--ff-only', '--progress'], { spawn: deps.spawn, env: deps.env, timeoutMs: deps.timeoutMs, onProgress: onP });
    if (r.ok) {
      onP({ step: 'Done', pct: 1 });
      const same = /Already up[ -]to[ -]date/i.test(r.out);
      return { ok: true, name, updated: !same, restartNeeded: !same, message: same ? `✔ ${name} is already the newest version.` : `✔ ${name} was updated. Restart ${app} to use the new version.` };
    }
    if (!r.spawnError) return gitProblem(r, `Updating ${name}`);
  }
  // No git (or not a git folder): a fresh copy from its zip, the old one kept in _removed.
  const meta = readJson(path.join(dir, META)) || {};
  const url = gitRemote(dir) || meta.url || '';
  if (!url || !zipUrlFor(url)) return err('CANT_UPDATE', hasGit ? 'Git is not on this PC, so it can\'t update this add-on. Install Git for Windows (free, git-scm.com), or Remove it and Install it again.' : `AutoInjector doesn't know where “${name}” came from, so it can't update it. Update it in ${app}'s own Extensions page, or Remove it and install it again.`);
  const tmp = tmpDir(inst, name);
  rmrf(tmp);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  const z = await fetchByZip(url, tmp, deps, onP);
  if (!z.ok) { rmrf(tmp); return z; }
  const old = path.join(inst.dir, '_removed', `${name}-${stamp(deps.now)}`);
  const m1 = moveDir(dir, old, app);
  if (!m1.ok) { rmrf(tmp); return m1; }
  const m2 = moveDir(tmp, dir, app);
  rmrf(path.join(inst.dir, '_removed', '.incoming'));
  if (!m2.ok) { moveDir(old, dir, app); return m2; }
  onP({ step: 'Done', pct: 1 });
  return { ok: true, name, updated: true, restartNeeded: true, keptOld: old, message: `✔ ${name} was updated (a fresh copy; the old one is in ${old}). Restart ${app} to use it.` };
}
async function remove(inst, name, deps = {}) {
  if (!inst || !inst.ok) return noInstall(inst);
  const app = inst.label;
  const dir = itemDir(inst, name);
  if (!dir) return err('NOT_INSTALLED', `“${name}” is not in ${app}'s add-ons folder.`);
  const to = path.join(inst.dir, '_removed', `${name}-${stamp(deps.now)}`);
  const mv = moveDir(dir, to, app);
  if (!mv.ok) return mv;
  return { ok: true, name, movedTo: to, restartNeeded: true, message: `✔ ${name} was taken out — moved to ${to} (nothing was deleted; move it back to undo). Restart ${app} to finish.` };
}

// ------------------------------------------------------------ one job at a time
function createAddonManager(o = {}) {
  let busy = null;
  const log = o.log || (() => {});
  const progress = (p) => { try { if (o.onProgress) o.onProgress(p); } catch {} };
  const deps = (job) => ({
    git: typeof o.git === 'function' ? o.git() : o.git, spawn: o.spawn, env: o.env, download: o.download, extract: o.extract, now: o.now,
    onProgress: (p) => progress(Object.assign({ phase: 'working' }, job, p)),
  });
  const conn = () => (typeof o.connection === 'function' ? o.connection() : o.connection) || {};
  const inst = () => (typeof o.resolve === 'function' ? o.resolve() : o.resolve);
  async function run(job, fn) {
    if (busy) return err('BUSY', `Still working on ${busy.title || busy.name || 'the last add-on'} — wait for it to finish.`);
    busy = job;
    progress(Object.assign({ phase: 'working', step: 'Starting', pct: 0 }, job));
    let r;
    try { r = await fn(deps(job)); } catch (e) { r = err('INTERNAL', `Something went wrong: ${(e && e.message) || e}`); }
    busy = null;
    log('sd-addon', { op: job.op, id: job.id || null, name: job.name || null, custom: !!job.custom, ok: !!r.ok, error: r.ok ? undefined : r.error, via: r.via });
    progress(Object.assign({ phase: r.ok ? 'done' : 'failed', message: r.message, error: r.ok ? null : r.error }, job));
    return r;
  }
  return {
    busy: () => busy,
    overview: async () => { const c = conn(); return overview({ install: inst(), base: c.base, backend: c.backend, label: c.label, getJson: o.getJson }); },
    install: (what = {}) => {
      const i = inst();
      const custom = !what.id;
      const v = custom ? validateRepoUrl(what.url) : null;
      if (v && !v.ok) return Promise.resolve(v);
      const c = what.id && i && i.ok ? catalogFor(i.kind).find((x) => x.id === what.id) : null;
      return run({ op: 'install', id: what.id || null, custom, title: c ? c.name : v ? `${v.owner}/${v.repo}` : what.id }, (d) => install(i, what, d));
    },
    update: (name) => run({ op: 'update', name, title: name }, (d) => update(inst(), name, d)),
    remove: (name) => run({ op: 'remove', name, title: name }, (d) => remove(inst(), name, d)),
  };
}

module.exports = {
  CATALOG, COMFY_CATALOG, FOR_FIELD, LABEL, META, catalogFor, kindFromLabel,
  validateRepoUrl, repoKey, zipUrlFor, inspectFolder, resolveInstall, noPathHelp, scanInstalled, apiList, overview,
  findGit, runGit, gitProblem, extractZip, install, update, remove, createAddonManager, stamp,
};
