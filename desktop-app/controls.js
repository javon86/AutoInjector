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
let butlerActive = false; // whether → All also includes the butler (his Active checkbox)
// Default pane zoom: 60% (main.js applies the same default to the real pages).
const DEFAULT_PANE_ZOOM = 0.6;
let zoomLevels = { chatgpt: DEFAULT_PANE_ZOOM, claude: DEFAULT_PANE_ZOOM, gemini: DEFAULT_PANE_ZOOM };

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
  // The butler is a fourth participant row — same shape as an AI: a → send
  // button in the Send column and its own Active checkbox in the Active column.
  const butler = document.createElement("button");
  butler.id = "btn-send-butler";
  butler.textContent = "→ 🤵 Butler";
  butler.title = "Send this message to the butler (give him a goal / talk to him)";
  butler.setAttribute("aria-label", "Send this message to the butler");
  butler.onclick = () => sendToButler();
  grid.appendChild(butler);

  const butlerChk = document.createElement("input");
  butlerChk.type = "checkbox";
  butlerChk.id = "p-butler";
  butlerChk.checked = butlerActive;
  butlerChk.title = "Include the butler when you press → All";
  butlerChk.setAttribute("aria-label", "Butler active");
  butlerChk.onchange = (e) => { butlerActive = e.target.checked; };
  grid.appendChild(butlerChk);

  // → All: send to every checked AI, plus the butler when his box is checked.
  const all = document.createElement("button");
  all.className = "primary";
  all.textContent = "→ All";
  all.onclick = () => { sendCompose(SITES.filter((s) => enabled[s])); if (butlerActive) sendToButler(); };
  grid.appendChild(all);
}

async function sendCompose(targets) {
  let text = el("composer-text").value.trim();
  const atts = composeAttachments.slice();
  if (!text && !atts.length) { setStatus("Type a message first."); return; }
  if (!targets.length) { setStatus("No enabled participants to send to."); return; }
  // Locker files (pictures, PDFs, …) go up first as real uploads, so the text
  // that follows is sent together with them.
  if (atts.length) {
    if (typeof window.api.lockersAttach !== "function") { setStatus("Uploading locker files isn't available in this build."); return; }
    setStatus(`Uploading ${atts.length} file${atts.length === 1 ? "" : "s"} to ${targets.map((t) => SITE_LABELS[t]).join(", ")}…`);
    const failed = [];
    for (const a of atts) {
      let r;
      try { r = await window.api.lockersAttach(a.site, a.rel, targets); } catch (e) { r = { ok: false, error: String(e) }; }
      if (!r || !r.ok) failed.push(`${a.rel} (${(r && r.error) || "upload failed"})`);
    }
    if (failed.length) { setStatus(`Couldn't upload: ${failed.join(", ")} — nothing was sent. Fix it or remove the file and try again.`); return; }
    if (!text) text = `(Sent you ${atts.length === 1 ? "a file" : `${atts.length} files`}: ${atts.map((a) => a.rel).join(", ")})`;
    clearComposeAttachments();
  }
  setStatus(`Sending to ${targets.map((t) => SITE_LABELS[t]).join(", ")}…`);
  const res = await window.api.sendCompose(text, targets);
  if (!res?.ok) setStatus(`Send failed: ${res?.error || "unknown error"}`);
}

// ---- 📁 Locker browser: what's in each AI's locker, click to use it ----
let composeAttachments = []; // [{ site, rel, kind }]
function renderComposeAttachments() {
  const box = el("compose-attachments");
  if (!box) return;
  box.innerHTML = "";
  for (const a of composeAttachments) {
    const chip = document.createElement("span");
    chip.className = "att-chip";
    chip.textContent = `${a.kind === "image" ? "🖼️" : "📎"} ${SITE_LABELS[a.site] || a.site}/${a.rel}`;
    const x = document.createElement("button");
    x.textContent = "✕";
    x.title = "Remove";
    x.setAttribute("aria-label", `Remove ${a.rel}`);
    x.onclick = () => { composeAttachments = composeAttachments.filter((c) => c !== a); renderComposeAttachments(); };
    chip.appendChild(x);
    box.appendChild(chip);
  }
}
function clearComposeAttachments() { composeAttachments = []; renderComposeAttachments(); }
function fmtDate(ms) {
  const d = new Date(Number(ms) || 0);
  if (!ms || isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? `Today ${time}` : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
function fmtSize(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
async function refreshLocker(site) {
  const list = el(`locker-list-${site}`);
  if (!list || typeof window.api.lockersList !== "function") return;
  let r;
  try { r = await window.api.lockersList(site); } catch (e) { r = { ok: false, error: String(e) }; }
  list.innerHTML = "";
  if (!r || !r.ok) {
    const err = document.createElement("div");
    err.className = "lk-row";
    err.textContent = `Couldn't read the locker: ${(r && r.error) || "error"}`;
    list.appendChild(err);
    return;
  }
  const tab = el(`locker-tab-${site}`);
  if (tab) tab.textContent = `📁 Locker (${r.files.length}${r.truncated ? "+" : ""})`;
  if (r.files.length) {
    const head = document.createElement("div");
    head.className = "lk-row lk-head";
    const hIc = document.createElement("span"); hIc.textContent = " ";
    const hName = document.createElement("span"); hName.className = "lk-name"; hName.textContent = "Name";
    const hDate = document.createElement("span"); hDate.className = "lk-date"; hDate.textContent = "Modified";
    const hSize = document.createElement("span"); hSize.className = "lk-size"; hSize.textContent = "Size";
    head.append(hIc, hName, hDate, hSize);
    list.appendChild(head);
  }
  for (const f of r.files) {
    const row = document.createElement("button");
    row.className = "lk-row";
    row.title = f.kind === "text" ? "Click: put this file's text into Compose" : "Click: attach this file in Compose — it uploads when you click an AI's name";
    const ic = document.createElement("span");
    ic.textContent = f.kind === "image" ? "🖼️" : f.kind === "text" ? "📄" : "📎";
    // Name first (bold), the folder it's in after it (dim), then date + size.
    const nm = document.createElement("span");
    nm.className = "lk-name";
    const parts = String(f.rel).split(/[\\/]/);
    const base = document.createElement("b");
    base.textContent = parts.pop();
    nm.appendChild(base);
    if (parts.length) {
      const dir = document.createElement("span");
      dir.className = "lk-dir";
      dir.textContent = parts.join("\\");
      nm.appendChild(dir);
    }
    nm.title = f.rel;
    const dt = document.createElement("span");
    dt.className = "lk-date";
    dt.textContent = fmtDate(f.mtime);
    const sz = document.createElement("span");
    sz.className = "lk-size";
    sz.textContent = fmtSize(f.size);
    row.append(ic, nm, dt, sz);
    row.onclick = (e) => { e.stopPropagation(); useLockerFile(site, f); };
    list.appendChild(row);
  }
}
// Text -> pasted into Compose. Anything else (pictures, PDFs, big files) ->
// attached in Compose and uploaded to whichever AI you click.
async function useLockerFile(site, f) {
  const box = el("composer-text");
  if (f.kind === "text" && typeof window.api.lockersRead === "function") {
    let r;
    try { r = await window.api.lockersRead(site, f.rel); } catch (e) { r = { ok: false, error: String(e) }; }
    if (r && r.ok && r.text != null) {
      const block = `----- ${SITE_LABELS[site]}'s locker: ${f.rel} -----\n${r.text}\n----- end of file -----`;
      const cur = box.value;
      const at = typeof box.selectionStart === "number" && document.activeElement === box ? box.selectionStart : cur.length;
      box.value = cur.slice(0, at) + (at && !cur.slice(0, at).endsWith("\n") ? "\n" : "") + block + "\n" + cur.slice(at);
      try { updateCharCount(); } catch (_) {}
      box.focus();
      setStatus(`Put ${f.rel} into Compose — click an AI's name to send it.`);
      return;
    }
    // too big / unreadable as text -> fall through to attaching it
  }
  if (composeAttachments.some((a) => a.site === site && a.rel === f.rel)) { setStatus(`${f.rel} is already attached.`); return; }
  composeAttachments.push({ site, rel: f.rel, kind: f.kind });
  renderComposeAttachments();
  setStatus(`Attached ${f.rel} — click an AI's name to upload it to them.`);
}
function wireLockers() {
  if (typeof window.api.lockersList !== "function") return;
  for (const s of SITES) refreshLocker(s);
  if (typeof window.api.onLockerChanged === "function") {
    window.api.onLockerChanged((p) => { for (const s of SITES) if (!p || p.site === "all" || p.site === s) refreshLocker(s); });
  }
  // Files you drop into a locker yourself (Explorer) show up within a few seconds.
  setInterval(() => { for (const s of SITES) { const l = el(`locker-list-${s}`); if (l && !l.hidden) refreshLocker(s); } }, 8000);
}

// Butler handling mode — how the next message you send him is handled:
//   converse : just talk; he replies in prose and speaks it, no task
//   auto     : he decides (a computer-task call-sign like "install…" → himself)
//   self     : he does it locally (code/install/tools), never the AIs
//   delegate : he routes it to ChatGPT/Claude/Gemini
const BUTLER_MODES = ["converse", "auto", "self", "delegate"];
const BUTLER_MODE_META = {
  converse: { ic: "💬", tx: "Converse", cls: "mode-converse" },
  auto:     { ic: "🔀", tx: "Auto",     cls: "mode-auto" },
  self:     { ic: "🤵", tx: "Himself",  cls: "mode-self" },
  delegate: { ic: "📤", tx: "Delegate", cls: "mode-delegate" },
};
let butlerMode = "auto";
try { const s = localStorage.getItem("butlerMode"); if (BUTLER_MODES.includes(s)) butlerMode = s; } catch (_) {}
function renderButlerMode() {
  const b = el("btn-butler-mode"); if (!b) return;
  const meta = BUTLER_MODE_META[butlerMode] || BUTLER_MODE_META.auto;
  b.classList.remove("mode-converse", "mode-auto", "mode-self", "mode-delegate");
  b.classList.add(meta.cls);
  const ic = b.querySelector(".mode-ic"); if (ic) ic.textContent = meta.ic;
  const tx = b.querySelector(".mode-tx"); if (tx) tx.textContent = meta.tx;
}
function setButlerMode(mode) {
  if (!BUTLER_MODES.includes(mode)) return;
  butlerMode = mode;
  try { localStorage.setItem("butlerMode", mode); } catch (_) {}
  renderButlerMode();
}
if (el("btn-butler-mode")) {
  renderButlerMode();
  el("btn-butler-mode").onclick = () => {
    const next = BUTLER_MODES[(BUTLER_MODES.indexOf(butlerMode) + 1) % BUTLER_MODES.length];
    setButlerMode(next);
    uiLog("click", { id: "btn-butler-mode", msg: `butler mode: ${next}` });
    setStatus(`Butler mode: ${BUTLER_MODE_META[next].tx} — ${next === "converse" ? "just chatting" : next === "self" ? "he'll do it himself" : next === "delegate" ? "he'll ask the AIs" : "he decides"}.`);
  };
}
// Converse: echo my line into his window, then his reply is shown + spoken by main.
async function butlerConverse(text) {
  if (!window.api.butlerChat) { logToCenter("Butler chat unavailable.", { tag: "manager", err: true }); return; }
  appendButlerLine({ cls: "bl-tome", who: "You → 🤵", text });
  const r = await window.api.butlerChat(text);
  if (!r || !r.ok) logToCenter(`Butler couldn't reply: ${(r && r.error) || "error"}${r && r.error === "NOT_CONFIGURED" ? " — give him a local model first." : ""}`, { tag: "manager", err: true });
}
// The one place that hands a message to the butler, honouring the current mode.
async function butlerHandle(text, opts = {}) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, error: "EMPTY" };
  if (butlerMode === "converse") { await butlerConverse(t); return { ok: true, converse: true }; }
  if (!window.api.startManagedTask) { setStatus("Butler isn't available."); return { ok: false, error: "UNAVAILABLE" }; }
  if (opts.mirror && el("jarvis-goal")) el("jarvis-goal").value = t;
  const r = await window.api.startManagedTask(t, butlerMode); // auto | self | delegate
  if (r && r.ok) { if (typeof jarvisShowRunning === "function") jarvisShowRunning(true); }
  return r || { ok: false, error: "error" };
}

// Send the composer text to the butler — honours the handling-mode toggle.
async function sendToButler() {
  const text = el("composer-text").value.trim();
  if (!text) { setStatus("Type a message first."); return; }
  setStatus(butlerMode === "converse" ? "Talking to the butler…" : `Sending to the butler (${BUTLER_MODE_META[butlerMode].tx})…`);
  const r = await butlerHandle(text, { mirror: true });
  if (r && r.ok) setStatus(butlerMode === "converse" ? "Asked the butler." : "Sent to the butler.");
  else { const hint = r && r.error === "NOT_CONFIGURED" ? " — give him a local model in the Butler bar (⚙️) first." : ""; setStatus(`Butler can't start: ${(r && r.error) || "error"}${hint}`); }
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
  zoomLabel.textContent = `${Math.round(DEFAULT_PANE_ZOOM * 100)}%`;
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

  // 📁 Locker (default) / 💬 Last reply. The live pane below already shows the
  // reply, so this box shows what's in that AI's locker instead; the old reply
  // preview is one click away (same #preview-<site> element as before).
  const lockerBox = document.createElement("div");
  lockerBox.className = "locker-box";
  const ltabs = document.createElement("div");
  ltabs.className = "locker-tabs";
  const lkTab = document.createElement("button");
  lkTab.className = "active";
  lkTab.id = `locker-tab-${site}`;
  lkTab.textContent = "📁 Locker";
  lkTab.title = `Files in ${SITE_LABELS[site]}'s locker. Click a file to put it in Compose, then click an AI's name to give it to them.`;
  const rpTab = document.createElement("button");
  rpTab.id = `reply-tab-${site}`;
  rpTab.textContent = "💬 Last reply";
  const lkSpacer = document.createElement("span");
  lkSpacer.className = "spacer";
  const lkRefresh = document.createElement("button");
  lkRefresh.className = "lk-refresh";
  lkRefresh.textContent = "↻";
  lkRefresh.title = "Refresh the file list";
  lkRefresh.setAttribute("aria-label", `Refresh ${SITE_LABELS[site]}'s locker list`);
  ltabs.append(lkTab, rpTab, lkSpacer, lkRefresh);
  const lkList = document.createElement("div");
  lkList.className = "locker-list";
  lkList.id = `locker-list-${site}`;
  const preview = document.createElement("div");
  preview.className = "preview";
  preview.id = `preview-${site}`;
  preview.textContent = "No reply captured yet.";
  preview.hidden = true;
  const showLocker = (on) => {
    lkList.hidden = !on; preview.hidden = on;
    lkTab.classList.toggle("active", on); rpTab.classList.toggle("active", !on);
    if (on) refreshLocker(site);
  };
  lkTab.onclick = (e) => { e.stopPropagation(); showLocker(true); };
  rpTab.onclick = (e) => { e.stopPropagation(); showLocker(false); };
  lkRefresh.onclick = (e) => { e.stopPropagation(); refreshLocker(site); };
  lockerBox.append(ltabs, lkList, preview);
  strip.appendChild(lockerBox);

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
  if (entry.detail?.id) parts.push(`#${entry.detail.id}`);
  if (entry.detail?.msg) parts.push(entry.detail.msg);
  // A human-written summary (manager events, the capability test, …) reads far
  // better than the raw kind — lead with it when present.
  if (entry.detail?.summary) return `${entry.detail.summary}${parts.length ? " " + parts.join(" ") : ""}`.trim();
  return `${entry.kind} ${parts.join(" ")}`.trim();
}

// The 13 tags (single source of truth is log-tags.js in main; fetched over IPC).
// Starts empty and is filled in on load; appendLogLine tolerates a missing tag,
// so log lines render correctly even for the first few events before it arrives.
let LOG_TAGS = { TAGS: {}, TAG_IDS: [] };

// Add one log line to the unified window, with its colour-coded tag chip. Works
// for both real events (kind+detail) and injected chat lines ({tag, text}), and
// never throws on an unknown/missing tag (falls back to a neutral chip).
function appendLogLine({ ts, tag, text, err, level }) {
  const box = el("activity-log");
  if (!box) return;
  const id = tag || "system";
  const meta = LOG_TAGS.TAGS[id] || { label: id, color: "#8a94a6" };
  // Level drives the "⚠ Errors only" view: error/warning stay, everything else
  // is hidden when it's on. `err` (error only) still drives the red styling.
  const lvl = level || (err ? "error" : "info");
  const line = document.createElement("div");
  line.className = `log-line${lvl === "error" ? " err" : ""}${lvl === "warning" ? " warn" : ""}`;
  line.dataset.tag = id;
  line.dataset.level = lvl;
  const chip = document.createElement("span");
  chip.className = "log-chip";
  chip.textContent = meta.label;
  chip.style.background = meta.color;
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = new Date(ts || Date.now()).toLocaleTimeString();
  const msg = document.createElement("span");
  msg.className = "log-msg";
  msg.textContent = text || "";
  line.appendChild(chip); line.appendChild(t); line.appendChild(msg);
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
  box.appendChild(line);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function appendLog(entry) {
  const level = entry.level || (String(entry.kind || "").includes("error") ? "error" : "info");
  appendLogLine({ ts: entry.ts, tag: entry.tag || "system", text: logLineText(entry), err: level === "error", level });
}

// Route an operational status/progress line straight into the ONE center
// Activity Log, instead of a scattered per-control box. Every former side-log
// (System Check, install progress, model downloads, the migrate, the log
// bundle, the intro) now funnels through here so there's a single place to
// read, filter and export — nothing is lost, it's just all in one window.
function logToCenter(text, opts = {}) {
  const t = String(text == null ? "" : text).replace(/\s+$/,"");
  if (!t.trim()) return;
  appendLogLine({ ts: Date.now(), tag: opts.tag || "system", text: t, err: !!opts.err, level: opts.err ? "error" : (opts.level || "info") });
}

// The conversation itself, folded into the one log under the Chat tag, so the
// window truly catches everything (the formatted transcript still exists too).
function appendUnifiedChatTurn(turn) {
  if (!turn) return;
  const who = turn.label || turn.site || "AI";
  const body = String(turn.text || "").replace(/\s+/g, " ").trim();
  appendLogLine({ ts: turn.ts || Date.now(), tag: "chat", text: `${who}: ${body}` });
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
  appendUnifiedChatTurn(turn);
  // Also show it in the butler's colour-coded window. An [TO: X] tag of USER (or
  // none — the default) means it's addressed to ME → bright + 2× via bl-tome;
  // an AI↔AI message is coloured as the sender.
  if (turn && turn.site) {
    const to = String(turn.roundtableTag || "USER").toUpperCase();
    const tome = to === "USER";
    appendButlerLine({
      cls: tome ? "bl-tome" : ("bl-" + turn.site),
      who: tome ? `${turn.label} → You` : turn.label,
      text: turn.text,
    });
  }
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

// --- Unified log: tag filters (checked = show that category) -------------------
function buildLogFilters() {
  const bar = el("log-filters");
  const box = el("activity-log");
  if (!bar || !box || !LOG_TAGS.TAG_IDS.length) return;
  bar.textContent = ""; // rebuild if tags arrive/refresh
  // Inject the hide rules once: #activity-log.hide-<tag> [data-tag=<tag>]{display:none}
  const style = document.getElementById("log-filter-style") || document.createElement("style");
  style.id = "log-filter-style";
  style.textContent = LOG_TAGS.TAG_IDS.map((id) => `#activity-log.hide-${id} .log-line[data-tag="${id}"]{display:none}`).join("\n");
  if (!style.parentNode) document.head.appendChild(style);
  // Restore any saved hidden set (per-viewer convenience only).
  let hidden = {};
  try { hidden = JSON.parse(localStorage.getItem("logHiddenTags") || "{}") || {}; } catch (_) { hidden = {}; }
  const save = () => { try { localStorage.setItem("logHiddenTags", JSON.stringify(hidden)); } catch (_) {} };
  const apply = (id) => box.classList.toggle(`hide-${id}`, !!hidden[id]);
  for (const id of LOG_TAGS.TAG_IDS) {
    const tag = LOG_TAGS.TAGS[id];
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !hidden[id]; // checked = visible
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = tag.color;
    const txt = document.createElement("span");
    txt.textContent = tag.label;
    label.appendChild(cb); label.appendChild(sw); label.appendChild(txt);
    label.title = `Show/hide ${tag.label} lines`;
    cb.onchange = () => { hidden[id] = !cb.checked; apply(id); save(); uiLog("click", { id: `log-filter-${id}`, msg: `${cb.checked ? "show" : "hide"} ${tag.label}` }); };
    bar.appendChild(label);
    apply(id);
  }
}
// Fetch the tag list from main (over IPC, since the sandboxed preload can't
// require it), then build the filter chips. Log lines already render before
// this resolves — appendLogLine tolerates a not-yet-known tag.
if (window.api.logTagsInfo) {
  window.api.logTagsInfo().then((info) => {
    if (info && Array.isArray(info.TAG_IDS) && info.TAG_IDS.length) { LOG_TAGS = info; buildLogFilters(); }
  }).catch(() => {});
}
if (el("btn-log-clear")) el("btn-log-clear").onclick = () => { const b = el("activity-log"); if (b) b.textContent = ""; uiLog("click", { id: "btn-log-clear", msg: "cleared the log view" }); };

// "⚠ Errors only": a cross-cutting filter on top of the per-tag checkboxes —
// when on, only error/warning lines show, whatever their tag. Remembered per
// viewer (localStorage), same as the tag filters.
(function initErrorsOnly() {
  const cb = el("cb-errors-only");
  const box = el("activity-log");
  if (!cb || !box) return;
  let on = false;
  try { on = localStorage.getItem("logErrorsOnly") === "1"; } catch (_) {}
  cb.checked = on;
  box.classList.toggle("errors-only", on);
  cb.onchange = () => {
    box.classList.toggle("errors-only", cb.checked);
    try { localStorage.setItem("logErrorsOnly", cb.checked ? "1" : "0"); } catch (_) {}
    uiLog("click", { id: "cb-errors-only", msg: `errors-only ${cb.checked ? "on" : "off"}` });
  };
})();

// --- Full activity trace: log EVERY user action into the same Activity Log ------
// so you can always see what's going on, no matter what you're doing.
const uiLog = (action, detail) => { try { if (window.api.uiLog) window.api.uiLog(action, detail); } catch (_) {} };
// Every button click says something (by id + its label).
document.addEventListener("click", (e) => {
  const b = e.target && e.target.closest && e.target.closest("button");
  if (!b) return;
  const label = (b.textContent || b.title || b.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 40);
  uiLog("click", { id: b.id || null, msg: label ? `“${label}”` : "(button)" });
}, true);
// Every collapsible section (System AI sub-panels, etc.) opening/closing says something.
for (const d of document.querySelectorAll("details")) {
  d.addEventListener("toggle", () => {
    const name = (d.querySelector("summary")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
    uiLog("panel", { msg: `${name || "section"} ${d.open ? "opened" : "closed"}` });
  });
}
// Every message the program actually sends (ledger entry) shows up with its ID.
if (window.api.onLedgerEntry) window.api.onLedgerEntry((led) => {
  if (!led) return;
  appendLog({ ts: led.ts || Date.now(), kind: "message", detail: { id: led.id, msg: `${led.source || "you"}→${led.target} ${led.status}${led.error ? " " + led.error : ""}` } });
});

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
  image: { panelId: "col-image", label: "Image Generation" },
  video: { panelId: "col-video", label: "Video Generation" },
  gpu: { panelId: "col-gpu", label: "GPU Usage" },
  systemai: { panelId: "col-systemai", label: "System AI" },
  bookforge: { panelId: "col-bookforge", label: "BookForge bridge" }
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
  uiLog("panel", { msg: `${label} panel minimized` });
}
function expandYellowPanel(key) {
  el(COLLAPSIBLE_PANELS[key].panelId).classList.remove("hidden-collapsed");
  el(`tab-${key}`)?.remove();
  uiLog("panel", { msg: `${COLLAPSIBLE_PANELS[key].label} panel restored` });
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

// --- System AI (Local Supervisor) panel + User Panel switch ----------------
if (el("btn-collapse-systemai")) el("btn-collapse-systemai").onclick = () => collapseYellowPanel("systemai");
if (el("btn-collapse-image")) el("btn-collapse-image").onclick = () => collapseYellowPanel("image");
if (el("btn-collapse-video")) el("btn-collapse-video").onclick = () => collapseYellowPanel("video");
if (el("btn-collapse-gpu")) el("btn-collapse-gpu").onclick = () => collapseYellowPanel("gpu");

// Butler Device panel: System Check (what he can do) + Send Intro (tell the AIs
// who he is + the rules). Nothing is sent unless you press a button.
function deviceSpeak(text) {
  if (el("device-speak") && el("device-speak").checked && window.api.voiceSpeak && text) { try { window.api.voiceSpeak(text); } catch (_) {} }
}
// A fix-it hint for each capability that can fail or be missing — shown next to
// a red/gray result in the pop-up so you know what to do about it.
const CAP_TIPS = {
  "Brain (local model)": "Install Ollama and download a model, then pick it in ⚙️ Local model settings and press Save + Test.",
  "Run code (Open Interpreter)": "Open the Setup Wizard → Auto-setup (or Install Missing) to install Open Interpreter — it needs Python 3.12.",
  "Open a file (read & write)": "Check the app can write to its output folder ('stuff and thing') — free disk space and folder permissions.",
  "Tools (USE_TOOL)": "No tools are registered, or the read-file tool failed — check the output folder exists and is readable.",
  "Memory (remember & recall)": "The shared database is off or unavailable — reopen the app; if it persists, check disk space where app data lives.",
  "Image generation": "Turn on Image generation and set a reachable Stable Diffusion endpoint in the Image panel (Auto-detect can find it).",
  "Video generation": "Turn on Video generation and set a reachable text-to-video endpoint in the Video panel (AnimateDiff / SVD / ComfyUI).",
  "Voice (speak)": "Enable Voice and set the local voice shim endpoint (install piper/whisper via the Setup Wizard).",
  "Talk to ChatGPT": "Open the ChatGPT pane and make sure you're signed in, then enable it as a participant up top.",
  "Talk to Claude": "Open the Claude pane and make sure you're signed in, then enable it as a participant up top.",
  "Talk to Gemini": "Open the Gemini pane and make sure you're signed in, then enable it as a participant up top.",
};
function capTipFor(c) {
  if (c.tip) return c.tip;
  if (CAP_TIPS[c.name]) return CAP_TIPS[c.name];
  if (/^Talk to/.test(c.name)) return "Open that AI's pane, sign in, and enable it as a participant up top.";
  return "Open the Setup Wizard to configure this capability.";
}

// The live "reel": a chip per capability, added as each finishes, so you watch
// the sweep go by. A trailing spinner shows it's still working.
let capReelActive = false;
function capReelReset() {
  const reel = el("cap-reel"); if (!reel) return;
  reel.innerHTML = "";
  const spin = document.createElement("span"); spin.className = "cap-chip running"; spin.id = "cap-reel-spinner";
  spin.innerHTML = '<span class="spin"></span><span>testing…</span>';
  reel.appendChild(spin);
  reel.classList.add("on");
}
function capReelStep(c) {
  const reel = el("cap-reel"); if (!reel) return;
  const cls = c.ok === true ? "pass" : c.ok === false ? "fail" : "skip";
  const mark = c.ok === true ? "✅" : c.ok === false ? "❌" : "⚪";
  const chip = document.createElement("span");
  chip.className = `cap-chip ${cls}`;
  chip.textContent = `${mark} ${c.name}`;
  chip.title = c.detail || "";
  const spin = el("cap-reel-spinner");
  if (spin) reel.insertBefore(chip, spin); else reel.appendChild(chip);
  reel.scrollLeft = reel.scrollWidth;
}
if (window.api.onCapabilityTestStep) window.api.onCapabilityTestStep((c) => { if (capReelActive) capReelStep(c); });

// Fill and open the 3-bucket results pop-up.
function openCapModal(r) {
  const modal = el("cap-modal"); if (!modal) return;
  const buckets = { working: [], failed: [], notset: [] };
  for (const c of (r.checks || [])) (c.ok === true ? buckets.working : c.ok === false ? buckets.failed : buckets.notset).push(c);
  const fill = (listId, arr, withTip) => {
    const box = el(listId); if (!box) return;
    box.innerHTML = "";
    if (!arr.length) { const d = document.createElement("div"); d.className = "cap-item"; d.style.opacity = ".6"; d.textContent = "—"; box.appendChild(d); return; }
    for (const c of arr) {
      const item = document.createElement("div"); item.className = "cap-item";
      let html = `<span class="nm">${gpuEsc(c.name)}</span>`;
      if (c.detail) html += `<span class="why">${gpuEsc(c.detail)}</span>`;
      if (withTip) html += `<span class="tip">💡 ${gpuEsc(capTipFor(c))}</span>`;
      item.innerHTML = html; box.appendChild(item);
    }
  };
  el("cap-n-working").textContent = buckets.working.length;
  el("cap-n-failed").textContent = buckets.failed.length;
  el("cap-n-notset").textContent = buckets.notset.length;
  fill("cap-list-working", buckets.working, false);
  fill("cap-list-failed", buckets.failed, true);
  fill("cap-list-notset", buckets.notset, true);
  el("cap-modal-sub").textContent = `${r.okCount}/${r.total} capabilities actually worked${r.failCount ? `, ${r.failCount} not working` : ""}. ⚪ = not set up yet.`;
  if (el("cap-modal-title")) el("cap-modal-title").textContent = "🧪 Capability test results";
  modal.classList.add("on");
}
function closeCapModal() { const m = el("cap-modal"); if (m) m.classList.remove("on"); }
if (el("btn-cap-modal-close")) el("btn-cap-modal-close").onclick = closeCapModal;
if (el("cap-modal")) el("cap-modal").addEventListener("click", (e) => { if (e.target === el("cap-modal")) closeCapModal(); });

// Run the deep capability test: live reel while it runs, a 3-bucket pop-up when
// it's done, and full detail in the Activity Log. Shared by every entry point
// (butler-panel button, User Panel button, System Check deep toggle).
let capTestRunning = false;
async function runCapabilityTest(triggerBtn) {
  if (capTestRunning) return;
  if (!window.api.butlerCapabilityTest) { logToCenter("Capability test unavailable.", { tag: "setup", err: true }); return; }
  capTestRunning = true; capReelActive = true; capReelReset();
  const btns = ["btn-cap-run", "btn-capability-test", "btn-selfcheck"].map(el).filter(Boolean);
  const prev = btns.map((b) => b.textContent);
  btns.forEach((b) => { b.disabled = true; }); if (triggerBtn) triggerBtn.textContent = "🧪 Testing…";
  logToCenter("🧪 Capability test started — really running code, files, tools, memory, image, video, voice, and pinging the AIs…", { tag: "setup" });
  let r; try { r = await window.api.butlerCapabilityTest(); } catch (e) { r = { ok: false, error: String(e) }; }
  capReelActive = false; capTestRunning = false;
  const spin = el("cap-reel-spinner"); if (spin) spin.remove();
  btns.forEach((b, i) => { b.disabled = false; b.textContent = prev[i]; });
  if (!r || !r.ok) { logToCenter(`Capability test failed: ${(r && r.error) || "error"}`, { tag: "setup", err: true }); return; }
  logToCenter(`🧪 Capability test done — ${r.okCount}/${r.total} worked${r.failCount ? `, ${r.failCount} failed` : ""} (⚪ = not set up).`, { tag: "setup" });
  openCapModal(r);
  deviceSpeak(`Capability test: ${r.okCount} of ${r.total} capabilities actually worked${r.failCount ? `, ${r.failCount} failed` : ""}.`);
}
// Every entry point runs the same test (reel + pop-up).
if (el("btn-cap-run")) el("btn-cap-run").onclick = () => { uiLog("click", { id: "btn-cap-run", msg: "test all capabilities" }); runCapabilityTest(el("btn-cap-run")); };
if (el("btn-capability-test")) el("btn-capability-test").onclick = () => { uiLog("click", { id: "btn-capability-test", msg: "run capability test" }); runCapabilityTest(el("btn-capability-test")); };

if (el("btn-selfcheck")) el("btn-selfcheck").onclick = async () => {
  const deep = !!(el("cb-deep-check") && el("cb-deep-check").checked);
  // Deep mode: actually exercise every capability (streams to the Activity Log).
  if (deep) { await runCapabilityTest(el("btn-selfcheck")); return; }

  // Quick readiness check → each capability's status streams into the center log.
  if (!window.api.butlerSelfCheck) { logToCenter("System check unavailable.", { tag: "setup", err: true }); return; }
  logToCenter("🩺 System check…", { tag: "setup" });
  let r; try { r = await window.api.butlerSelfCheck(); } catch (_) { r = null; }
  if (!r || !r.ok) { logToCenter(`System check failed: ${(r && r.error) || "error"}`, { tag: "setup", err: true }); return; }
  logToCenter(`🩺 System check — ${r.okCount}/${r.total} capabilities ready.`, { tag: "setup" });
  for (const c of r.checks) {
    const mark = c.ok === true ? "✅" : c.ok === false ? "❌" : "⚪";
    logToCenter(`${mark} ${c.name}${c.detail ? " — " + c.detail : ""}`, { tag: "setup", err: c.ok === false });
  }
  if (Array.isArray(r.installs) && r.installs.length) {
    logToCenter(`Dependencies — ${(r.missing || []).length} not installed:`, { tag: "setup" });
    for (const it of r.installs) {
      const mark = it.installed === true ? "✅ installed" : it.installed === false ? "❌ not installed" : "⚪ n/a";
      logToCenter(`   ${it.label}: ${mark}`, { tag: "setup", err: it.installed === false });
    }
  }
  if (el("btn-install-missing")) el("btn-install-missing").disabled = !r.canInstall;
  deviceSpeak(`System check: ${r.okCount} of ${r.total} capabilities working. ${(r.missing || []).length} dependencies not installed.`);
};
// Install everything that's missing (Open Interpreter first, so he controls it).
if (el("btn-install-missing")) el("btn-install-missing").onclick = async () => {
  if (!window.api.butlerInstallMissing) { logToCenter("Installer unavailable.", { tag: "setup", err: true }); return; }
  const btn = el("btn-install-missing"); btn.disabled = true; btn.textContent = "⚙️ Installing…";
  logToCenter("⚙️ Installing missing dependencies…", { tag: "setup" });
  let r; try { r = await window.api.butlerInstallMissing(); } catch (e) { r = { ok: false, error: String(e) }; }
  btn.textContent = "⚙️ Install Missing"; btn.disabled = false;
  logToCenter((r && r.ok) ? `Install done: ${r.installed || 0}/${(r.results || []).length} installed.` : `Install failed: ${(r && r.error) || "failed"}`, { tag: "setup", err: !(r && r.ok) });
  if (el("btn-selfcheck")) el("btn-selfcheck").click(); // refresh the status
};
if (window.api.onSetupProgress) window.api.onSetupProgress(({ target, line }) => {
  if (!line) return;
  logToCenter(`${target ? target + ": " : ""}${line}`, { tag: "setup" });
});
if (el("btn-send-intro")) el("btn-send-intro").onclick = async () => {
  if (!window.api.butlerSendIntro) { logToCenter("Intro unavailable.", { tag: "manager", err: true }); return; }
  logToCenter("📣 Sending the intro to the AIs…", { tag: "manager" });
  let r; try { r = await window.api.butlerSendIntro(); } catch (_) { r = null; }
  if (r && r.ok) { logToCenter(`Intro sent to: ${r.targets.join(", ")}. They now know who the butler is and the rules.`, { tag: "manager" }); deviceSpeak("Introduction sent to the assistants."); }
  else logToCenter(`Couldn't send intro: ${(r && r.error === "NO_TARGETS") ? "no AIs are enabled — check ChatGPT/Claude/Gemini up top." : (r && r.error) || "error"}`, { tag: "manager", err: true });
};

// Who's-speaking indicator: light the current speaker's chip in its colour.
if (window.api.onVoiceSpeaking) window.api.onVoiceSpeaking(({ who, speaking }) => {
  const chip = document.querySelector(`#speaking-indicator .spk-chip[data-who="${who}"]`);
  if (chip) chip.classList.toggle("speaking", !!speaking);
});

// Talk to the butler by voice — fills the one task box (#jarvis-goal) and sends.
// (The typed path is the Start Butler button below; feedback goes to the log.)
async function deviceSendTask(text) {
  const t = String(text || "").trim();
  if (!t) { logToCenter("Type or say something for the butler first.", { tag: "manager" }); return; }
  const r = await butlerHandle(t, { mirror: true }); // honours the mode toggle (converse/auto/self/delegate)
  if (r && r.converse) return; // butlerConverse already reported
  logToCenter(r && r.ok ? `🤵 Butler: on it — "${t.slice(0, 60)}"` : `Can't start the butler: ${(r && r.error) || "error"}${r && r.error === "NOT_CONFIGURED" ? " — give him a local model first." : ""}`, { tag: "manager", err: !(r && r.ok) });
}
async function deviceListenOnce() {
  if (!window.api.voiceListen) { logToCenter("Voice engine not available.", { tag: "voice", err: true }); return null; }
  logToCenter("🎤 Listening…", { tag: "voice" });
  let r; try { r = await window.api.voiceListen({}); } catch (_) { r = null; }
  if (r && r.ok && r.text && r.text.trim()) return r.text.trim();
  logToCenter(r && r.error ? `Didn't catch that (${r.error}).` : "Didn't catch that.", { tag: "voice" });
  return null;
}
if (el("btn-device-ptt")) el("btn-device-ptt").onclick = async () => {
  const t = await deviceListenOnce();
  if (t) { if (el("jarvis-goal")) el("jarvis-goal").value = t; deviceSendTask(t); }
};
let openMicOn = false;
async function openMicLoop() {
  while (openMicOn) {
    const t = await deviceListenOnce();
    if (!openMicOn) break;
    if (t) deviceSendTask(t);
    await new Promise((r) => setTimeout(r, 400));
  }
}
if (el("device-openmic")) el("device-openmic").onchange = (e) => {
  openMicOn = !!e.target.checked;
  logToCenter(openMicOn ? "🎤 Open mic on — talk freely." : "Open mic off.", { tag: "voice" });
  if (openMicOn) openMicLoop();
};

// Image Generation panel. Compact = prompt/negative/LoRA + Generate; expanding
// (⤢ More) reveals a live preview, size/steps, a recent-renders strip, and the
// connection config. There's also a button that opens the real SD web UI.
// Wire a range slider to its value display (live) and return a getter.
function wireSlider(rangeId, spanId) {
  const r = el(rangeId), sp = el(spanId);
  if (r) { const upd = () => { if (sp) sp.textContent = r.value; }; r.addEventListener("input", upd); upd(); }
}
function setSlider(rangeId, spanId, val) { const r = el(rangeId); if (r && val != null) { r.value = val; const sp = el(spanId); if (sp) sp.textContent = r.value; } }

async function loadImagePanel() {
  ["img-steps:img-steps-v", "img-cfg:img-cfg-v", "img-width:img-width-v", "img-height:img-height-v", "img-batch:img-batch-v"].forEach((p) => { const [r, s] = p.split(":"); wireSlider(r, s); });
  if (!window.api.imageStatus) return;
  try {
    const s = await window.api.imageStatus();
    if (!s) return;
    if (el("img-endpoint")) el("img-endpoint").value = s.endpoint || "";
    if (el("img-enabled")) el("img-enabled").checked = !!s.enabled;
    setSlider("img-steps", "img-steps-v", s.steps);
    setSlider("img-cfg", "img-cfg-v", s.cfgScale);
    setSlider("img-width", "img-width-v", s.width);
    setSlider("img-height", "img-height-v", s.height);
    setSlider("img-batch", "img-batch-v", s.batchCount);
    if (el("img-seed") && s.seed != null) el("img-seed").value = s.seed;
  } catch (_) {}
}
if (el("btn-img-seed-rand")) el("btn-img-seed-rand").onclick = () => { if (el("img-seed")) el("img-seed").value = "-1"; };
function imgMsg(t) { if (el("img-msg")) el("img-msg").textContent = t; }

// --- Generic 3-size panel state (minimal → middle → large) -------------------
// The ◱ button cycles a panel's data-size; CSS shows/hides .when-mid/.when-large.
// This is separate from the ⌄ tab-collapse (which hides the whole panel to a tab).
const PANEL_SIZES = ["minimal", "middle", "large"];
const SIZE_GLYPH = { minimal: "◱", middle: "◲", large: "◼" };
function setPanelSize(panelId, btnId, size) {
  const p = el(panelId); if (!p) return;
  if (!PANEL_SIZES.includes(size)) size = "minimal";
  p.setAttribute("data-size", size);
  const b = el(btnId);
  if (b) { const next = PANEL_SIZES[(PANEL_SIZES.indexOf(size) + 1) % PANEL_SIZES.length]; b.textContent = SIZE_GLYPH[size]; b.title = `Size: ${size} — click for ${next}`; }
  uiLog("panel", { msg: `${panelId} size → ${size}` });
}
function cyclePanelSize(panelId, btnId) {
  const cur = (el(panelId) && el(panelId).getAttribute("data-size")) || "minimal";
  setPanelSize(panelId, btnId, PANEL_SIZES[(PANEL_SIZES.indexOf(cur) + 1) % PANEL_SIZES.length]);
}
if (el("btn-img-size")) el("btn-img-size").onclick = () => cyclePanelSize("col-image", "btn-img-size");
if (el("btn-vid-size")) el("btn-vid-size").onclick = () => cyclePanelSize("col-video", "btn-vid-size");
if (el("btn-img-open-ui")) el("btn-img-open-ui").onclick = () => {
  const ep = (el("img-endpoint") && el("img-endpoint").value || "").trim() || "http://127.0.0.1:7860";
  let base = ep;
  try { const u = new URL(ep); base = `${u.protocol}//${u.host}`; } catch (_) { base = ep.replace(/\/sdapi.*$/, ""); }
  if (window.api.openExternal) window.api.openExternal(base);
};
if (el("btn-img-save")) el("btn-img-save").onclick = async () => {
  if (!window.api.configureImage) return;
  const r = await window.api.configureImage({ enabled: !!(el("img-enabled") && el("img-enabled").checked), endpoint: (el("img-endpoint") && el("img-endpoint").value || "").trim() });
  imgMsg(r && r.ok ? (r.enabled ? "Saved — image generation on." : "Saved — off.") : `Save failed: ${(r && r.error) || "error"}`);
};
const imgHistory = [];
function imgShowPreview(dataUrl, pathText) {
  if (!dataUrl || !el("img-preview")) return;
  el("img-preview").src = dataUrl;
  el("img-preview").style.display = "block";
  if (el("img-preview-empty")) el("img-preview-empty").style.display = "none";
  setPanelSize("col-image", "btn-img-size", "large"); // grow to show the render
  imgHistory.unshift({ dataUrl, pathText });
  imgHistory.length = Math.min(imgHistory.length, 8);
  const box = el("img-history");
  if (box) {
    box.innerHTML = "";
    for (const it of imgHistory) {
      const t = document.createElement("img");
      t.src = it.dataUrl; t.title = it.pathText || "";
      t.style.cssText = "width:44px;height:44px;object-fit:cover;border:1px solid #2a2a2a;border-radius:4px;cursor:pointer";
      t.onclick = () => imgShowPreview(it.dataUrl, it.pathText);
      box.appendChild(t);
    }
  }
}
if (el("btn-img-generate")) el("btn-img-generate").onclick = async () => {
  if (!window.api.imageGenerate) return;
  let prompt = (el("img-prompt") && el("img-prompt").value || "").trim();
  const lora = (el("img-lora") && el("img-lora").value || "").trim();
  if (lora) prompt = prompt ? `${prompt} ${lora}` : lora;
  const negative = (el("img-negative") && el("img-negative").value || "").trim();
  if (!prompt) { imgMsg("Type a prompt first."); return; }
  const cfg = { enabled: true, endpoint: (el("img-endpoint") && el("img-endpoint").value || "").trim() };
  const num = (id) => Number(el(id) && el(id).value);
  const w = num("img-width"), h = num("img-height"), st = num("img-steps"), cf = num("img-cfg"), bt = num("img-batch"), sd = num("img-seed");
  if (w) cfg.width = w; if (h) cfg.height = h; if (st) cfg.steps = st;
  if (cf) cfg.cfgScale = cf; if (bt) cfg.batchCount = bt; if (Number.isFinite(sd)) cfg.seed = sd;
  if (window.api.configureImage) await window.api.configureImage(cfg);
  imgMsg("Rendering…");
  const r = await window.api.imageGenerate(prompt, negative);
  if (r && r.ok) { imgMsg(`Rendered ✓ → ${r.path}`); imgShowPreview(r.preview, r.path); }
  else imgMsg(`Failed: ${(r && r.error) || "error"} (is your SD server running with --api?)`);
};
loadImagePanel();

// Video Generation panel — same shape as Image (3 sizes + tab), wired to a local
// text-to-video HTTP endpoint. minimal = prompt/negative; middle adds motion/LoRA
// + frames/fps/size; large adds the clip preview, recent strip, and connection.
async function loadVideoPanel() {
  ["vid-frames:vid-frames-v", "vid-fps:vid-fps-v", "vid-steps:vid-steps-v", "vid-cfg:vid-cfg-v", "vid-motion:vid-motion-v"].forEach((p) => { const [r, s] = p.split(":"); wireSlider(r, s); });
  if (!window.api.videoStatus) return;
  try {
    const s = await window.api.videoStatus();
    if (!s) return;
    if (el("vid-endpoint")) el("vid-endpoint").value = s.endpoint || "";
    if (el("vid-enabled")) el("vid-enabled").checked = !!s.enabled;
    if (el("vid-width") && s.width) el("vid-width").value = s.width;
    if (el("vid-height") && s.height) el("vid-height").value = s.height;
    if (el("vid-seed") && s.seed != null) el("vid-seed").value = s.seed;
    setSlider("vid-frames", "vid-frames-v", s.frames);
    setSlider("vid-fps", "vid-fps-v", s.fps);
    setSlider("vid-steps", "vid-steps-v", s.steps);
    setSlider("vid-cfg", "vid-cfg-v", s.cfgScale);
    setSlider("vid-motion", "vid-motion-v", s.motion);
  } catch (_) {}
}
if (el("btn-vid-seed-rand")) el("btn-vid-seed-rand").onclick = () => { if (el("vid-seed")) el("vid-seed").value = "-1"; };
function vidMsg(t) { if (el("vid-msg")) el("vid-msg").textContent = t; }
if (el("btn-vid-open-ui")) el("btn-vid-open-ui").onclick = () => {
  const ep = (el("vid-endpoint") && el("vid-endpoint").value || "").trim() || "http://127.0.0.1:7860";
  let base = ep;
  try { const u = new URL(ep); base = `${u.protocol}//${u.host}`; } catch (_) { base = ep.replace(/\/[^/]*$/, ""); }
  if (window.api.openExternal) window.api.openExternal(base);
};
if (el("btn-vid-save")) el("btn-vid-save").onclick = async () => {
  if (!window.api.configureVideo) return;
  const r = await window.api.configureVideo({ enabled: !!(el("vid-enabled") && el("vid-enabled").checked), endpoint: (el("vid-endpoint") && el("vid-endpoint").value || "").trim() });
  vidMsg(r && r.ok ? (r.enabled ? "Saved — video generation on." : "Saved — off.") : `Save failed: ${(r && r.error) || "error"}`);
};
const vidHistory = [];
function vidShowPreview(src, pathText) {
  if (!src || !el("vid-preview")) return;
  el("vid-preview").src = src;
  el("vid-preview").style.display = "block";
  if (el("vid-preview-empty")) el("vid-preview-empty").style.display = "none";
  setPanelSize("col-video", "btn-vid-size", "large");
  vidHistory.unshift({ src, pathText });
  vidHistory.length = Math.min(vidHistory.length, 8);
  const box = el("vid-history");
  if (box) {
    box.innerHTML = "";
    vidHistory.forEach((it, i) => {
      const chip = document.createElement("button");
      chip.textContent = `▶ clip ${vidHistory.length - i}`;
      chip.title = it.pathText || "";
      chip.style.cssText = "font-size:10.5px; padding:2px 6px;";
      chip.onclick = () => vidShowPreview(it.src, it.pathText);
      box.appendChild(chip);
    });
  }
}
if (el("btn-vid-generate")) el("btn-vid-generate").onclick = async () => {
  if (!window.api.videoGenerate) return;
  let prompt = (el("vid-prompt") && el("vid-prompt").value || "").trim();
  const lora = (el("vid-lora") && el("vid-lora").value || "").trim();
  if (lora) prompt = prompt ? `${prompt} ${lora}` : lora;
  const negative = (el("vid-negative") && el("vid-negative").value || "").trim();
  if (!prompt) { vidMsg("Type a prompt first."); return; }
  const cfg = { enabled: true, endpoint: (el("vid-endpoint") && el("vid-endpoint").value || "").trim() };
  const num = (id) => Number(el(id) && el(id).value);
  const w = num("vid-width"), h = num("vid-height"), fr = num("vid-frames"), fp = num("vid-fps"), st = num("vid-steps"), cf = num("vid-cfg"), mo = num("vid-motion"), sd = num("vid-seed");
  if (w) cfg.width = w; if (h) cfg.height = h; if (fr) cfg.frames = fr; if (fp) cfg.fps = fp;
  if (st) cfg.steps = st; if (cf) cfg.cfgScale = cf; if (Number.isFinite(mo)) cfg.motion = mo; if (Number.isFinite(sd)) cfg.seed = sd;
  if (window.api.configureVideo) await window.api.configureVideo(cfg);
  vidMsg("Rendering… (video can take a while)");
  const r = await window.api.videoGenerate(prompt, negative);
  if (r && r.ok) { vidMsg(`Rendered ✓ → ${r.path || r.url}`); vidShowPreview(r.preview, r.path || r.url); }
  else vidMsg(`Failed: ${(r && r.error) || "error"} — set a video endpoint in ⚙️ Connection, and make sure the backend is running.`);
};
loadVideoPanel();

// Endpoint helpers (shared by Image + Video) so the user never has to guess a URL:
// a preset dropdown, an auto-detect that scans localhost, and a reachability test.
async function loadEndpointPresets(kind, selectId, endpointId, msgId) {
  const sel = el(selectId);
  if (!sel || !window.api.endpointPresets) return;
  try {
    const r = await window.api.endpointPresets(kind);
    if (r && r.ok) for (const p of r.presets) { const o = document.createElement("option"); o.value = p.endpoint; o.textContent = p.label; sel.appendChild(o); }
  } catch (_) {}
  sel.onchange = () => { if (sel.value && el(endpointId)) { el(endpointId).value = sel.value; if (el(msgId)) el(msgId).textContent = "Filled in — press Save, then ✓ Test."; } };
}
async function detectEndpoint(kind, endpointId, selectId, msgId) {
  if (!window.api.detectEndpoints) return;
  if (el(msgId)) el(msgId).textContent = "Scanning localhost…";
  let r; try { r = await window.api.detectEndpoints(kind); } catch (_) { r = null; }
  const reach = (r && r.reachable) || [];
  if (!reach.length) { if (el(msgId)) el(msgId).textContent = "Nothing found running. Start your image/video app (with its API on), or pick one above."; return; }
  if (el(endpointId)) el(endpointId).value = reach[0].endpoint;
  if (el(selectId)) el(selectId).value = reach[0].endpoint;
  if (el(msgId)) el(msgId).textContent = `Found: ${reach[0].label} ✓ — press Save.${reach.length > 1 ? ` (+${reach.length - 1} more)` : ""}`;
}
async function testEndpointUi(endpointId, msgId) {
  if (!window.api.testEndpoint) return;
  const url = (el(endpointId) && el(endpointId).value || "").trim();
  if (!url) { if (el(msgId)) el(msgId).textContent = "Enter or pick an address first."; return; }
  if (el(msgId)) el(msgId).textContent = "Testing…";
  let r; try { r = await window.api.testEndpoint(url); } catch (_) { r = null; }
  if (el(msgId)) el(msgId).textContent = r && r.reachable ? "Reachable ✓ — the server answered." : "Not reachable — is the app running with its API enabled?";
}
loadEndpointPresets("image", "img-preset", "img-endpoint", "img-conn-msg");
if (el("btn-img-detect")) el("btn-img-detect").onclick = () => detectEndpoint("image", "img-endpoint", "img-preset", "img-conn-msg");
if (el("btn-img-test")) el("btn-img-test").onclick = () => testEndpointUi("img-endpoint", "img-conn-msg");
loadEndpointPresets("video", "vid-preset", "vid-endpoint", "vid-conn-msg");
if (el("btn-vid-detect")) el("btn-vid-detect").onclick = () => detectEndpoint("video", "vid-endpoint", "vid-preset", "vid-conn-msg");
if (el("btn-vid-test")) el("btn-vid-test").onclick = () => testEndpointUi("vid-endpoint", "vid-conn-msg");

// GPU Usage panel: poll "how much GPU are we using" and draw util + VRAM bars.
function gpuEsc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function gpuBarClass(p) { return p >= 85 ? "hot" : p >= 60 ? "warn" : ""; }
function renderGpu(info) {
  const box = el("gpu-body");
  if (!box) return;
  if (!info || !info.available) {
    box.innerHTML = `<div style="font-size:11.5px; opacity:.6;">GPU monitor unavailable${info && info.reason ? " — " + gpuEsc(info.reason) : ""}. (Needs an NVIDIA GPU with nvidia-smi.)</div>`;
    return;
  }
  box.innerHTML = (info.gpus || []).map((g) => {
    const util = g.util == null ? 0 : g.util;
    const memPct = g.memPct == null ? 0 : g.memPct;
    const mem = (g.memUsed != null && g.memTotal != null) ? `${(g.memUsed / 1024).toFixed(1)}/${(g.memTotal / 1024).toFixed(1)} GB` : "—";
    return `<div class="gpu-row"><div class="gpu-name">${gpuEsc(g.name)}</div>
      <div class="gpu-meter"><span class="lbl">GPU</span><span class="usage-bar ${gpuBarClass(util)}"><span style="width:${Math.max(0, Math.min(100, util))}%"></span></span><span class="val">${util}%</span></div>
      <div class="gpu-meter"><span class="lbl">VRAM</span><span class="usage-bar ${gpuBarClass(memPct)}"><span style="width:${Math.max(0, Math.min(100, memPct))}%"></span></span><span class="val">${mem}</span></div></div>`;
  }).join("");
}
async function pollGpu() {
  if (!window.api.gpuInfo) { renderGpu(null); return; }
  let info = null;
  try { info = await window.api.gpuInfo(); } catch (_) { info = null; }
  renderGpu(info);
}
pollGpu();
setInterval(pollGpu, 2500);

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
function lsiSetEnabled(on) {
  // The persistent System-AI settings API was removed; reflect the toggle
  // locally so the switch still responds.
  lsiReflect(on);
}
if (el("btn-ai-toggle")) el("btn-ai-toggle").onclick = () => lsiSetEnabled(!(el("lsi-enabled") && el("lsi-enabled").checked));
if (el("lsi-enabled")) el("lsi-enabled").onchange = () => lsiSetEnabled(el("lsi-enabled").checked);
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
if (el("btn-lsi-download")) el("btn-lsi-download").onclick = async () => {
  if (!window.api.ollamaPull) return;
  const model = el("lsi-download-model") ? el("lsi-download-model").value : "";
  if (!model) { logToCenter("Pick a model to download.", { tag: "models" }); return; }
  if (window.api.ollamaDetect) { const d = await window.api.ollamaDetect(); if (!d || !d.available) { logToCenter("Ollama isn't installed. Get it from ollama.com, then try again.", { tag: "models", err: true }); return; } }
  logToCenter(`⬇ Starting download of ${model}…`, { tag: "models" });
  const r = await window.api.ollamaPull(model);
  logToCenter(r && r.ok ? `✓ ${model} installed.` : `⚠ ${model}: ${(r && r.error) || "download failed"}`, { tag: "models", err: !(r && r.ok) });
  lsiRefreshModels();
};
if (window.api.onOllamaProgress) window.api.onOllamaProgress((p) => { if (p && p.line) logToCenter(p.line, { tag: "models" }); });
// Pull ANY model by name — your choice; the app doesn't decide which model for you.
if (el("btn-lsi-pull")) el("btn-lsi-pull").onclick = async () => {
  if (!window.api.ollamaPull) return;
  const model = (el("lsi-pull-name") && el("lsi-pull-name").value || "").trim();
  if (!model) { logToCenter("Type a model name (e.g. llama3.1:8b, mistral, qwen2.5:7b).", { tag: "models" }); return; }
  if (window.api.ollamaDetect) { const d = await window.api.ollamaDetect(); if (!d || !d.available) { logToCenter("Ollama isn't installed. Get it from ollama.com, then try again.", { tag: "models", err: true }); return; } }
  logToCenter(`⬇ Starting download of ${model}…`, { tag: "models" });
  const r = await window.api.ollamaPull(model);
  logToCenter(r && r.ok ? `✓ ${model} installed.` : `⚠ ${model}: ${(r && r.error) || "download failed"}`, { tag: "models", err: !(r && r.ok) });
  lsiRefreshModels();
};
// Populate the recommended-model picker (neutral, size-keyed suggestions).
async function lsiLoadRecommended() {
  const sel = el("lsi-download-model"); if (!sel || !window.api.ollamaRecommended) return;
  try {
    const uncensored = !!(el("lsi-uncensored") && el("lsi-uncensored").checked);
    const r = await window.api.ollamaRecommended({ vramGB: null, uncensored });
    const models = (r && r.models) || [];
    sel.innerHTML = "";
    for (const name of models) { const o = document.createElement("option"); o.value = name; o.textContent = name; sel.appendChild(o); }
    if (el("lsi-recommend") && models.length) el("lsi-recommend").textContent = uncensored
      ? "Uncensored models that still follow the butler's commands (Dolphin / Hermes) — or pull any other below."
      : "Suggested local models — or pull any other by name below.";
  } catch (_) {}
}
if (el("lsi-uncensored")) el("lsi-uncensored").onchange = () => { uiLog("click", { id: "lsi-uncensored", msg: el("lsi-uncensored").checked ? "prefer uncensored" : "default models" }); lsiLoadRecommended(); };
lsiLoadRecommended();
lsiRefreshModels();

// Models & assets folder: show where it is, what's in it, and open it.
async function loadModelsInfo() {
  if (!window.api.modelsInfo) return;
  try {
    const info = await window.api.modelsInfo();
    if (!info || !info.ok) return;
    // Show the one findable folder; note that downloads live in its models/ subfolder.
    if (el("models-path")) el("models-path").textContent = info.contentRoot || info.root || "(not ready)";
    if (el("models-inventory")) {
      const c = info.categories || {};
      el("models-inventory").textContent = "Installed: " + ["llm", "image", "loras", "video", "voice", "assets"].map((k) => `${k} ${c[k] || 0}`).join(" · ");
    }
    if (el("models-ollama")) {
      el("models-ollama").textContent = info.ollamaHere
        ? "✓ Ollama is pointed at this folder — pulls land here."
        : "Tip: set OLLAMA_MODELS to the llm/ folder so Ollama stores models here.";
    }
  } catch (_) {}
  await loadModelsStore();
}

// Language-model storage: is the app's own Ollama running (so downloads land in
// "stuff and thing"), and where do already-downloaded models currently live?
async function loadModelsStore() {
  const box = el("models-store-status");
  if (!box || !window.api.ollamaManagedStatus) return;
  try {
    const st = await window.api.ollamaManagedStatus();
    if (st && st.running) {
      box.innerHTML = `<span style="color:#8ef0b0;">✓ New downloads are stored in this folder</span> — the app runs its own Ollama at <code>${gpuEsc(st.endpoint || "")}</code>.` +
        (st.defaultStore ? `<br><span style="opacity:.75;">Models downloaded earlier may still be in <code>${gpuEsc(st.defaultStore)}</code> — use “Move downloaded models here”.</span>` : "");
    } else {
      box.innerHTML = `<span style="opacity:.8;">The app's own Ollama isn't running (Ollama may not be installed yet). New downloads go to Ollama's default store` +
        (st && st.defaultStore ? ` <code>${gpuEsc(st.defaultStore)}</code>` : "") + `. Install Ollama, then reopen the app to store here.</span>`;
    }
  } catch (_) {}
}
if (el("btn-open-models")) el("btn-open-models").onclick = () => { if (window.api.openModelsFolder) window.api.openModelsFolder(); };
// Move models already downloaded (Ollama's default store) into "stuff and thing".
if (el("btn-ollama-migrate")) el("btn-ollama-migrate").onclick = async () => {
  if (!window.api.ollamaMigrate) { logToCenter("Migration unavailable.", { tag: "models", err: true }); return; }
  const btn = el("btn-ollama-migrate");
  btn.disabled = true; logToCenter("📦 Moving downloaded models here…", { tag: "models" });
  let r; try { r = await window.api.ollamaMigrate(); } catch (e) { r = { ok: false, error: String(e) }; }
  logToCenter(r && r.ok
    ? `✓ Models moved: ${r.moved} moved, ${r.skipped} already there${r.note ? " — " + r.note : ""}.`
    : `⚠ Move failed: ${(r && r.error) || "error"}`, { tag: "models", err: !(r && r.ok) });
  btn.disabled = false;
  loadModelsInfo();
};
// Download all logs: gather every log the program writes into one folder + open it.
if (el("btn-download-logs")) el("btn-download-logs").onclick = async () => {
  if (!window.api.downloadAllLogs) { logToCenter("Log download unavailable.", { tag: "files", err: true }); return; }
  const btn = el("btn-download-logs");
  btn.disabled = true; logToCenter("📥 Gathering every log into one folder…", { tag: "files" });
  let r; try { r = await window.api.downloadAllLogs(); } catch (e) { r = { ok: false, error: String(e) }; }
  logToCenter(r && r.ok
    ? `✓ ${r.count} file(s) bundled and opened: ${r.folder}`
    : `⚠ Log bundle failed: ${(r && r.error) || "error"}`, { tag: "files", err: !(r && r.ok) });
  btn.disabled = false;
};
loadModelsInfo();

// --- Safeguards: approval mode + approve/reject a held action ------------------
if (el("lsi-approval")) el("lsi-approval").onchange = async () => {
  if (!window.api.configureManagerProvider) return;
  const on = !!el("lsi-approval").checked;
  const r = await window.api.configureManagerProvider({ approvalMode: on });
  if (el("lsi-approval-msg")) el("lsi-approval-msg").textContent = r && r.ok ? (on ? "On — the butler will pause for your OK before acting." : "Off — the butler acts on its own (risk-“ask” tools still pause).") : `Couldn't save: ${(r && r.error) || "error"}`;
};
// The local LLM endpoint starts pre-filled with Ollama's fixed local address
// (Ollama always runs on 127.0.0.1:11434, so nobody should have to type it). It
// is fully erasable, and a real saved endpoint takes over.
const DEFAULT_LLM_ENDPOINT = "http://127.0.0.1:11434/v1/chat/completions";
(async () => {
  // Prefer the app's own Ollama (whose store is "stuff and thing") when it's up,
  // so the butler and its downloads use the same server. Falls back to the
  // standard local Ollama address otherwise. A saved endpoint still wins below.
  let defaultEp = DEFAULT_LLM_ENDPOINT;
  try {
    if (window.api.ollamaManagedStatus) {
      const st = await window.api.ollamaManagedStatus();
      if (st && st.running && st.endpoint) defaultEp = `${st.endpoint}/v1/chat/completions`;
    }
  } catch (_) {}
  if (el("lsi-endpoint") && !el("lsi-endpoint").value) el("lsi-endpoint").value = defaultEp;
  if (!window.api.getManagerState) return;
  try {
    const s = await window.api.getManagerState();
    if (s && s.managerConfig) {
      if (el("lsi-approval")) el("lsi-approval").checked = !!s.managerConfig.approvalMode;
      const savedEp = String(s.managerConfig.endpoint || "").trim();
      if (savedEp && el("lsi-endpoint")) el("lsi-endpoint").value = savedEp; // a saved endpoint wins over the default
      if (s.managerConfig.model && el("lsi-model")) {
        const sel = el("lsi-model");
        if (![...sel.options].some((o) => o.value === s.managerConfig.model)) { const o = document.createElement("option"); o.value = s.managerConfig.model; o.textContent = s.managerConfig.model; sel.appendChild(o); }
        sel.value = s.managerConfig.model;
      }
    }
  } catch (_) {}
})();
if (el("btn-approve")) el("btn-approve").onclick = async () => { if (window.api.approveManagerAction) await window.api.approveManagerAction(); };
if (el("btn-reject")) el("btn-reject").onclick = async () => { if (window.api.rejectManagerAction) await window.api.rejectManagerAction("operator rejected"); };
function renderPendingApproval(m) {
  const box = el("lsi-pending"); if (!box) return;
  const p = m && m.pendingApproval;
  if (p) {
    box.style.display = "";
    const detail = p.action === "USE_TOOL" ? `${p.action}: ${p.tool}` : (p.action === "GENERATE_IMAGE" ? `${p.action}: "${(p.prompt || "").slice(0, 40)}"` : (p.assignments ? `${p.action} → ${p.assignments.map((a) => a.target).join(", ")}` : p.action));
    if (el("lsi-pending-text")) el("lsi-pending-text").textContent = `⏸ Waiting for your OK: ${detail}`;
  } else {
    box.style.display = "none";
  }
}

// --- System AI / Butler (the supervisor) --------------------------------------
// Save the endpoint + model as the supervisor's provider config, then the butler
// (manager) can be started with a goal. All of this drives existing IPC.
function _managerConfigFromUI() {
  return { provider: "openai-compatible", endpoint: (el("lsi-endpoint") && el("lsi-endpoint").value || "").trim(), model: (el("lsi-model") && el("lsi-model").value) || "" };
}
// Turn cryptic error codes into a plain next step, so it's clear what to do.
function lsiFriendly(err) {
  switch (err) {
    case "NOT_CONFIGURED": return "Pick a model above (download one if the list is empty), then press “Save settings” — after that, Test.";
    case "BAD_ENDPOINT": return "That endpoint doesn't look like a URL. Use e.g. http://127.0.0.1:11434/v1/chat/completions.";
    case "TIMEOUT": return "No response — is your local model server (Ollama/LM Studio) actually running?";
    case "unreachable": return "Couldn't reach that address — start your local model server, then Test again.";
    default: return err ? `couldn't connect (${err}) — is the model server running?` : "couldn't connect.";
  }
}
if (el("btn-lsi-save")) el("btn-lsi-save").onclick = async () => {
  if (!window.api.configureManagerProvider) return;
  const cfg = _managerConfigFromUI();
  if (!cfg.model) { if (el("lsi-msg")) el("lsi-msg").textContent = "Pick a model first (choose one, or download one above), then Save."; return; }
  const r = await window.api.configureManagerProvider(cfg);
  if (el("lsi-msg")) el("lsi-msg").textContent = r && r.ok ? "✓ Saved. Now press “Test” to check the connection, or type a goal for the Butler below." : `Save failed: ${lsiFriendly(r && r.error)}`;
};
if (el("btn-lsi-test")) el("btn-lsi-test").onclick = async () => {
  if (!window.api.testManagerConnection) return;
  if (el("lsi-msg")) el("lsi-msg").textContent = "Testing connection…";
  if (window.api.configureManagerProvider) await window.api.configureManagerProvider(_managerConfigFromUI());
  const r = await window.api.testManagerConnection();
  if (el("lsi-msg")) el("lsi-msg").textContent = r && r.ok ? "✓ Connection OK — the Butler is ready." : `Test failed: ${lsiFriendly(r && r.error)}`;
};

function jarvisSetStatus(t) { if (el("jarvis-status")) el("jarvis-status").textContent = t; }
function jarvisShowRunning(on) {
  if (el("btn-jarvis-stop")) el("btn-jarvis-stop").style.display = on ? "" : "none";
  if (el("btn-jarvis-start")) el("btn-jarvis-start").disabled = !!on;
}
// The Butler status light in the User Panel: glows while he's working, shows a
// one-line "what he's doing", and jumps to his panel on click.
function setButlerLight(cls, text) {
  const b = el("btn-butler-status"); if (!b) return;
  b.classList.remove("working", "needs", "error");
  if (cls) b.classList.add(cls);
  const t = b.querySelector(".txt"); if (t && text != null) t.textContent = text;
}
if (el("btn-butler-status")) el("btn-butler-status").onclick = () => {
  uiLog("click", { id: "btn-butler-status", msg: "open butler" });
  const panel = el("col-systemai");
  if (panel) { panel.classList.remove("hidden-collapsed"); panel.scrollIntoView({ behavior: "smooth", block: "start" }); }
  const goal = el("jarvis-goal"); if (goal) try { goal.focus(); } catch (_) {}
};
if (el("btn-jarvis-start")) el("btn-jarvis-start").onclick = async () => {
  if (!window.api.startManagedTask) return;
  const goal = (el("jarvis-goal") && el("jarvis-goal").value || "").trim();
  if (!goal) { jarvisSetStatus("Type a goal first."); return; }
  if (el("jarvis-ack")) el("jarvis-ack").textContent = "";
  jarvisSetStatus(butlerMode === "converse" ? "Asking…" : "Starting…");
  const r = await butlerHandle(goal, { mirror: false }); // honours the mode toggle
  if (r && r.converse) { jarvisSetStatus("Chatting."); return; }
  if (r && r.ok) { jarvisShowRunning(true); jarvisSetStatus("Started."); }
  else {
    const hint = r && r.error === "NOT_CONFIGURED" ? " — set an endpoint + model above and press Save." : "";
    jarvisSetStatus(`Can't start: ${(r && r.error) || "error"}${hint}`);
  }
};
if (el("btn-jarvis-stop")) el("btn-jarvis-stop").onclick = async () => {
  if (window.api.stopManagedTask) await window.api.stopManagedTask();
  jarvisShowRunning(false); jarvisSetStatus("Stopped.");
};
if (window.api.onManagerAck) window.api.onManagerAck((a) => {
  if (!a || !a.text) return;
  if (el("jarvis-ack")) el("jarvis-ack").textContent = "🤵 " + a.text;
  // A stall-break question is the butler asking ME for input — flag it amber.
  if (/\?\s*$/.test(a.text) || /would you like|tell me|need (more|the)|waiting on/i.test(a.text)) setButlerLight("needs", "Butler needs you");
});
function renderAwareness(a) {
  const box = el("jarvis-awareness"); if (!box) return;
  if (!a || !a.panes) { box.textContent = ""; return; }
  const parts = Object.keys(a.panes).map((site) => {
    const p = a.panes[site];
    const mark = !p.enabled ? "○" : p.available ? "🟢" : (p.rateLimited ? "⛔" : (p.busy ? "⏳" : "🟡"));
    return `${mark} ${site}`;
  });
  box.textContent = "Awareness: " + parts.join("  ");
}
if (window.api.onManagerState) window.api.onManagerState((m) => {
  if (!m) return;
  const running = m.status && !["idle", "finished", "error"].includes(m.status);
  jarvisShowRunning(running);
  const bits = [`Status: ${m.status || "idle"}`];
  if (m.turnNumber) bits.push(`turn ${m.turnNumber}/${m.maximumTurns}`);
  if (m.codeRuns && m.codeRuns.length) bits.push(`${m.codeRuns.length} code run(s)`);
  if (m.toolCalls && m.toolCalls.length) bits.push(`${m.toolCalls.length} tool call(s)`);
  if (m.memories && m.memories.length) bits.push(`${m.memories.length} memory item(s)`);
  jarvisSetStatus(bits.join(" · "));
  // Drive the User Panel status light.
  if (running) setButlerLight("working", `Butler: ${m.status}${m.turnNumber ? " · turn " + m.turnNumber : ""}`);
  else if (m.status === "error") setButlerLight("error", "Butler stopped");
  else setButlerLight("", m.status === "finished" ? "Butler done — idle" : "Butler idle");
  renderAwareness(m.awareness);
  renderPendingApproval(m);
});
// The butler chat/activity window, colour-coded by WHO is speaking:
//   • system  — muted grey (infra/config)
//   • butler  — his own reasoning/actions/status
//   • chatgpt/claude/gemini — each AI in its own colour (incl. AI↔AI)
//   • to-ME   — anything addressed to me (an AI's reply, or the butler asking me
//               something): its own bright colour AND 2× the size.
function appendButlerLine({ cls, who, text }) {
  const box = el("jarvis-log"); if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const row = document.createElement("div");
  row.className = "bl-line " + (cls || "bl-butler");
  const whoHtml = who ? `<span class="bl-who">${gpuEsc(who)}:</span> ` : "";
  row.innerHTML = `${whoHtml}${gpuEsc(String(text == null ? "" : text).slice(0, 500))}`;
  box.appendChild(row);
  while (box.children.length > 140) box.removeChild(box.firstChild);
  if (nearBottom) box.scrollTop = box.scrollHeight; // keep the latest in view (chat feel)
}
// Categories that are really the app/infra talking, not the butler himself.
const BUTLER_SYSTEM_CATEGORIES = new Set(["config", "error"]);
if (window.api.onManagerLog) window.api.onManagerLog((e) => {
  if (!e) return;
  const targetSite = Array.isArray(e.target) && e.target.length === 1 && SITE_LABELS[e.target[0]] ? e.target[0] : null;
  if (e.category === "response" && targetSite) {
    // An AI answered the butler — colour it as that AI.
    appendButlerLine({ cls: "bl-" + targetSite, who: SITE_LABELS[targetSite], text: e.summary });
  } else if (e.category === "response") {
    // The butler delivering to ME (e.g. the stall-break question) — to-me, 2×.
    appendButlerLine({ cls: "bl-tome", who: "🤵 Butler → You", text: e.summary });
  } else if (BUTLER_SYSTEM_CATEGORIES.has(e.category)) {
    appendButlerLine({ cls: "bl-system", who: "System", text: `${e.category}: ${e.summary || ""}` });
  } else {
    appendButlerLine({ cls: "bl-butler", who: "🤵 Butler", text: e.summary });
  }
});

// N5 Tools: show the registry so the user sees what the butler can call.
async function refreshToolsList() {
  const box = el("jarvis-tools"); if (!box || !window.api.toolsList) return;
  try {
    const r = await window.api.toolsList();
    const tools = (r && r.tools) || [];
    box.textContent = tools.length
      ? tools.map((t) => `• ${t.name}${t.risk === "ask" ? " (asks first)" : ""} — ${t.description}`).join("\n")
      : "No tools loaded.";
    box.style.whiteSpace = "pre-wrap";
  } catch { /* leave default */ }
}
refreshToolsList();

// N3 Memory: a summary line for the panel.
async function refreshMemoryLine() {
  const box = el("jarvis-memory"); if (!box || !window.api.memorySummary) return;
  try {
    const r = await window.api.memorySummary();
    if (r && r.available) box.textContent = `Memory: ${r.total || 0} item(s) stored`;
    else box.textContent = "Memory: off (SQLite unavailable)";
  } catch { /* leave blank */ }
}
refreshMemoryLine();

// N2 Voice: save/test config + push-to-talk + a distinct voice per speaker.
const VOICE_WHO = ["butler", "chatgpt", "claude", "gemini"];
function _voiceConfigFromUI() {
  const voices = {};
  for (const who of VOICE_WHO) voices[who] = (el(`voice-v-${who}`) && el(`voice-v-${who}`).value || "").trim();
  return {
    enabled: !!(el("voice-enabled") && el("voice-enabled").checked),
    speakOnAck: !!(el("voice-enabled") && el("voice-enabled").checked),
    endpoint: (el("voice-endpoint") && el("voice-endpoint").value || "").trim(),
    voices,
    micDevice: (el("voice-mic") && el("voice-mic").value) || "",
    speakerDevice: (el("voice-speaker") && el("voice-speaker").value) || "",
  };
}
function voiceMsg(t) { if (el("voice-msg")) el("voice-msg").textContent = t; }
// Load saved voice config into the fields, and enumerate the machine's mics/speakers.
async function loadVoicePanel() {
  if (window.api.voiceStatus) {
    try {
      const s = await window.api.voiceStatus();
      if (s) {
        if (el("voice-endpoint")) el("voice-endpoint").value = s.endpoint || "";
        if (el("voice-enabled")) el("voice-enabled").checked = !!s.enabled;
        for (const who of VOICE_WHO) if (el(`voice-v-${who}`) && s.voices) el(`voice-v-${who}`).value = s.voices[who] || "";
      }
    } catch (_) {}
  }
  // Populate the mic + speaker dropdowns from the real audio devices on this PC.
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const fill = (selId, kind) => {
        const sel = el(selId); if (!sel) return;
        for (const d of devs.filter((x) => x.kind === kind)) { const o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || `${kind} ${sel.length}`; sel.appendChild(o); }
      };
      fill("voice-mic", "audioinput");
      fill("voice-speaker", "audiooutput");
    }
  } catch (_) {}
}
loadVoicePanel();
// ▶ try-buttons: hear each speaker's assigned voice.
for (const who of VOICE_WHO) {
  const b = el(`btn-voice-try-${who}`);
  if (b) b.onclick = async () => {
    if (!window.api.configureVoice || !window.api.voiceSpeak) return;
    await window.api.configureVoice(_voiceConfigFromUI());
    voiceMsg(`Speaking as ${who}…`);
    const r = await window.api.voiceSpeak(`This is the ${who} voice.`, who);
    voiceMsg(r && r.ok ? `Spoke as ${who} ✓` : `Voice test failed: ${(r && r.error) || "error"}`);
  };
}
if (el("btn-voice-save")) el("btn-voice-save").onclick = async () => {
  if (!window.api.configureVoice) return;
  const r = await window.api.configureVoice(_voiceConfigFromUI());
  voiceMsg(r && r.ok ? (r.enabled ? "Saved — voice on." : "Saved — voice off.") : `Save failed: ${(r && r.error) || "error"}`);
};
if (el("btn-voice-test")) el("btn-voice-test").onclick = async () => {
  if (!window.api.configureVoice || !window.api.voiceSpeak) return;
  await window.api.configureVoice(_voiceConfigFromUI());
  voiceMsg("Speaking a test line…");
  const r = await window.api.voiceSpeak("AutoInjector voice is working.");
  voiceMsg(r && r.ok ? "Spoke a test line ✓" : `Voice test failed: ${(r && r.error) || "error"}`);
};
if (el("btn-mic")) el("btn-mic").onclick = async () => {
  if (!window.api.voiceListen) return;
  voiceMsg("Listening…");
  const r = await window.api.voiceListen({});
  if (r && r.ok && r.text) {
    if (el("jarvis-goal")) el("jarvis-goal").value = r.text;
    voiceMsg(`Heard: "${String(r.text).slice(0, 60)}" — press Start Butler.`);
  } else {
    voiceMsg(`Couldn't hear you: ${(r && r.error) || "error"}`);
  }
};

// User Panel: 🧙 Setup -> open the Setup Wizard window (downloads run in bg).
if (el("btn-open-wizard")) el("btn-open-wizard").onclick = () => { if (window.api.openWizard) window.api.openWizard(); };
// Image / Video paddles: open the Setup Wizard straight to their own tab.
if (el("btn-open-image")) el("btn-open-image").onclick = () => { if (window.api.openWizard) window.api.openWizard("images"); };
if (el("btn-open-video")) el("btn-open-video").onclick = () => { if (window.api.openWizard) window.api.openWizard("video"); };

// Open the consolidated AI feed window.
if (el("btn-open-feed")) el("btn-open-feed").onclick = () => { if (window.api.openFeed) window.api.openFeed(); };

// --- Phone companion: a minimal page served by the local bridge that a phone on
// the same Wi-Fi can open to watch the messages and send. The PC does the work.
async function refreshPhonePanel() {
  if (!window.api || !window.api.phoneInfo) return;
  let info = {};
  try { info = await window.api.phoneInfo(); } catch (_) {}
  const toggle = el("phone-lan-toggle");
  const urlEl = el("phone-url");
  const copyBtn = el("btn-phone-copy");
  if (toggle) toggle.checked = !!info.lanEnabled;
  if (urlEl) {
    if (info.lanEnabled && info.url) urlEl.value = info.url;
    else if (!info.lanEnabled) urlEl.value = "";
    urlEl.placeholder = info.lanEnabled ? (info.lanIp ? "" : "No Wi-Fi address found — connect to a network") : "Enable LAN access to get a link";
  }
  if (copyBtn) copyBtn.disabled = !(info.lanEnabled && info.url);
}
if (el("btn-open-phone")) el("btn-open-phone").onclick = async () => {
  const panel = el("phone-panel");
  if (!panel) return;
  panel.hidden = !panel.hidden;
  if (!panel.hidden) await refreshPhonePanel();
};
if (el("phone-lan-toggle")) el("phone-lan-toggle").onchange = async (e) => {
  const on = !!e.target.checked;
  const hint = el("phone-hint");
  if (hint) hint.textContent = on ? "Starting network access…" : "LAN access off — phone can't connect.";
  try { if (window.api.phoneSetLan) await window.api.phoneSetLan(on); } catch (_) {}
  await refreshPhonePanel();
  if (hint) hint.textContent = on
    ? "Open the link below on your phone (same Wi-Fi). The PC does all the work — the phone just shows messages and lets you send."
    : "LAN access off — phone can't connect.";
};
if (el("btn-phone-copy")) el("btn-phone-copy").onclick = async () => {
  const urlEl = el("phone-url");
  if (!urlEl || !urlEl.value) return;
  try { await navigator.clipboard.writeText(urlEl.value); } catch (_) { try { urlEl.select(); document.execCommand("copy"); } catch (_) {} }
  const b = el("btn-phone-copy"); if (b) { const t = b.textContent; b.textContent = "✓ Copied"; setTimeout(() => { b.textContent = t; }, 1400); }
};

// User Panel: 🆕 Start New Chat -> fresh session in all three AI panes at once.
if (el("btn-new-chat-all")) el("btn-new-chat-all").onclick = async () => {
  if (!window.api.startNewChatAll) return;
  setStatus("Starting a new chat in all three AIs…");
  const r = await window.api.startNewChatAll();
  const started = r && r.results ? Object.entries(r.results).filter(([, ok]) => ok).map(([s]) => SITE_LABELS[s] || s) : [];
  setStatus(started.length ? `New chat started in: ${started.join(", ")}.` : "Couldn't start a new chat — are the panes loaded?");
  setTimeout(refreshSites, 1500);
};

el("btn-open-sequence").onclick = () => window.api.openSequenceEditor();

el("btn-main-row-collapse").onclick = () => {
  const collapsed = el("main-row").classList.toggle("collapsed");
  el("btn-main-row-collapse").textContent = collapsed ? "›" : "⌄";
  el("btn-main-row-collapse").title = collapsed ? "Expand the Transcript/Log panel" : "Collapse the Transcript/Log panel";
};

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
// The big "stop them talking to each other" button — halts every relay path at
// once (Auto, House Rules, Sequence, Butler) but keeps your participants checked.
if (el("btn-silence")) el("btn-silence").onclick = async () => {
  if (!window.api.silenceAll) return;
  const res = await window.api.silenceAll();
  if (res?.ok) { applyGlobal(res.global); setStatus("🛑 Stopped — the AIs are no longer messaging each other."); }
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

// --- BookForge panel ----------------------------------------------------------
// Loopback HTTP bridge that lets BookForge drive these panes (main.js +
// bookforge-bridge.js; contract v1.1 in docs/BOOKFORGE_AUTOINJECTOR_BRIDGE.md).
// Three cards, top to bottom:
//   1. "Your AI & connection" — bridge on/off, the one-click 🔗 Connect BookForge
//      (pairing code, the key never goes into a URL), each AI's readiness, and the
//      connection check: ONE list of steps that live status ticks and that
//      🧪 Test the connection (the real link test) re-checks row by row.
//   2. "Now working on" — BookForge's current sub-module step and anything that
//      needs the user's approval (from BookForge's POST /v1/status).
//   3. "Book checklist" — the big picture: what's done, k of n.
// The activity log stays available, folded away. The key is copied by the main
// process; it only reaches this page when the user explicitly clicks "Show".
if (el("btn-collapse-bookforge")) el("btn-collapse-bookforge").onclick = () => collapseYellowPanel("bookforge");
const BF_SITES = ["chatgpt", "claude", "gemini"];
const BF_LABEL = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };
const BF_STALE_MS = 90000;
const bfStore = {
  get(k) { try { return window.localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { if (v == null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch (_) {} }
};
const bf = { snap: null, at: 0, starting: false, connecting: false, startingApp: false, localMsg: null,
  test: { running: false, results: new Map(), report: null } };
function bfLabel(site, s) { return (s && s.sites && s.sites[site] && s.sites[site].label) || BF_LABEL[site] || site; }
function bfClock(ms) { const t = Math.max(0, Math.round((ms || 0) / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; }
function bfDur(ms) { const t = Math.max(0, Math.round((ms || 0) / 1000)); return t < 60 ? `${t}s` : bfClock(ms); }
// "now" on the main process's clock, so ages/elapsed are right even if the snapshot is a few seconds old.
function bfNow() { const s = bf.snap; return s && s.now ? s.now + (Date.now() - bf.at) : Date.now(); }
function bfAgo(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((bfNow() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}
function bfTime(ts) { try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch (_) { return ""; } }
function bfMsg(text, tone) { const m = el("bf-msg"); if (m) { m.textContent = text || ""; if (tone) m.dataset.tone = tone; else delete m.dataset.tone; } }
function bfShow(id, on) { const n = el(id); if (n) n.hidden = !on; }
function bfText(id, t) { const n = el(id); if (n && n.textContent !== t) n.textContent = t; }

// Plain-English explanations behind every ⓘ.
const BF_INFO = {
  what: ["Your AI & connection", [
    "BookForge is the book-writing app on this computer. This panel lets BookForge hand questions to ChatGPT, Claude or Gemini in the windows of this app and get the answers back — using your normal logins, so there are no API keys and no extra bills.",
    "🔗 Connect BookForge does everything in one click: it turns the bridge on, checks BookForge is running, opens BookForge in your browser and hands it the connection key privately. You don't copy or paste anything.",
    "It only works on this computer (nothing on the internet can reach it), and only while the bridge is on."]],
  key: ["What is the connection key?", [
    "It's like a password that lets only your BookForge talk to this app. Connect BookForge hands it over for you, so normally you never see it.",
    "It never leaves your computer and is never shown in logs or reports, and it is never put in a web address. If anything tries to connect without it, it's refused — you'll see that in the Activity log."]],
  buttons: ["Copy, Show, and Make a new key", [
    "📋 Copy connection key — puts the key on your clipboard. Then in BookForge open Settings → Connect AutoInjector and paste it (Ctrl+V).",
    "Show key — shows the key on screen, in case you'd rather type it. Click Hide key when you're done.",
    "Make a new key — throws the old key away and makes a new one. BookForge is disconnected until it gets the new key (press Connect BookForge again). Only do this if you think someone else has seen your key."]],
  ais: ["What do the AI statuses mean?", [
    "Ready — the window is loaded; BookForge can use it.",
    "Not loaded — the window is missing or still loading. Open it, log in, and wait until the page has finished loading.",
    "Busy with BookForge — it's answering a BookForge question right now. Leave that window alone until it finishes.",
    "Not active — tick that AI as Active in this app if you want BookForge to use it.",
    "Below each status you see the result of its last request and when it happened."]],
  test: ["The connection check", [
    "Each line is one thing that has to work for BookForge to use your AIs. The ticks update by themselves as things change.",
    "🧪 Test the connection checks every line for real, the same way BookForge works: the bridge, the key (a wrong key must be refused), each AI window, a tiny test question to each Active AI (it must answer with a small JSON reply), whether BookForge is running and whether it is connected.",
    "A failed line says how to fix it. A report is saved in the logs folder (📄 Open last report) — it never contains your key or the question text.",
    "Heads-up: the test really types a short test message into each Active AI's chat. It can take a minute or two; you can stop it any time."]],
  now: ["Now working on", [
    "What BookForge is doing right now: the step of your book it's on (for example “Set B · B03 Main plot”), whether it's working or waiting for you, and a short note in plain words.",
    "If something needs your OK — like a draft to approve — it shows here with a ✅ Review & approve button that opens the right page in BookForge.",
    "BookForge sends this update by itself every few seconds while it's connected. If updates stop, a grey note says when the last one came."]],
  book: ["Book checklist", [
    "The big picture of your book: every part BookForge works through, which ones are done, which one is going on now and which ones are waiting for you.",
    "The bar shows how many parts are done out of the total. 📚 Open BookForge takes you to the book in your browser."]],
  activity: ["Activity log", [
    "A live diary of what happened between BookForge and this app, newest first — when BookForge connected, which AI it asked, how long the answer took, time-outs and refused connections.",
    "It never shows what was asked or answered, and never shows your connection key."]],
  tos: ["Is this allowed?", [
    "This app works by typing into the ChatGPT, Claude and Gemini websites for you. Those websites' terms of service may not allow automated use, and an account could be limited if they object.",
    "That's why the bridge is off until you turn it on (Connect BookForge turns it on for you). Use it at your own risk, at a gentle pace."]],
  routing: ["Why keep routing / autopilot off?", [
    "While BookForge is using an AI, the answer must go straight back to BookForge. If routing, autopilot, House Rules or a Prompt Sequence is also running, other messages can land in the same chat window at the same time and mix up the answers.",
    "The bridge never forwards BookForge's answers to the other AIs — but it can't stop other features typing into that window. So turn those off while BookForge works."]]
};
function bfOpenInfo(btn) {
  const pop = el("bf-pop");
  const panel = el("col-bookforge");
  if (!pop || !panel || !btn) return;
  const info = BF_INFO[btn.dataset.info];
  if (!info) return;
  const wasOpen = !pop.hidden && pop._owner === btn;
  bfCloseInfo(false);
  if (wasOpen) return;
  el("bf-pop-title").textContent = info[0];
  const body = el("bf-pop-body");
  body.textContent = "";
  for (const para of info[1]) { const p = document.createElement("p"); p.textContent = para; body.appendChild(p); }
  pop.hidden = false;
  pop._owner = btn;
  btn.setAttribute("aria-expanded", "true");
  // Place it under the ⓘ, kept inside the panel.
  try {
    const pr = panel.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const w = pop.offsetWidth || 340;
    let left = br.left - pr.left - 8;
    left = Math.max(8, Math.min(left, pr.width - w - 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${br.bottom - pr.top + 6}px`;
  } catch (_) {}
  try { pop.focus(); } catch (_) {}
}
function bfCloseInfo(returnFocus) {
  const pop = el("bf-pop");
  if (!pop || pop.hidden) return;
  const owner = pop._owner;
  pop.hidden = true;
  pop._owner = null;
  if (owner) { owner.setAttribute("aria-expanded", "false"); if (returnFocus) { try { owner.focus(); } catch (_) {} } }
}
if (el("col-bookforge")) {
  el("col-bookforge").addEventListener("click", (e) => {
    const b = e.target && e.target.closest && e.target.closest(".bf-info");
    if (b) { e.preventDefault(); e.stopPropagation(); bfOpenInfo(b); } // preventDefault: an ⓘ inside a <summary> must not fold it
  });
  const closeBtn = el("bf-pop") && el("bf-pop").querySelector(".bf-pop-close");
  if (closeBtn) closeBtn.onclick = () => bfCloseInfo(true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && el("bf-pop") && !el("bf-pop").hidden) { e.preventDefault(); bfCloseInfo(true); } });
  document.addEventListener("click", (e) => {
    const pop = el("bf-pop");
    if (!pop || pop.hidden) return;
    if (pop.contains(e.target) || (e.target.closest && e.target.closest(".bf-info"))) return;
    bfCloseInfo(false);
  });
}

// --- derive "where it's at" from a status snapshot ---------------------------
function bfErrorText(err, port) {
  if (err === "EADDRINUSE") return { title: `Couldn't start — port ${port} is already in use`, sub: "Another program (often a second copy of AutoInjector) is already using the bridge's address.", next: `Close the other program using port ${port} (often a second AutoInjector window), then press Connect BookForge again.` };
  if (err === "EACCES") return { title: `Couldn't start — this computer blocked port ${port}`, sub: "Your system refused to let the bridge open its address.", next: "Restart AutoInjector and try again. If it keeps happening, ask for help choosing another port (AUTOINJECTOR_BOOKFORGE_PORT)." };
  if (err === "TOKEN_WRITE_FAILED") return { title: "Couldn't save the connection key", sub: "The app couldn't write the key file in its settings folder.", next: "Make sure your disk isn't full, then press Connect BookForge again." };
  return { title: "The bridge couldn't start", sub: `Error: ${err || "unknown"}.`, next: "Press Connect BookForge again. If it keeps failing, restart AutoInjector and check the Activity Log for “bookforge-error”." };
}
function bfIsConnected(s) {
  if (s.connection) return !!s.connection.connected;
  // older main.js without a "connection" block
  const act = Array.isArray(s.activity) ? s.activity : [];
  const keyChanged = act.some((a) => a.kind === "key_changed" && a.at > (s.lastExternalContactAt || 0));
  return !!(s.enabled && s.listening && s.lastExternalContactAt) && !keyChanged;
}
function bfDerive(s) {
  const port = s.port || 17891;
  const act = Array.isArray(s.activity) ? s.activity : [];
  const badKey = act.some((a) => a.kind === "unauthorized" && !a.selftest && a.at > (s.lastExternalContactAt || 0));
  const connected = bfIsConnected(s);
  const activeSites = BF_SITES.filter((k) => s.sites && s.sites[k] && s.sites[k].active);
  const notReady = activeSites.filter((k) => !s.sites[k].ready);
  const working = BF_SITES.map((k) => [k, s.sites && s.sites[k] && s.sites[k].inFlight]).find(([, f]) => f && !f.selftest);
  const phase = (s.connect && s.connect.phase) || "idle";
  const d = { badKey, connected, phase };
  if (!s.enabled && !bf.connecting) return Object.assign(d, { key: "off", icon: "⏻", pill: "⏻ Off", tone: "off", title: "BookForge isn't connected", sub: "The bridge is off, so BookForge can't use your AIs. Nothing is shared until you connect.", next: "Press “🔗 Connect BookForge”. It turns the bridge on and connects BookForge in one click." });
  if (s.enabled && (bf.starting || (!s.listening && (s.starting || !s.error)))) return Object.assign(d, { key: "starting", icon: "⏳", pill: "⏳ Starting", tone: "info", title: "Starting the bridge…", sub: `Opening a private doorway on this computer (127.0.0.1:${port}).`, next: "Wait a moment while the bridge starts…" });
  if (s.enabled && !s.listening) { const e = bfErrorText(s.error, port); return Object.assign(d, { key: "error", icon: "⚠️", pill: "⚠ Problem", tone: "err", title: e.title, sub: e.sub, next: e.next }); }
  let next;
  if (bf.test.running) next = "The connection test is running — watch the ticks below. You can stop it any time.";
  else if (badKey && !connected) next = "BookForge (or something else) tried an old or wrong key. Press “🔗 Connect BookForge” to hand BookForge the right one.";
  else if (!connected && (phase === "waiting" || phase === "paired")) next = "Finish in the BookForge page that opened in your browser. This panel ticks by itself when it's done.";
  else if (!connected && phase === "not_running") next = (s.connect && s.connect.message) || "Start BookForge, then press Connect BookForge again.";
  else if (!connected) next = "Press “🔗 Connect BookForge”. It opens BookForge in your browser and connects it — nothing to copy or paste.";
  else if (!activeSites.length) next = "Tick at least one AI (ChatGPT, Claude or Gemini) as Active in this app so BookForge has someone to ask.";
  else if (notReady.length) next = `Open ${notReady.map((k) => bfLabel(k, s)).join(" and ")} and log in, so BookForge can use ${notReady.length > 1 ? "them" : "it"}.`;
  else if (s.bookforge && s.bookforge.approvals && s.bookforge.approvals.count > 0) next = "BookForge is waiting for your OK — see “Now working on” and press ✅ Review & approve.";
  else next = "All set. Use BookForge as normal and keep routing/autopilot off while it works.";
  if (working) {
    const [site, f] = working;
    const L = bfLabel(site, s);
    const el2 = (f.elapsed_ms || 0) + (Date.now() - bf.at);
    const late = f.phase === "late";
    return Object.assign(d, { key: "working", icon: "✍️", pill: "✍ Working", tone: "work",
      title: `BookForge asked ${L} for an answer… ${bfClock(el2)}`,
      sub: late ? `${L} is taking longer than BookForge waited. If it still answers, the answer is saved for BookForge.` : "The answer goes straight back to BookForge.",
      next: `Leave the ${L} window alone until it finishes answering — BookForge is waiting for it.` });
  }
  if (connected) {
    const b = s.bookforge;
    const when = b && !b.stale ? `last update ${bfAgo(b.receivedAt)}` : `last contact ${bfAgo(s.lastExternalContactAt || (b && b.receivedAt))}`;
    return Object.assign(d, { key: "connected", icon: "🔗", pill: "✓ Connected", tone: "ok", title: "BookForge is connected ✔", sub: `BookForge can use your AIs · ${when}.`, next });
  }
  if (phase === "waiting" || phase === "paired") return Object.assign(d, { key: "waiting", icon: "📡", pill: "📡 Connecting", tone: "wait", title: "Connecting to BookForge…", sub: "Finish in the BookForge page that opened in your browser.", next });
  return Object.assign(d, { key: "waiting", icon: "📡", pill: "📡 Not connected", tone: "wait", title: "Bridge is on — BookForge isn't connected yet", sub: `Listening on 127.0.0.1:${port} (this computer only).`, next });
}

// --- 🔗 Connect: the message under the button --------------------------------
function bfConnectView(s, d) {
  const c = s.connect || {};
  if (bf.startingApp) return { tone: "work", text: "Starting BookForge for you… the first start can take a minute or two while it gets ready." };
  if (bf.localMsg) return bf.localMsg;
  if (bf.connecting || c.phase === "starting_bridge" || c.phase === "checking") return { tone: "work", text: c.phase === "checking" ? "Looking for BookForge…" : "Turning the bridge on…" };
  if (d.connected && (c.phase === "connected" || c.phase === "idle" || !c.phase || c.phase === "no_status" || c.phase === "expired" || c.phase === "error" || c.phase === "not_running")) {
    if (c.phase === "no_status" || !s.bookforge) return { tone: "ok", text: "Connected ✔ BookForge can use your AIs. (It hasn't sent what it's working on yet — that shows below once it does.)" };
    return { tone: "ok", text: "Connected ✔ BookForge can use your AIs." };
  }
  switch (c.phase) {
    case "waiting": {
      const left = c.expiresAt ? Math.max(0, c.expiresAt - bfNow()) : 0;
      return { tone: "work", text: `BookForge opened in your browser. If it asks, click Connect there — this finishes by itself. (${bfClock(left)} left)` };
    }
    case "paired": return { tone: "work", text: "BookForge has the key ✔ — waiting for its first update…" };
    case "connected": // connected earlier, but not any more (no contact / updates stopped)
      return s.bookforge && s.bookforge.stale
        ? { tone: "warn", text: `BookForge stopped sending updates ${bfAgo(s.bookforge.receivedAt)} — is it still open? If you restarted it, press Connect again.` }
        : { tone: "warn", text: "BookForge isn't connected any more. Press Connect again." };
    case "no_status": return { tone: "warn", text: c.message || "BookForge has the key, but hasn't reported back yet." };
    case "not_running": return { tone: "warn", text: c.message || "BookForge isn't running. Start it with run-bookforge.bat, then press Connect again.", start: !!c.canStartApp };
    case "expired": case "error": return { tone: "err", text: c.message || "Connecting didn't finish. Press Connect again." };
    default: return { tone: "", text: "One click: turns the bridge on, opens BookForge in your browser and hands it the key. Nothing to copy or paste." };
  }
}
function bfRenderConnect(s, d) {
  const v = bfConnectView(s, d);
  const box = el("bf-connect-msg");
  if (box) { if (v.tone) box.dataset.tone = v.tone; else delete box.dataset.tone; }
  bfText("bf-connect-text", v.text);
  const start = el("btn-bf-start-app");
  if (start) { start.style.display = v.start && !bf.startingApp ? "" : "none"; start.disabled = bf.startingApp; }
  const btn = el("btn-bf-connect");
  if (btn) {
    const c = s.connect || {};
    const busy = bf.connecting || bf.startingApp || c.phase === "starting_bridge" || c.phase === "checking";
    btn.disabled = busy;
    let label = "🔗 Connect BookForge";
    if (busy) label = "⏳ Connecting…";
    else if (c.phase === "waiting" || c.phase === "paired") label = "🔗 Connect again";
    else if (d.connected) label = "Connected ✔";
    btn.textContent = label;
    btn.dataset.state = d.connected && !busy ? "connected" : "";
    btn.title = d.connected ? "BookForge is connected. Click to connect again (for example after restarting BookForge)." : "Turns the bridge on, opens BookForge in your browser and hands it the connection key — nothing to copy or paste";
  }
}

// --- AIs ----------------------------------------------------------------------
const BF_OUTCOME = {
  OK: (l) => `Answered in ${bfDur(l.elapsed_ms)}`,
  LATE_REPLY_STORED: (l) => `Answered late (${bfDur(l.elapsed_ms)})`,
  TIMEOUT: (l) => `Timed out after ${bfDur(l.elapsed_ms)}`,
  LATE_EXPIRED: () => "Never answered",
  SEND_FAILED: () => "Couldn't type the prompt",
  SITE_NOT_READY: () => "Window wasn't loaded",
  SITE_BUSY: () => "Was busy — told BookForge to wait"
};
function bfRenderAis(s) {
  const box = el("bf-ais");
  if (!box) return;
  box.textContent = "";
  for (const site of BF_SITES) {
    const x = (s.sites && s.sites[site]) || {};
    let pill = ["Not loaded", "err", "✕"];
    if (!x.active) pill = ["Not active", "off", "–"];
    else if (x.inFlight) pill = [x.inFlight.selftest ? "Busy with the test" : "Busy with BookForge", "work", "✍"];
    else if (x.ready) pill = ["Ready", "ok", "✓"];
    const card = document.createElement("div");
    card.className = "bf-ai";
    card.dataset.site = site;
    const nm = document.createElement("div"); nm.className = "bf-ai-name"; nm.textContent = bfLabel(site, s);
    const p = document.createElement("span"); p.className = "bf-pill"; p.dataset.tone = pill[1]; p.textContent = `${pill[2]} ${pill[0]}`;
    const last = document.createElement("div"); last.className = "bf-ai-last";
    if (x.inFlight) last.textContent = `Working for ${bfClock((x.inFlight.elapsed_ms || 0) + (Date.now() - bf.at))}`;
    else if (x.last) { const f = BF_OUTCOME[x.last.outcome]; last.textContent = `Last: ${f ? f(x.last) : x.last.outcome}${x.last.selftest ? " (test)" : ""} · ${bfAgo(x.last.at)}`; }
    else last.textContent = "No requests yet";
    card.append(nm, p, last);
    box.appendChild(card);
  }
}

// --- the connection check (live state + the link test's results) ---------------
// Link-test step id -> row id in the list.
function bfRowForStep(id) {
  if (id === "bridge_on") return "bridge";
  if (id === "key_file" || id === "wrong_key" || id === "right_key") return "key";
  if (id === "bookforge_running") return "app";
  if (id === "bookforge_connected") return "paired";
  const [k, site] = String(id).split(":");
  if (k === "pane") return `ready:${site}`;
  if (k === "roundtrip") return `trip:${site}`;
  return null;
}
// Combine the test steps that feed one row: running > fail > skip > pass.
function bfTestForRow(rowId) {
  let out = null;
  const rank = { running: 4, fail: 3, skip: 2, pass: 1 };
  for (const [id, p] of bf.test.results) {
    if (bfRowForStep(id) !== rowId) continue;
    if (!out || (rank[p.status] || 0) > (rank[out.status] || 0)) out = p;
  }
  return out;
}
function bfConnRows(s, d) {
  const rows = [];
  const c = s.connect || {};
  const on = s.enabled && s.listening;
  rows.push({ id: "bridge", label: "The bridge is on",
    st: on ? "ok" : s.enabled && s.error ? "bad" : s.enabled ? "wait" : "todo",
    state: on ? "On" : s.enabled && s.error ? "Problem" : s.enabled ? "Starting…" : "Off",
    detail: on ? `Listening on 127.0.0.1:${s.port} — this computer only.` : s.enabled && s.error ? bfErrorText(s.error, s.port).title : "Connect BookForge turns it on for you." });
  rows.push({ id: "key", label: "The connection key is ready",
    st: s.tokenPresent ? "ok" : "todo", state: s.tokenPresent ? "Ready" : "Not yet",
    detail: s.tokenPresent ? "BookForge gets it privately when you connect — never in a web address." : "Made automatically when you connect." });
  const app = s.app || {};
  const bfFresh = !!(s.bookforge && !s.bookforge.stale);
  const appOk = app.running === true || bfFresh;
  rows.push({ id: "app", label: "BookForge is running",
    st: appOk ? "ok" : app.running === false ? (c.phase === "not_running" ? "bad" : "todo") : "wait",
    state: appOk ? "Running" : app.running === false ? "Not running" : "Checking…",
    detail: appOk ? `${app.base ? `At ${app.base.replace(/\/$/, "")}` : "Running"}${app.version ? ` · version ${app.version}` : ""}` : app.running === false ? "Start BookForge with run-bookforge.bat (or press Connect and choose “Start BookForge for me”)." : "" });
  const waiting = c.phase === "waiting" || c.phase === "paired";
  rows.push({ id: "paired", label: "BookForge is connected to this app",
    st: d.connected ? "ok" : waiting ? "wait" : d.badKey ? "warn" : "todo",
    state: d.connected ? "Connected" : waiting ? "Connecting…" : d.badKey ? "Wrong key used" : "Not yet",
    detail: d.connected ? (s.bookforge && !s.bookforge.stale ? `Last update ${bfAgo(s.bookforge.receivedAt)}.` : `Last contact ${bfAgo(s.lastExternalContactAt)}.`) : waiting ? "Finish in the BookForge page in your browser." : "Press 🔗 Connect BookForge." });
  for (const site of BF_SITES) {
    const x = (s.sites && s.sites[site]) || {};
    const L = bfLabel(site, s);
    if (!x.active) { rows.push({ id: `ready:${site}`, label: `${L} is ready`, st: "na", state: "Not used", detail: `Not Active in this app — tick ${L} as Active to use it.` }); continue; }
    rows.push({ id: `ready:${site}`, label: `${L} is ready`,
      st: x.inFlight ? "ok" : x.ready ? "ok" : "bad",
      state: x.inFlight ? "Busy" : x.ready ? "Ready" : "Not loaded",
      detail: x.inFlight ? "Answering right now." : x.ready ? "" : "Open its window, log in and wait until it has loaded." });
    const lastTest = x.last && x.last.selftest ? x.last : null;
    rows.push({ id: `trip:${site}`, label: `${L} answers through the bridge`,
      st: lastTest ? (lastTest.outcome === "OK" ? "ok" : "bad") : "na",
      state: lastTest ? (lastTest.outcome === "OK" ? "Works" : "Failed") : "Not tested",
      detail: lastTest ? `Last test ${bfAgo(lastTest.at)}.` : "Press 🧪 Test the connection to send it a tiny test question." });
  }
  return rows;
}
const BF_ROW_ICON = { ok: "✓", bad: "✕", warn: "!", wait: "…", todo: "•", na: "–", run: "" };
function bfRenderConnRows(s, d) {
  const ol = el("bf-conn-steps");
  if (!ol) return;
  const rows = bfConnRows(s, d);
  ol.textContent = "";
  let currentSet = false;
  for (const r of rows) {
    const t = bfTestForRow(r.id);
    let st = r.st, state = r.state, detail = r.detail, tip = null;
    if (t && t.status === "running") { st = "run"; state = "Checking…"; }
    else if (t && r.id.startsWith("trip:")) {
      st = t.status === "pass" ? "ok" : t.status === "fail" ? "bad" : "na";
      state = t.status === "pass" ? "Works" : t.status === "fail" ? "Failed" : "Skipped";
      detail = t.detail || detail; tip = t.status === "fail" ? t.tip : null;
    } else if (t && t.status === "fail") {
      if (st === "ok") st = "warn";
      detail = `Last test: ${t.detail}`; tip = t.tip;
    }
    const li = document.createElement("li");
    li.dataset.row = r.id;
    li.dataset.st = st;
    if (st === "todo" && !currentSet) { currentSet = true; li.dataset.current = "1"; } // only the next thing to do is highlighted
    const chk = document.createElement("span"); chk.className = "bf-check"; chk.setAttribute("aria-hidden", "true");
    if (st === "run") chk.innerHTML = '<span class="bf-spin"></span>'; else chk.textContent = BF_ROW_ICON[st] || "•";
    const main = document.createElement("div"); main.className = "bf-step-main";
    const tx = document.createElement("span"); tx.className = "bf-step-text"; tx.textContent = r.label;
    const dt = document.createElement("span"); dt.className = "bf-step-detail"; dt.textContent = detail || "";
    main.append(tx, dt);
    if (tip) { const tp = document.createElement("span"); tp.className = "tip"; tp.textContent = `How to fix: ${tip}`; main.appendChild(tp); }
    const stt = document.createElement("span"); stt.className = "bf-step-state"; stt.textContent = state;
    li.append(chk, main, stt);
    ol.appendChild(li);
  }
}

// --- Now working on -------------------------------------------------------------
const BF_TASK_STATE = [
  [/^(running|working|in[_ -]?progress|active|busy|generating|writing)$/i, "Working", "work"],
  [/^(needs?[_ -]?approval|review|awaiting[_ -]?(approval|review)|waiting[_ -]?for[_ -]?you|paused)$/i, "Needs your OK", "warn"],
  [/^(waiting|queued|pending)$/i, "Waiting", "info"],
  [/^(done|complete(d)?|approved|finished)$/i, "Done", "ok"],
  [/^(error|failed|blocked|problem|timeout)$/i, "Problem", "err"],
  [/^(idle|ready|todo|not[_ -]?started|draft)$/i, "Ready to start", "info"]
];
function bfStateWord(state) {
  const sv = String(state || "");
  for (const [re, word, tone] of BF_TASK_STATE) if (re.test(sv)) return { word, tone };
  return { word: sv ? sv.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()) : "", tone: "info" };
}
function bfStepLabel(t) {
  if (!t) return "";
  const parts = [];
  if (t.set) parts.push(/^set\b/i.test(t.set) ? t.set : `Set ${t.set}`);
  const name = [t.op, t.title].filter(Boolean).join(" ");
  if (name) parts.push(name);
  return parts.join(" · ");
}
function bfOpenFor(s) { const b = s.bookforge; return (b && b.bookforge_url) || (s.app && s.app.base) || null; }
function bfStaleNote(b) {
  if (!b || !b.stale) return "";
  return `Last update from BookForge ${bfAgo(b.receivedAt)} — it may be closed or busy. This shows the last thing it reported.`;
}
function bfRenderNow(s, d) {
  const b = s.bookforge;
  bfShow("bf-now", !!b);
  bfShow("bf-now-empty", !b);
  if (!b) {
    bfText("bf-now-empty", d.connected ? "BookForge is connected but hasn't said what it's working on yet. It shows here as soon as it does." : "Connect BookForge to see what's happening.");
    bfShow("bf-now-stale", false);
    return;
  }
  const t = b.current_task;
  bfText("bf-now-step", t ? (bfStepLabel(t) || "Current step") : "Nothing in progress");
  const sw = bfStateWord(t && t.state);
  const pill = el("bf-now-state");
  if (pill) { pill.hidden = !sw.word; pill.textContent = sw.word; pill.dataset.tone = sw.tone; }
  bfText("bf-now-msg", (t && t.message) || (t ? "" : "BookForge isn't working on a step right now."));
  const w = b.working_on;
  const wEl = el("bf-now-working");
  if (wEl) {
    if (w && (w.op || w.title)) {
      wEl.hidden = false;
      const since = w.started_at ? ` — ${bfClock(Date.now() - w.started_at)}` : "";
      bfText("bf-now-working", `✍ Working on ${[w.op, w.title].filter(Boolean).join(" ")}${since}`);
    } else wEl.hidden = true;
  }
  const ap = b.approvals || { count: 0, items: [] };
  const n = Number(ap.count) || 0;
  const box = el("bf-approvals");
  if (box) box.dataset.tone = n > 0 ? "warn" : "ok";
  bfText("bf-approvals-title", n > 0 ? `${n} thing${n === 1 ? " needs" : "s need"} your approval` : "✓ Nothing needs your approval right now");
  const list = el("bf-approvals-list");
  if (list) {
    list.textContent = "";
    const items = (ap.items || []).slice(0, 3);
    for (const it of items) { const li = document.createElement("li"); li.textContent = [it.set && !it.op ? `Set ${it.set}` : null, it.op, it.title].filter(Boolean).join(" ") || "Untitled"; list.appendChild(li); }
    const more = n - items.length;
    if (n > 0 && more > 0) { const li = document.createElement("li"); li.textContent = `…and ${more} more`; list.appendChild(li); }
  }
  const appr = el("btn-bf-approve");
  if (appr) appr.style.display = n > 0 ? "" : "none";
  const go = el("btn-bf-goto-task");
  if (go) go.style.display = t && (t.url || bfOpenFor(s)) ? "" : "none";
  const stale = bfStaleNote(b);
  bfShow("bf-now-stale", !!stale);
  bfText("bf-now-stale", stale);
}

// --- Book checklist -------------------------------------------------------------
const BF_CHECK_STATE = [
  [/^(done|complete(d)?|approved|finished|ok)$/i, "✓", "Done", "ok"],
  [/^(current|running|working|in[_ -]?progress|active|now)$/i, "▶", "In progress", "work"],
  [/^(needs?[_ -]?approval|review|awaiting[_ -]?(approval|review)|waiting[_ -]?for[_ -]?you)$/i, "!", "Needs your OK", "warn"],
  [/^(error|failed|blocked|problem)$/i, "✕", "Problem", "err"],
  [/^(skipped|not[_ -]?needed|n\/?a)$/i, "–", "Skipped", "off"],
  [/^(todo|pending|not[_ -]?started|waiting|queued|locked|)$/i, "○", "To do", "off"]
];
function bfCheckState(state) {
  const sv = String(state || "");
  for (const [re, ic, word, tone] of BF_CHECK_STATE) if (re.test(sv)) return { ic, word, tone };
  return { ic: "○", word: sv.replace(/[_-]+/g, " "), tone: "off" };
}
function bfRenderBook(s, d) {
  const b = s.bookforge;
  const rows = b && Array.isArray(b.checklist) ? b.checklist : [];
  const has = !!(b && (rows.length || b.total || (b.project && b.project.title)));
  bfShow("bf-book", has);
  bfShow("bf-book-empty", !has);
  if (!has) bfText("bf-book-empty", d.connected ? "BookForge is connected — open a book in BookForge and its progress shows here." : "When BookForge is connected, your book's progress shows here.");
  if (has) {
    bfText("bf-book-title", (b.project && b.project.title) ? `“${b.project.title}”` : "Your book");
    const doneCount = rows.filter((r) => bfCheckState(r.state).tone === "ok").length;
    const total = Number.isFinite(b.total) && b.total > 0 ? b.total : rows.length;
    const done = Math.min(total, Number.isFinite(b.done) ? b.done : doneCount);
    const pct = total ? Math.round((done / total) * 100) : 0;
    const bar = el("bf-progress-bar");
    if (bar) bar.style.width = `${pct}%`;
    const pb = el("bf-progress");
    if (pb) { pb.setAttribute("aria-valuemax", String(total)); pb.setAttribute("aria-valuenow", String(done)); }
    bfText("bf-progress-text", total ? `${done} of ${total} done (${pct}%)` : "No parts listed yet");
    const ol = el("bf-checklist");
    if (ol) {
      ol.textContent = "";
      for (const r of rows) {
        const cs = bfCheckState(r.state);
        const li = document.createElement("li");
        li.dataset.tone = cs.tone;
        const ic = document.createElement("span"); ic.className = "ic"; ic.setAttribute("aria-hidden", "true"); ic.textContent = cs.ic;
        const tt = document.createElement("span"); tt.className = "tt";
        if (r.set) { const st = document.createElement("span"); st.className = "set"; st.textContent = r.set; tt.appendChild(st); }
        tt.appendChild(document.createTextNode(r.title || r.id || "Untitled"));
        const stw = document.createElement("span"); stw.className = "st"; stw.textContent = cs.word;
        li.append(ic, tt, stw);
        ol.appendChild(li);
      }
    }
  }
  const stale = bfStaleNote(b);
  bfShow("bf-book-stale", !!stale);
  bfText("bf-book-stale", stale);
  const open = el("btn-bf-open");
  if (open) open.style.display = bfOpenFor(s) ? "" : "none";
}

function bfRenderActivity(s) {
  const list = el("bf-activity");
  if (!list) return;
  const items = (Array.isArray(s.activity) ? s.activity : []).slice(-20).reverse();
  list.textContent = "";
  if (!items.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = "Nothing yet — events appear here as they happen."; list.appendChild(li); return; }
  const ICON = { ok: "✓", warn: "!", error: "✕", info: "•" };
  for (const a of items) {
    const li = document.createElement("li");
    li.dataset.tone = a.tone || "info";
    const t = document.createElement("span"); t.className = "t"; t.textContent = bfTime(a.at); t.title = bfAgo(a.at);
    const i = document.createElement("span"); i.className = "i"; i.setAttribute("aria-hidden", "true"); i.textContent = ICON[a.tone] || "•";
    const m = document.createElement("span"); m.textContent = a.say || a.kind;
    li.append(t, i, m);
    list.appendChild(li);
  }
}
function bookforgeRender(s) {
  if (!s || !s.ok) return;
  bf.snap = s;
  bf.at = Date.now();
  bfRenderAll();
}
function bfRenderAll() {
  const s = bf.snap;
  if (!s) return;
  try {
    if (el("bf-enabled") && !bf.starting) el("bf-enabled").checked = !!s.enabled;
    const d = bfDerive(s);
    const panel = el("col-bookforge");
    if (panel) panel.dataset.bfState = d.key;
    const st = el("bf-status");
    if (st) { st.textContent = d.pill; st.dataset.tone = d.tone; }
    bfText("bf-hero-icon", d.icon);
    bfText("bf-hero-title", d.title);
    bfText("bf-hero-sub", d.sub);
    bfText("bf-next", d.next);
    bfRenderConnect(s, d);
    bfRenderAis(s);
    bfRenderConnRows(s, d);
    bfRenderNow(s, d);
    bfRenderBook(s, d);
    bfRenderActivity(s);
    const det = el("bf-detail");
    if (det) {
      const c = s.counters;
      det.textContent = s.enabled && s.listening
        ? `Technical: bridge http://${s.host}:${s.port}${c ? ` · ${c.requests} request${c.requests === 1 ? "" : "s"} · ${c.answered} answered · ${c.timeouts} timed out · ${c.unauthorized} refused (wrong key)` : ""}`
        : `Technical: bridge port ${s.port} · ${s.enabled ? `not listening (${s.error || "starting"})` : "off — nothing is listening"}`;
    }
    if (!bf.test.running && s.linkTest && s.linkTest.lastReport && !bf.test.report) {
      bf.test.report = s.linkTest.lastReport;
      bfShowReportButton();
      const sum = el("bf-test-summary");
      if (sum && !sum.textContent && s.linkTest.lastSummary) {
        const ls = s.linkTest.lastSummary;
        sum.textContent = `Last test (${bfAgo(ls.at)}): ${ls.headline} ${ls.passCount} passed · ${ls.failCount} failed · ${ls.skipCount} skipped.`;
        sum.dataset.tone = ls.failCount ? "err" : "ok";
      }
    }
  } catch (e) {
    // Never let a bad snapshot break the rest of the controls window.
    bfMsg(`The BookForge panel couldn't update (${(e && e.message) || e}).`, "err");
  }
}
async function bookforgeRefresh() {
  if (!window.api || !window.api.bookforgeStatus) return;
  try { bookforgeRender(await window.api.bookforgeStatus()); } catch (_) {}
}
// Live: every bridge event arrives with a fresh snapshot; the 4 s refresh stays as a fallback.
if (window.api && window.api.onBookforgeActivity) window.api.onBookforgeActivity((p) => { if (p && p.status) bookforgeRender(p.status); });
// Tick clocks ("0:42", "12s ago") once a second without asking main.
setInterval(() => { if (bf.snap && el("col-bookforge") && !el("col-bookforge").classList.contains("hidden-collapsed")) bfRenderAll(); }, 1000);

if (el("bf-enabled")) el("bf-enabled").onchange = async () => {
  if (!window.api.bookforgeSetEnabled) return;
  const want = el("bf-enabled").checked;
  bf.starting = want;
  if (bf.snap) { bf.snap.enabled = want; bfRenderAll(); }
  bfMsg("");
  let s = null;
  try { s = await window.api.bookforgeSetEnabled(want); } catch (_) {}
  bf.starting = false;
  if (s) bookforgeRender(s); else { bfMsg("Couldn't change the bridge — please try again.", "err"); bookforgeRefresh(); }
  if (s && s.enabled && !s.listening) bfMsg(`Could not start: ${bfErrorText(s.error, s.port).title}.`, "err");
};

// --- 🔗 Connect BookForge -------------------------------------------------------
async function bfConnect() {
  if (!window.api.bookforgeConnect || bf.connecting) return;
  bf.connecting = true;
  bf.localMsg = null;
  bfMsg("");
  bfRenderAll();
  let s = null;
  try { s = await window.api.bookforgeConnect(); }
  catch (e) { bf.localMsg = { tone: "err", text: `Couldn't connect (${(e && e.message) || e}). Press Connect again.` }; }
  bf.connecting = false;
  if (s && s.ok) bookforgeRender(s); else { if (!bf.localMsg) bf.localMsg = { tone: "err", text: "Couldn't connect — no answer from the app. Press Connect again." }; bfRenderAll(); }
  setTimeout(() => { bf.localMsg = null; }, 15000);
}
if (el("btn-bf-connect")) el("btn-bf-connect").onclick = () => bfConnect();
if (el("btn-bf-start-app")) el("btn-bf-start-app").onclick = async () => {
  if (!window.api.bookforgeStartApp || bf.startingApp) return;
  bf.startingApp = true;
  bf.localMsg = null;
  bfRenderAll();
  let r = null;
  try { r = await window.api.bookforgeStartApp(); } catch (e) { r = { ok: false, message: `Couldn't start BookForge (${(e && e.message) || e}).` }; }
  bf.startingApp = false;
  if (r && r.ok && r.running) { await bfConnect(); return; } // it's up — finish connecting by itself
  bf.localMsg = { tone: r && r.ok ? "warn" : "err", text: (r && r.message) || "Couldn't start BookForge. Start it yourself with run-bookforge.bat, then press Connect again.", start: false };
  bfRenderAll();
};
async function bfOpen(url, what) {
  if (!window.api.bookforgeOpenUrl) return;
  let r = null;
  try { r = await window.api.bookforgeOpenUrl(url || ""); } catch (e) { r = { ok: false, message: String((e && e.message) || e) }; }
  if (!r || !r.ok) bfMsg(`Couldn't open ${what}. ${(r && r.message) || ""}`.trim(), "err");
  else bfMsg("");
}
if (el("btn-bf-approve")) el("btn-bf-approve").onclick = () => { const s = bf.snap || {}; const b = s.bookforge || {}; bfOpen((b.approvals && b.approvals.url) || bfOpenFor(s), "the approvals page"); };
if (el("btn-bf-goto-task")) el("btn-bf-goto-task").onclick = () => { const s = bf.snap || {}; const b = s.bookforge || {}; bfOpen((b.current_task && b.current_task.url) || bfOpenFor(s), "the current task"); };
if (el("btn-bf-open")) el("btn-bf-open").onclick = () => bfOpen(bfOpenFor(bf.snap || {}), "BookForge");

// --- Other ways: the key by hand ---------------------------------------------------
if (el("btn-bf-copy")) el("btn-bf-copy").onclick = async () => {
  if (!window.api.bookforgeCopyToken) return;
  let r = null;
  try { r = await window.api.bookforgeCopyToken(); } catch (_) {}
  if (r && r.ok) {
    bfStore.set("bf-key-copied", "1");
    bfMsg("✓ Connection key copied. Now in BookForge open Settings → Connect AutoInjector and paste it (Ctrl+V).");
    bfRenderAll();
  } else bfMsg(`Copy failed (${(r && r.error) || "unknown"}). Try “Show key” and copy it by hand.`, "err");
};
if (el("btn-bf-reveal")) el("btn-bf-reveal").onclick = async () => {
  const box = el("bf-token");
  if (!box || !window.api.bookforgeRevealToken) return;
  if (box.style.display !== "none") { box.style.display = "none"; box.textContent = ""; el("btn-bf-reveal").textContent = "Show key"; return; }
  let r = null;
  try { r = await window.api.bookforgeRevealToken(); } catch (_) {}
  if (r && r.ok) {
    box.textContent = r.token; box.style.display = "block"; el("btn-bf-reveal").textContent = "Hide key";
    bfMsg("This is your connection key. Keep it private — click Hide key when you're done.");
  } else bfMsg(`Could not read the connection key (${(r && r.error) || "unknown"}).`, "err");
};
if (el("btn-bf-regen")) el("btn-bf-regen").onclick = async () => {
  if (!window.api.bookforgeRegenerateToken) return;
  if (!window.confirm("Make a new connection key?\n\nThe old key stops working right away, so BookForge is disconnected until it gets the new key (press Connect BookForge again).\n\nOnly do this if you think someone else has seen your key.")) return;
  let s = null;
  try { s = await window.api.bookforgeRegenerateToken(); } catch (_) {}
  if (s && s.ok) {
    bfStore.set("bf-key-copied", null);
    const box = el("bf-token");
    if (box) { box.style.display = "none"; box.textContent = ""; }
    if (el("btn-bf-reveal")) el("btn-bf-reveal").textContent = "Show key";
    bookforgeRender(s);
    bfMsg("New connection key made. Press “🔗 Connect BookForge” to hand it to BookForge.");
  } else bfMsg(`Couldn't make a new key (${(s && s.error) || "unknown"}).`, "err");
};

// --- 🧪 Test the connection (the real link test, ticking the same rows) -----------
function bfShowReportButton() { const b = el("btn-bf-test-report"); if (b) b.style.display = bf.test.report ? "" : "none"; }
function bfTestButtons(running) {
  const b = el("btn-bf-test");
  if (b) { b.disabled = running; b.textContent = running ? "🧪 Testing…" : "🧪 Test the connection"; }
  if (el("btn-bf-test-stop")) el("btn-bf-test-stop").style.display = running ? "" : "none";
}
function bfTestStep(p) {
  if (!p || !p.id) return;
  bf.test.results.set(p.id, Object.assign({}, bf.test.results.get(p.id) || {}, p));
  if (p.total && el("bf-test-summary") && bf.test.running) el("bf-test-summary").textContent = `Testing… ${Math.min(p.index + (p.status === "running" ? 1 : 0), p.total)} of ${p.total} checks`;
  bfRenderAll();
}
if (window.api && window.api.onBookforgeLinkTestProgress) window.api.onBookforgeLinkTestProgress((p) => {
  if (!p) return;
  if (p.status === "start" || p.status === "done") return; // handled by the run() call itself
  bfTestStep(p);
});
async function bfRunLinkTest() {
  if (!window.api.bookforgeLinkTestRun || bf.test.running) return;
  bf.test.running = true;
  bf.test.results.clear();
  bf.test.report = null;
  bfShowReportButton();
  const sum = el("bf-test-summary");
  if (sum) { sum.textContent = "Starting the test…"; delete sum.dataset.tone; }
  bfTestButtons(true);
  bfRenderAll();
  let r = null;
  try { r = await window.api.bookforgeLinkTestRun(); } catch (e) { r = { ok: false, error: String(e) }; }
  bf.test.running = false;
  bfTestButtons(false);
  if (r && r.ok) {
    for (const st of r.steps || []) bf.test.results.set(st.id, Object.assign({}, st));
    if (sum) { sum.textContent = `${r.headline} ${r.passCount} passed · ${r.failCount} failed · ${r.skipCount} skipped.${r.report ? " Report saved." : ""}`; sum.dataset.tone = r.failCount ? "err" : "ok"; }
    bf.test.report = r.report || null;
    bfShowReportButton();
  } else if (sum) { sum.textContent = `The test couldn't run: ${(r && r.error) === "ALREADY_RUNNING" ? "a test is already running." : (r && r.error) || "unknown error"}`; sum.dataset.tone = "err"; }
  bfRenderAll();
  bookforgeRefresh();
}
if (el("btn-bf-test")) el("btn-bf-test").onclick = () => bfRunLinkTest();
if (el("btn-bf-test-stop")) el("btn-bf-test-stop").onclick = async () => {
  if (!window.api.bookforgeLinkTestStop) return;
  try { await window.api.bookforgeLinkTestStop(); } catch (_) {}
  if (el("bf-test-summary")) el("bf-test-summary").textContent = "Stopping… (finishing the current check)";
};
if (el("btn-bf-test-report")) el("btn-bf-test-report").onclick = async () => {
  if (!bf.test.report || !window.api.bookforgeOpenLinkTestReport) return;
  let r = null;
  try { r = await window.api.bookforgeOpenLinkTestReport(bf.test.report); } catch (_) {}
  if (!r || !r.ok) bfMsg(`Couldn't open the report (${(r && r.error) || "unknown"}). It's in the logs folder: ${bf.test.report}`, "err");
};

el("btn-clear").onclick = async () => {
  const res = await window.api.clearTranscript();
  if (res?.ok) renderTranscript([]);
};

// Extract All: save the whole conversation + the full activity/error log to one
// text file in the program's logs folder (main writes it; nothing is truncated).
el("btn-extract-all").onclick = async () => {
  const status = el("extract-status");
  const btn = el("btn-extract-all");
  if (status) status.textContent = "Extracting…";
  if (btn) btn.disabled = true;
  try {
    const res = await window.api.extractAllLogs();
    if (res && res.ok) {
      if (status) status.textContent = `Saved ${res.messages} messages + ${res.logEntries} log entries → ${res.file}`;
    } else if (status) {
      status.textContent = `Extract failed: ${(res && res.error) || "unknown error"}`;
    }
  } catch (e) {
    if (status) status.textContent = `Extract failed: ${e && e.message ? e.message : e}`;
  } finally {
    if (btn) btn.disabled = false;
  }
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
  databaseRefresh();
  bookforgeRefresh();
  setInterval(bookforgeRefresh, 4000);
})();

// ---------------------------------------------------------------------------
// ⌨ Terminal — the Command Prompt connection (third zone of the User Panel).
// main.js owns the shell (terminal-provider.js); this just renders its output
// stream, the AI approval strip, and sends what you type. Every call is
// guarded so an older main process (or the test harness) without the terminal
// API simply leaves the zone inert instead of breaking the whole panel.
// ---------------------------------------------------------------------------
const termUI = {
  history: [],        // your past commands, newest last (↑/↓ to recall)
  histPos: -1,
  running: false,     // something is running right now -> Enter answers it instead
  maxChars: 120000,   // view cap; the shell keeps its own scrollback in main
};
function termApi(name) {
  return window.api && typeof window.api[name] === "function" ? window.api[name] : null;
}
function termAppend(chunk, stream) {
  const out = el("term-output");
  if (!out || !chunk) return;
  const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 30;
  const span = document.createElement("span");
  if (stream === "stderr") span.className = "t-err";
  else if (stream === "system") span.className = "t-sys";
  span.textContent = chunk;
  out.appendChild(span);
  // Keep the DOM bounded: drop the oldest spans once the view gets huge.
  while (out.textContent.length > termUI.maxChars && out.firstChild) out.removeChild(out.firstChild);
  if (nearBottom) out.scrollTop = out.scrollHeight;
}
function renderTermPending(pending) {
  const box = el("term-pending");
  const badge = el("term-pending-badge");
  if (!box) return;
  box.innerHTML = "";
  const list = Array.isArray(pending) ? pending : [];
  if (badge) {
    badge.textContent = String(list.length);
    if (list.length) badge.removeAttribute("data-zero"); else badge.setAttribute("data-zero", "");
  }
  for (const req of list) {
    const row = document.createElement("div");
    row.className = "term-req" + (req.risk === "dangerous" ? " dangerous" : "");
    const head = document.createElement("div");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = req.label || req.from;
    head.appendChild(who);
    head.appendChild(document.createTextNode(` wants to run${req.commands.length === 1 ? "" : ` ${req.commands.length} commands`}:`));
    row.appendChild(head);
    const code = document.createElement("code");
    code.textContent = req.commands.join("\n");
    row.appendChild(code);
    if (req.risk === "dangerous") {
      const why = document.createElement("div");
      why.className = "why";
      why.textContent = `⚠ ${req.reason}`;
      why.title = `Careful — this ${req.reason}.`;
      row.appendChild(why);
    }
    const acts = document.createElement("div");
    acts.className = "acts";
    const run = document.createElement("button");
    run.className = "primary";
    run.textContent = "▶ Run";
    run.onclick = async () => {
      run.disabled = true; rej.disabled = true;
      const fn = termApi("terminalApprove");
      const r = fn ? await fn(req.id).catch((e) => ({ ok: false, error: String(e) })) : { ok: false, error: "NO_API" };
      if (!r || !r.ok) { termAppend(`[couldn't run request: ${(r && r.error) || "error"}]\n`, "stderr"); run.disabled = false; rej.disabled = false; }
    };
    const rej = document.createElement("button");
    rej.textContent = "✕ Reject";
    rej.onclick = async () => {
      run.disabled = true; rej.disabled = true;
      const fn = termApi("terminalReject");
      const r = fn ? await fn(req.id, "").catch((e) => ({ ok: false, error: String(e) })) : { ok: false, error: "NO_API" };
      if (!r || !r.ok) { termAppend(`[couldn't reject request: ${(r && r.error) || "error"}]\n`, "stderr"); run.disabled = false; rej.disabled = false; }
    };
    acts.appendChild(run);
    acts.appendChild(rej);
    row.appendChild(acts);
    box.appendChild(row);
  }
}
function applyTerminalState(st) {
  if (!st) return;
  const dot = el("term-dot");
  termUI.running = !!st.running;
  if (dot) {
    dot.className = "term-dot" + (st.running ? " busy" : st.alive ? " alive" : "");
    dot.title = st.running ? `Running: ${st.running.command}` : st.alive ? "Shell ready" : "Shell not started (starts on your first command)";
  }
  const input = el("term-input");
  if (input) {
    input.classList.toggle("answering", termUI.running);
    input.placeholder = termUI.running
      ? "A command is running — type here to answer its prompt (e.g. y), or ■ Stop"
      : "Type a command and press Enter…";
  }
  const auto = el("cb-term-autorun");
  if (auto) auto.checked = !!st.autoRunAI;
  const send = el("btn-term-send");
  if (send) send.disabled = !st.hasLastUserResult;
  renderTermPending(st.pending);
}
async function termSubmit(fromCompose) {
  const input = el("term-input");
  if (!input && fromCompose == null) return;
  const text = fromCompose != null ? String(fromCompose) : input.value;
  if (!text.trim() && !termUI.running) return;
  if (fromCompose == null) input.value = "";
  termUI.histPos = -1;
  try {
    if (termUI.running) {
      // Something is running: Enter feeds its stdin (answering a y/n prompt).
      const fn = termApi("terminalInput");
      const r = fn ? await fn(text) : { ok: false, error: "NO_API" };
      if (!r || !r.ok) termAppend(`[couldn't send input: ${(r && r.error) || "error"}]\n`, "stderr");
      return;
    }
    if (termUI.history[termUI.history.length - 1] !== text) termUI.history.push(text);
    if (termUI.history.length > 200) termUI.history.shift();
    const fn = termApi("terminalRun");
    if (!fn) { termAppend("[terminal not available in this build]\n", "stderr"); return; }
    const r = await fn(text);
    const res = r && r.result;
    if (res && res.error && res.error !== "NONZERO_EXIT") termAppend(`[${res.error}${res.detail ? `: ${res.detail}` : ""}]\n`, res.error === "TIMEOUT" ? "system" : "stderr");
    else if (res && res.exitCode) termAppend(`[exit ${res.exitCode}]\n`, "system");
  } catch (e) {
    termAppend(`[terminal error: ${e && e.message ? e.message : e}]\n`, "stderr");
  }
}
function wireTerminal() {
  const tabT = el("tab-terminal"), tabM = el("tab-messages");
  const paneT = el("term-pane"), paneM = el("messages-pane");
  const show = (which) => {
    const term = which === "terminal";
    if (paneT) paneT.hidden = !term;
    if (paneM) paneM.hidden = term;
    if (tabT) { tabT.classList.toggle("active", term); tabT.setAttribute("aria-selected", String(term)); }
    if (tabM) { tabM.classList.toggle("active", !term); tabM.setAttribute("aria-selected", String(!term)); }
    if (term && el("term-input")) el("term-input").focus();
  };
  if (tabT) tabT.onclick = () => show("terminal");
  if (tabM) tabM.onclick = () => show("messages");

  const input = el("term-input");
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); termSubmit(); return; }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (!termUI.history.length || termUI.running) return;
        e.preventDefault();
        if (termUI.histPos === -1) termUI.histPos = termUI.history.length;
        termUI.histPos = Math.max(0, Math.min(termUI.history.length, termUI.histPos + (e.key === "ArrowUp" ? -1 : 1)));
        input.value = termUI.history[termUI.histPos] || "";
      }
    });
  }
  if (el("btn-term-run")) el("btn-term-run").onclick = () => termSubmit();
  if (el("btn-term-stop")) el("btn-term-stop").onclick = async () => {
    const fn = termApi("terminalStop");
    if (fn) { const r = await fn(true).catch((e) => ({ ok: false, error: String(e) })); if (!r || !r.ok) termAppend(`[stop failed: ${(r && r.error) || "error"}]\n`, "stderr"); }
  };
  if (el("btn-term-clear")) el("btn-term-clear").onclick = () => {
    el("term-output").innerHTML = "";
    const fn = termApi("terminalClear"); if (fn) fn().catch(() => {});
  };
  if (el("btn-open-lockers")) el("btn-open-lockers").onclick = async () => {
    const fn = termApi("openLockers");
    const r = fn ? await fn().catch((e) => ({ ok: false, error: String(e) })) : { ok: false, error: "NO_API" };
    termAppend(r && r.ok ? `[opened the AI lockers folder: ${r.path}]\n` : `[couldn't open the lockers folder: ${(r && r.error) || "error"}]\n`, r && r.ok ? "system" : "stderr");
  };
  if (el("cb-term-autorun")) el("cb-term-autorun").onchange = async (e) => {
    const on = !!e.target.checked;
    const fn = termApi("terminalSettings");
    const r = fn ? await fn({ autoRunAI: on }).catch(() => null) : null;
    if (!r || !r.ok) e.target.checked = !on;
    else termAppend(`[AI scripts ${on ? "now run without asking" : "ask before running again"} — file commands inside each AI's own locker never ask]\n`, "system");
  };
  if (el("btn-term-send")) el("btn-term-send").onclick = async () => {
    const t = el("term-send-target").value;
    const targets = t === "all" ? SITES.filter((s) => s) : [t];
    const fn = termApi("terminalSendOutput");
    const r = fn ? await fn(targets).catch((e) => ({ ok: false, error: String(e) })) : { ok: false, error: "NO_API" };
    termAppend(r && r.ok ? `[sent your last output to ${t === "all" ? "all AIs" : t}]\n` : `[send failed: ${(r && r.error) || "error"}]\n`, r && r.ok ? "system" : "stderr");
  };

  if (termApi("onTerminalData")) window.api.onTerminalData((p) => p && termAppend(p.chunk, p.stream));
  if (termApi("onTerminalState")) window.api.onTerminalState((st) => applyTerminalState(st));
  const getSt = termApi("terminalState");
  if (getSt) {
    getSt().then((r) => {
      if (!r || !r.ok) return;
      if (r.scrollback) termAppend(r.scrollback, "stdout");
      applyTerminalState(r.state);
    }).catch(() => {});
  }
}
try { wireTerminal(); } catch (e) { console.error("terminal UI init failed", e); }

// ---------------------------------------------------------------------------
// Compose box doubles as a command prompt. Nothing about sending to the AIs
// changes: type, click an AI's name, it goes to that AI. The extra:
//   Enter        -> run the text as a Command Prompt command (output shows in
//                   the ⌨ Terminal next to it; the box clears)
//   Shift+Enter  -> a new line, as before
//   Ctrl+Enter   -> force-run even if it looks like a sentence
// Guard: text that reads like a message to an AI (a question, or a long
// sentence that doesn't start with a known command) is NOT run on plain Enter
// — you get a hint instead, so a habit-Enter never fires English at cmd.exe.
// ---------------------------------------------------------------------------
const KNOWN_COMMANDS = new Set(("dir cd chdir cls copy xcopy robocopy move ren rename del erase md mkdir rd rmdir type echo set where " +
  "ipconfig ping tracert nslookup netstat tasklist taskkill systeminfo hostname whoami ver tree find findstr sort more attrib " +
  "start call exit pushd popd path title color date time sc schtasks reg wmic powershell pwsh cmd curl wget tar " +
  "git npm npx node python py pip pip3 winget choco code dotnet java javac go cargo rustc docker ollama ls pwd cat grep " +
  "make cmake gcc yarn pnpm deno bun gh az aws gcloud kubectl").split(" "));
function looksLikeCommand(text) {
  const t = String(text || "").trim();
  if (!t || /[\r\n]/.test(t)) return false;            // multi-line = a message
  const first = t.split(/\s+/)[0].toLowerCase();
  if (/^[.\\/]|^[a-z]:[\\/]|\.(exe|bat|cmd|ps1|py|js)$/i.test(first)) return true; // a path or script
  if (KNOWN_COMMANDS.has(first.replace(/\.exe$/, ""))) return true;
  return false;
}
function wireComposeCommands() {
  const box = el("composer-text");
  if (!box) return;
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    const text = box.value.trim();
    if (!text) return;
    const force = e.ctrlKey || e.metaKey;
    e.preventDefault();
    const answering = termUI.running && text.length <= 20; // e.g. "y" to a running command's prompt
    if (!force && !answering && !looksLikeCommand(text)) {
      setStatus("That looks like a message — click an AI's name to send it. (Ctrl+Enter runs it as a command anyway; Shift+Enter = new line.)");
      return;
    }
    if (/[\r\n]/.test(text)) { setStatus("Commands are one line — remove the line breaks, or click an AI's name to send it as a message."); return; }
    box.value = "";
    try { updateCharCount(); } catch (_) {}
    if (el("tab-terminal")) el("tab-terminal").click();   // show where the output lands
    if (el("term-input")) box.focus();                     // keep typing in Compose
    setStatus(`Running: ${text}`);
    if (termUI.history[termUI.history.length - 1] !== text) termUI.history.push(text);
    termSubmit(text).then(() => setStatus("Ready.")).catch(() => {});
  });
}
try { wireComposeCommands(); } catch (e) { console.error("compose command init failed", e); }
try { wireLockers(); } catch (e) { console.error("locker browser init failed", e); }

// ---- 🔬 Feature Test button: run / stop, live progress, results pop-up ----
let featureTestRunning = false;
function wireFeatureTest() {
  const btn = el("btn-feature-test");
  if (!btn || typeof window.api.runFeatureTest !== "function") return;
  const idleText = btn.textContent;
  if (typeof window.api.onFeatureTestProgress === "function") {
    window.api.onFeatureTestProgress((p) => {
      if (!p || !featureTestRunning) return;
      if (p.status === "running") {
        btn.textContent = `■ Stop test ${p.index + 1}/${p.total}`;
        setStatus(`Feature test ${p.index + 1}/${p.total}: ${SITE_LABELS[p.site] || p.site} — ${p.step}…`);
      } else if (p.status === "pass" || p.status === "fail" || p.status === "skip") {
        const icon = p.status === "pass" ? "✅" : p.status === "fail" ? "❌" : "⚪";
        logToCenter(`🔬 ${icon} ${SITE_LABELS[p.site] || p.site} — ${p.step}${p.detail ? `: ${p.detail}` : ""}`, { tag: "roundtable", err: p.status === "fail" });
      }
    });
  }
  btn.onclick = async () => {
    if (featureTestRunning) {
      btn.textContent = "Stopping…";
      try { await window.api.stopFeatureTest(); } catch (_) {}
      return;
    }
    if (!window.confirm("Run the Feature Test?\n\nEach Active AI gets about 8 short test messages, one at a time (a few minutes per AI). It writes test files into their lockers and briefly turns off Auto forwarding while it runs (restored after). Click the button again to stop.")) return;
    featureTestRunning = true;
    btn.classList.add("danger");
    btn.textContent = "■ Stop test";
    logToCenter("🔬 Feature test started — each AI gets one test at a time; results land here and in a pop-up.", { tag: "roundtable" });
    let r;
    try { r = await window.api.runFeatureTest(); } catch (e) { r = { ok: false, error: String(e) }; }
    featureTestRunning = false;
    btn.classList.remove("danger");
    btn.textContent = idleText;
    if (!r || !r.ok) {
      setStatus(`Feature test couldn't run: ${(r && r.error) || "error"}`);
      logToCenter(`🔬 Feature test couldn't run: ${(r && r.error) || "error"}`, { tag: "roundtable", err: true });
      return;
    }
    const skipped = r.total - r.okCount - r.failCount;
    const summary = `🔬 Feature test ${r.stopped ? "stopped" : "done"} — ${r.okCount}/${r.total} passed${r.failCount ? `, ${r.failCount} failed` : ""}${skipped ? `, ${skipped} skipped` : ""}.${r.report ? ` Report: ${r.report}` : ""}`;
    logToCenter(summary, { tag: "roundtable", err: r.failCount > 0 });
    setStatus(summary);
    openCapModal({ checks: r.checks, okCount: r.okCount, failCount: r.failCount, total: r.total });
    const title = el("cap-modal-title");
    if (title) title.textContent = "🔬 Feature test results";
    const sub = el("cap-modal-sub");
    if (sub) sub.textContent = `${r.okCount}/${r.total} features worked${r.failCount ? `, ${r.failCount} not working` : ""}${skipped ? `, ${skipped} skipped` : ""}. Full report (incl. how each AI's replies really end): ${r.report || "not saved"}`;
  };
}
try { wireFeatureTest(); } catch (e) { console.error("feature test init failed", e); }
