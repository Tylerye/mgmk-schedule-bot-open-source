import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { sqliteAdapter } from '../src/attention-local.js';
import { withStateLock } from '../cloudflare/d1-store.js';
import { personalFixture } from './helpers/personal-fixture.js';
import { enqueuePersonalUpdate, processPersonalInbox } from '../src/personal/inbox.js';
import { deliverUser } from '../src/personal/delivery.js';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';

test('source lease also remembers completed ticks across ordinary calls and expired owners', async t=>{
  const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
  sqlite.exec('CREATE TABLE runtime_locks(name TEXT PRIMARY KEY,owner TEXT NOT NULL,locked_until INTEGER NOT NULL)');
  const db=sqliteAdapter(sqlite);let count=0;
  const run=interval=>withStateLock(db,async()=>{count++;},{name:'source',interval});
  const pair=await Promise.all([run(10),run(10)]);
  assert.equal(pair.filter(r=>r.acquired).length,1);assert.equal(count,1);
  assert.equal((await run(10)).acquired,false,'completed tick cannot replay');
  await withStateLock(db,async()=>{}, {name:'source'});
  assert.equal((await run(10)).acquired,false,'ordinary calls retain the tick marker');
  assert.equal((await run(11)).acquired,true);
  await assert.rejects(withStateLock(db,async()=>{throw Error('crash')},{name:'source',interval:12}),/crash/u);
  assert.equal((await run(12)).acquired,false,'failed tick resumes next minute, never blind same-tick retry');
  assert.equal((await run(13)).acquired,true);
  sqlite.prepare("UPDATE runtime_locks SET locked_until=? WHERE name='source'").run(Date.now()+60000);
  assert.equal((await run(14)).acquired,false,'new tick cannot overlap a running old tick');
  sqlite.prepare("UPDATE runtime_locks SET locked_until=0 WHERE name='source'").run();
  assert.equal((await run(14)).acquired,true);
  await withStateLock(db,async()=>{
    sqlite.prepare("UPDATE runtime_locks SET owner=?,locked_until=99 WHERE name='source'").run(JSON.stringify({token:'replacement',interval:99}));
  },{name:'source',interval:15});
  assert.equal(sqlite.prepare("SELECT locked_until FROM runtime_locks WHERE name='source'").get().locked_until,99,'old finally cannot release replacement');
  sqlite.prepare("INSERT INTO runtime_locks VALUES('maintenance-admission:teacher-source','maintenance',20)").run();
  assert.equal((await withStateLock(db,async()=>assert.fail('legacy replay'),{name:'teacher-source',interval:20})).acquired,false);
  assert.equal((await withStateLock(db,async()=>{}, {name:'teacher-source',interval:21})).acquired,true);
});

test('unchanged standalone tap finishes inbox without revising jobs; newer tap supersedes pending old navigation',async t=>{
  const f=await personalFixture();t.after(()=>f.close());
  await f.store.run('INSERT INTO users(user_id) VALUES(100)');
  const at=new Date('2026-11-13T07:00:00+03:00');let id=0;
  const input=async(action,options={})=>{
    const update={update_id:++id,userId:100,action,messageId:77,acknowledged:true,...options};
    await enqueuePersonalUpdate(f.store,update,at.getTime());
    return processPersonalInbox(f.store,await f.store.first('SELECT * FROM inbox WHERE update_id=?',id),at);
  };
  const calls=[],client={async call(method){calls.push(method);return true;}};
  await input('settings');await deliverUser(f.store,client,100,{now:at});
  const before=await f.store.first('SELECT value FROM job_revision_sequence');
  await input('settings');
  assert.equal((await f.store.first('SELECT value FROM job_revision_sequence')).value,before.value);
  assert.equal((await f.store.first('SELECT status FROM inbox WHERE update_id=?',id)).status,'done');
  assert.equal((await f.store.first('SELECT payload FROM inbox WHERE update_id=?',id)).payload,'{}');
  await input('help');assert.equal((await f.store.first("SELECT COUNT(*) n FROM jobs WHERE status='pending'")).n,1);
  await input('settings');assert.equal((await f.store.first("SELECT COUNT(*) n FROM jobs WHERE status='pending'")).n,0);
  assert.equal(calls.length,1);
  await f.store.setSetting('auto-pin:100',false);await input('settings');
  assert.equal((await f.store.first("SELECT COUNT(*) n FROM jobs WHERE status='pending'")).n,1,'fresh preferences invalidate screen equality');
  await f.store.run("UPDATE jobs SET status='done'");
  await input('settings',{acknowledged:false,callbackId:'needs-ack'});
  assert.equal((await f.store.first("SELECT COUNT(*) n FROM jobs WHERE kind='callback' AND status='pending'")).n,1);
});

test('owner preview and automatic cards cannot use the early standalone shortcut',async t=>{
  const f=await personalFixture();t.after(()=>f.close());await f.store.run('INSERT INTO users(user_id) VALUES(100)');
  const now=new Date('2026-11-13T07:00:00+03:00');
  const input=async(id,ownerId)=>{await enqueuePersonalUpdate(f.store,{update_id:id,userId:100,action:'settings',messageId:77,acknowledged:true});await processPersonalInbox(f.store,await f.store.first('SELECT * FROM inbox WHERE update_id=?',id),now,{ownerId});};
  await input(1);await deliverUser(f.store,{async call(){return true}},100,{now});
  await input(2,100);assert.equal((await f.store.first("SELECT COUNT(*) n FROM jobs WHERE status='pending'")).n,1);
  await f.store.run("UPDATE jobs SET status='done'");
  await f.store.run("INSERT INTO cards(user_id,group_id,date,parts) VALUES(100,'1А','2026-11-13','[{\"id\":77}]')");
  await input(3);assert.equal((await f.store.first("SELECT COUNT(*) n FROM jobs WHERE status='pending'")).n,1);
});

test('workerd repeat tap has no delivery invocation and fresh preferences still edit',async()=>{
  const script=(await build({entryPoints:['personal/worker.js'],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:crypto']})).outputFiles[0].text;
  const lanes=[],calls=[];
  const mf=new Miniflare(convertV4MiniflareOptions({name:'repeat-screen',modules:true,script,compatibilityDate:'2026-09-14',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'repeat-screen'},
    bindings:{PERSONAL_SHARED_SECRET:'local',ADMIN_USER_ID:'100',BOT_TOKEN:'fake',PERSONAL_PUBLIC:'true'},
    serviceBindings:{SELF:async(req,runtime)=>{lanes.push(new URL(req.url).pathname);return(await runtime.getWorker('repeat-screen')).fetch(req);}},
    outboundService:async req=>{assert.equal(new URL(req.url).hostname,'api.telegram.org');calls.push(await req.json());return Response.json({ok:true,result:true});}}));
  try{
    const db=await mf.getD1Database('DB');
    for(const f of(await readdir('personal/migrations')).filter(f=>f.endsWith('.sql')).sort())for(const sql of(await readFile('personal/migrations/'+f,'utf8')).replace(/--[^\n]*/gu,'').replace(/;\s*END;/gi,'__END__;').split(';').map(s=>s.replaceAll('__END__','; END;')).filter(s=>s.trim()))await db.prepare(sql).run();
    const post=id=>mf.dispatchFetch('http://localhost/inbox',{method:'POST',headers:{authorization:'Bearer local'},body:JSON.stringify({update_id:id,userId:200,action:'settings',messageId:77,callbackId:'cb'+id,acknowledged:true})});
    assert.equal((await post(1)).status,200);
    for(let i=0;i<100;i++){if(await db.prepare("SELECT 1 FROM settings WHERE key='screen-v1:200:77'").first())break;await new Promise(r=>setTimeout(r,50));}
    assert.ok(await db.prepare("SELECT 1 FROM settings WHERE key='screen-v1:200:77'").first());
    const revision=(await db.prepare('SELECT value FROM job_revision_sequence').first()).value;
    lanes.length=0;assert.equal((await post(2)).status,200);
    assert.deepEqual(lanes,['/inbox/2']);assert.equal(calls.length,1);
    assert.equal((await db.prepare('SELECT value FROM job_revision_sequence').first()).value,revision);
    assert.equal((await db.prepare('SELECT status FROM inbox WHERE update_id=2').first()).status,'done');
    await db.prepare('UPDATE users SET sound=0 WHERE user_id=200').run();
    assert.equal((await post(3)).status,200);
    for(let i=0;i<100 && calls.length<2;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(calls.length,2);assert.notDeepEqual(calls[0].reply_markup,calls[1].reply_markup);
    assert.ok(lanes.includes('/delivery/200'));
  }finally{await mf.dispose();}
});
