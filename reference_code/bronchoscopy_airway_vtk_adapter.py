#!/usr/bin/env python3
"""
Bronchoscopy Airway VTK Adapter
================================

Purpose
-------
Turn 3D Slicer/VMTK legacy VTK airway centerline/network exports into a data
object suitable for an educational peripheral/robotic bronchoscopy module.

This adapter is intentionally dependency-light: it does not require the VTK
Python package. It parses the legacy binary PolyData files produced by 3D Slicer
for this project.

What it provides
----------------
1. Reads the uploaded Network model.vtk and Centerline model.vtk files.
2. Converts model coordinates from LPS to Slicer RAS.
3. Builds an undirected airway graph from full sampled network branch polylines.
4. Infers the proximal tracheal/root node.
5. Routes from the root to a lesion point in RAS coordinates.
6. Exports route geometry, bifurcation decisions, and parallel-transport frames
   for synchronized CT reslicing and virtual bronchoscopic camera motion.

Coordinate conventions
----------------------
The uploaded VTK headers state: SPACE=LPS. The TSV columns are labeled R/A/S
and match the VTK data after conversion:

    RAS = [-LPS_x, -LPS_y, LPS_z]

Vector arrays are converted the same way:

    vector_RAS = [-vector_LPS_x, -vector_LPS_y, vector_LPS_z]

Example usage
-------------
Export full airway network geometry and summary:

    python bronchoscopy_airway_vtk_adapter.py \
      --network-vtk "Network model.vtk" \
      --centerline-vtk "Centerline model.vtk" \
      --out-json airway_network_case.json \
      --summary-json airway_network_summary.json

Route to a lesion point in RAS coordinates:

    python bronchoscopy_airway_vtk_adapter.py \
      --network-vtk "Network model.vtk" \
      --target-ras 42.0 130.0 -250.0 \
      --route-json route_to_lesion.json
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

Point3 = Tuple[float, float, float]


# -----------------------------------------------------------------------------
# Numeric helpers
# -----------------------------------------------------------------------------


def _round_list(values: Sequence[float], ndigits: int = 4) -> List[float]:
    return [round(float(v), ndigits) for v in values]


def _norm(v: np.ndarray) -> float:
    return float(np.linalg.norm(v))


def _unit(v: np.ndarray, fallback: Optional[np.ndarray] = None) -> np.ndarray:
    n = _norm(v)
    if n < 1e-12:
        if fallback is None:
            return np.zeros(3, dtype=float)
        return np.array(fallback, dtype=float)
    return np.asarray(v, dtype=float) / n


def _distance(a: Sequence[float], b: Sequence[float]) -> float:
    return float(np.linalg.norm(np.asarray(a, dtype=float) - np.asarray(b, dtype=float)))


def _rodrigues_rotate(v: np.ndarray, axis: np.ndarray, angle_rad: float) -> np.ndarray:
    axis = _unit(axis, np.array([0.0, 0.0, 1.0]))
    return (
        v * math.cos(angle_rad)
        + np.cross(axis, v) * math.sin(angle_rad)
        + axis * np.dot(axis, v) * (1.0 - math.cos(angle_rad))
    )


def lps_to_ras_points(points_lps: np.ndarray) -> np.ndarray:
    points_lps = np.asarray(points_lps, dtype=float)
    return np.column_stack((-points_lps[:, 0], -points_lps[:, 1], points_lps[:, 2]))


def lps_to_ras_vectors(vectors_lps: np.ndarray) -> np.ndarray:
    vectors_lps = np.asarray(vectors_lps, dtype=float)
    return np.column_stack((-vectors_lps[:, 0], -vectors_lps[:, 1], vectors_lps[:, 2]))


# -----------------------------------------------------------------------------
# Minimal legacy VTK PolyData parser
# -----------------------------------------------------------------------------


@dataclass
class LegacyVTKPolyData:
    path: str
    space: str
    points: np.ndarray
    lines: List[List[int]]
    point_data: Dict[str, np.ndarray] = field(default_factory=dict)
    cell_data: Dict[str, np.ndarray] = field(default_factory=dict)
    field_data: Dict[str, Any] = field(default_factory=dict)


class LegacyVTKParseError(RuntimeError):
    pass


class LegacyVTKReader:
    """Parser for the subset of legacy binary VTK PolyData used by Slicer/VMTK."""

    _DTYPE_MAP: Dict[str, Tuple[str, int]] = {
        "float": (">f4", 4),
        "double": (">f8", 8),
        "int": (">i4", 4),
        "unsigned_int": (">u4", 4),
        "short": (">i2", 2),
        "unsigned_short": (">u2", 2),
        "char": (">i1", 1),
        "unsigned_char": (">u1", 1),
        # Slicer/VTK legacy files often write vtkIdType as 4-byte big-endian ints.
        "vtkIdType": (">i4", 4),
        "idtype": (">i4", 4),
        "long": (">i4", 4),
        "unsigned_long": (">u4", 4),
    }

    def __init__(self, path: str | Path):
        self.path = str(path)
        self.data = Path(path).read_bytes()
        self.pos = 0
        self.space = self._infer_space()

    def _infer_space(self) -> str:
        first_256 = self.data[:256].decode("latin1", errors="ignore")
        if "SPACE=LPS" in first_256:
            return "LPS"
        if "SPACE=RAS" in first_256:
            return "RAS"
        return "UNKNOWN"

    def _read_line(self, pos: Optional[int] = None) -> Tuple[bytes, int]:
        if pos is None:
            pos = self.pos
        j = self.data.find(b"\n", pos)
        if j < 0:
            return self.data[pos:], len(self.data)
        return self.data[pos:j], j + 1

    def _skip_newline(self) -> None:
        if self.pos < len(self.data) and self.data[self.pos : self.pos + 1] == b"\n":
            self.pos += 1

    def _find(self, token: bytes) -> int:
        p = self.data.find(token, self.pos)
        if p < 0:
            p = self.data.find(token)
        if p < 0:
            raise LegacyVTKParseError(f"Could not find token {token!r} in {self.path}")
        return p

    def read(self) -> LegacyVTKPolyData:
        # Skip any Slicer string FieldData before POINTS by jumping to POINTS.
        self.pos = self._find(b"POINTS ")
        points = self._read_points()
        lines: List[List[int]] = []
        point_data: Dict[str, np.ndarray] = {}
        cell_data: Dict[str, np.ndarray] = {}
        current_store: Optional[Dict[str, np.ndarray]] = None

        while self.pos < len(self.data):
            line_b, self.pos = self._read_line()
            line = line_b.decode("latin1", errors="replace").strip()
            if not line:
                continue
            parts = line.split()
            key = parts[0]

            if key == "LINES":
                lines = self._read_lines(parts)
            elif key == "POLYGONS":
                self._skip_cell_list(parts)
            elif key == "VERTICES":
                self._skip_cell_list(parts)
            elif key == "POINT_DATA":
                current_store = point_data
            elif key == "CELL_DATA":
                current_store = cell_data
            elif key == "FIELD":
                if current_store is None:
                    # Numeric FIELD data outside POINT_DATA/CELL_DATA is not needed here.
                    self._skip_field_arrays(parts)
                else:
                    self._read_field_arrays(parts, current_store)
            else:
                # Unknown sections are ignored rather than failing; this keeps the parser
                # usable across small Slicer export variations.
                break

        return LegacyVTKPolyData(
            path=self.path,
            space=self.space,
            points=points,
            lines=lines,
            point_data=point_data,
            cell_data=cell_data,
        )

    def _read_points(self) -> np.ndarray:
        line_b, self.pos = self._read_line(self.pos)
        parts = line_b.decode("latin1", errors="replace").strip().split()
        if len(parts) < 3 or parts[0] != "POINTS":
            raise LegacyVTKParseError(f"Expected POINTS line, got: {line_b!r}")
        n_points = int(parts[1])
        vtk_dtype = parts[2]
        np_dtype, size = self._DTYPE_MAP[vtk_dtype]
        n_values = n_points * 3
        arr = np.frombuffer(self.data, dtype=np.dtype(np_dtype), count=n_values, offset=self.pos)
        points = arr.astype(float).reshape(n_points, 3)
        self.pos += n_values * size
        self._skip_newline()
        return points

    def _read_lines(self, parts: List[str]) -> List[List[int]]:
        n_lines = int(parts[1])
        total_size = int(parts[2])
        arr = np.frombuffer(self.data, dtype=">i4", count=total_size, offset=self.pos).astype(int)
        self.pos += total_size * 4
        self._skip_newline()

        lines: List[List[int]] = []
        k = 0
        for _ in range(n_lines):
            n = int(arr[k])
            k += 1
            lines.append(arr[k : k + n].astype(int).tolist())
            k += n
        return lines

    def _skip_cell_list(self, parts: List[str]) -> None:
        total_size = int(parts[2])
        self.pos += total_size * 4
        self._skip_newline()

    def _read_field_arrays(self, parts: List[str], store: Dict[str, np.ndarray]) -> None:
        n_arrays = int(parts[-1])
        for _ in range(n_arrays):
            header_b, self.pos = self._read_line(self.pos)
            header = header_b.decode("latin1", errors="replace").strip().split()
            if len(header) < 4:
                raise LegacyVTKParseError(f"Bad FIELD array header: {header_b!r}")
            name, n_comp_s, n_tuple_s, vtk_dtype = header[:4]
            n_comp = int(n_comp_s)
            n_tuples = int(n_tuple_s)
            np_dtype, size = self._DTYPE_MAP[vtk_dtype]
            n_values = n_comp * n_tuples
            arr = np.frombuffer(self.data, dtype=np.dtype(np_dtype), count=n_values, offset=self.pos).copy()
            self.pos += n_values * size
            self._skip_newline()
            if n_comp == 1:
                store[name] = arr.reshape(n_tuples)
            else:
                store[name] = arr.reshape(n_tuples, n_comp)

    def _skip_field_arrays(self, parts: List[str]) -> None:
        """Best-effort skip for FIELD data. Only used before POINTS in some Slicer files."""
        n_arrays = int(parts[-1])
        for _ in range(n_arrays):
            header_b, self.pos = self._read_line(self.pos)
            header = header_b.decode("latin1", errors="replace").strip().split()
            if len(header) < 4:
                return
            _, n_comp_s, n_tuple_s, vtk_dtype = header[:4]
            if vtk_dtype == "string":
                # Slicer string field data can contain arbitrary bytes. Since we jump to
                # POINTS before parsing, this path is usually not reached. If it is reached,
                # stop and let outer parser find the next supported section.
                return
            n_comp = int(n_comp_s)
            n_tuples = int(n_tuple_s)
            _, size = self._DTYPE_MAP[vtk_dtype]
            self.pos += n_comp * n_tuples * size
            self._skip_newline()


# -----------------------------------------------------------------------------
# Airway graph and route planning
# -----------------------------------------------------------------------------


@dataclass
class AirwayNode:
    id: int
    ras: Point3
    degree: int = 0
    kind: str = "unknown"  # root, carina, bifurcation, terminal, internal


@dataclass
class AirwayEdge:
    id: int
    cell_id: int
    start_node: int
    end_node: int
    length_mm: float
    tortuosity: float
    points_ras: np.ndarray
    radius_mm: np.ndarray
    curvature: Optional[np.ndarray] = None
    torsion: Optional[np.ndarray] = None
    frenet_tangent_ras: Optional[np.ndarray] = None
    frenet_normal_ras: Optional[np.ndarray] = None
    frenet_binormal_ras: Optional[np.ndarray] = None

    @property
    def mean_radius_mm(self) -> float:
        if self.radius_mm.size == 0:
            return float("nan")
        valid = self.radius_mm[np.isfinite(self.radius_mm)]
        if valid.size == 0:
            return float("nan")
        return float(np.mean(valid))

    @property
    def min_radius_mm(self) -> float:
        if self.radius_mm.size == 0:
            return float("nan")
        valid = self.radius_mm[np.isfinite(self.radius_mm)]
        if valid.size == 0:
            return float("nan")
        return float(np.min(valid))


@dataclass
class ProjectionResult:
    edge_id: int
    cell_id: int
    segment_index: int
    segment_fraction: float
    projection_ras: Point3
    distance_mm: float
    distance_from_edge_start_mm: float
    edge_length_mm: float


class AirwayNetwork:
    def __init__(self, merge_decimals: int = 3):
        self.merge_decimals = merge_decimals
        self.nodes: List[AirwayNode] = []
        self.edges: List[AirwayEdge] = []
        self._node_key_to_id: Dict[Tuple[float, float, float], int] = {}
        self.adj: Dict[int, List[Tuple[int, int]]] = defaultdict(list)
        self.root_node_id: Optional[int] = None
        self.carina_node_id: Optional[int] = None
        self._dist_cache: Optional[List[float]] = None
        self._parent_cache: Optional[List[Optional[Tuple[int, int]]]] = None

    def _key(self, point_ras: Sequence[float]) -> Tuple[float, float, float]:
        return tuple(round(float(x), self.merge_decimals) for x in point_ras)  # type: ignore[return-value]

    def _node_id(self, point_ras: Sequence[float]) -> int:
        key = self._key(point_ras)
        if key in self._node_key_to_id:
            return self._node_key_to_id[key]
        node_id = len(self.nodes)
        self._node_key_to_id[key] = node_id
        self.nodes.append(AirwayNode(id=node_id, ras=tuple(float(x) for x in point_ras)))
        return node_id

    @classmethod
    def from_network_vtk(cls, network_vtk: str | Path, merge_decimals: int = 3) -> "AirwayNetwork":
        poly = LegacyVTKReader(network_vtk).read()
        network = cls(merge_decimals=merge_decimals)

        if poly.space == "LPS":
            points_ras = lps_to_ras_points(poly.points)
            vector_converter = lps_to_ras_vectors
        else:
            points_ras = poly.points.astype(float)
            vector_converter = lambda x: np.asarray(x, dtype=float)

        radius = poly.point_data.get("Radius")
        curvature = poly.point_data.get("Curvature")
        torsion = poly.point_data.get("Torsion")
        frenet_tangent = poly.point_data.get("FrenetTangent")
        frenet_normal = poly.point_data.get("FrenetNormal")
        frenet_binormal = poly.point_data.get("FrenetBinormal")

        lengths = poly.cell_data.get("Length")
        tortuosities = poly.cell_data.get("Tortuosity")

        for edge_id, line in enumerate(poly.lines):
            line_idx = np.asarray(line, dtype=int)
            edge_points = points_ras[line_idx]
            start_node = network._node_id(edge_points[0])
            end_node = network._node_id(edge_points[-1])
            edge_length = float(lengths[edge_id]) if lengths is not None else _polyline_length(edge_points)
            edge_tortuosity = float(tortuosities[edge_id]) if tortuosities is not None else float("nan")

            edge = AirwayEdge(
                id=edge_id,
                cell_id=edge_id,
                start_node=start_node,
                end_node=end_node,
                length_mm=edge_length,
                tortuosity=edge_tortuosity,
                points_ras=edge_points,
                radius_mm=np.asarray(radius[line_idx], dtype=float) if radius is not None else np.array([], dtype=float),
                curvature=np.asarray(curvature[line_idx], dtype=float) if curvature is not None else None,
                torsion=np.asarray(torsion[line_idx], dtype=float) if torsion is not None else None,
                frenet_tangent_ras=vector_converter(frenet_tangent[line_idx]) if frenet_tangent is not None else None,
                frenet_normal_ras=vector_converter(frenet_normal[line_idx]) if frenet_normal is not None else None,
                frenet_binormal_ras=vector_converter(frenet_binormal[line_idx]) if frenet_binormal is not None else None,
            )
            network.edges.append(edge)
            network.adj[start_node].append((end_node, edge.id))
            network.adj[end_node].append((start_node, edge.id))

        network._classify_nodes()
        network.root_node_id = network._infer_root_by_superior_terminal()
        if network.root_node_id is not None:
            network.nodes[network.root_node_id].kind = "root"
            if len(network.adj[network.root_node_id]) == 1:
                network.carina_node_id = network.adj[network.root_node_id][0][0]
                network.nodes[network.carina_node_id].kind = "carina"
        network.shortest_paths_from_root()
        return network

    def _classify_nodes(self) -> None:
        for node in self.nodes:
            node.degree = len(self.adj[node.id])
            if node.degree == 1:
                node.kind = "terminal"
            elif node.degree >= 3:
                node.kind = "bifurcation"
            else:
                node.kind = "internal"

    def _infer_root_by_superior_terminal(self) -> int:
        # RAS: larger S is more superior. The proximal tracheal leaf is the most superior terminal point.
        terminal_ids = [node.id for node in self.nodes if node.degree == 1]
        if not terminal_ids:
            return 0
        return max(terminal_ids, key=lambda nid: self.nodes[nid].ras[2])

    def shortest_paths_from_root(self) -> Tuple[List[float], List[Optional[Tuple[int, int]]]]:
        if self.root_node_id is None:
            raise ValueError("Root node has not been set")
        n = len(self.nodes)
        dist = [float("inf")] * n
        parent: List[Optional[Tuple[int, int]]] = [None] * n
        root = self.root_node_id
        dist[root] = 0.0
        pq: List[Tuple[float, int]] = [(0.0, root)]
        while pq:
            du, u = heapq.heappop(pq)
            if du != dist[u]:
                continue
            for v, edge_id in self.adj[u]:
                nd = du + self.edges[edge_id].length_mm
                if nd < dist[v]:
                    dist[v] = nd
                    parent[v] = (u, edge_id)
                    heapq.heappush(pq, (nd, v))
        self._dist_cache = dist
        self._parent_cache = parent
        return dist, parent

    @property
    def root_distances(self) -> List[float]:
        if self._dist_cache is None:
            self.shortest_paths_from_root()
        assert self._dist_cache is not None
        return self._dist_cache

    @property
    def parents(self) -> List[Optional[Tuple[int, int]]]:
        if self._parent_cache is None:
            self.shortest_paths_from_root()
        assert self._parent_cache is not None
        return self._parent_cache

    def node_path_to(self, target_node: int) -> Tuple[List[int], List[int]]:
        if self.root_node_id is None:
            raise ValueError("Root node has not been set")
        nodes: List[int] = [target_node]
        edges: List[int] = []
        current = target_node
        parent = self.parents
        while current != self.root_node_id:
            p = parent[current]
            if p is None:
                raise ValueError(f"Node {target_node} is not connected to root")
            prev_node, edge_id = p
            nodes.append(prev_node)
            edges.append(edge_id)
            current = prev_node
        nodes.reverse()
        edges.reverse()
        return nodes, edges

    def oriented_edge_points(self, edge_id: int, from_node: int, to_node: int) -> np.ndarray:
        edge = self.edges[edge_id]
        if from_node == edge.start_node and to_node == edge.end_node:
            return edge.points_ras
        if from_node == edge.end_node and to_node == edge.start_node:
            return edge.points_ras[::-1]
        raise ValueError(f"Edge {edge_id} does not connect node {from_node} to node {to_node}")

    def nearest_edge_projection(self, point_ras: Sequence[float]) -> ProjectionResult:
        target = np.asarray(point_ras, dtype=float)
        best: Optional[ProjectionResult] = None
        for edge in self.edges:
            pts = edge.points_ras
            if len(pts) < 2:
                continue
            seg_lengths = np.linalg.norm(np.diff(pts, axis=0), axis=1)
            cumulative = np.concatenate(([0.0], np.cumsum(seg_lengths)))
            for j in range(len(pts) - 1):
                a = pts[j]
                b = pts[j + 1]
                ab = b - a
                denom = float(np.dot(ab, ab))
                frac = 0.0 if denom < 1e-12 else float(np.clip(np.dot(target - a, ab) / denom, 0.0, 1.0))
                proj = a + frac * ab
                d = _distance(target, proj)
                if best is None or d < best.distance_mm:
                    best = ProjectionResult(
                        edge_id=edge.id,
                        cell_id=edge.cell_id,
                        segment_index=j,
                        segment_fraction=frac,
                        projection_ras=tuple(float(x) for x in proj),
                        distance_mm=d,
                        distance_from_edge_start_mm=float(cumulative[j] + frac * seg_lengths[j]),
                        edge_length_mm=edge.length_mm,
                    )
        if best is None:
            raise ValueError("Could not project target onto any edge")
        return best

    def route_to_point(self, target_ras: Sequence[float], include_frames: bool = True) -> Dict[str, Any]:
        if self.root_node_id is None:
            raise ValueError("Root node has not been set")
        target = np.asarray(target_ras, dtype=float)
        proj = self.nearest_edge_projection(target)
        edge = self.edges[proj.edge_id]
        dist = self.root_distances

        # The shortest path to a point on an edge may approach from either endpoint.
        distance_from_start = proj.distance_from_edge_start_mm
        distance_from_end = edge.length_mm - distance_from_start
        cost_via_start = dist[edge.start_node] + distance_from_start
        cost_via_end = dist[edge.end_node] + distance_from_end

        if cost_via_start <= cost_via_end:
            approach_node = edge.start_node
            other_node = edge.end_node
            edge_points_oriented = edge.points_ras
            projection_distance_from_approach = distance_from_start
        else:
            approach_node = edge.end_node
            other_node = edge.start_node
            edge_points_oriented = edge.points_ras[::-1]
            projection_distance_from_approach = distance_from_end

        node_ids, edge_ids = self.node_path_to(approach_node)
        route_points_full_edges, full_edge_start_indices = self._points_and_edge_start_indices_for_node_edge_path(node_ids, edge_ids)
        partial_points = _partial_polyline_to_distance(edge_points_oriented, projection_distance_from_approach, proj.projection_ras)
        partial_edge_start_index = max(0, len(route_points_full_edges) - 1)
        route_points = _concat_polylines(route_points_full_edges, partial_points)

        route_edge_ids = edge_ids + [proj.edge_id]
        route_edge_start_point_indices = full_edge_start_indices + [partial_edge_start_index]
        route_node_ids = node_ids
        if route_node_ids and route_node_ids[-1] != approach_node:
            route_node_ids.append(approach_node)

        result: Dict[str, Any] = {
            "target_ras": _round_list(target, 4),
            "root_node_id": self.root_node_id,
            "root_ras": _round_list(self.nodes[self.root_node_id].ras, 4),
            "carina_node_id": self.carina_node_id,
            "carina_ras": _round_list(self.nodes[self.carina_node_id].ras, 4) if self.carina_node_id is not None else None,
            "nearest_airway": {
                "edge_id": proj.edge_id,
                "cell_id": proj.cell_id,
                "segment_index": proj.segment_index,
                "segment_fraction": round(proj.segment_fraction, 6),
                "projection_ras": _round_list(proj.projection_ras, 4),
                "airway_to_target_distance_mm": round(proj.distance_mm, 4),
                "distance_from_edge_start_mm": round(proj.distance_from_edge_start_mm, 4),
                "edge_length_mm": round(proj.edge_length_mm, 4),
            },
            "route": {
                "approach_node_id": approach_node,
                "approach_node_ras": _round_list(self.nodes[approach_node].ras, 4),
                "nearest_edge_other_node_id": other_node,
                "node_ids": route_node_ids,
                "edge_ids": route_edge_ids,
                "cell_ids": [self.edges[eid].cell_id for eid in route_edge_ids],
                "edge_start_point_indices": route_edge_start_point_indices,
                "path_length_to_projection_mm": round(float(min(cost_via_start, cost_via_end)), 4),
                "point_count": int(len(route_points)),
                "points_ras": [_round_list(p, 4) for p in route_points],
            },
        }

        result["bifurcation_decisions"] = self.bifurcation_decisions(
            route_edge_ids,
            target_ras=target,
            route_edge_start_point_indices=route_edge_start_point_indices,
        )

        if include_frames:
            frames = build_parallel_transport_frames(route_points, target_ras=target)
            result["route"]["frames"] = frames

        return result

    def _points_for_node_edge_path(self, node_ids: List[int], edge_ids: List[int]) -> np.ndarray:
        points, _ = self._points_and_edge_start_indices_for_node_edge_path(node_ids, edge_ids)
        return points

    def _points_and_edge_start_indices_for_node_edge_path(self, node_ids: List[int], edge_ids: List[int]) -> Tuple[np.ndarray, List[int]]:
        if not edge_ids:
            return (
                np.asarray([self.nodes[node_ids[0]].ras], dtype=float) if node_ids else np.empty((0, 3), dtype=float),
                [],
            )
        out = np.empty((0, 3), dtype=float)
        start_indices: List[int] = []
        for i, edge_id in enumerate(edge_ids):
            from_node = node_ids[i]
            to_node = node_ids[i + 1]
            poly = self.oriented_edge_points(edge_id, from_node, to_node)
            start_indices.append(0 if len(out) == 0 else len(out) - 1)
            out = _concat_polylines(out, poly)
        return out, start_indices

    def bifurcation_decisions(
        self,
        route_edge_ids: List[int],
        target_ras: Sequence[float],
        route_edge_start_point_indices: Optional[List[int]] = None,
    ) -> List[Dict[str, Any]]:
        if not route_edge_ids:
            return []
        target = np.asarray(target_ras, dtype=float)
        dist = self.root_distances
        decisions: List[Dict[str, Any]] = []

        # Determine the node where each route edge starts, using root-distance orientation.
        route_start_nodes: List[int] = []
        route_end_nodes: List[int] = []
        for eid in route_edge_ids:
            e = self.edges[eid]
            if dist[e.start_node] <= dist[e.end_node]:
                route_start_nodes.append(e.start_node)
                route_end_nodes.append(e.end_node)
            else:
                route_start_nodes.append(e.end_node)
                route_end_nodes.append(e.start_node)

        for idx, eid in enumerate(route_edge_ids):
            node_id = route_start_nodes[idx]
            node = self.nodes[node_id]
            if node.degree < 3 and node.kind not in {"carina"}:
                continue
            options = []
            for neigh, opt_eid in self.adj[node_id]:
                # For a learner-facing bifurcation decision, use distal options only.
                # This excludes the parent airway that returns proximally.
                if dist[neigh] <= dist[node_id] + 1e-6:
                    continue
                opt_edge = self.edges[opt_eid]
                oriented = self.oriented_edge_points(opt_eid, node_id, neigh)
                direction = _unit(oriented[min(1, len(oriented) - 1)] - oriented[0])
                target_direction = _unit(target - np.asarray(node.ras, dtype=float), fallback=np.array([0.0, 0.0, 1.0]))
                angle = math.degrees(math.acos(float(np.clip(np.dot(direction, target_direction), -1.0, 1.0))))
                options.append(
                    {
                        "edge_id": opt_eid,
                        "cell_id": opt_edge.cell_id,
                        "to_node_id": neigh,
                        "to_node_ras": _round_list(self.nodes[neigh].ras, 4),
                        "length_mm": round(opt_edge.length_mm, 4),
                        "mean_radius_mm": round(opt_edge.mean_radius_mm, 4),
                        "min_radius_mm": round(opt_edge.min_radius_mm, 4),
                        "first_direction_ras": _round_list(direction, 4),
                        "angle_to_target_degrees": round(angle, 2),
                        "endpoint_to_target_distance_mm": round(_distance(self.nodes[neigh].ras, target), 4),
                        "is_correct_next_branch": opt_eid == eid,
                    }
                )
            if options:
                decisions.append(
                    {
                        "route_edge_index": idx,
                        "route_point_index": int(route_edge_start_point_indices[idx]) if route_edge_start_point_indices and idx < len(route_edge_start_point_indices) else None,
                        "node_id": node_id,
                        "node_kind": node.kind,
                        "node_ras": _round_list(node.ras, 4),
                        "correct_edge_id": eid,
                        "correct_cell_id": self.edges[eid].cell_id,
                        "options": sorted(options, key=lambda x: x["edge_id"]),
                    }
                )
        return decisions

    def summary(self) -> Dict[str, Any]:
        degree_counts = Counter(node.degree for node in self.nodes)
        terminal_nodes = [n for n in self.nodes if n.degree == 1]
        bif_nodes = [n for n in self.nodes if n.degree >= 3]
        lengths = np.asarray([e.length_mm for e in self.edges], dtype=float)
        radii = np.concatenate([e.radius_mm[np.isfinite(e.radius_mm)] for e in self.edges if e.radius_mm.size])
        points = np.vstack([e.points_ras for e in self.edges]) if self.edges else np.empty((0, 3))
        return {
            "coordinate_system_exported": "RAS",
            "input_model_coordinate_system": "LPS converted to RAS" ,
            "node_count": len(self.nodes),
            "edge_count": len(self.edges),
            "sampled_polyline_point_count": int(sum(len(e.points_ras) for e in self.edges)),
            "degree_distribution": {str(k): v for k, v in sorted(degree_counts.items())},
            "terminal_node_count": len(terminal_nodes),
            "bifurcation_node_count_degree_ge_3": len(bif_nodes),
            "root_node_id": self.root_node_id,
            "root_ras": _round_list(self.nodes[self.root_node_id].ras, 4) if self.root_node_id is not None else None,
            "carina_node_id": self.carina_node_id,
            "carina_ras": _round_list(self.nodes[self.carina_node_id].ras, 4) if self.carina_node_id is not None else None,
            "edge_length_mm": {
                "min": round(float(np.min(lengths)), 4) if lengths.size else None,
                "median": round(float(np.median(lengths)), 4) if lengths.size else None,
                "max": round(float(np.max(lengths)), 4) if lengths.size else None,
                "total": round(float(np.sum(lengths)), 4) if lengths.size else None,
            },
            "point_radius_mm": {
                "min": round(float(np.min(radii)), 4) if radii.size else None,
                "median": round(float(np.median(radii)), 4) if radii.size else None,
                "max": round(float(np.max(radii)), 4) if radii.size else None,
            },
            "ras_bounds": {
                "min": _round_list(np.min(points, axis=0), 4) if points.size else None,
                "max": _round_list(np.max(points, axis=0), 4) if points.size else None,
            },
            "graph_note": "Use Dijkstra/root distances rather than assuming a perfect binary tree; this network has degree-4 bifurcations and a small cycle rank.",
        }

    def export_case_json(self, path: str | Path, include_geometry: bool = True) -> None:
        payload: Dict[str, Any] = {
            "schema": "bronchoscopy_airway_network_case/v1",
            "summary": self.summary(),
            "nodes": [
                {
                    "id": n.id,
                    "ras": _round_list(n.ras, 4),
                    "degree": n.degree,
                    "kind": n.kind,
                    "root_distance_mm": round(float(self.root_distances[n.id]), 4),
                }
                for n in self.nodes
            ],
            "edges": [],
        }
        for e in self.edges:
            item: Dict[str, Any] = {
                "id": e.id,
                "cell_id": e.cell_id,
                "start_node": e.start_node,
                "end_node": e.end_node,
                "length_mm": round(e.length_mm, 4),
                "tortuosity": round(e.tortuosity, 6) if np.isfinite(e.tortuosity) else None,
                "mean_radius_mm": round(e.mean_radius_mm, 4),
                "min_radius_mm": round(e.min_radius_mm, 4),
                "start_ras": _round_list(self.nodes[e.start_node].ras, 4),
                "end_ras": _round_list(self.nodes[e.end_node].ras, 4),
                "point_count": int(len(e.points_ras)),
            }
            if include_geometry:
                item["points_ras"] = [_round_list(p, 4) for p in e.points_ras]
                if e.radius_mm.size:
                    item["radius_mm"] = [round(float(x), 4) for x in e.radius_mm]
            payload["edges"].append(item)
        Path(path).write_text(json.dumps(payload, indent=2), encoding="utf-8")


# -----------------------------------------------------------------------------
# Route frames for CT planes and virtual bronchoscopy camera
# -----------------------------------------------------------------------------


def _polyline_length(points: np.ndarray) -> float:
    if len(points) < 2:
        return 0.0
    return float(np.linalg.norm(np.diff(points, axis=0), axis=1).sum())


def _concat_polylines(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    if a.size == 0:
        return b.copy()
    if b.size == 0:
        return a.copy()
    if _distance(a[-1], b[0]) < 1e-5:
        return np.vstack([a, b[1:]])
    return np.vstack([a, b])


def _concat_many_polylines(polylines: Iterable[np.ndarray]) -> np.ndarray:
    out = np.empty((0, 3), dtype=float)
    for poly in polylines:
        out = _concat_polylines(out, poly)
    return out


def _partial_polyline_to_distance(points: np.ndarray, distance_mm: float, projection_ras: Sequence[float]) -> np.ndarray:
    if len(points) == 0:
        return np.empty((0, 3), dtype=float)
    if len(points) == 1 or distance_mm <= 0:
        return np.asarray([points[0], np.asarray(projection_ras, dtype=float)], dtype=float)
    out = [points[0]]
    traveled = 0.0
    target = np.asarray(projection_ras, dtype=float)
    for i in range(len(points) - 1):
        a = points[i]
        b = points[i + 1]
        seg_len = _distance(a, b)
        if traveled + seg_len < distance_mm - 1e-6:
            out.append(b)
            traveled += seg_len
            continue
        remaining = max(0.0, distance_mm - traveled)
        frac = 0.0 if seg_len < 1e-12 else float(np.clip(remaining / seg_len, 0.0, 1.0))
        proj = a + frac * (b - a)
        # Prefer exact projection from the global projection routine, but avoid a large mismatch
        # if the route was oriented from the opposite endpoint.
        if _distance(proj, target) < 1.0:
            out.append(target)
        else:
            out.append(proj)
        break
    if _distance(out[-1], target) > 1e-5:
        out.append(target)
    return np.asarray(out, dtype=float)


def compute_tangents(points: np.ndarray) -> np.ndarray:
    points = np.asarray(points, dtype=float)
    n = len(points)
    if n == 0:
        return np.empty((0, 3), dtype=float)
    if n == 1:
        return np.asarray([[0.0, 0.0, 1.0]], dtype=float)
    tangents = np.zeros((n, 3), dtype=float)
    for i in range(n):
        if i == 0:
            v = points[1] - points[0]
        elif i == n - 1:
            v = points[-1] - points[-2]
        else:
            v = points[i + 1] - points[i - 1]
        tangents[i] = _unit(v, tangents[i - 1] if i > 0 else np.array([0.0, 0.0, -1.0]))
    return tangents


def initial_normal_for_tangent(tangent: np.ndarray, target_vector: Optional[np.ndarray] = None) -> np.ndarray:
    t = _unit(tangent, np.array([0.0, 0.0, -1.0]))
    if target_vector is not None and _norm(target_vector) > 1e-9:
        n = target_vector - np.dot(target_vector, t) * t
        if _norm(n) > 1e-9:
            return _unit(n)
    # Fallback axes in RAS. Prefer an axis not parallel to the airway tangent.
    candidates = [np.array([0.0, 1.0, 0.0]), np.array([1.0, 0.0, 0.0]), np.array([0.0, 0.0, 1.0])]
    for c in candidates:
        n = c - np.dot(c, t) * t
        if _norm(n) > 1e-6:
            return _unit(n)
    return np.array([1.0, 0.0, 0.0])


def build_parallel_transport_frames(points: np.ndarray, target_ras: Optional[Sequence[float]] = None) -> List[Dict[str, Any]]:
    points = np.asarray(points, dtype=float)
    tangents = compute_tangents(points)
    n_points = len(points)
    if n_points == 0:
        return []
    target = np.asarray(target_ras, dtype=float) if target_ras is not None else None

    normals = np.zeros_like(tangents)
    binormals = np.zeros_like(tangents)

    target_vec = target - points[0] if target is not None else None
    normals[0] = initial_normal_for_tangent(tangents[0], target_vec)
    binormals[0] = _unit(np.cross(tangents[0], normals[0]), np.array([1.0, 0.0, 0.0]))

    for i in range(1, n_points):
        t_prev = tangents[i - 1]
        t_curr = tangents[i]
        axis = np.cross(t_prev, t_curr)
        axis_norm = _norm(axis)
        normal = normals[i - 1]
        if axis_norm > 1e-9:
            angle = math.atan2(axis_norm, float(np.dot(t_prev, t_curr)))
            normal = _rodrigues_rotate(normal, axis / axis_norm, angle)
        # Re-orthogonalize to suppress drift.
        normal = normal - np.dot(normal, t_curr) * t_curr
        if _norm(normal) < 1e-9:
            normal = initial_normal_for_tangent(t_curr, target - points[i] if target is not None else None)
        normals[i] = _unit(normal)
        binormals[i] = _unit(np.cross(t_curr, normals[i]), binormals[i - 1])

    frames: List[Dict[str, Any]] = []
    cumulative = np.concatenate(([0.0], np.cumsum(np.linalg.norm(np.diff(points, axis=0), axis=1)))) if len(points) > 1 else np.array([0.0])
    for i in range(n_points):
        frame = {
            "index": i,
            "distance_from_root_mm": round(float(cumulative[i]), 4),
            "origin_ras": _round_list(points[i], 4),
            "tangent_ras": _round_list(tangents[i], 5),
            "normal_ras": _round_list(normals[i], 5),
            "binormal_ras": _round_list(binormals[i], 5),
            "ct_planes": {
                "airway_cross_section": {
                    "origin_ras": _round_list(points[i], 4),
                    "x_axis_ras": _round_list(normals[i], 5),
                    "y_axis_ras": _round_list(binormals[i], 5),
                    "normal_ras": _round_list(tangents[i], 5),
                },
                "airway_long_axis_normal": {
                    "origin_ras": _round_list(points[i], 4),
                    "x_axis_ras": _round_list(tangents[i], 5),
                    "y_axis_ras": _round_list(normals[i], 5),
                    "normal_ras": _round_list(binormals[i], 5),
                },
                "airway_long_axis_binormal": {
                    "origin_ras": _round_list(points[i], 4),
                    "x_axis_ras": _round_list(tangents[i], 5),
                    "y_axis_ras": _round_list(binormals[i], 5),
                    "normal_ras": _round_list(normals[i], 5),
                },
            },
            "bronchoscope_camera": {
                "position_ras": _round_list(points[i], 4),
                "view_direction_ras": _round_list(tangents[i], 5),
                "up_ras": _round_list(normals[i], 5),
            },
        }
        if target is not None:
            lesion_vec = target - points[i]
            lesion_axis = lesion_vec - np.dot(lesion_vec, tangents[i]) * tangents[i]
            if _norm(lesion_axis) > 1e-9:
                lesion_axis = _unit(lesion_axis)
                lesion_plane_normal = _unit(np.cross(tangents[i], lesion_axis), binormals[i])
                frame["ct_planes"]["lesion_directed_long_axis"] = {
                    "origin_ras": _round_list(points[i], 4),
                    "x_axis_ras": _round_list(tangents[i], 5),
                    "y_axis_ras": _round_list(lesion_axis, 5),
                    "normal_ras": _round_list(lesion_plane_normal, 5),
                }
            frame["distance_to_target_mm"] = round(_distance(points[i], target), 4)
        frames.append(frame)
    return frames


# -----------------------------------------------------------------------------
# Centerline model summary helper
# -----------------------------------------------------------------------------


def summarize_centerline_model(centerline_vtk: str | Path) -> Dict[str, Any]:
    poly = LegacyVTKReader(centerline_vtk).read()
    pts_ras = lps_to_ras_points(poly.points) if poly.space == "LPS" else poly.points.astype(float)
    starts = np.asarray([pts_ras[line[0]] for line in poly.lines], dtype=float) if poly.lines else np.empty((0, 3))
    ends = np.asarray([pts_ras[line[-1]] for line in poly.lines], dtype=float) if poly.lines else np.empty((0, 3))
    start_keys = [tuple(np.round(p, 3)) for p in starts]
    end_keys = [tuple(np.round(p, 3)) for p in ends]
    start_counts = Counter(start_keys)
    lengths = [_polyline_length(pts_ras[line]) for line in poly.lines]
    return {
        "path": str(centerline_vtk),
        "input_coordinate_system": poly.space,
        "point_count": int(len(poly.points)),
        "line_count": int(len(poly.lines)),
        "line_point_count": {
            "min": int(min(map(len, poly.lines))) if poly.lines else None,
            "max": int(max(map(len, poly.lines))) if poly.lines else None,
        },
        "unique_start_points_rounded_0p001mm": len(set(start_keys)),
        "unique_end_points_rounded_0p001mm": len(set(end_keys)),
        "most_common_start_points": [
            {"ras": [float(x) for x in key], "count": count}
            for key, count in start_counts.most_common(10)
        ],
        "line_length_mm": {
            "min": round(float(np.min(lengths)), 4) if lengths else None,
            "median": round(float(np.median(lengths)), 4) if lengths else None,
            "max": round(float(np.max(lengths)), 4) if lengths else None,
        },
        "point_data_arrays": {name: list(arr.shape) for name, arr in poly.point_data.items()},
        "note": "This model appears to contain multiple root-to-terminal centerline paths. The Network model is cleaner for branch graph/routing; this Centerline model can still be useful for comparing complete terminal paths.",
    }


# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="Build airway graph and route objects from Slicer/VMTK VTK centerline exports.")
    parser.add_argument("--network-vtk", required=True, help="Path to Network model.vtk")
    parser.add_argument("--centerline-vtk", default=None, help="Optional path to Centerline model.vtk for summary only")
    parser.add_argument("--out-json", default=None, help="Export full airway network case JSON")
    parser.add_argument("--summary-json", default=None, help="Export compact summary JSON")
    parser.add_argument("--target-ras", nargs=3, type=float, default=None, metavar=("R", "A", "S"), help="Target lesion point in RAS mm")
    parser.add_argument("--route-json", default=None, help="Export route to target JSON")
    parser.add_argument("--no-frames", action="store_true", help="Do not include CT/camera frames in route JSON")
    args = parser.parse_args()

    network = AirwayNetwork.from_network_vtk(args.network_vtk)

    summary = network.summary()
    if args.centerline_vtk:
        summary["centerline_model_summary"] = summarize_centerline_model(args.centerline_vtk)

    if args.summary_json:
        Path(args.summary_json).write_text(json.dumps(summary, indent=2), encoding="utf-8")
    else:
        print(json.dumps(summary, indent=2))

    if args.out_json:
        network.export_case_json(args.out_json, include_geometry=True)

    if args.target_ras is not None:
        route = network.route_to_point(args.target_ras, include_frames=not args.no_frames)
        if args.route_json:
            Path(args.route_json).write_text(json.dumps(route, indent=2), encoding="utf-8")
        else:
            print(json.dumps(route, indent=2))


if __name__ == "__main__":
    main()
