// mock-electron.js — a minimal stand-in for the parts of Electron main.js uses,
// so main.js's real orchestration logic (House Rules state machines, routing,
// capture detection) can run and be asserted on in plain Node, without a real
// browser or display. It does NOT simulate real page DOM — executeJavaScript()
// either records what a "send" script would have typed (by parsing the JSON
// payload automation.js embeds in it) or returns whatever text the test has set
// as that site's current on-screen reply. That's the real boundary this project
// can't unit-test without an actual browser; everything on the Node side of that
// boundary — who gets sent what, in what order, with what role/label — is real.
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

// A fresh, isolated temp dir per test process — mirrors what app.getPath("userData")
// gives a real Electron app, so persistence/debug-log code paths exercise real
// file IO instead of being mocked away entirely.
// main.js would start Akọwe's real server on app-ready (akowe-server.js); the mock-Electron
// harnesses test main.js's own logic, so it stays off unless a test turns it on.
if (process.env.AUTOINJECTOR_AKOWE_SERVER === undefined) process.env.AUTOINJECTOR_AKOWE_SERVER = "0";

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoinjector-test-"));

const ipcHandlers = {};
const ipcMain = {
  handle(channel, fn) { ipcHandlers[channel] = fn; }
};

function extractCfg(script) {
  const marker = "const CFG = ";
  const start = script.indexOf(marker);
  if (start === -1) return null;
  const jsonStart = start + marker.length;
  const end = script.indexOf(";\n", jsonStart);
  if (end === -1) return null;
  try {
    return JSON.parse(script.slice(jsonStart, end));
  } catch {
    return null;
  }
}
function extractSentText(script) {
  const cfg = extractCfg(script);
  return cfg ? (cfg.text ?? null) : null;
}

class FakeWebContents extends EventEmitter {
  constructor(label) {
    super();
    this.label = label;
    this.destroyedFlag = false;
    this._url = "";
    this.currentText = ""; // what this site's page "currently shows" as its latest reply
    this.sentLog = []; // { text, ts } — every send-script execution against this site, in order
    this.fileInputSets = []; // { files, objectId } — every successful DOM.setFileInputFiles call
    this._debuggerAttached = false;
    this._fileInputExists = true; // toggle false to simulate NO_FILE_INPUT_FOUND
    this._forceAttachFail = false; // toggle true to simulate ATTACH_FAILED
    this._forceSetFilesFail = false; // toggle true to simulate SET_FILES_FAILED
    this._forceSendFail = false; // toggle true to simulate a send that never actually submitted (SEND_NOT_CONFIRMED)
    this._nextPickResult = null; // test-settable: what the next selector:pick "click" resolves to
    this.pickCalls = []; // { role } — every pick script executed against this site, in order
    this._sendDelayQueue = []; // test-settable: ms to artificially delay each successive send script (shifted per call, 0 once empty) -- used to deterministically prove two concurrent sends to the same target get serialized rather than racing
    this._sendFailQueue = []; // test-settable: per-attempt pass/fail override for successive send attempts (retries included), shifted per call -- see executeJavaScript()
    this._nextLoginFillResult = null; // test-settable: what the next login-fill script resolves to
    this.loginFillCalls = []; // { username, password } — the REAL (decrypted) credentials the script actually received, in order -- lets a test verify the exact plaintext without ever going through the persisted state file
    // TR-15: when set, executeJavaScript() hands the REAL script to this function
    // instead of the string-matching fakes below -- test/stress.test.js points it
    // at a Playwright page (page.evaluate) so main.js drives a real browser DOM.
    this.evaluator = null;
    const self = this;
    // A minimal stand-in for webContents.debugger, at the same fidelity as
    // the rest of this mock: it asserts WHAT CDP command was sent with what
    // params, not real DOM behavior (that stays Playwright's job, same
    // division of labor as executeJavaScript() above).
    this.debugger = {
      attach(_protocolVersion) {
        if (self._forceAttachFail) throw new Error("Another debugger is already attached to the specified page");
        if (self._debuggerAttached) throw new Error("Debugger is already attached to this page");
        self._debuggerAttached = true;
      },
      detach() { self._debuggerAttached = false; },
      isAttached() { return self._debuggerAttached; },
      async sendCommand(method, params) {
        if (method === "Runtime.evaluate") {
          return self._fileInputExists ? { result: { objectId: `objid-${self.label}` } } : { result: { type: "undefined" } };
        }
        if (method === "DOM.setFileInputFiles") {
          if (self._forceSetFilesFail) throw new Error("setFileInputFiles failed: node not found");
          self.fileInputSets.push({ files: params.files, objectId: params.objectId });
          return {};
        }
        return {}; // Runtime.releaseObject and anything else
      }
    };
  }
  isDestroyed() { return this.destroyedFlag; }
  loadURL(u) { this._url = u; }
  loadFile(f, opts) { this._url = f; this._loadOpts = opts || {}; }
  getURL() { return this._url; }
  getTitle() { return `Mock ${this.label}`; }
  send(channel, payload) { this.emit("ipc-send", channel, payload); }
  openDevTools() {}
  setZoomFactor(factor) { this.zoomFactor = factor; }
  once(evt, cb) { if (evt === "did-finish-load") setImmediate(cb); return this; }
  async executeJavaScript(script) {
    if (this.evaluator) return this.evaluator(script);
    // P18 self-repair page scripts: run them for real against a fake page when the
    // test gave one (test/fake-dom.js), else say there is no page DOM here.
    if (script.includes("__AUTOINJECTOR_SELFREPAIR__")) {
      if (this.selfRepairPage) return require("./fake-dom").runScript(script, this.selfRepairPage);
      return { ok: false, error: "NO_FAKE_DOM" };
    }
    // 🎨 chatgpt-image.js page scripts (scan / fetch / convert): answered by a fake
    // ChatGPT image page when the test gave one (test/fixtures/fake-chatgpt-image.js).
    if (script.includes("__AUTOINJECTOR_CHATIMG__")) {
      if (typeof this.chatImagePage === "function") return this.chatImagePage(script);
      return { ok: false, error: "NO_FAKE_PAGE" };
    }
    if (script.includes("__AUTOINJECTOR_PICK__")) {
      const roleMatch = script.match(/const ROLE = "([^"]+)"/);
      this.pickCalls.push({ role: roleMatch ? roleMatch[1] : null });
      return this._nextPickResult || { ok: false, error: "TIMEOUT" };
    }
    if (script.includes("__AUTOINJECTOR_LOGIN_FILL__")) {
      const cfg = extractCfg(script) || {};
      this.loginFillCalls.push({ username: cfg.username, password: cfg.password });
      return this._nextLoginFillResult || { ok: true, filled: ["username", "password"], submitted: true };
    }
    if (script.includes("typeByKeyboard")) {
      const delay = this._sendDelayQueue.length ? this._sendDelayQueue.shift() : 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      // _sendFailQueue: per-attempt override (shifted on every typeByKeyboard
      // call, i.e. every real send AND every retry of it) -- lets a test
      // script "fails twice then succeeds on the 3rd try" precisely, to
      // verify the real retry loop in sendTextTo(), not just a permanently
      // broken or permanently working send. Falls back to the simpler
      // always-fail/always-succeed _forceSendFail once the queue is empty.
      // _busyCount: report AI_BUSY (the AI is still writing) this many times first (TR-25)
      if (this._busyCount > 0) { this._busyCount--; return { ok: false, error: "AI_BUSY" }; }
      const failThisAttempt = this._sendFailQueue.length ? this._sendFailQueue.shift() : this._forceSendFail;
      if (typeof this.onSendAttempt === "function") { try { this.onSendAttempt(extractSentText(script), failThisAttempt); } catch (_) {} } // P18.5 tests: the page reacts while the send is still being confirmed
      if (this._sendDelayAfterQueue && this._sendDelayAfterQueue.length) { const d = this._sendDelayAfterQueue.shift(); if (d) await new Promise((r) => setTimeout(r, d)); }
      if (failThisAttempt) return { ok: false, error: "SEND_NOT_CONFIRMED" };
      this.sentLog.push({ text: extractSentText(script), ts: Date.now() });
      return { ok: true, verified: this._verified === undefined ? undefined : this._verified };
    }
    // Read script: report the latest reply text plus the site's generating state.
    // `generating`/`sendReady` default to "done" so existing tests are unaffected;
    // a test can set webContents.generating = true to simulate an in-progress reply.
    const generating = !!this.generating;
    const out = { ok: true, text: this.currentText, generating, sendReady: !generating };
    if (Number.isInteger(this.replyCount)) out.count = this.replyCount; // reply blocks on the page (TR-17)
    if (typeof this.stopShown === "boolean") out.stopShown = this.stopShown; // TR-30: Stop button alone (default: same as generating)
    out.inputFound = typeof this.inputFound === "boolean" ? this.inputFound : true; // the message box is on the page (false = signed out / page changed)
    return out;
  }
}

const registry = {};

class WebContentsView {
  constructor(opts) {
    const partition = opts && opts.webPreferences && opts.webPreferences.partition;
    const label = partition ? partition.replace("persist:", "") : "controls";
    this.webContents = new FakeWebContents(label);
    registry[label] = this;
  }
  setBounds(b) { this._bounds = { ...b }; }
}

const windowRegistry = {};

class BaseWindow extends EventEmitter {
  constructor(opts) {
    super();
    this.contentView = { addChildView() {} };
    this._bounds = { x: 0, y: 0, width: (opts && opts.width) || 1600, height: (opts && opts.height) || 1000 };
    this._minSize = [(opts && opts.minWidth) || 0, (opts && opts.minHeight) || 0];
    this._destroyed = false;
    this._frameHeight = 0; // native title bar + borders (tests can set it; real Windows ~31-45px)
    this._maximized = false;
    this._normalBounds = null;
    if (opts && opts.title) windowRegistry[opts.title] = this;
  }
  getContentSize() { return [this._bounds.width, Math.max(0, this._bounds.height - this._frameHeight)]; }
  isMaximized() { return this._maximized; }
  maximize() { if (this._maximized) return; this._normalBounds = { ...this._bounds }; this._maximized = true; this._bounds = { x: 0, y: 0, width: 1920, height: 1040 }; }
  unmaximize() { if (!this._maximized) return; this._maximized = false; this._bounds = { ...this._normalBounds }; }
  getNormalBounds() { return { ...(this._maximized ? this._normalBounds : this._bounds) }; }
  getBounds() { return { ...this._bounds }; }
  setBounds(b) { this._bounds = { ...this._bounds, ...b }; }
  getMinimumSize() { return this._minSize.slice(); }
  setMinimumSize(w, h) { this._minSize = [w, h]; }
  focus() {}
  isDestroyed() { return this._destroyed; }
  close() { if (this._destroyed) return; this._destroyed = true; this.emit("closed"); }
}

// A BrowserWindow (no app window uses one any more — 🎩 Alfred's panel is docked): enough of one to check what
// it was made with (parent / alwaysOnTop / bounds), shown / hidden / focused, and what was sent to it.
const browserWindows = [];
class BrowserWindow extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts || {};
    this.webContents = new FakeWebContents("alfred-window");
    this.webContents.on = this.webContents.on.bind(this.webContents);
    this.webContents.sentLog = [];
    const origSend = this.webContents.send.bind(this.webContents);
    this.webContents.send = (channel, payload) => { this.webContents.sentLog.push({ channel, payload }); origSend(channel, payload); };
    this._bounds = { x: this.opts.x || 0, y: this.opts.y || 0, width: this.opts.width || 800, height: this.opts.height || 600 };
    this._parent = this.opts.parent || null;
    this._onTop = !!this.opts.alwaysOnTop;
    this._onTopLevel = this._onTop ? "floating" : null;
    this._visible = false;
    this._destroyed = false;
    this.calls = [];
    browserWindows.push(this);
  }
  loadFile(f) { this.calls.push("loadFile"); this.webContents.loadFile(f); }
  show() { this.calls.push("show"); this._visible = true; this.emit("show"); }
  showInactive() { this.calls.push("showInactive"); this._visible = true; this.emit("show"); }
  hide() { this.calls.push("hide"); this._visible = false; this.emit("hide"); }
  focus() { this.calls.push("focus"); }
  isVisible() { return this._visible; }
  isDestroyed() { return this._destroyed; }
  getBounds() { return { ...this._bounds }; }
  setBounds(b) { this._bounds = { ...this._bounds, ...b }; this.emit("move"); }
  setAlwaysOnTop(v, level) { this._onTop = !!v; this._onTopLevel = v ? (level || "floating") : null; }
  isAlwaysOnTop() { return this._onTop; }
  getParentWindow() { return this._parent; }
  close() {
    if (this._destroyed) return;
    let prevented = false;
    this.emit("close", { preventDefault: () => { prevented = true; } });
    if (!prevented) this.destroy();
  }
  destroy() { if (this._destroyed) return; this._destroyed = true; this._visible = false; this.webContents.destroyedFlag = true; this.emit("closed"); }
}
// screen: one 1920x1080 display unless a test sets others (__setDisplays).
let displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
const screen = { getAllDisplays: () => displays.map((d) => ({ ...d })) };
function __setDisplays(d) { displays = d; }

// app.on() listeners are kept (never fired by the mock itself) so a test can fire one, e.g.
// "web-contents-created" for Alfred's Ctrl+Shift+A, via __emitApp(event, ...args).
const appListeners = {};
const app = {
  whenReady: () => Promise.resolve(),
  getPath: () => userDataDir,
  on(evt, fn) { (appListeners[evt] = appListeners[evt] || []).push(fn); }
};
function __emitApp(evt, ...args) { for (const fn of appListeners[evt] || []) { try { fn(...args); } catch (_) {} } }

let dialogResult = { canceled: true, filePaths: [] };
const dialog = {
  showOpenDialog: async () => dialogResult
};
function __setDialogResult(r) { dialogResult = r; }

// A minimal stand-in for the real OS-keychain-backed safeStorage -- doesn't
// need to be genuinely secure (that's what the real Electron API on the real
// OS provides), just a real, working encrypt/decrypt round trip so
// main.js's own logic (never storing the raw password, always going through
// encrypt/decrypt) can be exercised for real. __setEncryptionAvailable lets
// a test simulate a system with no keychain backend (e.g. some Linux setups).
let __encryptionAvailable = true;
const safeStorage = {
  isEncryptionAvailable: () => __encryptionAvailable,
  encryptString: (plainText) => Buffer.from(String(plainText), "utf8"),
  decryptString: (buf) => Buffer.from(buf).toString("utf8")
};
function __setEncryptionAvailable(v) { __encryptionAvailable = v; }

module.exports = {
  app, BaseWindow, WebContentsView, ipcMain, dialog, safeStorage, BrowserWindow, screen, __browserWindows: browserWindows, __setDisplays, __emitApp,
  __ipcHandlers: ipcHandlers, __registry: registry, __windowRegistry: windowRegistry, __userDataDir: userDataDir,
  __setDialogResult, __setEncryptionAvailable
};
