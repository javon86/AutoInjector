"""Image inspection for exports (pure Python): JPEG and PNG only.

`load_image(data, mime)` returns an ImageInfo with the *display* size (after the EXIF
orientation of a JPEG) and a PDF image XObject (dictionary entries + stream bytes).

Every image is checked before it can reach a PDF, EPUB or DOCX, so a damaged file is refused
with a plain message (UnsupportedImage) instead of being passed through or crashing an export:
* PNG: chunk CRCs, IHDR sanity (size, bit depth/colour type), a pixel limit (decompression-bomb
  guard), and the complete zlib stream is inflated (bounded) and must hold exactly the rows the
  header promises, each with a valid filter type.
* JPEG: marker structure up to the scan, a frame header, and an end-of-image marker after the
  scan (catches truncated uploads; the entropy-coded data itself is not decoded).

PDF streams: JPEG passes through unchanged (DCTDecode). PNG without alpha passes the original
zlib data through (FlateDecode + PNG predictor). PNG with alpha (8-bit gray+alpha / RGBA) is split
into a colour stream and a /SMask stream *without unfiltering*: PNG filters work per channel
(each byte is predicted from the same channel of the neighbouring pixels), so de-interleaving
the filtered rows gives valid filtered rows for the colour and alpha images; both are re-deflated
and keep the PNG predictor. That is C-speed slicing, no per-byte Python loop.

Unsupported encodings (interlaced PNG, tRNS transparency, 16-bit alpha, 12-bit/arithmetic JPEG)
raise UnsupportedImage so callers block explicitly instead of silently degrading the asset.
Results are cached by content hash (the same art is inspected by several Set G steps).
"""
from __future__ import annotations

import hashlib
import struct
import threading
import zlib
from collections import OrderedDict
from dataclasses import dataclass, field

MAX_PIXELS = 50_000_000          # ~ 8000 x 6000; far above print needs (6x9 in at 300 dpi is 4.9 MP)
_CACHE_ENTRIES = 64
_cache: OrderedDict = OrderedDict()
_cache_lock = threading.Lock()


class UnsupportedImage(ValueError):
    pass


@dataclass
class ImageInfo:
    width: int                    # display size in pixels (after EXIF orientation)
    height: int
    mime: str
    ext: str
    pdf_dict: dict = field(default_factory=dict)   # PDF entries (values already PDF syntax strings)
    pdf_data: bytes = b""
    smask: tuple | None = None                     # (dict, bytes) for an alpha soft mask
    orientation: int = 1                           # EXIF orientation 1-8 of the stored pixels

    @property
    def swaps_axes(self) -> bool:
        return self.orientation in (5, 6, 7, 8)


def sniff_mime(data: bytes) -> str | None:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    return None


def load_image(data: bytes, mime: str | None = None) -> ImageInfo:
    if not data:
        raise UnsupportedImage("the image file is empty (0 bytes)")
    actual = sniff_mime(data)
    if actual is None:
        raise UnsupportedImage("only JPEG and PNG assets are supported by the exporters")
    if mime and mime.lower() not in (actual, "image/jpg" if actual == "image/jpeg" else actual):
        raise UnsupportedImage(f"declared MIME {mime} does not match the asset bytes ({actual})")
    key = hashlib.sha256(data).hexdigest()
    with _cache_lock:
        hit = _cache.get(key)
        if hit is not None:
            _cache.move_to_end(key)
            return hit
    try:
        info = _jpeg(data) if actual == "image/jpeg" else _png(data)
    except UnsupportedImage:
        raise
    except (struct.error, IndexError, ValueError, zlib.error, MemoryError) as exc:
        kind = "JPEG" if actual == "image/jpeg" else "PNG"
        raise UnsupportedImage(f"the {kind} file is damaged and cannot be read ({type(exc).__name__}: {exc})") \
            from exc
    with _cache_lock:
        _cache[key] = info
        while len(_cache) > _CACHE_ENTRIES:
            _cache.popitem(last=False)
    return info


def _check_size(width: int, height: int, kind: str) -> None:
    if width < 1 or height < 1:
        raise UnsupportedImage(f"the {kind} says it is {width} x {height} pixels; the file is damaged")
    if width * height > MAX_PIXELS:
        raise UnsupportedImage(f"the {kind} is {width} x {height} pixels ({width * height / 1e6:.0f} megapixels); "
                               f"the limit is {MAX_PIXELS / 1e6:.0f} megapixels - scale it down before placing it")


# --------------------------------------------------------------------------- JPEG
_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def _exif_orientation(seg: bytes) -> int:
    """Orientation tag (0x0112) from an APP1 'Exif' segment body; 1 when absent or unreadable."""
    if seg[:6] != b"Exif\x00\x00":
        return 1
    t = seg[6:]
    try:
        end = {b"II": "<", b"MM": ">"}[t[:2]]
        if struct.unpack(end + "H", t[2:4])[0] != 42:
            return 1
        ifd = struct.unpack(end + "I", t[4:8])[0]
        count = struct.unpack(end + "H", t[ifd:ifd + 2])[0]
        for i in range(count):
            e = ifd + 2 + 12 * i
            tag, typ, _n = struct.unpack(end + "HHI", t[e:e + 8])
            if tag == 0x0112 and typ == 3:
                v = struct.unpack(end + "H", t[e + 8:e + 10])[0]
                return v if 1 <= v <= 8 else 1
    except (KeyError, struct.error, IndexError):
        return 1
    return 1


def _jpeg(data: bytes) -> ImageInfo:
    i, n = 2, len(data)
    adobe = False
    orientation = 1
    frame = None
    while i + 4 <= n:
        if data[i] != 0xFF:
            raise UnsupportedImage("the JPEG file is damaged (corrupt marker stream)")
        marker = data[i + 1]
        if marker == 0xFF:
            i += 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        if marker == 0xD9:
            raise UnsupportedImage("the JPEG file ends before its image data (no scan)")
        seg_len = struct.unpack(">H", data[i + 2:i + 4])[0]
        if seg_len < 2 or i + 2 + seg_len > n:
            raise UnsupportedImage("the JPEG file is truncated (a header segment runs past the end of the file)")
        body = data[i + 4:i + 2 + seg_len]
        if marker == 0xEE and body[:5] == b"Adobe":
            adobe = True
        if marker == 0xE1 and orientation == 1:
            orientation = _exif_orientation(body)
        if marker in _SOF:
            bits, height, width, comps = struct.unpack(">BHHB", body[:6])
            if bits != 8 or comps not in (1, 3, 4):
                raise UnsupportedImage("unsupported JPEG sample layout (only 8-bit gray, RGB or CMYK)")
            if marker in (0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                raise UnsupportedImage("arithmetic-coded JPEG is not supported by PDF readers; re-save it")
            _check_size(width, height, "JPEG")
            frame = (width, height, comps)
        if marker == 0xDA:
            if frame is None:
                raise UnsupportedImage("the JPEG file has no frame header")
            # The entropy-coded scan follows; a complete file ends with an EOI marker (FFD9) after it.
            # Trailing padding/vendor data after EOI is tolerated.
            if data.rfind(b"\xff\xd9", i + 2 + seg_len) < 0:
                raise UnsupportedImage("the JPEG file is truncated (no end-of-image marker): re-export or "
                                       "re-upload the picture")
            break
        i += 2 + seg_len
    if frame is None:
        raise UnsupportedImage("the JPEG file has no frame header")
    if i + 4 > n:
        raise UnsupportedImage("the JPEG file is truncated (no image data)")
    width, height, comps = frame
    cs = {1: "/DeviceGray", 3: "/DeviceRGB", 4: "/DeviceCMYK"}[comps]
    d = {"Type": "/XObject", "Subtype": "/Image", "Width": str(width), "Height": str(height),
         "ColorSpace": cs, "BitsPerComponent": "8", "Filter": "/DCTDecode"}
    if comps == 4 and adobe:
        d["Decode"] = "[1 0 1 0 1 0 1 0]"
    if orientation in (5, 6, 7, 8):
        width, height = height, width
    return ImageInfo(width, height, "image/jpeg", "jpg", d, data, orientation=orientation)


# --------------------------------------------------------------------------- PNG
_PNG_DEPTHS = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
_PNG_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def _png_chunks(data: bytes):
    i = 8
    while True:
        if i + 8 > len(data):
            raise UnsupportedImage("the PNG file is truncated (no IEND chunk)")
        length = struct.unpack(">I", data[i:i + 4])[0]
        ctype = data[i + 4:i + 8]
        body = data[i + 8:i + 8 + length]
        crc = data[i + 8 + length:i + 12 + length]
        if len(body) != length or len(crc) != 4:
            raise UnsupportedImage("the PNG file is truncated (a chunk runs past the end of the file)")
        if zlib.crc32(ctype + body) & 0xFFFFFFFF != struct.unpack(">I", crc)[0]:
            raise UnsupportedImage(f"the PNG file is damaged (checksum error in a {ctype.decode('latin-1')!r} chunk)")
        yield ctype, body
        i += 12 + length
        if ctype == b"IEND":
            return


def _inflate(stream: bytes, expected: int) -> bytes:
    """Inflate the whole IDAT stream, never more than expected + 1 bytes (decompression-bomb guard)."""
    d = zlib.decompressobj()
    try:
        raw = d.decompress(stream, expected + 1)
    except zlib.error as exc:
        raise UnsupportedImage(f"the PNG image data is damaged ({exc})") from exc
    if len(raw) > expected:
        raise UnsupportedImage("the PNG holds more image data than its header declares (damaged or malicious)")
    if len(raw) < expected:
        raise UnsupportedImage(f"the PNG image data is truncated ({len(raw)} of {expected} bytes)")
    if not d.eof:
        try:
            d.flush()
        except zlib.error as exc:
            raise UnsupportedImage(f"the PNG image data is damaged ({exc})") from exc
    return raw


def _png(data: bytes) -> ImageInfo:
    ihdr, plte, idat, trns = None, None, [], False
    for ctype, body in _png_chunks(data):
        if ctype == b"IHDR":
            if len(body) != 13:
                raise UnsupportedImage("the PNG header (IHDR) is damaged")
            ihdr = struct.unpack(">IIBBBBB", body)
        elif ctype == b"PLTE":
            plte = body
        elif ctype == b"IDAT":
            idat.append(body)
        elif ctype == b"tRNS":
            trns = True
    if ihdr is None or not idat:
        raise UnsupportedImage("the PNG file has no header or no image data (IHDR/IDAT)")
    width, height, depth, ctype, comp, filt, interlace = ihdr
    if ctype not in _PNG_DEPTHS or depth not in _PNG_DEPTHS[ctype]:
        raise UnsupportedImage(f"invalid PNG colour type {ctype} / bit depth {depth}")
    if comp != 0 or filt != 0 or interlace != 0:
        raise UnsupportedImage("interlaced or non-standard PNG is not supported; save it without interlacing")
    _check_size(width, height, "PNG")
    if trns:
        raise UnsupportedImage("PNG tRNS transparency is not supported; use an alpha channel")
    if ctype == 3 and (plte is None or not plte or len(plte) % 3 or len(plte) // 3 > 2 ** depth):
        raise UnsupportedImage("the palette PNG has a missing or invalid palette (PLTE)")
    channels = _PNG_CHANNELS[ctype]
    stride = (width * channels * depth + 7) // 8
    stream = b"".join(idat)
    raw = _inflate(stream, height * (stride + 1))
    if max(raw[::stride + 1]) > 4:
        raise UnsupportedImage("the PNG image data is damaged (invalid row filter)")
    if ctype in (0, 2, 3):
        colors = {0: 1, 2: 3, 3: 1}[ctype]
        if ctype == 3:
            cs = f"[/Indexed /DeviceRGB {len(plte) // 3 - 1} <{plte.hex()}>]"
        else:
            cs = "/DeviceGray" if ctype == 0 else "/DeviceRGB"
        d = {"Type": "/XObject", "Subtype": "/Image", "Width": str(width), "Height": str(height),
             "ColorSpace": cs, "BitsPerComponent": str(depth), "Filter": "/FlateDecode",
             "DecodeParms": f"<< /Predictor 15 /Colors {colors} /BitsPerComponent {depth} /Columns {width} >>"}
        return ImageInfo(width, height, "image/png", "png", d, stream)
    if depth != 8:
        raise UnsupportedImage("16-bit PNG with an alpha channel is not supported; save it as 8-bit")
    nc = channels - 1
    color_rows, alpha_rows = bytearray(), bytearray()
    row_c = bytearray(1 + width * nc)
    for y in range(height):
        row = raw[y * (stride + 1):(y + 1) * (stride + 1)]
        f = row[0:1]
        px = row[1:]
        for ch in range(nc):
            row_c[1 + ch::nc] = px[ch::channels]
        row_c[0:1] = f
        color_rows += row_c
        alpha_rows += f + px[nc::channels]
    params = "<< /Predictor 15 /Colors {} /BitsPerComponent 8 /Columns {} >>"
    d = {"Type": "/XObject", "Subtype": "/Image", "Width": str(width), "Height": str(height),
         "ColorSpace": "/DeviceGray" if nc == 1 else "/DeviceRGB", "BitsPerComponent": "8",
         "Filter": "/FlateDecode", "DecodeParms": params.format(nc, width)}
    sm = {"Type": "/XObject", "Subtype": "/Image", "Width": str(width), "Height": str(height),
          "ColorSpace": "/DeviceGray", "BitsPerComponent": "8", "Filter": "/FlateDecode",
          "DecodeParms": params.format(1, width)}
    return ImageInfo(width, height, "image/png", "png", d, zlib.compress(bytes(color_rows), 6),
                     (sm, zlib.compress(bytes(alpha_rows), 6)))
