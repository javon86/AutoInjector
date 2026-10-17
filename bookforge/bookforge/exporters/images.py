"""Image inspection for exports (pure Python): JPEG and PNG only.

`load_image(data, mime)` returns an ImageInfo with pixel size and a PDF image XObject
(dictionary entries + stream bytes). JPEG streams pass through unchanged (DCTDecode).
PNG without alpha passes the original zlib data through (FlateDecode + PNG predictor);
PNG with alpha (8-bit gray+alpha / RGBA) is decoded and split into a raw colour stream
and a raw /SMask stream. Unsupported encodings (interlaced PNG, tRNS transparency,
16-bit alpha, unknown JPEG layout) raise UnsupportedImage so callers block explicitly
instead of silently degrading the asset.
"""
from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass, field


class UnsupportedImage(ValueError):
    pass


@dataclass
class ImageInfo:
    width: int
    height: int
    mime: str
    ext: str
    pdf_dict: dict = field(default_factory=dict)   # PDF entries (values already PDF syntax strings)
    pdf_data: bytes = b""
    smask: tuple | None = None                     # (dict, bytes) for an alpha soft mask


def sniff_mime(data: bytes) -> str | None:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    return None


def load_image(data: bytes, mime: str | None = None) -> ImageInfo:
    actual = sniff_mime(data)
    if actual is None:
        raise UnsupportedImage("only JPEG and PNG assets are supported by the exporters")
    if mime and mime.lower() not in (actual, "image/jpg" if actual == "image/jpeg" else actual):
        raise UnsupportedImage(f"declared MIME {mime} does not match the asset bytes ({actual})")
    return _jpeg(data) if actual == "image/jpeg" else _png(data)


# --------------------------------------------------------------------------- JPEG
_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def _jpeg(data: bytes) -> ImageInfo:
    i, n = 2, len(data)
    adobe = False
    while i + 4 <= n:
        if data[i] != 0xFF:
            raise UnsupportedImage("corrupt JPEG marker stream")
        marker = data[i + 1]
        if marker == 0xFF:
            i += 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        seg_len = struct.unpack(">H", data[i + 2:i + 4])[0]
        if marker == 0xEE and data[i + 4:i + 9] == b"Adobe":
            adobe = True
        if marker in _SOF:
            bits, height, width, comps = struct.unpack(">BHHB", data[i + 4:i + 10])
            if bits != 8 or width < 1 or height < 1 or comps not in (1, 3, 4):
                raise UnsupportedImage("unsupported JPEG sample layout")
            cs = {1: "/DeviceGray", 3: "/DeviceRGB", 4: "/DeviceCMYK"}[comps]
            d = {"Type": "/XObject", "Subtype": "/Image", "Width": str(width), "Height": str(height),
                 "ColorSpace": cs, "BitsPerComponent": "8", "Filter": "/DCTDecode"}
            if comps == 4 and adobe:
                d["Decode"] = "[1 0 1 0 1 0 1 0]"
            return ImageInfo(width, height, "image/jpeg", "jpg", d, data)
        if marker == 0xDA:
            break
        i += 2 + seg_len
    raise UnsupportedImage("JPEG has no frame header")


# --------------------------------------------------------------------------- PNG
def _png_chunks(data: bytes):
    i = 8
    while i + 8 <= len(data):
        length = struct.unpack(">I", data[i:i + 4])[0]
        ctype = data[i + 4:i + 8]
        body = data[i + 8:i + 8 + length]
        if len(body) != length:
            raise UnsupportedImage("truncated PNG chunk")
        yield ctype, body
        i += 12 + length
        if ctype == b"IEND":
            return


def _png(data: bytes) -> ImageInfo:
    ihdr, plte, idat, trns = None, None, [], False
    for ctype, body in _png_chunks(data):
        if ctype == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", body)
        elif ctype == b"PLTE":
            plte = body
        elif ctype == b"IDAT":
            idat.append(body)
        elif ctype == b"tRNS":
            trns = True
    if ihdr is None or not idat:
        raise UnsupportedImage("PNG lacks IHDR/IDAT")
    width, height, depth, ctype, comp, filt, interlace = ihdr
    if comp != 0 or filt != 0 or interlace != 0:
        raise UnsupportedImage("interlaced or non-standard PNG is not supported")
    if trns:
        raise UnsupportedImage("PNG tRNS transparency is not supported; use an alpha channel")
    stream = b"".join(idat)
    if ctype in (0, 2, 3):
        colors = {0: 1, 2: 3, 3: 1}[ctype]
        if ctype == 3:
            if plte is None:
                raise UnsupportedImage("palette PNG lacks PLTE")
            cs = f"[/Indexed /DeviceRGB {len(plte) // 3 - 1} <{plte.hex()}>]"
        else:
            cs = "/DeviceGray" if ctype == 0 else "/DeviceRGB"
        d = {"Type": "/XObject", "Subtype": "/Image", "Width": str(width), "Height": str(height),
             "ColorSpace": cs, "BitsPerComponent": str(depth), "Filter": "/FlateDecode",
             "DecodeParms": f"<< /Predictor 15 /Colors {colors} /BitsPerComponent {depth} /Columns {width} >>"}
        return ImageInfo(width, height, "image/png", "png", d, stream)
    if ctype in (4, 6) and depth == 8:
        channels = 2 if ctype == 4 else 4
        raw = _unfilter(zlib.decompress(stream), width, height, channels)
        color, alpha = bytearray(), bytearray()
        nc = channels - 1
        for p in range(0, len(raw), channels):
            color += raw[p:p + nc]
            alpha.append(raw[p + nc])
        d = {"Type": "/XObject", "Subtype": "/Image", "Width": str(width), "Height": str(height),
             "ColorSpace": "/DeviceGray" if nc == 1 else "/DeviceRGB", "BitsPerComponent": "8"}
        sm = {"Type": "/XObject", "Subtype": "/Image", "Width": str(width), "Height": str(height),
              "ColorSpace": "/DeviceGray", "BitsPerComponent": "8"}
        return ImageInfo(width, height, "image/png", "png", d, bytes(color), (sm, bytes(alpha)))
    raise UnsupportedImage("unsupported PNG colour type/bit depth")


def _unfilter(raw: bytes, width: int, height: int, bpp: int) -> bytes:
    stride = width * bpp
    out = bytearray()
    prev = bytearray(stride)
    pos = 0
    for _ in range(height):
        ftype = raw[pos]
        line = bytearray(raw[pos + 1:pos + 1 + stride])
        pos += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if ftype == 1:
                line[x] = (line[x] + a) & 0xFF
            elif ftype == 2:
                line[x] = (line[x] + b) & 0xFF
            elif ftype == 3:
                line[x] = (line[x] + ((a + b) >> 1)) & 0xFF
            elif ftype == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[x] = (line[x] + pred) & 0xFF
            elif ftype != 0:
                raise UnsupportedImage("corrupt PNG filter type")
        out += line
        prev = line
    return bytes(out)
