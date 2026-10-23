# Bookforge Set D - Art Visual
Revision BF-CLOSURE-1.1 | 12 operations | independent module

This is the current specification. Historical source/addenda are not active instructions. Use Shared_Contract.md for wire formats, lifecycle, ownership, permissions, failures and record storage.

## Set rules and corrected operation identities
The supplied C2 contract assigned some payloads to the wrong operation IDs. Final identities are D04 Environment/Location Art, D05 Creature Art, D06 Weapon/Item Art, D08 Comic Panel Generator, D09 Composition/Camera Planner and D10 Visual Consistency Checker. Names and responsibilities match the original source. The final schemas use the corrected payload assignment.

D01 defines style; D02 interprets A01/A02 appearance; D03 poses that reference; D04 renders A04 location; D05 renders A02 creature; D06 renders A11/A12 object. D07 requires a style and scene brief; asset categories are supplied only for depicted entities. Empty location scenes use location_asset_ref without mandatory characters, creatures or weapons. Supplied subjects require pinned approved reference interpretations and matching canon. D08 panel reading_order is a unique complete ordering of the supplied panels. D09 composition must fit positive canvas dimensions. D10 compares assets to pinned references; protected appearance mismatch is a blocking finding, never an A edit. D11 cover artwork does not claim final print spine geometry; G10 handles typography/wrap layout. D12 maps use a deterministic graph/text layer with optional AI background decoration.

A owns structured appearance; D owns visual interpretations. Visual approval requires rights.cleared=true, matching canon, actual file checksum and visual reviewer/policy evidence. Store rejected candidates without replacing approved assets. Metadata-only style/composition/check results may store JSON bytes with application/json MIME type; do not invent image files. Asset approval uses the project policy's tolerance profile; protected identity facts have zero semantic deviation tolerance.

D12 graph schema is Contracts/shared/MapGraph.schema.json. Node/edge IDs are unique; every edge endpoint exists; labels equal canonical spelling after NFC normalization for comparison only. Preserve graph coordinates and unit; compare sidecar positions within geometry_tolerance, default 0 for deterministic vector coordinates. Render sidecar lists graph IDs and actual label/geometry values, with exporter version and hash. Require source_graph_ref and sidecar_ref on D12 approval; raster-only comparison cannot pass exact map validation. Changed canon labels invalidate only maps/assets that use them.

Acceptance walkthrough: empty room illustration omits creature/weapon arrays and remains valid. A protected hair-color discrepancy blocks D02 approval. A map with a wrong label fails exact comparison even when it looks attractive. Provider timeout resumes via stored provider_job_id instead of duplicating charges.

## Operation contracts

### D01
D01 - Visual Style Definition

Purpose: Defines reusable visual style constraints for all generated/assembled imagery.

Execution: HYBRID. Style metadata is logic; AI may derive/propose visual descriptors.

Input contract: Contracts/D/D01.schema.json#/$defs/CREATE. Required CREATE fields: style_name, style_rules, publishing_format. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| style_name | string | yes |
| style_rules | string | yes |
| publishing_format | string | yes |
| palette | string | no |
| reference_asset_ids | array | no |

Owned output: D01_record; fields asset_type, storage_uri, mime_type, file_hash, rights, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/D/D01.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Visual style profile -> I/D/G. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T10 Visual/Canvas. Rendered inside the D set workspace using T10 Visual/Canvas; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/D01.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### D02
D02 - Character Appearance/Reference

Purpose: Creates and maintains canonical visual reference assets for characters from approved appearance canon.

Execution: HYBRID. Image generation uses visual AI; metadata, versioning and reference linkage are logic.

Input contract: Contracts/D/D02.schema.json#/$defs/CREATE. Required CREATE fields: character_id, appearance_canon_ref, style_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| character_id | string | yes |
| appearance_canon_ref | object | yes |
| style_ref | object | yes |
| pose | string | no |
| reference_asset_ids | array | no |

Owned output: D02_record; fields asset_type, storage_uri, mime_type, file_hash, rights, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/D/D02.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Character reference assets/metadata -> asset store/I/D03/D07. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T10 Visual/Canvas. Rendered inside the D set workspace using T10 Visual/Canvas; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/D02.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### D03
D03 - Character Pose/Expression

Purpose: Produces a known character in requested pose/expression while preserving reference identity.

Execution: AI. Image synthesis/editing requires image AI/tool.

Input contract: Contracts/D/D03.schema.json#/$defs/CREATE. Required CREATE fields: character_id, character_reference_ref, scene_brief. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| character_id | string | yes |
| character_reference_ref | object | yes |
| scene_brief | string | yes |
| pose | string | no |
| location_ref | object | no |

Owned output: D03_record; fields asset_type, storage_uri, mime_type, file_hash, rights, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/D/D03.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Pose/expression asset -> D07/D08/G. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T10 Visual/Canvas. Rendered inside the D set workspace using T10 Visual/Canvas; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/D03.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### D04
D04 - Environment/Location Art

Purpose: Creates location/environment imagery from canonical geography and visual style.

Execution: AI. Image generation requires visual AI/tool.

Input contract: Contracts/D/D04.schema.json#/$defs/CREATE. Required CREATE fields: location_id, location_canon_ref, style_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| location_id | string | yes |
| location_canon_ref | object | yes |
| style_ref | object | yes |
| time_of_day | string | no |
| weather | string | no |

Owned output: D04_record; fields asset_type, storage_uri, mime_type, file_hash, rights, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/D/D04.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Location art -> asset store/D07/G. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T10 Visual/Canvas. Rendered inside the D set workspace using T10 Visual/Canvas; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/D04.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### D05
D05 - Creature Art

Purpose: Creates species/creature visuals consistent with biological canon and style.

Execution: AI. Image generation requires visual AI/tool.

Input contract: Contracts/D/D05.schema.json#/$defs/CREATE. Required CREATE fields: creature_id, creature_canon_ref, style_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| creature_id | string | yes |
| creature_canon_ref | object | yes |
| style_ref | object | yes |
| habitat_ref | object | no |
| reference_asset_ids | array | no |

Owned output: D05_record; fields asset_type, storage_uri, mime_type, file_hash, rights, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/D/D05.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Creature art -> asset store/D07/G. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T10 Visual/Canvas. Rendered inside the D set workspace using T10 Visual/Canvas; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/D05.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### D06
D06 - Weapon/Item Art

Purpose: Creates visual references for weapons, artifacts and significant items.

Execution: AI. Image generation requires visual AI/tool.

Input contract: Contracts/D/D06.schema.json#/$defs/CREATE. Required CREATE fields: object_id, object_canon_ref, style_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| object_id | string | yes |
| object_canon_ref | object | yes |
| style_ref | object | yes |
| material | string | no |
| reference_asset_ids | array | no |

Owned output: D06_record; fields asset_type, storage_uri, mime_type, file_hash, rights, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/D/D06.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Item/weapon assets -> asset store/D07/G. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T10 Visual/Canvas. Rendered inside the D set workspace using T10 Visual/Canvas; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/D06.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### D07
D07 - Scene Illustration

Purpose: Creates a finished illustration of a planned/written scene using canonical visual references.

Execution: AI. Image generation requires visual AI/tool.

Input contract: Contracts/D/D07.schema.json#/$defs/CREATE. Required CREATE fields: scene_description, style_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| scene_description | string | yes |
| style_ref | object | yes |
| character_asset_refs | array | no |
| creature_asset_refs | array | no |
| object_asset_refs | array | no |
| location_asset_ref | object | no |

Owned output: D07_record; fields asset_type, storage_uri, mime_type, file_hash, rights, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/D/D07.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Scene illustration -> asset store/G03. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T10 Visual/Canvas. Rendered inside the D set workspace using T10 Visual/Canvas; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/D07.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### D08
D08 - Comic Panel Generator

Purpose: Converts scene beats/dialogue into sequential panel specifications and rendered panels.

Execution: HYBRID. Panel sequencing/layout can be logic; imagery requires visual AI.

Input contract: Contracts/D/D08.schema.json#/$defs/CREATE. Required CREATE fields: panel_brief, page_dimensions, style_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| panel_brief | string | yes |
| page_dimensions | string | yes |
| style_ref | object | yes |
| reading_order | string | no |
| asset_refs | array | no |

Owned output: D08_record; fields asset_type, storage_uri, mime_type, file_hash, rights, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/D/D08.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Panel plan/assets -> G04. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T10 Visual/Canvas. Rendered inside the D set workspace using T10 Visual/Canvas; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/D08.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### D09
D09 - Composition/Camera Planner

Purpose: Defines shot size, angle, framing, subject placement and composition for an image/panel.

Execution: HYBRID. Template/rule choices can be logic; semantic cinematic planning may use AI.

Input contract: Contracts/D/D09.schema.json#/$defs/CREATE. Required CREATE fields: composition_brief, canvas_dimensions, style_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| composition_brief | string | yes |
| canvas_dimensions | string | yes |
| style_ref | object | yes |
| asset_refs | array | no |
| focal_point | string | no |

Owned output: D09_record; fields asset_type, storage_uri, mime_type, file_hash, rights, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/D/D09.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Composition spec -> D07/D08. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T10 Visual/Canvas. Rendered inside the D set workspace using T10 Visual/Canvas; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/D09.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### D10
D10 - Visual Consistency Checker

Purpose: Compares assets with approved references/style and reports identity, costume, object or environment inconsistencies.

Execution: HYBRID. Metadata checks are logic; visual-semantic comparison may require vision AI.

Input contract: Contracts/D/D10.schema.json#/$defs/CREATE. Required CREATE fields: asset_refs, reference_revision_refs, tolerance_profile. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| asset_refs | array | yes |
| reference_revision_refs | array | yes |
| tolerance_profile | object | yes |

Owned output: D10_record; fields asset_type, storage_uri, mime_type, file_hash, rights, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/D/D10.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Consistency report -> K/D repair/H06. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T10 Visual/Canvas. Rendered inside the D set workspace using T10 Visual/Canvas; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/D10.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### D11
D11 - Cover Artwork

Purpose: Generates cover-specific artwork designed around project identity and cover constraints.

Execution: AI. Visual generation requires image AI/tool.

Input contract: Contracts/D/D11.schema.json#/$defs/CREATE. Required CREATE fields: title, trim_dimensions, style_ref, cover_brief. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| title | string | yes |
| trim_dimensions | string | yes |
| style_ref | object | yes |
| cover_brief | string | yes |
| author_name | string | no |
| series_name | string | no |
| reference_asset_ids | array | no |

Owned output: D11_record; fields asset_type, storage_uri, mime_type, file_hash, rights, findings. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/D/D11.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Cover artwork -> G10. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T10 Visual/Canvas. Rendered inside the D set workspace using T10 Visual/Canvas; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/D11.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### D12
D12 - Map/Diagram Artwork

Purpose: Produces maps/diagrams from structured world/location data while retaining canonical labels and relationships.

Execution: HYBRID. Geometry/labels can be code; decorative/generated art may use visual AI.

Input contract: Contracts/D/D12.schema.json#/$defs/CREATE. Required CREATE fields: map_requirements, geometry_source_ref, canonical_label_refs. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| map_requirements | string | yes |
| geometry_source_ref | object | yes |
| canonical_label_refs | array | yes |
| scale | string | no |
| legend | string | no |
| projection | string | no |

Owned output: D12_record; fields asset_type, storage_uri, mime_type, file_hash, rights, findings, source_graph_ref, sidecar_ref. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/D/D12.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Map/diagram asset -> asset store/G. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T10 Visual/Canvas. Rendered inside the D set workspace using T10 Visual/Canvas; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/D12.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

## Applied closure contract
Only D12 accepts source_graph_ref and sidecar_ref in OUTPUT. D01-D11 no longer require them. Style binds D01, and asset category fields bind their actual D producer. D12 initial graph import/extraction precedes render, and graph/sidecar metadata selects their exact schemas.
Shared_Contract.md section 10 and the updated schemas/registry are normative for these corrections. See Verification/Applied_Fixes.json and Verification/closure_check.json for observed artifact checks, and Acceptance_Cases/closure_runtime.cases.json for future application tests.
