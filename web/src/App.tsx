import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import type {
  AirwayAnatomyLabel,
  AirwayCandidateLabel,
  AirwayEdge,
  CtMetadata,
  Decision,
  LoadedCase,
  LoadedNoduleAsset,
  NoduleTarget,
  NoduleTargetLocation,
  RouteState,
  ScopeAdjustment,
  ScopeAdjustments,
  Vec3,
  WebCase
} from "./types";
import { loadCase } from "./caseLoader";
import { clamp, rasToIndex, type CtViewMode, type PlaneKind } from "./geometry";
import { buildRoute, childNodeForEdge, createIndexes, type CaseIndexes } from "./route";
import { buildAirwayFrame, CtPane, type CandidateOverlay, type TargetSurveyOverlay } from "./components/CtPane";
import {
  BronchoscopeView,
  DEFAULT_SCOPE_ADJUSTMENT,
  MAX_SCOPE_CAMERA_BACK_MM,
  MIN_SCOPE_CAMERA_BACK_MM,
  normalizeScopeAdjustment,
  scopeCameraBackLimitMm,
  type ScopeCameraPose
} from "./components/BronchoscopeView";
import { AirwayMap } from "./components/AirwayMap";
import { ENABLE_SCOPE_DEBUG } from "./runtimeFlags";

declare const __APP_BASE_PATH__: string;

type SliceOffsets = Record<PlaneKind, number>;
type SliceOffsetRanges = Record<PlaneKind, { min: number; max: number }>;
type TrainerMode = "setup" | "practice" | "test";

interface CentralAirwayFinding {
  targetIndex: number;
  targetNumber: number;
  location: NoduleTargetLocation;
  score: number;
  overlapMm: number;
  minRootDistanceMm: number;
  maxMeanRadiusMm: number;
  edgeIds: number[];
}

const ZERO_SLICE_OFFSETS: SliceOffsets = { axial: 0, coronal: 0, sagittal: 0 };
const AIRWAY_SLICE_OFFSET_RANGES: SliceOffsetRanges = {
  axial: { min: -8, max: 8 },
  coronal: { min: -8, max: 8 },
  sagittal: { min: -8, max: 8 }
};
const DEFAULT_SLICE_OFFSET_RANGES: SliceOffsetRanges = {
  axial: { min: -220, max: 220 },
  coronal: { min: -220, max: 220 },
  sagittal: { min: -220, max: 220 }
};
const SCOPE_CALIBRATION_SCHEMA = "bronchoedu_scope_calibration/v1";
const SCOPE_CALIBRATION_SOURCE_PATH = "scope_calibration.json";
const DRIVE_BRANCH_BACK_MM = 18;
const DRIVE_LOOK_AHEAD_MM = 34;
const DRIVE_SHORT_SEGMENT_BACK_FRACTION = 0.7;
const DRIVE_PARENT_CLEARANCE_MM = 3;
const DEFAULT_DRIVE_SPEED_MM_PER_SEC = 22;
const TARGET_PATH_RADIUS_MARGIN_MM = 8;
const MIN_TARGET_PATH_SELECTIONS = 5;
const NODULE_CONTACT_ALPHA_MIN = 64;
const NODULE_CONTACT_MIN_HITS = 2;
const NODULE_CONTACT_SAMPLE_MM = 1.5;
const ROUTE_CONTACT_DECISION_CLEARANCE_MM = 1;
const CENTRAL_AIRWAY_REVIEW_MAX_ROOT_DISTANCE_MM = 230;
const CENTRAL_AIRWAY_REVIEW_MIN_RADIUS_MM = 0.9;
const CENTRAL_AIRWAY_REVIEW_SAMPLE_MM = 1.25;
const CENTRAL_AIRWAY_REVIEW_MIN_OVERLAP_MM = 25;
const CENTRAL_AIRWAY_REVIEW_EXCLUDED_TARGET_NUMBERS = new Set([19, 123, 154, 158, 180]);
const CHOICE_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ENABLE_AUTHORING_TOOLS = ENABLE_SCOPE_DEBUG;
const SCOPE_CALIBRATION_WRITE_ENDPOINT = "/api/scope-calibration";
const MANUAL_TARGET_PATH_OVERRIDES = [
  { targetId: "advanced", targetIndex: 1, branchNodeId: 55, optionLabel: "A" },
  { targetId: "beginner", targetIndex: 1, branchNodeId: 255, optionLabel: "B" }
] as const;
const GENERATED_TARGET_LOCATION_OFFSETS = [
  { targetId: "beginner", targetIndex: 9, offsetRas: [2.6134, -5.1986, -10.495] },
  { targetId: "beginner", targetIndex: 18, offsetRas: [-4, -8, -2] }
] as const;
const GENERATED_TARGET_ENDPOINT_OVERRIDES = [
  { targetId: "beginner", targetIndex: 0, endpointNodeId: 91 },
  { targetId: "beginner", targetIndex: 62, endpointNodeId: 20 }
] as const;

export function App() {
  const [loadedCase, setLoadedCase] = useState<LoadedCase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null);
  const [targetLocationIndex, setTargetLocationIndex] = useState(0);
  const [selectedEndpointId, setSelectedEndpointId] = useState<number | null>(null);
  const [remainingCorrectTerminalIds, setRemainingCorrectTerminalIds] = useState<number[]>([]);
  const [committedPathEdgeIds, setCommittedPathEdgeIds] = useState<number[]>([]);
  const [currentDecisionIndex, setCurrentDecisionIndex] = useState(0);
  const [selectedEdgeId, setSelectedEdgeId] = useState<number | null>(null);
  const [showRoute, setShowRoute] = useState(false);
  const [showCandidateLabels, setShowCandidateLabels] = useState(true);
  const [ctViewMode, setCtViewMode] = useState<CtViewMode>("standard");
  const [sliceOffsets, setSliceOffsets] = useState<SliceOffsets>(ZERO_SLICE_OFFSETS);
  const [ctZoom, setCtZoom] = useState(1);
  const [scopeDebugMode, setScopeDebugMode] = useState(ENABLE_SCOPE_DEBUG);
  const [showScopeCompass, setShowScopeCompass] = useState(false);
  const [showScopeTrace, setShowScopeTrace] = useState(false);
  const [showScopeTumor, setShowScopeTumor] = useState(false);
  const [showCentralAirwayReview, setShowCentralAirwayReview] = useState(false);
  const [targetPlaced, setTargetPlaced] = useState(false);
  const [scopeAdjustments, setScopeAdjustments] = useState<ScopeAdjustments>({});
  const [calibrationStatus, setCalibrationStatus] = useState("");
  const [targetPlacementStatus, setTargetPlacementStatus] = useState("");
  const [mode, setMode] = useState<TrainerMode>("setup");
  const [driveDistanceMm, setDriveDistanceMm] = useState(0);
  const [driveRunning, setDriveRunning] = useState(false);
  const [debugFullPathPreview, setDebugFullPathPreview] = useState(false);
  const [driveSpeedMmPerSec, setDriveSpeedMmPerSec] = useState(DEFAULT_DRIVE_SPEED_MM_PER_SEC);
  const [testAttemptResults, setTestAttemptResults] = useState<Record<string, boolean>>({});
  const sourceSaveTimerRef = useRef<number | null>(null);
  const pendingTargetLocationIndexRef = useRef<number | null>(null);

  useEffect(() => {
    loadCase()
      .then((nextCase) => {
        const targets = noduleTargetsForCase(nextCase.metadata);
        const initialTarget = targets[0];
        setLoadedCase(nextCase);
        setActiveTargetId(initialTarget?.id ?? null);
        setSelectedEndpointId(initialTarget?.initialTerminalNodeId ?? nextCase.metadata.initial.snappedTerminalNodeId);
        setScopeAdjustments(parseScopeCalibration(nextCase.metadata.scopeCalibration));
      })
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : String(loadError)));
  }, []);

  const noduleTargets = useMemo(() => (loadedCase ? noduleTargetsForCase(loadedCase.metadata) : []), [loadedCase]);
  const activeTarget = useMemo(
    () => noduleTargets.find((target) => target.id === activeTargetId) ?? noduleTargets[0] ?? null,
    [activeTargetId, noduleTargets]
  );
  const activeNoduleAsset = activeTarget && loadedCase ? (loadedCase.noduleAssets[activeTarget.id] ?? loadedCase.noduleAsset) : (loadedCase?.noduleAsset ?? null);
  const indexes = useMemo(() => (loadedCase ? createIndexes(loadedCase.metadata) : null), [loadedCase]);
  const activeTargetLocations = useMemo(
    () => (activeTarget && indexes ? targetLocationsForTarget(activeTarget, indexes, activeNoduleAsset) : []),
    [activeTarget, indexes, activeNoduleAsset]
  );
  const beginnerTarget = useMemo(() => noduleTargets.find((target) => target.id === "beginner") ?? null, [noduleTargets]);
  const beginnerNoduleAsset = beginnerTarget && loadedCase ? (loadedCase.noduleAssets[beginnerTarget.id] ?? null) : null;
  const beginnerTargetLocations = useMemo(
    () =>
      beginnerTarget && indexes
        ? activeTarget?.id === beginnerTarget.id
          ? activeTargetLocations
          : targetLocationsForTarget(beginnerTarget, indexes, beginnerNoduleAsset)
        : [],
    [activeTarget?.id, activeTargetLocations, beginnerTarget, indexes, beginnerNoduleAsset]
  );
  const centralAirwayFindings = useMemo(
    () => (ENABLE_AUTHORING_TOOLS && indexes && beginnerNoduleAsset ? centralAirwayFindingsForTargets(beginnerTargetLocations, indexes, beginnerNoduleAsset) : []),
    [beginnerTargetLocations, indexes, beginnerNoduleAsset]
  );
  const activeCentralAirwayFindingIndex = useMemo(
    () => (ENABLE_AUTHORING_TOOLS && activeTarget?.id === "beginner" ? centralAirwayFindings.findIndex((finding) => finding.targetIndex === targetLocationIndex) : -1),
    [activeTarget?.id, centralAirwayFindings, targetLocationIndex]
  );
  const activeCentralAirwayFinding = activeCentralAirwayFindingIndex >= 0 ? centralAirwayFindings[activeCentralAirwayFindingIndex] : null;
  const activeTargetLocation = activeTargetLocations[Math.min(targetLocationIndex, Math.max(activeTargetLocations.length - 1, 0))] ?? null;
  const placedTargetLocation = targetPlaced ? activeTargetLocation : null;
  const activeTargetRasKey = placedTargetLocation?.targetRas.join(",") ?? "";
  const activeTargetCorrectTerminalIds = useMemo(
    () => activeTargetLocation?.correctTerminalNodeIds.filter((nodeId, index, nodeIds) => nodeIds.indexOf(nodeId) === index) ?? [],
    [activeTargetLocation]
  );
  const activePathTerminalIds = useMemo(() => {
    const narrowed = remainingCorrectTerminalIds.filter((nodeId) => activeTargetCorrectTerminalIds.includes(nodeId));
    return narrowed.length ? narrowed : activeTargetCorrectTerminalIds;
  }, [remainingCorrectTerminalIds, activeTargetCorrectTerminalIds]);
  const correctTerminalKey = activePathTerminalIds.join(",");
  const centerlineRoutes = useMemo(
    () =>
      indexes
        ? activePathTerminalIds.map((terminalNodeId) =>
            clipRouteToNoduleContact(buildRoute(terminalNodeId, indexes, activePathTerminalIds), placedTargetLocation?.targetRas ?? null, activeNoduleAsset)
          )
        : [],
    [indexes, activePathTerminalIds, correctTerminalKey, activeTargetRasKey, activeNoduleAsset]
  );
  const centerlineRoutePaths = useMemo(() => centerlineRoutes.map((candidateRoute) => candidateRoute.routePoints), [centerlineRoutes]);
  const route = useMemo<RouteState | null>(() => {
    if (!selectedEndpointId || !indexes) {
      return null;
    }
    return clipRouteToNoduleContact(buildRoute(selectedEndpointId, indexes, activePathTerminalIds), placedTargetLocation?.targetRas ?? null, activeNoduleAsset);
  }, [activePathTerminalIds, correctTerminalKey, selectedEndpointId, indexes, activeTargetRasKey, activeNoduleAsset]);

  const setupMode = mode === "setup";
  const practiceMode = mode === "practice";
  const testMode = mode === "test";
  const driveMode = practiceMode || testMode;
  const effectiveCtViewMode: CtViewMode = testMode ? "standard" : ctViewMode;
  const setupDebugEnabled = setupMode && ENABLE_SCOPE_DEBUG && scopeDebugMode;
  const debugFullPathActive = setupDebugEnabled && debugFullPathPreview;
  const currentDecision: Decision | null = route?.decisions[currentDecisionIndex] ?? null;
  const currentStopDistanceMm = route ? stopDistanceForDecision(route, currentDecision) : 0;
  const driveStopDistanceMm = route ? (debugFullPathActive ? route.totalLengthMm : currentStopDistanceMm) : 0;
  const atDecisionStop = Boolean(!debugFullPathActive && currentDecision && !driveRunning && driveDistanceMm >= currentStopDistanceMm - 0.75);
  const visibleDecision: Decision | null = !debugFullPathActive && atDecisionStop ? currentDecision : null;
  const driveRouteComplete = Boolean(!debugFullPathActive && route && !currentDecision && !driveRunning && driveDistanceMm >= route.totalLengthMm - 0.75);
  const drivePoseDecision = debugFullPathActive ? null : currentDecision;
  const drivePose = useMemo<ScopeCameraPose | null>(() => {
    if (!route) {
      return null;
    }
    return buildDrivePose(route, driveDistanceMm, drivePoseDecision);
  }, [route, driveDistanceMm, drivePoseDecision]);
  const driveMapBucket = Math.round(driveDistanceMm / 6);
  const mapDriveRas = useMemo<Vec3 | null>(() => (route ? pointAtRouteDistance(route, driveMapBucket * 6) : null), [route, driveMapBucket]);
  const scopeTracePath = useMemo<Vec3[]>(() => (route ? routePointsToDistance(route, driveDistanceMm) : []), [route, driveDistanceMm]);
  const noduleRas = placedTargetLocation?.targetRas ?? null;
  const airwaySurfaceMeshUrl = appAssetUrl("cases/default/airway_surface.stl");
  const visibleNoduleAsset = noduleRas ? activeNoduleAsset : null;
  const noduleMeshUrl = noduleRas ? noduleMeshUrlForAsset(activeNoduleAsset?.metadata.assetId ?? activeTarget?.noduleAsset.assetId ?? null) : null;
  const focusRas = drivePose?.cameraRas ?? visibleDecision?.nodeRas ?? noduleRas ?? loadedCase?.metadata.initial.targetRas;
  const selectedOption = visibleDecision?.options.find((option) => option.edgeId === selectedEdgeId) ?? null;
  const correctOptions = visibleDecision?.options.filter((option) => option.isCorrect) ?? [];
  const airwayFrame = useMemo(() => (route && focusRas ? buildAirwayFrame(route.routePoints, focusRas) : null), [route, focusRas]);
  const focusRouteDistanceMm = useMemo(() => (route && focusRas ? nearestRouteDistance(route, focusRas) : 0), [route, focusRas?.[0], focusRas?.[1], focusRas?.[2]]);
  const airwayAxialFrame = useMemo(() => {
    if (!route || !focusRas) {
      return null;
    }
    const axialDistanceMm = clamp(focusRouteDistanceMm + sliceOffsets.axial * 2, 0, route.totalLengthMm);
    return buildAirwayFrame(route.routePoints, pointAtRouteDistance(route, axialDistanceMm));
  }, [route, focusRas, focusRouteDistanceMm, sliceOffsets.axial]);
  const sliceOffsetRanges = useMemo(
    () => (loadedCase && focusRas ? sliceOffsetRangesForView(loadedCase.metadata.ct, focusRas, effectiveCtViewMode, route, focusRouteDistanceMm) : DEFAULT_SLICE_OFFSET_RANGES),
    [loadedCase, focusRas?.[0], focusRas?.[1], focusRas?.[2], effectiveCtViewMode, route, focusRouteDistanceMm]
  );
  const hasCandidateLabels = loadedCase?.metadata.airway.edges.some((edge) => edge.candidateLabels?.length) ?? false;
  const candidateOverlays = useMemo(
    () => (setupMode && ENABLE_AUTHORING_TOOLS && showCandidateLabels && visibleDecision ? buildCandidateOverlays(visibleDecision, indexes?.edgesById ?? new Map()) : []),
    [setupMode, showCandidateLabels, visibleDecision, indexes]
  );
  const targetSurveyOverlays = useMemo<TargetSurveyOverlay[]>(
    () =>
      setupMode && ENABLE_AUTHORING_TOOLS && showCentralAirwayReview && activeCentralAirwayFinding
        ? [
            {
              label: String(activeCentralAirwayFinding.targetNumber),
              ras: activeCentralAirwayFinding.location.targetRas,
              radiusMm: beginnerNoduleAsset?.metadata.maxRadiusMm ?? beginnerTarget?.noduleAsset.maxRadiusMm ?? null,
              active: true
            }
          ]
        : [],
    [setupMode, showCentralAirwayReview, activeCentralAirwayFinding, beginnerNoduleAsset, beginnerTarget]
  );

  useEffect(() => {
    if (!activeTarget) {
      return;
    }
    const pendingLocationIndex = pendingTargetLocationIndexRef.current;
    if (pendingLocationIndex != null) {
      pendingTargetLocationIndexRef.current = null;
      setTargetLocationIndex(pendingLocationIndex);
      setTargetPlaced(true);
      return;
    }
    setTargetLocationIndex(0);
    setTargetPlaced(false);
    setTargetPlacementStatus("");
  }, [activeTarget?.id]);

  useEffect(() => {
    if (targetLocationIndex < activeTargetLocations.length) {
      return;
    }
    setTargetLocationIndex(0);
    setTargetPlaced(false);
  }, [activeTargetLocations.length, targetLocationIndex]);

  useEffect(() => {
    if (!activeTargetLocation) {
      return;
    }
    setSelectedEndpointId(activeTargetLocation.initialTerminalNodeId);
    setRemainingCorrectTerminalIds(activeTargetLocation.correctTerminalNodeIds);
    setCommittedPathEdgeIds([]);
    setCurrentDecisionIndex(0);
    setSelectedEdgeId(null);
    setDriveDistanceMm(0);
    setDriveRunning(false);
    setDebugFullPathPreview(false);
    setSliceOffsets(ZERO_SLICE_OFFSETS);
  }, [activeTargetLocation?.id]);

  useEffect(() => {
    setSliceOffsets(ZERO_SLICE_OFFSETS);
  }, [currentDecisionIndex, effectiveCtViewMode]);

  useEffect(() => {
    setSliceOffsets((current) => clampSliceOffsets(current, sliceOffsetRanges));
  }, [sliceOffsetRanges]);

  useEffect(() => {
    if (!setupDebugEnabled) {
      setDebugFullPathPreview(false);
    }
  }, [setupDebugEnabled]);

  useEffect(() => {
    if (!route) {
      return;
    }
    setDriveDistanceMm((current) => clamp(current, 0, route.totalLengthMm));
  }, [route]);

  useEffect(() => {
    if (!setupMode || !route || debugFullPathPreview) {
      return;
    }
    const nextDecisionIndex = Math.min(currentDecisionIndex, Math.max(route.decisions.length - 1, 0));
    if (nextDecisionIndex !== currentDecisionIndex) {
      setCurrentDecisionIndex(nextDecisionIndex);
      return;
    }
    setDriveRunning(false);
    setDriveDistanceMm(stopDistanceForDecision(route, route.decisions[nextDecisionIndex] ?? null));
  }, [setupMode, route, currentDecisionIndex, debugFullPathPreview]);

  useEffect(() => {
    if (!driveRunning || !route) {
      return;
    }
    let frameId = 0;
    let lastTime = 0;
    const tick = (time: number) => {
      if (!lastTime) {
        lastTime = time;
      }
      const elapsedSeconds = Math.min(0.08, (time - lastTime) / 1000);
      lastTime = time;
      let reachedStop = false;
      setDriveDistanceMm((current) => {
        const next = Math.min(driveStopDistanceMm, current + driveSpeedMmPerSec * elapsedSeconds);
        reachedStop = next >= driveStopDistanceMm - 0.05;
        return reachedStop ? driveStopDistanceMm : next;
      });
      if (reachedStop) {
        setDriveRunning(false);
        return;
      }
      frameId = window.requestAnimationFrame(tick);
    };
    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [driveRunning, driveSpeedMmPerSec, driveStopDistanceMm, route]);

  useEffect(
    () => () => {
      if (sourceSaveTimerRef.current != null) {
        window.clearTimeout(sourceSaveTimerRef.current);
      }
    },
    []
  );

  if (error) {
    return (
      <main className="app app-centered">
        <div className="error-panel">{error}</div>
      </main>
    );
  }

  if (!loadedCase || !indexes || !route || !focusRas || !airwayFrame || !airwayAxialFrame) {
    return (
      <main className="app app-centered">
        <div className="loading-panel">Loading case</div>
      </main>
    );
  }

  const takenPathEdgeIds = driveRouteComplete ? route.edgePath : committedPathEdgeIds;
  const highlightEdges = buildHighlights(
    indexes.edgesById,
    visibleDecision,
    selectedEdgeId,
    selectedOption?.isCorrect ?? false,
    correctOptions.map((option) => option.edgeId),
    takenPathEdgeIds
  );
  const progressLabel = route.decisions.length ? `${Math.min(currentDecisionIndex + 1, route.decisions.length)} / ${route.decisions.length}` : "complete";
  const scopeAdjustmentKey = visibleDecision ? String(visibleDecision.nodeId) : "drive";
  const scopeAdjustment = visibleDecision ? normalizeScopeAdjustment(scopeAdjustments[scopeAdjustmentKey]) : DEFAULT_SCOPE_ADJUSTMENT;
  const scopeCameraBackMaxMm = visibleDecision ? Math.max(1, Math.floor(scopeCameraBackLimitMm(visibleDecision, indexes))) : MAX_SCOPE_CAMERA_BACK_MM;
  const scopeCameraBackMinMm = Math.min(MIN_SCOPE_CAMERA_BACK_MM, scopeCameraBackMaxMm);
  const visibleScopeAdjustment = visibleDecision
    ? {
        ...scopeAdjustment,
        cameraBackMm: clamp(scopeAdjustment.cameraBackMm, scopeCameraBackMinMm, scopeCameraBackMaxMm)
      }
    : scopeAdjustment;
  const driveTargetDistanceMm = Math.max(currentStopDistanceMm, 0);
  const driveProgressPercent = route.totalLengthMm > 0 ? Math.round((driveDistanceMm / route.totalLengthMm) * 100) : 0;
  const debugFullPathComplete = Boolean(debugFullPathActive && !driveRunning && driveDistanceMm >= route.totalLengthMm - 0.75);
  const scopeStatusLabel = debugFullPathActive
    ? debugFullPathComplete
      ? "Full path complete"
      : driveRunning
        ? "Full path preview"
        : "Full path paused"
    : visibleDecision
      ? `Decision ${visibleDecision.index + 1}`
      : driveRouteComplete
        ? "Complete"
        : driveRunning
          ? "Driving"
          : "Paused";
  const targetOrdinal = activeTargetLocation ? Math.min(targetLocationIndex + 1, activeTargetLocations.length) : 0;
  const targetCount = activeTargetLocations.length;
  const pathCount = activePathTerminalIds.length;
  const pathsNarrowed = pathCount > 0 && pathCount < activeTargetCorrectTerminalIds.length;
  const visibleDecisionKey = visibleDecision ? String(visibleDecision.nodeId) : "";
  const testChoiceLocked = Boolean(testMode && visibleDecisionKey && testAttemptResults[visibleDecisionKey] != null);
  const testAnswerResults = Object.values(testAttemptResults);
  const testAnsweredCount = testAnswerResults.length;
  const testCorrectCount = testAnswerResults.filter(Boolean).length;
  const testIncorrectCount = testAnsweredCount - testCorrectCount;
  const testScorePercent = testAnsweredCount > 0 ? Math.round((testCorrectCount / testAnsweredCount) * 100) : 0;
  const testScoreLabel = `${testCorrectCount}/${testAnsweredCount}`;

  const chooseOption = (edgeId: number) => {
    if (testChoiceLocked || (testMode && selectedEdgeId != null)) {
      return;
    }
    const option = visibleDecision?.options.find((candidate) => candidate.edgeId === edgeId);
    if (testMode && visibleDecision && option) {
      const decisionKey = String(visibleDecision.nodeId);
      setTestAttemptResults((current) => (current[decisionKey] == null ? { ...current, [decisionKey]: option.isCorrect } : current));
    }
    setDriveRunning(false);
    setSelectedEdgeId(edgeId);
  };

  const continueDrive = () => {
    if (selectedOption?.isCorrect) {
      const nextTerminals = uniqueNodeIds(selectedOption.correctTerminalNodeIds?.length ? selectedOption.correctTerminalNodeIds : activePathTerminalIds);
      const nextEndpointId = selectedEndpointId && nextTerminals.includes(selectedEndpointId) ? selectedEndpointId : nextTerminals[0];
      setRemainingCorrectTerminalIds(nextTerminals);
      if (nextEndpointId != null) {
        setSelectedEndpointId(nextEndpointId);
      }
      setCommittedPathEdgeIds((current) => uniqueNodeIds([...current, ...(selectedOption.pathEdgeIds?.length ? selectedOption.pathEdgeIds : [selectedOption.edgeId])]));
    }
    setSelectedEdgeId(null);
    setCurrentDecisionIndex((value) => Math.min(value + 1, route.decisions.length));
    setDriveRunning(true);
  };

  const resetPractice = () => {
    if (activeTargetLocation) {
      setSelectedEndpointId(activeTargetLocation.initialTerminalNodeId);
      setRemainingCorrectTerminalIds(activeTargetLocation.correctTerminalNodeIds);
    }
    setCommittedPathEdgeIds([]);
    setCurrentDecisionIndex(0);
    setSelectedEdgeId(null);
    setDriveDistanceMm(0);
    setDriveRunning(false);
    setDebugFullPathPreview(false);
    setSliceOffsets(ZERO_SLICE_OFFSETS);
    setTestAttemptResults({});
  };

  const enterMode = (nextMode: TrainerMode) => {
    setMode(nextMode);
    setSelectedEdgeId(null);
    setDriveRunning(false);
    setDebugFullPathPreview(false);

    if (nextMode === "setup") {
      const nextDecisionIndex = Math.min(currentDecisionIndex, Math.max(route.decisions.length - 1, 0));
      setCurrentDecisionIndex(nextDecisionIndex);
      setDriveDistanceMm(stopDistanceForDecision(route, route.decisions[nextDecisionIndex] ?? null));
      setScopeDebugMode(ENABLE_AUTHORING_TOOLS);
      return;
    }

    if (nextMode === "test") {
      setCtViewMode("standard");
      setShowRoute(false);
      setShowScopeTrace(false);
      setShowScopeCompass(false);
      setShowScopeTumor(false);
    }
    setShowRoute(false);
    setScopeDebugMode(false);
    resetPractice();
  };

  const wizardStep: 1 | 2 | 3 = setupMode ? 1 : practiceMode ? 2 : 3;
  const canAdvanceToPractice = targetPlaced;
  const goToStep = (step: 1 | 2 | 3) => {
    if ((step === 2 || step === 3) && !canAdvanceToPractice) {
      return;
    }
    enterMode(step === 1 ? "setup" : step === 2 ? "practice" : "test");
  };
  const wizardNext = () => goToStep(Math.min(wizardStep + 1, 3) as 1 | 2 | 3);
  const wizardBack = () => goToStep(Math.max(wizardStep - 1, 1) as 1 | 2 | 3);

  const nudgeDrive = (deltaMm: number) => {
    setDriveRunning(false);
    setDriveDistanceMm((current) => clamp(current + deltaMm, 0, driveTargetDistanceMm));
  };

  const toggleDrive = () => {
    if (driveRouteComplete || atDecisionStop) {
      return;
    }
    setDriveRunning((value) => !value);
  };

  const handleSliceScroll = (plane: PlaneKind, delta: number) => {
    const range = sliceOffsetRanges[plane];
    setSliceOffsets((current) => ({
      ...current,
      [plane]: Math.round(clamp(current[plane] + delta, range.min, range.max))
    }));
  };

  const setSliceOffset = (plane: PlaneKind, value: number) => {
    const range = sliceOffsetRanges[plane];
    setSliceOffsets((current) => ({
      ...current,
      [plane]: Math.round(clamp(value, range.min, range.max))
    }));
  };

  const resetSlices = () => {
    setSliceOffsets(ZERO_SLICE_OFFSETS);
  };

  const setZoom = (nextZoom: number) => {
    setCtZoom(clamp(Number(nextZoom.toFixed(2)), 1, 4));
  };

  const nudgeZoom = (delta: number) => {
    setCtZoom((value) => clamp(Number((value + delta).toFixed(2)), 1, 4));
  };

  const moveTarget = (delta: number) => {
    if (!activeTargetLocations.length) {
      return;
    }
    const nextIndex = (targetLocationIndex + delta + activeTargetLocations.length) % activeTargetLocations.length;
    setTargetLocationIndex(nextIndex);
    setTargetPlaced(true);
    setTargetPlacementStatus(`Target ${nextIndex + 1}`);
  };

  const resetTarget = () => {
    setTargetLocationIndex(0);
    setTargetPlaced(false);
    if (activeTargetLocation) {
      setSelectedEndpointId(activeTargetLocation.initialTerminalNodeId);
      setRemainingCorrectTerminalIds(activeTargetLocation.correctTerminalNodeIds);
    }
    setCommittedPathEdgeIds([]);
    setCurrentDecisionIndex(0);
    setSelectedEdgeId(null);
    setDriveDistanceMm(0);
    setDriveRunning(false);
    setDebugFullPathPreview(false);
    setSliceOffsets(ZERO_SLICE_OFFSETS);
    setTargetPlacementStatus("");
  };

  const surpriseTarget = () => {
    if (!activeTargetLocations.length) {
      return;
    }
    let nextIndex = Math.floor(Math.random() * activeTargetLocations.length);
    if (activeTargetLocations.length > 1 && nextIndex === targetLocationIndex) {
      nextIndex = (nextIndex + 1) % activeTargetLocations.length;
    }
    setTargetLocationIndex(nextIndex);
    setTargetPlaced(true);
    setTargetPlacementStatus(`Target ${nextIndex + 1}`);
  };

  const jumpToBeginnerTargetIndex = (nextIndex: number, status: string) => {
    if (!ENABLE_AUTHORING_TOOLS || !beginnerTarget || nextIndex < 0 || nextIndex >= beginnerTargetLocations.length) {
      return;
    }
    if (activeTarget?.id !== beginnerTarget.id) {
      pendingTargetLocationIndexRef.current = nextIndex;
    }
    setActiveTargetId(beginnerTarget.id);
    setTargetLocationIndex(nextIndex);
    setTargetPlaced(true);
    setTargetPlacementStatus(status);
    setShowCentralAirwayReview(true);
  };

  const toggleCentralAirwayReview = () => {
    if (!ENABLE_AUTHORING_TOOLS) {
      return;
    }
    if (showCentralAirwayReview) {
      setShowCentralAirwayReview(false);
      return;
    }
    const firstFinding = centralAirwayFindings[0];
    if (!firstFinding) {
      return;
    }
    jumpToBeginnerTargetIndex(firstFinding.targetIndex, `Central check: Target ${firstFinding.targetNumber}`);
  };

  const stepCentralAirwayFinding = (delta: number) => {
    if (!ENABLE_AUTHORING_TOOLS || !centralAirwayFindings.length) {
      return;
    }
    const currentIndex = activeCentralAirwayFindingIndex >= 0 ? activeCentralAirwayFindingIndex : delta > 0 ? -1 : 0;
    const nextFinding = centralAirwayFindings[(currentIndex + delta + centralAirwayFindings.length) % centralAirwayFindings.length];
    if (nextFinding) {
      jumpToBeginnerTargetIndex(nextFinding.targetIndex, `Central check: Target ${nextFinding.targetNumber}`);
    }
  };

  const snapTargetToRas = (ras: Vec3) => {
    const nextIndex = nearestTargetLocationIndex(activeTargetLocations, ras);
    if (nextIndex == null) {
      return;
    }
    setTargetLocationIndex(nextIndex);
    setTargetPlaced(true);
    setTargetPlacementStatus(`Snapped to Target ${nextIndex + 1}`);
  };

  const selectPathTerminal = (terminalNodeId: number) => {
    if (!activePathTerminalIds.includes(terminalNodeId)) {
      return;
    }
    setSelectedEndpointId(terminalNodeId);
    setCommittedPathEdgeIds([]);
    setCurrentDecisionIndex(0);
    setSelectedEdgeId(null);
    setDriveDistanceMm(0);
    setDriveRunning(false);
    setDebugFullPathPreview(false);
    setSliceOffsets(ZERO_SLICE_OFFSETS);
  };

  const startNoduleDrag = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-bronch-nodule", activeTarget?.id ?? "nodule");
  };

  const debugMoveDecision = (delta: number) => {
    setSelectedEdgeId(null);
    setDriveRunning(false);
    setDebugFullPathPreview(false);
    setCurrentDecisionIndex((value) => {
      const maxDecision = Math.max(route.decisions.length - 1, 0);
      const nextIndex = Math.round(clamp(value + delta, 0, maxDecision));
      setDriveDistanceMm(stopDistanceForDecision(route, route.decisions[nextIndex] ?? null));
      return nextIndex;
    });
  };

  const toggleDebugFullPathDrive = () => {
    setSelectedEdgeId(null);
    setShowRoute(true);
    setShowScopeTrace(true);
    if (!debugFullPathActive || debugFullPathComplete) {
      setDebugFullPathPreview(true);
      setDriveDistanceMm(0);
      setDriveRunning(true);
      return;
    }
    setDriveRunning((value) => !value);
  };

  const exitDebugFullPath = () => {
    setDebugFullPathPreview(false);
    setDriveRunning(false);
    setDriveDistanceMm(stopDistanceForDecision(route, currentDecision));
  };

  const seekDebugFullPath = (distanceMm: number) => {
    setSelectedEdgeId(null);
    setDebugFullPathPreview(true);
    setDriveRunning(false);
    setDriveDistanceMm(clamp(distanceMm, 0, route.totalLengthMm));
  };

  const nudgeDebugFullPath = (deltaMm: number) => {
    setSelectedEdgeId(null);
    setDebugFullPathPreview(true);
    setDriveRunning(false);
    setDriveDistanceMm((current) => clamp(current + deltaMm, 0, route.totalLengthMm));
  };

  const updateCurrentScopeAdjustment = (updater: (current: ScopeAdjustment) => ScopeAdjustment) => {
    if (!visibleDecision) {
      return;
    }
    const nextAdjustment = normalizeScopeAdjustment(updater(visibleScopeAdjustment));
    setScopeAdjustments((current) => {
      return {
        ...current,
        [scopeAdjustmentKey]: nextAdjustment
      };
    });
    queueScopeSourceSave(scopeAdjustmentKey, nextAdjustment);
  };

  const resetCurrentScopeAdjustment = () => {
    if (!visibleDecision) {
      return;
    }
    setScopeAdjustments((current) => {
      const next = { ...current };
      delete next[scopeAdjustmentKey];
      return next;
    });
    queueScopeSourceSave(scopeAdjustmentKey, null);
  };

  const queueScopeSourceSave = (nodeKey: string, adjustment: ScopeAdjustment | null) => {
    if (sourceSaveTimerRef.current != null) {
      window.clearTimeout(sourceSaveTimerRef.current);
    }
    setCalibrationStatus(`${adjustment ? "Saving" : "Removing"} Node ${nodeKey}...`);
    sourceSaveTimerRef.current = window.setTimeout(() => {
      sourceSaveTimerRef.current = null;
      void saveScopeAdjustmentToSource(loadedCase.metadata.caseId, nodeKey, adjustment)
        .then(() => {
          setCalibrationStatus(`${adjustment ? "Saved" : "Removed"} Node ${nodeKey} in ${SCOPE_CALIBRATION_SOURCE_PATH}.`);
        })
        .catch((saveError: unknown) => {
          const message = saveError instanceof Error ? saveError.message : String(saveError);
          setCalibrationStatus(`Local only: ${message}`);
        });
    }, 250);
  };

  const scopeFooter = driveMode ? (
    visibleDecision ? (
      <>
        <div className="scope-choice-row">
          {visibleDecision.options.map((option) => {
            const selected = selectedEdgeId === option.edgeId;
            const stateClass = selected ? (option.isCorrect ? "choice-correct" : "choice-wrong") : "";
            const lockedOutChoice = testMode && selectedEdgeId != null && selectedEdgeId !== option.edgeId;
            return (
              <button
                key={option.edgeId}
                className={`choice-button ${stateClass}`}
                onClick={() => chooseOption(option.edgeId)}
                disabled={lockedOutChoice}
                aria-label={`Select branch ${option.label}`}
              >
                <strong>{option.label}</strong>
              </button>
            );
          })}
        </div>
        <Feedback selectedEdgeId={selectedEdgeId} selectedOptionCorrect={selectedOption?.isCorrect ?? null} remainingPathCount={selectedOption?.correctTerminalNodeIds?.length ?? 0} testMode={testMode} />
        <button className="primary-action" disabled={selectedEdgeId == null} onClick={continueDrive}>
          Drive on
        </button>
      </>
    ) : driveRouteComplete ? (
      <>
        {testMode && <TestScoreSummary correctCount={testCorrectCount} incorrectCount={testIncorrectCount} answeredCount={testAnsweredCount} scorePercent={testScorePercent} scoreLabel={testScoreLabel} />}
        <RouteCompleteCelebration />
        <button className="primary-action" onClick={resetPractice}>
          {testMode ? "Restart test" : "Restart route"}
        </button>
      </>
    ) : (
      <>
        <div className="scope-progress" aria-hidden="true">
          <div className="scope-progress-fill" style={{ width: `${driveProgressPercent}%` }} />
        </div>
        <div className="scope-footer-primary">
          <div className="scope-footer-transport">
            <button className="icon-action" onClick={() => nudgeDrive(-8)} aria-label="Move scope backward">
              {"<"}
            </button>
            <button className="icon-action" onClick={() => nudgeDrive(8)} aria-label="Move scope forward" disabled={atDecisionStop}>
              {">"}
            </button>
          </div>
          <button className="primary-action" onClick={toggleDrive} disabled={atDecisionStop}>
            {driveRunning ? "Pause" : "Drive to branch"}
          </button>
        </div>
      </>
    )
  ) : null;

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand-block">
          <strong>Bronch Navigation Trainer</strong>
          <span>{loadedCase.metadata.caseId}</span>
        </div>
        <div className="wizard-stepper" role="group" aria-label="Trainer steps">
          {([
            { n: 1 as const, label: "Place target" },
            { n: 2 as const, label: "Practice" },
            { n: 3 as const, label: "Test" }
          ]).map((step) => {
            const locked = step.n > 1 && !canAdvanceToPractice;
            return (
              <button
                key={step.n}
                className={`wizard-step ${wizardStep === step.n ? "active" : ""} ${wizardStep > step.n ? "done" : ""}`}
                onClick={() => goToStep(step.n)}
                disabled={locked}
                aria-current={wizardStep === step.n ? "step" : undefined}
              >
                <span className="wizard-step-index">{step.n}</span>
                <span className="wizard-step-label">{step.label}</span>
              </button>
            );
          })}
        </div>
        <div className="wizard-nav">
          <button className="secondary-action" onClick={wizardBack} disabled={wizardStep === 1}>
            Back
          </button>
          <button
            className="primary-action"
            onClick={wizardNext}
            disabled={wizardStep === 3 || (wizardStep === 1 && !canAdvanceToPractice)}
            aria-label={wizardStep === 1 && !canAdvanceToPractice ? "Place a target first" : undefined}
          >
            Next
          </button>
        </div>
        {!testMode && (
          <label className="toggle">
            <input type="checkbox" checked={showRoute} onChange={(event) => setShowRoute(event.target.checked)} />
            <span>Centerline</span>
          </label>
        )}
        {setupMode && ENABLE_AUTHORING_TOOLS && (
          <label className={`toggle ${hasCandidateLabels ? "" : "toggle-disabled"}`}>
            <input
              type="checkbox"
              checked={showCandidateLabels && hasCandidateLabels}
              disabled={!hasCandidateLabels}
              onChange={(event) => setShowCandidateLabels(event.target.checked)}
            />
            <span>Candidates</span>
          </label>
        )}
        {!testMode && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={ctViewMode === "airway"}
              onChange={(event) => {
                setCtViewMode(event.target.checked ? "airway" : "standard");
                setSliceOffsets(ZERO_SLICE_OFFSETS);
              }}
            />
            <span>Airway CT</span>
          </label>
        )}
        {setupMode && ENABLE_SCOPE_DEBUG && (
          <label className="toggle">
            <input type="checkbox" checked={scopeDebugMode} onChange={(event) => setScopeDebugMode(event.target.checked)} />
            <span>Scope debug</span>
          </label>
        )}
        {!testMode && (
          <label className="toggle">
            <input type="checkbox" checked={showScopeCompass} onChange={(event) => setShowScopeCompass(event.target.checked)} />
            <span>Compass</span>
          </label>
        )}
        {!testMode && (
          <label className="toggle">
            <input type="checkbox" checked={showScopeTumor} onChange={(event) => setShowScopeTumor(event.target.checked)} />
            <span>Scope tumor</span>
          </label>
        )}
        {!testMode && (
          <label className="toggle">
            <input type="checkbox" checked={showScopeTrace} onChange={(event) => setShowScopeTrace(event.target.checked)} />
            <span>Scope trace</span>
          </label>
        )}
        <div className="case-status">
          <span>{setupMode ? "Mode" : testMode && driveRouteComplete ? "Score" : "Decision"}</span>
          <strong>{setupMode ? "Setup" : testMode && driveRouteComplete ? `${testScorePercent}%` : progressLabel}</strong>
        </div>
      </header>

      <aside className="trainer-panel">
        <div className="panel-section guide-section">
          <span className="section-label">{`Step ${wizardStep} of 3 — ${wizardStep === 1 ? "Place target" : wizardStep === 2 ? "Practice" : "Test"}`}</span>
          {setupMode ? (
            <ol className="instruction-list">
              <li>Click Surprise me to place a target automatically.</li>
              <li>Drag the nodule preview onto a CT pane to snap the target near that spot.</li>
              <li>Use Centerline, CT slice controls, and the airway map to confirm the route, then switch to Practice.</li>
            </ol>
          ) : testMode ? (
            <ol className="instruction-list">
              <li>Use the CT views and virtual bronchoscope only.</li>
              <li>Drive to each branch, then choose A, B, or C from the scope view.</li>
              <li>Your final score counts first-choice correct answers.</li>
            </ol>
          ) : (
            <ol className="instruction-list">
              <li>Press Drive to move the scope to the next branch point.</li>
              <li>Compare the A/B/C labels in the bronchoscope view with the branch choices, select one, then press Drive on.</li>
              <li>Scroll CT slices or switch Airway CT on when you need more orientation; the route ends when the lesion is reached.</li>
            </ol>
          )}
        </div>

        <div className="panel-section">
          <span className="section-label">Target</span>
          {setupMode && noduleTargets.length > 1 && (
            <div className="segmented target-selector">
              {noduleTargets.map((target) => (
                <button key={target.id} className={target.id === activeTarget?.id ? "active" : ""} onClick={() => setActiveTargetId(target.id)}>
                  {target.label.replace(" nodule", "")}
                </button>
              ))}
            </div>
          )}
          <h1>{activeTarget?.label ?? "Nodule target"}</h1>
          {testMode ? (
            <p>Helper overlays are hidden. Navigate from CT images and the virtual bronchoscope.</p>
          ) : (
            <p>
              {targetPlaced ? `Target ${targetOrdinal} of ${targetCount}. ` : "No nodule placed. "}
              {pathCount} accepted {pathCount === 1 ? "path" : "paths"}
              {pathsNarrowed ? " from this branch" : ""}.
            </p>
          )}
          {setupMode ? (
            <>
              <div className="nodule-picker">
                <NoduleThumbnail asset={activeNoduleAsset} label={activeTarget?.label ?? "Nodule"} onDragStart={startNoduleDrag} />
                <button className="secondary-action surprise-action" onClick={surpriseTarget} disabled={activeTargetLocations.length < 2}>
                  Surprise me
                </button>
              </div>
              <p className="placement-help">Drag the nodule preview onto any CT view to snap it to the nearest target location.</p>
              {ENABLE_AUTHORING_TOOLS && beginnerTarget && (
                <div className={`central-review-panel ${showCentralAirwayReview ? "central-review-panel-active" : ""}`}>
                  <button className="secondary-action wide central-review-trigger" onClick={toggleCentralAirwayReview} disabled={!centralAirwayFindings.length}>
                    {showCentralAirwayReview ? "Hide central check" : "Central airway check"}
                  </button>
                  <div className="decision-meta central-review-summary">
                    <span>
                      {centralAirwayFindings.length} flagged {centralAirwayFindings.length === 1 ? "target" : "targets"}
                    </span>
                    <span>{activeCentralAirwayFindingIndex >= 0 ? `${activeCentralAirwayFindingIndex + 1}/${centralAirwayFindings.length}` : "review queue"}</span>
                  </div>
                  {showCentralAirwayReview && centralAirwayFindings.length > 0 && (
                    <>
                      <div className="inline-actions central-review-actions">
                        <button className="secondary-action" onClick={() => stepCentralAirwayFinding(-1)}>
                          Prev flagged
                        </button>
                        <button className="secondary-action" onClick={() => stepCentralAirwayFinding(1)}>
                          Next flagged
                        </button>
                      </div>
                      <div className="central-review-list" aria-label="Beginner targets near central airways">
                        {centralAirwayFindings.map((finding) => (
                          <button
                            key={finding.location.id}
                            className={`central-review-item ${activeTarget?.id === "beginner" && finding.targetIndex === targetLocationIndex ? "central-review-item-active" : ""}`}
                            onClick={() => jumpToBeginnerTargetIndex(finding.targetIndex, `Central check: Target ${finding.targetNumber}`)}
                          >
                            <strong>Target {finding.targetNumber}</strong>
                            <span>
                              {finding.overlapMm.toFixed(1)} mm, R{Math.round(finding.minRootDistanceMm)}
                            </span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
              {targetPlacementStatus && <div className="target-snap-status">{targetPlacementStatus}</div>}
              <div className="path-list" aria-label="Accepted paths for this target">
                {activePathTerminalIds.map((nodeId, index) => (
                  <button key={nodeId} className={`path-pill ${nodeId === selectedEndpointId ? "path-pill-active" : ""}`} onClick={() => selectPathTerminal(nodeId)}>
                    Path {index + 1}
                  </button>
                ))}
              </div>
              <div className="inline-actions">
                <button className="secondary-action" onClick={() => moveTarget(-1)} disabled={activeTargetLocations.length < 2}>
                  Prev target
                </button>
                <button className="secondary-action" onClick={() => moveTarget(1)} disabled={activeTargetLocations.length < 2}>
                  Next target
                </button>
              </div>
              <button className="secondary-action wide" onClick={resetTarget}>
                Reset target
              </button>
            </>
          ) : (
            <button className="secondary-action wide" onClick={() => enterMode("setup")}>
              Adjust target
            </button>
          )}
        </div>

        <div className="panel-section">
          <span className="section-label">CT views</span>
          <div className="decision-meta">
            <span>{effectiveCtViewMode === "airway" ? "Airway aligned" : "Standard planes"}</span>
            <span>scroll slices</span>
          </div>
          <button className="secondary-action wide" onClick={resetSlices}>
            Recenter CT slices
          </button>
          <div className="zoom-row">
            <button className="icon-action" onClick={() => nudgeZoom(-0.25)} aria-label="Zoom out CT slices">
              -
            </button>
            <label className="range-control">
              <span>Zoom {ctZoom.toFixed(2)}x</span>
              <input type="range" min="1" max="4" step="0.25" value={ctZoom} onChange={(event) => setZoom(Number(event.target.value))} />
            </label>
            <button className="icon-action" onClick={() => nudgeZoom(0.25)} aria-label="Zoom in CT slices">
              +
            </button>
          </div>
        </div>

        {setupDebugEnabled && (
          <div className="panel-section debug-section">
            <span className="section-label">Scope debug</span>
            <div className="decision-meta">
              <span>{visibleDecision ? `Node ${visibleDecision.nodeId}` : "No active branch"}</span>
              <span>{SCOPE_CALIBRATION_SOURCE_PATH}</span>
            </div>
            <div className="debug-preview-control">
              <div className="decision-meta">
                <span>{debugFullPathActive ? (debugFullPathComplete ? "Full path complete" : "Full path preview") : "Full path preview"}</span>
                <span>
                  {Math.round(driveDistanceMm)} / {Math.round(route.totalLengthMm)} mm
                </span>
              </div>
              <div className="drive-controls">
                <button className="icon-action" onClick={() => nudgeDebugFullPath(-8)} disabled={!debugFullPathActive || driveDistanceMm <= 0} aria-label="Move full path preview backward">
                  {"<"}
                </button>
                <button className="secondary-action" onClick={toggleDebugFullPathDrive}>
                  {!debugFullPathActive ? "Drive full path" : driveRunning ? "Pause" : debugFullPathComplete ? "Replay" : "Resume"}
                </button>
                <button
                  className="icon-action"
                  onClick={() => nudgeDebugFullPath(8)}
                  disabled={!debugFullPathActive || driveDistanceMm >= route.totalLengthMm - 0.75}
                  aria-label="Move full path preview forward"
                >
                  {">"}
                </button>
              </div>
              <label className="range-control drive-range">
                <span>Preview position {Math.round(driveDistanceMm)} mm</span>
                <input
                  type="range"
                  min="0"
                  max={Math.max(1, Math.round(route.totalLengthMm))}
                  step="1"
                  value={Math.round(clamp(driveDistanceMm, 0, Math.max(1, route.totalLengthMm)))}
                  onChange={(event) => seekDebugFullPath(Number(event.target.value))}
                />
              </label>
              {debugFullPathActive && (
                <button className="secondary-action wide" onClick={exitDebugFullPath}>
                  Return to branch view
                </button>
              )}
            </div>
            {!debugFullPathActive && (
              <>
                <div className="inline-actions">
                  <button className="secondary-action" onClick={() => debugMoveDecision(-1)}>
                    Prev view
                  </button>
                  <button className="secondary-action" onClick={() => debugMoveDecision(1)}>
                    Next view
                  </button>
                </div>
                <p className="debug-help">Drag A/B/C labels in the bronchoscope pane. Use these controls to advance/back up the camera and correct yaw, pitch, roll, and field of view for the current branch.</p>
                <DebugSlider
                  label="Back"
                  value={visibleScopeAdjustment.cameraBackMm}
                  min={scopeCameraBackMinMm}
                  max={scopeCameraBackMaxMm}
                  step={1}
                  suffix="mm"
                  onChange={(value) => updateCurrentScopeAdjustment((current) => ({ ...current, cameraBackMm: value }))}
                />
                <DebugSlider
                  label="Aim"
                  value={scopeAdjustment.lookAheadMm}
                  min={8}
                  max={80}
                  step={1}
                  suffix="mm"
                  onChange={(value) => updateCurrentScopeAdjustment((current) => ({ ...current, lookAheadMm: value }))}
                />
                <DebugSlider
                  label="Yaw"
                  value={scopeAdjustment.yawDeg}
                  min={-80}
                  max={80}
                  step={1}
                  suffix="deg"
                  onChange={(value) => updateCurrentScopeAdjustment((current) => ({ ...current, yawDeg: value }))}
                />
                <DebugSlider
                  label="Pitch"
                  value={scopeAdjustment.pitchDeg}
                  min={-80}
                  max={80}
                  step={1}
                  suffix="deg"
                  onChange={(value) => updateCurrentScopeAdjustment((current) => ({ ...current, pitchDeg: value }))}
                />
                <DebugSlider
                  label="Roll"
                  value={scopeAdjustment.rollDeg}
                  min={-180}
                  max={180}
                  step={1}
                  suffix="deg"
                  onChange={(value) => updateCurrentScopeAdjustment((current) => ({ ...current, rollDeg: value }))}
                />
                <DebugSlider
                  label="FOV"
                  value={scopeAdjustment.fovDeg}
                  min={42}
                  max={118}
                  step={1}
                  suffix="deg"
                  onChange={(value) => updateCurrentScopeAdjustment((current) => ({ ...current, fovDeg: value }))}
                />
                <button className="secondary-action wide" onClick={resetCurrentScopeAdjustment}>
                  Reset this scope view
                </button>
              </>
            )}
            {calibrationStatus && <div className="debug-status">{calibrationStatus}</div>}
          </div>
        )}

        {!testMode && (
          <div className="panel-section compact-stats">
            <div>
              <span>Route edges</span>
              <strong>{route.edgePath.length}</strong>
            </div>
            <div>
              <span>Terminals</span>
              <strong>{loadedCase.metadata.airway.terminalNodeIds.length}</strong>
            </div>
          </div>
        )}
      </aside>

      <section className={`workspace ${testMode ? "workspace-test" : ""}`}>
        <div className="ct-grid">
          <CtPane
            plane="axial"
            viewMode={effectiveCtViewMode}
            ct={loadedCase.metadata.ct}
            volume={loadedCase.volume}
            focusRas={focusRas}
            noduleRas={noduleRas}
            noduleAsset={visibleNoduleAsset}
            routePaths={centerlineRoutePaths}
            scopeTracePath={scopeTracePath}
            airwayFrame={effectiveCtViewMode === "airway" ? airwayAxialFrame : airwayFrame}
            sliceOffset={sliceOffsets.axial}
            sliceOffsetMin={sliceOffsetRanges.axial.min}
            sliceOffsetMax={sliceOffsetRanges.axial.max}
            airwaySliceDistanceScale={effectiveCtViewMode === "airway" ? 0 : 2}
            showRoute={!testMode && showRoute}
            showScopeTrace={!testMode && showScopeTrace}
            highlightEdges={testMode ? [] : highlightEdges}
            candidateOverlays={testMode ? [] : candidateOverlays}
            targetSurveyOverlays={testMode ? [] : targetSurveyOverlays}
            zoom={ctZoom}
            onSliceScroll={handleSliceScroll}
            onSliceOffsetChange={setSliceOffset}
            onZoomChange={nudgeZoom}
            onTargetDrop={setupMode ? snapTargetToRas : undefined}
          />
          <CtPane
            plane="coronal"
            viewMode={effectiveCtViewMode}
            ct={loadedCase.metadata.ct}
            volume={loadedCase.volume}
            focusRas={focusRas}
            noduleRas={noduleRas}
            noduleAsset={visibleNoduleAsset}
            routePaths={centerlineRoutePaths}
            scopeTracePath={scopeTracePath}
            airwayFrame={airwayFrame}
            sliceOffset={sliceOffsets.coronal}
            sliceOffsetMin={sliceOffsetRanges.coronal.min}
            sliceOffsetMax={sliceOffsetRanges.coronal.max}
            showRoute={!testMode && showRoute}
            showScopeTrace={!testMode && showScopeTrace}
            highlightEdges={testMode ? [] : highlightEdges}
            candidateOverlays={testMode ? [] : candidateOverlays}
            targetSurveyOverlays={testMode ? [] : targetSurveyOverlays}
            zoom={ctZoom}
            onSliceScroll={handleSliceScroll}
            onSliceOffsetChange={setSliceOffset}
            onZoomChange={nudgeZoom}
            onTargetDrop={setupMode ? snapTargetToRas : undefined}
          />
          <CtPane
            plane="sagittal"
            viewMode={effectiveCtViewMode}
            ct={loadedCase.metadata.ct}
            volume={loadedCase.volume}
            focusRas={focusRas}
            noduleRas={noduleRas}
            noduleAsset={visibleNoduleAsset}
            routePaths={centerlineRoutePaths}
            scopeTracePath={scopeTracePath}
            airwayFrame={airwayFrame}
            sliceOffset={sliceOffsets.sagittal}
            sliceOffsetMin={sliceOffsetRanges.sagittal.min}
            sliceOffsetMax={sliceOffsetRanges.sagittal.max}
            showRoute={!testMode && showRoute}
            showScopeTrace={!testMode && showScopeTrace}
            highlightEdges={testMode ? [] : highlightEdges}
            candidateOverlays={testMode ? [] : candidateOverlays}
            targetSurveyOverlays={testMode ? [] : targetSurveyOverlays}
            zoom={ctZoom}
            onSliceScroll={handleSliceScroll}
            onSliceOffsetChange={setSliceOffset}
            onZoomChange={nudgeZoom}
            onTargetDrop={setupMode ? snapTargetToRas : undefined}
          />
        </div>
        <div className={`right-stack ${testMode ? "right-stack-test" : ""}`}>
          <BronchoscopeView
            decision={visibleDecision}
            indexes={indexes}
            selectedEdgeId={selectedEdgeId}
            drivePose={drivePose}
            meshUrl={airwaySurfaceMeshUrl}
            applyDriveAdjustment={Boolean(visibleDecision)}
            showDecisionLabels={Boolean(visibleDecision)}
            showCompass={!testMode && showScopeCompass}
            showTumor={!testMode && showScopeTumor}
            noduleRas={noduleRas}
            noduleMeshUrl={noduleMeshUrl}
            statusLabel={scopeStatusLabel}
            debugMode={setupDebugEnabled}
            adjustment={visibleScopeAdjustment}
            onAdjustmentChange={setupDebugEnabled ? (nextAdjustment) => updateCurrentScopeAdjustment(() => nextAdjustment) : undefined}
            onOptionSelect={visibleDecision ? chooseOption : undefined}
            footer={scopeFooter}
          />
          {!testMode && (
            <AirwayMap
              webCase={loadedCase.metadata}
              indexes={indexes}
              route={route}
              decision={visibleDecision}
              candidateOverlays={candidateOverlays}
              selectedEndpointId={selectedEndpointId ?? loadedCase.metadata.initial.snappedTerminalNodeId}
              selectableEndpointIds={activePathTerminalIds}
              noduleRas={noduleRas}
              noduleRadiusMm={visibleNoduleAsset?.metadata.maxRadiusMm ?? null}
              meshUrl={airwaySurfaceMeshUrl}
              noduleMeshUrl={noduleMeshUrl}
              selectedEdgeId={selectedEdgeId}
              committedEdgeIds={takenPathEdgeIds}
              driveRas={mapDriveRas}
            />
          )}
        </div>
      </section>
    </main>
  );
}

function noduleTargetsForCase(webCase: WebCase): NoduleTarget[] {
  if (webCase.noduleTargets?.length) {
    return webCase.noduleTargets.map((target) => ({
      ...target,
      correctTerminalNodeIds: uniqueNodeIds(target.correctTerminalNodeIds.length ? target.correctTerminalNodeIds : [target.initialTerminalNodeId])
    }));
  }
  return webCase.noduleAsset
    ? [
        {
          id: "advanced",
          label: "Advanced nodule",
          targetRas: webCase.initial.targetRas,
          initialTerminalNodeId: webCase.initial.snappedTerminalNodeId,
          correctTerminalNodeIds: [webCase.initial.snappedTerminalNodeId],
          noduleAsset: webCase.noduleAsset
        }
      ]
    : [];
}

function noduleMeshUrlForAsset(assetId: string | null): string | null {
  if (assetId === "beginner_102266_tumor") {
    return appAssetUrl("cases/default/beginner_nodule.stl");
  }
  if (assetId === "lung_nodule_1") {
    return appAssetUrl("cases/default/advanced_nodule.stl");
  }
  return null;
}

function appAssetUrl(path: string) {
  return new URL(path, new URL(__APP_BASE_PATH__, window.location.origin)).toString();
}

function sliceOffsetRangesForView(ct: CtMetadata, focusRas: Vec3, viewMode: CtViewMode, route: RouteState | null = null, focusRouteDistanceMm = 0): SliceOffsetRanges {
  if (viewMode === "airway") {
    const routeAxialMin = route ? Math.ceil(-focusRouteDistanceMm / 2) : AIRWAY_SLICE_OFFSET_RANGES.axial.min;
    const routeAxialMax = route ? Math.floor((route.totalLengthMm - focusRouteDistanceMm) / 2) : AIRWAY_SLICE_OFFSET_RANGES.axial.max;
    return {
      axial: {
        min: Math.max(AIRWAY_SLICE_OFFSET_RANGES.axial.min, routeAxialMin),
        max: Math.min(AIRWAY_SLICE_OFFSET_RANGES.axial.max, routeAxialMax)
      },
      coronal: AIRWAY_SLICE_OFFSET_RANGES.coronal,
      sagittal: AIRWAY_SLICE_OFFSET_RANGES.sagittal
    };
  }
  const focus = rasToIndex(focusRas, ct);
  return {
    axial: sliceOffsetRangeForIndex(focus.k, ct.sizeXyz[2]),
    coronal: sliceOffsetRangeForIndex(focus.j, ct.sizeXyz[1]),
    sagittal: sliceOffsetRangeForIndex(focus.i, ct.sizeXyz[0])
  };
}

function sliceOffsetRangeForIndex(index: number, size: number) {
  const center = Math.round(clamp(index, 0, Math.max(size - 1, 0)));
  return { min: -center, max: Math.max(size - 1 - center, 0) };
}

function clampSliceOffsets(offsets: SliceOffsets, ranges: SliceOffsetRanges): SliceOffsets {
  return {
    axial: Math.round(clamp(offsets.axial, ranges.axial.min, ranges.axial.max)),
    coronal: Math.round(clamp(offsets.coronal, ranges.coronal.min, ranges.coronal.max)),
    sagittal: Math.round(clamp(offsets.sagittal, ranges.sagittal.min, ranges.sagittal.max))
  };
}

function targetLocationsForTarget(target: NoduleTarget, indexes: CaseIndexes, noduleAsset: LoadedNoduleAsset | null): NoduleTargetLocation[] {
  if (target.locations?.length) {
    return removeShortPathTargets(
      target.locations.map((location, index) => ({
        ...location,
        id: location.id || `${target.id}-target-${index + 1}`,
        label: location.label || `Target ${index + 1}`,
        correctTerminalNodeIds: uniqueNodeIds(location.correctTerminalNodeIds.length ? location.correctTerminalNodeIds : [location.initialTerminalNodeId])
      })),
      indexes,
      noduleAsset
    );
  }

  const anchorNodeIds = orderedTerminalNodeIdsForTargets(indexes, target.initialTerminalNodeId);
  const baseNode = indexes.nodesById.get(target.initialTerminalNodeId);
  const anchorOffset: Vec3 = baseNode
    ? [target.targetRas[0] - baseNode.ras[0], target.targetRas[1] - baseNode.ras[1], target.targetRas[2] - baseNode.ras[2]]
    : [0, 0, 0];
  const radiusMm = target.noduleAsset.maxRadiusMm ?? 0;
  const useNearbyAcceptedPaths = target.correctTerminalNodeIds.length > 1;
  const routePointCache = new Map<number, Vec3[]>();

  const generatedLocations = (anchorNodeIds.length ? anchorNodeIds : [target.initialTerminalNodeId]).map((anchorNodeId, index) => {
    const anchorNode = indexes.nodesById.get(anchorNodeId);
    const generatedTargetRas: Vec3 = anchorNode
      ? [anchorNode.ras[0] + anchorOffset[0], anchorNode.ras[1] + anchorOffset[1], anchorNode.ras[2] + anchorOffset[2]]
      : target.targetRas;
    const targetRas = applyGeneratedTargetLocationOffset(target.id, index, generatedTargetRas);
    const endpointOverride = generatedTargetEndpointOverride(target.id, index);
    if (endpointOverride != null && indexes.nodesById.has(endpointOverride)) {
      return {
        id: `${target.id}-target-${index + 1}`,
        label: `Target ${index + 1}`,
        targetRas,
        initialTerminalNodeId: endpointOverride,
        correctTerminalNodeIds: [endpointOverride]
      };
    }
    const nearbyTerminalNodeIds = useNearbyAcceptedPaths ? terminalNodeIdsNearTarget(indexes, targetRas, radiusMm + TARGET_PATH_RADIUS_MARGIN_MM) : [];
    const contactTerminalNodeIds =
      useNearbyAcceptedPaths && noduleAsset
        ? terminalNodeIdsTouchingNodule(indexes, targetRas, uniqueNodeIds([anchorNodeId, ...nearbyTerminalNodeIds]), noduleAsset, routePointCache)
        : nearbyTerminalNodeIds;
    const manualTerminalNodeIds = manualTargetPathTerminalNodeIds(target.id, index, indexes);
    const correctTerminalNodeIds = uniqueNodeIds([...(contactTerminalNodeIds.length ? contactTerminalNodeIds : [anchorNodeId]), ...manualTerminalNodeIds]);
    const initialTerminalNodeId = correctTerminalNodeIds.includes(anchorNodeId) ? anchorNodeId : (correctTerminalNodeIds[0] ?? anchorNodeId);
    return {
      id: `${target.id}-target-${index + 1}`,
      label: `Target ${index + 1}`,
      targetRas,
      initialTerminalNodeId,
      correctTerminalNodeIds
    };
  });

  return removeShortPathTargets(generatedLocations, indexes, noduleAsset);
}

function removeShortPathTargets(locations: NoduleTargetLocation[], indexes: CaseIndexes, noduleAsset: LoadedNoduleAsset | null): NoduleTargetLocation[] {
  return locations.filter((location) => {
    const terminalNodeIds = uniqueNodeIds(location.correctTerminalNodeIds.length ? location.correctTerminalNodeIds : [location.initialTerminalNodeId]);
    return terminalNodeIds.length > 0 && terminalNodeIds.every((terminalNodeId) => pathSelectionCountForTargetLocation(location, terminalNodeId, terminalNodeIds, indexes, noduleAsset) >= MIN_TARGET_PATH_SELECTIONS);
  });
}

function pathSelectionCountForTargetLocation(
  location: NoduleTargetLocation,
  terminalNodeId: number,
  correctTerminalNodeIds: number[],
  indexes: CaseIndexes,
  noduleAsset: LoadedNoduleAsset | null
): number {
  return clipRouteToNoduleContact(buildRoute(terminalNodeId, indexes, correctTerminalNodeIds), location.targetRas, noduleAsset).decisions.length;
}

function applyGeneratedTargetLocationOffset(targetId: string, targetIndex: number, targetRas: Vec3): Vec3 {
  const override = GENERATED_TARGET_LOCATION_OFFSETS.find((item) => item.targetId === targetId && item.targetIndex === targetIndex);
  return override ? [targetRas[0] + override.offsetRas[0], targetRas[1] + override.offsetRas[1], targetRas[2] + override.offsetRas[2]] : targetRas;
}

function generatedTargetEndpointOverride(targetId: string, targetIndex: number): number | null {
  return GENERATED_TARGET_ENDPOINT_OVERRIDES.find((item) => item.targetId === targetId && item.targetIndex === targetIndex)?.endpointNodeId ?? null;
}

function orderedTerminalNodeIdsForTargets(indexes: CaseIndexes, preferredInitialNodeId: number): number[] {
  const terminalNodes = Array.from(indexes.nodesById.values()).filter((node) => node.kind === "terminal");
  const remaining = new Map(terminalNodes.map((node) => [node.id, node]));
  const ordered: number[] = [];
  const initialNode = remaining.get(preferredInitialNodeId) ?? terminalNodes[0];
  if (initialNode) {
    ordered.push(initialNode.id);
    remaining.delete(initialNode.id);
  }

  while (remaining.size) {
    let bestNodeId: number | null = null;
    let bestDistance = -1;
    remaining.forEach((node, nodeId) => {
      const nearestChosenDistance = Math.min(
        ...ordered.map((chosenNodeId) => {
          const chosenNode = indexes.nodesById.get(chosenNodeId);
          return chosenNode ? distanceBetween(node.ras, chosenNode.ras) : 0;
        })
      );
      if (nearestChosenDistance > bestDistance || (nearestChosenDistance === bestDistance && (bestNodeId == null || nodeId < bestNodeId))) {
        bestDistance = nearestChosenDistance;
        bestNodeId = nodeId;
      }
    });
    if (bestNodeId == null) {
      break;
    }
    ordered.push(bestNodeId);
    remaining.delete(bestNodeId);
  }

  return ordered;
}

function terminalNodeIdsNearTarget(indexes: CaseIndexes, targetRas: Vec3, radiusMm: number): number[] {
  const terminalNodeIds: { nodeId: number; distanceMm: number }[] = [];
  indexes.nodesById.forEach((node) => {
    if (node.kind !== "terminal") {
      return;
    }
    const distanceMm = distanceBetween(node.ras, targetRas);
    if (distanceMm <= radiusMm) {
      terminalNodeIds.push({ nodeId: node.id, distanceMm });
    }
  });
  return terminalNodeIds.sort((a, b) => a.distanceMm - b.distanceMm).map((item) => item.nodeId);
}

function terminalNodeIdsTouchingNodule(
  indexes: CaseIndexes,
  targetRas: Vec3,
  candidateTerminalNodeIds: number[],
  noduleAsset: LoadedNoduleAsset,
  routePointCache: Map<number, Vec3[]>
): number[] {
  return candidateTerminalNodeIds.filter((terminalNodeId) => {
    const routePoints = routePointCache.get(terminalNodeId) ?? buildRoute(terminalNodeId, indexes, [terminalNodeId]).routePoints;
    routePointCache.set(terminalNodeId, routePoints);
    return routeTouchesNodule(routePoints, targetRas, noduleAsset);
  });
}

function centralAirwayFindingsForTargets(locations: NoduleTargetLocation[], indexes: CaseIndexes, noduleAsset: LoadedNoduleAsset): CentralAirwayFinding[] {
  const centralEdges = Array.from(indexes.edgesById.values()).flatMap((edge) => {
    const meanRadiusMm = edge.meanRadiusMm ?? 0;
    if (meanRadiusMm < CENTRAL_AIRWAY_REVIEW_MIN_RADIUS_MM || edge.pointsRas.length < 2) {
      return [];
    }
    const startNode = indexes.nodesById.get(edge.startNode);
    const endNode = indexes.nodesById.get(edge.endNode);
    if (!startNode || !endNode) {
      return [];
    }
    const rootMinMm = Math.min(startNode.rootDistanceMm, endNode.rootDistanceMm);
    if (rootMinMm > CENTRAL_AIRWAY_REVIEW_MAX_ROOT_DISTANCE_MM) {
      return [];
    }
    return [{ edge, rootMinMm, meanRadiusMm }];
  });

  return locations
    .flatMap((location, targetIndex) => {
      const targetNumber = targetIndex + 1;
      if (CENTRAL_AIRWAY_REVIEW_EXCLUDED_TARGET_NUMBERS.has(targetNumber)) {
        return [];
      }
      let overlapMm = 0;
      let minRootDistanceMm = Number.POSITIVE_INFINITY;
      let maxMeanRadiusMm = 0;
      const edgeIds: number[] = [];

      centralEdges.forEach(({ edge, rootMinMm, meanRadiusMm }) => {
        const edgeOverlapMm = centralAirwayOverlapMm(edge, noduleAsset, location.targetRas);
        if (edgeOverlapMm <= 0) {
          return;
        }
        overlapMm += edgeOverlapMm;
        minRootDistanceMm = Math.min(minRootDistanceMm, rootMinMm);
        maxMeanRadiusMm = Math.max(maxMeanRadiusMm, meanRadiusMm);
        edgeIds.push(edge.id);
      });

      if (overlapMm < CENTRAL_AIRWAY_REVIEW_MIN_OVERLAP_MM) {
        return [];
      }

      const centralityBonus = Math.max(0, CENTRAL_AIRWAY_REVIEW_MAX_ROOT_DISTANCE_MM - minRootDistanceMm) * 0.03;
      const radiusBonus = maxMeanRadiusMm * 1.5;
      return [
        {
          targetIndex,
          targetNumber,
          location,
          overlapMm,
          minRootDistanceMm,
          maxMeanRadiusMm,
          edgeIds,
          score: overlapMm + centralityBonus + radiusBonus
        }
      ];
    })
    .sort((a, b) => b.score - a.score || a.targetNumber - b.targetNumber);
}

function centralAirwayOverlapMm(edge: AirwayEdge, noduleAsset: LoadedNoduleAsset, targetRas: Vec3): number {
  let overlapMm = 0;
  for (let pointIndex = 1; pointIndex < edge.pointsRas.length; pointIndex += 1) {
    const prev = edge.pointsRas[pointIndex - 1];
    const next = edge.pointsRas[pointIndex];
    const segmentLengthMm = distanceBetween(prev, next);
    const sampleCount = Math.max(1, Math.ceil(segmentLengthMm / CENTRAL_AIRWAY_REVIEW_SAMPLE_MM));
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const t = (sampleIndex + 0.5) / sampleCount;
      const sample: Vec3 = [prev[0] + (next[0] - prev[0]) * t, prev[1] + (next[1] - prev[1]) * t, prev[2] + (next[2] - prev[2]) * t];
      if (sampleNoduleAlpha(noduleAsset, sample, targetRas) >= NODULE_CONTACT_ALPHA_MIN) {
        overlapMm += segmentLengthMm / sampleCount;
      }
    }
  }
  return overlapMm;
}

function manualTargetPathTerminalNodeIds(targetId: string, targetIndex: number, indexes: CaseIndexes): number[] {
  const terminalNodeIds: number[] = [];
  MANUAL_TARGET_PATH_OVERRIDES.forEach((override) => {
    if (override.targetId !== targetId || override.targetIndex !== targetIndex) {
      return;
    }
    const optionIndex = CHOICE_LABELS.indexOf(override.optionLabel);
    if (optionIndex < 0) {
      return;
    }
    const edge = (indexes.childEdgesByNode.get(override.branchNodeId) ?? [])[optionIndex];
    if (!edge) {
      return;
    }
    terminalNodeIds.push(...terminalDescendantNodeIds(childNodeForEdge(edge, override.branchNodeId, indexes), indexes));
  });
  return uniqueNodeIds(terminalNodeIds);
}

function terminalDescendantNodeIds(nodeId: number, indexes: CaseIndexes): number[] {
  const node = indexes.nodesById.get(nodeId);
  if (!node) {
    return [];
  }
  const childEdges = indexes.childEdgesByNode.get(nodeId) ?? [];
  if (node.kind === "terminal" || childEdges.length === 0) {
    return node.kind === "terminal" ? [node.id] : [];
  }
  return childEdges.flatMap((edge) => terminalDescendantNodeIds(childNodeForEdge(edge, nodeId, indexes), indexes));
}

function routeTouchesNodule(routePoints: Vec3[], targetRas: Vec3, noduleAsset: LoadedNoduleAsset): boolean {
  let hitCount = 0;
  for (let pointIndex = 1; pointIndex < routePoints.length; pointIndex += 1) {
    const prev = routePoints[pointIndex - 1];
    const next = routePoints[pointIndex];
    const segmentLengthMm = distanceBetween(prev, next);
    const sampleCount = Math.max(1, Math.ceil(segmentLengthMm / NODULE_CONTACT_SAMPLE_MM));
    for (let sampleIndex = 0; sampleIndex <= sampleCount; sampleIndex += 1) {
      const t = sampleIndex / sampleCount;
      const sample: Vec3 = [prev[0] + (next[0] - prev[0]) * t, prev[1] + (next[1] - prev[1]) * t, prev[2] + (next[2] - prev[2]) * t];
      if (sampleNoduleAlpha(noduleAsset, sample, targetRas) >= NODULE_CONTACT_ALPHA_MIN) {
        hitCount += 1;
        if (hitCount >= NODULE_CONTACT_MIN_HITS) {
          return true;
        }
      }
    }
  }
  return false;
}

function sampleNoduleAlpha(asset: LoadedNoduleAsset, ras: Vec3, targetRas: Vec3): number {
  const deltaRas: Vec3 = [ras[0] - targetRas[0], ras[1] - targetRas[1], ras[2] - targetRas[2]];
  const spacing = asset.metadata.spacingXyzMm;
  const center = asset.metadata.centroidIndexXyz;
  const i = center[0] - deltaRas[0] / spacing[0];
  const j = center[1] - deltaRas[1] / spacing[1];
  const k = center[2] + deltaRas[2] / spacing[2];
  const [sx, sy, sz] = asset.metadata.sizeXyz;
  if (i < 0 || j < 0 || k < 0 || i > sx - 1 || j > sy - 1 || k > sz - 1) {
    return 0;
  }
  return sampleUint8Nearest(asset.alpha, sx, sy, sz, i, j, k);
}

function sampleUint8Nearest(volume: Uint8Array, sx: number, sy: number, sz: number, i: number, j: number, k: number): number {
  const ii = Math.round(clamp(i, 0, sx - 1));
  const jj = Math.round(clamp(j, 0, sy - 1));
  const kk = Math.round(clamp(k, 0, sz - 1));
  return volume[kk * sx * sy + jj * sx + ii] ?? 0;
}

function clipRouteToNoduleContact(route: RouteState, targetRas: Vec3 | null, noduleAsset: LoadedNoduleAsset | null): RouteState {
  if (!targetRas || !noduleAsset) {
    return route;
  }
  const contact = firstNoduleContact(route, targetRas, noduleAsset);
  if (!contact || contact.distanceMm >= route.totalLengthMm - 0.05) {
    return route;
  }
  const { routePoints, routeDistancesMm } = routePointsUntilDistance(route, contact.distanceMm, contact.ras);
  const { edgePath, nodePath } = structuralPathUntilDistance(route, contact.distanceMm);
  const decisions = route.decisions
    .filter((decision) => {
      const decisionDistanceMm = route.nodeDistancesMm[decision.nodeId] ?? nearestRouteDistance(route, decision.nodeRas);
      return decisionDistanceMm < contact.distanceMm - ROUTE_CONTACT_DECISION_CLEARANCE_MM;
    })
    .map((decision, index) => ({ ...decision, index }));
  return {
    ...route,
    edgePath,
    nodePath,
    routePoints,
    routeDistancesMm,
    totalLengthMm: contact.distanceMm,
    decisions
  };
}

function firstNoduleContact(route: RouteState, targetRas: Vec3, noduleAsset: LoadedNoduleAsset): { distanceMm: number; ras: Vec3 } | null {
  if (!route.routePoints.length) {
    return null;
  }
  if (sampleNoduleAlpha(noduleAsset, route.routePoints[0], targetRas) >= NODULE_CONTACT_ALPHA_MIN) {
    return { distanceMm: 0, ras: route.routePoints[0] };
  }

  for (let pointIndex = 1; pointIndex < route.routePoints.length; pointIndex += 1) {
    const prev = route.routePoints[pointIndex - 1];
    const next = route.routePoints[pointIndex];
    const prevDistanceMm = route.routeDistancesMm[pointIndex - 1] ?? 0;
    const segmentLengthMm = distanceBetween(prev, next);
    const sampleCount = Math.max(1, Math.ceil(segmentLengthMm / NODULE_CONTACT_SAMPLE_MM));
    let lastClearT = 0;

    for (let sampleIndex = 1; sampleIndex <= sampleCount; sampleIndex += 1) {
      const t = sampleIndex / sampleCount;
      const sample = interpolateRas(prev, next, t);
      if (sampleNoduleAlpha(noduleAsset, sample, targetRas) < NODULE_CONTACT_ALPHA_MIN) {
        lastClearT = t;
        continue;
      }
      const contactT = refineNoduleContactT(prev, next, lastClearT, t, targetRas, noduleAsset);
      return {
        distanceMm: prevDistanceMm + segmentLengthMm * contactT,
        ras: interpolateRas(prev, next, contactT)
      };
    }
  }
  return null;
}

function refineNoduleContactT(prev: Vec3, next: Vec3, clearT: number, hitT: number, targetRas: Vec3, noduleAsset: LoadedNoduleAsset): number {
  let low = clearT;
  let high = hitT;
  for (let step = 0; step < 8; step += 1) {
    const mid = (low + high) * 0.5;
    const sample = interpolateRas(prev, next, mid);
    if (sampleNoduleAlpha(noduleAsset, sample, targetRas) >= NODULE_CONTACT_ALPHA_MIN) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return high;
}

function routePointsUntilDistance(route: RouteState, distanceMm: number, endRas: Vec3): { routePoints: Vec3[]; routeDistancesMm: number[] } {
  const routePoints: Vec3[] = [];
  const routeDistancesMm: number[] = [];
  route.routePoints.forEach((point, index) => {
    const pointDistanceMm = route.routeDistancesMm[index] ?? 0;
    if (pointDistanceMm < distanceMm - 0.01) {
      routePoints.push(point);
      routeDistancesMm.push(pointDistanceMm);
    }
  });

  const lastPoint = routePoints[routePoints.length - 1];
  if (!lastPoint || distanceBetween(lastPoint, endRas) > 0.01) {
    routePoints.push(endRas);
    routeDistancesMm.push(distanceMm);
  } else {
    routePoints[routePoints.length - 1] = endRas;
    routeDistancesMm[routeDistancesMm.length - 1] = distanceMm;
  }
  return { routePoints, routeDistancesMm };
}

function structuralPathUntilDistance(route: RouteState, distanceMm: number): { edgePath: number[]; nodePath: number[] } {
  const edgePath: number[] = [];
  const nodePath: number[] = [];
  route.edgePath.forEach((edgeId, edgeIndex) => {
    const startNodeId = route.nodePath[edgeIndex];
    const endNodeId = route.nodePath[edgeIndex + 1];
    if (startNodeId == null || endNodeId == null) {
      return;
    }
    const startDistanceMm = route.nodeDistancesMm[startNodeId] ?? 0;
    const endDistanceMm = route.nodeDistancesMm[endNodeId] ?? Number.POSITIVE_INFINITY;
    if (startDistanceMm > distanceMm + 0.01 || edgePath.length && startDistanceMm >= distanceMm - 0.01) {
      return;
    }
    if (!nodePath.length) {
      nodePath.push(startNodeId);
    }
    edgePath.push(edgeId);
    nodePath.push(endNodeId);
    if (endDistanceMm >= distanceMm - 0.01) {
      return;
    }
  });
  return { edgePath, nodePath: nodePath.length ? nodePath : route.nodePath.slice(0, 1) };
}

function interpolateRas(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function nearestTargetLocationIndex(locations: NoduleTargetLocation[], ras: Vec3): number | null {
  let bestIndex: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  locations.forEach((location, index) => {
    const distance = distanceBetween(location.targetRas, ras);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function uniqueNodeIds(nodeIds: number[]): number[] {
  return nodeIds.filter((nodeId, index) => Number.isFinite(nodeId) && nodeIds.indexOf(nodeId) === index);
}

function NoduleThumbnail({
  asset,
  label,
  onDragStart
}: {
  asset: LoadedNoduleAsset | null;
  label: string;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    drawNoduleThumbnail(canvas, asset);
  }, [asset]);

  return (
    <div className="nodule-thumbnail" draggable onDragStart={onDragStart} role="img" aria-label={`${label} preview`}>
      <canvas ref={canvasRef} width={88} height={88} />
      <span>{label.replace(" nodule", "")}</span>
    </div>
  );
}

function drawNoduleThumbnail(canvas: HTMLCanvasElement, asset: LoadedNoduleAsset | null) {
  const width = 88;
  const height = 88;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  const image = ctx.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      image.data[offset] = 9;
      image.data[offset + 1] = 14;
      image.data[offset + 2] = 18;
      image.data[offset + 3] = 255;
    }
  }

  if (asset) {
    const [sx, sy, sz] = asset.metadata.sizeXyz;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = Math.round((x / Math.max(width - 1, 1)) * (sx - 1));
        const j = Math.round((y / Math.max(height - 1, 1)) * (sy - 1));
        let bestAlpha = 0;
        let residualHu = 0;
        for (let k = 0; k < sz; k += 1) {
          const assetOffset = k * sx * sy + j * sx + i;
          const alpha = asset.alpha[assetOffset] ?? 0;
          if (alpha > bestAlpha) {
            bestAlpha = alpha;
            residualHu = asset.residual[assetOffset] ?? 0;
          }
        }
        if (bestAlpha > 0) {
          const offset = (y * width + x) * 4;
          const alpha = bestAlpha / 255;
          const density = clamp((residualHu + 900) / 1800, 0, 1);
          image.data[offset] = Math.round(130 + density * 110);
          image.data[offset + 1] = Math.round(54 + density * 78);
          image.data[offset + 2] = Math.round(66 + density * 58);
          image.data[offset + 3] = Math.round(80 + alpha * 175);
        }
      }
    }
  }

  ctx.putImageData(image, 0, 0);
  ctx.save();
  ctx.strokeStyle = "#41515d";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  ctx.restore();
}

function RouteCompleteCelebration() {
  return (
    <div className="done-state celebration-state" role="status" aria-live="polite">
      <div className="celebration-mark" aria-hidden="true">
        <span className="target-ring" />
        {Array.from({ length: 14 }, (_, index) => (
          <span key={index} className="confetti-piece" />
        ))}
      </div>
      <strong>Lesion reached</strong>
      <span>Route complete</span>
    </div>
  );
}

function TestScoreSummary({
  correctCount,
  incorrectCount,
  answeredCount,
  scorePercent,
  scoreLabel
}: {
  correctCount: number;
  incorrectCount: number;
  answeredCount: number;
  scorePercent: number;
  scoreLabel: string;
}) {
  return (
    <div className="test-score-summary" role="status" aria-live="polite">
      <span className="section-label">Test score</span>
      <strong>{scorePercent}%</strong>
      <span>
        {scoreLabel} first choices correct across {answeredCount} {answeredCount === 1 ? "branch" : "branches"}.
      </span>
      <div className="test-score-grid">
        <span>
          <strong>{correctCount}</strong>
          Correct
        </span>
        <span>
          <strong>{incorrectCount}</strong>
          Incorrect
        </span>
      </div>
    </div>
  );
}

function DebugSlider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  const handleInput = (event: FormEvent<HTMLInputElement>) => onChange(Number(event.currentTarget.value));
  return (
    <label className="debug-slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onInput={handleInput} onChange={handleInput} />
      <strong>
        {value}
        {suffix}
      </strong>
    </label>
  );
}

function parseScopeCalibration(value: unknown): ScopeAdjustments {
  if (!isRecord(value)) {
    return {};
  }
  const rawAdjustments = isRecord(value.adjustments) ? value.adjustments : value;
  return Object.fromEntries(
    Object.entries(rawAdjustments).flatMap(([key, rawAdjustment]) => {
      const adjustment = parseScopeAdjustment(rawAdjustment);
      return adjustment ? [[key, normalizeScopeAdjustment(adjustment)]] : [];
    })
  );
}

function parseScopeAdjustment(value: unknown): Partial<ScopeAdjustment> | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    cameraBackMm: finiteNumber(value.cameraBackMm),
    lookAheadMm: finiteNumber(value.lookAheadMm),
    yawDeg: finiteNumber(value.yawDeg),
    pitchDeg: finiteNumber(value.pitchDeg),
    rollDeg: finiteNumber(value.rollDeg),
    fovDeg: finiteNumber(value.fovDeg),
    labelOffsets: parseLabelOffsets(value.labelOffsets)
  };
}

function parseLabelOffsets(value: unknown): ScopeAdjustment["labelOffsets"] {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([label, offset]) => {
      if (!isRecord(offset)) {
        return [];
      }
      const x = finiteNumber(offset.x);
      const y = finiteNumber(offset.y);
      return x == null || y == null ? [] : [[label, { x, y }]];
    })
  );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function saveScopeAdjustmentToSource(caseId: string, nodeKey: string, adjustment: ScopeAdjustment | null) {
  const response = await fetch(SCOPE_CALIBRATION_WRITE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      schema: SCOPE_CALIBRATION_SCHEMA,
      caseId,
      nodeId: nodeKey,
      adjustment
    })
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `source save failed with ${response.status}`);
  }
}

function stopDistanceForDecision(route: RouteState, decision: Decision | null): number {
  if (!decision) {
    return route.totalLengthMm;
  }
  const nodeDistance = route.nodeDistancesMm[decision.nodeId] ?? nearestRouteDistance(route, decision.nodeRas);
  const previousDistance = previousRouteNodeDistance(route, decision);
  const availableIncomingMm = previousDistance == null ? DRIVE_BRANCH_BACK_MM : Math.max(0, nodeDistance - previousDistance);
  const backDistanceMm = safeIncomingBackDistance(DRIVE_BRANCH_BACK_MM, availableIncomingMm);
  return clamp(nodeDistance - backDistanceMm, 0, route.totalLengthMm);
}

function buildDrivePose(route: RouteState, distanceMm: number, decision: Decision | null): ScopeCameraPose {
  const cameraRas = pointAtRouteDistance(route, distanceMm);
  const decisionDistanceMm = decision ? (route.nodeDistancesMm[decision.nodeId] ?? nearestRouteDistance(route, decision.nodeRas)) : null;
  const targetDistanceMm =
    decisionDistanceMm == null ? distanceMm + DRIVE_LOOK_AHEAD_MM : Math.min(distanceMm + DRIVE_LOOK_AHEAD_MM, decisionDistanceMm);
  let targetRas = pointAtRouteDistance(route, targetDistanceMm);
  if (distanceBetween(cameraRas, targetRas) < 2) {
    targetRas = pointAtRouteDistance(route, distanceMm + DRIVE_LOOK_AHEAD_MM);
  }
  return { cameraRas, targetRas };
}

function pointAtRouteDistance(route: RouteState, distanceMm: number): Vec3 {
  if (!route.routePoints.length) {
    return [0, 0, 0];
  }
  const clampedDistance = clamp(distanceMm, 0, route.totalLengthMm);
  for (let index = 1; index < route.routePoints.length; index += 1) {
    const prevDistance = route.routeDistancesMm[index - 1] ?? 0;
    const nextDistance = route.routeDistancesMm[index] ?? prevDistance;
    if (nextDistance >= clampedDistance) {
      const prev = route.routePoints[index - 1];
      const next = route.routePoints[index];
      const t = (clampedDistance - prevDistance) / Math.max(nextDistance - prevDistance, 1e-6);
      return [prev[0] + (next[0] - prev[0]) * t, prev[1] + (next[1] - prev[1]) * t, prev[2] + (next[2] - prev[2]) * t];
    }
  }
  return route.routePoints[route.routePoints.length - 1];
}

function routePointsToDistance(route: RouteState, distanceMm: number): Vec3[] {
  if (!route.routePoints.length) {
    return [];
  }
  const clampedDistance = clamp(distanceMm, 0, route.totalLengthMm);
  const points: Vec3[] = [route.routePoints[0]];
  if (clampedDistance <= 0) {
    return points;
  }

  for (let index = 1; index < route.routePoints.length; index += 1) {
    const prevDistance = route.routeDistancesMm[index - 1] ?? 0;
    const nextDistance = route.routeDistancesMm[index] ?? prevDistance;
    const prev = route.routePoints[index - 1];
    const next = route.routePoints[index];
    if (nextDistance < clampedDistance) {
      points.push(next);
      continue;
    }
    const t = (clampedDistance - prevDistance) / Math.max(nextDistance - prevDistance, 1e-6);
    points.push([prev[0] + (next[0] - prev[0]) * t, prev[1] + (next[1] - prev[1]) * t, prev[2] + (next[2] - prev[2]) * t]);
    return points;
  }

  return route.routePoints;
}

function nearestRouteDistance(route: RouteState, ras: Vec3): number {
  let bestDistance = 0;
  let bestPointDistance = Number.POSITIVE_INFINITY;
  route.routePoints.forEach((point, index) => {
    const pointDistance = distanceBetween(point, ras);
    if (pointDistance < bestPointDistance) {
      bestPointDistance = pointDistance;
      bestDistance = route.routeDistancesMm[index] ?? 0;
    }
  });
  return bestDistance;
}

function distanceBetween(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function previousRouteNodeDistance(route: RouteState, decision: Decision): number | null {
  const nodeIndex = route.nodePath.indexOf(decision.nodeId);
  if (nodeIndex <= 0) {
    return null;
  }
  return route.nodeDistancesMm[route.nodePath[nodeIndex - 1]] ?? null;
}

function safeIncomingBackDistance(requestedBackMm: number, availableIncomingMm: number): number {
  if (!Number.isFinite(availableIncomingMm) || availableIncomingMm <= 0) {
    return requestedBackMm;
  }
  const shortSegmentBackMm = Math.max(availableIncomingMm * DRIVE_SHORT_SEGMENT_BACK_FRACTION, availableIncomingMm - DRIVE_PARENT_CLEARANCE_MM);
  return clamp(requestedBackMm, 0, Math.min(DRIVE_BRANCH_BACK_MM, shortSegmentBackMm));
}

function anatomyDisplayName(anatomy?: AirwayAnatomyLabel | null): string | null {
  return anatomy?.subsegment?.name ?? anatomy?.segment?.name ?? anatomy?.lobe?.name ?? null;
}

function topCandidate(edge?: AirwayEdge | null): AirwayCandidateLabel | null {
  return edge?.candidateLabels?.[0] ?? null;
}

function buildCandidateOverlays(currentDecision: Decision, edgesById: Map<number, AirwayEdge>): CandidateOverlay[] {
  const colors = ["#ffdf5d", "#67e8f9", "#f0abfc", "#86efac"];
  return currentDecision.options.flatMap((option, index) => {
    const edge = edgesById.get(option.edgeId);
    const candidate = topCandidate(edge);
    if (!edge || !candidate) {
      return [];
    }
    return [
      {
        edge,
        label: candidate.candidateLabel,
        score: candidate.score,
        color: colors[index % colors.length]
      }
    ];
  });
}

function Feedback({
  selectedEdgeId,
  selectedOptionCorrect,
  remainingPathCount,
  testMode
}: {
  selectedEdgeId: number | null;
  selectedOptionCorrect: boolean | null;
  remainingPathCount: number;
  testMode: boolean;
}) {
  if (selectedEdgeId == null) {
    return <div className="feedback neutral">Pick A, B, or C from the bronchoscope view.</div>;
  }
  if (selectedOptionCorrect) {
    if (testMode) {
      return <div className="feedback correct">Correct. First attempt recorded.</div>;
    }
    const pathCount = Math.max(remainingPathCount, 1);
    return (
      <div className="feedback correct">
        Correct. {pathCount} accepted {pathCount === 1 ? "path remains" : "paths remain"} from here.
      </div>
    );
  }
  if (testMode) {
    return <div className="feedback wrong">Not this branch. First attempt recorded.</div>;
  }
  return <div className="feedback wrong">Not this branch. The correct airway is shown in amber for comparison.</div>;
}

function buildHighlights(
  edgesById: Map<number, AirwayEdge>,
  currentDecision: Decision | null,
  selectedEdgeId: number | null,
  selectedCorrect: boolean,
  correctEdgeIds: number[],
  committedEdgeIds: number[]
) {
  const highlights: { edge: AirwayEdge; color: string; width: number }[] = [];
  committedEdgeIds.forEach((edgeId) => {
    const edge = edgesById.get(edgeId);
    if (edge) {
      highlights.push({ edge, color: "#2ef082", width: 4.2 });
    }
  });
  if (selectedEdgeId != null) {
    pushOptionHighlights(highlights, edgesById, currentDecision, selectedEdgeId, selectedCorrect ? "#2ef082" : "#ff5964", 4.5);
  }
  if (selectedEdgeId != null && !selectedCorrect) {
    correctEdgeIds.forEach((correctEdgeId) => {
      pushOptionHighlights(highlights, edgesById, currentDecision, correctEdgeId, "#ffd43a", 4);
    });
  }
  return highlights;
}

function pushOptionHighlights(
  highlights: { edge: AirwayEdge; color: string; width: number }[],
  edgesById: Map<number, AirwayEdge>,
  currentDecision: Decision | null,
  edgeId: number,
  color: string,
  width: number
) {
  const option = currentDecision?.options.find((candidate) => candidate.edgeId === edgeId);
  const edgeIds = option?.pathEdgeIds?.length ? option.pathEdgeIds : [edgeId];
  edgeIds.forEach((pathEdgeId) => {
    const edge = edgesById.get(pathEdgeId);
    if (edge) {
      highlights.push({ edge, color, width });
    }
  });
}
