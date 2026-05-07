import { useEffect, useRef, useState, type PointerEvent } from "react";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import type { Decision, ScopeAdjustment, Vec3 } from "../types";
import { add, normalize, rasToScene, scale, subtract } from "../geometry";
import { type CaseIndexes, optionPathPoints } from "../route";

interface ScopeLabel {
  label: string;
  x: number;
  y: number;
  state: "neutral" | "correct" | "wrong" | "correct-unselected";
  visible: boolean;
}

export interface ScopeCameraPose {
  cameraRas: Vec3;
  targetRas: Vec3;
}

interface BronchoscopeViewProps {
  decision: Decision | null;
  indexes: CaseIndexes;
  selectedEdgeId: number | null;
  drivePose?: ScopeCameraPose | null;
  applyDriveAdjustment?: boolean;
  showDecisionLabels?: boolean;
  statusLabel?: string;
  debugMode?: boolean;
  adjustment?: ScopeAdjustment;
  onAdjustmentChange?: (adjustment: ScopeAdjustment) => void;
  meshUrl?: string;
}

export const DEFAULT_SCOPE_ADJUSTMENT: ScopeAdjustment = {
  cameraBackMm: 18,
  lookAheadMm: 30,
  yawDeg: 0,
  pitchDeg: 0,
  rollDeg: 0,
  fovDeg: 84,
  labelOffsets: {}
};

const geometryCache = new Map<string, Promise<THREE.BufferGeometry>>();
const BRANCH_BACK_MM = 18;
const SHORT_SEGMENT_BACK_FRACTION = 0.7;
const PARENT_CLEARANCE_MM = 3;

export function normalizeScopeAdjustment(adjustment?: Partial<ScopeAdjustment>): ScopeAdjustment {
  return {
    cameraBackMm: numberOrDefault(adjustment?.cameraBackMm, DEFAULT_SCOPE_ADJUSTMENT.cameraBackMm),
    lookAheadMm: numberOrDefault(adjustment?.lookAheadMm, DEFAULT_SCOPE_ADJUSTMENT.lookAheadMm),
    yawDeg: numberOrDefault(adjustment?.yawDeg, DEFAULT_SCOPE_ADJUSTMENT.yawDeg),
    pitchDeg: numberOrDefault(adjustment?.pitchDeg, DEFAULT_SCOPE_ADJUSTMENT.pitchDeg),
    rollDeg: numberOrDefault(adjustment?.rollDeg, DEFAULT_SCOPE_ADJUSTMENT.rollDeg),
    fovDeg: numberOrDefault(adjustment?.fovDeg, DEFAULT_SCOPE_ADJUSTMENT.fovDeg),
    labelOffsets: adjustment?.labelOffsets ?? {}
  };
}

function numberOrDefault(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function BronchoscopeView({
  decision,
  indexes,
  selectedEdgeId,
  drivePose = null,
  applyDriveAdjustment = false,
  showDecisionLabels = true,
  statusLabel,
  debugMode = false,
  adjustment: rawAdjustment,
  onAdjustmentChange,
  meshUrl = "/cases/default/airway_surface.stl"
}: BronchoscopeViewProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const headlightRef = useRef<THREE.PointLight | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const labelsVisibleRef = useRef(false);
  const renderRef = useRef<() => void>(() => {});
  const [labels, setLabels] = useState<ScopeLabel[]>([]);
  const [meshStatus, setMeshStatus] = useState<"loading" | "ready" | "error">("loading");
  const adjustment = normalizeScopeAdjustment(rawAdjustment);

  renderRef.current = () => {
    const mount = mountRef.current;
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const headlight = headlightRef.current;
    if (!mount || !renderer || !scene || !camera || !headlight) {
      return;
    }
    positionCamera(camera, decision, indexes, adjustment, drivePose, applyDriveAdjustment);
    camera.updateMatrixWorld(true);
    headlight.position.copy(camera.position);
    if (showDecisionLabels && decision) {
      labelsVisibleRef.current = true;
      updateLabels(camera, mount, decision, indexes, selectedEdgeId, adjustment, setLabels);
    } else if (labelsVisibleRef.current) {
      labelsVisibleRef.current = false;
      setLabels([]);
    }
    renderer.render(scene, camera);
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return;
    }
    mount.innerHTML = "";
    setLabels([]);
    labelsVisibleRef.current = false;
    setMeshStatus("loading");

    let cancelled = false;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setClearColor(0x070201, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.35;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070201);

    const camera = new THREE.PerspectiveCamera(84, mount.clientWidth / Math.max(mount.clientHeight, 1), 0.12, 900);
    camera.up.copy(toVector3([0, 1, 0]).normalize());

    const headlight = new THREE.PointLight(0xffd1ad, 18, 180, 1.1);
    headlight.position.copy(camera.position);
    scene.add(headlight);
    scene.add(new THREE.AmbientLight(0xffb08a, 0.65));

    const material = createBronchoscopyMaterial();
    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    headlightRef.current = headlight;
    materialRef.current = material;

    loadAirwayGeometry(meshUrl)
      .then((geometry) => {
        if (cancelled) {
          return;
        }
        setMeshStatus("ready");
        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);
        renderRef.current();
      })
      .catch(() => {
        if (!cancelled) {
          setMeshStatus("error");
          renderRef.current();
        }
      });

    const onResize = () => {
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      camera.aspect = mount.clientWidth / Math.max(mount.clientHeight, 1);
      camera.updateProjectionMatrix();
      renderRef.current();
    };
    window.addEventListener("resize", onResize);
    renderRef.current();

    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      materialRef.current?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      headlightRef.current = null;
      materialRef.current = null;
      mount.innerHTML = "";
    };
  }, [meshUrl]);

  useEffect(() => {
    renderRef.current();
  }, [
    decision,
    indexes,
    selectedEdgeId,
    showDecisionLabels,
    adjustment.cameraBackMm,
    adjustment.lookAheadMm,
    adjustment.yawDeg,
    adjustment.pitchDeg,
    adjustment.rollDeg,
    adjustment.fovDeg,
    adjustment.labelOffsets,
    applyDriveAdjustment,
    drivePose?.cameraRas[0],
    drivePose?.cameraRas[1],
    drivePose?.cameraRas[2],
    drivePose?.targetRas[0],
    drivePose?.targetRas[1],
    drivePose?.targetRas[2]
  ]);

  const beginLabelDrag = (item: ScopeLabel, event: PointerEvent<HTMLSpanElement>) => {
    if (!debugMode || !onAdjustmentChange) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const startOffset = adjustment.labelOffsets[item.label] ?? { x: 0, y: 0 };
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const nextOffset = {
        x: Math.round(startOffset.x + moveEvent.clientX - startX),
        y: Math.round(startOffset.y + moveEvent.clientY - startY)
      };
      onAdjustmentChange({
        ...adjustment,
        labelOffsets: {
          ...adjustment.labelOffsets,
          [item.label]: nextOffset
        }
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <section className="scope-panel">
      <div className="pane-chrome">
        <span>Virtual bronchoscope</span>
        <span>{statusLabel ?? (decision ? `Decision ${decision.index + 1}` : "Complete")}</span>
      </div>
      <div className="scope-mask scope-mask-real">
        <div ref={mountRef} className="scope-render" />
        {meshStatus === "loading" && <div className="scope-status">Loading airway surface</div>}
        {meshStatus === "error" && <div className="scope-status">Airway surface unavailable</div>}
        {labels.map((item) => (
          <span
            key={item.label}
            className={`scope-label scope-label-${item.state} ${debugMode ? "scope-label-debug" : ""}`}
            style={{
              left: `${item.x}px`,
              top: `${item.y}px`,
              opacity: item.visible ? 1 : 0
            }}
            onPointerDown={(event) => beginLabelDrag(item, event)}
          >
            {item.label}
          </span>
        ))}
      </div>
    </section>
  );
}

function loadAirwayGeometry(url: string): Promise<THREE.BufferGeometry> {
  const cached = geometryCache.get(url);
  if (cached) {
    return cached;
  }
  const promise = new STLLoader().loadAsync(url).then((geometry) => {
    const positions = geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i += 1) {
      const l = positions.getX(i);
      const p = positions.getY(i);
      const s = positions.getZ(i);
      positions.setXYZ(i, -l, s, p);
    }
    positions.needsUpdate = true;
    geometry.deleteAttribute("normal");
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    return geometry;
  });
  geometryCache.set(url, promise);
  return promise;
}

function createBronchoscopyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: `
      varying vec3 vWorldPosition;
      varying vec3 vNormalWorld;

      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        vNormalWorld = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vWorldPosition;
      varying vec3 vNormalWorld;

      float hash(vec3 p) {
        return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
      }

      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPosition);
        vec3 n = normalize(vNormalWorld);
        if (dot(n, viewDir) < 0.0) {
          n = -n;
        }

        float dist = length(cameraPosition - vWorldPosition);
        float headlight = max(dot(n, viewDir), 0.0);
        float falloff = mix(1.18, 0.20, smoothstep(28.0, 145.0, dist));

        vec3 p = vWorldPosition * 0.055;
        float broadFold = 0.5 + 0.5 * sin(p.z * 5.5 + p.y * 2.2 + sin(p.x * 2.6) * 1.4);
        float fineFold = 0.5 + 0.5 * sin(p.x * 12.0 + p.y * 7.0 + p.z * 4.0);
        float speckle = hash(floor(vWorldPosition * 0.95));
        float mucosa = 0.78 + broadFold * 0.18 + fineFold * 0.055 + (speckle - 0.5) * 0.045;

        vec3 shadowTone = vec3(0.38, 0.105, 0.075);
        vec3 midTone = vec3(0.92, 0.42, 0.285);
        vec3 highTone = vec3(1.0, 0.72, 0.49);
        vec3 base = mix(shadowTone, midTone, clamp(mucosa, 0.0, 1.0));
        base = mix(base, highTone, pow(headlight, 2.4) * 0.38);

        float rimWet = pow(max(dot(reflect(-viewDir, n), viewDir), 0.0), 20.0);
        float sparkleGate = smoothstep(0.982, 1.0, hash(floor(vWorldPosition * 2.15)));
        float sparkle = sparkleGate * pow(headlight, 10.0) * 0.58;

        float exposure = 0.58 + headlight * 1.45;
        vec3 color = base * exposure * falloff;
        color += vec3(1.0, 0.86, 0.68) * (rimWet * 0.38 + sparkle);

        float depthDarken = smoothstep(80.0, 185.0, dist);
        color = mix(color, vec3(0.035, 0.012, 0.009), depthDarken * 0.82);
        color = pow(max(color, vec3(0.0)), vec3(0.82));

        gl_FragColor = vec4(color, 1.0);
      }
    `
  });
}

function positionCamera(
  camera: THREE.PerspectiveCamera,
  decision: Decision | null,
  indexes: CaseIndexes,
  adjustment: ScopeAdjustment,
  drivePose: ScopeCameraPose | null,
  applyDriveAdjustment: boolean
) {
  const useDrivePose = Boolean(drivePose && !(applyDriveAdjustment && decision));
  const cameraAdjustment = useDrivePose ? DEFAULT_SCOPE_ADJUSTMENT : adjustment;
  camera.fov = cameraAdjustment.fovDeg;
  camera.updateProjectionMatrix();
  if (useDrivePose && drivePose) {
    aimCamera(camera, toVector3(drivePose.cameraRas), toVector3(drivePose.targetRas), cameraAdjustment);
    return;
  }
  if (!decision) {
    camera.position.set(0, 0, 240);
    camera.lookAt(0, 0, 0);
    return;
  }
  const node = indexes.nodesById.get(decision.nodeId);
  if (!node) {
    camera.position.set(0, 0, 240);
    camera.lookAt(0, 0, 0);
    return;
  }

  const incoming = incomingDirection(decision.nodeId, indexes);
  const cameraBackMm = safeIncomingBackDistance(adjustment.cameraBackMm, availableIncomingDistance(node, indexes));
  const cameraRas = add(node.ras, scale(incoming, -cameraBackMm));
  const targetRas = add(node.ras, scale(averageOptionDirection(decision, indexes, incoming), adjustment.lookAheadMm));
  aimCamera(camera, toVector3(cameraRas), toVector3(targetRas), cameraAdjustment);
}

function aimCamera(camera: THREE.PerspectiveCamera, cameraPosition: THREE.Vector3, targetPosition: THREE.Vector3, adjustment: ScopeAdjustment) {
  const upHint = toVector3([0, 1, 0]).normalize();
  const forward = targetPosition.clone().sub(cameraPosition);
  if (forward.lengthSq() < 1e-6) {
    forward.set(0, 0, -1);
  }
  forward.normalize();
  let right = new THREE.Vector3().crossVectors(forward, upHint).normalize();
  if (right.lengthSq() < 1e-6) {
    right = new THREE.Vector3(1, 0, 0);
  }
  let up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const yaw = new THREE.Quaternion().setFromAxisAngle(up, THREE.MathUtils.degToRad(adjustment.yawDeg));
  forward.applyQuaternion(yaw).normalize();
  right.applyQuaternion(yaw).normalize();
  const pitch = new THREE.Quaternion().setFromAxisAngle(right, THREE.MathUtils.degToRad(adjustment.pitchDeg));
  forward.applyQuaternion(pitch).normalize();
  up.applyQuaternion(pitch).normalize();
  camera.up.copy(up);
  camera.position.copy(cameraPosition);
  camera.lookAt(cameraPosition.clone().add(forward));
  camera.rotateZ(THREE.MathUtils.degToRad(adjustment.rollDeg));
}

function updateLabels(
  camera: THREE.PerspectiveCamera,
  mount: HTMLElement,
  decision: Decision | null,
  indexes: CaseIndexes,
  selectedEdgeId: number | null,
  adjustment: ScopeAdjustment,
  setLabels: (labels: ScopeLabel[]) => void
) {
  if (!decision) {
    setLabels([]);
    return;
  }
  const node = indexes.nodesById.get(decision.nodeId);
  if (!node) {
    setLabels([]);
    return;
  }
  const width = mount.clientWidth;
  const height = mount.clientHeight;
  const labels = decision.options.map((option) => {
    const points = optionPathPoints(decision, option, indexes);
    const labelRas = pointAlong(points, 16);
    const projected = toVector3(labelRas).project(camera);
    const offset = adjustment.labelOffsets[option.label] ?? { x: 0, y: 0 };
    const selected = selectedEdgeId === option.edgeId;
    const state: ScopeLabel["state"] = selected
      ? option.isCorrect
        ? "correct"
        : "wrong"
      : selectedEdgeId != null && option.isCorrect
        ? "correct-unselected"
        : "neutral";
    return {
      label: option.label,
      x: (projected.x * 0.5 + 0.5) * width + offset.x,
      y: (-projected.y * 0.5 + 0.5) * height + offset.y,
      visible: projected.z > -1 && projected.z < 1,
      state
    };
  });
  setLabels(labels);
}

function incomingDirection(nodeId: number, indexes: CaseIndexes): Vec3 {
  const node = indexes.nodesById.get(nodeId);
  const parent = node?.parentNodeId == null ? null : indexes.nodesById.get(node.parentNodeId);
  return node && parent ? normalize(subtract(node.ras, parent.ras), [0, 0, -1]) : [0, 0, -1];
}

function availableIncomingDistance(node: { rootDistanceMm: number; parentNodeId: number | null }, indexes: CaseIndexes): number {
  const parent = node.parentNodeId == null ? null : indexes.nodesById.get(node.parentNodeId);
  return parent ? Math.max(0, node.rootDistanceMm - parent.rootDistanceMm) : BRANCH_BACK_MM;
}

function safeIncomingBackDistance(requestedBackMm: number, availableIncomingMm: number): number {
  if (!Number.isFinite(availableIncomingMm) || availableIncomingMm <= 0) {
    return requestedBackMm;
  }
  const shortSegmentBackMm = Math.max(availableIncomingMm * SHORT_SEGMENT_BACK_FRACTION, availableIncomingMm - PARENT_CLEARANCE_MM);
  return Math.max(0, Math.min(requestedBackMm, BRANCH_BACK_MM, shortSegmentBackMm));
}

function averageOptionDirection(decision: Decision, indexes: CaseIndexes, fallback: Vec3): Vec3 {
  const node = indexes.nodesById.get(decision.nodeId);
  if (!node) {
    return fallback;
  }
  const out: Vec3 = [0, 0, 0];
  decision.options.forEach((option) => {
    const points = optionPathPoints(decision, option, indexes);
    const direction = normalize(subtract(points[Math.min(1, points.length - 1)] ?? node.ras, points[0] ?? node.ras), fallback);
    out[0] += direction[0];
    out[1] += direction[1];
    out[2] += direction[2];
  });
  return normalize(out, fallback);
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

function toVector3(ras: Vec3): THREE.Vector3 {
  const point = rasToScene(ras);
  return new THREE.Vector3(point[0], point[1], point[2]);
}
