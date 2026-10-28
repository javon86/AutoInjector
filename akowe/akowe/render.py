"""🖨 SVG → JPEG / PNG through AutoInjector (``POST /render/image``): Akọwe has no image library at runtime (no
Pillow), AutoInjector has Chromium. Used for the ebook cover JPG (stores like Amazon KDP want a JPG or TIFF cover,
1600 × 2560) and the PNG copy of the SVG map that Word needs.

The bridge address, token and plain-words errors are the picture helpers' (``forge.bridge_targets`` / ``forge._post``
/ ``forge.ART_PROBLEMS``); the next bridge is tried only when one is not reachable or has no render route. The
answer is checked: the right kind of file (JPEG / PNG magic) of exactly the size asked.
"""
from __future__ import annotations

import base64
import binascii

from . import forge
from .errors import AkoweError

RENDER_TIMEOUT_S = 60.0
MAX_RENDER_BYTES = 40 * 1024 * 1024


def render_image(app, svg: str | bytes, width: int, height: int, *, fmt: str = "jpeg", quality: int = 92,
                 timeout_s: float = RENDER_TIMEOUT_S) -> bytes:
    """The SVG drawn at exactly width × height as JPEG / PNG bytes. Raises ``forge.ArtProblem`` (plain words)."""
    if isinstance(svg, (bytes, bytearray)):
        svg = bytes(svg).decode("utf-8")
    body = {"svg": svg, "width": int(width), "height": int(height), "format": fmt,
            "timeoutMs": int(min(timeout_s, 60.0) * 1000)}
    if fmt == "jpeg":
        body["quality"] = int(quality)
    targets = forge.bridge_targets(app)
    if not targets:
        raise forge.ArtProblem("IMAGE_BRIDGE_UNREACHABLE", "no local AutoInjector address is set")
    last = None
    for url, token in targets:
        try:
            resp = forge._post(url, token, body, timeout_s + 10, route="/render/image")  # noqa: SLF001
            break
        except forge.ArtProblem as exc:
            if exc.code not in ("IMAGE_BRIDGE_UNREACHABLE", "RENDER_NOT_WIRED"):
                raise
            last = exc
    else:
        raise last
    b64 = resp.get("imageBase64")
    if not isinstance(b64, str) or not b64 or len(b64) > MAX_RENDER_BYTES * 4 // 3 + 8:
        raise forge.ArtProblem("RENDER_BAD_ANSWER")
    try:
        data = base64.b64decode(b64, validate=True)
    except (ValueError, binascii.Error):
        raise forge.ArtProblem("RENDER_BAD_ANSWER") from None
    from .exporters.images import UnsupportedImage, load_image  # noqa: PLC0415
    want = "image/jpeg" if fmt == "jpeg" else "image/png"
    try:
        info = load_image(data)
    except (UnsupportedImage, ValueError):
        raise forge.ArtProblem("RENDER_BAD_ANSWER", "AutoInjector's picture cannot be read") from None
    if info.mime != want or (info.width, info.height) != (int(width), int(height)):
        raise forge.ArtProblem("RENDER_BAD_ANSWER", f"AutoInjector sent a {info.width} × {info.height} "
                               f"{info.ext.upper()} instead of a {width} × {height} {fmt.upper()}")
    return data


def as_error(exc: forge.ArtProblem, what: str, path: str = "/format") -> AkoweError:
    """A plain-words API error for a failed render: what could not be made, why, and what to do."""
    if exc.code in ("IMAGE_BRIDGE_UNREACHABLE", "IMAGE_BRIDGE_KEY", "RENDER_NOT_WIRED"):
        head = f"The {what} is drawn by AutoInjector, and AutoInjector is not connected"
        if exc.code == "IMAGE_BRIDGE_KEY":
            head = f"The {what} is drawn by AutoInjector, and AutoInjector did not accept Akọwe's key"
        elif exc.code == "RENDER_NOT_WIRED":
            head = f"The {what} is drawn by AutoInjector, and this AutoInjector cannot draw pictures yet"
        return AkoweError("CAPABILITY_UNAVAILABLE", path, f"{head}. {exc.hint}", status="REJECTED")
    return AkoweError("CAPABILITY_UNAVAILABLE", path, f"The {what} could not be made: {exc.message}. {exc.hint}",
                      status="REJECTED")
