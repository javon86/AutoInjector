# Akọwe Set H - Final Quality Control
Revision BF-CLOSURE-1.1 | 10 operations | independent module

This is the current specification. Historical source/addenda are not active instructions. Use Shared_Contract.md for wire formats, lifecycle, ownership, permissions, failures and record storage.

## Set rules and exact release gate
H01 full read-through checks goals/coverage; H02 canon facts; H03 required plot resolutions; H04 required character arcs; H05 missing/duplicate content; H06 selected art; H07 layout; H08 TOC/navigation; H09 actual export bytes; H10 aggregates. Each report records pinned inputs, checker/policy revision, inspected coverage, findings and result. H owns reports only and requests repair from C/F/D/G/J.

Semantic findings are not deterministic truth. H01-H04/H06 must cite exact evidence, record inspected chunks and unresolved uncertainty, and require authorized human disposition for blocking/uncertain claims. Schema validity alone cannot pass the story. No skipped context window may be counted reviewed. H05 deterministically compares selected chapter/scene IDs and order. H07 identifies page number and bounding box crossing safe margins; H08 checks all targets against exact export anchors/page map. H09 checks every selected format, exact hash, expected assets and parser/tool results. Missing tool is UNKNOWN VALIDATOR_UNAVAILABLE, not PASS. EPUBCheck errors are FAIL.

Applicability is evaluated after shared envelope/authorization validation and before feature-specific payload validation. H06 is NOT_APPLICABLE when artwork=false with no selected assets; no missing art fields block text-only publication. Print layout checks are inapplicable to reflowable EPUB; anchor/link checks still apply. A disabled check retains a record of its manifest predicate/reason. H10 selects required reports from the frozen release manifest; it never requires unselected exports. Empty required check set is BLOCKED unless explicit user policy authorizes an empty phase.

H10 READY requires all selected required reports PASS at matching source/export hashes and policy versions, no unresolved blocking/unknown finding, and valid publication authorization. NOT_APPLICABLE counts only if the profile excludes the check; it is not a PASS. FAIL/UNKNOWN/stale/missing evidence gives BLOCKED with exact affected reports. Nonblocking minor findings are visible; waiver policy permits authorized disposition of semantic uncertainty only, not missing files, invalid hashes, denied permission or broken structural integrity. Freeze ready manifest; later edits invalidate affected H reports/H10.

Acceptance walkthrough: PDF-only, art disabled, H06 NOT_APPLICABLE; remaining required reports valid and H10 READY after actual reviewer authorization. Change one export byte: hash mismatch blocks H09/H10 while retained unrelated report hashes remain unchanged.

## Operation contracts

### H01
H01 - Full Book Read-Through

Purpose: Performs a holistic semantic read of the finished manuscript to find issues missed by localized checks.

Execution: AI. Holistic semantic reading requires AI.

Input contract: Contracts/H/H01.schema.json#/$defs/CREATE. Required CREATE fields: manuscript_ref, project_goals_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| manuscript_ref | object | yes |
| project_goals_ref | object | yes |

Owned output: H01_record; fields operation, status, source_refs, findings, result_revision, checker_version, coverage_refs, policy_ref. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/H/H01.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Whole-book review -> K/F/J/user. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T6 Checker/Validator. Rendered inside the H set workspace using T6 Checker/Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/H01.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### H02
H02 - Canon Verification

Purpose: Performs final verification that finished content does not violate approved/locked canon.

Execution: HYBRID. Exact checks are logic; semantic contradictions may use AI.

Input contract: Contracts/H/H02.schema.json#/$defs/CREATE. Required CREATE fields: manuscript_ref, canon_snapshot_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| manuscript_ref | object | yes |
| canon_snapshot_ref | object | yes |

Owned output: H02_record; fields operation, status, source_refs, findings, result_revision, checker_version, coverage_refs, policy_ref. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/H/H02.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Canon verification report -> K/J/F. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T6 Checker/Validator. Rendered inside the H set workspace using T6 Checker/Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/H02.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### H03
H03 - Plot Resolution Check

Purpose: Verifies required plot/subplot obligations are resolved or intentionally left open.

Execution: HYBRID. Lifecycle checks are logic; semantic payoff judgment may use AI.

Input contract: Contracts/H/H03.schema.json#/$defs/CREATE. Required CREATE fields: manuscript_ref, plot_plan_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| manuscript_ref | object | yes |
| plot_plan_ref | object | yes |

Owned output: H03_record; fields operation, status, source_refs, findings, result_revision, checker_version, coverage_refs, policy_ref. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/H/H03.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Resolution report -> K/B/F. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T6 Checker/Validator. Rendered inside the H set workspace using T6 Checker/Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/H03.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### H04
H04 - Character Arc Completion Check

Purpose: Verifies intended character arc milestones/end states are represented in the finished work.

Execution: HYBRID. Tagged milestones are logic; semantic realization may use AI.

Input contract: Contracts/H/H04.schema.json#/$defs/CREATE. Required CREATE fields: manuscript_ref, character_arcs_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| manuscript_ref | object | yes |
| character_arcs_ref | object | yes |

Owned output: H04_record; fields operation, status, source_refs, findings, result_revision, checker_version, coverage_refs, policy_ref. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/H/H04.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Arc completion report -> K/B/F. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T6 Checker/Validator. Rendered inside the H set workspace using T6 Checker/Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/H04.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### H05
H05 - Missing/Duplicate Content Check

Purpose: Detects missing, duplicated, empty or incorrectly repeated chapters/sections/assets.

Execution: LOGIC. Manifest comparison is deterministic.

Input contract: Contracts/H/H05.schema.json#/$defs/CREATE. Required CREATE fields: manuscript_ref, chapter_manifest_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| manuscript_ref | object | yes |
| chapter_manifest_ref | object | yes |

Owned output: H05_record; fields operation, status, source_refs, findings, result_revision, checker_version, coverage_refs, policy_ref. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/H/H05.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Structural error report -> G/K. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T6 Checker/Validator. Rendered inside the H set workspace using T6 Checker/Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/H05.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### H06
H06 - Artwork Consistency Check

Purpose: Performs final check that included artwork matches approved visual references and placement intent.

Execution: HYBRID. Metadata checks are logic; image-semantic comparison may use vision AI.

Input contract: Contracts/H/H06.schema.json#/$defs/CREATE. Required CREATE fields: asset_manifest_ref, approved_visual_bible_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| asset_manifest_ref | object | yes |
| approved_visual_bible_ref | object | yes |

Owned output: H06_record; fields operation, status, source_refs, findings, result_revision, checker_version, coverage_refs, policy_ref. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/H/H06.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Visual QC report -> D/G/K. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T6 Checker/Validator. Rendered inside the H set workspace using T6 Checker/Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/H06.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### H07
H07 - Page/Layout Inspection

Purpose: Checks final pages for overflow, clipping, collisions, blank anomalies, margin/bleed and other layout defects.

Execution: LOGIC/HYBRID. Geometry checks are logic; optional visual inspection AI may supplement.

Input contract: Contracts/H/H07.schema.json#/$defs/CREATE. Required CREATE fields: export_ref, layout_profile_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| export_ref | object | yes |
| layout_profile_ref | object | yes |

Owned output: H07_record; fields operation, status, source_refs, findings, result_revision, checker_version, coverage_refs, policy_ref. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/H/H07.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Layout QC report -> G/K. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T6 Checker/Validator. Rendered inside the H set workspace using T6 Checker/Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/H07.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### H08
H08 - TOC/Page Reference Check

Purpose: Verifies TOC entries, page references, anchors and navigation targets.

Execution: LOGIC. Reference resolution is deterministic.

Input contract: Contracts/H/H08.schema.json#/$defs/CREATE. Required CREATE fields: export_ref, toc_manifest_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| export_ref | object | yes |
| toc_manifest_ref | object | yes |

Owned output: H08_record; fields operation, status, source_refs, findings, result_revision, checker_version, coverage_refs, policy_ref. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/H/H08.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Reference QC report -> G/K. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T6 Checker/Validator. Rendered inside the H set workspace using T6 Checker/Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/H08.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### H09
H09 - Export/File Integrity Check

Purpose: Validates generated files, package structure, expected assets and basic open/read integrity.

Execution: LOGIC. File/package validation is deterministic.

Input contract: Contracts/H/H09.schema.json#/$defs/CREATE. Required CREATE fields: export_refs, expected_manifest_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| export_refs | array | yes |
| expected_manifest_ref | object | yes |

Owned output: H09_record; fields operation, status, source_refs, findings, result_revision, checker_version, coverage_refs, policy_ref. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/H/H09.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Integrity report -> K/user. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T6 Checker/Validator. Rendered inside the H set workspace using T6 Checker/Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/H09.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### H10
H10 - Final Readiness Report

Purpose: Aggregates H01-H09 evidence and applies release gates without overriding unresolved blocking failures.

Execution: LOGIC/HYBRID. Gate aggregation is logic; AI may summarize evidence but cannot set pass status.

Input contract: Contracts/H/H10.schema.json#/$defs/CREATE. Required CREATE fields: check_report_refs, release_profile_ref, release_manifest_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| check_report_refs | array | yes |
| release_profile_ref | object | yes |
| release_manifest_ref | object | yes |

Owned output: H10_record; fields operation, status, source_refs, findings, result_revision, checker_version, coverage_refs, policy_ref. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/H/H10.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Final readiness state/report -> K/user. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T6 Checker/Validator. Rendered inside the H set workspace using T6 Checker/Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/H10.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

## Applied closure contract
Typed OUTPUT_PROFILE/RELEASE_MANIFEST and selected exports govern approval. A manifest contains exact source/export/profile/check pins and a nullable pending publication authorization; only H10 final approval requires the current valid authorization. Checking source acceptance does not require prior H10 approval.
Shared_Contract.md section 10 and the updated schemas/registry are normative for these corrections. See Verification/Applied_Fixes.json and Verification/closure_check.json for observed artifact checks, and Acceptance_Cases/closure_runtime.cases.json for future application tests.
