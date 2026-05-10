#!/usr/bin/env python3
"""
One-time backfill of `rooms` (T1/T2/T3/T4+/unknown) and `meuble`
(meuble/non/unknown) fields onto the existing listings.jsonl file, so the
new sidebar filters in paris-realestate.html operate on historical data
immediately.

Why rule-based, not LLM:
  - classify_rules.md specifies exact keyword lists with explicit
    priority/conflict rules. The two new axes are *metadata-only* (do not
    affect verdict), so deterministic regex extraction matches the spec
    1:1 and avoids 182 LLM round-trips.
  - Future incoming listings will continue to use the LLM classifier
    (per SKILL.md / classify_rules.md). This script only patches the
    existing 182.

Source of truth for patterns:
  container/skills/paris-rental-watch/classify_rules.md  →
    "방수 (rooms) 추출 가이드"
    "가구 유무 (meublé) 추출 가이드"

Usage:
  python3 scripts/paris-rental/backfill_rooms_meuble.py [--listings PATH]
                                                         [--dry-run]
                                                         [--no-backup]

Default LISTINGS path mirrors SKILL.md: $PUBLIC_DIR/listings.jsonl,
which is `~/webdav-data/public/paris-rental/listings.jsonl` on the
host.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
import unicodedata
from collections import Counter
from typing import Iterable


DEFAULT_LISTINGS = os.path.expanduser(
    "~/webdav-data/public/paris-rental/listings.jsonl"
)


# ---------------------------------------------------------------------------
# Text normalization helpers
# ---------------------------------------------------------------------------

def _strip_diacritics(s: str) -> str:
    """Strip combining accents for accent-insensitive Latin matching.

    NFKD decomposes Hangul syllables into Jamo (e.g. `방` → `방`), which
    would break Korean keyword patterns like `방\\s*3`. We therefore strip
    only combining marks and then recompose with NFC so Hangul reassembles
    while accented Latin letters stay flattened (e.g. `é` → `e`).
    """
    decomposed = unicodedata.normalize("NFKD", s)
    no_marks = "".join(c for c in decomposed if not unicodedata.combining(c))
    return unicodedata.normalize("NFC", no_marks)


def _norm(s: str) -> str:
    """Lowercase + strip diacritics; preserve hyphens/spaces for word patterns."""
    return _strip_diacritics(s or "").lower()


# ---------------------------------------------------------------------------
# Rooms extraction (T1 / T2 / T3 / T4+ / unknown)
# ---------------------------------------------------------------------------
#
# Priority (per classify_rules.md):
#   1. Explicit T-code (T1/T2/...) > Korean word > area inference (skipped)
#   2. Multiple matches → take the LARGEST (e.g. "T2 또는 T3" → T3)
#   3. T4 and above all collapse to "T4+"
#   4. studio + metro name simultaneously → studio (T1)
#   5. Area-only with no rooms keyword → "unknown" (no inference)
#
# We detect every bucket independently, then pick max present. T1 only
# wins if no T2/T3/T4+ match (which matches "studio + metro" rule —
# studio sets T1, but if "T2" is also there, T2 wins; the spec only
# says studio doesn't get demoted by the metro name).

# Word-boundary helper: \b is unicode-friendly in `re.UNICODE` (default in py3),
# but T-codes / Korean often abut other chars; use explicit non-letter lookarounds.
_NB = r"(?:^|(?<=[^A-Za-z0-9가-힣]))"  # non-boundary-left
_NA = r"(?:$|(?=[^A-Za-z0-9가-힣]))"   # non-boundary-right


def _bp(*alternatives: str) -> re.Pattern:
    """Build a bordered alternation regex for the given literal alternatives."""
    body = "|".join(re.escape(a) for a in alternatives)
    return re.compile(f"{_NB}(?:{body}){_NA}", re.IGNORECASE)


# T1: studio / 1P / T1 / 원룸 / 스튜디오 / studette / 메블레 1P / 1.5룸 / 1 piece
_T1_RX = [
    _bp("T1", "T 1", "1P", "F1"),
    _bp("studio", "studette"),
    re.compile(r"1\s*pi[eè]ces?", re.IGNORECASE),
    _bp("스튜디오", "원룸", "스튀데트", "1.5룸"),
    re.compile(r"메블레\s*1P", re.IGNORECASE),
]

# T2: T2 / 2P / 2 pièces / 1 chambre + 1 séjour / 2 chambres / 투룸 / 방 2 / 1BR / F2
_T2_RX = [
    _bp("T2", "T 2", "2P", "F2", "1BR", "1 BR"),
    re.compile(r"2\s*pi[eè]ces?", re.IGNORECASE),
    re.compile(r"2\s*chambres?\b", re.IGNORECASE),
    re.compile(r"1\s*chambre\s*\+\s*1\s*s[eé]jour", re.IGNORECASE),
    re.compile(r"1\s*bedroom\b", re.IGNORECASE),
    _bp("투룸", "2룸", "방2"),
    re.compile(r"방\s*2(?!\d)"),  # 방 2 / 방2 — but not 방 20
]

# T3: T3 / 3P / 3 pièces / 2 chambres + séjour / 쓰리룸 / 방 3 / 2BR / F3
_T3_RX = [
    _bp("T3", "T 3", "3P", "F3", "2BR", "2 BR"),
    re.compile(r"3\s*pi[eè]ces?", re.IGNORECASE),
    re.compile(r"3\s*chambres?\b", re.IGNORECASE),
    re.compile(r"2\s*chambres?\s*\+\s*s[eé]jour", re.IGNORECASE),
    re.compile(r"2\s*bedrooms?\b", re.IGNORECASE),
    _bp("쓰리룸", "3룸", "방3"),
    re.compile(r"방\s*3(?!\d)"),
]

# T4+: T4/T5/T6 / 4P/5P / 4-5 pièces / 4 chambres+ / 포룸 / 4룸+ / 방 4/방 5 / 3BR+ / F4/F5
_T4PLUS_RX = [
    _bp("T4", "T 4", "T5", "T6", "4P", "5P", "F4", "F5"),
    re.compile(r"[4-9]\s*pi[eè]ces?", re.IGNORECASE),
    re.compile(r"[4-9]\s*chambres?\b", re.IGNORECASE),
    re.compile(r"[3-9]\s*bedrooms?\b", re.IGNORECASE),
    _bp("포룸"),
    # Digit/decimal-boundary on the leading digit so `5룸` matches but `1.5룸` does not.
    re.compile(r"(?<![\d.])4룸\s*이상|(?<![\d.])4룸\+|(?<![\d.])5룸|(?<![\d.])6룸"),
    re.compile(r"방\s*[4-9](?!\d)"),
    re.compile(r"3\s*BR\+", re.IGNORECASE),
    re.compile(r"duplex\s*4P", re.IGNORECASE),
]


def extract_rooms(text: str) -> str:
    """Return one of: 'T1', 'T2', 'T3', 'T4+', 'unknown'.

    Uses normalized (deaccented, lowercased) text. Picks the LARGEST
    matching bucket if multiple are present.
    """
    if not text:
        return "unknown"
    t = _norm(text)

    has_t1 = any(rx.search(t) for rx in _T1_RX)
    has_t2 = any(rx.search(t) for rx in _T2_RX)
    has_t3 = any(rx.search(t) for rx in _T3_RX)
    has_t4 = any(rx.search(t) for rx in _T4PLUS_RX)

    # Priority: largest wins (T4+ > T3 > T2 > T1)
    if has_t4:
        return "T4+"
    if has_t3:
        return "T3"
    if has_t2:
        return "T2"
    if has_t1:
        return "T1"
    return "unknown"


# ---------------------------------------------------------------------------
# Meublé extraction (meuble / non / unknown)
# ---------------------------------------------------------------------------
#
# Priority (per classify_rules.md):
#   1. Check NEGATIVE patterns FIRST (`non meublé`, `vide`, `가구 없음`).
#   2. `bail meublé` is a long-term-lease marker; if `bail vide` /
#      `location vide` is also explicitly stated → "non" wins.
#   3. Both meublé and vide present → "unknown" (contradictory).
#   4. Furniture nouns alone (canapé, lit, 소파) → "unknown" (model-home risk).
#   5. semi-meublé / 부분 가구 → "meuble".
#
# Implementation:
#   - Find any negative match.
#   - Find any positive match.
#   - Both → "unknown"; neither → "unknown"; one → that side.
#
# We do NOT include bare "nu" as a negative marker (huge false-positive
# risk in mixed-language text); the explicit "non meublé / vide / 가구 없음"
# patterns cover real cases.

_NEG_RX = [
    re.compile(r"non[\s\-]*meubl(?:e|ee|ees|é|ée|ées)\b", re.IGNORECASE),
    re.compile(r"non[\s\-]*furnished\b", re.IGNORECASE),
    re.compile(r"unfurnished\b", re.IGNORECASE),
    re.compile(r"\bbail\s+vide\b", re.IGNORECASE),
    re.compile(r"\blocation\s+vide\b", re.IGNORECASE),
    re.compile(r"\bvide\b", re.IGNORECASE),  # standalone vide (after non-meublé patterns)
    re.compile(r"가구\s*없(음|어|이|는)"),
    re.compile(r"빈집"),
    re.compile(r"공실"),
    re.compile(r"옵션\s*없(음|어|이|는)"),
]

_POS_RX = [
    re.compile(r"meubl(?:e|ee|ees|é|ée|ées)\b", re.IGNORECASE),  # meublé family
    re.compile(r"\bfurnished\b", re.IGNORECASE),
    re.compile(r"fully\s+furnished\b", re.IGNORECASE),
    re.compile(r"가구\s*포함"),
    re.compile(r"풀옵션"),
    re.compile(r"풀퍼니시드"),
    re.compile(r"옵션\s*포함"),
    re.compile(r"메블레"),
    re.compile(r"semi[\s\-]*meubl(?:e|é|ée)", re.IGNORECASE),
    re.compile(r"세미\s*메블레"),
]


def extract_meuble(text: str) -> str:
    """Return one of: 'meuble', 'non', 'unknown'.

    Negative patterns are evaluated first. If text has BOTH negative and
    positive markers (after excluding the overlap where the positive match
    is contained inside a negative match like 'non meublé'), the result
    is 'unknown' (contradictory listing — needs human review).
    """
    if not text:
        return "unknown"
    t = _norm(text)

    neg_spans: list[tuple[int, int]] = []
    for rx in _NEG_RX:
        for m in rx.finditer(t):
            neg_spans.append(m.span())
    has_neg = bool(neg_spans)

    # Positive matches that are NOT contained inside any negative span
    # (so 'meublé' inside 'non meublé' doesn't count as a positive).
    has_pos = False
    for rx in _POS_RX:
        for m in rx.finditer(t):
            s, e = m.span()
            inside_neg = any(ns <= s and e <= ne for ns, ne in neg_spans)
            if not inside_neg:
                has_pos = True
                break
        if has_pos:
            break

    if has_neg and has_pos:
        return "unknown"
    if has_neg:
        return "non"
    if has_pos:
        return "meuble"
    return "unknown"


# ---------------------------------------------------------------------------
# I/O + main
# ---------------------------------------------------------------------------

def _ordered_listing(listing: dict, rooms: str, meuble: str) -> dict:
    """Return a new dict with `rooms` inserted right after `area_m2` and
    `meuble` right after `price_unit`, falling back to appending if the
    anchor key is absent. Preserves all original fields and ordering."""
    out: dict = {}
    inserted_rooms = False
    inserted_meuble = False
    for k, v in listing.items():
        out[k] = v
        if k == "area_m2" and not inserted_rooms:
            out["rooms"] = rooms
            inserted_rooms = True
        if k == "price_unit" and not inserted_meuble:
            out["meuble"] = meuble
            inserted_meuble = True
    if not inserted_rooms:
        out["rooms"] = rooms
    if not inserted_meuble:
        out["meuble"] = meuble
    return out


def _read_jsonl(path: str) -> list[dict]:
    out: list[dict] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            out.append(json.loads(line))
    return out


def _write_jsonl_atomic(path: str, listings: Iterable[dict]) -> None:
    tmp = f"{path}.tmp.{int(time.time())}"
    with open(tmp, "w", encoding="utf-8") as f:
        for l in listings:
            f.write(json.dumps(l, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--listings", default=DEFAULT_LISTINGS,
                    help=f"Path to listings.jsonl (default: {DEFAULT_LISTINGS})")
    ap.add_argument("--dry-run", action="store_true",
                    help="Compute fields but don't write the file. Print summary only.")
    ap.add_argument("--no-backup", action="store_true",
                    help="Skip writing a .before-rooms-meuble.bak alongside the file.")
    args = ap.parse_args(argv)

    if not os.path.exists(args.listings):
        print(f"ERROR: listings file not found: {args.listings}", file=sys.stderr)
        return 2

    listings = _read_jsonl(args.listings)
    print(f"Loaded {len(listings)} listings from {args.listings}")

    rooms_counter: Counter = Counter()
    meuble_counter: Counter = Counter()
    already_had_rooms = 0
    already_had_meuble = 0
    samples = []  # (rooms, meuble, title) for first 10

    new_listings: list[dict] = []
    for l in listings:
        had_r = "rooms" in l
        had_m = "meuble" in l
        already_had_rooms += int(had_r)
        already_had_meuble += int(had_m)

        text_for_extract = "  ".join([l.get("title", ""), l.get("raw_body_excerpt", "")])
        rooms = l.get("rooms") or extract_rooms(text_for_extract)
        meuble = l.get("meuble") or extract_meuble(text_for_extract)
        rooms_counter[rooms] += 1
        meuble_counter[meuble] += 1
        if len(samples) < 10:
            samples.append((rooms, meuble, l.get("title", "")[:60]))

        new_listings.append(_ordered_listing(l, rooms=rooms, meuble=meuble))

    # ---- Verification: every listing must have both keys present ----
    missing_rooms = [i for i, l in enumerate(new_listings) if "rooms" not in l]
    missing_meuble = [i for i, l in enumerate(new_listings) if "meuble" not in l]
    if missing_rooms or missing_meuble:
        print(f"ERROR: post-process gap — missing rooms in {len(missing_rooms)}, "
              f"missing meuble in {len(missing_meuble)}", file=sys.stderr)
        return 3

    print()
    print(f"Pre-existing rooms field: {already_had_rooms}/{len(listings)}")
    print(f"Pre-existing meuble field: {already_had_meuble}/{len(listings)}")
    print()
    print("Rooms distribution after backfill:")
    for k in ("T1", "T2", "T3", "T4+", "unknown"):
        print(f"  {k:8s}: {rooms_counter.get(k, 0):4d}")
    print()
    print("Meublé distribution after backfill:")
    for k in ("meuble", "non", "unknown"):
        print(f"  {k:8s}: {meuble_counter.get(k, 0):4d}")
    print()
    print("Sample of first 10 (rooms | meuble | title):")
    for r, m, t in samples:
        print(f"  {r:8s} | {m:8s} | {t}")

    if args.dry_run:
        print("\n[dry-run] not writing")
        return 0

    if not args.no_backup:
        backup_path = f"{args.listings}.before-rooms-meuble.bak"
        shutil.copy2(args.listings, backup_path)
        print(f"\nBackup written: {backup_path}")

    _write_jsonl_atomic(args.listings, new_listings)
    print(f"Wrote {len(new_listings)} listings → {args.listings}")

    # ---- Final on-disk verification (round-trip) ----
    reread = _read_jsonl(args.listings)
    bad = [i for i, l in enumerate(reread)
           if "rooms" not in l or "meuble" not in l]
    if bad:
        print(f"ERROR: on-disk verification failed for {len(bad)} listings",
              file=sys.stderr)
        return 4
    print(f"Verified: 100% of {len(reread)} listings have both `rooms` and "
          f"`meuble` fields on disk.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
