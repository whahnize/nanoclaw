#!/bin/bash
# Install / uninstall / status for the cf-fetch-server launchd job.
#
# Usage:
#   ./install.sh install     # generate plist, load (auto-starts via RunAtLoad)
#   ./install.sh uninstall   # unload + remove plist
#   ./install.sh status      # show current launchctl state
#   ./install.sh restart     # bounce the job
#   ./install.sh run         # run server.py in foreground (debug)

set -euo pipefail

LABEL="com.nanoclaw.cf-fetch-server"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE="$SCRIPT_DIR/launchd.plist.template"

# Pick a python interpreter.
#
# IMPORTANT (macOS TCC): /usr/bin/python3 is the CommandLineTools python and
# launchd-spawned processes from that binary are denied read access to files
# under ~/Desktop/, ~/Documents/, ~/Downloads/ (TCC blocks with EPERM). The
# repo lives at ~/Desktop/nanoclaw/, so we avoid /usr/bin/python3.
#
# IMPORTANT (Sub-AC 1.1.2): the warm browser backend requires `nodriver` and
# `pyvirtualdisplay`. Homebrew's /opt/homebrew/bin/python3 is externally
# managed (PEP 668) and refuses pip install, so the practical interpreter is
# /opt/homebrew/Caskroom/miniconda/base/bin/python3 (or any unmanaged venv
# the user points at via PYTHON=). We prefer an interpreter that already has
# nodriver importable; if nothing matches we fall back to the first viable
# python3 and the sidecar runs in stub mode (launchd persistence preserved).
_has_nodriver() {
  local py="$1"
  [[ -x "$py" ]] || return 1
  "$py" -c "import nodriver" >/dev/null 2>&1
}

# Venv lives in ~/Library/Caches (Apple's blessed cache dir) — NOT under
# ~/Desktop where pyvenv.cfg reads would be TCC-blocked when the launchd
# job spawns the interpreter. macOS 26 enforces this strictly: a venv
# placed under ~/Desktop hangs the python startup in __open_nocancel
# while reading pyvenv.cfg.
CACHE_ROOT="${CF_FETCH_CACHE_ROOT:-$HOME/Library/Caches/com.nanoclaw.cf-fetch-server}"
VENV_DIR="${CF_FETCH_VENV_DIR:-$CACHE_ROOT/venv}"
VENV_PY="$VENV_DIR/bin/python"
# We copy server.py into the cache dir at install time. The launchd job runs
# this copy — never the in-repo source — because the in-repo path lives under
# ~/Desktop and macOS 26 TCC silently denies launchd-spawned processes from
# reading there (request hangs forever waiting for a consent dialog that
# never shows under the launchd background context). Cache dir is TCC-safe.
CACHE_SERVER="$CACHE_ROOT/server.py"

# `bootstrap_venv` creates the venv from /opt/homebrew/bin/python3 and
# pip-installs nodriver+pyvirtualdisplay. Homebrew Python is PEP 668
# externally-managed so we can't pip-install into it directly, hence the
# venv. nodriver 0.46 is the last release whose CDP-typed code parses
# cleanly on Python 3.14 *and* whose Browser.get(...) actually returns a
# usable Tab — 0.40 had a None-unpacking bug, 0.48 has a non-utf8 source
# file (network.py SyntaxError on 3.14).
bootstrap_venv() {
  local base_py="/opt/homebrew/bin/python3"
  if [[ ! -x "$base_py" ]]; then
    base_py="$(command -v python3 || true)"
  fi
  if [[ -z "$base_py" || ! -x "$base_py" ]]; then
    echo "ERROR: no base python3 to bootstrap venv (set PYTHON= or install Homebrew python)" >&2
    return 1
  fi
  echo "[OK] bootstrapping venv at $VENV_DIR from $base_py"
  mkdir -p "$(dirname "$VENV_DIR")"
  "$base_py" -m venv "$VENV_DIR"
  "$VENV_PY" -m pip install --quiet --upgrade pip
  "$VENV_PY" -m pip install --quiet "nodriver==0.46" pyvirtualdisplay
}

if [[ -n "${PYTHON:-}" ]]; then
  :  # explicit override — trust the operator
else
  # ALWAYS prefer the cache-located venv. It is the only Python we know
  # works under launchd on macOS 26 — system pythons under ~/Desktop's
  # WorkingDirectory hit TCC issues, and miniconda's base interpreter
  # itself hangs in __open_nocancel during interpreter startup under
  # launchd. The venv lives outside ~/Desktop so it sidesteps both.
  if ! _has_nodriver "$VENV_PY" && [[ "${CF_FETCH_NO_VENV:-0}" != "1" ]]; then
    bootstrap_venv || true
  fi
  if _has_nodriver "$VENV_PY"; then
    PYTHON="$VENV_PY"
  else
    # Bootstrap failed — degrade to any working python3 so the launchd
    # job can still load (sidecar stub mode preserves Verifications D/H).
    CANDIDATES=(
      "/opt/homebrew/bin/python3"
      "/opt/homebrew/Caskroom/miniconda/base/bin/python3"
      "/usr/local/bin/python3"
    )
    PYTHON=""
    for cand in "${CANDIDATES[@]}"; do
      if [[ -x "$cand" ]]; then
        PYTHON="$cand"
        break
      fi
    done
    if [[ -z "$PYTHON" ]]; then
      PYTHON="$(command -v python3 || true)"
    fi
  fi
fi
if [[ -z "$PYTHON" || ! -x "$PYTHON" ]]; then
  echo "ERROR: no python3 found (set PYTHON=/path or install via Homebrew)" >&2
  exit 1
fi
if _has_nodriver "$PYTHON"; then
  PYTHON_BACKEND="nodriver"
else
  PYTHON_BACKEND="stub (install with: $PYTHON -m pip install nodriver pyvirtualdisplay)"
fi

cmd="${1:-status}"

case "$cmd" in
  install)
    if [[ ! -f "$TEMPLATE" ]]; then
      echo "ERROR: template not found at $TEMPLATE" >&2
      exit 1
    fi
    if [[ ! -f "$SCRIPT_DIR/server.py" ]]; then
      echo "ERROR: server.py not found at $SCRIPT_DIR/server.py" >&2
      exit 1
    fi
    mkdir -p "$(dirname "$PLIST_DST")"
    # Stage server.py into the TCC-safe cache dir so the launchd job never
    # has to read from ~/Desktop at runtime.
    mkdir -p "$CACHE_ROOT"
    cp -f "$SCRIPT_DIR/server.py" "$CACHE_SERVER"
    chmod 0644 "$CACHE_SERVER"

    # Resolve webshare proxy creds at install time from ~/Desktop/.env (which
    # we CAN read here because install.sh runs in the user's interactive
    # context with TCC consent) and pass them through the launchd plist
    # EnvironmentVariables — same as documented in the Seed ontology
    # (credential_flow.loaded_by = "launchd plist EnvironmentVariables").
    # The plist file lives under ~/Library/LaunchAgents (host-only, never
    # mounted into the container) so the credentials still satisfy the
    # constraint that they "never enter the container".
    HTTP_PROXY_URL_VALUE=""
    if [[ -f "$REPO_ROOT/.env" ]]; then
      HTTP_PROXY_URL_VALUE="$(grep -E '^[[:space:]]*HTTP_PROXY_URL=' "$REPO_ROOT/.env" \
        | tail -1 \
        | sed -E 's/^[[:space:]]*HTTP_PROXY_URL=//;s/^"(.*)"$/\1/;s/^'"'"'(.*)'"'"'$/\1/' \
        || true)"
    fi
    # XML-escape for the plist (& < > " ').
    HTTP_PROXY_URL_XML="$(printf '%s' "$HTTP_PROXY_URL_VALUE" \
      | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
            -e 's/"/\&quot;/g' -e "s/'/\&apos;/g")"

    sed -e "s#__REPO_ROOT__#$REPO_ROOT#g" \
        -e "s#__PYTHON__#$PYTHON#g" \
        -e "s#__SERVER_PY__#$CACHE_SERVER#g" \
        -e "s#__HTTP_PROXY_URL__#$HTTP_PROXY_URL_XML#g" \
        "$TEMPLATE" > "$PLIST_DST"
    chmod 0600 "$PLIST_DST"   # plist may contain proxy credentials

    # Bootstrap (modern launchctl) — fall back to load if bootstrap unavailable
    if launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; then
      :  # was loaded; bootout to allow clean re-bootstrap
    fi
    if launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" 2>/dev/null; then
      echo "[OK] bootstrapped $LABEL"
    else
      launchctl unload "$PLIST_DST" 2>/dev/null || true
      launchctl load "$PLIST_DST"
      echo "[OK] loaded $LABEL (legacy)"
    fi
    echo "[OK] installed at $PLIST_DST"
    echo "[OK] python:    $PYTHON"
    echo "[OK] script:    $CACHE_SERVER"
    echo "[OK] backend:   $PYTHON_BACKEND"
    if [[ -n "$HTTP_PROXY_URL_VALUE" ]]; then
      echo "[OK] proxy:     HTTP_PROXY_URL injected from $REPO_ROOT/.env (host-only)"
    else
      echo "[--] proxy:     HTTP_PROXY_URL not set in $REPO_ROOT/.env (CF bypass disabled)"
    fi
    echo "[OK] logs:      /tmp/cf-fetch-server.log /tmp/cf-fetch-server.err"
    echo "[OK] endpoint:  http://127.0.0.1:8765/fetch?url=<url>"
    ;;

  uninstall)
    if [[ -f "$PLIST_DST" ]]; then
      launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null \
        || launchctl unload "$PLIST_DST" 2>/dev/null \
        || true
      rm -f "$PLIST_DST"
      echo "[OK] uninstalled $LABEL"
    else
      echo "[OK] not installed"
    fi
    # Cache dir is purged on uninstall too — venv + cached server.py go
    # together. Set CF_FETCH_KEEP_CACHE=1 to skip this (e.g. for debugging
    # the warm browser interactively).
    if [[ -d "$CACHE_ROOT" && "${CF_FETCH_KEEP_CACHE:-0}" != "1" ]]; then
      rm -rf "$CACHE_ROOT"
      echo "[OK] removed cache dir $CACHE_ROOT"
    fi
    ;;

  status)
    if [[ -f "$PLIST_DST" ]]; then
      echo "plist:    $PLIST_DST"
      echo "registered:"
      launchctl print "gui/$(id -u)/$LABEL" 2>&1 \
        | grep -E "(state|last exit code|pid =|program =)" \
        | sed 's/^/  /' || true
      echo "launchctl list:"
      launchctl list | grep "$LABEL" | sed 's/^/  /' || echo "  (not in list)"
      echo "logs:     /tmp/cf-fetch-server.log /tmp/cf-fetch-server.err"
      # Probe /healthz so the operator can see live process-management state
      # (browser uptime, restart count, concurrency, queue depth) — the same
      # fields surfaced by Sub-AC 1.1.4. curl --silent --max-time keeps the
      # status check fast even if the sidecar is wedged.
      port="$(grep -E 'CF_FETCH_SERVER_PORT' "$PLIST_DST" 2>/dev/null \
        | sed -nE 's/.*<string>([0-9]+)<\/string>.*/\1/p' | tail -1)"
      port="${port:-8765}"
      echo "healthz:  http://127.0.0.1:$port/healthz"
      hz="$(curl -sS --max-time 2 "http://127.0.0.1:$port/healthz" 2>/dev/null || true)"
      if [[ -n "$hz" ]]; then
        if command -v python3 >/dev/null 2>&1; then
          # NOTE: avoid backslash-escaped quotes inside f-string expressions —
          # that is a SyntaxError on Python <3.12, and the host's `python3`
          # may be the Apple CommandLineTools build (3.9). Use bare-key dict
          # lookups via a local alias instead.
          echo "$hz" | python3 -c '
import sys, json
try:
    d = json.loads(sys.stdin.read())
except Exception as e:
    print("  (healthz parse failed: " + repr(e) + ")")
    sys.exit(0)
keys = ["backend", "browser_ready", "browser_uptime_s", "browser_restarts",
        "proxy_configured", "shutting_down"]
for k in keys:
    print("  " + k + ": " + str(d.get(k)))
c = d.get("concurrency") or {}
cmax = c.get("max")
cact = c.get("active")
cwait = c.get("waiting")
cserv = c.get("total_served")
crej = c.get("rejected_total")
print("  concurrency: max=" + str(cmax) + " active=" + str(cact)
      + " waiting=" + str(cwait) + " served=" + str(cserv)
      + " rejected=" + str(crej))
'
        else
          echo "  $hz"
        fi
      else
        echo "  (no healthz response — sidecar may still be booting)"
      fi
      echo "tail log:"
      tail -5 /tmp/cf-fetch-server.log 2>/dev/null | sed 's/^/  /' || echo "  (no log yet)"
      tail -5 /tmp/cf-fetch-server.err 2>/dev/null | sed 's/^/  err: /' || true
    else
      echo "not installed"
    fi
    ;;

  restart)
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
    echo "[OK] restarted $LABEL"
    ;;

  run)
    echo "[OK] running server.py in foreground..."
    exec "$PYTHON" "$SCRIPT_DIR/server.py" "${@:2}"
    ;;

  *)
    echo "usage: $0 {install|uninstall|status|restart|run}" >&2
    exit 2
    ;;
esac
