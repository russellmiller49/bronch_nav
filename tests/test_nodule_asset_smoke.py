from argparse import Namespace
from pathlib import Path

import numpy as np
import SimpleITK as sitk

from bronchoedu.io import geometry_match
from bronchoedu.nodule_assets import create_asset, insert_asset, load_metadata


def _write_volume(path: Path, arr: np.ndarray, origin=(0.0, 0.0, 0.0)) -> sitk.Image:
    img = sitk.GetImageFromArray(arr)
    img.SetSpacing((1.0, 1.0, 1.0))
    img.SetOrigin(origin)
    img.SetDirection((1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0))
    sitk.WriteImage(img, str(path))
    return img


def test_create_and_insert_nodule_asset_smoke(tmp_path):
    source_ct_arr = np.full((20, 20, 20), -850, dtype=np.int16)
    source_mask_arr = np.zeros((20, 20, 20), dtype=np.uint8)
    source_mask_arr[8:12, 8:12, 8:12] = 1
    source_ct_arr[source_mask_arr == 1] = 80

    source_ct = tmp_path / "source_ct.nrrd"
    source_mask = tmp_path / "source_mask.nrrd"
    _write_volume(source_ct, source_ct_arr)
    _write_volume(source_mask, source_mask_arr)

    asset_dir = tmp_path / "asset"
    create_asset(
        Namespace(
            source_ct=str(source_ct),
            source_mask=str(source_mask),
            out_dir=str(asset_dir),
            label=1,
            label_name=None,
            labels_csv=None,
            margin_mm=3.0,
            feather_mm=1.0,
            background_ring_mm=2.0,
            asset_id=None,
        )
    )

    for name in ["patch_ct.nrrd", "mask_labelmap.nrrd", "alpha.nrrd", "residual_signal.nrrd", "metadata.json"]:
        assert (asset_dir / name).exists()
    metadata = load_metadata(asset_dir)
    assert metadata["education_only"] is True
    assert metadata["synthetic_asset"] is True
    assert metadata["volume_mm3"] > 0

    target_ct_arr = np.full((32, 32, 32), -900, dtype=np.int16)
    target_ct = tmp_path / "target_ct.nrrd"
    target_img = _write_volume(target_ct, target_ct_arr)
    out_ct = tmp_path / "synthetic_ct.nrrd"
    out_mask = tmp_path / "synthetic_nodule_mask.nrrd"
    out_placement = tmp_path / "synthetic_placement.json"

    insert_asset(
        Namespace(
            target_ct=str(target_ct),
            asset_dir=str(asset_dir),
            target_ras=[-16.0, -16.0, 16.0],
            out_ct=str(out_ct),
            out_mask=str(out_mask),
            out_placement=str(out_placement),
            scale=1.0,
            rot_deg=[0.0, 0.0, 0.0],
            mode="residual",
            blend_strength=1.0,
            margin_mm=4.0,
            min_hu=-1200.0,
            max_hu=3071.0,
            cast_int16=True,
        )
    )

    synthetic_img = sitk.ReadImage(str(out_ct))
    mask_img = sitk.ReadImage(str(out_mask))
    mask_arr = sitk.GetArrayFromImage(mask_img)
    synthetic_arr = sitk.GetArrayFromImage(synthetic_img)

    assert all(geometry_match(target_img, synthetic_img).values())
    assert all(geometry_match(target_img, mask_img).values())
    assert int(mask_arr.sum()) > 0
    assert np.any(synthetic_arr != target_ct_arr)
    assert out_placement.exists()
