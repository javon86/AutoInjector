"""D12 map graph extraction, deterministic SVG rendering and exact label/geometry checks.

Geometry from A04 uses extension predicates owned by Set D (Shared Contract section 10 /
predicate_registry "extensions"); their meaning is fixed here and documented in the report:

  x.map.x, x.map.y     number  - node position in the map unit (FACT, current interval)
  x.map.unit           string  - mm | px | world_units (default world_units)
  x.map.connects_to    list    - subject_ids this node has a drawn edge to
  entity.name          string  - canonical label spelling (registered predicate)

Labels compare to canonical spelling after NFC normalization (comparison only; stored and
rendered text keep their exact code points). Coordinates are copied, never rounded, so the
sidecar compares against the graph with geometry_tolerance (default 0).
"""
from __future__ import annotations

import math
import unicodedata
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape, quoteattr

from .canonical import sha256_bytes

EXPORTER_VERSION = "akowe-d12-svg/1.0.0"
UNITS = ("mm", "px", "world_units")


def current_facts(rec: dict, predicate: str) -> dict:
    """subject_id -> [values] of FACT assertions whose interval is open-ended (current)."""
    out: dict[str, list] = {}
    for f in (rec.get("data") or {}).get("facts", []):
        if f.get("predicate") != predicate or f.get("assertion_type") != "FACT" or f.get("effective_to") is not None:
            continue
        vals = out.setdefault(f["subject_id"], [])
        if f["value"] not in vals:
            vals.append(f["value"])
    return out


def canonical_labels(records: list[dict]) -> tuple[dict, dict, list[str]]:
    """(subject -> label, subject -> source record, conflicts) from entity.name FACTs."""
    labels, sources, conflicts = {}, {}, []
    for rec in records:
        for subj, vals in current_facts(rec, "entity.name").items():
            for v in vals:
                if not isinstance(v, str) or not v:
                    continue
                if subj in labels and nfc(labels[subj]) != nfc(v):
                    conflicts.append(f"{subj}: '{labels[subj]}' vs '{v}'")
                    continue
                labels.setdefault(subj, v)
                sources.setdefault(subj, rec)
    return labels, sources, conflicts


def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def extract_graph(a04: dict, label_records: list[dict], projection: str | None) -> tuple[dict | None, list[str]]:
    """Deterministic MapGraph from an approved A04 record's coordinate facts.

    Returns (graph, problems). problems are exact reasons the geometry cannot be extracted.
    """
    problems: list[str] = []
    xs, ys = current_facts(a04, "x.map.x"), current_facts(a04, "x.map.y")
    unit_vals = {v for vals in current_facts(a04, "x.map.unit").values() for v in vals}
    if len(unit_vals) > 1:
        problems.append(f"contradictory x.map.unit values {sorted(map(str, unit_vals))}")
    unit = next(iter(unit_vals)) if unit_vals else "world_units"
    if unit not in UNITS:
        problems.append(f"x.map.unit must be one of {UNITS}")
    labels, sources, conflicts = canonical_labels(label_records + [a04])
    problems += [f"contradictory canonical labels {c}" for c in conflicts]
    nodes = []
    for subj in sorted(set(xs) | set(ys)):
        xv, yv = xs.get(subj, []), ys.get(subj, [])
        if len(xv) != 1 or len(yv) != 1:
            problems.append(f"{subj}: needs exactly one current x.map.x and x.map.y FACT")
            continue
        x, y = xv[0], yv[0]
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (x, y)):
            problems.append(f"{subj}: coordinates must be finite numbers")
            continue
        if subj not in labels:
            problems.append(f"{subj}: no canonical entity.name label")
            continue
        nodes.append({"id": subj, "x": x, "y": y, "label": labels[subj], "canon_ref": sources[subj]["ref"]})
    if not nodes and not problems:
        problems.append("geometry source has no x.map.x/x.map.y coordinate facts")
    ids = {n["id"] for n in nodes}
    edges = []
    for subj, vals in sorted(current_facts(a04, "x.map.connects_to").items()):
        targets = [t for v in vals for t in (v if isinstance(v, list) else [v])]
        for t in sorted({str(t) for t in targets}):
            if subj not in ids or t not in ids:
                problems.append(f"edge {subj}->{t} references a node without geometry")
                continue
            edges.append({"id": f"{subj}->{t}", "from": subj, "to": t})
    graph = {"coordinate_system": projection or "cartesian", "unit": unit, "nodes": nodes, "edges": edges,
             "geometry_tolerance": 0}
    return (None if problems else graph), problems


def graph_problems(graph: dict) -> list[str]:
    """Structural graph rules: unique node/edge IDs and existing edge endpoints."""
    out = []
    ids = [n["id"] for n in graph["nodes"]]
    if len(ids) != len(set(ids)):
        out.append("node IDs are not unique")
    eids = [e["id"] for e in graph["edges"]]
    if len(eids) != len(set(eids)):
        out.append("edge IDs are not unique")
    known = set(ids)
    for e in graph["edges"]:
        if e["from"] not in known or e["to"] not in known:
            out.append(f"edge {e['id']} endpoint does not exist")
    return out


def _num(v) -> str:
    if isinstance(v, int):
        return str(v)
    return repr(float(v))


def _parse_num(s: str):
    return int(s) if s.lstrip("-").isdigit() else float(s)


def render_svg(graph: dict, *, title: str, legend: str | None = None, scale: str | None = None) -> bytes:
    """Deterministic SVG: same graph -> same bytes. Text/positions are exact graph values."""
    nodes = graph["nodes"]
    if nodes:
        minx, maxx = min(n["x"] for n in nodes), max(n["x"] for n in nodes)
        miny, maxy = min(n["y"] for n in nodes), max(n["y"] for n in nodes)
    else:
        minx = maxx = miny = maxy = 0
    span = max(maxx - minx, maxy - miny, 1)
    m = span * 0.1
    vb = f"{_num(minx - m)} {_num(miny - m)} {_num(maxx - minx + 2 * m)} {_num(maxy - miny + 2 * m)}"
    r = _num(span * 0.01)
    font = _num(span * 0.03)
    pos = {n["id"]: n for n in nodes}
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" data-exporter={quoteattr(EXPORTER_VERSION)} '
             f'data-unit={quoteattr(graph["unit"])} data-coordinate-system={quoteattr(graph["coordinate_system"])}>',
             f"<title>{escape(title)}</title>"]
    if legend:
        lines.append(f"<desc>{escape(legend)}</desc>")
    if scale:
        lines.append(f"<metadata data-scale={quoteattr(scale)}/>")
    lines.append('<g class="edges" stroke="#444" fill="none">')
    for e in sorted(graph["edges"], key=lambda e: e["id"]):
        a, b = pos[e["from"]], pos[e["to"]]
        lines.append(f'<line data-edge-id={quoteattr(e["id"])} data-from={quoteattr(e["from"])} '
                     f'data-to={quoteattr(e["to"])} x1="{_num(a["x"])}" y1="{_num(a["y"])}" '
                     f'x2="{_num(b["x"])}" y2="{_num(b["y"])}"/>')
    lines.append("</g>")
    lines.append(f'<g class="nodes" font-size="{font}" text-anchor="middle">')
    for n in sorted(nodes, key=lambda n: n["id"]):
        lines.append(f'<circle data-node-ref={quoteattr(n["id"])} cx="{_num(n["x"])}" cy="{_num(n["y"])}" r="{r}"/>')
        lines.append(f'<text data-node-id={quoteattr(n["id"])} x="{_num(n["x"])}" y="{_num(n["y"])}" '
                     f'dy="-{r}">{escape(n["label"])}</text>')
    lines.append("</g>")
    lines.append("</svg>")
    return ("\n".join(lines) + "\n").encode("utf-8")


def read_svg(svg: bytes) -> tuple[list[dict], list[dict]]:
    """Parse the actual rendered labels/edges back out of the SVG bytes."""
    root = ET.fromstring(svg)
    labels, edges = [], []
    for el in root.iter():
        if "data-node-id" in el.attrib:
            labels.append({"node_id": el.attrib["data-node-id"], "rendered_text": "".join(el.itertext()),
                           "x": _parse_num(el.attrib["x"]), "y": _parse_num(el.attrib["y"])})
        elif "data-edge-id" in el.attrib:
            edges.append({"edge_id": el.attrib["data-edge-id"], "from": el.attrib["data-from"],
                          "to": el.attrib["data-to"]})
    return labels, edges


def build_sidecar(graph_ref: dict, svg: bytes) -> dict:
    labels, edges = read_svg(svg)
    return {"graph_ref": graph_ref, "exporter_version": EXPORTER_VERSION, "file_hash": sha256_bytes(svg),
            "labels": labels, "edges": edges}


def compare(graph: dict, sidecar: dict, svg: bytes | None, canonical: dict, *, tolerance: float | None = None,
            graph_ref: dict | None = None, file_hash: str | None = None) -> list[tuple[str, bool, str]]:
    """Exact map validation. Returns [(rule_id, passed, message)]; raster-only input cannot pass."""
    tol = graph.get("geometry_tolerance", 0) if tolerance is None else tolerance
    out: list[tuple[str, bool, str]] = []
    gp = graph_problems(graph)
    out.append(("GRAPH_STRUCTURE", not gp, "; ".join(gp) or "node/edge IDs unique; every edge endpoint exists"))
    if graph_ref is not None:
        ok = sidecar.get("graph_ref") == graph_ref
        out.append(("SIDECAR_GRAPH_PIN", ok, "sidecar pins the source graph" if ok else
                    "sidecar graph_ref differs from source_graph_ref"))
    if file_hash is not None:
        ok = sidecar.get("file_hash") == file_hash
        out.append(("SIDECAR_FILE_HASH", ok, "sidecar binds the rendered file hash" if ok else
                    "sidecar file_hash differs from the map file"))
    if svg is None:
        out.append(("VECTOR_TEXT_LAYER", False, "no parseable vector/text layer; raster-only comparison cannot "
                    "pass exact map validation"))
    else:
        try:
            labels, edges = read_svg(svg)
        except ET.ParseError as exc:
            labels, edges = None, None
            out.append(("VECTOR_TEXT_LAYER", False, f"map file has no parseable vector/text layer: {exc}"))
        if labels is not None:
            ok = sha256_bytes(svg) == sidecar.get("file_hash")
            out.append(("SIDECAR_BYTES", ok, "sidecar hash equals the actual bytes" if ok else
                        "sidecar file_hash does not match the actual file bytes"))
            ok = (sorted(labels, key=lambda d: d["node_id"]) == sorted(sidecar["labels"], key=lambda d: d["node_id"])
                  and sorted(edges, key=lambda d: d["edge_id"]) == sorted(sidecar["edges"], key=lambda d: d["edge_id"]))
            out.append(("SIDECAR_MATCHES_FILE", ok, "sidecar lists the actual rendered labels/geometry" if ok else
                        "sidecar labels/edges differ from the rendered file"))
    by_node: dict[str, list] = {}
    for lab in sidecar["labels"]:
        by_node.setdefault(lab["node_id"], []).append(lab)
    node_ids = {n["id"] for n in graph["nodes"]}
    extra = sorted(set(by_node) - node_ids)
    if extra:
        out.append(("LABEL_EXACT", False, f"sidecar labels for unknown nodes {extra}"))
    for n in graph["nodes"]:
        labs = by_node.get(n["id"], [])
        if len(labs) != 1:
            out.append(("LABEL_EXACT", False, f"node {n['id']} rendered {len(labs)} labels (expected exactly 1)"))
            continue
        lab = labs[0]
        if lab["rendered_text"] != n["label"]:
            out.append(("LABEL_EXACT", False, f"node {n['id']} rendered '{lab['rendered_text']}' but the graph "
                        f"label is '{n['label']}'"))
        else:
            out.append(("LABEL_EXACT", True, f"node {n['id']} label rendered exactly"))
        dx, dy = abs(lab["x"] - n["x"]), abs(lab["y"] - n["y"])
        out.append(("GEOMETRY", dx <= tol and dy <= tol,
                    f"node {n['id']} offset ({dx}, {dy}) {graph['unit']} vs tolerance {tol}"))
        if n["id"] in canonical:
            ok = nfc(n["label"]) == nfc(canonical[n["id"]])
            out.append(("CANONICAL_LABEL", ok, f"node {n['id']} label '{n['label']}' "
                        + ("matches canonical spelling" if ok else f"differs from canonical '{canonical[n['id']]}'")))
    gedges = sorted((e["id"], e["from"], e["to"]) for e in graph["edges"])
    sedges = sorted((e["edge_id"], e["from"], e["to"]) for e in sidecar["edges"])
    out.append(("EDGES_EXACT", gedges == sedges, "edges match the graph" if gedges == sedges else
                "rendered edges differ from the graph"))
    return out
