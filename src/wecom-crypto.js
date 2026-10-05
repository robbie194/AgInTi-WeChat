import crypto from "node:crypto";
import { XMLBuilder, XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  cdataPropName: "#cdata",
});
const xmlBuilder = new XMLBuilder({
  ignoreAttributes: true,
  cdataPropName: "#cdata",
  format: false,
  suppressEmptyNode: true,
});

export function parseXml(xml) {
  const parsed = xmlParser.parse(String(xml || ""));
  return parsed.xml || parsed;
}

function normalizedCdata(value) {
  if (Array.isArray(value)) value = value[0];
  if (value && typeof value === "object" && "#cdata" in value) return normalizedCdata(value["#cdata"]);
  return String(value ?? "");
}

export function callbackField(xml, field) {
  return normalizedCdata(parseXml(xml)[field]);
}

export function callbackSignature(token, timestamp, nonce, encrypted) {
  const material = [String(token), String(timestamp), String(nonce), String(encrypted || "")].sort().join("");
  return crypto.createHash("sha1").update(material, "utf8").digest("hex");
}

export function verifyCallbackSignature({ token, timestamp, nonce, encrypted, signature }) {
  const expected = Buffer.from(callbackSignature(token, timestamp, nonce, encrypted));
  const supplied = Buffer.from(String(signature || ""));
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function pkcs7Pad(buffer) {
  const padding = 32 - (buffer.length % 32);
  return Buffer.concat([buffer, Buffer.alloc(padding, padding)]);
}

function pkcs7Unpad(buffer) {
  if (!buffer.length) throw new Error("WeChat callback is empty.");
  const padding = buffer[buffer.length - 1];
  if (padding < 1 || padding > 32 || padding > buffer.length) throw new Error("WeChat callback padding is invalid.");
  for (let index = buffer.length - padding; index < buffer.length; index += 1) {
    if (buffer[index] !== padding) throw new Error("WeChat callback padding is invalid.");
  }
  return buffer.subarray(0, buffer.length - padding);
}

export function encryptWeComMessage(message, { key, corpId }) {
  const random = crypto.randomBytes(16);
  const body = Buffer.from(String(message), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const plaintext = pkcs7Pad(Buffer.concat([random, length, body, Buffer.from(corpId, "utf8")]));
  const cipher = crypto.createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64");
}

export function decryptWeComMessage(encrypted, { key, corpId }) {
  const ciphertext = Buffer.from(String(encrypted || ""), "base64");
  if (!ciphertext.length || ciphertext.length % 16 !== 0) throw new Error("WeChat callback ciphertext is invalid.");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plaintext = pkcs7Unpad(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  if (plaintext.length < 20) throw new Error("WeChat callback plaintext is truncated.");
  const messageLength = plaintext.readUInt32BE(16);
  const messageEnd = 20 + messageLength;
  if (messageEnd > plaintext.length) throw new Error("WeChat callback message length is invalid.");
  const receiveId = plaintext.subarray(messageEnd).toString("utf8");
  if (receiveId !== corpId) throw new Error("WeChat callback CorpID does not match.");
  return plaintext.subarray(20, messageEnd).toString("utf8");
}

export function callbackResponse(message, { token, key, corpId, timestamp = String(Math.floor(Date.now() / 1000)), nonce = crypto.randomBytes(12).toString("hex") }) {
  const encrypted = encryptWeComMessage(message, { key, corpId });
  const signature = callbackSignature(token, timestamp, nonce, encrypted);
  return xmlBuilder.build({
    xml: {
      Encrypt: { "#cdata": encrypted },
      MsgSignature: { "#cdata": signature },
      TimeStamp: timestamp,
      Nonce: { "#cdata": nonce },
    },
  });
}
