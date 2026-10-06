#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${WECHAT_ENV_FILE:-$ROOT_DIR/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'Gateway environment file not found: %s\n' "$ENV_FILE" >&2
  exit 1
fi

node --env-file="$ENV_FILE" "$ROOT_DIR/scripts/check-wecom-customer-service.mjs"
