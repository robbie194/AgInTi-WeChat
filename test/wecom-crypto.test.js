import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  callbackResponse,
  callbackSignature,
  decryptWeComMessage,
  encryptWeComMessage,
  parseXml,
  verifyCallbackSignature,
} from "../src/wecom-crypto.js";

const key = crypto.randomBytes(32);
const corpId = "ww-test-corp-id";
const token = "test-token-that-is-long-enough-for-callback";

test("WeCom AES callback messages round-trip and validate the CorpID", () => {
  const message = "<xml><Event><![CDATA[kf_msg_or_event]]></Event></xml>";
  const encrypted = encryptWeComMessage(message, { key, corpId });
  assert.equal(decryptWeComMessage(encrypted, { key, corpId }), message);
  assert.throws(() => decryptWeComMessage(encrypted, { key, corpId: "wrong-corp" }), /CorpID/);
});

test("WeCom callback signatures bind the token, timestamp, nonce and ciphertext", () => {
  const signature = callbackSignature(token, "100", "nonce", "ciphertext");
  assert.equal(verifyCallbackSignature({ token, timestamp: "100", nonce: "nonce", encrypted: "ciphertext", signature }), true);
  assert.equal(verifyCallbackSignature({ token, timestamp: "101", nonce: "nonce", encrypted: "ciphertext", signature }), false);
});

test("encrypted callback response contains a valid encrypted XML envelope", () => {
  const response = callbackResponse("success", { token, key, corpId, timestamp: "100", nonce: "nonce" });
  const parsed = parseXml(response);
  const encrypted = parsed.Encrypt["#cdata"];
  assert.equal(verifyCallbackSignature({
    token,
    timestamp: parsed.TimeStamp,
    nonce: parsed.Nonce["#cdata"],
    encrypted,
    signature: parsed.MsgSignature["#cdata"],
  }), true);
  assert.equal(decryptWeComMessage(encrypted, { key, corpId }), "success");
});
