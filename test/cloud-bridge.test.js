import test from "node:test";
import assert from "node:assert/strict";
import { cloudBridgeSignature, verifyCloudBridgeSignature } from "../src/cloud-bridge.js";

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
