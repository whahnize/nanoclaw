#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Sub-AC 3.3 — the Dockerfile bakes the web-fetch wrapper CLI into the image
# at /opt/web-fetch/ and exposes it on PATH as `web-fetch`. The COPY step
# fails with a confusing "no such file or directory" if any of the source
# modules are missing, so verify them up front and emit a clear error.
WEB_FETCH_SRC="${SCRIPT_DIR}/skills/web-fetch"
WEB_FETCH_REQUIRED=(web_fetch.py cf_detect.py sidecar_client.py orchestrator.py)
for f in "${WEB_FETCH_REQUIRED[@]}"; do
    if [ ! -f "${WEB_FETCH_SRC}/${f}" ]; then
        echo "ERROR: web-fetch source missing: ${WEB_FETCH_SRC}/${f}" >&2
        echo "       The Dockerfile expects every file in skills/web-fetch/{${WEB_FETCH_REQUIRED[*]}}" >&2
        echo "       to be present. Aborting build." >&2
        exit 1
    fi
done

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test agent runner with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
echo ""
# Sub-AC 3.3 — surface the on-PATH web-fetch wrapper so operators can
# smoke-test the CF-bypass plumbing without tearing through the agent
# stack. host.docker.internal is the default sidecar host; override with
# `-e CF_FETCH_SIDECAR_URL=http://…` if you're not on Docker Desktop or
# the sidecar lives elsewhere.
echo "Test web-fetch wrapper (Sub-AC 3.3) with:"
echo "  ${CONTAINER_RUNTIME} run --rm --entrypoint web-fetch ${IMAGE_NAME}:${TAG} https://example.com"
echo "  ${CONTAINER_RUNTIME} run --rm --entrypoint sh ${IMAGE_NAME}:${TAG} -c 'echo \$CF_FETCH_SIDECAR_URL && command -v web-fetch'"
