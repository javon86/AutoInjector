'use strict';
// fake-git.js — a stand-in for git in the 🧩 Add-ons tests (sd-addons.js). Run through a tiny
// shell wrapper the test writes (AUTOINJECTOR_GIT=<wrapper>). Understands:
//   clone [-c k=v …] --depth 1 --progress -- <url> <dest>
//       url with "missing" → "Repository not found" (exit 128); "offline" → "Could not resolve host" (128);
//       else progress lines on stderr, then <dest>/.git/config (origin = url), scripts/<repo>.py and an
//       install.py that would write RAN_INSTALL_PY if anything ever ran it (nothing should).
//   -C <dir> pull --ff-only --progress
//       <dir>/LOCAL → "would be overwritten" (exit 1); <dir>/.git/UPTODATE → "Already up to date."; else
//       writes <dir>/UPDATED and says "Fast-forward".
// Every call is appended to $FAKE_GIT_LOG (one JSON line).
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (process.env.FAKE_GIT_LOG) fs.appendFileSync(process.env.FAKE_GIT_LOG, `${JSON.stringify({ args, prompt: process.env.GIT_TERMINAL_PROMPT })}\n`);
const rest = [];
for (let i = 0; i < args.length; i++) { if (args[i] === '-c') { i++; continue; } rest.push(args[i]); }
if (rest[0] === 'clone') {
  const dd = rest.indexOf('--');
  const [url, dest] = rest.slice(dd + 1);
  if (/missing/.test(url)) { process.stderr.write(`remote: Repository not found.\nfatal: repository '${url}' not found\n`); process.exit(128); }
  if (/offline/.test(url)) { process.stderr.write(`fatal: unable to access '${url}': Could not resolve host: github.com\n`); process.exit(128); }
  process.stderr.write(`Cloning into '${dest}'...\nReceiving objects:  50% (1/2)\rReceiving objects: 100% (2/2), done.\nResolving deltas: 100% (1/1), done.\n`);
  const repo = url.replace(/\.git$/, '').split('/').pop();
  fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dest, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  fs.mkdirSync(path.join(dest, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'scripts', `${repo}.py`), '# fake add-on script\n');
  fs.writeFileSync(path.join(dest, 'install.py'), `open(${JSON.stringify(path.join(dest, 'RAN_INSTALL_PY'))}, 'w').write('ran')\n`);
  process.exit(0);
}
if (rest[0] === '-C' && rest[2] === 'pull') {
  const dir = rest[1];
  if (fs.existsSync(path.join(dir, 'LOCAL'))) { process.stderr.write('error: Your local changes to the following files would be overwritten by merge:\n\tscripts/x.py\nAborting\n'); process.exit(1); }
  if (fs.existsSync(path.join(dir, '.git', 'UPTODATE'))) { process.stdout.write('Already up to date.\n'); process.exit(0); }
  fs.writeFileSync(path.join(dir, 'UPDATED'), 'yes');
  process.stdout.write('Updating 1111111..2222222\nFast-forward\n scripts/x.py | 2 +-\n');
  process.exit(0);
}
process.stderr.write(`fake-git: unsupported ${args.join(' ')}\n`);
process.exit(2);
