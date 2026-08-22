// test/book-pdf.test.js — the dependency-free PDF writer + rules file-naming.
// Run: node test/book-pdf.test.js
const pdf = require("../book-pdf");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}

function main() {
  console.log("\n== rules file naming (§36/§37) ==");
  assert(pdf.pdfFileName("Go Home", { kind: "chapter", number: 1, chapterTitle: "Voices Went First" }) === "Go Home - Chapter 01 - Voices Went First.pdf",
    "chapter PDF name follows [TITLE] - Chapter [NN] - [NAME].pdf");
  assert(pdf.pdfFileName("Go Home", { kind: "template", name: "Book Bible" }) === "Go Home - Book Bible.pdf",
    "template PDF name follows [TITLE] - [TEMPLATE].pdf");
  assert(pdf.pdfFileName("Go Home", { kind: "template", name: "Character Master Record", subject: "Elias Vale" }) === "Go Home - Character Master Record - Elias Vale.pdf",
    "template PDF name includes the subject when given");
  assert(!/[\\/:*?"<>|]/.test(pdf.pdfFileName("Ba:d/Ti*tle", { kind: "template", name: "X" })),
    "illegal filename characters are stripped");

  console.log("\n== the writer produces a real, valid, multi-page PDF ==");
  const body = Array.from({ length: 200 }, (_, i) => `Paragraph ${i + 1}. ` + "word ".repeat(30)).join("\n");
  const buf = pdf.renderTextPdf("My Title — With “Smart” Punctuation • and → arrows ✓", body);
  assert(Buffer.isBuffer(buf) && buf.length > 1000, `renderTextPdf returns a non-trivial Buffer (${buf.length} bytes)`);
  const s = buf.toString("latin1");
  assert(s.startsWith("%PDF-1."), "starts with a PDF header");
  assert(s.trimEnd().endsWith("%%EOF"), "ends with %%EOF");
  assert(/\/Type\s*\/Catalog/.test(s) && /\/Type\s*\/Pages/.test(s) && /\/BaseFont\s*\/Helvetica/.test(s),
    "has a Catalog, Pages tree and the Helvetica font");
  // xref offsets must each point at the start of their object (a strict reader
  // rejects the file otherwise).
  const xs = parseInt(s.match(/startxref\s+(\d+)/)[1], 10);
  const offs = s.slice(xs).match(/(\d{10}) \d{5} [nf]/g) || [];
  let offsetsOk = offs.length > 1;
  for (let i = 1; i < offs.length; i++) {
    const off = parseInt(offs[i].slice(0, 10), 10);
    if (!new RegExp("^" + i + " 0 obj").test(s.slice(off, off + 12))) offsetsOk = false;
  }
  assert(offsetsOk, `all ${offs.length} xref offsets resolve to their objects (valid cross-reference table)`);
  assert(/\/Count [2-9]/.test(s) || /\/Count \d\d/.test(s), "long text paginates to multiple pages");
  // Unicode we emit is transliterated, not dropped mid-word.
  assert(/My Title - With "Smart" Punctuation \* and -> arrows \[x\]/.test(pdf.toLatin("My Title — With “Smart” Punctuation • and → arrows ✓")),
    "smart quotes / dashes / bullets / arrows / checks transliterate to ASCII");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
