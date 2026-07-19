// prompt-editor.js — the standalone Prompt Library editor window's UI. Loaded
// with an optional "?id=<n>" query string: present means editing that saved
// prompt (fields are populated from the current state), absent means a blank
// new prompt. Saving (or Cancel) closes this window; the Automation window's
// compact prompt dropdown picks up the change via the "prompts-changed"
// broadcast, not anything this file does directly.
const SITES = ["chatgpt", "claude", "gemini"];

const el = (id) => document.getElementById(id);

function editingId() {
  const params = new URLSearchParams(window.location.search);
  return params.has("id") ? Number(params.get("id")) : null;
}

function currentText() {
  const text = {};
  for (const site of SITES) text[site] = el(`text-${site}`).value;
  return text;
}

el("btn-fill-all").onclick = () => {
  const v = el("fill-all-text").value;
  for (const site of SITES) el(`text-${site}`).value = v;
};

el("btn-cancel").onclick = () => window.api.closePromptEditor();

el("btn-save").onclick = async () => {
  const name = el("name").value.trim() || "Untitled";
  const res = await window.api.savePrompt(editingId(), name, currentText());
  if (res && res.ok) window.api.closePromptEditor();
  else el("error").textContent = `Couldn't save: ${(res && res.error) || "unknown error"}`;
};

(async () => {
  const id = editingId();
  if (id == null) return; // new prompt — fields stay blank
  const res = await window.api.getState();
  const prompt = res && Array.isArray(res.prompts) && res.prompts.find((p) => p.id === id);
  if (!prompt) return;
  el("name").value = prompt.name;
  for (const site of SITES) el(`text-${site}`).value = (prompt.text && prompt.text[site]) || "";
})();
