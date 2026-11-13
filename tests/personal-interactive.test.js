import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { sampleSchedule } from './helpers/personal-fixture.js';
import { dateInTimezone } from '../src/dates.js';
import { relayPersonalUpdate } from '../cloudflare/personal-relay.js';

test('a real D1 trigger admits a tap and delivers its timetable without Cron or other users', async () => {
  const script = (await build({entryPoints:['personal/worker.js'],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:crypto']})).outputFiles[0].text;
  const lanes=[], calls=[];
  const mf=new Miniflare(convertV4MiniflareOptions({name:'personal',modules:true,script,compatibilityDate:'2026-09-14',compatibilityFlags:['nodejs_compat'],
    d1Databases:{DB:'interactive'},bindings:{PERSONAL_SHARED_SECRET:'local-test',ADMIN_USER_ID:'100',BOT_TOKEN:'fake',PERSONAL_PUBLIC:'true',
      PERSONAL_DAILY_WRITES:'45000',PERSONAL_BACKGROUND_WRITES:'30000',PERSONAL_SOURCE_WRITES:'35000'},
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
    // The actual relay returns the spinner acknowledgement to Telegram while
    // only the visible screen is queued. Automatic work cannot eat this reserve.
    await db.prepare('UPDATE budgets SET rows_written=31000').run();
    await db.prepare("INSERT INTO jobs(id,user_id,epoch,kind,date,priority,due,payload) VALUES('auto-owner',100,1,'card',?,-10,0,'{}')").bind(date).run();
    const reply=await relayPersonalUpdate({PERSONAL_ENABLED:'true',ADMIN_USER_ID:'100',PERSONAL_SHARED_SECRET:'local-test',PERSONAL:{fetch:(url,options)=>mf.dispatchFetch('http://localhost/inbox',options)}},
      {update_id:2,callback_query:{id:'cb2',from:{id:100},data:'personal:today',message:{message_id:77,chat:{id:100,type:'private'}}}});
    assert.deepEqual(await reply.json(),{method:'answerCallbackQuery',callback_query_id:'cb2'});
    for(let i=0;i<100 && calls.length<3;i++) await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(calls.length,3);assert.equal(calls[2].method,'editMessageText');
    assert.equal((await db.prepare("SELECT COUNT(*) total FROM jobs WHERE kind='callback'").first()).total,1,'no second callback job');
    assert.equal((await db.prepare("SELECT status FROM jobs WHERE id='auto-owner'").first()).status,'pending');
    assert.equal((await db.prepare("SELECT status FROM jobs WHERE id='other'").first()).status,'pending');
    const route=path=>mf.dispatchFetch('http://localhost'+path,{method:'POST',headers:{authorization:'Bearer local-test'},body:'{}'});
    const tick=await (await route('/tick')).json();assert.equal(tick.delivery,0);assert.equal(tick.fanout,0);assert.equal(tick.due,0);
    assert.equal((await (await route('/tick/fanout')).json()).stopped,true);
    // Cron can still resume manual work left by a transient Telegram limit.
    await db.prepare("INSERT INTO jobs(id,user_id,epoch,kind,date,priority,due,payload) VALUES('manual-retry',200,1,'reply','retry',0,0,?)").bind(JSON.stringify({text:'manual retry',manual:true})).run();
    for(let i=0;i<20 && calls.length<4;i++) {await new Promise(resolve=>setTimeout(resolve,100));await route('/tick/delivery');}
    assert.equal(calls.length,4);assert.equal(calls[3].body.text,'manual retry');
    assert.equal((await db.prepare("SELECT status FROM jobs WHERE id='other'").first()).status,'pending');
    await db.prepare('UPDATE budgets SET rows_written=36000').run();
    assert.equal((await route('/source-status')).status,503,'uncommitted upload cannot be acknowledged as successful');
  } finally {await mf.dispose();}
});
