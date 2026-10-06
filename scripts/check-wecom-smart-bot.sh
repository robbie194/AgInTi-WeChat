#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${WECHAT_ENV_FILE:-$ROOT_DIR/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'Gateway environment file not found: %s\n' "$ENV_FILE" >&2
  exit 1
fi

# Prefer the host runtime for local development. Production hosts normally
# keep Node dependencies inside the Gateway image, so use that image there.
if [[ -d "$ROOT_DIR/node_modules" ]] && command -v node >/dev/null 2>&1; then
  node --env-file="$ENV_FILE" "$ROOT_DIR/scripts/check-wecom-smart-bot.mjs"
  exit $?
fi

if ! command -v docker >/dev/null 2>&1; then
  printf 'Node dependencies are not installed and Docker is unavailable; run npm ci or install Docker first.\n' >&2
  exit 1
fi

cd "$ROOT_DIR"
docker compose run --rm --no-deps gateway node /app/scripts/check-wecom-smart-bot.mjs
