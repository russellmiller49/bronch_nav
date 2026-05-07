export type Vec3 = [number, number, number];

export interface CtMetadata {
  raw: string;
  sizeXyz: [number, number, number];
  originalSizeXyz: [number, number, number];
  stride: number;
  spacingXyzMm: Vec3;
  originLps: Vec3;
  directionLps: number[];
  windowHu: [number, number];
}

export interface NoduleAssetMetadata {
  assetId: string;
  residualRaw: string;
  alphaRaw: string;
  residualRawType: "int16";
  alphaRawType: "uint8";
  sizeXyz: [number, number, number];
  spacingXyzMm: Vec3;
  centroidIndexXyz: Vec3;
  maxRadiusMm: number | null;
  mode: "residual";
}

export interface LoadedNoduleAsset {
  metadata: NoduleAssetMetadata;
  residual: Int16Array;
  alpha: Uint8Array;
}

export interface ScopeAdjustment {
  cameraBackMm: number;
  lookAheadMm: number;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  fovDeg: number;
  labelOffsets: Record<string, { x: number; y: number }>;
}

export type ScopeAdjustments = Record<string, ScopeAdjustment>;

export interface ScopeCalibrationPayload {
  schema: string;
  caseId?: string;
  exportedAt?: string;
  updatedAt?: string;
  adjustments: Record<string, Partial<ScopeAdjustment>>;
}

export interface AirwayNode {
  id: number;
  ras: Vec3;
  kind: "root" | "carina" | "bifurcation" | "terminal" | "internal" | string;
  degree: number;
  rootDistanceMm: number;
  parentNodeId: number | null;
  parentEdgeId: number | null;
  anatomy?: AirwayAnatomyLabel;
}

export interface AirwayEdge {
  id: number;
  cellId: number;
  startNode: number;
  endNode: number;
  lengthMm: number;
  meanRadiusMm: number | null;
  minRadiusMm: number | null;
  pointsRas: Vec3[];
  radiusMm?: number[];
  anatomy?: AirwayAnatomyLabel;
  candidateLabels?: AirwayCandidateLabel[];
}

export interface AirwayCandidateLabel {
  edgeId?: number;
  candidateLabel: string;
  candidateLevel: "segmental" | "subsegmental" | "sub_subsegmental" | "variant" | string;
  score: number;
  evidence?: Record<string, unknown>;
  explanation: string;
  warnings: string[];
  source: string;
}

export interface AirwayCandidatePayload {
  schema: "airway_labeling_candidate_results/v1" | string;
  source?: Record<string, unknown>;
  edges: Record<string, AirwayCandidateLabel[] | { candidateLabels?: AirwayCandidateLabel[]; candidates?: AirwayCandidateLabel[] }>;
}

export interface AirwayAnatomyClass {
  value: number;
  name: string;
  confidence: number;
}

export interface AirwayAnatomyLabel {
  sampleCount: number;
  validSampleCount: number;
  coverage: number;
  confidence: number;
  lobe?: AirwayAnatomyClass;
  segment?: AirwayAnatomyClass;
  subsegment?: AirwayAnatomyClass;
}

export interface WebCase {
  schema: string;
  caseId: string;
  educationOnly: boolean;
  notForClinicalUse: boolean;
  ct: CtMetadata;
  airway: {
    rootNodeId: number;
    carinaNodeId: number | null;
    terminalNodeIds: number[];
    bifurcationNodeIds: number[];
    nodes: AirwayNode[];
    edges: AirwayEdge[];
    anatomySource?: Record<string, unknown>;
    candidateSource?: Record<string, unknown>;
    candidatesJson?: string;
  };
  initial: {
    targetRas: Vec3;
    snappedTerminalNodeId: number;
    snappedTerminalRas: Vec3;
    sourceRouteJson: string;
    sourceCt: string;
  };
  noduleAsset?: NoduleAssetMetadata;
  scopeCalibrationJson?: string;
  scopeCalibration?: ScopeCalibrationPayload;
}

export interface LoadedCase {
  metadata: WebCase;
  volume: Uint8Array;
  noduleAsset: LoadedNoduleAsset | null;
}

export interface BranchOption {
  label: string;
  edgeId: number;
  toNodeId: number;
  isCorrect: boolean;
  pathEdgeIds?: number[];
}

export interface Decision {
  index: number;
  nodeId: number;
  nodeRas: Vec3;
  routeEdgeId: number;
  options: BranchOption[];
}

export interface RouteState {
  terminalNodeId: number;
  nodePath: number[];
  edgePath: number[];
  routePoints: Vec3[];
  routeDistancesMm: number[];
  nodeDistancesMm: Record<number, number>;
  totalLengthMm: number;
  decisions: Decision[];
}
