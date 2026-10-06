#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${WECHAT_ENV_FILE:-$ROOT_DIR/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'Gateway environment file not found: %s\n' "$ENV_FILE" >&2
  exit 1
fi

read -r -p '企业微信 API 模式机器人的 Bot ID: ' bot_id
read -r -s -p '机器人 Secret（输入隐藏）: ' bot_secret
printf '\n'

if [[ ! "$bot_id" =~ ^[A-Za-z0-9._:-]{1,128}$ ]]; then
  printf 'Bot ID 格式不正确。\n' >&2
  exit 1
fi
if [[ ! "$bot_secret" =~ ^[[:graph:]]{16,256}$ ]]; then
  printf 'Secret 格式不正确；请检查企业微信 API 配置页中的机器人 Secret。\n' >&2
  exit 1
fi

secret_file="$(mktemp "${TMPDIR:-/tmp}/aginti-wechat-bot.XXXXXX")"
chmod 600 "$secret_file"
trap 'rm -f "$secret_file"' EXIT
printf '%s\0%s\0' "$bot_id" "$bot_secret" > "$secret_file"

backup_file="$(python3 - "$secret_file" "$ENV_FILE" <<'PY'
import datetime
import os
import pathlib
import shutil
import sys

secret_file = pathlib.Path(sys.argv[1])
env_file = pathlib.Path(sys.argv[2])
bot_id, bot_secret, _ = secret_file.read_bytes().decode().split("\0")
values = {
    "WECHAT_BOT_ID": bot_id,
    "WECHAT_BOT_SECRET": bot_secret,
    "WECHAT_ENABLED": "false",
    "WECHAT_GROUP_BOT_ENABLED": "false",
}

old_lines = env_file.read_text().splitlines()
for line in old_lines:
    key, separator, value = line.partition("=")
    if separator and key in {"WECHAT_ENABLED", "WECHAT_GROUP_BOT_ENABLED"} and value.strip().lower() == "true":
        raise SystemExit("Disable the WeChat service switches before recording bot credentials.")

stamp = datetime.datetime.now().strftime("%Y%m%dT%H%M%S%f")
backup_file = env_file.with_name(f"{env_file.name}.bot-backup.{stamp}")
shutil.copy2(env_file, backup_file)
os.chmod(backup_file, 0o600)

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

printf 'API 模式机器人凭证已写入 .env；备份文件：%s\n' "$backup_file"
printf 'WECHAT_GROUP_BOT_ENABLED 和 WECHAT_ENABLED 均保持 false；Gateway 未重启，也未连接机器人。\n'
