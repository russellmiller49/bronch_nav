import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import type {
  AirwayAnatomyLabel,
  AirwayCandidateLabel,
  AirwayEdge,
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
import { clamp, type CtViewMode, type PlaneKind } from "./geometry";
import { buildRoute, createIndexes, type CaseIndexes } from "./route";
import { buildAirwayFrame, CtPane, type CandidateOverlay } from "./components/CtPane";
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

type SliceOffsets = Record<PlaneKind, number>;

const ZERO_SLICE_OFFSETS: SliceOffsets = { axial: 0, coronal: 0, sagittal: 0 };
const SCOPE_CALIBRATION_SCHEMA = "bronchoedu_scope_calibration/v1";
const SCOPE_CALIBRATION_SOURCE_PATH = "scope_calibration.json";
const DRIVE_BRANCH_BACK_MM = 18;
const DRIVE_LOOK_AHEAD_MM = 34;
const DRIVE_SHORT_SEGMENT_BACK_FRACTION = 0.7;
const DRIVE_PARENT_CLEARANCE_MM = 3;
const DEFAULT_DRIVE_SPEED_MM_PER_SEC = 22;
const TARGET_PATH_RADIUS_MARGIN_MM = 8;

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
  const [scopeDebugMode, setScopeDebugMode] = useState(false);
  const [scopeAdjustments, setScopeAdjustments] = useState<ScopeAdjustments>({});
  const [calibrationStatus, setCalibrationStatus] = useState("");
  const [targetPlacementStatus, setTargetPlacementStatus] = useState("");
  const [mode, setMode] = useState<"setup" | "practice">("practice");
  const [driveDistanceMm, setDriveDistanceMm] = useState(0);
  const [driveRunning, setDriveRunning] = useState(false);
  const [driveSpeedMmPerSec, setDriveSpeedMmPerSec] = useState(DEFAULT_DRIVE_SPEED_MM_PER_SEC);
  const sourceSaveTimerRef = useRef<number | null>(null);

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
    () => (activeTarget && indexes ? targetLocationsForTarget(activeTarget, indexes) : []),
    [activeTarget, indexes]
  );
  const activeTargetLocation = activeTargetLocations[Math.min(targetLocationIndex, Math.max(activeTargetLocations.length - 1, 0))] ?? null;
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
    () => (indexes ? activePathTerminalIds.map((terminalNodeId) => buildRoute(terminalNodeId, indexes, activePathTerminalIds)) : []),
    [indexes, activePathTerminalIds, correctTerminalKey]
  );
  const centerlineRoutePaths = useMemo(() => centerlineRoutes.map((candidateRoute) => candidateRoute.routePoints), [centerlineRoutes]);
  const route = useMemo<RouteState | null>(() => {
    if (!selectedEndpointId || !indexes) {
      return null;
    }
    return buildRoute(selectedEndpointId, indexes, activePathTerminalIds);
  }, [activePathTerminalIds, correctTerminalKey, selectedEndpointId, indexes]);

  const currentDecision: Decision | null = route?.decisions[currentDecisionIndex] ?? null;
  const currentStopDistanceMm = route ? stopDistanceForDecision(route, currentDecision) : 0;
  const atDecisionStop = Boolean(currentDecision && !driveRunning && driveDistanceMm >= currentStopDistanceMm - 0.75);
  const visibleDecision: Decision | null = atDecisionStop ? currentDecision : null;
  const driveRouteComplete = Boolean(route && !currentDecision && !driveRunning && driveDistanceMm >= route.totalLengthMm - 0.75);
  const drivePose = useMemo<ScopeCameraPose | null>(() => {
    if (!route) {
      return null;
    }
    return buildDrivePose(route, driveDistanceMm, currentDecision);
  }, [route, driveDistanceMm, currentDecision]);
  const driveMapBucket = Math.round(driveDistanceMm / 6);
  const mapDriveRas = useMemo<Vec3 | null>(() => (route ? pointAtRouteDistance(route, driveMapBucket * 6) : null), [route, driveMapBucket]);
  const noduleRas = activeTargetLocation?.targetRas ?? activeTarget?.targetRas ?? loadedCase?.metadata.initial.snappedTerminalRas;
  const focusRas = drivePose?.cameraRas ?? visibleDecision?.nodeRas ?? noduleRas ?? loadedCase?.metadata.initial.targetRas;
  const selectedOption = visibleDecision?.options.find((option) => option.edgeId === selectedEdgeId) ?? null;
  const correctOptions = visibleDecision?.options.filter((option) => option.isCorrect) ?? [];
  const airwayFrame = useMemo(() => (route && focusRas ? buildAirwayFrame(route.routePoints, focusRas) : null), [route, focusRas]);
  const hasCandidateLabels = loadedCase?.metadata.airway.edges.some((edge) => edge.candidateLabels?.length) ?? false;
  const candidateOverlays = useMemo(
    () => (showCandidateLabels && visibleDecision ? buildCandidateOverlays(visibleDecision, indexes?.edgesById ?? new Map()) : []),
    [showCandidateLabels, visibleDecision, indexes]
  );

  useEffect(() => {
    if (!activeTarget) {
      return;
    }
    setTargetLocationIndex(0);
    setTargetPlacementStatus("");
  }, [activeTarget?.id]);

  useEffect(() => {
    if (targetLocationIndex < activeTargetLocations.length) {
      return;
    }
    setTargetLocationIndex(0);
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
    setSliceOffsets(ZERO_SLICE_OFFSETS);
  }, [activeTargetLocation?.id]);

  useEffect(() => {
    setSliceOffsets(ZERO_SLICE_OFFSETS);
  }, [currentDecisionIndex, ctViewMode]);

  useEffect(() => {
    if (!route) {
      return;
    }
    setDriveDistanceMm((current) => clamp(current, 0, route.totalLengthMm));
  }, [route]);

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
        const next = Math.min(currentStopDistanceMm, current + driveSpeedMmPerSec * elapsedSeconds);
        reachedStop = next >= currentStopDistanceMm - 0.05;
        return reachedStop ? currentStopDistanceMm : next;
      });
      if (reachedStop) {
        setDriveRunning(false);
        return;
      }
      frameId = window.requestAnimationFrame(tick);
    };
    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [currentStopDistanceMm, driveRunning, driveSpeedMmPerSec, route]);

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

  if (!loadedCase || !indexes || !route || !focusRas || !noduleRas || !airwayFrame) {
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
  const scopeStatusLabel = visibleDecision ? `Decision ${visibleDecision.index + 1}` : driveRouteComplete ? "Complete" : driveRunning ? "Driving" : "Paused";
  const targetOrdinal = activeTargetLocation ? Math.min(targetLocationIndex + 1, activeTargetLocations.length) : 0;
  const targetCount = activeTargetLocations.length;
  const pathCount = activePathTerminalIds.length;
  const pathsNarrowed = pathCount > 0 && pathCount < activeTargetCorrectTerminalIds.length;

  const chooseOption = (edgeId: number) => {
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
    setSliceOffsets(ZERO_SLICE_OFFSETS);
  };

  const seekDrive = (distanceMm: number) => {
    setDriveRunning(false);
    setDriveDistanceMm(clamp(distanceMm, 0, driveTargetDistanceMm));
  };

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
    const limit = ctViewMode === "standard" ? 220 : 42;
    setSliceOffsets((current) => ({
      ...current,
      [plane]: Math.round(clamp(current[plane] + delta, -limit, limit))
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
    setTargetPlacementStatus(`Target ${nextIndex + 1}`);
  };

  const resetTarget = () => {
    setTargetLocationIndex(0);
    if (activeTargetLocation) {
      setSelectedEndpointId(activeTargetLocation.initialTerminalNodeId);
      setRemainingCorrectTerminalIds(activeTargetLocation.correctTerminalNodeIds);
    }
    setCommittedPathEdgeIds([]);
    setCurrentDecisionIndex(0);
    setSelectedEdgeId(null);
    setDriveDistanceMm(0);
    setDriveRunning(false);
    setSliceOffsets(ZERO_SLICE_OFFSETS);
    setTargetPlacementStatus("Target 1");
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
    setTargetPlacementStatus(`Target ${nextIndex + 1}`);
  };

  const snapTargetToRas = (ras: Vec3) => {
    const nextIndex = nearestTargetLocationIndex(activeTargetLocations, ras);
    if (nextIndex == null) {
      return;
    }
    setTargetLocationIndex(nextIndex);
    setTargetPlacementStatus(`Snapped to Target ${nextIndex + 1}`);
  };

  const startNoduleDrag = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-bronch-nodule", activeTarget?.id ?? "nodule");
  };

  const debugMoveDecision = (delta: number) => {
    setSelectedEdgeId(null);
    setDriveRunning(false);
    setCurrentDecisionIndex((value) => {
      const maxDecision = Math.max(route.decisions.length - 1, 0);
      const nextIndex = Math.round(clamp(value + delta, 0, maxDecision));
      setDriveDistanceMm(stopDistanceForDecision(route, route.decisions[nextIndex] ?? null));
      return nextIndex;
    });
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

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand-block">
          <strong>Bronch Navigation Trainer</strong>
          <span>{loadedCase.metadata.caseId}</span>
        </div>
        <div className="segmented">
          <button className={mode === "setup" ? "active" : ""} onClick={() => setMode("setup")}>
            Setup
          </button>
          <button className={mode === "practice" ? "active" : ""} onClick={() => setMode("practice")}>
            Practice
          </button>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={showRoute} onChange={(event) => setShowRoute(event.target.checked)} />
          <span>Centerline</span>
        </label>
        <label className={`toggle ${hasCandidateLabels ? "" : "toggle-disabled"}`}>
          <input
            type="checkbox"
            checked={showCandidateLabels && hasCandidateLabels}
            disabled={!hasCandidateLabels}
            onChange={(event) => setShowCandidateLabels(event.target.checked)}
          />
          <span>Candidates</span>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={ctViewMode === "airway"}
            onChange={(event) => setCtViewMode(event.target.checked ? "airway" : "standard")}
          />
          <span>Airway CT</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={scopeDebugMode} onChange={(event) => setScopeDebugMode(event.target.checked)} />
          <span>Scope debug</span>
        </label>
        <div className="case-status">
          <span>Decision</span>
          <strong>{progressLabel}</strong>
        </div>
      </header>

      <aside className="trainer-panel">
        <div className="panel-section">
          <span className="section-label">Target</span>
          {noduleTargets.length > 1 && (
            <div className="segmented target-selector">
              {noduleTargets.map((target) => (
                <button key={target.id} className={target.id === activeTarget?.id ? "active" : ""} onClick={() => setActiveTargetId(target.id)}>
                  {target.label.replace(" nodule", "")}
                </button>
              ))}
            </div>
          )}
          <h1>{activeTarget?.label ?? "Nodule target"}</h1>
          <p>
            Target {targetOrdinal} of {targetCount}. {pathCount} accepted {pathCount === 1 ? "path" : "paths"}
            {pathsNarrowed ? " from this branch" : ""}.
          </p>
          <div className="nodule-picker">
            <NoduleThumbnail asset={activeNoduleAsset} label={activeTarget?.label ?? "Nodule"} onDragStart={startNoduleDrag} />
            <button className="secondary-action surprise-action" onClick={surpriseTarget} disabled={activeTargetLocations.length < 2}>
              Surprise me
            </button>
          </div>
          {targetPlacementStatus && <div className="target-snap-status">{targetPlacementStatus}</div>}
          <div className="path-list" aria-label="Accepted paths for this target">
            {activePathTerminalIds.map((nodeId, index) => (
              <span key={nodeId} className={`path-pill ${nodeId === selectedEndpointId ? "path-pill-active" : ""}`}>
                Path {index + 1}
              </span>
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
        </div>

        <div className="panel-section">
          <span className="section-label">CT views</span>
          <div className="decision-meta">
            <span>{ctViewMode === "airway" ? "Airway aligned" : "Standard planes"}</span>
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

        <div className="panel-section">
          <span className="section-label">Drive</span>
          <div className="decision-meta">
            <span>{driveRunning ? "Moving" : driveRouteComplete ? "Complete" : atDecisionStop ? "At branch" : "Paused"}</span>
            <span>{driveProgressPercent}%</span>
          </div>
          <div className="drive-controls">
            <button className="icon-action" onClick={() => nudgeDrive(-8)} aria-label="Move scope backward">
              {"<"}
            </button>
            <button className="secondary-action" onClick={toggleDrive} disabled={driveRouteComplete || atDecisionStop}>
              {driveRunning ? "Pause" : "Drive"}
            </button>
            <button className="icon-action" onClick={() => nudgeDrive(8)} aria-label="Move scope forward" disabled={driveRouteComplete || atDecisionStop}>
              {">"}
            </button>
          </div>
          <label className="range-control drive-range">
            <span>Position {Math.round(driveDistanceMm)} mm</span>
            <input
              type="range"
              min="0"
              max={Math.max(1, Math.round(driveTargetDistanceMm))}
              step="1"
              value={Math.round(clamp(driveDistanceMm, 0, Math.max(1, driveTargetDistanceMm)))}
              onChange={(event) => seekDrive(Number(event.target.value))}
            />
          </label>
          <label className="range-control drive-range">
            <span>Speed {Math.round(driveSpeedMmPerSec)} mm/s</span>
            <input
              type="range"
              min="8"
              max="60"
              step="1"
              value={driveSpeedMmPerSec}
              onChange={(event) => setDriveSpeedMmPerSec(Number(event.target.value))}
            />
          </label>
        </div>

        {scopeDebugMode && (
          <div className="panel-section debug-section">
            <span className="section-label">Scope debug</span>
            <div className="decision-meta">
              <span>{visibleDecision ? `Node ${visibleDecision.nodeId}` : "No active branch"}</span>
              <span>{SCOPE_CALIBRATION_SOURCE_PATH}</span>
            </div>
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
            {calibrationStatus && <div className="debug-status">{calibrationStatus}</div>}
          </div>
        )}

        <div className="panel-section">
          <span className="section-label">Branch choice</span>
          {visibleDecision ? (
            <>
              <div className="decision-meta">
                <span>Node {visibleDecision.nodeId}</span>
                <span>{visibleDecision.options.length} choices</span>
              </div>
              <div className="choice-stack">
                {visibleDecision.options.map((option) => {
                  const selected = selectedEdgeId === option.edgeId;
                  const stateClass = selected ? (option.isCorrect ? "choice-correct" : "choice-wrong") : "";
                  const edge = indexes.edgesById.get(option.edgeId);
                  const candidate = topCandidate(edge);
                  return (
                    <button key={option.edgeId} className={`choice-button ${stateClass}`} onClick={() => chooseOption(option.edgeId)}>
                      <strong>{option.label}</strong>
                      <span>{candidate && showCandidateLabels ? `${candidate.candidateLabel} ${candidate.score.toFixed(2)}` : (anatomyDisplayName(edge?.anatomy) ?? `Cell ${option.edgeId}`)}</span>
                    </button>
                  );
                })}
              </div>
              <Feedback selectedEdgeId={selectedEdgeId} selectedOptionCorrect={selectedOption?.isCorrect ?? null} remainingPathCount={selectedOption?.correctTerminalNodeIds?.length ?? 0} />
              <button className="primary-action" disabled={selectedEdgeId == null} onClick={continueDrive}>
                Drive on
              </button>
            </>
          ) : driveRouteComplete ? (
            <>
              <RouteCompleteCelebration />
              <button className="primary-action" onClick={resetPractice}>
                Restart route
              </button>
            </>
          ) : (
            <>
              <div className="done-state">{driveRunning ? "Driving" : "Paused"}</div>
              <button className="primary-action" disabled={driveRunning || atDecisionStop} onClick={() => setDriveRunning(true)}>
                Drive to branch
              </button>
            </>
          )}
        </div>

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
      </aside>

      <section className="workspace">
        <div className="ct-grid">
          <CtPane
            plane="axial"
            viewMode={ctViewMode}
            ct={loadedCase.metadata.ct}
            volume={loadedCase.volume}
            focusRas={focusRas}
            noduleRas={noduleRas}
            noduleAsset={activeNoduleAsset}
            routePaths={centerlineRoutePaths}
            airwayFrame={airwayFrame}
            sliceOffset={sliceOffsets.axial}
            showRoute={showRoute}
            highlightEdges={highlightEdges}
            candidateOverlays={candidateOverlays}
            zoom={ctZoom}
            onSliceScroll={handleSliceScroll}
            onZoomChange={nudgeZoom}
            onTargetDrop={snapTargetToRas}
          />
          <CtPane
            plane="coronal"
            viewMode={ctViewMode}
            ct={loadedCase.metadata.ct}
            volume={loadedCase.volume}
            focusRas={focusRas}
            noduleRas={noduleRas}
            noduleAsset={activeNoduleAsset}
            routePaths={centerlineRoutePaths}
            airwayFrame={airwayFrame}
            sliceOffset={sliceOffsets.coronal}
            showRoute={showRoute}
            highlightEdges={highlightEdges}
            candidateOverlays={candidateOverlays}
            zoom={ctZoom}
            onSliceScroll={handleSliceScroll}
            onZoomChange={nudgeZoom}
            onTargetDrop={snapTargetToRas}
          />
          <CtPane
            plane="sagittal"
            viewMode={ctViewMode}
            ct={loadedCase.metadata.ct}
            volume={loadedCase.volume}
            focusRas={focusRas}
            noduleRas={noduleRas}
            noduleAsset={activeNoduleAsset}
            routePaths={centerlineRoutePaths}
            airwayFrame={airwayFrame}
            sliceOffset={sliceOffsets.sagittal}
            showRoute={showRoute}
            highlightEdges={highlightEdges}
            candidateOverlays={candidateOverlays}
            zoom={ctZoom}
            onSliceScroll={handleSliceScroll}
            onZoomChange={nudgeZoom}
            onTargetDrop={snapTargetToRas}
          />
        </div>
        <div className="right-stack">
          <BronchoscopeView
            decision={visibleDecision}
            indexes={indexes}
            selectedEdgeId={selectedEdgeId}
            drivePose={drivePose}
            applyDriveAdjustment={scopeDebugMode && Boolean(visibleDecision)}
            showDecisionLabels={Boolean(visibleDecision)}
            statusLabel={scopeStatusLabel}
            debugMode={scopeDebugMode}
            adjustment={visibleScopeAdjustment}
            onAdjustmentChange={(nextAdjustment) => updateCurrentScopeAdjustment(() => nextAdjustment)}
          />
          <AirwayMap
            webCase={loadedCase.metadata}
            indexes={indexes}
            route={route}
            decision={visibleDecision}
            candidateOverlays={candidateOverlays}
            selectedEndpointId={selectedEndpointId ?? loadedCase.metadata.initial.snappedTerminalNodeId}
            selectableEndpointIds={activePathTerminalIds}
            noduleRas={noduleRas}
            noduleRadiusMm={activeNoduleAsset?.metadata.maxRadiusMm ?? null}
            selectedEdgeId={selectedEdgeId}
            committedEdgeIds={takenPathEdgeIds}
            driveRas={mapDriveRas}
          />
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

function targetLocationsForTarget(target: NoduleTarget, indexes: CaseIndexes): NoduleTargetLocation[] {
  if (target.locations?.length) {
    return target.locations.map((location, index) => ({
      ...location,
      id: location.id || `${target.id}-target-${index + 1}`,
      label: location.label || `Target ${index + 1}`,
      correctTerminalNodeIds: uniqueNodeIds(location.correctTerminalNodeIds.length ? location.correctTerminalNodeIds : [location.initialTerminalNodeId])
    }));
  }

  const anchorNodeIds = orderedTerminalNodeIdsForTargets(indexes, target.initialTerminalNodeId);
  const baseNode = indexes.nodesById.get(target.initialTerminalNodeId);
  const anchorOffset: Vec3 = baseNode
    ? [target.targetRas[0] - baseNode.ras[0], target.targetRas[1] - baseNode.ras[1], target.targetRas[2] - baseNode.ras[2]]
    : [0, 0, 0];
  const radiusMm = target.noduleAsset.maxRadiusMm ?? 0;
  const useNearbyAcceptedPaths = target.correctTerminalNodeIds.length > 1;

  return (anchorNodeIds.length ? anchorNodeIds : [target.initialTerminalNodeId]).map((anchorNodeId, index) => {
    const anchorNode = indexes.nodesById.get(anchorNodeId);
    const targetRas: Vec3 = anchorNode
      ? [anchorNode.ras[0] + anchorOffset[0], anchorNode.ras[1] + anchorOffset[1], anchorNode.ras[2] + anchorOffset[2]]
      : target.targetRas;
    const nearbyTerminalNodeIds = useNearbyAcceptedPaths ? terminalNodeIdsNearTarget(indexes, targetRas, radiusMm + TARGET_PATH_RADIUS_MARGIN_MM) : [];
    const correctTerminalNodeIds = uniqueNodeIds([anchorNodeId, ...nearbyTerminalNodeIds]);
    const initialTerminalNodeId = correctTerminalNodeIds.includes(anchorNodeId) ? anchorNodeId : (correctTerminalNodeIds[0] ?? anchorNodeId);
    return {
      id: `${target.id}-target-${index + 1}`,
      label: `Target ${index + 1}`,
      targetRas,
      initialTerminalNodeId,
      correctTerminalNodeIds
    };
  });
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
  const response = await fetch("/__scope_calibration", {
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
  remainingPathCount
}: {
  selectedEdgeId: number | null;
  selectedOptionCorrect: boolean | null;
  remainingPathCount: number;
}) {
  if (selectedEdgeId == null) {
    return <div className="feedback neutral">Pick A, B, or C from the bronchoscope view.</div>;
  }
  if (selectedOptionCorrect) {
    const pathCount = Math.max(remainingPathCount, 1);
    return (
      <div className="feedback correct">
        Correct. {pathCount} accepted {pathCount === 1 ? "path remains" : "paths remain"} from here.
      </div>
    );
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
