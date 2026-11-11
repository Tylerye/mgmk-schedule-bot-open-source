import { checkSchedules } from "./monitor.js";
import { ensureDesiredState } from "./reconcile.js";
import { acknowledgeScheduleCallbacks, processTelegramUpdates } from "./telegram.js";
import { collectAttentionUpdate, processAttentionUpdate, recoverAttention } from "./attention.js";
import { recoverEventReminders } from "./event-reminders.js";

export async function assertPollingAvailable(client) {
  const webhook = await client.call("getWebhookInfo");
  if (webhook.url) {
    throw new Error("Local polling is disabled while a Telegram webhook is active. Use dry-run for local checks; stop the production webhook only during an explicit cutover.");
  }
}

function wait(milliseconds, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createSerialExecutor() {
  let queue = Promise.resolve();
  return (task) => {
    const operation = queue.then(task);
    queue = operation.catch(() => {});
    return operation;
  };
}

async function recordFailure({ store, logger, event, error }) {
  store.state.health.lastError = { at: new Date().toISOString(), event, message: error.message };
  await store.save();
  logger.error("error", { operation: event, error: error.message });
}

export async function runSourceLoop(context) {
  const { config, store, logger, client, signal, exclusive } = context;
  while (!signal.aborted) {
    const cycleStarted = Date.now();
    try {
      await exclusive(async () => {
        store.state.health.nextSourcePollAt = new Date(cycleStarted + config.pollIntervalMs).toISOString();
        await checkSchedules({ config, store, logger, now: new Date(cycleStarted) });
        await ensureDesiredState({ client, store, config, logger, now: new Date() });
      });
    } catch (error) {
      if (!signal.aborted) await exclusive(() => recordFailure({ store, logger, event: "source_poll", error }));
    }
    const remaining = Math.max(0, config.pollIntervalMs - (Date.now() - cycleStarted));
    await wait(remaining, signal);
  }
}

export async function runTelegramLoop(context) {
  const { config, store, logger, client, signal, exclusive, attentionStore } = context;
  const attentionExclusive = createSerialExecutor();
  while (!signal.aborted) {
    try {
      const updates = await client.getUpdates(store.state.updateOffset, 20);
      if (attentionStore) {
        for (const update of updates) {
          const attention = await collectAttentionUpdate({ update, chatId: store.state.chatId, store: attentionStore, config });
          if (attention) await attentionStore.run("INSERT OR IGNORE INTO attention_local_inbox (update_id,payload) VALUES (?,?)", update.update_id, JSON.stringify(attention));
        }
        // Persist sanitized intents before the schedule loop advances its offset,
        // then run this independent queue without holding the schedule executor.
        void attentionExclusive(async () => {
          const pending = await attentionStore.all("SELECT update_id,payload FROM attention_local_inbox ORDER BY update_id LIMIT 30");
          for (const row of pending) {
            await processAttentionUpdate({ update: JSON.parse(row.payload), chatId: store.state.chatId, store: attentionStore, config, client });
            await attentionStore.run("DELETE FROM attention_local_inbox WHERE update_id=?", row.update_id);
          }
          await recoverAttention({ store: attentionStore, client, chatId: store.state.chatId });
        }).catch(error => logger.warn("attention_local_deferred", { error: error.message }));
      }
      const acknowledgedCallbacks = await acknowledgeScheduleCallbacks({ client, state: store.state, updates });
      await exclusive(async () => {
        store.state.health.lastTelegramSuccessAt = new Date().toISOString();
        await processTelegramUpdates({
          client,
          store,
          config,
          updates,
          acknowledgedCallbacks,
          reconcile: (now) => ensureDesiredState({ client, store, config, logger, now }),
        });
        if (updates.length === 0) await store.save();
      });
    } catch (error) {
      if (signal.aborted) break;
      await exclusive(() => recordFailure({ store, logger, event: "telegram_poll", error }));
      await wait(2_000, signal);
    }
  }
}

export async function runLiveLoop(context) {
  const { config, store, logger, client, signal, exclusive } = context;
  while (!signal.aborted) {
    const delay = 60_000 - (Date.now() % 60_000) + 250;
    await wait(delay, signal);
    if (signal.aborted) break;
    try {
      await exclusive(() => ensureDesiredState({ client, store, config, logger, now: new Date() }));
    } catch (error) {
      await exclusive(() => recordFailure({ store, logger, event: "live_reconcile", error }));
    }
  }
}

export async function runReminderLoop({ attentionStore, store, client, logger, signal }) {
  if (!attentionStore) return;
  while (!signal.aborted) {
    try {
      if (store.state.chatId) await recoverEventReminders({ store: attentionStore, client, chatId: store.state.chatId });
    } catch (error) { logger.warn("event_reminder_maintenance_failed", { error: error.message }); }
    await wait(60_000 - (Date.now() % 60_000) + 250, signal);
  }
}

export async function runService(context) {
  const exclusive = createSerialExecutor();
  await Promise.all([
    runSourceLoop({ ...context, exclusive }),
    runTelegramLoop({ ...context, exclusive }),
    runLiveLoop({ ...context, exclusive }),
    runReminderLoop(context),
  ]);
}
