import test from 'node:test';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {EMPTY_STATE} from '../src/state-shape.js';
test('workerd executes all four independently authenticated maintenance lanes', async () => {
const bundle=await build({stdin:{contents:`import worker from './cloudflare/worker.js';export default {async fetch(request,env,ctx){if(new URL(request.url).pathname!=='/test-tick')return worker.fetch(request,env,ctx);const p=[];await env.DB.prepare("DELETE FROM runtime_locks WHERE name LIKE 'maintenance-admission:%'").run();await worker.scheduled({cron:'* * * * *',scheduledTime:Date.parse('2026-11-13T09:00:00+03:00')},env,{waitUntil(task){p.push(task)}});await Promise.all(p);return new Response('ok')}}`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'neutral',external:['node:crypto']});
const paths=[];
const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'bot',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-14',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],d1Databases:['DB'],bindings:{WORKER_PUBLIC_ORIGIN:"https://worker.audit-fixture.net", MAINTENANCE_SIGNING_SECRET:"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", HEALTH_READ_SECRET:"health-test",BOT_TOKEN:'123456789:fake',PARSER_SHARED_SECRET:'private',LOG_LEVEL:'error'},outboundService:async request=>{
  const u=new URL(request.url);paths.push(u.pathname);
  if(u.pathname.startsWith('/internal/maintenance/'))return mf.dispatchFetch(request.url,{method:request.method,headers:request.headers});
  if(u.hostname==='api.telegram.org')return new Response(JSON.stringify({ok:true,result:request.url.endsWith('getChatMember')?{status:'administrator',can_pin_messages:true}:{id:123456789,message_id:55}}));
  if(u.hostname==='drive.google.com')return new Response('data-id="abcdefghijklmnopqrstuv" data-tooltip="01.01.20 учащихся.pdf PDF"');
  throw Error('unexpected outbound host '+u.hostname);
}}]}));
try{
  const db=await mf.getD1Database('DB');
  for(const file of fs.readdirSync('migrations').filter(f=>f.endsWith('.sql'))){const sql=fs.readFileSync('migrations/'+file,'utf8').replace(/--[^\n]*/g,'');for(const statement of sql.replace(/;\s*END;/gi,'__TRIGGER_END__;').split(';').map(s=>s.replaceAll('__TRIGGER_END__','; END;')).filter(s=>s.trim()))await db.prepare(statement).run()}
  const state=structuredClone(EMPTY_STATE);state.chatId='-300';
  await db.prepare('INSERT INTO app_state(id,json,updated_at)VALUES(1,?,?)').bind(JSON.stringify(state),new Date().toISOString()).run();
  await db.prepare("INSERT INTO attention_settings(key,value)VALUES('setup:v1:-300','done')").run();
  assert.equal((await mf.dispatchFetch('http://localhost/test-tick')).status,200);
  const health=await(await mf.dispatchFetch('http://localhost/internal/health',{headers:{authorization:'Bearer health-test'}})).json();
  assert.equal(health.ok,true);
  assert.equal(paths.filter(p=>p.startsWith('/internal/maintenance/')).length,4);
  console.log(JSON.stringify({runtime:'workerd',lanes:paths.filter(p=>p.startsWith('/internal/maintenance/')),health}));
}finally{await mf.dispose()}
});
