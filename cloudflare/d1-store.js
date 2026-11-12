import { EMPTY_STATE } from "../src/state-shape.js";

export class D1StateStore {
  constructor(database) {
    this.database = database;
    this.state = structuredClone(EMPTY_STATE);
  }

  async load() {
    const row = await this.database.prepare("SELECT json FROM app_state WHERE id = 1").first();
    if (row?.json) {
      const loaded = JSON.parse(row.json);
      this.state = {
        ...structuredClone(EMPTY_STATE),
        ...loaded,
        version: 3,
        health: { ...structuredClone(EMPTY_STATE.health), ...(loaded.health ?? {}) },
      };
    }
    this.savedJson = JSON.stringify(this.state);
    this.savedContentJson = JSON.stringify({ ...this.state, health: null });
    this.savedHealth = { ...this.state.health };
    return this.state;
  }

  configureChat(chatId) {
    const normalized = String(chatId);
    if (!normalized.startsWith("-")) throw new Error("Configured Telegram chat must be a group or supergroup");
    if (String(this.state.chatId ?? "") === normalized) return false;
    this.state.chatId = normalized;
    this.state.health.nextLiveReconcileAt = 0;
    this.state.pinnedSchedule = null;
    this.state.pinCapability = null;
    this.state.pendingUnpinMessageIds = [];
    for (const record of Object.values(this.state.schedules)) {
      for (const key of [
        "messageId", "messageChatId", "publishedScheduleHash", "publishedSchedule", "renderHash", "sentHash",
        "pinnedHash", "previousMessageId", "sentAt", "editedAt", "viewMode",
        "changeSummary", "corrected", "changeNotifications", "changeNotificationSequence", "renderInputKey",
      ]) delete record[key];
    }
    return true;
  }

  async save() {
    const serialized = JSON.stringify(this.state);
    if (serialized === this.savedJson) return;
    const healthPatch = Object.fromEntries(Object.entries(this.state.health)
      .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(this.savedHealth?.[key])));
    const contentJson = JSON.stringify({ ...this.state, health: null });
    // Most minute ticks only change health. Do not serialize the entire 90 KB
    // timetable snapshot into a D1 request just to advance a timestamp.
    if (contentJson === this.savedContentJson) await patchHealth(this.database, healthPatch);
    else await this.database.prepare(
      "INSERT INTO app_state (id, json, updated_at) VALUES (1, ?, ?) "
      + "ON CONFLICT(id) DO UPDATE SET json = json_set(excluded.json, '$.health', "
      + "json_patch(COALESCE(json_extract(app_state.json, '$.health'), '{}'), json(?))), updated_at = excluded.updated_at",
    ).bind(serialized, new Date().toISOString(), JSON.stringify(healthPatch)).run();
    this.savedJson = serialized;
    this.savedContentJson = contentJson;
    this.savedHealth = { ...this.state.health };
  }
}

// Source discovery uses its own lease and only patches health. A concurrent
// Telegram snapshot must neither block discovery nor overwrite these fields.
export async function patchHealth(database, patch, { heartbeatKey, now = new Date() } = {}) {
  const serialized = JSON.stringify(patch);
  const args = [JSON.stringify(EMPTY_STATE), serialized, now.toISOString(), serialized];
  let condition = "";
  if (heartbeatKey) {
    if (!/^[A-Za-z]+$/u.test(heartbeatKey)) throw new Error("Invalid heartbeat key");
    const clocks = new Set(["lastCronCompletedAt", "lastReconcileSuccessAt", "lastSourcePollAt", "lastSourcePollSuccessAt", "nextSourcePollAt", "lastQueuesSuccessAt", "lastAttentionSuccessAt"]);
    condition = " WHERE (COALESCE(json_extract(app_state.json,?), '')<=?";
    args.push(`$.health.${heartbeatKey}`, new Date(now.getTime() - 180000).toISOString());
    for (const key of Object.keys(patch).filter(key => !clocks.has(key))) {
      condition += " OR json_extract(app_state.json,?) IS NOT json_extract(?,?)";
      args.push(`$.health.${key}`, serialized, `$.${key}`);
    }
    condition += ")";
  }
  await database.prepare(
    "INSERT INTO app_state (id, json, updated_at) VALUES (1, json_set(?, '$.health', json(?)), ?) "
    + "ON CONFLICT(id) DO UPDATE SET json = json_set(app_state.json, '$.health', "
    + "json_patch(COALESCE(json_extract(app_state.json, '$.health'), '{}'), json(?))), updated_at = excluded.updated_at" + condition,
  ).bind(...args).run();
}

// Telegram work is bounded to 25 seconds. An interrupted invocation must not
// stall more than the next minute tick; slow discovery has a separate lease.
export async function withStateLock(database, task, { name = "state", leaseMs = name === "state" ? 60_000 : 180_000 } = {}) {
  const owner = crypto.randomUUID();
  const now = Date.now();
  const acquired = await database.prepare(
    "INSERT INTO runtime_locks (name, owner, locked_until) VALUES (?, ?, ?) "
    + "ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, locked_until = excluded.locked_until "
    + "WHERE runtime_locks.locked_until <= ?",
  ).bind(name, owner, now + leaseMs, now).run();
  if ((acquired.meta?.changes ?? 0) !== 1) return { acquired: false };
  try {
    return { acquired: true, value: await task() };
  } finally {
    const persistent = name === "state" || name === "source" || name === "teacher-source" || name.startsWith("teacher:");
    if (!persistent) {
      await database.prepare("DELETE FROM runtime_locks WHERE name = ? AND owner = ?").bind(name, owner).run();
    } else await database.prepare(
      "UPDATE runtime_locks SET owner = '', locked_until = 0 WHERE name = ? AND owner = ?",
    ).bind(name, owner).run();
  }
}
