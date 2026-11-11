import { escapeHtml } from "./schedule/format.js";
import { ACK_CALLBACK, acknowledgementMarkup, acknowledgementReport, processAcknowledgement, refreshAcknowledgement, recoverAcknowledgements } from "./acknowledgements.js";
import { RECRUITMENT_CALLBACK, createRecruitment, processRecruitment, recruitmentReport, releaseDepartedRecruitments, recoverRecruitments } from "./recruitments.js";
import { PRIVATE_PAGE_CALLBACK, processPrivatePage, announcementLink } from "./private-pages.js";
import { EVENT_REMINDER_CALLBACK, parseReminderArgument, createEventReminder, processEventReminder } from "./event-reminders.js";

export const CURATOR_USER_ID = "900000002";
export const ATTENTION_UPDATES = ["message", "callback_query", "chat_member"];
const GROUP_TYPES = new Set(["group", "supergroup"]);
const changes = result => result.meta?.changes ?? 0;
const isActive = member => ["creator", "administrator", "member"].includes(member?.status)
  || (member?.status === "restricted" && member.is_member === true);
const validUserId = id => /^\d+$/.test(String(id)) && Number.isSafeInteger(Number(id)) && Number(id) > 0;
const validMessageId = id => Number.isSafeInteger(id) && id > 0;
const ATTENTION_CALLBACK = /^attention:(?:join|(?:confirm|cancel):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const userMetadata = user => user ? { id: user.id, first_name: user.first_name, last_name: user.last_name, is_bot: Boolean(user.is_bot) } : null;

export function authorizedAnnouncer(userId, config) {
  if (!validUserId(userId)) return false;
  return [String(config.adminUserId), CURATOR_USER_ID].includes(String(userId));
}

export class AttentionStore {
  constructor(database) { this.db = database; }
  async run(sql, ...values) { return this.db.prepare(sql).bind(...values).run(); }
  async first(sql, ...values) { return this.db.prepare(sql).bind(...values).first(); }
  async all(sql, ...values) { return (await this.db.prepare(sql).bind(...values).all()).results; }
  async setting(key) { return (await this.first("SELECT value FROM attention_settings WHERE key = ?", key))?.value; }
  async setSetting(key, value) {
    await this.run("INSERT INTO attention_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
  }
  async observe(chatId, user, active, now, membershipEvent = false) {
    if (!Number.isSafeInteger(user?.id) || !validUserId(user.id) || user.is_bot) return;
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim().slice(0, 80) || "Участник";
    // A delayed ordinary message must not reactivate somebody who has left.
    await this.run("INSERT INTO attention_members (chat_id,user_id,name,active,observed_at) VALUES (?,?,?,?,?) "
      + "ON CONFLICT(chat_id,user_id) DO UPDATE SET name=excluded.name,active=excluded.active,observed_at=excluded.observed_at "
      + "WHERE excluded.observed_at >= attention_members.observed_at "
      + (membershipEvent ? "" : "AND attention_members.active=1"), String(chatId), String(user.id), name, active ? 1 : 0, now);
  }
  async recipients(request) {
    return this.all("SELECT user_id,name FROM attention_members WHERE chat_id=? AND active=1 AND user_id "
      + (request.test ? "=" : "!=") + " ? ORDER BY user_id", request.chat_id, request.actor_id);
  }
}

// Only metadata enters the attention inbox, never the announcement or chat text.
export async function collectAttentionUpdate({ update, chatId, store, config, now = Date.now() }) {
  const callback = update.callback_query;
  const message = update.message;
  const membership = update.chat_member;
  const chat = message?.chat ?? callback?.message?.chat ?? membership?.chat;
  if (!chatId || !GROUP_TYPES.has(chat?.type) || String(chat.id) !== String(chatId)) return null;
  if (membership) {
    await store.observe(chatId, membership.new_chat_member?.user, isActive(membership.new_chat_member),
      (membership.date ?? now / 1000) * 1000, true);
    await releaseDepartedRecruitments({ store, chatId, now });
    return null;
  }
  if (message) {
    const timestamp = (message.date ?? now / 1000) * 1000;
    if (!message.sender_chat) await store.observe(chatId, message.from, true, timestamp);
    for (const user of message.new_chat_members ?? []) await store.observe(chatId, user, true, timestamp, true);
    if (message.left_chat_member) {
      await store.observe(chatId, message.left_chat_member, false, timestamp, true);
      await releaseDepartedRecruitments({ store, chatId, now });
    }
  }
  const privatePage = PRIVATE_PAGE_CALLBACK.test(callback?.data ?? "");
  if (callback && (ATTENTION_CALLBACK.test(callback.data ?? "") || ACK_CALLBACK.test(callback.data ?? "") || RECRUITMENT_CALLBACK.test(callback.data ?? "") || EVENT_REMINDER_CALLBACK.test(callback.data ?? "") || privatePage) && validUserId(callback.from?.id)
    && !callback.from?.is_bot && (privatePage ? Number.isSafeInteger(callback.message?.ephemeral_message_id) && callback.message.ephemeral_message_id >= 0 : validMessageId(callback.message?.message_id))) {
    return { update_id: update.update_id, _attention: true, callback_query: {
      id: callback.id, data: callback.data, from: userMetadata(callback.from),
      message: { message_id: callback.message.message_id, chat,
        ...(privatePage ? { ephemeral_message_id: callback.message.ephemeral_message_id,
          ...(callback.message.receiver_user ? { receiver_user: { id: callback.message.receiver_user.id } } : {}) } : {}) },
    } };
  }
  if (!message || !validMessageId(message.message_id) || message.sender_chat || message.from?.is_bot || !authorizedAnnouncer(message.from?.id, config)) return null;
  const text = String(message.text ?? message.caption ?? "").trim();
  const command = text.split(/\s+/, 1)[0];
  const prefix = /^!важно(?:\s|$)/iu.test(text);
  const need = /^\/need(?:@\w+)?$/iu.test(command);
  const remind = /^\/remind(?:@\w+)?$/iu.test(command);
  if (!prefix && !need && !remind && !/^\/all(?:_test)?(?:@\w+)?$/iu.test(command)) return null;
  const needArgument = text.slice(command.length).trim();
  return { update_id: update.update_id, _attention: true, message: {
    message_id: message.message_id, chat, from: userMetadata(message.from),
    command: prefix ? "!важно" : command.toLowerCase(),
    ...(need ? { need_count: needArgument === "" ? 5 : /^(?:[1-9]|[12]\d|30)$/.test(needArgument) ? Number(needArgument) : null } : {}),
    ...(remind ? { reminder: parseReminderArgument(needArgument, now) } : {}),
    has_content: prefix && text.replace(/^!важно\s*/iu, "").length > 0,
    origin_key: prefix && message.media_group_id ? `album:${message.media_group_id}` : null,
    reply_to_message: message.reply_to_message ? { message_id: message.reply_to_message.message_id } : null,
  } };
}

export function mentionBatches(members, heading = "Важное объявление") {
  const chunks = [];
  let text = `<b>${heading}</b>\n`;
  let audience = [];
  let count = 0;
  for (const member of members) {
    if (!/^\d+$/.test(String(member.user_id))) continue;
    const link = `<a href="tg://user?id=${member.user_id}">${escapeHtml(member.name)}</a>`;
    // Keep HTML itself below 3500 too, with <= 50 entities per message.
    if (count && (text.length + link.length + 2 > 3500 || count === 50)) {
      chunks.push({ text, members: audience }); text = `<b>${heading} — продолжение</b>\n`; count = 0; audience = [];
    }
    text += (count ? ", " : "") + link;
    count++;
    audience.push(member);
  }
  if (count) chunks.push({ text, members: audience });
  return chunks;
}

export function mentionChunks(members) { return mentionBatches(members).map(batch => batch.text); }

async function closePrompt(client, request, text) {
  if (!request.prompt_id) return;
  try { await client.editMessage(request.chat_id, request.prompt_id, text, { replyMarkup: { inline_keyboard: [] } }); }
  catch (error) { client.logger?.warn("attention_prompt_edit_failed", { requestId: request.id, code: error.errorCode }); }
}

export async function processAttentionUpdate({ update, chatId, store, config, client, now = Date.now() }) {
  const callback = update.callback_query;
  const message = update.message;
  const chat = message?.chat ?? callback?.message?.chat;
  if (!update._attention || !chatId || String(chat?.id) !== String(chatId) || !GROUP_TYPES.has(chat?.type)) return;
  if (callback) {
    if (callback.from?.is_bot || !validUserId(callback.from?.id)) return;
    if (EVENT_REMINDER_CALLBACK.test(callback.data ?? "")) {
      await processEventReminder({ store, client, config, callback, chatId, now }); return;
    }
    if (PRIVATE_PAGE_CALLBACK.test(callback.data ?? "")) {
      await processPrivatePage({ store, client, config, callback, chatId, now, authorized: authorizedAnnouncer,
        renderers: { ack: acknowledgementReport, need: recruitmentReport } }); return;
    }
    if (RECRUITMENT_CALLBACK.test(callback.data ?? "")) {
      await processRecruitment({ store, client, config, callback, chatId, now }); return;
    }
    if (ACK_CALLBACK.test(callback.data ?? "")) {
      await processAcknowledgement({ store, client, config, callback, chatId, now }); return;
    }
    if (!ATTENTION_CALLBACK.test(callback.data ?? "")) return;
    if (callback.data === "attention:join") {
      const registrationId = await store.setting(`registration:${chatId}`);
      if (registrationId && String(callback.message.message_id) !== registrationId) {
        await client.answerCallbackQuery(callback.id, "Используй кнопку «Я в группе» под сообщением регистрации"); return;
      }
      const member = await client.call("getChatMember", { chat_id: chatId, user_id: callback.from.id });
      if (!isActive(member)) return;
      await store.observe(chatId, callback.from, true, now, true);
      await client.answerCallbackQuery(callback.id, "Ты в списке получателей важных объявлений");
      return;
    }
    const match = /^attention:(confirm|cancel):([a-f0-9-]+)$/.exec(callback.data ?? "");
    if (!match) return;
    const request = await store.first("SELECT * FROM attention_requests WHERE id=?", match[2]);
    if (!request || String(request.chat_id) !== String(chatId) || request.prompt_id !== callback.message.message_id
      || !authorizedAnnouncer(callback.from.id, config) || request.actor_id !== String(callback.from.id)) {
      await client.answerCallbackQuery(callback.id, "Подтвердить может только автор вызова"); return;
    }
    if (request.status !== "pending" || request.expires_at <= now) {
      await client.answerCallbackQuery(callback.id, request.expires_at <= now ? "Подтверждение устарело" : "Уже обработано"); return;
    }
    if (match[1] === "cancel") {
      const result = await store.run("UPDATE attention_requests SET status='cancelled',updated_at=? WHERE id=? AND status='pending'", now, request.id);
      await client.answerCallbackQuery(callback.id, "Отменено");
      if (changes(result)) await closePrompt(client, request, "Оповещение отменено");
      return;
    }
    const result = await store.run("UPDATE attention_requests SET status='preparing',confirmed_at=?,updated_at=? "
      + "WHERE id=? AND status='pending' AND expires_at>? AND (test=1 OR NOT EXISTS "
      + "(SELECT 1 FROM attention_requests r WHERE r.chat_id=attention_requests.chat_id AND r.test=0 AND r.confirmed_at>?) AND NOT EXISTS "
      + "(SELECT 1 FROM announcement_reminders n JOIN attention_requests r ON r.id=n.request_id WHERE r.chat_id=attention_requests.chat_id AND r.test=0 AND n.claimed_at>?))",
    now, now, request.id, now, now - 60_000, now - 60_000);
    if (!changes(result)) { await client.answerCallbackQuery(callback.id, "Не чаще одного объявления в минуту"); return; }
    await client.answerCallbackQuery(callback.id, "Оповещение принято");
    await deliverAttentionRequest({ store, client, requestId: request.id, now });
    return;
  }
  if (!message || message.from?.is_bot || !authorizedAnnouncer(message.from?.id, config)) return;
  const [command, botName] = message.command.split("@");
  if (!["!важно", "/all", "/all_test", "/need", "/remind"].includes(command)) return;
  if (botName) {
    const bot = await client.getMe();
    if (botName.toLowerCase() !== bot.username.toLowerCase()) return;
  }
  if (command === "/need") { await createRecruitment({ store, client, message, chatId, now }); return; }
  if (command === "/remind") { await createEventReminder({ store, client, message, chatId, now }); return; }
  const targetId = command === "!важно" ? message.message_id : message.reply_to_message?.message_id;
  if (!validMessageId(targetId) || (command === "!важно" && !message.has_content)) {
    await client.sendMessage(chatId, "Ответь на объявление командой /all или напиши !важно и текст объявления"); return;
  }
  let id = crypto.randomUUID();
  const test = command === "/all_test" ? 1 : 0;
  const origin = message.origin_key ?? `message:${targetId}`;
  const [inserted] = await store.db.batch([
    store.db.prepare("INSERT OR IGNORE INTO attention_requests "
      + "(id,chat_id,target_id,origin_key,actor_id,test,status,expires_at,updated_at) VALUES (?,?,?,?,?,?,'prompting',?,?)")
      .bind(id, String(chatId), targetId, origin, String(message.from.id), test, now + 300_000, now),
    // Only newly-created requests opt in. Legacy announcements remain unchanged.
    store.db.prepare("INSERT OR IGNORE INTO announcement_ack(request_id) SELECT id FROM attention_requests WHERE id=?").bind(id),
  ]);
  if (!changes(inserted)) {
    const previous = await store.first("SELECT * FROM attention_requests WHERE chat_id=? AND origin_key=? AND test=?", String(chatId), origin, test);
    if (!previous || previous.actor_id !== String(message.from.id) || !["cancelled", "expired", "empty"].includes(previous.status)) return;
    const reset = await store.run("UPDATE attention_requests SET status='prompting',prompt_id=NULL,expires_at=?,updated_at=? WHERE id=? AND status=?",
      now + 300_000, now, previous.id, previous.status);
    if (!changes(reset)) return;
    id = previous.id;
  }
  const request = await store.first("SELECT * FROM attention_requests WHERE id=?", id);
  const members = await store.recipients(request);
  if (!members.length) {
    await store.run("UPDATE attention_requests SET status='empty',updated_at=? WHERE id=?", now, id);
    await client.sendMessage(chatId, "Пока нет известных получателей — участникам нужно нажать «Я в группе»"); return;
  }
  try {
    const prompt = await client.sendMessage(chatId, (test ? "Тест: упомянуть только тебя?" : `Оповестить участников: ${members.length} человек?`)
      + "\nВ списке только известные боту участники", {
      replyToMessageId: targetId,
      replyMarkup: { inline_keyboard: [[
        { text: "Оповестить", callback_data: `attention:confirm:${id}` },
        { text: "Отмена", callback_data: `attention:cancel:${id}` },
      ]] },
    });
    await store.run("UPDATE attention_requests SET status='pending',prompt_id=?,updated_at=? WHERE id=?", prompt.message_id, now, id);
  } catch (error) {
    await store.run("UPDATE attention_requests SET status='uncertain',updated_at=? WHERE id=?", now, id);
    client.logger?.warn("attention_prompt_uncertain", { requestId: id, code: error.errorCode });
  }
}

export async function deliverAttentionRequest({ store, client, requestId, now = Date.now() }) {
  let request = await store.first("SELECT * FROM attention_requests WHERE id=?", requestId);
  if (!request || !["preparing", "sending"].includes(request.status)) return;
  if (request.status === "preparing") {
    const existing = await store.first("SELECT 1 FROM attention_parts WHERE request_id=?", requestId);
    if (!existing) {
      const batches = mentionBatches(await store.recipients(request));
      if (!batches.length) {
        await store.run("UPDATE attention_requests SET status='empty',updated_at=? WHERE id=? AND status='preparing'", now, requestId);
        await closePrompt(client, request, "Нет доступных получателей");
        return;
      }
      const statements = [];
      for (const [part, batch] of batches.entries()) {
        statements.push(store.db.prepare("INSERT OR IGNORE INTO attention_parts "
          + "(request_id,part,text,status,updated_at) VALUES (?,?,?,'pending',?)").bind(requestId, part, batch.text, now));
        for (const member of batch.members) statements.push(store.db.prepare("INSERT OR IGNORE INTO announcement_audience(request_id,user_id,name,part) "
          + "SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM announcement_ack WHERE request_id=?)")
          .bind(requestId, member.user_id, member.name, part, requestId));
      }
      if (statements.length) await store.db.batch(statements);
    }
    await store.run("UPDATE attention_requests SET status='sending',updated_at=? WHERE id=? AND status='preparing'", now, requestId);
  }
  const parts = await store.all("SELECT * FROM attention_parts WHERE request_id=? ORDER BY part", requestId);
  for (const part of parts) {
    if (part.status === "sent") continue;
    if (part.status !== "pending" || part.retry_at > now) return;
    const claimed = await store.run("UPDATE attention_parts SET status='sending',updated_at=? WHERE request_id=? AND part=? AND status='pending'",
      now, requestId, part.part);
    if (!changes(claimed)) return;
    try {
      const policy = await store.first("SELECT * FROM announcement_ack WHERE request_id=?", requestId);
      const originalUrl = announcementLink(request.chat_id, request.target_id);
      const provisional = await store.first("SELECT COUNT(*) AS total FROM announcement_audience WHERE request_id=? AND part=?", requestId, part.part);
      const sent = await client.sendMessage(request.chat_id, part.text, { replyToMessageId: request.target_id,
        ...(policy && part.part === 0 ? { replyMarkup: acknowledgementMarkup(requestId, 0, provisional.total, false, originalUrl) }
          : originalUrl ? { replyMarkup: { inline_keyboard: [[{ text: "↗️ К объявлению", url: originalUrl }]] } } : {}) });
      await store.db.batch([
        store.db.prepare("UPDATE attention_parts SET status='sent',message_id=?,updated_at=? WHERE request_id=? AND part=?").bind(sent.message_id, now, requestId, part.part),
        store.db.prepare("UPDATE announcement_ack SET opened_at=COALESCE(opened_at,?),expires_at=COALESCE(expires_at,?),version=version+1 WHERE request_id=?")
          .bind(now, now + 86_400_000, requestId),
      ]);
      if (policy) await refreshAcknowledgement({ store, client, requestId, now, force: true });
    } catch (error) {
      const retry = error.errorCode === 429 && Number.isFinite(error.parameters?.retry_after);
      const status = retry ? "pending" : (!error.errorCode || error.errorCode >= 500 ? "uncertain" : "failed");
      await store.run("UPDATE attention_parts SET status=?,retry_at=?,updated_at=? WHERE request_id=? AND part=?",
        status, retry ? now + Math.max(1, error.parameters.retry_after) * 1000 : 0, now, requestId, part.part);
      if (!retry) await store.run("UPDATE attention_requests SET status=?,updated_at=? WHERE id=?", status, now, requestId);
      client.logger?.warn("attention_delivery_stopped", { requestId, part: part.part, status, code: error.errorCode });
      if (!retry) await closePrompt(client, request, status === "uncertain"
        ? "Результат отправки неизвестен — автоматический повтор отключён, чтобы не было дублей"
        : "Не удалось отправить оповещение");
      return;
    }
  }
  const unfinished = await store.first("SELECT 1 FROM attention_parts WHERE request_id=? AND status!='sent'", requestId);
  if (!unfinished) {
    await store.run("UPDATE attention_requests SET status='sent',updated_at=? WHERE id=? AND status='sending'", now, requestId);
    await closePrompt(client, request, "Оповещение отправлено");
    client.logger?.info("attention_sent", { requestId, parts: parts.length, test: Boolean(request.test) });
  }
}

export async function recoverAttention({ store, client, chatId, now = Date.now() }) {
  // A crash after a send began may have delivered it: never replay that part.
  const abandoned = await store.run("UPDATE attention_parts SET status='uncertain' WHERE status='sending' AND updated_at<?", now - 180_000);
  if (changes(abandoned)) client.logger?.warn("attention_abandoned_send_uncertain", { parts: changes(abandoned) });
  await store.run("UPDATE attention_requests SET status='uncertain',updated_at=? WHERE status='sending' AND EXISTS "
    + "(SELECT 1 FROM attention_parts p WHERE p.request_id=attention_requests.id AND p.status='uncertain')", now);
  await store.run("UPDATE attention_requests SET status='uncertain',updated_at=? WHERE status='prompting' AND updated_at<?", now, now - 180_000);
  const expired = await store.all("SELECT * FROM attention_requests WHERE status='pending' AND expires_at<=? AND chat_id=?", now, String(chatId));
  for (const request of expired) {
    await store.run("UPDATE attention_requests SET status='expired',updated_at=? WHERE id=? AND status='pending'", now, request.id);
    await closePrompt(client, request, "Срок подтверждения истёк");
  }
  const pending = await store.all("SELECT id FROM attention_requests WHERE chat_id=? AND status IN ('preparing','sending') ORDER BY updated_at LIMIT 10", String(chatId));
  for (const request of pending) await deliverAttentionRequest({ store, client, requestId: request.id, now });
  await recoverAcknowledgements({ store, client, chatId, now });
  await recoverRecruitments({ store, client, chatId, now });
}
