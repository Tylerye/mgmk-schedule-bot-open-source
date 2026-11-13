import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundPolicy } from '../src/background-policy.js';
import worker from '../personal/worker.js';
import { personalFixture } from './helpers/personal-fixture.js';
import { deliveryHealth, diagnosticText } from '../src/personal/delivery.js';
import { build } from 'esbuild';

const at = t => new Date(`2026-11-13T${t}:00+03:00`);
test('Minsk quiet hours include midnight and UTC quota reset, resume at six', () => {
  for (const t of ['21:29','06:00','16:00','16:30','19:55']) assert.equal(backgroundPolicy(at(t)).night,false,t);
  for (const t of ['21:30','22:00','00:00','03:00','05:45']) assert.equal(backgroundPolicy(at(t)).run,true,t);
  for (const t of ['21:31','23:59','00:01','03:01','05:59']) assert.equal(backgroundPolicy(at(t)).run,false,t);
  assert.equal(backgroundPolicy(at('06:01')).staleAfterMs,1200000);
  assert.equal(backgroundPolicy(at('06:05')).staleAfterMs,300000);
  const minutes=Array.from({length:510},(_,i)=>new Date(at('21:30').getTime()+i*60000));
  assert.equal(minutes.filter(d=>backgroundPolicy(d).run).length,34);
});

test('both Cron entrypoints skip D1 and fanout on a quiet minute', async () => {
  const code=(await build({entryPoints:['cloudflare/worker.js'],bundle:true,write:false,format:'esm',platform:'node',external:['node:crypto']})).outputFiles[0].text;
  const main=(await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default;
  const env={DB:{prepare(){assert.fail('no database access');}},SELF:{fetch(){assert.fail('no HTTP lane');}}};
  const ctx={waitUntil(){assert.fail('no background work');}};
  const controller={cron:'* * * * *',scheduledTime:at('22:01').getTime()};
  await worker.scheduled(controller,env,ctx);
  await main.scheduled(controller,env,ctx);
});

test('due users are visible even with an empty jobs queue; saving health is degraded', async t => {
  const f=await personalFixture();t.after(()=>f.close());
  const now=new Date();
  await f.store.run('INSERT INTO users(user_id,next_due) VALUES(100,?)',now.getTime()-25*60000);
  const health=await deliveryHealth(f.store,now);
  assert.equal(health.dueUsers,1);assert.equal(health.dueLagSeconds,1500);
  assert.equal(health.pendingJobs,0);assert.equal(health.late,true);
  assert.match(await diagnosticText(f.store,now),/Due users: 1; lag: 1500s/u);
  await f.store.run('INSERT INTO budgets(day,rows_written) VALUES(?,43000)',now.toISOString().slice(0,10));
  const response=await worker.fetch(new Request('https://personal.internal/health',{method:'POST',headers:{authorization:'Bearer test'}}),
    {DB:f.db,PERSONAL_SHARED_SECRET:'test',PERSONAL_DAILY_WRITES:'50000',PERSONAL_BACKGROUND_WRITES:'42000',PERSONAL_SOURCE_WRITES:'48000'},{});
  const body=await response.json();
  assert.equal(body.backgroundPaused,true);assert.equal(body.degraded,true);
  assert.equal(body.deliveryStopped,false);assert.equal(body.dueUsers,1);
});

test('main readiness exposes saving instead of reporting a fully healthy personal service', async () => {
  const code=(await build({entryPoints:['cloudflare/worker.js'],bundle:true,write:false,format:'esm',platform:'node',external:['node:crypto']})).outputFiles[0].text;
  const main=(await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default;
  const env={HEALTH_READ_SECRET:'test',PERSONAL_ENABLED:'true',PERSONAL_SHARED_SECRET:'local',
    DB:{prepare(){return{async first(){return{json:JSON.stringify({health:{}})}}}}},
    PERSONAL:{async fetch(){return Response.json({ok:true,backgroundPaused:true,degraded:true,dueUsers:4,dueLagSeconds:400,jobLagSeconds:0});}}};
  const r=await main.fetch(new Request('https://example.test/internal/health',{headers:{authorization:'Bearer test'}}),env,{});
  assert.equal(r.status,503);const body=await r.json();assert.equal(body.ok,false);
  assert.equal(body.degraded,true);assert.equal(body.personal.dueUsers,4);
});
