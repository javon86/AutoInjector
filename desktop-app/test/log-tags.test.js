// test/log-tags.test.js — the unified log's tag engine. Verifies there are 13
// tags, that the grouping the user asked for holds (3 AIs share "chat", the
// manager is its own tag), that representative events map correctly, and that
// EVERY real event kind the app emits resolves to a known tag (nothing dropped).
// Run: node test/log-tags.test.js
const lt = require('../log-tags');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

function main() {
  console.log('\n== 13 tags, with the required grouping ==');
  assert(lt.TAG_IDS.length === 13, `there are exactly 13 tags (got ${lt.TAG_IDS.length})`);
  assert(lt.TAG_IDS.includes('chat') && lt.TAG_IDS.includes('manager'), 'chat and manager are distinct tags');
  assert(lt.TAGS.chat && lt.TAGS.manager && lt.TAGS.chat !== lt.TAGS.manager, 'the manager is separate from chat');
  for (const id of lt.TAG_IDS) assert(lt.TAGS[id] && lt.TAGS[id].label && /^#/.test(lt.TAGS[id].color), `tag ${id} has a label + colour`);

  console.log('\n== the three AIs share "chat"; the butler is "manager" ==');
  assert(lt.tagFor('captured') === 'chat' && lt.tagFor('sent') === 'chat' && lt.tagFor('send-retry') === 'chat', 'AI sends/captures are chat');
  assert(lt.tagFor('manager-decision') === 'manager' && lt.tagFor('manager-ack') === 'manager' && lt.tagFor('manager-approval') === 'manager', 'butler reasoning is manager');

  console.log('\n== manager sub-actions get their topical tag ==');
  assert(lt.tagFor('manager-code') === 'code' && lt.tagFor('manager-tool') === 'code', 'a manager code/tool run is tagged Code & Tools');
  assert(lt.tagFor('manager-memory') === 'memory', 'a manager remember/recall is tagged Memory');
  assert(lt.tagFor('manager-image') === 'media' && lt.tagFor('manager-setup') === 'setup' && lt.tagFor('manager-file') === 'files', 'manager image/setup/file map to their tags');

  console.log('\n== representative events across every category ==');
  const cases = {
    system: ['state-restored', 'bridge-started', 'persist-error', 'this-kind-does-not-exist'],
    routing: ['routing-changed', 'endtag-missing', 'loop-suppressed'],
    roundtable: ['houserule-start', 'sequence-step-sent', 'tuner-done', 'selftest-started'],
    setup: ['setup-autowire', 'install-missing-done', 'selfcheck-installs-error'],
    models: ['ollama-managed', 'models-init'],
    voice: ['voice-config', 'voice-shim'],
    media: ['image-config', 'video-config', 'generation'],
    code: ['interpreter-shim', 'interpreter-managed-error'],
    memory: ['db-init', 'db-init-error'],
    files: ['file-attached', 'ai-download', 'logs-download-all', 'extract-all'],
    user: ['ui-click', 'ui-panel', 'prompt-saved', 'login-saved', 'zoom-changed'],
  };
  for (const [tag, kinds] of Object.entries(cases)) {
    for (const k of kinds) assert(lt.tagFor(k) === tag, `${k} -> ${tag} (got ${lt.tagFor(k)})`);
  }

  console.log('\n== EVERY real emitted kind resolves to a known tag — nothing is dropped ==');
  // The full list of logEvent kinds + manager categories the app emits today.
  const ALL_KINDS = ('ai-download ai-download-error auto-mesh-enabled bridge-start-error bridge-start-failed bridge-started ' +
    'butler-intro-sent captured compose db-init db-init-error endtag-missing endtag-missing-giveup endtag-reprompt-error ' +
    'extract-all extract-all-error file-attach-error file-attached houserule-done houserule-paused houserule-resumed ' +
    'houserule-start houserule-start-error houserule-stop image-config inspect-opened install-missing-done ' +
    'install-missing-start interpreter-managed-error interpreter-shim login-deleted login-fill-error login-fill-started ' +
    'login-saved logs-download-all logs-download-all-error loop-suppressed manager-watchdog-error menu-error ' +
    'menu-init-error models-init new-chat-all new-chat-error ollama-managed ollama-managed-error ollama-managed-skip ' +
    'output-init output-init-error participant-changed paused persist-error poll-error prompt-deleted prompt-saved ' +
    'prompt-send rate-limit-detected regenerate relay-silenced reload role-changed roundtable-skip routing-changed ' +
    'selector-override-cleared selector-pick-error selector-pick-rejected selector-pick-started selector-picked ' +
    'selfcheck-installs-error selftest-send-error selftest-started selftest-waiting-for-reply send-error send-retry sent ' +
    'sequence-done sequence-stale-capture-ignored sequence-stalled sequence-start sequence-step-sent sequence-stop ' +
    'setup-auto-done setup-auto-start setup-autowire setup-autowire-error setup-configure-error setup-install-start ' +
    'state-restored stopped tuner-done tuner-leg-error tuner-leg-ok tuner-leg-started tuner-started video-config ' +
    'voice-config voice-managed-error voice-shim window-collapse-changed zoom-changed ' +
    'manager-ack manager-action manager-approval manager-code manager-config manager-decision manager-error ' +
    'manager-escalation manager-file manager-image manager-memory manager-response manager-setup manager-task manager-tool').split(/\s+/);
  let unknown = 0;
  for (const k of ALL_KINDS) { const t = lt.tagFor(k); if (!lt.TAG_IDS.includes(t)) { unknown++; console.log(`      ! ${k} -> ${t}`); } }
  assert(unknown === 0, `all ${ALL_KINDS.length} emitted kinds map to a valid tag (${unknown} unknown)`);
  // Manager reasoning specifically stays under "manager" (not scattered away).
  assert(['manager-ack','manager-decision','manager-approval','manager-response','manager-task','manager-action','manager-config','manager-error','manager-escalation'].every((k) => lt.tagFor(k) === 'manager'),
    'the butler\'s core flow events stay under the Manager tag');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
