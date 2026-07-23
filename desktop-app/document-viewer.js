// document-viewer.js — the standalone document preview window's UI. Loaded
// with a "?path=<encoded absolute path>" query string. Renders differently
// depending on what document:read (main.js) reports for that file's `kind`.
// Highlighting is purely a client-side visual note for the user — the
// highlightRects array and any <mark> tags never leave this page; Send
// always delivers the ORIGINAL file via document:send, never anything
// annotated. There's no Save here (this is a viewer, not an editor) — Close
// just closes the window.
const SITES = ["chatgpt", "claude", "gemini"];
const LABELS = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };

const el = (id) => document.getElementById(id);

function currentPath() {
  return decodeURIComponent(new URLSearchParams(window.location.search).get("path") || "");
}

let highlightRects = []; // in-memory only — never persisted, never sent

function redrawHighlights(preview) {
  const canvas = el("highlight-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return; // no 2D context available (e.g. a test environment without real canvas support)
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(245,182,66,0.35)";
  ctx.strokeStyle = "rgba(245,182,66,0.9)";
  const rects = preview ? [...highlightRects, preview] : highlightRects;
  for (const r of rects) {
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
}

function renderImage(res) {
  const preview = el("preview");
  preview.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.id = "image-wrap";
  const img = document.createElement("img");
  img.id = "doc-image";
  img.src = res.fileUrl;
  const canvas = document.createElement("canvas");
  canvas.id = "highlight-canvas";
  wrap.appendChild(img);
  wrap.appendChild(canvas);
  preview.appendChild(wrap);

  el("btn-clear-highlights").style.display = "";

  const resize = () => {
    canvas.width = img.clientWidth;
    canvas.height = img.clientHeight;
    redrawHighlights();
  };
  img.onload = resize;
  if (img.complete) resize();
  window.addEventListener("resize", resize);

  let drawing = null;
  canvas.addEventListener("mousedown", (e) => { drawing = { x: e.offsetX, y: e.offsetY, w: 0, h: 0 }; });
  canvas.addEventListener("mousemove", (e) => {
    if (!drawing) return;
    drawing.w = e.offsetX - drawing.x;
    drawing.h = e.offsetY - drawing.y;
    redrawHighlights(drawing);
  });
  canvas.addEventListener("mouseup", () => {
    if (drawing && (Math.abs(drawing.w) > 2 || Math.abs(drawing.h) > 2)) highlightRects.push(drawing);
    drawing = null;
    redrawHighlights();
  });

  el("btn-clear-highlights").onclick = () => { highlightRects = []; redrawHighlights(); };
}

function renderText(res) {
  const preview = el("preview");
  preview.innerHTML = "";
  if (res.tooLarge) {
    const msg = document.createElement("div");
    msg.textContent = "(file too large to preview — over 500KB)";
    preview.appendChild(msg);
    return;
  }
  const box = document.createElement("div");
  box.id = "doc-text";
  box.textContent = res.text;
  preview.appendChild(box);

  el("btn-mark-selection").style.display = "";
  el("btn-mark-selection").onclick = () => {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!box.contains(range.commonAncestorContainer)) return;
    try {
      const mark = document.createElement("mark");
      range.surroundContents(mark);
      sel.removeAllRanges();
    } catch {
      el("doc-status").textContent = "Couldn't mark that selection — try selecting within a single block of text.";
    }
  };
}

function renderPdf(res) {
  const preview = el("preview");
  preview.innerHTML = "";
  const frame = document.createElement("iframe");
  frame.id = "pdf-frame";
  frame.src = res.fileUrl;
  preview.appendChild(frame);
}

function renderOther() {
  const preview = el("preview");
  preview.innerHTML = "";
  const msg = document.createElement("div");
  msg.style.opacity = ".7";
  msg.textContent = "No preview available for this file type — you can still send it below.";
  preview.appendChild(msg);
}

(async () => {
  const filePath = currentPath();
  const res = await window.api.readDocument(filePath);
  el("doc-name").textContent = (res && res.name) || filePath || "(no file)";
  if (!res || !res.ok) {
    el("doc-status").textContent = `Couldn't open: ${(res && res.error) || "unknown error"}`;
    return;
  }
  el("doc-size").textContent = `${res.size} bytes`;

  if (res.kind === "image") renderImage(res);
  else if (res.kind === "text") renderText(res);
  else if (res.kind === "pdf") renderPdf(res);
  else renderOther();

  const state = await window.api.getState();
  const enabled = (state && state.global && state.global.enabled) || {};
  for (const s of SITES) el(`send-${s}`).checked = enabled[s] !== false;

  el("btn-send-doc").onclick = async () => {
    const targets = SITES.filter((s) => el(`send-${s}`).checked);
    if (!targets.length) { el("doc-status").textContent = "Check at least one AI to send to."; return; }
    el("doc-status").textContent = `Sending to ${targets.map((t) => LABELS[t]).join(", ")}…`;
    const sendRes = await window.api.sendDocument(filePath, targets);
    if (!sendRes || !sendRes.ok) { el("doc-status").textContent = `Send failed: ${(sendRes && sendRes.error) || "unknown error"}`; return; }
    el("doc-status").textContent = targets.map((t) => `${LABELS[t]}: ${sendRes.results[t].ok ? "sent" : sendRes.results[t].error}`).join("  |  ");
  };
})();

el("btn-close").onclick = () => window.api.closeDocumentViewer();
