# 🗂 Character Forge dossiers (Akọwe side, plan item B5)

A deep, lettered profile per character, in the look of the author's **Moki Vey** sample: a dark dossier with the name
in gold, a teal tagline, a portrait with a 🎬 motion study (a short looping clip made from it), a ten-view reference
plate and 14 numbered sections of bordered cards. The
AutoInjector side (pictures) is `docs/SD_IMAGE_API.md`; this file is the Akọwe side. Code: `akowe/akowe/forge.py`
(model, storage, API, AI, art), `forge_pdf.py` (the PDF), `forge_example.py` (the Moki Vey example), `web/forge.js`
(the pages), tests `akowe/tests/test_forge.py`, `test_forge_clip.py` (motion clips) and
`tests/campaign/ui/test_ui_forge.py`.

## The dossier

* **14 sections** in the sample's order: 01 Character record · 02 Inner life · 03 Relationships and page essentials ·
  04 Voice card · 05 Detailed appearance · 06 Fighting style · 07 Weapons and possessions · 08 Mutation and magic
  rules · 09 Skills and abilities · 10 Physical capabilities · 11 Knowledge and expertise · 12 Chronological backstory ·
  13 Detailed storyline · 14 Continuity and reveal reference. 148 fields; keys are lowercase snake_case
  (`[a-z0-9_]{1,60}`), unique across sections (`forge.SECTIONS` / `GET …/forge/characters` → `fields`).
* **Letters** on every field (defaults from the sample, editable): C Canon · P Personality · V Voice · A Appearance ·
  F Fighting · M Magic · K Knowledge/skills · R Relationships · S Story development · E Essential on-page detail. The
  author's order is kept (`[S,P]`).
* **Status**: `supplied` (the author's own text, or the book's existing data), `proposed` (invented by the AI, not
  accepted yet), `approved` (a proposal the author accepted — or edited: ✎ Edit of a proposal approves it). An empty
  field has text `""` and status `supplied`. **Protected** fields are never touched by the AI.
* **Titled fields**: `relationship_1..6` and `backstory_1..8` carry a `title` (the bold label: "Imani Vey / CH-002",
  "2157-2166 / foundations"); the field's `label` is the title when there is one.
* **Readiness**: `ready` when the dossier has some text and no proposal waits, else `draft`.
* **Code and revision**: `CH-001` … per book (the lowest free number in the book's character order; fixed once the
  dossier is first saved). The revision starts at 1 and goes up with every author edit and approval (not with AI
  proposals or pictures). The last 12 changes are kept as history (what, by, fields, the old text of edited fields).
* Items (`AR-`), places (`PL-`) and magic systems (`MG-`) use the same machinery later (`forge.KINDS`); only
  characters are built now.

### One source of truth (no copies)

| Dossier field | Comes from | Editing it in the dossier |
|---|---|---|
| role, identity, traits, appearance, background, goals, constraints | the A01 canon record's attributes, when set | read-only, protected (change it on the character page); a dossier field of its own while the canon record has none |
| 02 inner life (wants … own_wish) | the character sheet | accepted text is written to the sheet |
| relationship_1..6 | the sheet's relationships (matched by name = title) | `tension` = the text (" History: …" splits off `history`) |
| must_show_1..5 ("Must reach the page") | the sheet's `must_show` | the list is rebuilt from the accepted fields |
| 04 voice card | the voice card (lists joined with "; ", samples one per line) | written back (split on ";", " / ", new lines) |
| speech_fear / speech_anger / speech_grief | the card's `under_pressure` ("Fear: … \| Anger: … \| Grief: …") | recomposed |

Proposals are never written through: the writer, the editor and the planned-to-page check only see accepted text. An
edit made later on the character page wins over the dossier's copy (the dossier remembers what it last wrote, `sync`).

Storage: settings key `forge:<project>:<branch>` = `{counters, records: {character: {<A01 record id>: entry}}}` —
companion data like the character sheets, so the book package and the book bible carry it. Pictures are book assets
(binary records, like uploads); so is the motion clip and its poster. Outbox event `forge.saved` (record, code, revision, what, by, number of fields; never
text).

## API (under `/api/projects/:pid/branches/:branch`)

| Route | Answer |
|---|---|
| `GET /forge/characters` | `{characters: [{record_id, name, kind, code, revision, readiness, has_portrait, views_done, has_sheet, has_clip, filled, proposed, total, tagline, portrait}], fields, image_bridge}` |
| `GET /forge/characters/:rid` | the dossier JSON (below) |
| `PUT /forge/characters/:rid` | body `{sections: {<section>: {<field>: {text?, letters?, protected?, title?}}}, tagline?, summary?, revision?}` → the dossier. `revision` = the one you edited (a newer one → 409 `VERSION_CONFLICT`). Canon-backed fields → 400 `LOCKED_FACT`. A relationship needs a title. |
| `POST /forge/characters/:rid/forge` | body `{slot_id?}` → 202 `{job_id, …}` ("Invent the rest") |
| `POST /forge/characters/:rid/approve` | body `{fields: [keys]}` (also `section.key`) or `{all: true}` → 200 `{ok, approved, message, readiness, revision, dossier}` — synchronous, no job |
| `POST /forge/characters/:rid/art` | body `{what: portrait\|views\|sheet, engine: auto\|sd\|chatgpt, views?: [...]}` → 202 `{job_id, …}`; `{what: "clip", engine: "auto"}` → 202 (the 🎬 motion clip; 400 `MISSING_INPUT` when there is no portrait or front view yet) |
| `PUT /forge/characters/:rid/art/:slot` | raw PNG/JPEG body (Content-Type image/png or image/jpeg); slot `portrait`, `sheet` or a view name → `{ok, slot, art, message}`. Slot `clip`: raw MP4/WebM (≤ 40 MB, checked from the bytes); slot `clip_poster`: PNG/JPEG first frame of the clip already there |
| `GET /forge/characters/:rid/pdf[?download=1]` | the dossier PDF |
| `POST /forge/example` | loads the Moki Vey example (201 `{record_id, created, dossier, message}`; again = the same one) |
| `GET\|PUT /api/settings/image-bridge` | `{url, token?}` → `{url, default_url, has_token, uses}` (never the token) |

Jobs are review jobs: poll `GET …/review/ai/:job_id` (or `GET …/forge/characters/:rid/jobs/:job_id`), stop with
`POST …/review/ai/:job_id/cancel`. A job answers `{job_id, status: queued|running|done|error|cancelled, phase, done,
total, results: [{message, …}], error: {code, message, fix}}`. An interrupted "Invent the rest" can be resumed from the
jobs list (it only fills what is still empty).

Dossier JSON:

```json
{ "record_id": "A01-…", "kind": "character", "name": "Moki Vey", "code": "CH-001", "revision": 1, "readiness": "draft",
  "tagline": "The man who holds the line", "summary": ["…", "…", "…"],
  "sections": [ { "key": "record", "n": 1, "title": "Character record",
      "fields": [ { "key": "supplied_canon", "label": "Supplied canon", "letters": ["C","A"], "text": "…",
                    "status": "supplied", "protected": true, "readonly?": true, "source?": "canon|sheet|voice",
                    "title?": "…", "by?": {"kind": "ai|author|example", "slot": "AI-1"} } ] } ],
  "art": { "portrait": {"asset_id": "I01-…", "version": 1, "mime": "image/png", "engine": "sd", "seed": 4001,
                        "source": "sd|chatgpt|upload|example", "url": "/api/projects/…/assets/I01-…/1"} | null,
           "views": { "front": {…} | null, "three_quarter_front": …, "side": …, "three_quarter_back": …, "back": …,
                      "idle": …, "draw": …, "attack": …, "dash": …, "defend": … },
           "sheet": {…} | null,
           "clip": {"asset_id": "I01-…", "version": 1, "mime": "video/mp4", "engine": "comfy-wan",
                    "model": "wan22-ti2v-5b", "seconds": 4, "fps": 24, "frames": 97, "width": 480, "height": 640,
                    "seed": 77, "source": "comfy-wan|upload", "url": "…",
                    "poster": {"asset_id": "I01-…", "mime": "image/png", "url": "…"} | null} | null },
  "counts": { "fields": 148, "filled": 146, "proposed": 145, "protected": 1, "views_done": 10 },
  "approved_character": false, "history": [ … ], "updated_at": "…" }
```

## ✨ Invent the rest

One AI call per section group (`forge.GROUPS`: record + inner life + relationships · voice + appearance · fighting +
weapons + magic · skills + physical + knowledge · backstory + storyline + continuity), only for groups with empty,
unprotected, writable fields — so web AIs never get one giant answer to write. The slot the author picked is used
(it never moves); otherwise AI-1 is preferred, then any working AI. Context: the character's canon, the book profile,
the other characters (names, codes, taglines), places, the story rules (≤ 2 500 chars) and the fields already filled
(≤ 9 000 chars, protected ones always). The answer must match a JSON schema of exactly the asked keys (the bridge's
JSON repair and re-asks apply), every value is clipped to 1 200 characters, and it fills only fields that are STILL
empty and unprotected when it arrives (the author may type meanwhile) — as `proposed`. The first group also writes
the tagline and the three cover lines when they are empty. A failing group stops the job with a plain message ("… the
N field(s) invented before this are kept as proposals").

## 🎨 Pictures (AutoInjector `POST /image/request`)

`{engine, purpose: "portrait"|"view"|"sheet", view?, prompt, characterLock: <name>, book, from: "akowe-forge",
returnImage: true, seed?}`. The prompt is the name + "Fixed visual anchors: …" + the supplied canon and the appearance
fields. The ten views go one request each; the seed the first view returned is sent with the other nine. The picture
comes from `images[]` (base64 strings or `{imageBase64|base64}`), else from a local file in `paths`/`images[].path`.
A `NO_LOCK` answer is retried once without `characterLock` (with a warning on the picture). Timeout 300 s per
request, always in a background job. Pictures already made are kept when a later one fails.

Where: Settings → 🎨 Pictures (`image_bridge` setting + the token in the local secret file); default
`$AKOWE_IMAGE_BRIDGE` or `http://127.0.0.1:8765` (AutoInjector's service bridge) with `$AUTOINJECTOR_BRIDGE_TOKEN`
or the AutoInjector AI slots' connection key; when that address is not reachable at all, the AI slots' bridge address
is tried too. Localhost only, never through a proxy.

Error codes (job `error.code`, plain words in `web/problems.js`): `SD_NOT_CONNECTED`, `CHATGPT_NOT_READY`,
`IMAGE_REFUSED` (ChatGPT's short reason in the message), `IMAGE_TIMEOUT`, `IMAGE_LIMIT`, `NO_IMAGE_ENGINE`, plus
Akọwe's own `IMAGE_BRIDGE_UNREACHABLE`, `IMAGE_BRIDGE_KEY` (401), `IMAGE_NOT_WIRED` (404), `IMAGE_BAD_ANSWER`.
The bridge's own `hint` becomes the "how to fix it".

## 🎬 Motion clip (AutoInjector `POST /video/request`)

A short picture→video "motion study" per dossier (contract: `docs/VIDEO_API.md`, the engine side). `POST …/art`
`{what: "clip", engine: "auto"}` starts a job (`forge_clip`) that:

* takes the **portrait**, else the **front view** (none → 400 before any job: "make or upload the portrait first"), and
  writes it to a temp file (`akowe-clip-*/portrait.png|.jpg`, removed when AutoInjector has answered) — the path is
  sent, never the bytes, because the bridge body limit is 1 MB;
* builds the prompt: the name + `Appearance:` / `Posture:` / `Gait:` / `Expressions:` (the `appearance`, `posture`,
  `gait` and `presence` fields, ≤ 300 characters each) + the fixed words "subtle idle motion, breathing, cloth moving,
  camera still" (always kept; ≤ 1 200 characters in all);
* sends `{image, prompt, seconds: 4, purpose: "clip", from: "akowe-forge", returnPoster: true, book?}` — no `engine`
  (AutoInjector picks its video backend) and no `characterLock` (the picture already fixes the looks) — with a
  **900 s** timeout, same bridge address and token as the pictures (Settings → 🎨 Pictures);
* reads the clip from the answer's local `path` (`.mp4` preferred, `.webm`; AutoInjector runs on the same computer;
  ≤ 40 MB, checked from the bytes) and the poster from the `returnPoster` base64 (`posterBase64` / `poster_base64` /
  `posterImage` / a `data:` URL), else the local `poster` file. No poster at all → the source picture is the poster
  (picture→video starts from it), with a warning;
* stores both as book assets and the clip in the dossier's `art.clip` (engine, model, seconds, fps, frames, size,
  seed, `made_from`); pictures and clips never bump the revision.

**Stop** works while AutoInjector is still working: Akọwe lets go at once and ignores the late answer.

Error codes (job `error.code`; plain words here and in `web/problems.js`; for these Akọwe's own fix is always shown,
the bridge's message only as the reason, first line only):

| Code | Fix shown |
|---|---|
| `VIDEO_NOT_SET_UP` | In AutoInjector's 🎬 Video tab, set up video (it uses the ComfyUI of 🎨 Images) … or upload your own clip. |
| `VIDEO_MODEL_MISSING` | In AutoInjector's 🎬 Video tab, download the video model (one click) … (the model id goes in the message) |
| `VIDEO_OOM` | Close other programs that use the graphics card (Stable Diffusion too) … about 12 GB of graphics memory. |
| `VIDEO_TIMEOUT` | Try again: the first clip after a start loads the video model … (also Akọwe's own 900 s timeout) |
| `VIDEO_CANCELLED` | Press Make the motion clip again when you are ready. |
| `VIDEO_FAILED` | Try again … or make the clip in AutoInjector's 🎬 Video tab and upload it here. |
| `UNSUPPORTED_ON_BACKEND` | Switch to the built-in ComfyUI video, or upload your own clip. |
| `VIDEO_NOT_WIRED` (Akọwe: 404) | Update AutoInjector to a version with 🎬 Video, or upload your own clip. |
| `VIDEO_BAD_ANSWER` (Akọwe) | No readable MP4/WebM came back: try again, or make it in 🎬 Video and upload it. |

The key and reachability codes are the pictures' (`IMAGE_BRIDGE_KEY`, `IMAGE_BRIDGE_UNREACHABLE`).

**Your own clip:** `PUT …/art/clip` (MP4/WebM, ≤ 40 MB, the type is checked from the bytes, not the label). The page
then grabs the clip's first frame in the browser and sends it as `PUT …/art/clip_poster` (best effort: without a
poster the PDF simply leaves the still out). Akọwe itself still needs no video or image library.

## The PDF

Pure Python (`exporters/pdf.py` gained per-page sizes, full-page background colours, filled/stroked rectangles, lines
and coloured text; `exporters/layout.Page` has `size` and `background`). Page 1: the cover (US Letter). With a motion
clip that has a poster, the portrait moves to the left margin and the poster stands beside it, bottom-aligned, as a
small gold-framed still under a teal "MOTION STUDY" label ("4-second loop, first frame"); the page count and every
other page stay the same, and without a clip page 1 is unchanged. Page 2: "NAME /
TEN-VIEW REFERENCE" in landscape (A4) — the turnaround sheet when there is one, else the 5 × 2 grid with labels and
quiet placeholders. Then the sections: header "CHARACTER FORGE / NAME / PROPOSED CHARACTER DETAILS" (just "CHARACTER
DETAILS" when ready), gold numbered headings, one bordered card per filled field (`[letters]` teal, bold label, text),
a card split cleanly across pages when it does not fit, never into the footer. Every page: the letter legend and
"CH-001 | REV n | DRAFT|READY | page". Text outside WinAnsi loses its accents (Ọlá → Ola).

## Chapter prompts (letters)

`chapter_brief.build` adds `character_details` (rule "character_details"): for each character present, the ACCEPTED
dossier fields whose letters the chapter needs — E always, A on the character's first appearance (no earlier outline
chapter mentions them), F / M when the chapter's plan reads like a fight / powers. Fields the brief already carries
(sheet, voice card, canon attributes, must-show) are left out. ≤ 2 500 characters; off with the pipeline's voices
switch.

## The web pages

`#/p/<pid>/<branch>/forge` (the list: portrait tiles, code, readiness, progress; "🧪 Load the Moki Vey example") and
`#/p/<pid>/<branch>/forge/<record_id>` (the dossier). Entry points: "🗂 Character Forge" on every character's card and
in More ▾. The page: hero portrait (🎨 Stable Diffusion / 💬 ChatGPT / ⬆ Upload), gold name, teal tagline, cover
lines, counts, ✨ Invent the rest (with the AI choice), ✔ Approve all proposals, ⬇ Dossier PDF, ✎ Edit the cover;
under the portrait the **🎬 Motion study**: a `<video>` (loop, muted, playsinline, controls, the poster as
placeholder; autoplay unless the reader prefers reduced motion) with "🎬 Make the motion clip" (needs the portrait or
front view) and "⬆ Upload a clip" (MP4/WebM, size checked before sending) and its own progress line while the job
runs (the page's CSP allows `media-src 'self' blob:` for it); the ten-view plate with a slot per view (and all ten at once, or one ChatGPT turnaround sheet); a sticky letter filter
(click letters to show only those cards; show/hide empty fields); a section index; cards with "proposed" badges, ✔
Approve / ✎ Edit, 🔒 for protected fields, 📘/🎭/🗣 for text shared with the canon record / sheet / voice card.
Styles are scoped under `.forge` in `style.css`.

## The Moki Vey example

`akowe/akowe/examples/moki_vey/`: `dossier.json` (the sample's text parsed into the field keys; the supplied canon
supplied + protected, everything else proposed, as in the sample) and JPEG copies of the portrait (640 × 960) and the
ten views (≈ 307 × 512), downscaled once with Pillow when the example was made — the app itself needs no image library.
The author's own sample, used with permission.

## Not done yet

* Items, places and magic systems (the machinery is there: `KINDS`, codes `AR-`/`PL-`/`MG-`).
* The dossier is not yet checked against the manuscript (the sample's "verification pending").
* A real ChatGPT/Stable Diffusion run against the other agent's finished `/image/request` (tested against a fake bridge
  that follows the contract).
* A real GPU run of the motion clip against AutoInjector's finished `/video/request` (tested against a fake bridge
  that follows the video contract). Clips for items, places and magic systems.
