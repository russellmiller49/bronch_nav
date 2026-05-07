# AirMorph Lambda Runner

This is a small remote-runner subrepo for processing the navigation-module CT with AirMorph/AirwayNet on a Lambda Labs GPU instance. It does not vendor AirMorph; it clones the upstream project, installs its environment, runs the CT through AirMorph, and maps the resulting labels onto the bundled `Network model.vtk`.

## Local Bundle

From the root of `navigation_module` on your local machine:

```bash
./airmorph_lambda_runner/scripts/make_bundle.sh
```

That creates:

```text
outputs/airmorph_lambda_runner_bundle.tar.gz
```

The bundle includes:

- `data/target/target_clean_ct.nrrd`
- `data/airway/Network model.vtk`
- this runner
- the local `bronchoedu` importer code needed to produce `airway_anatomy_labels.json`

Upload it to the Lambda instance:

```bash
scp outputs/airmorph_lambda_runner_bundle.tar.gz ubuntu@LAMBDA_IP:~
```

## Run On Lambda

On the Lambda instance:

```bash
tar -xzf airmorph_lambda_runner_bundle.tar.gz
cd airmorph_lambda_runner
cursor .
./scripts/run_all.sh
```

The script will:

1. Clone AirMorph.
2. Create/update the `airwayatlas` conda environment.
3. Install PyTorch CUDA wheels and AirMorph requirements.
4. Try to download AirMorph checkpoints with `gdown`.
5. Convert the bundled CT to AirMorph’s `image.nii.gz` case layout.
6. Run AirMorph segmentation and anatomy classification.
7. Import the labels onto `Network model.vtk`.
8. Create `outputs/target_clean_ct_airmorph_results.tar.gz`.

If Google Drive checkpoint download fails, place these files in `AirMorph/checkpoints/` and rerun `./scripts/run_all.sh`:

```text
airway_model1.pth
airway_model2.pth
airway_model3.pth
break1.ckpt
wingsnet.ckpt
airway_cls.ckpt
```

## Results

The main result is:

```text
outputs/target_clean_ct/airway_anatomy_labels.json
```

The archive also includes AirMorph volumes such as:

```text
airway_bin.nii.gz
target_clean_ct_pred_lob.nii.gz
target_clean_ct_pred_seg.nii.gz
target_clean_ct_pred_sub.nii.gz
target_clean_ct_anno.json
```

Download the archive back locally:

```bash
scp ubuntu@LAMBDA_IP:~/airmorph_lambda_runner/outputs/target_clean_ct_airmorph_results.tar.gz outputs/
```

Then unpack and pass the JSON into the web-case build:

```bash
tar -xzf outputs/target_clean_ct_airmorph_results.tar.gz -C outputs
PYTHONPATH=src .venv/bin/python -m bronchoedu.scripts.prepare_web_case \
  --ct data/target/target_clean_ct.nrrd \
  --network-vtk "data/airway/Network model.vtk" \
  --route-json outputs/routes/route_to_synthetic_nodule.json \
  --out-dir web/public/cases/default \
  --case-id synthetic-target \
  --stride 2 \
  --airway-anatomy-json outputs/target_clean_ct/airway_anatomy_labels.json
```

## Notes

- AirMorph’s GitHub repo currently does not advertise a license through GitHub, so this runner clones it at setup time instead of redistributing it.
- AirMorph expects a CUDA-capable Linux machine; their README describes validation on an RTX 3090 with 24 GB VRAM.
- The labels are imported as teaching metadata and should be reviewed before using them in educational material.
