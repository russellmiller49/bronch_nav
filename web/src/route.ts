import type { AirwayEdge, AirwayNode, BranchOption, Decision, RouteState, Vec3, WebCase } from "./types";

const CHOICE_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const NON_VISIBLE_TERMINAL_MEAN_RADIUS_MM = 0.35;
const NON_VISIBLE_TERMINAL_LENGTH_MM = 6;

const NEARBY_DECISION_COLLAPSES = [
  { parentNodeId: 2, childNodeId: 6, viaEdgeId: 5 },
  { parentNodeId: 4, childNodeId: 10, viaEdgeId: 9 },
  { parentNodeId: 46, childNodeId: 89, viaEdgeId: 88 },
  { parentNodeId: 92, childNodeId: 93, viaEdgeId: 91 }
] as const;

export interface CaseIndexes {
  nodesById: Map<number, AirwayNode>;
  edgesById: Map<number, AirwayEdge>;
  childEdgesByNode: Map<number, AirwayEdge[]>;
}

interface CollapsedDecision {
  decision: Decision;
  skipNodeIds: number[];
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

export function buildRoute(terminalNodeId: number, indexes: CaseIndexes, correctTerminalNodeIds: number[] = [terminalNodeId]): RouteState {
  const correctTerminalSet = new Set(correctTerminalNodeIds.length ? correctTerminalNodeIds : [terminalNodeId]);
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
  const routeDistancesMm: number[] = [];
  const nodeDistancesMm: Record<number, number> = {};
  let totalLengthMm = 0;
  edgePath.forEach((edgeId, edgeIndex) => {
    const edge = indexes.edgesById.get(edgeId);
    if (!edge) {
      return;
    }
    nodeDistancesMm[nodePath[edgeIndex]] = totalLengthMm;
    const oriented = orientedEdgePoints(edge, nodePath[edgeIndex], nodePath[edgeIndex + 1]);
    appendRoutePoints(routePoints, routeDistancesMm, oriented, (nextTotal) => {
      totalLengthMm = nextTotal;
    }, totalLengthMm);
    nodeDistancesMm[nodePath[edgeIndex + 1]] = totalLengthMm;
  });

  if (!routePoints.length) {
    const node = indexes.nodesById.get(terminalNodeId);
    if (node) {
      routePoints.push(node.ras);
      routeDistancesMm.push(0);
      nodeDistancesMm[terminalNodeId] = 0;
    }
  }

  const decisions: Decision[] = [];
  const skipDecisionNodeIds = new Set<number>();
  edgePath.forEach((edgeId, edgeIndex) => {
    const startNodeId = nodePath[edgeIndex];
    if (skipDecisionNodeIds.has(startNodeId)) {
      return;
    }
    const node = indexes.nodesById.get(startNodeId);
    const childEdges = indexes.childEdgesByNode.get(startNodeId) ?? [];
    if (!node || childEdges.length < 2) {
      return;
    }
    if (isNonVisibleTerminalDecision(childEdges, startNodeId, indexes)) {
      return;
    }

    const collapsedDecision = buildCollapsedRightLowerLobeDecision({
      indexes,
      node,
      childEdges,
      routeEdgeId: edgeId,
      nextRouteEdgeId: edgePath[edgeIndex + 1] ?? null,
      decisionIndex: decisions.length,
      correctTerminalSet
    });
    if (collapsedDecision) {
      decisions.push(collapsedDecision.decision);
      collapsedDecision.skipNodeIds.forEach((nodeId) => skipDecisionNodeIds.add(nodeId));
      return;
    }

    const nearbyCollapsedDecision = buildCollapsedNearbyDecision({
      indexes,
      node,
      childEdges,
      routeEdgeId: edgeId,
      nextRouteEdgeId: edgePath[edgeIndex + 1] ?? null,
      decisionIndex: decisions.length,
      correctTerminalSet
    });
    if (nearbyCollapsedDecision) {
      decisions.push(nearbyCollapsedDecision.decision);
      nearbyCollapsedDecision.skipNodeIds.forEach((nodeId) => skipDecisionNodeIds.add(nodeId));
      return;
    }

    const options: BranchOption[] = childEdges.map((edge, optionIndex) => {
      const toNodeId = childNodeForEdge(edge, startNodeId, indexes);
      const matchingTerminalNodeIds = matchingCorrectTerminalNodeIds(toNodeId, indexes, correctTerminalSet);
      return {
        label: CHOICE_LABELS[optionIndex] ?? `${optionIndex + 1}`,
        edgeId: edge.id,
        toNodeId,
        isCorrect: matchingTerminalNodeIds.length > 0,
        correctTerminalNodeIds: matchingTerminalNodeIds
      };
    });
    decisions.push({
      index: decisions.length,
      nodeId: startNodeId,
      nodeRas: node.ras,
      routeEdgeId: edgeId,
      options
    });
  });

  return { terminalNodeId, nodePath, edgePath, routePoints, routeDistancesMm, nodeDistancesMm, totalLengthMm, decisions };
}

function appendRoutePoints(
  routePoints: Vec3[],
  routeDistancesMm: number[],
  oriented: Vec3[],
  setTotal: (value: number) => void,
  startTotal: number
) {
  let total = startTotal;
  if (!oriented.length) {
    setTotal(total);
    return;
  }
  let startIndex = 0;
  if (!routePoints.length) {
    routePoints.push(oriented[0]);
    routeDistancesMm.push(total);
    startIndex = 1;
  } else if (samePoint(routePoints[routePoints.length - 1], oriented[0])) {
    startIndex = 1;
  } else {
    total += distanceMm(routePoints[routePoints.length - 1], oriented[0]);
    routePoints.push(oriented[0]);
    routeDistancesMm.push(total);
    startIndex = 1;
  }
  for (let index = startIndex; index < oriented.length; index += 1) {
    total += distanceMm(oriented[index - 1], oriented[index]);
    routePoints.push(oriented[index]);
    routeDistancesMm.push(total);
  }
  setTotal(total);
}

function matchingCorrectTerminalNodeIds(nodeId: number, indexes: CaseIndexes, correctTerminalSet: Set<number>): number[] {
  const matchingNodeIds: number[] = correctTerminalSet.has(nodeId) ? [nodeId] : [];
  const childEdges = indexes.childEdgesByNode.get(nodeId) ?? [];
  childEdges.forEach((edge) => {
    matchingNodeIds.push(...matchingCorrectTerminalNodeIds(childNodeForEdge(edge, nodeId, indexes), indexes, correctTerminalSet));
  });
  return matchingNodeIds.filter((matchingNodeId, index) => matchingNodeIds.indexOf(matchingNodeId) === index);
}

function buildCollapsedNearbyDecision({
  indexes,
  node,
  childEdges,
  routeEdgeId,
  nextRouteEdgeId,
  decisionIndex,
  correctTerminalSet
}: {
  indexes: CaseIndexes;
  node: AirwayNode;
  childEdges: AirwayEdge[];
  routeEdgeId: number;
  nextRouteEdgeId: number | null;
  decisionIndex: number;
  correctTerminalSet: Set<number>;
}): CollapsedDecision | null {
  const collapse = NEARBY_DECISION_COLLAPSES.find((candidate) => candidate.parentNodeId === node.id);
  if (!collapse) {
    return null;
  }

  const continuationEdge = childEdges.find((edge) => edge.id === collapse.viaEdgeId);
  if (!continuationEdge || childNodeForEdge(continuationEdge, node.id, indexes) !== collapse.childNodeId) {
    return null;
  }

  const childEdgesToCollapse = indexes.childEdgesByNode.get(collapse.childNodeId) ?? [];
  if (childEdgesToCollapse.length < 2) {
    return null;
  }

  const parentOptionEdges = childEdges.filter((edge) => edge.id !== continuationEdge.id);
  const optionEdges = [...parentOptionEdges, ...childEdgesToCollapse];
  const correctEdgeId = routeEdgeId === continuationEdge.id && nextRouteEdgeId != null ? nextRouteEdgeId : routeEdgeId;
  const options: BranchOption[] = optionEdges.map((edge, optionIndex) => {
    const fromNodeId = parentOptionEdges.includes(edge) ? node.id : collapse.childNodeId;
    const toNodeId = childNodeForEdge(edge, fromNodeId, indexes);
    const matchingTerminalNodeIds = matchingCorrectTerminalNodeIds(toNodeId, indexes, correctTerminalSet);
    return {
      label: CHOICE_LABELS[optionIndex] ?? `${optionIndex + 1}`,
      edgeId: edge.id,
      toNodeId,
      isCorrect: matchingTerminalNodeIds.length > 0,
      pathEdgeIds: parentOptionEdges.includes(edge) ? [edge.id] : [continuationEdge.id, edge.id],
      correctTerminalNodeIds: matchingTerminalNodeIds
    };
  });

  return {
    decision: {
      index: decisionIndex,
      nodeId: node.id,
      nodeRas: node.ras,
      routeEdgeId: correctEdgeId,
      options
    },
    skipNodeIds: [collapse.childNodeId]
  };
}

function buildCollapsedRightLowerLobeDecision({
  indexes,
  node,
  childEdges,
  routeEdgeId,
  nextRouteEdgeId,
  decisionIndex,
  correctTerminalSet
}: {
  indexes: CaseIndexes;
  node: AirwayNode;
  childEdges: AirwayEdge[];
  routeEdgeId: number;
  nextRouteEdgeId: number | null;
  decisionIndex: number;
  correctTerminalSet: Set<number>;
}): CollapsedDecision | null {
  const rmlEdge = childEdges.find((edge) => labelMatches(edge, ["RML bronchus origin", "RML bronchus", "RML"]));
  const rllOriginEdge = childEdges.find((edge) => labelMatches(edge, ["RLL bronchus origin", "RLL bronchus", "RLL"]));
  if (!rmlEdge || !rllOriginEdge) {
    return null;
  }

  const rllSplitNodeId = childNodeForEdge(rllOriginEdge, node.id, indexes);
  const rllChildEdges = indexes.childEdgesByNode.get(rllSplitNodeId) ?? [];
  const b6Edge = rllChildEdges.find((edge) => labelMatches(edge, ["RB6", "RLL_B6", "B6"]));
  const basalEdge = rllChildEdges.find((edge) => labelIncludes(edge, ["RLL basal trunk", "RLL_BASAL", "basal trunk"]));
  if (!b6Edge || !basalEdge) {
    return null;
  }

  const optionEdges = [rmlEdge, b6Edge, basalEdge];
  const pathByEdgeId = new Map<number, number[]>([
    [rmlEdge.id, [rmlEdge.id]],
    [b6Edge.id, [rllOriginEdge.id, b6Edge.id]],
    [basalEdge.id, [rllOriginEdge.id, basalEdge.id]]
  ]);
  const correctEdgeId = routeEdgeId === rllOriginEdge.id && nextRouteEdgeId != null ? nextRouteEdgeId : routeEdgeId;
  const options: BranchOption[] = optionEdges.map((edge, optionIndex) => {
    const fromNodeId = edge === rmlEdge ? node.id : rllSplitNodeId;
    const toNodeId = childNodeForEdge(edge, fromNodeId, indexes);
    const matchingTerminalNodeIds = matchingCorrectTerminalNodeIds(toNodeId, indexes, correctTerminalSet);
    return {
      label: CHOICE_LABELS[optionIndex] ?? `${optionIndex + 1}`,
      edgeId: edge.id,
      toNodeId,
      isCorrect: matchingTerminalNodeIds.length > 0,
      pathEdgeIds: pathByEdgeId.get(edge.id),
      correctTerminalNodeIds: matchingTerminalNodeIds
    };
  });

  return {
    decision: {
      index: decisionIndex,
      nodeId: node.id,
      nodeRas: node.ras,
      routeEdgeId: correctEdgeId,
      options
    },
    skipNodeIds: [rllSplitNodeId]
  };
}

function labelMatches(edge: AirwayEdge, labels: string[]): boolean {
  const normalized = normalizeLabel(topCandidateLabel(edge) ?? anatomyEdgeLabel(edge));
  return labels.some((label) => normalized === normalizeLabel(label));
}

function labelIncludes(edge: AirwayEdge, fragments: string[]): boolean {
  const normalized = normalizeLabel(topCandidateLabel(edge) ?? anatomyEdgeLabel(edge));
  return fragments.some((fragment) => normalized.includes(normalizeLabel(fragment)));
}

function isNonVisibleTerminalDecision(childEdges: AirwayEdge[], parentNodeId: number, indexes: CaseIndexes): boolean {
  return childEdges.every((edge) => {
    const childNodeId = childNodeForEdge(edge, parentNodeId, indexes);
    const childNode = indexes.nodesById.get(childNodeId);
    return (
      childNode?.kind === "terminal" &&
      (edge.meanRadiusMm ?? Number.POSITIVE_INFINITY) < NON_VISIBLE_TERMINAL_MEAN_RADIUS_MM &&
      edge.lengthMm < NON_VISIBLE_TERMINAL_LENGTH_MM
    );
  });
}

function topCandidateLabel(edge: AirwayEdge): string | null {
  return edge.candidateLabels?.[0]?.candidateLabel ?? null;
}

function anatomyEdgeLabel(edge: AirwayEdge): string | null {
  return edge.anatomy?.subsegment?.name ?? edge.anatomy?.segment?.name ?? edge.anatomy?.lobe?.name ?? null;
}

function normalizeLabel(label: string | null | undefined): string {
  return (label ?? "").toLowerCase().replace(/[_+\s-]+/g, "");
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

export function optionPathPoints(decision: Decision, option: BranchOption, indexes: CaseIndexes): Vec3[] {
  const edgeIds = option.pathEdgeIds?.length ? option.pathEdgeIds : [option.edgeId];
  const node = indexes.nodesById.get(decision.nodeId);
  if (!node) {
    return [];
  }
  const points: Vec3[] = [];
  let currentNodeId = decision.nodeId;
  edgeIds.forEach((edgeId) => {
    const edge = indexes.edgesById.get(edgeId);
    if (!edge) {
      return;
    }
    const nextNodeId = childNodeForEdge(edge, currentNodeId, indexes);
    const edgePoints = orientedEdgePoints(edge, currentNodeId, nextNodeId);
    if (!points.length) {
      points.push(...edgePoints);
    } else if (edgePoints.length) {
      points.push(...(samePoint(points[points.length - 1], edgePoints[0]) ? edgePoints.slice(1) : edgePoints));
    }
    currentNodeId = nextNodeId;
  });
  return points.length ? points : [node.ras];
}

function samePoint(a: Vec3, b: Vec3): boolean {
  return Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01 && Math.abs(a[2] - b[2]) < 0.01;
}

function distanceMm(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}
