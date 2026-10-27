# 🎨 Book covers (Akọwe, plan item B3, covers)

The **🎨 Cover** page (`#/p/<pid>/<branch>/cover`, also under **More** and linked from *Make my book → Export*) makes a
book look professional: an ebook cover, a print-ready paperback wrap with spine, and the book's own PDF / EPUB / DOCX
with the cover added. Code: `akowe/cover.py` (design, art job, API, book save), `akowe/exporters/cover.py` (templates,
layout, print maths, PDF/SVG writers, the EPUB/DOCX/PDF add-ons), `akowe/web/cover.js` (the page). Tests:
`tests/test_cover.py`, `tests/campaign/ui/test_ui_cover.py`.

## What the author does

1. **Pick a template**: seven typographic looks, light and dark, built on the dark-and-gold dossier style:

   | id | name | for | look |
   |---|---|---|---|
   | `gilded` | Gilded | literary, historical, saga | charcoal and gold, a gold double frame and rules, serif capitals |
   | `thriller` | Midnight thriller | thriller, crime | black, huge white sans capitals at the bottom, a red bar |
   | `romance` | Blush | romance | cream and wine, italic serif in the middle, small flourishes (light) |
   | `fantasy` | Epic fantasy | fantasy, myth | navy and gold, wide-tracked serif capitals, diamond rules |
   | `literary` | Paper and ink | literary, memoir | ivory, a framed (inset) picture, a quiet serif title (light) |
   | `scifi` | Signal | science fiction | near-black and teal, tracked sans capitals left-aligned, an accent bar |
   | `minimal` | Swiss minimal | non-fiction, poetry | white, bold sans title left-aligned, a yellow block, the picture off the edge (light) |

   You can change the background, text and accent colours (↺ resets one).
2. **Type the texts**: the title, subtitle, author, series and tagline. An empty title or author uses the book profile's.
   A line break in the title breaks it there.
3. **Add a picture**: 🎨 Stable Diffusion or 💬 ChatGPT (through AutoInjector), ⬆ Upload (PNG/JPEG), or none for a
   typographic cover. Optional: *What the picture shows*, *Upscale* (×2 / ×4, for print) and a *Character* (an
   AutoInjector character lock).
4. **Back cover**: the blurb and *About the author*. These are kept in the book profile (`blurb`, `author_bio`).
   *Start from the book idea* copies the profile idea into the blurb as a first draft.
5. **Print**: the trim (5 × 8, 5.5 × 8.5 or 6 × 9 in), the paper (white or cream) and the page count. Akọwe shows the
   spine width and the full wrap size.
6. **Download**: the ebook cover (PDF or SVG), the picture alone, the print cover (PDF), and the book's last exported
   PDF / EPUB / DOCX **with this cover**.

The preview redraws as you type (it renders the unsaved design), and the design saves itself a moment later.

## Typesetting rules (all templates)

- **Hierarchy.** The series is small tracked capitals in the accent colour. The title is the largest text and never
  smaller than the author. Then the subtitle (italic) and the tagline, with the author last.
- **Safe area.** No text is closer than 0.375 in to any trim edge or fold (KDP asks for 0.25 in). The test suite reads
  every text show back out of the PDF and checks its full extent (advance width with tracking, the font's ascent and
  descent) against the safe area, for every template, with and without a picture, for short and very long titles.
- **Title fitting.** Akọwe uses the largest size that fits its zone in at most 3 lines (4–5 for long titles). The
  breaks are balanced: it finds the fewest lines that fit, then the narrowest width that keeps that many lines, so
  there is no lonely last word. A word wider than the line is broken with a hyphen. A title that still does not fit at
  14 pt is cut with "…" and a warning.
- **Contrast over artwork.** Behind each text group on a full-bleed picture there is a scrim: a soft gradient in the
  template's dark (or light) colour. It is solid (82–86 %) where the text sits and fades out over 14 % of the height.
  In the PDF this is a luminosity soft mask with an axial shading; in the SVG it is a `linearGradient`.
- **Spine.** The title and author are rotated to read top to bottom (the US/UK custom). They are centred across the
  spine on the capital height, centred along it, and kept 0.0625 in from each fold and 0.5 in from the trim. The text
  shrinks to fit. If it is still too long the author is dropped, then the spine text itself.
- **Back cover.** The tagline is the headline. Below it come the blurb (11.5 pt, shrinking to 8 pt to fit) and
  *ABOUT THE AUTHOR* with the bio. Text never runs into the barcode area. What still does not fit at 8 pt is cut with
  "…" and a warning.

## Print maths

Akọwe follows Amazon KDP's paperback rules (black-ink interior), the strictest of the common print-on-demand
services:

| | value |
|---|---|
| bleed | 0.125 in on the outer edges (MediaBox = BleedBox; TrimBox marks the trim) |
| spine width | pages × 0.002252 in (white paper) or pages × 0.0025 in (cream paper) |
| wrap width | 0.125 + trim width + spine + trim width + 0.125 in |
| wrap height | 0.125 + trim height + 0.125 in |
| page count | 24 to 828 (white) or 776 (cream); an odd count is rounded up (the printer adds a blank page) |
| spine text | from 100 pages (KDP allows it from 80; under 100 the spine is so thin that a small fold drift moves the text onto a cover) |
| barcode area | a blank white 2 × 1.2 in box at the back's bottom right, 0.25 in from the spine fold and from the bottom trim |

Example: 6 × 9 in, cream, 320 pages → spine 0.800 in, wrap 13.050 × 9.250 in.

**The page count** comes from, in this order:

1. the number the author typed;
2. the exported PDF's pages (shown as "from your PDF export");
3. an estimate from the word count (about 280 words per 6 × 9 page, plus 8 pages, shown as an estimate).

Every problem is said in plain words, for example "a printed paperback needs at least 24 pages (this book has 12)" or
"on cream paper a paperback can have at most 776 pages".

A picture with fewer than 300 dpi on the print cover gets a warning that names the pixel size and the dpi, and
suggests ×2 / ×4 upscale.

## The ebook cover without Pillow (the decision)

Akọwe stays pure Python with no Pillow at runtime, and it **does not rasterise**. Putting text into pixels needs glyph
outlines, and the base-14 PDF fonts are never embedded, so there are no outlines to draw. Decoding the AI's JPEG would
also need a whole DCT decoder in Python. So:

- **Ebook cover** = a one-page PDF (6 × 9.6 in, the 1600 × 2560 px shape) and the same layout as an **SVG**. The SVG
  layers the artwork (a data URI) and the typeset text. Every line carries `textLength` and
  `lengthAdjust="spacingAndGlyphs"`, so a reader's stand-in font keeps the measured width and stays in the safe area.
- **EPUB**: the **artwork itself** is the `cover-image` (the library thumbnail; JPEG/PNG as AutoInjector made it), and
  the title and author are in the metadata. The first spine item is `text/cover.xhtml`, an inline SVG
  (`properties="svg"`) with the typeset text over the artwork. With no artwork, the typographic SVG is the `cover-image`
  (SVG is an EPUB 3 core media type). An EPUB that already has a cover is left as it is.
- **DOCX**: a cover page in front: the series, the title (Title style), the subtitle, the artwork fitted to 60 % of the
  page, the author, then a page break.
- **PDF export**: a cover page is put in front of page 1, at the book's own page size (with bleed when the book has
  it). Every other object keeps its number, so the outline, the links and the named destinations still work.
- Stores that want one flat JPEG with the title on it (KDP's ebook upload): use the picture (it is already a JPEG or
  PNG) or open the ebook-cover PDF/SVG in any viewer and export it as an image. Rasterising inside AutoInjector
  (Chromium) is possible later.

## AI artwork

`POST …/cover/art {engine: auto|sd|chatgpt, upscale?: 1|2|4}` → 202 `{job_id}` (poll `…/cover/jobs/<id>` or
`…/review/ai/<id>`). It calls AutoInjector `POST /image/request` with the Character Forge helpers (the bridge address
and token from Settings → Pictures):

```json
{"engine": "sd", "purpose": "cover", "prompt": "Book cover artwork for \"The Salt Road\". Genre: Fantasy. … No text, no letters, no title, no logos, no watermark, no border",
 "size": {"width": 1600, "height": 2400}, "upscale": 2, "characterLock": "Mara Vell",
 "book": "The Salt Road", "from": "akowe-cover", "returnImage": true}
```

- The prompt comes from the art note, or else the book idea, plus the genre and tone. It asks for a calm area where
  the template puts the title, and for no lettering.
- `size` follows the trim's shape.
- `NO_LOCK` retries once without the lock and says so.
- Every `/image/request` error code gets the forge's plain words and fix: `SD_NOT_CONNECTED`, `CHATGPT_NOT_READY`,
  `IMAGE_REFUSED`, `IMAGE_TIMEOUT`, `IMAGE_LIMIT`, `NO_IMAGE_ENGINE`, `IMAGE_BRIDGE_UNREACHABLE`, `IMAGE_BRIDGE_KEY`,
  `IMAGE_NOT_WIRED`, `IMAGE_BAD_ANSWER`.
- The picture is stored as a book asset (binary I01 record).

## API (under `/api/projects/:pid/branches/:b`)

| call | what |
|---|---|
| `GET /cover` | `{design, texts (resolved), templates, trims, papers, print (spine/wrap/ok/problem/notes), warnings, ebook, characters, idea, image_bridge, rules}` |
| `PUT /cover` | partial design: `template`, `colors{background,text,accent}` (#rrggbb or null), `texts{title,subtitle,author,series,tagline}`, `blurb`, `author_bio` (→ profile), `print{trim,paper,page_count}`, `use_art`, `art: null`, `art_note`, `character_lock`, optional `revision` (stale → 409). Bad values → 400 in plain words |
| `POST /cover/art` | `{engine, upscale?}` → 202 `{job_id}` |
| `PUT /cover/art` | the picture bytes (PNG/JPEG) → the design |
| `GET /cover/ebook?format=pdf\|svg\|art` | the front cover (PDF default) or the picture alone |
| `GET /cover/print?trim=6x9&paper=cream[&pages=N][&format=svg&guides=1]` | the full wrap PDF (or SVG with trim, fold and safe-area guides) |
| `GET /cover/book?format=PDF\|EPUB\|DOCX` | the last exported book file with the cover |
| `POST /cover/preview[?what=print]` | SVG of an unsaved design (the live preview; nothing is saved) |
| `GET /cover/jobs/:id` | the art job |

Add `download=1` to any file call to get it as an attachment.

## Book save (💾)

`Cover/` in the book's folder is written once the cover page has been used. Every path is at most 60 characters:

- `cover-design.json`;
- `ebook cover.pdf` and `ebook cover.svg`;
- `cover art.jpg|png`;
- `print cover.pdf`, when the page count is known;
- `<title> (with cover).pdf|epub|docx`, when the book has been exported.
