// test/akowe-legacy.test.js — BookForge was renamed to Akọwe (2026-10-25). An
// existing install must keep its saved pairing (the connection key file), its
// bridge on/off setting, its environment variables and its logs; an Akọwe
// still calling itself "bookforge" must still be recognised.
// Run with: node test/akowe-legacy.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const legacy = require("../akowe-legacy");
const bridgeMod = require("../akowe-bridge");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "akowe-legacy-"));

console.log("== the saved connection key (pairing) survives the rename ==");
{
  const dir = tmp();
  const key = "old-paired-key-abcdefghijklmnopqrstuvwxyz-0123";
  fs.writeFileSync(path.join(dir, legacy.OLD_TOKEN_FILE), key + "\n", { mode: 0o600 });
  assert(bridgeMod.readToken(dir) === key, "readToken finds the key saved as bookforge-bridge-token");
  assert(fs.existsSync(path.join(dir, "akowe-bridge-token")) && !fs.existsSync(path.join(dir, legacy.OLD_TOKEN_FILE)), "…and takes the file over as akowe-bridge-token");
  assert(bridgeMod.loadOrCreateToken(dir) === key, "loadOrCreateToken keeps that key (no new key, no re-pairing)");
  if (process.platform !== "win32") assert((fs.statSync(path.join(dir, "akowe-bridge-token")).mode & 0o777) === 0o600, "the key file stays 0600");
}
{
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "akowe-bridge-token"), "new-key-abcdefghijklmnopqrstuvwxyz-0123456");
  fs.writeFileSync(path.join(dir, legacy.OLD_TOKEN_FILE), "old-key-abcdefghijklmnopqrstuvwxyz-0123456");
  assert(bridgeMod.readToken(dir) === "new-key-abcdefghijklmnopqrstuvwxyz-0123456", "a new key file is never overwritten by an old one");
  const empty = tmp();
  assert(bridgeMod.readToken(empty) === "", "no key at all: still none");
}

console.log("== the saved bridge setting ==");
assert(legacy.settingsFrom({ bookforge: { enabled: true } }).enabled === true, "the setting saved as \"bookforge\" is read");
assert(legacy.settingsFrom({ akowe: { enabled: false }, bookforge: { enabled: true } }).enabled === false, "the new key wins over the old one");
assert(legacy.settingsFrom({}) === null && legacy.settingsFrom(null) === null, "nothing saved: null");

console.log("== environment variables ==");
assert(legacy.aiEnv("PORT", { AUTOINJECTOR_BOOKFORGE_PORT: "17999" }) === "17999", "AUTOINJECTOR_BOOKFORGE_PORT is still read");
assert(legacy.aiEnv("PORT", { AUTOINJECTOR_AKOWE_PORT: "17998", AUTOINJECTOR_BOOKFORGE_PORT: "17999" }) === "17998", "AUTOINJECTOR_AKOWE_PORT wins");
assert(legacy.aiEnv("DIR", {}) === "", "unset: empty");
assert(legacy.appEnv("PORT", { BOOKFORGE_PORT: "8790" }) === "8790" && legacy.appEnv("PORT", { AKOWE_PORT: "8791", BOOKFORGE_PORT: "8790" }) === "8791", "AKOWE_PORT, else BOOKFORGE_PORT");

console.log("== an Akọwe from before the rename ==");
assert(legacy.isAppId("akowe") && legacy.isAppId("bookforge") && !legacy.isAppId("other") && !legacy.isAppId(undefined), "ping/status app ids");
{
  const r = bridgeMod.sanitizeAkoweStatus({ app: "bookforge", version: 1, bookforge_url: "http://127.0.0.1:8780/", done: 1, total: 3, checklist: [] });
  assert(r.ok && r.value.app === "akowe" && r.value.akowe_url === "http://127.0.0.1:8780/", "an old status push (app bookforge, bookforge_url) is accepted as Akọwe's");
  const n = bridgeMod.sanitizeAkoweStatus({ app: "akowe", version: 1, akowe_url: "http://127.0.0.1:8781/", checklist: [] });
  assert(n.ok && n.value.akowe_url === "http://127.0.0.1:8781/", "the new status push");
  const bad = bridgeMod.sanitizeAkoweStatus({ app: "other", version: 1 });
  assert(bad.ok === false, "another app's status is refused");
}

console.log("== logs and the Extract book list ==");
assert(legacy.isAkoweEventKind("akowe-request") && legacy.isAkoweEventKind("bookforge-request") && !legacy.isAkoweEventKind("sent") && !legacy.isAkoweEventKind(null), "old bookforge-* log events still count as Akọwe events");
{
  const dir = tmp();
  fs.writeFileSync(path.join(dir, legacy.OLD_EXTRACT_BOOKS_FILE), "{\"projects\":{}}");
  assert(legacy.adoptFile(dir, legacy.OLD_EXTRACT_BOOKS_FILE, "akowe-extract-books.json") === true && fs.readFileSync(path.join(dir, "akowe-extract-books.json"), "utf8") === "{\"projects\":{}}", "the book list file is taken over");
  assert(legacy.adoptFile(dir, legacy.OLD_EXTRACT_BOOKS_FILE, "akowe-extract-books.json") === false, "only once");
}

console.log("== the app folder next to AutoInjector ==");
{
  const c = legacy.launcherCandidates("/x/desktop-app", "", "linux");
  assert(c[0] === path.join("/x/akowe", "run-akowe.sh") && c.includes(path.join("/x/bookforge", "run-bookforge.sh")), "../akowe/run-akowe.sh first, the old ../bookforge/run-bookforge.sh still found");
  const w = legacy.launcherCandidates("/x/desktop-app", "/my/dir", "win32");
  assert(w.length === 2 && w[0] === path.join("/my/dir", "run-akowe.bat"), "AUTOINJECTOR_AKOWE_DIR: only that folder (run-akowe.bat, then run-bookforge.bat)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
