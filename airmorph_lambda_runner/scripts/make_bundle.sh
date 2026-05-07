#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
runner_root="$repo_root/airmorph_lambda_runner"
out="${1:-$repo_root/outputs/airmorph_lambda_runner_bundle.tar.gz}"
stage="$(mktemp -d)"
bundle="$stage/airmorph_lambda_runner"

cleanup() {
  rm -rf "$stage"
}
trap cleanup EXIT

mkdir -p "$bundle/case/input" "$bundle/navigation_module/src" "$(dirname "$out")"

rsync -a \
  --exclude AirMorph \
  --exclude case/input \
  --exclude case/work \
  --exclude __pycache__ \
  --exclude logs \
  --exclude navigation_module \
  --exclude outputs \
  "$runner_root/" "$bundle/"

cp "$repo_root/data/target/target_clean_ct.nrrd" "$bundle/case/input/target_clean_ct.nrrd"
cp "$repo_root/data/airway/Network model.vtk" "$bundle/case/input/Network model.vtk"
cp "$repo_root/pyproject.toml" "$bundle/navigation_module/pyproject.toml"
rsync -a --exclude __pycache__ "$repo_root/src/bronchoedu" "$bundle/navigation_module/src/"

tar -czf "$out" -C "$stage" airmorph_lambda_runner

echo "Wrote $out"
du -h "$out"
