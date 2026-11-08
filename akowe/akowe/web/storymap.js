/* 🗺 Story map (story_map.py): the Book Bible's connections — who is family, who loves or hates whom, who knows which
   secret, who owns what, who lives where, clues and subplots — as a live, editable map. #/p/<pid>/<b>/storymap.
   Data: GET …/storymap (nodes = the Book Bible's own entries, links L1, L2…, conflicts, gap warnings). Drawn with
   vanilla JS + SVG (no library): a small force layout seeded by the positions the author dragged (saved with the
   book, PUT …/storymap/positions), zoom and pan, labels capped so 100+ entries stay readable. Solid line = a rule
   (✔ approved or 🔒 locked = on the page), dotted = a draft, red = a conflict to decide, ★ = the main character.
   Everything is drawn with DOM APIs (no innerHTML with book data). The helpers of app.js are passed in. */

const NS = 'http://www.w3.org/2000/svg';
const W = 1000, H = 640;                 // the layout space (the same as the binder's picture)
const LABELS = 40;                       // names always shown (the best-connected first); the rest on zoom / hover
const STATUS = { draft: ['Draft', 'Suggested — not a rule yet. Approve it to make it one.'],
  approved: ['✔ Approved', 'You approved it: a rule the writer keeps.'],
  locked: ['🔒 Locked', 'It is on the page in a written chapter: a rule. It never changes silently.'] };

function s(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, String(v));
  for (const c of kids) if (c !== null && c !== undefined) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}
const clip = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export async function viewStoryMap(main, x) {
  const { h, clear, api, bpath, plink, S } = x;
  const where = { book: S.project.name, step: 'Story map' };
  const lsKey = `bf:storymap:${S.pid}:${S.branch}`;
  const saved = (() => { try { return JSON.parse(localStorage.getItem(lsKey) || '{}') || {}; } catch { return {}; } })();
  const keep = () => { try { localStorage.setItem(lsKey, JSON.stringify({ kinds: [...st.kinds], problems: st.problems })); } catch { /* private mode */ } };
  let data;
  const load = async () => { data = await api('GET', bpath('/storymap')); };
  try { await load(); }
  catch (e) { main.appendChild(x.problemBox(x.toProblem(e, where), { retry: () => x.route() }, 'Could not open the story map')); return; }

  const st = { kinds: new Set(Array.isArray(saved.kinds) && saved.kinds.length ? saved.kinds : Object.keys(data.node_kinds)),
    problems: !!saved.problems, asOf: null, sel: null, form: null, zoom: 1, tx: 0, ty: 0, find: '' };
  const pos = new Map();
  const msg = h('div', { 'aria-live': 'polite', class: 'sm-msg' });
  const fail = (e, title) => clear(msg).appendChild(x.problemBox(x.toProblem(e, where), {}, title));
  async function call(method, path, body, title) {
    clear(msg);
    try {
      const out = await api(method, bpath('/storymap' + path), { body: Object.assign({ version: data.version }, body || {}) });
      if (out && out.message) x.toast(out.message);
      await load();
      draw();
      return out;
    } catch (e) { fail(e, title); return null; }
  }

  /* ------------------------------------------------------------------ head */
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    x.crumbs(['My books', '#/'], [S.project.name, plink('book')], ['Book Bible', plink('bible')], 'Story map'),
    h('h1', null, '🗺 Story map')),
  h('div', { class: 'row' }, x.infoTip('Story map',
    h('p', null, 'Who is connected to whom in your book: family, love and hate, friends and enemies, who works for whom, who knows which secret, who owns what, who lives where, clues and subplots.'),
    h('p', null, 'After every chapter is written, the AI that updates the running notes also reads the chapter’s connections. New ones arrive as drafts (dotted lines). Anything the chapter shows on the page is 🔒 locked — the same rule as every other detail already on the page.'),
    h('p', null, 'Click a line or a circle to see where it comes from. ✔ Approve a draft to make it a rule. Approved and locked connections go to the writer of every chapter they matter for, and the checks flag a chapter that breaks one (by its code, like L12).'),
    h('p', null, 'If a chapter seems to change a locked or approved connection, nothing is changed: it shows in red for you to decide.')),
  h('a', { class: 'btn small', href: plink('bible') }, '📖 Back to the Book Bible'))));

  const summary = h('p', { class: 'sm-summary', 'data-testid': 'sm-summary' });
  const kindsBox = h('div', { class: 'sm-kinds', role: 'group', 'aria-label': 'Show these kinds of entries' });
  const asOf = h('input', { type: 'range', min: '0', max: '0', value: '0', id: 'sm-asof', 'data-testid': 'sm-asof', 'aria-describedby': 'sm-asof-words' });
  const asOfWords = h('span', { id: 'sm-asof-words', class: 'sm-asof-words', 'data-testid': 'sm-asof-words' });
  const probs = h('input', { type: 'checkbox', id: 'sm-problems', 'data-testid': 'sm-only-problems', checked: st.problems });
  const find = h('input', { type: 'search', id: 'sm-find', placeholder: 'Find a name…', 'aria-label': 'Find a name on the map', class: 'sm-find' });
  const kindsSum = h('summary', { class: 'sm-kinds-sum', 'data-testid': 'sm-kinds-sum' }, 'Show: everything');
  const tools = h('div', { class: 'sm-tools card' },
    h('details', { class: 'sm-tool sm-kinds-pop' }, kindsSum, kindsBox),
    h('div', { class: 'sm-tool sm-asof' }, h('label', { for: 'sm-asof', class: 'sm-tool-h' }, 'As of chapter'), asOf, asOfWords),
    h('div', { class: 'sm-tool' }, h('label', { class: 'sm-check' }, probs, ' Only problems')),
    h('div', { class: 'sm-tool' }, find),
    h('div', { class: 'sm-tool sm-btns' },
      h('button', { type: 'button', class: 'small', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => zoomBy(1.25) }, '＋'),
      h('button', { type: 'button', class: 'small', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => zoomBy(0.8) }, '－'),
      h('button', { type: 'button', class: 'small', 'data-testid': 'sm-fit', title: 'Show the whole map', onclick: () => { st.zoom = 1; st.tx = 0; st.ty = 0; applyView(); } }, '⤢ Fit'),
      h('button', { type: 'button', class: 'small', 'data-testid': 'sm-relayout', title: 'Forget where you dragged things and lay the map out again', onclick: relayout }, '↺ Tidy up'),
      h('button', { type: 'button', class: 'small primary', 'data-testid': 'sm-add-link', disabled: data.read_only ? true : null, onclick: () => { st.form = { type: 'add' }; st.sel = null; drawCard(); } }, '＋ Connection'),
      h('button', { type: 'button', class: 'small', 'data-testid': 'sm-add-node', title: 'Add a secret, a clue or a subplot', onclick: () => { st.form = { type: 'node' }; st.sel = null; drawCard(); } }, '＋ Secret / clue / subplot')));
  const legend = h('div', { class: 'sm-legend', 'aria-label': 'What the colours and lines mean' });
  const svg = s('svg', { class: 'sm-svg', viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Story map', 'data-testid': 'sm-svg', preserveAspectRatio: 'xMidYMid meet' });
  const stage = s('g', { class: 'sm-stage' });
  svg.appendChild(stage);
  const card = h('aside', { class: 'sm-card card', 'data-testid': 'sm-card', 'aria-live': 'polite', 'aria-label': 'Details' });
  const listBox = h('details', { class: 'card sm-list', 'data-testid': 'sm-list' });
  const root = h('div', { class: 'storymap', 'data-testid': 'storymap' }, summary, msg, tools,
    h('div', { class: 'sm-body' }, h('div', { class: 'sm-canvas' }, svg, legend), card), listBox);
  main.appendChild(root);

  asOf.addEventListener('input', () => { st.asOf = Number(asOf.value) >= Number(asOf.max) ? null : Number(asOf.value); draw(); });
  probs.addEventListener('change', () => { st.problems = probs.checked; keep(); draw(); });
  find.addEventListener('input', () => { st.find = find.value.trim().toLowerCase(); drawMap(); });

  /* ------------------------------------------------------------------ data helpers */
  const nodeBy = () => new Map(data.nodes.map(n => [n.id, n]));
  const kindLabel = k => (data.kinds[k] || data.kinds.other).label;
  const nodeKind = k => data.node_kinds[k] || data.node_kinds.other;
  const linkActive = lk => {
    if (st.asOf === null) return !lk.ended;
    const since = lk.since || 0, ended = lk.ended || Infinity;
    return since <= st.asOf && ended > st.asOf;
  };
  function problemSets() {
    const ns = new Set(), ls = new Set();
    for (const g of data.gaps || []) { for (const n of g.nodes || []) if (n) ns.add(n); for (const l of g.links || []) if (l) ls.add(l); }
    for (const lk of data.links) if (lk.conflict) { ls.add(lk.id); ns.add(lk.from); ns.add(lk.to); }
    return { ns, ls };
  }
  function visible() {
    const nb = nodeBy();
    const pr = problemSets();
    let links = data.links.filter(lk => linkActive(lk) && nb.has(lk.from) && nb.has(lk.to)
      && st.kinds.has(nb.get(lk.from).kind) && st.kinds.has(nb.get(lk.to).kind));
    if (st.problems) links = links.filter(lk => pr.ls.has(lk.id) || (pr.ns.has(lk.from) && pr.ns.has(lk.to)));
    const linked = new Set(links.flatMap(lk => [lk.from, lk.to]));
    const nodes = data.nodes.filter(n => st.kinds.has(n.kind) && (linked.has(n.id) || (!st.problems && n.kind === 'character' && !n.minor) || (st.problems && pr.ns.has(n.id))));
    return { nodes, links, pr };
  }
  const nameOf = id => (nodeBy().get(id) || {}).name || '(removed)';

  /* ------------------------------------------------------------------ layout: saved positions + a small force layout */
  function layout(nodes, links) {
    const ids = nodes.map(n => n.id);
    const fixed = new Set();
    const centre = nodes.find(n => n.protagonist);
    const fresh = new Set();   // only the entries placed now move: the rest stay where they are (no jumping)
    nodes.forEach((n, i) => {
      if (pos.has(n.id)) return;
      if (Array.isArray(n.pos)) { pos.set(n.id, { x: n.pos[0], y: n.pos[1] }); fixed.add(n.id); return; }
      fresh.add(n.id);
      if (centre && n.id === centre.id) { pos.set(n.id, { x: W / 2, y: H / 2 }); return; }
      const a = (i / Math.max(1, nodes.length)) * Math.PI * 2, r = 120 + (i % 5) * 45;
      pos.set(n.id, { x: W / 2 + Math.cos(a) * r * 1.4, y: H / 2 + Math.sin(a) * r });
    });
    const moving = ids.filter(id => fresh.has(id));
    if (!moving.length) return;
    const P = ids.map(id => pos.get(id));
    const idx = new Map(ids.map((id, i) => [id, i]));
    const E = links.map(lk => [idx.get(lk.from), idx.get(lk.to)]).filter(([a, b]) => a !== undefined && b !== undefined);
    const free = ids.map(id => moving.includes(id));
    const n = P.length, k = Math.sqrt((W * H) / Math.max(4, n)) * 0.55;
    const iters = n > 150 ? 120 : 220;
    for (let it = 0; it < iters; it++) {
      const t = 30 * (1 - it / iters) + 1;
      const D = P.map(() => ({ x: 0, y: 0 }));
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        let dx = P[i].x - P[j].x, dy = P[i].y - P[j].y; let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (i - j) || 1; dy = 1; d2 = 2; }
        if (d2 > 160000) continue;
        const f = (k * k) / d2;
        D[i].x += dx * f; D[i].y += dy * f; D[j].x -= dx * f; D[j].y -= dy * f;
      }
      for (const [a, b] of E) {
        const dx = P[a].x - P[b].x, dy = P[a].y - P[b].y, d = Math.sqrt(dx * dx + dy * dy) || 1, f = d / k;
        D[a].x -= dx * f; D[a].y -= dy * f; D[b].x += dx * f; D[b].y += dy * f;
      }
      for (let i = 0; i < n; i++) {
        if (!free[i]) continue;
        D[i].x += (W / 2 - P[i].x) * 0.01; D[i].y += (H / 2 - P[i].y) * 0.012;   // gentle pull to the middle
        const d = Math.sqrt(D[i].x * D[i].x + D[i].y * D[i].y) || 1;
        P[i].x = Math.min(W - 75, Math.max(75, P[i].x + (D[i].x / d) * Math.min(d, t)));
        P[i].y = Math.min(H - 35, Math.max(25, P[i].y + (D[i].y / d) * Math.min(d, t)));
      }
    }
  }
  async function relayout() {
    pos.clear();
    for (const n of data.nodes) n.pos = null;
    drawMap();
    try { const r = await api('PUT', bpath('/storymap/positions'), { body: { positions: {}, reset: true } }); if (r && r.version) data.version = r.version; } catch { /* the map still shows */ }
  }
  let saveTimer = null;
  const dirty = {};
  function savePos(id) {
    const p = pos.get(id);
    dirty[id] = [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10];
    const n = nodeBy().get(id); if (n) n.pos = dirty[id];
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const body = { positions: Object.assign({}, dirty) };
      for (const k of Object.keys(dirty)) delete dirty[k];
      try { const r = await api('PUT', bpath('/storymap/positions'), { body }); if (r && r.version) data.version = r.version; } catch { /* kept on screen; saved next time */ }
    }, 600);
  }

  /* ------------------------------------------------------------------ zoom and pan */
  function applyView() { stage.setAttribute('transform', `translate(${st.tx} ${st.ty}) scale(${st.zoom})`); drawLabels(); }
  function zoomBy(f, cx = W / 2, cy = H / 2) {
    const z = Math.min(6, Math.max(0.3, st.zoom * f));
    st.tx = cx - (cx - st.tx) * (z / st.zoom); st.ty = cy - (cy - st.ty) * (z / st.zoom); st.zoom = z; applyView();
  }
  function svgPoint(ev) {
    const r = svg.getBoundingClientRect();
    const sc = Math.min(r.width / W, r.height / H) || 1;
    const ox = (r.width - W * sc) / 2, oy = (r.height - H * sc) / 2;
    return { x: (ev.clientX - r.left - ox) / sc, y: (ev.clientY - r.top - oy) / sc };
  }
  const toMap = p => ({ x: (p.x - st.tx) / st.zoom, y: (p.y - st.ty) / st.zoom });
  svg.addEventListener('wheel', ev => { ev.preventDefault(); const p = svgPoint(ev); zoomBy(ev.deltaY < 0 ? 1.15 : 0.87, p.x, p.y); }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', ev => {
    const g = ev.target.closest('[data-node]');
    const p = svgPoint(ev);
    const hit = ev.target.closest('[data-node],[data-link]');
    drag = g ? { node: g.getAttribute('data-node'), start: p, moved: false, hit } : { pan: true, start: p, tx: st.tx, ty: st.ty, moved: false, hit };
    try { svg.setPointerCapture(ev.pointerId); } catch { /* old browsers */ }
  });
  svg.addEventListener('pointermove', ev => {
    if (!drag) return;
    const p = svgPoint(ev);
    if (Math.abs(p.x - drag.start.x) + Math.abs(p.y - drag.start.y) > 3) drag.moved = true;
    if (!drag.moved) return;
    if (drag.pan) { st.tx = drag.tx + (p.x - drag.start.x); st.ty = drag.ty + (p.y - drag.start.y); applyView(); return; }
    const m = toMap(p);
    pos.set(drag.node, { x: m.x, y: m.y });
    moveNode(drag.node);
  });
  svg.addEventListener('pointerup', ev => {
    if (drag && drag.node && drag.moved) savePos(drag.node);
    else if (drag && !drag.moved) {
      const g = drag.hit;
      if (g) select(g.hasAttribute('data-node') ? { node: g.getAttribute('data-node') } : { link: g.getAttribute('data-link') });
      else if (drag.pan) select(null);
    }
    drag = null;
  });

  /* ------------------------------------------------------------------ drawing */
  let shown = { nodes: [], links: [] };
  const els = { nodes: new Map(), links: [] };
  function drawMap() {
    shown = visible();
    layout(shown.nodes, shown.links);
    while (stage.firstChild) stage.removeChild(stage.firstChild);
    els.nodes.clear(); els.links = [];
    const gl = s('g', { class: 'sm-links' }), gn = s('g', { class: 'sm-nodes' });
    stage.append(gl, gn);
    const deg = new Map();
    for (const lk of shown.links) for (const e of [lk.from, lk.to]) deg.set(e, (deg.get(e) || 0) + 1);
    const ranked = [...shown.nodes].sort((a, b) => (deg.get(b.id) || 0) - (deg.get(a.id) || 0));
    const always = new Set(ranked.slice(0, LABELS).map(n => n.id));
    for (const lk of shown.links) {
      const a = pos.get(lk.from), b = pos.get(lk.to);
      if (!a || !b) continue;
      const col = lk.conflict ? 'var(--bad)' : (data.kinds[lk.kind] || data.kinds.other).colour;
      const sel = st.sel && st.sel.link === lk.id;
      const g = s('g', { class: `sm-link sm-st-${lk.status}${lk.conflict ? ' sm-conflict' : ''}${sel ? ' sm-sel' : ''}`, 'data-link': lk.id, 'data-testid': 'sm-link', tabindex: '0', role: 'button',
        'aria-label': `${lk.id}: ${nameOf(lk.from)} ${kindLabel(lk.kind).toLowerCase()} ${nameOf(lk.to)}, ${STATUS[lk.status][0]}${lk.conflict ? ', a conflict to decide' : ''}` });
      const line = s('line', { class: 'sm-line', stroke: col, 'stroke-width': lk.conflict ? 3.5 : sel ? 4 : 2.2, 'stroke-dasharray': lk.status === 'draft' ? '7 6' : null });
      const hit = s('line', { class: 'sm-hit', stroke: 'transparent', 'stroke-width': 14 });
      const lock = lk.status === 'locked' ? s('text', { class: 'sm-lock', 'text-anchor': 'middle', 'font-size': 13 }, '🔒') : null;
      const warn = lk.conflict ? s('text', { class: 'sm-warn', 'text-anchor': 'middle', 'font-size': 15 }, '⚠') : null;
      g.append(hit, line); if (lock) g.appendChild(lock); if (warn) g.appendChild(warn);
      g.appendChild(s('title', null, `${lk.id} · ${nameOf(lk.from)} — ${kindLabel(lk.kind)} — ${nameOf(lk.to)} · ${STATUS[lk.status][0]}`));
      g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select({ link: lk.id }); } });
      gl.appendChild(g);
      els.links.push({ lk, line, hit, lock, warn });
    }
    for (const n of shown.nodes) {
      const k = nodeKind(n.kind);
      const r = n.protagonist ? 17 : n.main ? 13 : 10;
      const hl = (st.find && n.name.toLowerCase().includes(st.find)) || (st.sel && st.sel.node === n.id);
      const g = s('g', { class: `sm-node sm-k-${n.kind}${n.missing ? ' sm-missing' : ''}${hl ? ' sm-sel' : ''}${shown.pr.ns.has(n.id) ? ' sm-prob' : ''}`, 'data-node': n.id, 'data-testid': 'sm-node', tabindex: '0', role: 'button',
        'aria-label': `${n.name}${n.protagonist ? ' (main character)' : ''}, ${k.label}${n.missing ? ', removed from the Book Bible' : ''}` });
      g.appendChild(s('circle', { r: r + 3, class: 'sm-halo' }));
      g.appendChild(s('circle', { r, fill: n.missing ? '#9e9e9e' : k.colour, class: 'sm-dot', 'stroke-dasharray': n.missing || n.not_in_bible ? '3 3' : null }));
      if (n.protagonist) g.appendChild(s('text', { class: 'sm-star', 'text-anchor': 'middle', dy: '0.36em', 'font-size': 17 }, '★'));
      const label = s('text', { class: 'sm-label', 'text-anchor': 'middle', y: r + 14, 'font-size': 12 }, clip(n.name, 24));
      label.dataset.always = always.has(n.id) || n.protagonist || hl ? '1' : '0';
      g.appendChild(label);
      g.appendChild(s('title', null, `${n.name} · ${k.label}${n.missing ? ' · removed from the Book Bible' : ''}`));
      g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select({ node: n.id }); } });
      gn.appendChild(g);
      els.nodes.set(n.id, { g, label });
      moveNode(n.id, true);
    }
    for (const e of els.links) placeLink(e);
    applyView();
    if (!shown.nodes.length) {
      stage.appendChild(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'sm-empty', 'font-size': 18 },
        st.problems ? 'No problems to show. 🎉' : data.links.length ? 'Nothing to show with these filters.' : 'No connections yet: they appear as chapters are written, or add one yourself.'));
    }
  }
  function placeLink(e) {
    const a = pos.get(e.lk.from), b = pos.get(e.lk.to);
    if (!a || !b) return;
    for (const l of [e.line, e.hit]) { l.setAttribute('x1', a.x); l.setAttribute('y1', a.y); l.setAttribute('x2', b.x); l.setAttribute('y2', b.y); }
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (e.lock) { e.lock.setAttribute('x', mx); e.lock.setAttribute('y', my + 4); }
    if (e.warn) { e.warn.setAttribute('x', mx); e.warn.setAttribute('y', my - 6); }
  }
  function moveNode(id, only) {
    const p = pos.get(id), el = els.nodes.get(id);
    if (!p || !el) return;
    el.g.setAttribute('transform', `translate(${p.x} ${p.y})`);
    if (!only) for (const e of els.links) if (e.lk.from === id || e.lk.to === id) placeLink(e);
  }
  function drawLabels() {
    const many = st.zoom >= 1.6;
    for (const { label } of els.nodes.values()) label.style.display = (many || label.dataset.always === '1') ? '' : 'none';
    for (const e of els.links) if (e.lock) e.lock.style.display = (st.zoom >= 0.7 && shown.links.length < 220) || st.zoom >= 1.4 ? '' : 'none';
  }

  function drawKinds() {
    clear(kindsBox);
    const count = {};
    for (const n of data.nodes) count[n.kind] = (count[n.kind] || 0) + 1;
    const present = Object.keys(data.node_kinds).filter(k => count[k]);
    const on = present.filter(k => st.kinds.has(k)).length;
    kindsSum.textContent = on === present.length ? 'Show: everything ▾' : `Show: ${on} of ${present.length} kinds ▾`;
    for (const [k, v] of Object.entries(data.node_kinds)) {
      if (!count[k]) continue;
      const cb = h('input', { type: 'checkbox', checked: st.kinds.has(k), 'data-testid': `sm-filter-${k}` });
      cb.addEventListener('change', () => { if (cb.checked) st.kinds.add(k); else st.kinds.delete(k); keep(); drawKinds(); drawMap(); drawList(); });
      kindsBox.appendChild(h('label', { class: 'sm-kind' }, cb, h('span', { class: 'sm-sw', style: `background:${v.colour}`, 'aria-hidden': 'true' }), ` ${v.label} (${count[k]})`));
    }
  }
  function drawLegend() {
    clear(legend);
    legend.append(
      h('span', null, h('b', null, '★'), ' main character'),
      h('span', null, h('i', { class: 'sm-lg-line sm-lg-solid', 'aria-hidden': 'true' }), ' a rule (✔ approved or 🔒 on the page)'),
      h('span', null, h('i', { class: 'sm-lg-line sm-lg-dot', 'aria-hidden': 'true' }), ' a draft'),
      h('span', null, h('i', { class: 'sm-lg-line sm-lg-red', 'aria-hidden': 'true' }), ' a conflict to decide'),
      h('span', { class: 'muted' }, 'Drag a circle to move it · scroll to zoom · drag the background to pan'));
  }
  function drawSummary() {
    const c = data.counts, ch = data.chapters;
    clear(summary).append(
      `${c.links} connection${c.links === 1 ? '' : 's'}: ${c.locked} 🔒 on the page, ${c.approved} ✔ approved, ${c.draft} draft${c.draft === 1 ? '' : 's'}`,
      c.conflicts ? h('b', { class: 'sm-bad' }, ` · ⚠️ ${c.conflicts} conflict${c.conflicts === 1 ? '' : 's'} to decide`) : null,
      c.warnings ? h('span', null, ` · ${c.warnings} thing${c.warnings === 1 ? '' : 's'} to look at`) : null,
      ` · ${ch.written ? `chapters 1–${ch.written} written` : 'no chapter written yet'}${ch.planned ? ` of ${ch.planned}` : ''}.`);
    const max = Math.max(1, ch.written || 0);
    asOf.max = String(max);
    if (st.asOf === null) asOf.value = String(max);
    asOf.disabled = !ch.written;
    asOfWords.textContent = st.asOf === null ? (ch.written ? `Now (after chapter ${ch.written})` : 'Now') : st.asOf === 0 ? 'Before chapter 1' : `After chapter ${st.asOf}`;
  }

  /* ------------------------------------------------------------------ the side card */
  function select(sel) { st.sel = sel; st.form = null; drawMap(); drawCard(); }
  const bibleLink = n => n.page && !n.own && !n.missing ? h('a', { class: 'btn small', href: plink('bible', n.page) }, '📖 Open its Book Bible page') : null;
  function statusBadge(lk) {
    return h('span', { class: `sm-badge sm-b-${lk.status}`, title: STATUS[lk.status][1], 'data-testid': 'sm-status' }, STATUS[lk.status][0]);
  }
  function drawCard() {
    clear(card);
    if (st.form) { card.appendChild(st.form.type === 'node' ? nodeForm(st.form) : linkForm(st.form)); return; }
    const nb = nodeBy();
    if (st.sel && st.sel.link) {
      const lk = data.links.find(l => l.id === st.sel.link);
      if (lk) { card.appendChild(linkCard(lk, nb)); return; }
    }
    if (st.sel && st.sel.node) {
      const n = nb.get(st.sel.node);
      if (n) { card.appendChild(nodeCard(n)); return; }
    }
    card.appendChild(gapsCard());
  }
  function gapsCard() {
    const gaps = data.gaps || [];
    const warn = gaps.filter(g => g.severity === 'warn'), info = gaps.filter(g => g.severity !== 'warn');
    const item = g => h('li', { class: `sm-gap sm-gap-${g.severity}`, 'data-code': g.code },
      h('button', { type: 'button', class: 'link', onclick: () => {
        if (g.links && g.links[0] && data.links.some(l => l.id === g.links[0])) select({ link: g.links[0] });
        else if (g.nodes && g.nodes[0]) select({ node: g.nodes[0] });
      } }, g.message));
    return h('div', { 'data-testid': 'sm-gaps' },
      h('h2', null, warn.length ? `⚠️ Things to look at (${warn.length})` : '✔ Nothing to worry about'),
      warn.length ? h('ul', { class: 'sm-gaps' }, warn.map(item)) : h('p', { class: 'muted' }, 'No conflicts, no forgotten subplots, clues or secrets. Click a circle or a line to see its details.'),
      info.length ? h('details', null, h('summary', null, `Smaller notes (${info.length})`), h('ul', { class: 'sm-gaps' }, info.map(item))) : null,
      h('p', { class: 'muted small' }, 'Click a circle or a line to see where it comes from.'));
  }
  function nodeCard(n) {
    const mine = data.links.filter(l => l.from === n.id || l.to === n.id);
    const k = nodeKind(n.kind);
    const box = h('div', { 'data-testid': 'sm-node-card' },
      h('h2', null, n.protagonist ? '★ ' : '', n.name),
      h('p', null, h('span', { class: 'sm-sw', style: `background:${k.colour}`, 'aria-hidden': 'true' }), ` ${k.label}`, n.protagonist ? ' · the main character' : '', n.plan ? ' · from your story plan' : '', n.own ? ' · made on this map' : ''),
      n.missing ? h('p', { class: 'sm-bad', 'data-testid': 'sm-removed' }, '⚠️ This entry is no longer in the Book Bible. Its connections are kept — delete them, or add the entry back.') : null,
      n.not_in_bible ? h('p', { class: 'muted' }, 'A name from the chapters that has no Book Bible page yet.') : null,
      n.note ? h('p', null, n.note) : null,
      n.kind === 'clue' ? h('p', { class: 'small' }, n.paid_off ? '🎯 Paid off.' : n.payoff_chapter ? `Planned payoff: chapter ${n.payoff_chapter}.` : 'No payoff chapter planned.') : null,
      h('div', { class: 'row' }, bibleLink(n),
        n.kind === 'clue' || n.own ? h('button', { type: 'button', class: 'small', 'data-testid': 'sm-edit-node', onclick: () => { st.form = { type: 'node', node: n }; drawCard(); } }, '✎ Edit') : null,
        n.own ? h('button', { type: 'button', class: 'small danger', 'data-testid': 'sm-delete-node', onclick: async () => {
          const ok = await x.choiceDialog('Delete this entry from the map?', h('p', null, `“${n.name}” is removed from the story map. Its connections stay (shown as about a removed entry) until you delete them.`), [{ id: 'yes', label: '🗑 Delete' }]);
          if (ok === 'yes') { await call('POST', `/nodes/${encodeURIComponent(n.id)}/delete`, {}, 'Could not delete it'); st.sel = null; drawCard(); }
        } }, '🗑 Delete') : null),
      h('h3', null, `Connections (${mine.length})`),
      mine.length ? h('ul', { class: 'sm-conns' }, mine.map(l => h('li', null, h('button', { type: 'button', class: 'link', onclick: () => select({ link: l.id }) },
        `${l.id} · ${l.from === n.id ? '' : nameOf(l.from) + ' '}${kindLabel(l.kind).toLowerCase()} ${l.from === n.id ? nameOf(l.to) : ''}`.trim()), ' ', statusBadge(l)))) : h('p', { class: 'muted' }, 'None yet.'),
      h('button', { type: 'button', class: 'small', onclick: () => { st.form = { type: 'add', from: n.id }; drawCard(); } }, '＋ Connect it to…'));
    return box;
  }
  function linkCard(lk, nb) {
    const from = nb.get(lk.from) || { name: '(removed)' }, to = nb.get(lk.to) || { name: '(removed)' };
    const conflict = lk.conflict ? (data.conflicts || []).find(c => c.id === lk.conflict && c.status === 'open') : null;
    const ev = (lk.evidence || []).filter(e => e && e.quote);
    const reasonBox = h('div', { class: 'sm-reason-box' });
    const ask = (title, label, onOk, extra) => {
      clear(reasonBox);
      const ta = h('textarea', { rows: 2, id: 'sm-reason', 'data-testid': 'sm-reason', placeholder: 'Why? (a few words — kept with the connection)' });
      reasonBox.append(h('label', { for: 'sm-reason', class: 'sm-tool-h' }, title), extra || null, ta,
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'small primary', 'data-testid': 'sm-reason-ok', onclick: () => {
          if (ta.value.trim().length < 3) { ta.setAttribute('aria-invalid', 'true'); ta.focus(); return; }
          onOk(ta.value.trim());
        } }, label), h('button', { type: 'button', class: 'small', onclick: () => clear(reasonBox) }, 'Cancel')));
      ta.focus();
    };
    const act = [];
    if (lk.status === 'draft') act.push(h('button', { type: 'button', class: 'small primary', 'data-testid': 'sm-approve', title: 'Make it a rule: the writer keeps it from now on',
      onclick: () => call('POST', `/links/${lk.id}/approve`, { author_confirms: true }, 'Could not approve it') }, '✔ Approve'));
    if (lk.status !== 'locked') act.push(h('button', { type: 'button', class: 'small', 'data-testid': 'sm-edit', onclick: () => { st.form = { type: 'edit', link: lk }; drawCard(); } }, '✎ Edit'));
    if (lk.status === 'locked') act.push(h('button', { type: 'button', class: 'small', 'data-testid': 'sm-change', title: 'It is on the page: a change needs a reason',
      onclick: () => { st.form = { type: 'change', link: lk }; drawCard(); } }, '✎ Change it…'));
    act.push(h('button', { type: 'button', class: 'small danger', 'data-testid': 'sm-delete', onclick: () => {
      if (lk.status === 'locked') ask('This connection is on the page. Delete it anyway?', '🗑 Delete', r => call('POST', `/links/${lk.id}/delete`, { author_confirms: true, reason: r }, 'Could not delete it').then(() => { st.sel = null; drawCard(); }));
      else x.choiceDialog('Delete this connection?', h('p', null, `${lk.id}: ${from.name} — ${kindLabel(lk.kind).toLowerCase()} — ${to.name}`), [{ id: 'yes', label: '🗑 Delete' }])
        .then(ok => ok === 'yes' && call('POST', `/links/${lk.id}/delete`, {}, 'Could not delete it').then(() => { st.sel = null; drawCard(); }));
    } }, '🗑 Delete'));
    return h('div', { 'data-testid': 'sm-link-card' },
      h('p', { class: 'sm-code' }, h('code', null, lk.id), ' ', statusBadge(lk), lk.source === 'user' ? h('span', { class: 'muted small' }, ' · added by you') : h('span', { class: 'muted small' }, ' · found by the AI')),
      h('h2', { class: 'sm-link-h' }, h('button', { type: 'button', class: 'link', onclick: () => select({ node: lk.from }) }, from.name),
        h('span', { class: 'sm-kind-word' }, ` ${(data.kinds[lk.kind] || data.kinds.other).icon} ${(data.kinds[lk.kind] || data.kinds.other).phrase} `),
        h('button', { type: 'button', class: 'link', onclick: () => select({ node: lk.to }) }, to.name)),
      lk.note ? h('p', null, lk.note) : null,
      h('p', { class: 'small' }, lk.since ? `Since chapter ${lk.since}` : 'From the start of the book', lk.ended ? ` · ended in chapter ${lk.ended}` : ''),
      lk.about_removed ? h('p', { class: 'sm-bad', 'data-testid': 'sm-removed' }, '⚠️ This connection is about an entry that is no longer in the Book Bible.') : null,
      conflict ? h('div', { class: 'sm-conflict-box', 'data-testid': 'sm-conflict' },
        h('h3', null, `⚠️ Chapter ${conflict.chapter} seems to change this`),
        h('p', null, conflict.proposed.change === 'ended' ? 'The chapter seems to end this connection.' : conflict.proposed.new_link
          ? `The chapter seems to say: ${from.name} ${(data.kinds[conflict.proposed.kind] || data.kinds.other).phrase} ${to.name}.`
          : `The chapter seems to change it${conflict.proposed.note ? ` to “${conflict.proposed.note}”` : ''}.`),
        conflict.proposed.quote ? h('blockquote', { class: 'sm-quote' }, `“${conflict.proposed.quote}”`) : null,
        h('p', { class: 'small muted' }, 'Nothing was changed. Keep the connection as it is (then the chapter may need a fix), or accept the change.'),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'small primary', 'data-testid': 'sm-keep', onclick: () => ask('Keep it as it is — why?', '✔ Keep it', r => call('POST', `/conflicts/${conflict.id}/resolve`, { choice: 'keep', reason: r, author_confirms: true }, 'Could not decide it')) }, '✔ Keep it as it is'),
          h('button', { type: 'button', class: 'small', 'data-testid': 'sm-accept', onclick: () => ask('Accept the chapter’s change — why?', 'Accept the change', r => call('POST', `/conflicts/${conflict.id}/resolve`, { choice: 'accept', reason: r, author_confirms: true }, 'Could not decide it')) }, 'Accept the change'))) : null,
      h('div', { class: 'row sm-acts' }, act), reasonBox,
      h('h3', null, 'On the page'),
      ev.length ? h('ul', { class: 'sm-ev' }, ev.map(e => h('li', null, h('b', null, `Chapter ${e.chapter}${e.book ? ` (book ${e.book})` : ''}: `), h('q', null, e.quote)))) : h('p', { class: 'muted small' }, lk.status === 'draft' ? 'Not shown on the page yet.' : 'No quote kept.'),
      (lk.history || []).length ? h('details', { class: 'sm-hist' }, h('summary', null, `History (${lk.history.length})`),
        h('ul', { class: 'small' }, [...lk.history].reverse().map(e => h('li', null, `${String(e.at || '').slice(0, 10)} · ${e.what}`, e.reason ? h('em', null, ` — “${e.reason}”`) : null)))) : null);
  }
  function kindSelect(id, value) {
    return h('select', { id, 'data-testid': 'sm-kind' }, Object.entries(data.kinds).map(([k, v]) => h('option', { value: k, selected: k === value }, `${v.icon} ${v.label}`)));
  }
  function nodeSelect(id, value) {
    const nodes = [...data.nodes].filter(n => !n.missing).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)));
    return h('select', { id }, h('option', { value: '' }, '— choose —'), nodes.map(n => h('option', { value: n.id, selected: n.id === value }, `${nodeKind(n.kind).icon} ${n.name}`)));
  }
  function linkForm(f) {
    const lk = f.link || {};
    const isAdd = f.type === 'add';
    const fromSel = isAdd ? nodeSelect('sm-f-from', f.from) : null, toSel = isAdd ? nodeSelect('sm-f-to', null) : null;
    const kind = kindSelect('sm-f-kind', lk.kind || 'ally');
    const note = h('input', { id: 'sm-f-note', value: lk.note || '', maxlength: '160', placeholder: 'A few words, e.g. “older brother”' });
    const since = h('input', { id: 'sm-f-since', type: 'number', min: '1', value: lk.since || '', placeholder: 'from the start' });
    const reason = f.type === 'change' ? h('textarea', { id: 'sm-f-reason', 'data-testid': 'sm-reason', rows: 2, placeholder: 'Why are you changing it? (kept with the connection)' }) : null;
    const err = h('p', { class: 'sm-bad small', 'aria-live': 'polite' });
    const go = async status => {
      const body = { kind: kind.value, note: note.value.trim(), since: since.value ? Number(since.value) : null };
      let out;
      if (isAdd) {
        if (!fromSel.value || !toSel.value) { err.textContent = 'Choose both ends of the connection.'; return; }
        out = await call('POST', '/links', Object.assign(body, { from: fromSel.value, to: toSel.value, status }), 'Could not add it');
        if (out && out.link) { st.form = null; select({ link: out.link.id }); }
        return;
      }
      if (f.type === 'change') {
        if (!reason.value.trim() || reason.value.trim().length < 3) { err.textContent = 'Say why in a few words: a change to something on the page is never silent.'; reason.focus(); return; }
        out = await call('POST', `/links/${lk.id}/change`, Object.assign(body, { reason: reason.value.trim(), author_confirms: true }), 'Could not change it');
      } else out = await call('PUT', `/links/${lk.id}`, body, 'Could not save it');
      if (out) { st.form = null; drawCard(); }
    };
    const row = (lab, id, el) => h('div', { class: 'sm-field' }, h('label', { for: id }, lab), el);
    return h('form', { class: 'sm-form', 'data-testid': 'sm-form', onsubmit: ev => { ev.preventDefault(); go(isAdd ? 'approved' : null); } },
      h('h2', null, isAdd ? '＋ A new connection' : f.type === 'change' ? `✎ Change ${lk.id} (it is on the page)` : `✎ Edit ${lk.id}`),
      f.type === 'change' ? h('p', { class: 'small' }, 'This connection is already on the page. If you change it, the chapters that show it may need a fix — the checks will tell you.') : null,
      isAdd ? row('From', 'sm-f-from', fromSel) : null, row('Connection', 'sm-f-kind', kind), isAdd ? row('To', 'sm-f-to', toSel) : null,
      row('Note', 'sm-f-note', note), row('Since chapter', 'sm-f-since', since), reason ? row('Why', 'sm-f-reason', reason) : null, err,
      h('div', { class: 'row' },
        h('button', { type: 'submit', class: 'small primary', 'data-testid': 'sm-save' }, isAdd ? '✔ Add as a rule' : 'Save'),
        isAdd ? h('button', { type: 'button', class: 'small', 'data-testid': 'sm-save-draft', onclick: () => go('draft') }, 'Add as a draft') : null,
        h('button', { type: 'button', class: 'small', onclick: () => { st.form = null; drawCard(); } }, 'Cancel')));
  }
  function nodeForm(f) {
    const n = f.node || {};
    const kind = h('select', { id: 'sm-n-kind', disabled: n.id ? true : null }, (data.own_kinds || []).map(k => h('option', { value: k, selected: k === (n.kind || 'secret') }, `${nodeKind(k).icon} ${k === 'thread' ? 'Subplot' : nodeKind(k).label}`)));
    const name = h('input', { id: 'sm-n-name', value: n.name || '', maxlength: '80', disabled: n.id && !n.own ? true : null });
    const note = h('input', { id: 'sm-n-note', value: n.note || '', maxlength: '160', disabled: n.id && !n.own ? true : null });
    const pay = h('input', { id: 'sm-n-pay', type: 'number', min: '1', value: n.payoff_chapter || '' });
    const paid = h('input', { id: 'sm-n-paid', type: 'checkbox', checked: !!n.paid_off });
    const row = (lab, id, el) => h('div', { class: 'sm-field' }, h('label', { for: id }, lab), el);
    return h('form', { class: 'sm-form', 'data-testid': 'sm-node-form', onsubmit: async ev => {
      ev.preventDefault();
      const body = { payoff_chapter: pay.value ? Number(pay.value) : null, paid_off: paid.checked };
      if (!n.id || n.own) Object.assign(body, { name: name.value.trim(), note: note.value.trim() });
      const out = n.id ? await call('PUT', `/nodes/${encodeURIComponent(n.id)}`, body, 'Could not save it')
        : await call('POST', '/nodes', Object.assign(body, { kind: kind.value }), 'Could not add it');
      if (out) { st.form = null; if (out.node) select({ node: out.node.id }); else drawCard(); }
    } },
    h('h2', null, n.id ? `✎ ${n.name}` : '＋ A secret, clue or subplot'),
    h('p', { class: 'small muted' }, 'For what your Book Bible has no page for: a secret someone keeps, a clue that must pay off later, a subplot to follow.'),
    row('Kind', 'sm-n-kind', kind), row('Name', 'sm-n-name', name), row('Note', 'sm-n-note', note),
    row('Pays off in chapter (a clue)', 'sm-n-pay', pay), h('label', { class: 'sm-check' }, paid, ' Already paid off'),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'small primary', 'data-testid': 'sm-node-save' }, n.id ? 'Save' : '＋ Add'),
      h('button', { type: 'button', class: 'small', onclick: () => { st.form = null; drawCard(); } }, 'Cancel')));
  }

  /* ------------------------------------------------------------------ the list (also for keyboards and screen readers) */
  function drawList() {
    clear(listBox);
    const { links } = visible();
    listBox.appendChild(h('summary', null, `All connections as a list (${links.length})`));
    if (!links.length) { listBox.appendChild(h('p', { class: 'muted' }, 'None with these filters.')); return; }
    const tb = h('tbody');
    for (const lk of links) {
      tb.appendChild(h('tr', { class: lk.conflict ? 'sm-row-conflict' : null },
        h('td', null, h('button', { type: 'button', class: 'link', onclick: () => { select({ link: lk.id }); svg.scrollIntoView({ block: 'nearest' }); } }, lk.id)),
        h('td', null, nameOf(lk.from)), h('td', null, kindLabel(lk.kind)), h('td', null, nameOf(lk.to)),
        h('td', null, lk.since ? `ch. ${lk.since}` : 'start'), h('td', null, STATUS[lk.status][0], lk.conflict ? ' ⚠️' : '')));
    }
    listBox.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'sm-table' },
      h('thead', null, h('tr', null, ['Code', 'From', 'Connection', 'To', 'Since', 'Status'].map(t => h('th', { scope: 'col' }, t)))), tb)));
  }

  function draw() { drawSummary(); drawKinds(); drawLegend(); drawMap(); drawCard(); drawList(); }
  draw();
}
