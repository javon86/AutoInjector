'use strict';
/*
 * alfred-tools.js — Alfred's FIXED tool registry (direct controls, never free code).
 *
 * Every tool has:
 *   name         unique id the AI names in a tool call
 *   title        a short fixed title (this is what the activity log records — never arguments)
 *   group        books | images | video | ais | files | code
 *   description  one plain sentence the AI reads to know when to use it
 *   args         a JSON schema (type:object) — validated before anything runs
 *   changes      true = it changes or creates something -> shown on an "I will: …" card first
 *   allowAlways  the user may tick "always allow" for it (harmless ones only)
 *   describe(a)  the "I will: …" line for the card (plain English)
 *   run(a, ctx)  calls existing app code through ctx (injected by main.js; fakes in tests)
 *
 * Nothing here talks to the network or Electron directly: ctx carries the app's own functions
 * (Akọwe's API with the token AutoInjector already holds, the image adapter, the AI panes, the
 * output folder, log extract, Open Interpreter). That keeps the registry testable with fakes.
 */

const SITES = ['chatgpt', 'claude', 'gemini'];
const SITE_LABEL = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' };
const LENGTHS = ['short_story', 'novelette', 'novella', 'novel'];
const RULE_KINDS = ['hard_rule', 'seen', 'belief', 'mystery'];
const DETAIL_KINDS = ['work', 'weather', 'institution', 'people', 'economy'];
const PROFILE_KEYS = ['title', 'author', 'genre', 'audience', 'length', 'tone', 'idea', 'chapters'];
const AKOWE_PAGES = { book: 'book', report: 'report', grid: 'grid', journal: 'journal', world: 'world', review: 'review', forge: 'forge', pictures: 'pictures', cover: 'cover', home: null, shelf: null };
const OUTPUT_CATEGORIES = ['images', 'videos', 'books', 'logs', 'uploads'];

// ----------------------------------------------------------------------------- small helpers
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').slice(0, n || 400);
const clip = (v, n) => { const s = str(v, 100000); return s.length > n ? `${s.slice(0, n)}…` : s; };
function q(v) { return `“${clip(v, 120)}”`; }

/** Akọwe answered with {errors:[{code,message,fix}]} or a transport problem -> one plain sentence. */
function akoweError(r) {
  if (!r) return { ok: false, error: 'NO_ANSWER', message: "Akọwe didn't answer." };
  if (r.error === 'NOT_READY' || r.status === 0) {
    return { ok: false, error: 'AKOWE_NOT_READY', message: "Akọwe isn't running right now (see the 📖 Akọwe tab). Everything else still works." };
  }
  const e = r.json && Array.isArray(r.json.errors) && r.json.errors[0];
  if (e) return { ok: false, error: str(e.code, 40) || `HTTP_${r.status}`, message: `Akọwe said: ${clip(e.message || e.code, 300)}${e.fix ? ` — ${clip(e.fix, 200)}` : ''}` };
  return { ok: false, error: `HTTP_${r.status}`, message: `Akọwe answered with an error (HTTP ${r.status}).` };
}
const okStatus = (r) => r && r.status >= 200 && r.status < 300;
const enc = encodeURIComponent;

/** The book to act on: the one named, else the current run's book, else the only / newest book. */
async function resolveBook(ctx, a) {
  if (a && a.project_id) return { ok: true, pid: String(a.project_id) };
  const runs = await ctx.akowe('GET', '/api/autobook');
  if (okStatus(runs) && runs.json) {
    const act = (runs.json.active || [])[0];
    if (act && act.project_id) return { ok: true, pid: act.project_id };
  }
  const list = await ctx.akowe('GET', '/api/projects');
  if (!okStatus(list)) return akoweError(list);
  const books = Array.isArray(list.json) ? list.json : [];
  if (!books.length) return { ok: false, error: 'NO_BOOK', message: 'There are no books in Akọwe yet. Ask me to make one ("make a book for me about …").' };
  if (books.length === 1) return { ok: true, pid: books[0].project_id };
  const newest = books.slice().sort((x, y) => String(y.last_opened_at || y.updated_at || y.created_at || '').localeCompare(String(x.last_opened_at || x.updated_at || x.created_at || '')))[0];
  return { ok: true, pid: newest.project_id, guessed: true };
}
async function resolveRun(ctx, a) {
  const runs = await ctx.akowe('GET', '/api/autobook');
  if (!okStatus(runs)) return akoweError(runs);
  if (a && a.run_id) return { ok: true, runId: String(a.run_id) };
  const j = runs.json || {};
  const act = (j.active || [])[0] || (j.runs || []).find((r) => ['paused', 'interrupted', 'running', 'waiting', 'pausing', 'queued'].includes(r.status));
  if (!act) return { ok: false, error: 'NO_RUN', message: 'No “Make a book for me” run is going right now.' };
  return { ok: true, runId: act.id, run: act };
}
function runBrief(r) {
  if (!r) return null;
  return {
    run_id: r.id, status: r.status, phase: clip(r.phase, 160), title: clip(r.title || '', 160), project_id: r.project_id || null,
    steps: (r.steps || []).map((s) => ({ title: clip(s.title, 80), state: s.state })),
    recent_events: (r.events || []).slice(-8).map((e) => clip(e.message, 200)),
    problem: r.problem ? { code: r.problem.code || null, message: clip(r.problem.message, 300), options: r.problem.options || null } : null,
    needs_decision: r.status === 'paused' && !!(r.problem && r.problem.record_id),
  };
}

// ----------------------------------------------------------------------------- the registry
const TOOLS = [];
function def(t) { TOOLS.push(Object.freeze(Object.assign({ changes: false, allowAlways: false, timeoutMs: 60000 }, t))); }

// ---- 📖 Akọwe / books -------------------------------------------------------------------------
def({
  name: 'book_status', title: 'Book status', group: 'books',
  description: 'Status of the books in Akọwe and the current "Make a book for me" run: checklist steps, recent events, the AIs\' health and any problems. Read-only.',
  args: { type: 'object', properties: { project_id: { type: 'string', maxLength: 80, description: 'Which book (optional; default: the current one)' } }, additionalProperties: false },
  async run(a, ctx) {
    const out = { books: [], run: null, checklist: null, ais: null, problems: [] };
    const list = await ctx.akowe('GET', '/api/projects');
    if (!okStatus(list)) return akoweError(list);
    out.books = (Array.isArray(list.json) ? list.json : []).slice(0, 12).map((b) => ({ project_id: b.project_id, title: clip(b.name || b.title || b.project_id, 120) }));
    const runs = await ctx.akowe('GET', '/api/autobook');
    if (okStatus(runs) && runs.json) out.run = runBrief((runs.json.active || [])[0] || (runs.json.runs || [])[0]);
    const slots = await ctx.akowe('GET', '/api/slots/states');
    if (okStatus(slots) && slots.json) out.ais = (slots.json.slots || []).map((s) => ({ slot: s.slot_id, name: clip(s.name, 40), state: s.state, word: clip(s.word, 60) }));
    if (!out.books.length) { out.note = 'No books yet.'; return { ok: true, data: out }; }
    const b = await resolveBook(ctx, a);
    if (b.ok) {
      const st = await ctx.akowe('GET', `/api/projects/${enc(b.pid)}/branches/main/book`);
      if (okStatus(st) && st.json) {
        out.checklist = { project_id: b.pid, steps: (st.json.steps || []).map((s) => ({ title: clip(s.title, 80), state: s.state, chapters: Array.isArray(s.chapters) ? s.chapters.map((c) => ({ chapter_id: c.chapter_id, state: c.state })) : undefined })) };
      }
      const j = await ctx.akowe('GET', `/api/projects/${enc(b.pid)}/branches/main/journal?problems=1`);
      if (okStatus(j) && j.json) out.problems = (j.json.entries || []).slice(-6).map((e) => clip(e.what || (e.problem && e.problem.message), 200));
    }
    return { ok: true, data: out };
  },
});
def({
  name: 'list_books', title: 'List books', group: 'books',
  description: 'List the books in Akọwe (id and title). Read-only.',
  args: { type: 'object', properties: {}, additionalProperties: false },
  async run(_a, ctx) {
    const r = await ctx.akowe('GET', '/api/projects');
    if (!okStatus(r)) return akoweError(r);
    return { ok: true, data: (Array.isArray(r.json) ? r.json : []).map((b) => ({ project_id: b.project_id, title: clip(b.name || b.project_id, 120) })) };
  },
});
def({
  name: 'start_book', title: 'Start "Make a book for me"', group: 'books', changes: true, book: true,
  description: 'Start Akọwe\'s "⚡ Make a book for me" run for a new book from an idea. Pressing Do it on the card is the author\'s consent for this one run.',
  args: { type: 'object', required: ['idea'], properties: {
    idea: { type: 'string', minLength: 3, maxLength: 2000, description: 'The idea in a few sentences' },
    genre: { type: 'string', maxLength: 120 },
    length: { type: 'string', enum: LENGTHS },
  }, additionalProperties: false },
  describe: (a) => `Start ⚡ Make a book for me in Akọwe — idea ${q(a.idea)}${a.genre ? `, genre ${q(a.genre)}` : ''}${a.length ? `, length ${a.length.replace('_', ' ')}` : ''}. (Your ✔ Do it is your consent for this one run, as if you pressed the button in Akọwe.)`,
  async run(a, ctx) {
    const body = { idea: a.idea, author_confirms: true };
    if (a.genre) body.genre = a.genre;
    if (a.length) body.length = a.length;
    const r = await ctx.akowe('POST', '/api/autobook', body);
    if (!okStatus(r)) return akoweError(r);
    return { ok: true, message: 'The run started. I will tell you when it pauses or finishes.', data: runBrief(r.json), project_id: r.json && r.json.project_id };
  },
});
for (const [verb, label] of [['pause', 'Pause'], ['resume', 'Resume'], ['cancel', 'Cancel']]) {
  def({
    name: `${verb}_run`, title: `${label} the book run`, group: 'books', changes: true, book: true,
    description: `${label} the current "Make a book for me" run${verb === 'resume' ? ' (it never approves anything you have to decide; a paused decision stays yours)' : ''}.`,
    args: { type: 'object', properties: { run_id: { type: 'string', maxLength: 80 } }, additionalProperties: false },
    describe: (a) => `${label} the Make-a-book run${a.run_id ? ` ${a.run_id}` : ' that is going now'}.`,
    async run(a, ctx) {
      const rr = await resolveRun(ctx, a);
      if (!rr.ok) return rr;
      const r = await ctx.akowe('POST', `/api/autobook/${enc(rr.runId)}/${verb}`, {});
      if (!okStatus(r)) return akoweError(r);
      return { ok: true, data: runBrief(r.json), project_id: r.json && r.json.project_id };
    },
  });
}
def({
  name: 'edit_profile', title: 'Edit book profile', group: 'books', changes: true, book: true,
  description: 'Change the book profile (title, author, genre, audience, length, tone, idea, chapters) and/or the story choices (ending and style choices).',
  args: { type: 'object', properties: {
    project_id: { type: 'string', maxLength: 80 },
    title: { type: 'string', minLength: 1, maxLength: 200 }, author: { type: 'string', maxLength: 200 }, genre: { type: 'string', maxLength: 120 },
    audience: { type: 'string', maxLength: 120 }, length: { type: 'string', enum: LENGTHS }, tone: { type: 'string', maxLength: 200 },
    idea: { type: 'string', maxLength: 4000 }, chapters: { type: 'integer', minimum: 1, maximum: 60 },
    choices: { type: 'object', description: 'Story choices, e.g. {"ending": "...", "pov": "..."}' },
  }, additionalProperties: false },
  describe: (a) => {
    const keys = PROFILE_KEYS.filter((k) => a[k] !== undefined).map((k) => `${k} → ${q(a[k])}`);
    if (a.choices) keys.push(`story choices → ${clip(JSON.stringify(a.choices), 160)}`);
    return `Change the book profile${a.project_id ? ` of ${a.project_id}` : ''}: ${keys.join(', ') || '(nothing)'}.`;
  },
  async run(a, ctx) {
    const b = await resolveBook(ctx, a);
    if (!b.ok) return b;
    const body = {};
    for (const k of PROFILE_KEYS) if (a[k] !== undefined) body[k] = a[k];
    if (a.choices) body.choices = a.choices;
    if (!Object.keys(body).length) return { ok: false, error: 'NOTHING_TO_CHANGE', message: 'Tell me what to change in the profile.' };
    const r = await ctx.akowe('PUT', `/api/projects/${enc(b.pid)}/profile`, body);
    if (!okStatus(r)) return akoweError(r);
    return { ok: true, message: 'Saved the book profile.', project_id: b.pid };
  },
});
def({
  name: 'edit_character', title: 'Edit character sheet / voice card', group: 'books', changes: true, book: true,
  description: 'Change fields of a character\'s sheet (e.g. wants, needs, fear, secret, role) and/or voice card (e.g. rhythm, register, vocabulary, phrases). Other fields are kept.',
  args: { type: 'object', required: ['character'], properties: {
    project_id: { type: 'string', maxLength: 80 },
    character: { type: 'string', minLength: 1, maxLength: 120, description: 'The character\'s name or record id' },
    sheet: { type: 'object', description: 'Sheet fields to set' },
    voice: { type: 'object', description: 'Voice-card fields to set' },
  }, additionalProperties: false },
  describe: (a) => `Update ${q(a.character)}'s ${[a.sheet && `sheet (${Object.keys(a.sheet).join(', ')})`, a.voice && `voice card (${Object.keys(a.voice).join(', ')})`].filter(Boolean).join(' and ') || 'sheet'}; everything else on it stays.`,
  async run(a, ctx) {
    if (!a.sheet && !a.voice) return { ok: false, error: 'NOTHING_TO_CHANGE', message: 'Tell me which sheet or voice-card fields to change.' };
    const b = await resolveBook(ctx, a);
    if (!b.ok) return b;
    const base = `/api/projects/${enc(b.pid)}/branches/main/review/characters`;
    const list = await ctx.akowe('GET', base);
    if (!okStatus(list)) return akoweError(list);
    const want = String(a.character).trim().toLowerCase();
    const chars = (list.json && list.json.characters) || [];
    const c = chars.find((x) => x.record_id === a.character) || chars.find((x) => String(x.name || '').toLowerCase() === want) || chars.find((x) => String(x.name || '').toLowerCase().includes(want));
    if (!c) return { ok: false, error: 'NO_CHARACTER', message: `I couldn't find a character called ${q(a.character)}. Characters: ${chars.map((x) => x.name).join(', ') || 'none yet'}.` };
    const body = { version: c.version || 0 };
    if (a.sheet) body.sheet = Object.assign({}, c.sheet || {}, a.sheet);
    if (a.voice) body.voice = Object.assign({}, c.voice || {}, a.voice);
    const r = await ctx.akowe('PUT', `${base}/${enc(c.record_id)}`, body);
    if (!okStatus(r)) return akoweError(r);
    return { ok: true, message: clip((r.json && r.json.message) || 'Saved.', 200), project_id: b.pid };
  },
});
def({
  name: 'add_story_rule', title: 'Add / edit a story rule', group: 'books', changes: true, book: true,
  description: 'Add a story rule (or change one by its id) in the book\'s story-rules ledger. Categories: hard_rule, seen, belief, mystery.',
  args: { type: 'object', required: ['text'], properties: {
    project_id: { type: 'string', maxLength: 80 },
    text: { type: 'string', minLength: 3, maxLength: 400 },
    category: { type: 'string', enum: RULE_KINDS },
    scope: { type: 'string', maxLength: 400 },
    rule_id: { type: 'string', maxLength: 24, description: 'Only to change an existing rule' },
  }, additionalProperties: false },
  describe: (a) => `${a.rule_id ? `Change story rule ${a.rule_id} to` : 'Add the story rule'} ${q(a.text)} (${(a.category || 'hard_rule').replace('_', ' ')}).`,
  async run(a, ctx) {
    const b = await resolveBook(ctx, a);
    if (!b.ok) return b;
    const w = await ctx.akowe('GET', `/api/projects/${enc(b.pid)}/branches/main/review/world`);
    if (!okStatus(w)) return akoweError(w);
    const entry = (w.json && w.json.rules) || null;
    const rules = (entry && Array.isArray(entry.rules) ? entry.rules : []).map((r) => Object.assign({}, r));
    const rule = { category: a.category || 'hard_rule', text: a.text };
    if (a.scope) rule.scope = a.scope;
    if (a.rule_id) {
      const i = rules.findIndex((r) => r.id === a.rule_id);
      if (i < 0) return { ok: false, error: 'NO_RULE', message: `There is no story rule ${a.rule_id}.` };
      rules[i] = Object.assign(rules[i], rule);
    } else rules.push(rule);
    const body = { rules };
    if (entry && entry.version) body.version = entry.version;
    const r = await ctx.akowe('PUT', `/api/projects/${enc(b.pid)}/branches/main/review/world/rules`, body);
    if (!okStatus(r)) return akoweError(r);
    return { ok: true, message: clip((r.json && r.json.message) || 'Saved.', 200), project_id: b.pid };
  },
});
def({
  name: 'add_world_detail', title: 'Add / edit a world detail', group: 'books', changes: true, book: true,
  description: 'Add a world-texture detail (a concrete tool, rule, person, price… of this world) or change one by its id.',
  args: { type: 'object', required: ['detail'], properties: {
    project_id: { type: 'string', maxLength: 80 },
    detail: { type: 'string', minLength: 3, maxLength: 200 },
    kind: { type: 'string', enum: DETAIL_KINDS },
    effect: { type: 'string', maxLength: 200 },
    item_id: { type: 'string', maxLength: 24, description: 'Only to change an existing detail' },
  }, additionalProperties: false },
  describe: (a) => `${a.item_id ? `Change world detail ${a.item_id} to` : 'Add the world detail'} ${q(a.detail)}${a.effect ? ` (what it can cause: ${q(a.effect)})` : ''}.`,
  async run(a, ctx) {
    const b = await resolveBook(ctx, a);
    if (!b.ok) return b;
    const w = await ctx.akowe('GET', `/api/projects/${enc(b.pid)}/branches/main/review/world`);
    if (!okStatus(w)) return akoweError(w);
    const entry = (w.json && w.json.texture) || null;
    const items = (entry && Array.isArray(entry.items) ? entry.items : []).map((x) => Object.assign({}, x));
    const it = { detail: a.detail };
    if (a.kind) it.kind = a.kind;
    if (a.effect) it.effect = a.effect;
    if (a.item_id) {
      const i = items.findIndex((x) => x.id === a.item_id);
      if (i < 0) return { ok: false, error: 'NO_DETAIL', message: `There is no world detail ${a.item_id}.` };
      items[i] = Object.assign(items[i], it);
    } else items.push(it);
    const body = { items };
    if (entry && entry.version) body.version = entry.version;
    const r = await ctx.akowe('PUT', `/api/projects/${enc(b.pid)}/branches/main/review/world/texture`, body);
    if (!okStatus(r)) return akoweError(r);
    return { ok: true, message: clip((r.json && r.json.message) || 'Saved.', 200), project_id: b.pid };
  },
});
def({
  name: 'rewrite_chapter', title: 'Ask for a chapter rewrite', group: 'books', changes: true, book: true,
  description: 'Ask the AI to revise a chapter draft that waits for approval, following a note. The new version waits for your approval in Akọwe (nothing is approved for you).',
  args: { type: 'object', required: ['chapter', 'note'], properties: {
    project_id: { type: 'string', maxLength: 80 },
    chapter: { type: 'string', minLength: 1, maxLength: 40, description: 'Chapter id (e.g. ch3) or number' },
    note: { type: 'string', minLength: 3, maxLength: 1000 },
  }, additionalProperties: false },
  describe: (a) => `Ask the AI to rewrite chapter ${q(a.chapter)} with your note ${q(a.note)}. The new version waits for your approval in Akọwe.`,
  async run(a, ctx) {
    const b = await resolveBook(ctx, a);
    if (!b.ok) return b;
    const st = await ctx.akowe('GET', `/api/projects/${enc(b.pid)}/branches/main/book`);
    if (!okStatus(st)) return akoweError(st);
    const step = ((st.json && st.json.steps) || []).find((s) => s.id === 'chapters');
    const chapters = (step && step.chapters) || [];
    const want = String(a.chapter).trim().toLowerCase();
    const n = Number(want.replace(/[^0-9]/g, ''));
    const ch = chapters.find((c) => String(c.chapter_id).toLowerCase() === want) || (Number.isFinite(n) && n > 0 ? chapters[n - 1] : null);
    if (!ch) return { ok: false, error: 'NO_CHAPTER', message: `I couldn't find chapter ${q(a.chapter)}. Chapters: ${chapters.map((c) => c.chapter_id).join(', ') || 'none yet'}.` };
    const draft = ch.prose && ch.prose.lifecycle && ['DRAFT', 'VALIDATED'].includes(ch.prose.lifecycle) ? ch.prose : null;
    if (!draft) return { ok: false, error: ch.approved ? 'CHAPTER_APPROVED' : 'NO_DRAFT', message: ch.approved ? `Chapter ${ch.chapter_id} is already approved. To change it, open it in Akọwe and edit it (a rewrite of an approved chapter is your call there).` : `Chapter ${ch.chapter_id} has no draft yet to rewrite.` };
    const r = await ctx.akowe('POST', `/api/projects/${enc(b.pid)}/branches/main/review/fix`, { record_id: draft.record_id, note: a.note });
    if (!okStatus(r)) return akoweError(r);
    return { ok: true, message: `The AI is rewriting chapter ${ch.chapter_id}; the new version will wait for your approval.`, project_id: b.pid };
  },
});
def({
  name: 'open_akowe_page', title: 'Open an Akọwe page', group: 'books',
  description: 'Show a page of the book in the 📖 Akọwe tab: book (checklist), report, grid (scene grid), journal, world, review, forge (Character Forge dossiers; with "character" that dossier), or home/shelf. Read-only (it only changes what is shown).',
  args: { type: 'object', required: ['page'], properties: {
    page: { type: 'string', enum: Object.keys(AKOWE_PAGES) },
    project_id: { type: 'string', maxLength: 80 },
    character: { type: 'string', maxLength: 120, description: 'Only with page "forge": open this character\'s dossier' },
  }, additionalProperties: false },
  async run(a, ctx) {
    let hash = a.page === 'shelf' ? '#/shelf' : '#/';
    if (a.page === 'forge' && a.character) {
      const r = await resolveDossier(ctx, a);
      if (!r.ok) return r;
      hash = `#/p/${enc(r.pid)}/main/forge/${enc(r.d.record_id)}`;
    } else if (AKOWE_PAGES[a.page]) {
      const b = await resolveBook(ctx, a);
      if (!b.ok) return b;
      hash = `#/p/${enc(b.pid)}/main/${AKOWE_PAGES[a.page]}`;
    }
    const r = await ctx.openAkowePage(hash);
    return r && r.ok ? { ok: true, message: `Showing the ${a.page} page in the 📖 Akọwe tab.` } : { ok: false, error: (r && r.error) || 'OPEN_FAILED', message: "I couldn't show that page — is Akọwe running (📖 Akọwe tab)?" };
  },
});
// ---- 🗂 Character Forge dossiers (Akọwe; the dark "Moki Vey" look) --------------------------------------
const FORGE_VIEWS = ['front', 'three_quarter_front', 'side', 'three_quarter_back', 'back', 'idle', 'draw', 'attack', 'dash', 'defend'];
const IMAGE_ENGINES = ['auto', 'sd', 'chatgpt'];
// Dossier kinds: characters (CH-), items (AR-), places (PL-), magic systems (MG-). A code picks its own kind.
const FORGE_KINDS = ['characters', 'items', 'places', 'magic'];
const KIND_WORD = { characters: 'character', items: 'item', places: 'place', magic: 'magic system' };
const KIND_OF_CODE = { CH: 'characters', AR: 'items', PL: 'places', MG: 'magic' };
const KIND_ARG = { type: 'string', enum: FORGE_KINDS, description: 'characters (default), items, places or magic (magic systems); a code like AR-001 picks its kind' };
function kindOf(a) {
  const m = /^(CH|AR|PL|MG)-\d+$/i.exec(String((a && (a.character || a.name)) || '').trim());
  return m ? KIND_OF_CODE[m[1].toUpperCase()] : (a && a.kind) || 'characters';
}
/** The book + the dossier entry (by name, record id or code) of one kind. -> { pid, kp (path part), list, d } */
async function resolveDossier(ctx, a) {
  const b = await resolveBook(ctx, a);
  if (!b.ok) return b;
  const kp = kindOf(a); const word = KIND_WORD[kp] || 'character';
  const list = await ctx.akowe('GET', `/api/projects/${enc(b.pid)}/branches/main/forge/${kp}`);
  if (!okStatus(list)) return akoweError(list);
  const all = (list.json && (list.json[kp] || list.json.characters || list.json.dossiers || (Array.isArray(list.json) ? list.json : null))) || [];
  if (!a.character) return { ok: true, pid: b.pid, kp, list: all, candidates: (list.json && list.json.candidates) || [] };
  const want = String(a.character).trim().toLowerCase();
  const d = all.find((x) => x.record_id === a.character || String(x.code || '').toLowerCase() === want)
    || all.find((x) => String(x.name || '').toLowerCase() === want) || all.find((x) => String(x.name || '').toLowerCase().includes(want));
  if (!d) return { ok: false, error: kp === 'characters' ? 'NO_CHARACTER' : 'NO_DOSSIER', message: `I couldn't find a ${word} called ${q(a.character)}. ${word[0].toUpperCase()}${word.slice(1)}s: ${all.map((x) => x.name).join(', ') || 'none yet'}.` };
  return { ok: true, pid: b.pid, kp, list: all, d };
}
function dossierBrief(j) {
  if (!j) return null;
  const fields = []; for (const s of j.sections || []) for (const f of s.fields || []) fields.push(f);
  const by = (st) => fields.filter((f) => f.status === st && str(f.text, 1)).length;
  const art = j.art || {}; const views = art.views || {};
  return {
    record_id: j.record_id, name: j.name, code: j.code, revision: j.revision, readiness: j.readiness, tagline: clip(j.tagline, 120),
    fields: { filled: fields.filter((f) => str(f.text, 1)).length, empty: fields.filter((f) => !str(f.text, 1)).length, proposed: by('proposed'), approved: by('approved'), supplied: by('supplied') },
    sections: (j.sections || []).map((s) => ({ n: s.n, title: s.title, proposed: (s.fields || []).filter((f) => f.status === 'proposed').map((f) => f.key) })),
    art: { portrait: !!art.portrait, sheet: !!art.sheet, views_done: FORGE_VIEWS.filter((v) => views[v]), views_missing: FORGE_VIEWS.filter((v) => !views[v]) },
  };
}
def({
  name: 'character_dossier', title: 'Character Forge: read a dossier', group: 'books', book: true,
  description: 'Read Character Forge dossiers (deep character profiles with portrait + ten-view art): without "character" the list; with it that dossier\'s state (filled / proposed fields per section, readiness, which art exists). With "section" also that section\'s text.',
  args: { type: 'object', properties: {
    project_id: { type: 'string', maxLength: 80 },
    kind: KIND_ARG,
    character: { type: 'string', maxLength: 120, description: 'Name, record id or code (CH-001)' },
    section: { type: 'string', maxLength: 60, description: 'Optional: a section number or title to read in full' },
  }, additionalProperties: false },
  async run(a, ctx) {
    const r = await resolveDossier(ctx, a);
    if (!r.ok) return r;
    if (!r.d) return { ok: true, message: `${r.list.length} dossier(s).`, data: { project_id: r.pid, dossiers: r.list.slice(0, 40).map((x) => ({ name: x.name, code: x.code, readiness: x.readiness, has_portrait: !!x.has_portrait, views_done: x.views_done })) } };
    const g = await ctx.akowe('GET', `/api/projects/${enc(r.pid)}/branches/main/forge/${r.kp}/${enc(r.d.record_id)}`);
    if (!okStatus(g)) return akoweError(g);
    const data = dossierBrief(g.json);
    if (a.section) {
      const want = String(a.section).trim().toLowerCase();
      const s = (g.json.sections || []).find((x) => String(x.n) === want.replace(/^0+/, '') || String(x.title || '').toLowerCase().includes(want) || x.key === want);
      if (s) data.section = { n: s.n, title: s.title, fields: (s.fields || []).map((f) => ({ key: f.key, label: f.label, letters: f.letters, status: f.status, protected: !!f.protected, text: clip(f.text, 600) })) };
      else data.section_missing = `No section ${q(a.section)}.`;
    }
    return { ok: true, message: `${data.name} (${data.code}, ${data.readiness}).`, data };
  },
});
def({
  name: 'forge_character', title: 'Character Forge: invent the rest', group: 'books', changes: true, book: true,
  description: 'Fill a character\'s empty dossier fields with AI proposals (appearance, inner life, voice, fighting, powers, skills, backstory, storyline, continuity…). Supplied and protected text is never changed; everything new is a PROPOSAL the author approves. Runs in the background.',
  args: { type: 'object', required: ['character'], properties: {
    project_id: { type: 'string', maxLength: 80 },
    kind: KIND_ARG,
    character: { type: 'string', minLength: 1, maxLength: 120 },
  }, additionalProperties: false },
  describe: (a) => `Let the book's AI fill ${q(a.character)}'s empty dossier fields as proposals (nothing you wrote or protected changes; you approve each proposal).`,
  async run(a, ctx) {
    const r = await resolveDossier(ctx, a);
    if (!r.ok) return r;
    const p = await ctx.akowe('POST', `/api/projects/${enc(r.pid)}/branches/main/forge/${r.kp}/${enc(r.d.record_id)}/forge`, {});
    if (!okStatus(p)) return akoweError(p);
    return { ok: true, message: `Inventing the rest of ${r.d.name}'s dossier in the background. The new details arrive as proposals for you to approve.`, data: { job_id: p.json && p.json.job_id, project_id: r.pid } };
  },
});
def({
  name: 'approve_dossier', title: 'Character Forge: approve proposals', group: 'books', changes: true, book: true,
  description: 'Approve proposed dossier fields (all, or the listed field keys). Approved details become part of the character.',
  args: { type: 'object', required: ['character'], properties: {
    project_id: { type: 'string', maxLength: 80 },
    kind: KIND_ARG,
    character: { type: 'string', minLength: 1, maxLength: 120 },
    fields: { type: 'array', maxItems: 120, items: { type: 'string', maxLength: 60 }, description: 'Field keys; leave out to approve every proposal' },
  }, additionalProperties: false },
  describe: (a) => (a.fields && a.fields.length ? `Approve ${a.fields.length} proposed field(s) on ${q(a.character)}'s dossier: ${a.fields.slice(0, 8).join(', ')}${a.fields.length > 8 ? '…' : ''}.` : `Approve EVERY proposed field on ${q(a.character)}'s dossier.`),
  async run(a, ctx) {
    const r = await resolveDossier(ctx, a);
    if (!r.ok) return r;
    const p = await ctx.akowe('POST', `/api/projects/${enc(r.pid)}/branches/main/forge/${r.kp}/${enc(r.d.record_id)}/approve`, a.fields && a.fields.length ? { fields: a.fields } : { all: true });
    if (!okStatus(p)) return akoweError(p);
    return { ok: true, message: clip((p.json && p.json.message) || 'Approved.', 200), data: { readiness: p.json && p.json.readiness, revision: p.json && p.json.revision } };
  },
});
def({
  name: 'edit_dossier', title: 'Character Forge: edit dossier fields', group: 'books', changes: true, book: true,
  description: 'Write dossier fields yourself (the author\'s words, status "supplied"). fields = { "<field_key>": "text" } — keys from character_dossier with "section".',
  args: { type: 'object', required: ['character', 'fields'], properties: {
    project_id: { type: 'string', maxLength: 80 },
    kind: KIND_ARG,
    character: { type: 'string', minLength: 1, maxLength: 120 },
    fields: { type: 'object', description: 'field_key -> new text (max 1200 characters each)' },
    protect: { type: 'boolean', description: 'Also lock these fields so "invent the rest" never changes them' },
  }, additionalProperties: false },
  describe: (a) => `Set ${Object.keys(a.fields || {}).length} field(s) on ${q(a.character)}'s dossier (${Object.keys(a.fields || {}).slice(0, 6).join(', ')})${a.protect ? ' and lock them' : ''}.`,
  async check(a) {
    const keys = Object.keys(a.fields || {});
    if (!keys.length || keys.length > 60) return { ok: false, error: 'give 1–60 fields' };
    for (const k of keys) { if (!/^[a-z0-9_]{1,60}$/.test(k)) return { ok: false, error: `"${str(k, 40)}" is not a field key` }; if (typeof a.fields[k] !== 'string' || a.fields[k].length > 1200) return { ok: false, error: `${k} must be text up to 1200 characters` }; }
    return { ok: true };
  },
  async run(a, ctx) {
    const r = await resolveDossier(ctx, a);
    if (!r.ok) return r;
    const g = await ctx.akowe('GET', `/api/projects/${enc(r.pid)}/branches/main/forge/${r.kp}/${enc(r.d.record_id)}`);
    if (!okStatus(g)) return akoweError(g);
    const where = {}; for (const s of (g.json && g.json.sections) || []) for (const f of s.fields || []) where[f.key] = s.key;
    const unknown = Object.keys(a.fields).filter((k) => !where[k]);
    if (unknown.length) return { ok: false, error: 'UNKNOWN_FIELD', message: `The dossier has no field ${unknown.map(q).join(', ')}. Ask character_dossier with a section to see the keys.` };
    const sections = {};
    for (const [k, text] of Object.entries(a.fields)) { sections[where[k]] = sections[where[k]] || {}; sections[where[k]][k] = Object.assign({ text }, a.protect ? { protected: true } : {}); }
    const p = await ctx.akowe('PUT', `/api/projects/${enc(r.pid)}/branches/main/forge/${r.kp}/${enc(r.d.record_id)}`, { sections });
    if (!okStatus(p)) return akoweError(p);
    return { ok: true, message: `Saved ${Object.keys(a.fields).length} field(s) on ${r.d.name}'s dossier.` };
  },
});
def({
  name: 'make_character_art', title: 'Character Forge: make the portrait / ten views', group: 'books', changes: true, book: true,
  description: 'Make a character\'s dossier art: the portrait, a short motion clip (what="clip": the portrait brought to life with the 🎬 Video module), any of the ten full-body reference views (front, three_quarter_front, side, three_quarter_back, back, idle, draw, attack, dash, defend), or one turnaround sheet. engine: "sd" = Stable Diffusion (uses the character lock), "chatgpt" = ChatGPT draws it in its pane, "auto" = SD when connected, else ChatGPT. Runs in the background; pictures are saved into the book.',
  args: { type: 'object', required: ['character', 'what'], properties: {
    project_id: { type: 'string', maxLength: 80 },
    kind: KIND_ARG,
    character: { type: 'string', minLength: 1, maxLength: 120 },
    what: { type: 'string', enum: ['portrait', 'views', 'sheet', 'clip', 'hero'], description: 'Characters: portrait / views / sheet / clip. Items, places, magic: hero (item portrait / establishing shot / sigil) or views' },
    engine: { type: 'string', enum: IMAGE_ENGINES },
    views: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 }, description: 'Only with what="views": which ones (default: the missing ones). Characters: front … defend; items: front, side, back, detail; places: day, night, interior; magic: in_use' },
  }, additionalProperties: false },
  describe: (a) => {
    const eng = { sd: 'Stable Diffusion', chatgpt: 'ChatGPT', auto: 'Stable Diffusion if connected, else ChatGPT' }[a.engine || 'auto'];
    const what = a.what === 'clip' ? 'a short motion clip (the portrait brought to life, 🎬 Video module)' : a.what === 'portrait' ? 'the portrait' : a.what === 'sheet' ? 'one turnaround sheet (all ten views)' : `${a.views && a.views.length ? a.views.length : 'the missing'} reference view(s)${a.views && a.views.length ? ` (${a.views.join(', ')})` : ''}`;
    return `Make ${what} for ${q(a.character)}'s dossier with ${eng}. It runs in the background and the pictures are saved into the book.`;
  },
  async run(a, ctx) {
    const r = await resolveDossier(ctx, a);
    if (!r.ok) return r;
    if (r.kp !== 'characters' && ['sheet', 'clip'].includes(a.what)) return { ok: false, error: 'NOT_FOR_KIND', message: `A ${a.what} is only made for characters. For ${KIND_WORD[r.kp]}s: hero (the main picture) or views.` };
    if (r.kp === 'characters' && a.what === 'hero') a.what = 'portrait';
    if (r.kp === 'characters' && a.views && a.views.some((v) => !FORGE_VIEWS.includes(v))) return { ok: false, error: 'BAD_VIEW', message: `Character views are: ${FORGE_VIEWS.join(', ')}.` };
    const body = { what: r.kp !== 'characters' && a.what === 'portrait' ? 'hero' : a.what, engine: a.engine || 'auto' };
    if (a.what === 'views' && a.views && a.views.length) body.views = a.views;
    const p = await ctx.akowe('POST', `/api/projects/${enc(r.pid)}/branches/main/forge/${r.kp}/${enc(r.d.record_id)}/art`, body);
    if (!okStatus(p)) return akoweError(p);
    return { ok: true, message: `Making ${a.what === 'views' ? 'the reference views' : `the ${a.what}`} for ${r.d.name} in the background (${a.what === 'clip' ? 'a video takes a few minutes — watch the 🎬 Video tab' : body.engine === 'chatgpt' ? 'ChatGPT takes about a minute per picture' : 'watch the 🎨 Images tab'}).`, data: { job_id: p.json && p.json.job_id, project_id: r.pid } };
  },
});
def({
  name: 'create_dossier', title: 'Character Forge: start a dossier', group: 'books', changes: true, book: true,
  description: 'Start a dossier for an item, place or magic system (or a character) — by name, or from a record the book already has (from = a candidate source_id; see character_dossier with kind). Then forge_character fills it, make_character_art draws it.',
  args: { type: 'object', required: ['kind'], properties: {
    project_id: { type: 'string', maxLength: 80 }, kind: KIND_ARG,
    name: { type: 'string', maxLength: 120 }, from: { type: 'string', maxLength: 80, description: 'A candidate source_id (a place / artifact / power record of the book)' },
    aliases: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 80 } },
  }, additionalProperties: false },
  async check(a) { return a.name || a.from ? { ok: true } : { ok: false, error: 'give a name, or from = a candidate source_id' }; },
  describe: (a) => `Start a ${KIND_WORD[a.kind] || 'character'} dossier${a.name ? ` for ${q(a.name)}` : ''}${a.from ? ` from the book's record ${q(a.from)}` : ''}.`,
  async run(a, ctx) {
    const b = await resolveBook(ctx, a);
    if (!b.ok) return b;
    const body = {};
    for (const k of ['name', 'from', 'aliases']) if (a[k] !== undefined) body[k] = a[k];
    const r = await ctx.akowe('POST', `/api/projects/${enc(b.pid)}/branches/main/forge/${a.kind}`, body);
    if (!okStatus(r)) return akoweError(r);
    const d = (r.json && r.json.dossier) || {};
    return { ok: true, message: clip((r.json && r.json.message) || `${r.json && r.json.created === false ? 'Already there' : 'Started'}: ${d.code || ''} ${d.name || a.name || ''}.`, 200), data: { record_id: r.json && r.json.record_id, code: d.code, created: r.json && r.json.created } };
  },
});
def({
  name: 'check_dossier', title: 'Character Forge: check a dossier against the book', group: 'books', book: true,
  description: 'Compare a dossier\'s approved facts with the written chapters (ages, colours, heights, years, stated limits, who holds an item; plus an AI pass for the fuzzy parts). action "run" starts the check (background), "results" lists the findings, "verdict" marks one: fix | fine | change_dossier (makes a proposal you approve) | null.',
  args: { type: 'object', required: ['character'], properties: {
    project_id: { type: 'string', maxLength: 80 }, kind: KIND_ARG,
    character: { type: 'string', minLength: 1, maxLength: 120, description: 'Name, record id or code (CH-/AR-/PL-/MG-001)' },
    action: { type: 'string', enum: ['run', 'results', 'verdict'] },
    ai: { type: 'boolean', description: 'run: also the AI pass (default true)' },
    finding_id: { type: 'string', maxLength: 80 }, verdict: { type: ['string', 'null'], enum: ['fix', 'fine', 'change_dossier', null] },
    text: { type: 'string', maxLength: 1200, description: 'verdict change_dossier: your own wording for the proposal' },
  }, additionalProperties: false },
  dynamicChanges: async (a) => (a.action || 'results') !== 'results',
  async check(a) { return (a.action || 'results') === 'verdict' && (!a.finding_id || a.verdict === undefined) ? { ok: false, error: 'verdict needs finding_id and verdict' } : { ok: true }; },
  describe: (a) => ((a.action || 'results') === 'run' ? `Check ${q(a.character)}'s dossier against the written chapters (in the background).` : `Mark finding ${q(a.finding_id)} as ${a.verdict === 'change_dossier' ? '"change the dossier" (a proposal you approve)' : a.verdict || 'not decided'}.`),
  async run(a, ctx) {
    const r = await resolveDossier(ctx, a);
    if (!r.ok) return r;
    const act = a.action || 'results';
    if (act === 'run') {
      const p = await ctx.akowe('POST', `/api/projects/${enc(r.pid)}/branches/main/forge/${r.kp}/${enc(r.d.record_id)}/check`, a.ai === false ? { ai: false } : {});
      return okStatus(p) ? { ok: true, message: `Checking ${r.d.name} against the book in the background.`, data: { job_id: p.json && p.json.job_id } } : akoweError(p);
    }
    if (act === 'verdict') {
      const p = await ctx.akowe('PUT', `/api/projects/${enc(r.pid)}/branches/main/forge/${r.kp}/${enc(r.d.record_id)}/check/${enc(a.finding_id)}`, Object.assign({ verdict: a.verdict }, a.text ? { text: a.text } : {}));
      return okStatus(p) ? { ok: true, message: a.verdict === 'change_dossier' ? 'Marked: a proposal to change the dossier is waiting for your approval.' : 'Marked.' } : akoweError(p);
    }
    const g = await ctx.akowe('GET', `/api/projects/${enc(r.pid)}/branches/main/forge/${r.kp}/${enc(r.d.record_id)}/check`);
    if (!okStatus(g)) return akoweError(g);
    const j = g.json || {};
    const findings = (j.findings || []).slice(0, 30).map((f) => ({ finding_id: f.finding_id || f.id, field: f.field, chapter: f.chapter || f.chapter_id, quote: clip(f.quote, 240), disagrees: clip(f.what || f.disagrees || f.message, 240), verdict: f.verdict || null }));
    return { ok: true, message: `${(j.findings || []).length} finding(s) for ${r.d.name}.`, data: { counts: j.counts || null, findings, status: j.status || null } };
  },
});

// ---- 🖼 Book pictures: chapter / scene illustrations and the map (Akọwe docs/PICTURES.md) -----------------
const PIC_ENGINES = ['auto', 'sd', 'chatgpt'];
async function picturesOf(ctx, a) {
  const b = await resolveBook(ctx, a);
  if (!b.ok) return b;
  const g = await ctx.akowe('GET', `/api/projects/${enc(b.pid)}/branches/main/pictures`);
  if (!okStatus(g)) return akoweError(g);
  return { ok: true, pid: b.pid, j: g.json || {} };
}
function chapterOf(j, which) {
  const chs = j.chapters || [];
  const w = String(which == null ? '' : which).trim().toLowerCase();
  return chs.find((c) => String(c.chapter_id).toLowerCase() === w) || chs.find((c) => String(c.number) === w.replace(/^(chapter|ch)\s*/, ''))
    || chs.find((c) => String(c.title || '').toLowerCase() === w) || chs.find((c) => w && String(c.title || '').toLowerCase().includes(w)) || null;
}
def({
  name: 'book_pictures', title: 'Book pictures: what is illustrated', group: 'books', book: true,
  description: 'The book\'s pictures: the art style, each chapter with its pictures (chosen / candidates waiting / none), the map. Read-only.',
  args: { type: 'object', properties: { project_id: { type: 'string', maxLength: 80 } }, additionalProperties: false },
  async run(a, ctx) {
    const r = await picturesOf(ctx, a);
    if (!r.ok) return r;
    const j = r.j;
    const chapters = (j.chapters || []).map((c) => ({ chapter_id: c.chapter_id, number: c.number, title: clip(c.title, 80), state: c.state,
      pictures: (c.pictures || []).map((p) => ({ pic_id: p.pic_id || p.id, chosen: p.chosen != null, candidates: (p.candidates || []).length, caption: clip(p.caption, 120), where: p.placement && p.placement.where })) }));
    return { ok: true, message: `Art style: ${j.style || 'none set'}; ${chapters.filter((c) => c.pictures.some((p) => p.chosen)).length} of ${chapters.length} chapters illustrated${j.map ? '; the map is made' : ''}.`,
      data: { project_id: r.pid, style: j.style || null, styles: (j.styles || []).slice(0, 20), chapters, map: j.map ? { kind: j.map.kind || null } : null, out_of_date: !!j.out_of_date } };
  },
});
def({
  name: 'set_art_style', title: 'Book pictures: set the art style', group: 'books', changes: true, book: true,
  description: 'Set the one art style every picture of the book uses (e.g. "ink wash", "painterly oil", "manga", "watercolour storybook").',
  args: { type: 'object', required: ['style'], properties: { project_id: { type: 'string', maxLength: 80 }, style: { type: 'string', minLength: 2, maxLength: 200 } }, additionalProperties: false },
  describe: (a) => `Set the book's art style to ${q(a.style)} (every new picture uses it).`,
  async run(a, ctx) {
    const b = await resolveBook(ctx, a);
    if (!b.ok) return b;
    const r = await ctx.akowe('PUT', `/api/projects/${enc(b.pid)}/branches/main/pictures/style`, { style: a.style });
    return okStatus(r) ? { ok: true, message: `Art style set to ${q(a.style)}.` } : akoweError(r);
  },
});
def({
  name: 'illustrate', title: 'Book pictures: illustrate a chapter (or all)', group: 'books', changes: true, book: true,
  description: 'Make a picture for a chapter (or one scene of it) from its scene cards, with the characters\' looks and the book\'s art style; count 1–3 candidates to pick from. all=true illustrates every chapter that has no chosen picture yet (a background job you can stop). engine sd / chatgpt / auto.',
  args: { type: 'object', properties: {
    project_id: { type: 'string', maxLength: 80 },
    chapter: { type: 'string', maxLength: 120, description: 'Chapter number, id or title' },
    scene: { type: 'integer', minimum: 1, maximum: 200 },
    count: { type: 'integer', minimum: 1, maximum: 3 },
    all: { type: 'boolean' },
    engine: { type: 'string', enum: PIC_ENGINES },
  }, additionalProperties: false },
  async check(a) { return a.all || a.chapter ? { ok: true } : { ok: false, error: 'say which chapter, or all: true' }; },
  describe: (a) => `${a.all ? 'Illustrate every chapter that has no picture yet' : `Illustrate chapter ${q(a.chapter)}${a.scene ? `, scene ${a.scene}` : ''}${a.count > 1 ? ` (${a.count} candidates to pick from)` : ''}`} with ${{ sd: 'Stable Diffusion', chatgpt: 'ChatGPT' }[a.engine] || 'Stable Diffusion if connected, else ChatGPT'}. It runs in the background.`,
  async run(a, ctx) {
    const r = await picturesOf(ctx, a);
    if (!r.ok) return r;
    const base = `/api/projects/${enc(r.pid)}/branches/main/pictures`;
    if (a.all) {
      const p = await ctx.akowe('POST', `${base}/illustrate-all`, { engine: a.engine || 'auto' });
      return okStatus(p) ? { ok: true, message: 'Illustrating every chapter without a picture, in the background (see the 🖼 Pictures page; you can Stop it there).', data: { job_id: p.json && p.json.job_id } } : akoweError(p);
    }
    const ch = chapterOf(r.j, a.chapter);
    if (!ch) return { ok: false, error: 'NO_CHAPTER', message: `There is no chapter ${q(a.chapter)}. Chapters: ${(r.j.chapters || []).map((c) => c.number).join(', ') || 'none yet'}.` };
    const body = { chapter_id: ch.chapter_id, engine: a.engine || 'auto' };
    if (a.scene) body.scene = a.scene;
    if (a.count) body.count = a.count;
    const p = await ctx.akowe('POST', `${base}/illustrate`, body);
    return okStatus(p) ? { ok: true, message: `Illustrating chapter ${ch.number}${a.scene ? `, scene ${a.scene}` : ''} in the background${a.count > 1 ? ' — pick your favourite on the 🖼 Pictures page' : ''}.`, data: { job_id: p.json && p.json.job_id, pic_id: p.json && p.json.pic_id } } : akoweError(p);
  },
});
def({
  name: 'edit_picture', title: 'Book pictures: caption, placement, pick or remove', group: 'books', changes: true, book: true,
  description: 'Change one picture (pic_id from book_pictures): caption, alt text, placement (where: before / start / after_scene (with scene) / end), chosen = which candidate (0-based) or null to leave it out, remove = delete it.',
  args: { type: 'object', required: ['pic_id'], properties: {
    project_id: { type: 'string', maxLength: 80 },
    pic_id: { type: 'string', minLength: 1, maxLength: 80 },
    caption: { type: 'string', maxLength: 300 }, alt: { type: 'string', maxLength: 300 },
    where: { type: 'string', enum: ['before', 'start', 'after_scene', 'end'] }, scene: { type: 'integer', minimum: 1, maximum: 200 },
    chosen: { type: ['integer', 'null'], minimum: 0, maximum: 5 },
    remove: { type: 'boolean' },
  }, additionalProperties: false },
  describe: (a) => (a.remove ? `Delete picture ${q(a.pic_id)}.` : `Change picture ${q(a.pic_id)}: ${[a.caption != null && `caption ${q(a.caption)}`, a.alt != null && 'alt text', a.where && `placed ${a.where}${a.scene ? ` ${a.scene}` : ''}`, a.chosen !== undefined && (a.chosen === null ? 'left out' : `candidate ${a.chosen + 1}`)].filter(Boolean).join(', ') || 'nothing'}.`),
  async run(a, ctx) {
    const b = await resolveBook(ctx, a);
    if (!b.ok) return b;
    const url = `/api/projects/${enc(b.pid)}/branches/main/pictures/${enc(a.pic_id)}`;
    if (a.remove) { const d = await ctx.akowe('DELETE', url); return okStatus(d) ? { ok: true, message: 'Picture removed.' } : akoweError(d); }
    const body = {};
    for (const k of ['caption', 'alt', 'chosen']) if (a[k] !== undefined) body[k] = a[k];
    if (a.where) body.placement = Object.assign({ where: a.where }, a.scene ? { scene: a.scene } : {});
    if (!Object.keys(body).length) return { ok: false, error: 'NOTHING_TO_CHANGE', message: 'Say what to change (caption, alt, where, chosen) or remove: true.' };
    const r = await ctx.akowe('PUT', url, body);
    return okStatus(r) ? { ok: true, message: 'Picture updated.' } : akoweError(r);
  },
});
// 🎞 B2: the book trailer (Akọwe trailer.py → AutoInjector 🎬 Video POST /video/trailer)
def({
  name: 'make_trailer', title: 'Make the book trailer', group: 'books', changes: true, book: true,
  description: 'Make a short trailer of a book: Akọwe plans 5–8 video shots from the book (its key scenes, main place and characters\' looks, title cards with the logline) — or uses the plan the author already edited on the 🎞 Trailer page — and AutoInjector\'s 🎬 Video makes the shots and joins them. Runs in the background (a few minutes per shot); the trailer is stored with the book. replan = plan it again from the book first (the author\'s edits are replaced).',
  args: { type: 'object', properties: {
    project_id: { type: 'string', maxLength: 80 },
    replan: { type: 'boolean', description: 'Plan the shots again from the book (replaces the author\'s edited plan)' },
  }, additionalProperties: false },
  describe: (a) => `${a.replan ? 'Plan the trailer again from the book (your edits to the plan are replaced), then make' : 'Make'} the book trailer: AutoInjector's 🎬 Video makes each shot (a few minutes each) and joins them with title cards; it is stored with the book.`,
  async run(a, ctx) {
    const b = await resolveBook(ctx, a);
    if (!b.ok) return b;
    const g = await ctx.akowe('GET', `/api/projects/${enc(b.pid)}/branches/main/trailer`);
    if (!okStatus(g)) return akoweError(g);
    let planned = false;
    if (a.replan || !(g.json && g.json.plan)) {
      const p = await ctx.akowe('POST', `/api/projects/${enc(b.pid)}/branches/main/trailer/plan`, {});
      if (!okStatus(p)) return akoweError(p);
      planned = true;
    }
    const m = await ctx.akowe('POST', `/api/projects/${enc(b.pid)}/branches/main/trailer/make`, {});
    if (!okStatus(m)) return akoweError(m);
    const shots = m.json && m.json.total;
    return { ok: true, message: `Making the book trailer in the background${planned ? ' (planned from the book)' : ' (your plan)'}: ${shots || 'the'} shot(s), a few minutes each — watch 🎬 Video → 🎞 Trailer in AutoInjector, or the 🎞 Trailer page in Akọwe.`, data: { job_id: m.json && m.json.job_id, project_id: b.pid, shots, planned } };
  },
});
def({
  name: 'book_map', title: 'Book pictures: make the map', group: 'books', changes: true, book: true,
  description: 'Make the book\'s world map: kind "svg" = drawn from the book\'s places (instant), "illustrated" = an illustrated map picture (engine sd / chatgpt / auto, background job). It goes before chapter 1.',
  args: { type: 'object', properties: { project_id: { type: 'string', maxLength: 80 }, kind: { type: 'string', enum: ['svg', 'illustrated'] }, engine: { type: 'string', enum: PIC_ENGINES } }, additionalProperties: false },
  describe: (a) => ((a.kind || 'svg') === 'svg' ? 'Draw the world map from the book\'s places (it goes before chapter 1).' : `Make an illustrated world map with ${{ sd: 'Stable Diffusion', chatgpt: 'ChatGPT' }[a.engine] || 'Stable Diffusion if connected, else ChatGPT'} (it goes before chapter 1).`),
  async run(a, ctx) {
    const b = await resolveBook(ctx, a);
    if (!b.ok) return b;
    const body = { kind: a.kind || 'svg' };
    if (body.kind === 'illustrated') body.engine = a.engine || 'auto';
    const r = await ctx.akowe('POST', `/api/projects/${enc(b.pid)}/branches/main/pictures/map`, body);
    return okStatus(r) ? { ok: true, message: body.kind === 'svg' ? 'The map is drawn from the book\'s places.' : 'Making the illustrated map in the background.', data: { job_id: r.json && r.json.job_id } } : akoweError(r);
  },
});

// ---- 🎨 Book cover: designer, AI art, ebook + print wrap (Akọwe docs/COVERS.md) -------------------------
const COVER_TEMPLATES = ['gilded', 'thriller', 'romance', 'fantasy', 'literary', 'scifi', 'minimal'];
def({
  name: 'book_cover', title: 'Book cover: read the design', group: 'books', book: true,
  description: 'The book cover: template, texts (title, subtitle, author, series, tagline), colours, art (yes/no), the print settings (trim, paper, pages) with the spine width and any problem or warning. Read-only.',
  args: { type: 'object', properties: { project_id: { type: 'string', maxLength: 80 } }, additionalProperties: false },
  async run(a, ctx) {
    const b = await resolveBook(ctx, a);
    if (!b.ok) return b;
    const g = await ctx.akowe('GET', `/api/projects/${enc(b.pid)}/branches/main/cover`);
    if (!okStatus(g)) return akoweError(g);
    const j = g.json || {}; const d = j.design || {}; const pr = j.print || {};
    return { ok: true, message: `Template ${d.template || '?'}; ${d.art ? 'with' : 'no'} art; print ${pr.ok === false ? `problem: ${clip(pr.problem, 160)}` : `spine ${pr.spine_in != null ? `${pr.spine_in} in` : '?'}`}.`,
      data: { project_id: b.pid, template: d.template, templates: (j.templates || []).map((t) => t.id || t), texts: j.texts || {}, colors: d.colors || {}, has_art: !!d.art,
        blurb: clip(d.blurb || (j.texts && j.texts.blurb), 400), print: { trim: (d.print || {}).trim, paper: (d.print || {}).paper, page_count: (d.print || {}).page_count, spine: pr.spine_in || pr.spine, ok: pr.ok !== false, problem: pr.problem || null, notes: pr.notes || [] }, warnings: (j.warnings || []).slice(0, 8) } };
  },
});
def({
  name: 'design_cover', title: 'Book cover: change the design', group: 'books', changes: true, book: true,
  description: `Change the cover: template (${COVER_TEMPLATES.join(', ')}), texts {title, subtitle, author, series, tagline}, colors {background, text, accent} as #rrggbb, blurb and author_bio (back cover), print {trim: 5x8 | 5.5x8.5 | 6x9, paper: white | cream, page_count}, use_art (false = typographic only). Only what you give changes.`,
  args: { type: 'object', properties: {
    project_id: { type: 'string', maxLength: 80 },
    template: { type: 'string', enum: COVER_TEMPLATES },
    texts: { type: 'object', properties: { title: { type: 'string', maxLength: 200 }, subtitle: { type: 'string', maxLength: 200 }, author: { type: 'string', maxLength: 120 }, series: { type: 'string', maxLength: 120 }, tagline: { type: 'string', maxLength: 200 } }, additionalProperties: false },
    colors: { type: 'object', properties: { background: { type: 'string', maxLength: 9 }, text: { type: 'string', maxLength: 9 }, accent: { type: 'string', maxLength: 9 } }, additionalProperties: false },
    blurb: { type: 'string', maxLength: 2000 }, author_bio: { type: 'string', maxLength: 800 },
    print: { type: 'object', properties: { trim: { type: 'string', enum: ['5x8', '5.5x8.5', '6x9'] }, paper: { type: 'string', enum: ['white', 'cream'] }, page_count: { type: 'integer', minimum: 24, maximum: 828 } }, additionalProperties: false },
    use_art: { type: 'boolean' },
  }, additionalProperties: false },
  async check(a) {
    for (const [k, v] of Object.entries(a.colors || {})) if (!/^#[0-9a-fA-F]{6}$/.test(v)) return { ok: false, error: `colors.${k} must be #rrggbb` };
    return ['template', 'texts', 'colors', 'blurb', 'author_bio', 'print', 'use_art'].some((k) => a[k] !== undefined) ? { ok: true } : { ok: false, error: 'say what to change on the cover' };
  },
  describe: (a) => `Change the cover: ${[a.template && `template ${a.template}`, a.texts && `texts (${Object.keys(a.texts).join(', ')})`, a.colors && 'colours', a.blurb && 'back-cover blurb', a.author_bio && 'author bio', a.print && `print (${Object.entries(a.print).map(([k, v]) => `${k} ${v}`).join(', ')})`, a.use_art === false && 'no art (typographic)', a.use_art === true && 'use the art'].filter(Boolean).join('; ')}.`,
  async run(a, ctx) {
    const b = await resolveBook(ctx, a);
    if (!b.ok) return b;
    const body = {};
    for (const k of ['template', 'texts', 'colors', 'blurb', 'author_bio', 'print', 'use_art']) if (a[k] !== undefined) body[k] = a[k];
    const r = await ctx.akowe('PUT', `/api/projects/${enc(b.pid)}/branches/main/cover`, body);
    if (!okStatus(r)) return akoweError(r);
    const pr = (r.json && r.json.print) || {};
    return { ok: true, message: `Cover updated.${pr.ok === false && pr.problem ? ` Print note: ${clip(pr.problem, 200)}` : ''}`, data: { warnings: ((r.json && r.json.warnings) || []).slice(0, 6) } };
  },
});
def({
  name: 'make_cover_art', title: 'Book cover: make the cover art', group: 'books', changes: true, book: true,
  description: 'Make the cover picture (no lettering — the designer sets the type): engine sd / chatgpt / auto, upscale 2 or 4 for a sharp print cover, character = whose character lock to use. Runs in the background.',
  args: { type: 'object', properties: {
    project_id: { type: 'string', maxLength: 80 },
    engine: { type: 'string', enum: ['auto', 'sd', 'chatgpt'] },
    upscale: { type: 'integer', enum: [1, 2, 4] },
    character: { type: 'string', maxLength: 120 },
    note: { type: 'string', maxLength: 400, description: 'What the cover picture should show' },
  }, additionalProperties: false },
  describe: (a) => `Make the cover art with ${{ sd: 'Stable Diffusion', chatgpt: 'ChatGPT' }[a.engine] || 'Stable Diffusion if connected, else ChatGPT'}${a.upscale > 1 ? `, upscaled ×${a.upscale}` : ''}${a.character ? `, with ${q(a.character)}'s looks` : ''}${a.note ? ` — ${q(a.note)}` : ''}. It runs in the background.`,
  async run(a, ctx) {
    const b = await resolveBook(ctx, a);
    if (!b.ok) return b;
    const base = `/api/projects/${enc(b.pid)}/branches/main/cover`;
    if (a.character || a.note) {
      const p0 = await ctx.akowe('PUT', base, Object.assign({}, a.character ? { character_lock: a.character } : {}, a.note ? { art_note: a.note } : {}));
      if (!okStatus(p0)) return akoweError(p0);
    }
    const body = { engine: a.engine || 'auto' };
    if (a.upscale) body.upscale = a.upscale;
    const p = await ctx.akowe('POST', `/api/projects/${enc(b.pid)}/branches/main/cover/art`, body);
    return okStatus(p) ? { ok: true, message: 'Making the cover art in the background (see the 🎨 Cover page).', data: { job_id: p.json && p.json.job_id } } : akoweError(p);
  },
});

def({
  name: 'make_book_report', title: 'Make the book report', group: 'books', changes: true, book: true, allowAlways: true,
  description: 'Make (or refresh) the book report in Akọwe. It runs in the background.',
  args: { type: 'object', properties: { project_id: { type: 'string', maxLength: 80 } }, additionalProperties: false },
  describe: (a) => `Make the book report${a.project_id ? ` for ${a.project_id}` : ''} in Akọwe (it runs in the background).`,
  async run(a, ctx) {
    const b = await resolveBook(ctx, a);
    if (!b.ok) return b;
    const r = await ctx.akowe('POST', `/api/projects/${enc(b.pid)}/branches/main/report`, {});
    if (!okStatus(r)) return akoweError(r);
    return { ok: true, message: 'The book report is being made. Ask me to open the report page when you want to see it.', project_id: b.pid };
  },
});
def({
  name: 'save_book', title: 'Save the book', group: 'books', changes: true, book: true, allowAlways: true,
  description: 'Save the book to its folder now (Akọwe\'s 💾 Save).',
  args: { type: 'object', properties: { project_id: { type: 'string', maxLength: 80 } }, additionalProperties: false },
  describe: (a) => `Save the book${a.project_id ? ` ${a.project_id}` : ''} to its folder now (💾 Save).`,
  async run(a, ctx) {
    const b = await resolveBook(ctx, a);
    if (!b.ok) return b;
    const r = await ctx.akowe('POST', `/api/projects/${enc(b.pid)}/branches/main/save`, {});
    if (!okStatus(r)) return akoweError(r);
    return { ok: true, message: 'Saving the book.', project_id: b.pid };
  },
});

// ---- 🎨 Images ----------------------------------------------------------------------------------
def({
  name: 'generate_image', title: 'Generate an image', group: 'images', changes: true, allowAlways: true, timeoutMs: 480000,
  description: 'Make a picture from a description. engine: "sd" = the local Stable Diffusion, "chatgpt" = ChatGPT\'s own image generation in its logged-in pane (30–180 s), "auto" (default) = SD when connected, else ChatGPT. For a character\'s reference pictures: purpose "portrait", purpose "view" with one view (front, three_quarter_front, side, three_quarter_back, back, idle, draw, attack, dash, defend — AutoInjector adds the framing), or purpose "sheet" (one turnaround sheet with all ten). Optional size, style, character (their character lock is used) and appearance.',
  args: { type: 'object', properties: {
    prompt: { type: 'string', minLength: 2, maxLength: 1000 },
    width: { type: 'integer', minimum: 256, maximum: 2048 },
    height: { type: 'integer', minimum: 256, maximum: 2048 },
    style: { type: 'string', maxLength: 200 },
    character: { type: 'string', maxLength: 200, description: 'A character name: their saved character lock is used when there is one' },
    appearance: { type: 'string', maxLength: 1000, description: 'What the character looks like, in words' },
    negative_prompt: { type: 'string', maxLength: 1000 },
    loras: { type: 'array', maxItems: 4, items: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, weight: { type: 'number' } }, additionalProperties: false } },
    engine: { type: 'string', enum: ['auto', 'sd', 'chatgpt'] },
    purpose: { type: 'string', enum: ['free', 'portrait', 'cover', 'scene', 'illustration', 'map', 'view', 'sheet'] },
    view: { type: 'string', enum: ['front', 'three_quarter_front', 'side', 'three_quarter_back', 'back', 'idle', 'draw', 'attack', 'dash', 'defend'] },
    new_chat: { type: 'boolean', description: 'ChatGPT engine: start a fresh ChatGPT chat first' },
    upscale: { type: 'integer', enum: [2, 4], description: 'Upscale the finished picture ×2 or ×4 (needs a connected Stable Diffusion app)' },
  }, additionalProperties: false },
  check(a) {
    if (!a.prompt && !a.character && !a.appearance) return { ok: false, error: 'say what to draw (prompt), or give a character / appearance' };
    if (a.purpose === 'view' && !a.view) return { ok: false, error: 'purpose "view" needs a view (front, side, back, …)' };
    return { ok: true, args: a };
  },
  describe: (a) => `Make ${a.purpose === 'sheet' ? 'a turnaround sheet' : a.purpose === 'view' ? `the ${String(a.view || '').replace(/_/g, ' ')} reference view` : a.purpose === 'portrait' ? 'a portrait' : a.purpose === 'map' ? 'a map' : a.purpose === 'cover' ? 'cover art' : 'an image'}${a.prompt ? ` of ${q(a.prompt)}` : ''}${a.width && a.height ? ` at ${a.width}×${a.height}` : ''}${a.style ? `, style ${q(a.style)}` : ''}${a.character ? `, with ${q(a.character)} (their character lock if saved)` : ''}${a.appearance ? ` (${clip(a.appearance, 120)})` : ''}${a.loras && a.loras.length ? `, LoRAs ${a.loras.map((l) => l.name).join(', ')}` : ''}${a.engine === 'chatgpt' ? ' with ChatGPT' : a.engine === 'sd' ? ' with Stable Diffusion' : ''}, and save it in the images folder.`,
  async run(a, ctx) {
    const r = await ctx.generateImage({ prompt: a.prompt, width: a.width, height: a.height, style: a.style, character: a.character, appearance: a.appearance, negativePrompt: a.negative_prompt, loras: a.loras, engine: a.engine, purpose: a.purpose, view: a.view, newChat: a.new_chat, upscale: a.upscale });
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'IMAGE_FAILED', message: (r && r.message) || `The image couldn't be made (${(r && r.error) || 'unknown'}). Check the 🎨 Images tab.` };
    const notes = imageNotes(r.warnings);
    return { ok: true, message: `Saved ${r.count || 1} image(s)${r.engine === 'chatgpt' ? ' (made by ChatGPT)' : ''}.${notes.length ? ` Notes: ${clip(notes.join(' '), 600)}` : ''}`, data: { path: r.path, paths: r.paths || [r.path], engine: r.engine || null, view: r.view || null, warnings: notes }, image: r.path };
  },
});
def({
  name: 'list_images', title: 'List recent images', group: 'images',
  description: 'List the most recent images in the images folder. Read-only.',
  args: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
  async run(a, ctx) {
    const items = await ctx.listOutputs('images', a.limit || 10);
    return { ok: true, data: items };
  },
});

def({
  name: 'image_generator_status', title: 'Image generator status', group: 'images',
  description: 'Whether Stable Diffusion is connected (which app, checkpoint, busy), whether AutoInjector is running it, and whether ChatGPT can make pictures (its pane ready, drawing now). Read-only.',
  args: { type: 'object', properties: {}, additionalProperties: false },
  async run(_a, ctx) {
    const r = await ctx.sdStatus();
    if (!r || r.ok === false) return { ok: false, error: (r && r.error) || 'NO_IMAGES_MODULE', message: (r && r.message) || 'The image module is not available in this build.' };
    const im = r.image || {}; const mg = r.managed || {};
    const cg = r.chatgpt || null;
    return { ok: true, data: { connected: !!(im.enabled && im.endpoint), app: im.label || im.backend || null, checkpoint: im.checkpoint || im.model || null, busy: !!im.busy, started_by_autoinjector: mg.phase || null, endpoint: im.endpoint || null,
      chatgpt: cg ? { ready: !!cg.ready, why: cg.why || null, drawing: !!cg.busy, seconds: cg.drawingMs ? Math.round(cg.drawingMs / 1000) : 0 } : null } };
  },
});
def({
  name: 'start_image_generator', title: 'Start Stable Diffusion', group: 'images', changes: true, allowAlways: true, timeoutMs: 200000,
  description: 'Start the Stable Diffusion app AutoInjector knows about (from the 🎨 Images tab → Start & install), optionally a specific one by its target id.',
  args: { type: 'object', properties: { target: { type: 'string', maxLength: 200 } }, additionalProperties: false },
  describe: (a) => `Start Stable Diffusion${a.target ? ` (${a.target})` : ''} so images can be made (it can take a minute).`,
  async run(a, ctx) {
    const r = await ctx.sdStart(a.target);
    return r && r.ok !== false ? { ok: true, message: 'Stable Diffusion is starting (or already running).' } : { ok: false, error: (r && r.error) || 'START_FAILED', message: (r && r.message) || "Stable Diffusion couldn't be started — see the 🎨 Images tab." };
  },
});
def({
  name: 'stop_image_generator', title: 'Stop Stable Diffusion', group: 'images', changes: true, allowAlways: true,
  description: 'Stop the Stable Diffusion app that AutoInjector started (frees the GPU). One you started yourself is left alone.',
  args: { type: 'object', properties: {}, additionalProperties: false },
  describe: () => 'Stop the Stable Diffusion app AutoInjector started (frees the graphics card).',
  async run(_a, ctx) {
    const r = await ctx.sdStop();
    return r && r.ok !== false ? { ok: true, message: 'Stopped.' } : { ok: false, error: (r && r.error) || 'STOP_FAILED', message: (r && r.message) || "It couldn't be stopped." };
  },
});
def({
  name: 'find_models', title: 'Search the model library', group: 'images',
  description: 'Search the Stable Diffusion library (LoRAs, checkpoints, VAEs, embeddings) by words, e.g. a character or a style. Read-only.',
  args: { type: 'object', properties: { query: { type: 'string', maxLength: 200 }, kind: { type: 'string', enum: ['lora', 'checkpoint', 'vae', 'embedding'] } }, additionalProperties: false },
  async run(a, ctx) {
    const items = await ctx.libraryFind(a.query || '', a.kind ? { kind: a.kind } : {});
    if (!Array.isArray(items)) return { ok: false, error: (items && items.error) || 'LIBRARY_FAILED', message: (items && items.message) || 'The library could not be searched.' };
    return { ok: true, data: items.slice(0, 15).map((x) => ({ id: x.id, name: x.name, kind: x.kind, base: x.base || null, trigger_words: (x.triggerWords || []).slice(0, 6), weight: x.defaultWeight != null ? x.defaultWeight : null })) };
  },
});
def({
  name: 'character_locks', title: 'Character locks', group: 'images',
  description: 'List the saved character locks (a character\'s LoRAs, trigger words and look), or show one by name. Read-only. Use the character name in generate_image to use the lock.',
  args: { type: 'object', properties: { name: { type: 'string', maxLength: 120 } }, additionalProperties: false },
  async run(a, ctx) {
    const brief = (l) => ({ character: l.character, book: l.book || null, loras: (l.loras || []).map((x) => `${x.name}:${x.weight}`), trigger_words: (l.triggerWords || []).slice(0, 8), look: clip(l.prompt || '', 200) });
    if (a.name) {
      const l = await ctx.characterLock(a.name);
      return l && l.character ? { ok: true, data: brief(l) } : { ok: true, data: null, message: `There is no character lock for ${q(a.name)} yet (make one in the 🎨 Images tab → 🔒 Character locks).` };
    }
    const all = await ctx.characterLocks();
    return { ok: true, data: (Array.isArray(all) ? all : []).slice(0, 30).map(brief) };
  },
});

// ---- 🎬 Video -----------------------------------------------------------------------------------
def({
  name: 'video_status', title: 'Video status', group: 'video',
  description: 'Whether video generation is set up: the 🎬 Video module (ComfyUI + a Wan video model) — installed models, what is missing, busy — or the older video-server setting. Read-only.',
  args: { type: 'object', properties: {}, additionalProperties: false },
  async run(_a, ctx) {
    if (ctx.videoInvoke && ctx.videoMethods && (await ctx.videoMethods()).some((m) => m.method === 'video.status')) {
      const r = await ctx.videoInvoke('video.status', {});
      if (r && r.ok !== false) return { ok: true, data: shrink(r) };
    }
    const s = ctx.videoStatus();
    return { ok: true, data: { enabled: !!s.enabled, configured: !!s.configured, note: s.enabled && s.configured ? 'Video generation is set up.' : 'Video generation is not set up yet: in the 🎬 Video tab, install ComfyUI + a video model (one click).' } };
  },
});
// generate_video forgives what small models send (seen: {character, image, prompt, seconds} with a
// picture that wasn't one): seconds clamped to 1–10, an empty / "none" value dropped, an image that is
// no picture path or picture data dropped (→ text→video), a picture + a character → the picture is used.
// Each forgiven value is noted back to the AI; what still fails names the field and what it may be.
const VIDEO_SECONDS = { min: 1, max: 10 };
const EMPTYISH = /^\s*(none|null|undefined|n\/?a|no|false|-|nothing|empty)?\s*$/i;
function looksLikePicture(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (/^data:image\/[\w.+-]+;base64,/i.test(s)) return true;
  if (s.length < 2048 && /\.(png|jpe?g|webp|gif)$/i.test(s)) return true;
  if (s.length < 2048 && /^(file:\/\/|[a-z]:[\\/]|[\\/]|~[\\/]|\.{1,2}[\\/])/i.test(s)) return true;
  return s.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(s); // plain base64
}
function forgiveVideoArgs(a, notes) {
  const out = {};
  for (const [k, v] of Object.entries(a || {})) {
    if (v === undefined || v === null || (typeof v === 'string' && EMPTYISH.test(v))) continue; // empty / "none" = not given
    out[k] = v;
  }
  if (out.seconds !== undefined) {
    let n = typeof out.seconds === 'number' ? out.seconds : Number((String(out.seconds).match(/-?\d+(\.\d+)?/) || [])[0]);
    if (!Number.isFinite(n)) { notes.push(`seconds “${str(out.seconds, 40)}” is not a number, so the usual length is used (seconds may be ${VIDEO_SECONDS.min} to ${VIDEO_SECONDS.max}).`); delete out.seconds; }
    else {
      const c = Math.min(VIDEO_SECONDS.max, Math.max(VIDEO_SECONDS.min, n));
      if (c !== n) notes.push(`seconds ${n} is outside ${VIDEO_SECONDS.min}–${VIDEO_SECONDS.max}, so ${c} was used.`);
      out.seconds = c;
    }
  }
  for (const k of ['prompt', 'character', 'negative_prompt']) if (out[k] !== undefined && typeof out[k] !== 'string') { if (typeof out[k] === 'number') out[k] = String(out[k]); else { notes.push(`${k} must be text — it was left out.`); delete out[k]; } }
  if (out.image !== undefined && !looksLikePicture(out.image)) {
    notes.push(`image “${clip(typeof out.image === 'string' ? out.image : JSON.stringify(out.image), 60)}” is not a picture (image must be the path of a .png / .jpg / .webp file, or picture data), so it was left out — the video is made from the description instead (text → video).`);
    delete out.image;
  }
  return out;
}
def({
  name: 'generate_video', title: 'Generate a video', group: 'video', changes: true, timeoutMs: 1200000,
  description: 'Make a short video clip: from a description (prompt → text → video), or bring a picture to life (image = the path of a .png/.jpg/.webp file → video). character = a character lock name (keeps their looks; for text → video — with an image the picture is used). seconds 1–10. Uses the 🎬 Video module (ComfyUI + Wan); for every other setting use video_call.',
  args: { type: 'object', properties: {
    prompt: { type: 'string', maxLength: 1000, description: 'What happens in the video' },
    image: { type: 'string', maxLength: 2000, description: 'A picture to animate: the path of a .png / .jpg / .webp file' },
    character: { type: 'string', maxLength: 120, description: 'A character lock name (text → video)' },
    seconds: { type: 'number', description: `Length in seconds, ${VIDEO_SECONDS.min}–${VIDEO_SECONDS.max} (clamped)` },
    negative_prompt: { type: 'string', maxLength: 1000 },
  }, additionalProperties: false },
  forgive: forgiveVideoArgs,
  async check(a) { return str(a.prompt, 1) || a.image || a.character ? { ok: true } : { ok: false, error: 'give at least one of: prompt (what happens, as text), image (the path of a .png / .jpg / .webp picture to animate) or character (a character lock name)' }; },
  describe: (a) => `${a.image ? `Bring the picture ${q(a.image)} to life` : 'Make a short video'}${a.prompt ? ` — ${q(a.prompt)}` : ''}${a.character ? (a.image ? ` (the picture is used, not ${q(a.character)}'s character lock)` : ` with ${q(a.character)}'s looks`) : ''}${a.seconds ? ` (${a.seconds} s)` : ''}, and save it in the videos folder. It can take several minutes.`,
  async run(a, ctx) {
    const notes = [];
    const methods = ctx.videoMethods ? await ctx.videoMethods() : [];
    if (methods.some((m) => m.method === 'video.generate')) {
      const base = { from: 'alfred' };
      if (a.seconds) base.seconds = a.seconds;
      if (a.negative_prompt) base.negativePrompt = a.negative_prompt;
      const textParams = () => { const p = Object.assign({ prompt: a.prompt || '' }, base); if (a.character) p.characterLock = a.character; return p; };
      let r; let usedImage = false;
      if (a.image && methods.some((m) => m.method === 'video.animate')) {
        if (a.character) notes.push(`Both a picture and a character were given: the picture was used (it already shows who it is); the character lock “${str(a.character, 80)}” was not applied.`);
        r = await ctx.videoInvoke('video.animate', Object.assign({ prompt: a.prompt || '', image: a.image }, base));
        usedImage = true;
        // The picture could not be used (not found / not a picture): make it from the description instead.
        if (r && r.ok === false && r.code === 'INVALID_PARAM' && r.field === 'image' && (str(a.prompt, 1) || a.character)) {
          notes.length = 0;
          notes.push(`The picture could not be used (${clip(r.message || 'not a readable picture', 160)}), so the video was made from the description instead (text → video).`);
          r = await ctx.videoInvoke('video.generate', textParams()); usedImage = false;
        }
      } else {
        if (a.image) notes.push('Picture → video is not available in this build, so the video was made from the description (text → video).');
        if (a.image && !str(a.prompt, 1) && !a.character) return { ok: false, error: 'UNSUPPORTED', message: 'Picture → video is not available here and there is no description (prompt) to make it from text.' };
        r = await ctx.videoInvoke('video.generate', textParams());
      }
      // No such character lock: with a description the video is still made, without the lock.
      if (r && r.ok === false && r.code === 'NO_LOCK' && !usedImage && a.character && str(a.prompt, 1)) {
        notes.push(`There is no character lock “${str(a.character, 80)}”, so the video was made from the description without one (character_locks lists them).`);
        const p = textParams(); delete p.characterLock;
        r = await ctx.videoInvoke('video.generate', p);
      }
      if (!r || r.ok === false) return { ok: false, error: str((r && (r.code || r.error)) || 'VIDEO_FAILED', 60), message: clip(videoErrorText(r), 500), notes };
      for (const w of imageNotes(r.warnings)) notes.push(w);
      return { ok: true, message: `Saved the clip${usedImage ? ' (from the picture)' : ''}${r.seconds ? ` (${r.seconds} s)` : ''}.${notes.length ? ` ${notes[0]}` : ''}`, notes, data: { path: r.path || null, poster: r.poster || null, model: r.model || null, seed: r.seed, mode: usedImage ? 'picture→video' : 'text→video' } };
    }
    if (a.image && !str(a.prompt, 1)) return { ok: false, error: 'VIDEO_NOT_SET_UP', message: 'Bringing a picture to life needs the 🎬 Video module (ComfyUI + a video model): install it in the 🎬 Video tab.' };
    const s = ctx.videoStatus();
    if (!s.enabled || !s.configured) return { ok: false, error: 'VIDEO_NOT_SET_UP', message: 'Video generation is not set up yet: in the 🎬 Video tab, install ComfyUI + a video model (one click).' };
    if (a.image) notes.push('This video server makes video from text only, so the picture was not used.');
    const r = await ctx.generateVideo(a.prompt);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'VIDEO_FAILED', message: (r && r.message) || 'The video could not be made.', notes };
    return { ok: true, message: 'Saved the clip.', notes, data: { path: r.path || r.url || null } };
  },
});
// A module failure in words the AI can act on: which field, what it may be.
function videoErrorText(r) {
  if (!r) return 'The video could not be made.';
  const msg = String(r.message || r.error || 'The video could not be made.');
  const parts = [r.code === 'INVALID_PARAM' && r.field && !msg.includes(r.field) ? `${r.field}: ${msg}` : msg];
  if (r.hint && !msg.includes(r.hint)) parts.push(r.hint);
  if (r.fix && !msg.includes(r.fix)) parts.push(r.fix);
  return parts.join(' ');
}
def({
  name: 'video_call', title: 'Use the 🎬 Video module', group: 'video', changes: true, timeoutMs: 1200000,
  description: 'Any video control through the 🎬 Video module (video-api): method = a module method such as video.generate / video.animate (every setting: prompt, negativePrompt, image, width, height, seconds, frames, fps, model, steps, cfgScale, seed, sampler, scheduler, shift, characterLock), video.status/models/progress/cancel/gallery/capabilities, video.install.check/downloadModel/cancel, and any newer method the module lists. Read-only methods run directly; the rest ask first.',
  args: { type: 'object', required: ['method'], properties: { method: { type: 'string', minLength: 3, maxLength: 80 }, args: { 'x-passthrough': true } }, additionalProperties: false },
  allowAlwaysFor: () => false,
  allowKey: (a) => `video_call:${a && a.method}`,
  dynamicChanges: async (a, ctx) => { const m = await videoMethod(ctx, a.method); return m ? !!m.changes : true; },
  async check(a, ctx) {
    const m = await videoMethod(ctx, a.method);
    if (!m) return { ok: false, error: `the Video module has no method "${str(a.method, 80)}"${ctx && ctx.videoMethods && (await ctx.videoMethods()).length ? '' : ' (the 🎬 Video module is not available in this build)'}` };
    const args = a.args === undefined ? {} : a.args;
    if (m.schema) { const e = checkValue(args, m.schema, 'args'); if (e) return { ok: false, error: e }; }
    return { ok: true, args: { method: a.method, args } };
  },
  describe: (a) => `${a.method} in the 🎬 Video module${a.args && Object.keys(a.args).length ? ` with ${clip(JSON.stringify(a.args), 400)}` : ''}`,
  async run(a, ctx) {
    const r = await ctx.videoInvoke(a.method, a.args);
    if (r && r.ok === false) return { ok: false, error: str(r.code || r.error || 'FAILED', 60), message: clip(r.message || `It didn't work (${r.code || r.error || 'failed'}).`, 400) };
    return { ok: true, message: r && r.path ? 'Saved the clip.' : 'Done.', data: shrink(r), video: (r && r.path) || null };
  },
});
async function videoMethod(ctx, name) {
  if (!ctx || typeof ctx.videoMethods !== 'function') return null;
  const list = await ctx.videoMethods();
  return (list || []).find((m) => m.method === name) || null;
}

// ---- 💬 AI panes ---------------------------------------------------------------------------------
def({
  name: 'send_to_ai', title: 'Send a message to an AI pane', group: 'ais', changes: true,
  description: 'Type a message into the ChatGPT, Claude or Gemini pane (or all three) and send it.',
  args: { type: 'object', required: ['to', 'message'], properties: {
    to: { type: 'string', enum: SITES.concat(['all']) },
    message: { type: 'string', minLength: 1, maxLength: 8000 },
  }, additionalProperties: false },
  describe: (a) => `Send to ${a.to === 'all' ? 'ChatGPT, Claude and Gemini' : SITE_LABEL[a.to]}: ${q(a.message)}`,
  async run(a, ctx) {
    const sites = a.to === 'all' ? SITES : [a.to];
    const res = await ctx.sendToAi(sites, a.message);
    const failed = Object.entries(res || {}).filter(([, r]) => !r || !r.ok).map(([s, r]) => `${SITE_LABEL[s]} (${(r && r.error) || 'failed'})`);
    return failed.length ? { ok: false, error: 'SEND_FAILED', message: `Couldn't send to ${failed.join(', ')}.` } : { ok: true, message: `Sent to ${sites.map((s) => SITE_LABEL[s]).join(', ')}. Ask me to read the reply in a moment.` };
  },
});
def({
  name: 'read_latest_reply', title: 'Read the latest AI reply', group: 'ais',
  description: 'Read the latest reply captured from ChatGPT, Claude or Gemini. Read-only.',
  args: { type: 'object', required: ['from'], properties: { from: { type: 'string', enum: SITES } }, additionalProperties: false },
  async run(a, ctx) {
    const r = ctx.latestReply(a.from);
    if (!r || !r.text) return { ok: true, data: { from: SITE_LABEL[a.from], reply: null, note: 'No reply captured yet.' } };
    return { ok: true, data: { from: SITE_LABEL[a.from], at: r.ts ? new Date(r.ts).toISOString() : null, reply: clip(r.text, 4000) } };
  },
});
def({
  name: 'ai_health', title: 'AI pane health', group: 'ais',
  description: 'Show whether ChatGPT, Claude and Gemini work right now (self-repair state, problems). Read-only.',
  args: { type: 'object', properties: {}, additionalProperties: false },
  async run(_a, ctx) { return { ok: true, data: ctx.aiHealth() }; },
});
def({
  name: 'run_checkin', title: 'Run the AI check-in', group: 'ais', changes: true, allowAlways: true,
  description: 'Run the self-repair check-in on the AI panes now (sends each a short test message and repairs what it can).',
  args: { type: 'object', properties: { sites: { type: 'array', items: { type: 'string', enum: SITES }, maxItems: 3 } }, additionalProperties: false },
  describe: (a) => `Run the self-repair check-in on ${(a.sites && a.sites.length ? a.sites : SITES).map((s) => SITE_LABEL[s]).join(', ')} (each gets a short test message).`,
  async run(a, ctx) {
    const r = ctx.runCheckin(a.sites && a.sites.length ? a.sites : null);
    return { ok: true, message: `Check-in started on ${((r && r.started) || []).map((s) => SITE_LABEL[s] || s).join(', ') || 'no AI (busy or turned off)'}.` };
  },
});

// ---- 📁 Files / projects -------------------------------------------------------------------------
def({
  name: 'list_outputs', title: 'List project outputs', group: 'files',
  description: 'List files in an output folder: images, videos, books, logs or uploads. Read-only.',
  args: { type: 'object', required: ['folder'], properties: { folder: { type: 'string', enum: OUTPUT_CATEGORIES }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
  async run(a, ctx) { return { ok: true, data: await ctx.listOutputs(a.folder, a.limit || 20) }; },
});
def({
  name: 'open_output', title: 'Open an output file', group: 'files', changes: true, allowAlways: true,
  description: 'Open a file from the output folders (images, videos, books, logs, uploads) with its usual program. Programs and scripts are never opened.',
  args: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 1000 } }, additionalProperties: false },
  describe: (a) => `Open ${q(a.path)} with its usual program.`,
  async run(a, ctx) {
    const r = await ctx.openOutput(a.path);
    return r && r.ok ? { ok: true, message: 'Opened it.' } : { ok: false, error: (r && r.error) || 'OPEN_FAILED', message: (r && r.message) || "I couldn't open that file." };
  },
});
def({
  name: 'export_logs', title: 'Export logs', group: 'files', changes: true, allowAlways: true,
  description: 'Export the logs to a text file in the logs folder: "book" = this Akọwe book only, "day" = the last day, "everything".',
  args: { type: 'object', properties: { scope: { type: 'string', enum: ['book', 'day', 'everything'] }, book_id: { type: 'string', maxLength: 80 } }, additionalProperties: false },
  // "everything" holds old private conversations: it always asks, it can never be "always allowed".
  allowAlwaysFor: (a) => ((a && (a.scope || a.action)) || 'book') !== 'everything',
  allowKey: (a) => `export_logs:${(a && a.scope) || 'book'}`,
  describe: (a) => a.scope === 'everything'
    ? 'Export EVERYTHING — every saved conversation, including older private ones — to a file in the logs folder (secrets are taken out).'
    : `Export the logs (${a.scope === 'day' ? 'the last day' : 'this book only'}) to a file in the logs folder (secrets are taken out).`,
  async run(a, ctx) {
    const r = await ctx.exportLogs({ scope: a.scope || 'book', bookId: a.book_id });
    return r && r.ok ? { ok: true, message: `Saved ${r.file}.`, data: { file: r.file } } : { ok: false, error: (r && r.error) || 'EXPORT_FAILED', message: r && r.error === 'NO_BOOK' ? 'There is no Akọwe book in the logs yet — try scope "day".' : "I couldn't export the logs." };
  },
});

// ---- 🧪 Open Interpreter (optional, off by default, always asks) ----------------------------------
def({
  name: 'run_code', title: 'Run code with Open Interpreter', group: 'code', changes: true, interpreter: true, timeoutMs: 310000,
  description: 'LAST RESORT: run exact code on this computer through Open Interpreter. Only when no other tool can do it. Always shows the exact code first and asks.',
  args: { type: 'object', required: ['language', 'code', 'why'], properties: {
    language: { type: 'string', enum: ['python', 'shell', 'powershell', 'javascript'] },
    code: { type: 'string', minLength: 1, maxLength: 6000 },
    why: { type: 'string', minLength: 3, maxLength: 300 },
  }, additionalProperties: false },
  describe: (a) => `Run this ${a.language} code with Open Interpreter (${clip(a.why, 160)}):\n${a.code}`,
  async run(a, ctx) {
    const r = await ctx.interpreterRun(`Run exactly this ${a.language} code (do not change it) and report its output:\n\`\`\`${a.language}\n${a.code}\n\`\`\``);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'RUN_FAILED', message: `Open Interpreter couldn't run it (${(r && r.error) || 'unknown'}).` };
    const outs = (r.events || []).filter((e) => e.type === 'output').map((e) => clip(e.content, 1000));
    return { ok: true, data: { summary: clip(r.message, 1500), output: outs.slice(-5) } };
  },
});

// ---- 🧰 the rest of the app (alfred-app-actions.js) and the 🎨 Images module (sd-api.js) ---------------------
const appActions = require('./alfred-app-actions');
function appTool(changes) {
  return {
    name: changes ? 'app_control' : 'app_info',
    title: changes ? 'Use an app control' : 'Look something up in the app',
    group: 'app', changes, timeoutMs: 180000,
    description: changes
      ? `Any other control of AutoInjector (changes something). action: ${appActions.catalogText(true)}. args: that action's arguments (app_help shows titles and argument details).`
      : `Read anything else in AutoInjector (read-only). action: ${appActions.catalogText(false)}. args: that action's arguments (app_help shows titles and argument details).`,
    args: { type: 'object', required: ['action'], properties: { action: { type: 'string', maxLength: 60 }, args: { type: 'object', 'x-passthrough': true } }, additionalProperties: false },
    allowAlwaysFor: (a) => { const e = appActions.get(a && a.action); return !!(e && e.allowAlways); },
    allowKey: (a) => `${changes ? 'app_control' : 'app_info'}:${a && a.action}`,
    check(a) {
      const e = appActions.get(a.action);
      if (!e || e.changes !== changes) return { ok: false, error: `there is no ${changes ? 'app_control' : 'app_info'} action "${str(a.action, 60)}"` };
      const e2 = checkValue(a.args || {}, appActions.schemaOf(e), 'args');
      return e2 ? { ok: false, error: e2 } : { ok: true, args: { action: a.action, args: a.args || {} } };
    },
    describe: (a) => { const e = appActions.get(a.action); const args = a.args && Object.keys(a.args).length ? ` — ${clip(JSON.stringify(a.args), 300)}` : ''; return `${e ? e.title : a.action}${args}`; },
    async run(a, ctx) {
      const e = appActions.get(a.action);
      if (e.local) { const r = await ctx.local(e.local, a.args || {}); return r && r.ok === false ? r : { ok: true, message: `${e.title}: done.`, data: r }; }
      if (typeof ctx.invoke !== 'function') return { ok: false, error: 'NOT_WIRED', message: 'That control is not available here.' };
      const r = await ctx.invoke(e.channel, ...e.call(a.args || {}));
      if (r && r.ok === false) return { ok: false, error: str(r.error || 'FAILED', 60), message: r.message ? clip(r.message, 300) : `${e.title} didn't work (${str(r.error || 'failed', 60)}).`, data: r };
      return { ok: true, message: `${e.title}: done.`, data: r === undefined ? null : r };
    },
  };
}
def({
  name: 'app_help', title: 'What an app control does', group: 'app',
  description: 'Titles and argument details of the app_info / app_control actions (optionally only those starting with a prefix such as "routing." or "sd"). Read-only.',
  args: { type: 'object', properties: { prefix: { type: 'string', maxLength: 40 } }, additionalProperties: false },
  async run(a) { return { ok: true, data: appActions.help(a.prefix) }; },
});
def(appTool(false));
def(appTool(true));

def({
  name: 'sd_call', title: 'Use the 🎨 Images module', group: 'images', changes: true, timeoutMs: 600000,
  description: 'Any Stable Diffusion control through the 🎨 Images module (sd-api): method = a module method such as images.generate (every generation field: prompt, negativePrompt, loras, characterLock, width, height, steps, cfgScale, seed, sampler, scheduler, checkpoint, vae, count, initImage, denoise … plus, when the module supports it, extra = raw A1111 payload fields, options = /sdapi/v1/options keys, workflow = a ComfyUI workflow JSON with {{name}} parameters), images.status/progress/cancel/gallery/test, sd.status/detect/connect/targets/start/stop, sd.install.*, library.find/get/characterLock/locks/scan, and any newer method the module lists. Read-only methods run directly; the rest ask first.',
  args: { type: 'object', required: ['method'], properties: { method: { type: 'string', minLength: 3, maxLength: 80 }, args: { 'x-passthrough': true } }, additionalProperties: false },
  allowAlwaysFor: () => false,
  allowKey: (a) => `sd_call:${a && a.method}`,
  dynamicChanges: async (a, ctx) => { const m = await sdMethod(ctx, a.method); return m ? !!m.changes : true; },
  async check(a, ctx) {
    const m = await sdMethod(ctx, a.method);
    if (!m) return { ok: false, error: `the Images module has no method "${str(a.method, 80)}"${ctx && ctx.sdMethods ? '' : ' (the Images module is not available)'}` };
    const args = a.args === undefined ? (m.positional ? [] : {}) : a.args;
    if (m.schema) {
      const e = m.positional ? (Array.isArray(args) ? args.map((v, i) => checkValue(v, (m.schema.items || [])[i] || {}, `args[${i}]`)).find(Boolean) : 'args must be a list') : checkValue(args, m.schema, 'args');
      if (e) return { ok: false, error: e };
    }
    if (m.unsupported) { const bad = m.unsupported(args); if (bad) return { ok: false, error: bad }; }
    return { ok: true, args: { method: a.method, args } };
  },
  describe: (a) => `${a.method} in the 🎨 Images module${a.args && (Array.isArray(a.args) ? a.args.length : Object.keys(a.args).length) ? ` with ${clip(JSON.stringify(a.args), 400)}` : ''}`,
  async run(a, ctx) {
    const r = await ctx.sdInvoke(a.method, a.args);
    if (r && r.ok === false) return { ok: false, error: str(r.error || 'FAILED', 60), message: clip(r.message || `It didn't work (${r.error || 'failed'}).`, 400), data: r.code || r.fix || (r.warnings && r.warnings.length) ? { code: r.code ? str(r.code, 60) : undefined, fix: r.fix ? clip(r.fix, 400) : undefined, warnings: imageNotes(r.warnings) } : undefined };
    const images = r && Array.isArray(r.images) ? r.images.map((x) => x.path).filter(Boolean) : [];
    // what the Images module corrected or retried (unknown sampler, size, "made it with the basics") — Alfred should see it
    const notes = imageNotes(r && r.warnings);
    return { ok: true, message: `${images.length ? `Saved ${images.length} picture(s).` : 'Done.'}${notes.length ? ` Notes: ${clip(notes.join(' '), 600)}` : ''}`, data: shrink(r), image: images[0] || null };
  },
});
// The plain sentences of an image result's warnings (strings or {message}), at most 6.
function imageNotes(ws) { return (Array.isArray(ws) ? ws : []).map((w) => (typeof w === 'string' ? w : w && w.message)).filter(Boolean).map((m) => clip(String(m), 240)).slice(0, 6); }
async function sdMethod(ctx, name) {
  if (!ctx || typeof ctx.sdMethods !== 'function') return null;
  const list = await ctx.sdMethods();
  return (list || []).find((m) => m.method === name) || null;
}
function shrink(v) { // keep tool results small: no base64 images
  try { return JSON.parse(JSON.stringify(v === undefined ? null : v, (k, x) => (typeof x === 'string' && x.length > 2000 ? `${x.slice(0, 200)}… (${x.length} chars)` : x))); } catch (_) { return null; }
}

// Words that mean a DIRECT tool exists: Open Interpreter is refused for these.
const DIRECT_FOR = [
  [/\b(image|picture|draw|illustrat|stable diffusion|png)\b/i, 'generate_image'],
  [/\b(book|chapter|akowe|akọwe|character|story rule|profile|manuscript)\b/i, 'the book tools'],
  [/\b(chatgpt|claude|gemini)\b/i, 'send_to_ai'],
  [/\btrailer\b/i, 'make_trailer'],
  [/\b(video|clip|mp4)\b/i, 'generate_video'],
  [/\b(log|logs)\b/i, 'export_logs'],
];
function directToolFor(text) {
  for (const [re, name] of DIRECT_FOR) if (re.test(String(text || ''))) return name;
  return null;
}

// ----------------------------------------------------------------------------- schema validation
/** A validated pass-through value (settings patches, raw SD payload fields): plain JSON, bounded size and
 *  depth, safe key names. The receiving module validates the meaning. */
// keys may start with a digit: ComfyUI node ids ("3") and "<node>.<input>" params ("7.text")
const PASS_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.\- ]{0,79}$/;
function checkPassthrough(v, at) {
  let n = 0;
  const walk = (x, d, where) => {
    if (++n > 2000) return `${at} is too big`;
    if (d > 8) return `${at} is nested too deeply`;
    if (x === null || typeof x === 'boolean') return null;
    if (typeof x === 'number') return Number.isFinite(x) ? null : `${where} must be a finite number`;
    if (typeof x === 'string') return x.length > 200000 ? `${where} is too long` : null;
    if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) { const e = walk(x[i], d + 1, `${where}[${i}]`); if (e) return e; } return null; }
    if (typeof x === 'object') {
      for (const [k, val] of Object.entries(x)) {
        if (!PASS_KEY.test(k) || k === '__proto__' || k === 'constructor' || k === 'prototype') return `${where} has a key that is not allowed ("${str(k, 40)}")`;
        const e = walk(val, d + 1, `${where}.${k}`); if (e) return e;
      }
      return null;
    }
    return `${where} must be plain JSON`;
  };
  if (v === undefined) return null;
  try { if (JSON.stringify(v).length > 400000) return `${at} is too big`; } catch (_) { return `${at} must be plain JSON`; }
  return walk(v, 0, at);
}
function checkValue(v, s, at) {
  if (!s || typeof s !== 'object') return null;
  if (s['x-passthrough'] && !s.type) return checkPassthrough(v, at);
  if (s.enum && !s.enum.includes(v)) return `${at} must be one of: ${s.enum.join(', ')}`;
  switch (s.type) {
    case 'string':
      if (typeof v !== 'string') return `${at} must be text`;
      if (s.minLength != null && v.trim().length < s.minLength) return `${at} is too short`;
      if (s.maxLength != null && v.length > s.maxLength) return `${at} is too long (max ${s.maxLength} characters)`;
      return null;
    case 'integer':
      if (typeof v !== 'number' || !Number.isInteger(v)) return `${at} must be a whole number`;
      if (s.minimum != null && v < s.minimum) return `${at} must be at least ${s.minimum}`;
      if (s.maximum != null && v > s.maximum) return `${at} must be at most ${s.maximum}`;
      return null;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${at} must be a number`;
      if (s.minimum != null && v < s.minimum) return `${at} must be at least ${s.minimum}`;
      if (s.maximum != null && v > s.maximum) return `${at} must be at most ${s.maximum}`;
      return null;
    case 'boolean':
      return typeof v === 'boolean' ? null : `${at} must be true or false`;
    case 'array':
      if (!Array.isArray(v)) return `${at} must be a list`;
      if (s.maxItems != null && v.length > s.maxItems) return `${at} has too many items`;
      for (let i = 0; i < v.length; i++) { const e = checkValue(v[i], s.items, `${at}[${i}]`); if (e) return e; }
      return null;
    case 'object': {
      if (s['x-passthrough']) return checkPassthrough(v, at);
      // an open object from a module schema (e.g. a ComfyUI workflow graph): plain JSON, safe keys, size-capped
      if (!s.properties && s.additionalProperties === true) return checkPassthrough(v, at);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return `${at} must be an object`;
      if (JSON.stringify(v).length > 8000) return `${at} is too big`;
      const props = s.properties || {};
      for (const k of s.required || []) if (v[k] === undefined || v[k] === null || v[k] === '') return `${at === 'args' ? '' : at + '.'}${k} is required`;
      for (const [k, val] of Object.entries(v)) {
        if (!props[k]) { if (s.additionalProperties === false) return `unknown argument "${str(k, 40)}"`; continue; }
        const e = checkValue(val, props[k], k);
        if (e) return e;
      }
      if (!s.properties) { // a free object (story choices, sheet fields): only short text / lists of text
        for (const [k, val] of Object.entries(v)) {
          const okv = typeof val === 'string' ? val.length <= 2000 : Array.isArray(val) ? val.every((x) => typeof x === 'string' && x.length <= 400) : (val === null || typeof val === 'number' || typeof val === 'boolean');
          if (!okv) return `${at}.${str(k, 40)} must be text`;
        }
      }
      return null;
    }
    default: return null;
  }
}
/** Validate a tool call's arguments against its schema. -> { ok, args } | { ok:false, error } */
function validate(tool, args) {
  let a = args;
  if (a == null || a === '') a = {};
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_) { return { ok: false, error: 'the arguments were not valid JSON' }; } }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { ok: false, error: 'the arguments must be an object' };
  const ignored = [];
  a = tidyArgs(a, tool.args, ignored);
  // A tool may forgive its own usual slips (clamp a number, drop a value it can't use) — each one noted.
  const notes = [];
  if (typeof tool.forgive === 'function') { try { a = tool.forgive(a, notes) || a; } catch (_) { /* keep a */ } }
  const e = checkValue(a, tool.args, 'args');
  return e ? { ok: false, error: e } : Object.assign({ ok: true, args: a }, ignored.length ? { ignored } : {}, notes.length ? { notes } : {});
}
/**
 * Forgive the usual small-model slips before checking (the real limits are still checked after):
 * arguments wrapped once more ({"args": {...}}), extra keys the tool doesn't take (dropped), and
 * numbers / true-false sent as text. Required arguments are never invented. Dropped names go in `ignored`
 * (the AI is told, so nothing it meant is lost silently).
 */
function tidyArgs(a, schema, ignored = []) {
  if (!schema || schema.type !== 'object' || !schema.properties) return a;
  const props = schema.properties;
  const keys = Object.keys(a);
  if (keys.length === 1 && !props[keys[0]] && ['args', 'arguments', 'parameters', 'params', 'input'].includes(keys[0])) {
    let inner = a[keys[0]];
    if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch (_) { inner = null; } }
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) a = inner;
  }
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    const p = props[k];
    if (!p) { if (schema.additionalProperties === false) { ignored.push(String(k).slice(0, 40)); continue; } out[k] = v; continue; }
    if (typeof v === 'string' && (p.type === 'integer' || p.type === 'number') && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) out[k] = Number(v);
    else if (typeof v === 'string' && p.type === 'boolean' && /^(true|false)$/i.test(v.trim())) out[k] = v.trim().toLowerCase() === 'true';
    else if ((v === '' || v === null) && !(schema.required || []).includes(k) && p.type !== 'string') continue; // an empty optional value = not given
    else out[k] = v;
  }
  return out;
}

// ----------------------------------------------------------------------------- registry API
function get(name) { return TOOLS.find((t) => t.name === name) || null; }
function list(opts = {}) {
  return TOOLS.filter((t) => !t.interpreter || opts.interpreter).map((t) => t);
}
/** OpenAI-compatible "tools" array for the AI (the interpreter tool only when it is turned on). */
function openAiTools(opts = {}) {
  return list(opts).map((t) => ({ type: 'function', function: { name: t.name, description: `${t.description}${t.changes ? ' (Changes things: the user confirms first.)' : ''}`, parameters: t.args } }));
}
/** A short public description (UI / docs). */
function publicList(opts = {}) {
  return list(opts).map((t) => ({ name: t.name, title: t.title, group: t.group, description: t.description, changes: !!t.changes, allowAlways: !!t.allowAlways }));
}
/** May this key ("tool" or "tool:action") be "always allowed"? */
function allowableKey(key) {
  const [name, sub] = String(key || '').split(/:(.+)/);
  const t = get(name);
  if (!t || t.interpreter) return false;
  if (sub !== undefined) return typeof t.allowAlwaysFor === 'function' && !!t.allowAlwaysFor(t.name === 'sd_call' ? { method: sub } : { action: sub });
  return !t.allowAlwaysFor && !!t.allowAlways;
}
function allowKeyOf(tool, args) { return typeof tool.allowKey === 'function' ? tool.allowKey(args || {}) : tool.name; }
function canAllowAlways(tool, args) { return typeof tool.allowAlwaysFor === 'function' ? !!tool.allowAlwaysFor(args || {}) : !!tool.allowAlways; }
/** "name(a, b?, mode?: x|y)" — what a model should send, for the "arguments were not right" reply. */
function usage(tool) {
  try {
    const sch = (tool && tool.args) || {}; const props = sch.properties || {}; const req = new Set(sch.required || []);
    const parts = Object.keys(props).slice(0, 16).map((k) => {
      const p = props[k] || {};
      const kind = Array.isArray(p.enum) ? `: ${p.enum.slice(0, 8).join('|')}` : p.type ? `: ${p.type}` : '';
      return `${k}${req.has(k) ? '' : '?'}${kind}`;
    });
    return `${tool.name}({${parts.join(', ')}})`;
  } catch (_) { return tool && tool.name ? `${tool.name}({…})` : ''; }
}
function describe(tool, args) {
  try { return typeof tool.describe === 'function' ? tool.describe(args || {}) : tool.title; } catch (_) { return tool.title; }
}

module.exports = { TOOLS, SITES, SITE_LABEL, get, list, openAiTools, publicList, validate, describe, usage, directToolFor, akoweError, allowableKey, allowKeyOf, canAllowAlways, checkPassthrough, _resolveBook: resolveBook };
