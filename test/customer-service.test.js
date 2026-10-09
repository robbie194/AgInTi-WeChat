import test from "node:test";
import assert from "node:assert/strict";
import { attachmentDetails, messageText, weComSendMessageId } from "../src/customer-service.js";

test("mixed Customer Service messages retain text and extract supported media", () => {
  const message = {
    msgtype: "mixed",
    mixed: {
      msg_item: [
        { msgtype: "text", text: { content: "请看看这些材料" } },
        { msgtype: "image", image: { media_id: "image-media-id", name: "图表.png" } },
        { msgtype: "file", file: { media_id: "file-media-id", file_name: "论文.pdf" } },
      ],
    },
  };

  assert.deepEqual(attachmentDetails(message), [
    { mediaId: "image-media-id", mediaType: "image", name: "图表.png" },
    { mediaId: "file-media-id", mediaType: "file", name: "论文.pdf" },
  ]);
  assert.equal(messageText(message), "请看看这些材料\n[图片]\n[文件]");
});

test("WeCom send message IDs fit the 32-character API limit", () => {
  assert.equal(weComSendMessageId("a3ea895a-3725-4f3f-bf69-5957142993df"), "a3ea895a37254f3fbf695957142993df");
  assert.equal(weComSendMessageId("a3ea895a-3725-4f3f-bf69-5957142993df").length, 32);
});
