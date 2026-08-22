'use strict';
/*
 * book-pdf.js — a tiny, dependency-free PDF writer for the Book Studio's
 * "PDF Completion Gate" (Rules of Conduct §36–39): every filled-out template,
 * record and finished chapter must exist as a real, downloadable PDF before it
 * counts as complete. This produces a valid, openable PDF from plain text using
 * the built-in Helvetica font (no fonts embedded, no external libraries), so it
 * works offline on any machine. It also owns the rules' file-naming convention.
 *
 * Kept Electron-free so it's unit-testable and callable from book-project.js.
 */

// --- File naming (Rules §36/§37) -------------------------------------------
// Template:  "[BOOK TITLE] - [TEMPLATE NAME] - [SUBJECT].pdf"
// Chapter:   "[BOOK TITLE] - Chapter [NN] - [TITLE].pdf"
function cleanPart(s, fallback) {
  let out = String(s == null ? '' : s)
    .replace(/[\/\\]+/g, ' ')          // no path separators
    .replace(/[\x00-\x1f<>:"|?*]+/g, '') // no control/illegal filename chars
    .replace(/\s+/g, ' ').trim()
    .slice(0, 80).trim();
  return out || fallback || 'Document';
}
function pad2(n) { const x = parseInt(n, 10); return String(isNaN(x) ? 1 : x).padStart(2, '0'); }

function pdfFileName(bookTitle, opts) {
  const o = opts || {};
  const title = cleanPart(bookTitle, 'Book');
  if (o.kind === 'chapter') {
    const ct = o.chapterTitle ? ' - ' + cleanPart(o.chapterTitle, '') : '';
    return `${title} - Chapter ${pad2(o.number)}${ct}.pdf`;
  }
  const subj = o.subject ? ' - ' + cleanPart(o.subject, '') : '';
  return `${title} - ${cleanPart(o.name, 'Document')}${subj}.pdf`;
}

// --- Text -> PDF ------------------------------------------------------------
// Transliterate the Unicode we actually emit (smart quotes, dashes, arrows,
// bullets, checkmarks) down to WinAnsi-safe ASCII so Helvetica renders it,
// and drop anything else non-printable.
function toLatin(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[•●▪·]/g, '*')
    .replace(/→/g, '->')
    .replace(/[✓✔]/g, '[x]')
    .replace(/ /g, ' ')
    .replace(/[^\x09\x0a\x20-\x7e]/g, ''); // keep tab, newline, printable ASCII
}
function pdfEscape(s) { return s.replace(/([\\()])/g, '\\$1'); }

// Word-wrap a single logical line to a character budget (Helvetica ~0.5em avg).
function wrap(line, maxChars) {
  const tabbed = line.replace(/\t/g, '    ');
  if (tabbed.length <= maxChars) return [tabbed];
  const words = tabbed.split(/(\s+)/); // keep spaces so we don't lose them
  const out = [];
  let cur = '';
  for (const w of words) {
    if ((cur + w).length > maxChars && cur.trim() !== '') { out.push(cur.replace(/\s+$/, '')); cur = w.replace(/^\s+/, ''); }
    else cur += w;
    // hard-break a single word longer than the budget
    while (cur.length > maxChars) { out.push(cur.slice(0, maxChars)); cur = cur.slice(maxChars); }
  }
  if (cur.trim() !== '' || out.length === 0) out.push(cur.replace(/\s+$/, ''));
  return out;
}

/**
 * Render `title` + `body` text into a valid PDF (US Letter, Helvetica 11pt),
 * returning a Buffer. Handles multi-page pagination.
 */
function renderTextPdf(title, body) {
  const PAGE_W = 612, PAGE_H = 792, MARGIN = 54;
  const FS = 11, LEADING = 15, TITLE_FS = 16;
  const usableW = PAGE_W - 2 * MARGIN;
  const maxChars = Math.max(20, Math.floor(usableW / (FS * 0.5)));
  const linesPerPage = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);

  // Build the flat list of display lines (title first).
  const raw = [];
  const t = toLatin(title || '').trim();
  if (t) { raw.push({ text: t, size: TITLE_FS }); raw.push({ text: '', size: FS }); }
  for (const ln of toLatin(body || '').split('\n')) {
    for (const w of wrap(ln, maxChars)) raw.push({ text: w, size: FS });
  }
  if (raw.length === 0) raw.push({ text: '', size: FS });

  // Paginate.
  const pages = [];
  for (let i = 0; i < raw.length; i += linesPerPage) pages.push(raw.slice(i, i + linesPerPage));
  if (pages.length === 0) pages.push([{ text: '', size: FS }]);

  // Content stream for one page.
  function contentFor(lines) {
    let y = PAGE_H - MARGIN;
    let s = 'BT\n';
    let first = true;
    for (const ln of lines) {
      const sz = ln.size || FS;
      if (first) { s += `/F1 ${sz} Tf\n${MARGIN} ${y} Td\n`; first = false; }
      else { s += `/F1 ${sz} Tf\n0 -${LEADING} Td\n`; }
      s += `(${pdfEscape(ln.text)}) Tj\n`;
      y -= LEADING;
    }
    s += 'ET';
    return s;
  }

  // Assemble objects. Layout:
  //   1 Catalog, 2 Pages, 3 Font, then per page: Page obj + Content obj.
  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>'); // 1
  const pageObjNums = [];
  // Reserve: obj 2 = Pages, obj 3 = Font. Pages start at obj 4.
  let objNum = 4;
  const pageContents = [];
  for (let p = 0; p < pages.length; p++) {
    const pageNo = objNum++;
    const contentNo = objNum++;
    pageObjNums.push(pageNo);
    pageContents.push({ pageNo, contentNo, stream: contentFor(pages[p]) });
  }
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageObjNums.length} >>`); // 2
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); // 3
  for (const pc of pageContents) {
    // page object
    objects[pc.pageNo - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pc.contentNo} 0 R >>`;
    // content stream object
    const bytes = Buffer.byteLength(pc.stream, 'latin1');
    objects[pc.contentNo - 1] = `<< /Length ${bytes} >>\nstream\n${pc.stream}\nendstream`;
  }

  // Serialize with a correct xref table.
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  const count = objects.length + 1;
  pdf += `xref\n0 ${count}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 0; i < objects.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

module.exports = { pdfFileName, renderTextPdf, cleanPart, toLatin };
