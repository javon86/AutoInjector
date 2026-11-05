// test/sd-addons-panel.test.js — the 🎨 Images tab's 🧩 Add-ons panel (controls.html + images-studio.js) in jsdom
// with a stub window.api.sd: the list with states (built in / installed / restart), Install with progress and
// "🔁 Restart Forge now", the custom link (validated + "only install add-ons you trust"), Update / Remove,
// the no-folder guidance + folder picker, "Open Forge's own Extensions page", and the PR #120 warning's
// "🧩 Install it" link opening the panel on ADetailer.
// Run: node test/sd-addons-panel.test.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function catalog(states) {
  const base = [
    { id: 'adetailer', name: 'ADetailer', what: 'Fixes faces and hands by itself after each picture.', state: 'missing' },
    { id: 'controlnet', name: 'ControlNet', what: 'Copies a pose.', state: 'builtin', note: 'ControlNet is built into Forge already — nothing to install.' },
    { id: 'regional-prompter', name: 'Regional Prompter', what: 'Different words for different parts.', state: 'missing' },
    { id: 'reactor', name: 'ReActor (face swap)', what: 'Puts a face onto another picture. Only use faces of people who said yes.', state: 'missing', consent: true },
  ];
  return base.map((c) => Object.assign({}, c, states && states[c.id] ? states[c.id] : {}));
}
function overview(o = {}) {
  return Object.assign({ ok: true, kind: 'forge', app: 'Forge', backend: 'a1111', connected: true, git: true, canRestart: true, apiVia: 'extensions',
    install: { dir: 'C:/SM/Data/Packages/stable-diffusion-webui-forge', extDir: 'C:/SM/Data/Packages/stable-diffusion-webui-forge/extensions', kind: 'forge', label: 'Forge', source: 'Stability Matrix', chosen: false, others: [] },
    help: null, installed: [], catalog: catalog(), restartNeeded: false }, o);
}

async function load(over = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'controls.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/controls.html' });
  const calls = [];
  let ov = over.ov || overview();
  let onAddons = null;
  const confirms = [];
  const sd = {
    status: async () => ({ ok: true, enabled: true, endpoint: 'http://127.0.0.1:7860/sdapi/v1/txt2img', backend: 'a1111', base: 'http://127.0.0.1:7860', label: 'Forge', steps: 20, cfgScale: 7, width: 512, height: 512, batchSize: 1, seed: -1 }),
    connect: async () => ({ ok: true, kind: 'a1111', label: 'Forge', port: 7860, message: 'Connected to Forge on :7860', status: { enabled: true, endpoint: 'x', backend: 'a1111', base: 'http://127.0.0.1:7860', label: 'Forge' } }),
    lists: async () => ({ ok: true, backend: 'a1111', checkpoints: [{ name: 'dreamshaper_8', title: 'dreamshaper_8' }], loras: [], samplers: [], schedulers: [], vaes: [], embeddings: [], current: { checkpoint: 'dreamshaper_8' } }),
    extras: async () => ({ ok: true, backend: 'a1111', upscalers: [], upscaleModels: [], controlnet: null, adetailer: null, styles: [], scripts: { txt2img: [], img2img: [] }, optionKeys: [], workflows: [] }),
    check: async () => ({ ok: true, warnings: [] }),
    generate: async (req) => { calls.push(['generate', req]); return { ok: true, seed: 7, settings: req, images: [{ path: '/out/sd-7.png', url: 'file:///out/sd-7.png', seed: 7 }], warnings: [{ level: 'hard', kind: 'skipped', field: 'adetailer', message: 'ADetailer (fix faces / hands) was left out: Forge doesn\'t have it, so the picture was made without it. To use it, install ADetailer in the WebUI (Extensions → Available → ADetailer) and restart it.' }] }; },
    progress: async () => ({ ok: true, busy: false }),
    gallery: async () => ({ ok: true, items: [] }), libList: async () => ({ ok: true, items: [], total: 0, collections: [], tags: [], folders: [] }), locks: async () => ({ ok: true, locks: [] }),
    targets: async () => ({ ok: true, targets: [], runner: { phase: 'idle' }, install: { phase: 'idle' } }),
    addons: async () => { calls.push(['addons']); return ov; },
    addonsInstall: async (what) => {
      calls.push(['install', what]);
      if (onAddons) { onAddons({ phase: 'working', op: 'install', title: 'ADetailer', step: 'Downloading', pct: 0.5 }); }
      if (what.url && /missing/.test(what.url)) return { ok: false, error: 'NOT_FOUND', message: 'GitHub says that add-on doesn\'t exist.', overview: ov };
      await tick(30);
      ov = overview({ catalog: catalog({ [what.id || 'regional-prompter']: { state: 'restart', folder: what.id || 'x', onDisk: true } }), installed: [{ name: what.id || 'x', title: 'ADetailer', url: 'https://github.com/Bing-su/adetailer.git', state: 'restart', onDisk: true, canUpdate: true, canRemove: true }], restartNeeded: true });
      return { ok: true, restartNeeded: true, message: '✔ ADetailer is installed. Restart Forge to turn it on.', overview: ov };
    },
    addonsUpdate: async (name) => { calls.push(['update', name]); return { ok: true, message: `✔ ${name} is already the newest version.`, overview: ov }; },
    addonsRemove: async (name) => { calls.push(['remove', name]); ov = overview(); return { ok: true, restartNeeded: true, message: `✔ ${name} was taken out — moved to …/_removed (nothing was deleted).`, overview: ov }; },
    addonsRestart: async () => { calls.push(['restart']); ov = overview({ catalog: catalog({ adetailer: { state: 'installed', folder: 'adetailer', onDisk: true } }), installed: [{ name: 'adetailer', title: 'ADetailer', state: 'on', onDisk: true, canUpdate: true, canRemove: true }] }); return { ok: true, message: '✔ Forge restarted. The new add-ons are loaded.', overview: ov }; },
    addonsOpenPage: async () => { calls.push(['openPage']); return { ok: true, clicked: true, message: 'Opened Forge\'s Extensions page.' }; },
    addonsFolder: async () => { calls.push(['folder']); ov = overview(); return { ok: true, message: '✔ AutoInjector will put add-ons into Forge at C:/SM/…', overview: ov }; },
    addonsOpenFolder: async () => { calls.push(['openFolder']); return { ok: true }; },
    onAddons: (cb) => { onAddons = cb; },
  };
  const sdProxy = new Proxy(sd, { get(t, k) { if (k in t) return t[k]; if (typeof k === 'string' && /^on[A-Z]/.test(k)) return () => {}; return async () => ({ ok: false }); } });
  dom.window.api = new Proxy({ sd: sdProxy, akoweTab: async () => ({}) }, { get(t, k) { if (k in t) return t[k]; if (typeof k === 'string' && /^on[A-Z]/.test(k)) return () => {}; return async () => ({}); } });
  dom.window.confirm = (m) => { confirms.push(m); return over.confirm !== undefined ? over.confirm : true; };
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  try { dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'controls.js'), 'utf8')); } catch (e) { console.log('controls.js threw (ignored for this test):', e.message); }
  dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'images-studio.js'), 'utf8'));
  await tick(30);
  const d = dom.window.document;
  const t = { dom, d, calls, confirms, $: (id) => d.getElementById(id), setOv: (o) => { ov = o; },
    click: (el) => (typeof el === 'string' ? d.getElementById(el) : el).dispatchEvent(new dom.window.Event('click', { bubbles: true })),
    row: (id) => d.querySelector(`#sd-ao-catalog .sd-ao-item[data-id="${id}"]`) };
  return t;
}
const btn = (row, re) => row && [...row.querySelectorAll('button')].find((b) => re.test(b.textContent));

(async () => {
  console.log('== the 🧩 Add-ons panel ==');
  let t = await load();
  t.click('tab-app-images'); await tick(80);
  assert(t.$('sd-sub-addons') && /🧩 Add-ons/.test(t.$('sd-sub-addons').textContent) && t.$('sd-view-addons').hidden, 'the 🧩 Add-ons sub-tab exists; its panel starts hidden');
  t.click('sd-sub-addons'); await tick(60);
  assert(!t.$('sd-view-addons').hidden && t.$('sd-view-generate').hidden && t.calls.some((c) => c[0] === 'addons'), 'clicking it shows the panel and reads the add-ons');
  assert(/Forge/.test(t.$('sd-ao-app').textContent) && /extensions/.test(t.$('sd-ao-where').textContent) && /Stability Matrix/.test(t.$('sd-ao-where').textContent) && t.$('sd-ao-nopath').hidden, 'it says where Forge\'s add-ons folder is (found in Stability Matrix)');
  assert(/✔ built in/.test(t.row('controlnet').textContent) && !btn(t.row('controlnet'), /Install/) && /nothing to install/.test(t.row('controlnet').textContent), 'ControlNet: "✔ built in", no Install button');
  assert(/not installed/.test(t.row('adetailer').textContent) && btn(t.row('adetailer'), /⬇ Install/) && /faces and hands/.test(t.row('adetailer').textContent), 'ADetailer: plain description + ⬇ Install');
  assert(/Open Forge's own Extensions page/.test(t.$('btn-sd-ao-openpage').textContent) && !t.$('btn-sd-ao-openpage').disabled, '"Open Forge\'s own Extensions page ↗" is there');
  assert(/Stability Matrix has its own add-on manager/.test(t.$('sd-view-addons').textContent), 'Stability Matrix\'s own extension manager is mentioned');

  console.log('== install + restart ==');
  t.click(btn(t.row('adetailer'), /⬇ Install/)); await tick(5);
  assert(!t.$('sd-ao-progress').hidden && /Installing ADetailer… Downloading 50%/.test(t.$('sd-ao-msg').textContent), `progress while it installs (“${t.$('sd-ao-msg').textContent}”)`);
  await tick(80);
  assert(t.calls.some((c) => c[0] === 'install' && c[1].id === 'adetailer') && /✔ ADetailer is installed/.test(t.$('sd-ao-msg').textContent) && t.$('sd-ao-progress').hidden, 'Install → installed message, the bar goes away');
  assert(/restart Forge to turn it on/.test(t.row('adetailer').textContent) && !t.$('sd-ao-restart').hidden && /Restart Forge now/.test(t.$('btn-sd-ao-restart').textContent) && !t.$('btn-sd-ao-restart').hidden, '"⏳ restart Forge to turn it on" + "🔁 Restart Forge now"');
  t.click('btn-sd-ao-restart'); await tick(80);
  assert(t.calls.some((c) => c[0] === 'restart') && /✔ Forge restarted/.test(t.$('sd-ao-msg').textContent) && /✔ installed/.test(t.row('adetailer').textContent) && t.$('sd-ao-restart').hidden, 'Restart → re-checked: ADetailer ✔ installed, the restart box goes away');
  assert(/✔ on/.test(t.$('sd-ao-installed').textContent), 'the Installed list shows it ✔ on');

  console.log('== update / remove ==');
  const irow = t.d.querySelector('#sd-ao-installed .sd-ao-item[data-name="adetailer"]');
  t.click(btn(irow, /Update/)); await tick(40);
  assert(t.calls.some((c) => c[0] === 'update' && c[1] === 'adetailer') && /newest version/.test(t.$('sd-ao-msg').textContent), 'Update → git pull, plain result');
  t.click(btn(t.d.querySelector('#sd-ao-installed .sd-ao-item[data-name="adetailer"]'), /Remove/)); await tick(40);
  assert(t.confirms.some((m) => /nothing is deleted/.test(m)) && t.calls.some((c) => c[0] === 'remove' && c[1] === 'adetailer') && /_removed/.test(t.$('sd-ao-msg').textContent), 'Remove asks first ("nothing is deleted"), then moves it to _removed');

  console.log('== install from a link ==');
  t.$('sd-ao-url').value = 'https://example.com/a/b';
  t.click('btn-sd-ao-url'); await tick(20);
  assert(/Only https:\/\/github\.com/.test(t.$('sd-ao-msg').textContent) && !t.calls.some((c) => c[0] === 'install' && c[1].url), 'a non-GitHub link → refused right away');
  const nConf = t.confirms.length;
  t.$('sd-ao-url').value = 'https://github.com/hako-mikan/sd-webui-regional-prompter';
  t.click('btn-sd-ao-url'); await tick(80);
  assert(t.confirms.length === nConf + 1 && /only install add-ons you trust/i.test(t.confirms[t.confirms.length - 1]) && /hako-mikan\/sd-webui-regional-prompter/.test(t.confirms[t.confirms.length - 1]), 'a GitHub link → "only install add-ons you trust" confirmation first');
  assert(t.calls.some((c) => c[0] === 'install' && c[1].url === 'https://github.com/hako-mikan/sd-webui-regional-prompter') && t.$('sd-ao-url').value === '', 'then it installs (the box is cleared)');
  t.$('sd-ao-url').value = 'https://github.com/someone/missing-addon';
  t.click('btn-sd-ao-url'); await tick(60);
  assert(/✖ GitHub says that add-on doesn't exist/.test(t.$('sd-ao-msg').textContent), 'a link to nothing → the plain error');
  // ReActor: the consent note before installing; "no" → nothing happens
  let t2 = await load({ confirm: false });
  t2.click('tab-app-images'); await tick(60); t2.click('sd-sub-addons'); await tick(60);
  t2.click(btn(t2.row('reactor'), /Install/)); await tick(40);
  assert(t2.confirms.some((m) => /people who agreed/.test(m)) && !t2.calls.some((c) => c[0] === 'install'), 'ReActor asks about consent first; "no" installs nothing');
  t2.$('sd-ao-url').value = 'https://github.com/a/b';
  t2.click('btn-sd-ao-url'); await tick(40);
  assert(!t2.calls.some((c) => c[0] === 'install'), 'a custom link the person doesn\'t confirm is not installed');

  console.log('== no folder known ==');
  const help = { error: 'NO_PATH', message: 'AutoInjector doesn\'t know where Forge is installed on this PC yet, so it can\'t put add-ons into it.', fix: 'Press “📂 Choose the folder…” and pick Forge\'s folder — the one with launch.py … Data\\Packages\\stable-diffusion-webui-forge … AutoInjector remembers it.' };
  t2 = await load({ ov: overview({ install: null, help, canRestart: false }) });
  t2.click('tab-app-images'); await tick(60); t2.click('sd-sub-addons'); await tick(60);
  assert(!t2.$('sd-ao-nopath').hidden && /doesn't know where Forge is installed/.test(t2.$('sd-ao-nopath').textContent) && /launch\.py/.test(t2.$('sd-ao-nopath').textContent), 'the plain "how to point AutoInjector at Forge\'s folder" note');
  assert(btn(t2.row('adetailer'), /Install/).disabled && /Choose Forge's folder/.test(t2.$('btn-sd-ao-folder').textContent) && t2.$('btn-sd-ao-openfolder').hidden, 'Install waits for the folder; "📂 Choose Forge\'s folder…"');
  t2.click('btn-sd-ao-folder'); await tick(60);
  assert(t2.calls.some((c) => c[0] === 'folder') && t2.$('sd-ao-nopath').hidden && /✔ AutoInjector will put add-ons into Forge/.test(t2.$('sd-ao-msg').textContent) && !btn(t2.row('adetailer'), /Install/).disabled, 'choosing the folder → remembered, Install works');
  // started outside AutoInjector: no restart button, plain "restart it in Stability Matrix"
  t2.setOv(overview({ canRestart: false, restartNeeded: true, catalog: catalog({ adetailer: { state: 'restart', folder: 'adetailer', onDisk: true } }) }));
  t2.click('btn-sd-ao-refresh'); await tick(60);
  assert(!t2.$('sd-ao-restart').hidden && t2.$('btn-sd-ao-restart').hidden && /restart it in Stability Matrix \(Stop, then Launch\)/.test(t2.$('sd-ao-restart-note').textContent), 'Forge started in Stability Matrix → "restart it in Stability Matrix (Stop, then Launch)"');

  console.log('== Open Forge\'s own Extensions page ==');
  t2.click('btn-sd-ao-openpage'); await tick(40);
  assert(t2.calls.some((c) => c[0] === 'openPage') && /Opened Forge's Extensions page/.test(t2.$('sd-ao-msg').textContent), 'it opens the in-app window on its Extensions tab');

  console.log('== PR #120: the skipped-ADetailer warning links here ==');
  t = await load();
  t.click('tab-app-images'); await tick(120);
  t.$('sd-prompt').value = 'a lighthouse';
  t.click('btn-sd-generate'); await tick(150);
  assert(/ADetailer \(fix faces \/ hands\) was left out/.test(t.$('sd-msg').textContent), 'Generate shows the #120 warning');
  const link = t.d.querySelector('#sd-msg-addons button[data-addon="adetailer"]');
  assert(!t.$('sd-msg-addons').hidden && link && /🧩 Install it/.test(link.textContent), 'with a "🧩 Install it" link');
  t.click(link); await tick(80);
  assert(!t.$('sd-view-addons').hidden && t.row('adetailer') && t.row('adetailer').dataset.focus === '1' && /ADetailer: press ⬇ Install/.test(t.$('sd-ao-msg').textContent), 'the link opens 🧩 Add-ons on ADetailer (highlighted, with what to press)');
  assert(t.$('btn-sd-ad-install') && !t.$('btn-sd-ad-install').hidden, 'the ADetailer section\'s "not installed" note has "🧩 Install it" too');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
