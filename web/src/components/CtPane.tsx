import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { AirwayEdge, CtMetadata, LoadedNoduleAsset, Vec3 } from "../types";
import {
  add,
  clamp,
  cross,
  dot,
  type CtViewMode,
  normalize,
  type PlaneKind,
  indexToRas,
  projectRasToPlane,
  rasToIndex,
  scale,
  subtract
} from "../geometry";

interface HighlightEdge {
  edge: AirwayEdge;
  color: string;
  width: number;
}

export interface CandidateOverlay {
  edge: AirwayEdge;
  label: string;
  score: number;
  color: string;
}

export interface AirwayFrame {
  origin: Vec3;
  tangent: Vec3;
  normal: Vec3;
  binormal: Vec3;
}

export interface TargetSurveyOverlay {
  label: string;
  ras: Vec3;
  radiusMm?: number | null;
  active?: boolean;
}

interface PanOffset {
  x: number;
  y: number;
}

interface PanDragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPan: PanOffset;
}

interface CtPaneProps {
  plane: PlaneKind;
  viewMode: CtViewMode;
  ct: CtMetadata;
  volume: Uint8Array;
  focusRas: Vec3;
  noduleRas: Vec3 | null;
  noduleAsset: LoadedNoduleAsset | null;
  routePaths: Vec3[][];
  scopeTracePath: Vec3[];
  airwayFrame: AirwayFrame;
  sliceOffset: number;
  sliceOffsetMin: number;
  sliceOffsetMax: number;
  airwaySliceDistanceScale?: number;
  showRoute: boolean;
  showScopeTrace: boolean;
  highlightEdges: HighlightEdge[];
  candidateOverlays: CandidateOverlay[];
  targetSurveyOverlays?: TargetSurveyOverlay[];
  zoom: number;
  onSliceScroll: (plane: PlaneKind, delta: number) => void;
  onSliceOffsetChange: (plane: PlaneKind, value: number) => void;
  onZoomChange: (delta: number) => void;
  onTargetDrop?: (ras: Vec3) => void;
}

const STANDARD_TITLES: Record<PlaneKind, string> = {
  axial: "Axial",
  coronal: "Coronal",
  sagittal: "Sagittal"
};

const AIRWAY_TITLES: Record<PlaneKind, string> = {
  axial: "Airway cross-section",
  coronal: "Airway long-axis A",
  sagittal: "Airway long-axis B"
};

const ZERO_PAN: PanOffset = { x: 0, y: 0 };
const MIN_PAN_ZOOM = 1.01;

export function CtPane({
  plane,
  viewMode,
  ct,
  volume,
  focusRas,
  noduleRas,
  noduleAsset,
  routePaths,
  scopeTracePath,
  airwayFrame,
  sliceOffset,
  sliceOffsetMin,
  sliceOffsetMax,
  airwaySliceDistanceScale = 2,
  showRoute,
  showScopeTrace,
  highlightEdges,
  candidateOverlays,
  targetSurveyOverlays = [],
  zoom,
  onSliceScroll,
  onSliceOffsetChange,
  onZoomChange,
  onTargetDrop
}: CtPaneProps) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawInfoRef = useRef<DrawInfo | null>(null);
  const panDragRef = useRef<PanDragState | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [pan, setPan] = useState<PanOffset>(ZERO_PAN);
  const [panning, setPanning] = useState(false);
  const canPan = zoom > MIN_PAN_ZOOM;

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        onZoomChange(event.deltaY > 0 ? -0.15 : 0.15);
      } else {
        onSliceScroll(plane, event.deltaY > 0 ? 1 : -1);
      }
    };
    section.addEventListener("wheel", onWheel, { passive: false });
    return () => section.removeEventListener("wheel", onWheel);
  }, [plane, onSliceScroll, onZoomChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const drawInfo =
      viewMode === "standard"
        ? drawStandardCt(canvas, plane, ct, volume, focusRas, sliceOffset, noduleRas, noduleAsset)
        : drawAirwayAlignedCt(canvas, plane, ct, volume, airwayFrame, sliceOffset, noduleRas, noduleAsset, airwaySliceDistanceScale);
    drawInfoRef.current = drawInfo;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    if (showRoute) {
      routePaths.forEach((routePoints) => {
        drawPolyline(ctx, drawInfo, routePoints, "#4bd7ff", 1.8, 0.72);
      });
    }
    highlightEdges.forEach(({ edge, color, width }) => {
      drawPolyline(ctx, drawInfo, edge.pointsRas, color, width, 0.95);
    });
    if (showScopeTrace) {
      drawPolyline(ctx, drawInfo, scopeTracePath, "#29e47c", 2.6, 0.95);
    }
    candidateOverlays.forEach(({ edge, label, score, color }) => {
      drawPolyline(ctx, drawInfo, edge.pointsRas, color, 1.7, 0.72);
      drawEdgeLabel(ctx, drawInfo, edge, `${label} ${score.toFixed(2)}`, color);
    });
    if (targetSurveyOverlays.length) {
      drawTargetSurveyOverlays(ctx, drawInfo, targetSurveyOverlays);
    }
    if (!noduleAsset && noduleRas) {
      drawMarker(ctx, drawInfo, noduleRas, "#ff5b68", 6, "target");
    }
  }, [
    plane,
    viewMode,
    ct,
    volume,
    focusRas,
    noduleRas,
    noduleAsset,
    routePaths,
    scopeTracePath,
    airwayFrame,
    sliceOffset,
    airwaySliceDistanceScale,
    showRoute,
    showScopeTrace,
    highlightEdges,
    candidateOverlays,
    targetSurveyOverlays
  ]);

  useEffect(() => {
    setPan((current) => clampPanOffset(current, canvasWrapRef.current, zoom));
    if (!canPan) {
      panDragRef.current = null;
      setPanning(false);
    }
  }, [canPan, zoom]);

  useEffect(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      setPan((current) => clampPanOffset(current, wrap, zoom));
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [zoom]);

  const title = viewMode === "standard" ? STANDARD_TITLES[plane] : AIRWAY_TITLES[plane];
  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    if (!canPan || event.button !== 0 || target?.closest(".slice-scrubber")) {
      return;
    }
    event.preventDefault();
    panDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPan: clampPanOffset(pan, canvasWrapRef.current, zoom)
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanning(true);
  };
  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = panDragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    setPan(
      clampPanOffset(
        {
          x: dragState.startPan.x + event.clientX - dragState.startClientX,
          y: dragState.startPan.y + event.clientY - dragState.startClientY
        },
        canvasWrapRef.current,
        zoom
      )
    );
  };
  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = panDragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    panDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPanning(false);
  };
  const resetPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    if (!canPan || target?.closest(".slice-scrubber")) {
      return;
    }
    setPan(ZERO_PAN);
  };
  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!onTargetDrop) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropActive(true);
  };
  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDropActive(false);
    }
  };
  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (!onTargetDrop) {
      return;
    }
    event.preventDefault();
    setDropActive(false);
    const ras = droppedCanvasPointToRas(event, canvasRef.current, drawInfoRef.current);
    if (ras) {
      onTargetDrop(ras);
    }
  };

  return (
    <section
      ref={sectionRef}
      className={`ct-pane ${dropActive ? "ct-pane-drop-active" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="pane-chrome">
        <span>{title}</span>
        <span>{viewMode === "standard" ? standardSliceLabel(plane, focusRas, ct, sliceOffset) : airwaySliceLabel(plane, sliceOffset)}</span>
      </div>
      <div
        ref={canvasWrapRef}
        className={`ct-canvas-wrap ${canPan ? "ct-canvas-wrap-pannable" : ""} ${panning ? "ct-canvas-wrap-panning" : ""}`}
        onPointerDown={beginPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onDoubleClick={resetPan}
      >
        <canvas ref={canvasRef} className="ct-canvas" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} />
        <label className="slice-scrubber">
          <input
            type="range"
            min={sliceOffsetMin}
            max={sliceOffsetMax}
            step={1}
            value={sliceOffset}
            aria-label={`${title} slice position`}
            onChange={(event) => onSliceOffsetChange(plane, Number(event.currentTarget.value))}
          />
        </label>
      </div>
    </section>
  );
}

function clampPanOffset(offset: PanOffset, wrap: HTMLElement | null, zoom: number): PanOffset {
  if (!wrap || zoom <= MIN_PAN_ZOOM) {
    return ZERO_PAN;
  }
  const maxX = Math.max(0, (wrap.clientWidth * (zoom - 1)) / 2);
  const maxY = Math.max(0, (wrap.clientHeight * (zoom - 1)) / 2);
  return {
    x: clamp(offset.x, -maxX, maxX),
    y: clamp(offset.y, -maxY, maxY)
  };
}

type DrawInfo =
  | {
      mode: "standard";
      plane: PlaneKind;
      ct: CtMetadata;
      sliceIndex: number;
      width: number;
      height: number;
    }
  | {
      mode: "airway";
      plane: PlaneKind;
      origin: Vec3;
      xAxis: Vec3;
      yAxis: Vec3;
      normal: Vec3;
      fovX: number;
      fovY: number;
      width: number;
      height: number;
    };

function drawStandardCt(
  canvas: HTMLCanvasElement,
  plane: PlaneKind,
  ct: CtMetadata,
  volume: Uint8Array,
  focusRas: Vec3,
  sliceOffset: number,
  noduleRas: Vec3 | null,
  noduleAsset: LoadedNoduleAsset | null
): DrawInfo {
  const [sx, sy, sz] = ct.sizeXyz;
  const focus = rasToIndex(focusRas, ct);
  const i = Math.round(clamp(focus.i, 0, sx - 1));
  const j = Math.round(clamp(focus.j, 0, sy - 1));
  const k = Math.round(clamp(focus.k, 0, sz - 1));
  const sliceIndex =
    plane === "axial"
      ? Math.round(clamp(k + sliceOffset, 0, sz - 1))
      : plane === "coronal"
        ? Math.round(clamp(j + sliceOffset, 0, sy - 1))
        : Math.round(clamp(i + sliceOffset, 0, sx - 1));
  const width = plane === "sagittal" ? sy : sx;
  const height = plane === "axial" ? sy : sz;

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { mode: "standard", plane, ct, sliceIndex, width, height };
  }
  const image = ctx.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let vx = x;
      let vy = y;
      let vz = sliceIndex;
      if (plane === "coronal") {
        vy = sliceIndex;
        vz = sz - 1 - y;
      } else if (plane === "sagittal") {
        vx = sliceIndex;
        vy = x;
        vz = sz - 1 - y;
      }
      const baseValue = volume[vz * sx * sy + vy * sx + vx] ?? 0;
      const ras = noduleAsset && noduleRas ? indexToRas({ i: vx, j: vy, k: vz }, ct) : null;
      writePixel(image, x, y, width, ras ? applyNoduleAsset(baseValue, ras, noduleRas, noduleAsset, ct.windowHu) : baseValue);
    }
  }
  ctx.putImageData(image, 0, 0);
  return { mode: "standard", plane, ct, sliceIndex, width, height };
}

function drawAirwayAlignedCt(
  canvas: HTMLCanvasElement,
  plane: PlaneKind,
  ct: CtMetadata,
  volume: Uint8Array,
  frame: AirwayFrame,
  sliceOffset: number,
  noduleRas: Vec3 | null,
  noduleAsset: LoadedNoduleAsset | null,
  sliceDistanceScale: number
): DrawInfo {
  const width = 256;
  const height = 256;
  const axes = airwayPlaneAxes(plane, frame);
  const scrollMm = sliceOffset * sliceDistanceScale;
  const origin = add(frame.origin, scale(axes.normal, scrollMm));
  const fovX = plane === "axial" ? 42 : 132;
  const fovY = plane === "axial" ? 42 : 96;
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { mode: "airway", plane, origin, ...axes, fovX, fovY, width, height };
  }
  const image = ctx.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    const yy = (0.5 - y / Math.max(height - 1, 1)) * fovY;
    for (let x = 0; x < width; x += 1) {
      const xx = (x / Math.max(width - 1, 1) - 0.5) * fovX;
      const ras = add(origin, add(scale(axes.xAxis, xx), scale(axes.yAxis, yy)));
      const baseValue = sampleVolumeRas(volume, ct, ras);
      writePixel(image, x, y, width, applyNoduleAsset(baseValue, ras, noduleRas, noduleAsset, ct.windowHu));
    }
  }
  ctx.putImageData(image, 0, 0);
  return { mode: "airway", plane, origin, ...axes, fovX, fovY, width, height };
}

function airwayPlaneAxes(plane: PlaneKind, frame: AirwayFrame) {
  if (plane === "axial") {
    return {
      xAxis: frame.normal,
      yAxis: frame.binormal,
      normal: frame.tangent
    };
  }
  if (plane === "coronal") {
    return {
      xAxis: frame.tangent,
      yAxis: frame.normal,
      normal: frame.binormal
    };
  }
  return {
    xAxis: frame.tangent,
    yAxis: frame.binormal,
    normal: frame.normal
  };
}

function writePixel(image: ImageData, x: number, y: number, width: number, value: number) {
  const offset = (y * width + x) * 4;
  image.data[offset] = value;
  image.data[offset + 1] = value;
  image.data[offset + 2] = value;
  image.data[offset + 3] = 255;
}

function sampleVolumeRas(volume: Uint8Array, ct: CtMetadata, ras: Vec3): number {
  const [sx, sy, sz] = ct.sizeXyz;
  const idx = rasToIndex(ras, ct);
  if (idx.i < 0 || idx.j < 0 || idx.k < 0 || idx.i > sx - 1 || idx.j > sy - 1 || idx.k > sz - 1) {
    return 0;
  }
  const i0 = Math.floor(idx.i);
  const j0 = Math.floor(idx.j);
  const k0 = Math.floor(idx.k);
  const i1 = Math.min(i0 + 1, sx - 1);
  const j1 = Math.min(j0 + 1, sy - 1);
  const k1 = Math.min(k0 + 1, sz - 1);
  const tx = idx.i - i0;
  const ty = idx.j - j0;
  const tz = idx.k - k0;
  const v000 = voxel(volume, sx, sy, i0, j0, k0);
  const v100 = voxel(volume, sx, sy, i1, j0, k0);
  const v010 = voxel(volume, sx, sy, i0, j1, k0);
  const v110 = voxel(volume, sx, sy, i1, j1, k0);
  const v001 = voxel(volume, sx, sy, i0, j0, k1);
  const v101 = voxel(volume, sx, sy, i1, j0, k1);
  const v011 = voxel(volume, sx, sy, i0, j1, k1);
  const v111 = voxel(volume, sx, sy, i1, j1, k1);
  const c00 = v000 * (1 - tx) + v100 * tx;
  const c10 = v010 * (1 - tx) + v110 * tx;
  const c01 = v001 * (1 - tx) + v101 * tx;
  const c11 = v011 * (1 - tx) + v111 * tx;
  const c0 = c00 * (1 - ty) + c10 * ty;
  const c1 = c01 * (1 - ty) + c11 * ty;
  return Math.round(c0 * (1 - tz) + c1 * tz);
}

function voxel(volume: Uint8Array, sx: number, sy: number, i: number, j: number, k: number) {
  return volume[k * sx * sy + j * sx + i] ?? 0;
}

function applyNoduleAsset(
  baseValue: number,
  ras: Vec3,
  noduleRas: Vec3 | null,
  noduleAsset: LoadedNoduleAsset | null,
  windowHu: [number, number]
) {
  if (!noduleAsset || !noduleRas) {
    return baseValue;
  }
  const sample = sampleNoduleAsset(noduleAsset, ras, noduleRas);
  if (sample.alpha <= 0.004) {
    return baseValue;
  }
  const baseHu = windowHu[0] + (baseValue / 255) * (windowHu[1] - windowHu[0]);
  return huToUint8(baseHu + sample.residualHu * sample.alpha, windowHu);
}

function sampleNoduleAsset(asset: LoadedNoduleAsset, ras: Vec3, centerRas: Vec3) {
  const deltaRas = subtract(ras, centerRas);
  const spacing = asset.metadata.spacingXyzMm;
  const center = asset.metadata.centroidIndexXyz;
  const i = center[0] - deltaRas[0] / spacing[0];
  const j = center[1] - deltaRas[1] / spacing[1];
  const k = center[2] + deltaRas[2] / spacing[2];
  const [sx, sy, sz] = asset.metadata.sizeXyz;
  if (i < 0 || j < 0 || k < 0 || i > sx - 1 || j > sy - 1 || k > sz - 1) {
    return { alpha: 0, residualHu: 0 };
  }
  return {
    alpha: sampleScalar(asset.alpha, sx, sy, i, j, k) / 255,
    residualHu: sampleScalar(asset.residual, sx, sy, i, j, k)
  };
}

function sampleScalar(volume: Uint8Array | Int16Array, sx: number, sy: number, i: number, j: number, k: number) {
  const i0 = Math.floor(i);
  const j0 = Math.floor(j);
  const k0 = Math.floor(k);
  const i1 = Math.min(i0 + 1, sx - 1);
  const j1 = Math.min(j0 + 1, sy - 1);
  const k1 = Math.min(k0 + 1, volume.length / (sx * sy) - 1);
  const tx = i - i0;
  const ty = j - j0;
  const tz = k - k0;
  const v000 = volume[k0 * sx * sy + j0 * sx + i0] ?? 0;
  const v100 = volume[k0 * sx * sy + j0 * sx + i1] ?? 0;
  const v010 = volume[k0 * sx * sy + j1 * sx + i0] ?? 0;
  const v110 = volume[k0 * sx * sy + j1 * sx + i1] ?? 0;
  const v001 = volume[k1 * sx * sy + j0 * sx + i0] ?? 0;
  const v101 = volume[k1 * sx * sy + j0 * sx + i1] ?? 0;
  const v011 = volume[k1 * sx * sy + j1 * sx + i0] ?? 0;
  const v111 = volume[k1 * sx * sy + j1 * sx + i1] ?? 0;
  const c00 = v000 * (1 - tx) + v100 * tx;
  const c10 = v010 * (1 - tx) + v110 * tx;
  const c01 = v001 * (1 - tx) + v101 * tx;
  const c11 = v011 * (1 - tx) + v111 * tx;
  const c0 = c00 * (1 - ty) + c10 * ty;
  const c1 = c01 * (1 - ty) + c11 * ty;
  return c0 * (1 - tz) + c1 * tz;
}

function huToUint8(hu: number, windowHu: [number, number]) {
  return Math.round(clamp((hu - windowHu[0]) / Math.max(windowHu[1] - windowHu[0], 1), 0, 1) * 255);
}

function drawPolyline(ctx: CanvasRenderingContext2D, info: DrawInfo, points: Vec3[], color: string, width: number, alpha: number) {
  if (points.length < 2) {
    return;
  }
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  let started = false;
  points.forEach((point) => {
    const projected = projectPoint(point, info);
    if (!projected.visible) {
      started = false;
      return;
    }
    if (!started) {
      ctx.moveTo(projected.x, projected.y);
      started = true;
    } else {
      ctx.lineTo(projected.x, projected.y);
    }
  });
  ctx.stroke();
  ctx.restore();
}

function drawMarker(ctx: CanvasRenderingContext2D, info: DrawInfo, ras: Vec3, color: string, radius: number, label: string) {
  const projected = projectPoint(ras, info);
  if (!projected.inFrame || !projected.visible) {
    return;
  }
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.strokeStyle = "#050505";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(projected.x, projected.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.font = "11px Inter, system-ui, sans-serif";
  ctx.fillStyle = "#f5f7fb";
  ctx.shadowColor = "#000";
  ctx.shadowBlur = 4;
  ctx.fillText(label, projected.x + radius + 4, projected.y - radius - 2);
  ctx.restore();
}

function drawTargetSurveyOverlays(ctx: CanvasRenderingContext2D, info: DrawInfo, overlays: TargetSurveyOverlay[]) {
  if (info.mode !== "standard") {
    return;
  }
  ctx.save();
  ctx.font = "9px Inter, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  overlays.forEach((overlay) => {
    const projected = projectRasToPlane(overlay.ras, info.ct, info.plane);
    if (projected.x < -32 || projected.y < -32 || projected.x > info.width + 32 || projected.y > info.height + 32) {
      return;
    }
    const radius = targetSurveyRadiusPixels(info, overlay.radiusMm);
    ctx.globalAlpha = overlay.active ? 0.56 : 0.32;
    ctx.fillStyle = overlay.active ? "rgba(41, 228, 124, 0.24)" : "rgba(255, 91, 104, 0.22)";
    ctx.strokeStyle = overlay.active ? "#29e47c" : "#ff8290";
    ctx.lineWidth = overlay.active ? 1.8 : 1.1;
    ctx.beginPath();
    ctx.arc(projected.x, projected.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const label = overlay.label;
    const labelWidth = Math.ceil(ctx.measureText(label).width) + 6;
    const labelHeight = 12;
    const labelX = clamp(projected.x + radius * 0.35, 2, info.width - labelWidth - 2);
    const labelY = clamp(projected.y - radius * 0.35 - labelHeight * 0.5, 2, info.height - labelHeight - 2);
    ctx.globalAlpha = overlay.active ? 0.96 : 0.78;
    ctx.fillStyle = overlay.active ? "#071710" : "#13080a";
    roundedRect(ctx, labelX, labelY, labelWidth, labelHeight, 3);
    ctx.fill();
    ctx.strokeStyle = overlay.active ? "#29e47c" : "#ff8290";
    ctx.lineWidth = 0.8;
    roundedRect(ctx, labelX + 0.5, labelY + 0.5, labelWidth - 1, labelHeight - 1, 3);
    ctx.stroke();
    ctx.fillStyle = overlay.active ? "#ceffdf" : "#ffd4d9";
    ctx.fillText(label, labelX + 3, labelY + labelHeight * 0.5 + 0.5);
  });
  ctx.restore();
}

function targetSurveyRadiusPixels(info: Extract<DrawInfo, { mode: "standard" }>, radiusMm: number | null | undefined) {
  if (!radiusMm || !Number.isFinite(radiusMm)) {
    return 5;
  }
  const spacing =
    info.plane === "axial"
      ? (info.ct.spacingXyzMm[0] + info.ct.spacingXyzMm[1]) * 0.5
      : info.plane === "coronal"
        ? (info.ct.spacingXyzMm[0] + info.ct.spacingXyzMm[2]) * 0.5
        : (info.ct.spacingXyzMm[1] + info.ct.spacingXyzMm[2]) * 0.5;
  return clamp(radiusMm / Math.max(spacing, 0.001), 5, 26);
}

function drawEdgeLabel(ctx: CanvasRenderingContext2D, info: DrawInfo, edge: AirwayEdge, label: string, color: string) {
  const point = pointAlong(edge.pointsRas, Math.min(32, Math.max(10, edge.lengthMm * 0.42)));
  const projected = projectPoint(point, info);
  if (!projected.inFrame || !projected.visible) {
    return;
  }
  ctx.save();
  ctx.font = "11px Inter, system-ui, sans-serif";
  const metrics = ctx.measureText(label);
  const width = Math.min(metrics.width + 12, 118);
  const height = 18;
  const x = Math.max(4, Math.min(projected.x + 7, info.width - width - 4));
  const y = Math.max(4, Math.min(projected.y - height - 5, info.height - height - 4));
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = "#081016";
  roundedRect(ctx, x, y, width, height, 5);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  roundedRect(ctx, x + 0.5, y + 0.5, width - 1, height - 1, 5);
  ctx.stroke();
  ctx.fillStyle = "#f4f7f8";
  ctx.fillText(label, x + 6, y + 12.5, width - 12);
  ctx.restore();
}

function pointAlong(points: Vec3[], distanceMm: number): Vec3 {
  if (!points.length) {
    return [0, 0, 0];
  }
  let travelled = 0;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const next = points[i];
    const segment = Math.hypot(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]);
    if (travelled + segment >= distanceMm) {
      const t = (distanceMm - travelled) / Math.max(segment, 1e-6);
      return [prev[0] + (next[0] - prev[0]) * t, prev[1] + (next[1] - prev[1]) * t, prev[2] + (next[2] - prev[2]) * t];
    }
    travelled += segment;
  }
  return points[points.length - 1];
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function projectPoint(ras: Vec3, info: DrawInfo) {
  if (info.mode === "standard") {
    const projected = projectRasToPlane(ras, info.ct, info.plane);
    const depthDistance = Math.abs(projected.depth - info.sliceIndex);
    return {
      x: projected.x,
      y: projected.y,
      visible: depthDistance <= 4,
      inFrame: projected.x >= 0 && projected.y >= 0 && projected.x <= info.width && projected.y <= info.height
    };
  }
  const relative = subtract(ras, info.origin);
  const xMm = dot(relative, info.xAxis);
  const yMm = dot(relative, info.yAxis);
  const depthMm = dot(relative, info.normal);
  const x = (xMm / info.fovX + 0.5) * info.width;
  const y = (0.5 - yMm / info.fovY) * info.height;
  return {
    x,
    y,
    visible: Math.abs(depthMm) <= 7,
    inFrame: x >= 0 && y >= 0 && x <= info.width && y <= info.height
  };
}

function droppedCanvasPointToRas(event: DragEvent<HTMLElement>, canvas: HTMLCanvasElement | null, info: DrawInfo | null): Vec3 | null {
  if (!canvas || !info) {
    return null;
  }
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const x = clamp(((event.clientX - rect.left) / rect.width) * canvas.width, 0, canvas.width - 1);
  const y = clamp(((event.clientY - rect.top) / rect.height) * canvas.height, 0, canvas.height - 1);
  return canvasPointToRas(info, x, y);
}

function canvasPointToRas(info: DrawInfo, x: number, y: number): Vec3 {
  if (info.mode === "airway") {
    const xMm = (x / Math.max(info.width - 1, 1) - 0.5) * info.fovX;
    const yMm = (0.5 - y / Math.max(info.height - 1, 1)) * info.fovY;
    return add(info.origin, add(scale(info.xAxis, xMm), scale(info.yAxis, yMm)));
  }

  const [sx, sy, sz] = info.ct.sizeXyz;
  const ix = clamp(x, 0, info.width - 1);
  const iy = clamp(y, 0, info.height - 1);
  if (info.plane === "axial") {
    return indexToRas({ i: clamp(ix, 0, sx - 1), j: clamp(iy, 0, sy - 1), k: info.sliceIndex }, info.ct);
  }
  if (info.plane === "coronal") {
    return indexToRas({ i: clamp(ix, 0, sx - 1), j: info.sliceIndex, k: clamp(sz - 1 - iy, 0, sz - 1) }, info.ct);
  }
  return indexToRas({ i: info.sliceIndex, j: clamp(ix, 0, sy - 1), k: clamp(sz - 1 - iy, 0, sz - 1) }, info.ct);
}

function standardSliceLabel(plane: PlaneKind, focusRas: Vec3, ct: CtMetadata, sliceOffset: number) {
  const idx = rasToIndex(focusRas, ct);
  const suffix = sliceOffset === 0 ? "" : ` ${sliceOffset > 0 ? "+" : ""}${sliceOffset}`;
  if (plane === "axial") {
    return `S ${Math.round(idx.k + sliceOffset)}${suffix}`;
  }
  if (plane === "coronal") {
    return `A ${Math.round(idx.j + sliceOffset)}${suffix}`;
  }
  return `R ${Math.round(idx.i + sliceOffset)}${suffix}`;
}

function airwaySliceLabel(plane: PlaneKind, sliceOffset: number) {
  const mm = sliceOffset * 2;
  const suffix = mm === 0 ? "0 mm" : `${mm > 0 ? "+" : ""}${mm} mm`;
  if (plane === "axial") {
    return `normal ${suffix}`;
  }
  return `offset ${suffix}`;
}

export function buildAirwayFrame(routePoints: Vec3[], focusRas: Vec3): AirwayFrame {
  if (routePoints.length < 2) {
    return fallbackFrame(focusRas);
  }
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  routePoints.forEach((point, index) => {
    const d = Math.hypot(point[0] - focusRas[0], point[1] - focusRas[1], point[2] - focusRas[2]);
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = index;
    }
  });
  const previous = routePoints[Math.max(0, bestIndex - 1)];
  const next = routePoints[Math.min(routePoints.length - 1, bestIndex + 1)];
  const tangent = normalize(subtract(next, previous), [0, 0, -1]);
  const patientAnterior: Vec3 = [0, 1, 0];
  let normal = normalize(subtract(patientAnterior, scale(tangent, dot(patientAnterior, tangent))), [1, 0, 0]);
  if (Math.abs(dot(normal, tangent)) > 0.95) {
    normal = normalize(cross([1, 0, 0], tangent), [1, 0, 0]);
  }
  const binormal = normalize(cross(tangent, normal), [0, 0, 1]);
  normal = normalize(cross(binormal, tangent), normal);
  return { origin: focusRas, tangent, normal, binormal };
}

function fallbackFrame(origin: Vec3): AirwayFrame {
  return {
    origin,
    tangent: [0, 0, -1],
    normal: [0, 1, 0],
    binormal: [1, 0, 0]
  };
}
