# Data contracts

## Coordinate systems

### Slicer RAS

3D Slicer reports positions as RAS:

```text
R = right
A = anterior
S = superior
```

Route JSON should use RAS.

### Image LPS

NRRD/ITK/SimpleITK often use LPS:

```text
L = left
P = posterior
S = superior
```

Conversion:

```text
RAS = [-L, -P, S]
LPS = [-R, -A, S]
```

## Source CT

Accepted formats:

```text
.nrrd
.nii.gz
```

Required properties:

- 3D scalar image
- CT Hounsfield-unit-like intensity values
- same geometry as source nodule mask

## Source nodule mask

Accepted formats:

```text
.nrrd
.nii.gz
```

May be:

- binary mask, label 1
- multi-label mask, e.g. label 5 for `lung_nodule_1`

Must have same size, spacing, origin, and direction as source CT.

## Labels CSV

Slicer labels CSV format includes columns:

```text
LabelValue, Name, Color_R, Color_G, Color_B, Color_A, ...
```

The implementation should parse at least:

- `LabelValue`
- `Name`

## Nodule asset directory

Required files:

```text
patch_ct.nrrd
mask_labelmap.nrrd
alpha.nrrd
residual_signal.nrrd
metadata.json
```

Required metadata fields:

```json
{
  "education_only": true,
  "not_for_clinical_use": true,
  "synthetic_asset": true,
  "source_ct": "...",
  "source_mask": "...",
  "selected_label": 5,
  "selected_label_name": "lung_nodule_1",
  "centroid_lps": [0, 0, 0],
  "centroid_ras": [0, 0, 0],
  "spacing_xyz_mm": [0, 0, 0],
  "volume_mm3": 0,
  "equivalent_diameter_mm": 0,
  "background_hu": -850,
  "margin_mm": 12
}
```

## Synthetic output

Required files:

```text
synthetic_ct.nrrd
synthetic_nodule_mask.nrrd
synthetic_placement.json
```

The synthetic CT and synthetic mask must have geometry exactly matching the target CT.

## Airway route JSON

Use `reference_outputs/example_route_to_terminal_like_target.json` as the schema example.

Required top-level concepts:

- input target RAS
- airway nearest projection
- airway-to-target distance
- route points RAS
- route edge/cell IDs
- frames with origin/tangent/normal/binormal
- CT planes
- bronchoscope camera
- bifurcation decisions

## Case package

Future complete case packages should look like:

```text
case_id/
  synthetic_ct.nrrd
  synthetic_nodule_mask.nrrd
  route_to_synthetic_nodule.json
  Network model.vtk
  case_metadata.json
  teaching_notes.json
```
