#!/usr/bin/env python3
"""
test_assembler.py — regression suite for the Strict Manuscript Boundary Rule.

Covers SYSTEM_SPEC §36 machinery injections 12-16 plus normalization limits and
the recorded process defects. Stdlib only; no test framework required.

    python test_assembler.py           run all
    python test_assembler.py -v        show each case
    python test_assembler.py --prove   demonstrate the suite can fail

Every case asserts a SPECIFIC expected outcome (exit code, block count, changed
line count). Per PDF-003, a case that merely asserts "no error" is not a test —
it cannot distinguish a working system from one that does nothing.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ASSEMBLER = HERE / "assemble_manuscript.py"

CANON_START = "}-----< Start >-----{"
CANON_FINISH = "}-----< finish >-----{"

_results: list[tuple[str, bool, str]] = []


def run(workdir: Path, *args: str) -> tuple[int, str, str]:
    proc = subprocess.run(
        [sys.executable, str(ASSEMBLER), *args],
        cwd=workdir, capture_output=True, text=True,
    )
    return proc.returncode, proc.stdout, proc.stderr


def case(name: str):
    def deco(fn):
        def wrapped():
            with tempfile.TemporaryDirectory() as td:
                d = Path(td) / "src"
                d.mkdir()
                try:
                    fn(d, Path(td))
                    _results.append((name, True, ""))
                except AssertionError as e:
                    _results.append((name, False, str(e)))
                except Exception as e:  # noqa: BLE001
                    _results.append((name, False, f"{type(e).__name__}: {e}"))
        wrapped.case_name = name
        return wrapped
    return deco


def write(p: Path, text: str) -> None:
    p.write_text(text, encoding="utf-8")


# --------------------------------------------------------------------------
# §36 injection 12 — malformed marker
# --------------------------------------------------------------------------
@case("inj12: marker sharing a line with text is an error, never honored")
def t12(d: Path, tmp: Path):
    write(d / "a.md", f"note {CANON_START} still note\nprose\n")
    code, _, err = run(tmp, "src", "-o", str(tmp / "o.md"))
    assert "same line" in err, f"expected same-line error, got: {err!r}"
    assert code != 0, "malformed marker must not produce a clean exit"
    assert not (tmp / "o.md").exists(), "no output when there is no valid block"


# --------------------------------------------------------------------------
# §36 injection 13 — nested Start
# --------------------------------------------------------------------------
@case("inj13: nested Start -> file emits ZERO output in EVERY mode")
def t13(d: Path, tmp: Path):
    """
    Ruled behavior (F-06 residual): a nested Start is a structural failure and
    the file emits nothing in ANY mode. Detection is not the same as
    non-emission. This case previously asserted that the outer block still
    assembled in non-strict mode -- that was the defect.
    """
    write(d / "a.md",
          f"{CANON_START}\nouter\n{CANON_START}\ninner\n{CANON_FINISH}\n")
    code, out, err = run(tmp, "src", "-o", str(tmp / "o.md"))
    assert "nested" in err.lower(), f"expected nested error, got: {err!r}"
    assert "STRUCTURAL" in err, "must report the file as non-emitting"
    assert not (tmp / "o.md").exists(), \
        "NON-STRICT must emit zero output from a structurally failed file"
    scode, _, _ = run(tmp, "src", "-o", str(tmp / "s.md"), "--strict")
    assert scode == 2, f"strict must refuse nested markers, got {scode}"
    assert not (tmp / "s.md").exists(), "strict must write nothing"


@case("inj13b: structural failure is scoped — clean files still assemble")
def t13b(d: Path, tmp: Path):
    write(d / "a_good.md", f"{CANON_START}\nkept\n{CANON_FINISH}\n")
    write(d / "b_bad.md",
          f"{CANON_START}\nlost\n{CANON_START}\nalso lost\n{CANON_FINISH}\n")
    run(tmp, "src", "-o", str(tmp / "o.md"))
    text = (tmp / "o.md").read_text()
    assert "kept" in text, "clean file must still assemble"
    assert "lost" not in text, "failed file must contribute nothing"


# --------------------------------------------------------------------------
# §36 injection 14 — unclosed Start
# --------------------------------------------------------------------------
@case("inj14: unclosed Start is DISCARDED, never guessed to EOF")
def t14(d: Path, tmp: Path):
    write(d / "a.md", f"{CANON_START}\nclean\n{CANON_FINISH}\n")
    write(d / "b.md", f"{CANON_START}\nnever closed\n")
    code, _, err = run(tmp, "src", "-o", str(tmp / "o.md"))
    assert "never closed" in err.lower(), f"expected unclosed error: {err!r}"
    text = (tmp / "o.md").read_text()
    assert "clean" in text, "valid block must still assemble"
    assert "never closed" not in text, "unclosed block must NOT reach the book"
    assert code == 1, f"expected exit 1, got {code}"


# --------------------------------------------------------------------------
# §36 injection 15 — notes inside markers: detect, report, NEVER auto-repair
# --------------------------------------------------------------------------
@case("inj15: notes inside markers are KEPT verbatim (no semantic repair)")
def t15(d: Path, tmp: Path):
    note = "TODO: fix this chapter later"
    write(d / "a.md", f"{CANON_START}\nReal prose.\n{note}\n{CANON_FINISH}\n")
    code, _, _ = run(tmp, "src", "-o", str(tmp / "o.md"))
    text = (tmp / "o.md").read_text()
    assert note in text, (
        "note inside markers MUST be preserved — removing it would require "
        "interpreting content, which the Non-Interpretation Clause forbids"
    )
    assert code == 0, f"this is not a build error; got exit {code}"


# --------------------------------------------------------------------------
# §36 injection 16 — prose outside markers is cut
# --------------------------------------------------------------------------
@case("inj16: prose outside markers is CUT, no rescue")
def t16(d: Path, tmp: Path):
    write(d / "a.md",
          f"Beautiful orphaned sentence.\n{CANON_START}\nkept\n{CANON_FINISH}\n"
          "Another orphan.\n")
    run(tmp, "src", "-o", str(tmp / "o.md"))
    text = (tmp / "o.md").read_text()
    assert "kept" in text
    assert "orphan" not in text.lower(), "out-of-book prose must be cut"
    assert text.strip() == "kept", f"unexpected content: {text!r}"


# --------------------------------------------------------------------------
# Protocol §3.1 — strict rejects noncanonical markers
# --------------------------------------------------------------------------
@case("proto3.1: strict rejects noncanonical markers; tolerant mode accepts")
def t_noncanon(d: Path, tmp: Path):
    write(d / "a.md", "}--< start >--{\nbody\n}------< FINISH >------{\n")
    lax, _, _ = run(tmp, "src", "-o", str(tmp / "o.md"))
    assert lax == 0, f"tolerant parse should succeed, got {lax}"
    assert (tmp / "o.md").read_text().strip() == "body"
    strict, _, err = run(tmp, "src", "-o", str(tmp / "s.md"), "--strict")
    assert strict == 2, f"strict must fail on noncanonical, got {strict}"
    assert "noncanonical" in err.lower(), f"expected reason in stderr: {err!r}"
    assert not (tmp / "s.md").exists(), "strict failure must write nothing"


# --------------------------------------------------------------------------
# Protocol §3.2 — normalization touches ONLY standalone marker lines
# --------------------------------------------------------------------------
@case("proto3.2: normalize rewrites only standalone markers, never content")
def t_normalize(d: Path, tmp: Path):
    original = (
        "A note mentioning }--< start >--{ inline.\n"
        "}--< start >--{\n"
        "Prose body.\n"
        "}------< FINISH >------{\n"
        "Tail with }--< Start >--{ reference.\n"
    )
    src = d / "a.md"
    write(src, original)
    reference = tmp / "reference.md"          # OUTSIDE the scanned tree (PDF-003)
    shutil.copy(src, reference)

    code, out, err = run(tmp, "src", "-o", str(tmp / "o.md"), "--normalize-markers")
    assert "Normalized 2 marker" in out, f"expected exactly 2 rewrites: {out!r}"

    before = reference.read_text().splitlines()
    after = src.read_text().splitlines()
    changed = [i for i, (b, a) in enumerate(zip(before, after)) if b != a]
    assert changed == [1, 3], f"only lines 1 and 3 may change, changed {changed}"
    assert after[0] == before[0], "inline marker-like text must be untouched"
    assert after[4] == before[4], "tail marker-like text must be untouched"
    assert after[1] == CANON_START, f"line 1 not canonical: {after[1]!r}"
    assert after[3] == CANON_FINISH, f"line 3 not canonical: {after[3]!r}"

    # Inline marker-like text is REPORTED as a same-line error and left alone.
    # Per Protocol §3.2 the tool reports and never repairs, so a non-zero exit
    # here is correct behavior, not a regression.
    assert err.count("same line") == 2, f"expected 2 same-line reports: {err!r}"
    assert code == 1, f"expected exit 1 (reported, unrepaired), got {code}"


# --------------------------------------------------------------------------
# Ordering + out-of-book metadata
# --------------------------------------------------------------------------
@case("assembly: file sort order preserved; routing metadata excluded")
def t_order(d: Path, tmp: Path):
    write(d / "ch02.md", f"[TO: ALL]\n{CANON_START}\nsecond\n{CANON_FINISH}\n")
    write(d / "ch01.md", f"[TO: CLAUDE]\n{CANON_START}\nfirst\n{CANON_FINISH}\n")
    run(tmp, "src", "-o", str(tmp / "o.md"))
    text = (tmp / "o.md").read_text()
    assert text.index("first") < text.index("second"), "sort order violated"
    assert "TO:" not in text, "routing metadata must never reach the manuscript"


@case("empty project reports STOP, not FATAL, and writes nothing")
def t_empty(d: Path, tmp: Path):
    write(d / "a.md", "just notes, no markers\n")
    code, _, err = run(tmp, "src", "-o", str(tmp / "o.md"))
    assert code == 1, f"expected exit 1 for empty, got {code}"
    assert "[STOP]" in err, f"expected STOP not FATAL: {err!r}"
    assert not (tmp / "o.md").exists()


@case("inj14b: unclosed Start -> zero output in BOTH modes (F-06 matrix)")
def t14b(d: Path, tmp: Path):
    write(d / "a.md", f"{CANON_START}\nnever closed\n")
    code, _, err = run(tmp, "src", "-o", str(tmp / "o.md"))
    assert "STRUCTURAL" in err or "never closed" in err.lower()
    assert not (tmp / "o.md").exists(), "non-strict must emit zero output"
    scode, _, _ = run(tmp, "src", "-o", str(tmp / "s.md"), "--strict")
    assert scode == 2, f"strict must fail, got {scode}"
    assert not (tmp / "s.md").exists(), "strict must emit zero output"


@case("F-06 x normalize: normalization cannot rescue a structural failure")
def t_norm_struct(d: Path, tmp: Path):
    """
    --normalize-markers repairs marker FORM. It must not convert a structural
    failure into an emitting build: a noncanonical *and* nested file is still
    nested after normalization, and must still emit zero output.
    """
    write(d / "a.md",
          "}--< start >--{\nouter\n}--< start >--{\ninner\n}------< FINISH >------{\n")
    code, out, err = run(tmp, "src", "-o", str(tmp / "o.md"),
                         "--normalize-markers")
    assert "Normalized" in out, f"markers should have been normalized: {out!r}"
    assert not (tmp / "o.md").exists(), \
        "normalization must NOT rescue a nested-marker file into emitting"
    assert "nested" in err.lower(), "structural failure must still be reported"


@case("F-06 x normalize: unclosed + noncanonical still emits nothing")
def t_norm_unclosed(d: Path, tmp: Path):
    write(d / "a.md", "}--< start >--{\nnever closed\n")
    code, _, err = run(tmp, "src", "-o", str(tmp / "o.md"),
                       "--normalize-markers")
    assert not (tmp / "o.md").exists(), "must emit zero output"
    assert "never closed" in err.lower() or "STRUCTURAL" in err


@case("scaffold: a fresh project passes its own --strict build")
def t_scaffold(d: Path, tmp: Path):
    """
    Regression for a defect found only by running init_project.py and then
    building it: templates under _TEMPLATE/ carry an empty marker block, the
    assembler warns, and --strict fails on warnings. Every prior test used
    hand-made directories, so none of them exercised this path.
    """
    (d / "_TEMPLATE" / "scenes").mkdir(parents=True)
    write(d / "_TEMPLATE" / "scenes" / "s01.md",
          f"{CANON_START}\n\n{CANON_FINISH}\n\nNOTES:\n")
    write(d / "ch01.md", f"{CANON_START}\nreal prose\n{CANON_FINISH}\n")
    code, _, err = run(tmp, "src", "-o", str(tmp / "o.md"), "--strict")
    assert code == 0, f"fresh scaffold must pass --strict, got {code}: {err}"
    text = (tmp / "o.md").read_text()
    assert "real prose" in text
    assert "NOTES" not in text, "template content must never be assembled"


@case("scaffold: an EMPTY fresh project reports STOP, not a build error")
def t_scaffold_empty(d: Path, tmp: Path):
    """
    Regression for PDF-011. A newly scaffolded project contains only templates,
    which PDF-008 correctly excludes -- leaving zero candidate files. That is an
    empty state, not an error. The PDF-008 fix over-corrected and made every new
    project unbuildable until its first scene existed.
    """
    (d / "_TEMPLATE" / "scenes").mkdir(parents=True)
    write(d / "_TEMPLATE" / "scenes" / "s01.md",
          f"{CANON_START}\n\n{CANON_FINISH}\n")
    code, _, err = run(tmp, "src", "-o", str(tmp / "o.md"))
    assert code == 1, f"empty project must be STOP (1), not error (2/3): {code}"
    assert "[STOP]" in err, f"expected STOP: {err!r}"
    assert not (tmp / "o.md").exists()

    # and once a scene exists, it builds
    write(d / "ch01.md", f"{CANON_START}\nfirst prose\n{CANON_FINISH}\n")
    code2, _, _ = run(tmp, "src", "-o", str(tmp / "o2.md"), "--strict")
    assert code2 == 0, "adding the first scene must make the project buildable"
    assert "first prose" in (tmp / "o2.md").read_text()


@case("E2E: init_project -> untouched scaffold -> strict assembly (PDF-011)")
def t_e2e_scaffold(d: Path, tmp: Path):
    """
    TRUE end-to-end. Invokes init_project.py itself rather than hand-building a
    fixture -- the hand-built fixture is exactly what let PDF-011 through.

    Deliberately SEPARATE from t_scaffold (_TEMPLATE exclusion) so that neither
    correction can mask the other: one proves templates stay out, this proves an
    empty project is a valid state.
    """
    init = HERE / "init_project.py"
    if not init.exists():
        raise AssertionError("init_project.py not found alongside the tests")

    r = subprocess.run([sys.executable, str(init), "E2E Check", "--chapters", "6"],
                       cwd=tmp, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, f"scaffold failed: {r.stderr}"
    proj = tmp / "e2e-check"
    assert proj.is_dir(), "project directory not created"

    tpl = proj / "04_CHAPTERS" / "_TEMPLATE" / "scenes" / "s01.md"
    assert tpl.exists(), "scaffold no longer ships a scene template — update this test"

    # 1. untouched fresh scaffold: valid EMPTY state, not corruption
    a = subprocess.run([sys.executable, str(HERE / "assemble_manuscript.py"),
                        "04_CHAPTERS", "-o", "07_BUILD/m.md", "--strict"],
                       cwd=proj, capture_output=True, text=True, timeout=60)
    assert a.returncode == 1, (
        f"untouched scaffold must be STOP (1), got {a.returncode}: {a.stderr}")
    assert "[STOP]" in a.stderr, f"expected STOP: {a.stderr!r}"
    assert "no input files matched" not in a.stderr, "PDF-011 has regressed"
    assert not (proj / "07_BUILD" / "m.md").exists(), \
        "must not fabricate manuscript output from an empty project"

    # 2. add one real scene: normal rules apply, template stays out
    (proj / "04_CHAPTERS" / "ch01.md").write_text(
        f"{CANON_START}\nThe salt line reached the second fence.\n{CANON_FINISH}\n",
        encoding="utf-8")
    b = subprocess.run([sys.executable, str(HERE / "assemble_manuscript.py"),
                        "04_CHAPTERS", "-o", "07_BUILD/m.md", "--strict"],
                       cwd=proj, capture_output=True, text=True, timeout=60)
    assert b.returncode == 0, f"one real scene must build: {b.stderr}"
    text = (proj / "07_BUILD" / "m.md").read_text()
    assert text.strip() == "The salt line reached the second fence."
    assert "NOTES" not in text and "JOB_ID" not in text, \
        "template content leaked into the manuscript"


@case("PDF-017: a UTF-8 BOM does not break marker recognition")
def t_bom(d: Path, tmp: Path):
    """
    Any file saved by a Windows editor carries a BOM. Read as plain utf-8 the
    BOM sits BEFORE the Start marker, so the marker is not recognised at
    position 0 and the build fails with "finish with no matching Start" —
    pointing at the wrong line entirely. Found by adversarial sweep.
    """
    src = tmp / "c"; src.mkdir()
    (src / "bom.md").write_bytes(
        b"\xef\xbb\xbf}-----< Start >-----{\nbom prose\n}-----< finish >-----{\n")
    out = tmp / "o.md"
    code, _, err = run(tmp, "c", "-o", str(out), "--strict")
    assert code == 0, f"a BOM broke the build: {err}"
    assert out.read_text(encoding="utf-8").strip() == "bom prose"


@case("PDF-017: CRLF line endings assemble correctly")
def t_crlf(d: Path, tmp: Path):
    src = tmp / "c"; src.mkdir()
    (src / "crlf.md").write_bytes(
        b"}-----< Start >-----{\r\ncrlf prose\r\n}-----< finish >-----{\r\n")
    out = tmp / "o.md"
    code, _, err = run(tmp, "c", "-o", str(out), "--strict")
    assert code == 0, f"CRLF broke the build: {err}"
    assert "crlf prose" in out.read_text(encoding="utf-8")


CASES = [t_bom, t_crlf, t12, t13, t13b, t14, t14b, t_scaffold, t_scaffold_empty, t_e2e_scaffold, t_norm_struct, t_norm_unclosed, t15, t16, t_noncanon, t_normalize, t_order, t_empty]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--prove", action="store_true",
                    help="prove the suite can fail (PDF-003 guard)")
    args = ap.parse_args()

    if not ASSEMBLER.exists():
        print(f"[FATAL] assembler not found at {ASSEMBLER}", file=sys.stderr)
        return 3

    if args.prove:
        print("PDF-003 guard: running a case against a deliberately wrong "
              "expectation.\nIf this does NOT fail, the suite proves nothing.\n")

        @case("DELIBERATELY WRONG — must fail")
        def bad(d: Path, tmp: Path):
            write(d / "a.md", f"{CANON_START}\nkept\n{CANON_FINISH}\n")
            run(tmp, "src", "-o", str(tmp / "o.md"))
            text = (tmp / "o.md").read_text()
            assert "this string is not present" in text, \
                "expected failure — suite is capable of going red"

        bad()
        name, ok, msg = _results[-1]
        print(f"  {'FAIL (correct)' if not ok else 'PASS (BROKEN SUITE!)'} — {msg}")
        return 0 if not ok else 1

    for c in CASES:
        c()

    failed = [(n, m) for n, ok, m in _results if not ok]
    for name, ok, msg in _results:
        if args.verbose or not ok:
            print(f"  {'PASS' if ok else 'FAIL'}  {name}")
            if not ok:
                print(f"        {msg}")

    print(f"\n{len(_results) - len(failed)}/{len(_results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
