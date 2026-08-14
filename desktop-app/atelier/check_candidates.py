#!/usr/bin/env python3
"""
check_candidates.py — canon-extraction integrity (ISS-003, ISS-004).

Two failures motivated this:
  ISS-003  CH04/CH05 candidates stored as a PROSE SUMMARY instead of records.
           A reported count of 65 could not be reconciled against 29 findable.
  ISS-004  CH06 was never extracted at all. Absence is invisible; malformation
           is merely ugly.

The checker ESTABLISHES the count from the artifact. It never accepts a
reported figure.

    python check_candidates.py <project_dir> [--ref HEAD]

Exit codes:
    0  ledger sound
    1  S1/S2 findings
    3  bad invocation
"""
from __future__ import annotations
import argparse, re, sys
from collections import Counter
from pathlib import Path

REC = re.compile(r"^\s*-\s*id:\s*(CAND-\S+)\s*(.*)$")
ID_OK = re.compile(r"^CAND-\d{4}$")   # exactly 4 digits, zero-padded
FIELDS = ("entity", "property", "value", "status")
SECTION = re.compile(r"^##\s+From\s+(CH\d{2})", re.I)
# prose-summary tells: a section that names chapters but holds no records
PROSE_TELL = re.compile(r"see .*handoff|summary:|candidates \d+[–-]\d+", re.I)


def drafted_chapters(root: Path) -> list[str]:
    out = []
    for p in sorted((root / "04_CHAPTERS").glob("ch*/scenes/*.md")):
        if any(s.startswith("_") for s in p.relative_to(root).parts):
            continue
        m = re.search(r"ch(\d+)", str(p))
        if m:
            ch = f"CH{int(m.group(1)):02d}"
            if ch not in out:
                out.append(ch)
    return out


def parse(path: Path):
    """Return (records, sections, prose_sections)."""
    recs, sections, prose = [], {}, []
    cur = None
    fence = False          # inside the section's ``` block?
    seen_fence = False     # has this section's block already closed?
    lines = path.read_text(encoding="utf-8").splitlines()
    for i, raw in enumerate(lines):
        if raw.strip().startswith("```"):
            # A section owns records inside its first fenced block only. Records
            # in a later block belong to no section -- they are unattributed,
            # not silently inherited by the last heading seen.
            if fence:
                fence = False; seen_fence = True
            elif not seen_fence:
                fence = True
            else:
                cur = None          # a second block: ownership has ended
            continue
        m = SECTION.match(raw)
        if m:
            fence = False; seen_fence = False
            cur = m.group(1).upper()
            sections.setdefault(cur, 0)
            # look ahead: does this section contain any record?
            body = "\n".join(lines[i + 1:i + 40])
            if not REC.search(body) and PROSE_TELL.search(body):
                prose.append(cur)
            continue
        r = REC.match(raw)
        if r:
            cid = r.group(1)
            # Bound the block at the NEXT record. A fixed window bleeds into
            # the following entry, so a malformed record silently inherits its
            # neighbour's fields and passes. Found by an isolated fixture.
            j = i + 1
            while j < len(lines) and not REC.match(lines[j]):
                j += 1
            block = "\n".join(lines[i:j])
            missing = [f for f in FIELDS if not re.search(rf"\b{f}:", block)]
            recs.append({"id": cid, "chapter": cur, "line": i + 1,
                         "missing": missing,
                         "promoted": "status: promoted" in block})
            if cur:
                sections[cur] = sections.get(cur, 0) + 1
    return recs, sections, prose


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Canon-extraction integrity.")
    ap.add_argument("project")
    ap.add_argument("--ref", default="HEAD")
    a = ap.parse_args(argv)

    root = Path(a.project).expanduser()
    led = root / "03_MEMORY" / "CANDIDATES.md"
    if not led.exists():
        print(f"[FATAL] no ledger at {led}", file=sys.stderr)
        return 3

    recs, sections, prose = parse(led)
    findings: list[tuple[str, str]] = []

    # mixed storage — prose summary where records are required
    for ch in prose:
        findings.append(("S2", f"{ch}: prose-summary storage where structured "
                               f"records are required (ISS-003 condition)"))

    # missing extraction — a drafted chapter with no ledger section
    for ch in drafted_chapters(root):
        if ch not in sections:
            findings.append(("S1", f"{ch}: drafted but NEVER EXTRACTED — no "
                                   f"ledger section (ISS-004 condition)"))
        elif sections[ch] == 0:
            findings.append(("S1", f"{ch}: ledger section present but empty"))

    # unattributed records — syntactically valid, but owned by no chapter.
    # These inflate the ledger total while belonging to nothing, so a stored
    # count and an artifact-derived count diverge with every record still valid.
    orphans = [r for r in recs if r["chapter"] is None]
    for r in orphans:
        findings.append(("S2", f"{r['id']} (line {r['line']}): unattributed — "
                               f"no owning '## From CHnn' section"))

    # duplicate ids
    # ---- SURFACE 3: DUPLICATES — only among syntactically valid ids ------
    for cid, n in Counter(r["id"] for r in recs
                          if ID_OK.match(r["id"])).items():
        if n > 1:
            findings.append(("S1", f"[DUPLICATE] {cid}: syntactically valid but "
                                   f"appears {n} times"))

    # ---- SURFACE 1: ID GRAMMAR ------------------------------------------
    # Runs FIRST and gates the rest. A record with an unusable identifier must
    # never reach field validation, because passing field checks would make a
    # malformed token look usable. Three distinct surfaces, never conflated:
    #   ID syntax failure  !=  malformed record  !=  duplicate ID
    bad_id = {r["id"] for r in recs if not ID_OK.match(r["id"])}
    for r in recs:
        if r["id"] in bad_id:
            findings.append(("S2", f"[ID SYNTAX] {r['id']} (line {r['line']}): "
                                   f"malformed identifier — expected CAND-nnnn, "
                                   f"exactly four zero-padded digits. Record-level "
                                   f"validation SKIPPED for this entry."))

    # ---- SURFACE 2: RECORD STRUCTURE ------------------------------------
    # Only for records whose identifier is usable.
    for r in recs:
        if r["id"] in bad_id:
            continue
        if r["missing"]:
            findings.append(("S2", f"[RECORD] {r['id']} (line {r['line']}): "
                                   f"missing {', '.join(r['missing'])}"))

    # gaps in the id sequence
    nums = sorted(int(r["id"].split("-")[1]) for r in recs
                  if ID_OK.match(r["id"]))
    if nums:
        gaps = [n for n in range(nums[0], nums[-1] + 1)
                if n not in set(nums)]
        if gaps:
            findings.append(("S2", f"id sequence gaps: "
                                   f"{', '.join(f'CAND-{g:04d}' for g in gaps)}"))

    # --- load-bearing quantitative facts -------------------------------
    # A fact is canon-bearing ONLY if it says so. Incidental prose numbers are
    # legitimately prose; a rule forcing every numeral into the ledger would be
    # brittle and would train people to game it. The marker is explicit.
    LB_FIELDS = ("value", "units", "precision", "provenance", "source_chapter")
    text = led.read_text(encoding="utf-8")
    lb_blocks = re.split(r"\n(?=\s*- id: CAND-)", text)
    lb = [b for b in lb_blocks
          if re.search(r"classification:\s*LOAD-BEARING", b, re.I)]
    for b in lb:
        cid = re.search(r"CAND-\d+", b).group(0)
        miss = [f for f in LB_FIELDS if not re.search(rf"\b{f}:", b)]
        if miss:
            findings.append(("S1", f"{cid}: marked LOAD-BEARING but missing "
                                   f"{', '.join(miss)} — a load-bearing figure "
                                   f"without provenance cannot be audited"))
        # downstream propagation: the affects set must actually carry it
        m = re.search(r"affects:\s*\[([^\]]+)\]", b)
        if m:
            # A declared target is a path this gate will READ. Left unchecked,
            # a record naming ../../../etc/passwd turns the candidate gate into
            # a file-disclosure primitive. Same class as PDF-015/016.
            import posixpath as _pp
            for _t in (x.strip() for x in m.group(1).split(",")):
                _n = _pp.normpath(_t.replace("\\", "/"))
                if _t.startswith("/") or _n.startswith("..") or "/../" in f"/{_n}/":
                    findings.append(("S1", f"[AFFECTS] {cid}: target {_t!r} "
                                           f"escapes the project root"))
        if m:
            val = re.search(r'value:\s*"?([^"\n]+)', b)
            key = re.findall(r"[\d]+\.[\d]+", val.group(1) if val else "")
            for target in [x.strip() for x in m.group(1).split(",")]:
                tp = root / target
                if not tp.exists():
                    findings.append(("S1", f"{cid}: affects {target}, which does not exist"))
                elif key and not any(k in tp.read_text(encoding="utf-8") for k in key):
                    findings.append(("S1", f"{cid}: load-bearing value not "
                                           f"propagated into {target}"))
        else:
            findings.append(("S2", f"{cid}: load-bearing but declares no affects set"))

    promoted = sum(1 for r in recs if r["promoted"])

    for sev, msg in findings:
        print(f"[{sev}] {msg}", file=sys.stderr)

    print(f"ESTABLISHED from artifact at ref {a.ref}:")
    print(f"  structured records : {len(recs)}")
    print(f"  promoted           : {promoted}")
    print(f"  chapters extracted : {len(sections)} "
          f"({', '.join(sorted(sections))})")
    print(f"  chapters drafted   : {len(drafted_chapters(root))}")
    print(f"  load-bearing facts : {len(lb)}")
    print(f"  findings           : {len(findings)}")
    if findings:
        print("        A reported count is not evidence. This figure is "
              "established from the ledger, not accepted from a report.",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
