from __future__ import annotations

import argparse
import json

from bronchoedu.labels import parse_slicer_labels_csv, resolve_label_value, split_labelmap_to_binary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Extract one label from a multi-label mask as binary label 1.")
    parser.add_argument("--mask", required=True, help="Input multi-label NRRD/NIfTI")
    parser.add_argument("--out", required=True, help="Output binary mask NRRD/NIfTI")
    parser.add_argument("--label", type=int, default=None, help="Numeric label value to extract")
    parser.add_argument("--label-name", default=None, help="Segment name to extract")
    parser.add_argument("--labels-csv", default=None, help="Slicer labels CSV, required for --label-name")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    label, name = resolve_label_value(args.label, args.label_name, args.labels_csv)
    result = split_labelmap_to_binary(args.mask, args.out, label)
    result["selected_label_name"] = name
    result["labels"] = parse_slicer_labels_csv(args.labels_csv)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
