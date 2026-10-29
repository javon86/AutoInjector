'use strict';
// test/fixtures/fake-framepack.js — a fake FramePack on disk for the tests (no GPU, no torch):
//   makeFramePackDir(dir, { venv })          the FramePack folder: demo_gradio.py, diffusers_helper/, venv python
//   makeHfCache(hfHome, { skip: ['…/vae'] }) the Hugging Face cache FramePack's I2V loads (hub/models--…)
//   runnerEnv({ mode, log })                  env that makes the engine start test/fixtures/fake-framepack-runner.js with node
const fs = require('fs');
const path = require('path');

const RUNNER = path.join(__dirname, 'fake-framepack-runner.js');
const REVS = { 'hunyuanvideo-community/HunyuanVideo': 'e8c2aaa66fe3742a32c11a6766aecbf07c56e773', 'lllyasviel/flux_redux_bfl': '45b801affc54ff2af4e5daf1b282e0921901db87', 'lllyasviel/FramePackI2V_HY': '86cef4396041b6002c957852daac4c91aaa47c79' };
const FILES = {
  'hunyuanvideo-community/HunyuanVideo': { text_encoder: ['config.json', 'model-00001-of-00004.safetensors', 'model-00002-of-00004.safetensors', 'model-00003-of-00004.safetensors', 'model-00004-of-00004.safetensors', 'model.safetensors.index.json'], text_encoder_2: ['config.json', 'model.safetensors'], tokenizer: ['tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json'], tokenizer_2: ['vocab.json', 'merges.txt', 'tokenizer_config.json'], vae: ['config.json', 'diffusion_pytorch_model.safetensors'] },
  'lllyasviel/flux_redux_bfl': { image_encoder: ['config.json', 'model.safetensors'], feature_extractor: ['preprocessor_config.json'] },
  'lllyasviel/FramePackI2V_HY': { '': ['config.json', 'diffusion_pytorch_model-00001-of-00003.safetensors', 'diffusion_pytorch_model-00002-of-00003.safetensors', 'diffusion_pytorch_model-00003-of-00003.safetensors', 'diffusion_pytorch_model.safetensors.index.json'] },
};

function makeFramePackDir(dir, o = {}) {
  fs.mkdirSync(path.join(dir, 'diffusers_helper', 'models'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'demo_gradio.py'), '# FramePack demo (fake)\n');
  fs.writeFileSync(path.join(dir, 'demo_gradio_f1.py'), '# FramePack F1 demo (fake)\n');
  fs.writeFileSync(path.join(dir, 'diffusers_helper', 'hunyuan.py'), '');
  if (o.venv !== false) {
    const py = process.platform === 'win32' ? path.join(dir, 'venv', 'Scripts', 'python.exe') : path.join(dir, 'venv', 'bin', 'python');
    fs.mkdirSync(path.dirname(py), { recursive: true }); fs.writeFileSync(py, '');
  }
  return dir;
}

function makeHfCache(hfHome, o = {}) {
  const skip = new Set(o.skip || []);
  for (const [repo, subs] of Object.entries(FILES)) {
    const rd = path.join(hfHome, 'hub', `models--${repo.replace(/\//g, '--')}`);
    if (skip.has(repo)) continue;
    const snap = path.join(rd, 'snapshots', REVS[repo]);
    fs.mkdirSync(path.join(rd, 'refs'), { recursive: true });
    fs.writeFileSync(path.join(rd, 'refs', 'main'), REVS[repo]);
    for (const [sub, files] of Object.entries(subs)) {
      const label = sub ? `${repo}/${sub}` : repo;
      const d = sub ? path.join(snap, sub) : snap;
      fs.mkdirSync(d, { recursive: true });
      if (skip.has(label)) continue;
      for (const f of files) {
        if (/\.index\.json$/.test(f)) {
          const parts = files.filter((x) => /-of-\d+\.safetensors$/.test(x));
          const wm = {}; parts.forEach((p, i) => { wm[`w${i}`] = p; });
          fs.writeFileSync(path.join(d, f), JSON.stringify({ metadata: {}, weight_map: wm }));
        } else if (!(o.dropPart && f === o.dropPart)) fs.writeFileSync(path.join(d, f), 'x');
      }
    }
  }
  fs.mkdirSync(path.join(hfHome, 'hub'), { recursive: true });
  return hfHome;
}

function runnerEnv(o = {}) {
  const env = { AUTOINJECTOR_FRAMEPACK_PYTHON: o.node || process.execPath, AUTOINJECTOR_FRAMEPACK_RUNNER: RUNNER };
  if (o.mode) env.FAKE_FP_MODE = o.mode;
  if (o.log) env.FAKE_FP_LOG = o.log;
  if (o.stepMs != null) env.FAKE_FP_STEP_MS = String(o.stepMs);
  return env;
}

module.exports = { makeFramePackDir, makeHfCache, runnerEnv, RUNNER, FILES };
