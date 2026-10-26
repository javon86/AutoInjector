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
const AKOWE_PAGES = { book: 'book', report: 'report', grid: 'grid', journal: 'journal', world: 'world', review: 'review', home: null, shelf: null };
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
  description: 'Show a page of the book in the 📖 Akọwe tab: book (checklist), report, grid (scene grid), journal, world, review, or home/shelf. Read-only (it only changes what is shown).',
  args: { type: 'object', required: ['page'], properties: {
    page: { type: 'string', enum: Object.keys(AKOWE_PAGES) },
    project_id: { type: 'string', maxLength: 80 },
  }, additionalProperties: false },
  async run(a, ctx) {
    let hash = a.page === 'shelf' ? '#/shelf' : '#/';
    if (AKOWE_PAGES[a.page]) {
      const b = await resolveBook(ctx, a);
      if (!b.ok) return b;
      hash = `#/p/${enc(b.pid)}/main/${AKOWE_PAGES[a.page]}`;
    }
    const r = await ctx.openAkowePage(hash);
    return r && r.ok ? { ok: true, message: `Showing the ${a.page} page in the 📖 Akọwe tab.` } : { ok: false, error: (r && r.error) || 'OPEN_FAILED', message: "I couldn't show that page — is Akọwe running (📖 Akọwe tab)?" };
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
  name: 'generate_image', title: 'Generate an image', group: 'images', changes: true, allowAlways: true, timeoutMs: 240000,
  description: 'Make a picture from a description with the local image generator (Stable Diffusion). Optional size, style and character.',
  args: { type: 'object', required: ['prompt'], properties: {
    prompt: { type: 'string', minLength: 2, maxLength: 1000 },
    width: { type: 'integer', minimum: 256, maximum: 2048 },
    height: { type: 'integer', minimum: 256, maximum: 2048 },
    style: { type: 'string', maxLength: 200 },
    character: { type: 'string', maxLength: 200, description: 'A character name: their saved character lock is used when there is one' },
    negative_prompt: { type: 'string', maxLength: 1000 },
    loras: { type: 'array', maxItems: 4, items: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, weight: { type: 'number' } }, additionalProperties: false } },
  }, additionalProperties: false },
  describe: (a) => `Make an image of ${q(a.prompt)}${a.width && a.height ? ` at ${a.width}×${a.height}` : ''}${a.style ? `, style ${q(a.style)}` : ''}${a.character ? `, with ${q(a.character)} (their character lock if saved)` : ''}${a.loras && a.loras.length ? `, LoRAs ${a.loras.map((l) => l.name).join(', ')}` : ''}, and save it in the images folder.`,
  async run(a, ctx) {
    const r = await ctx.generateImage({ prompt: a.prompt, width: a.width, height: a.height, style: a.style, character: a.character, negativePrompt: a.negative_prompt, loras: a.loras });
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'IMAGE_FAILED', message: (r && r.message) || `The image couldn't be made (${(r && r.error) || 'unknown'}). Check the 🎨 Images tab.` };
    return { ok: true, message: `Saved ${r.count || 1} image(s).`, data: { path: r.path, paths: r.paths || [r.path] }, image: r.path };
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
  description: 'Whether Stable Diffusion is connected (which app, checkpoint, busy) and whether AutoInjector is running it. Read-only.',
  args: { type: 'object', properties: {}, additionalProperties: false },
  async run(_a, ctx) {
    const r = await ctx.sdStatus();
    if (!r || r.ok === false) return { ok: false, error: (r && r.error) || 'NO_IMAGES_MODULE', message: (r && r.message) || 'The image module is not available in this build.' };
    const im = r.image || {}; const mg = r.managed || {};
    return { ok: true, data: { connected: !!(im.enabled && im.endpoint), app: im.label || im.backend || null, checkpoint: im.checkpoint || im.model || null, busy: !!im.busy, started_by_autoinjector: mg.phase || null, endpoint: im.endpoint || null } };
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
  description: 'Whether video generation is set up. Read-only.',
  args: { type: 'object', properties: {}, additionalProperties: false },
  async run(_a, ctx) {
    const s = ctx.videoStatus();
    return { ok: true, data: { enabled: !!s.enabled, configured: !!s.configured, note: s.enabled && s.configured ? 'Video generation is set up.' : 'Video generation is not available yet: it needs a text-to-video backend (Setup Wizard → Video).' } };
  },
});
def({
  name: 'generate_video', title: 'Generate a video', group: 'video', changes: true, timeoutMs: 620000,
  description: 'Make a short video clip from a description — only when video generation is set up (it often is not yet).',
  args: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string', minLength: 2, maxLength: 1000 } }, additionalProperties: false },
  describe: (a) => `Make a short video of ${q(a.prompt)} and save it in the videos folder.`,
  async run(a, ctx) {
    const s = ctx.videoStatus();
    if (!s.enabled || !s.configured) return { ok: false, error: 'VIDEO_NOT_AVAILABLE', message: 'Video generation is not available yet: no text-to-video backend is set up (Setup Wizard → Video).' };
    const r = await ctx.generateVideo(a.prompt);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'VIDEO_FAILED', message: (r && r.message) || 'The video could not be made.' };
    return { ok: true, message: 'Saved the clip.', data: { path: r.path || r.url || null } };
  },
});

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
    if (r && r.ok === false) return { ok: false, error: str(r.error || 'FAILED', 60), message: clip(r.message || `It didn't work (${r.error || 'failed'}).`, 400) };
    const images = r && Array.isArray(r.images) ? r.images.map((x) => x.path).filter(Boolean) : [];
    return { ok: true, message: images.length ? `Saved ${images.length} picture(s).` : 'Done.', data: shrink(r), image: images[0] || null };
  },
});
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
  const e = checkValue(a, tool.args, 'args');
  return e ? { ok: false, error: e } : { ok: true, args: a };
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
function describe(tool, args) {
  try { return typeof tool.describe === 'function' ? tool.describe(args || {}) : tool.title; } catch (_) { return tool.title; }
}

module.exports = { TOOLS, SITES, SITE_LABEL, get, list, openAiTools, publicList, validate, describe, directToolFor, akoweError, allowableKey, allowKeyOf, canAllowAlways, checkPassthrough, _resolveBook: resolveBook };
