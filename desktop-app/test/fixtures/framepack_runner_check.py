# -*- coding: utf-8 -*-
"""test/fixtures/framepack_runner_check.py — unit checks of integrations/framepack/framepack_runner.py that need
no torch / FramePack: request checking + clamping, the section maths, error words, the model check and the
JSON-lines server driven with a fake engine. Prints one JSON line per check: {"ok": bool, "name": "..."}.
Run (by test/framepack-runner.test.js): python -B framepack_runner_check.py <runner.py> <hf_home_complete> <hf_home_partial> <tmpdir>
"""
import importlib.util
import io
import json
import os
import sys
import threading
import time

runner_path, hf_ok, hf_partial, tmp = sys.argv[1:5]
spec = importlib.util.spec_from_file_location('framepack_runner', runner_path)
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)


def check(cond, name):
    print(json.dumps({'ok': bool(cond), 'name': name}))
    sys.stdout.flush()


check('torch' not in sys.modules, 'importing the runner does not import torch')

# ---- the section maths (demo_gradio.py)
check(R.sections_for(5) == 4 and R.sections_for(1) == 1 and R.sections_for(2) == 2 and R.sections_for(10) == 8, 'sections_for: 5 s -> 4, 1 s -> 1, 2 s -> 2, 10 s -> 8')
check(R.frames_for(1) == 37 and R.frames_for(2) == 73 and R.frames_for(4) == 145, 'frames_for: 1 -> 37, 2 -> 73, 4 -> 145 frames')
check(R.latent_paddings_for(3) == [2, 1, 0] and R.latent_paddings_for(6) == [3, 2, 2, 2, 1, 0], 'latent paddings like the demo (reversed; [3]+[2]*(n-3)+[1,0] above 4)')

# ---- normalize_request
img = os.path.join(tmp, 'in.png')
with open(img, 'wb') as f:
    f.write(b'\x89PNG\r\n\x1a\n')
p = R.normalize_request({'image': img, 'out': os.path.join(tmp, 'o.mp4'), 'seconds': 40, 'steps': '7', 'gs': 99, 'gpu_memory_preservation': 2, 'use_teacache': False, 'seed': 12})
check(p['seconds'] == 10 and p['steps'] == 7 and p['gs'] == 32 and p['gpu_memory_preservation'] == 6 and p['use_teacache'] is False and p['seed'] == 12, 'normalize_request clamps (seconds 40 -> 10, gs 99 -> 32, GPU memory 2 -> 6) and reads numbers given as text')
d = R.normalize_request({'image': img, 'out': 'x.mp4'})
check(d['steps'] == 25 and d['gs'] == 10 and d['cfg'] == 1 and d['use_teacache'] is True and d['mp4_crf'] == 16 and d['seconds'] == 5 and d['seed'] == 31337, "the demo's defaults: 25 steps, distilled CFG 10, CFG 1, TeaCache on, MP4 quality 16, 5 s, seed 31337")
for bad, why in (({'out': 'x.mp4'}, 'no image'), ({'image': os.path.join(tmp, 'nope.png'), 'out': 'x.mp4'}, 'a missing picture'), ({'image': img}, 'no out'), ({'image': img, 'out': 'x', 'steps': 'many'}, 'steps not a number'), ({'image': img, 'out': 'x', 'seconds': True}, 'a boolean for seconds'), ('nope', 'not an object')):
    try:
        R.normalize_request(bad)
        check(False, 'BAD_REQUEST for ' + why)
    except R.RunnerError as e:
        check(e.code == 'BAD_REQUEST' and e.message, 'BAD_REQUEST for ' + why + ': ' + e.message)

# ---- error words
c, m, fx = R.classify_error(RuntimeError('CUDA out of memory. Tried to allocate 2.00 GiB'))
check(c == 'FRAMEPACK_OOM' and 'ran out of memory' in m and 'GPU memory to keep free' in fx and 'shorter clip' in fx, 'CUDA out of memory -> FRAMEPACK_OOM with the fix')
c, m, fx = R.classify_error(OSError('We couldn\'t connect ... offline mode is enabled. Cannot find the requested files in the cached path'))
check(c == 'FRAMEPACK_MODEL_MISSING' and 'Nothing is downloaded' in fx, 'offline / not in the cache -> FRAMEPACK_MODEL_MISSING (nothing is downloaded)')
c, m, fx = R.classify_error(ValueError('something odd'))
check(c == 'FRAMEPACK_FAILED' and 'something odd' in m, 'anything else -> FRAMEPACK_FAILED with the first line')

# ---- the model check (pure files)
c, m, fx = R.classify_error(Exception("OfflineModeIsEnabled: Cannot reach https://huggingface.co/api/models/lllyasviel/FramePackI2V_HY: offline mode is enabled."))
check(c == 'FRAMEPACK_OFFLINE_LOOKUP' and 'website' in m and 'probably fine' in fx, 'the PC error (OfflineModeIsEnabled on huggingface.co/api) -> its own plain words, not "check all three models"')
# local_repo: models load from the snapshot FOLDER (a repo id makes diffusers call model_info even offline)
snap = R.local_repo(hf_ok, 'lllyasviel/FramePackI2V_HY')
check(bool(snap) and os.path.isdir(snap) and os.sep + 'snapshots' + os.sep in snap, 'local_repo: the FramePack model resolves to its local snapshot folder (%s)' % snap)
check(R.local_repo(hf_partial, 'lllyasviel/FramePackI2V_HY') is None and R.local_repo('', 'x/y') is None, 'local_repo: None when the model is not in the cache / no cache')
# missing_shards: an index naming a shard that is not there
import json as _json
shard_dir = os.path.join(tmp, 'sharded')
os.makedirs(shard_dir, exist_ok=True)
with open(os.path.join(shard_dir, 'diffusion_pytorch_model.safetensors.index.json'), 'w') as f:
    _json.dump({'weight_map': {'a': 'm-00001-of-00002.safetensors', 'b': 'm-00002-of-00002.safetensors'}}, f)
open(os.path.join(shard_dir, 'm-00001-of-00002.safetensors'), 'wb').close()
check(R.missing_shards(shard_dir) == ['m-00002-of-00002.safetensors'], 'missing_shards: names the shard the index lists but the folder lacks')
open(os.path.join(shard_dir, 'm-00002-of-00002.safetensors'), 'wb').close()
check(R.missing_shards(shard_dir) == [], 'missing_shards: complete -> nothing missing')
check(R.check_models(hf_ok) == [], 'check_models: a complete cache -> nothing missing')
miss = R.check_models(hf_partial)
check('hunyuanvideo-community/HunyuanVideo/vae' in miss and 'lllyasviel/FramePackI2V_HY' in miss and len(miss) == 2, 'check_models: names what is missing (%s)' % ', '.join(miss))


# ---- the JSON-lines server with a fake engine (no torch)
class FakeEngine(object):
    def __init__(self):
        self.loaded = False
        self.calls = []

    def status(self):
        return {'loaded': self.loaded, 'high_vram': False, 'vram_gb': 7.5}

    def load(self, emit, should_stop=None):
        emit({'event': 'loading', 'stage': 'fake', 'step': 1, 'steps': 1})
        self.loaded = True
        emit({'event': 'loaded', 'vram_gb': 7.5, 'high_vram': False})

    def generate(self, p, emit, should_stop):
        self.calls.append(p)
        for s in range(1, p['sections'] + 1):
            for k in range(1, p['steps'] + 1):
                if should_stop():
                    raise R.Cancelled()
                if p['prompt'] == 'oom':
                    raise RuntimeError('torch.OutOfMemoryError: CUDA out of memory')
                emit({'event': 'progress', 'id': p['id'], 'phase': 'sampling', 'section': s, 'sections': p['sections'], 'step': k, 'steps': p['steps']})
                time.sleep(0.01 if p['prompt'] != 'slow' else 0.05)
        with open(p['out'], 'wb') as f:
            f.write(b'mp4')
        return {'path': p['out'], 'frames': p['frames'], 'fps': 30, 'seconds': round(p['frames'] / 30.0, 2), 'width': 640, 'height': 480, 'sections': p['sections'], 'seed': p['seed']}


def events(out):
    return [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]


def wait(server, secs=5):
    end = time.time() + secs
    while server.busy() and time.time() < end:
        time.sleep(0.01)


eng = FakeEngine()
out = io.StringIO()
srv = R.Server(eng, out)
lines = [json.dumps({'cmd': 'ping', 'id': 'p1'}), 'not json', json.dumps({'cmd': 'dance'}), json.dumps({'cmd': 'status', 'id': 's1'})]
srv.serve(io.StringIO('\n'.join(lines) + '\n'))
ev = events(out)
check(ev[0]['event'] == 'ready' and ev[0]['protocol'] == 1, 'the server says ready first (protocol 1)')
check(any(e['event'] == 'pong' and e['id'] == 'p1' for e in ev), 'ping -> pong')
check(any(e['event'] == 'error' and e['code'] == 'BAD_REQUEST' and 'not JSON' in e['message'] for e in ev), 'a line that is not JSON -> BAD_REQUEST (the server keeps going)')
check(any(e['event'] == 'error' and 'Unknown command' in e['message'] for e in ev), 'an unknown command -> said so')
check(any(e['event'] == 'status' and e['id'] == 's1' and e['busy'] is False and e['vram_gb'] == 7.5 for e in ev), 'status answers (busy, the engine state)')

out = io.StringIO()
srv = R.Server(eng, out)
srv.handle({'cmd': 'generate', 'id': 'g1', 'image': img, 'out': os.path.join(tmp, 'g1.mp4'), 'seconds': 2, 'steps': 3, 'prompt': 'waves'})
srv.handle({'cmd': 'generate', 'id': 'g2', 'image': img, 'out': os.path.join(tmp, 'g2.mp4')})
wait(srv)
ev = events(out)
check(any(e['event'] == 'accepted' and e['id'] == 'g1' and e['sections'] == 2 and e['frames'] == 73 for e in ev), 'generate -> accepted (2 parts, 73 frames)')
check(any(e['event'] == 'error' and e['id'] == 'g2' and e['code'] == 'FRAMEPACK_BUSY' for e in ev), 'a second generate while busy -> FRAMEPACK_BUSY')
check(len([e for e in ev if e['event'] == 'progress' and e['id'] == 'g1']) == 6, 'progress for each step of each part')
res = [e for e in ev if e['event'] == 'result' and e['id'] == 'g1']
check(res and res[0]['ok'] is True and res[0]['fps'] == 30 and res[0]['frames'] == 73 and os.path.exists(res[0]['path']), 'result: the mp4, 30 fps, its frames')

out = io.StringIO()
srv = R.Server(eng, out)
srv.handle({'cmd': 'generate', 'id': 'g3', 'image': img, 'out': os.path.join(tmp, 'g3.mp4'), 'seconds': 10, 'steps': 50, 'prompt': 'slow'})
time.sleep(0.15)
srv.handle({'cmd': 'cancel'})
wait(srv)
ev = events(out)
check(any(e['event'] == 'cancelling' for e in ev) and any(e['event'] == 'cancelled' and e['id'] == 'g3' for e in ev), 'cancel -> cancelling, then cancelled')

out = io.StringIO()
srv = R.Server(eng, out)
srv.handle({'cmd': 'generate', 'id': 'g4', 'image': img, 'out': os.path.join(tmp, 'g4.mp4'), 'seconds': 1, 'steps': 2, 'prompt': 'oom'})
wait(srv)
ev = events(out)
check(any(e['event'] == 'error' and e['id'] == 'g4' and e['code'] == 'FRAMEPACK_OOM' and 'GPU memory to keep free' in e['fix'] for e in ev), 'an out-of-memory inside FramePack -> FRAMEPACK_OOM event with the fix')

out = io.StringIO()
srv = R.Server(eng, out)
srv.handle({'cmd': 'generate', 'id': 'g5', 'out': 'x.mp4'})
ev = events(out)
check(any(e['event'] == 'error' and e['id'] == 'g5' and e['code'] == 'BAD_REQUEST' and 'picture' in e['message'] for e in ev), 'generate without a picture -> BAD_REQUEST in words')

eng2 = FakeEngine()
out = io.StringIO()
srv = R.Server(eng2, out)
srv.handle({'cmd': 'load', 'id': 'l1'})
wait(srv)
ev = events(out)
check(eng2.loaded and any(e['event'] == 'loaded' for e in ev) and any(e['event'] == 'loading' for e in ev), 'load -> loading ... loaded')

# setup_env: offline before any Hugging Face import
saved = dict(os.environ)
R.setup_env(tmp, hf_ok)
check(os.environ['HF_HUB_OFFLINE'] == '1' and os.environ['TRANSFORMERS_OFFLINE'] == '1' and os.environ['HF_HOME'] == os.path.abspath(hf_ok) and sys.path[0] == os.path.abspath(tmp), 'setup_env: offline, HF_HOME = the models folder, FramePack importable')
os.environ.clear()
os.environ.update(saved)
saved_path = list(sys.path)
os.environ.pop('HF_HOME', None)
R.setup_env(tmp, '')
check(os.environ.get('HF_HOME') == os.path.abspath(os.path.join(tmp, 'hf_download')), "setup_env: no models folder given -> FramePack's own hf_download (like demo_gradio.py)")
check('PYTORCH_CUDA_ALLOC_CONF' not in os.environ or saved.get('PYTORCH_CUDA_ALLOC_CONF'), 'setup_env leaves the CUDA allocator as FramePack has it')
os.environ.clear()
os.environ.update(saved)
sys.path[:] = saved_path

# ---- Windows-safe section file names; stdin with a BOM and \r\n
check(R.safe_name('a:b/c\\d?*<>|"e') == 'a_b_c_d_e' and R.safe_name(None) == 'job' and len(R.safe_name('x' * 99)) == 40, 'safe_name: no characters Windows refuses in a file name')
out = io.StringIO()
srv = R.Server(FakeEngine(), out)
srv.serve(io.BytesIO(b'\xef\xbb\xbf{"cmd": "ping", "id": "bom"}\r\n{"cmd": "ping", "id": "crlf"}\r\n'))
ev = events(out)
check(any(e['event'] == 'pong' and e['id'] == 'bom' for e in ev) and any(e['event'] == 'pong' and e['id'] == 'crlf' for e in ev), 'stdin as bytes: a UTF-8 BOM and Windows \\r\\n line ends are fine')


# ---- heartbeat: where a busy thread is (e.g. inside "import torch"), every few seconds
def stuck_in_import_here(ev):
    ev.wait(5)


gate = threading.Event()
th = threading.Thread(target=stuck_in_import_here, args=(gate,))
th.start()
time.sleep(0.05)
check('stuck_in_import_here' in R.where_is(th) and 'framepack_runner_check.py' in R.where_is(th), 'where_is names the file:line and function a thread is in (%s)' % R.where_is(th))
beats = []
os.environ['AUTOINJECTOR_FRAMEPACK_HEARTBEAT_S'] = '0.05'
R.start_heartbeat(beats.append, th, 'load', 'l9')
time.sleep(0.3)
gate.set()
th.join()
time.sleep(0.15)
n = len(beats)
time.sleep(0.15)
check(n >= 2 and all(b['event'] == 'heartbeat' and b['job'] == 'load' and 'stuck_in_import_here' in b['where'] for b in beats) and len(beats) == n, 'heartbeat: every few seconds while the job runs (where it is), and none after it ends (%d beats)' % n)


# ---- a load that is told to stop between its stages (the real Engine checks should_stop between models)
class SlowLoadEngine(FakeEngine):
    def load(self, emit, should_stop=None):
        for i in range(100):
            if should_stop is not None and should_stop():
                raise R.Cancelled()
            emit({'event': 'loading', 'stage': 'part %d' % i, 'step': i, 'steps': 100})
            time.sleep(0.02)
        self.loaded = True
        emit({'event': 'loaded'})


out = io.StringIO()
srv = R.Server(SlowLoadEngine(), out)
srv.handle({'cmd': 'load', 'id': 'l2'})
time.sleep(0.1)
srv.handle({'cmd': 'cancel'})
wait(srv)
ev = events(out)
check(any(e['event'] == 'cancelled' and e['id'] == 'l2' for e in ev) and not any(e['event'] == 'loaded' for e in ev), 'cancel during a load -> it stops at the next stage (cancelled, not loaded)')
del os.environ['AUTOINJECTOR_FRAMEPACK_HEARTBEAT_S']

# ---- Engine.load loads every model from its local snapshot FOLDER with local_files_only=True
# (the PC: a repo id made diffusers call huggingface.co/api model_info -> OfflineModeIsEnabled)
import types as _types
_calls = []
class _Stop(Exception):
    pass
def _fake_cls(name, stop=False):
    class C(object):
        @classmethod
        def from_pretrained(cls, path, **kw):
            _calls.append((name, path, kw))
            if stop:
                raise _Stop()
            o = C(); o.cpu = lambda: o
            return o
    C.__name__ = name
    return C
_saved = {k: sys.modules.get(k) for k in ('torch', 'diffusers', 'transformers', 'diffusers_helper', 'diffusers_helper.models', 'diffusers_helper.models.hunyuan_video_packed', 'diffusers_helper.memory')}
try:
    _t = _types.ModuleType('torch'); _t.__version__ = 'fake'; _t.float16 = 'f16'; _t.bfloat16 = 'bf16'
    _t.cuda = _types.SimpleNamespace(is_available=lambda: True)
    sys.modules['torch'] = _t
    _d = _types.ModuleType('diffusers'); _d.AutoencoderKLHunyuanVideo = _fake_cls('VAE'); sys.modules['diffusers'] = _d
    _tr = _types.ModuleType('transformers')
    for _n in ('LlamaModel', 'CLIPTextModel', 'LlamaTokenizerFast', 'CLIPTokenizer', 'SiglipImageProcessor', 'SiglipVisionModel'):
        setattr(_tr, _n, _fake_cls(_n))
    sys.modules['transformers'] = _tr
    sys.modules['diffusers_helper'] = _types.ModuleType('diffusers_helper')
    sys.modules['diffusers_helper.models'] = _types.ModuleType('diffusers_helper.models')
    _hv = _types.ModuleType('diffusers_helper.models.hunyuan_video_packed'); _hv.HunyuanVideoTransformer3DModelPacked = _fake_cls('Transformer', stop=True)
    sys.modules['diffusers_helper.models.hunyuan_video_packed'] = _hv
    _mem = _types.ModuleType('diffusers_helper.memory'); _mem.gpu = 'cuda:0'; _mem.get_cuda_free_memory_gb = lambda g: 16.0; _mem.DynamicSwapInstaller = object
    sys.modules['diffusers_helper.memory'] = _mem
    eng = R.Engine(hf_home=hf_ok)
    try:
        eng.load(lambda ev: None)
    except _Stop:
        pass
    names = [c[0] for c in _calls]
    check('Transformer' in names and len(_calls) == 8, 'Engine.load reached the FramePack video model through all 8 loads (%s)' % ', '.join(names))
    check(all(c[2].get('local_files_only') is True for c in _calls), 'every model is loaded with local_files_only=True')
    check(all(os.path.isdir(c[1]) and (os.sep + 'snapshots' + os.sep) in c[1] for c in _calls), 'every model is loaded from its local snapshot folder, never by repo id')
    tp = [c for c in _calls if c[0] == 'Transformer'][0][1]
    check('models--lllyasviel--FramePackI2V_HY' in tp, 'the FramePack video model comes from its own folder (%s)' % tp)
finally:
    for _k, _v in _saved.items():
        if _v is None:
            sys.modules.pop(_k, None)
        else:
            sys.modules[_k] = _v

print(json.dumps({'done': True}))
