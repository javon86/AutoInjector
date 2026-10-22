// relay-policy.js — who an AI's captured reply is automatically passed on to,
// and when automatic AI-to-AI relaying must stop and wait for the user.
//
// TR-05: an AI that addresses [TO: USER] is talking to the person running the
//        app. The setup prompt promises the AIs exactly that, so Auto routing
//        must NOT forward those replies to the other AIs (doing so caused a
//        14-minute Claude <-> Gemini loop in the 2026-10-21 Extract All).
// TR-06: every automatic hand-off (an AI reply relayed to another AI, the Butler
//        or the terminal) counts as one hop. After maxHops in a row with no
//        user action in between, relaying pauses until the user sends
//        something, clicks Auto again, or uses Stop AIs Talking.

const DEFAULT_MAX_AUTO_HOPS = 30;

// Mesh (Auto routing) targets for one captured reply.
//  site          - who wrote the reply
//  tag           - its [TO: X] tag (upper-case) or null when it had none
//  routing       - iterable of sites Auto routing forwards this site to
//  alreadyCovered- Set of sites the tag relay / House Rule already sent to
//  stageActive   - a House Rules stage owns this turn (its own rules apply)
function meshTargetsFor({ site, tag, routing, alreadyCovered, stageActive }) {
  if (!stageActive && String(tag || "").toUpperCase() === "USER") return [];
  const covered = alreadyCovered || new Set();
  const out = [];
  for (const t of routing || []) {
    if (t === site || covered.has(t) || out.includes(t)) continue;
    out.push(t);
  }
  return out;
}

function createHopCounter({ max } = {}) {
  const clean = (m) => (Number.isFinite(Number(m)) && Number(m) > 0 ? Math.floor(Number(m)) : DEFAULT_MAX_AUTO_HOPS);
  let limit = clean(max);
  let hops = 0;
  let paused = false;
  return {
    // Call once per captured reply that is about to be relayed automatically.
    // -> { allowed, hops, max, justPaused } ; justPaused is true only on the
    // reply that first hits the limit (so the user is told once, not per reply).
    note() {
      if (hops >= limit) {
        const justPaused = !paused;
        paused = true;
        return { allowed: false, hops, max: limit, justPaused };
      }
      hops++;
      return { allowed: true, hops, max: limit, justPaused: false };
    },
    reset() { hops = 0; paused = false; },
    setMax(m) { limit = clean(m); if (hops < limit) paused = false; return limit; },
    status() { return { hops, max: limit, paused }; },
  };
}

module.exports = { meshTargetsFor, createHopCounter, DEFAULT_MAX_AUTO_HOPS };
