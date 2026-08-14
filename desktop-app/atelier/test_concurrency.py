#!/usr/bin/env python3
"""
test_concurrency.py — concurrent-project isolation (finish-line task 8).

Two books running at once must not see each other's jobs, candidates, ledgers,
quarantine or recovery state. Nothing had ever tested contention — only that
namespacing existed.

    python test_concurrency.py [-v] [--prove]
"""
from __future__ import annotations
import argparse, json, os, subprocess, sys, tempfile, threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
HERE = Path(__file__).resolve().parent
_r: list[tuple[str, bool, str]] = []
S, F = "}-----< Start >-----{", "}-----< finish >-----{"


def run(tool, *a, cwd=None, timeout=90):
    p = subprocess.run([sys.executable, str(HERE / tool), *a], cwd=cwd,
                       capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def case(n):
    def deco(fn):
        def w():
            with tempfile.TemporaryDirectory() as td:
                try: fn(Path(td)); _r.append((n, True, ""))
                except AssertionError as e: _r.append((n, False, str(e)))
                except Exception as e: _r.append((n, False, f"{type(e).__name__}: {e}"))
        return w
    return deco


def scaffold(td: Path, title: str) -> Path:
    run("init_project.py", title, "--chapters", "6", cwd=td)
    return td / title.lower().replace(" ", "-")


@case("CONC: identical job ids in two projects do not collide")
def t1(td):
    from identity import namespaced
    a, b = namespaced("book-a", "CH01-S01-v1"), namespaced("book-b", "CH01-S01-v1")
    assert a != b, "same job id in two books produced the same key"


@case("CONC: two projects' delivery ledgers are independent")
def t2(td):
    from redelivery import accept, DeliveryRefused, _load
    A, B = td / "a", td / "b"
    A.mkdir(); B.mkdir()
    accept(A, "J1", "content-a", project_id="book-a")
    accept(B, "J1", "content-b", project_id="book-b")   # must not raise
    # and a redelivery in A must not be satisfied by B's record
    try:
        accept(A, "J1", "content-a", project_id="book-a")
        raise AssertionError("redelivery in A must still be refused")
    except DeliveryRefused:
        pass
    assert set(_load(A)) == {"book-a/J1"} and set(_load(B)) == {"book-b/J1"}


@case("CONC: same job id, same ledger, different projects — no cross-refusal")
def t3(td):
    from redelivery import accept
    accept(td, "CH01-S01", "prose for A", project_id="book-a")
    accept(td, "CH01-S01", "prose for B", project_id="book-b")   # must not raise
    from redelivery import _load
    assert len(_load(td)) == 2, "shared ledger must namespace by project"


@case("CONC: a quarantined write in one project does not appear in the other")
def t4(td):
    from safe_write import write, WriteRefused
    from authority import QUARANTINE
    A, B = td / "a", td / "b"
    A.mkdir(); B.mkdir()
    try: write(A, "04_CHAPTERS/x.md", "bad", role="gemini", job_id="J1")
    except WriteRefused: pass
    assert list((A / QUARANTINE).glob("*")), "A should hold the quarantined write"
    assert not (B / QUARANTINE).exists(), "B must not see A's quarantine"


@case("CONC: recovery in one project ignores the other's open transactions")
def t5(td):
    A, B = td / "a", td / "b"
    A.mkdir(); B.mkdir()
    for root, pid in ((A, "book-a"), (B, "book-b")):
        run("transaction.py", "open", "J1", "--branch", "wb/J1",
            "--base-commit", "b0", "--spec-version", "v0.3.3",
            "--project-id", pid, "--inputs", "card=v1", cwd=root)
    code, out, err = run("transaction.py", "recover", cwd=A)
    assert "J1" in (out + err), "A's own open transaction should be found"
    b_jobs = list((B / ".atelier" / "jobs").glob("*.json"))
    b_rec = json.loads(b_jobs[0].read_text())
    assert b_rec.get("recovery") is None, \
        "recovery in A mutated B's transaction record"


@case("CONC: parallel scaffold + build of two projects produces isolated output")
def t6(td):
    results = {}
    def build(name):
        try:
            proj = scaffold(td, name)
            (proj / "04_CHAPTERS" / "s.md").write_text(
                f"{S}\nProse for {name}.\n{F}\n", encoding="utf-8")
            rc, _, _ = run("assemble_manuscript.py", "04_CHAPTERS",
                           "-o", "07_BUILD/m.md", "--strict", cwd=proj)
            results[name] = (rc, (proj / "07_BUILD" / "m.md").read_text().strip())
        except Exception as e:
            results[name] = ("ERR", str(e))
    ths = [threading.Thread(target=build, args=(n,)) for n in ("Book Alpha", "Book Beta")]
    for t in ths: t.start()
    for t in ths: t.join(timeout=120)
    assert len(results) == 2, f"both builds must complete: {results}"
    for name, (rc, text) in results.items():
        assert rc == 0, f"{name} build failed: {rc}"
        assert text == f"Prose for {name}.", f"{name} got: {text!r} — cross-contamination"


@case("CONC: candidate ledgers in two projects are counted independently")
def t7(td):
    A, B = scaffold(td, "Proj A"), scaffold(td, "Proj B")
    for proj, n in ((A, 3), (B, 7)):
        d = proj / "04_CHAPTERS" / "ch01" / "scenes"; d.mkdir(parents=True, exist_ok=True)
        (d / "s01.md").write_text(f"{S}\np\n{F}\n", encoding="utf-8")
        rows = "\n".join(f'- id: CAND-{i:04d}  entity: E  property: P\n'
                         f'  value: "v"  status: proposed' for i in range(1, n + 1))
        (proj / "03_MEMORY" / "CANDIDATES.md").write_text(
            "# C\n\n## From CH01\n\n```yaml\n" + rows + "\n```\n", encoding="utf-8")
    _, oa, _ = run("check_candidates.py", str(A))
    _, ob, _ = run("check_candidates.py", str(B))
    assert "structured records : 3" in oa, oa
    assert "structured records : 7" in ob, ob


CASES = [t1, t2, t3, t4, t5, t6, t7]


def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--prove", action="store_true"); a = ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            from identity import namespaced
            assert namespaced("book-a", "J1") == namespaced("book-b", "J1"), \
                "expected failure — suite can go red"
        bad(); _, ok, msg = _r[-1]
        print(f"  {'FAIL (correct)' if not ok else 'PASS (BROKEN SUITE!)'} — {msg}")
        return 0 if not ok else 1
    for c in CASES: c()
    bad_ = [(n, m) for n, ok, m in _r if not ok]
    for n, ok, m in _r:
        if a.verbose or not ok:
            print(f"  {'PASS' if ok else 'FAIL'}  {n}")
            if not ok: print(f"        {m}")
    print(f"\n{len(_r)-len(bad_)}/{len(_r)} passed")
    return 1 if bad_ else 0


if __name__ == "__main__":
    sys.exit(main())
