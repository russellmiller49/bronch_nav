from __future__ import annotations

import argparse
import json
import math
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from bronchoedu.airway_route import AirwayNetwork


SCHEMA = "learnable_attention_airway_graph_from_slicer_vmtk/v0.1"


@dataclass(frozen=True)
class BranchRecord:
    row_index: int
    edge_id: int
    cell_id: int
    parent_row: int | None
    generation: int
    start_node: int
    end_node: int
    proximal_node: int
    distal_node: int
    points_ras: np.ndarray
    length_mm: float
    mean_radius_mm: float


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Convert a Slicer/VMTK airway Network model.vtk into the graph tensor format used by the learnable-attention airway-labeling repo."
    )
    parser.add_argument("--network-vtk", required=True, help="Path to the Slicer/VMTK Network model.vtk.")
    parser.add_argument("--out-dir", required=True, help="Output directory. Creates features/, topology/, and metadata/ subdirectories.")
    parser.add_argument(
        "--patient-id",
        default="patient01",
        help="Patient/case id prefix. Use no underscores because the upstream dataset loader splits on the first underscore.",
    )
    parser.add_argument(
        "--write-placeholder-y",
        action="store_true",
        help="Write all--1 placeholder labels and a parse placeholder so the upstream labeled dataset loader can smoke-load the case. Metrics are not meaningful.",
    )
    return parser


def export_learnable_attention_graph(
    network_vtk: str | Path,
    out_dir: str | Path,
    patient_id: str = "patient01",
    *,
    write_placeholder_y: bool = False,
) -> dict[str, Any]:
    patient_id = _validate_patient_id(patient_id)
    out_root = Path(out_dir)
    feature_dir = out_root / "features"
    topology_dir = out_root / "topology"
    metadata_dir = out_root / "metadata"
    for directory in (feature_dir, topology_dir, metadata_dir):
        directory.mkdir(parents=True, exist_ok=True)

    network = AirwayNetwork.from_network_vtk(network_vtk)
    records = _build_branch_records(network)
    x = _build_feature_matrix(records)
    edge, edge_feature = _build_edge_tensors(records)
    spd = _shortest_path_distance_matrix(len(records), edge[:, edge_feature > 0] if edge.size else edge)
    node_idx = np.asarray([record.edge_id for record in records], dtype=np.int64)

    files = {
        "x": feature_dir / f"{patient_id}_x.npy",
        "edge": feature_dir / f"{patient_id}_edge.npy",
        "edge_feature": feature_dir / f"{patient_id}_edge_feature.npy",
        "node_idx": feature_dir / f"{patient_id}_node_idx.npy",
        "spd": topology_dir / f"{patient_id}_spd.npy",
        "metadata": metadata_dir / f"{patient_id}_branch_metadata.json",
    }
    np.save(files["x"], x)
    np.save(files["edge"], edge)
    np.save(files["edge_feature"], edge_feature)
    np.save(files["node_idx"], node_idx)
    np.save(files["spd"], spd)

    if write_placeholder_y:
        y = np.full((3, len(records)), -1, dtype=np.int64)
        files["y"] = feature_dir / f"{patient_id}_y.npy"
        files["parse_placeholder"] = feature_dir / f"{patient_id}_parse_placeholder.npy"
        np.save(files["y"], y)
        np.save(files["parse_placeholder"], np.zeros(len(records), dtype=np.uint8))

    metadata = _metadata_payload(
        network=network,
        records=records,
        patient_id=patient_id,
        network_vtk=network_vtk,
        files=files,
        write_placeholder_y=write_placeholder_y,
    )
    Path(files["metadata"]).write_text(json.dumps(metadata, indent=2, allow_nan=False), encoding="utf-8")

    return {
        "schema": SCHEMA,
        "patient_id": patient_id,
        "branch_count": len(records),
        "feature_shape": list(x.shape),
        "edge_shape": list(edge.shape),
        "edge_feature_shape": list(edge_feature.shape),
        "spd_shape": list(spd.shape),
        "feature_dir": str(feature_dir),
        "topology_dir": str(topology_dir),
        "metadata_json": str(files["metadata"]),
        "placeholder_labels_written": write_placeholder_y,
    }


def _validate_patient_id(patient_id: str) -> str:
    patient_id = str(patient_id).strip()
    if not patient_id:
        raise ValueError("patient_id must not be empty.")
    if "_" in patient_id:
        raise ValueError("patient_id must not contain underscores; the upstream dataset loader splits filenames on '_'.")
    return patient_id


def _build_branch_records(network: AirwayNetwork) -> list[BranchRecord]:
    if network.root_node_id is None:
        raise ValueError("Network root could not be inferred.")
    distances = network.root_distances
    parent_by_node = network.parents
    edge_to_row = {edge.id: index for index, edge in enumerate(network.edges)}

    parent_rows: list[int | None] = []
    endpoints: list[tuple[int, int]] = []
    for edge in network.edges:
        start_dist = distances[edge.start_node]
        end_dist = distances[edge.end_node]
        if start_dist <= end_dist:
            proximal_node, distal_node = edge.start_node, edge.end_node
        else:
            proximal_node, distal_node = edge.end_node, edge.start_node
        endpoints.append((proximal_node, distal_node))

        parent_edge_id: int | None = None
        if proximal_node != network.root_node_id:
            parent = parent_by_node[proximal_node]
            if parent is not None and parent[1] != edge.id:
                parent_edge_id = parent[1]
        parent_rows.append(edge_to_row[parent_edge_id] if parent_edge_id is not None else None)

    generations = _branch_generations(parent_rows)
    records: list[BranchRecord] = []
    for row_index, edge in enumerate(network.edges):
        proximal_node, distal_node = endpoints[row_index]
        points = network.oriented_edge_points(edge.id, proximal_node, distal_node)
        mean_radius = edge.mean_radius_mm
        records.append(
            BranchRecord(
                row_index=row_index,
                edge_id=edge.id,
                cell_id=edge.cell_id,
                parent_row=parent_rows[row_index],
                generation=generations[row_index],
                start_node=edge.start_node,
                end_node=edge.end_node,
                proximal_node=proximal_node,
                distal_node=distal_node,
                points_ras=np.asarray(points, dtype=float),
                length_mm=float(edge.length_mm),
                mean_radius_mm=float(mean_radius) if math.isfinite(mean_radius) else float("nan"),
            )
        )
    return records


def _branch_generations(parent_rows: list[int | None]) -> list[int]:
    memo: dict[int, int] = {}
    visiting: set[int] = set()

    def generation(row: int) -> int:
        if row in memo:
            return memo[row]
        if row in visiting:
            memo[row] = 1
            return 1
        visiting.add(row)
        parent = parent_rows[row]
        value = 1 if parent is None else generation(parent) + 1
        visiting.remove(row)
        memo[row] = value
        return value

    return [generation(row) for row in range(len(parent_rows))]


def _build_feature_matrix(records: list[BranchRecord]) -> np.ndarray:
    n = len(records)
    raw = np.zeros((n, 17), dtype=float)
    if n == 0:
        return np.zeros((0, 20), dtype=np.float32)

    centers = np.asarray([_branch_center(record.points_ras) for record in records], dtype=float)
    root_rows = [record.row_index for record in records if record.parent_row is None]
    root_center = centers[root_rows[0]] if root_rows else centers[0]
    children = _children_by_parent(records)

    raw[:, 0] = [record.generation for record in records]
    raw[:, 1:4] = centers - root_center
    raw[:, 4] = [record.length_mm for record in records]
    raw[:, 5:8] = [_branch_extents(record.points_ras) for record in records]
    raw[:, 8:11] = [_axis_angles_degrees(_branch_vector(record)) for record in records]
    raw[:, 11] = [len(children.get(record.row_index, [])) for record in records]
    raw[:, 12] = [0 if record.parent_row is None else max(0, len(children.get(record.parent_row, [])) - 1) for record in records]
    raw[:, 13] = [_volume_proxy(record) for record in records]
    raw[:, 14:17] = _relative_side_positions(centers, root_center)

    data = np.concatenate((raw, _rank(raw[:, 14:17])), axis=1)
    for column in range(data.shape[1]):
        if column == 0 or 1 <= column <= 3 or 5 <= column <= 7 or column in {11, 12, 14, 15, 16}:
            continue
        if column in {8, 9, 10}:
            data[:, column] = data[:, column] / 180.0
        else:
            data[:, column] = _normalize_feature(data[:, column])
    data[:, 1:4] = _normalize_space(data[:, 1:4])
    data[:, 5:8] = _normalize_space(data[:, 5:8])
    return data.astype(np.float32)


def _children_by_parent(records: list[BranchRecord]) -> dict[int, list[int]]:
    children: dict[int, list[int]] = {}
    for record in records:
        if record.parent_row is not None:
            children.setdefault(record.parent_row, []).append(record.row_index)
    return children


def _build_edge_tensors(records: list[BranchRecord]) -> tuple[np.ndarray, np.ndarray]:
    directed_edges: list[tuple[int, int]] = []
    edge_features: list[int] = []
    for record in records:
        if record.parent_row is None:
            continue
        directed_edges.append((record.parent_row, record.row_index))
        edge_features.append(1)
        directed_edges.append((record.row_index, record.parent_row))
        edge_features.append(-1)
    if not directed_edges:
        return np.empty((2, 0), dtype=np.int64), np.empty((0,), dtype=np.int64)
    return np.asarray(directed_edges, dtype=np.int64).T, np.asarray(edge_features, dtype=np.int64)


def _shortest_path_distance_matrix(node_count: int, forward_edge: np.ndarray) -> np.ndarray:
    adjacency: list[list[int]] = [[] for _ in range(node_count)]
    if forward_edge.size:
        for parent, child in forward_edge.T:
            adjacency[int(parent)].append(int(child))
            adjacency[int(child)].append(int(parent))

    spd = np.full((node_count, node_count), 999, dtype=np.int64)
    for source in range(node_count):
        spd[source, source] = 0
        queue: deque[int] = deque([source])
        while queue:
            node = queue.popleft()
            for neighbor in adjacency[node]:
                if spd[source, neighbor] <= spd[source, node] + 1:
                    continue
                spd[source, neighbor] = spd[source, node] + 1
                queue.append(neighbor)
    return spd


def _branch_center(points: np.ndarray) -> np.ndarray:
    if points.size == 0:
        return np.zeros(3, dtype=float)
    return (np.min(points, axis=0) + np.max(points, axis=0)) / 2.0


def _branch_extents(points: np.ndarray) -> np.ndarray:
    if points.size == 0:
        return np.zeros(3, dtype=float)
    return np.max(points, axis=0) - np.min(points, axis=0)


def _branch_vector(record: BranchRecord) -> np.ndarray:
    if len(record.points_ras) >= 2:
        return np.asarray(record.points_ras[-1] - record.points_ras[0], dtype=float)
    return np.zeros(3, dtype=float)


def _axis_angles_degrees(vector: np.ndarray) -> np.ndarray:
    unit = _unit(vector)
    return np.degrees(np.arccos(np.clip(unit, -1.0, 1.0)))


def _unit(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    if norm < 1e-12:
        return np.zeros(3, dtype=float)
    return np.asarray(vector, dtype=float) / norm


def _volume_proxy(record: BranchRecord) -> float:
    if math.isfinite(record.mean_radius_mm) and record.mean_radius_mm > 0:
        return float(record.length_mm * math.pi * record.mean_radius_mm * record.mean_radius_mm)
    return float(record.length_mm)


def _relative_side_positions(centers: np.ndarray, root_center: np.ndarray) -> np.ndarray:
    out = np.zeros_like(centers, dtype=float)
    right_mask = centers[:, 0] >= root_center[0]
    left_mask = ~right_mask
    for mask, sign in ((right_mask, 1.0), (left_mask, -1.0)):
        if not np.any(mask):
            continue
        side_centers = centers[mask]
        mins = np.min(side_centers, axis=0)
        maxs = np.max(side_centers, axis=0)
        denom = np.where(np.abs(maxs - mins) < 1e-12, 1.0, maxs - mins)
        out[mask] = sign * (side_centers - mins) / denom
    return out


def _rank(pos: np.ndarray) -> np.ndarray:
    ranked = np.zeros_like(pos, dtype=float)
    for column in range(pos.shape[1]):
        values = pos[:, column]
        negative_mask = values < 0
        positive_mask = values > 0
        for mask, sign in ((negative_mask, -1.0), (positive_mask, 1.0)):
            count = int(np.sum(mask))
            if count == 0:
                continue
            magnitudes = np.abs(values[mask])
            order = np.argsort(magnitudes)
            pool = np.linspace(0.005, 1.0, count)
            assigned = np.zeros(count, dtype=float)
            assigned[order] = pool
            ranked[:, column][mask] = sign * assigned
    return ranked


def _normalize_feature(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=float).copy()
    if values.size == 0:
        return values
    max_value = float(np.max(values))
    min_value = float(np.min(values))
    if min_value >= 0:
        return values / max_value if abs(max_value) > 1e-12 else np.zeros_like(values)
    if max_value < 0:
        return -values / min_value if abs(min_value) > 1e-12 else np.zeros_like(values)
    out = np.zeros_like(values)
    positive = values > 0
    negative = values < 0
    out[positive] = values[positive] / max_value if abs(max_value) > 1e-12 else 0
    out[negative] = values[negative] / (-min_value) if abs(min_value) > 1e-12 else 0
    return out


def _normalize_space(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=float).copy()
    max_abs = float(np.max(np.abs(values))) if values.size else 0.0
    if max_abs < 1e-12:
        return np.zeros_like(values)
    return values / max_abs


def _metadata_payload(
    *,
    network: AirwayNetwork,
    records: list[BranchRecord],
    patient_id: str,
    network_vtk: str | Path,
    files: dict[str, Path],
    write_placeholder_y: bool,
) -> dict[str, Any]:
    root_rows = [record.row_index for record in records if record.parent_row is None]
    root_row = root_rows[0] if root_rows else 0
    root_center = _branch_center(records[root_row].points_ras) if records else np.zeros(3)
    return {
        "schema": SCHEMA,
        "patient_id": patient_id,
        "source_network_vtk": str(network_vtk),
        "coordinate_system": "RAS",
        "branch_count": len(records),
        "root_node_id": network.root_node_id,
        "carina_node_id": network.carina_node_id,
        "placeholder_labels_written": write_placeholder_y,
        "files": {key: str(path) for key, path in files.items()},
        "feature_contract": {
            "x_shape": "[branch_count, 20]",
            "model_input_columns": "Upstream dataset uses x[:, 0:11] plus x[:, 13:17], producing 15 input features.",
            "edge_shape": "[2, directed_edge_count]",
            "edge_feature_values": "1 means parent->child; -1 means child->parent.",
            "spd_shape": "[branch_count, branch_count] unweighted branch graph shortest-path distance.",
            "coordinate_caveat": "Features are derived from Slicer/VMTK RAS centerline geometry, not the repo's original voxel-index skeleton/lobe-mask pipeline.",
        },
        "branches": [_record_payload(record, root_center) for record in records],
    }


def _record_payload(record: BranchRecord, root_center: np.ndarray) -> dict[str, Any]:
    center = _branch_center(record.points_ras)
    vector = _branch_vector(record)
    return {
        "row_index": record.row_index,
        "edge_id": record.edge_id,
        "cell_id": record.cell_id,
        "parent_row": record.parent_row,
        "generation": record.generation,
        "start_node": record.start_node,
        "end_node": record.end_node,
        "proximal_node": record.proximal_node,
        "distal_node": record.distal_node,
        "center_ras": _round_list(center),
        "center_offset_from_root_ras": _round_list(center - root_center),
        "direction_ras": _round_list(vector),
        "length_mm": round(float(record.length_mm), 4),
        "mean_radius_mm": round(float(record.mean_radius_mm), 4) if math.isfinite(record.mean_radius_mm) else None,
    }


def _round_list(values: np.ndarray, ndigits: int = 4) -> list[float]:
    return [round(float(value), ndigits) for value in values.tolist()]


def main() -> None:
    args = build_parser().parse_args()
    summary = export_learnable_attention_graph(
        network_vtk=args.network_vtk,
        out_dir=args.out_dir,
        patient_id=args.patient_id,
        write_placeholder_y=args.write_placeholder_y,
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
