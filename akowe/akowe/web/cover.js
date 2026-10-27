/* 🎨 Cover designer (plan item B3, covers): #/p/<pid>/<b>/cover. A live preview (the ebook front, or the full print
   wrap with trim / fold / safe-area guides) next to the controls: template picker, colours, cover texts, the back-cover
   blurb and author bio (kept in the book profile), the artwork (Stable Diffusion / ChatGPT through AutoInjector, or
   upload, or none), the print settings (trim, paper, page count → spine width) and the downloads. Every change
   re-renders the preview at once (POST …/cover/preview, nothing saved) and is saved a moment later (PUT …/cover).
   The helpers of app.js are passed in. API: /cover/… (cover.py, docs/COVERS.md). Styles are scoped under .cover. */

const ENGINE_WORDS = { sd: 'Stable Diffusion', chatgpt: 'ChatGPT', auto: 'the picture maker', upload: 'your upload' };
const TEXT_FIELDS = [
  ['title', 'Title', 'The book’s title. Leave empty to use the title of the book profile. A line break (Shift+Enter) breaks the title where you want.'],
  ['subtitle', 'Subtitle', 'Optional, e.g. “A novel” or the long part of a long title.'],
  ['author', 'Author', 'Leave empty to use the author of the book profile.'],
  ['series', 'Series', 'Optional, e.g. “The Harbour Cycle · Book One”.'],
  ['tagline', 'Tagline', 'Optional: one short hook line. It is also the headline of the back cover.'],
];
const COLOR_FIELDS = [['background', 'Background'], ['text', 'Text'], ['accent', 'Accent']];

function downloadBlob(h, blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function safeName(s) { return String(s || 'Book').replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, 60) || 'Book'; }

export async function viewCover(main, x) {
  const { h, clear, api, bpath, plink, S } = x;
  const where = { book: S.project.name, step: 'Cover' };
  const wrap = h('div', { class: 'cover', 'data-testid': 'cover-page' });
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    x.crumbs(['Your books', '#/'], [S.project.name, plink()], 'Cover'), h('h1', null, '🎨 Cover')),
  h('div', { class: 'row' }, x.infoTip('Cover designer',
    h('p', null, 'Pick a template, type the texts, add a picture (made by Stable Diffusion or ChatGPT through AutoInjector, or your own) — or none for a typographic cover.'),
    h('p', null, 'The ebook cover is the front alone. The print cover is the full wrap for a paperback: back, spine and front with 0.125 in bleed. The spine width comes from the page count and the paper (white 0.002252 in per page, cream 0.0025 in per page, as Amazon KDP measures it).'),
    h('p', null, 'Text stays 0.375 in inside every edge and fold. Spine text needs at least 100 pages. The back cover keeps a blank white 2 × 1.2 in box at the bottom right for the barcode.')))));
  main.appendChild(wrap);
  const body = h('div', null, x.loadingState('Loading the cover…'));
  wrap.appendChild(body);
  let d;
  try { d = await api('GET', bpath('/cover')); }
  catch (e) { clear(body).appendChild(x.problemBox(x.toProblem(e, where), { retry: () => x.route() }, 'Could not open the cover designer')); return; }

  // ------------------------------------------------------------------ state
  const draft = {
    template: d.design.template, colors: Object.assign({}, d.design.colors || {}), texts: Object.assign({}, d.design.texts || {}),
    print: Object.assign({}, d.design.print || {}), blurb: d.texts.blurb || '', author_bio: d.texts.author_bio || '',
    art_note: d.design.art_note || '', character_lock: d.design.character_lock || '', use_art: d.design.use_art !== false,
  };
  let revision = d.design.revision || 0;
  let mode = 'front';
  let previewUrl = null; let previewTimer = null; let saveTimer = null; let previewSeq = 0; let saving = false; let dirty = false;
  const tpl = id => (d.templates || []).find(t => t.id === id) || d.templates[0];

  // ------------------------------------------------------------------ preview
  const img = h('img', { class: 'cover-preview-img', alt: 'Cover preview', 'data-testid': 'cover-preview-img' });
  const previewBox = h('div', { class: 'cover-preview-box', 'data-mode': 'front', 'aria-live': 'polite' }, img);
  const previewMsg = h('div', { class: 'cover-preview-msg', 'data-testid': 'cover-preview-msg' });
  const tabFront = h('button', { type: 'button', class: 'cover-tab', 'aria-pressed': 'true', 'data-testid': 'cover-tab-front', onclick: () => setMode('front') }, 'Ebook front');
  const tabPrint = h('button', { type: 'button', class: 'cover-tab', 'aria-pressed': 'false', 'data-testid': 'cover-tab-print', onclick: () => setMode('print') }, 'Print wrap');
  const legend = h('p', { class: 'cover-legend small', hidden: true }, h('span', { class: 'lg trim' }, 'trim'), h('span', { class: 'lg fold' }, 'spine folds'), h('span', { class: 'lg safe' }, 'safe area'), ' — the guides are not printed.');
  function setMode(m) {
    mode = m; tabFront.setAttribute('aria-pressed', String(m === 'front')); tabPrint.setAttribute('aria-pressed', String(m === 'print'));
    previewBox.dataset.mode = m; legend.hidden = m !== 'print'; refreshPreview(0);
  }
  function payload() {
    return { template: draft.template, colors: draft.colors, texts: draft.texts, print: draft.print, blurb: draft.blurb,
      author_bio: draft.author_bio, art_note: draft.art_note, character_lock: draft.character_lock, use_art: draft.use_art };
  }
  async function renderPreview() {
    const seq = ++previewSeq;
    try {
      const blob = await api('POST', bpath(`/cover/preview${mode === 'print' ? '?what=print' : ''}`), { body: payload(), blob: true });
      if (seq !== previewSeq) return;
      const url = URL.createObjectURL(blob);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = url; img.src = url; img.dataset.ready = String(seq); clear(previewMsg);
      img.alt = mode === 'print' ? 'Print cover preview: back, spine and front' : 'Ebook cover preview';
    } catch (e) {
      if (seq !== previewSeq) return;
      clear(previewMsg).appendChild(x.problemBox(x.toProblem(e, where), {}, mode === 'print' ? 'The print cover cannot be shown yet' : 'The preview could not be made'));
    }
  }
  function refreshPreview(delay = 250) { clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, delay); }

  // ------------------------------------------------------------------ saving
  const saveState = h('span', { class: 'cover-save-state small', 'data-testid': 'cover-save-state', role: 'status' }, 'Saved');
  async function saveNow() {
    if (saving) { dirty = true; return; }
    saving = true; dirty = false; saveState.textContent = 'Saving…';
    try {
      d = await api('PUT', bpath('/cover'), { body: Object.assign(payload(), { revision }) });
      revision = d.design.revision; saveState.textContent = 'Saved'; showInfo();
    } catch (e) {
      saveState.textContent = 'Not saved';
      clear(msg).appendChild(x.problemBox(x.toProblem(e, where), { retry: saveNow }, 'The cover could not be saved'));
    } finally {
      saving = false;
      if (dirty) saveNow();
    }
  }
  function changed() { saveState.textContent = 'Changed…'; refreshPreview(); clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 700); }

  // ------------------------------------------------------------------ controls
  const msg = h('div', { 'aria-live': 'polite' });
  const warnBox = h('div', { class: 'cover-warnings', 'data-testid': 'cover-warnings', 'aria-live': 'polite' });

  const tplGrid = h('div', { class: 'cover-templates', role: 'group', 'aria-label': 'Templates', 'data-testid': 'cover-templates' });
  function drawTemplates() {
    clear(tplGrid);
    for (const t of d.templates) {
      const serif = t.title_font.startsWith('Times');
      tplGrid.appendChild(h('button', { type: 'button', class: 'cover-tpl', 'data-tpl': t.id, 'aria-pressed': String(draft.template === t.id), title: `${t.name}: ${t.genre}`,
        onclick: () => { draft.template = t.id; draft.colors = {}; drawTemplates(); drawColors(); changed(); } },
      h('span', { class: 'cover-tpl-swatch', style: `background:${t.colors.background};color:${t.colors.text};border-color:${t.colors.accent}`, 'aria-hidden': 'true' },
        h('span', { style: `font-family:${serif ? 'Georgia, Times New Roman, serif' : 'Helvetica, Arial, sans-serif'};${t.title_font.includes('Italic') ? 'font-style:italic;' : ''}${t.title_font.includes('Bold') ? 'font-weight:700;' : ''}` }, 'Aa'),
        h('span', { class: 'bar', style: `background:${t.colors.accent}` })),
      h('span', { class: 'cover-tpl-name' }, t.name), h('span', { class: 'cover-tpl-genre' }, t.genre, t.art === 'inset' ? ' · framed picture' : '')));
    }
  }

  const colorRow = h('div', { class: 'cover-colors' });
  function drawColors() {
    clear(colorRow);
    const t = tpl(draft.template);
    for (const [k, label] of COLOR_FIELDS) {
      const id = `cv-${k}`;
      const input = h('input', { type: 'color', id, value: draft.colors[k] || t.colors[k], 'data-testid': `cover-color-${k}`,
        oninput: ev => { draft.colors[k] = ev.target.value; changed(); } });
      colorRow.appendChild(h('div', { class: 'cover-color' }, h('label', { for: id }, label), input,
        h('button', { type: 'button', class: 'cover-mini', title: `Use the template’s ${label.toLowerCase()} colour`, 'aria-label': `Reset the ${label.toLowerCase()} colour`,
          onclick: () => { delete draft.colors[k]; input.value = t.colors[k]; changed(); } }, '↺')));
    }
  }

  const textBox = h('div', { class: 'cover-fields' });
  for (const [k, label, hint] of TEXT_FIELDS) {
    const id = `ct-${k}`;
    const ph = k === 'title' ? (d.texts.title || '') : k === 'author' ? (d.texts.author || '') : '';
    const input = k === 'title'
      ? h('textarea', { id, rows: 2, maxlength: 200, placeholder: ph, 'data-testid': `cover-text-${k}`, oninput: ev => { draft.texts[k] = ev.target.value; changed(); } })
      : h('input', { type: 'text', id, maxlength: k === 'series' ? 120 : k === 'tagline' ? 160 : 200, placeholder: ph, 'data-testid': `cover-text-${k}`, oninput: ev => { draft.texts[k] = ev.target.value; changed(); } });
    input.value = draft.texts[k] || '';
    textBox.appendChild(h('div', { class: 'cover-field' }, h('label', { for: id }, label), input, h('p', { class: 'cover-hint' }, hint)));
  }
  const blurb = h('textarea', { id: 'cb-blurb', rows: 7, maxlength: 3000, 'data-testid': 'cover-blurb', oninput: ev => { draft.blurb = ev.target.value; changed(); } });
  blurb.value = draft.blurb;
  const bio = h('textarea', { id: 'cb-bio', rows: 3, maxlength: 1500, 'data-testid': 'cover-bio', oninput: ev => { draft.author_bio = ev.target.value; changed(); } });
  bio.value = draft.author_bio;
  const fromIdea = d.idea ? h('button', { type: 'button', class: 'cover-mini', 'data-testid': 'cover-blurb-idea',
    onclick: () => { blurb.value = d.idea; draft.blurb = d.idea; changed(); } }, 'Start from the book idea') : null;
  const backBox = h('div', { class: 'cover-fields' },
    h('div', { class: 'cover-field' }, h('div', { class: 'row space' }, h('label', { for: 'cb-blurb' }, 'Back-cover blurb'), fromIdea), blurb,
      h('p', { class: 'cover-hint' }, 'Two or three short paragraphs that make a reader want the book. Kept in the book profile.')),
    h('div', { class: 'cover-field' }, h('label', { for: 'cb-bio' }, 'About the author'), bio, h('p', { class: 'cover-hint' }, 'Optional: one or two sentences.')));

  // the artwork
  const artProg = h('div', { 'aria-live': 'polite', 'data-testid': 'cover-art-progress' });
  const artThumb = h('div', { class: 'cover-art-thumb', 'data-testid': 'cover-art-thumb' });
  const artMeta = h('div', { class: 'cover-art-meta small' });
  const upscale = h('select', { id: 'ca-up', 'data-testid': 'cover-upscale' }, h('option', { value: '1' }, 'No upscale'), h('option', { value: '2' }, '× 2 (for print)'), h('option', { value: '4' }, '× 4'));
  const lock = h('select', { id: 'ca-lock', 'data-testid': 'cover-lock', onchange: ev => { draft.character_lock = ev.target.value; changed(); } },
    h('option', { value: '' }, 'No character lock'), ...(d.characters || []).map(n => h('option', { value: n, selected: n === draft.character_lock }, n)));
  const note = h('textarea', { id: 'ca-note', rows: 2, maxlength: 600, placeholder: 'e.g. a lone rider crossing white salt flats at dusk', 'data-testid': 'cover-art-note', oninput: ev => { draft.art_note = ev.target.value; changed(); } });
  note.value = draft.art_note;
  const useArt = h('input', { type: 'checkbox', id: 'ca-use', checked: draft.use_art, 'data-testid': 'cover-use-art', onchange: ev => { draft.use_art = ev.target.checked; changed(); } });
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg', hidden: true, 'data-testid': 'cover-upload-file', onchange: async ev => {
    const f = ev.target.files && ev.target.files[0]; ev.target.value = '';
    if (!f) return;
    clear(artProg);
    if (!['image/png', 'image/jpeg'].includes(f.type)) { artProg.appendChild(x.stateBox('failed', 'Only PNG and JPEG pictures can be used', h('p', null, 'Save the picture as PNG or JPEG, then upload it again.'))); return; }
    try { d = await api('PUT', bpath('/cover/art'), { raw: f, headers: { 'Content-Type': f.type } }); revision = d.design.revision; x.toast(d.message || 'Picture saved'); draft.use_art = true; useArt.checked = true; showArt(); showInfo(); refreshPreview(0); }
    catch (e) { artProg.appendChild(x.problemBox(x.toProblem(e, where), {}, 'The picture could not be saved')); }
  } });
  async function makeArt(engine) {
    if (saveTimer) { clearTimeout(saveTimer); await saveNow(); }
    const label = `Making the cover picture with ${ENGINE_WORDS[engine]}`;
    const j = await x.runAiJob('/cover/art', { engine, upscale: parseInt(upscale.value, 10) }, artProg, label);
    if (!j) return;
    d = await api('GET', bpath('/cover')); revision = d.design.revision; draft.use_art = true; useArt.checked = true;
    x.toast('Cover picture made'); showArt(); showInfo(); refreshPreview(0);
  }
  async function showArt() {
    clear(artThumb); clear(artMeta);
    const a = d.design.art;
    if (!a) { artThumb.appendChild(h('span', { class: 'cover-art-none' }, 'No picture: a typographic cover')); return; }
    try {
      const blob = await api('GET', bpath(`/assets/${encodeURIComponent(a.asset_id)}/${a.version || 1}`), { blob: true });
      const u = URL.createObjectURL(blob); S.blobUrls.push(u);
      artThumb.appendChild(h('img', { src: u, alt: 'The cover picture' }));
    } catch { artThumb.appendChild(h('span', { class: 'cover-art-none' }, 'The picture cannot be shown')); }
    artMeta.append(`Made by ${ENGINE_WORDS[a.source] || ENGINE_WORDS[a.engine] || a.source || 'you'}`,
      a.width ? ` · ${a.width} × ${a.height} px` : '', a.upscale ? ` · upscaled × ${a.upscale}` : '', a.seed ? ` · seed ${a.seed}` : '');
    for (const w of a.warnings || []) artMeta.appendChild(h('div', { class: 'cover-warn-line' }, '⚠ ', w));
  }
  const artBox = h('div', { class: 'cover-art' },
    artThumb,
    h('div', { class: 'cover-art-side' },
      h('div', { class: 'cover-actions' },
        h('button', { type: 'button', class: 'cover-btn', 'data-testid': 'cover-art-sd', onclick: () => makeArt('sd') }, '🎨 Stable Diffusion'),
        h('button', { type: 'button', class: 'cover-btn', 'data-testid': 'cover-art-gpt', onclick: () => makeArt('chatgpt') }, '💬 ChatGPT'),
        h('button', { type: 'button', class: 'cover-btn ghost', 'data-testid': 'cover-art-upload', onclick: () => fileInput.click() }, '⬆ Upload'), fileInput),
      h('div', { class: 'cover-field' }, h('label', { for: 'ca-note' }, 'What the picture shows'), note, h('p', { class: 'cover-hint' }, 'Optional. Without it the picture is made from the book idea, genre and tone. Akọwe always asks for no lettering in the picture.')),
      h('div', { class: 'cover-inline' }, h('div', { class: 'cover-field' }, h('label', { for: 'ca-up' }, 'Upscale'), upscale), h('div', { class: 'cover-field' }, h('label', { for: 'ca-lock' }, 'Character'), lock)),
      h('div', { class: 'cover-check' }, useArt, h('label', { for: 'ca-use' }, 'Use the picture on the cover')),
      artMeta, artProg));

  // print settings
  const trim = h('select', { id: 'cp-trim', 'data-testid': 'cover-trim', onchange: ev => { draft.print.trim = ev.target.value; changed(); } },
    ...(d.trims || []).map(t => h('option', { value: t.id, selected: t.id === draft.print.trim }, `${t.w_in} × ${t.h_in} in`)));
  const paper = h('select', { id: 'cp-paper', 'data-testid': 'cover-paper', onchange: ev => { draft.print.paper = ev.target.value; changed(); } },
    ...(d.papers || []).map(p => h('option', { value: p.id, selected: p.id === draft.print.paper }, `${p.label} (${p.inches_per_page} in per page)`)));
  const pages = h('input', { type: 'number', id: 'cp-pages', min: 24, max: 828, step: 1, inputmode: 'numeric', 'data-testid': 'cover-pages',
    oninput: ev => { const v = ev.target.value.trim(); const n = parseInt(v, 10); draft.print.page_count = v === '' ? null : (Number.isFinite(n) && n >= 24 && n <= 828 ? n : draft.print.page_count); if (v === '' || (n >= 24 && n <= 828)) changed(); } });
  if (draft.print.page_count) pages.value = draft.print.page_count;
  const printInfo = h('div', { class: 'cover-print-info', 'data-testid': 'cover-print-info', 'aria-live': 'polite' });
  const printBox = h('div', null,
    h('div', { class: 'cover-inline' },
      h('div', { class: 'cover-field' }, h('label', { for: 'cp-trim' }, 'Trim size'), trim),
      h('div', { class: 'cover-field' }, h('label', { for: 'cp-paper' }, 'Paper'), paper),
      h('div', { class: 'cover-field' }, h('label', { for: 'cp-pages' }, 'Pages'), pages)),
    printInfo);

  function showInfo() {
    const p = d.print || {};
    clear(printInfo);
    if (!draft.print.page_count && p.page_count) pages.placeholder = String(p.page_count);
    if (!p.ok) printInfo.appendChild(h('p', { class: 'cover-problem' }, '⚠ ', p.problem || 'The print cover needs a page count.'));
    else {
      printInfo.appendChild(h('dl', { class: 'cover-dl' },
        h('dt', null, 'Spine'), h('dd', { 'data-testid': 'cover-spine' }, `${p.spine_in.toFixed(3)} in (${p.page_count} pages × ${p.inches_per_page} in)`),
        h('dt', null, 'Full wrap'), h('dd', null, `${p.width_in.toFixed(3)} × ${p.height_in.toFixed(3)} in, with 0.125 in bleed`),
        h('dt', null, 'Spine text'), h('dd', null, p.spine_text ? 'yes' : `no (needs ${d.rules.spine_text_min_pages} pages)`)));
      for (const n of p.notes || []) printInfo.appendChild(h('p', { class: 'cover-hint' }, n));
    }
    clear(warnBox);
    for (const w of d.warnings || []) warnBox.appendChild(h('p', { class: 'cover-warn-line' }, '⚠ ', w));
  }

  // downloads
  const dlProg = h('div', { 'aria-live': 'polite', 'data-testid': 'cover-dl-msg' });
  const title = () => safeName(draft.texts.title || d.texts.title);
  async function download(path, name, label) {
    if (saveTimer) { clearTimeout(saveTimer); await saveNow(); }
    clear(dlProg);
    try { downloadBlob(h, await api('GET', bpath(path), { blob: true }), name); x.toast(`${label} downloaded`); }
    catch (e) { dlProg.appendChild(x.problemBox(x.toProblem(e, where), {}, `${label}: it could not be made`)); }
  }
  const dlBox = h('div', null,
    h('div', { class: 'cover-actions' },
      h('button', { type: 'button', class: 'cover-btn', 'data-testid': 'cover-dl-ebook', onclick: () => download('/cover/ebook?download=1', `${title()} - ebook cover.pdf`, 'Ebook cover') }, '⬇ Ebook cover (PDF)'),
      h('button', { type: 'button', class: 'cover-btn ghost', 'data-testid': 'cover-dl-svg', onclick: () => download('/cover/ebook?format=svg&download=1', `${title()} - ebook cover.svg`, 'Ebook cover') }, '⬇ Ebook cover (SVG)'),
      h('button', { type: 'button', class: 'cover-btn ghost', 'data-testid': 'cover-dl-art', onclick: () => {
        const a = d.design.art; if (!a) { clear(dlProg).appendChild(x.stateBox('empty', 'No picture yet', h('p', null, 'Make or upload a picture first.'))); return; }
        download('/cover/ebook?format=art&download=1', `${title()} - cover art.${a.mime === 'image/jpeg' ? 'jpg' : 'png'}`, 'Cover picture');
      } }, '⬇ Picture only'),
      h('button', { type: 'button', class: 'cover-btn', 'data-testid': 'cover-dl-print', onclick: () => {
        const p = d.print || {};
        download(`/cover/print?trim=${encodeURIComponent(draft.print.trim)}&paper=${encodeURIComponent(draft.print.paper)}&download=1`, `${title()} - print cover ${draft.print.trim} ${draft.print.paper}${p.page_count ? ` ${p.page_count}p` : ''}.pdf`, 'Print cover');
      } }, '⬇ Print cover (PDF)')),
    h('p', { class: 'cover-hint' }, 'Your book with this cover (made from the last export):'),
    h('div', { class: 'cover-actions' }, ...['PDF', 'EPUB', 'DOCX'].map(f => h('button', { type: 'button', class: 'cover-btn ghost', 'data-testid': `cover-book-${f.toLowerCase()}`,
      onclick: () => download(`/cover/book?format=${f}&download=1`, `${title()} (with cover).${f.toLowerCase()}`, `${f} with cover`) }, `📘 ${f}`))),
    h('p', { class: 'cover-hint' }, 'Ebook stores want a JPEG: the picture already is one when it came from AutoInjector; the SVG and PDF carry the title over it. EPUB files made here use the picture as the cover image and the typeset cover as the first page.'),
    dlProg);

  const section = (title_, testid, ...kids) => h('section', { class: 'cover-card', 'data-testid': testid }, h('h2', null, title_), ...kids);
  clear(body).append(
    h('div', { class: 'cover-grid' },
      h('div', { class: 'cover-left' },
        h('div', { class: 'cover-preview-card' }, h('div', { class: 'cover-tabs', role: 'group', 'aria-label': 'Preview' }, tabFront, tabPrint, saveState), previewBox, legend, previewMsg),
        warnBox),
      h('div', { class: 'cover-right' }, msg,
        section('Template', 'cover-sec-template', tplGrid, colorRow),
        section('Front cover text', 'cover-sec-text', textBox),
        section('Picture', 'cover-sec-art', artBox),
        section('Back cover', 'cover-sec-back', backBox),
        section('Print', 'cover-sec-print', printBox),
        section('Downloads', 'cover-sec-downloads', dlBox))));
  drawTemplates(); drawColors(); showArt(); showInfo(); renderPreview();
}
