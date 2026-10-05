import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildTestCallbackXml, createWeComCallbackHandler } from "../src/wecom-callback.js";
import { callbackField, callbackSignature, decryptWeComMessage, encryptWeComMessage, parseXml } from "../src/wecom-crypto.js";

const key = crypto.randomBytes(32);
const config = {
  decodedAesKey: key,
  corpId: "ww-callback-test",
  callbackToken: "callback-token-long-enough-for-tests",
  openKfIds: ["kf-test"],
};

function mockResponse() {
  return {
    statusCode: 200,
    contentType: "",
    body: "",
    status(code) { this.statusCode = code; return this; },
    type(value) { this.contentType = value; return this; },
    send(value) { this.body = value; return this; },
  };
}

test("GET callback verification decrypts the echoed challenge", async () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "challenge-nonce";
  const echostr = encryptWeComMessage("test-echo", { key, corpId: config.corpId });
  const signature = callbackSignature(config.callbackToken, timestamp, nonce, echostr);
  const handler = createWeComCallbackHandler({ config });
  const response = mockResponse();
  await handler({
    method: "GET",
    query: { timestamp, nonce, msg_signature: signature, echostr },
    body: "",
  }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "test-echo");
});

test("POST callback verifies, decrypts the event, and returns encrypted success", async () => {
  const seen = [];
  const handler = createWeComCallbackHandler({ config, onEvent: async (event) => seen.push(event) });
  const fixture = buildTestCallbackXml({ Event: "kf_msg_or_event", OpenKfId: "kf-test", Token: "sync-token" }, config);
  const xml = `<xml><Encrypt><![CDATA[${fixture.encrypted}]]></Encrypt></xml>`;
  const response = mockResponse();
  await handler({
    method: "POST",
    query: { timestamp: fixture.timestamp, nonce: fixture.nonce, msg_signature: fixture.signature },
    body: Buffer.from(xml),
  }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen, [{ openKfId: "kf-test", callbackToken: "sync-token", eventType: "kf_msg_or_event" }]);
  const ack = parseXml(response.body);
  assert.equal(decryptWeComMessage(callbackField(response.body, "Encrypt"), { key, corpId: config.corpId }), "success");
  assert.ok(ack.MsgSignature);
});

test("callback rejects an invalid signature without invoking event handling", async () => {
  let invoked = false;
  const handler = createWeComCallbackHandler({ config, onEvent: async () => { invoked = true; } });
  const fixture = buildTestCallbackXml({ Event: "kf_msg_or_event", OpenKfId: "kf-test", Token: "sync-token" }, config);
  const response = mockResponse();
  await handler({
    method: "POST",
    query: { timestamp: fixture.timestamp, nonce: fixture.nonce, msg_signature: "invalid" },
    body: Buffer.from(`<xml><Encrypt><![CDATA[${fixture.encrypted}]]></Encrypt></xml>`),
  }, response);
  assert.equal(response.statusCode, 403);
  assert.equal(invoked, false);
});
