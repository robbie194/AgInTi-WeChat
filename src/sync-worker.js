import { decryptPayload } from "./encryption.js";
import { getSyncState, rememberCallbackToken, saveSyncPage } from "./db.js";

function privateLog(level, message, data = {}) {
  const safe = Object.fromEntries(Object.entries(data).filter(([key]) => !/content|token|secret|external|user|media|payload/i.test(key)));
  console[level](message, safe);
}

export class CustomerServiceSyncWorker {
  constructor({ config, api, pollIntervalMs = 10_000, maxPagesPerPoll = 8 }) {
    this.config = config;
    this.api = api;
    this.pollIntervalMs = pollIntervalMs;
    this.maxPagesPerPoll = maxPagesPerPoll;
    this.running = false;
    this.timer = null;
    this.wakeRequested = false;
    this.activePoll = null;
  }

  async notify({ openKfId, callbackToken }) {
    if (!this.config.openKfIds.includes(openKfId)) return;
    await rememberCallbackToken(openKfId, callbackToken);
    this.wakeRequested = true;
    if (this.running && !this.activePoll) void this.pollAll();
  }

  start() {
    if (!this.config.enabled || this.running) return;
    this.running = true;
    void this.pollAll();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.activePoll) await this.activePoll.catch(() => {});
  }

  async pollAll() {
    if (!this.running || this.activePoll) return this.activePoll;
    this.wakeRequested = false;
    this.activePoll = (async () => {
      for (const openKfId of this.config.openKfIds) {
        try {
          await this.syncAccount(openKfId);
        } catch (error) {
          privateLog("error", "WeChat Customer Service message sync failed.", { statusCode: error.statusCode, wecomCode: error.wecomCode });
        }
      }
    })().finally(() => {
      this.activePoll = null;
      if (!this.running) return;
      const delay = this.wakeRequested ? 50 : this.pollIntervalMs;
      this.timer = setTimeout(() => void this.pollAll(), delay);
      this.timer.unref?.();
    });
    return this.activePoll;
  }

  async syncAccount(openKfId) {
    const state = await getSyncState(openKfId);
    const savedCallback = state.callback_token_enc
      ? decryptPayload(state.callback_token_enc, this.config.dataEncryptionKey).token
      : "";
    let cursor = state.cursor || "";
    for (let page = 0; page < this.maxPagesPerPoll; page += 1) {
      const response = await this.api.syncMessages(openKfId, { cursor, callbackToken: savedCallback, limit: 100 });
      const messages = Array.isArray(response.msg_list) ? response.msg_list : [];
      const nextCursor = String(response.next_cursor || cursor);
      await saveSyncPage(openKfId, { cursor: nextCursor, messages });
      if (!messages.length || response.has_more !== 1 || nextCursor === cursor) break;
      cursor = nextCursor;
    }
  }
}
