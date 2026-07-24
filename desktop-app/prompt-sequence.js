// prompt-sequence.js — the standalone Prompt Sequence popup window. Build a
// numbered list of {target, text} steps and Run: main.js sends step 1, waits
// for that target to actually reply (or, for "All", waits for the first of
// the three to reply), then sends step 2, and so on. This window doesn't run
// the sequence itself — it just calls runSequence() and reflects status back
// via the "sequence-state" broadcast, same division of labor as everywhere
// else in this app (main.js owns all real state).
const SITES = ["chatgpt", "claude", "gemini"];
const LABELS = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", all: "All" };

const el = (id) => document.getElementById(id);

function renumber() {
  document.querySelectorAll("#steps .step").forEach((row, i) => {
    row.querySelector(".num").textContent = `${i + 1}.`;
  });
}

function addStep(target, text) {
  const row = document.createElement("div");
  row.className = "step";

  const num = document.createElement("div");
  num.className = "num";
  row.appendChild(num);

  const fields = document.createElement("div");
  fields.className = "fields";

  const select = document.createElement("select");
  select.className = "step-target";
  for (const t of ["all", ...SITES]) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = `→ ${LABELS[t]}`;
    if (t === target) opt.selected = true;
    select.appendChild(opt);
  }
  fields.appendChild(select);

  const textarea = document.createElement("textarea");
  textarea.className = "step-text";
  textarea.placeholder = "What to send at this step…";
  textarea.value = text || "";
  fields.appendChild(textarea);

  row.appendChild(fields);

  const removeBtn = document.createElement("button");
  removeBtn.className = "btn-remove";
  removeBtn.textContent = "✕";
  removeBtn.title = "Remove this step";
  removeBtn.onclick = () => { row.remove(); renumber(); };
  row.appendChild(removeBtn);

  el("steps").appendChild(row);
  renumber();
}

function readSteps() {
  return Array.from(document.querySelectorAll("#steps .step")).map((row) => ({
    target: row.querySelector(".step-target").value,
    text: row.querySelector(".step-text").value.trim()
  }));
}

el("btn-add-step").onclick = () => addStep("all", "");

el("btn-run").onclick = async () => {
  const steps = readSteps().filter((s) => s.text);
  if (!steps.length) { el("status").textContent = "Add at least one step with text before running."; return; }
  el("btn-run").disabled = true;
  el("status").textContent = "Starting sequence…";
  const res = await window.api.runSequence(steps);
  if (!res || !res.ok) {
    el("status").textContent = `Couldn't start: ${(res && res.error) || "unknown error"}`;
    el("btn-run").disabled = false;
  }
};

el("btn-close").onclick = () => window.api.closeSequenceEditor();

window.api.onSequenceState(({ active, index, total }) => {
  el("btn-run").disabled = active;
  if (active) el("status").textContent = `Running — step ${index + 1} of ${total}, waiting for a reply before continuing…`;
  else if (total > 0) el("status").textContent = "Sequence finished.";
});

addStep("all", "");
