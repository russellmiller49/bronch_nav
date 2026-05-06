import type { AirwayEdge, AirwayNode, BranchOption, Decision, RouteState, Vec3, WebCase } from "./types";

const CHOICE_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface CaseIndexes {
  nodesById: Map<number, AirwayNode>;
  edgesById: Map<number, AirwayEdge>;
  childEdgesByNode: Map<number, AirwayEdge[]>;
}

export function createIndexes(webCase: WebCase): CaseIndexes {
  const nodesById = new Map(webCase.airway.nodes.map((node) => [node.id, node]));
  const edgesById = new Map(webCase.airway.edges.map((edge) => [edge.id, edge]));
  const childEdgesByNode = new Map<number, AirwayEdge[]>();

  for (const edge of webCase.airway.edges) {
    const start = nodesById.get(edge.startNode);
    const end = nodesById.get(edge.endNode);
    if (!start || !end) {
      continue;
    }
    if (end.rootDistanceMm > start.rootDistanceMm) {
      appendChildEdge(childEdgesByNode, start.id, edge);
    }
    if (start.rootDistanceMm > end.rootDistanceMm) {
      appendChildEdge(childEdgesByNode, end.id, edge);
    }
  }
  for (const edges of childEdgesByNode.values()) {
    edges.sort((a, b) => a.id - b.id);
  }
  return { nodesById, edgesById, childEdgesByNode };
}

function appendChildEdge(map: Map<number, AirwayEdge[]>, nodeId: number, edge: AirwayEdge) {
  const current = map.get(nodeId) ?? [];
  current.push(edge);
  map.set(nodeId, current);
}

export function buildRoute(terminalNodeId: number, indexes: CaseIndexes): RouteState {
  const nodePath = [terminalNodeId];
  const edgePath: number[] = [];
  let current = indexes.nodesById.get(terminalNodeId);

  while (current?.parentNodeId != null && current.parentEdgeId != null) {
    edgePath.push(current.parentEdgeId);
    nodePath.push(current.parentNodeId);
    current = indexes.nodesById.get(current.parentNodeId);
  }

  nodePath.reverse();
  edgePath.reverse();

  const routePoints: Vec3[] = [];
  edgePath.forEach((edgeId, edgeIndex) => {
    const edge = indexes.edgesById.get(edgeId);
    if (!edge) {
      return;
    }
    const oriented = orientedEdgePoints(edge, nodePath[edgeIndex], nodePath[edgeIndex + 1]);
    if (routePoints.length && oriented.length && samePoint(routePoints[routePoints.length - 1], oriented[0])) {
      routePoints.push(...oriented.slice(1));
    } else {
      routePoints.push(...oriented);
    }
  });

  const decisions: Decision[] = [];
  edgePath.forEach((edgeId, edgeIndex) => {
    const startNodeId = nodePath[edgeIndex];
    const node = indexes.nodesById.get(startNodeId);
    const childEdges = indexes.childEdgesByNode.get(startNodeId) ?? [];
    if (!node || childEdges.length < 2) {
      return;
    }
    const options: BranchOption[] = childEdges.map((edge, optionIndex) => ({
      label: CHOICE_LABELS[optionIndex] ?? `${optionIndex + 1}`,
      edgeId: edge.id,
      toNodeId: childNodeForEdge(edge, startNodeId, indexes),
      isCorrect: edge.id === edgeId
    }));
    decisions.push({
      index: decisions.length,
      nodeId: startNodeId,
      nodeRas: node.ras,
      routeEdgeId: edgeId,
      options
    });
  });

  return { terminalNodeId, nodePath, edgePath, routePoints, decisions };
}

export function orientedEdgePoints(edge: AirwayEdge, fromNodeId: number, toNodeId: number): Vec3[] {
  if (edge.startNode === fromNodeId && edge.endNode === toNodeId) {
    return edge.pointsRas;
  }
  if (edge.endNode === fromNodeId && edge.startNode === toNodeId) {
    return [...edge.pointsRas].reverse();
  }
  return edge.pointsRas;
}

export function childNodeForEdge(edge: AirwayEdge, parentNodeId: number, indexes: CaseIndexes): number {
  const a = indexes.nodesById.get(edge.startNode);
  const b = indexes.nodesById.get(edge.endNode);
  if (!a || !b) {
    return edge.endNode;
  }
  if (edge.startNode === parentNodeId) {
    return edge.endNode;
  }
  if (edge.endNode === parentNodeId) {
    return edge.startNode;
  }
  return a.rootDistanceMm < b.rootDistanceMm ? b.id : a.id;
}

function samePoint(a: Vec3, b: Vec3): boolean {
  return Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01 && Math.abs(a[2] - b[2]) < 0.01;
}
