import path from "node:path";
import { decryptPayload } from "./encryption.js";
import {
  claimInboundMessage,
  completeOutboundMessage,
  finishInboundMessage,
  hashExternalUserId,
  markInboundAcked,
  markInboundSubmitted,
  reserveOutboundMessage,
  retryInboundMessage,
} from "./db.js";

function safeLog(level, message, data = {}) {
  const safe = Object.fromEntries(Object.entries(data).filter(([key]) => /status|code|attempt|messageid|transport/i.test(key)));
  console[level](message, safe);
}

function cleanText(value) {
  return String(value || "").replace(/\u0000/g, "").trim();
}

function truncateUtf8(value, maxBytes = 1800) {
  const input = String(value || "");
  const encoder = new TextEncoder();
  if (encoder.encode(input).length <= maxBytes) return input;
  let output = "";
  for (const character of input) {
    if (encoder.encode(output + character).length > maxBytes - 100) break;
    output += character;
  }
  return `${output}\n\n(回复较长，完整内容请在 OverTree 项目中查看。)`;
}

function attachmentDetails(message) {
  const type = String(message.msgtype || "");
  if (type === "mixed") {
    return (message.mixed?.msg_item || [])
      .slice(0, 10)
      .flatMap((item) => attachmentDetails(item));
  }
  const item = message[type] || {};
  const id = String(item.media_id || item.file_id || item.id || "");
  if (!id || !["image", "voice", "video", "file"].includes(type)) return [];
  return [{
    mediaId: id,
    mediaType: type,
    name: path.basename(String(item.file_name || item.filename || item.name || `wechat-${type}`)),
  }];
}

function messageText(message, uploadedAttachments = []) {
  const type = String(message.msgtype || "");
  if (type === "text") return cleanText(message.text?.content);
  if (type === "voice") return cleanText(message.voice?.content || "用户发送了一条语音消息。");
  if (type === "mixed") {
    const labels = { image: "图片", file: "文件", video: "视频", voice: "语音" };
    return (message.mixed?.msg_item || []).map((item) => item.msgtype === "text"
      ? cleanText(item.text?.content)
      : `[${labels[item.msgtype] || "附件"}]`).filter(Boolean).join("\n");
  }
  const description = { image: "图片", file: "文件", video: "视频", voice: "语音" }[type];
  return description ? `用户发送了${description}。` : cleanText(message.content || "用户发送了一条消息。");
}

function extractLinkCode(text) {
  const candidate = cleanText(text).toUpperCase().replace(/^绑定\s*/, "");
  return /^[A-HJ-NP-Z2-9]{8}$/.test(candidate) ? candidate : "";
}

function cloudStatus(payload) {
  return String(payload.status || payload.state || "running").toLowerCase();
}

export class CustomerServiceProcessor {
  constructor({ config, api, bridge, pollIntervalMs = 1000 }) {
    this.config = config;
    this.api = api;
    this.bridge = bridge;
    this.pollIntervalMs = pollIntervalMs;
    this.running = false;
    this.timer = null;
    this.activeTask = null;
  }

  start() {
    if (!this.config.enabled || this.running) return;
    this.running = true;
    void this.work();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.activeTask) await this.activeTask.catch(() => {});
  }

  async work() {
    if (!this.running || this.activeTask) return this.activeTask;
    this.activeTask = (async () => {
      const row = await claimInboundMessage();
      if (row) await this.process(row);
    })().catch((error) => safeLog("error", "WeChat inbound message processing failed.", { statusCode: error.statusCode, code: error.wecomCode }))
      .finally(() => {
        this.activeTask = null;
        if (!this.running) return;
        this.timer = setTimeout(() => void this.work(), this.pollIntervalMs);
        this.timer.unref?.();
      });
    return this.activeTask;
  }

  async sendText({ openKfId, externalUserId, externalHash, stableId, content }) {
    const reservation = await reserveOutboundMessage({ openKfId, externalUserIdHash: externalHash, messageId: stableId });
    if (!reservation) return { sent: false, limited: true };
    if (reservation.status === "sent") return { sent: true, reused: true };
    if (!reservation.allowed) return { sent: false, unknown: reservation.status === "unknown" };
    try {
      await this.api.sendText(openKfId, externalUserId, truncateUtf8(content), reservation.id);
      await completeOutboundMessage(reservation.id, { sent: true });
      return { sent: true };
    } catch (error) {
      await completeOutboundMessage(reservation.id, {
        unknown: !error.statusCode || error.statusCode >= 500,
        errorCode: error.wecomCode,
        error: error.message,
      });
      throw error;
    }
  }

  async process(row) {
    const payload = decryptPayload(row.payload_enc, this.config.dataEncryptionKey);
    const openKfId = row.open_kfid;
    const externalUserId = String(payload.external_userid || "");
    const externalHash = row.external_userid_hash;
    const upstreamMessageId = row.upstream_msg_id;
    if (!externalUserId) throw Object.assign(new Error("Inbound customer identity is missing."), { statusCode: 400 });

    try {
      const pendingCloudRequest = Boolean(row.cloud_request_id);
      if (!pendingCloudRequest) {
        await this.processNewMessage({ row, payload, openKfId, externalUserId, externalHash, upstreamMessageId });
      } else {
        await this.pollCloudMessage({ row, payload, openKfId, externalUserId, externalHash, upstreamMessageId });
      }
    } catch (error) {
      const terminal = (error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 409 && error.statusCode !== 429) || row.attempts >= 100;
      await retryInboundMessage(row.id, { attempts: row.attempts, error: error.message, terminal });
      safeLog("error", "WeChat inbound message will be retried or held for review.", {
        statusCode: error.statusCode,
        code: error.wecomCode,
        attempts: row.attempts,
        messageId: upstreamMessageId,
      });
    }
  }

  async processNewMessage({ row, payload, openKfId, externalUserId, externalHash, upstreamMessageId }) {
    const message = payload;
    if (message.origin != null && Number(message.origin) !== 3) {
      await finishInboundMessage(row.id);
      return;
    }

    const text = messageText(message);
    const code = extractLinkCode(text);
    if (code) {
      const result = await this.bridge.claimBinding({ code, openKfId, externalUserId });
      await this.sendText({
        openKfId,
        externalUserId,
        externalHash,
        stableId: `bind-${upstreamMessageId}`,
        content: result.ok === false ? "绑定码无效或已过期，请回到 OverTree 重新生成。" : "微信已绑定到你的 OverTree 账号。现在可以直接发送问题；新会话和文件都会进入你选定的云端项目。",
      });
      await finishInboundMessage(row.id);
      return;
    }

    let binding;
    try {
      binding = await this.bridge.resolveBinding({ openKfId, externalUserId });
    } catch (error) {
      if (error.statusCode === 404) {
        await this.sendText({
          openKfId,
          externalUserId,
          externalHash,
          stableId: `unbound-${upstreamMessageId}`,
          content: "请先在 OverTree 云端登录后选择项目并绑定微信。绑定时会显示一次性验证码；在此客服会话中发送该验证码即可完成绑定。",
        });
        await finishInboundMessage(row.id);
        return;
      }
      throw error;
    }

    const attachments = [];
    for (const attachment of attachmentDetails(message)) {
      const file = attachment.mediaType === "file"
        ? await this.api.downloadCustomerServiceFile(attachment.mediaId, this.config.maxMediaBytes)
        : await this.api.downloadMedia(attachment.mediaId, this.config.maxMediaBytes);
      const filename = path.basename(attachment.name || file.filename);
      const stored = await this.bridge.uploadAttachment({
        openKfId,
        externalUserId,
        messageId: upstreamMessageId,
        filename,
        contentType: file.contentType,
        buffer: file.buffer,
      });
      attachments.push(stored);
    }
    const content = [messageText(message, attachments), ...attachments.map((file) => `附件已保存到项目：${file.path || file.name || "wechat-inbox/"}`)].filter(Boolean).join("\n\n");
    if (!content) throw Object.assign(new Error("The incoming WeChat message is empty."), { statusCode: 400 });

    const receipt = await this.bridge.submitMessage({
      openKfId,
      externalUserId,
      messageId: upstreamMessageId,
      content,
      attachments,
    });
    const state = cloudStatus(receipt);
    if (state === "finished" || state === "completed" || state === "failed") {
      await this.deliverCloudResult({ row, receipt, openKfId, externalUserId, externalHash, upstreamMessageId });
      return;
    }
    await markInboundSubmitted(row.id, { cloudRequestId: String(receipt.messageId || upstreamMessageId), delaySeconds: 3 });
    const ageMs = Date.now() - new Date(row.received_at).getTime();
    if (ageMs >= this.config.ackDelayMs) {
      const ack = await this.sendText({
        openKfId,
        externalUserId,
        externalHash,
        stableId: `ack-${upstreamMessageId}`,
        content: "已收到，OverTree 正在处理，完成后会把结果发回这里。",
      });
      if (ack.sent) await markInboundAcked(row.id, { delaySeconds: 3 });
    }
  }

  async pollCloudMessage({ row, payload, openKfId, externalUserId, externalHash, upstreamMessageId }) {
    const receipt = await this.bridge.getMessage({
      openKfId,
      externalUserId,
      messageId: row.cloud_request_id,
    });
    const state = cloudStatus(receipt);
    if (state === "running" || state === "queued" || state === "processing") {
      if (!row.ack_sent_at && Date.now() - new Date(row.received_at).getTime() >= this.config.ackDelayMs) {
        const ack = await this.sendText({
          openKfId,
          externalUserId,
          externalHash,
          stableId: `ack-${upstreamMessageId}`,
          content: "已收到，OverTree 正在处理，完成后会把结果发回这里。",
        });
        if (ack.sent) await markInboundAcked(row.id, { delaySeconds: 4 });
        else await markInboundSubmitted(row.id, { cloudRequestId: row.cloud_request_id, delaySeconds: 10 });
      } else {
        await markInboundSubmitted(row.id, { cloudRequestId: row.cloud_request_id, delaySeconds: 4 });
      }
      return;
    }
    await this.deliverCloudResult({ row, receipt, openKfId, externalUserId, externalHash, upstreamMessageId });
  }

  async deliverCloudResult({ row, receipt, openKfId, externalUserId, externalHash, upstreamMessageId }) {
    const failed = ["failed", "error"].includes(cloudStatus(receipt));
    const content = failed
      ? "这次 OverTree 任务没有完成。请稍后重试，或打开 OverTree 查看任务状态。"
      : String(receipt.result || receipt.reply || "OverTree 已完成处理，但没有返回可发送的文字摘要。请打开 OverTree 项目查看完整结果和文件。");
    const fileLinks = Array.isArray(receipt.files)
      ? receipt.files.map((file) => String(file.url || "")).filter(Boolean)
      : [];
    const linksText = fileLinks.map((url) => `文件下载：${url}`).join("\n\n");
    const linksBytes = new TextEncoder().encode(linksText).length;
    const summary = truncateUtf8(content, Math.max(100, 1800 - linksBytes - 150));
    const result = await this.sendText({
      openKfId,
      externalUserId,
      externalHash,
      stableId: `result-${upstreamMessageId}`,
      content: [summary, linksText].filter(Boolean).join("\n\n"),
    });
    if (result.limited) {
      await markInboundSubmitted(row.id, { cloudRequestId: row.cloud_request_id || upstreamMessageId, delaySeconds: 60 });
      return;
    }
    if (!result.sent) throw Object.assign(new Error("WeChat Customer Service could not confirm message delivery."), { statusCode: 503 });
    await finishInboundMessage(row.id, { cloudRequestId: String(receipt.messageId || upstreamMessageId) });
  }
}

export { attachmentDetails, messageText, truncateUtf8 };
