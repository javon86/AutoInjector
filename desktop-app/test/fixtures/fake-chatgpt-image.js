'use strict';
// fake-chatgpt-image.js — a Node-side stand-in for the ChatGPT pane's IMAGE side,
// at the same fidelity as mock-electron.js: it answers chatgpt-image.js's page
// scripts (scan / fetch / convert, recognised by their marker) from a little state
// machine instead of a DOM. Real DOM behaviour is covered by test/chatgpt-image.test.js
// (real Chromium + test/fixtures/fake-chat.html?image=…).
//   const pane = fakeChatGptPane({ mode: 'ok', delayMs: 300 });
//   pane.send(text)            → a message was typed (call it from the send path)
//   pane.run(script)           → what executeJavaScript would return (null = not ours)
// mode: ok | webp | refuse | limit | banner | words | never | loggedout | fetchfail
const zlib = require('zlib');
const { crc32 } = require('../../sd-images');

const MARKER = '__AUTOINJECTOR_CHATIMG__';

// A real PNG (RGB, noisy so it isn't tiny).
function makePng(w = 320, h = 480, seed = 7) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let x = seed >>> 0;
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let i = 0; i < w * 3; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; raw[y * (w * 3 + 1) + 1 + i] = (x >>> 16) & 0xff; }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A minimal WebP header (VP8X) — enough for sniff(); the bytes are not decodable.
function makeWebpHeader(w = 512, h = 768) {
  const b = Buffer.alloc(64);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(56, 4); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1'); b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}

function fakeChatGptPane(opts) {
  const o = opts || {};
  const st = {
    mode: o.mode || 'ok', delayMs: o.delayMs == null ? 300 : o.delayMs, turns: o.turns || 1, png: o.png || makePng(), sends: [], scans: 0, fetches: 0, converts: 0,
    srcs: ['https://chatgpt.example/old-picture.png'], current: null, avatar: o.avatar !== false,
  };
  function send(text) {
    st.sends.push({ text: String(text || ''), at: Date.now() });
    if (/Create (?:an|one|a)(?: wide| tall)? image|Create an image in a/i.test(String(text || ''))) {
      st.turns += 1;
      st.current = { n: st.turns, at: Date.now(), src: `https://chatgpt.example/backend-api/estuary/content?id=file_${st.turns}${st.mode === 'webp' ? '.webp' : '.png'}` };
    }
    return { ok: true };
  }
  const avatar = () => ({ src: 'data:image/png;base64,AAAA', alt: 'ChatGPT avatar', nw: 28, nh: 28, w: 28, h: 28, complete: true, blurred: false, hidden: false, avatar: true });
  function scan() {
    st.scans++;
    const base = { ok: true, url: 'https://chatgpt.com/c/fake', turns: st.turns, generating: false, inputFound: st.mode !== 'loggedout', loggedOut: st.mode === 'loggedout', notice: '', srcs: st.srcs.slice() };
    const c = st.current;
    if (!c) return Object.assign(base, { last: { text: 'An older text reply.', images: [], progress: false } });
    const t = Date.now() - c.at;
    const imgs = st.avatar ? [avatar()] : [];
    if (st.mode === 'never' || t < st.delayMs) {
      if (st.mode === 'banner' && t > st.delayMs / 2) base.notice = "You've reached the limit for image generation requests. Please try again later.";
      const preview = t > st.delayMs / 2 ? [{ src: `${c.src}&preview=1`, alt: 'Generated image', nw: 512, nh: 768, w: 256, h: 384, complete: true, blurred: true, hidden: false, avatar: false }] : [];
      return Object.assign(base, { generating: st.mode !== 'never' || t < st.delayMs, last: { text: 'Creating image', images: imgs.concat(preview), progress: true } });
    }
    if (st.mode === 'refuse') return Object.assign(base, { last: { text: "I'm sorry, but I can't create that image because it goes against our content policy. Want something else?", images: imgs, progress: false } });
    if (st.mode === 'limit') return Object.assign(base, { last: { text: "You've reached your image creation limit. Your limit resets in 4 hours.", images: imgs, progress: false } });
    if (st.mode === 'words') return Object.assign(base, { last: { text: 'Here is how the character could look: a grey coat and a lantern.', images: imgs, progress: false } });
    if (st.mode === 'banner') return Object.assign(base, { notice: "You've reached the limit for image generation requests. Please try again later.", last: { text: 'Creating image', images: imgs, progress: true } });
    return Object.assign(base, { last: { text: '', images: imgs.concat([{ src: c.src, alt: 'Generated image', nw: 1024, nh: 1536, w: 400, h: 600, complete: true, blurred: false, hidden: false, avatar: false }]), progress: false } });
  }
  function run(script) {
    const s = String(script || '');
    if (!s.includes(MARKER)) return null;
    if (/\/\* __AUTOINJECTOR_CHATIMG__ fetch \*\//.test(s)) {
      st.fetches++;
      if (st.mode === 'fetchfail') return { ok: false, error: 'HTTP_403' };
      if (st.mode === 'webp') return { ok: true, b64: makeWebpHeader().toString('base64'), kind: 'webp', mime: 'image/webp', bytes: 64, how: 'fetch' }; // as if the page could not convert it
      return { ok: true, b64: st.png.toString('base64'), kind: 'png', mime: 'image/png', bytes: st.png.length, converted: false, how: 'fetch' };
    }
    if (/\/\* __AUTOINJECTOR_CHATIMG__ convert \*\//.test(s)) { st.converts++; return { ok: true, b64: st.png.toString('base64') }; }
    return scan();
  }
  return { state: st, send, run, scan };
}

module.exports = { fakeChatGptPane, makePng, makeWebpHeader, MARKER };
