// test/output-manager.test.js — the output folder layout + safe file handling.
// Uses a throwaway temp dir as "Documents". Run: node test/output-manager.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const om = require("../output-manager");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}

function main() {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), "docs-"));
  const root = om.init(docs);

  console.log("\n== init lays out the output folder under Documents/AutoInjector ==");
  assert(root === path.join(docs, "AutoInjector", "output"), "root is <documents>/AutoInjector/output");
  assert(fs.existsSync(root), "the output folder is created");

  console.log("\n== category folders ==");
  assert(path.basename(om.imagesDir()) === "images" && fs.existsSync(om.imagesDir()), "images/ exists");
  assert(path.basename(om.videosDir()) === "videos", "videos/");
  assert(path.basename(om.uploadsDir()) === "uploads", "uploads/");
  assert(om.bookDir("My Great Book").endsWith(path.join("books", "My Great Book")), "books/<title>/");
  assert(om.aiWorkDir("claude").endsWith(path.join("ai-work", "claude")), "ai-work/<site>/");

  console.log("\n== name sanitization blocks path traversal and illegal chars ==");
  assert(om.safeName("../../etc/passwd") === "etc passwd", "strips ../ and separators");
  assert(om.safeName("..") === "untitled", "a pure-traversal name falls back");
  assert(!/[\\/]/.test(om.safeName("a/b\\c")), "no separators survive");
  assert(om.safeName("") === "untitled", "empty -> fallback");
  // A malicious book title cannot escape the books folder.
  const evil = om.bookDir("../../secret");
  assert(evil.startsWith(path.join(root, "books")) && evil.includes("secret"), "a traversal title stays inside books/");

  console.log("\n== saveBuffer writes and never clobbers ==");
  const a = om.saveBuffer(om.imagesDir(), "pic.png", Buffer.from([1, 2, 3]));
  const b = om.saveBuffer(om.imagesDir(), "pic.png", Buffer.from([4, 5, 6]));
  assert(fs.existsSync(a) && fs.existsSync(b), "both writes land");
  assert(a !== b && /pic-1\.png$/.test(b), "the second write becomes pic-1.png (no overwrite)");
  assert(fs.readFileSync(a).length === 3 && fs.readFileSync(b).length === 3, "contents are independent");

  console.log("\n== copyInto copies an existing file in ==");
  const src = path.join(docs, "some upload.txt");
  fs.writeFileSync(src, "hello");
  const dest = om.copyInto(om.uploadsDir(), src);
  assert(fs.existsSync(dest) && dest.endsWith(path.join("uploads", "some upload.txt")), "copied into uploads/ under its name");
  assert(fs.readFileSync(dest, "utf8") === "hello", "content copied intact");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
