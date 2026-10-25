# Akọwe Set C - Writing
Revision BF-CLOSURE-1.1 | 12 operations | independent module

This is the current specification. Historical source/addenda are not active instructions. Use Shared_Contract.md for wire formats, lifecycle, ownership, permissions, failures and record storage.

## Set rules and manuscript authority
C01 deterministically retrieves pinned outline, A constraints, entry E state and C12 style. Package includes verbatim mandatory/protected facts and output schema; tokenize with the chosen adapter tokenizer. No text or existing draft is required to load first context. C02 produces chapter prose; C03 scene prose; C04 dialogue honors speaker knowledge; C05 location description may omit D visuals; C06 actions require A09 only when uses_magic=true and A11 when is_combat=true. Missing applicable rule ref returns MISSING_INPUT at its field. C07 interior thought cannot assert knowledge absent from E05. C08 transitions do not invent intervening events. C09 FIRST/ONLY requires no previous ending; MIDDLE/LAST needs previous_ending_ref. C10 LAST/ONLY requires no next chapter; FIRST/MIDDLE needs next_chapter_ref. C11 requires passage_ref and a matching base text for rewrite. C12 owns scope-specific style; a style change triggers only consumers of that profile.

C owns the accepted manuscript, its ordered chapter/scene/passage IDs and append-only revisions. New prose is a candidate until schema, protected facts, plan objectives and acceptance policy pass. C returns candidate_events=[] in prose OUTPUT and stores extracted candidates in a separate CEventBundle with exact source spans and prose pins; it never commits E state. For generation before the prose record exists, stage candidate events and bind source_ref after the candidate prose revision has been stored. If source reference cannot be resolved, events remain candidate and cannot become accepted E evidence.

Generation output text must be nonempty. Validate every applicable outline objective as satisfied, unsatisfied or uncertain with span evidence. Unknown semantic meaning requires review; never automatically mark protected contradictions as approval. C04-C10 specialized prose is inserted only at an explicitly selected span/scene in a new manuscript candidate; it never replaces an entire chapter silently. Unrelated passages keep their hashes. C maintains source-to-passage dependencies so F/J patches can locate exact spans. Replacing accepted prose supersedes derived E events and invalidates downstream F/G/H reads.

Acceptance walkthrough: FIRST chapter opening from outline without a prior ending; reject a middle opening missing prior context. Write nonmagical action without power rules. Accept prose, route candidate events to E, then rewrite an earlier passage and require E replay. C cannot change A appearance or E snapshots directly.

## Operation contracts

### C01
C01 - Chapter Context Loader

Purpose: Builds a bounded, traceable context package containing only information needed for the current writing job.

Execution: LOGIC. Retrieval, filtering, token budgeting and provenance are deterministic.

Input contract: Contracts/C/C01.schema.json#/$defs/CREATE. Required CREATE fields: chapter_id, outline_ref, instruction. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| chapter_id | string | yes |
| outline_ref | object | yes |
| constraints | array | no |
| instruction | string | yes |

Owned output: C01_record; fields facts, protected_facts, output_schema_ref, token_count. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/C/C01.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Context package -> C02-C11 and selected AI resource. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T3 Generator / T4 Editor. Rendered inside the C set workspace using T3 Generator / T4 Editor; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/C01.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### C02
C02 - Chapter Writer

Purpose: Generates a complete chapter that fulfills the approved chapter outline without silently changing canon.

Execution: AI. Long-form prose generation requires text AI unless manually authored.

Input contract: Contracts/C/C02.schema.json#/$defs/CREATE. Required CREATE fields: chapter_id, outline_ref, context_ref, instruction. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| chapter_id | string | yes |
| outline_ref | object | yes |
| context_ref | object | yes |
| constraints | array | no |
| instruction | string | yes |

Owned output: C02_record; fields text, candidate_events, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/C/C02.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Chapter candidate -> validation/I/manuscript; events -> E. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T3 Generator / T4 Editor. Rendered inside the C set workspace using T3 Generator / T4 Editor; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/C02.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### C03
C03 - Scene Writer

Purpose: Generates a scene from its plan while preserving entry/exit state, canon and chapter objectives.

Execution: AI. Scene prose is generative.

Input contract: Contracts/C/C03.schema.json#/$defs/CREATE. Required CREATE fields: scene_id, scene_plan_ref, context_ref, instruction. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| scene_id | string | yes |
| scene_plan_ref | object | yes |
| context_ref | object | yes |
| constraints | array | no |
| instruction | string | yes |

Owned output: C03_record; fields text, candidate_events, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/C/C03.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Scene candidate -> manuscript; state/event extraction -> E. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T3 Generator / T4 Editor. Rendered inside the C set workspace using T3 Generator / T4 Editor; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/C03.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### C04
C04 - Dialogue Writer

Purpose: Creates or rewrites dialogue consistent with character voice, knowledge, relationship and scene objective.

Execution: AI. Dialogue generation is semantic/creative.

Input contract: Contracts/C/C04.schema.json#/$defs/CREATE. Required CREATE fields: scene_id, scene_plan_ref, speaker_ids, instruction. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| scene_id | string | yes |
| scene_plan_ref | object | yes |
| speaker_ids | array | yes |
| constraints | array | no |
| instruction | string | yes |

Owned output: C04_record; fields text, candidate_events, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/C/C04.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Dialogue candidate -> C03/manuscript/F05. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T3 Generator / T4 Editor. Rendered inside the C set workspace using T3 Generator / T4 Editor; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/C04.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### C05
C05 - Description/Atmosphere Writer

Purpose: Generates sensory/environmental description consistent with location canon, POV and tone.

Execution: AI. Creative descriptive prose requires AI.

Input contract: Contracts/C/C05.schema.json#/$defs/CREATE. Required CREATE fields: scene_id, scene_plan_ref, instruction. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| scene_id | string | yes |
| scene_plan_ref | object | yes |
| visual_ref | object | no |
| constraints | array | no |
| instruction | string | yes |

Owned output: C05_record; fields text, candidate_events, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/C/C05.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Description -> manuscript. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T3 Generator / T4 Editor. Rendered inside the C set workspace using T3 Generator / T4 Editor; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/C05.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### C06
C06 - Action/Combat Writer

Purpose: Generates action/combat prose constrained by participants, weapons, powers, environment and state.

Execution: AI. Prose generation uses AI; rule/state validation is logic.

Input contract: Contracts/C/C06.schema.json#/$defs/CREATE. Required CREATE fields: scene_id, action_plan_ref, instruction. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| scene_id | string | yes |
| action_plan_ref | object | yes |
| uses_magic | boolean | no |
| power_rules_ref | object | no |
| is_combat | boolean | no |
| combat_rules_ref | object | no |
| constraints | array | no |
| instruction | string | yes |

Owned output: C06_record; fields text, candidate_events, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/C/C06.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Action prose -> manuscript; state deltas -> E. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T3 Generator / T4 Editor. Rendered inside the C set workspace using T3 Generator / T4 Editor; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/C06.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### C07
C07 - Emotional/Internal Narrative

Purpose: Generates internal thought/emotion aligned with character arc, knowledge and current state.

Execution: AI. Semantic interiority generation requires AI.

Input contract: Contracts/C/C07.schema.json#/$defs/CREATE. Required CREATE fields: scene_id, instruction. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| scene_id | string | yes |
| emotion_plan_ref | object | no |
| constraints | array | no |
| instruction | string | yes |

Owned output: C07_record; fields text, candidate_events, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/C/C07.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Internal narrative -> manuscript. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T3 Generator / T4 Editor. Rendered inside the C set workspace using T3 Generator / T4 Editor; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/C07.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### C08
C08 - Transition Writer

Purpose: Generates concise transitions between scenes, locations, POVs or time periods without inventing unsupported events.

Execution: AI. Natural prose generation uses AI; temporal validity is logic.

Input contract: Contracts/C/C08.schema.json#/$defs/CREATE. Required CREATE fields: from_scene_id, to_scene_id, transition_goal, instruction. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| from_scene_id | string | yes |
| to_scene_id | string | yes |
| transition_goal | string | yes |
| constraints | array | no |
| instruction | string | yes |

Owned output: C08_record; fields text, candidate_events, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/C/C08.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Transition text -> manuscript. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T3 Generator / T4 Editor. Rendered inside the C set workspace using T3 Generator / T4 Editor; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/C08.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### C09
C09 - Chapter Opening/Hook

Purpose: Creates or revises the opening to establish orientation and reader momentum while honoring chapter intent.

Execution: AI. Hook prose is creative.

Input contract: Contracts/C/C09.schema.json#/$defs/CREATE. Required CREATE fields: chapter_id, outline_ref, instruction, chapter_position. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| chapter_id | string | yes |
| outline_ref | object | yes |
| previous_ending_ref | object | no |
| constraints | array | no |
| instruction | string | yes |
| chapter_position | enum ['FIRST', 'MIDDLE', 'LAST', 'ONLY'] | yes |

Owned output: C09_record; fields text, candidate_events, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/C/C09.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Opening candidate -> manuscript. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T3 Generator / T4 Editor. Rendered inside the C set workspace using T3 Generator / T4 Editor; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/C09.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### C10
C10 - Chapter Ending

Purpose: Creates or revises chapter closure, cliffhanger or transition consistent with next planned state.

Execution: AI. Ending prose is creative.

Input contract: Contracts/C/C10.schema.json#/$defs/CREATE. Required CREATE fields: chapter_id, outline_ref, instruction, chapter_position. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| chapter_id | string | yes |
| outline_ref | object | yes |
| next_chapter_ref | object | no |
| constraints | array | no |
| instruction | string | yes |
| chapter_position | enum ['FIRST', 'MIDDLE', 'LAST', 'ONLY'] | yes |

Owned output: C10_record; fields text, candidate_events, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/C/C10.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Ending candidate -> manuscript. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T3 Generator / T4 Editor. Rendered inside the C set workspace using T3 Generator / T4 Editor; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/C10.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### C11
C11 - Rewrite/Expansion

Purpose: Performs bounded rewrite, expansion, compression or transformation while preserving specified facts and constraints.

Execution: AI. Semantic rewriting requires AI; protected-fact validation is logic.

Input contract: Contracts/C/C11.schema.json#/$defs/CREATE. Required CREATE fields: passage_id, rewrite_goal, instruction, passage_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| passage_id | string | yes |
| rewrite_goal | string | yes |
| constraints | array | no |
| instruction | string | yes |
| passage_ref | object | yes |

Owned output: C11_record; fields text, candidate_events, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/C/C11.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Replacement text + change metadata -> manuscript/F. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T3 Generator / T4 Editor. Rendered inside the C set workspace using T3 Generator / T4 Editor; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/C11.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### C12
C12 - Writing Style Controller

Purpose: Stores and enforces POV, tense, voice, style constraints, prohibited tendencies and project-specific writing rules.

Execution: HYBRID. Rules can be checked deterministically where possible; semantic style analysis may use AI.

Input contract: Contracts/C/C12.schema.json#/$defs/CREATE. Required CREATE fields: style_goal, scope_id, instruction. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| style_goal | string | yes |
| scope_id | string | yes |
| constraints | array | no |
| instruction | string | yes |

Owned output: C12_record; fields style_goal, style_profile. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/C/C12.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Style profile -> I/C/F; style warnings -> C/F. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T3 Generator / T4 Editor. Rendered inside the C set workspace using T3 Generator / T4 Editor; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/C12.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

## Applied closure contract
Prose OUTPUT candidate_events is empty. A separate CEventBundle cites already-stored prose; refer to Shared Contract section 10 for extraction resume and acyclic hashes. All manuscript inputs route only from C-owned prose or an explicitly compiled G manuscript, never F proposals.
Shared_Contract.md section 10 and the updated schemas/registry are normative for these corrections. See Verification/Applied_Fixes.json and Verification/closure_check.json for observed artifact checks, and Acceptance_Cases/closure_runtime.cases.json for future application tests.
