"""Shared pytest fixtures: a fresh store/engine/project per test and a dispatch helper."""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
# 💾 P20: the test suite never saves into the real Documents folder, and auto-save is off unless a test turns it on
# (tests/test_section6.py does, with its own books folder per test).
os.environ.setdefault("BOOKFORGE_BOOKS_DIR", str(Path(tempfile.gettempdir()) / f"bookforge-test-books-{os.getpid()}"))
os.environ.setdefault("BOOKFORGE_AUTOSAVE", "0")
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from bookforge.contracts import get_package  # noqa: E402
from bookforge.engine import Engine  # noqa: E402
from bookforge.requests import build_request, candidate_payload  # noqa: E402
from bookforge.store import Store  # noqa: E402

PRINCIPAL = "author-1"


class Harness:
    """Thin wrapper so tests read like the workflow: create -> validate -> accept."""

    def __init__(self, engine: Engine, project_id: str, branch_id: str = "main", principal: str = PRINCIPAL):
        self.engine = engine
        self.store = engine.store
        self.project_id = project_id
        self.branch_id = branch_id
        self.principal = principal

    def request(self, op, action, **kw):
        return build_request(project_id=self.project_id, branch_id=self.branch_id, op_id=op, action=action,
                             principal_id=self.principal, **kw)

    def dispatch(self, op, action, *, manual_candidate=None, principal=None, **kw):
        req = self.request(op, action, **kw)
        if principal:
            req["principal_id"] = principal
        return self.engine.dispatch(req, principal or self.principal, manual_candidate=manual_candidate)

    def create(self, op, payload, **kw):
        return self.dispatch(op, "CREATE", payload=payload, **kw)

    def validate(self, ref, approval_ref=None):
        return self.dispatch(ref["module_id"], "VALIDATE", base_ref=ref, payload=candidate_payload(ref, approval_ref))

    def accept(self, ref, approval_ref=None):
        return self.dispatch(ref["module_id"], "ACCEPT", base_ref=ref, payload=candidate_payload(ref, approval_ref))

    def approve(self, ref, approval_ref=None):
        """VALIDATE then ACCEPT; returns the ACCEPT response."""
        v = self.validate(ref, approval_ref)
        assert v["status"] in ("VALIDATED", "APPROVED"), v
        return self.accept(ref, approval_ref)

    def create_approved(self, op, payload=None, manual_candidate=None, **kw):
        r = self.dispatch(op, "CREATE", payload=payload or {}, manual_candidate=manual_candidate, **kw)
        assert r["status"] == "DRAFT", r
        ref = r["output_refs"][0]
        a = self.approve(ref)
        assert a["status"] == "APPROVED", a
        return ref, r

    def record(self, ref):
        return self.store.get_record(ref["project_id"], ref["branch_id"], ref["record_id"], ref["version"])

    def set_features(self, **features):
        m = dict(self.store.feature_manifest(self.project_id, self.branch_id))
        m["features"] = dict(m["features"], **features)
        return self.engine.set_manifest(self.principal, self.project_id, self.branch_id, m)


@pytest.fixture(scope="session")
def contracts():
    return get_package()


@pytest.fixture
def engine(tmp_path, contracts):
    store = Store(tmp_path / "data")
    eng = Engine(store, contracts)
    eng.providers.secret_path = tmp_path / "secrets.json"
    yield eng
    store.close()


@pytest.fixture
def h(engine):
    pid = engine.bootstrap_project(PRINCIPAL, "Test Book")
    return Harness(engine, pid)


def errors_of(resp):
    return [(e["code"], e["path"]) for e in resp["errors"]]
