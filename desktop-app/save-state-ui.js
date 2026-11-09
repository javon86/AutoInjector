// save-state-ui.js — 💾 Save state / 📂 Load state in the control panel (the buttons in the title bar).
//
//   💾 Save state: you type a name ("Salt Keeper ch 12"); main.js saves the chat each pane is on, a backup of each
//      chat's recent replies, and the set-up (save-state.js). This file hands main the window's own bits through
//      window.saveStateUi.snapshot(): the Compose box, whether 🎩 Alfred is in → All, the open tab, each pane's size,
//      the folded panels.
//   📂 Load state: the saves with name + date/time; Load / ✎ Rename / 📜 Saved text / 🗑 Delete. Loading moves all
//      three panes to their saved chats at once; main.js then calls window.saveStateUi.apply() with the set-up and
//      the result, shown here in plain words — with the saved text (read-only) for any chat that is gone.
// Works the same when 🎩 Alfred saves or loads ("save this as …", "load …"): main.js calls apply() either way.
(function () {
  "use strict";
  const api = window.api || {};
  if (typeof api.saveStateList !== "function") return;
  const $ = (id) => document.getElementById(id);
  const SITE_IDS = ["chatgpt", "claude", "gemini"];
  const NAMES = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };
  const PANEL_KEYS = ["global", "houserules", "prompts", "gpu", "systemai", "akowe"];
  const PANEL_IDS = { global: "col-global", houserules: "col-houserules", prompts: "col-prompts", gpu: "col-gpu", systemai: "col-systemai", akowe: "col-akowe" };
  const ICON = { ok: "✅", gone: "⚠️", "new-chat": "⚠️", login: "🔑", error: "⚠️", refused: "⛔", none: "—" };
  const say = (s) => { try { if (typeof setStatus === "function") setStatus(s); } catch (_) {} };

  function mk(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "text") n.textContent = v; else if (k === "onclick") n.onclick = v; else if (k === "className") n.className = v; else n.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids) if (k) n.append(k);
    return n;
  }
  function when(ms) {
    const d = new Date(Number(ms) || 0);
    if (!ms || isNaN(d.getTime())) return "";
    return d.toLocaleString([], { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  }

  // ---- the window's own bits ----------------------------------------------------------------------------------
  function columnState(site) {
    const col = $(`col-${site}`);
    if (!col) return null;
    return ["open", "reduced", "min"].find((s) => col.classList.contains(`state-${s}`)) || "open";
  }
  function snapshot() {
    const out = { columns: {}, panelsCollapsed: [] };
    const box = $("composer-text");
    if (box) out.composer = String(box.value || "");
    const butler = $("p-butler");
    if (butler) out.alfredActive = !!butler.checked;
    out.tab = document.body.dataset.appTab || "main";
    for (const s of SITE_IDS) { const c = columnState(s); if (c) out.columns[s] = c; }
    const row = $("main-row");
    if (row) out.mainRowCollapsed = row.classList.contains("collapsed");
    for (const k of PANEL_KEYS) { const p = $(PANEL_IDS[k]); if (p && p.classList.contains("hidden-collapsed")) out.panelsCollapsed.push(k); }
    return out;
  }
  function applyUi(ui, global) {
    const u = ui || {};
    try { if (global && typeof applyGlobal === "function") applyGlobal(global); } catch (_) {}
    if (typeof u.composer === "string" && $("composer-text")) {
      $("composer-text").value = u.composer;
      try { if (typeof updateCharCount === "function") updateCharCount(); } catch (_) {}
    }
    if (typeof u.alfredActive === "boolean" && $("p-butler")) {
      $("p-butler").checked = u.alfredActive;
      try { butlerActive = u.alfredActive; } catch (_) {} // controls.js's → All flag
    }
    if (u.columns) for (const s of SITE_IDS) { if (u.columns[s] && typeof setColumnState === "function") { try { setColumnState(s, u.columns[s]); } catch (_) {} } }
    if (typeof u.mainRowCollapsed === "boolean" && $("main-row") && $("btn-main-row-collapse") && $("main-row").classList.contains("collapsed") !== u.mainRowCollapsed) $("btn-main-row-collapse").click();
    if (Array.isArray(u.panelsCollapsed)) {
      for (const k of PANEL_KEYS) {
        const p = $(PANEL_IDS[k]);
        if (!p) continue;
        const want = u.panelsCollapsed.includes(k);
        const is = p.classList.contains("hidden-collapsed");
        if (want === is) continue;
        try {
          if (k === "systemai" && typeof setButlerFolded === "function") setButlerFolded(want, false);
          else if (want && typeof collapseYellowPanel === "function") collapseYellowPanel(k);
          else if (!want && typeof expandYellowPanel === "function") expandYellowPanel(k);
        } catch (_) {}
      }
    }
    if (u.tab) { const b = $(`tab-app-${u.tab}`); if (b && (document.body.dataset.appTab || "main") !== u.tab) b.click(); }
    try { if (api.syncPanes) api.syncPanes(); } catch (_) {}
  }

  // ---- the dialog ---------------------------------------------------------------------------------------------
  let lastFocus = null;
  function modal() { return $("savestate-modal"); }
  function open(title, sub) {
    const m = modal();
    if (!m) return null;
    if (!m.classList.contains("on")) lastFocus = document.activeElement;
    m.classList.add("on");
    $("savestate-title").textContent = title;
    $("savestate-sub").textContent = sub || "";
    const body = $("savestate-body");
    body.textContent = "";
    $("savestate-msg").textContent = "";
    return body;
  }
  function close() {
    const m = modal();
    if (m) m.classList.remove("on");
    try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (_) {}
    try { if (api.syncPanes) api.syncPanes(); } catch (_) {}
  }
  function msg(text, bad) { const n = $("savestate-msg"); if (n) { n.textContent = text || ""; n.dataset.bad = bad ? "1" : "0"; } }

  // 💾
  function openSave() {
    const body = open("💾 Save state", "Saves the chat each AI pane is on, a copy of their recent replies, and how everything is set up — on this PC only.");
    if (!body) return;
    const input = mk("input", { type: "text", id: "savestate-name", maxlength: "80", placeholder: "A name, e.g. Salt Keeper ch 12", "aria-label": "Name for this save", autocomplete: "off" });
    const go = mk("button", { type: "button", id: "btn-savestate-do", className: "primary", text: "💾 Save" });
    const cancel = mk("button", { type: "button", text: "Cancel", onclick: close });
    const row = mk("div", { className: "ss-row" }, input, go, cancel);
    body.append(mk("label", { for: "savestate-name", className: "ss-l", text: "Name" }), row);
    async function doSave(replace) {
      const name = input.value.trim();
      if (!name) { msg("Type a name first.", true); input.focus(); return; }
      go.disabled = true; msg("Saving…");
      let r;
      try { r = await api.saveStateSave(name, replace); } catch (e) { r = { ok: false, message: String(e) }; }
      go.disabled = false;
      if (r && r.ok) { close(); say(`💾 ${r.message}`); return; }
      if (r && r.error === "NAME_TAKEN") {
        msg(r.message, true);
        const rep = mk("button", { type: "button", id: "btn-savestate-replace", text: `Replace “${r.name}”`, onclick: () => { rep.remove(); doSave(true); } });
        $("savestate-msg").append(" ", rep);
        return;
      }
      msg((r && r.message) || "The save could not be made.", true);
    }
    go.onclick = () => doSave(false);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(false); } });
    setTimeout(() => input.focus(), 0);
  }

  // 📂
  async function openLoad() {
    const body = open("📂 Load state", "Pick a save: all three AI panes go back to their saved chats, and the rest is put back the way it was.");
    if (!body) return;
    body.append(mk("p", { className: "ss-note", text: "Loading…" }));
    let r;
    try { r = await api.saveStateList(); } catch (_) { r = null; }
    body.textContent = "";
    if (!r || !r.ok) { msg((r && r.message) || "The saves could not be read.", true); return; }
    if (!r.saves.length) { body.append(mk("p", { className: "ss-note", id: "savestate-empty", text: "No saves yet. Press 💾 Save state to keep where you are." })); return; }
    body.append(mk("p", { className: "ss-note", text: `${r.count} save${r.count === 1 ? "" : "s"} (up to ${r.max} are kept). Newest first.` }));
    const list = mk("div", { id: "savestate-list", role: "list" });
    for (const s of r.saves) list.append(row(s));
    body.append(list);
  }
  function summaryText(s) {
    const sm = s.summary || {};
    const sites = sm.sites || {};
    const chats = SITE_IDS.filter((x) => sites[x] && sites[x].url).map((x) => NAMES[x]);
    const parts = [];
    parts.push(chats.length ? `💬 ${chats.join(" · ")}` : "no chats");
    if (sm.book) parts.push(`📖 ${sm.book}`);
    if (sm.sequenceSteps) parts.push(`🧵 ${sm.sequenceSteps} step${sm.sequenceSteps === 1 ? "" : "s"}`);
    return parts.join("  ·  ");
  }
  function row(s) {
    const item = mk("div", { className: "ss-item", role: "listitem", "data-id": s.id, "data-damaged": s.damaged ? "1" : "0" });
    const name = mk("div", { className: "ss-name", text: s.name });
    const meta = mk("div", { className: "ss-meta", text: s.damaged ? "This file is damaged and can't be loaded — you can delete it." : `${when(s.savedAt)}  ·  ${summaryText(s)}` });
    const btns = mk("div", { className: "ss-btns" });
    const status = mk("div", { className: "ss-status", role: "status" });
    if (!s.damaged) {
      btns.append(
        mk("button", { type: "button", className: "primary ss-load", text: "📂 Load", onclick: () => doLoad(s, false, status) }),
        mk("button", { type: "button", className: "ss-rename", text: "✎ Rename", onclick: () => startRename(item, s) }),
        mk("button", { type: "button", className: "ss-view", text: "📜 Saved text", onclick: () => openViewer(s.id, null) }),
      );
    }
    btns.append(mk("button", { type: "button", className: "ss-delete", text: "🗑 Delete", onclick: () => confirmDelete(item, s, status) }));
    item.append(name, meta, btns, status);
    return item;
  }
  function startRename(item, s) {
    const nameEl = item.querySelector(".ss-name");
    const input = mk("input", { type: "text", className: "ss-rename-input", maxlength: "80", value: s.name, "aria-label": "New name" });
    const ok = mk("button", { type: "button", className: "primary ss-rename-ok", text: "Save name" });
    const no = mk("button", { type: "button", text: "Cancel", onclick: () => openLoad() });
    const box = mk("div", { className: "ss-row" }, input, ok, no);
    nameEl.replaceWith(box);
    ok.onclick = async () => {
      let r;
      try { r = await api.saveStateRename(s.id, input.value); } catch (e) { r = { ok: false, message: String(e) }; }
      if (r && r.ok) { await openLoad(); msg(r.message); } else msg((r && r.message) || "Could not rename it.", true);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ok.click(); } });
    input.focus(); input.select();
  }
  function confirmDelete(item, s, status) {
    status.textContent = "";
    const yes = mk("button", { type: "button", className: "danger ss-delete-yes", text: "Yes, delete it" });
    const no = mk("button", { type: "button", text: "Keep it", onclick: () => { status.textContent = ""; } });
    status.append(mk("span", { text: `Delete “${s.name}” for good? ` }), yes, no);
    yes.onclick = async () => {
      let r;
      try { r = await api.saveStateDelete(s.id); } catch (e) { r = { ok: false, message: String(e) }; }
      if (r && r.ok) { await openLoad(); msg(r.message); } else status.textContent = (r && r.message) || "Could not delete it.";
    };
  }
  let loading = false;
  async function doLoad(s, anyway, status) {
    if (loading) return;
    loading = true;
    status.textContent = "⏳ Opening the saved chats…";
    for (const b of document.querySelectorAll("#savestate-list button")) b.disabled = true;
    let r;
    try { r = await api.saveStateLoad(s.id, anyway); } catch (e) { r = { ok: false, message: String(e) }; }
    loading = false;
    for (const b of document.querySelectorAll("#savestate-list button")) b.disabled = false;
    if (r && r.ok) { if (!modal().classList.contains("on") || $("savestate-title").textContent.indexOf("Loaded") < 0) showResult(r); return; }
    status.textContent = "";
    if (r && r.error === "BUSY") {
      const yes = mk("button", { type: "button", className: "danger ss-anyway", text: "Load it anyway" });
      const no = mk("button", { type: "button", text: "Not now", onclick: () => { status.textContent = ""; } });
      status.append(mk("span", { className: "ss-busy", text: `${r.message} ` }), yes, no);
      yes.onclick = () => doLoad(s, true, status);
      return;
    }
    status.textContent = (r && r.message) || "The save could not be loaded.";
  }

  // the result of a load (from the 📂 list, or when 🎩 Alfred loaded one)
  function showResult(r) {
    if (!r) return;
    const body = open(`📂 Loaded “${r.name}”`, r.savedAt ? `Saved ${when(r.savedAt)}` : "");
    if (!body) return;
    const lines = mk("ul", { id: "savestate-result", className: "ss-result" });
    const problems = [];
    for (const s of SITE_IDS) {
      const x = r.results && r.results[s];
      if (!x) continue;
      lines.append(mk("li", { "data-site": s, "data-state": x.state }, `${ICON[x.state] || "•"} `, x.say));
      if (!["ok", "none"].includes(x.state)) problems.push(s);
    }
    body.append(lines);
    if (r.book && r.book.title) body.append(mk("p", { className: "ss-note", text: r.book.shown ? `📖 ${r.book.title} is open again in the 📖 Akọwe tab.` : `📖 You were working on ${r.book.title}. Open it in the 📖 Akọwe tab.` }));
    if (r.sequenceSteps) body.append(mk("p", { className: "ss-note", text: `🧵 Your prompt sequence (${r.sequenceSteps} step${r.sequenceSteps === 1 ? "" : "s"}) is back in 🧵 Sequence — nothing is sent until you press Run there.` }));
    const foot = mk("div", { className: "ss-row" }, mk("button", { type: "button", className: "primary", id: "btn-savestate-close", text: "OK", onclick: close }));
    body.append(foot);
    say(`📂 ${r.message || `Loaded “${r.name}”.`}`);
    if (problems.length) showSavedCopy(r.id, problems, body, foot);
  }
  async function showSavedCopy(id, sites, body, before) {
    let v;
    try { v = await api.saveStateView(id); } catch (_) { v = null; }
    if (!v || !v.ok) return;
    for (const s of sites) body.insertBefore(viewerFor(v, s), before);
  }
  function viewerFor(v, site) {
    const turns = (v.backup && v.backup[site]) || [];
    const box = mk("section", { className: "ss-viewer", "data-site": site, "aria-label": `${NAMES[site]}: the saved copy (read-only)` });
    box.append(mk("h4", { text: `📜 ${NAMES[site]} — the saved copy (read-only)` }));
    if (!turns.length) { box.append(mk("p", { className: "ss-note", text: "No replies were saved for this chat." })); return box; }
    for (const t of turns) {
      const turn = mk("div", { className: "ss-turn" });
      turn.append(mk("div", { className: "ss-when", text: when(t.ts) }), mk("div", { className: "ss-text", text: t.text }));
      box.append(turn);
    }
    return box;
  }
  async function openViewer(id) {
    let v;
    try { v = await api.saveStateView(id); } catch (_) { v = null; }
    if (!v || !v.ok) { msg((v && v.message) || "That save could not be read.", true); return; }
    const body = open(`📜 “${v.name}” — saved text`, `Saved ${when(v.savedAt)}. Read-only: this is what each AI said, kept with the save.`);
    for (const s of SITE_IDS) body.append(viewerFor(v, s));
    body.append(mk("div", { className: "ss-row" }, mk("button", { type: "button", text: "← Back to the saves", onclick: openLoad }), mk("button", { type: "button", className: "primary", text: "Close", onclick: close })));
  }

  // main.js calls this after a load (from the 📂 list or from 🎩 Alfred)
  function apply(payload) {
    const p = payload || {};
    applyUi(p.ui, p.global);
    if (p.result) showResult(p.result);
    return true;
  }

  window.saveStateUi = { snapshot, apply, openSave, openLoad };
  const sb = $("btn-save-state"); if (sb) sb.onclick = openSave;
  const lb = $("btn-load-state"); if (lb) lb.onclick = openLoad;
  const m = modal();
  if (m) {
    m.addEventListener("click", (e) => { if (e.target === m) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && m.classList.contains("on")) { e.stopPropagation(); close(); } }, true);
    const x = $("btn-savestate-x"); if (x) x.onclick = close;
  }
})();
