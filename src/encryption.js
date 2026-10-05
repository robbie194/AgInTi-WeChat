import crypto from "node:crypto";

export function encryptPayload(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptPayload(value, key) {
  const payload = Buffer.from(value);
  if (payload.length < 29) throw new Error("Encrypted message is truncated.");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}
