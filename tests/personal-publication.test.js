import test from 'node:test';
import assert from 'node:assert/strict';
import { personalFixture, sampleSchedule, installSchedules } from './helpers/personal-fixture.js';
import { fanoutBatch, beginDataset, stageSchedules, finishDataset } from '../src/personal/ingest.js';

test('publication spans groups, bounds recipients and resumes without requeuing completed users', async t => {
  const f = await personalFixture(); t.after(() => f.close());
  const schedules = await Promise.all(['8Са', '8ТС', '10СБ'].map(g => sampleSchedule(g)));
  for (let id = 1; id <= 140; id++)
    await f.store.run('INSERT INTO users(user_id,group_id,paused,blocked) VALUES(?,?,?,?)', id, schedules[id % 3].canonicalGroup, id === 139 ? 1 : 0, id === 140 ? 1 : 0);
  await installSchedules(f.store, schedules);
  // One update of the revision sequence per publication batch, not per user.
  f.sqlite.exec('CREATE TABLE revision_writes(n INTEGER); CREATE TRIGGER test_revision_write AFTER UPDATE ON job_revision_sequence BEGIN INSERT INTO revision_writes VALUES(1); END;');
  await fanoutBatch(f.store, 1000);
  let jobs = await f.store.all('SELECT * FROM jobs ORDER BY user_id');
  assert.equal(jobs.length, 24);
  assert.equal(new Set(jobs.map(j => j.revision)).size, 24);
  const firstUser = jobs[0].user_id;
  const firstRevision = jobs[0].revision;
  await f.store.run("UPDATE jobs SET status='done',completed_at=1100 WHERE user_id=?", firstUser);
  await fanoutBatch(f.store, 2000);
  for (let i = 0; i < 4; i++) await fanoutBatch(f.store, 2001 + i);
  jobs = await f.store.all('SELECT * FROM jobs ORDER BY user_id');
  assert.equal(jobs.length, 138);
  assert.equal(new Set(jobs.map(j => j.user_id % 3)).size, 3);
  assert.equal(jobs.find(j => j.user_id === firstUser).status, 'done');
  assert.equal(jobs.find(j => j.user_id === firstUser).revision, firstRevision);
  assert.equal(new Set(jobs.map(j => j.revision)).size, 138);
  assert.equal((await f.store.first("SELECT COUNT(*) n FROM fanout WHERE status='pending'")).n, 0);
  assert.equal((await f.store.first('SELECT COUNT(*) n FROM revision_writes')).n, 6);
  await fanoutBatch(f.store, 3000);
  assert.equal((await f.store.first('SELECT COUNT(*) n FROM revision_writes')).n, 6);
  // A new generation still updates every eligible subscription exactly once.
  const newer = schedules.map(s => ({ ...s, hash: 'c'.repeat(64) }));
  await installSchedules(f.store, newer, { id: 'b'.repeat(64), generation: 2 });
  await fanoutBatch(f.store, 4000);
  await fanoutBatch(f.store, 5000);
  for (let i = 0; i < 4; i++) await fanoutBatch(f.store, 5001 + i);
  assert.equal((await f.store.first("SELECT COUNT(*) n FROM jobs WHERE status='pending'")).n, 138);
  assert.ok((await f.store.first('SELECT revision FROM jobs WHERE user_id=?', firstUser)).revision > firstRevision);
});

test('publication enqueue and cursor progress roll back together on failure', async t => {
  const f = await personalFixture(); t.after(() => f.close());
  const s = await sampleSchedule();
  await f.store.run('INSERT INTO users(user_id,group_id) VALUES(1,?)', s.canonicalGroup);
  await installSchedules(f.store, [s]);
  f.sqlite.exec("CREATE TRIGGER reject_publication BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END;");
  await assert.rejects(fanoutBatch(f.store, 1000), /simulated storage failure/);
  assert.equal((await f.store.first('SELECT value FROM job_revision_sequence')).value, 0);
  assert.equal((await f.store.first('SELECT cursor FROM fanout')).cursor, 0);
  assert.equal((await f.store.first('SELECT status FROM fanout')).status, 'pending');
  f.sqlite.exec('DROP TRIGGER reject_publication');
  await fanoutBatch(f.store, 2000);
  assert.equal((await f.store.first('SELECT COUNT(*) n FROM jobs')).n, 1);
  assert.equal((await f.store.first('SELECT status FROM fanout')).status, 'done');
});

test('finish signals only a newly activated generation; unchanged and obsolete sources do not wake delivery', async t => {
  const f = await personalFixture(); t.after(() => f.close());
  const s = await sampleSchedule();
  const input = { id: 'a'.repeat(64), date: s.date, generation: 2, observations: [], manifest: { [s.canonicalGroup]: s.hash } };
  await beginDataset(f.store, input); await stageSchedules(f.store, input.id, [s]);
  assert.equal(await finishDataset(f.store, input.id), true);
  assert.equal(await finishDataset(f.store, input.id), false);
  const older = { ...input, id: 'b'.repeat(64), generation: 1 };
  await beginDataset(f.store, older); await stageSchedules(f.store, older.id, [s]);
  assert.equal(await finishDataset(f.store, older.id), false);
});
