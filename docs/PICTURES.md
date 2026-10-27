# 🖼 Pictures: chapter and scene illustrations and the map (plan item B3, interior pictures)

Akọwe's **🖼 Pictures** page (`#/p/<pid>/<b>/pictures`, More → 🖼 Pictures, and 🖼 Illustrate on a chapter's scene
cards page) gives a book its pictures: one per chapter or per scene card, a map of the book's world, and their
placement in the PDF, EPUB and DOCX exports. Code: `akowe/akowe/pictures.py`, `akowe/akowe/web/pictures.js`, the
interior placement in `akowe/akowe/exporters/` (`book.place_pictures`, `layout`, `pdf`, `epub`, `docx`) and one hook
each in `modules/set_g.py` (`assemble`), `book_path.py` (`a_assemble`, `assembly_out_of_date`), `book_save.py` and
`server.py`. The cover is a separate feature (`docs/COVERS.md`).

## What the author does

1. **Art style** — set once per book (“ink wash”, “painterly”, “manga” …). Every picture is made in it.
2. **🖼 Illustrate** a chapter (or one of its scene cards): 1, 2 or 3 candidates, with Stable Diffusion, ChatGPT or
   automatic. With one candidate it is used at once; with more, the author clicks the one to use. **⬆ Upload** adds
   the author's own PNG/JPEG (used at once). **👁 Prompt** shows exactly what is sent.
3. Per picture: **caption**, **alt text**, **where in the book** — a page of its own before the chapter, under the
   chapter heading, after scene *n*, or at the end of the chapter — **Leave out** (no picture in the book) and
   **🗑 Remove**.
4. **🗺 Map** — drawn from the places (SVG), made as an illustrated map, or uploaded. By default on a page of its
   own before chapter 1.
5. **🖼 Illustrate every chapter** — a job with progress and **Stop**: one picture per chapter that has no picture
   in the book yet (chapters with one are skipped; what was made before Stop is kept).
6. Put the book together again (📘 Make my book) and export: the page and the book page say when the pictures
   changed since the book was put together.

## The prompt

`pictures.build_prompt` (at most **1 200 characters**, plain sentences):

```
Art style: <style>. Book illustration for chapter <n>[, scene <k>]: <the key moment>. Setting: <place>, <time>.
Characters: <Name> (<approved look>); <Name> (<approved look>). Character lock: <main character>.
Keep every character's look exactly as described. No text, letters, captions or watermark in the picture.
```

* **The scene card** (scenes.py): place, time, who is there and the key moment (“what changes”, else the beat). A
  chapter picture uses the chapter's objective as the moment and its first card's place and time. Without cards: the
  chapter plan (POV, location, objective).
* **Approved looks** (Character Forge, forge.py): Fixed visual anchors first, then the appearance fields — only text
  that is the author's own or approved, never an AI proposal. Each character's look is shortened so that every
  present character keeps a place in the prompt.
* **Character lock**: the POV character when present, else the first present character. It goes in the request as
  `characterLock`; when AutoInjector has no lock with that name (`NO_LOCK`) the picture is made from the prompt alone
  and the candidate carries the warning.

## API (under `/api/projects/:pid/branches/:b`)

| Call | What |
|---|---|
| `GET /pictures` | `{style, styles, revision, chapters: [{chapter_id, number, title, objective, scenes, cards, state, pictures}], map, places, counts, where, max_count, out_of_date, image_bridge}` |
| `PUT /pictures/style {style}` | the book's art style (≤ 120 characters) |
| `GET /pictures/prompt?chapter=…&scene=…` | `{prompt, lock, characters}` (the preview) |
| `POST /pictures/illustrate {chapter_id, scene?, engine, count?}` | 202 `{job_id, pic_id, …}`; `count` 1-3 candidates |
| `POST /pictures/illustrate-all {engine}` | 202 `{job_id}`: the batch (Stop = `POST /review/ai/:job/cancel`) |
| `PUT /pictures/:pic_id {caption?, alt?, placement?: {where, scene?}, chosen?}` | `chosen` = candidate index or `null` |
| `DELETE /pictures/:pic_id` | remove the picture (its files stay in the book's assets) |
| `POST /pictures/map {kind: "svg"}` | 200: the map drawn from the places |
| `POST /pictures/map {kind: "illustrated", engine}` | 202 job (`purpose: "map"`) |
| `PUT /pictures/upload?chapter=<id>\|map[&scene=n]` | the PNG/JPEG bytes; added and chosen |

Jobs are polled with `GET /review/ai/:job_id` (or `GET /pictures/jobs/:job_id`) like the Character Forge's art jobs:
`{status, phase, done, total, pic_id, results, error: {code, message, fix}}`. Every `/image/request` error code is
the Character Forge's (`forge.ART_PROBLEMS`: `SD_NOT_CONNECTED`, `CHATGPT_NOT_READY`, `IMAGE_REFUSED`,
`IMAGE_TIMEOUT`, `IMAGE_LIMIT`, `NO_IMAGE_ENGINE`, `IMAGE_BRIDGE_UNREACHABLE`, `IMAGE_BRIDGE_KEY`, `IMAGE_NOT_WIRED`,
`IMAGE_BAD_ANSWER`, `NO_LOCK`), with a plain fix; pictures made before a failure are kept.

The request to AutoInjector: `{engine, purpose: "illustration" | "map", prompt, characterLock?, book, from:
"akowe-pictures", returnImage: true}` (`docs/SD_IMAGE_API.md`).

## Storage

Companion data `pictures:<pid>:<branch>` = `{style, revision, counter, pictures: {pic-001: {id, kind:
chapter|map, chapter_id, scene, candidates: [{asset_id, version, mime, source, engine, seed, at, warnings}], chosen,
caption, alt, placement: {where, scene}, prompt, created_at, updated_at}}}`. Candidates are book assets (binary I01
records, like uploads); at most 6 per picture (the chosen one is always kept). Outbox events `pictures.*` carry
numbers only. The book package (book.akowe) carries the setting and the assets.

## Placement in the exports

“Put the book together” (`book_path.a_assemble`) freezes the chosen pictures in a snapshot keyed by that assembly's
G02 record (`pictures_snap:<pid>:<branch>:<G02 id>`, `pictures.snapshot`) and remembers its signature. Every G step
that builds the book model (`set_g.assemble`: G01 checks, G04 pagination, G07 contents, G11/G12/G13 exports) places
that same snapshot (`pictures.overlay` → `exporters/book.place_pictures`), so the TOC page numbers, the pagination
check and the three files agree. A change on the Pictures page afterwards makes the assembly out of date (“The
pictures changed since the book was put together …”).

* Block `{"t": "img", id, key, w_mm, h_mm, fit, caption?, alt?}`; a picture “before” the chapter is a **plate**
  section (`kind: "plate"`: no heading, not in the contents or the EPUB navigation).
* **PDF**: the picture scaled into its box (never wider than the text, never taller than the page), the caption
  under it in italics; a plate is centred on its page.
* **EPUB**: `<figure><img alt=…/><figcaption>…</figcaption></figure>`; a plate is its own XHTML file.
* **DOCX**: an inline drawing (alt text in `descr`) and a “caption” paragraph; a plate starts a new page.
* The pictures are the author's own interior art, separate from the G03 placement of approved Set D assets: the
  output profiles' `artwork_selected` stays as it is.

## The SVG map — decision

The exporters accept JPEG/PNG only and Akọwe has no Pillow at runtime, so the SVG is **never rasterised**:

* the map is `d_maps.render_svg` of the places (A04): their own `x.map.x` / `x.map.y` coordinates when they have
  them (`d_maps.extract_graph`), else a deterministic route in story order (the order the chapters and scene cards
  first visit the places, joined by the route). The viewBox is widened so the names are not cut off;
* **EPUB**: the SVG itself (`image/svg+xml` is an EPUB 3 core media type) in a `<figure>`;
* **PDF**: drawn with vector operations from the SVG (`d_maps.read_svg`): a parchment frame, the routes as lines,
  each place as a dot (a new `circle` op in the PDF writer) with its name; characters the base-14 fonts lack are
  printed as their plain letters (`layout.winansi`);
* **DOCX**: not drawn (Word needs a PNG copy of an SVG); the caption is followed by “the map is in the PDF and EPUB
  editions of this book”. An **illustrated or uploaded map** (PNG/JPEG) is placed in all three formats.

## Book save

`Pictures/pictures.json` (style, and per picture: kind, chapter, scene, caption, alt, placement, chosen, file) and
the chosen pictures: `Pictures/ch01 pic-001.png`, `Pictures/ch02 scene 2 pic-004.jpg`, `Pictures/map.svg` (every
path ≤ 60 characters inside the book's folder). The exported PDF/EPUB/DOCX in `Book/` carry the pictures.

## Tests

`akowe/tests/test_pictures.py` (prompt builder, illustrate job against a fake bridge with every error code and the
NO_LOCK fallback, candidates, the batch with Stop, the SVG and illustrated maps, placement in the three exporters and
in a real assemble → export, book save, HTTP API) and `akowe/tests/campaign/ui/test_ui_pictures.py` (the page in
Chromium, desktop and phone).
