import { WSClient } from "@wecom/aibot-node-sdk";

function configured(value) {
  const text = String(value || "").trim();
  return Boolean(text) && !/replace-with/i.test(text);
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

const botId = String(process.env.WECHAT_BOT_ID || "").trim();
const secret = String(process.env.WECHAT_BOT_SECRET || "").trim();
const enabled = String(process.env.WECHAT_GROUP_BOT_ENABLED || "false").trim().toLowerCase() === "true";

if (enabled) {
  fail("群聊开关已经开启；为避免同一个机器人建立第二条长连接，请先关闭 WECHAT_GROUP_BOT_ENABLED 再运行预检。");
} else if (!configured(botId) || !configured(secret)) {
  fail("尚未录入真实 Smart Bot Bot ID 和 Secret。请先运行 scripts/configure-wecom-smart-bot.sh。");
} else {
  let done = false;
  let timeout;
  const client = new WSClient({
    botId,
    secret,
    maxReconnectAttempts: 0,
    maxAuthFailureAttempts: 0,
    heartbeatInterval: 30_000,
    requestTimeout: 10_000,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });

  const finish = (ok, message) => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    client.disconnect();
    if (ok) {
      console.log(message);
    } else {
      fail(message);
    }
  };

  client.once("authenticated", () => finish(true, "预检通过：Smart Bot 长连接认证成功。未开启群聊开关，也未处理或发送任何群消息。"));
  client.once("error", () => finish(false, "预检失败：Smart Bot 长连接认证或网络连接未通过。请核对 Bot ID、Secret、企业权限和服务器出网连接。未开启群聊开关。"));
  client.connect();
  timeout = setTimeout(() => finish(false, "预检超时：Smart Bot 长连接在 15 秒内没有完成认证。请检查服务器到企业微信的 WebSocket 出网连接。"), 15_000);
  timeout.unref?.();
}
