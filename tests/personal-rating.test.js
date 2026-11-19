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
  assert.match(await diagnosticText(f.store, now), /Rating: 2 \/ 5 · 1 votes/u);
  const calls = [];
  const client = { async call(method, body) { calls.push({ method, body }); return true; } };
  await deliverUser(f.store, client, 100, { now });
  await deliverUser(f.store, client, 200, { now: new Date(now.getTime() + 2000) });
  assert.deepEqual(calls.map(c => [c.method, c.body.message_id]), [['editMessageText', 42], ['deleteMessage', 42]]);
  assert.equal(calls[0].body.reply_markup.inline_keyboard.length, 1);
});
