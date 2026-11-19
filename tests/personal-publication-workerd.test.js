import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { PersonalStore } from '../src/personal/store.js';
import { beginDataset, stageSchedules, finishDataset, fanoutBatch } from '../src/personal/ingest.js';
import { sampleSchedule } from './helpers/personal-fixture.js';

test('workerd immediately delivers a new publication across 22 groups without Cron or duplicate finish sends', async () => {
  const baseline = process.env.PERSONAL_MEASURE_REF;
  if (baseline) assert.match(baseline, /^[a-f0-9]{7,40}$/u);
  const script = (await build({ stdin: { contents: `import worker from './personal/worker.js';
    export default {async fetch(request,env,ctx){
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
      b.onLoad({ filter: /[\\/](?:personal[\\/]worker|src[\\/]personal[\\/](?:ingest|store|delivery))\.js$/ }, args => {
        const path = args.path.slice(process.cwd().length + 1).replaceAll('\\', '/');
        return { contents: execFileSync('git', ['-c', `safe.directory=${process.cwd()}`, 'show', `${baseline}:${path}`], { encoding: 'utf8' }), loader: 'js' };
      });
    } }] : [] })).outputFiles[0].text;
  const lanes = [], sends = [], edits = [];
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
      if (new URL(request.url).pathname.endsWith('/editMessageText')) edits.push(body.chat_id);
      return new Response(JSON.stringify({ ok: true, result: { message_id: sends.length } }), { headers: { 'content-type': 'application/json' } });
    } }));
  try {
    const db = await mf.getD1Database('DB');
    for (const file of (await readdir('personal/migrations')).filter(f => f.endsWith('.sql')).sort())
      for (const sql of (await readFile('personal/migrations/' + file, 'utf8')).replace(/--[^\n]*/gu, '').replace(/;\s*END;/gi, '__TRIGGER_END__;').split(';').map(s => s.replaceAll('__TRIGGER_END__', '; END;')).filter(s => s.trim())) await db.prepare(sql).run();
    const store = new PersonalStore(db);
    const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const schedules = await Promise.all(Array.from({ length: 22 }, (_, i) => sampleSchedule(`${i + 1}ТМ`, date)));
    for (let i = 0; i < 60; i++) await db.prepare('INSERT INTO users(user_id,group_id) VALUES(?,?)').bind(1000 + i, schedules[i % 22].canonicalGroup).run();
    const input = { id: 'a'.repeat(64), date, generation: 1, observations: [], manifest: Object.fromEntries(schedules.map(s => [s.canonicalGroup, s.hash])) };
    await beginDataset(store, input);
    for (let i = 0; i < schedules.length; i += 3) await stageSchedules(store, input.id, schedules.slice(i, i + 3));
    const post = () => mf.dispatchFetch('http://localhost/test-finish', { method: 'POST', headers: { authorization: 'Bearer local-test' }, body: JSON.stringify({ id: input.id }) });
    const started = Date.now();
    assert.equal((await post()).status, 200);
    const activationMs = Date.now() - started;
    const activationRecipients = new Set(sends).size;
    if (!baseline) assert.equal(activationRecipients, 60, 'Every card must arrive in the activation pump, without Cron');
    // Include follow-up pin operations in both cost measurements. On a slow
    // runner those can use normal Cron recovery after all cards have arrived.
    for (let i = 0; i < 8; i++) {
      const pending = await db.prepare("SELECT (SELECT COUNT(*) FROM jobs WHERE status='pending')+(SELECT COUNT(*) FROM fanout WHERE status='pending') n").first();
      if (!pending.n) break;
      await mf.dispatchFetch('http://localhost/test-cron');
    }
    assert.equal(new Set(sends).size, 60);
    assert.equal(sends.length, 60);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='pending'").first()).n, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM fanout WHERE status='pending'").first()).n, 0);
    if (!baseline) {
      assert.equal(lanes.filter(p => p === '/fanout').length, 3);
      assert.ok(!lanes.includes('/tick/fanout'), 'activation must call the fanout lane directly');
    }
    const invocations = lanes.length;
    assert.equal((await post()).status, 200);
    assert.equal(sends.length, 60);
    assert.equal(lanes.length, invocations);
    console.log(JSON.stringify({ scenario: 'new-publication-60-users-22-groups', baseline: Boolean(baseline), telegramDelay, activationMs, activationRecipients, elapsedMs: Date.now() - started, httpInvocations: invocations, sends: sends.length,
      budget: await db.prepare('SELECT requests,rows_read,rows_written FROM budgets').first() }));
    if (process.env.PERSONAL_MEASURE_DUE) {
      // Force one visible edit per user without depending on the host's lesson times.
      await db.prepare("UPDATE cards SET parts=json_set(parts,'$[0].hash','outdated')").run();
      await db.prepare("UPDATE users SET next_due=0,last_api_at=0").run();
      const budget = () => db.prepare('SELECT requests,rows_read,rows_written FROM budgets').first();
      const before = await budget(), offset = lanes.length, dueStarted = Date.now();
      await mf.dispatchFetch('http://localhost/test-cron');
      const firstPass = new Set(edits).size;
      for (let i = 0; i < 6 && new Set(edits).size < 60; i++) await mf.dispatchFetch('http://localhost/test-cron');
      assert.equal(new Set(edits).size, 60);
      assert.equal(edits.length, 60);
      assert.equal(sends.length, 60);
      assert.equal((await db.prepare("SELECT count(*) n FROM jobs WHERE status='pending'").first()).n, 0);
      assert.equal((await db.prepare("SELECT count(*) n FROM users WHERE next_due=0").first()).n, 0);
      const after = await budget();
      console.log(JSON.stringify({ scenario: 'due-60-card-edits', baseline: Boolean(baseline), firstPass, elapsedMs: Date.now() - dueStarted,
        httpInvocations: lanes.length - offset, budget: Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - before[key]])) }));
    }
    // Concurrent fanout pumps are serialized in D1, including revision allocation.
    await db.prepare("UPDATE fanout SET status='pending',cursor=0").run();
    const before = new PersonalStore(db), after = new PersonalStore(db);
    await Promise.all([fanoutBatch(before), fanoutBatch(after)]);
    await fanoutBatch(after);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='card'").first()).n, 60);
    assert.equal((await db.prepare("SELECT COUNT(DISTINCT revision) n FROM jobs WHERE kind='card'").first()).n, 60);
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
