"""Canonical JSON serialization and hashing (Shared Contract section 3).

Hash input is UTF-8 JSON with keys recursively sorted, no insignificant whitespace,
non-ASCII characters retained and no NaN/Infinity. Text is never Unicode-normalized.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

REFERENCE_KEYS = ("project_id", "branch_id", "owner", "module_id", "record_id", "version", "content_hash")


def canonical_bytes(value: Any) -> bytes:
    """Serialize a JSON value to its canonical byte form; raises ValueError on NaN/Infinity."""
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_bytes(canonical_bytes(value))


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def is_reference(value: Any) -> bool:
    """True when value has exactly the seven canonical Reference fields."""
    return isinstance(value, dict) and set(value.keys()) == set(REFERENCE_KEYS)


def make_reference(project_id: str, branch_id: str, module_id: str, record_id: str,
                   version: int, content_hash: str) -> dict:
    return {
        "project_id": project_id,
        "branch_id": branch_id,
        "owner": module_id[0],
        "module_id": module_id,
        "record_id": record_id,
        "version": int(version),
        "content_hash": content_hash,
    }


def ref_key(ref: dict) -> tuple:
    return (ref["project_id"], ref["branch_id"], ref["record_id"], int(ref["version"]))


def json_pointer(parts) -> str:
    """Build an RFC 6901 pointer from path parts."""
    out = ""
    for p in parts:
        out += "/" + str(p).replace("~", "~0").replace("/", "~1")
    return out


def iter_references(value: Any, path: tuple = ()):
    """Yield (pointer_parts, reference) for every canonical Reference nested in value."""
    if is_reference(value):
        yield path, value
        return
    if isinstance(value, dict):
        for k, v in value.items():
            yield from iter_references(v, path + (k,))
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from iter_references(v, path + (i,))


def resolve_pointer(doc: Any, pointer: str) -> Any:
    """Resolve an RFC 6901 pointer; raises KeyError when absent."""
    if pointer == "":
        return doc
    if not pointer.startswith("/"):
        raise KeyError(pointer)
    cur = doc
    for raw in pointer[1:].split("/"):
        token = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(cur, list):
            cur = cur[int(token)]
        elif isinstance(cur, dict):
            cur = cur[token]
        else:
            raise KeyError(pointer)
    return cur


def changed_pointers(old: Any, new: Any, path: str = "") -> list[str]:
    """Return the minimal pointers whose values differ between two JSON documents."""
    if type(old) is not type(new):
        return [path]
    if isinstance(old, dict):
        out = []
        for k in sorted(set(old) | set(new)):
            p = path + "/" + str(k).replace("~", "~0").replace("/", "~1")
            if k not in old or k not in new:
                out.append(p)
            else:
                out.extend(changed_pointers(old[k], new[k], p))
        return out
    if isinstance(old, list):
        if len(old) != len(new):
            return [path]
        out = []
        for i, (a, b) in enumerate(zip(old, new)):
            out.extend(changed_pointers(a, b, f"{path}/{i}"))
        return out
    return [] if old == new else [path]


def pointers_overlap(a: str, b: str) -> bool:
    """Changed path invalidates a read path when equal, ancestor or descendant (section 6)."""
    if a == b or a == "" or b == "":
        return True
    return a.startswith(b + "/") or b.startswith(a + "/")


def codepoint_slice(text: str, start: int, end: int) -> str:
    """Python str indexes are Unicode code points, matching the span contract."""
    if not (0 <= start <= end <= len(text)):
        raise ValueError("span out of range")
    return text[start:end]
