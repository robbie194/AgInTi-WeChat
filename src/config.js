import crypto from "node:crypto";

function secret(env, name, { length = 32, testValue = "test-secret-which-is-long-enough-for-checks" } = {}) {
  const value = String(env[name] || "").trim();
  if (env.NODE_ENV === "test" && !value) return testValue;
  if (value.length < length) throw new Error(`${name} must contain at least ${length} characters.`);
  return value;
}

function encryptionKey(env) {
  const raw = String(env.WECHAT_DATA_ENCRYPTION_KEY || "").trim();
  if (env.NODE_ENV === "test" && !raw) return Buffer.alloc(32, 7);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("WECHAT_DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
}

function integer(env, name, fallback, minimum = 1) {
  const parsed = Number(env[name] || fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}.`);
  return parsed;
}

export function readConfig(env = process.env) {
  const enabled = String(env.WECHAT_ENABLED || "false").toLowerCase() === "true";
  const groupBotEnabled = String(env.WECHAT_GROUP_BOT_ENABLED || "false").toLowerCase() === "true";
  const openKfIds = String(env.WECHAT_OPEN_KF_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (enabled) {
    for (const name of ["WECHAT_CORP_ID", "WECHAT_CORP_SECRET", "WECHAT_CALLBACK_TOKEN", "WECHAT_ENCODING_AES_KEY", "CLOUD_BRIDGE_URL", "CLOUD_BRIDGE_SHARED_SECRET"]) {
      if (!String(env[name] || "").trim()) throw new Error(`${name} is required when WECHAT_ENABLED=true.`);
    }
    if (!openKfIds.length) throw new Error("WECHAT_OPEN_KF_IDS must include at least one customer service account.");
  }
  if (groupBotEnabled) {
    for (const name of ["WECHAT_BOT_ID", "WECHAT_BOT_SECRET", "CLOUD_BRIDGE_URL", "CLOUD_BRIDGE_SHARED_SECRET"]) {
      if (!String(env[name] || "").trim()) throw new Error(`${name} is required when WECHAT_GROUP_BOT_ENABLED=true.`);
    }
  }

  const encodingAesKey = String(env.WECHAT_ENCODING_AES_KEY || "").trim();
  let decodedAesKey = null;
  if (encodingAesKey) {
    if (!/^[A-Za-z0-9+/]{43}$/.test(encodingAesKey)) throw new Error("WECHAT_ENCODING_AES_KEY must be the 43-character WeChat EncodingAESKey.");
    decodedAesKey = Buffer.from(`${encodingAesKey}=`, "base64");
    if (decodedAesKey.length !== 32) throw new Error("WECHAT_ENCODING_AES_KEY must decode to 32 bytes.");
  }

  return Object.freeze({
    env: env.NODE_ENV || "development",
    port: integer(env, "PORT", 3230),
    databaseURL: String(env.DATABASE_URL || "postgres://aginti_wechat:aginti_wechat@localhost:5432/aginti_wechat"),
    enabled,
    groupBotEnabled,
    groupBotId: String(env.WECHAT_BOT_ID || ""),
    groupBotSecret: String(env.WECHAT_BOT_SECRET || ""),
    corpId: String(env.WECHAT_CORP_ID || ""),
    corpSecret: String(env.WECHAT_CORP_SECRET || ""),
    callbackToken: String(env.WECHAT_CALLBACK_TOKEN || ""),
    encodingAesKey,
    decodedAesKey,
    callbackPath: String(env.WECHAT_CALLBACK_PATH || "/wecom/callback"),
    openKfIds,
    ackDelayMs: integer(env, "WECHAT_ACK_DELAY_MS", 8000),
    maxMediaBytes: integer(env, "WECHAT_MAX_MEDIA_BYTES", 20 * 1024 * 1024),
    dataEncryptionKey: encryptionKey(env),
    cloudBridgeURL: String(env.CLOUD_BRIDGE_URL || "http://localhost:3220").replace(/\/+$/, ""),
    cloudBridgeSharedSecret: enabled ? secret(env, "CLOUD_BRIDGE_SHARED_SECRET") : String(env.CLOUD_BRIDGE_SHARED_SECRET || "test-cloud-bridge-secret"),
    cloudBridgeTimeoutMs: integer(env, "CLOUD_BRIDGE_TIMEOUT_MS", 20_000),
  });
}

export const config = readConfig();

export function randomKey() {
  return crypto.randomBytes(32).toString("base64");
}
