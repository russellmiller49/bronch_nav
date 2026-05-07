import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import SimpleITK as sitk

from bronchoedu.scripts.prepare_web_case import _load_scope_calibration, _prepare_nodule_asset, _sanitize_json, prepare_web_case


def test_sanitize_json_replaces_nonfinite_float_values():
    payload = {
        "ok": 1.25,
        "bad": float("nan"),
        "nested": [float("inf"), {"also_bad": -float("inf")}],
    }

    sanitized = _sanitize_json(payload)

    assert sanitized == {"ok": 1.25, "bad": None, "nested": [None, {"also_bad": None}]}
    json.dumps(sanitized, allow_nan=False)


def test_prepare_nodule_asset_writes_browser_residual_and_alpha(tmp_path):
    asset_dir = tmp_path / "asset"
    out_dir = tmp_path / "case"
    asset_dir.mkdir()
    out_dir.mkdir()

    residual = np.array([[[0, 120], [-20, 40]]], dtype=np.float32)
    alpha = np.array([[[0.0, 0.5], [1.0, 0.25]]], dtype=np.float32)
    residual_img = sitk.GetImageFromArray(residual)
    alpha_img = sitk.GetImageFromArray(alpha)
    residual_img.SetSpacing((0.7, 0.8, 1.0))
    alpha_img.CopyInformation(residual_img)
    sitk.WriteImage(residual_img, str(asset_dir / "residual_signal.nrrd"))
    sitk.WriteImage(alpha_img, str(asset_dir / "alpha.nrrd"))
    (asset_dir / "metadata.json").write_text(
        json.dumps(
            {
                "asset_id": "demo",
                "centroid_index_xyz": [1.0, 2.0, 3.0],
                "max_radius_mm": 4.5,
            }
        ),
        encoding="utf-8",
    )

    payload = _prepare_nodule_asset(asset_dir, out_dir)

    assert payload["assetId"] == "demo"
    assert payload["sizeXyz"] == [2, 2, 1]
    assert payload["spacingXyzMm"] == [0.7, 0.8, 1.0]
    assert (out_dir / "nodule_residual_int16.raw").read_bytes()
    assert (out_dir / "nodule_alpha_uint8.raw").read_bytes()


def test_load_scope_calibration_accepts_exported_payload(tmp_path):
    payload = {
        "schema": "bronchoedu_scope_calibration/v1",
        "caseId": "synthetic-target",
        "exportedAt": "2026-05-06T00:00:00.000Z",
        "adjustments": {"42": {"yawDeg": 12, "labelOffsets": {"A": {"x": 4, "y": -3}}}},
    }
    path = tmp_path / "scope-calibration.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    loaded = _load_scope_calibration(path, "fallback-case")

    assert loaded["caseId"] == "synthetic-target"
    assert loaded["adjustments"]["42"]["yawDeg"] == 12


def test_prepare_web_case_merges_airway_anatomy_labels(tmp_path):
    root = Path(__file__).resolve().parents[1]
    anatomy_path = tmp_path / "airway_anatomy_labels.json"
    anatomy_path.write_text(
        json.dumps(
            {
                "schema": "bronchoedu_airway_anatomy/v1",
                "source": {"generator": "test-import", "reviewStatus": "unreviewed"},
                "nodes": {
                    "0": {
                        "sampleCount": 1,
                        "validSampleCount": 1,
                        "coverage": 1.0,
                        "confidence": 1.0,
                        "segment": {"value": 8, "name": "RB1", "confidence": 1.0},
                    }
                },
                "edges": {
                    "0": {
                        "sampleCount": 2,
                        "validSampleCount": 2,
                        "coverage": 1.0,
                        "confidence": 1.0,
                        "subsegment": {"value": 42, "name": "RB1a", "confidence": 1.0},
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    out_dir = tmp_path / "case"
    prepare_web_case(
        SimpleNamespace(
            ct=root / "data/target/target_clean_ct.nrrd",
            network_vtk=root / "data/airway/Network model.vtk",
            route_json=root / "reference_outputs/example_route_to_terminal_like_target.json",
            out_dir=out_dir,
            case_id="anatomy-test",
            stride=16,
            window_min=-1050.0,
            window_max=350.0,
            nodule_asset_dir=None,
            scope_calibration_json=None,
            airway_anatomy_json=anatomy_path,
            airway_candidates_json=None,
        )
    )

    case = json.loads((out_dir / "case.json").read_text(encoding="utf-8"))

    assert case["airway"]["anatomySource"]["generator"] == "test-import"
    assert case["airway"]["nodes"][0]["anatomy"]["segment"]["name"] == "RB1"
    assert case["airway"]["edges"][0]["anatomy"]["subsegment"]["name"] == "RB1a"


def test_prepare_web_case_merges_book_candidate_labels(tmp_path):
    root = Path(__file__).resolve().parents[1]
    candidates_path = tmp_path / "book_candidates.json"
    candidates_path.write_text(
        json.dumps(
            {
                "schema": "airway_labeling_candidate_results/v1",
                "source": {"generator": "book-test", "reviewQueue": []},
                "edges": {
                    "0": [
                        {
                            "edgeId": 0,
                            "candidateLabel": "RUL_B1",
                            "candidateLevel": "segmental",
                            "score": 0.82,
                            "explanation": "directional candidate",
                            "warnings": ["candidate_not_final"],
                            "source": "book_directional_rules",
                            "evidence": {"direction_score": 0.9},
                        }
                    ]
                },
            }
        ),
        encoding="utf-8",
    )

    out_dir = tmp_path / "case"
    prepare_web_case(
        SimpleNamespace(
            ct=root / "data/target/target_clean_ct.nrrd",
            network_vtk=root / "data/airway/Network model.vtk",
            route_json=root / "reference_outputs/example_route_to_terminal_like_target.json",
            out_dir=out_dir,
            case_id="candidates-test",
            stride=16,
            window_min=-1050.0,
            window_max=350.0,
            nodule_asset_dir=None,
            scope_calibration_json=None,
            airway_anatomy_json=None,
            airway_candidates_json=candidates_path,
        )
    )

    case = json.loads((out_dir / "case.json").read_text(encoding="utf-8"))

    assert case["airway"]["candidateSource"]["generator"] == "book-test"
    assert case["airway"]["edges"][0]["candidateLabels"][0]["candidateLabel"] == "RUL_B1"
    assert case["airway"]["edges"][0]["candidateLabels"][0]["score"] == 0.82
