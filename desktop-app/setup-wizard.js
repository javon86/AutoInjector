// setup-wizard.js — renderer for the Setup Wizard window. Helps set up a local
// AI (Ollama) for the optional System AI helper: lists recommended models and
// pulls them via the main process. Model pulls run in the main process, so they
// keep going even if this window is closed.
const el = (id) => document.getElementById(id);
// Escape any dynamic string before it goes into innerHTML (model names, notes).
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// NOTE: don't name this `api` — Electron's contextBridge already exposes a
// global `api`, and a top-level `const api` would throw "already declared".
const dl = window.api || {};

// ---- Tabs ----
for (const tab of document.querySelectorAll(".tab")) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
    for (const p of document.querySelectorAll(".panel")) p.classList.toggle("active", p.id === `panel-${tab.dataset.tab}`);
  };
}

// ---- Catalog ----
let catalog = null;
async function loadCatalog() {
  if (!dl.wizardCatalog) return;
  const c = await dl.wizardCatalog();
  catalog = c && c.ok ? c : null;
  renderOllamaState();
  renderModels();
  renderInstallers();
}

// ---- Advanced tab: guided installers (Ollama) ----
function renderInstallers() {
  const box = el("advanced-installers");
  if (!box) return;
  const inst = catalog && catalog.installers;
  box.innerHTML = "";
  if (!inst) { box.innerHTML = '<div class="muted">Not available.</div>'; return; }
  for (const key of Object.keys(inst)) {
    const it = inst[key];
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `<div style="flex:1 1 auto; min-width:0;"><div class="name">${esc(it.name)}</div><div class="why">${esc(it.note)}</div></div>`;
    // Installs inside AutoInjector (🎬 Video): no web page to open — say where it is.
    if (it.inApp) { const t = document.createElement("span"); t.className = "muted"; t.textContent = "In AutoInjector: 🎬 Video tab → Setup & models"; row.appendChild(t); box.appendChild(row); continue; }
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = `Install ${it.name} ↗`;
    btn.onclick = () => dl.openExternal && dl.openExternal(it.url);
    row.appendChild(btn);
    box.appendChild(row);
  }
}
function renderOllamaState() {
  const box = el("ollama-state");
  if (!box) return;
  const runtime = (document.querySelector('input[name="runtime"]:checked') || {}).value;
  if (runtime !== "ollama") {
    box.textContent = runtime === "openrouter"
      ? "OpenRouter runs in the cloud — no local download; you'll add an API key later."
      : "LM Studio is a separate app — guided install coming in a later step.";
    return;
  }
  const ok = catalog && catalog.ollama && catalog.ollama.available;
  box.innerHTML = "";
  if (ok) { box.textContent = "Ollama is installed ✓ — pick models below to download."; return; }
  box.innerHTML = 'Ollama isn\'t installed yet. Install it, then reopen this wizard. ';
  const btn = document.createElement("button");
  btn.className = "primary";
  btn.textContent = "Install Ollama ↗";
  const url = (catalog && catalog.installers && catalog.installers.ollama && catalog.installers.ollama.url) || "https://ollama.com/download";
  btn.onclick = () => dl.openExternal && dl.openExternal(url);
  box.appendChild(btn);
}
function renderModels() {
  const list = el("model-list");
  if (!list) return;
  list.innerHTML = "";
  const runtime = (document.querySelector('input[name="runtime"]:checked') || {}).value;
  if (runtime !== "ollama") return;
  const models = (catalog && catalog.models) || [];
  if (!models.length) { list.innerHTML = '<div class="muted">No model recommendations available.</div>'; return; }
  for (const m of models) {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `<span class="name">${esc(m.model)}</span><span class="why">recommended local model</span><span class="spacer" style="flex:1"></span>`;
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = "⬇ Download";
    btn.onclick = () => pull(m.model, btn);
    row.appendChild(btn);
    list.appendChild(row);
  }
}
for (const r of document.querySelectorAll('input[name="runtime"]')) {
  r.onchange = () => { renderOllamaState(); renderModels(); };
}

// Pull an Ollama model through the main process (progress streams back).
async function pull(model, btn) {
  if (!dl.ollamaPull) return;
  if (btn) { btn.disabled = true; btn.textContent = "Downloading…"; }
  try {
    const r = await dl.ollamaPull(model);
    if (btn) btn.textContent = r && r.ok ? "Done ✓" : "Failed";
  } catch (_) { if (btn) btn.textContent = "Failed"; }
}
if (dl.onOllamaProgress) {
  dl.onOllamaProgress(({ model, line, done }) => {
    const box = el("ollama-progress");
    if (box) box.textContent = `${model || ""}: ${line || ""}`;
  });
}

// ---- Installs tab: butler self-install (Auto-setup) ----
// The app installs the butler's dependencies itself; the user never types a
// command or a path. Each target shows an install state and a one-click button.
let setupTargets = [];
function setupLog(line) {
  const box = el("setup-progress");
  if (!box) return;
  box.textContent = (box.textContent ? box.textContent + "\n" : "") + line;
  box.scrollTop = box.scrollHeight;
}
function stateBadge(installed) {
  if (installed === true) return '<span style="color:#5ac37a;">installed ✓</span>';
  if (installed === false) return '<span style="color:#e0b055;">not installed</span>';
  return '<span class="muted">—</span>';
}
async function loadSetupTargets() {
  if (!dl.setupList) return;
  try {
    const r = await dl.setupList();
    if (!r || !r.ok) return;
    setupTargets = (r.targets || []).map((t) => ({ ...t, installed: r.status ? r.status[t.id] : null }));
    renderSetupTargets();
  } catch (_) {}
}
function renderSetupTargets() {
  const box = el("setup-targets");
  if (!box) return;
  box.innerHTML = "";
  if (!setupTargets.length) { box.innerHTML = '<div class="muted">Self-install not available.</div>'; return; }
  for (const t of setupTargets) {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `<div style="flex:1 1 auto; min-width:0;"><div class="name">${esc(t.label)}</div><div class="why">${esc(t.note)} &nbsp;${stateBadge(t.installed)}</div></div>`;
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = t.kind === "handoff" ? "Open installer ↗" : "Install";
    btn.dataset.target = t.id;
    btn.onclick = () => installTarget(t.id, btn);
    row.appendChild(btn);
    box.appendChild(row);
  }
}
async function installTarget(target, btn) {
  if (!dl.setupInstall) return;
  if (btn) { btn.disabled = true; btn.textContent = "Installing…"; }
  setupLog(`▶ Installing ${target}…`);
  try {
    const r = await dl.setupInstall(target);
    if (btn) { btn.disabled = false; btn.textContent = r && r.ok ? "Done ✓" : "Retry"; }
  } catch (e) { if (btn) { btn.disabled = false; btn.textContent = "Retry"; } setupLog(`⚠ ${target}: ${e}`); }
  loadSetupTargets();
}
if (el("btn-setup-auto")) el("btn-setup-auto").onclick = async (e) => {
  const btn = e.currentTarget;
  if (!dl.setupAuto) return;
  btn.disabled = true; btn.textContent = "Setting up…";
  setupLog("🚀 Auto-setup started — installing everything the butler needs…");
  try {
    const r = await dl.setupAuto();
    setupLog(r && r.ok ? `✓ Auto-setup done: ${r.installed}/${r.total} installed.` : `⚠ Auto-setup: ${(r && r.error) || "nothing installed"}`);
  } catch (err) { setupLog(`⚠ Auto-setup failed: ${err}`); }
  btn.disabled = false; btn.textContent = "🚀 Auto-setup everything";
  loadSetupTargets();
};
if (el("btn-setup-refresh")) el("btn-setup-refresh").onclick = async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = "Checking…";
  if (dl.setupDetect) { try { const r = await dl.setupDetect(); if (r && r.ok) setupTargets = setupTargets.map((t) => ({ ...t, installed: r.status[t.id] })); } catch (_) {} }
  renderSetupTargets();
  btn.disabled = false; btn.textContent = "Check what's installed";
};
if (dl.onSetupProgress) {
  dl.onSetupProgress(({ target, line }) => { if (line) setupLog(`${target ? target + ": " : ""}${line}`); });
}

// ---- Images / Video tabs: short notes. Pictures and videos are set up in the main window's
// 🎨 Images / 🎬 Video tabs (one place); the button closes this wizard and shows that tab.
function wireAppTabButton(btnId, tab, msgId) {
  const b = el(btnId);
  if (!b) return;
  b.onclick = async () => {
    const say = (t) => { if (el(msgId)) el(msgId).textContent = t; };
    if (typeof dl.openAppTab !== "function") { say("Close this window and click the tab at the top of the main window."); return; }
    let r; try { r = await dl.openAppTab(tab); } catch (e) { r = { ok: false, message: String(e) }; }
    if (!r || !r.ok) say(`Couldn't switch the main window: ${(r && (r.message || r.error)) || "error"}. Close this window and click the tab at the top of the main window.`);
  };
}
wireAppTabButton("btn-wz-open-images", "images", "wz-images-msg");
wireAppTabButton("btn-wz-open-video", "video", "wz-video-msg");

// Open directly on a requested tab (?tab=images|video|advanced|localai), so the
// links (e.g. Alfred's wizard.open) land the user on the right tab.
function activateRequestedTab() {
  try {
    const want = new URLSearchParams(location.search).get("tab");
    if (!want) return;
    const btn = document.querySelector(`.tab[data-tab="${want}"]`);
    if (btn) btn.click();
  } catch (_) {}
}

// ---- Boot ----
loadCatalog();
loadSetupTargets();
activateRequestedTab();
