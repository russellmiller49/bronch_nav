from __future__ import annotations

import argparse

from bronchoedu.nodule_assets import insert_asset


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Insert a nodule asset into a target CT volume.")
    parser.add_argument("--target-ct", required=True, help="Target clean CT volume")
    parser.add_argument("--asset-dir", required=True, help="Asset directory created by create_nodule_asset")
    parser.add_argument("--target-ras", nargs=3, type=float, required=True, metavar=("R", "A", "S"), help="Insertion center in Slicer RAS mm")
    parser.add_argument("--out-ct", required=True, help="Output synthetic CT volume")
    parser.add_argument("--out-mask", required=True, help="Output synthetic nodule mask in target CT geometry")
    parser.add_argument("--out-placement", default=None, help="Output placement metadata JSON; defaults to synthetic_placement.json beside --out-ct")
    parser.add_argument("--scale", type=float, default=1.0, help="Nodule scale factor")
    parser.add_argument("--rot-deg", nargs=3, type=float, default=[0.0, 0.0, 0.0], metavar=("RX", "RY", "RZ"), help="Rotation around LPS x,y,z axes")
    parser.add_argument("--mode", choices=["residual", "direct"], default="residual", help="Residual mode usually looks better in lung parenchyma")
    parser.add_argument("--blend-strength", type=float, default=1.0, help="Multiply alpha by this value")
    parser.add_argument("--margin-mm", type=float, default=8.0, help="Extra ROI margin during insertion")
    parser.add_argument("--min-hu", type=float, default=-1200.0, help="Minimum output HU clamp")
    parser.add_argument("--max-hu", type=float, default=3071.0, help="Maximum output HU clamp")
    parser.add_argument("--cast-int16", action="store_true", help="Cast output CT to signed 16-bit integer")
    return parser


def main() -> None:
    insert_asset(build_parser().parse_args())


if __name__ == "__main__":
    main()
