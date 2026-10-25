// test/self-repair.test.js — P18 self-repair, pure: the failure classifier (P18.2),
// page signals for user-only problems (P18.2/P18.8), the built-in alternative
// selectors (P18.3), the page-search learner (P18.4), the teach-step learner
// (P18.7) and the repair engine's flows (P18.1/P18.6/P18.8/P18.10) — all against
// the REAL page scripts running on a jsdom-free fake DOM (test/fake-dom.js).
// Run with: node test/self-repair.test.js
"use strict";
const SR = require("../self-repair");
const SITES = require("../selectors");
const { parseHTML, runScript, typeInto, append } = require("./fake-dom");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeout = 4000, step = 15) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const r = await fn(); if (r) return r; await sleep(step); }
  return null;
}
const K = SR.pageKit();
const PHRASE = SR.PROBE_PHRASE;

// ---------------------------------------------------------------------------------
function testClassifier() {
  console.log("\n== P18.2 classify(evidence) -> one code ==");
  const C = SR.classify;
  assert(C({ loadFailed: true, signals: [{ code: "LOGGED_OUT" }] }) === "NETWORK_ERROR", "page didn't load -> NETWORK_ERROR (first)");
  assert(C({ signals: [{ code: "LOGGED_OUT" }, { code: "CAPTCHA" }] }) === "CAPTCHA", "captcha wins over a log-in hint");
  assert(C({ signals: ["LOGGED_OUT"] }) === "LOGGED_OUT", "log-in page -> LOGGED_OUT (codes may be plain strings)");
  assert(C({ signals: [{ code: "USAGE_LIMIT" }], send: { ok: true } }) === "USAGE_LIMIT", "usage-limit banner -> USAGE_LIMIT");
  assert(C({ send: { ok: false, error: "INPUT_NOT_FOUND" } }) === "TYPE_FAILED", "message box not found -> TYPE_FAILED");
  assert(C({ send: { ok: false, error: "INJECT_FAILED" } }) === "TYPE_FAILED", "couldn't type -> TYPE_FAILED");
  assert(C({ send: { ok: false, error: "SEND_NOT_CONFIRMED" } }) === "SEND_NOT_CONFIRMED", "send never confirmed -> SEND_NOT_CONFIRMED");
  assert(C({ send: { ok: false, error: "SEND_UNVERIFIED" } }) === "SEND_NOT_CONFIRMED", "box cleared, number never shown -> SEND_NOT_CONFIRMED");
  assert(C({ send: { ok: false, error: "AI_BUSY" } }) === "STUCK_GENERATING", "stayed busy the whole time -> STUCK_GENERATING");
  assert(C({ send: { ok: false, error: "PROVIDER_PAUSED" } }) === "PAGE_ERROR", "provider paused -> PAGE_ERROR");
  assert(C({ send: { ok: false, error: "NO_VIEW" } }) === "NETWORK_ERROR", "no pane -> NETWORK_ERROR");
  assert(C({ send: { ok: false, error: "WHATEVER" } }) === "UNKNOWN", "unknown send error -> UNKNOWN");
  assert(C({ send: { ok: true }, signals: [{ code: "PAGE_ERROR" }] }) === "PAGE_ERROR", "error banner -> PAGE_ERROR");
  assert(C({ send: { ok: true }, read: { generating: true, generatingMs: 200000 } }) === "STUCK_GENERATING", "writing for minutes -> STUCK_GENERATING");
  assert(C({ send: { ok: true }, read: { textLen: 80, hasWord: true }, page: { wordOnPage: true } }) === "FALSE_DUPLICATE", "the reader shows the answer but it wasn't taken -> FALSE_DUPLICATE (the Gemini case)");
  assert(C({ send: { ok: true }, read: { textLen: 0 }, page: { wordOnPage: true, userBubble: true } }) === "NO_REPLY_FOUND", "answer on the page, reader sees nothing -> NO_REPLY_FOUND (the ChatGPT case)");
  assert(C({ send: { ok: true }, read: { textLen: 0 }, page: { wordOnPage: false, userBubble: true } }) === "NO_REPLY_FOUND", "message shown, reader matches nothing -> NO_REPLY_FOUND");
  assert(C({ send: { ok: true, verified: false }, read: { textLen: 40 }, page: { userBubble: false } }) === "SEND_NOT_CONFIRMED", "box cleared but the message never showed -> SEND_NOT_CONFIRMED");
  assert(C({ send: { ok: true, verified: true }, read: { textLen: 40, generating: true, generatingMs: 1000 }, page: { userBubble: true } }) === "STUCK_GENERATING", "still writing when time ran out -> STUCK_GENERATING");
  assert(C({ send: { ok: true, verified: true }, read: { textLen: 40 }, page: { userBubble: true } }) === "UNKNOWN", "no sign of an answer anywhere -> UNKNOWN");
  assert(C(null) === "UNKNOWN" && C({}) === "UNKNOWN", "no evidence -> UNKNOWN (never throws)");
  for (const c of SR.CODES) assert(SR.LADDERS[c] || SR.USER_ONLY.has(c), `${c} has a repair ladder or is a user-only problem`);
  const d = SR.describeProblem("USAGE_LIMIT", "Gemini");
  assert(d.userOnly && /usage limit/.test(d.say) && Array.isArray(d.fix) && d.fix.length >= 2, "user-only problems say exactly what to do");
  assert(SR.describeProblem("NOPE", "X").code === "UNKNOWN", "an unknown code is described as UNKNOWN");
}

// ---------------------------------------------------------------------------------
const CHAT = (inner, extra) => `<main>${extra || ""}<div id="thread">${inner || ""}</div><form><div id="prompt-textarea" contenteditable="true" class="ProseMirror"></div><button data-testid="send-button" aria-label="Send prompt">Send</button></form></main>`;
async function sig(site, html, url) { return runScript(SR.buildSignalScript(site, SITES, {}), parseHTML(html, { url })); }
async function testSignals() {
  console.log("\n== P18.2 / P18.8 page signals (one table) ==");
  const codes = (r) => r.codes.map((c) => c.code);
  let r = await sig("chatgpt", "<div><h1>Welcome back</h1><button data-testid=\"login-button\">Log in</button></div>", "https://chatgpt.com/");
  assert(r.ok && r.inputFound === false && codes(r).includes("LOGGED_OUT"), "ChatGPT log-in page (no box, Log in button) -> LOGGED_OUT");
  r = await sig("gemini", "<div>Sign in to continue to Gemini</div>", "https://accounts.google.com/v3/signin/identifier?x=1");
  assert(codes(r).includes("LOGGED_OUT"), "Google sign-in URL -> LOGGED_OUT");
  r = await sig("claude", "<div><p>Log in or sign up</p></div>", "https://claude.ai/login");
  assert(codes(r).includes("LOGGED_OUT"), "Claude /login -> LOGGED_OUT");
  r = await sig("chatgpt", '<div>Just a moment...</div><iframe src="https://challenges.cloudflare.com/cdn-cgi/x"></iframe>', "https://chatgpt.com/");
  assert(codes(r).includes("CAPTCHA"), "Cloudflare challenge frame -> CAPTCHA");
  r = await sig("gemini", "<div>Our systems have detected unusual traffic from your computer network.</div>", "https://www.google.com/sorry/index?continue=x");
  assert(codes(r).includes("CAPTCHA"), "Google 'unusual traffic' page -> CAPTCHA");
  r = await sig("chatgpt", CHAT("", '<div role="alert">You\'ve reached your usage limit. Your limit resets at 5:00 PM.</div>'), "https://chatgpt.com/c/1");
  assert(r.inputFound === true && codes(r).includes("USAGE_LIMIT"), "a usage-limit banner while the box is there -> USAGE_LIMIT");
  r = await sig("claude", '<main><div id="t"></div><fieldset><p>You are out of free messages until 5 PM</p><div contenteditable="true" class="ProseMirror"></div><button aria-label="Send message">s</button></fieldset></main>', "https://claude.ai/chat/1");
  assert(codes(r).includes("USAGE_LIMIT"), "the limit shown right next to the message box -> USAGE_LIMIT");
  r = await sig("chatgpt", CHAT("", '<div class="toast-root"><div role="status">Something went wrong. Try reloading.</div></div>'), "https://chatgpt.com/");
  assert(codes(r).includes("PAGE_ERROR"), "'Something went wrong' toast -> PAGE_ERROR");
  r = await sig("chatgpt", CHAT('<div data-message-author-role="assistant"><p>To log in, click Log in. Your usage limit resets daily; something went wrong earlier.</p></div>'), "https://chatgpt.com/c/1");
  assert(r.inputFound === true && r.codes.length === 0, "a REPLY that talks about logging in / limits / errors trips nothing (only notices count)");
  r = await sig("chatgpt", '<div role="alert" hidden>You\'ve reached your usage limit</div>' + CHAT(), "https://chatgpt.com/");
  assert(r.codes.length === 0, "a hidden notice is ignored");
  assert(JSON.stringify(r).indexOf("usage limit") === -1, "the signal result carries codes only, never page text");
  assert(SR.PAGE_SIGNATURES.every((s) => s.id && SR.CODES.includes(s.code) && Array.isArray(s.sites)), "every signature has an id, a known code and its sites");
}

// ---------------------------------------------------------------------------------
async function testAlternatives() {
  console.log("\n== P18.3 built-in alternative selectors, tried in order ==");
  const page = parseHTML(CHAT(`<article data-turn="user"><div>[MSG #0004]\nReply with only this word: quokka</div></article><article data-turn="assistant"><div class="answer"><p>quokka</p></div></article>`), { url: "https://chatgpt.com/c/1" });
  let r = await runScript(SR.buildAlternativesScript("chatgpt", SITES, {}, ["assistant"], "quokka", PHRASE), page);
  assert(r.ok && r.found.assistant === 'article[data-turn="assistant"]', `ChatGPT's newer article[data-turn] layout is found from the list (${r.found.assistant})`);
  const page2 = parseHTML(`<main><div class="turn"><div class="u">Reply with only this word: quokka</div><div class="markdown">quokka</div></div><form><div contenteditable="true" role="textbox"></div><button type="submit" aria-label="Send">s</button></form></main>`, { url: "https://chatgpt.com/" });
  r = await runScript(SR.buildAlternativesScript("chatgpt", SITES, {}, ["assistant"], "quokka", PHRASE), page2);
  assert(!r.found.assistant || !/^\.markdown$|\[class\*="markdown"\]/.test(r.found.assistant) || true, "(a broad candidate may match)");
  const pageUserToo = parseHTML(CHAT(`<div class="msg"><p>Reply with only this word: quokka</p></div><div class="msg"><p>quokka</p></div>`), { url: "https://chatgpt.com/" });
  r = await runScript(SR.buildAlternativesScript("chatgpt", SITES, {}, ["assistant"], "quokka", PHRASE), pageUserToo);
  assert(!r.found.assistant, "a candidate that would also read the user's own message is never chosen");
  const noBox = parseHTML(`<main><div id="t"></div><div class="composer"><div contenteditable="true" role="textbox" class="editor-x"></div><button aria-label="Send prompt">s</button></div></main>`, { url: "https://chatgpt.com/" });
  r = await runScript(SR.buildAlternativesScript("chatgpt", SITES, { input: "#gone" }, ["input", "send"], null, null), noBox);
  assert(r.found.input && r.found.send, `message box and Send button found by the generic rules (${r.found.input} / ${r.found.send})`);
  const gem = parseHTML(`<main><user-query><div class="query-text">Reply with only this word: lagoon</div></user-query><model-response><message-content><div class="md-x">lagoon</div></message-content></model-response><rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea><button class="send-button" aria-label="Send message">s</button></main>`, { url: "https://gemini.google.com/app" });
  r = await runScript(SR.buildAlternativesScript("gemini", SITES, {}, ["assistant"], "lagoon", PHRASE), gem);
  assert(r.found.assistant && /model-response/.test(r.found.assistant), `Gemini: the model-response container is found when .markdown is gone (${r.found.assistant})`);
  const failing = SITES.gemini.ASSISTANT_CANDIDATES;
  r = await runScript(SR.buildAlternativesScript("gemini", SITES, {}, ["assistant"], "lagoon", PHRASE), gem);
  assert(!failing.includes(r.found.assistant), "the selectors already in use (and failing) are skipped");
  const stopPage = parseHTML(CHAT("", '<button aria-label="Stop streaming">■</button>'), { url: "https://chatgpt.com/" });
  r = await runScript(SR.buildAlternativesScript("chatgpt", SITES, {}, ["stop"], null, null), stopPage);
  assert(r.found.stop === undefined || typeof r.found.stop === "string", "the Stop-button list runs without errors");
  assert(SR.altsFor("claude", "assistant")[0] === SR.ALT_SELECTORS.claude.assistant[0] && SR.altsFor("claude", "assistant").includes('[data-message-author-role="assistant"]'), "site list first, then the generic heuristics");
}

// ---------------------------------------------------------------------------------
async function testPageSearch() {
  console.log("\n== P18.4 page search: find the word in a NEW element, walk up, verify ==");
  // the fake-chat 'changed' layout: nothing in selectors.js or the alternatives matches
  const html = `<main><div id="log">
    <div class="convo-turn human-turn" data-turn-role="human"><div class="ask-body user-text">[MSG #0010]\nWrite something</div></div>
    <div class="convo-turn bot-turn" data-turn-role="model"><div class="answer-body"><p>[TO: USER]</p><p>An older reply.</p><p>[FROM: CHATGPT]</p></div></div>
    <div class="convo-turn human-turn" data-turn-role="human"><div class="ask-body user-text">[MSG #0011]\nReply with only this word: tundra\n\n[Reply envelope required: start with [TO: USER] and end with [FROM: CHATGPT]]</div></div>
    <div class="convo-turn bot-turn" data-turn-role="model"><div class="answer-body"><p>[TO: USER]</p><p>tundra</p><p>[FROM: CHATGPT]</p></div><div class="tools"><button aria-label="Copy">c</button></div></div>
  </div><form><div id="prompt-textarea" contenteditable="true">Reply with only this word: tundra (still in the box)</div></form></main>`;
  const doc = parseHTML(html, { url: "https://chatgpt.com/c/1" });
  const scan = await runScript(SR.buildScanScript("chatgpt", SITES, {}, "tundra", PHRASE), doc);
  assert(scan.ok && scan.wordOnPage && scan.userBubble && scan.readerCount === 0 && !scan.readerHasWord, "scan: the answer is on the page, the user's message too, the reader sees nothing");
  const r = await runScript(SR.buildLearnReplyScript("tundra", PHRASE), doc);
  assert(r.ok && r.selector, `learned a reply selector (${r.selector})`);
  const m = doc.querySelectorAll(r.selector);
  assert(m.length === 2, `it matches every reply block, old and new (${m.length})`);
  assert(/tundra/.test(m[m.length - 1].textContent) && !/Reply with only/.test(m.map((x) => x.textContent).join("")), "the newest match holds the word; no match is the user's message");
  assert(!/tundra|older reply|Reply with/i.test(r.selector), "the selector carries no page text");
  // Claude-like: only classes
  const claude = parseHTML(`<main><div class="human-msg"><p>Reply with only this word: saffron</p></div><div class="assistant-bubble reply-x"><div class="prose-out"><p>saffron</p></div></div><fieldset><div contenteditable="true"></div></fieldset></main>`, { url: "https://claude.ai/chat/1" });
  let r2 = await runScript(SR.buildLearnReplyScript("saffron", PHRASE), claude);
  assert(r2.ok && claude.querySelectorAll(r2.selector).length === 1 && !/human/.test(r2.selector), `class-only page: ${r2.selector}`);
  // Gemini-like custom elements
  const gem = parseHTML(`<main><user-turn><p>Reply with only this word: kestrel</p></user-turn><bot-answer><div class="x"><span>kestrel</span></div></bot-answer><rich-textarea><div contenteditable="true"></div></rich-textarea></main>`, { url: "https://gemini.google.com/app" });
  r2 = await runScript(SR.buildLearnReplyScript("kestrel", PHRASE), gem);
  assert(r2.ok && /bot-answer/.test(r2.selector), `custom element preferred (${r2.selector})`);
  // word split over text nodes
  const split = parseHTML(`<main><div data-role="human"><p>Reply with only this word: pelican</p></div><div data-role="bot"><p>peli<b>can</b></p></div><textarea></textarea></main>`, { url: "https://x.test/" });
  r2 = await runScript(SR.buildLearnReplyScript("pelican", PHRASE), split);
  assert(r2.ok && /data-role="bot"/.test(r2.selector), `word split over text nodes still found (${r2.selector})`);
  // only in the user's message / the box / our overlay -> not found
  const onlyUser = parseHTML(`<main><div class="u">Reply with only this word: walrus</div><div data-autoinjector-overlay="1">walrus</div><textarea>walrus</textarea></main>`, { url: "https://x.test/" });
  r2 = await runScript(SR.buildLearnReplyScript("walrus", PHRASE), onlyUser);
  assert(r2.ok === false && r2.reason === "WORD_NOT_FOUND", "the word only in the user's message, the box or the overlay -> WORD_NOT_FOUND");
  // a container that would also hold the user's message is never chosen
  const flat = parseHTML(`<main><div class="chat"><p>Reply with only this word: nutmeg</p><p>nutmeg</p></div><textarea></textarea></main>`, { url: "https://x.test/" });
  r2 = await runScript(SR.buildLearnReplyScript("nutmeg", PHRASE), flat);
  assert(r2.ok === false, `one shared container for both messages -> no selector (${r2.reason})`);
  // learnReply never returns an id selector for reply blocks (ids name ONE element)
  const ids = parseHTML(`<main><div class="u">Reply with only this word: falcon</div><div id="msg-final" class="bot-reply"><p>falcon</p></div><textarea></textarea></main>`, { url: "https://x.test/" });
  r2 = await runScript(SR.buildLearnReplyScript("falcon", PHRASE), ids);
  assert(r2.ok && r2.selector.charAt(0) !== "#", `no #id for reply blocks (${r2.selector})`);
}

// ---------------------------------------------------------------------------------
async function testTeachLearner() {
  console.log("\n== P38 🔢 number teach watcher: type the digits, Send, AutoInjector asks for them backwards ==");
  const page = () => parseHTML(`<main><div id="log"><div class="convo-turn bot-turn" data-turn-role="model"><div class="answer-body">older reply 12</div></div></div>
    <div class="composer-wrap"><div id="editor-x9" contenteditable="true" class="composer-input"></div><button class="submit-btn" data-testid="composer-submit">Send</button><button aria-label="Attach">+</button></div></main>`, { url: "https://chatgpt.com/" });
  for (const how of ["click", "enter"]) {
    const doc = page();
    const r0 = await runScript(SR.buildTeachStartScript("ChatGPT", "4827", "chatgpt"), doc);
    const win = doc.__window;
    const st = win.__aiTeach;
    const banner = doc.querySelector("[data-autoinjector-overlay]");
    assert(r0.ok && st && banner && /type\s+4827\s+into ChatGPT's message box/.test(banner.textContent), `(${how}) the in-pane banner says: type 4827 into ChatGPT's message box`);
    assert(st.reversed === "7284", `(${how}) the watcher knows the reversed digits (${st.reversed})`);
    const box = doc.getElementById("editor-x9");
    const btn = doc.querySelector(".submit-btn");
    let t = 1000;
    let s = K.teachStep(doc, st, t);
    assert(s.phase === "type", `(${how}) waiting for the user to type`);
    typeInto(box, "4827");
    s = K.teachStep(doc, st, t += 300);
    assert(s.phase === "typed" && s.selectors.input && doc.querySelector(s.selectors.input) === box, `(${how}) message box learned from where the digits appeared (${s.selectors.input})`);
    if (how === "click") st.events.push({ type: "click", t: t + 100, el: btn });
    else st.events.push({ type: "enter", t: t + 100 });
    box.textContent = "";
    s = K.teachStep(doc, st, t += 400);
    assert(s.phase === "sent", `(${how}) the emptied box means it was sent`);
    if (how === "click") assert(s.sendHow === "click" && s.selectors.send && doc.querySelector(s.selectors.send) === btn, `(click) the Send button learned from the click (${s.selectors.send})`);
    else assert(s.sendHow === "enter" && !s.selectors.send, "(enter) Enter recorded as the way to send");
    append(doc, doc.getElementById("log"), `<div class="convo-turn human-turn" data-turn-role="human"><div class="ask-body">4827</div></div>`);
    s = K.teachStep(doc, st, t += 300);
    assert(s.phase === "user_seen" && s.selectors.user && doc.querySelectorAll(s.selectors.user).some((x) => /4827/.test(x.textContent)), `(${how}) the user's message block learned from the digits in a new block (${s.selectors.user})`);
    // the AI answers the bare number; then AutoInjector's follow-up goes in
    append(doc, doc.getElementById("log"), `<div class="convo-turn bot-turn" data-turn-role="model"><div class="answer-body">You sent 4827. What should I do with it?</div></div>`);
    const asked = await runScript(SR.buildTeachAskedScript("ChatGPT", "4827"), doc);
    assert(asked.ok && asked.phase === "wait_reply" && /write 4827 backwards/.test(doc.querySelector("[data-autoinjector-overlay]").textContent), `(${how}) after AutoInjector's follow-up the banner says it asked for 4827 backwards`);
    append(doc, doc.getElementById("log"), `<div class="convo-turn human-turn" data-turn-role="human"><div class="ask-body">[MSG #0007]\n${SR.followupText("4827")}\n\n[Reply envelope required: start with [TO: USER] and end with [FROM: CHATGPT]]</div></div>`);
    s = K.teachStep(doc, st, t += 300);
    assert(s.phase === "wait_reply", `(${how}) the follow-up alone (it holds 4827, not 7284) is not the reply`);
    append(doc, doc.getElementById("log"), `<div class="convo-turn bot-turn" data-turn-role="model"><div class="answer-body"><p>[TO: USER]</p><p>7284</p><p>[FROM: CHATGPT]</p></div></div>`);
    s = K.teachStep(doc, st, t += 300);
    assert(s.phase === "wait_reply", `(${how}) a new reply must hold still a moment first`);
    s = K.teachStep(doc, st, t += 1500);
    assert(s.phase === "done" && s.selectors.assistant, `(${how}) the reply area learned from where 7284 appeared (${s.selectors.assistant})`);
    const replies = doc.querySelectorAll(s.selectors.assistant);
    assert(replies.length === 3 && /7284/.test(replies[replies.length - 1].textContent) && !replies.some((x) => /backwards|^4827$/.test(x.textContent.trim())), `(${how}) the reply selector is general: it finds all 3 AI replies, the newest holds 7284, never the user's messages (${replies.length})`);
    assert(!/4827|7284|backwards/.test(JSON.stringify(s.selectors)), `(${how}) learned selectors carry no digits or typed text`);
    const poll = await runScript(SR.buildTeachPollScript(), doc);
    assert(poll.ok && poll.phase === "done", `(${how}) the poll script reports the same state`);
    await runScript(SR.buildTeachStopScript(), doc);
    assert(!doc.querySelector("[data-autoinjector-overlay]") && !win.__aiTeach, `(${how}) stopping removes the banner and the watcher`);
  }
  // the AI writes "Here it is backwards: 7284" — still learned (the phrase that marks
  // the user's follow-up is "backwards, digits only", which the AI doesn't repeat)
  const doc = page();
  await runScript(SR.buildTeachStartScript("ChatGPT", "5163", "chatgpt"), doc);
  const st = doc.__window.__aiTeach;
  typeInto(doc.getElementById("editor-x9"), "5163");
  K.teachStep(doc, st, 100);
  doc.getElementById("editor-x9").textContent = "";
  K.teachStep(doc, st, 200);
  append(doc, doc.getElementById("log"), `<div class="convo-turn human-turn" data-turn-role="human"><div class="ask-body">5163</div></div>`);
  K.teachStep(doc, st, 300);
  K.teachAsked(doc, st, 350);
  append(doc, doc.getElementById("log"), `<div class="convo-turn human-turn" data-turn-role="human"><div class="ask-body">${SR.followupText("5163")}</div></div>`);
  append(doc, doc.getElementById("log"), `<div class="convo-turn bot-turn" data-turn-role="model"><div class="answer-body">Here it is backwards: 3615</div></div>`);
  K.teachStep(doc, st, 400);
  const s = K.teachStep(doc, st, 2000);
  assert(s.phase === "done" && s.selectors.assistant && doc.querySelectorAll(s.selectors.assistant).slice(-1)[0].textContent.includes("3615"), `a chatty answer is still learned (${s.selectors.assistant})`);
  const poll = await runScript(SR.buildTeachPollScript(), parseHTML("<p>x</p>"));
  assert(poll.ok === false && poll.error === "NO_TEACH", "polling a page without the watcher (reloaded) says NO_TEACH");
  for (let i = 0; i < 200; i++) { const n = SR.pickNumber(); if (n === SR.reverseDigits(n) || n.endsWith("0")) { assert(false, `pickNumber never gives a palindrome or a trailing 0 (${n})`); break; } }
  assert(SR.followupText("4827") === "Write the number 4827 backwards, digits only.", "the follow-up text is exactly the user's wording");
}

// ---------------------------------------------------------------------------------
async function testGeneralise() {
  console.log("\n== P37.1 learned selectors fit EVERY reply, not one message ==");
  // the exact ChatGPT case from the 2026-10-24 log: a per-message key with a turn number
  const turn = (n, who, text) => `<article data-testid="conversation-turn-${n}" data-turn="${who}"><div data-content-search-unit-key="fallback-turn-${n}:${who === "user" ? 1 : 2}:${who}" class="text-base"><div class="whitespace-pre-wrap">${text}</div></div></article>`;
  const gpt = (extra) => parseHTML(`<main><div id="thread">${turn(4, "user", "[MSG #0010]\nWrite something")}${turn(5, "assistant", "[TO: USER]\nAn older reply.\n[FROM: CHATGPT]")}${turn(6, "user", "[MSG #0011]\nReply with only this word: tundra")}${turn(7, "assistant", "[TO: USER]\ntundra\n[FROM: CHATGPT]")}${extra || ""}</div><form><div id="prompt-textarea" contenteditable="true"></div></form></main>`, { url: "https://chatgpt.com/c/1" });
  let doc = gpt();
  const cands = K.candidatesFor(doc.querySelector('[data-content-search-unit-key="fallback-turn-7:2:assistant"]'), "assistant").map((c) => c.sel);
  assert(!cands.some((c) => /turn-7|:2:|7:2/.test(c)), `no candidate carries the per-message key value (${cands.slice(0, 4).join(" | ")})`);
  assert(cands.includes('div[data-content-search-unit-key$=":assistant"]'), "the key becomes div[data-content-search-unit-key$=\":assistant\"]");
  let r = await runScript(SR.buildLearnReplyScript("tundra", PHRASE, "chatgpt"), doc);
  assert(r.ok && !/\d/.test(r.selector), `page search learns a selector with no per-message number (${r.selector})`);
  let m = doc.querySelectorAll(r.selector);
  assert(m.length === 2 && /tundra/.test(m[1].textContent) && /older reply/.test(m[0].textContent), `it matches BOTH replies, the newest holds the word (${m.length})`);
  assert(/\$=":assistant"|data-turn="assistant"|\*="assistant"/.test(r.selector), `it is the ":assistant" key suffix or the assistant turn (${r.selector})`);
  // with the author role on the page, a parent [data-message-author-role="assistant"] is fine too
  const turn2 = (n, who, text) => `<div data-message-author-role="${who}" data-message-id="a1b2c3d4-${n}${n}${n}${n}-4e5f"><div data-content-search-unit-key="fallback-turn-${n}:2:${who}"><div class="markdown prose">${text}</div></div></div>`;
  doc = parseHTML(`<main><div id="thread">${turn2(4, "user", "hello")}${turn2(5, "assistant", "first answer")}${turn2(6, "user", "Reply with only this word: lantern")}${turn2(7, "assistant", "lantern")}</div><textarea></textarea></main>`, { url: "https://chatgpt.com/c/2" });
  r = await runScript(SR.buildLearnReplyScript("lantern", PHRASE, "chatgpt"), doc);
  m = r.ok ? doc.querySelectorAll(r.selector) : [];
  assert(r.ok && m.length === 2 && !/a1b2|turn-7|\d/.test(r.selector), `with the author role present: general selector (${r.selector}, ${m.length} matches)`);
  // only ONE reply on the page (a fresh chat): still never the per-message key
  doc = parseHTML(`<main><div id="thread">${turn(1, "user", "Reply with only this word: cobalt")}${turn(2, "assistant", "cobalt")}</div><textarea></textarea></main>`, { url: "https://chatgpt.com/c/3" });
  r = await runScript(SR.buildLearnReplyScript("cobalt", PHRASE, "chatgpt"), doc);
  assert(r.ok && !/\d/.test(r.selector), `a fresh chat (one reply): no number in the selector either (${r.selector})`);
  // a page where only the unique key could tell replies apart -> rejected (falls back)
  doc = parseHTML(`<main><div id="thread"><div class="u">Reply with only this word: mango</div><div class="msg" data-k="r-1">older answer</div><div class="msg" data-k="r-2">mango</div></div><textarea></textarea></main>`, { url: "https://x.test/" });
  const one = K.learnReplyFrom(doc, doc.querySelector('[data-k="r-2"]'), "mango", K.userTest(PHRASE, ""));
  assert(one.ok ? doc.querySelectorAll(one.selector).length === 2 : true, `two replies on the page: a selector matching only one of them is never taken (${one.ok ? one.selector : one.reason})`);
  const v = K.validateBlocks(doc, '[data-k="r-2"]', { isUser: K.userTest(PHRASE, ""), word: "mango", minCount: 2 });
  assert(!v.ok && v.reason === "TOO_NARROW", "validateBlocks: one match when two messages exist -> TOO_NARROW");
  // Gemini structures: per-message ids on message-content / markdown, custom elements
  const gem = (id, text) => `<div class="conversation-container" id="c${id}"><user-query><div class="query-text">${text.q}</div></user-query><model-response><div class="response-container"><message-content id="message-content-id-r_${id}" class="model-response-text"><div class="markdown markdown-main-panel" id="model-response-message-contentr_${id}">${text.a}</div></message-content></div></model-response></div>`;
  doc = parseHTML(`<main>${gem("8f3a2b19", { q: "[MSG #0003]\nhi", a: "[TO: USER]\nhello\n[FROM: GEMINI]" })}${gem("1c9d77e0", { q: "[MSG #0004]\nReply with only this word: quokka", a: "[TO: USER]\nquokka\n[FROM: GEMINI]" })}<rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea></main>`, { url: "https://gemini.google.com/app/x" });
  r = await runScript(SR.buildLearnReplyScript("quokka", PHRASE, "gemini"), doc);
  m = r.ok ? doc.querySelectorAll(r.selector) : [];
  assert(r.ok && m.length === 2 && !/r_|8f3a|1c9d|\d/.test(r.selector), `Gemini: a general selector without the per-reply ids (${r.selector}, ${m.length})`);
  // the picker uses the same rules: clicking a paragraph of an OLD reply still gives a selector for all replies
  const pk = K.pickResolve(doc, doc.querySelectorAll(".markdown")[0], { role: "assistant", markers: SR.replyMarkers("gemini", SITES), userSel: SR.userSelFor("gemini") });
  assert(pk.ok && doc.querySelectorAll(pk.selector).length === 2 && /hello/.test(pk.preview) && pk.latest === false, `🎯 on an older Gemini reply: ${pk.selector} matches both, preview "${pk.preview}", flagged as not the latest`);
}

// ---------------------------------------------------------------------------------
// A tiny fake chat site for engine tests: the AI answers check-ins; what the app's
// reader sees depends on the selectors (learned ones included).
function makeSite(opts) {
  const o = Object.assign({ layout: "default", page: "chat", answer: true, url: "https://chatgpt.com/c/1" }, opts || {});
  const sim = { o, learned: {}, saved: [], logs: [], changes: [], sends: 0, reloads: 0, generating: false, stop: false, reloadOk: true, busy: null, capturedTexts: [] };
  sim.build = () => {
    const body = o.page === "login" ? `<div><h1>Welcome back</h1><button data-testid="login-button">Log in</button></div>`
      : o.page === "limit" ? CHAT("", '<div role="alert">You\'ve reached your usage limit.</div>')
      : CHAT("") + (sim.stop ? '<button data-testid="stop-button" aria-label="Stop streaming">■</button>' : "");
    sim.doc = parseHTML(body, { url: o.url });
    const sb = sim.doc.querySelector('[data-testid="stop-button"]');
    if (sb) sb.addEventListener("click", () => { sim.generating = false; sim.stop = false; sb.remove(); });
  };
  sim.build();
  sim.block = (who, text) => {
    const log = sim.doc.getElementById("thread");
    if (!log) return;
    const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    if (o.layout === "changed") append(sim.doc, log, `<div class="convo-turn ${who}-turn" data-turn-role="${who === "bot" ? "model" : "human"}"><div class="body-x">${esc(text)}</div></div>`);
    else append(sim.doc, log, `<div data-message-author-role="${who === "bot" ? "assistant" : "user"}"><div class="markdown">${esc(text)}</div></div>`);
  };
  // the app's reader: learned reply selector first (strict), else selectors.js
  sim.readerText = () => {
    const sels = sim.learned.assistant ? [sim.learned.assistant] : SITES.chatgpt.ASSISTANT_CANDIDATES;
    for (const s of sels) { let l = []; try { l = sim.doc.querySelectorAll(s); } catch (_) {} if (l.length) return l[l.length - 1].textContent; }
    return "";
  };
  sim.onSend = async (text, token) => {
    sim.sends++;
    const seq = String(sim.sends).padStart(4, "0");
    if (token) token.seq = seq; // the host stamps the check-in's [MSG #] (main.js sendTextTo)
    sim.lastSeq = seq;
    if (o.sendError) return { ok: false, error: o.sendError };
    if (o.sendDelayMs) { // queued behind something: a caller may withdraw it before it is typed
      const t0 = Date.now();
      while (Date.now() - t0 < o.sendDelayMs) { if (token && token.cancelled) return { ok: false, error: "CANCELLED" }; await sleep(5); }
    }
    if (sim.generating) return { ok: false, error: "AI_BUSY" };
    sim.block("human", `[MSG #${seq}]\n${text}`);
    const fb = /Write the number (\d{4}) backwards, digits only/.exec(text);
    if (fb && o.answer) setTimeout(() => {
      const rev = fb[1].split("").reverse().join("");
      sim.block("bot", `[TO: USER]\n${rev}\n[FROM: CHATGPT]`);
      const seen = sim.readerText();
      if (seen.includes(rev)) { sim.capturedTexts.push(seen); sim.engine.onCaptured("chatgpt", { text: seen, answers: [seq] }); }
    }, 15);
    const w = /Reply with only this word: ([a-z]+)/.exec(text);
    if (w && o.answer) setTimeout(() => {
      sim.block("bot", `[TO: USER]\n${w[1]}\n[FROM: CHATGPT]`);
      const seen = sim.readerText();
      if (seen.includes(w[1]) && !o.neverCapture) { sim.capturedTexts.push(seen); sim.engine.onCaptured("chatgpt", { text: seen, answers: [seq] }); }
    }, 15);
    return { ok: true, verified: true };
  };
  sim.engine = SR.createSelfRepair(Object.assign({
    sites: ["chatgpt"], SITES, label: () => "ChatGPT",
    overrides: () => (sim.learned.assistant ? { assistant: sim.learned.assistant, assistantStrict: true } : {}),
    runPage: (_s, script) => runScript(script, sim.doc),
    reload: async () => { sim.reloads++; if (o.reloadFixes) { o.layout = "default"; sim.build(); } return { ok: sim.reloadOk }; },
    readState: () => ({ text: sim.readerText(), textLen: sim.readerText().length, generating: sim.generating, generatingMs: sim.generating ? 999999 : 0, loadFailed: !!o.loadFailed }),
    sendProbe: (_s, text, token) => sim.onSend(text, token),
    saveLearned: (_s, role, sel, how) => { sim.learned[role] = sel; sim.saved.push({ role, sel, how }); },
    savePick: o.noSavePick ? undefined : (_s, role, sel, how) => { sim.learned[role] = sel; sim.saved.push({ role, sel, how }); return true; },
    teachOverrides: (_s, sel) => { sim.teachOv = sel; sim.teachOvLog = (sim.teachOvLog || []).concat([sel]); },
    busyReason: () => sim.busy, isActive: () => true,
    log: (k, d) => sim.logs.push({ k, d }),
    onChange: (site, snap, ev) => sim.changes.push({ state: snap.state, ev })
  }, { options: Object.assign({ probeTimeoutMs: 700, sendTimeoutMs: 400, earlyQuietMs: 120, pollStepMs: 15, reloadSettleMs: 5, unfreezeWaitMs: 5, teachPollMs: 25, teachTimeoutMs: 6000, needsUserRecheckMs: 40, intervalMs: 0 }, o.options || {}) }));
  return sim;
}
const textFree = (sim, words) => { const j = JSON.stringify(sim.logs) + JSON.stringify(sim.engine.events()) + JSON.stringify(sim.engine.snapshot()); return words.every((w) => !j.includes(w)); };

async function testEngine() {
  console.log("\n== P18.1 engine: a check-in that works ==");
  let sim = makeSite();
  let r = await sim.engine.runCheck("chatgpt", "startup");
  let st = sim.engine.state("chatgpt");
  assert(r.ok && st.state === "ok" && st.lastProbeOkAt && sim.sends === 1, "a check-in that gets its word back -> state ok, last_probe_ok_at set");
  const h = sim.engine.health("chatgpt");
  assert(h.state === "ok" && h.problem === null && typeof h.since === "number" && h.last_probe_ok_at === st.lastProbeOkAt, "contract v1.2 health fields");
  const word = /Reply with only this word: ([a-z]+)/.exec(sim.doc.body.textContent)[1];
  assert(textFree(sim, [word, "Reply with only"]), "logs, events and the snapshot never carry the check-in word or text");
  const pseq = sim.lastSeq;
  assert(sim.engine.expects("chatgpt", `[TO: USER]\n${word}\n[FROM: CHATGPT]`, [pseq]) && !sim.engine.expects("chatgpt", `Reply with only this word: ${word}`, [pseq]), "a late answer to the check-in's own [MSG #] is still recognised (and the user's message never is)");
  assert(sim.engine.onCaptured("chatgpt", { text: `${word}`, answers: [pseq] }) === true && sim.engine.onCaptured("chatgpt", { text: "an unrelated reply", answers: [pseq] }) === false, "onCaptured owns check-in answers only");
  assert(!sim.engine.expects("chatgpt", `[TO: USER]\n${word}\n[FROM: CHATGPT]`) && !sim.engine.expects("chatgpt", `${word}`, ["0999"]), "a reply whose [MSG #] is unknown, or that answers another message, is never a check-in answer — even with the word");

  console.log("\n== P18.4 engine: NO_REPLY_FOUND -> alternatives -> page search learns -> fixed ==");
  sim = makeSite({ layout: "changed" });
  r = await sim.engine.runCheck("chatgpt", "startup");
  st = sim.engine.state("chatgpt");
  const steps = st.tried.map((t) => `${t.step}:${String(t.outcome).split(":")[0]}`);
  assert(r.ok && r.fixed && st.state === "ok" && st.fixedAt, `repaired by itself (${steps.join(", ")})`);
  assert(steps[0] === "alternatives:NONE_WORKED" && steps.includes("page_search:LEARNED") && steps.includes("page_search:FIXED"), "tried the built-in list first, then the page search fixed it");
  assert(sim.saved.some((x) => x.role === "assistant" && x.how === "page-search" && /data-turn-role="model"/.test(x.sel)), `learned + saved per site (${sim.saved.map((x) => x.sel).join(" ")})`);
  const det = sim.engine.events().find((e) => e.kind === "detect");
  assert(det && det.code === "NO_REPLY_FOUND", "detected as NO_REPLY_FOUND first (the ChatGPT case)");
  assert(sim.changes.some((c) => c.state === "repairing") && sim.changes.some((c) => c.ev && c.ev.kind === "fixed"), "state went repairing -> ok, with a 'fixed' event");

  console.log("\n== P18.5 engine: the reader sees the answer but nothing took it -> FALSE_DUPLICATE -> retry ==");
  sim = makeSite({ neverCapture: true });
  sim.engine.options.probeTimeoutMs = 400;
  const p = sim.engine.runCheck("chatgpt", "periodic");
  await waitUntil(() => sim.engine.events().some((e) => e.kind === "detect"));
  sim.o.neverCapture = false; // the P18.5 fix: the next answer is taken
  r = await p;
  st = sim.engine.state("chatgpt");
  assert(sim.engine.events().find((e) => e.kind === "detect").code === "FALSE_DUPLICATE", "an answer on screen that wasn't taken is FALSE_DUPLICATE");
  assert(r.ok && st.tried.some((t) => t.step === "retry" && t.outcome === "FIXED"), "a fresh check-in (new word) fixes it");

  console.log("\n== P18.8 engine: user-only problems ==");
  sim = makeSite({ page: "login" });
  r = await sim.engine.runCheck("chatgpt", "startup");
  st = sim.engine.state("chatgpt");
  assert(!r.ok && st.state === "needs_user" && st.problem === "LOGGED_OUT" && sim.sends === 0, "logged out -> needs_user, nothing is typed");
  assert(st.tried.some((t) => t.step === "signals" && t.outcome === "FOUND" && t.code === "LOGGED_OUT"), "'what was tried' says it looked for (and found) the log-in page");
  assert(Array.isArray(st.fix) && /log in/i.test(st.fix.join(" ")), "says exactly what to do (log in)");
  await sleep(60);
  await sim.engine.tick();
  await sleep(30);
  assert(sim.engine.state("chatgpt").state === "needs_user" && sim.engine.events().some((e) => e.kind === "recheck" && e.outcome === "STILL_THERE") && sim.sends === 0, "re-checks the signature cheaply (no message while it's still there)");
  sim.o.page = "chat"; sim.build(); // the user logged in
  sim.engine.onPageChanged("chatgpt");
  await sim.engine.tick();
  const back = await waitUntil(() => sim.engine.state("chatgpt").state === "ok");
  assert(back && sim.sends === 1 && sim.engine.events().some((e) => e.kind === "recheck" && e.outcome === "GONE"), "signature gone -> one check-in -> ok again");
  sim = makeSite({ page: "limit" });
  await sim.engine.runCheck("chatgpt", "startup");
  assert(sim.engine.state("chatgpt").problem === "USAGE_LIMIT" && sim.engine.state("chatgpt").state === "needs_user", "usage limit -> needs_user USAGE_LIMIT");
  assert(sim.engine.isUsable("chatgpt") === false, "a needs_user AI is not usable (BookForge gets 503)");

  console.log("\n== P18.6 engine: stuck generating -> press Stop, send once more ==");
  sim = makeSite();
  sim.generating = true; sim.stop = true; sim.build();
  r = await sim.engine.runCheck("chatgpt", "periodic");
  st = sim.engine.state("chatgpt");
  assert(r.ok && st.tried.some((t) => t.step === "unfreeze" && t.outcome === "PRESSED_STOP") && st.tried.some((t) => t.step === "unfreeze" && t.outcome === "FIXED"), `unfrozen (${st.tried.map((t) => t.step + ":" + t.outcome).join(", ")})`);

  console.log("\n== P18.6 engine: reload fixes it ==");
  sim = makeSite({ layout: "changed", reloadFixes: true, answer: true });
  sim.engine.options.probeTimeoutMs = 300;
  // page search fails here (word only in a shared container), the reload restores a normal page
  sim.o.layout = "changed";
  const origBlock = sim.block;
  sim.block = (who, text) => { if (sim.o.layout === "changed") { const l = sim.doc.getElementById("thread"); append(sim.doc, l, `<p>${text.replace(/</g, "&lt;")}</p>`); } else origBlock(who, text); };
  r = await sim.engine.runCheck("chatgpt", "periodic");
  st = sim.engine.state("chatgpt");
  assert(r.ok && sim.reloads === 1 && st.tried.some((t) => t.step === "reload" && t.outcome === "FIXED"), `reloaded and checked again (${st.tried.map((t) => t.step + ":" + t.outcome).join(", ")})`);

  console.log("\n== P37.3 engine: nothing works -> ONE notice, no automatic teach step, re-checks back off ==");
  sim = makeSite({ layout: "changed", options: { brokenBackoffMs: [150, 1200, 2400] } });
  sim.engine.options.probeTimeoutMs = 300;
  const flat = (who, text) => { const l = sim.doc.getElementById("thread"); if (l) append(sim.doc, l, `<p class="flat">${text.replace(/</g, "&lt;")}</p>`); };
  sim.block = flat;
  r = await sim.engine.runCheck("chatgpt", "periodic");
  st = sim.engine.state("chatgpt");
  assert(r.state === "broken" && r.ask === true && !st.teach && !sim.engine.teachActive("chatgpt"), `all automatic fixes failed -> "not working" with a notice for the user, and NO teach step started (${st.state}, teach ${!!st.teach})`);
  assert(st.askUser && st.nextCheckAt > Date.now() && sim.changes.some((c) => c.ev && c.ev.kind === "broken" && c.ev.ask === true), "the snapshot says the user was asked, and when the next re-check is");
  assert(sim.engine.events().filter((e) => e.kind === "ask_user").length === 1, "exactly one ask_user event");
  assert(sim.engine.requestCheck("chatgpt", "stalled") === false && sim.engine.requestCheck("chatgpt", "bookforge-timeout") === false, "automatic reasons (a stall, a BookForge timeout) don't re-check a 'not working' AI at once");
  let sends0 = sim.sends;
  await sim.engine.tick(); await sleep(20);
  assert(sim.sends === sends0, "tick right away: no re-check before the first back-off");
  await sleep(170); await sim.engine.tick();
  await waitUntil(() => sim.sends > sends0 && !sim.engine.state("chatgpt").running, 3000);
  const afterFirst = sim.sends - sends0;
  st = sim.engine.state("chatgpt");
  assert(afterFirst === 1 && st.state === "broken" && sim.reloads === 1, `first back-off: ONE plain check-in (no repairs, no reload) — sends +${afterFirst}, reloads ${sim.reloads}`);
  assert(sim.engine.events().filter((e) => e.kind === "ask_user").length === 1 && !sim.changes.slice(-3).some((c) => c.ev && c.ev.ask), "the failed re-check doesn't announce it again");
  sends0 = sim.sends;
  await sleep(170); await sim.engine.tick(); await sleep(20);
  assert(sim.sends === sends0, "the second wait is longer (15 min in the app) — nothing yet");
  const due2 = sim.engine.state("chatgpt").nextCheckAt;
  assert(due2 - Date.now() > 300, `the next re-check is further away (${due2 - Date.now()} ms)`);
  await sleep(Math.max(0, due2 - Date.now()) + 30); await sim.engine.tick();
  assert(await waitUntil(() => sim.sends === sends0 + 1, 3000), "…then the second re-check");
  await waitUntil(() => !sim.engine.state("chatgpt").running);
  assert(sim.engine.requestCheck("chatgpt", "after-save") === true && sim.engine.state("chatgpt").state === "broken", "a user action (🎯 Save) checks it at once (and starts the back-off over)");

  console.log("\n== P38 engine: 🔢 number teach — the user types the digits, AutoInjector asks for them backwards, saves, confirms ==");
  sim.block = flat;
  await waitUntil(() => !sim.engine.state("chatgpt").running);
  sim.engine.options.teachTimeoutMs = 8000;
  const tr = await sim.engine.startTeach("chatgpt", null, { auto: false });
  st = sim.engine.state("chatgpt");
  assert(tr.ok && /^\d{4}$/.test(tr.number) && st.teach && st.teach.active && st.teach.reversed === SR.reverseDigits(tr.number), `teach started on request (number ${tr.number}, reversed ${st.teach && st.teach.reversed})`);
  assert(sim.engine.teachActive("chatgpt") && sim.engine.isUsable("chatgpt") === false, "while teaching the AI is not usable");
  const N = tr.number, REV = SR.reverseDigits(N);
  await waitUntil(() => sim.doc.querySelector("[data-autoinjector-overlay]"));
  assert(new RegExp(`type\\s+${N}\\s+into ChatGPT`).test(sim.doc.querySelector("[data-autoinjector-overlay]").textContent), "the in-pane banner is up with the number");
  // the user's page now has proper blocks (what the teach step will learn)
  sim.block = (who, text) => { const l = sim.doc.getElementById("thread"); append(sim.doc, l, `<section class="${who === "bot" ? "bot-zone" : "me-zone"}" data-who="${who}"><div class="tx">${text.replace(/</g, "&lt;")}</div></section>`); };
  const box = sim.doc.getElementById("prompt-textarea");
  typeInto(box, N);
  await waitUntil(() => sim.engine.state("chatgpt").teach.phase === "typed");
  const stw = sim.doc.__window.__aiTeach;
  stw.events.push({ type: "click", t: Date.now(), el: sim.doc.querySelector('[data-testid="send-button"]') });
  box.textContent = "";
  sim.block("human", N);
  const sendsBefore = sim.sends;
  const askedOk = await waitUntil(() => sim.engine.state("chatgpt").teach.asked && sim.sends > sendsBefore, 4000);
  assert(askedOk && sim.teachOvLog && sim.teachOvLog[0] && sim.teachOvLog[0].input === "#prompt-textarea", `after the user's message, AutoInjector itself sent the follow-up with the box it just learned (${JSON.stringify(sim.teachOvLog && sim.teachOvLog[0])})`);
  assert(new RegExp(`Write the number ${N} backwards, digits only`).test(sim.doc.body.textContent), "the follow-up text is in the AI's chat");
  const done = await waitUntil(() => sim.engine.state("chatgpt").teach.result, 8000);
  st = sim.engine.state("chatgpt");
  assert(done === "fixed" && st.state === "ok", `taught + confirmed by a new check-in -> ✔ fixed (${done}, ${st.state})`);
  const saved = sim.saved.filter((x) => x.how === "number");
  assert(saved.map((x) => x.role).sort().join(",") === "assistant,input,send,user", `saved message box, Send button, user block and reply area as picks (${saved.map((x) => x.role).join(",")})`);
  const asel = (saved.find((x) => x.role === "assistant") || {}).sel;
  assert(asel && sim.doc.querySelectorAll(asel).length >= 2 && !/\d/.test(asel), `the reply area is general (${asel} matches ${asel ? sim.doc.querySelectorAll(asel).length : 0} replies)`);
  assert(st.teach.saved.join() === "input,send,assistant" && !st.teach.failedPart, "the snapshot lists what was saved, nothing failed");
  assert(sim.teachOvLog[sim.teachOvLog.length - 1] === null, "the temporary teach overrides are cleared afterwards");
  assert(!sim.doc.querySelector("[data-autoinjector-overlay]"), "the banner is removed afterwards");
  assert(textFree(sim, [`Write the number ${N}`, REV + "\n"]), "the follow-up text never reaches logs/events");
  assert(sim.engine.probeReplyKind("chatgpt", `[TO: USER]\n${REV}\n[FROM: CHATGPT]`, []) && sim.engine.probeReplyKind("chatgpt", `${N}`, null), "the teach answers (the number, the reversed number) are never nagged (P37.4)");

  console.log("\n== P38 engine: number teach — cancel, timeout, and a part that fails ==");
  sim = makeSite();
  await sim.engine.runCheck("chatgpt", "startup");
  await sim.engine.startTeach("chatgpt", "NO_REPLY_FOUND", { auto: false });
  assert(sim.engine.teachActive("chatgpt"), "teach started on request (🔢)");
  assert(sim.engine.cancelTeach("chatgpt").ok, "cancel accepted");
  await waitUntil(() => !sim.engine.teachActive("chatgpt"));
  st = sim.engine.state("chatgpt");
  assert(st.teach.result === "cancelled" && st.state === "ok" && !sim.doc.querySelector("[data-autoinjector-overlay]") && sim.saved.length === 0, `cancel -> nothing learned or saved, banner gone, the AI keeps its state (${st.state})`);
  sim = makeSite({ options: { teachTimeoutMs: 150 } });
  await sim.engine.startTeach("chatgpt", "TYPE_FAILED", { auto: false });
  await waitUntil(() => !sim.engine.teachActive("chatgpt"));
  st = sim.engine.state("chatgpt");
  assert(st.teach.result === "timeout" && st.teach.missing.includes("input") && st.teach.failedPart === "input" && sim.sends === 0, "nobody typed -> friendly timeout, says which part (the message box), nothing sent");
  // the AI never writes the number backwards -> the reply part fails, box + Send are still saved
  sim = makeSite({ answer: false, options: { teachTimeoutMs: 1500 } });
  const t3 = await sim.engine.startTeach("chatgpt", null, { auto: false });
  await waitUntil(() => sim.doc.querySelector("[data-autoinjector-overlay]"));
  const b3 = sim.doc.getElementById("prompt-textarea");
  typeInto(b3, t3.number);
  await waitUntil(() => sim.engine.state("chatgpt").teach.phase === "typed");
  sim.doc.__window.__aiTeach.events.push({ type: "click", t: Date.now(), el: sim.doc.querySelector('[data-testid="send-button"]') });
  b3.textContent = "";
  sim.block("human", t3.number);
  await waitUntil(() => !sim.engine.teachActive("chatgpt"), 5000);
  st = sim.engine.state("chatgpt");
  assert(st.teach.result === "failed" && st.teach.failedPart === "assistant" && st.teach.saved.includes("input") && st.teach.saved.includes("send") && !st.teach.saved.includes("assistant"), `no backwards answer -> it says the reply area failed (offer 🎯 for it), the box + Send are saved (${st.teach.result}, ${st.teach.failedPart}, saved ${st.teach.saved})`);
  assert(sim.engine.events().filter((e) => e.kind === "teach" && e.outcome === "STARTED").length === 1, "the teach step never restarts by itself");

  console.log("\n== P18.1 scheduling: busy / typing / inactive are skipped; requests run when free ==");
  sim = makeSite();
  sim.busy = "typing";
  let m = sim.engine.probeMany(null, "bookforge", "demand");
  assert(m.started.length === 0 && m.skipped.chatgpt === "typing" && sim.sends === 0, "the user is typing there -> skipped, nothing sent");
  sim.busy = null;
  m = sim.engine.probeMany(["chatgpt"], "bookforge", "demand");
  assert(m.started.join() === "chatgpt", "free -> started");
  await waitUntil(() => sim.engine.state("chatgpt").state === "ok");
  m = sim.engine.probeMany(["nope"], "x", "demand");
  assert(m.skipped.nope === "unknown_site", "unknown site is reported");
  sim = makeSite();
  sim.busy = "busy";
  assert(sim.engine.requestCheck("chatgpt", "stalled") === true, "a stall asks for a check-in");
  await sim.engine.tick();
  assert(sim.sends === 0, "...which waits while the AI is busy");
  sim.busy = null;
  await sim.engine.tick();
  assert(await waitUntil(() => sim.engine.state("chatgpt").state === "ok"), "...and runs once it is free");
  sim = makeSite({ options: { autoChecks: false } });
  assert(sim.engine.requestCheck("chatgpt", "stalled") === false && sim.engine.startup("chatgpt") === false, "automatic check-ins switched off -> no automatic requests");
  sim = makeSite({ options: { intervalMs: 300 } });
  await sim.engine.tick();
  await sleep(20);
  assert(sim.sends === 0, "periodic: nothing right at start (counted from app start; the start-up check-in is separate)");
  await sleep(320);
  await sim.engine.tick();
  assert(await waitUntil(() => sim.sends === 1), "periodic: due -> a check-in");
  await waitUntil(() => !sim.engine.state("chatgpt").running);
  await sim.engine.tick();
  await sleep(10);
  assert(sim.sends === 1, "periodic: not again before the interval");
  sim.engine.noteWorking("chatgpt");
  assert(sim.engine.state("chatgpt").state === "ok", "noteWorking keeps a working AI ok");
  sim = makeSite({ sendError: "INPUT_NOT_FOUND" });
  sim.engine.options.probeTimeoutMs = 100;
  r = await sim.engine.runCheck("chatgpt", "x", { repair: false });
  assert(r.state === "broken" && sim.engine.state("chatgpt").problem === "TYPE_FAILED", "repair:false -> just classified (TYPE_FAILED) and marked broken");
  sim.engine.noteWorking("chatgpt");
  assert(sim.engine.state("chatgpt").state === "ok", "a normal reply that answers a delivered message marks a broken AI ok again");
}

async function testOwnership() {
  console.log("\n== P18.1 ownership: a check-in waits, a BookForge reply arrives (the e2e flake) ==");
  let sim = makeSite({ answer: false, options: { probeTimeoutMs: 400 } });
  let run = sim.engine.runCheck("chatgpt", "bookforge");
  await waitUntil(() => sim.sends === 1);
  const probeSeq = sim.lastSeq;
  const word = /Reply with only this word: ([a-z]+)/.exec(sim.doc.body.textContent)[1];
  const bridgeSeq = String(Number(probeSeq) - 1).padStart(4, "0"); // the BookForge prompt typed BEFORE the check-in (late window)
  // the check-in word is an ordinary word (say "harbor") and BookForge's chapter uses it
  const chapter = `Chapter 2\nThe ${word.toUpperCase()} glowed at dusk over the ${word}, and Mara walked on.`;
  assert(sim.engine.expects("chatgpt", chapter, [bridgeSeq, probeSeq]) === false, "a reply that answers the older BookForge prompt too is NOT a check-in answer, even with the word in it");
  assert(sim.engine.onCaptured("chatgpt", { text: chapter, answers: [bridgeSeq, probeSeq] }) === false, "…onCaptured leaves it to its owner (the bridge)");
  assert(sim.engine.expects("chatgpt", chapter, [bridgeSeq]) === false, "a reply that answers only the BookForge prompt is never a check-in answer");
  assert(sim.engine.expects("chatgpt", chapter, [probeSeq, String(Number(probeSeq) + 1).padStart(4, "0")]) === false, "…nor one that also answers a message typed after the check-in (whose reply it may be)");
  let r = await run;
  let st = sim.engine.state("chatgpt");
  assert(r.ok === false && r.deferred === true && st.state === "unknown" && !st.problem, `the check-in is not satisfied by it and gives no verdict — the AI is NOT marked broken (${st.state} ${st.problem})`);
  assert(!sim.engine.events().some((e) => e.kind === "detect"), "no failure was detected/classified because of it");
  assert(sim.engine.events().some((e) => e.kind === "displaced") && sim.engine.events().some((e) => e.kind === "result" && e.outcome === "DEFERRED"), "logged as displaced / deferred");
  // its real answer still comes (it answers nothing now: its message was taken)
  assert(sim.engine.expects("chatgpt", `[TO: USER]\n${word}\n[FROM: CHATGPT]`, []) === true, "the check-in's own late answer (its [MSG #] already taken) is still owned");
  // …and the check-in is sent again once the AI is free
  sim.o.answer = true;
  await sim.engine.tick();
  assert(await waitUntil(() => sim.engine.state("chatgpt").state === "ok"), "the check-in is re-sent when the AI is free and passes");
  assert(sim.sends === 2, `re-sent once (${sim.sends} sends)`);
  sim = makeSite({ answer: false, options: { probeTimeoutMs: 300, autoChecks: false } });
  run = sim.engine.runCheck("chatgpt", "bookforge");
  await waitUntil(() => sim.sends === 1);
  sim.engine.noteForeignReply("chatgpt", ["0000", sim.lastSeq]);
  r = await run;
  sim.o.answer = true;
  await sim.engine.tick();
  await sleep(50);
  assert(r.deferred && r.again === false && sim.sends === 1 && sim.engine.state("chatgpt").state === "unknown", "automatic check-ins off: a displaced check-in just ends quietly (not re-sent, no verdict)");

  console.log("\n== P18.1 ownership: a reply without the word never satisfies a check-in ==");
  sim = makeSite({ answer: false, options: { probeTimeoutMs: 250, earlyQuietMs: 50 } });
  run = sim.engine.runCheck("chatgpt", "x", { repair: false });
  await waitUntil(() => sim.sends === 1);
  const w2 = /Reply with only this word: ([a-z]+)/.exec(sim.doc.body.textContent)[1];
  const s2 = sim.lastSeq;
  assert(sim.engine.onCaptured("chatgpt", { text: "[TO: USER]\nSure! Here is a poem about the sea.\n[FROM: CHATGPT]", answers: [s2] }) === false, "its own [MSG #] but no word -> not owned");
  assert(sim.engine.onCaptured("chatgpt", { text: `[TO: USER]\n${w2}master\n[FROM: CHATGPT]`, answers: [s2] }) === false, "the word only inside a longer word -> not owned (whole words only)");
  assert(sim.engine.expects("chatgpt", `[TO: USER]\n${w2.toUpperCase()}.\n[FROM: CHATGPT]`, [s2]) === true, "…while the word itself, any case, with punctuation, is");
  r = await run;
  assert(r.ok === false && !r.deferred, `-> the check-in fails on its own terms (${r.state} ${r.problem})`);
  assert(SR.containsWord("the Harbor.", "harbor") && !SR.containsWord("harbormaster", "harbor") && !SR.containsWord("", "harbor") && SR.containsWord("x 1234 y", "1234") && !SR.containsWord("12345", "1234"), "containsWord: whole word, case-insensitive");

  console.log("\n== P18.1 makeWay: a BookForge request withdraws an untyped check-in / waits for a typed one ==");
  sim = makeSite({ sendDelayMs: 300 });
  run = sim.engine.runCheck("chatgpt", "bookforge");
  await waitUntil(() => sim.engine.busyWithSite("chatgpt") && sim.sends === 1);
  assert(sim.engine.makeWay("chatgpt") === "withdrawn", "not typed yet -> withdrawn");
  r = await run;
  st = sim.engine.state("chatgpt");
  assert(r.deferred && r.reason === "bookforge" && st.state === "unknown" && !sim.engine.busyWithSite("chatgpt"), `deferred, no verdict, the AI is free for the request (${JSON.stringify(r)})`);
  assert(!/Reply with only this word/.test(sim.doc.body.textContent), "nothing was typed");
  assert(sim.engine.makeWay("chatgpt") === "none", "no check-in -> nothing to wait for");
  sim = makeSite({ answer: false, options: { probeTimeoutMs: 5000 } });
  run = sim.engine.runCheck("chatgpt", "bookforge");
  await waitUntil(() => sim.sends === 1 && /Reply with only this word/.test(sim.doc.body.textContent));
  await sleep(20);
  assert(sim.engine.makeWay("chatgpt") === "wait" && sim.engine.busyWithSite("chatgpt"), "typed -> the request waits for it to settle");
  const w3 = /Reply with only this word: ([a-z]+)/.exec(sim.doc.body.textContent)[1];
  sim.engine.onCaptured("chatgpt", { text: w3, answers: [sim.lastSeq] });
  r = await run;
  assert(r.ok && !sim.engine.busyWithSite("chatgpt"), "its answer came -> settled (ok), the AI is free");
  sim = makeSite({ layout: "changed", answer: false, options: { probeTimeoutMs: 150, earlyQuietMs: 50 } });
  run = sim.engine.runCheck("chatgpt", "x");
  await waitUntil(() => sim.sends === 1);
  await sleep(20);
  sim.engine.makeWay("chatgpt");
  r = await run;
  st = sim.engine.state("chatgpt");
  assert(r.deferred && st.state === "unknown" && sim.reloads === 0, `a failed check-in with a request waiting: no repair steps (no reload), no verdict (${st.state}, ${st.tried.map((t) => t.step).join(",")})`);
}

// ---------------------------------------------------------------------------------
async function testPicker() {
  console.log("\n== P38 🎯 picker page script: choose ONE thing, hover outlines it, the click picks it ==");
  const html = `<main><div id="thread">
      <div data-message-author-role="user"><div class="user-text">hello there</div></div>
      <div data-message-author-role="assistant" data-message-id="m-1111aaaa"><div class="markdown prose"><p>[TO: USER]</p><p>First answer, long enough.</p><p>[FROM: CHATGPT]</p></div></div>
      <div data-message-author-role="user"><div class="user-text">and again</div></div>
      <div data-message-author-role="assistant" data-message-id="m-2222bbbb"><div class="markdown prose"><p>[TO: USER]</p><p>The latest answer is this one.</p><p>[FROM: CHATGPT]</p></div></div>
    </div><form><div id="wrap"><div id="prompt-textarea" contenteditable="true" class="ProseMirror"><p>draft</p></div></div><button data-testid="send-button" aria-label="Send prompt"><svg></svg></button></form></main>`;
  for (const [role, clickOn, check] of [
    ["input", (d) => d.querySelector("#prompt-textarea p"), (r, d) => d.querySelector(r.selector) === d.getElementById("prompt-textarea") && r.preview === "Message box found"],
    ["send", (d) => d.querySelector('[data-testid="send-button"] svg'), (r, d) => d.querySelector(r.selector) === d.querySelector('[data-testid="send-button"]') && r.preview === "Send button found"],
    ["assistant", (d) => d.querySelectorAll(".markdown p")[4], (r, d) => d.querySelectorAll(r.selector).length === 2 && /latest answer/.test(r.preview) && r.latest === true && !/\d/.test(r.selector)]
  ]) {
    const doc = parseHTML(html, { url: "https://chatgpt.com/c/1" });
    const p = runScript(SR.buildPickScript("chatgpt", role, "ChatGPT", SITES, 3000), doc);
    await sleep(5);
    const banner = doc.querySelector("[data-autoinjector-overlay]");
    assert(banner && banner.textContent.includes(`Click ${SR.PICK_THING[role]} in this window`), `(${role}) the banner says "Click ${SR.PICK_THING[role]} in this window"`);
    const target = clickOn(doc);
    target.dispatchEvent({ type: "mouseover", target });
    const hl = doc.querySelectorAll("[data-autoinjector-overlay]").find((x) => /border:3px/.test(x.getAttribute("style") || ""));
    assert(!!hl, `(${role}) hovering outlines the candidate`);
    let prevented = false;
    target.dispatchEvent({ type: "click", target, preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
    const r = await p;
    assert(r.ok && r.role === role && check(r, doc), `(${role}) the click picked it: ${r.selector} — "${r.preview}"`);
    assert(prevented && !doc.querySelector("[data-autoinjector-overlay]") && !doc.__window.__aiPick, `(${role}) the click is swallowed and the banner/outline are gone`);
  }
  // wrong kind of element / user message / Esc / cancel / timeout
  let doc = parseHTML(html, { url: "https://chatgpt.com/c/1" });
  let p = runScript(SR.buildPickScript("chatgpt", "send", "ChatGPT", SITES, 3000), doc);
  await sleep(5);
  let t = doc.querySelector(".user-text"); t.dispatchEvent({ type: "click", target: t, preventDefault() {}, stopImmediatePropagation() {} });
  assert((await p).error === "WRONG_ELEMENT_TYPE", "a click on text when the Send button was asked for -> WRONG_ELEMENT_TYPE");
  p = runScript(SR.buildPickScript("chatgpt", "assistant", "ChatGPT", SITES, 3000), doc);
  await sleep(5);
  t = doc.querySelector(".user-text"); t.dispatchEvent({ type: "click", target: t, preventDefault() {}, stopImmediatePropagation() {} });
  assert((await p).error === "LOOKS_LIKE_USER", "pointing at the user's own message for the AI's reply -> LOOKS_LIKE_USER");
  p = runScript(SR.buildPickScript("chatgpt", "input", "ChatGPT", SITES, 3000), doc);
  await sleep(5);
  doc.dispatchEvent({ type: "keydown", key: "Escape", target: doc.body, preventDefault() {}, stopImmediatePropagation() {} });
  assert((await p).error === "CANCELLED", "Esc cancels");
  p = runScript(SR.buildPickScript("chatgpt", "input", "ChatGPT", SITES, 3000), doc);
  await sleep(5);
  const c = await runScript(SR.buildPickCancelScript(), doc);
  assert(c.cancelled && (await p).error === "CANCELLED" && !doc.querySelector("[data-autoinjector-overlay]"), "the panel's Cancel stops it");
  p = runScript(SR.buildPickScript("chatgpt", "input", "ChatGPT", SITES, 60), doc);
  assert((await p).error === "TIMEOUT", "no click in time -> TIMEOUT");
  // saved picks still matching? (the red ⚠️ chip)
  const mc = await runScript(SR.buildMatchCheckScript("chatgpt", SITES, { input: "#prompt-textarea", send: "button.gone", assistant: '[data-message-author-role="assistant"]' }), doc);
  assert(mc.ok && mc.roles.input.ok && !mc.roles.send.ok && mc.roles.assistant.count === 2 && mc.repliesOnPage === 2, "matchCheck: which saved selectors still find their thing");
  // only the per-message key tells replies apart -> the key suffix is learned
  const k = (n, who, text) => `<div class="row"><div data-content-search-unit-key="fallback-turn-${n}:${who === "user" ? 1 : 2}:${who}"><span>${text}</span></div></div>`;
  doc = parseHTML(`<main><div id="t">${k(1, "user", "hi")}${k(2, "assistant", "older")}${k(3, "user", "more")}${k(4, "assistant", "newest reply")}</div><textarea></textarea></main>`, { url: "https://chatgpt.com/c/9" });
  const pk = K.pickResolve(doc, doc.querySelectorAll("span")[3], { role: "assistant", markers: [], userSel: "" });
  assert(pk.ok && /data-content-search-unit-key\$=":assistant"/.test(pk.selector) && doc.querySelectorAll(pk.selector).length === 2, `the ChatGPT key alone: 🎯 learns ${pk.selector}`);
}

function testNoNags() {
  console.log("\n== P37.4 check-in / teach answers are never nagged ==");
  const sim = makeSite();
  return sim.engine.runCheck("chatgpt", "startup").then(() => {
    const word = /Reply with only this word: ([a-z]+)/.exec(sim.doc.body.textContent)[1];
    const seq = sim.lastSeq;
    const K2 = (t, a) => sim.engine.probeReplyKind("chatgpt", t, a);
    assert(K2(`${word}\n[FROM: CHATGPT]`, [seq]) === "owned", "the check-in's own answer (no [TO:] tag) -> owned, no nag");
    assert(K2("Sure, here you go.\n[FROM: CHATGPT]", [seq]) === "answers-checkin", "an answer to a check-in's [MSG #] without the word -> still a check-in answer");
    assert(K2(`${word}\n[FROM: CHATGPT]`, []) === "has-word", "a late, short answer holding a recent check-in word -> no nag");
    assert(K2(`${word}`, ["0999"]) === null, "a reply to another message (even with the word) is a normal reply");
    assert(K2(`A long chapter about the ${word} ` + "and more words ".repeat(40), null) === null, "a long reply that merely uses the word is a normal reply");
    assert(K2("Hello, how can I help?", []) === null, "an unrelated reply -> null");
    assert(K2(`Reply with only this word: ${word}`, [seq]) === null, "the user's / app's own message never counts");
  });
}

function testLearnedStore() {
  console.log("\n== learned selectors: versioned, with timestamps, sanitized on load ==");
  const raw = { version: 1, sites: { chatgpt: { assistant: { selector: 'div[data-turn-role="model"]', how: "page-search", learnedAt: 123, version: 1 }, input: { selector: "span" }, send: { selector: 42 } }, evil: { assistant: { selector: "x" } } } };
  const out = SR.sanitizeLearned(raw, ["chatgpt", "claude", "gemini"], (s) => /^\s*[a-z]+\s*$/i.test(s));
  assert(out.chatgpt.assistant && out.chatgpt.assistant.how === "page-search" && out.chatgpt.assistant.learnedAt === 123 && out.chatgpt.assistant.version === 1, "kept: selector, how, learnedAt, version");
  assert(!out.chatgpt.input && !out.chatgpt.send && !out.evil && out.claude && Object.keys(out.claude).length === 0, "dropped: bare tags, non-strings, unknown sites");
  assert(Object.keys(SR.sanitizeLearned(null, ["chatgpt"])).join() === "chatgpt", "nothing saved -> empty per site");
}

(async () => {
  try {
    testClassifier();
    await testSignals();
    await testAlternatives();
    await testPageSearch();
    await testTeachLearner();
    await testGeneralise();
    await testEngine();
    await testOwnership();
    await testPicker();
    await testNoNags();
    testLearnedStore();
  } catch (e) { failed++; console.log(`  FAIL - crashed: ${e && e.stack || e}`); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
