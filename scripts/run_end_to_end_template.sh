#!/usr/bin/env bash
set -euo pipefail

# Template only. Update paths and target RAS before running.
# Requires: pip install SimpleITK numpy scipy

SOURCE_CT="data/source/source_ct.nrrd"
SOURCE_MASK="data/source/Nodule_segmentation_patient_1_1.nrrd"
LABELS_CSV="data/source/Nodule_segmentation_patient_1_1.labels.csv"
TARGET_CT="data/target/target_clean_ct.nrrd"
NETWORK_VTK="data/airway/Network model.vtk"

TARGET_RAS_R="42.0"
TARGET_RAS_A="130.0"
TARGET_RAS_S="-250.0"

mkdir -p outputs/assets outputs/synthetic outputs/routes data/source

python scripts/validate_slicer_exports.py \
  --ct "$SOURCE_CT" \
  --mask "$SOURCE_MASK" \
  --labels-csv "$LABELS_CSV" \
  --out-json outputs/source_export_validation.json

python scripts/split_multilabel_nodule_mask.py \
  --mask "$SOURCE_MASK" \
  --labels-csv "$LABELS_CSV" \
  --label-name "lung_nodule_1" \
  --out data/source/lung_nodule_1_mask.nrrd

python reference_code/nodule_asset_inserter.py create-asset \
  --source-ct "$SOURCE_CT" \
  --source-mask data/source/lung_nodule_1_mask.nrrd \
  --out-dir outputs/assets/lung_nodule_1 \
  --margin-mm 12 \
  --label 1

python reference_code/nodule_asset_inserter.py insert \
  --target-ct "$TARGET_CT" \
  --asset-dir outputs/assets/lung_nodule_1 \
  --target-ras "$TARGET_RAS_R" "$TARGET_RAS_A" "$TARGET_RAS_S" \
  --out-ct outputs/synthetic/synthetic_ct.nrrd \
  --out-mask outputs/synthetic/synthetic_nodule_mask.nrrd \
  --mode residual \
  --cast-int16

python scripts/route_from_mask_centroid.py \
  --network-vtk "$NETWORK_VTK" \
  --mask outputs/synthetic/synthetic_nodule_mask.nrrd \
  --label 1 \
  --route-json outputs/routes/route_to_synthetic_nodule.json
