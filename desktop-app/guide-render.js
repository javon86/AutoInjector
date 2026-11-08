'use strict';
/*
 * guide-render.js — turns the user guide (docs/USER_GUIDE.md) into one safe HTML page for Help → 📖 User guide.
 * A small Markdown reader for what the guide uses: # headings (with anchors), paragraphs, - / 1. lists (nested by
 * indent), > notes, | tables |, ``` code ```, --- lines, **bold**, *italic*, `code` and [links](…).
 * Everything is HTML-escaped first; links may only be #anchors or http(s) addresses (the window opens those in
 * the browser). No scripts in the page. Pure, so it is unit-tested.
 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function slug(text) {
  return String(text).toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
}

function inline(raw) {
  let s = esc(raw);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => {
    const h = href.replace(/&amp;/g, '&');
    if (/^#[\w\p{L}-]*$/u.test(h)) return `<a href="${esc(h)}">${t}</a>`;
    if (/^https?:\/\//i.test(h)) return `<a href="${esc(h)}" class="ext">${t}</a>`;
    return t; // a link to a file in the repository: show the words only
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

function render(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const toc = [];
  const used = new Set();
  let i = 0;
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const listRe = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const hm = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hm) {
      flush();
      const level = hm[1].length;
      let id = slug(hm[2]) || `section-${out.length}`;
      while (used.has(id)) id += '-x';
      used.add(id);
      if (level === 2) toc.push({ id, text: hm[2] });
      out.push(`<h${level} id="${esc(id)}">${inline(hm[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote>${buf.map((b) => (b.trim() ? `<p>${inline(b)}</p>` : '')).join('')}</blockquote>`);
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flush();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (listRe.test(line)) {
      flush();
      // nested lists by indent
      const stack = []; // { indent, tag }
      let html = '';
      while (i < lines.length) {
        const m = listRe.exec(lines[i]);
        if (!m) {
          // a continuation line of the last item (indented text)
          if (/^\s{2,}\S/.test(lines[i]) && stack.length) { html = html.replace(/<\/li>$/, ` ${inline(lines[i].trim())}</li>`); i++; continue; }
          break;
        }
        const indent = m[1].length;
        const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
        if (!stack.length || indent > stack[stack.length - 1].indent) {
          if (stack.length) html = html.replace(/<\/li>$/, '');
          stack.push({ indent, tag });
          html += `<${tag}>`;
        } else {
          while (stack.length > 1 && indent < stack[stack.length - 1].indent) { html += `</${stack.pop().tag}></li>`; }
        }
        html += `<li>${inline(m[3])}</li>`;
        i++;
      }
      while (stack.length) { const t = stack.pop().tag; html += `</${t}>${stack.length ? '</li>' : ''}`; }
      out.push(html);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line.trim());
    i++;
  }
  flush();
  return { html: out.join('\n'), toc };
}

const PAGE_CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#111;color:#e8e8e8;font:15px/1.6 system-ui,'Segoe UI',sans-serif;display:flex;height:100vh}
nav{flex:0 0 250px;overflow:auto;background:#161616;border-right:1px solid #2a2a2a;padding:14px 12px;font-size:13.5px}
nav b{display:block;margin-bottom:8px;color:#9fe7b5}
nav a{display:block;color:#cfd8ff;text-decoration:none;padding:3px 6px;border-radius:5px}
nav a:hover{background:#222}
main{flex:1 1 auto;overflow:auto;padding:18px 28px 60px;max-width:none}
main > *{max-width:860px}
h1{font-size:24px;margin:4px 0 10px}h2{font-size:19px;margin:26px 0 8px;padding-top:6px;border-top:1px solid #2a2a2a}h3{font-size:16px;margin:18px 0 6px}
a{color:#9db4ff}code{background:#1d1d1d;border:1px solid #2c2c2c;border-radius:4px;padding:0 4px;font-size:13px}
pre{background:#161616;border:1px solid #2a2a2a;border-radius:6px;padding:8px 10px;overflow:auto}
pre code{border:0;padding:0;background:none}
blockquote{margin:10px 0;padding:6px 12px;border-left:3px solid #3f6b4c;background:#151d17;border-radius:4px}
table{border-collapse:collapse;margin:8px 0;font-size:14px}th,td{border:1px solid #2f2f2f;padding:5px 8px;text-align:left;vertical-align:top}th{background:#1a1a1a}
li{margin:2px 0}
@media (max-width:900px){nav{display:none}main{padding:14px 16px}}
`;

/** The whole page (no scripts). title: the window's title. */
function page(md, { title = 'AutoInjector — User guide' } = {}) {
  const r = render(md);
  const nav = r.toc.length ? `<nav aria-label="Contents"><b>Contents</b>${r.toc.map((t) => `<a href="#${esc(t.id)}">${inline(t.text)}</a>`).join('')}</nav>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body>${nav}<main id="guide">${r.html}</main></body></html>`;
}

module.exports = { render, page, inline, slug, esc };
