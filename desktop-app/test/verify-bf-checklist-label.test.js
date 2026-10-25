// verify-bf-checklist-label.test.js — ACCEPT-5 (acceptance run, Akọwe panel screenshot): the Book checklist chip
// for Akọwe's "chapters" step (id "chapters", set "C") reads "hapters": bfShortLabel() strips a leading set
// letter from ANY id that starts with it, meant only for op codes like "B03" -> "03".
"use strict";
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "controls.js"), "utf8");
const m = /function bfShortLabel\(r\) \{[\s\S]*?\n\}/.exec(src);
if (!m) { console.log("FAIL: bfShortLabel not found"); process.exit(1); }
const bfShortLabel = new Function(`${m[0]}; return bfShortLabel;`)();
let fails = 0;
const eq = (got, want, what) => { const ok = got === want; if (!ok) fails++; console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`); };
// Akọwe's status push (akowe/status_push.py) sends {id: <step id>, title, set}
eq(bfShortLabel({ id: "B03", set: "B", title: "Main plot" }), "03", "op code B03 in set B");
eq(bfShortLabel({ id: "premise", set: "B", title: "Premise" }), "premise", "step id premise (set B)");
eq(bfShortLabel({ id: "chapters", set: "C", title: "Write the chapters" }), "chapters", "step id chapters (set C)");
eq(bfShortLabel({ id: "check", set: "H", title: "Check the book" }), "check", "step id check (set H)");
eq(bfShortLabel({ id: "assemble", set: "G", title: "Put the book together" }), "assemble", "step id assemble (set G)");
console.log(fails ? `\n${fails} FAIL` : "\nPASS");
process.exit(fails ? 1 : 0);
