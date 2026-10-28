#!/usr/bin/env node
'use strict';
// test/fixtures/fake-mcp-server.js — a tiny MCP tool server over stdio (newline-delimited JSON-RPC), for tests.
// Behaviour through env:
//   FAKE_MCP_MODE   normal (default) | noinit (never answers initialize) | die (prints to stderr, exits 2 at once)
//   FAKE_MCP_STARTS a file: one line is appended per start (to count restarts)
//   FAKE_TOKEN      a "secret": the `leak` tool writes it to stderr, then the process exits
// Tools (tools/list is paged two at a time, so a client must follow nextCursor):
//   echo {text}  · add {a,b}  · picture {}  · doc {}  · fail {}  · slow {ms}  · crash {}  · leak {}
const fs = require('fs');
const mode = process.env.FAKE_MCP_MODE || 'normal';
if (process.env.FAKE_MCP_STARTS) { try { fs.appendFileSync(process.env.FAKE_MCP_STARTS, `${process.pid}\n`); } catch (_) {} }
if (mode === 'die') { process.stderr.write(`fatal: bad config, token=${process.env.FAKE_TOKEN || 'none'} rejected\n`); process.exit(2); }
process.stderr.write('fake-mcp: starting (this line is just noise on stderr)\n');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64');
const TOOLS = [
  { name: 'echo', description: 'Say the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'] } },
  { name: 'add', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false } },
  { name: 'picture', description: 'Return a tiny picture.', inputSchema: { type: 'object', properties: {} } },
  { name: 'doc', description: 'Return an embedded resource and a link.', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Always reports a problem.', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Answers after ms milliseconds.', inputSchema: { type: 'object', properties: { ms: { type: 'integer', minimum: 0, maximum: 60000 } } } },
  { name: 'crash', description: 'Exits the server.', inputSchema: { type: 'object', properties: {} } },
  { name: 'leak', description: 'Writes the secret to stderr, then exits.', inputSchema: { type: 'object', properties: {} } },
];
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let initialized = false;
function handle(msg) {
  if (msg.method === 'initialize') {
    if (mode === 'noinit') return;
    return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params && msg.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake-mcp', version: '0.0.1' }, client: msg.params && msg.params.clientInfo } });
  }
  if (msg.method === 'notifications/initialized') { initialized = true; send({ jsonrpc: '2.0', id: 'srv-1', method: 'ping' }); return; }
  if (msg.id === 'srv-1') return; // the client's answer to our ping
  if (msg.method === 'tools/list') {
    const start = msg.params && msg.params.cursor ? Number(msg.params.cursor) : 0;
    const page = TOOLS.slice(start, start + 2);
    const next = start + 2 < TOOLS.length ? String(start + 2) : undefined;
    return send({ jsonrpc: '2.0', id: msg.id, result: Object.assign({ tools: page }, next ? { nextCursor: next } : {}) });
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: a = {} } = msg.params || {};
    const ok = (content, extra) => send({ jsonrpc: '2.0', id: msg.id, result: Object.assign({ content }, extra || {}) });
    switch (name) {
      case 'echo': return ok([{ type: 'text', text: `echo: ${a.text}` }]);
      case 'add': return ok([{ type: 'text', text: String(Number(a.a) + Number(a.b)) }], { structuredContent: { sum: Number(a.a) + Number(a.b) } });
      case 'picture': return ok([{ type: 'text', text: 'here is a picture' }, { type: 'image', data: PNG, mimeType: 'image/png' }]);
      case 'doc': return ok([{ type: 'resource', resource: { uri: 'file:///notes/a.txt', mimeType: 'text/plain', text: 'note text' } }, { type: 'resource_link', uri: 'file:///notes/b.txt', name: 'b.txt' }]);
      case 'fail': return ok([{ type: 'text', text: 'the disk is full' }], { isError: true });
      case 'slow': return setTimeout(() => ok([{ type: 'text', text: 'finally' }]), Number(a.ms) || 0);
      case 'crash': process.stderr.write('fake-mcp: crashing on purpose\n'); return process.exit(3);
      case 'leak': process.stderr.write(`oops my token is ${process.env.FAKE_TOKEN}\n`); return setTimeout(() => process.exit(4), 20);
      default: return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    }
  }
  if (msg.id != null && msg.method) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (e) { process.stderr.write(`bad line: ${e.message}\n`); }
  }
});
process.stdin.on('end', () => process.exit(0)); // a clean stop closes stdin
void initialized;
