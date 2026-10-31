"""📖 The Book Bible binder: every page of the binder as data (the contract the web page and the exports read).

``build(app, pid, branch)`` collects, read-only, from the book and returns the contract of the binder lane's PLAN.md:

    {schema_version, book: {title, author, genre, look, look_default, look_stored, looks}, generated_at, updated_at,
     pages: [{template, entry_id, title, page_id, page, status: approved|draft|needs_you, target?,
              sections: {<code>: {fields: {<id>: field}, rows?: [{<id>: field, _meta?}]}}, pics: {<id>: pic},
              graph? (6) | map? (9)}],
     contents: [{template, title, count, page, page_id}], todo: [{what, page_id, action}], counts}

A field is ``{value, status: approved|proposed|supplied|empty|auto, source, edit?, draft?, new?}``; a picture
``{url, alt, mime?, items?: [{url, alt}], video?, png_url?}``. Every field id of ``binder_schema.json`` (the user's
template spec, a copy of ``pc-work/binder/schema.json``) appears on every page of its template, empty ones as
``{value: "", status: "empty"}``; a repeating section has placeholders in ``fields`` and its data in ``rows``.

**The mapping table** ``MAP`` (below) is the ONE place that says where each field id comes from — a source spec, a
tuple of specs tried in order, or ``None`` (then ``UNAVAILABLE`` says why). Specs:

* ``profile:<key>`` the book profile · ``new:<key>`` a 🆕 field (``binder_fields.py``) of the page's subject
  (the book's ones live in the profile) · ``cover:<key>`` the cover design's texts · ``choices:<key>`` the ending and
  style choices · ``plan:<key>`` the premise (B01), main plot (B03) · ``forge:<key>`` the character's Forge dossier
  (which already merges the A01 canon, the character sheet and the voice card) · ``place:`` / ``magic:`` / ``item:``
  ``<key>`` the item / place / magic-system dossier (``forge_kinds_spec``), falling back to the A04 / A09 / A12 canon
  record · ``canon:<attr>`` an attribute of the page's canon record · ``pic:<slot>`` a picture (book assets: forge
  art, chapter pictures, the map, the cover art) · ``row:<key>`` a value of the current row of a repeating section ·
  ``auto:<name>`` computed here (codes, counts, approved %, chapters a character or place appears in, first
  appearance, page numbers in page order, the still-to-do list…) · ``const:<text>``.

Approved versions are preferred everywhere (canon, plan, chapters); drafts are marked (``draft: true`` on the field,
page status ``draft``), proposals keep ``status: proposed`` (page status ``needs_you``).

Looks (``LOOKS``): 7 style families for the 11 genres; the chosen one is stored per book (profile ``binder_look``,
``PUT …/binder/look``), else the genre's (``look_for_genre``). The exports: ``binder_docx.py`` (Word, stdlib) and
``binder_html.py`` (one self-contained HTML, the PDF through AutoInjector's ``POST /render/pdf``).
"""
from __future__ import annotations

import copy
import json
import logging
import re
from functools import cached_property
from itertools import zip_longest
from pathlib import Path

from . import binder_fields as bf
from . import characters as chars_mod
from .errors import AkoweError

log = logging.getLogger("akowe.binder")

SCHEMA_VERSION = 1
SCHEMA_PATH = Path(__file__).resolve().parent / "binder_schema.json"
TEXT_MAX = 1200
_REJ = {"status": "REJECTED"}

# ====================================================================== looks
LOOKS = {
    "classic": {"label": "Classic", "feel": "cream paper, deep green, gold rules, serif"},
    "fantasy": {"label": "Fantasy", "feel": "parchment, burgundy and antique gold, ornate corners"},
    "scifi": {"label": "Science fiction", "feel": "dark slate, cyan and violet, thin geometric lines"},
    "noir": {"label": "Noir case file", "feel": "charcoal and off-white, red accent, typewriter labels"},
    "romance": {"label": "Romance", "feel": "blush and ivory, rose and muted gold, rounded cards"},
    "horror": {"label": "Horror", "feel": "near-black, blood red, bone white, worn edges"},
    "playful": {"label": "Playful", "feel": "bright cheerful colours, rounded shapes, big friendly type"},
}
GENRE_LOOK = {"literary": "classic", "historical": "classic", "fantasy": "fantasy", "adventure": "fantasy",
              "science fiction": "scifi", "mystery": "noir", "thriller": "noir", "romance": "romance",
              "horror": "horror", "comedy": "playful", "children's picture book": "playful"}
_GENRE_WORDS = (("sci-fi", "scifi"), ("science", "scifi"), ("space", "scifi"), ("cyber", "scifi"),
                ("mystery", "noir"), ("thriller", "noir"), ("crime", "noir"), ("detective", "noir"),
                ("noir", "noir"), ("romance", "romance"), ("love", "romance"), ("horror", "horror"),
                ("gothic", "horror"), ("fantasy", "fantasy"), ("adventure", "fantasy"), ("myth", "fantasy"),
                ("comedy", "playful"), ("children", "playful"), ("picture book", "playful"), ("funny", "playful"),
                ("historical", "classic"), ("literary", "classic"))


def look_for_genre(genre: str | None) -> str:
    """The look of a genre (Akọwe's 11 genres; a free-text genre by its words; ``classic`` when unknown)."""
    g = " ".join(str(genre or "").replace("’", "'").lower().split())
    if g in GENRE_LOOK:
        return GENRE_LOOK[g]
    for word, look in _GENRE_WORDS:
        if word in g:
            return look
    return "classic"


# ====================================================================== the template spec
_SCHEMA_CACHE: dict = {}


def schema() -> dict:
    if not _SCHEMA_CACHE:
        _SCHEMA_CACHE.update(json.loads(SCHEMA_PATH.read_text(encoding="utf-8")))
    return _SCHEMA_CACHE


def all_ids() -> list[str]:
    return [f["id"] for t in schema().values() for s in t["sections"] for f in s["fields"]]


_MARKS = re.compile(r"\s*\*?\((?:pic|auto|pic, auto|pics|pic, optional)\)\*?|\s*🆕|\s*\*\([^)]*\)\*")


def clean_label(label: str) -> str:
    """"Cover art *(pic)* — falls back …" -> "Cover art — falls back …" (the marks are separate flags)."""
    return " ".join(_MARKS.sub("", str(label or "")).split())


def section_title(sec: dict) -> str:
    """"📋 Quick facts (5) — 1 Where …" -> "📋 Quick facts"."""
    return re.split(r"\s+\(|\s+—", sec["name"], maxsplit=1)[0].strip()


TEMPLATE_ICONS = {"1": "📕", "2": "📑", "3": "🔭", "4": "👥", "5": "🧑", "6": "🕸", "7": "🏙", "8A": "✴",
                  "8B": "🗡", "8C": "🌍", "9": "🗺", "10": "📈", "11": "📖", "12": "🔒"}

# ====================================================================== THE MAPPING TABLE (field id -> source)
# One entry per schema field id. A tuple is tried in order (the first one with a value wins). None = not available
# (UNAVAILABLE says why); the field is still on the page, empty.
MAP: dict[str, object] = {
    # ---- 1 Cover
    "1.1.1": "profile:title", "1.1.2": "cover:subtitle", "1.1.3": "profile:author",
    "1.1.4": ("auto:series_line", "cover:series"),
    "1.2.1": "pic:cover_art", "1.2.2": "auto:art_credit",
    "1.3.1": "const:BOOK BIBLE", "1.3.2": "profile:genre", "1.3.3": "auto:length_label", "1.3.4": "profile:audience",
    "1.3.5": "auto:chapter_count",
    "1.4.1": "auto:approved_percent", "1.4.2": "auto:drafts_waiting", "1.4.3": "auto:missing_pictures",
    "1.4.4": "auto:last_updated",
    "1.5.1": "auto:book_revision", "1.5.2": "auto:schema_version", "1.5.3": "const:Made with Akọwe + AutoInjector",
    # ---- 2 Contents (all rows)
    "2.1.1": "row:name", "2.1.2": "row:count", "2.1.3": "row:page",
    "2.2.1": "row:character", "2.2.2": "row:place", "2.2.3": "row:world",
    "2.3.1": "row:what", "2.3.2": "row:where", "2.3.3": "row:action",
    # ---- 3 At a glance
    "3.1.1": "profile:idea", "3.1.2": "auto:started",
    "3.2.1": ("plan:concept_summary", "auto:idea_first_sentence"), "3.3.1": "plan:premise",
    "3.4.1": "profile:genre", "3.4.2": "new:subgenre", "3.4.3": "profile:audience", "3.4.4": "profile:tone",
    "3.4.5": "auto:pov", "3.4.6": "auto:tense", "3.4.7": "auto:length_and_target", "3.4.8": "auto:chapters_planned_written",
    "3.4.9": "auto:reading_level",
    "3.5.1": "choices:ending", "3.5.2": "auto:ending_matrix", "3.5.3": "auto:style_choices", "3.5.4": "new:content_limits",
    "3.6.1": "row:portrait", "3.6.2": "row:name", "3.6.3": "row:role", "3.6.4": "row:one_line",
    "3.7.1": "auto:key_places", "3.7.2": "auto:theme_1", "3.7.3": "auto:theme_2", "3.7.4": "auto:theme_3",
    "3.7.5": ("new:central_question", "plan:dramatic_question"),
    # ---- 4 Cast list
    "4.1.1": "auto:cast_groups", "4.1.2": "auto:cast_count",
    "4.2.1": "row:portrait", "4.2.2": "row:name", "4.2.3": "row:code", "4.2.4": "row:role", "4.2.5": "row:one_line",
    "4.2.6": "row:age", "4.2.7": "row:first_chapter", "4.2.8": "row:status",
    "4.3.1": "const:By role · by status · no portrait yet",
    # ---- 5 Character page
    "5.1.1": "pic:portrait", "5.1.2": "auto:name", "5.1.3": "forge:name", "5.1.4": "auto:code_revision",
    "5.1.5": ("forge:role", "auto:sheet_role"), "5.1.6": ("auto:tagline", "auto:summary_line"),
    "5.2.1": ("new:age", "auto:canon_age"), "5.2.2": "new:birth", "5.2.3": "new:pronouns", "5.2.4": "new:species",
    "5.2.5": "new:height", "5.2.6": "new:weight", "5.2.7": "new:build", "5.2.8": ("new:eyes", "forge:eyes"),
    "5.2.9": ("new:hair", "forge:hair"), "5.2.10": ("new:skin", "forge:skin"), "5.2.11": ("new:marks", "forge:markings"),
    "5.2.12": "new:occupation", "5.2.13": "new:home", "5.2.14": "new:family_status", "5.2.15": "new:era",
    "5.2.16": "new:handedness",
    "5.3.1": "pic:sheet", "5.3.2": "pic:front", "5.3.3": "pic:side", "5.3.4": "pic:back", "5.3.5": "pic:extra_views",
    "5.3.6": "pic:clip",
    "5.4.1": "forge:traits", "5.4.2": None, "5.4.3": "forge:wants", "5.4.4": "forge:needs", "5.4.5": "forge:fear",
    "5.4.6": "forge:secret", "5.4.7": "forge:false_belief", "5.4.8": "forge:stress", "5.4.9": "forge:never_say",
    "5.4.10": "forge:private_memory", "5.4.11": "forge:change_limits", "5.4.12": "forge:public_private",
    "5.5.1": "forge:goals", "5.5.2": "forge:objective", "5.5.3": "forge:constraints", "5.5.4": None,
    "5.6.1": "forge:appearance", "5.6.2": "forge:physique", "5.6.3": "forge:face", "5.6.4": "forge:posture",
    "5.6.5": "forge:gait", "5.6.6": "forge:presence", "5.6.7": "forge:clothing", "5.6.8": "forge:combat_clothing",
    "5.6.9": "forge:accessories", "5.6.10": "forge:anatomy",
    "5.7.1": "forge:rhythm", "5.7.2": "forge:register", "5.7.3": "forge:vocabulary", "5.7.4": "forge:phrases",
    "5.7.5": "forge:never_words", "5.7.6": "forge:habits", "5.7.7": "forge:speech_fear", "5.7.8": "forge:speech_anger",
    "5.7.9": "forge:speech_grief", "5.7.10": "forge:talks_around", "5.7.11": "auto:sample_1", "5.7.12": "auto:sample_2",
    "5.8.1": "row:portrait", "5.8.2": "row:name", "5.8.3": "row:type", "5.8.4": "row:note",
    "5.9.1": "forge:practical_skills", "5.9.2": "forge:combat_skills", "5.9.3": "forge:social_skills",
    "5.9.4": "forge:natural_talents", "5.9.5": "forge:supernatural_abilities", "5.9.6": "forge:senses",
    "5.9.7": "new:stat_strength", "5.9.8": "new:stat_speed", "5.9.9": "new:stat_agility", "5.9.10": "new:stat_stamina",
    "5.9.11": "new:stat_durability", "5.9.12": "auto:fighting_style", "5.9.13": "forge:signature_moves",
    "5.9.14": "forge:exploitable_habits",
    "5.10.1": "forge:primary_weapon", "5.10.2": "auto:backup_ranged", "5.10.3": "forge:signature_possessions",
    "5.10.4": "forge:resources", "5.10.5": "forge:weapon_weaknesses",
    "5.11.1": "forge:education", "5.11.2": "forge:languages", "5.11.3": "forge:specialist_subjects",
    "5.11.4": "forge:blind_spots", "5.11.5": "forge:unknowns", "5.11.6": "forge:reader_knowledge",
    "5.12.1": "row:title", "5.12.2": "row:text",
    "5.13.1": "forge:opening", "5.13.2": "forge:inciting_incident", "5.13.3": "forge:obstacles",
    "5.13.4": "forge:midpoint", "5.13.5": "forge:setback", "5.13.6": "forge:decisive_choice", "5.13.7": "forge:climax",
    "5.13.8": "forge:resolution", "5.13.9": "forge:change_hook", "5.13.10": None,
    "5.14.1": "auto:first_appearance", "5.14.2": "auto:chapters_in", "5.14.3": "forge:must_show_1",
    "5.14.4": "forge:must_show_2", "5.14.5": "forge:must_show_3", "5.14.6": "forge:must_show_4",
    "5.14.7": "forge:must_show_5", "5.14.8": "forge:visual_anchors", "5.14.9": "forge:timeline_ledger",
    "5.14.10": "forge:power_ledger", "5.14.11": "forge:secrets_ledger", "5.14.12": "forge:reveal_points",
    "5.14.13": "auto:linked_records",
    # ---- 6 Relationship map
    "6.1.1": "auto:bubbles", "6.1.2": "auto:lines", "6.1.3": "auto:centre", "6.1.4": "auto:closeness",
    "6.2.1": "auto:legend_family", "6.2.2": "auto:legend_love", "6.2.3": "auto:legend_ally",
    "6.2.4": "auto:legend_rival", "6.2.5": "auto:legend_enemy", "6.2.6": "auto:legend_mentor",
    "6.3.1": "row:tie", "6.4.1": "row:group",
    # ---- 7 Place page
    "7.1.1": "pic:establishing", "7.1.2": "auto:name_aliases", "7.1.3": "auto:code", "7.1.4": "place:place_type",
    "7.1.5": ("place:one_line", "canon:description"), "7.1.6": "place:role_in_story",
    "7.2.1": ("place:location", "canon:geography"), "7.2.2": "place:setting_time", "7.2.3": "place:size_scale",
    "7.2.4": "place:terrain", "7.2.5": "place:population", "7.2.6": "place:rulers", "7.2.7": "new:danger_level",
    "7.2.8": "place:first_impression",
    "7.3.1": "pic:day", "7.3.2": "pic:night", "7.3.3": "pic:interior",
    "7.4.1": "place:sights", "7.4.2": "place:sounds", "7.4.3": "place:smells", "7.4.4": "place:touch",
    "7.4.5": "place:light", "7.4.6": None, "7.4.7": "place:mood", "7.4.8": "place:seasons",
    "7.4.9": "place:signature_detail",
    "7.5.1": ("place:map_notes", "place:location", "canon:geography"), "7.5.2": ("place:layout", "canon:containment"),
    "7.5.3": "place:landmarks", "7.5.4": "place:districts", "7.5.5": "place:terrain", "7.5.6": "place:architecture",
    "7.5.7": "pic:map_crop",
    "7.6.1": "place:founding", "7.6.2": "place:eras", "7.6.3": "place:key_events", "7.6.4": "place:ruins",
    "7.6.5": "place:recent_change", "7.6.6": "place:myths", "7.6.7": "place:timeline_facts",
    "7.7.1": "place:population", "7.7.2": "place:factions", "7.7.3": "place:rulers", "7.7.4": "place:economy",
    "7.7.5": "place:culture", "7.7.6": "place:language", "7.7.7": "place:notable_people", "7.7.8": "place:outsiders",
    "7.8.1": "place:laws", "7.8.2": "place:dangers", "7.8.3": "place:hazards", "7.8.4": "place:forbidden",
    "7.8.5": "place:magic_here", "7.8.6": "place:defences", "7.8.7": "place:safe_havens",
    "7.9.1": "place:access", "7.9.2": ("place:routes", "canon:travel"), "7.9.3": "place:travel_times",
    "7.9.4": "place:hidden_ways", "7.9.5": "place:transport", "7.9.6": "place:borders",
    "7.10.1": ("place:first_appearance", "auto:first_appearance"), "7.10.2": ("auto:scenes_here", "place:scenes_set_here"),
    "7.10.3": "place:how_it_changes", "7.10.4": ("place:characters_here", "auto:characters_here"),
    "7.10.5": "place:reveal_points", "7.10.6": "place:must_show_1", "7.10.7": "place:must_show_2",
    "7.10.8": "place:must_show_3", "7.10.9": "place:fixed_anchors", "7.10.10": "place:state_ledger",
    "7.10.11": "place:occupancy_ledger", "7.10.12": "place:secrets_ledger", "7.10.13": "auto:linked_records",
    # ---- 8A Magic system
    "8A.1.1": "pic:sigil", "8A.1.2": "auto:name_aliases", "8A.1.3": "auto:code", "8A.1.4": "magic:kind_of_power",
    "8A.1.5": ("magic:one_line", "canon:concept"),
    "8A.2.1": "magic:source", "8A.2.2": "magic:who_has_it", "8A.2.3": ("magic:how_gained", "canon:prerequisites"),
    "8A.2.4": "magic:rarity", "8A.2.5": ("magic:cost", "canon:costs"),
    "8A.3.1": ("magic:core_rules", "canon:powers"), "8A.3.2": ("magic:hard_limits", "canon:limits"),
    "8A.3.3": "magic:range_duration", "8A.3.4": "magic:cannot_do", "8A.3.5": "magic:counters",
    "8A.3.6": ("magic:exceptions", "canon:exceptions"), "8A.3.7": "magic:interactions",
    "8A.4.1": "row:name", "8A.4.2": "row:does", "8A.4.3": "row:users",
    "8A.5.1": "magic:activation", "8A.5.2": "magic:recovery", "8A.5.3": "magic:price_long",
    "8A.5.4": "auto:combinations_rituals",
    "8A.6.1": "magic:visual_signs", "8A.6.2": "magic:sounds_smells", "8A.6.3": "magic:on_the_body",
    "8A.6.4": "magic:environment_signs", "8A.6.5": "magic:tells",
    "8A.7.1": "magic:failure_conditions", "8A.7.2": "magic:backlash", "8A.7.3": "magic:overuse",
    "8A.7.4": "magic:misuse", "8A.7.5": "magic:worst_case",
    "8A.8.1": "magic:practitioners", "8A.8.2": "magic:training", "8A.8.3": "magic:ranks", "8A.8.4": "magic:schools",
    "8A.8.5": "magic:mastery",
    "8A.9.1": "magic:origin_story", "8A.9.2": "magic:key_events", "8A.9.3": "magic:lore",
    "8A.9.4": "magic:lost_knowledge",
    "8A.10.1": "magic:public_view", "8A.10.2": "magic:law", "8A.10.3": "magic:institutions",
    "8A.10.4": "magic:prejudice",
    "8A.11.1": "pic:in_use", "8A.11.2": ("magic:first_use", "auto:first_appearance"), "8A.11.3": "magic:escalation",
    "8A.11.4": "magic:climax_use", "8A.11.5": "magic:power_ledger", "8A.11.6": "magic:secrets_ledger",
    # ---- 8B Item
    "8B.1.1": "pic:portrait", "8B.1.2": "auto:name_aliases", "8B.1.3": "auto:code", "8B.1.4": "item:item_type",
    "8B.1.5": ("item:one_line", "canon:concept"),
    "8B.2.1": "item:size_weight", "8B.2.2": "item:materials", "8B.2.3": "item:colours", "8B.2.4": "item:current_holder",
    "8B.2.5": "item:status_now", "8B.2.6": "item:value",
    "8B.3.1": "pic:front", "8B.3.2": "pic:side", "8B.3.3": "pic:back", "8B.3.4": "pic:detail",
    "8B.4.1": ("item:abilities", "canon:properties"), "8B.4.2": "item:how_it_works", "8B.4.3": "item:activation",
    "8B.4.4": ("item:limits", "canon:restrictions"), "8B.4.5": "item:costs", "8B.4.6": "item:weaknesses",
    "8B.4.7": "item:cannot_do",
    "8B.5.1": "item:who_can_use", "8B.5.2": "item:skill_needed", "8B.5.3": "item:combat_use",
    "8B.5.4": "item:maintenance", "8B.5.5": "item:damage",
    "8B.6.1": ("item:origin", "canon:origin"), "8B.6.2": "item:made_when", "8B.6.3": "item:previous_owners",
    "8B.6.4": "item:key_events", "8B.6.5": "item:legends", "8B.6.6": "item:provenance_gaps",
    "8B.7.1": "item:owner", "8B.7.2": "item:forbidden_users", "8B.7.3": "item:who_wants_it", "8B.7.4": "item:transfers",
    "8B.7.5": "item:bond", "8B.7.6": "item:significance",
    "8B.8.1": ("item:first_appearance", "auto:first_appearance"), "8B.8.2": "item:introduction",
    "8B.8.3": "item:key_scenes", "8B.8.4": "item:turning_point", "8B.8.5": "item:final_state",
    "8B.8.6": "item:location_ledger", "8B.8.7": "item:condition_ledger", "8B.8.8": "item:uses_ledger",
    "8B.8.9": "item:secrets_ledger", "8B.8.10": "item:visual_anchors", "8B.8.11": "auto:linked_records",
    # ---- 8C Other world entry (A02/A03/A05-A08/A10/A11/A13+ canon records)
    "8C.1.1": None, "8C.1.2": "auto:name", "8C.1.3": "auto:world_kind", "8C.1.4": "canon:concept",
    "8C.2.1": "auto:full_description",
    "8C.3.1": "auto:founded", "8C.3.2": "auto:reach", "8C.3.3": "auto:leaders", "8C.3.4": "auto:base",
    "8C.3.5": "new:symbol_colours",
    "8C.4.1": "auto:tenets", "8C.4.2": "auto:forbidden", "8C.4.3": "auto:views_of_others",
    "8C.5.1": "auto:members", "8C.5.2": "canon:alliances", "8C.5.3": "canon:rivalries",
    "8C.6.1": "auto:first_appearance", "8C.6.2": "canon:goals", "8C.6.3": "auto:protected_flags",
    "8C.6.4": "auto:linked_records",
    # ---- 9 Map page
    "9.1.1": "pic:map", "9.1.2": "auto:markers",
    "9.2.1": "row:number", "9.2.2": "row:name", "9.2.3": "row:page",
    "9.3.1": "row:from_to", "9.3.2": "row:time", "9.3.3": "row:how",
    "9.4.1": "auto:compass", "9.4.2": "auto:scale",
    # ---- 10 Story plan
    "10.1.1": "plan:premise", "10.1.2": "plan:main_plot",
    "10.2.1": "auto:beat_opening", "10.2.2": "auto:beat_inciting", "10.2.3": "auto:beat_first_plot_point",
    "10.2.4": "auto:beat_midpoint", "10.2.5": "auto:beat_crisis", "10.2.6": "auto:beat_climax",
    "10.2.7": "auto:beat_resolution", "10.2.8": "auto:beat_final_image",
    "10.3.1": "row:name", "10.3.2": "row:starts", "10.3.3": "row:ends",
    "10.4.1": "row:name", "10.4.2": "row:about", "10.4.3": "row:chapters",
    "10.5.1": "auto:themes", "10.5.2": "auto:motifs", "10.5.3": "auto:recurring_images",
    "10.5.4": ("new:central_question", "plan:dramatic_question"),
    "10.6.1": "choices:ending", "10.6.2": "auto:ending_matrix", "10.6.3": "auto:left_open", "10.6.4": "auto:sequel_hook",
    # ---- 11 Chapter page
    "11.1.1": "auto:chapter_number", "11.1.2": "auto:chapter_title", "11.1.3": "pic:chapter",
    "11.1.4": "auto:chapter_status", "11.1.5": "auto:word_count", "11.1.6": "auto:word_target",
    "11.2.1": "auto:pov", "11.2.2": "auto:main_place", "11.2.3": "auto:story_time", "11.2.4": "new:time_since_previous",
    "11.3.1": "auto:chapter_summary", "11.3.2": "auto:chapter_goal",
    "11.4.1": "row:number", "11.4.2": "row:goal", "11.4.3": "row:conflict", "11.4.4": "row:outcome",
    "11.4.5": "row:who", "11.4.6": "row:where_when",
    "11.5.1": "row:who",
    "11.6.1": "row:detail", "11.6.2": "row:on_page",
    "11.7.1": None, "11.7.2": "auto:planted_threads",
    "11.8.1": "auto:readability", "11.8.2": "auto:editor_score", "11.8.3": "auto:repeats", "11.8.4": "auto:continuity",
    # ---- 12 Rules & facts
    "12.1.1": "row:fact", "12.1.2": "row:about", "12.1.3": "row:why",
    "12.2.1": "auto:rules_hard_rule", "12.2.2": "auto:rules_seen", "12.2.3": "auto:rules_belief",
    "12.2.4": "auto:rules_mystery",
    "12.3.1": "row:date", "12.3.2": "row:event", "12.3.3": "row:chapter", "12.3.4": "row:clash",
    "12.4.1": "row:term", "12.4.2": "row:meaning", "12.4.3": "row:type", "12.4.4": "row:checked",
    "12.5.1": "row:detail", "12.5.2": "row:where",
    "12.6.1": "auto:narrative_voice", "12.6.2": "auto:tense", "12.6.3": "auto:pov_rules", "12.6.4": "auto:reading_level",
    "12.6.5": "choices:dialogue", "12.6.6": "auto:spelling", "12.6.7": "auto:words_to_avoid",
    "12.7.1": "row:phrase", "12.7.2": "row:kind",
}
UNAVAILABLE = {
    "5.4.2": "the Forge keeps the traits and their contradiction in one field (5.4.1 Traits)",
    "5.5.4": "the Forge keeps what they won't do and what they can't do in one field (5.5.3 Constraints)",
    "5.13.10": "the Forge keeps the resulting change and the optional hook in one field (5.13.9)",
    "7.4.6": "the place dossier keeps light by day and by night in one field (7.4.5 Light)",
    "8C.1.1": "no emblem pictures are stored for groups, beliefs and world entries yet (no Forge dossier for them)",
    "11.7.1": "Akọwe stores no set-up / pay-off links between chapters yet (only the planted, unresolved threads)",
}
# The repeating sections and the row producer each one uses (the row keys are the row:<key> specs above).
ROWS = {"2.1": "contents_rows", "2.2": "jump_rows", "2.3": "todo_rows", "3.6": "main_cast_rows",
        "4.2": "cast_rows", "5.8": "relationship_rows", "5.12": "backstory_rows", "6.3": "tie_rows",
        "6.4": "group_rows", "8A.4": "power_rows", "9.2": "map_key_rows", "9.3": "distance_rows",
        "10.3": "arc_rows", "10.4": "subplot_rows", "11.4": "scene_rows", "11.5": "here_rows",
        "11.6": "must_rows", "12.1": "protected_rows", "12.3": "timeline_rows", "12.4": "term_rows",
        "12.5": "texture_rows", "12.7": "repeat_rows"}
# Fields that are a 🆕 value Akọwe stores (binder_fields.py), for the "new" flag on the page.
NEW_IDS = {i for i, s in MAP.items() if isinstance(s, str) and s.startswith("new:")} | \
    {i for i, s in MAP.items() if isinstance(s, tuple) and str(s[0]).startswith("new:")} | \
    {"5.8.3", "1.1.4", "3.7.2", "3.7.3", "3.7.4", "4.2.6", "10.5.1"}  # built from 🆕 values (auto / rows)
SECTION_EDIT = {}  # (filled below: per template, the page an "✏ Edit" button opens)


def source_kinds() -> dict:
    """{id: "data"|"new"|"auto"|"pic"|"row"|"const"|"none"} — what each id is (for the report and the audit test)."""
    out = {}
    for i in all_ids():
        s = MAP.get(i)
        first = s[0] if isinstance(s, tuple) else s
        if first is None:
            out[i] = "none"
        elif i in NEW_IDS:
            out[i] = "new"
        else:
            out[i] = str(first).split(":", 1)[0].replace("profile", "data").replace("forge", "data") \
                .replace("place", "data").replace("magic", "data").replace("item", "data") \
                .replace("canon", "data").replace("plan", "data").replace("cover", "data") \
                .replace("choices", "data")
    return out


# ====================================================================== small helpers
def _clip(v, n: int = TEXT_MAX) -> str:
    if v is None or isinstance(v, bool):
        return ""
    if isinstance(v, (list, tuple)):
        v = " · ".join(str(x) for x in v if x not in (None, ""))
    if isinstance(v, dict):
        return ""
    lines = [" ".join(x.split()) for x in str(v).replace("\r", "").split("\n")]
    return "\n".join(x for x in lines if x)[:n].strip()


def slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "-", str(text or "")).strip("-")[:80] or "x"


def _first_sentence(text: str) -> str:
    t = _clip(text, 600)
    m = re.match(r"^(.{20,300}?[.!?])(\s|$)", t, re.S)
    return (m.group(1) if m else t[:300]).strip()


def empty_field(source: str | None = None) -> dict:
    out = {"value": "", "status": "empty"}
    if source:
        out["source"] = source
    return out


def _f(value, status: str, source: str, edit: dict | None = None, **extra) -> dict | None:
    v = value if isinstance(value, (int, float)) and not isinstance(value, bool) else _clip(value)
    if v in ("", None):
        return None
    out = {"value": v, "status": status, "source": source}
    if edit:
        out["edit"] = edit
    out.update({k: x for k, x in extra.items() if x not in (None, False)})
    return out


def _asset_url(pid, branch, a) -> str | None:
    from . import forge  # noqa: PLC0415
    p = forge._art_public(pid, branch, a)  # noqa: SLF001 - the one asset URL rule
    return p["url"] if p else None


# ====================================================================== the book (everything read once, lazily)
class Book:
    """Everything the binder reads, read once per build (lazy properties; every read is best effort)."""

    def __init__(self, app, pid: str, branch: str):
        self.app, self.store, self.pid, self.branch = app, app.store, pid, branch
        self.principal = getattr(app, "principal_id", "author")

    # ------------------------------------------------------------------ book level
    @cached_property
    def prof(self) -> dict:
        from .book_path import get_profile  # noqa: PLC0415
        return get_profile(self.store, self.pid) or {}

    @cached_property
    def project(self) -> dict:
        return dict(self.store.project(self.pid) or {})

    @cached_property
    def title(self) -> str:
        return self.prof.get("title") or self.project.get("name") or "Untitled book"

    @cached_property
    def choices(self) -> dict:
        from . import story_choices  # noqa: PLC0415
        try:
            return story_choices.of_profile(self.prof)
        except Exception:  # noqa: BLE001
            return {}

    @cached_property
    def bp(self):
        from .book_path import BookPath  # noqa: PLC0415
        return BookPath(self.app.engine, self.principal, self.pid, self.branch)

    @cached_property
    def outline(self):
        try:
            return self.bp.outline()
        except Exception:  # noqa: BLE001
            return None

    @cached_property
    def plan(self) -> dict:
        """{premise|main_plot|outline: {record, approved, data}} — approved revision, else the newest draft."""
        out = {}
        for op, key in (("B01", "premise"), ("B03", "main_plot"), ("B11", "outline")):
            try:
                appr = self.bp.approved(op)
                rec = appr[0] if appr else None
                if rec is None:
                    drafts = sorted(self.bp.drafts(op), key=lambda r: r.get("created_at") or "", reverse=True)
                    rec = drafts[0] if drafts else None
            except Exception:  # noqa: BLE001
                rec, appr = None, None
            if rec is not None:
                out[key] = {"record_id": rec["record_id"], "version": rec["version"], "approved": bool(appr),
                            "data": rec.get("data") or {}}
        return out

    @cached_property
    def length(self) -> dict:
        from . import lengths as lengths_mod  # noqa: PLC0415
        try:
            return lengths_mod.chapter_plan(self.prof, len(self.chapters) or None, self.store)
        except Exception:  # noqa: BLE001
            return {}

    @cached_property
    def chapters(self) -> list[dict]:
        """The outline's chapters in order: plan facts, the text (approved, else the newest draft) and its state."""
        from . import scenes as scenes_mod  # noqa: PLC0415
        out = []
        if not self.outline:
            return out
        try:
            plan_chs = self.bp.outline_chapters(self.outline)
        except Exception:  # noqa: BLE001
            return out
        entries = scenes_mod.all_entries(self.store, self.pid, self.branch)
        for i, ch in enumerate(plan_chs):
            cid = ch["chapter_id"]
            try:
                plan = scenes_mod.chapter_plan(self.bp, self.outline, cid)
            except Exception:  # noqa: BLE001
                plan = {}
            try:
                _ctx, latest, appr = self.bp.chapter_prose(self.outline, cid)
            except Exception:  # noqa: BLE001
                latest, appr = None, None
            rec = appr or latest
            text = str((rec or {}).get("data", {}).get("text") or "") if rec else ""
            first = text.lstrip().split("\n", 1)[0]
            title = first[2:].strip()[:120] if first.startswith("# ") else ""
            e = entries.get(scenes_mod.ekey(self.outline["record_id"], cid))
            cards = (e or {}).get("cards") or [] if scenes_mod.usable(e, self.outline) else []
            from . import lengths as lengths_mod  # noqa: PLC0415
            out.append({"chapter_id": cid, "number": i + 1, "objective": ch.get("objective") or "",
                        "summary": ch.get("summary") or "", "plan": plan, "text": text,
                        "words": lengths_mod.words(text) if text else 0, "title": title, "written": bool(rec),
                        "approved": bool(appr), "record_id": (rec or {}).get("record_id"),
                        "version": (rec or {}).get("version"), "cards": cards, "scene_entry": e})
        return out

    # ------------------------------------------------------------------ canon and dossiers
    @cached_property
    def chars(self) -> list[dict]:
        try:
            return chars_mod.canon_characters(self.store, self.pid, self.branch)
        except Exception:  # noqa: BLE001
            return []

    @cached_property
    def sheets(self) -> dict:
        return chars_mod.all_entries(self.store, self.pid, self.branch)

    @cached_property
    def dossiers(self) -> dict:
        """{A01 record id: the character's Forge dossier (public view, with links)}."""
        from . import forge, forge_kinds  # noqa: PLC0415
        out = {}
        for c in self.chars:
            try:
                d = forge.public(self.store, self.pid, self.branch, c["record_id"])
                try:
                    d = forge_kinds.attach_links(self.store, self.pid, self.branch, d)
                except Exception:  # noqa: BLE001 - links are a nicety
                    pass
                out[c["record_id"]] = d
            except Exception:  # noqa: BLE001
                log.exception("binder: dossier of a character could not be read")
        return out

    def _kind_entities(self, kind: str, op: str) -> list[dict]:
        """Items / places / magic systems: the Forge dossiers, then the canon records (A12 / A04 / A09) that have
        none. [{id, name, aliases, code, dossier, canon (record), approved, source_id}]"""
        from . import forge, forge_kinds  # noqa: PLC0415
        out = []
        try:
            tiles = forge_kinds.list_dossiers(self.store, self.pid, self.branch, kind)
        except Exception:  # noqa: BLE001
            tiles = []
        try:
            heads = forge_kinds._heads(self.store, self.pid, self.branch, op)  # noqa: SLF001
        except Exception:  # noqa: BLE001
            heads = []
        subjects = []
        for rec in heads:
            for subj, name in forge_kinds._subjects(rec):  # noqa: SLF001
                subjects.append((f"{op}:{rec['record_id']}:{subj}", name, rec, subj))
        used = set()
        for t in tiles:
            try:
                d = forge_kinds.attach_links(self.store, self.pid, self.branch,
                                             forge_kinds.public(self.store, self.pid, self.branch, kind,
                                                                t["record_id"]))
            except Exception:  # noqa: BLE001
                continue
            src = (d.get("source") or {}).get("source_id") if isinstance(d.get("source"), dict) else None
            match = next((s for s in subjects if s[0] == src), None) or \
                next((s for s in subjects if s[1].lower() == (d.get("name") or "").lower()), None)
            if match:
                used.add(match[0])
            canon = match[2] if match else None
            key = match[0] if match else (src if src else t["record_id"])
            out.append({"id": key, "name": d.get("name") or (match[1] if match else ""), "aliases": d.get("aliases")
                        or [], "code": d.get("code"), "dossier": d, "canon": canon, "subject_id": match[3] if match
                        else None, "approved": d.get("readiness") == "ready"})
        n = max([forge._code_num(e["code"]) for e in out if e.get("code")] + [0])  # noqa: SLF001
        for sid, name, rec, subj in subjects:
            if sid in used or any(e["name"].lower() == name.lower() for e in out):
                continue
            n += 1
            out.append({"id": sid, "name": name, "aliases": [], "code": f"{forge.KINDS[kind]}-{n:03d}",
                        "dossier": None, "canon": rec, "subject_id": subj,
                        "approved": bool(rec.get("lifecycle") in ("APPROVED", "LOCKED") or rec.get("approved_version")
                                         == rec.get("version"))})
        return out

    @cached_property
    def places(self) -> list[dict]:
        return self._kind_entities("place", "A04")

    @cached_property
    def magic(self) -> list[dict]:
        return self._kind_entities("magic", "A09")

    @cached_property
    def items(self) -> list[dict]:
        return self._kind_entities("item", "A12")

    @cached_property
    def others(self) -> list[dict]:
        """Every other Set A canon entry (the world, beliefs, groups, organisations, cultures, …): [{id, name, op,
        kind, rec, approved}]."""
        from . import forge_kinds  # noqa: PLC0415
        out = []
        try:
            heads = [r for r in self.store.list_records(self.pid, self.branch) if str(r["module_id"]).startswith("A")
                     and r["module_id"] not in ("A01", "A04", "A09", "A12") and r.get("record_kind") == "OUTPUT"]
        except Exception:  # noqa: BLE001
            heads = []
        mods = sorted({r["module_id"] for r in heads})
        for op in mods:
            for rec in forge_kinds._heads(self.store, self.pid, self.branch, op):  # noqa: SLF001
                name = chars_mod._name_and_subject(rec)[0]  # noqa: SLF001
                try:
                    kind = self.app.engine.contracts.operation(op)["name"]
                except Exception:  # noqa: BLE001
                    kind = op
                out.append({"id": rec["record_id"], "name": name, "op": op, "kind": kind, "rec": rec,
                            "approved": rec.get("lifecycle") in ("APPROVED", "LOCKED")})
        return out

    # ------------------------------------------------------------------ companion data
    @cached_property
    def extras(self) -> dict:
        return bf.get_doc(self.store, self.pid, self.branch)

    def new_values(self, target: str) -> dict:
        try:
            return bf.values(self.store, self.pid, self.branch, target, self.extras)
        except AkoweError:
            return {}

    @cached_property
    def rules(self) -> list[dict]:
        from . import story_rules  # noqa: PLC0415
        return story_rules.active(story_rules.get_entry(self.store, self.pid, self.branch))

    @cached_property
    def texture(self) -> list[dict]:
        from . import texture as texture_mod  # noqa: PLC0415
        return list((texture_mod.get_entry(self.store, self.pid, self.branch) or {}).get("items") or [])

    @cached_property
    def terms(self) -> list[dict]:
        from . import terms as terms_mod  # noqa: PLC0415
        return list((terms_mod.get_entry(self.store, self.pid, self.branch) or {}).get("items") or [])

    @cached_property
    def texts(self) -> list[tuple[str, str]]:
        return [(c["chapter_id"], c["text"]) for c in self.chapters if c["text"]]

    @cached_property
    def repeats(self) -> dict:
        from . import repetition  # noqa: PLC0415
        if not self.texts:
            return {"repeats": []}
        try:
            labels = repetition.get_labels(self.store, self.pid, self.branch).get("labels") or {}
            voices = chars_mod.voice_words(self.store, self.pid, self.branch)
            motifs = [w for t in self.texture for w in (t.get("words") or [])]
            return repetition.sort_repeats(self.texts, names=[c["name"] for c in self.chars], voices=voices,
                                           motifs=motifs, labels=labels)
        except Exception:  # noqa: BLE001
            log.exception("binder: repetition sort failed")
            return {"repeats": []}

    @cached_property
    def timeline(self) -> dict:
        from . import timeline_check  # noqa: PLC0415
        if not self.texts:
            return {"years": [], "findings": []}
        try:
            from . import terms as terms_mod  # noqa: PLC0415
            year = (terms_mod.get_entry(self.store, self.pid, self.branch) or {}).get("story_year")
            return timeline_check.check_book(self.texts, names=[c["name"] for c in self.chars],
                                             characters=self.chars, story_year=year)
        except Exception:  # noqa: BLE001
            log.exception("binder: timeline check failed")
            return {"years": [], "findings": []}

    @cached_property
    def canon_ages(self) -> dict:
        from . import timeline_check  # noqa: PLC0415
        try:
            return timeline_check.canon_ages(self.chars) or {}
        except Exception:  # noqa: BLE001
            return {}

    @cached_property
    def style(self) -> dict:
        from . import style_card  # noqa: PLC0415
        if self.texts:
            try:
                return style_card.stats([t for _c, t in self.texts])
            except Exception:  # noqa: BLE001
                return {}
        return {}

    @cached_property
    def readability(self) -> dict:
        from . import readability  # noqa: PLC0415
        try:
            return readability.book(self.texts, audience=self.prof.get("audience"), genre=self.prof.get("genre"))
        except Exception:  # noqa: BLE001
            return {}

    @cached_property
    def crafts(self) -> dict:
        try:
            return self.app.review.editor.crafts(self.pid, self.branch)
        except Exception:  # noqa: BLE001
            return {}

    @cached_property
    def planned_store(self) -> dict:
        try:
            return self.app.review.planned.stored(self.pid, self.branch)
        except Exception:  # noqa: BLE001
            return {}

    @cached_property
    def continuity_lint(self) -> dict:
        from . import continuity  # noqa: PLC0415
        if not self.texts:
            return {}
        try:
            chs = [{"chapter_id": c["chapter_id"], "number": c["number"], "text": c["text"]} for c in self.chapters
                   if c["text"]]
            return continuity.checks(self.store, self.pid, self.branch, chs, [c["chapter_id"] for c in chs])
        except Exception:  # noqa: BLE001
            return {}

    @cached_property
    def pictures(self) -> dict:
        from . import pictures  # noqa: PLC0415
        try:
            return pictures.doc(self.store, self.pid, self.branch)
        except Exception:  # noqa: BLE001
            return {"pictures": {}}

    @cached_property
    def cover(self) -> dict:
        from . import cover  # noqa: PLC0415
        try:
            return cover.get_design(self.store, self.pid, self.branch)
        except Exception:  # noqa: BLE001
            return {}

    @cached_property
    def map_graph(self) -> dict | None:
        from . import pictures  # noqa: PLC0415
        if not self.places:
            return None
        try:
            return pictures.map_graph(self.app, self.principal, self.pid, self.branch)
        except Exception:  # noqa: BLE001
            return None

    # ------------------------------------------------------------------ who / where is in which chapter
    @cached_property
    def presence(self) -> dict:
        """{A01 record id: [chapter numbers]} — named in the chapter text, else in its plan (summary, scene cards,
        POV)."""
        out: dict = {c["record_id"]: [] for c in self.chars}
        for ch in self.chapters:
            blob = ch["text"] or "\n".join([ch["summary"], ch["objective"]] + [
                json.dumps(card, ensure_ascii=False) for card in ch["cards"]])
            pov = (ch["plan"] or {}).get("pov_id")
            for c in chars_mod.present_in(self.chars, blob, ids=[pov] if pov else ()):
                out.setdefault(c["record_id"], []).append(ch["number"])
        return out

    def mentions(self, names: list[str]) -> list[int]:
        """Chapter numbers whose text (else plan) names one of ``names`` (whole words, case-insensitive)."""
        names = [n for n in names if n and len(n) >= 3]
        if not names:
            return []
        pat = re.compile(r"\b(" + "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True)) + r")\b", re.I)
        out = []
        for ch in self.chapters:
            blob = ch["text"] or "\n".join([ch["summary"], ch["objective"]] + [
                json.dumps(card, ensure_ascii=False) for card in ch["cards"]])
            if pat.search(blob):
                out.append(ch["number"])
        return out

    def char_by_id(self, ident) -> dict | None:
        if not ident:
            return None
        ident = str(ident).lower()
        return next((c for c in self.chars if ident in (c["record_id"].lower(), c["subject_id"].lower(),
                                                        c["name"].lower())), None)

    def char_by_name(self, name: str) -> dict | None:
        n = (name or "").split("/")[0].strip().lower()
        if not n:
            return None
        return next((c for c in self.chars if c["name"].lower() == n), None) or \
            next((c for c in self.chars if n in c["name"].lower() or c["name"].lower() in n), None)

    def place_by_id(self, ident) -> dict | None:
        if not ident:
            return None
        ident = str(ident).lower()
        return next((p for p in self.places if ident in (str(p.get("subject_id") or "").lower(), p["id"].lower(),
                                                         p["name"].lower())), None)

    @cached_property
    def pov_counts(self) -> dict:
        out: dict = {}
        for ch in self.chapters:
            c = self.char_by_id((ch["plan"] or {}).get("pov_id"))
            if c:
                out[c["record_id"]] = out.get(c["record_id"], 0) + 1
        return out

    def role_of(self, c: dict) -> str:
        """main | side | minor (the character sheet's role; a POV character is main)."""
        r = ((self.sheets.get(c["record_id"]) or {}).get("sheet") or {}).get("role")
        if r in ("main", "side"):
            return r
        return "main" if self.pov_counts.get(c["record_id"]) else "minor"

    @cached_property
    def protagonist(self) -> dict | None:
        if not self.chars:
            return None
        ranked = sorted(self.chars, key=lambda c: (-self.pov_counts.get(c["record_id"], 0),
                                                   {"main": 0, "side": 1, "minor": 2}[self.role_of(c)]))
        return ranked[0]


# ====================================================================== pages
class Page:
    """One template instance being filled."""

    def __init__(self, book: Book, template: str, page_id: str, title: str, *, entry_id=None, target=None,
                 subject=None):
        self.book, self.template, self.page_id, self.title = book, template, page_id, title
        self.entry_id, self.target, self.subject = entry_id, target, subject or {}
        self.number = 0
        self.pics: dict = {}
        self.extra: dict = {}
        self.draft = False

    # ------------------------------------------------------------------ links
    def route(self, *parts) -> str:
        return "#/p/" + "/".join([self.book.pid, self.book.branch] + [str(p) for p in parts])

    def new_edit(self, key: str) -> dict:
        b = self.book
        return {"route": self.route("binder"), "field": key, "target": self.target or "book",
                "api": f"PUT /api/projects/{b.pid}/branches/{b.branch}/binder/fields"}

    # ------------------------------------------------------------------ dossier helpers
    def dossier_field(self, kind: str, key: str):
        d = self.subject.get("dossier") if kind != "forge" else self.subject.get("dossier")
        if not d:
            return None
        for s in d.get("sections") or []:
            for f in s.get("fields") or []:
                if f["key"] == key:
                    return f
        return None


def _status_of_dossier(f: dict) -> str:
    return f.get("status") if f.get("status") in ("supplied", "proposed", "approved") else "supplied"


def resolve(spec, page: Page, row: dict | None = None) -> dict:
    """The field for a spec (a tuple: the first one with a value wins)."""
    specs = spec if isinstance(spec, tuple) else (spec,)
    for s in specs:
        if s is None:
            continue
        try:
            out = _resolve_one(s, page, row)
        except Exception:  # noqa: BLE001 - one odd source never breaks the page
            log.exception("binder: source %s failed", s)
            out = None
        if out is not None:
            return out
    first = specs[0] if specs else None
    return empty_field(first)


def _resolve_one(s: str, page: Page, row: dict | None):
    b = page.book
    kind, _, key = s.partition(":")
    if kind == "const":
        return {"value": key, "status": "auto", "source": "const"}
    if kind == "row":
        v = (row or {}).get(key)
        if isinstance(v, dict) and "value" in v:
            return v if v.get("value") not in ("", None) else None
        return _f(v, (row or {}).get("_status", "auto"), f"row:{key}")
    if kind == "profile":
        return _f(b.prof.get(key), "supplied", s, {"route": page.route("book"), "field": s, "dialog": "profile"})
    if kind == "cover":
        return _f((b.cover.get("texts") or {}).get(key), "supplied", s, {"route": page.route("cover"), "field": key})
    if kind == "choices":
        v = b.choices.get(key)
        if not v:
            return None
        label = _choice_label(key, v)
        return _f(label, "supplied", s, {"route": page.route("book"), "field": f"choices.{key}", "dialog": "profile"})
    if kind == "plan":
        return _plan_field(b, page, key, s)
    if kind == "new":
        return _new_field(page, key, s)
    if kind == "forge":
        f = page.dossier_field("forge", key)
        if not f or not f.get("text"):
            return None
        d = page.subject.get("dossier") or {}
        draft = f.get("source") == "canon" and not d.get("approved_character")
        return _f(f["text"], _status_of_dossier(f), s, {"route": page.route("forge", page.entry_id), "field": key},
                  draft=draft)
    if kind in ("place", "magic", "item"):
        f = page.dossier_field(kind, key)
        if not f or not f.get("text"):
            return None
        seg = {"place": "places", "magic": "magic", "item": "items"}[kind]
        d = page.subject.get("dossier") or {}
        return _f(f["text"], _status_of_dossier(f), s, {"route": page.route("forge", seg, d.get("record_id")),
                                                       "field": key})
    if kind == "canon":
        rec = page.subject.get("canon")
        if not rec:
            return None
        data = rec.get("data") or {}
        v = data.get("concept") if key == "concept" else (data.get("attributes") or {}).get(key)
        approved = bool(page.subject.get("approved"))
        return _f(v, "approved" if approved else "supplied", f"canon:{rec.get('module_id')}.{key}",
                  {"route": page.route("rec", rec["record_id"]), "field": key}, draft=not approved)
    if kind == "pic":
        return _pic_field(page, key, s)
    if kind == "auto":
        fn = AUTO.get(key)
        if fn is None:
            raise KeyError(key)
        v = fn(page)
        if isinstance(v, dict):
            return v if v.get("value") not in ("", None) else None
        return _f(v, "auto", s)
    raise KeyError(s)


def _choice_label(key: str, v: str) -> str:
    from . import story_choices  # noqa: PLC0415
    for k, _label, _h, opts in story_choices.CHOICES:
        if k == key:
            for val, lbl, desc in opts:
                if val == v:
                    return f"{lbl} — {desc}"
    return v


def _plan_field(b: Book, page: Page, key: str, s: str):
    if key in ("premise", "dramatic_question", "concept_summary"):
        p = b.plan.get("premise")
        v = ((p or {}).get("data") or {}).get(key)
    elif key == "main_plot":
        p = b.plan.get("main_plot")
        v = (((p or {}).get("data") or {}).get("main_plot") or {}).get("summary")
    else:
        return None
    if not p:
        return None
    return _f(v, "approved" if p["approved"] else "proposed", f"plan:{key}",
              {"route": page.route("rec", p["record_id"]), "field": key}, draft=not p["approved"])


def _new_field(page: Page, key: str, s: str):
    vals = page.book.new_values(page.target or "book")
    st = vals.get(key)
    if not st or st.get("value") in (None, "", []):
        return None
    v = st["value"]
    status = st.get("status") if st.get("status") in ("supplied", "proposed", "approved") else "supplied"
    return _f(v if not isinstance(v, list) else " · ".join(v), status, s, page.new_edit(key), new=bool(st.get("new")),
              protected=bool(st.get("protected")), basis=st.get("basis"))


def _pic(page: Page, fid_key: str, a: dict | None, alt: str, **extra) -> dict | None:
    url = _asset_url(page.book.pid, page.book.branch, a)
    if not url:
        return None
    out = {"url": url, "alt": alt, "mime": a.get("mime")}
    out.update({k: v for k, v in extra.items() if v})
    return out


def _pic_field(page: Page, key: str, s: str):
    """Pictures: put into page.pics under the field id being resolved (page.extra['fid'])."""
    b, fid = page.book, page.extra.get("fid")
    subj = page.subject
    pic = None
    name = page.title
    d = subj.get("dossier") or {}
    art = d.get("art") or {}
    if key == "cover_art":
        a = b.cover.get("art") if b.cover.get("use_art", True) else None
        pic = _pic(page, key, a, f"Cover art of {b.title}")
    elif key in ("portrait", "establishing", "sigil") and art:
        a = art.get(key)
        pic = {"url": a["url"], "alt": f"{name} — {key}", "mime": a.get("mime")} if a else None
    elif key == "sheet" and art.get("sheet"):
        pic = {"url": art["sheet"]["url"], "alt": f"{name} — turnaround sheet", "mime": art["sheet"].get("mime")}
    elif key in ("front", "side", "back", "detail", "day", "night", "interior", "in_use"):
        a = (art.get("views") or {}).get(key)
        pic = {"url": a["url"], "alt": f"{name} — {key.replace('_', ' ')}", "mime": a.get("mime")} if a else None
    elif key == "extra_views":
        views = art.get("views") or {}
        items = [{"url": views[v]["url"], "alt": f"{name} — {v.replace('_', ' ')}", "mime": views[v].get("mime")}
                 for v in ("three_quarter_front", "three_quarter_back", "idle", "draw", "attack", "dash", "defend")
                 if views.get(v)][:6]
        pic = dict(items[0], items=items) if items else None
    elif key == "clip":
        c = art.get("clip")
        if c and (c.get("poster") or {}).get("url"):
            pic = {"url": c["poster"]["url"], "alt": f"{name} — motion clip", "mime": c["poster"].get("mime"),
                   "video": c["url"], "video_mime": c.get("mime")}
    elif key == "chapter":
        cid = subj.get("chapter_id")
        cands = []
        for p in (b.pictures.get("pictures") or {}).values():
            if p.get("kind") == "chapter" and p.get("chapter_id") == cid and p.get("chosen") is not None:
                cs = p.get("candidates") or []
                if p["chosen"] < len(cs):
                    cands.append((p.get("scene") or 0, cs[p["chosen"]], p.get("alt") or p.get("caption")))
        if cands:
            cands.sort(key=lambda x: x[0])
            pic = _pic(page, key, cands[0][1], cands[0][2] or f"Chapter {subj.get('number')}")
    elif key in ("map", "map_crop"):
        mp = next((p for p in (b.pictures.get("pictures") or {}).values() if p.get("kind") == "map"
                   and p.get("chosen") is not None), None)
        if mp and mp["chosen"] < len(mp.get("candidates") or []):
            c = mp["candidates"][mp["chosen"]]
            png = _asset_url(b.pid, b.branch, c.get("png")) if isinstance(c.get("png"), dict) else None
            on_map = key == "map" or any(n.get("label", "").lower() == (subj.get("name") or "").lower()
                                         for n in (b.map_graph or {}).get("nodes") or [])
            if on_map:
                pic = _pic(page, key, c, mp.get("alt") or f"Map of {b.title}", png_url=png)
    if not pic:
        return None
    page.pics[fid] = pic
    route = page.route("pictures") if key in ("chapter", "map", "map_crop") else page.route("cover") \
        if key == "cover_art" else page.route("forge", *([] if page.template == "5" else [
            {"7": "places", "8A": "magic", "8B": "items"}.get(page.template, "")]), d.get("record_id") or "")
    return {"value": pic["url"], "status": "supplied", "source": s, "edit": {"route": route, "field": key}}


# ====================================================================== auto fields
def _chapters_text(nums: list[int]) -> str:
    return ", ".join(f"Ch {n}" for n in nums)


def _rows_status(page):
    return "auto"


def a_name(page: Page):
    return page.subject.get("name") or page.title


def a_code(page: Page):
    return page.subject.get("code") or ""


def a_code_revision(page: Page):
    d = page.subject.get("dossier") or {}
    return f"{d.get('code') or ''} · rev {max(1, int(d.get('revision') or 0))}" if d.get("code") else ""


def a_name_aliases(page: Page):
    s = page.subject
    al = [a for a in s.get("aliases") or [] if a]
    return s.get("name", "") + (f" ({', '.join(al)})" if al else "")


def a_sheet_role(page: Page):
    r = page.book.role_of(page.subject["char"]) if page.subject.get("char") else ""
    return {"main": "Main character", "side": "Supporting character", "minor": "Minor character"}.get(r, "")


def a_tagline(page: Page):
    d = page.subject.get("dossier") or {}
    return _f(d.get("tagline"), "supplied", "forge:tagline", {"route": page.route("forge", page.entry_id),
                                                               "field": "tagline"})


def a_summary_line(page: Page):
    d = page.subject.get("dossier") or {}
    return (d.get("summary") or [""])[0]


def a_canon_age(page: Page):
    c = page.subject.get("char") or {}
    v = page.book.canon_ages.get(c.get("name"))
    if isinstance(v, dict):
        v = v.get("age")
    if isinstance(v, list):
        v = v[0] if v else None
    return str(v) if v else ""


def _sample(page: Page, i: int):
    f = page.dossier_field("forge", "samples")
    if not f or not f.get("text"):
        return None
    lines = [x.strip() for x in f["text"].split("\n") if x.strip()]
    if len(lines) <= i:
        return None
    return _f(lines[i], _status_of_dossier(f), "forge:samples", {"route": page.route("forge", page.entry_id),
                                                                  "field": "samples"})


def a_fighting_style(page: Page):
    a = page.dossier_field("forge", "primary_style")
    b = page.dossier_field("forge", "secondary_style")
    parts = [x for x in ((a or {}).get("text"), (b or {}).get("text")) if x]
    if not parts:
        return None
    st = "proposed" if any((x or {}).get("status") == "proposed" for x in (a, b) if x and x.get("text")) else \
        _status_of_dossier(a if a and a.get("text") else b)
    return _f(" / ".join(parts), st, "forge:primary_style+secondary_style",
              {"route": page.route("forge", page.entry_id), "field": "primary_style"})


def a_backup_ranged(page: Page):
    a = page.dossier_field("forge", "backup_weapon")
    b = page.dossier_field("forge", "ranged_option")
    parts = [x for x in ((a or {}).get("text"), (b or {}).get("text")) if x]
    if not parts:
        return None
    st = "proposed" if any((x or {}).get("status") == "proposed" for x in (a, b) if x and x.get("text")) else \
        _status_of_dossier(a if a and a.get("text") else b)
    return _f(" / ".join(parts), st, "forge:backup_weapon+ranged_option",
              {"route": page.route("forge", page.entry_id), "field": "backup_weapon"})


def a_first_appearance(page: Page):
    nums = page.extra.get("chapters_in")
    if nums is None:
        nums = _chapters_of_subject(page)
    return f"Chapter {nums[0]}" if nums else ""


def _chapters_of_subject(page: Page) -> list[int]:
    b, s = page.book, page.subject
    if page.template == "5" and s.get("char"):
        nums = sorted(set(b.presence.get(s["char"]["record_id"]) or []))
    elif page.template == "7":
        ids = {str(s.get("subject_id") or "").lower(), s.get("id", "").lower()}
        nums = sorted({ch["number"] for ch in b.chapters if str((ch["plan"] or {}).get("location_id") or "").lower()
                       in ids} | set(b.mentions([s.get("name", "")] + list(s.get("aliases") or []))))
    else:
        nums = b.mentions([s.get("name", "")] + list(s.get("aliases") or []))
    page.extra["chapters_in"] = nums
    return nums


def a_chapters_in(page: Page):
    return _chapters_text(_chapters_of_subject(page))


def a_linked_records(page: Page):
    d = page.subject.get("dossier") or {}
    out = []
    for lk in (d.get("links") or []) + (d.get("backlinks") or []):
        label = f"{lk.get('code') or ''} {lk.get('name') or ''}".strip()
        if label and label not in out:
            out.append(label)
    rec = page.subject.get("canon") or page.subject.get("rec")
    if rec:
        for r in (rec.get("data") or {}).get("linked_refs") or []:
            if isinstance(r, dict) and r.get("record_id"):
                n = _name_of_record(page.book, r["record_id"])
                if n and n not in out:
                    out.append(n)
    return " · ".join(out[:20])


def _name_of_record(b: Book, rid: str) -> str:
    for c in b.chars:
        if c["record_id"] == rid:
            return c["name"]
    for coll in (b.places, b.magic, b.items):
        for e in coll:
            if (e.get("canon") or {}).get("record_id") == rid:
                return f"{e.get('code') or ''} {e['name']}".strip()
    for o in b.others:
        if o["id"] == rid:
            return o["name"]
    return ""


def a_scenes_here(page: Page):
    b, s = page.book, page.subject
    names = [n.lower() for n in [s.get("name", "")] + list(s.get("aliases") or []) if n]
    ids = {str(s.get("subject_id") or "").lower(), s.get("id", "").lower()}
    out = []
    for ch in b.chapters:
        here = str((ch["plan"] or {}).get("location_id") or "").lower() in ids
        for i, card in enumerate(ch["cards"]):
            if any(n and n in str(card.get("place") or "").lower() for n in names):
                out.append(f"Ch {ch['number']} scene {i + 1}")
                here = False
        if here:
            out.append(f"Ch {ch['number']}")
    return " · ".join(out)


def a_characters_here(page: Page):
    b, s = page.book, page.subject
    nums = set(_chapters_of_subject(page))
    names = [c["name"] for c in b.chars if nums & set(b.presence.get(c["record_id"]) or [])]
    return ", ".join(names[:12])


# ---- book level
def a_series_line(page: Page):
    b = page.book
    vals = b.new_values("book")
    s = (vals.get("series") or {}).get("value")
    n = (vals.get("series_number") or {}).get("value")
    if not s:
        return None
    st = "proposed" if "proposed" in ((vals.get("series") or {}).get("status"),
                                      (vals.get("series_number") or {}).get("status")) else "supplied"
    return _f(f"{s}" + (f", book {n}" if n else ""), st, "new:series+series_number", page.new_edit("series"), new=True)


def a_art_credit(page: Page):
    a = page.book.cover.get("art") or {}
    if not a.get("asset_id") or not page.book.cover.get("use_art", True):
        return "No cover art yet — a styled title page in the look's colours"
    src = a.get("source") or a.get("engine") or ""
    return {"upload": "Your upload", "sd": "Stable Diffusion (AutoInjector)", "chatgpt": "ChatGPT (AutoInjector)",
            "example": "Example art"}.get(src, f"Made with {src}" if src else "Your picture")


def a_length_label(page: Page):
    from .lengths import PRESETS  # noqa: PLC0415
    k = page.book.prof.get("length")
    return (PRESETS.get(k) or {}).get("label") or k or ""


def a_chapter_count(page: Page):
    n = len(page.book.chapters) or page.book.prof.get("chapters") or 0
    return f"{n} chapter{'s' if n != 1 else ''}" if n else ""


def a_started(page: Page):
    return str(page.book.project.get("created_at") or "")[:10]


def a_idea_first_sentence(page: Page):
    return _first_sentence(page.book.prof.get("idea") or "")


def a_pov(page: Page):
    if page.template == "11":
        c = page.book.char_by_id((page.subject.get("plan") or {}).get("pov_id"))
        if not c:
            return ""
        d = page.book.dossiers.get(c["record_id"]) or {}
        pt = ((d.get("art") or {}).get("portrait") or {})
        if pt.get("url"):
            page.pics[page.extra["fid"]] = {"url": pt["url"], "alt": c["name"], "mime": pt.get("mime")}
        return _f(c["name"], "auto", "auto:pov", {"route": page.route("forge", c["record_id"]), "field": "name"},
                  link=f"character-{slug(c['record_id'])}")
    st = page.book.style
    if not st.get("person"):
        return ""
    povs = [c["name"] for c in page.book.chars if page.book.pov_counts.get(c["record_id"])]
    return f"{st['person'].capitalize()} person" + (f" — {', '.join(povs[:4])}" if povs else "")


def a_tense(page: Page):
    t = page.book.style.get("tense")
    return f"{t.capitalize()} tense" if t else ""


def a_length_and_target(page: Page):
    ln = page.book.length
    label = a_length_label(page)
    if not label and not ln:
        return ""
    return f"{label}" + (f" — about {ln['book_words']:,} words" if ln.get("book_words") else "")


def a_chapters_planned_written(page: Page):
    chs = page.book.chapters
    if not chs:
        n = page.book.prof.get("chapters")
        return f"{n} planned · 0 written" if n else ""
    return f"{len(chs)} planned · {sum(1 for c in chs if c['written'])} written · " \
           f"{sum(1 for c in chs if c['approved'])} approved"


def a_reading_level(page: Page):
    rep = page.book.readability or {}
    t = rep.get("totals") or {}
    aud = rep.get("audience") or {}
    if not t.get("grade") and not aud.get("label"):
        return ""
    return (f"Grade {t['grade']:g}" if t.get("grade") is not None else "Not measured yet") + \
        (f" (for {aud.get('label')})" if aud.get("label") else "")


def a_ending_matrix(page: Page):
    from . import story_choices  # noqa: PLC0415
    ch = page.book.choices
    if not ch.get("ending") and not ch.get("matrix"):
        return ""
    m = story_choices.matrix(ch)
    labels = {r: lbl for r, lbl, _h, _v in story_choices.MATRIX}
    return "; ".join(f"{labels.get(k, k)}: {v}" for k, v in m.items())


def a_style_choices(page: Page):
    ch = page.book.choices
    keys = ("dialogue", "pace", "humor", "darkness", "explain")
    parts = [_choice_label(k, ch[k]).split(" — ")[0] + f" {k}" for k in keys if ch.get(k)]
    return ", ".join(parts)


def _theme(i: int):
    def fn(page: Page):
        vals = page.book.new_values("book").get("themes") or {}
        v = vals.get("value") or []
        if len(v) <= i:
            return None
        return _f(v[i], vals.get("status") or "supplied", "new:themes", page.new_edit("themes"), new=True)
    return fn


def a_themes(page: Page):
    vals = page.book.new_values("book").get("themes") or {}
    v = vals.get("value") or []
    return _f(" · ".join(v), vals.get("status") or "supplied", "new:themes", page.new_edit("themes"), new=True) \
        if v else None


def a_key_places(page: Page):
    b = page.book
    tiles = []
    for p in b.places[:4]:
        hero = ((p.get("dossier") or {}).get("art") or {}).get("establishing")
        tiles.append({"url": hero["url"], "alt": p["name"], "mime": hero.get("mime")} if hero else None)
    items = [t for t in tiles if t]
    if items:
        page.pics[page.extra["fid"]] = dict(items[0], items=items)
    return ", ".join(p["name"] for p in b.places[:4])


def a_cast_groups(page: Page):
    b = page.book
    groups = [("main", "Main"), ("side", "Supporting"), ("minor", "Minor")]
    return " · ".join(f"{label} ({sum(1 for c in b.chars if b.role_of(c) == k)})" for k, label in groups
                      if any(b.role_of(c) == k for c in b.chars))


def a_cast_count(page: Page):
    n = len(page.book.chars)
    return f"{n} character{'s' if n != 1 else ''}" if n else ""


# ---- relationships
REL_COLOURS = {"family": "#2e7d32", "love": "#c2185b", "ally": "#1565c0", "rival": "#ef6c00", "enemy": "#b71c1c",
               "mentor": "#6a1b9a", "other": "#757575"}


def _graph(b: Book) -> dict:
    """The relationship graph: nodes (characters) and lines (each typed relationship row, merged both ways)."""
    nodes, edges = [], {}
    centre = b.protagonist
    for c in b.chars:
        d = b.dossiers.get(c["record_id"]) or {}
        pt = ((d.get("art") or {}).get("portrait") or {})
        nodes.append({"id": c["record_id"], "name": c["name"], "page_id": f"character-{slug(c['record_id'])}",
                      "portrait": pt.get("url"), "role": b.role_of(c)})
        for row in _rel_rows_of(b, c):
            other = b.char_by_name(row["name"])
            if not other or other["record_id"] == c["record_id"]:
                continue
            k = tuple(sorted((c["record_id"], other["record_id"])))
            e = edges.setdefault(k, {"from": k[0], "to": k[1], "type": None, "note": "", "status": "auto"})
            if row["type"] and not e["type"]:
                e["type"], e["status"] = row["type"], row["type_status"]
            if row["note"] and not e["note"]:
                e["note"] = row["note"]
    edge_list = list(edges.values())
    for e in edge_list:
        e["colour"] = REL_COLOURS.get(e["type"] or "other")
    ring = {centre["record_id"]: 0} if centre else {}
    frontier = list(ring)
    while frontier:
        nxt = []
        for n in frontier:
            for e in edge_list:
                for a, z in ((e["from"], e["to"]), (e["to"], e["from"])):
                    if a == n and z not in ring:
                        ring[z] = ring[n] + 1
                        nxt.append(z)
        frontier = nxt
    far = max(ring.values(), default=0) + 1
    for nd in nodes:
        nd["ring"] = ring.get(nd["id"], far)
    return {"centre": centre["record_id"] if centre else None, "nodes": nodes, "edges": edge_list,
            "colours": REL_COLOURS}


def _rel_rows_of(b: Book, c: dict) -> list[dict]:
    d = b.dossiers.get(c["record_id"]) or {}
    out = []
    for s in d.get("sections") or []:
        if s.get("key") != "relationships":
            continue
        for f in s.get("fields") or []:
            if not f["key"].startswith("relationship_") or not f.get("text"):
                continue
            name = (f.get("title") or "").split("/")[0].strip()
            if not name:
                continue
            target = bf.rel_target(c["record_id"], name)
            tv = b.new_values(target).get("type") or {}
            out.append({"key": f["key"], "name": name, "title": f.get("title") or name, "note": _first_sentence(
                f["text"]), "text": f["text"], "status": _status_of_dossier(f), "type": tv.get("value"),
                "type_status": tv.get("status") or "supplied", "target": target})
    return out


def _legend(t: str):
    def fn(page: Page):
        g = page.extra.get("graph") or {}
        n = sum(1 for e in g.get("edges") or [] if e.get("type") == t)
        label = {"family": "Family", "love": "Love", "ally": "Allies", "rival": "Rivals", "enemy": "Enemies",
                 "mentor": "Mentor / student"}[t]
        return _f(f"{label} ({n})", "auto", f"auto:legend_{t}", colour=REL_COLOURS[t])
    return fn


def a_bubbles(page: Page):
    g = page.extra.get("graph") or {}
    return ", ".join(n["name"] for n in g.get("nodes") or [])


def a_lines(page: Page):
    g = page.extra.get("graph") or {}
    n = len(g.get("edges") or [])
    return f"{n} line{'s' if n != 1 else ''}" if n else ""


def a_centre(page: Page):
    c = page.book.protagonist
    return c["name"] if c else ""


def a_closeness(page: Page):
    g = page.extra.get("graph") or {}
    rings: dict = {}
    for n in g.get("nodes") or []:
        rings.setdefault(n["ring"], []).append(n["name"])
    return " · ".join(f"ring {r}: {', '.join(v)}" for r, v in sorted(rings.items()) if r)


# ---- world entries (8C)
_8C_ATTRS = {  # auto field -> the canon attributes that answer it, per module (the first one with text wins)
    "founded": ("origin", "history", "founding"),
    "reach": ("membership", "environment", "scope", "population"),
    "leaders": ("hierarchy", "institutions", "leadership", "government", "rulers"),
    "base": ("location", "territory", "headquarters"),
    "tenets": ("doctrines", "physical_rules", "laws", "rules", "values", "sacred_concepts", "norms"),
    "forbidden": ("global_constraints", "taboos", "prohibitions", "restrictions"),
    "views_of_others": ("attitudes", "relations", "rivalries"),
    "members": ("membership", "members", "population"),
}


def _attr_any(page: Page, keys) -> str:
    rec = page.subject.get("rec") or {}
    attrs = (rec.get("data") or {}).get("attributes") or {}
    for k in keys:
        if _clip(attrs.get(k)):
            return _clip(attrs.get(k))
    facts = (rec.get("data") or {}).get("facts") or []
    for f in facts:
        if isinstance(f, dict) and any(k in str(f.get("predicate") or "") for k in keys) and f.get("value"):
            return _clip(f["value"])
    return ""


def _8c(name):
    def fn(page: Page):
        v = _attr_any(page, _8C_ATTRS[name])
        if not v:
            return None
        approved = bool(page.subject.get("approved"))
        rec = page.subject.get("rec") or {}
        return _f(v, "approved" if approved else "supplied", f"canon:{rec.get('module_id')}",
                  {"route": page.route("rec", rec.get("record_id")), "field": name}, draft=not approved)
    return fn


def a_world_kind(page: Page):
    op = page.subject.get("op") or ""
    word = {"A03": "world", "A08": "belief", "A06": "group", "A05": "organisation", "A07": "culture",
            "A02": "people / species", "A10": "technology", "A11": "weapons & fighting"}.get(op)
    return f"{word} — {page.subject.get('kind')}" if word else page.subject.get("kind") or ""


def a_full_description(page: Page):
    rec = page.subject.get("rec") or {}
    attrs = (rec.get("data") or {}).get("attributes") or {}
    parts = [f"{k.replace('_', ' ').capitalize()}: {_clip(v)}" for k, v in attrs.items() if _clip(v)]
    if not parts:
        return None
    approved = bool(page.subject.get("approved"))
    return _f("\n".join(parts), "approved" if approved else "supplied", f"canon:{rec.get('module_id')}.attributes",
              {"route": page.route("rec", rec.get("record_id")), "field": "attributes"}, draft=not approved)


def a_protected_flags(page: Page):
    rec = page.subject.get("rec") or page.subject.get("canon") or {}
    flags = [f for f in (rec.get("data") or {}).get("protected_fact_flags") or [] if isinstance(f, str)]
    return " · ".join(flags)


# ---- map
def a_markers(page: Page):
    g = page.book.map_graph or {}
    n = len(g.get("nodes") or [])
    return f"{n} numbered marker{'s' if n != 1 else ''}" if n else ""


def a_compass(page: Page):
    g = page.book.map_graph or {}
    if not g:
        return ""
    return "N ↑ (story route: no real directions)" if g.get("coordinate_system") == "story-route" else "N ↑"


def a_scale(page: Page):
    g = page.book.map_graph or {}
    unit = g.get("unit")
    return f"1 unit = 1 {unit}" if g and unit and unit not in ("world_units",) else ""


# ---- story plan
BEATS = (("opening", 0.0, "Opening"), ("inciting", 0.1, "Inciting incident"), ("first_plot_point", 0.25,
         "First plot point"), ("midpoint", 0.5, "Midpoint"), ("crisis", 0.75, "Crisis / all is lost"),
         ("climax", 0.9, "Climax"), ("resolution", 0.97, "Resolution"), ("final_image", 1.0, "Final image"))


def _beat(key: str, frac: float):
    def fn(page: Page):
        chs = page.book.chapters
        if not chs:
            return ""
        i = min(len(chs) - 1, max(0, int(round(frac * (len(chs) - 1)))))
        c = chs[i]
        return _f(f"Chapter {c['number']}: {_first_sentence(c['objective'] or c['summary'])}", "auto",
                  f"auto:beat_{key}", chapter=c["number"], link=f"chapter-{slug(c['chapter_id'])}")
    return fn


def a_motifs(page: Page):
    from . import repetition  # noqa: PLC0415
    labels = repetition.get_labels(page.book.store, page.book.pid, page.book.branch).get("labels") or {}
    motifs = [k for k, v in labels.items() if v == "motif"]
    tex = [t["detail"] for t in page.book.texture if t.get("detail")][:3]
    return " · ".join(motifs[:8] + tex)


def a_recurring_images(page: Page):
    reps = [r for r in page.book.repeats.get("repeats") or [] if r.get("class") == "motif"]
    return " · ".join(str(r.get("label") or r.get("phrase") or r.get("key") or "") for r in reps[:8])


def a_left_open(page: Page):
    o = page.book.plan.get("outline") or {}
    threads = ((o.get("data") or {}).get("unresolved_threads")) or []
    out = []
    for t in threads:
        out.append(t if isinstance(t, str) else _clip((t or {}).get("summary") or (t or {}).get("description")
                                                     or (t or {}).get("name") or ""))
    from . import story_choices  # noqa: PLC0415
    m = story_choices.matrix(page.book.choices) if page.book.choices.get("ending") else {}
    opens = [k.replace("_", " ") for k, v in m.items() if v in ("incomplete", "deferred", "ambiguous", "persistent",
                                                                "pending", "protected", "uncertain")]
    return " · ".join([x for x in out if x] + ([f"by design: {', '.join(opens)}"] if opens else []))


def a_sequel_hook(page: Page):
    c = page.book.protagonist
    if not c:
        return None
    d = page.book.dossiers.get(c["record_id"]) or {}
    page2 = Page(page.book, "5", "", "", entry_id=c["record_id"], subject={"dossier": d})
    f = page2.dossier_field("forge", "change_hook")
    if not f or not f.get("text"):
        return None
    return _f(f"{c['name']}: {f['text']}", _status_of_dossier(f), "forge:change_hook (main character)",
              {"route": page.route("forge", c["record_id"]), "field": "change_hook"})


# ---- chapter page
def a_chapter_number(page: Page):
    return f"{page.subject['number']}"


def a_chapter_title(page: Page):
    s = page.subject
    if s.get("title"):
        return _f(s["title"], "approved" if s["approved"] else "supplied", "chapter:title",
                  {"route": page.route("write", s["chapter_id"]), "field": "title"}, draft=not s["approved"])
    return _f(_first_sentence(s.get("objective") or s.get("summary") or ""), "auto", "outline:objective")


def a_chapter_status(page: Page):
    s = page.subject
    return "Approved" if s["approved"] else "Written" if s["written"] else "Planned"


def a_word_count(page: Page):
    return f"{page.subject['words']:,}" if page.subject.get("written") else "0"


def a_word_target(page: Page):
    t = page.book.length.get("target_words")
    return f"{t:,}" if t else ""


def a_main_place(page: Page):
    p = page.book.place_by_id((page.subject.get("plan") or {}).get("location_id"))
    if not p:
        cards = page.subject.get("cards") or []
        return _clip(cards[0].get("place")) if cards else ""
    hero = ((p.get("dossier") or {}).get("art") or {}).get("establishing")
    if hero:
        page.pics[page.extra["fid"]] = {"url": hero["url"], "alt": p["name"], "mime": hero.get("mime")}
    return _f(p["name"], "auto", "auto:main_place", link=f"place-{slug(p['id'])}")


def a_story_time(page: Page):
    times = [_clip(c.get("time"), 80) for c in page.subject.get("cards") or [] if c.get("time")]
    return " → ".join(dict.fromkeys(times)) if times else ""


def a_chapter_summary(page: Page):
    s = page.subject
    o = page.book.plan.get("outline") or {}
    return _f(s.get("summary") or s.get("objective"), "approved" if o.get("approved") else "proposed",
              "plan:outline.summary", {"route": page.route("rec", o.get("record_id")), "field": "summary"},
              draft=not o.get("approved"))


def a_chapter_goal(page: Page):
    s = page.subject
    o = page.book.plan.get("outline") or {}
    return _f(s.get("objective"), "approved" if o.get("approved") else "proposed", "plan:outline.objective",
              {"route": page.route("rec", o.get("record_id")), "field": "objective"}, draft=not o.get("approved"))


def a_planted_threads(page: Page):
    s = page.subject
    out = [_clip(c.get("unsaid"), 160) for c in s.get("cards") or [] if c.get("unsaid")]
    return " · ".join(dict.fromkeys(out))


def a_readability(page: Page):
    rows = (page.book.readability or {}).get("chapters") or []
    r = next((x for x in rows if x.get("chapter_id") == page.subject["chapter_id"]), None)
    if not r or r.get("grade") is None:
        return ""
    return f"Grade {r['grade']:g} · ease {r['ease']:g} · {r.get('pace') or ''} pace".strip(" ·")


def a_editor_score(page: Page):
    from .book_report import latest_read  # noqa: PLC0415
    s = page.subject
    if not s.get("record_id"):
        return ""
    cr, _at = latest_read(page.book.crafts, s["record_id"], s["version"])
    if not isinstance(cr, dict):
        return "Not read by the editor yet"
    sc = [v for v in (cr.get("scores") or {}).values() if isinstance(v, (int, float))]
    return (f"{round(sum(sc) / len(sc), 1):g} / 10" if sc else "") + (f" · {cr.get('verdict')}" if cr.get("verdict")
                                                                       else "")


def a_repeats(page: Page):
    from . import repetition  # noqa: PLC0415
    if not page.subject.get("text"):
        return ""
    rep = repetition.for_chapter(page.book.repeats, page.subject["chapter_id"])
    n = (rep.get("counts") or {}).get("trim", 0)
    return f"{n} repeat{'s' if n != 1 else ''} to trim" if n else "None to trim"


def _chapter_warnings(b: Book, cid: str) -> list[str]:
    out = []
    for f in b.timeline.get("findings") or []:
        if any(p.get("chapter") == cid for p in f.get("passages") or []):
            out.append(f.get("label") or f.get("check") or "timeline")
    for part in ("physical", "characters"):
        found = b.continuity_lint.get(part)
        found = (found.get("findings") or []) if isinstance(found, dict) else (found or [])
        for f in found:
            if isinstance(f, dict) and (f.get("chapter_id") == cid or cid in (f.get("chapters") or [])):
                out.append(_clip(f.get("message") or f.get("label") or f.get("code") or part, 160))
    return out


def a_continuity(page: Page):
    if not page.subject.get("text"):
        return ""
    w = _chapter_warnings(page.book, page.subject["chapter_id"])
    return f"{len(w)} warning(s): " + "; ".join(dict.fromkeys(w)) if w else "No warnings"


# ---- rules & facts
def _rules(cat: str):
    def fn(page: Page):
        rs = [r for r in page.book.rules if r.get("category") == cat]
        if not rs:
            return None
        txt = "\n".join(r["text"] + (f" — limits: {r['scope']}" if r.get("scope") else "") for r in rs)
        return _f(txt, "supplied", f"story_rules:{cat}", {"route": page.route("world"), "field": cat})
    return fn


def a_narrative_voice(page: Page):
    from . import style_card  # noqa: PLC0415
    st = page.book.style
    if st.get("words"):
        return " ".join(style_card.describe(st)[:2])
    try:
        card = style_card.brief_for(page.book.store, page.book.pid)
    except Exception:  # noqa: BLE001
        card = None
    return _clip((card or {}).get("summary") or "", 400) if card else ""


def a_pov_rules(page: Page):
    b = page.book
    povs = [c["name"] for c in b.chars if b.pov_counts.get(c["record_id"])]
    person = b.style.get("person")
    if not povs and not person:
        return ""
    return (f"{person.capitalize()} person" if person else "") + \
        (f"; point-of-view characters: {', '.join(povs)}" if povs else "")


_UK = re.compile(r"\b(colour|favour|honour|neighbour|grey|realise|organise|centre|theatre|travelled|harbour)\w*\b", re.I)
_US = re.compile(r"\b(color|favor|honor|neighbor|gray|realize|organize|center|theater|traveled|harbor)\w*\b", re.I)


def a_spelling(page: Page):
    blob = "\n".join(t for _c, t in page.book.texts)
    if not blob:
        return ""
    uk, us = len(_UK.findall(blob)), len(_US.findall(blob))
    if not uk and not us:
        return ""
    return f"{'UK' if uk >= us else 'US'} spelling (by the text: {uk} UK / {us} US words)"


def a_words_to_avoid(page: Page):
    out = [t["term"] for t in page.book.terms if t.get("status") == "wrong"]
    try:
        es = page.book.store.get_setting("editor_settings") or {}
        out += [w for w in es.get("watch_words") or [] if isinstance(w, str)]
    except Exception:  # noqa: BLE001
        pass
    return ", ".join(dict.fromkeys(out))


# ---- cover status (filled after every other page)
def a_late(name: str):
    def fn(page: Page):
        return page.book.__dict__.get("_late", {}).get(name, "")
    return fn


def a_combinations_rituals(page: Page):
    a = page.dossier_field("magic", "combinations")
    b = page.dossier_field("magic", "rituals")
    parts = [x["text"] for x in (a, b) if x and x.get("text")]
    if not parts:
        return None
    st = "proposed" if any(x.get("status") == "proposed" for x in (a, b) if x and x.get("text")) else "supplied"
    return _f(" / ".join(parts), st, "magic:combinations+rituals",
              {"route": page.route("forge", "magic", (page.subject.get("dossier") or {}).get("record_id")),
               "field": "combinations"})


AUTO = {
    "name": a_name, "code": a_code, "code_revision": a_code_revision, "name_aliases": a_name_aliases,
    "sheet_role": a_sheet_role, "tagline": a_tagline, "summary_line": a_summary_line, "canon_age": a_canon_age,
    "sample_1": lambda p: _sample(p, 0), "sample_2": lambda p: _sample(p, 1), "fighting_style": a_fighting_style,
    "backup_ranged": a_backup_ranged, "first_appearance": a_first_appearance, "chapters_in": a_chapters_in,
    "linked_records": a_linked_records, "scenes_here": a_scenes_here, "characters_here": a_characters_here,
    "series_line": a_series_line, "art_credit": a_art_credit, "length_label": a_length_label,
    "chapter_count": a_chapter_count, "approved_percent": a_late("approved_percent"),
    "drafts_waiting": a_late("drafts_waiting"), "missing_pictures": a_late("missing_pictures"),
    "last_updated": a_late("last_updated"), "book_revision": a_late("book_revision"),
    "schema_version": lambda p: f"Book Bible schema {SCHEMA_VERSION}", "started": a_started,
    "idea_first_sentence": a_idea_first_sentence, "pov": a_pov, "tense": a_tense,
    "length_and_target": a_length_and_target, "chapters_planned_written": a_chapters_planned_written,
    "reading_level": a_reading_level, "ending_matrix": a_ending_matrix, "style_choices": a_style_choices,
    "theme_1": _theme(0), "theme_2": _theme(1), "theme_3": _theme(2), "themes": a_themes,
    "key_places": a_key_places, "cast_groups": a_cast_groups, "cast_count": a_cast_count,
    "bubbles": a_bubbles, "lines": a_lines, "centre": a_centre, "closeness": a_closeness,
    **{f"legend_{t}": _legend(t) for t in ("family", "love", "ally", "rival", "enemy", "mentor")},
    "world_kind": a_world_kind, "full_description": a_full_description, "protected_flags": a_protected_flags,
    **{k: _8c(k) for k in _8C_ATTRS},
    "markers": a_markers, "compass": a_compass, "scale": a_scale,
    **{f"beat_{k}": _beat(k, f) for k, f, _l in BEATS},
    "motifs": a_motifs, "recurring_images": a_recurring_images, "left_open": a_left_open, "sequel_hook": a_sequel_hook,
    "chapter_number": a_chapter_number, "chapter_title": a_chapter_title, "chapter_status": a_chapter_status,
    "word_count": a_word_count, "word_target": a_word_target, "main_place": a_main_place, "story_time": a_story_time,
    "chapter_summary": a_chapter_summary, "chapter_goal": a_chapter_goal, "planted_threads": a_planted_threads,
    "readability": a_readability, "editor_score": a_editor_score, "repeats": a_repeats, "continuity": a_continuity,
    **{f"rules_{c}": _rules(c) for c in ("hard_rule", "seen", "belief", "mystery")},
    "narrative_voice": a_narrative_voice, "pov_rules": a_pov_rules, "spelling": a_spelling,
    "words_to_avoid": a_words_to_avoid, "combinations_rituals": a_combinations_rituals,
}


# ====================================================================== rows of the repeating sections
def _row_pic(page: Page, row_index: int, fid: str, pic: dict | None) -> dict:
    if not pic or not pic.get("url"):
        return empty_field("row:portrait")
    page.pics[f"{fid}#{row_index + 1}"] = pic
    return {"value": pic["url"], "status": "supplied", "source": "pic"}


def _portrait_of(b: Book, rid: str) -> dict | None:
    pt = ((b.dossiers.get(rid) or {}).get("art") or {}).get("portrait")
    return {"url": pt["url"], "alt": "", "mime": pt.get("mime")} if pt else None


def contents_rows(page: Page) -> list[dict]:
    return [{"name": f"{r['icon']} {r['title']}", "count": r["count_text"], "page": str(r["page"] or "–"),
             "_meta": {"page_id": r.get("page_id"), "template": r["template"]}}
            for r in page.book.__dict__.get("_contents_rows", [])]


def jump_rows(page: Page) -> list[dict]:
    b = page.book
    chars = [(c["name"], _portrait_of(b, c["record_id"]), f"character-{slug(c['record_id'])}") for c in b.chars]
    places = [(p["name"], {"url": ((p.get("dossier") or {}).get("art") or {}).get("establishing", {}).get("url")}
               if ((p.get("dossier") or {}).get("art") or {}).get("establishing") else None, f"place-{slug(p['id'])}")
              for p in b.places]
    world = [(m["name"], {"url": ((m.get("dossier") or {}).get("art") or {}).get("sigil", {}).get("url")}
              if ((m.get("dossier") or {}).get("art") or {}).get("sigil") else None, f"magic-{slug(m['id'])}")
             for m in b.magic] + \
        [(i["name"], {"url": ((i.get("dossier") or {}).get("art") or {}).get("portrait", {}).get("url")}
          if ((i.get("dossier") or {}).get("art") or {}).get("portrait") else None, f"item-{slug(i['id'])}")
         for i in b.items] + [(o["name"], None, f"world-{slug(o['id'])}") for o in b.others]
    rows = []
    for i, (c, p, w) in enumerate(zip_longest(chars, places, world)):
        row = {"_meta": {}}
        for key, fid, x in (("character", "2.2.1", c), ("place", "2.2.2", p), ("world", "2.2.3", w)):
            if not x:
                row[key] = empty_field(f"row:{key}")
                continue
            if x[1] and x[1].get("url"):
                page.pics[f"{fid}#{i + 1}"] = {"url": x[1]["url"], "alt": x[0]}
            row[key] = {"value": x[0], "status": "auto", "source": f"row:{key}", "link": x[2]}
        rows.append(row)
    return rows


def todo_rows(page: Page) -> list[dict]:
    words = {"approve": "✔ Approve", "make_picture": "🎨 Make picture", "fix": "✏ Fix"}
    out = []
    for t in page.book.__dict__.get("_todo", [])[:10]:
        out.append({"what": t["what"], "where": f"page {t.get('page') or '–'}", "action": words.get(t["action"],
                                                                                                   t["action"]),
                    "_meta": {"page_id": t.get("page_id"), "action": t["action"]}})
    return out


def _main_cast(b: Book) -> list[dict]:
    mains = [c for c in b.chars if b.role_of(c) == "main"]
    rest = [c for c in b.chars if b.role_of(c) == "side"]
    return (mains + rest)[:5]


def _one_line(b: Book, c: dict) -> dict | None:
    d = b.dossiers.get(c["record_id"]) or {}
    if d.get("tagline"):
        return {"value": d["tagline"], "status": "supplied", "source": "forge:tagline"}
    for s in d.get("sections") or []:
        for f in s.get("fields") or []:
            if f["key"] in ("role", "identity") and f.get("text"):
                return {"value": _first_sentence(f["text"]), "status": _status_of_dossier(f),
                        "source": f"forge:{f['key']}"}
    return None


def _role_text(b: Book, c: dict) -> str:
    return {"main": "Main character", "side": "Supporting character", "minor": "Minor character"}[b.role_of(c)]


def main_cast_rows(page: Page) -> list[dict]:
    b = page.book
    rows = []
    for i, c in enumerate(_main_cast(b)):
        rows.append({"portrait": _row_pic(page, i, "3.6.1", _portrait_of(b, c["record_id"])), "name": c["name"],
                     "role": _role_text(b, c), "one_line": _one_line(b, c) or "",
                     "_meta": {"entry_id": c["record_id"], "page_id": f"character-{slug(c['record_id'])}"}})
    return rows


def cast_rows(page: Page) -> list[dict]:
    b = page.book
    order = {"main": 0, "side": 1, "minor": 2}
    rows = []
    chars = sorted(b.chars, key=lambda c: (order[b.role_of(c)], (b.dossiers.get(c["record_id"]) or {}).get("code")
                                           or ""))
    for i, c in enumerate(chars):
        d = b.dossiers.get(c["record_id"]) or {}
        nums = sorted(set(b.presence.get(c["record_id"]) or []))
        age = b.new_values(f"character:{c['record_id']}").get("age") or {}
        age_f = {"value": age["value"], "status": age.get("status") or "supplied", "source": "new:age", "new": True} \
            if age.get("value") else (_f(a_canon_age(Page(b, "5", "", "", subject={"char": c})), "auto",
                                          "auto:canon_age") or "")
        rows.append({"portrait": _row_pic(page, i, "4.2.1", _portrait_of(b, c["record_id"])), "name": c["name"],
                     "code": d.get("code") or "", "role": _role_text(b, c), "one_line": _one_line(b, c) or "",
                     "age": age_f, "first_chapter": f"Chapter {nums[0]}" if nums else "",
                     "status": "Approved" if c.get("approved") and d.get("readiness") == "ready" else
                     "Approved (dossier draft)" if c.get("approved") else "Draft",
                     "_meta": {"entry_id": c["record_id"], "page_id": f"character-{slug(c['record_id'])}",
                               "group": {"main": "Main", "side": "Supporting", "minor": "Minor"}[b.role_of(c)],
                               "has_portrait": bool(_portrait_of(b, c["record_id"]))}})
    return rows


def relationship_rows(page: Page) -> list[dict]:
    b = page.book
    c = page.subject.get("char")
    rows = []
    for i, r in enumerate(_rel_rows_of(b, c)[:6]):
        other = b.char_by_name(r["name"])
        edit_type = {"route": page.route("binder"), "field": "type", "target": r["target"],
                     "api": f"PUT /api/projects/{b.pid}/branches/{b.branch}/binder/fields"}
        rows.append({
            "portrait": _row_pic(page, i, "5.8.1", _portrait_of(b, other["record_id"]) if other else None),
            "name": {"value": r["title"], "status": r["status"], "source": f"forge:{r['key']}.title",
                     "link": f"character-{slug(other['record_id'])}" if other else None,
                     "edit": {"route": page.route("forge", c["record_id"]), "field": r["key"]}},
            "type": {"value": r["type"] or "", "status": r["type_status"] if r["type"] else "empty",
                     "source": "new:relationship.type", "new": True, "edit": edit_type},
            "note": {"value": r["note"], "status": r["status"], "source": f"forge:{r['key']}",
                     "edit": {"route": page.route("forge", c["record_id"]), "field": r["key"]}},
            "_meta": {"target": r["target"], "field_key": r["key"]}})
    return rows


def backstory_rows(page: Page) -> list[dict]:
    d = page.subject.get("dossier") or {}
    rows = []
    for s in d.get("sections") or []:
        if s.get("key") != "backstory":
            continue
        for f in s.get("fields") or []:
            if not f.get("text"):
                continue
            ed = {"route": page.route("forge", page.entry_id), "field": f["key"]}
            rows.append({"title": {"value": f.get("title") or f["label"], "status": _status_of_dossier(f),
                                   "source": f"forge:{f['key']}.title", "edit": ed},
                         "text": {"value": f["text"], "status": _status_of_dossier(f), "source": f"forge:{f['key']}",
                                  "edit": ed}})
    return rows


def tie_rows(page: Page) -> list[dict]:
    g = page.extra.get("graph") or {}
    names = {n["id"]: n["name"] for n in g.get("nodes") or []}
    rank = {"love": 0, "family": 1, "enemy": 2, "mentor": 3, "rival": 4, "ally": 5, None: 6, "other": 6}
    edges = sorted(g.get("edges") or [], key=lambda e: (rank.get(e.get("type"), 6), not e.get("note")))
    return [{"tie": f"{names.get(e['from'], '?')} ↔ {names.get(e['to'], '?')}"
             + (f" — {e['note']}" if e.get("note") else "") + (f" ({e['type']})" if e.get("type") else "")}
            for e in edges[:5]]


def group_rows(page: Page) -> list[dict]:
    b = page.book
    return [{"group": {"value": f"{o['name']} ({o['kind']})", "status": "auto", "source": "canon",
                       "link": f"world-{slug(o['id'])}"}}
            for o in b.others if o["op"] in ("A05", "A06", "A08", "A07")]


def power_rows(page: Page) -> list[dict]:
    d = page.subject.get("dossier") or {}
    b = page.book
    rows = []
    from .forge import split_title  # noqa: PLC0415
    for s in d.get("sections") or []:
        for f in s.get("fields") or []:
            if not f["key"].startswith("named_power_") or not f.get("text"):
                continue
            name, rest = split_title(f["text"])
            name = name or _first_sentence(f["text"])[:60]
            users = []
            for c in b.chars:
                cd = b.dossiers.get(c["record_id"]) or {}
                blob = " ".join(x.get("text") or "" for sec in cd.get("sections") or [] for x in sec.get("fields")
                                or [] if x["key"] in ("supernatural_abilities", "named_power_1", "named_power_2",
                                                      "power_source", "signature_moves"))
                if name and name.lower() in blob.lower():
                    users.append(c["name"])
            ed = {"route": page.route("forge", "magic", d.get("record_id")), "field": f["key"]}
            st = _status_of_dossier(f)
            rows.append({"name": {"value": name, "status": st, "source": f"magic:{f['key']}", "edit": ed},
                         "does": {"value": rest or f["text"], "status": st, "source": f"magic:{f['key']}", "edit": ed},
                         "users": ", ".join(users)})
    return rows


def map_key_rows(page: Page) -> list[dict]:
    b = page.book
    g = b.map_graph or {}
    pages = b.__dict__.get("_page_of", {})
    rows = []
    for i, n in enumerate(g.get("nodes") or []):
        p = b.place_by_id(n.get("id")) or b.place_by_id(n.get("label"))
        pid_ = f"place-{slug(p['id'])}" if p else None
        rows.append({"number": str(i + 1), "name": n.get("label") or "", "page": str(pages.get(pid_) or "–"),
                     "_meta": {"page_id": pid_, "x": n.get("x"), "y": n.get("y")}})
    return rows


def distance_rows(page: Page) -> list[dict]:
    g = page.book.map_graph or {}
    names = {n["id"]: n.get("label") or n["id"] for n in g.get("nodes") or []}
    rows = []
    for e in g.get("edges") or []:
        rows.append({"from_to": f"{names.get(e.get('from'), '?')} → {names.get(e.get('to'), '?')}",
                     "time": _clip(e.get("travel_time") or e.get("time") or e.get("distance") or ""),
                     "how": _clip(e.get("mode") or e.get("how") or "")})
    return rows


def arc_rows(page: Page) -> list[dict]:
    b = page.book
    rows = []
    for i, c in enumerate(_main_cast(b)[:4]):
        pg = Page(b, "5", "", c["name"], entry_id=c["record_id"], subject={"dossier": b.dossiers.get(c["record_id"])})
        pt = _portrait_of(b, c["record_id"])
        if pt:
            page.pics[f"10.3.1#{i + 1}"] = dict(pt, alt=c["name"])
        rows.append({"name": {"value": c["name"], "status": "auto", "source": "canon:name",
                              "link": f"character-{slug(c['record_id'])}"},
                     "starts": resolve(("forge:opening", "forge:wants"), pg),
                     "ends": resolve(("forge:resolution", "forge:change_hook"), pg)})
    return rows


def subplot_rows(page: Page) -> list[dict]:
    b = page.book
    items = []
    for key in ("plot_obligations", "objectives"):
        for x in ((b.plan.get("main_plot") or {}).get("data") or {}).get(key) or []:
            items.append(x)
    for x in ((b.plan.get("outline") or {}).get("data") or {}).get("unresolved_threads") or []:
        items.append(x)
    rows = []
    for x in items:
        text = x if isinstance(x, str) else _clip((x or {}).get("summary") or (x or {}).get("description")
                                                  or (x or {}).get("text") or (x or {}).get("name") or "")
        if not text:
            continue
        name = _clip((x or {}).get("name") or (x or {}).get("id") or "", 80) if isinstance(x, dict) else ""
        words = [w for w in re.findall(r"[A-Za-z]{5,}", text)][:4]
        nums = [ch["number"] for ch in b.chapters if words and sum(
            1 for w in words if w.lower() in (ch["summary"] + " " + ch["objective"]).lower()) >= 2]
        rows.append({"name": name or _first_sentence(text)[:60], "about": text, "chapters": _chapters_text(nums)})
    return rows


def scene_rows(page: Page) -> list[dict]:
    s = page.subject
    e = s.get("scene_entry") or {}
    st = "approved" if e.get("approved") else "proposed" if (e.get("made_by") or {}).get("kind") == "ai" else "supplied"
    ed = {"route": page.route("scenes", s["chapter_id"]), "field": "cards"}
    rows = []
    for i, c in enumerate(s.get("cards") or []):
        goals = "; ".join(f"{g.get('character')}: {g.get('goal')}" for g in c.get("goals") or [] if g.get("goal"))

        def fld(v, src):
            return {"value": _clip(v), "status": st if _clip(v) else "empty", "source": f"scenes:{src}", "edit": ed}
        rows.append({"number": str(i + 1), "goal": fld(goals or c.get("beat"), "goals"),
                     "conflict": fld(c.get("obstacle"), "obstacle"), "outcome": fld(c.get("change"), "change"),
                     "who": fld(", ".join(c.get("characters") or []), "characters"),
                     "where_when": fld(" · ".join(x for x in (c.get("place"), c.get("time")) if x), "place+time")})
    return rows


def here_rows(page: Page) -> list[dict]:
    b, s = page.book, page.subject
    rows = []
    for i, c in enumerate([c for c in b.chars if s["number"] in (b.presence.get(c["record_id"]) or [])]):
        pt = _portrait_of(b, c["record_id"])
        if pt:
            page.pics[f"11.5.1#{i + 1}"] = dict(pt, alt=c["name"])
        rows.append({"who": {"value": c["name"], "status": "auto", "source": "auto:present",
                             "link": f"character-{slug(c['record_id'])}"}})
    return rows


def must_rows(page: Page) -> list[dict]:
    from . import planned as planned_mod  # noqa: PLC0415
    b, s = page.book, page.subject
    if not b.outline:
        return []
    st = b.planned_store.get(f"{s.get('record_id')}:{s.get('version')}") if s.get("record_id") else None
    try:
        items = st["items"] if st else planned_mod.planned_items(b.bp, b.outline, s["chapter_id"])
        if not st and s.get("text"):
            items = planned_mod.check_text(s["text"], items)
    except Exception:  # noqa: BLE001
        return []
    words = {"on_page": "✔ on the page", "unclear": "? unclear", "missing": "⚠ missing"}
    return [{"detail": i.get("label") or i.get("text") or "",
             "on_page": words.get(i.get("status"), "planned (not written yet)" if not s.get("text") else "")}
            for i in items if i.get("required", True)]


def protected_rows(page: Page) -> list[dict]:
    b = page.book
    rows = []
    for c in b.chars:
        d = b.dossiers.get(c["record_id"]) or {}
        for s in d.get("sections") or []:
            for f in s.get("fields") or []:
                if f.get("protected") and f.get("text") and not f.get("readonly"):
                    rows.append({"fact": _clip(f["text"], 300), "about": {
                        "value": f"{c['name']} — {f['label']}", "status": "auto", "source": "forge",
                        "link": f"character-{slug(c['record_id'])}"}, "why": "Protected in the Character Forge"})
    for coll, word in ((b.places, "place"), (b.magic, "magic"), (b.items, "item")):
        for e in coll:
            for s in (e.get("dossier") or {}).get("sections") or []:
                for f in s.get("fields") or []:
                    if f.get("protected") and f.get("text"):
                        rows.append({"fact": _clip(f["text"], 300), "about": {
                            "value": f"{e['name']} — {f['label']}", "status": "auto", "source": "forge",
                            "link": f"{word}-{slug(e['id'])}"}, "why": "Protected in the Forge"})
    heads = [(c["name"], c.get("canon") or c.get("rec")) for c in b.places + b.magic + b.items] + \
        [(o["name"], o["rec"]) for o in b.others]
    for c in b.chars:
        try:
            rec = b.store.get_record(b.pid, b.branch, c["record_id"], c["version"])
        except Exception:  # noqa: BLE001
            rec = None
        heads.append((c["name"], rec))
    for name, rec in heads:
        for flag in ((rec or {}).get("data") or {}).get("protected_fact_flags") or []:
            if isinstance(flag, str):
                rows.append({"fact": flag, "about": name, "why": "A protected fact of the canon record"})
    return rows


def timeline_rows(page: Page) -> list[dict]:
    b = page.book
    nums = {c["chapter_id"]: c["number"] for c in b.chapters}
    clashes = set()
    for f in b.timeline.get("findings") or []:
        if f.get("check") in ("year_arithmetic", "time_backwards"):
            for p in f.get("passages") or []:
                clashes.add(p.get("chapter"))
    rows = []
    for y in b.timeline.get("years") or []:
        if not isinstance(y, dict):
            continue
        rows.append({"date": str(y.get("year") or y.get("value") or ""), "event": _clip(y.get("excerpt"), 200),
                     "chapter": f"Ch {nums.get(y.get('chapter'), '?')}",
                     "clash": "⚠ clash" if y.get("chapter") in clashes else ""})
    for c in b.chars:  # the characters' dated backstory (titles like "2157-2166 / foundations")
        d = b.dossiers.get(c["record_id"]) or {}
        for s in d.get("sections") or []:
            if s.get("key") != "backstory":
                continue
            for f in s.get("fields") or []:
                if f.get("text") and re.match(r"^\s*\d{3,4}", f.get("title") or ""):
                    rows.append({"date": (f.get("title") or "").split("/")[0].strip(),
                                 "event": f"{c['name']}: {_first_sentence(f['text'])}", "chapter": "backstory",
                                 "clash": ""})
    return rows[:40]


def term_rows(page: Page) -> list[dict]:
    from . import terms as terms_mod  # noqa: PLC0415
    kinds = dict(terms_mod.KINDS)
    return [{"term": t["term"], "meaning": t.get("note") or t.get("use_instead") or t.get("question") or "",
             "type": kinds.get(t.get("kind"), t.get("kind") or ""),
             "checked": "✔ checked" if t.get("status") == "verified" else "✖ wrong — do not use"
             if t.get("status") == "wrong" else "🔎 research needed"} for t in page.book.terms]


def texture_rows(page: Page) -> list[dict]:
    from . import texture as texture_mod  # noqa: PLC0415
    b = page.book
    try:
        usage = texture_mod.book_usage(b.texture, b.texts) if b.texts else {}
    except Exception:  # noqa: BLE001
        usage = {}
    rows = []
    for t in b.texture:
        u = usage.get(t.get("id")) if isinstance(usage, dict) else None
        where = ""
        if isinstance(u, dict):
            chs = u.get("chapters") or []
            nums = {c["chapter_id"]: c["number"] for c in b.chapters}
            where = _chapters_text([nums.get(c, c) if not isinstance(c, dict) else nums.get(c.get("chapter_id"), "?")
                                    for c in chs]) if chs else f"{u.get('count', 0)} use(s)"
        rows.append({"detail": t.get("detail") or "", "where": where or (t.get("effect") or "")})
    return rows


def repeat_rows(page: Page) -> list[dict]:
    from . import repetition  # noqa: PLC0415
    rows = []
    for r in page.book.repeats.get("repeats") or []:
        if r.get("class") not in ("accident", "voice", "motif", "filler"):
            continue
        kind = "character catchphrase — protected" if r["class"] == "voice" else \
            "motif — protected" if r["class"] == "motif" else "accidental repeat" if r["class"] == "accident" else \
            "filler"
        rows.append({"phrase": r.get("label") or r.get("phrase") or r.get("key") or "", "kind": kind})
    return rows[:20]


ROW_FUNCS = {name: globals()[name] for name in set(ROWS.values())}


# ====================================================================== fill one page
def _page_status(sections: dict, draft: bool) -> str:
    for sec in sections.values():
        for f in sec["fields"].values():
            if f.get("status") == "proposed":
                return "needs_you"
        for row in sec.get("rows") or []:
            for k, f in row.items():
                if not k.startswith("_") and isinstance(f, dict) and f.get("status") == "proposed":
                    return "needs_you"
    return "draft" if draft else "approved"


def fill(page: Page) -> dict:
    tpl = schema()[page.template]
    sections = {}
    for sec in tpl["sections"]:
        code = sec["code"]
        fields = {}
        if code in ROWS:
            try:
                raw_rows = ROW_FUNCS[ROWS[code]](page)
            except Exception:  # noqa: BLE001
                log.exception("binder: rows of %s failed", code)
                raw_rows = []
            rows = []
            for i, rr in enumerate(raw_rows):
                row = {}
                for fd in sec["fields"]:
                    page.extra["fid"] = f"{fd['id']}#{i + 1}"
                    f = resolve(MAP[fd["id"]], page, rr)
                    if fd["id"] in NEW_IDS:
                        f["new"] = True
                    row[fd["id"]] = f
                if rr.get("_meta"):
                    row["_meta"] = rr["_meta"]
                rows.append(row)
            for fd in sec["fields"]:
                fields[fd["id"]] = dict(empty_field(f"rows:{code}") if not rows else
                                        {"value": "", "status": "auto", "source": f"rows:{code}"},
                                        repeat=True, rows=len(rows), **({"new": True} if fd["id"] in NEW_IDS else {}))
            sections[code] = {"fields": fields, "rows": rows}
            continue
        for fd in sec["fields"]:
            page.extra["fid"] = fd["id"]
            spec = MAP[fd["id"]]
            f = resolve(spec, page) if spec is not None else dict(empty_field("none"),
                                                                  unavailable=UNAVAILABLE[fd["id"]])
            if fd["id"] in NEW_IDS:
                f["new"] = True
            fields[fd["id"]] = f
        sections[code] = {"fields": fields}
    out = {"template": page.template, "entry_id": page.entry_id, "title": page.title, "page_id": page.page_id,
           "page": page.number, "status": _page_status(sections, page.draft), "sections": sections,
           "pics": page.pics, "icon": TEMPLATE_ICONS[page.template]}
    if page.target:
        out["target"] = page.target
    for k in ("graph", "map"):
        if page.extra.get(k):
            out[k] = page.extra[k]
    return out


# ====================================================================== the page list
def _plan_pages(b: Book) -> list[Page]:
    """Every page, in binder order (the page numbers are their positions)."""
    pages = [Page(b, "1", "cover", b.title), Page(b, "2", "contents", "Contents"),
             Page(b, "3", "glance", "At a glance"), Page(b, "4", "cast", "Cast list")]
    for c in b.chars:
        d = b.dossiers.get(c["record_id"]) or {}
        p = Page(b, "5", f"character-{slug(c['record_id'])}", c["name"], entry_id=c["record_id"],
                 target=f"character:{c['record_id']}",
                 subject={"char": c, "dossier": d, "name": c["name"], "code": d.get("code"), "approved":
                          c.get("approved")})
        p.draft = not c.get("approved") or d.get("readiness") != "ready"
        pages.append(p)
    rel = Page(b, "6", "relationships", "Relationship map")
    pages.append(rel)
    for e in b.places:
        p = Page(b, "7", f"place-{slug(e['id'])}", e["name"], entry_id=(e.get("dossier") or {}).get("record_id")
                 or (e.get("canon") or {}).get("record_id"), target=f"place:{e['id']}", subject=e)
        p.draft = not e.get("approved")
        pages.append(p)
    for coll, tpl, word in ((b.magic, "8A", "magic"), (b.items, "8B", "item")):
        for e in coll:
            p = Page(b, tpl, f"{word}-{slug(e['id'])}", e["name"], entry_id=(e.get("dossier") or {}).get(
                "record_id") or (e.get("canon") or {}).get("record_id"), subject=e)
            p.draft = not e.get("approved")
            pages.append(p)
    for o in b.others:
        p = Page(b, "8C", f"world-{slug(o['id'])}", o["name"], entry_id=o["id"], target=f"group:{o['id']}",
                 subject=dict(o, canon=o["rec"]))
        p.draft = not o.get("approved")
        pages.append(p)
    has_map = bool(b.places) or any(p.get("kind") == "map" for p in (b.pictures.get("pictures") or {}).values())
    if has_map:
        pages.append(Page(b, "9", "map", "Map"))
    plan = Page(b, "10", "plan", "Story plan")
    plan.draft = any(not (b.plan.get(k) or {}).get("approved", True) for k in ("premise", "main_plot", "outline"))
    pages.append(plan)
    for ch in b.chapters:
        title = f"Chapter {ch['number']}" + (f": {ch['title']}" if ch["title"] else "")
        p = Page(b, "11", f"chapter-{slug(ch['chapter_id'])}", title, entry_id=ch["chapter_id"],
                 target=f"chapter:{ch['chapter_id']}", subject=ch)
        p.draft = not ch["approved"]
        pages.append(p)
    pages.append(Page(b, "12", "rules", "Rules & facts"))
    for i, p in enumerate(pages):
        p.number = i + 1
    return pages


CONTENT_GROUPS = (("3", "At a glance", "🔭"), ("4", "Cast", "👥"), ("6", "Relationships", "🕸"),
                  ("7", "Places", "🏙"), ("8", "World", "🌍"), ("9", "Map", "🗺"), ("10", "Story plan", "📈"),
                  ("11", "Chapters", "📖"), ("12", "Rules & facts", "🔒"))


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def known_targets(app, pid: str, branch: str) -> set:
    b = Book(app, pid, branch)
    out = {"book"} | {f"character:{c['record_id']}" for c in b.chars} | {f"place:{p['id']}" for p in b.places} | \
        {f"group:{o['id']}" for o in b.others} | {f"chapter:{c['chapter_id']}" for c in b.chapters}
    return out


def build(app, pid: str, branch: str = "main", *, look: str | None = None) -> dict:
    """The binder contract (see the module docstring)."""
    from .jobs import now_iso  # noqa: PLC0415
    b = Book(app, pid, branch)
    pages = _plan_pages(b)
    b.__dict__["_page_of"] = {p.page_id: p.number for p in pages}
    filled: dict[str, dict] = {}
    late = ("1", "2")  # the cover and the contents need every other page first
    for p in pages:
        if p.template in late:
            continue
        if p.template == "6":
            p.extra["graph"] = _graph(b)
        if p.template == "9" and b.map_graph:
            g = b.map_graph
            p.extra["map"] = {"coordinate_system": g.get("coordinate_system"), "nodes": [
                {"n": i + 1, "id": n.get("id"), "name": n.get("label"), "x": n.get("x"), "y": n.get("y")}
                for i, n in enumerate(g.get("nodes") or [])], "edges": [{"from": e.get("from"), "to": e.get("to")}
                                                                       for e in g.get("edges") or []]}
        filled[p.page_id] = fill(p)
    # --- the still-to-do list and the status numbers
    todo = []
    missing = 0
    main_pic = {"5": "5.1.1", "7": "7.1.1", "8A": "8A.1.1", "8B": "8B.1.1"}
    for p in pages:
        f = filled.get(p.page_id)
        if not f:
            continue
        if f["status"] == "needs_you":
            n = sum(1 for sec in f["sections"].values() for x in list(sec["fields"].values()) + [
                v for r in sec.get("rows") or [] for k, v in r.items() if not k.startswith("_")]
                if isinstance(x, dict) and x.get("status") == "proposed")
            todo.append({"what": f"{p.title}: {_plural(n, 'proposal')} to approve", "page_id": p.page_id,
                         "page": p.number, "action": "approve", "kind": "proposals"})
        elif f["status"] == "draft":
            todo.append({"what": f"{p.title} is a draft", "page_id": p.page_id, "page": p.number,
                         "action": "approve", "kind": "draft"})
    for p in pages:
        f = filled.get(p.page_id)
        if f and p.template in main_pic and not f["pics"].get(main_pic[p.template]):
            missing += 1
            todo.append({"what": f"No {'portrait' if p.template in ('5', '8B') else 'picture'} for {p.title}",
                         "page_id": p.page_id, "page": p.number, "action": "make_picture", "kind": "picture"})
        if f and p.template == "11" and not f["pics"].get("11.1.3") and p.subject.get("written"):
            missing += 1
    for p in pages:
        f = filled.get(p.page_id)
        if f and p.template == "11":
            w = _chapter_warnings(b, p.subject["chapter_id"]) if p.subject.get("text") else []
            if w:
                todo.append({"what": f"{p.title}: {w[0]}" + (f" (+{len(w) - 1} more)" if len(w) > 1 else ""),
                             "page_id": p.page_id, "page": p.number, "action": "fix", "kind": "continuity"})
    approved = sum(1 for f in filled.values() if f["status"] == "approved")
    total = len(filled) + 2
    cover_art = bool(b.cover.get("art")) and b.cover.get("use_art", True)
    if not cover_art:
        missing += 1
    b.__dict__["_todo"] = todo
    b.__dict__["_late"] = {
        "approved_percent": f"{round(100 * (approved + 2) / total)}%",
        "drafts_waiting": _plural(sum(1 for f in filled.values() if f["status"] != "approved"), "page") + " waiting",
        "missing_pictures": _plural(missing, "picture") + " missing" if missing else "None missing",
        "last_updated": _last_updated(b), "book_revision": _book_revision(b)}
    # --- the contents rows (counts and first pages)
    rows = []
    for tpl, title, icon in CONTENT_GROUPS:
        ps = [p for p in pages if p.template == tpl or (tpl == "8" and p.template.startswith("8"))]
        if tpl == "4":
            count = _plural(len(b.chars), "character")
        elif tpl == "7":
            count = _plural(len(b.places), "place")
        elif tpl == "8":
            count = _plural(len(ps), "entry").replace("entrys", "entries")
        elif tpl == "11":
            count = _plural(len(b.chapters), "chapter")
        elif tpl == "6":
            count = _plural(len((filled.get("relationships") or {}).get("sections", {}).get("6.3", {}).get("rows")
                                or []), "strong tie")
        else:
            count = "1 page" if ps else "not yet"
        rows.append({"template": tpl, "title": title, "icon": icon, "count_text": count, "count": len(ps),
                     "page": ps[0].number if ps else None, "page_id": ps[0].page_id if ps else None})
    b.__dict__["_contents_rows"] = rows
    for p in pages:
        if p.template in late:
            filled[p.page_id] = fill(p)
    out_pages = [filled[p.page_id] for p in pages]
    contents = []
    groups = (("1", "Cover"), ("2", "Contents"), ("3", "At a glance"), ("4", "Cast list"), ("5", "Characters"),
              ("6", "Relationship map"), ("7", "Places"), ("8A", "Magic systems"), ("8B", "Items"),
              ("8C", "World"), ("9", "Map"), ("10", "Story plan"), ("11", "Chapters"), ("12", "Rules & facts"))
    for tpl, title in groups:
        ps = [p for p in pages if p.template == tpl]
        if ps:
            contents.append({"template": tpl, "title": title, "count": len(ps), "page": ps[0].number,
                             "page_id": ps[0].page_id, "icon": TEMPLATE_ICONS[tpl]})
    stored = b.prof.get("binder_look") or ""
    default = look_for_genre(b.prof.get("genre"))
    chosen = look if look in LOOKS else stored if stored in LOOKS else default
    return {"schema_version": SCHEMA_VERSION, "generated_at": now_iso(), "updated_at": _last_updated(b),
            "book": {"title": b.title, "author": b.prof.get("author") or "", "genre": b.prof.get("genre") or "",
                     "look": chosen, "look_default": default, "look_stored": stored or None,
                     "looks": [{"id": k, **v} for k, v in LOOKS.items()]},
            "pages": out_pages, "contents": contents,
            "todo": [{k: t[k] for k in ("what", "page_id", "action", "page", "kind")} for t in todo],
            "counts": {"pages": len(out_pages), "approved": approved + 2, "missing_pictures": missing,
                       "new_fields": bf.counts(b.extras)},
            "fields_info": bf.info()}


def _last_updated(b: Book) -> str:
    try:
        r = b.store.query_one("SELECT MAX(created_at) AS m FROM records WHERE project_id=? AND branch_id=? AND module_id != 'I01'",
                              (b.pid, b.branch))
        s = b.store.query_one("SELECT MAX(updated_at) AS m FROM settings WHERE instr(key, ?) > 0 AND key NOT LIKE "
                              "'book_save:%' AND key NOT LIKE 'binder_pdf:%' AND key NOT LIKE 'job:%'", (b.pid,))
        vals = [str(x["m"]) for x in (r, s) if x and x["m"]]
        return max(vals)[:10] if vals else ""
    except Exception:  # noqa: BLE001
        return ""


def _book_revision(b: Book) -> str:
    try:
        r = b.store.query_one("SELECT COUNT(*) AS n FROM records WHERE project_id=? AND branch_id=? AND module_id != "
                              "'I01'", (b.pid, b.branch))  # pictures and kept PDFs are not book revisions
        return f"revision {int(r['n'])}" if r else ""
    except Exception:  # noqa: BLE001
        return ""


# ====================================================================== the text "✨ Fill from the book" reads
def fill_subjects(app, pid: str, branch: str) -> list[dict]:
    """[{target, kind, subject, texts: {source: text}, relationships: [(name, rel target)]}] — the book's own
    accepted text about every subject that has 🆕 fields (proposals are not used as evidence)."""
    b = Book(app, pid, branch)
    out = []

    def accepted(d: dict | None) -> dict:
        t = {}
        for s in (d or {}).get("sections") or []:
            for f in s.get("fields") or []:
                if f.get("text") and f.get("status") in ("supplied", "approved"):
                    t[f["key"]] = f["text"][:600]
        return t
    prem = (b.plan.get("premise") or {}).get("data") or {}
    book_t = {k: _clip(v, 1200) for k, v in (("idea", b.prof.get("idea")), ("premise", prem.get("premise")),
                                            ("dramatic_question", prem.get("dramatic_question")),
                                            ("concept_summary", prem.get("concept_summary")),
                                            ("main_plot", (((b.plan.get("main_plot") or {}).get("data") or {})
                                                           .get("main_plot") or {}).get("summary")),
                                            ("genre", b.prof.get("genre")), ("tone", b.prof.get("tone")),
                                            ("audience", b.prof.get("audience"))) if _clip(v)}
    if b.rules:
        book_t["story_rules"] = "; ".join(r["text"] for r in b.rules[:12])[:1500]
    out.append({"target": "book", "kind": "book", "subject": b.title, "texts": book_t})
    for c in b.chars:
        d = b.dossiers.get(c["record_id"]) or {}
        t = accepted(d)
        for k, v in (c.get("attributes") or {}).items():
            t.setdefault(k, _clip(v, 600))
        rels = [(r["name"], r["target"]) for r in _rel_rows_of(b, c)[:6]]
        for i, r in enumerate(_rel_rows_of(b, c)[:6]):
            t[f"rel_{i + 1}"] = f"{r['title']}: {r['text'][:300]}"
        out.append({"target": f"character:{c['record_id']}", "kind": "character", "subject": c["name"], "texts": t,
                    "relationships": rels})
    for p in b.places:
        t = accepted(p.get("dossier"))
        for k, v in (((p.get("canon") or {}).get("data") or {}).get("attributes") or {}).items():
            t.setdefault(k, _clip(v, 600))
        out.append({"target": f"place:{p['id']}", "kind": "place", "subject": p["name"], "texts": t})
    for o in b.others:
        data = o["rec"].get("data") or {}
        t = {k: _clip(v, 600) for k, v in (data.get("attributes") or {}).items() if _clip(v)}
        t["concept"] = _clip(data.get("concept"), 400)
        out.append({"target": f"group:{o['id']}", "kind": "group", "subject": o["name"], "texts": t})
    prev = None
    for ch in b.chapters:
        t = {"summary": ch["summary"][:600], "objective": ch["objective"][:300],
             "scene_times": " | ".join(_clip(c.get("time"), 80) for c in ch["cards"] if c.get("time"))}
        if ch["text"]:
            t["opening"] = ch["text"][:1500]
        if prev:
            t["previous_chapter"] = (prev["summary"] or prev["objective"])[:400]
            t["previous_scene_times"] = " | ".join(_clip(c.get("time"), 80) for c in prev["cards"] if c.get("time"))
            if prev["text"]:
                t["previous_ending"] = prev["text"][-800:]
        out.append({"target": f"chapter:{ch['chapter_id']}", "kind": "chapter", "subject": f"Chapter {ch['number']}",
                     "texts": {k: v for k, v in t.items() if v}})
        prev = ch
    return out


# ====================================================================== the look, the exports, HTTP
def save_look(store, pid: str, body) -> dict:
    from .book_path import get_profile, save_profile  # noqa: PLC0415
    body = body if isinstance(body, dict) else {}
    look = body.get("look")
    if look not in (None, "") and look not in LOOKS:
        raise AkoweError("INVALID_INPUT", "/look", "look: one of " + ", ".join(LOOKS) + " (or null for the genre's)",
                         **_REJ)
    save_profile(store, pid, {"binder_look": look or ""})
    prof = get_profile(store, pid)
    default = look_for_genre(prof.get("genre"))
    return {"ok": True, "look": look or default, "look_stored": look or None, "look_default": default}


def export_docx(app, pid: str, branch: str, look: str | None = None) -> tuple[bytes, str]:
    from . import binder_docx  # noqa: PLC0415
    data = build(app, pid, branch, look=look)
    return binder_docx.build_docx(data, pic_bytes=lambda url: picture_bytes(app, pid, branch, url)), \
        f"{_file_stem(data)} - Book Bible.docx"


RENDER_NOT_WIRED_WORDS = "Open AutoInjector to make the PDF, or use 🖨 Print → Save as PDF"


def export_html(app, pid: str, branch: str, look: str | None = None, page_size: str = "A4") -> tuple[str, dict]:
    from . import binder_html  # noqa: PLC0415
    data = build(app, pid, branch, look=look)
    return binder_html.render(data, pic_bytes=lambda url: picture_bytes(app, pid, branch, url),
                              page_size=page_size), data


def export_pdf(app, pid: str, branch: str, look: str | None = None, page_size: str = "A4") -> tuple[bytes, str]:
    """The binder PDF through AutoInjector's ``POST /render/pdf``. Raises AkoweError RENDER_NOT_WIRED (plain words)
    when no AutoInjector can make it."""
    from . import forge, render  # noqa: PLC0415
    html, data = export_html(app, pid, branch, look, page_size)
    try:
        pdf = render.render_pdf(app, html, title=f"{data['book']['title']} — Book Bible", page_size=page_size)
    except forge.ArtProblem as exc:
        raise not_wired(exc) from None
    return pdf, f"{_file_stem(data)} - Book Bible.pdf"


def not_wired(exc) -> AkoweError:
    """A plain-words refusal: problem ``RENDER_NOT_WIRED`` when no AutoInjector can print (not running, no route,
    wrong key), else AutoInjector's own code (RENDER_TIMEOUT, RENDER_FAILED, TOO_BIG, …) with the same way out."""
    code = getattr(exc, "code", "") or "RENDER_FAILED"
    absent = code in ("IMAGE_BRIDGE_UNREACHABLE", "RENDER_NOT_WIRED", "IMAGE_BRIDGE_KEY")
    reason = getattr(exc, "message", "") or ""
    out = AkoweError("CAPABILITY_UNAVAILABLE", "/format", f"{RENDER_NOT_WIRED_WORDS}." if absent else
                     f"The PDF could not be made: {reason}. {RENDER_NOT_WIRED_WORDS}.", **_REJ)
    out.errors[0]["problem"] = "RENDER_NOT_WIRED" if absent else code
    out.errors[0]["fix"] = RENDER_NOT_WIRED_WORDS
    return out


def _file_stem(data: dict) -> str:
    t = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', " ", data["book"]["title"] or "Book")
    return " ".join(t.split())[:60].strip(" .") or "Book"


_ASSET_URL = re.compile(r"^/api/projects/([^/]+)/branches/([^/]+)/assets/([^/]+)/(\d{1,9})$")


def picture_bytes(app, pid: str, branch: str, url: str | None) -> bytes | None:
    """The bytes of a binder picture URL (only this book's assets; anything else is None)."""
    from . import forge  # noqa: PLC0415
    m = _ASSET_URL.match(url or "")
    if not m or m.group(1) != pid or m.group(2) != branch:
        return None
    return forge.picture_bytes(app.store, pid, branch, {"asset_id": m.group(3), "version": int(m.group(4))})


def route(app, method: str, rest: list, query: dict, body, principal: str, pid: str, branch: str, headers=None):
    """/api/projects/:pid/branches/:b/binder/… (one block in server.py)."""
    look = (query.get("look") or [None])[0]
    if look not in (None, "") and look not in LOOKS:
        raise AkoweError("INVALID_INPUT", "/look", "look: one of " + ", ".join(LOOKS), **_REJ)
    if rest == [] and method == "GET":
        return 200, build(app, pid, branch, look=look or None)
    if rest == ["look"] and method == "PUT":
        return 200, save_look(app.store, pid, body)
    if rest == ["schema"] and method == "GET":
        return 200, {"templates": schema(), "map": {i: (list(s) if isinstance(s, tuple) else s)
                                                    for i, s in MAP.items()},
                     "unavailable": UNAVAILABLE, "rows": ROWS, "looks": LOOKS, "genre_looks": GENRE_LOOK,
                     "fields": bf.info()}
    if rest == ["fields"] and method == "GET":
        target = (query.get("target") or ["book"])[0]
        return 200, {"target": target, "fields": bf.values(app.store, pid, branch, target), "info": bf.info()}
    if rest == ["fields"] and method == "PUT":
        return 200, bf.edit(app.store, pid, branch, body, app=app)
    if rest == ["fields", "approve"] and method == "POST":
        return 200, bf.approve(app.store, pid, branch, body)
    if rest == ["fields", "dismiss"] and method == "POST":
        return 200, bf.dismiss(app.store, pid, branch, body)
    if rest == ["fill"] and method == "POST":
        return 202, bf.start_fill(app, principal, pid, branch, body)
    if rest == ["export"] and method == "GET":
        fmt = (query.get("format") or ["docx"])[0]
        size = (query.get("page_size") or ["A4"])[0]
        if size not in ("A4", "Letter"):
            raise AkoweError("INVALID_INPUT", "/page_size", "page_size: A4 or Letter", **_REJ)
        disposition = "inline" if (query.get("download") or ["1"])[0] == "0" else "attachment"
        if fmt == "docx":
            data, name = export_docx(app, pid, branch, look or None)
            return 200, ("__binary__", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                         data, name, disposition)
        if fmt == "pdf":
            data, name = export_pdf(app, pid, branch, look or None, size)
            return 200, ("__binary__", "application/pdf", data, name, disposition)
        if fmt == "html":
            html, data = export_html(app, pid, branch, look or None, size)
            return 200, ("__binary__", "text/html; charset=utf-8", html.encode("utf-8"),
                         f"{_file_stem(data)} - Book Bible.html", disposition)
        raise AkoweError("INVALID_INPUT", "/format", "format: docx, pdf or html", **_REJ)
    raise AkoweError("NOT_FOUND", "/binder", "no such Book Bible endpoint", **_REJ)


# ====================================================================== the book save (Book Bible/)
def save_files(app, pid: str, branch: str, files: dict, keep: set, info: dict) -> None:
    """``Book Bible/Book Bible.docx`` always; ``Book Bible/Book Bible.pdf`` when AutoInjector can render it (the PDF
    is kept per HTML fingerprint, so an unchanged binder is never rendered twice). A part that fails keeps the file
    saved before (``keep``) and is reported in ``info["skipped_parts"]``."""
    import hashlib  # noqa: PLC0415
    skipped = info.setdefault("skipped_parts", [])
    try:
        files["Book Bible/Book Bible.docx"] = export_docx(app, pid, branch)[0]
    except Exception:  # noqa: BLE001 - the rest of the save still happens
        log.exception("binder DOCX for the save failed")
        keep.add("Book Bible/Book Bible.docx")
        skipped.append({"file": "Book Bible/Book Bible.docx", "why": "the Word Book Bible could not be made"})
    try:
        html, _data = export_html(app, pid, branch)
    except Exception:  # noqa: BLE001
        log.exception("binder HTML for the save failed")
        keep.add("Book Bible/Book Bible.pdf")
        skipped.append({"file": "Book Bible/Book Bible.pdf", "why": "the Book Bible pages could not be made"})
        return
    fp = hashlib.sha256(re.sub(r'data-generated="[^"]*"', "", html).encode("utf-8")).hexdigest()[:32]
    key = f"binder_pdf:{pid}:{branch}"
    from . import forge, render  # noqa: PLC0415
    kept = app.store.get_setting(key) or {}
    if isinstance(kept, dict) and kept.get("fingerprint") == fp:
        data = forge.picture_bytes(app.store, pid, branch, kept.get("asset")) if kept.get("asset") else None
        if data and data[:5] == b"%PDF-":
            files["Book Bible/Book Bible.pdf"] = data
            return
    try:
        data = render.render_pdf(app, html, title="Book Bible", page_size="A4")
    except forge.ArtProblem as exc:
        keep.add("Book Bible/Book Bible.pdf")
        skipped.append({"file": "Book Bible/Book Bible.pdf", "why": f"{RENDER_NOT_WIRED_WORDS} ({exc.code})"})
        return
    except Exception:  # noqa: BLE001
        log.exception("binder PDF for the save failed")
        keep.add("Book Bible/Book Bible.pdf")
        skipped.append({"file": "Book Bible/Book Bible.pdf", "why": "the PDF could not be made"})
        return
    files["Book Bible/Book Bible.pdf"] = data
    try:
        asset = forge._store_asset(app.store, app.principal_id, pid, branch, data, "application/pdf",  # noqa: SLF001
                                   "Book Bible PDF")
        app.store.set_setting(key, {"fingerprint": fp, "asset": asset})
    except Exception:  # noqa: BLE001 - only the cache
        log.warning("the Book Bible PDF could not be kept for the next save")


def copy_contract(data: dict) -> dict:
    return copy.deepcopy(data)
