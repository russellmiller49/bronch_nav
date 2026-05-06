import type { CtMetadata, Vec3 } from "./types";

export type PlaneKind = "axial" | "coronal" | "sagittal";
export type CtViewMode = "standard" | "airway";

export interface IndexPoint {
  i: number;
  j: number;
  k: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function rasToIndex(ras: Vec3, ct: CtMetadata): IndexPoint {
  const lps: Vec3 = [-ras[0], -ras[1], ras[2]];
  return {
    i: (lps[0] - ct.originLps[0]) / ct.spacingXyzMm[0],
    j: (lps[1] - ct.originLps[1]) / ct.spacingXyzMm[1],
    k: (lps[2] - ct.originLps[2]) / ct.spacingXyzMm[2]
  };
}

export function indexToRas(index: IndexPoint, ct: CtMetadata): Vec3 {
  const lps: Vec3 = [
    ct.originLps[0] + index.i * ct.spacingXyzMm[0],
    ct.originLps[1] + index.j * ct.spacingXyzMm[1],
    ct.originLps[2] + index.k * ct.spacingXyzMm[2]
  ];
  return [-lps[0], -lps[1], lps[2]];
}

export function projectRasToPlane(ras: Vec3, ct: CtMetadata, plane: PlaneKind) {
  const idx = rasToIndex(ras, ct);
  const [sx, sy, sz] = ct.sizeXyz;
  if (plane === "axial") {
    return { x: idx.i, y: idx.j, depth: idx.k, width: sx, height: sy };
  }
  if (plane === "coronal") {
    return { x: idx.i, y: sz - 1 - idx.k, depth: idx.j, width: sx, height: sz };
  }
  return { x: idx.j, y: sz - 1 - idx.k, depth: idx.i, width: sy, height: sz };
}

export function distance(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.hypot(dx, dy, dz);
}

export function normalize(v: Vec3, fallback: Vec3 = [0, 0, -1]): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (n < 1e-8) {
    return fallback;
  }
  return [v[0] / n, v[1] / n, v[2] / n];
}

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

export function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function rasToScene(ras: Vec3): Vec3 {
  return [ras[0], ras[2], -ras[1]];
}
