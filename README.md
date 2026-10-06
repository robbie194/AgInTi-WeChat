# AgInTi-WeChat

An isolated official WeChat Work integration Gateway for OverTree Cloud. It handles WeChat Customer Service callbacks, durable message synchronization and retries, and an optional official WeCom Smart Bot WebSocket adapter. Cloud remains the source of truth for OverTree email accounts, projects, sessions, model routing, Agent runs and workspace files.

## Current behavior

- A Cloud user chooses a project and either an existing session or a dedicated WeChat session, then creates a single-use, ten-minute binding code at `https://cloud.overtree.top/wechat`.
- For private chat, the user opens the configured official WeChat Customer Service link and sends that code. Their WeChat `external_userid` is bound to that Cloud account and selected session.
- Customer messages and supported attachments enter the existing Cloud `continueRun` path. Attachments are written to the selected project under `wechat-inbox/`. Results return to the same WeChat conversation; messages queued into one OverTree run share its result and the Gateway delivers that run result once.
- Project files are only attached to outbound replies when the user opted into artifact sharing for that binding. Links expire after 24 hours and allow at most 10 downloads.
- The optional Smart Bot path accepts `@OverTree` group text and text/image mixed messages using the official WebSocket SDK, stores supported mixed-message images in the selected Cloud project, and uses a separately bound Cloud session. Standalone group image/file/voice/video messages are not supported by this adapter. Whether a Smart Bot can join a group containing external WeChat customers must be verified in the target enterprise tenant before enabling it.
- The Gateway never logs in to a user's personal WeChat account and does not ask the user to install cc-connect or provide WeChat credentials.

The Smart Bot adapter is a tenant POC candidate, not a promise that every personal-WeChat/customer group supports bots. It is distinct from customer-group chat archives and customer-group send-task APIs. See the detailed findings in OverTree Cloud's `docs/history/2026-10-05-wechat-agent-human-collaboration-architecture.md`.

## Local checks

```bash
npm ci
npm run check
npm test
```

Node.js 22 or newer is required.

## Configuration

Copy `.env.example` to `.env` and configure the server side only:

- `WECHAT_CORP_ID`, `WECHAT_CORP_SECRET`, callback `Token`, and `EncodingAESKey` for the company-owned WeChat Customer Service app. The callback URL is `https://wechat.example.com/wecom/callback`.
- `WECHAT_OPEN_KF_IDS` with the official Customer Service account ID(s) that this Gateway is allowed to synchronize.
- `CLOUD_BRIDGE_URL` with the Cloud private-network URL. Gateway reaches the `cloud` Compose service on the isolated `overtree-wechat-bridge` network; Cloud reaches Gateway through its `aginti-wechat` network alias.
- A strong, freshly generated `POSTGRES_PASSWORD`, plus a shared secret in `CLOUD_BRIDGE_SHARED_SECRET` and `CLOUD_WECHAT_GATEWAY_SECRET`. The Gateway signs every internal request with a timestamp, one-time nonce and SHA-256 HMAC; Cloud rejects expired or replayed requests.
- `WECHAT_DATA_ENCRYPTION_KEY` for queued WeChat callback/message payloads at rest.
- Keep `WECHAT_ENABLED=false` until the Customer Service POC is complete. Keep `WECHAT_GROUP_BOT_ENABLED=false` until the separate external-customer-group test passes. If enabling it, configure `WECHAT_BOT_ID`/`WECHAT_BOT_SECRET` and the matching `CLOUD_WECHAT_GROUP_BOT_ID` in Cloud.

Generate values without sending them in chat:

```bash
openssl rand -base64 36
openssl rand -base64 32
openssl rand -hex 32
```

The first command is suitable for the shared bridge secret. For the encryption key, use the second command exactly and keep it unchanged across restarts. Use the third command for `POSTGRES_PASSWORD`; its hexadecimal alphabet is safe inside the Compose database URL. Do not commit `.env` or put secrets in client-side configuration.

## Deploy alongside Cloud

Cloud's Compose file creates the isolated `overtree-wechat-bridge` network, shared only by Cloud and the Gateway. Deploy the Gateway on the same Docker host after Cloud's Compose stack has created that network. The Gateway database stays on a separate internal network. The Gateway also has its own outbound network for official WeChat APIs; it does not join Cloud's database/Docker-proxy network.

```bash
cp .env.example .env
# Fill the server secrets and company-owned WeChat configuration in .env.
docker compose -f compose.yml up -d --build
curl http://127.0.0.1:3230/health
```

Add the Caddy snippet to the host reverse proxy with the real WeChat callback hostname and point the enterprise callback URL at `https://<hostname>/wecom/callback`. Keep the Cloud bridge endpoint private; only Cloud-to-Gateway internal traffic is needed. Set Cloud's `.env` values for `CLOUD_WECHAT_GATEWAY_SECRET`, `CLOUD_WECHAT_CUSTOMER_SERVICE_URL` and, only for the Smart Bot POC, `CLOUD_WECHAT_GROUP_BOT_ID`. Recreate both services after changing environment files.

## Enterprise acceptance checklist

1. Configure the official WeChat Customer Service callback and app scope with a company-owned test service account.
2. Sign into Cloud with a test email account, generate a code, bind an ordinary personal WeChat user, and test duplicate callbacks, text, image/file ingestion, Agent completion and outbound limits.
3. Check that the same exchange appears in the selected Cloud session and that revoking the binding prevents future access.
4. Test the Smart Bot only in a test tenant and group. Verify that a group containing an external personal-WeChat customer can add the bot, that `@OverTree` callbacks arrive with the expected chat/member fields, and that replies appear to every intended participant.
5. If any group acceptance item fails, leave the group flag off. The Customer Service private route remains independently configurable.

Don't describe the platform integration as zero-risk: official APIs avoid automating a user's personal WeChat client, while enterprise message processing still requires the company's normal customer notice, consent, retention and access controls.
