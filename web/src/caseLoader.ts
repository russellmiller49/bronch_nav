import type { AirwayCandidateLabel, AirwayCandidatePayload, LoadedCase, WebCase } from "./types";

export async function loadCase(caseUrl = "/cases/default/case.json"): Promise<LoadedCase> {
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

  const rawUrl = new URL(metadata.ct.raw, new URL(caseUrl, window.location.origin)).toString();
  const buffer = await fetch(rawUrl).then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load CT preview volume: ${response.status}`);
    }
    return response.arrayBuffer();
  });

  const noduleAsset = metadata.noduleAsset
    ? {
        metadata: metadata.noduleAsset,
        residual: new Int16Array(await fetchCaseArrayBuffer(metadata.noduleAsset.residualRaw, caseUrl, "nodule residual volume")),
        alpha: new Uint8Array(await fetchCaseArrayBuffer(metadata.noduleAsset.alphaRaw, caseUrl, "nodule alpha volume"))
      }
    : null;

  return { metadata, volume: new Uint8Array(buffer), noduleAsset };
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
