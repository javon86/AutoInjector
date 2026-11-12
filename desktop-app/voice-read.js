/*
 * voice-read.js — the plain helpers behind 🎤 talk-to-the-AIs and 🔊 read-aloud (used by main.js and voice-ui.js).
 *
 *   cleanForSpeech(text)     an AI reply -> words worth saying: code blocks become "(code block)", links become
 *                            "a link to example.com", markdown marks (**, #, -, |) and the app's routing tags
 *                            ([TO: …], [FROM: …], [MSG #0001]) go.
 *   chunkForSpeech(text,max) split into short pieces (sentences, ≤ max chars) so ⏹ Stop is instant and long
 *                            replies never hit the speech engine's own length limits.
 *   preview(text, words)     the first few words, for tooltips ("Reply 3 of 7 — “Here is the plan…”").
 *   replyList(transcript, s) one AI's replies from the app's captured conversation (oldest first), with short
 *                            previews — never site-error notices (rate limits, "chat is full").
 *   pickBrowserVoices(list)  a DIFFERENT installed voice per speaker (Alfred / ChatGPT / Claude / Gemini) for the
 *                            no-install fallback (the browser's speechSynthesis — on Windows the built-in
 *                            Microsoft voices, offline).
 *   defaultPiperVoices(list) the same for piper voice files found in models/voice.
 *   STYLE                    a slightly different pitch / pace per speaker so they also sound different when the
 *                            PC has only one voice.
 *
 * Plain JS, no dependencies: CommonJS in Node, window.VoiceRead in the page.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VoiceRead = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const WHO = ['butler', 'chatgpt', 'claude', 'gemini'];
  const WHO_LABEL = { butler: '🎩 Alfred', chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' };
  // pitch / pace per speaker (multiplied with the user's own speed)
  const STYLE = {
    butler: { pitch: 0.9, rate: 0.95 },
    chatgpt: { pitch: 1.0, rate: 1.0 },
    claude: { pitch: 1.06, rate: 0.97 },
    gemini: { pitch: 1.14, rate: 1.04 },
  };

  function hostOf(url) {
    const m = String(url).match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([^/:?#\s]+)/i) || String(url).match(/^www\.([^/:?#\s]+)/i);
    if (!m) return '';
    return m[1].replace(/^www\./i, '').toLowerCase();
  }

  function cleanForSpeech(text) {
    let s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    // the app's own routing marks
    s = s.replace(/^\s*\[MSG #\d+\]\s*$/gim, '').replace(/\[(?:TO|FROM):[^\]\n]{0,60}\]/gi, '').replace(/\[MSG #\d+\]/gi, '');
    // fenced code blocks (``` or ~~~), closed or running to the end
    s = s.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, '$1(code block)\n');
    // images / links in markdown: keep the words
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (m, alt) => (alt ? `(picture: ${alt})` : '(picture)'));
    s = s.replace(/\[([^\]]+)\]\((\S+?)\)/g, '$1');
    // bare links -> "a link to example.com"
    s = s.replace(/\b(?:https?:\/\/|www\.)[^\s<>()"']+/gi, (u) => { const h = hostOf(u); return h ? `a link to ${h}` : 'a link'; });
    // inline code: keep short words, drop long code
    s = s.replace(/`([^`\n]*)`/g, (m, c) => (c.length <= 40 ? c : '(code)'));
    // tables: drop separator rows, pipes become commas
    s = s.replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, '');
    s = s.replace(/^\s*\|(.*)\|\s*$/gm, (m, row) => row.split('|').map((c) => c.trim()).filter(Boolean).join(', ') + '.');
    // headings, quotes, bullets, numbered lists, rules
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*>\s?/gm, '');
    s = s.replace(/^\s*[-*+•]\s+/gm, '').replace(/^\s*(\d+)[.)]\s+/gm, '$1. ');
    s = s.replace(/^\s*([-*_])\s*(\1\s*){2,}$/gm, '');
    // emphasis marks
    s = s.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2').replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2').replace(/~~(.+?)~~/g, '$1');
    // HTML-ish tags
    s = s.replace(/<\/?[a-z][^>\n]{0,80}>/gi, ' ');
    // whitespace
    s = s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return s;
  }

  function chunkForSpeech(text, max) {
    const lim = Math.max(40, Number(max) || 220);
    const out = [];
    const paras = String(text || '').split(/\n+/).map((p) => p.trim()).filter(Boolean);
    for (const p of paras) {
      const sentences = p.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)\s*/g) || [p];
      let cur = '';
      const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
      for (let s of sentences) {
        s = s.trim();
        if (!s) continue;
        while (s.length > lim) { // one very long sentence: cut at a comma / space
          let cut = s.lastIndexOf(', ', lim);
          if (cut < lim / 3) cut = s.lastIndexOf(' ', lim);
          if (cut < lim / 3) cut = lim;
          push(); out.push(s.slice(0, cut + 1).trim()); s = s.slice(cut + 1).trim();
        }
        if (cur && cur.length + 1 + s.length > lim) push();
        cur = cur ? `${cur} ${s}` : s;
      }
      push();
    }
    return out;
  }

  function preview(text, words) {
    const n = Math.max(1, Number(words) || 8);
    const w = cleanForSpeech(text).replace(/\(code block\)/g, ' ').split(/\s+/).filter(Boolean);
    if (!w.length) return '';
    return w.slice(0, n).join(' ') + (w.length > n ? '…' : '');
  }

  function isSpeakableTurn(t, site) {
    return !!(t && t.site === site && !t.isRateLimited && !t.siteError && typeof t.text === 'string' && t.text.trim());
  }
  function replyList(transcript, site, opts) {
    const words = (opts && opts.words) || 8;
    const list = (Array.isArray(transcript) ? transcript : []).filter((t) => isSpeakableTurn(t, site));
    return list.map((t, i) => ({ id: t.id, n: i + 1, ts: t.ts || 0, preview: preview(t.text, words) }));
  }

  // A different voice per speaker from the voices this PC has. Prefers English, local (offline) voices.
  const PREFER = {
    butler: [/george|ryan|hazel|alan|daniel|arthur|en-gb.*male|british/i, /david|guy|mark/i],
    chatgpt: [/zira|aria|jenny|samantha|lessac/i, /female/i],
    claude: [/david|guy|christopher|eric|alex|ryan/i, /male/i],
    gemini: [/mark|susan|sonia|libby|amy|karen|moira|tessa/i, /female/i],
  };
  function pickBrowserVoices(voices) {
    const all = (Array.isArray(voices) ? voices : []).filter((v) => v && v.name);
    let en = all.filter((v) => /^en\b|^en[-_]/i.test(String(v.lang || '')));
    if (!en.length) en = all;
    const local = en.filter((v) => v.localService !== false);
    const pool = local.length ? local : en;
    const out = {};
    const used = new Set();
    for (const who of WHO) {
      let pick = null;
      for (const re of PREFER[who]) { pick = pool.find((v) => !used.has(v.name) && re.test(`${v.name} ${v.lang || ''}`)); if (pick) break; }
      if (!pick) pick = pool.find((v) => !used.has(v.name));
      if (!pick) pick = pool[WHO.indexOf(who) % Math.max(1, pool.length)] || null;
      out[who] = pick ? pick.name : '';
      if (pick) used.add(pick.name);
    }
    return out;
  }
  // piper voice files (names without .onnx) -> who -> name; distinct while there are enough.
  // The better voices first (voice-catalog.js recommends: Alfred en_GB-alan, ChatGPT en_US-lessac-high, Claude
  // en_US-ryan-high, Gemini en_GB-alba), then their smaller / similar ones — a "-high" voice beats its "-medium".
  const PIPER_PREFER = {
    butler: [/en_GB-alan/i, /en_GB-(northern_english_male|semaine)/i, /en_GB/i],
    chatgpt: [/en_US-lessac-high/i, /en_US-lessac/i, /en_US-(hfc_female|kristin|amy)/i],
    claude: [/en_US-ryan-high/i, /en_US-(ryan|joe|john|bryce|kusal)/i, /en_US/i],
    gemini: [/en_GB-alba/i, /en_GB-(cori|jenny)/i, /en_US-(amy|kathleen|hfc_female)/i, /en_/i],
  };
  function defaultPiperVoices(names) {
    const pool = (Array.isArray(names) ? names : []).map(String).filter(Boolean);
    const out = {};
    const used = new Set();
    for (const who of WHO) {
      let pick = null;
      for (const re of PIPER_PREFER[who]) { pick = pool.find((n) => !used.has(n) && re.test(n)); if (pick) break; }
      if (!pick) pick = pool.find((n) => !used.has(n)) || pool[0] || '';
      out[who] = pick;
      if (pick) used.add(pick);
    }
    return out;
  }

  return { WHO, WHO_LABEL, STYLE, cleanForSpeech, chunkForSpeech, preview, replyList, pickBrowserVoices, defaultPiperVoices, hostOf };
}));
