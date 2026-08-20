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

/**
 * Compose the full prompt text for a task, given optional project/chapter
 * context and a records digest to reference by ID.
 */
function composeTask(taskId, ctx = {}) {
  const task = TASKS.find((t) => t.id === taskId);
  if (!task) return null;
  const role = ROLES[task.target];
  const lines = [SHARED_SYSTEM, "", role.prompt, ""];
  if (ctx.title) lines.push(`Book: ${ctx.title}`);
  if (ctx.stage) lines.push(`Current stage: ${ctx.stage}`);
  if (ctx.chapter) lines.push(`Current chapter: ${ctx.chapter}`);
  if (ctx.recordsDigest) lines.push(`Known records: ${ctx.recordsDigest}`);
  lines.push("", `TASK: ${task.body}`);
  if (task.review) lines.push("", REVIEW_SCHEMA);
  return { target: task.target, label: task.label, text: lines.join("\n") };
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
    SHARED_SYSTEM, "", role.prompt, "",
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

module.exports = { SHARED_SYSTEM, ROLES, REVIEW_SCHEMA, TASKS, composeTask, composeBrief, composeBriefAll, digest };
