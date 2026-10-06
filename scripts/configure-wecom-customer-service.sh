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
read -r -s -p '微信客服 API Secret（输入隐藏）: ' api_secret
printf '\n'
read -r -p '微信客服 open_kfid（多个用英文逗号分隔）: ' open_kf_ids

if [[ ! "$corp_id" =~ ^[A-Za-z0-9._@:-]{1,128}$ ]]; then
  printf 'CorpID 格式不正确。\n' >&2
  exit 1
fi
if [[ ! "$api_secret" =~ ^[[:graph:]]{16,256}$ ]]; then
  printf 'API Secret 格式不正确；请粘贴企业微信页面提供的 Secret。\n' >&2
  exit 1
fi
if [[ -z "$open_kf_ids" || "$open_kf_ids" == ,* || "$open_kf_ids" == *, ]]; then
  printf '至少需要填写一个 open_kfid；多个值之间用英文逗号分隔。\n' >&2
  exit 1
fi

IFS=',' read -r -a open_kf_id_list <<< "$open_kf_ids"
normalized_open_kf_ids=()
for open_kf_id in "${open_kf_id_list[@]}"; do
  open_kf_id="${open_kf_id//[[:space:]]/}"
  if [[ ! "$open_kf_id" =~ ^[A-Za-z0-9_-]{1,128}$ ]]; then
    printf 'open_kfid 格式不正确；请检查逗号分隔的账号 ID。\n' >&2
    exit 1
  fi
  normalized_open_kf_ids+=("$open_kf_id")
done
open_kf_ids="$(IFS=,; printf '%s' "${normalized_open_kf_ids[*]}")"

secret_file="$(mktemp "${TMPDIR:-/tmp}/aginti-wechat-api.XXXXXX")"
chmod 600 "$secret_file"
trap 'rm -f "$secret_file"' EXIT
printf '%s\0%s\0%s\0' "$corp_id" "$api_secret" "$open_kf_ids" > "$secret_file"

backup_file="$(python3 - "$secret_file" "$ENV_FILE" <<'PY'
import datetime
import os
import pathlib
import shutil
import sys

secret_file = pathlib.Path(sys.argv[1])
env_file = pathlib.Path(sys.argv[2])
corp_id, api_secret, open_kf_ids, _ = secret_file.read_bytes().decode().split("\0")
values = {
    "WECHAT_CORP_ID": corp_id,
    "WECHAT_CORP_SECRET": api_secret,
    "WECHAT_OPEN_KF_IDS": open_kf_ids,
    "WECHAT_ENABLED": "false",
    "WECHAT_GROUP_BOT_ENABLED": "false",
}

stamp = datetime.datetime.now().strftime("%Y%m%dT%H%M%S%f")
old_lines = env_file.read_text().splitlines()
for line in old_lines:
    key, separator, value = line.partition("=")
    if separator and key in {"WECHAT_ENABLED", "WECHAT_GROUP_BOT_ENABLED"} and value.strip().lower() == "true":
        raise SystemExit("Disable the WeChat service switches before recording credentials.")

backup_file = env_file.with_name(f"{env_file.name}.api-backup.{stamp}")
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

printf '微信客服 API 凭证已安全写入 .env；备份文件：%s\n' "$backup_file"
printf 'WECHAT_ENABLED 和 WECHAT_GROUP_BOT_ENABLED 均保持 false，Gateway 未重启，当前生产行为不变。\n'
printf '完成回调校验并准备验收后，再单独启用私聊服务。\n'
