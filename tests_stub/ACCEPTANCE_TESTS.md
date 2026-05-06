# Acceptance tests

## Test A: validate label export

Input:

- source CT NRRD
- Slicer-exported multi-label mask NRRD
- labels CSV

Expected:

- reports geometry match between CT and mask
- prints label values and names
- identifies `lung_nodule_1` and `Lung_nodule_2`

## Test B: split nodule mask

Input:

- multi-label mask
- label name `lung_nodule_1`

Expected:

- output binary mask contains only 0 and 1
- output binary mask has nonzero voxels
- output geometry matches input mask

## Test C: create asset

Input:

- source CT
- binary nodule mask

Expected:

- asset directory contains `patch_ct.nrrd`, `mask_labelmap.nrrd`, `alpha.nrrd`, `residual_signal.nrrd`, `metadata.json`
- metadata has volume, equivalent diameter, centroid RAS/LPS, and education-only fields

## Test D: insert asset

Input:

- clean target CT
- nodule asset
- target RAS

Expected:

- synthetic CT and synthetic mask are written
- output geometry exactly matches target CT
- synthetic mask has nonzero voxels
- synthetic CT differs from target CT only near the inserted mask/alpha region

## Test E: route from synthetic mask

Input:

- `Network model.vtk`
- synthetic nodule mask

Expected:

- route JSON written
- route contains nonzero route points
- route has CT/camera frames
- route has bifurcation decision list

## Test F: Slicer UI smoke test

Input:

- synthetic CT
- route JSON
- network VTK

Expected:

- route curve displayed
- current marker moves when slider changes
- crosshair follows current marker
- branch prompt updates near bifurcations
