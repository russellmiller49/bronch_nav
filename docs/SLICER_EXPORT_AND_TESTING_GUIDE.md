# 3D Slicer export and testing guide

## Export source CT

In Slicer:

1. Load source CT DICOM.
2. Open `Save`.
3. Save the CT volume as:

```text
source_ct.nrrd
```

## Export nodule segmentation

In Segmentations:

1. Hide all segments except the nodule you want, or export the full multi-label segmentation and select the nodule label in code.
2. In `Export/import models and labelmaps`:
   - Operation: `Export`
   - Output type: `Labelmap`
   - Reference volume: `CT`
   - File format: `NRRD`
   - Coordinate system: `LPS` is acceptable
3. Export to files.

Expected files:

```text
Nodule_segmentation_patient 1_1.nrrd
Nodule_segmentation_patient 1_1.labels.csv
```

The `.nrrd` contains voxel labels. The `.labels.csv` maps label values to segment names.

## Export target CT

Load the clean target CT and save as:

```text
target_clean_ct.nrrd
```

## Choose insertion coordinate

In Slicer, move the crosshair to the desired parenchymal target location and record the RAS coordinate from Data Probe.

Pass it to the inserter as:

```bash
--target-ras R A S
```

## Visual QA after insertion

Load:

```text
synthetic_ct.nrrd
synthetic_nodule_mask.nrrd
```

Check:

- the nodule appears in axial scrolling
- the nodule appears naturally in coronal/sagittal views
- the mask overlays the synthetic nodule
- no rectangular pasted donor background is visible
- the target CT orientation and spacing are unchanged

## Visual QA after route generation

Load:

```text
synthetic_ct.nrrd
Network model.vtk
route_to_synthetic_nodule.json
```

Check:

- route starts near proximal trachea
- route approaches airway nearest to lesion
- lesion-directed CT plane shows lesion relationship near terminal airway
- branch-decision prompts appear at bifurcations
