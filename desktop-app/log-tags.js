'use strict';
/*
 * log-tags.js — the single source of truth for the unified activity log's tags.
 *
 * Every event the program emits (a logEvent kind, or a manager-<category>) maps
 * to exactly ONE of 13 tags, so the one bottom log window can catch everything
 * and let the user show/hide whole categories. Shared by main (tag at the
 * source), the renderer (chips + filters), and the tests — one list, no drift.
 *
 * Grouping rules the user asked for: the three web AIs share ONE "chat" tag;
 * the local manager/butler is its OWN "manager" tag, separate from chat.
 */

// id → { label, color }. Order here is the order the filter chips render in.
const TAGS = {
  system:  { label: 'System',      color: '#8a94a6' },
  chat:    { label: 'Chat',        color: '#57c07a' },
  manager: { label: 'Manager',     color: '#8ef0b0' },
  routing: { label: 'Routing',     color: '#e0a24a' },
  roundtable: { label: 'Roundtable', color: '#e07a4a' },
  setup:   { label: 'Setup',       color: '#4ac0c0' },
  models:  { label: 'Models',      color: '#6ea8ff' },
  voice:   { label: 'Voice',       color: '#e06ea8' },
  media:   { label: 'Image/Video', color: '#c06ee0' },
  code:    { label: 'Code & Tools', color: '#9ad14a' },
  memory:  { label: 'Memory',      color: '#a98cff' },
  files:   { label: 'Files',       color: '#d0a878' },
  user:    { label: 'You (UI)',    color: '#b0b6c0' },
};

const TAG_IDS = Object.keys(TAGS);

// Exact-kind overrides where a prefix rule would send it to the wrong bucket.
const EXACT = {
  // System lifecycle / infra
  'state-restored': 'system', 'output-init': 'system', 'output-init-error': 'system',
  'bridge-started': 'system', 'bridge-start-error': 'system', 'bridge-start-failed': 'system',
  'menu-error': 'system', 'menu-init-error': 'system', 'persist-error': 'system',
  'poll-error': 'system', 'paused': 'system', 'stopped': 'system',
  // Chat — the three web AIs
  'captured': 'chat', 'sent': 'chat', 'send-error': 'chat', 'send-retry': 'chat',
  'compose': 'chat', 'rate-limit-detected': 'chat',
  // Routing / relay between AIs
  'routing-changed': 'routing', 'relay-silenced': 'routing', 'loop-suppressed': 'routing',
  'endtag-missing': 'routing', 'endtag-missing-giveup': 'routing', 'endtag-reprompt-error': 'routing',
  'participant-changed': 'routing', 'auto-mesh-enabled': 'routing', 'roundtable-skip': 'roundtable',
  // Models / Ollama
  'models-init': 'models',
  // Media
  'image-config': 'media', 'video-config': 'media', 'generation': 'media',
  // Code & Tools (Open Interpreter backend)
  'interpreter-shim': 'code', 'interpreter-managed-error': 'code',
  // Memory / database
  'db-init': 'memory', 'db-init-error': 'memory',
  // Files
  'file-attached': 'files', 'file-attach-error': 'files', 'ai-download': 'files', 'ai-download-error': 'files',
  'logs-download-all': 'files', 'logs-download-all-error': 'files', 'extract-all': 'files', 'extract-all-error': 'files',
  // You (UI)
  'ui-click': 'user', 'ui-panel': 'user', 'role-changed': 'user', 'reload': 'user',
  'regenerate': 'user', 'inspect-opened': 'user', 'new-chat-all': 'user', 'new-chat-error': 'user',
  'zoom-changed': 'user', 'window-collapse-changed': 'user',
};

// Manager sub-categories that belong to a topical tag instead of "manager".
const MANAGER_CATEGORY_TAG = {
  code: 'code', tool: 'code', memory: 'memory', image: 'media', file: 'files', setup: 'setup',
};

// Prefix rules (checked after EXACT). First match wins, longest-first below.
const PREFIX = [
  ['manager-', (k) => MANAGER_CATEGORY_TAG[k.slice('manager-'.length)] || 'manager'],
  ['houserule-', () => 'roundtable'],
  ['sequence-', () => 'roundtable'],
  ['tuner-', () => 'roundtable'],
  ['selftest-', () => 'roundtable'],
  ['setup-', () => 'setup'],
  ['install-missing', () => 'setup'],
  ['selfcheck-', () => 'setup'],
  ['ollama-', () => 'models'],
  ['voice-', () => 'voice'],
  ['interpreter-', () => 'code'],
  ['prompt-', () => 'user'],
  ['login-', () => 'user'],
  ['selector-', () => 'user'],
];

/**
 * Map an event kind (logEvent kind, or "manager-<category>") to a tag id.
 * Unknown kinds fall back to "system" so nothing is ever dropped.
 */
function tagFor(kind) {
  const k = String(kind || '').trim();
  if (!k) return 'system';
  if (EXACT[k]) return EXACT[k];
  for (const [pre, fn] of PREFIX) { if (k.startsWith(pre)) return fn(k); }
  return 'system';
}

module.exports = { TAGS, TAG_IDS, tagFor };
