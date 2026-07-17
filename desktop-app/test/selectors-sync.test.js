// test/selectors-sync.test.js — desktop-app/selectors.js and
// ../AutoInjector/extension/selectors.js describe the exact same three sites'
// DOM selectors, but they're two separate files kept in sync by hand (the
// desktop app requires CommonJS; the extension assigns onto `window` for a
// content script). Nothing catches it if one gets updated and the other
// doesn't — this test does, by loading both and diffing every candidate
// array per site. Run with: node test/selectors-sync.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}

function loadExtensionSelectors() {
  const filePath = path.join(__dirname, "..", "..", "AutoInjector", "extension", "selectors.js");
  const src = fs.readFileSync(filePath, "utf8");
  const sandbox = { window: {}, location: { hostname: "" } };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: filePath });
  return sandbox.window.__AI_SITES__;
}

async function main() {
  console.log("\n== selectors.js sync: desktop-app vs. extension ==");
  const desktop = require("../selectors");
  const extension = loadExtensionSelectors();

  assert(!!extension, "extension/selectors.js loads and populates window.__AI_SITES__");
  if (!extension) {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  const desktopSites = Object.keys(desktop).sort();
  const extensionSites = Object.keys(extension).sort();
  assert(JSON.stringify(desktopSites) === JSON.stringify(extensionSites), `both files cover the exact same set of sites (desktop: ${desktopSites.join(",")}; extension: ${extensionSites.join(",")})`);

  for (const site of desktopSites) {
    if (!extension[site]) continue; // already flagged by the assertion above
    for (const key of ["INPUT_CANDIDATES", "SEND_CANDIDATES", "ASSISTANT_CANDIDATES"]) {
      const d = desktop[site][key] || [];
      const e = extension[site][key] || [];
      assert(
        JSON.stringify(d) === JSON.stringify(e),
        `${site}.${key} matches between desktop-app and extension (desktop: ${JSON.stringify(d)}; extension: ${JSON.stringify(e)})`
      );
    }
    assert(desktop[site].label === extension[site].label, `${site}.label matches`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
