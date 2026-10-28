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
let butlerActive = false; // whether → All also includes 🎩 Alfred (his Active checkbox; id p-butler kept)
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
// P38 🎯 picker card: the three things the user can point at (one at a time).
const PICK_ROLE_NAME = { input: "Message box", send: "Send button", assistant: "AI's reply", image: "Generated picture" };
const PICK_ROLE_HINT = { input: "where you type", send: "", assistant: "pick the latest answer", image: "a picture ChatGPT made — for 🎨 ChatGPT images" };
const PICK_ROLE_TARGET_DESC = { input: "the message box (where you type)", send: "the Send button", assistant: "the AI's latest reply", image: "a picture ChatGPT made" };
// 🎨 ChatGPT also has a "Generated picture" item (chatgpt-image.js reads its pictures with it).
const pickRolesFor = (site) => (site === "chatgpt" ? PICK_ROLES.concat(["image"]) : PICK_ROLES);

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

// --- P38 🎯 picker: "What do you want to point at?" ---------------------------------
// Clicking 🎯 opens a small card (not a modal dialog — the AI's window must stay
// clickable): choose ONE of Message box / Send button / AI's reply, press OK, then
// click that thing in the AI's window (a banner there says what to click; hovering
// outlines it). Each item has a chip — blue "Not set", green "Picked" (with a short
// preview, not saved yet), green "✓ Saved", red "⚠️ Saved but not found" — and its
// own Clear and Save: any ONE item can be saved at any time. "Test it" sends a
// check-in; "🔢 Do it for me with a number" starts the number teach.
const pickerUi = {}; // site -> { role (radio choice), status (main's picker:status), busy, msg, tone }
function pickerState(site) { return pickerUi[site] || (pickerUi[site] = { role: null, status: null, busy: null, msg: "", tone: null }); }
function pickTime(ts) { try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; } }
function pickChip(item) {
  const st = (item && item.state) || "none";
  if (item && item.picking) return { st: "picking", text: "Click it in the AI's window…" };
  if (st === "picked") return { st, text: `Picked: ${item.preview || "found"}${item.latest === false ? " (not the latest answer)" : ""}` };
  if (st === "saved") return { st, text: `✓ Saved${item.savedAt ? ` ${pickTime(item.savedAt)}` : ""}${item.how === "number" ? " (🔢)" : ""}` };
  if (st === "stale") return { st, text: "⚠️ Saved — not found on the page now" };
  return { st: "none", text: "Not set" };
}
function togglePickMenu(site) {
  const menu = el(`pick-menu-${site}`);
  if (!menu) return;
  menu.classList.toggle("collapsed");
  if (!menu.classList.contains("collapsed")) refreshPicker(site);
}
// Open the card for one AI (also from the Akọwe panel's ⚠️), optionally with
// one item already chosen.
function openPicker(site, role) {
  const menu = el(`pick-menu-${site}`);
  if (!menu) return false;
  const col = el(`col-${site}`);
  if (col && !col.classList.contains("state-open")) { try { setColumnState(site, "open"); } catch (_) {} }
  menu.classList.remove("collapsed");
  if (role && pickRolesFor(site).includes(role)) pickerState(site).role = role;
  renderPicker(site);
  refreshPicker(site);
  try { menu.scrollIntoView({ block: "nearest" }); } catch (_) {}
  return true;
}
async function refreshPicker(site) {
  if (!window.api || !window.api.pickerStatus) return;
  try { const st = await window.api.pickerStatus(site); if (st && st.ok) { pickerState(site).status = st; renderPicker(site); } } catch (_) {}
}
function pickerSay(site, text, tone) { const ps = pickerState(site); ps.msg = text || ""; ps.tone = tone || null; const s = el(`pick-status-${site}`); if (s) { s.textContent = ps.msg; if (tone) s.dataset.tone = tone; else delete s.dataset.tone; } }
const PICK_REJECT = {
  WRONG_ELEMENT_TYPE: (d) => `that doesn't look like ${d} — try clicking right on it`,
  LOOKS_LIKE_USER: () => "that is your own message — click the AI's latest answer instead",
  LOOKS_LIKE_ECHO: () => "that looks like the last message sent, not a real reply — click the AI's answer",
  TOO_GENERIC: () => "that would match too many things on the page — click more precisely",
  TOO_SMALL: () => "that picture is too small (an icon or avatar) — click the big picture ChatGPT made",
  TOO_BROAD: () => "that matches too many things on the page — click the AI's answer text itself",
  NO_STABLE_SELECTOR: () => "AutoInjector couldn't find a reliable way to recognise it — try clicking a different part of it",
  ONLY_ONE_MESSAGE: () => "that only matches this one message, not every reply — try clicking the middle of the answer text",
  MISSES_PICK: () => "couldn't pin that down — try clicking the middle of the answer text",
  TIMEOUT: () => "no click in time — press OK and click again",
  CANCELLED: () => "cancelled",
  REPLACED: () => "cancelled",
  TEACHING: () => "a 🔢 number teach is running for this AI — finish or cancel it first",
  NO_VIEW: () => "the AI's window isn't open"
};
async function runPick(site, role) {
  const ps = pickerState(site);
  const desc = PICK_ROLE_TARGET_DESC[role];
  if (!role) { pickerSay(site, site === "chatgpt" ? "Choose one of the four first (Message box, Send button, AI's reply or Generated picture), then press OK." : "Choose one of the three first (Message box, Send button or AI's reply), then press OK.", "warn"); return; }
  ps.role = role; ps.busy = role;
  if (ps.status && ps.status.items && ps.status.items[role]) ps.status.items[role].picking = true;
  renderPicker(site);
  pickerSay(site, `Click ${desc} in ${SITE_LABELS[site]}'s window… (hovering outlines it · Esc or Cancel to stop)`);
  setStatus(`Waiting for a click in ${SITE_LABELS[site]}'s window to pick ${desc}…`);
  const res = window.api.pickerStart ? await window.api.pickerStart(site, role) : await window.api.pickSelector(site, role);
  ps.busy = null;
  if (res && res.ok) {
    pickerSay(site, `✓ ${PICK_ROLE_NAME[role]}: ${res.preview || "found"}. Press Save to lock it in (or Clear).`, "ok");
    setStatus(`${SITE_LABELS[site]}: picked ${desc} — press Save to keep it.`);
  } else {
    const f = PICK_REJECT[res && res.error];
    const reason = f ? f(desc) : `didn't catch a click (${(res && res.error) || "unknown"})`;
    pickerSay(site, `Not picked: ${reason}.`, res && (res.error === "CANCELLED" || res.error === "REPLACED") ? null : "err");
    setStatus(`${SITE_LABELS[site]}: pick ${res && res.error === "CANCELLED" ? "cancelled" : `failed (${(res && res.error) || "unknown"})`}.`);
  }
  await refreshPicker(site);
}
async function pickerSave(site, role) {
  const r = await window.api.pickerSave(site, role);
  if (r && r.ok) { pickerState(site).status = r; pickerSay(site, `✓ Saved ${PICK_ROLE_NAME[role]} for ${SITE_LABELS[site]} — press “Test it” to check it works.`, "ok"); }
  else pickerSay(site, r && r.error === "NOTHING_PICKED" ? `Nothing picked for ${PICK_ROLE_NAME[role]} yet — choose it, press OK and click it first.` : `Couldn't save (${(r && r.error) || "error"}).`, "err");
  renderPicker(site);
}
async function pickerClear(site, role) {
  const r = await window.api.pickerClear(site, role);
  if (r && r.ok) { pickerState(site).status = r; pickerSay(site, r.cleared === "draft" ? `Cleared the new pick for ${PICK_ROLE_NAME[role]}.` : `Cleared ${PICK_ROLE_NAME[role]} — back to AutoInjector's built-in way of finding it.`); }
  renderPicker(site);
}
async function pickerTest(site) {
  const ps = pickerState(site);
  ps.busy = "test"; renderPicker(site);
  pickerSay(site, `Sending ${SITE_LABELS[site]} a check-in (a tiny message)…`);
  const r = await window.api.pickerTest(site);
  ps.busy = null;
  if (r && r.ok) pickerSay(site, `✔ ${SITE_LABELS[site]} answered the check-in and AutoInjector read it — it works.`, "ok");
  else if (r && r.deferred) pickerSay(site, `${SITE_LABELS[site]} was busy — try “Test it” again in a moment.`, "warn");
  else pickerSay(site, r && r.error === "CHECKING" ? `${SITE_LABELS[site]} is being checked right now — try again in a moment.` : r && r.error === "TEACHING" ? "A 🔢 number teach is running — wait for it to finish." : r && r.error === "INACTIVE" ? `${SITE_LABELS[site]} isn't Active — tick it first.` : `✕ The check-in didn't work${r && r.say ? `: ${r.say}` : ""}`, "err");
  await refreshPicker(site);
}
async function pickerCancel(site) {
  if (window.api.pickerCancel) await window.api.pickerCancel(site);
  pickerState(site).busy = null;
  await refreshPicker(site);
}
// The number teach as the card (and the Akọwe panel's box) shows it.
const TEACH_PART_WORD = { input: "message box", send: "Send button", assistant: "reply area" };
function teachSteps(t, L) {
  const ph = String((t && t.phase) || "type");
  const order = ["type", "typed", "sent", "user_seen", "asking", "wait_reply", "done"];
  const at = order.indexOf(ph);
  const past = (p) => at >= order.indexOf(p);
  const fixed = t && t.result === "fixed";
  const lr = (t && t.learned) || {};
  return [
    { label: "You type the number", ok: past("typed") || !!lr.input || fixed, wait: ph === "type" },
    { label: "You press Send", ok: past("sent") || fixed, wait: ph === "typed" },
    { label: "Your message shows", ok: past("user_seen") || fixed, wait: ph === "sent" },
    { label: `AutoInjector asks ${L} to write it backwards`, ok: past("wait_reply") || fixed, wait: ph === "user_seen" || ph === "asking" },
    { label: `${L} writes ${t && t.reversed ? t.reversed : "it"} backwards`, ok: ph === "done" || !!lr.reply || fixed, wait: ph === "wait_reply" },
    { label: "Saved and checked", ok: fixed, wait: !!t && !t.active && !t.result }
  ];
}
function renderPicker(site, menuEl) {
  const menu = menuEl || el(`pick-menu-${site}`);
  if (!menu) return;
  const ps = pickerState(site);
  const st = ps.status || { items: {} };
  const L = SITE_LABELS[site];
  let body = menu.querySelector(".pk-body");
  if (!body) {
    menu.textContent = "";
    const head = document.createElement("div");
    head.className = "pk-head";
    head.innerHTML = `<span>🎯 What do you want to point at?</span><span class="pk-site"></span>`;
    head.querySelector(".pk-site").textContent = L;
    const x = document.createElement("button");
    x.type = "button"; x.className = "pk-x"; x.textContent = "✕"; x.title = "Close"; x.onclick = () => menu.classList.add("collapsed");
    head.appendChild(x);
    menu.appendChild(head);
    body = document.createElement("div");
    body.className = "pk-body";
    for (const role of pickRolesFor(site)) {
      const row = document.createElement("div");
      row.className = "pk-row"; row.dataset.role = role;
      const lab = document.createElement("label");
      lab.className = "pk-name";
      const radio = document.createElement("input");
      radio.type = "radio"; radio.name = `pk-role-${site}`; radio.value = role;
      radio.onchange = () => { pickerState(site).role = role; renderPicker(site); };
      const nm = document.createElement("span");
      nm.textContent = PICK_ROLE_NAME[role];
      lab.append(radio, nm);
      if (PICK_ROLE_HINT[role]) { const h = document.createElement("small"); h.textContent = `(${PICK_ROLE_HINT[role]})`; lab.appendChild(h); }
      const chip = document.createElement("span"); chip.className = "pk-chip";
      const clr = document.createElement("button"); clr.type = "button"; clr.className = "pk-clear"; clr.textContent = "Clear"; clr.onclick = () => pickerClear(site, role);
      const sv = document.createElement("button"); sv.type = "button"; sv.className = "pk-save"; sv.textContent = "Save"; sv.onclick = () => pickerSave(site, role);
      row.append(lab, chip, clr, sv);
      body.appendChild(row);
    }
    menu.appendChild(body);
    const acts = document.createElement("div");
    acts.className = "pk-actions";
    const mk = (cls, text, fn, tip) => { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = text; if (tip) b.title = tip; b.onclick = fn; acts.appendChild(b); return b; };
    mk("pk-ok", "OK — point at it", () => runPick(site, pickerState(site).role), "Then click the chosen thing in the AI's window");
    mk("pk-cancel", "Cancel", () => pickerCancel(site), "Stop pointing");
    mk("pk-number", "🔢 Do it for me with a number", () => pickerNumber(site), "You type a 4-digit number and press Send; AutoInjector learns all three by itself");
    mk("pk-test", "Test it", () => pickerTest(site), "Send a check-in (a tiny message) to confirm the AI works");
    const testBtn = mk("pk-roundtrip", "🧪 Test", () => runSelfTest(site), "Round-trip test: send a real test prompt, wait for the reply, and light up green/red");
    testBtn.classList.add("pk-more");
    menu.appendChild(acts);
    const status = document.createElement("div");
    status.className = "pick-status"; status.id = `pick-status-${site}`; status.setAttribute("aria-live", "polite");
    menu.appendChild(status);
    const teach = document.createElement("div");
    teach.className = "pk-teach"; teach.hidden = true;
    menu.appendChild(teach);
  }
  for (const role of pickRolesFor(site)) {
    const row = body.querySelector(`.pk-row[data-role="${role}"]`);
    const item = (st.items || {})[role] || { state: "none" };
    const c = pickChip(Object.assign({}, item, { picking: item.picking || ps.busy === role }));
    const chip = row.querySelector(".pk-chip");
    chip.dataset.st = c.st; chip.textContent = c.text; chip.title = c.text;
    row.classList.toggle("sel", ps.role === role);
    const radio = row.querySelector("input[type=radio]"); radio.checked = ps.role === role;
    row.querySelector(".pk-save").disabled = item.state !== "picked";
    row.querySelector(".pk-clear").disabled = item.state === "none" && !item.picking;
  }
  const busy = !!ps.busy;
  const teaching = !!(st.repair && st.repair.teach && st.repair.teach.active);
  const okb = menu.querySelector(".pk-ok"); if (okb) okb.disabled = busy || teaching;
  const cb = menu.querySelector(".pk-cancel"); if (cb) cb.hidden = !(ps.busy && ps.busy !== "test");
  const nb = menu.querySelector(".pk-number"); if (nb) nb.disabled = busy || teaching;
  const tb = menu.querySelector(".pk-test"); if (tb) tb.disabled = busy || teaching;
  const sEl = menu.querySelector(".pick-status"); if (sEl && sEl.textContent !== ps.msg) { sEl.textContent = ps.msg; if (ps.tone) sEl.dataset.tone = ps.tone; else delete sEl.dataset.tone; }
  const tt = st.repair && st.repair.teach;
  if (tt && tt.result && /^🔢 Type /.test(ps.msg || "")) { ps.msg = ""; if (sEl) sEl.textContent = ""; }
  renderPickerTeach(site, menu.querySelector(".pk-teach"), tt);
}
function renderPickerTeach(site, box, t) {
  if (!box) return;
  const recent = t && (t.active || (t.result && t.result !== "cancelled" && Date.now() - (t.startedAt || 0) < 15 * 60000));
  if (!recent) { box.hidden = true; box.textContent = ""; return; }
  const L = SITE_LABELS[site];
  box.hidden = false;
  box.textContent = "";
  box.dataset.tone = t.result === "fixed" ? "ok" : t.result ? "err" : "";
  const h = document.createElement("div"); h.className = "pk-teach-title";
  const p = document.createElement("div"); p.className = "pk-teach-text";
  if (t.result === "fixed") { h.textContent = `✔ Saved — ${L} is working again.`; p.textContent = "The number teach learned the message box, the Send button and the reply area, saved them and a check-in worked."; }
  else if (t.result === "timeout") { h.textContent = "🔢 The number didn't show up in time"; p.textContent = `Nothing was changed. Press “🔢 Do it for me with a number” to try again — type the number exactly, then press Send.`; }
  else if (t.result) { const part = TEACH_PART_WORD[t.failedPart] || "reply area"; h.textContent = `🔢 The ${part} part didn't work`; p.textContent = `${t.saved && t.saved.length ? `Saved: ${t.saved.map((x) => TEACH_PART_WORD[x]).join(", ")}. ` : ""}Use 🎯 for just the ${part}: choose it above, press OK and click it in ${L}'s window.`; }
  else { h.textContent = `🔢 Type ${t.number} into ${L}'s message box and press Send`; p.textContent = "AutoInjector watches where the number appears, then asks the AI to write it backwards to find its replies."; }
  box.append(h, p);
  const ol = document.createElement("ol"); ol.className = "pk-teach-steps";
  for (const s of teachSteps(t, L)) { const li = document.createElement("li"); li.dataset.st = s.ok ? "ok" : s.wait ? "wait" : ""; li.textContent = `${s.ok ? "✔" : s.wait ? "…" : "○"} ${s.label}`; ol.appendChild(li); }
  if (!t.result || t.result === "fixed") box.appendChild(ol);
  const acts = document.createElement("div"); acts.className = "pk-actions";
  if (t.active) { const b = document.createElement("button"); b.type = "button"; b.textContent = "Cancel"; b.onclick = async () => { await window.api.selfRepairTeachCancel(site); pickerSay(site, `Cancelled — nothing was changed for ${L}.`); refreshPicker(site); }; acts.appendChild(b); }
  else if (t.result && t.result !== "fixed" && t.failedPart && PICK_ROLES.includes(t.failedPart)) { const b = document.createElement("button"); b.type = "button"; b.className = "pk-ok"; b.textContent = `🎯 Point at the ${TEACH_PART_WORD[t.failedPart]}`; b.onclick = () => { pickerState(site).role = t.failedPart; renderPicker(site); runPick(site, t.failedPart); }; acts.appendChild(b); }
  if (acts.children.length) box.appendChild(acts);
}
async function pickerNumber(site) {
  if (!window.api.selfRepairTeachStart) return;
  const r = await window.api.selfRepairTeachStart(site);
  if (r && r.ok) pickerSay(site, `🔢 Type ${r.number} into ${SITE_LABELS[site]}'s message box and press Send.`);
  else pickerSay(site, r && r.error === "INACTIVE" ? `${SITE_LABELS[site]} isn't Active — tick it first.` : r && r.error === "CHECKING" ? `AutoInjector is checking ${SITE_LABELS[site]} right now — try again in a moment.` : `Couldn't start (${(r && r.error) || "error"}).`, "err");
  await refreshPicker(site);
}
// Old entry point kept for the Akọwe panel's buttons and older callers.
async function clearPickOverrides(site) {
  for (const role of PICK_ROLES) await window.api.clearSelectorOverride(site, role);
  pickerSay(site, "Overrides cleared — back to the built-in selectors.");
  setStatus(`${SITE_LABELS[site]}: selector overrides cleared.`);
  refreshPicker(site);
}
// the number teach's progress also shows on the pane's 🎯 card
if (window.api && window.api.onSelfRepair) window.api.onSelfRepair((p) => { try { if (!p || !p.site || !pickerUi[p.site]) return; const ps = pickerState(p.site); ps.status = Object.assign({ items: {} }, ps.status || {}, { repair: p.repair }); renderPicker(p.site); } catch (_) {} });
if (window.api && window.api.onPicker) window.api.onPicker((st) => { try { if (st && st.ok && st.site) { const ps = pickerState(st.site); ps.status = st; if (!st.picking && ps.busy && ps.busy !== "test") ps.busy = null; renderPicker(st.site); } } catch (_) {} });

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
  setTestLed(site, "pending");
  pickerSay(site, `Testing ${SITE_LABELS[site]}: sent a prompt, waiting for it to reply back…`);
  setStatus(`Testing ${SITE_LABELS[site]}'s connection — this can take up to 45s…`);
  const res = await window.api.runSelfTest(site);
  if (res?.ok) {
    setTestLed(site, "ok");
    pickerSay(site, `✅ ${SITE_LABELS[site]} is hooked up correctly — it replied with exactly what was asked.`);
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
    pickerSay(site, `❌ ${SITE_LABELS[site]}: ${reason}`);
    setStatus(`${SITE_LABELS[site]}: connectivity test failed — ${res?.error || "error"}.`);
  }
}

// TR-07: the light next to each AI's name is its LIVE health, not just "page
// loaded": green = last message delivered and its reply captured; amber =
// waiting for a reply, or a send that couldn't be proven; red = send failed or
// no reply for minutes (hover for the reason). Grey until something is sent.
const HEALTH_COLOR = { idle: "#666", ok: "#29c447", waiting: "#f5b642", warn: "#f5b642", stalled: "#e5484d", error: "#e5484d" };
const paneHealthState = {};
const paneLoaded = {};
function paintLed(site) {
  const node = document.getElementById(`led-${site}`);
  if (!node) return;
  const h = paneHealthState[site];
  if (!paneLoaded[site] && (!h || h.level === "idle")) { node.style.background = "#333"; node.title = "Page not loaded"; return; }
  if (!h || h.level === "idle") { node.style.background = HEALTH_COLOR.idle; node.title = "Page loaded — nothing sent yet"; return; }
  node.style.background = HEALTH_COLOR[h.level] || "#666";
  node.title = h.text || h.level;
}
function led(site, ok) { paneLoaded[site] = !!ok; paintLed(site); }
// Click a light to re-run the read-only page check for that AI (TR-08).
function wireLedChecks() {
  for (const site of SITES) {
    const node = document.getElementById(`led-${site}`);
    if (!node || node._checkWired || !window.api.healthCheck) continue;
    node._checkWired = true;
    node.style.cursor = "pointer";
    node.addEventListener("click", async (e) => {
      e.stopPropagation();
      setStatus(`Checking ${SITE_LABELS[site]}'s page…`);
      try {
        const r = await window.api.healthCheck(site);
        const h = r && r.health && r.health[site];
        setStatus(`${SITE_LABELS[site]}: ${h ? h.text : "check finished"}`);
      } catch (_) { setStatus(`${SITE_LABELS[site]}: check failed`); }
    });
  }
}
if (window.api.onPaneHealth) window.api.onPaneHealth((snap) => {
  if (!snap) return;
  for (const site of Object.keys(snap)) { paneHealthState[site] = snap[site]; paintLed(site); }
});

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
  // 🎩 Alfred is a fourth participant row — same shape as an AI: a → send
  // button in the Send column and his own Active checkbox in the Active column.
  // (The ids are the old butler's, kept so everything that finds them still does.)
  const butler = document.createElement("button");
  butler.id = "btn-send-butler";
  butler.textContent = "→ 🎩 Alfred";
  butler.title = "Send this message to 🎩 Alfred — his side panel opens and he answers there (he asks before he changes anything)";
  butler.setAttribute("aria-label", "Send this message to Alfred");
  butler.onclick = () => sendToAlfred();
  grid.appendChild(butler);

  const butlerChk = document.createElement("input");
  butlerChk.type = "checkbox";
  butlerChk.id = "p-butler";
  butlerChk.checked = butlerActive;
  butlerChk.title = "Include 🎩 Alfred when you press → All";
  butlerChk.setAttribute("aria-label", "Alfred active");
  butlerChk.onchange = (e) => { butlerActive = e.target.checked; };
  grid.appendChild(butlerChk);

  // → All: send to every checked AI, plus Alfred when his box is checked.
  const all = document.createElement("button");
  all.className = "primary";
  all.textContent = "→ All";
  all.onclick = () => { const text = el("composer-text").value.trim(); sendCompose(SITES.filter((s) => enabled[s])); if (butlerActive) sendToAlfred(text); };
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
  const b = el("legacy-butler-mode"); if (!b) return; // the old butler's toggle is gone; #btn-butler-mode is Alfred's (below)
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
if (el("legacy-butler-mode")) {
  renderButlerMode();
  el("legacy-butler-mode").onclick = () => {
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
  head.innerHTML = `<span class="led" id="led-${site}" title="Page not loaded"></span><span class="gendot" id="gendot-${site}"></span><span class="pane-name">${SITE_LABELS[site]}</span><span class="role-badge" id="role-badge-${site}"></span><span class="test-led" id="test-led-${site}" title="Connectivity test: not run yet"></span><span class="spacer"></span>`;
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
  pickBtn.title = "Point at the message box, the Send button or the AI's reply in this window (no DevTools needed)";
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
  pickMenu.className = "pick-menu picker-card collapsed";
  pickMenu.id = `pick-menu-${site}`;
  pickMenu.setAttribute("role", "region");
  pickMenu.setAttribute("aria-label", `Point at things in ${SITE_LABELS[site]}'s window`);
  renderPicker(site, pickMenu);
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
  try { wireLedChecks(); } catch (_) {}
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
      ? "Auto is ON — enabled participants forward replies to each other (replies addressed to you stay with you)."
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
// Plain-language versions of the send errors people actually see.
const SEND_ERROR_TEXT = {
  SEND_NOT_CONFIRMED: "the message is still sitting in its box — the Send button didn't work",
  SEND_UNVERIFIED: "the box cleared but the message never showed up in the chat",
  INPUT_NOT_FOUND: "couldn't find its message box — is it signed in and on a chat page?",
  AI_BUSY: "it was still writing its last reply for 5 minutes, so the new message couldn't go in",
  NO_VIEW: "its pane isn't open",
};
window.api.onSendError(({ target, error }) => {
  setStatus(`Error sending to ${SITE_LABELS[target] || target}: ${SEND_ERROR_TEXT[error] || error}`);
});
// TR-14: Bucket Brigade progress on the status line (started from the Tools menu).
if (window.api.onBrigadeProgress) window.api.onBrigadeProgress((p) => {
  if (!p) return;
  const L = (s) => SITE_LABELS[s] || s;
  if (p.status === "start") setStatus(`Relay check started (${(p.sites || []).map(L).join(" → ")}). Auto is paused until it finishes.`);
  else if (p.status === "setup") setStatus(`Relay check: explaining the rules to ${L(p.site)}…`);
  else if (p.status === "hop") setStatus(`Relay check: step ${p.index} of ${p.of} — waiting for ${L(p.site)} to add ${p.item}…`);
  else if (p.status === "hop-problem") setStatus(`Relay check: problem at ${p.item} (${L(p.site)}): ${p.detail || "see the report"}`);
  else if (p.status === "done") setStatus(p.ok ? `Relay check finished — app ${p.appPass ? "PASSED" : "FAILED"}${p.finished ? "" : " (did not finish)"}. The report has opened.` : `Relay check couldn't run: ${p.error || "error"}`);
});
// TR-06: too many AI-to-AI hand-offs in a row — relaying paused until I act.
if (window.api.onRelayPaused) window.api.onRelayPaused((p) => {
  if (!p) return;
  setStatus(`Auto paused after ${p.max} AI-to-AI hand-offs — send a message or click Auto to continue.`);
  if (el("mesh-status")) el("mesh-status").textContent = `Auto PAUSED — ${p.max} hand-offs in a row without you. Send a message or click Auto to continue.`;
  try { logToCenter(p.text, { tag: "routing", err: true }); } catch (_) {}
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
  document.body.classList.toggle("window-collapsed", collapsed);
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
  gpu: { panelId: "col-gpu", label: "GPU Usage" },
  systemai: { panelId: "col-systemai", label: "🎩 Butler" },
  akowe: { panelId: "col-akowe", label: "Akọwe bridge" }
};
function collapseYellowPanel(key) {
  const { panelId, label } = COLLAPSIBLE_PANELS[key];
  if (el(`tab-${key}`)) return; // already minimized: never add a second tab
  el(panelId).classList.add("hidden-collapsed");
  const tab = document.createElement("button");
  tab.id = `tab-${key}`;
  tab.title = `Expand ${label}`;
  tab.onclick = () => expandYellowPanel(key);
  if (key === "systemai") {
    // The 🎩 Butler section folds IN PLACE to its one-line header (it is never
    // hidden away in the top strip), with a plain "▸ Open" button on that line.
    tab.className = "primary";
    tab.textContent = "▸ Open";
    tab.onclick = () => setButlerFolded(false, true);
    tab.title = "Open the Butler section (Alfred's AI, personality, settings, activity)";
    const btn = el("btn-collapse-systemai");
    if (btn) {
      btn.before(tab);
      btn.textContent = "▸";
      btn.title = "Open the Butler section"; btn.setAttribute("aria-label", btn.title);
      btn.setAttribute("aria-expanded", "false");
    } else el("top-tab-strip").appendChild(tab);
  } else {
    tab.className = "collapsed-tab";
    tab.innerHTML = `<span class="tab-color"></span>${label}`;
    el("top-tab-strip").appendChild(tab);
  }
  uiLog("panel", { msg: `${label} panel minimized` });
}
function expandYellowPanel(key) {
  el(COLLAPSIBLE_PANELS[key].panelId).classList.remove("hidden-collapsed");
  el(`tab-${key}`)?.remove();
  if (key === "systemai" && el("btn-collapse-systemai")) {
    const btn = el("btn-collapse-systemai");
    btn.textContent = "⌄";
    btn.title = "Fold the Butler section to one line"; btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-expanded", "true");
  }
  uiLog("panel", { msg: `${COLLAPSIBLE_PANELS[key].label} panel restored` });
}
// 🎩 Butler section: fold/unfold (the ▾ button and the heading toggle it). The
// user's choice is remembered; with no choice yet it starts folded once Alfred's
// AI is set up (Ollama installed and his model downloaded), open until then.
const BUTLER_FOLD_KEY = "butler-folded";
let butlerFoldTouched = false;
function butlerFoldPref() { try { return window.localStorage.getItem(BUTLER_FOLD_KEY); } catch (_) { return null; } }
function setButlerFolded(on, save) {
  if (on) collapseYellowPanel("systemai"); else expandYellowPanel("systemai");
  if (save) {
    butlerFoldTouched = true;
    try { window.localStorage.setItem(BUTLER_FOLD_KEY, on ? "1" : "0"); } catch (_) {}
  }
}
function toggleButlerFolded() { setButlerFolded(!el("col-systemai").classList.contains("hidden-collapsed"), true); }
function butlerAiIsSetUp(st) {
  if (!st || !st.ok || !st.ollama || !st.ollama.installed) return false;
  const want = st.alfred && st.alfred.model;
  if (!want) return false;
  const key = (n) => String(n || "").trim().toLowerCase().replace(/:latest$/, "");
  return (st.models || []).some((m) => key(m && m.name) === key(want));
}
function initButlerFold() {
  const pref = butlerFoldPref();
  if (pref === "1") { setButlerFolded(true, false); return; }
  if (pref === "0") return;
  if (!window.api || typeof window.api.llmStatus !== "function") return;
  Promise.resolve(window.api.llmStatus()).then((st) => {
    if (!butlerFoldTouched && butlerAiIsSetUp(st)) setButlerFolded(true, false);
  }).catch(() => {});
}
// Make each utility panel's heading a second, larger click target for collapsing
// it — and keyboard-operable (Enter/Space), with a visible focus ring via CSS.
for (const key of Object.keys(COLLAPSIBLE_PANELS)) {
  const panel = el(COLLAPSIBLE_PANELS[key].panelId);
  const h2 = panel && panel.querySelector(".yc-head h2");
  if (!h2 || key === "akowe") continue; // Akọwe's heading folds it to its slim status bar instead (see bfSetCollapsed)
  h2.setAttribute("role", "button");
  h2.setAttribute("tabindex", "0");
  h2.title = "Minimize this panel to the top tab strip";
  const act = key === "systemai" ? toggleButlerFolded : () => collapseYellowPanel(key);
  if (key === "systemai") h2.title = "Fold or open the Butler section";
  h2.addEventListener("click", act);
  h2.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } });
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
if (el("btn-collapse-systemai")) el("btn-collapse-systemai").onclick = toggleButlerFolded;
try { initButlerFold(); } catch (_) {}
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
  "Video generation": "Set up a text-to-video backend (AnimateDiff / Stable Video Diffusion) with its API on, then enter its address in Setup Wizard → Video and press Check connection.",
  "Voice (speak)": "Make sure the voice service is running (Setup Wizard → Installs → Voice engine) and that its address in System AI → 🔊 Voice is right — press Test there to check.",
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

// A one-click fix offered next to a failed capability (main sends c.fix =
// { action, label }). Only known actions get a button.
const CAP_FIXES = {
  "voice:redownload": async () => {
    if (!window.api.voiceRedownload) return { ok: false, message: "Re-download isn't available in this version." };
    return window.api.voiceRedownload();
  },
};
function capFixButton(c) {
  const fix = c && c.fix;
  const run = fix && CAP_FIXES[fix.action];
  if (!run) return null;
  const b = document.createElement("button");
  b.className = "cap-fix-btn";
  b.dataset.fix = fix.action;
  b.textContent = `🔧 ${fix.label || "Fix it"}`;
  b.onclick = async () => {
    uiLog("click", { id: "cap-fix", msg: fix.action });
    b.disabled = true; const prev = b.textContent; b.textContent = "⏳ Working…";
    let r; try { r = await run(); } catch (e) { r = { ok: false, message: String(e) }; }
    b.disabled = false; b.textContent = r && r.ok ? "✅ Done" : prev;
    logToCenter((r && r.message) || (r && r.ok ? "Done." : `Couldn't fix it: ${(r && r.error) || "failed"}`), { tag: "setup", err: !(r && r.ok) });
  };
  return b;
}

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
      item.innerHTML = html;
      const fixBtn = capFixButton(c);
      if (fixBtn) item.appendChild(fixBtn);
      box.appendChild(item);
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
  const btns = ["btn-cap-run", "btn-selfcheck"].map(el).filter(Boolean);
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

if (el("btn-selfcheck")) el("btn-selfcheck").onclick = async () => {
  const deep = !!(el("cb-deep-check") && el("cb-deep-check").checked);
  // Deep mode: actually exercise every capability (streams to the Activity Log).
  if (deep) { await runCapabilityTest(el("btn-selfcheck")); return; }

  // Quick readiness check → each capability's status streams into the center log.
  if (!window.api.butlerSelfCheck) { logToCenter("System check unavailable.", { tag: "setup", err: true }); return; }
  logToCenter("🩺 System check…", { tag: "setup" });
  let r; try { r = await window.api.butlerSelfCheck(); } catch (_) { r = null; }
  if (!r || !r.ok) { logToCenter(`System check failed: ${(r && r.error) || "error"}`, { tag: "setup", err: true }); return; }
  // Three honest buckets: ✅ checked & working, ❌ turned on but not working,
  // ⚪ not set up (optional). Counted here so older results still render.
  const checks = Array.isArray(r.checks) ? r.checks : [];
  const nFail = checks.filter((c) => c.ok === false).length;
  const nNotSet = checks.filter((c) => c.ok !== true && c.ok !== false).length;
  const took = typeof r.elapsedMs === "number" ? ` (took ${(r.elapsedMs / 1000).toFixed(1)}s)` : "";
  logToCenter(`🩺 System check — ${r.okCount}/${r.total} working · ${nFail} need attention · ${nNotSet} not set up (optional)${took}.`, { tag: "setup" });
  for (const c of checks) {
    const mark = c.ok === true ? "✅" : c.ok === false ? "❌" : "⚪";
    logToCenter(`${mark} ${c.name}${c.detail ? " — " + c.detail : ""}`, { tag: "setup", err: c.ok === false });
  }
  if (Array.isArray(r.installs) && r.installs.length) {
    // Every add-on is optional: "not installed" is information, not an error.
    logToCenter(`Optional add-ons — ${(r.missing || []).length} not installed (Install Missing can add them):`, { tag: "setup" });
    for (const it of r.installs) {
      const mark = it.installed === true ? "✅ installed" : it.installed === false ? "⚪ not installed (optional)" : "⚪ couldn't tell";
      logToCenter(`   ${it.label}: ${mark}${it.detail ? " — " + it.detail : ""}`, { tag: "setup" });
    }
  }
  logToCenter("ℹ️ ✅ here means set up and answering. To actually exercise each one (render an image, run code, ping the AIs), run 🧪 Capability Test.", { tag: "setup" });
  if (el("btn-install-missing")) el("btn-install-missing").disabled = !r.canInstall;
  deviceSpeak(`System check: ${r.okCount} of ${r.total} working${nFail ? `, ${nFail} need attention` : ""}. ${(r.missing || []).length} optional add-ons not installed.`);
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
  logToCenter(r && r.error ? `Didn't catch that — ${voiceErrText(r)}` : "Didn't catch that.", { tag: "voice", err: !!(r && r.error) });
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

// The old Image Generation / Video Generation panels lived here. They are gone:
// pictures are made in the 🎨 Images tab (images-studio.js) and clips in the 🎬 Video
// tab (videos-studio.js). Their "point at another server" settings (preset list,
// auto-detect, reachability test, on/off) moved into each tab's ⚙ setup view under
// "Advanced: another server". The image:* / video:* / endpoints:* IPC stays for
// Alfred, the butler, Akọwe's bridge and the Setup Wizard.

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
// ISS-017: "✓ Saved" describes the endpoint/model as they were at Save time.
// Once either is edited it's no longer true, so don't leave it standing.
function lsiMarkUnsaved() {
  const m = el("lsi-msg");
  if (m && /^✓ Saved/.test(m.textContent)) m.textContent = "Unsaved changes — press “Save settings” (or Test).";
}
for (const id of ["lsi-endpoint", "lsi-model"]) {
  const f = el(id);
  if (f) { f.addEventListener("input", lsiMarkUnsaved); f.addEventListener("change", lsiMarkUnsaved); }
}
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
// The status light in the User Panel is 🎩 Alfred's: off / idle / working (glows) / needs you
// (a card is waiting). Clicking it opens his side panel (alfredTop below).
function setButlerLight(cls, text) {
  const b = el("btn-butler-status"); if (!b) return;
  b.classList.remove("working", "needs", "error", "off");
  if (cls) b.classList.add(cls);
  const t = b.querySelector(".txt"); if (t && text != null) t.textContent = text;
}

// ==== 🎩 Alfred in the User Panel ====================================================================
// The old butler's buttons up here are Alfred's now (same ids): "→ 🎩 Alfred" + his Active box, the status
// light, 🧠 what he thinks with (#btn-butler-mode), 🎩 Alfred: On/Off (#btn-ai-toggle, the same as the
// title-bar switch) and 🩺 Check Alfred (#btn-capability-test). His TALK panel is alfred-panel.js.
let alfredTop = null; // his last state ({ enabled, busy, card, settings })
const ALFRED_BRAINS = ["auto", "local", "api", "pane"];
const ALFRED_BRAIN_META = {
  auto:  { tx: "Auto",         cls: "mode-auto",     say: "Automatic — a local model, else the connected AI" },
  local: { tx: "Local",        cls: "mode-self",     say: "a local model on this PC (Ollama)" },
  api:   { tx: "Connected AI", cls: "mode-delegate", say: "the connected AI (manager / API)" },
  pane:  { tx: "Web AI",       cls: "mode-converse", say: "a web AI pane (ChatGPT, Claude or Gemini)" },
};
function paintAlfredTop(st) {
  if (st) alfredTop = st;
  const s = alfredTop || {};
  const on = !!s.enabled;
  if (!on) setButlerLight("off", "🎩 Alfred off");
  else if (s.card) setButlerLight("needs", "🎩 Alfred needs you — a card is waiting");
  else if (s.busy) setButlerLight("working", "🎩 Alfred working…");
  else setButlerLight("", "🎩 Alfred idle");
  const t = el("btn-ai-toggle");
  if (t) { t.classList.toggle("on", on); t.setAttribute("aria-checked", String(on)); t.textContent = `🎩 Alfred: ${on ? "On" : "Off"}`; }
  const m = el("btn-butler-mode");
  if (m) {
    const brain = (s.settings && ALFRED_BRAIN_META[s.settings.brain]) ? s.settings.brain : "auto";
    const meta = ALFRED_BRAIN_META[brain];
    m.classList.remove("mode-converse", "mode-auto", "mode-self", "mode-delegate");
    m.classList.add(meta.cls);
    m.dataset.brain = brain;
    const ic = m.querySelector(".mode-ic"); if (ic) ic.textContent = "🧠";
    const tx = m.querySelector(".mode-tx"); if (tx) tx.textContent = meta.tx;
  }
}
async function alfredRefresh() {
  if (typeof window.api.alfredStatus !== "function") return null;
  try { const st = await window.api.alfredStatus(); paintAlfredTop(st); return st; } catch (_) { return null; }
}
/** Turn him on (when he is off) and open his side panel. Returns his state, or null. */
async function alfredOpenPanel() {
  let st = alfredTop || await alfredRefresh();
  if (!st || !st.enabled) {
    if (typeof window.api.alfredSetEnabled !== "function") return null;
    try { st = await window.api.alfredSetEnabled(true); } catch (_) { st = null; }
    if (!st || !st.enabled) return null;
    paintAlfredTop(st);
  }
  if (typeof window.api.alfredPanelToggle === "function") { try { await window.api.alfredPanelToggle(true); } catch (_) {} }
  return st;
}
// "→ 🎩 Alfred": the composed message goes to Alfred; his side panel opens and he answers there.
async function sendToAlfred(preset) {
  const text = String(typeof preset === "string" ? preset : el("composer-text").value).trim();
  if (!text) { setStatus("Type a message first."); return; }
  if (typeof window.api.alfredAsk !== "function") { setStatus("🎩 Alfred isn't available in this build."); return; }
  uiLog("click", { id: "btn-send-butler", msg: "send to Alfred" });
  const wasOn = !!(alfredTop && alfredTop.enabled);
  const st = await alfredOpenPanel();
  if (!st) { setStatus("Couldn't turn 🎩 Alfred on — try the 🎩 switch at the top."); return; }
  if (st.card) { setStatus("🎩 Alfred is waiting for your answer on his card first (✔ Do it or ✖ No) — see his panel."); return; }
  if (st.busy) { setStatus("🎩 Alfred is still working — see his panel (■ Stop cancels)."); return; }
  setStatus(wasOn ? "Sent to 🎩 Alfred — he answers in his panel." : "Turned 🎩 Alfred on and sent him your message — he answers in his panel.");
  if (typeof preset !== "string") { el("composer-text").value = ""; if (typeof updateCharCount === "function") try { updateCharCount(); } catch (_) {} }
  let r = null;
  try { r = await window.api.alfredAsk(text); } catch (_) { r = null; }
  if (r && r.ok === false && r.message) setStatus(`🎩 ${r.message}`);
}
if (el("btn-butler-status")) el("btn-butler-status").onclick = async () => {
  uiLog("click", { id: "btn-butler-status", msg: "open Alfred" });
  const st = await alfredOpenPanel();
  if (!st) setStatus("🎩 Alfred isn't available — try the 🎩 switch at the top.");
};
if (el("btn-ai-toggle")) el("btn-ai-toggle").onclick = async () => {
  uiLog("click", { id: "btn-ai-toggle", msg: "Alfred on/off" });
  const sw = el("btn-alfred-switch");
  // the title-bar switch does the same (and its panel code builds / removes the drawer)
  if (sw && sw.dataset.alfredWired === "yes") { sw.click(); setTimeout(alfredRefresh, 60); return; }
  if (typeof window.api.alfredSetEnabled !== "function") { setStatus("🎩 Alfred isn't available in this build."); return; }
  try { paintAlfredTop(await window.api.alfredSetEnabled(!(alfredTop && alfredTop.enabled))); } catch (_) {}
};
if (el("btn-butler-mode")) el("btn-butler-mode").onclick = async () => {
  if (typeof window.api.alfredSettings !== "function") { setStatus("🎩 Alfred isn't available in this build."); return; }
  const cur = (alfredTop && alfredTop.settings && alfredTop.settings.brain) || el("btn-butler-mode").dataset.brain || "auto";
  const next = ALFRED_BRAINS[(ALFRED_BRAINS.indexOf(cur) + 1) % ALFRED_BRAINS.length];
  uiLog("click", { id: "btn-butler-mode", msg: `Alfred thinks with: ${next}` });
  let s = null;
  try { s = await window.api.alfredSettings({ brain: next }); } catch (_) { s = null; }
  const brain = (s && s.brain) || next;
  paintAlfredTop(Object.assign({}, alfredTop || {}, { settings: Object.assign({}, (alfredTop && alfredTop.settings) || {}, s || {}, { brain }) }));
  setStatus(`🧠 Alfred now thinks with ${ALFRED_BRAIN_META[brain].say}.${brain === "auto" ? "" : " Set it up in the 🎩 Butler section if it isn't ready."}`);
};
// 🩺 Check Alfred: his AI (llm:check) + the whole app (health:status) — no AI needed. With Alfred on, the
// result shows in his side panel (its 🩺 Check everything button); while he is off, in the Activity Log.
async function checkAlfredFromTop() {
  uiLog("click", { id: "btn-capability-test", msg: "check Alfred" });
  const panelBtn = el("alfred-a-check");
  if (alfredTop && alfredTop.enabled && panelBtn) {
    if (typeof window.api.alfredPanelToggle === "function") { try { await window.api.alfredPanelToggle(true); } catch (_) {} }
    panelBtn.click();
    setStatus("🩺 Checking — the result is in 🎩 Alfred's panel.");
    return;
  }
  const b = el("btn-capability-test"); if (b) b.disabled = true;
  logToCenter("🩺 Checking Alfred's AI and the whole app…", { tag: "setup" });
  try {
    let r = null;
    if (typeof window.api.llmCheck === "function") { try { r = await window.api.llmCheck(); } catch (_) { r = null; } }
    if (r && Array.isArray(r.rows)) {
      logToCenter(`🧠 His AI: ${r.summary || (r.ok ? "ready." : "something needs fixing.")}`, { tag: "setup", err: r.ok === false });
      for (const x of r.rows.slice(0, 10)) logToCenter(`  ${x.ok === true ? "✔" : x.ok === false ? "✖" : "⚠"} ${x.label}${x.detail ? ` — ${x.detail}` : ""}`, { tag: "setup", err: x.ok === false });
    } else logToCenter("🧠 His AI: the check isn't available in this build — use the 🎩 Butler section.", { tag: "setup" });
    let hs = null;
    if (typeof window.api.healthStatus === "function") { try { hs = await window.api.healthStatus({ fresh: true }); } catch (_) { hs = null; } }
    if (hs && Array.isArray(hs.problems)) {
      if (!hs.problems.length) logToCenter("🩺 The app: ✔ nothing wrong found.", { tag: "setup" });
      for (const p of hs.problems.slice(0, 8)) logToCenter(`  ${p.severity === "error" ? "✖" : "⚠"} ${p.text}${p.fix && p.fix.label ? ` — fix: ${p.fix.label} (in Alfred's panel)` : ""}`, { tag: "setup", err: p.severity === "error" });
    }
    setStatus(r && r.ok === false ? "🩺 Something needs fixing — see the Activity Log (⚡ Set up in the 🎩 Butler section)." : "🩺 Check done — see the Activity Log.");
  } finally { if (b) b.disabled = false; }
}
if (el("btn-capability-test")) el("btn-capability-test").onclick = () => { checkAlfredFromTop(); };
if (typeof window.api.onAlfred === "function") {
  window.api.onAlfred((p) => {
    if (!p) return;
    if (p.type === "state" && p.state) paintAlfredTop(p.state);
    else if (p.type === "card" || p.type === "message" || p.type === "activity") alfredRefresh();
  });
}
paintAlfredTop(null);
alfredRefresh();
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
  // (the User Panel status light is 🎩 Alfred's now — see alfredTop below)
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
  renderAwareness(m.awareness);
  renderPendingApproval(m);
});
// The butler chat/activity window, colour-coded by WHO is speaking:
//   • system  — muted grey (infra/config)
//   • butler  — his own reasoning/actions/status
//   • chatgpt/claude/gemini — each AI in its own colour (incl. AI↔AI)
//   • to-ME   — anything addressed to me (an AI's reply, or the butler asking me
//               something): its own bright colour AND 2× the size.
function appendButlerLine({ cls, who, text, max = 500 }) {
  const box = el("jarvis-log"); if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const row = document.createElement("div");
  row.className = "bl-line " + (cls || "bl-butler");
  const whoHtml = who ? `<span class="bl-who">${gpuEsc(who)}:</span> ` : "";
  const full = String(text == null ? "" : text);
  const body = max && full.length > max ? `${full.slice(0, max)}…` : full; // ISS-017: never cut silently
  row.innerHTML = `${whoHtml}${gpuEsc(body)}`;
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
    // ISS-017: this is his Converse reply to me -- show all of it, not 500 chars.
    appendButlerLine({ cls: "bl-tome", who: "🤵 Butler → You", text: e.summary, max: 0 });
  } else if (BUTLER_SYSTEM_CATEGORIES.has(e.category)) {
    appendButlerLine({ cls: "bl-system", who: "System", text: `${e.category}: ${e.summary || ""}` });
  } else {
    appendButlerLine({ cls: "bl-butler", who: "🤵 Butler", text: e.summary });
  }
});

// 🩺 Health watch (health-watch.js): one short line per problem — before it breaks something — and one
// when it's fixed, with its one-click fix as a small button (works whether or not 🎩 Alfred is on).
if (window.api.onHealth) window.api.onHealth((e) => {
  if (!e || !e.text) return;
  appendButlerLine({ cls: e.type === "fixed" ? "bl-butler" : "bl-system", who: "🩺 Health", text: e.text });
  const p = e.problem;
  const row = el("jarvis-log") && el("jarvis-log").lastElementChild;
  if (e.type !== "problem" || !p || !p.fix || !row || !window.api.healthFix) return;
  const b = document.createElement("button");
  b.type = "button"; b.className = "bl-fix"; b.dataset.code = p.code; b.textContent = p.fix.label || "Fix it";
  b.style.cssText = "margin-left:8px;font-size:11px;padding:1px 8px";
  b.onclick = async () => {
    b.disabled = true; const was = b.textContent; b.textContent = "…";
    let r = null; try { r = await window.api.healthFix(p.code); } catch (_) {}
    b.textContent = r && r.ok ? (r.fixed ? "✔ Fixed" : "✔ Done") : `${was} — ${(r && (r.message || r.error)) || "didn't work"}`.slice(0, 120);
    b.disabled = !!(r && r.ok);
  };
  row.appendChild(b);
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
    const n = el("jarvis-tools-count"); if (n) n.textContent = tools.length ? `(${tools.length})` : "";
  } catch { /* leave default */ }
}
refreshToolsList();

// 🧰 Tool servers (MCP): the saved list, each with its status, Start / Stop / Remove and its tools.
// Everything a server says is shown as text (textContent), never as HTML. Secrets never come back from main.
let mcpPollTimer = null;
function mcpMsg(t, bad) { const m = el("mcp-msg"); if (m) { m.textContent = t || ""; m.style.color = bad ? "#e88" : ""; } }
function mcpEl(tag, text, css) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (css) e.style.cssText = css; return e; }
function renderMcpServers(servers) {
  const box = el("mcp-servers"); if (!box) return;
  box.textContent = "";
  if (!servers || !servers.length) { box.textContent = "None yet — nothing runs until you add one."; return; }
  for (const s of servers) {
    const row = mcpEl("div", null, "border:1px solid #333; border-radius:6px; padding:4px 6px; margin:3px 0;");
    row.className = "mcp-server"; row.dataset.id = s.id;
    const head = mcpEl("div", null, "display:flex; align-items:center; gap:6px; flex-wrap:wrap;");
    const dot = s.status === "connected" ? "🟢" : s.status === "starting" ? "🟡" : s.status === "error" ? "🔴" : "⚪";
    head.appendChild(mcpEl("b", `${dot} ${s.name}`));
    const sum = mcpEl("span", s.status === "error" ? "not working" : s.summary, "opacity:.85;"); sum.className = "mcp-summary"; head.appendChild(sum);
    const btns = mcpEl("span", null, "margin-left:auto; display:flex; gap:4px;");
    const mk = (label, cls, fn) => { const b = mcpEl("button", label); b.className = `mini ${cls || ""}`; b.onclick = async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; refreshMcpServers(); refreshToolsList(); } }; btns.appendChild(b); return b; };
    if (s.status === "connected" || s.status === "starting") mk("■ Stop", "", async () => { const r = await window.api.mcpStop(s.id); mcpMsg(r && r.message, !(r && r.ok)); });
    else mk("▶ Start", "primary", async () => { mcpMsg(`Starting “${s.name}”… (the first start can take a minute while it downloads)`); const r = await window.api.mcpStart(s.id); mcpMsg(r && r.message, !(r && r.ok)); });
    mk("✖ Remove", "danger", async () => { if (!window.confirm(`Remove the tool server “${s.name}”? Its saved keys are deleted too.`)) return; const r = await window.api.mcpRemove(s.id); mcpMsg(r && r.message, !(r && r.ok)); });
    head.appendChild(btns);
    row.appendChild(head);
    const kind = s.transport === "http" ? "web address" : "program on this computer";
    const keys = [...(s.envKeys || []), ...(s.headerKeys || [])];
    row.appendChild(mcpEl("div", `${kind}: ${s.target}${keys.length ? ` · keys: ${keys.join(", ")} (hidden)` : ""}`, "font-size:10.5px; opacity:.65; word-break:break-all;"));
    if (s.secretsNotSaved) row.appendChild(mcpEl("div", "This PC can't store keys encrypted, so its keys are kept only until AutoInjector closes.", "font-size:11px; color:#e0a24a;"));
    if (s.status === "error" && s.message) {
      const err = mcpEl("div", s.message, "font-size:11px; color:#e88; margin-top:2px;"); err.className = "mcp-error"; row.appendChild(err);
    }
    if (s.tools && s.tools.length) {
      const d = mcpEl("details", null, "margin-top:2px;");
      d.appendChild(mcpEl("summary", `${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}`, "font-size:11px; cursor:pointer;"));
      const ul = mcpEl("div", null, "font-size:11px; opacity:.85; white-space:pre-wrap;");
      ul.className = "mcp-tools";
      ul.textContent = s.tools.map((t) => `• ${t.name}${t.description ? ` — ${String(t.description).split("\n")[0].slice(0, 200)}` : ""}`).join("\n");
      d.appendChild(ul);
      row.appendChild(d);
    }
    box.appendChild(row);
  }
}
async function refreshMcpServers() {
  if (!window.api.mcpList) return;
  let r = null; try { r = await window.api.mcpList(); } catch (_) { r = null; }
  if (!r || !r.ok) return;
  renderMcpServers(r.servers || []);
  clearTimeout(mcpPollTimer);
  const sec = el("tools-sec");
  if (sec && sec.open && (r.servers || []).some((s) => s.status === "starting")) mcpPollTimer = setTimeout(refreshMcpServers, 2000);
}
if (el("tools-sec")) el("tools-sec").addEventListener("toggle", () => { if (el("tools-sec").open) { refreshMcpServers(); refreshToolsList(); } });
if (el("btn-mcp-add")) el("btn-mcp-add").onclick = async () => {
  const name = (el("mcp-name").value || "").trim();
  const line = (el("mcp-line").value || "").trim();
  if (!name || !line) { mcpMsg("Give it a short name and the command line (or web address) that starts it.", true); return; }
  const b = el("btn-mcp-add"); b.disabled = true;
  mcpMsg(`Adding “${name}” and starting it… (the first start can take a minute while it downloads)`);
  let r = null;
  try { r = await window.api.mcpAdd({ name, line, secrets: el("mcp-secrets").value || "" }); } catch (_) { r = null; }
  b.disabled = false;
  mcpMsg((r && r.message) || "That didn't work.", !(r && r.ok));
  if (r && (r.ok || r.added)) { el("mcp-name").value = ""; el("mcp-line").value = ""; el("mcp-secrets").value = ""; }
  refreshMcpServers(); refreshToolsList();
};
refreshMcpServers();

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
// OP-12: prefer the plain-language message (which address, what's wrong, how to
// fix it) over a raw code like ECONNREFUSED.
function voiceErrText(r) { return (r && (r.message || r.error)) || "error"; }
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
    voiceMsg(r && r.ok ? `Spoke as ${who} ✓` : `Voice test failed: ${voiceErrText(r)}`);
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
  // Cheap check first: is anything answering at the voice address?
  if (window.api.voiceCheck) {
    voiceMsg("Checking the voice service…");
    let c; try { c = await window.api.voiceCheck(); } catch (_) { c = null; }
    if (!c || !c.ok) { voiceMsg(`Voice test failed: ${voiceErrText(c)}`); return; }
  }
  voiceMsg("Speaking a test line…");
  const r = await window.api.voiceSpeak("AutoInjector voice is working.");
  voiceMsg(r && r.ok ? "Spoke a test line ✓" : `Voice test failed: ${voiceErrText(r)}`);
};
if (el("btn-mic")) el("btn-mic").onclick = async () => {
  if (!window.api.voiceListen) return;
  voiceMsg("Listening…");
  const r = await window.api.voiceListen({});
  if (r && r.ok && r.text) {
    if (el("jarvis-goal")) el("jarvis-goal").value = r.text;
    voiceMsg(`Heard: "${String(r.text).slice(0, 60)}" — press Start Butler.`);
  } else {
    voiceMsg(`Couldn't hear you: ${voiceErrText(r)}`);
  }
};

// User Panel: 🧙 Setup -> open the Setup Wizard window (downloads run in bg).
if (el("btn-open-wizard")) el("btn-open-wizard").onclick = () => { if (window.api.openWizard) window.api.openWizard(); };
// 🎨 Images / 🎬 Video buttons: switch the main window to that tab (the one place to make
// pictures and clips). Only if the tab script is missing do they fall back to the Setup Wizard.
if (el("btn-open-image")) el("btn-open-image").onclick = () => {
  if (typeof window.sdShowImagesTab === "function") window.sdShowImagesTab();
  else if (window.api.openWizard) window.api.openWizard("images");
};
if (el("btn-open-video")) el("btn-open-video").onclick = () => {
  if (typeof window.vdShowVideoTab === "function") window.vdShowVideoTab();
  else if (window.api.openWizard) window.api.openWizard("video");
};
// The Setup Wizard's "Open the Images / Video tab" buttons (wizard:open-app-tab) land here.
if (window.api.onAppTabShow) window.api.onAppTabShow((p) => { const b = p && p.tab && el(`tab-app-${p.tab}`); if (b) b.click(); });

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

// --- Akọwe panel ----------------------------------------------------------
// Loopback HTTP bridge that lets Akọwe drive these panes (main.js +
// akowe-bridge.js; contract v1.1 in docs/AKOWE_AUTOINJECTOR_BRIDGE.md).
// Compact layout, top to bottom:
//   header  — health dot · state pill · one-line "where it's at" · 🔗 Connect ·
//             Bridge switch · 📋 Copy diagnostics · ⓘ · ▾/▸ (collapse to a slim bar)
//   line    — what Connect is doing + the next step
//   strip   — the three AIs side by side | the connection check as status chips
//             (the full list opens on click, or by itself when something fails;
//             🧪 Test the connection — the real link test — ticks the same rows)
//   pair    — "Now working on" (step, state, approvals) | "Book checklist"
//             (k/n bar + a stepper of chips with module-set letter badges)
//   footer  — activity log, other ways to connect (key by hand), cautions — folded
// Problems are shown WHERE they are: a ⚠️ marker on the exact element; clicking
// it explains where / what / how to fix and offers 🔁 Try again when possible.
// All codes map to plain words in BF_CODES (one table). The key is copied by the
// main process; it only reaches this page when the user explicitly clicks "Show".
const BF_SITES = ["chatgpt", "claude", "gemini"];
const BF_LABEL = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };
const BF_STALE_MS = 90000;
// Module-set letter badges (Akọwe sets A–K). 11 hues picked to stay apart from
// each other and readable with dark text (#0b0b10, contrast ≥ 4.5:1 on every one).
// Akọwe can reuse exactly these so a letter has the same colour in both apps:
//   A #f87171 coral   B #fb923c orange  C #fbbf24 amber   D #a3e635 lime
//   E #34d399 emerald F #22d3ee cyan    G #60a5fa blue    H #818cf8 indigo
//   I #c084fc violet  J #f472b6 pink    K #a8a29e stone   (anything else: K's stone)
const BF_SET_COLORS = { A: "#f87171", B: "#fb923c", C: "#fbbf24", D: "#a3e635", E: "#34d399", F: "#22d3ee", G: "#60a5fa", H: "#818cf8", I: "#c084fc", J: "#f472b6", K: "#a8a29e" };
function bfSetColor(set) { const k = String(set || "").trim().replace(/^set\s*/i, "").charAt(0).toUpperCase(); return BF_SET_COLORS[k] || BF_SET_COLORS.K; }
function bfSetLetter(set) { const k = String(set || "").trim().replace(/^set\s*/i, ""); return (k.charAt(0) || "?").toUpperCase(); }
const bfStore = {
  get(k) { try { return window.localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { if (v == null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch (_) {} }
};
const bf = { snap: null, at: 0, starting: false, connecting: false, startingApp: false, localMsg: null,
  test: { running: false, results: new Map(), report: null },
  actionProblems: new Map(), // action id -> { code, opts } from a failed button / IPC call (cleared when it works)
  uiError: null,             // last unexpected error inside this panel (global handler)
  problems: [], checksOpen: null, checksSig: "", bookOpen: false, collapsed: false };
const BF_EMPTY_SNAP = { ok: true, enabled: false, listening: false, sites: {}, activity: [], port: 17891 };
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
function bfNode(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function bfSetText(n, t) { if (n && n.textContent !== t) n.textContent = t; }
// Keyed list update: keeps each child element (and the ⚠️ marker / focus inside it)
// instead of rebuilding the list every second.
function bfKeyed(box, items, keyOf, create, update) {
  if (!box) return;
  const old = new Map();
  for (const c of Array.from(box.children)) { if (c.dataset && c.dataset.key != null) old.set(c.dataset.key, c); else c.remove(); }
  let i = 0;
  for (const it of items) {
    const k = String(keyOf(it));
    let n = old.get(k);
    if (n) old.delete(k); else { n = create(it); n.dataset.key = k; }
    update(n, it);
    if (box.children[i] !== n) box.insertBefore(n, box.children[i] || null);
    i++;
  }
  for (const n of old.values()) n.remove();
}

// Plain-English explanations behind every ⓘ.
const BF_INFO = {
  what: ["Akọwe & your AIs", [
    "Akọwe is the book-writing app on this computer. This panel lets Akọwe hand questions to ChatGPT, Claude or Gemini in the windows of this app and get the answers back — using your normal logins, so there are no API keys and no extra bills.",
    "🔗 Connect Akọwe does everything in one click: it turns the bridge on, checks Akọwe is running, opens Akọwe in your browser and hands it the connection key privately. You don't copy or paste anything.",
    "The coloured dot is the overall health: green = all good, amber = not connected yet / waiting, ⚠️ = something needs fixing (look for the ⚠️ marker), grey = bridge off. ▾ folds the panel into a slim one-line bar. 📋 copies a safe summary for asking for help.",
    "It only works on this computer (nothing on the internet can reach it), and only while the bridge is on."]],
  key: ["What is the connection key?", [
    "It's like a password that lets only your Akọwe talk to this app. Connect Akọwe hands it over for you, so normally you never see it.",
    "It never leaves your computer and is never shown in logs, reports or diagnostics, and it is never put in a web address. If anything tries to connect without it, it's refused — you'll see that in the Activity log."]],
  buttons: ["Copy, Show, and Make a new key", [
    "📋 Copy connection key — puts the key on your clipboard. Then in Akọwe open Settings → Connect AutoInjector and paste it (Ctrl+V).",
    "Show key — shows the key on screen, in case you'd rather type it. Click Hide key when you're done.",
    "Make a new key — throws the old key away and makes a new one. Akọwe is disconnected until it gets the new key (press Connect Akọwe again). Only do this if you think someone else has seen your key."]],
  ais: ["What do the AI statuses mean?", [
    "Ready — the window is loaded and its message box is on the page; Akọwe can use it.",
    "Not loaded / Didn't load — the window is missing, still loading, or its page failed to load. Open it and wait until the page has finished loading. A ⚠️ marker offers 🔁 Reload.",
    "Signed out? / No message box — the page loaded but there is no message box: log in, or (if the site changed its page) use 🎯 to pick the box.",
    "Busy — it's answering an Akọwe question right now. Leave that window alone until it finishes.",
    "🔧 Repairing… — a check-in failed and AutoInjector is fixing it by itself (other known ways to find things, searching the page for the reply, reloading the window). Akọwe uses your other AIs meanwhile.",
    "⚠️ Needs you — only you can fix it (log in, the “are you human?” check, a usage limit) or AutoInjector asks you to point at something (🎯 / 🔢). Click the ⚠️ for exactly what to do; it re-checks by itself.",
    "✕ Not working — AutoInjector tried everything it can. Click the ⚠️ to see what was tried, then 🎯 point at the part that's wrong, 🔢 let it learn with a number, or reload. It re-checks by itself after 5, 15, then every 60 minutes.",
    "Check-ins: every so often (and when you press 🩺 Check now) AutoInjector sends each idle AI a tiny message — “Reply with only this word: …” — to make sure it still answers. Never while you're typing in it or it's busy, and never passed on to the other AIs.",
    "Not active — tick that AI as Active in this app if you want Akọwe to use it.",
    "Under each status you see the result of its last request and when it happened."]],
  test: ["The connection check", [
    "Each chip is one thing that has to work for Akọwe to use your AIs: ✔ works, … waiting, ○ not done yet, ✕ problem (with a ⚠️ marker — click it). The chips update by themselves.",
    "Details ▸ opens the full list. It opens by itself when something fails.",
    "🧪 Test the connection checks every line for real, the same way Akọwe works: the bridge, the key (a wrong key must be refused), each AI window, a tiny test question to each Active AI (it must answer with a small JSON reply), whether Akọwe is running and whether it is connected.",
    "A report is saved in the logs folder (📄 Last report) — it never contains your key or the question text. Heads-up: the test really types a short test message into each Active AI's chat."]],
  now: ["Now working on", [
    "What Akọwe is doing right now: the step of your book it's on (for example “Set B · B03 Main plot”), whether it's working or waiting for you, and a short note in plain words.",
    "If something needs your OK — like a draft to approve — it shows here with a ✅ Review & approve button that opens the right page in Akọwe.",
    "Akọwe sends this update by itself every few seconds while it's connected. If updates stop, a ⚠️ note says when the last one came."]],
  book: ["Book checklist", [
    "The big picture of your book: every part Akọwe works through. The coloured letter is the module set (A, B, C…); ✓ done, ▶ in progress, ! waiting for your OK, ○ to do.",
    "The bar shows how many parts are done out of the total. List ▸ shows every part with its name. 📚 Open Akọwe takes you to the book in your browser."]],
  activity: ["Activity log", [
    "A live diary of what happened between Akọwe and this app, newest first — when Akọwe connected, which AI it asked, how long the answer took, time-outs and refused connections.",
    "It never shows what was asked or answered, and never shows your connection key."]],
  tos: ["Is this allowed?", [
    "This app works by typing into the ChatGPT, Claude and Gemini websites for you. Those websites' terms of service may not allow automated use, and an account could be limited if they object.",
    "That's why the bridge is off until you turn it on (Connect Akọwe turns it on for you). Use it at your own risk, at a gentle pace."]],
  routing: ["Why keep routing / autopilot off?", [
    "While Akọwe is using an AI, the answer must go straight back to Akọwe. If routing, autopilot, House Rules or a Prompt Sequence is also running, other messages can land in the same chat window at the same time and mix up the answers.",
    "The bridge never forwards Akọwe's answers to the other AIs — but it can't stop other features typing into that window. So turn those off while Akọwe works."]]
};

// --- ⚠️ problems: every code in plain words, in ONE table ------------------------
// Bridge HTTP errors (contract), pairing errors (v1.1), per-request outcomes, the
// bridge's start errors, Connect steps, link-test failures and the panel's own IPC
// failures. Each: title, what happened (plain), how to fix (steps), and the retry
// action (a key of BF_RETRY) when there is one. `c` = { port, L (AI name), site, msg }.
const BF_CODES = {
  // the bridge itself
  EADDRINUSE: { sev: "err", title: "The bridge couldn't start — its address is taken",
    what: (c) => `Another program is already using port ${c.port} on this computer — usually a second copy of AutoInjector.`,
    fix: () => ["Close any other AutoInjector window (check the taskbar).", "Press 🔁 Try again — or turn the Bridge switch off and on.", "Still stuck? Restart the computer."], retry: "restartBridge" },
  EACCES: { sev: "err", title: "This computer blocked the bridge",
    what: (c) => `Your system refused to let the bridge open its private address (port ${c.port}).`,
    fix: () => ["Restart AutoInjector and press 🔁 Try again.", "If it keeps happening, security software may be blocking it — ask for help choosing another port (AUTOINJECTOR_AKOWE_PORT)."], retry: "restartBridge" },
  TOKEN_WRITE_FAILED: { sev: "err", title: "Couldn't save the connection key",
    what: () => "The app couldn't write the key file in its settings folder.",
    fix: () => ["Make sure your disk isn't full.", "Press 🔁 Try again."], retry: "restartBridge" },
  BRIDGE_START_FAILED: { sev: "err", title: "The bridge couldn't start",
    what: () => "The bridge was switched on but isn't listening.",
    fix: () => ["Press 🔁 Try again.", "If it keeps failing, restart AutoInjector, then 📋 copy the diagnostics and ask for help."], retry: "restartBridge" },
  NOT_READY: { sev: "err", title: "The bridge has no connection key yet",
    what: () => "Akọwe tried to connect, but this app hasn't made its connection key.",
    fix: () => ["Press 🔁 Try again — the key is made automatically."], retry: "reconnect" },
  // Connect steps
  CONNECT_BRIDGE: { sev: "err", title: "Connecting stopped — the bridge went off",
    what: (c) => c.msg || "The bridge was turned off while connecting.",
    fix: () => ["Leave the Bridge switch on.", "Press 🔁 Try again."], retry: "reconnect" },
  CONNECT_BROWSER: { sev: "err", title: "Couldn't open your web browser",
    what: (c) => c.msg || "Connect couldn't open Akọwe in your browser.",
    fix: () => ["Open Akọwe in your browser yourself (📚 Open Akọwe), then press 🔁 Try again.", "Or use “Other ways to connect” → 📋 Copy connection key and paste it in Akọwe (Settings → Connect AutoInjector)."], retry: "reconnect" },
  CONNECT_EXPIRED: { sev: "warn", title: "Akọwe didn't pick up the connection in time",
    what: () => "The one-time connection code lasts 2 minutes and Akọwe didn't use it.",
    fix: () => ["Press 🔁 Try again — an Akọwe page opens in your browser.", "If Akọwe asks, click Connect there and keep that page open."], retry: "reconnect" },
  CONNECT_FAILED: { sev: "err", title: "Connecting didn't finish",
    what: (c) => c.msg || "Something went wrong while connecting.",
    fix: () => ["Press 🔁 Try again.", "If it keeps failing, 📋 copy the diagnostics and ask for help."], retry: "reconnect" },
  AKOWE_NOT_RUNNING: { sev: "warn", title: "Akọwe isn't running",
    what: (c) => c.msg || "This app can't find Akọwe on this computer.",
    fix: () => ["Start Akọwe: double-click run-akowe.bat (Windows) or run-akowe.sh (Mac/Linux) in the Akọwe folder — or press 🔁 “Start Akọwe for me”.", "Wait until its window says it is running.", "Press 🔗 Connect Akọwe."], retry: "startApp" },
  NO_STATUS: { sev: "warn", title: "Akọwe hasn't reported back yet",
    what: () => "Akọwe has the connection key, but hasn't sent what it's working on.",
    fix: () => ["Keep the Akọwe page open in your browser.", "If this stays, update Akọwe — the AIs still work either way."], retry: "openAkowe" },
  STATUS_STALE: { sev: "warn", title: "Akọwe stopped sending updates",
    what: (c) => `The last update from Akọwe came ${c.ago || "a while ago"}. What you see is the last thing it reported.`,
    fix: () => ["Check that Akọwe's page is still open in your browser (📚 Open Akọwe).", "If you restarted Akọwe, press 🔗 Connect Akọwe again."], retry: "openAkowe" },
  // keys & pairing
  UNAUTHORIZED: { sev: "warn", title: "Something used an old or wrong connection key",
    what: () => "A connection attempt with an old or wrong key was refused. Usually Akọwe still has a key from before a new one was made.",
    fix: () => ["Press 🔁 Try again (Connect) to hand Akọwe the right key."], retry: "reconnect" },
  PAIRING_CODE_INVALID: { sev: "warn", title: "An unknown or used-up connection code was refused",
    what: () => "Something tried a one-time connection code that isn't valid any more (each code works once).",
    fix: () => ["Press 🔁 Try again for a fresh code."], retry: "reconnect" },
  PAIRING_CODE_EXPIRED: { sev: "warn", title: "The connection code was used too late",
    what: () => "One-time connection codes last 2 minutes.",
    fix: () => ["Press 🔁 Try again and finish in the Akọwe page within 2 minutes."], retry: "reconnect" },
  TOO_MANY_ATTEMPTS: { sev: "warn", title: "Too many wrong connection codes",
    what: () => "After several wrong codes, connecting is paused for a minute (a safety lock).",
    fix: () => ["Wait one minute.", "Then press 🔁 Try again."], retry: "reconnect" },
  // the AIs
  SITE_NOT_READY: { sev: "err", title: (c) => `${c.L}'s window isn't ready`,
    what: (c) => `${c.L}'s window is missing or still loading, so Akọwe can't use it.`,
    fix: (c) => [`Look at ${c.L}'s window in this app — log in if it asks.`, "Wait until the page has finished loading.", `Or press 🔁 Reload ${c.L}.`], retry: "reloadPane" },
  NO_ACTIVE_AI: { sev: "warn", title: "No AI is switched on for Akọwe",
    what: () => "None of ChatGPT, Claude or Gemini is ticked as Active in this app, so Akọwe has nobody to ask.",
    fix: () => ["Tick at least one AI as Active (the Active checkboxes in the User Panel).", "Press 🔁 Try again."], retry: "recheck" },
  TIMEOUT: { sev: "warn", title: (c) => `${c.L} took too long to answer`,
    what: (c) => `${c.L} hadn't finished answering before Akọwe stopped waiting.`,
    fix: (c) => [`Look at ${c.L}'s window: is it still writing, logged out, or showing a pop-up/captcha?`, `Fix what it shows, or press 🔁 Reload ${c.L}.`, "Akọwe asks you before it retries."], retry: "reloadPane" },
  LATE_EXPIRED: { sev: "warn", title: (c) => `${c.L} never answered`,
    what: (c) => `${c.L} never finished the answer; it is free again.`,
    fix: (c) => [`Check ${c.L}'s window (logged out? pop-up?).`, `Press 🔁 Reload ${c.L} if it looks stuck.`], retry: "reloadPane" },
  SEND_FAILED: { sev: "err", title: (c) => `Couldn't type into ${c.L}'s window`,
    what: (c) => `The question couldn't be typed into ${c.L}'s chat box.`,
    fix: (c) => [`Look at ${c.L}'s window — close any pop-up and make sure you're logged in.`, `Press 🔁 Reload ${c.L}, then try again in Akọwe.`], retry: "reloadPane" },
  SITE_BUSY: { sev: "warn", title: (c) => `${c.L} was busy`,
    what: (c) => `${c.L} was still answering an earlier request, so Akọwe was told to wait.`,
    fix: () => ["Nothing to do — Akọwe tries again by itself.", "Keep routing/autopilot off while Akọwe works."], retry: null },
  TOO_LARGE: { sev: "warn", title: "A request was too big", what: () => "Akọwe sent a request over 1 MB, so it was refused.", fix: () => ["Update Akọwe and AutoInjector.", "📋 Copy the diagnostics and ask for help if it repeats."], retry: null },
  BAD_REQUEST: { sev: "warn", title: "A request this app couldn't use", what: () => "Akọwe sent something this app couldn't understand.", fix: () => ["Update Akọwe and AutoInjector so they match.", "Run 🧪 Test the connection."], retry: "linktest" },
  UNKNOWN_SITE: { sev: "warn", title: "A request named an unknown AI", what: () => "Akọwe asked for an AI this app doesn't have.", fix: () => ["Update Akọwe and AutoInjector so they match."], retry: "linktest" },
  NOT_FOUND: { sev: "warn", title: "A request went to the wrong address", what: () => "Something asked the bridge for a page that doesn't exist.", fix: () => ["Update Akọwe and AutoInjector so they match."], retry: "linktest" },
  // 🧪 link test
  LINKTEST_FAIL: { sev: "err", title: (c) => `Test failed: ${c.step || "a check"}`,
    what: (c) => c.msg || "This check failed during the connection test.",
    fix: (c) => (c.tip ? [c.tip, "Then press 🔁 Try again to run the test again."] : ["Press 🔁 Try again to run the test again."]), retry: "linktest" },
  ALREADY_RUNNING: { sev: "warn", title: "A test is already running", what: () => "Only one connection test can run at a time.", fix: () => ["Wait for it to finish (or press ■ Stop)."], retry: null },
  LINKTEST_COULDNT_RUN: { sev: "err", title: "The connection test couldn't run", what: (c) => c.msg || "The test stopped before it started.", fix: () => ["Press 🔁 Try again.", "If it keeps failing, 📋 copy the diagnostics and ask for help."], retry: "linktest" },
  BAD_FILE: { sev: "warn", title: "Couldn't open the report", what: () => "The saved test report couldn't be found or opened.", fix: () => ["Run 🧪 Test the connection again to make a new report.", "Reports are in the app's logs folder."], retry: "linktest" },
  // Start Akọwe for me / open pages / clipboard
  NO_LAUNCHER: { sev: "warn", title: "Couldn't find Akọwe next to this app", what: (c) => c.msg || "The run-akowe launcher isn't in the Akọwe folder next to AutoInjector.", fix: () => ["Start Akọwe yourself with run-akowe.bat (or .sh).", "Then press 🔗 Connect Akọwe."], retry: "reconnect" },
  SPAWN_FAILED: { sev: "err", title: "Couldn't start Akọwe", what: (c) => c.msg || "Starting the Akọwe launcher failed.", fix: () => ["Start Akọwe yourself with run-akowe.bat (or .sh).", "Then press 🔗 Connect Akọwe."], retry: "startApp" },
  ALREADY_STARTING: { sev: "warn", title: "Akọwe is already starting", what: () => "Give it a moment — the first start can take a few minutes.", fix: () => ["Wait until Akọwe's window says it is running, then press 🔗 Connect Akọwe."], retry: "reconnect" },
  STILL_STARTING: { sev: "warn", title: "Akọwe is still starting", what: (c) => c.msg || "Akọwe didn't answer yet.", fix: () => ["Wait until Akọwe's window says it is running.", "Press 🔁 Try again."], retry: "reconnect" },
  OPEN_FAILED: { sev: "err", title: "Couldn't open your web browser", what: (c) => c.msg || "The page couldn't be opened.", fix: () => ["Open your browser and go to Akọwe's address yourself (usually http://127.0.0.1:8780/).", "Press 🔁 Try again."], retry: "openAkowe" },
  NO_CLIPBOARD: { sev: "warn", title: "Couldn't use the clipboard", what: () => "Copying didn't work on this computer.", fix: () => ["Use “Show key” and copy it by hand (or select the text shown).", "Press 🔁 Try again."], retry: null },
  TOKEN_UNAVAILABLE: { sev: "err", title: "Couldn't read the connection key", what: () => "The key file couldn't be read or made.", fix: () => ["Press 🔁 Try again.", "If it repeats, press 🔗 Connect Akọwe — it makes the key for you."], retry: null },
  DIAGNOSTICS_FAILED: { sev: "warn", title: "Couldn't put the diagnostics together", what: () => "The app couldn't build the summary.", fix: () => ["Press 🔁 Try again."], retry: null },
  // P18 self-repair
  AI_NEEDS_YOU: { sev: "warn", title: (c) => `${c.L || "This AI"} needs you`,
    what: (c) => c.say || `${c.L || "This AI"} needs you before it can work again.`,
    fix: (c) => (Array.isArray(c.fix) && c.fix.length ? c.fix : [`Open ${c.L || "the AI"}'s window and follow what it shows.`, "AutoInjector checks again by itself."]), retry: null },
  AI_BROKEN: { sev: "err", title: (c) => `${c.L || "This AI"} isn't working`,
    what: (c) => `${c.say || "A check-in failed."} AutoInjector tried to fix it by itself but couldn't. Akọwe uses your other AIs meanwhile.`,
    fix: (c) => [`Press 🎯 Point at it: choose the part that's wrong (message box, Send button or the AI's reply), press OK and click it in ${c.L || "the AI"}'s window, then Save.`, `Or press 🔢 Do it for me with a number: you type a 4-digit number into ${c.L || "the AI"} and press Send — AutoInjector learns all three by itself.`, "Or press 🔄 Reload, then 🩺 Check again.", "AutoInjector re-checks by itself after 5, 15, then every 60 minutes — it won't keep asking you."], retry: null },
  // the panel itself
  IPC_FAILED: { sev: "err", title: "The app didn't answer", what: (c) => `${c.where || "This action"} didn't get an answer from the main app.`, fix: () => ["Press 🔁 Try again.", "If it keeps happening, restart AutoInjector."], retry: null },
  IPC_MISSING: { sev: "err", title: "This part of the app isn't available", what: (c) => `${c.where || "This action"} isn't available in this version of the app.`, fix: () => ["Restart AutoInjector. If it still happens, update AutoInjector."], retry: null },
  STATUS_UNAVAILABLE: { sev: "err", title: "The panel can't get the latest status", what: () => "Asking the main app for the Akọwe status failed, so what you see may be out of date.", fix: () => ["Press 🔁 Try again.", "If it keeps happening, restart AutoInjector."], retry: "recheck" },
  UI_ERROR: { sev: "err", title: "The Akọwe panel hit a snag", what: () => "Something unexpected went wrong while showing this panel. The rest of the app is fine.", fix: () => ["Press 🔁 Try again.", "If it repeats, 📋 copy the diagnostics and ask for help."], retry: "recheck" }
};
function bfCodeInfo(code) { return BF_CODES[code] || BF_CODES[String(code || "").toUpperCase()] || null; }
const BF_START_ERRORS = ["EADDRINUSE", "EACCES", "TOKEN_WRITE_FAILED"];

// --- derive "where it's at" from a status snapshot ---------------------------
function bfErrorText(err, port) {
  const code = BF_START_ERRORS.includes(err) ? err : "BRIDGE_START_FAILED";
  const i = BF_CODES[code];
  const c = { port };
  return { code, title: i.title, sub: i.what(c) + (code === "BRIDGE_START_FAILED" && err ? ` (${err})` : ""), next: i.fix(c).join(" ") };
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
  const notReady = activeSites.filter((k) => !s.sites[k].ready && !s.sites[k].inFlight);
  const working = BF_SITES.map((k) => [k, s.sites && s.sites[k] && s.sites[k].inFlight]).find(([, f]) => f && !f.selftest);
  const phase = (s.connect && s.connect.phase) || "idle";
  const d = { badKey, connected, phase, activeSites, notReady };
  if (!s.enabled && !bf.connecting) return Object.assign(d, { key: "off", pill: "⏻ Off", tone: "off", title: "Akọwe isn't connected", sub: "The bridge is off — nothing is shared until you connect.", next: "Press “🔗 Connect Akọwe”. It turns the bridge on and connects Akọwe in one click." });
  if (s.enabled && (bf.starting || (!s.listening && (s.starting || !s.error)))) return Object.assign(d, { key: "starting", pill: "⏳ Starting", tone: "info", title: "Starting the bridge…", sub: `Opening a private doorway on this computer (127.0.0.1:${port}).`, next: "Wait a moment while the bridge starts…" });
  if (s.enabled && !s.listening) { const e = bfErrorText(s.error, port); return Object.assign(d, { key: "error", pill: "⚠️ Problem", tone: "err", title: e.title, sub: e.sub, next: "Click the ⚠️ next to the Bridge switch for how to fix it." }); }
  let next;
  if (bf.test.running) next = "The connection test is running — watch the chips. You can stop it any time.";
  else if (badKey && !connected) next = "Akọwe (or something else) tried an old or wrong key. Press “🔗 Connect Akọwe” to hand Akọwe the right one.";
  else if (!connected && (phase === "waiting" || phase === "paired")) next = bfInApp(s) ? "Akọwe is connecting by itself — this panel ticks when it's done." : "Finish in the Akọwe page that opened in your browser. This panel ticks by itself when it's done.";
  else if (!connected && phase === "not_running") next = "Start Akọwe, then press Connect Akọwe again.";
  else if (!connected) next = bfInApp(s) ? "Press “🔗 Connect Akọwe” — it connects the Akọwe in the 📖 Akọwe tab, nothing to copy or paste." : "Press “🔗 Connect Akọwe”. It opens Akọwe in your browser and connects it — nothing to copy or paste.";
  else if (!activeSites.length) next = "Tick at least one AI (ChatGPT, Claude or Gemini) as Active in this app so Akọwe has someone to ask.";
  else if (notReady.length) next = `Open ${notReady.map((k) => bfLabel(k, s)).join(" and ")} and log in, so Akọwe can use ${notReady.length > 1 ? "them" : "it"}.`;
  else if (s.akowe && s.akowe.approvals && s.akowe.approvals.count > 0) next = "Akọwe is waiting for your OK — press ✅ Review & approve.";
  else next = "All set. Use Akọwe as normal and keep routing/autopilot off while it works.";
  if (working) {
    const [site, f] = working;
    const L = bfLabel(site, s);
    const el2 = (f.elapsed_ms || 0) + (Date.now() - bf.at);
    const late = f.phase === "late";
    return Object.assign(d, { key: "working", pill: "✍️ Working", tone: "work",
      title: `Akọwe asked ${L} for an answer… ${bfClock(el2)}`,
      sub: late ? `${L} is taking longer than Akọwe waited; a late answer is still saved for Akọwe.` : "The answer goes straight back to Akọwe.",
      next: `Leave the ${L} window alone until it finishes answering — Akọwe is waiting for it.` });
  }
  if (connected) {
    const b = s.akowe;
    const when = b && !b.stale ? `last update ${bfAgo(b.receivedAt)}` : `last contact ${bfAgo(s.lastExternalContactAt || (b && b.receivedAt))}`;
    return Object.assign(d, { key: "connected", pill: "✔ Connected", tone: "ok", title: "Akọwe is connected", sub: `can use your AIs · ${when}`, next });
  }
  if (phase === "waiting" || phase === "paired") return Object.assign(d, { key: "waiting", pill: "📡 Connecting", tone: "wait", title: "Connecting to Akọwe…", sub: bfInApp(s) ? "Akọwe runs inside AutoInjector — it connects by itself" : "finish in the Akọwe page in your browser", next });
  return Object.assign(d, { key: "waiting", pill: "📡 Not connected", tone: "wait", title: "Bridge is on — Akọwe isn't connected yet", sub: `listening on 127.0.0.1:${port} (this computer only)`, next });
}

// Akọwe runs inside AutoInjector (its server started or reused by AutoInjector, signed in):
// Connect pairs it directly, nothing opens in the browser.
function bfInApp(s) { return !!(s && s.server && s.server.ready && s.server.hasToken); }
// --- 🔗 Connect: the message on the status line --------------------------------
function bfConnectView(s, d) {
  const c = s.connect || {};
  if (bf.startingApp) return { tone: "work", text: "Starting Akọwe for you… the first start can take a minute or two." };
  if (bf.localMsg) return bf.localMsg;
  if (bf.connecting || c.phase === "starting_bridge" || c.phase === "checking") return { tone: "work", text: c.phase === "checking" ? "Looking for Akọwe…" : "Turning the bridge on…" };
  if (d.connected && (c.phase === "connected" || c.phase === "idle" || !c.phase || c.phase === "no_status" || c.phase === "expired" || c.phase === "error" || c.phase === "not_running")) {
    if (c.phase === "no_status" || !s.akowe) return { tone: "ok", text: "Connected ✔ (Akọwe hasn't said what it's working on yet.)" };
    return { tone: "ok", text: "" }; // the pill already says "Connected"
  }
  switch (c.phase) {
    case "waiting": {
      const left = c.expiresAt ? Math.max(0, c.expiresAt - bfNow()) : 0;
      if (bfInApp(s)) return { tone: "work", text: "Connecting the Akọwe that runs inside AutoInjector…" };
      return { tone: "work", text: `Akọwe opened in your browser — click Connect there if it asks (${bfClock(left)} left).` };
    }
    case "paired": return { tone: "work", text: "Akọwe has the key ✔ — waiting for its first update…" };
    case "connected": // connected earlier, but not any more (no contact / updates stopped)
      return s.akowe && s.akowe.stale
        ? { tone: "warn", text: `Akọwe stopped sending updates ${bfAgo(s.akowe.receivedAt)}.` }
        : { tone: "warn", text: "Akọwe isn't connected any more." };
    case "no_status": return { tone: "warn", text: "Akọwe has the key, but hasn't reported back yet." };
    case "not_running": return { tone: "warn", text: "Akọwe isn't running.", start: !!c.canStartApp };
    case "expired": case "error": return { tone: "err", text: "Connecting didn't finish." };
    default: return { tone: "", text: bfInApp(s) ? "Akọwe runs inside AutoInjector (📖 Akọwe tab) and connects by itself. Connect does it again by hand." : "One click: turns the bridge on, opens Akọwe in your browser and hands it the key." };
  }
}
function bfRenderConnect(s, d) {
  const v = bfConnectView(s, d);
  const box = el("bf-connect-msg");
  if (box) { const t = v.tone || (d.tone === "off" ? "" : d.tone === "wait" ? "warn" : d.tone); if (t) box.dataset.tone = t; else delete box.dataset.tone; }
  bfText("bf-connect-text", v.text);
  const start = el("btn-bf-start-app");
  if (start) { start.style.display = v.start && !bf.startingApp ? "" : "none"; start.disabled = bf.startingApp; }
  const btn = el("btn-bf-connect");
  if (btn) {
    const c = s.connect || {};
    const busy = bf.connecting || bf.startingApp || c.phase === "starting_bridge" || c.phase === "checking";
    btn.disabled = busy;
    let label = "🔗 Connect Akọwe";
    if (busy) label = "⏳ Connecting…";
    else if (c.phase === "waiting" || c.phase === "paired") label = "🔗 Connect again";
    else if (d.connected) label = "✔ Connected";
    bfSetText(btn, label);
    btn.dataset.state = d.connected && !busy ? "connected" : "";
    btn.title = d.connected ? "Akọwe is connected. Click to connect again (for example after restarting Akọwe)." : "Turns the bridge on, opens Akọwe in your browser and hands it the connection key — nothing to copy or paste";
  }
}

// --- AIs (compact strip) ---------------------------------------------------------
const BF_OUTCOME = {
  OK: (l) => `Answered in ${bfDur(l.elapsed_ms)}`,
  LATE_REPLY_STORED: (l) => `Answered late (${bfDur(l.elapsed_ms)})`,
  TIMEOUT: (l) => `Timed out after ${bfDur(l.elapsed_ms)}`,
  LATE_EXPIRED: () => "Never answered",
  SEND_FAILED: () => "Couldn't type the prompt",
  SITE_NOT_READY: () => "Window wasn't loaded",
  SITE_BUSY: () => "Was busy — told Akọwe to wait",
  CACHED: () => "Gave an earlier answer again"
};
// Why an AI window isn't ready, as a short pill word (main sends problem + problemSay).
const BF_NOT_READY_WORD = { TEACHING: "Teaching…", SIGNED_OUT: "Signed out?", NO_MESSAGE_BOX: "No message box", LOAD_FAILED: "Didn't load", LOADING: "Loading…", CHECKING: "Checking…" };
function bfNotReadyWord(x) { return BF_NOT_READY_WORD[x && x.problem] || "Not loaded"; }
const BF_REPAIR_STEP = { check: "checking in", alternatives: "trying other known ways", page_search: "searching the page", retry: "checking in again", unfreeze: "pressing Stop", reload: "reloading the window", reload_home: "opening a fresh page", teach: "waiting for you" };
function bfRepairOf(x) { return (x && x.repair) || {}; }
function bfAiView(s, site) {
  const x = (s.sites && s.sites[site]) || {};
  const R = bfRepairOf(x);
  let pill = [bfNotReadyWord(x), "err", "✕", "bad"];
  if (!x.active) pill = ["Not active", "off", "–", "off"];
  else if (R.teach && R.teach.active) pill = ["Needs you", "warn", "🔢", "needs"];
  else if (R.state === "repairing") pill = ["Repairing…", "work", "🔧", "repair"];
  else if (R.state === "needs_user") pill = ["Needs you", "warn", "⚠️", "needs"];
  else if (R.state === "broken") pill = ["Not working", "err", "✕", "bad"];
  else if (x.inFlight) pill = [x.inFlight.selftest ? "Testing" : "Busy", "work", "✍️", "work"];
  else if (x.ready) pill = [R.running ? "Checking…" : "Ready", "ok", R.running ? "🩺" : "✔", "ok"];
  let last;
  if (x.active && R.teach && R.teach.active) last = `🔢 Type ${R.teach.number} into ${bfLabel(site, s)}'s message box and press Send — see the box above`;
  else if (x.active && (R.state === "repairing" || R.state === "needs_user" || R.state === "broken")) last = `${R.say || "A check-in failed."}${R.running && R.step ? ` Now: ${BF_REPAIR_STEP[R.step] || R.step}…` : ""}`;
  else if (x.inFlight) last = `Working for ${bfClock((x.inFlight.elapsed_ms || 0) + (Date.now() - bf.at))}`;
  else if (x.active && !x.ready && x.problemSay) last = `Not ready: ${x.problemSay}`;
  else if (x.last) { const f = BF_OUTCOME[x.last.outcome]; last = `${f ? f(x.last) : x.last.outcome}${x.last.selftest ? " (test)" : ""} · ${bfAgo(x.last.at)}`; }
  else last = "No requests yet";
  let check = "";
  if (x.active && R.state === "ok" && R.fixedAt && bfNow() - R.fixedAt < 10 * 60000) check = `✔ Fixed ${bfAgo(R.fixedAt)} — working again`;
  else if (x.active && R.lastProbeOkAt) check = `Check-in OK ${bfAgo(R.lastProbeOkAt)}`;
  else if (x.active && R.running) check = "Checking in…";
  return { x, pill, last, check };
}
function bfRenderAis(s) {
  bfKeyed(el("bf-ais"), BF_SITES, (k) => k, (site) => {
    const card = bfNode("div", "bf-ai");
    card.dataset.site = site;
    const top = bfNode("div", "bf-ai-top");
    top.append(bfNode("span", "bf-ai-name"), bfNode("span", "bf-pill"));
    card.append(top, bfNode("div", "bf-ai-last"), bfNode("div", "bf-ai-check"));
    return card;
  }, (card, site) => {
    const v = bfAiView(s, site);
    card.dataset.st = v.pill[3];
    if (bf.attention && bf.attention[site] && Date.now() - bf.attention[site] < 8000) card.dataset.flash = "1"; else delete card.dataset.flash;
    bfSetText(card.querySelector(".bf-ai-name"), bfLabel(site, s));
    const p = card.querySelector(".bf-pill"); p.dataset.tone = v.pill[1]; bfSetText(p, `${v.pill[2]} ${v.pill[0]}`);
    const last = card.querySelector(".bf-ai-last"); bfSetText(last, v.last); last.title = v.last;
    const chk = card.querySelector(".bf-ai-check"); if (chk) { bfSetText(chk, v.check || ""); chk.title = v.check || ""; }
  });
}

// --- the connection check (live state + the link test's results) ---------------
// Link-test step id -> row id.
function bfRowForStep(id) {
  if (id === "bridge_on") return "bridge";
  if (id === "key_file" || id === "wrong_key" || id === "right_key") return "key";
  if (id === "akowe_running") return "app";
  if (id === "akowe_connected") return "paired";
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
  rows.push({ id: "bridge", label: "The bridge is on", short: "Bridge",
    st: on ? "ok" : s.enabled && s.error ? "bad" : s.enabled ? "wait" : "todo",
    state: on ? "On" : s.enabled && s.error ? "Problem" : s.enabled ? "Starting…" : "Off",
    detail: on ? `Listening on 127.0.0.1:${s.port} — this computer only.` : s.enabled && s.error ? bfErrorText(s.error, s.port).title : "Connect Akọwe turns it on for you." });
  rows.push({ id: "key", label: "The connection key is ready", short: "Key",
    st: s.tokenPresent ? "ok" : "todo", state: s.tokenPresent ? "Ready" : "Not yet",
    detail: s.tokenPresent ? "Akọwe gets it privately when you connect — never in a web address." : "Made automatically when you connect." });
  const app = s.app || {};
  const bfFresh = !!(s.akowe && !s.akowe.stale);
  const appOk = app.running === true || bfFresh;
  rows.push({ id: "app", label: "Akọwe is running", short: "Akọwe running",
    st: appOk ? "ok" : app.running === false ? (c.phase === "not_running" ? "bad" : "todo") : "wait",
    state: appOk ? "Running" : app.running === false ? "Not running" : "Checking…",
    detail: appOk ? `${app.base ? `At ${app.base.replace(/\/$/, "")}` : "Running"}${app.version ? ` · version ${app.version}` : ""}` : app.running === false ? "Start Akọwe with run-akowe.bat (or press Connect and choose “Start Akọwe for me”)." : "" });
  const waiting = c.phase === "waiting" || c.phase === "paired";
  const stale = !!(s.akowe && s.akowe.stale);
  rows.push({ id: "paired", label: "Akọwe is connected to this app", short: "Connected",
    st: d.connected ? (stale ? "warn" : "ok") : waiting ? "wait" : d.badKey || c.phase === "no_status" || (c.phase === "connected" && stale) ? "warn" : "todo",
    state: d.connected ? (stale ? "Updates stopped" : "Connected") : waiting ? "Connecting…" : d.badKey ? "Wrong key used" : c.phase === "no_status" ? "No update yet" : "Not yet",
    detail: d.connected ? (s.akowe && !stale ? `Last update ${bfAgo(s.akowe.receivedAt)}.` : `Last contact ${bfAgo(s.lastExternalContactAt || (s.akowe && s.akowe.receivedAt))}.`) : waiting ? "Finish in the Akọwe page in your browser." : "Press 🔗 Connect Akọwe." });
  for (const site of BF_SITES) {
    const x = (s.sites && s.sites[site]) || {};
    const L = bfLabel(site, s);
    if (!x.active) { rows.push({ id: `ready:${site}`, site, label: `${L} is ready`, short: `${L} (not used)`, st: "na", state: "Not used", detail: `Not Active in this app — tick ${L} as Active to use it.` }); continue; }
    rows.push({ id: `ready:${site}`, site, label: `${L} is ready`, short: `${L} window`,
      st: x.inFlight ? "ok" : x.ready ? "ok" : x.problem === "TEACHING" ? "wait" : "bad",
      state: x.inFlight ? "Busy" : x.ready ? "Ready" : bfNotReadyWord(x),
      detail: x.inFlight ? "Answering right now." : x.ready ? "" : x.problemSay ? `Not ready: ${x.problemSay}.` : "Open its window, log in and wait until it has loaded." });
    const lastTest = x.last && x.last.selftest ? x.last : null;
    rows.push({ id: `trip:${site}`, site, label: `${L} answers through the bridge`, short: `${L} test`,
      st: lastTest ? (lastTest.outcome === "OK" ? "ok" : "bad") : "na",
      state: lastTest ? (lastTest.outcome === "OK" ? "Works" : "Failed") : "Not tested",
      outcome: lastTest && lastTest.outcome !== "OK" ? lastTest.outcome : null,
      detail: lastTest ? `Last test ${bfAgo(lastTest.at)}.` : "Press 🧪 Test the connection to send it a tiny test question." });
  }
  // the live rows + the link test's results for each row
  for (const r of rows) {
    const t = bfTestForRow(r.id);
    r.tip = null; r.test = t;
    if (t && t.status === "running") { r.st = "run"; r.state = "Checking…"; }
    else if (t && r.id.startsWith("trip:")) {
      r.st = t.status === "pass" ? "ok" : t.status === "fail" ? "bad" : "na";
      r.state = t.status === "pass" ? "Works" : t.status === "fail" ? "Failed" : "Skipped";
      r.detail = t.detail || r.detail; r.tip = t.status === "fail" ? t.tip : null;
    } else if (t && t.status === "fail") {
      r.st = r.st === "ok" ? "warn" : "bad"; // works now, but the last test failed -> "!"; otherwise a real problem
      r.detail = `Last test: ${t.detail}`; r.tip = t.tip;
    }
  }
  return rows;
}
const BF_ROW_ICON = { ok: "✔", bad: "✕", warn: "!", wait: "…", todo: "○", na: "–", run: "" };
function bfRenderChecks(s, d, rows) {
  // chips (inactive AIs: one chip, not two)
  const chipRows = rows.filter((r) => !(r.st === "na" && r.id.startsWith("trip:") && !(s.sites && s.sites[r.site] && s.sites[r.site].active)));
  bfKeyed(el("bf-chips"), chipRows, (r) => r.id, (r) => {
    const c = bfNode("span", "bf-chip");
    c.append(bfNode("span", "ic"), bfNode("span", "lb"));
    c.setAttribute("role", "img");
    if (r.site) c.dataset.ai = r.site;
    return c;
  }, (c, r) => {
    c.dataset.st = r.st;
    const ic = c.querySelector(".ic");
    if (r.st === "run") { if (!ic.querySelector(".bf-spin")) { ic.textContent = ""; ic.appendChild(bfNode("span", "bf-spin")); } }
    else bfSetText(ic, BF_ROW_ICON[r.st] || "•");
    bfSetText(c.querySelector(".lb"), r.short);
    const tip = `${r.label}: ${r.state}${r.detail ? ` — ${r.detail}` : ""}`;
    if (c.title !== tip) { c.title = tip; c.setAttribute("aria-label", tip); }
  });
  // full list: opens by itself when something fails, otherwise on click
  const failing = rows.filter((r) => r.st === "bad" || (r.test && r.test.status === "fail")).map((r) => r.id).join(",");
  if (failing !== bf.checksSig) { bf.checksSig = failing; bf.checksOpen = null; }
  const open = bf.checksOpen == null ? !!failing : bf.checksOpen;
  const ol = el("bf-conn-steps");
  if (ol && ol.hidden === open) ol.hidden = !open;
  const more = el("btn-bf-checks-more");
  if (more) { more.setAttribute("aria-expanded", String(open)); bfSetText(more, open ? "Details ▾" : "Details ▸"); }
  if (!open || !ol) return;
  let currentSet = false;
  bfKeyed(ol, rows, (r) => r.id, () => {
    const li = bfNode("li");
    const chk = bfNode("span", "bf-check"); chk.setAttribute("aria-hidden", "true");
    const main = bfNode("div", "bf-step-main");
    main.append(bfNode("span", "bf-step-text"), bfNode("span", "bf-step-detail"), bfNode("span", "tip"));
    li.append(chk, main, bfNode("span", "bf-step-state"));
    return li;
  }, (li, r) => {
    li.dataset.row = r.id;
    li.dataset.st = r.st;
    if (r.st === "todo" && !currentSet) { currentSet = true; li.dataset.current = "1"; } else delete li.dataset.current; // only the next thing to do is highlighted
    const chk = li.querySelector(".bf-check");
    if (r.st === "run") { if (!chk.querySelector(".bf-spin")) { chk.textContent = ""; chk.appendChild(bfNode("span", "bf-spin")); } }
    else bfSetText(chk, BF_ROW_ICON[r.st] || "•");
    bfSetText(li.querySelector(".bf-step-text"), r.label);
    bfSetText(li.querySelector(".bf-step-detail"), r.detail || "");
    const tp = li.querySelector(".tip"); tp.hidden = !r.tip; bfSetText(tp, r.tip ? `How to fix: ${r.tip}` : "");
    bfSetText(li.querySelector(".bf-step-state"), r.state);
  });
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
function bfOpenFor(s) { const b = s && s.akowe; return (b && b.akowe_url) || (s && s.app && s.app.base) || null; }
function bfStaleNote(b) {
  if (!b || !b.stale) return "";
  return `Last update from Akọwe ${bfAgo(b.receivedAt)} — it may be closed or busy. This shows the last thing it reported.`;
}
function bfRenderNow(s, d) {
  const b = s.akowe;
  bfShow("bf-now", !!b);
  bfShow("bf-now-empty", !!(!b));
  const card = el("bf-now-card");
  if (!b) {
    if (card) card.dataset.tone = "off";
    bfText("bf-now-empty", d.connected ? "Connected — Akọwe hasn't said what it's working on yet." : "Connect Akọwe to see what's happening.");
    bfShow("bf-now-stale", false);
    return;
  }
  const t = b.current_task;
  bfText("bf-now-step", t ? (bfStepLabel(t) || "Current step") : "Nothing in progress");
  const sw = bfStateWord(t && t.state);
  const pill = el("bf-now-state");
  if (pill) { pill.hidden = !sw.word; bfSetText(pill, sw.word); pill.dataset.tone = sw.tone; }
  bfText("bf-now-msg", (t && t.message) || (t ? "" : "Akọwe isn't working on a step right now."));
  const w = b.working_on;
  const wEl = el("bf-now-working");
  if (wEl) {
    if (w && (w.op || w.title)) {
      wEl.hidden = false;
      const since = w.started_at ? ` ${bfClock(Date.now() - w.started_at)}` : "";
      bfText("bf-now-working", `✍️ ${[w.op, w.title].filter(Boolean).join(" ")}${since}`);
    } else wEl.hidden = true;
  }
  const ap = b.approvals || { count: 0, items: [] };
  const n = Number(ap.count) || 0;
  const box = el("bf-approvals");
  if (box) box.dataset.tone = n > 0 ? "warn" : "ok";
  if (card) card.dataset.tone = b.stale ? "warn" : n > 0 ? "warn" : sw.tone === "work" ? "work" : sw.tone === "err" ? "err" : "ok";
  bfText("bf-approvals-title", n > 0 ? `✅ ${n} need${n === 1 ? "s" : ""} your OK:` : "✓ Nothing needs your approval right now");
  const items = (ap.items || []).slice(0, 3).map((it) => [it.set && !it.op ? `Set ${it.set}` : null, it.op, it.title].filter(Boolean).join(" ") || "Untitled");
  const more = n - items.length;
  bfText("bf-approvals-list", n > 0 ? items.join(", ") + (more > 0 ? ` …and ${more} more` : "") : "");
  const appr = el("btn-bf-approve");
  if (appr) appr.style.display = n > 0 ? "" : "none";
  const go = el("btn-bf-goto-task");
  if (go) go.style.display = t && (t.url || bfOpenFor(s)) ? "" : "none";
  const stale = bfStaleNote(b);
  bfShow("bf-now-stale", !!stale);
  bfText("bf-now-stale-text", stale);
}

// --- Book checklist: k/n bar + stepper chips; full list on demand ----------------
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
function bfShortLabel(r) {
  const op = String(r.op || r.id || "");
  const set = String(r.set || "");
  const title = String(r.title || "");
  // An op code "B03" in set "B" -> "03"; an op that IS the set ("A") -> its title.
  // A step id that merely starts with the set's letter ("chapters" in set C) stays whole.
  const code = /^([A-K])(\d+)$/i.exec(op);
  let lbl = code && set && code[1].toUpperCase() === set.toUpperCase() ? code[2] : (op && op !== set ? op : title);
  if (!lbl) lbl = title || op || "?";
  return lbl.length > 14 ? `${lbl.slice(0, 13)}…` : lbl;
}
function bfSetBadge(set) {
  const b = bfNode("span", "bf-set", bfSetLetter(set));
  b.style.setProperty("--set", bfSetColor(set));
  b.title = `Module set ${bfSetLetter(set)}`;
  return b;
}
function bfRenderBook(s, d) {
  const b = s.akowe;
  const rows = b && Array.isArray(b.checklist) ? b.checklist.filter((r) => r && typeof r === "object") : [];
  const has = !!(b && (rows.length || b.total || (b.project && b.project.title)));
  bfShow("bf-book", has);
  bfShow("bf-book-empty", !has);
  if (!has) bfText("bf-book-empty", d.connected ? "Connected — open a book in Akọwe and its progress shows here." : "When Akọwe is connected, your book's progress shows here.");
  if (has) {
    bfText("bf-book-title", (b.project && b.project.title) ? `“${b.project.title}”` : "Your book");
    const doneCount = rows.filter((r) => bfCheckState(r.state).tone === "ok").length;
    const total = Number.isFinite(b.total) && b.total > 0 ? b.total : rows.length;
    const done = Math.min(total, Number.isFinite(b.done) ? b.done : doneCount);
    const pct = total ? Math.round((done / total) * 100) : 0;
    const bar = el("bf-progress-bar");
    if (bar) bar.style.width = `${pct}%`;
    const pb = el("bf-progress");
    if (pb) { pb.setAttribute("aria-valuemax", String(total)); pb.setAttribute("aria-valuenow", String(done)); pb.title = `${done} of ${total} done (${pct}%)`; }
    bfText("bf-progress-text", total ? `${done}/${total}` : "–");
    const stepper = el("bf-stepper");
    bfKeyed(stepper, rows, (r) => r.id || r.op || r.title, (r) => {
      const li = bfNode("li");
      li.append(bfSetBadge(r.set || r.id), bfNode("span", "lbl"), bfNode("span", "ic"));
      return li;
    }, (li, r) => {
      const cs = bfCheckState(r.state);
      li.dataset.tone = cs.tone;
      bfSetText(li.querySelector(".lbl"), cs.tone === "work" ? (r.title || bfShortLabel(r)) : bfShortLabel(r));
      bfSetText(li.querySelector(".ic"), cs.ic);
      li.title = `${[r.op || r.id, r.title].filter(Boolean).join(" ")} — ${cs.word}`;
    });
    const more = el("btn-bf-book-more");
    if (more) { more.setAttribute("aria-expanded", String(bf.bookOpen)); bfSetText(more, bf.bookOpen ? "List ▾" : "List ▸"); more.hidden = !rows.length; }
    const ol = el("bf-checklist");
    if (ol) {
      ol.hidden = !bf.bookOpen;
      if (bf.bookOpen) bfKeyed(ol, rows, (r) => r.id || r.op || r.title, (r) => {
        const li = bfNode("li");
        const ic = bfNode("span", "ic"); ic.setAttribute("aria-hidden", "true");
        const tt = bfNode("span", "tt");
        tt.append(bfSetBadge(r.set || r.id), document.createTextNode(" "), bfNode("span", "nm"));
        li.append(ic, tt, bfNode("span", "st"));
        return li;
      }, (li, r) => {
        const cs = bfCheckState(r.state);
        li.dataset.tone = cs.tone;
        bfSetText(li.querySelector(".ic"), cs.ic);
        bfSetText(li.querySelector(".nm"), [r.op && r.op !== r.set ? r.op : null, r.title || (r.op ? null : r.id) || "Untitled"].filter(Boolean).join(" "));
        bfSetText(li.querySelector(".st"), cs.word);
      });
    }
  }
  bfShow("bf-book-stale", false); // the stale note lives on "Now working on" (one ⚠️, not two)
  const open = el("btn-bf-open");
  if (open) open.style.display = bfOpenFor(s) ? "" : "none";
}

function bfRenderActivity(s) {
  const list = el("bf-activity");
  if (!list) return;
  const act = el("bf-act-card");
  if (act && !act.open) return; // folded: nothing to draw
  const items = (Array.isArray(s.activity) ? s.activity : []).slice(-20).reverse();
  list.textContent = "";
  if (!items.length) { const li = bfNode("li", "empty", "Nothing yet — events appear here as they happen."); list.appendChild(li); return; }
  const ICON = { ok: "✓", warn: "!", error: "✕", info: "•" };
  for (const a of items) {
    const li = bfNode("li");
    li.dataset.tone = a.tone || "info";
    const t = bfNode("span", "t", bfTime(a.at)); t.title = bfAgo(a.at);
    const i = bfNode("span", "i", ICON[a.tone] || "•"); i.setAttribute("aria-hidden", "true");
    li.append(t, i, bfNode("span", null, a.say || a.kind));
    list.appendChild(li);
  }
}

// --- ⚠️ problems: computed from the snapshot + failed actions, shown where they are ---
// Each problem: { id, code, sev, where, anchors: [element ids / chip keys], ctx, msg?, tech? }.
function bfProblemsFor(s, d, rows) {
  const out = [];
  const add = (id, code, where, anchors, ctx, extra) => {
    const info = bfCodeInfo(code) || BF_CODES.UI_ERROR;
    out.push(Object.assign({ id, code, sev: info.sev, where, anchors, ctx: Object.assign({ port: s.port }, ctx || {}) }, extra || {}));
  };
  const c = s.connect || {};
  const anchored = new Set();
  const mark = (...ids) => ids.forEach((x) => anchored.add(x));
  // the bridge couldn't start
  if (s.enabled && !s.listening && s.error && !bf.starting && !s.starting) {
    const e = bfErrorText(s.error, s.port);
    add("bridge", e.code, "The Bridge switch (top right)", ["#bf-switch-anchor", "chip:bridge", "row:bridge"], {}, { tech: `bridge start error: ${s.error} · port ${s.port}` });
    mark("bridge");
  }
  // Connect steps that failed
  if (!d.connected && !bf.connecting) {
    if (c.phase === "error" && !(c.step === "bridge" && anchored.has("bridge"))) { // (a bridge start error already has its own ⚠️)
      const code = c.step === "bridge" ? "CONNECT_BRIDGE" : c.step === "browser" ? "CONNECT_BROWSER" : "CONNECT_FAILED";
      add("connect", code, `🔗 Connect Akọwe — step “${c.step === "bridge" ? "turn the bridge on" : c.step === "browser" ? "open Akọwe in your browser" : "connect"}”`, ["#bf-connect-anchor"], { msg: c.message }, { tech: `connect phase=error step=${c.step || "?"}` });
    } else if (c.phase === "expired") {
      add("connect", "CONNECT_EXPIRED", "🔗 Connect Akọwe — step “Akọwe picks up the connection”", ["#bf-connect-anchor", "chip:paired", "row:paired"], {}, { tech: "connect phase=expired (pairing code unused after 120 s)" });
      mark("paired");
    } else if (c.phase === "not_running") {
      add("connect", "AKOWE_NOT_RUNNING", "🔗 Connect Akọwe — step “is Akọwe running?”", ["#bf-connect-anchor", "chip:app", "row:app"], { msg: c.message }, { tech: `connect phase=not_running · ping ${(s.app && s.app.base) || "?"}api/ping`, retryOverride: c.canStartApp ? "startApp" : "reconnect" });
      mark("app");
    } else if (c.phase === "no_status") {
      add("nostatus", "NO_STATUS", "“Connected” check — Akọwe's first update", ["chip:paired", "row:paired"], {}, { tech: "connect phase=no_status (paired, no POST /v1/status within 30 s)" });
      mark("paired");
    }
  }
  // stale status
  if (s.akowe && s.akowe.stale) {
    add("stale", "STATUS_STALE", "“Now working on” — Akọwe's last update", ["#bf-now-stale", "chip:paired"], { ago: bfAgo(s.akowe.receivedAt) }, { tech: `status age ${Math.round((s.akowe.age_ms || 0) / 1000)} s (stale after ${BF_STALE_MS / 1000} s)` });
    mark("paired");
  }
  // a wrong key was seen and Akọwe isn't connected
  if (d.badKey && !d.connected && !anchored.has("paired")) { add("badkey", "UNAUTHORIZED", "“Connected” check", ["chip:paired", "row:paired"], {}, { tech: "HTTP 401 UNAUTHORIZED seen after the last good contact" }); mark("paired"); }
  // pairing refusals in the last 2 minutes
  const act = Array.isArray(s.activity) ? s.activity : [];
  const pr = act.filter((a) => a.kind === "pair" && a.outcome && a.outcome !== "PAIRED" && bfNow() - a.at < 120000).pop();
  if (pr && !d.connected && !anchored.has("paired") && BF_CODES[pr.outcome]) { add("pair", pr.outcome, "“Connected” check — pairing", ["chip:paired", "row:paired"], {}, { tech: `POST /v1/pair -> ${pr.outcome}${pr.http_status ? ` (HTTP ${pr.http_status})` : ""}` }); mark("paired"); }
  // AIs
  if (s.enabled && s.listening && !d.activeSites.length) add("noai", "NO_ACTIVE_AI", "Your AIs", ["#bf-ais-h"], {});
  for (const site of BF_SITES) {
    const x = (s.sites && s.sites[site]) || {};
    if (!x.active) continue;
    const L = bfLabel(site, s);
    // P18: the self-repair says this AI needs the user / couldn't be fixed — one ⚠️ that lists what was tried.
    const R = bfRepairOf(x);
    if ((R.state === "needs_user" || R.state === "broken") && !(R.teach && R.teach.active)) {
      const code = R.state === "needs_user" && R.fix ? "AI_NEEDS_YOU" : "AI_BROKEN";
      add(`repair:${site}`, code, `Your AIs → ${L}`, [`ai:${site}`, `chip:ready:${site}`, `row:ready:${site}`], { L, site, say: R.say, fix: R.fix, tried: R.tried || [], problem: R.problem, repair: true },
        { tech: `self-repair ${site}: state=${R.state} problem=${R.problem || "?"}${R.since ? ` since ${bfAgo(R.since)}` : ""}`, retryRun: () => bfCheckIn([site]), retryLabel: `Check ${L} again now` });
      mark(`ready:${site}`);
      continue;
    }
    if (R.state === "repairing" || (R.teach && R.teach.active)) continue; // being handled — the pill says so
    if (!x.ready && !x.inFlight) { add(`pane:${site}`, "SITE_NOT_READY", `Your AIs → ${L}`, [`ai:${site}`, `chip:ready:${site}`, `row:ready:${site}`], { L, site }, { tech: `pane ${site}: ready=false` }); mark(`ready:${site}`); continue; }
    const l = x.last;
    if (l && !l.selftest && ["TIMEOUT", "SEND_FAILED", "SITE_NOT_READY", "LATE_EXPIRED"].includes(l.outcome) && bfNow() - l.at < 10 * 60000 && !x.inFlight)
      add(`last:${site}`, l.outcome, `Your AIs → ${L} (last request)`, [`ai:${site}`], { L, site }, { tech: `last outcome ${l.outcome} after ${Math.round((l.elapsed_ms || 0) / 1000)} s` });
  }
  // the link test's failed rows (and live rows that are bad with no problem yet)
  for (const r of rows) {
    const t = r.test && r.test.status === "fail" ? r.test : null;
    if (anchored.has(r.id) || (r.st !== "bad" && !t)) continue;
    if (t) add(`lt:${r.id}`, "LINKTEST_FAIL", `Connection check → “${r.label}”`, [`chip:${r.id}`, `row:${r.id}`], { step: r.label, msg: t.detail, tip: t.tip, L: r.site ? bfLabel(r.site, s) : "", site: r.site }, { tech: `link test step ${t.id}: fail${t.http_status ? ` (HTTP ${t.http_status})` : ""}`, extraRetry: r.site ? "reloadPane" : null });
    else if (r.outcome && bfCodeInfo(r.outcome)) add(`trip:${r.id}`, r.outcome, `Connection check → “${r.label}”`, [`chip:${r.id}`, `row:${r.id}`], { L: bfLabel(r.site, s), site: r.site }, { tech: `last link-test round trip: ${r.outcome}`, retryOverride: "linktest" });
  }
  // failed actions (buttons / IPC) and the panel's own errors
  for (const [action, p] of bf.actionProblems) {
    add(`act:${action}`, p.code, p.opts.where || "This panel", [p.opts.anchor || "#bf-status-anchor"], Object.assign({ where: p.opts.where, msg: p.opts.msg }, p.opts.ctx || {}), { tech: p.opts.tech || `action ${action}: ${p.code}`, transient: action, retryRun: p.opts.retryRun, retryLabel: p.opts.retryLabel });
  }
  if (bf.uiError) add("ui", "UI_ERROR", "This panel", ["#bf-status-anchor"], {}, { tech: bf.uiError, transient: "__ui" });
  return out;
}
function bfAnchorEl(a) {
  if (a.startsWith("#")) return el(a.slice(1));
  const [kind, ...rest] = a.split(":");
  const key = rest.join(":");
  if (kind === "ai") return el("bf-ais") && el("bf-ais").querySelector(`.bf-ai[data-key="${key}"] .bf-ai-top`);
  if (kind === "chip") return el("bf-chips") && el("bf-chips").querySelector(`.bf-chip[data-key="${key}"]`);
  if (kind === "row") { const ol = el("bf-conn-steps"); return ol && !ol.hidden ? ol.querySelector(`li[data-key="${key}"] .bf-step-text`) : null; }
  return null;
}
// Put exactly one ⚠️ on each anchor that has a problem; leave unchanged markers alone (keeps focus).
function bfSyncMarkers(problems) {
  const panel = el("col-akowe");
  if (!panel) return;
  const want = new Map();
  for (const p of problems) for (const a of p.anchors) { const n = bfAnchorEl(a); if (n && !want.has(n)) want.set(n, p); }
  for (const m of Array.from(panel.querySelectorAll(".bf-hz"))) {
    const p = want.get(m.parentElement);
    if (!p || m.dataset.pid !== p.id) m.remove();
  }
  for (const [n, p] of want) {
    let m = Array.from(n.children).find((c) => c.classList && c.classList.contains("bf-hz"));
    if (!m) {
      m = bfNode("button", "bf-hz", "⚠️");
      m.type = "button";
      m.dataset.pid = p.id;
      m.setAttribute("aria-haspopup", "dialog");
      m.setAttribute("aria-controls", "bf-pop");
      m.setAttribute("aria-expanded", "false");
      n.appendChild(m);
    }
    m.dataset.sev = p.sev;
    const t = bfProblemTitle(p);
    const lbl = `Problem: ${t} — click for where, what and how to fix`;
    if (m.title !== lbl) { m.title = lbl; m.setAttribute("aria-label", lbl); }
  }
}
function bfProblemTitle(p) { const i = bfCodeInfo(p.code) || BF_CODES.UI_ERROR; return typeof i.title === "function" ? i.title(p.ctx) : i.title; }

// --- 🔁 Try again ------------------------------------------------------------------
const BF_RETRY = {
  recheck: { label: "Check again", run: () => akoweRefresh() },
  reconnect: { label: "Connect again", run: () => bfConnect() },
  restartBridge: { label: "Restart the bridge", run: () => bfRestartBridge() },
  linktest: { label: "Run the test again", run: () => bfRunLinkTest() },
  reloadPane: { label: (c) => `Reload ${c.L || "the window"}`, run: (c) => bfReloadPane(c.site, c.L) },
  openAkowe: { label: "Open Akọwe", run: () => bfOpen(bfOpenFor(bf.snap || {}), "Akọwe", "open") },
  startApp: { label: "Start Akọwe for me", run: () => bfStartApp() }
};
function bfRetryFor(p) {
  if (p.retryRun) return { label: p.retryLabel || "Try again", run: p.retryRun };
  const info = bfCodeInfo(p.code) || {};
  const key = p.retryOverride || info.retry;
  const r = key && BF_RETRY[key];
  if (!r) return null;
  return { label: typeof r.label === "function" ? r.label(p.ctx) : r.label, run: () => r.run(p.ctx) };
}

// --- pop-over: ⓘ explanations, ⚠️ problems, health, diagnostics fallback -----------
function bfOpenPop(owner, kind, fill) {
  const pop = el("bf-pop");
  const panel = el("col-akowe");
  if (!pop || !panel || !owner) return;
  const wasOpen = !pop.hidden && pop._owner === owner;
  bfCloseInfo(false);
  if (wasOpen) return;
  pop.dataset.kind = kind;
  delete pop.dataset.sev;
  el("bf-pop-title").textContent = "";
  const body = el("bf-pop-body");
  body.textContent = "";
  fill(el("bf-pop-title"), body, pop);
  pop.hidden = false;
  pop._owner = owner;
  owner.setAttribute("aria-expanded", "true");
  bfPlacePop();
  try { pop.focus(); } catch (_) {}
}
function bfPlacePop() {
  const pop = el("bf-pop");
  const panel = el("col-akowe");
  const owner = pop && pop._owner;
  if (!pop || pop.hidden || !owner || !panel) return;
  try {
    const pr = panel.getBoundingClientRect();
    const br = owner.getBoundingClientRect();
    if (!br.width && !br.height) return;
    const w = pop.offsetWidth || 360;
    let left = br.left - pr.left - 8;
    left = Math.max(8, Math.min(left, pr.width - w - 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${br.bottom - pr.top + 6}px`;
  } catch (_) {}
}
function bfOpenInfo(btn) {
  const info = BF_INFO[btn.dataset.info];
  if (!info) return;
  bfOpenPop(btn, "info", (title, body) => {
    title.textContent = info[0];
    for (const para of info[1]) body.appendChild(bfNode("p", null, para));
  });
}
function bfSec(label, content) {
  const d = bfNode("div", "bf-pop-sec");
  d.appendChild(bfNode("b", null, label));
  if (typeof content === "string") d.appendChild(bfNode("div", null, content)); else d.appendChild(content);
  return d;
}
function bfOpenProblem(marker) {
  const p = bf.problems.find((x) => x.id === marker.dataset.pid);
  if (!p) return;
  const info = bfCodeInfo(p.code) || BF_CODES.UI_ERROR;
  bfOpenPop(marker, "problem", (title, body, pop) => {
    pop.dataset.sev = p.sev;
    title.textContent = `⚠️ ${bfProblemTitle(p)}`;
    body.appendChild(bfSec("Where", p.where));
    body.appendChild(bfSec("What happened", info.what ? info.what(p.ctx) : (p.ctx.msg || "")));
    const steps = info.fix ? info.fix(p.ctx) : [];
    if (steps.length) { const ol = bfNode("ol"); for (const s of steps) ol.appendChild(bfNode("li", null, s)); body.appendChild(bfSec("How to fix", ol)); }
    if (p.ctx && Array.isArray(p.ctx.tried) && p.ctx.tried.length) {
      const ul = bfNode("ul");
      for (const t of p.ctx.tried.slice(-8)) ul.appendChild(bfNode("li", null, `${bfTime(t.at)} — ${t.say || t.step}: ${bfTriedOutcome(t.outcome)}`));
      body.appendChild(bfSec("What AutoInjector already tried", ul));
    }
    const det = bfNode("details");
    det.appendChild(bfNode("summary", null, "Technical details"));
    det.appendChild(bfNode("code", null, `${p.code}${p.tech ? ` · ${p.tech}` : ""}`));
    body.appendChild(det);
    const acts = bfNode("div", "bf-pop-actions");
    const retry = bfRetryFor(p);
    if (retry) {
      const b = bfNode("button", "bf-primary", `🔁 Try again — ${retry.label}`);
      b.type = "button";
      b.onclick = bfSafe(async () => { bfCloseInfo(false); if (p.transient) { bf.actionProblems.delete(p.transient); if (p.transient === "__ui") bf.uiError = null; } await retry.run(); }, "retry");
      acts.appendChild(b);
    }
    if (p.ctx && p.ctx.repair && p.ctx.site) {
      if (!p.ctx.fix) { // (log in / captcha / limit: only the user can fix those — no teach step)
        // P38: the 🎯 picker (the thing that works for the user) and the 🔢 number teach
        const pb = bfNode("button", "bf-primary", "🎯 Point at it");
        pb.type = "button"; pb.title = `Opens the 🎯 card on ${p.ctx.L}'s pane: choose the message box, the Send button or the AI's reply, press OK and click it in ${p.ctx.L}'s window`;
        pb.onclick = bfSafe(() => { bfCloseInfo(false); if (!openPicker(p.ctx.site, BF_PART_FOR[p.ctx.problem] || null)) bfMsg(`Couldn't open ${p.ctx.L}'s 🎯 card.`, "err"); else bfMsg(`See the 🎯 card on ${p.ctx.L}'s pane: choose one thing, press OK and click it in ${p.ctx.L}'s window.`); }, "picker");
        acts.appendChild(pb);
        const tb = bfNode("button", null, "🔢 Do it for me with a number");
        tb.type = "button"; tb.title = `You type a 4-digit number into ${p.ctx.L}'s message box and press Send; AutoInjector then asks ${p.ctx.L} to write it backwards and learns the message box, Send button and replies`;
        tb.onclick = bfSafe(async () => { bfCloseInfo(false); await bfTeachStart(p.ctx.site); }, "teach");
        acts.appendChild(tb);
      }
      const rb = bfNode("button", null, `🔄 Reload ${p.ctx.L}`);
      rb.type = "button";
      rb.onclick = bfSafe(async () => { bfCloseInfo(false); await bfRepairReload(p.ctx.site, p.ctx.L); }, "reload");
      acts.appendChild(rb);
    }
    if (p.extraRetry && BF_RETRY[p.extraRetry] && (!retry || p.extraRetry !== (p.retryOverride || info.retry))) {
      const r2 = BF_RETRY[p.extraRetry];
      const b2 = bfNode("button", null, `🔁 ${typeof r2.label === "function" ? r2.label(p.ctx) : r2.label}`);
      b2.type = "button";
      b2.onclick = bfSafe(async () => { bfCloseInfo(false); await r2.run(p.ctx); }, "retry");
      acts.appendChild(b2);
    }
    if (p.transient) {
      const x = bfNode("button", null, "Dismiss");
      x.type = "button";
      x.onclick = () => { bf.actionProblems.delete(p.transient); if (p.transient === "__ui") bf.uiError = null; bfCloseInfo(false); bfRenderAll(); };
      acts.appendChild(x);
    }
    const diag = bfNode("button", null, "📋 Copy diagnostics");
    diag.type = "button";
    diag.onclick = bfSafe(() => bfCopyDiagnostics(), "diagnostics");
    acts.appendChild(diag);
    body.appendChild(acts);
  });
}
const BF_HEALTH_NAMES = { bridge: "Bridge listening", key: "Connection key", akowe_reachable: "Akọwe reachable", status_fresh: "Akọwe updates are fresh", panes: "An AI is Active" };
function bfHealthOf(s) {
  if (s.health && s.health.level) return s.health;
  // older main.js: a rough local version
  if (!s.enabled) return { level: "off", checks: [] };
  return { level: s.listening ? (bfIsConnected(s) ? "ok" : "warn") : "bad", checks: [] };
}
function bfOpenHealth(btn) {
  const s = bf.snap || BF_EMPTY_SNAP;
  const h = bfHealthOf(s);
  bfOpenPop(btn, "info", (title, body) => {
    title.textContent = { ok: "🟢 All good", warn: "🟠 Not fully connected yet", bad: "⚠️ Something needs fixing", off: "⚪ Bridge is off" }[h.level] || "Health";
    const ul = bfNode("ul", "bf-health-list");
    for (const c of h.checks || []) {
      if (c.level === "off") continue;
      const nm = c.id.startsWith("pane:") ? `${bfLabel(c.id.slice(5), s)} window ready` : (BF_HEALTH_NAMES[c.id] || c.id);
      const li = bfNode("li");
      li.append(bfNode("span", null, c.level === "ok" ? "✔" : c.level === "bad" ? "⚠️" : "…"), bfNode("span", null, `${nm} — ${c.why}`));
      ul.appendChild(li);
    }
    if (!ul.children.length) body.appendChild(bfNode("p", null, h.level === "off" ? "Press 🔗 Connect Akọwe to start." : "No details from this version of the app."));
    else body.appendChild(ul);
    body.appendChild(bfNode("p", null, "Checked every few seconds; Akọwe itself is pinged at most every 30 seconds. Problems show a ⚠️ marker on the exact spot — click it for how to fix."));
  });
}
function bfCloseInfo(returnFocus) {
  const pop = el("bf-pop");
  if (!pop || pop.hidden) return;
  const owner = pop._owner;
  pop.hidden = true;
  pop._owner = null;
  if (owner) { owner.setAttribute("aria-expanded", "false"); if (returnFocus && owner.isConnected) { try { owner.focus(); } catch (_) {} } }
}
if (el("col-akowe")) {
  el("col-akowe").addEventListener("click", (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const info = t.closest(".bf-info");
    if (info) { e.preventDefault(); e.stopPropagation(); bfOpenInfo(info); return; } // preventDefault: an ⓘ inside a <summary> must not fold it
    const hz = t.closest(".bf-hz");
    if (hz) { e.preventDefault(); e.stopPropagation(); bfOpenProblem(hz); return; }
    if (t.closest("#bf-health")) { e.preventDefault(); e.stopPropagation(); bfOpenHealth(el("bf-health")); }
  });
  const closeBtn = el("bf-pop") && el("bf-pop").querySelector(".bf-pop-close");
  if (closeBtn) closeBtn.onclick = () => bfCloseInfo(true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && el("bf-pop") && !el("bf-pop").hidden) { e.preventDefault(); bfCloseInfo(true); } });
  document.addEventListener("click", (e) => {
    const pop = el("bf-pop");
    if (!pop || pop.hidden) return;
    if (pop.contains(e.target) || (e.target.closest && e.target.closest(".bf-info, .bf-hz, #bf-health, #bf-slim-problems"))) return;
    bfCloseInfo(false);
  });
}

// --- no silent failures: every IPC call / action goes through these ----------------
function bfActionProblem(action, code, opts) {
  bf.actionProblems.set(action, { code: bfCodeInfo(code) ? code : "IPC_FAILED", opts: Object.assign({ tech: bfCodeInfo(code) ? undefined : `error ${code}` }, opts || {}) });
  bfRenderAll();
}
function bfActionOk(action) { if (bf.actionProblems.delete(action)) bfRenderAll(); }
// Call window.api[method]; a missing method or a thrown error becomes a ⚠️ on `opts.anchor`.
async function bfCall(action, method, args, opts) {
  const fn = window.api && window.api[method];
  if (typeof fn !== "function") { bfActionProblem(action, "IPC_MISSING", Object.assign({ tech: `window.api.${method} is missing` }, opts)); return null; }
  try { return await fn.apply(window.api, args || []); }
  catch (e) { bfActionProblem(action, "IPC_FAILED", Object.assign({ tech: `${method}: ${String((e && e.message) || e).slice(0, 160)}` }, opts)); return null; }
}
// Wrap a click handler: an unexpected throw shows ⚠️ on the panel instead of vanishing.
function bfSafe(fn, where) {
  return async function (...a) {
    try { return await fn.apply(this, a); }
    catch (e) { bfReportUiError(e, where); }
  };
}
function bfReportUiError(e, where) {
  bf.uiError = `${where || "panel"}: ${String((e && e.message) || e).slice(0, 160)}`;
  try { bfRenderAll(); } catch (_) {}
}
// Global safety net: an error thrown from Akọwe panel code anywhere (timers,
// IPC callbacks) shows the ⚠️ instead of silently breaking the panel.
function bfIsPanelError(stack, file) { return /\b(bf[A-Z]\w*|akowe\w*)\b/.test(String(stack || "")) && (!file || /controls\.js/.test(String(file))); }
window.addEventListener("error", (ev) => { try { const st = ev && ev.error && ev.error.stack; if (bfIsPanelError(st || ev.message, ev.filename)) bfReportUiError(ev.error || ev.message, "panel"); } catch (_) {} });
window.addEventListener("unhandledrejection", (ev) => { try { const r = ev && ev.reason; if (bfIsPanelError(r && r.stack)) bfReportUiError(r, "panel"); } catch (_) {} });

// --- P18 self-repair: check-ins and the teach step ----------------------------------
// The AI cards show ok / 🔧 repairing / ⚠️ needs you / ✕ not working (from the main
// process' self-repair, s.sites[x].repair); the ⚠️ pop-over lists what was tried; the
// 🎓 teach box (above the panel body, never a dialog — the AI panes must stay
// visible) walks the user through "Repeat this number: ####". No page text here.
const BF_TRIED_WORD = { FOUND: "found it on the page", FIXED: "✔ fixed it", RETRY: "checked again", NONE_WORKED: "none of them worked", NOT_FOUND: "nothing found", LEARNED: "learned where replies are", RELOADED: "reloaded", RELOAD_FAILED: "the reload failed", PRESSED_STOP: "pressed Stop", NO_STOP_BUTTON: "no Stop button found", STILL_FAILING: "still not answering", NO_WORD: "no answer to search for", WORD_NOT_FOUND: "the answer isn't on the page", NO_STABLE_SELECTOR: "couldn't pin it down", TIMEOUT: "no reply in time", CANCELLED: "cancelled", NOTHING_LEARNED: "couldn't learn anything" };
function bfPartWords(list) { return String(list || "").replace(/assistant/g, "replies").replace(/input/g, "message box").replace(/send/g, "Send button").replace(/stop/g, "Stop button").replace(/\+/g, ", "); }
function bfTriedOutcome(o) {
  const t = String(o || "");
  if (t.startsWith("FOUND:")) return `found another way (${bfPartWords(t.slice(6))})`;
  if (t.startsWith("LEARNED:")) return `learned ${bfPartWords(t.slice(8))}`;
  return BF_TRIED_WORD[t] || t.toLowerCase().replace(/_/g, " ");
}
const BF_PART_FOR = { TYPE_FAILED: "input", SEND_NOT_CONFIRMED: "send", NO_REPLY_FOUND: "assistant", FALSE_DUPLICATE: "assistant" };
const BF_TEACH_PART = { input: "the message box", send: "the Send button", assistant: "the reply area" };
bf.teachDismissed = {};
// The 🔢 number-teach box shows the active number teach, or the latest finished one (until closed).
function bfTeachSite(s) {
  let best = null;
  for (const site of BF_SITES) {
    const R = bfRepairOf((s.sites || {})[site]);
    const t = R.teach;
    if (!t) continue;
    if (t.active) return { site, R, t };
    if (bf.teachDismissed[site] === t.startedAt || t.result === "cancelled") continue;
    if (bfNow() - t.startedAt > 15 * 60000) continue;
    if (!best || t.startedAt > best.t.startedAt) best = { site, R, t };
  }
  return best;
}
function bfRenderTeach(s) {
  const box = el("bf-teach");
  if (!box) return;
  const cur = bfTeachSite(s);
  if (!cur) { box.hidden = true; delete box.dataset.key; return; }
  const { site, R, t } = cur;
  const L = bfLabel(site, s);
  const confirming = !t.active && !t.result;
  const key = JSON.stringify([site, t.startedAt, t.phase, t.active, t.result, t.learned, t.missing, t.failedPart, R.state]);
  box.hidden = false;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const title = el("bf-teach-title"), text = el("bf-teach-text"), steps = el("bf-teach-steps"), acts = el("bf-teach-actions");
  if (!title || !text || !steps || !acts) return;
  text.textContent = ""; steps.textContent = ""; acts.textContent = "";
  const btn = (label, fn, cls, tip) => { const b = bfNode("button", cls || null, label); b.type = "button"; if (tip) b.title = tip; b.onclick = bfSafe(fn, "teach"); acts.appendChild(b); return b; };
  const close = () => { bf.teachDismissed[site] = t.startedAt; bfRenderAll(); };
  const row = (st) => { const li = bfNode("li"); li.dataset.st = st.ok ? "ok" : st.wait ? "wait" : ""; li.append(bfNode("span", "ic", st.ok ? "✔" : st.wait ? "…" : "○"), bfNode("span", null, st.label)); steps.appendChild(li); };
  delete box.dataset.tone;
  if (t.result === "fixed") {
    box.dataset.tone = "ok";
    title.textContent = `✔ Saved — ${L} is working again.`;
    text.textContent = `AutoInjector learned ${L}'s message box, Send button and reply area from the number, saved them, and a new check-in worked. Nothing else to do.`;
    for (const st of teachSteps(t, L)) row(st);
    btn("Close", close, "bf-primary");
    return;
  }
  if (t.active || confirming) {
    title.textContent = `🔢 Number teach — ${L}`;
    text.append("Type ");
    const say = bfNode("span", "bf-teach-say", String(t.number));
    say.title = "Type exactly this number (you can also select it and copy it)";
    text.append(say, ` into ${L}'s message box and press Send. AutoInjector then asks ${L} to write it backwards and learns where its replies appear.`);
    for (const st of teachSteps(t, L)) row(st);
    if (t.active) btn("Cancel", async () => { await bfCall(`teach-cancel-${site}`, "selfRepairTeachCancel", [site], { where: "Cancel the number teach", anchor: `ai:${site}` }); bfMsg(`Cancelled — nothing was changed for ${L}.`); akoweRefresh(); }, null, "Stop — nothing is changed");
    return;
  }
  // finished without fixing it: say which part, offer 🎯 for just that part
  box.dataset.tone = "err";
  const part = PICK_ROLES.includes(t.failedPart) ? t.failedPart : (Array.isArray(t.missing) ? t.missing.find((m) => BF_TEACH_PART[m]) : null);
  if (t.result === "timeout") {
    title.textContent = `${L}: the number didn't show up in time`;
    text.textContent = `AutoInjector waited 4 minutes but didn't see the number in ${L}'s window. Nothing was changed. You can try again whenever you like — type it exactly as shown, then press Send.`;
  } else {
    title.textContent = `${L}: ${part ? `the ${TEACH_PART_WORD[part]} part didn't work` : "still not working"}`;
    const savedTxt = Array.isArray(t.saved) && t.saved.length ? ` Saved: ${t.saved.map((x) => TEACH_PART_WORD[x]).join(", ")}.` : "";
    text.textContent = part
      ? `${part === "assistant" ? `${L} didn't write the number backwards where AutoInjector could find it.` : part === "send" ? "AutoInjector couldn't send its follow-up message." : `AutoInjector couldn't learn ${L}'s message box.`}${savedTxt} Use 🎯 to point at ${BF_TEACH_PART[part]} yourself: press the button, then click it in ${L}'s window and Save.`
      : `AutoInjector learned the page, but a new check-in still didn't work.${savedTxt} Try 🎯, or reload ${L}'s window.`;
  }
  if (part) btn(`🎯 Point at ${BF_TEACH_PART[part]}`, () => { if (openPicker(site, part)) { runPick(site, part); bfMsg(`Click ${BF_TEACH_PART[part]} in ${L}'s window, then press Save on its 🎯 card.`); } }, "bf-primary", `Opens ${L}'s 🎯 card for just this part`);
  btn("🔢 Try again", () => bfTeachStart(site), part ? null : "bf-primary");
  btn(`🔄 Reload ${L}`, () => bfRepairReload(site, L));
  btn("Close", close);
}
async function bfTeachStart(site) {
  const L = bfLabel(site, bf.snap || {});
  const r = await bfCall(`teach-${site}`, "selfRepairTeachStart", [site], { where: `🔢 Number teach for ${L}`, anchor: `ai:${site}`, retryRun: () => bfTeachStart(site), retryLabel: "Try again" });
  if (r && r.ok) { delete bf.teachDismissed[site]; bfMsg(`See the box above: type ${r.number} into ${L}'s message box and press Send.`); }
  else if (r) bfMsg(r.error === "INACTIVE" ? `${L} isn't Active — tick it first.` : r.error === "CHECKING" ? `AutoInjector is checking ${L} right now — try again in a moment.` : `Couldn't start (${r.error || "error"}).`, "err");
  akoweRefresh();
}
const BF_SKIP_WORD = { busy: "is busy", typing: "— you're typing there", inactive: "isn't Active", checking: "is already being checked", teaching: "is waiting for you", akowe: "is answering Akọwe", waiting: "is still answering", sending: "is getting a message", test: "is in a test", relay: "is in a relay", recent: "was just used", not_ready: "isn't loaded" };
async function bfCheckIn(sites) {
  const r = await bfCall("checkin", "selfRepairProbe", [sites || null], { where: "🩺 Check now", anchor: "#bf-checkin-anchor", retryRun: () => bfCheckIn(sites), retryLabel: "Check again" });
  if (!r || r.ok === false) return;
  const skipped = Object.entries(r.skipped || {}).map(([x, why]) => `${bfLabel(x, bf.snap || {})} ${BF_SKIP_WORD[why] || `(${why})`}`);
  bfMsg(`${(r.started || []).length ? `Checking in with ${r.started.map((x) => bfLabel(x, bf.snap || {})).join(", ")}…` : "No check-in started."}${skipped.length ? ` Not now: ${skipped.join("; ")}.` : ""}`);
  akoweRefresh();
}
async function bfRepairReload(site, L) {
  const r = await bfCall(`reload-${site}`, "selfRepairReload", [site], { where: `Reloading ${L || site}`, anchor: `ai:${site}` });
  bfMsg(r && r.ok ? `Reloaded ${L || site} — checking it again…` : `Couldn't reload ${L || site}.`, r && r.ok ? null : "err");
  akoweRefresh();
}
function bfRenderCheckinSetting(s) {
  const sel = el("bf-checkin-every");
  if (!sel || !s.selfRepair || document.activeElement === sel) return;
  const v = String(s.selfRepair.intervalMin);
  if (!Array.from(sel.options).some((o) => o.value === v)) { const o = document.createElement("option"); o.value = v; o.textContent = `every ${v} min`; sel.appendChild(o); }
  if (sel.value !== v) sel.value = v;
}
if (el("btn-bf-checkin")) el("btn-bf-checkin").onclick = bfSafe(() => bfCheckIn(null), "checkin");
if (el("bf-checkin-every")) el("bf-checkin-every").onchange = bfSafe(async (e) => {
  const v = Number(e.target.value);
  const r = await bfCall("checkin-every", "selfRepairSettings", [{ intervalMin: v }], { where: "Check-ins", anchor: "#bf-checkin-anchor" });
  if (r && r.ok) bfMsg(v ? `✓ AutoInjector checks in with idle AIs every ${v >= 60 ? "hour" : `${v} minutes`}.` : "✓ Automatic check-ins are off (🩺 Check now still works).");
  akoweRefresh();
}, "checkin-every");
// P37.3: an AI that couldn't be fixed is announced ONCE, noticeably: its card
// flashes, and (if the user ticked 🔔) a short sound plays. No pop-up loop.
function bfSoundOn() { try { return localStorage.getItem("bf-sound") === "1"; } catch (_) { return false; } }
function bfBeep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false;
    const ctx = new AC(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = "sine"; o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination);
    o.start(); setTimeout(() => { try { o.frequency.value = 660; } catch (_) {} }, 160); setTimeout(() => { try { o.stop(); ctx.close(); } catch (_) {} }, 360);
    return true;
  } catch (_) { return false; }
}
bf.attention = {};
function bfAttention(site) {
  bf.attention[site] = Date.now();
  if (bfSoundOn()) bfBeep();
  const L = bfLabel(site, bf.snap || {});
  bfMsg(`⚠️ ${L} isn't working and AutoInjector couldn't fix it by itself — click its ⚠️, then 🎯 Point at it or 🔢 Do it for me with a number.`, "err");
}
if (el("bf-sound")) {
  try { el("bf-sound").checked = bfSoundOn(); } catch (_) {}
  el("bf-sound").onchange = (e) => { try { localStorage.setItem("bf-sound", e.target.checked ? "1" : "0"); } catch (_) {} if (e.target.checked) bfBeep(); };
}
// Live repair updates (state changes, teach progress) re-render at once.
if (window.api && window.api.onSelfRepair) window.api.onSelfRepair((p) => {
  try {
    if (!p || !p.site || !bf.snap || !bf.snap.sites || !bf.snap.sites[p.site]) return;
    bf.snap.sites[p.site].repair = p.repair;
    if (p.event && p.event.kind === "broken" && p.event.ask) bfAttention(p.site);
    bfRenderAll();
  } catch (e) { bfReportUiError(e, "self-repair update"); }
});

// --- render ------------------------------------------------------------------------
function akoweRender(s) {
  if (!s || !s.ok) return;
  bf.snap = s;
  bf.at = Date.now();
  bf.actionProblems.delete("status");
  bfRenderAll();
}
function bfRenderAll() {
  const s = bf.snap || BF_EMPTY_SNAP;
  try {
    if (el("bf-enabled") && !bf.starting) el("bf-enabled").checked = !!s.enabled;
    const d = bfDerive(s);
    const panel = el("col-akowe");
    if (panel) { panel.dataset.bfState = d.key; panel.dataset.collapsed = bf.collapsed ? "1" : "0"; }
    const st = el("bf-status");
    if (st) { bfSetText(st, d.pill); st.dataset.tone = d.tone; }
    const ht = el("bf-head-text");
    if (ht) {
      const want = `${d.title}${d.sub ? ` · ${d.sub}` : ""}`;
      if (ht.dataset.v !== want) { ht.dataset.v = want; ht.textContent = d.title; if (d.sub) ht.appendChild(bfNode("span", "sub", ` · ${d.sub}`)); ht.title = want; }
    }
    bfText("bf-next", d.next);
    bfRenderConnect(s, d);
    bfRenderAis(s);
    bfRenderTeach(s);
    bfRenderCheckinSetting(s);
    const rows = bfConnRows(s, d);
    bfRenderChecks(s, d, rows);
    bfRenderNow(s, d);
    bfRenderBook(s, d);
    bfRenderActivity(s);
    // health dot (R12): bridge, key, Akọwe reachable, status fresh, each pane
    const h = bfHealthOf(s);
    const dot = el("bf-health");
    if (dot) {
      dot.dataset.level = h.level;
      const words = { ok: "all good", warn: "not fully connected yet", bad: "something needs fixing", off: "bridge off" }[h.level] || h.level;
      const lbl = `Overall health: ${words} — click for details`;
      if (dot.title !== lbl) { dot.title = lbl; dot.setAttribute("aria-label", lbl); }
    }
    // problems + markers
    bf.problems = bfProblemsFor(s, d, rows);
    bfSyncMarkers(bf.problems);
    bfRenderSlim(s, d);
    const det = el("bf-detail");
    if (det) {
      const c = s.counters;
      bfSetText(det, s.enabled && s.listening
        ? `Technical: bridge http://127.0.0.1:${s.port}${c ? ` · ${c.requests} request${c.requests === 1 ? "" : "s"} · ${c.answered} answered · ${c.timeouts} timed out · ${c.unauthorized} refused (wrong key)` : ""}`
        : `Technical: bridge port ${s.port || "?"} · ${s.enabled ? `not listening (${s.error || "starting"})` : "off — nothing is listening"}`);
    }
    if (!bf.test.running && s.linkTest && s.linkTest.lastReport && !bf.test.report) {
      bf.test.report = s.linkTest.lastReport;
      bfShowReportButton();
      const sum = el("bf-test-summary");
      if (sum && !sum.textContent && s.linkTest.lastSummary) {
        const ls = s.linkTest.lastSummary;
        sum.textContent = `Last test ${bfAgo(ls.at)}: ${ls.passCount} passed · ${ls.failCount} failed · ${ls.skipCount} skipped`;
        sum.dataset.tone = ls.failCount ? "err" : "ok";
      }
    }
    bfPlacePop();
  } catch (e) {
    // Never let a bad snapshot break the rest of the controls window.
    if (!bf.uiError) bf.uiError = `render: ${String((e && e.message) || e).slice(0, 160)}`;
    try { bf.problems = [{ id: "ui", code: "UI_ERROR", sev: "err", where: "This panel", anchors: ["#bf-status-anchor"], ctx: {}, tech: bf.uiError, transient: "__ui" }]; bfSyncMarkers(bf.problems); } catch (_) {}
    bfMsg("The Akọwe panel couldn't update — click the ⚠️ for help.", "err");
  }
}
// The slim bar (collapsed): state pill · current step · approvals · ⚠️ count · Open Akọwe.
function bfRenderSlim(s, d) {
  const b = s.akowe;
  const t = b && b.current_task;
  const step = t ? `${bfStepLabel(t) || "Current step"}${t.state ? ` — ${bfStateWord(t.state).word}` : ""}` : d.title;
  bfText("bf-slim-step", step);
  const st = el("bf-slim-step"); if (st) st.title = step;
  const n = Number((b && b.approvals && b.approvals.count) || 0);
  const ap = el("bf-slim-approvals");
  if (ap) { ap.hidden = !(n > 0); bfSetText(ap, `✅ ${n}`); ap.setAttribute("aria-label", `${n} thing${n === 1 ? "" : "s"} waiting for your OK — open the approvals page`); }
  const pc = bf.problems.length;
  const pb = el("bf-slim-problems");
  if (pb) { pb.hidden = !pc; bfSetText(pb, `⚠️ ${pc}`); pb.setAttribute("aria-label", `${pc} problem${pc === 1 ? "" : "s"} — show the first one`); }
  const op = el("btn-bf-slim-open");
  if (op) op.style.display = bfOpenFor(s) ? "" : "none";
}
// L1: is the Akọwe panel open in the sense that it may check on Akọwe in
// the background? Only when the author expanded it themselves: not minimized to a
// tab, not folded to the slim bar, and not merely shown as it is by default.
function bfPanelExpanded(panel, state) {
  return !!(panel && !panel.classList.contains("hidden-collapsed") && state && !state.collapsed && state.userExpanded);
}
async function akoweRefresh() {
  if (!window.api || typeof window.api.akoweStatus !== "function") { bfActionProblem("status", "IPC_MISSING", { where: "The Akọwe status", tech: "window.api.akoweStatus is missing" }); return; }
  let s = null;
  // L1: main only checks whether Akọwe is running (a local GET) while the
  // bridge is on, after Connect / the link test, or while the author has this
  // panel expanded (the default view and the folded slim bar count as closed).
  const panelOpen = bfPanelExpanded(el("col-akowe"), bf);
  try { s = await window.api.akoweStatus({ panelOpen }); }
  catch (e) { bfActionProblem("status", "STATUS_UNAVAILABLE", { tech: `akoweStatus: ${String((e && e.message) || e).slice(0, 160)}` }); return; }
  if (s && s.ok) akoweRender(s);
  else bfActionProblem("status", "STATUS_UNAVAILABLE", { tech: `akoweStatus returned ${s ? JSON.stringify(Object.keys(s)).slice(0, 80) : "nothing"}` });
}
// Live: every bridge event arrives with a fresh snapshot; the 4 s refresh stays as a fallback.
if (window.api && window.api.onAkoweActivity) window.api.onAkoweActivity((p) => { try { if (p && p.status) akoweRender(p.status); } catch (e) { bfReportUiError(e, "live update"); } });
// Tick clocks ("0:42", "12s ago") once a second without asking main.
setInterval(() => { if (bf.snap && el("col-akowe") && !el("col-akowe").classList.contains("hidden-collapsed")) bfRenderAll(); }, 1000);

// --- ▾/▸ collapse to a slim status bar (remembered) ---------------------------------
function bfSetCollapsed(on, save) {
  bf.collapsed = !!on;
  const btn = el("btn-collapse-akowe");
  if (btn) {
    btn.textContent = on ? "▸" : "▾";
    btn.setAttribute("aria-expanded", String(!on));
    const t = on ? "Expand the Akọwe panel" : "Collapse to a slim status bar";
    btn.title = t; btn.setAttribute("aria-label", t);
  }
  if (on) bfCloseInfo(false);
  if (save) { bfStore.set("bf-collapsed", on ? "1" : "0"); if (!on) bf.userExpanded = true; }
  bfRenderAll();
}
bf.collapsed = bfStore.get("bf-collapsed") === "1";
bf.userExpanded = bfStore.get("bf-collapsed") === "0"; // the author expanded the panel themselves (L1)
if (el("btn-collapse-akowe")) el("btn-collapse-akowe").onclick = () => bfSetCollapsed(!bf.collapsed, true);
if (el("bf-title")) {
  const h2 = el("bf-title");
  h2.setAttribute("role", "button");
  h2.setAttribute("tabindex", "0");
  h2.addEventListener("click", () => bfSetCollapsed(!bf.collapsed, true));
  h2.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bfSetCollapsed(!bf.collapsed, true); } });
}
bfSetCollapsed(bf.collapsed, false);
if (el("bf-slim-problems")) el("bf-slim-problems").onclick = bfSafe(() => {
  const first = bf.problems[0];
  bfSetCollapsed(false, true);
  if (!first) return;
  const m = el("col-akowe").querySelector(`.bf-hz[data-pid="${CSS.escape(first.id)}"]`);
  if (m) { try { m.scrollIntoView({ block: "nearest" }); } catch (_) {} bfOpenProblem(m); }
}, "slim bar");
if (el("bf-slim-approvals")) el("bf-slim-approvals").onclick = () => { const s = bf.snap || {}; const b = s.akowe || {}; bfOpen((b.approvals && b.approvals.url) || bfOpenFor(s), "the approvals page", "approve"); };
if (el("btn-bf-slim-open")) el("btn-bf-slim-open").onclick = () => bfOpen(bfOpenFor(bf.snap || {}), "Akọwe", "open");
if (el("btn-bf-checks-more")) el("btn-bf-checks-more").onclick = () => { const ol = el("bf-conn-steps"); bf.checksOpen = !!(ol && ol.hidden); bfRenderAll(); };
if (el("btn-bf-book-more")) el("btn-bf-book-more").onclick = () => { bf.bookOpen = !bf.bookOpen; bfRenderAll(); };
if (el("bf-act-card")) el("bf-act-card").addEventListener("toggle", () => bfRenderAll());

// --- Bridge switch -----------------------------------------------------------------
async function bfSetEnabled(want) {
  bf.starting = want;
  if (bf.snap) { bf.snap.enabled = want; }
  bfMsg("");
  bfRenderAll();
  const s = await bfCall("bridge", "akoweSetEnabled", [want], { where: "The Bridge switch", anchor: "#bf-switch-anchor", retryRun: () => bfSetEnabled(want), retryLabel: want ? "Turn the bridge on" : "Turn the bridge off" });
  bf.starting = false;
  if (s && s.ok) { bfActionOk("bridge"); akoweRender(s); }
  else { if (s) bfActionProblem("bridge", "IPC_FAILED", { where: "The Bridge switch", anchor: "#bf-switch-anchor", tech: `setEnabled -> ${String(s.error || "no ok")}`, retryRun: () => bfSetEnabled(want) }); await akoweRefresh(); }
}
async function bfRestartBridge() {
  const s0 = bf.snap || {};
  if (s0.enabled) { await bfSetEnabled(false); }
  await bfSetEnabled(true);
}
if (el("bf-enabled")) el("bf-enabled").onchange = bfSafe(() => bfSetEnabled(el("bf-enabled").checked), "the Bridge switch");

// --- 🔗 Connect Akọwe -------------------------------------------------------
async function bfConnect() {
  if (bf.connecting) return;
  bf.connecting = true;
  bf.localMsg = null;
  bfMsg("");
  bfRenderAll();
  const s = await bfCall("connect", "akoweConnect", [], { where: "🔗 Connect Akọwe", anchor: "#bf-connect-anchor", retryRun: () => bfConnect(), retryLabel: "Connect again" });
  bf.connecting = false;
  if (s && s.ok) { bfActionOk("connect"); akoweRender(s); }
  else { if (s) bfActionProblem("connect", "CONNECT_FAILED", { where: "🔗 Connect Akọwe", anchor: "#bf-connect-anchor", tech: "connect returned no snapshot", retryRun: () => bfConnect() }); bfRenderAll(); }
}
if (el("btn-bf-connect")) el("btn-bf-connect").onclick = bfSafe(() => bfConnect(), "Connect");
async function bfStartApp() {
  if (bf.startingApp) return;
  bf.startingApp = true;
  bf.localMsg = null;
  bfRenderAll();
  const r = await bfCall("startapp", "akoweStartApp", [], { where: "▶ Start Akọwe for me", anchor: "#bf-connect-anchor", retryRun: () => bfStartApp() });
  bf.startingApp = false;
  if (r && r.ok && r.running) { bfActionOk("startapp"); await bfConnect(); return; } // it's up — finish connecting by itself
  if (r) bfActionProblem("startapp", r.ok ? "STILL_STARTING" : (r.error || "SPAWN_FAILED"), { where: "▶ Start Akọwe for me", anchor: "#bf-connect-anchor", msg: r.message, tech: `start-app -> ${r.ok ? "started, not answering yet" : r.error || "error"}` });
  bfRenderAll();
}
if (el("btn-bf-start-app")) el("btn-bf-start-app").onclick = bfSafe(() => bfStartApp(), "Start Akọwe");
// Open an Akọwe page; `action` names the button that gets the ⚠️ if it fails.
const BF_OPEN_ANCHOR = { open: "#bf-open-anchor", approve: "#bf-approve-anchor", goto: "#bf-goto-anchor" };
async function bfOpen(url, what, action) {
  const key = `open-${action || "open"}`;
  const opts = { where: `Opening ${what}`, anchor: BF_OPEN_ANCHOR[action] || "#bf-open-anchor", retryRun: () => bfOpen(url, what, action), retryLabel: `Open ${what}` };
  const r = await bfCall(key, "akoweOpenUrl", [url || ""], opts);
  if (r && r.ok) { bfActionOk(key); bfMsg(""); }
  else if (r) bfActionProblem(key, r.error || "OPEN_FAILED", Object.assign({ msg: r.message }, opts));
}
if (el("btn-bf-approve")) el("btn-bf-approve").onclick = () => { const s = bf.snap || {}; const b = s.akowe || {}; bfOpen((b.approvals && b.approvals.url) || bfOpenFor(s), "the approvals page", "approve"); };
if (el("btn-bf-goto-task")) el("btn-bf-goto-task").onclick = () => { const s = bf.snap || {}; const b = s.akowe || {}; bfOpen((b.current_task && b.current_task.url) || bfOpenFor(s), "the current task", "goto"); };
if (el("btn-bf-open")) el("btn-bf-open").onclick = () => bfOpen(bfOpenFor(bf.snap || {}), "Akọwe", "open");
// 🔁 Reload an AI's window (the app's own reload).
async function bfReloadPane(site, L) {
  if (!site) return;
  const r = await bfCall(`reload-${site}`, "reloadSite", [site], { where: `Reloading ${L || site}`, anchor: `ai:${site}`, retryRun: () => bfReloadPane(site, L), retryLabel: `Reload ${L || site}` });
  if (r && r.ok === false) bfActionProblem(`reload-${site}`, "IPC_FAILED", { where: `Reloading ${L || site}`, anchor: `ai:${site}`, tech: `reloadSite -> ${r.error || "failed"}` });
  else if (r) { bfActionOk(`reload-${site}`); bfMsg(`Reloading ${L || site}… give it a few seconds to load.`); }
  setTimeout(() => { akoweRefresh(); }, 3000);
}

// --- 📋 Copy diagnostics (safe: no key, codes, prompts or replies) ---------------
async function bfCopyDiagnostics() {
  const extra = { panelProblems: bf.problems.map((p) => p.code) };
  const opts = { where: "📋 Copy diagnostics", anchor: "#bf-diag-anchor", retryRun: () => bfCopyDiagnostics(), retryLabel: "Copy diagnostics" };
  const r = await bfCall("diag", "akoweCopyDiagnostics", [extra], opts);
  if (r && r.ok) { bfActionOk("diag"); bfMsg("✓ Diagnostics copied — paste them into your message. They never contain your key, codes, prompts or replies."); return; }
  if (r && r.text) { // no clipboard: show the text to copy by hand
    bfActionOk("diag");
    bfOpenPop(el("btn-bf-diag"), "info", (title, body) => {
      title.textContent = "📋 Diagnostics";
      body.appendChild(bfNode("p", null, "Copying didn't work here — select all of this text (Ctrl+A) and copy it (Ctrl+C). It contains no key, codes, prompts or replies."));
      const ta = bfNode("textarea"); ta.readOnly = true; ta.value = r.text; body.appendChild(ta);
      setTimeout(() => { try { ta.focus(); ta.select(); } catch (_) {} }, 0);
    });
    return;
  }
  if (r) bfActionProblem("diag", r.error || "DIAGNOSTICS_FAILED", opts);
}
if (el("btn-bf-diag")) el("btn-bf-diag").onclick = bfSafe(() => bfCopyDiagnostics(), "Copy diagnostics");

// --- Other ways: the key by hand ---------------------------------------------------
async function bfCopyKey() {
  const opts = { where: "📋 Copy connection key", anchor: "#bf-copy-anchor", retryRun: () => bfCopyKey(), retryLabel: "Copy the key" };
  const r = await bfCall("copykey", "akoweCopyToken", [], opts);
  if (r && r.ok) {
    bfActionOk("copykey");
    bfStore.set("bf-key-copied", "1");
    bfMsg("✓ Connection key copied. Now in Akọwe open Settings → Connect AutoInjector and paste it (Ctrl+V).");
  } else if (r) bfActionProblem("copykey", r.error || "NO_CLIPBOARD", opts);
}
if (el("btn-bf-copy")) el("btn-bf-copy").onclick = bfSafe(() => bfCopyKey(), "Copy connection key");
async function bfRevealKey() {
  const box = el("bf-token");
  if (!box) return;
  if (box.style.display !== "none") { box.style.display = "none"; box.textContent = ""; el("btn-bf-reveal").textContent = "Show key"; return; }
  const opts = { where: "Show key", anchor: "#bf-reveal-anchor", retryRun: () => bfRevealKey(), retryLabel: "Show the key" };
  const r = await bfCall("reveal", "akoweRevealToken", [], opts);
  if (r && r.ok) {
    bfActionOk("reveal");
    box.textContent = r.token; box.style.display = "block"; el("btn-bf-reveal").textContent = "Hide key";
    bfMsg("This is your connection key. Keep it private — click Hide key when you're done.");
  } else if (r) bfActionProblem("reveal", r.error || "TOKEN_UNAVAILABLE", opts);
}
if (el("btn-bf-reveal")) el("btn-bf-reveal").onclick = bfSafe(() => bfRevealKey(), "Show key");
async function bfRegenKey() {
  if (!window.confirm("Make a new connection key?\n\nThe old key stops working right away, so Akọwe is disconnected until it gets the new key (press Connect Akọwe again).\n\nOnly do this if you think someone else has seen your key.")) return;
  const opts = { where: "Make a new key", anchor: "#bf-regen-anchor" };
  const s = await bfCall("regen", "akoweRegenerateToken", [], opts);
  if (s && s.ok) {
    bfActionOk("regen");
    bfStore.set("bf-key-copied", null);
    const box = el("bf-token");
    if (box) { box.style.display = "none"; box.textContent = ""; }
    if (el("btn-bf-reveal")) el("btn-bf-reveal").textContent = "Show key";
    akoweRender(s);
    bfMsg("New connection key made. Press “🔗 Connect Akọwe” to hand it to Akọwe.");
  } else if (s) bfActionProblem("regen", s.error || "TOKEN_WRITE_FAILED", opts);
}
if (el("btn-bf-regen")) el("btn-bf-regen").onclick = bfSafe(() => bfRegenKey(), "Make a new key");

// --- 🧪 Test the connection (the real link test, ticking the same chips/rows) --------
function bfShowReportButton() { const b = el("btn-bf-test-report"); if (b) b.style.display = bf.test.report ? "" : "none"; }
function bfTestButtons(running) {
  const b = el("btn-bf-test");
  if (b) { b.disabled = running; b.textContent = running ? "🧪 Testing…" : "🧪 Test the connection"; }
  if (el("btn-bf-test-stop")) el("btn-bf-test-stop").style.display = running ? "" : "none";
}
function bfTestStep(p) {
  if (!p || !p.id) return;
  bf.test.results.set(p.id, Object.assign({}, bf.test.results.get(p.id) || {}, p));
  if (p.total && el("bf-test-summary") && bf.test.running) el("bf-test-summary").textContent = `Testing… ${Math.min(p.index + (p.status === "running" ? 1 : 0), p.total)} of ${p.total}`;
  bfRenderAll();
}
if (window.api && window.api.onAkoweLinkTestProgress) window.api.onAkoweLinkTestProgress((p) => {
  try {
    if (!p) return;
    if (p.status === "start" || p.status === "done") return; // handled by the run() call itself
    bfTestStep(p);
  } catch (e) { bfReportUiError(e, "link test progress"); }
});
async function bfRunLinkTest() {
  if (bf.test.running) return;
  bf.test.running = true;
  bf.test.results.clear();
  bf.test.report = null;
  bfShowReportButton();
  const sum = el("bf-test-summary");
  if (sum) { sum.textContent = "Starting the test…"; delete sum.dataset.tone; }
  bfTestButtons(true);
  bfRenderAll();
  const opts = { where: "🧪 Test the connection", anchor: "#bf-test-anchor", retryRun: () => bfRunLinkTest(), retryLabel: "Run the test again" };
  let r = null;
  try { r = await bfCall("linktest", "akoweLinkTestRun", [], opts); }
  finally { bf.test.running = false; bfTestButtons(false); }
  if (r && r.ok) {
    bfActionOk("linktest");
    for (const st of r.steps || []) bf.test.results.set(st.id, Object.assign({}, st));
    if (sum) { sum.textContent = `${r.failCount ? `${r.failCount} problem${r.failCount === 1 ? "" : "s"} — click the ⚠️` : "All good ✔"} · ${r.passCount} passed · ${r.failCount} failed · ${r.skipCount} skipped${r.report ? " · report saved" : ""}`; sum.dataset.tone = r.failCount ? "err" : "ok"; }
    bf.test.report = r.report || null;
    bfShowReportButton();
  } else if (r) {
    if (sum) { sum.textContent = "The test couldn't run — click the ⚠️."; sum.dataset.tone = "err"; }
    bfActionProblem("linktest", r.error === "ALREADY_RUNNING" ? "ALREADY_RUNNING" : "LINKTEST_COULDNT_RUN", Object.assign({ tech: `linktest-run -> ${String(r.error || "error").slice(0, 120)}` }, opts));
  } else if (sum) { sum.textContent = ""; }
  bfRenderAll();
  akoweRefresh();
}
if (el("btn-bf-test")) el("btn-bf-test").onclick = bfSafe(() => bfRunLinkTest(), "Test the connection");
if (el("btn-bf-test-stop")) el("btn-bf-test-stop").onclick = bfSafe(async () => {
  const r = await bfCall("linkstop", "akoweLinkTestStop", [], { where: "■ Stop test", anchor: "#bf-test-anchor" });
  if (r && el("bf-test-summary")) el("bf-test-summary").textContent = "Stopping… (finishing the current check)";
}, "Stop test");
if (el("btn-bf-test-report")) el("btn-bf-test-report").onclick = bfSafe(async () => {
  if (!bf.test.report) return;
  const opts = { where: "📄 Last report", anchor: "#bf-report-anchor", tech: "report file in the logs folder" };
  const r = await bfCall("report", "akoweOpenLinkTestReport", [bf.test.report], opts);
  if (r && r.ok) bfActionOk("report");
  else if (r) bfActionProblem("report", r.error === "BAD_FILE" ? "BAD_FILE" : "BAD_FILE", Object.assign({}, opts, { tech: `open-report -> ${String(r.error || "error").slice(0, 80)}` }));
}, "Open report");

el("btn-clear").onclick = async () => {
  const res = await window.api.clearTranscript();
  if (res?.ok) renderTranscript([]);
};

// ⤓ Extract (P16): the button opens a small dialog that asks what goes into the
// file — "This Akọwe book only" (the default when a book is known), a time
// range, or Everything (with a warning) — shows the counts and the first lines,
// and saves only on "Save". main builds the text (log-extract.js) and redacts it.
const exState = { opts: null, timer: null, seq: 0, open: false, everything: null };
// The last choice is remembered for next time (this viewer only) — except
// Everything, which is never pre-selected: it always takes a fresh, confirmed pick.
const EX_LAST_KEY = "autoinjector.extract.last";
function exLoadLast() {
  try {
    const v = JSON.parse(window.localStorage.getItem(EX_LAST_KEY) || "null");
    if (!v || typeof v !== "object" || (v.scope !== "book" && v.scope !== "time")) return null;
    return v;
  } catch (_) { return null; }
}
function exSaveLast(opts) {
  if (!opts || (opts.scope !== "book" && opts.scope !== "time")) return; // never Everything
  const v = { scope: opts.scope, include: opts.include || null };
  if (opts.scope === "book") v.bookId = opts.bookId || null;
  if (opts.scope === "time") v.preset = opts.preset || "custom";
  try { window.localStorage.setItem(EX_LAST_KEY, JSON.stringify(v)); } catch (_) { /* storage blocked: just don't remember */ }
}
function exHideConfirm() {
  const c = el("ex-confirm-all"); if (c) c.hidden = true;
  const save = el("btn-extract-save"); if (save) save.hidden = false;
}
function exPad(n) { return String(n).padStart(2, "0"); }
function exLocalInput(ms) { const d = new Date(ms); return `${d.getFullYear()}-${exPad(d.getMonth() + 1)}-${exPad(d.getDate())}T${exPad(d.getHours())}:${exPad(d.getMinutes())}`; }
function exShortDate(ms) { try { return ms ? new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""; } catch (_) { return ""; } }
function exScope() { const r = document.querySelector('input[name="ex-scope"]:checked'); return r ? r.value : "time"; }
function exGather() {
  const scope = exScope();
  const o = { scope, include: { conversation: !!el("ex-inc-conv").checked, activity: !!el("ex-inc-act").checked, relay: !!el("ex-inc-relay").checked } };
  if (scope === "book") o.bookId = el("ex-book").value || null;
  if (scope === "time") {
    const preset = el("ex-preset").value;
    if (preset === "custom") {
      const f = Date.parse(el("ex-from").value), t = Date.parse(el("ex-to").value);
      o.from = Number.isFinite(f) ? f : Date.now() - 3600000;
      o.to = Number.isFinite(t) ? t : Date.now();
    } else o.preset = preset;
  }
  return o;
}
function exSyncUi() {
  const scope = exScope();
  for (const [id, v] of [["ex-scope-book-row", "book"], ["ex-scope-time-row", "time"], ["ex-scope-all-row", "everything"]]) {
    const row = el(id); if (row) row.classList.toggle("sel", scope === v);
  }
  const custom = el("ex-custom"); if (custom) custom.hidden = el("ex-preset").value !== "custom";
}
async function exRefreshPreview() {
  exSyncUi();
  exHideConfirm(); // a changed choice needs a fresh confirmation
  const my = ++exState.seq;
  const counts = el("ex-counts");
  const opts = exGather();
  let r;
  try { r = await window.api.extractPreview(opts); } catch (e) { r = { ok: false, error: e && e.message ? e.message : String(e) }; }
  if (my !== exState.seq || !exState.open) return; // a newer choice is already being previewed
  const save = el("btn-extract-save");
  if (!r || !r.ok) {
    counts.textContent = r && r.error === "NO_BOOK" ? "No Akọwe book has been recorded yet — choose a time range instead." : `Preview failed: ${(r && r.error) || "unknown error"}`;
    el("ex-preview").textContent = "";
    el("ex-file").textContent = "";
    if (save) save.disabled = true;
    return;
  }
  if (save) save.disabled = false;
  const c = r.counts || {};
  const parts = [];
  parts.push(opts.include.conversation ? `<b>${c.messages}</b> AI message${c.messages === 1 ? "" : "s"}` : "no AI messages");
  parts.push(opts.include.activity ? `<b>${c.events}</b> activity event${c.events === 1 ? "" : "s"}` : "no activity log");
  parts.push(opts.include.relay ? `relay trace (${c.relayMessages == null ? "?" : c.relayMessages} sent)` : "no relay trace");
  counts.innerHTML = `Will save: ${parts.join(" · ")}${r.redactions ? ` · ${r.redactions} secret${r.redactions === 1 ? "" : "s"}/path${r.redactions === 1 ? "" : "s"} redacted` : ""}`;
  el("ex-preview").textContent = r.preview || "";
  el("ex-file").textContent = r.fileName ? `File: ${r.fileName}` : "";
  el("ex-file").title = r.fileName || "";
  exState.opts = opts;
  exState.everything = opts.scope === "everything" ? { messages: c.messages, oldestAt: r.oldestAt, text: r.everything && r.everything.text } : null;
}
function exPreviewSoon() { clearTimeout(exState.timer); exState.timer = setTimeout(exRefreshPreview, 120); }
function exClose(note) {
  exState.open = false;
  const m = el("extract-modal"); if (m) m.classList.remove("on");
  const status = el("extract-status"); if (status && note) status.textContent = note;
  const btn = el("btn-extract-all"); if (btn) { btn.disabled = false; try { btn.focus(); } catch (_) {} }
}
async function exOpen() {
  const m = el("extract-modal");
  const status = el("extract-status");
  if (!m || !window.api.extractOptions) return exSaveDirect();
  exState.open = true;
  m.classList.add("on");
  el("ex-counts").textContent = "Loading preview…";
  el("ex-preview").textContent = "";
  let o = null;
  try { o = await window.api.extractOptions(); } catch (_) { o = null; }
  if (!exState.open) return;
  const books = (o && o.ok && Array.isArray(o.books)) ? o.books : [];
  const sel = el("ex-book");
  sel.innerHTML = "";
  for (const b of books) {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = `${b.title}${b.current ? " (current)" : ""} — ${b.requests} request${b.requests === 1 ? "" : "s"}${b.lastAt ? `, last ${exShortDate(b.lastAt)}` : ""}`;
    sel.appendChild(opt);
  }
  const bookRow = el("ex-scope-book-row");
  const bookRadio = el("ex-scope-book");
  bookRadio.disabled = !books.length;
  sel.disabled = !books.length;
  if (sel.parentElement) sel.parentElement.hidden = !books.length; // no empty picker when no book is known
  bookRow.classList.toggle("disabled", !books.length);
  el("ex-book-why").textContent = books.length
    ? "Only the AIs' replies to Akọwe's requests for this book, and the activity of those requests. Your other conversations are left out."
    : "No Akọwe book has been recorded yet (Akọwe hasn't sent this app any requests).";
  const def = (o && o.default) || { scope: "time", preset: "day" };
  // Never "Everything" by default — the safe one-click choice is the book, else a
  // time range (last 24 hours). A remembered last choice (never Everything) wins
  // when it still applies.
  const last = exLoadLast();
  const useLast = last && (last.scope === "time" || (last.scope === "book" && books.length));
  const pick = useLast ? last : def;
  const scope = pick.scope === "book" && books.length ? "book" : "time";
  const bookId = pick.scope === "book" && pick.bookId && books.some((b) => b.id === pick.bookId) ? pick.bookId : def.bookId;
  if (scope === "book" && bookId) sel.value = bookId;
  const presets = ["hour", "today", "day", "custom"];
  el("ex-preset").value = scope === "time" && presets.includes(pick.preset) ? pick.preset : (def.preset || "day");
  el(scope === "book" ? "ex-scope-book" : "ex-scope-time").checked = true;
  exHideConfirm();
  const inc = (useLast && last.include) || def.include || {};
  el("ex-inc-conv").checked = inc.conversation !== false;
  el("ex-inc-act").checked = inc.activity !== false;
  el("ex-inc-relay").checked = inc.relay !== false;
  const now = Date.now();
  el("ex-from").value = exLocalInput(now - 3600000);
  el("ex-to").value = exLocalInput(now);
  if (status) status.textContent = "Choose what to extract…";
  try { el("btn-extract-save").focus(); } catch (_) {}
  await exRefreshPreview();
}
async function exSaveDirect(opts) {
  const status = el("extract-status");
  const btn = el("btn-extract-all");
  if (status) status.textContent = "Extracting…";
  if (btn) btn.disabled = true;
  try {
    const res = await window.api.extractAllLogs(opts);
    if (res && res.ok) exSaveLast(opts);
    if (res && res.ok) {
      const what = res.scope === "book" ? `book “${res.book && res.book.title}” only` : res.scope === "everything" ? "everything" : "time range";
      if (status) { status.textContent = `Saved ${res.messages} messages + ${res.logEntries} log entries (${what}) → ${res.file}`; status.title = status.textContent; }
    } else if (status) {
      status.textContent = res && res.error === "CONFIRM_EVERYTHING" ? `Nothing saved — ${res.message || "Everything needs a second confirmation."}` : `Extract failed: ${(res && res.error) || "unknown error"}`;
    }
  } catch (e) {
    if (status) status.textContent = `Extract failed: ${e && e.message ? e.message : e}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}
el("btn-extract-all").onclick = () => exOpen();
el("btn-extract-cancel").onclick = () => exClose("Extract cancelled — nothing was saved.");
function exDateOnly(ms) { try { return new Date(ms).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" }); } catch (_) { return ""; } }
// Everything asks a second time, naming what is in it.
function exShowConfirm() {
  const box = el("ex-confirm-all"); if (!box) return false;
  const ev = exState.everything || {};
  const n = Number(ev.messages) || 0;
  const inc = (exState.opts && exState.opts.include) || {};
  const what = inc.conversation === false
    ? `the activity log of all of the app's saved history${ev.oldestAt ? ` going back to ${exDateOnly(ev.oldestAt)}` : ""} (no AI conversation text)`
    : (ev.text || `${n.toLocaleString("en-US")} message${n === 1 ? "" : "s"}${ev.oldestAt ? ` going back to ${exDateOnly(ev.oldestAt)}` : ""}, including older private conversations`);
  el("ex-confirm-all-text").textContent = `⚠ Save EVERYTHING? This file will hold ${what}. Anyone you share it with can read all of it.`;
  box.hidden = false;
  const save = el("btn-extract-save"); if (save) save.hidden = true;
  try { el("btn-extract-confirm-back").focus(); } catch (_) {}
  return true;
}
el("btn-extract-save").onclick = async () => {
  const opts = exGather();
  if (opts.scope === "everything") {
    // a stale preview (still loading) must not be confirmed blind
    if (!exState.everything || !exState.opts || exState.opts.scope !== "everything") { await exRefreshPreview(); }
    exShowConfirm();
    return;
  }
  exClose(null);
  await exSaveDirect(opts);
};
if (el("btn-extract-confirm-back")) el("btn-extract-confirm-back").onclick = () => { exHideConfirm(); try { el("btn-extract-save").focus(); } catch (_) {} };
if (el("btn-extract-confirm-all")) el("btn-extract-confirm-all").onclick = async () => {
  const opts = exGather();
  if (opts.scope !== "everything") { exHideConfirm(); return; }
  uiLog("click", { id: "btn-extract-confirm-all", msg: "confirmed: extract everything" });
  exClose(null);
  await exSaveDirect(Object.assign({}, opts, { confirmEverything: true }));
};
for (const id of ["ex-scope-book", "ex-scope-time", "ex-scope-all", "ex-inc-conv", "ex-inc-act", "ex-inc-relay", "ex-book", "ex-preset", "ex-from", "ex-to"]) {
  const x = el(id); if (x) x.addEventListener("change", exPreviewSoon);
}
for (const id of ["ex-preset", "ex-from", "ex-to"]) { const x = el(id); if (x) x.addEventListener("change", () => { el("ex-scope-time").checked = true; }); }
{ const x = el("ex-book"); if (x) x.addEventListener("change", () => { if (!el("ex-scope-book").disabled) el("ex-scope-book").checked = true; }); }
el("extract-modal").addEventListener("click", (e) => { if (e.target === el("extract-modal")) exClose("Extract cancelled — nothing was saved."); });
el("extract-modal").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); exClose("Extract cancelled — nothing was saved."); } });

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
  akoweRefresh();
  setInterval(akoweRefresh, 4000);
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

// ISS-001: the AI panes are native views drawn ON TOP of this page. Ask main to
// re-place them the moment the page scrolls or a dialog opens/closes, so they
// never sit over the sticky User Panel or a pop-up.
function wirePaneSync() {
  if (!window.api || typeof window.api.syncPanes !== "function") return;
  let queued = false;
  const kick = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; try { const p = window.api.syncPanes(); if (p && p.catch) p.catch(() => {}); } catch (_) {} });
  };
  window.addEventListener("scroll", kick, { passive: true, capture: true });
  window.addEventListener("resize", kick, { passive: true });
  const mo = new MutationObserver(kick);
  for (const d of document.querySelectorAll('[role="dialog"], dialog')) mo.observe(d, { attributes: true, attributeFilter: ["class", "style", "open", "hidden"] });
  // Anything that changes size ABOVE or IN the AI windows (the User Panel, the
  // top tab strip, a pane opened/reduced/minimized, a slot resizing) moves the
  // slots: re-place the panes right away instead of on the next timer tick.
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(kick);
    for (const id of ["top-tab-strip", "col-userpanel", "collapsed-strip", "ai-row", "expanded-strip"]) { const n = el(id); if (n) ro.observe(n); }
    for (const n of document.querySelectorAll(".pane-slot")) ro.observe(n);
  }
  // A pane switching open / reduced / minimized (a class change), or the panes being built.
  // (Class changes only — not text, so a streaming reply preview doesn't re-place the panes all the time.)
  if (el("expanded-strip")) {
    mo.observe(el("expanded-strip"), { subtree: true, attributes: true, attributeFilter: ["class", "hidden"] });
    new MutationObserver(kick).observe(el("expanded-strip"), { childList: true });
  }
}
try { wirePaneSync(); } catch (e) { console.error("pane sync init failed", e); }

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


// ---- 📖 Akọwe tab: one app, one launcher ------------------------------------
// AutoInjector starts Akọwe's server itself (main.js + akowe-server.js) and lays
// the real Akọwe page over #akowe-slot when this tab shows. Here: the two tabs,
// what the server is doing in plain words, and the buttons (Try again, Open
// log, Get Python, Pop out / Bring back, Reload, Start with AutoInjector).
function wireAkoweTab() {
  const api = window.api || {};
  if (!el("tab-app-akowe") || typeof api.akoweServerStatus !== "function") return;
  let last = null;
  const BUSY = ["checking", "finding_python", "preparing", "installing", "starting", "restarting"];
  function setTab(which) {
    const ak = which === "akowe";
    document.body.dataset.appTab = ak ? "akowe" : "main";
    el("tab-app-main").setAttribute("aria-selected", String(!ak));
    el("tab-app-akowe").setAttribute("aria-selected", String(ak));
    el("akowe-tab").hidden = !ak;
    // The 🎨 Images tab (images-studio.js) is the third tab; any switch here hides it.
    if (el("tab-app-images")) el("tab-app-images").setAttribute("aria-selected", "false");
    if (el("images-tab")) el("images-tab").hidden = true;
    // …and the 🎬 Video tab (videos-studio.js).
    if (el("tab-app-video")) el("tab-app-video").setAttribute("aria-selected", "false");
    if (el("video-tab")) el("video-tab").hidden = true;
    try { if (api.akoweTab) api.akoweTab(ak); } catch (_) {}
    try { localStorage.setItem("akoweTab", ak ? "akowe" : "main"); } catch (_) {}
  }
  function btn(label, onClick, opts) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label;
    if (opts && opts.id) b.id = opts.id;
    if (opts && opts.primary) b.className = "primary";
    b.onclick = onClick;
    return b;
  }
  const tryAgain = () => btn("↻ Try again", async () => { render(await api.akoweServerRetry()); }, { id: "btn-akowe-retry", primary: true });
  const openLog = () => btn("📄 Open log", () => api.akoweServerOpenLog(), { id: "btn-akowe-openlog" });
  function render(st) {
    if (!st || typeof st !== "object") return;
    last = st;
    const phase = st.phase || "idle";
    const popped = !!(st.view && st.view.popped);
    const tone = phase === "running" ? "ok" : phase === "failed" ? "error" : BUSY.includes(phase) ? "busy" : "off";
    el("akowe-tab-dot").dataset.tone = tone;
    el("akowe-autostart").checked = st.startWithApp !== false;
    const where = st.port ? ` · port ${st.port}` : "";
    const stateText = {
      running: st.owned ? `✅ Akọwe is running${where}` : `✅ Using the Akọwe you started${where}`,
      failed: "⚠ Akọwe isn't running", stopped: "⏹ Akọwe is stopped", idle: st.enabled ? "Akọwe" : "Akọwe doesn't start with AutoInjector",
    }[phase] || `⏳ ${st.message || "Starting Akọwe…"}`;
    el("akowe-tab-state").textContent = stateText;
    el("btn-akowe-popout").textContent = popped ? "⇲ Bring back" : "⇱ Pop out";
    el("btn-akowe-popout").disabled = phase !== "running" || !(st.view && (st.view.loaded || popped));
    el("btn-akowe-reload").disabled = phase !== "running";
    const notice = el("akowe-notice");
    const title = el("akowe-notice-title"), text = el("akowe-notice-text"), small = el("akowe-notice-small"), acts = el("akowe-notice-actions");
    acts.textContent = "";
    notice.dataset.tone = tone;
    small.textContent = "Everything else in AutoInjector works without Akọwe.";
    if (phase === "running" && popped) {
      title.textContent = "Akọwe is open in its own window";
      text.textContent = "Close that window, or press Bring it back, to see Akọwe here again.";
      acts.append(btn("⇲ Bring it back", () => api.akoweDock().then((r) => render(r && r.status)), { primary: true }));
      small.textContent = "";
    } else if (phase === "running") {
      title.textContent = st.hasToken ? "Opening Akọwe…" : "Akọwe is running";
      text.textContent = st.hasToken ? "Akọwe's page appears here in a moment." : (st.message || "AutoInjector can't sign in to this Akọwe. Use the link in Akọwe's own window.");
      small.textContent = "";
    } else if (phase === "failed") {
      title.textContent = st.error === "NO_PYTHON" ? "Akọwe needs Python" : st.error === "NO_APP" ? "Akọwe wasn't found" : "Akọwe couldn't start";
      text.textContent = st.message || "Something went wrong while starting Akọwe.";
      if (st.error === "NO_PYTHON") acts.append(btn("⬇ Get Python", () => api.akoweServerGetPython(), { id: "btn-akowe-getpython", primary: true }), tryAgain());
      else if (st.error === "NO_APP") acts.append(tryAgain());
      else acts.append(tryAgain(), openLog());
    } else if (phase === "stopped" || (phase === "idle" && !st.enabled)) {
      title.textContent = st.enabled ? "Akọwe is stopped" : "Akọwe doesn't start with AutoInjector";
      text.textContent = st.enabled ? "Press Start to run it again." : "“Start with AutoInjector” is off. Start it now, or turn that back on.";
      acts.append(btn("▶ Start Akọwe now", async () => { render(await api.akoweServerRetry()); }, { id: "btn-akowe-start", primary: true }));
    } else {
      title.textContent = phase === "restarting" ? "Akọwe is restarting" : "Starting Akọwe…";
      text.textContent = st.message || "Akọwe starts together with AutoInjector.";
      small.textContent = "The first start can take a few minutes. Everything else in AutoInjector works meanwhile.";
      if (phase === "restarting") acts.append(openLog());
    }
  }
  el("tab-app-main").onclick = () => setTab("main");
  el("tab-app-akowe").onclick = () => setTab("akowe");
  el("btn-akowe-reload").onclick = async () => { if (api.akoweReload) render(await api.akoweReload()); };
  el("btn-akowe-log").onclick = () => api.akoweServerOpenLog();
  el("btn-akowe-popout").onclick = async () => {
    const popped = !!(last && last.view && last.view.popped);
    const r = popped ? await api.akoweDock() : await api.akowePopOut();
    if (r && r.status) render(r.status);
  };
  el("akowe-autostart").onchange = async (e) => { render(await api.akoweServerSetAutostart(!!e.target.checked)); };
  if (api.onAkoweServer) api.onAkoweServer((st) => render(st));
  if (api.onAkoweTabShow) api.onAkoweTabShow(() => setTab("akowe"));
  // Arrow keys move between the two tabs (tablist pattern).
  el("app-tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    // The tabs: 🤖 AutoInjector · 📖 Akọwe · 🎨 Images · 🎬 Video (when present).
    const order = ["main", "akowe"];
    if (el("tab-app-images") && typeof window.sdShowImagesTab === "function") order.push("images");
    if (el("tab-app-video") && typeof window.vdShowVideoTab === "function") order.push("video");
    const cur = Math.max(0, order.indexOf(document.body.dataset.appTab || "main"));
    const next = order[(cur + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
    if (next === "images") window.sdShowImagesTab(); else if (next === "video") window.vdShowVideoTab(); else setTab(next);
    el(`tab-app-${next}`).focus();
    e.preventDefault();
  });
  let saved = "main";
  try { saved = localStorage.getItem("akoweTab") || "main"; } catch (_) {}
  setTab(saved === "akowe" ? "akowe" : "main");
  Promise.resolve(api.akoweServerStatus()).then(render).catch(() => {});
}
try { wireAkoweTab(); } catch (e) { console.error("Akọwe tab init failed", e); }
