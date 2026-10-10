import pg from "pg";
import crypto from "node:crypto";
import { config } from "./config.js";
import { encryptPayload } from "./encryption.js";

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.databaseURL, max: 8, application_name: "aginti-wechat" });

const migrations = [
  `CREATE TABLE IF NOT EXISTS wechat_sync_state (
    open_kfid TEXT PRIMARY KEY,
    cursor TEXT NOT NULL DEFAULT '',
    callback_token_enc BYTEA,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS wechat_inbound_messages (
    id BIGSERIAL PRIMARY KEY,
    open_kfid TEXT NOT NULL,
    external_userid_hash TEXT NOT NULL,
    upstream_msg_id TEXT NOT NULL,
    payload_enc BYTEA NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','submitted','acked','sent','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until TIMESTAMPTZ,
    cloud_request_id TEXT,
    ack_sent_at TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '',
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,
    UNIQUE(open_kfid, upstream_msg_id)
  )`,
  `CREATE INDEX IF NOT EXISTS wechat_inbound_queue_idx ON wechat_inbound_messages(status, next_attempt_at, received_at)`,
  `CREATE TABLE IF NOT EXISTS wechat_outbound_messages (
    id UUID PRIMARY KEY,
    open_kfid TEXT NOT NULL,
    external_userid_hash TEXT NOT NULL,
    upstream_msg_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('sending','sent','failed','unknown')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ,
    error_code INTEGER,
    error TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS wechat_group_inbound_messages (
    id BIGSERIAL PRIMARY KEY,
    bot_id TEXT NOT NULL,
    chat_id_hash TEXT NOT NULL,
    upstream_msg_id TEXT NOT NULL,
    payload_enc BYTEA,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','submitted','acked','sent','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until TIMESTAMPTZ,
    cloud_request_id TEXT,
    ack_sent_at TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '',
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,
    UNIQUE(bot_id,upstream_msg_id)
  )`,
  `CREATE INDEX IF NOT EXISTS wechat_group_inbound_queue_idx ON wechat_group_inbound_messages(status,next_attempt_at,received_at)`,
  `CREATE TABLE IF NOT EXISTS wechat_group_outbound_messages (
    id UUID PRIMARY KEY,
    bot_id TEXT NOT NULL,
    chat_id_hash TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('sending','sent','failed','unknown')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ,
    error TEXT NOT NULL DEFAULT '',
    UNIQUE(bot_id,chat_id_hash,idempotency_key)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS wechat_outbound_idempotency_idx ON wechat_outbound_messages(open_kfid,external_userid_hash,upstream_msg_id) WHERE upstream_msg_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS wechat_outbound_rate_idx ON wechat_outbound_messages(open_kfid, external_userid_hash, sent_at DESC) WHERE status = 'sent'`,
];

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of migrations) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function query(text, values = []) {
  return pool.query(text, values);
}

export function hashExternalUserId(externalUserId) {
  return crypto.createHmac("sha256", config.dataEncryptionKey).update(String(externalUserId)).digest("hex");
}

export async function saveSyncPage(openKfId, { cursor = "", callbackToken = "", messages = [] }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const message of messages) {
      const externalUserId = String(message.external_userid || "");
      if (!externalUserId || !message.msgtype || (message.origin != null && Number(message.origin) !== 3)) continue;
      const body = JSON.stringify(message);
      const messageId = String(message.msgid || crypto.createHash("sha256").update(body).digest("hex"));
      await client.query(
        `INSERT INTO wechat_inbound_messages(open_kfid,external_userid_hash,upstream_msg_id,payload_enc)
         VALUES($1,$2,$3,$4) ON CONFLICT(open_kfid,upstream_msg_id) DO NOTHING`,
        [openKfId, hashExternalUserId(externalUserId), messageId, encryptPayload(message, config.dataEncryptionKey)]
      );
    }
    await client.query(
      `INSERT INTO wechat_sync_state(open_kfid,cursor,callback_token_enc,updated_at)
       VALUES($1,$2,$3,now())
       ON CONFLICT(open_kfid) DO UPDATE SET
         cursor=EXCLUDED.cursor,
         callback_token_enc=COALESCE(EXCLUDED.callback_token_enc,wechat_sync_state.callback_token_enc),
         updated_at=now()`,
      [openKfId, cursor, callbackToken ? encryptPayload({ token: callbackToken }, config.dataEncryptionKey) : null]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getSyncState(openKfId) {
  const { rows } = await query("SELECT open_kfid,cursor,callback_token_enc FROM wechat_sync_state WHERE open_kfid=$1", [openKfId]);
  return rows[0] || { open_kfid: openKfId, cursor: "", callback_token_enc: null };
}

export async function rememberCallbackToken(openKfId, token) {
  await query(
    `INSERT INTO wechat_sync_state(open_kfid,callback_token_enc)
     VALUES($1,$2) ON CONFLICT(open_kfid) DO UPDATE SET callback_token_enc=EXCLUDED.callback_token_enc,updated_at=now()`,
    [openKfId, token ? encryptPayload({ token }, config.dataEncryptionKey) : null]
  );
}

export async function claimInboundMessage() {
  const { rows } = await query(
    `WITH next_message AS (
       SELECT id FROM wechat_inbound_messages
       WHERE ((status IN ('pending','submitted','acked')) AND next_attempt_at <= now()) OR (status='processing' AND lease_until < now())
       ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE wechat_inbound_messages AS message
     SET status='processing', attempts=attempts+1, lease_until=now()+interval '3 minutes'
     FROM next_message WHERE message.id=next_message.id
     RETURNING message.*`
  );
  return rows[0] || null;
}

export async function finishInboundMessage(id, { cloudRequestId = "" } = {}) {
  await query("UPDATE wechat_inbound_messages SET status='sent',cloud_request_id=$2,lease_until=NULL,processed_at=now(),last_error='' WHERE id=$1", [id, cloudRequestId]);
}

export async function markInboundSubmitted(id, { cloudRequestId, delaySeconds = 3 }) {
  await query(
    `UPDATE wechat_inbound_messages SET status='submitted',cloud_request_id=$2,lease_until=NULL,
      next_attempt_at=now()+($3*interval '1 second'),last_error='' WHERE id=$1`,
    [id, cloudRequestId, delaySeconds]
  );
}

export async function markInboundAcked(id, { delaySeconds = 3 }) {
  await query(
    `UPDATE wechat_inbound_messages SET status='acked',ack_sent_at=now(),lease_until=NULL,
      next_attempt_at=now()+($2*interval '1 second') WHERE id=$1`,
    [id, delaySeconds]
  );
}

export async function retryInboundMessage(id, { attempts, error, terminal = false }) {
  const delaySeconds = Math.min(300, 2 ** Math.min(Number(attempts) || 1, 8));
  await query(
    `UPDATE wechat_inbound_messages SET status=$2,lease_until=NULL,next_attempt_at=now()+($3*interval '1 second'),
      last_error=$4 WHERE id=$1`,
    [id, terminal ? "failed" : "pending", delaySeconds, String(error || "Processing failed.").slice(0, 500)]
  );
}

export async function reserveOutboundMessage({ openKfId, externalUserIdHash, messageId }) {
  const client = await pool.connect();
  const id = crypto.randomUUID();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${openKfId}:${externalUserIdHash}`]);
    const { rows: existingRows } = await client.query(
      `SELECT id,status FROM wechat_outbound_messages WHERE open_kfid=$1 AND external_userid_hash=$2 AND upstream_msg_id=$3`,
      [openKfId, externalUserIdHash, messageId]
    );
    if (existingRows.length) {
      if (existingRows[0].status === "failed") {
        await client.query(
          "UPDATE wechat_outbound_messages SET status='sending',error_code=NULL,error='' WHERE id=$1",
          [existingRows[0].id]
        );
        await client.query("COMMIT");
        return { id: existingRows[0].id, status: "sending", allowed: true, retry: true };
      }
      await client.query("COMMIT");
      return { id: existingRows[0].id, status: existingRows[0].status, allowed: existingRows[0].status === "sending" };
    }
    const { rows: countRows } = await client.query(
      `SELECT count(*)::int AS count FROM wechat_outbound_messages
       WHERE open_kfid=$1 AND external_userid_hash=$2 AND status IN ('sending','sent','unknown')
         AND COALESCE(sent_at,created_at) > now()-interval '48 hours'`,
      [openKfId, externalUserIdHash]
    );
    if (countRows[0].count >= 5) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query("INSERT INTO wechat_outbound_messages(id,open_kfid,external_userid_hash,upstream_msg_id,status) VALUES($1,$2,$3,$4,'sending')", [id, openKfId, externalUserIdHash, messageId]);
    await client.query("COMMIT");
    return { id, status: "sending", allowed: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeOutboundMessage(id, { sent = false, unknown = false, errorCode = null, error = "" } = {}) {
  const status = sent ? "sent" : unknown ? "unknown" : "failed";
  await query(
    "UPDATE wechat_outbound_messages SET status=$2,sent_at=CASE WHEN $2='sent' THEN now() ELSE NULL END,error_code=$3,error=$4 WHERE id=$1",
    [id, status, errorCode, String(error).slice(0, 500)]
  );
}

export async function saveSmartBotMessage(botId, frame) {
  const body = frame?.body || {};
  const chatId = String(body.chatid || "");
  const messageId = String(body.msgid || "");
  if (!chatId || !messageId || body.chattype !== "group") return false;
  const { rowCount } = await query(
    `INSERT INTO wechat_group_inbound_messages(bot_id,chat_id_hash,upstream_msg_id,payload_enc)
     VALUES($1,$2,$3,$4) ON CONFLICT(bot_id,upstream_msg_id) DO NOTHING`,
    [botId, hashExternalUserId(chatId), messageId, encryptPayload(frame, config.dataEncryptionKey)]
  );
  return rowCount === 1;
}

export async function claimSmartBotMessage(botId) {
  const { rows } = await query(
    `WITH next_message AS (
       SELECT id FROM wechat_group_inbound_messages
       WHERE bot_id=$1 AND (((status IN ('pending','submitted','acked')) AND next_attempt_at <= now()) OR (status='processing' AND lease_until < now()))
       ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE wechat_group_inbound_messages AS message
     SET status='processing',attempts=attempts+1,lease_until=now()+interval '3 minutes'
     FROM next_message WHERE message.id=next_message.id
     RETURNING message.*`,
    [botId]
  );
  return rows[0] || null;
}

export async function markSmartBotSubmitted(id, { cloudRequestId, delaySeconds = 3 }) {
  await query(
    `UPDATE wechat_group_inbound_messages SET status='submitted',cloud_request_id=$2,lease_until=NULL,
      next_attempt_at=now()+($3*interval '1 second'),last_error='' WHERE id=$1`,
    [id, cloudRequestId, delaySeconds]
  );
}

export async function markSmartBotAcked(id, { delaySeconds = 3 }) {
  await query(
    `UPDATE wechat_group_inbound_messages SET status='acked',ack_sent_at=now(),lease_until=NULL,
      next_attempt_at=now()+($2*interval '1 second') WHERE id=$1`,
    [id, delaySeconds]
  );
}

export async function finishSmartBotMessage(id) {
  await query("UPDATE wechat_group_inbound_messages SET status='sent',payload_enc=NULL,lease_until=NULL,processed_at=now(),last_error='' WHERE id=$1", [id]);
}

export async function retrySmartBotMessage(id, { attempts, error, terminal = false }) {
  const delaySeconds = Math.min(300, 2 ** Math.min(Number(attempts) || 1, 8));
  await query(
    `UPDATE wechat_group_inbound_messages SET status=$2,lease_until=NULL,next_attempt_at=now()+($3*interval '1 second'),
      last_error=$4 WHERE id=$1`,
    [id, terminal ? "failed" : "pending", delaySeconds, String(error || "Processing failed.").slice(0, 500)]
  );
}

export async function reserveGroupOutbound({ botId, chatId, idempotencyKey }) {
  const client = await pool.connect();
  const chatHash = hashExternalUserId(chatId);
  const id = crypto.randomUUID();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`group:${botId}:${chatHash}`]);
    const { rows: prior } = await client.query(
      `SELECT id,status FROM wechat_group_outbound_messages WHERE bot_id=$1 AND chat_id_hash=$2 AND idempotency_key=$3`,
      [botId, chatHash, idempotencyKey]
    );
    if (prior.length) {
      if (prior[0].status === "failed") {
        await client.query(
          "UPDATE wechat_group_outbound_messages SET status='sending',error='' WHERE id=$1",
          [prior[0].id]
        );
        await client.query("COMMIT");
        return { id: prior[0].id, status: "sending", allowed: true, retry: true };
      }
      await client.query("COMMIT");
      return { id: prior[0].id, status: prior[0].status, allowed: prior[0].status === "sending" };
    }
    const { rows: count } = await client.query(
      `SELECT count(*) FILTER (WHERE COALESCE(sent_at,created_at)>now()-interval '1 minute')::int AS minute_count,
              count(*) FILTER (WHERE COALESCE(sent_at,created_at)>now()-interval '1 hour')::int AS hour_count
       FROM wechat_group_outbound_messages WHERE bot_id=$1 AND chat_id_hash=$2 AND status IN ('sending','sent','unknown')`,
      [botId, chatHash]
    );
    if (count[0].minute_count >= 30 || count[0].hour_count >= 1000) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `INSERT INTO wechat_group_outbound_messages(id,bot_id,chat_id_hash,idempotency_key,status)
       VALUES($1,$2,$3,$4,'sending')`,
      [id, botId, chatHash, idempotencyKey]
    );
    await client.query("COMMIT");
    return { id, status: "sending", allowed: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeGroupOutbound(id, { sent = false, unknown = false, error = "" } = {}) {
  const status = sent ? "sent" : unknown ? "unknown" : "failed";
  await query(
    `UPDATE wechat_group_outbound_messages SET status=$2,sent_at=CASE WHEN $2='sent' THEN now() ELSE NULL END,error=$3 WHERE id=$1`,
    [id, status, String(error).slice(0, 500)]
  );
}
