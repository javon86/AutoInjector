'use strict';
/*
 * alfred-catalog.js — "❓ Everything I can do": the list his side panel shows, grouped for a person, built
 * from the SAME fixed registries Alfred uses (alfred-tools.js publicList() + alfred-app-actions.js ACTIONS),
 * so it never promises something he cannot do. Each item: a one-line plain description and an example
 * request ("▶ Try it" puts it in his input box). Read-only; main serves it on `alfred:catalog`.
 */
const registry = require('./alfred-tools');
const appActions = require('./alfred-app-actions');

const GROUPS = [
  { id: 'books', icon: '📖', title: 'Books' },
  { id: 'characters', icon: '🧑', title: 'Characters & world' },
  { id: 'pictures', icon: '🎨', title: 'Pictures & covers' },
  { id: 'video', icon: '🎬', title: 'Video' },
  { id: 'ais', icon: '💬', title: 'The three AIs' },
  { id: 'brain', icon: '🧠', title: 'His AI & setup' },
  { id: 'files', icon: '📁', title: 'Files & folders' },
  { id: 'app', icon: '⚙', title: 'App settings & tools' },
];

// Tools → group (default: by the tool's own group) and an example request in plain words.
const TOOL_GROUP = {
  edit_character: 'characters', add_world_detail: 'characters', character_dossier: 'characters', forge_character: 'characters',
  approve_dossier: 'characters', edit_dossier: 'characters', make_character_art: 'characters', create_dossier: 'characters',
  check_dossier: 'characters', character_locks: 'characters',
  book_pictures: 'pictures', set_art_style: 'pictures', illustrate: 'pictures', edit_picture: 'pictures', book_map: 'pictures',
  book_cover: 'pictures', design_cover: 'pictures', make_cover_art: 'pictures',
  images: 'pictures', sd_call: 'pictures', video: 'video', ais: 'ais', files: 'files', code: 'app',
};
const TOOL_EXAMPLE = {
  book_status: "What's the status of my book?",
  list_books: 'Which books do I have?',
  start_book: 'Make a book for me: a lighthouse keeper finds a door under the sea.',
  pause_run: 'Pause the book run.',
  resume_run: 'Continue my book — resume the "Make a book for me" run.',
  cancel_run: 'Cancel the book run.',
  edit_profile: 'Change my book\'s genre to cosy mystery.',
  edit_character: 'Make Mara\'s voice card say she speaks in short, dry sentences.',
  add_story_rule: 'Add a story rule: magic always costs a memory.',
  add_world_detail: 'Add a world detail: the harbour town is called Saltmere.',
  rewrite_chapter: 'Ask for a rewrite of chapter 2 with more tension.',
  open_akowe_page: 'Open the characters page of my book.',
  character_dossier: 'Show me Mara\'s character dossier.',
  forge_character: 'Invent the rest of Mara\'s dossier.',
  approve_dossier: 'Approve all of Mara\'s proposals.',
  edit_dossier: 'In Mara\'s dossier, set her eye colour to grey.',
  make_character_art: 'Make Mara\'s portrait.',
  create_dossier: 'Start a character dossier for Mara, the lighthouse keeper.',
  check_dossier: 'Check Mara\'s dossier against the chapters.',
  book_pictures: 'Which chapters of my book have pictures?',
  set_art_style: 'Set the book\'s art style to soft watercolour.',
  illustrate: 'Illustrate chapter 1 of my book.',
  edit_picture: 'Change the caption of the first picture in chapter 1.',
  book_map: 'Make the map for my book.',
  book_cover: 'How does my book cover look now?',
  design_cover: 'Design my cover: dark blue background, gold title.',
  make_cover_art: 'Make the cover art: a lighthouse in a storm.',
  make_book_report: 'Make the book report.',
  save_book: 'Save my book.',
  generate_image: 'Make a picture of a lighthouse at dusk.',
  list_images: 'Show me my latest pictures.',
  image_generator_status: 'Is the picture maker running?',
  start_image_generator: 'Start Stable Diffusion.',
  stop_image_generator: 'Stop Stable Diffusion.',
  find_models: 'Find a watercolour LoRA in my model library.',
  character_locks: 'Which character locks do I have?',
  sd_call: 'Make 4 pictures of a castle, 768×512, 30 steps.',
  video_status: 'Is video making set up?',
  generate_video: 'Make a short video of waves hitting a lighthouse.',
  video_call: 'Bring my latest picture to life as a short clip.',
  send_to_ai: 'Ask Claude to suggest three titles for my book.',
  read_latest_reply: 'What did Gemini answer last?',
  ai_health: 'Are the three AIs working?',
  run_checkin: 'Check on the three AIs now.',
  list_outputs: 'What files has the app made lately?',
  open_output: 'Open the last picture you made.',
  export_logs: 'Save today\'s logs to a file.',
  run_code: 'Use Open Interpreter to count the words in my book export.',
  app_help: 'What app controls are there for routing?',
};
// Plain words where the tool's own description is written for the AI rather than for you.
const TOOL_SAY = {
  sd_call: 'Any picture setting the 🎨 Images tab has: size, steps, sampler, model, LoRAs, several at once, picture-to-picture, upscale.',
  video_call: 'Any 🎬 Video tab control: make a clip from words, bring a picture to life, models, progress, cancel.',
  open_akowe_page: 'Show a page of your book in the 📖 Akọwe tab (checklist, report, scene grid, journal, world, characters, pictures, cover).',
  character_dossier: 'Read a character\'s dossier: what is filled in, what is proposed, the portrait and the views.',
  make_character_art: 'Draw a character: the portrait, the ten reference views, a turnaround sheet, or a short moving clip.',
  create_dossier: 'Start a dossier for a character, an item, a place or a magic system.',
  edit_picture: 'Change one book picture: caption, where it sits in the chapter, which candidate is used, or remove it.',
  book_cover: 'Read the cover design: template, texts, colours, art and the print settings.',
  design_cover: 'Change the cover: template, title / author texts, colours, back-cover blurb, print size.',
  make_cover_art: 'Make the cover picture (the designer adds the lettering).',
  app_help: 'Explain what one of the app\'s controls does and what it needs.',
};
const SKIP_TOOLS = new Set(['app_info', 'app_control']); // their actions are listed one by one below

function actionGroup(id) {
  const p = id.split('.')[0];
  if (/^(send|routing|relay|participants|roles|sites|site|transcript|ledger|houserule|sequence|prompts|selftest|tuner|brigade|featuretest|feed)$/.test(p)) return 'ais';
  if (id === 'health.check' || id === 'health.get') return 'ais';
  if (/^(health|llm|ollama|setup|wizard|voice|endpoints|gpu)$/.test(p)) return 'brain';
  if (/^(lockers|db|models|logs|folders|content)$/.test(p)) return 'files';
  if (/^(akowe|akowe_server|akowe_view)$/.test(p)) return 'books';
  if (/^(image|sd|sdlib)$/.test(p)) return 'pictures';
  if (p === 'video') return 'video';
  return 'app';
}
const SITE_WORD = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' };
function exampleWords(ex) {
  const parts = [];
  for (const [k, v] of Object.entries(ex || {})) {
    if (v == null || typeof v === 'object' && !Array.isArray(v)) continue;
    const w = Array.isArray(v) ? v.map((x) => SITE_WORD[x] || x).join(' and ') : typeof v === 'boolean' ? `${k} ${v ? 'on' : 'off'}` : (SITE_WORD[v] || String(v));
    if (w) parts.push(w);
  }
  return parts.join(', ').slice(0, 120);
}
function firstSentence(t) {
  const s = String(t || '').replace(/\s+/g, ' ').replace(/\be\.g\./g, 'e.g').replace(/\bi\.e\./g, 'i.e').trim();
  const m = s.match(/^(.{20,}?[.!?])(\s|$)/);
  const out = m ? m[1] : s;
  return out.length > 170 ? `${out.slice(0, 167)}…` : out;
}
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const plainTitle = (t) => cap(String(t || '').replace(/^Character Forge: /, '').replace(/^Book pictures: /, 'Pictures: ').replace(/^Book cover: /, 'Cover: '));

/** The grouped list. opts.interpreter: include Open Interpreter (only when it is turned on). */
function build(opts = {}) {
  const by = new Map(GROUPS.map((g) => [g.id, []]));
  for (const t of registry.publicList({ interpreter: !!opts.interpreter })) {
    if (SKIP_TOOLS.has(t.name)) continue;
    const g = TOOL_GROUP[t.name] || TOOL_GROUP[t.group] || (by.has(t.group) ? t.group : 'app');
    by.get(g).push({ id: t.name, kind: 'tool', title: plainTitle(t.title), say: TOOL_SAY[t.name] || firstSentence(t.description), example: TOOL_EXAMPLE[t.name] || `${t.title}.`, changes: !!t.changes });
  }
  for (const a of appActions.ACTIONS) {
    const words = exampleWords(a.example);
    by.get(actionGroup(a.id)).push({ id: a.id, kind: 'control', title: a.title, say: `${a.title}${a.changes ? '' : ' (just looks)'}.`, example: `${a.title}${words ? ` — ${words}` : ''}.`, changes: !!a.changes });
  }
  const groups = GROUPS.map((g) => Object.assign({}, g, { items: by.get(g.id) })).filter((g) => g.items.length);
  return { ok: true, groups, count: groups.reduce((n, g) => n + g.items.length, 0) };
}

module.exports = { build, GROUPS, TOOL_EXAMPLE };
