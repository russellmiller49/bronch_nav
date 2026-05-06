from pathlib import Path

from bronchoedu.airway_route import AirwayNetwork


def test_airway_route_from_included_network_has_frames_and_decisions():
    root = Path(__file__).resolve().parents[1]
    network = AirwayNetwork.from_network_vtk(root / "data/airway/Network model.vtk")
    route = network.route_to_point([49.9669, 123.7354, -310.0783], include_frames=True)

    assert route["target_ras"] == [49.9669, 123.7354, -310.0783]
    assert route["nearest_airway"]["airway_to_target_distance_mm"] >= 0
    assert route["route"]["point_count"] > 0
    assert len(route["route"]["frames"]) == route["route"]["point_count"]
    assert len(route["bifurcation_decisions"]) > 0
