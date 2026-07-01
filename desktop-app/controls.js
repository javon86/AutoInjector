// controls.js — builds the per-site routing cards, wires the composer and export
// buttons, and reflects live events (capture / sent / send-error) from main.js.
const SITES = ["chatgpt", "claude", "gemini"];
const SITE_LABELS = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };

let currentTranscript = [];
let routing = { chatgpt: [], claude: [], gemini: [] };

const el = (id) => document.getElementById(id);
const setStatus = (s) => { el("status").textContent = s; };
const otherSites = (site) => SITES.filter((s) => s !== site);

function led(site, ok) {
  const node = document.getElementById(`led-${site}`);
  if (node) node.style.background = ok ? "#29c447" : "#444";
}

function buildComposerButtons() {
  const box = el("composer-buttons");
  box.innerHTML = "";
  for (const site of SITES) {
    const btn = document.createElement("button");
    btn.textContent = `→ ${SITE_LABELS[site]}`;
    btn.onclick = () => sendCompose([site]);
    box.appendChild(btn);
  }
  const all = document.createElement("button");
  all.textContent = "→ All";
  all.onclick = () => sendCompose([...SITES]);
  box.appendChild(all);
}

async function sendCompose(targets) {
  const text = el("composer-text").value.trim();
  if (!text) { setStatus("Type a message first."); return; }
  setStatus(`Sending to ${targets.map((t) => SITE_LABELS[t]).join(", ")}…`);
  const res = await window.api.sendCompose(text, targets);
  if (!res?.ok) setStatus(`Send failed: ${res?.error || "unknown error"}`);
}

function buildCard(site) {
  const card = document.createElement("div");
  card.className = `site-card ${site}`;

  const head = document.createElement("div");
  head.className = "site-card-head";
  head.innerHTML = `<span class="led" id="led-${site}"></span><span>${SITE_LABELS[site]}</span>`;
  const reloadBtn = document.createElement("button");
  reloadBtn.textContent = "⟳";
  reloadBtn.title = "Reload this pane";
  reloadBtn.onclick = async () => {
    await window.api.reloadSite(site);
    setStatus(`Reloading ${SITE_LABELS[site]}…`);
    setTimeout(refreshSites, 1500);
  };
  head.appendChild(reloadBtn);
  card.appendChild(head);

  const preview = document.createElement("div");
  preview.className = "preview";
  preview.id = `preview-${site}`;
  preview.textContent = "No reply captured yet.";
  card.appendChild(preview);

  const fwdRow = document.createElement("div");
  fwdRow.className = "btns";
  fwdRow.innerHTML = `<span class="row-label">Forward:</span>`;
  for (const target of otherSites(site)) {
    const btn = document.createElement("button");
    btn.textContent = `→${SITE_LABELS[target]}`;
    btn.onclick = async () => {
      setStatus(`Forwarding ${SITE_LABELS[site]}'s reply to ${SITE_LABELS[target]}…`);
      const res = await window.api.sendForward(site, [target]);
      if (!res?.ok) setStatus(`Forward failed: ${res?.error || "unknown error"}`);
    };
    fwdRow.appendChild(btn);
  }
  const bothBtn = document.createElement("button");
  bothBtn.textContent = "→Both";
  bothBtn.onclick = async () => {
    setStatus(`Forwarding ${SITE_LABELS[site]}'s reply to both others…`);
    const res = await window.api.sendForward(site, otherSites(site));
    if (!res?.ok) setStatus(`Forward failed: ${res?.error || "unknown error"}`);
  };
  fwdRow.appendChild(bothBtn);
  card.appendChild(fwdRow);

  const autoRow = document.createElement("div");
  autoRow.className = "btns";
  autoRow.innerHTML = `<span class="row-label">Auto:</span>`;
  for (const target of otherSites(site)) {
    const btn = document.createElement("button");
    btn.className = "auto-toggle";
    btn.textContent = `→${SITE_LABELS[target]}`;
    btn.dataset.autoSource = site;
    btn.dataset.autoTarget = target;
    btn.onclick = async () => {
      const enabled = !btn.classList.contains("on");
      const res = await window.api.setRouting(site, target, enabled);
      if (res?.ok) applyRouting(res.routing);
    };
    autoRow.appendChild(btn);
  }
  card.appendChild(autoRow);

  return card;
}

function buildCards() {
  const box = el("col-cards");
  box.innerHTML = "";
  for (const site of SITES) box.appendChild(buildCard(site));
}

function applyRouting(next) {
  routing = next || routing;
  document.querySelectorAll(".auto-toggle").forEach((btn) => {
    const source = btn.dataset.autoSource;
    const target = btn.dataset.autoTarget;
    const on = (routing[source] || []).includes(target);
    btn.classList.toggle("on", on);
  });
}

function renderPreview(site, turn) {
  const box = el(`preview-${site}`);
  if (!box) return;
  const ts = turn.ts ? new Date(turn.ts).toLocaleTimeString() : "";
  box.innerHTML = "";
  const tsEl = document.createElement("span");
  tsEl.className = "ts";
  tsEl.textContent = ts;
  box.appendChild(tsEl);
  box.appendChild(document.createTextNode(turn.text || ""));
}

function turnEl(turn) {
  const wrap = document.createElement("div");
  wrap.className = `turn ${turn.site}`;
  const meta = document.createElement("div");
  meta.className = "meta";
  const ts = turn.ts ? new Date(turn.ts).toLocaleTimeString() : "";
  meta.textContent = `${turn.label} — ${ts}`;
  const text = document.createElement("div");
  text.className = "text";
  text.textContent = turn.text;
  wrap.appendChild(meta);
  wrap.appendChild(text);
  return wrap;
}

function renderTranscript(transcript) {
  currentTranscript = transcript || [];
  const box = el("transcript");
  box.innerHTML = "";
  for (const turn of currentTranscript) box.appendChild(turnEl(turn));
  box.scrollTop = box.scrollHeight;
}

function appendTranscriptTurn(turn) {
  currentTranscript.push(turn);
  const box = el("transcript");
  box.appendChild(turnEl(turn));
  box.scrollTop = box.scrollHeight;
}

function buildExportText() {
  const lines = ["# AI Roundtable Transcript", `Generated: ${new Date().toLocaleString()}`, ""];
  for (const turn of currentTranscript) {
    const ts = turn.ts ? new Date(turn.ts).toLocaleTimeString() : "";
    lines.push(`## ${turn.label} (${ts})`);
    lines.push(turn.text);
    lines.push("");
  }
  return lines.join("\n");
}

async function refreshSites() {
  const res = await window.api.listSites();
  if (!res?.ok) return;
  for (const site of SITES) led(site, !!res.sites[site]?.url);
}

window.api.onCapture((turn) => {
  renderPreview(turn.site, turn);
  appendTranscriptTurn(turn);
  setStatus(`Captured new reply from ${turn.label}.`);
});
window.api.onSent(({ target, from }) => {
  setStatus(from ? `Sent ${SITE_LABELS[from]}'s reply to ${SITE_LABELS[target]}.` : `Sent to ${SITE_LABELS[target]}.`);
});
window.api.onSendError(({ target, error }) => {
  setStatus(`Error sending to ${SITE_LABELS[target] || target}: ${error}`);
});

el("btn-pause-all").onclick = async () => {
  const res = await window.api.pauseAllRouting();
  if (res?.ok) { applyRouting(res.routing); setStatus("All auto-forwarding paused."); }
};

el("btn-copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(buildExportText());
    setStatus("Transcript copied to clipboard.");
  } catch (e) {
    setStatus("Copy failed — select and copy manually from the transcript.");
  }
};

el("btn-download").onclick = () => {
  const blob = new Blob([buildExportText()], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `roundtable-transcript-${Date.now()}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};

el("btn-clear").onclick = async () => {
  const res = await window.api.clearTranscript();
  if (res?.ok) renderTranscript([]);
};

(async () => {
  buildComposerButtons();
  buildCards();
  await refreshSites();
  setInterval(refreshSites, 4000);

  const res = await window.api.getState();
  if (res?.ok) {
    applyRouting(res.routing);
    renderTranscript(res.transcript);
    for (const site of SITES) {
      if (res.captured[site]) renderPreview(site, res.captured[site]);
    }
    setStatus("Ready.");
  }
})();
