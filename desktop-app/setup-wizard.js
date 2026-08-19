// setup-wizard.js — renderer for the Setup Wizard window.
// Reads the hardware scan + machine-matched catalog from the main process,
// lets the user queue downloads (Ollama models to start), and shows a live
// Downloads tray. The actual downloads run in the main process, so they keep
// going even if this window is closed.
const el = (id) => document.getElementById(id);
// NOTE: don't name this `api` — Electron's contextBridge already exposes a
// global `api` in the page, and a top-level `const api` throws "Identifier
// 'api' has already been declared", which would kill this whole script.
const dl = window.api || {};

// ---- Tabs ----
for (const tab of document.querySelectorAll(".tab")) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
    for (const p of document.querySelectorAll(".panel")) p.classList.toggle("active", p.id === `panel-${tab.dataset.tab}`);
  };
}

function fmtSystem(rep) {
  if (!rep) return "Couldn't read your hardware.";
  const s = rep.snapshot || {}, r = rep.recommendation || null;
  if (s.error) return s.error;
  const gpu = (s.gpus && s.gpus[0]) ? `${s.gpus[0].model}${s.gpus[0].vramGB ? ` · ${s.gpus[0].vramGB} GB VRAM` : ""}` : "no dedicated GPU";
  const ram = s.mem && s.mem.totalGB ? `${s.mem.totalGB} GB RAM` : "";
  const line1 = `Your machine: <b>${gpu}</b>${ram ? ` · ${ram}` : ""}`;
  const line2 = r ? `You can comfortably run — local models: <b>${r.llm.tier}</b>; Stable Diffusion: <b>${r.sd.tier}</b>` : "";
  return line2 ? `${line1}<br>${line2}` : line1;
}

// ---- Catalog / model list ----
let catalog = null;
async function loadCatalog() {
  if (!dl.wizardCatalog) return;
  const c = await dl.wizardCatalog();
  catalog = c && c.ok ? c : null;
  el("scan").innerHTML = fmtSystem(catalog && catalog.system);
  renderOllamaState();
  renderModels();
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
  box.innerHTML = ok
    ? "Ollama is installed ✓ — pick models below to download."
    : 'Ollama isn\'t installed yet. Get it from <b>ollama.com</b>, then reopen this wizard. (Guided install coming soon.) You can still queue models; they\'ll download once Ollama is available.';
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
    row.innerHTML = `<span class="name">${m.model}</span><span class="why">recommended for your machine</span><span class="spacer"></span>`;
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = "⬇ Download";
    btn.onclick = () => queue(m, btn);
    row.appendChild(btn);
    list.appendChild(row);
  }
}
for (const r of document.querySelectorAll('input[name="runtime"]')) {
  r.onchange = () => { renderOllamaState(); renderModels(); };
}

async function queue(spec, btn) {
  if (!dl.downloadsEnqueue) return;
  if (btn) { btn.disabled = true; btn.textContent = "Queued ✓"; }
  await dl.downloadsEnqueue({ kind: spec.kind, model: spec.model, label: spec.model, category: spec.category });
  refreshTray();
}

// ---- Downloads tray ----
const STATUS_LABEL = { queued: "queued", running: "downloading", done: "done ✓", failed: "failed", canceled: "canceled" };
function renderJobs(jobs) {
  const list = el("tray-list");
  if (!list) return;
  list.innerHTML = "";
  const active = jobs.filter((j) => j.status === "running" || j.status === "queued").length;
  el("tray-count").textContent = active ? `(${active} active)` : "";
  for (const j of jobs) {
    const box = document.createElement("div");
    box.className = `job ${j.status}`;
    const pct = j.status === "done" ? 100 : (j.progress || 0);
    box.innerHTML =
      `<div class="top"><span class="jname">${j.label}</span>` +
      `<span class="jstatus">${STATUS_LABEL[j.status] || j.status}${j.status === "running" && pct ? ` ${pct}%` : ""}</span>` +
      `<span class="spacer"></span></div>` +
      `<div class="bar"><div class="fill" style="width:${pct}%"></div></div>` +
      `<div class="detail">${(j.detail || "").replace(/</g, "&lt;")}</div>`;
    if (j.status === "running" || j.status === "queued") {
      const x = document.createElement("button");
      x.className = "x"; x.textContent = "✕"; x.title = "Cancel";
      x.onclick = () => dl.downloadsCancel && dl.downloadsCancel(j.id).then(refreshTray);
      box.querySelector(".top").appendChild(x);
    }
    list.appendChild(box);
  }
}
async function refreshTray() {
  if (!dl.downloadsList) return;
  const r = await dl.downloadsList();
  if (r && r.ok) renderJobs(r.jobs);
}
if (dl.onDownloadsChanged) dl.onDownloadsChanged((jobs) => renderJobs(jobs || []));
if (el("btn-clear-finished")) el("btn-clear-finished").onclick = () => dl.downloadsClearFinished && dl.downloadsClearFinished().then(refreshTray);

// ---- Boot ----
loadCatalog();
refreshTray();
