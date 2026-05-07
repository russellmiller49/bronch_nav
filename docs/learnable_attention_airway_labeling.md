# Learnable-Attention Airway Labeling Investigation

Source repos:

- Learnable-attention repo: https://github.com/EndoluminalSurgicalVision-IMR/Reflecting-Topology-Consistency-and-Abnormality-via-Learnable-Attentions
- AirMorph/AirwayNet repo: https://github.com/EndoluminalSurgicalVision-IMR/AirMorph

Local clones:

- `external_repos/Reflecting-Topology-Consistency-and-Abnormality-via-Learnable-Attentions`
- `external_repos/AirMorph`

## Upstream Input And Output Contract

`data_process/process_data.py` expects three NIfTI inputs:

- `label_path`: binary airway segmentation mask, `.nii.gz`
- `skel_path`: airway skeleton, `.nii.gz`
- `lobe_path`: lung lobe segmentation from the `lung_mask` package

The processing path is:

1. `tree_parse(label_path, skel_path)` assigns one integer component id per branch and returns branch topology: `parent_map`, `children_map`, `generation`, `trachea`, skeleton parse volume, and airway parse volume.
2. `feature_extraction_cuda(...)` extracts graph tensors from the parsed skeleton and lobe mask.
3. The intended saved outputs are `skel_parse.nii.gz`, `parse.nii.gz`, `x.npy`, `edge.npy`, `edge_feature.npy`, and `node_idx.npy`.

The dataset/test code expects a per-case graph layout:

- `{patient}_x.npy`: `(N, 20)` branch feature matrix. The model input is `x[:, 0:11]` plus `x[:, 13:17]`, so the network actually receives 15 features.
- `{patient}_edge.npy`: `(2, E)` directed edge index array.
- `{patient}_edge_feature.npy`: `(E,)`, where `1` means parent-to-child and `-1` means child-to-parent.
- `{patient}_node_idx.npy`: `(N,)` branch-row to parsed-volume node mapping.
- `{patient}_y.npy`: three label vectors `[y_lobar, y_seg, y_subseg]`; required by the provided train/test dataset loader.
- `{patient}_spd.npy`: `(N, N)` branch graph shortest-path distance matrix, loaded from a separate topology path.

Important loader caveat: `data_process/dataset.py` uses `patient = file[i * 6].split("_")[0]`, so compatible case ids must not contain underscores, and the feature directory must contain exactly the expected six files per case.

## Model Outputs

`models/network.py` defines `our_net(...)`. Its forward pass returns ten tensors:

1. Stage-1 lobar logits
2. Stage-1 segmental logits
3. Stage-1 subsegmental logits
4. Stage-2 lobar logits
5. Stage-2 segmental logits
6. Stage-2 subsegmental logits
7. Stage-1 learned node-pair/topology attention
8. Stage-2 learned node-pair/topology attention
9. Stage-1 outlier score
10. Stage-2 outlier score

`test/test.py` evaluates the Stage-2 logits at outputs 4-6 and uses `checkpoints/best.ckpt`.

## Actual Labels In `anno_class_dict.json`

Lobar labels are the same as AirMorph/AirwayAtlas:

| id | label |
| --- | --- |
| 0 | trachea |
| 1 | Left Upper Lobe |
| 2 | Left Lower Lobe |
| 3 | Right Upper Lobe |
| 4 | Right Middle Lobe |
| 5 | Right Lower Lobe |

Segmental labels are also the same anatomical set as AirMorph:

| id | label |
| --- | --- |
| 0 | LB1+2 |
| 1 | LB3 |
| 2 | LB4 |
| 3 | LB5 |
| 4 | LB6 |
| 5 | LB8 |
| 6 | LB9 |
| 7 | LB10 |
| 8 | RB1 |
| 9 | RB2 |
| 10 | RB3 |
| 11 | RB4 |
| 12 | RB5 |
| 13 | RB6 |
| 14 | RB7 |
| 15 | RB8 |
| 16 | RB9 |
| 17 | RB10 |
| 18 | Trachea |
| 19 | LB7 |

Subsegmental labels are broader than AirMorph. The learned-attention JSON uses one-based ids for this dictionary:

| id range | labels |
| --- | --- |
| 1 | trachea |
| 2-8 | LB1+2, LB1+2a, LB1+2b, LB1+2c, LB1+2a+b, LB1+2b+c, LB1+2a+c |
| 9-15 | LB3, LB3a, LB3b, LB3c, LB3a+b, LB3b+c, LB3a+c |
| 16-22 | LB4, LB4a, LB4b, LB4c, LB4a+b, LB4b+c, LB4a+c |
| 23-29 | LB5, LB5a, LB5b, LB5c, LB5a+b, LB5b+c, LB5a+c |
| 30-36 | LB6, LB6a, LB6b, LB6c, LB6a+b, LB6b+c, LB6a+c |
| 37-43 | LB8, LB8a, LB8b, LB8c, LB8a+b, LB8b+c, LB8a+c |
| 44-50 | LB9, LB9a, LB9b, LB9c, LB9a+b, LB9b+c, LB9a+c |
| 51-57 | LB10, LB10a, LB10b, LB10c, LB10a+b, LB10b+c, LB10a+c |
| 58-64 | RB1, RB1a, RB1b, RB1c, RB1a+b, RB1b+c, RB1a+c |
| 65-71 | RB2, RB2a, RB2b, RB2c, RB2a+b, RB2b+c, RB2a+c |
| 72-78 | RB3, RB3a, RB3b, RB3c, RB3a+b, RB3b+c, RB3a+c |
| 79-85 | RB4, RB4a, RB4b, RB4c, RB4a+b, RB4b+c, RB4a+c |
| 86-92 | RB5, RB5a, RB5b, RB5c, RB5a+b, RB5b+c, RB5a+c |
| 93-99 | RB6, RB6a, RB6b, RB6c, RB6a+b, RB6b+c, RB6a+c |
| 100-106 | RB7, RB7a, RB7b, RB7c, RB7a+b, RB7b+c, RB7a+c |
| 107-113 | RB8, RB8a, RB8b, RB8c, RB8a+b, RB8b+c, RB8a+c |
| 114-120 | RB9, RB9a, RB9b, RB9c, RB9a+b, RB9b+c, RB9a+c |
| 121-127 | RB10, RB10a, RB10b, RB10c, RB10a+b, RB10b+c, RB10a+c |
| 128-134 | LB7, LB7a, LB7b, LB7c, LB7a+b, LB7b+c, LB7a+c |
| 135 | abnormal |

Indexing caveat: `config/config.py` sets `num_classes3 = 135`, but the JSON contains `abnormal: 135`, and `utils.calculate_CS` treats predicted subsegmental class `0` as the trachea/background skip class. Before using the JSON as an inverse prediction map, verify whether the trained checkpoint expects zero-based logits or the one-based annotation ids.

## Pretrained Weights And Sample Data

The learnable-attention repo does not include pretrained weights or sample tensors. A local search found no `.ckpt`, `.pth`, `.pt`, `.npy`, `.npz`, `.nii`, or `.nii.gz` files in the cloned repo. The provided test script references `checkpoints/best.ckpt`, but that file is absent, and `config/config.py` leaves all data paths empty except `top_test="/"`.

AirMorph does reference external Google Drive links for checkpoints and sample data, but those weights are not vendored in its repo either.

## Converter From Slicer/VMTK Network To Graph Format

Implemented converter:

```bash
PYTHONPATH=src .venv/bin/python -m airway_labeling.scripts.export_learnable_attention_graph \
  --network-vtk "data/airway/Network model.vtk" \
  --out-dir outputs/learnable_attention_graph \
  --patient-id patient01 \
  --write-placeholder-y
```

Outputs:

```text
outputs/learnable_attention_graph/
├── features/
│   ├── patient01_edge.npy
│   ├── patient01_edge_feature.npy
│   ├── patient01_node_idx.npy
│   ├── patient01_parse_placeholder.npy
│   ├── patient01_x.npy
│   └── patient01_y.npy
├── metadata/
│   └── patient01_branch_metadata.json
└── topology/
    └── patient01_spd.npy
```

For the bundled `Network model.vtk`, the converter produced:

- `branch_count = 418`
- `x.shape = (418, 20)`
- `edge.shape = (2, 834)`
- `edge_feature.shape = (834,)`
- `spd.shape = (418, 418)`

The converter maps each Slicer/VMTK network edge to one model branch row, orients it proximal-to-distal using root distance, builds parent/child branch edges, computes graph shortest paths, and writes metadata mapping `row_index` back to VTK `edge_id`/`cell_id`. The feature matrix is compatible in shape with the upstream model, but it is an approximation from RAS centerline geometry rather than the repo's original voxel-index skeleton plus lobe-mask feature pipeline.

## Included Test Script Result

Attempted:

```bash
/Users/russellmiller/Projects/navigation_module/.venv/bin/python test/test.py
```

from the learned-attention repo clone. It failed immediately with:

```text
ModuleNotFoundError: No module named 'torch'
```

Even with PyTorch installed, the script would still need configured test data paths and `checkpoints/best.ckpt`, neither of which is included in the repo.

## AirMorph/AirwayAtlas Comparison

The lobar and segmental label spaces match in anatomical meaning between AirMorph and the learnable-attention repo.

The subsegmental space differs:

- AirMorph has 82 subsegmental ids, zero-based from `trachea=0` through `LB7b=81`.
- Learnable-attention has 135 named subsegmental ids in `anno_class_dict.json`, with broader `c` and combined-trunk variants for most segmental bronchi and an `abnormal` label.
- Learnable-attention includes labels AirMorph lacks, such as `LB4c`, `LB5c`, `LB8c`, `RB1c`, `RB4c`, `RB7c`, and many `a+b`, `b+c`, `a+c` combinations.
- A direct numeric comparison is unsafe until the subsegmental indexing caveat is resolved.

Because no learned-attention pretrained checkpoint is available locally, there are no predicted labels to compare against AirMorph/AirwayAtlas yet. The next useful step is either to obtain `best.ckpt` from the authors or train/fine-tune a checkpoint, then add an unlabeled inference script that loads `x`, `edge`, `edge_feature`, and `spd` without requiring ground-truth `y`.

## Matching LIDC Airway Annotation Rebuild

`annotations/LIDC-IDRI_annotation/1.3.6.1.4.1.14519.5.2.1.6279.6001.168037818448885856452592057286.nii.gz` matches the target CT geometry exactly. It is a binary airway mask, not an anatomical label volume.

Implemented helper:

```bash
PYTHONPATH=src .venv/bin/python -m airway_labeling.scripts.rebuild_mask_graph \
  --mask annotations/LIDC-IDRI_annotation/1.3.6.1.4.1.14519.5.2.1.6279.6001.168037818448885856452592057286.nii.gz \
  --out-dir outputs/airway_annotation_rebuild \
  --case-id lidc_target_largest \
  --network-vtk "data/airway/Network model.vtk" \
  --reference-airway-mask Airway.seg.nrrd \
  --keep-skeleton-components 1
```

Main outputs:

```text
outputs/airway_annotation_rebuild/lidc_target_largest_mask.nrrd
outputs/airway_annotation_rebuild/lidc_target_largest_skeleton.nrrd
outputs/airway_annotation_rebuild/lidc_target_largest_skeleton_graph.json
outputs/airway_annotation_rebuild/lidc_target_largest_skeleton_network.vtk
outputs/airway_annotation_rebuild/lidc_target_largest_current_network_supported.vtk
outputs/airway_annotation_rebuild/lidc_target_largest_current_network_supported_or_partial.vtk
outputs/airway_annotation_rebuild/lidc_target_largest_comparison.json
```

Findings:

- LIDC airway mask voxels: `281,636`
- Existing `Airway.seg.nrrd` voxels: `577,634`
- Dice overlap: `0.640278`
- Existing airway voxels outside LIDC mask: `302,548`
- Existing VMTK network branches supported by the LIDC mask at >= 90% centerline-point overlap: `185 / 418`
- Partial branches: `139 / 418`
- Outside branches: `94 / 418`

The direct SimpleITK skeleton is useful for QA, but it is not VMTK-quality: thinning produced 128 skeleton components before filtering. The more useful artifact is the pruned current VMTK network, especially `lidc_target_largest_current_network_supported.vtk`, which preserves the original smooth centerline geometry while showing only branches strongly supported by the LIDC airway annotation.
