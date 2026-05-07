#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/common.sh
source "$root/scripts/common.sh"
load_case_config

cd "$root"

require_file "$CT_NRRD"
require_file "$NETWORK_VTK"

./scripts/setup_airmorph.sh
./scripts/download_checkpoints.sh

activate_conda_env

python scripts/prepare_case.py \
  --ct-nrrd "$CT_NRRD" \
  --network-vtk "$NETWORK_VTK" \
  --airmorph-root "$AIRMORPH_DIR" \
  --case-group "$AIRMORPH_CASE_GROUP" \
  --case-id "$CASE_ID"

case_dir="$root/$AIRMORPH_DIR/sample_data/$AIRMORPH_CASE_GROUP/$CASE_ID"
mkdir -p logs
python scripts/run_airmorph_case.py \
  --airmorph-root "$AIRMORPH_DIR" \
  --case-dir "$case_dir" \
  --case-id "$CASE_ID" 2>&1 | tee "logs/${CASE_ID}_airmorph.log"

./scripts/import_labels.sh
./scripts/collect_results.sh

echo "Done. Main import JSON: $OUTPUT_DIR/airway_anatomy_labels.json"
