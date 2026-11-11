import { authorizedAnnouncer, mentionBatches } from "./attention.js";
import { escapeHtml } from "./schedule/format.js";
import { announcementLink, openPrivatePages } from "./private-pages.js";

const changed = result => (result.meta?.changes ?? 0) > 0;
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
export const ACK_CALLBACK = new RegExp(`^ack:(read|report|remind|close|send|cancel):(${UUID})$`);
const deliveredAudience = " FROM announcement_audience a JOIN attention_parts p ON p.request_id=a.request_id AND p.part=a.part AND p.status='sent' ";
const open = (policy, now) => policy?.opened_at != null && !policy.closed_at && policy.expires_at > now;

export function acknowledgementMarkup(id, confirmed, total, closed = false, originalUrl = null) {
  return { inline_keyboard: [
    [{ text: `${closed ? "Итог" : "✅ Ознакомился"} · ${confirmed}/${total}`, callback_data: `ack:read:${id}` }],
    closed ? [{ text: "📋 Сводка", callback_data: `ack:report:${id}` }] : [
      { text: "📋 Сводка", callback_data: `ack:report:${id}` },
      { text: "🔔 Напомнить", callback_data: `ack:remind:${id}` },
      { text: "Закрыть", callback_data: `ack:close:${id}` },
    ],
    ...(originalUrl ? [[{ text: "↗️ К объявлению", url: originalUrl }]] : []),
  ] };
}

async function audience(store, requestId, remaining = false) {
  return store.all("SELECT a.*" + deliveredAudience
    + (remaining ? "JOIN attention_requests r ON r.id=a.request_id JOIN attention_members m ON m.chat_id=r.chat_id AND m.user_id=a.user_id AND m.active=1 " : "")
    + "WHERE a.request_id=? " + (remaining ? "AND a.confirmed_at IS NULL " : "") + "ORDER BY a.user_id", requestId);
}

export async function refreshAcknowledgement({ store, client, requestId, now = Date.now(), force = false, drain = true }) {
  const token = crypto.randomUUID();
  const claim = await store.run("UPDATE announcement_ack SET render_owner=?,render_until=? WHERE request_id=? AND render_until<=? "
    + (force ? "" : "AND version!=rendered_version AND next_render_at<=?"),
  ...[token, now + 60_000, requestId, now, ...(force ? [] : [now])]);
  if (!changed(claim)) return;
  try {
    const policy = await store.first("SELECT * FROM announcement_ack WHERE request_id=?", requestId);
    const part = await store.first("SELECT p.message_id,r.chat_id,r.target_id FROM attention_parts p JOIN attention_requests r ON r.id=p.request_id WHERE p.request_id=? AND p.part=0 AND p.status='sent'", requestId);
    if (!part) return;
    const counts = await store.first("SELECT COUNT(*) AS total,COUNT(a.confirmed_at) AS confirmed" + deliveredAudience + "WHERE a.request_id=?", requestId);
    try {
      await client.call("editMessageReplyMarkup", { chat_id: part.chat_id, message_id: part.message_id,
        reply_markup: acknowledgementMarkup(requestId, counts.confirmed, counts.total, !open(policy, now), announcementLink(part.chat_id, part.target_id)) });
    } catch (error) {
      if (!/message is not modified/iu.test(error.description ?? "")) throw error;
    }
    await store.run("UPDATE announcement_ack SET rendered_version=?,next_render_at=? WHERE request_id=? AND render_owner=?", policy.version, now + 800, requestId, token);
  } catch (error) {
    const delay = error.errorCode === 429 ? Math.max(1, error.parameters?.retry_after ?? 1) * 1000 : 5000;
    const removed = error.errorCode === 400 && /message to edit not found|message can't be edited|message can not be edited/iu.test(error.description ?? "");
    if (removed) await store.run("UPDATE announcement_ack SET rendered_version=version,next_render_at=? WHERE request_id=? AND render_owner=?", now + 86_400_000, requestId, token);
    else await store.run("UPDATE announcement_ack SET next_render_at=? WHERE request_id=? AND render_owner=?", now + delay, requestId, token);
    client.logger?.warn("ack_counter_edit_failed", { requestId, code: error.errorCode });
  } finally {
    await store.run("UPDATE announcement_ack SET render_until=0,render_owner=NULL WHERE request_id=? AND render_owner=?", requestId, token);
  }
  // A click arriving during the API edit must not leave the final burst stale until Cron.
  if (drain) {
    const dirty = await store.first("SELECT 1 FROM announcement_ack WHERE request_id=? AND version!=rendered_version AND next_render_at<=?", requestId, now + 800);
    if (dirty) {
      await new Promise(resolve => setTimeout(resolve, 800));
      await refreshAcknowledgement({ store, client, requestId, now: Math.max(now + 800, Date.now()), drain: false });
    }
  }
}

export async function acknowledgementReport({ store, id, chatId, now, page }) {
  const request = await store.first("SELECT * FROM attention_requests WHERE id=?", id);
  if (!request || String(request.chat_id) !== String(chatId)) return null;
  const members = await audience(store, id);
  // Sort before pagination; retain roster order within each confirmation group.
  members.sort((a, b) => Number(b.confirmed_at != null) - Number(a.confirmed_at != null));
  const policy = await store.first("SELECT * FROM announcement_ack WHERE request_id=?", id);
  const confirmed = members.filter(m => m.confirmed_at != null).length;
  // Small pages bound both HTML length and the number of private API requests per click.
  const pages = Math.max(1, Math.ceil(members.length / 6));
  page = Math.max(0, Math.min(page, pages - 1));
  const lines = members.slice(page * 6, page * 6 + 6).map(m => `${m.confirmed_at == null ? "⏳" : "✅"} ${escapeHtml(m.name)}`);
  const text = [`<b>Ознакомились: ${confirmed}/${members.length}</b>`, open(policy, now) ? "Подтверждения открыты" : "Подтверждения закрыты",
    "Добровольное подтверждение, не доказательство прочтения", ...lines,
    `Страница ${page + 1}/${pages}`].join("\n");
  return { text, page, pages };
}

async function closeReminderPrompt(store, client, reminder, text) {
  if (!reminder.prompt_id) return;
  const request = await store.first("SELECT chat_id FROM attention_requests WHERE id=?", reminder.request_id);
  try { await client.editMessage(request.chat_id, reminder.prompt_id, text, { replyMarkup: { inline_keyboard: [] } }); }
  catch (error) { client.logger?.warn("ack_reminder_prompt_edit_failed", { reminderId: reminder.id, code: error.errorCode }); }
}

export async function processAcknowledgement({ store, client, config, callback, chatId, now }) {
  const match = ACK_CALLBACK.exec(callback.data);
  if (!match) return;
  const [, action, id] = match;
  const reminderAction = ["send", "cancel"].includes(action);
  const reminder = reminderAction ? await store.first("SELECT * FROM announcement_reminders WHERE id=?", id) : null;
  const requestId = reminderAction ? reminder?.request_id : id;
  const request = await store.first("SELECT * FROM attention_requests WHERE id=?", requestId ?? "");
  const policy = await store.first("SELECT * FROM announcement_ack WHERE request_id=?", requestId ?? "");
  const control = await store.first("SELECT message_id FROM attention_parts WHERE request_id=? AND part=0 AND status='sent'", requestId ?? "");
  if (!request || !policy || String(request.chat_id) !== String(chatId)
    || callback.message.message_id !== (reminderAction ? reminder?.prompt_id : control?.message_id)) {
    await client.answerCallbackQuery(callback.id, "Это не кнопка действующего объявления"); return;
  }
  const admin = authorizedAnnouncer(callback.from.id, config);
  if (action !== "read" && !admin) { await client.answerCallbackQuery(callback.id, "Доступно только автору бота и куратору"); return; }
  if (action === "report") {
    await openPrivatePages({ store, client, callback, kind: "ack", entityId: request.id, chatId, renderer: acknowledgementReport, now }); return;
  }
  if (!open(policy, now)) { await client.answerCallbackQuery(callback.id, "Подтверждения закрыты"); await refreshAcknowledgement({ store, client, requestId, now, force: true }); return; }
  if (action === "read") {
    await store.db.batch([store.db.prepare("UPDATE announcement_audience SET confirmed_at=? WHERE request_id=? AND user_id=? AND confirmed_at IS NULL "
      + "AND EXISTS(SELECT 1 FROM attention_parts p WHERE p.request_id=announcement_audience.request_id AND p.part=announcement_audience.part AND p.status='sent') "
      + "AND EXISTS(SELECT 1 FROM attention_members m WHERE m.chat_id=? AND m.user_id=announcement_audience.user_id AND m.active=1) "
      + "AND EXISTS(SELECT 1 FROM announcement_ack k WHERE k.request_id=announcement_audience.request_id AND k.closed_at IS NULL AND k.expires_at>?)")
    .bind(now, requestId, String(callback.from.id), String(chatId), now),
    store.db.prepare("UPDATE announcement_ack SET version=version+1 WHERE request_id=? AND changes()>0").bind(requestId)]);
    const eligible = await store.first("SELECT a.confirmed_at" + deliveredAudience + "WHERE a.request_id=? AND a.user_id=?", requestId, String(callback.from.id));
    await client.answerCallbackQuery(callback.id, eligible?.confirmed_at != null ? "✅ Подтверждение учтено" : "Ты не входишь в список получателей этого объявления");
    // A short bounded debounce merges rapid presses; persistent dirty versions survive restart.
    await new Promise(resolve => setTimeout(resolve, 850));
    await refreshAcknowledgement({ store, client, requestId, now: now + 850 });
    return;
  }
  if (action === "close") {
    await store.run("UPDATE announcement_ack SET closed_at=?,version=version+1 WHERE request_id=? AND closed_at IS NULL", now, requestId);
    await client.answerCallbackQuery(callback.id, "Подтверждения закрыты");
    await refreshAcknowledgement({ store, client, requestId, now, force: true }); return;
  }
  if (action === "remind") {
    if (now < policy.opened_at + 600_000) { await client.answerCallbackQuery(callback.id, "Напомнить можно через 10 минут после объявления"); return; }
    const remaining = await audience(store, requestId, true);
    if (!remaining.length) { await client.answerCallbackQuery(callback.id, "Нет участников, которым нужно напомнить"); return; }
    const reminderId = crypto.randomUUID();
    const inserted = await store.run("INSERT OR IGNORE INTO announcement_reminders (id,request_id,actor_id,status,expires_at,updated_at) VALUES (?,?,?,'prompting',?,?)",
      reminderId, requestId, String(callback.from.id), now + 300_000, now);
    if (!changed(inserted)) {
      const previous = await store.first("SELECT * FROM announcement_reminders WHERE request_id=?", requestId);
      if (!["cancelled", "expired", "empty"].includes(previous.status)) { await client.answerCallbackQuery(callback.id, "Напоминание уже создано или отправлено"); return; }
      const reset = await store.run("DELETE FROM announcement_reminders WHERE id=? AND status IN ('cancelled','expired','empty') AND claimed_at IS NULL", previous.id);
      if (!changed(reset)) { await client.answerCallbackQuery(callback.id, "Напоминание уже использовано"); return; }
      await processAcknowledgement({ store, client, config, callback, chatId, now }); return;
    }
    await client.answerCallbackQuery(callback.id, "Подтверди отправку напоминания");
    try {
      const sent = await client.sendMessage(chatId, `Напомнить оставшимся участникам: ${remaining.length}?`, { replyToMessageId: request.target_id,
        replyMarkup: { inline_keyboard: [[{ text: "Напомнить", callback_data: `ack:send:${reminderId}` }, { text: "Отмена", callback_data: `ack:cancel:${reminderId}` }]] } });
      await store.run("UPDATE announcement_reminders SET status='pending',prompt_id=?,updated_at=? WHERE id=?", sent.message_id, now, reminderId);
    } catch (error) {
      await store.run("UPDATE announcement_reminders SET status='uncertain',updated_at=? WHERE id=?", now, reminderId);
      client.logger?.warn("ack_reminder_prompt_uncertain", { reminderId, code: error.errorCode });
    }
    return;
  }
  if (reminder.actor_id !== String(callback.from.id)) { await client.answerCallbackQuery(callback.id, "Подтвердить может только автор вызова"); return; }
  if (reminder.status !== "pending" || reminder.expires_at <= now) { await client.answerCallbackQuery(callback.id, "Подтверждение уже обработано или устарело"); return; }
  if (action === "cancel") {
    if (changed(await store.run("UPDATE announcement_reminders SET status='cancelled',updated_at=? WHERE id=? AND status='pending'", now, id))) await closeReminderPrompt(store, client, reminder, "Напоминание отменено");
    await client.answerCallbackQuery(callback.id, "Отменено"); return;
  }
  const claim = await store.run("UPDATE announcement_reminders SET status='preparing',claimed_at=?,updated_at=? WHERE id=? AND status='pending' AND expires_at>? "
    + "AND EXISTS(SELECT 1 FROM announcement_ack k WHERE k.request_id=announcement_reminders.request_id AND k.closed_at IS NULL AND k.expires_at>?) "
    + "AND (?=1 OR (NOT EXISTS(SELECT 1 FROM attention_requests r WHERE r.chat_id=? AND r.test=0 AND r.confirmed_at>?) "
    + "AND NOT EXISTS(SELECT 1 FROM announcement_reminders n JOIN attention_requests r ON r.id=n.request_id WHERE n.id!=? AND r.chat_id=? AND r.test=0 AND n.claimed_at>?)))",
  now, now, id, now, now, request.test, String(chatId), now - 60_000, id, String(chatId), now - 60_000);
  if (!changed(claim)) { await client.answerCallbackQuery(callback.id, "Уже обработано или действует лимит одного оповещения в минуту"); return; }
  await client.answerCallbackQuery(callback.id, "Напоминание принято");
  await deliverReminder({ store, client, reminderId: id, now });
}

export async function deliverReminder({ store, client, reminderId, now = Date.now() }) {
  const reminder = await store.first("SELECT * FROM announcement_reminders WHERE id=?", reminderId);
  if (!reminder || !["preparing", "sending"].includes(reminder.status)) return;
  const request = await store.first("SELECT * FROM attention_requests WHERE id=?", reminder.request_id);
  const policy = await store.first("SELECT * FROM announcement_ack WHERE request_id=?", request.id);
  if (!open(policy, now)) {
    await store.run("UPDATE announcement_reminders SET status='closed',updated_at=? WHERE id=?", now, reminderId);
    await closeReminderPrompt(store, client, reminder, "Подтверждения закрыты — напоминание не отправлено"); return;
  }
  if (reminder.status === "preparing") {
    const batches = mentionBatches(await audience(store, request.id, true), "Пожалуйста, подтвердите ознакомление");
    const statements = batches.map((batch, part) => store.db.prepare("INSERT OR IGNORE INTO announcement_reminder_parts (reminder_id,part,members,status,updated_at) VALUES (?,?,?,'pending',?)")
      .bind(reminderId, part, JSON.stringify(batch.members.map(m => m.user_id)), now));
    statements.push(store.db.prepare("UPDATE announcement_reminders SET status='sending',updated_at=? WHERE id=? AND status='preparing'").bind(now, reminderId));
    await store.db.batch(statements);
  }
  const parts = await store.all("SELECT * FROM announcement_reminder_parts WHERE reminder_id=? ORDER BY part", reminderId);
  let sentAny = parts.some(p => p.status === "sent");
  for (const part of parts) {
    if (["sent", "empty"].includes(part.status)) continue;
    if (part.status !== "pending" || part.retry_at > now) return;
    // Re-read acknowledgements and departures immediately before every network call.
    const ids = new Set(JSON.parse(part.members));
    const members = (await audience(store, request.id, true)).filter(m => ids.has(m.user_id));
    const current = await store.first("SELECT * FROM announcement_ack WHERE request_id=?", request.id);
    if (!open(current, now)) break;
    if (!members.length) { await store.run("UPDATE announcement_reminder_parts SET status='empty',updated_at=? WHERE reminder_id=? AND part=? AND status='pending'", now, reminderId, part.part); continue; }
    if (!changed(await store.run("UPDATE announcement_reminder_parts SET status='sending',updated_at=? WHERE reminder_id=? AND part=? AND status='pending'", now, reminderId, part.part))) return;
    try {
      const text = mentionBatches(members, "Пожалуйста, подтвердите ознакомление")[0].text;
      const originalUrl = announcementLink(request.chat_id, request.target_id);
      const sent = await client.sendMessage(request.chat_id, text, { replyToMessageId: request.target_id,
        ...(originalUrl ? { replyMarkup: { inline_keyboard: [[{ text: "↗️ К объявлению", url: originalUrl }]] } } : {}) });
      await store.run("UPDATE announcement_reminder_parts SET status='sent',message_id=?,updated_at=? WHERE reminder_id=? AND part=?", sent.message_id, now, reminderId, part.part);
      sentAny = true;
    } catch (error) {
      const retry = error.errorCode === 429 && Number.isFinite(error.parameters?.retry_after);
      const status = retry ? "pending" : !error.errorCode || error.errorCode >= 500 ? "uncertain" : "failed";
      await store.run("UPDATE announcement_reminder_parts SET status=?,retry_at=?,updated_at=? WHERE reminder_id=? AND part=?", status, retry ? now + Math.max(1, error.parameters.retry_after) * 1000 : 0, now, reminderId, part.part);
      if (!retry) {
        await store.run("UPDATE announcement_reminders SET status=?,updated_at=? WHERE id=?", status, now, reminderId);
        await closeReminderPrompt(store, client, reminder, status === "uncertain" ? "Результат неизвестен — повтор отключён" : "Не удалось отправить напоминание");
      }
      client.logger?.warn("ack_reminder_delivery_stopped", { reminderId, part: part.part, status, code: error.errorCode }); return;
    }
  }
  await store.run("UPDATE announcement_reminders SET status=?,updated_at=? WHERE id=? AND status='sending'", sentAny ? "sent" : "empty", now, reminderId);
  await closeReminderPrompt(store, client, reminder, sentAny ? "Напоминание отправлено" : "Нет участников, которым нужно напомнить");
}

export async function recoverAcknowledgements({ store, client, chatId, now = Date.now() }) {
  await store.run("UPDATE announcement_ack SET closed_at=expires_at,version=version+1 WHERE closed_at IS NULL AND expires_at<=?", now);
  const dirty = await store.all("SELECT k.request_id FROM announcement_ack k JOIN attention_requests r ON r.id=k.request_id WHERE r.chat_id=? AND k.version!=k.rendered_version AND k.opened_at IS NOT NULL LIMIT 30", String(chatId));
  for (const entry of dirty) await refreshAcknowledgement({ store, client, requestId: entry.request_id, now });
  const abandoned = await store.run("UPDATE announcement_reminder_parts SET status='uncertain' WHERE status='sending' AND updated_at<?", now - 180_000);
  if (changed(abandoned)) client.logger?.warn("ack_reminder_abandoned_uncertain");
  await store.run("UPDATE announcement_reminders SET status='uncertain',updated_at=? WHERE (status='prompting' AND updated_at<?) OR (status='sending' AND EXISTS(SELECT 1 FROM announcement_reminder_parts p WHERE p.reminder_id=announcement_reminders.id AND p.status='uncertain'))", now, now - 180_000);
  const expired = await store.all("SELECT n.* FROM announcement_reminders n JOIN attention_requests r ON r.id=n.request_id WHERE r.chat_id=? AND n.status='pending' AND n.expires_at<=?", String(chatId), now);
  for (const reminder of expired) {
    await store.run("UPDATE announcement_reminders SET status='expired',updated_at=? WHERE id=? AND status='pending'", now, reminder.id);
    await closeReminderPrompt(store, client, reminder, "Срок подтверждения напоминания истёк");
  }
  const pending = await store.all("SELECT n.id FROM announcement_reminders n JOIN attention_requests r ON r.id=n.request_id WHERE r.chat_id=? AND n.status IN ('preparing','sending') LIMIT 10", String(chatId));
  for (const reminder of pending) await deliverReminder({ store, client, reminderId: reminder.id, now });
}
