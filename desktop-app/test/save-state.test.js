// test/save-state.test.js — 💾 Save state / 📂 Load state, the Electron-free core (save-state.js).
//   * one JSON per save in its own folder, atomic writes, safe file names, the 200-save limit, damaged files
//   * only real AI chat addresses are opened on load (anything else is refused)
//   * where a pane landed: ok / gone (404, "not found") / signed out / sent to a new chat
//   * the backup text, the cleaning of a hand-edited file, the busy question
// Run: node test/save-state.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../save-state');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'save-state-test-'));

const sampleData = () => ({
  panes: {
    chatgpt: { url: 'https://chatgpt.com/c/6720-abc', title: 'Plot', zoom: 0.9 },
    claude: { url: 'https://claude.ai/chat/1f2e-77', title: 'Salt Keeper' },
    gemini: { url: 'https://gemini.google.com/app/9a8b7c', title: 'Gemini' },
  },
  backup: S.backupOf([{ site: 'claude', text: 'Chapter 12 opens at the lighthouse.', ts: 5 }, { site: 'gemini', text: 'The salt keeper waits.', ts: 6 }]),
  setup: { enabled: { chatgpt: true, claude: true, gemini: false }, ui: { composer: 'Write chapter 12', alfredActive: true, tab: 'video', columns: { chatgpt: 'open', claude: 'reduced', gemini: 'min' }, mainRowCollapsed: true, panelsCollapsed: ['gpu', 'nope'] }, window: { width: 1600, height: 1000, maximized: false } },
  relay: { routing: { chatgpt: ['claude', 'chatgpt', 'bing'], claude: [], gemini: ['chatgpt'] }, meshActive: true, relayEnabled: true, roles: { claude: 'a strict editor' }, hopLimit: 6 },
  sequence: { steps: [{ target: 'claude', text: 'Outline ch 12' }, { target: 'nobody', text: 'x' }], at: 1, wasRunning: false },
  akowe: { project_id: 'salt-keeper', title: 'The Salt Keeper', hash: '#/p/salt-keeper/main/chapters' },
});

console.log('\n== names and ids are safe ==');
assert(S.cleanName('  Salt   Keeper\nch 12 ') === 'Salt Keeper ch 12', 'a name is one tidy line');
assert(S.cleanName('\u0000\u0007') === '', 'a name of control characters only is empty (not usable)');
assert(S.cleanName('x'.repeat(300)).length === S.MAX_NAME, `a long name is cut to ${S.MAX_NAME}`);
const id = S.makeId('../../Ẹ̀kọ́ ch 12/..\\evil', Date.UTC(2026, 10, 9, 14, 3, 7), () => 0.5);
assert(S.validId(id) && !/[./\\]/.test(id) && /^eko-ch-12-evil-20261109-140307-8000$/.test(id), `the file id has letters, digits and dashes only (${id})`);
assert(!S.validId('../x') && !S.validId('a/b') && !S.validId('') && !S.validId('.hidden'), 'ids with slashes or dots are not valid ids');

console.log('\n== only real AI chat addresses are opened ==');
const ok = (site, url, o) => S.isAllowedChatUrl(site, url, o).ok;
assert(ok('chatgpt', 'https://chatgpt.com/c/abc') && ok('chatgpt', 'https://chat.openai.com/c/abc'), 'ChatGPT: chatgpt.com and chat.openai.com');
assert(ok('claude', 'https://claude.ai/chat/abc') && ok('gemini', 'https://gemini.google.com/app/abc'), 'Claude: claude.ai · Gemini: gemini.google.com');
assert(!ok('claude', 'https://chatgpt.com/c/abc'), 'a ChatGPT address is not opened in Claude\'s pane');
assert(!ok('claude', 'http://claude.ai/chat/abc'), 'plain http is refused');
assert(!ok('claude', 'https://claude.ai.evil.com/chat/abc') && !ok('claude', 'https://evil.com/?x=claude.ai') && !ok('claude', 'https://notclaude.ai/chat'), 'look-alike hosts are refused');
assert(!ok('claude', 'https://user:pw@claude.ai/chat/abc') && !ok('claude', 'https://claude.ai:8443/chat/abc'), 'a user:password or another port is refused');
assert(!ok('claude', 'javascript:alert(1)') && !ok('claude', 'file:///etc/passwd') && !ok('claude', 'not a url') && !ok('claude', ''), 'javascript:, file:, garbage and empty are refused');
assert(!ok('bing', 'https://claude.ai/chat/x'), 'an unknown pane is refused');
const tb = 'http://127.0.0.1:4567/claude/new?site=claude';
assert(ok('claude', 'http://127.0.0.1:4567/claude/chat/x?site=claude', { testBase: tb }) && !ok('claude', 'http://127.0.0.1:9999/claude/chat/x', { testBase: tb }), 'tests: only the fake page\'s own loopback origin is allowed');
assert(!ok('claude', 'http://10.0.0.5:4567/x', { testBase: 'http://10.0.0.5:4567/' }), 'tests: a non-loopback "test page" is not trusted');

console.log('\n== where a pane landed ==');
const J = (o) => S.judgeLanding(Object.assign({ site: 'claude', wanted: 'https://claude.ai/chat/abc' }, o));
assert(J({ finalUrl: 'https://claude.ai/chat/abc', httpCode: 200 }).state === 'ok', 'same chat → ok');
assert(J({ finalUrl: 'https://claude.ai/chat/abc/', httpCode: 200 }).state === 'ok', 'a trailing slash is the same chat');
assert(J({ finalUrl: 'https://claude.ai/chat/abc', httpCode: 404 }).state === 'gone', '404 → gone');
assert(J({ finalUrl: 'https://claude.ai/chat/abc', httpCode: 200, pageSaysGone: true }).state === 'gone', 'the page says "not found" → gone');
assert(J({ finalUrl: 'https://claude.ai/new', httpCode: 200 }).state === 'new-chat', 'sent to a new chat → new-chat');
assert(J({ finalUrl: 'https://claude.ai/login?returnTo=x', httpCode: 200 }).state === 'login', 'a sign-in page → login');
assert(S.judgeLanding({ site: 'gemini', wanted: 'https://gemini.google.com/app/x', finalUrl: 'https://accounts.google.com/v3/signin', httpCode: 200 }).state === 'login', 'Google sign-in → login');
assert(J({ loadError: 'ERR_INTERNET_DISCONNECTED' }).state === 'error', 'a load error → error');
assert(J({ finalUrl: 'https://claude.ai/chat/abc', httpCode: 404, loadError: 'ERR_HTTP_RESPONSE_CODE_FAILURE' }).state === 'gone', 'a 404 that also failed to load is still "gone" (not a network problem)');
assert(S.judgeLanding({ site: 'claude', wanted: 'https://claude.ai/new', finalUrl: 'https://claude.ai/chat/new-one', httpCode: 200 }).state === 'ok', 'a saved start page that becomes a chat is fine');
const sayGone = J({ finalUrl: 'https://claude.ai/chat/abc', httpCode: 404 }).say;
assert(/Claude: that chat is gone/.test(sayGone) && /saved copy/.test(sayGone), `plain words (${sayGone})`);
assert(S.GONE_TEXT.test('Conversation not found') && S.GONE_TEXT.test("We couldn't find that chat") && S.GONE_TEXT.test('Unable to load the conversation') && !S.GONE_TEXT.test('Chapter 12: the keeper found the chat log'), '"not found" wording is recognised (and ordinary chat text is not)');

console.log('\n== backup text ==');
const tr = [];
for (let i = 0; i < 45; i++) tr.push({ site: 'claude', text: `reply ${i}`, ts: i });
tr.push({ site: 'claude', text: 'x'.repeat(50000), ts: 99 }, { site: 'user', text: 'mine' }, { site: 'gemini', text: '   ' });
const b = S.backupOf(tr);
assert(b.claude.length === 30 && b.claude[29].text.length === 12000 && b.claude[0].text === 'reply 16', `the newest 30 replies per pane, each cut to 12,000 characters (${b.claude.length})`);
assert(b.chatgpt.length === 0 && b.gemini.length === 0 && !('user' in b), 'only the three panes; empty replies dropped');

console.log('\n== cleaning (a save file may have been edited by hand) ==');
const c = S.cleanData(sampleData());
assert(JSON.stringify(c.relay.routing.chatgpt) === '["claude"]', 'routing keeps real, other panes only');
assert(c.setup.ui.panelsCollapsed.length === 1 && c.setup.ui.panelsCollapsed[0] === 'gpu', 'unknown panels are dropped');
assert(c.sequence.steps.length === 1 && c.sequence.at === 1, 'sequence steps with an unknown target are dropped');
assert(c.akowe.hash === '#/p/salt-keeper/main/chapters', 'the Akọwe book place is kept');
assert(S.cleanData({ akowe: { hash: '#/p/x?token=abc' } }).akowe === null, 'an Akọwe address with a sign-in key is never kept');
assert(S.cleanData({ setup: { ui: { tab: 'evil', columns: { claude: 'huge' }, composer: 5 } } }).setup.ui.tab === undefined, 'a bad tab / pane state is dropped');
assert(S.cleanData({ setup: { window: { width: 'a' } } }).setup.window === null, 'a bad window size is dropped');
assert(S.cleanData(null).sequence.steps.length === 0 && S.cleanData('x').relay.relayEnabled === true, 'nonsense reads as an empty save');

console.log('\n== the store: save, list, read, rename, delete ==');
let t = 1000;
const dir = path.join(TMP, 'saved-states');
const store = S.createStore({ dir, now: () => (t += 1000), max: 3 });
assert(store.list().length === 0, 'no folder yet → no saves');
let r = store.save('Salt Keeper ch 12', sampleData());
assert(r.ok && fs.existsSync(path.join(dir, `${r.id}.json`)), `saved as one JSON file (${r.id}.json)`);
const firstId = r.id;
assert(fs.readdirSync(dir).every((f) => !f.endsWith('.tmp')), 'no temp file left behind');
const text = fs.readFileSync(path.join(dir, `${r.id}.json`), 'utf8');
assert(JSON.parse(text).format === S.FORMAT && text.split('\n')[0].length < 2000, 'the file is valid JSON with a short header line');
let L = store.list();
assert(L.length === 1 && L[0].name === 'Salt Keeper ch 12' && L[0].savedAt === 2000 && L[0].summary.sites.claude.conversation === true && L[0].summary.book === 'The Salt Keeper', 'the list shows name, time and summary');
let rd = store.read(firstId);
assert(rd.ok && rd.data.panes.claude.url === 'https://claude.ai/chat/1f2e-77' && rd.data.backup.claude[0].text === 'Chapter 12 opens at the lighthouse.' && rd.data.setup.ui.composer === 'Write chapter 12', 'reading it back gives the chats, the backup text and the set-up');
r = store.save('salt keeper CH 12', sampleData());
assert(!r.ok && r.error === 'NAME_TAKEN' && /already a save called “Salt Keeper ch 12”/.test(S.sayError(r)), 'the same name (any case) is not overwritten without asking');
r = store.save('salt keeper CH 12', Object.assign(sampleData(), { setup: { ui: { composer: 'new text' } } }), { replace: true });
assert(r.ok && r.replaced && r.id === firstId && store.read(firstId).data.setup.ui.composer === 'new text' && store.list().length === 1, 'replace: true replaces it in place');
assert(!store.save('   ', {}).ok && store.save('  ', {}).error === 'NO_NAME', 'an empty name is refused');
assert(store.save('Two', {}).ok && store.save('Three', {}).ok, 'more saves');
r = store.save('Four', {});
assert(!r.ok && r.error === 'TOO_MANY' && /3 saves/.test(S.sayError(r)), `the limit (${store.max}) is kept, in plain words`);
L = store.list();
assert(L.map((x) => x.name).join(',') === 'Three,Two,salt keeper CH 12', `newest first (${L.map((x) => x.name).join(',')})`);
assert(store.find('two').ok && store.find('two').save.name === 'Two' && store.find(firstId).save.id === firstId, 'find by name (any case) or id');
assert(store.find('salt').ok && store.find('t').error === 'AMBIGUOUS', 'find by the start of a name; ambiguous when several match');
assert(store.find('nothing like it').error === 'NOT_FOUND', 'not found');
r = store.rename(firstId, 'Salt Keeper — chapter 12');
assert(r.ok && store.read(firstId).name === 'Salt Keeper — chapter 12' && store.read(firstId).data.panes.claude.url === 'https://claude.ai/chat/1f2e-77', 'rename keeps everything else');
assert(store.rename(firstId, 'two').error === 'NAME_TAKEN', 'rename to another save\'s name is refused');
assert(store.rename('../../etc/passwd', 'x').error === 'NOT_FOUND' && store.read('../x').error === 'NOT_FOUND' && store.remove('../x').error === 'NOT_FOUND', 'path tricks in an id are refused');
const twoId = store.find('Two').save.id;
assert(store.remove(twoId).ok && !store.find('Two').ok && store.remove(twoId).error === 'NOT_FOUND', 'delete');

console.log('\n== damaged files ==');
fs.writeFileSync(path.join(dir, 'broken-one.json'), '{"format":"autoinjector-saved-state","version":1,"name":"Half');
fs.writeFileSync(path.join(dir, 'not-ours.json'), '{"hello":1}');
fs.writeFileSync(path.join(dir, 'head-only.json'), '{"format":"autoinjector-saved-state",');
fs.writeFileSync(path.join(dir, 'Bad Name.json'), '{}'); // not a valid id: ignored
fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
L = store.list();
const dam = L.filter((x) => x.damaged).map((x) => x.id).sort();
assert(dam.join(',') === 'broken-one,head-only,not-ours', `damaged files are listed as damaged, not crashing the list (${dam.join(',')})`);
assert(store.read('broken-one').error === 'DAMAGED' && /damaged/.test(S.sayError({ error: 'DAMAGED' })), 'loading a damaged file says so');
assert(store.remove('broken-one').ok, 'a damaged save can be deleted');
const goodId = store.find('Three').save.id;
const full = fs.readFileSync(path.join(dir, `${goodId}.json`), 'utf8');
fs.writeFileSync(path.join(dir, `${goodId}.json`), full.slice(0, full.length - 20));
assert(store.list().find((x) => x.id === goodId) && store.read(goodId).error === 'DAMAGED', 'a cut-off file still lists by its header but will not load');
fs.writeFileSync(path.join(dir, 'newer.json'), JSON.stringify({ format: S.FORMAT, version: 99, name: 'Future', data: {} }));
assert(store.read('newer').error === 'TOO_NEW', 'a save from a newer version is not loaded');

console.log('\n== an atomic write that fails leaves the old save alone ==');
{
  const real = require('fs');
  const fake = Object.assign({}, real, { renameSync: () => { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; } });
  const s2 = S.createStore({ dir, fs: fake, now: () => 1 });
  const before = real.readFileSync(path.join(dir, `${firstId}.json`), 'utf8');
  const w = s2.save('Salt Keeper — chapter 12', {}, { replace: true });
  assert(!w.ok && w.error === 'WRITE_FAILED', 'the write fails in plain words');
  assert(real.readFileSync(path.join(dir, `${firstId}.json`), 'utf8') === before && real.readdirSync(dir).every((f) => !f.endsWith('.tmp')), 'the old file is untouched and no temp file is left');
}

console.log('\n== loading: what each pane does ==');
const bad = sampleData();
bad.panes.claude.url = 'https://evil.example.com/chat/1';
bad.panes.gemini = { url: '' };
const plan = S.planLoad(bad);
assert(plan.open.chatgpt === 'https://chatgpt.com/c/6720-abc' && !plan.open.claude && plan.refused.claude && /isn't a Claude chat address/.test(plan.refused.claude.say), 'a foreign address is refused, the real ones are opened');
assert(plan.none.includes('gemini'), 'a pane with no saved address is left as it is');

console.log('\n== busy: ask first ==');
assert(S.busyQuestion({ busy: false, why: [] }) === null, 'nothing working → no question');
const q = S.busyQuestion({ busy: true, why: ['a book is being written'] }, ['a prompt sequence is running']);
assert(q && /a book is being written, a prompt sequence is running/.test(q.message) && /Load it anyway\?/.test(q.message), `a plain question (${q && q.message})`);
assert(S.busyQuestion({ busy: false, why: [] }, ['a House Rule is running']).why.length === 1, 'extra reasons alone also ask');

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(failed ? 1 : 0);
