#!/usr/bin/env python3
"""
Fetch line membership for IDF métro / RER / tram stations from OSM Overpass and
augment idf_stations.json with a third element: ``[lat, lng, [lines...]]``.

Why coord-based join (not name-based):
  ``idf_stations.json`` already enumerates ~1540 alias keys for ~800 unique
  stations, with diacritic / hyphen variants. Joining on a normalised name from
  Overpass would re-introduce the same aliasing problem we already solved at
  build time. Coords are unique per station (rounded to 5 decimals — ~1m), so
  we keep the alias table intact and just attach line lists.

Output schema (new):
  {
    "alésia":          [48.82803, 2.32704, ["M4"]],
    "châtelet":        [48.85878, 2.34741, ["M1", "M4", "M7", "M11", "M14"]],
    ...
  }

Backward-compat: ``metro_lookup.py`` keeps reading element [0] and [1] for
coords. New filter code can read element [2] for line membership.

The Overpass route_master relations are the source of truth for "which stops
belong to which line" — we iterate every line ref and collect its stop_position
members, then union by coord.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import unicodedata
import urllib.parse
import urllib.request


OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]


# ---------------------------------------------------------------------------
# Overpass helpers
# ---------------------------------------------------------------------------

def overpass(query: str, timeout: int = 180) -> dict:
    """POST a query to Overpass with endpoint failover."""
    last_err: Exception | None = None
    for ep in OVERPASS_ENDPOINTS:
        try:
            data = urllib.parse.urlencode({"data": query}).encode()
            req = urllib.request.Request(ep, data=data, method="POST")
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # pragma: no cover - network
            last_err = e
            print(f"  ! {ep} failed: {e}", file=sys.stderr)
            time.sleep(2)
    raise RuntimeError(f"all Overpass endpoints failed: {last_err}")


# Fetches every route relation for a given mode + filter, plus all member stop
# nodes. We use ``out body`` for relations (so members are visible) and ``>;
# out skel`` to pull every referenced node with coords.
QUERY_ALL_LINES = r"""
[out:json][timeout:180];
(
  // Métro de Paris (M1..M14, M3bis, M7bis)
  relation["type"="route"]["route"="subway"]["network"~"Métro de Paris|RATP", i](47.7,1.5,49.5,3.6);
  // RER A..E — tagged route=train with name "RER X"
  relation["type"="route"]["route"="train"]["name"~"^RER ", i](47.7,1.5,49.5,3.6);
  // Trams T1..T13
  relation["type"="route"]["route"="tram"](47.7,1.5,49.5,3.6);
);
out body;
// Recurse to member nodes WITH tags so we can name-join missed aliases.
node(r);
out body qt;
"""


# ---------------------------------------------------------------------------
# Line-id normaliser
# ---------------------------------------------------------------------------

def normalise_line_id(rel_tags: dict) -> str | None:
    """Return canonical line id for a route relation: 'M1', 'RER A', 'T3a', ...

    Strategy: prefer ``short_name`` ("M1", "T3a"); else build from ``route`` +
    ``ref`` ('subway' + '1' → 'M1', 'tram' + '3a' → 'T3a', 'train' + 'A' → 'RER A').
    Returns None if we can't classify (e.g. SNCF Transilien lines, which are
    not in scope for the filter).
    """
    short = (rel_tags.get("short_name") or "").strip()
    ref = (rel_tags.get("ref") or "").strip()
    route = rel_tags.get("route", "")
    name = rel_tags.get("name", "")

    if route == "subway":
        # ref is the line number: 1..14, 3bis, 7bis. Reject Orlyval and other
        # non-numbered subway refs (out of scope per Seed: "M1-M14").
        if not ref:
            return None
        ref_lc = ref.lower().replace(" ", "")
        digits = "".join(c for c in ref_lc if c.isdigit())
        if not digits:
            return None
        try:
            n = int(digits)
        except ValueError:
            return None
        if not (1 <= n <= 14):
            return None
        return f"M{ref_lc}"

    if route == "train":
        # RER lines have name "RER A: ..." or short_name "RER A"
        # Or ref="A" with network tagged "RER"
        # Reject Transilien / other commuter trains.
        nm = name.upper()
        sn = short.upper()
        if sn.startswith("RER ") and len(sn) >= 5:
            return sn[:5]  # "RER A"
        if nm.startswith("RER ") and len(nm) >= 5 and nm[4] in "ABCDE":
            return f"RER {nm[4]}"
        # Fallback: ref alone is a single uppercase letter A..E with network "RER"
        if ref and len(ref) == 1 and ref in "ABCDE":
            return f"RER {ref}"
        return None

    if route == "tram":
        if not ref:
            return None
        ref_lc = ref.lower().replace(" ", "")
        # Some trams encode "T3a"/"T3b" as ref="3a"
        if ref_lc.startswith("t"):
            ref_lc = ref_lc[1:]
        # Filter to T1..T13 (with optional letter suffix like 3a/3b).
        digits = "".join(c for c in ref_lc if c.isdigit())
        if not digits:
            return None
        try:
            n = int(digits)
        except ValueError:
            return None
        if not (1 <= n <= 13):
            return None
        return f"T{ref_lc}"

    return None


# ---------------------------------------------------------------------------
# Build station→lines mapping from one Overpass response
# ---------------------------------------------------------------------------

def build_station_lines(elements: list[dict]) -> dict:
    """Return {(round_lat, round_lng): {"name": str, "lines": set[str]}}.

    Walk every relation, classify its line, then for each member node (only
    members with role like "stop"/"stop_entry_only"/"stop_exit_only"/"" — we
    accept any node member that has coords) attach the line id.
    """
    nodes: dict[int, dict] = {}
    relations: list[dict] = []
    for el in elements:
        if el.get("type") == "node":
            nodes[el["id"]] = el
        elif el.get("type") == "relation":
            relations.append(el)

    station_lines: dict[tuple, dict] = {}

    for rel in relations:
        line_id = normalise_line_id(rel.get("tags", {}))
        if not line_id:
            continue
        for member in rel.get("members", []):
            if member.get("type") != "node":
                continue
            role = (member.get("role") or "").lower()
            # Accept actual stops; skip "platform" nodes which are the same
            # station but shifted; "stop" is the canonical role for boarding
            # nodes. Also accept legacy bare role ("") for older relations.
            if role and not role.startswith("stop") and role not in ("", "halt"):
                continue
            node = nodes.get(member["ref"])
            if not node or "lat" not in node or "lon" not in node:
                continue
            key = (round(node["lat"], 5), round(node["lon"], 5))
            entry = station_lines.setdefault(
                key, {"name": node.get("tags", {}).get("name", ""), "lines": set()}
            )
            entry["lines"].add(line_id)
            # Prefer the longest non-empty name we've seen for diagnostics.
            cand = node.get("tags", {}).get("name", "")
            if cand and len(cand) > len(entry["name"]):
                entry["name"] = cand

    # Stamp serialisable lists, sorted for stable output.
    return {
        k: {"name": v["name"], "lines": sorted(v["lines"], key=_line_sort_key)}
        for k, v in station_lines.items()
    }


def _line_sort_key(line: str) -> tuple:
    """Sort: M1..M14 first, RER A..E next, T1..T13 last."""
    if line.startswith("M"):
        # M3bis, M7bis sort after M3, M7
        rest = line[1:]
        try:
            return (0, int(rest), "")
        except ValueError:
            digits = "".join(c for c in rest if c.isdigit())
            tail = rest[len(digits):]
            return (0, int(digits) if digits else 999, tail)
    if line.startswith("RER"):
        return (1, 0, line)
    if line.startswith("T"):
        rest = line[1:]
        digits = "".join(c for c in rest if c.isdigit())
        tail = rest[len(digits):]
        return (2, int(digits) if digits else 999, tail)
    return (3, 0, line)


# ---------------------------------------------------------------------------
# Coord match against existing idf_stations.json
# ---------------------------------------------------------------------------

def _normalise_name(s: str) -> str:
    """Lowercase + strip diacritics + collapse whitespace/hyphens — matches
    the same shape as keys in idf_stations.json so we can name-join too."""
    s = (s or "").strip().lower()
    s_ascii = "".join(
        c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn"
    )
    # Treat hyphens, slashes, dots as spaces; collapse whitespace.
    out = []
    for c in s_ascii:
        if c in "-/._":
            out.append(" ")
        else:
            out.append(c)
    return " ".join("".join(out).split())


def attach_lines(
    stations: dict,
    station_lines: dict,
    tolerance: float = 0.0020,
    name_tolerance: float = 0.012,
) -> tuple[dict, int]:
    """Return ({alias: [lat, lng, [lines...]]}, miss_count) by joining on
    coord+name and **unioning** lines across all nearby stops.

    Why union and not nearest-only: each métro/RER line has its OWN
    ``stop_position`` node at the same physical station (e.g. Châtelet has
    five separate stop_position nodes, one per line, 50-100m apart). A
    nearest-only match would only return one line. We collect *every* OSM
    stop within ``tolerance`` (~200 m) of the alias coord and union their
    lines — that's the actual line set served at that station.

    Steps:

    1. **Spatial union** — for each alias coord, sweep all stops within
       ``tolerance`` and union their line sets. Most lookups are O(N*M) but
       N*M ≈ 1540*1800 = 2.8M comparisons, done once at build time.
    2. **Name fallback** — if the spatial union came up empty, re-try by
       normalised station name within ``name_tolerance`` (~1 km bound, to
       reject same-name stations on the other side of IDF).
    """
    # Build normalised-name → list[(coord, lines)] index for the name fallback.
    name_index: dict[str, list[tuple[tuple[float, float], list[str]]]] = {}
    stops_with_coord: list[tuple[tuple[float, float], list[str], str]] = []
    for coord, info in station_lines.items():
        norm = _normalise_name(info["name"]) if info["name"] else ""
        stops_with_coord.append((coord, info["lines"], norm))
        if norm:
            name_index.setdefault(norm, []).append((coord, info["lines"]))

    out: dict[str, list] = {}
    miss = 0
    for alias, val in stations.items():
        lat, lng = float(val[0]), float(val[1])
        # Spatial union: collect lines from every OSM stop within tolerance.
        union: set[str] = set()
        for (klat, klng), lns, _norm in stops_with_coord:
            if abs(klat - lat) + abs(klng - lng) <= tolerance:
                union.update(lns)
        # Name union: ALSO include lines from any OSM stop with the SAME
        # normalised name within ``name_tolerance``. This catches lines whose
        # stop_position node is just outside ``tolerance`` (e.g. Châtelet M7
        # at the southern end is ~280 m from the canonical alias coord).
        # Bounded by ``name_tolerance`` to reject same-name stations elsewhere
        # in IDF (rare, but e.g. Pont-de-Neuilly is unique enough).
        norm_alias = _normalise_name(alias)
        candidates = name_index.get(norm_alias) if norm_alias else None
        if candidates:
            for (klat, klng), lns in candidates:
                if abs(klat - lat) + abs(klng - lng) <= name_tolerance:
                    union.update(lns)
        if not union:
            miss += 1
        out[alias] = [lat, lng, sorted(union, key=_line_sort_key)]
    return out, miss


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    p.add_argument(
        "--in",
        dest="infile",
        default=os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
            "container/skills/paris-rental-watch/idf_stations.json",
        ),
    )
    p.add_argument("--out", dest="outfile", default=None, help="defaults to in-place")
    p.add_argument(
        "--cache",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".overpass_cache.json"),
        help="cache the raw Overpass response so re-runs don't re-fetch",
    )
    p.add_argument("--no-cache", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    with open(args.infile, "r", encoding="utf-8") as f:
        stations = json.load(f)
    print(f"loaded {len(stations)} alias keys from {args.infile}", file=sys.stderr)

    if not args.no_cache and os.path.exists(args.cache):
        print(f"using cached Overpass response: {args.cache}", file=sys.stderr)
        with open(args.cache, "r", encoding="utf-8") as f:
            resp = json.load(f)
    else:
        print("fetching IDF route relations from Overpass …", file=sys.stderr)
        resp = overpass(QUERY_ALL_LINES)
        if not args.no_cache:
            with open(args.cache, "w", encoding="utf-8") as f:
                json.dump(resp, f)

    elements = resp.get("elements", [])
    print(f"  {len(elements)} elements returned", file=sys.stderr)

    station_lines = build_station_lines(elements)
    print(f"  {len(station_lines)} unique stop coords with line membership", file=sys.stderr)

    out, miss = attach_lines(stations, station_lines)
    print(
        f"  attached lines to {len(out) - miss}/{len(out)} alias entries "
        f"({miss} unmatched, will get [])",
        file=sys.stderr,
    )

    target = args.outfile or args.infile
    if args.dry_run:
        print(f"(dry-run) would write {target}", file=sys.stderr)
        return 0
    with open(target, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(", ", ": "))
        f.write("\n")
    print(f"wrote {target}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
