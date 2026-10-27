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

// ---- Images tab: Stable Diffusion endpoint config + a test render ----
async function loadImageConfig() {
  if (!dl.imageStatus) return;
  try {
    const s = await dl.imageStatus();
    if (!s) return;
    if (el("sd-endpoint")) el("sd-endpoint").value = s.endpoint || "";
    if (el("sd-enabled")) el("sd-enabled").checked = !!s.enabled;
    if (el("sd-steps") && s.steps) el("sd-steps").value = s.steps;
    if (el("sd-width") && s.width) el("sd-width").value = s.width;
    if (el("sd-height") && s.height) el("sd-height").value = s.height;
  } catch (_) {}
}
function imageConfigFromUI() {
  return {
    enabled: !!(el("sd-enabled") && el("sd-enabled").checked),
    endpoint: (el("sd-endpoint") && el("sd-endpoint").value || "").trim(),
    steps: Number(el("sd-steps") && el("sd-steps").value) || 20,
    width: Number(el("sd-width") && el("sd-width").value) || 512,
    height: Number(el("sd-height") && el("sd-height").value) || 512,
  };
}
function sdMsg(t) { if (el("sd-msg")) el("sd-msg").textContent = t; }
if (el("btn-sd-save")) el("btn-sd-save").onclick = async () => {
  if (!dl.configureImage) return;
  const r = await dl.configureImage(imageConfigFromUI());
  sdMsg(r && r.ok ? (r.enabled ? "Saved — image generation is on." : "Saved — image generation is off.") : `Save failed: ${(r && r.error) || "error"}`);
};
if (el("btn-sd-test")) el("btn-sd-test").onclick = async () => {
  if (!dl.configureImage || !dl.imageGenerate) return;
  await dl.configureImage(imageConfigFromUI());
  sdMsg("Rendering a test image…");
  const r = await dl.imageGenerate("a small red apple on a white table, product photo");
  sdMsg(r && r.ok ? `Rendered ✓ → ${r.path}` : `Test failed: ${(r && r.error) || "error"} (is your SD server running with --api?)`);
};

// ---- Video tab: text-to-video endpoint config + check + a test render ----
// Same shape as the Images tab. The backend isn't bundled, so this step is where
// the user points the app at one and proves it works.
async function loadVideoConfig() {
  if (!dl.videoStatus) return;
  try {
    const s = await dl.videoStatus();
    if (!s) return;
    if (el("vd-endpoint")) el("vd-endpoint").value = s.endpoint || "";
    if (el("vd-enabled")) el("vd-enabled").checked = !!s.enabled;
    if (el("vd-width") && s.width) el("vd-width").value = s.width;
    if (el("vd-height") && s.height) el("vd-height").value = s.height;
    if (el("vd-frames") && s.frames) el("vd-frames").value = s.frames;
    if (el("vd-fps") && s.fps) el("vd-fps").value = s.fps;
  } catch (_) {}
}
function videoConfigFromUI() {
  return {
    enabled: !!(el("vd-enabled") && el("vd-enabled").checked),
    endpoint: (el("vd-endpoint") && el("vd-endpoint").value || "").trim(),
    width: Number(el("vd-width") && el("vd-width").value) || 512,
    height: Number(el("vd-height") && el("vd-height").value) || 512,
    frames: Number(el("vd-frames") && el("vd-frames").value) || 16,
    fps: Number(el("vd-fps") && el("vd-fps").value) || 8,
  };
}
function vdMsg(t) { if (el("vd-msg")) el("vd-msg").textContent = t; }
const VD_NO_BACKEND = "No video backend is set up yet. Start a text-to-video server (e.g. AnimateDiff or Stable Video Diffusion) with its API on, then paste its generate URL above.";
if (el("btn-vd-save")) el("btn-vd-save").onclick = async () => {
  if (!dl.configureVideo) return;
  const r = await dl.configureVideo(videoConfigFromUI());
  vdMsg(r && r.ok ? (r.enabled ? "Saved — video generation is on." : "Saved — video generation is off.") : `Save failed: ${(r && (r.message || r.error)) || "error"}`);
};
if (el("btn-vd-check")) el("btn-vd-check").onclick = async () => {
  const cfg = videoConfigFromUI();
  if (!cfg.endpoint) { vdMsg(VD_NO_BACKEND); return; }
  if (!dl.testEndpoint) return;
  vdMsg(`Checking ${cfg.endpoint}…`);
  let r; try { r = await dl.testEndpoint(cfg.endpoint); } catch (_) { r = null; }
  if (r && r.reachable) vdMsg(`Reachable ✓ — something is answering at ${r.base || cfg.endpoint}. Press Test render to confirm it really sends back a video.`);
  else vdMsg(`Nothing is answering at ${(r && r.base) || cfg.endpoint}. Start your video backend with its API turned on, or fix the address.`);
};
if (el("btn-vd-test")) el("btn-vd-test").onclick = async () => {
  if (!dl.configureVideo || !dl.videoGenerate) return;
  const cfg = videoConfigFromUI();
  if (!cfg.endpoint) { vdMsg(VD_NO_BACKEND); return; }
  if (!cfg.enabled) { vdMsg("Tick \"Enable video generation\" first, then press Test render."); return; }
  await dl.configureVideo(cfg);
  vdMsg("Rendering a short test clip… (video can take several minutes)");
  let r; try { r = await dl.videoGenerate("a short test clip: a simple spinning cube"); } catch (e) { r = { ok: false, error: String(e) }; }
  vdMsg(r && r.ok ? `Rendered ✓ → ${r.path || r.url}` : `Test failed: ${(r && (r.message || r.error)) || "error"}`);
};

// Open directly on a requested tab (?tab=images|video|advanced|localai), so the
// Image/Video paddles in the main menu land the user on the right tab.
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
loadImageConfig();
loadVideoConfig();
activateRequestedTab();
