#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/common.sh
source "$root/scripts/common.sh"
load_case_config
activate_conda_env

cd "$root"
case_dir="$root/$AIRMORPH_DIR/sample_data/$AIRMORPH_CASE_GROUP/$CASE_ID"
mkdir -p "$OUTPUT_DIR"

require_file "$case_dir/${CASE_ID}_pred_lob.nii.gz"
require_file "$case_dir/${CASE_ID}_pred_seg.nii.gz"
require_file "$case_dir/${CASE_ID}_pred_sub.nii.gz"
require_file "$root/$AIRMORPH_DIR/configs/class2anno.json"
require_file "$NETWORK_VTK"
require_file "$CT_NRRD"

export PYTHONPATH="$root/navigation_module/src:${PYTHONPATH:-}"

python -m bronchoedu.scripts.import_airmorph_labels \
  --network-vtk "$NETWORK_VTK" \
  --ct "$CT_NRRD" \
  --pred-lob "$case_dir/${CASE_ID}_pred_lob.nii.gz" \
  --pred-seg "$case_dir/${CASE_ID}_pred_seg.nii.gz" \
  --pred-sub "$case_dir/${CASE_ID}_pred_sub.nii.gz" \
  --airway-bin "$case_dir/airway_bin.nii.gz" \
  --anno-json "$case_dir/${CASE_ID}_anno.json" \
  --class2anno "$root/$AIRMORPH_DIR/configs/class2anno.json" \
  --out-json "$OUTPUT_DIR/airway_anatomy_labels.json"
