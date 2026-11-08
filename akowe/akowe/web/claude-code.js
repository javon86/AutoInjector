// 🤖 Claude Code helpers (claude_code.py / claude_code_book.py): the Settings card, the Make-a-book option, the run
// window line and the chapter page's box (research notes, sourced fact checks, proposed rewrites). app.js passes its
// helpers in (s7c()), so this module never reaches into app.js. All data is rendered with DOM APIs (never innerHTML).

const STATE_TONE = { ready: 'ok', not_installed: 'off', signed_out: 'warn', limited: 'warn', failing: 'warn', off: 'off', checking: 'off' };

function statusLine(c, st, testid = 'cc-status') {
  const { h } = c;
  const kids = [h('span', { 'aria-hidden': 'true' }, st.state === 'ready' ? '' : '🤖 '), st.words || st.state];
  if (st.state === 'not_installed') kids.push(' ', h('a', { href: st.install_url || 'https://code.claude.com/docs/en/setup', target: '_blank', rel: 'noopener' }, 'Install page'));
  return h('p', { class: `small cc-status cc-${STATE_TONE[st.state] || 'off'}`, 'data-testid': testid, 'data-state': st.state || '' }, ...kids);
}

/** Settings › 🤖 Claude Code helpers: status, On/Off, helpers at once (1–5) and which jobs are on. */
export function helpersCard(c) {
  const { h, api, put, clear, toast, problemBox, toProblem } = c;
  const box = h('div', { 'aria-live': 'polite' });
  const card = h('section', { class: 'card', 'aria-labelledby': 'cc-h', 'data-testid': 'cc-card' }, h('h2', { id: 'cc-h' }, '🤖 Claude Code helpers'),
    h('p', { class: 'small' }, 'Claude Code is Anthropic’s command-line tool. With it, Akọwe runs small side jobs several at a time — research ahead for the next chapters, fact checks with real sources, checks side by side and a “sounds like AI” pass — so the book is made faster and checked more. It uses your Claude plan, so it shares that plan’s usage limits with the Claude pane and claude.ai. Without it (or when it is signed out or at its limit), the web AIs do all the work, as before.'), box);
  const where = { step: 'Settings › Claude Code helpers' };
  const draw = (cur) => {
    const s = cur.settings;
    const on = h('select', { id: 'cc-on', 'data-testid': 'cc-on' },
      [['auto', 'On when Claude Code is found (recommended)'], ['on', 'On'], ['off', 'Off']].map(([v, l]) => h('option', { value: v }, l)));
    on.value = s.enabled === false ? 'off' : (s.enabled === true ? 'on' : 'auto');
    const n = h('input', { type: 'number', id: 'cc-n', min: String(cur.helpers_range[0]), max: String(cur.helpers_range[1]), value: String(s.helpers), class: 'wz-num', 'data-testid': 'cc-helpers' });
    const jobs = Object.entries(cur.job_words).map(([k, l]) => {
      const id = `cc-job-${k}`;
      const b = h('input', { type: 'checkbox', id, 'data-job': k, checked: s.jobs[k] !== false });
      return h('div', { class: 'check-row' }, b, h('label', { for: id }, l));
    });
    const recheck = h('button', { type: 'button', class: 'small', 'data-testid': 'cc-recheck', onclick: async () => {
      recheck.disabled = true;
      try { draw(await api('POST', '/settings/claude-code/check')); } catch (e) { box.appendChild(problemBox(toProblem(e, where))); recheck.disabled = false; }
    } }, '↻ Check again');
    const save = h('button', { type: 'button', class: 'small primary', 'data-testid': 'cc-save', onclick: async () => {
      const body = { enabled: on.value === 'auto' ? null : on.value === 'on', helpers: parseInt(n.value, 10), jobs: {} };
      card.querySelectorAll('input[data-job]').forEach(b => { body.jobs[b.dataset.job] = b.checked; });
      try { draw(await api('PUT', '/settings/claude-code', { body })); toast('Saved'); }
      catch (e) { box.appendChild(problemBox(toProblem(e, where))); }
    } }, 'Save');
    put(clear(box), statusLine(c, Object.assign({ install_url: cur.install_url }, cur.status)),
      h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', { for: 'cc-on' }, 'Claude Code helpers'), on),
        h('div', { class: 'field' }, h('label', { for: 'cc-n' }, 'Helpers at once (1–5)'), n, h('span', { class: 'hint' }, 'More helpers finish sooner but use your Claude plan’s limits faster. 3 is a good start.'))),
      h('fieldset', { class: 'field' }, h('legend', null, 'Which jobs the helpers do'), ...jobs),
      h('p', { class: 'small muted' }, cur.shares_limits, ' To sign in: open PowerShell, type ', h('code', null, 'claude'), ', press Enter and follow the steps once.'),
      h('div', { class: 'row' }, save, recheck));
  };
  (async () => {
    for (let i = 0; i < 40; i++) {  // the status is checked in the background: ask again while it says "checking"
      let cur;
      try { cur = await api('GET', '/settings/claude-code'); } catch (e) { box.appendChild(problemBox(toProblem(e, where))); return; }
      if (!card.isConnected && i > 0) return;
      draw(cur);
      if (cur.status.state !== 'checking') return;
      await new Promise(r => setTimeout(r, 2500));
    }
  })();
  return card;
}

/** ⚡ Make a book: "Use Claude Code helpers" for this run (ticked when they are ready). */
export function makeSetupField(c) {
  const { h, api } = c;
  const box = h('input', { type: 'checkbox', id: 'mb-cc', 'data-testid': 'mb-cc', checked: false, disabled: true });
  const status = h('div', { 'aria-live': 'polite' });
  const el = h('fieldset', { class: 'field cc-switch' }, h('legend', null, '🤖 Claude Code helpers'),
    h('div', { class: 'check-row' }, box, h('label', { for: 'mb-cc' }, h('strong', null, 'Use Claude Code helpers for this book'))), status,
    h('p', { class: 'hint' }, 'Research ahead, fact checks with sources, checks side by side and a “sounds like AI” pass, several at a time — faster, and nothing waits for them: without them the web AIs do the work. Shares your Claude plan’s limits. Settings › 🤖 Claude Code helpers has the details.'));
  let ready = false;
  (async () => {
    for (let i = 0; i < 40; i++) {
      let cur;
      try { cur = await api('GET', '/settings/claude-code'); } catch { return; /* the run works without them */ }
      ready = !!cur.active;
      box.checked = ready; box.disabled = !ready;
      c.clear(status).appendChild(statusLine(c, Object.assign({ install_url: cur.install_url }, cur.status), 'mb-cc-status'));
      if (cur.status.state !== 'checking' || (!el.isConnected && i > 0)) return;
      await new Promise(r => setTimeout(r, 2500));
    }
  })();
  return { el, box, apply(body) { if (ready && !box.checked) body.claude_code = false; } };
}

/** The run window: how long the checks took with the helpers and one after another. */
export function runLine(c, r) {
  const hl = r && r.costs && r.costs.helpers;
  if (!hl || !hl.line) return null;
  return c.h('p', { class: 'small mb-cc-line', 'data-testid': 'mb-cc-line' }, hl.line);
}

/** The chapter page: research notes, the sourced fact check and the proposed rewrites (✔ Use = a new draft). */
export function chapterBox(c, rid, { onSaved } = {}) {
  const { h, api, bpath, clear, toast, problemBox, toProblem } = c;
  const title = h('h2', null, '🤖 Claude Code helpers');
  const box = h('section', { class: 'card cc-chapter', 'data-testid': 'cc-chapter', hidden: true }, title);
  const body = h('div', { 'aria-live': 'polite' });
  box.appendChild(body);
  const where = { step: 'Claude Code helpers' };
  const draw = async () => {
    let info;
    try { info = await api('GET', bpath(`/review/claude-code/chapter/${encodeURIComponent(rid)}`)); } catch { return; }
    const notes = info.research_notes || [];
    const claims = (info.facts && info.facts.claims) || [];
    const props = info.proposals || [];
    if (!notes.length && !claims.length && !props.length) return;
    box.hidden = false;
    // ✍ only the end-of-book suggestions (no helper notes): a plain title, the helpers may be off
    if (!notes.length && !claims.length && props.every(p => p.kind === 'voice')) title.textContent = '✍ Suggestions to sound more like a person';
    clear(body);
    if (notes.length) body.appendChild(h('details', { 'data-testid': 'cc-notes' }, h('summary', null, `📚 Research notes for this chapter (${notes.length})`),
      h('ul', { class: 'plain-list' }, notes.map(n => h('li', null, h('strong', null, `${n.label}: `), n.topic ? `${n.topic} — ` : '', n.note,
        n.source ? [' ', h('a', { href: n.source, target: '_blank', rel: 'noopener noreferrer' }, 'source')] : null)))));
    if (claims.length) body.appendChild(h('details', { 'data-testid': 'cc-facts' }, h('summary', null, `🔎 Fact check with sources (${claims.length} claim${claims.length === 1 ? '' : 's'})`),
      h('ul', { class: 'plain-list' }, claims.map(x => h('li', null, h('strong', null, `${x.verdict.replace('_', ' ')}: `), x.claim, ` (${x.label_words})`,
        x.source_url ? [' ', h('a', { href: x.source_url, target: '_blank', rel: 'noopener noreferrer' }, 'source')] : null)))));
    if (props.length) {
      const ticks = props.map(p => {
        const id = `cc-p-${p.id}`;
        const b = h('input', { type: 'checkbox', id, value: p.id, checked: true });
        return h('div', { class: 'check-row cc-prop', 'data-kind': p.kind }, b, h('label', { for: id },
          h('span', { class: 'muted' }, p.kind === 'fact' ? 'Fact fix: ' : p.kind === 'voice' ? 'To sound more like a person: ' : 'Sounds like AI: '), h('del', null, p.original), ' → ', h('ins', null, p.replacement),
          h('span', { class: 'small muted' }, ` — ${p.problem}`)));
      });
      const msg = h('div', { 'aria-live': 'polite' });
      const use = h('button', { type: 'button', class: 'primary small', 'data-testid': 'cc-use', onclick: async () => {
        const ids = ticks.map(t => t.querySelector('input')).filter(b => b.checked).map(b => b.value);
        if (!ids.length) return;
        use.disabled = true;
        try { const out = await api('POST', bpath(`/review/claude-code/chapter/${encodeURIComponent(rid)}/use`), { body: { ids } }); toast(out.message); if (onSaved) onSaved(out); }
        catch (e) { clear(msg).appendChild(problemBox(toProblem(e, where))); use.disabled = false; }
      } }, '✔ Use the ticked changes (a new draft for you to approve)');
      body.appendChild(h('div', { 'data-testid': 'cc-proposals' }, h('p', { class: 'small' }, `${props.length} proposed change${props.length === 1 ? '' : 's'} — nothing is changed until you use them:`), ...ticks, msg, h('div', { class: 'row' }, use)));
    }
  };
  draw();
  return box;
}
