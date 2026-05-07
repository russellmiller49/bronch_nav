#!/usr/bin/env python
from __future__ import annotations

import argparse
import logging
import sys
import traceback
import warnings
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run AirMorph/AirwayNet on one prepared case directory.")
    parser.add_argument("--airmorph-root", required=True)
    parser.add_argument("--case-dir", required=True)
    parser.add_argument("--case-id", required=True)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    airmorph_root = Path(args.airmorph_root).resolve()
    case_dir = Path(args.case_dir).resolve()
    image_path = case_dir / "image.nii.gz"
    if not image_path.exists():
        raise FileNotFoundError(f"AirMorph case image not found: {image_path}")

    sys.path.insert(0, str(airmorph_root))
    warnings.filterwarnings("ignore", category=FutureWarning)
    warnings.filterwarnings("ignore", category=UserWarning)
    logging.basicConfig(level=logging.INFO, format="(%(asctime)s)(%(levelname)s) %(name)s: %(message)s")

    from monai.transforms import Compose
    from segmentator.airway_segmentator import AirwayAtlasBinaryAirwaySegmentator
    from classifier.airway_classifier import AirwayAtlasMultiAnatomyAirwayClassifier

    pipeline = Compose(
        [
            AirwayAtlasBinaryAirwaySegmentator(),
            AirwayAtlasMultiAnatomyAirwayClassifier(),
        ]
    )
    data = {"patient": args.case_id, "file_path": str(case_dir)}
    try:
        pipeline(data)
    except Exception:
        traceback.print_exc()
        raise


if __name__ == "__main__":
    main()
