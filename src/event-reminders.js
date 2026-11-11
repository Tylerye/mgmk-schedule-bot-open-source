import { addDays, dateInTimezone, parseScheduleDate, timeInTimezone } from './dates.js';
import { authorizedAnnouncer } from './attention.js';
import { announcementLink } from './private-pages.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const GRACE = 15 * MINUTE;
const ZONE = 'Europe/Minsk';
const changed = result => (result.meta?.changes ?? 0) > 0;
export const EVENT_REMINDER_CALLBACK = /^remind:cancel:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const help = 'Ответь на объявление: /remind завтра 08:00\nИли /remind сегодня 15:00, /remind 05.10.2026 08:00\nОтмена: /remind отмена';

// Resolve relative dates before the sanitized intent enters the durable inbox.
export function parseReminderArgument(argument, now = Date.now()) {
  const text = String(argument).trim().toLowerCase();
  if (text === 'отмена') return { cancel: true };
  const match = /^(сегодня|завтра|\d{2}\.\d{2}\.\d{4})\s+(\d{2}):(\d{2})$/u.exec(text);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59) return { error: help };
  const date = match[1] === 'сегодня' ? dateInTimezone(new Date(now), ZONE)
    : match[1] === 'завтра' ? addDays(dateInTimezone(new Date(now), ZONE), 1) : parseScheduleDate(match[1]);
  if (!date || (/^\d/u.test(match[1]) && date !== match[1].split('.').reverse().join('-'))) return { error: 'Такой даты нет\n' + help };
  const candidate = Date.parse(`${date}T${match[2]}:${match[3]}:00Z`);
  const offset = new Intl.DateTimeFormat('en', { timeZone: ZONE, timeZoneName: 'shortOffset' })
    .formatToParts(new Date(candidate)).find(p => p.type === 'timeZoneName').value;
  const parts = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(offset);
  const dueAt = candidate - (parts ? (parts[1] === '+' ? 1 : -1) * (Number(parts[2]) * 60 + Number(parts[3] ?? 0)) * MINUTE : 0);
  if (dateInTimezone(new Date(dueAt), ZONE) !== date || timeInTimezone(new Date(dueAt), ZONE) !== `${match[2]}:${match[3]}`) return { error: help };
  if (dueAt < now + MINUTE) return { error: 'Укажи время минимум через минуту — прошедшее время не переносится\n' + help };
  if (dueAt > now + 30 * DAY) return { error: 'Можно поставить напоминание максимум на 30 дней вперёд' };
  return { dueAt };
}

function promptView(r) {
  const date = new Intl.DateTimeFormat('ru', { timeZone: ZONE, day: 'numeric', month: 'long' }).format(new Date(r.due_at));
  const when = `${date} в ${timeInTimezone(new Date(r.due_at), ZONE)} · время Минска`;
  const labels = { pending: `Напомню ${when}`, sending: `Отправляю напоминание · ${when}`, sent: 'Напоминание отправлено',
    cancelled: 'Напоминание отменено', missed: 'Напоминание пропущено — прошло больше 15 минут',
    uncertain: 'Результат отправки неизвестен — автоматический повтор отключён', failed: 'Не удалось отправить напоминание — исходное сообщение недоступно или Telegram отклонил запрос' };
  return { text: `<b>${labels[r.status]}</b>`, replyMarkup: { inline_keyboard: r.status === 'pending'
    ? [[{ text: 'Отменить напоминание', callback_data: `remind:cancel:${r.id}` }]] : [] } };
}

function sendFailure(error, now) {
  // A Telegram JSON rejection is known not to have sent; transport/invalid HTTP failures are ambiguous.
  const retry = error.errorCode === 429 && Number.isFinite(error.parameters?.retry_after)
    ? Math.max(1, error.parameters.retry_after) * 1000
    : error.apiRejected === true && error.errorCode >= 500 ? 5000 : null;
  return { status: retry !== null ? 'pending' : !error.errorCode || error.errorCode >= 500 ? 'uncertain' : 'failed', retryAt: retry !== null ? now + retry : 0 };
}

async function publishPrompt({ store, client, id, now }) {
  const r = await store.first('SELECT * FROM event_reminders WHERE id=?', id);
  if (!r || r.status !== 'pending' || r.due_at <= now || r.prompt_retry_at > now) return;
  if (!changed(await store.run("UPDATE event_reminders SET prompt_status='sending',prompt_updated_at=? WHERE id=? AND status='pending' AND prompt_status='pending' AND prompt_retry_at<=?", now, id, now))) return;
  try {
    const view = promptView(r);
    const sent = await client.sendMessage(r.chat_id, view.text, { replyToMessageId: r.target_id, replyMarkup: view.replyMarkup });
    await store.run("UPDATE event_reminders SET prompt_status='sent',prompt_id=?,rendered_status='pending',prompt_updated_at=? WHERE id=?", sent.message_id, now, id);
  } catch (error) {
    const failure = sendFailure(error, now);
    await store.run('UPDATE event_reminders SET prompt_status=?,prompt_retry_at=?,prompt_updated_at=? WHERE id=?', failure.status, failure.retryAt, now, id);
    client.logger?.warn('event_reminder_prompt_stopped', { id, status: failure.status, code: error.errorCode });
  }
}

async function refreshPrompt({ store, client, id }) {
  const r = await store.first('SELECT * FROM event_reminders WHERE id=?', id);
  if (!r?.prompt_id || r.rendered_status === r.status || r.status === 'sending') return;
  try {
    const view = promptView(r);
    await client.editMessage(r.chat_id, r.prompt_id, view.text, { replyMarkup: view.replyMarkup });
    await store.run('UPDATE event_reminders SET rendered_status=? WHERE id=? AND status=?', r.status, id, r.status);
  } catch (error) {
    if (/message is not modified/iu.test(error.description ?? '')) {
      await store.run('UPDATE event_reminders SET rendered_status=? WHERE id=? AND status=?', r.status, id, r.status);
    } else if (error.errorCode === 400 || error.errorCode === 403) {
      // Deleted control messages must not be retried every minute forever.
      await store.run('UPDATE event_reminders SET prompt_id=NULL WHERE id=?', id);
    } else client.logger?.warn('event_reminder_prompt_edit_failed', { id, code: error.errorCode });
  }
}

export async function createEventReminder({ store, client, message, chatId, now }) {
  const targetId = message.reply_to_message?.message_id;
  if (!Number.isSafeInteger(targetId) || targetId <= 0 || !message.reminder || message.reminder.error) {
    await client.sendMessage(chatId, message.reminder?.error ?? help); return;
  }
  if (message.reminder.cancel) {
    const [receipt, cancelled] = await store.db.batch([
      store.db.prepare("INSERT OR IGNORE INTO attention_settings(key,value) VALUES (?, 'done')").bind(`remind-cancel:${chatId}:${message.message_id}`),
      store.db.prepare("UPDATE event_reminders SET status='cancelled',updated_at=? WHERE chat_id=? AND target_id=? AND status='pending' AND changes()>0").bind(now, String(chatId), targetId),
    ]);
    if (!changed(receipt)) return;
    await client.sendMessage(chatId, changed(cancelled) ? 'Напоминание отменено' : 'Ожидающего напоминания для этого сообщения нет', { replyToMessageId: targetId });
    const row = await store.first("SELECT id FROM event_reminders WHERE chat_id=? AND target_id=? AND status='cancelled' ORDER BY updated_at DESC LIMIT 1", String(chatId), targetId);
    if (row) await refreshPrompt({ store, client, id: row.id });
    return;
  }
  const dueAt = message.reminder.dueAt;
  if (!Number.isSafeInteger(dueAt) || dueAt < now + MINUTE || dueAt > now + 30 * DAY) {
    await client.sendMessage(chatId, 'Укажи новое время минимум через минуту и не дальше 30 дней\n' + help); return;
  }
  const id = crypto.randomUUID();
  const inserted = await store.run("INSERT OR IGNORE INTO event_reminders(id,chat_id,target_id,origin_id,actor_id,due_at,created_at,updated_at,prompt_updated_at) "
    + "SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM event_reminders WHERE chat_id=? AND status IN ('pending','sending'))<10",
  id, String(chatId), targetId, message.message_id, String(message.from.id), dueAt, now, now, now, String(chatId));
  if (!changed(inserted)) {
    if (await store.first('SELECT 1 FROM event_reminders WHERE chat_id=? AND origin_id=?', String(chatId), message.message_id)) return;
    const active = await store.first("SELECT 1 FROM event_reminders WHERE chat_id=? AND target_id=? AND status IN ('pending','sending')", String(chatId), targetId);
    await client.sendMessage(chatId, active ? 'Для этого объявления уже есть напоминание\nДля изменения времени сначала отмени его: /remind отмена' : 'В группе уже 10 ожидающих напоминаний — сначала отмени ненужное'); return;
  }
  await publishPrompt({ store, client, id, now });
}

export async function processEventReminder({ store, client, config, callback, chatId, now }) {
  const match = EVENT_REMINDER_CALLBACK.exec(callback.data ?? '');
  if (!match) return;
  const r = await store.first('SELECT * FROM event_reminders WHERE id=?', match[1]);
  if (!authorizedAnnouncer(callback.from?.id, config) || !r || String(r.chat_id) !== String(chatId) || r.prompt_id !== callback.message.message_id) {
    await client.answerCallbackQuery(callback.id, 'Доступно только автору бота и куратору по кнопке этого напоминания'); return;
  }
  const cancelled = await store.run("UPDATE event_reminders SET status='cancelled',updated_at=? WHERE id=? AND status='pending'", now, r.id);
  await client.answerCallbackQuery(callback.id, changed(cancelled) ? 'Напоминание отменено' : 'Уже отменено или отправка началась');
  await refreshPrompt({ store, client, id: r.id });
}

export async function deliverEventReminder({ store, client, id, now = Date.now() }) {
  const r = await store.first('SELECT * FROM event_reminders WHERE id=?', id);
  if (!r) return;
  const claim = await store.run("UPDATE event_reminders SET status='sending',updated_at=? WHERE id=? AND status='pending' AND due_at<=? AND due_at>=? AND retry_at<=?",
    now, id, now, now - GRACE, now);
  if (!changed(claim)) return;
  try {
    const url = announcementLink(r.chat_id, r.target_id);
    const sent = await client.sendMessage(r.chat_id, '🔔 Напоминание по этому объявлению', { replyToMessageId: r.target_id,
      ...(url ? { replyMarkup: { inline_keyboard: [[{ text: 'Открыть объявление', url }]] } } : {}) });
    await store.run("UPDATE event_reminders SET status='sent',sent_id=?,updated_at=? WHERE id=? AND status='sending'", sent.message_id, now, id);
    client.logger?.info('event_reminder_sent', { id, delayMs: now - r.due_at });
  } catch (error) {
    const failure = sendFailure(error, now);
    await store.run("UPDATE event_reminders SET status=?,retry_at=?,updated_at=? WHERE id=? AND status='sending'", failure.status, failure.retryAt, now, id);
    client.logger?.warn('event_reminder_send_stopped', { id, status: failure.status, code: error.errorCode });
  }
  await refreshPrompt({ store, client, id });
}

export async function recoverEventReminders({ store, client, chatId, now = Date.now(), clock = Date.now }) {
  const abandoned = await store.run("UPDATE event_reminders SET status='uncertain',updated_at=? WHERE chat_id=? AND status='sending' AND updated_at<?", now, String(chatId), now - 180_000);
  if (changed(abandoned)) client.logger?.warn('event_reminder_abandoned_send_uncertain');
  await store.run("UPDATE event_reminders SET prompt_status='uncertain' WHERE chat_id=? AND prompt_status='sending' AND prompt_updated_at<?", String(chatId), now - 180_000);
  const missed = await store.run("UPDATE event_reminders SET status='missed',updated_at=? WHERE chat_id=? AND status='pending' AND due_at<?", now, String(chatId), now - GRACE);
  if (changed(missed)) client.logger?.warn('event_reminder_missed', { count: missed.meta.changes });
  const due = await store.all("SELECT id FROM event_reminders WHERE chat_id=? AND status='pending' AND due_at<=? AND retry_at<=? ORDER BY due_at LIMIT 10", String(chatId), now, now);
  for (const r of due) {
    const current = Math.max(now, clock());
    await store.run("UPDATE event_reminders SET status='missed',updated_at=? WHERE id=? AND status='pending' AND due_at<?", current, r.id, current - GRACE);
    await deliverEventReminder({ store, client, id: r.id, now: current });
  }
  const prompts = await store.all("SELECT id FROM event_reminders WHERE chat_id=? AND status='pending' AND prompt_status='pending' AND prompt_retry_at<=? AND due_at>? LIMIT 10", String(chatId), now, now);
  for (const r of prompts) await publishPrompt({ store, client, id: r.id, now });
  const dirty = await store.all("SELECT id FROM event_reminders WHERE chat_id=? AND prompt_id IS NOT NULL AND status!=rendered_status LIMIT 20", String(chatId));
  for (const r of dirty) await refreshPrompt({ store, client, id: r.id });
}
