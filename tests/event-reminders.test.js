import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { sqliteAdapter } from '../src/attention-local.js';
import { AttentionStore, collectAttentionUpdate, processAttentionUpdate, CURATOR_USER_ID } from '../src/attention.js';
import { parseReminderArgument, deliverEventReminder, recoverEventReminders } from '../src/event-reminders.js';
import { TelegramApiError, TelegramClient } from '../src/telegram.js';
import { runReminderLoop } from '../src/runtime.js';

const now = Date.parse('2026-10-03T04:00:00Z'); // 07:00 Minsk
const due = now + 60 * 60_000;
const chat = { id: -1001, type: 'supergroup' };
const owner = { id: 42, first_name: 'Owner' };
const config = { adminUserId: '42' };
async function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const name of ['0004_attention.sql', '0005_acknowledgements.sql', '0006_recruitments.sql', '0007_event_reminders.sql']) db.exec(await readFile(`migrations/${name}`, 'utf8'));
  const store = new AttentionStore(sqliteAdapter(db));
  const sent = [], edits = [], answers = [], logs = [];
  let sequence = 100;
  const client = { logger: { warn(event, data) { logs.push({ event, data }); }, info(event, data) { logs.push({ event, data }); } },
    async sendMessage(chatId, text, options) { sent.push({ chatId, text, options }); return { message_id: ++sequence }; },
    async editMessage(...args) { edits.push(args); }, async answerCallbackQuery(...args) { answers.push(args); },
    async getMe() { return { username: 'mgmk_8cba_schedule_bot' }; },
  };
  const raw = (text = '/remind сегодня 08:00', id = 10, target = 5, from = owner) => ({ update_id: id,
    message: { message_id: id, chat, from, text, reply_to_message: { message_id: target, text: 'SECRET ANNOUNCEMENT' } } });
  const process = async (update, time = now) => {
    const intent = await collectAttentionUpdate({ update, chatId: chat.id, store, config, now: time });
    if (intent) await processAttentionUpdate({ update: intent, chatId: chat.id, store, config, client, now: time });
    return intent;
  };
  const recover = time => recoverEventReminders({ store, client, chatId: chat.id, now: time, clock: () => time });
  const row = () => store.first('SELECT * FROM event_reminders ORDER BY created_at,id LIMIT 1');
  return { db, store, sent, edits, answers, logs, client, raw, process, recover, row };
}

test('reminder parses Minsk today/tomorrow, midnight, year rollover and strict dates', () => {
  assert.equal(parseReminderArgument('сегодня 08:00', now).dueAt, due);
  assert.equal(parseReminderArgument(' завтра   08:00 ', now).dueAt, due + 86_400_000);
  const end = Date.parse('2026-12-31T20:58:00Z');
  assert.equal(parseReminderArgument('завтра 00:01', end).dueAt, Date.parse('2026-12-31T21:01:00Z'));
  assert.equal(parseReminderArgument('сегодня 00:01', Date.parse('2026-12-31T21:00:00Z')).dueAt, Date.parse('2026-12-31T21:01:00Z'));
  assert.equal(parseReminderArgument('05.10.2026 08:00', now).dueAt, due + 2 * 86_400_000);
  assert.equal(parseReminderArgument('29.02.2028 08:00', Date.parse('2028-02-28T04:00:00Z')).dueAt, Date.parse('2028-02-29T05:00:00Z'));
  for (const arg of ['', '08:00', 'завтра 8:00', 'завтра 24:00', 'завтра 08:60', '31.02.2026 08:00', '29.02.2027 08:00', '04.10.0026 08:00', 'сегодня 07:00', 'сегодня 06:00', '04.11.2026 08:00', '<b>завтра</b> 08:00']) assert.ok(parseReminderArgument(arg, now).error, arg);
  assert.equal(parseReminderArgument('сегодня 07:01', now).dueAt, now + 60_000);
  assert.equal(parseReminderArgument('02.11.2026 07:00', now).dueAt, now + 30 * 86_400_000);
  assert.ok(parseReminderArgument('02.11.2026 07:01', now).error);
  assert.deepEqual(parseReminderArgument('отмена', now), { cancel: true });
});

test('create persists sanitized intent, confirms once, binds bot suffix and supports photo replies', async () => {
  const f = await fixture();
  const raw = f.raw('/remind@mgmk_8cba_schedule_bot завтра 08:00');
  raw.message.reply_to_message.photo = [{ file_id: 'SECRET PHOTO' }];
  const intent = await f.process(raw);
  await Promise.all([f.process(raw), f.process(raw)]);
  assert.ok(!JSON.stringify(intent).includes('SECRET'));
  assert.ok(!JSON.stringify(intent).includes('завтра'));
  assert.equal((await f.row()).due_at, due + 86_400_000);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /Напомню 4 октября в 08:00 · время Минска/);
  assert.equal(f.sent[0].options.replyToMessageId, 5);
  assert.ok(Buffer.byteLength(f.sent[0].options.replyMarkup.inline_keyboard[0][0].callback_data) <= 64);
  assert.ok(!JSON.stringify(await f.store.all('SELECT * FROM event_reminders')).includes('SECRET'));
  await f.process(f.raw('/remind@other_bot завтра 08:00', 11, 6));
  assert.equal(f.sent.length, 1);
});

test('private/foreign/anonymous/unauthorized commands are ignored and malformed input explained', async () => {
  const f = await fixture();
  for (const changes of [{ from: { id: 43 } }, { sender_chat: chat }, { from: { ...owner, is_bot: true } }, { chat: { id: 42, type: 'private' } }, { chat: { id: -999, type: 'supergroup' } }]) {
    const raw = f.raw(); Object.assign(raw.message, changes);
    assert.equal(await f.process(raw), null);
  }
  await f.process(f.raw('/remind invalid'));
  const noReply = f.raw('/remind завтра 08:00', 11); delete noReply.message.reply_to_message;
  await f.process(noReply);
  assert.equal((await f.store.first('SELECT COUNT(*) AS n FROM event_reminders')).n, 0);
  assert.equal(f.sent.length, 2);
  assert.ok(f.sent.every(s => s.text.includes('/remind завтра 08:00')));
});

test('one active per target and atomic group capacity with concurrent creates', async () => {
  const f = await fixture();
  await f.process(f.raw());
  await f.process(f.raw('/remind завтра 09:00', 11));
  assert.equal((await f.store.first('SELECT COUNT(*) AS n FROM event_reminders')).n, 1);
  assert.match(f.sent.at(-1).text, /уже есть напоминание/);
  await Promise.all(Array.from({ length: 15 }, (_, i) => f.process(f.raw('/remind завтра 08:00', 20 + i, 20 + i))));
  assert.equal((await f.store.first("SELECT COUNT(*) AS n FROM event_reminders WHERE status='pending'")).n, 10);
});

test('both admins cancel, forged buttons rejected, old cancellation cannot cancel replacement', async () => {
  const f = await fixture(); await f.process(f.raw());
  const r = await f.row();
  const click = (userId, messageId = r.prompt_id, id = 100) => f.process({ update_id: id,
    callback_query: { id: `cb${id}`, data: `remind:cancel:${r.id}`, from: { id: userId }, message: { chat, message_id: messageId } } });
  await click(43); await click(Number(CURATOR_USER_ID), 999);
  assert.equal((await f.row()).status, 'pending');
  await click(Number(CURATOR_USER_ID)); await click(42, r.prompt_id, 101);
  assert.equal((await f.row()).status, 'cancelled');
  assert.equal(f.edits.length, 1);
  await f.process(f.raw('/remind завтра 08:00', 11));
  const cancel = f.raw('/remind отмена', 12, 5, { id: Number(CURATOR_USER_ID) });
  await f.process(cancel);
  await f.process(f.raw('/remind завтра 09:00', 13));
  await f.process(cancel); await f.process(f.raw()); // old create does not resurrect
  const active = await f.store.all("SELECT * FROM event_reminders WHERE status='pending'");
  assert.equal(active.length, 1); assert.equal(active[0].origin_id, 13);
});

test('due delivery survives store restart, is a reply/link with no copied text or tags, exactly once', async () => {
  const f = await fixture(); await f.process(f.raw());
  await f.recover(due - 1); assert.equal(f.sent.length, 1);
  const restartedStore = new AttentionStore(sqliteAdapter(f.db));
  await Promise.all([0, 1, 2].map(() => recoverEventReminders({ store: restartedStore, client: f.client, chatId: chat.id, now: due, clock: () => due })));
  await f.recover(due + 60_000);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].text, '🔔 Напоминание по этому объявлению');
  assert.equal(f.sent[1].options.replyToMessageId, 5);
  assert.equal(f.sent[1].options.replyMarkup.inline_keyboard[0][0].url, 'https://t.me/c/1/5');
  assert.equal((await f.row()).status, 'sent');
  assert.ok(!JSON.stringify(f.sent).includes('tg://user'));
});

test('late recovery allows exactly fifteen minutes, skips older entries and wrong group', async () => {
  const f = await fixture(); await f.process(f.raw());
  await recoverEventReminders({ store: f.store, client: f.client, chatId: -999, now: due, clock: () => due });
  assert.equal(f.sent.length, 1);
  await f.recover(due + 15 * 60_000); assert.equal((await f.row()).status, 'sent');
  const g = await fixture(); await g.process(g.raw());
  await g.recover(due + 15 * 60_000 + 1);
  assert.equal((await g.row()).status, 'missed'); assert.equal(g.sent.length, 1);
  assert.ok(g.logs.some(l => l.event === 'event_reminder_missed'));
});

test('claim versus cancellation race never sends a cancelled reminder', async () => {
  const f = await fixture(); await f.process(f.raw()); const r = await f.row();
  await Promise.all([f.process(f.raw('/remind отмена', 11), due), deliverEventReminder({ store: f.store, client: f.client, id: r.id, now: due })]);
  const status = (await f.row()).status;
  assert.ok(['cancelled', 'sent'].includes(status));
  assert.equal(f.sent.filter(s => s.text.startsWith('🔔')).length, status === 'sent' ? 1 : 0);
});

test('explicit temporary rejection retries within grace, ambiguous failure never replays', async () => {
  for (const error of [new TelegramApiError('sendMessage', 'Too Many Requests', 429, { retry_after: 60 }), Object.assign(new TelegramApiError('sendMessage', 'Temporary', 503), { apiRejected: true })]) {
    const f = await fixture(); await f.process(f.raw()); const original = f.client.sendMessage;
    f.client.sendMessage = async () => { throw error; };
    await f.recover(due); assert.equal((await f.row()).status, 'pending');
    f.client.sendMessage = original; await f.recover((await f.row()).retry_at);
    assert.equal((await f.row()).status, 'sent'); assert.equal(f.sent.length, 2);
  }
  for (const error of [new TelegramApiError('sendMessage', 'network request failed'), new TelegramApiError('sendMessage', 'invalid HTTP 503 response', 503)]) {
    const f = await fixture(); await f.process(f.raw());
    let calls = 0; f.client.sendMessage = async () => { calls++; throw error; };
    await f.recover(due); await f.recover(due + 60_000);
    assert.equal((await f.row()).status, 'uncertain'); assert.equal(calls, 1);
  }
});

test('deleted original has no standalone fallback; abandoned sends stay uncertain', async () => {
  const f = await fixture(); await f.process(f.raw()); let calls = 0;
  f.client.sendMessage = async () => { calls++; throw new TelegramApiError('sendMessage', 'message to be replied not found', 400); };
  await f.recover(due); await f.recover(due + 60_000);
  assert.equal((await f.row()).status, 'failed'); assert.equal(calls, 1);
  const g = await fixture(); await g.process(g.raw());
  await g.store.run("UPDATE event_reminders SET status='sending',updated_at=?", due);
  await g.recover(due + 180_001);
  assert.equal((await g.row()).status, 'uncertain'); assert.equal(g.sent.length, 1);
});

test('retry beyond grace expires and slow earlier calls do not send a now-stale reminder', async () => {
  const f = await fixture(); await f.process(f.raw());
  const send = f.client.sendMessage;
  f.client.sendMessage = async () => { throw new TelegramApiError('sendMessage', 'rate limit', 429, { retry_after: 901 }); };
  await f.recover(due); f.client.sendMessage = send; await f.recover(due + 901_000);
  assert.equal((await f.row()).status, 'missed'); assert.equal(f.sent.length, 1);
  const g = await fixture(); await g.process(g.raw());
  await recoverEventReminders({ store: g.store, client: g.client, chatId: chat.id, now: due + 899_000, clock: () => due + 901_000 });
  assert.equal((await g.row()).status, 'missed'); assert.equal(g.sent.length, 1);
});

test('prompt transport timeout never duplicates confirmation; pending 429 prompt recovers', async () => {
  const f = await fixture(); let calls = 0;
  f.client.sendMessage = async () => { calls++; throw new TelegramApiError('sendMessage', 'network request failed'); };
  await f.process(f.raw()); await f.recover(now + 60_000);
  assert.equal((await f.row()).prompt_status, 'uncertain'); assert.equal((await f.row()).status, 'pending'); assert.equal(calls, 1);
  const g = await fixture(); const send = g.client.sendMessage;
  g.client.sendMessage = async () => { throw new TelegramApiError('sendMessage', 'rate limit', 429, { retry_after: 1 }); };
  await g.process(g.raw()); g.client.sendMessage = send; await g.recover(now + 1000);
  assert.equal((await g.row()).prompt_status, 'sent'); assert.equal(g.sent.length, 1);
});

test('local reminder minute loop runs without the schedule executor and respects abort', async () => {
  const f = await fixture(); const controller = new AbortController();
  const created = await f.process(f.raw()); assert.ok(created);
  await f.store.run('UPDATE event_reminders SET due_at=?', Date.now() - 1000);
  const send = f.client.sendMessage;
  f.client.sendMessage = async (...args) => { const result = await send(...args); controller.abort(); return result; };
  await runReminderLoop({ attentionStore: f.store, store: { state: { chatId: chat.id } }, client: f.client, logger: f.client.logger, signal: controller.signal });
  assert.equal((await f.row()).status, 'sent');
});

test('Telegram reply requires the original and distinguishes JSON rejection from gateway ambiguity', async () => {
  const original = globalThis.fetch; const client = new TelegramClient({ token: 'test' }); let request;
  globalThis.fetch = async (_url, options) => { request = JSON.parse(options.body); return new Response(JSON.stringify({ ok: false, error_code: 503, description: 'temporary rejection' }), { status: 503 }); };
  try {
    await assert.rejects(client.sendMessage(chat.id, 'test', { replyToMessageId: 5 }), error => error.apiRejected === true);
    assert.equal(request.reply_parameters.allow_sending_without_reply, false);
    globalThis.fetch = async () => new Response('gateway unavailable', { status: 503 });
    await assert.rejects(client.sendMessage(chat.id, 'test'), error => !error.apiRejected);
  } finally { globalThis.fetch = original; }
});
