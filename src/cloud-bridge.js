import crypto from "node:crypto";
import { config } from "./config.js";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function cloudBridgeSignature({ method, path, timestamp, nonce, body, secret }) {
  const canonical = [String(method).toUpperCase(), path, timestamp, nonce, sha256(body)].join("\n");
  return crypto.createHmac("sha256", secret).update(canonical).digest("base64url");
}

export function verifyCloudBridgeSignature({ method, path, timestamp, nonce, body, signature, secret, now = Date.now() }) {
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || Math.abs(Math.floor(now / 1000) - seconds) > 60) return false;
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(String(nonce || ""))) return false;
  const expected = Buffer.from(cloudBridgeSignature({ method, path, timestamp, nonce, body, secret }));
  const supplied = Buffer.from(String(signature || ""));
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

export class CloudBridgeClient {
  constructor({ baseURL = config.cloudBridgeURL, secret = config.cloudBridgeSharedSecret, fetchImpl = fetch, timeoutMs = config.cloudBridgeTimeoutMs } = {}) {
    this.baseURL = String(baseURL).replace(/\/+$/, "");
    this.secret = secret;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(method, pathname, { body, headers = {} } = {}) {
    const rawBody = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(18).toString("base64url");
    const signature = cloudBridgeSignature({ method, path: pathname, timestamp, nonce, body: rawBody, secret: this.secret });
    const response = await this.fetch(`${this.baseURL}${pathname}`, {
      method,
      headers: {
        Accept: "application/json",
        "X-OverTree-WeChat-Timestamp": timestamp,
        "X-OverTree-WeChat-Nonce": nonce,
        "X-OverTree-WeChat-Signature": signature,
        ...(body == null ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body == null ? undefined : rawBody,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(String(payload.error || `OverTree Cloud bridge returned ${response.status}.`).slice(0, 500));
      error.statusCode = response.status;
      error.retryable = response.status >= 500 || response.status === 409 || response.status === 429;
      throw error;
    }
    return payload;
  }

  claimBinding({ code, openKfId, externalUserId }) {
    return this.request("POST", "/internal/wechat/v1/bindings/claim", { body: { code, openKfId, externalUserId } });
  }

  claimGroupBinding({ code, botId, chatId, actorId }) {
    return this.request("POST", "/internal/wechat/v1/groups/claim", { body: { code, botId, chatId, actorId } });
  }

  resolveGroupBinding({ botId, chatId }) {
    const params = new URLSearchParams({ botId, chatId });
    return this.request("GET", `/internal/wechat/v1/groups/resolve?${params}`);
  }

  resolveBinding({ openKfId, externalUserId }) {
    const params = new URLSearchParams({ openKfId, externalUserId });
    return this.request("GET", `/internal/wechat/v1/bindings/resolve?${params}`);
  }

  submitMessage({ channel = "wechat_customer_service", openKfId = "", externalUserId = "", botId = "", chatId = "", actorId = "", messageId, content, attachments = [] }) {
    return this.request("POST", "/internal/wechat/v1/messages", {
      body: { channel, openKfId, externalUserId, botId, chatId, actorId, messageId, content, attachments },
    });
  }

  getMessage({ channel = "wechat_customer_service", openKfId = "", externalUserId = "", botId = "", chatId = "", actorId = "", messageId }) {
    const params = new URLSearchParams({ channel, openKfId, externalUserId, botId, chatId, actorId });
    return this.request("GET", `/internal/wechat/v1/messages/${encodeURIComponent(messageId)}?${params}`);
  }

  uploadAttachment({ openKfId, externalUserId, messageId, filename, contentType, buffer }) {
    const pathname = `/internal/wechat/v1/attachments?${new URLSearchParams({ openKfId, externalUserId, messageId, filename })}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(18).toString("base64url");
    const signature = cloudBridgeSignature({ method: "PUT", path: pathname, timestamp, nonce, body: buffer, secret: this.secret });
    return this.fetch(`${this.baseURL}${pathname}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-OverTree-WeChat-Content-Type": contentType,
        "X-OverTree-WeChat-Timestamp": timestamp,
        "X-OverTree-WeChat-Nonce": nonce,
        "X-OverTree-WeChat-Signature": signature,
      },
      body: buffer,
      signal: AbortSignal.timeout(this.timeoutMs),
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(String(payload.error || `OverTree Cloud bridge returned ${response.status}.`).slice(0, 500));
        error.statusCode = response.status;
        error.retryable = response.status >= 500 || response.status === 429;
        throw error;
      }
      return payload;
    });
  }
}

export const cloudBridge = new CloudBridgeClient();
