from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from bronchoedu.io import geometry_match, image_summary, read_image
from bronchoedu.labels import label_summary, parse_slicer_labels_csv


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate Slicer CT/mask exports and summarize label values.")
    parser.add_argument("--ct", default=None, help="Optional CT volume path to compare geometry against mask")
    parser.add_argument("--mask", required=True, help="Segmentation labelmap NRRD/NIfTI path")
    parser.add_argument("--labels-csv", default=None, help="Optional Slicer labels CSV")
    parser.add_argument("--out-json", default=None, help="Optional path to write JSON summary")
    return parser


def validate_exports(args: argparse.Namespace) -> dict[str, Any]:
    mask_img = read_image(args.mask)
    labels = parse_slicer_labels_csv(args.labels_csv)
    result: dict[str, Any] = {
        "education_only": True,
        "not_for_clinical_use": True,
        "mask_path": str(args.mask),
        "mask_summary": image_summary(mask_img),
        "labels_csv": str(args.labels_csv) if args.labels_csv else None,
        "labels": label_summary(mask_img, labels),
    }
    if args.ct:
        ct_img = read_image(args.ct)
        result["ct_path"] = str(args.ct)
        result["ct_summary"] = image_summary(ct_img)
        result["geometry_match"] = geometry_match(ct_img, mask_img)
        result["geometry_match_all"] = all(result["geometry_match"].values())
    return result


def main() -> None:
    args = build_parser().parse_args()
    result = validate_exports(args)
    text = json.dumps(result, indent=2)
    print(text)
    if args.out_json:
        Path(args.out_json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out_json).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
