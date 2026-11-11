import { cutoffReached, dateInTimezone, timeInTimezone } from "./dates.js";
import { renderSchedule } from "./schedule/format.js";
import { describeScheduleChanges } from "./schedule/changes.js";
import { prepareChangeNotification, deliverChangeNotifications } from "./schedule/notifications.js";
import { isMessageNotModified, isMessageUneditable, isPinPermissionError } from "./telegram.js";

const PIN_CAPABILITY_RECHECK_MS = 5 * 60 * 1_000;

function scheduleHash(record) {
  return record.scheduleHash ?? record.schedule?.hash ?? record.hash;
}

function belongsToChat(record, chatId) {
  return record.messageId && String(record.messageChatId) === String(chatId);
}

function renderingFor(record, config, now, pinned) {
  const today = dateInTimezone(now, config.timezone);
  const events = record.schedule.timeline ?? record.schedule.lessons.map((lesson) => ({
    ...lesson,
    end: lesson.time?.[1] ?? null,
  }));
  const currentTime = timeInTimezone(now, config.timezone);
  const dayFinished = record.schedule.date < today || (record.schedule.date === today
    && events.length > 0
    && events.every((event) => event.end && event.end <= currentTime));
  if (dayFinished && !record.completionViewInitialized) {
    if (record.viewMode !== "full") record.viewMode = "compact";
    record.completionViewInitialized = true;
  }
  const completed = dayFinished;
  const mode = pinned || completed ? (record.viewMode ?? "compact") : "full";
  const inputKey = JSON.stringify([scheduleHash(record), mode, pinned, completed, Boolean(record.corrected),
    record.changeSummary ?? [],
    pinned || completed ? events.filter(event => event.end && (record.schedule.date < today
      || (record.schedule.date === today && event.end <= currentTime))).length : 0]);
  if (record.renderHash && record.renderInputKey === inputKey) return { hash: record.renderHash, inputKey };
  return { ...renderSchedule(record.schedule, {
    updated: Boolean(record.corrected) && !completed,
    changeSummary: record.changeSummary ?? [],
    mode,
    now: pinned || completed ? now : null,
    timezone: config.timezone,
    withKeyboard: pinned || completed,
    completed,
  }), inputKey };
}

async function editIfChanged({ client, store, logger, record, rendering, reason }) {
  if (record.renderHash === rendering.hash) {
    record.renderInputKey = rendering.inputKey;
    return false;
  }
  try {
    await client.editMessage(store.state.chatId, record.messageId, rendering.text, { replyMarkup: rendering.replyMarkup });
  } catch (error) {
    if (!isMessageNotModified(error)) throw error;
  }
  record.renderHash = rendering.hash;
  record.renderInputKey = rendering.inputKey;
  record.editedAt = new Date().toISOString();
  await store.save();
  logger.info(reason, { date: record.schedule.date, messageId: record.messageId });
  return true;
}

async function ensurePublished({ client, store, config, logger, record, now, activeDate = null }) {
  const chatId = String(store.state.chatId);
  if (record.messageId && !belongsToChat(record, chatId)) {
    delete record.messageId;
    delete record.renderHash;
    delete record.renderInputKey;
    delete record.publishedScheduleHash;
    delete record.publishedSchedule;
    delete record.changeNotifications;
    delete record.changeNotificationSequence;
  }
  const pinned = activeDate === record.schedule.date
    || (store.state.pinnedSchedule?.date === record.schedule.date
      && Number(store.state.pinnedSchedule?.messageId) === Number(record.messageId));
  const rendering = renderingFor(record, config, now, pinned);
  const currentScheduleHash = scheduleHash(record);

  if (record.messageId && !record.publishedSchedule && record.publishedScheduleHash === currentScheduleHash) {
    record.publishedSchedule = structuredClone(record.schedule);
    await store.save();
  }

  if (!record.messageId) {
    const message = await client.sendMessage(chatId, rendering.text, { replyMarkup: rendering.replyMarkup });
    record.messageId = message.message_id;
    record.messageChatId = chatId;
    record.publishedScheduleHash = currentScheduleHash;
    record.publishedSchedule = structuredClone(record.schedule);
    record.renderHash = rendering.hash;
    record.renderInputKey = rendering.inputKey;
    record.sentAt = new Date().toISOString();
    await store.save();
    logger.info("telegram_schedule_posted", { date: record.schedule.date, messageId: record.messageId });
    return;
  }

  const scheduleChanged = record.publishedScheduleHash !== currentScheduleHash;
  if (!scheduleChanged && record.renderHash === rendering.hash) return;
  if (scheduleChanged && record.publishedScheduleHash) {
    record.corrected = true;
    record.changeSummary = record.publishedSchedule
      ? describeScheduleChanges(record.publishedSchedule, record.schedule)
      : [];
    await prepareChangeNotification({ record, changes: record.changeSummary, store, now,
      timezone: config.timezone, targetHash: currentScheduleHash });
  }
  const correctedRendering = renderingFor(record, config, now, pinned);
  try {
    await editIfChanged({
      client, store, logger, record, rendering: correctedRendering,
      reason: scheduleChanged ? "telegram_schedule_edited" : "live_message_updated",
    });
    record.publishedScheduleHash = currentScheduleHash;
    record.publishedSchedule = structuredClone(record.schedule);
    await store.save();
  } catch (error) {
    if (!isMessageUneditable(error)) throw error;
    const oldMessageId = record.messageId;
    const message = await client.sendMessage(chatId, correctedRendering.text, { replyMarkup: correctedRendering.replyMarkup });
    record.messageId = message.message_id;
    record.messageChatId = chatId;
    record.publishedScheduleHash = currentScheduleHash;
    record.publishedSchedule = structuredClone(record.schedule);
    record.renderHash = correctedRendering.hash;
    record.renderInputKey = correctedRendering.inputKey;
    record.sentAt = new Date().toISOString();
    await store.save();
    logger.warn("telegram_schedule_reposted", {
      date: record.schedule.date,
      messageId: record.messageId,
      replacedMessageId: oldMessageId,
      reason: error.message,
    });
  }
}

export function desiredPinnedDate(state, config, now) {
  const today = dateInTimezone(now, config.timezone);
  const published = (date) => {
    const record = state.schedules[date];
    return record && belongsToChat(record, state.chatId);
  };
  const nextDate = Object.keys(state.schedules).filter(date => date > today && published(date)).sort()[0];
  if (cutoffReached(now, config.timezone, config.pinSwitchTime) && nextDate) return nextDate;
  if (published(today)) return today;
  return state.pinnedSchedule?.date ?? null;
}

async function retryPendingUnpins({ client, store, logger }) {
  const pending = [...new Map(store.state.pendingUnpinMessageIds.map((item) => [`${item.chatId}:${item.messageId}`, item])).values()];
  store.state.pendingUnpinMessageIds = [];
  for (const item of pending) {
    try {
      await client.unpinOwnMessage(item.chatId, item.messageId);
    } catch (error) {
      store.state.pendingUnpinMessageIds.push(item);
      logger.warn("pin_cleanup_failed", { messageId: item.messageId, error: error.message });
    }
  }
}

async function pinCapability({ client, store, logger, now }) {
  if (typeof client.getPinCapability !== "function") return { canPin: true, status: "not-checked" };
  const cached = store.state.pinCapability;
  const fresh = cached
    && String(cached.chatId) === String(store.state.chatId)
    && Number.isFinite(Date.parse(cached.checkedAt))
    && now.getTime() - Date.parse(cached.checkedAt) < PIN_CAPABILITY_RECHECK_MS;
  if (fresh) return cached;

  try {
    const capability = await client.getPinCapability(store.state.chatId);
    store.state.pinCapability = {
      chatId: String(store.state.chatId),
      canPin: capability.canPin === true,
      status: capability.status ?? "unknown",
      checkedAt: now.toISOString(),
    };
  } catch (error) {
    store.state.pinCapability = {
      chatId: String(store.state.chatId),
      canPin: false,
      status: "check-failed",
      checkedAt: now.toISOString(),
    };
    logger.warn("pin_capability_check_failed", { error: error.message });
  }
  await store.save();
  if (!store.state.pinCapability.canPin) {
    logger.warn("pin_capability_unavailable", { status: store.state.pinCapability.status });
  }
  return store.state.pinCapability;
}

async function markPinUnavailable({ store, logger, error, now }) {
  store.state.pinCapability = {
    chatId: String(store.state.chatId),
    canPin: false,
    status: "permission-denied",
    checkedAt: now.toISOString(),
  };
  await store.save();
  logger.warn("pin_capability_unavailable", { status: "permission-denied", error: error.message });
}

export async function ensureDesiredState({ client, store, config, logger, now = new Date() }) {
  if (!client || !store.state.chatId) return { configured: false };
  const today = dateInTimezone(now, config.timezone);
  const records = Object.values(store.state.schedules)
    .filter((record) => record.schedule.date >= today || record.viewMode === "full")
    // ISO dates sort bytewise; ICU collation adds expensive cold-start work.
    .sort((left, right) => left.schedule.date < right.schedule.date ? -1 : left.schedule.date > right.schedule.date ? 1 : 0);

  const activeDate = desiredPinnedDate(store.state, config, now);
  const failures = [];
  const publishRecords = async (selected) => {
    for (const record of selected) {
      try {
        await ensurePublished({ client, store, config, logger, record, now, activeDate });
      } catch (error) {
        if (error.parameters?.migrate_to_chat_id) throw error;
        failures.push(error);
        logger.warn("schedule_publish_deferred", { date: record.schedule.date, error: error.message });
        continue;
      }
      try {
        await deliverChangeNotifications({ record, client, store, logger, now, timezone: config.timezone });
      } catch (error) {
        logger.warn("schedule_notification_deferred", { date: record.schedule.date, error: error.message });
      }
    }
  };
  // Old expanded cards must not consume the Telegram budget before today's
  // live edit, new publications and the 16:00 pin rotation.
  await publishRecords(records.filter(record => record.schedule.date >= today));

  const desiredDate = desiredPinnedDate(store.state, config, now);
  const desiredRecord = desiredDate ? store.state.schedules[desiredDate] : null;
  const currentPin = store.state.pinnedSchedule;
  if (desiredRecord && belongsToChat(desiredRecord, store.state.chatId)) {
    desiredRecord.viewMode ??= "compact";
    const desiredMessageId = desiredRecord.messageId;
    const pinChanged = String(currentPin?.chatId ?? "") !== String(store.state.chatId)
      || Number(currentPin?.messageId) !== Number(desiredMessageId);

    const liveRendering = renderingFor(desiredRecord, config, now, true);
    await editIfChanged({ client, store, logger, record: desiredRecord, rendering: liveRendering, reason: "live_message_updated" });

    if (pinChanged) {
      const capability = await pinCapability({ client, store, logger, now });
      if (!capability.canPin) {
        await store.save();
        return { configured: true, pinnedDate: currentPin?.date ?? null, activeDate: desiredDate, canPin: false };
      }
      try {
        await client.pinMessage(store.state.chatId, desiredMessageId);
      } catch (error) {
        if (!isPinPermissionError(error)) throw error;
        await markPinUnavailable({ store, logger, error, now });
        return { configured: true, pinnedDate: currentPin?.date ?? null, activeDate: desiredDate, canPin: false };
      }
      const oldPin = currentPin ? { ...currentPin } : null;
      store.state.pinnedSchedule = { chatId: String(store.state.chatId), date: desiredDate, messageId: desiredMessageId };
      await store.save();
      if (oldPin && Number(oldPin.messageId) !== Number(desiredMessageId)) {
        try {
          await client.unpinOwnMessage(oldPin.chatId, oldPin.messageId);
        } catch (error) {
          store.state.pendingUnpinMessageIds.push({ chatId: oldPin.chatId, messageId: oldPin.messageId });
          logger.warn("pin_cleanup_failed", { messageId: oldPin.messageId, error: error.message });
        }
        const oldRecord = store.state.schedules[oldPin.date];
        if (oldRecord && belongsToChat(oldRecord, store.state.chatId)
          && Number(oldRecord.messageId) === Number(oldPin.messageId)) {
          oldRecord.viewMode ??= "compact";
          const staticRendering = renderingFor(oldRecord, config, now, false);
          await editIfChanged({ client, store, logger, record: oldRecord, rendering: staticRendering, reason: "live_message_updated" });
        }
      }
      await store.save();
      logger.info("pin_rotated", { fromDate: oldPin?.date ?? null, toDate: desiredDate, messageId: desiredMessageId });
    }
  }

  if (store.state.pinnedSchedule) {
    const capability = await pinCapability({ client, store, logger, now });
    if (capability.canPin) await retryPendingUnpins({ client, store, logger });
  }

  await publishRecords(records.filter(record => record.schedule.date < today));
  await store.save();
  if (failures.length) throw failures[0];
  return { configured: true, pinnedDate: store.state.pinnedSchedule?.date ?? null };
}
