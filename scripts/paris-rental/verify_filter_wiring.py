#!/usr/bin/env python3
"""
Regression test for Sub-AC 1.5.2: each of the 7 sidebar filter UI controls in
the rendered Paris-rental Leaflet HTML must read/write the central FilterState
and trigger map re-filtering.

This is a structural test on the *rendered* HTML output of render_map.py — it
proves the wiring code emitted into paris-realestate.html is well-formed,
without spinning up a browser. The 7 axes (per the Seed contract) are:

    1. price       (number-input duo: filter-price-min / filter-price-max)
    2. area        (number-input duo: filter-area-min  / filter-area-max)
    3. rooms       (chip checkboxes:  input.filter-rooms)
    4. meuble      (chip checkboxes:  input.filter-meuble)
    5. move-in     (single checkbox:  input#filter-movein.filter-movein)
    6. sources     (chip checkboxes:  input.filter-sources)
    7. arr         (chip checkboxes:  input.filter-arr; metro-line UI ships
                                       in a later sub-AC and only its state
                                       slot is checked here)

For each axis we assert:
  (a) The DOM control(s) are emitted with the right id/class.
  (b) syncFromInputs() reads the control(s) into the FilterState.set() patch.
  (c) An 'input'/'change' event on the control routes through syncFromInputs.
  (d) FilterState.subscribe(applyFilters) is wired so a state change re-runs
      passesFilter + cluster re-population.
  (e) The reset button clears every control and re-syncs.

The script exits non-zero on the first failed assertion. It is intended to be
run from the repo root:

    python3 scripts/paris-rental/verify_filter_wiring.py
"""
from __future__ import annotations

import os
import re
import sys
import tempfile

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SKILL_DIR = os.path.join(REPO_ROOT, "container", "skills", "paris-rental-watch")
sys.path.insert(0, SKILL_DIR)

import render_map  # noqa: E402


SAMPLE_LISTINGS = [
    {
        "namespaced_id": "fz-bbs2:1",
        "post_id": "1",
        "source": "francezone-bbs2",
        "title": "T2 14e arr",
        "url": "https://example.com/1",
        "verdict": "pass",
        "lat": 48.83,
        "lng": 2.32,
        "location_text": "14e",
        "price_eur": 1200,
        "area_m2": 35,
        "move_in": "2026-06-01",
        "rooms": "T2",
        "meuble": "meuble",
        "zip_or_arr": "75014",
    },
    {
        "namespaced_id": "pap:2",
        "post_id": "2",
        "source": "pap",
        "title": "T3 11e arr",
        "url": "https://example.com/2",
        "verdict": "pass",
        "lat": 48.85,
        "lng": 2.37,
        "location_text": "11e",
        "price_eur": 1800,
        "area_m2": 55,
        "move_in": "flexible",
        "rooms": "T3",
        "meuble": "non",
        "zip_or_arr": "75011",
    },
    {
        "namespaced_id": "fz-bbs3:3",
        "post_id": "3",
        "source": "francezone-bbs3",
        "title": "T1 92",
        "url": "https://example.com/3",
        "verdict": "ambiguous",
        "lat": 48.88,
        "lng": 2.24,
        "location_text": "Boulogne",
        "price_eur": 900,
        "area_m2": 22,
        "move_in": None,
        "rooms": "T1",
        "meuble": "unknown",
        "zip_or_arr": "92100",
    },
]


def _render() -> str:
    """Render the test fixture and return the HTML body."""
    with tempfile.TemporaryDirectory() as td:
        html_path = os.path.join(td, "out.html")
        render_map.render_html(SAMPLE_LISTINGS, html_path, "2026-05-09T22:00:00+02:00")
        with open(html_path, "r", encoding="utf-8") as f:
            return f.read()


# Shape: (axis label, list of (description, regex) checks).
# Each axis must satisfy ALL its checks. Regexes are deliberately liberal
# (\s* etc) so cosmetic tweaks (whitespace, attribute reorder) don't break them.
DOM_CHECKS: list[tuple[str, list[tuple[str, str]]]] = [
    (
        "price",
        [
            (
                "min input present (type=number, id=filter-price-min)",
                r'<input(?=[^>]*\btype="number")(?=[^>]*\bid="filter-price-min")',
            ),
            (
                "max input present (type=number, id=filter-price-max)",
                r'<input(?=[^>]*\btype="number")(?=[^>]*\bid="filter-price-max")',
            ),
        ],
    ),
    (
        "area",
        [
            (
                "min input present (type=number, id=filter-area-min)",
                r'<input(?=[^>]*\btype="number")(?=[^>]*\bid="filter-area-min")',
            ),
            (
                "max input present (type=number, id=filter-area-max)",
                r'<input(?=[^>]*\btype="number")(?=[^>]*\bid="filter-area-max")',
            ),
        ],
    ),
    (
        "rooms",
        [
            (
                "≥3 chip checkboxes",
                # We expect at least T1, T2, T3, T4+, unknown.
                None,
            ),
        ],
    ),
    (
        "meuble",
        [("≥3 chip checkboxes", None)],
    ),
    (
        "move-in",
        [
            (
                "single checkbox toggle present (id=filter-movein, class=filter-movein)",
                r'<input(?=[^>]*\bid="filter-movein")(?=[^>]*\bclass="filter-movein")',
            ),
        ],
    ),
    (
        "sources",
        [("≥3 chip checkboxes", None)],
    ),
    (
        "arr",
        [("≥20 chip checkboxes (1구–20구 + 92/93/94 + 미기재)", None)],
    ),
]

# Per-axis chip class → expected minimum count.
CHIP_COUNTS = {
    "filter-rooms": 5,
    "filter-meuble": 3,
    "filter-sources": 3,
    "filter-arr": 24,
}

# syncFromInputs() must write each axis into FilterState.set({…}).
SYNC_PATCH_KEYS = [
    ("price", r"priceMin\s*:\s*readNum\(\s*'filter-price-min'\s*\)"),
    ("price", r"priceMax\s*:\s*readNum\(\s*'filter-price-max'\s*\)"),
    ("area", r"areaMin\s*:\s*readNum\(\s*'filter-area-min'\s*\)"),
    ("area", r"areaMax\s*:\s*readNum\(\s*'filter-area-max'\s*\)"),
    ("rooms", r"roomsSelected\s*:\s*readChecked\(\s*'filter-rooms'\s*\)"),
    ("meuble", r"meubleSelected\s*:\s*readChecked\(\s*'filter-meuble'\s*\)"),
    ("sources", r"sourcesSelected\s*:\s*readChecked\(\s*'filter-sources'\s*\)"),
    ("arr", r"arrSelected\s*:\s*readChecked\(\s*'filter-arr'\s*\)"),
    (
        "move-in",
        r"moveInAfter202606\s*:\s*!!\(\s*moveInEl\s*&&\s*moveInEl\.checked\s*\)",
    ),
]


def main(argv: list[str] | None = None) -> int:
    html = _render()
    failures: list[str] = []

    def check(label: str, ok: bool, detail: str) -> None:
        status = "OK" if ok else "FAIL"
        print(f"[{status}] {label}: {detail}")
        if not ok:
            failures.append(f"{label}: {detail}")

    # ------------------------------------------------------------------
    # 1. DOM controls present for each of the 7 axes.
    # ------------------------------------------------------------------
    for axis, checks in DOM_CHECKS:
        for desc, pat in checks:
            if pat is None:
                continue
            check(f"{axis} DOM", re.search(pat, html) is not None, desc)
    for cls, expected_min in CHIP_COUNTS.items():
        # Order-agnostic: look for any <input ... class="cls" ...> regardless
        # of attribute ordering.
        n = len(
            re.findall(
                rf'<input(?=[^>]*\bclass="{re.escape(cls)}")', html
            )
        )
        check(
            f"{cls} chip count",
            n >= expected_min,
            f"got {n}, expected ≥ {expected_min}",
        )

    # ------------------------------------------------------------------
    # 2. syncFromInputs() patches FilterState with each axis.
    # ------------------------------------------------------------------
    for axis, pat in SYNC_PATCH_KEYS:
        check(
            f"{axis} sync→state",
            re.search(pat, html) is not None,
            f"syncFromInputs() must include patch matching /{pat}/",
        )

    # ------------------------------------------------------------------
    # 3. Event listeners route DOM changes through syncFromInputs.
    # ------------------------------------------------------------------
    # Range inputs use rAF-debounced 'input' + 'change'.
    check(
        "range inputs listen for 'input'",
        re.search(r"el\.addEventListener\(\s*'input'\s*,", html) is not None,
        "price/area number inputs must listen for 'input'",
    )
    check(
        "range inputs listen for 'change'",
        re.search(r"el\.addEventListener\(\s*'change'\s*,\s*syncFromInputs", html)
        is not None,
        "price/area number inputs must listen for 'change'",
    )

    # Chip + move-in checkboxes share one listener selector.
    chip_listener = re.search(
        r"querySelectorAll\(\s*\n?\s*'([^']*filter-rooms[^']*)'", html
    )
    chip_selector = chip_listener.group(1) if chip_listener else ""
    for cls in (
        "filter-rooms",
        "filter-meuble",
        "filter-sources",
        "filter-arr",
        "filter-movein",
    ):
        check(
            f"{cls} change listener",
            f"input.{cls}" in chip_selector,
            f"checkbox listener selector must include input.{cls}",
        )
    check(
        "checkboxes route through syncFromInputs",
        re.search(
            r"checkboxes\[i\]\.addEventListener\(\s*'change'\s*,\s*syncFromInputs",
            html,
        )
        is not None,
        "every checkbox must call syncFromInputs on 'change'",
    )

    # ------------------------------------------------------------------
    # 4. FilterState change → applyFilters re-renders the cluster.
    # ------------------------------------------------------------------
    check(
        "FilterState.subscribe(applyFilters)",
        re.search(r"FilterState\.subscribe\(\s*applyFilters\s*\)", html) is not None,
        "applyFilters must be subscribed to FilterState",
    )
    check(
        "applyFilters clears+repopulates cluster",
        re.search(r"cluster\.clearLayers\(\)", html) is not None
        and re.search(r"cluster\.addLayers\(\s*visible\s*\)", html) is not None,
        "applyFilters must clearLayers() then addLayers(visible)",
    )
    check(
        "applyFilters updates count display",
        re.search(r"getElementById\(\s*'filter-count'\s*\)", html) is not None,
        "applyFilters must refresh #filter-count",
    )

    # ------------------------------------------------------------------
    # 5. Reset button clears every control + re-syncs.
    # ------------------------------------------------------------------
    check(
        "reset button present",
        re.search(r'id="filter-reset"', html) is not None,
        "#filter-reset must exist",
    )
    check(
        "reset clears number inputs",
        re.search(r"if\s*\(\s*el\s*\)\s*el\.value\s*=\s*''", html) is not None,
        "reset handler must clear number inputs",
    )
    check(
        "reset clears every checkbox in sidebar",
        re.search(
            r"querySelectorAll\(\s*'#sidebar-content input\[type=\"checkbox\"\]'\s*\)",
            html,
        )
        is not None,
        "reset handler must walk #sidebar-content checkboxes",
    )
    check(
        "reset re-syncs state via syncFromInputs",
        len(
            re.findall(r"syncFromInputs\(\)", html)
        )
        >= 2,
        "reset handler must call syncFromInputs() after clearing",
    )

    # ------------------------------------------------------------------
    # 6. metroLinesSelected slot exists in FilterState (DOM ships in a
    #    later sub-AC; this one only guarantees the state field is held).
    # ------------------------------------------------------------------
    check(
        "metroLinesSelected state slot",
        re.search(r"metroLinesSelected\s*:\s*\[\s*\]", html) is not None,
        "FilterState defaults must include metroLinesSelected: []",
    )

    print()
    if failures:
        print(f"verify_filter_wiring: {len(failures)} FAILURE(S)")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("verify_filter_wiring: all 7 sidebar filter controls wired ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
