import { addDays, dateInTimezone, eventHasEnded } from "./dates.js";
import { escapeHtml, formatScheduleMessage, renderSchedule } from "./schedule/format.js";
import { formatNextMessage } from "./schedule/next.js";
import { formatDaySummary } from "./schedule/day.js";

export class TelegramApiError extends Error {
  constructor(method, description, errorCode = null, parameters = {}) {
    super(`Telegram ${method} failed: ${description}`);
    this.name = "TelegramApiError";
    this.method = method;
    this.description = description;
    this.errorCode = errorCode;
    this.parameters = parameters;
  }
}

export function isMessageNotModified(error) {
  return error instanceof TelegramApiError && /message is not modified/iu.test(error.description);
}

export function isMessageUneditable(error) {
  return error instanceof TelegramApiError && /(message to edit not found|message can't be edited|message can not be edited)/iu.test(error.description);
}

export function isPinPermissionError(error) {
  return error instanceof TelegramApiError
    && [400, 403].includes(error.errorCode)
    && /(not enough rights|chat_admin_required|can't pin|cannot pin|not an administrator|need administrator rights)/iu.test(error.description);
}

export class TelegramClient {
  constructor({ token, logger, abortSignal = null, timeoutMs = 35_000 }) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.logger = logger;
    this.abortSignal = abortSignal;
    this.timeoutMs = timeoutMs;
    this.botId = null;
  }

  async call(method, body = {}) {
    let response;
    try {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = this.abortSignal ? AbortSignal.any([timeout, this.abortSignal]) : timeout;
      response = await fetch(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new TelegramApiError(method, error.name === "AbortError" ? "request aborted" : "network request failed");
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramApiError(method, `invalid HTTP ${response.status} response`, response.status);
    }
    if (!response.ok || !payload.ok) {
      const error = new TelegramApiError(method, payload.description ?? `HTTP ${response.status}`, payload.error_code ?? response.status, payload.parameters);
      error.apiRejected = payload.ok === false;
      throw error;
    }
    return payload.result;
  }

  async getMe() {
    const bot = await this.call("getMe");
    this.botId = bot.id;
    return bot;
  }

  async getPinCapability(chatId) {
    if (!this.botId) throw new TelegramApiError("getChatMember", "bot identity is unavailable");
    const member = await this.call("getChatMember", { chat_id: chatId, user_id: this.botId });
    return {
      canPin: member.status === "creator"
        || (member.status === "administrator" && member.can_pin_messages === true),
      status: member.status,
    };
  }

  getUpdates(offset, timeout = 20) {
    return this.call("getUpdates", { offset, timeout, allowed_updates: ["message", "callback_query", "chat_member"] });
  }

  sendMessage(chatId, text, { replyMarkup, replyToMessageId } = {}) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: false } } : {}),
    });
  }

  editMessage(chatId, messageId, text, { replyMarkup } = {}) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  pinMessage(chatId, messageId) {
    return this.call("pinChatMessage", { chat_id: chatId, message_id: messageId, disable_notification: false });
  }

  unpinOwnMessage(chatId, messageId) {
    return this.call("unpinChatMessage", { chat_id: chatId, message_id: messageId });
  }

  async answerCallbackQuery(callbackQueryId, text) {
    try {
      return await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
    } catch (error) {
      // A durable webhook may be replayed after Telegram's spinner has expired.
      // The requested view still needs to be applied to the schedule message.
      if (error.errorCode === 400 && /query is too old|query ID is invalid/iu.test(error.description)) return;
      throw error;
    }
  }
}

function commandName(text) {
  return String(text ?? "").trim().split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
}

export function isReadOnlyTelegramUpdate(update) {
  return !update.callback_query && ["/next", "/day", "/today", "/tomorrow", "/latest", "/status"]
    .includes(commandName(update.message?.text));
}

function latestSchedule(state) {
  return Object.values(state.schedules).sort((a, b) => b.schedule.date.localeCompare(a.schedule.date))[0] ?? null;
}

function callbackAction(data) {
  const match = /^schedule:(\d{4}-\d{2}-\d{2}):(compact|full)$/.exec(String(data ?? ""));
  return match ? { date: match[1], mode: match[2] } : null;
}

function isCompletedSchedule(record, now, timezone) {
  const date = record.schedule.date;
  const today = dateInTimezone(now, timezone);
  if (date < today || record.completionViewInitialized) return true;
  if (date > today) return false;
  const events = record.schedule.timeline ?? record.schedule.lessons ?? [];
  return events.length > 0 && events.every((event) => event.end && eventHasEnded(date, event.end, now, timezone));
}

export async function acknowledgeScheduleCallbacks({ client, state, updates }) {
  const acknowledged = new Set();
  for (const update of updates) {
    const callback = update.callback_query;
    const chat = callback?.message?.chat;
    const action = callbackAction(callback?.data);
    if (!callback || !chat || !action) continue;
    if (!state.chatId || String(chat.id) !== String(state.chatId)) continue;
    const record = state.schedules[action.date];
    if (!record || Number(record.messageId) !== Number(callback.message.message_id)) continue;
    await client.answerCallbackQuery(callback.id);
    acknowledged.add(callback.id);
  }
  return acknowledged;
}

export async function processTelegramUpdates({
  client, store, config, updates, reconcile = async () => {}, now = new Date(), acknowledgedCallbacks = new Set(),
}) {
  if (updates.length === 0) return;
  let shouldReconcile = false;
  for (const update of updates) {
    store.state.updateOffset = Math.max(store.state.updateOffset, update.update_id + 1);

    if (update.callback_query) {
      const callback = update.callback_query;
      const chat = callback.message?.chat;
      const action = callbackAction(callback.data);
      if (!chat || !new Set(["group", "supergroup"]).has(chat.type)) continue;
      if (!store.state.chatId || String(chat.id) !== String(store.state.chatId) || !action) continue;
      const record = store.state.schedules[action.date];
      if (!record || Number(record.messageId) !== Number(callback.message.message_id)) continue;
      if (!acknowledgedCallbacks.has(callback.id)) await client.answerCallbackQuery(callback.id);
      record.viewMode = action.mode;
      const completed = isCompletedSchedule(record, now, config.timezone);
      const rendering = renderSchedule(record.schedule, {
        updated: Boolean(record.corrected) && !completed,
        changeSummary: record.changeSummary ?? [],
        mode: action.mode,
        now,
        timezone: config.timezone,
        withKeyboard: true,
        completed,
      });
      try {
        await client.editMessage(chat.id, record.messageId, rendering.text, { replyMarkup: rendering.replyMarkup });
      } catch (error) {
        if (!isMessageNotModified(error)) throw error;
      }
      record.renderHash = rendering.hash;
      delete record.renderInputKey;
      await store.save();
      client.logger?.info("callback_view_changed", { date: action.date, viewMode: action.mode });
      continue;
    }

    const message = update.message;
    if (!message || !new Set(["group", "supergroup"]).has(message.chat?.type)) continue;
    const command = commandName(message.text);
    if (!command.startsWith("/")) continue;
    const chatId = String(message.chat.id);

    if (command === "/setup") {
      if (String(message.from?.id) !== String(config.adminUserId)) continue;
      store.configureChat(chatId);
      await store.save();
      await client.sendMessage(chatId, `✅ Группа подключена. Расписание ${escapeHtml(config.displayGroup)} настроено.`);
      shouldReconcile = true;
      continue;
    }

    if (!store.state.chatId || chatId !== String(store.state.chatId)) continue;
    const today = dateInTimezone(now, config.timezone);
    const requestedDate = command === "/today" ? today : command === "/tomorrow" ? addDays(today, 1) : null;
    if (command === "/day") {
      const tomorrow = addDays(today, 1);
      await client.sendMessage(chatId, formatDaySummary(store.state.schedules[tomorrow]?.schedule, { date: tomorrow }));
    } else if (command === "/next") {
      await client.sendMessage(chatId, formatNextMessage(store.state.schedules[today]?.schedule, { now, timezone: config.timezone }));
    } else if (requestedDate) {
      const record = store.state.schedules[requestedDate];
      await client.sendMessage(chatId, record
        ? formatScheduleMessage(record.schedule, { mode: "full", now, timezone: config.timezone, updated: record.corrected })
        : `Расписание на ${requestedDate} ещё не найдено.`);
    } else if (command === "/latest") {
      const record = latestSchedule(store.state);
      await client.sendMessage(chatId, record
        ? formatScheduleMessage(record.schedule, { mode: "full", now, timezone: config.timezone, updated: record.corrected })
        : "Расписание ещё не загружено.");
    } else if (command === "/status" && String(message.from?.id) === String(config.adminUserId)) {
      const health = store.state.health;
      const pinStatus = store.state.pinCapability?.canPin === true
        ? "доступно"
        : store.state.pinCapability?.canPin === false ? "нет права Pin Messages" : "ещё не проверено";
      await client.sendMessage(chatId, [
        "✅ Бот работает",
        `Группа: ${escapeHtml(config.displayGroup)}`,
        `Источник: ${escapeHtml(health.lastSourcePollSuccessAt ?? "ещё не проверен")}`,
        `Последний парсинг: ${escapeHtml(health.lastParserSuccessAt ?? "ещё не выполнялся")}`,
        `Закреплённая дата: ${escapeHtml(store.state.pinnedSchedule?.date ?? "нет")}`,
        `Закрепление: ${escapeHtml(pinStatus)}`,
        `Следующая проверка: ${escapeHtml(health.nextSourcePollAt ?? "вычисляется")}`,
      ].join("\n"));
    }
  }
  await store.save();
  if (shouldReconcile) await reconcile(now);
}
