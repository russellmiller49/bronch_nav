"""Import anatomical airway labels produced by AirMorph/AirwayNet.

AirMorph is treated as an upstream inference tool. This module maps its label
volumes onto the Slicer/VMTK airway network used by the teaching app.
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
import SimpleITK as sitk

from .airway_route import AirwayNetwork
from .coordinates import ras_to_lps
from .io import assert_geometry_match, image_summary, read_image

SCHEMA = "bronchoedu_airway_anatomy/v1"

_LEVEL_TO_AIRMORPH_KEY = {
    "lobe": "lob",
    "segment": "seg",
    "subsegment": "subseg",
}


@dataclass(frozen=True)
class LabelVolume:
    image: sitk.Image
    array_zyx: np.ndarray


@dataclass(frozen=True)
class AirMorphLabelVolumes:
    lobe: LabelVolume
    segment: LabelVolume
    subsegment: LabelVolume
    airway_bin: LabelVolume | None = None

    @property
    def reference_image(self) -> sitk.Image:
        return self.lobe.image


def load_class2anno(path: str | Path) -> dict[str, dict[int, str]]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("AirMorph class2anno JSON must contain an object.")

    out: dict[str, dict[int, str]] = {}
    for level, airmorph_key in _LEVEL_TO_AIRMORPH_KEY.items():
        raw_mapping = payload.get(airmorph_key)
        if not isinstance(raw_mapping, dict):
            raise ValueError(f"AirMorph class2anno JSON is missing {airmorph_key!r}.")
        out[level] = {int(value): str(name) for value, name in raw_mapping.items()}
    return out


def load_label_volumes(
    pred_lob: str | Path,
    pred_seg: str | Path,
    pred_sub: str | Path,
    *,
    reference_ct: str | Path | None = None,
    airway_bin: str | Path | None = None,
) -> AirMorphLabelVolumes:
    lobe_img = read_image(pred_lob)
    segment_img = read_image(pred_seg)
    subsegment_img = read_image(pred_sub)

    assert_geometry_match(lobe_img, segment_img, context="AirMorph lobe/segment label geometry")
    assert_geometry_match(lobe_img, subsegment_img, context="AirMorph lobe/subsegment label geometry")
    if reference_ct is not None:
        assert_geometry_match(read_image(reference_ct), lobe_img, context="AirMorph label/reference CT geometry")

    airway_volume = None
    if airway_bin is not None:
        airway_img = read_image(airway_bin)
        assert_geometry_match(lobe_img, airway_img, context="AirMorph label/airway-bin geometry")
        airway_volume = LabelVolume(airway_img, sitk.GetArrayFromImage(airway_img))

    return AirMorphLabelVolumes(
        lobe=LabelVolume(lobe_img, sitk.GetArrayFromImage(lobe_img)),
        segment=LabelVolume(segment_img, sitk.GetArrayFromImage(segment_img)),
        subsegment=LabelVolume(subsegment_img, sitk.GetArrayFromImage(subsegment_img)),
        airway_bin=airway_volume,
    )


def anatomy_for_points(
    points_ras: Iterable[Sequence[float]],
    volumes: AirMorphLabelVolumes,
    class2anno: Mapping[str, Mapping[int, str]],
) -> dict[str, Any]:
    points = [tuple(float(v) for v in point) for point in points_ras]
    counts: dict[str, Counter[int]] = {
        "lobe": Counter(),
        "segment": Counter(),
        "subsegment": Counter(),
    }
    valid_samples = 0

    for point_ras in points:
        labels = _sample_label_triplet(point_ras, volumes)
        if labels is None:
            continue
        valid_samples += 1
        for level, value in labels.items():
            counts[level][value] += 1

    sample_count = len(points)
    anatomy: dict[str, Any] = {
        "sampleCount": sample_count,
        "validSampleCount": valid_samples,
        "coverage": _rounded_ratio(valid_samples, sample_count),
    }

    confidences: list[float] = []
    for level in ("lobe", "segment", "subsegment"):
        label = _majority_label(counts[level], class2anno.get(level, {}), valid_samples)
        if label is not None:
            anatomy[level] = label
            confidences.append(float(label["confidence"]))
    anatomy["confidence"] = round(min(confidences), 4) if confidences else 0.0
    return anatomy


def import_airmorph_labels(
    *,
    network_vtk: str | Path,
    pred_lob: str | Path,
    pred_seg: str | Path,
    pred_sub: str | Path,
    class2anno_json: str | Path,
    out_json: str | Path,
    reference_ct: str | Path | None = None,
    airway_bin: str | Path | None = None,
    anno_json: str | Path | None = None,
) -> dict[str, Any]:
    class2anno = load_class2anno(class2anno_json)
    volumes = load_label_volumes(
        pred_lob,
        pred_seg,
        pred_sub,
        reference_ct=reference_ct,
        airway_bin=airway_bin,
    )
    network = AirwayNetwork.from_network_vtk(network_vtk)

    edges = {
        str(edge.id): anatomy_for_points(edge.points_ras, volumes, class2anno)
        for edge in network.edges
    }
    nodes = {
        str(node.id): anatomy_for_points([node.ras], volumes, class2anno)
        for node in network.nodes
    }

    source: dict[str, Any] = {
        "generator": "AirMorph/AirwayNet external import",
        "networkVtk": str(network_vtk),
        "predLob": str(pred_lob),
        "predSeg": str(pred_seg),
        "predSub": str(pred_sub),
        "class2anno": str(class2anno_json),
        "referenceCt": str(reference_ct) if reference_ct is not None else None,
        "airwayBin": str(airway_bin) if airway_bin is not None else None,
        "annoJson": str(anno_json) if anno_json is not None else None,
        "labelImage": image_summary(volumes.reference_image),
        "reviewStatus": "unreviewed",
    }
    if anno_json is not None:
        source["annoEntryCount"] = _count_anno_entries(anno_json)

    payload = {
        "schema": SCHEMA,
        "educationOnly": True,
        "notForClinicalUse": True,
        "source": source,
        "nodes": nodes,
        "edges": edges,
    }
    Path(out_json).parent.mkdir(parents=True, exist_ok=True)
    Path(out_json).write_text(json.dumps(payload, indent=2, allow_nan=False), encoding="utf-8")
    return payload


def _sample_label_triplet(point_ras: Sequence[float], volumes: AirMorphLabelVolumes) -> dict[str, int] | None:
    index_xyz = _point_ras_to_index_xyz(point_ras, volumes.reference_image)
    if index_xyz is None:
        return None
    if volumes.airway_bin is not None and _sample_array(volumes.airway_bin.array_zyx, index_xyz) <= 0:
        return None
    return {
        "lobe": _sample_array(volumes.lobe.array_zyx, index_xyz),
        "segment": _sample_array(volumes.segment.array_zyx, index_xyz),
        "subsegment": _sample_array(volumes.subsegment.array_zyx, index_xyz),
    }


def _point_ras_to_index_xyz(point_ras: Sequence[float], image: sitk.Image) -> tuple[int, int, int] | None:
    point_lps = ras_to_lps(point_ras)
    continuous = image.TransformPhysicalPointToContinuousIndex(point_lps)
    index = tuple(int(round(value)) for value in continuous)
    size = image.GetSize()
    if any(value < 0 for value in index) or any(index[axis] >= size[axis] for axis in range(3)):
        return None
    return index


def _sample_array(array_zyx: np.ndarray, index_xyz: Sequence[int]) -> int:
    x, y, z = (int(value) for value in index_xyz)
    return int(array_zyx[z, y, x])


def _majority_label(counts: Counter[int], mapping: Mapping[int, str], denominator: int) -> dict[str, Any] | None:
    if not counts or denominator <= 0:
        return None
    value, count = max(counts.items(), key=lambda item: (item[1], -item[0]))
    return {
        "value": int(value),
        "name": str(mapping.get(int(value), f"class_{int(value)}")),
        "confidence": _rounded_ratio(count, denominator),
    }


def _rounded_ratio(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return round(float(numerator) / float(denominator), 4)


def _count_anno_entries(path: str | Path) -> int:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    return len(payload) if isinstance(payload, dict) else 0
