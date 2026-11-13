import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

test('workerd keeps independent HTTP lanes and skips empty inbox waves while draining multipart replies',async()=>{
  // Optional comparison against an explicitly selected local commit; no remote
  // access or production data. Normal CI always exercises the current source.
  const baseline=process.env.PERSONAL_MEASURE_REF;
  if(baseline) assert.match(baseline,/^[a-f0-9]{7,40}$/u);
  const script=(await build({stdin:{contents:`import worker from './personal/worker.js';
    export default {async fetch(request,env,ctx){
      if(new URL(request.url).pathname==='/test-cron') {
        const pending=[];await worker.scheduled({},env,{waitUntil(p){pending.push(p)}});await Promise.all(pending);return new Response('ok');
      }
      return worker.fetch(request,env,ctx);
    }};`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'neutral',external:['node:crypto'],
    plugins:baseline?[{name:'baseline-worker',setup(b){b.onLoad({filter:/[\\/]personal[\\/]worker\.js$/},()=>({contents:execFileSync('git',['show',`${baseline}:personal/worker.js`],{encoding:'utf8'}),loader:'js'}));}}]:[]})).outputFiles[0].text;
  const lanes=[],telegram=[];
  const mf=new Miniflare(convertV4MiniflareOptions({name:'personal',modules:true,script,compatibilityDate:'2026-09-14',compatibilityFlags:['nodejs_compat'],
    d1Databases:{DB:'lanes-db'}, bindings:{PERSONAL_SHARED_SECRET:'local-test',ADMIN_USER_ID:'100',BOT_TOKEN:'fake',PERSONAL_DELIVERY_ENABLED:'true',PERSONAL_PUBLIC:'true'},
    serviceBindings:{SELF:async(request,runtime)=>{lanes.push(new URL(request.url).pathname);return (await runtime.getWorker('personal')).fetch(request);}},
    outboundService:async request=>{
      assert.equal(new URL(request.url).hostname,'api.telegram.org');telegram.push(new URL(request.url).pathname.split('/').at(-1));
      return new Response(JSON.stringify({ok:true,result:{message_id:telegram.length}}),{headers:{'content-type':'application/json'}});
    }}));
  try {
    const db=await mf.getD1Database('DB');
    for(const file of (await readdir('personal/migrations')).filter(f=>f.endsWith('.sql')).sort()) {
      for(const sql of (await readFile('personal/migrations/'+file,'utf8')).replace(/--[^\n]*/gu,'').replace(/;\s*END;/gi,'__TRIGGER_END__;').split(';').map(s=>s.replaceAll('__TRIGGER_END__','; END;')).filter(s=>s.trim())) await db.prepare(sql).run();
    }
    await db.prepare('INSERT INTO users(user_id) VALUES(100)').run();
    await db.prepare("INSERT INTO jobs(id,user_id,epoch,kind,date,priority,due,payload) VALUES('reply',100,1,'reply','one',0,0,?)")
      .bind(JSON.stringify({texts:['first','second']})).run();
    assert.equal((await mf.dispatchFetch('http://localhost/test-cron')).status,200);
    assert.deepEqual(telegram,['sendMessage','sendMessage']);
    assert.deepEqual(lanes,baseline?['/tick','/tick/inbox','/tick/delivery','/delivery/100','/tick/inbox','/tick/delivery','/delivery/100']:
      ['/tick','/tick/delivery','/delivery/100','/tick/delivery','/delivery/100']);
    console.log(JSON.stringify({scenario:'multipart-reply-http',baseline:Boolean(baseline),httpInvocations:lanes.length,telegramCalls:telegram.length}));
    assert.equal((await db.prepare("SELECT status FROM jobs WHERE id='reply'").first()).status,'done');
    // A truly empty minute only needs the work probe.
    lanes.length=0;
    assert.equal((await mf.dispatchFetch('http://localhost/test-cron')).status,200);
    assert.deepEqual(lanes,['/tick']);
    if(!baseline) {
      // All four independent users must drain without duplicate sends. D1
      // completion order can differ under CI load, so a rate-gate loser may
      // correctly need the next bounded wave rather than this first wave.
      await db.prepare("UPDATE rate_gate SET next_at=0 WHERE key='telegram'").run();
      for(const id of [201,202,203,204]) {
        await db.prepare('INSERT INTO users(user_id) VALUES(?)').bind(id).run();
        await db.prepare("INSERT INTO jobs(id,user_id,epoch,kind,date,priority,due,payload) VALUES(?,?,1,'reply','burst',0,0,?)").bind('burst'+id,id,JSON.stringify({text:'burst'})).run();
      }
      telegram.length=0;
      const response=await mf.dispatchFetch('http://localhost/tick/delivery',{method:'POST',headers:{authorization:'Bearer local-test'}});
      assert.equal(response.status,200);
      if((await response.json()).pending) assert.equal((await mf.dispatchFetch('http://localhost/test-cron')).status,200);
      assert.deepEqual(telegram,['sendMessage','sendMessage','sendMessage','sendMessage']);
      assert.equal((await db.prepare("SELECT COUNT(*) count FROM jobs WHERE id LIKE 'burst%' AND status='pending'").first()).count,0);
    }
  } finally {await mf.dispose();}
});
