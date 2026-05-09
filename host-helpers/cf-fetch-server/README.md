# cf-fetch-server

Host-side Cloudflare-bypass fetch sidecar for NanoClaw container agents.

## What it is

A long-lived HTTP service bound to `127.0.0.1:8765` (loopback only) that the
container's web-fetch wrapper can call as fallback when the in-container
agent-browser hits a Cloudflare challenge. The container reaches the host via
`host.docker.internal`.

Layout follows the `host-helpers/paris-pap-fetch/` precedent:

| File | Purpose |
|------|---------|
| `server.py` | The sidecar process — stdlib HTTP server + persistent `nodriver` browser, automatic Cloudflare-challenge resolution via `verify_cf()` |
| `launchd.plist.template` | LaunchAgent definition with `KeepAlive=true` so launchd auto-respawns the python process if it dies |
| `install.sh` | install / uninstall / status / restart / run helper. Auto-detects the first python3 with `nodriver` installed |

## Install

```bash
./install.sh install      # bootstraps com.nanoclaw.cf-fetch-server
./install.sh status
./install.sh uninstall
```

`install.sh` writes the rendered plist to
`~/Library/LaunchAgents/com.nanoclaw.cf-fetch-server.plist` and bootstraps it
into the user's launchd domain.

### macOS TCC note

`/usr/bin/python3` (CommandLineTools) is denied read access to files under
`~/Desktop/`, `~/Documents/`, `~/Downloads/` when launched by launchd
(`Operation not permitted`/EPERM from TCC). Because this repo lives at
`~/Desktop/nanoclaw/`, the installer prefers `/opt/homebrew/bin/python3`,
mirroring how the working `com.nanoclaw` plist uses `/opt/homebrew/bin/node`.
Override with `PYTHON=/path/to/python3 ./install.sh install` if needed.

## Endpoints

- `GET /healthz` — liveness probe (returns pid, host, port, uptime, backend)
- `POST /fetch` — Cloudflare-bypass fetch. JSON body and JSON response.
- `GET /fetch?url=<url>&timeout=<s>` — convenience GET form for ad-hoc curl
  probes. Same backend, no custom headers.

The backend is a persistent `nodriver` browser launched at startup (warm
between requests so the first request after boot lands under 5s and repeats
land under 2s). It auto-resolves Cloudflare challenges via
`page.verify_cf()` and the `_looks_like_cf()` title heuristic ported from
`.claude/skills/request-proxy/request_proxy.py::_visit_page_async`. Webshare
residential-proxy creds are loaded from `HTTP_PROXY_URL` in the host `.env`
(see `CF_FETCH_SERVER_ENV_FILE`) and wired into the browser via
`--proxy-server=` plus a CDP `Fetch.continueWithAuth` handler.

### Webshare proxy rotation

Webshare's residential proxy rotates exit IPs **per TCP connection**. The
sidecar takes advantage of this without any per-request reconfiguration:

1. The browser is launched ONCE at startup with `--proxy-server=<host>:<port>`
   (no creds in the URL — Chromium rejects embedded creds and would log them
   anyway). This pins a single proxy endpoint for the whole process.
2. Each `/fetch` opens a **new tab** on the warm browser
   (`browser.get(url, new_tab=True)`). Each new tab issues new TCP sockets
   to the proxy, so each request reaches the upstream site through a fresh
   exit IP — that's the "rotation" Webshare advertises.
3. CDP `Fetch.enable(handle_auth_requests=true)` plus
   `Fetch.requestPaused` / `Fetch.authRequired` handlers feed the username
   and password to Chromium at connection time, per tab. The handlers are
   wired in `_visit_page_async` so the auth state is local to that
   request's tab — no shared state across concurrent fetches.
4. For sticky-session use cases (e.g. multi-step login flows that need a
   stable exit IP), append Webshare's session token suffix to the
   username portion of `HTTP_PROXY_URL` (e.g.
   `user-session-abc123:pass@p.webshare.io:80`). No code change needed —
   the username is passed through verbatim to `continueWithAuth`.

`/healthz` reports the parsed proxy host/scheme/port and `has_auth`
without leaking the credentials, so an operator can confirm the wiring at
a glance:

```jsonc
{
  "proxy_configured": true,
  "proxy": {
    "scheme":   "http",
    "host":     "p.webshare.io",
    "port":     80,
    "has_auth": true
  }
}
```

Each `/fetch` response also carries `proxy_auth_wired: true|false` so the
container wrapper (Sub-AC 1.2) can tell whether the request actually went
through the authenticated proxy or fell through to a no-proxy / no-auth
path.

If `nodriver` / `pyvirtualdisplay` aren't importable on the chosen
interpreter the sidecar gracefully degrades to `backend=stub` so the launchd
job and API contract stay intact (Verifications D and H continue to pass).
`/healthz` reports `browser_ready` and `browser_error` so you can tell
which mode you're in.

### Python interpreter & cache layout

`install.sh` does NOT use the in-repo source tree at runtime. It stages a
copy outside `~/Desktop/` because macOS 26 silently TCC-blocks
launchd-spawned processes from reading the Desktop folder (the consent
dialog never surfaces in background context, so the python interpreter
hangs in `__open_nocancel()` forever). Layout:

```
~/Library/Caches/com.nanoclaw.cf-fetch-server/
├── server.py            # cp -f from in-repo at install time
└── venv/                # bootstrapped from /opt/homebrew/bin/python3
    └── bin/python       # nodriver==0.46 + pyvirtualdisplay
```

Both `server.py` and `venv/` live OUTSIDE the TCC-protected zone.
`install.sh` re-copies `server.py` on every `install` invocation, so to
pick up edits in the in-repo source just run `./install.sh install` again
(it bootstraps the venv only once).

Override the venv location with `CF_FETCH_VENV_DIR=…` or the cache root
with `CF_FETCH_CACHE_ROOT=…`. Bypass the venv with
`CF_FETCH_NO_VENV=1` (will degrade to stub if no system python has
`nodriver` importable). Skip cache cleanup on uninstall with
`CF_FETCH_KEEP_CACHE=1`.

`nodriver==0.46` is pinned because newer 0.48 ships a non-utf-8 source
file that fails to import on Python 3.14, and older 0.40 has a
`Browser.get` None-unpacking bug.

### `POST /fetch` contract

Request body (JSON):

```jsonc
{
  "url":     "https://utoon.net/",   // required, non-empty string
  "timeout": 30,                      // optional, seconds (>0, capped at 300)
  "headers": {                        // optional, object of string→string
    "User-Agent": "...",
    "Referer":    "..."
  }
}
```

Response body (JSON):

```jsonc
{
  "status":  200,                     // upstream HTTP status (or 503 on stub)
  "html":    "<!doctype html>...",   // rendered page HTML (empty on stub)
  "headers": { "content-type": "..." }, // upstream response headers
  // diagnostic fields:
  "ok":      true,
  "url":     "https://utoon.net/",
  "title":   "...",
  "backend": "nodriver"               // "stub" until backend is wired
}
```

HTTP status codes:

- `200` — fetch operation succeeded (inspect `status` for upstream code)
- `400` — bad request (missing/invalid `url`, `timeout`, `headers`, or body)
- `404` — unknown path
- `500` — fetch backend raised
- `503` — fetch operation failed (e.g. proxy down, browser crashed, stub mode)

### Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `CF_FETCH_SERVER_HOST` | `127.0.0.1` | Bind address (loopback only) |
| `CF_FETCH_SERVER_PORT` | `8765` | Bind port |
| `CF_FETCH_SERVER_ENV_FILE` | _unset_ | Path to dotenv file (webshare creds) |
| `CF_FETCH_SERVER_DEFAULT_TIMEOUT` | `30` | Default fetch timeout (seconds) |
| `CF_FETCH_SERVER_MAX_BODY` | `262144` | Max accepted POST body bytes |
| `CF_FETCH_SERVER_BROWSER_LAUNCH_TIMEOUT` | `60` | Cold-start budget for the warm browser before degrading to stub |
| `CF_FETCH_SERVER_MAX_CONCURRENT` | `3` | Max in-flight `/fetch` operations against the warm browser |
| `CF_FETCH_SERVER_QUEUE_WAIT` | `30` | How long a queued `/fetch` waits for a slot before returning 503 |
| `CF_FETCH_SERVER_WATCHDOG_INTERVAL` | `30` | Watchdog poll interval for warm-browser liveness (0 disables) |
| `CF_FETCH_SERVER_SHUTDOWN_DRAIN` | `10` | Time SIGTERM waits for in-flight requests to finish before forcing close |

## Persistence (Verification D)

Two layers of restart-on-death keep the sidecar alive:

1. **Process-level (launchd)**. The plist sets `KeepAlive=true` plus
   `ThrottleInterval=10`, so killing the python process triggers an
   automatic respawn within ~10s. The whole sidecar comes back —
   including a fresh warm browser.
2. **Browser-level (in-process watchdog)**. A background thread inside
   `server.py` polls `_BrowserState.is_alive()` every
   `CF_FETCH_SERVER_WATCHDOG_INTERVAL` seconds. If the warm browser has
   exited (Chromium OOM, SIGSEGV, manual `kill`) the watchdog calls
   `_BrowserState.restart()` to bring just the browser back without
   tearing down the HTTP server. This is cheaper than a full launchd
   restart because the python process and its socket stay up.

Verify launchd-level restart:

```bash
launchctl list | grep com.nanoclaw.cf-fetch-server
PID=$(launchctl list | awk '/com.nanoclaw.cf-fetch-server/{print $1}')
kill -9 "$PID"
sleep 8
launchctl list | grep com.nanoclaw.cf-fetch-server   # new pid present
curl -sS http://127.0.0.1:8765/healthz                # new server responds
```

Verify browser-level recovery (watchdog):

```bash
# Find the Chromium child of the cf-fetch-server python process
PY_PID=$(launchctl list | awk '/com.nanoclaw.cf-fetch-server/{print $1}')
CHROMIUM_PID=$(pgrep -P "$PY_PID" -f Chromium | head -1)
kill -9 "$CHROMIUM_PID"
sleep $((30 + 5))   # watchdog poll interval + restart latency
curl -sS http://127.0.0.1:8765/healthz | python3 -c \
  'import sys, json; h=json.load(sys.stdin); \
   print("browser_ready:", h["browser_ready"], \
         "restarts:", h["browser_restarts"])'
# Expect: browser_ready: True, restarts: >=1
```

## Concurrency, queueing & graceful shutdown (Sub-AC 1.1.4)

Each `/fetch` opens its own tab on the warm browser, so without a cap an
N-way concurrent flood would spawn N concurrent tabs and N concurrent
`verify_cf()` loops. The sidecar caps this with a bounded semaphore
(`CF_FETCH_SERVER_MAX_CONCURRENT`, default 3). Requests beyond the cap
block at the gate for up to `CF_FETCH_SERVER_QUEUE_WAIT` seconds; if a
slot still isn't available the sidecar returns:

```jsonc
HTTP/1.1 503
{
  "ok": false,
  "status": 503,
  "backend": "queue-full",
  "error": "sidecar busy: 3 active / 3 max, queued 30s without slot",
  "queue":  { "max": 3, "active": 3, "waiting": 1, "total_served": …, "rejected_total": … }
}
```

This is real backpressure for the container wrapper to act on rather
than a silent timeout. `/healthz.concurrency` exposes the same counters
live so an operator can spot pile-ups before they become user-visible.

Graceful shutdown (SIGTERM/SIGINT/SIGHUP):

1. `_SHUTDOWN_EVENT` is set — the watchdog exits, and new `/fetch` calls
   are rejected with `backend: "shutdown"` instead of being accepted into
   the queue.
2. The signal handler waits up to `CF_FETCH_SERVER_SHUTDOWN_DRAIN`
   seconds for in-flight `/fetch` to finish (logs `all in-flight
   requests drained cleanly` or `N still in flight after Ns; forcing
   server close`).
3. `server.shutdown()` breaks `serve_forever()`, the socket closes, and
   `_BROWSER.stop()` shuts down Chromium (and xvfb on Linux).

The launchd plist sets `ExitTimeOut=15` to give the python process this
drain budget plus a few seconds of headroom — well under launchd's 20s
default that would otherwise SIGKILL a slow drain.

`/healthz` payload (the parts added in this Sub-AC):

```jsonc
{
  "browser_uptime_s": 1234.5,         // seconds since the warm browser came up (null if down)
  "browser_restarts": 0,              // total restart count since process boot
  "concurrency": {
    "max":             3,
    "active":          0,
    "waiting":         0,
    "total_served":    1240,
    "rejected_total":  3
  },
  "shutting_down":   false
}
```

## Credentials

Webshare residential-proxy credentials live in `~/Desktop/nanoclaw/.env`
(host side, source of truth — `HTTP_PROXY_URL=http://user:pass@host:port`).
At install time, `install.sh` reads that line and writes it directly into
the launchd plist's `EnvironmentVariables.HTTP_PROXY_URL`. The plist
itself is `chmod 0600`, lives at `~/Library/LaunchAgents/`, and is never
mounted into the container. The launchd-spawned python process never
needs to read `~/Desktop/.env` at runtime — sidestepping the TCC issue
described above.

The credentials therefore only appear in three places, all host-only:

1. `~/Desktop/nanoclaw/.env` (chmod 0644, owner-only)
2. `~/Library/LaunchAgents/com.nanoclaw.cf-fetch-server.plist` (chmod 0600)
3. The cf-fetch-server process's environment block (visible in `ps eww`)

They never reach the container, the container env, or the in-repo
`server.py` source.

## Logs

- stdout: `/tmp/cf-fetch-server.log`
- stderr: `/tmp/cf-fetch-server.err`
