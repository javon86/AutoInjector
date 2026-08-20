// test/file-downloader.test.js — the HTTP file downloader, exercised against a
// throwaway local server (no real network). Run: node test/file-downloader.test.js
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { download } = require("../file-downloader");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}

function tmpFile(name) { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dl-")), name); }

// A tiny server: /file streams N bytes with a content-length; /redirect 302s to
// /file; /slow streams slowly so the abort test has time to fire.
function makeServer() {
  const body = Buffer.alloc(64 * 1024, 7); // 64 KiB of 0x07
  const srv = http.createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/file" }); return res.end(); }
    if (req.url === "/missing") { res.writeHead(404); return res.end("nope"); }
    if (req.url === "/stall") {
      // Send headers, then go silent forever (never write the body).
      res.writeHead(200, { "content-length": String(body.length) });
      return; // no res.end — the socket stalls
    }
    if (req.url === "/slow") {
      res.writeHead(200, { "content-length": String(body.length) });
      let i = 0;
      const timer = setInterval(() => {
        if (i >= body.length) { clearInterval(timer); return res.end(); }
        res.write(body.slice(i, i + 4096)); i += 4096;
      }, 25);
      req.on("close", () => clearInterval(timer));
      return;
    }
    res.writeHead(200, { "content-length": String(body.length) });
    res.end(body);
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port, size: body.length })));
}

async function main() {
  const { srv, port, size } = await makeServer();
  const base = `http://127.0.0.1:${port}`;

  console.log("\n== download(): writes the file and reports progress ==");
  {
    const dest = tmpFile("out.bin");
    let lastPct = -1, sawTotal = 0;
    const r = await download(`${base}/file`, dest, { onProgress: (p) => { lastPct = p.pct; sawTotal = p.total; } });
    assert(r.ok && r.bytes === size, "resolves ok with the full byte count");
    assert(fs.existsSync(dest) && fs.statSync(dest).size === size, "the destination file has the right size");
    assert(lastPct === 100 && sawTotal === size, "progress reaches 100% with the known total");
    assert(!fs.existsSync(dest + ".part"), "the .part temp file is cleaned up");
  }

  console.log("\n== follows redirects ==");
  {
    const dest = tmpFile("redir.bin");
    const r = await download(`${base}/redirect`, dest, {});
    assert(r.ok && fs.statSync(dest).size === size, "a 302 is followed to the real file");
  }

  console.log("\n== a bad status rejects, no file left behind ==");
  {
    const dest = tmpFile("miss.bin");
    let err = null;
    await download(`${base}/missing`, dest, {}).catch((e) => { err = e; });
    assert(err && /404/.test(err.message), "HTTP 404 rejects with the status");
    assert(!fs.existsSync(dest) && !fs.existsSync(dest + ".part"), "no partial file remains after a failed download");
  }

  console.log("\n== abort stops the download and removes the partial ==");
  {
    const dest = tmpFile("abort.bin");
    const ac = new AbortController();
    const p = download(`${base}/slow`, dest, { signal: ac.signal });
    setTimeout(() => ac.abort(), 40);
    let err = null;
    await p.catch((e) => { err = e; });
    assert(err && /abort/i.test(err.message), "aborting rejects with an abort error");
    // give the fs a tick to unlink
    await new Promise((r) => setTimeout(r, 50));
    assert(!fs.existsSync(dest), "no completed file after abort");
  }

  console.log("\n== a stalled connection times out (does not hang forever) ==");
  {
    const dest = tmpFile("stall.bin");
    const t0 = Date.now();
    let err = null;
    await download(`${base}/stall`, dest, { timeoutMs: 300 }).catch((e) => { err = e; });
    assert(err && /timed out/.test(err.message), "a silent connection rejects with a timeout");
    assert(Date.now() - t0 < 3000, "it gives up quickly (~timeoutMs), not hanging");
    await new Promise((r) => setTimeout(r, 50));
    assert(!fs.existsSync(dest) && !fs.existsSync(dest + ".part"), "no file/partial left after a timeout");
  }

  srv.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
