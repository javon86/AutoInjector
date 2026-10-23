"""Illustrations in the exporters: colour models, transparency, CMYK, scaling/placement, corrupt files.

Rendering is checked with pdfium (pixels at the image centre vs Pillow's own decode composited on white).
"""
from __future__ import annotations

import io
import os
import struct
import time
import zipfile
import zlib

import pytest

PIL = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

from bf_export_helpers import PAGE, build_all, jpeg, png  # noqa: E402
from bookforge import h_checks  # noqa: E402
from bookforge.exporters.images import UnsupportedImage, load_image  # noqa: E402

CH = [{"id": "C02-img1", "text": "# Pictures\nPara one.\nPara two.\nPara three."}]


def place(data, *, w=80, h=60, fit="CONTAIN", margins=54, chapters=CH):
    info = load_image(data)
    return build_all(chapters, toc=False, images={"k1": (data, info)}, margins=margins,
                     placements=[{"placement_id": "pl1", "anchor_id": f"{chapters[0]['id']}-p1", "key": "k1",
                                  "width_mm": w, "height_mm": h, "fit": fit}])


def img_op(b):
    for pi, p in enumerate(b.layout.pages):
        for o in p.ops:
            if o[0] == "img":
                return pi, o
    raise AssertionError("no image placed")


def centre_pixel(b, scale=2):
    import pypdfium2 as pdfium
    pi, (_, _, x, y, dw, dh, clip) = img_op(b)
    bmp = pdfium.PdfDocument(b.pdf)[pi].render(scale=scale).to_pil().convert("RGB")
    return bmp.getpixel((int((x + dw / 2) * scale), int((b.geom.height - (y + dh / 2)) * scale)))


def expected(data):
    im = Image.open(io.BytesIO(data))
    im.load()
    if im.mode in ("RGBA", "LA", "PA"):
        base = Image.new("RGBA", im.size, (255, 255, 255, 255))
        base.alpha_composite(im.convert("RGBA"))
        return base.convert("RGB").getpixel((im.width // 2, im.height // 2))
    return im.convert("RGB").getpixel((im.width // 2, im.height // 2))


RED = (220, 20, 30)
VARIANTS = {
    "rgb_png": lambda: png(Image.new("RGB", (40, 30), RED)),
    "rgba_png_half_alpha": lambda: png(Image.new("RGBA", (40, 30), RED + (128,))),
    "gray_alpha_png": lambda: png(Image.new("LA", (40, 30), (100, 128))),
    "palette_png": lambda: png(Image.new("RGB", (40, 30), RED).convert("P")),
    "bilevel_png": lambda: png(Image.new("1", (40, 30), 1)),
    "rgb_jpeg": lambda: jpeg(Image.new("RGB", (40, 30), RED)),
    "gray_jpeg": lambda: jpeg(Image.new("L", (40, 30), 90)),
    "progressive_jpeg": lambda: jpeg(Image.new("RGB", (40, 30), RED), progressive=True),
}


@pytest.mark.parametrize("name", sorted(VARIANTS))
def test_image_renders_with_right_colour_in_pdf_and_is_packaged(name):
    data = VARIANTS[name]()
    b = place(data)
    got, want = centre_pixel(b), expected(data)
    assert max(abs(a - c) for a, c in zip(got, want)) <= 12, (got, want)
    # EPUB and DOCX carry the exact original bytes
    ez = zipfile.ZipFile(io.BytesIO(b.epub))
    assert [ez.read(n) for n in ez.namelist() if n.startswith("OEBPS/images/")] == [data]
    dz = zipfile.ZipFile(io.BytesIO(b.docx))
    assert [dz.read(n) for n in dz.namelist() if n.startswith("word/media/")] == [data]


def test_cmyk_jpeg_not_inverted():
    data = jpeg(Image.new("CMYK", (40, 30), (0, 230, 200, 30)))  # a red; Pillow writes Adobe (inverted) CMYK
    r, g, bl = centre_pixel(place(data))
    assert r > 150 and g < 110 and bl < 110, (r, g, bl)


def test_sixteen_bit_gray_png_renders_mid_grey():
    data = png(Image.new("I;16", (40, 30), 30000))  # 30000/65535 ~ 46% grey
    r, g, bl = centre_pixel(place(data))
    assert abs(r - 117) <= 12 and r == g == bl


def test_unsupported_encodings_rejected_explicitly():
    with pytest.raises(UnsupportedImage):
        load_image(png(Image.new("RGBA", (40, 30), RED + (0,)).convert("P")))  # tRNS
    with pytest.raises(UnsupportedImage):
        load_image(b"GIF89a....")


@pytest.mark.parametrize("w,h,fit", [(80, 60, "CONTAIN"), (1, 1, "CONTAIN"), (500, 2000, "CONTAIN"), (5000, 10, "CONTAIN"),
                                     (152.4, 228.6, "CONTAIN")])
@pytest.mark.parametrize("shape", [(100, 1000), (2000, 50), (300, 200)])
def test_contain_images_stay_inside_content_box(w, h, fit, shape):
    data = png(Image.new("RGB", shape, (0, 0, 200)))
    b = place(data, w=w, h=h, fit=fit)
    g = b.geom
    _, (_, _, x, y, dw, dh, clip) = img_op(b)
    assert g.left - 0.01 <= x and x + dw <= g.width - g.right + 0.01
    assert g.bottom - 0.01 <= y and y + dh <= g.height - g.top + 0.01
    assert dw > 0 and dh > 0
    assert abs(dw / dh - shape[0] / shape[1]) < 0.01 * shape[0] / shape[1]  # aspect ratio kept
    issues = [i for i in h_checks.pdf_layout(b.pdf, PAGE, print_profile=False) if i["decision"] != "PASS"]
    assert issues == []


def test_cover_fit_is_clipped_to_its_box_when_rendered():
    import pypdfium2 as pdfium
    data = png(Image.new("RGB", (100, 1000), (0, 0, 200)))
    b = place(data, w=80, h=60, fit="COVER")
    pi, (_, _, x, y, dw, dh, clip) = img_op(b)
    cx, cy, cw, ch = clip
    bmp = pdfium.PdfDocument(b.pdf)[pi].render(scale=1).to_pil().convert("RGB")
    H = b.geom.height
    inside = bmp.getpixel((int(cx + cw / 2), int(H - (cy + ch / 2))))
    above = bmp.getpixel((int(cx + cw / 2), int(H - (cy + ch)) - 3))
    assert inside[2] > 150 and inside[0] < 60
    assert above[2] < 150 or above[0] > 100, "COVER image leaks outside its clip box"


@pytest.mark.xfail(strict=True, reason="NEW-export-3: H07 (h_checks.pdf_layout) ignores the clipping path, so every "
                                       "COVER-fit image that overflows its box is reported as a MAJOR SAFE_MARGIN failure")
def test_h07_accepts_clipped_cover_image():
    data = png(Image.new("RGB", (100, 1000), (0, 0, 200)))
    b = place(data, w=80, h=60, fit="COVER")
    issues = [i for i in h_checks.pdf_layout(b.pdf, PAGE, print_profile=False) if i["decision"] != "PASS"]
    assert issues == []


@pytest.mark.xfail(strict=True, reason="NEW-export-4: a page-height illustration is scaled to content_height-leading "
                                       "but the composer floor is above the bottom margin, so the image overlaps the "
                                       "page number (layout.py _Composer.image vs floor)")
@pytest.mark.parametrize("margins", [0, 20])
def test_tall_image_does_not_overlap_page_number(margins):
    data = png(Image.new("RGB", (100, 1000), (0, 0, 200)))
    b = place(data, w=500, h=2000, margins=margins)
    pi, (_, _, x, y, dw, dh, clip) = img_op(b)
    footer = [o for o in b.layout.pages[pi].ops if o[0] == "text" and o[5].isdigit()][-1]
    assert footer[4] + footer[2] < y, f"page number top {footer[4] + footer[2]:.1f} >= image bottom {y:.1f}"


@pytest.mark.xfail(strict=True, reason="NEW-export-5: DOCX images are sized from width_mm/height_mm without clamping "
                                       "to the page's usable width (PDF clamps), so full-width art runs off the page")
def test_docx_image_fits_usable_page_width():
    data = png(Image.new("RGB", (300, 200), (0, 0, 200)))
    b = place(data, w=152.4, h=101.6)
    from lxml import etree
    doc = etree.fromstring(zipfile.ZipFile(io.BytesIO(b.docx)).read("word/document.xml"))
    wp = "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}"
    cx = int(doc.find(f".//{wp}extent").get("cx"))
    usable = (PAGE["width_mm"] - 2 * PAGE["safe_margin_mm"]) * 36000
    assert cx <= usable, (cx / 36000, usable / 36000)


# ----------------------------------------------------------------------------- corrupt files
def _chunk(t, body):
    return struct.pack(">I", len(body)) + t + body + struct.pack(">I", zlib.crc32(t + body) & 0xFFFFFFFF)


def _png(w, h, ctype, idat):
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, ctype, 0, 0, 0))
            + _chunk(b"IDAT", idat) + _chunk(b"IEND", b""))


CORRUPT = {
    "rgb_png_short_pixel_data": lambda: _png(40, 30, 2, zlib.compress(b"\x00" * 10)),
    "rgb_png_garbage_zlib": lambda: _png(40, 30, 2, b"garbage!"),
    "rgb_png_zero_width": lambda: _png(0, 30, 2, zlib.compress(b"")),
    "jpeg_truncated_after_header": lambda: jpeg(Image.new("RGB", (40, 30), RED))[:200],
    "rgba_png_short_pixel_data": lambda: _png(40, 30, 6, zlib.compress(b"\x00" * 10)),
    "rgba_png_garbage_zlib": lambda: _png(40, 30, 6, b"garbage!"),
}


@pytest.mark.xfail(strict=True, reason="NEW-export-2: corrupt PNG/JPEG bytes are accepted without decoding (passed "
                                       "through into PDF/EPUB/DOCX) or crash with a raw IndexError/zlib.error instead "
                                       "of UnsupportedImage")
@pytest.mark.parametrize("name", sorted(CORRUPT))
def test_corrupt_image_rejected_cleanly(name):
    with pytest.raises(UnsupportedImage):
        load_image(CORRUPT[name]())


@pytest.mark.xfail(strict=True, reason="NEW-export-10: EXIF orientation is ignored - a phone photo tagged 'rotate 90' "
                                       "prints sideways in the PDF while EPUB readers rotate it")
def test_exif_orientation_respected():
    im = Image.new("RGB", (40, 30), RED)
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 CW for display: displayed 30x40
    info = load_image(jpeg(im, exif=exif.tobytes()))
    assert (info.width, info.height) == (30, 40)


@pytest.mark.xfail(strict=True, reason="NEW-export-11: RGBA PNG decode is a pure-Python per-byte loop (~0.7 MP/s) and "
                                       "is repeated by every assemble() (G03, G01 validate, G04, G07, each export)")
def test_rgba_png_decode_throughput():
    w = 800
    data = png(Image.frombytes("RGBA", (w, w), os.urandom(w * w * 4)))
    t = time.perf_counter()
    load_image(data)
    mp_per_s = (w * w / 1e6) / (time.perf_counter() - t)
    assert mp_per_s >= 3.0, f"{mp_per_s:.2f} MP/s"
