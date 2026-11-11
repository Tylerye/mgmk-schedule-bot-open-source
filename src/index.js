import { loadConfig } from "./config.js";
import { startHealthServer } from "./health.js";
import { createLogger } from "./logger.js";
import { checkSchedules } from "./monitor.js";
import { assertPollingAvailable, runService } from "./runtime.js";
import { StateStore } from "./state.js";
import { TelegramClient } from "./telegram.js";
import { openLocalAttention } from "./attention-local.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const once = args.has("--once");
const abortController = new AbortController();
const config = await loadConfig({ dryRun });
config.abortSignal = abortController.signal;
const logger = createLogger(config.logLevel);
config.logger = logger;
const store = new StateStore(config.statePath);
await store.load();

if (once) {
  try {
    await checkSchedules({ config, store, logger });
  } catch (error) {
    logger.error("error", { operation: "dry_run", error: error.message });
    process.exitCode = 1;
  }
} else {
  store.state.health.startedAt = new Date().toISOString();
  const client = new TelegramClient({ token: config.botToken, logger, abortSignal: abortController.signal });
  const healthServer = startHealthServer({ store, port: config.healthPort, host: config.healthHost, logger });
  const shutdown = (signal) => {
    logger.info("graceful_shutdown_started", { signal });
    abortController.abort();
    healthServer.close();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  try {
    const bot = await client.getMe();
    await assertPollingAvailable(client);
    store.state.health.lastTelegramSuccessAt = new Date().toISOString();
    await store.save();
    logger.info("process_started", {
      botUsername: bot.username,
      group: config.groupName,
      timezone: config.timezone,
      pollIntervalSeconds: config.pollIntervalMs / 1_000,
      pinSwitchTime: config.pinSwitchTime,
    });
    const attentionStore = await openLocalAttention(`${config.statePath}.attention.sqlite`);
    await runService({ config, store, logger, client, attentionStore, signal: abortController.signal });
  } catch (error) {
    if (!abortController.signal.aborted) {
      logger.error("error", { operation: "startup", error: error.message });
      process.exitCode = 1;
    }
  } finally {
    healthServer.close();
  }
}
