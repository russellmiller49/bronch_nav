import type { LoadedCase, WebCase } from "./types";

export async function loadCase(caseUrl = "/cases/default/case.json"): Promise<LoadedCase> {
  const metadata = (await fetch(caseUrl).then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load case metadata: ${response.status}`);
    }
    return response.json();
  })) as WebCase;

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

async function fetchCaseArrayBuffer(path: string, caseUrl: string, label: string) {
  const url = new URL(path, new URL(caseUrl, window.location.origin)).toString();
  return fetch(url).then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load ${label}: ${response.status}`);
    }
    return response.arrayBuffer();
  });
}
