#!/usr/bin/env python
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import SimpleITK as sitk


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Prepare the bundled CT for AirMorph's image.nii.gz case layout.")
    parser.add_argument("--ct-nrrd", required=True)
    parser.add_argument("--network-vtk", required=True)
    parser.add_argument("--airmorph-root", required=True)
    parser.add_argument("--case-group", required=True)
    parser.add_argument("--case-id", required=True)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    ct_path = Path(args.ct_nrrd)
    network_path = Path(args.network_vtk)
    case_dir = Path(args.airmorph_root) / "sample_data" / args.case_group / args.case_id
    case_dir.mkdir(parents=True, exist_ok=True)

    image = sitk.ReadImage(str(ct_path))
    if image.GetDimension() != 3:
        raise ValueError(f"Expected 3D CT, got dimension {image.GetDimension()}: {ct_path}")
    sitk.WriteImage(image, str(case_dir / "image.nii.gz"))

    shutil.copy2(network_path, case_dir / "Network model.vtk")
    manifest = {
        "case_id": args.case_id,
        "source_ct": str(ct_path),
        "source_network_vtk": str(network_path),
        "airmorph_case_dir": str(case_dir),
        "image": "image.nii.gz",
        "network_vtk": "Network model.vtk",
        "size_xyz": [int(v) for v in image.GetSize()],
        "spacing_xyz_mm": [float(v) for v in image.GetSpacing()],
        "origin_lps": [float(v) for v in image.GetOrigin()],
        "direction_lps": [float(v) for v in image.GetDirection()],
    }
    (case_dir / "bronchoedu_case_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
