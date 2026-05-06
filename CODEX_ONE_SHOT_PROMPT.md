# One-shot prompt for Codex

You are implementing a prototype educational peripheral/robotic bronchoscopy simulator. This is for education and simulation only, not clinical navigation, diagnosis, or treatment planning.

## Goal

Build a Python/Slicer MVP that can:

1. Take a segmented pulmonary nodule from a source CT and convert it into a reusable 3D nodule asset.
2. Insert that nodule asset into a separate target CT volume at a Slicer RAS coordinate so the nodule becomes part of the target CT voxel array and scrolls correctly in axial, coronal, sagittal, and oblique views.
3. Compute the synthetic nodule centroid from the inserted nodule mask.
4. Use the airway `Network model.vtk` to generate a route from the proximal trachea to the airway closest to the synthetic nodule.
5. Load the synthetic CT and route JSON in 3D Slicer and provide a slider-driven branch-tracing exercise where the CT planes, route marker, 3D view, and branch-decision prompt update as the learner advances toward the lesion.

## Existing files in this handoff package

Use these files as reference implementations and starter code:

- `reference_code/nodule_asset_inserter.py`: CLI prototype for creating nodule assets and inserting them into target CTs.
- `reference_code/bronchoscopy_airway_vtk_adapter.py`: CLI + class implementation for parsing `Network model.vtk`, building the airway graph, creating route JSON, generating CT/camera frames, and branch-decision metadata.
- `reference_code/slicer_branch_tracer_prototype.py`: preliminary Slicer prototype skeleton.
- `airway_data/Network model.vtk`: target airway network model. Header says LPS; adapter outputs RAS.
- `airway_data/Centerline model.vtk`: optional QA centerline model.
- `airway_data/*.tsv`: quantification tables, useful for validation and metadata.
- `reference_outputs/example_route_to_terminal_like_target.json`: example of expected route JSON shape.
- `data_placeholders/Nodule_segmentation_patient 1_1.labels.csv`: example Slicer labels file. The multi-label export has nodules at label 5 (`lung_nodule_1`) and label 6 (`Lung_nodule_2`).

Do not modify original user data in place. Write derived outputs under `outputs/`.

## Required implementation structure

Create a repository with this structure:

```text
bronchoedu/
  pyproject.toml
  README.md
  src/bronchoedu/
    __init__.py
    coordinates.py
    io.py
    labels.py
    nodule_assets.py
    nodule_insert.py
    airway_route.py
    slicer_module/
      BronchoscopicBranchTracer.py
  scripts/
    validate_slicer_exports.py
    split_multilabel_nodule_mask.py
    create_nodule_asset.py
    insert_nodule_asset.py
    route_from_mask_centroid.py
    run_end_to_end_demo.py
  tests/
    test_coordinates.py
    test_labelmap_utils.py
    test_airway_route.py
    test_nodule_asset_smoke.py
```

You may wrap or refactor the provided reference scripts, but preserve their behavior.

## Coordinate conventions

This project uses two coordinate conventions:

- 3D Slicer UI and route JSON: RAS coordinates.
- SimpleITK and exported NRRD image physical space: usually LPS.

Implement and test exact conversion functions:

```python
def ras_to_lps(point_ras):
    r, a, s = point_ras
    return [-r, -a, s]

def lps_to_ras(point_lps):
    l, p, s = point_lps
    return [-l, -p, s]
```

The airway `Network model.vtk` header indicates `SPACE=LPS`; the adapter converts to RAS internally. Do not double-convert route JSON output.

## Nodule asset requirements

For each source nodule:

Input:

```text
source_ct.nrrd
source_nodule_mask.nrrd  # same geometry as source CT; may be binary or multi-label
```

The code must support both:

```bash
--label 5
```

and:

```bash
--label-name lung_nodule_1 --labels-csv Nodule_segmentation_patient\ 1_1.labels.csv
```

Output asset directory:

```text
patch_ct.nrrd
mask_labelmap.nrrd
alpha.nrrd
residual_signal.nrrd
metadata.json
```

Metadata must include:

- source image geometry: spacing, origin, direction, size
- selected label value and name
- centroid LPS and RAS
- bounding box in voxel and physical coordinates
- volume in mm^3
- equivalent spherical diameter in mm
- estimated donor background HU
- margin and feathering parameters

The `metadata.json` must clearly include `education_only: true` and `synthetic_asset: true`.

## Nodule insertion requirements

Input:

```text
target_ct.nrrd
asset_dir/
target_ras R A S
```

Output:

```text
synthetic_ct.nrrd
synthetic_nodule_mask.nrrd
synthetic_placement.json
```

Insertion must:

- resample the asset into the target CT physical space
- use RAS input coordinates but LPS internally for SimpleITK
- support `--scale` and `--rot-deg rx ry rz`
- support `--mode residual` and `--mode direct`
- default to residual mode
- not overwrite the source or target CT
- cast CT output to int16 when requested
- ensure output geometry matches target CT geometry exactly

For residual mode, use the nodule signal relative to donor background:

```text
synthetic = target + residual_signal * alpha
```

For direct mode, use soft alpha blending:

```text
synthetic = target * (1 - alpha) + patch_ct * alpha
```

## Airway route requirements

Input:

```text
Network model.vtk
synthetic_nodule_mask.nrrd
```

Workflow:

1. Compute synthetic nodule centroid from mask in LPS.
2. Convert centroid to RAS.
3. Call the airway network adapter to compute route to target.
4. Write `route_to_synthetic_nodule.json`.

Route JSON must include:

- target RAS
- nearest airway edge/cell
- airway-to-target distance
- route point list in RAS
- route edge/cell IDs
- ordered CT/camera frames
- bifurcation decision list with available branches and correct branch hidden behind a field that the UI can reveal only after learner selection

Use `reference_outputs/example_route_to_terminal_like_target.json` as the expected schema.

## Slicer module MVP requirements

Create a Slicer scripted module named `BronchoscopicBranchTracer`.

UI controls:

- CT volume selector
- route JSON file selector
- optional airway VTK model selector
- synthetic nodule mask selector
- slider for route index
- buttons: Load Route, Previous Bifurcation, Next Bifurcation, Play/Pause, Show/Hide Correct Route
- text panel showing current branch, distance to target, and branch-decision prompt

On route load:

- create a markups curve from route points
- create/update a current-position fiducial/sphere
- create a lesion centroid fiducial
- if airway model is loaded, display it with low opacity
- populate bifurcation-decision table

On slider change:

- update current position marker to `frame.origin_ras`
- update crosshair to `frame.origin_ras`
- update an airway-relative slice plane using `frame.ct_planes.airway_cross_section`
- update a lesion-directed long-axis slice plane when present
- update 3D camera position/focal point/view-up from `frame.bronchoscope_camera`
- detect whether current index is near a bifurcation and show the branch quiz prompt

Use the Slicer API carefully. If arbitrary slice-plane setup is difficult, implement marker/route/quiz first and leave a clearly marked method for plane update with TODO comments and tests around frame parsing.

## CLI demo workflow

The final repo must support this end-to-end workflow:

```bash
# 1. Validate Slicer-exported CT/mask geometry and labels.
python scripts/validate_slicer_exports.py \
  --ct data/source/source_ct.nrrd \
  --mask data/source/Nodule_segmentation_patient_1_1.nrrd \
  --labels-csv data/source/Nodule_segmentation_patient_1_1.labels.csv

# 2. Split the multi-label segmentation into one binary nodule mask.
python scripts/split_multilabel_nodule_mask.py \
  --mask data/source/Nodule_segmentation_patient_1_1.nrrd \
  --labels-csv data/source/Nodule_segmentation_patient_1_1.labels.csv \
  --label-name lung_nodule_1 \
  --out data/source/lung_nodule_1_mask.nrrd

# 3. Create nodule asset.
python scripts/create_nodule_asset.py \
  --source-ct data/source/source_ct.nrrd \
  --source-mask data/source/lung_nodule_1_mask.nrrd \
  --out-dir outputs/assets/lung_nodule_1 \
  --label 1 \
  --margin-mm 12

# 4. Insert into target clean CT.
python scripts/insert_nodule_asset.py \
  --target-ct data/target/target_clean_ct.nrrd \
  --asset-dir outputs/assets/lung_nodule_1 \
  --target-ras 42 130 -250 \
  --out-ct outputs/synthetic/synthetic_ct.nrrd \
  --out-mask outputs/synthetic/synthetic_nodule_mask.nrrd \
  --mode residual \
  --cast-int16

# 5. Route from synthetic mask centroid to airway.
python scripts/route_from_mask_centroid.py \
  --network-vtk data/airway/Network\ model.vtk \
  --mask outputs/synthetic/synthetic_nodule_mask.nrrd \
  --label 1 \
  --route-json outputs/routes/route_to_synthetic_nodule.json
```

## Acceptance criteria

The implementation is acceptable when:

1. The validation script prints all label values, names, voxel counts, centroids, and reports whether CT/mask geometry matches.
2. A multi-label Slicer segmentation can be split by label value or label name into a single binary nodule mask.
3. Creating a nodule asset produces all required asset files and metadata.
4. Inserting the nodule produces a synthetic CT and synthetic mask with geometry identical to the target CT.
5. The synthetic nodule is visible when scrolling through the synthetic CT in Slicer.
6. The centroid of the synthetic mask can be converted to RAS and routed through the airway network.
7. The route JSON has frames and bifurcation decisions.
8. The Slicer module can load the route JSON, draw the route, move the position marker with a slider, and display branch-decision prompts.

## Safety/labeling

Every generated metadata JSON must state:

```json
{
  "education_only": true,
  "not_for_clinical_use": true,
  "synthetic": true
}
```

Do not claim the software is clinically validated. Do not integrate with clinical navigation systems.
