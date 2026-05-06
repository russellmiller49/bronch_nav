"""Coordinate conversion helpers.

3D Slicer UI coordinates and route JSON use RAS. SimpleITK/NRRD image
physical space is normally LPS. Points and vectors use the same sign flip for
the first two axes.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence


def _triplet(values: Iterable[float]) -> list[float]:
    out = [float(v) for v in values]
    if len(out) != 3:
        raise ValueError(f"Expected 3 values, got {len(out)}")
    return out


def ras_to_lps(point_ras: Iterable[float]) -> list[float]:
    r, a, s = _triplet(point_ras)
    return [-r, -a, s]


def lps_to_ras(point_lps: Iterable[float]) -> list[float]:
    l, p, s = _triplet(point_lps)
    return [-l, -p, s]


def ras_vector_to_lps(vector_ras: Iterable[float]) -> list[float]:
    return ras_to_lps(vector_ras)


def lps_vector_to_ras(vector_lps: Iterable[float]) -> list[float]:
    return lps_to_ras(vector_lps)


def ras_points_to_lps(points_ras: Iterable[Sequence[float]]) -> list[list[float]]:
    return [ras_to_lps(point) for point in points_ras]


def lps_points_to_ras(points_lps: Iterable[Sequence[float]]) -> list[list[float]]:
    return [lps_to_ras(point) for point in points_lps]
