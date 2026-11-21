'use strict';
// test/fixtures/phone-fake.js — a believable PC for the 📱 phone app tests and screenshots: three AIs, a book being
// written that stopped on a question, a few chapters, Alfred, and the fakes phone-main.js needs (no Electron, no Akọwe).
const ISO = (ms) => new Date(ms).toISOString();

function makeFakePc(opts = {}) {
  const t0 = opts.now || Date.UTC(2026, 10, 18, 15, 0, 0);
  const calls = [];
  const chapterText = (n) => `# Chapter ${n}: ${['The Lighthouse', 'Salt and Iron', 'The Keeper\'s Letter'][n - 1] || 'More'}\n\nThe fog rolled in over Gullhaven before dawn, and Mara Vell climbed the hundred and twelve steps of the old lighthouse with a lantern in one hand and her master's last letter in the other.\n\nShe stopped at the window where the glass had cracked. Below, the harbour lay grey and still, the boats knocking against each other like old men sharing a secret.\n\n"You're late," said a voice behind her.`;
  const state = {
    run: {
      id: 'run-abc123', project_id: 'p1', branch_id: 'main', title: 'The Salt Tuner', alive: false, state: 'needs_decision', status: 'paused',
      state_words: 'Waiting for you — chapter 7 needs a decision', steps_done: 11, steps_total: 19, percent: 58, left_s: 6000, finish_at: ISO(t0 + 6000e3),
      step_label: 'Writing chapter 7 of 12', needs_you: true,
      alert: {
        key: 'decision:REVIEW:ch7', icon: '🧐', label: 'A decision for you', what: 'Chapter 7', wrong: 'The reviewer thinks Mara is too calm when she finds the letter.',
        why: 'Two AIs disagreed about the scene.', next: 'Pick one: accept the change, keep the original, or edit it yourself.',
        change: 'Make Mara\'s hands shake as she reads; add one line of her fear.',
        choices: [{ action: 'accept_change', label: '✔ Accept the change' }, { action: 'keep_original', label: '↩ Keep the original' }, { action: 'approve_anyway', label: '✔ Approve it anyway' }, { action: 'edited', label: '▶ I edited it — continue' }],
      },
    },
    participants: [
      { id: 'chatgpt', enabled: true, ready: true, generating: false }, { id: 'claude', enabled: true, ready: true, generating: true }, { id: 'gemini', enabled: false, ready: false, generating: false },
    ],
    replies: [
      { id: 1, site: 'chatgpt', text: 'Here are three titles for the sequel: The Salt Choir, Iron Tide, The Last Keeper.', ts: t0 - 600000 },
      { id: 2, site: 'claude', text: 'I like "The Last Keeper" — it echoes the lighthouse and Mara\'s master. Want a one-line pitch for it?', ts: t0 - 540000 },
    ],
    alfred: { enabled: true, busy: false, card: null, chat: [
      { role: 'user', text: 'How is the book going?', ts: t0 - 300000 },
      { role: 'assistant', text: 'The Salt Tuner is at chapter 7 of 12. It is waiting for your decision on one scene; everything else is on track — about 1 h 40 m left once you answer.', ts: t0 - 290000 },
    ] },
    chapters: [1, 2, 3].map((n) => ({ number: n, title: ['The Lighthouse', 'Salt and Iron', 'The Keeper\'s Letter'][n - 1], words: 2400 + n * 310, approved: n < 3, text: chapterText(n) })),
    akoweUp: true,
  };
  const akowe = async (method, p, body) => {
    calls.push({ fn: 'akowe', method, p, body });
    if (!state.akoweUp) return { status: 0, json: null, error: 'NOT_READY' };
    if (method === 'GET' && p === '/api/autobook') return { status: 200, json: { current: state.run } };
    const m = /^\/api\/autobook\/([^/]+)\/(pause|resume|decide)$/.exec(p);
    if (method === 'POST' && m) {
      if (m[2] === 'pause') { state.run = Object.assign({}, state.run, { state: 'pausing' }); return { status: 200, json: {} }; }
      if (m[2] === 'decide' && body.action === 'approve_anyway' && body.author_confirms !== true) return { status: 400, json: { message: 'needs confirmation' } };
      state.run = Object.assign({}, state.run, { state: 'working', alive: true, needs_you: false, alert: null, state_words: 'Writing chapter 7 of 12' });
      return { status: 200, json: {} };
    }
    const c = /^\/api\/projects\/p1\/branches\/main\/chapters(?:\/(\d+))?$/.exec(p);
    if (method === 'GET' && c) {
      if (!c[1]) return { status: 200, json: { chapters: state.chapters.map(({ text, ...x }) => x) } };
      const ch = state.chapters.find((x) => x.number === Number(c[1]));
      return ch ? { status: 200, json: Object.assign({ of: state.chapters.length }, ch) } : { status: 404, json: { message: 'no' } };
    }
    return { status: 404, json: null };
  };
  const alfred = async (channel, payload) => {
    calls.push({ fn: 'alfred', channel, payload });
    if (channel === 'alfred:status') return Object.assign({ ok: true }, state.alfred);
    if (channel === 'alfred:ask') { state.alfred.chat.push({ role: 'user', text: payload.text, ts: Date.now() }, { role: 'assistant', text: 'Certainly — I will look into it.', ts: Date.now() + 1 }); return { ok: true, text: 'Certainly' }; }
    return { ok: false };
  };
  return {
    state, calls, t0,
    deps: {
      participants: () => state.participants,
      replies: () => state.replies,
      sendTo: async (site, text) => { calls.push({ fn: 'sendTo', site, text }); return { ok: true }; },
      stopAll: async () => { calls.push({ fn: 'stopAll' }); },
      akowe, alfred,
      qr: async (text) => `<svg xmlns="http://www.w3.org/2000/svg" data-text="${text.length}"></svg>`,
      interfaces: () => ({ 'vEthernet (WSL)': [{ family: 'IPv4', address: '172.22.80.1', internal: false }], 'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.42', internal: false }], lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }),
      hostname: () => 'BATCAVE-PC',
    },
  };
}

module.exports = { makeFakePc };
