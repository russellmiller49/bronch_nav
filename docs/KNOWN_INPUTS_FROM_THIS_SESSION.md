# Known inputs from this session

## Airway VTK data

The airway network file has already been parsed successfully.

Summary:

```text
Network model.vtk coordinate system: LPS
Adapter output: RAS
Sampled airway points: 9,947
Airway branch segments: 418
Graph nodes: 417
Terminal nodes: 209
Bifurcation nodes: 208
Root/proximal tracheal node: 385
Root RAS: [5.9960, 178.9888, -56.7153]
Carina/first major branch node: 0
Carina RAS: [11.8954, 155.7244, -172.2558]
```

## Uploaded Slicer segmentation export

The uploaded labelmap header was:

```text
NRRD0004
type: short
dimension: 3
space: left-posterior-superior
sizes: 512 512 278
space directions: (0.693359375,0,0) (0,0.693359375,0) (0,0,1)
space origin: (-168.1533203125,-347.6533203125,-281)
encoding: raw
```

The labels CSV listed:

```text
1: trachea and bronchus
2: airway wall
3: pulmonary artery
4: pulmonary vein
5: lung_nodule_1
6: Lung_nodule_2
```

The uploaded mask had these nonzero voxel counts:

```text
1: 175,488
2: 251,764
3: 597,067
4: 449,271
5: 2,694
6: 177
```

The implementation should handle this multi-label segmentation cleanly by extracting label 5 or 6 into a binary mask before creating a nodule asset.
