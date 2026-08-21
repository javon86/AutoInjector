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
  "blind-round": "Blind Round"
};
const CHAR_WARN_AT = 2000;
const HIGHLIGHT_MS = 2500;

let currentTranscript = [];
const lastReplyBySite = {}; // most recent reply text per AI, for "use as image prompt"
let currentPrompts = [];
let routing = { chatgpt: [], claude: [], gemini: [] };
let enabled = { chatgpt: true, claude: true, gemini: true };
let zoomLevels = { chatgpt: 1, claude: 1, gemini: 1 };

// Each AI pane has three states, cycled in this order. The button's glyph and
// tooltip always describe what the NEXT click does.
const PANE_STATES = ["open", "reduced", "min"];
const STATE_GLYPH = { open: "⌄", reduced: "▁", min: "▸" };
const STATE_TITLE = {
  open: "Open — showing the website. Click to reduce (hide the site, keep the reply area).",
  reduced: "Reduced — website hidden, replies shown. Click to minimize to a bar.",
  min: "Minimized. Click anywhere on the bar to open fully.",
};
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
    const REJECT_REASONS = {
      NOT_FOUND: "the generated selector doesn't actually match the clicked element — try clicking again",
      NOT_VISIBLE: "the clicked element is hidden or zero-size — try clicking the visible part of it",
      WRONG_ELEMENT_TYPE: `that doesn't look like ${desc} — try clicking more precisely`,
      LOOKS_LIKE_ECHO: "that looks like it's just the last message sent, not a real reply — try clicking the actual reply text"
    };
    const reason = REJECT_REASONS[res?.error] || `didn't catch a click (${res?.error || "unknown"})`;
    if (statusEl) statusEl.textContent = `Pick rejected: ${reason}. Try again.`;
    setStatus(`${SITE_LABELS[site]}: selector pick failed (${res?.error || "unknown"}).`);
  }
}

async function clearPickOverrides(site) {
  for (const role of PICK_ROLES) await window.api.clearSelectorOverride(site, role);
  const statusEl = el(`pick-status-${site}`);
  if (statusEl) statusEl.textContent = "Overrides cleared — back to the built-in selectors.";
  setStatus(`${SITE_LABELS[site]}: selector overrides cleared.`);
}

function toggleLoginMenu(site) {
  const menu = el(`login-menu-${site}`);
  if (menu) menu.classList.toggle("collapsed");
}

// Saved logins: purely manual and one-click, never auto-triggered. Renders
// the saved list for one site (label + username only -- the password never
// leaves main.js, not even to render here) with a Fill button per entry.
function renderLoginList(site, logins) {
  const list = el(`login-list-${site}`);
  if (!list) return;
  list.textContent = "";
  if (!logins || !logins.length) {
    list.textContent = "No saved logins yet.";
    return;
  }
  for (const entry of logins) {
    const row = document.createElement("div");
    row.className = "login-row";
    const fillBtn = document.createElement("button");
    fillBtn.textContent = `🔑 ${entry.label} (${entry.username})`;
    fillBtn.onclick = () => runFillLogin(site, entry.id, entry.label);
    row.appendChild(fillBtn);
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "✕";
    deleteBtn.title = `Delete "${entry.label}"`;
    deleteBtn.onclick = async () => {
      const res = await window.api.deleteLogin(site, entry.id);
      if (res?.ok) renderLoginList(site, res.logins);
    };
    row.appendChild(deleteBtn);
    list.appendChild(row);
  }
}

function applyLogins(loginsBySite) {
  for (const site of SITES) renderLoginList(site, loginsBySite?.[site]);
}

async function saveNewLogin(site) {
  const label = el(`login-label-${site}`).value.trim();
  const username = el(`login-username-${site}`).value.trim();
  const password = el(`login-password-${site}`).value;
  const statusEl = el(`login-status-${site}`);
  const res = await window.api.saveLogin(site, label, username, password);
  if (res?.ok) {
    renderLoginList(site, res.logins);
    el(`login-label-${site}`).value = "";
    el(`login-username-${site}`).value = "";
    el(`login-password-${site}`).value = "";
    el(`login-add-form-${site}`).classList.add("collapsed");
    if (statusEl) statusEl.textContent = `Saved "${label}".`;
    setStatus(`${SITE_LABELS[site]}: saved login "${label}".`);
  } else {
    const reason = res?.error === "ENCRYPTION_UNAVAILABLE"
      ? "this system can't provide secure credential storage right now"
      : res?.error === "NEEDS_LABEL" ? "give it a label first"
      : res?.error === "NEEDS_USERNAME" ? "enter a username/email first"
      : res?.error === "NEEDS_PASSWORD" ? "enter a password first"
      : res?.error || "unknown error";
    if (statusEl) statusEl.textContent = `Couldn't save: ${reason}.`;
    setStatus(`${SITE_LABELS[site]}: couldn't save login (${reason}).`);
  }
}

// Fills in whatever login field(s) are actually on screen right now and
// clicks Sign In -- real logins for these sites are often multi-step, so a
// "SUBMIT_NOT_FOUND" or a fill that only touched the username field is
// expected mid-flow, not necessarily a failure: click the same saved login
// again once the next step (e.g. the password screen) appears.
async function runFillLogin(site, id, label) {
  const statusEl = el(`login-status-${site}`);
  if (statusEl) statusEl.textContent = `Filling in "${label}"…`;
  setStatus(`${SITE_LABELS[site]}: filling in saved login "${label}"…`);
  const res = await window.api.fillLogin(site, id);
  if (res?.ok) {
    const what = (res.filled || []).join(" + ") || "nothing";
    const submitNote = res.submitted ? "and clicked Sign In" : res.warning === "SUBMIT_NOT_FOUND" ? "but couldn't find a Sign In button to click" : "";
    if (statusEl) statusEl.textContent = `Filled ${what} ${submitNote}.`.replace(/\s+/g, " ").trim();
    setStatus(`${SITE_LABELS[site]}: filled in "${label}"${res.submitted ? " and submitted" : ""}. If this site logs in over multiple steps, click it again once the next screen appears.`);
  } else {
    const reason = res?.error === "NO_LOGIN_FORM_FOUND" ? "no login form found on screen right now" : res?.error || "unknown error";
    if (statusEl) statusEl.textContent = `Couldn't fill in "${label}": ${reason}.`;
    setStatus(`${SITE_LABELS[site]}: couldn't fill in "${label}" (${reason}).`);
  }
}

function setTestLed(site, resultState) {
  const dot = el(`test-led-${site}`);
  if (!dot) return;
  dot.classList.remove("pending", "ok", "fail");
  if (resultState) dot.classList.add(resultState);
  const titles = { pending: "Connectivity test: running…", ok: "Connectivity test: passed", fail: "Connectivity test: failed" };
  dot.title = titles[resultState] || "Connectivity test: not run yet";
}

// Sends a real prompt carrying a fresh token and waits for it to actually
// come back -- this is a genuine round-trip check (send AND read both have
// to work, with the right content), not just "did something happen."
async function runSelfTest(site) {
  const statusEl = el(`pick-status-${site}`);
  setTestLed(site, "pending");
  if (statusEl) statusEl.textContent = `Testing ${SITE_LABELS[site]}: sent a prompt, waiting for it to reply back…`;
  setStatus(`Testing ${SITE_LABELS[site]}'s connection — this can take up to 45s…`);
  const res = await window.api.runSelfTest(site);
  if (res?.ok) {
    setTestLed(site, "ok");
    if (statusEl) statusEl.textContent = `✅ ${SITE_LABELS[site]} is hooked up correctly — it replied with exactly what was asked.`;
    setStatus(`${SITE_LABELS[site]}: connectivity test passed.`);
  } else {
    setTestLed(site, "fail");
    const sample = res?.text ? ` It actually captured: "${res.text.slice(0, 80)}${res.text.length > 80 ? "…" : ""}"` : "";
    const reason = res?.error === "SELECTOR_TOO_BROAD"
      ? `the reply selector is reading BOTH the sent prompt and the actual reply — it's too broad and needs to be picked more precisely.${sample}`
      : res?.error === "REPLY_ECHO"
        ? `nothing came back but an echo of what was sent — the reply selector is likely reading the outgoing message, not the actual reply.${sample}`
        : res?.error === "REPLY_MISMATCH"
          ? `it replied, but not with what was asked — reading may be picking up the wrong text.${sample}`
          : res?.error === "TIMEOUT"
            ? "no reply arrived in time"
            : res?.error === "ALREADY_RUNNING"
              ? "a test is already running for this site"
              : `sending failed (${res?.error || "unknown error"})`;
    if (statusEl) statusEl.textContent = `❌ ${SITE_LABELS[site]}: ${reason}`;
    setStatus(`${SITE_LABELS[site]}: connectivity test failed — ${res?.error || "error"}.`);
  }
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

// Send + Active as a real two-column grid: SEND / ACTIVE headers already
// sit in the HTML as the grid's first two children, then one row per AI
// (that AI's send button in column 1, its own checkbox row-aligned in
// column 2) gets appended after them, then → All on its own row spanning
// just the Send column. The checkboxes are built here (not static HTML) so
// their onchange wiring can live right next to where they're created,
// instead of a second pass that has to run after this one.
function buildComposerButtons() {
  const grid = el("send-active-grid");
  while (grid.children.length > 2) grid.removeChild(grid.lastChild); // keep the two header labels, rebuild the rows
  for (const site of SITES) {
    const btn = document.createElement("button");
    btn.textContent = `→ ${SITE_LABELS[site]}`;
    btn.onclick = () => sendCompose([site]);
    grid.appendChild(btn);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `p-${site}`;
    checkbox.checked = true;
    checkbox.title = `${SITE_LABELS[site]} active`;
    checkbox.setAttribute("aria-label", `${SITE_LABELS[site]} active`);
    checkbox.onchange = async (e) => {
      const res = await window.api.setParticipant(site, e.target.checked);
      if (res?.ok) applyGlobal(res.global);
    };
    grid.appendChild(checkbox);
  }
  const all = document.createElement("button");
  all.className = "primary";
  all.textContent = "→ All";
  all.onclick = () => sendCompose(SITES.filter((s) => enabled[s]));
  grid.appendChild(all);
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
  col.className = `ai-col ${site} state-open`;
  col.id = `col-${site}`;
  // When minimized, the whole thin bar is an expand target.
  col.addEventListener("click", () => { if (col.classList.contains("state-min")) setColumnState(site, "open"); });

  const strip = document.createElement("div");
  strip.className = "control-strip";

  const head = document.createElement("div");
  head.className = "card-head";
  head.innerHTML = `<span class="led" id="led-${site}" title="Pane loaded"></span><span class="gendot" id="gendot-${site}"></span><span class="pane-name">${SITE_LABELS[site]}</span><span class="role-badge" id="role-badge-${site}"></span><span class="test-led" id="test-led-${site}" title="Connectivity test: not run yet"></span><span class="spacer"></span>`;
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
  const loginBtn = document.createElement("button");
  loginBtn.className = "login-btn";
  loginBtn.textContent = "🔑";
  loginBtn.title = "Saved logins: fill in a saved username/password and click Sign In for this site";
  loginBtn.onclick = () => toggleLoginMenu(site);
  head.appendChild(loginBtn);
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
  collapseBtn.textContent = STATE_GLYPH.open;
  collapseBtn.title = STATE_TITLE.open;
  collapseBtn.onclick = (e) => { e.stopPropagation(); cycleColumnState(site); };
  head.appendChild(collapseBtn);
  strip.appendChild(head);

  const pickMenu = document.createElement("div");
  pickMenu.className = "pick-menu collapsed";
  pickMenu.id = `pick-menu-${site}`;
  pickMenu.innerHTML = `<span class="row-label">Fix:</span>`;
  const testBtn = document.createElement("button");
  testBtn.textContent = "🧪 Test";
  testBtn.title = "Send a real test prompt, wait for the reply, and light up green/red based on whether it actually round-tripped";
  testBtn.onclick = () => runSelfTest(site);
  pickMenu.appendChild(testBtn);
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

  const loginMenu = document.createElement("div");
  loginMenu.className = "pick-menu collapsed";
  loginMenu.id = `login-menu-${site}`;
  loginMenu.innerHTML = `<span class="row-label">Logins:</span>`;
  const loginList = document.createElement("div");
  loginList.className = "login-list";
  loginList.id = `login-list-${site}`;
  loginList.textContent = "No saved logins yet.";
  loginMenu.appendChild(loginList);
  const addLoginBtn = document.createElement("button");
  addLoginBtn.textContent = "+ Add Login";
  addLoginBtn.onclick = () => el(`login-add-form-${site}`).classList.toggle("collapsed");
  loginMenu.appendChild(addLoginBtn);
  const addForm = document.createElement("div");
  addForm.className = "login-add-form collapsed";
  addForm.id = `login-add-form-${site}`;
  const labelInput = document.createElement("input");
  labelInput.id = `login-label-${site}`;
  labelInput.placeholder = "Label (e.g. Personal)";
  addForm.appendChild(labelInput);
  const userInput = document.createElement("input");
  userInput.id = `login-username-${site}`;
  userInput.placeholder = "Username / email";
  addForm.appendChild(userInput);
  const passInput = document.createElement("input");
  passInput.id = `login-password-${site}`;
  passInput.type = "password";
  passInput.placeholder = "Password";
  addForm.appendChild(passInput);
  const saveLoginBtn = document.createElement("button");
  saveLoginBtn.textContent = "Save Login";
  saveLoginBtn.onclick = () => saveNewLogin(site);
  addForm.appendChild(saveLoginBtn);
  loginMenu.appendChild(addForm);
  const loginStatus = document.createElement("div");
  loginStatus.className = "pick-status";
  loginStatus.id = `login-status-${site}`;
  loginMenu.appendChild(loginStatus);
  strip.appendChild(loginMenu);

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
// see sendTextTo() in main.js. Reachable from the 🎭 Roles button in the
// User Panel, which opens #roles-popup (this function's container).
// General-purpose presets alongside free text, since most role assignment
// falls into one of a handful of common shapes rather than needing a fresh
// custom description every time.
const ROLE_PRESETS = [
  "Project Manager", "Detective", "Research Analyst", "Editor",
  "Skeptical Engineer", "Strategist", "Devil's Advocate", "Fact-Checker", "Summarizer"
];

function buildRoleAssignment() {
  const box = el("roles-body");
  box.innerHTML = "";
  for (const site of SITES) {
    const row = document.createElement("div");
    row.className = "roles-popup-row";

    const siteLine = document.createElement("div");
    siteLine.className = `site-line ${site}`;
    siteLine.innerHTML = `<span class="dot"></span>${SITE_LABELS[site]}`;
    row.appendChild(siteLine);

    const pickerLine = document.createElement("div");
    pickerLine.className = "picker-line";

    const input = document.createElement("input");
    input.id = `role-${site}`;
    input.placeholder = "e.g. Skeptical Engineer";

    const preset = document.createElement("select");
    preset.innerHTML = `<option value="">— none —</option>` +
      ROLE_PRESETS.map((r) => `<option value="${r}">${r}</option>`).join("") +
      `<option value="__custom__">Custom…</option>`;
    preset.onchange = () => {
      if (preset.value === "__custom__") { input.value = ""; input.focus(); }
      else input.value = preset.value;
    };
    pickerLine.appendChild(preset);
    pickerLine.appendChild(input);
    row.appendChild(pickerLine);

    const btnRow = document.createElement("div");
    btnRow.className = "btns";
    const current = document.createElement("span");
    current.className = "role-current";
    current.id = `role-current-${site}`;

    const applyBtn = document.createElement("button");
    applyBtn.textContent = "Apply";
    applyBtn.onclick = async () => {
      const role = input.value.trim();
      const res = await window.api.setRole(site, role);
      if (res?.ok) {
        current.textContent = role ? `current: ${role}` : "";
        preset.value = ROLE_PRESETS.includes(role) ? role : "";
      }
    };
    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear";
    clearBtn.onclick = async () => {
      input.value = "";
      preset.value = "";
      const res = await window.api.setRole(site, "");
      if (res?.ok) current.textContent = "";
    };
    btnRow.appendChild(applyBtn);
    btnRow.appendChild(clearBtn);
    btnRow.appendChild(current);
    row.appendChild(btnRow);

    box.appendChild(row);
  }
}

function buildAiRow() {
  const box = el("expanded-strip");
  box.innerHTML = "";
  for (const site of SITES) box.appendChild(buildAiColumn(site));
}

// The three AI panes ALWAYS stay in #expanded-strip in SITES order — a state
// change never moves a pane, so provider order (ChatGPT, Claude, Gemini) is
// fixed regardless of open/reduced/minimized. Only the pane's own state class
// changes its size in place.
//
// Purely a visual/layout change — a pane's state does NOT change whether that
// AI is enabled/participating (that's the separate Participants checkbox).
// syncPaneBounds() in main.js measures pane-slot's real on-screen rect every
// ~700ms and zeroes out the live browser view once it's too small to see, so
// hiding .pane-slot (in reduced and minimized) also hides the embedded browser
// pane — no main.js change needed.
function setColumnState(site, state) {
  const col = el(`col-${site}`);
  if (!col || !PANE_STATES.includes(state)) return;
  col.classList.remove("state-open", "state-reduced", "state-min");
  col.classList.add(`state-${state}`);
  const btn = col.querySelector(".collapse-btn");
  if (btn) { btn.textContent = STATE_GLYPH[state]; btn.title = STATE_TITLE[state]; }
  updateAllCollapsedState();
}
function currentColumnState(col) {
  return PANE_STATES.find((s) => col.classList.contains(`state-${s}`)) || "open";
}
function cycleColumnState(site) {
  const col = el(`col-${site}`);
  if (!col) return;
  const cur = currentColumnState(col);
  setColumnState(site, PANE_STATES[(PANE_STATES.indexOf(cur) + 1) % PANE_STATES.length]);
}

// When every AI pane is collapsed there's nothing left to look at up top —
// shrink the AI row down to just the collapsed titlebars and let the
// Transcript/Activity Log panel below grow to fill the freed space, instead
// of leaving it stuck at a fixed height.
function updateAllCollapsedState() {
  const allMinimized = SITES.every((site) => el(`col-${site}`)?.classList.contains("state-min"));
  el("wrap").classList.toggle("all-collapsed", allMinimized);
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
  // A House Rules stage's own state machine already decides who gets
  // messaged for each turn -- re-enabling a per-pane Auto toggle mid-run
  // used to let mesh routing independently message the same target a
  // second time with different wording, since mesh had nothing to dedupe
  // against for the targets a stage messages directly. Disabling these
  // here (matching how the global Auto button already is) closes off the
  // UI path to that; main.js's own mesh-forward loop also dedupes against
  // the stage's real targets as defense-in-depth for anyone hitting the
  // routing:set IPC channel directly.
  document.querySelectorAll(".auto-toggle").forEach((btn) => { btn.disabled = !!hr.active; });
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
  if (turn.governance && turn.governance.governed) {
    const g = turn.governance;
    const b = document.createElement("span");
    b.className = g.held ? "badge-verdict" : "badge-roundtable";
    b.style.background = g.held ? "#7a2020" : "#1f5130";
    b.textContent = g.held ? "⛔ HELD" : (g.available === false ? "⚠ gate off" : "✓ authorised");
    b.title = `${g.role || ""} → ${g.target || ""}${g.reason ? "\n" + g.reason : ""}`;
    meta.appendChild(b);
  }
  const text = document.createElement("div");
  text.className = "text";
  text.textContent = turn.text;
  wrap.appendChild(meta);
  wrap.appendChild(text);
  return wrap;
}

// Messages to you: main.js's Roundtable v2 tags every captured reply with
// roundtableTag === "USER" whenever an AI explicitly addresses [TO: USER],
// AND (per Rule 1's documented fallback) whenever it forgets the tag
// entirely -- both cases genuinely mean "this one's for you," which is
// exactly what should land here instead of only in the Transcript stream.
// No new backend/IPC surface needed: this is derived entirely from turns
// the renderer already receives.
let messagesToUser = [];

function messageRowEl(turn, compact) {
  const row = document.createElement(compact ? "button" : "div");
  row.className = `${compact ? "feed-row" : "msg-turn"} ${turn.site}`;
  const meta = document.createElement("div");
  meta.className = "meta";
  const ts = turn.ts ? new Date(turn.ts).toLocaleTimeString() : "";
  const siteLabel = document.createElement("span");
  if (!compact) siteLabel.className = "site";
  siteLabel.textContent = turn.label;
  meta.appendChild(siteLabel);
  meta.appendChild(document.createTextNode(ts));
  row.appendChild(meta);
  const textEl = document.createElement("div");
  textEl.className = compact ? "snippet" : "text";
  textEl.textContent = (turn.text || "").replace(/\s+/g, " ").trim();
  row.appendChild(textEl);
  if (compact) row.onclick = () => el("messages-popup").classList.add("open");
  return row;
}

function renderMessagesFeed() {
  const badge = el("messages-badge");
  badge.textContent = String(messagesToUser.length);
  if (messagesToUser.length) badge.removeAttribute("data-zero");
  else badge.setAttribute("data-zero", "");

  const feed = el("messages-feed");
  feed.innerHTML = "";
  for (const turn of messagesToUser.slice(-3).reverse()) feed.appendChild(messageRowEl(turn, true));

  const popupBody = el("messages-popup-body");
  popupBody.innerHTML = "";
  for (const turn of messagesToUser.slice().reverse()) popupBody.appendChild(messageRowEl(turn, false));
}

function renderTranscript(transcript) {
  currentTranscript = transcript || [];
  messagesToUser = currentTranscript.filter((t) => t.roundtableTag === "USER");
  renderMessagesFeed();
  const box = el("transcript");
  box.innerHTML = "";
  for (const turn of currentTranscript) box.appendChild(turnEl(turn));
  box.scrollTop = box.scrollHeight;
}

function appendTranscriptTurn(turn) {
  currentTranscript.push(turn);
  if (turn.roundtableTag === "USER") {
    messagesToUser.push(turn);
    renderMessagesFeed();
  }
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
  if (entry.detail?.role) parts.push(`role=${entry.detail.role}`);
  if (entry.detail?.token) parts.push(`token=${entry.detail.token}`);
  if (entry.detail?.timeoutMs != null) parts.push(`timeout=${Math.round(entry.detail.timeoutMs / 1000)}s`);
  if (entry.detail?.selector) parts.push(`selector=${JSON.stringify(entry.detail.selector)}`);
  if (entry.detail?.tag) parts.push(`<${entry.detail.tag}>`);
  if (entry.detail?.sample) parts.push(`sample=${JSON.stringify(entry.detail.sample)}`);
  if (entry.detail?.capturedText) parts.push(`got=${JSON.stringify(entry.detail.capturedText)}`);
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
  if (turn && turn.site) lastReplyBySite[turn.site] = turn.text || "";
  setStatus(`Captured new reply from ${turn.label}.`);
  beep();
  if (typeof databaseRefresh === "function" && el("database-status")) databaseRefresh();
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

// Messages / Roles: small in-window popups (not separate OS windows like
// Prompt Editor/Sequence Editor use, since neither needs persistent window
// state of its own). Closing on a click outside the popup's own card
// matches how a native modal behaves.
function wirePopup(openBtnId, overlayId, closeBtnId) {
  const overlay = el(overlayId);
  el(openBtnId).onclick = () => overlay.classList.add("open");
  el(closeBtnId).onclick = () => overlay.classList.remove("open");
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.remove("open"); });
}
wirePopup("btn-open-messages", "messages-popup", "btn-close-messages");
wirePopup("btn-open-roles", "roles-popup", "btn-close-roles");

// Global / House Rules / Prompt Library each collapse to a small tab in
// #top-tab-strip -- unlike an AI pane's in-place shrink, these vanish
// entirely from their row (display:none), so the row itself naturally
// collapses to zero height once every panel in it is gone, freeing that
// space for the AI panes below via the same flex:1 1 auto #ai-row already
// uses. Clicking the tab restores the panel to its normal spot.
const COLLAPSIBLE_PANELS = {
  global: { panelId: "col-global", label: "Global" },
  houserules: { panelId: "col-houserules", label: "House Rules" },
  prompts: { panelId: "col-prompts", label: "Prompt Library" },
  memory: { panelId: "col-memory", label: "Project Memory" },
  state: { panelId: "col-state", label: "Project State" },
  system: { panelId: "col-system", label: "System Monitor" },
  systemai: { panelId: "col-systemai", label: "System AI" },
  imagestudio: { panelId: "col-imagestudio", label: "Image Studio" },
  bookstudio: { panelId: "col-bookstudio", label: "Book Studio" }
};
function collapseYellowPanel(key) {
  const { panelId, label } = COLLAPSIBLE_PANELS[key];
  el(panelId).classList.add("hidden-collapsed");
  const tab = document.createElement("button");
  tab.className = "collapsed-tab";
  tab.id = `tab-${key}`;
  tab.title = `Expand ${label}`;
  tab.innerHTML = `<span class="tab-color"></span>${label}`;
  tab.onclick = () => expandYellowPanel(key);
  el("top-tab-strip").appendChild(tab);
}
function expandYellowPanel(key) {
  el(COLLAPSIBLE_PANELS[key].panelId).classList.remove("hidden-collapsed");
  el(`tab-${key}`)?.remove();
}
// Make each utility panel's heading a second, larger click target for collapsing
// it — and keyboard-operable (Enter/Space), with a visible focus ring via CSS.
for (const key of Object.keys(COLLAPSIBLE_PANELS)) {
  const panel = el(COLLAPSIBLE_PANELS[key].panelId);
  const h2 = panel && panel.querySelector(".yc-head h2");
  if (!h2) continue;
  h2.setAttribute("role", "button");
  h2.setAttribute("tabindex", "0");
  h2.title = "Minimize this panel to the top tab strip";
  h2.addEventListener("click", () => collapseYellowPanel(key));
  h2.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); collapseYellowPanel(key); } });
}
el("btn-collapse-global").onclick = () => collapseYellowPanel("global");
el("btn-collapse-houserules").onclick = () => collapseYellowPanel("houserules");
el("btn-collapse-prompts").onclick = () => collapseYellowPanel("prompts");

// --- ATELIER governance panel ---------------------------------------------
if (el("btn-collapse-atelier")) {
  el("btn-collapse-atelier").onclick = () => {
    const body = el("atelier-body");
    const hidden = body.style.display === "none";
    body.style.display = hidden ? "" : "none";
    el("btn-collapse-atelier").textContent = hidden ? "⌄" : "›";
  };
}

async function atelierRefreshStatus() {
  const statusEl = el("atelier-status");
  if (!statusEl || !window.api.atelierDetect) return;
  try {
    const d = await window.api.atelierDetect();
    if (d && d.available) {
      statusEl.textContent = `✓ Toolkit ready — ${d.version}`;
      statusEl.style.color = "#7ad19a";
    } else {
      statusEl.textContent = `⚠ Not available: ${(d && d.reason) || "unknown"} (governance will pass replies through untouched)`;
      statusEl.style.color = "#e0b060";
    }
  } catch (e) {
    statusEl.textContent = `⚠ ${String(e)}`;
  }
}

async function atelierLoadSettings() {
  if (!window.api.atelierGetSettings) return;
  try {
    const s = await window.api.atelierGetSettings();
    if (!s || s.error) return;
    if (el("atelier-enabled")) el("atelier-enabled").checked = !!s.enabled;
    if (el("atelier-projectdir")) el("atelier-projectdir").value = s.projectDir || "";
    for (const site of ["chatgpt", "claude", "gemini"]) {
      const inp = el(`atelier-target-${site}`);
      if (inp) inp.value = (s.targets && s.targets[site]) || "";
    }
  } catch (_) { /* leave fields as-is */ }
}

if (el("btn-atelier-save")) {
  el("btn-atelier-save").onclick = async () => {
    const patch = {
      enabled: el("atelier-enabled").checked,
      projectDir: el("atelier-projectdir").value.trim(),
      targets: {
        chatgpt: el("atelier-target-chatgpt").value.trim(),
        claude: el("atelier-target-claude").value.trim(),
        gemini: el("atelier-target-gemini").value.trim(),
      },
    };
    const out = el("atelier-save-status");
    try {
      const s = await window.api.atelierSetSettings(patch);
      if (s && !s.error) {
        out.textContent = s.enabled ? "Saved — governance is ON." : "Saved — governance is OFF.";
        out.style.color = "#7ad19a";
      } else {
        out.textContent = `Could not save: ${(s && s.error) || "unknown"}`;
        out.style.color = "#e08080";
      }
    } catch (e) {
      out.textContent = String(e);
      out.style.color = "#e08080";
    }
  };
}

if (el("btn-atelier-recheck")) {
  el("btn-atelier-recheck").onclick = atelierRefreshStatus;
}

// --- Conversation database status ------------------------------------------
// The Conversation window (formerly the separate Transcript + Database panels,
// now merged into one) is saved to the shared SQLite database. This shows a
// live saved-count next to its heading; the messages themselves render in the
// #transcript box below via renderTranscript/appendTranscriptTurn.
async function databaseRefresh() {
  const statusEl = el("database-status");
  if (!statusEl || !window.api.dbStatus) return;
  try {
    const s = await window.api.dbStatus();
    if (s && s.available) {
      statusEl.textContent = `· saved to database (${s.count})`;
      statusEl.style.color = "#7ad19a";
    } else {
      statusEl.textContent = "· not saved (database off)";
      statusEl.style.color = "#e0b060";
    }
  } catch (_) { statusEl.textContent = ""; }
}

// --- Project Memory + Project State panels (backend-module panels) ----------
// Collapse to the top tab strip, exactly like Global / House Rules / Prompt
// Library, so every panel minimizes the same predictable way.
if (el("btn-collapse-memory")) el("btn-collapse-memory").onclick = () => collapseYellowPanel("memory");
if (el("btn-collapse-state")) el("btn-collapse-state").onclick = () => collapseYellowPanel("state");

async function memoryRefresh() {
  const sum = el("memory-summary");
  if (!sum || !window.api.dbMemorySummary) return;
  try { const s = await window.api.dbMemorySummary(); sum.textContent = s && s.available ? `${s.total} item(s)` : "(db off)"; }
  catch (_) { sum.textContent = ""; }
}

async function memoryRunSearch() {
  const box = el("memory-results");
  if (!box || !window.api.dbMemorySearch) return;
  try {
    const r = await window.api.dbMemorySearch(el("memory-query").value);
    box.innerHTML = "";
    if (!r || !r.results || !r.results.length) { box.innerHTML = '<div style="opacity:.5;">No matches.</div>'; return; }
    for (const x of r.results) {
      const row = document.createElement("div");
      row.className = "feed-row";
      row.textContent = `${x.id} — ${x.title || x.type}`;
      box.appendChild(row);
    }
  } catch (_) {}
}

if (el("btn-memory-add")) el("btn-memory-add").onclick = async () => {
  if (!window.api.dbMemoryCreate) return;
  const type = el("memory-type").value;
  const text = el("memory-text").value.trim();
  if (!text) return;
  const field = { character: "name", task: "title", decision: "summary", fact: "statement", timeline: "label", status: "label" }[type] || "name";
  const data = {}; data[field] = text;
  const res = await window.api.dbMemoryCreate(type, data);
  if (res && res.ok) { el("memory-text").value = ""; memoryRefresh(); }
  else if (el("memory-results")) { el("memory-results").innerHTML = ""; const d = document.createElement("div"); d.style.color = "#e08080"; d.textContent = (res && res.error) || "failed"; el("memory-results").appendChild(d); }
};
if (el("btn-memory-search")) el("btn-memory-search").onclick = memoryRunSearch;

async function stateRefresh() {
  const box = el("state-content");
  if (!box || !window.api.dbProjectState) return;
  try {
    const s = await window.api.dbProjectState();
    box.innerHTML = "";
    if (!s || !s.available) { box.innerHTML = '<div style="opacity:.5;">Database off.</div>'; return; }
    const section = (label, lines) => {
      const wrap = document.createElement("div");
      const b = document.createElement("b"); b.style.opacity = ".7"; b.textContent = label;
      wrap.appendChild(b);
      const rows = lines.length ? lines : ["—"];
      for (const ln of rows) { const p = document.createElement("div"); p.style.opacity = ".85"; p.textContent = ln; wrap.appendChild(p); }
      return wrap;
    };
    box.appendChild(section("Read positions", (s.readPositions || []).map((p) => `${p.model}: ${p.position} (lag ${p.lag})`)));
    box.appendChild(section("Baseline", s.baseline ? [`${s.baseline.hash} (${s.baseline.stage || "?"})`] : []));
    box.appendChild(section("Artifacts", (s.artifacts || []).map((a) => `${a.path} v${a.current_version}`)));
    box.appendChild(section("Owned tasks", (s.ownedTasks || []).map((t) => `${t.task_id} → ${t.owner}`)));
  } catch (_) {}
}
if (el("btn-state-refresh")) el("btn-state-refresh").onclick = stateRefresh;

// --- System Monitor panel ---------------------------------------------------
if (el("btn-collapse-system")) el("btn-collapse-system").onclick = () => collapseYellowPanel("system");

async function systemRefresh() {
  const rec = el("system-recommend"), stats = el("system-stats"), msg = el("system-msg");
  if (!rec || !window.api.systemInfo) return;
  if (msg) msg.textContent = "reading…";
  try {
    const r = await window.api.systemInfo();
    const s = r && r.snapshot, reco = r && r.recommendation;
    if (msg) msg.textContent = "";
    rec.innerHTML = "";
    if (reco) {
      const d = document.createElement("div");
      d.innerHTML = `<b>This machine can run</b><br>• Local models: <b>${reco.llm.tier}</b> — ${reco.llm.detail}<br>• Stable Diffusion: <b>${reco.sd.tier}</b> — ${reco.sd.detail}`;
      rec.appendChild(d);
    } else { rec.textContent = "—"; }
    stats.innerHTML = "";
    const add = (label, val) => {
      const d = document.createElement("div");
      const b = document.createElement("b"); b.style.opacity = ".7"; b.textContent = `${label}: `;
      d.appendChild(b); d.appendChild(document.createTextNode(val));
      stats.appendChild(d);
    };
    if (s && !s.error) {
      add("CPU", `${s.cpu.brand || "?"} · ${s.cpu.cores || "?"} cores${s.cpu.speedGHz ? ` · ${s.cpu.speedGHz} GHz` : ""}${s.temps.cpuMainC ? ` · ${s.temps.cpuMainC}°C` : ""}`);
      add("RAM", `${s.mem.totalGB} GB total · ${s.mem.usedGB} GB used`);
      if ((s.gpus || []).length) {
        for (const g of s.gpus) add("GPU", `${g.model}${g.vramGB ? ` · ${g.vramGB} GB VRAM` : ""}${g.tempC ? ` · ${g.tempC}°C` : ""}${g.utilizationPct != null ? ` · ${g.utilizationPct}% used` : ""}`);
      } else { add("GPU", "none detected (integrated or headless)"); }
      add("OS", `${s.os.distro || s.os.platform || "?"} ${s.os.release || ""} (${s.os.arch || ""})`);
      if (!s.temps.cpuMainC) add("Note", "CPU temperature not available on this system.");
    } else { stats.textContent = s && s.error ? `⚠ ${s.error}` : "unavailable"; }
  } catch (e) { if (msg) msg.textContent = String(e); }
}
if (el("btn-system-refresh")) el("btn-system-refresh").onclick = systemRefresh;

// Tools menu (or any code) can ask the UI to reveal a panel.
function focusPanel(key) {
  try { if (typeof expandYellowPanel === "function") expandYellowPanel(key); } catch (_) {}
  const p = COLLAPSIBLE_PANELS[key] && el(COLLAPSIBLE_PANELS[key].panelId);
  if (p && p.scrollIntoView) p.scrollIntoView({ behavior: "smooth", block: "center" });
}
if (window.api.onFocusPanel) window.api.onFocusPanel((key) => focusPanel(key));

// --- System AI (Local Supervisor) panel + User Panel switch ----------------
if (el("btn-collapse-systemai")) el("btn-collapse-systemai").onclick = () => collapseYellowPanel("systemai");

function lsiReflect(enabled) {
  if (el("lsi-enabled")) el("lsi-enabled").checked = !!enabled;
  const b = el("btn-ai-toggle");
  if (b) { b.classList.toggle("on", !!enabled); b.textContent = `🤖 System AI: ${enabled ? "On" : "Off"}`; }
  const st = el("lsi-status");
  if (st) { st.textContent = enabled ? "· on" : "· off"; st.style.color = enabled ? "#7ad19a" : "#888"; }
}
function lsiEnsureModelOption(name) {
  const sel = el("lsi-model"); if (!sel || !name) return;
  if (!Array.from(sel.options).some((o) => o.value === name)) { const o = document.createElement("option"); o.value = name; o.textContent = name; sel.appendChild(o); }
}
async function lsiLoadSettings() {
  if (!window.api.lsiGetSettings) return;
  try {
    const s = await window.api.lsiGetSettings();
    if (!s || s.error) return;
    if (el("lsi-endpoint")) el("lsi-endpoint").value = s.endpoint || "";
    if (el("lsi-model") && s.model) { lsiEnsureModelOption(s.model); el("lsi-model").value = s.model; }
    lsiReflect(!!s.enabled);
  } catch (_) {}
}
async function lsiSetEnabled(on) {
  if (!window.api.lsiSetSettings) return;
  const s = await window.api.lsiSetSettings({ enabled: on });
  lsiReflect(s && s.enabled);
}
if (el("btn-ai-toggle")) el("btn-ai-toggle").onclick = () => lsiSetEnabled(!(el("lsi-enabled") && el("lsi-enabled").checked));
if (el("lsi-enabled")) el("lsi-enabled").onchange = () => lsiSetEnabled(el("lsi-enabled").checked);
if (el("btn-lsi-save")) el("btn-lsi-save").onclick = async () => {
  if (!window.api.lsiSetSettings) return;
  const s = await window.api.lsiSetSettings({ enabled: el("lsi-enabled").checked, endpoint: el("lsi-endpoint").value.trim(), model: el("lsi-model") ? el("lsi-model").value : "" });
  lsiReflect(s && s.enabled);
  if (el("lsi-msg")) el("lsi-msg").textContent = "Saved.";
};
if (el("btn-lsi-test")) el("btn-lsi-test").onclick = async () => {
  if (!window.api.lsiTest) return;
  const m = el("lsi-msg"); if (m) m.textContent = "Testing…";
  const r = await window.api.lsiTest();
  if (m) m.textContent = r && r.ok ? "✓ Reachable." : `⚠ ${(r && r.error) || "not reachable"}`;
};
async function lsiRefreshModels() {
  const sel = el("lsi-model"); if (!sel || !window.api.ollamaList) return;
  const keep = sel.value;
  const r = await window.api.ollamaList();
  sel.innerHTML = '<option value="">(choose a model)</option>';
  for (const name of (r && r.models) || []) { const o = document.createElement("option"); o.value = name; o.textContent = name; sel.appendChild(o); }
  if (keep) { lsiEnsureModelOption(keep); sel.value = keep; }
  if (el("lsi-msg")) el("lsi-msg").textContent = (r && r.ok) ? `${((r.models) || []).length} model(s) installed.` : "Ollama not reachable — install it to run a local model.";
}
if (el("btn-lsi-models")) el("btn-lsi-models").onclick = lsiRefreshModels;
async function lsiLoadRecommended() {
  const rec = el("lsi-recommend"), dl = el("lsi-download-model");
  if (!rec || !window.api.systemInfo || !window.api.ollamaRecommended) return;
  try {
    const info = await window.api.systemInfo();
    const vram = info && info.recommendation ? info.recommendation.vramGB : null;
    const r = await window.api.ollamaRecommended(vram);
    const models = (r && r.models) || [];
    rec.textContent = `Recommended for your machine${vram ? ` (${vram} GB VRAM)` : ""}: ${models.slice(0, 3).join(", ")}`;
    if (dl) { dl.innerHTML = ""; for (const name of models) { const o = document.createElement("option"); o.value = name; o.textContent = name; dl.appendChild(o); } }
  } catch (_) {}
}
if (el("btn-lsi-download")) el("btn-lsi-download").onclick = async () => {
  if (!window.api.ollamaPull) return;
  const model = el("lsi-download-model") ? el("lsi-download-model").value : "";
  const st = el("lsi-download-status");
  if (!model) { if (st) st.textContent = "Pick a model to download."; return; }
  if (window.api.ollamaDetect) { const d = await window.api.ollamaDetect(); if (!d || !d.available) { if (st) st.textContent = "Ollama isn't installed. Get it from ollama.com, then try again."; return; } }
  if (st) st.textContent = `Starting download of ${model}…`;
  const r = await window.api.ollamaPull(model);
  if (st) st.textContent = r && r.ok ? `✓ ${model} installed.` : `⚠ ${(r && r.error) || "download failed"}`;
  lsiRefreshModels();
};
if (window.api.onOllamaProgress) window.api.onOllamaProgress((p) => { const st = el("lsi-download-status"); if (st && p && p.line) st.textContent = p.line; });

// User Panel: 🧙 Setup -> open the Setup Wizard window (downloads run in bg).
if (el("btn-open-wizard")) el("btn-open-wizard").onclick = () => { if (window.api.openWizard) window.api.openWizard(); };

// --- Book Studio (ATELIER V2) ----------------------------------------------
if (el("btn-collapse-bookstudio")) el("btn-collapse-bookstudio").onclick = () => collapseYellowPanel("bookstudio");
let bookCurrentId = null;
let bookCurrentChapter = null;
let bookProject = null;
const BOOK_TASKS = [
  { id: "initialize", label: "Initialize" }, { id: "outline", label: "Outline" },
  { id: "bible", label: "Book Bible" }, { id: "roadmap", label: "Roadmap" },
  { id: "write", label: "✍ Write" }, { id: "story-review", label: "📖 Story review" },
  { id: "canon-review", label: "🗺 Canon review" }, { id: "writing-review", label: "✅ Writing review" },
  { id: "revise", label: "Revise" }, { id: "redo", label: "↻ Redo" },
  { id: "start-over", label: "⟲ Start over" }, { id: "check-again", label: "🔁 Check again" },
];
const BOOK_WORKFLOW = [
  "Intake questionnaire (ChatGPT asks you)", "Capture requirements + Story Direction",
  "Master chapter outline", "Build the Book Bible", "Chapter roadmap", "Write the chapter",
  "Story review (ChatGPT)", "Canon review (Gemini)", "Writing review (Claude)",
  "Consolidated revision", "Verify + lock the chapter",
];
function bookSetStatus(t) { if (el("book-status")) el("book-status").textContent = t || ""; }

async function bookLoadList(selectId) {
  if (!window.api.bookList) return;
  const r = await window.api.bookList();
  const sel = el("book-select"); if (!sel) return;
  const keep = selectId || sel.value;
  sel.innerHTML = '<option value="">(no book selected)</option>';
  for (const p of (r && r.projects) || []) {
    const o = document.createElement("option"); o.value = p.id; o.textContent = `${p.title} (${p.stage})`; sel.appendChild(o);
  }
  if (keep && Array.from(sel.options).some((o) => o.value === keep)) { sel.value = keep; await bookSelect(keep); }
}
async function bookSelect(id) {
  bookCurrentId = id || null;
  if (!id) { bookProject = null; bookRenderAll(); return; }
  const r = await window.api.bookGet(id);
  bookProject = r && r.ok ? r.project : null;
  bookCurrentChapter = bookProject && bookProject.chapters.length ? bookProject.chapters[bookProject.chapters.length - 1].id : null;
  bookRenderAll();
}
async function bookRefresh() { if (bookCurrentId) { const r = await window.api.bookGet(bookCurrentId); bookProject = r && r.ok ? r.project : bookProject; bookRenderAll(); } }

function bookRenderAll() { bookRenderWorkflow(); bookRenderStages(); bookRenderChapters(); bookRenderTasks(); bookRenderRecordTypes(); bookRenderRecords(); bookRenderLog(); }

function bookRenderWorkflow() {
  const wf = (bookProject && bookProject.workflow) ? bookProject.workflow : { status: "idle", step: 0 };
  const has = !!bookCurrentId;
  const running = wf.status === "running", paused = wf.status === "paused", done = wf.status === "done";
  const show = (id, on) => { const e = el(id); if (e) e.style.display = on ? "" : "none"; };
  show("btn-book-start", has && (wf.status === "idle" || done));
  show("btn-book-continue", has && running);
  show("btn-book-pause", has && running);
  show("btn-book-resume", has && paused);
  show("btn-book-stop", has && (running || paused));
  if (el("btn-book-start")) el("btn-book-start").disabled = !has;
  const st = el("book-workflow-status"); if (!st) return;
  const total = BOOK_WORKFLOW.length, label = BOOK_WORKFLOW[wf.step] || "";
  if (!has) st.textContent = "Pick or create a book, then press Start.";
  else if (wf.status === "idle") st.textContent = "Ready. Press ▶ Start Making Book — ChatGPT sends you the intake questionnaire first.";
  else if (done) st.textContent = "Workflow complete ✓ — press Start to run it again.";
  else if (running) st.textContent = `Step ${wf.step + 1}/${total}: ${label} — running. Answer/review in the pane, then Continue ▶.`;
  else if (paused) st.textContent = `Paused at step ${wf.step + 1}/${total}: ${label}. Press ▶ Resume when ready.`;
}
async function bookSendComposed(c) {
  if (!c || !c.ok) { setStatus(`Book step failed: ${(c && c.error) || "error"}`); return; }
  if (c.done) { setStatus("Book workflow complete."); bookRefresh(); return; }
  await window.api.sendCompose(c.text, [c.target]);
  await window.api.bookLog(bookCurrentId, `▶ step ${(c.index || 0) + 1}/${c.total}: ${c.label} → ${SITE_LABELS[c.target] || c.target}`);
  setStatus(`Sent step ${(c.index || 0) + 1}: ${c.label} → ${SITE_LABELS[c.target] || c.target}.`);
  bookRefresh();
}
if (el("btn-book-start")) el("btn-book-start").onclick = async () => {
  if (!bookCurrentId) { setStatus("Select or create a book first."); return; }
  await bookSendComposed(await window.api.bookWorkflowStart(bookCurrentId, bookCurrentChapter));
};
if (el("btn-book-continue")) el("btn-book-continue").onclick = async () => {
  if (!bookCurrentId) return;
  await bookSendComposed(await window.api.bookWorkflowNext(bookCurrentId, bookCurrentChapter));
};
if (el("btn-book-pause")) el("btn-book-pause").onclick = async () => { if (bookCurrentId) { await window.api.bookWorkflowSetStatus(bookCurrentId, "paused"); bookRefresh(); } };
if (el("btn-book-resume")) el("btn-book-resume").onclick = async () => { if (bookCurrentId) { await window.api.bookWorkflowSetStatus(bookCurrentId, "running"); bookRefresh(); } };
if (el("btn-book-stop")) el("btn-book-stop").onclick = async () => { if (bookCurrentId) { await window.api.bookWorkflowSetStatus(bookCurrentId, "idle"); bookRefresh(); } };

function bookRenderStages() {
  const box = el("book-stages"); if (!box) return; box.innerHTML = "";
  if (!bookProject) { if (el("book-stage-count")) el("book-stage-count").textContent = ""; return; }
  const stages = bookProject.stages || [];
  const idx = stages.indexOf(bookProject.stage);
  if (el("book-stage-count")) el("book-stage-count").textContent = `(${idx + 1}/${stages.length})`;
  stages.forEach((s, i) => {
    const b = document.createElement("button");
    b.textContent = `${i <= idx ? "●" : "○"} ${(bookProject.stageLabels && bookProject.stageLabels[s]) || s}`;
    b.style.opacity = i === idx ? "1" : ".7";
    if (i === idx) b.classList.add("primary");
    b.title = "Set stage";
    b.onclick = async () => { await window.api.bookSetStage(bookCurrentId, s); bookRefresh(); bookLoadList(bookCurrentId); };
    box.appendChild(b);
  });
}
function bookRenderChapters() {
  const box = el("book-chapters"); if (!box) return; box.innerHTML = "";
  if (!bookProject) return;
  for (const ch of bookProject.chapters) {
    const row = document.createElement("div"); row.className = "btns"; row.style.alignItems = "center";
    const pick = document.createElement("button");
    pick.textContent = (ch.id === bookCurrentChapter ? "▶ " : "") + ch.id + (ch.title ? " — " + ch.title : "");
    pick.style.flex = "1 1 auto"; pick.style.textAlign = "left";
    if (ch.id === bookCurrentChapter) pick.classList.add("primary");
    pick.title = "Make this the current chapter for tasks";
    pick.onclick = () => { bookCurrentChapter = ch.id; bookRenderChapters(); };
    const sel = document.createElement("select");
    for (const st of bookProject.chapterStates) { const o = document.createElement("option"); o.value = st; o.textContent = st; if (st === ch.status) o.selected = true; sel.appendChild(o); }
    sel.onchange = async () => { await window.api.bookSetChapterStatus(bookCurrentId, ch.id, sel.value); bookRefresh(); };
    const view = document.createElement("button"); view.textContent = "👁"; view.title = "View manuscript";
    view.onclick = () => bookViewRecord(ch.id);
    row.appendChild(pick); row.appendChild(sel); row.appendChild(view); box.appendChild(row);
  }
}
function bookRenderTasks() {
  const box = el("book-tasks"); if (!box) return; box.innerHTML = "";
  for (const t of BOOK_TASKS) {
    const b = document.createElement("button"); b.textContent = t.label;
    b.disabled = !bookCurrentId;
    b.onclick = () => bookSendTask(t.id, t.label);
    box.appendChild(b);
  }
}
function bookRenderRecordTypes() {
  const sel = el("book-rec-type"); if (!sel) return; sel.innerHTML = "";
  const types = (bookProject && bookProject.recordTypes) || ["REQ", "CHR", "PLC", "ART", "SEC", "TWT", "STP", "ARC", "EVT", "CCR", "CNF", "REV"];
  for (const t of types) { const o = document.createElement("option"); o.value = t; o.textContent = t; sel.appendChild(o); }
}
function bookRenderRecords() {
  const box = el("book-records"); if (!box) return; box.innerHTML = "";
  if (!bookProject) return;
  if (!bookProject.records.length) { box.innerHTML = '<span class="muted" style="opacity:.5;">no records yet</span>'; return; }
  for (const r of bookProject.records) {
    const b = document.createElement("button"); b.textContent = r.id; b.title = r.name || r.id;
    b.onclick = () => bookViewRecord(r.id);
    box.appendChild(b);
  }
}
function bookRenderLog() {
  const box = el("book-log"); if (!box) return; box.innerHTML = "";
  if (!bookProject) return;
  for (const e of (bookProject.log || [])) {
    const d = document.createElement("div");
    const t = (e.ts || "").replace("T", " ").replace(/\..*/, "").slice(5);
    d.textContent = `${t}  ${e.text}`;
    box.appendChild(d);
  }
}
async function bookViewRecord(recordId) {
  if (!bookCurrentId) return;
  const r = await window.api.bookReadRecord(bookCurrentId, recordId);
  if (el("book-record-title")) el("book-record-title").textContent = `${recordId}${r && r.name ? " — " + r.name : ""}`;
  if (el("book-record-content")) el("book-record-content").textContent = r && r.ok ? r.content : `Couldn't open: ${(r && r.error) || "error"}`;
  if (el("book-record-overlay")) el("book-record-overlay").classList.add("open");
}
async function bookSendTask(taskId, label) {
  if (!bookCurrentId || !window.api.bookTask) return;
  const r = await window.api.bookTask(bookCurrentId, taskId, bookCurrentChapter);
  if (!r || !r.ok) { setStatus(`Book task failed: ${(r && r.error) || "error"}`); return; }
  await window.api.sendCompose(r.text, [r.target]);
  await window.api.bookLog(bookCurrentId, `→ ${SITE_LABELS[r.target] || r.target}: ${label}${bookCurrentChapter ? " (" + bookCurrentChapter + ")" : ""}`);
  setStatus(`Sent "${label}" to ${SITE_LABELS[r.target] || r.target}.`);
  bookRefresh();
}
if (el("btn-book-new")) el("btn-book-new").onclick = async () => {
  const title = (el("book-new-title") && el("book-new-title").value || "").trim();
  if (!title) { setStatus("Give the new book a title first."); return; }
  const r = await window.api.bookCreate(title);
  if (!r || !r.ok) { setStatus(`Couldn't create book: ${(r && r.error) || "error"}`); return; }
  if (el("book-new-title")) el("book-new-title").value = "";
  await bookLoadList(r.project.id);
  setStatus(`Created book "${title}".`);
};
if (el("book-select")) el("book-select").onchange = () => bookSelect(el("book-select").value);
if (el("btn-book-folder")) el("btn-book-folder").onclick = () => { if (bookCurrentId && window.api.bookOpenFolder) window.api.bookOpenFolder(bookCurrentId); };
if (el("btn-book-add-chapter")) el("btn-book-add-chapter").onclick = async () => {
  if (!bookCurrentId) { setStatus("Select or create a book first."); return; }
  const title = (el("book-chapter-title") && el("book-chapter-title").value || "").trim();
  const r = await window.api.bookAddChapter(bookCurrentId, title);
  if (el("book-chapter-title")) el("book-chapter-title").value = "";
  if (r && r.ok) bookCurrentChapter = r.chapterId;
  bookRefresh();
};
if (el("btn-book-add-record")) el("btn-book-add-record").onclick = async () => {
  if (!bookCurrentId) { setStatus("Select or create a book first."); return; }
  const type = el("book-rec-type") ? el("book-rec-type").value : "REQ";
  const name = (el("book-rec-name") && el("book-rec-name").value || "").trim();
  await window.api.bookAddRecord(bookCurrentId, type, name, "");
  if (el("book-rec-name")) el("book-rec-name").value = "";
  bookRefresh();
};
if (el("btn-book-brief")) el("btn-book-brief").onclick = async () => {
  if (!bookCurrentId || !window.api.bookBrief) { setStatus("Select a book first."); return; }
  const r = await window.api.bookBrief(bookCurrentId);
  if (!r || !r.ok) { setStatus(`Brief failed: ${(r && r.error) || "error"}`); return; }
  for (const b of r.briefs) { await window.api.sendCompose(b.text, [b.target]); }
  await window.api.bookLog(bookCurrentId, "briefed all three AIs (filled panes)");
  setStatus("Briefed ChatGPT, Claude and Gemini on this book.");
  bookRefresh();
};
if (el("btn-book-record-close")) el("btn-book-record-close").onclick = () => { if (el("book-record-overlay")) el("book-record-overlay").classList.remove("open"); };
if (el("book-record-overlay")) el("book-record-overlay").onclick = (e) => { if (e.target === el("book-record-overlay")) el("book-record-overlay").classList.remove("open"); };

// User Panel: 🆕 Start New Chat -> fresh session in all three AI panes at once.
if (el("btn-new-chat-all")) el("btn-new-chat-all").onclick = async () => {
  if (!window.api.startNewChatAll) return;
  setStatus("Starting a new chat in all three AIs…");
  const r = await window.api.startNewChatAll();
  const started = r && r.results ? Object.entries(r.results).filter(([, ok]) => ok).map(([s]) => SITE_LABELS[s] || s) : [];
  setStatus(started.length ? `New chat started in: ${started.join(", ")}.` : "Couldn't start a new chat — are the panes loaded?");
  setTimeout(refreshSites, 1500);
};

// User Panel: 🧪 Test -> run the system check and post the report to messages.
if (el("btn-run-test")) el("btn-run-test").onclick = async () => {
  if (!window.api.systemReport) return;
  setStatus("Running system check…");
  const r = await window.api.systemReport();
  setStatus(r && r.ok ? "System check posted to your messages." : `System check failed: ${(r && r.error) || "error"}`);
};

// --- Image Studio (Stable Diffusion) panel ---------------------------------
if (el("btn-collapse-sd")) el("btn-collapse-sd").onclick = () => collapseYellowPanel("imagestudio");

let sdLastImage = null; // {dataUri, prompt, from, seed}

function sdStatus(s) {
  const st = el("sd-status"); if (!st) return;
  st.textContent = s && s.enabled ? "· on" : "· off";
  st.style.color = s && s.enabled ? "#7ad19a" : "#888";
}
function sdSetVal(id, v) { const e = el(id); if (e != null && v != null) e.value = v; }
async function sdLoadSettings() {
  if (!window.api.sdGetSettings) return;
  try {
    const s = await window.api.sdGetSettings();
    if (!s || s.error) return;
    sdSetVal("sd-endpoint", s.endpoint || "");
    if (el("sd-enabled")) el("sd-enabled").checked = !!s.enabled;
    if (el("sd-auto")) el("sd-auto").checked = !!s.autoFromAI;
    sdSetVal("sd-negative", s.negativePrompt || "");
    sdSetVal("sd-steps", s.steps); sdSetVal("sd-cfg", s.cfg);
    sdSetVal("sd-width", s.width); sdSetVal("sd-height", s.height);
    sdSetVal("sd-batch", s.batch); sdSetVal("sd-sampler", s.sampler);
    if (el("sd-model") && s.model) { sdEnsureModelOption(s.model); el("sd-model").value = s.model; }
    sdStatus(s);
  } catch (_) {}
}
function sdEnsureModelOption(name) {
  const sel = el("sd-model"); if (!sel || !name) return;
  if (!Array.from(sel.options).some((o) => o.value === name)) {
    const o = document.createElement("option"); o.value = name; o.textContent = name; sel.appendChild(o);
  }
}
function sdSettingsPatch() {
  return {
    endpoint: el("sd-endpoint").value.trim(),
    enabled: el("sd-enabled").checked,
    autoFromAI: el("sd-auto").checked,
    negativePrompt: el("sd-negative").value,
    model: el("sd-model") ? el("sd-model").value : "",
    steps: Number(el("sd-steps").value) || 25,
    cfg: Number(el("sd-cfg").value) || 7,
    width: Number(el("sd-width").value) || 512,
    height: Number(el("sd-height").value) || 512,
    sampler: el("sd-sampler") ? el("sd-sampler").value : "Euler a",
    batch: Number(el("sd-batch").value) || 1,
  };
}
function sdShowImage(it) {
  sdLastImage = it;
  const img = el("sd-viewer-img"), empty = el("sd-viewer-empty"), actions = el("sd-viewer-actions");
  if (img && it && it.dataUri) { img.src = it.dataUri; img.style.display = "block"; if (empty) empty.style.display = "none"; if (actions) actions.style.display = "flex"; }
  const meta = el("sd-viewer-meta");
  if (meta && it) meta.textContent = `${it.from || "you"}${it.seed != null ? " · seed " + it.seed : ""}`;
}
async function sdRenderGallery() {
  const g = el("sd-gallery");
  if (!g || !window.api.sdGallery) return;
  try {
    const items = (await window.api.sdGallery(24)) || [];
    g.innerHTML = "";
    for (const it of items) {
      if (!it.dataUri) continue;
      const img = document.createElement("img");
      img.src = it.dataUri;
      img.title = `${it.from || "?"}: ${it.prompt || ""}`;
      img.style.cssText = "width:56px; height:56px; object-fit:cover; border-radius:5px; border:1px solid #2a2a2a; cursor:pointer;";
      img.onclick = () => sdShowImage(it);
      g.appendChild(img);
    }
    if (items[0] && !sdLastImage) sdShowImage(items[0]);
  } catch (_) {}
}
async function sdRefreshModels() {
  const sel = el("sd-model"); const m = el("sd-message");
  if (!sel || !window.api.sdModels) return;
  const keep = sel.value;
  if (m) m.textContent = "Loading models…";
  try {
    const r = await window.api.sdModels();
    if (r && r.ok) {
      sel.innerHTML = '<option value="">(server default — a light SD 1.5)</option>';
      for (const name of r.models) { const o = document.createElement("option"); o.value = name; o.textContent = name; sel.appendChild(o); }
      if (keep) { sdEnsureModelOption(keep); sel.value = keep; }
      if (m) m.textContent = `${r.models.length} model(s) available.`;
    } else if (m) m.textContent = `⚠ ${(r && r.error) || "could not list models"}`;
  } catch (_) {}
}

const SD_PRESETS = {
  fast: { steps: 15, cfg: 6 },
  quality: { steps: 35, cfg: 8 },
  portrait: { width: 512, height: 768 },
  landscape: { width: 768, height: 512 },
  square: { width: 512, height: 512 },
};
document.querySelectorAll(".sd-preset").forEach((btn) => {
  btn.onclick = () => {
    const p = SD_PRESETS[btn.dataset.preset]; if (!p) return;
    for (const [k, v] of Object.entries(p)) sdSetVal(`sd-${k}`, v);
    if (el("sd-message")) el("sd-message").textContent = `Preset applied: ${btn.textContent}.`;
  };
});

if (el("btn-sd-seed-random")) el("btn-sd-seed-random").onclick = () => sdSetVal("sd-seed", Math.floor(Math.random() * 2147483647));
if (el("btn-sd-models")) el("btn-sd-models").onclick = sdRefreshModels;
if (el("btn-sd-save")) el("btn-sd-save").onclick = async () => {
  if (!window.api.sdSetSettings) return;
  const s = await window.api.sdSetSettings(sdSettingsPatch());
  sdStatus(s);
  if (el("sd-message")) el("sd-message").textContent = "Settings saved.";
};
if (el("btn-sd-test")) el("btn-sd-test").onclick = async () => {
  if (!window.api.sdTest) return;
  const m = el("sd-message"); if (m) m.textContent = "Testing…";
  const r = await window.api.sdTest();
  if (m) m.textContent = r && r.ok ? `✓ Connected (${r.models} model(s))` : `⚠ ${(r && r.error) || "failed"}`;
  if (r && r.ok) sdRefreshModels();
};
if (el("btn-sd-generate")) el("btn-sd-generate").onclick = async () => {
  if (!window.api.sdGenerate) return;
  const prompt = el("sd-prompt").value.trim();
  const m = el("sd-message");
  if (!prompt) { if (m) m.textContent = "Enter a prompt first."; return; }
  if (m) m.textContent = "Generating… (this can take a moment)";
  const seedVal = el("sd-seed").value.trim();
  const p = sdSettingsPatch();
  const r = await window.api.sdGenerate({
    prompt, negativePrompt: el("sd-negative").value,
    steps: p.steps, cfg: p.cfg, width: p.width, height: p.height,
    sampler: p.sampler, batch: p.batch, model: p.model,
    seed: seedVal === "" ? -1 : Number(seedVal),
  });
  if (r && r.ok) {
    if (m) m.textContent = `Done${r.count > 1 ? ` — ${r.count} images` : ""}.`;
    sdShowImage({ dataUri: r.dataUri, prompt, from: r.from, seed: r.seed });
    sdRenderGallery();
  } else if (m) m.textContent = `⚠ ${(r && r.error) || "failed"}`;
};
if (el("btn-sd-copy-prompt")) el("btn-sd-copy-prompt").onclick = () => {
  if (sdLastImage && navigator.clipboard) navigator.clipboard.writeText(sdLastImage.prompt || "");
  if (el("sd-message")) el("sd-message").textContent = "Prompt copied.";
};
if (el("btn-sd-send-convo")) el("btn-sd-send-convo").onclick = () => {
  if (sdLastImage && el("composer-text")) { el("composer-text").value = `[image] ${sdLastImage.prompt || ""}`; updateCharCount(); }
  if (el("sd-message")) el("sd-message").textContent = "Prompt placed in Compose.";
};
if (el("btn-sd-save-img")) el("btn-sd-save-img").onclick = () => {
  if (el("sd-message")) el("sd-message").textContent = "Images are already saved with the project (Project Memory → search).";
};
function sdUseReply(site) { if (el("sd-prompt") && lastReplyBySite[site]) el("sd-prompt").value = lastReplyBySite[site]; }
if (el("btn-sd-use-chatgpt")) el("btn-sd-use-chatgpt").onclick = () => sdUseReply("chatgpt");
if (el("btn-sd-use-claude")) el("btn-sd-use-claude").onclick = () => sdUseReply("claude");
if (el("btn-sd-use-gemini")) el("btn-sd-use-gemini").onclick = () => sdUseReply("gemini");
if (window.api.onSdImage) window.api.onSdImage((payload) => { if (payload) sdShowImage(payload); sdRenderGallery(); });

el("btn-open-sequence").onclick = () => window.api.openSequenceEditor();

el("btn-main-row-collapse").onclick = () => {
  const collapsed = el("main-row").classList.toggle("collapsed");
  el("btn-main-row-collapse").textContent = collapsed ? "›" : "⌄";
  el("btn-main-row-collapse").title = collapsed ? "Expand the Transcript/Log panel" : "Collapse the Transcript/Log panel";
};

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

// The Tuner: runs the 🧪 connectivity check on all 3 sites, then a genuine
// A-to-B relay check on all 6 directed pairs (a few minutes total). Every
// individual check is already logged in detail to the Activity Log via the
// normal logEvent() path in main.js (tuner-leg-started/-ok/-error, etc.) --
// this listener just drives the button's own live progress text and the
// final consolidated summary, it doesn't duplicate that per-check logging.
const TUNER_SITE_LABEL = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };
function tunerLegLabel(leg) {
  const [source, target] = leg.split("->");
  return `${TUNER_SITE_LABEL[source] || source} → ${TUNER_SITE_LABEL[target] || target}`;
}
window.api.onTunerState((payload) => {
  const statusEl = el("tuner-status");
  if (!statusEl) return;
  if (payload.phase === "site") {
    statusEl.textContent = `Running: testing ${TUNER_SITE_LABEL[payload.site] || payload.site}'s own connection…`;
  } else if (payload.phase === "leg") {
    statusEl.textContent = `Running: testing ${tunerLegLabel(payload.leg)} relay…`;
  } else if (payload.phase === "done") {
    const { summary } = payload;
    statusEl.textContent = `Done — ${summary.sitesOk}/${summary.sitesTotal} sites OK, ${summary.legsOk}/${summary.legsTotal} relay legs OK.`;
    const brokenLegs = Object.values(payload.legs).filter((r) => !r.ok).map((r) => `${tunerLegLabel(r.leg)} (${r.stage}: ${r.error})`);
    const brokenSites = Object.entries(payload.sites).filter(([, r]) => !r.ok).map(([site, r]) => `${TUNER_SITE_LABEL[site] || site} (${r.stage || "reply"}: ${r.error})`);
    if (brokenLegs.length || brokenSites.length) {
      setStatus(`Tuner finished with problems — ${[...brokenSites, ...brokenLegs].join("; ")}`);
    } else {
      setStatus("Tuner finished — every site and every relay pair is working.");
    }
    el("btn-run-tuner").disabled = false;
  }
});

el("btn-run-tuner").onclick = async () => {
  el("btn-run-tuner").disabled = true;
  el("tuner-status").textContent = "Starting…";
  setStatus("Running the Tuner — this checks 3 sites and 6 relay pairs, can take a few minutes…");
  const res = await window.api.runTuner();
  if (!res?.ok && res?.error) {
    el("btn-run-tuner").disabled = false;
    setStatus(`Tuner couldn't start: ${res.error}`);
  }
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
    applyLogins(res.logins);
    for (const entry of res.log || []) appendLog(entry);
    for (const site of SITES) {
      if (res.captured[site]) renderPreview(site, res.captured[site]);
    }
    setStatus("Ready.");
  }
  // ON HOLD: the ATELIER governance panel is hidden (see controls.html). Skip
  // its startup probes so nothing runs while it's parked. To restore, un-hide
  // #col-atelier and re-enable these two calls:
  // atelierRefreshStatus();
  // atelierLoadSettings();
  databaseRefresh();
  memoryRefresh();
  stateRefresh();
  systemRefresh();
  lsiLoadSettings();
  lsiLoadRecommended();
  sdLoadSettings();
  sdRenderGallery();
  bookLoadList();
})();
