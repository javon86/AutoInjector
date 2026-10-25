// fake-sd-proc.js — stands in for "python launch.py --api --port N" / "python main.py --port N"
// in the sd-runner tests: starts a fake A1111 (or ComfyUI with --comfy) on --port.
// --crash-after <ms> exits with code 3 after that long; --no-api serves a WebUI without /sdapi.
const { fakeA1111, fakeComfy } = require('./fake-sd');
const a = process.argv.slice(2);
const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const port = Number(val('--port'));
const comfy = a.includes('--comfy') || a.some((x) => /main\.py$/.test(x));
console.log(`fake sd starting args=${a.join(' ')} token=SECRET123`);
(async () => {
  const delay = Number(val('--delay') || 0);
  if (delay) await new Promise((r) => setTimeout(r, delay));
  if (comfy) await fakeComfy({ port }); else await fakeA1111({ port, noApi: !a.includes('--api') });
  console.log(`Running on local URL:  http://127.0.0.1:${port}`);
  const crash = Number(val('--crash-after') || 0);
  if (crash) setTimeout(() => process.exit(3), crash);
})();
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
