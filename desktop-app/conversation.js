// conversation.js — the primary, user-facing window. Renders only what's
// already in state.transcript (main.js guarantees that array never contains
// "UPDATED" acks, RESPOND/UPDATE instructions, or internal automation
// chatter — see pollSite()'s silent-capture handling), plus Send/Start/
// Pause/Resume/Stop and per-AI Role Assignment. Deliberately does NOT surface
// onLog's raw internal text — send-error and the rate-limit/stuck detectors
// are shown as short, generic banners instead (AI name + what to do), never
// the underlying script/selector error text.
const SITES = ["chatgpt", "claude", "gemini"];
const LABELS = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };
const STUCK_THRESHOLD_MS = 3 * 60 * 1000; // "hasn't replied in a while" warning
const STUCK_CHECK_INTERVAL_MS = 15000;

let transcript = [];
let seenIds = new Set();
let hr = { mode: null, active: false, paused: false, pauseReason: null, topic: "", nextSpeaker: null, phase: null, ackPending: [] };
let waitingState = {}; // site -> bool, driven by onWaitingChanged, for the "generating" pulse
let waitingSince = {}; // site -> local Date.now() when waiting started, for stuck detection
let rateLimitBannerShown = false;

function el(id) { return document.getElementById(id); }

// Captured once, up front: renderTranscript() detaches/reattaches this same
// node across renders. Re-querying by ID each time would fail once it's been
// removed — getElementById only finds nodes still in the document.
const emptyTranscriptEl = el("transcript-empty");

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    osc.onended = () => ctx.close();
  } catch {}
}

function showBanner(msg, type) {
  const banner = el("banner");
  banner.querySelector(".msg").textContent = msg;
  banner.classList.remove("error", "warn");
  banner.classList.add("show", type);
}
function hideBanner() {
  el("banner").classList.remove("show");
}
el("btn-banner-dismiss").onclick = () => { rateLimitBannerShown = false; hideBanner(); };

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
  } else if (hr.mode === "roundtable" && hr.phase === "ack") {
    const acked = 3 - (hr.ackPending ? hr.ackPending.length : 0);
    status.textContent = `Waiting for all three AIs to acknowledge the house rules… (${acked}/3)`;
    status.classList.add("running");
  } else if (hr.active) {
    status.textContent = "Running";
    status.classList.add("running");
  } else if (hr.paused) {
    status.textContent = hr.pauseReason === "rate-limit" ? "Paused — usage limit" : "Paused";
    status.classList.add("paused");
  } else {
    status.textContent = "Finished";
  }

  if (hr.pauseReason === "rate-limit") {
    if (!rateLimitBannerShown) {
      rateLimitBannerShown = true;
      showBanner("One of the AIs appears to have hit a usage limit, so the conversation paused itself automatically. Try Resume once it's available again.", "warn");
    }
  } else if (rateLimitBannerShown) {
    rateLimitBannerShown = false;
    hideBanner();
  }
}

function renderSpeakers() {
  const currentSite = transcript.length ? transcript[transcript.length - 1].site : null;
  const nextSite = hr.mode && hr.active ? hr.nextSpeaker : null;
  for (const site of SITES) {
    const chip = document.querySelector(`.speaker-chip[data-site="${site}"]`);
    const tag = chip.querySelector(".tag");
    const roleTag = chip.querySelector(".role-tag");
    chip.classList.toggle("current", site === currentSite);
    chip.classList.toggle("next", site === nextSite && site !== currentSite);
    chip.classList.toggle("generating", !!waitingState[site]);
    tag.textContent = site === nextSite ? "next" : "";
    roleTag.textContent = (hr.roles && hr.roles[site]) ? hr.roles[site].toUpperCase() : "";
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
  if (turn.isRateLimited) div.classList.add("rate-limited");
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = `<span class="dot"></span>${LABELS[turn.site] || turn.label}`;
  if (turn.isRateLimited) {
    const b = document.createElement("span");
    b.className = "badge-rate-limited";
    b.textContent = "⚠ USAGE LIMIT";
    meta.appendChild(b);
  }
  if (turn.roundtableTag && turn.roundtableTag !== "USER") {
    const label = turn.roundtableTag === "ALL" ? "Everyone" : LABELS[turn.roundtableTag.toLowerCase()] || turn.roundtableTag;
    const b = document.createElement("span");
    b.className = "badge-roundtable";
    b.textContent = `→ ${label}`;
    meta.appendChild(b);
  }
  const text = document.createElement("div");
  text.className = "text";
  text.textContent = turn.text;
  div.appendChild(meta);
  div.appendChild(text);
  return div;
}

function renderTranscript() {
  const box = el("transcript");
  if (!transcript.length) {
    if (!emptyTranscriptEl.isConnected) box.appendChild(emptyTranscriptEl);
    return;
  }
  if (emptyTranscriptEl.isConnected) box.removeChild(emptyTranscriptEl);
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

const DEFAULT_TITLE = "AutoInjector — Conversation";

function addTurn(turn) {
  if (seenIds.has(turn.id)) return;
  seenIds.add(turn.id);
  transcript.push(turn);
  renderAll();
  // Only ever reached for genuinely live replies (hydrate() below loads
  // history directly into `transcript`, bypassing this function entirely) —
  // safe to always cue on, no risk of a startup flood of beeps/flashes.
  beep();
  if (!document.hasFocus()) document.title = `🔔 New reply — ${DEFAULT_TITLE}`;
}

async function hydrate() {
  const res = await window.api.getState();
  if (!res || !res.ok) return;
  transcript = res.transcript || [];
  seenIds = new Set(transcript.map((t) => t.id));
  hr = res.houseRule || hr;
  waitingState = (res.global && res.global.waiting) || {};
  for (const site of SITES) {
    const role = (res.global && res.global.customRole && res.global.customRole[site]) || "";
    el(`role-${site}`).value = role;
    el(`role-current-${site}`).textContent = role ? `current: ${role}` : "";
  }
  renderAll();
}

window.addEventListener("focus", () => { document.title = DEFAULT_TITLE; });

window.api.onCapture((turn) => addTurn(turn));
window.api.onHouseRuleState((snapshot) => { hr = snapshot; renderAll(); });
window.api.onWaitingChanged(({ site, waiting }) => {
  waitingState[site] = waiting;
  waitingSince[site] = waiting ? Date.now() : null;
  renderSpeakers();
});
window.api.onSendError(({ target }) => {
  showBanner(`${LABELS[target] || target} had trouble sending or receiving just now — check the Automation window's Activity Log for details.`, "error");
});
setInterval(() => {
  const stuckSite = SITES.find((s) => waitingSince[s] && Date.now() - waitingSince[s] > STUCK_THRESHOLD_MS);
  if (stuckSite) showBanner(`${LABELS[stuckSite]} hasn't replied in a while — it may be stuck. Check the Automation window, or try Pause/Resume.`, "warn");
}, STUCK_CHECK_INTERVAL_MS);
window.api.onWindowCollapseChanged(({ which, collapsed }) => {
  if (which !== "conversation") return;
  el("wrap").classList.toggle("window-collapsed", collapsed);
  el("btn-collapse-window").textContent = collapsed ? "›" : "⌄";
  el("btn-collapse-window").title = collapsed ? "Expand this window" : "Collapse this window to a titlebar";
});

el("btn-collapse-window").onclick = () => window.api.toggleWindowCollapse("conversation");

function currentHopLimit() {
  const n = parseInt(el("hr-hops").value, 10);
  return n > 0 ? n : 24;
}

async function startRoundtable(topic) {
  const res = await window.api.startHouseRule("roundtable", topic, currentHopLimit());
  if (res && res.ok) {
    hr = res.houseRule;
    el("msg-box").value = "";
    renderAll();
  }
  return res;
}

el("btn-send").onclick = async () => {
  const text = el("msg-box").value.trim();
  if (!text) return;
  // Nothing running yet: this first message IS the topic — kick off the full
  // Roundtable v2 house rules automatically instead of making the user click
  // Start separately. Once a run is active or paused, Send goes back to
  // being a plain interjection to all three.
  if (!hr.mode || (!hr.active && !hr.paused)) {
    await startRoundtable(text);
    return;
  }
  await window.api.sendCompose(text, SITES);
  el("msg-box").value = "";
};

el("msg-box").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    el("btn-send").click();
  }
});

el("btn-start").onclick = async () => {
  const topic = el("msg-box").value.trim();
  if (!topic) return;
  await startRoundtable(topic);
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
  if (!window.confirm("This will end the conversation. You'll need to Start again to resume it. Continue?")) return;
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

function buildExportText() {
  const lines = ["# AutoInjector Conversation", `Topic: ${hr.topic || "(none)"}`, `Generated: ${new Date().toLocaleString()}`, ""];
  for (const turn of transcript) {
    const ts = turn.ts ? new Date(turn.ts).toLocaleTimeString() : "";
    const marker = turn.isVerdict ? "🏆 VERDICT — " : turn.isFinalPlan ? "✅ FINAL PLAN — "
      : turn.isRateLimited ? "⚠ USAGE LIMIT — "
      : (turn.roundtableTag && turn.roundtableTag !== "USER") ? `→ ${turn.roundtableTag === "ALL" ? "Everyone" : LABELS[turn.roundtableTag.toLowerCase()] || turn.roundtableTag} — ` : "";
    lines.push(`## ${marker}${LABELS[turn.site] || turn.label} (${ts})`);
    lines.push(turn.text);
    lines.push("");
  }
  return lines.join("\n");
}

el("btn-copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(buildExportText());
  } catch {}
};

el("btn-download").onclick = () => {
  const blob = new Blob([buildExportText()], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `conversation-${Date.now()}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};

hydrate();
