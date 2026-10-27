// test/model-catalog.test.js — the model finder's catalog: Ollama search-page
// scraping, Hugging Face search + file lists (quants, multi-part sums, gated,
// tools from the chat template), uncensored detection/ranking/widening, the
// offline curated list, plain-English errors (offline, timeouts, 401/403/404,
// changed page), and that the HF token never leaks. Fixtures in
// test/fixtures/llm/; no network. Run: node test/model-catalog.test.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const mc = require('../model-catalog');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const GB = 1024 * 1024 * 1024;
const FIX = path.join(__dirname, 'fixtures', 'llm');
const fx = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const HW12 = { bestVramMB: 12288, ramMB: 32768, freeRamMB: 20480 };
const HW4 = { bestVramMB: 4096, ramMB: 8192, freeRamMB: 3000 };

function res(status, body, isJson) {
  return { ok: status >= 200 && status < 300, status, json: async () => (isJson ? JSON.parse(body) : JSON.parse(body)), text: async () => body };
}
// routes: [ [regex, (url, init) => response | Error] ]
function fakeFetch(routes, calls) {
  return async (url, init) => {
    if (calls) calls.push({ url, init });
    for (const [re, fn] of routes) if (re.test(url)) { const r = fn(url, init); if (r instanceof Error) throw r; return r; }
    const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e;
  };
}

async function main() {
  console.log('\n== helpers: quants, params, uncensored ==');
  assert(mc.parseQuant('Qwen2.5-7B-Instruct-Q4_K_M.gguf') === 'Q4_K_M', 'Q4_K_M');
  assert(mc.parseQuant('m-q8_0.gguf') === 'Q8_0', 'lower-case q8_0 → Q8_0');
  assert(mc.parseQuant('a.IQ3_XXS.gguf') === 'IQ3_XXS' && mc.parseQuant('b-IQ4_NL.gguf') === 'IQ4_NL', 'IQ quants');
  assert(mc.parseQuant('Llama-3.2-3B-f16.gguf') === 'F16' && mc.parseQuant('x-BF16.gguf') === 'BF16' && mc.parseQuant('x-Q2_K.gguf') === 'Q2_K', 'F16 / BF16 / Q2_K');
  assert(mc.parseQuant('x-UD-Q4_K_XL.gguf') === 'UD-Q4_K_XL', 'Unsloth UD- quants keep their prefix (Ollama tag)');
  assert(mc.parseQuant('d/Q4_K_M/m-Q4_K_M-00001-of-00003.gguf') === 'Q4_K_M', 'quant from a multi-part file');
  assert(mc.parseQuant('model.gguf') === null, 'no quant in the name → null');
  assert(mc.parseParams('8b') === 8 && mc.parseParams('1.5b') === 1.5 && mc.parseParams('135m') === 0.135, 'param sizes 8b / 1.5b / 135m');
  assert(mc.parseParams('Qwen3-30B-A3B') === 30 && mc.parseParams('Meta-Llama-3.1-8B-Instruct') === 8, 'param size from repo names');
  assert(mc.parseParams('8x7b') > 40 && mc.parseParams('8x7b') < 50, 'MoE 8x7b ≈ 46B');
  assert(mc.parseParams('mystery-model') === null, 'unknown → null');
  assert(mc.parseCount('4.2M') === 4200000 && mc.parseCount('98.1K') === 98100 && mc.parseCount('1,234') === 1234, 'pull counts');
  for (const n of ['dolphin3', 'hermes3:8b', 'Llama-3.1-8B-abliterated', 'Lexi-Llama-3-8B-Uncensored', 'huihui_ai/qwen3-abliterated', 'Mistral-unfiltered', 'NSFW-capable-7b', 'Qwen-Heretic']) {
    assert(mc.isUncensored(n), `"${n}" is detected as uncensored`);
  }
  for (const n of ['qwen2.5', 'llama3.1', 'lexicon-model', 'mistral-nemo']) assert(!mc.isUncensored(n), `"${n}" is not flagged`);
  assert(mc.isUncensored('some-model', ['gguf', 'uncensored']), 'a tag can mark it uncensored');

  console.log('\n== GGUF file grouping (multi-part summed, mmproj skipped) ==');
  const siblings = JSON.parse(fx('hf-model-qwen.json')).siblings;
  const groups = mc.groupGgufFiles(siblings, 'bartowski/Qwen2.5-7B-Instruct-GGUF');
  assert(groups.map((g) => g.quant).join(',') === 'IQ2_M,Q3_K_M,Q4_K_M,Q6_K,Q8_0,F16', `quants smallest first: ${groups.map((g) => g.quant).join(',')}`);
  const f16 = groups.find((g) => g.quant === 'F16');
  assert(f16.parts === 2 && f16.sizeBytes === 7900000000 + 7330000000, 'the 2-part F16 sizes are summed');
  assert(!groups.some((g) => /mmproj/.test(g.file)), 'the vision projector file is not a variant');
  assert(groups[2].pullName === 'hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M', 'pullName = hf.co/<repo>:<QUANT>');

  console.log('\n== Ollama search page parse ==');
  const parsed = mc.parseOllamaSearchHtml(fx('ollama-search.html'));
  assert(parsed.length === 4, `4 models parsed (nav <li>s ignored): ${parsed.map((p) => p.name).join(', ')}`);
  const q3 = parsed[0];
  assert(q3.name === 'qwen3' && q3.title === 'qwen3', 'name/title');
  assert(q3.capabilities.join() === 'tools,thinking' && q3.sizes.join() === '0.6b,8b,32b,235b', 'capabilities and sizes');
  assert(q3.pulls === 4200000 && /latest generation/.test(q3.description), 'pull count + description');
  assert(parsed[1].name === 'huihui_ai/qwen3-abliterated' && /abliterated & uncensored/.test(parsed[1].description), 'community model keeps its user/ prefix; entities decoded');
  assert(mc.parseOllamaSearchHtml('<html>garbage</html>').length === 0 && mc.parseOllamaSearchHtml(null).length === 0, 'garbage → []');

  console.log('\n== searchOllama ==');
  let calls = [];
  let cat = mc.createCatalog({ fetch: fakeFetch([[/ollama\.com\/search/, () => res(200, fx('ollama-search.html'))]], calls) });
  let r = await cat.searchOllama('qwen', { hardware: HW12 });
  assert(r.ok && r.models.length === 4, 'ok with models');
  assert(/ollama\.com\/search\?q=qwen$/.test(calls[0].url), `requests ${calls[0].url}`);
  const m = r.models[0];
  assert(m.id === 'ollama:qwen3' && m.source === 'ollama' && m.tools === true && m.thinking === true, 'model shape: id/source/tools');
  assert(m.variants.length === 4 && m.variants[1].pullName === 'qwen3:8b' && m.variants[1].params === 8, 'one variant per size tag, pullName name:size');
  assert(Math.abs(m.variants[1].sizeBytes - (8 * 0.6 + 0.2) * GB) < GB * 0.01 && m.variants[1].estimated, 'size estimated at ~0.6 GB per billion (Q4)');
  assert(m.fit && m.fit.rating === 'great' && m.pullName === 'qwen3:8b', 'auto-picks the biggest that fits great (8b on 12 GB)');
  assert(m.variants.every((v) => v.fit && v.fit.label), 'every variant carries its own fit');
  assert(m.variants.find((v) => v.tag === 'qwen3:235b').fit.rating === 'too-big', '235b is too big');
  assert(r.models[1].uncensored === true && r.models[0].uncensored === false, 'uncensored flagged per model');
  assert(r.models[2].vision === true, 'vision capability');
  await cat.searchOllama('x', { toolsOnly: true });
  assert(/&c=tools/.test(calls[calls.length - 1].url), 'toolsOnly adds the tools filter to the Ollama search');
  cat = mc.createCatalog({ fetch: fakeFetch([[/ollama\.com/, () => res(200, '<html><ul><li class="new-layout">qwen3</li></ul></html>')]]) });
  r = await cat.searchOllama('qwen');
  assert(r.ok === false && /page changed/.test(r.error), 'a changed page layout → plain error, not a crash');
  cat = mc.createCatalog({ fetch: fakeFetch([[/ollama\.com/, () => res(503, 'down')]]) });
  r = await cat.searchOllama('qwen');
  assert(r.ok === false && /having trouble/.test(r.error), '503 → "having trouble right now"');

  console.log('\n== searchHf ==');
  calls = [];
  cat = mc.createCatalog({ fetch: fakeFetch([[/huggingface\.co\/api\/models\?/, () => res(200, fx('hf-search.json'), true)]], calls), hfToken: () => 'hf_SECRETtoken123' });
  r = await cat.searchHf('qwen 7b', { limit: 20 });
  const u = calls[0].url;
  assert(r.ok && r.models.length === 4, 'ok with 4 models');
  assert(/api\/models\?search=qwen%207b&filter=gguf&sort=downloads&direction=-1&limit=20$/.test(u), `documented query: ${u}`);
  assert(calls[0].init.headers.Authorization === 'Bearer hf_SECRETtoken123', 'Bearer token sent when connected');
  assert(!u.includes('SECRET'), 'token is never in the URL');
  const qw = r.models[0];
  assert(qw.id === 'hf:bartowski/Qwen2.5-7B-Instruct-GGUF' && qw.source === 'hf' && qw.repo === 'bartowski/Qwen2.5-7B-Instruct-GGUF', 'id/source/repo');
  assert(qw.downloads === 845000 && qw.likes === 120 && qw.params === 7 && qw.tools === true, 'downloads, likes, params from name, tools (qwen2.5 family)');
  assert(qw.pullName === 'hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M' && qw.variants[0].estimated, 'an estimated Q4_K_M variant until files are loaded');
  assert(r.models[1].uncensored === true, 'abliterated repo flagged uncensored');
  assert(r.models[2].gated === true && r.models[0].gated === false, 'gated "manual" → gated:true; false → false');
  assert(r.models[3].params === null && r.models[3].tools === null && r.models[3].sizeBytes === null, 'unknown model: params/tools/size null');
  calls = [];
  cat = mc.createCatalog({ fetch: fakeFetch([[/huggingface/, () => res(200, '[]', true)]], calls) });
  await cat.searchHf('x');
  assert(!calls[0].init.headers.Authorization, 'no token → no Authorization header');
  cat = mc.createCatalog({ fetch: fakeFetch([[/huggingface/, () => res(200, '{"error":"x"}', true)]]) });
  r = await cat.searchHf('x');
  assert(r.ok === false && /couldn't read/.test(r.error), 'non-array answer → plain error');
  cat = mc.createCatalog({ fetch: fakeFetch([[/huggingface/, () => res(429, 'slow down')]]) });
  r = await cat.searchHf('x');
  assert(r.ok === false && /too many searches/.test(r.error), '429 → wait a minute');

  console.log('\n== hfFiles ==');
  calls = [];
  cat = mc.createCatalog({ fetch: fakeFetch([[/api\/models\/bartowski\/Qwen2\.5-7B-Instruct-GGUF\?blobs=true/, () => res(200, fx('hf-model-qwen.json'), true)]], calls), hfToken: () => 'hf_SECRETtoken123' });
  r = await cat.hfFiles('bartowski/Qwen2.5-7B-Instruct-GGUF', { hardware: HW12 });
  assert(r.ok && r.variants.length === 6, '6 GGUF variants');
  assert(r.tools === true, 'tools = the chat template mentions tools');
  assert(r.params === 7.6 && r.contextLength === 32768 && r.architecture === 'qwen2', 'params from gguf.total, context length, architecture');
  assert(r.vision === true, 'an mmproj file means it can see pictures');
  assert(r.variants.every((v) => v.fit && v.pullName.startsWith('hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF:')), 'each variant rated with an hf.co pullName');
  assert(r.pick === 'Q6_K', `best great quant on 12 GB is picked (${r.pick})`);
  assert(/split into several files/.test(r.note || ''), 'multi-part sizes come with a plain note');
  r = await cat.hfFiles('hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M');
  assert(r.ok, 'accepts an hf.co/…:QUANT name too');
  r = await cat.hfFiles('not a repo');
  assert(r.ok === false && /user\/model/.test(r.error), 'a bad repo name → plain error');
  cat = mc.createCatalog({ fetch: fakeFetch([[/huggingface/, () => res(403, 'gated')]]) });
  r = await cat.hfFiles('meta-llama/Llama-3.3-70B-Instruct-GGUF');
  assert(r.ok === false && r.gated === true && /accept its terms/.test(r.error) && /token/.test(r.error), '403 without token → accept terms + connect token');
  cat = mc.createCatalog({ fetch: fakeFetch([[/huggingface/, () => res(401, 'nope')]]), hfToken: () => 'hf_SECRETtoken123' });
  r = await cat.hfFiles('meta-llama/Llama-3.3-70B-Instruct-GGUF');
  assert(r.ok === false && /your token can't open/.test(r.error) && !r.error.includes('SECRET'), '401 with a token → plain error that never shows the token');
  cat = mc.createCatalog({ fetch: fakeFetch([[/huggingface/, () => res(404, 'missing')]]) });
  r = await cat.hfFiles('a/b');
  assert(r.ok === false && /Couldn't find that model/.test(r.error), '404 → couldn\'t find');
  cat = mc.createCatalog({ fetch: fakeFetch([[/huggingface/, () => res(200, JSON.stringify({ id: 'a/b', siblings: [{ rfilename: 'model.safetensors', size: 5 }] }), true)]]) });
  r = await cat.hfFiles('a/b');
  assert(r.ok === false && /no GGUF files/.test(r.error), 'repo without GGUF → plain error');

  console.log('\n== search(): merge, rate, rank, uncensored widening, errors ==');
  calls = [];
  const routes = [
    [/ollama\.com\/search/, () => res(200, fx('ollama-search.html'))],
    [/huggingface\.co\/api\/models\?/, () => res(200, fx('hf-search.json'), true)],
  ];
  cat = mc.createCatalog({ fetch: fakeFetch(routes, calls) });
  r = await cat.search('qwen', { sources: ['ollama', 'hf'], hardware: HW12 });
  assert(r.ok && r.errors.length === 0, 'both sources ok');
  assert(r.models.some((x) => x.source === 'ollama') && r.models.some((x) => x.source === 'hf'), 'results merged from both');
  assert(!r.models.some((x) => x.name === 'nomic-embed-text'), 'embedding-only models are left out (they can\'t chat)');
  assert(r.models.every((x) => x.fit && x.fit.label), 'every model has a fit');
  const lastFits = r.models.map((x) => x.fit.rating);
  assert(lastFits.indexOf('too-big') === -1 || lastFits.slice(lastFits.indexOf('too-big')).every((x) => x === 'too-big'), 'too-big models sort last');
  assert(r.models.some((x) => x.uncensored), 'uncensored models are never hidden in a normal search');
  calls.length = 0;
  r = await cat.search('qwen', { sources: ['ollama', 'hf'], uncensored: true, hardware: HW12 });
  assert(calls.some((c) => /abliterated/.test(c.url)) && calls.some((c) => /uncensored/.test(c.url)), 'uncensored widens the query (+abliterated, +uncensored)');
  const firstPlain = r.models.findIndex((x) => !x.uncensored && x.fit.rating !== 'too-big');
  const lastUnc = r.models.map((x) => x.uncensored && x.fit.rating !== 'too-big').lastIndexOf(true);
  assert(lastUnc >= 0 && lastUnc < firstPlain, 'with 🔓 on, runnable uncensored models rank first');
  assert(new Set(r.models.map((x) => x.id)).size === r.models.length, 'no duplicates after widening');
  r = await cat.search('qwen', { sources: ['ollama', 'hf'], toolsOnly: true, hardware: HW12 });
  assert(r.models.length && r.models.every((x) => x.tools === true), 'toolsOnly keeps only tool-capable models');
  cat = mc.createCatalog({ fetch: fakeFetch([[/huggingface\.co\/api\/models\?/, () => res(200, fx('hf-search.json'), true)]]) });
  r = await cat.search('qwen', { sources: ['ollama', 'hf'], hardware: HW12 });
  assert(r.ok && r.models.length > 0 && r.errors.length === 1 && r.errors[0].source === 'ollama', 'one source offline → the other still answers, error listed');
  assert(/Couldn't reach The Ollama library/.test(r.errors[0].message) && /internet/.test(r.errors[0].message), `plain offline message: "${r.errors[0].message}"`);
  cat = mc.createCatalog({ fetch: fakeFetch([]) });
  r = await cat.search('qwen', { hardware: HW12 });
  assert(r.ok === false && r.models.length === 0 && r.errors.length === 2, 'fully offline → ok:false with both errors, never throws');
  r = await cat.search('qwen', { sources: [] });
  assert(r.ok === false && /at least one place/.test(r.errors[0].message), 'no sources → plain message');
  r = await mc.createCatalog({ fetch: async () => { throw Object.assign(new Error('boom'), { name: 'AbortError' }); } }).searchHf('x');
  assert(r.ok === false && /took too long/.test(r.error), 'an abort → "took too long"');

  console.log('\n== timeouts against a real (silent) local server ==');
  const srv = http.createServer(() => { /* never answers */ });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  cat = mc.createCatalog({ timeoutMs: 1000, hfBase: base, ollamaBase: base });
  const t0 = Date.now();
  r = await cat.search('qwen', { hardware: HW12 });
  assert(r.ok === false && Date.now() - t0 < 4000 && r.errors.every((e) => /took too long/.test(e.message)), 'a server that never answers times out with a plain message');
  srv.closeAllConnections && srv.closeAllConnections();
  srv.close();

  console.log('\n== curated (offline) ==');
  cat = mc.createCatalog({ fetch: fakeFetch([]) });
  let list = cat.curated(HW12, {});
  assert(Array.isArray(list) && list.length >= 10, 'a rated list without any network');
  const names = list.map((x) => x.name);
  for (const n of ['qwen2.5', 'qwen3', 'llama3.1', 'llama3.2', 'mistral-nemo', 'hermes3', 'dolphin3']) assert(names.includes(n), `includes ${n}`);
  assert(list.some((x) => /abliterat/.test(x.name)), 'includes abliterated (huihui_ai) models');
  assert(list.every((x) => x.source === 'curated' && x.fit && x.variants.every((v) => v.sizeBytes > 0 && v.pullName && v.fit)), 'every entry: source curated, fit, sizes per tag');
  const q25 = list.find((x) => x.name === 'qwen2.5');
  assert(q25.pullName === 'qwen2.5:7b' && q25.fit.rating === 'great', 'qwen2.5 auto-picks 7b on 12 GB');
  assert(list[0].fit.rating === 'great', 'the best fits come first');
  assert(list.slice(-1)[0].fit.rating === 'too-big', 'too-big ones at the end');
  list = cat.curated(HW12, { uncensored: true });
  assert(list[0].uncensored && list[1].uncensored, '🔓 uncensored ranks uncensored models first');
  assert(list.some((x) => !x.uncensored), 'and still shows the others');
  const small = cat.curated(HW4, {});
  const l32 = small.find((x) => x.name === 'llama3.2');
  assert(l32.pullName === 'llama3.2:1b' && l32.fit.rating === 'great', 'on a 4 GB card llama3.2 picks the 1b (great beats good)');
  assert(l32.variants.find((v) => v.tag === 'llama3.2:3b').fit.rating === 'good', 'and its 3b is still offered as a good fit');
  assert(small.find((x) => x.name === 'llama3.3').fit.rating === 'too-big', 'llama3.3 70b is too big on a 4 GB card');
  const none = cat.curated(null, {});
  assert(none.length && none.every((x) => x.fit.rating === 'unknown'), 'no hardware → still listed, fit unknown');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
