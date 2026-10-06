import test from "node:test";
import assert from "node:assert/strict";
import { groupBindCode, groupMessageText, groupMixedImages, mediaContentType, stripBotMention, truncateMarkdown } from "../src/smart-bot.js";
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
