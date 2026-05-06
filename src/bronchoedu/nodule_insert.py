"""Nodule insertion API.

The implementation is shared with :mod:`bronchoedu.nodule_assets` to preserve
the behavior of the original prototype while exposing the required module name.
"""

from __future__ import annotations

from .nodule_assets import insert_asset

__all__ = ["insert_asset"]
