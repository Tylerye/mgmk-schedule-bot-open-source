import { dateInTimezone } from "../dates.js";
import { dateTitle, escapeHtml } from "./format.js";

export async function prepareChangeNotification({ record, changes, store, now, timezone, targetHash }) {
  if (!changes.length || record.schedule.date < dateInTimezone(now, timezone)) return;
  const queue = record.changeNotifications ??= [];
  const latest = queue.at(-1);
  const fromHash = record.publishedScheduleHash;
  if (latest?.fromHash === fromHash && latest?.targetHash === targetHash && latest.status !== "superseded") return;
  const sequence = record.changeNotificationSequence = (record.changeNotificationSequence ?? 0) + 1;
  const title = dateTitle(record.schedule.date);
  const text = `<b>Расписание обновлено — ${escapeHtml(title[0].toLowerCase() + title.slice(1))}</b>\n`
    + changes.map((line) => escapeHtml(line.replace(" урок убран:", " урок отменён:"))).join("\n");
  queue.push({ id: `${record.schedule.date}:${sequence}`, fromHash, targetHash,
    chatId: String(store.state.chatId), text, status: "pending", createdAt: now.toISOString() });
  // Keep unresolved work, plus the latest completed transitions for diagnostics.
  const completed = queue.filter((item) => !["pending", "sending"].includes(item.status)).slice(-50);
  record.changeNotifications = queue.filter((item) => ["pending", "sending"].includes(item.status) || completed.includes(item));
  await store.save();
}

export async function deliverChangeNotifications({ record, client, store, logger, now, timezone }) {
  for (const item of record.changeNotifications ?? []) {
    if (item.status === "sending") {
      item.status = "uncertain";
      await store.save();
      logger.warn("schedule_notification_uncertain", { id: item.id, reason: "interrupted_send" });
      continue;
    }
    if (item.status !== "pending") continue;
    if (item.chatId !== String(store.state.chatId) || record.schedule.date < dateInTimezone(now, timezone)
      || (item.targetHash !== record.publishedScheduleHash && item.targetHash !== record.scheduleHash)) {
      item.status = "superseded";
      await store.save();
      continue;
    }
    if (record.publishedScheduleHash !== item.targetHash || (item.retryAt && now.getTime() < item.retryAt)) continue;
    item.status = "sending";
    await store.save();
    let message;
    try {
      message = await client.sendMessage(store.state.chatId, item.text);
    } catch (error) {
      const code = error.errorCode;
      item.status = code === 429 ? "pending" : code >= 400 && code < 500 ? "failed" : "uncertain";
      if (code === 429) item.retryAt = now.getTime() + Math.max(60, Number(error.parameters?.retry_after) || 60) * 1000;
      await store.save();
      logger.warn("schedule_notification_failed", { id: item.id, status: item.status, error: error.message });
      continue;
    }
    item.status = "sent";
    item.messageId = message.message_id;
    item.sentAt = now.toISOString();
    await store.save();
    logger.info("schedule_notification_sent", { id: item.id, messageId: item.messageId });
  }
}
