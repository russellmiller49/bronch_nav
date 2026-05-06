from pathlib import Path

import numpy as np
import SimpleITK as sitk

from bronchoedu.labels import (
    centroid_for_label,
    find_label_value,
    label_voxel_counts,
    parse_slicer_labels_csv,
    split_labelmap_to_binary,
)


def _write_img(path: Path, arr: np.ndarray) -> sitk.Image:
    img = sitk.GetImageFromArray(arr)
    img.SetSpacing((2.0, 2.0, 5.0))
    img.SetOrigin((10.0, 20.0, -30.0))
    sitk.WriteImage(img, str(path))
    return img


def test_labels_csv_and_lookup(tmp_path):
    csv_path = tmp_path / "labels.csv"
    csv_path.write_text(
        '"LabelValue","Name","Color_R"\n5,"lung_nodule_1",1\n6,"Lung_nodule_2",1\n',
        encoding="utf-8",
    )
    labels = parse_slicer_labels_csv(csv_path)
    assert labels == {5: "lung_nodule_1", 6: "Lung_nodule_2"}
    assert find_label_value(labels, "lung_nodule_1") == 5
    assert find_label_value(labels, "lung_NODULE_2") == 6


def test_split_and_centroid_preserve_geometry(tmp_path):
    arr = np.zeros((4, 5, 6), dtype=np.uint8)
    arr[1:3, 2:4, 3:5] = 5
    mask_path = tmp_path / "mask.nrrd"
    src_img = _write_img(mask_path, arr)
    out_path = tmp_path / "binary.nrrd"

    result = split_labelmap_to_binary(mask_path, out_path, 5)
    out_img = sitk.ReadImage(str(out_path))
    out_arr = sitk.GetArrayFromImage(out_img)

    assert result["voxel_count"] == 8
    assert set(np.unique(out_arr).tolist()) == {0, 1}
    assert out_img.GetSpacing() == src_img.GetSpacing()
    assert out_img.GetOrigin() == src_img.GetOrigin()
    assert label_voxel_counts(out_img) == {1: 8}
    centroid = centroid_for_label(out_img, 1)
    assert centroid["centroid_index_xyz"] == [3.5, 2.5, 1.5]
