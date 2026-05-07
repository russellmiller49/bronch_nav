from __future__ import annotations

import argparse
import json

from bronchoedu.airway_anatomy import import_airmorph_labels


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Import AirMorph/AirwayNet airway anatomy labels onto a network VTK.")
    parser.add_argument("--network-vtk", required=True, help="Path to the Slicer/VMTK airway Network model.vtk.")
    parser.add_argument("--pred-lob", required=True, help="AirMorph lobar label volume, e.g. patient_pred_lob.nii.gz.")
    parser.add_argument("--pred-seg", required=True, help="AirMorph segmental label volume, e.g. patient_pred_seg.nii.gz.")
    parser.add_argument("--pred-sub", required=True, help="AirMorph subsegmental label volume, e.g. patient_pred_sub.nii.gz.")
    parser.add_argument("--class2anno", required=True, help="AirMorph configs/class2anno.json.")
    parser.add_argument("--out-json", required=True, help="Output airway_anatomy_labels.json path.")
    parser.add_argument("--ct", default=None, help="Optional CT used for AirMorph; validates label geometry.")
    parser.add_argument("--airway-bin", default=None, help="Optional AirMorph airway_bin.nii.gz used to reject background samples.")
    parser.add_argument("--anno-json", default=None, help="Optional AirMorph patient_anno.json for provenance.")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    payload = import_airmorph_labels(
        network_vtk=args.network_vtk,
        pred_lob=args.pred_lob,
        pred_seg=args.pred_seg,
        pred_sub=args.pred_sub,
        class2anno_json=args.class2anno,
        out_json=args.out_json,
        reference_ct=args.ct,
        airway_bin=args.airway_bin,
        anno_json=args.anno_json,
    )
    print(
        json.dumps(
            {
                "out_json": args.out_json,
                "node_count": len(payload["nodes"]),
                "edge_count": len(payload["edges"]),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
