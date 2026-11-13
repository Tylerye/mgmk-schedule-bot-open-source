import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { personalFixture, sampleSchedule, installSchedules } from './helpers/personal-fixture.js';
import { PersonalStore } from '../src/personal/store.js';
import { deliverUser, enqueueDue } from '../src/personal/delivery.js';
import { renderPersonal, nextRenderAt, nextPersonalPinAt } from '../src/personal/view.js';

const local = (time, day='2026-11-12') => new Date(`${day}T${time}:00+03:00`);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
async function drain(f, now) {
  let ms=now.getTime();
  for(let i=0;i<30;i++) {
    const job=await f.store.first("SELECT due FROM jobs WHERE status='pending' ORDER BY due LIMIT 1");
    if(!job) return;
    ms=Math.max(ms+2000,job.due);
    await deliverUser(f.store,f.client,100,{now:new Date(ms)});
  }
  assert.fail('delivery must converge');
}

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

test('visible deadlines omit starts and full-view breaks but retain coalescing and midnight',async()=>{
  const s=await sampleSchedule();
  assert.equal(nextRenderAt(s,local('08:16')),local('09:00').getTime());
  const custom={...s,timeline:[{type:'break',start:'08:15',end:'08:19'},{...s.timeline.find(e=>e.type==='lesson'),start:'08:20',end:'08:31'}]};
  assert.equal(nextRenderAt(custom,local('08:16')),local('08:21').getTime());
  assert.equal(nextRenderAt(custom,local('08:16'),{mode:'full'}),local('08:33').getTime());
  custom.timeline[1].end=null;
  assert.equal(nextRenderAt(custom,local('18:00')),local('00:00','2026-11-13').getTime());
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
