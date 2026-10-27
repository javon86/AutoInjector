"""🗂 The section and field lists of the item (AR-), place (PL-) and magic-system (MG-) dossiers (plan item B5).

The ONE place where these dossiers' sections and fields are named, in the same "Character Forge" idea as the character
dossier (``forge.SECTIONS``): numbered sections of lettered fields. The letters are the character dossier's
(C Canon · P Personality · V Voice · A Appearance · F Fighting · M Magic · K Knowledge/skills · R Relationships ·
S Story development · E Essential on-page detail), so a chapter prompt can take only the letters it needs, whatever the
kind. Keys are lowercase snake_case, unique within a kind.
"""
from __future__ import annotations

from .forge import KEY_RE, _f

# ====================================================================== items (AR-)
ITEM_SECTIONS = (
    ("record", "Item record", [
        _f("supplied_canon", "Supplied canon", "CA", "the author's own fixed description; usually protected"),
        _f("proposed_additions", "Proposed additions", "CS", "say plainly which details below are invented proposals"),
        _f("name", "Name and aliases", "C", "the name, other names and who uses each"),
        _f("item_type", "Type and class", "CK", "what kind of thing it is: tool, weapon, relic, device, document"),
        _f("purpose", "Purpose", "CS", "what it was made for"),
        _f("one_line", "One-line description", "CE", "the item in one sentence a reader would remember"),
        _f("status_now", "Current state", "CS", "where it is and what state it is in at the story's opening"),
        _f("significance", "Story significance", "S", "why the story needs this object"),
        _f("record_controls", "Record controls", "CS", "code / revision / effective story time; what is protected"),
    ]),
    ("appearance", "Appearance and materials", [
        _f("overall_look", "Overall look", "A", "the look in two sentences"),
        _f("size_weight", "Size and weight", "AC", "length, width and weight in metric and imperial"),
        _f("shape", "Shape and silhouette", "A"),
        _f("materials", "Materials", "AK", "what it is made of, outside and inside"),
        _f("colours", "Colours and finish", "A"),
        _f("markings", "Markings, inscriptions and wear", "AC", "serial numbers, symbols, scratches, repairs"),
        _f("sound_smell", "Sound, smell and feel", "AE", "what it sounds, smells and feels like in the hand"),
        _f("condition", "Condition", "AS", "new, worn, damaged, repaired"),
        _f("visual_anchors", "Fixed visual anchors", "CA", "what must look the same in every picture and scene"),
    ]),
    ("history", "History and provenance", [
        _f("origin", "Origin and maker", "CK", "who made it"),
        _f("made_when", "When and where it was made", "C", "a year and a place"),
        _f("made_how", "How it was made", "K"),
        _f("previous_owners", "Previous owners", "CR", "names / CH- codes, with years"),
        _f("key_events", "Key events in its past", "CS"),
        _f("legends", "Legends and rumours", "KS", "what people say about it, true or not"),
        _f("how_acquired", "How the current holder got it", "RS"),
        _f("provenance_gaps", "What nobody knows about it", "KS"),
    ]),
    ("powers", "Powers and limits", [
        _f("abilities", "What it can do", "MK", "or 'None: an ordinary object' when it has no special powers"),
        _f("how_it_works", "How it works", "MK"),
        _f("activation", "Activation and control", "M"),
        _f("limits", "Hard limits", "MC", "numbers: range, duration, uses per day, load"),
        _f("costs", "Costs to the user", "M"),
        _f("weaknesses", "Weaknesses and counters", "MF"),
        _f("side_effects", "Side effects", "MS"),
        _f("cannot_do", "What it can never do", "MC"),
        _f("linked_system", "Magic system or technology", "MC", "the MG- code when it runs on a magic system"),
    ]),
    ("use", "Use and maintenance", [
        _f("who_can_use", "Who can use it", "KR", "anyone, a trained user, one bloodline, only its owner"),
        _f("skill_needed", "Skill or training needed", "K"),
        _f("handling", "Handling and carrying", "AF", "where it is carried, how it is held"),
        _f("combat_use", "Use in a fight", "F", "character beats, never real fighting instructions"),
        _f("everyday_use", "Everyday use", "K"),
        _f("maintenance", "Maintenance and care", "K"),
        _f("damage", "Damage, repair and destruction", "KS", "what can break it, and what can never"),
        _f("legal", "Legal and social standing", "KS", "is it legal, licensed, feared, envied"),
        _f("signature_use", "Signature use on the page", "E", "the gesture that shows it in a scene"),
    ]),
    ("ownership", "Ownership", [
        _f("owner", "Rightful owner", "RC", "name / CH- code"),
        _f("current_holder", "Current holder", "RC", "who has it at the story's opening: name / CH- code"),
        _f("allowed_users", "Who may hold or use it", "RC", "names / CH- codes; the manuscript check uses this list"),
        _f("forbidden_users", "Who must never have it", "RS", "names / CH- codes"),
        _f("who_wants_it", "Who wants it and why", "RS"),
        _f("transfers", "Changes of hands in the story", "RS", "chapter by chapter: from whom to whom"),
        _f("bond", "Bond with its holder", "RP"),
        _f("value", "Value and price", "K"),
    ]),
    ("appearances", "Appearances in the story", [
        _f("first_appearance", "First appearance", "SE", "chapter and moment"),
        _f("introduction", "How it is introduced", "SE"),
        _f("key_scenes", "Key scenes", "S"),
        _f("turning_point", "Turning point", "S"),
        _f("final_state", "Where it ends up", "S"),
        _f("reveal_points", "Reader reveal points", "SE"),
        _f("must_show_1", "Must reach the page 1", "EA", "a concrete detail the reader must see on the page"),
        _f("must_show_2", "Must reach the page 2", "EM"),
        _f("must_show_3", "Must reach the page 3", "ES"),
    ]),
    ("continuity", "Continuity ledger", [
        _f("location_ledger", "Where it is, chapter by chapter", "CS"),
        _f("condition_ledger", "Condition and damage ledger", "CS"),
        _f("uses_ledger", "Uses and charges ledger", "CM"),
        _f("secrets_ledger", "Secrets and who knows", "KS"),
        _f("linked_records", "Linked record references", "CR", "codes like CH-001, PL-001, MG-001"),
        _f("unresolved_choices", "Unresolved choices", "CS"),
        _f("artwork_note", "Artwork note", "CE"),
        _f("verification_scope", "Verification scope", "CE"),
    ]),
)

# ====================================================================== places (PL-)
PLACE_SECTIONS = (
    ("overview", "Place record", [
        _f("supplied_canon", "Supplied canon", "CA", "the author's own fixed description; usually protected"),
        _f("proposed_additions", "Proposed additions", "CS", "say plainly which details below are invented proposals"),
        _f("name", "Name and other names", "C", "the name, nicknames and what outsiders call it"),
        _f("place_type", "Kind of place", "CK", "city, district, ship, house, forest, room"),
        _f("one_line", "One-line description", "CE"),
        _f("setting_time", "Where and when", "CK", "region or world, era and year"),
        _f("role_in_story", "Role in the story", "S"),
        _f("first_impression", "First impression", "AE", "what a newcomer notices first"),
        _f("record_controls", "Record controls", "CS", "code / revision / effective story time; what is protected"),
    ]),
    ("geography", "Geography and layout", [
        _f("location", "Location and surroundings", "CK"),
        _f("size_scale", "Size and scale", "AC", "numbers: area, height, population density"),
        _f("layout", "Layout", "AK", "how it is laid out, level by level or street by street"),
        _f("landmarks", "Landmarks", "AE"),
        _f("districts", "Districts, rooms or zones", "AK"),
        _f("terrain", "Terrain and climate", "AK"),
        _f("architecture", "Architecture and materials", "A"),
        _f("map_notes", "Map notes", "CK", "directions and distances: what lies north of what"),
    ]),
    ("atmosphere", "Atmosphere and senses", [
        _f("sights", "Sights", "AE"),
        _f("sounds", "Sounds", "E"),
        _f("smells", "Smells", "E"),
        _f("touch", "Touch, temperature and air", "E"),
        _f("light", "Light by day and by night", "AE"),
        _f("mood", "Mood", "PE"),
        _f("seasons", "Seasons and weather", "AK"),
        _f("signature_detail", "Signature sensory detail", "E", "the one detail that tells the reader where they are"),
    ]),
    ("history", "History", [
        _f("founding", "Founding and origin", "C", "who founded it, and the year"),
        _f("eras", "Eras and turning points", "CS"),
        _f("key_events", "Key events", "CS"),
        _f("ruins", "Ruins and traces of the past", "AK"),
        _f("recent_change", "Recent change", "S", "what changed just before the story starts"),
        _f("myths", "Myths and local stories", "KS"),
        _f("timeline_facts", "Dates and numbers", "C", "founding year, population by year: numbers that must not drift"),
    ]),
    ("people", "People and factions", [
        _f("population", "Population and who lives here", "KC"),
        _f("factions", "Factions and power", "RS"),
        _f("rulers", "Who is in charge", "RC", "names / CH- codes"),
        _f("economy", "Economy and trade", "K"),
        _f("culture", "Customs and culture", "K"),
        _f("language", "Speech and dialect", "V", "words and phrases people here use"),
        _f("notable_people", "Notable residents", "R", "names / CH- codes"),
        _f("outsiders", "How outsiders are treated", "RP"),
    ]),
    ("rules", "Rules and dangers", [
        _f("laws", "Laws and rules", "KC"),
        _f("dangers", "Dangers", "F"),
        _f("hazards", "Natural hazards", "FK"),
        _f("forbidden", "Forbidden places and acts", "KS"),
        _f("magic_here", "Magic and technology here", "MC", "MG- codes of the systems that work here"),
        _f("defences", "Defences and security", "FK"),
        _f("safe_havens", "Safe places", "F"),
    ]),
    ("routes", "Routes and connections", [
        _f("access", "How to get in and out", "KF"),
        _f("routes", "Routes to other places", "K", "PL- codes, the means and the travel time"),
        _f("travel_times", "Travel times and distances", "C", "numbers that must not drift"),
        _f("hidden_ways", "Hidden ways", "KS"),
        _f("transport", "Transport", "K"),
        _f("borders", "Borders and checkpoints", "F"),
    ]),
    ("appearances", "Appearances in the story", [
        _f("first_appearance", "First appearance", "SE", "chapter and moment"),
        _f("scenes_set_here", "Scenes set here", "S"),
        _f("how_it_changes", "How it changes over the story", "S"),
        _f("characters_here", "Characters tied to it", "R", "names / CH- codes: born here, live here, work here"),
        _f("reveal_points", "Reader reveal points", "SE"),
        _f("must_show_1", "Must reach the page 1", "EA", "a concrete detail the reader must see on the page"),
        _f("must_show_2", "Must reach the page 2", "EK"),
        _f("must_show_3", "Must reach the page 3", "ES"),
    ]),
    ("continuity", "Continuity ledger", [
        _f("fixed_anchors", "Fixed visual anchors", "CA", "what must look the same in every picture and scene"),
        _f("state_ledger", "State and damage ledger", "CS", "what is broken, flooded, closed, chapter by chapter"),
        _f("occupancy_ledger", "Who is where", "CR"),
        _f("secrets_ledger", "Secrets and who knows", "KS"),
        _f("linked_records", "Linked record references", "CR", "codes like CH-001, AR-001, MG-001"),
        _f("unresolved_choices", "Unresolved choices", "CS"),
        _f("artwork_note", "Artwork note", "CE"),
        _f("verification_scope", "Verification scope", "CE"),
    ]),
)

# ====================================================================== magic systems (MG-)
MAGIC_SECTIONS = (
    ("source", "Source and nature", [
        _f("supplied_canon", "Supplied canon", "CM", "the author's own fixed rules; usually protected"),
        _f("proposed_additions", "Proposed additions", "CS", "say plainly which details below are invented proposals"),
        _f("name", "Name and other names", "C", "the name and what different people call it"),
        _f("kind_of_power", "Kind of system", "MC", "magic, mutation, science, faith, bargain"),
        _f("source", "Where the power comes from", "MC"),
        _f("nature", "What it is", "MK"),
        _f("one_line", "One-line description", "CE"),
        _f("record_controls", "Record controls", "CS", "code / revision / effective story time; what is protected"),
    ]),
    ("access", "Access and cost", [
        _f("who_has_it", "Who can use it", "MR"),
        _f("how_gained", "How it is gained", "MK", "born with it, learned, granted, caught"),
        _f("activation", "Activation and method", "M"),
        _f("cost", "Cost of use", "M", "numbers: what every use takes"),
        _f("recovery", "Recovery", "M", "how long it takes, and what it needs"),
        _f("price_long", "Long-term price", "MS"),
        _f("rarity", "How rare it is", "MK"),
    ]),
    ("rules", "Rules and hard limits", [
        _f("core_rules", "Core rules", "MC"),
        _f("hard_limits", "Hard limits", "MC", "numbers: duration, range, uses and how often; the check reads them"),
        _f("range_duration", "Range and duration", "M"),
        _f("cannot_do", "What it can never do", "MC"),
        _f("counters", "Counters and protections", "MF"),
        _f("exceptions", "Exceptions (bounded)", "MC", "every exception with its own limit"),
        _f("interactions", "Interactions with technology and other powers", "MK"),
    ]),
    ("practitioners", "Practitioners and training", [
        _f("practitioners", "Known practitioners", "R", "names / CH- codes"),
        _f("training", "Training and learning", "K"),
        _f("ranks", "Ranks and levels", "K"),
        _f("schools", "Schools, orders and traditions", "KR"),
        _f("mastery", "What mastery looks like", "K"),
        _f("beginners", "Beginner mistakes", "KS"),
    ]),
    ("powers", "Named powers and techniques", [
        _f("named_power_1", "Named power 1", "MF", "Name: what it does and what it cannot do"),
        _f("named_power_2", "Named power 2", "MK"),
        _f("named_power_3", "Named power 3", "MF"),
        _f("named_power_4", "Named power 4", "MK"),
        _f("combinations", "Combinations", "MF"),
        _f("rituals", "Rituals and tools", "MK", "AR- codes of items it needs"),
    ]),
    ("signs", "Visible and sensory signs", [
        _f("visual_signs", "What it looks like", "MA"),
        _f("sounds_smells", "Sounds, smells and feel", "ME"),
        _f("on_the_body", "Marks on the body", "AM"),
        _f("environment_signs", "Effects on surroundings", "ME"),
        _f("tells", "Tells before use", "ME", "the warning a reader can learn to see"),
        _f("sigil", "Sigil or emblem", "AC", "the symbol that stands for it"),
    ]),
    ("failure", "Failure and backlash", [
        _f("failure_conditions", "Failure conditions", "MS"),
        _f("backlash", "Backlash", "MF"),
        _f("overuse", "Overuse", "M"),
        _f("misuse", "Misuse and corruption", "MS"),
        _f("worst_case", "Worst case", "MS"),
    ]),
    ("history", "History and lore", [
        _f("origin_story", "Origin", "CK"),
        _f("discovery", "Discovery and first use", "CS", "who, where and the year"),
        _f("key_events", "Key events", "CS"),
        _f("lore", "Lore, myths and misreadings", "KS"),
        _f("lost_knowledge", "Lost knowledge", "KS"),
    ]),
    ("society", "Society's view", [
        _f("public_view", "What ordinary people think", "KP"),
        _f("law", "Laws and control", "KC"),
        _f("institutions", "Who controls it", "RS"),
        _f("prejudice", "Fear, prejudice and status", "RP"),
        _f("economy", "Trade and economy", "K"),
    ]),
    ("appearances", "Appearances in the story", [
        _f("first_use", "First use on the page", "SE", "chapter and moment"),
        _f("key_uses", "Key uses", "S"),
        _f("escalation", "How use escalates", "S"),
        _f("climax_use", "Use at the climax", "S"),
        _f("reveal_points", "Reader reveal points", "SE"),
        _f("must_show_1", "Must reach the page 1", "EM", "a concrete detail the reader must see on the page"),
        _f("must_show_2", "Must reach the page 2", "EA"),
        _f("must_show_3", "Must reach the page 3", "ES"),
    ]),
    ("continuity", "Continuity ledger", [
        _f("power_ledger", "Use ledger", "CM", "uses and costs paid, chapter by chapter; no reset at a scene cut"),
        _f("rules_ledger", "Rules stated on the page", "CM"),
        _f("secrets_ledger", "Secrets and who knows", "KS"),
        _f("linked_records", "Linked record references", "CR", "codes like CH-001, AR-001, PL-001"),
        _f("unresolved_choices", "Unresolved choices", "CS"),
        _f("artwork_note", "Artwork note", "CE"),
        _f("verification_scope", "Verification scope", "CE"),
    ]),
)


def _art(hero, hero_label, hero_purpose, views, plate_title):
    return {"hero": hero, "hero_label": hero_label, "hero_purpose": hero_purpose,
            "views": tuple(views), "plate_title": plate_title}


# kind -> everything that differs between the kinds (the machinery is shared: forge_kinds.py)
SPECS = {
    "item": {
        "prefix": "AR", "word": "item", "Word": "Item", "plural": "items", "segment": "items", "icon": "🗡",
        "forge": "ITEM FORGE", "sections": ITEM_SECTIONS,
        "groups": (("record", "appearance", "history"), ("powers", "use", "ownership"), ("appearances", "continuity")),
        "art": _art("portrait", "ITEM PORTRAIT", "portrait",
                    (("front", "FRONT", "illustration"), ("side", "SIDE", "illustration"),
                     ("back", "BACK", "illustration"), ("detail", "DETAIL", "illustration")),
                    "TURNAROUND REFERENCE"),
        "appearance_keys": ("supplied_canon", "overall_look", "size_weight", "shape", "materials", "colours",
                            "markings", "condition"),
        "anchor_key": "visual_anchors",
        "source_ops": ("A12",),
    },
    "place": {
        "prefix": "PL", "word": "place", "Word": "Place", "plural": "places", "segment": "places", "icon": "🏙",
        "forge": "PLACE FORGE", "sections": PLACE_SECTIONS,
        "groups": (("overview", "geography", "atmosphere"), ("history", "people", "rules"),
                   ("routes", "appearances", "continuity")),
        "art": _art("establishing", "ESTABLISHING SHOT", "scene",
                    (("day", "DAY", "scene"), ("night", "NIGHT", "scene"), ("interior", "INTERIOR / DETAIL", "scene")),
                    "MOOD VIEWS"),
        "appearance_keys": ("supplied_canon", "one_line", "first_impression", "size_scale", "layout", "landmarks",
                            "terrain", "architecture", "sights", "light"),
        "anchor_key": "fixed_anchors",
        "source_ops": ("A04",),
    },
    "magic": {
        "prefix": "MG", "word": "magic system", "Word": "Magic system", "plural": "magic systems",
        "segment": "magic", "icon": "✴", "forge": "MAGIC FORGE", "sections": MAGIC_SECTIONS,
        "groups": (("source", "access", "rules", "practitioners"), ("powers", "signs", "failure"),
                   ("history", "society", "appearances", "continuity")),
        "art": _art("sigil", "SIGIL", "illustration", (("in_use", "IN USE", "scene"),), "IN USE"),
        "appearance_keys": ("supplied_canon", "visual_signs", "sounds_smells", "on_the_body", "environment_signs",
                            "tells"),
        "anchor_key": "sigil",
        "source_ops": ("A09",),
    },
}
for _k, _s in SPECS.items():
    _s["kind"] = _k
    _s["fields"] = {f["key"]: dict(f, section=sec[0]) for sec in _s["sections"] for f in sec[2]}
    assert len(_s["fields"]) == sum(len(sec[2]) for sec in _s["sections"]), f"{_k}: field keys must be unique"
    assert all(KEY_RE.match(k) for k in _s["fields"]), _k
    assert {s for g in _s["groups"] for s in g} == {sec[0] for sec in _s["sections"]}, f"{_k}: every section in a group"
    _s["section_keys"] = tuple(sec[0] for sec in _s["sections"])
    _s["slots"] = (_s["art"]["hero"],) + tuple(v[0] for v in _s["art"]["views"])
SEGMENTS = {"characters": "character", **{s["segment"]: k for k, s in SPECS.items()}}
