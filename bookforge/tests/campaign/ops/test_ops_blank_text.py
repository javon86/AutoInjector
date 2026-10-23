"""NEW-ui-5 (server side): a text field that must not be empty must not be only spaces either.

The oracle comes from the contracts, not the handlers: for every string in an operation's valid
CREATE payload (and OUTPUT record), if the schema refuses "" at that spot, it must refuse "   "
at the same spot with the same field-level error. Then, for every operation, each required
top-level text field set to spaces is refused end to end by the engine and nothing is written.
"""
from __future__ import annotations

import copy

import pytest

from bookforge.contracts import get_package

from conftest import errors_of
import opsgen

PKG = get_package()
OPS = list(PKG.operation_ids)
ALL_FEATURES = {"artwork": True, "magic": True, "mystery": True, "foreshadowing": True}
BLANK = "  \t \n "


def _string_leaves(node, path=()):
    if isinstance(node, str):
        yield path
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from _string_leaves(v, path + (k,))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _string_leaves(v, path + (i,))


def _set(doc, path, value):
    doc = copy.deepcopy(doc)
    node = doc
    for p in path[:-1]:
        node = node[p]
    node[path[-1]] = value
    return doc


def _ptr(prefix, path):
    return prefix + "".join("/" + str(p) for p in path)


def _request(op, payload):
    req = copy.deepcopy(opsgen.case(PKG, op, "CREATE-valid")["input"])
    req["payload"] = payload
    return req


def _blank_vs_empty(op, name, doc, prefix, wrap):
    """(checked, failures) comparing "" and BLANK at every string leaf of doc."""
    checked, failures = 0, []
    for path in _string_leaves(doc):
        ptr = _ptr(prefix, path)
        empty = {(e["code"], e["path"]): e["message"] for e in PKG.check(op, name, wrap(_set(doc, path, "")))}
        if ("INVALID_INPUT", ptr) not in empty:
            continue  # "" is allowed (or refused for another reason) here: nothing to compare
        checked += 1
        errs = PKG.check(op, name, wrap(_set(doc, path, BLANK)))
        hit = [e for e in errs if (e["code"], e["path"]) == ("INVALID_INPUT", ptr)]
        if not hit:
            failures.append(f"{op} {name} {ptr}: spaces accepted")
        elif "empty" not in empty[("INVALID_INPUT", ptr)]:
            pass  # a choice list / fixed value refuses "" with its own message; refused is what matters
        elif "empty" not in hit[0]["message"] or str([p for p in path if not isinstance(p, int)][-1]) not in hit[0]["message"]:
            failures.append(f"{op} {name} {ptr}: message is not field-level: {hit[0]['message']!r}")
    return checked, failures


@pytest.mark.parametrize("op", OPS)
def test_blank_text_is_refused_like_empty_text_by_the_contracts(op):
    checked = 0
    failures = []
    payload = opsgen.valid_payload(PKG, op)
    n, f = _blank_vs_empty(op, "CREATE", payload, "/payload", lambda p: _request(op, p))
    checked += n
    failures += f
    out = opsgen.valid_output(PKG, op)
    n, f = _blank_vs_empty(op, "OUTPUT", out, "", lambda d: d)
    checked += n
    failures += f
    assert failures == []
    assert checked > 0, f"{op}: no non-empty text field found to check"


def _required_text_fields(op):
    payload = opsgen.valid_payload(PKG, op)
    out = []
    for field in opsgen.create_required(PKG, op):
        if not isinstance(payload.get(field), str):
            continue
        errs = PKG.check(op, "CREATE", _request(op, dict(payload, **{field: ""})))
        hit = [e for e in errs if (e["code"], e["path"]) == ("INVALID_INPUT", f"/payload/{field}")]
        if hit:
            # free text (refused as "empty") or a choice/format field (refused by its own rule)
            out.append((field, "empty" in hit[0]["message"]))
    return out


REQUIRED_TEXT = [(op, f, free) for op in OPS for f, free in _required_text_fields(op)]


def test_there_are_required_text_fields_to_check():
    assert len({op for op, _, free in REQUIRED_TEXT if free}) >= 50, len(REQUIRED_TEXT)


@pytest.fixture
def hx(h):
    h.set_features(**ALL_FEATURES)
    return h


@pytest.mark.parametrize("op,field,free_text", REQUIRED_TEXT, ids=[f"{o}-{f}" for o, f, _ in REQUIRED_TEXT])
def test_engine_refuses_required_text_of_only_spaces(hx, op, field, free_text):
    payload = dict(opsgen.valid_payload(PKG, op), **{field: BLANK})
    before = hx.store.query_one("SELECT COUNT(*) c FROM records")["c"]
    r = hx.create(op, payload)
    assert r["status"] == "REJECTED", r["status"]
    assert ("INVALID_INPUT", f"/payload/{field}") in errors_of(r)
    if free_text:
        msg = next(e["message"] for e in r["errors"] if e["path"] == f"/payload/{field}")
        assert f"'{field}'" in msg and "empty" in msg, msg
    assert r["output_refs"] == [] and r["result"] is None
    assert hx.store.query_one("SELECT COUNT(*) c FROM records")["c"] == before


def test_manual_candidate_of_only_spaces_is_refused(hx):
    # the manual-form path validates the author's record against OUTPUT: blank text is refused there too
    op = "A01"
    out = opsgen.valid_output(PKG, op)
    path = next(p for p in _string_leaves(out)
                if ("INVALID_INPUT", _ptr("", p)) in {(e["code"], e["path"]) for e in PKG.check(op, "OUTPUT", _set(out, p, ""))})
    r = hx.dispatch(op, "CREATE", payload=opsgen.valid_payload(PKG, op), manual_candidate=_set(out, path, BLANK))
    assert r["status"] == "REJECTED"
    assert ("INVALID_INPUT", _ptr("/manual_candidate", path)) in errors_of(r)
