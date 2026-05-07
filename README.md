# BronchoEdu

Educational synthetic nodule insertion and bronchoscopic branch tracing MVP.

This repository is for education and simulation only. Outputs are synthetic and
must not be used for clinical navigation, diagnosis, treatment planning, or
robotic bronchoscopy guidance.

## Install

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[test]'
```

3D Slicer is only required for the scripted module UI. On this workstation,
`/Applications/Slicer.app` is available and reports Slicer 5.10.0.

## CLI Workflow

The root `scripts/` files work from a checkout, and installed console commands
are also available after `pip install -e .`.

```bash
.venv/bin/python scripts/validate_slicer_exports.py \
  --ct data/source/CT.nrrd \
  --mask data/source/lung_nodule_1_mask.nrrd \
  --labels-csv "data/source/Nodule_segmentation_patient 1.labels.csv"

.venv/bin/python scripts/split_multilabel_nodule_mask.py \
  --mask data/source/lung_nodule_1_mask.nrrd \
  --labels-csv "data/source/Nodule_segmentation_patient 1.labels.csv" \
  --label-name lung_nodule_1 \
  --out outputs/source/lung_nodule_1_mask.nrrd

.venv/bin/python scripts/create_nodule_asset.py \
  --source-ct data/source/CT.nrrd \
  --source-mask outputs/source/lung_nodule_1_mask.nrrd \
  --out-dir outputs/assets/lung_nodule_1 \
  --label 1 \
  --margin-mm 12

.venv/bin/python scripts/insert_nodule_asset.py \
  --target-ct data/target/target_clean_ct.nrrd \
  --asset-dir outputs/assets/lung_nodule_1 \
  --target-ras 42 130 -250 \
  --out-ct outputs/synthetic/synthetic_ct.nrrd \
  --out-mask outputs/synthetic/synthetic_nodule_mask.nrrd \
  --out-placement outputs/synthetic/synthetic_placement.json \
  --mode residual \
  --cast-int16

.venv/bin/python scripts/route_from_mask_centroid.py \
  --network-vtk "data/airway/Network model.vtk" \
  --mask outputs/synthetic/synthetic_nodule_mask.nrrd \
  --label 1 \
  --route-json outputs/routes/route_to_synthetic_nodule.json
```

The same flow can be run from the YAML config:

```bash
.venv/bin/python scripts/run_end_to_end_demo.py \
  --config config/example_pipeline_config.yaml
```

## Outputs

Nodule assets contain:

```text
patch_ct.nrrd
mask_labelmap.nrrd
alpha.nrrd
residual_signal.nrrd
metadata.json
```

Synthetic insertion writes:

```text
synthetic_ct.nrrd
synthetic_nodule_mask.nrrd
synthetic_placement.json
```

Route generation writes a JSON with `target_ras`, `nearest_airway`,
`route.points_ras`, `route.frames`, and `bifurcation_decisions`.

## Slicer Module

The scripted module file is:

```text
src/bronchoedu/slicer_module/BronchoscopicBranchTracer.py
```

In Slicer, add `src/bronchoedu/slicer_module` to scripted module paths, restart
Slicer, then load:

- `outputs/synthetic/synthetic_ct.nrrd`
- `outputs/synthetic/synthetic_nodule_mask.nrrd`
- `data/airway/Network model.vtk`
- `Airway.seg.nrrd`
- `data/airway/curves`
- `outputs/routes/route_to_synthetic_nodule.json`

The module provides route loading, route curve display, current-position marker,
lesion marker, route slider/playback, bifurcation navigation, branch prompt
table, guarded CT-plane updates, and an explicit endoscopic 3D camera mode.
**Head-end supine orientation** is enabled by default for bronchoscopy render:
the virtual scope advances from the patient head toward the feet and keeps
patient anterior/chest toward the top of the screen, matching common teaching
bronchoscopy images.
By default the CT views stay in standard Red axial, Yellow sagittal, and Green
coronal orientation while tracking the current airway point. Check
**Airway-aligned CT planes** only when you want the experimental oblique
airway-relative planes. At active branch decisions, CT views are centered on the
bifurcation node rather than the upstream scope camera point, so the cut planes
line up with the visible branch choices.
Use `Airway.seg.nrrd` as the **Airway surface** input for a real airway-tree
surface in the 3D/endoscopic view. Use `data/airway/curves` as the **Network
curves** folder so branch choices trace the actual exported airway curves instead
of simple straight guide-lines. At branch points it shows small `B1`, `B2`, ...
markers plus A/B/C branch choices in CT and 3D; after selecting a branch, the correct
option turns green and an incorrect selected option turns red. **Bronchoscopy
render** hides teaching markers in 3D, uses the airway surface as an opaque
inside-lumen view, and keeps the branch-choice curves visible in the CT views.
Playback pauses at each bifurcation and holds the branch choices on screen until
the learner advances.

Coordinate/data note: `data/source/CT.nrrd` is only the donor CT used to build
the nodule asset. The airway-aligned target image is
`data/target/target_clean_ct.nrrd`. The Slicer module can use
`outputs/synthetic/synthetic_ct.nrrd`; the web trainer uses the clean target CT
and blends the reusable nodule asset into the selected terminal location in the
browser.

## Web Trainer

The first web implementation lives in `web/`. It uses the clean target CT, the
reusable nodule asset, the airway network VTK, and the route JSON to build a
browser case package with a downsampled CT preview volume, nodule residual/alpha
volumes, and airway graph.

For the virtual bronchoscope, place the Slicer-exported airway surface mesh at:

```text
web/public/cases/default/airway_surface.stl
```

The STL exported by Slicer should keep its native `SPACE=LPS` coordinates; the
web app converts that mesh into the route/CT coordinate space at load time.

Prepare or refresh the web case data:

```bash
PYTHONPATH=src .venv/bin/python -m bronchoedu.scripts.prepare_web_case \
  --ct data/target/target_clean_ct.nrrd \
  --network-vtk "data/airway/Network model.vtk" \
  --route-json outputs/routes/route_to_synthetic_nodule.json \
  --out-dir web/public/cases/default \
  --case-id synthetic-target \
  --stride 2 \
  --nodule-asset-dir outputs/assets/lung_nodule_1
```

To bake a scope calibration export into the browser case, add:

```bash
  --scope-calibration-json outputs/scope_calibration.json
```

To import AirMorph/AirwayNet anatomical labels, first run AirMorph externally,
then map its label volumes onto the Slicer network:

```bash
PYTHONPATH=src .venv/bin/python -m bronchoedu.scripts.import_airmorph_labels \
  --network-vtk "data/airway/Network model.vtk" \
  --ct data/target/target_clean_ct.nrrd \
  --pred-lob outputs/airmorph/patient_pred_lob.nii.gz \
  --pred-seg outputs/airmorph/patient_pred_seg.nii.gz \
  --pred-sub outputs/airmorph/patient_pred_sub.nii.gz \
  --airway-bin outputs/airmorph/airway_bin.nii.gz \
  --class2anno outputs/airmorph/class2anno.json \
  --out-json outputs/airway_anatomy_labels.json
```

Then add the labels to `bronchoedu-prepare-web-case`:

```bash
  --airway-anatomy-json outputs/airway_anatomy_labels.json
```

To visually review book-rule candidate labels, export a candidate sidecar with
reviewed parent-context seeds and place it next to `case.json`:

```bash
PYTHONPATH=src .venv/bin/python -m airway_labeling.scripts.export_book_candidates \
  --network-vtk "data/airway/Network model.vtk" \
  --out-json web/public/cases/default/book_candidates.json \
  --node-label 3=RUL \
  --node-label 10=RLL_BASAL
```

`bronchoedu-prepare-web-case` can also bake the same candidates into `case.json`:

```bash
  --airway-candidates-json web/public/cases/default/book_candidates.json
```

Run the app:

```bash
cd web
npm install
npm run dev
```

Open the Vite URL. The airway map lets the learner drag/snap the red target to a
terminal branch, and the CT panes blend the reusable nodule volume into that
location. The CT panels show standard axial/coronal/sagittal slices with no
airway outline by default; the centerline overlay is optional. At each decision,
choose A/B/C from the bronchoscope view, then the selected branch and correct
branch are highlighted on the CT views.

CT interaction:

- Scroll over any CT pane to move that pane through nearby slices.
- Use the CT zoom control, or hold Shift/Command/Ctrl while scrolling over a CT
  pane, to zoom the CT views.
- Use **Airway CT** to switch the three CT panes from standard anatomical planes
  to airway cross-section plus two airway long-axis views.
- Use **Recenter CT slices** to return all panes to the active branch point.
- Use **Prev endpoint**, **Next endpoint**, or drag the red map target to snap
  the synthetic nodule to a different terminal airway branch.

Temporary scope calibration:

- Enable **Scope debug** to show camera controls for the active branch point.
- Use **Prev view** and **Next view** to step through branch points without
  answering the quiz.
- Adjust **Back**, **Aim**, **Yaw**, **Pitch**, **Roll**, and **FOV** to realign
  problematic bronchoscopic frames.
- Drag A/B/C labels directly in the bronchoscope pane when they are misplaced.
- Use **Export JSON** to save the current calibration, **Import JSON** to merge a
  saved calibration back into this browser, or **Clear all calibration** to
  reset local calibration. Imported and edited offsets are saved in browser
  local storage.

## Tests

```bash
.venv/bin/python -m pytest -q
```
