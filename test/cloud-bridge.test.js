import test from "node:test";
import assert from "node:assert/strict";
import { CloudBridgeClient, cloudArtifactKind, cloudBridgeSignature, cloudResultIdempotencyKey, downloadCloudArtifact, isFailedCloudState, verifyCloudBridgeSignature } from "../src/cloud-bridge.js";

const secret = "a-32-character-test-secret-for-the-wechat-bridge";

test("Cloud bridge HMAC binds method, exact path, timestamp, nonce and body bytes", () => {
  const request = {
    method: "POST",
    path: "/internal/wechat/v1/messages?channel=group",
    timestamp: "1000",
    nonce: "0123456789abcdef0123456789",
    body: Buffer.from('{"messageId":"abc"}'),
  };
  const signature = cloudBridgeSignature({ ...request, secret });
  assert.equal(verifyCloudBridgeSignature({ ...request, signature, secret, now: 1_000_000 }), true);
  assert.equal(verifyCloudBridgeSignature({ ...request, path: "/internal/wechat/v1/messages", signature, secret, now: 1_000_000 }), false);
  assert.equal(verifyCloudBridgeSignature({ ...request, timestamp: "900", signature, secret, now: 1_000_000 }), false);
});

test("Cloud bridge includes the stable attachment index in signed media uploads", async () => {
  let requestURL = "";
  let requestOptions = null;
  const bridge = new CloudBridgeClient({
    baseURL: "http://cloud:3220",
    secret,
    fetchImpl: async (url, options) => {
      requestURL = url;
      requestOptions = options;
      return { ok: true, json: async () => ({ ok: true, path: "wechat-inbox/binding/hash-0-image.png" }) };
    },
  });

  await bridge.uploadAttachment({
    channel: "wecom_smart_bot_group",
    botId: "bot-test",
    chatId: "group-test",
    openKfId: "kf-test",
    externalUserId: "external-test",
    messageId: "message-test",
    attachmentIndex: 2,
    filename: "image.png",
    contentType: "image/png",
    buffer: Buffer.from("image-bytes"),
  });

  const url = new URL(requestURL);
  assert.equal(url.searchParams.get("channel"), "wecom_smart_bot_group");
  assert.equal(url.searchParams.get("botId"), "bot-test");
  assert.equal(url.searchParams.get("chatId"), "group-test");
  assert.equal(url.searchParams.get("attachmentIndex"), "2");
  assert.equal(requestOptions.method, "PUT");
  assert.equal(requestOptions.body.toString(), "image-bytes");
});

test("Cloud bridge carries personal-group and author identity without mixing WeCom IDs", async () => {
  let requestURL = "";
  let requestBody = null;
  const bridge = new CloudBridgeClient({
    baseURL: "http://cloud:3220",
    secret,
    fetchImpl: async (url, options) => {
      requestURL = url;
      requestBody = JSON.parse(options.body.toString());
      return { ok: true, json: async () => ({ ok: true, status: "running" }) };
    },
  });

  await bridge.submitPersonalGroupMessage({
    agentAccountId: "overtree-agent",
    groupId: "chatroom-123",
    actorId: "sender-456",
    actorRole: "support_member",
    actorName: "客服",
    messageId: "message_1.db:27",
    content: "补充问题",
  });

  assert.equal(new URL(requestURL).pathname, "/internal/wechat/personal-groups/v1/messages");
  assert.equal(requestBody.agentAccountId, "overtree-agent");
  assert.equal(requestBody.groupId, "chatroom-123");
  assert.equal(requestBody.actorRole, "support_member");
  assert.equal(requestBody.actorName, "客服");
  assert.equal(requestBody.channel, undefined);
});

test("personal-group claim, resolve, polling and attachments use their own signed namespace", async () => {
  const urls = [];
  const bridge = new CloudBridgeClient({
    baseURL: "http://cloud:3220",
    secret: "isolated-personal-group-secret-with-32-bytes",
    fetchImpl: async (url, options) => {
      urls.push({ url, method: options.method });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });

  await bridge.claimPersonalGroupBinding({ code: "ABCDEFGH", agentAccountId: "agent-1", groupId: "group-1" });
  await bridge.resolvePersonalGroupBinding({ agentAccountId: "agent-1", groupId: "group-1" });
  await bridge.getPersonalGroupMessage({ agentAccountId: "agent-1", groupId: "group-1", messageId: "message-1" });
  await bridge.uploadPersonalGroupAttachment({
    agentAccountId: "agent-1", groupId: "group-1", messageId: "message-1",
    filename: "image.png", contentType: "image/png", buffer: Buffer.from("image"),
  });

  assert.deepEqual(urls.map(({ url, method }) => [new URL(url).pathname, method]), [
    ["/internal/wechat/personal-groups/v1/bindings/claim", "POST"],
    ["/internal/wechat/personal-groups/v1/bindings/resolve", "GET"],
    ["/internal/wechat/personal-groups/v1/messages/message-1", "GET"],
    ["/internal/wechat/personal-groups/v1/attachments", "PUT"],
  ]);
});

test("one OverTree run produces one stable WeChat result id across queued messages", () => {
  const receipt = { responseId: "9a366262-ddf5-45a7-9a3a-bd3c91ed6412" };

  assert.equal(cloudResultIdempotencyKey(receipt, "event-1"), cloudResultIdempotencyKey(receipt, "event-2"));
  assert.notEqual(cloudResultIdempotencyKey({ responseId: "run-a" }, "event-1"), cloudResultIdempotencyKey({ responseId: "run-b" }, "event-1"));
  assert.equal(cloudResultIdempotencyKey({}, "event-1"), "result-event-1");
});

test("a stopped Cloud run is reported as an interruption instead of success", () => {
  assert.equal(isFailedCloudState("stopped"), true);
  assert.equal(isFailedCloudState("failed"), true);
  assert.equal(isFailedCloudState("finished"), false);
});

test("Cloud result artifacts only allow directly viewable media and small office files", () => {
  assert.equal(cloudArtifactKind({ name: "plot.PNG" }), "image");
  assert.equal(cloudArtifactKind({ name: "notes.txt" }), "file");
  assert.equal(cloudArtifactKind({ name: "draft.docx" }), "file");
  assert.equal(cloudArtifactKind({ name: "paper.pdf" }), "file");
  assert.equal(cloudArtifactKind({ name: "script.py", contentType: "text/plain" }), "");
  assert.equal(cloudArtifactKind({ name: "script.py", contentType: "application/pdf" }), "");
});

test("Cloud artifacts are downloaded with a size bound and preserved metadata", async () => {
  const result = await downloadCloudArtifact({ url: "https://cloud.example/wechat/files/token", name: "plot.png" }, {
    maxBytes: 1024,
    fetchImpl: async () => new Response(Buffer.from("png-bytes"), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "9" },
    }),
  });
  assert.equal(result.filename, "plot.png");
  assert.equal(result.contentType, "image/png");
  assert.equal(result.buffer.toString(), "png-bytes");
});
