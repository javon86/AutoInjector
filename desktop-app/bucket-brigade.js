// bucket-brigade.js — TR-14 Bucket Brigade: a scored relay run on the REAL sites.
//
// The AIs pass a numbered list around using the app's normal [TO: X] relay.
// Each AI adds the next item from a fixed table and hands the list on, for 19
// hand-offs (B02..B20). The items are chosen to stress the path: line breaks,
// accents, quotes, code, brackets, symbols, a URL, a long paragraph.
//
// Every hop is judged from program-visible evidence and the blame is split:
//   APP  — was the message delivered (and proven)? was the reply captured?
//          did the app pass on exactly what it captured? any duplicates?
//   AI   — did the AI follow the format (right [TO:], kept every item, added
//          the right one)? did any item come back altered?
// If an AI breaks the chain, the runner hands the CORRECT list to the next AI
// itself ("repair"), marks the hop, and carries on — so one slip doesn't hide
// how the rest of the system behaves.
//
// Pure: main.js injects send/capture/ledger access; unit-tested with a fake world.

const ITEMS = {
  B01: "The brigade starts here.",
  B02: "Pi is about 3.14159; e is about 2.718 (100% approximate).",
  B03: "Line one of B03\nLine two of B03",
  B04: "Café, naïve, jalapeño, São Paulo, Zürich.",
  B05: "She said \"pass it on\" and it's done — no changes.",
  B06: "Run `npm run test:unit` before you push.",
  B07: "[not a routing tag] {curly braces} <angle brackets>",
  B08: "- apples\n- pears\n- plums",
  B09: "This item is deliberately long so that a truncated relay shows up: the quick brown fox jumps over the lazy dog, then the lazy dog gets up, stretches, and walks to the far end of the yard where the old oak tree throws a wide shadow across the grass in the late afternoon.",
  B10: "Symbols: ✓ ✗ → ← ± × ÷ °",
  B11: "Plain sentence number eleven.",
  B12: "https://example.com/path?a=1&b=two#frag",
  B13: "First line\nSecond line\nThird line",
  B14: "Math: 2 + 2 = 4; 10 / 5 = 2; 3 * 3 = 9.",
  B15: "Don't, can't, won't, it's, they're.",
  B16: "1) one 2) two 3) three",
  B17: "MIXED Case STAYS mixed Case.",
  B18: "Tabs and   double  spaces   stay put.",
  B19: "Second to last item.",
  B20: "END OF BRIGADE",
};
const IDS = Object.keys(ITEMS);
const LABEL = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };

const norm = (s) => String(s || "").replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").trim();

// Pull the items out of a BRIGADE message. -> { ids:[...], items:{id:text}, dupes:[id] }
function parseItems(text) {
  const body = String(text || "").replace(/\r\n/g, "\n");
  const re = /^(B\d{2}):[ \t]?/gm;
  const marks = []; let m;
  while ((m = re.exec(body))) marks.push({ id: m[1], start: m.index, end: m.index + m[0].length });
  const items = {}; const ids = []; const dupes = [];
  marks.forEach((mk, i) => {
    let val = body.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : body.length);
    val = val.replace(/\n?\[\s*FROM\s*:[^\]]*\]\s*$/i, "");
    if (items[mk.id] != null) dupes.push(mk.id);
    items[mk.id] = norm(val); ids.push(mk.id);
  });
  return { ids, items, dupes };
}

function listText(upTo) {
  const n = IDS.indexOf(upTo) + 1;
  return ["BRIGADE", ...IDS.slice(0, n).map((id) => `${id}: ${ITEMS[id]}`)].join("\n");
}

// What changed in an item, in plain words.
function damageKind(want, got) {
  if (got == null) return "missing";
  if (norm(got) === norm(want)) return null;
  if (got.replace(/\s+/g, " ").trim() === want.replace(/\s+/g, " ").trim()) return "line breaks or spacing changed";
  if (want.startsWith(got.slice(0, Math.max(1, got.length - 3))) && got.length < want.length) return "cut short";
  if (got.normalize("NFD").replace(/[̀-ͯ]/g, "") === want.normalize("NFD").replace(/[̀-ͯ]/g, "")) return "accents changed";
  if (got.replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'") === want) return "quote marks changed";
  return "text changed";
}

function setupPrompt(site, order, label) {
  const n = order.length;
  const i = order.indexOf(site);
  const next = order[(i + 1) % n];
  const mine = IDS.filter((_, k) => k >= 1 && (k - 1) % n === i);
  return [
    "[AutoInjector relay check — a test of the app, not a real task. About 20 short messages.]",
    "We'll pass a numbered list around. When a message reaches you that contains a BRIGADE list:",
    `1. Copy EVERY item in it exactly as written (same characters, same line breaks).`,
    `2. Add the next item number from the table below, exactly as written.`,
    `3. Send it on: start your reply with [TO: ${next.toUpperCase()}], then the line BRIGADE, then all the items, then [FROM: ${site.toUpperCase()}]. If you just added B20, use [TO: USER] instead.`,
    `Your items are ${mine.join(", ")}. If the last item in a BRIGADE message is not the one right before one of yours, reply with just NONE.`,
    "Do not add any other words, comments or formatting (no code blocks around the list).",
    "",
    "THE TABLE:",
    ...IDS.map((id) => `${id}: ${ITEMS[id]}`),
    "",
    `Reply to THIS message with just NONE. (You are ${label(site)}; the list goes from you to ${label(next)}.)`,
  ].join("\n");
}

// deps: { sites, label, send(site,text)->res, captureSince(site,ts)->[{text,ts}],
//         sendsSince(target,ts)->[{text, ok, verified, seq, ts}], now, sleep,
//         shouldStop, onProgress, hopTimeoutMs, pollMs, setupWaitMs }
async function runBrigade(deps) {
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const label = deps.label || ((s) => LABEL[s] || s);
  const order = (deps.sites || []).slice();
  if (order.length < 2) return { ok: false, error: "NEED_TWO_AIS" };
  const hopTimeoutMs = deps.hopTimeoutMs || 4 * 60 * 1000;
  const pollMs = deps.pollMs || 1000;
  const progress = (p) => { try { deps.onProgress && deps.onProgress(p); } catch (_) {} };
  const stop = () => !!(deps.shouldStop && deps.shouldStop());
  const t0 = now();
  const hops = [];
  const setup = {};

  // 1) teach every AI the rules (each replies NONE)
  for (const s of order) {
    progress({ status: "setup", site: s });
    const r = await deps.send(s, setupPrompt(s, order, label));
    setup[s] = { ok: !!(r && r.ok), verified: r && r.verified === true, error: r && !r.ok ? r.error : null };
  }
  await sleep(deps.setupWaitMs != null ? deps.setupWaitMs : 20000); // let the NONE replies land

  // 2) start the chain with B01
  let holder = order[0];
  let lastList = listText("B01");
  let startTs = now();
  const first = await deps.send(holder, `(Relay check: add your next item and pass it on as described.)\n\n${lastList}`);
  let delivered = { ok: !!(first && first.ok), verified: first && first.verified === true, repaired: false };

  for (let k = 1; k < IDS.length; k++) {
    if (stop()) break;
    const id = IDS[k];
    const by = holder;
    const next = k === IDS.length - 1 ? "user" : order[(order.indexOf(by) + 1) % order.length];
    let nextStart = null; // when the next AI could first have seen the list
    const hop = { item: id, by, to: next, delivered: delivered.ok, verified: delivered.verified, repairedIn: delivered.repaired, replyCaptured: false, replySec: null, aiFollowed: false, aiIssue: null, damaged: [], appPassedOnExactly: null, passedOn: null, duplicates: 0 };
    progress({ status: "hop", item: id, site: by, of: IDS.length - 1, index: k });
    // wait for the holder's BRIGADE reply
    let reply = null;
    const deadline = startTs + hopTimeoutMs;
    let firstSeen = null;
    while (!reply && now() < deadline && !stop()) {
      const caps = (deps.captureSince(by, startTs) || []).filter((c) => /BRIGADE/.test(c.text));
      // Prefer the reply that adds THIS hop's item; take any other BRIGADE reply
      // from this AI only if nothing better shows up within a few seconds.
      const exact = caps.find((c) => { const p = parseItems(c.text); return p.ids[p.ids.length - 1] === id; });
      if (exact) reply = exact;
      else if (caps.length) { if (firstSeen == null) firstSeen = now(); if (now() - firstSeen > 5000) reply = caps[caps.length - 1]; else await sleep(pollMs); }
      else await sleep(pollMs);
    }
    if (reply) {
      hop.replyCaptured = true;
      hop.replySec = Math.round((reply.ts - startTs) / 1000);
      const raw = String(reply.text);
      const toM = /^\s*\[\s*TO\s*:\s*(\w+)\s*\]/i.exec(raw);
      const to = toM ? toM[1].toLowerCase() : null;
      const got = parseItems(raw);
      const want = IDS.slice(0, k + 1);
      const issues = [];
      if (to !== next) issues.push(`addressed ${to ? to.toUpperCase() : "nobody"} instead of ${next.toUpperCase()}`);
      const missing = want.filter((w) => got.items[w] == null);
      if (missing.length) issues.push(`left out ${missing.join(", ")}`);
      const extra = got.ids.filter((x) => !want.includes(x));
      if (extra.length) issues.push(`added extra ${[...new Set(extra)].join(", ")}`);
      if (got.dupes.length) issues.push(`repeated ${got.dupes.join(", ")}`);
      const ordered = got.ids.filter((x) => want.includes(x));
      if (ordered.join() !== want.filter((w) => got.items[w] != null).join()) issues.push("items out of order");
      for (const w of want) {
        if (got.items[w] == null) continue;
        const dk = damageKind(ITEMS[w], got.items[w]);
        if (dk) hop.damaged.push({ item: w, how: dk });
      }
      hop.aiFollowed = !issues.length;
      hop.aiIssue = issues.join("; ") || null;
      if (hop.damaged.length && hop.aiFollowed) hop.aiIssue = null;
      // did the app pass on exactly what it captured?
      if (next !== "user" && to === next) {
        const sendDeadline = now() + 60000;
        let s = null;
        // The relay of THIS reply: sent to `next` after the capture, ending in this hop's item.
        const isThisHop = (x) => /BRIGADE/.test(x.text || "") && (() => { const p = parseItems(x.text); return p.ids[p.ids.length - 1] === id; })();
        const relaysOfThisHop = () => (deps.sendsSince(next, reply.ts) || []).filter(isThisHop);
        while (!s && now() < sendDeadline && !stop()) {
          const sends = relaysOfThisHop();
          if (sends.length) s = sends[0]; else await sleep(pollMs);
        }
        if (s) {
          const sentItems = parseItems(s.text);
          hop.appPassedOnExactly = want.every((w) => got.items[w] == null || sentItems.items[w] === got.items[w]);
          hop.passedOn = { ok: !!s.ok, verified: s.verified === true };
          if (deps.settleMs) await sleep(deps.settleMs); // give a would-be second copy time to show up
          hop.duplicates = Math.max(0, relaysOfThisHop().filter((x) => x.ok).length - 1);
          delivered = { ok: !!s.ok, verified: s.verified === true, repaired: false };
          nextStart = reply.ts; // a fast AI may answer before this runner finishes checking
        } else {
          hop.passedOn = { ok: false, verified: false, missing: true };
        }
      }
    }
    hops.push(hop);
    progress({ status: hop.replyCaptured && hop.aiFollowed ? "hop-ok" : "hop-problem", item: id, site: by, detail: hop.aiIssue || (hop.replyCaptured ? "" : "no reply captured") });
    if (next === "user") break;
    // repair the chain if this hop didn't hand on correctly
    const handedOn = hop.replyCaptured && hop.passedOn && hop.passedOn.ok && hop.aiFollowed;
    lastList = listText(id);
    holder = next;
    startTs = handedOn && nextStart != null ? nextStart : now();
    if (!handedOn) {
      const r = await deps.send(next, `(Relay check: the previous step went wrong, so the app is handing you the correct list. Add your next item and pass it on as described.)\n\n${lastList}`);
      delivered = { ok: !!(r && r.ok), verified: r && r.verified === true, repaired: true };
    }
  }

  return summarize({ order, setup, hops, t0, t1: now(), stopped: stop(), label });
}

function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

function summarize({ order, setup, hops, t0, t1, stopped }) {
  const per = {};
  for (const s of order) per[s] = { hops: 0, captured: 0, followed: 0, damaged: 0, replySecs: [] };
  for (const h of hops) {
    const p = per[h.by]; if (!p) continue;
    p.hops++; if (h.replyCaptured) { p.captured++; p.replySecs.push(h.replySec); }
    if (h.aiFollowed) p.followed++;
    if (h.damaged.length) p.damaged++;
  }
  for (const p of Object.values(per)) { p.medianReplySec = median(p.replySecs); delete p.replySecs; }
  const deliveredHops = hops.filter((h) => h.delivered).length;
  const provenHops = hops.filter((h) => h.verified).length;
  const capturedHops = hops.filter((h) => h.replyCaptured).length;
  const exactHops = hops.filter((h) => h.appPassedOnExactly === true).length;
  const checkedExact = hops.filter((h) => h.appPassedOnExactly != null).length;
  const dupes = hops.reduce((n, h) => n + h.duplicates, 0);
  const repairs = hops.filter((h) => h.repairedIn).length;
  const app = {
    delivered: `${deliveredHops}/${hops.length}`, proven: `${provenHops}/${hops.length}`,
    captured: `${capturedHops}/${hops.length}`, passedOnExactly: `${exactHops}/${checkedExact}`, duplicates: dupes,
  };
  const appPass = hops.length > 0 && deliveredHops === hops.length && capturedHops === hops.length && exactHops === checkedExact && dupes === 0;
  const finished = hops.length === IDS.length - 1 && !stopped;
  return { ok: true, finished, stopped, order, setup, hops, per, app, appPass, repairs, seconds: Math.round((t1 - t0) / 1000) };
}

function formatReport(r, { label = (s) => LABEL[s] || s } = {}) {
  const L = [];
  L.push("# Bucket Brigade — relay check");
  L.push("");
  L.push(`Order: ${r.order.map(label).join(" → ")} · ${r.hops.length} hand-offs · ${r.seconds}s${r.stopped ? " · STOPPED early" : ""}${r.finished ? "" : " · did not finish"}`);
  L.push("");
  L.push(`**App verdict: ${r.appPass ? "PASS — every hand-off was delivered, captured and passed on exactly, with no duplicates." : "FAIL — see the app checks below."}**`);
  L.push("");
  L.push("## App checks (the program's job)");
  L.push(`- Delivered: ${r.app.delivered}`);
  L.push(`- Proven in the chat ([MSG #] seen): ${r.app.proven}`);
  L.push(`- Reply captured: ${r.app.captured}`);
  L.push(`- Passed on exactly as captured: ${r.app.passedOnExactly}`);
  L.push(`- Duplicate deliveries: ${r.app.duplicates}`);
  if (r.repairs) L.push(`- Hand-offs the app had to repair after an AI slip: ${r.repairs}`);
  L.push("");
  L.push("## Per AI");
  for (const s of r.order) {
    const p = r.per[s];
    L.push(`- ${label(s)}: ${p.captured}/${p.hops} replies captured · followed the format ${p.followed}/${p.hops} · altered items in ${p.damaged} · typical reply ${p.medianReplySec == null ? "—" : p.medianReplySec + "s"}`);
  }
  L.push("");
  L.push("## Hand-off by hand-off");
  for (const h of r.hops) {
    const bits = [];
    bits.push(h.delivered ? (h.verified ? "delivered ✓" : "delivered (unproven)") : "NOT delivered");
    bits.push(h.replyCaptured ? `reply ${h.replySec}s` : "NO REPLY CAPTURED");
    if (h.aiIssue) bits.push(`AI: ${h.aiIssue}`);
    if (h.damaged.length) bits.push(`altered: ${h.damaged.map((d) => `${d.item} (${d.how})`).join(", ")}`);
    if (h.appPassedOnExactly === false) bits.push("APP CHANGED THE TEXT when passing it on");
    if (h.passedOn && h.passedOn.missing) bits.push("APP DID NOT PASS IT ON");
    if (h.duplicates) bits.push(`${h.duplicates} DUPLICATE`);
    if (h.repairedIn) bits.push("(this hop started from an app repair)");
    L.push(`- ${h.item} by ${label(h.by)} → ${h.to === "user" ? "you" : label(h.to)}: ${bits.join(" · ")}`);
  }
  const setupBad = Object.entries(r.setup).filter(([, v]) => !v.ok);
  if (setupBad.length) { L.push(""); L.push(`Setup message failed for: ${setupBad.map(([s, v]) => `${label(s)} (${v.error})`).join(", ")}`); }
  L.push("");
  L.push("How to read this: app checks are the program's responsibility. \"AI:\" lines and altered items are usually the AI not following instructions; if one AI always loses line breaks, the typing into that site may be flattening them.");
  return L.join("\n");
}

module.exports = { runBrigade, formatReport, parseItems, listText, setupPrompt, damageKind, ITEMS, IDS };
