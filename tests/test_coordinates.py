from bronchoedu.coordinates import lps_to_ras, lps_vector_to_ras, ras_to_lps, ras_vector_to_lps


def test_ras_lps_roundtrip_point():
    point_ras = [12.5, -3.0, 44.0]
    assert lps_to_ras(ras_to_lps(point_ras)) == point_ras


def test_vector_sign_flip_matches_point_sign_flip():
    assert ras_vector_to_lps([1, 2, 3]) == [-1.0, -2.0, 3.0]
    assert lps_vector_to_ras([-1, -2, 3]) == [1.0, 2.0, 3.0]
