'use strict';
/*
 * image-views.js — the words for character REFERENCE pictures (Akọwe's Character
 * Forge, the 🎨 Images tab's "Reference views" helper, Alfred), shared by both
 * image engines:
 *   • Stable Diffusion (sd-studio.js): the view phrase goes into the prompt, plus a
 *     few "character reference" words and a negative that keeps the whole body in
 *     frame; views are tall, a sheet is wide; one seed is kept across a series.
 *   • ChatGPT (chatgpt-image.js): the same framing written as a plain request,
 *     "Create an image: …", sent to the logged-in ChatGPT pane.
 *
 * purpose "view"  + view  → one full-body reference view (VIEW_IDS)
 * purpose "sheet"         → ONE wide turnaround sheet with all ten views
 * Contract: /home/user/moki/CONTRACT.md §1 → docs/SD_IMAGE_API.md.
 * Pure and dependency-free (unit-tested in test/chatgpt-image.test.js).
 */

const VIEW_IDS = ['front', 'three_quarter_front', 'side', 'three_quarter_back', 'back', 'idle', 'draw', 'attack', 'dash', 'defend'];
const VIEW_LABELS = {
  front: 'Front', three_quarter_front: '¾ front', side: 'Side', three_quarter_back: '¾ back', back: 'Back',
  idle: 'Idle', draw: 'Draw (tool at the belt)', attack: 'Attack (empty hand)', dash: 'Dash', defend: 'Defend',
};
const BACKDROP = 'plain neutral light-grey studio background, even soft lighting, no text';
// One phrase per view: what the camera sees and what the body does.
const VIEW_PHRASES = {
  front: `full body, head to toe, standing upright, seen exactly from the front, facing the viewer, arms relaxed at the sides, ${BACKDROP}`,
  three_quarter_front: `full body, head to toe, standing upright, seen from a three-quarter front angle (turned about 45 degrees from the viewer), ${BACKDROP}`,
  side: `full body, head to toe, standing, seen exactly from the side (profile), ${BACKDROP}`,
  three_quarter_back: `full body, head to toe, standing upright, seen from a three-quarter back angle (turned away, the back and one side visible), ${BACKDROP}`,
  back: `full body, head to toe, standing upright, seen exactly from behind (back view, face not visible), ${BACKDROP}`,
  idle: `full body, head to toe, relaxed idle stance, weight on one leg, natural resting pose, seen from a three-quarter front angle, ${BACKDROP}`,
  draw: `full body, head to toe, reaching for a tool at the belt, one hand on it about to draw it, seen from a three-quarter front angle, ${BACKDROP}`,
  attack: `full body, head to toe, mid-strike empty-hand attack (a punch thrown forward), dynamic pose, no weapon, seen from a three-quarter front angle, ${BACKDROP}`,
  dash: `full body, head to toe, dashing forward at speed, leaning into the run, one foot off the ground, seen from the side, ${BACKDROP}`,
  defend: `full body, head to toe, defensive guard stance, forearms raised to block, feet braced, seen from a three-quarter front angle, ${BACKDROP}`,
};
const SHEET_PHRASE = 'character turnaround sheet: the same character shown ten times in a 5×2 grid: front, 3/4 front, side, 3/4 back, back, idle, reaching for a tool, empty-hand attack, dash, defend; plain light-grey background; consistent outfit and proportions; no text labels';
const PORTRAIT_PHRASE = 'character portrait, head and shoulders, looking at the viewer, soft studio lighting, plain neutral background, no text';

// Stable Diffusion extras (only where they help: views and sheets).
const SD_VIEW_WORDS = 'character reference, solo, full body visible';
const SD_SHEET_WORDS = 'character turnaround sheet, character reference sheet, multiple views of the same character, same outfit, consistent proportions, grid layout, plain light grey background';
const SD_VIEW_NEGATIVE = 'cropped, out of frame, cut off feet, cut off head, multiple people, text, watermark, busy background';
const SD_SHEET_NEGATIVE = 'text, labels, watermark, different outfits, busy background';

function isView(v) { return VIEW_IDS.includes(String(v || '')); }
function viewPhrase(v) { return VIEW_PHRASES[v] || ''; }

// Width × height for a view / a sheet on a model family (multiples of 64).
function sdSize(purpose, base) {
  const big = ['SDXL', 'Pony', 'Illustrious', 'NoobAI', 'Flux', 'SD3'].includes(base);
  if (purpose === 'sheet') return big ? { width: 1536, height: 768 } : { width: 1024, height: 512 };
  return big ? { width: 832, height: 1216 } : { width: 512, height: 768 }; // a view: tall, the whole body fits
}

// The Stable Diffusion prompt / negative for a view or a sheet. `prompt` is what
// the caller wrote (already with the lock's trigger words in front of it).
function sdPrompt({ prompt, purpose, view }) {
  const p = String(prompt || '').trim();
  if (purpose === 'sheet') return { prompt: [SD_SHEET_WORDS, p, 'front view, three-quarter view, side view, back view, action poses'].filter(Boolean).join(', '), negative: SD_SHEET_NEGATIVE };
  if (purpose === 'view' && isView(view)) return { prompt: [p, viewPhrase(view), SD_VIEW_WORDS].filter(Boolean).join(', '), negative: SD_VIEW_NEGATIVE };
  return { prompt: p, negative: '' };
}
function mergeNegative(a, b) { return [String(a || '').trim(), String(b || '').trim()].filter(Boolean).join(', '); }

// Who / what to draw, in words, for ChatGPT: the lock's character + looks, the
// typed appearance and the request's own prompt.
function describeSubject({ character, looks, appearance, prompt }) {
  const bits = [];
  if (character) bits.push(String(character).trim());
  const look = [looks, appearance].map((x) => String(x || '').trim()).filter(Boolean).join('; ');
  if (look) bits.push(character ? `(${look})` : look);
  const p = String(prompt || '').trim();
  if (p) bits.push(bits.length ? `— ${p}` : p);
  return bits.join(' ').trim();
}

// The message typed into ChatGPT. Always clearly an image request, one picture,
// no questions back. For a view series in one chat it asks to keep the character.
function chatgptPrompt({ subject, purpose, view }) {
  const s = String(subject || '').trim() || 'the character';
  const tail = 'Make exactly one picture. Do not ask me questions first — just draw it.';
  if (purpose === 'sheet') return `Create one wide image: ${SHEET_PHRASE}. The character: ${s}. ${tail}`;
  if (purpose === 'view' && isView(view)) {
    return `Create an image: ${s}. Framing: ${viewPhrase(view)}. If you drew this character earlier in this chat, keep them exactly the same (same face, hair, outfit, colours and proportions). ${tail}`;
  }
  if (purpose === 'portrait') return `Create an image: ${PORTRAIT_PHRASE}, of ${s}. ${tail}`;
  if (purpose === 'cover') return `Create an image in a tall book-cover format: ${s}. ${tail}`;
  if (purpose === 'scene' || purpose === 'illustration') return `Create a wide image: ${s}. ${tail}`;
  return `Create an image: ${s}. ${tail}`;
}

module.exports = { VIEW_IDS, VIEW_LABELS, VIEW_PHRASES, SHEET_PHRASE, PORTRAIT_PHRASE, SD_VIEW_NEGATIVE, SD_SHEET_NEGATIVE, isView, viewPhrase, sdSize, sdPrompt, mergeNegative, describeSubject, chatgptPrompt };
