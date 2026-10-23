"""Handler registry for the 11 domain modules (A-K, 142 operations).

Each module file registers OperationHandler subclasses for the operations it owns.
Operations without a specialised handler use the base OperationHandler, which still
gives full CREATE/UPDATE/READ/VALIDATE/ACCEPT semantics through the kernel.
"""
from __future__ import annotations

import importlib

from .base import Context, OperationHandler, Result, normalize_to_output

HANDLERS: dict[str, OperationHandler] = {}
MODULE_NAMES = ["set_a", "set_b", "set_c", "set_d", "set_e", "set_f", "set_g", "set_h", "set_i", "set_j", "set_k"]
_loaded = False


def register(*op_ids: str):
    """Class decorator: @register("A01", "A02") instantiates one handler per op ID."""
    def deco(cls):
        for op in op_ids:
            HANDLERS[op] = cls(op)
        return cls
    return deco


def load_all():
    global _loaded
    if _loaded:
        return
    for name in MODULE_NAMES:
        importlib.import_module(f"{__name__}.{name}")
    _loaded = True


def get_handler(op_id: str) -> OperationHandler:
    load_all()
    h = HANDLERS.get(op_id)
    if h is None:
        h = OperationHandler(op_id)
        HANDLERS[op_id] = h
    return h


__all__ = ["Context", "OperationHandler", "Result", "normalize_to_output", "register", "get_handler", "HANDLERS"]
