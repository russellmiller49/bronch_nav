import type { AirwayCandidateLabel, AirwayCandidatePayload, LoadedCase, LoadedNoduleAsset, NoduleAssetMetadata, WebCase } from "./types";

declare const __APP_BASE_PATH__: string;

export async function loadCase(caseUrl = appAssetUrl("cases/default/case.json")): Promise<LoadedCase> {
  const metadata = (await fetch(caseUrl).then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load case metadata: ${response.status}`);
    }
    return response.json();
  })) as WebCase;
  const candidatePayload = await fetchCandidateSidecar(metadata, caseUrl);
  if (candidatePayload) {
    mergeCandidateLabels(metadata, candidatePayload);
  }
  const scopeCalibrationPayload = await fetchScopeCalibrationSidecar(metadata, caseUrl);
  if (scopeCalibrationPayload) {
    metadata.scopeCalibration = scopeCalibrationPayload;
  }

  const rawUrl = new URL(metadata.ct.raw, new URL(caseUrl, window.location.origin)).toString();
  const buffer = await fetch(rawUrl).then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load CT preview volume: ${response.status}`);
    }
    return response.arrayBuffer();
  });

  const noduleAsset = metadata.noduleAsset ? await loadNoduleAsset(metadata.noduleAsset, caseUrl) : null;
  const noduleAssets: Record<string, LoadedNoduleAsset> = {};
  for (const target of metadata.noduleTargets ?? []) {
    noduleAssets[target.id] = await loadNoduleAsset(target.noduleAsset, caseUrl);
  }

  return { metadata, volume: new Uint8Array(buffer), noduleAsset, noduleAssets };
}

function appAssetUrl(path: string) {
  return new URL(path, new URL(__APP_BASE_PATH__, window.location.origin)).toString();
}

async function fetchScopeCalibrationSidecar(metadata: WebCase, caseUrl: string) {
  const sidecarPath = metadata.scopeCalibrationJson ?? "scope_calibration.json";
  const url = new URL(sidecarPath, new URL(caseUrl, window.location.origin)).toString();
  return fetch(url).then(async (response) => {
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Failed to load scope calibration: ${response.status}`);
    }
    const payload = await response.json();
    if (!payload || payload.schema !== "bronchoedu_scope_calibration/v1" || typeof payload.adjustments !== "object") {
      throw new Error("Scope calibration JSON has an unsupported schema.");
    }
    return payload;
  });
}

async function fetchCandidateSidecar(metadata: WebCase, caseUrl: string): Promise<AirwayCandidatePayload | null> {
  const sidecarPath = metadata.airway.candidatesJson ?? "book_candidates.json";
  const url = new URL(sidecarPath, new URL(caseUrl, window.location.origin)).toString();
  return fetch(url).then(async (response) => {
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Failed to load airway candidate labels: ${response.status}`);
    }
    const payload = (await response.json()) as AirwayCandidatePayload;
    if (payload.schema !== "airway_labeling_candidate_results/v1" || !payload.edges) {
      throw new Error("Airway candidate labels JSON has an unsupported schema.");
    }
    return payload;
  });
}

function mergeCandidateLabels(metadata: WebCase, payload: AirwayCandidatePayload) {
  metadata.airway.candidateSource = payload.source;
  metadata.airway.edges = metadata.airway.edges.map((edge) => {
    const raw = payload.edges[String(edge.id)];
    const candidates = normalizeCandidateLabels(raw);
    return candidates.length ? { ...edge, candidateLabels: candidates } : edge;
  });
}

function normalizeCandidateLabels(raw: AirwayCandidatePayload["edges"][string] | undefined): AirwayCandidateLabel[] {
  const items = Array.isArray(raw) ? raw : (raw?.candidateLabels ?? raw?.candidates ?? []);
  return items
    .filter((item) => typeof item.candidateLabel === "string" && Number.isFinite(Number(item.score)))
    .map((item) => ({
      ...item,
      score: Number(item.score),
      warnings: Array.isArray(item.warnings) ? item.warnings : [],
      explanation: typeof item.explanation === "string" ? item.explanation : "",
      source: typeof item.source === "string" ? item.source : "book_directional_rules"
    }))
    .sort((a, b) => b.score - a.score || a.candidateLabel.localeCompare(b.candidateLabel));
}

async function fetchCaseArrayBuffer(path: string, caseUrl: string, label: string) {
  const url = new URL(path, new URL(caseUrl, window.location.origin)).toString();
  return fetch(url).then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load ${label}: ${response.status}`);
    }
    return response.arrayBuffer();
  });
}

async function loadNoduleAsset(metadata: NoduleAssetMetadata, caseUrl: string): Promise<LoadedNoduleAsset> {
  return {
    metadata,
    residual: new Int16Array(await fetchCaseArrayBuffer(metadata.residualRaw, caseUrl, `${metadata.assetId} residual volume`)),
    alpha: new Uint8Array(await fetchCaseArrayBuffer(metadata.alphaRaw, caseUrl, `${metadata.assetId} alpha volume`))
  };
}
