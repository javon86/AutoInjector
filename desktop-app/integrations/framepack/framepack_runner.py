#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
framepack_runner.py - AutoInjector's own FramePack runner (picture -> video).

AutoInjector starts this with FramePack's OWN python (its venv) and the FramePack folder as the
working folder, so it can reuse FramePack's `diffusers_helper` exactly the way FramePack's
demo_gradio.py `worker()` does (the original image-to-video model, lllyasviel/FramePackI2V_HY):
text encoders + tokenizers + VAE (hunyuanvideo-community/HunyuanVideo), the picture encoder
(lllyasviel/flux_redux_bfl), the packed transformer, the section loop with sample_hunyuan,
latent padding, VAE decode with soft_append_bcthw and save_bcthw_as_mp4 at 30 fps.

It NEVER downloads anything: HF_HUB_OFFLINE=1 is set before any Hugging Face import, and the
model cache (HF_HOME) is the one AutoInjector found ("stuff and thing"/models/video/framepack/hf,
else FramePack's own hf_download).

It is a long-lived process that speaks JSON lines:
  stdin  (one JSON object per line, from AutoInjector)
    {"cmd": "ping"}                                   -> {"event": "pong"}
    {"cmd": "status"}                                 -> {"event": "status", "loaded", "busy", ...}
    {"cmd": "load", "id": "..."}                      -> {"event": "loading", "stage", "step", "steps"} ... {"event": "loaded", "vram_gb", "high_vram"}
    {"cmd": "generate", "id": "...", "image": "C:/pic.png", "prompt": "...", "negative": "",
     "seconds": 5, "seed": 31337, "steps": 25, "cfg": 1, "gs": 10, "rs": 0, "use_teacache": true,
     "mp4_crf": 16, "gpu_memory_preservation": 6, "out": "C:/.../clip.mp4", "poster": "C:/.../clip.png"}
        -> {"event": "progress", "id", "phase", "section", "sections", "step", "steps", "percent", "frames", "video_seconds"} ...
        -> {"event": "result", "id", "ok": true, "path", "frames", "fps": 30, "seconds", "width", "height", "sections", "seed"}
    {"cmd": "cancel"}                                 -> {"event": "cancelling"} ... then {"event": "cancelled", "id"}
    {"cmd": "quit"}
  stdout  only these JSON lines (everything FramePack / torch prints goes to stderr).
  Errors: {"event": "error", "id", "code", "message", "fix"} with code one of
    FRAMEPACK_MODEL_MISSING (+ "missing": [...]), FRAMEPACK_OOM, FRAMEPACK_FAILED, FRAMEPACK_BUSY, BAD_REQUEST.

torch / diffusers / transformers are imported INSIDE the functions that need them, so this file can be
checked (and its JSON handling tested) by any Python 3 without them.
"""
from __future__ import print_function

import argparse
import json
import math
import os
import sys
import threading
import time
import traceback

PROTOCOL = 1
FPS = 30
LATENT_WINDOW_SIZE = 9  # FramePack's demo keeps this at 9 (hidden in its UI)

# The demo's own defaults (demo_gradio.py): 5 s, seed 31337, 25 steps, CFG 1 (real guidance, hidden),
# distilled CFG 10, rescale 0, TeaCache on, MP4 quality 16, keep 6 GB of graphics memory free.
DEFAULTS = {
    'seconds': 5.0, 'seed': 31337, 'steps': 25, 'cfg': 1.0, 'gs': 10.0, 'rs': 0.0,
    'use_teacache': True, 'mp4_crf': 16, 'gpu_memory_preservation': 6.0, 'negative': '', 'prompt': '',
}
LIMITS = {
    'seconds': (1.0, 10.0), 'steps': (1, 100), 'cfg': (1.0, 32.0), 'gs': (1.0, 32.0), 'rs': (0.0, 1.0),
    'mp4_crf': (0, 100), 'gpu_memory_preservation': (6.0, 128.0),
}

# What FramePack's I2V needs from the Hugging Face cache: repo -> sub-folders (None = the repo's root).
NEEDED_MODELS = [
    ('hunyuanvideo-community/HunyuanVideo', ['text_encoder', 'text_encoder_2', 'tokenizer', 'tokenizer_2', 'vae']),
    ('lllyasviel/flux_redux_bfl', ['image_encoder', 'feature_extractor']),
    ('lllyasviel/FramePackI2V_HY', [None]),
]


class RunnerError(Exception):
    def __init__(self, code, message, fix='', **extra):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.fix = fix
        self.extra = extra

    def to_event(self, job_id=None):
        ev = {'event': 'error', 'id': job_id, 'code': self.code, 'message': self.message, 'fix': self.fix}
        ev.update(self.extra)
        return ev


class Cancelled(Exception):
    pass


# --------------------------------------------------------------------------- small pure helpers
def _num(v, name):
    if isinstance(v, bool):
        raise RunnerError('BAD_REQUEST', '%s must be a number.' % name)
    try:
        n = float(v)
    except (TypeError, ValueError):
        raise RunnerError('BAD_REQUEST', '%s must be a number (got %r).' % (name, str(v)[:40]))
    if math.isnan(n) or math.isinf(n):
        raise RunnerError('BAD_REQUEST', '%s must be a number.' % name)
    return n


def _clamp(n, lo, hi):
    return max(lo, min(hi, n))


def sections_for(seconds, latent_window_size=LATENT_WINDOW_SIZE):
    """demo_gradio.py: total_latent_sections = max(round(seconds * 30 / (window * 4)), 1)."""
    s = (float(seconds) * FPS) / (latent_window_size * 4)
    return int(max(round(s), 1))


def frames_for(sections, latent_window_size=LATENT_WINDOW_SIZE):
    """The finished clip's frame count: each section adds `window` latent frames, the start picture one more;
    a latent frame is 4 video frames minus the 3 the VAE overlaps."""
    latent = sections * latent_window_size + 1
    return latent * 4 - 3


def latent_paddings_for(sections):
    """demo_gradio.py: reversed(range(n)); for more than 4 sections [3] + [2]*(n-3) + [1, 0] (looks better)."""
    if sections > 4:
        return [3] + [2] * (sections - 3) + [1, 0]
    return list(reversed(range(sections)))


def normalize_request(req):
    """Check and clamp one generate request -> a plain dict (raises RunnerError('BAD_REQUEST'))."""
    if not isinstance(req, dict):
        raise RunnerError('BAD_REQUEST', 'The request must be a JSON object.')
    image = req.get('image')
    if not isinstance(image, str) or not image.strip():
        raise RunnerError('BAD_REQUEST', 'FramePack needs a picture (image: the path of a .png / .jpg / .webp file).')
    image = image.strip()
    if not os.path.isfile(image):
        raise RunnerError('BAD_REQUEST', 'The picture "%s" was not found.' % image)
    out = req.get('out')
    if not isinstance(out, str) or not out.strip():
        raise RunnerError('BAD_REQUEST', 'out (where to save the .mp4) is missing.')
    p = dict(DEFAULTS)
    for k in ('prompt', 'negative'):
        if req.get(k) is not None:
            if not isinstance(req.get(k), str):
                raise RunnerError('BAD_REQUEST', '%s must be text.' % k)
            p[k] = req[k][:4000]
    for k in ('seconds', 'steps', 'cfg', 'gs', 'rs', 'mp4_crf', 'gpu_memory_preservation'):
        if req.get(k) is not None:
            lo, hi = LIMITS[k]
            p[k] = _clamp(_num(req[k], k), lo, hi)
    p['steps'] = int(round(p['steps']))
    p['mp4_crf'] = int(round(p['mp4_crf']))
    if req.get('seed') is not None:
        s = _num(req['seed'], 'seed')
        p['seed'] = int(s) % (2 ** 63) if s >= 0 else DEFAULTS['seed']
    if req.get('use_teacache') is not None:
        p['use_teacache'] = bool(req['use_teacache'])
    p['image'] = image
    p['out'] = out.strip()
    poster = req.get('poster')
    p['poster'] = poster.strip() if isinstance(poster, str) and poster.strip() else None
    p['id'] = req.get('id')
    p['sections'] = sections_for(p['seconds'])
    p['frames'] = frames_for(p['sections'])
    return p


OOM_WORDS = ('out of memory', 'outofmemoryerror', 'cuda error: out of memory', 'not enough memory', 'defaultcpuallocator', 'tried to allocate')
MISSING_WORDS = ('localentrynotfounderror', 'does not appear to have a file named', 'cannot find the requested files', "can't load", 'no such file or directory', 'offline mode', 'outgoing traffic has been disabled', 'is not a local folder')


def classify_error(exc):
    """An exception (or its text) -> (code, message, fix) in plain words."""
    if isinstance(exc, RunnerError):
        return exc.code, exc.message, exc.fix
    text = ('%s: %s' % (type(exc).__name__, exc)) if isinstance(exc, BaseException) else str(exc)
    low = text.lower()
    if any(w in low for w in OOM_WORDS):
        return ('FRAMEPACK_OOM', 'Your graphics card ran out of memory making this video.',
                'Raise "GPU memory to keep free" (e.g. to 8 or 10 GB), make a shorter clip, and close other programs that use the graphics card.')
    if any(w in low for w in MISSING_WORDS):
        return ('FRAMEPACK_MODEL_MISSING', 'FramePack could not open one of its model files (%s).' % first_line(text)[:200],
                'Check the FramePack models folder ("stuff and thing"/models/video/framepack/hf/hub) has all three models. Nothing is downloaded by AutoInjector.')
    return ('FRAMEPACK_FAILED', 'FramePack could not make the video: %s' % first_line(text)[:300], 'Look at the details below; try again, or a shorter clip.')


def first_line(text):
    for line in str(text).splitlines():
        line = line.strip()
        if line and not line.startswith('Traceback') and not line.startswith('File '):
            return line
    return str(text).strip()[:300]


def _snapshot_dir(repo_dir):
    """The snapshot folder of an HF cache repo: refs/main's revision, else the newest snapshot."""
    snaps = os.path.join(repo_dir, 'snapshots')
    try:
        with open(os.path.join(repo_dir, 'refs', 'main')) as f:
            rev = f.read().strip()
        if rev and os.path.isdir(os.path.join(snaps, rev)):
            return os.path.join(snaps, rev)
    except (IOError, OSError):
        pass
    try:
        names = [n for n in os.listdir(snaps) if os.path.isdir(os.path.join(snaps, n))]
    except OSError:
        return None
    if not names:
        return None
    names.sort(key=lambda n: os.path.getmtime(os.path.join(snaps, n)), reverse=True)
    return os.path.join(snaps, names[0])


def _has_weights(folder):
    try:
        names = os.listdir(folder)
    except OSError:
        return False
    return any(n for n in names if not n.startswith('.'))


def check_models(hf_home):
    """What is missing from the HF cache under hf_home (a list of 'repo/subfolder' strings; [] = all there)."""
    hub = os.path.join(hf_home, 'hub')
    missing = []
    for repo, subs in NEEDED_MODELS:
        rd = os.path.join(hub, 'models--' + repo.replace('/', '--'))
        snap = _snapshot_dir(rd) if os.path.isdir(rd) else None
        for sub in subs:
            label = repo + ('/' + sub if sub else '')
            if not snap:
                missing.append(label)
                continue
            folder = os.path.join(snap, sub) if sub else snap
            if not _has_weights(folder):
                missing.append(label)
    return missing


# --------------------------------------------------------------------------- the real engine
class Engine(object):
    """FramePack's I2V, the way demo_gradio.py runs it. Models are loaded once and kept."""

    def __init__(self, hf_home=None):
        self.hf_home = hf_home
        self.loaded = False
        self.high_vram = False
        self.vram_gb = None
        self.m = {}

    def status(self):
        return {'loaded': self.loaded, 'high_vram': self.high_vram, 'vram_gb': self.vram_gb}

    def load(self, emit):
        if self.loaded:
            emit({'event': 'loaded', 'vram_gb': self.vram_gb, 'high_vram': self.high_vram, 'already': True})
            return
        if self.hf_home:
            missing = check_models(self.hf_home)
            if missing:
                raise RunnerError('FRAMEPACK_MODEL_MISSING', 'FramePack\'s model files are not all there (missing: %s).' % ', '.join(missing),
                                  'Put FramePack\'s "hub" folder into "stuff and thing"/models/video/framepack/hf. Nothing is downloaded by AutoInjector.', missing=missing)
        steps = 7
        emit({'event': 'loading', 'stage': 'starting PyTorch', 'step': 0, 'steps': steps})
        import torch
        if not torch.cuda.is_available():
            raise RunnerError('FRAMEPACK_FAILED', 'FramePack needs an NVIDIA graphics card (CUDA), and PyTorch in FramePack\'s folder does not see one.',
                              'Check the graphics card driver is installed, then try again. FramePack does not run on the processor.', cause='NO_GPU')
        from diffusers import AutoencoderKLHunyuanVideo
        from transformers import LlamaModel, CLIPTextModel, LlamaTokenizerFast, CLIPTokenizer
        from transformers import SiglipImageProcessor, SiglipVisionModel
        from diffusers_helper.models.hunyuan_video_packed import HunyuanVideoTransformer3DModelPacked
        from diffusers_helper.memory import gpu, get_cuda_free_memory_gb, DynamicSwapInstaller

        free_mem_gb = get_cuda_free_memory_gb(gpu)
        high_vram = free_mem_gb > 60
        print('Free VRAM %s GB, high-VRAM mode: %s' % (free_mem_gb, high_vram), file=sys.stderr)
        hv = 'hunyuanvideo-community/HunyuanVideo'
        emit({'event': 'loading', 'stage': 'the text encoder (Llama)', 'step': 1, 'steps': steps})
        text_encoder = LlamaModel.from_pretrained(hv, subfolder='text_encoder', torch_dtype=torch.float16).cpu()
        emit({'event': 'loading', 'stage': 'the text encoder (CLIP)', 'step': 2, 'steps': steps})
        text_encoder_2 = CLIPTextModel.from_pretrained(hv, subfolder='text_encoder_2', torch_dtype=torch.float16).cpu()
        tokenizer = LlamaTokenizerFast.from_pretrained(hv, subfolder='tokenizer')
        tokenizer_2 = CLIPTokenizer.from_pretrained(hv, subfolder='tokenizer_2')
        emit({'event': 'loading', 'stage': 'the VAE', 'step': 3, 'steps': steps})
        vae = AutoencoderKLHunyuanVideo.from_pretrained(hv, subfolder='vae', torch_dtype=torch.float16).cpu()
        emit({'event': 'loading', 'stage': 'the picture encoder', 'step': 4, 'steps': steps})
        feature_extractor = SiglipImageProcessor.from_pretrained('lllyasviel/flux_redux_bfl', subfolder='feature_extractor')
        image_encoder = SiglipVisionModel.from_pretrained('lllyasviel/flux_redux_bfl', subfolder='image_encoder', torch_dtype=torch.float16).cpu()
        emit({'event': 'loading', 'stage': 'the FramePack video model', 'step': 5, 'steps': steps})
        transformer = HunyuanVideoTransformer3DModelPacked.from_pretrained('lllyasviel/FramePackI2V_HY', torch_dtype=torch.bfloat16).cpu()

        emit({'event': 'loading', 'stage': 'preparing the graphics card', 'step': 6, 'steps': steps})
        vae.eval()
        text_encoder.eval()
        text_encoder_2.eval()
        image_encoder.eval()
        transformer.eval()
        if not high_vram:
            vae.enable_slicing()
            vae.enable_tiling()
        transformer.high_quality_fp32_output_for_inference = True
        transformer.to(dtype=torch.bfloat16)
        vae.to(dtype=torch.float16)
        image_encoder.to(dtype=torch.float16)
        text_encoder.to(dtype=torch.float16)
        text_encoder_2.to(dtype=torch.float16)
        for mdl in (vae, text_encoder, text_encoder_2, image_encoder, transformer):
            mdl.requires_grad_(False)
        if not high_vram:
            # DynamicSwapInstaller: like huggingface's enable_sequential_offload, but 3x faster (FramePack's words)
            DynamicSwapInstaller.install_model(transformer, device=gpu)
            DynamicSwapInstaller.install_model(text_encoder, device=gpu)
        else:
            text_encoder.to(gpu)
            text_encoder_2.to(gpu)
            image_encoder.to(gpu)
            vae.to(gpu)
            transformer.to(gpu)
        self.m = dict(text_encoder=text_encoder, text_encoder_2=text_encoder_2, tokenizer=tokenizer, tokenizer_2=tokenizer_2,
                      vae=vae, feature_extractor=feature_extractor, image_encoder=image_encoder, transformer=transformer)
        self.high_vram = high_vram
        self.vram_gb = round(float(free_mem_gb), 1)
        self.loaded = True
        emit({'event': 'loaded', 'vram_gb': self.vram_gb, 'high_vram': high_vram})

    def _unload_all(self):
        try:
            from diffusers_helper.memory import unload_complete_models
            m = self.m
            unload_complete_models(m['text_encoder'], m['text_encoder_2'], m['image_encoder'], m['vae'], m['transformer'])
        except Exception:
            traceback.print_exc()

    def generate(self, p, emit, should_stop):
        import torch
        with torch.no_grad():
            try:
                return self._generate(p, emit, should_stop)
            except BaseException:
                if not self.high_vram:
                    self._unload_all()
                try:
                    torch.cuda.empty_cache()
                except Exception:
                    pass
                raise

    def _generate(self, p, emit, should_stop):
        import numpy as np
        import torch
        import einops  # noqa: F401  (FramePack's helpers use it)
        from PIL import Image
        from diffusers_helper.hunyuan import encode_prompt_conds, vae_decode, vae_encode
        from diffusers_helper.utils import save_bcthw_as_mp4, crop_or_pad_yield_mask, soft_append_bcthw, resize_and_center_crop
        from diffusers_helper.pipelines.k_diffusion_hunyuan import sample_hunyuan
        from diffusers_helper.memory import gpu, move_model_to_device_with_memory_preservation, offload_model_from_device_for_memory_preservation
        from diffusers_helper.memory import fake_diffusers_current_device, unload_complete_models, load_model_as_complete
        from diffusers_helper.clip_vision import hf_clip_vision_encode
        from diffusers_helper.bucket_tools import find_nearest_bucket

        m = self.m
        high_vram = self.high_vram
        text_encoder, text_encoder_2, tokenizer, tokenizer_2 = m['text_encoder'], m['text_encoder_2'], m['tokenizer'], m['tokenizer_2']
        vae, feature_extractor, image_encoder, transformer = m['vae'], m['feature_extractor'], m['image_encoder'], m['transformer']
        jid = p.get('id')
        steps = p['steps']
        lws = LATENT_WINDOW_SIZE
        total_latent_sections = p['sections']
        total_steps = total_latent_sections * steps

        def phase(name, pct=0.0):
            emit({'event': 'progress', 'id': jid, 'phase': name, 'section': 0, 'sections': total_latent_sections, 'step': 0, 'steps': steps, 'percent': pct})

        def stop_check():
            if should_stop():
                raise Cancelled()

        # Clean GPU
        if not high_vram:
            unload_complete_models(text_encoder, text_encoder_2, image_encoder, vae, transformer)

        # Text encoding
        phase('text')
        if not high_vram:
            fake_diffusers_current_device(text_encoder, gpu)
            load_model_as_complete(text_encoder_2, target_device=gpu)
        llama_vec, clip_l_pooler = encode_prompt_conds(p['prompt'], text_encoder, text_encoder_2, tokenizer, tokenizer_2)
        if p['cfg'] == 1:
            llama_vec_n, clip_l_pooler_n = torch.zeros_like(llama_vec), torch.zeros_like(clip_l_pooler)
        else:
            llama_vec_n, clip_l_pooler_n = encode_prompt_conds(p['negative'], text_encoder, text_encoder_2, tokenizer, tokenizer_2)
        llama_vec, llama_attention_mask = crop_or_pad_yield_mask(llama_vec, length=512)
        llama_vec_n, llama_attention_mask_n = crop_or_pad_yield_mask(llama_vec_n, length=512)
        stop_check()

        # The picture
        phase('picture')
        input_image = np.array(Image.open(p['image']).convert('RGB'))
        H, W, C = input_image.shape
        height, width = find_nearest_bucket(H, W, resolution=640)
        input_image_np = resize_and_center_crop(input_image, target_width=width, target_height=height)
        if p.get('poster'):
            try:
                Image.fromarray(input_image_np).save(p['poster'])
            except Exception:
                traceback.print_exc()
        input_image_pt = torch.from_numpy(input_image_np).float() / 127.5 - 1
        input_image_pt = input_image_pt.permute(2, 0, 1)[None, :, None]

        # VAE encoding
        phase('vae-encode')
        if not high_vram:
            load_model_as_complete(vae, target_device=gpu)
        start_latent = vae_encode(input_image_pt, vae)

        # CLIP Vision
        phase('vision')
        if not high_vram:
            load_model_as_complete(image_encoder, target_device=gpu)
        image_encoder_output = hf_clip_vision_encode(input_image_np, feature_extractor, image_encoder)
        image_encoder_last_hidden_state = image_encoder_output.last_hidden_state

        # Dtype
        llama_vec = llama_vec.to(transformer.dtype)
        llama_vec_n = llama_vec_n.to(transformer.dtype)
        clip_l_pooler = clip_l_pooler.to(transformer.dtype)
        clip_l_pooler_n = clip_l_pooler_n.to(transformer.dtype)
        image_encoder_last_hidden_state = image_encoder_last_hidden_state.to(transformer.dtype)
        stop_check()

        # Sampling
        rnd = torch.Generator('cpu').manual_seed(p['seed'])
        num_frames = lws * 4 - 3
        history_latents = torch.zeros(size=(1, 16, 1 + 2 + 16, height // 8, width // 8), dtype=torch.float32).cpu()
        history_pixels = None
        total_generated_latent_frames = 0
        out = p['out']
        out_dir = os.path.dirname(os.path.abspath(out)) or '.'
        if not os.path.isdir(out_dir):
            os.makedirs(out_dir)
        tmp_files = []
        section_no = 0
        for latent_padding in latent_paddings_for(total_latent_sections):
            section_no += 1
            is_last_section = latent_padding == 0
            latent_padding_size = latent_padding * lws
            stop_check()
            print('latent_padding_size = %s, is_last_section = %s' % (latent_padding_size, is_last_section), file=sys.stderr)

            indices = torch.arange(0, sum([1, latent_padding_size, lws, 1, 2, 16])).unsqueeze(0)
            clean_latent_indices_pre, blank_indices, latent_indices, clean_latent_indices_post, clean_latent_2x_indices, clean_latent_4x_indices = \
                indices.split([1, latent_padding_size, lws, 1, 2, 16], dim=1)
            clean_latent_indices = torch.cat([clean_latent_indices_pre, clean_latent_indices_post], dim=1)
            clean_latents_pre = start_latent.to(history_latents)
            clean_latents_post, clean_latents_2x, clean_latents_4x = history_latents[:, :, :1 + 2 + 16, :, :].split([1, 2, 16], dim=2)
            clean_latents = torch.cat([clean_latents_pre, clean_latents_post], dim=2)

            if not high_vram:
                unload_complete_models()
                move_model_to_device_with_memory_preservation(transformer, target_device=gpu, preserved_memory_gb=p['gpu_memory_preservation'])

            if p['use_teacache']:
                transformer.initialize_teacache(enable_teacache=True, num_steps=steps)
            else:
                transformer.initialize_teacache(enable_teacache=False)

            made_so_far = int(max(0, total_generated_latent_frames * 4 - 3))

            def callback(d, _section=section_no, _made=made_so_far):
                if should_stop():
                    raise Cancelled()
                current_step = d['i'] + 1
                done = (_section - 1) * steps + current_step
                emit({'event': 'progress', 'id': jid, 'phase': 'sampling', 'section': _section, 'sections': total_latent_sections,
                      'step': current_step, 'steps': steps, 'percent': round(min(1.0, float(done) / total_steps), 4),
                      'frames': _made, 'video_seconds': round(max(0, _made) / float(FPS), 2)})

            generated_latents = sample_hunyuan(
                transformer=transformer, sampler='unipc', width=width, height=height, frames=num_frames,
                real_guidance_scale=p['cfg'], distilled_guidance_scale=p['gs'], guidance_rescale=p['rs'],
                num_inference_steps=steps, generator=rnd,
                prompt_embeds=llama_vec, prompt_embeds_mask=llama_attention_mask, prompt_poolers=clip_l_pooler,
                negative_prompt_embeds=llama_vec_n, negative_prompt_embeds_mask=llama_attention_mask_n, negative_prompt_poolers=clip_l_pooler_n,
                device=gpu, dtype=torch.bfloat16, image_embeddings=image_encoder_last_hidden_state,
                latent_indices=latent_indices, clean_latents=clean_latents, clean_latent_indices=clean_latent_indices,
                clean_latents_2x=clean_latents_2x, clean_latent_2x_indices=clean_latent_2x_indices,
                clean_latents_4x=clean_latents_4x, clean_latent_4x_indices=clean_latent_4x_indices,
                callback=callback,
            )

            if is_last_section:
                generated_latents = torch.cat([start_latent.to(generated_latents), generated_latents], dim=2)
            total_generated_latent_frames += int(generated_latents.shape[2])
            history_latents = torch.cat([generated_latents.to(history_latents), history_latents], dim=2)

            emit({'event': 'progress', 'id': jid, 'phase': 'decoding', 'section': section_no, 'sections': total_latent_sections,
                  'step': steps, 'steps': steps, 'percent': round(min(1.0, float(section_no * steps) / total_steps), 4)})
            if not high_vram:
                offload_model_from_device_for_memory_preservation(transformer, target_device=gpu, preserved_memory_gb=8)
                load_model_as_complete(vae, target_device=gpu)

            real_history_latents = history_latents[:, :, :total_generated_latent_frames, :, :]
            if history_pixels is None:
                history_pixels = vae_decode(real_history_latents, vae).cpu()
            else:
                section_latent_frames = (lws * 2 + 1) if is_last_section else (lws * 2)
                overlapped_frames = lws * 4 - 3
                current_pixels = vae_decode(real_history_latents[:, :, :section_latent_frames], vae).cpu()
                history_pixels = soft_append_bcthw(current_pixels, history_pixels, overlapped_frames)

            if not high_vram:
                unload_complete_models()

            # Like the demo, every section is saved (a growing clip); only the last one is kept.
            part = os.path.join(out_dir, '.framepack-%s-%d.mp4' % (str(jid or 'job')[:40], total_generated_latent_frames))
            try:
                save_bcthw_as_mp4(history_pixels, part, fps=FPS, crf=p['mp4_crf'])
            except TypeError:  # an older FramePack without the crf option
                save_bcthw_as_mp4(history_pixels, part, fps=FPS)
            tmp_files.append(part)
            print('Decoded. Current latent shape %s; pixel shape %s' % (tuple(real_history_latents.shape), tuple(history_pixels.shape)), file=sys.stderr)
            if is_last_section:
                break

        if not tmp_files:
            raise RunnerError('FRAMEPACK_FAILED', 'FramePack finished without a video file.')
        os.replace(tmp_files[-1], out)
        for f in tmp_files[:-1]:
            try:
                os.remove(f)
            except OSError:
                pass
        frames = int(history_pixels.shape[2])
        return {'path': out, 'frames': frames, 'fps': FPS, 'seconds': round(frames / float(FPS), 2), 'width': int(width), 'height': int(height),
                'sections': total_latent_sections, 'seed': p['seed'], 'poster': p.get('poster')}


# --------------------------------------------------------------------------- the JSON-lines server
class Server(object):
    def __init__(self, engine, out):
        self.engine = engine
        self.out = out
        self.lock = threading.Lock()
        self.job = None  # {'id', 'kind', 'cancel': Event, 'thread'}
        self.started = time.time()

    def emit(self, obj):
        line = json.dumps(obj, ensure_ascii=True, default=str)
        with self.lock:
            try:
                self.out.write(line + '\n')
                self.out.flush()
            except (IOError, OSError, ValueError):
                pass

    def busy(self):
        j = self.job
        return bool(j and j['thread'].is_alive())

    def status(self):
        j = self.job if self.busy() else None
        st = {'event': 'status', 'protocol': PROTOCOL, 'busy': bool(j), 'job': (j['kind'] if j else None), 'job_id': (j['id'] if j else None),
              'pid': os.getpid(), 'uptime': round(time.time() - self.started, 1)}
        try:
            st.update(self.engine.status())
        except Exception:
            pass
        return st

    def _run(self, kind, jid, fn):
        cancel = threading.Event()

        def target():
            try:
                fn(cancel)
            except Cancelled:
                self.emit({'event': 'cancelled', 'id': jid})
            except RunnerError as e:
                self.emit(e.to_event(jid))
            except BaseException as e:  # noqa: B902 - everything must become an answer
                traceback.print_exc()
                code, message, fix = classify_error(e)
                self.emit({'event': 'error', 'id': jid, 'code': code, 'message': message, 'fix': fix, 'detail': first_line('%s: %s' % (type(e).__name__, e))[:1500]})

        t = threading.Thread(target=target, name='framepack-' + kind)
        t.daemon = True
        self.job = {'id': jid, 'kind': kind, 'cancel': cancel, 'thread': t}
        t.start()

    def handle(self, msg):
        """One command. Returns False to stop the server."""
        if not isinstance(msg, dict):
            self.emit({'event': 'error', 'code': 'BAD_REQUEST', 'message': 'Each line must be a JSON object.'})
            return True
        cmd = msg.get('cmd')
        jid = msg.get('id')
        if cmd == 'ping':
            self.emit({'event': 'pong', 'id': jid})
        elif cmd == 'status':
            self.emit(dict(self.status(), id=jid))
        elif cmd == 'quit':
            if self.job:
                self.job['cancel'].set()
            return False
        elif cmd == 'cancel':
            if self.busy():
                self.job['cancel'].set()
                self.emit({'event': 'cancelling', 'id': self.job['id']})
            else:
                self.emit({'event': 'cancelled', 'id': jid, 'idle': True})
        elif cmd in ('load', 'generate'):
            if self.busy():
                self.emit({'event': 'error', 'id': jid, 'code': 'FRAMEPACK_BUSY', 'message': 'FramePack is already busy (%s).' % self.job['kind'],
                           'fix': 'Wait for it, or press Stop.'})
                return True
            if cmd == 'load':
                self._run('load', jid, lambda cancel: self.engine.load(self.emit))
            else:
                try:
                    p = normalize_request(msg)
                except RunnerError as e:
                    self.emit(e.to_event(jid))
                    return True
                self.emit({'event': 'accepted', 'id': jid, 'sections': p['sections'], 'frames': p['frames'], 'seconds': round(p['frames'] / float(FPS), 2), 'seed': p['seed']})

                def work(cancel, p=p):
                    if not getattr(self.engine, 'loaded', False):
                        self.engine.load(self.emit)
                    if cancel.is_set():
                        raise Cancelled()
                    res = self.engine.generate(p, self.emit, cancel.is_set)
                    ev = {'event': 'result', 'id': jid, 'ok': True}
                    ev.update(res)
                    self.emit(ev)
                self._run('generate', jid, work)
        else:
            self.emit({'event': 'error', 'id': jid, 'code': 'BAD_REQUEST', 'message': 'Unknown command %r.' % str(cmd)[:40]})
        return True

    def serve(self, inp):
        self.emit({'event': 'ready', 'protocol': PROTOCOL, 'pid': os.getpid(), 'python': sys.version.split()[0]})
        for raw in inp:
            if isinstance(raw, bytes):
                raw = raw.decode('utf-8', 'replace')
            line = raw.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                self.emit({'event': 'error', 'code': 'BAD_REQUEST', 'message': 'That line is not JSON.'})
                continue
            if not self.handle(msg):
                break
        # stdin closed / quit: stop what is running
        if self.job:
            self.job['cancel'].set()


# --------------------------------------------------------------------------- start
def parse_args(argv=None):
    ap = argparse.ArgumentParser(description='AutoInjector FramePack runner (JSON lines on stdin/stdout).')
    ap.add_argument('--framepack-dir', default=os.environ.get('AUTOINJECTOR_FRAMEPACK_DIR', ''), help='The FramePack folder (with diffusers_helper/)')
    ap.add_argument('--hf-home', default=os.environ.get('HF_HOME', ''), help='The Hugging Face cache folder (it has hub/)')
    ap.add_argument('--check', action='store_true', help='Only check the folders and models, print one JSON line, exit')
    return ap.parse_args(argv)


def setup_env(framepack_dir, hf_home):
    """Before ANY Hugging Face import: offline, the right cache, FramePack's helpers importable."""
    if hf_home:
        os.environ['HF_HOME'] = os.path.abspath(hf_home)
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    os.environ['HF_DATASETS_OFFLINE'] = '1'
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    os.environ.setdefault('PYTORCH_CUDA_ALLOC_CONF', 'expandable_segments:True')
    if framepack_dir:
        fd = os.path.abspath(framepack_dir)
        if fd not in sys.path:
            sys.path.insert(0, fd)
        try:
            os.chdir(fd)
        except OSError:
            pass


def main(argv=None):
    args = parse_args(argv)
    proto = sys.stdout
    sys.stdout = sys.stderr  # FramePack / torch print a lot: only our JSON lines go to the real stdout
    if args.framepack_dir and not os.path.isdir(os.path.join(args.framepack_dir, 'diffusers_helper')):
        proto.write(json.dumps({'event': 'error', 'code': 'FRAMEPACK_NOT_FOUND', 'message': 'There is no FramePack in "%s" (no diffusers_helper folder).' % args.framepack_dir}) + '\n')
        proto.flush()
        return 2
    setup_env(args.framepack_dir, args.hf_home)
    if args.check:
        missing = check_models(args.hf_home) if args.hf_home else []
        proto.write(json.dumps({'event': 'check', 'ok': not missing, 'missing': missing, 'hf_home': args.hf_home, 'python': sys.version.split()[0]}) + '\n')
        proto.flush()
        return 0
    server = Server(Engine(args.hf_home or None), proto)
    stdin = getattr(sys.stdin, 'buffer', sys.stdin)
    server.serve(stdin)
    return 0


if __name__ == '__main__':
    sys.exit(main())
