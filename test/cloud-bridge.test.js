import test from "node:test";
import assert from "node:assert/strict";
import { CloudBridgeClient, cloudBridgeSignature, verifyCloudBridgeSignature } from "../src/cloud-bridge.js";

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
