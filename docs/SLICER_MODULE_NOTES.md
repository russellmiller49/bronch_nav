# Slicer module notes for Codex

## Module name

`BronchoscopicBranchTracer`

## First-pass module behavior

The first pass does not need to perform nodule insertion inside Slicer. Keep insertion as CLI/Python. The Slicer module should consume the generated outputs:

```text
synthetic_ct.nrrd
synthetic_nodule_mask.nrrd
route_to_synthetic_nodule.json
Network model.vtk
```

## Suggested Slicer interactions

### Create a route curve

```python
routeNode = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsCurveNode", "Airway route")
for p in route_points_ras:
    routeNode.AddControlPointWorld(vtk.vtkVector3d(float(p[0]), float(p[1]), float(p[2])))
routeNode.GetDisplayNode().SetVisibility(True)
```

### Create/update current position marker

```python
fid = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "Current bronchoscope")
fid.AddControlPointWorld(vtk.vtkVector3d(*origin_ras))
# Later:
fid.SetNthControlPointPositionWorld(0, vtk.vtkVector3d(*origin_ras))
```

### Move crosshair

```python
crosshair = slicer.util.getNode("Crosshair")
crosshair.SetCrosshairRAS(origin_ras)
```

### Set arbitrary slice plane

Slicer has APIs such as `vtkMRMLSliceNode.SetSliceToRASByNTP`. Confirm exact signature against the Slicer version being used. The frame JSON gives enough information:

```text
origin_ras
normal_ras
x_axis_ras / y_axis_ras
```

A typical pattern is:

```python
sliceNode = slicer.app.layoutManager().sliceWidget("Red").mrmlSliceNode()
normal = plane["normal_ras"]
transverse = plane["x_axis_ras"]
origin = plane["origin_ras"]
sliceNode.SetSliceToRASByNTP(
    normal[0], normal[1], normal[2],
    transverse[0], transverse[1], transverse[2],
    origin[0], origin[1], origin[2],
    0,
)
sliceNode.UpdateMatrices()
```

If this is brittle, implement a fallback that moves the crosshair to the current route point and leaves the standard axial/coronal/sagittal planes synchronized.

### Update 3D camera

```python
viewNode = slicer.app.layoutManager().threeDWidget(0).mrmlViewNode()
cameraNode = slicer.modules.cameras.logic().GetViewActiveCameraNode(viewNode)
camera = cameraNode.GetCamera()
camera.SetPosition(*camera_position_ras)
camera.SetFocalPoint(*camera_focal_point_ras)
camera.SetViewUp(*camera_up_ras)
cameraNode.Modified()
```

The route frame contains `bronchoscope_camera` fields. If camera behavior looks disorienting, default to an external overview camera and make virtual bronchoscope camera optional.

## Branch quiz UI

Each bifurcation decision includes candidate branches. The UI should display:

- branch option number
- length
- mean/min radius
- angle to target
- endpoint-to-target distance

Hide `is_correct_next_branch` until the learner clicks an option.

## Educational text

At each bifurcation, show:

```text
At this bifurcation, which branch leads toward the lesion?
```

After selection, show:

```text
Correct: this branch decreases distance to the target and follows the planned route.
```

or:

```text
Incorrect: this branch courses away from the target; compare endpoint-to-target distance and CT plane correlate.
```
