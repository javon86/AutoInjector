'use strict';
// feed.js — the consolidated "all AIs talking" window. Listens for captured
// replies (and user sends) broadcast from main and renders them as bubbles
// coloured by which LLM is talking. A separate window you can open, close and
// reopen any time; it reflects the same live conversation as the main app.
const SITE_LABELS = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', user: 'You' };
const el = (id) => document.getElementById(id);
const feed = el('feed');

const show = { chatgpt: true, claude: true, gemini: true };
let autoscroll = true;
const seen = new Set();      // de-dupe by turn id
let total = 0;

function fmtTime(ts) {
  try { const d = new Date(ts || Date.now()); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch (_) { return ''; }
}
function atBottom() { return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60; }
function scrollDown() { if (autoscroll) feed.scrollTop = feed.scrollHeight; }

function applyFilter() {
  for (const node of feed.querySelectorAll('.bubble')) {
    const s = node.getAttribute('data-site');
    node.style.display = (s === 'user' || show[s]) ? '' : 'none';
  }
  const e = el('empty'); if (e) e.style.display = feed.querySelector('.bubble') ? 'none' : '';
}

function addBubble(turn, kind) {
  const site = (turn.site || kind || '').toLowerCase();
  const id = turn.id != null ? `${kind}-${turn.id}` : `${kind}-${total}-${(turn.ts || 0)}`;
  if (seen.has(id)) return;
  seen.add(id);
  const text = (turn.text || '').trim();
  if (!text) return;
  const cls = site === 'chatgpt' ? 'b-chatgpt' : site === 'claude' ? 'b-claude' : site === 'gemini' ? 'b-gemini' : 'b-user';
  const wasBottom = atBottom();
  const div = document.createElement('div');
  div.className = `bubble ${cls}`;
  div.setAttribute('data-site', kind === 'user' ? 'user' : site);
  const who = document.createElement('div');
  who.className = 'who';
  const name = document.createElement('span');
  name.textContent = kind === 'user' ? 'You → ' + (turn.toLabel || 'the AIs') : (turn.label || SITE_LABELS[site] || site || 'AI');
  const when = document.createElement('span'); when.className = 'when'; when.textContent = fmtTime(turn.ts);
  who.appendChild(name); who.appendChild(when);
  const body = document.createElement('div'); body.textContent = text;
  div.appendChild(who); div.appendChild(body);
  feed.appendChild(div);
  const e = el('empty'); if (e) e.style.display = 'none';
  total++; el('count').textContent = total ? `${total} message${total === 1 ? '' : 's'}` : '';
  if (kind !== 'user' && !show[site]) div.style.display = 'none';
  if (wasBottom) scrollDown();
}

// Filter chips.
for (const chip of document.querySelectorAll('.chip')) {
  chip.onclick = () => { const s = chip.getAttribute('data-site'); show[s] = !show[s]; chip.classList.toggle('on', show[s]); applyFilter(); };
}
el('btn-clear').onclick = () => { feed.querySelectorAll('.bubble').forEach((n) => n.remove()); seen.clear(); total = 0; el('count').textContent = ''; const e = el('empty'); if (e) e.style.display = ''; };
el('btn-autoscroll').onclick = () => { autoscroll = !autoscroll; el('btn-autoscroll').textContent = `Auto-scroll: ${autoscroll ? 'on' : 'off'}`; scrollDown(); };

// Live wiring. Reuses the main preload bridge (window.api) — capture/sent are
// broadcast to every window, so this one gets them too.
if (window.api) {
  if (window.api.onCapture) window.api.onCapture((turn) => { if (turn && turn.site) addBubble(turn, turn.site); });
  if (window.api.onSent) window.api.onSent((info) => {
    // A user send: info may carry {targets, text} — show it as a neutral bubble.
    if (info && info.text) addBubble({ text: info.text, ts: info.ts, toLabel: Array.isArray(info.targets) ? info.targets.map((t) => SITE_LABELS[t] || t).join(', ') : '' }, 'user');
  });
  // Backfill the recent conversation so opening the window shows history, not a blank.
  if (window.api.feedHistory) {
    window.api.feedHistory().then((rows) => {
      if (Array.isArray(rows)) for (const t of rows) addBubble(t, t.site);
      scrollDown();
    }).catch(() => {});
  }
}

// --- Composer: reply box + 8 savable preset buttons ------------------------
const PRESET_KEY = 'feed-presets-v1';
const PRESET_COUNT = 8;
let hintTimer = null;
function hint(msg) { const h = el('composer-hint'); if (!h) return; h.textContent = msg || ''; if (hintTimer) clearTimeout(hintTimer); if (msg) hintTimer = setTimeout(() => { h.textContent = ''; }, 2600); }
function loadPresets() {
  let a = [];
  try { a = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]'); } catch (_) { a = []; }
  return Array.from({ length: PRESET_COUNT }, (_, i) => (a[i] && typeof a[i].text === 'string') ? a[i] : { label: '', text: '' });
}
function savePresets(p) { try { localStorage.setItem(PRESET_KEY, JSON.stringify(p)); } catch (_) {} }
let presets = loadPresets();
let editMode = false;

function targetsFromSelect() {
  const v = (el('reply-target') && el('reply-target').value) || 'all';
  return v === 'all' ? ['chatgpt', 'claude', 'gemini'] : [v];
}
function sendText(text) {
  const t = (text || '').trim();
  if (!t) return;
  const targets = targetsFromSelect();
  if (window.api && window.api.sendCompose) {
    window.api.sendCompose(t, targets);
    hint('Sent to ' + targets.map((x) => SITE_LABELS[x] || x).join(', '));
  }
}
function renderPresets() {
  const row = el('preset-row'); if (!row) return;
  row.innerHTML = '';
  presets.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'preset' + (p.text ? '' : ' empty');
    b.textContent = p.text ? (p.label || p.text) : `(set ${i + 1})`;
    b.title = p.text ? p.text : 'Empty preset — turn on ✎ Presets, type text above, then click here to save it';
    b.onclick = () => {
      if (editMode) {
        const src = (el('reply-text') && el('reply-text').value || '').trim();
        presets[i] = { label: src.slice(0, 22), text: src };
        savePresets(presets); renderPresets();
        hint(src ? `Saved preset ${i + 1}` : `Cleared preset ${i + 1}`);
      } else if (p.text) {
        sendText(p.text);
      } else {
        hint('Empty — click ✎ Presets, type text above, then click a slot to save it');
      }
    };
    row.appendChild(b);
  });
}
if (el('btn-reply-send')) el('btn-reply-send').onclick = () => { const box = el('reply-text'); if (box && box.value.trim()) { sendText(box.value); box.value = ''; } };
if (el('reply-text')) el('reply-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el('btn-reply-send').click(); } });
if (el('btn-preset-edit')) el('btn-preset-edit').onclick = () => {
  editMode = !editMode;
  el('btn-preset-edit').classList.toggle('on', editMode);
  const c = el('composer'); if (c) c.classList.toggle('editing', editMode);
  hint(editMode ? 'Edit mode: type text above, then click a preset slot to save it (empty text clears it).' : 'Edit mode off — clicking a preset now sends it.');
};
renderPresets();
