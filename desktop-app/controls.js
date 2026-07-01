// controls.js — drives the control panel pane (topic/participants/rounds, live
// transcript, export) and talks to the main process via the window.api bridge from
// preload.js. The three AI panes themselves are separate WebContentsViews positioned
// by main.js, visible directly below this panel.
const SITES = ["chatgpt", "claude", "gemini"];
const SITE_LABELS = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };

let currentTopic = "";
let currentTranscript = [];

const el = (id) => document.getElementById(id);
const setStatus = (s) => { el("status").textContent = s; };
const setRunningUI = (running) => {
  el("btn-start").disabled = running;
  el("btn-stop").disabled = !running;
};

function led(site, ok) {
  el(`led-${site}`).style.background = ok ? "#29c447" : "#444";
}

async function refreshSites() {
  const res = await window.api.listSites();
  if (!res?.ok) return;
  for (const site of SITES) {
    led(site, !!res.sites[site]?.url);
  }
}

function turnEl(turn) {
  const wrap = document.createElement("div");
  wrap.className = `turn ${turn.site}${turn.error ? " error" : ""}`;
  const meta = document.createElement("div");
  meta.className = "meta";
  const ts = turn.ts ? new Date(turn.ts).toLocaleTimeString() : "";
  meta.textContent = turn.error ? `${turn.label} — error (${ts})` : `${turn.label} — ${ts}`;
  const text = document.createElement("div");
  text.className = "text";
  text.textContent = turn.error ? `[${turn.error}]` : turn.text;
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

function appendTurn(turn) {
  currentTranscript.push(turn);
  const box = el("transcript");
  box.appendChild(turnEl(turn));
  box.scrollTop = box.scrollHeight;
}

function selectedParticipants() {
  return SITES.filter((s) => el(`p-${s}`).checked);
}

function buildExportText() {
  const lines = [];
  lines.push("# AI Roundtable Transcript");
  lines.push(`Topic: ${currentTopic || "(none)"}`);
  lines.push(`Generated: ${new Date().toLocaleString()}`);
  lines.push("");
  for (const turn of currentTranscript) {
    const ts = turn.ts ? new Date(turn.ts).toLocaleTimeString() : "";
    lines.push(`## ${turn.label} (${ts})`);
    lines.push(turn.error ? `[error: ${turn.error}]` : turn.text);
    lines.push("");
  }
  return lines.join("\n");
}

window.api.onTurnStart(({ site }) => setStatus(`Waiting on ${SITE_LABELS[site]}…`));
window.api.onTurn((turn) => { appendTurn(turn); setStatus(`Got reply from ${turn.label}.`); });
window.api.onError(({ site, error }) => setStatus(`Error from ${SITE_LABELS[site] || site}: ${error}`));
window.api.onDone(({ stopped }) => { setRunningUI(false); setStatus(stopped ? "Stopped." : "Roundtable finished."); });

document.querySelectorAll("[data-reload]").forEach((btn) => {
  btn.onclick = async () => {
    const site = btn.getAttribute("data-reload");
    await window.api.reloadSite(site);
    setStatus(`Reloading ${SITE_LABELS[site]}…`);
    setTimeout(refreshSites, 1500);
  };
});

el("btn-start").onclick = async () => {
  const participants = selectedParticipants();
  if (participants.length < 2) { setStatus("Pick at least two participants."); return; }
  const topic = el("topic").value.trim();
  if (!topic) { setStatus("Enter a topic or opening message."); return; }
  const starter = el("starter").value;
  const rounds = Number(el("rounds").value) || 3;

  currentTopic = topic;
  renderTranscript([]);
  setRunningUI(true);
  setStatus("Starting…");
  const res = await window.api.startRoundtable({ topic, participants, starter, rounds });
  if (!res?.ok) {
    setRunningUI(false);
    setStatus(`Failed to start: ${res?.error || "unknown error"}`);
  }
};

el("btn-stop").onclick = async () => {
  await window.api.stopRoundtable();
  setStatus("Stopping after the current reply…");
};

el("btn-clear").onclick = async () => {
  const res = await window.api.clearRoundtable();
  if (res?.ok) renderTranscript([]);
  else setStatus(`Could not clear: ${res?.error || "unknown error"}`);
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

(async () => {
  await refreshSites();
  setInterval(refreshSites, 4000);
  const res = await window.api.getRoundtable();
  if (res?.ok && res.roundtable) {
    currentTopic = res.roundtable.topic || currentTopic;
    if (res.roundtable.topic) el("topic").value = res.roundtable.topic;
    if (res.roundtable.starter) el("starter").value = res.roundtable.starter;
    if (res.roundtable.rounds) el("rounds").value = res.roundtable.rounds;
    renderTranscript(res.roundtable.transcript);
    setRunningUI(res.roundtable.running);
    setStatus(res.roundtable.running ? "Roundtable running…" : "Idle.");
  }
})();
