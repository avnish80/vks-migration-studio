#!/usr/bin/env bash
# Builds and starts the engine inside a GitHub Codespace, reachable through the
# Codespace's private forwarded address for port 8080.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${CODESPACE_NAME:-}" ] || [ -z "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
  echo "This script is for GitHub Codespaces. Locally, run the engine as described in README.md." >&2
  exit 1
fi

host="${CODESPACE_NAME}-8080.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"

echo "Building the UI and engine…"
(cd ui && npm run build --silent)
(cd engine && npm run build --silent)

# The forwarded address is trusted explicitly; everything else keeps the localhost-only rules.
# Data lives in .studio-data/ in the repository folder, which survives Codespace restarts.
export STUDIO_ALLOWED_HOSTS="$host"
export STUDIO_PUBLIC_URL="https://$host"
exec node engine/build/server.js
