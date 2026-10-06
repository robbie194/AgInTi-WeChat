#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${WECHAT_ENV_FILE:-$ROOT_DIR/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'Gateway environment file not found: %s\n' "$ENV_FILE" >&2
  exit 1
fi

read -r -p '企业微信 CorpID: ' corp_id
read -r -s -p '回调 Token（输入隐藏）: ' callback_token
printf '\n'
read -r -s -p 'EncodingAESKey（43 位，输入隐藏）: ' encoding_aes_key
printf '\n'

if [[ ! "$corp_id" =~ ^[A-Za-z0-9._@:-]{1,128}$ ]]; then
  printf 'CorpID 格式不正确。\n' >&2
  exit 1
fi
if [[ ! "$callback_token" =~ ^[A-Za-z0-9]{3,32}$ ]]; then
  printf 'Token 必须是 3 至 32 位字母或数字。\n' >&2
  exit 1
fi
if [[ ! "$encoding_aes_key" =~ ^[A-Za-z0-9+/]{43}$ ]]; then
  printf 'EncodingAESKey 必须是 43 位 Base64 字符。\n' >&2
  exit 1
fi

secret_file="$(mktemp "${TMPDIR:-/tmp}/aginti-wechat-callback.XXXXXX")"
chmod 600 "$secret_file"
trap 'rm -f "$secret_file"' EXIT
printf '%s\0%s\0%s\0' "$corp_id" "$callback_token" "$encoding_aes_key" > "$secret_file"

backup_file="$(python3 - "$secret_file" "$ENV_FILE" <<'PY'
import datetime
import os
import pathlib
import shutil
import sys

secret_file = pathlib.Path(sys.argv[1])
env_file = pathlib.Path(sys.argv[2])
corp_id, callback_token, encoding_aes_key, _ = secret_file.read_bytes().decode().split("\0")
values = {
    "WECHAT_CORP_ID": corp_id,
    "WECHAT_CALLBACK_TOKEN": callback_token,
    "WECHAT_ENCODING_AES_KEY": encoding_aes_key,
    "WECHAT_ENABLED": "false",
    "WECHAT_GROUP_BOT_ENABLED": "false",
}

stamp = datetime.datetime.now().strftime("%Y%m%dT%H%M%S")
backup_file = env_file.with_name(f"{env_file.name}.callback-backup.{stamp}")
shutil.copy2(env_file, backup_file)
os.chmod(backup_file, 0o600)

old_lines = env_file.read_text().splitlines()
keys = set(values)
lines = [line for line in old_lines if line.partition("=")[0] not in keys]
lines.extend(f"{key}={value}" for key, value in values.items())
temporary_file = env_file.with_name(f"{env_file.name}.new")
temporary_file.write_text("\n".join(lines) + "\n")
os.chmod(temporary_file, 0o600)
temporary_file.replace(env_file)
os.chmod(env_file, 0o600)
print(backup_file)
PY
)"

cd "$ROOT_DIR"
if ! docker compose up -d gateway || ! curl -fsS --max-time 10 http://127.0.0.1:3230/health >/dev/null; then
  cp -a "$backup_file" "$ENV_FILE"
  docker compose up -d gateway || true
  printf '配置重启失败，已恢复旧环境文件：%s\n' "$backup_file" >&2
  exit 1
fi

printf '回调验证参数已保存；环境备份：%s\n' "$backup_file"
printf 'Gateway 健康检查通过；客服私聊和群聊仍保持关闭。\n'
