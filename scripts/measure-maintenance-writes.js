// Synthetic workerd/D1 benchmark. All external services are local stubs.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {relative} from 'node:path';
import {EMPTY_STATE} from '../src/state-shape.js';
import {TEACHER_ACCOUNTS} from '../cloudflare/teachers.js';
const ref=process.argv[3];
if(ref&&!/^[a-f0-9]{7,40}$/u.test(ref))throw Error('Expected local commit ID');
const wrapper=`import worker from './cloudflare/worker.js';
const RealDate=Date;let clock=Date.parse('2026-11-12T07:00:00+03:00');
globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}};
let counts;
function dbProxy(db){const record=(sql,r)=>{counts.rowsWritten+=r.meta?.rows_written??0;counts.rowsRead+=r.meta?.rows_read??0;counts.queries++;return r;};
 const statement=(sql,args=[])=>{const raw=db.prepare(sql).bind(...args);return{raw,sql,bind(...a){return statement(sql,a)},async all(){return record(sql,await raw.all())},async run(){return record(sql,await raw.run())},async first(col){const r=record(sql,await raw.all()),row=r.results[0]??null;return col?row?.[col]??null:row;}};};
 return{prepare:statement,async batch(ss){return(await db.batch(ss.map(s=>s.raw))).map((r,i)=>record(ss[i].sql,r));}};
}
export default{async fetch(req,env,ctx){
 if(new URL(req.url).pathname==='/measure'){clock+=60000;counts={rowsWritten:0,rowsRead:0,queries:0};const pending=[];
 await worker.scheduled({cron:'* * * * *'},env,{waitUntil(p){pending.push(p)}});await Promise.all(pending);return Response.json(counts);}
 return worker.fetch(req,{...env,DB:dbProxy(env.DB)},ctx);
}};`;
const bundle=(await build({stdin:{contents:wrapper,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'neutral',external:['node:crypto'],
 plugins:ref?[{name:'baseline',setup(b){b.onLoad({filter:/[\\/](cloudflare|src)[\\/].*\.js$/},args=>({contents:execFileSync('git',['show',`${ref}:${relative(process.cwd(),args.path).replaceAll('\\','/')}`],{encoding:'utf8'}),loader:'js'}));}}]:[]})).outputFiles[0].text;
let telegram=0,lanes=0,drive=0;
const mf=new Miniflare(convertV4MiniflareOptions({name:'measure',modules:true,script:bundle,compatibilityDate:'2026-09-14',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],d1Databases:{DB:'maintenance-measure'},
 bindings:{WORKER_PUBLIC_ORIGIN:'https://worker.measure-fixture.net',MAINTENANCE_SIGNING_SECRET:'x'.repeat(32),HEALTH_READ_SECRET:'health-test',BOT_TOKEN:'123456789:fake',PARSER_SHARED_SECRET:'local-test',TEACHERS_ENABLED:'true',OWNER_PREVIEW_ENABLED:'true',PERSONAL_ENABLED:'true',ADMIN_USER_ID:'100',LOG_LEVEL:'error'},
 outboundService:async request=>{const u=new URL(request.url);if(u.pathname.startsWith('/internal/maintenance/')){lanes++;return mf.dispatchFetch(request.url,{method:request.method,headers:request.headers});}
 if(u.hostname==='drive.google.com'){drive++;return new Response('data-id="abcdefghijklmnopqrstuv" data-tooltip="01.01.20 учащихся.pdf PDF"');}
 if(u.hostname==='api.telegram.org'){telegram++;return Response.json({ok:true,result:u.pathname.endsWith('getChatMember')?{status:'administrator',can_pin_messages:true}:{id:123456789,message_id:55}});}
 throw Error('Unexpected outbound host');}}));
try{
 const db=await mf.getD1Database('DB');
 for(const file of(await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())
 for(const sql of(await readFile('migrations/'+file,'utf8')).replace(/--[^\n]*/gu,'').replace(/;\s*END;/gi,'__TRIGGER_END__;').split(';').map(s=>s.replaceAll('__TRIGGER_END__','; END;')).filter(s=>s.trim()))await db.prepare(sql).run();
 const state=structuredClone(EMPTY_STATE);state.chatId='-300';
 await db.prepare('INSERT INTO app_state VALUES(1,?,?)').bind(JSON.stringify(state),'2026-11-12T04:00:00Z').run();
 await db.prepare("INSERT INTO attention_settings VALUES('setup:v1:-300','done')").run();
 await db.prepare("INSERT INTO teacher_settings VALUES('month:ноябрь 26','synthetic-month')").run();
 for(const [i,teacher]of TEACHER_ACCOUNTS.entries())await db.prepare('INSERT INTO teacher_users(teacher_id,user_id,enrolled_at) VALUES(?,?,?)').bind(teacher.id,teacher.sourceTeacherId?100:101+i,'2026-11-12T04:00:00Z').run();
 {const r=await mf.dispatchFetch('http://localhost/measure');if(!r.ok)throw Error((await r.text()).slice(0,1200));} // Warm-up excluded.
 telegram=0;lanes=0;drive=0;
 const minutes=[];for(let i=0;i<9;i++){const r=await mf.dispatchFetch('http://localhost/measure');if(!r.ok)throw Error((await r.text()).slice(0,1200));minutes.push(await r.json());}
 const result={minutes,totals:minutes.reduce((a,r)=>({rowsWritten:a.rowsWritten+r.rowsWritten,rowsRead:a.rowsRead+r.rowsRead,queries:a.queries+r.queries}),{rowsWritten:0,rowsRead:0,queries:0}),httpLanes:lanes,telegram,drive};
 console.log(JSON.stringify(result,null,2));if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(result,null,2)+'\n');
}finally{await mf.dispose();}
