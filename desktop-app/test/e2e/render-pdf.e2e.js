'use strict';
// test/e2e/render-pdf.e2e.js — POST /render/pdf in REAL Electron (render-pdf.js + service-bridge.js): a 3-page HTML
// page with a data: URI picture, a CSS background, a header / footer with page numbers becomes a real PDF through the
// token-protected bridge, and pictures / stylesheets / fonts / header pictures pointing at the network are NOT fetched.
// Run: xvfb-run -a node test/e2e/render-pdf.e2e.js   (node re-launches itself inside Electron)
const path = require('path');

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const electronBin = require('electron');
  const r = spawnSync(electronBin, ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', __filename], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, env: Object.assign({}, process.env, { ELECTRON_ENABLE_LOGGING: '' }) });
  const out = String(r.stdout || '');
  process.stdout.write(out);
  if (r.status !== 0 || !/ 0 failed/.test(out)) { process.stderr.write(String(r.stderr || '').split('\n').filter((l) => !/dbus|Fontconfig|NODE_OPTION/.test(l)).join('\n')); process.exit(1); }
  process.exit(0);
}

const fs = require('fs');
const os = require('os');
const http = require('http');
const electron = require('electron');
const { app } = electron;
const renderPdf = require(path.join(__dirname, '..', '..', 'render-pdf'));
const { createServiceBridge } = require(path.join(__dirname, '..', '..', 'service-bridge'));

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

function post(port, token, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, token ? { Authorization: `Bearer ${token}` } : {}, extraHeaders || {});
    const rq = http.request({ host: '127.0.0.1', port, path: '/render/pdf', method: 'POST', headers }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch (e) { reject(e); } });
    });
    rq.on('error', reject); rq.write(data); rq.end();
  });
}

// a 4 × 4 red PNG, made here (no files needed)
function redPngDataUri() {
  const img = electron.nativeImage.createFromBitmap(Buffer.alloc(4 * 4 * 4, 0).map((_, i) => [0, 0, 255, 255][i % 4]), { width: 4, height: 4 });
  return 'data:image/png;base64,' + img.toPNG().toString('base64');
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  // every network request from the page (or its header/footer) would show up here — none may happen
  let netHits = 0;
  const hitPaths = [];
  const trap = http.createServer((q, s) => { netHits++; hitPaths.push(q.url); s.end('x'); });
  await new Promise((r) => trap.listen(0, '127.0.0.1', r));
  const T = `http://127.0.0.1:${trap.address().port}`;

  const tmpBefore = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ai-renderpdf-')));
  const bridge = createServiceBridge({ pdfRenderer: renderPdf.createPdfRenderer({ makeWindow: renderPdf.electronWindowFactory(electron) }) });
  const st = await bridge.start({ port: 0, token: 'e2e-token' });
  try {
    console.log('\n== 🖨 HTML → PDF in real Chromium ==');
    const page = (n) => `<section class="pg"><h1>Chapter ${n}</h1><img alt="dot" src="${redPngDataUri()}" width="60" height="60">`
      + `<p>${'Lorem ipsum dolor sit amet. '.repeat(40)}</p><img alt="net" src="${T}/img-${n}.png" width="10" height="10"></section>`;
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>old</title>'
      + `<link rel="stylesheet" href="${T}/style.css">`
      + '<style>'
      + `@font-face{font-family:Net;src:url(${T}/font.woff2)}`
      + `body{font-family:Net,serif;margin:0} .pg{page-break-after:always;break-after:page;min-height:200px;padding:20px;`
      + `background:#f4ecd8 url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'><rect width='8' height='8' fill='%23e0d0a0'/></svg>")}`
      + `.pg:last-child{page-break-after:auto;break-after:auto} h1{background-image:url(${T}/bg.png)}`
      + '</style><script>document.title="script ran"; fetch("' + T + '/script")</script></head><body>'
      + page(1) + page(2) + page(3)
      + `<iframe src="${T}/frame.html"></iframe></body></html>`;
    const t0 = Date.now();
    const r = await post(st.port, 'e2e-token', {
      html, title: 'Salt — Book Bible', pageSize: 'A4', printBackground: true, margins: { top: 20, bottom: 20, left: 15, right: 15 },
      headerFooter: { header: `<div style="font-size:8px;width:100%;text-align:center"><span class="title"></span><img src="${T}/hdr.png"></div>`, footer: '<div style="font-size:8px;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span><script>fetch("x")</script></div>' },
    });
    const ms = Date.now() - t0;
    assert(r.status === 200 && r.json.ok === true && r.json.mime === 'application/pdf', `the bridge answers 200 with a PDF (${r.json.bytes} bytes, ${r.json.pages} pages, ${ms} ms)`);
    const buf = Buffer.from(r.json.pdfBase64 || '', 'base64');
    assert(buf.slice(0, 5).toString('latin1') === '%PDF-' && buf.length === r.json.bytes, 'the bytes are a PDF (start with %PDF-) and "bytes" is their length');
    const pages = renderPdf.countPages(buf);
    assert(pages >= 3 && r.json.pages === pages, `it has at least 3 pages (${pages} /Type /Page objects; "pages" says ${r.json.pages})`);
    assert(/\/Image\b/.test(buf.toString('latin1')), 'the data: URI picture is embedded in the PDF (an /Image XObject)');
    const titleHex = 'FEFF' + Buffer.from('Salt — Book Bible', 'utf16le').swap16().toString('hex').toUpperCase();
    const pdfTitle = (buf.toString('latin1').match(/\/Title\s*(<[0-9A-Fa-f]+>|\([^)]*\))/) || [])[1] || '';
    assert(pdfTitle.toUpperCase() === `<${titleHex}>` || pdfTitle === '(Salt — Book Bible)', `"title" became the PDF title, not the page's own <title> or what its (blocked) script would set: ${pdfTitle.slice(0, 80)}`);
    assert(netHits === 0, `nothing on the network was fetched (stylesheet, font, pictures, CSS background, iframe, script, header picture): ${netHits} hits ${hitPaths.join(' ')}`);
    assert(ms < 15000, `it does not wait out a long pause (${ms} ms)`);

    // a long binder: 80 pages, each with the picture
    const longHtml = '<!doctype html><style>.pg{break-after:page}.pg:last-child{break-after:auto}</style>' + Array.from({ length: 80 }, (_, i) => `<div class="pg"><h2>Page ${i + 1}</h2><img src="${redPngDataUri()}" width="40" height="40"></div>`).join('');
    const t1 = Date.now();
    const long = await post(st.port, 'e2e-token', { html: longHtml, headerFooter: { footer: '<div style="font-size:8px"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' } });
    assert(long.status === 200 && long.json.pages === 80, `a long page prints every page (${long.json.pages} of 80, ${Date.now() - t1} ms)`);

    const letter = await post(st.port, 'e2e-token', { html: '<!doctype html><p>one page</p>', pageSize: 'Letter', landscape: true });
    const lb = Buffer.from(letter.json.pdfBase64 || '', 'base64').toString('latin1');
    const box = lb.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
    assert(letter.status === 200 && letter.json.pages === 1 && box && Math.round(Number(box[1])) === 792 && Math.round(Number(box[2])) === 612, `Letter landscape gives one 792 × 612 pt page (${box && box[1]} × ${box && box[2]})`);

    const noTok = await post(st.port, null, { html: '<p>x</p>' });
    assert(noTok.status === 401, 'the token is required');
    const foreign = await post(st.port, 'e2e-token', { html: '<p>x</p>' }, { Origin: 'https://evil.example' });
    assert(foreign.status === 403, 'a foreign browser Origin is refused');
    const bad = await post(st.port, 'e2e-token', { html: '<p>x</p>', pageSize: 'A3' });
    assert(bad.status === 400 && bad.json.error === 'INVALID_PARAM', 'an unknown page size is refused');
    assert(netHits === 0, 'still nothing fetched from the network');
    const tmpAfter = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ai-renderpdf-') && !tmpBefore.has(n));
    assert(tmpAfter.length === 0, `the temp folders are removed (${tmpAfter.length} left)`);
  } catch (e) {
    assert(false, `crashed: ${(e && e.stack) || e}`);
  } finally {
    await bridge.stop();
    trap.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
});
