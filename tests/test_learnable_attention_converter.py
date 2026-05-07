from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from airway_labeling.scripts.export_learnable_attention_graph import export_learnable_attention_graph
from bronchoedu.airway_route import AirwayNetwork


def test_export_learnable_attention_graph_from_included_network(tmp_path: Path):
    root = Path(__file__).resolve().parents[1]
    network_vtk = root / "data/airway/Network model.vtk"
    network = AirwayNetwork.from_network_vtk(network_vtk)

    summary = export_learnable_attention_graph(
        network_vtk=network_vtk,
        out_dir=tmp_path,
        patient_id="patient01",
        write_placeholder_y=True,
    )

    x = np.load(tmp_path / "features/patient01_x.npy")
    edge = np.load(tmp_path / "features/patient01_edge.npy")
    edge_feature = np.load(tmp_path / "features/patient01_edge_feature.npy")
    node_idx = np.load(tmp_path / "features/patient01_node_idx.npy")
    y = np.load(tmp_path / "features/patient01_y.npy")
    spd = np.load(tmp_path / "topology/patient01_spd.npy")
    metadata = json.loads((tmp_path / "metadata/patient01_branch_metadata.json").read_text(encoding="utf-8"))

    assert summary["branch_count"] == len(network.edges)
    assert x.shape == (len(network.edges), 20)
    assert edge.shape[0] == 2
    assert edge_feature.shape == (edge.shape[1],)
    assert set(edge_feature.tolist()) == {-1, 1}
    assert node_idx.tolist() == [edge.id for edge in network.edges]
    assert y.shape == (3, len(network.edges))
    assert np.all(y == -1)
    assert spd.shape == (len(network.edges), len(network.edges))
    assert np.all(np.diag(spd) == 0)
    assert metadata["schema"].startswith("learnable_attention_airway_graph")
    assert metadata["branches"][0]["row_index"] == 0

