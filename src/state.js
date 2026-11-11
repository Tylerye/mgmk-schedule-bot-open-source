import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EMPTY_STATE } from "./state-shape.js";

export { EMPTY_STATE } from "./state-shape.js";

function clearChatDelivery(record) {
  for (const key of [
    "messageId", "messageChatId", "publishedScheduleHash", "publishedSchedule", "renderHash", "sentHash",
    "pinnedHash", "previousMessageId", "sentAt", "editedAt", "viewMode",
    "changeSummary", "corrected", "changeNotifications", "changeNotificationSequence", "renderInputKey",
  ]) delete record[key];
}

export class StateStore {
  constructor(path) {
    this.path = path;
    this.state = structuredClone(EMPTY_STATE);
    this.saveQueue = Promise.resolve();
  }

  async load() {
    try {
      const loaded = JSON.parse(await readFile(this.path, "utf8"));
      this.state = {
        ...structuredClone(EMPTY_STATE),
        ...loaded,
        version: 3,
        health: { ...structuredClone(EMPTY_STATE.health), ...(loaded.health ?? {}) },
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    // A private Telegram chat ID is positive. It was valid only for the local MVP
    // and must never become the production destination after this migration.
    if (this.state.chatId && !String(this.state.chatId).startsWith("-")) {
      this.state.chatId = null;
      this.state.pinnedSchedule = null;
      this.state.pinCapability = null;
      this.state.pendingUnpinMessageIds = [];
      for (const record of Object.values(this.state.schedules)) clearChatDelivery(record);
      await this.save();
    }
    return this.state;
  }

  configureChat(chatId) {
    const normalized = String(chatId);
    if (!normalized.startsWith("-")) throw new Error("Configured Telegram chat must be a group or supergroup");
    if (String(this.state.chatId ?? "") === normalized) return false;
    this.state.chatId = normalized;
    this.state.pinnedSchedule = null;
    this.state.pinCapability = null;
    this.state.pendingUnpinMessageIds = [];
    for (const record of Object.values(this.state.schedules)) clearChatDelivery(record);
    return true;
  }

  async save() {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    const operation = this.saveQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.tmp`;
      await writeFile(temporaryPath, snapshot, { mode: 0o600 });
      await rename(temporaryPath, this.path);
    });
    this.saveQueue = operation.catch(() => {});
    await operation;
  }
}
