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
  }
  isDestroyed() { return this.destroyedFlag; }
  loadURL(u) { this._url = u; }
  loadFile(f) { this._url = f; }
  getURL() { return this._url; }
  getTitle() { return `Mock ${this.label}`; }
  send(channel, payload) { this.emit("ipc-send", channel, payload); }
  openDevTools() {}
  once(evt, cb) { if (evt === "did-finish-load") setImmediate(cb); return this; }
  async executeJavaScript(script) {
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

class BaseWindow {
  constructor(opts) {
    this.contentView = { addChildView() {} };
    this._bounds = { x: 0, y: 0, width: (opts && opts.width) || 1600, height: (opts && opts.height) || 1000 };
    this._minSize = [(opts && opts.minWidth) || 0, (opts && opts.minHeight) || 0];
    if (opts && opts.title) windowRegistry[opts.title] = this;
  }
  getContentSize() { return [this._bounds.width, this._bounds.height]; }
  getBounds() { return { ...this._bounds }; }
  setBounds(b) { this._bounds = { ...this._bounds, ...b }; }
  getMinimumSize() { return this._minSize.slice(); }
  setMinimumSize(w, h) { this._minSize = [w, h]; }
  on() {}
}

const app = {
  whenReady: () => Promise.resolve(),
  on() {}
};

module.exports = { app, BaseWindow, WebContentsView, ipcMain, __ipcHandlers: ipcHandlers, __registry: registry, __windowRegistry: windowRegistry };
