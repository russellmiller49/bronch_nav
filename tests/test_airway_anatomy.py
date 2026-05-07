from pathlib import Path

import numpy as np
import pytest
import SimpleITK as sitk

from bronchoedu.airway_anatomy import AirMorphLabelVolumes, LabelVolume, anatomy_for_points, load_label_volumes


def _image_from_array(array_zyx: np.ndarray, spacing=(1.0, 1.0, 1.0), origin=(0.0, 0.0, 0.0)) -> sitk.Image:
    img = sitk.GetImageFromArray(array_zyx.astype(np.int16))
    img.SetSpacing(spacing)
    img.SetOrigin(origin)
    return img


def _write_image(path: Path, array_zyx: np.ndarray, spacing=(1.0, 1.0, 1.0)) -> sitk.Image:
    img = _image_from_array(array_zyx, spacing=spacing)
    sitk.WriteImage(img, str(path))
    return img


def test_anatomy_for_points_samples_ras_as_lps_and_assigns_majority_label():
    lobe = np.zeros((8, 8, 8), dtype=np.int16)
    segment = np.zeros_like(lobe)
    subsegment = np.zeros_like(lobe)

    for x in (2, 3):
        lobe[4, 3, x] = 2
        segment[4, 3, x] = 4
        subsegment[4, 3, x] = 21
    lobe[4, 3, 4] = 2
    segment[4, 3, 4] = 5
    subsegment[4, 3, 4] = 22

    lobe_img = _image_from_array(lobe)
    volumes = AirMorphLabelVolumes(
        lobe=LabelVolume(lobe_img, lobe),
        segment=LabelVolume(_image_from_array(segment), segment),
        subsegment=LabelVolume(_image_from_array(subsegment), subsegment),
    )

    anatomy = anatomy_for_points(
        [[-2.0, -3.0, 4.0], [-3.0, -3.0, 4.0], [-4.0, -3.0, 4.0]],
        volumes,
        {
            "lobe": {2: "Left Lower Lobe"},
            "segment": {4: "LB6", 5: "LB8"},
            "subsegment": {21: "LB6", 22: "LB6a"},
        },
    )

    assert anatomy["coverage"] == 1.0
    assert anatomy["confidence"] == 0.6667
    assert anatomy["lobe"] == {"value": 2, "name": "Left Lower Lobe", "confidence": 1.0}
    assert anatomy["segment"] == {"value": 4, "name": "LB6", "confidence": 0.6667}
    assert anatomy["subsegment"] == {"value": 21, "name": "LB6", "confidence": 0.6667}


def test_load_label_volumes_validates_reference_geometry(tmp_path):
    zeros = np.zeros((3, 3, 3), dtype=np.int16)
    ct_path = tmp_path / "ct.nrrd"
    lob_path = tmp_path / "lob.nrrd"
    seg_path = tmp_path / "seg.nrrd"
    sub_path = tmp_path / "sub.nrrd"
    _write_image(ct_path, zeros, spacing=(1.0, 1.0, 1.0))
    _write_image(lob_path, zeros, spacing=(1.0, 1.0, 1.0))
    _write_image(seg_path, zeros, spacing=(1.0, 1.0, 1.0))
    _write_image(sub_path, zeros, spacing=(1.0, 1.0, 1.0))

    volumes = load_label_volumes(lob_path, seg_path, sub_path, reference_ct=ct_path)
    assert volumes.reference_image.GetSize() == (3, 3, 3)

    mismatch_ct = tmp_path / "mismatch_ct.nrrd"
    _write_image(mismatch_ct, zeros, spacing=(2.0, 1.0, 1.0))
    with pytest.raises(ValueError, match="AirMorph label/reference CT geometry mismatch"):
        load_label_volumes(lob_path, seg_path, sub_path, reference_ct=mismatch_ct)
