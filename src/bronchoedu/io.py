"""Image IO and geometry utilities."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import SimpleITK as sitk

from .coordinates import lps_to_ras


def read_image(path: str | Path) -> sitk.Image:
    img = sitk.ReadImage(str(path))
    if img.GetDimension() != 3:
        raise ValueError(f"Expected 3D image: {path}, got dimension {img.GetDimension()}")
    return img


def ensure_parent(path: str | Path) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)


def image_summary(img: sitk.Image) -> dict[str, Any]:
    return {
        "size_xyz": [int(v) for v in img.GetSize()],
        "spacing_xyz_mm": [float(v) for v in img.GetSpacing()],
        "origin_lps": [float(v) for v in img.GetOrigin()],
        "origin_ras": lps_to_ras(img.GetOrigin()),
        "direction_lps": [float(v) for v in img.GetDirection()],
        "pixel_id": img.GetPixelIDTypeAsString(),
    }


def geometry_match(a: sitk.Image, b: sitk.Image, atol: float = 1e-5) -> dict[str, bool]:
    return {
        "size": a.GetSize() == b.GetSize(),
        "spacing": bool(np.allclose(a.GetSpacing(), b.GetSpacing(), atol=atol)),
        "origin": bool(np.allclose(a.GetOrigin(), b.GetOrigin(), atol=atol)),
        "direction": bool(np.allclose(a.GetDirection(), b.GetDirection(), atol=atol)),
    }


def assert_geometry_match(a: sitk.Image, b: sitk.Image, context: str = "image geometry", atol: float = 1e-5) -> None:
    checks = geometry_match(a, b, atol=atol)
    if not all(checks.values()):
        failed = ", ".join(name for name, ok in checks.items() if not ok)
        raise ValueError(f"{context} mismatch: {failed}")


def assert_same_geometry(a: sitk.Image, b: sitk.Image, context: str = "image geometry") -> None:
    assert_geometry_match(a, b, context=context)


def write_image_like(array_zyx: np.ndarray, reference: sitk.Image, out_path: str | Path, pixel_id: int | None = None) -> None:
    ensure_parent(out_path)
    img = sitk.GetImageFromArray(array_zyx)
    img.CopyInformation(reference)
    if pixel_id is not None:
        img = sitk.Cast(img, pixel_id)
    sitk.WriteImage(img, str(out_path))
