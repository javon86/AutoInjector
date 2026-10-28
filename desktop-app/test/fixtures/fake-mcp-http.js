'use strict';
// test/fixtures/fake-mcp-http.js — a tiny MCP tool server over Streamable HTTP, for tests.
//   const s = await startFakeMcpHttp({ token: 'abc', sse: true });  s.url, s.state, s.close()
// It hands out an Mcp-Session-Id on initialize and wants it back; with `token` it wants
// "Authorization: Bearer <token>". With sse:true tools/call answers as a short text/event-stream
// (a notification first, then the result). tools/list is paged (one tool per page). forgetSessions()
// makes the next request with an old session answer 404 (as after a server restart). callDelayMs: tools/call
// answers only after that long (the socket stays idle meanwhile).
const http = require('http');
function startFakeMcpHttp(opts = {}) {
  const state = { requests: [], sessions: new Set(), deleted: 0, auth: [] };
  const TOOLS = [
    { name: 'shout', description: 'Upper-case the text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'when', description: 'The time.', inputSchema: { type: 'object', properties: {} } },
  ];
  let n = 0;
  const server = http.createServer((req, res) => {
    state.auth.push(req.headers.authorization || '');
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'unauthorized' })); }
    if (req.method === 'DELETE') { state.deleted++; state.sessions.delete(req.headers['mcp-session-id']); res.writeHead(200); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let msg; try { msg = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end(); }
      state.requests.push({ method: msg.method, session: req.headers['mcp-session-id'] || null, protocol: req.headers['mcp-protocol-version'] || null, accept: req.headers.accept });
      if (msg.method === 'initialize') {
        const sid = `s${++n}`; state.sessions.add(sid);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sid });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-http', version: '1' } } }));
      }
      if (!state.sessions.has(req.headers['mcp-session-id'])) { res.writeHead(404); return res.end('no session'); }
      if (msg.id == null) { res.writeHead(202); return res.end(); }
      if (msg.method === 'tools/list') {
        const i = msg.params && msg.params.cursor ? Number(msg.params.cursor) : 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: Object.assign({ tools: TOOLS.slice(i, i + 1) }, i + 1 < TOOLS.length ? { nextCursor: String(i + 1) } : {}) }));
      }
      if (msg.method === 'tools/call' && opts.callDelayMs && !req.__delayed) { // a slow tool: nothing is sent for a while
        req.__delayed = true;
        return setTimeout(() => { if (!res.destroyed && !res.writableEnded) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'slow noon' }] } })); } }, opts.callDelayMs);
      }
      if (msg.method === 'tools/call') {
        const a = (msg.params && msg.params.arguments) || {};
        const result = msg.params.name === 'shout' ? { content: [{ type: 'text', text: String(a.text || '').toUpperCase() }] } : { content: [{ type: 'text', text: 'noon' }] };
        if (opts.sse) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write(': keep-alive\n\n');
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
          setTimeout(() => { res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`); if (!opts.keepOpen) res.end(); }, 30);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({ url: `http://127.0.0.1:${port}/mcp`, port, state, forgetSessions: () => state.sessions.clear(), close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }) });
  }));
}
module.exports = { startFakeMcpHttp };
