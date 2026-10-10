import test from "node:test";
import assert from "node:assert/strict";
import { attachmentDetails, messageText, weComSendMessageId } from "../src/customer-service.js";
import { pool, reserveOutboundMessage } from "../src/db.js";

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

async function reserveWithDatabaseStub(t, { existing = [], quota = { window_open: true, count: 0 } } = {}) {
  const statements = [];
  const client = {
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (sql.includes("SELECT id,status FROM wechat_outbound_messages")) return { rows: existing };
      if (sql.includes("WITH latest_inbound AS")) return { rows: [quota] };
      return { rows: [] };
    },
    release() {},
  };
  t.mock.method(pool, "connect", async () => client);
  const result = await reserveOutboundMessage({ openKfId: "kf-test", externalUserIdHash: "peer-hash", messageId: "message-1" });
  return { result, statements };
}

test("a new customer message resets the outbound quota for the new 48-hour reply window", async (t) => {
  const { result, statements } = await reserveWithDatabaseStub(t, {
    quota: { window_open: true, count: 0 },
  });

  assert.equal(result.allowed, true);
  const quotaQuery = statements.find((entry) => entry.sql.includes("WITH latest_inbound AS"));
  assert.ok(quotaQuery.sql.includes("max(received_at)"));
  assert.ok(quotaQuery.sql.includes("wechat_inbound_messages"));
  assert.ok(quotaQuery.sql.includes("outbound.sent_at,outbound.created_at) > latest_inbound.received_at"));
});

test("the official five-message cap still applies within the current reply window", async (t) => {
  const { result } = await reserveWithDatabaseStub(t, {
    quota: { window_open: true, count: 5 },
  });

  assert.equal(result, null);
});

test("outbound replies wait for a new customer message after the 48-hour window expires", async (t) => {
  const { result } = await reserveWithDatabaseStub(t, {
    quota: { window_open: false, count: 0 },
  });

  assert.equal(result, null);
});
