import test from 'node:test';
import assert from 'node:assert/strict';
import {maintenanceHeaders,verifyMaintenance} from '../cloudflare/maintenance-auth.js';
import {boundedBytes} from '../src/source/bounded.js';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {sqliteAdapter} from '../src/attention-local.js';
import {admitInteractive} from '../cloudflare/ingress-admission.js';
import {validGroupResult} from '../cloudflare/result-schema.js';
const env={WORKER_PUBLIC_ORIGIN:'https://worker.audit-fixture.net',MAINTENANCE_SIGNING_SECRET:'x'.repeat(32)};
test('maintenance signature is bound to origin, method, body, lane and time; no credential is sent',async()=>{
 const path='/internal/maintenance/live',now=Date.now(),headers=await maintenanceHeaders(env,path,now);
 assert.equal(JSON.stringify(headers).includes(env.MAINTENANCE_SIGNING_SECRET),false);
 assert.equal(await verifyMaintenance(new Request(env.WORKER_PUBLIC_ORIGIN+path,{method:'POST',headers}),env,now),true);
 for(const [url,opt,at]of [[env.WORKER_PUBLIC_ORIGIN+path,{method:'GET',headers},now],[env.WORKER_PUBLIC_ORIGIN+'/internal/maintenance/source',{method:'POST',headers},now],['https://other.audit-fixture.net'+path,{method:'POST',headers},now],[env.WORKER_PUBLIC_ORIGIN+path,{method:'POST',headers,body:'x'},now],[env.WORKER_PUBLIC_ORIGIN+path,{method:'POST',headers},now+60001]])assert.equal(await verifyMaintenance(new Request(url,opt),env,at),false);
});
test('source limits actual bytes as well as declared length',async()=>{
 assert.deepEqual(await boundedBytes(new Response('abc'),3),new TextEncoder().encode('abc'));
 await assert.rejects(boundedBytes(new Response('abcd'),3),/limit/);
 await assert.rejects(boundedBytes(new Response('x',{headers:{'content-length':'99'}}),3),/limit/);
});
test('durable ingress rejects excess per-user actions while another user proceeds',async()=>{
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(await readFile('migrations/0001_initial.sql','utf8'));const DB=sqliteAdapter(sqlite);try{
 const env={DB,INTERACTIVE_BURST_LIMIT:2};assert.equal(await admitInteractive(env,101,100000),true);assert.equal(await admitInteractive(env,101,100001),true);assert.equal(await admitInteractive(env,101,100002),false);assert.equal(await admitInteractive(env,102,100003),true);assert.equal(await admitInteractive(env,101,110001),true);
 }finally{sqlite.close();}
});
test('security migrations preserve populated app state and add storage guards',async()=>{
 const db=new DatabaseSync(':memory:');try{
 for(const name of ['0001_initial.sql','0002_webhook_inbox.sql','0008_teachers.sql'])db.exec(await readFile('migrations/'+name,'utf8'));
 db.prepare('INSERT INTO app_state VALUES(1,?,?)').run(JSON.stringify({chatId:'-100',pinnedSchedule:{messageId:7}}),'now');
 const before=db.prepare('SELECT json FROM app_state').get().json;db.exec(await readFile('migrations/0009_security_limits.sql','utf8'));assert.equal(db.prepare('SELECT json FROM app_state').get().json,before);
 const personal=new DatabaseSync(':memory:');try{personal.exec(await readFile('personal/migrations/0001_personal.sql','utf8'));personal.exec(await readFile('personal/migrations/0002_security_limits.sql','utf8'));assert.ok(personal.prepare("SELECT name FROM sqlite_master WHERE name='security_interactive_queue'").get());}finally{personal.close();}
 }finally{db.close();}
});
test('group parser rejects malformed hashes, times, oversized strings and invalid lesson numbers',()=>{
 const s={date:'2026-11-12',hash:'a'.repeat(64),lessons:[]};assert.equal(validGroupResult(s),true);
 for(const value of [{...s,hash:'bad'},{...s,lessons:[{number:0}]},{...s,notes:['x'.repeat(3001)]},{...s,timeline:[{start:'99:00',end:'99:30'}]}])assert.equal(validGroupResult(value),false);
});

test('concurrent budget reservations cannot both cross the write ceiling',async()=>{
 const {personalFixture}=await import('./helpers/personal-fixture.js');const {PersonalStore}=await import('../src/personal/store.js');const f=await personalFixture();try{const now=new Date('2026-11-12T12:00:00Z');await f.store.run('INSERT INTO budgets(day,requests,rows_read,rows_written) VALUES(?,0,0,26700)','2026-11-12');const a=new PersonalStore(f.db),b=new PersonalStore(f.db);const results=await Promise.all([a.budget(now),b.budget(now)]);assert.equal(results.filter(r=>r.mode==='stopped').length,1);assert.equal((await f.store.first('SELECT rows_written FROM budgets')).rows_written,26900);}finally{f.close();}
});
