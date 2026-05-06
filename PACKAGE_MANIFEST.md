# Package manifest

## Root files

- `README.md` — overview of the handoff package.
- `CODEX_ONE_SHOT_PROMPT.md` — main prompt to give Codex.
- `requirements.txt` — Python dependencies for CLI pieces.
- `pyproject.example.toml` — suggested package metadata for the implementation repo.

## docs

- `IMPLEMENTATION_SPEC.md` — product and architecture spec.
- `DATA_CONTRACTS.md` — required input/output data formats and coordinate conventions.
- `SLICER_EXPORT_AND_TESTING_GUIDE.md` — how to export files from Slicer and visually test results.
- `SLICER_MODULE_NOTES.md` — Slicer scripted module implementation notes.
- `CODEX_TASK_LIST.md` — ordered implementation tasks.
- `KNOWN_INPUTS_FROM_THIS_SESSION.md` — parsed facts about current labels and airway network.
- `airway_branch_tracer_vtk_integration_notes.md` — previous detailed airway notes.
- `nodule_asset_pipeline_README.md` — previous nodule asset pipeline notes.

## reference_code

- `nodule_asset_inserter.py` — existing nodule asset/insertion CLI.
- `bronchoscopy_airway_vtk_adapter.py` — existing airway graph/route/frame CLI.
- `slicer_branch_tracer_prototype.py` — existing Slicer prototype skeleton.

## scripts

- `validate_slicer_exports.py` — validation utility for CT/mask/label exports.
- `split_multilabel_nodule_mask.py` — split one label into a binary mask.
- `route_from_mask_centroid.py` — compute centroid and route to synthetic nodule.
- `run_end_to_end_template.sh` — shell template for the MVP pipeline.

## airway_data

- `Network model.vtk` — primary airway network geometry.
- `Centerline model.vtk` — centerline model for QA/comparison.
- `Network properties.tsv` and schema — branch metrics.
- `Centerline quantification.tsv` and schema — centerline metrics.

## reference_outputs

- `airway_vtk_summary.json` — parsed airway summary.
- `airway_network_case_with_geometry.json` — full airway graph with geometry.
- `example_route_to_terminal_like_target.json` — example route JSON.

## data_placeholders

- `Nodule_segmentation_patient 1_1.labels.csv` — example labels CSV.
- `README_place_full_data_here.md` — where to put large source/target CT files.
