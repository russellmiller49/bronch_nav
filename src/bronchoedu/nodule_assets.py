#!/usr/bin/env python3
"""
Nodule asset extraction and 3D CT insertion prototype.

Purpose
-------
1. Convert a segmented pulmonary nodule from a source CT into a reusable 3D asset.
2. Insert that asset into a different target CT at a Slicer RAS coordinate.
3. Output a synthetic CT volume and an inserted-nodule mask that scroll like normal 3D images.

Expected inputs
---------------
- Source CT volume: NRRD or NIfTI exported from Slicer, or any SimpleITK-readable 3D image.
- Source nodule mask/labelmap: binary/label volume with the SAME geometry as the source CT.
- Target CT volume: NRRD or NIfTI exported from Slicer.

Recommended export from 3D Slicer
---------------------------------
For the segmentation, export to labelmap using the source CT as the reference volume.
That ensures origin, spacing, directions, and extents match.

Install
-------
pip install SimpleITK numpy scipy

Examples
--------
Create a reusable nodule asset:
python nodule_asset_inserter.py create-asset \
  --source-ct source_ct.nrrd \
  --source-mask source_nodule_mask.nrrd \
  --out-dir assets/nodule_001 \
  --margin-mm 12 \
  --label 1

Insert into target CT at a Slicer RAS coordinate:
python nodule_asset_inserter.py insert \
  --target-ct target_clean_ct.nrrd \
  --asset-dir assets/nodule_001 \
  --target-ras 42.0 130.0 -250.0 \
  --out-ct synthetic_ct.nrrd \
  --out-mask synthetic_nodule_mask.nrrd \
  --scale 1.0 \
  --rot-deg 0 0 0 \
  --mode residual

Coordinate note
---------------
3D Slicer displays RAS coordinates. SimpleITK image physical space is normally LPS.
This script accepts --target-ras and internally converts RAS -> LPS as [-R, -A, S].
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
from typing import Dict, Iterable, Tuple

import numpy as np

try:
    import SimpleITK as sitk
except ImportError as exc:  # pragma: no cover
    raise SystemExit("Missing dependency: pip install SimpleITK") from exc

try:
    from scipy import ndimage
except ImportError as exc:  # pragma: no cover
    raise SystemExit("Missing dependency: pip install scipy") from exc

from .labels import find_label_value, parse_slicer_labels_csv


Array3D = np.ndarray


def ras_to_lps(pt_ras: Iterable[float]) -> np.ndarray:
    r, a, s = [float(v) for v in pt_ras]
    return np.array([-r, -a, s], dtype=np.float64)


def lps_to_ras(pt_lps: Iterable[float]) -> np.ndarray:
    l, p, s = [float(v) for v in pt_lps]
    return np.array([-l, -p, s], dtype=np.float64)


def read_image(path: str | Path) -> sitk.Image:
    img = sitk.ReadImage(str(path))
    if img.GetDimension() != 3:
        raise ValueError(f"Expected 3D image: {path}, got dimension {img.GetDimension()}")
    return img


def write_image_like(array_zyx: Array3D, reference: sitk.Image, out_path: str | Path, pixel_id=None) -> None:
    if pixel_id is None:
        img = sitk.GetImageFromArray(array_zyx)
    else:
        img = sitk.GetImageFromArray(array_zyx.astype(np.float32 if pixel_id == sitk.sitkFloat32 else array_zyx.dtype))
        img = sitk.Cast(img, pixel_id)
    img.CopyInformation(reference)
    sitk.WriteImage(img, str(out_path))


def image_matrix(img: sitk.Image) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return origin, spacing, direction matrix, and inverse direction for index->physical math."""
    origin = np.array(img.GetOrigin(), dtype=np.float64)
    spacing = np.array(img.GetSpacing(), dtype=np.float64)
    direction = np.array(img.GetDirection(), dtype=np.float64).reshape(3, 3)
    inv_direction = np.linalg.inv(direction)
    return origin, spacing, direction, inv_direction


def physical_to_continuous_index_np(points_lps: np.ndarray, img: sitk.Image) -> np.ndarray:
    """Vectorized SimpleITK physical point -> continuous index in xyz order."""
    origin, spacing, direction, inv_direction = image_matrix(img)
    delta = points_lps - origin[None, :]
    idx_times_spacing = delta @ inv_direction.T
    return idx_times_spacing / spacing[None, :]


def continuous_index_to_physical_np(indices_xyz: np.ndarray, img: sitk.Image) -> np.ndarray:
    """Vectorized continuous index xyz -> physical point LPS."""
    origin, spacing, direction, _ = image_matrix(img)
    return origin[None, :] + (indices_xyz * spacing[None, :]) @ direction.T


def bbox_from_mask(mask: Array3D, margin_vox_zyx: Tuple[int, int, int]) -> Tuple[slice, slice, slice]:
    coords = np.argwhere(mask > 0)
    if coords.size == 0:
        raise ValueError("Mask is empty.")
    zmin, ymin, xmin = coords.min(axis=0)
    zmax, ymax, xmax = coords.max(axis=0) + 1
    mz, my, mx = margin_vox_zyx
    zmin = max(0, zmin - mz)
    ymin = max(0, ymin - my)
    xmin = max(0, xmin - mx)
    zmax = min(mask.shape[0], zmax + mz)
    ymax = min(mask.shape[1], ymax + my)
    xmax = min(mask.shape[2], xmax + mx)
    return slice(zmin, zmax), slice(ymin, ymax), slice(xmin, xmax)


def crop_sitk_image(img: sitk.Image, slices_zyx: Tuple[slice, slice, slice]) -> sitk.Image:
    zsl, ysl, xsl = slices_zyx
    index = [int(xsl.start), int(ysl.start), int(zsl.start)]
    size = [int(xsl.stop - xsl.start), int(ysl.stop - ysl.start), int(zsl.stop - zsl.start)]
    roi = sitk.RegionOfInterest(img, size=size, index=index)
    return roi


def centroid_physical_from_mask(mask_img: sitk.Image, label: int = 1) -> Tuple[np.ndarray, np.ndarray]:
    mask = sitk.GetArrayFromImage(mask_img) == label
    coords_zyx = np.argwhere(mask)
    if coords_zyx.size == 0:
        raise ValueError(f"No voxels found for label {label}.")
    centroid_zyx = coords_zyx.mean(axis=0)
    centroid_xyz = np.array([centroid_zyx[2], centroid_zyx[1], centroid_zyx[0]], dtype=np.float64)
    centroid_lps = continuous_index_to_physical_np(centroid_xyz[None, :], mask_img)[0]
    return centroid_lps, centroid_xyz


def make_alpha(mask: Array3D, spacing_xyz: Tuple[float, float, float], feather_mm: float = 2.0) -> Array3D:
    """Create a soft 3D blending mask from a binary nodule mask."""
    spacing_zyx = np.array([spacing_xyz[2], spacing_xyz[1], spacing_xyz[0]], dtype=np.float64)
    sigma_zyx = np.maximum(feather_mm / spacing_zyx, 0.25)
    alpha = ndimage.gaussian_filter(mask.astype(np.float32), sigma=sigma_zyx, mode="nearest")
    mx = float(alpha.max())
    if mx > 0:
        alpha = alpha / mx
    # Keep true nodule core high while softly feathering the margin.
    alpha = np.clip(alpha, 0.0, 1.0).astype(np.float32)
    return alpha


def ring_background_hu(ct_arr: Array3D, mask: Array3D, spacing_xyz: Tuple[float, float, float], ring_mm: float = 6.0) -> float:
    """Estimate local donor lung background using a ring around the nodule."""
    spacing_zyx = np.array([spacing_xyz[2], spacing_xyz[1], spacing_xyz[0]], dtype=np.float64)
    iterations = int(max(1, round(ring_mm / float(np.min(spacing_zyx)))))
    dilated = ndimage.binary_dilation(mask > 0, iterations=iterations)
    ring = np.logical_and(dilated, ~(mask > 0))
    vals = ct_arr[ring]
    # Keep plausible aerated/parenchymal background values; fallback if not enough remain.
    vals_lung = vals[(vals > -1000) & (vals < -200)]
    if vals_lung.size >= 20:
        return float(np.median(vals_lung))
    if vals.size > 0:
        return float(np.median(vals))
    return -850.0


def save_metadata(out_dir: Path, metadata: Dict) -> None:
    with open(out_dir / "metadata.json", "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)


def load_metadata(asset_dir: str | Path) -> Dict:
    with open(Path(asset_dir) / "metadata.json", "r", encoding="utf-8") as f:
        return json.load(f)


def create_asset(args: argparse.Namespace) -> None:
    source_ct = read_image(args.source_ct)
    source_mask_img = read_image(args.source_mask)
    labels = parse_slicer_labels_csv(getattr(args, "labels_csv", None))
    if getattr(args, "label_name", None):
        selected_label = find_label_value(labels, args.label_name)
    elif getattr(args, "label", None) is not None:
        selected_label = int(args.label)
    else:
        selected_label = 1
    selected_label_name = labels.get(selected_label, getattr(args, "label_name", "") or "")

    # Check geometry. This is intentionally strict: misaligned source CT/mask corrupts the asset.
    if source_ct.GetSize() != source_mask_img.GetSize():
        raise ValueError("Source CT and mask sizes differ. Export mask as labelmap using source CT as reference volume.")
    if not np.allclose(source_ct.GetSpacing(), source_mask_img.GetSpacing(), atol=1e-5):
        raise ValueError("Source CT and mask spacings differ. Export mask using source CT as reference volume.")
    if not np.allclose(source_ct.GetOrigin(), source_mask_img.GetOrigin(), atol=1e-5):
        raise ValueError("Source CT and mask origins differ. Export mask using source CT as reference volume.")
    if not np.allclose(source_ct.GetDirection(), source_mask_img.GetDirection(), atol=1e-5):
        raise ValueError("Source CT and mask directions differ. Export mask using source CT as reference volume.")

    ct_arr = sitk.GetArrayFromImage(source_ct).astype(np.float32)
    mask_arr = (sitk.GetArrayFromImage(source_mask_img) == selected_label).astype(np.uint8)

    spacing_xyz = source_ct.GetSpacing()
    spacing_zyx = np.array([spacing_xyz[2], spacing_xyz[1], spacing_xyz[0]], dtype=np.float64)
    margin_vox_zyx = tuple(np.ceil(float(args.margin_mm) / spacing_zyx).astype(int).tolist())
    slices = bbox_from_mask(mask_arr, margin_vox_zyx)

    patch_img = crop_sitk_image(source_ct, slices)
    mask_crop_img = crop_sitk_image(source_mask_img, slices)
    patch_arr = sitk.GetArrayFromImage(patch_img).astype(np.float32)
    mask_crop = (sitk.GetArrayFromImage(mask_crop_img) == selected_label).astype(np.uint8)
    mask_binary_img = sitk.GetImageFromArray(mask_crop)
    mask_binary_img.CopyInformation(patch_img)

    alpha = make_alpha(mask_crop, spacing_xyz=patch_img.GetSpacing(), feather_mm=float(args.feather_mm))
    background_hu = ring_background_hu(patch_arr, mask_crop, spacing_xyz=patch_img.GetSpacing(), ring_mm=float(args.background_ring_mm))

    # Residual asset: donor nodule signal relative to its local donor lung background.
    residual = patch_arr - background_hu
    residual = residual.astype(np.float32)

    centroid_lps, centroid_idx_xyz = centroid_physical_from_mask(mask_binary_img, label=1)

    coords_zyx = np.argwhere(mask_crop > 0)
    coords_xyz = np.column_stack([coords_zyx[:, 2], coords_zyx[:, 1], coords_zyx[:, 0]]).astype(np.float64)
    points_lps = continuous_index_to_physical_np(coords_xyz, mask_crop_img)
    max_radius_mm = float(np.sqrt(np.sum((points_lps - centroid_lps[None, :]) ** 2, axis=1)).max())
    voxel_count = int(mask_crop.sum())
    voxel_volume_mm3 = float(np.prod(patch_img.GetSpacing()))
    volume_mm3 = voxel_count * voxel_volume_mm3
    equiv_diameter_mm = float((6.0 * volume_mm3 / math.pi) ** (1.0 / 3.0)) if volume_mm3 > 0 else 0.0
    bbox_zyx_min = coords_zyx.min(axis=0)
    bbox_zyx_max = coords_zyx.max(axis=0)
    bbox_xyz_min = [int(bbox_zyx_min[2]), int(bbox_zyx_min[1]), int(bbox_zyx_min[0])]
    bbox_xyz_max = [int(bbox_zyx_max[2]), int(bbox_zyx_max[1]), int(bbox_zyx_max[0])]
    bbox_corners_xyz = np.asarray(
        [
            [x, y, z]
            for x in (bbox_xyz_min[0], bbox_xyz_max[0])
            for y in (bbox_xyz_min[1], bbox_xyz_max[1])
            for z in (bbox_xyz_min[2], bbox_xyz_max[2])
        ],
        dtype=float,
    )
    bbox_corners_lps = continuous_index_to_physical_np(bbox_corners_xyz, mask_binary_img)
    bbox_lps_min = bbox_corners_lps.min(axis=0)
    bbox_lps_max = bbox_corners_lps.max(axis=0)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    sitk.WriteImage(patch_img, str(out_dir / "patch_ct.nrrd"))
    sitk.WriteImage(mask_binary_img, str(out_dir / "mask_labelmap.nrrd"))
    write_image_like(alpha, patch_img, out_dir / "alpha.nrrd", pixel_id=sitk.sitkFloat32)
    write_image_like(residual, patch_img, out_dir / "residual_signal.nrrd", pixel_id=sitk.sitkFloat32)

    metadata = {
        "education_only": True,
        "not_for_clinical_use": True,
        "synthetic": True,
        "synthetic_asset": True,
        "asset_id": args.asset_id or out_dir.name,
        "label": selected_label,
        "selected_label": selected_label,
        "selected_label_name": selected_label_name,
        "source_ct": str(args.source_ct),
        "source_mask": str(args.source_mask),
        "labels_csv": str(args.labels_csv) if getattr(args, "labels_csv", None) else None,
        "source_image_geometry": {
            "spacing_xyz_mm": [float(v) for v in source_ct.GetSpacing()],
            "origin_lps": [float(v) for v in source_ct.GetOrigin()],
            "direction_lps": [float(v) for v in source_ct.GetDirection()],
            "size_xyz": [int(v) for v in source_ct.GetSize()],
        },
        "spacing_lps_xyz_mm": [float(v) for v in patch_img.GetSpacing()],
        "spacing_xyz_mm": [float(v) for v in patch_img.GetSpacing()],
        "size_xyz": [int(v) for v in patch_img.GetSize()],
        "origin_lps": [float(v) for v in patch_img.GetOrigin()],
        "direction_lps": [float(v) for v in patch_img.GetDirection()],
        "centroid_lps": [float(v) for v in centroid_lps],
        "centroid_ras": [float(v) for v in lps_to_ras(centroid_lps)],
        "centroid_index_xyz": [float(v) for v in centroid_idx_xyz],
        "bounding_box": {
            "selected_label_index_zyx_min": [int(v) for v in bbox_zyx_min],
            "selected_label_index_zyx_max": [int(v) for v in bbox_zyx_max],
            "selected_label_index_xyz_min": bbox_xyz_min,
            "selected_label_index_xyz_max": bbox_xyz_max,
            "selected_label_lps_min": [float(v) for v in bbox_lps_min],
            "selected_label_lps_max": [float(v) for v in bbox_lps_max],
            "crop_slices_zyx": [[int(s.start), int(s.stop)] for s in slices],
            "crop_origin_lps": [float(v) for v in patch_img.GetOrigin()],
            "crop_size_xyz": [int(v) for v in patch_img.GetSize()],
        },
        "background_hu": float(background_hu),
        "estimated_donor_background_hu": float(background_hu),
        "max_radius_mm": max_radius_mm,
        "volume_mm3": volume_mm3,
        "equivalent_diameter_mm": equiv_diameter_mm,
        "margin_mm": float(args.margin_mm),
        "feather_mm": float(args.feather_mm),
        "background_ring_mm": float(args.background_ring_mm),
        "notes": "Residual signal is patch_ct - estimated local donor background; insertion multiplies residual by alpha.",
    }
    save_metadata(out_dir, metadata)
    print(json.dumps(metadata, indent=2))


def rotation_matrix_zyx_degrees(rot_deg_xyz: Iterable[float]) -> np.ndarray:
    """Return rotation matrix for rotations about LPS x, y, z axes, applied x then y then z."""
    rx, ry, rz = np.deg2rad(np.array(list(rot_deg_xyz), dtype=np.float64))
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]], dtype=np.float64)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], dtype=np.float64)
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]], dtype=np.float64)
    return Rz @ Ry @ Rx


def get_target_roi_slices(target_img: sitk.Image, center_lps: np.ndarray, radius_mm: float) -> Tuple[slice, slice, slice]:
    center_idx_xyz = physical_to_continuous_index_np(center_lps[None, :], target_img)[0]
    spacing = np.array(target_img.GetSpacing(), dtype=np.float64)
    radius_vox_xyz = np.ceil(radius_mm / spacing).astype(int) + 3
    size_xyz = np.array(target_img.GetSize(), dtype=int)
    lo_xyz = np.floor(center_idx_xyz).astype(int) - radius_vox_xyz
    hi_xyz = np.ceil(center_idx_xyz).astype(int) + radius_vox_xyz + 1
    lo_xyz = np.maximum(lo_xyz, 0)
    hi_xyz = np.minimum(hi_xyz, size_xyz)
    if np.any(hi_xyz <= lo_xyz):
        raise ValueError("Insertion point is outside the target CT volume.")
    # Return in array zyx slice order.
    return (
        slice(int(lo_xyz[2]), int(hi_xyz[2])),
        slice(int(lo_xyz[1]), int(hi_xyz[1])),
        slice(int(lo_xyz[0]), int(hi_xyz[0])),
    )


def sample_asset_at_target_roi(
    target_img: sitk.Image,
    roi_slices_zyx: Tuple[slice, slice, slice],
    asset_img: sitk.Image,
    placement_lps: np.ndarray,
    asset_centroid_lps: np.ndarray,
    rotation_asset_to_target_lps: np.ndarray,
    scale: float,
    order: int,
    cval: float = 0.0,
) -> Tuple[Array3D, Array3D]:
    """Return sampled asset array and target ROI physical points.

    The rotation matrix maps asset-local LPS deltas to target LPS deltas.
    Inverse rotation maps target deltas back into asset-local LPS deltas.
    """
    zsl, ysl, xsl = roi_slices_zyx
    zz, yy, xx = np.mgrid[zsl, ysl, xsl]
    indices_xyz = np.column_stack([xx.ravel(), yy.ravel(), zz.ravel()]).astype(np.float64)
    target_points_lps = continuous_index_to_physical_np(indices_xyz, target_img)

    R_inv = rotation_asset_to_target_lps.T
    delta_target = target_points_lps - placement_lps[None, :]
    delta_asset = (delta_target @ R_inv.T) / float(scale)
    asset_points_lps = asset_centroid_lps[None, :] + delta_asset

    asset_idx_xyz = physical_to_continuous_index_np(asset_points_lps, asset_img)
    coords_zyx = np.vstack([asset_idx_xyz[:, 2], asset_idx_xyz[:, 1], asset_idx_xyz[:, 0]])
    asset_arr = sitk.GetArrayFromImage(asset_img).astype(np.float32)
    sampled = ndimage.map_coordinates(asset_arr, coords_zyx, order=order, mode="constant", cval=cval)
    sampled = sampled.reshape(xx.shape).astype(np.float32)
    return sampled, target_points_lps


def insert_asset(args: argparse.Namespace) -> None:
    asset_dir = Path(args.asset_dir)
    metadata = load_metadata(asset_dir)
    target_ct = read_image(args.target_ct)
    target_arr = sitk.GetArrayFromImage(target_ct).astype(np.float32)

    patch_img = read_image(asset_dir / "patch_ct.nrrd")
    residual_img = read_image(asset_dir / "residual_signal.nrrd")
    alpha_img = read_image(asset_dir / "alpha.nrrd")
    mask_img = read_image(asset_dir / "mask_labelmap.nrrd")

    placement_lps = ras_to_lps(args.target_ras)
    asset_centroid_lps = np.array(metadata["centroid_lps"], dtype=np.float64)
    max_radius_mm = float(metadata["max_radius_mm"])
    scale = float(args.scale)
    if scale <= 0:
        raise ValueError("Scale must be positive.")
    R = rotation_matrix_zyx_degrees(args.rot_deg)
    roi_radius_mm = max_radius_mm * scale + float(args.margin_mm) + 2.5 * float(metadata.get("feather_mm", 2.0))
    roi_slices = get_target_roi_slices(target_ct, placement_lps, roi_radius_mm)

    sampled_alpha, _ = sample_asset_at_target_roi(
        target_img=target_ct,
        roi_slices_zyx=roi_slices,
        asset_img=alpha_img,
        placement_lps=placement_lps,
        asset_centroid_lps=asset_centroid_lps,
        rotation_asset_to_target_lps=R,
        scale=scale,
        order=1,
        cval=0.0,
    )
    sampled_alpha = np.clip(sampled_alpha * float(args.blend_strength), 0.0, 1.0)

    zsl, ysl, xsl = roi_slices
    roi = target_arr[zsl, ysl, xsl]

    if args.mode == "residual":
        sampled_residual, _ = sample_asset_at_target_roi(
            target_img=target_ct,
            roi_slices_zyx=roi_slices,
            asset_img=residual_img,
            placement_lps=placement_lps,
            asset_centroid_lps=asset_centroid_lps,
            rotation_asset_to_target_lps=R,
            scale=scale,
            order=1,
            cval=0.0,
        )
        new_roi = roi + sampled_residual * sampled_alpha
    elif args.mode == "direct":
        sampled_patch, _ = sample_asset_at_target_roi(
            target_img=target_ct,
            roi_slices_zyx=roi_slices,
            asset_img=patch_img,
            placement_lps=placement_lps,
            asset_centroid_lps=asset_centroid_lps,
            rotation_asset_to_target_lps=R,
            scale=scale,
            order=1,
            cval=-1000.0,
        )
        new_roi = roi * (1.0 - sampled_alpha) + sampled_patch * sampled_alpha
    else:
        raise ValueError("mode must be residual or direct")

    # Clamp to a sane CT HU range to avoid accidental extreme values.
    new_roi = np.clip(new_roi, float(args.min_hu), float(args.max_hu))
    out_arr = target_arr.copy()
    out_arr[zsl, ysl, xsl] = new_roi

    sampled_mask, _ = sample_asset_at_target_roi(
        target_img=target_ct,
        roi_slices_zyx=roi_slices,
        asset_img=mask_img,
        placement_lps=placement_lps,
        asset_centroid_lps=asset_centroid_lps,
        rotation_asset_to_target_lps=R,
        scale=scale,
        order=0,
        cval=0.0,
    )
    out_mask = np.zeros_like(target_arr, dtype=np.uint8)
    out_mask[zsl, ysl, xsl] = (sampled_mask >= 0.5).astype(np.uint8)
    inserted_voxels = int(out_mask.sum())
    if inserted_voxels == 0:
        raise ValueError("Inserted synthetic nodule mask is empty; check placement, scale, and target geometry.")

    # Preserve original target image geometry.
    output_pixel_id = target_ct.GetPixelID()
    out_img = sitk.GetImageFromArray(out_arr.astype(np.int16 if args.cast_int16 else np.float32))
    out_img.CopyInformation(target_ct)
    if args.cast_int16:
        out_img = sitk.Cast(out_img, sitk.sitkInt16)
    else:
        out_img = sitk.Cast(out_img, output_pixel_id)
    Path(args.out_ct).parent.mkdir(parents=True, exist_ok=True)
    sitk.WriteImage(out_img, str(args.out_ct))

    mask_out_img = sitk.GetImageFromArray(out_mask)
    mask_out_img.CopyInformation(target_ct)
    Path(args.out_mask).parent.mkdir(parents=True, exist_ok=True)
    sitk.WriteImage(mask_out_img, str(args.out_mask))

    placement_metadata = {
        "education_only": True,
        "not_for_clinical_use": True,
        "synthetic": True,
        "asset_dir": str(asset_dir),
        "target_ct": str(args.target_ct),
        "output_ct": str(args.out_ct),
        "output_mask": str(args.out_mask),
        "placement_ras": [float(v) for v in args.target_ras],
        "placement_lps": [float(v) for v in placement_lps],
        "scale": scale,
        "rotation_degrees_lps_xyz": [float(v) for v in args.rot_deg],
        "mode": args.mode,
        "blend_strength": float(args.blend_strength),
        "roi_slices_zyx": [[int(s.start), int(s.stop)] for s in roi_slices],
        "inserted_mask_voxel_count": inserted_voxels,
        "output_geometry_matches_target": {
            "size": out_img.GetSize() == target_ct.GetSize(),
            "spacing": bool(np.allclose(out_img.GetSpacing(), target_ct.GetSpacing(), atol=1e-5)),
            "origin": bool(np.allclose(out_img.GetOrigin(), target_ct.GetOrigin(), atol=1e-5)),
            "direction": bool(np.allclose(out_img.GetDirection(), target_ct.GetDirection(), atol=1e-5)),
        },
    }
    out_placement = getattr(args, "out_placement", None)
    placement_path = Path(out_placement) if out_placement else Path(args.out_ct).with_name("synthetic_placement.json")
    placement_path.parent.mkdir(parents=True, exist_ok=True)
    placement_metadata["output_placement_json"] = str(placement_path)
    with open(placement_path, "w", encoding="utf-8") as f:
        json.dump(placement_metadata, f, indent=2)
    print(json.dumps(placement_metadata, indent=2))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Create and insert synthetic pulmonary nodule CT assets.")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("create-asset", help="Create a reusable nodule asset from a source CT and nodule mask.")
    a.add_argument("--source-ct", required=True, help="Source CT volume, e.g. .nrrd or .nii.gz")
    a.add_argument("--source-mask", required=True, help="Binary/label nodule segmentation labelmap with source CT geometry")
    a.add_argument("--out-dir", required=True, help="Output asset directory")
    a.add_argument("--label", type=int, default=None, help="Label value for the nodule in the source mask")
    a.add_argument("--label-name", default=None, help="Segment name to extract from a multi-label source mask")
    a.add_argument("--labels-csv", default=None, help="Slicer labels CSV used with --label-name")
    a.add_argument("--margin-mm", type=float, default=12.0, help="Crop margin around nodule")
    a.add_argument("--feather-mm", type=float, default=2.0, help="Soft blend feather width")
    a.add_argument("--background-ring-mm", type=float, default=6.0, help="Ring size for donor lung background estimate")
    a.add_argument("--asset-id", default=None, help="Optional asset identifier")
    a.set_defaults(func=create_asset)

    ins = sub.add_parser("insert", help="Insert a nodule asset into a target CT volume.")
    ins.add_argument("--target-ct", required=True, help="Target clean CT volume")
    ins.add_argument("--asset-dir", required=True, help="Asset directory created by create-asset")
    ins.add_argument("--target-ras", nargs=3, type=float, required=True, metavar=("R", "A", "S"), help="Insertion center in Slicer RAS mm")
    ins.add_argument("--out-ct", required=True, help="Output synthetic CT volume")
    ins.add_argument("--out-mask", required=True, help="Output synthetic nodule mask in target CT geometry")
    ins.add_argument("--out-placement", default=None, help="Output placement metadata JSON; defaults to synthetic_placement.json beside --out-ct")
    ins.add_argument("--scale", type=float, default=1.0, help="Nodule scale factor")
    ins.add_argument("--rot-deg", nargs=3, type=float, default=[0.0, 0.0, 0.0], metavar=("RX", "RY", "RZ"), help="Rotation around LPS x,y,z axes")
    ins.add_argument("--mode", choices=["residual", "direct"], default="residual", help="Residual mode usually looks better in lung parenchyma")
    ins.add_argument("--blend-strength", type=float, default=1.0, help="Multiply alpha by this value")
    ins.add_argument("--margin-mm", type=float, default=8.0, help="Extra ROI margin during insertion")
    ins.add_argument("--min-hu", type=float, default=-1200.0, help="Minimum output HU clamp")
    ins.add_argument("--max-hu", type=float, default=3071.0, help="Maximum output HU clamp")
    ins.add_argument("--cast-int16", action="store_true", help="Cast output CT to signed 16-bit integer")
    ins.set_defaults(func=insert_asset)
    return p


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
