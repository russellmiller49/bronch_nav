# Airway Branch Tracer — VTK Integration Notes

## Uploaded files analyzed

The uploaded files are enough to move the project from a branch-level concept to a smooth navigable airway-path module.

Files:

- `Network model.vtk`
- `Centerline model.vtk`
- `Network properties.tsv`
- `Centerline quantification.tsv`

## Key finding

`Network model.vtk` is the most useful runtime file. It contains the full sampled airway branch polylines, not just branch start/end points.

Parsed network model:

```text
Input coordinate system: LPS
Exported adapter coordinate system: RAS
Sampled polyline points: 9,947
Airway branch segments / edges: 418
Graph nodes: 417
Terminal nodes: 209
Bifurcation nodes, degree >= 3: 208
Degree distribution: 209 degree-1, 205 degree-3, 3 degree-4
Root/proximal tracheal node: node 385
Root RAS: [5.9960, 178.9888, -56.7153]
Carina/first major branch node: node 0
Carina RAS: [11.8954, 155.7244, -172.2558]
Total network branch length: 5376.7122 mm
Longest edge: 127.9930 mm, corresponding to the proximal tracheal/root-to-carina segment
```

The model header states `SPACE=LPS`. The TSV values are in RAS-style coordinates. The adapter therefore converts coordinates as:

```text
RAS = [-LPS_x, -LPS_y, LPS_z]
```

Vectors are converted with the same sign flip:

```text
vector_RAS = [-vector_LPS_x, -vector_LPS_y, vector_LPS_z]
```

## What this means for the module

The earlier TSV tables were enough for graph routing and branch decisions. The VTK model now gives the missing piece: continuous branch geometry for smooth scrolling and camera movement.

The module should use:

```text
Network model.vtk
  -> full sampled airway geometry
  -> branch graph
  -> edge length, tortuosity
  -> per-point radius, curvature, torsion, Frenet vectors

Network properties.tsv
  -> useful validation and human-readable metrics

Centerline model.vtk
  -> appears to contain multiple complete root-to-terminal paths
  -> useful for comparison and QA, but less clean than Network model.vtk for graph routing
```

## Runtime data flow

```text
CT DICOM volume
  +
Network model.vtk
  +
lesion RAS coordinate or lesion segmentation centroid
  ↓
bronchoscopy_airway_vtk_adapter.py
  ↓
route JSON
  ↓
branch-tracing module
```

The route JSON provides:

- tracheal/root start point
- carina point
- nearest airway segment to lesion
- airway-to-lesion distance
- route edge IDs and cell IDs
- ordered route points in RAS space
- bifurcation decision list
- candidate child branches at each bifurcation
- correct branch for each decision
- CT-plane frames for each route point
- virtual bronchoscope camera position, view direction, and up vector

## CT plane behavior

For every route point, the adapter computes a parallel-transport frame:

```text
origin = airway centerline point
T = local tangent
N = transported normal
B = binormal = T x N
```

These drive three default CT planes:

```text
1. Airway cross-section plane
   x-axis = N
   y-axis = B
   normal = T

2. Long-axis plane using normal
   x-axis = T
   y-axis = N
   normal = B

3. Long-axis plane using binormal
   x-axis = T
   y-axis = B
   normal = N
```

If a lesion target is supplied, the route JSON also includes a lesion-directed long-axis plane:

```text
x-axis = airway tangent
 y-axis = projection of lesion vector onto plane perpendicular to airway tangent
normal = cross(tangent, lesion_axis)
```

This is the plane that should be most useful for teaching the airway-to-lesion relationship as the learner advances.

## Branch-decision exercise

At each bifurcation, the route JSON contains candidate distal branches. For each option, the adapter stores:

```text
edge_id / cell_id
to_node_id
to_node_ras
length_mm
mean_radius_mm
min_radius_mm
first_direction_ras
angle_to_target_degrees
endpoint_to_target_distance_mm
is_correct_next_branch
```

This can directly power the learner prompt:

```text
At this bifurcation, which branch leads toward the lesion?
```

The UI can hide `is_correct_next_branch` until the learner selects an answer.

## Example route included

The package includes `example_route_to_terminal_like_target.json`, routed to this example target:

```text
Target RAS: [49.9669, 123.7354, -310.0783]
Nearest airway edge/cell: 351
Airway-to-target distance: 0.4738 mm
Path length to projection: 300.4598 mm
Route edge count: 13
Route point count: 123
Bifurcation decisions: 12
Route cell IDs: [365, 0, 3, 9, 22, 45, 88, 149, 220, 285, 330, 343, 351]
```

This is only a test target near a terminal airway. A real module should pass the actual pulmonary nodule centroid or a projected airway target point.

## Suggested Slicer prototype wiring

1. Load the CT volume.
2. Load `Network model.vtk` for 3D airway display.
3. Run the adapter with the lesion RAS coordinate.
4. Load the resulting route JSON.
5. Add a MarkupsCurve from `route.points_ras`.
6. Add a fiducial/sphere representing the current bronchoscope position.
7. Move along the route with a slider.
8. At each slider position:
   - update the current bronchoscope fiducial
   - update the 3D camera, if desired
   - update slice nodes using the corresponding frame's CT planes
   - when the current route index reaches a bifurcation decision, show the branch-choice prompt

## Suggested web prototype wiring

Frontend:

```text
OHIF / Cornerstone3D volume viewport
VTK.js 3D airway tree and route actor
React quiz panel
```

Backend:

```text
Python / FastAPI
bronchoscopy_airway_vtk_adapter.py
SimpleITK/ITK for CT coordinate handling
```

Core frontend state:

```ts
currentRouteIndex: number
routePointsRAS: number[][]
routeFrames: Frame[]
bifurcationDecisions: BifurcationDecision[]
showCorrectRoute: boolean
selectedBranchCellId?: number
```

When the slider changes:

```text
frame = route.frames[currentRouteIndex]
set CT crosshairs to frame.origin_ras
set airway cross-section plane from frame.ct_planes.airway_cross_section
set lesion-directed plane from frame.ct_planes.lesion_directed_long_axis
set virtual bronchoscopy camera position/view/up from frame.bronchoscope_camera
```

## Development caution

Do not assume a perfect binary airway tree. This network contains three degree-4 nodes and has a small cycle rank, so branch decisions should be generated using root-distance/Dijkstra logic rather than hard-coded parent/left/right rules.

## Next concrete input needed

To generate a real lesion route, provide either:

```text
1. lesion centroid in Slicer RAS coordinates, or
2. a lesion segmentation from which the centroid can be computed.
```
