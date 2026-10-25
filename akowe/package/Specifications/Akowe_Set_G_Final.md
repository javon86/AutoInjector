# Akọwe Set G - Book Assembly
Revision BF-CLOSURE-1.1 | 14 operations | independent module

This is the current specification. Historical source/addenda are not active instructions. Use Shared_Contract.md for wire formats, lifecycle, ownership, permissions, failures and record storage.

## Set rules and assembly order
G02 creates an ordered content manifest from approved chapter pins and a unique ordered ID list; duplicates/missing selected IDs fail. G01 compiles that manifest, not a previously compiled final book. G05 establishes font profile and language before G04 pagination. G14 supplies preliminary trim/profile for print; page_count is not an initial prerequisite. G03 places only selected D assets by stable anchors and explicit size/fit; absent art is NOT_APPLICABLE. G06 title pages, G08 front matter and G09 back matter are included before final pagination. G07 generates TOC after anchors and pagination exist. G10 final print cover uses resulting page count. G11-G13 export immutable candidate bytes for selected formats only.

Output profiles are MANUSCRIPT_PDF, PRINT_INTERIOR, PRINT_WRAP_COVER, EPUB_REFLOWABLE and EDITABLE_DOCX. MANUSCRIPT_PDF needs no cover/art/physical spine. Print interior/wrap needs pinned printer geometry, paper and binding rules. EPUB uses navigation anchors, no print page-number requirement. DOCX exports editable structured paragraphs/styles and image relationships, not flattened pages. A selected profile determines required fields; unselected exports never block another format. Source approval refs refer to manuscript/content approval and are distinct from later H approval of exact exported bytes, avoiding a G/H cycle.

Use mm for physical geometry and pt for PDF text (1 pt=25.4/72 mm). Require positive dimensions; margins/bleed fit the selected page. Font profile pins font files, embedding/license permission, fallback, size and line spacing. For print spine use the printer profile's page-to-leaf/caliper formula, binding allowances and tolerances; do not assume one universal coefficient. Reject unsupported printer/binding combinations. Digital cover omits spine/back-panel geometry.

Paginate -> regenerate TOC -> paginate until ordered (heading_id,page) map and page count are unchanged for two consecutive passes. Default max_passes=6, allowed 1..12; fail TOC_NONCONVERGENCE at the limit and retain candidates, never publish unstable page numbers. Heading IDs are stable and TOC links resolve. PRINT_WRAP_COVER is generated only after interior page count stabilizes; if geometry feedback changes pagination, repeat the bounded loop.

Each export binds ordered manifest hash, C source pins, D asset hashes, template/font versions, profile and byte hash. Write to staging, validate/hash bytes, then atomically publish the artifact record. G11 PDF parse verifies all pages/media boxes/fonts/links against profile. G12 EPUB requires mimetype first/uncompressed, OPF manifest/spine, XHTML/nav and relative assets, plus EPUBCheck; validation tool absence produces UNKNOWN. G13 requires valid OOXML package and resolvable relationships. Export candidates need H09 checks before book release. No output silently adds an unapproved asset.

Acceptance walkthrough: a text-only manuscript PDF without D/print geometry; an EPUB without spine values; print pagination that changes after TOC insertion converges or fails at the exact cap. A missing font embedding license blocks the affected export.

## Operation contracts

### G01
G01 - Manuscript Compiler

Purpose: Assembles approved chapter/scene content into a single ordered manuscript representation.

Execution: LOGIC. Compilation is deterministic.

Input contract: Contracts/G/G01.schema.json#/$defs/CREATE. Required CREATE fields: ordered_manifest_ref, approved_chapter_refs, section_id_policy. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| ordered_manifest_ref | object | yes |
| approved_chapter_refs | array | yes |
| section_id_policy | enum ['STABLE_ID'] | yes |

Owned output: G01_record; fields artifact_ref, revision, sha256, validation_report_ref, artifact_type. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/G/G01.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Compiled manuscript -> G02/G04/H. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T11 Assembly/Layout / T12 Export. Rendered inside the G set workspace using T11 Assembly/Layout / T12 Export; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/G01.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### G02
G02 - Chapter Ordering

Purpose: Validates and applies final chapter/section order.

Execution: LOGIC. Ordering is deterministic.

Input contract: Contracts/G/G02.schema.json#/$defs/CREATE. Required CREATE fields: approved_chapter_refs, ordered_chapter_ids, manifest_revision. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| approved_chapter_refs | array | yes |
| ordered_chapter_ids | array | yes |
| manifest_revision | integer | yes |

Owned output: G02_record; fields artifact_ref, revision, sha256, validation_report_ref, artifact_type. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/G/G02.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Ordered structure -> G01/G07/G04. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T11 Assembly/Layout / T12 Export. Rendered inside the G set workspace using T11 Assembly/Layout / T12 Export; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/G02.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### G03
G03 - Illustration Placement

Purpose: Maps approved visual assets to target chapters/scenes/pages and checks placement requirements.

Execution: LOGIC/HYBRID. Anchor matching is logic; aesthetic suggestion may optionally use AI.

Input contract: Contracts/G/G03.schema.json#/$defs/CREATE. Required CREATE fields: ordered_manuscript_ref, illustration_policy. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| ordered_manuscript_ref | object | yes |
| placements | array | no |
| illustration_policy | string ['NONE', 'OPTIONAL', 'REQUIRED'] | yes |

Owned output: G03_record; fields artifact_ref, revision, sha256, validation_report_ref, artifact_type. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/G/G03.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Placement map -> G04/H06. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T11 Assembly/Layout / T12 Export. Rendered inside the G set workspace using T11 Assembly/Layout / T12 Export; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/G03.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### G04
G04 - Page Layout

Purpose: Flows text and assets into pages according to trim, margin, spacing and layout rules.

Execution: LOGIC. Page composition should use deterministic layout code.

Input contract: Contracts/G/G04.schema.json#/$defs/CREATE. Required CREATE fields: manuscript_ref, page_profile_ref, margins_pt, typography_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| manuscript_ref | object | yes |
| page_profile_ref | object | yes |
| margins_pt | object | yes |
| typography_ref | object | yes |

Owned output: G04_record; fields artifact_ref, revision, sha256, validation_report_ref, artifact_type. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/G/G04.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Laid-out pages -> G05-G10/H07. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T11 Assembly/Layout / T12 Export. Rendered inside the G set workspace using T11 Assembly/Layout / T12 Export; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/G04.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### G05
G05 - Typography

Purpose: Applies typefaces, hierarchy, spacing, paragraph styles and typographic rules.

Execution: LOGIC. Style application is deterministic.

Input contract: Contracts/G/G05.schema.json#/$defs/CREATE. Required CREATE fields: font_profile_ref, language_tag, manuscript_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| font_profile_ref | object | yes |
| language_tag | string | yes |
| manuscript_ref | object | yes |

Owned output: G05_record; fields artifact_ref, revision, sha256, validation_report_ref, artifact_type. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/G/G05.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Typeset layout -> G04/export. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T11 Assembly/Layout / T12 Export. Rendered inside the G set workspace using T11 Assembly/Layout / T12 Export; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/G05.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### G06
G06 - Chapter Title Pages

Purpose: Generates standardized chapter title/opening page structures.

Execution: LOGIC. Template generation is deterministic.

Input contract: Contracts/G/G06.schema.json#/$defs/CREATE. Required CREATE fields: typography_ref, chapter_title_rules_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| typography_ref | object | yes |
| chapter_title_rules_ref | object | yes |

Owned output: G06_record; fields artifact_ref, revision, sha256, validation_report_ref, artifact_type. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/G/G06.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Chapter title pages -> G04. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T11 Assembly/Layout / T12 Export. Rendered inside the G set workspace using T11 Assembly/Layout / T12 Export; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/G06.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### G07
G07 - Table of Contents

Purpose: Builds navigation entries from final structure and page/anchor information.

Execution: LOGIC. TOC generation is deterministic.

Input contract: Contracts/G/G07.schema.json#/$defs/CREATE. Required CREATE fields: paginated_book_ref, toc_style_ref, max_passes. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| paginated_book_ref | object | yes |
| toc_style_ref | object | yes |
| max_passes | integer | yes |

Owned output: G07_record; fields artifact_ref, revision, sha256, validation_report_ref, artifact_type. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/G/G07.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: TOC/navigation -> G04/G11/G12/H08. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T11 Assembly/Layout / T12 Export. Rendered inside the G set workspace using T11 Assembly/Layout / T12 Export; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/G07.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### G08
G08 - Front Matter

Purpose: Assembles title, copyright, dedication, epigraph and other selected front matter.

Execution: HYBRID. Assembly is logic; optional prose drafting may use AI.

Input contract: Contracts/G/G08.schema.json#/$defs/CREATE. Required CREATE fields: book_ref, front_matter_items, publication_profile_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| book_ref | object | yes |
| front_matter_items | array | yes |
| publication_profile_ref | object | yes |

Owned output: G08_record; fields artifact_ref, revision, sha256, validation_report_ref, artifact_type. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/G/G08.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Front matter -> G01/G04. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T11 Assembly/Layout / T12 Export. Rendered inside the G set workspace using T11 Assembly/Layout / T12 Export; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/G08.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### G09
G09 - Back Matter

Purpose: Assembles acknowledgments, appendices, glossary, author note and selected back matter.

Execution: HYBRID. Assembly is logic; optional drafting/summarization may use AI.

Input contract: Contracts/G/G09.schema.json#/$defs/CREATE. Required CREATE fields: book_ref, publication_profile_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| book_ref | object | yes |
| back_matter_items | array | no |
| publication_profile_ref | object | yes |

Owned output: G09_record; fields artifact_ref, revision, sha256, validation_report_ref, artifact_type. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/G/G09.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Back matter -> G01/G04. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T11 Assembly/Layout / T12 Export. Rendered inside the G set workspace using T11 Assembly/Layout / T12 Export; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/G09.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### G10
G10 - Cover Layout

Purpose: Combines cover artwork with title, author, spine/back elements and print geometry.

Execution: HYBRID. Layout is logic; AI only for optional creative copy/art requests.

Input contract: Contracts/G/G10.schema.json#/$defs/CREATE. Required CREATE fields: cover_asset_ref, cover_mode. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| cover_asset_ref | object | yes |
| print_profile_ref | object | no |
| page_count | integer | no |
| cover_mode | string ['EBOOK', 'PRINT'] | yes |

Owned output: G10_record; fields artifact_ref, revision, sha256, validation_report_ref, artifact_type. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/G/G10.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Complete cover files -> G11/print/H07. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T11 Assembly/Layout / T12 Export. Rendered inside the G set workspace using T11 Assembly/Layout / T12 Export; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/G10.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### G11
G11 - PDF Export

Purpose: Renders the approved book package to PDF and records export metadata.

Execution: LOGIC. File export is deterministic.

Input contract: Contracts/G/G11.schema.json#/$defs/CREATE. Required CREATE fields: final_book_ref, pdf_profile_ref, approval_manifest_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| final_book_ref | object | yes |
| pdf_profile_ref | object | yes |
| approval_manifest_ref | object | yes |

Owned output: G11_record; fields artifact_ref, revision, sha256, validation_report_ref, artifact_type. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/G/G11.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: PDF -> H09/user. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T11 Assembly/Layout / T12 Export. Rendered inside the G set workspace using T11 Assembly/Layout / T12 Export; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/G11.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### G12
G12 - EPUB Export

Purpose: Builds an EPUB package with content, navigation, metadata and assets.

Execution: LOGIC. Packaging is deterministic.

Input contract: Contracts/G/G12.schema.json#/$defs/CREATE. Required CREATE fields: final_book_ref, epub_profile_ref, metadata_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| final_book_ref | object | yes |
| epub_profile_ref | object | yes |
| metadata_ref | object | yes |

Owned output: G12_record; fields artifact_ref, revision, sha256, validation_report_ref, artifact_type. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/G/G12.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: EPUB -> H09/user. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T11 Assembly/Layout / T12 Export. Rendered inside the G set workspace using T11 Assembly/Layout / T12 Export; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/G12.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### G13
G13 - DOCX/Editable Export

Purpose: Produces an editable manuscript/book representation for downstream editing.

Execution: LOGIC. Document generation is deterministic.

Input contract: Contracts/G/G13.schema.json#/$defs/CREATE. Required CREATE fields: final_book_ref, docx_profile_ref, metadata_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| final_book_ref | object | yes |
| docx_profile_ref | object | yes |
| metadata_ref | object | yes |

Owned output: G13_record; fields artifact_ref, revision, sha256, validation_report_ref, artifact_type. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/G/G13.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: DOCX/editable file -> H09/user. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T11 Assembly/Layout / T12 Export. Rendered inside the G set workspace using T11 Assembly/Layout / T12 Export; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/G13.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

### G14
G14 - Print Specification/Trim Setup

Purpose: Stores and validates trim, bleed, margins, spine and print-production constraints.

Execution: LOGIC. Numeric/spec validation is deterministic.

Input contract: Contracts/G/G14.schema.json#/$defs/CREATE. Required CREATE fields: trim_width_mm, trim_height_mm, binding, paper_stock_ref, printer_profile_ref. Optional fields are all remaining declared schema properties; absent optional data never silently becomes required except the explicit rules above. Empty collections are permitted where minItems=0; null follows exact schema.

| Field | Type | Required |
|---|---|---|
| trim_width_mm | number | yes |
| trim_height_mm | number | yes |
| binding | string | yes |
| paper_stock_ref | object | yes |
| printer_profile_ref | object | yes |

Owned output: G14_record; fields artifact_ref, revision, sha256, validation_report_ref, artifact_type. Exact nested types, required properties, bounds and enumeration values are defined in Contracts/G/G14.schema.json#/$defs/OUTPUT. Shared creative objects use SemanticRecord; structured domain outputs retain their own fields.

Routes: Print spec -> G04/G10/H07. All destinations receive the new immutable output reference; they retrieve and validate the record rather than taking over ownership. Field-level receiver bindings are in Contracts/interface_registry.json. Routing denotes consumers, not blanket hard prerequisites.

Behavior: validate the shared envelope, authenticated permission, applicable selection and source pins; run this operation's purpose under the set rules; return a DRAFT result plus evidence/findings; owner VALIDATE/ACCEPT gates determine approval. READ retrieves its base_ref without domain mutation. UPDATE requires complete owned output data and a matching base_ref. CREATE allocates a new logical result ID and needs no existing output. Missing/invalid/stale/unauthorized data leave the previous approved head unchanged.

Workspace: T11 Assembly/Layout / T12 Export. Rendered inside the G set workspace using T11 Assembly/Layout / T12 Export; show required/optional/conditional fields, source/provenance indicators, validation state, missing dependencies, run/repair status, and direct links to affected/requested modules. Use the common empty/loading/draft/blocked/stale/approved states. Resume from durable attempt checkpoint; revalidate changed pins before continuing.

Acceptance: Acceptance_Cases/G14.cases.json contains concrete structural examples and planned runtime cases. Successful structural validation is separate from domain acceptance. Runtime tests must verify this purpose, one missing applicable input, duplicate delivery, stale update, permission denial, interrupted commit and declared output consumption. The module-specific walkthrough above provides the cross-module success/recovery path.

## Applied closure contract
Intermediate artifact_registry provides actual JSON shapes for manifests, compilation, pagination, typography, matter and print specification. External profiles import through typed I01 auxiliary_record; no unrelated record can be used as a profile. G04/G05 read compiled G01; exporters read assembled/paginated G records.
Shared_Contract.md section 10 and the updated schemas/registry are normative for these corrections. See Verification/Applied_Fixes.json and Verification/closure_check.json for observed artifact checks, and Acceptance_Cases/closure_runtime.cases.json for future application tests.
