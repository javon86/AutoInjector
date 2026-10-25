# Bookforge Set K - Workflow Orchestration
Revision BF-CLOSURE-1.1 | 12 operations | independent module

This is the current specification. Historical source/addenda are not active instructions. Use Shared_Contract.md for wire formats, lifecycle, ownership, permissions, failures and record storage.

## Set rules, queue authority and resource policy
K01 creates project identity/configuration; K02 schedules selected required operations; K03 resolves registry adapter; K04 resolves prerequisite graph; K05 owns queue attempts; K06 enforces AUTO/MANUAL; K07 classifies failures; K08 derives progress; K09 owns action checkpoints; K10 pause/resume; K11 selects resources; K12 reserves quota. I12 alone supplies accepted output evidence. K never edits domain records.

Bootstrap creates project with default locale=en-US, branch=main, mode=MANUAL and max_parallel_jobs=1 when UI defaults are accepted. Settings are explicit in K01 request. Feature manifest starts with selected project operations/profiles, not all 142 as hard prerequisites. K04 Tarjan SCC detects hard-cycle nodes/edges in O(V+E), deduplicates missing requests by provider/operation/pinned input hash and uses only declared CREATE-stage exceptions. Feedback schedules revisions after first outputs exist; missing prerequisites are BLOCKED, not transient retries.

Queue: READY -> QUEUED -> RUNNING -> VALIDATING -> COMPLETE. RUNNING may enter RETRY_WAIT, BLOCKED, FAILED, CANCELLED or PAUSED_PENDING. RETRY_WAIT -> QUEUED only within retry policy. BLOCKED -> READY only after dependency/permission repair. COMPLETE requires I commit receipt and I12 evidence matching current source pins. Every transition compares queue_revision. Dispatch allocates attempt_id, increasing fencing_token, generation and a lease (default 60s, heartbeat every 20s); renew only for current attempt. Late expired/fenced/generation-mismatched replies cannot commit. Worker checkpoints are allowed but are not published output.

Pause increments queue generation and blocks new dispatch. Default FINISH_AND_CHECKPOINT allows running calls to checkpoint but forbids publish; optional CANCEL_COOPERATIVE asks them to stop. Resume validates pins/permissions/approvals and creates a new attempt against the resumed generation. Old responses remain stale even if valid. Stop/cancel persists the decision; retry uses the original logical key only if inputs are unchanged.

K06 allows scoped READ/DRAFT/PROPOSE automatically under AUTO, with protected write, publication and deletion held for K09 authorization. MANUAL requires initiation per job as well as action approval where required. Authorization binds action hash, actor scope, source revisions and expiry. K08 numerator is accepted required output evidence count; denominator is selected applicable required count. DRAFT/UNKNOWN/DEFERRED count only in denominator. NOT_APPLICABLE removes an item only with manifest rule evidence. Empty phase is not ready without explicit policy. Job completion and phase readiness are distinct.

K11 considers CODE/TOOL before AI. Exactly three AI slots coexist with deterministic resources; unavailable slots remain configured but ineligible. Eligible resource must meet capability, context, health, authorization and concurrency. AI selection orders estimated cost, load, slot ID. K12 atomically enforces spent+reserved+estimate <= quota using integer minor units. Reserve before dispatch; settlement atomically releases reservation and records actual usage. If actual exceeds estimate, reserve the difference before further work; insufficient quota holds next work and records actual external incurred usage accurately (never pretending an already incurred charge vanished). Cancellation refunds only unspent reservation; ambiguous provider completion keeps reservation until status reconciles.

Acceptance walkthrough: two eligible concurrent 20-unit requests with spent=70 and limit=100 allow at most one. Two AI slots offline leave supported work on one; code validation still runs independently. Pause/restart/resume rejects old worker publication, dispatches a new fenced attempt and commits once.

## Operation contracts

### K01
K01 - Project Manager

Purpose: Maintains project identity, lifecycle, configuration, active phase and top-level status.

Execution: LOGIC. Lifecycle state machine is deterministic.

Input contract: Contracts/K/K01.schema.json#/$defs/CREATE. Required CREATE fields: project_name, settings, owner_id. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| project_name | string | yes |
| settings | object | yes |
| owner_id | string | yes |

Owned output: K01_record; fields project_id, phase, revision, status. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/K/K01.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Project state -> UI/K02/K08. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T9 Router/Workflow. Rendered inside the K set workspace using T9 Router/Workflow; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/K01.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### K02
K02 - Module-Set Scheduler

Purpose: Determines which module/set work is eligible to run based on phase, dependencies, priorities and mode.

Execution: LOGIC. Scheduling rules are deterministic.

Input contract: Contracts/K/K02.schema.json#/$defs/CREATE. Required CREATE fields: project_id, phase, feature_manifest, completion_refs, mode. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| project_id | string | yes |
| phase | string | yes |
| feature_manifest | object | yes |
| completion_refs | array | yes |
| mode | string ['AUTO', 'MANUAL'] | yes |

Owned output: K02_record; fields scheduled_jobs, blocked_jobs. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/K/K02.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Scheduled jobs -> K05. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T9 Router/Workflow. Rendered inside the K set workspace using T9 Router/Workflow; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/K02.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### K03
K03 - Module Router

Purpose: Routes each job/service request to the owning module or registered specialist.

Execution: LOGIC. Registry-based routing is deterministic.

Input contract: Contracts/K/K03.schema.json#/$defs/CREATE. Required CREATE fields: job_id, operation_ref, registry_revision, capability_requirements. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| job_id | string | yes |
| operation_ref | object | yes |
| registry_revision | integer | yes |
| capability_requirements | array | yes |

Owned output: K03_record; fields route, adapter_ref. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/K/K03.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Routed work item -> module/K05. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T9 Router/Workflow. Rendered inside the K set workspace using T9 Router/Workflow; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/K03.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### K04
K04 - Dependency Resolver

Purpose: Checks prerequisite modules/facts and marks work ready, blocked or waiting with explicit reasons.

Execution: LOGIC. Graph/state evaluation is deterministic.

Input contract: Contracts/K/K04.schema.json#/$defs/CREATE. Required CREATE fields: job_id, dependency_graph, completion_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| job_id | string | yes |
| dependency_graph | object | yes |
| completion_refs | array | yes |

Owned output: K04_record; fields ready, missing, cycles, bootstrap_plan. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/K/K04.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Dependency decision -> K02/K05/UI. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T9 Router/Workflow. Rendered inside the K set workspace using T9 Router/Workflow; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/K04.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### K05
K05 - Job Queue

Purpose: Persists queued, running, waiting, retrying, failed and completed work items with priority and run IDs.

Execution: LOGIC. Queue operations are deterministic.

Input contract: Contracts/K/K05.schema.json#/$defs/CREATE. Required CREATE fields: job_id, operation_ref, source_versions, priority. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| job_id | string | yes |
| operation_ref | object | yes |
| source_versions | array | yes |
| priority | integer | yes |

Owned output: K05_record; fields queue_id, attempt_id, lease_state. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/K/K05.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Dispatchable work -> code/tool/AI; status -> K08/I12. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T9 Router/Workflow. Rendered inside the K set workspace using T9 Router/Workflow; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/K05.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### K06
K06 - Automatic/Manual Mode Controller

Purpose: Enforces whether eligible actions may execute automatically, require preview, or require explicit user initiation.

Execution: LOGIC. Policy enforcement is deterministic.

Input contract: Contracts/K/K06.schema.json#/$defs/CREATE. Required CREATE fields: job_id, mode, action_class, approval_policy. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| job_id | string | yes |
| mode | string ['AUTO', 'MANUAL'] | yes |
| action_class | string ['READ', 'DRAFT', 'PROPOSE', 'PUBLISH', 'PROTECTED_WRITE', 'DELETE'] | yes |
| approval_policy | object | yes |

Owned output: K06_record; fields decision, hold_reason. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/K/K06.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Execution permission/hold -> K05/K09. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T9 Router/Workflow. Rendered inside the K set workspace using T9 Router/Workflow; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/K06.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### K07
K07 - Retry/Failure Handler

Purpose: Classifies failures, preserves valid partial output and creates bounded retry, repair, fallback or escalation jobs.

Execution: LOGIC. Failure policy is deterministic; it may invoke AI later but does not need AI itself.

Input contract: Contracts/K/K07.schema.json#/$defs/CREATE. Required CREATE fields: job_id, attempt_id, error_code, retry_policy. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| job_id | string | yes |
| attempt_id | string | yes |
| error_code | string ['TIMEOUT', 'INTERNAL_ERROR', 'CAPABILITY_UNAVAILABLE', 'MISSING_INPUT', 'INVALID_INPUT', 'VERSION_CONFLICT', 'PERMISSION_DENIED', 'APPROVAL_REQUIRED', 'QUOTA_EXCEEDED', 'LEASE_EXPIRED'] | yes |
| retry_policy | object | yes |

Owned output: K07_record; fields decision, next_attempt_at, repair_request. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/K/K07.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Retry/repair/fallback/escalation -> K05/I08/J11. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T9 Router/Workflow. Rendered inside the K set workspace using T9 Router/Workflow; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/K07.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### K08
K08 - Progress Manager

Purpose: Calculates project/set/module progress from validated states rather than worker claims.

Execution: LOGIC. Aggregation is deterministic.

Input contract: Contracts/K/K08.schema.json#/$defs/CREATE. Required CREATE fields: project_id, feature_manifest, completion_refs, queue_states. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| project_id | string | yes |
| feature_manifest | object | yes |
| completion_refs | array | yes |
| queue_states | array | yes |

Owned output: K08_record; fields progress, blockers, phase_ready. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/K/K08.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Progress/status -> dashboard/K01. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T9 Router/Workflow. Rendered inside the K set workspace using T9 Router/Workflow; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/K08.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### K09
K09 - Approval Checkpoints

Purpose: Creates and enforces explicit approval gates for canon locks, high-impact changes, release and configured user decisions.

Execution: LOGIC. Approval workflow is deterministic.

Input contract: Contracts/K/K09.schema.json#/$defs/CREATE. Required CREATE fields: action_id, impact, policy, base_revision. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| action_id | string | yes |
| impact | object | yes |
| policy | object | yes |
| base_revision | integer | yes |

Owned output: K09_record; fields approval_id, decision, expiry. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/K/K09.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Approval request/result -> K/J/I10/H10. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T9 Router/Workflow. Rendered inside the K set workspace using T9 Router/Workflow; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/K09.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### K10
K10 - Pause/Resume

Purpose: Safely suspends dispatch while preserving durable job/project state and resumes eligible work later.

Execution: LOGIC. State persistence is deterministic.

Input contract: Contracts/K/K10.schema.json#/$defs/CREATE. Required CREATE fields: project_id, command, queue_generation. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| project_id | string | yes |
| command | string ['PAUSE', 'RESUME'] | yes |
| queue_generation | integer | yes |

Owned output: K10_record; fields paused, generation, worker_disposition. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/K/K10.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Paused/resumed workflow -> K05/UI. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T9 Router/Workflow. Rendered inside the K set workspace using T9 Router/Workflow; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/K10.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### K11
K11 - Model/Tool Selector

Purpose: Chooses code, deterministic tool, AI-1, AI-2 or AI-3 from declared job capabilities, availability and constraints.

Execution: LOGIC. Selection should be deterministic; the selected resource may itself be AI.

Input contract: Contracts/K/K11.schema.json#/$defs/CREATE. Required CREATE fields: job_id, capabilities, context_requirement, resource_registry. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| job_id | string | yes |
| capabilities | array | yes |
| context_requirement | integer | yes |
| resource_registry | array | yes |

Owned output: K11_record; fields resource_kind, resource_id, ai_slot, adapter_id, capabilities, context_limit_tokens, healthy, max_concurrent, active_jobs, estimated_cost_minor_units, currency, reservation_ref. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/K/K11.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Resource assignment -> K05/worker adapter. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T9 Router/Workflow. Rendered inside the K set workspace using T9 Router/Workflow; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/K11.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### K12
K12 - Cost/Resource Controller

Purpose: Applies logic-first policy, quotas, concurrency, context/resource limits and fallback priorities to minimize unnecessary AI use.

Execution: LOGIC. Policy and accounting are deterministic.

Input contract: Contracts/K/K12.schema.json#/$defs/CREATE. Required CREATE fields: job_id, estimated_cost, quota, usage. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| job_id | string | yes |
| estimated_cost | number | yes |
| quota | object | yes |
| usage | object | yes |

Owned output: K12_record; fields reservation_id, allowed, remaining. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/K/K12.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Resource permission/limits -> K11/K05/UI. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T9 Router/Workflow. Rendered inside the K set workspace using T9 Router/Workflow; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/K12.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

## Applied closure contract
K05 durable queue states now include waits, retries, terminal failures/cancellation/completion. K07 can represent null next retry; K09 pending decisions may have null expiry. K12 uses integer minor units and explicit currency with trusted reservation balances. Completion bindings accept I12 evidence rather than arbitrary output.
Shared_Contract.md section 10 and the updated schemas/registry are normative for these corrections. See Verification/Applied_Fixes.json and Verification/closure_check.json for observed artifact checks, and Acceptance_Cases/closure_runtime.cases.json for future application tests.
