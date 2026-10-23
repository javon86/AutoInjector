// test/pane-layout.test.js — ISS-001: native AI panes must never cover the
// sticky User Panel or an open dialog. Run: node test/pane-layout.test.js
const { clipPaneRects, MIN_PANE_VISIBLE } = require('../pane-layout');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const R = (x, y, width, height) => ({ x, y, width, height });

console.log('\n== clipPaneRects ==');
let o = clipPaneRects({ claude: R(10, 300, 400, 280), __top: 212, __bottom: 1000, __modal: false });
assert(JSON.stringify(o.claude) === JSON.stringify(R(10, 300, 400, 280)), 'a pane fully below the User Panel is untouched');

o = clipPaneRects({ claude: R(10, 100, 400, 280), __top: 212, __bottom: 1000 });
assert(o.claude.y === 212 && o.claude.height === 168, `a pane scrolled under the panel is clipped to start below it (${JSON.stringify(o.claude)})`);

o = clipPaneRects({ claude: R(10, 0, 400, 230), __top: 212, __bottom: 1000 });
assert(o.claude === null, `a pane with < ${MIN_PANE_VISIBLE}px left visible is hidden`);

o = clipPaneRects({ claude: R(10, 900, 400, 280), __top: 212, __bottom: 1000 });
assert(o.claude.height === 100, 'a pane running off the bottom of the window is clipped to the window');

o = clipPaneRects({ claude: R(10, 300, 400, 280), gemini: R(420, 300, 400, 280), __top: 212, __bottom: 1000, __modal: true });
assert(o.claude === null && o.gemini === null, 'every pane is hidden while a dialog is open');

o = clipPaneRects({ claude: null, __top: 0 });
assert(o.claude === null && !('__top' in o), 'missing slot -> null; the __ keys are not treated as panes');
assert(JSON.stringify(clipPaneRects(null)) === '{}', 'no measurement -> nothing placed');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
