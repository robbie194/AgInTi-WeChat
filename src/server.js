import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import { migrate, pool, query } from "./db.js";
import { cloudBridge } from "./cloud-bridge.js";
import { CustomerServiceProcessor } from "./customer-service.js";
import { CustomerServiceSyncWorker } from "./sync-worker.js";
import { createWeComCallbackHandler } from "./wecom-callback.js";
import { wecomApi } from "./wecom-api.js";
import { SmartBotGroupProcessor } from "./smart-bot.js";

const app = express();
const server = http.createServer(app);
const syncWorker = new CustomerServiceSyncWorker({ config, api: wecomApi });
const customerServiceProcessor = new CustomerServiceProcessor({ config, api: wecomApi, bridge: cloudBridge });
const smartBotProcessor = new SmartBotGroupProcessor({ config, bridge: cloudBridge });
const callbackHandler = createWeComCallbackHandler({
  config,
  onEvent: (event) => syncWorker.notify(event),
});

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.get("/health", async (_request, response) => {
  try {
    await query("SELECT 1");
    response.json({
      ok: true,
      service: "aginti-wechat",
      features: {
        customerService: config.enabled,
        groupSmartBot: config.groupBotEnabled,
        groupBotConnected: smartBotProcessor.ready,
      },
    });
  } catch {
    response.status(503).json({ ok: false, service: "aginti-wechat" });
  }
});

app.get(config.callbackPath, callbackHandler);
app.post(config.callbackPath, express.raw({ type: ["application/xml", "text/xml", "application/octet-stream"], limit: "1mb" }), callbackHandler);
app.get("/", (_request, response) => response.status(404).json({ ok: false, error: "Not found." }));
app.use((error, _request, response, _next) => {
  const status = Number(error?.statusCode) >= 400 && Number(error.statusCode) < 600 ? Number(error.statusCode) : 500;
  response.status(status).json({ ok: false, error: status >= 500 ? "Internal gateway error." : "Invalid request." });
});

async function start() {
  await migrate();
  server.listen(config.port, "0.0.0.0", () => {
    console.info(JSON.stringify({ event: "gateway.started", port: config.port, customerService: config.enabled, groupSmartBot: config.groupBotEnabled }));
  });
  if (config.enabled) {
    syncWorker.start();
    customerServiceProcessor.start();
  }
  if (config.groupBotEnabled) smartBotProcessor.start();
}

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.info(JSON.stringify({ event: "gateway.stopping", signal }));
  await Promise.allSettled([syncWorker.stop(), customerServiceProcessor.stop(), smartBotProcessor.stop()]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  process.exit(0);
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

if (process.env.NODE_ENV !== "test" && process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  start().catch((error) => {
    console.error(JSON.stringify({ event: "gateway.start_failed", code: String(error?.code || error?.name || "error") }));
    process.exitCode = 1;
  });
}

export { app, callbackHandler, customerServiceProcessor, server, smartBotProcessor, start, stop, syncWorker };
