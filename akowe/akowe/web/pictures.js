/* 🖼 Pictures (plan item B3): chapter and scene illustrations and the map of the book's world
   (#/p/<pid>/<b>/pictures). One card for the book's art style, one for "Illustrate every chapter" (a job with
   progress and Stop), one for the map (drawn from the places as SVG, illustrated, or uploaded) and one per chapter:
   🖼 Illustrate (the whole chapter or one scene card, 1-3 candidates to pick from), ⬆ Upload, and per picture the
   candidates, a caption, alt text and where it goes in the book. The helpers of app.js are passed in.
   API: /pictures/… (pictures.py, docs/PICTURES.md). Styles are scoped under .pics (style.css). */

const ENGINES = [['auto', 'Automatic (AutoInjector picks)'], ['sd', 'Stable Diffusion'], ['chatgpt', 'ChatGPT']];
const WHERE_WORDS = { before: 'A page of its own before the chapter', start: 'Under the chapter heading', end: 'At the end of the chapter' };
const SOURCE_WORDS = { sd: 'Stable Diffusion', chatgpt: 'ChatGPT', upload: 'your picture', svg: 'drawn from your places' };

/** A picture from the book's assets as a blob URL (the asset route needs the access token, so no plain <img src>). */
async function blobUrl(x, cand) {
  if (!cand || !cand.url) return null;
  const blob = await x.api('GET', cand.url.replace(/^\/api/, ''), { blob: true });
  const typed = cand.vector ? new Blob([blob], { type: 'image/svg+xml' }) : blob;
  const url = URL.createObjectURL(typed); x.S.blobUrls.push(url);
  return url;
}

function img(x, cand, alt, cls) {
  const box = x.h('div', { class: `pics-img ${cls || ''}` }, x.h('span', { class: 'pics-img-wait', 'aria-hidden': 'true' }, '🖼'));
  blobUrl(x, cand).then(u => { if (u) { x.clear(box).appendChild(x.h('img', { src: u, alt: alt || '' })); } }).catch(() => { /* keep the placeholder */ });
  return box;
}

export async function viewPictures(main, x) {
  const { h, clear, api, bpath, plink, S } = x;
  const where = { book: S.project.name, step: 'Pictures' };
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    x.crumbs(['Your books', '#/'], [S.project.name, plink()], 'Pictures'),
    h('h1', null, '🖼 Pictures')),
  h('div', { class: 'row' }, x.infoTip('Pictures',
    h('p', null, 'Pictures for your chapters and scenes, and a map of your world, placed in the PDF, EPUB and Word files of the book.'),
    h('p', null, '🖼 Illustrate makes a picture from the scene card (where, when, who is there and what happens) with each character’s approved look from the Character Forge (Fixed visual anchors and appearance) and the character lock of the main character, in the art style you set for the book.'),
    h('p', null, 'Make 2 or 3 candidates and pick the one you like. Only a picked picture goes into the book. After a change here, put the book together again (📘 Make my book) so the files show it.'),
    h('p', null, 'The map drawn from your places is a vector drawing: it is in the PDF and the EPUB; Word files show a PNG copy that AutoInjector draws (without AutoInjector they say where to find the map). An illustrated or uploaded map is in all three.')))));
  const wrap = h('div', { class: 'pics', 'data-testid': 'pictures-page' });
  main.appendChild(wrap);
  const msg = h('div', { class: 'pics-msg', 'aria-live': 'polite' });
  const body = h('div', null, x.loadingState('Loading the pictures…'));
  wrap.append(msg, body);
  let d = null;
  const fail = (e, title) => { clear(msg).appendChild(x.problemBox(x.toProblem(e, where), {}, title)); };
  const load = async () => { d = await api('GET', bpath('/pictures')); };
  try { await load(); } catch (e) { clear(body).appendChild(x.problemBox(x.toProblem(e, where), { retry: () => x.route() }, 'Could not open the Pictures page')); return; }
  const reload = async () => { try { await load(); } catch (e) { fail(e, 'Could not reload the pictures'); } render(); };
  const engineSel = (id, label) => h('select', { id, class: 'pics-select', 'aria-label': label }, ENGINES.map(([v, t]) => h('option', { value: v }, t)));
  const runJob = async (path, jobBody, prog, label) => {
    clear(msg);
    const j = await x.runAiJob(path, jobBody, prog, label);
    if (j) { const r = (j.results || []).slice(-1)[0] || {}; x.toast(r.message || 'Done'); }
    await reload();
    return j;
  };
  const save = async (picId, change, okText) => {
    clear(msg);
    try { await api('PUT', bpath(`/pictures/${encodeURIComponent(picId)}`), { body: change }); x.toast(okText || 'Saved'); }
    catch (e) { fail(e, 'Could not save the picture'); }
    await reload();
  };
  const remove = async p => {
    const ok = await x.choiceDialog('Remove this picture?', h('p', null, 'The picture and its candidates leave the book. You can make or upload a new one any time.'), [{ id: 'yes', label: '🗑 Remove' }]);
    if (ok !== 'yes') return;
    clear(msg);
    try { const out = await api('DELETE', bpath(`/pictures/${encodeURIComponent(p.id)}`)); x.toast(out.message || 'Removed'); }
    catch (e) { fail(e, 'Could not remove the picture'); }
    await reload();
  };
  const upload = (query, label) => {
    const inp = h('input', { type: 'file', accept: 'image/png,image/jpeg', class: 'visually-hidden', 'aria-label': label });
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0]; inp.remove();
      if (!f) return;
      clear(msg);
      try { const out = await api('PUT', bpath(`/pictures/upload?${query}`), { raw: f, headers: { 'Content-Type': f.type || 'application/octet-stream' } }); x.toast(out.message || 'Picture saved'); }
      catch (e) { fail(e, 'The picture could not be saved'); }
      await reload();
    });
    document.body.appendChild(inp); inp.click();
  };

  /** One picture: the chosen one large, the candidates to pick from, caption, alt text and placement. */
  const pictureBlock = (p, scenes, label) => {
    const capId = `pc-${p.id}`; const altId = `pa-${p.id}`; const plId = `pp-${p.id}`;
    const cap = h('input', { id: capId, type: 'text', maxlength: 300, value: p.caption || '', placeholder: 'Shown under the picture (optional)' });
    const alt = h('input', { id: altId, type: 'text', maxlength: 300, value: p.alt || '', placeholder: 'What the picture shows, for readers who cannot see it' });
    const pl = h('select', { id: plId, class: 'pics-select' });
    const opts = [['before', WHERE_WORDS.before], ['start', WHERE_WORDS.start]];
    for (let n = 1; n <= Math.max(scenes, 1); n++) opts.push([`after_scene:${n}`, `After scene ${n}`]);
    opts.push(['end', WHERE_WORDS.end]);
    const cur = p.placement && p.placement.where === 'after_scene' ? `after_scene:${p.placement.scene}` : (p.placement && p.placement.where) || 'start';
    for (const [v, t] of (p.kind === 'map' ? [['before', 'A page of its own before chapter 1'], ['start', 'Under the heading of chapter 1']] : opts)) pl.appendChild(h('option', { value: v, selected: v === cur }, t));
    const chosen = p.picture;
    const src = chosen ? (SOURCE_WORDS[chosen.source] || chosen.engine || '') : '';
    const cands = h('div', { class: 'pics-cands', role: 'group', 'aria-label': `Candidates for ${label}` },
      p.candidates.map(c => h('button', { type: 'button', class: `pics-cand${c.chosen ? ' chosen' : ''}`, 'data-testid': 'pics-cand', 'aria-pressed': c.chosen ? 'true' : 'false',
        title: c.chosen ? 'This one is in the book' : 'Use this one', 'aria-label': `Candidate ${c.index + 1}${c.chosen ? ' (in the book)' : ''}`,
        onclick: () => (c.chosen ? null : save(p.id, { chosen: c.index }, 'Picked')) }, img(x, c, '', 'thumb'))));
    const saveBtn = h('button', { type: 'button', class: 'small primary', 'data-testid': 'pics-save', onclick: () => {
      const [w, n] = pl.value.split(':');
      save(p.id, { caption: cap.value, alt: alt.value, placement: w === 'after_scene' ? { where: w, scene: parseInt(n, 10) } : { where: w } });
    } }, '💾 Save');
    return h('div', { class: 'pics-pic', 'data-testid': 'pics-pic', 'data-pic': p.id },
      h('div', { class: 'pics-main' }, chosen ? img(x, chosen, p.alt || p.caption || label, 'big') :
        h('div', { class: 'pics-img big pics-none' }, h('p', null, p.candidates.length ? 'Pick one of the candidates below: only a picked picture goes into the book.' : 'No picture yet.'))),
      h('div', { class: 'pics-side' },
        h('div', { class: 'pics-title' }, label, chosen ? h('span', { class: 'pics-badge ok' }, '✔ in the book') : h('span', { class: 'pics-badge' }, 'not in the book'), src ? h('span', { class: 'muted small' }, ` · ${src}`) : null),
        p.candidates.length > 1 || !chosen ? h('div', null, h('div', { class: 'small muted' }, `${p.candidates.length} candidate(s) — click one to use it`), cands) : null,
        h('label', { for: capId }, 'Caption'), cap,
        h('label', { for: altId }, 'Alt text'), alt,
        h('label', { for: plId }, 'Where in the book'), pl,
        h('div', { class: 'row' }, saveBtn,
          chosen ? h('button', { type: 'button', class: 'small', 'data-testid': 'pics-unpick', onclick: () => save(p.id, { chosen: null }, 'Left out of the book') }, 'Leave out') : null,
          h('button', { type: 'button', class: 'small', 'data-testid': 'pics-remove', onclick: () => remove(p) }, '🗑 Remove'))));
  };

  const render = () => {
    clear(body);
    if (d.out_of_date) {
      body.appendChild(h('div', { class: 'notice warn', role: 'status', 'data-testid': 'pics-stale' }, d.out_of_date, ' ',
        h('a', { href: plink('book') }, '📘 Make my book')));
    }
    // the art style
    const styleIn = h('input', { id: 'pics-style', type: 'text', maxlength: 120, value: d.style || '', list: 'pics-styles', placeholder: 'for example ink wash, painterly, manga' });
    const styleList = h('datalist', { id: 'pics-styles' }, (d.styles || []).map(s => h('option', { value: s })));
    body.appendChild(h('section', { class: 'card pics-card', 'aria-labelledby': 'pics-style-h', 'data-testid': 'pics-style-card' },
      h('h2', { id: 'pics-style-h' }, '🎨 The book’s art style'),
      h('p', { class: 'small muted' }, 'Set once for the whole book: every picture is made in this style.'),
      h('div', { class: 'row' }, h('label', { for: 'pics-style', class: 'visually-hidden' }, 'Art style'), styleIn, styleList,
        h('button', { type: 'button', class: 'small primary', 'data-testid': 'pics-style-save', onclick: async () => {
          clear(msg);
          try { const out = await api('PUT', bpath('/pictures/style'), { body: { style: styleIn.value } }); x.toast(out.style ? `Art style: ${out.style}` : 'Art style cleared'); }
          catch (e) { fail(e, 'Could not save the art style'); }
          await reload();
        } }, '💾 Save style'))));
    // the batch
    const allEngine = engineSel('pics-all-engine', 'Picture maker for every chapter');
    const allProg = h('div', { class: 'pics-prog', 'aria-live': 'polite', 'data-testid': 'pics-all-progress' });
    const c = d.counts || {};
    const left = d.chapters.length - (c.chapters_with_picture || 0);
    body.appendChild(h('section', { class: 'card pics-card', 'aria-labelledby': 'pics-all-h', 'data-testid': 'pics-batch' },
      h('h2', { id: 'pics-all-h' }, '🖼 Illustrate every chapter'),
      h('p', { class: 'small muted', 'data-testid': 'pics-all-left' }, d.chapters.length ? `${c.chapters_with_picture || 0} of ${d.chapters.length} chapter(s) have a picture. One picture is made for each of the other ${left}; you can stop at any time and keep what is made.` : 'Plan the chapters first (📘 Make my book).'),
      h('div', { class: 'row' }, h('label', { for: 'pics-all-engine' }, 'Make with'), allEngine,
        h('button', { type: 'button', class: 'primary', 'data-testid': 'pics-all', disabled: !d.chapters.length || !left,
          onclick: () => runJob('/pictures/illustrate-all', { engine: allEngine.value }, allProg, 'Illustrating every chapter') }, '🖼 Illustrate every chapter')),
      allProg));
    // the map
    const mapEngine = engineSel('pics-map-engine', 'Picture maker for the map');
    const mapProg = h('div', { class: 'pics-prog', 'aria-live': 'polite' });
    const mapCard = h('section', { class: 'card pics-card', 'aria-labelledby': 'pics-map-h', 'data-testid': 'pics-map' },
      h('h2', { id: 'pics-map-h' }, '🗺 Map of the world'),
      h('p', { class: 'small muted' }, d.places ? `Made from your ${d.places} place(s). It goes on a page of its own before chapter 1.` : 'Your book has no places yet: make them first (🌍 world), or upload your own map.'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'small', 'data-testid': 'pics-map-svg', disabled: !d.places, onclick: async () => {
          clear(msg);
          try { const out = await api('POST', bpath('/pictures/map'), { body: { kind: 'svg' } }); x.toast('The map is drawn from your places'); if (out.message) msg.appendChild(h('p', { class: 'small muted' }, out.message)); }
          catch (e) { fail(e, 'The map could not be drawn'); }
          await reload();
        } }, '🗺 Draw from my places'),
        h('label', { for: 'pics-map-engine' }, 'or make it with'), mapEngine,
        h('button', { type: 'button', class: 'small', 'data-testid': 'pics-map-art', disabled: !d.places, onclick: () => runJob('/pictures/map', { kind: 'illustrated', engine: mapEngine.value }, mapProg, 'Making the illustrated map') }, '🎨 Illustrated map'),
        h('button', { type: 'button', class: 'small', 'data-testid': 'pics-map-up', onclick: () => upload('chapter=map', 'Upload a map') }, '⬆ Upload a map')),
      mapProg);
    if (d.map) mapCard.appendChild(pictureBlock(d.map, 1, 'Map'));
    // 🖨 Word needs a PNG copy of a drawn (SVG) map: AutoInjector draws it (POST /pictures/map {kind: 'png'})
    const pick = d.map && d.map.picture;
    if (pick && pick.vector) {
      mapCard.appendChild(pick.word_copy
        ? h('p', { class: 'small muted', 'data-testid': 'pics-map-word' }, '✔ Word files show a PNG copy of this map.')
        : h('div', { class: 'row', 'data-testid': 'pics-map-word' },
          h('span', { class: 'small muted' }, 'Word cannot show this drawn map without a PNG copy. AutoInjector draws it (it must be running).'),
          h('button', { type: 'button', class: 'small', 'data-testid': 'pics-map-png', onclick: async () => {
            clear(msg);
            try { const out = await api('POST', bpath('/pictures/map'), { body: { kind: 'png' } }); x.toast('The Word copy of the map is made'); if (out.message) msg.appendChild(h('p', { class: 'small muted' }, out.message)); }
            catch (e) { fail(e, 'The Word copy of the map could not be made'); }
            await reload();
          } }, '🖨 Make the Word copy')));
    }
    body.appendChild(mapCard);
    // the chapters
    if (!d.chapters.length) {
      body.appendChild(x.stateBox('empty', 'No chapters yet', h('p', null, 'Plan the chapters first (📘 Make my book → chapter outline); every chapter then gets its place here.')));
      return;
    }
    const list = h('div', { class: 'pics-chapters' });
    for (const ch of d.chapters) {
      const sceneSel = h('select', { id: `ps-${ch.chapter_id}`, class: 'pics-select', 'data-testid': 'pics-scene' }, h('option', { value: '' }, 'The whole chapter'),
        ch.cards.map(cd => h('option', { value: String(cd.scene) }, `Scene ${cd.scene}${cd.place ? ` — ${cd.place}` : ''}`)));
      const countSel = h('select', { id: `pn-${ch.chapter_id}`, class: 'pics-select', 'data-testid': 'pics-count' }, [1, 2, 3].map(n => h('option', { value: String(n) }, n === 1 ? '1 picture' : `${n} to choose from`)));
      const eng = engineSel(`pe-${ch.chapter_id}`, `Picture maker for chapter ${ch.number}`);
      const prog = h('div', { class: 'pics-prog', 'aria-live': 'polite' });
      const preview = h('div', { class: 'pics-preview small' });
      const card = h('section', { class: 'card pics-card pics-ch', 'aria-labelledby': `pch-${ch.chapter_id}`, 'data-testid': 'pics-chapter', 'data-cid': ch.chapter_id },
        h('div', { class: 'row space' }, h('h2', { id: `pch-${ch.chapter_id}` }, `Chapter ${ch.number}`, h('span', { class: 'pics-chtitle' }, ch.title ? ` · ${ch.title}` : '')),
          h('span', { class: `pics-badge ${ch.state === 'approved' ? 'ok' : ''}` }, ch.state === 'approved' ? 'approved' : ch.state === 'draft' ? 'draft' : 'not written')),
        h('div', { class: 'row pics-make' },
          h('label', { for: `ps-${ch.chapter_id}`, class: 'visually-hidden' }, 'Which part'), sceneSel,
          h('label', { for: `pn-${ch.chapter_id}`, class: 'visually-hidden' }, 'How many'), countSel,
          h('label', { for: `pe-${ch.chapter_id}`, class: 'visually-hidden' }, 'Picture maker'), eng,
          h('button', { type: 'button', class: 'primary small', 'data-testid': 'pics-illustrate', onclick: () => {
            const b = { chapter_id: ch.chapter_id, engine: eng.value, count: parseInt(countSel.value, 10) };
            if (sceneSel.value) b.scene = parseInt(sceneSel.value, 10);
            runJob('/pictures/illustrate', b, prog, `Illustrating chapter ${ch.number}`);
          } }, '🖼 Illustrate'),
          h('button', { type: 'button', class: 'small', 'data-testid': 'pics-upload', onclick: () => upload(`chapter=${encodeURIComponent(ch.chapter_id)}${sceneSel.value ? `&scene=${sceneSel.value}` : ''}`, `Upload a picture for chapter ${ch.number}`) }, '⬆ Upload'),
          h('button', { type: 'button', class: 'small', 'data-testid': 'pics-prompt', title: 'See what is sent to the picture maker', onclick: async () => {
            clear(preview);
            try {
              const q = `chapter=${encodeURIComponent(ch.chapter_id)}${sceneSel.value ? `&scene=${sceneSel.value}` : ''}`;
              const out = await api('GET', bpath(`/pictures/prompt?${q}`));
              preview.append(h('p', { class: 'muted' }, out.lock ? `Character lock: ${out.lock}` : 'No character lock (no character in this scene)'), h('p', { class: 'pics-prompt-text' }, out.prompt));
            } catch (e) { fail(e, 'Could not show the prompt'); }
          } }, '👁 Prompt')),
        prog, preview);
      for (const p of ch.pictures) card.appendChild(pictureBlock(p, ch.scenes, p.scene ? `Scene ${p.scene}` : 'Chapter picture'));
      list.appendChild(card);
    }
    body.appendChild(list);
  };
  render();
}
