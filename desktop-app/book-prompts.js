'use strict';
/*
 * book-prompts.js — the ATELIER "Corrected V2" 3-AI book-making prompts, built
 * into the app so the Book Studio can send the right role/task prompt to the
 * right AI pane. Text is condensed from the V2 Prompt Pack (shared system
 * prompt + per-role prompts + reusable task prompts).
 *
 * Roles (CHG-003): ChatGPT = Story, Gemini = Canon, Claude = Writing.
 */

const SHARED_SYSTEM =
  "You are one of three AI systems producing a book under the ATELIER Corrected V2 workflow. " +
  "Use only the authoritative project records supplied. Respect the authority order: approved user " +
  "requirements > approved Canon Change (CCR) records > locked chapters > approved master records > " +
  "Book Bible index > drafts. Never silently resolve a contradiction — flag it as a CNF (conflict) record. " +
  "Never change locked material without an approved CCR. Reference facts by immutable Record ID (REQ/CHR/PLC/" +
  "ART/SEC/TWT/STP/ARC/EVT/CH/CCR/CNF/REV) rather than duplicating data. Report missing required context " +
  "instead of inventing it. Update only records assigned to your role.";

const ROLES = {
  chatgpt: {
    label: "ChatGPT — Story",
    prompt:
      "Your role is STORY (project lead). You own user requirements and their REQ IDs, Story Direction, the " +
      "Master Chapter Outline, project coordination, and story-scope verification. Check story function, " +
      "progression, structure, and requirement fulfillment. Do NOT do Gemini's canon audit or Claude's prose " +
      "audit. A PASS means no story-scope required fix remains.",
  },
  gemini: {
    label: "Gemini — Canon",
    prompt:
      "Your role is CANON. You own the Book Bible canon index, Context Manifests, Chapter Roadmaps, continuity, " +
      "record references, the conflict log, and canon impact analysis. Verify versions and authority before work. " +
      "Do NOT replace ChatGPT's story judgment or Claude's prose judgment. A PASS means no canon-scope fix remains.",
  },
  claude: {
    label: "Claude — Writing",
    prompt:
      "Your role is WRITING QUALITY. You own manuscript drafting, prose-quality review, and approved revisions. " +
      "Follow the roadmap, linked authoritative records, and requirement constraints. Review prose, pacing, " +
      "dialogue, voice, emotional effect, clarity, repetition, transitions, and readability. Do NOT alter canon or " +
      "story architecture to solve a writing issue — flag it. A PASS means no writing-scope fix remains.",
  },
};

// The standard review response schema (CHG-011) — appended to review tasks.
const REVIEW_SCHEMA =
  "Respond using the standard review schema, one block per issue:\n" +
  "Review ID: REV-### | Reviewer/Scope: [AI / STORY|CANON|WRITING] | Status: PASS|PASS WITH NOTES|FAIL|BLOCKED | " +
  "Severity: CRITICAL|MAJOR|MINOR|NOTE | Location: [precise] | Issue: [one supported issue] | Record ID(s): [...] | " +
  "Requirement ID(s): [...] | Required Fix: [minimum action] | Evidence: [quote/reference] | Verification: [check].";

// Reusable tasks. target = which AI pane it goes to. review = append the schema.
const TASKS = [
  { id: "intake", target: "chatgpt", label: "Intake questionnaire",
    body: "You are starting a NEW book with the user. Ask the user a concise NUMBERED questionnaire to capture the book's requirements, then STOP and wait for their answers. Cover: (1) working title & genre; (2) one-paragraph premise/logline; (3) target length and audience; (4) tone & 2-3 comparable titles; (5) main character(s) and what they want; (6) setting/world; (7) must-have elements, scenes, or constraints; (8) point of view & tense; (9) content to avoid; (10) deadline/priorities. Ask them to reply in a numbered list. Do NOT start outlining or writing yet — just ask." },
  { id: "requirements", target: "chatgpt", label: "Capture requirements + Story Direction",
    body: "Using the user's answers, capture the requirements as REQ records (exact wording, priority MUST/SHOULD/COULD) and write a short Story Direction (premise, arc, tone, audience). List anything still unanswered as an open question rather than inventing it." },
  { id: "lock", target: "chatgpt", label: "Verify + lock chapter",
    body: "Verify the current chapter: are its story requirements MET (with manuscript evidence), did all three reviews PASS, and is no MUST requirement unmet and no critical canon conflict open? If yes, mark it ready to LOCK. If not, list exactly what is blocking, by Record/Review ID." },
  { id: "initialize", target: "chatgpt", label: "Initialize project",
    body: "Initialize this book project: confirm the project title, draft the initial user requirements as REQ records, propose the Story Direction, and list the first concrete next action." },
  { id: "outline", target: "chatgpt", label: "Master outline",
    body: "Create the Master Chapter Outline: a numbered chapter list, each with its intended story function and the REQ IDs it satisfies." },
  { id: "roadmap", target: "gemini", label: "Chapter roadmap",
    body: "Create a Chapter Roadmap for the current chapter: required beats, constraints, knowledge/timeline state, setup/payoff, linked canon records, and verification targets." },
  { id: "bible", target: "gemini", label: "Build Book Bible",
    body: "Build/update the Book Bible canon index: one-sentence canon summaries with authority/status and related IDs for the approved master records. Summarize and link; do not copy full profiles." },
  { id: "write", target: "claude", label: "Write chapter",
    body: "Write the current chapter's manuscript following the roadmap, the linked authoritative records, and the requirement constraints. Stay within canon; if something is missing or contradictory, flag it rather than inventing it." },
  { id: "story-review", target: "chatgpt", label: "Story review", review: true,
    body: "Review the current chapter for STORY only: story function, progression, structure, and requirement fulfillment." },
  { id: "canon-review", target: "gemini", label: "Canon review", review: true,
    body: "Review the current chapter for CANON only: continuity, timeline, knowledge state, references, and authoritative versions." },
  { id: "writing-review", target: "claude", label: "Writing review", review: true,
    body: "Review the current chapter for WRITING only: prose, pacing, dialogue, voice, emotional effect, clarity, repetition, transitions, readability." },
  { id: "revise", target: "claude", label: "Consolidated revision",
    body: "Apply the approved review fixes once, minimally. Do not change locked canon without an approved CCR. Return the changed locations and the Review IDs you addressed." },
  { id: "redo", target: "claude", label: "Redo",
    body: "Redo the current chapter from the roadmap and records. Keep what works, but produce a fresh, stronger draft." },
  { id: "start-over", target: "claude", label: "Start over",
    body: "Discard the current draft and start this chapter over from the roadmap and the authoritative records. Do not reuse the previous wording." },
  { id: "check-again", target: "gemini", label: "Check again",
    body: "Re-verify the current chapter against the authoritative records and open conflicts/changes. Report anything that no longer matches, by Record ID." },
];

// The mandatory communication envelope (Rules of Conduct §0), targeted to the
// specific AI so its own [FROM: ...] closing tag is spelled out. Included in
// every composed task/brief because EVERY reply the app captures is completed by
// its [FROM: ...] tag — a reply without it is discarded and the AI is asked to
// resend. Book deliverables address [TO: USER] so they're never swallowed as a
// "[TO: NONE] — nothing to add" reply.
function envelopeLine(target) {
  const tag = String(target || "").toUpperCase();
  return "MESSAGE FORMAT (MANDATORY): BEGIN every reply with a bracket routing tag — [TO: USER] for a project deliverable or a question to the user, or [TO: CHATGPT]/[TO: GEMINI]/[TO: CLAUDE]/[TO: ALL] to address a teammate — and END every reply with your own closing tag in the same form: [FROM: " + tag + "]. The [FROM: ...] tag is what marks your message complete; a reply without it is discarded and you will be asked to resend the whole thing. Put nothing after the closing tag.";
}

/**
 * Compose the full prompt text for a task, given optional project/chapter
 * context and a records digest to reference by ID.
 */
function composeTask(taskId, ctx = {}) {
  const task = TASKS.find((t) => t.id === taskId);
  if (!task) return null;
  const role = ROLES[task.target];
  const lines = [SHARED_SYSTEM, "", role.prompt, "", envelopeLine(task.target), ""];
  if (ctx.title) lines.push(`Book: ${ctx.title}`);
  if (ctx.stage) lines.push(`Current stage: ${ctx.stage}`);
  if (ctx.chapter) lines.push(`Current chapter: ${ctx.chapter}`);
  if (ctx.recordsDigest) lines.push(`Known records: ${ctx.recordsDigest}`);
  lines.push("", `TASK: ${task.body}`);
  if (task.review) lines.push("", REVIEW_SCHEMA);
  return { target: task.target, label: task.label, text: lines.join("\n") };
}

/*
 * The guided production sequence. "Start Making Book" begins at step 0 (ChatGPT
 * sends the intake questionnaire to the user); each "next" advances one step,
 * sending the right role prompt to the right pane and moving the book's stage.
 * It's a human-in-the-loop sequence — you answer / review between steps, and can
 * pause and pick it up later (the step index is saved with the book).
 */
const WORKFLOW = [
  { id: "intake", stage: "setup", kind: "ask-user", label: "Intake questionnaire (ChatGPT asks you)" },
  { id: "requirements", stage: "setup", label: "Capture requirements + Story Direction" },
  { id: "outline", stage: "planning", label: "Master chapter outline" },
  { id: "bible", stage: "planning", label: "Build the Book Bible" },
  { id: "roadmap", stage: "roadmap", label: "Chapter roadmap" },
  { id: "write", stage: "drafting", label: "Write the chapter" },
  { id: "story-review", stage: "review", label: "Story review (ChatGPT)" },
  { id: "canon-review", stage: "review", label: "Canon review (Gemini)" },
  { id: "writing-review", stage: "review", label: "Writing review (Claude)" },
  { id: "revise", stage: "revision", label: "Consolidated revision" },
  { id: "lock", stage: "locking", label: "Verify + lock the chapter" },
];

/** Compose the prompt for workflow step `index`, with project context. */
function composeStep(index, ctx = {}) {
  const step = WORKFLOW[index];
  if (!step) return null;
  const composed = composeTask(step.id, ctx);
  if (!composed) return null;
  return { index, total: WORKFLOW.length, id: step.id, stage: step.stage, kind: step.kind || "ai",
    target: composed.target, label: step.label, text: composed.text };
}

/** A short digest of a project's chapters + records to reference by ID. */
function digest(project) {
  const chs = (project.chapters || []).map((c) => `${c.id}[${c.status}]${c.title ? ' ' + c.title : ''}`).join('; ');
  const recs = (project.records || []).map((r) => `${r.id}${r.name ? ' ' + r.name : ''}`).join('; ');
  return { chapters: chs || '(none yet)', records: recs || '(none yet)' };
}

/**
 * Compose a "catch-up" brief for one AI when a book is (re)opened, so the pane
 * knows exactly what this book is and where it left off — its role, the current
 * stage, every chapter's status, the known records, and what to do next.
 */
function composeBrief(target, project) {
  const role = ROLES[target];
  if (!role) return null;
  const d = digest(project);
  const stageLabel = (project.stageLabels && project.stageLabels[project.stage]) || project.stage;
  const text = [
    SHARED_SYSTEM, "", role.prompt, "", envelopeLine(target), "",
    `You are (re)joining work on a book. Get oriented, then wait for the next task.`,
    `Book: ${project.title}  (${project.id})`,
    `Current stage: ${stageLabel}`,
    `Chapters: ${d.chapters}`,
    `Records: ${d.records}`,
    "", `Acknowledge in one short line that you are caught up and ready in your ${role.label.split(' — ')[1] || 'role'} scope. Do not start writing or reviewing until asked.`,
  ].join("\n");
  return { target, label: role.label, text };
}

/** Briefs for all three AIs at once (for "fill the panes"). */
function composeBriefAll(project) {
  return ['chatgpt', 'gemini', 'claude'].map((t) => composeBrief(t, project)).filter(Boolean);
}

module.exports = { SHARED_SYSTEM, ROLES, REVIEW_SCHEMA, TASKS, WORKFLOW, composeTask, composeStep, composeBrief, composeBriefAll, digest };
