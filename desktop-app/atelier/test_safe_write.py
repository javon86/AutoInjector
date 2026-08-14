#!/usr/bin/env python3
"""test_safe_write.py — regression for C-05 (authorised write path)."""
from __future__ import annotations
import argparse, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
_r=[]
def case(n):
    def deco(fn):
        def w():
            with tempfile.TemporaryDirectory() as td:
                try: fn(Path(td)); _r.append((n,True,""))
                except AssertionError as e: _r.append((n,False,str(e)))
                except Exception as e: _r.append((n,False,f"{type(e).__name__}: {e}"))
        return w
    return deco

@case("C-05: an unauthorised role cannot write through the write path")
def t1(td):
    from safe_write import write, WriteRefused
    try:
        write(td,"04_CHAPTERS/ch01/scenes/s01.md","prose",role="gemini",job_id="J1")
        raise AssertionError("§3.3 violation reached disk through safe_write")
    except WriteRefused as e:
        assert "may not write" in str(e), e
    assert not (td/"04_CHAPTERS").exists()

@case("C-05: an authorised write lands AND is stamped with provenance")
def t2(td):
    from safe_write import write
    p=write(td,"04_CHAPTERS/ch01/scenes/s01.md","prose",role="claude",
            job_id="CH01-S01-v1",project_id="salt-line")
    txt=p.read_text()
    assert "authored_by: claude" in txt and "job_id: CH01-S01-v1" in txt
    assert "prose" in txt

@case("C-05: an authorised write with NO job_id is refused (PDF-006)")
def t3(td):
    from safe_write import write, WriteRefused
    try:
        write(td,"04_CHAPTERS/ch01/scenes/s01.md","prose",role="claude")
        raise AssertionError("unattributed artifact must be refused")
    except WriteRefused as e:
        assert "not evidence" in str(e), e

@case("C-05: content already carrying provenance is not double-stamped")
def t4(td):
    from safe_write import write
    pre=("---\nauthored_by: claude\nauthored_at: 2026-08-13T00:00:00Z\n"
         "job_id: J0\n---\nbody\n")
    p=write(td,"02_BIBLE/x.md",pre,role="claude",job_id="J1")
    assert p.read_text().count("authored_by")==1

@case("C-05: a refused write is quarantined, not dropped")
def t5(td):
    from safe_write import write, WriteRefused
    from authority import QUARANTINE
    try: write(td,"02_BIBLE/x.md","invented canon",role="gemini",job_id="J1")
    except WriteRefused: pass
    q=list((td/QUARANTINE).glob("*"))
    assert q and "invented canon" in q[0].read_text()

@case("C-05: the audit reports tools that bypass the write path")
def t6(td):
    from safe_write import audit_writers
    (td/"rogue.py").write_text("from pathlib import Path\nPath('x').write_text('y')\n")
    (td/"good.py").write_text("from safe_write import write\nwrite(1,2,3)\n")
    rogue=audit_writers(td)
    assert "rogue.py" in rogue and "good.py" not in rogue, rogue

@case("C-05: a symlink inside the project cannot redirect a write outside it")
def t7(td):
    """
    Found by adversarial sweep. can_write() normalises the STRING; a symlink
    resolves at the FILESYSTEM, so a clean relative path can still land
    outside. String validation cannot see this — only resolution can.
    """
    import os, tempfile
    from safe_write import write, WriteRefused
    (td / "04_CHAPTERS").mkdir()
    outside = Path(tempfile.mkdtemp())
    os.symlink(outside, td / "04_CHAPTERS" / "link")
    try:
        write(td, "04_CHAPTERS/link/evil.md", "x", role="claude",
              job_id="J1", stamp_provenance=False)
        raise AssertionError("a symlinked write escaped the project root")
    except WriteRefused as e:
        assert "outside the project root" in str(e), e
    assert not (outside / "evil.md").exists()


CASES=[t1,t2,t3,t4,t5,t6,t7]
def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("-v","--verbose",action="store_true")
    ap.add_argument("--prove",action="store_true"); a=ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            from safe_write import write
            write(td,"04_CHAPTERS/x.md","p",role="gemini",job_id="J1")
            raise AssertionError("expected failure — suite can go red")
        bad(); _,ok,msg=_r[-1]
        print(f"  {'FAIL (correct)' if not ok else 'PASS (BROKEN SUITE!)'} — {msg}")
        return 0 if not ok else 1
    for c in CASES: c()
    bad_=[(n,m) for n,ok,m in _r if not ok]
    for n,ok,m in _r:
        if a.verbose or not ok:
            print(f"  {'PASS' if ok else 'FAIL'}  {n}")
            if not ok: print(f"        {m}")
    print(f"\n{len(_r)-len(bad_)}/{len(_r)} passed")
    return 1 if bad_ else 0
if __name__=="__main__": sys.exit(main())
