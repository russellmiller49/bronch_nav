# Codex task list

## Task 1: Repo setup

Create a pip-installable Python package called `bronchoedu` with console scripts. Include a README with end-to-end examples.

## Task 2: Coordinates module

Implement:

- `ras_to_lps`
- `lps_to_ras`
- point and vector variants
- unit tests for roundtrip and vector sign flips

## Task 3: Label utilities

Implement:

- parse Slicer labels CSV
- list labels in labelmap with voxel counts
- find label by exact or case-insensitive name
- split multi-label mask into binary mask
- compute label centroid LPS and RAS
- compute physical bounding box

## Task 4: Nodule asset module

Refactor `reference_code/nodule_asset_inserter.py` into importable functions.

Keep the CLI behavior.

Add:

- support for `--label-name`
- richer metadata
- strict geometry report
- safe output directory creation

## Task 5: Nodule insertion module

Refactor insertion into importable functions.

Add:

- placement metadata JSON
- optional target lung mask validity check
- output geometry assertion
- sanity check that inserted mask has nonzero voxels

## Task 6: Airway route module

Refactor/wrap `reference_code/bronchoscopy_airway_vtk_adapter.py`.

Add a script that computes centroid from a mask and directly writes route JSON.

## Task 7: Slicer scripted module

Implement `BronchoscopicBranchTracer.py`.

MVP behavior:

- load route JSON
- draw route curve
- create current position marker
- create lesion marker
- slider updates marker/crosshair
- text panel displays nearest bifurcation prompt

Stretch behavior:

- update arbitrary CT planes from route frames
- update 3D virtual bronchoscope camera
- branch-choice quiz UI with correct/incorrect feedback

## Task 8: End-to-end demo script

Implement `scripts/run_end_to_end_demo.py` that orchestrates:

1. validate exports
2. split nodule mask
3. create asset
4. insert asset
5. compute route

Use a YAML or JSON config.

## Task 9: Tests

Add pytest tests for pure-Python pieces. For SimpleITK-dependent tests, create tiny synthetic volumes in memory.

Minimum tests:

- coordinate conversion
- label CSV parsing
- multi-label split
- centroid computation
- output geometry matching
- airway adapter can route to the included example target

## Task 10: Documentation

Document the exact Slicer export steps and a one-command demo workflow.
