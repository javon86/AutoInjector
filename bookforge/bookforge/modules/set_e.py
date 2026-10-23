"""Set E handlers: accepted story state and continuity (E01-E12).

All twelve operations share one deterministic engine (bookforge/e_state.py). A record's
OUTPUT is {entity_id, snapshot, accepted_event_ids, superseded_event_ids, findings,
affected_refs}; snapshot.facts is the state index and snapshot.links pins the predecessor
snapshot, checkpoint, baseline and the C event bundles that supplied applied events.

Modes (Shared Contract sections 9/10, Set E rules):
* INITIALIZE - no accepted head may exist; approved A/B baseline facts for the entity (or a
  known empty snapshot with the selection reason); optional events.
* APPLY - current_snapshot_ref must be the accepted head; >=1 event.
* REPLAY - current_snapshot_ref (head) + superseded_event_ids; optional checkpoint_ref (an
  accepted earlier snapshot preceding the earliest affected event); without it the replay
  starts from the current approved revisions of the recorded baseline. Remaining accepted
  events come from the E ledger and are re-verified.
* CHECK - findings only; never publishes a new state head.

Events are accepted only when their prose pin is ACCEPTED C prose (APPROVED/LOCKED), every
evidence span matches the prose text by code point offsets and SHA-256, and the event is
present unchanged in a C-owned CEventBundle for that prose pin. Caller status claims are
ignored. Invalid events become findings and are not applied.

CREATE produces a candidate and records its derivation (keyed by the candidate data hash) in
module state; UPDATE may only publish such a candidate onto the exact base snapshot it was
computed from, so callers cannot inject unexplained state. ACCEPT checks the derivation's
snapshot is still the accepted head, then moves the head (CAS), updates the event ledger and
marks impacted snapshots of other E records stale.
"""
from __future__ import annotations

import copy

from ..c_events import PROSE_OPS, find_bundles
from ..canonical import canonical_bytes, sha256_json, sha256_text
from ..e_state import Projection, event_body, overlaps, same, sort_key
from ..errors import BookforgeError
from . import register
from .base import Context, OperationHandler, Result

HEAD_NS, LEDGER_NS, BASELINE_NS, DERIV_NS = "e_head", "e_ledger", "e_baseline", "e_derivation"
APPROVED = ("APPROVED", "LOCKED")

# op -> (entity field, single-entity, tracked event paths; None = every entity.* path, "ALL" = every path)
OP_CONFIG = {
    "E01": ("character_id", True, None),
    "E02": ("entity_id", True, {"/location_id"}),
    "E03": ("timeline_id", False, "ALL"),
    "E04": ("relationship_id", False, {"/relationship_ids"}),
    "E05": ("character_id", True, {"/known_fact_ids"}),
    "E06": ("character_id", True, {"/condition_ids"}),
    "E07": ("holder_id", True, {"/inventory_ids"}),
    "E08": ("character_id", True, {"/power_remaining"}),
    "E09": ("thread_id", True, {"/resolution"}),
    "E10": ("event_ref", False, {"/resolution"}),
    "E11": ("chapter_id", False, "ALL"),
    "E12": ("manuscript_ref", False, "ALL"),
}


def _rev(ctx: Context, ns: str, key: str) -> int:
    row = ctx.store.query_one("SELECT revision FROM module_state WHERE project_id=? AND branch_id=? AND namespace=? "
                              "AND key=?", (ctx.project_id, ctx.branch_id, ns, key))
    return row["revision"] if row else 0


def _approved_version(ctx: Context, record_id: str) -> dict | None:
    latest = ctx.store.get_record(ctx.project_id, ctx.branch_id, record_id)
    if latest is None or not latest["approved_version"]:
        return None
    return ctx.store.get_record(ctx.project_id, ctx.branch_id, record_id, latest["approved_version"])


def _baseline_facts(rec: dict) -> list[dict]:
    d = rec.get("data") or {}
    if rec["module_id"][0] == "A":
        return list(d.get("facts") or [])
    out = []
    for v in d.values():  # B plans: lists of SemanticRecords
        if isinstance(v, list):
            for item in v:
                if isinstance(item, dict) and isinstance(item.get("facts"), list):
                    out.extend(item["facts"])
        elif isinstance(v, dict) and isinstance(v.get("facts"), list):
            out.extend(v["facts"])
    return out


@register(*OP_CONFIG)
class StateTracker(OperationHandler):

    # ---------------------------------------------------------------- configuration
    def entity_of(self, ctx: Context) -> str:
        field = OP_CONFIG[ctx.op_id][0]
        if field.endswith("_ref"):
            rec = ctx.field_record(field)
            if rec["record_kind"] != "OUTPUT":
                raise BookforgeError("INVALID_INPUT", f"/payload/{field}", "must pin prose OUTPUT, not an event bundle",
                                     status="REJECTED")
            return rec["record_id"]
        return ctx.payload[field]

    def paths(self, ctx: Context) -> dict:
        return dict(ctx.contracts.predicate_registry.get("event_paths", {}))

    def tracked(self, ctx: Context, path: str) -> bool:
        allowed = OP_CONFIG[ctx.op_id][2]
        if allowed == "ALL":
            return True
        if allowed is None:
            return self.paths(ctx).get(path, "").startswith("entity.")
        return path in allowed

    def tracked_predicate(self, ctx: Context, predicate: str) -> bool:
        allowed = OP_CONFIG[ctx.op_id][2]
        if allowed == "ALL":
            return predicate in set(self.paths(ctx).values())
        if allowed is None:
            return True  # E01 character state keeps every baseline fact about the character
        return predicate in {self.paths(ctx)[p] for p in allowed}

    # ---------------------------------------------------------------- baseline
    def baseline_records(self, ctx: Context, strict: bool, findings: list) -> list[dict]:
        found = []
        b = ctx.field_record("baseline_ref")
        if b is not None:
            found.append(("/payload/baseline_ref", b))
        for i, r in enumerate(ctx.field_records("source_refs")):
            if r["module_id"][0] in "AB" and r["record_kind"] == "OUTPUT":
                found.append((f"/payload/source_refs/{i}", r))
        out, seen = [], set()
        for path, r in found:
            if (r["record_id"], r["version"]) in seen:
                continue
            seen.add((r["record_id"], r["version"]))
            if r["lifecycle"] not in APPROVED:
                if strict:
                    raise BookforgeError("APPROVAL_REQUIRED", path, f"baseline {r['module_id']} {r['record_id']} "
                                         f"v{r['version']} is {r['lifecycle']}; INITIALIZE needs approved A/B baseline")
                findings.append(self._f(ctx, "UNAPPROVED_BASELINE", f"{path} is not approved canon; ignored",
                                        "MAJOR", "UNKNOWN", refs=[r["ref"]]))
                continue
            out.append(r)
        return out

    def state_records(self, ctx: Context, findings: list) -> list[dict]:
        """Accepted E snapshots pinned in a CHECK's source_refs (spec E: E11/E12 compare claims with A/E state)."""
        out, seen = [], set()
        for i, r in enumerate(ctx.field_records("source_refs")):
            if r["module_id"][0] != "E" or r["record_kind"] != "OUTPUT" or r["record_id"] in seen:
                continue
            seen.add(r["record_id"])
            snap = (r.get("data") or {}).get("snapshot")
            if not isinstance(snap, dict):
                continue
            if r["lifecycle"] not in APPROVED or r["stale"]:
                findings.append(self._f(ctx, "UNAPPROVED_STATE", f"/payload/source_refs/{i} is "
                                        f"{'stale' if r['stale'] else r['lifecycle']} E state, not the accepted "
                                        "state; ignored", "MAJOR", "UNKNOWN", refs=[r["ref"]]))
                continue
            out.append(r)
        return out

    def overlay_state(self, ctx: Context, entity: str, facts: list[dict], states: list[dict]) -> list[dict]:
        """Accepted E state replaces the A/B baseline series it projects (it already starts from that baseline)."""
        if not states:
            return facts
        single = OP_CONFIG[ctx.op_id][1]
        state_facts = [copy.deepcopy(f) for r in states for f in r["data"]["snapshot"]["facts"]
                       if f.get("assertion_type") == "FACT" and (not single or f["subject_id"] == entity)
                       and self.tracked_predicate(ctx, f["predicate"])]
        covered = {(f["subject_id"], f["predicate"]) for f in state_facts}
        out = [f for f in facts if (f["subject_id"], f["predicate"]) not in covered]
        seen = {canonical_bytes(f) for f in out}
        for f in state_facts:
            k = canonical_bytes(f)
            if k not in seen:
                seen.add(k)
                out.append(f)
        return out

    def select_facts(self, ctx: Context, entity: str, recs: list[dict]) -> list[dict]:
        single = OP_CONFIG[ctx.op_id][1]
        out, seen = [], set()
        for r in recs:
            for f in _baseline_facts(r):
                if f["assertion_type"] != "FACT" or (single and f["subject_id"] != entity):
                    continue
                if not self.tracked_predicate(ctx, f["predicate"]):
                    continue
                k = canonical_bytes(f)
                if k not in seen:
                    seen.add(k)
                    out.append(copy.deepcopy(f))
        return out

    @staticmethod
    def _f(ctx, rule, msg, severity="BLOCKING", decision="FAIL", evidence=None, refs=None):
        return ctx.finding(rule, msg, severity=severity, decision=decision, evidence=evidence, source_refs=refs)

    # ---------------------------------------------------------------- event verification
    def verify_event(self, ctx: Context, ev: dict, path: str, entity: str, prose: dict | None,
                     findings: list) -> dict | None:
        """Owner checks for one event; returns the matching C bundle record or None (finding added)."""
        refs = [ev["source_ref"]]
        if ev["status"] in ("SUPERSEDED", "REJECTED"):
            findings.append(self._f(ctx, "EVENT_STATUS", f"{path}: {ev['event_id']} is {ev['status']}", refs=refs))
            return None
        if ev["branch_id"] != ctx.branch_id:
            findings.append(self._f(ctx, "EVENT_BRANCH", f"{path}: event belongs to branch {ev['branch_id']}; it "
                                    "cannot mutate this branch implicitly", refs=refs))
            return None
        if len(ev["entity_ids"]) != 1:
            findings.append(self._f(ctx, "MULTI_ENTITY", f"{path}: an event addresses exactly one entity; submit an "
                                    "ordered batch with one event per entity", refs=refs))
            return None
        if OP_CONFIG[ctx.op_id][1] and ev["entity_ids"][0] != entity:
            findings.append(self._f(ctx, "ENTITY_MISMATCH", f"{path}: event addresses {ev['entity_ids'][0]}, this "
                                    f"tracker is {entity}", refs=refs))
            return None
        if ev["path"] not in self.paths(ctx):
            findings.append(self._f(ctx, "UNKNOWN_PREDICATE", f"{path}: {ev['path']} has no registered event_paths "
                                    "mapping; not applied, review required", "MAJOR", "UNKNOWN", refs=refs))
            return None
        if not self.tracked(ctx, ev["path"]):
            findings.append(self._f(ctx, "PATH_NOT_TRACKED", f"{path}: {ctx.op_id} does not track {ev['path']}",
                                    refs=refs))
            return None
        if prose is None or prose["module_id"] not in PROSE_OPS or prose["record_kind"] != "OUTPUT":
            findings.append(self._f(ctx, "EVENT_SOURCE", f"{path}: source_ref must pin C02-C11 prose", refs=refs))
            return None
        if prose["lifecycle"] not in APPROVED:
            findings.append(self._f(ctx, "PROSE_NOT_ACCEPTED", f"{path}: source prose {prose['record_id']} "
                                    f"v{prose['version']} is {prose['lifecycle']}; E accepts events only from "
                                    "accepted prose", refs=refs))
            return None
        text = prose["data"]["text"]
        for k, span in enumerate(ev["evidence"]):
            if span["record_ref"] != ev["source_ref"]:
                findings.append(self._f(ctx, "SPAN_SOURCE", f"{path}/evidence/{k}: span must pin the event's prose",
                                        evidence=[span], refs=refs))
                return None
            ok = 0 <= span["start"] <= span["end"] <= len(text) and \
                sha256_text(text[span["start"]:span["end"]]) == span["text_hash"]
            if not ok:
                findings.append(self._f(ctx, "SPAN_HASH", f"{path}/evidence/{k}: span [{span['start']},{span['end']}) "
                                        "does not match the prose text hash", evidence=[span], refs=refs))
                return None
        body = canonical_bytes(event_body(ev))
        for b in find_bundles(ctx.store, ctx.project_id, ctx.branch_id, ev["source_ref"]):
            if any(canonical_bytes(event_body(x)) == body for x in b["data"]["events"]):
                return b
        findings.append(self._f(ctx, "UNBUNDLED_EVENT", f"{path}: {ev['event_id']} is not an unchanged candidate in "
                                "a C event bundle for its prose", refs=refs))
        return None

    # ---------------------------------------------------------------- CREATE
    def create(self, ctx: Context) -> Result:
        if ctx.manual_candidate is not None:
            raise BookforgeError("INVALID_INPUT", "/manual_candidate", "E state is computed from accepted events; a "
                                 "caller cannot inject a state result", status="REJECTED")
        op, p = ctx.op_id, ctx.payload
        mode = p["mode"]
        entity = self.entity_of(ctx)
        hkey = f"{op}:{entity}"
        head_ref = (ctx.get_state(HEAD_NS, hkey) or {}).get("ref")
        ledger = (ctx.get_state(LEDGER_NS, hkey) or {}).get("events", {})
        cur = ctx.field_record("current_snapshot_ref")
        if cur is not None and (cur["record_kind"] != "OUTPUT" or cur["data"]["entity_id"] != entity):
            raise BookforgeError("INVALID_INPUT", "/payload/current_snapshot_ref",
                                 f"current snapshot must be a {op} snapshot of {entity}", status="REJECTED")
        findings: list[dict] = []
        links: list[dict] = []
        extra: list[dict] = []
        baseline_refs: list[dict] = []
        superseded_now: list[str] = []
        prior_superseded: list[str] = []
        carried: list[dict] = []
        checkpoint_keys: list[tuple] = []

        if mode == "INITIALIZE":
            if head_ref is not None:
                raise BookforgeError("INVALID_INPUT", "/payload/mode", f"{hkey} already has an accepted head; use "
                                     "APPLY or REPLAY", status="REJECTED")
            if cur is not None:
                raise BookforgeError("INVALID_INPUT", "/payload/current_snapshot_ref",
                                     "INITIALIZE starts without a current snapshot", status="REJECTED")
            recs = self.baseline_records(ctx, True, findings)
            baseline_refs = [r["ref"] for r in recs]
            facts = self.select_facts(ctx, entity, recs)
            start_accepted: list[str] = []
            if not facts:
                findings.append(self._f(ctx, "KNOWN_EMPTY", f"no selected approved baseline facts for {entity}"
                                        f" ({len(recs)} baseline record(s) selected); initialized a known empty "
                                        "snapshot", "INFO", "PASS", refs=baseline_refs))
        elif mode in ("APPLY", "REPLAY"):
            if head_ref is None:
                raise BookforgeError("MISSING_INPUT", "/payload/current_snapshot_ref",
                                     f"{hkey} has no accepted head; INITIALIZE first")
            if cur["ref"] != head_ref:
                raise BookforgeError("VERSION_CONFLICT", "/payload/current_snapshot_ref",
                                     f"stale snapshot {cur['record_id']} v{cur['version']}; the accepted head is "
                                     f"{head_ref['record_id']} v{head_ref['version']}", status="REJECTED")
            links.append(cur["ref"])
            prior_superseded = list(cur["data"]["superseded_event_ids"])
            if mode == "APPLY":
                facts = cur["data"]["snapshot"]["facts"]
                start_accepted = list(cur["data"]["accepted_event_ids"])
            else:
                if "superseded_event_ids" not in p:
                    raise BookforgeError("MISSING_INPUT", "/payload/superseded_event_ids",
                                         "REPLAY needs superseded_event_ids")
                accepted_now = cur["data"]["accepted_event_ids"]
                for i, sid in enumerate(p["superseded_event_ids"]):
                    if sid not in accepted_now:
                        raise BookforgeError("INVALID_INPUT", f"/payload/superseded_event_ids/{i}",
                                             f"{sid} is not an accepted event of the current snapshot",
                                             status="REJECTED")
                superseded_now = list(p["superseded_event_ids"])
                chk = ctx.field_record("checkpoint_ref")
                if chk is not None:
                    acc = chk["data"]["accepted_event_ids"]
                    if (chk["record_kind"] != "OUTPUT" or chk["data"]["entity_id"] != entity
                            or chk["lifecycle"] not in APPROVED + ("SUPERSEDED",)
                            or not set(acc) <= set(accepted_now)):
                        raise BookforgeError("INVALID_INPUT", "/payload/checkpoint_ref", "checkpoint must be an "
                                             f"accepted earlier {op} snapshot of {entity}", status="REJECTED")
                    if set(acc) & set(superseded_now):
                        raise BookforgeError("INVALID_INPUT", "/payload/checkpoint_ref", "checkpoint already contains "
                                             "a superseded event; choose an earlier checkpoint or the baseline",
                                             status="REJECTED")
                    facts = chk["data"]["snapshot"]["facts"]
                    start_accepted = list(acc)
                    links.append(chk["ref"])
                    checkpoint_keys = [sort_key(ledger[i]) for i in acc if i in ledger]
                else:
                    recs = self.baseline_records(ctx, True, findings)
                    if not recs:
                        for ref in (ctx.get_state(BASELINE_NS, hkey) or {}).get("refs", []):
                            rec = _approved_version(ctx, ref["record_id"])
                            if rec is not None:
                                recs.append(rec)
                    baseline_refs = [r["ref"] for r in recs]
                    facts = self.select_facts(ctx, entity, recs)
                    start_accepted = []
                for eid in accepted_now:
                    if eid in start_accepted or eid in superseded_now:
                        continue
                    if eid not in ledger:
                        raise BookforgeError("INVALID_INPUT", "/payload/current_snapshot_ref",
                                             f"accepted event {eid} missing from the {op} ledger")
                    carried.append(ledger[eid])
        else:  # CHECK
            if not p["source_refs"]:
                raise BookforgeError("MISSING_INPUT", "/payload/source_refs", "CHECK needs pinned manuscript/state/"
                                     "canon source_refs")
            base = cur
            if base is None and head_ref is not None:
                base = ctx.store.get_record(ctx.project_id, ctx.branch_id, head_ref["record_id"], head_ref["version"])
            if base is not None:
                facts = base["data"]["snapshot"]["facts"]
                start_accepted = list(base["data"]["accepted_event_ids"])
                prior_superseded = list(base["data"]["superseded_event_ids"])
                links.append(base["ref"])
            else:
                recs = self.baseline_records(ctx, False, findings)
                baseline_refs = [r["ref"] for r in recs]
                facts = self.select_facts(ctx, entity, recs)
                states = self.state_records(ctx, findings)
                facts = self.overlay_state(ctx, entity, facts, states)
                baseline_refs += [r["ref"] for r in states]
                start_accepted = []
        links.extend(baseline_refs)

        # -- verify carried (replayed) events: their prose must still be accepted
        seq: list[dict] = []
        for ev in carried:
            prose = ctx.store.get_record(ctx.project_id, ctx.branch_id, ev["source_ref"]["record_id"],
                                         ev["source_ref"]["version"])
            b = self.verify_event(ctx, dict(ev, status="CANDIDATE"), f"/ledger/{ev['event_id']}", entity, prose,
                                  findings)
            if b is None:
                findings.append(self._f(ctx, "SOURCE_SUPERSEDED", f"accepted event {ev['event_id']} no longer has "
                                        "accepted source prose; list it in superseded_event_ids"))
                continue
            extra.append(b["ref"])
            seq.append(ev)
        # -- verify submitted events
        seen: dict[str, bytes] = {}
        known = set(start_accepted) | {e["event_id"] for e in carried}
        new_ids: list[str] = []
        for i, ev in enumerate(p["events"]):
            path = f"/payload/events/{i}"
            body = canonical_bytes(event_body(ev))
            if ev["event_id"] in seen:
                if seen[ev["event_id"]] != body:
                    raise BookforgeError("EVENT_CONFLICT", path + "/event_id", "event_id reused with different "
                                         "content", status="REJECTED")
                continue
            seen[ev["event_id"]] = body
            if ev["event_id"] in superseded_now or ev["event_id"] in prior_superseded:
                findings.append(self._f(ctx, "EVENT_SUPERSEDED", f"{path}: {ev['event_id']} is superseded"))
                continue
            accepted_before = ledger.get(ev["event_id"], {}).get("status") == "ACCEPTED"
            if ev["event_id"] in known or accepted_before:
                prior = ledger.get(ev["event_id"])
                if prior is not None and canonical_bytes(event_body(prior)) != body:
                    raise BookforgeError("EVENT_CONFLICT", path + "/event_id", f"{ev['event_id']} was accepted with "
                                         "different content", status="REJECTED")
                findings.append(self._f(ctx, "DUPLICATE_EVENT", f"{path}: {ev['event_id']} already accepted; "
                                        "applied once", "INFO", "PASS"))
                continue
            b = self.verify_event(ctx, ev, path, entity, ctx.resolved.get(path + "/source_ref"), findings)
            if b is None:
                continue
            extra.append(b["ref"])
            seq.append(ev)
            new_ids.append(ev["event_id"])
        if checkpoint_keys and seq and min(sort_key(e) for e in seq) < max(checkpoint_keys):
            raise BookforgeError("INVALID_INPUT", "/payload/checkpoint_ref", "checkpoint does not precede the earliest "
                                 "affected event; replay from an earlier checkpoint or the baseline", status="REJECTED")

        # -- deterministic application
        proj = Projection(facts)
        applied: list[dict] = []
        registry = ctx.contracts.predicate_registry.get("predicates", {})
        limits = self.power_limits(ctx, hkey, baseline_refs) if op == "E08" else []
        for ev in sorted(seq, key=sort_key):
            predicate = self.paths(ctx)[ev["path"]]
            if limits and ev["path"] == "/power_remaining":
                over = self.power_limit_error(ev, limits)
                if over:
                    findings.append(self._f(ctx, "POWER_LIMIT", over, evidence=ev["evidence"],
                                            refs=[ev["source_ref"]] + [r for _, r in limits]))
                    continue
            err = proj.apply(ev, predicate, registry.get(predicate))
            if err:
                findings.append(self._f(ctx, err[0], err[1], evidence=ev["evidence"], refs=[ev["source_ref"]]))
                continue
            applied.append(dict(ev, status="ACCEPTED"))
        bundle_refs = sorted({canonical_bytes(r): r for r in extra}.values(), key=lambda r: r["record_id"])
        for r in bundle_refs:
            if r not in links:
                links.append(r)

        if mode == "CHECK":
            out_facts, accepted = [copy.deepcopy(f) for f in facts], list(start_accepted)
            applied_ids: list[str] = []
        else:
            out_facts = proj.sorted_facts()
            applied_ids = [e["event_id"] for e in applied]
            accepted = list(start_accepted) + applied_ids
        affected = self.affected_heads(ctx, hkey, superseded_now) if superseded_now else []
        summary = (f"{op} state of {entity}: {len(out_facts)} fact(s) from {len(accepted)} accepted event(s)"
                   + (" - check only, no new head" if mode == "CHECK" else ""))
        data = {"entity_id": entity,
                "snapshot": {"summary": summary, "facts": out_facts, "links": links},
                "accepted_event_ids": accepted,
                "superseded_event_ids": sorted(set(prior_superseded) | set(superseded_now)),
                "findings": findings, "affected_refs": affected}
        deriv = {"mode": mode, "entity_id": entity, "current_snapshot_ref": cur["ref"] if cur is not None else None,
                 "applied_events": applied if mode != "CHECK" else [], "superseded": superseded_now,
                 "baseline_refs": baseline_refs, "checked_events": [e["event_id"] for e in seq] if mode == "CHECK" else []}
        dkey = f"{op}:{sha256_json(data)}"
        conflicts = [f for f in findings if f["severity"] == "BLOCKING"]

        def commit(tx):
            items = (ctx.get_state(DERIV_NS, dkey) or {}).get("items", [])
            if not any(same(x, deriv) for x in items):
                tx.put_state(ctx.project_id, ctx.branch_id, DERIV_NS, dkey, {"items": items + [deriv]})
            if conflicts:
                tx.insert_outbox(ctx.project_id, ctx.branch_id, "e.conflict_candidates",
                                 {"operation_id": op, "entity_id": entity, "mode": mode,
                                  "findings": [{"rule_id": f["rule_id"], "message": f["message"]} for f in conflicts]})
        ctx.on_commit(commit)
        return Result(data=data, findings=list(findings), source_refs=baseline_refs + bundle_refs, transform="LOGIC")

    # ---------------------------------------------------------------- A09 power limits (E08)
    def power_limits(self, ctx: Context, hkey: str, baseline_refs: list[dict]) -> list[tuple]:
        """Numeric x.a09.limit facts of the approved A09 systems governing this character.

        A09 records come from the selected baseline (this request's or the one recorded at INITIALIZE), the
        A09 records those baseline A records link to, and approved A09 records pinned in source_refs.
        """
        refs = list(baseline_refs) + list((ctx.get_state(BASELINE_NS, hkey) or {}).get("refs", []))
        refs += [r["ref"] for r in ctx.field_records("source_refs") if r["lifecycle"] in APPROVED]
        a09s, seen = [], set()

        def add(rec):
            if rec is not None and rec["module_id"] == "A09" and rec["record_id"] not in seen:
                seen.add(rec["record_id"])
                a09s.append(rec)
        for ref in refs:
            rec = _approved_version(ctx, ref["record_id"])
            if rec is None or rec["module_id"][0] != "A":
                continue
            add(rec)
            for link in (rec.get("data") or {}).get("linked_refs") or []:
                if isinstance(link, dict) and link.get("module_id") == "A09":
                    add(_approved_version(ctx, link["record_id"]))
        out = []
        for rec in a09s:
            for f in (rec.get("data") or {}).get("facts") or []:
                v = f.get("value")
                if (f.get("predicate") == "x.a09.limit" and f.get("assertion_type", "FACT") == "FACT"
                        and isinstance(v, (int, float)) and not isinstance(v, bool)):
                    out.append((v, rec["ref"]))
        return out

    @staticmethod
    def power_limit_error(ev: dict, limits: list[tuple]) -> str | None:
        """Spec E: power use exceeding A09 limits is a finding. The strictest numeric limit bounds both the
        power a character can hold and the amount spent by one event."""
        limit = min(v for v, _ in limits)
        before, after = ev["before"], ev["after"]
        num = (lambda x: isinstance(x, (int, float)) and not isinstance(x, bool))
        if num(after) and after > limit:
            return (f"{ev['event_id']}: power {after} exceeds the A09 limit of {limit}; the power system does not "
                    "allow it (change the prose or the A09 limits)")
        if num(before) and num(after) and before - after > limit:
            return (f"{ev['event_id']}: spends {before - after} power at once, more than the A09 limit of {limit}")
        return None

    def affected_heads(self, ctx: Context, hkey: str, superseded: list[str]) -> list[dict]:
        out = []
        ledgers = ctx.store.list_state(ctx.project_id, ctx.branch_id, LEDGER_NS)
        heads = ctx.store.list_state(ctx.project_id, ctx.branch_id, HEAD_NS)
        for key in sorted(ledgers):
            if key == hkey or key not in heads:
                continue
            evs = ledgers[key].get("events", {})
            if any(evs.get(s, {}).get("status") == "ACCEPTED" for s in superseded):
                out.append(heads[key]["ref"])
        return out

    # ---------------------------------------------------------------- UPDATE
    def update(self, ctx: Context) -> Result:
        base = ctx.base
        derivs = self._derivations(ctx, ctx.payload)
        if not any(d["mode"] in ("APPLY", "REPLAY") and d["current_snapshot_ref"] == base["ref"] for d in derivs):
            raise BookforgeError("INVALID_INPUT", "/payload", "unexplained state: UPDATE publishes only a CREATE "
                                 "candidate computed from this exact base snapshot", status="REJECTED")
        hkey = f"{ctx.op_id}:{base['data']['entity_id']}"
        head_ref = (ctx.get_state(HEAD_NS, hkey) or {}).get("ref")
        if head_ref != base["ref"]:
            raise BookforgeError("VERSION_CONFLICT", "/base_ref", "base snapshot is no longer the accepted head",
                                 status="REJECTED")
        return Result(data=copy.deepcopy(ctx.payload), transform="LOGIC")

    # ---------------------------------------------------------------- VALIDATE / ACCEPT
    def _derivations(self, ctx: Context, data: dict) -> list[dict]:
        return (ctx.get_state(DERIV_NS, f"{ctx.op_id}:{sha256_json(data)}") or {}).get("items", [])

    def validate(self, ctx: Context, record: dict) -> list[dict]:
        out = []
        data = record["data"]
        derivs = self._derivations(ctx, data)
        if not derivs:
            out.append(self._f(ctx, "UNEXPLAINED_STATE", "no E derivation produced this snapshot; state must be "
                               "computed by CREATE from accepted events"))
        for f in data["findings"]:
            if f["severity"] == "BLOCKING" and f["decision"] in ("FAIL", "UNKNOWN"):
                out.append(self._f(ctx, "CANDIDATE_FINDING", f"{f['rule_id']}: {f['message']}", evidence=f["evidence"],
                                   refs=f["source_refs"]))
        for subj, pred in overlaps(data["snapshot"]["facts"]):
            out.append(self._f(ctx, "FACT_INDEX", f"{subj} {pred} has overlapping effective intervals"))
        for d in derivs[:1]:
            for ev in d["applied_events"]:
                src = ev["source_ref"]
                prose = ctx.store.get_record(ctx.project_id, ctx.branch_id, src["record_id"], src["version"])
                if ev["event_id"] in data["superseded_event_ids"]:
                    continue
                if prose is None or prose["lifecycle"] not in APPROVED:
                    out.append(self._f(ctx, "PROSE_NOT_ACCEPTED", f"{ev['event_id']}: source prose is no longer "
                                       "accepted; replay with this event superseded", refs=[src]))
                    continue
                text = prose["data"]["text"]
                for span in ev["evidence"]:
                    if sha256_text(text[span["start"]:span["end"]]) != span["text_hash"]:
                        out.append(self._f(ctx, "SPAN_HASH", f"{ev['event_id']}: evidence span hash mismatch",
                                           evidence=[span], refs=[src]))
        return out

    def requires_explicit_approval(self, ctx: Context, record: dict) -> bool:
        """Unknown predicates/semantics need an authorized review (approval_ref) before acceptance."""
        return any(f["decision"] == "UNKNOWN" for f in record["data"]["findings"])

    def accept_gate(self, ctx: Context, record: dict, approval: dict | None) -> list[dict]:
        hkey = f"{ctx.op_id}:{record['data']['entity_id']}"
        head_ref = (ctx.get_state(HEAD_NS, hkey) or {}).get("ref")
        rev = _rev(ctx, HEAD_NS, hkey)
        for d in self._derivations(ctx, record["data"]):
            ok = (d["mode"] == "CHECK" or (d["mode"] == "INITIALIZE" and head_ref is None)
                  or (d["mode"] in ("APPLY", "REPLAY") and d["current_snapshot_ref"] == head_ref))
            if ok:
                ctx.e_accept = (d, rev, hkey)
                return []
        return [self._f(ctx, "STALE_SNAPSHOT", "the snapshot this candidate was computed from is no longer the "
                        "accepted head; create a new candidate from the current head", refs=[head_ref] if head_ref else [])]

    def on_accept(self, ctx: Context, record: dict, tx) -> None:
        d, rev, hkey = ctx.e_accept
        if d["mode"] == "CHECK":
            tx.insert_outbox(ctx.project_id, ctx.branch_id, "e.check_accepted",
                             {"operation_id": ctx.op_id, "ref": record["ref"], "entity_id": d["entity_id"]})
            return
        tx.put_state(ctx.project_id, ctx.branch_id, HEAD_NS, hkey, {"ref": record["ref"], "mode": d["mode"]},
                     expected_revision=rev)
        ledger = copy.deepcopy((ctx.get_state(LEDGER_NS, hkey) or {}).get("events", {}))
        for ev in d["applied_events"]:
            ledger[ev["event_id"]] = dict(ev, status="ACCEPTED")
        for sid in d["superseded"]:
            if sid in ledger:
                ledger[sid]["status"] = "SUPERSEDED"
        tx.put_state(ctx.project_id, ctx.branch_id, LEDGER_NS, hkey, {"events": ledger})
        if d["mode"] == "INITIALIZE":
            tx.put_state(ctx.project_id, ctx.branch_id, BASELINE_NS, hkey, {"refs": d["baseline_refs"]})
        for ref in record["data"]["affected_refs"]:
            tx.mark_stale(ctx.project_id, ctx.branch_id, ref["record_id"], ref["version"],
                          f"events {d['superseded']} superseded by {ctx.op_id} replay {record['record_id']}")
        tx.insert_outbox(ctx.project_id, ctx.branch_id, "e.state_accepted",
                         {"operation_id": ctx.op_id, "entity_id": d["entity_id"], "ref": record["ref"],
                          "mode": d["mode"], "applied_event_ids": [e["event_id"] for e in d["applied_events"]],
                          "superseded_event_ids": d["superseded"], "affected_refs": record["data"]["affected_refs"]})


__all__ = ["StateTracker", "OP_CONFIG"]
