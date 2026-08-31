// test/secret-store.test.js — AI-001: the secret store never hands back a
// readable key outside Electron, so callers persist nothing rather than
// plaintext. (The provider-specific persistence tests moved out with the
// Stable Diffusion / LSI providers when the app was reduced to its core.)
// Run: node test/secret-store.test.js
const secret = require('../secret-store');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

function main() {
  console.log('\n== secret-store degrades safely without Electron ==');
  // In plain Node there is no OS keychain: it must report unavailable and never
  // hand back a readable key (callers then persist nothing rather than plaintext).
  assert(secret.available() === false, 'encryption is reported unavailable outside Electron');
  assert(secret.seal('sk-abc') === null, 'seal() returns null when encryption is unavailable');
  assert(secret.open('anything') === '', "open() returns '' when encryption is unavailable");
  assert(secret.open(null) === '', "open(null) returns '' rather than throwing");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
