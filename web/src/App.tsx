import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AirwayAnatomyLabel,
  AirwayCandidateLabel,
  AirwayEdge,
  Decision,
  LoadedCase,
  RouteState,
  ScopeAdjustment,
  ScopeAdjustments,
  ScopeCalibrationPayload
} from "./types";
import { loadCase } from "./caseLoader";
import { clamp, type CtViewMode, type PlaneKind } from "./geometry";
import { buildRoute, createIndexes } from "./route";
import { buildAirwayFrame, CtPane, type CandidateOverlay } from "./components/CtPane";
import { BronchoscopeView, DEFAULT_SCOPE_ADJUSTMENT, normalizeScopeAdjustment } from "./components/BronchoscopeView";
import { AirwayMap } from "./components/AirwayMap";

type SliceOffsets = Record<PlaneKind, number>;

const ZERO_SLICE_OFFSETS: SliceOffsets = { axial: 0, coronal: 0, sagittal: 0 };
const SCOPE_DEBUG_STORAGE_KEY = "bronchoedu.scopeDebugAdjustments.v1";
const SCOPE_CALIBRATION_SCHEMA = "bronchoedu_scope_calibration/v1";

export function App() {
  const [loadedCase, setLoadedCase] = useState<LoadedCase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedEndpointId, setSelectedEndpointId] = useState<number | null>(null);
  const [currentDecisionIndex, setCurrentDecisionIndex] = useState(0);
  const [selectedEdgeId, setSelectedEdgeId] = useState<number | null>(null);
  const [showRoute, setShowRoute] = useState(false);
  const [showCandidateLabels, setShowCandidateLabels] = useState(true);
  const [ctViewMode, setCtViewMode] = useState<CtViewMode>("standard");
  const [sliceOffsets, setSliceOffsets] = useState<SliceOffsets>(ZERO_SLICE_OFFSETS);
  const [ctZoom, setCtZoom] = useState(1);
  const [scopeDebugMode, setScopeDebugMode] = useState(false);
  const [scopeAdjustments, setScopeAdjustments] = useState<ScopeAdjustments>(() => loadScopeAdjustments());
  const [calibrationStatus, setCalibrationStatus] = useState("");
  const [mode, setMode] = useState<"setup" | "practice">("practice");
  const calibrationInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    loadCase()
      .then((nextCase) => {
        setLoadedCase(nextCase);
        setSelectedEndpointId(nextCase.metadata.initial.snappedTerminalNodeId);
        setScopeAdjustments((localAdjustments) => ({
          ...parseScopeCalibration(nextCase.metadata.scopeCalibration),
          ...localAdjustments
        }));
      })
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : String(loadError)));
  }, []);

  const indexes = useMemo(() => (loadedCase ? createIndexes(loadedCase.metadata) : null), [loadedCase]);
  const route = useMemo<RouteState | null>(() => {
    if (!selectedEndpointId || !indexes) {
      return null;
    }
    return buildRoute(selectedEndpointId, indexes);
  }, [selectedEndpointId, indexes]);

  const currentDecision: Decision | null = route?.decisions[currentDecisionIndex] ?? null;
  const selectedNode = loadedCase && selectedEndpointId ? loadedCase.metadata.airway.nodes.find((node) => node.id === selectedEndpointId) : null;
  const selectedEndpointAnatomy = anatomyDisplayName(selectedNode?.anatomy);
  const noduleRas = selectedNode?.ras ?? loadedCase?.metadata.initial.snappedTerminalRas;
  const focusRas = currentDecision?.nodeRas ?? noduleRas ?? loadedCase?.metadata.initial.targetRas;
  const selectedOption = currentDecision?.options.find((option) => option.edgeId === selectedEdgeId) ?? null;
  const correctOption = currentDecision?.options.find((option) => option.isCorrect) ?? null;
  const airwayFrame = useMemo(() => (route && focusRas ? buildAirwayFrame(route.routePoints, focusRas) : null), [route, focusRas]);
  const hasCandidateLabels = loadedCase?.metadata.airway.edges.some((edge) => edge.candidateLabels?.length) ?? false;
  const candidateOverlays = useMemo(
    () => (showCandidateLabels && currentDecision ? buildCandidateOverlays(currentDecision, indexes?.edgesById ?? new Map()) : []),
    [showCandidateLabels, currentDecision, indexes]
  );

  useEffect(() => {
    setCurrentDecisionIndex(0);
    setSelectedEdgeId(null);
    setSliceOffsets(ZERO_SLICE_OFFSETS);
  }, [selectedEndpointId]);

  useEffect(() => {
    setSliceOffsets(ZERO_SLICE_OFFSETS);
  }, [currentDecisionIndex, ctViewMode]);

  useEffect(() => {
    window.localStorage.setItem(SCOPE_DEBUG_STORAGE_KEY, JSON.stringify(scopeAdjustments));
  }, [scopeAdjustments]);

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

  const highlightEdges = buildHighlights(indexes.edgesById, selectedEdgeId, selectedOption?.isCorrect ?? false, correctOption?.edgeId ?? null);
  const progressLabel = route.decisions.length ? `${Math.min(currentDecisionIndex + 1, route.decisions.length)} / ${route.decisions.length}` : "complete";
  const scopeAdjustmentKey = currentDecision ? String(currentDecision.nodeId) : "complete";
  const scopeAdjustment = currentDecision ? normalizeScopeAdjustment(scopeAdjustments[scopeAdjustmentKey]) : DEFAULT_SCOPE_ADJUSTMENT;

  const chooseOption = (edgeId: number) => {
    setSelectedEdgeId(edgeId);
  };

  const nextDecision = () => {
    setSelectedEdgeId(null);
    setCurrentDecisionIndex((value) => Math.min(value + 1, route.decisions.length));
  };

  const resetPractice = () => {
    setCurrentDecisionIndex(0);
    setSelectedEdgeId(null);
    setSliceOffsets(ZERO_SLICE_OFFSETS);
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

  const moveEndpoint = (delta: number) => {
    const terminals = loadedCase.metadata.airway.terminalNodeIds;
    const current = selectedEndpointId ?? loadedCase.metadata.initial.snappedTerminalNodeId;
    const index = Math.max(0, terminals.indexOf(current));
    const nextIndex = (index + delta + terminals.length) % terminals.length;
    setSelectedEndpointId(terminals[nextIndex]);
  };

  const resetEndpoint = () => {
    setSelectedEndpointId(loadedCase.metadata.initial.snappedTerminalNodeId);
  };

  const debugMoveDecision = (delta: number) => {
    setSelectedEdgeId(null);
    setCurrentDecisionIndex((value) => {
      const maxDecision = Math.max(route.decisions.length - 1, 0);
      return Math.round(clamp(value + delta, 0, maxDecision));
    });
  };

  const updateCurrentScopeAdjustment = (updater: (current: ScopeAdjustment) => ScopeAdjustment) => {
    if (!currentDecision) {
      return;
    }
    setScopeAdjustments((current) => {
      const existing = normalizeScopeAdjustment(current[scopeAdjustmentKey]);
      return {
        ...current,
        [scopeAdjustmentKey]: normalizeScopeAdjustment(updater(existing))
      };
    });
  };

  const resetCurrentScopeAdjustment = () => {
    if (!currentDecision) {
      return;
    }
    setScopeAdjustments((current) => {
      const next = { ...current };
      delete next[scopeAdjustmentKey];
      return next;
    });
  };

  const exportScopeCalibration = () => {
    const payload: ScopeCalibrationPayload = {
      schema: SCOPE_CALIBRATION_SCHEMA,
      caseId: loadedCase.metadata.caseId,
      exportedAt: new Date().toISOString(),
      adjustments: scopeAdjustments
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${loadedCase.metadata.caseId || "broncho"}-scope-calibration.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setCalibrationStatus(`Exported ${Object.keys(scopeAdjustments).length} views.`);
  };

  const importScopeCalibration = async (file: File | null | undefined) => {
    if (!file) {
      return;
    }
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const imported = parseScopeCalibration(parsed);
      const count = Object.keys(imported).length;
      if (count === 0) {
        throw new Error("No scope adjustments found in file.");
      }
      setScopeAdjustments((current) => ({ ...current, ...imported }));
      setCalibrationStatus(`Imported ${count} views.`);
    } catch (importError) {
      setCalibrationStatus(importError instanceof Error ? importError.message : "Could not import calibration.");
    } finally {
      if (calibrationInputRef.current) {
        calibrationInputRef.current.value = "";
      }
    }
  };

  const clearScopeCalibration = () => {
    setScopeAdjustments({});
    setCalibrationStatus("Cleared all local calibration.");
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
          <h1>Snap nodule, then choose the airway.</h1>
          <p>
            Endpoint {selectedEndpointId} is active{selectedEndpointAnatomy ? ` (${selectedEndpointAnatomy})` : ""}. Drag the red target in the airway map to pick a different terminal branch.
          </p>
          <div className="inline-actions">
            <button className="secondary-action" onClick={() => moveEndpoint(-1)}>
              Prev endpoint
            </button>
            <button className="secondary-action" onClick={() => moveEndpoint(1)}>
              Next endpoint
            </button>
          </div>
          <button className="secondary-action wide" onClick={resetEndpoint}>
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

        {scopeDebugMode && (
          <div className="panel-section debug-section">
            <span className="section-label">Scope debug</span>
            <div className="decision-meta">
              <span>{currentDecision ? `Node ${currentDecision.nodeId}` : "No active branch"}</span>
              <span>local only</span>
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
              value={scopeAdjustment.cameraBackMm}
              min={4}
              max={45}
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
            <div className="inline-actions calibration-actions">
              <button className="secondary-action" onClick={exportScopeCalibration}>
                Export JSON
              </button>
              <button className="secondary-action" onClick={() => calibrationInputRef.current?.click()}>
                Import JSON
              </button>
            </div>
            <button className="secondary-action wide" onClick={clearScopeCalibration}>
              Clear all calibration
            </button>
            <input
              ref={calibrationInputRef}
              className="file-input"
              type="file"
              accept="application/json,.json"
              onChange={(event) => void importScopeCalibration(event.target.files?.[0])}
            />
            {calibrationStatus && <div className="debug-status">{calibrationStatus}</div>}
          </div>
        )}

        <div className="panel-section">
          <span className="section-label">Branch choice</span>
          {currentDecision ? (
            <>
              <div className="decision-meta">
                <span>Node {currentDecision.nodeId}</span>
                <span>{currentDecision.options.length} choices</span>
              </div>
              <div className="choice-stack">
                {currentDecision.options.map((option) => {
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
              <Feedback selectedEdgeId={selectedEdgeId} selectedOptionCorrect={selectedOption?.isCorrect ?? null} />
              <button className="primary-action" disabled={selectedEdgeId == null} onClick={nextDecision}>
                Next branch
              </button>
            </>
          ) : (
            <>
              <div className="done-state">Route complete</div>
              <button className="primary-action" onClick={resetPractice}>
                Restart route
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
            noduleAsset={loadedCase.noduleAsset}
            routePoints={route.routePoints}
            airwayFrame={airwayFrame}
            sliceOffset={sliceOffsets.axial}
            showRoute={showRoute}
            highlightEdges={highlightEdges}
            candidateOverlays={candidateOverlays}
            zoom={ctZoom}
            onSliceScroll={handleSliceScroll}
            onZoomChange={nudgeZoom}
          />
          <CtPane
            plane="coronal"
            viewMode={ctViewMode}
            ct={loadedCase.metadata.ct}
            volume={loadedCase.volume}
            focusRas={focusRas}
            noduleRas={noduleRas}
            noduleAsset={loadedCase.noduleAsset}
            routePoints={route.routePoints}
            airwayFrame={airwayFrame}
            sliceOffset={sliceOffsets.coronal}
            showRoute={showRoute}
            highlightEdges={highlightEdges}
            candidateOverlays={candidateOverlays}
            zoom={ctZoom}
            onSliceScroll={handleSliceScroll}
            onZoomChange={nudgeZoom}
          />
          <CtPane
            plane="sagittal"
            viewMode={ctViewMode}
            ct={loadedCase.metadata.ct}
            volume={loadedCase.volume}
            focusRas={focusRas}
            noduleRas={noduleRas}
            noduleAsset={loadedCase.noduleAsset}
            routePoints={route.routePoints}
            airwayFrame={airwayFrame}
            sliceOffset={sliceOffsets.sagittal}
            showRoute={showRoute}
            highlightEdges={highlightEdges}
            candidateOverlays={candidateOverlays}
            zoom={ctZoom}
            onSliceScroll={handleSliceScroll}
            onZoomChange={nudgeZoom}
          />
        </div>
        <div className="right-stack">
          <BronchoscopeView
            decision={currentDecision}
            indexes={indexes}
            selectedEdgeId={selectedEdgeId}
            debugMode={scopeDebugMode}
            adjustment={scopeAdjustment}
            onAdjustmentChange={(nextAdjustment) => updateCurrentScopeAdjustment(() => nextAdjustment)}
          />
          <AirwayMap
            webCase={loadedCase.metadata}
            indexes={indexes}
            route={route}
            decision={currentDecision}
            candidateOverlays={candidateOverlays}
            selectedEndpointId={selectedEndpointId ?? loadedCase.metadata.initial.snappedTerminalNodeId}
            selectedEdgeId={selectedEdgeId}
            onEndpointChange={setSelectedEndpointId}
          />
        </div>
      </section>
    </main>
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
  return (
    <label className="debug-slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <strong>
        {value}
        {suffix}
      </strong>
    </label>
  );
}

function loadScopeAdjustments(): ScopeAdjustments {
  try {
    const raw = window.localStorage.getItem(SCOPE_DEBUG_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    return parseScopeCalibration(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
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
  selectedOptionCorrect
}: {
  selectedEdgeId: number | null;
  selectedOptionCorrect: boolean | null;
}) {
  if (selectedEdgeId == null) {
    return <div className="feedback neutral">Pick A, B, or C from the bronchoscope view.</div>;
  }
  if (selectedOptionCorrect) {
    return <div className="feedback correct">Correct. The matching airway is highlighted on the CT views.</div>;
  }
  return <div className="feedback wrong">Not this branch. The correct airway is shown in amber for comparison.</div>;
}

function buildHighlights(
  edgesById: Map<number, AirwayEdge>,
  selectedEdgeId: number | null,
  selectedCorrect: boolean,
  correctEdgeId: number | null
) {
  const highlights: { edge: AirwayEdge; color: string; width: number }[] = [];
  if (selectedEdgeId != null) {
    const selected = edgesById.get(selectedEdgeId);
    if (selected) {
      highlights.push({ edge: selected, color: selectedCorrect ? "#2ef082" : "#ff5964", width: 4.5 });
    }
  }
  if (selectedEdgeId != null && !selectedCorrect && correctEdgeId != null) {
    const correct = edgesById.get(correctEdgeId);
    if (correct) {
      highlights.push({ edge: correct, color: "#ffd43a", width: 4 });
    }
  }
  return highlights;
}
