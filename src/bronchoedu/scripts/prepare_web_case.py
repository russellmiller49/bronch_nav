from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import SimpleITK as sitk

from bronchoedu.airway_route import AirwayNetwork
from bronchoedu.io import read_image


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Prepare a browser-friendly bronchoscopy training case.")
    parser.add_argument("--ct", required=True, help="Target or synthetic CT NRRD/NIfTI aligned to the airway.")
    parser.add_argument("--network-vtk", required=True, help="Path to the airway Network model.vtk.")
    parser.add_argument("--route-json", required=True, help="Existing route JSON used to seed the initial nodule target.")
    parser.add_argument("--out-dir", required=True, help="Output directory for case.json and ct_uint8.raw.")
    parser.add_argument("--case-id", default="default", help="Case identifier written into case.json.")
    parser.add_argument("--stride", type=int, default=2, help="Integer downsample stride for the CT preview volume.")
    parser.add_argument("--window-min", type=float, default=-1050.0, help="CT window lower HU for browser preview.")
    parser.add_argument("--window-max", type=float, default=350.0, help="CT window upper HU for browser preview.")
    parser.add_argument(
        "--nodule-asset-dir",
        default=None,
        help="Optional reusable nodule asset directory. When provided, browser residual/alpha volumes are exported.",
    )
    parser.add_argument(
        "--scope-calibration-json",
        default=None,
        help="Optional bronchoscope scope-calibration JSON exported from the web debug UI.",
    )
    parser.add_argument(
        "--airway-anatomy-json",
        default=None,
        help="Optional airway_anatomy_labels.json produced by bronchoedu-import-airmorph-labels.",
    )
    parser.add_argument(
        "--airway-candidates-json",
        default=None,
        help="Optional book-rule airway candidate labels JSON produced by airway-labeling-export-book-candidates.",
    )
    return parser


def _round_list(values: Sequence[float], ndigits: int = 4) -> list[float]:
    return [round(float(v), ndigits) for v in values]


def _safe_round(value: float, ndigits: int = 4) -> float | None:
    return round(float(value), ndigits) if math.isfinite(float(value)) else None


def _sanitize_json(value: Any) -> Any:
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: _sanitize_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_sanitize_json(item) for item in value]
    return value


def _distance(a: Sequence[float], b: Sequence[float]) -> float:
    return float(np.linalg.norm(np.asarray(a, dtype=float) - np.asarray(b, dtype=float)))


def _window_to_uint8(array_zyx: np.ndarray, window_min: float, window_max: float) -> np.ndarray:
    clipped = np.clip(array_zyx.astype(np.float32), window_min, window_max)
    scaled = (clipped - window_min) / max(window_max - window_min, 1.0)
    return np.round(scaled * 255.0).astype(np.uint8)


def _prepare_nodule_asset(asset_dir: str | Path, out_dir: Path) -> dict[str, Any]:
    asset_path = Path(asset_dir)
    metadata_path = asset_path / "metadata.json"
    if not metadata_path.exists():
        raise FileNotFoundError(f"Nodule asset metadata not found: {metadata_path}")

    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    residual_img = read_image(asset_path / "residual_signal.nrrd")
    alpha_img = read_image(asset_path / "alpha.nrrd")
    if residual_img.GetSize() != alpha_img.GetSize():
        raise ValueError("Nodule residual_signal.nrrd and alpha.nrrd sizes differ.")
    if not np.allclose(residual_img.GetSpacing(), alpha_img.GetSpacing(), atol=1e-5):
        raise ValueError("Nodule residual_signal.nrrd and alpha.nrrd spacings differ.")

    residual_zyx = sitk.GetArrayFromImage(residual_img).astype(np.float32)
    alpha_zyx = np.clip(sitk.GetArrayFromImage(alpha_img).astype(np.float32), 0.0, 1.0)
    residual_name = "nodule_residual_int16.raw"
    alpha_name = "nodule_alpha_uint8.raw"
    residual_raw = np.rint(np.clip(residual_zyx, -32768, 32767)).astype("<i2")
    alpha_raw = np.round(alpha_zyx * 255.0).astype(np.uint8)
    (out_dir / residual_name).write_bytes(residual_raw.tobytes(order="C"))
    (out_dir / alpha_name).write_bytes(alpha_raw.tobytes(order="C"))

    return {
        "assetId": metadata.get("asset_id", asset_path.name),
        "residualRaw": residual_name,
        "alphaRaw": alpha_name,
        "residualRawType": "int16",
        "alphaRawType": "uint8",
        "sizeXyz": [int(v) for v in residual_img.GetSize()],
        "spacingXyzMm": _round_list(residual_img.GetSpacing(), 6),
        "centroidIndexXyz": _round_list(metadata["centroid_index_xyz"], 6),
        "maxRadiusMm": _safe_round(float(metadata.get("max_radius_mm", 0.0)), 4),
        "mode": "residual",
    }


def _load_scope_calibration(path: str | Path, case_id: str) -> dict[str, Any]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Scope calibration JSON must contain an object.")
    adjustments = payload.get("adjustments", payload)
    if not isinstance(adjustments, dict):
        raise ValueError("Scope calibration JSON must include an adjustments object.")
    return {
        "schema": str(payload.get("schema", "bronchoedu_scope_calibration/v1")),
        "caseId": str(payload.get("caseId", case_id)),
        "exportedAt": payload.get("exportedAt"),
        "adjustments": adjustments,
    }


def _load_airway_anatomy(path: str | Path) -> dict[str, Any]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Airway anatomy JSON must contain an object.")
    if payload.get("schema") != "bronchoedu_airway_anatomy/v1":
        raise ValueError("Airway anatomy JSON schema must be bronchoedu_airway_anatomy/v1.")
    if not isinstance(payload.get("edges"), dict) or not isinstance(payload.get("nodes"), dict):
        raise ValueError("Airway anatomy JSON must include nodes and edges objects.")
    return payload


def _load_airway_candidates(path: str | Path) -> dict[str, Any]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Airway candidates JSON must contain an object.")
    if payload.get("schema") != "airway_labeling_candidate_results/v1":
        raise ValueError("Airway candidates JSON schema must be airway_labeling_candidate_results/v1.")
    if not isinstance(payload.get("edges"), dict):
        raise ValueError("Airway candidates JSON must include an edges object.")
    return payload


def _anatomy_for(collection: dict[str, Any], item_id: int) -> dict[str, Any] | None:
    value = collection.get(str(item_id), collection.get(item_id))
    return value if isinstance(value, dict) else None


def _candidate_labels_for(collection: dict[str, Any], item_id: int) -> list[dict[str, Any]]:
    value = collection.get(str(item_id), collection.get(item_id))
    if isinstance(value, dict):
        raw_items = value.get("candidateLabels", value.get("candidates", []))
    else:
        raw_items = value
    if not isinstance(raw_items, list):
        return []

    labels = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        label = item.get("candidateLabel", item.get("candidate_label"))
        if not label:
            continue
        raw_score = item.get("score", 0.0)
        score = float(raw_score) if isinstance(raw_score, (int, float)) and math.isfinite(float(raw_score)) else 0.0
        labels.append(
            {
                "candidateLabel": str(label),
                "candidateLevel": str(item.get("candidateLevel", item.get("candidate_level", "segmental"))),
                "score": _safe_round(score, 4),
                "explanation": str(item.get("explanation", "")),
                "warnings": [str(value) for value in item.get("warnings", []) if isinstance(value, str)],
                "source": str(item.get("source", "book_directional_rules")),
                "evidence": item.get("evidence", {}),
            }
        )
    return labels


def _nearest_terminal_id(network: AirwayNetwork, target_ras: Sequence[float]) -> int:
    candidates = [
        node
        for node in network.nodes
        if node.kind == "terminal" and node.id != network.root_node_id and math.isfinite(network.root_distances[node.id])
    ]
    if not candidates:
        raise ValueError("Airway network does not contain a terminal node other than the root.")
    return min(candidates, key=lambda node: _distance(node.ras, target_ras)).id


def _edge_payload(
    network: AirwayNetwork,
    anatomy: dict[str, Any] | None = None,
    candidates: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    edges = []
    anatomy_edges = anatomy.get("edges", {}) if anatomy else {}
    candidate_edges = candidates.get("edges", {}) if candidates else {}
    for edge in network.edges:
        payload: dict[str, Any] = {
            "id": edge.id,
            "cellId": edge.cell_id,
            "startNode": edge.start_node,
            "endNode": edge.end_node,
            "lengthMm": round(float(edge.length_mm), 4),
            "meanRadiusMm": _safe_round(edge.mean_radius_mm),
            "minRadiusMm": _safe_round(edge.min_radius_mm),
            "pointsRas": [_round_list(point, 3) for point in edge.points_ras],
        }
        if edge.radius_mm.size:
            payload["radiusMm"] = [round(float(value), 3) for value in edge.radius_mm]
        edge_anatomy = _anatomy_for(anatomy_edges, edge.id)
        if edge_anatomy is not None:
            payload["anatomy"] = edge_anatomy
        candidate_labels = _candidate_labels_for(candidate_edges, edge.id)
        if candidate_labels:
            payload["candidateLabels"] = candidate_labels
        edges.append(payload)
    return edges


def _node_payload(network: AirwayNetwork, anatomy: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    nodes = []
    anatomy_nodes = anatomy.get("nodes", {}) if anatomy else {}
    for node in network.nodes:
        parent = network.parents[node.id]
        payload: dict[str, Any] = {
            "id": node.id,
            "ras": _round_list(node.ras, 3),
            "kind": node.kind,
            "degree": node.degree,
            "rootDistanceMm": round(float(network.root_distances[node.id]), 4),
            "parentNodeId": int(parent[0]) if parent else None,
            "parentEdgeId": int(parent[1]) if parent else None,
        }
        node_anatomy = _anatomy_for(anatomy_nodes, node.id)
        if node_anatomy is not None:
            payload["anatomy"] = node_anatomy
        nodes.append(payload)
    return nodes


def prepare_web_case(args: argparse.Namespace) -> dict[str, Any]:
    stride = max(1, int(args.stride))
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    ct = read_image(args.ct)
    array_zyx = sitk.GetArrayFromImage(ct)
    preview_zyx = _window_to_uint8(array_zyx[::stride, ::stride, ::stride], args.window_min, args.window_max)
    raw_name = "ct_uint8.raw"
    (out_dir / raw_name).write_bytes(preview_zyx.tobytes(order="C"))

    network = AirwayNetwork.from_network_vtk(args.network_vtk)
    airway_anatomy = _load_airway_anatomy(args.airway_anatomy_json) if args.airway_anatomy_json else None
    airway_candidates = _load_airway_candidates(args.airway_candidates_json) if getattr(args, "airway_candidates_json", None) else None
    route_seed = json.loads(Path(args.route_json).read_text(encoding="utf-8"))
    target_ras = route_seed.get("target_ras")
    if not target_ras:
        raise ValueError("Route JSON does not include target_ras.")
    initial_terminal_id = _nearest_terminal_id(network, target_ras)

    terminal_ids = sorted(
        [
            node.id
            for node in network.nodes
            if node.kind == "terminal" and node.id != network.root_node_id and math.isfinite(network.root_distances[node.id])
        ]
    )
    bifurcation_ids = sorted([node.id for node in network.nodes if node.degree >= 3 or node.kind == "carina"])

    spacing = [float(v) * stride for v in ct.GetSpacing()]
    case = {
        "schema": "bronchoedu_web_case/v1",
        "caseId": args.case_id,
        "educationOnly": True,
        "notForClinicalUse": True,
        "ct": {
            "raw": raw_name,
            "sizeXyz": [int(preview_zyx.shape[2]), int(preview_zyx.shape[1]), int(preview_zyx.shape[0])],
            "originalSizeXyz": [int(v) for v in ct.GetSize()],
            "stride": stride,
            "spacingXyzMm": _round_list(spacing, 6),
            "originLps": _round_list(ct.GetOrigin(), 6),
            "directionLps": _round_list(ct.GetDirection(), 6),
            "windowHu": [float(args.window_min), float(args.window_max)],
        },
        "airway": {
            "rootNodeId": network.root_node_id,
            "carinaNodeId": network.carina_node_id,
            "terminalNodeIds": terminal_ids,
            "bifurcationNodeIds": bifurcation_ids,
            "nodes": _node_payload(network, airway_anatomy),
            "edges": _edge_payload(network, airway_anatomy, airway_candidates),
        },
        "initial": {
            "targetRas": _round_list(target_ras, 4),
            "snappedTerminalNodeId": initial_terminal_id,
            "snappedTerminalRas": _round_list(network.nodes[initial_terminal_id].ras, 4),
            "sourceRouteJson": str(args.route_json),
            "sourceCt": str(args.ct),
        },
    }
    if args.nodule_asset_dir:
        case["noduleAsset"] = _prepare_nodule_asset(args.nodule_asset_dir, out_dir)
    if args.scope_calibration_json:
        case["scopeCalibration"] = _load_scope_calibration(args.scope_calibration_json, args.case_id)
    if airway_anatomy:
        case["airway"]["anatomySource"] = airway_anatomy.get("source", {})
    if airway_candidates:
        case["airway"]["candidateSource"] = airway_candidates.get("source", {})
    case = _sanitize_json(case)
    (out_dir / "case.json").write_text(json.dumps(case, indent=2, allow_nan=False), encoding="utf-8")
    return {
        "case_json": str(out_dir / "case.json"),
        "ct_raw": str(out_dir / raw_name),
        "preview_size_xyz": case["ct"]["sizeXyz"],
        "node_count": len(case["airway"]["nodes"]),
        "edge_count": len(case["airway"]["edges"]),
        "terminal_count": len(terminal_ids),
        "initial_terminal_id": initial_terminal_id,
    }


def main() -> None:
    summary = prepare_web_case(build_parser().parse_args())
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
