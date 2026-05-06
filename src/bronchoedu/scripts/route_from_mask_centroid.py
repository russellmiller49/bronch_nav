from __future__ import annotations

import argparse
import json
from pathlib import Path

from bronchoedu.airway_route import AirwayNetwork
from bronchoedu.io import read_image
from bronchoedu.labels import centroid_for_label


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate airway route JSON from a nodule mask centroid.")
    parser.add_argument("--network-vtk", required=True, help="Path to Network model.vtk")
    parser.add_argument("--mask", required=True, help="Synthetic nodule mask NRRD/NIfTI")
    parser.add_argument("--label", type=int, default=1, help="Mask label value for synthetic nodule")
    parser.add_argument("--route-json", required=True, help="Output route JSON path")
    parser.add_argument("--no-frames", action="store_true", help="Skip CT/camera frames")
    return parser


def route_from_mask(args: argparse.Namespace) -> dict:
    mask_img = read_image(args.mask)
    centroid = centroid_for_label(mask_img, args.label)
    target_ras = centroid["centroid_ras"]
    network = AirwayNetwork.from_network_vtk(args.network_vtk)
    route = network.route_to_point(target_ras, include_frames=not args.no_frames)
    route["derived_from_mask"] = {
        "mask": str(args.mask),
        "label": int(args.label),
        "centroid_lps": centroid["centroid_lps"],
        "centroid_ras": target_ras,
        "education_only": True,
        "not_for_clinical_use": True,
        "synthetic": True,
    }
    route["education_only"] = True
    route["not_for_clinical_use"] = True
    return route


def main() -> None:
    args = build_parser().parse_args()
    route = route_from_mask(args)
    out_path = Path(args.route_json)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(route, indent=2), encoding="utf-8")
    summary = {
        "route_json": str(out_path),
        "target_ras": route.get("target_ras"),
        "nearest_airway_distance_mm": route.get("nearest_airway", {}).get("airway_to_target_distance_mm"),
        "route_point_count": route.get("route", {}).get("point_count", 0),
        "bifurcation_decision_count": len(route.get("bifurcation_decisions", [])),
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
