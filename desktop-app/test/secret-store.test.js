// test/secret-store.test.js — AI-001: provider API keys are never written to
// disk as plaintext, and legacy plaintext files are migrated on load.
// Run: node test/secret-store.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const secret = require('../secret-store');
const lsi = require('../lsi-provider');
const sd = require('../sd-provider');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

function main() {
  console.log('\n== secret-store degrades safely without Electron ==');
  // In plain Node there is no OS keychain: it must report unavailable and never
  // hand back a readable key (callers then persist nothing rather than plaintext).
  assert(secret.available() === false, 'encryption is reported unavailable outside Electron');
  assert(secret.seal('sk-abc') === null, 'seal() returns null when encryption is unavailable');
  assert(secret.open('anything') === '', "open() returns '' when encryption is unavailable");

  console.log('\n== LSI key is never persisted as plaintext ==');
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'lsi-'));
  lsi.init(d1);
  lsi.setSettings({ enabled: true, endpoint: 'http://x', model: 'm', apiKey: 'sk-PLAINTEXT-1' });
  const disk1 = fs.readFileSync(path.join(d1, 'lsi-settings.json'), 'utf8');
  assert(!disk1.includes('sk-PLAINTEXT-1'), 'the raw key is not in lsi-settings.json');
  assert(!/"apiKey"/.test(disk1), 'no plaintext apiKey field is written');
  assert(lsi.getSettings().hasApiKey === true && lsi.getSettings().apiKey === undefined,
    'getSettings still reports hasApiKey without leaking the key');

  console.log('\n== legacy plaintext files are migrated on load ==');
  // Simulate an OLD settings file that stored the key in the clear.
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-'));
  fs.writeFileSync(path.join(d2, 'sd-settings.json'), JSON.stringify({ enabled: true, endpoint: 'http://sd', apiKey: 'sk-LEGACY-9' }, null, 2));
  sd.init(d2); // loading should rewrite it without the plaintext key
  const disk2 = fs.readFileSync(path.join(d2, 'sd-settings.json'), 'utf8');
  assert(!disk2.includes('sk-LEGACY-9'), 'the legacy plaintext key is scrubbed from disk on load');
  assert(!/"apiKey"/.test(disk2), 'the migrated file has no plaintext apiKey field');
  assert(sd.getSettings().hasApiKey === true, 'the key is still usable in memory this session after migration');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
