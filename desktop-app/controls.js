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
  "rotation": "Rotation"
};
const CHAR_WARN_AT = 2000;
const HIGHLIGHT_MS = 2500;

let currentTranscript = [];
let currentPrompts = [];
let routing = { chatgpt: [], claude: [], gemini: [] };
let enabled = { chatgpt: true, claude: true, gemini: true };
let zoomLevels = { chatgpt: 1, claude: 1, gemini: 1 };
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2;
const PICK_ROLES = ["input", "send", "assistant"];
const PICK_ROLE_LABELS = { input: "Pick Input", send: "Pick Send", assistant: "Pick Reply" };
const PICK_ROLE_TARGET_DESC = { input: "the message box you type into", send: "the Send button", assistant: "the text of a reply" };

const el = (id) => document.getElementById(id);
const setStatus = (s) => { el("status").textContent = s; };
const otherSites = (site) => SITES.filter((s) => s !== site);

// Zooms the actual live embedded page (via Electron's real WebContents zoom
// API in main.js), not the app's own UI — lets more of the real
// chatgpt.com/claude.ai/gemini.google.com conversation fit on screen
// without scrolling, same as Ctrl+- in a normal browser tab.
async function adjustZoom(site, delta) {
  const next = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomLevels[site] + delta)) * 100) / 100;
  const res = await window.api.setZoom(site, next);
  if (res?.ok) {
    zoomLevels[site] = res.factor;
    const label = el(`zoom-level-${site}`);
    if (label) label.textContent = `${Math.round(res.factor * 100)}%`;
  }
}

function togglePickMenu(site) {
  const menu = el(`pick-menu-${site}`);
  if (menu) menu.classList.toggle("collapsed");
}

// The selector picker: pick a role, then click the real element live in that
// site's pane -- main.js captures the next click there and works out a
// selector for it (see automation.js's buildPickScript). No separate "test"
// step; the picked sample text (for a reply) or tag (for input/send) IS the
// confirmation, shown right here.
async function runPick(site, role) {
  const statusEl = el(`pick-status-${site}`);
  const desc = PICK_ROLE_TARGET_DESC[role];
  if (statusEl) statusEl.textContent = `Click ${desc} in ${SITE_LABELS[site]}'s pane now…`;
  setStatus(`Waiting for a click in ${SITE_LABELS[site]}'s pane to pick ${desc}…`);
  const res = await window.api.pickSelector(site, role);
  if (res?.ok) {
    const sample = res.sample ? ` — "${res.sample.slice(0, 60)}${res.sample.length > 60 ? "…" : ""}"` : "";
    if (statusEl) statusEl.textContent = `Picked <${res.tag}> ${res.selector}${sample}`;
    setStatus(`${SITE_LABELS[site]}: picked a new selector for ${desc}.`);
  } else {
    if (statusEl) statusEl.textContent = `Didn't catch a click (${res?.error || "unknown"}). Try again.`;
    setStatus(`${SITE_LABELS[site]}: selector pick failed (${res?.error || "unknown"}).`);
  }
}

async function clearPickOverrides(site) {
  for (const role of PICK_ROLES) await window.api.clearSelectorOverride(site, role);
  const statusEl = el(`pick-status-${site}`);
  if (statusEl) statusEl.textContent = "Overrides cleared — back to the built-in selectors.";
  setStatus(`${SITE_LABELS[site]}: selector overrides cleared.`);
}

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

// The Prompt Library is just a compact dropdown + a few buttons here —
// creating/editing a prompt's actual per-AI text happens in the separate
// popup window (prompt-editor.html), not inline. Saving there broadcasts
// "prompts-changed", which is what keeps this dropdown in sync.
function selectedPrompt() {
  const id = Number(el("prompt-select").value);
  return currentPrompts.find((p) => p.id === id) || null;
}

function updatePromptButtons() {
  const has = !!selectedPrompt();
  el("btn-prompt-send").disabled = !has;
  el("btn-prompt-edit").disabled = !has;
  el("btn-prompt-delete").disabled = !has;
}

function renderPrompts(prompts) {
  currentPrompts = prompts || [];
  const sel = el("prompt-select");
  const prevValue = sel.value;
  sel.innerHTML = "";
  if (!currentPrompts.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no saved prompts)";
    sel.appendChild(opt);
  }
  for (const p of currentPrompts) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  if (currentPrompts.some((p) => String(p.id) === prevValue)) sel.value = prevValue;
  updatePromptButtons();
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
  const zoomOutBtn = document.createElement("button");
  zoomOutBtn.className = "zoom-btn";
  zoomOutBtn.textContent = "－";
  zoomOutBtn.title = "Zoom out this pane (fit more of the real conversation)";
  zoomOutBtn.onclick = () => adjustZoom(site, -ZOOM_STEP);
  head.appendChild(zoomOutBtn);
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "zoom-level";
  zoomLabel.id = `zoom-level-${site}`;
  zoomLabel.textContent = "100%";
  head.appendChild(zoomLabel);
  const zoomInBtn = document.createElement("button");
  zoomInBtn.className = "zoom-btn";
  zoomInBtn.textContent = "＋";
  zoomInBtn.title = "Zoom in this pane";
  zoomInBtn.onclick = () => adjustZoom(site, ZOOM_STEP);
  head.appendChild(zoomInBtn);
  const inspectBtn = document.createElement("button");
  inspectBtn.className = "inspect-btn";
  inspectBtn.textContent = "🔍";
  inspectBtn.title = "Open DevTools on this pane (for fixing selectors)";
  inspectBtn.onclick = () => window.api.inspectSite(site);
  head.appendChild(inspectBtn);
  const pickBtn = document.createElement("button");
  pickBtn.className = "pick-btn";
  pickBtn.textContent = "🎯";
  pickBtn.title = "Fix selectors: pick the real input box / send button / reply text live in this pane -- no DevTools needed";
  pickBtn.onclick = () => togglePickMenu(site);
  head.appendChild(pickBtn);
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

  const pickMenu = document.createElement("div");
  pickMenu.className = "pick-menu collapsed";
  pickMenu.id = `pick-menu-${site}`;
  pickMenu.innerHTML = `<span class="row-label">Fix:</span>`;
  for (const role of PICK_ROLES) {
    const btn = document.createElement("button");
    btn.textContent = PICK_ROLE_LABELS[role];
    btn.onclick = () => runPick(site, role);
    pickMenu.appendChild(btn);
  }
  const clearOverridesBtn = document.createElement("button");
  clearOverridesBtn.textContent = "Clear Overrides";
  clearOverridesBtn.onclick = () => clearPickOverrides(site);
  pickMenu.appendChild(clearOverridesBtn);
  const pickStatus = document.createElement("div");
  pickStatus.className = "pick-status";
  pickStatus.id = `pick-status-${site}`;
  pickMenu.appendChild(pickStatus);
  strip.appendChild(pickMenu);

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
  const autoBothBtn = document.createElement("button");
  autoBothBtn.className = "auto-toggle";
  autoBothBtn.textContent = "→Both";
  autoBothBtn.dataset.autoSource = site;
  autoBothBtn.dataset.autoTarget = "both";
  autoBothBtn.onclick = async () => {
    // On if EITHER individual toggle is currently off, so one click always
    // gets you to "both on" first, and a second click turns both off again
    // — rather than each click only flipping whichever happened to be
    // already-off, which would need three clicks in the worst case.
    const already = otherSites(site).every((t) => (routing[site] || []).includes(t));
    const wantOn = !already;
    for (const target of otherSites(site)) {
      const res = await window.api.setRouting(site, target, wantOn);
      if (res?.ok) applyRouting(res.routing);
    }
  };
  autoRow.appendChild(autoBothBtn);
  strip.appendChild(autoRow);

  col.appendChild(strip);

  const slot = document.createElement("div");
  slot.className = "pane-slot";
  slot.id = `pane-slot-${site}`;
  col.appendChild(slot);

  return col;
}

// A per-AI persona clause (state.customRole in main.js) gets prepended to
// every message sent to that site, regardless of how it's sent (Compose,
// Forward, Auto, a House Rules format, Prompt Library, a Sequence step) —
// see sendTextTo() in main.js. This is the only UI for it now that the
// Conversation window is gone.
function buildRoleAssignment() {
  const box = el("roles-body");
  box.innerHTML = "";
  for (const site of SITES) {
    const row = document.createElement("div");
    row.className = "role-row";

    const label = document.createElement("span");
    label.className = "role-site-label";
    label.textContent = SITE_LABELS[site];
    row.appendChild(label);

    const input = document.createElement("input");
    input.id = `role-${site}`;
    input.placeholder = "e.g. Skeptical Engineer";
    row.appendChild(input);

    const current = document.createElement("span");
    current.className = "role-current";
    current.id = `role-current-${site}`;
    row.appendChild(current);

    const applyBtn = document.createElement("button");
    applyBtn.textContent = "Apply";
    applyBtn.onclick = async () => {
      const role = input.value.trim();
      const res = await window.api.setRole(site, role);
      if (res?.ok) current.textContent = role ? `current: ${role}` : "";
    };
    row.appendChild(applyBtn);

    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear";
    clearBtn.onclick = async () => {
      input.value = "";
      const res = await window.api.setRole(site, "");
      if (res?.ok) current.textContent = "";
    };
    row.appendChild(clearBtn);

    box.appendChild(row);
  }
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
    const on = target === "both"
      ? otherSites(source).every((t) => (routing[source] || []).includes(t))
      : (routing[source] || []).includes(target);
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
  if (global.customRole) {
    for (const site of SITES) {
      const role = global.customRole[site] || "";
      const input = el(`role-${site}`);
      const current = el(`role-current-${site}`);
      if (input) input.value = role;
      if (current) current.textContent = role ? `current: ${role}` : "";
    }
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

el("roles-toggle").onclick = () => {
  const body = el("roles-body");
  const collapsed = body.classList.toggle("collapsed");
  el("roles-toggle-icon").textContent = collapsed ? "▾" : "▴";
};

el("btn-open-sequence").onclick = () => window.api.openSequenceEditor();

el("btn-main-row-collapse").onclick = () => {
  const collapsed = el("main-row").classList.toggle("collapsed");
  el("btn-main-row-collapse").textContent = collapsed ? "›" : "⌄";
  el("btn-main-row-collapse").title = collapsed ? "Expand the Transcript/Log panel" : "Collapse the Transcript/Log panel";
};

for (const site of SITES) {
  el(`p-${site}`).onchange = async (e) => {
    const res = await window.api.setParticipant(site, e.target.checked);
    if (res?.ok) applyGlobal(res.global);
  };
}

el("composer-text").addEventListener("input", updateCharCount);

el("btn-attach-document").onclick = async () => {
  const res = await window.api.chooseDocument();
  if (!res?.ok && res?.error !== "CANCELLED") setStatus(`Couldn't open file picker: ${res?.error || "unknown error"}`);
};

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

el("prompt-select").onchange = updatePromptButtons;

el("btn-prompt-send").onclick = async () => {
  const p = selectedPrompt();
  if (!p) return;
  setStatus(`Sending "${p.name}"…`);
  const res = await window.api.sendPrompt(p.text);
  if (!res?.ok) setStatus(`Send failed: ${res?.error === "NEED_TEXT" ? "that prompt has no text for any AI" : (res?.error || "unknown error")}`);
  else setStatus(`Sent "${p.name}".`);
};

el("btn-prompt-new").onclick = () => window.api.openPromptEditor(null);

el("btn-prompt-edit").onclick = () => {
  const p = selectedPrompt();
  if (p) window.api.openPromptEditor(p.id);
};

el("btn-prompt-delete").onclick = async () => {
  const p = selectedPrompt();
  if (!p) return;
  if (!window.confirm(`Delete the "${p.name}" prompt?`)) return;
  const res = await window.api.deletePrompt(p.id);
  if (res?.ok) renderPrompts(res.prompts);
};

window.api.onPromptsChanged((prompts) => renderPrompts(prompts));

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
  buildRoleAssignment();
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
