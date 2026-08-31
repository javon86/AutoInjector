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

// ---- Boot ----
loadCatalog();
