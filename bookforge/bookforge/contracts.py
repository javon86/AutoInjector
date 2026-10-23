"""Loads the delivered contract package (schemas, registries, cases) offline.

The package ships as package/contracts.zip (Contracts/ + Acceptance_Cases/ from the
BookForge Final Build Plan). Schemas are parsed lazily per operation because the full
set is ~70 MB of JSON. The bootstrap kernel loads these files before any I/K job runs.
"""
from __future__ import annotations

import json
import os
import threading
import zipfile
from functools import lru_cache
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker, ValidationError, validators

from . import CONTRACT_VERSION
from .canonical import json_pointer, sha256_bytes
from .errors import error

PACKAGE_DIR = Path(__file__).resolve().parent.parent / "package"
DEFAULT_ZIP = PACKAGE_DIR / "contracts.zip"

ACTIONS = ("CREATE", "UPDATE", "READ", "VALIDATE", "ACCEPT")
SETS = "ABCDEFGHIJK"

_base_min_length = Draft202012Validator.VALIDATORS["minLength"]


def _min_length_not_blank(validator, min_length, instance, schema):
    """minLength, plus: a text that must not be empty must not be only spaces either.

    Every required text field in the contracts carries minLength >= 1, so "   " used to pass
    where "" was refused (NEW-ui-5). A whitespace-only value now fails the same way as an
    empty one, for every operation, every action and the manual candidates.
    """
    yield from _base_min_length(validator, min_length, instance, schema)
    if (isinstance(instance, str) and instance and min_length >= 1 and not instance.strip()
            and validator.is_type(instance, "string")):
        yield ValidationError(f"{instance!r} is blank (only spaces)")


def _same_dialect(schema, _top=True):
    """Drop nested "$schema": "<2020-12>" markers (the package embeds shared schemas whole).

    They change nothing about the meaning, but jsonschema switches to its stock validator class at
    such a subschema, which would skip BookforgeValidator's own rules inside embedded references.
    """
    if isinstance(schema, dict):
        if not _top and schema.get("$schema") == Draft202012Validator.META_SCHEMA["$id"]:
            del schema["$schema"]
        for v in schema.values():
            _same_dialect(v, False)
    elif isinstance(schema, list):
        for v in schema:
            _same_dialect(v, False)
    return schema


# The validator class every contract check uses (Draft 2020-12 + the blank-text rule above).
BookforgeValidator = validators.extend(Draft202012Validator, {"minLength": _min_length_not_blank})


class ContractPackage:
    def __init__(self, zip_path: str | os.PathLike | None = None):
        self.zip_path = Path(zip_path or os.environ.get("BOOKFORGE_CONTRACTS_ZIP") or DEFAULT_ZIP)
        if not self.zip_path.exists():
            raise FileNotFoundError(
                f"Contract package not found at {self.zip_path}. "
                "Set BOOKFORGE_CONTRACTS_ZIP or restore bookforge/package/contracts.zip.")
        self._zip = zipfile.ZipFile(self.zip_path)
        self._lock = threading.Lock()
        self.package_sha256 = sha256_bytes(self.zip_path.read_bytes())
        self.operations = {o["id"]: o for o in self._json("Contracts/operation_registry.json")}
        self.operation_ids = sorted(self.operations)
        self.interface_registry = self._json("Contracts/interface_registry.json")
        self.predicate_registry = self._json("Contracts/predicate_registry.json")
        self.dependency_matrix = self._json("Contracts/dependency_matrix.json")
        self.artifact_registry = self._json("Contracts/artifact_registry.json")
        self._bindings: dict[str, list] = {}
        for b in self.interface_registry:
            self._bindings.setdefault(b["consumer_operation"], []).append(b)
        self._deps: dict[tuple, list] = {}
        for d in self.dependency_matrix:
            self._deps.setdefault((d["operation_id"], d["action"]), []).append(d)

    # ------------------------------------------------------------------ raw access
    def _read(self, name: str) -> bytes:
        with self._lock:
            return self._zip.read(name)

    def _json(self, name: str):
        return json.loads(self._read(name).decode("utf-8"))

    def names(self) -> list[str]:
        return self._zip.namelist()

    # ------------------------------------------------------------------ operations
    def operation(self, op_id: str) -> dict | None:
        return self.operations.get(op_id)

    @lru_cache(maxsize=256)
    def schema(self, op_id: str) -> dict:
        return _same_dialect(self._json(self.operations[op_id]["schema"]))

    @lru_cache(maxsize=256)
    def descriptor(self, op_id: str) -> dict:
        return self._json(self.operations[op_id]["schema"].replace(".schema.json", ".operations.json"))

    def definition(self, op_id: str, name: str) -> dict:
        return self.schema(op_id)["$defs"][name]

    @lru_cache(maxsize=1024)
    def validator(self, op_id: str, name: str) -> Draft202012Validator:
        full = dict(self.schema(op_id))
        full["$ref"] = f"#/$defs/{name}"
        return BookforgeValidator(full, format_checker=FormatChecker())

    @lru_cache(maxsize=64)
    def shared_schema(self, name: str) -> dict:
        return _same_dialect(self._json(f"Contracts/shared/{name}.schema.json"))

    @lru_cache(maxsize=64)
    def shared_validator(self, name: str) -> Draft202012Validator:
        return BookforgeValidator(self.shared_schema(name), format_checker=FormatChecker())

    def cases(self, op_id: str) -> list:
        return self._json(f"Acceptance_Cases/{op_id}.cases.json")

    def extra_cases(self, name: str):
        return self._json(f"Acceptance_Cases/{name}")

    def bindings(self, op_id: str) -> list:
        return self._bindings.get(op_id, [])

    def dependencies(self, op_id: str, action: str = "CREATE") -> list:
        return self._deps.get((op_id, action), [])

    def artifact_entry(self, producer: str) -> dict | None:
        for a in self.artifact_registry:
            if a["producer"] == producer:
                return a
        return None

    # ------------------------------------------------------------------ validation
    def check(self, op_id: str, name: str, instance) -> list[dict]:
        return schema_errors(self.validator(op_id, name), instance)

    def check_shared(self, name: str, instance) -> list[dict]:
        return schema_errors(self.shared_validator(name), instance)


def schema_errors(validator: Draft202012Validator, instance) -> list[dict]:
    """Convert jsonschema errors into contract errors with exact JSON Pointer paths.

    Missing required properties -> MISSING_INPUT at the missing property's path;
    unsupported fields -> INVALID_INPUT at the unknown field; anything else INVALID_INPUT.
    """
    out: dict[tuple, dict] = {}
    for err in validator.iter_errors(instance):
        _collect(err, out)
    # Deterministic order: missing inputs first, then by path.
    return sorted(out.values(), key=lambda e: (e["code"] != "MISSING_INPUT", e["path"]))


def _collect(err, out: dict):
    base = list(err.absolute_path)
    if err.validator == "required":
        inst = err.instance if isinstance(err.instance, dict) else {}
        for name in err.validator_value:
            if name not in inst:
                p = json_pointer(base + [name])
                out.setdefault(("MISSING_INPUT", p), error("MISSING_INPUT", p, f"required field '{name}' is missing"))
        return
    if err.validator == "additionalProperties" and isinstance(err.instance, dict):
        allowed = set(err.schema.get("properties", {}))
        for name in err.instance:
            if name not in allowed:
                p = json_pointer(base + [name])
                out.setdefault(("INVALID_INPUT", p), error("INVALID_INPUT", p, f"unsupported field '{name}'"))
        return
    if err.validator in ("oneOf", "anyOf") and err.context:
        # Report the most specific branch failure when every branch failed the same way.
        best = min(err.context, key=lambda e: (-len(e.absolute_path), str(e.message)))
        if len(best.absolute_path) > len(err.absolute_path):
            _collect(best, out)
            return
    p = json_pointer(base)
    if err.validator == "minLength" and isinstance(err.instance, str) and not err.instance.strip():
        field = next((str(x) for x in reversed(base) if not isinstance(x, int)), "this field")
        # takes precedence over a pattern/format complaint at the same spot: "it's empty" is the useful message
        out[("INVALID_INPUT", p)] = error("INVALID_INPUT", p,
                                          f"'{field}' is empty: please type some text (spaces alone don't count)")
        return
    if err.validator == "const" and base and base[-1] == "contract_version":
        out.setdefault(("UNSUPPORTED_CONTRACT", p), error("UNSUPPORTED_CONTRACT", p, "unsupported contract_version"))
        return
    msg = err.message if len(err.message) < 300 else err.message[:297] + "..."
    out.setdefault(("INVALID_INPUT", p), error("INVALID_INPUT", p, msg))


_PACKAGE: ContractPackage | None = None
_PACKAGE_LOCK = threading.Lock()


def get_package() -> ContractPackage:
    global _PACKAGE
    with _PACKAGE_LOCK:
        if _PACKAGE is None:
            _PACKAGE = ContractPackage()
        return _PACKAGE


__all__ = ["ContractPackage", "BookforgeValidator", "get_package", "schema_errors", "ACTIONS", "SETS", "CONTRACT_VERSION"]
