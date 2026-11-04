"""🔢 The Book Bible code map: one short code for every detail of the Book Bible (the author's design).

**How a code is made.** ``KIND letter + SECTION digit + FIELD letter``: ``C1c`` = a character's eyes. A whole
section is written with its digit doubled: ``C11`` = all of a character's Looks, ``C33`` = all of Voice. Sections are
numbered 0-9 (never two digits), so ``C11`` can never be mistaken for a section eleven. Field letters run a, b, c… in
the order the Book Bible shows the fields; details that only the Character Forge (or the item / place / magic
dossiers) holds come after them.

Kinds: ``B`` book · ``C`` character · ``P`` place · ``M`` magic · ``I`` item · ``G`` group · ``S`` story plan ·
``H`` chapter · ``W`` world rules & facts · ``N`` running notes (the story ledger, ``story_ledger.py``).

This module is the ONE source of truth that ties every code to

* the **binder field ids** of ``binder_schema.json`` (``"5.2.8"``: the numbers "Show field numbers" shows),
* the **Forge field keys** (``forge.FIELDS`` for characters, ``forge_kinds_spec.SPECS`` for items, places and
  magic), written ``"<kind>:<key>"`` (``"character:eyes"``),
* the **Book Bible 🆕 values** (``binder_fields.FIELDS``), written ``"<kind>:<key>"`` (``"character:height"``),
* the **story ledger categories** (``"people.injuries"``, ``"time.season"`` …) and the series categories.

Every binder field id and every Forge field maps to exactly one code (``audit()``; tested). The old Forge letters
(C P V A F M K R S E) and the binder numbers keep working: ``resolve`` / ``codes_for`` translate them.

``docs/CODE_MAP.md`` and ``web/code-map.js`` are generated from here (``markdown()`` / ``web_module()``; a test keeps
them in sync — regenerate with ``python -m akowe.code_map --write``).
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

from .errors import AkoweError

# kind letter -> (plain name, binder templates, forge kind, 🆕 bible kind)
KINDS = {
    "B": ("Book", ("1", "2", "3", "4", "6", "9"), None, "book"),
    "C": ("Character", ("5",), "character", "character"),
    "P": ("Place", ("7",), "place", "place"),
    "M": ("Magic and powers", ("8A",), "magic", None),
    "I": ("Item", ("8B",), "item", None),
    "G": ("Group", ("8C",), None, "group"),
    "S": ("Story plan", ("10",), None, "book"),
    "H": ("Chapter", ("11",), None, "chapter"),
    "W": ("World rules and facts", ("12",), None, None),
    "N": ("Running notes", (), None, None),
}
KIND_LETTERS = tuple(KINDS)

# kind -> {section digit: (section name, [(field label, "tokens")])}
# tokens: a binder field id ("5.2.8") · f:<forge key> · b:<🆕 bible key> (b:relationship.type for the relationship
# row's type) · l:<story ledger category> · s:<series category>
SPEC: dict[str, dict[int, tuple[str, list[tuple[str, str]]]]] = {
    "B": {
        0: ("Cover", [
            ("Book title", "1.1.1"), ("Subtitle", "1.1.2"), ("Author name", "1.1.3"),
            ("Series name and book number", "1.1.4 b:series b:series_number"), ("Cover art", "1.2.1"),
            ("Art credit", "1.2.2"), ("“BOOK BIBLE” label", "1.3.1"), ("Genre (label strip)", "1.3.2"),
            ("Length", "1.3.3"), ("Audience (label strip)", "1.3.4"), ("Number of chapters", "1.3.5"),
            ("Approved %", "1.4.1"), ("Drafts waiting for approval", "1.4.2"), ("Missing pictures", "1.4.3"),
            ("Last updated", "1.4.4"), ("Book version", "1.5.1"), ("Book Bible schema version", "1.5.2"),
            ("Made with", "1.5.3")]),
        1: ("Contents and still to do", [
            ("Section icon and name", "2.1.1"), ("Entries in it", "2.1.2"), ("Page number", "2.1.3"),
            ("Character thumbnails", "2.2.1"), ("Place thumbnails", "2.2.2"), ("World sigils", "2.2.3"),
            ("Item needing attention", "2.3.1"), ("Where it is", "2.3.2"), ("Action link", "2.3.3")]),
        2: ("The idea, logline and premise", [
            ("The author's idea", "3.1.1"), ("Date the book was started", "3.1.2"), ("Logline", "3.2.1"),
            ("Premise paragraph", "3.3.1")]),
        3: ("Book facts", [
            ("Genre", "3.4.1"), ("Sub-genre", "3.4.2 b:subgenre"), ("Audience / age range", "3.4.3"),
            ("Tone", "3.4.4"), ("Point of view", "3.4.5"), ("Tense", "3.4.6"), ("Length and word target", "3.4.7"),
            ("Chapters planned / written", "3.4.8"), ("Reading level", "3.4.9")]),
        4: ("Ending and style", [
            ("Ending type", "3.5.1"), ("What must be resolved", "3.5.2"), ("Style choices", "3.5.3"),
            ("Content limits", "3.5.4 b:content_limits")]),
        5: ("Main cast and the cast list", [
            ("Main cast: portrait", "3.6.1"), ("Main cast: name", "3.6.2"), ("Main cast: role", "3.6.3"),
            ("Main cast: one line", "3.6.4"), ("Cast group name", "4.1.1"), ("Cast group count", "4.1.2"),
            ("Cast card: portrait", "4.2.1"), ("Cast card: name", "4.2.2"), ("Cast card: code", "4.2.3"),
            ("Cast card: role", "4.2.4"), ("Cast card: one line", "4.2.5"), ("Cast card: age", "4.2.6"),
            ("Cast card: first chapter", "4.2.7"), ("Cast card: status", "4.2.8"), ("Cast filters", "4.3.1")]),
        6: ("Main places and themes", [
            ("Key places", "3.7.1"), ("Theme 1", "3.7.2"), ("Theme 2", "3.7.3"), ("Theme 3", "3.7.4"),
            ("Central question (At a glance)", "3.7.5")]),
        7: ("Relationship map", [
            ("Character bubbles", "6.1.1"), ("Lines between them", "6.1.2"), ("Main character in the centre", "6.1.3"),
            ("Closeness", "6.1.4"), ("Key: family", "6.2.1"), ("Key: love", "6.2.2"), ("Key: allies", "6.2.3"),
            ("Key: rivals", "6.2.4"), ("Key: enemies", "6.2.5"), ("Key: mentor / student", "6.2.6"),
            ("Strongest ties", "6.3.1"), ("Groups", "6.4.1")]),
        8: ("World map", [
            ("Map image", "9.1.1"), ("Numbered markers", "9.1.2"), ("Key: marker number", "9.2.1"),
            ("Key: place name", "9.2.2"), ("Key: page number", "9.2.3"), ("Distances: from → to", "9.3.1"),
            ("Distances: travel time", "9.3.2"), ("Distances: how", "9.3.3"), ("Compass", "9.4.1"),
            ("Scale bar", "9.4.2")]),
    },
    "C": {
        0: ("Identity", [
            ("Name", "5.1.2"), ("Nicknames and aliases", "5.1.3 f:name"), ("Code and revision", "5.1.4"),
            ("Role in the story", "5.1.5 f:role"), ("One-line summary", "5.1.6"), ("Age", "5.2.1 b:age"),
            ("Birth date", "5.2.2 b:birth"), ("Pronouns", "5.2.3 b:pronouns"), ("Species / people", "5.2.4 b:species"),
            ("Occupation", "5.2.12 b:occupation"), ("Home", "5.2.13 b:home"),
            ("Family status", "5.2.14 b:family_status"), ("Era", "5.2.15 b:era"),
            ("Handedness", "5.2.16 b:handedness"),
            ("Supplied canon", "f:supplied_canon"), ("Proposed additions", "f:proposed_additions"),
            ("Identity (Forge)", "f:identity"), ("Hard facts and numbers", "f:facts"),
            ("Record controls", "f:record_controls")]),
        1: ("Looks", [
            ("Overall look", "5.6.1 f:appearance"),
            ("Height, weight and build", "5.2.5 5.2.6 5.2.7 5.6.2 f:physique b:height b:weight b:build"),
            ("Eyes", "5.2.8 f:eyes b:eyes"), ("Hair", "5.2.9 f:hair b:hair"), ("Skin", "5.2.10 f:skin b:skin"),
            ("Face and features", "5.6.3 f:face"), ("Scars and marks", "5.2.11 f:markings b:marks"),
            ("Posture", "5.6.4 f:posture"), ("Gait", "5.6.5 f:gait"), ("Presence", "5.6.6 f:presence"),
            ("Everyday clothes", "5.6.7 f:clothing"), ("Combat clothes", "5.6.8 f:combat_clothing"),
            ("Accessories", "5.6.9 f:accessories"), ("Anatomy", "5.6.10 f:anatomy"),
            ("Pictures", "5.1.1 5.3.1 5.3.2 5.3.3 5.3.4 5.3.5 5.3.6")]),
        2: ("Personality and inner life", [
            ("Traits", "5.4.1 f:traits"), ("Their contradiction", "5.4.2"), ("What they want", "5.4.3 f:wants"),
            ("What they really need", "5.4.4 f:needs"), ("What they fear", "5.4.5 f:fear"),
            ("What they hide", "5.4.6 f:secret"), ("What they wrongly believe", "5.4.7 f:false_belief"),
            ("Under pressure", "5.4.8 f:stress"), ("What they'd never say", "5.4.9 f:never_say"),
            ("A private memory", "5.4.10 f:private_memory"), ("How far they can change", "5.4.11 f:change_limits"),
            ("Public self vs private self", "5.4.12 f:public_private"), ("Their own wish", "f:own_wish")]),
        3: ("Voice", [
            ("Sentence rhythm", "5.7.1 f:rhythm"), ("Register", "5.7.2 f:register"),
            ("Words from their job, era and place", "5.7.3 f:vocabulary"),
            ("Favourite phrases", "5.7.4 f:phrases"), ("Words they'd never use", "5.7.5 f:never_words"),
            ("Habits in conversation", "5.7.6 f:habits"), ("Speech under fear", "5.7.7 f:speech_fear"),
            ("Speech under anger", "5.7.8 f:speech_anger"), ("Speech under grief", "5.7.9 f:speech_grief"),
            ("What they talk around", "5.7.10 f:talks_around"), ("Sample lines", "5.7.11 5.7.12 f:samples")]),
        4: ("Goals and limits", [
            ("Goal in this story", "5.5.1 f:goals"), ("Concrete objective", "5.5.2 f:objective"),
            ("What they won't do", "5.5.3 f:constraints"), ("What they can't do", "5.5.4")]),
        5: ("Relationships", [
            ("Who", "5.8.1 5.8.2"), ("Relationship type", "5.8.3 b:relationship.type"),
            ("Note", "5.8.4 f:relationship_1 f:relationship_2 f:relationship_3 f:relationship_4 f:relationship_5 "
                     "f:relationship_6 s:relationships")]),
        6: ("Abilities", [
            ("Practical skills", "5.9.1 f:practical_skills"), ("Combat skills", "5.9.2 f:combat_skills"),
            ("Social and leadership skills", "5.9.3 f:social_skills"), ("Natural talents", "5.9.4 f:natural_talents"),
            ("Powers", "5.9.5 f:supernatural_abilities s:abilities_gained s:abilities_lost"),
            ("Senses", "5.9.6 f:senses"), ("Strength", "5.9.7 f:strength b:stat_strength"),
            ("Speed", "5.9.8 f:speed b:stat_speed"), ("Agility", "5.9.9 f:agility b:stat_agility"),
            ("Stamina", "5.9.10 f:stamina b:stat_stamina"), ("Durability", "5.9.11 f:durability b:stat_durability"),
            ("Fighting style", "5.9.12 f:primary_style f:secondary_style f:training"),
            ("Signature moves", "5.9.13 f:signature_moves"), ("Weakness in a fight", "5.9.14 f:exploitable_habits"),
            ("Survival, stealth and crafting", "f:survival_stealth f:technical_skills"),
            ("Passive abilities and transformations", "f:passive_abilities f:transformations"),
            ("Reflexes", "f:reflexes"), ("Endurance and recovery", "f:endurance f:recovery"),
            ("Range, stance and approach", "f:preferred_range f:stance f:approach"),
            ("Tactics, surroundings and teamwork", "f:tactics f:surroundings f:teamwork"),
            ("Courage, and when outmatched", "f:courage f:outmatched"),
            ("Combat limits and growth", "f:combat_boundaries"),
            ("Power source and access", "f:power_source f:power_access f:activation"),
            ("Named powers", "f:named_power_1 f:named_power_2"),
            ("Power effects, signs and growth", "f:power_effects f:power_signs f:power_growth"),
            ("Power costs, limits and failure", "f:power_costs f:power_limits f:power_failure")]),
        7: ("Possessions and knowledge", [
            ("Primary weapon / tool", "5.10.1 f:primary_weapon"),
            ("Backup and ranged option", "5.10.2 f:backup_weapon f:ranged_option"),
            ("Signature possessions", "5.10.3 f:signature_possessions s:items_gained s:items_lost"),
            ("Resources", "5.10.4 f:resources"), ("Gear weaknesses and costs", "5.10.5 f:weapon_weaknesses"),
            ("Education", "5.11.1 f:education"), ("Languages", "5.11.2 f:languages"),
            ("Specialist subjects", "5.11.3 f:specialist_subjects"), ("Blind spots", "5.11.4 f:blind_spots"),
            ("Things they don't know", "5.11.5 f:unknowns"), ("What they know that the reader doesn't",
                                                           "5.11.6 f:reader_knowledge"),
            ("Weapon's special properties", "f:weapon_properties"), ("Weapon maintenance", "f:weapon_maintenance"),
            ("Weapon's signature use", "f:weapon_signature"), ("Cultural knowledge", "f:cultural_knowledge"),
            ("Practical experience", "f:practical_experience"), ("Sources of learning", "f:learning_sources"),
            ("Misconceptions", "f:misconceptions")]),
        8: ("Backstory and story arc", [
            ("Backstory timeline", "5.12.1 5.12.2 f:backstory_1 f:backstory_2 f:backstory_3 f:backstory_4 "
                                   "f:backstory_5 f:backstory_6 f:backstory_7 f:backstory_8"),
            ("Opening status quo", "5.13.1 f:opening"), ("Inciting incident", "5.13.2 f:inciting_incident"),
            ("Escalating obstacles", "5.13.3 f:obstacles"), ("Midpoint revelation", "5.13.4 f:midpoint"),
            ("Major setback", "5.13.5 f:setback"), ("Decisive choice", "5.13.6 f:decisive_choice"),
            ("Climax", "5.13.7 f:climax"), ("Resolution", "5.13.8 f:resolution"),
            ("Resulting change", "5.13.9 f:change_hook"), ("Sequel hook", "5.13.10"),
            ("Background", "f:background s:appearance")]),
        9: ("In the book and continuity", [
            ("First appearance", "5.14.1"), ("Chapters they appear in", "5.14.2"),
            ("Must reach the page", "5.14.3 5.14.4 5.14.5 5.14.6 5.14.7 f:must_show_1 f:must_show_2 f:must_show_3 "
                                    "f:must_show_4 f:must_show_5"),
            ("Fixed visual anchors", "5.14.8 f:visual_anchors"), ("Timeline and injury ledger", "5.14.9 f:timeline_ledger"),
            ("Power ledger", "5.14.10 f:power_ledger"), ("Secrets and who knows", "5.14.11 f:secrets_ledger"),
            ("Reader reveal points", "5.14.12 f:reveal_points"), ("Linked records", "5.14.13 f:linked_records"),
            ("Readiness by component", "f:component_readiness"), ("Unresolved choices", "f:unresolved_choices"),
            ("Artwork note", "f:artwork_note"), ("Verification scope", "f:verification_scope")]),
    },
    "P": {
        0: ("Identity and quick facts", [
            ("Establishing shot", "7.1.1"), ("Name and other names", "7.1.2 f:name"), ("Code", "7.1.3"),
            ("Kind of place", "7.1.4 f:place_type"), ("One-line description", "7.1.5 f:one_line"),
            ("Role in the story", "7.1.6 f:role_in_story"), ("Where", "7.2.1 f:location"),
            ("When (era)", "7.2.2 f:setting_time"), ("Size / scale", "7.2.3 f:size_scale"), ("Climate", "7.2.4"),
            ("Population", "7.2.5 f:population"), ("Who's in charge", "7.2.6 f:rulers"),
            ("Danger level", "7.2.7 b:danger_level"), ("First impression", "7.2.8 f:first_impression"),
            ("Supplied canon", "f:supplied_canon"), ("Proposed additions", "f:proposed_additions"),
            ("Record controls", "f:record_controls")]),
        1: ("Mood views", [("Day", "7.3.1"), ("Night", "7.3.2"), ("Interior / detail", "7.3.3")]),
        2: ("Senses", [
            ("Sights", "7.4.1 f:sights"), ("Sounds", "7.4.2 f:sounds"), ("Smells", "7.4.3 f:smells"),
            ("Touch, temperature, air", "7.4.4 f:touch"), ("Light by day", "7.4.5 f:light"), ("Light by night", "7.4.6"),
            ("Mood", "7.4.7 f:mood"), ("Seasons and weather", "7.4.8 f:seasons"),
            ("Signature sensory detail", "7.4.9 f:signature_detail")]),
        3: ("Layout", [
            ("Location and surroundings", "7.5.1 f:map_notes"), ("Layout", "7.5.2 f:layout"),
            ("Landmarks", "7.5.3 f:landmarks"), ("Districts / rooms / zones", "7.5.4 f:districts"),
            ("Terrain", "7.5.5 f:terrain"), ("Architecture and materials", "7.5.6 f:architecture"),
            ("Map crop", "7.5.7")]),
        4: ("History", [
            ("Founding and origin", "7.6.1 f:founding"), ("Eras and turning points", "7.6.2 f:eras"),
            ("Key events", "7.6.3 f:key_events"), ("Ruins and traces", "7.6.4 f:ruins"),
            ("Recent change", "7.6.5 f:recent_change"), ("Myths and local stories", "7.6.6 f:myths"),
            ("Dates and numbers", "7.6.7 f:timeline_facts")]),
        5: ("People and factions", [
            ("Who lives here", "7.7.1"), ("Factions and power", "7.7.2 f:factions"), ("Who is in charge", "7.7.3"),
            ("Economy and trade", "7.7.4 f:economy"), ("Customs and culture", "7.7.5 f:culture"),
            ("Speech and dialect", "7.7.6 f:language"), ("Notable residents", "7.7.7 f:notable_people"),
            ("How outsiders are treated", "7.7.8 f:outsiders")]),
        6: ("Rules and dangers", [
            ("Laws and rules", "7.8.1 f:laws"), ("Dangers", "7.8.2 f:dangers"), ("Natural hazards", "7.8.3 f:hazards"),
            ("Forbidden places and acts", "7.8.4 f:forbidden"), ("Magic / technology here", "7.8.5 f:magic_here"),
            ("Defences and security", "7.8.6 f:defences"), ("Safe places", "7.8.7 f:safe_havens")]),
        7: ("Routes", [
            ("How to get in and out", "7.9.1 f:access"), ("Routes to other places", "7.9.2 f:routes"),
            ("Travel times and distances", "7.9.3 f:travel_times"), ("Hidden ways", "7.9.4 f:hidden_ways"),
            ("Transport", "7.9.5 f:transport"), ("Borders and checkpoints", "7.9.6 f:borders")]),
        9: ("In the book and continuity", [
            ("First appearance", "7.10.1 f:first_appearance"), ("Scenes set here", "7.10.2 f:scenes_set_here"),
            ("How it changes", "7.10.3 f:how_it_changes"), ("Characters tied to it", "7.10.4 f:characters_here"),
            ("Reader reveal points", "7.10.5 f:reveal_points"),
            ("Must reach the page", "7.10.6 7.10.7 7.10.8 f:must_show_1 f:must_show_2 f:must_show_3"),
            ("Fixed visual anchors", "7.10.9 f:fixed_anchors"), ("State and damage ledger", "7.10.10 f:state_ledger"),
            ("Who is where", "7.10.11 f:occupancy_ledger"), ("Secrets and who knows", "7.10.12 f:secrets_ledger"),
            ("Linked records", "7.10.13 f:linked_records"), ("Unresolved choices", "f:unresolved_choices"),
            ("Artwork note", "f:artwork_note"), ("Verification scope", "f:verification_scope")]),
    },
    "M": {
        0: ("Identity and quick facts", [
            ("Sigil", "8A.1.1"), ("Name and other names", "8A.1.2 f:name"), ("Code", "8A.1.3"),
            ("Kind of system", "8A.1.4 f:kind_of_power"), ("One-line description", "8A.1.5 f:one_line"),
            ("Where the power comes from", "8A.2.1 f:source"), ("Who can use it", "8A.2.2 f:who_has_it"),
            ("How it's gained", "8A.2.3 f:how_gained"), ("How rare", "8A.2.4 f:rarity"),
            ("Cost of use", "8A.2.5 f:cost"), ("Supplied canon", "f:supplied_canon"),
            ("Proposed additions", "f:proposed_additions"), ("Nature", "f:nature"),
            ("Record controls", "f:record_controls")]),
        1: ("Hard rules", [
            ("Core rules", "8A.3.1 f:core_rules"), ("Hard limits", "8A.3.2 f:hard_limits"),
            ("Range and duration", "8A.3.3 f:range_duration"), ("What it can never do", "8A.3.4 f:cannot_do"),
            ("Counters and protections", "8A.3.5 f:counters"), ("Exceptions", "8A.3.6 f:exceptions"),
            ("Interaction with technology", "8A.3.7 f:interactions")]),
        2: ("Named powers", [
            ("Power name", "8A.4.1 f:named_power_1 f:named_power_2 f:named_power_3 f:named_power_4"),
            ("What it does", "8A.4.2"), ("Who uses it", "8A.4.3")]),
        3: ("Access and recovery", [
            ("Activation and method", "8A.5.1 f:activation"), ("Recovery", "8A.5.2 f:recovery"),
            ("Long-term price", "8A.5.3 f:price_long"), ("Combinations and rituals", "8A.5.4 f:combinations f:rituals")]),
        4: ("Visible signs", [
            ("What it looks like", "8A.6.1 f:visual_signs"), ("Sounds, smells, feel", "8A.6.2 f:sounds_smells"),
            ("Marks on the body", "8A.6.3 f:on_the_body"), ("Effects on surroundings", "8A.6.4 f:environment_signs"),
            ("Tells before use", "8A.6.5 f:tells"), ("Sigil (description)", "f:sigil")]),
        5: ("Failure and backlash", [
            ("Failure conditions", "8A.7.1 f:failure_conditions"), ("Backlash", "8A.7.2 f:backlash"),
            ("Overuse", "8A.7.3 f:overuse"), ("Misuse and corruption", "8A.7.4 f:misuse"),
            ("Worst case", "8A.7.5 f:worst_case")]),
        6: ("Practitioners", [
            ("Known practitioners", "8A.8.1 f:practitioners"), ("Training", "8A.8.2 f:training"),
            ("Ranks and levels", "8A.8.3 f:ranks"), ("Schools and orders", "8A.8.4 f:schools"),
            ("What mastery looks like", "8A.8.5 f:mastery"), ("Beginners", "f:beginners")]),
        7: ("Lore", [
            ("Origin", "8A.9.1 f:origin_story"), ("Key events", "8A.9.2 f:key_events"),
            ("Myths and misreadings", "8A.9.3 f:lore"), ("Lost knowledge", "8A.9.4 f:lost_knowledge"),
            ("Discovery", "f:discovery")]),
        8: ("Society's view", [
            ("What ordinary people think", "8A.10.1 f:public_view"), ("Laws and control", "8A.10.2 f:law"),
            ("Who controls it", "8A.10.3 f:institutions"), ("Fear, prejudice and status", "8A.10.4 f:prejudice"),
            ("Economy", "f:economy")]),
        9: ("In the book and continuity", [
            ("In-use scene", "8A.11.1"), ("First use on the page", "8A.11.2 f:first_use"),
            ("How use escalates", "8A.11.3 f:escalation"), ("Use at the climax", "8A.11.4 f:climax_use"),
            ("Use ledger", "8A.11.5 f:power_ledger"), ("Secrets and who knows", "8A.11.6 f:secrets_ledger"),
            ("Key uses", "f:key_uses"), ("Reader reveal points", "f:reveal_points"),
            ("Must reach the page", "f:must_show_1 f:must_show_2 f:must_show_3"), ("Rules ledger", "f:rules_ledger"),
            ("Linked records", "f:linked_records"), ("Unresolved choices", "f:unresolved_choices"),
            ("Artwork note", "f:artwork_note"), ("Verification scope", "f:verification_scope")]),
    },
    "I": {
        0: ("Identity and quick facts", [
            ("Item portrait", "8B.1.1"), ("Name and aliases", "8B.1.2 f:name"), ("Code", "8B.1.3"),
            ("Type and class", "8B.1.4 f:item_type"), ("One-line description", "8B.1.5 f:one_line"),
            ("Size and weight", "8B.2.1 f:size_weight"), ("Materials", "8B.2.2 f:materials"),
            ("Colours and finish", "8B.2.3 f:colours"), ("Current holder", "8B.2.4 f:current_holder"),
            ("Current state", "8B.2.5 f:status_now"), ("Value / price", "8B.2.6 f:value"),
            ("Overall look", "f:overall_look"), ("Shape", "f:shape"), ("Markings", "f:markings"),
            ("Sound and smell", "f:sound_smell"), ("Condition", "f:condition"), ("Purpose", "f:purpose"),
            ("Supplied canon", "f:supplied_canon"), ("Proposed additions", "f:proposed_additions"),
            ("Record controls", "f:record_controls")]),
        1: ("Turnaround pictures", [("Front", "8B.3.1"), ("Side", "8B.3.2"), ("Back", "8B.3.3"), ("Detail", "8B.3.4")]),
        2: ("Powers and limits", [
            ("What it can do", "8B.4.1 f:abilities"), ("How it works", "8B.4.2 f:how_it_works"),
            ("Activation", "8B.4.3 f:activation"), ("Hard limits", "8B.4.4 f:limits"),
            ("Costs to the user", "8B.4.5 f:costs"), ("Weaknesses and counters", "8B.4.6 f:weaknesses"),
            ("What it can never do", "8B.4.7 f:cannot_do"), ("Side effects", "f:side_effects"),
            ("Linked magic system", "f:linked_system")]),
        3: ("Use and care", [
            ("Who can use it", "8B.5.1 f:who_can_use"), ("Skill needed", "8B.5.2 f:skill_needed"),
            ("Use in a fight", "8B.5.3 f:combat_use"), ("Maintenance", "8B.5.4 f:maintenance"),
            ("Damage, repair and destruction", "8B.5.5 f:damage"), ("Handling", "f:handling"),
            ("Everyday use", "f:everyday_use"), ("Legal status", "f:legal"), ("Signature use", "f:signature_use")]),
        4: ("History", [
            ("Origin and maker", "8B.6.1 f:origin"), ("When and where made", "8B.6.2 f:made_when"),
            ("Previous owners", "8B.6.3 f:previous_owners"), ("Key events", "8B.6.4 f:key_events"),
            ("Legends and rumours", "8B.6.5 f:legends"), ("What nobody knows", "8B.6.6 f:provenance_gaps"),
            ("How it was made", "f:made_how"), ("How it was acquired", "f:how_acquired")]),
        5: ("Ownership", [
            ("Rightful owner", "8B.7.1 f:owner"), ("Who must never have it", "8B.7.2 f:forbidden_users"),
            ("Who wants it and why", "8B.7.3 f:who_wants_it"), ("Changes of hands", "8B.7.4 f:transfers"),
            ("Bond with its holder", "8B.7.5 f:bond"), ("Story significance", "8B.7.6 f:significance"),
            ("Allowed users", "f:allowed_users")]),
        9: ("Where it is and continuity", [
            ("First appearance", "8B.8.1 f:first_appearance"), ("How it's introduced", "8B.8.2 f:introduction"),
            ("Key scenes", "8B.8.3 f:key_scenes"), ("Turning point", "8B.8.4 f:turning_point"),
            ("Where it ends up", "8B.8.5 f:final_state"), ("Location chapter by chapter", "8B.8.6 f:location_ledger"),
            ("Condition and damage ledger", "8B.8.7 f:condition_ledger"), ("Uses and charges ledger", "8B.8.8 f:uses_ledger"),
            ("Secrets and who knows", "8B.8.9 f:secrets_ledger"), ("Fixed visual anchors", "8B.8.10 f:visual_anchors"),
            ("Linked records", "8B.8.11 f:linked_records"), ("Reader reveal points", "f:reveal_points"),
            ("Must reach the page", "f:must_show_1 f:must_show_2 f:must_show_3"),
            ("Unresolved choices", "f:unresolved_choices"), ("Artwork note", "f:artwork_note"),
            ("Verification scope", "f:verification_scope")]),
    },
    "G": {
        0: ("Identity and key facts", [
            ("Emblem / picture", "8C.1.1"), ("Name", "8C.1.2"), ("Kind", "8C.1.3"), ("One-line description", "8C.1.4"),
            ("Founded / origin", "8C.3.1"), ("Size / reach", "8C.3.2"), ("Leaders", "8C.3.3"),
            ("Base / where", "8C.3.4"), ("Symbol and colours", "8C.3.5 b:symbol_colours")]),
        1: ("Description", [("Full description", "8C.2.1")]),
        2: ("Rules and beliefs", [
            ("Main rules or tenets", "8C.4.1"), ("What's forbidden", "8C.4.2"), ("What members believe about others",
                                                                               "8C.4.3")]),
        3: ("Members", [("Members / followers", "8C.5.1"), ("Allies", "8C.5.2"), ("Enemies", "8C.5.3")]),
        9: ("In the book", [
            ("First appearance", "8C.6.1"), ("Role in the plot", "8C.6.2"), ("Secrets and who knows", "8C.6.3"),
            ("Linked records", "8C.6.4")]),
    },
    "S": {
        1: ("Premise", [("Premise paragraph", "10.1.1"), ("Central conflict", "10.1.2")]),
        2: ("Plot line", [
            ("Opening", "10.2.1"), ("Inciting incident", "10.2.2"), ("First plot point", "10.2.3"),
            ("Midpoint", "10.2.4"), ("Crisis / all is lost", "10.2.5"), ("Climax", "10.2.6"),
            ("Resolution", "10.2.7"), ("Final image", "10.2.8")]),
        3: ("Character arcs", [("Name", "10.3.1"), ("Starts as", "10.3.2"), ("Ends as", "10.3.3")]),
        4: ("Subplots", [("Subplot name", "10.4.1"), ("What it's about", "10.4.2"), ("Chapters it runs through",
                                                                                  "10.4.3")]),
        5: ("Themes and motifs", [
            ("Themes", "10.5.1 b:themes"), ("Motifs and symbols", "10.5.2"), ("Recurring images", "10.5.3"),
            ("Central question", "10.5.4 b:central_question")]),
        6: ("Ending", [
            ("Ending type", "10.6.1"), ("What's resolved", "10.6.2"), ("What's left open", "10.6.3"),
            ("Sequel hook", "10.6.4")]),
    },
    "H": {
        0: ("Identity and quick facts", [
            ("Chapter number", "11.1.1"), ("Chapter title", "11.1.2"), ("Chapter picture", "11.1.3"),
            ("Status", "11.1.4"), ("Word count", "11.1.5"), ("Word target", "11.1.6"), ("POV character", "11.2.1"),
            ("Main place", "11.2.2"), ("Story time / date", "11.2.3"),
            ("Time since the previous chapter", "11.2.4 b:time_since_previous")]),
        1: ("What happens", [("Chapter summary", "11.3.1"), ("Chapter goal", "11.3.2")]),
        2: ("Scene cards", [
            ("Scene number", "11.4.1"), ("Goal", "11.4.2"), ("Conflict", "11.4.3"), ("Outcome", "11.4.4"),
            ("Who's in it", "11.4.5"), ("Where and when", "11.4.6")]),
        3: ("Who's here", [("Who's here", "11.5.1")]),
        4: ("Must reach the page", [("Planned detail", "11.6.1"), ("On the page or missing", "11.6.2")]),
        5: ("Threads", [("Setups paid off here", "11.7.1"), ("Setups planted here", "11.7.2")]),
        6: ("Checks", [
            ("Readability", "11.8.1"), ("Editor score", "11.8.2"), ("Repeats flagged", "11.8.3"),
            ("Continuity warnings", "11.8.4")]),
    },
    "W": {
        1: ("Protected facts", [("The fact", "12.1.1"), ("What it's about", "12.1.2"), ("Why it's locked", "12.1.3")]),
        2: ("Story rules", [
            ("Hard rules", "12.2.1"), ("Soft rules", "12.2.2"), ("Beliefs in the world", "12.2.3"),
            ("Mysteries", "12.2.4")]),
        3: ("Timeline", [("Date / story time", "12.3.1"), ("Event", "12.3.2"), ("Chapter", "12.3.3"),
                         ("Clash flag", "12.3.4")]),
        4: ("Names and terms", [("Term", "12.4.1"), ("Meaning", "12.4.2"), ("Type", "12.4.3"),
                                ("Checked / research needed", "12.4.4")]),
        5: ("World details", [("Detail", "12.5.1"), ("Where it shows up", "12.5.2")]),
        6: ("Style sheet", [
            ("Narrative voice", "12.6.1"), ("Tense", "12.6.2"), ("POV rules", "12.6.3"), ("Reading level", "12.6.4"),
            ("Dialogue style", "12.6.5"), ("Spelling", "12.6.6"), ("Words to avoid", "12.6.7")]),
        7: ("Repeats to watch", [("Phrase", "12.7.1"), ("Kind", "12.7.2")]),
    },
    "N": {
        1: ("Injuries and health", [("Injuries", "l:people.injuries"), ("After-effects of powers",
                                                                         "l:people.magic_cost")]),
        2: ("What each character carries, has gained or has lost", [
            ("Carrying", "l:people.carrying"), ("Gained", "l:people.items_gained"), ("Lost", "l:people.items_lost")]),
        3: ("Alive or dead, and where each character is now", [
            ("Alive or dead", "l:people.status s:status"), ("Where they are now", "l:people.where")]),
        4: ("Who knows which secret", [("Who learns or is surprised by what", "l:knowledge")]),
        5: ("Relationships right now", [("Relationship changes", "l:relationships")]),
        6: ("Story day, date, season and time since the last chapter", [
            ("Story day", "l:time.day"), ("Date", "l:time.date"), ("Season", "l:time.season"),
            ("Time since the last chapter", "l:time.since_previous"), ("Journeys and how long they take", "l:trips")]),
        7: ("Money, prices and counts", [
            ("Money", "l:numbers.money"), ("Prices", "l:numbers.price"), ("Distances", "l:numbers.distance"),
            ("Counts", "l:numbers.count")]),
        8: ("Name list", [("Every name used so far", "l:names")]),
        9: ("Story so far", [("Story so far", "l:summary"), ("How the last chapter ended", "l:end")]),
    },
}

# the old Forge letters: the section each one mostly means (resolve("A") -> C11 plus every field that carries it)
LETTER_SECTIONS = {"C": "C00", "P": "C22", "V": "C33", "A": "C11", "F": "C66", "M": "C66", "K": "C77", "R": "C55",
                   "S": "C88", "E": "C99"}
LETTER_NAMES = {"C": "Canon", "P": "Personality", "V": "Voice", "A": "Appearance", "F": "Fighting", "M": "Magic",
                "K": "Knowledge/skills", "R": "Relationships", "S": "Story development",
                "E": "Essential on-page detail"}

CODE_RE = re.compile(r"^([BCPMIGSHWN])(\d)(\d|[a-z])?$")
FIELD_CODE_IN_TEXT = re.compile(r"\b([BCPMIGSHWN])(\d)([a-z])\b")
BINDER_ID_RE = re.compile(r"^(?:\d{1,2}|8[ABC])\.\d{1,2}\.\d{1,2}$")
BINDER_SECTION_RE = re.compile(r"^(?:\d{1,2}|8[ABC])\.\d{1,2}$")
LETTERS = "abcdefghijklmnopqrstuvwxyz"


def _bad(path: str, msg: str) -> AkoweError:
    return AkoweError("INVALID_INPUT", path, msg, status="REJECTED")


# ====================================================================== the table
@lru_cache(maxsize=1)
def _table() -> dict:
    """{"fields": {code: entry}, "sections": {section code: entry}, indexes …} built once from SPEC."""
    fields, sections = {}, {}
    by_binder, by_forge, by_bible, by_ledger, by_series = {}, {}, {}, {}, {}
    for kind, secs in SPEC.items():
        kname, _tpls, fkind, bkind = KINDS[kind]
        for digit, (sname, rows) in sorted(secs.items()):
            scode = f"{kind}{digit}{digit}"
            if len(rows) > len(LETTERS):
                raise ValueError(f"{scode}: more than 26 fields")
            codes = []
            for i, (label, tokens) in enumerate(rows):
                code = f"{kind}{digit}{LETTERS[i]}"
                e = {"code": code, "kind": kind, "kind_label": kname, "section": scode, "section_label": sname,
                     "letter": LETTERS[i], "label": label, "binder": [], "forge": [], "bible": [], "ledger": [],
                     "series": []}
                for tok in tokens.split():
                    if BINDER_ID_RE.match(tok):
                        e["binder"].append(tok)
                        by_binder.setdefault(tok, []).append(code)
                    elif tok.startswith("f:"):
                        key = f"{fkind}:{tok[2:]}"
                        e["forge"].append(key)
                        by_forge.setdefault(key, []).append(code)
                    elif tok.startswith("b:"):
                        k = tok[2:]
                        key = k.replace(".", ":") if "." in k else f"{bkind}:{k}"
                        e["bible"].append(key)
                        by_bible.setdefault(key, []).append(code)
                    elif tok.startswith("l:"):
                        e["ledger"].append(tok[2:])
                        by_ledger.setdefault(tok[2:], []).append(code)
                    elif tok.startswith("s:"):
                        e["series"].append(tok[2:])
                        by_series.setdefault(tok[2:], []).append(code)
                    else:
                        raise ValueError(f"{code}: unknown token {tok!r}")
                fields[code] = e
                codes.append(code)
            sections[scode] = {"code": scode, "kind": kind, "kind_label": kname, "digit": digit, "label": sname,
                               "fields": codes,
                               "binder_sections": sorted({b.rsplit(".", 1)[0] for c in codes
                                                          for b in fields[c]["binder"]}, key=_binder_sort)}
    return {"fields": fields, "sections": sections, "binder": by_binder, "forge": by_forge, "bible": by_bible,
            "ledger": by_ledger, "series": by_series}


def _binder_sort(fid: str):
    parts = fid.split(".")
    t = parts[0]
    return ((int(t[0]) * 10 + ord(t[1]) - 64) if t[1:] else int(t) * 10, *[int(p) for p in parts[1:]])


def fields() -> dict:
    return _table()["fields"]


def sections() -> dict:
    return _table()["sections"]


def all_codes() -> list[str]:
    return list(fields())


# ====================================================================== parse / format
def parse(code: str) -> dict:
    """``"C1c"`` -> {kind, section, letter, whole: False}; ``"C11"`` / ``"C1"`` -> {…, letter: None, whole: True}.
    Raises a plain error for anything that is not a code (or a code nobody gave out)."""
    if not isinstance(code, str):
        raise _bad("/code", "a code is text like C1c (one detail) or C11 (a whole section)")
    s = code.strip()
    m = CODE_RE.match(s)
    if not m:
        raise _bad("/code", f"“{code}” is not a Book Bible code: a code is a kind letter "
                            f"({', '.join(KIND_LETTERS)}), a section number 0-9 and a field letter — C1c is a "
                            "character's eyes, C11 all of their Looks")
    kind, digit, rest = m.group(1), int(m.group(2)), m.group(3)
    if rest and rest.isdigit() and int(rest) != digit:
        raise _bad("/code", f"“{code}”: a whole section is its number written twice (C11, C33) — sections are 0-9, "
                            "never two digits")
    whole = not rest or rest.isdigit()
    scode = f"{kind}{digit}{digit}"
    if scode not in sections():
        have = ", ".join(s_ for s_ in sections() if s_[0] == kind)
        raise _bad("/code", f"“{code}”: {KINDS[kind][0].lower()} has no section {digit} (its sections: {have})")
    if not whole:
        fc = f"{kind}{digit}{rest}"
        if fc not in fields():
            n = len(sections()[scode]["fields"])
            raise _bad("/code", f"“{code}”: {sections()[scode]['label']} ({scode}) has fields a-{LETTERS[n - 1]} "
                                f"only")
    return {"kind": kind, "section": scode, "digit": digit, "letter": None if whole else rest, "whole": whole}


def format_code(kind: str, section: int, letter: str | None = None) -> str:
    """("C", 1, "c") -> "C1c"; ("C", 1) -> "C11" (a whole section: the digit doubled)."""
    if kind not in KINDS or not isinstance(section, int) or not 0 <= section <= 9:
        raise _bad("/code", "kind: one of " + ", ".join(KIND_LETTERS) + "; section: 0-9")
    out = f"{kind}{section}{letter}" if letter else f"{kind}{section}{section}"
    parse(out)
    return out


def is_code(s) -> bool:
    try:
        parse(s)
        return True
    except AkoweError:
        return False


# ====================================================================== resolve / expand / codes_for
def expand(code: str) -> list[str]:
    """``"C11"`` -> every field code of that section (``["C1a", …]``); a field code -> ``[code]``."""
    p = parse(code)
    return list(sections()[p["section"]]["fields"]) if p["whole"] else [code.strip()]


def resolve(code: str) -> dict:
    """What a code (or an old Forge letter, a binder number, a Forge / 🆕 key) covers, in plain words.

    A field code -> its entry (label, section, binder ids, Forge keys, 🆕 keys, ledger categories). A section code ->
    the section with every field. Old forms are translated: ``"5.2.8"`` -> C1c, ``"5.2"`` -> C00 and C11's part,
    ``"A"`` (the old Appearance letter) -> C11 and the fields that carry the letter, ``"character:eyes"`` -> C1c."""
    s = code.strip() if isinstance(code, str) else code
    if isinstance(s, str) and CODE_RE.match(s):
        p = parse(s)
        if p["whole"]:
            sec = sections()[p["section"]]
            return dict(sec, whole=True, fields=[dict(fields()[c]) for c in sec["fields"]],
                        binder=[b for c in sec["fields"] for b in fields()[c]["binder"]],
                        forge=[f for c in sec["fields"] for f in fields()[c]["forge"]])
        return dict(fields()[s], whole=False)
    found = codes_for(s)
    if not found:
        raise _bad("/code", f"“{code}” is not a Book Bible code, field number or field name")
    if isinstance(s, str) and s.upper() == s and s in LETTER_NAMES:
        return {"code": LETTER_SECTIONS[s], "old_letter": s, "label": LETTER_NAMES[s], "translated": found,
                "whole": True, **{k: v for k, v in resolve(LETTER_SECTIONS[s]).items() if k not in ("code", "label")}}
    if len(found) == 1:
        return dict(resolve(found[0]), translated_from=s)
    return {"code": None, "translated_from": s, "translated": found, "whole": True,
            "fields": [dict(fields()[c]) for c in found if c in fields()]}


def codes_for(ref: str, kind: str | None = None) -> list[str]:
    """The code(s) of a binder field id ("5.2.8"), a binder section ("5.2"), a Forge key ("character:eyes", or
    "eyes" with ``kind``), a 🆕 key ("character:height"), a ledger category ("people.injuries" / "ledger:…"), a series
    category ("series:items_lost"), an old Forge letter ("A": every character field that carries it) — or a code
    (itself; a section code -> its fields). [] when nothing matches."""
    t = _table()
    if not isinstance(ref, str) or not ref.strip():
        return []
    s = ref.strip()
    if CODE_RE.match(s):
        try:
            return expand(s)
        except AkoweError:
            return []
    if BINDER_ID_RE.match(s):
        return list(t["binder"].get(s, []))
    if BINDER_SECTION_RE.match(s):
        out = []
        for b, cs in sorted(t["binder"].items(), key=lambda kv: _binder_sort(kv[0])):
            if b.rsplit(".", 1)[0] == s:
                out += [c for c in cs if c not in out]
        return out
    if s in LETTER_NAMES:
        from .forge import FIELDS  # noqa: PLC0415
        out = []
        for key, f in FIELDS.items():
            if s in f["letters"]:
                out += [c for c in t["forge"].get(f"character:{key}", []) if c not in out]
        return sorted(out, key=_code_sort)
    if s.startswith("ledger:"):
        return list(t["ledger"].get(s[7:], []))
    if s.startswith("series:"):
        return list(t["series"].get(s[7:], []))
    if s.startswith("forge:") or s.startswith("bible:"):
        s = s.split(":", 1)[1]
    if ":" not in s and kind:
        s = f"{kind}:{s}"
    out = list(t["forge"].get(s, [])) + [c for c in t["bible"].get(s, []) if c not in t["forge"].get(s, [])]
    if not out:
        out = list(t["ledger"].get(s, []))
    return out


def _code_sort(c: str):
    return (KIND_LETTERS.index(c[0]), int(c[1]), c[2:])


def code_of_field(kind: str, key: str) -> str | None:
    """The one code of a Forge (or 🆕) field of this kind, or None."""
    cs = codes_for(f"{kind}:{key}")
    return cs[0] if cs else None


def tag(kind: str, key: str, words: str | None = None) -> str:
    """``"C1c (eyes)"`` for a Forge / 🆕 field — the plain words kept, the code added. ``words`` defaults to the
    code's own label in lower case. Returns just ``words`` when the field has no code."""
    c = code_of_field(kind, key)
    w = (words if words is not None else (fields()[c]["label"] if c else key)).lower()
    return f"{c} ({w})" if c else w


def label(code: str) -> str:
    r = resolve(code)
    return r["label"]


# ====================================================================== the audit (every id and key exactly once)
def binder_ids() -> list[str]:
    path = Path(__file__).with_name("binder_schema.json")
    d = json.loads(path.read_text(encoding="utf-8"))
    return [f["id"] for t in d.values() for s in t["sections"] for f in s.get("fields", [])]


def forge_keys() -> list[str]:
    from . import forge  # noqa: PLC0415
    from .forge_kinds_spec import SPECS  # noqa: PLC0415
    out = [f"character:{k}" for k in forge.FIELDS]
    for kind, sp in SPECS.items():
        out += [f"{kind}:{f['key']}" for _k, _t, fs in sp["sections"] for f in fs]
    return out


def bible_keys() -> list[str]:
    from .binder_fields import FIELDS  # noqa: PLC0415
    return [f"{kind}:{k}" for kind, rules in FIELDS.items() for k in rules]


def audit() -> dict:
    """{missing_binder, duplicate_binder, unknown_binder, missing_forge, duplicate_forge, unknown_forge,
    missing_bible, duplicate_bible, unknown_bible} — all empty when the map is complete."""
    t = _table()
    out = {}
    for name, have, index in (("binder", binder_ids(), t["binder"]), ("forge", forge_keys(), t["forge"]),
                              ("bible", bible_keys(), t["bible"])):
        want = set(have)
        out[f"missing_{name}"] = sorted(k for k in want if k not in index)
        out[f"duplicate_{name}"] = sorted(k for k, cs in index.items() if len(cs) > 1)
        out[f"unknown_{name}"] = sorted(k for k in index if k not in want)
    return out


# ====================================================================== the sheet (Markdown, the web module)
def rows() -> list[dict]:
    """One row per field code, in order (for the Help page's table and the sheet)."""
    return [dict(e, section_code=e["section"]) for e in fields().values()]


def markdown() -> str:
    """The printable code-map sheet (docs/CODE_MAP.md)."""
    out = ["# Book Bible code map", "",
           "<!-- GENERATED by `python -m akowe.code_map --write` from akowe/akowe/code_map.py — do not edit by hand. -->",
           "",
           "Every detail of the Book Bible has a short code.", "",
           "- **Kind letter + section number + field letter** = one exact detail: `C1c` is a character's eyes.",
           "- **Kind letter + the section number twice** = a whole section: `C11` is all of a character's Looks.",
           "- Sections are numbered 0–9, so `C11` can never be confused with a two-digit section.",
           "- The binder numbers (“Show field numbers”, e.g. `5.2.8`) and the old Forge letters still work: "
           "Akọwe translates them.", "",
           "Kinds: " + " · ".join(f"**{k}** {v[0].lower()}" for k, v in KINDS.items()) + ".", "",
           "Old Forge letters: " + " · ".join(f"**{k}** {LETTER_NAMES[k]} → `{LETTER_SECTIONS[k]}`"
                                              for k in LETTER_NAMES) + ".", "",
           "Examples:", "",
           "- Needs list: `Mara C11, C33, C66 · Harbour tower P22, P33 · Brass key I22 · N11, N44`",
           "- A correction: `Chapter 9: Mara C1c (eyes) doesn't match — the sheet says grey, the book says brown.`",
           ""]
    t = _table()
    for kind, (kname, tpls, _f, _b) in KINDS.items():
        pages = f" (Book Bible page{'s' if len(tpls) > 1 else ''} {', '.join(tpls)})" if tpls else \
            " (the story ledger: updated after every chapter)"
        out += [f"## {kind}: {kname}{pages}", ""]
        for scode, sec in t["sections"].items():
            if sec["kind"] != kind:
                continue
            out += [f"### `{scode}` {sec['label']}", "", "| Code | Detail | Binder no. | Forge / ledger field |",
                    "|---|---|---|---|"]
            for c in sec["fields"]:
                e = t["fields"][c]
                src = ", ".join(e["forge"] + e["bible"] + [f"ledger {x}" for x in e["ledger"]]
                                + [f"series {x}" for x in e["series"]])
                out.append(f"| `{c}` | {e['label']} | {', '.join(e['binder']) or '—'} | {src or '—'} |")
            out.append("")
    return "\n".join(out).rstrip() + "\n"


def web_data() -> dict:
    """The compact map the web pages use (binder.js "Show codes", the ❓ Help code-map page)."""
    t = _table()
    return {"kinds": {k: v[0] for k, v in KINDS.items()},
            "sections": {s: [e["label"], e["fields"], e["binder_sections"]] for s, e in t["sections"].items()},
            "fields": {c: [e["label"], e["binder"], e["forge"] + e["bible"], e["ledger"]]
                       for c, e in t["fields"].items()},
            "fid": {b: cs[0] for b, cs in t["binder"].items()},
            "letters": {k: [LETTER_NAMES[k], LETTER_SECTIONS[k]] for k in LETTER_NAMES}}


def web_module() -> str:
    return ("/* 🔢 Book Bible code map. GENERATED by `python -m akowe.code_map --write` from akowe/code_map.py — do\n"
            "   not edit by hand (a test keeps it in sync). kinds: letter -> name; sections: code -> [label, field\n"
            "   codes, binder sections]; fields: code -> [label, binder ids, forge / 🆕 keys, ledger categories];\n"
            "   fid: binder field id -> code; letters: old Forge letter -> [name, section code]. */\n"
            "export const CODE_MAP = " + json.dumps(web_data(), ensure_ascii=False, separators=(",", ":")) + ";\n"
            "export const CODE_MAP_MD = " + json.dumps(markdown(), ensure_ascii=False) + ";\n")


ROOT = Path(__file__).resolve().parent
DOC_PATH = ROOT.parent.parent / "docs" / "CODE_MAP.md"
WEB_PATH = ROOT / "web" / "code-map.js"


def write_files() -> list[str]:
    DOC_PATH.write_text(markdown(), encoding="utf-8")
    WEB_PATH.write_text(web_module(), encoding="utf-8")
    return [str(DOC_PATH), str(WEB_PATH)]


if __name__ == "__main__":  # pragma: no cover
    import sys
    if "--write" in sys.argv:
        print("\n".join(write_files()))
    else:
        bad = {k: v for k, v in audit().items() if v}
        print(json.dumps(bad or {"ok": True, "codes": len(fields()), "sections": len(sections())}, indent=1))
