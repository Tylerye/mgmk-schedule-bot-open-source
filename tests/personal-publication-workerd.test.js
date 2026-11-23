import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { PersonalStore } from '../src/personal/store.js';
import { beginDataset, stageSchedules, finishDataset, fanoutBatch } from '../src/personal/ingest.js';
import { sampleSchedule } from './helpers/personal-fixture.js';

test('workerd immediately delivers a new publication across 22 groups without Cron or duplicate finish sends', async () => {
  const baseline = process.env.PERSONAL_MEASURE_REF;
  const schemaRef = process.env.PERSONAL_MEASURE_SCHEMA_REF || baseline;
  const recipients = Number(process.env.PERSONAL_MEASURE_USERS ?? 60);
  assert.ok([60,120].includes(recipients));
  if (baseline) assert.match(baseline, /^[a-f0-9]{7,40}$/u);
  if (schemaRef) assert.match(schemaRef, /^[a-f0-9]{7,40}$/u);
  const script = (await build({ stdin: { contents: `import worker from './personal/worker.js';
    import {PersonalStore} from './src/personal/store.js';
    const measure = PersonalStore.prototype.measure;
    let writes = 0;
    let reads = 0;
    let statements = 0;
    PersonalStore.prototype.measure = function(result) {
      writes += result?.meta?.rows_written ?? 0;
      reads += result?.meta?.rows_read ?? 0;
      statements++;
      return measure.call(this,result);
    };
    export default {async fetch(request,env,ctx){
      if(new URL(request.url).pathname==='/test-cost') return Response.json(writes);
      if(new URL(request.url).pathname==='/test-d1-meta') return Response.json({ reads, writes, statements });
      if(new URL(request.url).pathname==='/test-inbox') {
        const pending=[];
        const response=await worker.fetch(new Request('http://localhost/inbox',request),env,{waitUntil(p){pending.push(p)}});
        await Promise.all(pending);return response;
      }
      if(new URL(request.url).pathname==='/test-finish') {
        const pending=[];
        const response=await worker.fetch(new Request('http://localhost/finish',request),env,{waitUntil(p){pending.push(p)}});
        await Promise.all(pending);return response;
      }
      if(new URL(request.url).pathname==='/test-cron') {
        const pending=[];await worker.scheduled({scheduledTime:Date.parse('2026-11-16T09:00:00+03:00')},env,{waitUntil(p){pending.push(p)}});
        await Promise.all(pending);return new Response('ok');
      }
      return worker.fetch(request,env,ctx);
    }};`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:crypto'],
    plugins: baseline ? [{ name: 'baseline-publication', setup(b) {
      b.onLoad({ filter: /[\\/](?:personal[\\/]worker|src[\\/]personal[\\/](?:ingest|store|delivery|inbox))\.js$/ }, args => {
        const path = relative(realpathSync(process.cwd()), realpathSync(args.path)).replaceAll('\\', '/');
        return { contents: execFileSync('git', ['-c', `safe.directory=${process.cwd()}`, 'show', `${baseline}:${path}`], { encoding: 'utf8' }), loader: 'js' };
      });
    } }] : [] })).outputFiles[0].text;
  const lanes = [], sends = [], edits = [], editTimes = [];
  let failFirstDelivery = !baseline && !process.env.PERSONAL_MEASURE_TELEGRAM_MS;
  const telegramDelay = Number(process.env.PERSONAL_MEASURE_TELEGRAM_MS ?? 0);
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'personal', modules: true, script,
    compatibilityDate: '2026-09-14', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'publication-db' },
    bindings: { PERSONAL_SHARED_SECRET: 'local-test', ADMIN_USER_ID: '100', BOT_TOKEN: 'fake', PERSONAL_DELIVERY_ENABLED: 'true', PERSONAL_PUBLIC: 'true' },
    serviceBindings: { SELF: async (request, runtime) => {
      const path = new URL(request.url).pathname;
      lanes.push(path);
      if (failFirstDelivery && path.startsWith('/delivery/')) {
        failFirstDelivery = false;
        return new Response(null, { status: 503 });
      }
      return (await runtime.getWorker('personal')).fetch(request);
    } },
    outboundService: async request => {
      assert.equal(new URL(request.url).hostname, 'api.telegram.org');
      const body = await request.json();
      if (telegramDelay > 0) await new Promise(resolve => setTimeout(resolve, telegramDelay));
      if (new URL(request.url).pathname.endsWith('/sendMessage')) sends.push(body.chat_id);
      if (new URL(request.url).pathname.endsWith('/editMessageText')) { edits.push(body.chat_id); editTimes.push(Date.now()); }
      return new Response(JSON.stringify({ ok: true, result: { message_id: sends.length } }), { headers: { 'content-type': 'application/json' } });
    } }));
  try {
    const db = await mf.getD1Database('DB');
    const git = (...args) => execFileSync('git', ['-c', 'safe.directory='+process.cwd(), ...args], { encoding: 'utf8' });
    const files = schemaRef ? git('ls-tree','--name-only',schemaRef+':personal/migrations').trim().split(/\r?\n/u) : await readdir('personal/migrations');
    for (const file of files.filter(f => f.endsWith('.sql')).sort()) {
      const path = 'personal/migrations/'+file;
      const source = schemaRef ? git('show',schemaRef+':'+path) : await readFile(path,'utf8');
      for (const sql of source.replace(/--[^\n]*/gu, '').replace(/;\s*END;/gi, '__TRIGGER_END__;').split(';').map(s => s.replaceAll('__TRIGGER_END__', '; END;')).filter(s => s.trim())) await db.prepare(sql).run();
    }
    const store = new PersonalStore(db);
    const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const schedules = await Promise.all(Array.from({ length: 22 }, (_, i) => sampleSchedule(`${i + 1}ТМ`, date)));
    for (let i = 0; i < recipients; i++) await db.prepare('INSERT INTO users(user_id,group_id) VALUES(?,?)').bind(1000 + i, schedules[i % 22].canonicalGroup).run();
    const input = { id: 'a'.repeat(64), date, generation: 1, observations: [], manifest: Object.fromEntries(schedules.map(s => [s.canonicalGroup, s.hash])) };
    await beginDataset(store, input);
    for (let i = 0; i < schedules.length; i += 3) await stageSchedules(store, input.id, schedules.slice(i, i + 3));
    const post = () => mf.dispatchFetch('http://localhost/test-finish', { method: 'POST', headers: { authorization: 'Bearer local-test' }, body: JSON.stringify({ id: input.id }) });
    const started = Date.now();
    assert.equal((await post()).status, 200);
    const activationMs = Date.now() - started;
    const activationRecipients = new Set(sends).size;
    if (!baseline && recipients === 60) assert.equal(activationRecipients, 60, 'Every card must arrive in the activation pump, without Cron');
    // Include follow-up pin operations in both cost measurements. On a slow
    // runner those can use normal Cron recovery after all cards have arrived.
    for (let i = 0; i < 8; i++) {
      const pending = await db.prepare("SELECT (SELECT COUNT(*) FROM jobs WHERE status='pending')+(SELECT COUNT(*) FROM fanout WHERE status='pending') n").first();
      if (!pending.n) break;
      await mf.dispatchFetch('http://localhost/test-cron');
    }
    assert.equal(new Set(sends).size, recipients);
    assert.equal(sends.length, recipients);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='pending'").first()).n, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM fanout WHERE status='pending'").first()).n, 0);
    if (!baseline) {
      assert.equal(lanes.filter(p => p === '/fanout').length, Math.ceil(recipients/24));
      assert.ok(!lanes.includes('/tick/fanout'), 'activation must call the fanout lane directly');
    }
    const invocations = lanes.length;
    assert.equal((await post()).status, 200);
    assert.equal(sends.length, recipients);
    assert.equal(lanes.length, invocations);
    const physical = async () => (await mf.dispatchFetch('http://localhost/test-cost')).json();
    const d1 = async () => (await mf.dispatchFetch('http://localhost/test-d1-meta')).json();
    const difference = (after, before) => Object.fromEntries(Object.entries(after).map(([key, n]) => [key, n - before[key]]));
    console.log(JSON.stringify({ scenario: 'new-publication', recipients, rowsWritten: await physical(), baseline: Boolean(baseline), telegramDelay, activationMs, activationRecipients, elapsedMs: Date.now() - started, httpInvocations: invocations, sends: sends.length,
      d1: await d1(), budget: await db.prepare('SELECT requests,rows_read,rows_written FROM budgets').first() }));
    if (process.env.PERSONAL_MEASURE_DUE) {
      // Force one visible edit per user without depending on the host's lesson times.
      await db.prepare("UPDATE cards SET parts=json_set(parts,'$[0].hash','outdated')").run();
      await db.prepare("UPDATE users SET next_due=0,last_api_at=0").run();
      const budget = () => db.prepare('SELECT requests,rows_read,rows_written FROM budgets').first();
      const before = await budget(), beforeD1 = await d1(), writesBefore = await physical(), offset = lanes.length, dueStarted = Date.now();
      await mf.dispatchFetch('http://localhost/test-cron');
      const firstPass = new Set(edits).size;
      for (let i = 0; i < 6 && new Set(edits).size < recipients; i++) await mf.dispatchFetch('http://localhost/test-cron');
      assert.equal(new Set(edits).size, recipients);
      assert.equal(edits.length, recipients);
      assert.equal(sends.length, recipients);
      assert.equal((await db.prepare("SELECT count(*) n FROM jobs WHERE status='pending'").first()).n, 0);
      assert.equal((await db.prepare("SELECT count(*) n FROM users WHERE next_due=0").first()).n, 0);
      const after = await budget();
      console.log(JSON.stringify({ scenario: 'due-card-edits', recipients, rowsWritten: await physical()-writesBefore, baseline: Boolean(baseline), firstPass, elapsedMs: Date.now() - dueStarted,
        firstMs: editTimes[0]-dueStarted, p95Ms: editTimes[Math.ceil(recipients*0.95)-1]-dueStarted, lastMs: editTimes.at(-1)-dueStarted,
        httpInvocations: lanes.length - offset, d1: difference(await d1(), beforeD1), budget: difference(after, before) }));
      const route = (path, body={}) => mf.dispatchFetch('http://localhost/'+path,{ method:'POST',
        headers:{authorization:'Bearer local-test'}, body:JSON.stringify(body) });
      const idle = async () => {
        const tick = await (await route('tick')).json();
        assert.deepEqual([tick.inbox,tick.fanout,tick.due,tick.delivery,tick.recover],[0,0,0,0,false]);
      };
      await idle();
      const idleBefore = await physical();
      for (let i=0;i<10;i++) await idle();
      console.log(JSON.stringify({scenario:'ten-idle-ticks', rowsWritten:await physical()-idleBefore}));
      for (const size of [16, 17, 100]) {
        const future = Date.now() + 3600000;
        const jobs = Array.from({ length: size }, (_, i) => db.prepare(
          "INSERT INTO jobs(id,user_id,epoch,kind,priority,due) VALUES(?,8888,1,'card',2,?)"
        ).bind('idle-probe-' + i, future));
        await db.batch(jobs);
        await idle();
        const startWrites = await physical(), startBudget = await budget();
        for (let i = 0; i < 5; i++) await idle();
        console.log(JSON.stringify({ scenario: 'five-idle-ticks', size, rowsWritten: await physical() - startWrites,
          budgetReads: (await budget()).rows_read - startBudget.rows_read }));
        await db.prepare("DELETE FROM jobs WHERE id GLOB 'idle-probe-*'").run();
      }
      const tap = i => route('test-inbox',{update_id:i,userId:8888,action:'settings',messageId:77,acknowledged:true});
      assert.equal((await tap(1)).status,200);
      const tapBefore = await d1(), tapTimes = [];
      for (let i=2;i<=7;i++) {
        const start = performance.now();
        assert.equal((await tap(i)).status,200);
        tapTimes.push(performance.now() - start);
      }
      assert.equal(await db.prepare("SELECT COUNT(*) n FROM inbox WHERE user_id=8888 AND status='done'").first('n'),7);
      const sorted = [...tapTimes].sort((a, b) => a - b);
      console.log(JSON.stringify({scenario:'six-repeat-taps', d1: difference(await d1(), tapBefore),
        p50Ms: sorted[2], p95Ms: sorted.at(-1), elapsedMs: tapTimes.reduce((sum, ms) => sum + ms, 0)}));

      const far = Date.now() + 3600000;
      await db.batch(Array.from({ length: 350 }, (_, i) => db.prepare(
        "INSERT INTO jobs(id,user_id,epoch,kind,priority,due) VALUES(?,8888,1,'card',?,?)"
      ).bind('router-probe-' + i, i === 349 ? 99 : 2, far)));
      const routerBefore = await d1();
      const router = await route('tick/delivery');
      assert.equal(router.status, 200);
      assert.equal((await router.json()).pending, false);
      console.log(JSON.stringify({ scenario: 'delivery-router-with-future-work', d1: difference(await d1(), routerBefore) }));
      await db.prepare("DELETE FROM jobs WHERE id GLOB 'router-probe-*'").run();

      await db.prepare("UPDATE users SET blocked=1 WHERE user_id=8888").run();
      await db.prepare("INSERT INTO jobs(id,user_id,epoch,kind,priority,due) VALUES('blocked-probe',8888,1,'card',3,0)").run();
      const blockedBefore = await d1(), blockedOffset = lanes.length;
      await mf.dispatchFetch('http://localhost/test-cron');
      assert.equal(await db.prepare("SELECT status FROM jobs WHERE id='blocked-probe'").first('status'), 'pending');
      console.log(JSON.stringify({ scenario: 'blocked-only-cron', d1: difference(await d1(), blockedBefore),
        httpInvocations: lanes.length - blockedOffset }));
      await db.prepare("DELETE FROM jobs WHERE id='blocked-probe'").run();
    }
    // Concurrent fanout pumps are serialized in D1, including revision allocation.
    await db.prepare("UPDATE fanout SET status='pending',cursor=0").run();
    const before = new PersonalStore(db), after = new PersonalStore(db);
    await Promise.all([fanoutBatch(before), fanoutBatch(after)]);
    for (let i=2;i<Math.ceil(recipients/24);i++) await fanoutBatch(after);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='card'").first()).n, recipients);
    assert.equal((await db.prepare("SELECT COUNT(DISTINCT revision) n FROM jobs WHERE kind='card'").first()).n, recipients);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM fanout WHERE status='pending'").first()).n, 0);
    console.log(JSON.stringify({ scenario: 'concurrent-publication-enqueue', rowsWritten: before.written + after.written, rowsRead: before.read + after.read }));
    // Worst cursor overhead: a new recipient in each of 24 different groups.
    // This must stay within the existing admission reservation, even without
    // the savings that several subscribers in one group normally provide.
    await db.prepare('UPDATE users SET paused=1').run();
    const nextDate = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const sparse = await Promise.all(Array.from({ length: 24 }, (_, i) => sampleSchedule(`${i + 1}ТМ`, nextDate)));
    for (let i = 0; i < sparse.length; i++) await db.prepare('INSERT INTO users(user_id,group_id) VALUES(?,?)').bind(4000 + i, sparse[i].canonicalGroup).run();
    const sparseInput = { id: 'b'.repeat(64), date: nextDate, generation: 2, observations: [], manifest: Object.fromEntries(sparse.map(s => [s.canonicalGroup, s.hash])) };
    await beginDataset(store, sparseInput);
    for (let i = 0; i < sparse.length; i += 3) await stageSchedules(store, sparseInput.id, sparse.slice(i, i + 3));
    await finishDataset(store, sparseInput.id);
    const measured = new PersonalStore(db);
    await fanoutBatch(measured);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM jobs WHERE date=?').bind(nextDate).first()).n, 24);
    assert.ok(measured.written + 3 <= 200, `Publication batch exceeded admission reserve: ${measured.written}`);
    console.log(JSON.stringify({ scenario: '24-groups-reservation-boundary', rowsWritten: measured.written, reservation: 200 }));
  } finally { await mf.dispose(); }
});
