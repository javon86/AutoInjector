/* 🎞 Book trailer (plan item B2, #/p/<pid>/<b>/trailer): a 30-40 second trailer of the book made by AutoInjector's
   🎬 Video module — shots (short videos made from the book's scenes, or its pictures brought to life) joined with
   title cards. One card shows the trailer (player, length, when it was made); one is the plan: 🎬 Plan a trailer
   builds 5-8 shots from the book (the logline, key scenes, the place and the characters' looks from the Character
   Forge), the author edits every shot and card (↑ ↓ ✕, + shot, + title card, music), then 🎞 Make the trailer runs it
   as a background job (progress: which shot AutoInjector is making; Stop). The helpers of app.js are passed in.
   API: /trailer/… (trailer.py). Styles are scoped under .trl (style.css). */

// Plain words for every code a trailer job can end with (the server's fix is shown with them).
const TRAILER_PROBLEMS = {
  VIDEO_NOT_SET_UP: ['AutoInjector cannot make video yet', 'AutoInjector has no video maker set up, so no shot could be made.'],
  VIDEO_MODEL_MISSING: ['The video model is not downloaded yet', 'AutoInjector’s video maker is set up, but its video model is not on this computer yet.'],
  VIDEO_OOM: ['The graphics card ran out of memory', 'A shot needed more graphics memory than was free.'],
  VIDEO_TIMEOUT: ['A shot took too long', 'AutoInjector gave up waiting for a shot.'],
  VIDEO_CANCELLED: ['The trailer was stopped in AutoInjector', 'The trailer was stopped before it was finished.'],
  VIDEO_FAILED: ['A shot could not be made', 'AutoInjector’s video maker stopped with a problem (its reason is shown).'],
  UNSUPPORTED_ON_BACKEND: ['This video maker cannot bring a picture to life', 'The video maker AutoInjector uses makes video from text only.'],
  VIDEO_NOT_WIRED: ['This AutoInjector cannot make trailers', 'The AutoInjector that answered has no 🎞 Trailer in its 🎬 Video tab.'],
  VIDEO_BAD_ANSWER: ['No usable trailer came back', 'AutoInjector answered, but Akọwe could not read a trailer file from it.'],
  TRAILER_JOIN_FAILED: ['The shots were made, but joining them failed', 'AutoInjector made every shot but could not join them into one video.'],
  TRAILER_LOST: ['AutoInjector restarted while making the trailer', 'AutoInjector no longer knows the trailer it was making.'],
  BUSY: ['AutoInjector is already making a trailer', 'Only one trailer is made at a time.'],
  INVALID_PARAM: ['AutoInjector did not accept the plan', 'Something in the shots or title cards was not accepted.'],
  NO_LOCK: ['No character lock', 'AutoInjector has no character lock with this name.'],
  IMAGE_BRIDGE_UNREACHABLE: ['AutoInjector cannot be reached', 'Akọwe could not reach AutoInjector to make the trailer.'],
  IMAGE_BRIDGE_KEY: ['AutoInjector did not accept the key', 'AutoInjector refused the request because the bridge key is missing or wrong.'],
};

export async function viewTrailer(main, x) {
  const { h, clear, api, bpath, plink, S } = x;
  const where = { book: S.project.name, step: 'Trailer' };
  const problem = (e, step) => {
    const p = x.toProblem(e, Object.assign({}, where, step ? { step } : {}));
    const t = TRAILER_PROBLEMS[p.code];
    return t ? Object.assign({}, p, { title: t[0], what: t[1], action: ['IMAGE_BRIDGE_UNREACHABLE', 'IMAGE_BRIDGE_KEY'].includes(p.code) ? 'settings' : 'retry' }) : p;
  };
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    x.crumbs(['Your books', '#/'], [S.project.name, plink()], 'Trailer'),
    h('h1', null, '🎞 Book trailer')),
  h('div', { class: 'row' }, x.infoTip('Book trailer',
    h('p', null, 'A short trailer of your book: video shots of its world, its key scenes and its main character, joined with title cards (the title, the one-line idea, “Coming soon”).'),
    h('p', null, '🎬 Plan a trailer builds the shots from the book: the scene cards of key chapters (never the ending), each character’s approved look from the Character Forge, and the chapter pictures you chose (they are brought to life). Change anything before you make it.'),
    h('p', null, 'AutoInjector’s 🎬 Video makes the shots one by one (a few minutes each) and joins them. If you stop, the shots already made are kept: making it again continues where it stopped.')))));
  const wrap = h('div', { class: 'trl', 'data-testid': 'trailer-page' });
  main.appendChild(wrap);
  const msg = h('div', { class: 'trl-msg', 'aria-live': 'polite' });
  const body = h('div', null, x.loadingState('Loading the trailer…'));
  wrap.append(msg, body);
  let d = null;
  let items = [];
  let music = '';
  let dirty = false;
  const fail = (e, title) => { clear(msg).appendChild(x.problemBox(problem(e), {}, title)); };
  const load = async () => {
    d = await api('GET', bpath('/trailer'));
    items = JSON.parse(JSON.stringify((d.plan && d.plan.items) || []));
    music = (d.plan && d.plan.music) || '';
    dirty = false;
  };
  try { await load(); } catch (e) { clear(body).appendChild(x.problemBox(problem(e), { retry: () => x.route() }, 'Could not open the Trailer page')); return; }

  const planBody = () => ({ items: items.map(it => (it.type === 'card'
    ? { type: 'card', text: it.text || '', subtitle: it.subtitle || '', seconds: Number(it.seconds) || 3 }
    : { type: 'shot', prompt: it.prompt || '', seconds: Number(it.seconds) || 4, character: it.character || null, picture: it.picture || null, label: it.label || '' })),
  music: music || null });
  const savePlan = async (quiet) => {
    clear(msg);
    try { d = await api('PUT', bpath('/trailer/plan'), { body: planBody() }); dirty = false; if (!quiet) x.toast('Plan saved'); return true; }
    catch (e) { fail(e, 'The plan could not be saved'); return false; }
  };
  const planFromBook = async () => {
    if (items.length) {
      const ok = await x.choiceDialog('Plan the trailer again from the book?', h('p', null, 'The shots and title cards below are replaced by a new plan made from the book. Your changes to them are lost.'), [{ id: 'yes', label: '🎬 Plan it again' }]);
      if (ok !== 'yes') return;
    }
    clear(msg);
    try {
      const out = await api('POST', bpath('/trailer/plan'));
      d = out; items = JSON.parse(JSON.stringify(out.plan.items)); music = out.plan.music || ''; dirty = false;
      x.toast(`Planned: ${out.shots} shots, ${out.seconds} s`);
      for (const n of out.notes || []) msg.appendChild(h('p', { class: 'small muted' }, n));
    } catch (e) { fail(e, 'The trailer could not be planned'); }
    render();
  };
  // the job: like runAiJob, with the trailer's own words for every problem
  const make = async (prog) => {
    clear(msg);
    let job;
    try { job = await api('POST', bpath('/trailer/make'), { body: planBody() }); }
    catch (e) { clear(prog).appendChild(x.problemBox(problem(e), {}, 'The trailer could not start')); return; }
    dirty = false;
    const line = h('span', { 'data-testid': 'trailer-phase' });
    const bar = h('progress', { max: 1, value: 0, class: 'trl-bar', 'aria-label': 'Shots made' });
    const stop = h('button', { type: 'button', class: 'small', 'data-testid': 'trailer-stop', onclick: async () => {
      stop.disabled = true; try { await api('POST', bpath(`/review/ai/${encodeURIComponent(job.job_id)}/cancel`)); } catch { /* it ends anyway */ }
    } }, '⏹ Stop');
    clear(prog).appendChild(h('div', { class: 'state loading', role: 'status' }, h('p', { class: 'row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), line, stop), bar,
      h('p', { class: 'small' }, 'Each shot takes a few minutes in AutoInjector. You can keep working; this keeps running.')));
    const show = j => { line.textContent = `${j.phase || 'Making the trailer'}… ${x.fmtClock ? x.fmtClock(j.elapsed_ms || 0) : ''}`; bar.value = j.total ? Math.min(1, (j.done || 0) / j.total) : 0; };
    show(job);
    while (!['done', 'error', 'cancelled'].includes(job.status)) {
      await new Promise(r => setTimeout(r, 1000));
      if (!document.contains(prog)) return;
      try { job = await api('GET', bpath(`/review/ai/${encodeURIComponent(job.job_id)}`)); } catch { continue; }
      show(job);
    }
    clear(prog);
    if (job.status === 'error') prog.appendChild(x.problemBox(problem(job.error || {}), { retry: () => make(prog), retryLabel: '🎞 Make the trailer again' }, (TRAILER_PROBLEMS[(job.error || {}).code] || [])[0] || 'The trailer could not be made'));
    else if (job.status === 'cancelled') prog.appendChild(x.stateBox('empty', 'Stopped', h('p', null, 'The shots AutoInjector already made are kept: 🎞 Make the trailer continues where it stopped.')));
    else { const r = (job.results || []).slice(-1)[0] || {}; x.toast(r.message || 'Trailer made'); try { await load(); } catch { /* shown below */ } render(); }
  };

  const player = () => {
    const t = d.trailer;
    const card = h('section', { class: 'card trl-card', 'aria-labelledby': 'trl-h', 'data-testid': 'trailer-card' }, h('h2', { id: 'trl-h' }, '🎞 Your trailer'));
    if (!t || !(t.webm || t.mp4)) {
      card.appendChild(h('p', { class: 'muted', 'data-testid': 'trailer-none' }, 'No trailer yet. Plan it below, change what you like, then press 🎞 Make the trailer.'));
      return card;
    }
    const vid = h('video', { class: 'trl-video', controls: true, playsinline: true, preload: 'metadata', 'data-testid': 'trailer-video', 'aria-label': `Trailer of ${S.project.name}` });
    const src = t.webm || t.mp4;  // WebM plays in every browser Akọwe runs in; the MP4 is for sharing (💾 Save)
    x.api('GET', src.url.replace(/^\/api/, ''), { blob: true }).then(b => { const u = URL.createObjectURL(b); x.S.blobUrls.push(u); vid.src = u; }).catch(() => card.classList.add('no-play'));
    const when = t.at ? new Date(t.at).toLocaleString() : '';
    card.append(vid, h('p', { class: 'small muted', 'data-testid': 'trailer-meta' }, [t.seconds ? `${t.seconds} s` : null, t.width ? `${t.width}×${t.height}` : null, t.shots != null ? `${t.shots} shots` : null, t.mp4 ? 'MP4 + WebM' : 'WebM', when ? `made ${when}` : null].filter(Boolean).join(' · ')));
    if (d.out_of_date) card.appendChild(h('div', { class: 'notice warn', role: 'status', 'data-testid': 'trailer-stale' }, 'The plan changed since this trailer was made: press 🎞 Make the trailer to make it again (unchanged shots are kept).'));
    for (const w of t.warnings || []) card.appendChild(h('p', { class: 'small muted' }, `⚠ ${w}`));
    card.appendChild(h('p', { class: 'small muted' }, '💾 Save puts it in the book’s folder (Trailer/).'));
    return card;
  };

  const itemRow = (it, i) => {
    const n = items.slice(0, i + 1).filter(y => y.type === it.type).length;
    const title = it.type === 'shot' ? `🎬 Shot ${n}` : `🔤 Title card ${n}`;
    const mark = () => { dirty = true; renderTotal(); };
    const move = dlt => () => { const j = i + dlt; if (j < 0 || j >= items.length) return; const [y] = items.splice(i, 1); items.splice(j, 0, y); dirty = true; render(); };
    const head = h('div', { class: 'row space trl-item-head' }, h('strong', null, title, it.label ? h('span', { class: 'muted trl-label' }, ` · ${it.label}`) : null),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'small', title: 'Move up', 'aria-label': `Move ${title} up`, disabled: i === 0, onclick: move(-1) }, '↑'),
        h('button', { type: 'button', class: 'small', title: 'Move down', 'aria-label': `Move ${title} down`, disabled: i === items.length - 1, onclick: move(1) }, '↓'),
        h('button', { type: 'button', class: 'small', 'data-testid': 'trailer-remove', 'aria-label': `Remove ${title}`, onclick: () => { items.splice(i, 1); dirty = true; render(); } }, '✕')));
    const sid = `trl-s-${i}`;
    const secs = h('input', { id: sid, type: 'number', min: 1, max: it.type === 'shot' ? 5 : 10, step: 0.5, value: it.seconds, class: 'trl-secs', 'data-testid': 'trailer-seconds' });
    secs.addEventListener('input', () => { it.seconds = Number(secs.value) || 0; mark(); });
    const row = h('div', { class: 'card trl-item', 'data-testid': 'trailer-item', 'data-type': it.type }, head);
    if (it.type === 'card') {
      const tid = `trl-t-${i}`; const uid = `trl-u-${i}`;
      const tx = h('input', { id: tid, type: 'text', maxlength: 120, value: it.text || '', 'data-testid': 'trailer-card-text' });
      const sub = h('input', { id: uid, type: 'text', maxlength: 160, value: it.subtitle || '', placeholder: 'optional', 'data-testid': 'trailer-card-subtitle' });
      tx.addEventListener('input', () => { it.text = tx.value; mark(); });
      sub.addEventListener('input', () => { it.subtitle = sub.value; mark(); });
      row.append(h('label', { for: tid }, 'Text'), tx, h('label', { for: uid }, 'Small line'), sub, h('div', { class: 'row' }, h('label', { for: sid }, 'Seconds'), secs));
    } else {
      const pid_ = `trl-p-${i}`; const cid = `trl-c-${i}`;
      const ta = h('textarea', { id: pid_, rows: 3, maxlength: 1200, 'data-testid': 'trailer-prompt' }, it.prompt || '');
      ta.addEventListener('input', () => { it.prompt = ta.value; mark(); });
      const ch = h('input', { id: cid, type: 'text', maxlength: 120, value: it.character || '', placeholder: 'none', 'data-testid': 'trailer-character' });
      ch.addEventListener('input', () => { it.character = ch.value.trim() || null; mark(); });
      row.append(h('label', { for: pid_ }, it.picture ? 'How the picture moves' : 'What happens'), ta);
      if (it.picture) row.appendChild(h('p', { class: 'small row', 'data-testid': 'trailer-picture' }, it.picture.kind === 'portrait' ? '🖼 The character’s portrait is brought to life' : '🖼 The chapter’s chosen picture is brought to life',
        h('button', { type: 'button', class: 'small', onclick: () => { it.picture = null; dirty = true; render(); } }, 'Use words only')));
      row.append(h('div', { class: 'row trl-shot-opts' }, h('label', { for: sid }, 'Seconds'), secs, h('label', { for: cid }, 'Character lock'), ch));
    }
    return row;
  };

  let totalEl = null;
  const renderTotal = () => {
    if (!totalEl) return;
    const s = items.filter(y => y.type === 'shot').length;
    const secs = items.reduce((a, y) => a + (Number(y.seconds) || 0), 0);
    totalEl.textContent = `${s} shot(s), ${items.length - s} title card(s) · ${Math.round(secs * 10) / 10} s${dirty ? ' · not saved yet' : ''}`;
  };
  const render = () => {
    clear(body);
    body.appendChild(player());
    const prog = h('div', { class: 'trl-prog', 'aria-live': 'polite', 'data-testid': 'trailer-progress' });
    totalEl = h('span', { class: 'small muted', 'data-testid': 'trailer-total' });
    const musicId = 'trl-music';
    const mus = h('input', { id: musicId, type: 'text', value: music, placeholder: 'No music — or the full path of a music file on this computer (.mp3, .ogg, .wav …)', 'data-testid': 'trailer-music' });
    mus.addEventListener('input', () => { music = mus.value.trim(); dirty = true; renderTotal(); });
    const planCard = h('section', { class: 'card trl-card', 'aria-labelledby': 'trl-plan-h', 'data-testid': 'trailer-plan' },
      h('div', { class: 'row space' }, h('h2', { id: 'trl-plan-h' }, '🎬 The plan'),
        h('button', { type: 'button', class: items.length ? 'small' : 'primary', 'data-testid': 'trailer-plan-book', onclick: planFromBook }, items.length ? '🎬 Plan it again from the book' : '🎬 Plan a trailer')),
      items.length ? h('p', { class: 'small muted' }, 'Change any shot or title card. A shot is 1–5 seconds; a title card 1–10.') :
        h('p', { class: 'muted', 'data-testid': 'trailer-empty' }, 'No plan yet. 🎬 Plan a trailer makes 5–8 shots from your book (its scenes, places and characters) with title cards; you can change all of it.'));
    const list = h('div', { class: 'trl-items' }, items.map(itemRow));
    planCard.appendChild(list);
    planCard.append(
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'small', 'data-testid': 'trailer-add-shot', onclick: () => { items.push({ type: 'shot', prompt: '', seconds: 4, character: null, picture: null, label: '' }); dirty = true; render(); } }, '＋ Shot'),
        h('button', { type: 'button', class: 'small', 'data-testid': 'trailer-add-card', onclick: () => { items.push({ type: 'card', text: S.project.name, subtitle: '', seconds: 3 }); dirty = true; render(); } }, '＋ Title card'),
        totalEl),
      h('label', { for: musicId }, 'Music (optional)'), mus,
      h('div', { class: 'row trl-actions' },
        h('button', { type: 'button', class: 'small', 'data-testid': 'trailer-save', disabled: !items.length, onclick: async () => { if (await savePlan()) render(); } }, '💾 Save the plan'),
        h('button', { type: 'button', class: 'primary', 'data-testid': 'trailer-make', disabled: !items.length, onclick: () => make(prog) }, d.trailer ? '🎞 Make the trailer again' : '🎞 Make the trailer')),
      prog);
    body.appendChild(planCard);
    renderTotal();
  };
  render();
}
