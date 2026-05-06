import { useEffect, useRef } from "react";
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

export interface AirwayFrame {
  origin: Vec3;
  tangent: Vec3;
  normal: Vec3;
  binormal: Vec3;
}

interface CtPaneProps {
  plane: PlaneKind;
  viewMode: CtViewMode;
  ct: CtMetadata;
  volume: Uint8Array;
  focusRas: Vec3;
  noduleRas: Vec3;
  noduleAsset: LoadedNoduleAsset | null;
  routePoints: Vec3[];
  airwayFrame: AirwayFrame;
  sliceOffset: number;
  showRoute: boolean;
  highlightEdges: HighlightEdge[];
  zoom: number;
  onSliceScroll: (plane: PlaneKind, delta: number) => void;
  onZoomChange: (delta: number) => void;
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

export function CtPane({
  plane,
  viewMode,
  ct,
  volume,
  focusRas,
  noduleRas,
  noduleAsset,
  routePoints,
  airwayFrame,
  sliceOffset,
  showRoute,
  highlightEdges,
  zoom,
  onSliceScroll,
  onZoomChange
}: CtPaneProps) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

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
        : drawAirwayAlignedCt(canvas, plane, ct, volume, airwayFrame, sliceOffset, noduleRas, noduleAsset);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    if (showRoute) {
      drawPolyline(ctx, drawInfo, routePoints, "#4bd7ff", 2.2, 0.86);
    }
    highlightEdges.forEach(({ edge, color, width }) => {
      drawPolyline(ctx, drawInfo, edge.pointsRas, color, width, 0.95);
    });
    drawMarker(ctx, drawInfo, focusRas, "#ffcc28", 5, "scope");
    if (!noduleAsset) {
      drawMarker(ctx, drawInfo, noduleRas, "#ff5b68", 6, "target");
    }
  }, [plane, viewMode, ct, volume, focusRas, noduleRas, noduleAsset, routePoints, airwayFrame, sliceOffset, showRoute, highlightEdges]);

  const title = viewMode === "standard" ? STANDARD_TITLES[plane] : AIRWAY_TITLES[plane];

  return (
    <section ref={sectionRef} className="ct-pane">
      <div className="pane-chrome">
        <span>{title}</span>
        <span>{viewMode === "standard" ? standardSliceLabel(plane, focusRas, ct, sliceOffset) : airwaySliceLabel(plane, sliceOffset)}</span>
      </div>
      <div className="ct-canvas-wrap">
        <canvas ref={canvasRef} className="ct-canvas" style={{ transform: `scale(${zoom})` }} />
      </div>
    </section>
  );
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
  noduleRas: Vec3,
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
      const ras = noduleAsset ? indexToRas({ i: vx, j: vy, k: vz }, ct) : null;
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
  noduleRas: Vec3,
  noduleAsset: LoadedNoduleAsset | null
): DrawInfo {
  const width = 256;
  const height = 256;
  const axes = airwayPlaneAxes(plane, frame);
  const scrollMm = sliceOffset * 2.0;
  const origin = add(frame.origin, scale(axes.normal, scrollMm));
  const fovX = plane === "axial" ? 72 : 132;
  const fovY = plane === "axial" ? 72 : 96;
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
  noduleRas: Vec3,
  noduleAsset: LoadedNoduleAsset | null,
  windowHu: [number, number]
) {
  if (!noduleAsset) {
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
