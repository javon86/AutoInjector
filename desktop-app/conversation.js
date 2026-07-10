// conversation.js — the primary, user-facing window. Renders only what's
// already in state.transcript (main.js guarantees that array never contains
// "UPDATED" acks, RESPOND/UPDATE instructions, or internal automation
// chatter — see pollSite()'s silent-capture handling), plus Send/Start/
// Pause/Resume/Stop and per-AI Role Assignment. Deliberately does NOT listen
// to onLog/onSendError/onWaitingChanged's raw text — this window shows the
// clean conversation, not the machinery behind it.
const SITES = ["chatgpt", "claude", "gemini"];
const LABELS = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };

let transcript = [];
let seenIds = new Set();
let hr = { mode: null, active: false, paused: false, topic: "", nextSpeaker: null };

function el(id) { return document.getElementById(id); }

function renderTopic() {
  const line = el("topic-line");
  if (hr.mode && hr.topic) {
    line.textContent = hr.topic;
    line.classList.remove("empty");
  } else {
    line.textContent = "No conversation started yet.";
    line.classList.add("empty");
  }
}

function renderStatus() {
  const status = el("run-status");
  status.classList.remove("running", "paused");
  if (!hr.mode) {
    status.textContent = "Idle";
  } else if (hr.active) {
    status.textContent = "Running";
    status.classList.add("running");
  } else if (hr.paused) {
    status.textContent = "Paused";
    status.classList.add("paused");
  } else {
    status.textContent = "Finished";
  }
}

function renderSpeakers() {
  const currentSite = transcript.length ? transcript[transcript.length - 1].site : null;
  const nextSite = hr.mode && hr.active ? hr.nextSpeaker : null;
  for (const site of SITES) {
    const chip = document.querySelector(`.speaker-chip[data-site="${site}"]`);
    const tag = chip.querySelector(".tag");
    chip.classList.toggle("current", site === currentSite);
    chip.classList.toggle("next", site === nextSite && site !== currentSite);
    tag.textContent = site === nextSite ? "next" : "";
  }
}

function renderButtons() {
  el("btn-start").disabled = !!hr.active || !!hr.paused;
  el("btn-pause").disabled = !hr.active;
  el("btn-resume").disabled = !hr.paused;
  el("btn-stop").disabled = !hr.mode || (!hr.active && !hr.paused);
}

function turnEl(turn) {
  const div = document.createElement("div");
  div.className = `turn ${turn.site}`;
  if (turn.isVerdict) div.classList.add("verdict");
  if (turn.isFinalPlan) div.classList.add("final-plan");
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = `<span class="dot"></span>${LABELS[turn.site] || turn.label}`;
  const text = document.createElement("div");
  text.className = "text";
  text.textContent = turn.text;
  div.appendChild(meta);
  div.appendChild(text);
  return div;
}

function renderTranscript() {
  const box = el("transcript");
  const empty = el("transcript-empty");
  if (!transcript.length) {
    if (!empty.isConnected) box.appendChild(empty);
    return;
  }
  if (empty.isConnected) box.removeChild(empty);
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.innerHTML = "";
  for (const turn of transcript) box.appendChild(turnEl(turn));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderAll() {
  renderTopic();
  renderStatus();
  renderSpeakers();
  renderButtons();
  renderTranscript();
}

function addTurn(turn) {
  if (seenIds.has(turn.id)) return;
  seenIds.add(turn.id);
  transcript.push(turn);
  renderAll();
}

async function hydrate() {
  const res = await window.api.getState();
  if (!res || !res.ok) return;
  transcript = res.transcript || [];
  seenIds = new Set(transcript.map((t) => t.id));
  hr = res.houseRule || hr;
  for (const site of SITES) {
    const role = (res.global && res.global.customRole && res.global.customRole[site]) || "";
    el(`role-${site}`).value = role;
    el(`role-current-${site}`).textContent = role ? `current: ${role}` : "";
  }
  renderAll();
}

window.api.onCapture((turn) => addTurn(turn));
window.api.onHouseRuleState((snapshot) => { hr = snapshot; renderAll(); });

el("btn-send").onclick = async () => {
  const text = el("msg-box").value.trim();
  if (!text) return;
  await window.api.sendCompose(text, SITES);
  el("msg-box").value = "";
};

el("btn-start").onclick = async () => {
  const topic = el("msg-box").value.trim();
  if (!topic) return;
  const res = await window.api.startHouseRule("rotation", topic, 0);
  if (res && res.ok) {
    hr = res.houseRule;
    el("msg-box").value = "";
    renderAll();
  }
};

el("btn-pause").onclick = async () => {
  const res = await window.api.pauseHouseRule();
  if (res && res.ok) { hr = res.houseRule; renderAll(); }
};

el("btn-resume").onclick = async () => {
  const res = await window.api.resumeHouseRule();
  if (res && res.ok) { hr = res.houseRule; renderAll(); }
};

el("btn-stop").onclick = async () => {
  const res = await window.api.stopHouseRule();
  if (res && res.ok) { hr = res.houseRule; renderAll(); }
};

el("roles-toggle").onclick = () => {
  const panel = el("roles-panel");
  panel.classList.toggle("open");
  el("roles-toggle").textContent = panel.classList.contains("open") ? "Role Assignment ▴" : "Role Assignment ▾";
};

document.querySelectorAll(".role-apply").forEach((btn) => {
  btn.onclick = async () => {
    const site = btn.dataset.site;
    const role = el(`role-${site}`).value.trim();
    const res = await window.api.setRole(site, role);
    if (res && res.ok) el(`role-current-${site}`).textContent = role ? `current: ${role}` : "";
  };
});

document.querySelectorAll(".role-clear").forEach((btn) => {
  btn.onclick = async () => {
    const site = btn.dataset.site;
    el(`role-${site}`).value = "";
    const res = await window.api.setRole(site, "");
    if (res && res.ok) el(`role-current-${site}`).textContent = "";
  };
});

hydrate();
