import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts/configure-wecom-smart-bot.sh");
const checkScript = path.join(root, "scripts/check-wecom-smart-bot.sh");

function runScript(envFile, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script], {
      cwd: root,
      env: { ...process.env, WECHAT_ENV_FILE: envFile },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr || `Script exited with code ${code}.`), { code, stdout, stderr }));
    });
    child.stdin.end(input);
  });
}

test("Smart Bot credential setup hides the secret and leaves both switches disabled", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-wechat-bot-test-"));
  const envFile = path.join(directory, ".env");
  const secret = "fake-smart-bot-secret-never-print";
  await fs.writeFile(envFile, "NODE_ENV=production\nKEEP_THIS=value\nWECHAT_ENABLED=false\nWECHAT_GROUP_BOT_ENABLED=false\n", { mode: 0o600 });

  try {
    const { stdout, stderr } = await runScript(envFile, `fake-bot-id\n${secret}\n`);
    const output = `${stdout}${stderr}`;
    const configured = await fs.readFile(envFile, "utf8");
    const stat = await fs.stat(envFile);

    assert.equal(output.includes(secret), false);
    assert.match(output, /未重启|未连接机器人/);
    assert.match(configured, /^WECHAT_BOT_ID=fake-bot-id$/m);
    assert.match(configured, /^WECHAT_BOT_SECRET=fake-smart-bot-secret-never-print$/m);
    assert.match(configured, /^WECHAT_ENABLED=false$/m);
    assert.match(configured, /^WECHAT_GROUP_BOT_ENABLED=false$/m);
    assert.match(configured, /^KEEP_THIS=value$/m);
    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Smart Bot credential setup refuses to edit an enabled Gateway", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-wechat-bot-test-"));
  const envFile = path.join(directory, ".env");
  const original = "WECHAT_ENABLED=true\nWECHAT_GROUP_BOT_ENABLED=false\nWECHAT_BOT_ID=old-bot\n";
  await fs.writeFile(envFile, original, { mode: 0o600 });

  try {
    await assert.rejects(runScript(envFile, "new-bot-id\nfake-smart-bot-secret-never-print\n"));
    assert.equal(await fs.readFile(envFile, "utf8"), original);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function runCheck(envFile) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [checkScript], {
      cwd: root,
      env: { ...process.env, WECHAT_ENV_FILE: envFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("Smart Bot preflight stops safely when credentials are missing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-wechat-bot-check-"));
  const envFile = path.join(directory, ".env");
  await fs.writeFile(envFile, "NODE_ENV=production\nWECHAT_GROUP_BOT_ENABLED=false\nWECHAT_BOT_ID=replace-with-smart-bot-id\nWECHAT_BOT_SECRET=replace-with-smart-bot-secret\n", { mode: 0o600 });

  try {
    const result = await runCheck(envFile);
    assert.equal(result.code, 1);
    assert.match(`${result.stdout}${result.stderr}`, /尚未录入真实 Smart Bot/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /replace-with-smart-bot-secret/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Smart Bot preflight refuses to compete with an enabled Gateway", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-wechat-bot-check-enabled-"));
  const envFile = path.join(directory, ".env");
  await fs.writeFile(envFile, "NODE_ENV=production\nWECHAT_GROUP_BOT_ENABLED=true\nWECHAT_BOT_ID=real-bot-id\nWECHAT_BOT_SECRET=real-smart-bot-secret\n", { mode: 0o600 });

  try {
    const result = await runCheck(envFile);
    assert.equal(result.code, 1);
    assert.match(`${result.stdout}${result.stderr}`, /群聊开关已经开启/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
