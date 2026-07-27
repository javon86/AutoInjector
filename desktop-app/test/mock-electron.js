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
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoinjector-test-"));

const ipcHandlers = {};
const ipcMain = {
  handle(channel, fn) { ipcHandlers[channel] = fn; }
};

function extractSentText(script) {
  const marker = "const CFG = ";
  const start = script.indexOf(marker);
  if (start === -1) return null;
  const jsonStart = start + marker.length;
  const end = script.indexOf(";\n", jsonStart);
  if (end === -1) return null;
  try {
    return JSON.parse(script.slice(jsonStart, end)).text ?? null;
  } catch {
    return null;
  }
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
    this._nextPickResult = null; // test-settable: what the next selector:pick "click" resolves to
    this.pickCalls = []; // { role } — every pick script executed against this site, in order
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
    if (script.includes("__AUTOINJECTOR_PICK__")) {
      const roleMatch = script.match(/const ROLE = "([^"]+)"/);
      this.pickCalls.push({ role: roleMatch ? roleMatch[1] : null });
      return this._nextPickResult || { ok: false, error: "TIMEOUT" };
    }
    if (script.includes("typeByKeyboard")) {
      this.sentLog.push({ text: extractSentText(script), ts: Date.now() });
      return { ok: true };
    }
    return { ok: true, text: this.currentText };
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
  setBounds() {}
}

const windowRegistry = {};

class BaseWindow extends EventEmitter {
  constructor(opts) {
    super();
    this.contentView = { addChildView() {} };
    this._bounds = { x: 0, y: 0, width: (opts && opts.width) || 1600, height: (opts && opts.height) || 1000 };
    this._minSize = [(opts && opts.minWidth) || 0, (opts && opts.minHeight) || 0];
    this._destroyed = false;
    if (opts && opts.title) windowRegistry[opts.title] = this;
  }
  getContentSize() { return [this._bounds.width, this._bounds.height]; }
  getBounds() { return { ...this._bounds }; }
  setBounds(b) { this._bounds = { ...this._bounds, ...b }; }
  getMinimumSize() { return this._minSize.slice(); }
  setMinimumSize(w, h) { this._minSize = [w, h]; }
  focus() {}
  isDestroyed() { return this._destroyed; }
  close() { if (this._destroyed) return; this._destroyed = true; this.emit("closed"); }
}

const app = {
  whenReady: () => Promise.resolve(),
  getPath: () => userDataDir,
  on() {}
};

let dialogResult = { canceled: true, filePaths: [] };
const dialog = {
  showOpenDialog: async () => dialogResult
};
function __setDialogResult(r) { dialogResult = r; }

module.exports = {
  app, BaseWindow, WebContentsView, ipcMain, dialog,
  __ipcHandlers: ipcHandlers, __registry: registry, __windowRegistry: windowRegistry, __userDataDir: userDataDir,
  __setDialogResult
};
