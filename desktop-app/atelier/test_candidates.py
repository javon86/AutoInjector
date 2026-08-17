#!/usr/bin/env python3
"""
test_candidates.py — regression suite for ISS-003 / ISS-004.

ISS-003: CH04/CH05 stored as prose summary. Reported 65, findable 29.
ISS-004: CH06 never extracted at all.
Both passed every gate, because no gate read the ledger.

    python test_candidates.py [-v] [--prove]
"""
from __future__ import annotations
import argparse, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
S, F = "}-----< Start >-----{", "}-----< finish >-----{"
_r: list[tuple[str, bool, str]] = []

REC = ("- id: CAND-{n:04d}  entity: E  property: P\n"
       "  value: \"v\"  status: proposed\n")


def run(*a, cwd=None, timeout=60):
    try:
        p = subprocess.run([sys.executable, str(HERE / "check_candidates.py"), *a],
                           cwd=cwd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise AssertionError(f"checker timed out after {timeout}s")
    return p.returncode, p.stdout, p.stderr


def case(name):
    def deco(fn):
        def w():
            with tempfile.TemporaryDirectory() as td:
                try: fn(Path(td)); _r.append((name, True, ""))
                except AssertionError as e: _r.append((name, False, str(e)))
                except Exception as e: _r.append((name, False, f"{type(e).__name__}: {e}"))
        return w
    return deco


def project(td: Path, chapters: int, ledger: str) -> Path:
    code = subprocess.run([sys.executable, str(HERE / "init_project.py"),
                           "Cand Check", "--chapters", "6"], cwd=td,
                          capture_output=True, text=True, timeout=60).returncode
    assert code == 0, "scaffold failed"
    proj = td / "cand-check"
    for n in range(1, chapters + 1):
        d = proj / "04_CHAPTERS" / f"ch{n:02d}" / "scenes"
        d.mkdir(parents=True, exist_ok=True)
        (d / "s01.md").write_text(f"{S}\nProse {n}.\n{F}\n", encoding="utf-8")
    (proj / "03_MEMORY" / "CANDIDATES.md").write_text(ledger, encoding="utf-8")
    return proj


def ledger(sections: dict[str, list[int]], extra: str = "") -> str:
    out = ["# CANON CANDIDATES\n"]
    for ch, ids in sections.items():
        out.append(f"\n## From {ch}-S01\n\n```yaml\n")
        for n in ids:
            out.append(REC.format(n=n))
        out.append("```\n")
    return "".join(out) + extra


# --- the exact ISS-003 condition -------------------------------------------
@case("ISS-003: prose-summary storage is rejected")
def t1(td: Path):
    led = ledger({"CH01": [1, 2], "CH02": [3, 4]})
    led += ("\n## From CH03-S01\n\nSee scene handoff blocks for full YAML. "
            "Summary: several facts about the survey.\n")
    proj = project(td, 3, led)
    code, _, err = run(str(proj))
    assert code == 1, f"prose summary must be rejected, got {code}"
    assert "prose-summary storage" in err, err
    assert "CH03" in err, err


# --- the exact ISS-004 condition -------------------------------------------
@case("ISS-004: a drafted-but-unextracted chapter is S1")
def t2(td: Path):
    proj = project(td, 3, ledger({"CH01": [1], "CH02": [2]}))
    code, _, err = run(str(proj))
    assert code == 1, f"missing extraction must fail, got {code}"
    assert "CH03" in err and "NEVER EXTRACTED" in err, err


@case("count is ESTABLISHED from the artifact, never reported")
def t3(td: Path):
    proj = project(td, 2, ledger({"CH01": [1, 2, 3], "CH02": [4, 5]}))
    code, out, _ = run(str(proj))
    assert code == 0, "well-formed ledger must pass"
    assert "structured records : 5" in out, out
    assert "chapters extracted : 2" in out and "chapters drafted   : 2" in out, out


@case("duplicate ids are S1")
def t4(td: Path):
    proj = project(td, 2, ledger({"CH01": [1, 2], "CH02": [2, 3]}))
    code, _, err = run(str(proj))
    assert code == 1 and "[DUPLICATE]" in err, err


@case("malformed record missing required fields is S2")
def t5(td: Path):
    led = ("# C\n\n## From CH01-S01\n\n```yaml\n"
           "- id: CAND-0001  entity: E  property: P\n  value: \"v\"  status: proposed\n"
           "- id: CAND-0002\n  note: no entity, no value, no status\n```\n")
    proj = project(td, 1, led)
    code, _, err = run(str(proj))
    assert code == 1, "malformed record must fail"
    assert "CAND-0002" in err and "missing" in err, err


@case("malformed record does not inherit the next record's fields")
def t5b(td: Path):
    """
    Regression for a window-bleed bug in the checker itself: a fixed-size parse
    window read forward into the FOLLOWING record, so a malformed entry
    inherited its neighbour's fields and passed. Found by an isolated fixture,
    not by the suite — the suite's own malformed case happened to be last.
    """
    led = ("# C\n\n## From CH01-S01\n\n```yaml\n"
           "- id: CAND-0001\n  note: nothing required here\n"
           "- id: CAND-0002  entity: E  property: P\n"
           "  value: \"v\"  status: proposed\n```\n")
    proj = project(td, 1, led)
    code, _, err = run(str(proj))
    assert code == 1, "malformed first record must fail"
    assert "CAND-0001" in err and "missing" in err, \
        f"malformed record inherited the next record's fields: {err}"


@case("ID GRAMMAR: canonical id passes; XX / 7 / padded variants fail")
def idg(td: Path):
    """
    ID syntax is its own validation surface and runs BEFORE field validation.
    A malformed token must not be made to look usable by passing field checks.
    """
    # "CAND-" alone is not a parseable record token at all, so it fails
    # earlier and differently (the section reads as empty). Grammar cases here
    # are tokens that DO parse but violate the canonical width/charset.
    cases = {"CAND-0001": False, "CAND-XX": True, "CAND-7": True,
             "CAND-00001": True, "CAND-001": True}
    for cid, should_fail in cases.items():
        led = ("# C\n\n## From CH01-S01\n\n```yaml\n"
               f"- id: {cid}  entity: E  property: P\n"
               "  value: \"v\"  status: proposed\n```\n")
        with tempfile.TemporaryDirectory() as sub:
            proj = project(Path(sub), 1, led)
            code, _, err = run(str(proj))
            if should_fail:
                assert code == 1, f"{cid} must FAIL"
                assert "[ID SYNTAX]" in err, f"{cid} not reported as ID syntax: {err}"
            else:
                assert code == 0, f"canonical {cid} must PASS: {err}"


@case("ID GRAMMAR gates first: a malformed id SKIPS record validation")
def idg2(td: Path):
    """A record with a bad id AND missing fields reports the ID surface only —
    field validation must not run and make the token appear usable."""
    led = ("# C\n\n## From CH01-S01\n\n```yaml\n"
           "- id: CAND-XX\n  note: no entity, no property, no value, no status\n```\n")
    proj = project(td, 1, led)
    code, _, err = run(str(proj))
    assert code == 1
    assert "[ID SYNTAX]" in err, err
    assert "[RECORD]" not in err, \
        f"record validation ran on a malformed id: {err}"


@case("three surfaces are reported distinctly, never conflated")
def idg3(td: Path):
    led = ("# C\n\n## From CH01-S01\n\n```yaml\n"
           "- id: CAND-0001  entity: E  property: P\n  value: \"v\"  status: proposed\n"
           "- id: CAND-0001  entity: E  property: P\n  value: \"v\"  status: proposed\n"
           "- id: CAND-0002\n  note: missing everything\n"
           "- id: CAND-XX  entity: E  property: P\n  value: \"v\"  status: proposed\n```\n")
    proj = project(td, 1, led)
    code, _, err = run(str(proj))
    assert code == 1
    assert "[ID SYNTAX]" in err and "CAND-XX" in err
    assert "[RECORD]" in err and "CAND-0002" in err
    assert "[DUPLICATE]" in err and "CAND-0001" in err


@case("malformed ID TOKEN is rejected — distinct from a malformed record")
def t5c(td: Path):
    """
    A record can be structurally complete and still carry an unusable
    identifier. CAND-7 (unpadded), CAND-XX (non-numeric) and CAND-00001
    (over-padded) all parse as records; none is a valid ID.
    """
    led = ("# C\n\n## From CH01-S01\n\n```yaml\n"
           "- id: CAND-0001  entity: E  property: P\n  value: \"v\"  status: proposed\n"
           "- id: CAND-7  entity: E  property: P\n  value: \"v\"  status: proposed\n"
           "- id: CAND-XX  entity: E  property: P\n  value: \"v\"  status: proposed\n"
           "- id: CAND-00002  entity: E  property: P\n  value: \"v\"  status: proposed\n```\n")
    proj = project(td, 1, led)
    code, _, err = run(str(proj))
    assert code == 1, "malformed IDs must fail"
    for bad in ("CAND-7", "CAND-XX", "CAND-00002"):
        assert bad in err and "[ID SYNTAX]" in err, f"{bad} not rejected: {err}"
    assert "CAND-0001" not in err.replace("CAND-00012", ""), \
        "the well-formed id was wrongly flagged"


@case("gaps in the id sequence are reported")
def t6(td: Path):
    proj = project(td, 1, ledger({"CH01": [1, 2, 5]}))
    code, _, err = run(str(proj))
    assert code == 1 and "sequence gaps" in err and "CAND-0003" in err, err


@case("a sound ledger passes clean")
def t7(td: Path):
    proj = project(td, 3, ledger({"CH01": [1, 2], "CH02": [3], "CH03": [4, 5]}))
    code, out, err = run(str(proj))
    assert code == 0, f"sound ledger must pass: {err}"
    assert "findings           : 0" in out, out


@case("load-bearing fact without provenance metadata is S1")
def t8(td: Path):
    led = ("# C\n\n## From CH01-S01\n\n```yaml\n"
           "- id: CAND-0001  entity: E  property: P\n"
           "  value: \"40.0 m\"  classification: LOAD-BEARING\n"
           "  status: proposed\n```\n")
    proj = project(td, 1, led)
    code, _, err = run(str(proj))
    assert code == 1, "load-bearing without metadata must fail"
    for f in ("units", "precision", "provenance", "source_chapter"):
        assert f in err, f"{f} not demanded: {err}"


@case("load-bearing value not propagated into its affects set is S1")
def t9(td: Path):
    led = ("# C\n\n## From CH01-S01\n\n```yaml\n"
           "- id: CAND-0001  entity: E  property: P\n"
           "  value: \"40.0 m\"\n  units: metres  precision: 0.1 m\n"
           "  provenance: \"CH01\"  source_chapter: CH01\n"
           "  classification: LOAD-BEARING\n"
           "  affects: [02_BIBLE/TIMELINE.md]\n  status: proposed\n```\n")
    proj = project(td, 1, led)
    code, _, err = run(str(proj))
    assert code == 1, "unpropagated load-bearing value must fail"
    assert "not propagated into" in err, err


@case("incidental prose numbers are NOT forced into the ledger")
def t10(td: Path):
    """The control must not be brittle. A chapter full of unmarked numbers
    passes; only explicitly classified facts carry the obligation."""
    proj = project(td, 1, ledger({"CH01": [1]}))
    (proj / "04_CHAPTERS" / "ch01" / "scenes" / "s01.md").write_text(
        f"{S}\nHe was 61. The wire was 3 metres from the gate. Forty years.\n{F}\n",
        encoding="utf-8")
    code, out, err = run(str(proj))
    assert code == 0, f"incidental numbers must not fail the gate: {err}"
    assert "load-bearing facts : 0" in out, out


@case("FIXTURE-1a: ledger MISSING a valid record for a drafted chapter -> FAIL")
def f1a(td: Path):
    """
    Every record present is syntactically valid. The disagreement is between the
    drafted-chapter count and what the ledger accounts for.
    """
    proj = project(td, 3, ledger({"CH01": [1, 2], "CH02": [3]}))   # CH03 drafted, absent
    code, out, err = run(str(proj))
    assert code == 1, f"missing coverage must FAIL, got {code}"
    assert "CH03" in err and "NEVER EXTRACTED" in err, err
    assert "chapters drafted   : 3" in out and "chapters extracted : 2" in out, out


@case("FIXTURE-1b: ledger contains an EXTRA unattributed record -> FAIL")
def f1b(td: Path):
    """
    The extra record is syntactically perfect. It simply belongs to no chapter,
    so a stored total and an artifact-derived total diverge while every record
    individually validates.
    """
    led = ("# C\n\n## From CH01-S01\n\n```yaml\n"
           "- id: CAND-0001  entity: E  property: P\n  value: \"v\"  status: proposed\n```\n"
           "\n```yaml\n"
           "- id: CAND-0002  entity: E  property: P\n  value: \"v\"  status: proposed\n```\n")
    proj = project(td, 1, led)
    code, out, err = run(str(proj))
    assert code == 1, f"unattributed record must FAIL, got {code}"
    assert "CAND-0002" in err and "unattributed" in err, err
    assert "structured records : 2" in out, "count must be artifact-derived"


@case("FIXTURE-1c: detector ignores a stored/reported total entirely")
def f1c(td: Path):
    led = ledger({"CH01": [1, 2], "CH02": [3]}) + "\n**Total: 999 candidates.**\n"
    proj = project(td, 2, led)
    code, out, _ = run(str(proj))
    assert code == 0, "valid ledger passes despite a false stored total"
    assert "structured records : 3" in out and "999" not in out, out


@case("PDF-018: an affects target escaping the project root is S1")
def taff(td: Path):
    """
    A declared affects target is a path this gate READS. Unchecked, a record
    naming ../../../etc/passwd turns the candidate gate into a file-disclosure
    primitive — the same class as PDF-015/016 on the write path.
    """
    led = ("# C\n\n## From CH01-S01\n\n```yaml\n"
           "- id: CAND-0001  entity: E  property: P\n"
           '  value: "40.0 m"\n  units: m  precision: 0.1\n'
           "  provenance: CH01  source_chapter: CH01\n"
           "  classification: LOAD-BEARING\n"
           "  affects: [../../../etc/passwd]\n  status: proposed\n```\n")
    proj = project(td, 1, led)
    code, _, err = run(str(proj))
    assert code == 1, "a traversing affects target must fail the gate"
    assert "[AFFECTS]" in err and "escapes the project root" in err, err


@case("ledger-count mismatch: a stated count that disagrees with the artifact")
def t11(td: Path):
    """
    ISS-003's signature failure: a document ASSERTS a count that the ledger
    cannot produce. The checker must never adopt the asserted figure.
    """
    led = ledger({"CH01": [1, 2], "CH02": [3]})
    led += "\n**65 candidates pending.**\n"      # false assertion in the file
    proj = project(td, 2, led)
    code, out, _ = run(str(proj))
    assert code == 0, "a well-formed ledger passes regardless of prose claims"
    assert "structured records : 3" in out, \
        f"checker must report the ESTABLISHED 3, not the asserted 65: {out}"
    assert "65" not in out.split("structured records")[1][:40], \
        "asserted count leaked into the established figure"


def _lb(fields: dict, affects="[02_BIBLE/TIMELINE.md]") -> str:
    body = "\n".join(f"  {k}: {v}" for k, v in fields.items())
    aff = f"  affects: {affects}\n" if affects is not None else ""
    return ("# C\n\n## From CH01-S01\n\n```yaml\n"
            "- id: CAND-0001  entity: E  property: P\n" + body + "\n"
            "  classification: LOAD-BEARING\n" + aff + "  status: proposed\n```\n"
            "\n## From CH02-S01\n\n```yaml\n"
            "- id: CAND-0002  entity: E2  property: P2\n"
            "  value: \"unrelated\"  status: proposed\n```\n")


LB_VALID = {"value": '"40.0 m"', "units": "metres", "precision": "0.1 m",
            "provenance": "CH01-S01", "source_chapter": "CH01"}


@case("FIXTURE-2 control: the unmutated load-bearing record -> PASS")
def f2ctl(td: Path):
    proj = project(td, 2, _lb(LB_VALID))
    (proj / "02_BIBLE" / "TIMELINE.md").write_text("timeline: 40.0 m\n", encoding="utf-8")
    code, out, err = run(str(proj))
    assert code == 0, f"valid load-bearing record must PASS: {err}"
    assert "load-bearing facts : 1" in out, out


@case("FIXTURE-2: each of value/units/precision/provenance/source_chapter mutated alone -> FAIL")
def f2fields(td: Path):
    """
    One field removed at a time. A correct neighbouring field, and a second
    fully-valid candidate in the ledger, must never compensate.
    """
    for drop in LB_VALID:
        fields = {k: v for k, v in LB_VALID.items() if k != drop}
        with tempfile.TemporaryDirectory() as sub:
            proj = project(Path(sub), 2, _lb(fields))
            (proj / "02_BIBLE" / "TIMELINE.md").write_text("timeline: 40.0 m\n", encoding="utf-8")
            code, _, err = run(str(proj))
            assert code == 1, f"removing {drop!r} alone must FAIL"
            assert drop in err, f"removing {drop!r} not reported: {err}"
            assert "CAND-0002" not in err, "the valid neighbour was wrongly implicated"


@case("FIXTURE-2: affects MISSING from the record -> FAIL")
def f2affmissing(td: Path):
    proj = project(td, 2, _lb(LB_VALID, affects=None))
    code, _, err = run(str(proj))
    assert code == 1, "load-bearing without an affects set must FAIL"
    assert "declares no affects set" in err, err


@case("FIXTURE-2: affects LISTED but target lacks the value -> FAIL")
def f2affempty(td: Path):
    proj = project(td, 2, _lb(LB_VALID))
    (proj / "02_BIBLE" / "TIMELINE.md").write_text("timeline with no figure\n", encoding="utf-8")
    code, _, err = run(str(proj))
    assert code == 1, "declared-but-unpropagated must FAIL"
    assert "not propagated into" in err, err


CASES = [taff, t1, t2, t3, t4, t5, t5b, t5c, idg, idg2, idg3, t6, t7, t8, t9, t10, t11,
         f1a, f1b, f1c, f2ctl, f2fields, f2affmissing, f2affempty]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--prove", action="store_true")
    a = ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately invalid expectation.\n"
              "If this does NOT fail, the suite proves nothing.\n")
        @case("DELIBERATELY WRONG")
        def bad(td: Path):
            proj = project(td, 2, ledger({"CH01": [1]}))   # CH02 unextracted
            code, _, _ = run(str(proj))
            assert code == 0, "expected failure — suite can go red"
        bad()
        _, ok, msg = _r[-1]
        print(f"  {'FAIL (correct)' if not ok else 'PASS (BROKEN SUITE!)'} — {msg}")
        return 0 if not ok else 1
    for c in CASES: c()
    bad_ = [(n, m) for n, ok, m in _r if not ok]
    for n, ok, m in _r:
        if a.verbose or not ok:
            print(f"  {'PASS' if ok else 'FAIL'}  {n}")
            if not ok: print(f"        {m}")
    print(f"\n{len(_r) - len(bad_)}/{len(_r)} passed")
    return 1 if bad_ else 0


if __name__ == "__main__":
    sys.exit(main())
