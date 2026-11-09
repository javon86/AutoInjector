#!/usr/bin/env node
'use strict';
// test/fixtures/fake-claude-judge.js — a fake `claude` CLI for the 🧑‍⚖️ picture judge tests (Claude Code is not
// installed in CI or the sandbox). It mimics what image-judge-cc.js uses of the real one (the pattern of
// akowe/tests/fake_claude/fake_claude.py):
//   claude --version                         → "2.1.300 (Claude Code)"
//   claude -p "<instruction>" --output-format json … (prompt on stdin, the picture in the working folder)
//                                            → ONE JSON result object {"type":"result","subtype":"success","result":"<judge JSON>"}
// A 🎬 video question (the prompt says CONTACT SHEET — video-judge.js) gets the video scores instead (videoAnswer).
// Modes (env FAKE_CLAUDE_JUDGE_MODE): improving (default: every call scores higher — 5, 7, 9 …), keep (9/10),
// malformed (never JSON), malformed_once (the first answer is not JSON), logged_out, limit, slow (sleeps 30 s),
// unknown_flag (refuses --permission-mode), crash. FAKE_CLAUDE_JUDGE_STATE: a counter file (improving).
// FAKE_CLAUDE_JUDGE_LOG: a file each call appends {argv, cwdFiles, sawPicture, stdinChars, apiKey} to (JSON lines).
// makeFakeClaude(dir) → the path of an executable wrapper named claude (claude.cmd on Windows) that runs this file.
const fs = require('fs');
const path = require('path');

function makeFakeClaude(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const me = __filename;
  if (process.platform === 'win32') {
    const p = path.join(dir, 'claude.cmd');
    fs.writeFileSync(p, `@echo off\r\n"${process.execPath}" "${me}" %*\r\n`);
    return p;
  }
  const p = path.join(dir, 'claude');
  fs.writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${me}" "$@"\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

// 🎬 a video judge question (it says CONTACT SHEET): the video scores and fixes from the video vocabulary.
function videoAnswer(n, prompt) {
  const mode = process.env.FAKE_CLAUDE_JUDGE_MODE || 'improving';
  const base = mode === 'keep' ? 9 : Math.min(9.5, 3 + 2 * n);
  const s = (d) => Math.max(1, Math.min(10, Math.round((base + d) * 10) / 10));
  const i2v = /"faithful":1-10/.test(prompt);
  return {
    scores: { prompt: s(0.5), quality: s(0), consistency: s(-0.5), motion: s(-1), flicker: s(0.5), faithful: i2v ? s(0) : null },
    verdict: base >= 8 ? 'keep' : base < 4 ? 'redo' : 'fix',
    good: ['the light is right', 'the camera is steady'],
    bad: base >= 8 ? [] : ['her hands melt in frames 40–60', 'the face changes a little'],
    fixes: base >= 8 ? [] : [{ type: 'steps', delta: 4, why: 'more detail' }, { type: 'motion', amount: 'less', why: 'calmer movement' }, { type: 'negative_add', terms: ['morphing hands', 'flicker'] }, { type: 'teleport', why: 'not in the vocabulary' }],
    prompt: base >= 8 ? {} : { add: ['steady camera'], remove: [], front: [] },
  };
}

function judgeAnswer(n, prompt) {
  if (/CONTACT SHEET/.test(prompt || '')) return videoAnswer(n, prompt);
  const mode = process.env.FAKE_CLAUDE_JUDGE_MODE || 'improving';
  const base = mode === 'keep' ? 9 : Math.min(9.5, 3 + 2 * n);
  const s = (d) => Math.max(1, Math.min(10, Math.round((base + d) * 10) / 10));
  const hasChar = /should show the character/.test(prompt);
  const verdict = base >= 8 ? 'keep' : base < 4 ? 'redo' : 'fix';
  return {
    scores: { prompt: s(0.5), quality: s(0), anatomy: s(-1), artifacts: s(0), composition: s(0.5), character: hasChar ? s(0) : null },
    verdict,
    good: ['clear subject', 'nice light'],
    bad: base >= 8 ? [] : ['the hands are melted', 'a little blurry'],
    fixes: base >= 8 ? [] : [{ type: 'steps', delta: 6, why: 'more detail' }, { type: 'cfg', delta: -1, why: 'less burnt' }, { type: 'negative_add', terms: ['extra fingers', 'blurry'] }, { type: 'adetailer', target: 'face' }, { type: 'teleport', why: 'not in the vocabulary' }],
    prompt: base >= 8 ? {} : { add: ['sharp focus'], remove: [], front: [] },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--version')) { process.stdout.write('2.1.300 (Claude Code)\n'); return 0; }
  const mode = process.env.FAKE_CLAUDE_JUDGE_MODE || 'improving';
  let stdin = '';
  for await (const c of process.stdin) stdin += c;
  const cwdFiles = fs.readdirSync(process.cwd());
  const sawPicture = cwdFiles.some((f) => /^picture\.(png|jpg|webp)$/.test(f));
  if (process.env.FAKE_CLAUDE_JUDGE_LOG) {
    try { fs.appendFileSync(process.env.FAKE_CLAUDE_JUDGE_LOG, `${JSON.stringify({ argv, cwdFiles, sawPicture, stdinChars: stdin.length, apiKey: !!process.env.ANTHROPIC_API_KEY, cwd: process.cwd() })}\n`); } catch (_) {}
  }
  if (mode === 'unknown_flag' && argv.includes('--permission-mode')) { process.stderr.write("error: unknown option '--permission-mode'\n"); return 1; }
  if (mode === 'crash') return 3;
  const out = (o, code) => { process.stdout.write(JSON.stringify(Object.assign({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 900, output_tokens: 200 }, num_turns: 2 }, o))); return code || 0; };
  if (mode === 'logged_out') return out({ is_error: true, result: 'Not logged in · Please run /login' }, 1);
  if (mode === 'limit') return out({ is_error: true, result: "You've hit your session limit · resets 3pm" }, 1);
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 30000));
  let n = 1;
  const stateFile = process.env.FAKE_CLAUDE_JUDGE_STATE;
  if (stateFile) { try { n = Number(fs.readFileSync(stateFile, 'utf8')) + 1 || 1; } catch (_) { n = 1; } try { fs.writeFileSync(stateFile, String(n)); } catch (_) {} }
  if (!sawPicture) return out({ result: 'I cannot see any picture file in this folder.' });
  if (mode === 'malformed' || (mode === 'malformed_once' && !/could not be used/.test(stdin))) return out({ result: 'The picture looks nice! I would give it a 7.' });
  return out({ result: `Here is my verdict:\n\`\`\`json\n${JSON.stringify(judgeAnswer(n, stdin))}\n\`\`\`` });
}

if (require.main === module) main().then((c) => process.exit(c || 0), () => process.exit(9));
module.exports = { makeFakeClaude, judgeAnswer, videoAnswer };
