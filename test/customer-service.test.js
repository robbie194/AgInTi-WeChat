import test from "node:test";
import assert from "node:assert/strict";
import { attachmentDetails, bindingClaimReply, messageText, validateCloudDeliveryPlan, weComSendMessageId } from "../src/customer-service.js";
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

test("Customer Service gives recovery instructions for an already-bound WeChat account", () => {
  assert.match(bindingClaimReply({ ok: false, reason: "already_bound" }), /微信客服账号已绑定 OverTree 会话/);
  assert.match(bindingClaimReply({ ok: false, reason: "already_bound" }), /「微信连接」/);
  assert.match(bindingClaimReply({ ok: false, reason: "already_bound" }), /取消当前连接/);
  assert.match(bindingClaimReply({ ok: false }), /绑定码无效或已过期/);
  assert.match(bindingClaimReply({ ok: true }), /微信已绑定到你的 OverTree 账号/);
});

test("Customer Service accepts only a bounded, versioned Cloud delivery plan", () => {
  const plan = {
    version: 1,
    limits: { maxTextBytes: 1800, maxMessages: 5, maxMediaFiles: 4, maxArtifactBytes: 50 * 1024 * 1024 },
    textParts: ["结果🙂"],
    files: [{
      name: "report.pdf", url: "https://cloud.example/file", mediaType: "file",
      maxBytes: 50 * 1024 * 1024, size: 1200,
    }],
  };
  assert.equal(validateCloudDeliveryPlan({ deliveryPlan: plan }), plan);
  assert.throws(() => validateCloudDeliveryPlan({ deliveryPlan: { ...plan, textParts: ["🙂".repeat(500)] } }), /unsupported/);
  assert.throws(() => validateCloudDeliveryPlan({ deliveryPlan: { ...plan, version: 2 } }), /unsupported/);
  assert.throws(() => validateCloudDeliveryPlan({ deliveryPlan: {
    ...plan,
    limits: { ...plan.limits, maxArtifactBytes: 100 * 1024 * 1024 },
  } }), /unsupported/);
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

test("non-text customer input replies locally before any Cloud or attachment access", async (t) => {
  const { CustomerServiceProcessor } = await import("../src/customer-service.js");
  const finished = [];
  t.mock.method(pool, "query", async (sql, values) => { finished.push({ sql, values }); return { rows: [] }; });
  const noCalls = new Proxy({}, { get: (_target, key) => () => assert.fail(`Unexpected Cloud/media call: ${String(key)}`) });
  const worker = new CustomerServiceProcessor({ config: {}, api: noCalls, bridge: noCalls });
  const sent = [];
  worker.sendText = async (message) => { sent.push(message); return { sent: true }; };
  for (const msgtype of ["voice", "image", "file", "video", "location", "link", "mixed", "unknown", undefined]) {
    await worker.processNewMessage({ row: { id: 1 }, payload: {
      origin: 3, msgtype, voice: { content: "ABC23456" }, text: { content: "ABC23456" },
      mixed: { msg_item: [{ msgtype: "text", text: { content: "ABC23456" } }] },
    }, openKfId: "kf", externalUserId: "user", externalHash: "hash", upstreamMessageId: `source-${msgtype}` });
  }
  assert.equal(sent.length, 9);
  assert.ok(sent.every((item) => item.content === "暂时只支持文字消息，请用文字描述你的问题。"));
  assert.ok(sent.every((item) => item.stableId.startsWith("unsupported-source-")));
  assert.equal(finished.length, 9);
  // Agent/system events must remain silent.
  await worker.processNewMessage({ row: { id: 2 }, payload: { origin: 5, msgtype: "image" } });
  assert.equal(sent.length, 9);
});

test("text binding messages still use the normal Cloud binding path", async (t) => {
  const { CustomerServiceProcessor } = await import("../src/customer-service.js");
  t.mock.method(pool, "query", async () => ({ rows: [] }));
  const claims = [];
  const worker = new CustomerServiceProcessor({ config: {}, api: {}, bridge: {
    claimBinding: async (body) => { claims.push(body); return { ok: true }; },
  } });
  worker.sendText = async () => ({ sent: true });
  await worker.processNewMessage({ row: { id: 1 }, payload: { origin: 3, msgtype: "text", text: { content: "ABC23456" } },
    openKfId: "kf", externalUserId: "user", externalHash: "hash", upstreamMessageId: "text-code" });
  assert.deepEqual(claims, [{ code: "ABC23456", openKfId: "kf", externalUserId: "user" }]);
});
