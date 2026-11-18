// phone-app.js — 📱 the phone app (served by phone-server.js; runs in the phone's browser).
// Five tabs: 🏠 Home · 💬 Chat · 📖 Book · 🎩 Alfred · 🔔 Alerts. Everything shown that came from an AI or a book is
// set as text (textContent), never parsed as HTML. The pairing key arrives in the link's #k=… and is kept on the
// phone (localStorage); every call carries it.
(function (root) {
  'use strict';
  const KEY_STORE = 'autoinjector.phone.key';
  const TAB_STORE = 'autoinjector.phone.tab';
  const SIZE_STORE = 'autoinjector.phone.reader';
  const SPEAK_STORE = 'autoinjector.phone.speak';
  const TO_STORE = 'autoinjector.phone.to';
  const TABS = ['home', 'chat', 'book', 'alfred', 'alerts'];
  const LABEL = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' };

  // ---------------------------------------------------------------- small helpers
  const store = {
    get(k, d) { try { const v = root.localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } },
    set(k, v) { try { root.localStorage.setItem(k, String(v)); } catch (_) { /* private mode: fine */ } },
    del(k) { try { root.localStorage.removeItem(k); } catch (_) { /* fine */ } },
  };
  function el(doc, tag, attrs, kids) {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'text') e.textContent = String(v);
      else if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of [].concat(kids || [])) if (c) e.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    return e;
  }
  function fill(box, nodes) { box.textContent = ''; for (const n of [].concat(nodes)) if (n) box.appendChild(n); }
  function timeLeft(s) {
    if (typeof s !== 'number' || !isFinite(s) || s < 0) return '';
    const m = Math.round(s / 60);
    if (m < 1) return 'under a minute left';
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} m left` : `${m} min left`;
  }
  function clock(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    try { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; }
  }
  function ago(ms, now) {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }

  /** The pairing key: from the link (#k=…), else the one kept on this phone. The link's key is then hidden. */
  function takeKey(loc, hist) {
    const m = /[#&]k=([^&]+)/.exec(loc.hash || '');
    if (m) {
      const k = decodeURIComponent(m[1]);
      store.set(KEY_STORE, k);
      try { hist.replaceState(null, '', loc.pathname + loc.search); } catch (_) { /* old browser: leave it */ }
      return k;
    }
    return store.get(KEY_STORE, '');
  }

  // ---------------------------------------------------------------- the app
  function start(doc, opts = {}) {
    const fetchFn = opts.fetch || root.fetch.bind(root);
    const now = opts.now || (() => Date.now());
    const $ = (id) => doc.getElementById(id);
    const S = {
      key: takeKey(opts.location || root.location, opts.history || root.history),
      tab: TABS.includes(store.get(TAB_STORE, 'home')) ? store.get(TAB_STORE, 'home') : 'home',
      state: null, chat: [], alfred: null, chapters: null, reading: null, sending: false,
      to: (() => { try { const v = JSON.parse(store.get(TO_STORE, '[]')); return Array.isArray(v) ? v : []; } catch (_) { return []; } })(),
      reachable: null, seenAlerts: null, lastAlfredSpoken: 0, timers: [],
    };

    async function api(method, path, body) {
      const headers = { Authorization: `Bearer ${S.key}` };
      if (body) headers['Content-Type'] = 'application/json';
      let r;
      try { r = await fetchFn(path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }); } catch (_) { setReach(false); return { ok: false, error: 'UNREACHABLE', words: 'Can\'t reach the PC.' }; }
      setReach(true);
      let j = null;
      try { j = await r.json(); } catch (_) { j = null; }
      if (r.status === 401) { S.key = ''; store.del(KEY_STORE); show(); return { ok: false, error: 'NOT_PAIRED', words: (j && j.words) || 'Not paired.' }; }
      return j || { ok: false, error: 'BAD_ANSWER', words: 'The PC gave an odd answer.' };
    }

    function setReach(ok) {
      if (S.reachable === ok) return;
      S.reachable = ok;
      paintPc();
    }
    function paintPc() {
      const dot = $('pc-dot');
      const words = $('pc-words');
      if (!dot || !words) return;
      if (!S.key) { dot.className = 'dot'; words.textContent = 'Not paired'; return; }
      if (S.reachable === false) { dot.className = 'dot off'; words.textContent = 'PC not reachable — same Wi-Fi? AutoInjector open?'; return; }
      dot.className = S.reachable ? 'dot on' : 'dot';
      words.textContent = S.reachable ? (S.state && S.state.pc ? S.state.pc : 'PC connected') : 'Connecting…';
    }

    let toastTimer = null;
    function toast(words) {
      const t = $('toast');
      if (!t || !words) return;
      t.textContent = words;
      t.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
    }

    function confirmBox(text) {
      const d = $('confirm');
      if (!d || typeof d.showModal !== 'function') return Promise.resolve(root.confirm ? root.confirm(text) : false);
      $('confirm-text').textContent = text;
      return new Promise((resolve) => {
        const done = (v) => { $('confirm-yes').onclick = null; $('confirm-no').onclick = null; try { d.close(); } catch (_) {} resolve(v); };
        $('confirm-yes').onclick = () => done(true);
        $('confirm-no').onclick = () => done(false);
        d.showModal();
      });
    }

    // -------------------------------------------------------------- tabs
    function show(tab) {
      if (tab) { S.tab = tab; store.set(TAB_STORE, tab); }
      const paired = !!S.key;
      $('s-pair').hidden = paired;
      $('tabs').hidden = !paired;
      for (const t of TABS) $(`s-${t}`).hidden = !paired || S.tab !== t || (t === 'book' && !!S.reading);
      $('s-reader').hidden = !paired || S.tab !== 'book' || !S.reading;
      for (const b of doc.querySelectorAll('#tabs button')) {
        if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      }
      paintPc();
      if (!paired) return;
      if (S.tab === 'chat') { loadChat(); }
      if (S.tab === 'book' && !S.chapters) loadChapters();
      if (S.tab === 'alfred') loadAlfred();
      if (S.tab === 'alerts') paintAlerts();
      try { root.scrollTo(0, S.tab === 'chat' || S.tab === 'alfred' ? doc.body.scrollHeight : 0); } catch (_) { /* fine */ }
    }

    // -------------------------------------------------------------- state (polled)
    async function loadState() {
      if (!S.key) return;
      const st = await api('GET', '/api/state');
      if (!st || st.ok === false) return;
      const before = S.state;
      S.state = st;
      paintPc();
      paintHome();
      paintBook();
      paintAlertsBadge(before);
      if (S.tab === 'alerts') paintAlerts();
      // a new or changed book: the chapter list is read again when the Book tab is next shown
      if (before && before.book && st.book && before.book.done !== st.book.done) S.chapters = null;
    }

    function bookCard(b, big) {
      if (!b) return el(doc, 'div', { class: 'card' }, [el(doc, 'div', { class: 'card-head', text: 'Book' }), el(doc, 'p', { class: 'dim', text: 'No book is being made right now. Start one on the PC with ⚡ Make a book for me.' })]);
      const kids = [
        el(doc, 'div', { class: 'card-head', text: b.live ? '📖 Writing now' : b.finished ? '📖 Finished' : '📖 Your book' }),
        el(doc, 'div', { class: 'book-title', text: b.title }),
        el(doc, 'div', { class: 'book-state', text: b.stateWords }),
      ];
      if (b.percent != null) kids.push(el(doc, 'div', { class: 'bar', role: 'progressbar', 'aria-valuenow': b.percent, 'aria-valuemin': 0, 'aria-valuemax': 100 }, [el(doc, 'i', { style: `width:${b.percent}%` })]));
      const left = [b.done != null && b.total ? `Step ${Math.min(b.total, b.done + (b.live ? 1 : 0))} of ${b.total}` : '', b.live ? timeLeft(b.leftS) : '', b.live && b.finishAt ? `done ~${clock(b.finishAt)}` : ''].filter(Boolean);
      if (left.length) kids.push(el(doc, 'div', { class: 'book-numbers' }, left.map((t) => el(doc, 'span', { text: t }))));
      if (b.step && (b.live || big)) kids.push(el(doc, 'div', { class: 'book-step', text: b.step }));
      const btns = [];
      if (b.canPause) btns.push(el(doc, 'button', { class: 'btn', type: 'button', text: '⏸ Pause', onclick: () => bookAct('/api/book/pause', 'Pausing…') }));
      if (b.canContinue) btns.push(el(doc, 'button', { class: 'btn primary', type: 'button', text: '▶ Continue', onclick: () => bookAct('/api/book/continue', 'Continuing…') }));
      if (!big) btns.push(el(doc, 'button', { class: 'btn', type: 'button', text: 'Open', onclick: () => show('book') }));
      if (btns.length) kids.push(el(doc, 'div', { class: 'btn-row' }, btns));
      return el(doc, 'div', { class: 'card book', 'data-testid': 'book-card' }, kids);
    }

    function questionCard(b, withChoices) {
      const q = b && b.question;
      if (!q) return null;
      const kids = [el(doc, 'div', { class: 'q-label', text: `${q.icon} ${q.label || 'The book needs you'}` })];
      if (q.what) kids.push(el(doc, 'div', { class: 'q-what', text: q.what }));
      if (q.wrong) kids.push(el(doc, 'p', { class: 'q-line', text: q.wrong }));
      if (withChoices) {
        if (q.why) kids.push(el(doc, 'p', { class: 'q-line dim', text: q.why }));
        if (q.change) kids.push(el(doc, 'div', { class: 'q-change', text: q.change }));
        if (q.next) kids.push(el(doc, 'p', { class: 'q-line', text: q.next }));
        if (q.choices.length) {
          kids.push(el(doc, 'div', { class: 'choices' }, q.choices.map((c) => el(doc, 'button', {
            class: `choice${c.action === 'resume' || c.action === 'accept_change' ? ' primary' : ''}`, type: 'button', text: c.label, 'data-action': c.action,
            onclick: async (e) => {
              let ok = true;
              if (c.confirm) ok = await confirmBox(`${c.label}?\n\nThis approves it as your own decision, without the AI's OK.`);
              if (!ok) return;
              e.currentTarget.disabled = true;
              const r = await api('POST', '/api/book/answer', { action: c.action, confirm: c.confirm === true });
              toast((r && r.words) || (r && r.ok ? 'Done.' : 'That did not work.'));
              loadState();
            },
          }))));
        }
        if (q.pcOnly) kids.push(el(doc, 'p', { class: 'pc-note', text: '✏ To edit it yourself, use the PC (then press “I edited it” there).' }));
      } else {
        kids.push(el(doc, 'div', { class: 'btn-row' }, [el(doc, 'button', { class: 'btn primary', type: 'button', text: 'Answer', onclick: () => show('book') })]));
      }
      return el(doc, 'div', { class: 'card question', 'data-testid': 'question-card' }, kids);
    }

    async function bookAct(path, words) {
      toast(words);
      const r = await api('POST', path);
      toast((r && r.words) || (r && r.ok ? 'Done.' : 'That did not work.'));
      loadState();
    }

    function paintHome() {
      const st = S.state || {};
      fill($('home-book'), bookCard(st.book, false));
      fill($('home-question'), questionCard(st.book, false));
      fill($('home-ais'), (st.ais || []).map((a) => el(doc, 'div', { class: `ai ${a.id}${a.on ? '' : ' off'}` }, [el(doc, 'b', { text: a.label }), el(doc, 'span', { text: a.words })])));
      const al = st.alfred || {};
      fill($('home-alfred'), [el(doc, 'span', { class: 'big', text: '🎩' }), el(doc, 'div', { class: 'grow' }, [el(doc, 'b', { text: 'Alfred' }), el(doc, 'div', { class: 'dim', text: !al.on ? 'Off — turn him on with the 🎩 switch on the PC' : al.waitingOnPc ? `Waiting for your OK on the PC: ${al.waitingOnPc}` : al.busy ? 'Thinking…' : 'Ready to help' })]), el(doc, 'span', { class: 'go', text: '›' })]);
      $('home-alfred').onclick = () => show('alfred');
      const n = (st.alerts || []).filter((a) => !a.seen).length;
      fill($('home-alerts'), [el(doc, 'span', { class: 'big', text: '🔔' }), el(doc, 'div', { class: 'grow' }, [el(doc, 'b', { text: n ? `${n} new alert${n === 1 ? '' : 's'}` : 'No new alerts' }), el(doc, 'div', { class: 'dim', text: n ? (st.alerts.find((a) => !a.seen) || {}).title || '' : 'You\'ll see anything that needs you here.' })]), el(doc, 'span', { class: 'go', text: '›' })]);
      $('home-alerts').onclick = () => show('alerts');
    }

    function paintBook() {
      const st = S.state || {};
      fill($('book-card'), bookCard(st.book, true));
      fill($('book-question'), questionCard(st.book, true));
    }

    // -------------------------------------------------------------- chapters + reader
    async function loadChapters() {
      const box = $('book-chapters');
      fill(box, el(doc, 'p', { class: 'dim', text: 'Loading…' }));
      const r = await api('GET', '/api/book/chapters');
      if (!r || r.ok === false) { fill(box, el(doc, 'p', { class: 'dim', text: (r && r.words) || 'The chapters can\'t be read now.' })); return; }
      S.chapters = r.chapters || [];
      if (!S.chapters.length) { fill(box, el(doc, 'p', { class: 'dim', text: 'No chapters written yet.' })); return; }
      fill(box, S.chapters.map((c) => el(doc, 'button', { class: 'item', type: 'button', 'data-n': c.number, onclick: () => openChapter(c.number) }, [
        el(doc, 'div', { class: 'grow' }, [el(doc, 'div', { class: 't', text: `${c.number}. ${c.title || `Chapter ${c.number}`}` }), el(doc, 'div', { class: 's', text: `${(c.words || 0).toLocaleString()} words${c.approved ? '' : ' · draft'}` })]),
        el(doc, 'span', { class: 'go', text: '›' }),
      ])));
    }

    function paintReader() {
      const r = S.reading;
      if (!r) return;
      const art = $('reader-text');
      const blocks = String(r.text || '').split(/\n\s*\n/);
      fill(art, blocks.map((b) => { const t = b.trim(); if (!t) return null; return /^#\s/.test(t) ? el(doc, 'h1', { text: t.replace(/^#\s+/, '') }) : el(doc, 'p', { text: t }); }));
      $('reader-where').textContent = `Chapter ${r.number} of ${r.of || '?'}`;
      $('reader-prev').disabled = r.number <= 1;
      $('reader-next').disabled = !!r.of && r.number >= r.of;
      art.style.setProperty('--reader-size', `${Number(store.get(SIZE_STORE, 19)) || 19}px`);
    }
    async function openChapter(n) {
      const r = await api('GET', `/api/book/chapters/${n}`);
      if (!r || r.ok === false) { toast((r && r.words) || 'That chapter can\'t be read now.'); return; }
      S.reading = r;
      show('book');
      paintReader();
      try { root.scrollTo(0, 0); } catch (_) { /* fine */ }
    }

    // -------------------------------------------------------------- chat with the AIs
    function paintTo() {
      const ais = (S.state && S.state.ais) || [];
      fill($('chat-to'), ais.map((a) => {
        const on = S.to.length ? S.to.includes(a.id) : a.on;
        return el(doc, 'button', { class: `chip ${a.id}${a.on ? '' : ' off'}`, type: 'button', 'aria-pressed': on ? 'true' : 'false', text: a.label, disabled: !a.on, onclick: () => {
          const cur = S.to.length ? S.to.slice() : ais.filter((x) => x.on).map((x) => x.id);
          S.to = cur.includes(a.id) ? cur.filter((x) => x !== a.id) : cur.concat(a.id);
          store.set(TO_STORE, JSON.stringify(S.to));
          paintTo();
        } });
      }));
    }
    function bubbles(list, empty) {
      if (!list.length) return [el(doc, 'div', { class: 'empty', text: empty })];
      return list.map((m) => el(doc, 'div', { class: `bubble ${m.who}` }, [el(doc, 'div', { class: 'who', text: m.label || (m.who === 'me' ? 'You' : m.who === 'alfred' ? 'Alfred' : LABEL[m.who] || m.who) }), el(doc, 'div', { class: 'txt', text: m.text })]));
    }
    async function loadChat() {
      paintTo();
      const r = await api('GET', '/api/chat');
      if (!r || r.ok === false) return;
      const before = S.chat.length && S.chat[S.chat.length - 1].id;
      S.chat = r.messages || [];
      const after = S.chat.length && S.chat[S.chat.length - 1].id;
      fill($('chat-feed'), bubbles(S.chat, 'Say something to the AIs — their answers show here. To talk instead of typing, use the 🎤 on your keyboard.'));
      if (before !== after && S.tab === 'chat') { try { root.scrollTo(0, doc.body.scrollHeight); } catch (_) { /* fine */ } }
    }
    async function sendChat(e) {
      if (e) e.preventDefault();
      const box = $('chat-text');
      const text = box.value.trim();
      if (!text || S.sending) return;
      S.sending = true;
      const r = await api('POST', '/api/chat', { text, to: S.to });
      S.sending = false;
      if (r && r.ok) { box.value = ''; grow(box); loadChat(); }
      toast(r && r.ok ? (r.words || 'Sent.') : ((r && r.words) || 'Not sent.'));
    }

    // -------------------------------------------------------------- Alfred
    async function loadAlfred() {
      const r = await api('GET', '/api/alfred');
      if (!r || r.ok === false) return;
      S.alfred = r;
      fill($('alfred-waiting'), r.waitingOnPc ? el(doc, 'div', { class: 'card waiting' }, [el(doc, 'b', { text: '✋ Alfred is waiting for your OK on the PC' }), el(doc, 'p', { class: 'dim', text: r.waitingOnPc })]) : null);
      fill($('alfred-feed'), r.on ? bubbles(r.chat || [], 'Ask Alfred anything — he can check on the book, the AIs and the app for you. Tap 🎤 on your keyboard to talk.') : [el(doc, 'div', { class: 'empty', text: 'Alfred is off. Turn him on with the 🎩 switch on the PC.' })]);
      const last = (r.chat || []).filter((m) => m.who === 'alfred').pop();
      if (last && last.ts > S.lastAlfredSpoken) {
        if (S.lastAlfredSpoken && store.get(SPEAK_STORE, '0') === '1') speak(last.text);
        S.lastAlfredSpoken = last.ts;
      }
    }
    function speak(text) {
      try {
        const syn = root.speechSynthesis;
        if (!syn || !root.SpeechSynthesisUtterance) return;
        syn.cancel();
        syn.speak(new root.SpeechSynthesisUtterance(String(text).slice(0, 1200)));
      } catch (_) { /* no voice on this phone */ }
    }
    async function sendAlfred(e) {
      if (e) e.preventDefault();
      const box = $('alfred-text');
      const text = box.value.trim();
      if (!text || S.sending) return;
      S.sending = true;
      box.value = '';
      grow(box);
      const mine = S.alfred && S.alfred.chat ? S.alfred.chat.slice() : [];
      mine.push({ who: 'me', text, ts: now() }, { who: 'alfred', text: '…', ts: now() });
      fill($('alfred-feed'), bubbles(mine, ''));
      try { root.scrollTo(0, doc.body.scrollHeight); } catch (_) { /* fine */ }
      const r = await api('POST', '/api/alfred', { text });
      S.sending = false;
      if (!r || r.ok === false) toast((r && r.words) || 'Alfred did not answer.');
      loadAlfred();
    }

    // -------------------------------------------------------------- alerts
    function paintAlertsBadge(before) {
      const list = (S.state && S.state.alerts) || [];
      const n = list.filter((a) => !a.seen).length;
      const b = $('alerts-badge');
      if (b) { b.hidden = !n; b.textContent = n > 9 ? '9+' : String(n); }
      const known = S.seenAlerts;
      S.seenAlerts = new Set(list.map((a) => a.id));
      if (known && before) {
        const fresh = list.filter((a) => !a.seen && !known.has(a.id));
        if (fresh.length) {
          try { if (root.navigator && root.navigator.vibrate) root.navigator.vibrate([180, 80, 180]); } catch (_) { /* no buzz */ }
          toast(`🔔 ${fresh[0].title}`);
        }
      }
    }
    function paintAlerts() {
      const list = (S.state && S.state.alerts) || [];
      fill($('alerts-list'), list.length ? list.map((a) => el(doc, 'button', { class: `item${a.seen ? '' : ' unseen'}`, type: 'button', 'data-id': a.id, onclick: async () => {
        await api('POST', '/api/alerts/seen', { id: a.id });
        if (a.kind === 'book') show('book'); else if (a.kind === 'alfred') show('alfred'); else loadState();
      } }, [
        el(doc, 'span', { class: 'big', text: a.kind === 'book' ? '📖' : a.kind === 'alfred' ? '🎩' : '🔔' }),
        el(doc, 'div', { class: 'grow' }, [el(doc, 'div', { class: 't', text: a.title }), a.body ? el(doc, 'div', { class: 's', text: a.body }) : null, el(doc, 'div', { class: 's', text: ago(a.at, now()) })]),
      ])) : el(doc, 'div', { class: 'empty', text: 'Nothing needs you right now.' }));
    }

    // -------------------------------------------------------------- wiring
    function grow(t) { t.style.height = 'auto'; t.style.height = `${Math.min(140, t.scrollHeight)}px`; }
    for (const b of doc.querySelectorAll('#tabs button')) b.addEventListener('click', () => { if (b.dataset.tab === 'book') S.reading = null; show(b.dataset.tab); });
    $('chat-form').addEventListener('submit', sendChat);
    $('alfred-form').addEventListener('submit', sendAlfred);
    for (const id of ['chat-text', 'alfred-text']) $(id).addEventListener('input', (e) => grow(e.target));
    $('chat-stop').addEventListener('click', async () => { const r = await api('POST', '/api/stop'); toast((r && r.words) || (r && r.ok ? 'Stopped.' : 'Could not stop them.')); });
    $('alerts-all').addEventListener('click', async () => { await api('POST', '/api/alerts/seen', { id: 'all' }); loadState(); });
    $('reader-back').addEventListener('click', () => { S.reading = null; show('book'); });
    $('reader-prev').addEventListener('click', () => { if (S.reading) openChapter(S.reading.number - 1); });
    $('reader-next').addEventListener('click', () => { if (S.reading) openChapter(S.reading.number + 1); });
    const resize = (d) => { const v = Math.max(14, Math.min(30, (Number(store.get(SIZE_STORE, 19)) || 19) + d)); store.set(SIZE_STORE, v); paintReader(); };
    $('reader-smaller').addEventListener('click', () => resize(-2));
    $('reader-bigger').addEventListener('click', () => resize(2));
    const sp = $('alfred-speak');
    sp.checked = store.get(SPEAK_STORE, '0') === '1';
    sp.addEventListener('change', () => store.set(SPEAK_STORE, sp.checked ? '1' : '0'));

    show();
    if (S.key) loadState();
    if (opts.poll !== false) {
      S.timers.push(setInterval(() => { if (!doc.hidden) loadState(); }, 4000));
      S.timers.push(setInterval(() => { if (doc.hidden || !S.key) return; if (S.tab === 'chat') loadChat(); if (S.tab === 'alfred') loadAlfred(); }, 3000));
      doc.addEventListener('visibilitychange', () => { if (!doc.hidden && S.key) loadState(); });
    }
    return { S, show, loadState, loadChat, loadAlfred, loadChapters, openChapter, stop: () => S.timers.forEach(clearInterval) };
  }

  const out = { start, takeKey, timeLeft, ago };
  if (typeof module !== 'undefined' && module.exports) module.exports = out;
  if (root && root.document && !root.__PHONE_APP_NO_AUTOSTART) {
    root.PhoneApp = out;
    const go = () => { try { root.PhoneApp.app = start(root.document); } catch (e) { const w = root.document.getElementById('pc-words'); if (w) w.textContent = `The app could not start: ${e && e.message}`; } };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', go); else go();
  } else if (root) root.PhoneApp = out;
})(typeof window !== 'undefined' ? window : null);
