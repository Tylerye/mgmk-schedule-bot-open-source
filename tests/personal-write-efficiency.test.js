import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { personalFixture, sampleSchedule, installSchedules } from './helpers/personal-fixture.js';
import { enqueuePersonalUpdate, processPersonalInbox } from '../src/personal/inbox.js';
import { PersonalStore } from '../src/personal/store.js';
import { deliverUser, enqueueDue } from '../src/personal/delivery.js';
import { renderPersonal, nextRenderAt, nextPersonalPinAt } from '../src/personal/view.js';

const local = (time, day='2026-11-12') => new Date(`${day}T${time}:00+03:00`);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('inbox admission is idempotent and never exceeds the per-user limit under concurrent arrivals', async t => {
  const f = await personalFixture();
  t.after(() => f.close());
  const submit = update_id => enqueuePersonalUpdate(new PersonalStore(f.db), { update_id, userId: 1, action: 'settings' });
  const results = await Promise.all([1, 1, 2, 3, 4, 5, 6, 7].map(submit));
  assert.equal(results.filter(Boolean).length, 5);
  assert.equal(await submit(1), false);
  assert.equal((await f.store.first("SELECT rows FROM security_storage_counts WHERE name='inbox'")).rows, 5);
});

test('stale staging and recovery cooldown keep idle cheap without missing the next eligible retry', async t => {
  const f = await personalFixture();
  t.after(() => f.close());
  const now = local('08:00');
  const store = new PersonalStore(f.db, { LEGACY: {} });
  await store.run('INSERT INTO budgets(day) VALUES(?)', '2026-11-12');
  await store.run("INSERT INTO datasets(id,date,generation,manifest,expected_count) VALUES('test','2026-11-11',1,'{}',1)");
  assert.equal(await store.accountIdleTick(now), true);
  await store.run("UPDATE datasets SET date='2026-11-12'");
  await store.setSetting('recovery', { day: '2026-11-12', count: 1, at: +now });
  assert.equal(await store.accountIdleTick(local('08:19')), true);
  assert.equal(await store.accountIdleTick(local('08:20')), false);
  await store.setSetting('recovery', { day: '2026-11-12', count: 3, at: +now });
  assert.equal(await store.accountIdleTick(local('08:21')), true);
});

test('idle ticks take the cheap path until the first pending job is due', async t => {
  const f = await personalFixture();
  t.after(() => f.close());
  const now = local('08:00'), due = local('08:05');
  await f.store.run('INSERT INTO budgets(day) VALUES(?)', now.toISOString().slice(0, 10));
  await f.store.run('INSERT INTO users(user_id) VALUES(100)');
  await f.store.enqueue(await f.store.user(100), 'reply', 'screen', { due: +due });
  assert.equal(await new PersonalStore(f.db).accountIdleTick(now), true);
  assert.equal((await f.store.first("SELECT status FROM jobs WHERE kind='reply'")).status, 'pending');
  assert.equal(await new PersonalStore(f.db).accountIdleTick(due), false);
  const user = await f.store.user(100);
  await f.store.batch(Array.from({ length: 16 }, (_, i) => f.store.jobStatement(user, 'card', String(i), { due: +due })));
  assert.equal(await new PersonalStore(f.db).accountIdleTick(now), true);
  await f.store.enqueue(user, 'card', 'ready', { priority: 5, due: +now });
  assert.equal(await new PersonalStore(f.db).accountIdleTick(now), false);
  await f.store.run("UPDATE jobs SET due=?, priority=99 WHERE date='ready'", +due);
  assert.equal(await new PersonalStore(f.db).accountIdleTick(now), false);
});
async function fixture(t, { cards=true }={}) {
  const f=await personalFixture();t.after(()=>f.close());
  const s=await sampleSchedule(), tomorrow=await sampleSchedule('8Са','2026-11-13');
  await installSchedules(f.store,[s]); await installSchedules(f.store,[tomorrow],{id:'c'.repeat(64)});
  await f.store.run('INSERT INTO users(user_id,group_id,next_due) VALUES(100,?,?)',s.canonicalGroup,local('09:00').getTime());
  const user=await f.store.user(100);
  if(cards) {
    for(const [j,schedule] of [s,tomorrow].entries()) {
      const r=renderPersonal(schedule,user,{now:local('08:59')});
      await f.store.run('INSERT INTO cards(user_id,group_id,date,parts,schedule_hash,schedule_payload) VALUES(?,?,?,?,?,?)',100,s.canonicalGroup,schedule.date,
        JSON.stringify(r.parts.map((text,i)=>({id:88+j*10+i,hash:hash([text,i?{inline_keyboard:[]}:r.keyboard])}))),schedule.hash,JSON.stringify(schedule));
    }
    await f.store.run('UPDATE users SET pin_message_id=88,pin_date=? WHERE user_id=100',s.date);
  }
  const calls=[],client={async call(method,body){calls.push({method,body});return method==='sendMessage'?{message_id:1000+calls.length}:true;}};
  return {...f,s,tomorrow,user,calls,client};
}
async function drain(f, now, mode = "normal") {
  let ms=now.getTime();
  for(let i=0;i<30;i++) {
    const job=await f.store.first("SELECT due FROM jobs WHERE status='pending' ORDER BY due LIMIT 1");
    if(!job) return;
    ms=Math.max(ms+2000,job.due);
    await deliverUser(f.store,f.client,100,{now:new Date(ms),mode});
  }
  assert.fail('delivery must converge');
}

for (const existingCard of [false, true]) test(`manual onboarding completes the automatic pin in saving mode, existing card=${existingCard}`, async t => {
  const f = await fixture(t, { cards: existingCard });
  const now = local('08:59');
  await f.store.run('UPDATE users SET pin_message_id=NULL,pin_date=NULL WHERE user_id=100');
  await enqueuePersonalUpdate(f.store, { update_id:1, userId:100, action:existingCard ? 'start' : 'group:'+f.s.canonicalGroup });
  await processPersonalInbox(f.store, await f.store.first('SELECT * FROM inbox WHERE update_id=1'), now);
  await drain(f,now,'saving');
  const card = await f.store.card(f.user,f.s.date);
  assert.equal((await f.store.user(100)).pin_message_id,card.parts[0].id);
  assert.equal(f.calls.filter(c=>c.method==='pinChatMessage').length,1);
  assert.equal(f.calls.filter(c=>c.method==='sendMessage' && c.body.text.includes('МАТЕМАТИКА')).length,existingCard ? 0 : 2);
});

test('unchanged cards finish once without metadata writes, pin jobs or deadline rewrites',async t=>{
  const f=await fixture(t);
  f.sqlite.exec('CREATE TABLE card_writes(n INTEGER); CREATE TRIGGER test_card_write AFTER UPDATE ON cards BEGIN INSERT INTO card_writes VALUES(1); END;');
  await f.store.enqueue(f.user,'card',f.s.date,{due:local('08:59').getTime()});
  await deliverUser(f.store,f.client,100,{now:local('08:59')});
  assert.equal((await f.store.first("SELECT status FROM jobs WHERE kind='card'")).status,'done');
  assert.equal((await f.store.first('SELECT COUNT(*) n FROM card_writes')).n,0);
  assert.equal((await f.store.first("SELECT COUNT(*) n FROM jobs WHERE kind='pin'")).n,0);
  assert.equal((await f.store.user(100)).next_due,local('09:00').getTime());
  assert.deepEqual(f.calls,[]);
});

test('lesson completion queues only the changed date; concurrent due ticks preserve revisions and IDs',async t=>{
  const f=await fixture(t);
  await Promise.all([enqueueDue(f.store,local('09:00').getTime()),enqueueDue(new PersonalStore(f.db),local('09:00').getTime())]);
  const jobs=await f.store.all("SELECT * FROM jobs WHERE status='pending'");
  assert.deepEqual(jobs.map(j=>[j.kind,j.date]),[['card',f.s.date]]);
  const rev=jobs[0].revision;
  await enqueueDue(f.store,local('09:00').getTime());
  assert.equal((await f.store.first('SELECT revision FROM jobs')).revision,rev);
  await drain(f,local('09:00'));
  assert.deepEqual(f.calls.map(c=>c.method),['editMessageText']);
  assert.equal(f.calls[0].body.message_id,88);
});

test('metadata-only updates persist and subject changes still alert when the visible lesson is already hidden',async t=>{
  const f=await fixture(t);
  // Metadata changed without changing any visible text.
  await f.store.run('UPDATE cards SET schedule_hash=NULL,schedule_payload=NULL WHERE date=?',f.s.date);
  await f.store.enqueue(f.user,'card',f.s.date,{due:local('08:59').getTime()});
  await deliverUser(f.store,f.client,100,{now:local('08:59')});
  assert.equal((await f.store.card(f.user,f.s.date)).schedule.hash,f.s.hash);
  assert.deepEqual(f.calls,[]);
  const old=structuredClone(f.s);old.hash='d'.repeat(64);old.lessons[0].variants[0].subject='OLD';
  const r=renderPersonal(f.s,f.user,{now:local('18:00')});
  await f.store.run('UPDATE cards SET parts=?,schedule_hash=?,schedule_payload=? WHERE date=?',
    JSON.stringify(r.parts.map((text,i)=>({id:88+i,hash:hash([text,i?{inline_keyboard:[]}:r.keyboard])}))),old.hash,JSON.stringify(old),f.s.date);
  await f.store.enqueue(f.user,'card',f.s.date,{due:local('18:00').getTime()});
  await deliverUser(f.store,f.client,100,{now:local('18:00')});
  assert.equal((await f.store.first("SELECT COUNT(*) n FROM jobs WHERE kind='alert' AND status='pending'")).n,1);
  assert.equal((await f.store.card(f.user,f.s.date)).schedule.hash,f.s.hash);
});

test('one-part completion is atomic with metadata and job status; parallel lanes send once',async t=>{
  const f=await fixture(t,{cards:false});
  await f.store.enqueue(f.user,'card',f.s.date,{due:local('07:00').getTime()});
  await Promise.all([deliverUser(f.store,f.client,100,{now:local('07:00')}),deliverUser(new PersonalStore(f.db),f.client,100,{now:local('07:00')})]);
  assert.deepEqual(f.calls.map(c=>c.method),['sendMessage']);
  assert.equal((await f.store.first("SELECT status FROM jobs WHERE kind='card'")).status,'done');
  assert.equal((await f.store.card(f.user,f.s.date)).schedule.hash,f.s.hash);
});

for(const crossBoundary of [false,true]) test(`receipt survives restart before card persistence, boundary=${crossBoundary}`,async t=>{
  const f=await fixture(t,{cards:false});
  await f.store.enqueue(f.user,'card',f.s.date,{due:local('08:59').getTime()});
  const original=f.store.batch.bind(f.store);let crash=true;
  f.store.batch=async statements=>{if(crash&&statements.some(([sql])=>sql.startsWith('INSERT INTO cards'))){crash=false;throw Error('simulated restart');}return original(statements);};
  await assert.rejects(deliverUser(f.store,f.client,100,{now:local('08:59')}),/simulated restart/);
  const resumed=new PersonalStore(f.db);
  await deliverUser(resumed,f.client,100,{now:local(crossBoundary?'09:00':'08:59')});
  assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1);
  assert.equal((await resumed.card(f.user,f.s.date)).parts[0].id,1001);
  if(crossBoundary) {
    assert.equal((await resumed.first("SELECT status FROM jobs WHERE kind='card'")).status,'pending');
    await deliverUser(resumed,f.client,100,{now:local('09:01')});
    assert.equal(f.calls.filter(c=>c.method==='editMessageText').length,1);
  }
  assert.equal((await resumed.first("SELECT status FROM jobs WHERE kind='card'")).status,'done');
});

test('multipart persists each part, resumes with stable IDs and finalizes in the last send lane',async t=>{
  const f=await fixture(t,{cards:false});
  f.s.timeline.find(e=>e.number===1).variants[0].subject=f.s.lessons[0].variants[0].subject='<&>'.repeat(800);f.s.hash='b'.repeat(64);
  await installSchedules(f.store,[f.s],{id:'b'.repeat(64),generation:2});
  const expected=renderPersonal(f.s,f.user,{now:local('07:00')}).parts.length;
  await f.store.enqueue(f.user,'card',f.s.date,{due:local('07:00').getTime()});
  for(let i=0;i<expected;i++) {
    await deliverUser(new PersonalStore(f.db),f.client,100,{now:new Date(local('07:00').getTime()+i*2000)});
    const c=await f.store.card(f.user,f.s.date);assert.equal(c.parts.length,i+1);
    assert.equal((await f.store.first("SELECT status FROM jobs WHERE kind='card'")).status,i+1===expected?'done':'pending');
  }
  assert.equal(new Set((await f.store.card(f.user,f.s.date)).parts.map(p=>p.id)).size,expected);
  assert.equal(f.calls.length,expected);
});

test('pin deadline is independent, switches once at 16:30, remains monotonic at midnight and handles late PDF',async t=>{
  const f=await fixture(t);
  const eligible=[{date:f.s.date,messageId:88,hasLessons:true},{date:f.tomorrow.date,messageId:98,hasLessons:true}];
  assert.equal(nextPersonalPinAt(eligible,{date:f.s.date,messageId:88},local('16:29')),local('16:30').getTime());
  await f.store.run('UPDATE users SET next_due=? WHERE user_id=100',local('16:30').getTime());
  await enqueueDue(f.store,local('16:30').getTime());
  assert.equal((await f.store.first("SELECT COUNT(*) n FROM jobs WHERE kind='pin' AND status='pending'")).n,1);
  await drain(f,local('16:30'));
  assert.equal((await f.store.user(100)).pin_message_id,98);
  assert.equal(f.calls.filter(c=>c.method==='pinChatMessage').length,1);
  await enqueueDue(f.store,local('00:00','2026-11-13').getTime());
  await drain(f,local('00:00','2026-11-13'));
  assert.equal(f.calls.filter(c=>c.method==='pinChatMessage').length,1);
  // A future PDF delivered late still chooses the already-published future card.
  await f.store.run('UPDATE users SET pin_message_id=88,pin_date=? WHERE user_id=100',f.s.date);
  await f.store.enqueue(await f.store.user(100),'card',f.tomorrow.date,{due:local('18:00').getTime()});
  await drain(f,local('18:00'));
  assert.equal((await f.store.user(100)).pin_message_id,98);
});

test('a confirmed pin persists the message and changed deadline in one user update', async t => {
  const f = await fixture(t);
  const now = local('16:30');
  await f.store.enqueue(await f.store.user(100), 'pin', '', { due: +now });
  f.sqlite.exec(`CREATE TABLE pin_updates(n INTEGER);
    CREATE TRIGGER track_pin_update AFTER UPDATE ON users
    WHEN OLD.pin_message_id IS NOT NEW.pin_message_id OR OLD.next_due IS NOT NEW.next_due
    BEGIN INSERT INTO pin_updates VALUES(1); END;`);
  await deliverUser(f.store, f.client, 100, { now });
  const user = await f.store.user(100);
  assert.equal(user.pin_message_id, 98);
  assert.ok(user.next_due > +now);
  assert.equal((await f.store.first('SELECT COUNT(*) n FROM pin_updates')).n, 1);
  assert.deepEqual(f.calls.map(c => c.method), ['pinChatMessage']);
});

test('only the pilot includes starts in full-view deadlines',async()=>{
  const s=await sampleSchedule('8ТС');
  assert.equal(nextRenderAt(s,local('08:16')),local('09:00').getTime());
  const custom={...s,timeline:[{type:'break',start:'08:15',end:'08:19'},{...s.timeline.find(e=>e.type==='lesson'),start:'08:20',end:'08:31'}]};
  assert.equal(nextRenderAt(custom,local('08:16')),local('08:21').getTime());
  assert.equal(nextRenderAt(custom,local('08:16'),{mode:'full'}),local('08:33').getTime());
  assert.equal(nextRenderAt({...custom,canonicalGroup:'8СА'},local('08:16'),{mode:'full'}),local('08:21').getTime());
  custom.timeline[1].end=null;
  assert.equal(nextRenderAt(custom,local('18:00')),local('00:00','2026-11-13').getTime());
});

test('8-Сба shows current and next lessons and retains PDF details across clock edits on the same card', async t => {
  const f = await fixture(t);
  const revised = structuredClone(f.s);
  revised.hash = 'e'.repeat(64);
  const lesson = revised.timeline.find(event => event.type === 'lesson');
  lesson.variants[0].room = '214';
  revised.lessons.find(item => item.number === lesson.number).variants[0].room = '214';
  lesson.end = '09:01';
  await installSchedules(f.store, [revised], { id: 'b'.repeat(64), generation: 2 });
  await f.store.enqueue(f.user, 'card', revised.date, { due: local('08:50').getTime() });
  await drain(f, local('08:50'));
  const edit = f.calls.find(call => call.method === 'editMessageText' && call.body.message_id === 88);
  assert.match(edit.body.text, /Сейчас · до 09:01/u);
  assert.match(edit.body.text, /Дальше · .*ФИЗИКА/u);
  assert.match(edit.body.text, /Кабинет 245 → 214/u);
  const card = await f.store.card(f.user, revised.date);
  assert.ok(card.parts[0].lessonChanges[0].time);
  const updated = renderPersonal(revised, f.user, { now: local('09:03'), lessonChanges: card.parts[0].lessonChanges });
  assert.doesNotMatch(updated.parts[0], /245 → 214/u);
  assert.ok(f.calls.every(call => call.method !== 'sendMessage'));
  assert.doesNotMatch(renderPersonal({ ...revised, canonicalGroup: '8ТС' }, f.user, { now: local('08:50') }).parts[0], /Сейчас ·|Дальше ·/u);
});

for(const error of ['429','403','ambiguous']) test(`card delivery preserves durable behavior for ${error}`,async t=>{
  const f=await fixture(t,{cards:false});let n=0;
  const client={async call(){n++;if(error==='ambiguous')throw Error('timeout');throw Object.assign(Error('rejected'),{apiRejected:true,errorCode:Number(error),parameters:{retry_after:25}});}};
  await f.store.enqueue(f.user,'card',f.s.date,{due:local('07:00').getTime()});
  await deliverUser(f.store,client,100,{now:local('07:00')});
  assert.equal(await f.store.card(f.user,f.s.date),null);
  if(error==='429') {
    assert.equal((await f.store.first("SELECT due FROM jobs WHERE kind='card'")).due,local('07:00').getTime()+25000);
    await deliverUser(new PersonalStore(f.db),f.client,100,{now:local('07:01')});
    assert.equal((await f.store.first("SELECT status FROM jobs WHERE kind='card'")).status,'done');
  } else {
    await deliverUser(new PersonalStore(f.db),client,100,{now:local('07:01')});assert.equal(n,1);
    assert.equal((await f.store.first("SELECT status FROM jobs WHERE kind='card'")).status,error==='403'?'blocked':'uncertain');
  }
});

test('near-ceiling admissions remain atomic and UTC rollover never resets the spent day',async t=>{
  const f=await fixture(t,{cards:false});
  await f.store.run("INSERT INTO budgets(day,rows_written) VALUES('2026-11-12',27850)");
  const now=new Date('2026-11-12T23:59:59Z'),a=new PersonalStore(f.db),b=new PersonalStore(f.db);
  assert.ok((await Promise.all([a.budget(now,1,{router:true}),b.budget(now,1,{userWork:true})])).some(r=>r.mode==='stopped'));
  const spent=(await f.store.first("SELECT rows_written FROM budgets WHERE day='2026-11-12'")).rows_written;
  assert.equal((await new PersonalStore(f.db).budget(new Date('2026-11-13T00:00:00Z'),1,{userWork:true})).mode,'normal');
  assert.equal((await f.store.first("SELECT rows_written FROM budgets WHERE day='2026-11-12'")).rows_written,spent);
});

test('queued card edits recover after a persistence crash using the same message without a second journal',async t=>{
  const f=await fixture(t);await f.store.enqueue(f.user,'card',f.s.date,{due:local('09:00').getTime()});
  const original=f.store.batch.bind(f.store);let crash=true,attempts=0;
  f.store.batch=async statements=>{if(crash&&statements.some(([sql])=>sql.startsWith('INSERT INTO cards'))){crash=false;throw Error('card commit interrupted');}return original(statements);};
  const client={async call(method,body){assert.equal(method,'editMessageText');assert.equal(body.message_id,88);attempts++;
    if(attempts>1)throw Object.assign(Error('unchanged'),{apiRejected:true,errorCode:400,description:'Bad Request: message is not modified'});return true;}};
  await assert.rejects(deliverUser(f.store,client,100,{now:local('09:00')}),/interrupted/u);
  const resumed=new PersonalStore(f.db);await deliverUser(resumed,client,100,{now:local('09:01')});
  assert.equal(attempts,2);assert.equal((await resumed.card(f.user,f.s.date)).parts[0].id,88);
  assert.equal((await resumed.first('SELECT COUNT(*) n FROM operations')).n,0);
  const done=await resumed.first("SELECT * FROM jobs WHERE kind='card'");assert.equal(done.status,'done');assert.ok(done.completed_at);
  await resumed.enqueue(f.user,'card',f.s.date,{due:local('09:02').getTime()});
  const reopened=await resumed.first("SELECT * FROM jobs WHERE kind='card'");assert.equal(reopened.completed_at,null);assert.ok(reopened.revision>done.revision);
});

for(const kind of ['timeout','429','403']) test(`queued card edit retains retry and block handling: ${kind}`,async t=>{
  const f=await fixture(t);await f.store.enqueue(f.user,'card',f.s.date,{due:local('09:00').getTime()});
  const client={async call(method){assert.equal(method,'editMessageText');if(kind==='timeout')throw Error('timeout');
    throw Object.assign(Error('rejected'),{apiRejected:true,errorCode:Number(kind),parameters:{retry_after:25}});}};
  await deliverUser(f.store,client,100,{now:local('09:00')});
  assert.equal((await f.store.first('SELECT COUNT(*) n FROM operations')).n,0);
  const job=await f.store.first("SELECT * FROM jobs WHERE kind='card'");
  if(kind==='403'){assert.equal(job.status,'blocked');assert.equal((await f.store.user(100)).blocked,1);}
  else {assert.equal(job.status,'pending');assert.ok(job.due>local('09:00').getTime());
    await deliverUser(new PersonalStore(f.db),f.client,100,{now:local('09:01')});
    assert.equal((await f.store.first("SELECT status FROM jobs WHERE kind='card'")).status,'done');
    assert.deepEqual(f.calls.map(c=>c.method),['editMessageText']);}
});

test('uneditable card replacement still uses an uncertain-protected send intent',async t=>{
  const f=await fixture(t);await f.store.enqueue(f.user,'card',f.s.date,{due:local('09:00').getTime()});
  const methods=[],client={async call(method){methods.push(method);
    if(method==='editMessageText')throw Object.assign(Error('missing'),{apiRejected:true,errorCode:400,description:'message to edit not found'});
    throw Error('ambiguous send timeout');}};
  await deliverUser(f.store,client,100,{now:local('09:00')});
  await deliverUser(new PersonalStore(f.db),client,100,{now:local('09:01')});
  await deliverUser(new PersonalStore(f.db),client,100,{now:local('09:02')});
  assert.deepEqual(methods,['editMessageText','sendMessage']);
  assert.equal((await f.store.first("SELECT status FROM jobs WHERE kind='card'")).status,'uncertain');
  assert.equal((await f.store.first("SELECT status FROM operations WHERE method='sendMessage'")).status,'uncertain');
});

test('/start verifies and restores a missing pin without requeueing a current second card', async t => {
  const f = await fixture(t);
  const now = local('08:59');
  await enqueuePersonalUpdate(f.store, {update_id:1,userId:100,action:'start'});
  await processPersonalInbox(f.store,await f.store.first('SELECT * FROM inbox WHERE update_id=1'),now);
  const jobs = await f.store.all("SELECT date,payload FROM jobs WHERE kind='card'");
  assert.deepEqual(jobs.map(job=>[job.date,JSON.parse(job.payload).verifyMessageId]),[[f.s.date,88]]);
  let sequence = 1000;
  f.client.call = async (method,body) => {
    f.calls.push({method,body});
    if (method==='editMessageText' && body.message_id===88)
      throw Object.assign(Error('missing'),{apiRejected:true,errorCode:400,description:'Bad Request: message to edit not found'});
    return method==='sendMessage' ? {message_id:++sequence} : true;
  };
  await drain(f,now);
  assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,2);
  assert.equal((await f.store.user(100)).pin_message_id,1002);
  assert.equal((await f.store.card(f.user,f.s.date)).parts[0].id,1002);
  assert.equal((await f.store.card(f.user,f.tomorrow.date)).parts[0].id,98);
});

test('multiple jobs in one batch consume one revision-counter write and keep ordered distinct revisions', async t => {
  const f = await fixture(t);
  f.sqlite.exec('CREATE TABLE revision_writes(n INTEGER); CREATE TRIGGER test_revision_write AFTER UPDATE ON job_revision_sequence BEGIN INSERT INTO revision_writes VALUES(1); END;');
  const jobs = ['ru','en',''].map(date=>f.store.jobStatement(f.user,'commands',date));
  await f.store.batch(jobs);
  assert.equal((await f.store.first('SELECT count(*) n FROM revision_writes')).n,1);
  const rows=await f.store.all('SELECT date,revision FROM jobs ORDER BY revision');
  assert.deepEqual(rows.map(r=>r.date),['ru','en','']);
  assert.deepEqual(rows.map(r=>r.revision-rows[0].revision),[0,1,2]);
});

test('clock-driven delivery edits the existing card using one user lease', async t => {
  const f = await fixture(t);
  f.sqlite.exec('CREATE TABLE lease_writes(n INTEGER); CREATE TRIGGER test_lease_write AFTER UPDATE ON locks BEGIN INSERT INTO lease_writes VALUES(1); END;');
  await deliverUser(f.store, f.client, 100, { now: local('09:00'), catchUp: true });
  assert.deepEqual(f.calls.map(c => [c.method,c.body.message_id]), [['editMessageText',88]]);
  const job = await f.store.first("SELECT status FROM jobs WHERE kind='card' AND date=?",f.s.date);
  assert.equal(job,null);
  assert.equal((await f.store.first("SELECT expires_at FROM locks WHERE user_id=100")).expires_at,0);
  assert.equal((await f.store.first('SELECT count(*) n FROM lease_writes')).n,1);
  assert.equal((await f.store.user(100)).pin_message_id,88);
  assert.equal((await f.store.card(f.user,f.tomorrow.date)).parts[0].id,98);
});

test('clock edit retains a durable retry deadline after Telegram 429', async t => {
  const f = await fixture(t), now = local('09:00');
  const client = { async call() { throw Object.assign(Error('limited'), { errorCode: 429, parameters: { retry_after: 33 } }); } };
  await deliverUser(f.store, client, 100, { now, catchUp: true });
  const job = await f.store.first("SELECT * FROM jobs WHERE status='pending'");
  assert.equal(job.due, now.getTime() + 33000);
  await deliverUser(f.store, f.client, 100, { now: local('09:01') });
  assert.deepEqual(f.calls.map(c => c.body.message_id), [88]);
});

test('restart after a clock edit repeats only the original message and accepts not-modified', async t => {
  const f = await fixture(t), now = local('09:00');
  const client = { async call(method, body) {
    assert.deepEqual([method, body.message_id], ['editMessageText', 88]);
    f.sqlite.exec("CREATE TRIGGER interrupt_clock BEFORE UPDATE OF parts ON cards BEGIN SELECT RAISE(ABORT,'clock crash'); END");
    return true;
  } };
  await assert.rejects(deliverUser(f.store, client, 100, { now, catchUp: true }), /clock crash/u);
  assert.equal((await f.store.user(100)).next_due, now.getTime());
  f.sqlite.exec("DROP TRIGGER interrupt_clock");
  const recovered = { async call(method, body) {
    assert.deepEqual([method, body.message_id], ['editMessageText', 88]);
    throw Object.assign(Error('already edited'), {description:'message is not modified',errorCode:400,apiRejected:true});
  } };
  await deliverUser(new PersonalStore(f.db), recovered, 100, { now:local('09:01'), catchUp:true });
  assert.ok((await f.store.card(f.user,f.s.date)).parts[0].hash);
  assert.ok((await f.store.user(100)).next_due > now.getTime());
  assert.equal(await f.store.first("SELECT 1 FROM jobs"), null);
});

test('missing clock-edit target recovers through a journalled replacement send', async t => {
  const f = await fixture(t);
  const client = { async call() { throw Object.assign(Error('missing'),{errorCode:400,apiRejected:true,description:'message to edit not found'}); } };
  await deliverUser(f.store,client,100,{now:local('09:00'),catchUp:true});
  assert.equal((await f.store.card(f.user,f.s.date)).parts[0].replacementFor,88);
  await deliverUser(f.store,f.client,100,{now:local('09:01')});
  assert.deepEqual(f.calls.map(c=>c.method),['sendMessage']);
  assert.equal((await f.store.first("SELECT status FROM operations WHERE method='sendMessage'")).status,'succeeded');
});

test('publication during clock edit leaves the overdue card recoverable', async t => {
  const f = await fixture(t), now = local('09:00');
  const newer = { ...f.s, hash: 'f'.repeat(64) };
  const client = { async call() {
    await installSchedules(f.store, [newer], { id: 'd'.repeat(64), generation: 2 });
    return true;
  } };
  await deliverUser(f.store, client, 100, { now, catchUp: true });
  assert.equal((await f.store.user(100)).next_due, now.getTime());
  assert.equal((await f.store.card(f.user, f.s.date)).parts[0].hash, null);
  await deliverUser(f.store, f.client, 100, { now: local('09:01'), catchUp: true });
  assert.equal((await f.store.card(f.user, f.s.date)).schedule_hash, newer.hash);
});
