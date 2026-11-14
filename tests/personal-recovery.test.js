import test from 'node:test';
import assert from 'node:assert/strict';
import { personalFixture, sampleSchedule, installSchedules } from './helpers/personal-fixture.js';
import { processPersonalInbox, enqueuePersonalUpdate, collectPersonalUpdate } from '../src/personal/inbox.js';
import { deliverUser } from '../src/personal/delivery.js';
import { manualJobsOnly } from '../src/personal/quota.js';
import { renderPersonal } from '../src/personal/view.js';

const now = new Date('2026-11-12T07:00:00+03:00');
async function fixture(t, { paused = 0, long = false } = {}) {
  const f = await personalFixture(); t.after(() => f.close());
  const schedule = await sampleSchedule();
  if (long) {
    schedule.notes = Array.from({ length: 6 }, (_, i) => ({ text: `${i}: ${'Примечание к расписанию '.repeat(90)}` }));
    schedule.hash = 'b'.repeat(64);
  }
  await installSchedules(f.store, [schedule]);
  await f.store.run("INSERT INTO users(user_id,group_id,paused) VALUES(101,'8СА',?)", paused);
  return { ...f, schedule };
}
async function input(f, action, update_id, date = now) {
  const update = { update_id, userId: 101, action, messageId: 77, acknowledged: true };
  await enqueuePersonalUpdate(f.store, update, date.getTime());
  await processPersonalInbox(f.store, await f.store.first('SELECT * FROM inbox WHERE update_id=?', update_id), date);
}

test('resume queues manual cards that are delivered during budget saving without changing limits', async t => {
  const f = await fixture(t, { paused: 1 });
  await input(f, 'toggle:paused', 1);
  assert.equal((await f.store.user(101)).paused, 0);
  const cards = await f.store.all("SELECT * FROM jobs WHERE kind='card'" + manualJobsOnly('saving'));
  assert.equal(cards.length, 1); assert.equal(cards[0].priority, 0);
  const methods = [], client = { async call(method) { methods.push(method); return method === 'sendMessage' ? { message_id: 88 } : true; } };
  for (let i = 1; i <= 4; i++) await deliverUser(f.store, client, 101, { now: new Date(now.getTime() + i * 2000), mode: 'saving' });
  assert.equal((await f.store.first("SELECT status FROM jobs WHERE kind='card'")).status, 'done');
  assert.equal(methods.filter(m => m === 'sendMessage').length, 1);
});

test('multipart preview pages and view toggles edit one screen without creating sends or receipts', async t => {
  const f = await fixture(t, { long: true });
  const rendered = renderPersonal(f.schedule, await f.store.user(101), { now });
  assert.ok(rendered.parts.length > 2);
  const calls = [], client = { async call(method, body) { calls.push({ method, body }); return true; } };
  for (const [i, action] of ['today', `preview:${f.schedule.date}:compact:1`, `preview:${f.schedule.date}:full`, `preview:${f.schedule.date}:compact:999`].entries()) {
    const date = new Date(now.getTime() + i * 2000);
    await input(f, action, i + 1, date);
    assert.equal((await f.store.all("SELECT * FROM jobs WHERE kind='reply' AND status='pending'")).length, 1);
    await deliverUser(f.store, client, 101, { now: date });
  }
  assert.equal(calls.length, 4);
  assert.ok(calls.every(c => c.method === 'editMessageText' && c.body.message_id === 77));
  assert.equal(calls[0].body.text, rendered.parts[0]);
  assert.equal(calls[1].body.text, rendered.parts[1]);
  assert.equal(calls[3].body.text, rendered.parts.at(-1));
  assert.equal((await f.store.first('SELECT COUNT(*) n FROM operations')).n, 0);
  for (const c of calls) for (const row of c.body.reply_markup.inline_keyboard) for (const b of row) {
    if (!b.callback_data?.includes('preview:')) continue;
    const collected = collectPersonalUpdate({ update_id: 99, callback_query: { id: 'cb', from: { id: 101 }, data: b.callback_data, message: { message_id: 77, chat: { id: 101, type: 'private' } } } });
    assert.ok(collected); assert.ok(b.callback_data.length <= 64);
  }
});

for (const timeout of [false, true]) test(`missing pin repairs only its deleted card and preserves uncertain sends (${timeout})`, async t => {
  const f = await fixture(t), user = await f.store.user(101);
  await f.store.run('INSERT INTO cards(user_id,group_id,date,parts,schedule_payload) VALUES(?,?,?,?,?)', 101, user.group_id, f.schedule.date, JSON.stringify([{ id: 88, hash: 'old' }]), JSON.stringify(f.schedule));
  await f.store.enqueue(user, 'pin', '', { due: now.getTime() });
  const calls = [], client = { async call(method, body) {
    calls.push({ method, body });
    if (method === 'pinChatMessage' && body.message_id === 88) throw Object.assign(Error('missing'), { apiRejected: true, errorCode: 400, description: 'Bad Request: message to pin not found' });
    if (method === 'sendMessage' && timeout) throw Error('ambiguous timeout');
    return method === 'sendMessage' ? { message_id: 89 } : true;
  } };
  for (let i = 0; i < 4; i++) await deliverUser(f.store, client, 101, { now: new Date(now.getTime() + i * 2000) });
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 1);
  assert.equal(calls.filter(c => c.method === 'pinChatMessage' && c.body.message_id === 88).length, 1);
  if (timeout) {
    await f.store.enqueue(await f.store.user(101), 'card', f.schedule.date, { due: now.getTime() + 10000 });
    await deliverUser(f.store, client, 101, { now: new Date(now.getTime() + 10000) });
    assert.equal(calls.filter(c => c.method === 'sendMessage').length, 1);
    assert.equal((await f.store.first("SELECT status FROM jobs WHERE kind='card'")).status, 'uncertain');
  } else {
    assert.equal((await f.store.card(user, f.schedule.date)).parts[0].id, 89);
    assert.equal((await f.store.user(101)).pin_message_id, 89);
  }
});

test('a pin permission failure never replaces a known card', async t => {
  const f = await fixture(t), user = await f.store.user(101);
  await f.store.run('INSERT INTO cards(user_id,group_id,date,parts,schedule_payload) VALUES(?,?,?,?,?)', 101, user.group_id, f.schedule.date, JSON.stringify([{ id: 88, hash: 'old' }]), JSON.stringify(f.schedule));
  await f.store.enqueue(user, 'pin', '', { due: now.getTime() });
  await deliverUser(f.store, { async call() { throw Object.assign(Error('denied'), { apiRejected: true, errorCode: 400, description: 'not enough rights to pin a message' }); } }, 101, { now });
  assert.equal((await f.store.card(user, f.schedule.date)).parts[0].id, 88);
  assert.equal((await f.store.first("SELECT COUNT(*) n FROM jobs WHERE kind='card'")).n, 0);
});
