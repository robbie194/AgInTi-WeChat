import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { downloadAndStoreGroupAttachments, downloadGroupMedia, groupBindCode, groupMediaAttachments, groupMessageText, groupMixedImages, mediaContentType, stripBotMention, truncateMarkdown } from "../src/smart-bot.js";
import { messageText, truncateUtf8 } from "../src/customer-service.js";

test("group bot command parsing removes a leading mention and validates bind codes", () => {
  const content = stripBotMention("@OverTree 绑定群 ABCDEFGH");
  assert.equal(content, "绑定群 ABCDEFGH");
  assert.equal(groupBindCode(content), "ABCDEFGH");
  assert.equal(groupBindCode("绑定群 01234567"), "");
});

test("message formatting stays within byte limits without breaking UTF-8", () => {
  const value = "论文分析🙂".repeat(500);
  assert.ok(Buffer.byteLength(truncateUtf8(value), "utf8") <= 1800);
  assert.ok(Buffer.byteLength(truncateMarkdown(value), "utf8") <= 15_000);
  assert.equal(messageText({ msgtype: "voice", voice: { content: "识别出的语音" } }), "识别出的语音");
});

test("group mixed text and image messages retain text and Cloud attachment paths", () => {
  const body = {
    msgtype: "mixed",
    mixed: {
      msg_item: [
        { msgtype: "text", text: { content: "@OverTree 请看这张图" } },
        { msgtype: "image", image: { url: "https://media.example/image", aeskey: "image-key" } },
        { msgtype: "text", text: { content: "给我解释一下" } },
      ],
    },
  };
  const images = groupMixedImages(body);
  const prompt = groupMessageText(body, [{ itemIndex: 1, path: "wechat-inbox/binding/hash-0-image.png" }]);

  assert.equal(images.length, 1);
  assert.equal(images[0].item.image.aeskey, "image-key");
  assert.equal(images[0].itemIndex, 1);
  assert.equal(images[0].attachmentIndex, 0);
  assert.equal(prompt, "请看这张图\n[图片已保存到项目：wechat-inbox/binding/hash-0-image.png]\n给我解释一下");
  assert.equal(mediaContentType("photo.JPG"), "image/jpeg");
});

test("group mixed image paths remain attached to the right image when some images are unavailable or capped", () => {
  const body = {
    msgtype: "mixed",
    mixed: {
      msg_item: [
        { msgtype: "image", image: {} },
        ...Array.from({ length: 11 }, (_, index) => ({
          msgtype: "image",
          image: { url: `https://media.example/${index}`, aeskey: `key-${index}` },
        })),
      ],
    },
  };
  const images = groupMixedImages(body);
  const prompt = groupMessageText(body, [{ itemIndex: images[0].itemIndex, path: "wechat-inbox/binding/hash-0-first.png" }]);

  assert.equal(images.length, 10);
  assert.equal(images[0].itemIndex, 1);
  assert.equal(images[0].attachmentIndex, 0);
  assert.equal(images.at(-1).itemIndex, 10);
  assert.equal(images.at(-1).attachmentIndex, 9);
  assert.match(prompt, /^\[图片未能保存到项目\]\n\[图片已保存到项目：wechat-inbox\/binding\/hash-0-first\.png\]/);
  assert.match(prompt, /\[图片未能保存到项目\]$/);
});

test("group file messages are decrypted, stored in the selected Cloud project, and referenced in the prompt", async () => {
  const body = {
    msgtype: "file",
    file: { url: "https://media.example/encrypted", aeskey: "file-key" },
  };
  const downloads = [];
  const uploads = [];
  const attachments = await downloadAndStoreGroupAttachments({
    body,
    downloadFile: async (url, aeskey, options) => {
      downloads.push({ url, aeskey, maxBytes: options.maxBytes });
      return { buffer: Buffer.from("%PDF-test"), filename: "C:\\temp\\report.pdf" };
    },
    bridge: {
      async uploadAttachment(input) {
        uploads.push(input);
        return { path: "wechat-inbox/binding/report.pdf", name: input.filename, contentType: input.contentType, size: input.buffer.length };
      },
    },
    botId: "bot-id",
    chatId: "chat-id",
    messageId: "upstream-id",
    maxBytes: 1024,
  });

  assert.deepEqual(downloads, [{ url: "https://media.example/encrypted", aeskey: "file-key", maxBytes: 1024 }]);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].channel, "wecom_smart_bot_group");
  assert.equal(uploads[0].messageId, "group-upstream-id");
  assert.equal(uploads[0].filename, "report.pdf");
  assert.equal(uploads[0].contentType, "application/pdf");
  assert.equal(uploads[0].buffer.toString(), "%PDF-test");
  assert.equal(attachments[0].itemIndex, null);
  assert.match(groupMessageText(body, attachments), /report\.pdf.*已保存到项目：wechat-inbox\/binding\/report\.pdf/);
  assert.equal(mediaContentType("clip.MP4"), "video/mp4");
});

test("group video messages are stored as video attachments", async () => {
  const body = { msgtype: "video", video: { url: "https://media.example/video", aeskey: "video-key" } };
  let uploaded;
  const attachments = await downloadAndStoreGroupAttachments({
    body,
    downloadFile: async () => ({ buffer: Buffer.from("video-bytes"), filename: "clip.mp4" }),
    bridge: { async uploadAttachment(input) { uploaded = input; return { path: "wechat-inbox/binding/clip.mp4", name: input.filename, contentType: input.contentType }; } },
    botId: "bot-id",
    chatId: "chat-id",
    messageId: "video-message",
    maxBytes: 1024,
  });

  assert.equal(uploaded.contentType, "video/mp4");
  assert.equal(uploaded.messageId, "group-video-message");
  assert.equal(attachments[0].mediaType, "video");
  assert.match(groupMessageText(body, attachments), /视频.*已保存到项目/);
});

test("an unavailable mixed image does not discard its accompanying text", async () => {
  const body = {
    msgtype: "mixed",
    mixed: {
      msg_item: [
        { msgtype: "text", text: { content: "@OverTree 请解释附件" } },
        { msgtype: "image", image: { url: "https://media.example/image-without-key" } },
      ],
    },
  };
  const attachments = await downloadAndStoreGroupAttachments({
    body,
    downloadFile: async () => { assert.fail("An image without an AES key must not be downloaded."); },
    bridge: { async uploadAttachment() { assert.fail("An image without an AES key must not be uploaded."); } },
    botId: "bot-id",
    chatId: "chat-id",
    messageId: "upstream-id",
    maxBytes: 1024,
  });

  assert.deepEqual(groupMediaAttachments(body), [{
    itemIndex: 1,
    attachmentIndex: 0,
    item: { msgtype: "image", image: { url: "https://media.example/image-without-key" } },
    mediaType: "image",
  }]);
  assert.equal(attachments.length, 0);
  assert.equal(groupMessageText(body, attachments), "请解释附件\n[图片未能保存到项目]");
  assert.equal(groupMixedImages(body).length, 1);
});

test("WeCom voice messages preserve the recognized transcript in the group session", () => {
  assert.equal(groupMessageText({ msgtype: "voice", voice: { content: "@OverTree 请总结刚才的讨论" } }), "请总结刚才的讨论");
});

test("bounded WeCom media download decrypts the response and preserves its filename", async () => {
  const key = crypto.randomBytes(32);
  const aesKey = key.toString("base64");
  const content = Buffer.from("project attachment bytes");
  const padding = 32 - (content.length % 32);
  const plain = Buffer.concat([content, Buffer.alloc(padding, padding)]);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  let requestedUrl = "";
  const result = await downloadGroupMedia("https://media.example/file", aesKey, {
    maxBytes: 1024,
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      assert.equal(options.redirect, "follow");
      return new Response(encrypted, {
        status: 200,
        headers: {
          "content-disposition": "attachment; filename*=UTF-8''project%20notes.pdf",
          "content-length": String(encrypted.length),
        },
      });
    },
  });

  assert.equal(requestedUrl, "https://media.example/file");
  assert.deepEqual(result.buffer, content);
  assert.equal(result.filename, "project notes.pdf");
});

test("bounded WeCom media download cancels an oversized streamed response", async () => {
  await assert.rejects(downloadGroupMedia("https://media.example/large", "unused-key", {
    maxBytes: 16,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: "https://media.example/large",
      headers: new Headers(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.alloc(40));
          controller.enqueue(Buffer.alloc(40));
        },
      }),
    }),
  }), (error) => error.statusCode === 413);
});
