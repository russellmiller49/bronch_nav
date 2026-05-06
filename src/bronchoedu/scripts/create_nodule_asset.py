from __future__ import annotations

import argparse

from bronchoedu.nodule_assets import create_asset


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create a reusable nodule asset from a source CT and nodule mask.")
    parser.add_argument("--source-ct", required=True, help="Source CT volume, e.g. .nrrd or .nii.gz")
    parser.add_argument("--source-mask", required=True, help="Binary/label nodule segmentation labelmap with source CT geometry")
    parser.add_argument("--out-dir", required=True, help="Output asset directory")
    parser.add_argument("--label", type=int, default=None, help="Label value for the nodule in the source mask; defaults to 1")
    parser.add_argument("--label-name", default=None, help="Segment name to extract from a multi-label source mask")
    parser.add_argument("--labels-csv", default=None, help="Slicer labels CSV used with --label-name")
    parser.add_argument("--margin-mm", type=float, default=12.0, help="Crop margin around nodule")
    parser.add_argument("--feather-mm", type=float, default=2.0, help="Soft blend feather width")
    parser.add_argument("--background-ring-mm", type=float, default=6.0, help="Ring size for donor lung background estimate")
    parser.add_argument("--asset-id", default=None, help="Optional asset identifier")
    return parser


def main() -> None:
    create_asset(build_parser().parse_args())


if __name__ == "__main__":
    main()
