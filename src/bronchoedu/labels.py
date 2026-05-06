"""Slicer labelmap and labels CSV utilities."""

from __future__ import annotations

import csv
import math
from pathlib import Path
from typing import Any

import numpy as np
import SimpleITK as sitk

from .coordinates import lps_to_ras
from .io import ensure_parent, image_summary, read_image


def parse_slicer_labels_csv(path: str | Path | None) -> dict[int, str]:
    if not path:
        return {}
    labels: dict[int, str] = {}
    with open(path, "r", newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                labels[int(row["LabelValue"])] = row.get("Name", "")
            except (KeyError, TypeError, ValueError):
                continue
    return labels


def find_label_value(labels: dict[int, str], label_name: str) -> int:
    exact = [value for value, name in labels.items() if name == label_name]
    if len(exact) == 1:
        return exact[0]
    lowered = label_name.lower()
    ci = [value for value, name in labels.items() if name.lower() == lowered]
    if len(ci) == 1:
        return ci[0]
    contains = [value for value, name in labels.items() if lowered in name.lower()]
    if len(contains) == 1:
        return contains[0]
    raise ValueError(f"Could not uniquely identify label name {label_name!r}; candidates={labels}")


def resolve_label_value(label: int | None, label_name: str | None, labels_csv: str | Path | None) -> tuple[int, str]:
    labels = parse_slicer_labels_csv(labels_csv)
    if label is None:
        if not label_name:
            raise ValueError("Provide either --label or --label-name")
        label = find_label_value(labels, label_name)
    return int(label), labels.get(int(label), label_name or "")


def label_voxel_counts(mask_img: sitk.Image) -> dict[int, int]:
    arr = sitk.GetArrayFromImage(mask_img)
    values, counts = np.unique(arr, return_counts=True)
    return {int(value): int(count) for value, count in zip(values, counts) if int(value) != 0}


def _coords_for_label(mask_img: sitk.Image, label: int) -> np.ndarray:
    arr = sitk.GetArrayFromImage(mask_img)
    coords = np.argwhere(arr == int(label))
    if coords.size == 0:
        raise ValueError(f"No voxels found for label {label}")
    return coords


def centroid_for_label(mask_img: sitk.Image, label: int = 1) -> dict[str, Any]:
    coords_zyx = _coords_for_label(mask_img, label)
    centroid_zyx = coords_zyx.mean(axis=0)
    centroid_xyz = [float(centroid_zyx[2]), float(centroid_zyx[1]), float(centroid_zyx[0])]
    centroid_lps = mask_img.TransformContinuousIndexToPhysicalPoint(centroid_xyz)
    return {
        "label": int(label),
        "voxel_count": int(coords_zyx.shape[0]),
        "centroid_index_xyz": centroid_xyz,
        "centroid_lps": [float(v) for v in centroid_lps],
        "centroid_ras": lps_to_ras(centroid_lps),
    }


def bounding_box_for_label(mask_img: sitk.Image, label: int = 1) -> dict[str, Any]:
    coords_zyx = _coords_for_label(mask_img, label)
    min_zyx = coords_zyx.min(axis=0)
    max_zyx = coords_zyx.max(axis=0)
    min_xyz = [int(min_zyx[2]), int(min_zyx[1]), int(min_zyx[0])]
    max_xyz = [int(max_zyx[2]), int(max_zyx[1]), int(max_zyx[0])]
    corners_xyz = np.array(
        [
            [x, y, z]
            for x in (min_xyz[0], max_xyz[0])
            for y in (min_xyz[1], max_xyz[1])
            for z in (min_xyz[2], max_xyz[2])
        ],
        dtype=float,
    )
    corners_lps = [mask_img.TransformIndexToPhysicalPoint([int(x), int(y), int(z)]) for x, y, z in corners_xyz]
    corners_lps_arr = np.asarray(corners_lps, dtype=float)
    return {
        "bbox_index_zyx_min": [int(v) for v in min_zyx],
        "bbox_index_zyx_max": [int(v) for v in max_zyx],
        "bbox_index_xyz_min": min_xyz,
        "bbox_index_xyz_max": max_xyz,
        "bbox_lps_min": [float(v) for v in corners_lps_arr.min(axis=0)],
        "bbox_lps_max": [float(v) for v in corners_lps_arr.max(axis=0)],
        "bbox_ras_min": lps_to_ras(corners_lps_arr.max(axis=0)),
        "bbox_ras_max": lps_to_ras(corners_lps_arr.min(axis=0)),
    }


def label_summary(mask_img: sitk.Image, labels: dict[int, str] | None = None) -> list[dict[str, Any]]:
    labels = labels or {}
    arr = sitk.GetArrayFromImage(mask_img)
    values, counts = np.unique(arr, return_counts=True)
    out: list[dict[str, Any]] = []
    for value, count in zip(values, counts):
        value_int = int(value)
        if value_int == 0:
            continue
        entry = centroid_for_label(mask_img, value_int)
        entry.update(bounding_box_for_label(mask_img, value_int))
        entry["name"] = labels.get(value_int, "")
        entry["voxel_count"] = int(count)
        spacing = mask_img.GetSpacing()
        volume_mm3 = float(count) * float(math.prod(spacing))
        entry["volume_mm3"] = volume_mm3
        out.append(entry)
    return out


def split_labelmap_to_binary(mask_path: str | Path, out_path: str | Path, label: int) -> dict[str, Any]:
    img = read_image(mask_path)
    arr = sitk.GetArrayFromImage(img)
    binary = (arr == int(label)).astype(np.uint8)
    voxels = int(binary.sum())
    if voxels == 0:
        raise ValueError(f"No voxels found for label {label}")
    out_img = sitk.GetImageFromArray(binary)
    out_img.CopyInformation(img)
    ensure_parent(out_path)
    sitk.WriteImage(out_img, str(out_path))
    return {
        "input_mask": str(mask_path),
        "output_mask": str(out_path),
        "label": int(label),
        "voxel_count": voxels,
        "output_summary": image_summary(out_img),
    }
