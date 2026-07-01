// roundtable.js — drives the 3-way ChatGPT/Claude/Gemini roundtable UI
const SITES = ["chatgpt", "claude", "gemini"];
const SITE_LABELS = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };

let currentTopic = "";
let currentTranscript = [];

const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
const el = (id) => document.getElementById(id);
const setStatus = (s) => { el("status").textContent = s; };
const setRunningUI = (running) => {
  el("btn-start").disabled = running;
  el("btn-stop").disabled = !running;
};

function led(site, ok) {
  el(`led-${site}`).style.background = ok ? "#29c447" : "#444";
}

async function refreshTabs() {
  const res = await send({ type: "LIST_AI_TABS" });
  if (!res?.ok) { setStatus("Failed to list tabs."); return; }
  for (const site of SITES) {
    const sel = el(`tabs-${site}`);
    const prev = sel.value;
    sel.innerHTML = "";
    const tabs = res.tabs[site] || [];
    led(site, tabs.length > 0);
    if (!tabs.length) {
      const opt = document.createElement("option");
      opt.value = ""; opt.textContent = "(no tab open)";
      sel.appendChild(opt);
      continue;
    }
    tabs.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.title || t.url;
      sel.appendChild(opt);
    });
    if (prev && tabs.some(t => String(t.id) === prev)) sel.value = prev;
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
  return SITES.filter(s => el(`p-${s}`).checked);
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

// Port for live updates from background.js
const port = chrome.runtime.connect();
port.onMessage.addListener((m) => {
  if (m.type === "ROUNDTABLE_STATE" && m.roundtable) {
    currentTopic = m.roundtable.topic || "";
    if (m.roundtable.topic) el("topic").value = m.roundtable.topic;
    renderTranscript(m.roundtable.transcript);
    setRunningUI(m.roundtable.running);
    setStatus(m.roundtable.running ? "Roundtable running…" : "Idle.");
  }
  if (m.type === "ROUNDTABLE_TURN_START") {
    setStatus(`Waiting on ${SITE_LABELS[m.site]}…`);
  }
  if (m.type === "ROUNDTABLE_TURN") {
    appendTurn(m.turn);
    setStatus(`Got reply from ${m.turn.label}.`);
  }
  if (m.type === "ROUNDTABLE_ERROR") {
    setStatus(`Error from ${SITE_LABELS[m.site] || m.site}: ${m.error}`);
  }
  if (m.type === "ROUNDTABLE_DONE") {
    setRunningUI(false);
    setStatus(m.stopped ? "Stopped." : "Roundtable finished.");
  }
});

el("btn-refresh-tabs").onclick = refreshTabs;
el("btn-open-chatgpt").onclick = async () => { await send({ type: "OPEN_SITE_TAB", site: "chatgpt" }); await refreshTabs(); };
el("btn-open-claude").onclick = async () => { await send({ type: "OPEN_SITE_TAB", site: "claude" }); await refreshTabs(); };
el("btn-open-gemini").onclick = async () => { await send({ type: "OPEN_SITE_TAB", site: "gemini" }); await refreshTabs(); };

el("btn-start").onclick = async () => {
  const participants = selectedParticipants();
  if (participants.length < 2) { setStatus("Pick at least two participants."); return; }
  const topic = el("topic").value.trim();
  if (!topic) { setStatus("Enter a topic or opening message."); return; }
  const starter = el("starter").value;
  const rounds = Number(el("rounds").value) || 3;

  const tabIds = {};
  for (const site of SITES) {
    const v = el(`tabs-${site}`).value;
    tabIds[site] = v ? Number(v) : null;
  }
  await send({ type: "SET_TARGET_TABS", tabIds });

  currentTopic = topic;
  renderTranscript([]);
  setRunningUI(true);
  setStatus("Starting…");
  const res = await send({ type: "START_ROUNDTABLE", topic, participants, starter, rounds });
  if (!res?.ok) {
    setRunningUI(false);
    setStatus(`Failed to start: ${res?.error || "unknown error"}`);
  }
};

el("btn-stop").onclick = async () => {
  await send({ type: "STOP_ROUNDTABLE" });
  setStatus("Stopping after the current reply…");
};

el("btn-clear").onclick = async () => {
  const res = await send({ type: "CLEAR_ROUNDTABLE" });
  if (res?.ok) renderTranscript([]);
  else setStatus(`Could not clear: ${res?.error || "unknown error"}`);
};

el("btn-copy").onclick = async () => {
  const text = buildExportText();
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Transcript copied to clipboard.");
  } catch (e) {
    setStatus("Copy failed — select and copy manually from the transcript.");
  }
};

el("btn-download").onclick = () => {
  const text = buildExportText();
  const blob = new Blob([text], { type: "text/markdown" });
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
  await refreshTabs();
  const res = await send({ type: "GET_ROUNDTABLE" });
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
