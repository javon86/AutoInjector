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

  console.log('\n== E09: an HTTP error surfaces the backend reason, not just a code ==');
  const errStub = http.createServer((req, res) => { req.resume(); res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'CUDA out of memory' })); });
  const ePort = await listen(errStub);
  vp.setSettings({ enabled: true, endpoint: `http://127.0.0.1:${ePort}/txt2vid` });
  const eR = await vp.generate('a cat');
  assert(eR.error === 'HTTP_500' && /out of memory/i.test(eR.detail || ''), 'the backend reason is returned in detail');
  errStub.close();

  console.log('\n== OP-13: NO_VIDEO and friends come with a plain-language message ==');
  assert(!r.message, 'a successful render carries no error message');
  const replyWith = (obj) => http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }); });
  const imgStub = replyWith({ images: ['iVBORw0KGgo='], info: '' });
  const iPort = await listen(imgStub);
  vp.setSettings({ enabled: true, endpoint: `http://127.0.0.1:${iPort}/sdapi/v1/txt2img` });
  const nv = await vp.generate('a cat');
  assert(nv.ok === false && nv.error === 'NO_VIDEO' && nv.shape === 'images', 'an image-only reply is NO_VIDEO (shape: images)');
  assert(/didn't send back a video/.test(nv.message || '') && /no working video backend is configured/.test(nv.message), 'the message says no working video backend is configured');
  assert(/image \(Stable Diffusion\) server/.test(nv.message) && /AnimateDiff/.test(nv.message), 'it explains the address looks like an image server and mentions AnimateDiff');
  assert(/Setup Wizard → Video/.test(nv.message) && nv.message.includes(`127.0.0.1:${iPort}`), 'it says where to set one up and names the address it tried');
  imgStub.close();
  const comfyStub = replyWith({ prompt_id: 'abc', number: 1, node_errors: {} });
  const cPort = await listen(comfyStub);
  vp.setSettings({ endpoint: `http://127.0.0.1:${cPort}/prompt` });
  const nc = await vp.generate('a cat');
  assert(nc.error === 'NO_VIDEO' && nc.shape === 'comfy-queue' && /ComfyUI/.test(nc.message || ''), 'a ComfyUI queue reply is explained as such');
  comfyStub.close();
  const emptyStub = replyWith({});
  const ePort2 = await listen(emptyStub);
  vp.setSettings({ endpoint: `http://127.0.0.1:${ePort2}/gen` });
  const ne = await vp.generate('a cat');
  assert(ne.error === 'NO_VIDEO' && ne.shape === 'empty' && /text-to-video backend/.test(ne.message || ''), 'an empty reply still gets the how-to-set-up message');
  emptyStub.close();
  vp.setSettings({ enabled: true, endpoint: '' });
  const nE = await vp.generate('a cat');
  assert(/No video backend is set up yet/.test(nE.message || '') && /Setup Wizard → Video/.test(nE.message), 'NO_ENDPOINT says no video backend is set up and where to do it');
  vp.setSettings({ enabled: false });
  assert(/turned off/.test((await vp.generate('a cat')).message || ''), 'VIDEO_DISABLED says video is turned off');
  const dead = http.createServer(); const dPort = await listen(dead); await new Promise((res) => dead.close(res));
  vp.setSettings({ enabled: true, endpoint: `http://127.0.0.1:${dPort}/gen` });
  const ref = await vp.generate('a cat');
  assert(ref.error === 'ECONNREFUSED' && /Nothing is running/.test(ref.message || '') && ref.message.includes(`127.0.0.1:${dPort}`), 'ECONNREFUSED says nothing is running at the address');
  assert(/out of memory/.test(vp.explainError({ error: 'HTTP_500', detail: 'CUDA out of memory' }, 'http://x')), 'an HTTP error message includes the backend reason');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
// (video-provider only — voice per-speaker voices are covered in voice-provider.test.js)
