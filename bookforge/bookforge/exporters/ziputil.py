"""Deterministic ZIP packaging shared by the EPUB and DOCX writers.

Every entry is STORED (no compression, so bytes never depend on the zlib build), has a
fixed 1980-01-01 timestamp, fixed Unix permissions and the caller's explicit order.
Identical inputs therefore always yield identical archive bytes.
"""
from __future__ import annotations

import io
import zipfile

FIXED_DATE = (1980, 1, 1, 0, 0, 0)


def build_zip(entries: list[tuple[str, bytes]]) -> bytes:
    names = [n for n, _ in entries]
    if len(set(names)) != len(names):
        raise ValueError("duplicate zip entry names")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as zf:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.create_version = 20
            info.extract_version = 20
            info.external_attr = (0o100644 << 16)
            info.flag_bits = 0x800 if any(ord(c) > 127 for c in name) else 0
            zf.writestr(info, data)
    return buf.getvalue()


def read_zip(data: bytes) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BytesIO(data))
