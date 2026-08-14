#!/usr/bin/env python3
"""test_capture.py — regression for C-08 (execution-evidence capture)."""
from __future__ import annotations
import argparse, json, sys, tempfile
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

@case("C-08: a run is captured with exit code, duration and transcript hash")
def t1(td):
    from capture import capture
    rec=capture([sys.executable,"-c","print('hello')"],"t")
    assert rec["exit_code"]==0 and "hello" in rec["stdout"]
    assert len(rec["transcript_sha256"])==64 and rec["duration_s"]>=0

@case("C-08: a FAILING command is captured, not discarded")
def t2(td):
    from capture import capture
    rec=capture([sys.executable,"-c","import sys;sys.exit(3)"],"t")
    assert rec["exit_code"]==3, "a failure is evidence too"

@case("C-08: a timeout is recorded as a timeout, not a pass")
def t3(td):
    from capture import capture
    rec=capture([sys.executable,"-c","import time;time.sleep(30)"],"t",timeout=1)
    assert rec["timed_out"] is True and rec["exit_code"]==124

@case("C-08: verify() accepts an unaltered record")
def t4(td):
    from capture import capture, save, verify
    p=save(td,capture([sys.executable,"-c","print('x')"],"t"))
    ok,msg=verify(p); assert ok, msg

@case("C-08: verify() DETECTS a record edited after capture")
def t5(td):
    from capture import capture, save, verify
    p=save(td,capture([sys.executable,"-c","print('16/16 passed')"],"t"))
    rec=json.loads(p.read_text()); rec["stdout"]="23/23 passed\n"
    p.write_text(json.dumps(rec))
    ok,msg=verify(p)
    assert not ok and "altered after capture" in msg, msg

CASES=[t1,t2,t3,t4,t5]
def main()->int:
    ap=argparse.ArgumentParser(); ap.add_argument("-v","--verbose",action="store_true")
    ap.add_argument("--prove",action="store_true"); a=ap.parse_args()
    if a.prove:
        print("PDF-003 guard: deliberately wrong expectation.\n")
        @case("DELIBERATELY WRONG")
        def bad(td):
            from capture import capture
            rec=capture([sys.executable,"-c","import sys;sys.exit(3)"],"t")
            assert rec["exit_code"]==0, "expected failure — suite can go red"
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
