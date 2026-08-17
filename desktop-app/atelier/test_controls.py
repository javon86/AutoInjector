#!/usr/bin/env python3
"""
test_controls.py — regression suite for the Showrunner's focused rulings.

Covers: Injection 13 (evidence), Injection 15 detection, Injection 16
round-trip proof, F-03 runtime atomicity, F-05 metric invariant.
"""
from __future__ import annotations
import argparse, subprocess, sys, tempfile
from pathlib import Path
HERE = Path(__file__).resolve().parent
S, F = "}-----< Start >-----{", "}-----< finish >-----{"
_r: list[tuple[str, bool, str]] = []

def run(tool, *a, cwd=None):
    p = subprocess.run([sys.executable, str(HERE/tool), *a], cwd=cwd,
                       capture_output=True, text=True)
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

# --- Injection 13: nested -> S0 -> zero manuscript emitted ------------------
@case("inj13: nested Start -> S0 -> ZERO manuscript emitted (--strict)")
def t13(d: Path):
    (d/"a.md").write_text(f"{S}\nouter\n{S}\ninner\n{F}\n")
    code,_,err = run("assemble_manuscript.py", str(d), "-o", str(d/"o.md"), "--strict")
    assert code == 2, f"expected S0 exit 2, got {code}"
    assert "nested" in err.lower(), f"must name the cause: {err!r}"
    assert not (d/"o.md").exists(), "ZERO manuscript must be emitted"

# --- Injection 15: detection exists, and does NOT remove -------------------
@case("inj15: notes inside markers DETECTED and reported, never removed")
def t15(d: Path):
    note = "TODO: fix this chapter later"
    (d/"a.md").write_text(f"{S}\nReal prose here.\n{note}\nJOB_ID: CH07-S03\n{F}\n")
    code,_,err = run("check_manuscript.py", str(d), "--strict")
    assert code == 2, f"strict must halt on findings, got {code}"
    assert "IN_BOOK_EDITORIAL" in err, "editorial note not detected"
    assert "IN_BOOK_METADATA" in err, "handoff field not detected"
    assert "nothing was removed" in err, "must state it did not remove"
    # and the assembler still keeps them: membership is positional
    run("assemble_manuscript.py", str(d), "-o", str(d/"o.md"))
    txt = (d/"o.md").read_text()
    assert note in txt and "JOB_ID" in txt, "content must NOT be removed"

# --- Injection 16: detect -> positional correction -> bytes unchanged -------
@case("inj16: outside prose detected; marker move reproduces bytes exactly")
def t16(d: Path):
    prose = ("The salt line reached the second fence by August.\n"
             "Marla counted the seconds between the lamp and the dark.\n"
             "She did not sleep that night, or the next.\n")
    (d/"a.md").write_text(prose + S + "\n" + F + "\n")
    code,_,err = run("check_manuscript.py", str(d), "--strict")
    assert code == 2, f"misplaced prose must be detected, got {code}"
    assert "OUT_OF_BOOK_PROSE" in err, f"detector missed it: {err!r}"
    # baseline: the prose is outside the markers, so nothing is emitted at all
    bcode,_,berr = run("assemble_manuscript.py", str(d), "-o", str(d/"before.md"))
    assert not (d/"before.md").exists(), "out-of-book prose must not be emitted"
    assert "no in-book content" in berr, f"expected STOP, got: {berr!r}"
    # permitted positional correction: move the markers, touch no prose
    (d/"a.md").write_text(S + "\n" + prose + F + "\n")
    run("assemble_manuscript.py", str(d), "-o", str(d/"after.md"))
    assert (d/"after.md").read_text().rstrip("\n") == prose.rstrip("\n"), \
        "rebuilt manuscript must reproduce the original prose bytes unchanged"

# --- F-03 runtime atomicity ------------------------------------------------
@case("F-03: conditional component is ATOMIC and never subdivided")
def t3(d: Path):
    (d/"i.md").write_text(
        "1. Revise Chapter 7, but only if Marla hasn't left the workshop\n"
        "2. Update the style sheet\n"
        "3. Rename the tavern\n")
    _,out,_ = run("components.py", "split", str(d/"i.md"))
    assert "[ATOMIC] component 1" in out, f"conditional not atomic:\n{out}"
    assert "[SEPARABLE] component 2" in out, "plain item must stay separable"
    assert "2 separable" in out, f"expected 2 separable:\n{out}"

@case("F-03: structure creates components, not the lexical layer")
def t3b(d: Path):
    (d/"i.md").write_text("Revise chapter 7 if Marla is present and also "
                          "rename the tavern.\n")
    _,out,_ = run("components.py", "split", str(d/"i.md"))
    assert "component 1" in out and "component 2" not in out, \
        "lexical conditional must NOT create a boundary"
    assert "QUARANTINED" in out, "unbounded atomic must quarantine"

# --- F-05 metric invariant -------------------------------------------------
@case("F-05: truncation is visible in the Job Packet")
def t5(d: Path):
    code,out,err = run("components.py", "context", "--available", "50",
                       "--included", "38", "--json")
    assert code == 0, err
    assert '"facts_omitted": 12' in out and '"continuity_truncated": true' in out
    assert "TRUNCATION" in err

@case("F-05: inconsistent metrics fail validation (S0)")
def t5b(d: Path):
    code,_,err = run("components.py", "context", "--available", "50",
                     "--included", "38", "--omitted", "5")
    assert code == 2, f"inconsistency must be S0, got {code}"
    assert "metric inconsistency" in err

@case("F-05: no truncation reports cleanly")
def t5c(d: Path):
    code,out,_ = run("components.py", "context", "--available", "20",
                     "--included", "20", "--json")
    assert code == 0 and '"continuity_truncated": false' in out

CASES=[t13,t15,t16,t3,t3b,t5,t5b,t5c]

def main() -> int:
    ap=argparse.ArgumentParser(); ap.add_argument("-v","--verbose",action="store_true")
    ap.add_argument("--prove", action="store_true",
                    help="run a deliberately wrong expectation; passes ONLY if "
                         "it fails, proving the suite can go red (PDF-003)")
    a=ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n"
              "If this does NOT fail, the suite proves nothing.\n")
        @case("DELIBERATELY WRONG")
        def bad(d: Path):
            (d/"a.md").write_text(f"{S}\nkept\n{F}\n")
            run("assemble_manuscript.py", str(d), "-o", str(d/"o.md"))
            assert "this string is not present" in (d/"o.md").read_text(), \
                "expected failure — suite can go red"
        bad()
        n, ok, msg = _r[-1]
        print(f"  {'FAIL (correct)' if not ok else 'PASS (BROKEN SUITE!)'} — {msg}")
        return 0 if not ok else 1
    for c in CASES: c()
    bad=[(n,m) for n,ok,m in _r if not ok]
    for n,ok,m in _r:
        if a.verbose or not ok:
            print(f"  {'PASS' if ok else 'FAIL'}  {n}")
            if not ok: print(f"        {m}")
    print(f"\n{len(_r)-len(bad)}/{len(_r)} passed")
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
