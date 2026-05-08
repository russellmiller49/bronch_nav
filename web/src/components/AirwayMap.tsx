import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import type { Decision, RouteState, Vec3, WebCase } from "../types";
import { rasToScene } from "../geometry";
import { childNodeForEdge, type CaseIndexes, optionPathPoints, orientedEdgePoints } from "../route";
import type { CandidateOverlay } from "./CtPane";

declare const __APP_BASE_PATH__: string;

interface MapLabel {
  key: string;
  label: string;
  x: number;
  y: number;
  state: "neutral" | "correct" | "wrong" | "candidate";
}

interface AirwayMapProps {
  webCase: WebCase;
  indexes: CaseIndexes;
  route: RouteState;
  decision: Decision | null;
  candidateOverlays: CandidateOverlay[];
  selectedEndpointId: number;
  selectableEndpointIds?: number[];
  noduleRas: Vec3;
  noduleRadiusMm?: number | null;
  selectedEdgeId: number | null;
  committedEdgeIds?: number[];
  driveRas?: Vec3 | null;
  onEndpointChange?: (nodeId: number) => void;
  meshUrl?: string;
  noduleMeshUrl?: string | null;
}

const surfaceGeometryCache = new Map<string, Promise<THREE.BufferGeometry>>();
const noduleGeometryCache = new Map<string, Promise<THREE.BufferGeometry>>();

function appAssetUrl(path: string) {
  return new URL(path, new URL(__APP_BASE_PATH__, window.location.origin)).toString();
}

export function AirwayMap({
  webCase,
  indexes,
  route,
  decision,
  candidateOverlays,
  selectedEndpointId,
  selectableEndpointIds = [],
  noduleRas,
  noduleRadiusMm = null,
  selectedEdgeId,
  committedEdgeIds = [],
  driveRas = null,
  onEndpointChange,
  meshUrl = appAssetUrl("cases/default/airway_surface.stl"),
  noduleMeshUrl = null
}: AirwayMapProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const onEndpointChangeRef = useRef(onEndpointChange);
  const [labels, setLabels] = useState<MapLabel[]>([]);

  useEffect(() => {
    onEndpointChangeRef.current = onEndpointChange;
  }, [onEndpointChange]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return;
    }
    const mountEl = mount;
    mount.innerHTML = "";

    let cancelled = false;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = fitOverviewCamera(webCase, mount.clientWidth, mount.clientHeight);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(airwaySceneCenter(webCase));
    controls.enableDamping = false;
    controls.enablePan = true;
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    controls.touches.ONE = THREE.TOUCH.ROTATE;
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    controls.update();
    scene.add(new THREE.AmbientLight(0xc6f6ff, 0.85));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.7);
    keyLight.position.set(180, 240, 320);
    scene.add(keyLight);

    addAirwayLines(scene, webCase, 0x5e8790, 0.18);
    addRouteTube(scene, route.routePoints, 0x2fe2ff, 2.0, 0.98);
    addRouteLines(scene, indexes, route.edgePath, route.nodePath, 0xb7fbff, 0.9);
    addEdgeHighlights(scene, indexes, committedEdgeIds, 0x2ef082, 1);
    if (decision) {
      addDecisionLines(scene, indexes, decision, selectedEdgeId);
      addCurrentMarker(scene, decision.nodeRas);
    } else if (driveRas) {
      addCurrentMarker(scene, driveRas);
    }
    addEndpointDots(scene, webCase, 0.78);
    addTargetEndpointDots(scene, indexes, selectableEndpointIds.length ? selectableEndpointIds : [selectedEndpointId], selectedEndpointId);

    const renderScene = () => {
      updateLabels();
      renderer.render(scene, camera);
    };
    controls.addEventListener("change", renderScene);

    const addFallbackNodule = () => {
      addNodule(scene, noduleRas, noduleRadiusMm);
      renderScene();
    };

    if (noduleMeshUrl) {
      loadNoduleGeometry(noduleMeshUrl)
        .then((geometry) => {
          if (cancelled) {
            return;
          }
          addNoduleMesh(scene, geometry, noduleRas);
          renderScene();
        })
        .catch(() => {
          if (!cancelled) {
            addFallbackNodule();
          }
        });
    } else {
      addFallbackNodule();
    }

    loadAirwaySurface(meshUrl)
      .then((geometry) => {
        if (cancelled) {
          return;
        }
        const mesh = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({
            color: 0x8fd1d6,
            roughness: 0.55,
            metalness: 0,
            transparent: true,
            opacity: 0.2,
            depthWrite: false,
            side: THREE.DoubleSide
          })
        );
        scene.add(mesh);
        renderScene();
      })
      .catch(() => {
        renderScene();
      });

    const terminalScreenPoints = () => {
      const selectable = selectableEndpointIds.length ? selectableEndpointIds : webCase.airway.terminalNodeIds;
      return selectable
        .map((nodeId) => {
          const node = indexes.nodesById.get(nodeId);
          if (!node) {
            return null;
          }
          const projected = toVector3(node.ras).project(camera);
          return {
            nodeId,
            x: (projected.x * 0.5 + 0.5) * mount.clientWidth,
            y: (-projected.y * 0.5 + 0.5) * mount.clientHeight
          };
        })
        .filter(Boolean) as { nodeId: number; x: number; y: number }[];
    };

    function updateLabels() {
      if (!decision) {
        setLabels([]);
        return;
      }
      const decisionScreen = projectToScreen(decision.nodeRas, camera, mountEl);
      const next: MapLabel[] = decision.options.map((option, index) => {
        const labelPoint = pointAlong(optionPathPoints(decision, option, indexes), 28);
        const branchScreen = projectToScreen(labelPoint, camera, mountEl);
        const labelScreen = labelNearDecision(decisionScreen, branchScreen, index, decision.options.length, mountEl);
        const isSelected = selectedEdgeId === option.edgeId;
        const state: MapLabel["state"] = !isSelected ? "neutral" : option.isCorrect ? "correct" : "wrong";
        return {
          key: `choice-${option.edgeId}`,
          label: option.label,
          x: labelScreen.x,
          y: labelScreen.y,
          state
        };
      });
      candidateOverlays.forEach((candidate, index) => {
        const node = indexes.nodesById.get(decision.nodeId);
        if (!node) {
          return;
        }
        const labelPoint = pointAlong(orientedEdgePoints(candidate.edge, node.id, childNodeForEdge(candidate.edge, node.id, indexes)), 58);
        const branchScreen = projectToScreen(labelPoint, camera, mountEl);
        const spread = (index - (candidateOverlays.length - 1) / 2) * 16;
        next.push({
          key: `candidate-${candidate.edge.id}-${candidate.label}`,
          label: `${candidate.label} ${candidate.score.toFixed(2)}`,
          x: clampScreen(branchScreen.x, 42, mountEl.clientWidth - 42),
          y: clampScreen(branchScreen.y + spread, 18, mountEl.clientHeight - 18),
          state: "candidate"
        });
      });
      setLabels(next);
    }

    let dragging = false;
    const pickEndpoint = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      let nearest = selectedEndpointId;
      let nearestDistance = Number.POSITIVE_INFINITY;
      terminalScreenPoints().forEach((point) => {
        const d = Math.hypot(point.x - x, point.y - y);
        if (d < nearestDistance) {
          nearestDistance = d;
          nearest = point.nodeId;
        }
      });
      if (nearestDistance < 64) {
        onEndpointChangeRef.current?.(nearest);
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      renderer.domElement.setPointerCapture(event.pointerId);
      pickEndpoint(event);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (dragging) {
        pickEndpoint(event);
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      dragging = false;
      renderer.domElement.releasePointerCapture(event.pointerId);
      pickEndpoint(event);
    };
    const onResize = () => {
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      const nextCamera = fitOverviewCamera(webCase, mount.clientWidth, mount.clientHeight);
      camera.left = nextCamera.left;
      camera.right = nextCamera.right;
      camera.top = nextCamera.top;
      camera.bottom = nextCamera.bottom;
      camera.position.copy(nextCamera.position);
      camera.quaternion.copy(nextCamera.quaternion);
      camera.updateProjectionMatrix();
      controls.target.copy(airwaySceneCenter(webCase));
      controls.update();
      renderScene();
    };

    if (onEndpointChange) {
      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      renderer.domElement.addEventListener("pointermove", onPointerMove);
      renderer.domElement.addEventListener("pointerup", onPointerUp);
    }
    window.addEventListener("resize", onResize);
    renderScene();

    return () => {
      cancelled = true;
      controls.removeEventListener("change", renderScene);
      controls.dispose();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      renderer.forceContextLoss();
      mount.innerHTML = "";
    };
  }, [webCase, indexes, route, decision, candidateOverlays, selectedEndpointId, selectableEndpointIds, noduleRas, noduleRadiusMm, selectedEdgeId, committedEdgeIds, driveRas, onEndpointChange, meshUrl, noduleMeshUrl]);

  return (
    <section className="map-panel">
      <div className="pane-chrome">
        <span>3D airway path</span>
        <span>drag rotate / scroll zoom</span>
      </div>
      <div className="map-render-wrap">
        <div ref={mountRef} className="map-render" />
        {labels.map((item) => (
          <span
            key={item.key}
            className={`map-label map-label-${item.state}`}
            style={{ left: `${item.x}px`, top: `${item.y}px` }}
          >
            {item.label}
          </span>
        ))}
      </div>
    </section>
  );
}

function loadAirwaySurface(url: string): Promise<THREE.BufferGeometry> {
  const cached = surfaceGeometryCache.get(url);
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
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  });
  surfaceGeometryCache.set(url, promise);
  return promise;
}

function loadNoduleGeometry(url: string): Promise<THREE.BufferGeometry> {
  const cached = noduleGeometryCache.get(url);
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
    geometry.computeBoundingBox();
    geometry.center();
    geometry.computeBoundingSphere();
    return geometry;
  });
  noduleGeometryCache.set(url, promise);
  return promise;
}

function fitOverviewCamera(webCase: WebCase, width: number, height: number): THREE.OrthographicCamera {
  const { center, span } = airwaySceneBounds(webCase);
  const aspect = width / Math.max(height, 1);
  const camera = new THREE.OrthographicCamera((-span * aspect) / 2, (span * aspect) / 2, span / 2, -span / 2, -1000, 1000);
  camera.up.set(0, 1, 0);
  camera.position.set(center.x, center.y + span * 0.04, center.z - span * 1.08);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return camera;
}

function airwaySceneCenter(webCase: WebCase): THREE.Vector3 {
  return airwaySceneBounds(webCase).center;
}

function airwaySceneBounds(webCase: WebCase) {
  const points = webCase.airway.nodes.map((node) => rasToScene(node.ras));
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const minY = Math.min(...points.map((point) => point[1]));
  const maxY = Math.max(...points.map((point) => point[1]));
  const minZ = Math.min(...points.map((point) => point[2]));
  const maxZ = Math.max(...points.map((point) => point[2]));
  return {
    center: new THREE.Vector3((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5),
    span: Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 1.55
  };
}

function addAirwayLines(scene: THREE.Scene, webCase: WebCase, color: number, opacity: number) {
  const positions: number[] = [];
  webCase.airway.edges.forEach((edge) => {
    for (let i = 1; i < edge.pointsRas.length; i += 1) {
      const a = rasToScene(edge.pointsRas[i - 1]);
      const b = rasToScene(edge.pointsRas[i]);
      positions.push(...a, ...b);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  scene.add(
    new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity
      })
    )
  );
}

function addRouteLines(scene: THREE.Scene, indexes: CaseIndexes, edgePath: number[], nodePath: number[], color: number, opacity: number) {
  const positions: number[] = [];
  edgePath.forEach((edgeId, index) => {
    const edge = indexes.edgesById.get(edgeId);
    if (!edge) {
      return;
    }
    const points = orientedEdgePoints(edge, nodePath[index], nodePath[index + 1]);
    for (let i = 1; i < points.length; i += 1) {
      positions.push(...rasToScene(points[i - 1]), ...rasToScene(points[i]));
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  scene.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity })));
}

function addEdgeHighlights(scene: THREE.Scene, indexes: CaseIndexes, edgeIds: number[], color: number, opacity: number) {
  const uniqueEdgeIds = edgeIds.filter((edgeId, index) => edgeIds.indexOf(edgeId) === index);
  uniqueEdgeIds.forEach((edgeId) => {
    const edge = indexes.edgesById.get(edgeId);
    if (edge) {
      addPointLine(scene, edge.pointsRas, color, opacity);
    }
  });
}

function addRouteTube(scene: THREE.Scene, pointsRas: Vec3[], color: number, radius: number, opacity: number) {
  if (pointsRas.length < 2) {
    return;
  }
  const curve = new THREE.CatmullRomCurve3(pointsRas.map(toVector3));
  const geometry = new THREE.TubeGeometry(curve, Math.max(24, pointsRas.length * 8), radius, 12, false);
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity });
  scene.add(new THREE.Mesh(geometry, material));
}

function addDecisionLines(scene: THREE.Scene, indexes: CaseIndexes, decision: Decision, selectedEdgeId: number | null) {
  decision.options.forEach((option) => {
    const points = optionPathPoints(decision, option, indexes);
    if (points.length < 2) {
      return;
    }
    const color = selectedEdgeId === option.edgeId ? (option.isCorrect ? 0x29f07f : 0xff5964) : option.isCorrect && selectedEdgeId != null ? 0xffd43a : 0xf2c94c;
    addPointLine(scene, points, color, 1);
  });
}

function addPointLine(scene: THREE.Scene, pointsRas: Vec3[], color: number, opacity: number) {
  const positions: number[] = [];
  for (let i = 1; i < pointsRas.length; i += 1) {
    positions.push(...rasToScene(pointsRas[i - 1]), ...rasToScene(pointsRas[i]));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  scene.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity })));
}

function addEndpointDots(scene: THREE.Scene, webCase: WebCase, opacity = 0.78) {
  const positions: number[] = [];
  webCase.airway.terminalNodeIds.forEach((nodeId) => {
    const node = webCase.airway.nodes.find((candidate) => candidate.id === nodeId);
    if (node) {
      positions.push(...rasToScene(node.ras));
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  scene.add(new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x9af6ff, size: 3.1, sizeAttenuation: false, transparent: true, opacity })));
}

function addTargetEndpointDots(scene: THREE.Scene, indexes: CaseIndexes, endpointIds: number[], selectedEndpointId: number) {
  const acceptedEndpointIds = endpointIds.filter((nodeId, index) => endpointIds.indexOf(nodeId) === index);
  const acceptedPositions: number[] = [];
  acceptedEndpointIds.forEach((nodeId) => {
    const node = indexes.nodesById.get(nodeId);
    if (node) {
      acceptedPositions.push(...rasToScene(node.ras));
    }
  });
  if (acceptedPositions.length) {
    const acceptedGeometry = new THREE.BufferGeometry();
    acceptedGeometry.setAttribute("position", new THREE.Float32BufferAttribute(acceptedPositions, 3));
    scene.add(
      new THREE.Points(
        acceptedGeometry,
        new THREE.PointsMaterial({ color: 0xff8f5f, size: 6.2, sizeAttenuation: false, transparent: true, opacity: 0.96 })
      )
    );
  }

  const selectedNode = indexes.nodesById.get(selectedEndpointId);
  if (selectedNode) {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(4.0, 18, 10),
      new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0.98 })
    );
    marker.position.copy(toVector3(selectedNode.ras));
    scene.add(marker);
  }
}

function addNodule(scene: THREE.Scene, ras: Vec3, radiusMm: number | null) {
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(6.2, radiusMm ?? 6.2), 32, 18),
    new THREE.MeshBasicMaterial({ color: 0xff5964, transparent: true, opacity: radiusMm ? 0.36 : 0.95 })
  );
  marker.position.copy(toVector3(ras));
  scene.add(marker);
}

function addNoduleMesh(scene: THREE.Scene, geometry: THREE.BufferGeometry, ras: Vec3) {
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color: 0xff5f6d,
      roughness: 0.42,
      metalness: 0.02,
      transparent: true,
      opacity: 0.94
    })
  );
  mesh.position.copy(toVector3(ras));
  scene.add(mesh);
}

function addCurrentMarker(scene: THREE.Scene, ras: Vec3) {
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(4.4, 20, 12),
    new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0.98 })
  );
  marker.position.copy(toVector3(ras));
  scene.add(marker);
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

function projectToScreen(ras: Vec3, camera: THREE.Camera, mount: HTMLElement) {
  const projected = toVector3(ras).project(camera);
  return {
    x: (projected.x * 0.5 + 0.5) * mount.clientWidth,
    y: (-projected.y * 0.5 + 0.5) * mount.clientHeight
  };
}

function labelNearDecision(
  decisionScreen: { x: number; y: number },
  branchScreen: { x: number; y: number },
  index: number,
  count: number,
  mount: HTMLElement
) {
  const spread = count <= 1 ? 0 : (index - (count - 1) / 2) * 18;
  let dx = branchScreen.x - decisionScreen.x;
  let dy = branchScreen.y - decisionScreen.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) {
    const angle = -Math.PI / 2 + (index + 0.5) * (Math.PI / Math.max(count, 1));
    dx = Math.cos(angle);
    dy = Math.sin(angle);
  } else {
    dx /= length;
    dy /= length;
  }
  const px = -dy;
  const py = dx;
  return {
    x: clampScreen(decisionScreen.x + dx * 42 + px * spread, 18, mount.clientWidth - 18),
    y: clampScreen(decisionScreen.y + dy * 42 + py * spread, 18, mount.clientHeight - 18)
  };
}

function clampScreen(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function toVector3(ras: Vec3): THREE.Vector3 {
  const point = rasToScene(ras);
  return new THREE.Vector3(point[0], point[1], point[2]);
}
