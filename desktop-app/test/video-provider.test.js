// test/video-provider.test.js — the text-to-video adapter. Uses a stub HTTP
// server; asserts settings, the tolerant response extraction, and generate()
// guards. Run: node test/video-provider.test.js
const http = require('http');
const vp = require('../video-provider');
let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
function listen(s) { return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port))); }

async function main() {
  console.log('\n== settings + status ==');
  vp.setSettings({ enabled: true, endpoint: 'http://x', frames: 24, fps: 12, cfgScale: 6.5, motion: 1.4, seed: 99 });
  const s = vp.status();
  assert(s.configured && s.enabled && s.frames === 24 && s.fps === 12, 'settings round-trip through status()');
  assert(s.cfgScale === 6.5 && s.motion === 1.4 && s.seed === 99, 'the CFG/motion/seed sliders round-trip too');

  console.log('\n== _extract handles the common backend shapes ==');
  assert(vp._extract({ videos: ['AAAA'] }).videoBase64 === 'AAAA', 'videos[] array → base64');
  assert(vp._extract({ video: 'data:video/mp4;base64,BBBB' }).videoBase64 === 'BBBB', 'single data-URI → stripped base64');
  assert(vp._extract({ url: 'http://h/out.mp4' }).videoUrl === 'http://h/out.mp4', 'a url → videoUrl');
  assert(!vp._extract({}).videoBase64 && !vp._extract({}).videoUrl, 'an empty body → nothing');

  console.log('\n== generate() guards ==');
  vp.setSettings({ enabled: false, endpoint: '' });
  assert((await vp.generate('')).error === 'NEED_PROMPT', 'no prompt → NEED_PROMPT');
  assert((await vp.generate('a cat')).error === 'VIDEO_DISABLED', 'disabled → VIDEO_DISABLED');
  vp.setSettings({ enabled: true });
  assert((await vp.generate('a cat')).error === 'NO_ENDPOINT', 'enabled but no endpoint → NO_ENDPOINT');

  console.log('\n== generate() posts and returns a clip from a reachable backend ==');
  const stub = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
      const body = JSON.parse(b || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ videos: [Buffer.from('FAKEVID').toString('base64')], info: `frames=${body.frames}` }));
    });
  });
  const port = await listen(stub);
  vp.setSettings({ enabled: true, endpoint: `http://127.0.0.1:${port}/txt2vid`, frames: 16, cfgScale: 8, motion: 1.2, seed: 7 });
  let seenBody = null;
  const r = await vp.generate('a spinning cube', { negativePrompt: 'blurry' });
  assert(r.ok && r.videoBase64 && Buffer.from(r.videoBase64, 'base64').toString() === 'FAKEVID', 'a base64 clip comes back');
  assert(/frames=16/.test(r.info), 'the render params reached the backend');
  // (the stub echoes frames into info; assert the extra params are on the settings)
  assert(vp.status().cfgScale === 8 && vp.status().motion === 1.2 && vp.status().seed === 7, 'CFG/motion/seed are applied to the render');
  stub.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
