// relay-trace.js — TR-13 Relay Trace. Follows every message the app sends,
// by its [MSG #n] number, through each stage it can PROVE:
//
//   1 typed     the send script ran against the AI's box
//   2 proven    its [MSG #n] number showed up in the chat (or: unproven / failed)
//   3 started   the AI began writing a reply afterwards
//   4 answered  a finished reply from that AI was captured
//   5 handed on that reply was forwarded to another AI / the Butler / the
//               terminal — or held back, and why (for you, hop limit, loop guard)
//
// and reports, per AI, how many messages reached each stage and where the rest
// stopped. It records only; it never sends anything. Pure (no Electron), so
// main.js feeds it events and it can be unit-tested with a fake clock.

const crypto = require("crypto");

const DEFAULT_NO_REPLY_MS = 3 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

function hashBody(text) {
  // The [MSG #n] header differs on every send, so hash the body without it.
  const body = String(text || "").replace(/^\[MSG #\d+\]\n?/, "").trim();
  return crypto.createHash("sha1").update(body).digest("hex").slice(0, 12);
}

function createRelayTrace({ now = () => Date.now(), maxMessages = 2000, noReplyMs = DEFAULT_NO_REPLY_MS } = {}) {
  let msgs = [];               // in send order
  const bySeq = new Map();
  const turns = new Map();     // captured turn id -> { site, at, answers:[seq], handoffs:[], held:null }
  const writing = {};          // site -> true while the AI is seen writing (since its last idle/capture)
  const startedAt = now();

  function add(m) {
    msgs.push(m); bySeq.set(m.seq, m);
    if (msgs.length > maxMessages) { const old = msgs.shift(); bySeq.delete(old.seq); }
  }

  // kind: "user"/"program" (you or the app started it), "relay" (another AI's
  // reply passed on), "auto" (terminal results, missing-tag nudges).
  function noteSend({ seq, target, from = null, kind = "program", sourceTurnId = null, text = "" }) {
    if (seq == null) return;
    const m = { seq: String(seq), target, from, kind, sourceTurnId, at: now(), hash: hashBody(text), chars: String(text || "").length,
      result: null, error: null, attempts: null, typedOver: false, provenAt: null, startedAt: null, answeredAt: null, answerTurn: null, batched: false, duplicateOf: null, overtakenBy: null };
    // Same body to the same AI within a short window = a duplicate delivery.
    for (let i = msgs.length - 1; i >= 0; i--) {
      const p = msgs[i];
      if (m.at - p.at > DUPLICATE_WINDOW_MS) break;
      if (p.target === target && p.hash === m.hash && p.result !== "failed") { m.duplicateOf = p.seq; break; }
    }
    add(m);
    if (sourceTurnId != null && turns.has(sourceTurnId)) turns.get(sourceTurnId).handoffs.push({ to: target, seq: m.seq });
  }

  function noteSendResult(seq, res) {
    const m = bySeq.get(String(seq)); if (!m) return;
    m.attempts = res && res.attempts != null ? res.attempts : m.attempts;
    if (res && res.ok) {
      m.result = res.verified === true ? "proven" : res.verified === false ? "unproven" : "sent"; m.provenAt = now();
      // Typed while the AI was still writing an earlier reply (so no new
      // idle->writing edge can mark this one as started).
      m.typedOver = !!writing[m.target];
      // TR-30: an earlier message to this AI that it had STARTED answering, with
      // no reply captured yet — this message was typed over that reply, so the
      // reply may never be captured. (Not flagged when the AI hadn't started:
      // then it simply answers both at once.)
      // A reminder the app sends because the reply had no [FROM:] tag replaces
      // that reply by design — not a loss.
      if (m.kind !== "auto") for (const p of msgs) {
        if (p === m || p.target !== m.target || p.answeredAt || !p.startedAt || p.overtakenBy) continue;
        if (p.result && p.result !== "failed" && p.at < m.at) p.overtakenBy = m.seq;
      }
    }
    // A send its caller withdrew before it was typed (a BookForge request that
    // timed out while the AI was busy) never went out: not a failure, not waiting.
    else if (res && res.error === "CANCELLED") { m.result = "cancelled"; }
    else { m.result = "failed"; m.error = (res && res.error) || "unknown"; }
  }

  // Messages to `site` that went out and haven't been answered yet, oldest first.
  function waiting(site) { return msgs.filter((m) => m.target === site && m.result && m.result !== "failed" && m.result !== "cancelled" && !m.answeredAt); }

  function noteGenerating(site) {
    writing[site] = true;
    for (const m of waiting(site)) if (!m.startedAt) m.startedAt = now();
  }
  // The AI stopped writing (its Send button came back).
  function noteIdle(site) { writing[site] = false; }

  // A finished reply from `site` was captured (turnId may be null for a silent
  // NONE / empty reply). It answers every message that site was still waiting on.
  // When the AI was seen writing after some of them but NOT after the newest
  // ones, AND those newest ones were typed while it was still writing that
  // earlier reply, the reply on the page is the answer to the older message
  // (typed over before it was captured): the newer ones stay open for the next
  // reply. A newer message typed while the AI was idle is answered by this
  // reply even if it came faster than one poll (no writing edge was seen) —
  // an older started message whose reply was never captured must not take it.
  function noteCapture(site, turnId, { none = false, rateLimited = false } = {}) {
    writing[site] = false; // a reply is only captured once the AI has finished it
    let open = waiting(site);
    let lastStarted = -1;
    open.forEach((m, i) => { if (m.startedAt) lastStarted = i; });
    const tail = open.slice(lastStarted + 1);
    if (lastStarted >= 0 && tail.length && tail.every((m) => m.typedOver)) open = open.slice(0, lastStarted + 1);
    const t = { site, at: now(), answers: open.map((m) => m.seq), handoffs: [], held: none ? "nothing-to-add" : rateLimited ? "rate-limited" : null };
    open.forEach((m, i) => { m.answeredAt = t.at; m.answerTurn = turnId; m.batched = i < open.length - 1; if (!m.startedAt) m.startedAt = t.at; });
    if (turnId != null) turns.set(turnId, t);
    if (turns.size > maxMessages) turns.delete(turns.keys().next().value);
  }

  // A captured reply was handed to the Butler/terminal, or deliberately held.
  function noteHandoff(turnId, to) { const t = turns.get(turnId); if (t) t.handoffs.push({ to, seq: null }); }
  function noteHeld(turnId, reason) { const t = turns.get(turnId); if (t && !t.held) t.held = reason; }
  // The [MSG #] numbers a captured reply answers (the BookForge bridge owns a
  // reply only when it answers the bridge's own prompt). null = unknown turn.
  function answersOf(turnId) { const t = turns.get(turnId); return t ? t.answers.slice() : null; }

  function stageOf(m, at) {
    if (!m.result) return "typing";
    if (m.result === "failed") return "failed";
    if (m.result === "cancelled") return "cancelled";
    if (m.answeredAt) return "answered";
    if (at - m.at >= noReplyMs) return m.result === "unproven" ? "unproven-no-reply" : "no-reply";
    return m.result === "unproven" ? "unproven-waiting" : "waiting";
  }

  function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

  function report() {
    const at = now();
    const sites = {};
    const anomalies = [];
    for (const m of msgs) {
      const s = sites[m.target] || (sites[m.target] = { sent: 0, proven: 0, sentUnchecked: 0, unproven: 0, failed: 0, cancelled: 0, started: 0, answered: 0, waiting: 0, noReply: 0, duplicates: 0, retried: 0, replyMs: [], proveMs: [], errors: {} });
      s.sent++;
      if (m.result === "proven") s.proven++;
      else if (m.result === "sent") s.sentUnchecked++;
      else if (m.result === "unproven") s.unproven++;
      else if (m.result === "failed") { s.failed++; s.errors[m.error] = (s.errors[m.error] || 0) + 1; }
      else if (m.result === "cancelled") s.cancelled++;
      if (m.attempts > 1) s.retried++;
      if (m.startedAt) s.started++;
      // Only an AI-to-AI relay sent twice is the app's fault. The same message
      // sent again by you is your call; a repeated reminder is by design.
      if (m.duplicateOf && m.kind === "relay") { s.duplicates++; anomalies.push({ seq: m.seq, target: m.target, at: m.at, what: `duplicate of #${m.duplicateOf} (same message sent twice)` }); }
      else if (m.duplicateOf && m.kind === "program") s.repeatedByYou = (s.repeatedByYou || 0) + 1;
      if (m.overtakenBy) anomalies.push({ seq: m.seq, target: m.target, at: m.at, what: `the next message (#${m.overtakenBy}) was typed while its reply was still on the page and not captured — that reply may be lost` });
      if (m.provenAt && m.result === "proven") s.proveMs.push(m.provenAt - m.at);
      const st = stageOf(m, at);
      if (st === "answered") { s.answered++; if (!m.batched) s.replyMs.push(m.answeredAt - m.at); }
      else if (st === "waiting" || st === "unproven-waiting" || st === "typing") s.waiting++;
      else if (st === "no-reply" || st === "unproven-no-reply") {
        s.noReply++;
        anomalies.push({ seq: m.seq, target: m.target, at: m.at, what: st === "no-reply" ? `delivered${m.startedAt ? ", the AI started replying" : ""}, but no reply was captured within ${Math.round(noReplyMs / 60000)} min` : "never proven to arrive, and no reply" });
      }
      if (st === "failed") anomalies.push({ seq: m.seq, target: m.target, at: m.at, what: `send failed: ${m.error}${m.attempts ? ` after ${m.attempts} tries` : ""}` });
    }
    for (const s of Object.values(sites)) {
      s.medianReplySec = s.replyMs.length ? Math.round(median(s.replyMs) / 1000) : null;
      s.medianProveSec = s.proveMs.length ? Math.round(median(s.proveMs) / 100) / 10 : null;
      delete s.replyMs; delete s.proveMs;
      // Where most of this AI's messages stopped (the first stage that lost any).
      s.stopsAt = s.failed ? "sending (the message never went out)"
        : s.unproven ? "proving (box cleared but the message never showed in the chat)"
        : s.noReply ? (s.started ? "capturing (the AI replied but the reply wasn't captured)" : "replying (no sign the AI ever answered)")
        : null;
    }
    // What happened to each captured reply.
    const out = { forwarded: 0, toButlerOrTerminal: 0, held: {}, notPassedOn: 0 };
    for (const t of turns.values()) {
      const ai = t.handoffs.filter((h) => h.seq != null).length;
      const other = t.handoffs.length - ai;
      if (ai) out.forwarded++;
      if (other) out.toButlerOrTerminal++;
      if (t.held) out.held[t.held] = (out.held[t.held] || 0) + 1;
      if (!t.handoffs.length && !t.held) out.notPassedOn++;
    }
    anomalies.sort((a, b) => a.at - b.at);
    return { since: startedAt, at, messages: msgs.length, replies: turns.size, sites, replyOutcomes: out, anomalies };
  }

  function reset() { msgs = []; bySeq.clear(); turns.clear(); }
  return { noteSend, noteSendResult, noteGenerating, noteIdle, noteCapture, noteHandoff, noteHeld, answersOf, report, reset, _msgs: () => msgs };
}

const LABEL = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };
const HELD_TEXT = { "to-user": "addressed to you (kept with you)", "hop-limit": "hop limit reached (paused)", "loop-guard": "loop guard (same short reply repeating)", "relay-off": "Stop AIs Talking was on", "nothing-to-add": "AI said NONE (nothing to add)", "rate-limited": "rate-limit / usage-cap notice", "bookforge": "answer to a BookForge request (handed to BookForge)" };

function formatReport(r, { label = (s) => LABEL[s] || s, timeFmt = (t) => new Date(t).toLocaleTimeString() } = {}) {
  const L = [];
  L.push("RELAY TRACE — where every message went");
  L.push(`Covers ${timeFmt(r.since)} to ${timeFmt(r.at)} · ${r.messages} messages sent · ${r.replies} replies captured`);
  L.push("");
  const sites = Object.keys(r.sites);
  if (!sites.length) { L.push("(nothing sent yet)"); return L.join("\n"); }
  L.push("Per AI (messages the app sent TO each AI):");
  for (const s of sites) {
    const x = r.sites[s];
    L.push(`- ${label(s)}: ${x.sent} sent · ${x.proven} proven in the chat${x.sentUnchecked ? ` · ${x.sentUnchecked} sent (not checkable)` : ""}${x.unproven ? ` · ${x.unproven} UNPROVEN` : ""}${x.failed ? ` · ${x.failed} FAILED` : ""}${x.cancelled ? ` · ${x.cancelled} withdrawn before typing` : ""} · ${x.answered} got a reply${x.noReply ? ` · ${x.noReply} NO REPLY` : ""}${x.waiting ? ` · ${x.waiting} still waiting` : ""}`);
    const extra = [];
    if (x.retried) extra.push(`${x.retried} needed a retry`);
    if (x.duplicates) extra.push(`${x.duplicates} DUPLICATE deliveries`);
    if (x.repeatedByYou) extra.push(`${x.repeatedByYou} sent again by you (same text)`);
    if (x.medianProveSec != null) extra.push(`proven in ~${x.medianProveSec}s`);
    if (x.medianReplySec != null) extra.push(`replies in ~${x.medianReplySec}s`);
    const errs = Object.entries(x.errors).map(([k, v]) => `${k}×${v}`).join(", ");
    if (errs) extra.push(`errors: ${errs}`);
    if (extra.length) L.push(`    ${extra.join(" · ")}`);
    L.push(`    ${x.stopsAt ? `→ Messages stop at: ${x.stopsAt}` : "→ No losses found"}`);
  }
  L.push("");
  const o = r.replyOutcomes;
  L.push("What happened to the captured replies:");
  L.push(`- passed on to another AI: ${o.forwarded}`);
  if (o.toButlerOrTerminal) L.push(`- handed to the Butler / terminal: ${o.toButlerOrTerminal}`);
  for (const [k, v] of Object.entries(o.held)) L.push(`- held back — ${HELD_TEXT[k] || k}: ${v}`);
  if (o.notPassedOn) L.push(`- not passed on by the relay (no [TO:] / Auto route for it, or handled by House Rules / Sequence): ${o.notPassedOn}`);
  L.push("");
  L.push(`Problems (${r.anomalies.length}):`);
  if (!r.anomalies.length) L.push("- none");
  for (const a of r.anomalies.slice(-60)) L.push(`- ${timeFmt(a.at)} #${a.seq} → ${label(a.target)}: ${a.what}`);
  if (r.anomalies.length > 60) L.push(`- …and ${r.anomalies.length - 60} earlier ones`);
  return L.join("\n");
}

module.exports = { createRelayTrace, formatReport, hashBody, DEFAULT_NO_REPLY_MS };
