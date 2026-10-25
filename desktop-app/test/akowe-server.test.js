// test/akowe-server.test.js — AutoInjector runs Akọwe's server itself (akowe-server.js):
// start + health wait, reuse of a hand-started Akọwe, crash restart with backoff and a
// limit, clean stop on quit, Python missing, the Windows venv bootstrap, busy ports and a
// server that never answers. Child processes, Python checks and pings are all fakes.
// Run with: node test/akowe-server.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const srv = require("../akowe-server");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await sleep(5); }
  return !!fn();
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "akowe-server-"));
const TOKEN = "tok_ABCdef-123_xyz";

// A fake Python child process: prints Akọwe's start line on request, exits when killed
// (unless told to ignore SIGINT), or crashes when the test says so.
class FakeChild extends EventEmitter {
  constructor(cmd, args, opts) {
    super();
    this.cmd = cmd; this.args = args; this.opts = opts;
    this.stdout = new EventEmitter(); this.stderr = new EventEmitter();
    this.pid = 1000 + Math.floor(Math.random() * 1000);
    this.kills = [];
    this.ignoreSigint = false;
    this.exited = false;
  }
  port() { const i = this.args.indexOf("--port"); return Number(this.args[i + 1]); }
  say(text) { this.stdout.emit("data", Buffer.from(text + "\n")); }
  exit(code, signal) { if (this.exited) return; this.exited = true; this.emit("exit", code, signal || null); }
  kill(sig) {
    this.kills.push(sig || "SIGTERM");
    if (sig === "SIGINT" && this.ignoreSigint) return true;
    setTimeout(() => this.exit(null, sig || "SIGTERM"), 5);
    return true;
  }
}

// The fake world: which ports answer /api/ping, which are free, what python answers.
function world(over) {
  const w = Object.assign({
    live: {},          // port -> ping answer (object) for an already-running Akọwe
    busy: new Set(),   // ports something else listens on
    pythonOk: true, pythonVersion: "3.12.4", jsonschema: true, pipOk: true, venvOk: true,
    exists: new Set(), files: {},
    children: [], execCalls: [], logs: [], states: [], timers: [],
    autoAnswer: true,  // a spawned server starts answering (and prints its link) on its own
  }, over || {});
  w.spawn = (cmd, args, opts) => {
    const c = new FakeChild(cmd, args, opts);
    w.children.push(c);
    if (w.autoAnswer) setTimeout(() => {
      if (c.exited) return;
      c.say("Akọwe 1.0 running. Data: /data");
      c.say(`Open: http://127.0.0.1:${c.port()}/#token=${TOKEN}`);
      w.live[c.port()] = { app: "akowe", version: "1.0" };
    }, 10);
    c.on("exit", () => { delete w.live[c.port()]; });
    return c;
  };
  w.ping = async (port, challenge) => {
    const a = w.live[port];
    if (!a) return null;
    const out = Object.assign({}, a);
    if (challenge && a.token) out.proof = srv.pingProof(a.token, challenge);
    delete out.token;
    return out;
  };
  w.portFree = async (port) => (port === 0 ? 45678 : !w.busy.has(port) && !w.live[port]);
  w.execFile = (cmd, args, opts, cb) => {
    w.execCalls.push([cmd, ...args].join(" "));
    const a = args.join(" ");
    setTimeout(() => {
      if (a.includes("sys.version_info")) {
        if (!w.pythonOk) return cb(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), "", "");
        return cb(null, w.pythonVersion + "\n", "");
      }
      if (a.includes("import jsonschema")) return w.jsonschema ? cb(null, "", "") : cb(Object.assign(new Error("x"), { code: 1 }), "", "ModuleNotFoundError");
      if (a.includes("-m pip install")) { if (w.pipOk) { w.jsonschema = true; return cb(null, "", ""); } return cb(Object.assign(new Error("x"), { code: 1 }), "", "no internet"); }
      if (a.includes("-m venv")) {
        if (!w.venvOk) return cb(Object.assign(new Error("x"), { code: 1 }), "", "venv failed");
        const target = args[args.indexOf("venv") + 1];
        w.exists.add(path.win32.join(target, "Scripts", "python.exe"));
        w.exists.add(path.join(target, "bin", "python"));
        return cb(null, "", "");
      }
      cb(null, "", "");
    }, 1);
  };
  return w;
}
function manager(w, over) {
  return srv.createServerManager(Object.assign({
    app: { dir: "/apps/akowe", module: "akowe" },
    platform: "linux",
    env: { AUTOINJECTOR_AKOWE_PYTHON: "python3", HOME: "/home/u" },
    spawn: w.spawn, execFile: w.execFile, ping: w.ping, portFree: w.portFree,
    exists: (f) => w.exists.has(f), readFile: (f) => { if (f in w.files) return w.files[f]; throw new Error("ENOENT"); },
    rename: () => { throw new Error("no rename in tests"); },
    logger: (kind, detail) => w.logs.push({ kind, detail }),
    onChange: (st) => w.states.push(st.phase),
    healthPollMs: 5, healthTimeoutMs: 1500, tokenWaitMs: 200, pingTimeoutMs: 50,
    backoffMs: [20, 40, 80], maxRestarts: 3, stableMs: 100000, stopGraceMs: 60, reuseWatchMs: 0,
  }, over || {}));
}
const kinds = (w) => w.logs.map((l) => l.kind);

(async () => {
  console.log("== helpers ==");
  {
    assert(srv.redact("Open: http://127.0.0.1:8780/#token=abc_DEF-1") === "Open: http://127.0.0.1:8780/#token=<hidden>", "redact hides the token in a start link");
    assert(srv.redact("Authorization: Bearer s3cr3t") === "Authorization: Bearer <hidden>", "redact hides a bearer key");
    const sl = srv.parseStartLink("Open: http://127.0.0.1:8791/#token=abc_DEF-1");
    assert(sl && sl.port === 8791 && sl.token === "abc_DEF-1", "parseStartLink reads port and token from Akọwe's Open: line");
    assert(srv.parseStartLink("Akọwe is running") === null, "…and nothing from other lines");
    const d = tmp();
    fs.mkdirSync(path.join(d, "akowe", "akowe"), { recursive: true });
    fs.writeFileSync(path.join(d, "akowe", "akowe", "__main__.py"), "");
    fs.mkdirSync(path.join(d, "desktop-app"));
    const f = srv.findAppDir(path.join(d, "desktop-app"));
    assert(f && f.dir === path.join(d, "akowe") && f.module === "akowe", "findAppDir finds ../akowe next to desktop-app");
    const old = tmp();
    fs.mkdirSync(path.join(old, "bookforge", "bookforge"), { recursive: true });
    fs.writeFileSync(path.join(old, "bookforge", "bookforge", "__main__.py"), "");
    const g = srv.findAppDir(path.join(old, "desktop-app"));
    assert(g && g.module === "bookforge", "…and the ../bookforge of a checkout from before the rename");
    assert(srv.findAppDir(path.join(tmp(), "desktop-app")) === null, "…and null when there is none");
    const h = srv.appHomes("win32", { LOCALAPPDATA: "C:\\Users\\A\\AppData\\Local" });
    assert(h.home === "C:\\Users\\A\\AppData\\Local\\Akowe" && srv.venvPython(h.home, "win32") === "C:\\Users\\A\\AppData\\Local\\Akowe\\venv\\Scripts\\python.exe", "Windows: the launcher's venv at %LOCALAPPDATA%\\Akowe\\venv");
    assert(srv.dataDirCandidates("linux", { AKOWE_DATA: "/d" })[0] === "/d", "AKOWE_DATA is where the access token is looked for first");
  }

  console.log("\n== start: a free port, health wait, start link ==");
  {
    const w = world();
    const m = manager(w);
    const st = await m.start();
    assert(st.phase === "running" && st.ready && st.owned, `the server runs and is ours (${st.phase})`);
    const c = w.children[0];
    assert(w.children.length === 1 && c.cmd === "python3", "one Python process was started");
    assert(c.args.join(" ") === "-m akowe --no-browser --host 127.0.0.1 --port 8780", `with python -m akowe --no-browser on 127.0.0.1 (${c.args.join(" ")})`);
    assert(c.opts.cwd === "/apps/akowe" && c.opts.windowsHide === true && c.opts.env.PYTHONUNBUFFERED === "1", "from Akọwe's folder, hidden, unbuffered");
    assert(st.port === 8780 && st.base === "http://127.0.0.1:8780/", "on the usual port 8780");
    assert(m.startLink() === `http://127.0.0.1:8780/#token=${TOKEN}`, "the start link carries the access token (signed in)");
    assert(!JSON.stringify(st).includes(TOKEN), "status() never contains the token");
    assert(!JSON.stringify(w.logs).includes(TOKEN), "the log events never contain the token");
    assert(kinds(w).includes("start") && kinds(w).includes("ready"), `start and ready are logged (${kinds(w).join(",")})`);
    assert(w.states.includes("checking") && w.states.includes("starting"), "phases: checking → starting → running");
    await m.stop();
  }

  console.log("\n== port busy → the next free port ==");
  {
    const w = world({ busy: new Set([8780, 8781]) });
    const m = manager(w);
    const st = await m.start();
    assert(st.ready && st.port === 8782 && w.children[0].port() === 8782, `8780 and 8781 busy → port ${st.port}`);
    await m.stop();
  }

  console.log("\n== an Akọwe started by hand is reused, never a second one ==");
  {
    const w = world();
    w.live[8781] = { app: "akowe", version: "0.9", token: TOKEN };
    const env = { AUTOINJECTOR_AKOWE_PYTHON: "python3", HOME: "/home/u", XDG_DATA_HOME: "/xdg" };
    w.files[path.join("/xdg", "akowe", "local_token")] = TOKEN + "\n";
    const m = manager(w, { env });
    const st = await m.start();
    assert(st.ready && !st.owned && st.port === 8781 && st.version === "0.9", "the running Akọwe on 8781 is used");
    assert(w.children.length === 0 && !w.execCalls.length, "no Python was looked for or started");
    assert(m.startLink() === `http://127.0.0.1:8781/#token=${TOKEN}`, "its token was read from the data folder (the ping proof matched)");
    assert(kinds(w).includes("reuse"), "reuse is logged");
    await m.stop();
    assert(w.live[8781], "stop() leaves a hand-started Akọwe running");

    const w2 = world();
    w2.live[8780] = { app: "akowe", version: "0.9", token: "someone-elses-token" };
    w2.files[path.join("/xdg", "akowe", "local_token")] = TOKEN;
    const m2 = manager(w2, { env });
    const st2 = await m2.start();
    assert(st2.ready && !st2.hasToken && m2.startLink() === "http://127.0.0.1:8780/", "a token that doesn't prove itself is not used (no link with a wrong key)");
    assert(/different data folder/.test(st2.message || ""), "…and the reason is said in plain words");
  }

  console.log("\n== crash → restart with backoff, then stop trying ==");
  {
    const w = world();
    const delays = [];
    const m = manager(w, { setTimeout: (fn, ms) => { if (ms >= 20) delays.push(ms); return setTimeout(fn, ms); } });
    await m.start();
    w.children[0].exit(1);
    assert(m.status().phase === "restarting" && m.status().restarts === 1, "a crash → restarting (1)");
    assert(await waitFor(() => w.children.length === 2 && m.status().phase === "running"), "…and it runs again");
    assert(w.children[1].port() === 8780, "on the same port");
    w.children[1].exit(1);
    assert(await waitFor(() => w.children.length === 3 && m.status().phase === "running"), "second crash → started again");
    w.children[2].exit(1);
    assert(await waitFor(() => w.children.length === 4 && m.status().phase === "running"), "third crash → started again");
    w.children[3].exit(1);
    await sleep(30);
    const st = m.status();
    assert(st.phase === "failed" && st.error === "CRASHED" && w.children.length === 4, `the 4th crash in a row → failed CRASHED, no more restarts (${st.phase} ${st.error})`);
    assert(/Try again/.test(st.message), "the notice offers Try again");
    const restartDelays = w.logs.filter((l) => l.kind === "restart").map((l) => l.detail.in_ms);
    assert(JSON.stringify(restartDelays) === "[20,40,80]", `backoff grows: ${restartDelays}`);
    assert(kinds(w).filter((k) => k === "crash").length === 4, "each crash is logged");
    await m.retry();
    assert(m.status().phase === "running" && m.status().restarts === 0 && w.children.length === 5, "Try again starts it once more with a fresh count");
    await m.stop();
  }

  console.log("\n== a long-stable server resets the crash count ==");
  {
    const w = world();
    const m = manager(w, { stableMs: 30 });
    await m.start();
    w.children[0].exit(1);
    assert(await waitFor(() => m.status().phase === "running" && w.children.length === 2), "restarted after a crash");
    assert(await waitFor(() => m.status().restarts === 0, 500), "after stableMs up, the count goes back to 0");
    await m.stop();
  }

  console.log("\n== stop on quit ==");
  {
    const w = world();
    const m = manager(w);
    await m.start();
    const c = w.children[0];
    const st = await m.stop();
    assert(c.kills[0] === "SIGINT", "Akọwe gets Ctrl+C (SIGINT) first");
    assert(st.phase === "stopped" && !m.isOwnedAlive(), "and is stopped");
    await sleep(60);
    assert(w.children.length === 1, "a stop is not a crash: no restart");
    assert(kinds(w).includes("stop") && kinds(w).includes("stopped"), "stop is logged");

    const w2 = world();
    const m2 = manager(w2);
    await m2.start();
    w2.children[0].ignoreSigint = true;
    await m2.stop();
    assert(w2.children[0].kills.join(",") === "SIGINT,SIGKILL", "one that ignores Ctrl+C is killed after the grace time");
    assert(w2.logs.some((l) => l.kind === "stop-forced"), "…and that is logged");

    const w3 = world();
    const m3 = manager(w3, { platform: "win32" });
    await m3.start();
    await m3.stop();
    assert(w3.children[0].kills[0] === "SIGTERM", "Windows: the process is ended with kill()");
  }

  console.log("\n== Python missing ==");
  {
    const w = world({ pythonOk: false });
    const m = manager(w, { env: { HOME: "/home/u" } });
    const st = await m.start();
    assert(st.phase === "failed" && st.error === "NO_PYTHON", "no Python → failed NO_PYTHON");
    assert(/python\.org\/downloads/.test(st.message) && st.pythonUrl === srv.PYTHON_DOWNLOAD_URL, "the notice says what to install, with the link");
    assert(w.children.length === 0, "nothing was started");
    assert(w.execCalls.some((c) => c.startsWith("python3 ")) && w.execCalls.some((c) => c.startsWith("python ")), "python3 and python were both tried");

    const w2 = world({ pythonVersion: "3.8.10" });
    w2.execFile = ((orig) => (cmd, args, opts, cb) => orig(cmd, args, opts, (err, out, e) => (args.join(" ").includes("version_info") ? cb(Object.assign(new Error("old"), { code: 1 }), "3.8.10\n", "") : cb(err, out, e))))(w2.execFile);
    const st2 = await manager(w2, { env: { HOME: "/home/u" } }).start();
    assert(st2.error === "NO_PYTHON" && /3\.8\.10/.test(st2.message), "a too-old Python is named in the notice");
  }

  console.log("\n== Windows first start: the launcher's venv is made and what Akọwe needs installed once ==");
  {
    const w = world({ jsonschema: false });
    const env = { LOCALAPPDATA: "C:\\L", USERPROFILE: "C:\\U" };
    const m = manager(w, { platform: "win32", env });
    const st = await m.start();
    const vpy = "C:\\L\\Akowe\\venv\\Scripts\\python.exe";
    assert(w.execCalls.some((c) => c.startsWith("py -3 -c")), "Python found with the py launcher (py -3)");
    assert(w.execCalls.some((c) => c === "py -3 -m venv C:\\L\\Akowe\\venv"), "the venv is made where run-akowe.bat makes it");
    assert(w.execCalls.some((c) => c.startsWith(vpy + " -m pip install") && c.includes("requirements.txt")), "requirements.txt is installed into it");
    assert(st.ready && w.children[0].cmd === vpy, `Akọwe runs with the venv's python (${w.children[0] && w.children[0].cmd})`);
    assert(st.python && st.python.venv === true, "status says the private environment is used");
    assert(w.states.includes("preparing") && w.states.includes("installing"), "phases preparing and installing were shown");
    await m.stop();
    // second start: the venv exists and has jsonschema -> no venv, no pip
    const w2 = world({ jsonschema: true });
    w2.exists.add(vpy);
    const m2 = manager(w2, { platform: "win32", env });
    await m2.start();
    assert(!w2.execCalls.some((c) => c.includes("-m venv") || c.includes("pip install")), "next start: no venv making, no install");
    assert(w2.children[0].cmd === vpy, "…and the existing venv is used");
    await m2.stop();
    // install fails (no internet)
    const w3 = world({ jsonschema: false, pipOk: false });
    const st3 = await manager(w3, { platform: "win32", env }).start();
    assert(st3.error === "INSTALL_FAILED" && /internet/.test(st3.message), "install failing → INSTALL_FAILED with a plain notice");
  }

  console.log("\n== the server never answers → HEALTH_TIMEOUT, stopped, Try again ==");
  {
    const w = world({ autoAnswer: false });
    const m = manager(w, { healthTimeoutMs: 120 });
    const st = await m.start();
    assert(st.phase === "failed" && st.error === "HEALTH_TIMEOUT", "no answer in time → failed HEALTH_TIMEOUT");
    assert(w.children[0].kills.length >= 1, "the silent process was stopped");
    await sleep(60);
    assert(w.children.length === 1 && m.status().phase === "failed", "…and not restarted on its own (Try again is the user's)");
    assert(/Try again/.test(st.message) && /log/.test(st.message), "the notice points to Try again and the log");
    assert(kinds(w).includes("health-timeout"), "logged");
  }

  console.log("\n== no Akọwe folder ==");
  {
    const w = world();
    const st = await manager(w, { app: null }).start();
    assert(st.error === "NO_APP" && w.children.length === 0, "NO_APP when ../akowe isn't there");
  }

  console.log("\n== the log file: server output kept, tokens hidden ==");
  {
    const w = world();
    const file = path.join(tmp(), "akowe-server.log");
    const m = manager(w, { logFile: file });
    await m.start();
    await m.stop();
    const text = fs.readFileSync(file, "utf8");
    assert(/Akọwe 1\.0 running/.test(text) && /token=<hidden>/.test(text), "the server's lines are in the log with the token hidden");
    assert(!text.includes(TOKEN), "the token itself is never in the log file");
  }

  console.log("\n== a hand-started Akọwe that goes away → AutoInjector starts its own ==");
  {
    const w = world();
    w.live[8780] = { app: "akowe", version: "0.9" };
    const m = manager(w, { reuseWatchMs: 15 });
    await m.start();
    assert(!m.status().owned && w.children.length === 0, "reused first");
    delete w.live[8780];
    assert(await waitFor(() => m.status().phase === "running" && m.status().owned && w.children.length === 1), "after it stopped answering, our own server runs");
    await m.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
