import test from 'node:test';
import assert from 'node:assert/strict';
import { personalFixture } from './helpers/personal-fixture.js';
import { enqueuePersonalUpdate, processPersonalInbox } from '../src/personal/inbox.js';
import { deliverUser, diagnosticText } from '../src/personal/delivery.js';

test('survey binds to its Telegram receipt and saves only one decision', async t => {
  const f = await personalFixture();
  t.after(() => f.close());
  const now = new Date();
  let updateId = 0;
  const tap = async (userId, messageId, choice) => {
    await enqueuePersonalUpdate(f.store, { userId, messageId, action: 'rating:' + choice, update_id: ++updateId, acknowledged: true });
    await processPersonalInbox(f.store, await f.store.first('SELECT * FROM inbox WHERE update_id=?', updateId), now);
  };
  for (const id of [100, 200]) {
    await f.store.run('INSERT INTO users(user_id) VALUES(?)', id);
    await f.store.run("INSERT INTO operations(id,user_id,method,status,result,started_at) VALUES(?,?,'sendMessage','succeeded',?,?)", id + ':alert:rating-20261120-v1:1:0:receipt', id, JSON.stringify({message_id:42}), now.getTime());
  }
  await tap(100, 99, '5');
  await tap(100, 42, '2');
  await tap(100, 42, '5');
  await tap(200, 42, 'later');
  assert.equal(await f.store.setting('rating-20261120-v1:100'), 2);
  assert.doesNotMatch(await diagnosticText(f.store, now, null, { showUpdateRating: true }), /Rating:/u);
  const calls = [];
  const client = { async call(method, body) { calls.push({ method, body }); return true; } };
  await deliverUser(f.store, client, 100, { now });
  await deliverUser(f.store, client, 200, { now: new Date(now.getTime() + 2000) });
  assert.deepEqual(calls.map(c => [c.method, c.body.message_id]), [['editMessageText', 42], ['deleteMessage', 42]]);
  assert.equal(calls[0].body.reply_markup.inline_keyboard.length, 1);
});

test('update rating is isolated from the previous survey and visible only in owner status', async t => {
  const f = await personalFixture(); t.after(() => f.close());
  const now = new Date();
  const id = 123;
  const campaign = 'rating-update-20261123-v1';
  await f.store.run('INSERT INTO users(user_id) VALUES(?)', id);
  await f.store.setSetting('rating-20261120-v1:123', 2);
  await f.store.run("INSERT INTO operations(id,user_id,method,status,result,started_at) VALUES(?,?,'sendMessage','succeeded',?,?)",
    id + ':alert:' + campaign + ':10:0:receipt', id, JSON.stringify({ message_id: 44 }), +now);
  for (const [updateId, messageId, stars] of [[1,43,1],[2,44,5],[3,44,3]]) {
    const update = { userId: id, messageId, action: 'rating:update-20261123:' + stars, update_id: updateId, acknowledged: true };
    await enqueuePersonalUpdate(f.store, update, +now);
    await processPersonalInbox(f.store, await f.store.first('SELECT * FROM inbox WHERE update_id=?', updateId), now);
  }
  assert.equal(await f.store.setting(campaign + ':123'), 5);
  assert.doesNotMatch(await diagnosticText(f.store, now), /Оценка обновления/u);
  assert.match(await diagnosticText(f.store, now, null, { showUpdateRating: true }), /Оценка обновления · 5 \/ 5 · голосов 1/u);
});

test('the update notice repairs paragraphs and never reopens a voted message', async t => {
  const f = await personalFixture(); t.after(() => f.close());
  const now = new Date();
  const campaign = 'rating-update-20261123-v1';
  const collapsed = '<b>Ребят, бот обновился</b>Переделал меню и добавил просмотр на неделюНажмите /start еще раз, чтобы открыть новое меню<b>Как вам обновление?</b>Поставьте от 1 до 5 звезд ниже';
  const keyboard = { inline_keyboard: [[{ text: '5 ⭐', callback_data: 'personal:rating:update-20261123:5' }]] };
  await f.store.run('INSERT INTO users(user_id) VALUES(100),(101),(102)');
  for (const id of [100,101,102]) {
    await f.store.enqueue(await f.store.user(id), 'alert', campaign, { due: +now, payload: { manual: true, text: collapsed, keyboard } });
  }
  await f.store.run("UPDATE jobs SET status='done' WHERE user_id<>100");
  for (const id of [101,102]) {
    await f.store.run("INSERT INTO operations(id,user_id,method,status,result,started_at) VALUES(?,?,'sendMessage','succeeded',?,?)",
      id + ':alert:' + campaign + ':1:0:receipt', id, JSON.stringify({message_id:42}), +now);
    await f.store.enqueue(await f.store.user(id), 'alert', 'format-' + campaign, { due: +now, payload: { manual: true } });
  }
  await f.store.setSetting(campaign + ':102', 5);
  const calls = [];
  const client = { async call(method, body) { calls.push([method, body]); return { message_id: 123 }; } };
  for (const [i,id] of [100,101,102].entries()) await deliverUser(f.store, client, id, { now: new Date(+now + 2000 * i) });
  assert.deepEqual(calls.map(([method, body]) => [method, body.chat_id, body.message_id]), [['sendMessage',100,undefined],['editMessageText',101,42]]);
  for (const [, body] of calls) {
    assert.equal(body.text.split('\n\n').length, 4);
    assert.match(body.text, /обновление\?<\/b>\nПоставьте/u);
    assert.deepEqual(body.reply_markup, keyboard);
  }
});
