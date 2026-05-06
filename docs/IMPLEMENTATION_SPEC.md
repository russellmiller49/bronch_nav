# Implementation specification

## 1. Product definition

Create an educational tool that allows faculty to synthesize pulmonary nodules in a clean target CT and then teach airway branch tracing to that lesion using CT-plane correlation and virtual bronchoscopy-style route navigation.

This is not a diagnostic or navigation device. It should be labeled as educational/synthetic in all outputs.

## 2. Main user workflows

### Faculty authoring workflow

```text
1. Load source CT containing a real nodule.
2. Export nodule segmentation as a labelmap using the source CT as reference.
3. Create reusable nodule asset.
4. Load clean target CT.
5. Insert nodule asset at a chosen RAS coordinate.
6. Generate synthetic CT and synthetic nodule mask.
7. Generate airway route JSON from synthetic mask centroid.
8. Open synthetic CT + route JSON in Slicer branch-tracing module.
9. Add teaching notes and branch-choice explanations.
```

### Learner workflow

```text
1. Open teaching case.
2. See synthetic CT and lesion.
3. Advance along bronchoscopic route using slider/playback.
4. At each bifurcation, choose the branch that leads to the lesion.
5. See CT-plane correlate and feedback.
```

## 3. Core software components

### Nodule asset creator

Converts source CT + labelmap into reusable 3D asset.

Important behaviors:

- strict geometry validation between source CT and mask
- support label value and label name lookup
- crop around selected label with margin in mm
- soft alpha mask generation
- residual nodule signal generation
- metadata JSON

### Nodule inserter

Resamples nodule asset into target CT geometry.

Important behaviors:

- RAS input coordinate converted to LPS for SimpleITK
- output CT geometry exactly matches target CT
- write inserted nodule mask
- write placement metadata
- residual insertion as default
- direct alpha blending as secondary option

### Route planner

Uses `Network model.vtk` and lesion centroid to produce route JSON.

Important behaviors:

- parse legacy binary VTK without requiring VTK Python, using existing adapter
- convert airway LPS to RAS once
- nearest-edge projection to lesion
- root-to-target graph route
- CT/camera frames using parallel transport
- bifurcation branch-decision metadata

### Slicer module

Loads route JSON and synthetic CT.

Important behaviors:

- slider controls route index
- current marker follows airway centerline
- route curve displayed
- lesion marker displayed
- CT planes update using route frames
- branch-decision prompt at bifurcations

## 4. Implementation priorities

### Must-have MVP

- CLI end-to-end pipeline works.
- Slicer module can load route JSON and show route slider.
- Synthetic CT has nodule embedded in voxel volume.
- Route is generated from synthetic nodule mask centroid.

### Nice-to-have after MVP

- Target lung mask placement validation.
- Vessel/airway overlap warnings.
- Nodule library browser.
- Faculty case-authoring notes.
- Web viewer.
- Poisson/gradient-domain blending.
- Noise/kernel matching.

## 5. Non-goals for MVP

- Clinical validation.
- Robotic platform integration.
- Real-time bronchoscope video registration.
- FDA-regulated clinical navigation claims.
- Fully automated airway segmentation.
