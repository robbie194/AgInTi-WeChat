import crypto from "node:crypto";
import { callbackResponse, callbackField, callbackSignature, decryptWeComMessage, encryptWeComMessage, parseXml, verifyCallbackSignature } from "./wecom-crypto.js";

function callbackBody(request) {
  if (Buffer.isBuffer(request.body)) return request.body.toString("utf8");
  return String(request.body || "");
}

function xmlText(value) {
  if (Array.isArray(value)) return xmlText(value[0]);
  if (value && typeof value === "object" && "#cdata" in value) return xmlText(value["#cdata"]);
  return String(value ?? "");
}

export function createWeComCallbackHandler({ config, onEvent = async () => {} }) {
  return async function weComCallback(request, response) {
    if (!config.decodedAesKey || !config.callbackToken || !config.corpId) {
      response.status(503).type("text/plain").send("WeChat callback is not configured.");
      return;
    }

    const timestamp = String(request.query.timestamp || "");
    const nonce = String(request.query.nonce || "");
    const signature = String(request.query.msg_signature || request.query.signature || "");
    const xml = callbackBody(request);
    const encrypted = request.method === "GET" ? String(request.query.echostr || "") : callbackField(xml, "Encrypt");
    if (!timestamp || !nonce || !encrypted || !verifyCallbackSignature({
      token: config.callbackToken,
      timestamp,
      nonce,
      encrypted,
      signature,
    })) {
      response.status(403).type("text/plain").send("Invalid callback signature.");
      return;
    }

    try {
      const plaintext = decryptWeComMessage(encrypted, { key: config.decodedAesKey, corpId: config.corpId });
      if (request.method === "GET") {
        response.status(200).type("text/plain").send(plaintext);
        return;
      }

      const event = parseXml(plaintext);
      const eventType = xmlText(event.Event || "").toLowerCase();
      const openKfId = xmlText(event.OpenKfId || event.open_kfid || "");
      const callbackToken = xmlText(event.Token || event.token || "");
      if (eventType === "kf_msg_or_event" && openKfId && callbackToken) {
        await onEvent({ openKfId, callbackToken, eventType });
      }
      const ack = callbackResponse("success", {
        token: config.callbackToken,
        key: config.decodedAesKey,
        corpId: config.corpId,
      });
      response.status(200).type("application/xml").send(ack);
    } catch {
      response.status(400).type("text/plain").send("Invalid callback payload.");
    }
  };
}

export function buildTestCallbackXml(event, config) {
  const json = Object.entries(event).map(([key, value]) => `<${key}><![CDATA[${String(value)}]]></${key}>`).join("");
  const plaintext = `<xml>${json}</xml>`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(12).toString("hex");
  const encrypted = encryptWeComMessage(plaintext, { key: config.decodedAesKey, corpId: config.corpId });
  const signature = callbackSignature(config.callbackToken, timestamp, nonce, encrypted);
  return { timestamp, nonce, encrypted, signature };
}
