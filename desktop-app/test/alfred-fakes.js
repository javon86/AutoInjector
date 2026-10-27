'use strict';
// test/alfred-fakes.js — fakes for the 🎩 Alfred tests: an OpenAI-compatible server (like Ollama's
// /v1) that returns scripted tool calls, a tiny Stable Diffusion txt2img server, and a fake Akọwe
// HTTP API (token-checked) that records what it was asked.
const http = require('http');

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function readBody(req) { return new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => { const t = Buffer.concat(c).toString('utf8'); try { r(t ? JSON.parse(t) : null); } catch (_) { r(t); } }); }); }
function send(res, status, obj) { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': b.length }); res.end(b); }

/** script(body, n) -> message | { delayMs, message } | { status, body } */
async function fakeLlm(script) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) return send(res, 200, { data: [{ id: 'fake-model' }] });
    if (req.method === 'GET' && req.url === '/api/tags') return send(res, 200, { models: [{ name: 'fake-model' }] });
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) return send(res, 404, { error: 'no' });
    const body = await readBody(req);
    requests.push({ body, auth: req.headers.authorization || null });
    let out;
    try { out = await script(body, requests.length); } catch (e) { out = { status: 500, body: { error: String(e) } }; }
    if (out && out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
    if (res.destroyed) return;
    if (out && out.status) return send(res, out.status, out.body || {});
    const message = out && out.message ? out.message : out;
    send(res, 200, { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: Object.assign({ role: 'assistant', content: '' }, message), finish_reason: message && message.tool_calls ? 'tool_calls' : 'stop' }] });
  });
  const port = await listen(server);
  return { port, base: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }) };
}
let callN = 0;
function toolCall(name, args) { callN += 1; return { content: '', tool_calls: [{ id: `call_${callN}`, type: 'function', function: { name, arguments: JSON.stringify(args || {}) } }] }; }
function lastMsg(body) { return body.messages[body.messages.length - 1]; }
function lastUser(body) { for (let i = body.messages.length - 1; i >= 0; i--) if (body.messages[i].role === 'user') return body.messages[i]; return null; }

// A 1x1 PNG
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
async function fakeSd() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push(body);
    send(res, 200, { images: [PNG_1PX], info: '{}' });
  });
  const port = await listen(server);
  return { port, endpoint: `http://127.0.0.1:${port}/sdapi/v1/txt2img`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

/** A fake Akọwe API: one book with a draft chapter, a run, characters, story rules and texture. */
async function fakeAkowe(token) {
  const requests = [];
  const st = {
    projects: [{ project_id: 'proj-1', name: 'The Lighthouse Keeper' }],
    run: { id: 'run-abc', status: 'running', phase: 'Writing chapter 2', title: 'The Lighthouse Keeper', project_id: 'proj-1', steps: [{ id: 'backup', title: 'Backup', state: 'done' }, { id: 'chapters', title: 'Chapters', state: 'running' }], events: [{ message: 'Chapter 1 approved under your consent' }], problem: null },
    profile: { title: 'The Lighthouse Keeper', genre: 'mystery' },
    characters: [{ record_id: 'rec-mara', name: 'Mara Vell', version: 2, sheet: { wants: 'find her master', fear: 'the sea' }, voice: { rhythm: 'short' } }],
    rules: { version: 3, rules: [{ id: 'r1', category: 'hard_rule', text: 'The lamp never goes out.' }] },
    texture: { version: 1, items: [{ id: 't1', kind: 'work', detail: 'Wick trimming at dusk' }] },
    // Character Forge (CONTRACT: docs/CHARACTER_FORGE.md)
    dossier: { record_id: 'rec-mara', name: 'Mara Vell', code: 'CH-001', revision: 1, readiness: 'draft', tagline: 'The keeper who stayed',
      sections: [
        { key: 'record', n: 1, title: 'Character record', fields: [
          { key: 'supplied_canon', label: 'Supplied canon', letters: ['C', 'A'], text: 'Grey coat, salt-white hair.', status: 'supplied', protected: true },
          { key: 'traits', label: 'Traits', letters: ['P'], text: 'Stubborn, kind.', status: 'proposed', protected: false },
          { key: 'goals', label: 'Goals', letters: ['S', 'P'], text: '', status: 'proposed', protected: false }] },
        { key: 'inner_life', n: 2, title: 'Inner life', fields: [
          { key: 'fear', label: 'What they fear', letters: ['P'], text: 'The sea.', status: 'approved', protected: false }] }],
      art: { portrait: null, views: { front: { asset_id: 'a1' } }, sheet: null } },
    forgeCalls: [],
    pictures: { style: 'ink wash', styles: ['ink wash', 'painterly'], chapters: [
      { chapter_id: 'ch1', number: 1, title: 'The Lamp Room', state: 'chosen', pictures: [{ pic_id: 'pic-001', chosen: 0, candidates: [{}, {}], caption: 'Mara climbs', placement: { where: 'start' } }] },
      { chapter_id: 'ch2', number: 2, title: 'Fog', state: 'none', pictures: [] }], map: null },
    pictureCalls: [],
  };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    requests.push({ method: req.method, path: p, query: url.search, body, auth: req.headers.authorization || null });
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { errors: [{ code: 'UNAUTHORIZED', message: 'missing or wrong token' }] });
    const m = req.method;
    const B = '/api/projects/proj-1/branches/main';
    if (m === 'GET' && p === '/api/projects') return send(res, 200, st.projects);
    if (m === 'GET' && p === '/api/autobook') return send(res, 200, { runs: [st.run], active: ['running', 'queued', 'pausing'].includes(st.run.status) ? [st.run] : [] });
    if (m === 'POST' && p === '/api/autobook') {
      if (!body || body.author_confirms !== true) return send(res, 400, { errors: [{ code: 'APPROVAL_REQUIRED', message: 'consent needed' }] });
      return send(res, 202, { id: 'run-new', status: 'queued', phase: 'Starting', project_id: null, steps: [], events: [] });
    }
    let mm = /^\/api\/autobook\/([^/]+)\/(pause|resume|cancel)$/.exec(p);
    if (m === 'POST' && mm) { st.run.status = { pause: 'pausing', resume: 'running', cancel: 'cancelled' }[mm[2]]; return send(res, 200, st.run); }
    if (m === 'GET' && p === '/api/slots/states') return send(res, 200, { slots: [{ slot_id: 'AI-1', name: 'Claude', state: 'ok', word: 'works' }] });
    if (m === 'GET' && p === `${B}/book`) return send(res, 200, { steps: [{ id: 'profile', title: 'Book profile', state: 'done' }, { id: 'chapters', title: 'Write the chapters', state: 'needs_you', chapters: [{ chapter_id: 'ch1', state: 'done', approved: { record_id: 'rec-c1', version: 1 }, prose: { record_id: 'rec-c1', version: 1, lifecycle: 'APPROVED' } }, { chapter_id: 'ch2', state: 'needs_you', prose: { record_id: 'rec-c2', version: 1, lifecycle: 'DRAFT' } }] }] });
    if (m === 'GET' && p === `${B}/journal`) return send(res, 200, { entries: [{ what: 'AI review: REVISE (rec-c2 v1)', problem: { code: 'REVISE' } }] });
    if (m === 'PUT' && p === '/api/projects/proj-1/profile') { Object.assign(st.profile, body); return send(res, 200, st.profile); }
    if (m === 'GET' && p === `${B}/review/characters`) return send(res, 200, { characters: st.characters });
    mm = /^\/api\/projects\/proj-1\/branches\/main\/review\/characters\/([^/]+)$/.exec(p);
    if (m === 'PUT' && mm) { const c = st.characters.find((x) => x.record_id === mm[1]); if (!c) return send(res, 404, { errors: [{ code: 'NOT_FOUND', message: 'no' }] }); Object.assign(c, { sheet: body.sheet || c.sheet, voice: body.voice || c.voice, version: c.version + 1 }); return send(res, 200, { ok: true, message: `Saved (version ${c.version}).` }); }
    if (m === 'GET' && p === `${B}/review/world`) return send(res, 200, { rules: st.rules, texture: st.texture });
    if (m === 'PUT' && p === `${B}/review/world/rules`) { st.rules = { version: st.rules.version + 1, rules: body.rules }; return send(res, 200, { ok: true, message: 'Saved.' }); }
    if (m === 'PUT' && p === `${B}/review/world/texture`) { st.texture = { version: st.texture.version + 1, items: body.items }; return send(res, 200, { ok: true, message: 'Saved.' }); }
    if (m === 'POST' && p === `${B}/review/fix`) return send(res, 202, { job_id: 'job-1', status: 'queued' });
    if (m === 'POST' && p === `${B}/report`) return send(res, 202, { job_id: 'rep-1' });
    if (m === 'POST' && p === `${B}/save`) return send(res, 202, { ok: true });
    if (m === 'POST' && p === `${B}/journal/note`) return send(res, 201, { ok: true, event_id: 'evt-1' });
    if (p.startsWith(`${B}/pictures`)) {
      st.pictureCalls.push({ m, p, body });
      if (m === 'GET' && p === `${B}/pictures`) return send(res, 200, st.pictures);
      if (m === 'PUT' && p === `${B}/pictures/style`) { st.pictures.style = body.style; return send(res, 200, { ok: true, style: body.style }); }
      if (m === 'POST' && p === `${B}/pictures/illustrate`) return st.pictures.chapters.some((c) => c.chapter_id === body.chapter_id) ? send(res, 202, { job_id: 'job-ill', pic_id: 'pic-002' }) : send(res, 404, { errors: [{ code: 'NOT_FOUND', message: 'no chapter' }] });
      if (m === 'POST' && p === `${B}/pictures/illustrate-all`) return send(res, 202, { job_id: 'job-all' });
      if (m === 'POST' && p === `${B}/pictures/map`) return body.kind === 'svg' ? send(res, 200, { ok: true, map: { kind: 'svg' } }) : send(res, 202, { job_id: 'job-map' });
      const pm = /^\/api\/projects\/proj-1\/branches\/main\/pictures\/(pic-\d+)$/.exec(p);
      if (pm && m === 'PUT') return send(res, 200, Object.assign({ pic_id: pm[1] }, body));
      if (pm && m === 'DELETE') return send(res, 200, { ok: true });
      return send(res, 404, { errors: [{ code: 'NOT_FOUND', message: 'no such pictures endpoint' }] });
    }
    const D = st.dossier;
    if (m === 'GET' && p === `${B}/forge/characters`) return send(res, 200, { characters: [{ record_id: D.record_id, name: D.name, kind: 'character', code: D.code, revision: D.revision, readiness: D.readiness, has_portrait: !!D.art.portrait, views_done: Object.keys(D.art.views).length }] });
    mm = /^\/api\/projects\/proj-1\/branches\/main\/forge\/characters\/([^/]+)(?:\/(forge|approve|art))?$/.exec(p);
    if (mm && mm[1] !== D.record_id) return send(res, 404, { errors: [{ code: 'NOT_FOUND', message: 'no such dossier' }] });
    if (mm && m === 'GET' && !mm[2]) return send(res, 200, D);
    if (mm && m === 'PUT' && !mm[2]) {
      for (const [sk, fields] of Object.entries((body && body.sections) || {})) {
        const sec = D.sections.find((x) => x.key === sk); if (!sec) return send(res, 400, { errors: [{ code: 'UNKNOWN_SECTION', message: sk }] });
        for (const [fk, v] of Object.entries(fields)) { const f = sec.fields.find((x) => x.key === fk); if (!f) return send(res, 400, { errors: [{ code: 'UNKNOWN_FIELD', message: fk }] }); f.text = v.text; f.status = 'supplied'; if (v.protected) f.protected = true; }
      }
      D.revision += 1; return send(res, 200, { ok: true, revision: D.revision });
    }
    if (mm && m === 'POST' && mm[2]) {
      st.forgeCalls.push({ kind: mm[2], body });
      if (mm[2] === 'approve') { for (const s2 of D.sections) for (const f of s2.fields) if (f.status === 'proposed' && f.text && (body.all || (body.fields || []).includes(f.key))) f.status = 'approved'; D.revision += 1; D.readiness = D.sections.every((s2) => s2.fields.every((f) => f.status !== 'proposed' || !f.text)) ? 'ready' : 'draft'; return send(res, 200, { ok: true, message: 'Approved.', readiness: D.readiness, revision: D.revision }); }
      return send(res, 202, { job_id: `job-${mm[2]}` });
    }
    return send(res, 404, { errors: [{ code: 'NOT_FOUND', message: 'no such endpoint' }] });
  });
  const port = await listen(server);
  return { port, base: `http://127.0.0.1:${port}`, requests, state: st, close: () => new Promise((r) => server.close(() => r())) };
}

module.exports = { fakeLlm, fakeSd, fakeAkowe, toolCall, lastMsg, lastUser, PNG_1PX, listen };
