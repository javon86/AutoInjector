'use strict';
// trailer-recorder-preload.js — the bridge of the hidden 🎞 trailer-recorder window (trailer-recorder.js):
// main sends the plan; the page sends the recording back in chunks, its progress, and done / failed.
// The window's token comes as --trailer-token=… (webPreferences.additionalArguments).
const { contextBridge, ipcRenderer } = require('electron');

const arg = (process.argv || []).find((a) => a.startsWith('--trailer-token='));
const token = arg ? arg.slice('--trailer-token='.length) : '';

contextBridge.exposeInMainWorld('trailerHost', {
  onPlan: (cb) => ipcRenderer.on('trailer-rec:plan', (_e, plan) => cb(plan)),
  onStop: (cb) => ipcRenderer.on('trailer-rec:stop', () => cb()),
  ready: () => ipcRenderer.send('trailer-rec:ready', token),
  chunk: (bytes) => ipcRenderer.send('trailer-rec:chunk', token, bytes),
  progress: (p) => ipcRenderer.send('trailer-rec:progress', token, p),
  done: (info) => ipcRenderer.send('trailer-rec:done', token, info),
  fail: (err) => ipcRenderer.send('trailer-rec:fail', token, err),
});
