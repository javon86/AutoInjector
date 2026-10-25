# Akọwe Set I - Brain Storage Context
Revision BF-CLOSURE-1.1 | 15 operations | independent module

This is the current specification. Historical source/addenda are not active instructions. Use Shared_Contract.md for wire formats, lifecycle, ownership, permissions, failures and record storage.

## Set rules and storage bootstrap
I02/I03 schemas and registry load from these delivered files into a trusted deterministic bootstrap kernel. Verify hashes and JSON Schema definitions before dispatch. Kernel validation of infrastructure envelopes never enqueues I04, and I12 does not need its own completion event to project another module's commit. I01 stores A/domain data as custodian with explicit owner_operation. Staged DRAFT facts permit approval_ref=null; APPROVED requires a valid I10 approval/delegation and resolved applicable sources. The caller cannot select an unauthorized owner.

I02 json_schema is a JSON Schema document; validate with Draft202012Validator.check_schema, rather than treating its arbitrary keywords as creative content. I04 subject_payload is any candidate document validated against the exact supplied schema. These two objects are intentionally schema-controlled by the referenced/meta schema, rather than the universal SemanticRecord. I03 producer/consumer IDs must exist and output_type match the registry. Breaking schema changes create a new immutable major version; never mutate an existing version.

I04 returns exact field violations. I05 deduplicates missing requirements by project/branch/subject revision/path/required_by. I06 searches only authorized records, pins results and orders by record ID/version; query text is literal casefolded search of summary/text, predicates exact match and filters conjunctive. limit 1..1000, cursor opaque and bound to the initial result snapshot. I07 includes required/protected facts first; optional retrieval sorted by relevance then stable ID; never truncate mandatory facts. I08 routes one missing request to its declared owning operation; unknown owner holds for user input. I09 produces a labeled fallback candidate with evidence/confidence and cannot self-approve canon. I10 enforces approve/lock transitions and rejects self-escalation of authority. I11 returns immutable revision diffs and audit. I12 requires storage commit receipt and validation/approval pins, not worker flags. I13 records typed dependency paths. I14 records transform and approval chains. I15 compresses optional description only; required/protected values and schema remain verbatim.

Backups are infrastructure work, distinct from I09 creative completion. Default retention: daily transaction-consistent snapshots for 7 days plus weekly snapshots for 4 weeks; user may change retention with a recorded policy revision. Snapshot includes DB schema version, immutable records/history, ACLs, outbox/receipts, queue checkpoints and asset bytes with SHA-256 manifest. Credentials are excluded and restored separately from secret store. Restore into a new isolated database/storage root; verify counts, revision links, every file hash, dangling references and representative allowed/denied ACL decisions. Replay pending outbox idempotently. Promote only after verification; failed restoration leaves original environment active.

Migration procedure: back up and verify; validate supported from/to versions; migrate an isolated copy; validate schemas/record counts/hashes/ACL invariants; switch storage pointer atomically. New schema version and migration ID are recorded with audit. Downgrade uses a tested inverse migration or restores the verified prior snapshot; loss of newer writes must be explicitly reviewed before restore. No claim of a tested migration is made in this blueprint.

Acceptance walkthrough: empty project loads schemas/registry and can validate first A01 without recursive jobs. Duplicate commit creates one head/history/outbox. Corrupt one backed-up asset and restore validation blocks promotion. Protected context exceeds tokenizer budget: split job or CONTEXT_TOO_LARGE, never drop the fact.

## Operation contracts

### I01
I01 - Canon Database

Purpose: Stores authoritative project entities/facts and exposes controlled read/write operations.

Execution: LOGIC. Database operations are deterministic.

Input contract: Contracts/I/I01.schema.json#/$defs/CREATE. Required CREATE fields: owner_operation, source_ref, approval_ref, fact_type, fact_payload, requested_state. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| owner_operation | enum ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18', 'B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B09', 'B10', 'B11', 'B12', 'B13', 'B14', 'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12', 'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10', 'D11', 'D12', 'E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10', 'E11', 'E12', 'F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12', 'G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08', 'G09', 'G10', 'G11', 'G12', 'G13', 'G14', 'H01', 'H02', 'H03', 'H04', 'H05', 'H06', 'H07', 'H08', 'H09', 'H10', 'I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08', 'I09', 'I10', 'I11', 'I12', 'I13', 'I14', 'I15', 'J01', 'J02', 'J03', 'J04', 'J05', 'J06', 'J07', 'J08', 'J09', 'J10', 'J11', 'K01', 'K02', 'K03', 'K04', 'K05', 'K06', 'K07', 'K08', 'K09', 'K10', 'K11', 'K12'] | yes |
| source_ref | object | yes |
| approval_ref | structured | yes |
| fact_type | string | yes |
| fact_payload | object | yes |
| requested_state | enum ['DRAFT', 'APPROVED'] | yes |

Owned output: I01_record; fields canon_id, revision, approval_state. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/I/I01.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Current canon -> authorized modules; change events -> I11/I13/J/K. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T8 Storage/Context. Rendered inside the I set workspace using T8 Storage/Context; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/I01.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### I02
I02 - Schema Manager

Purpose: Stores versioned schemas defining fields, types, requirements, conditionals and validation rules.

Execution: LOGIC. Schema evaluation is deterministic.

Input contract: Contracts/I/I02.schema.json#/$defs/CREATE. Required CREATE fields: schema_id, semantic_version, json_schema, compatibility_policy. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| schema_id | string | yes |
| semantic_version | string | yes |
| json_schema | object | yes |
| compatibility_policy | enum ['ADDITIVE', 'BREAKING'] | yes |

Owned output: I02_record; fields schema_id, schema_hash, version. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/I/I02.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Schemas -> UI/I04/modules/K. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T8 Storage/Context. Rendered inside the I set workspace using T8 Storage/Context; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/I02.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### I03
I03 - Module Input/Output Registry

Purpose: Stores each module's ownership, inputs, outputs, permissions, services and contracts.

Execution: LOGIC. Registry lookup is deterministic.

Input contract: Contracts/I/I03.schema.json#/$defs/CREATE. Required CREATE fields: producer, consumer, contract_version, output_type, dependency_predicate. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| producer | enum ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18', 'B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B09', 'B10', 'B11', 'B12', 'B13', 'B14', 'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12', 'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10', 'D11', 'D12', 'E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10', 'E11', 'E12', 'F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12', 'G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08', 'G09', 'G10', 'G11', 'G12', 'G13', 'G14', 'H01', 'H02', 'H03', 'H04', 'H05', 'H06', 'H07', 'H08', 'H09', 'H10', 'I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08', 'I09', 'I10', 'I11', 'I12', 'I13', 'I14', 'I15', 'J01', 'J02', 'J03', 'J04', 'J05', 'J06', 'J07', 'J08', 'J09', 'J10', 'J11', 'K01', 'K02', 'K03', 'K04', 'K05', 'K06', 'K07', 'K08', 'K09', 'K10', 'K11', 'K12'] | yes |
| consumer | enum ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18', 'B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B09', 'B10', 'B11', 'B12', 'B13', 'B14', 'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12', 'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10', 'D11', 'D12', 'E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10', 'E11', 'E12', 'F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12', 'G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08', 'G09', 'G10', 'G11', 'G12', 'G13', 'G14', 'H01', 'H02', 'H03', 'H04', 'H05', 'H06', 'H07', 'H08', 'H09', 'H10', 'I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08', 'I09', 'I10', 'I11', 'I12', 'I13', 'I14', 'I15', 'J01', 'J02', 'J03', 'J04', 'J05', 'J06', 'J07', 'J08', 'J09', 'J10', 'J11', 'K01', 'K02', 'K03', 'K04', 'K05', 'K06', 'K07', 'K08', 'K09', 'K10', 'K11', 'K12'] | yes |
| contract_version | structured | yes |
| output_type | string | yes |
| dependency_predicate | object | yes |

Owned output: I03_record; fields registration_id, revision. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/I/I03.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Registry -> I/K/J/UI. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T8 Storage/Context. Rendered inside the I set workspace using T8 Storage/Context; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/I03.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### I04
I04 - Required-Field Validator

Purpose: Validates candidate records/results against schema, conditional requirements and allowed values.

Execution: LOGIC. AI self-reported completeness is never authoritative.

Input contract: Contracts/I/I04.schema.json#/$defs/CREATE. Required CREATE fields: schema_ref, subject_ref, subject_payload. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| schema_ref | object | yes |
| subject_ref | structured | yes |
| subject_payload | object | yes |

Owned output: I04_record; fields valid, violations, schema_version. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/I/I04.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Validation result/errors -> module/K/I05. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T8 Storage/Context. Rendered inside the I set workspace using T8 Storage/Context; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/I04.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### I05
I05 - Missing-Information Detector

Purpose: Converts validation failures and context requirements into exact missing/invalid field requests.

Execution: LOGIC. Set difference/rule evaluation is deterministic.

Input contract: Contracts/I/I05.schema.json#/$defs/CREATE. Required CREATE fields: subject_ref, field_path, required_by, blocking_class. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| subject_ref | object | yes |
| field_path | string | yes |
| required_by | enum ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18', 'B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B09', 'B10', 'B11', 'B12', 'B13', 'B14', 'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12', 'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10', 'D11', 'D12', 'E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10', 'E11', 'E12', 'F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12', 'G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08', 'G09', 'G10', 'G11', 'G12', 'G13', 'G14', 'H01', 'H02', 'H03', 'H04', 'H05', 'H06', 'H07', 'H08', 'H09', 'H10', 'I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08', 'I09', 'I10', 'I11', 'I12', 'I13', 'I14', 'I15', 'J01', 'J02', 'J03', 'J04', 'J05', 'J06', 'J07', 'J08', 'J09', 'J10', 'J11', 'K01', 'K02', 'K03', 'K04', 'K05', 'K06', 'K07', 'K08', 'K09', 'K10', 'K11', 'K12'] | yes |
| blocking_class | enum ['STRUCTURAL', 'SEMANTIC', 'APPROVAL', 'DEPENDENCY'] | yes |

Owned output: I05_record; fields request_id, dedupe_key, status. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/I/I05.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Missing-information list -> I08/K/UI. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T8 Storage/Context. Rendered inside the I set workspace using T8 Storage/Context; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/I05.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### I06
I06 - Context Retriever

Purpose: Retrieves relevant records using explicit references, dependencies, scope and access rules.

Execution: LOGIC. Retrieval is deterministic; semantic search may be optional supporting infrastructure.

Input contract: Contracts/I/I06.schema.json#/$defs/CREATE. Required CREATE fields: query, branch_id, limit, source_version_policy. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| query | object | yes |
| branch_id | string | yes |
| limit | integer | yes |
| source_version_policy | enum ['EXACT', 'CURRENT_APPROVED'] | yes |
| cursor | ['string', 'null'] | no |

Owned output: I06_record; fields records, next_cursor, source_refs. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/I/I06.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Retrieved fact set + provenance -> I07. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T8 Storage/Context. Rendered inside the I set workspace using T8 Storage/Context; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/I06.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### I07
I07 - Context Package Builder

Purpose: Builds bounded job packages containing instructions, relevant facts, protected facts and output contract.

Execution: LOGIC. Packaging and budgeting are deterministic.

Input contract: Contracts/I/I07.schema.json#/$defs/CREATE. Required CREATE fields: task_ref, token_budget, required_facts, retrieval_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| task_ref | object | yes |
| token_budget | integer | yes |
| required_facts | array | yes |
| retrieval_refs | array | yes |

Owned output: I07_record; fields included, omitted, source_pins, budget_used. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/I/I07.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Context/job package -> selected worker/module. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T8 Storage/Context. Rendered inside the I set workspace using T8 Storage/Context; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/I07.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### I08
I08 - Missing-Information Router

Purpose: Finds the owning/provider module for each missing requirement and creates targeted requests.

Execution: LOGIC. Routing uses registry/dependency rules.

Input contract: Contracts/I/I08.schema.json#/$defs/CREATE. Required CREATE fields: missing_request_ref, target_owner, deadline. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| missing_request_ref | object | yes |
| target_owner | enum ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'] | yes |
| deadline | string | yes |

Owned output: I08_record; fields route_id, delivery_state, attempts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/I/I08.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Requests -> K/owning modules. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T8 Storage/Context. Rendered inside the I set workspace using T8 Storage/Context; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/I08.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### I09
I09 - Backup Completion Engine

Purpose: Provides controlled fallback for unresolved creative information when normal owning-module completion cannot proceed.

Execution: HYBRID. Logic determines eligibility; AI may propose creative missing values.

Input contract: Contracts/I/I09.schema.json#/$defs/CREATE. Required CREATE fields: missing_request_ref, candidate_value, evidence_refs, confidence. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| missing_request_ref | object | yes |
| candidate_value | object | yes |
| evidence_refs | array | yes |
| confidence | number | yes |

Owned output: I09_record; fields candidate_id, approval_state. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/I/I09.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Proposed fallback facts -> I04/I10/user. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T8 Storage/Context. Rendered inside the I set workspace using T8 Storage/Context; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/I09.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### I10
I10 - Canon Approval/Lock Manager

Purpose: Applies canon lifecycle status and enforces who may approve, lock, supersede or reopen facts.

Execution: LOGIC. State machine is deterministic.

Input contract: Contracts/I/I10.schema.json#/$defs/CREATE. Required CREATE fields: candidate_ref, decision, approver_id, reason, authorization_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| candidate_ref | object | yes |
| decision | enum ['APPROVE', 'REJECT', 'LOCK', 'UNLOCK', 'SUPERSEDE'] | yes |
| approver_id | string | yes |
| reason | string | yes |
| authorization_ref | structured | yes |

Owned output: I10_record; fields approval, locked_revision. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/I/I10.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Status transitions -> I01/K/J. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T8 Storage/Context. Rendered inside the I set workspace using T8 Storage/Context; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/I10.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### I11
I11 - Version/Change History

Purpose: Records immutable change history, prior values, timestamps/run IDs and revision relationships.

Execution: LOGIC. Versioning is deterministic.

Input contract: Contracts/I/I11.schema.json#/$defs/CREATE. Required CREATE fields: entity_ref, from_revision, to_revision. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| entity_ref | object | yes |
| from_revision | integer | yes |
| to_revision | integer | yes |

Owned output: I11_record; fields diff, audit_events. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/I/I11.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Version history -> I/J/K/user. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T8 Storage/Context. Rendered inside the I set workspace using T8 Storage/Context; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/I11.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### I12
I12 - Module Completion Tracker

Purpose: Stores module/job completion state based on authoritative validation and dependency rules.

Execution: LOGIC. Workers cannot mark themselves complete without validation.

Input contract: Contracts/I/I12.schema.json#/$defs/CREATE. Required CREATE fields: operation_ref, phase, requirements, evidence_ref, evidence_type. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| operation_ref | object | yes |
| phase | string | yes |
| requirements | array | yes |
| evidence_ref | object | yes |
| evidence_type | enum ['COMMITTED_OUTPUT', 'AUDITED_READ', 'AUDITED_VALIDATION'] | yes |

Owned output: I12_record; fields completion_state, unmet_requirements, evidence. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/I/I12.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Completion/block state -> K/UI. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T8 Storage/Context. Rendered inside the I set workspace using T8 Storage/Context; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/I12.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### I13
I13 - Dependency Tracker

Purpose: Maintains entity/module/data dependency graph used for impact analysis and scheduling.

Execution: LOGIC. Graph operations are deterministic.

Input contract: Contracts/I/I13.schema.json#/$defs/CREATE. Required CREATE fields: source_ref, target_ref, predicate, reason. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| source_ref | object | yes |
| target_ref | object | yes |
| predicate | object | yes |
| reason | string | yes |

Owned output: I13_record; fields edge_id, invalidated_targets. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/I/I13.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Dependency graph/change notifications -> J/K/I06. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T8 Storage/Context. Rendered inside the I set workspace using T8 Storage/Context; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/I13.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### I14
I14 - Data Provenance

Purpose: Records source module, run, worker/resource, context/fact IDs and approval path for accepted information.

Execution: LOGIC. Audit metadata capture is deterministic.

Input contract: Contracts/I/I14.schema.json#/$defs/CREATE. Required CREATE fields: artifact_ref, source_refs, transform_chain, decision_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| artifact_ref | object | yes |
| source_refs | array | yes |
| transform_chain | array | yes |
| decision_refs | array | yes |

Owned output: I14_record; fields provenance_id, chain_hash. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/I/I14.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Provenance records -> I/J/H/user. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T8 Storage/Context. Rendered inside the I set workspace using T8 Storage/Context; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/I14.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### I15
I15 - Context Compression

Purpose: Produces smaller context representations when full source context exceeds worker limits while retaining traceability.

Execution: HYBRID. Deterministic pruning first; AI summarization only when semantic compression is necessary.

Input contract: Contracts/I/I15.schema.json#/$defs/CREATE. Required CREATE fields: context_package_ref, protected_fact_refs, max_tokens, compression_policy. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| context_package_ref | object | yes |
| protected_fact_refs | array | yes |
| max_tokens | integer | yes |
| compression_policy | enum ['OPTIONAL_DESCRIPTIONS_ONLY'] | yes |

Owned output: I15_record; fields compressed_text, preserved_refs, omissions. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/I/I15.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Compressed context + source links -> I07/worker. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T8 Storage/Context. Rendered inside the I set workspace using T8 Storage/Context; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/I15.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

## Applied closure contract
I01 imports typed auxiliary records without changing domain ownership. These profile/source imports are bootstrap inputs and have actual shared schemas. Immutable content hashes exclude lifecycle/provenance sidecar projection updates, eliminating metadata hash cycles.
Shared_Contract.md section 10 and the updated schemas/registry are normative for these corrections. See Verification/Applied_Fixes.json and Verification/closure_check.json for observed artifact checks, and Acceptance_Cases/closure_runtime.cases.json for future application tests.
