# Akọwe Set J - Canon Refinement Reconciliation
Revision BF-CLOSURE-1.1 | 11 operations | independent module

This is the current specification. Historical source/addenda are not active instructions. Use Shared_Contract.md for wire formats, lifecycle, ownership, permissions, failures and record storage.

## Set rules and reconciliation protocol
J01 finds incompatible claims only for the same stable subject/predicate/branch and overlapping effective intervals. BELIEF, PLAN and alternate branches are not automatically conflicts with FACT. J02 retains its original cross-Bible purpose: check A records against shared rules, then classify candidates HARD_CONFLICT, TEMPORAL_MISMATCH, BRANCH_MISMATCH, AMBIGUOUS or NON_CONFLICT. J03 exact duplicate uses normalized fact content excluding record metadata; near duplicates use token Jaccard >=0.92 and remain candidates. Names alone never establish identity; aliases/intentional retellings remain distinct.

J04 proposes options, ordered locked approved canon > approved dated canon > verified E events > accepted manuscript claims > unapproved proposals. Authority ties or disputed meaning escalate, not silent selection. J05 rejects prohibited protected changes; feasible option cost = 1000*protected_violations +100*changed_canon_facts +10*changed_passages + affected_downstream_count. Protected violations without explicit authorization are infeasible, not merely expensive. Tie-break by stable option ID. J06 breadth-first impact traversal visits (record,version), follows changed read paths and preserves unrelated branches. Stale graph pins require refresh.

J07 generates proposed owner patches with exact base pins/precondition hash, changed paths/anchored spans, inverse source and expected postconditions. J08 coordinates a repair transaction; A/C/E/D owners validate their parts, I10 verifies protected authorization, I storage atomically commits all in-database changes and outbox. External assets are staged/hash-verified before the transaction; storage promotion references them only after all participants are prepared. If participants use separate stores, use a persisted prepare/commit coordinator and hold visibility until every commit receipt exists; failure compensates only against matching postconditions and otherwise escalates. Do not represent a partially committed multi-owner repair as RESOLVED. A single shared storage kernel is the default compatible implementation.

J09 locates impacted C passage pins and re-anchors stale spans; unaffected passage hashes remain identical. J10 reruns exact impacted predicates and consumers, max three repair iterations per conflict/input revision before escalation. J11 asks for a bounded decision with options, reason, impact, protected facts, source pins, approver scope and expiry. Approval binds candidate/action hash and exact revisions. Rejection/expiry/revocation stops commit. A newly revised repair needs renewed authorization. J cannot approve its own protected fact update merely because an AI is confident.

Acceptance walkthrough: character's childhood relationship differs from later E state: temporal classification, no forced baseline rewrite. Confirm a genuine protected appearance conflict, propose minimal repair, reject an expired approval, then commit the authorized owner plan and revalidate only affected consumers. Interrupted prepare never exposes a mixed canon/manuscript state.

## Operation contracts

### J01
J01 - Contradiction Detector

Purpose: Finds incompatible claims across structured canon, state and manuscript-derived assertions.

Execution: HYBRID. Rule conflicts are logic; semantic contradiction may use AI.

Input contract: Contracts/J/J01.schema.json#/$defs/CREATE. Required CREATE fields: claim_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| claim_refs | array | yes |
| evidence_refs | array | no |
| branch_scope | string | no |
| effective_at | string | no |

Owned output: J01_record; fields conflict_candidates, evidence_refs, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/J/J01.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Conflict candidates/evidence -> J04/K. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T7 Reconciler/Repair. Rendered inside the J set workspace using T7 Reconciler/Repair; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/J01.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### J02
J02 - Cross-Bible Checker

Purpose: Checks A-set records against one another for violations of shared rules and references.

Execution: HYBRID. Structured constraints are logic; semantic consistency may use AI.

Input contract: Contracts/J/J02.schema.json#/$defs/CREATE. Required CREATE fields: candidate_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| candidate_refs | array | yes |
| evidence_refs | array | no |
| branch_scope | string | no |
| effective_at | string | no |

Owned output: J02_record; fields classified_conflicts, evidence_refs, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/J/J02.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Cross-Bible conflicts -> J04. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T7 Reconciler/Repair. Rendered inside the J set workspace using T7 Reconciler/Repair; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/J02.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### J03
J03 - Duplicate/Overlapping Fact Detector

Purpose: Detects duplicate entities/facts and competing records representing the same concept.

Execution: HYBRID. Exact duplicates are logic; semantic entity resolution may use AI.

Input contract: Contracts/J/J03.schema.json#/$defs/CREATE. Required CREATE fields: record_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| record_refs | array | yes |
| evidence_refs | array | no |
| branch_scope | string | no |
| effective_at | string | no |

Owned output: J03_record; fields duplicate_candidates, evidence_refs, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/J/J03.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Duplicate/overlap candidates -> J04/user. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T7 Reconciler/Repair. Rendered inside the J set workspace using T7 Reconciler/Repair; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/J03.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### J04
J04 - Canon Reconciler

Purpose: Generates valid resolution options for a confirmed contradiction without silently choosing a high-impact canon change.

Execution: AI/HYBRID. Rules can eliminate invalid options; semantic repair proposals may require AI.

Input contract: Contracts/J/J04.schema.json#/$defs/CREATE. Required CREATE fields: conflict_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| conflict_refs | array | yes |
| evidence_refs | array | no |
| branch_scope | string | no |
| effective_at | string | no |

Owned output: J04_record; fields repair_options, evidence_refs, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/J/J04.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Repair options -> J05/J11/user. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T7 Reconciler/Repair. Rendered inside the J set workspace using T7 Reconciler/Repair; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/J04.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### J05
J05 - Minimal-Change Solver

Purpose: Ranks feasible repair plans by dependency impact and required changes while respecting locked facts.

Execution: LOGIC/HYBRID. Impact scoring is logic; AI may help formulate semantic alternatives.

Input contract: Contracts/J/J05.schema.json#/$defs/CREATE. Required CREATE fields: option_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| option_refs | array | yes |
| evidence_refs | array | no |
| branch_scope | string | no |
| effective_at | string | no |

Owned output: J05_record; fields ranked_repairs, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/J/J05.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Minimal-impact repair plan -> J06/J11. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T7 Reconciler/Repair. Rendered inside the J set workspace using T7 Reconciler/Repair; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/J05.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### J06
J06 - Dependency/Ripple Analyzer

Purpose: Enumerates records, assets, manuscript passages and jobs affected by a proposed change.

Execution: LOGIC. Graph traversal is deterministic.

Input contract: Contracts/J/J06.schema.json#/$defs/CREATE. Required CREATE fields: changed_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| changed_refs | array | yes |
| evidence_refs | array | no |
| branch_scope | string | no |
| effective_at | string | no |

Owned output: J06_record; fields impact_refs, impact_known, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/J/J06.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Impact graph/recheck plan -> K/J11. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T7 Reconciler/Repair. Rendered inside the J set workspace using T7 Reconciler/Repair; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/J06.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### J07
J07 - Rewrite/Patch Generator

Purpose: Creates localized replacement text/data required by an approved reconciliation plan.

Execution: AI. Semantic rewriting/generation requires AI; scope validation is logic.

Input contract: Contracts/J/J07.schema.json#/$defs/CREATE. Required CREATE fields: approved_option_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| approved_option_ref | object | yes |
| evidence_refs | array | no |
| branch_scope | string | no |
| effective_at | string | no |

Owned output: J07_record; fields patch_proposals, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/J/J07.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Patch candidates -> owning module/I04/C/F. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T7 Reconciler/Repair. Rendered inside the J set workspace using T7 Reconciler/Repair; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/J07.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### J08
J08 - Canon Update Manager

Purpose: Commits approved validated canon changes transactionally and emits version/dependency events.

Execution: LOGIC. Transactional update is deterministic.

Input contract: Contracts/J/J08.schema.json#/$defs/CREATE. Required CREATE fields: approved_patch_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| approved_patch_ref | object | yes |
| evidence_refs | array | no |
| branch_scope | string | no |
| effective_at | string | no |

Owned output: J08_record; fields commit_receipts, transaction_state, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/J/J08.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Updated canon/version events -> I/K/J10. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T7 Reconciler/Repair. Rendered inside the J set workspace using T7 Reconciler/Repair; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/J08.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### J09
J09 - Manuscript Impact Checker

Purpose: Locates manuscript references or implications potentially invalidated by a canon change.

Execution: HYBRID. Exact references are logic; semantic implications may require AI.

Input contract: Contracts/J/J09.schema.json#/$defs/CREATE. Required CREATE fields: changed_fact_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| changed_fact_refs | array | yes |
| evidence_refs | array | no |
| branch_scope | string | no |
| effective_at | string | no |

Owned output: J09_record; fields passage_impacts, evidence_refs, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/J/J09.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Affected passage list -> C/F/K. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T7 Reconciler/Repair. Rendered inside the J set workspace using T7 Reconciler/Repair; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/J09.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### J10
J10 - Revalidation

Purpose: Reruns relevant schemas, constraints and dependent checks after repair.

Execution: LOGIC/HYBRID. Deterministic validators first; semantic checks only where required.

Input contract: Contracts/J/J10.schema.json#/$defs/CREATE. Required CREATE fields: repair_receipt_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| repair_receipt_ref | object | yes |
| evidence_refs | array | no |
| branch_scope | string | no |
| effective_at | string | no |

Owned output: J10_record; fields validation_reports, evidence_refs, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/J/J10.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Pass/new issues -> K/J/I12/H. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T7 Reconciler/Repair. Rendered inside the J set workspace using T7 Reconciler/Repair; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/J10.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### J11
J11 - User Decision Escalation

Purpose: Creates a bounded decision request when automation lacks authority or multiple materially different valid repairs remain.

Execution: LOGIC. Escalation policy and workflow are deterministic.

Input contract: Contracts/J/J11.schema.json#/$defs/CREATE. Required CREATE fields: proposal_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| proposal_ref | object | yes |
| evidence_refs | array | no |
| branch_scope | string | no |
| effective_at | string | no |

Owned output: J11_record; fields approval_records, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/J/J11.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: User decision/hold state -> K/J04/J08. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T7 Reconciler/Repair. Rendered inside the J set workspace using T7 Reconciler/Repair; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/J11.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

## Applied closure contract
Consumer bindings connect J01/J02 conflicts -> J04 options -> J05 ranking -> J07 patches -> J08 receipts -> J10 checks. Generic evidence remains context and cannot impersonate any typed stage. Unknown impact keeps nullable cost/count and blocks automatic selection.
Shared_Contract.md section 10 and the updated schemas/registry are normative for these corrections. See Verification/Applied_Fixes.json and Verification/closure_check.json for observed artifact checks, and Acceptance_Cases/closure_runtime.cases.json for future application tests.
