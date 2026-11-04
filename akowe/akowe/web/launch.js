/* 🚀 Launch kit (#/p/<pid>/<b>/launch): everything to list the book in a store (Amazon KDP and others) — the blurbs,
   the hook, the author bio, 7 keywords, 3 categories, comparable titles, age range and content notes and an A+
   content plan — made by the AI, changed by the author, and checked against the Book Bible so nothing over-promises.
   Every field is versioned: an AI answer or the author's edit is a new draft; only the author approves. Each field
   shows its ⚠️ problems (Akọwe's own check on every load; 🔎 Check with AI adds an AI reading), 🔁 Fix with AI,
   📋 Copy and the history. API: /launch/… (launch_kit.py). Styles are scoped under .lk (style.css). */
import { copyText } from './clipboard.js';

const BY = { ai: '🤖 AI', author: '✍ you', akowe: '📖 Akọwe' };

/** The plain text of a field, as the 📋 Copy button copies it (the same as launch_kit.as_text). */
export function asText(kind, v) {
  if (kind === 'text') return String(v || '').trim();
  if (kind === 'keywords' || kind === 'categories') return (v || []).filter(x => String(x).trim()).join('\n');
  if (kind === 'comps') return (v || []).filter(c => c.title).map(c => `${c.title}${c.author ? ` by ${c.author}` : ''}${c.why ? ` — ${c.why}` : ''}`).join('\n');
  if (kind === 'age') { const a = v || {}; return [a.age_range || '', ...(a.notes || [])].join('\n').trim(); }
  if (kind === 'aplus') return (v || []).map((m, i) => `Module ${i + 1}: ${m.headline || ''}\n${m.text || ''}\nPicture: ${m.image_label || m.image || 'none (text only)'}`).join('\n\n');
  return String(v || '');
}
const add = (el, ...kids) => { for (const k of kids) if (k) el.appendChild(k); return el; };
const words = t => (String(t || '').match(/[\p{L}\p{N}'’-]+/gu) || []).length;

export async function viewLaunch(main, x) {
  const { h, clear, api, bpath, plink, S } = x;
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    x.crumbs(['My books', '#/'], [S.project.name, plink('book')], ['Export', plink('export')], 'Launch kit'),
    h('h1', null, '🚀 Launch kit')),
  h('div', { class: 'row' }, x.infoTip('Launch kit',
    h('p', null, 'Everything you need to put your book in a store such as Amazon KDP: the back-cover blurb, the store description, a one-line hook, your author bio, 7 keywords, 3 categories, books like yours, the age range and an A+ content plan.'),
    h('p', null, '✨ Make the launch kit asks your AI to write it from your Book Bible. Change anything, then ✔ approve each part. Every change is kept as a version.'),
    h('p', null, 'Akọwe checks every part against your book: names that are not in it, spoilers past the point you choose, claims like “bestseller”, KDP’s keyword rules and the lengths. Each ⚠️ says how to fix it; 🔁 Fix with AI rewrites that part with the problems in mind.'),
    h('p', null, 'Categories come from Akọwe’s own list, and the comparable titles are suggestions: check them in KDP before you use them.')))));
  const wrap = h('div', { class: 'lk', 'data-testid': 'launch-page' });
  main.appendChild(wrap);
  const msg = h('div', { class: 'lk-msg', 'aria-live': 'polite' });
  const body = h('div', null, x.loadingState('Loading the launch kit…'));
  wrap.append(msg, body);
  let d = null;
  const edits = {};          // field -> the value being edited (not saved yet)
  const load = async () => { d = await api('GET', bpath('/launch')); for (const k of Object.keys(edits)) delete edits[k]; };
  try { await load(); } catch (e) { clear(body).appendChild(x.problemBox(x.toProblem(e, { book: S.project.name, step: 'Launch kit' }), { retry: () => x.route() }, 'Could not open the Launch kit')); return; }
  const fail = (e, title) => { clear(msg).appendChild(x.problemBox(x.toProblem(e, { book: S.project.name, step: 'Launch kit' }), {}, title)); };
  const anyDirty = () => Object.keys(edits).length > 0;
  const fieldOf = id => d.fields.find(f => f.id === id);
  const valueOf = f => (f.id in edits ? edits[f.id] : f.value);

  const generate = async (fields, fix, prog) => {
    if (anyDirty() && fields.some(f => f in edits)) {
      const ok = await x.choiceDialog('Replace your unsaved changes?', h('p', null, 'You changed this part but did not save it. The AI’s new version replaces what you typed (your saved versions are kept).'), [{ id: 'yes', label: '✨ Write it again' }]);
      if (ok !== 'yes') return;
    }
    clear(msg);
    const job = await x.runAiJob('/launch/generate', fields ? { fields, fix: !!fix } : {}, prog, fix ? '🔁 Fixing with AI' : '✨ Making the launch kit');
    if (!job) return;
    const r = (job.results || []).slice(-1)[0] || {};
    x.toast(r.message || 'Done');
    try { await load(); } catch (e) { fail(e, 'Could not reload the launch kit'); }
    render();
  };
  const aiCheck = async prog => {
    clear(msg);
    const job = await x.runAiJob('/launch/check', {}, prog, '🔎 Checking with AI');
    if (!job) return;
    const r = (job.results || []).slice(-1)[0] || {};
    x.toast(r.message || 'Checked');
    try { await load(); } catch (e) { fail(e, 'Could not reload the launch kit'); }
    render();
  };
  const saveField = async f => {
    clear(msg);
    try { d = await api('PUT', bpath('/launch/field'), { body: { field: f.id, value: edits[f.id], revision: d.revision } }); delete edits[f.id]; x.toast(`${f.label}: saved as a new version`); render(); }
    catch (e) { fail(e, `${f.label} could not be saved`); }
  };
  const approveField = async (f, n) => {
    if (n != null && f.issues.some(i => i.severity === 'problem')) {
      const ok = await x.choiceDialog(`Approve “${f.label}” anyway?`, h('p', null, 'Akọwe still sees a problem here (⚠️ below). You can approve it anyway if you know it is right.'), [{ id: 'yes', label: '✔ Approve anyway' }]);
      if (ok !== 'yes') return;
    }
    clear(msg);
    try { d = await api('POST', bpath('/launch/approve'), { body: { field: f.id, n, revision: d.revision } }); x.toast(n == null ? `${f.label}: not approved any more` : `${f.label}: version ${n} approved`); render(); }
    catch (e) { fail(e, `${f.label} could not be approved`); }
  };
  const setSpoiler = async v => {
    clear(msg);
    try { d = await api('PUT', bpath('/launch/settings'), { body: { spoiler_point: v, revision: d.revision } }); render(); }
    catch (e) { fail(e, 'The spoiler point could not be saved'); }
  };
  const download = async (path, name) => {
    try {
      const blob = await api('GET', bpath(path), { blob: true });
      const u = URL.createObjectURL(blob);
      const a = h('a', { href: u, download: name }); document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 4000);
      x.toast(`${name} downloaded`);
    } catch (e) { fail(e, `${name} could not be downloaded`); }
  };

  /* ---------------------------------------------------------------- the editors */
  const mark = (f, v, after) => { edits[f.id] = v; if (after) after(); };
  const counter = (f, v) => {
    const r = f.rules || {};
    if (f.kind !== 'text') return null;
    const n = words(v); const c = String(v || '').length;
    const [lo, aim, hi] = r.words || [0, 0, 1e9];
    const off = n && (n < lo || n > hi || c > r.max_chars);
    return h('span', { class: `small ${off ? 'lk-off' : 'muted'}`, 'data-testid': 'launch-count' }, `${n} words · ${c} characters (aim: about ${aim} words${r.max_chars ? `, at most ${r.max_chars} characters` : ''})`);
  };
  const editor = (f, refresh) => {
    const v = valueOf(f);
    const id = `lk-${f.id}`;
    if (f.kind === 'text') {
      const ta = h('textarea', { id, rows: f.id === 'hook' ? 2 : f.id === 'blurb_long' ? 12 : 7, 'data-testid': 'launch-text', 'aria-label': f.label }, v || '');
      const cnt = h('span', null, counter(f, v));
      ta.addEventListener('input', () => { mark(f, ta.value); clear(cnt).appendChild(counter(f, ta.value)); refresh(); });
      return h('div', { class: 'lk-ed' }, ta, cnt);
    }
    if (f.kind === 'keywords') {
      const list = (v || []).slice();
      const n = Math.max(f.rules.count || 7, list.length);
      while (list.length < n) list.push('');
      return h('ol', { class: 'lk-kw' }, list.map((k, i) => {
        const inp = h('input', { type: 'text', value: k, 'aria-label': `Keyword ${i + 1}`, 'data-testid': 'launch-keyword' });
        const c = h('span', { class: `small ${k.length > f.rules.item_max ? 'lk-off' : 'muted'}` }, `${k.length}/${f.rules.item_max}`);
        inp.addEventListener('input', () => { list[i] = inp.value; c.textContent = `${inp.value.length}/${f.rules.item_max}`; c.className = `small ${inp.value.length > f.rules.item_max ? 'lk-off' : 'muted'}`; mark(f, list.filter(s => s.trim())); refresh(); });
        return h('li', null, inp, ' ', c);
      }));
    }
    if (f.kind === 'categories') {
      const list = (v || []).slice();
      while (list.length < (f.rules.count || 3)) list.push('');
      return h('ol', { class: 'lk-cats' }, list.map((c, i) => {
        const opts = [''].concat(d.categories.includes(c) || !c ? [] : [c], d.categories);
        const sel = h('select', { 'aria-label': `Category ${i + 1}`, 'data-testid': 'launch-category' }, opts.map(o => h('option', { value: o, selected: o === c }, o || '— choose —')));
        sel.addEventListener('change', () => { list[i] = sel.value; mark(f, list.filter(s => s)); refresh(); });
        return h('li', null, sel);
      }));
    }
    if (f.kind === 'comps') {
      const list = JSON.parse(JSON.stringify(v || []));
      const box = h('div', { class: 'lk-comps' });
      const draw = () => {
        clear(box);
        box.appendChild(h('p', { class: 'notice warn small', role: 'note', 'data-testid': 'launch-comps-note' }, '🔎 Suggestions to verify: check that each book exists, is by that author and is really like yours. Akọwe cannot look them up.'));
        list.forEach((c, i) => {
          const t = h('input', { type: 'text', value: c.title, 'aria-label': `Title ${i + 1}`, placeholder: 'Title' });
          const a = h('input', { type: 'text', value: c.author, 'aria-label': `Author ${i + 1}`, placeholder: 'Author' });
          const w = h('input', { type: 'text', value: c.why, 'aria-label': `Why it is like your book ${i + 1}`, placeholder: 'Why it is like your book' });
          for (const [el, k] of [[t, 'title'], [a, 'author'], [w, 'why']]) el.addEventListener('input', () => { c[k] = el.value; mark(f, list.filter(q => q.title.trim())); refresh(); });
          box.appendChild(h('div', { class: 'row lk-comp', 'data-testid': 'launch-comp' }, t, a, w,
            h('button', { type: 'button', class: 'small', 'aria-label': `Remove comparable title ${i + 1}`, onclick: () => { list.splice(i, 1); mark(f, list.filter(q => q.title.trim())); draw(); refresh(); } }, '✕')));
        });
        box.appendChild(h('button', { type: 'button', class: 'small', onclick: () => { list.push({ title: '', author: '', why: '' }); draw(); } }, '＋ Comparable title'));
      };
      draw();
      return box;
    }
    if (f.kind === 'age') {
      const a = Object.assign({ age_range: '', notes: [] }, v || {});
      const r = h('input', { type: 'text', id: `${id}-r`, value: a.age_range, 'data-testid': 'launch-age' });
      const n = h('textarea', { id: `${id}-n`, rows: 4 }, (a.notes || []).join('\n'));
      const upd = () => { mark(f, { age_range: r.value, notes: n.value.split('\n').map(s => s.trim()).filter(Boolean) }); refresh(); };
      r.addEventListener('input', upd); n.addEventListener('input', upd);
      return h('div', { class: 'lk-ed' }, h('label', { for: `${id}-r` }, 'Age range'), r, h('label', { for: `${id}-n` }, 'Content notes (one per line)'), n);
    }
    if (f.kind === 'aplus') {
      const list = JSON.parse(JSON.stringify(v || []));
      const box = h('div', { class: 'lk-aplus' });
      const draw = () => {
        clear(box);
        list.forEach((m, i) => {
          const hd = h('input', { type: 'text', value: m.headline, 'aria-label': `Module ${i + 1} headline`, 'data-testid': 'launch-aplus-headline' });
          const tx = h('textarea', { rows: 3, 'aria-label': `Module ${i + 1} text` }, m.text || '');
          const im = h('select', { 'aria-label': `Module ${i + 1} picture`, 'data-testid': 'launch-aplus-image' },
            h('option', { value: '', selected: !m.image }, 'No picture (text only)'), d.assets.map(a => h('option', { value: a.key, selected: a.key === m.image }, a.label)));
          const upd = () => { m.headline = hd.value; m.text = tx.value; m.image = im.value || null; mark(f, list); refresh(); };
          hd.addEventListener('input', upd); tx.addEventListener('input', upd); im.addEventListener('change', upd);
          const card = h('div', { class: 'card lk-mod', 'data-testid': 'launch-aplus-module' },
            h('div', { class: 'row space' }, h('strong', null, `Module ${i + 1}`),
              h('button', { type: 'button', class: 'small', 'aria-label': `Remove module ${i + 1}`, onclick: () => { list.splice(i, 1); mark(f, list); draw(); refresh(); } }, '✕')),
            hd, tx, im);
          if (!(f.id in edits) && f.current) {   // the saved module: its picture, made by Akọwe
            const img = h('img', { class: 'lk-mod-img', alt: `A+ module ${i + 1}: ${m.headline || ''}`, 'data-testid': 'launch-aplus-preview' });
            api('GET', bpath(`/launch/aplus/${i + 1}`), { blob: true }).then(b => { const u = URL.createObjectURL(b); S.blobUrls.push(u); img.src = u; }).catch(() => img.remove());
            add(card, img, h('div', { class: 'row' },
              h('button', { type: 'button', class: 'small', onclick: () => download(`/launch/aplus/${i + 1}?download=1`, `a-plus-module-${i + 1}.svg`) }, '⬇ SVG'),
              h('button', { type: 'button', class: 'small', title: 'Drawn by AutoInjector (it must be running)', onclick: () => download(`/launch/aplus/${i + 1}?format=jpg&download=1`, `a-plus-module-${i + 1}.jpg`) }, '⬇ JPG')));
          }
          box.appendChild(card);
        });
        if (list.length < 5) box.appendChild(h('button', { type: 'button', class: 'small', onclick: () => { list.push({ headline: '', text: '', image: null }); mark(f, list); draw(); refresh(); } }, '＋ Module'));
      };
      draw();
      return box;
    }
    return h('p', null, '');
  };

  const issueList = f => {
    const ai = d.ai_check && !d.ai_check.stale ? (d.ai_check.issues || []).filter(i => i.field === f.id) : [];
    const all = f.issues.concat(ai);
    if (!all.length) return f.current ? h('p', { class: 'small lk-ok', 'data-testid': 'launch-ok' }, '✅ Akọwe found no problems here.') : null;
    return h('ul', { class: 'lk-issues', 'data-testid': 'launch-issues' }, all.map(i => h('li', { class: `lk-issue ${i.severity}`, 'data-kind': i.kind },
      h('span', null, `⚠️ ${i.by === 'ai' ? '🤖 ' : ''}${i.message}`), h('span', { class: 'small lk-fix' }, ` Fix: ${i.fix}`))));
  };

  const fieldCard = f => {
    const v = valueOf(f);
    const st = f.approved && f.approved === f.current && !(f.id in edits) ? ['✔', `Approved (version ${f.approved})`, 'ok']
      : f.current ? ['📝', `Draft — version ${f.current} by ${BY[f.by] || f.by}${f.approved ? ` (version ${f.approved} is approved)` : ''}`, 'warn'] : ['○', 'Not made yet', 'muted'];
    const actions = h('div', { class: 'row lk-actions' });
    const prog = h('div', { 'aria-live': 'polite' });
    const card = h('section', { class: 'card lk-field', id: `lk-f-${f.id}`, 'data-testid': 'launch-field', 'data-field': f.id, 'aria-labelledby': `lk-h-${f.id}` },
      h('div', { class: 'row space' }, h('h2', { id: `lk-h-${f.id}` }, f.label), x.badge ? x.badge(st[0], st[1], st[2]) : h('span', { class: `badge ${st[2]}`, 'data-testid': 'launch-state' }, `${st[0]} ${st[1]}`)),
      h('p', { class: 'small muted' }, f.help));
    const drawActions = () => {
      clear(actions);
      const dirty = f.id in edits;
      const hasIssues = f.issues.length || (d.ai_check && !d.ai_check.stale && (d.ai_check.issues || []).some(i => i.field === f.id));
      add(actions,
        dirty ? h('button', { type: 'button', class: 'primary small', 'data-testid': 'launch-save', onclick: () => saveField(f) }, '💾 Save my changes') : null,
        dirty ? h('button', { type: 'button', class: 'small', onclick: () => { delete edits[f.id]; render(); } }, '↩ Undo my changes') : null,
        !dirty && f.current && f.approved !== f.current ? h('button', { type: 'button', class: 'small', 'data-testid': 'launch-approve', onclick: () => approveField(f, f.current) }, `✔ Approve version ${f.current}`) : null,
        !dirty && f.approved ? h('button', { type: 'button', class: 'small', 'data-testid': 'launch-unapprove', onclick: () => approveField(f, null) }, '↩ Not approved') : null,
        f.ai ? h('button', { type: 'button', class: 'small', 'data-testid': 'launch-regen', onclick: () => generate([f.id], !!hasIssues && !!f.current, prog) }, hasIssues && f.current ? '🔁 Fix with AI' : (f.current ? '🔁 Write it again' : '✨ Write it')) : null,
        h('button', { type: 'button', class: 'small', 'data-testid': 'launch-copy', disabled: !asText(f.kind, valueOf(f)), onclick: () => copyText(asText(f.kind, valueOf(f)), `${f.label} copied`) }, '📋 Copy'),
        ['blurb_short', 'blurb_long', 'author_bio'].includes(f.id) && f.current && !dirty ? h('button', { type: 'button', class: 'small', title: 'Put this text on the back cover (🎨 Cover page)', onclick: async () => {
          try { await api('POST', bpath('/launch/use-on-cover'), { body: { field: f.id } }); x.toast(`${f.label}: now on the back cover`); } catch (e) { fail(e, 'The back cover could not be changed'); }
        } }, '📕 Use on the back cover') : null);
    };
    add(card, editor(f, drawActions), issueList(f), actions, prog);
    if ((f.versions || []).length > 1) {
      const sel = h('select', { 'aria-label': `${f.label}: earlier versions`, 'data-testid': 'launch-history' }, h('option', { value: '' }, `${f.versions.length} versions — show one…`),
        f.versions.slice().reverse().map(ver => h('option', { value: String(ver.n) }, `Version ${ver.n} · ${BY[ver.by] || ver.by}${ver.n === f.approved ? ' · ✔ approved' : ''} · ${new Date(ver.at).toLocaleString()}`)));
      sel.addEventListener('change', () => { const ver = f.versions.find(y => String(y.n) === sel.value); if (!ver) return; edits[f.id] = JSON.parse(JSON.stringify(ver.value)); x.toast(`Version ${ver.n} is in the editor: 💾 Save it to use it again`); render(); });
      card.appendChild(h('div', { class: 'row small' }, sel));
    }
    drawActions();
    void v;
    return card;
  };

  const render = () => {
    clear(body);
    const top = h('section', { class: 'card lk-top', 'aria-labelledby': 'lk-top-h', 'data-testid': 'launch-top' }, h('h2', { id: 'lk-top-h' }, d.fields.some(f => f.current) ? 'Your launch kit' : 'Make your launch kit'));
    const b = d.book || {};
    top.appendChild(h('p', { class: 'small muted' }, [b.title, b.author ? `by ${b.author}` : '(no pen name yet: set it in the book profile)', b.genre, b.audience].filter(Boolean).join(' · ')));
    const spId = 'lk-spoiler';
    const sp = h('select', { id: spId, 'data-testid': 'launch-spoiler' }, d.spoiler_points.map(o => h('option', { value: o.id, selected: o.id === d.spoiler_point }, o.label)));
    sp.addEventListener('change', () => setSpoiler(sp.value));
    add(top, h('div', { class: 'row' }, h('label', { for: spId }, 'Tell readers nothing past'), sp),
      h('p', { class: 'small muted', 'data-testid': 'launch-cut' }, d.chapters ? (d.cut < d.chapters ? `Chapters 1–${d.cut} may be told; chapters ${d.cut + 1}–${d.chapters} stay secret (the AI writing the kit never sees them).` : 'The whole book may be told: no spoiler check.') : 'The book has no chapter outline yet, so there is nothing to keep secret.'));
    const n = d.problems; const all = d.checks;
    top.appendChild(h('p', { class: `lk-sum ${n ? 'lk-off' : ''}`, 'data-testid': 'launch-summary' }, !d.fields.some(f => f.current) ? 'Nothing made yet.' : n ? `⚠️ ${n} problem(s) to fix and ${all - n} thing(s) to check.` : all ? `⚠️ ${all} thing(s) to check — no real problems.` : '✅ Akọwe’s own check found no problems.'));
    if (d.ai_check) top.appendChild(h('p', { class: 'small', 'data-testid': 'launch-ai-check' }, d.ai_check.stale ? '🔎 The AI check is out of date (the kit changed since): check again.' : `🔎 Checked by ${d.ai_check.slot_label || 'the AI'}${d.ai_check.independent ? '' : ' (the same AI that wrote it: not independent)'}: ${(d.ai_check.issues || []).length} thing(s) found.`));
    const prog = h('div', { 'aria-live': 'polite', 'data-testid': 'launch-progress' });
    const made = d.fields.some(f => f.current);
    add(top, h('div', { class: 'row lk-actions' },
      h('button', { type: 'button', class: made ? 'small' : 'primary', 'data-testid': 'launch-generate', onclick: () => generate(null, false, prog) }, made ? '✨ Write it all again' : '✨ Make the launch kit'),
      h('button', { type: 'button', class: 'small', 'data-testid': 'launch-ai-check-btn', disabled: !made, onclick: () => aiCheck(prog) }, '🔎 Check with AI'),
      h('button', { type: 'button', class: 'small', 'data-testid': 'launch-download', disabled: !made, onclick: () => download('/launch/export.md', `${S.project.name} - launch kit.md`) }, '⬇ launch-kit.md'),
      x.quickSave ? h('button', { type: 'button', class: 'small', 'data-testid': 'launch-save-folder', disabled: !made, onclick: ev => x.quickSave(ev.currentTarget) }, '💾 Save to the book folder') : null), prog,
    h('p', { class: 'small muted' }, `💾 Save writes a “${d.folder}” folder in the book’s folder: launch-kit.md and one .txt file per part, ready to copy and paste.`));
    body.appendChild(top);
    for (const f of d.fields) body.appendChild(fieldCard(f));
  };
  render();
}
