'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/quality-check.js'), 'utf8').replace(/main\(\);\s*$/, '');
let result;
const messages = [];
const context = { require(name) { if (name === 'child_process') return { spawnSync: () => result }; return require(name); }, __dirname: path.join(__dirname, '../scripts'), process, console: { log: (...args) => messages.push(args.join(' ')) } };
vm.createContext(context);
vm.runInContext(source, context);
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok - ' + name); }
check('nonzero exit cannot be green despite passing summary', () => {
 result = { status: 1, stdout: '5 passed, 0 failed' };
 assert.strictEqual(context.layerLine('test', context.runNodeFiles(['fixture.js'])), 'FAIL');
});
check('timeout cannot produce PASS', () => {
 result = { status: null, error: { code: 'ETIMEDOUT' } };
 assert.notStrictEqual(context.layerLine('test', context.runNodeFiles(['fixture.js'])), 'PASS');
});
check('wrapper command actually used', () => {
 context.require = (name) => name === 'child_process' ? { spawnSync: () => result } : require(name);
 result = { status: 0, stdout: '5 passed, 0 failed' };
 assert.strictEqual(context.layerLine('test', context.runNodeFiles(['fixture.js'])), 'PASS');
});
console.log(`${passed} passed, 0 failed`);
