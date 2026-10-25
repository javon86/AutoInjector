# Akọwe Set E - Continuity State
Revision BF-CLOSURE-1.1 | 12 operations | independent module

This is the current specification. Historical source/addenda are not active instructions. Use Shared_Contract.md for wire formats, lifecycle, ownership, permissions, failures and record storage.

## Set rules, baseline and event replay
E01 character state, E02 location, E03 chronology, E04 relationship, E05 knowledge, E06 injuries, E07 inventory, E08 power state, E09 plot threads and E10 unresolved events are projections of accepted events. E11 checks adjacent chapter/scene state and coordinates replay impact; E12 compares manuscript claims with A/E and sends candidates to J. E does not rewrite A or C.

INITIALIZE requires applicable approved A/B baseline source_refs; events=[] is valid. If there are no selected baseline facts, initialize a known empty snapshot and record the selection reason. APPLY requires at least one ACCEPTED event from accepted C prose and an exact base_ref to the current snapshot (use UPDATE with a candidate produced from CREATE). REPLAY requires current_snapshot_ref and superseded_event_ids; checkpoint_ref is optional and absence starts at the approved baseline. CHECK requires source_refs including pinned manuscript/state/canon appropriate to its purpose, and produces findings without changing snapshots. mode-specific missing inputs block with exact paths. The old value/action fields were removed: a caller cannot inject unexplained state as a deterministic result.

Events use story_time ticks and (scene_order,event_order,event_id) for deterministic tie ordering; scene narrative order does not erase chronology. Verify evidence spans and all source pins. Ambiguous prose extraction stays CANDIDATE; accepted prose alone is insufficient to authorize an ambiguous event. Before must match projected state. SET replaces the named scalar/list; ADD appends a new scalar list item only if absent; REMOVE requires the item present. Invalid before/value, negative inventory, impossible chronology or power use exceeding A09 limits produces a finding and commits no invalid state. All affected entity projections from one accepted event batch commit atomically with the event ledger and outbox.

Rewrite/replay: supersede events from replaced C source pins; find impacted entities and their temporal/dependency descendants; start at the newest checkpoint preceding the earliest affected event; replay remaining accepted events in chronological order with deterministic tie order; mark all impacted later snapshots stale until replay commits. If no checkpoint exists, start from baseline. Preserve old snapshots/history and unaffected branch hashes. An event moved to another branch cannot mutate the original branch implicitly. E05 distinguishes reader knowledge from each character's knowledge; a character can act only on accepted learned facts at or before scene time. E06 tracks conditions/recovery without assuming medical universals; configured fictional rules apply. E09/E10 distinguish planned, observed resolved and unresolved, and cite manuscript evidence.

Acceptance walkthrough: initialize a first character without C events; accept one location-change event once despite duplicate delivery; rewrite the earlier source and replay from baseline/checkpoint. Old event becomes SUPERSEDED, later affected state is rebuilt and unrelated entities remain byte-identical.

## Operation contracts

### E01
E01 - Character State Tracker

Purpose: Maintains per-story-point character state such as status, condition, role and temporary attributes.

Execution: LOGIC. Structured event application and snapshots are deterministic.

Input contract: Contracts/E/E01.schema.json#/$defs/CREATE. Required CREATE fields: character_id, mode, events, source_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| character_id | string | yes |
| mode | enum ['INITIALIZE', 'APPLY', 'REPLAY', 'CHECK'] | yes |
| baseline_ref | object | no |
| checkpoint_ref | object | no |
| events | array | yes |
| superseded_event_ids | array | no |
| source_refs | array | yes |
| current_snapshot_ref | object | no |

Owned output: E01_record; fields entity_id, snapshot, accepted_event_ids, superseded_event_ids, findings, affected_refs. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/E/E01.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Character state snapshots/deltas -> I/C/H. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T5 Tracker / T6 Validator. Rendered inside the E set workspace using T5 Tracker / T6 Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/E01.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### E02
E02 - Location Tracker

Purpose: Tracks current and historical locations of characters and tracked objects.

Execution: LOGIC. Structured location transitions are deterministic.

Input contract: Contracts/E/E02.schema.json#/$defs/CREATE. Required CREATE fields: entity_id, mode, events, source_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| entity_id | string | yes |
| mode | enum ['INITIALIZE', 'APPLY', 'REPLAY', 'CHECK'] | yes |
| baseline_ref | object | no |
| checkpoint_ref | object | no |
| events | array | yes |
| superseded_event_ids | array | no |
| source_refs | array | yes |
| current_snapshot_ref | object | no |

Owned output: E02_record; fields entity_id, snapshot, accepted_event_ids, superseded_event_ids, findings, affected_refs. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/E/E02.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Location state/history -> I/C/E03. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T5 Tracker / T6 Validator. Rendered inside the E set workspace using T5 Tracker / T6 Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/E02.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### E03
E03 - Timeline Checker

Purpose: Validates dates, durations, event order and travel/time constraints.

Execution: LOGIC/HYBRID. Exact temporal math is logic; AI only if prose must be semantically interpreted.

Input contract: Contracts/E/E03.schema.json#/$defs/CREATE. Required CREATE fields: timeline_id, mode, events, source_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| timeline_id | string | yes |
| mode | enum ['INITIALIZE', 'APPLY', 'REPLAY', 'CHECK'] | yes |
| baseline_ref | object | no |
| checkpoint_ref | object | no |
| events | array | yes |
| superseded_event_ids | array | no |
| source_refs | array | yes |
| current_snapshot_ref | object | no |

Owned output: E03_record; fields entity_id, snapshot, accepted_event_ids, superseded_event_ids, findings, affected_refs. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/E/E03.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Timeline conflicts/evidence -> J/K/H. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T5 Tracker / T6 Validator. Rendered inside the E set workspace using T5 Tracker / T6 Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/E03.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### E04
E04 - Relationship Tracker

Purpose: Tracks story-time changes to relationships without overwriting canonical baseline history.

Execution: LOGIC. State transitions are deterministic once events are structured.

Input contract: Contracts/E/E04.schema.json#/$defs/CREATE. Required CREATE fields: relationship_id, mode, events, source_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| relationship_id | string | yes |
| mode | enum ['INITIALIZE', 'APPLY', 'REPLAY', 'CHECK'] | yes |
| baseline_ref | object | no |
| checkpoint_ref | object | no |
| events | array | yes |
| superseded_event_ids | array | no |
| source_refs | array | yes |
| current_snapshot_ref | object | no |

Owned output: E04_record; fields entity_id, snapshot, accepted_event_ids, superseded_event_ids, findings, affected_refs. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/E/E04.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Relationship-state timeline -> I/C/H04. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T5 Tracker / T6 Validator. Rendered inside the E set workspace using T5 Tracker / T6 Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/E04.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### E05
E05 - Knowledge Tracker

Purpose: Tracks what each character knows, believes, suspects and has not yet learned at each story point.

Execution: LOGIC/HYBRID. Storage/propagation is logic; semantic extraction from prose may use AI.

Input contract: Contracts/E/E05.schema.json#/$defs/CREATE. Required CREATE fields: character_id, mode, events, source_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| character_id | string | yes |
| mode | enum ['INITIALIZE', 'APPLY', 'REPLAY', 'CHECK'] | yes |
| baseline_ref | object | no |
| checkpoint_ref | object | no |
| events | array | yes |
| superseded_event_ids | array | no |
| source_refs | array | yes |
| current_snapshot_ref | object | no |

Owned output: E05_record; fields entity_id, snapshot, accepted_event_ids, superseded_event_ids, findings, affected_refs. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/E/E05.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Knowledge state -> I/C/E11. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T5 Tracker / T6 Validator. Rendered inside the E set workspace using T5 Tracker / T6 Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/E05.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### E06
E06 - Injury/Condition Tracker

Purpose: Tracks injuries, illness, recovery, impairment and condition changes over story time.

Execution: LOGIC. Structured condition transitions are deterministic.

Input contract: Contracts/E/E06.schema.json#/$defs/CREATE. Required CREATE fields: character_id, mode, events, source_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| character_id | string | yes |
| mode | enum ['INITIALIZE', 'APPLY', 'REPLAY', 'CHECK'] | yes |
| baseline_ref | object | no |
| checkpoint_ref | object | no |
| events | array | yes |
| superseded_event_ids | array | no |
| source_refs | array | yes |
| current_snapshot_ref | object | no |

Owned output: E06_record; fields entity_id, snapshot, accepted_event_ids, superseded_event_ids, findings, affected_refs. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/E/E06.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Condition state -> I/C/E11. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T5 Tracker / T6 Validator. Rendered inside the E set workspace using T5 Tracker / T6 Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/E06.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### E07
E07 - Inventory/Weapon Tracker

Purpose: Tracks possession, transfer, loss and use of important objects/weapons.

Execution: LOGIC. Ownership/state transitions are deterministic.

Input contract: Contracts/E/E07.schema.json#/$defs/CREATE. Required CREATE fields: holder_id, mode, events, source_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| holder_id | string | yes |
| mode | enum ['INITIALIZE', 'APPLY', 'REPLAY', 'CHECK'] | yes |
| baseline_ref | object | no |
| checkpoint_ref | object | no |
| events | array | yes |
| superseded_event_ids | array | no |
| source_refs | array | yes |
| current_snapshot_ref | object | no |

Owned output: E07_record; fields entity_id, snapshot, accepted_event_ids, superseded_event_ids, findings, affected_refs. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/E/E07.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Inventory state/history -> I/C/E11. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T5 Tracker / T6 Validator. Rendered inside the E set workspace using T5 Tracker / T6 Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/E07.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### E08
E08 - Magic/Power State Tracker

Purpose: Tracks availability, cost, cooldown, depletion and temporary changes in powers.

Execution: LOGIC. Rule/state calculations are deterministic when rules are structured.

Input contract: Contracts/E/E08.schema.json#/$defs/CREATE. Required CREATE fields: character_id, mode, events, source_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| character_id | string | yes |
| mode | enum ['INITIALIZE', 'APPLY', 'REPLAY', 'CHECK'] | yes |
| baseline_ref | object | no |
| checkpoint_ref | object | no |
| events | array | yes |
| superseded_event_ids | array | no |
| source_refs | array | yes |
| current_snapshot_ref | object | no |

Owned output: E08_record; fields entity_id, snapshot, accepted_event_ids, superseded_event_ids, findings, affected_refs. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/E/E08.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Power state -> I/C/E11. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T5 Tracker / T6 Validator. Rendered inside the E set workspace using T5 Tracker / T6 Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/E08.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### E09
E09 - Plot Thread Tracker

Purpose: Tracks each plot/subplot thread from opened through progressed, blocked and resolved.

Execution: LOGIC. Lifecycle states and links are deterministic.

Input contract: Contracts/E/E09.schema.json#/$defs/CREATE. Required CREATE fields: thread_id, mode, events, source_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| thread_id | string | yes |
| mode | enum ['INITIALIZE', 'APPLY', 'REPLAY', 'CHECK'] | yes |
| baseline_ref | object | no |
| checkpoint_ref | object | no |
| events | array | yes |
| superseded_event_ids | array | no |
| source_refs | array | yes |
| current_snapshot_ref | object | no |

Owned output: E09_record; fields entity_id, snapshot, accepted_event_ids, superseded_event_ids, findings, affected_refs. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/E/E09.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Thread state -> I/B/H03. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T5 Tracker / T6 Validator. Rendered inside the E set workspace using T5 Tracker / T6 Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/E09.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### E10
E10 - Unresolved Event Tracker

Purpose: Records promises, questions, planted details and events that still require payoff or explanation.

Execution: LOGIC/HYBRID. Known obligations are logic; semantic extraction from free prose may use AI.

Input contract: Contracts/E/E10.schema.json#/$defs/CREATE. Required CREATE fields: event_ref, mode, events, source_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| event_ref | object | yes |
| mode | enum ['INITIALIZE', 'APPLY', 'REPLAY', 'CHECK'] | yes |
| baseline_ref | object | no |
| checkpoint_ref | object | no |
| events | array | yes |
| superseded_event_ids | array | no |
| source_refs | array | yes |
| current_snapshot_ref | object | no |

Owned output: E10_record; fields entity_id, snapshot, accepted_event_ids, superseded_event_ids, findings, affected_refs. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/E/E10.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Unresolved obligation list -> I/B/H. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T5 Tracker / T6 Validator. Rendered inside the E set workspace using T5 Tracker / T6 Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/E10.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### E11
E11 - Chapter-to-Chapter Continuity Checker

Purpose: Checks adjacent and nearby chapters for incompatible state transitions or unexplained changes.

Execution: HYBRID. State comparisons are logic; semantic prose interpretation may use AI.

Input contract: Contracts/E/E11.schema.json#/$defs/CREATE. Required CREATE fields: chapter_id, mode, events, source_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| chapter_id | string | yes |
| mode | enum ['INITIALIZE', 'APPLY', 'REPLAY', 'CHECK'] | yes |
| baseline_ref | object | no |
| checkpoint_ref | object | no |
| events | array | yes |
| superseded_event_ids | array | no |
| source_refs | array | yes |
| current_snapshot_ref | object | no |

Owned output: E11_record; fields entity_id, snapshot, accepted_event_ids, superseded_event_ids, findings, affected_refs. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/E/E11.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Continuity issues -> C/F/J/K. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T5 Tracker / T6 Validator. Rendered inside the E set workspace using T5 Tracker / T6 Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/E11.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### E12
E12 - Canon-vs-Manuscript Checker

Purpose: Checks manuscript assertions against locked/approved canon and distinguishes contradiction from intentional state change.

Execution: HYBRID. Exact entity/fact checks are logic; semantic entailment/conflict may require AI.

Input contract: Contracts/E/E12.schema.json#/$defs/CREATE. Required CREATE fields: manuscript_ref, mode, events, source_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| manuscript_ref | object | yes |
| mode | enum ['INITIALIZE', 'APPLY', 'REPLAY', 'CHECK'] | yes |
| baseline_ref | object | no |
| checkpoint_ref | object | no |
| events | array | yes |
| superseded_event_ids | array | no |
| source_refs | array | yes |
| current_snapshot_ref | object | no |

Owned output: E12_record; fields entity_id, snapshot, accepted_event_ids, superseded_event_ids, findings, affected_refs. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/E/E12.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Canon conflict candidates -> J/F/K. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T5 Tracker / T6 Validator. Rendered inside the E set workspace using T5 Tracker / T6 Validator; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/E12.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

## Applied closure contract
REPLAY checkpoint_ref is optional; no checkpoint means baseline replay. current_snapshot_ref remains mandatory for APPLY/REPLAY and identifies this same E operation/entity. Event paths index canonical snapshot facts under section 10, with full before/after and an atomic one-entity-per-event batch.
Shared_Contract.md section 10 and the updated schemas/registry are normative for these corrections. See Verification/Applied_Fixes.json and Verification/closure_check.json for observed artifact checks, and Acceptance_Cases/closure_runtime.cases.json for future application tests.
