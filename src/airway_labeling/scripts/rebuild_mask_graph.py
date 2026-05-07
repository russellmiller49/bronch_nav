from __future__ import annotations

import argparse
import json
import math
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import SimpleITK as sitk
from scipy import ndimage

from bronchoedu.airway_route import AirwayNetwork


SCHEMA = "airway_mask_skeleton_graph_rebuild/v0.1"
NEIGHBOR_OFFSETS_ZYX = [
    (dz, dy, dx)
    for dz in (-1, 0, 1)
    for dy in (-1, 0, 1)
    for dx in (-1, 0, 1)
    if not (dz == 0 and dy == 0 and dx == 0)
]


@dataclass(frozen=True)
class SkeletonNode:
    id: int
    component_label: int
    voxels_zyx: np.ndarray
    ras: np.ndarray
    degree: int
    kind: str


@dataclass(frozen=True)
class SkeletonEdge:
    id: int
    start_node: int
    end_node: int
    voxels_zyx: np.ndarray
    points_ras: np.ndarray
    length_mm: float


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Rebuild a coarse airway branch graph from a binary airway mask and compare it with a Slicer/VMTK network.")
    parser.add_argument("--mask", required=True, help="Binary airway mask to skeletonize.")
    parser.add_argument("--out-dir", required=True, help="Output directory for mask copy, skeleton, graph, VTK, and comparison JSON.")
    parser.add_argument("--network-vtk", default=None, help="Optional existing Slicer/VMTK Network model.vtk to compare against the mask.")
    parser.add_argument("--reference-airway-mask", default=None, help="Optional existing airway mask to compare voxel overlap, e.g. Airway.seg.nrrd.")
    parser.add_argument("--case-id", default="target_airway", help="Output file prefix.")
    parser.add_argument("--crop-margin-vox", type=int, default=4, help="Bounding-box margin used before thinning.")
    parser.add_argument("--keep-skeleton-components", type=int, default=1, help="Keep this many largest skeleton connected components after thinning. Use 0 to keep all.")
    parser.add_argument("--support-threshold", type=float, default=0.9, help="Point-in-mask fraction used to count current network branches as supported.")
    return parser


def rebuild_mask_graph(
    *,
    mask_path: str | Path,
    out_dir: str | Path,
    case_id: str = "target_airway",
    network_vtk: str | Path | None = None,
    reference_airway_mask: str | Path | None = None,
    crop_margin_vox: int = 4,
    keep_skeleton_components: int = 1,
    support_threshold: float = 0.9,
) -> dict[str, Any]:
    out_root = Path(out_dir)
    out_root.mkdir(parents=True, exist_ok=True)
    mask_img = sitk.ReadImage(str(mask_path))
    mask = sitk.GetArrayFromImage(mask_img) > 0
    if not np.any(mask):
        raise ValueError(f"Mask is empty: {mask_path}")

    crop_start_xyz, crop_size_xyz = _bbox_xyz(mask, int(crop_margin_vox))
    crop_img = sitk.RegionOfInterest(mask_img, size=[int(v) for v in crop_size_xyz], index=[int(v) for v in crop_start_xyz])
    crop_bin = sitk.Cast(crop_img > 0, sitk.sitkUInt8)
    skeleton_crop_img = sitk.BinaryThinning(crop_bin)
    skeleton_crop = sitk.GetArrayFromImage(skeleton_crop_img) > 0
    skeleton_component_info = _skeleton_component_info(skeleton_crop)
    if keep_skeleton_components > 0:
        skeleton_crop = _keep_largest_components(skeleton_crop, keep_skeleton_components)

    nodes, edges = _graph_from_skeleton(skeleton_crop, mask_img, crop_start_xyz)
    graph_summary = _graph_summary(nodes, edges)

    mask_out = out_root / f"{case_id}_mask.nrrd"
    skeleton_out = out_root / f"{case_id}_skeleton.nrrd"
    graph_out = out_root / f"{case_id}_skeleton_graph.json"
    vtk_out = out_root / f"{case_id}_skeleton_network.vtk"
    comparison_out = out_root / f"{case_id}_comparison.json"

    sitk.WriteImage(sitk.Cast(mask_img > 0, sitk.sitkUInt8), str(mask_out))
    skeleton_full = np.zeros(mask.shape, dtype=np.uint8)
    z0, y0, x0 = int(crop_start_xyz[2]), int(crop_start_xyz[1]), int(crop_start_xyz[0])
    sx, sy, sz = [int(v) for v in crop_size_xyz]
    skeleton_full[z0 : z0 + sz, y0 : y0 + sy, x0 : x0 + sx] = skeleton_crop.astype(np.uint8)
    skeleton_full_img = sitk.GetImageFromArray(skeleton_full)
    skeleton_full_img.CopyInformation(mask_img)
    sitk.WriteImage(skeleton_full_img, str(skeleton_out))

    graph_payload = _graph_payload(mask_path, mask_img, crop_start_xyz, crop_size_xyz, nodes, edges, graph_summary)
    graph_out.write_text(json.dumps(graph_payload, indent=2, allow_nan=False), encoding="utf-8")
    _write_skeleton_network_vtk(vtk_out, edges)

    comparison = {
        "schema": SCHEMA,
        "case_id": case_id,
        "mask": _mask_summary(mask_img, mask),
        "skeleton": {
            "voxel_count": int(skeleton_crop.sum()),
            "component_count_before_filter": skeleton_component_info["component_count"],
            "largest_component_voxel_counts_before_filter": skeleton_component_info["largest_component_voxel_counts"],
            "kept_largest_component_count": int(keep_skeleton_components) if keep_skeleton_components > 0 else "all",
            "crop_start_xyz": [int(v) for v in crop_start_xyz],
            "crop_size_xyz": [int(v) for v in crop_size_xyz],
        },
        "rebuilt_graph": graph_summary,
        "outputs": {
            "mask_nrrd": str(mask_out),
            "skeleton_nrrd": str(skeleton_out),
            "skeleton_graph_json": str(graph_out),
            "skeleton_network_vtk": str(vtk_out),
            "comparison_json": str(comparison_out),
        },
    }
    if reference_airway_mask is not None:
        reference_img = sitk.ReadImage(str(reference_airway_mask))
        comparison["reference_mask_overlap"] = _mask_overlap(mask_img, mask, reference_airway_mask, reference_img)
    if network_vtk is not None:
        comparison["current_network_comparison"] = _compare_current_network(
            mask_img=mask_img,
            mask_array=mask,
            network_vtk=network_vtk,
            support_threshold=float(support_threshold),
            subset_vtk_prefix=out_root / case_id,
        )
    comparison_out.write_text(json.dumps(comparison, indent=2, allow_nan=False), encoding="utf-8")
    return comparison


def _bbox_xyz(mask_zyx: np.ndarray, margin: int) -> tuple[np.ndarray, np.ndarray]:
    coords = np.argwhere(mask_zyx)
    zmin, ymin, xmin = coords.min(axis=0)
    zmax, ymax, xmax = coords.max(axis=0) + 1
    shape_z, shape_y, shape_x = mask_zyx.shape
    xmin = max(0, xmin - margin)
    ymin = max(0, ymin - margin)
    zmin = max(0, zmin - margin)
    xmax = min(shape_x, xmax + margin)
    ymax = min(shape_y, ymax + margin)
    zmax = min(shape_z, zmax + margin)
    start = np.asarray([xmin, ymin, zmin], dtype=int)
    size = np.asarray([xmax - xmin, ymax - ymin, zmax - zmin], dtype=int)
    return start, size


def _skeleton_component_info(skeleton_zyx: np.ndarray) -> dict[str, Any]:
    labels, component_count = ndimage.label(skeleton_zyx, structure=np.ones((3, 3, 3), dtype=np.uint8))
    counts = np.bincount(labels.ravel())[1:]
    largest = sorted((int(value) for value in counts), reverse=True)[:20]
    return {"component_count": int(component_count), "largest_component_voxel_counts": largest}


def _keep_largest_components(skeleton_zyx: np.ndarray, keep_count: int) -> np.ndarray:
    labels, component_count = ndimage.label(skeleton_zyx, structure=np.ones((3, 3, 3), dtype=np.uint8))
    if component_count <= keep_count:
        return skeleton_zyx
    counts = np.bincount(labels.ravel())
    keep_labels = np.argsort(counts[1:])[::-1][:keep_count] + 1
    return np.isin(labels, keep_labels)


def _graph_from_skeleton(skeleton_crop_zyx: np.ndarray, source_img: sitk.Image, crop_start_xyz: np.ndarray) -> tuple[list[SkeletonNode], list[SkeletonEdge]]:
    if not np.any(skeleton_crop_zyx):
        return [], []
    degree = _degree_map(skeleton_crop_zyx)
    critical = np.logical_and(skeleton_crop_zyx, degree != 2)
    if not np.any(critical):
        return [], []

    critical_labels, component_count = ndimage.label(critical, structure=np.ones((3, 3, 3), dtype=np.uint8))
    nodes_by_component: dict[int, SkeletonNode] = {}
    for component_label in range(1, component_count + 1):
        voxels = np.argwhere(critical_labels == component_label)
        ras = _indices_zyx_to_ras(_global_voxels(voxels, crop_start_xyz), source_img).mean(axis=0)
        nodes_by_component[component_label] = SkeletonNode(
            id=component_label - 1,
            component_label=component_label,
            voxels_zyx=voxels,
            ras=ras,
            degree=0,
            kind="unknown",
        )

    path_voxel_visited: set[tuple[int, int, int]] = set()
    edge_keys: set[tuple[int, int, tuple[int, int, int] | None]] = set()
    edges: list[SkeletonEdge] = []

    for component_label, node in nodes_by_component.items():
        for voxel in node.voxels_zyx:
            voxel_t = _coord_tuple(voxel)
            for neighbor_t in _neighbors(voxel_t, skeleton_crop_zyx.shape):
                if not skeleton_crop_zyx[neighbor_t]:
                    continue
                neighbor_component = int(critical_labels[neighbor_t])
                if neighbor_component == component_label:
                    continue
                if neighbor_component > 0:
                    start_node = nodes_by_component[component_label].id
                    end_node = nodes_by_component[neighbor_component].id
                    key = (min(start_node, end_node), max(start_node, end_node), None)
                    if key in edge_keys:
                        continue
                    edge_keys.add(key)
                    edge_voxels = np.asarray([voxel_t, neighbor_t], dtype=int)
                    edges.append(_make_edge(len(edges), start_node, end_node, edge_voxels, source_img, crop_start_xyz))
                    continue
                if neighbor_t in path_voxel_visited:
                    continue
                traced = _trace_path(neighbor_t, voxel_t, component_label, skeleton_crop_zyx, critical_labels)
                if traced is None:
                    continue
                end_component, path_voxels = traced
                start_node = nodes_by_component[component_label].id
                end_node = nodes_by_component[end_component].id
                first_path = _coord_tuple(path_voxels[0]) if len(path_voxels) else None
                key = (min(start_node, end_node), max(start_node, end_node), first_path)
                if key in edge_keys:
                    continue
                edge_keys.add(key)
                for item in path_voxels:
                    item_t = _coord_tuple(item)
                    if int(critical_labels[item_t]) == 0:
                        path_voxel_visited.add(item_t)
                full_voxels = np.vstack([np.asarray(voxel_t, dtype=int), path_voxels])
                edges.append(_make_edge(len(edges), start_node, end_node, full_voxels, source_img, crop_start_xyz))

    node_degrees = {node.id: 0 for node in nodes_by_component.values()}
    for edge in edges:
        node_degrees[edge.start_node] += 1
        node_degrees[edge.end_node] += 1
    nodes: list[SkeletonNode] = []
    for node in nodes_by_component.values():
        graph_degree = node_degrees[node.id]
        kind = "terminal" if graph_degree == 1 else "bifurcation" if graph_degree >= 3 else "connector"
        nodes.append(SkeletonNode(node.id, node.component_label, node.voxels_zyx, node.ras, graph_degree, kind))
    nodes.sort(key=lambda item: item.id)
    return nodes, edges


def _degree_map(skeleton_zyx: np.ndarray) -> np.ndarray:
    kernel = np.ones((3, 3, 3), dtype=np.uint8)
    kernel[1, 1, 1] = 0
    return ndimage.convolve(skeleton_zyx.astype(np.uint8), kernel, mode="constant", cval=0)


def _trace_path(
    start_voxel: tuple[int, int, int],
    previous_voxel: tuple[int, int, int],
    start_component: int,
    skeleton_zyx: np.ndarray,
    critical_labels: np.ndarray,
) -> tuple[int, np.ndarray] | None:
    path: list[tuple[int, int, int]] = []
    prev = previous_voxel
    current = start_voxel
    seen: set[tuple[int, int, int]] = set()
    while True:
        if current in seen:
            return None
        seen.add(current)
        component = int(critical_labels[current])
        if component > 0:
            if component == start_component:
                return None
            path.append(current)
            return component, np.asarray(path, dtype=int)
        path.append(current)
        candidates = [
            neighbor
            for neighbor in _neighbors(current, skeleton_zyx.shape)
            if neighbor != prev and skeleton_zyx[neighbor]
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda coord: int(critical_labels[coord]) == 0)
        prev, current = current, candidates[0]


def _make_edge(
    edge_id: int,
    start_node: int,
    end_node: int,
    voxels_zyx: np.ndarray,
    source_img: sitk.Image,
    crop_start_xyz: np.ndarray,
) -> SkeletonEdge:
    global_voxels = _global_voxels(voxels_zyx, crop_start_xyz)
    points_ras = _indices_zyx_to_ras(global_voxels, source_img)
    length = float(np.linalg.norm(np.diff(points_ras, axis=0), axis=1).sum()) if len(points_ras) > 1 else 0.0
    return SkeletonEdge(edge_id, int(start_node), int(end_node), global_voxels, points_ras, length)


def _global_voxels(voxels_zyx: np.ndarray, crop_start_xyz: np.ndarray) -> np.ndarray:
    start_zyx = np.asarray([crop_start_xyz[2], crop_start_xyz[1], crop_start_xyz[0]], dtype=int)
    return np.asarray(voxels_zyx, dtype=int) + start_zyx


def _indices_zyx_to_ras(indices_zyx: np.ndarray, img: sitk.Image) -> np.ndarray:
    indices_zyx = np.asarray(indices_zyx, dtype=float)
    indices_xyz = indices_zyx[:, ::-1]
    origin = np.asarray(img.GetOrigin(), dtype=float)
    spacing = np.asarray(img.GetSpacing(), dtype=float)
    direction = np.asarray(img.GetDirection(), dtype=float).reshape(3, 3)
    points_lps = origin + (direction @ (indices_xyz * spacing).T).T
    return np.column_stack((-points_lps[:, 0], -points_lps[:, 1], points_lps[:, 2]))


def _ras_to_lps(points_ras: np.ndarray) -> np.ndarray:
    points_ras = np.asarray(points_ras, dtype=float)
    return np.column_stack((-points_ras[:, 0], -points_ras[:, 1], points_ras[:, 2]))


def _coord_tuple(coord: np.ndarray | tuple[int, int, int]) -> tuple[int, int, int]:
    return tuple(int(v) for v in coord)


def _neighbors(coord: tuple[int, int, int], shape: tuple[int, int, int]) -> list[tuple[int, int, int]]:
    z, y, x = coord
    out: list[tuple[int, int, int]] = []
    max_z, max_y, max_x = shape
    for dz, dy, dx in NEIGHBOR_OFFSETS_ZYX:
        nz, ny, nx = z + dz, y + dy, x + dx
        if 0 <= nz < max_z and 0 <= ny < max_y and 0 <= nx < max_x:
            out.append((nz, ny, nx))
    return out


def _graph_summary(nodes: list[SkeletonNode], edges: list[SkeletonEdge]) -> dict[str, Any]:
    lengths = np.asarray([edge.length_mm for edge in edges], dtype=float)
    terminal_nodes = [node for node in nodes if node.degree == 1]
    bifurcation_nodes = [node for node in nodes if node.degree >= 3]
    root_id = max((node.id for node in terminal_nodes), key=lambda node_id: nodes[node_id].ras[2], default=None)
    generations = _bfs_generations(root_id, nodes, edges) if root_id is not None else {}
    return {
        "node_count": len(nodes),
        "edge_count": len(edges),
        "terminal_node_count": len(terminal_nodes),
        "bifurcation_node_count": len(bifurcation_nodes),
        "root_node_id": root_id,
        "root_ras": _round_list(nodes[root_id].ras) if root_id is not None else None,
        "max_unweighted_generation": max(generations.values()) if generations else None,
        "edge_length_mm": {
            "min": round(float(lengths.min()), 4) if lengths.size else None,
            "median": round(float(np.median(lengths)), 4) if lengths.size else None,
            "max": round(float(lengths.max()), 4) if lengths.size else None,
            "total": round(float(lengths.sum()), 4) if lengths.size else None,
        },
    }


def _bfs_generations(root_id: int | None, nodes: list[SkeletonNode], edges: list[SkeletonEdge]) -> dict[int, int]:
    if root_id is None:
        return {}
    adjacency: dict[int, list[int]] = {node.id: [] for node in nodes}
    for edge in edges:
        adjacency[edge.start_node].append(edge.end_node)
        adjacency[edge.end_node].append(edge.start_node)
    generations = {root_id: 0}
    queue: deque[int] = deque([root_id])
    while queue:
        node = queue.popleft()
        for neighbor in adjacency[node]:
            if neighbor in generations:
                continue
            generations[neighbor] = generations[node] + 1
            queue.append(neighbor)
    return generations


def _graph_payload(
    mask_path: str | Path,
    mask_img: sitk.Image,
    crop_start_xyz: np.ndarray,
    crop_size_xyz: np.ndarray,
    nodes: list[SkeletonNode],
    edges: list[SkeletonEdge],
    summary: dict[str, Any],
) -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "source_mask": str(mask_path),
        "coordinate_system": "RAS",
        "image_geometry": _image_geometry(mask_img),
        "crop_start_xyz": [int(v) for v in crop_start_xyz],
        "crop_size_xyz": [int(v) for v in crop_size_xyz],
        "summary": summary,
        "nodes": [
            {
                "id": node.id,
                "ras": _round_list(node.ras),
                "degree": node.degree,
                "kind": node.kind,
                "component_voxel_count": int(len(node.voxels_zyx)),
            }
            for node in nodes
        ],
        "edges": [
            {
                "id": edge.id,
                "start_node": edge.start_node,
                "end_node": edge.end_node,
                "length_mm": round(float(edge.length_mm), 4),
                "point_count": int(len(edge.points_ras)),
                "start_ras": _round_list(edge.points_ras[0]) if len(edge.points_ras) else None,
                "end_ras": _round_list(edge.points_ras[-1]) if len(edge.points_ras) else None,
            }
            for edge in edges
        ],
    }


def _mask_summary(mask_img: sitk.Image, mask: np.ndarray) -> dict[str, Any]:
    coords = np.argwhere(mask)
    bbox = None
    if coords.size:
        zmin, ymin, xmin = coords.min(axis=0)
        zmax, ymax, xmax = coords.max(axis=0)
        bbox = {"min_zyx": [int(zmin), int(ymin), int(xmin)], "max_zyx": [int(zmax), int(ymax), int(xmax)]}
    return {
        "geometry": _image_geometry(mask_img),
        "voxel_count": int(mask.sum()),
        "bbox": bbox,
    }


def _image_geometry(img: sitk.Image) -> dict[str, Any]:
    return {
        "size_xyz": [int(v) for v in img.GetSize()],
        "spacing_xyz": [round(float(v), 6) for v in img.GetSpacing()],
        "origin_lps": [round(float(v), 6) for v in img.GetOrigin()],
        "direction": [round(float(v), 6) for v in img.GetDirection()],
    }


def _mask_overlap(mask_img: sitk.Image, mask: np.ndarray, reference_path: str | Path, reference_img: sitk.Image) -> dict[str, Any]:
    if mask_img.GetSize() != reference_img.GetSize():
        return {"reference_mask": str(reference_path), "geometry_match": False, "reason": "size_mismatch"}
    reference = sitk.GetArrayFromImage(reference_img) > 0
    intersection = int(np.logical_and(mask, reference).sum())
    union = int(np.logical_or(mask, reference).sum())
    total = int(mask.sum() + reference.sum())
    return {
        "reference_mask": str(reference_path),
        "geometry_match": bool(
            mask_img.GetSize() == reference_img.GetSize()
            and np.allclose(mask_img.GetSpacing(), reference_img.GetSpacing())
            and np.allclose(mask_img.GetOrigin(), reference_img.GetOrigin())
            and np.allclose(mask_img.GetDirection(), reference_img.GetDirection())
        ),
        "mask_voxels": int(mask.sum()),
        "reference_voxels": int(reference.sum()),
        "intersection_voxels": intersection,
        "union_voxels": union,
        "dice": round(float(2 * intersection / total), 6) if total else None,
        "mask_minus_reference_voxels": int(np.logical_and(mask, ~reference).sum()),
        "reference_minus_mask_voxels": int(np.logical_and(reference, ~mask).sum()),
    }


def _compare_current_network(
    *,
    mask_img: sitk.Image,
    mask_array: np.ndarray,
    network_vtk: str | Path,
    support_threshold: float,
    subset_vtk_prefix: Path | None = None,
) -> dict[str, Any]:
    network = AirwayNetwork.from_network_vtk(network_vtk)
    branch_items: list[dict[str, Any]] = []
    supported_edge_ids: set[int] = set()
    nonoutside_edge_ids: set[int] = set()
    supported = partial = outside = 0
    supported_length = partial_length = outside_length = 0.0
    for edge in network.edges:
        inside = _points_inside_mask(mask_img, mask_array, edge.points_ras)
        fraction = float(np.mean(inside)) if inside.size else 0.0
        if fraction >= support_threshold:
            supported += 1
            supported_length += edge.length_mm
            category = "supported"
            supported_edge_ids.add(edge.id)
            nonoutside_edge_ids.add(edge.id)
        elif fraction <= 0.1:
            outside += 1
            outside_length += edge.length_mm
            category = "outside"
        else:
            partial += 1
            partial_length += edge.length_mm
            category = "partial"
            nonoutside_edge_ids.add(edge.id)
        branch_items.append(
            {
                "edge_id": edge.id,
                "cell_id": edge.cell_id,
                "length_mm": round(float(edge.length_mm), 4),
                "point_count": int(len(edge.points_ras)),
                "inside_fraction": round(fraction, 4),
                "inside_point_count": int(np.sum(inside)),
                "category": category,
                "start_ras": _round_list(np.asarray(edge.points_ras[0])),
                "end_ras": _round_list(np.asarray(edge.points_ras[-1])),
            }
        )
    summary = network.summary()
    subset_outputs: dict[str, str] = {}
    if subset_vtk_prefix is not None:
        supported_path = Path(f"{subset_vtk_prefix}_current_network_supported.vtk")
        nonoutside_path = Path(f"{subset_vtk_prefix}_current_network_supported_or_partial.vtk")
        _write_airway_network_subset_vtk(supported_path, network, supported_edge_ids)
        _write_airway_network_subset_vtk(nonoutside_path, network, nonoutside_edge_ids)
        subset_outputs = {
            "supported_network_vtk": str(supported_path),
            "supported_or_partial_network_vtk": str(nonoutside_path),
        }
    return {
        "network_vtk": str(network_vtk),
        "support_threshold": support_threshold,
        "current_network_summary": summary,
        "supported_branch_count": supported,
        "partial_branch_count": partial,
        "outside_branch_count": outside,
        "supported_length_mm": round(float(supported_length), 4),
        "partial_length_mm": round(float(partial_length), 4),
        "outside_length_mm": round(float(outside_length), 4),
        "subset_outputs": subset_outputs,
        "branches": branch_items,
    }


def _points_inside_mask(mask_img: sitk.Image, mask_array: np.ndarray, points_ras: np.ndarray) -> np.ndarray:
    points_lps = _ras_to_lps(np.asarray(points_ras, dtype=float))
    origin = np.asarray(mask_img.GetOrigin(), dtype=float)
    spacing = np.asarray(mask_img.GetSpacing(), dtype=float)
    direction = np.asarray(mask_img.GetDirection(), dtype=float).reshape(3, 3)
    indices_xyz = ((np.linalg.inv(direction) @ (points_lps - origin).T).T) / spacing
    nearest_xyz = np.rint(indices_xyz).astype(int)
    size_x, size_y, size_z = mask_img.GetSize()
    valid = (
        (nearest_xyz[:, 0] >= 0)
        & (nearest_xyz[:, 0] < size_x)
        & (nearest_xyz[:, 1] >= 0)
        & (nearest_xyz[:, 1] < size_y)
        & (nearest_xyz[:, 2] >= 0)
        & (nearest_xyz[:, 2] < size_z)
    )
    out = np.zeros(len(points_ras), dtype=bool)
    valid_idx = nearest_xyz[valid]
    out[valid] = mask_array[valid_idx[:, 2], valid_idx[:, 1], valid_idx[:, 0]]
    return out


def _write_skeleton_network_vtk(path: Path, edges: list[SkeletonEdge]) -> None:
    points_lps: list[np.ndarray] = []
    lines: list[list[int]] = []
    lengths: list[float] = []
    for edge in edges:
        line: list[int] = []
        for point_ras in edge.points_ras:
            point_lps = np.asarray([-point_ras[0], -point_ras[1], point_ras[2]], dtype=float)
            line.append(len(points_lps))
            points_lps.append(point_lps)
        if len(line) >= 2:
            lines.append(line)
            lengths.append(edge.length_mm)

    total_line_size = sum(len(line) + 1 for line in lines)
    with path.open("w", encoding="utf-8") as f:
        f.write("# vtk DataFile Version 3.0\n")
        f.write("SPACE=LPS\n")
        f.write("ASCII\n")
        f.write("DATASET POLYDATA\n")
        f.write(f"POINTS {len(points_lps)} float\n")
        for point in points_lps:
            f.write(f"{point[0]:.6f} {point[1]:.6f} {point[2]:.6f}\n")
        f.write(f"LINES {len(lines)} {total_line_size}\n")
        for line in lines:
            f.write(f"{len(line)} {' '.join(str(idx) for idx in line)}\n")
        f.write(f"CELL_DATA {len(lines)}\n")
        f.write("FIELD FieldData 1\n")
        f.write(f"Length 1 {len(lines)} float\n")
        for length in lengths:
            f.write(f"{length:.6f}\n")


def _write_airway_network_subset_vtk(path: Path, network: AirwayNetwork, keep_edge_ids: set[int]) -> None:
    points_lps: list[np.ndarray] = []
    lines: list[list[int]] = []
    lengths: list[float] = []
    radii: list[float] = []
    for edge in network.edges:
        if edge.id not in keep_edge_ids:
            continue
        line: list[int] = []
        for point_index, point_ras in enumerate(edge.points_ras):
            point_lps = np.asarray([-point_ras[0], -point_ras[1], point_ras[2]], dtype=float)
            line.append(len(points_lps))
            points_lps.append(point_lps)
            radius = float(edge.radius_mm[point_index]) if edge.radius_mm.size > point_index and np.isfinite(edge.radius_mm[point_index]) else edge.mean_radius_mm
            radii.append(radius if np.isfinite(radius) else 0.0)
        if len(line) >= 2:
            lines.append(line)
            lengths.append(edge.length_mm)

    total_line_size = sum(len(line) + 1 for line in lines)
    with path.open("w", encoding="utf-8") as f:
        f.write("# vtk DataFile Version 3.0\n")
        f.write("SPACE=LPS\n")
        f.write("ASCII\n")
        f.write("DATASET POLYDATA\n")
        f.write(f"POINTS {len(points_lps)} float\n")
        for point in points_lps:
            f.write(f"{point[0]:.6f} {point[1]:.6f} {point[2]:.6f}\n")
        f.write(f"LINES {len(lines)} {total_line_size}\n")
        for line in lines:
            f.write(f"{len(line)} {' '.join(str(idx) for idx in line)}\n")
        f.write(f"POINT_DATA {len(points_lps)}\n")
        f.write("FIELD FieldData 1\n")
        f.write(f"Radius 1 {len(points_lps)} float\n")
        for radius in radii:
            f.write(f"{radius:.6f}\n")
        f.write(f"CELL_DATA {len(lines)}\n")
        f.write("FIELD FieldData 1\n")
        f.write(f"Length 1 {len(lines)} float\n")
        for length in lengths:
            f.write(f"{length:.6f}\n")


def _round_list(values: np.ndarray, ndigits: int = 4) -> list[float]:
    return [round(float(value), ndigits) for value in np.asarray(values).tolist()]


def main() -> None:
    args = build_parser().parse_args()
    result = rebuild_mask_graph(
        mask_path=args.mask,
        out_dir=args.out_dir,
        case_id=args.case_id,
        network_vtk=args.network_vtk,
        reference_airway_mask=args.reference_airway_mask,
        crop_margin_vox=args.crop_margin_vox,
        keep_skeleton_components=args.keep_skeleton_components,
        support_threshold=args.support_threshold,
    )
    print(json.dumps({
        "comparison_json": result["outputs"]["comparison_json"],
        "skeleton_graph_json": result["outputs"]["skeleton_graph_json"],
        "skeleton_network_vtk": result["outputs"]["skeleton_network_vtk"],
        "rebuilt_graph": result["rebuilt_graph"],
        "current_network_comparison": {
            key: result.get("current_network_comparison", {}).get(key)
            for key in ("supported_branch_count", "partial_branch_count", "outside_branch_count")
        } if "current_network_comparison" in result else None,
    }, indent=2))


if __name__ == "__main__":
    main()
