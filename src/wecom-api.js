import { config } from "./config.js";

const API = "https://qyapi.weixin.qq.com/cgi-bin";

export class WeComApi {
  constructor({ fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.fetch = fetchImpl;
    this.now = now;
    this.token = "";
    this.tokenExpiresAt = 0;
    this.tokenRequest = null;
  }

  async accessToken(force = false) {
    if (!force && this.token && this.tokenExpiresAt > this.now() + 5 * 60_000) return this.token;
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = (async () => {
      const url = new URL(`${API}/gettoken`);
      url.searchParams.set("corpid", config.corpId);
      url.searchParams.set("corpsecret", config.corpSecret);
      const response = await this.fetch(url, { signal: AbortSignal.timeout(15_000) });
      const body = await response.json();
      if (!response.ok || body.errcode) throw this.apiError(body, response.status, "Unable to obtain WeChat Work access token.");
      this.token = String(body.access_token || "");
      this.tokenExpiresAt = this.now() + Number(body.expires_in || 7200) * 1000;
      if (!this.token) throw new Error("WeChat Work did not return an access token.");
      return this.token;
    })().finally(() => { this.tokenRequest = null; });
    return this.tokenRequest;
  }

  async request(path, { method = "GET", body, query = {}, retryAuth = true } = {}) {
    const token = await this.accessToken();
    const url = new URL(`${API}${path}`);
    url.searchParams.set("access_token", token);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const response = await this.fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (payload.errcode === 40014 || payload.errcode === 42001) {
      this.token = "";
      this.tokenExpiresAt = 0;
      if (retryAuth) {
        await this.accessToken(true);
        return this.request(path, { method, body, query, retryAuth: false });
      }
    }
    if (!response.ok || Number(payload.errcode || 0) !== 0) throw this.apiError(payload, response.status, `WeChat Work API ${path} failed.`);
    return payload;
  }

  apiError(payload, status, fallback) {
    const error = new Error(String(payload.errmsg || fallback).slice(0, 500));
    error.statusCode = status || 502;
    error.wecomCode = Number(payload.errcode || 0);
    return error;
  }

  syncMessages(openKfId, { cursor = "", callbackToken = "", limit = 100 } = {}) {
    return this.request("/kf/sync_msg", {
      method: "POST",
      body: { open_kfid: openKfId, cursor, token: callbackToken, limit, voice_format: 0 },
    });
  }

  sendText(openKfId, externalUserId, content, messageId) {
    return this.request("/kf/send_msg", {
      method: "POST",
      body: {
        touser: externalUserId,
        open_kfid: openKfId,
        msgid: messageId,
        msgtype: "text",
        text: { content: String(content).slice(0, 2000) },
      },
    });
  }

  async downloadMedia(mediaId, maxBytes = config.maxMediaBytes) {
    const token = await this.accessToken();
    const url = new URL(`${API}/media/get`);
    url.searchParams.set("access_token", token);
    url.searchParams.set("media_id", mediaId);
    const response = await this.fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw Object.assign(new Error(`WeChat media download failed (${response.status}).`), { statusCode: response.status });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw Object.assign(new Error("WeChat attachment exceeds the configured size limit."), { statusCode: 413 });
    if (buffer.subarray(0, 1).toString() === "{") {
      const errorBody = JSON.parse(buffer.toString("utf8"));
      if (errorBody.errcode) throw this.apiError(errorBody, 502, "WeChat media download failed.");
    }
    return {
      buffer,
      contentType: response.headers.get("content-type") || "application/octet-stream",
      filename: response.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/)?.[1] || "wechat-attachment",
    };
  }

  async downloadCustomerServiceFile(fileId, maxBytes = config.maxMediaBytes) {
    const token = await this.accessToken();
    const response = await this.fetch(`${API}/kf/get_msg_file?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw Object.assign(new Error(`WeChat Customer Service file download failed (${response.status}).`), { statusCode: response.status });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw Object.assign(new Error("WeChat attachment exceeds the configured size limit."), { statusCode: 413 });
    if (response.headers.get("content-type")?.includes("application/json") || buffer.subarray(0, 1).toString() === "{") {
      const errorBody = JSON.parse(buffer.toString("utf8"));
      if (errorBody.errcode) throw this.apiError(errorBody, 502, "WeChat file download failed.");
    }
    return {
      buffer,
      contentType: response.headers.get("content-type") || "application/octet-stream",
      filename: response.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/)?.[1] || "wechat-file",
    };
  }
}

export const wecomApi = new WeComApi();
