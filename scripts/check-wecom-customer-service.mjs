import { config } from "../src/config.js";
import { wecomApi } from "../src/wecom-api.js";

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

if (!config.corpId || !config.corpSecret || /replace-with/i.test(config.corpId) || /replace-with/i.test(config.corpSecret)) {
  fail("尚未录入真实企业 CorpID 和微信客服 API Secret。请先运行 scripts/configure-wecom-customer-service.sh。");
} else if (!config.openKfIds.length || config.openKfIds.some((id) => /replace-with/i.test(id))) {
  fail("尚未录入真实 open_kfid。请先运行 scripts/configure-wecom-customer-service.sh。");
} else {
  try {
    const accounts = [];
    const pageSize = 100;
    for (let offset = 0; offset < 10_000; offset += pageSize) {
      const page = await wecomApi.listCustomerServiceAccounts({ offset, limit: pageSize });
      accounts.push(...(Array.isArray(page.account_list) ? page.account_list : []));
      if (accounts.length - offset < pageSize) break;
    }

    const namesById = new Map(accounts.map((account) => [String(account.open_kfid || ""), String(account.name || "客服帐号")]));
    const matchedNames = config.openKfIds.map((id) => namesById.get(id)).filter(Boolean);
    if (matchedNames.length !== config.openKfIds.length) {
      fail(`企微 API 凭证可以调用，但配置的客服帐号未全部匹配（匹配 ${matchedNames.length}/${config.openKfIds.length}）。请在企业微信后台核对“微信客服”Secret 的权限和 open_kfid。`);
    } else {
      console.log(`预检通过：微信客服 API 凭证有效，配置的客服帐号已匹配 ${matchedNames.length}/${config.openKfIds.length} 个。`);
      console.log(`帐号名称：${matchedNames.join("、")}`);
      console.log("预检只读取客服帐号列表；没有开启消息同步、绑定用户或发送微信消息。");
    }
  } catch (error) {
    const code = Number(error.wecomCode || 0);
    const hint = code === 40001 || code === 40013
      ? "CorpID 或 API Secret 不匹配。"
      : code === 48002
        ? "该 Secret 缺少“微信客服 → 获取基础信息”权限。"
        : code
          ? "请核对微信客服 API 权限和企业可信 IP。"
          : "请检查服务器网络、DNS 与 TLS 后重试。";
    fail(`企微预检失败${code ? `（接口错误码 ${code}）` : ""}：${hint}没有输出或保存任何访问令牌。`);
  }
}
