// pane-health.js — one honest status per AI pane (TR-07), built only from what
// the program can prove: did the last send land, and did a reply come back?
//
// Levels (shown as the light in each AI column's header):
//   idle     grey   nothing sent yet this run
//   ok       green  the last message was delivered and its reply was captured
//   waiting  amber  delivered, reply not back yet (still inside stallMs)
//   warn     amber  delivered but NOT proven (box cleared, message never seen)
//   stalled  red    delivered, but no reply captured for stallMs — with the
//                   reason read off the page (TR-03 diagnostics)
//   error    red    the last send failed
//
// Pure: main.js feeds it events and a clock; it never touches Electron.

const DEFAULT_STALL_MS = 3 * 60 * 1000;

function createPaneHealth({ sites, now = () => Date.now(), stallMs = DEFAULT_STALL_MS } = {}) {
  const s = {};
  for (const site of sites || []) s[site] = { sentAt: 0, verified: null, sendError: null, capturedAt: 0, read: null, stallLogged: false, probe: null };

  function onSendResult(site, res) {
    const p = s[site]; if (!p) return;
    if (res && res.ok) {
      p.sentAt = now(); p.sendError = null; p.verified = res.verified === true ? true : res.verified === false ? false : null; p.stallLogged = false;
    } else {
      p.sendError = (res && res.error) || "unknown";
    }
  }
  function onCapture(site) { const p = s[site]; if (p) { p.capturedAt = now(); p.stallLogged = false; } }
  // What the read script saw on the last poll: { textLen, generating, hasEndTag, tail }
  function onRead(site, info) { const p = s[site]; if (p) p.read = info || null; }
  // TR-08: result of the read-only page check (automation.buildProbeScript).
  function onProbe(site, probe) { const p = s[site]; if (p) p.probe = probe || null; }

  function stallReason(p) {
    const r = p.read;
    if (!r) return "the page hasn't been read yet";
    if (!r.textLen) return "no reply found on the page — the reply selector matches nothing (use 🎯 to pick the reply text)";
    if (r.generating) return "the page still says it is generating (a Stop button is showing)";
    if (!r.hasEndTag && r.textLen <= 40 && /^\s*\[\s*TO\b/i.test(String(r.tail || ""))) return `the reader only sees the start of the reply ("${String(r.tail || "").trim().slice(0, 40)}") — the page may have split it; use 🎯 to pick the reply text`;
    if (!r.hasEndTag) return "a reply is on the page but it has no closing [FROM:] tag, so it isn't accepted";
    if (r.textLen <= 40) return `the reply selector reads only the last line of the reply ("${String(r.tail || "").trim().slice(0, 40)}") — use 🎯 → Clear Overrides on this pane`;
    return "a tagged reply is on the page but it matches one already captured";
  }

  function evaluate(site) {
    const p = s[site]; if (!p) return null;
    if (p.sendError) return { level: "error", text: `Last send failed: ${p.sendError}` };
    if (!p.sentAt) {
      const pr = p.probe;
      if (pr && pr.ok && !pr.input.found) return { level: "error", text: pr.signedOutHint ? "Signed out? Its message box isn't on the page — open the pane and sign in" : "Can't find its message box on the page — open the pane (and use 🎯 to pick the box if the site changed)" };
      if (p.capturedAt) return { level: "ok", text: "Reply captured" };
      if (pr && pr.ok) return { level: "idle", text: `Page check OK: message box found${pr.send.found ? ", Send button found" : " (Send button not found yet — it may appear once you type)"}. Nothing sent yet.` };
      return { level: "idle", text: "Nothing sent yet" };
    }
    if (p.capturedAt > p.sentAt) return { level: "ok", text: "Working: last message delivered and its reply captured" };
    const age = now() - p.sentAt;
    // A long reply still being written is not a stall (until it runs 4x as long).
    if (age >= stallMs && p.read && p.read.generating && age < stallMs * 4) return { level: "waiting", text: `Still writing its reply (${Math.round(age / 60000)} min)` };
    if (age >= stallMs) {
      const reason = stallReason(p);
      return { level: "stalled", text: `No reply for ${Math.round(age / 60000)} min: ${reason}`, reason, stalledMs: age };
    }
    if (p.verified === false) return { level: "warn", text: "Sent, but not proven: the box cleared and the message never showed in the chat" };
    return { level: "waiting", text: "Delivered, waiting for the reply" };
  }

  // Returns the sites whose stall should be logged now (once per stall).
  function newStalls() {
    const out = [];
    for (const site of Object.keys(s)) {
      const e = evaluate(site);
      if (e && e.level === "stalled" && !s[site].stallLogged) {
        s[site].stallLogged = true;
        out.push({ site, reason: e.reason, minutes: Math.round(e.stalledMs / 60000), read: s[site].read });
      }
    }
    return out;
  }

  function snapshot() { const o = {}; for (const site of Object.keys(s)) o[site] = evaluate(site); return o; }
  return { onSendResult, onCapture, onRead, onProbe, evaluate, newStalls, snapshot };
}

module.exports = { createPaneHealth, DEFAULT_STALL_MS };
