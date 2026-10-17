# Bookforge Set B - Story Plot
Revision BF-CLOSURE-1.1 | 14 operations | independent module

This is the current specification. Historical source/addenda are not active instructions. Use Shared_Contract.md for wire formats, lifecycle, ownership, permissions, failures and record storage.

## Set rules and stage order
CREATE stages are B01 -> B02/B03 -> provisional B04/B05 -> B06/B07 -> provisional B10 -> B11 -> selected B08/B09, B12/B13 -> revised B11/B14. B04 and B05 do not require each other for initial drafts. B09/B10 do not require an existing outline; B13 affects revisions rather than the first outline. B14 plans endings from plot obligations before C/E observed evidence exists. B01 goals and B03 constraints may be empty lists. B03 canon_refs can be empty for an initial draft but all asserted facts must resolve before approval.

B11 target length is optional; absent means plan chapter count from supplied plot/structure and return a proposed count for approval. Supplied target length must declare words or chapters and be positive. selected_plan_refs contain only selected outputs. Mystery/foreshadowing disabled means B08/B09 NOT_APPLICABLE; the first B11 does not wait for those outputs. Selected mystery/foreshadowing final plans must be incorporated before final outline approval, through revision feedback rather than hard initial cycles.

Plan records use SemanticRecord structures where the schema declares them. facts assert planned objectives, event IDs, causal predecessors, POV, location, obligations and desired outcomes. B03 obligations remain stable identifiers; B04 subplots, B05 arcs, B06 acts, B07 conflicts, B08 reveals, B09 setup/payoff, B10 chronology, B11 chapters and B12 scenes use stable item IDs represented by fact subject_id. Every obligation is either planned resolved, intentionally unresolved with user approval, or a blocking issue for a final ending. B13 measures distribution against supplied targets; it does not invent universal pacing scores. B14 labels proposed resolutions separately from observed E09/E10 completion.

Acceptance walkthrough: mystery=false and foreshadowing=false; create premise, main plot and initial outline without prose. Create B14 ending, write C prose, then supply an observed unresolved thread. B14 revision reports the mismatch without marking a planned resolution as observed.

## Operation contracts

### B01
B01 - Premise/Concept Builder

Purpose: Creates the central story premise, core dramatic question and concise project concept.

Execution: AI. Creative synthesis normally requires text AI; schema and validation remain logic.

Input contract: Contracts/B/B01.schema.json#/$defs/CREATE. Required CREATE fields: idea, goals. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| idea | string | yes |
| goals | array | yes |
| canon_refs | array | no |

Owned output: B01_record; fields premise, dramatic_question, concept_summary. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/B/B01.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Approved premise -> I; foundation -> B02/B03. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T2 Planner. Rendered inside the B set workspace using T2 Planner; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/B01.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### B02
B02 - Genre/Tone Definition

Purpose: Defines genre, subgenre, tone, audience-facing expectations and tonal constraints.

Execution: HYBRID. Selection/storage can be logic; AI may interpret or propose nuanced tone.

Input contract: Contracts/B/B02.schema.json#/$defs/CREATE. Required CREATE fields: premise_ref, preferences, project_metadata. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| premise_ref | object | yes |
| preferences | object | yes |
| project_metadata | object | yes |

Owned output: B02_record; fields genre_tags, tone_profile, style_constraints. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/B/B02.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Genre/tone profile -> I; C12/D01/F. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T2 Planner. Rendered inside the B set workspace using T2 Planner; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/B02.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### B03
B03 - Main Plot Builder

Purpose: Creates the primary causal sequence of story events and major turning points.

Execution: AI. Plot invention and causal narrative design are semantic/creative.

Input contract: Contracts/B/B03.schema.json#/$defs/CREATE. Required CREATE fields: premise_ref, canon_refs, constraints. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| premise_ref | object | yes |
| tone_ref | object | no |
| canon_refs | array | yes |
| constraints | array | yes |

Owned output: B03_record; fields main_plot, objectives, plot_obligations. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/B/B03.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Main plot -> I; B06/B07/B11/E09. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T2 Planner. Rendered inside the B set workspace using T2 Planner; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/B03.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### B04
B04 - Subplot Builder

Purpose: Creates secondary plotlines tied to characters/themes without displacing the main plot.

Execution: AI. Creative subplot design requires AI when not manually authored.

Input contract: Contracts/B/B04.schema.json#/$defs/CREATE. Required CREATE fields: main_plot_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| main_plot_ref | object | yes |
| character_refs | array | no |

Owned output: B04_record; fields subplots. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/B/B04.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Subplot records -> I; B11/E09/C. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T2 Planner. Rendered inside the B set workspace using T2 Planner; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/B04.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### B05
B05 - Character Arc Planner

Purpose: Plans initial state, pressures, turning points and intended end state for major characters.

Execution: AI. Arc design is semantic; milestone structure/validation is logic.

Input contract: Contracts/B/B05.schema.json#/$defs/CREATE. Required CREATE fields: character_refs, main_plot_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| character_refs | array | yes |
| main_plot_ref | object | yes |
| user_goals | array | no |

Owned output: B05_record; fields arcs. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/B/B05.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Arc records -> I; B11/C/H04. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T2 Planner. Rendered inside the B set workspace using T2 Planner; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/B05.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### B06
B06 - Act/Structure Planner

Purpose: Maps plot events to acts or another selected story structure and verifies required structural positions.

Execution: HYBRID. Templates and placement checks are logic; AI may propose mapping.

Input contract: Contracts/B/B06.schema.json#/$defs/CREATE. Required CREATE fields: main_plot_ref, selected_structure. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| main_plot_ref | object | yes |
| selected_structure | string | yes |
| subplot_refs | array | no |
| arc_refs | array | no |

Owned output: B06_record; fields acts, structure_model. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/B/B06.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Structure plan -> I; B11/B13. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T2 Planner. Rendered inside the B set workspace using T2 Planner; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/B06.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### B07
B07 - Conflict Builder

Purpose: Designs and records internal, interpersonal and external conflicts driving story action.

Execution: AI. Conflict invention/semantic fit generally requires AI.

Input contract: Contracts/B/B07.schema.json#/$defs/CREATE. Required CREATE fields: main_plot_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| main_plot_ref | object | yes |
| canon_refs | array | no |
| arc_refs | array | no |

Owned output: B07_record; fields conflicts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/B/B07.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Conflict records -> I; B03/B11/C. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T2 Planner. Rendered inside the B set workspace using T2 Planner; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/B07.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### B08
B08 - Mystery/Reveal Planner

Purpose: Plans hidden information, clues, discovery sequence and reveal timing.

Execution: AI. Semantic mystery design uses AI; ordering/state constraints use logic.

Input contract: Contracts/B/B08.schema.json#/$defs/CREATE. Required CREATE fields: main_plot_ref, feature_selected. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| main_plot_ref | object | yes |
| knowledge_constraints | array | no |
| feature_selected | boolean | yes |

Owned output: B08_record; fields reveals. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/B/B08.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Reveal plan -> I; B09/B11/E05. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T2 Planner. Rendered inside the B set workspace using T2 Planner; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/B08.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### B09
B09 - Foreshadowing Planner

Purpose: Creates setup/payoff links and plans where clues or thematic signals appear.

Execution: AI. Creative foreshadowing suggestions use AI; link tracking is logic.

Input contract: Contracts/B/B09.schema.json#/$defs/CREATE. Required CREATE fields: main_plot_ref, feature_selected. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| main_plot_ref | object | yes |
| reveal_refs | array | no |
| outline_ref | object | no |
| feature_selected | boolean | yes |

Owned output: B09_record; fields foreshadow_links. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/B/B09.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Foreshadowing links -> I; B11/C/H03. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T2 Planner. Rendered inside the B set workspace using T2 Planner; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/B09.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### B10
B10 - Story Timeline

Purpose: Orders story events in narrative and chronological time and identifies timing conflicts.

Execution: HYBRID. Exact ordering is logic; AI only parses ambiguous temporal prose.

Input contract: Contracts/B/B10.schema.json#/$defs/CREATE. Required CREATE fields: main_plot_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| main_plot_ref | object | yes |
| historical_canon_refs | array | no |
| outline_ref | object | no |

Owned output: B10_record; fields events. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/B/B10.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Story timeline -> I; E03/C. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T2 Planner. Rendered inside the B set workspace using T2 Planner; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/B10.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### B11
B11 - Chapter Outline Generator

Purpose: Partitions approved plot/arc material into chapter objectives, events, POV and required outcomes.

Execution: AI. Creative partitioning uses AI; numbering/completeness checks use logic.

Input contract: Contracts/B/B11.schema.json#/$defs/CREATE. Required CREATE fields: main_plot_ref, selected_plan_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| main_plot_ref | object | yes |
| structure_ref | object | no |
| target_length | object | no |
| selected_plan_refs | array | yes |

Owned output: B11_record; fields chapters, unresolved_threads. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/B/B11.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Chapter outlines -> I; B12/C02/B13. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T2 Planner. Rendered inside the B set workspace using T2 Planner; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/B11.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### B12
B12 - Scene Planner

Purpose: Breaks a chapter into scenes with purpose, participants, location, entry state, events and exit state.

Execution: AI. Scene design uses AI; required-field validation is logic.

Input contract: Contracts/B/B12.schema.json#/$defs/CREATE. Required CREATE fields: outline_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| outline_ref | object | yes |
| canon_refs | array | no |
| observed_state_refs | array | no |

Owned output: B12_record; fields scenes. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/B/B12.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Scene plans -> I; C03/D07/E. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T2 Planner. Rendered inside the B set workspace using T2 Planner; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/B12.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### B13
B13 - Pacing Planner

Purpose: Defines pacing targets and analyzes distribution of action, exposition, tension and recovery.

Execution: HYBRID. Metrics are logic; qualitative pacing interpretation can use AI.

Input contract: Contracts/B/B13.schema.json#/$defs/CREATE. Required CREATE fields: outline_ref, length_targets. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| structure_ref | object | no |
| outline_ref | object | yes |
| scene_refs | array | no |
| length_targets | object | yes |

Owned output: B13_record; fields pacing_targets, pacing_warnings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/B/B13.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Pacing targets/report -> I; C/F03. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T2 Planner. Rendered inside the B set workspace using T2 Planner; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/B13.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### B14
B14 - Ending/Resolution Planner

Purpose: Designs climax, denouement and explicit resolution obligations for plotlines and arcs.

Execution: AI. Resolution design is creative; obligation tracking is logic.

Input contract: Contracts/B/B14.schema.json#/$defs/CREATE. Required CREATE fields: plot_refs, resolution_goals. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| plot_refs | array | yes |
| arc_refs | array | no |
| observed_state_refs | array | no |
| resolution_goals | array | yes |

Owned output: B14_record; fields ending, resolved_obligation_ids, unresolved_obligation_ids. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/B/B14.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Ending/resolution plan -> I; B11/C/H. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T2 Planner. Rendered inside the B set workspace using T2 Planner; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/B14.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

## Applied closure contract
B11 target_length now has value/unit, replacing the SemanticRecord-shaped placeholder. Plan records use section 10 canonical plan facts. Every required chapter/scene item has stable identity, parent/order, objective, event IDs, POV/location and obligations; empty and unknown states retain the stated approval rules.
Shared_Contract.md section 10 and the updated schemas/registry are normative for these corrections. See Verification/Applied_Fixes.json and Verification/closure_check.json for observed artifact checks, and Acceptance_Cases/closure_runtime.cases.json for future application tests.
