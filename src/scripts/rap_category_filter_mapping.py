"""
RAP Category strings for the Spend Review filter (see ``index.html`` ``idpGetRapCategoryForFilter``).

Keep this module in sync with the dashboard triple/wildcard rules.
"""

from __future__ import annotations

import re

_WS = re.compile(r"\s+")


def norm_rap_seg(s: object) -> str:
    return _WS.sub(" ", str(s or "").strip()).lower()


_EXACT: list[tuple[tuple[str, str, str], str]] = []
_WILD: list[tuple[tuple[str, str], str]] = []


def _init_rules() -> None:
    if _EXACT:
        return

    def triple(a1: str, a2: str, a3: str, out: str) -> None:
        _EXACT.append(((norm_rap_seg(a1), norm_rap_seg(a2), norm_rap_seg(a3)), out))

    def duo(a1: str, a2: str, out: str) -> None:
        _WILD.append(((norm_rap_seg(a1), norm_rap_seg(a2)), out))

    triple("Direct", "Direct/Undefined", "Direct/Undefined/Undefined", "Other Directs")
    triple("Direct", "Electrical Systems", "Controls", "Controls")
    triple("Direct", "Electrical Systems", "Sensors", "Sensors")
    triple(
        "Direct",
        "Electrical Systems",
        "Wiring Harnesses And Electrical Components",
        "Wiring Harnesses And Electrical Components",
    )
    triple("Direct", "Electrified Power Components", "EPC - Power Electronics", "Other Directs")
    triple("Direct", "Emissions", "DIT", "Other Directs")
    triple("Direct", "Fluid And Air Management", "Turbines And Compressors", "Turbines and Compressors")
    triple("Direct", "Fluid And Air Management", "Valves", "Valves and Pumps")
    triple("Direct", "Fluid And Air Management", "Pumps", "Valves and Pumps")
    triple("Direct", "Fluid And Air Management", "Sealings And Gaskets", "Other Fluid and Air Management")
    triple("Direct", "Fluid And Air Management", "Fuel And Dosing Systems", "Other Fluid and Air Management")
    triple("Direct", "Fluid And Air Management", "Tubes And Hoses", "Other Fluid and Air Management")
    triple("Direct", "Fluid And Air Management", "Plastics", "Other Fluid and Air Management")
    triple("Direct", "Fluid And Air Management", "Filters", "Other Fluid and Air Management")
    triple("Direct", "Fluid And Air Management", "Castings", "Other Fluid and Air Management")
    triple("Direct", "Fluid And Air Management", "Heat Transfer", "Other Fluid and Air Management")
    triple("Direct", "Manufactured Materials", "Castings", "Castings")
    triple("Direct", "Manufactured Materials", "Forgings", "Forgings, Stampings, and Fabs")
    triple("Direct", "Manufactured Materials", "Stamping And Fabs", "Forgings, Stampings, and Fabs")
    triple("Direct", "Manufactured Materials", "Overhead And Power Cylinder", "Other Manufactured Materials")
    triple("Direct", "Manufactured Materials", "Raw Materials", "Other Manufactured Materials")
    triple("Direct", "Manufactured Materials", "Blocks And Heads", "Other Manufactured Materials")
    triple("Direct", "Mechanical Systems", "Precision Machining", "Precision Machining")
    triple("Direct", "Mechanical Systems", "Hardware", "Hardware")
    triple("Direct", "Mechanical Systems", "Mechanical Assemblies", "Other Mechanical Systems")
    triple("Direct", "Mechanical Systems", "Komatsu", "Other Mechanical Systems")
    triple("Direct", "New", "New", "Other Directs")
    triple("Direct", "Power Systems", "PS Power Electronics", "Other Directs")
    triple("Direct", "Power Systems", "Engines", "Other Directs")
    triple("Direct", "Power Systems", "PS Heat Transfer", "Other Directs")
    triple("Direct", "Specialized Procurement", "NRP", "Other Directs")
    triple("Direct", "Specialized Procurement", "Miscellaneous", "Other Directs")
    triple("Direct", "Specialized Procurement", "DBU", "Other Directs")
    triple("Direct", "Specialized Procurement", "CGT", "Other Directs")
    triple("Indirect", "Indirect/Undefined", "Indirect/Undefined/Undefined", "Other Indirects")
    duo("Indirect", "Corporate Services", "Corporate Services")
    duo("Indirect", "Facilities Services", "Facilities Services")
    duo("Indirect", "IT & Engineering Services", "IT and Engineering Services")
    duo("Indirect", "Product Testing And Manufacturing Services", "Product Testing And Manufacturing Services")
    duo("Indirect", "Supply Chain", "Supply Chain")
    triple("Indirect", "Unmanaged", "Prototypes", "Other Indirects")
    triple("Indirect", "Unmanaged", "Taxes", "Other Indirects")


_init_rules()


def get_rap_category_for_filter(l1: object, l2: object, l3: object) -> str:
    n1, n2, n3 = norm_rap_seg(l1), norm_rap_seg(l2), norm_rap_seg(l3)
    for (t1, t2, t3), out in _EXACT:
        if n1 == t1 and n2 == t2 and n3 == t3:
            return out
    for (t1, t2), out in _WILD:
        if n1 == t1 and n2 == t2:
            return out
    return "Other"
