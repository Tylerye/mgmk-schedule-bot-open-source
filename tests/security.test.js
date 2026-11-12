import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { sqliteAdapter } from '../src/attention-local.js';
import { readJson } from '../cloudflare/request-json.js';
import { queueParserResult } from '../cloudflare/parser-results.js';
import { createLogger } from '../src/logger.js';
import { EMPTY_STATE } from '../src/state-shape.js';

let cachedWorker;
async function worker() {
  if (!cachedWorker) {
    const bundle = await build({ entryPoints: ['cloudflare/worker.js'], bundle: true, write: false, format: 'esm', platform: 'node', external: ['node:crypto'] });
    cachedWorker = (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)).default;
  }
  return cachedWorker;
}
const request = (path, body, headers = {}) => new Request(`https://worker.test${path}`, { method: 'POST', headers, body });
const context = { waitUntil() { assert.fail('invalid input must not start background work'); } };

test('JSON ingress bounds actual UTF-8 bytes, rejects primitives and never trusts content-length', async () => {
  assert.deepEqual(await readJson(request('/', '{"ok":true}'), 64), { ok: true });
  for (const body of ['null', '[]', 'true', '"text"', '{invalid']) await assert.rejects(readJson(request('/', body), 64), error => error.status === 400);
  for (const headers of [{}, { 'content-length': '1' }, { 'content-length': '200' }]) await assert.rejects(readJson(request('/', '{"x":"' + 'ю'.repeat(40) + '"}', headers), 64), error => error.status === 413);
});

test('stalled request stream has a bounded deadline and is cancelled', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const req = new Request('https://worker.test/', { method: 'POST', body, duplex: 'half' });
  await assert.rejects(readJson(req, 64, 10), error => error.status === 408);
  assert.equal(cancelled, true);
});

test('webhook and internal routes fail closed without configured secrets before touching DB', async () => {
  const w = await worker();
  const DB = { prepare() { assert.fail('unauthorized requests must not touch database'); } };
  for (const secret of [undefined, null, '']) {
    assert.equal((await w.fetch(request('/telegram/webhook', '{}'), { DB, TELEGRAM_WEBHOOK_SECRET: secret }, context)).status, 403);
    assert.equal((await w.fetch(request('/internal/state/import', '{}'), { DB, PARSER_SHARED_SECRET: secret }, context)).status, 404);
    assert.equal((await w.fetch(request('/internal/jobs/x/result', '{}'), { DB, PARSER_SHARED_SECRET: secret }, context)).status, 403);
    assert.equal((await w.fetch(request('/internal/maintenance/live', '{}'), { DB, PARSER_SHARED_SECRET: secret }, context)).status, 403);
  }
  assert.equal((await w.fetch(request('/telegram/webhook', '{}', { 'x-telegram-bot-api-secret-token': 'wrong' }), { DB, TELEGRAM_WEBHOOK_SECRET: 'right' }, context)).status, 403);
  assert.equal((await w.fetch(request('/internal/maintenance/live', '{}', { authorization: 'Bearer wrong' }), { DB, PARSER_SHARED_SECRET: 'right' }, context)).status, 403);
  assert.equal((await w.fetch(request('/internal/maintenance/all', '{}', { authorization: 'Bearer right' }), { DB, PARSER_SHARED_SECRET: 'right' }, context)).status, 403);
});

test('authenticated malformed/oversized webhook input is rejected before database access', async () => {
  const w = await worker(); const env = { DB: { prepare() { assert.fail('invalid body must not touch database'); } }, TELEGRAM_WEBHOOK_SECRET: 'right' };
  const headers = { 'x-telegram-bot-api-secret-token': 'right' };
  for (const body of ['null', '[]', '{invalid']) assert.equal((await w.fetch(request('/telegram/webhook', body, headers), env, context)).status, 400);
  assert.equal((await w.fetch(request('/telegram/webhook', '{"x":"' + 'a'.repeat(256 * 1024) + '"}', headers), env, context)).status, 413);
});

test('HTTP import is removed for every method and credential without database access', async () => {
 const w=await worker(); const DB={prepare(){assert.fail('must not access DB');}};
 for(const method of ['GET','POST','PUT','DELETE']) {
  const r=await w.fetch(new Request('https://worker.test/internal/state/import',{method,headers:{authorization:'Bearer right'}}),{DB,PARSER_SHARED_SECRET:'right'},context);
  assert.equal(r.status,404);
 }
});

test('public liveness performs no database or background work', async () => {
 const w=await worker(); const DB={prepare(){assert.fail('public liveness must not access DB');}};
 const r=await w.fetch(new Request('https://worker.test/healthz'),{DB,TEACHERS_ENABLED:'true'},context);
 assert.equal(r.status,200);assert.deepEqual(await r.json(),{alive:true});
});

test('detailed health rejects unauthorized requests before database access', async () => {
 const w=await worker();const DB={prepare(){assert.fail('unauthorized DB access');}};
 for(const headers of [{},{authorization:'Bearer wrong'}]) assert.equal((await w.fetch(new Request('https://worker.test/internal/health',{headers}),{DB,HEALTH_READ_SECRET:'right'},context)).status,403);
});

test('readiness detects a stopped personal service without exposing its diagnostics', async () => {
 const w=await worker(); const state=structuredClone(EMPTY_STATE);
 const DB={prepare(){return {async first(){return {json:JSON.stringify(state)};}};}};
 let calls=0;
 const env={DB,HEALTH_READ_SECRET:'right',PERSONAL_ENABLED:'true',PERSONAL_SHARED_SECRET:'private-test',PERSONAL:{async fetch(url,options){calls++;assert.equal(options.method,'POST');return new Response(JSON.stringify({ok:true,stopped:true,diagnostics:'INTERNAL TEST DETAIL'}));}}};
 const response=await w.fetch(new Request('https://worker.test/internal/health',{headers:{authorization:'Bearer right'}}),env,context);
 assert.equal(response.status,503);const result=await response.json();assert.deepEqual(result.personal,{enabled:true,ok:false});assert.equal(JSON.stringify(result).includes('INTERNAL TEST DETAIL'),false);assert.equal(calls,1);
});

test('parser rejects malformed and oversized schedules without writing poisoned inbox entries', async () => {
  const db = new DatabaseSync(':memory:'); db.exec(await readFile('migrations/0003_parser_results.sql', 'utf8'));
  const DB = sqliteAdapter(db); const job = { id: 'job', schedule_date: '2026-10-05', source_id: 'source' };
  try {
    for (const payload of [null, [], {}, { document: { id: 'source' }, schedule: { date: job.schedule_date, lessons: {} } },
      { document: { id: 'source' }, schedule: { date: job.schedule_date, lessons: Array(65).fill({}) } },
      { document: { id: 'source' }, schedule: { date: job.schedule_date, lessons: [], timeline: {} } }]) assert.equal(await queueParserResult(DB, job, payload), false);
    assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM parser_results').first()).n, 0);
  } finally { db.close(); }
});

test('authenticated health omits exception details and disables caching', async () => {
  const w = await worker();
  const state = { ...structuredClone(EMPTY_STATE), health: { lastError: { at: 'now', event: 'source_poll', message: 'SECRET EXCEPTION' } } };
  const DB = { prepare() { return { async first() { return { json: JSON.stringify(state) }; } }; } };
  const response = await w.fetch(new Request('https://worker.test/internal/health', { headers: { authorization: 'Bearer right' } }), { DB, HEALTH_READ_SECRET: 'right' }, context);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await response.json()).lastError, { at: 'now', event: 'source_poll' });
});

test('health detects stalled work even when the last saved error is null', async () => {
  const w = await worker();
  const state = { ...structuredClone(EMPTY_STATE), chatId: '-1001', health: { lastError: null,
    lastSourcePollSuccessAt: new Date(Date.now() - 600000).toISOString(), lastReconcileSuccessAt: new Date().toISOString() } };
  const DB = { prepare() { return { async first() { return { json: JSON.stringify(state) }; } }; } };
  let health = await (await w.fetch(new Request('https://worker.test/internal/health', { headers: { authorization: 'Bearer right' } }), { DB, HEALTH_READ_SECRET: 'right' }, context)).json();
  assert.equal(health.ok, false); assert.equal(health.stale, true);
  state.health.lastSourcePollSuccessAt = new Date().toISOString();
  state.health.lastQueuesSuccessAt = new Date().toISOString();
  state.health.lastAttentionSuccessAt = new Date().toISOString();
  health = await (await w.fetch(new Request('https://worker.test/internal/health', { headers: { authorization: 'Bearer right' } }), { DB, HEALTH_READ_SECRET: 'right' }, context)).json();
  assert.equal(health.ok, true); assert.equal(health.stale, false);
});

test('logger redacts nested credentials and Telegram URL tokens while retaining useful error fields', () => {
  const original = console.log; let output;
  console.log = text => { output = text; };
  try {
    createLogger().warn('test', { botToken: 'SECRET-A', nested: { authorization: 'SECRET-B' },
      error: 'https://api.telegram.org/bot123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/getMe Bearer SECRET-C', code: 429 });
    assert.ok(!/SECRET|ABCDEFGHIJKLMNOPQRSTUVWXYZ/.test(output));
    assert.equal(JSON.parse(output).code, 429);
    assert.equal(JSON.parse(output).message, 'test');
  } finally { console.log = original; }
});
