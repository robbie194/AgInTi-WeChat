import crypto from "node:crypto";
import { decryptFile, WSClient } from "@wecom/aibot-node-sdk";
import { config as defaultConfig } from "./config.js";
import { cloudArtifactKind, cloudResultIdempotencyKey, isFailedCloudState } from "./cloud-bridge.js";
import { decryptPayload } from "./encryption.js";
import {
  claimSmartBotMessage,
  completeGroupOutbound,
  finishSmartBotMessage,
  markSmartBotAcked,
  markSmartBotSubmitted,
  reserveGroupOutbound,
  retrySmartBotMessage,
  saveSmartBotMessage,
} from "./db.js";

function log(level, message, fields = {}) {
  const safe = Object.fromEntries(Object.entries(fields).filter(([key]) => /status|code|attempt|messageid/i.test(key)));
  console[level](message, safe);
}

function cleanMessage(value) {
  return String(value || "").replace(/\u0000/g, "").trim();
}

function stripBotMention(value) {
  return cleanMessage(value)
    .replace(/^\s*<at[^>]*>.*?<\/at>\s*/i, "")
    .replace(/^\s*<at[^>]*\/?>\s*/i, "")
    .replace(/^\s*@[\p{L}\p{N}_-]+\s*/u, "")
    .trim();
}

function groupMentionText(body = {}) {
  if (body.msgtype === "text") return [body.text?.content];
  if (body.msgtype === "voice") return [body.voice?.content];
  if (body.msgtype === "mixed") {
    return (Array.isArray(body.mixed?.msg_item) ? body.mixed.msg_item : [])
      .filter((item) => item?.msgtype === "text")
      .map((item) => item.text?.content);
  }
  return [];
}

function groupBotMentioned(body = {}) {
  if (body.chattype !== "group") return true;
  return groupMentionText(body).some((value) => /^(?:\s*<at\b[^>]*(?:\/>|>.*?<\/at>)|\s*@[\p{L}\p{N}_-]+)/iu.test(String(value || "")));
}

function truncateMarkdown(value, maxBytes = 15_000) {
  const text = String(value || "");
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let output = "";
  for (const character of text) {
    if (encoder.encode(output + character).length > maxBytes - 100) break;
    output += character;
  }
  return `${output}\n\n> 内容较长，已在 OverTree 会话中保存完整结果。`;
}

function statusOf(payload) {
  return String(payload.status || payload.state || "running").toLowerCase();
}

function groupBindCode(content) {
  const match = cleanMessage(content).match(/^(?:绑定群|绑定群聊|bind\s+group)\s+([A-HJ-NP-Z2-9]{8})$/i);
  return match?.[1]?.toUpperCase() || "";
}

const GROUP_MEDIA_TYPES = new Set(["image", "file", "video"]);
const GROUP_MEDIA_LABELS = { image: "图片", file: "文件", video: "视频" };

function groupMediaAttachments(body = {}) {
  let attachmentIndex = 0;
  if (body.msgtype === "mixed") {
    return (Array.isArray(body.mixed?.msg_item) ? body.mixed.msg_item : [])
      .flatMap((item, itemIndex) => {
        if (item?.msgtype !== "image" || !item.image?.url || attachmentIndex >= 10) return [];
        const image = { itemIndex, attachmentIndex, item, mediaType: "image" };
        attachmentIndex += 1;
        return [image];
      });
  }
  if (!GROUP_MEDIA_TYPES.has(body.msgtype) || !body[body.msgtype]?.url) return [];
  return [{
    itemIndex: null,
    attachmentIndex: 0,
    mediaType: body.msgtype,
    item: { msgtype: body.msgtype, [body.msgtype]: body[body.msgtype] },
  }];
}

function groupMixedImages(body = {}) {
  return groupMediaAttachments(body).filter((attachment) => attachment.mediaType === "image");
}

function groupMessageText(body = {}, attachments = []) {
  if (body.msgtype === "text") return stripBotMention(body.text?.content);
  if (body.msgtype === "voice") {
    return stripBotMention(body.voice?.content || "群成员发送了一条语音消息，企业微信没有提供可用的转写文字。");
  }
  if (GROUP_MEDIA_TYPES.has(body.msgtype)) {
    const uploaded = attachments.find((attachment) => attachment.itemIndex === null && attachment.path);
    if (!uploaded) return `群成员发送的${GROUP_MEDIA_LABELS[body.msgtype]}未能保存到项目。`;
    const name = String(uploaded.name || "").trim();
    return `群成员发送的${GROUP_MEDIA_LABELS[body.msgtype]}${name ? `（${name}）` : ""}已保存到项目：${uploaded.path}`;
  }
  if (body.msgtype !== "mixed") return "";
  const attachmentByItemIndex = new Map(attachments
    .filter((attachment) => Number.isInteger(attachment?.itemIndex))
    .map((attachment) => [attachment.itemIndex, attachment]));
  const parts = (Array.isArray(body.mixed?.msg_item) ? body.mixed.msg_item : []).map((item, itemIndex) => {
    if (item?.msgtype === "text") return cleanMessage(item.text?.content);
    if (item?.msgtype !== "image") return "";
    const uploaded = attachmentByItemIndex.get(itemIndex);
    return uploaded?.path ? `[图片已保存到项目：${uploaded.path}]` : "[图片未能保存到项目]";
  }).filter(Boolean);
  return stripBotMention(parts.join("\n"));
}

function mediaContentType(filename = "") {
  const extension = String(filename).toLowerCase().match(/\.[a-z0-9]{1,8}$/)?.[0] || "";
  return ({
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
    ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  })[extension] || "application/octet-stream";
}

function nonRetryableMediaError(error) {
  const statusCode = Number(error?.statusCode || error?.response?.status);
  return statusCode >= 400 && statusCode < 500 && ![408, 409, 425, 429].includes(statusCode);
}

function attachmentFilename(headers) {
  const disposition = String(headers.get("content-disposition") || "");
  const utf8 = disposition.match(/filename\*=UTF-8''([^;\s]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";\s]+)"?/i)?.[1];
  let filename = utf8 || plain || "";
  if (utf8) {
    try { filename = decodeURIComponent(utf8); } catch {}
  }
  return String(filename).split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 160);
}

async function downloadGroupMedia(url, aesKey, { maxBytes, fetchImpl = fetch } = {}) {
  let parsedUrl;
  try { parsedUrl = new URL(String(url)); }
  catch { throw Object.assign(new Error("WeCom attachment URL is invalid."), { statusCode: 400 }); }
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password) {
    throw Object.assign(new Error("WeCom attachment URL is not a secure HTTPS URL."), { statusCode: 400 });
  }
  const response = await fetchImpl(parsedUrl, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error("WeCom attachment download failed."), { statusCode: response.status });
  }
  if (response.url && new URL(response.url).protocol !== "https:") {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error("WeCom attachment download left HTTPS."), { statusCode: 400 });
  }
  const maxEncryptedBytes = maxBytes + 32;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(contentLength) && contentLength > maxEncryptedBytes) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error("WeCom attachment exceeds the configured media limit."), { statusCode: 413 });
  }
  const reader = response.body?.getReader();
  if (!reader) throw Object.assign(new Error("WeCom attachment response has no body."), { statusCode: 502 });
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxEncryptedBytes) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error("WeCom attachment exceeds the configured media limit."), { statusCode: 413 });
    }
    chunks.push(Buffer.from(value));
  }
  let buffer;
  try { buffer = decryptFile(Buffer.concat(chunks, size), aesKey); }
  catch { throw Object.assign(new Error("WeCom attachment could not be decrypted."), { statusCode: 422 }); }
  if (buffer.length > maxBytes) throw Object.assign(new Error("WeCom attachment exceeds the configured media limit."), { statusCode: 413 });
  return { buffer, filename: attachmentFilename(response.headers) };
}

async function downloadAndStoreGroupAttachments({ body, downloadFile = downloadGroupMedia, bridge, botId, chatId, messageId, maxBytes }) {
  const storedAttachments = [];
  for (const candidate of groupMediaAttachments(body)) {
    const media = candidate.item[candidate.mediaType] || {};
    if (!media.url || !media.aeskey) continue;
    let file;
    try {
      file = await downloadFile(media.url, media.aeskey, { maxBytes });
    } catch (error) {
      if (nonRetryableMediaError(error)) continue;
      throw error;
    }
    if (!Buffer.isBuffer(file?.buffer) || !file.buffer.length) {
      throw Object.assign(new Error("WeCom Smart Bot returned an empty group attachment."), { statusCode: 502 });
    }
    if (file.buffer.length > maxBytes) continue;
    const fallback = `wechat-group-${candidate.mediaType}-${candidate.attachmentIndex + 1}${candidate.mediaType === "image" ? ".jpg" : candidate.mediaType === "video" ? ".mp4" : ".bin"}`;
    const filename = String(file.filename || fallback).split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 160) || fallback;
    let stored;
    try {
      stored = await bridge.uploadAttachment({
        channel: "wecom_smart_bot_group",
        botId,
        chatId,
        messageId: `group-${messageId}`,
        attachmentIndex: candidate.attachmentIndex,
        filename,
        contentType: mediaContentType(filename),
        buffer: file.buffer,
      });
    } catch (error) {
      if (nonRetryableMediaError(error)) continue;
      throw error;
    }
    storedAttachments.push({ ...stored, itemIndex: candidate.itemIndex, mediaType: candidate.mediaType });
  }
  return storedAttachments;
}

export class SmartBotGroupProcessor {
  constructor({ config = defaultConfig, bridge, clientFactory = (options) => new WSClient(options), pollIntervalMs = 800 }) {
    this.config = config;
    this.bridge = bridge;
    this.clientFactory = clientFactory;
    this.pollIntervalMs = pollIntervalMs;
    this.client = null;
    this.ready = false;
    this.running = false;
    this.timer = null;
    this.activeTask = null;
  }

  start() {
    if (!this.config.groupBotEnabled || this.running) return;
    this.running = true;
    this.client = this.clientFactory({
      botId: this.config.groupBotId,
      secret: this.config.groupBotSecret,
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: 5,
      heartbeatInterval: 30_000,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
    });
    this.client.on("authenticated", () => {
      this.ready = true;
      log("info", "WeCom Smart Bot connected.");
    });
    this.client.on("message.text", (frame) => void this.receive(frame));
    this.client.on("message.mixed", (frame) => void this.receive(frame));
    this.client.on("message.image", (frame) => void this.receive(frame));
    this.client.on("message.file", (frame) => void this.receive(frame));
    this.client.on("message.voice", (frame) => void this.receive(frame));
    this.client.on("message.video", (frame) => void this.receive(frame));
    this.client.on("event.enter_chat", () => log("info", "A WeCom Smart Bot conversation was opened."));
    this.client.on("error", (error) => {
      this.ready = false;
      log("error", "WeCom Smart Bot socket failed.", { code: error?.code, statusCode: error?.statusCode });
    });
    this.client.connect();
    void this.work();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.client?.disconnect();
    this.ready = false;
    if (this.activeTask) await this.activeTask.catch(() => {});
  }

  async receive(frame) {
    const body = frame?.body || {};
    if (body.chattype !== "group" || !body.chatid || !body.msgid) return;
    try {
      await saveSmartBotMessage(this.config.groupBotId, frame);
      if (this.running && !this.activeTask) void this.work();
    } catch (error) {
      log("error", "WeCom Smart Bot group message could not be queued.", { statusCode: error.statusCode, code: error.code });
    }
  }

  async sendGroupText({ chatId, idempotencyKey, content }) {
    const reservation = await reserveGroupOutbound({
      botId: this.config.groupBotId,
      chatId,
      idempotencyKey,
    });
    if (!reservation) return { sent: false, limited: true };
    if (reservation.status === "sent") return { sent: true, reused: true };
    if (!reservation.allowed) return { sent: false, unknown: reservation.status === "unknown" };
    try {
      const response = await this.client.sendMessage(chatId, {
        chat_type: 2,
        msgtype: "markdown",
        markdown: { content: truncateMarkdown(content) },
      });
      if (Number(response?.errcode || 0) !== 0) {
        const error = new Error(String(response?.errmsg || "WeCom Smart Bot did not accept the reply."));
        error.wecomCode = response?.errcode;
        throw error;
      }
      await completeGroupOutbound(reservation.id, { sent: true });
      return { sent: true };
    } catch (error) {
      await completeGroupOutbound(reservation.id, {
        unknown: !error.wecomCode && !error.statusCode,
        error: error.message,
      });
      throw error;
    }
  }

  async sendGroupMedia({ chatId, idempotencyKey, type, buffer, filename }) {
    const reservation = await reserveGroupOutbound({
      botId: this.config.groupBotId,
      chatId,
      idempotencyKey,
    });
    if (!reservation) return { sent: false, limited: true };
    if (reservation.status === "sent") return { sent: true, reused: true };
    if (!reservation.allowed) return { sent: false, unknown: reservation.status === "unknown" };
    try {
      const uploaded = await this.client.uploadMedia(buffer, { type, filename });
      const response = await this.client.sendMediaMessage(chatId, type, uploaded.media_id);
      if (Number(response?.errcode || 0) !== 0) {
        const error = new Error(String(response?.errmsg || "WeCom Smart Bot did not accept the media reply."));
        error.wecomCode = response?.errcode;
        throw error;
      }
      await completeGroupOutbound(reservation.id, { sent: true });
      return { sent: true };
    } catch (error) {
      await completeGroupOutbound(reservation.id, {
        unknown: !error.wecomCode && !error.statusCode,
        error: error.message,
      });
      throw error;
    }
  }

  async work() {
    if (!this.running || this.activeTask) return this.activeTask;
    this.activeTask = (async () => {
      const row = await claimSmartBotMessage(this.config.groupBotId);
      if (row) await this.process(row);
    })().catch((error) => log("error", "WeCom Smart Bot group message processing failed.", { statusCode: error.statusCode, code: error.wecomCode }))
      .finally(() => {
        this.activeTask = null;
        if (!this.running) return;
        this.timer = setTimeout(() => void this.work(), this.pollIntervalMs);
        this.timer.unref?.();
      });
    return this.activeTask;
  }

  async process(row) {
    const frame = decryptPayload(row.payload_enc, this.config.dataEncryptionKey);
    const body = frame.body || {};
    const chatId = String(body.chatid || "");
    const actorId = String(body.from?.userid || "");
    const content = groupMessageText(body);
    try {
      if (body.chattype !== "group" || !chatId) {
        await finishSmartBotMessage(row.id);
        return;
      }
      if (!groupBotMentioned(body)) {
        await finishSmartBotMessage(row.id);
        return;
      }
      if (!["text", "mixed", "image", "file", "video", "voice"].includes(body.msgtype)) {
        await this.sendGroupText({
          chatId,
          idempotencyKey: `unsupported-${body.msgid}`,
          content: "这类群消息暂时不能交给 OverTree 处理。请发文字、图片、文件、视频或带语音转写的消息。",
        });
        await finishSmartBotMessage(row.id);
        return;
      }
      if (row.cloud_request_id) {
        await this.pollCloudMessage({ row, body, chatId, actorId });
        return;
      }
      const code = groupBindCode(content);
      if (code) {
        const result = await this.bridge.claimGroupBinding({ code, botId: this.config.groupBotId, chatId, actorId });
        await this.sendGroupText({
          chatId,
          idempotencyKey: `bind-${body.msgid}`,
          content: result.ok === false ? "群绑定码无效或已过期，请在 OverTree 重新生成。" : "这个群已绑定到 OverTree 项目。群内成员可以 @OverTree 提问，消息和支持的附件会进入所选项目会话。",
        });
        await finishSmartBotMessage(row.id);
        return;
      }

      const groupIdentity = { botId: this.config.groupBotId, chatId };
      try {
        await this.bridge.resolveGroupBinding(groupIdentity);
      } catch (error) {
        if (error.statusCode === 404) {
          await this.sendGroupText({
            chatId,
            idempotencyKey: `unbound-${body.msgid}`,
            content: "此群还没有绑定 OverTree 项目。请项目所有者先在 OverTree 云端登录，选择项目并生成群绑定码，再在群里 @OverTree 绑定群 <验证码>。",
          });
          await finishSmartBotMessage(row.id);
          return;
        }
        throw error;
      }

      if (!content) {
        await this.sendGroupText({
          chatId,
          idempotencyKey: `empty-${body.msgid}`,
          content: "请在 @OverTree 后写出具体问题，我会把它发送到绑定的 OverTree 会话。",
        });
        await finishSmartBotMessage(row.id);
        return;
      }

      const attachments = await downloadAndStoreGroupAttachments({
        body,
        bridge: this.bridge,
        botId: this.config.groupBotId,
        chatId,
        messageId: body.msgid,
        maxBytes: this.config.maxMediaBytes,
      });
      const prompt = groupMessageText(body, attachments);

      const receipt = await this.bridge.submitMessage({
        channel: "wecom_smart_bot_group",
        botId: this.config.groupBotId,
        chatId,
        actorId,
        messageId: `group-${body.msgid}`,
        content: prompt,
        attachments,
      });
      const acknowledgement = await this.sendGroupText({
        chatId,
        idempotencyKey: `ack-${body.msgid}`,
        content: "已收到，OverTree 正在处理。完成后会把结果发到本群。",
      });
      await markSmartBotSubmitted(row.id, { cloudRequestId: String(receipt.messageId || `group-${body.msgid}`), delaySeconds: 3 });
      if (acknowledgement.sent) await markSmartBotAcked(row.id, { delaySeconds: 3 });
    } catch (error) {
      const terminal = (error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 409 && error.statusCode !== 429) || row.attempts >= 100;
      await retrySmartBotMessage(row.id, { attempts: row.attempts, error: error.message, terminal });
      log("error", "WeCom Smart Bot group event will be retried or held for review.", { statusCode: error.statusCode, code: error.wecomCode, attempts: row.attempts, messageId: body.msgid });
    }
  }

  async pollCloudMessage({ row, body, chatId, actorId }) {
    const receipt = await this.bridge.getMessage({
      channel: "wecom_smart_bot_group",
      botId: this.config.groupBotId,
      chatId,
      actorId,
      messageId: row.cloud_request_id,
    });
    const state = statusOf(receipt);
    if (["running", "queued", "processing"].includes(state)) {
      if (!row.ack_sent_at) {
        const acknowledgement = await this.sendGroupText({
          chatId,
          idempotencyKey: `ack-${body.msgid}`,
          content: "已收到，OverTree 正在处理。完成后会把结果发到本群。",
        });
        if (acknowledgement.sent) await markSmartBotAcked(row.id, { delaySeconds: 4 });
        else await markSmartBotSubmitted(row.id, { cloudRequestId: row.cloud_request_id, delaySeconds: 10 });
      } else {
        await markSmartBotSubmitted(row.id, { cloudRequestId: row.cloud_request_id, delaySeconds: 4 });
      }
      return;
    }

    const failed = isFailedCloudState(state);
    const result = failed
      ? state === "stopped"
        ? "这次 OverTree 任务因服务重启或停止而中断，结果没有完成。你可以稍后在 OverTree 会话中继续。"
        : "这次 OverTree 任务没有完成。请稍后重试，或打开 OverTree 查看任务状态。"
      : String(receipt.result || receipt.reply || "OverTree 已完成处理，请在已绑定的 Cloud 会话中查看完整记录。");
    const summary = truncateMarkdown(result);
    const delivery = await this.sendGroupText({
      chatId,
      idempotencyKey: cloudResultIdempotencyKey(receipt, body.msgid),
      content: summary,
    });
    if (!delivery.sent) {
      await markSmartBotSubmitted(row.id, { cloudRequestId: row.cloud_request_id, delaySeconds: 60 });
      return;
    }
    const artifacts = Array.isArray(receipt.files)
      ? receipt.files.filter((file) => cloudArtifactKind(file)).slice(0, 8)
      : [];
    for (const [index, file] of artifacts.entries()) {
      if (typeof this.bridge.downloadArtifact !== "function") break;
      try {
        const artifact = await this.bridge.downloadArtifact(file, { maxBytes: this.config.maxMediaBytes });
        const type = cloudArtifactKind({ ...file, name: artifact.filename, contentType: artifact.contentType });
        if (!type) continue;
        const media = await this.sendGroupMedia({
          chatId,
          idempotencyKey: `${cloudResultIdempotencyKey(receipt, body.msgid)}-artifact-${index}`,
          type,
          buffer: artifact.buffer,
          filename: artifact.filename,
        });
        if (media.limited) break;
        if (!media.sent) throw Object.assign(new Error("WeCom Smart Bot could not confirm media delivery."), { statusCode: 503 });
      } catch (error) {
        if (Number(error?.statusCode) >= 400 && Number(error.statusCode) < 500 && ![408, 409, 425, 429].includes(Number(error.statusCode))) continue;
        throw error;
      }
    }
    await finishSmartBotMessage(row.id);
  }
}

export function makeSmartBotClient(options) {
  return new WSClient(options);
}

export { downloadAndStoreGroupAttachments, downloadGroupMedia, groupBindCode, groupBotMentioned, groupMediaAttachments, groupMessageText, groupMixedImages, mediaContentType, stripBotMention, truncateMarkdown };
