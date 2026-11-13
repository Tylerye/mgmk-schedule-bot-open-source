import test from 'node:test';
import assert from 'node:assert/strict';
import { personalFixture, sampleSchedule, installSchedules } from './helpers/personal-fixture.js';
import { PersonalStore } from '../src/personal/store.js';
import { deliverUser } from '../src/personal/delivery.js';
import { enqueuePersonalUpdate, processPersonalInbox } from '../src/personal/inbox.js';
import { fanoutBatch } from '../src/personal/ingest.js';

const now = new Date('2026-11-13T07:00:00+03:00');
async function screen(t) {
  const f = await personalFixture(); t.after(() => f.close());
  await f.store.run('INSERT INTO users(user_id) VALUES(100)');
  await f.store.enqueue(await f.store.user(100), 'reply', 'screen', {
    due: now.getTime(), payload: { editId: 77, text: 'latest screen', manual: true },
  });
  return f;
}

test('queued screen edit recovers on the same message after interruption before its hash receipt', async t => {
  const f = await screen(t); let attempts = 0;
  const client = { async call(method, body) {
    assert.equal(method, 'editMessageText'); assert.equal(body.message_id, 77);
    if (++attempts > 1) throw Object.assign(Error('unchanged'), { apiRejected: true, errorCode: 400, description: 'message is not modified' });
    return true;
  } };
  f.store.setSetting = async () => { throw Error('receipt interrupted'); };
  await assert.rejects(deliverUser(f.store, client, 100, { now }), /interrupted/u);
  const resumed = new PersonalStore(f.db);
  await deliverUser(resumed, client, 100, { now: new Date(now.getTime() + 2000) });
  assert.equal(attempts, 2);
  assert.equal((await resumed.first('SELECT status FROM jobs')).status, 'done');
  assert.equal((await resumed.first('SELECT COUNT(*) n FROM operations')).n, 0);
});

test('screen hash persisted before completion lets a restarted job finish without another edit', async t => {
  const f = await screen(t); let edits = 0;
  const original = f.store.run.bind(f.store);
  f.store.run = async (sql, ...args) => {
    if (sql.startsWith('UPDATE jobs SET status=')) throw Error('completion interrupted');
    return original(sql, ...args);
  };
  const client = { async call() { edits++; return true; } };
  await assert.rejects(deliverUser(f.store, client, 100, { now }), /interrupted/u);
  await deliverUser(new PersonalStore(f.db), client, 100, { now: new Date(now.getTime() + 2000) });
  assert.equal(edits, 1);
  assert.equal((await f.store.first('SELECT status FROM jobs')).status, 'done');
});

for (const kind of ['timeout', '429', '403']) test(`queued manual screen keeps error handling: ${kind}`, async t => {
  const f = await screen(t);
  await deliverUser(f.store, { async call() {
    if (kind === 'timeout') throw Error('timeout');
    throw Object.assign(Error('rejected'), { apiRejected: true, errorCode: Number(kind), parameters: { retry_after: 25 } });
  } }, 100, { now });
  assert.equal((await f.store.first('SELECT COUNT(*) n FROM operations')).n, 0);
  const job = await f.store.first('SELECT * FROM jobs');
  if (kind === '403') {
    assert.equal(job.status, 'blocked'); assert.equal((await f.store.user(100)).blocked, 1);
  } else {
    assert.equal(job.status, 'pending'); assert.ok(job.due > now.getTime());
    await deliverUser(new PersonalStore(f.db), { async call() { return true; } }, 100, { now: new Date(now.getTime() + 60000) });
    assert.equal((await f.store.first('SELECT status FROM jobs')).status, 'done');
  }
});

test('missing screen replacement retains send intent and never repeats an ambiguous send', async t => {
  const f = await screen(t), calls = [];
  const client = { async call(method) {
    calls.push(method);
    if (method === 'editMessageText') throw Object.assign(Error('missing'), { apiRejected: true, errorCode: 400, description: 'message to edit not found' });
    throw Error('ambiguous send');
  } };
  for (let i = 0; i < 3; i++) await deliverUser(new PersonalStore(f.db), client, 100, { now: new Date(now.getTime() + i * 2000) });
  assert.deepEqual(calls, ['editMessageText', 'sendMessage']);
  assert.equal((await f.store.first('SELECT status FROM jobs')).status, 'uncertain');
  assert.equal((await f.store.first("SELECT status FROM operations WHERE method='sendMessage'")).status, 'uncertain');
});

test('empty groups keep all snapshots, late subscribers catch up, and emptied active cursors drain safely', async t => {
  const f = await personalFixture(); t.after(() => f.close());
  const a = await sampleSchedule('1А', '2026-11-13'), b = await sampleSchedule('2Б', '2026-11-13');
  await f.store.run("INSERT INTO users(user_id,group_id) VALUES(100,'1А')");
  await installSchedules(f.store, [a, b]);
  assert.deepEqual((await f.store.all('SELECT group_id FROM fanout')).map(r => r.group_id), ['1А']);
  assert.equal((await f.store.schedules('2Б')).length, 1);
  await f.store.run("INSERT INTO users(user_id,group_id) VALUES(200,'2Б')");
  await enqueuePersonalUpdate(f.store, { update_id: 1, userId: 200, action: 'start' });
  await processPersonalInbox(f.store, await f.store.first('SELECT * FROM inbox WHERE update_id=1'), now);
  assert.equal((await f.store.first("SELECT COUNT(*) n FROM jobs WHERE user_id=200 AND kind='card' AND status='pending'")).n, 1);
  await f.store.run('UPDATE users SET paused=1 WHERE user_id=100');
  await fanoutBatch(f.store, now.getTime());
  assert.equal((await f.store.first("SELECT COUNT(*) n FROM fanout WHERE status='pending'")).n, 0);
  assert.equal((await f.store.first('SELECT COUNT(*) n FROM jobs WHERE user_id=100')).n, 0);
});
