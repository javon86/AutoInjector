'use strict';
// test/alfred-ollama.test.js — Alfred's local brain on Ollama's own /api/chat: a context window big enough for
// his tool list (Ollama's default would cut it off), qwen3 without its thinking pass, <think> text removed,
// tool calls and tool results in Ollama's shape, and the /v1 fallback for servers that aren't Ollama.
// Run: node test/alfred-ollama.test.js
const http = require('http');
const ai = require('../alfred-ai');
const tools = require('../alfred-tools');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

function fakeServer({ ollama = true, reply, noTools = false }) {
  const st = { chats: [], v1: [] };
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = (() => { try { return JSON.parse(body || '{}'); } catch (_) { return {}; } })();
      const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (ollama && req.url === '/api/version') return send(200, { version: '0.12.3' });
      if (ollama && req.url === '/api/chat') { st.chats.push(j); if (noTools && j.tools) return send(400, { error: `registry.ollama.ai/library/${j.model} does not support tools` }); return send(200, { model: j.model, message: reply(j) }); }
      if (req.url === '/v1/chat/completions') { st.v1.push(j); return send(200, { choices: [{ message: { role: 'assistant', content: 'from v1' } }] }); }
      res.writeHead(404); res.end('404 page not found');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ st, srv, ep: `http://127.0.0.1:${srv.address().port}/v1` })));
}

(async () => {
  console.log('\n== thinking text ==');
  assert(ai.stripThinking('<think>let me see…</think>\nHello!') === 'Hello!', '<think>…</think> is removed');
  assert(ai.stripThinking('half a thought</think> Done.') === 'Done.', 'a cut-off opening tag is handled');
  assert(ai.stripThinking('<think>never finished') === '', 'unfinished thinking gives nothing (not the thoughts)');
  assert(ai.normalizeMessage({ content: '<think>hmm</think>{"tool":"book_status","args":{}}' }).toolCalls[0].name === 'book_status', 'a text tool call after thinking is still understood');

  console.log('\n== the context window ==');
  const all = tools.openAiTools();
  const need = ai.contextFor([{ role: 'system', content: 'x'.repeat(2000) }, { role: 'user', content: 'hi' }], all);
  assert(need >= 12288 && need % 4096 === 0 && need <= 32768, `Alfred's full tool list asks for ${need} tokens (Ollama's default 2–4k would cut it off)`);
  assert(ai.contextFor([{ role: 'user', content: 'hi' }], []) === 8192, 'a tiny request still gets 8k');
  assert(ai.contextFor([{ role: 'user', content: 'x'.repeat(400000) }], all) === 32768, 'capped at 32k');

  console.log('\n== Ollama /api/chat ==');
  ai._resetOllamaCache();
  const o = await fakeServer({ reply: (j) => (j.messages.some((m) => m.role === 'tool')
    ? { role: 'assistant', content: '<think>ok</think>Your book is in chapter 3.' }
    : { role: 'assistant', content: '', tool_calls: [{ function: { name: 'book_status', arguments: { project: 'p1' } } }] }) });
  const cfg = { kind: 'local', endpoint: o.ep, model: 'qwen3:14b', timeoutMs: 5000 };
  const msgs = [{ role: 'system', content: 'You are Alfred.' }, { role: 'user', content: 'status?' }];
  let r = await ai.next(cfg, msgs, all);
  const sent = o.st.chats[0];
  assert(r.ok && o.st.v1.length === 0 && sent, 'an Ollama server is talked to through /api/chat, not /v1');
  assert(sent.options.num_ctx >= 12288 && sent.keep_alive === '30m' && sent.stream === false, `num_ctx ${sent.options.num_ctx}, keep_alive 30m`);
  assert(/\/no_think$/.test(sent.messages[0].content) && msgs[0].content === 'You are Alfred.', 'qwen3: /no_think added to the system message (the caller\'s copy untouched)');
  assert(Array.isArray(sent.tools) && sent.tools.length === all.length, 'the tools are sent');
  assert(r.message.toolCalls[0].name === 'book_status' && r.message.toolCalls[0].args.project === 'p1', 'Ollama\'s tool call (arguments as an object) is understood');
  const hist = msgs.concat([{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'book_status', arguments: '{"project":"p1"}' } }] }, { role: 'tool', tool_call_id: 'c1', name: 'book_status', content: '{"ok":true}' }]);
  r = await ai.next(cfg, hist, all);
  const s2 = o.st.chats[1];
  assert(s2.messages[2].tool_calls[0].function.arguments.project === 'p1' && s2.messages[3].role === 'tool' && s2.messages[3].tool_name === 'book_status', 'history is sent in Ollama\'s shape (arguments as objects, tool_name on results)');
  assert(r.ok && r.message.content === 'Your book is in chapter 3.', 'the answer comes back without its thinking');
  r = await ai.next(Object.assign({}, cfg, { model: 'llama3.1:8b' }), msgs, all);
  assert(!/no_think/.test(o.st.chats[2].messages[0].content), 'other models are not sent /no_think');
  o.srv.close();

  console.log('\n== not Ollama: the OpenAI-compatible /v1 as before ==');
  const v = await fakeServer({ ollama: false });
  r = await ai.next({ kind: 'local', endpoint: v.ep, model: 'some-model', timeoutMs: 5000 }, msgs, all);
  assert(r.ok && v.st.v1.length === 1 && r.message.content === 'from v1', 'LM Studio / llama.cpp style servers still work through /v1');
  v.srv.close();

  console.log('\n== speed: no model reloads, no needless round-trips (PC test: ~1½ min per answer) ==');
  {
    ai._resetOllamaCache();
    const sp = await fakeServer({ reply: (j) => (j.messages.some((m) => m.role === 'tool') ? { role: 'assistant', content: 'Done.' } : { role: 'assistant', content: '', tool_calls: [{ function: { name: 'book_status', arguments: {} } }] }) });
    const c = { kind: 'local', endpoint: sp.ep, model: 'qwen2.5:7b', timeoutMs: 5000 };
    const base = [{ role: 'system', content: 'You are Alfred.' }, { role: 'user', content: 'status?' }];
    await ai.next(c, base, all);
    // the tool result makes the conversation bigger — before, this crossed into the next 4k step: a different
    // num_ctx = Ollama reloads the model and re-reads the whole tool list
    const big = base.concat([{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'book_status', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', name: 'book_status', content: JSON.stringify({ ok: true, data: 'x'.repeat(14000) }) }]);
    await ai.next(c, big, all);
    await ai.next(c, base, all); // a new, short question after that
    const sizes = sp.st.chats.map((x) => x.options.num_ctx);
    assert(ai.contextFor(base, all) !== ai.contextFor(big, all), `(the two requests alone would ask for ${ai.contextFor(base, all)} and ${ai.contextFor(big, all)})`);
    assert(sizes.length === 3 && sizes.every((n) => n === sizes[0]), `num_ctx stays the same for every call (${sizes.join(', ')}) — no reload between ask, tool result and the next question`);
    sp.srv.close();
    ai._resetOllamaCache();
    const nt = await fakeServer({ noTools: true, reply: () => ({ role: 'assistant', content: '{"reply":"Hello."}' }) });
    const c2 = { kind: 'local', endpoint: nt.ep, model: 'tinyllama', timeoutMs: 5000 };
    let x = await ai.next(c2, base, all);
    assert(x.ok && x.message.content === 'Hello.' && nt.st.chats.length === 2, 'a model without tool support: refused once, then asked with the text protocol');
    x = await ai.next(c2, base, all);
    assert(x.ok && nt.st.chats.length === 3 && !nt.st.chats[2].tools, 'the next step goes straight to the text protocol (one call, not a failing call + a retry)');
    nt.srv.close();
  }

  console.log('\n== a wrong call gets the right shape back ==');
  assert(tools.usage(tools.get('generate_video')).startsWith('generate_video({prompt?: string'), `usage: ${tools.usage(tools.get('generate_video'))}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
