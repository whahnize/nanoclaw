#!/usr/bin/env python3
"""
PapRentalCFBypassMigration — AC 4 (Step 2-C cron simulator).

Runs the deterministic Sections 0-2, 5, 6 of
container/skills/paris-rental-watch/SKILL.md against a temp state copy,
exclusively focused on the new pap source (Source C).  Section 3
(LLM classify) is stubbed as "reject" so the harness can prove the
machinery wires up end-to-end without API credentials and without
sending Discord alerts.

Run inside the container:
    docker run --rm -i \
        -e CF_FETCH_SIDECAR_URL=http://host.docker.internal:8765 \
        --add-host=host.docker.internal:host-gateway \
        -v /tmp/cron-sim-2c:/workspace/sim \
        -v <project>/container/skills/paris-rental-watch:/skill:ro \
        -v <project>/container/skills/web-fetch:/opt/web-fetch:ro \
        --entrypoint python3 \
        nanoclaw-agent:latest \
        /workspace/sim/cron_sim.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone

# --- Config (mirrors SKILL.md Config block / Source C) -----------------------
SKILL_DIR             = "/skill"
STATE                 = "/workspace/sim/.paris-rental-seen.json"
LEGACY_STATE          = "/workspace/sim/.francezone_seen.json"
PAP_BASE_URL          = "https://www.pap.fr/annonce/locations-appartement-paris-75-g439"
PAP_MAX_PAGES         = 50
PAP_PRICE_MAX         = 1800
PAP_SURFACE_MIN       = 30
PAP_FETCH_TIMEOUT_S   = 120
PAP_PAGE_DELAY_S      = 2
PAP_FAILURE_THRESHOLD = 3

DISCORD_JID = "dc:1485303434541273220"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def log(msg: str) -> None:
    print(f"[cron-sim] {msg}", flush=True)


# --- Section 0: legacy-state migration (defensive — production state already
# migrated, this is a no-op when LEGACY_STATE is absent) ----------------------
def section0_legacy_migration() -> None:
    if os.path.exists(LEGACY_STATE) and not os.path.exists(STATE):
        log("legacy state migration triggered (would not happen on prod)")
        with open(LEGACY_STATE) as fh:
            o = json.load(fh)
        with open(STATE, "w") as fh:
            json.dump(
                {
                    "seen_post_ids": [
                        f"francezone-bbs2:{p}" for p in o.get("seen_post_ids", [])
                    ],
                    "last_check": o.get("last_check"),
                    "last_check_by_source": {
                        "francezone-bbs2": o.get("last_check"),
                        "francezone-bbs3": None,
                        "pap": None,
                    },
                    "rate_limit_attempt": 0,
                    "backfilled_at": o.get("backfilled_at"),
                    "pap_failure_last_alert": None,
                    "pap_consec_failures": 0,
                    "pap_last_failure_reason": None,
                },
                fh, ensure_ascii=False, indent=2,
            )
        os.rename(LEGACY_STATE, LEGACY_STATE + ".bak")
    else:
        log("Section 0: legacy state migration not needed (already migrated)")


# --- Section 1: state load + setdefault for AC-2 keys ------------------------
def section1_load_state() -> tuple[dict, set[str]]:
    with open(STATE) as fh:
        state = json.load(fh)
    seen: set[str] = set(state["seen_post_ids"])
    state.setdefault("pap_consec_failures", 0)
    state.setdefault("pap_last_failure_reason", None)
    state.setdefault("pap_failure_last_alert", None)
    log(
        f"Section 1: loaded state — seen={len(seen)} "
        f"pap_consec_failures={state['pap_consec_failures']} "
        f"pap_last_failure_reason={state['pap_last_failure_reason']!r}"
    )
    return state, seen


# --- Section 2C: pap.fr direct via web-fetch ---------------------------------
def section2c_pap_polling(state: dict, seen: set[str]):
    pap_pages_done = 0
    pap_total_cards = 0
    pap_pre_filtered_out = 0
    pap_skipped_seen = 0
    pap_failure_reason = None
    pap_failed_first_page = False
    pap_new_listings: list[dict] = []

    log("Section 2C: starting pap.fr polling")

    for page in range(1, PAP_MAX_PAGES + 1):
        url = PAP_BASE_URL if page == 1 else f"{PAP_BASE_URL}-{page}"
        log(f"  page {page} fetch start url={url}")
        try:
            proc = subprocess.run(
                ["web-fetch", "--output", "html",
                 "--timeout", str(PAP_FETCH_TIMEOUT_S),
                 "--quiet", url],
                capture_output=True, text=True,
                timeout=PAP_FETCH_TIMEOUT_S + 15,
            )
        except subprocess.TimeoutExpired as e:
            pap_failure_reason = f"page {page} subprocess timeout: {e}"
            log(f"  page {page} TIMEOUT: {e}")
            if page == 1:
                pap_failed_first_page = True
            break
        if proc.returncode != 0:
            pap_failure_reason = (
                f"page {page} web-fetch rc={proc.returncode}: "
                f"{(proc.stderr or '').strip()[:200]}"
            )
            log(f"  page {page} web-fetch rc={proc.returncode}")
            if page == 1:
                pap_failed_first_page = True
            break
        log(f"  page {page} web-fetch ok html_len={len(proc.stdout)}")

        parsed = subprocess.run(
            ["python3", f"{SKILL_DIR}/parse_pap.py", "list"],
            input=proc.stdout, capture_output=True, text=True, timeout=20,
        )
        if parsed.returncode != 0:
            pap_failure_reason = (
                f"page {page} parse_pap rc={parsed.returncode}: "
                f"{(parsed.stderr or '').strip()[:200]}"
            )
            log(f"  page {page} parse_pap rc={parsed.returncode}")
            if page == 1:
                pap_failed_first_page = True
            break
        try:
            cards = json.loads(parsed.stdout or "[]")
        except json.JSONDecodeError as e:
            pap_failure_reason = f"page {page} parse_pap JSON decode: {e}"
            log(f"  page {page} parse_pap json decode error: {e}")
            if page == 1:
                pap_failed_first_page = True
            break

        log(f"  page {page} parsed cards={len(cards)}")
        if not cards:
            log(f"  page {page} empty — end of pagination")
            break
        pap_pages_done += 1
        pap_total_cards += len(cards)

        for c in cards:
            nid = f"pap:{c['pap_id']}"
            if nid in seen:
                pap_skipped_seen += 1
                continue
            price = c.get("price_eur")
            surface = c.get("surface_m2")
            rooms = c.get("rooms")
            if price and price > PAP_PRICE_MAX:
                pap_pre_filtered_out += 1
                continue
            if surface and surface < PAP_SURFACE_MIN:
                pap_pre_filtered_out += 1
                continue
            if rooms == 1 and (surface is None or surface < PAP_SURFACE_MIN):
                pap_pre_filtered_out += 1
                continue
            # Geocode — defer to Paris centroid in dry-run to keep the
            # simulator fast and offline-stable. The real skill calls
            # geocode.py here; the wiring is identical.
            g = {"lat": 48.8566, "lng": 2.3522, "source": "fallback"}
            pap_new_listings.append({
                "source": "pap",
                "post_id": c["pap_id"],
                "namespaced_id": nid,
                "title": c["title"],
                "url": c["detail_url"],
                "fetched_at": now_iso(),
                "post_date": "",
                "price_eur_card": price,
                "surface_m2_card": surface,
                "rooms_card": rooms,
                "tags": c.get("tags", []),
                "location_text": c.get("location_text", ""),
                "description": c.get("description", ""),
                "photo_url": c.get("photo_url", ""),
                "lat": g["lat"], "lng": g["lng"],
                "geocode_source": g["source"],
            })

        time.sleep(PAP_PAGE_DELAY_S)

    if pap_pages_done > 0:
        state["pap_consec_failures"] = 0
        state["pap_last_failure_reason"] = None
    elif pap_failed_first_page or pap_failure_reason:
        state["pap_consec_failures"] = state.get("pap_consec_failures", 0) + 1
        state["pap_last_failure_reason"] = (pap_failure_reason or "?")[:300]
    else:
        state["pap_consec_failures"] = 0
        state["pap_last_failure_reason"] = None

    return {
        "pages_done": pap_pages_done,
        "total_cards": pap_total_cards,
        "pre_filtered_out": pap_pre_filtered_out,
        "skipped_seen": pap_skipped_seen,
        "new_listings": pap_new_listings,
        "failure_reason": pap_failure_reason,
        "failed_first_page": pap_failed_first_page,
    }


# --- Section 3 stub: LLM classify replaced with deterministic "reject" -------
def stub_classify_all(new_listings: list[dict], seen: set[str]) -> dict:
    """Replace LLM classification with a deterministic stub so the cron
    sim can validate the post-classify branches (`seen.add`, state commit)
    without API credentials. We mark every candidate as `reject` — the
    same code path the real skill takes for ads outside the buyer's box."""
    rejected = 0
    for entry in new_listings:
        nid = entry["namespaced_id"]
        # verdict = classify(entry)  # real call
        verdict = {"verdict": "reject"}
        if verdict["verdict"] == "reject":
            seen.add(nid)
            rejected += 1
            continue
        # process_and_alert(...) — never taken in stub
        seen.add(nid)
    return {"rejected": rejected}


# --- Section 5: state commit -------------------------------------------------
def section5_commit(state: dict, seen: set[str]) -> None:
    state["seen_post_ids"] = sorted(seen, reverse=True)
    state["last_check"] = now_iso()
    state.setdefault("last_check_by_source", {})
    state["last_check_by_source"]["pap"] = now_iso()
    with open(STATE, "w") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=2)
    log(f"Section 5: committed state — seen_post_ids={len(seen)}")


# --- Section 6: pap failure-alert check (dry — would call send_message) ------
def section6_alert_check(state: dict) -> dict:
    consec = state.get("pap_consec_failures", 0)
    info = {"consec_failures": consec, "would_alert": False, "reason": None}
    if consec >= PAP_FAILURE_THRESHOLD:
        last_alert = state.get("pap_failure_last_alert")
        from datetime import datetime as dt
        now_dt = dt.now(timezone.utc)
        cooled = True
        if last_alert:
            try:
                t = dt.fromisoformat(last_alert)
                cooled = (now_dt - t).total_seconds() > 86400
            except Exception:
                cooled = True
        if cooled:
            info["would_alert"] = True
            info["reason"] = state.get("pap_last_failure_reason") or "?"
            log(f"  Section 6: would alert {DISCORD_JID} — {info['reason']}")
            # state["pap_failure_last_alert"] = now_iso()  # not committed in dry sim
    log(f"Section 6: consec={consec} would_alert={info['would_alert']}")
    return info


def main() -> int:
    summary = {
        "started_at": now_iso(),
        "pap": None,
        "stub": None,
        "alert": None,
        "errors": [],
        "exit_code": 0,
    }
    try:
        section0_legacy_migration()
        state, seen = section1_load_state()

        before_seen = len(seen)
        pap = section2c_pap_polling(state, seen)
        summary["pap"] = {
            "pages_done": pap["pages_done"],
            "total_cards": pap["total_cards"],
            "skipped_seen": pap["skipped_seen"],
            "pre_filtered_out": pap["pre_filtered_out"],
            "new_listings_count": len(pap["new_listings"]),
            "failure_reason": pap["failure_reason"],
            "failed_first_page": pap["failed_first_page"],
        }

        stub = stub_classify_all(pap["new_listings"], seen)
        summary["stub"] = stub

        # Section 4 (map rebuild) — only triggers when a real classify produces
        # `pass`/`maybe`. The stub rejects everything, so the real skill would
        # skip render_map.py here too. Logged for evidence.
        log("Section 4: skip render_map (no listings passed stub classifier)")

        section5_commit(state, seen)
        summary["alert"] = section6_alert_check(state)

        summary["after_seen"] = len(seen)
        summary["delta_seen"] = len(seen) - before_seen
        summary["finished_at"] = now_iso()
    except Exception as e:
        tb = traceback.format_exc()
        log(f"FATAL: {e}\n{tb}")
        summary["errors"].append({"type": type(e).__name__, "msg": str(e), "tb": tb})
        summary["exit_code"] = 1

    print("---CRON-SIM-RESULT-START---")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print("---CRON-SIM-RESULT-END---")
    return summary["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
