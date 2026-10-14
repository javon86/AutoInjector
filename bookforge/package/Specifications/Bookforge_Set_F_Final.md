# Bookforge Set F - Editing Refinement
Revision BF-CLOSURE-1.1 | 12 operations | independent module

This is the current specification. Historical source/addenda are not active instructions. Use Shared_Contract.md for wire formats, lifecycle, ownership, permissions, failures and record storage.

## Set rules and safe edit application
Initial F01 review requires manuscript and selected story goals; existing E/H findings are conditional. F02 checks structural order; F03 pacing against declared targets; F04 character/arc consistency; F05 speaker voice/knowledge; F06 prose/style; F07 repeated content; F08 clarity for target audience; F09 language/spelling with protected names; F10 chapter continuity; F11 meaning-preserving line edits; F12 final polish. None may directly change canon/state or mutate accepted C prose.

Each finding cites a pinned text span, criterion, severity, confidence and suggested repair. Return patches as owner requests with base target_ref, exact JSON pointer or resolved text span, replacement, reason and approval reference. Convert a textual edit into a C-owned replacement candidate with precondition text_hash. Overlapping spans from concurrent editors produce PATCH_OVERLAP; queue merge/review rather than choosing the last writer. Stale source yields VERSION_CONFLICT; failure leaves prior manuscript and unrelated hashes unchanged. Stage nonoverlapping patches, validate the complete candidate, then have C accept it atomically. Store inverse source content for recovery; compensation can restore only if no intervening revision exists.

F07 exact repeats compare NFC/casefolded whitespace-normalized text within comparison_scope; protected names/excluded_terms are excluded. exact_min_occurrences >=2. Near-repeat candidates use token Jaccard similarity (intersection/union of Unicode word tokens), threshold from input; empty/empty score=1 and one-empty score=0. Similarity flags a candidate rather than deleting text. F09 confidence below confidence_floor yields UNKNOWN/review. F10 chapter_position FIRST/ONLY omits previous_chapter_ref; LAST/ONLY omits next_chapter_ref; the other applicable neighbor is required. F11 meaning_preservation must be true and protected facts unchanged. F12 requires no unresolved blocking refs, pinned approved manuscript/canon and authorization for the exact polish candidate; changed prose renews checks.

Accepting any edit produces a new C manuscript revision and affected dependency events. Final polish invalidates only the assembled artifacts and QC checks that read changed content. Freeze publication only after checks on that new exact revision. An attractive edit is not proof of protected-fact preservation.

Acceptance walkthrough: developmental review runs before final H review. Two edits overlap one sentence: neither overwrites the other silently. Accept one approved line edit through C, then confirm relevant G/H reports are stale and unrelated chapters retain their hashes.

## Operation contracts

### F01
F01 - Developmental Editor

Purpose: Reviews the manuscript at whole-story level for major narrative weaknesses and actionable revisions.

Execution: AI. Whole-story semantic critique requires AI.

Input contract: Contracts/F/F01.schema.json#/$defs/CREATE. Required CREATE fields: story_goal, stakes, arc_expectations, manuscript_ref, instruction, span_ids. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| story_goal | string | yes |
| stakes | string | yes |
| arc_expectations | array | yes |
| manuscript_ref | object | yes |
| instruction | string | yes |
| span_ids | array | yes |

Owned output: F01_record; fields kind, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/F/F01.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Developmental report/proposed jobs -> user/K/B/C. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T4 Editor/Rewriter. Rendered inside the F set workspace using T4 Editor/Rewriter; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/F01.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### F02
F02 - Story Structure Editor

Purpose: Compares manuscript structure to approved act/plot design and identifies misplaced/missing structural functions.

Execution: HYBRID. Structural mapping is logic where tagged; semantic scene function may use AI.

Input contract: Contracts/F/F02.schema.json#/$defs/CREATE. Required CREATE fields: chapter_order, manuscript_ref, instruction, span_ids. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| beat_map_ref | object | no |
| chapter_order | array | yes |
| manuscript_ref | object | yes |
| instruction | string | yes |
| span_ids | array | yes |

Owned output: F02_record; fields kind, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/F/F02.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Structure report/revisions -> B/C/K. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T4 Editor/Rewriter. Rendered inside the F set workspace using T4 Editor/Rewriter; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/F02.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### F03
F03 - Pacing Editor

Purpose: Measures and evaluates pacing across chapters/scenes and proposes localized changes.

Execution: HYBRID. Metrics are logic; qualitative pacing judgment may use AI.

Input contract: Contracts/F/F03.schema.json#/$defs/CREATE. Required CREATE fields: scene_lengths, manuscript_ref, instruction, span_ids. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| scene_lengths | array | yes |
| pacing_targets | string | no |
| manuscript_ref | object | yes |
| instruction | string | yes |
| span_ids | array | yes |

Owned output: F03_record; fields kind, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/F/F03.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Pacing report/revision requests -> C/K. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T4 Editor/Rewriter. Rendered inside the F set workspace using T4 Editor/Rewriter; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/F03.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### F04
F04 - Characterization Editor

Purpose: Checks behavior/voice/development against character canon and arcs and proposes corrections.

Execution: AI. Semantic characterization review requires AI.

Input contract: Contracts/F/F04.schema.json#/$defs/CREATE. Required CREATE fields: character_refs, manuscript_ref, instruction, span_ids. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| character_refs | array | yes |
| arc_intent | string | no |
| manuscript_ref | object | yes |
| instruction | string | yes |
| span_ids | array | yes |

Owned output: F04_record; fields kind, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/F/F04.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Characterization issues/revisions -> C/K. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T4 Editor/Rewriter. Rendered inside the F set workspace using T4 Editor/Rewriter; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/F04.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### F05
F05 - Dialogue Editor

Purpose: Improves dialogue clarity, naturalness, differentiation and character consistency.

Execution: AI. Semantic dialogue editing requires AI.

Input contract: Contracts/F/F05.schema.json#/$defs/CREATE. Required CREATE fields: speaker_map, dialogue_spans, manuscript_ref, instruction, span_ids. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| speaker_map | object | yes |
| dialogue_spans | array | yes |
| manuscript_ref | object | yes |
| instruction | string | yes |
| span_ids | array | yes |

Owned output: F05_record; fields kind, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/F/F05.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Revised dialogue -> manuscript. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T4 Editor/Rewriter. Rendered inside the F set workspace using T4 Editor/Rewriter; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/F05.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### F06
F06 - Prose/Style Editor

Purpose: Improves prose while enforcing approved voice, POV, tense and style constraints.

Execution: AI. Semantic style editing requires AI.

Input contract: Contracts/F/F06.schema.json#/$defs/CREATE. Required CREATE fields: prose_spans, manuscript_ref, instruction, span_ids. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| style_ref | object | no |
| prose_spans | array | yes |
| manuscript_ref | object | yes |
| instruction | string | yes |
| span_ids | array | yes |

Owned output: F06_record; fields kind, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/F/F06.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Prose revisions -> manuscript. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T4 Editor/Rewriter. Rendered inside the F set workspace using T4 Editor/Rewriter; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/F06.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### F07
F07 - Repetition Detector

Purpose: Detects repeated words, phrases, constructions and optionally semantic repetition.

Execution: LOGIC/HYBRID. Lexical repetition is logic; semantic repetition may use AI.

Input contract: Contracts/F/F07.schema.json#/$defs/CREATE. Required CREATE fields: exact_min_occurrences, similarity_threshold, comparison_scope, excluded_terms, manuscript_ref, instruction, span_ids. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| exact_min_occurrences | integer | yes |
| similarity_threshold | number | yes |
| comparison_scope | enum ['chapter', 'book'] | yes |
| excluded_terms | array | yes |
| manuscript_ref | object | yes |
| instruction | string | yes |
| span_ids | array | yes |

Owned output: F07_record; fields kind, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/F/F07.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Repetition report/fix candidates -> F/C. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T4 Editor/Rewriter. Rendered inside the F set workspace using T4 Editor/Rewriter; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/F07.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### F08
F08 - Clarity Editor

Purpose: Identifies confusing references, ambiguous sentences and difficult passages and proposes clearer wording.

Execution: AI. Semantic ambiguity/rewriting requires AI.

Input contract: Contracts/F/F08.schema.json#/$defs/CREATE. Required CREATE fields: target_audience, ambiguous_spans, manuscript_ref, instruction, span_ids. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| target_audience | string | yes |
| ambiguous_spans | array | yes |
| manuscript_ref | object | yes |
| instruction | string | yes |
| span_ids | array | yes |

Owned output: F08_record; fields kind, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/F/F08.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Clarity revisions -> manuscript. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T4 Editor/Rewriter. Rendered inside the F set workspace using T4 Editor/Rewriter; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/F08.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### F09
F09 - Grammar/Spelling

Purpose: Detects spelling, punctuation and grammar errors with protected-name dictionaries.

Execution: LOGIC/HYBRID. Dictionary/rule checks are logic; ambiguous grammar may use AI.

Input contract: Contracts/F/F09.schema.json#/$defs/CREATE. Required CREATE fields: language_tag, protected_names_ref, confidence_floor, manuscript_ref, instruction, span_ids. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| language_tag | string | yes |
| protected_names_ref | object | yes |
| confidence_floor | number | yes |
| manuscript_ref | object | yes |
| instruction | string | yes |
| span_ids | array | yes |

Owned output: F09_record; fields kind, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/F/F09.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Mechanical corrections -> manuscript. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T4 Editor/Rewriter. Rendered inside the F set workspace using T4 Editor/Rewriter; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/F09.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### F10
F10 - Chapter Transition Editor

Purpose: Evaluates and repairs transitions between chapter endings/openings.

Execution: AI. Natural transition rewriting is semantic.

Input contract: Contracts/F/F10.schema.json#/$defs/CREATE. Required CREATE fields: chapter_position, manuscript_ref, instruction, span_ids. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| chapter_position | enum ['first', 'middle', 'last', 'only'] | yes |
| previous_chapter_ref | object | no |
| next_chapter_ref | object | no |
| manuscript_ref | object | yes |
| instruction | string | yes |
| span_ids | array | yes |

Owned output: F10_record; fields kind, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/F/F10.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Transition revisions -> manuscript. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T4 Editor/Rewriter. Rendered inside the F set workspace using T4 Editor/Rewriter; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/F10.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### F11
F11 - Line Editor

Purpose: Performs sentence/paragraph-level refinement without changing protected facts or intended meaning.

Execution: AI. Fine semantic rewriting requires AI.

Input contract: Contracts/F/F11.schema.json#/$defs/CREATE. Required CREATE fields: voice_profile_ref, protected_facts_ref, meaning_preservation, manuscript_ref, instruction, span_ids. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| voice_profile_ref | object | yes |
| protected_facts_ref | object | yes |
| meaning_preservation | structured | yes |
| manuscript_ref | object | yes |
| instruction | string | yes |
| span_ids | array | yes |

Owned output: F11_record; fields kind, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/F/F11.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Line-edited text -> manuscript. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T4 Editor/Rewriter. Rendered inside the F set workspace using T4 Editor/Rewriter; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/F11.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### F12
F12 - Final Manuscript Polish

Purpose: Performs the final controlled prose pass after substantive issues are resolved.

Execution: AI. Final prose refinement is semantic; validation remains logic.

Input contract: Contracts/F/F12.schema.json#/$defs/CREATE. Required CREATE fields: approved_manuscript_ref, unresolved_blockers, locked_canon_ref, manuscript_ref, instruction, span_ids. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| approved_manuscript_ref | object | yes |
| unresolved_blockers | object | yes |
| approval_ref | object | no |
| locked_canon_ref | object | yes |
| manuscript_ref | object | yes |
| instruction | string | yes |
| span_ids | array | yes |

Owned output: F12_record; fields kind, findings, patches. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/F/F12.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Polished manuscript -> G/H. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T4 Editor/Rewriter. Rendered inside the F set workspace using T4 Editor/Rewriter; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/F12.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

## Applied closure contract
F results are edit proposals/reports and cannot serve as accepted manuscript pins. Manuscript inputs resolve C-owned prose; neighbor and protection/style fields use exact producer bindings. Acceptance and source spans refer to the exact new C revision.
Shared_Contract.md section 10 and the updated schemas/registry are normative for these corrections. See Verification/Applied_Fixes.json and Verification/closure_check.json for observed artifact checks, and Acceptance_Cases/closure_runtime.cases.json for future application tests.
