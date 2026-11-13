import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { sampleSchedule } from './helpers/personal-fixture.js';
import { dateInTimezone } from '../src/dates.js';

test('a real D1 trigger admits a tap and delivers its timetable without Cron or other users', async () => {
  const script = (await build({entryPoints:['personal/worker.js'],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:crypto']})).outputFiles[0].text;
  const lanes=[], calls=[];
  const mf=new Miniflare(convertV4MiniflareOptions({name:'personal',modules:true,script,compatibilityDate:'2026-09-14',compatibilityFlags:['nodejs_compat'],
    d1Databases:{DB:'interactive'},bindings:{PERSONAL_SHARED_SECRET:'local-test',ADMIN_USER_ID:'100',BOT_TOKEN:'fake',PERSONAL_PUBLIC:'true'},
    serviceBindings:{SELF:async(request,runtime)=>{lanes.push(new URL(request.url).pathname);return (await runtime.getWorker('personal')).fetch(request);}},
    outboundService:async request=>{calls.push({method:new URL(request.url).pathname.split('/').at(-1),body:await request.json()});
      return new Response(JSON.stringify({ok:true,result:{message_id:700}}),{headers:{'content-type':'application/json'}});}}));
  try {
    const db=await mf.getD1Database('DB');
    for(const file of (await readdir('personal/migrations')).filter(f=>f.endsWith('.sql')).sort())
      for(const sql of (await readFile('personal/migrations/'+file,'utf8')).replace(/--[^\n]*/gu,'').replace(/;\s*END;/gi,'__TRIGGER_END__;').split(';').map(s=>s.replaceAll('__TRIGGER_END__','; END;')).filter(s=>s.trim())) await db.prepare(sql).run();
    const date=dateInTimezone(new Date(),'Europe/Minsk'), schedule=await sampleSchedule('8Са',date);
    await db.prepare("INSERT INTO users(user_id,group_id) VALUES(100,'8СА'),(200,'8СА')").run();
    await db.prepare("INSERT INTO datasets(id,date,generation,manifest,expected_count,status) VALUES('today',?,1,'{}',1,'ready')").bind(date).run();
    await db.prepare("INSERT INTO active_versions(date,dataset_id,generation) VALUES(?,'today',1)").bind(date).run();
    await db.prepare("INSERT INTO snapshots(dataset_id,group_id,hash,payload) VALUES('today','8СА',?,?)").bind(schedule.hash,JSON.stringify(schedule)).run();
    await db.prepare("INSERT INTO jobs(id,user_id,epoch,kind,date,priority,due,payload) VALUES('other',200,1,'reply','other',-5,0,?)").bind(JSON.stringify({text:'other user'})).run();
    const post=body=>mf.dispatchFetch('http://localhost/inbox',{method:'POST',headers:{authorization:'Bearer local-test'},body:JSON.stringify(body)});
    const update={update_id:1,userId:100,action:'schedule',messageId:77,callbackId:'cb1'};
    const response=await post(update);assert.equal(response.status,200);
    assert.equal((await db.prepare('SELECT status FROM inbox WHERE update_id=1').first()).status,'done');
    // waitUntil must finish the visible reply and acknowledgement, without Cron.
    for(let i=0;i<100 && calls.length<2;i++) await new Promise(resolve=>setTimeout(resolve,50));
    assert.deepEqual(calls.map(c=>c.method),['editMessageText','answerCallbackQuery']);
    assert.match(calls[0].body.text,/МАТЕМАТИКА|Учебный день завершён/u);
    assert.equal(calls[0].body.chat_id,100);
    assert.equal((await db.prepare("SELECT status FROM jobs WHERE id='other'").first()).status,'pending');
    assert.ok(lanes.includes('/inbox/1'));assert.ok(lanes.includes('/delivery/100'));
    assert.ok(!lanes.includes('/tick/delivery'));
    assert.equal((await (await post(update)).json()).queued,false);
    assert.equal(calls.length,2,'duplicate update must not send again');
  } finally {await mf.dispose();}
});
