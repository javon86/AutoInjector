// controls.js — builds the merged AI columns (control strip + native pane slot),
// wires the composer/participant/global controls, and reflects live events
// (capture / sent / send-error / waiting-changed / log) from main.js.
const SITES = ["chatgpt", "claude", "gemini"];
const SITE_LABELS = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };
const HOUSE_RULE_LABELS = {
  "who-wants-to-speak": "Who Wants to Speak?",
  "debate": "Debate",
  "free-for-all": "Free-for-All",
  "devil-angel": "Devil & Angel",
  "chargeback": "Chargeback",
  "brainstorm": "Brainstorm",
  "rotation": "Rotation",
  "roundtable": "Roundtable v2"
};
const CHAR_WARN_AT = 2000;
const HIGHLIGHT_MS = 2500;

let currentTranscript = [];
let currentPrompts = [];
let routing = { chatgpt: [], claude: [], gemini: [] };
let enabled = { chatgpt: true, claude: true, gemini: true };

const el = (id) => document.getElementById(id);
const setStatus = (s) => { el("status").textContent = s; };
const otherSites = (site) => SITES.filter((s) => s !== site);

function led(site, ok) {
  const node = document.getElementById(`led-${site}`);
  if (node) node.style.background = ok ? "#29c447" : "#444";
}

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
  all.onclick = () => sendCompose(SITES.filter((s) => enabled[s]));
  box.appendChild(all);
}

async function sendCompose(targets) {
  const text = el("composer-text").value.trim();
  if (!text) { setStatus("Type a message first."); return; }
  if (!targets.length) { setStatus("No enabled participants to send to."); return; }
  setStatus(`Sending to ${targets.map((t) => SITE_LABELS[t]).join(", ")}…`);
  const res = await window.api.sendCompose(text, targets);
  if (!res?.ok) setStatus(`Send failed: ${res?.error || "unknown error"}`);
}

function readPromptFields(card) {
  const text = {};
  for (const site of SITES) {
    const ta = card.querySelector(`textarea[data-site="${site}"]`);
    text[site] = ta ? ta.value : "";
  }
  return text;
}

function promptCardEl(prompt) {
  const card = document.createElement("div");
  card.className = "prompt-card";
  card.dataset.id = prompt.id;

  const head = document.createElement("div");
  head.className = "prompt-card-head";
  const nameInput = document.createElement("input");
  nameInput.className = "prompt-name";
  nameInput.value = prompt.name;
  head.appendChild(nameInput);

  const btns = document.createElement("div");
  btns.className = "btns";
  const sendBtn = document.createElement("button");
  sendBtn.className = "primary";
  sendBtn.textContent = "Send";
  sendBtn.onclick = async () => {
    const text = readPromptFields(card);
    setStatus(`Sending "${nameInput.value}"…`);
    const res = await window.api.sendPrompt(text);
    if (!res?.ok) setStatus(`Send failed: ${res?.error === "NEED_TEXT" ? "no text entered for any AI" : (res?.error || "unknown error")}`);
    else setStatus(`Sent "${nameInput.value}".`);
  };
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.onclick = async () => {
    const text = readPromptFields(card);
    const res = await window.api.savePrompt(prompt.id, nameInput.value, text);
    if (res?.ok) { currentPrompts = res.prompts; setStatus("Prompt saved."); }
  };
  const delBtn = document.createElement("button");
  delBtn.className = "danger";
  delBtn.textContent = "Delete";
  delBtn.onclick = async () => {
    if (!window.confirm(`Delete the "${prompt.name}" prompt?`)) return;
    const res = await window.api.deletePrompt(prompt.id);
    if (res?.ok) renderPrompts(res.prompts);
  };
  btns.appendChild(sendBtn);
  btns.appendChild(saveBtn);
  btns.appendChild(delBtn);
  head.appendChild(btns);
  card.appendChild(head);

  const fields = document.createElement("div");
  fields.className = "prompt-fields";
  for (const site of SITES) {
    const field = document.createElement("div");
    field.className = "prompt-field";
    const label = document.createElement("label");
    label.textContent = SITE_LABELS[site];
    const ta = document.createElement("textarea");
    ta.dataset.site = site;
    ta.value = (prompt.text && prompt.text[site]) || "";
    ta.placeholder = `Leave blank to skip ${SITE_LABELS[site]}`;
    field.appendChild(label);
    field.appendChild(ta);
    fields.appendChild(field);
  }
  card.appendChild(fields);
  return card;
}

function renderPrompts(prompts) {
  currentPrompts = prompts || [];
  const box = el("prompts-list");
  box.innerHTML = "";
  for (const p of currentPrompts) box.appendChild(promptCardEl(p));
}

function buildAiColumn(site) {
  const col = document.createElement("div");
  col.className = `ai-col ${site}`;
  col.id = `col-${site}`;

  const strip = document.createElement("div");
  strip.className = "control-strip";

  const head = document.createElement("div");
  head.className = "card-head";
  head.innerHTML = `<span class="led" id="led-${site}"></span><span class="gendot" id="gendot-${site}"></span><span>${SITE_LABELS[site]}</span><span class="role-badge" id="role-badge-${site}"></span><span class="spacer"></span>`;
  const inspectBtn = document.createElement("button");
  inspectBtn.className = "inspect-btn";
  inspectBtn.textContent = "🔍";
  inspectBtn.title = "Open DevTools on this pane (for fixing selectors)";
  inspectBtn.onclick = () => window.api.inspectSite(site);
  head.appendChild(inspectBtn);
  const reloadBtn = document.createElement("button");
  reloadBtn.className = "reload-btn";
  reloadBtn.textContent = "⟳";
  reloadBtn.title = "Reload this pane";
  reloadBtn.onclick = async () => {
    await window.api.reloadSite(site);
    setStatus(`Reloading ${SITE_LABELS[site]}…`);
    setTimeout(refreshSites, 1500);
  };
  head.appendChild(reloadBtn);
  const collapseBtn = document.createElement("button");
  collapseBtn.className = "collapse-btn";
  collapseBtn.textContent = "⌄";
  collapseBtn.title = "Collapse this pane";
  collapseBtn.onclick = () => toggleColumnCollapse(site);
  head.appendChild(collapseBtn);
  strip.appendChild(head);

  const preview = document.createElement("div");
  preview.className = "preview";
  preview.id = `preview-${site}`;
  preview.textContent = "No reply captured yet.";
  strip.appendChild(preview);

  const fwdRow = document.createElement("div");
  fwdRow.className = "btns fwd-row";
  fwdRow.style.marginTop = "5px";
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
  const regenBtn = document.createElement("button");
  regenBtn.textContent = "↻ Regenerate";
  regenBtn.onclick = async () => {
    setStatus(`Resending ${SITE_LABELS[site]}'s last prompt…`);
    const res = await window.api.regenerate(site);
    if (!res?.ok) setStatus(`Regenerate failed: ${res?.error || "unknown error"}`);
  };
  fwdRow.appendChild(regenBtn);
  strip.appendChild(fwdRow);

  const autoRow = document.createElement("div");
  autoRow.className = "btns auto-row";
  autoRow.innerHTML = `<span class="row-label">Auto:</span>`;
  for (const target of otherSites(site)) {
    const btn = document.createElement("button");
    btn.className = "auto-toggle";
    btn.textContent = `→${SITE_LABELS[target]}`;
    btn.dataset.autoSource = site;
    btn.dataset.autoTarget = target;
    btn.onclick = async () => {
      const wantOn = !btn.classList.contains("on");
      const res = await window.api.setRouting(site, target, wantOn);
      if (res?.ok) applyRouting(res.routing);
    };
    autoRow.appendChild(btn);
  }
  strip.appendChild(autoRow);

  col.appendChild(strip);

  const slot = document.createElement("div");
  slot.className = "pane-slot";
  slot.id = `pane-slot-${site}`;
  col.appendChild(slot);

  return col;
}

function buildAiRow() {
  const box = el("expanded-strip");
  box.innerHTML = "";
  for (const site of SITES) box.appendChild(buildAiColumn(site));
}

// Collapsed panes live in #collapsed-strip (stacked, auto-height bars) and
// expanded ones in #expanded-strip (side by side, sharing whatever room is
// left) — moving a column between the two (appendChild on an already-
// attached node relocates it, no clone needed) is what actually frees up
// vertical space when a pane collapses, rather than just narrowing it in
// place and leaving its full row-height allocation unused.
function relocateColumn(site) {
  const col = el(`col-${site}`);
  if (!col) return;
  const target = col.classList.contains("collapsed") ? el("collapsed-strip") : el("expanded-strip");
  target.appendChild(col);
}

// Purely a visual/layout toggle — collapsing a pane does NOT change whether
// that AI is enabled/participating (that's the separate Participants
// checkbox). syncPaneBounds() in main.js measures pane-slot's real on-screen
// rect every ~700ms and zeroes out the live browser view's bounds once it's
// too small to see, so hiding .pane-slot here is enough to also hide the
// actual embedded browser pane — no main.js change needed for this part.
function toggleColumnCollapse(site) {
  const col = el(`col-${site}`);
  if (!col) return;
  const collapsed = col.classList.toggle("collapsed");
  const btn = col.querySelector(".collapse-btn");
  if (btn) {
    btn.textContent = collapsed ? "›" : "⌄";
    btn.title = collapsed ? "Expand this pane" : "Collapse this pane";
  }
  relocateColumn(site);
  updateAllCollapsedState();
}

// When every AI pane is collapsed there's nothing left to look at up top —
// shrink the AI row down to just the collapsed titlebars and let the
// Transcript/Activity Log panel below grow to fill the freed space, instead
// of leaving it stuck at a fixed height.
function updateAllCollapsedState() {
  const allCollapsed = SITES.every((site) => el(`col-${site}`)?.classList.contains("collapsed"));
  el("wrap").classList.toggle("all-collapsed", allCollapsed);
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

function applyGlobal(global) {
  if (!global) return;
  if (global.routing) applyRouting(global.routing);
  if (global.enabled) {
    enabled = global.enabled;
    for (const site of SITES) {
      el(`p-${site}`).checked = !!enabled[site];
      el(`col-${site}`).classList.toggle("disabled", !enabled[site]);
    }
  }
  if (global.waiting) {
    for (const site of SITES) setGenerating(site, !!global.waiting[site]);
  }
  if (typeof global.meshActive === "boolean") {
    el("mesh-status").textContent = global.meshActive
      ? "Auto is ON — enabled participants keep forwarding replies to each other."
      : "Auto is off.";
  }
}

function setGenerating(site, on) {
  const dot = el(`gendot-${site}`);
  if (dot) dot.classList.toggle("on", on);
}

function applyHouseRule(hr) {
  if (!hr) return;
  for (const site of SITES) {
    const badge = el(`role-badge-${site}`);
    if (badge) badge.textContent = hr.roles && hr.roles[site] ? hr.roles[site].toUpperCase() : "";
  }
  // Once a House Rules format has been picked, its own state machine (or,
  // for Roundtable v2, each AI's own [TO: X] tag) is what decides who gets
  // sent what — the manual per-pane Forward/Auto buttons would just fight
  // it, so hide them for as long as a format is in play (mode stays set
  // through "finished" and Stop; a fresh Start with a different format is
  // what changes it).
  el("ai-row").classList.toggle("hr-active", !!hr.mode);
  if (hr.mode) {
    const label = HOUSE_RULE_LABELS[hr.mode] || hr.mode;
    const roundText = hr.rounds ? `round ${hr.roundNum}/${hr.rounds}` : `round ${hr.roundNum}`;
    const state = hr.active ? "running" : (hr.paused ? "paused" : "finished");
    el("hr-status").textContent = `${label} — ${state} — ${roundText}`;
  } else {
    el("hr-status").textContent = "";
  }
  el("btn-hr-wrapup").style.display = hr.mode === "brainstorm" && hr.active ? "" : "none";
  el("btn-hr-start").disabled = !!hr.active || !!hr.paused;
  el("btn-auto-all").disabled = !!hr.active;
  el("btn-pause-all").disabled = !!hr.active;
}

function flashReceived(site) {
  const col = el(`col-${site}`);
  if (!col) return;
  col.classList.add("just-received");
  clearTimeout(col._flashTimer);
  col._flashTimer = setTimeout(() => col.classList.remove("just-received"), HIGHLIGHT_MS);
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
  const extra = turn.isVerdict ? " verdict" : turn.isFinalPlan ? " final-plan" : "";
  wrap.className = `turn ${turn.site}${turn.pinned ? " pinned" : ""}${extra}`;
  wrap.dataset.turnId = turn.id;
  const meta = document.createElement("div");
  meta.className = "meta";
  const ts = turn.ts ? new Date(turn.ts).toLocaleTimeString() : "";
  const pinBtn = document.createElement("button");
  pinBtn.className = `pin-btn${turn.pinned ? " pinned" : ""}`;
  pinBtn.textContent = "📌";
  pinBtn.title = "Pin this turn";
  pinBtn.onclick = async () => {
    const res = await window.api.togglePin(turn.id);
    if (res?.ok) {
      turn.pinned = res.pinned;
      pinBtn.classList.toggle("pinned", res.pinned);
      wrap.classList.toggle("pinned", res.pinned);
    }
  };
  meta.appendChild(pinBtn);
  meta.appendChild(document.createTextNode(`${turn.label} — ${ts}`));
  if (turn.isVerdict) {
    const b = document.createElement("span");
    b.className = "badge-verdict";
    b.textContent = "🏆 VERDICT";
    meta.appendChild(b);
  }
  if (turn.isFinalPlan) {
    const b = document.createElement("span");
    b.className = "badge-final-plan";
    b.textContent = "✅ FINAL PLAN";
    meta.appendChild(b);
  }
  if (turn.roundtableTag && turn.roundtableTag !== "USER") {
    const label = turn.roundtableTag === "ALL" ? "Everyone" : SITE_LABELS[turn.roundtableTag.toLowerCase()] || turn.roundtableTag;
    const b = document.createElement("span");
    b.className = "badge-roundtable";
    b.textContent = `→ ${label}`;
    meta.appendChild(b);
  }
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
    const marker = turn.pinned ? "📌 " : turn.isVerdict ? "🏆 VERDICT — " : turn.isFinalPlan ? "✅ FINAL PLAN — " : "";
    lines.push(`## ${marker}${turn.label} (${ts})`);
    lines.push(turn.text);
    lines.push("");
  }
  return lines.join("\n");
}

function logLineText(entry) {
  const parts = [];
  if (entry.detail?.mode) parts.push(HOUSE_RULE_LABELS[entry.detail.mode] || entry.detail.mode);
  if (entry.detail?.site) parts.push(entry.detail.site);
  if (entry.detail?.source) parts.push(`${entry.detail.source}->${entry.detail.target}`);
  if (entry.detail?.from) parts.push(`from ${entry.detail.from}`);
  if (entry.detail?.target && entry.kind !== "routing-changed") parts.push(`to ${entry.detail.target}`);
  if (entry.detail?.participants) parts.push(`[${entry.detail.participants.join(", ")}]`);
  if (typeof entry.detail?.enabled === "boolean") parts.push(entry.detail.enabled ? "ON" : "OFF");
  if (entry.detail?.rounds != null) parts.push(`rounds=${entry.detail.rounds}`);
  if (entry.detail?.reason) parts.push(`(${entry.detail.reason})`);
  if (entry.detail?.chars != null) parts.push(`${entry.detail.chars} chars`);
  if (entry.detail?.error) parts.push(`ERROR: ${entry.detail.error}`);
  return `${entry.kind} ${parts.join(" ")}`.trim();
}

function appendLog(entry) {
  const box = el("activity-log");
  const line = document.createElement("div");
  const isErr = entry.kind.includes("error");
  line.className = `log-line${isErr ? " err" : ""}`;
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = new Date(entry.ts).toLocaleTimeString();
  line.appendChild(t);
  line.appendChild(document.createTextNode(logLineText(entry)));
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

async function refreshSites() {
  const res = await window.api.listSites();
  if (!res?.ok) return;
  for (const site of SITES) led(site, !!res.sites[site]?.url);
}

function updateCharCount() {
  const n = el("composer-text").value.length;
  const box = el("char-count");
  box.textContent = `${n} chars`;
  box.classList.toggle("warn", n > CHAR_WARN_AT);
  if (n > CHAR_WARN_AT) box.textContent += " — some sites may truncate very long messages";
}

window.api.onCapture((turn) => {
  renderPreview(turn.site, turn);
  appendTranscriptTurn(turn);
  setStatus(`Captured new reply from ${turn.label}.`);
  beep();
});
window.api.onSent(({ target, from }) => {
  setStatus(from ? `Sent ${SITE_LABELS[from]}'s reply to ${SITE_LABELS[target]}.` : `Sent to ${SITE_LABELS[target]}.`);
  flashReceived(target);
});
window.api.onSendError(({ target, error }) => {
  setStatus(`Error sending to ${SITE_LABELS[target] || target}: ${error}`);
});
window.api.onWaitingChanged(({ site, waiting }) => setGenerating(site, waiting));
window.api.onHouseRuleState(applyHouseRule);
window.api.onLog(appendLog);
window.api.onWindowCollapseChanged(({ which, collapsed }) => {
  if (which !== "automation") return;
  el("wrap").classList.toggle("window-collapsed", collapsed);
  el("btn-collapse-window").textContent = collapsed ? "›" : "⌄";
  el("btn-collapse-window").title = collapsed ? "Expand this window" : "Collapse this window to a titlebar";
});

el("btn-collapse-window").onclick = () => window.api.toggleWindowCollapse("automation");

for (const site of SITES) {
  el(`p-${site}`).onchange = async (e) => {
    const res = await window.api.setParticipant(site, e.target.checked);
    if (res?.ok) applyGlobal(res.global);
  };
}

el("composer-text").addEventListener("input", updateCharCount);

el("btn-auto-all").onclick = async () => {
  const res = await window.api.autoAllRouting();
  if (res?.ok) { applyGlobal(res.global); setStatus("Auto enabled for checked participants."); }
};
el("btn-pause-all").onclick = async () => {
  const res = await window.api.pauseAllRouting();
  if (res?.ok) { applyGlobal(res.global); setStatus("Paused — participant selection kept."); }
};
el("btn-stop-all").onclick = async () => {
  const res = await window.api.stopAllRouting();
  if (res?.ok) { applyGlobal(res.global); setStatus("Stopped — all participants unchecked."); }
  // if a House Rules run was active, main.js follows up with its own
  // houserule-state broadcast (mode kept, active:false) — nothing to force here
};

el("btn-hr-start").onclick = async () => {
  const mode = el("hr-mode").value;
  if (!mode) { setStatus("Pick a House Rules format first."); return; }
  const topic = el("composer-text").value.trim();
  if (!topic) { setStatus("Type a topic/goal in Compose first."); return; }
  const rounds = Number(el("hr-rounds").value) || 0;
  setStatus(`Starting ${HOUSE_RULE_LABELS[mode] || mode}…`);
  const res = await window.api.startHouseRule(mode, topic, rounds);
  if (!res?.ok) {
    setStatus(`Couldn't start: ${res?.error || "unknown error"}`);
  } else {
    applyHouseRule(res.houseRule);
    setStatus(`${HOUSE_RULE_LABELS[mode] || mode} started.`);
  }
};
el("btn-hr-stop").onclick = async () => {
  if (!window.confirm("This will end the House Rules run. You'll need to Start again to resume it. Continue?")) return;
  const res = await window.api.stopHouseRule();
  if (res?.ok) {
    applyHouseRule(res.houseRule);
    applyGlobal(res.global);
    setStatus("House Rules run stopped.");
  }
};
el("btn-hr-wrapup").onclick = async () => {
  const res = await window.api.wrapUpBrainstorm();
  if (!res?.ok) setStatus(`Couldn't wrap up: ${res?.error || "unknown error"}`);
  else setStatus("Wrapping up — asking one participant to synthesize a final plan…");
};

el("btn-prompts-collapse").onclick = () => {
  const collapsed = el("prompts-body").classList.toggle("collapsed");
  el("prompts-hint").classList.toggle("collapsed", collapsed);
  el("btn-prompts-collapse").textContent = collapsed ? "›" : "⌄";
  el("btn-prompts-collapse").title = collapsed ? "Expand the Prompt Library" : "Collapse the Prompt Library";
};

el("btn-prompt-add").onclick = async () => {
  const res = await window.api.savePrompt(null, "New Prompt", { chatgpt: "", claude: "", gemini: "" });
  if (res?.ok) renderPrompts(res.prompts);
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
  buildAiRow();
  updateAllCollapsedState();
  updateCharCount();
  await refreshSites();
  setInterval(refreshSites, 4000);

  const res = await window.api.getState();
  if (res?.ok) {
    applyGlobal(res.global);
    applyHouseRule(res.houseRule);
    renderPrompts(res.prompts);
    renderTranscript(res.transcript);
    for (const entry of res.log || []) appendLog(entry);
    for (const site of SITES) {
      if (res.captured[site]) renderPreview(site, res.captured[site]);
    }
    setStatus("Ready.");
  }
})();
