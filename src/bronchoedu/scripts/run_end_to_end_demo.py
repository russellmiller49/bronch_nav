from __future__ import annotations

import argparse
import json
from pathlib import Path

import yaml

from bronchoedu.scripts.create_nodule_asset import build_parser as create_parser
from bronchoedu.scripts.insert_nodule_asset import build_parser as insert_parser
from bronchoedu.scripts.route_from_mask_centroid import build_parser as route_parser
from bronchoedu.scripts.route_from_mask_centroid import route_from_mask
from bronchoedu.scripts.split_multilabel_nodule_mask import build_parser as split_parser
from bronchoedu.scripts.validate_slicer_exports import build_parser as validate_parser
from bronchoedu.scripts.validate_slicer_exports import validate_exports
from bronchoedu.labels import resolve_label_value, split_labelmap_to_binary
from bronchoedu.nodule_assets import create_asset, insert_asset


def _parse_with(parser, args: list[str]):
    return parser().parse_args(args)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the bronchoedu end-to-end demo pipeline from YAML config.")
    parser.add_argument("--config", default="config/example_pipeline_config.yaml", help="Pipeline YAML config")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    config = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))

    source = config["source"]
    target = config["target"]
    airway = config["airway"]
    asset_cfg = config["nodule_asset"]
    insertion = config["insertion"]
    route_cfg = config["route"]

    outputs_root = Path("outputs")
    outputs_root.mkdir(exist_ok=True)

    validation_args = _parse_with(
        validate_parser,
        [
            "--ct",
            source["ct"],
            "--mask",
            source["mask"],
            "--labels-csv",
            source.get("labels_csv", ""),
            "--out-json",
            "outputs/source_export_validation.json",
        ],
    )
    validation = validate_exports(validation_args)
    Path("outputs/source_export_validation.json").write_text(json.dumps(validation, indent=2), encoding="utf-8")

    split_out = source.get("binary_mask_out", "outputs/source/lung_nodule_1_mask.nrrd")
    label, _ = resolve_label_value(source.get("label_value"), source.get("label_name"), source.get("labels_csv"))
    split_labelmap_to_binary(source["mask"], split_out, label)

    create_args = _parse_with(
        create_parser,
        [
            "--source-ct",
            source["ct"],
            "--source-mask",
            split_out,
            "--out-dir",
            asset_cfg["out_dir"],
            "--label",
            "1",
            "--labels-csv",
            source.get("labels_csv", ""),
            "--margin-mm",
            str(asset_cfg.get("margin_mm", 12)),
            "--feather-mm",
            str(asset_cfg.get("feather_mm", 2)),
        ],
    )
    create_asset(create_args)

    insert_args = _parse_with(
        insert_parser,
        [
            "--target-ct",
            target["ct"],
            "--asset-dir",
            asset_cfg["out_dir"],
            "--target-ras",
            *[str(v) for v in target["insertion_ras"]],
            "--out-ct",
            insertion["out_ct"],
            "--out-mask",
            insertion["out_mask"],
            "--out-placement",
            insertion.get("out_placement", "outputs/synthetic/synthetic_placement.json"),
            "--mode",
            insertion.get("mode", "residual"),
            "--scale",
            str(insertion.get("scale", 1.0)),
            "--rot-deg",
            *[str(v) for v in insertion.get("rotation_degrees", [0, 0, 0])],
        ],
    )
    if insertion.get("cast_int16", False):
        insert_args.cast_int16 = True
    insert_asset(insert_args)

    route_args = _parse_with(
        route_parser,
        [
            "--network-vtk",
            airway["network_vtk"],
            "--mask",
            insertion["out_mask"],
            "--label",
            "1",
            "--route-json",
            route_cfg["out_json"],
        ],
    )
    route = route_from_mask(route_args)
    route_path = Path(route_cfg["out_json"])
    route_path.parent.mkdir(parents=True, exist_ok=True)
    route_path.write_text(json.dumps(route, indent=2), encoding="utf-8")
    print(json.dumps({"route_json": str(route_path), "route_point_count": route.get("route", {}).get("point_count", 0)}, indent=2))


if __name__ == "__main__":
    main()
