#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/common.sh
source "$root/scripts/common.sh"
load_case_config

cd "$root"
case_dir="$root/$AIRMORPH_DIR/sample_data/$AIRMORPH_CASE_GROUP/$CASE_ID"
mkdir -p "$OUTPUT_DIR/airmorph" "$OUTPUT_DIR/input"

copy_if_present() {
  local src="$1"
  local dst_dir="$2"
  if [[ -f "$src" ]]; then
    cp "$src" "$dst_dir/"
  fi
}

for name in \
  airway_bin.nii.gz \
  airway_skeleton.nii.gz \
  lunglobe.nii.gz \
  "${CASE_ID}_parse.nii.gz" \
  "${CASE_ID}_skel_parsing.nii.gz" \
  "${CASE_ID}_pred_lob.nii.gz" \
  "${CASE_ID}_pred_seg.nii.gz" \
  "${CASE_ID}_pred_sub.nii.gz" \
  "${CASE_ID}_anno.json" \
  "${CASE_ID}_airway_graph.npy" \
  "${CASE_ID}_airway_feature_cls.npy" \
  "${CASE_ID}_airway_graph_cls.npy" \
  bronchoedu_case_manifest.json; do
  copy_if_present "$case_dir/$name" "$OUTPUT_DIR/airmorph"
done

copy_if_present "$NETWORK_VTK" "$OUTPUT_DIR/input"
copy_if_present "$CT_NRRD" "$OUTPUT_DIR/input"
copy_if_present "$root/$AIRMORPH_DIR/configs/class2anno.json" "$OUTPUT_DIR/airmorph"

archive="outputs/${CASE_ID}_airmorph_results.tar.gz"
tar -czf "$archive" -C outputs "$CASE_ID"
echo "Wrote $root/$archive"
du -h "$archive"
