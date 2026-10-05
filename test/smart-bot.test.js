import test from "node:test";
import assert from "node:assert/strict";
import { groupBindCode, stripBotMention, truncateMarkdown } from "../src/smart-bot.js";
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
