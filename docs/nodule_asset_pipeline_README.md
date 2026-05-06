# Synthetic Pulmonary Nodule Asset Pipeline

This is a prototype workflow for taking a segmented nodule from one CT and inserting it into another CT so the result scrolls like a real 3D lesion.

## 1. Export from 3D Slicer

For each source nodule case:

1. Load the source CT DICOM in Slicer.
2. Load or create the nodule segmentation.
3. In **Segmentations**, export the nodule segment to a **labelmap volume**.
4. In Advanced export options, choose the **source CT as the reference volume**.
5. Save the source CT and nodule labelmap as `.nrrd` or `.nii.gz`.

This gives you:

```text
source_ct.nrrd
source_nodule_mask.nrrd
```

For each target case:

1. Load the target clean CT.
2. Save it as `.nrrd` or `.nii.gz`.
3. Use Slicer's RAS coordinate readout to choose an insertion point.

## 2. Create a nodule asset

```bash
python nodule_asset_inserter.py create-asset \
  --source-ct source_ct.nrrd \
  --source-mask source_nodule_mask.nrrd \
  --out-dir assets/nodule_001 \
  --margin-mm 12 \
  --label 1
```

The asset directory contains:

```text
patch_ct.nrrd
mask_labelmap.nrrd
alpha.nrrd
residual_signal.nrrd
metadata.json
```

## 3. Insert the nodule into another CT

```bash
python nodule_asset_inserter.py insert \
  --target-ct target_clean_ct.nrrd \
  --asset-dir assets/nodule_001 \
  --target-ras 42.0 130.0 -250.0 \
  --out-ct synthetic_ct.nrrd \
  --out-mask synthetic_nodule_mask.nrrd \
  --scale 1.0 \
  --rot-deg 0 0 0 \
  --mode residual \
  --cast-int16
```

## 4. View the result

Load these into Slicer:

```text
synthetic_ct.nrrd
synthetic_nodule_mask.nrrd
```

The synthetic CT has edited voxels, not just an overlay, so the nodule appears in axial, coronal, sagittal, oblique, and airway-relative planes.

## 5. Recommended modes

- `--mode residual` usually looks better for lung parenchyma because it adds the donor nodule signal to the target lung texture.
- `--mode direct` is simpler but often imports donor lung background and can look pasted.

## 6. Important coordinate note

3D Slicer displays RAS coordinates. SimpleITK image physical space is typically LPS. The script accepts `--target-ras` and internally converts:

```text
LPS = [-R, -A, S]
```

## 7. Limitations

This is an educational/prototyping workflow. It does not yet perform advanced Poisson blending, vessel-aware deformation, pleural-surface matching, or CT noise/reconstruction-kernel matching.
