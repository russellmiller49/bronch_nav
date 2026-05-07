from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from airway_labeling.rules.book_candidate_rules import (
    CandidateRuleEngine,
    candidate_results_payload,
    load_candidate_rules,
)
from bronchoedu.airway_route import AirwayNetwork


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Export book-rule airway label candidates as a browser sidecar JSON.")
    parser.add_argument("--network-vtk", required=True, help="Path to the Slicer/VMTK Network model.vtk.")
    parser.add_argument("--out-json", required=True, help="Output candidate sidecar JSON.")
    parser.add_argument("--hierarchy-json", default=None, help="Optional parent/locked label hierarchy JSON.")
    parser.add_argument("--rules-yaml", default=None, help="Optional bronchial branch tracing candidate YAML.")
    parser.add_argument("--coordinate-system", default="RAS", choices=["RAS", "LPS", "UNKNOWN"], help="Coordinate system for edge directions.")
    parser.add_argument("--max-per-edge", type=int, default=4, help="Maximum candidates to keep per edge.")
    parser.add_argument(
        "--node-label",
        action="append",
        default=[],
        metavar="NODE_ID=LABEL",
        help="Seed a parent-context node label, for example --node-label 3=RUL. Can be repeated.",
    )
    parser.add_argument(
        "--edge-label",
        action="append",
        default=[],
        metavar="EDGE_ID=LABEL",
        help="Seed a locked parent edge label, for example --edge-label 6=RUL_B1. Can be repeated.",
    )
    parser.add_argument(
        "--level",
        action="append",
        choices=["segmental", "subsegmental"],
        default=[],
        help="Candidate level to export. Repeat for both. Defaults to segmental and subsegmental.",
    )
    return parser


def export_book_candidates(args: argparse.Namespace) -> dict[str, Any]:
    hierarchy = _load_hierarchy(args.hierarchy_json)
    hierarchy["coordinate_system"] = args.coordinate_system
    _merge_cli_labels(hierarchy, args.node_label, args.edge_label)

    rules = load_candidate_rules(args.rules_yaml)
    network = AirwayNetwork.from_network_vtk(args.network_vtk)
    engine = CandidateRuleEngine(rules, coordinate_system=args.coordinate_system)
    levels = tuple(args.level or ["segmental", "subsegmental"])
    results = engine.generate_candidates(network, hierarchy, levels=levels)
    payload = candidate_results_payload(
        results,
        source={
            "generator": "airway_labeling.scripts.export_book_candidates",
            "networkVtk": str(args.network_vtk),
            "rulesYaml": str(args.rules_yaml) if args.rules_yaml else None,
            "hierarchyJson": str(args.hierarchy_json) if args.hierarchy_json else None,
            "coordinateSystem": args.coordinate_system,
            "seedNodeLabels": hierarchy.get("node_labels", {}),
            "seedEdgeLabels": hierarchy.get("edge_labels", {}),
            "reviewQueue": hierarchy.get("review_queue", []),
        },
        max_per_edge=max(1, int(args.max_per_edge)),
    )
    out_path = Path(args.out_json)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, allow_nan=False), encoding="utf-8")
    return {
        "out_json": str(out_path),
        "edge_count_with_candidates": len(payload["edges"]),
        "candidate_count": sum(len(items) for items in payload["edges"].values()),
        "review_queue_count": len(hierarchy.get("review_queue", [])),
    }


def _load_hierarchy(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Hierarchy JSON must contain an object.")
    return payload


def _merge_cli_labels(hierarchy: dict[str, Any], node_labels: list[str], edge_labels: list[str]) -> None:
    node_map = hierarchy.setdefault("node_labels", {})
    edge_map = hierarchy.setdefault("edge_labels", {})
    if not isinstance(node_map, dict) or not isinstance(edge_map, dict):
        raise ValueError("Hierarchy node_labels and edge_labels must be objects when provided.")
    for spec in node_labels:
        key, label = _parse_label_spec(spec, "--node-label")
        node_map[str(key)] = {"label": label, "confidence": 1.0, "locked": True}
    for spec in edge_labels:
        key, label = _parse_label_spec(spec, "--edge-label")
        edge_map[str(key)] = {"label": label, "confidence": 1.0, "locked": True}


def _parse_label_spec(spec: str, flag: str) -> tuple[str, str]:
    if "=" not in spec:
        raise ValueError(f"{flag} must be formatted as ID=LABEL.")
    key, label = spec.split("=", 1)
    key = key.strip()
    label = label.strip()
    if not key or not label:
        raise ValueError(f"{flag} must include both ID and LABEL.")
    return key, label


def main() -> None:
    summary = export_book_candidates(build_parser().parse_args())
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
