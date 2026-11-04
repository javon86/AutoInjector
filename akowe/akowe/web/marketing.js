/* 📣 Mockups & ads (idea #17, #/p/<pid>/<b>/marketing): pictures and short clips to sell the book, made from its
   🎨 cover. The words card (the hook and the call to action), the buttons (🖼 Make the pictures, 🎬 Make the teaser
   clips, ⬇ Download all), then a gallery: 📚 mockups (3D paperback / hardcover / stack / series, phone, tablet,
   e-reader — each see-through and on a background), 📣 ads in the sizes the stores ask for, 🎬 teaser clips.
   A picture not made yet shows its live drawing (SVG); a made one its PNG / JPG; a made one whose cover or words
   changed since says so ("out of date") and is made again with the button. The helpers of app.js are passed in.
   API: /marketing/… (marketing.py). Styles are scoped under .mkt (style.css). */

const MK_PROBLEMS = {
  IMAGE_BRIDGE_UNREACHABLE: ['AutoInjector is not connected', 'The pictures and clips are drawn by AutoInjector, and Akọwe could not reach it. The SVG drawings still download.'],
  IMAGE_BRIDGE_KEY: ['AutoInjector did not accept the key', 'AutoInjector refused the request because the bridge key is missing or wrong.'],
  RENDER_NOT_WIRED: ['This AutoInjector cannot draw pictures yet', 'Update AutoInjector. The SVG drawings still download.'],
  VIDEO_NOT_WIRED: ['This AutoInjector cannot make clips', 'Update AutoInjector to a version that makes clips from pictures (🎬 Video → 🎞 Trailer).'],
  BUSY: ['AutoInjector is already making a video', 'Only one trailer or clip is made at a time.'],
  TRAILER_JOIN_FAILED: ['The clip could not be put together', 'AutoInjector drew the pictures but could not join them into a video.'],
  VIDEO_BAD_ANSWER: ['No usable clip came back', 'AutoInjector answered, but Akọwe could not read a clip from it.'],
  TRAILER_LOST: ['AutoInjector restarted while making the clip', 'AutoInjector no longer knows the clip it was making.'],
};
const GROUPS = [
  ['mockup', '📚 Mockups', 'Your book as a real object: for your website, posts, newsletters and flyers.'],
  ['ad', '📣 Ads', 'Ready-made pictures in the exact sizes each place asks for, with your hook and a call to action.'],
  ['clip', '🎬 Teaser clips', 'Short videos (13 seconds) for stories, Reels and posts.'],
];

function saveBlob(h, blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function viewMarketing(main, x) {
  const { h, clear, api, bpath, plink, S } = x;
  const where = { book: S.project.name, step: 'Mockups & ads' };
  const problem = (e, step) => {
    const p = x.toProblem(e, Object.assign({}, where, step ? { step } : {}));
    const t = MK_PROBLEMS[p.code];
    return t ? Object.assign({}, p, { title: t[0], what: t[1], action: ['IMAGE_BRIDGE_UNREACHABLE', 'IMAGE_BRIDGE_KEY'].includes(p.code) ? 'settings' : 'retry' }) : p;
  };
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    x.crumbs(['Your books', '#/'], [S.project.name, plink()], 'Mockups & ads'),
    h('h1', null, '📣 Mockups & ads')),
  h('div', { class: 'row' }, h('a', { class: 'btn', href: plink('cover'), 'data-testid': 'mk-cover-link' }, '🎨 Cover'),
    x.infoTip('Mockups & ads',
      h('p', null, 'Pictures and short clips to sell your book, made from your 🎨 cover: the book standing on a table, on a phone or an e-reader, ads in the sizes Instagram, Facebook, X, Amazon and BookBub ask for, and 13-second teaser clips.'),
      h('p', null, 'The words come from your 🚀 launch kit’s hook when there is one, else your cover’s tagline, else your book idea. Type your own if you like.'),
      h('p', null, 'AutoInjector draws the pictures (PNG and JPG) and joins the clips. Without it, every picture still downloads as an SVG drawing.'),
      h('p', null, 'When you change the cover or the words, the files made before are marked “out of date”: make them again with one press.')))));
  const wrap = h('div', { class: 'mkt', 'data-testid': 'marketing-page' });
  main.appendChild(wrap);
  const msg = h('div', { class: 'mkt-msg', 'aria-live': 'polite' });
  const body = h('div', null, x.loadingState('Loading the mockups…'));
  wrap.append(msg, body);
  let d = null;
  const load = async () => { d = await api('GET', bpath('/marketing')); };
  try { await load(); } catch (e) { clear(body).appendChild(x.problemBox(problem(e), { retry: () => x.route() }, 'Could not open Mockups & ads')); return; }

  const blobUrl = async (path) => {
    const b = await api('GET', path.replace(/^\/api/, ''), { blob: true });
    const u = URL.createObjectURL(b); (S.blobUrls || (S.blobUrls = [])).push(u); return u;
  };
  const download = async (path, name, btn) => {
    if (btn) btn.disabled = true;
    try { const b = await api('GET', path.replace(/^\/api/, ''), { blob: true }); saveBlob(h, b, name); }
    catch (e) { clear(msg).appendChild(x.problemBox(problem(e), {}, 'The file could not be downloaded')); }
    finally { if (btn) btn.disabled = false; }
  };
  const safe = s => String(s || 'Book').replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, 40) || 'Book';
  const stem = () => safe(d.cover.title || S.project.name);

  // a background job (pictures or clips), like the trailer's
  const runJob = async (prog, start, what) => {
    clear(msg);
    let job;
    try { job = await start(); }
    catch (e) { clear(prog).appendChild(x.problemBox(problem(e), {}, `The ${what} could not start`)); return; }
    const line = h('span', { 'data-testid': 'mk-phase' });
    const bar = h('progress', { max: 1, value: 0, class: 'mkt-bar', 'aria-label': `${what} made` });
    const stop = h('button', { type: 'button', class: 'small', 'data-testid': 'mk-stop', onclick: async () => {
      stop.disabled = true; try { await api('POST', bpath(`/review/ai/${encodeURIComponent(job.job_id)}/cancel`)); } catch { /* it ends anyway */ }
    } }, '⏹ Stop');
    clear(prog).appendChild(h('div', { class: 'state loading', role: 'status' }, h('p', { class: 'row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), line, stop), bar));
    const show = j => { line.textContent = `${j.phase || `Making the ${what}`}…`; bar.value = j.total ? Math.min(1, (j.done || 0) / j.total) : 0; };
    show(job);
    while (!['done', 'error', 'cancelled'].includes(job.status)) {
      await new Promise(r => setTimeout(r, 700));
      if (!document.contains(prog)) return;
      try { job = await api('GET', bpath(`/review/ai/${encodeURIComponent(job.job_id)}`)); } catch { continue; }
      show(job);
    }
    clear(prog);
    if (job.status === 'error') { prog.appendChild(x.problemBox(problem(job.error || {}), { retry: () => runJob(prog, start, what) }, (MK_PROBLEMS[(job.error || {}).code] || [])[0] || `The ${what} could not be made`)); return; }
    if (job.status === 'cancelled') { prog.appendChild(x.stateBox('empty', 'Stopped', h('p', null, 'What was already made is kept.'))); }
    const fails = (job.results || []).filter(r => r.ok === false && r.piece);
    for (const f of fails) prog.appendChild(h('p', { class: 'small notice warn' }, `⚠ ${f.message}`));
    const last = (job.results || []).slice(-1)[0];
    if (job.status === 'done') x.toast((last && last.message) || 'Done');
    try { await load(); } catch { /* shown below */ }
    render(prog);
  };

  // ------------------------------------------------------------------ the words
  const wordsCard = () => {
    const w = d.words;
    const SRC = { 'launch kit': 'your 🚀 launch kit’s hook', 'cover tagline': 'your cover’s tagline', 'book idea': 'your book’s one-line idea', none: 'nothing yet' };
    const hook = h('input', { id: 'mk-hook', type: 'text', maxlength: d.limits.hook, value: w.hook_source === 'yours' ? w.hook : '', placeholder: w.auto_hook || 'One short line that makes a reader want the book', 'data-testid': 'mk-hook' });
    const ctaList = h('datalist', { id: 'mk-cta-choices' }, (d.cta_choices || []).map(c => h('option', { value: c })));
    const cta = h('input', { id: 'mk-cta', type: 'text', maxlength: d.limits.cta, value: w.cta, list: 'mk-cta-choices', 'data-testid': 'mk-cta' });
    const from = h('p', { class: 'small muted', 'data-testid': 'mk-hook-source' }, w.hook_source === 'yours' ? 'Your own words.' : `Empty: Akọwe uses ${SRC[w.auto_source] || 'the book'}${w.auto_hook ? ` — “${w.auto_hook}”` : ''}.`);
    const save = h('button', { type: 'button', class: 'small', 'data-testid': 'mk-save-words', onclick: async () => {
      save.disabled = true; clear(msg);
      try { d = await api('PUT', bpath('/marketing'), { body: { hook: hook.value.trim() || null, cta: cta.value.trim() || null, revision: d.revision } }); x.toast('Words saved'); render(); }
      catch (e) { save.disabled = false; clear(msg).appendChild(x.problemBox(problem(e), {}, 'The words could not be saved')); }
    } }, '💾 Save the words');
    return h('section', { class: 'card mkt-card', 'aria-labelledby': 'mk-words-h', 'data-testid': 'mk-words' },
      h('h2', { id: 'mk-words-h' }, '✏️ The words on the ads'),
      h('label', { for: 'mk-hook' }, 'Hook (one short line)'), hook, from,
      h('label', { for: 'mk-cta' }, 'Call to action'), cta, ctaList,
      h('p', { class: 'small muted' }, 'The Amazon picture has no words at all (Amazon does not allow added words on it).'),
      h('div', { class: 'row' }, save));
  };

  // ------------------------------------------------------------------ the buttons
  const actionsCard = (prog) => {
    const animate = h('input', { id: 'mk-animate', type: 'checkbox', checked: !!d.animate, disabled: !d.has_art, 'data-testid': 'mk-animate' });
    const make = h('button', { type: 'button', class: 'primary', 'data-testid': 'mk-make', onclick: () => runJob(prog, () => api('POST', bpath('/marketing/make'), { body: {} }), 'pictures') },
      d.made_count ? '🖼 Make the pictures again' : '🖼 Make the pictures');
    const clips = h('button', { type: 'button', 'data-testid': 'mk-clips', onclick: () => runJob(prog, () => api('POST', bpath('/marketing/clips'), { body: { animate: !!animate.checked } }), 'teaser clips') }, '🎬 Make the teaser clips');
    const zip = h('button', { type: 'button', 'data-testid': 'mk-zip', onclick: () => download(bpath('/marketing/zip'), `${stem()} - mockups and ads.zip`, zip) }, '⬇ Download all (zip)');
    return h('section', { class: 'card mkt-card', 'aria-labelledby': 'mk-act-h', 'data-testid': 'mk-actions' },
      h('h2', { id: 'mk-act-h' }, '🖨 Make them'),
      h('p', { class: 'small muted' }, 'AutoInjector draws the pictures (a few seconds each) and joins the clips (about a minute each). You can keep working meanwhile.'),
      h('div', { class: 'row mkt-actions' }, make, clips, zip),
      h('p', { class: 'small row' }, animate, h('label', { for: 'mk-animate' }, 'Bring the cover picture to life in the clips (needs 🎬 Video set up in AutoInjector; a few minutes more)')),
      d.has_art ? null : h('p', { class: 'small muted' }, 'Your cover has no picture, so the clips use the still cover.'),
      prog);
  };

  // ------------------------------------------------------------------ the gallery
  const status = p => {
    if (!p.made) return h('span', { class: 'badge', 'data-testid': 'mk-status', 'data-state': 'none' }, 'Not made yet');
    if (p.out_of_date) return h('span', { class: 'badge b-warn', 'data-testid': 'mk-status', 'data-state': 'stale' }, '⚠ Out of date');
    return h('span', { class: 'badge b-ok', 'data-testid': 'mk-status', 'data-state': 'made' }, '✔ Made');
  };
  const pieceCard = (p, prog) => {
    const fig = h('div', { class: `mkt-fig${p.transparent ? ' checker' : ''}`, style: `aspect-ratio:${p.width} / ${p.height}` });
    const card = h('article', { class: 'card mkt-piece', 'data-testid': 'mk-piece', 'data-id': p.id, 'data-group': p.group }, fig,
      h('h3', null, p.label), h('p', { class: 'small' }, p.line),
      h('p', { class: 'small muted row' }, `${p.width} × ${p.height}${p.group === 'clip' ? '' : ` · ${p.raster.toUpperCase()}`}`, status(p)));
    if (p.out_of_date) card.appendChild(h('p', { class: 'small notice warn', 'data-testid': 'mk-why' }, `Out of date: ${p.out_of_date_why.join('; ')}.`));
    for (const w of (p.made && p.made.warnings) || []) card.appendChild(h('p', { class: 'small muted' }, `⚠ ${w}`));
    if (p.note) card.appendChild(h('p', { class: 'small muted mkt-note' }, p.note));
    const btns = h('div', { class: 'row mkt-btns' });
    if (p.group === 'clip') {
      if (p.made && p.made.url) {
        const vid = h('video', { class: 'mkt-video', controls: true, muted: true, playsinline: true, preload: 'metadata', 'aria-label': p.label, 'data-testid': 'mk-video' });
        fig.appendChild(vid);
        blobUrl(p.made.url).then(u => { vid.src = u; }).catch(() => fig.classList.add('no-play'));
        const bw = h('button', { type: 'button', class: 'small', 'data-testid': 'mk-dl', onclick: () => download(`${p.made.file_url}?format=webm&download=1`, `${stem()} - ${p.label}.webm`, bw) }, '⬇ WebM');
        btns.appendChild(bw);
        if (p.made.mp4_url) { const bm = h('button', { type: 'button', class: 'small', 'data-testid': 'mk-dl-mp4', onclick: () => download(`${p.made.file_url}?format=mp4&download=1`, `${stem()} - ${p.label}.mp4`, bm) }, '⬇ MP4'); btns.appendChild(bm); }
      } else fig.appendChild(h('p', { class: 'mkt-empty muted small' }, '🎬 Not made yet'));
      btns.appendChild(h('button', { type: 'button', class: 'small', 'data-testid': 'mk-make-one', onclick: () => runJob(prog, () => api('POST', bpath('/marketing/clips'), { body: { clips: [p.id] } }), 'teaser clip') }, p.made ? '🔁 Make again' : '🎬 Make this clip'));
    } else {
      const img = h('img', { alt: `${p.label} of ${S.project.name}`, loading: 'lazy', 'data-testid': 'mk-img' });
      fig.appendChild(img);
      const usesMade = p.made && !p.out_of_date;
      blobUrl(usesMade ? p.made.url : p.svg_url).then(u => { img.src = u; img.dataset.src = usesMade ? 'made' : 'svg'; }).catch(() => fig.classList.add('no-play'));
      if (p.made) {
        const b = h('button', { type: 'button', class: 'small', 'data-testid': 'mk-dl', onclick: () => download(`${p.made.file_url}?download=1`, `${stem()} - ${p.label}.${p.raster}`, b) }, `⬇ ${p.raster.toUpperCase()}`);
        btns.appendChild(b);
      }
      const bs = h('button', { type: 'button', class: 'small', 'data-testid': 'mk-dl-svg', onclick: () => download(`${p.svg_url}?download=1`, `${stem()} - ${p.label}.svg`, bs) }, '⬇ SVG');
      btns.appendChild(bs);
      btns.appendChild(h('button', { type: 'button', class: 'small', 'data-testid': 'mk-make-one', onclick: () => runJob(prog, () => api('POST', bpath('/marketing/make'), { body: { pieces: [p.id] } }), 'picture') }, p.made ? '🔁 Make again' : '🖼 Make this one'));
    }
    card.appendChild(btns);
    return card;
  };

  const render = (keepProg) => {
    clear(body);
    const prog = keepProg || h('div', { class: 'mkt-prog', 'aria-live': 'polite', 'data-testid': 'mk-progress' });
    if (!d.cover.designed) body.appendChild(h('div', { class: 'notice', role: 'note', 'data-testid': 'mk-no-cover' }, 'Your cover is not designed yet, so these use a plain cover. ', h('a', { href: plink('cover') }, '🎨 Design the cover'), ' first for the real thing.'));
    else if (!d.cover.print_wrap) body.appendChild(h('p', { class: 'small muted', 'data-testid': 'mk-no-wrap' }, 'The spine is drawn by Akọwe until the print cover knows the page count (🎨 Cover → Print). Then the mockups show your real spine.'));
    if (d.out_of_date) body.appendChild(h('div', { class: 'notice warn', role: 'status', 'data-testid': 'mk-stale' }, `⚠️ ${d.out_of_date_count} file(s) are out of date: your cover or the words changed since they were made. Press 🖼 Make the pictures again${d.pieces.some(p => p.group === 'clip' && p.out_of_date) ? ' and 🎬 Make the teaser clips' : ''} to make them new.`));
    body.append(h('div', { class: 'mkt-top' }, wordsCard(), actionsCard(prog)));
    for (const [g, title, lead] of GROUPS) {
      const items = d.pieces.filter(p => p.group === g);
      if (!items.length) continue;
      body.appendChild(h('section', { class: 'mkt-group', 'aria-label': title, 'data-testid': `mk-group-${g}` }, h('h2', null, title), h('p', { class: 'small muted' }, lead),
        h('div', { class: 'mkt-grid' }, items.map(p => pieceCard(p, prog)))));
    }
  };
  render();
}
