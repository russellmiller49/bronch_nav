from __future__ import annotations

import math
from dataclasses import dataclass
from collections import defaultdict

from airway_labeling.rules.book_candidate_rules import (
    CandidateRuleEngine,
    detect_lateral_branch,
    load_candidate_rules,
)


@dataclass
class Node:
    id: int
    ras: list[float]


@dataclass
class Edge:
    id: int
    start_node: int
    end_node: int
    vector: list[float]
    length_mm: float
    mean_radius_mm: float = 4.0
    label: str | None = None
    generation: int | None = None
    between_b6_and_basal: bool = False

    @property
    def points_ras(self) -> list[list[float]]:
        return [GRAPH_POINTS[self.start_node], GRAPH_POINTS[self.end_node]]


GRAPH_POINTS: dict[int, list[float]] = {}


class Graph:
    def __init__(self) -> None:
        GRAPH_POINTS.clear()
        self.nodes = [Node(0, [0.0, 0.0, 0.0])]
        GRAPH_POINTS[0] = [0.0, 0.0, 0.0]
        self.edges: list[Edge] = []
        self.adj: dict[int, list[tuple[int, int]]] = defaultdict(list)
        self.root_distances = [0.0]

    def add_child(
        self,
        parent: int,
        vector: list[float],
        *,
        radius: float = 4.0,
        label: str | None = None,
        generation: int | None = None,
        between_b6_and_basal: bool = False,
    ) -> Edge:
        node_id = len(self.nodes)
        parent_point = self.nodes[parent].ras
        point = [parent_point[i] + float(vector[i]) for i in range(3)]
        self.nodes.append(Node(node_id, point))
        GRAPH_POINTS[node_id] = point
        edge_id = len(self.edges)
        length = math.sqrt(sum(float(item) * float(item) for item in vector))
        edge = Edge(
            id=edge_id,
            start_node=parent,
            end_node=node_id,
            vector=list(vector),
            length_mm=length,
            mean_radius_mm=radius,
            label=label,
            generation=generation,
            between_b6_and_basal=between_b6_and_basal,
        )
        self.edges.append(edge)
        self.adj[parent].append((node_id, edge_id))
        self.adj[node_id].append((parent, edge_id))
        self.root_distances.append(self.root_distances[parent] + length)
        return edge


def _engine() -> CandidateRuleEngine:
    return CandidateRuleEngine(load_candidate_rules())


def _top(results, edge: Edge) -> str:
    candidates = [item for item in results if item.edge_id == edge.id]
    assert candidates, f"no candidates for edge {edge.id}"
    return max(candidates, key=lambda item: item.score).candidate_label


def test_right_upper_lobe_candidates():
    graph = Graph()
    b1 = graph.add_child(0, [0, 0, 10], generation=3)
    b2 = graph.add_child(0, [0, -9, 5], generation=3)
    b3 = graph.add_child(0, [0, 10, 0], generation=3)

    hierarchy = {"coordinate_system": "RAS", "node_labels": {0: "RUL"}}
    results = _engine().generate_segmental_candidates(graph, hierarchy)

    assert _top(results, b1) == "RUL_B1"
    assert _top(results, b2) == "RUL_B2"
    assert _top(results, b3) == "RUL_B3"


def test_right_middle_lobe_candidates():
    graph = Graph()
    b4 = graph.add_child(0, [10, 0, 0], generation=3)
    b5 = graph.add_child(0, [-5, 9, -6], generation=3)

    hierarchy = {"coordinate_system": "RAS", "node_labels": {0: "RML"}}
    results = _engine().generate_segmental_candidates(graph, hierarchy)

    assert _top(results, b4) == "RML_B4"
    assert _top(results, b5) == "RML_B5"


def test_right_b6_candidates():
    graph = Graph()
    b6 = graph.add_child(0, [0, -8, 0], label="RLL_B6", generation=3)
    b6a = graph.add_child(b6.end_node, [0, 0, 10], generation=4)
    b6b = graph.add_child(b6.end_node, [8, 0, -7], generation=4)
    b6c = graph.add_child(b6.end_node, [-8, 0, -7], generation=4)

    hierarchy = {
        "coordinate_system": "RAS",
        "edge_labels": {b6.id: {"label": "RLL_B6", "confidence": 0.95, "locked": True}},
    }
    results = _engine().generate_subsegmental_candidates(graph, hierarchy)

    assert _top(results, b6a) == "RLL_B6a"
    assert _top(results, b6b) == "RLL_B6b"
    assert _top(results, b6c) == "RLL_B6c"


def test_left_superior_candidates():
    graph = Graph()
    b12 = graph.add_child(0, [0, -8, 7], generation=3)
    b3 = graph.add_child(0, [0, 10, 0], generation=3)
    b12c = graph.add_child(b12.end_node, [-10, 0, 0], generation=4)
    b12a = graph.add_child(b12.end_node, [0, 0, 10], generation=4)
    b12b = graph.add_child(b12.end_node, [0, -10, 0], generation=4)

    hierarchy = {"coordinate_system": "RAS", "node_labels": {0: "LUL_SUPERIOR"}}
    engine = _engine()
    segmental = engine.generate_segmental_candidates(graph, hierarchy)
    assert _top(segmental, b12) == "LUL_B1_2"
    assert _top(segmental, b3) == "LUL_B3"

    hierarchy["edge_labels"] = {b12.id: {"label": "LUL_B1_2", "confidence": 0.95, "locked": True}}
    subsegmental = engine.generate_subsegmental_candidates(graph, hierarchy)
    assert _top(subsegmental, b12c) == "LUL_B1_2c"
    assert _top(subsegmental, b12a) == "LUL_B1_2a"
    assert _top(subsegmental, b12b) == "LUL_B1_2b"


def test_lingula_candidates():
    graph = Graph()
    b4 = graph.add_child(0, [-8, 0, 8], generation=3)
    b5 = graph.add_child(0, [6, 8, -7], generation=3)
    b4a = graph.add_child(b4.end_node, [-8, -5, 7], generation=4)
    b4b = graph.add_child(b4.end_node, [6, 8, -7], generation=4)
    b5a = graph.add_child(b5.end_node, [-8, 8, 0], generation=4)
    b5b = graph.add_child(b5.end_node, [0, 0, -10], generation=4)

    hierarchy = {"coordinate_system": "RAS", "node_labels": {0: "LINGULA"}}
    engine = _engine()
    segmental = engine.generate_segmental_candidates(graph, hierarchy)
    assert _top(segmental, b4) == "LINGULA_B4"
    assert _top(segmental, b5) == "LINGULA_B5"

    hierarchy["edge_labels"] = {
        b4.id: {"label": "LINGULA_B4", "confidence": 0.95, "locked": True},
        b5.id: {"label": "LINGULA_B5", "confidence": 0.95, "locked": True},
    }
    subsegmental = engine.generate_subsegmental_candidates(graph, hierarchy)
    assert _top(subsegmental, b4a) == "LINGULA_B4a"
    assert _top(subsegmental, b4b) == "LINGULA_B4b"
    assert _top(subsegmental, b5a) == "LINGULA_B5a"
    assert _top(subsegmental, b5b) == "LINGULA_B5b"


def test_left_basal_candidates():
    graph = Graph()
    b8 = graph.add_child(0, [0, 9, -5], generation=3)
    b9 = graph.add_child(0, [-10, 0, -4], generation=3)
    b10 = graph.add_child(0, [0, -10, -5], generation=3)
    b8a = graph.add_child(b8.end_node, [-10, 0, 0], generation=4)
    b8b = graph.add_child(b8.end_node, [0, 0, -10], generation=4)
    b9a = graph.add_child(b9.end_node, [-8, -5, 0], generation=4)
    b9b = graph.add_child(b9.end_node, [0, 0, -10], generation=4)
    b10a = graph.add_child(b10.end_node, [0, -10, 0], generation=4)
    b10b = graph.add_child(b10.end_node, [-10, 0, 0], generation=4)
    b10c = graph.add_child(b10.end_node, [10, 0, 0], generation=4)

    hierarchy = {"coordinate_system": "RAS", "node_labels": {0: "LLL_BASAL"}}
    engine = _engine()
    segmental = engine.generate_segmental_candidates(graph, hierarchy)
    assert _top(segmental, b8) == "LLL_B8"
    assert _top(segmental, b9) == "LLL_B9"
    assert _top(segmental, b10) == "LLL_B10"

    hierarchy["edge_labels"] = {
        b8.id: {"label": "LLL_B8", "confidence": 0.95, "locked": True},
        b9.id: {"label": "LLL_B9", "confidence": 0.95, "locked": True},
        b10.id: {"label": "LLL_B10", "confidence": 0.95, "locked": True},
    }
    subsegmental = engine.generate_subsegmental_candidates(graph, hierarchy)
    assert _top(subsegmental, b8a) == "LLL_B8a"
    assert _top(subsegmental, b8b) == "LLL_B8b"
    assert _top(subsegmental, b9a) == "LLL_B9a"
    assert _top(subsegmental, b9b) == "LLL_B9b"
    assert _top(subsegmental, b10a) == "LLL_B10a"
    assert _top(subsegmental, b10b) == "LLL_B10b"
    assert _top(subsegmental, b10c) == "LLL_B10c"


def test_lateral_branch_detection():
    graph = Graph()
    parent = graph.add_child(0, [0, 0, 10], radius=5.0, label="RLL_B10b", generation=4)
    continuing = graph.add_child(parent.end_node, [0, 0, 10], radius=5.0, generation=5)
    daughter = graph.add_child(parent.end_node, [8, 0, 2], radius=2.0, generation=5)

    result = detect_lateral_branch(daughter, parent, [continuing])

    assert result is not None
    assert result.candidate_label == "RLL_B10b*"
    assert result.candidate_level == "variant"
    assert result.evidence["generation_incremented"] is False


def test_bstar_variant():
    graph = Graph()
    bstar = graph.add_child(0, [8, -8, 0], generation=3, between_b6_and_basal=True)

    hierarchy = {"coordinate_system": "RAS", "node_labels": {0: "RLL_BASAL"}}
    results = _engine().generate_segmental_candidates(graph, hierarchy)
    labels = [item.candidate_label for item in results if item.edge_id == bstar.id]

    assert labels == ["B*"]
    assert all(label not in labels for label in ["RLL_B7", "RLL_B8", "RLL_B9", "RLL_B10"])


def test_uncertain_coordinates():
    graph = Graph()
    edge = graph.add_child(0, [0, 0, 10], generation=3)

    hierarchy = {"coordinate_system": "UNKNOWN", "node_labels": {0: "RUL"}}
    results = _engine().generate_segmental_candidates(graph, hierarchy)

    assert results
    assert hierarchy["review_queue"]
    assert all("coordinate_system_uncertain_review_required" in item.warnings for item in results)
    assert max(item.score for item in results if item.edge_id == edge.id) < 0.55
