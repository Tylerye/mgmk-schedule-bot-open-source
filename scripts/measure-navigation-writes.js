// Local D1 + Telegram stub; repeated real inbox/navigation flows, no network.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {relative} from 'node:path';
import {PersonalStore as Store} from '../src/personal/store.js';
import {enqueuePersonalUpdate as enqueue,processPersonalInbox as processInbox} from '../src/personal/inbox.js';
import {deliverUser as deliver} from '../src/personal/delivery.js';
let runtime={PersonalStore:Store,enqueuePersonalUpdate:enqueue,processPersonalInbox:processInbox,deliverUser:deliver};
const ref=process.argv[3];
if(ref){if(!/^[a-f0-9]{7,40}$/u.test(ref))throw Error('Expected local commit ID');
 const b=await build({stdin:{contents:"export{PersonalStore}from'./src/personal/store.js';export{enqueuePersonalUpdate,processPersonalInbox}from'./src/personal/inbox.js';export{deliverUser}from'./src/personal/delivery.js';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'baseline',setup(b){b.onLoad({filter:/[\\/]src[\\/]personal[\\/].*\.js$/},args=>({contents:execFileSync('git',['show',`${ref}:${relative(process.cwd(),args.path).replaceAll('\\','/')}`],{encoding:'utf8'}),loader:'js'}));}}]});
 runtime=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
}
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default{fetch(){return new Response("local")}}',compatibilityDate:'2026-09-14',d1Databases:{DB:'navigation-measure'}}));
try{
 const raw=await mf.getD1Database('DB');for(const f of(await readdir('personal/migrations')).filter(f=>f.endsWith('.sql')).sort())
 for(const sql of(await readFile('personal/migrations/'+f,'utf8')).replace(/--[^\n]*/gu,'').replace(/;\s*END;/gi,'__TRIGGER_END__;').split(';').map(s=>s.replaceAll('__TRIGGER_END__','; END;')).filter(s=>s.trim()))await raw.prepare(sql).run();
 await raw.prepare('INSERT INTO users(user_id) VALUES(100)').run();
 let measuring=false,rowsWritten=0,invocations=0;const telegram=[];
 const record=r=>{if(measuring)rowsWritten+=r.meta?.rows_written??0;return r};
 const statement=(sql,args=[])=>{const s=raw.prepare(sql).bind(...args);return{raw:s,bind(...a){return statement(sql,a)},async all(){return record(await s.all())},async run(){return record(await s.run())}}};
 const db={prepare:statement,async batch(ss){return(await raw.batch(ss.map(s=>s.raw))).map(record)}};
 let time=Date.parse('2026-11-12T07:00:00+03:00');
 const invoke=async fn=>{invocations++;const store=new runtime.PersonalStore(db);await store.budget(new Date(time),1,{userWork:true});await fn(store);await store.flushBudget(new Date(time));};
 const client={async call(method){if(measuring)telegram.push(method);return true}};
 for(let id=0;id<7;id++){
  if(id===1){measuring=true;invocations=0;}
  time+=2000;
  await invoke(async s=>runtime.enqueuePersonalUpdate(s,{update_id:id+1,userId:100,action:'settings',messageId:77,callbackId:'cb'+id},time));
  await invoke(async s=>runtime.processPersonalInbox(s,await s.first('SELECT * FROM inbox WHERE update_id=?',id+1),new Date(time)));
  for(let i=0;i<10;i++){
   const job=await raw.prepare("SELECT due FROM jobs WHERE status='pending' ORDER BY due LIMIT 1").first();if(!job)break;
   time=Math.max(time+2000,job.due);await invoke(s=>runtime.deliverUser(s,client,100,{now:new Date(time)}));
   if(i===9)throw Error('Queue did not converge');
  }
 }
 const jobs=await raw.prepare('SELECT kind,status,COUNT(*) n FROM jobs GROUP BY kind,status').all();
 const result={scenario:'six repeated settings clicks after warmup',rowsWritten,invocations,telegram,jobs:jobs.results};console.log(JSON.stringify(result,null,2));if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(result,null,2)+'\n');
}finally{await mf.dispose();}
