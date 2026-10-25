"""📦 ``book.bookforge``: one book as a complete, re-importable package (P20 save / P21 open).

Format (a ZIP file, ``schema_version`` 1):

    manifest.json          {format: "bookforge-package", schema_version, app_version, contract_version,
                            store_schema_version, saved_at, project_id, title, name, counts, files: {path: sha256}}
    book/tables.json       every row of the book in the storage kernel (projects, branches, feature manifests,
                           records with ALL their versions, binaries, lifecycle, heads, receipts, audit, provenance,
                           dependency edges, checkpoints, module state, approvals, activity events) as
                           ``Store.export_project_rows`` reads them in one snapshot
    book/settings.json     the book's companion settings (book profile, path memory, character sheets, scene cards,
                           story rules, world texture, reviews, reports, pipeline …) and its Make-a-book / Write-all
                           runs (``job:<id>``)
    assets/<sha256>.bin    the bytes of every stored file the book uses (exports, imports), content-addressed
    book-bible.json        the book bible (for people and for 🔁 Rerun; not needed to open the package)

Every file is listed in the manifest with its SHA-256; opening checks each one, every record's content hash and every
asset's hash before anything is written, and refuses a newer ``schema_version`` (``OPEN_NEWER_VERSION``).

Opening is always a NEW book (``import_package``): a new project id, new ids for the kernel's global ids (audit,
provenance, approvals, events, edges, checkpoints) and the runs, and every record's content rewritten for the new
project — records are hashed with their project id, so each content hash (and every reference to it, in later
records, approvals, the path memory and the companion settings) is recomputed in dependency order. Record IDs and
versions are kept, so the companion data keyed by record ID needs no change. What cannot be recomputed: an
approval's ``action_hash`` (a hash over the action as it was signed) keeps its old value — it is history only.

Keys, the access token and prompts are never in a package: secrets live outside the database, and the text is
checked against the saved secrets before it is written (``guard``).
"""
from __future__ import annotations

import io
import json
import logging
import re
import uuid
import zipfile

from . import CONTRACT_VERSION, __version__
from .canonical import canonical_bytes, sha256_bytes
from .errors import BookforgeError
from .jobs import now_iso
from .store import SCHEMA_VERSION as STORE_SCHEMA_VERSION

log = logging.getLogger("bookforge.book_package")

FORMAT = "bookforge-package"
SCHEMA_VERSION = 1
MAX_PACKAGE_BYTES = 512 * 1024 * 1024     # a package file larger than this is refused
MAX_UNPACKED = 1024 * 1024 * 1024         # the sum of the entries' sizes (zip bombs)
MAX_ENTRIES = 50000
SKIP_SETTINGS = ("book_folder:", "book_save:", "rerun_bible:")   # this computer's own state, never copied
KEEP_JOBS = ("autobook", "write_all")
LIVE = ("queued", "running", "waiting", "pausing", "paused", "interrupted")
OPENED_PHASE = ("Opened from a saved book — press ▶ Resume to go on where it stopped (or ▶ Continue making this book "
                "on the book page).")
HASH_RE = re.compile(r"[0-9a-f]{64}")
ID_RE = re.compile(r"[A-Za-z]+-[0-9a-f]{8,40}")


class PackageProblem(Exception):
    """A package that cannot be opened: ``code`` is a problems.js code (OPEN_BAD_PACKAGE, OPEN_NEWER_VERSION,
    OPEN_TOO_LARGE)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ====================================================================== secrets guard
def secrets_of(app) -> list[str]:
    """The saved API keys / connection keys and the access token (never written into a save)."""
    try:
        from .diagnostics import _secrets  # noqa: PLC0415
        return _secrets(app)
    except Exception:  # noqa: BLE001
        return [app.token] if getattr(app, "token", None) else []


def guard(text: str, secrets: list[str]) -> str:
    for s in secrets:
        if s and s in text:
            text = text.replace(s, "[redacted]")
    return text


# ====================================================================== build
def _dump(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def package_rows(store, pid: str) -> dict:
    """The book's rows and settings for a package (this computer's own state and other kinds of jobs left out)."""
    rows = store.export_project_rows(pid)
    keep = []
    for s in rows["settings"]:
        k = s["key"]
        if k.startswith(SKIP_SETTINGS):
            continue
        if k.startswith("job:"):
            v = s["value"] if isinstance(s["value"], dict) else {}
            if v.get("kind") not in KEEP_JOBS:
                continue
        keep.append(s)
    rows["settings"] = keep
    return rows


def build(app, pid: str, *, bible: dict | None = None, on_progress=None) -> bytes:
    """The package bytes for one book (read-only)."""
    store = app.store
    rows = package_rows(store, pid)
    proj = (rows["tables"].get("projects") or [{}])[0]
    secrets = secrets_of(app)
    tables_b = guard(_dump({"tables": rows["tables"]}).decode("utf-8"), secrets).encode("utf-8")
    settings_b = guard(_dump({"settings": rows["settings"]}).decode("utf-8"), secrets).encode("utf-8")
    entries: list[tuple[str, bytes, int]] = [("book/tables.json", tables_b, zipfile.ZIP_DEFLATED),
                                             ("book/settings.json", settings_b, zipfile.ZIP_DEFLATED)]
    for i, name in enumerate(rows["assets"]):
        data = (store.asset_dir / name).read_bytes()
        if sha256_bytes(data) != name.split(".", 1)[0]:
            raise BookforgeError("HASH_MISMATCH", "/assets", "a stored file of this book is damaged (its bytes do not "
                                 "match its fingerprint); restore a backup, then save again")
        entries.append((f"assets/{name}", data, zipfile.ZIP_STORED))
        if on_progress:
            on_progress(i + 1, len(rows["assets"]))
    if bible is not None:
        entries.append(("book-bible.json", guard(json.dumps(bible, ensure_ascii=False, indent=2), secrets)
                        .encode("utf-8"), zipfile.ZIP_DEFLATED))
    title = None
    for s in rows["settings"]:
        if s["key"] == f"book_profile:{pid}" and isinstance(s["value"], dict):
            title = s["value"].get("title")
    manifest = {"format": FORMAT, "schema_version": SCHEMA_VERSION, "app": "BookForge", "app_version": __version__,
                "contract_version": CONTRACT_VERSION, "store_schema_version": STORE_SCHEMA_VERSION,
                "saved_at": now_iso(), "project_id": pid, "name": proj.get("name"), "title": title or proj.get("name"),
                "counts": {"records": len(rows["tables"].get("records") or []),
                           "binaries": len(rows["tables"].get("binaries") or []),
                           "settings": len(rows["settings"]), "assets": len(rows["assets"])},
                "files": {n: sha256_bytes(d) for n, d, _c in entries}}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(zipfile.ZipInfo("manifest.json", date_time=(1980, 1, 1, 0, 0, 0)),
                    json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"), zipfile.ZIP_DEFLATED)
        for name, data, comp in entries:
            zf.writestr(zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0)), data, comp)
    return buf.getvalue()


# ====================================================================== read + check
def is_package(data: bytes) -> bool:
    return bytes(data[:4]) == b"PK\x03\x04"


def read(data: bytes) -> dict:
    """Open and check a package (nothing is written). Returns {manifest, tables, settings, assets {name: bytes},
    bible?}. Raises PackageProblem."""
    if len(data) > MAX_PACKAGE_BYTES:
        raise PackageProblem("OPEN_TOO_LARGE", "this book package is larger than 512 MB")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
        infos = zf.infolist()
    except (zipfile.BadZipFile, OSError, ValueError):
        raise PackageProblem("OPEN_BAD_PACKAGE", "this file is not a BookForge book package (book.bookforge), or it "
                             "is damaged (it was perhaps not copied completely)") from None
    if len(infos) > MAX_ENTRIES or sum(i.file_size for i in infos) > MAX_UNPACKED:
        raise PackageProblem("OPEN_TOO_LARGE", "this book package is too large to open")
    names = {i.filename for i in infos}
    for n in names:
        if n.startswith("/") or "\\" in n or ".." in n.split("/"):
            raise PackageProblem("OPEN_BAD_PACKAGE", "the book package holds a file with an unsafe name")
    try:
        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
    except (KeyError, ValueError, UnicodeDecodeError, zipfile.BadZipFile, OSError):
        raise PackageProblem("OPEN_BAD_PACKAGE", "the book package has no readable manifest.json (it is damaged or "
                             "not a BookForge package)") from None
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        raise PackageProblem("OPEN_BAD_PACKAGE", "this is not a BookForge book package")
    sv = manifest.get("schema_version")
    if not isinstance(sv, int) or isinstance(sv, bool) or sv < 1:
        raise PackageProblem("OPEN_BAD_PACKAGE", "the book package has no valid schema_version")
    ssv = manifest.get("store_schema_version")
    if sv > SCHEMA_VERSION or (isinstance(ssv, int) and ssv > STORE_SCHEMA_VERSION):
        raise PackageProblem("OPEN_NEWER_VERSION", f"this book was saved by a newer BookForge (package format {sv}; "
                             f"this BookForge opens format {SCHEMA_VERSION} and older)")
    files = manifest.get("files")
    if not isinstance(files, dict) or "book/tables.json" not in files or "book/settings.json" not in files:
        raise PackageProblem("OPEN_BAD_PACKAGE", "the book package's manifest does not list its files")
    blobs = {}
    for name, digest in files.items():
        if name not in names:
            raise PackageProblem("OPEN_BAD_PACKAGE", f"the book package is missing {name} (it was not copied "
                                 "completely)")
        try:
            b = zf.read(name)
        except (zipfile.BadZipFile, OSError, KeyError, ValueError):
            raise PackageProblem("OPEN_BAD_PACKAGE", f"{name} in the book package cannot be read (damaged)") from None
        if sha256_bytes(b) != digest:
            raise PackageProblem("OPEN_BAD_PACKAGE", f"{name} in the book package does not match its checksum (the "
                                 "file is damaged or was changed)")
        blobs[name] = b
    try:
        tables = json.loads(blobs["book/tables.json"].decode("utf-8"))["tables"]
        settings = json.loads(blobs["book/settings.json"].decode("utf-8"))["settings"]
    except (ValueError, KeyError, TypeError, UnicodeDecodeError):
        raise PackageProblem("OPEN_BAD_PACKAGE", "the book's data in the package cannot be read") from None
    if not isinstance(tables, dict) or not isinstance(settings, list):
        raise PackageProblem("OPEN_BAD_PACKAGE", "the book's data in the package has the wrong shape")
    pid = manifest.get("project_id")
    projects = tables.get("projects") or []
    if not isinstance(pid, str) or len(projects) != 1 or projects[0].get("project_id") != pid:
        raise PackageProblem("OPEN_BAD_PACKAGE", "the package does not hold exactly one book")
    assets = {n.split("/", 1)[1]: b for n, b in blobs.items() if n.startswith("assets/")}
    for name, b in assets.items():
        if not re.fullmatch(r"[0-9a-f]{64}\.bin", name) or sha256_bytes(b) != name[:64]:
            raise PackageProblem("OPEN_BAD_PACKAGE", "a stored file in the package does not match its fingerprint")
    # every record's content must still hash to its content hash; every binary must have its bytes
    for r in tables.get("records") or []:
        if not isinstance(r, dict) or r.get("project_id") != pid:
            raise PackageProblem("OPEN_BAD_PACKAGE", "the package's records do not belong to its book")
        c = r.get("content")
        if not isinstance(c, dict) or "$blob" not in c:
            raise PackageProblem("OPEN_BAD_PACKAGE", "a record in the package has no readable content")
        if r.get("representation") == "JSON_RECORD" and sha256_bytes(str(c["$blob"]).encode("utf-8")) != \
                r.get("content_hash"):
            raise PackageProblem("OPEN_BAD_PACKAGE", f"record {r.get('record_id')} version {r.get('version')} in the "
                                 "package was changed (it does not match its fingerprint)")
    for b in tables.get("binaries") or []:
        name = str(b.get("storage_uri") or "").split("/")[-1]
        if name not in assets:
            raise PackageProblem("OPEN_BAD_PACKAGE", f"the file of {b.get('record_id')} is missing from the package")
    bible = None
    if "book-bible.json" in blobs:
        try:
            bible = json.loads(blobs["book-bible.json"].decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            bible = None
    return {"manifest": manifest, "tables": tables, "settings": settings, "assets": assets, "bible": bible}


# ====================================================================== open as a NEW book
def _new_id(old: str) -> str:
    m = re.fullmatch(r"([A-Za-z]+)-([0-9a-f]+)", old)
    if m:
        n = len(m.group(2))
        return f"{m.group(1)}-{(uuid.uuid4().hex + uuid.uuid4().hex)[:n]}"
    return f"{old}-{uuid.uuid4().hex[:8]}"


class _Rewriter:
    """Text rewriting for the new book: the project id, the global ids and the recomputed content hashes."""

    def __init__(self, old_pid: str, new_pid: str, ids: dict):
        self.old_pid, self.new_pid = old_pid, new_pid
        self.ids = ids
        self.odd = {k: v for k, v in ids.items() if not ID_RE.fullmatch(k)}
        self.hashes: dict[str, str] = {}

    def __call__(self, text: str) -> str:
        if not isinstance(text, str) or not text:
            return text
        text = text.replace(self.old_pid, self.new_pid)
        if self.ids:
            text = ID_RE.sub(lambda m: self.ids.get(m.group(0), m.group(0)), text)
            for k, v in self.odd.items():
                text = text.replace(k, v)
        if self.hashes:
            text = HASH_RE.sub(lambda m: self.hashes.get(m.group(0), m.group(0)), text)
        return text

    def value(self, v):
        if isinstance(v, str):
            return self(v)
        if isinstance(v, dict) and "$blob" in v:
            return {"$blob": self(str(v["$blob"]))}
        return v


def transplant(pkg: dict, new_pid: str, principal: str, *, name: str | None = None) -> tuple[dict, list, dict]:
    """The package's rows and settings rewritten for ``new_pid`` (see the module docstring). Returns (tables,
    settings, info {ids, hashes, jobs})."""
    old_pid = pkg["manifest"]["project_id"]
    tables = {t: [dict(r) for r in rows] for t, rows in pkg["tables"].items()}
    ids: dict[str, str] = {}
    for t, col in (("audit", "audit_id"), ("provenance", "provenance_id"), ("outbox", "event_id"),
                   ("approvals", "approval_id"), ("dependency_edges", "edge_id"), ("checkpoints", "checkpoint_id")):
        for r in tables.get(t) or []:
            v = r.get(col)
            if isinstance(v, str) and v and v not in ids:
                ids[v] = _new_id(v)
    for s in pkg["settings"]:
        if s["key"].startswith("job:"):
            jid = s["key"][4:]
            if jid and jid not in ids:
                ids[jid] = _new_id(jid)
    rw = _Rewriter(old_pid, new_pid, ids)
    # 1. JSON records in dependency order: a record's content holds the content hashes of the records it refers to
    recs = tables.get("records") or []
    json_hashes = {r["content_hash"]: r for r in recs if r.get("representation") == "JSON_RECORD"}
    deps = {h: set(HASH_RE.findall(str(r["content"]["$blob"]))) & set(json_hashes) - {h}
            for h, r in json_hashes.items()}
    done: set = set()

    def visit(h, stack=()):
        if h in done:
            return
        if h in stack:
            raise PackageProblem("OPEN_BAD_PACKAGE", "the package's records refer to each other in a circle")
        for d in sorted(deps[h]):
            visit(d, stack + (h,))
        r = json_hashes[h]
        text = rw(str(r["content"]["$blob"]))
        try:
            new_bytes = canonical_bytes(json.loads(text))
        except ValueError:
            raise PackageProblem("OPEN_BAD_PACKAGE", f"record {r.get('record_id')} cannot be read") from None
        new_hash = sha256_bytes(new_bytes)
        rw.hashes[h] = new_hash
        r["content"] = {"$blob": new_bytes.decode("utf-8")}
        r["content_hash"] = new_hash
        done.add(h)
    for h in sorted(json_hashes):
        visit(h)
    for r in recs:
        for k, v in list(r.items()):
            if k in ("content", "content_hash") and r.get("representation") == "JSON_RECORD":
                continue
            r[k] = rw.value(v)
    # 2. everything else, with every hash known now
    for t, rows in tables.items():
        if t == "records":
            continue
        for r in rows:
            for k, v in list(r.items()):
                r[k] = rw.value(v)
    for r in tables.get("outbox") or []:
        try:
            r["payload_hash"] = sha256_bytes(canonical_bytes(json.loads(r["payload"])))
        except (ValueError, TypeError):
            pass
    for r in tables.get("feature_manifests") or []:
        try:
            r["content_hash"] = sha256_bytes(canonical_bytes(json.loads(r["manifest"])))
        except (ValueError, TypeError):
            pass
    proj = tables["projects"][0]
    proj["owner_id"] = principal
    proj["archived"] = 0
    if name:
        proj["name"] = name
    # 3. settings
    settings, jobs = [], []
    for s in pkg["settings"]:
        k = s["key"]
        if not isinstance(k, str) or k.startswith(SKIP_SETTINGS):
            continue
        try:
            val = json.loads(rw(json.dumps(s["value"], ensure_ascii=False)))
        except ValueError:
            continue
        nk = rw(k)
        if k.startswith("job:"):
            if not isinstance(val, dict) or val.get("kind") not in KEEP_JOBS:
                continue
            val["principal"] = principal
            val["opened_from_package"] = True
            if val.get("status") in LIVE:
                val["status"], val["phase"], val["waiting"] = "interrupted", OPENED_PHASE, None
            jobs.append({"id": val.get("id"), "kind": val.get("kind"), "status": val.get("status")})
        settings.append({"key": nk, "value": val})
    return tables, settings, {"ids": len(ids), "hashes": len(rw.hashes), "jobs": jobs}


def import_package(app, data: bytes, principal: str) -> dict:
    """Open a package as a NEW book. Returns {project_id, branch_id, name, title, jobs, manifest}."""
    pkg = read(data)
    store = app.store
    old = pkg["tables"]["projects"][0]
    title = None
    for s in pkg["settings"]:
        if s["key"] == f"book_profile:{pkg['manifest']['project_id']}" and isinstance(s["value"], dict):
            title = s["value"].get("title")
    name = str(old.get("name") or title or "Opened book")
    taken = {r["name"] for r in store.query("SELECT name FROM projects")}
    if name in taken:
        name = f"{name} (opened)"
        n = 2
        while name in taken:
            name = f"{str(old.get('name') or 'Opened book')} (opened {n})"
            n += 1
    new_pid = f"proj-{uuid.uuid4().hex[:12]}"
    tables, settings, info = transplant(pkg, new_pid, principal, name=name[:200])
    for fname, b in pkg["assets"].items():
        store.write_asset(b, fname[:64])
    store.import_project_rows(tables, settings, principal_id=principal)
    problems = verify(store, new_pid)
    if problems:  # never leave a half-usable book behind
        try:
            store.delete_project(new_pid)
        except Exception:  # noqa: BLE001
            log.exception("could not remove the half-opened book %s", new_pid)
        raise PackageProblem("OPEN_FAILED", "the opened book did not check out: " + "; ".join(problems[:3]))
    branches = [r["branch_id"] for r in tables.get("branches") or []]
    return {"project_id": new_pid, "branch_id": "main" if "main" in branches else (branches[0] if branches else "main"),
            "name": name, "title": title or name, "jobs": info["jobs"], "manifest": pkg["manifest"]}


def verify(store, pid: str) -> list[str]:
    """Every record of the opened book hashes to its content hash; every file it uses is there and intact."""
    out = []
    for r in store.query("SELECT record_id, version, representation, content, content_hash FROM records WHERE "
                         "project_id=?", (pid,)):
        if r["representation"] == "JSON_RECORD" and sha256_bytes(r["content"]) != r["content_hash"]:
            out.append(f"record {r['record_id']}@{r['version']} does not match its hash")
    for r in store.query("SELECT record_id, storage_uri, content_hash FROM binaries WHERE project_id=?", (pid,)):
        p = store.asset_dir / str(r["storage_uri"]).split("/")[-1]
        try:
            if sha256_bytes(p.read_bytes()) != r["content_hash"]:
                out.append(f"file of {r['record_id']} is damaged")
        except OSError:
            out.append(f"file of {r['record_id']} is missing")
    return out
