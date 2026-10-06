# 企业微信客服 API 预检与群聊能力边界

日期：2026-10-06

## 私聊接入进度

Gateway 已实现用户绑定、微信客服消息同步、把文本和附件送入 Cloud 选定的项目会话，以及把任务结果发回同一客服会话。附件写入项目 `wechat-inbox/`，Cloud 仍是会话记录、Agent、模式路由和项目文件的唯一来源。两个功能开关在生产环境保持关闭；目标企业租户尚未完成真实消息验收。

生产 Gateway 已更新到 `0.1.9`。镜像包含预检脚本；生产主机没有主机级 Node 依赖时，`check-wecom-customer-service.sh` 会通过 `docker compose run --rm --no-deps gateway` 执行。私聊和群聊仍保持关闭。

## 回调域名与主域名备案范围

当前实际回调地址是 `https://wechat.overtree.top/wecom/callback`，所以在“API 接收消息”里填写完整 URL；若另行配置 OAuth/JS-SDK 可信域名，则填写主机名 `wechat.overtree.top`，不要把协议和路径混进域名字段。

备案主体登记在主域名 `overtree.top`。工信部门备案 FAQ 说明：主域与二级域名使用同一接入商时，主域备案后使用二级域名通常无需单独备案；若接入商不同，二级域名接入商需要办理新增接入。因此，`overtree.top` 备案通过且接入关系符合要求时，`wechat.overtree.top` 通常沿用同一备案主体，不需要再创造一个子域名主体。企微回调仍填写实际主机名 `https://wechat.overtree.top/wecom/callback`；若配置 OAuth/JS-SDK 可信域名，也应填实际主机名 `wechat.overtree.top`。备案规则不保证企微后台一定自动接受该子域名，最终以实际域名校验能否保存为准。当前 `overtree.top` 没有 ICP 备案，添加 DNS 子域名、HTTPS 证书或域名所有权校验文件都不能补出备案主体关系。

参考：[工信部门备案 FAQ（一级域名与二级域名）](https://jxca.miit.gov.cn/bsfw/bszn/cjwt/art/2020/art_869445de6a9f40f99d.html)、[阿里云备案域名 FAQ](https://help.aliyun.com/zh/icp-filing/basic-icp-service/support/for-the-record-domain-faq)、[企业微信应用接入指引](https://wdk-docs.github.io/wework-docs/operation/guidelines-for-enterprise-wechat-application-access/)。

## 新增的服务器端 API 预检

在服务器录入微信客服 API Secret 和 `open_kfid` 后，可运行：

```bash
cd /opt/aginti-wechat
bash scripts/check-wecom-customer-service.sh
```

预检调用企业微信“获取客服帐号列表”接口，确认当前凭证有读取基础信息的权限，并确认配置的客服帐号 ID 存在。企业微信该接口要求 `offset`、`limit` 的 JSON 请求体；Node 的标准 `fetch` 不允许 GET 请求携带 body，因此 Gateway 使用 Node HTTPS 请求发送这个只读请求，并在 access token 过期时按现有 API 客户端逻辑重试。

命令只输出验证结果、匹配数量和客服显示名称，不输出 CorpID、Secret、access token 或完整 `open_kfid`。它不启动消息同步、不绑定用户、不发微信消息，也不修改两个功能开关。没有真实企业凭证时，只能验证脚本行为，不能据此宣称租户 API 已连通。

企业微信要求使用“微信客服”Secret，并具备“微信客服 → 获取基础信息”权限；接口资料见[获取客服帐号列表](https://open.work.weixin.qq.com/api/doc/90001/90143/94691)。

## 外部联系人群的现行边界与新 API 模式

企业微信 5.0.10 增加了 API 模式智能机器人；机器人可以通过 WebSocket 长连接接入，腾讯云 2026-08 接入指南演示了单聊和群聊 @ 机器人。长连接不需要机器人回调域名。公开的企微智能机器人 FAQ 仍说明外部群暂不支持，更新后的 API 模式指南没有明确说这项群类型限制已改变。因此，目前还没有足够依据证明该机器人可进入同时包含个人微信客户的外部联系人群；管理员测试群是下一步的决定性验证。

客户群资料 API 不是群消息回调；企业群发 API 创建的是需要员工确认发送的群发任务，不能直接作为逐条即时回复接口。会话内容存档可以在企业启用相应能力、员工告知以及外部参与者同意后用于读取留存消息，但它是需要企业配置和解密处理的数据归档通道，也不能单独提供机器人在群里实时发言的能力。

群处理代码现在也可下载并保存企微 Smart Bot 长连接提供的图片、文件和视频附件到已绑定 Cloud 项目；媒体以流方式下载并受 `WECHAT_MAX_MEDIA_BYTES` 限制，默认上限 20 MiB，超限附件不入库，但同一消息的文字问题仍可处理。语音消息使用企微提供的转写文本，平台不提供可供此适配器归档的语音原件。输入和结果继续共用对应 OverTree 会话，外发项目文件仍按绑定时的“分享结果文件”选择生成短期下载链接。

新增 `scripts/configure-wecom-smart-bot.sh`，管理员创建 API 模式机器人后，可在 Gateway 主机安全录入 Bot ID/Secret；脚本隐藏 Secret、保护 `.env` 备份，保持两个功能开关关闭，不会重启或连接服务。没有把它标记为目标客服群功能，也没有用网页协作或人工转发替代用户要求的真实群聊。只有在真实企业测试群确认机器人可加入且个人微信成员可见后，才继续做端到端验收。

参考接口资料：

- [企业群发 API](https://open.work.weixin.qq.com/api/doc/90001/90143/92698)：调用用于创建群发任务，发送仍由成员确认。
- [查询客户群会话存档同意状态](https://open.work.weixin.qq.com/api/doc/90000/91782)：群内外部联系人的会话存档同意情况。
- [获取会话内容存档内部群信息](https://open.work.weixin.qq.com/api/doc/90000/92951)：接口文档明确此接口仅支持内部群。
- [企业微信 5.0.10 客户端版本说明](https://apps.apple.com/cn/app/%E4%BC%81%E4%B8%9A%E5%BE%AE%E4%BF%A1/id1087897068)：提到 API 模式智能机器人和配置回调接收用户提问。
- [腾讯云 API 模式智能机器人接入指南](https://cloud.tencent.com/document/product/1831/137051)：介绍 WebSocket 长连接和 @ 群聊示例，但未说明外部联系人群范围。

## 验证

- `npm run check` 通过。
- `npm test`：27 项通过，覆盖客服帐号预检、凭证安全录入、群图片/文件/视频下载归档和语音转写、媒体流大小限制、回调加密、桥接签名及消息幂等。
- 生产 Gateway `0.1.9` 和 Cloud `0.1.21` 健康检查通过；预检脚本在没有真实凭证时安全停止。
- 使用占位 `.env` 执行服务器预检烟测：命令在联网前安全停止，未输出占位 Secret。
- 尚未使用真实企业微信凭证联网验证。域名主体审核、回调 URL 保存、用户绑定、文件往返和客服群真实交互仍未验收。
