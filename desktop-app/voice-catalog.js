/*
 * voice-catalog.js — the list of recommended free read-aloud voices (🔊 Voice box → "Better voices").
 *
 *   PIPER_VOICES  good, free Piper voices from the official list (Hugging Face rhasspy/piper-voices). Each one is two
 *                 files that go into the models/voice folder: <name>.onnx (the voice) and <name>.onnx.json (its
 *                 settings). Names, sizes and the short sample were checked against the repository (2026-11).
 *   KOKORO        the optional "best quality" engine (kokoro-onnx): its Python package, its two model files and a
 *                 short list of its English voices.
 *
 * The file URLs follow the documented repository layout:
 *   https://huggingface.co/rhasspy/piper-voices/resolve/main/<lang>/<lang_REGION>/<name>/<quality>/<file>
 * Nothing here touches the internet: main.js downloads a file only when the user presses ⬇ (voice-downloads.js).
 * Shared by main.js (require) and the control panel (window.VoiceCatalog), like voice-read.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VoiceCatalog = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const PIPER_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
  const LANG = { en_US: 'US English', en_GB: 'British English' };

  // [voice name, sound (plain words), man/woman, .onnx bytes, who it suits by default]
  const RAW = [
    ['en_US-lessac-high', 'Lessac — clear and warm', 'woman', 113895201, 'chatgpt'],
    ['en_US-ryan-high', 'Ryan — calm and steady', 'man', 120786792, 'claude'],
    ['en_GB-alba-medium', 'Alba — soft Scottish', 'woman', 63221984, 'gemini'],
    ['en_GB-alan-medium', 'Alan — a proper British butler', 'man', 63201294, 'butler'],
    ['en_GB-northern_english_male-medium', 'Northern English — friendly', 'man', 63201294, ''],
    ['en_GB-cori-high', 'Cori — gentle storyteller', 'woman', 114219352, ''],
    ['en_US-amy-medium', 'Amy — bright', 'woman', 63221984, ''],
    ['en_US-joe-medium', 'Joe — relaxed', 'man', 63221984, ''],
    ['en_GB-jenny_dioco-medium', 'Jenny — light British', 'woman', 63221984, ''],
    ['en_US-lessac-medium', 'Lessac (smaller) — the Setup Wizard\'s voice', 'woman', 63201294, ''],
  ];

  /** "en_US-ryan-high" -> { lang:'en', region:'en_US', speaker:'ryan', quality:'high' } (or null). */
  function parseName(name) {
    const m = /^([a-z]{2,3})_([A-Z]{2})-([a-z0-9_]+)-(x_low|low|medium|high)$/.exec(String(name || ''));
    if (!m) return null;
    return { lang: m[1], region: `${m[1]}_${m[2]}`, speaker: m[3], quality: m[4] };
  }
  /** The download URL of one file of a Piper voice (the documented repository layout). */
  function piperUrl(name, file) {
    const p = parseName(name);
    if (!p) return '';
    return `${PIPER_BASE}/${p.lang}/${p.region}/${p.speaker}/${p.quality}/${file}`;
  }

  const PIPER_VOICES = RAW.map(([id, label, gender, bytes, suits]) => {
    const p = parseName(id);
    return {
      id, label, gender, suits, quality: p.quality, lang: p.region, langLabel: LANG[p.region] || p.region,
      bytes, // the .onnx file; the .onnx.json is a few KB
      sample: piperUrl(id, 'samples/speaker_0.mp3'), // a short recording the voice's makers published (~90 KB)
      files: [
        { name: `${id}.onnx`, url: piperUrl(id, `${id}.onnx`), bytes, minBytes: Math.floor(bytes * 0.9) },
        { name: `${id}.onnx.json`, url: piperUrl(id, `${id}.onnx.json`), minBytes: 500, json: true },
      ],
    };
  });
  function piperVoice(id) { return PIPER_VOICES.find((v) => v.id === id) || null; }
  /** who -> the recommended voice id (Alfred, ChatGPT, Claude and Gemini each a different one). */
  function recommendedFor(who) { const v = PIPER_VOICES.find((x) => x.suits === who); return v ? v.id : ''; }

  // ---- ✨ Kokoro (optional) ---------------------------------------------------------------------------------
  const KOKORO_RELEASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0';
  const KOKORO = {
    packages: ['kokoro-onnx'], // pulls onnxruntime (processor), numpy, phonemizer, espeakng-loader
    folder: 'kokoro', // inside models/voice
    files: [
      { name: 'kokoro-v1.0.onnx', url: `${KOKORO_RELEASE}/kokoro-v1.0.onnx`, bytes: 325532387, minBytes: 300000000 },
      { name: 'voices-v1.0.bin', url: `${KOKORO_RELEASE}/voices-v1.0.bin`, bytes: 28214398, minBytes: 20000000 },
    ],
    approxMB: 350,
    // a short, good English selection: [id, plain label]
    voices: [
      ['af_heart', 'Heart — US, warm (woman)'], ['af_bella', 'Bella — US, lively (woman)'], ['af_nicole', 'Nicole — US, soft (woman)'],
      ['af_sarah', 'Sarah — US (woman)'], ['am_michael', 'Michael — US, deep (man)'], ['am_fenrir', 'Fenrir — US (man)'],
      ['am_puck', 'Puck — US, playful (man)'], ['bf_emma', 'Emma — British (woman)'], ['bf_isabella', 'Isabella — British (woman)'],
      ['bm_george', 'George — British, a butler (man)'], ['bm_fable', 'Fable — British storyteller (man)'], ['bm_lewis', 'Lewis — British (man)'],
    ].map(([id, label]) => ({ id, label })),
    defaults: { butler: 'bm_george', chatgpt: 'af_heart', claude: 'am_michael', gemini: 'bf_emma' },
  };
  function kokoroVoiceOk(id) { return /^[a-z]{2}_[a-z0-9]{1,24}$/.test(String(id || '')); }

  function fmtMB(bytes) { const mb = (Number(bytes) || 0) / (1024 * 1024); return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`; }

  return { PIPER_BASE, PIPER_VOICES, KOKORO, parseName, piperUrl, piperVoice, recommendedFor, kokoroVoiceOk, fmtMB };
}));
