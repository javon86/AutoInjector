# Bookforge Set A - Bible Universe Builder
Revision BF-CLOSURE-1.1 | 18 operations | independent module

This is the current specification. Historical source/addenda are not active instructions. Use Shared_Contract.md for wire formats, lifecycle, ownership, permissions, failures and record storage.

## Set rules and bootstrap
A owns baseline/historical canon. All A operations CREATE from a concept; linked references and existing records are not prerequisites for the first draft. Allocate stable IDs before linking. A01/A18, A04/A07, A05/A17 and A10/A16 reciprocal links become revision feedback; missing references used by approved assertions block ACCEPT. Approve a link-free concept only if no required project assertion uses that absent reference. A's textual attributes are narrative descriptions; precise typed facts belong in facts, with subject/predicate/value, effective interval and source pins. Empty attributes/facts mean unspecified draft details, never generated certainty.

A01 appearance facts protect identity, skin, hair, anatomy and distinguishing features when marked protected. A02 capabilities/limits constrain character biology. A03 physical rules constrain worlds; A04 containment must be acyclic, coordinates have units and travel claims must agree with configured geography. A05 jurisdiction and A17 laws link by stable IDs. A06 membership and A18 relationship endpoints must exist before their asserted links are approved. A07 cultures and A08 beliefs distinguish societal claims from verified physical truth. A09 powers must state costs and limits used by scenes; A10 technology cannot silently override those limits. A11 combat rules and A12 artifact rules are constraints, not prose-generated events. A13 historical events preserve participants, causes and outcomes; A14 sorts by time then stable event ID and reports impossible precedence. A15 names use stable entity IDs and preserve exact spelling. A16 currency/resources have explicit units. A18 is baseline; E04 changes relationships at story time without overwriting it.

Accepting an approved A change emits an owner-bound commit event with changed paths. D, B, C, E, F, H and J consumers revalidate only their recorded reads. Protected change requires I10/K09 authorization for the exact candidate and source revisions.

Acceptance walkthrough: create A01 and A18 drafts in an empty project, link resolved IDs, approve the baseline, then apply an E04 relationship change. A18's old bytes/hash remain unchanged; queries return baseline and later E state at the correct time. An unresolved asserted relationship blocks approval without blocking draft creation.

## Operation contracts

### A01
A01 - Character Builder

Purpose: Creates and maintains canonical characters: identity, role, traits, appearance, background, goals, constraints and character-owned facts.

Execution: HYBRID. AI only for requested creative proposals or semantic completion; IDs, fields, validation, references and storage are logic.

Input contract: Contracts/A/A01.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A01_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A01.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Character record and change event -> I; character context -> B/C/D/E. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A01.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### A02
A02 - Species & Biology

Purpose: Defines species biology, anatomy, lifecycle, capabilities and biological limits so characters and scenes obey consistent physical rules.

Execution: HYBRID. Creative biology can use AI; schema validation, inheritance and constraint checks use logic.

Input contract: Contracts/A/A02.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A02_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A02.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Species record -> I; biological constraints -> A01/C/D05/E. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A02.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### A03
A03 - World/Planet Builder

Purpose: Defines top-level worlds/planets, environments and global physical or fantastical rules that constrain lower-level locations and societies.

Execution: HYBRID. AI may propose world content; hierarchy, IDs, validation and rule storage are logic.

Input contract: Contracts/A/A03.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A03_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A03.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: World record -> I; world constraints -> A04/A07/A10/B/C/D. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A03.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### A04
A04 - Locations & Geography

Purpose: Defines canonical geographic and built locations, containment relationships, travel-relevant properties and descriptive facts.

Execution: HYBRID. AI for creative description/proposals; hierarchy, coordinates/containment and validation are logic.

Input contract: Contracts/A/A04.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A04_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A04.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Location records -> I; geography/context -> B/C/D04/D12/E02. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A04.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### A05
A05 - Governments & Political Systems

Purpose: Defines governments, jurisdictions, leadership structures, authority and political rules within the fictional setting.

Execution: HYBRID. AI for institutional design; references and jurisdiction rules are logic.

Input contract: Contracts/A/A05.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A05_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A05.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Government records -> I; authority/jurisdiction context -> B/C/E. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A05.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### A06
A06 - Organizations & Factions

Purpose: Defines organizations, factions, membership, hierarchy, goals, alliances and rivalries.

Execution: HYBRID. AI for creative faction content; membership/reference integrity is logic.

Input contract: Contracts/A/A06.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A06_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A06.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Organization records -> I; faction context -> B/C/E04. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A06.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### A07
A07 - Cultures & Societies

Purpose: Defines customs, values, social structures, norms, traditions and everyday societal patterns.

Execution: HYBRID. AI for cultural generation; field/rule validation and links are logic.

Input contract: Contracts/A/A07.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A07_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A07.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Culture records -> I; cultural constraints/context -> A01/B/C/D. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A07.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### A08
A08 - Religions & Beliefs

Purpose: Defines belief systems, doctrines, rituals, institutions, sacred concepts and religious relationships.

Execution: HYBRID. AI for creative belief systems; record/reference logic remains deterministic.

Input contract: Contracts/A/A08.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A08_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A08.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Religion records -> I; belief context -> A01/B/C. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A08.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### A09
A09 - Magic / Power Systems

Purpose: Defines powers, magic rules, costs, limits, prerequisites, interactions and exceptions.

Execution: HYBRID. AI may design systems; numeric/rule validation and state enforcement are logic.

Input contract: Contracts/A/A09.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A09_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A09.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Power-system records -> I; constraints -> A01/B/C/E08. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A09.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### A10
A10 - Technology & Science

Purpose: Defines technological levels, scientific assumptions, devices, capabilities and hard limitations.

Execution: HYBRID. AI for creative technologies; capability/rule storage and validation are logic.

Input contract: Contracts/A/A10.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A10_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A10.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Technology records -> I; constraints -> A11/A12/B/C/D. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A10.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### A11
A11 - Weapons & Combat Systems

Purpose: Defines weapons, combat methods, properties, restrictions and combat-relevant rules.

Execution: HYBRID. AI for concepts/descriptions; statistics, ownership references and validation are logic.

Input contract: Contracts/A/A11.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A11_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A11.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Weapon/combat records -> I; combat constraints -> C06/D06/E07. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A11.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### A12
A12 - Items & Artifacts

Purpose: Defines important objects, equipment and artifacts, including properties, origin and canonical restrictions.

Execution: HYBRID. AI for creative items; IDs, ownership and schema validation are logic.

Input contract: Contracts/A/A12.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A12_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A12.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Item records -> I; item context -> B/C/D06/E07. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A12.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### A13
A13 - History & Major Events

Purpose: Defines canonical past events and their participants, causes, outcomes and consequences.

Execution: HYBRID. AI for historical narratives/proposals; dates/references and validation are logic.

Input contract: Contracts/A/A13.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A13_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A13.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Historical-event records -> I; events -> A14/B/C. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A13.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### A14
A14 - World Timeline

Purpose: Orders historical canon into a consistent chronology and exposes date/order conflicts.

Execution: LOGIC/HYBRID. Ordering and exact date checks are logic; AI only for ambiguous natural-language temporal relationships.

Input contract: Contracts/A/A14.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A14_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A14.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Canonical timeline and chronology warnings -> I/J/B10. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A14.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### A15
A15 - Languages & Naming Systems

Purpose: Defines languages, dialects, terminology, naming conventions and reusable naming rules.

Execution: HYBRID. AI can invent names/language material; uniqueness/pattern/reference checks use logic.

Input contract: Contracts/A/A15.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A15_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A15.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Language/naming records -> I; naming constraints -> A01/C/D. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A15.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### A16
A16 - Economy & Resources

Purpose: Defines currencies, resources, trade, production, scarcity and economic relationships.

Execution: HYBRID. AI for economic worldbuilding; quantities/references and validation are logic.

Input contract: Contracts/A/A16.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A16_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A16.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Economic records -> I; resource/economy context -> B/C. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A16.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### A17
A17 - Laws & Social Rules

Purpose: Defines formal laws, prohibitions, rights, penalties and important informal social rules.

Execution: HYBRID. AI for rule drafting; jurisdiction/reference validation is logic.

Input contract: Contracts/A/A17.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A17_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A17.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Law/social-rule records -> I; constraints -> B/C/E. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A17.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### A18
A18 - Character Relationships

Purpose: Defines canonical baseline relationships among characters and organizations.

Execution: HYBRID. AI may propose nuanced relationship descriptions; graph integrity and links are logic.

Input contract: Contracts/A/A18.schema.json#/$defs/CREATE. Required CREATE fields: concept. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| concept | string | yes |
| attributes | object | no |
| linked_refs | array | no |
| protected_fact_flags | array | no |
| facts | array | no |

Owned output: A18_record; fields concept, attributes, linked_refs, protected_fact_flags, facts. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/A/A18.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Relationship graph -> I; baseline relationship context -> B/C/E04. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T1 Schema/Form Builder. Rendered inside the A set workspace using T1 Schema/Form Builder; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/A18.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

## Applied closure contract
Use the canonical entity predicates and registered extension meanings. Canon changes remain owner proposals; locked authority and approved historical version are retained. Typed links are validated before final acceptance; unselected contextual links never force completion of an entire module.
Shared_Contract.md section 10 and the updated schemas/registry are normative for these corrections. See Verification/Applied_Fixes.json and Verification/closure_check.json for observed artifact checks, and Acceptance_Cases/closure_runtime.cases.json for future application tests.
