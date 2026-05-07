from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

from airway_labeling.rules.book_candidate_rules import CandidateRuleEngine, load_candidate_rules, score_direction
from bronchoedu.airway_route import AirwayNetwork


MANUAL_SOURCE = "manual_seed_labels"
INFERRED_SOURCE = "manual_seeded_directional_rules"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Use partial manual airway labels as locked seeds and infer additional candidate labels.")
    parser.add_argument("--network-vtk", required=True, help="Path to Slicer/VMTK Network model.vtk.")
    parser.add_argument("--manual-labels-tsv", required=True, help="Two-column TSV: curve name, manual label.")
    parser.add_argument("--out-json", required=True, help="Browser candidate sidecar JSON output.")
    parser.add_argument("--report-md", required=True, help="Human-readable inference report.")
    parser.add_argument("--rules-yaml", default=None, help="Optional candidate rules YAML.")
    parser.add_argument("--coordinate-system", default="RAS", choices=["RAS", "LPS", "UNKNOWN"])
    parser.add_argument("--max-per-edge", type=int, default=4)
    return parser


def infer_manual_labels(args: argparse.Namespace) -> dict[str, Any]:
    network = AirwayNetwork.from_network_vtk(args.network_vtk)
    manual_entries = _load_manual_labels(args.manual_labels_tsv)
    edge_manual = {entry["edge_id"]: entry for entry in manual_entries if entry.get("edge_id") is not None}
    hierarchy = {
        "coordinate_system": args.coordinate_system,
        "allow_left_b7_8_combined_candidate": True,
        "edge_labels": {
            str(edge_id): {
                "label": entry["rule_label"] or entry["display_label"],
                "confidence": 1.0,
                "locked": True,
                "manual_label": True,
                "display_label": entry["display_label"],
            }
            for edge_id, entry in edge_manual.items()
        },
    }

    engine = CandidateRuleEngine(load_candidate_rules(args.rules_yaml), coordinate_system=args.coordinate_system)
    rule_results = engine.generate_candidates(network, hierarchy, levels=("segmental", "subsegmental"))
    children_by_edge, parent_by_edge = _edge_tree(network)
    manual_edge_ids = set(edge_manual)

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for edge_id, entry in sorted(edge_manual.items()):
        grouped[str(edge_id)].append(_manual_candidate(entry))

    for result in rule_results:
        edge_id = int(result.edge_id)
        if edge_id in manual_edge_ids:
            continue
        candidate = _result_candidate_dict(result, parent_by_edge, edge_manual)
        grouped[str(edge_id)].append(candidate)

    for candidate in _special_trunk_candidates(network, edge_manual, children_by_edge, parent_by_edge, args.coordinate_system):
        edge_id = str(candidate["edgeId"])
        if int(candidate["edgeId"]) in manual_edge_ids:
            continue
        grouped[edge_id].append(candidate)

    for edge_id, items in list(grouped.items()):
        deduped = _dedupe_candidates(items)
        grouped[edge_id] = sorted(deduped, key=lambda item: (-float(item["score"]), item["candidateLabel"]))[: max(1, args.max_per_edge)]

    payload = {
        "schema": "airway_labeling_candidate_results/v1",
        "mode": "manual_seeded_candidate_generation_not_final_labeling",
        "source": {
            "generator": "airway_labeling.scripts.infer_manual_labels",
            "networkVtk": str(args.network_vtk),
            "manualLabelsTsv": str(args.manual_labels_tsv),
            "coordinateSystem": args.coordinate_system,
            "manualSeedCount": len(edge_manual),
            "note": "Manual labels are locked seeds. Non-manual labels are candidates for review, not final labels.",
        },
        "edges": dict(sorted(grouped.items(), key=lambda item: int(item[0]))),
    }
    out_json = Path(args.out_json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(payload, indent=2, allow_nan=False), encoding="utf-8")
    Path(args.report_md).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report_md).write_text(
        _report_markdown(network, edge_manual, grouped, children_by_edge, parent_by_edge, out_json),
        encoding="utf-8",
    )
    return {
        "out_json": str(out_json),
        "report_md": str(args.report_md),
        "manual_seed_count": len(edge_manual),
        "edge_count_with_labels_or_candidates": len(grouped),
        "inferred_edge_count": sum(1 for edge_id in grouped if int(edge_id) not in manual_edge_ids),
    }


def _load_manual_labels(path: str | Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for line_number, raw_line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = re.split(r"\t+", line, maxsplit=1)
        if len(parts) != 2:
            raise ValueError(f"Manual label TSV line {line_number} must contain curve name and label separated by a tab.")
        curve_name, display_label = parts[0].strip(), parts[1].strip()
        edge_id = _network_curve_id(curve_name)
        entries.append(
            {
                "curve_name": curve_name,
                "edge_id": edge_id,
                "display_label": display_label,
                "rule_label": _rule_label(display_label),
                "line_number": line_number,
            }
        )
    return entries


def _network_curve_id(curve_name: str) -> int | None:
    match = re.search(r"Network curve\s*\((\d+)\)", curve_name, flags=re.IGNORECASE)
    return int(match.group(1)) if match else None


def _rule_label(label: str) -> str | None:
    clean = label.strip()
    lower = clean.lower()
    exact = {
        "right main bronchus": "RMB",
        "left main bronchus": "LMB",
        "rul bronchus origin": "RUL",
        "bronchus intermedius": "BI",
        "rll bronchus origin": "RLL",
        "rml bronchus origin": "RML",
        "lul bronchus origin": "LUL",
        "lll bronchus origin": "LLL",
        "upper division bronchus (lb1+2+3) origin": "LUL_SUPERIOR",
        "lingular bronchus origin": "LINGULA",
        "lll basal trunk (distal to lb6)": "LLL_BASAL",
        "rll basal trunk (between rb6 and rb7 origin)": "RLL_BASAL",
        "rll basal trunk (between rb7 and rb8 origin)": "RLL_BASAL_BETWEEN_RB7_RB8",
        "lb6 trunk distal to lb6c, proximal to lb6a/lb6b bifurcation": "LLL_B6_TRUNK_A_B",
        "rb6a+b orifice": "RLL_B6_TRUNK_A_B",
        "lb3a+b trunk": "LUL_B3a_b_TRUNK",
        "rb3a trunk proximal to rb3a1/rb3a2/rb3a3 branching": "RUL_B3a_TRUNK",
    }
    if lower in exact:
        return exact[lower]

    match = re.fullmatch(r"RB(10|[1-9])([abc])?", clean, flags=re.IGNORECASE)
    if match:
        segment = int(match.group(1))
        suffix = match.group(2) or ""
        section = "RUL" if segment <= 3 else "RML" if segment <= 5 else "RLL"
        return f"{section}_B{segment}{suffix.lower()}"

    match = re.fullmatch(r"LB(1\+2|10|[1-9])([abc])?", clean, flags=re.IGNORECASE)
    if match:
        segment_raw = match.group(1)
        suffix = match.group(2) or ""
        segment = segment_raw.replace("+", "_")
        section = "LUL" if segment_raw in {"1+2", "3"} else "LINGULA" if segment_raw in {"4", "5"} else "LLL"
        return f"{section}_B{segment}{suffix.lower()}"

    match = re.fullmatch(r"LB7\+8([abc])?", clean, flags=re.IGNORECASE)
    if match:
        suffix = match.group(1) or ""
        return f"LLL_B7_8{suffix.lower()}"
    return None


def _display_label(rule_label: str) -> str:
    label = rule_label
    label = label.replace("RUL_B", "RB").replace("RML_B", "RB").replace("RLL_B", "RB")
    label = label.replace("LUL_B", "LB").replace("LINGULA_B", "LB").replace("LLL_B", "LB")
    label = label.replace("LB1_2", "LB1+2").replace("LB7_8", "LB7+8")
    label = label.replace("LB3a_b_TRUNK", "LB3a+b trunk")
    label = label.replace("RB6_TRUNK_A_B", "RB6a+b orifice")
    label = label.replace("LB6_TRUNK_A_B", "LB6 trunk distal to LB6c, proximal to LB6a/LB6b bifurcation")
    return label


def _manual_candidate(entry: dict[str, Any]) -> dict[str, Any]:
    edge_id = int(entry["edge_id"])
    return {
        "edgeId": edge_id,
        "candidateLabel": entry["display_label"],
        "candidateLevel": "manual_locked",
        "score": 1.0,
        "evidence": {
            "manualCurveName": entry["curve_name"],
            "ruleLabel": entry["rule_label"],
            "locked": True,
        },
        "explanation": "Manual seed label supplied by user; treated as locked context for inference.",
        "warnings": [],
        "source": MANUAL_SOURCE,
    }


def _result_candidate_dict(result: Any, parent_by_edge: dict[int, int | None], edge_manual: dict[int, dict[str, Any]]) -> dict[str, Any]:
    edge_id = int(result.edge_id)
    parent_edge = parent_by_edge.get(edge_id)
    parent_entry = edge_manual.get(parent_edge) if parent_edge is not None else None
    display = _display_label(result.candidate_label)
    evidence = dict(result.evidence)
    evidence["internalCandidateLabel"] = result.candidate_label
    if parent_entry:
        evidence["manualParentLabel"] = parent_entry["display_label"]
    return {
        "edgeId": edge_id,
        "candidateLabel": display,
        "candidateLevel": result.candidate_level,
        "score": float(result.score),
        "evidence": evidence,
        "explanation": result.explanation,
        "warnings": list(result.warnings),
        "source": INFERRED_SOURCE,
    }


def _special_trunk_candidates(
    network: AirwayNetwork,
    edge_manual: dict[int, dict[str, Any]],
    children_by_edge: dict[int, list[int]],
    parent_by_edge: dict[int, int | None],
    coordinate_system: str,
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for parent_edge, entry in edge_manual.items():
        if entry["rule_label"] not in {"LLL_B6_TRUNK_A_B", "RLL_B6_TRUNK_A_B"}:
            continue
        side = "right" if entry["rule_label"].startswith("RLL_") else "left"
        label_prefix = "RB6" if side == "right" else "LB6"
        children = children_by_edge.get(parent_edge, [])
        if len(children) < 2:
            continue
        scored: list[tuple[float, int, str, list[str]]] = []
        for child in children:
            vector = _edge_vector(network, child)
            a_score = score_direction(vector, ["cranial"], side, coordinate_system)
            b_score = score_direction(vector, ["caudal", "lateral"], side, coordinate_system)
            scored.append((a_score, child, f"{label_prefix}a", ["cranial"]))
            scored.append((b_score, child, f"{label_prefix}b", ["caudal", "lateral"]))
        used_edges: set[int] = set()
        used_labels: set[str] = set()
        for raw_score, child, label, terms in sorted(scored, reverse=True):
            if child in used_edges or label in used_labels:
                continue
            used_edges.add(child)
            used_labels.add(label)
            candidates.append(
                {
                    "edgeId": child,
                    "candidateLabel": label,
                    "candidateLevel": "subsegmental",
                    "score": round(min(0.82, 0.55 + 0.35 * raw_score), 4),
                    "evidence": {
                        "manualParentEdge": parent_edge,
                        "manualParentLabel": entry["display_label"],
                        "parentEdge": parent_by_edge.get(child),
                        "directionTerms": terms,
                        "directionScore": raw_score,
                        "inferenceKind": "manual_trunk_split",
                    },
                    "explanation": f"{label} candidate from manually labeled {label_prefix} a/b trunk split using child direction.",
                    "warnings": ["candidate_from_manual_trunk_split_review_required"],
                    "source": INFERRED_SOURCE,
                }
            )
    return candidates


def _edge_vector(network: AirwayNetwork, edge_id: int) -> list[float]:
    edge = network.edges[edge_id]
    distances = network.root_distances
    proximal = edge.start_node if distances[edge.start_node] <= distances[edge.end_node] else edge.end_node
    points = edge.points_ras if proximal == edge.start_node else edge.points_ras[::-1]
    vector = points[-1] - points[0]
    return [float(value) for value in vector]


def _edge_tree(network: AirwayNetwork) -> tuple[dict[int, list[int]], dict[int, int | None]]:
    children_by_edge: dict[int, list[int]] = {edge.id: [] for edge in network.edges}
    parent_by_edge: dict[int, int | None] = {}
    distances = network.root_distances
    for edge in network.edges:
        proximal = edge.start_node if distances[edge.start_node] <= distances[edge.end_node] else edge.end_node
        if proximal == network.root_node_id:
            parent_by_edge[edge.id] = None
            continue
        parent = network.parents[proximal]
        parent_edge = parent[1] if parent is not None else None
        parent_by_edge[edge.id] = parent_edge
        if parent_edge is not None:
            children_by_edge[parent_edge].append(edge.id)
    return children_by_edge, parent_by_edge


def _dedupe_candidates(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    best: dict[str, dict[str, Any]] = {}
    for item in items:
        label = str(item["candidateLabel"])
        if label not in best or float(item["score"]) > float(best[label]["score"]):
            best[label] = item
    return list(best.values())


def _report_markdown(
    network: AirwayNetwork,
    edge_manual: dict[int, dict[str, Any]],
    grouped: dict[str, list[dict[str, Any]]],
    children_by_edge: dict[int, list[int]],
    parent_by_edge: dict[int, int | None],
    out_json: Path,
) -> str:
    manual_ids = set(edge_manual)
    inferred_edges = sorted(int(edge_id) for edge_id in grouped if int(edge_id) not in manual_ids)
    lines = [
        "# Manual-Seeded Airway Label Inference",
        "",
        f"Candidate sidecar: `{out_json}`",
        "",
        "Manual labels are locked seeds. Inferred labels are candidates for review, not final labels.",
        "",
        f"- Manual network-edge seeds: `{len(edge_manual)}`",
        f"- Edges with inferred candidates: `{len(inferred_edges)}`",
        "",
        "## Stronger Inferred Candidates",
        "",
        "| edge | parent edge | parent manual label | top candidate | score | next candidates |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for edge_id in inferred_edges:
        top_items = sorted(grouped[str(edge_id)], key=lambda item: -float(item["score"]))
        if not top_items:
            continue
        top = top_items[0]
        if float(top["score"]) < 0.75:
            continue
        parent = parent_by_edge.get(edge_id)
        parent_label = edge_manual.get(parent, {}).get("display_label", "") if parent is not None else ""
        next_items = ", ".join(f"{item['candidateLabel']} {float(item['score']):.2f}" for item in top_items[1:3])
        lines.append(f"| {edge_id} | {parent if parent is not None else ''} | {parent_label} | {top['candidateLabel']} | {float(top['score']):.2f} | {next_items} |")

    lines.extend(["", "## Manual Parents With Unlabeled Children", "", "| parent edge | manual label | unlabeled children |", "| --- | --- | --- |"])
    for edge_id, entry in sorted(edge_manual.items()):
        unlabeled = [child for child in children_by_edge.get(edge_id, []) if child not in manual_ids]
        if unlabeled:
            lines.append(f"| {edge_id} | {entry['display_label']} | {', '.join(str(child) for child in unlabeled)} |")

    del network
    return "\n".join(lines) + "\n"


def main() -> None:
    result = infer_manual_labels(build_parser().parse_args())
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
