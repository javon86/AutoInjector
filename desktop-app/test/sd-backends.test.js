// test/sd-backends.test.js — connecting to real-shaped SD servers: detect which
// app answers (A1111 / Forge / SD.Next / ComfyUI / WebUI-without---api / not SD /
// nothing), txt2img on both backends, LoRA tags vs LoRA nodes, progress + cancel,
// and the plain-English errors. Uses fake servers from test/fixtures/fake-sd.js.
// Run: node test/sd-backends.test.js
const sd = require('../sd-backends');
const ip = require('../image-provider');
const { fakeA1111, fakeComfy, fakeOther, freePort, PNG_B64 } = require('./fixtures/fake-sd');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const a1111 = await fakeA1111();
  const forge = await fakeA1111({ flavor: 'forge' });
  const sdnext = await fakeA1111({ flavor: 'sdnext' });
  const noapi = await fakeA1111({ noApi: true });
  const comfy = await fakeComfy();
  const other = await fakeOther();
  const closed = await freePort();

  console.log('\n== identify(): which app answers ==');
  let r = await sd.identify(a1111.base);
  assert(r.kind === 'a1111' && r.usable && r.flavor === 'Automatic1111', 'plain A1111 is identified as Automatic1111');
  assert(/Connected to Automatic1111 on :\d+ — model dreamshaper_8/.test(r.message), `status line names the app, port and model ("${r.message}")`);
  r = await sd.identify(forge.base);
  assert(r.kind === 'a1111' && r.flavor === 'Forge', 'Forge is told apart by its forge_* options');
  r = await sd.identify(sdnext.base);
  assert(r.kind === 'a1111' && r.flavor === 'SD.Next', 'SD.Next is told apart by /sdapi/v1/version');
  r = await sd.identify(comfy.base);
  assert(r.kind === 'comfy' && r.usable && /ComfyUI on :\d+ \(v0\.3\.10\)/.test(r.message), 'ComfyUI is identified by /system_stats (with its version)');
  r = await sd.identify(`${a1111.base}/sdapi/v1/txt2img`);
  assert(r.kind === 'a1111' && r.base === a1111.base, 'a full txt2img URL is reduced to its base first');
  r = await sd.identify(`127.0.0.1:${comfy.port}`);
  assert(r.kind === 'comfy', 'an address typed without http:// still works');

  console.log('\n== the "started without --api" mistake ==');
  r = await sd.identify(noapi.base);
  assert(r.kind === 'webui-no-api' && r.usable === false && r.error === 'NO_API', 'a WebUI whose /sdapi is 404 is reported as API-off, not as "nothing there"');
  assert(/Stability Matrix/.test(r.message) && /Launch Options/.test(r.message) && /--api/.test(r.message), 'the hint says exactly what to tick/add in Stability Matrix');
  assert(/webui-user\.bat/.test(r.message) && /COMMANDLINE_ARGS=--api/.test(r.message), 'and what to put in webui-user.bat for a standalone install');

  console.log('\n== not SD / nothing running ==');
  r = await sd.identify(other.base);
  assert(r.kind === 'unknown' && !r.usable && /My Router/.test(r.message), 'some other web app is "not a Stable Diffusion API", named by its title');
  r = await sd.identify(`http://127.0.0.1:${closed}`);
  assert(r.kind === 'none' && r.error === 'REFUSED' && /Nothing is answering/.test(r.message) && /Stability Matrix/.test(r.message), 'a closed port says nothing is answering and how to start it');
  r = await sd.identify('not a url ::::');
  assert(r.error === 'BAD_URL', 'garbage address → BAD_URL');

  console.log('\n== detect(): scan ports, usable first, problems kept ==');
  const d = await sd.detect({ ports: [closed, noapi.port, comfy.port, other.port, forge.port], timeoutMs: 1500 });
  assert(d.ok && d.found.length === 2, 'two usable backends found among five ports');
  assert(d.best && d.best.kind === 'a1111' && d.best.flavor === 'Forge', 'the A1111-family backend ranks first');
  assert(d.found[1].kind === 'comfy', 'ComfyUI is second');
  assert(d.problems.length === 1 && d.problems[0].kind === 'webui-no-api', 'the WebUI-without---api is listed as a problem (with its fix)');
  const d2 = await sd.detect({ ports: [closed], timeoutMs: 800 });
  assert(d2.found.length === 0 && /No Stable Diffusion app found/.test(d2.message), 'nothing running → a plain "no SD app found" message');
  const d3 = await sd.detect({ ports: [noapi.port], timeoutMs: 1500 });
  assert(!d3.best && /API is switched off/.test(d3.message), 'only a no-api WebUI → the message is the --api fix');
  assert(sd.DETECT_PORTS.includes(7860) && sd.DETECT_PORTS.includes(7861) && sd.DETECT_PORTS.includes(8188), 'default ports cover A1111/Forge 7860/7861 and ComfyUI 8188');

  console.log('\n== LoRA syntax (A1111) ==');
  assert(sd.loraTag('odile_face', 0.8) === '<lora:odile_face:0.8>', 'loraTag makes <lora:name:0.8>');
  assert(sd.a1111Prompt('a woman', [{ name: 'odile_face', weight: 0.75 }, { name: 'Styles/ink.safetensors', weight: 1 }]) === 'a woman <lora:odile_face:0.75> <lora:ink:1>', 'selected LoRAs are appended as tags (folder + extension stripped)');
  assert(sd.a1111Prompt('a woman <lora:odile_face:0.5>', [{ name: 'odile_face', weight: 0.9 }]) === 'a woman <lora:odile_face:0.5>', 'a LoRA already typed in the prompt is not added twice');
  const pl = sd.parseLoraTags('portrait <lora:odile_face:0.7>, oil <lora:ink>');
  assert(pl.prompt === 'portrait, oil' && pl.loras.length === 2 && pl.loras[0].weight === 0.7 && pl.loras[1].weight === 1, 'parseLoraTags pulls tags out (default weight 1)');

  console.log('\n== txt2img on A1111/Forge ==');
  let cr = await ip.connect(forge.base);
  assert(cr.ok && ip.status().backend === 'a1111' && ip.status().label === 'Forge' && ip.status().enabled, 'connect() makes Forge the backend and enables image generation');
  assert(ip.status().endpoint === `${forge.base}/sdapi/v1/txt2img`, 'endpoint is the full txt2img URL');
  const lists = await ip.lists();
  assert(lists.ok && lists.checkpoints.length === 2 && lists.loras[0].name === 'odile_face' && lists.samplers.includes('Euler a') && lists.schedulers.includes('Karras'), 'lists(): checkpoints, LoRAs, samplers, schedulers');
  assert(lists.vaes.includes('vae-ft-mse-840000') && lists.embeddings[0].name === 'easynegative' && /dreamshaper_8/.test(lists.current.checkpoint), 'lists(): VAEs, embeddings and the loaded checkpoint');
  let g = await ip.generate('portrait of odile', { negativePrompt: 'blurry', loras: [{ name: 'odile_face', weight: 0.8 }], checkpoint: 'dreamshaper_8.safetensors [879db523c3]', vae: 'vae-ft-mse-840000', sampler: 'DPM++ 2M', scheduler: 'Karras', steps: 25, cfgScale: 6.5, width: 512, height: 768, seed: 42, batchSize: 2 });
  const body = forge.state.lastTxt2img;
  assert(g.ok && g.images.length === 2 && g.imageBase64 === PNG_B64, 'generate() returns both images of the batch');
  assert(body.prompt === 'portrait of odile <lora:odile_face:0.8>' && body.negative_prompt === 'blurry', 'the prompt carries the <lora:…> tag; negative prompt sent');
  assert(body.override_settings && body.override_settings.sd_model_checkpoint === 'dreamshaper_8.safetensors [879db523c3]' && body.override_settings.sd_vae === 'vae-ft-mse-840000' && body.override_settings_restore_afterwards === true, 'checkpoint + VAE go in override_settings (restored afterwards)');
  assert(body.sampler_name === 'DPM++ 2M' && body.scheduler === 'Karras' && body.steps === 25 && body.cfg_scale === 6.5 && body.width === 512 && body.height === 768 && body.seed === 42 && body.batch_size === 2, 'sampler, scheduler, steps, CFG, size, seed, batch reach the server');
  assert(g.seed === 42 && g.params.loras[0].name === 'odile_face' && g.backend === 'a1111', 'the result reports the seed and the settings used');
  g = await ip.generate('img2img', { initImage: 'data:image/png;base64,' + PNG_B64, denoise: 0.4 });
  assert(g.ok && forge.seen.some((s) => s.path === '/sdapi/v1/img2img') && forge.state.lastTxt2img.denoising_strength === 0.4 && forge.state.lastTxt2img.init_images[0] === PNG_B64, 'initImage → /sdapi/v1/img2img with denoising strength');

  console.log('\n== progress + cancel (A1111) ==');
  const slow = await fakeA1111({ slow: true });
  await ip.connect(slow.base);
  const pg = ip.generate('slow one');
  await sleep(250);
  const prog = await ip.progress();
  assert(prog.busy && prog.progress === 0.5 && prog.step === 10 && prog.steps === 20 && prog.etaSeconds > 0, 'progress() reads step 10/20 and the ETA while rendering');
  assert((await ip.generate('second')).error === 'BUSY', 'a second Generate while one runs is refused politely (BUSY)');
  const c = await ip.cancel();
  assert(c.ok && slow.state.interrupted, 'cancel() posts /sdapi/v1/interrupt');
  const pr = await pg;
  assert(!pr.ok && pr.error === 'CANCELLED' && pr.message === 'Stopped.', 'a cancelled render ends as CANCELLED ("Stopped.")');
  assert(!(await ip.progress()).busy, 'progress() is idle afterwards');

  console.log('\n== errors in plain words ==');
  const oom = await fakeA1111({ oom: true });
  await ip.connect(oom.base);
  g = await ip.generate('big');
  assert(!g.ok && g.error === 'HTTP_500' && /out of memory/i.test(g.detail) && /graphics card ran out of memory/.test(g.message), 'CUDA OOM → "your graphics card ran out of memory" with what to try');
  ip.setSettings({ enabled: true, backend: 'a1111', endpoint: `http://127.0.0.1:${closed}` });
  g = await ip.generate('x');
  assert(!g.ok && g.error === 'REFUSED' && /Nothing is answering/.test(g.message), 'SD app closed → "nothing is answering … start it"');
  ip.setSettings({ enabled: true, backend: 'a1111', endpoint: `${noapi.base}/sdapi/v1/txt2img` });
  g = await ip.generate('x');
  assert(!g.ok && g.error === 'NO_API' && /--api/.test(g.message), 'txt2img 404 → the --api fix');
  cr = await ip.connect(noapi.base);
  assert(!cr.ok && cr.kind === 'webui-no-api' && ip.status().endpoint.indexOf(String(noapi.port)) >= 0, 'connect() to a no-api WebUI fails with the hint and does not switch to something else');
  assert(/ran out of memory/.test(sd.explain({ error: 'HTTP_500', detail: 'torch.OutOfMemoryError' })), 'explain() knows OutOfMemoryError too');
  assert(/took too long/.test(sd.explain('TIMEOUT')), 'explain(TIMEOUT)');

  console.log('\n== ComfyUI: workflow graph, LoRA nodes, history, view ==');
  cr = await ip.connect(comfy.base);
  assert(cr.ok && ip.status().backend === 'comfy' && ip.status().endpoint === comfy.base, 'connect() makes ComfyUI the backend (base address, no /sdapi)');
  const cl = await ip.lists();
  assert(cl.ok && cl.checkpoints.length === 3 && cl.loras.map((x) => x.name).includes('Characters\\odile_face.safetensors'), 'lists() parses the old combo shape and the new ["COMBO",{options}] shape');
  assert(cl.samplers.includes('dpmpp_2m') && cl.schedulers.includes('karras') && cl.vaes.includes('vae-ft-mse-840000.safetensors') && cl.embeddings[0].name === 'easynegative', 'samplers, schedulers, VAEs, embeddings from /object_info + /embeddings');
  g = await ip.generate('portrait of odile <lora:ink_style:0.5>', { negativePrompt: 'blurry', loras: [{ name: 'odile_face', weight: 0.8 }], checkpoint: 'dreamshaper_8', vae: 'vae-ft-mse-840000', sampler: 'DPM++ 2M Karras', steps: 22, cfgScale: 6, width: 512, height: 640, seed: -1, batchSize: 2, pollMs: 30 });
  const graph = comfy.state.lastGraph;
  assert(g.ok && g.images.length === 2 && g.images[0] === PNG_B64, 'ComfyUI render: queued, history polled, both images fetched from /view');
  const nodes = Object.entries(graph);
  const byType = (t) => nodes.filter(([, n]) => n.class_type === t);
  assert(byType('CheckpointLoaderSimple')[0][1].inputs.ckpt_name === 'sd15/dreamshaper_8.safetensors', 'the checkpoint name is resolved to ComfyUI\'s own path ("sd15/…")');
  const lls = byType('LoraLoader');
  assert(lls.length === 2, 'two LoraLoader nodes: one from the <lora:> tag, one from the picker');
  const loraNames = lls.map(([, n]) => n.inputs.lora_name);
  assert(loraNames.includes('ink_style.safetensors') && loraNames.includes('Characters\\odile_face.safetensors'), 'LoRA names resolved to ComfyUI\'s file names (sub-folder kept)');
  const chained = lls.some(([, n]) => n.inputs.model[0] === '4') && lls.some(([, n]) => lls.some(([oid]) => n.inputs.model[0] === oid && n.inputs.clip[0] === oid));
  assert(chained, 'LoRA nodes are chained: checkpoint → LoRA 1 → LoRA 2 (model and clip)');
  const lastLora = lls.find(([id]) => !lls.some(([, n]) => n.inputs.model[0] === id))[0];
  const ks = byType('KSampler')[0][1].inputs;
  assert(ks.model[0] === lastLora && byType('CLIPTextEncode').every(([, n]) => n.inputs.clip[0] === lastLora), 'KSampler + both text encoders use the last LoRA\'s outputs');
  assert(byType('CLIPTextEncode').map(([, n]) => n.inputs.text).includes('portrait of odile') && byType('CLIPTextEncode').map(([, n]) => n.inputs.text).includes('blurry'), 'positive (tag removed) and negative prompts are encoded');
  assert(ks.sampler_name === 'dpmpp_2m' && ks.scheduler === 'karras' && ks.steps === 22 && ks.cfg === 6 && Number.isInteger(ks.seed) && ks.seed >= 0, 'A1111 sampler name mapped (DPM++ 2M Karras → dpmpp_2m + karras); seed -1 → a real random seed');
  assert(g.seed === ks.seed, 'the random seed actually used is reported back (so the image can be remade)');
  const lat = byType('EmptyLatentImage')[0][1].inputs;
  assert(lat.width === 512 && lat.height === 640 && lat.batch_size === 2, 'size + batch in EmptyLatentImage');
  assert(byType('VAELoader')[0][1].inputs.vae_name === 'vae-ft-mse-840000.safetensors' && byType('VAEDecode')[0][1].inputs.vae[0] === byType('VAELoader')[0][0], 'a chosen VAE gets its own VAELoader feeding VAEDecode');
  assert(byType('SaveImage').length === 1 && comfy.seen.some((s) => s.path === '/view' && /type=output/.test(s.query)), 'SaveImage output fetched with /view?…&type=output');
  const wf = sd.buildComfyWorkflow({ checkpoint: 'a.safetensors', prompt: 'x', negativePrompt: '', width: 512, height: 512, steps: 20, cfgScale: 7, seed: 1, loras: [] });
  assert(wf['8'].inputs.vae[0] === '4' && wf['3'].inputs.model[0] === '4' && !Object.values(wf).some((n) => n.class_type === 'LoraLoader'), 'no LoRAs / no VAE → the checkpoint feeds everything directly');

  console.log('\n== ComfyUI errors + cancel ==');
  g = await ip.generate('x', { checkpoint: 'not_there.safetensors', pollMs: 30 });
  assert(g.ok && comfy.state.lastGraph['4'].inputs.ckpt_name === 'sd15/dreamshaper_8.safetensors', 'an unknown checkpoint name falls back to ComfyUI\'s first checkpoint (no crash)');
  const rejected = await sd.comfyGenerate(comfy.base, { prompt: 'x', checkpoint: '', width: 512, height: 512, steps: 4, cfgScale: 7, seed: 1 }, { lists: { ok: true, checkpoints: [{ name: 'nope.safetensors' }], loras: [], vaes: [] } });
  assert(!rejected.ok && rejected.error === 'COMFY_REJECTED' && /doesn't have “nope\.safetensors”/.test(rejected.message), 'a 400 from /prompt (value_not_in_list) becomes "ComfyUI doesn\'t have …, press Refresh"');
  const missing = await ip.generate('x <lora:ghost:1>', { pollMs: 30 });
  assert(missing.ok && missing.missingLoras.includes('ghost'), 'a LoRA ComfyUI doesn\'t have is left out and reported (missingLoras)');
  const failing = await fakeComfy({ failWith: 'mat1 and mat2 shapes cannot be multiplied' });
  await ip.connect(failing.base);
  g = await ip.generate('x', { pollMs: 30 });
  assert(!g.ok && g.error === 'COMFY_ERROR' && /KSampler: mat1 and mat2/.test(g.message), 'an execution_error in /history is shown with the node and the reason');
  const slowC = await fakeComfy({ slow: true });
  await ip.connect(slowC.base);
  const pc = ip.generate('slow', { pollMs: 30 });
  await sleep(200);
  const cprog = await ip.progress();
  assert(cprog.busy && cprog.job === 'running', 'ComfyUI progress() reads /queue (running)');
  await ip.cancel();
  assert(slowC.state.interrupted && slowC.state.deleted.includes('p1'), 'cancel() posts /interrupt and removes the job from /queue');
  const pcr = await pc;
  assert(!pcr.ok && pcr.error === 'CANCELLED', 'the ComfyUI render ends as CANCELLED');
  assert(sd.toComfySampler('Euler a').sampler_name === 'euler_ancestral' && sd.toComfySampler('euler', 'Karras').scheduler === 'karras' && sd.toComfySampler('Weird Thing').sampler_name === 'euler', 'sampler mapping: Euler a → euler_ancestral; unknown → euler');
  assert(sd.comboOptions([['a', 'b'], {}]).length === 2 && sd.comboOptions(['COMBO', { options: ['x'] }])[0] === 'x' && sd.comboOptions(['INT', {}]).length === 0, 'comboOptions handles both /object_info shapes');

  for (const s of [a1111, forge, sdnext, noapi, comfy, other, slow, oom, failing, slowC]) await s.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
