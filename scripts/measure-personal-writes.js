// Local synthetic D1 only. Never connects to Cloudflare or Telegram.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { PersonalStore as CurrentStore } from '../src/personal/store.js';
import { deliverUser as currentDeliver, enqueueDue as currentDue } from '../src/personal/delivery.js';
import { renderPersonal as currentRender } from '../src/personal/view.js';
import { sampleSchedule, installSchedules } from '../tests/helpers/personal-fixture.js';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { build } from 'esbuild';

let { PersonalStore, deliverUser, enqueueDue, renderPersonal } = {
  PersonalStore: CurrentStore, deliverUser: currentDeliver, enqueueDue: currentDue, renderPersonal: currentRender,
};
// An optional earlier local commit makes the comparison repeatable without
// changing either checkout or touching any remote service.
const baseline = process.argv[3];
if (baseline) {
  if (!/^[a-f0-9]{7,40}$/u.test(baseline)) throw Error('Expected a hexadecimal local commit ID');
  const result=await build({stdin:{contents:"export {PersonalStore} from './src/personal/store.js'; export {deliverUser,enqueueDue} from './src/personal/delivery.js'; export {renderPersonal} from './src/personal/view.js';",resolveDir:process.cwd()},
    bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'baseline',setup(b){b.onLoad({filter:/[\\/]src[\\/]personal[\\/](store|delivery|view)\.js$/},args=>({
      contents:execFileSync('git',['show',`${baseline}:${relative(process.cwd(),args.path).replaceAll('\\','/')}`],{encoding:'utf8'}),loader:'js',
    }));}}]});
  ({ PersonalStore, deliverUser, enqueueDue, renderPersonal }=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64')));
}

const names = ['idle', 'unchanged', 'lesson-end-with-tomorrow', 'new-single', 'new-multipart', 'subject-change', 'metadata-only'];
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("local benchmark")}}',
  compatibilityDate: '2026-09-14', d1Databases: Object.fromEntries(names.map((_, i) => ['DB'+i, 'cost-'+i])) }));
const output = [];
try {
  for (const [i, name] of names.entries()) {
    const raw = await mf.getD1Database('DB'+i);
    for (const file of (await readdir('personal/migrations')).filter(f=>f.endsWith('.sql')).sort()) {
      const sql = (await readFile('personal/migrations/'+file, 'utf8')).replace(/--[^\n]*/gu, '').replace(/;\s*END;/gi, '__TRIGGER_END__;');
      for (const s of sql.split(';').map(s=>s.replaceAll('__TRIGGER_END__', '; END;')).filter(s=>s.trim())) await raw.prepare(s).run();
    }
    const counts = { rowsWritten: 0, sqlWrites: 0, jobUpserts: 0, invocations: 0, telegram: [], writesByTable: {} };
    let measuring = false;
    const measured = (sql, r) => {
      if (measuring) { counts.rowsWritten += r.meta?.rows_written ?? 0; if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) counts.sqlWrites++;
        if (sql.startsWith('INSERT INTO jobs(')) counts.jobUpserts++;
        const table=sql.match(/^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM) (\w+)/iu)?.[1];
        if(table) counts.writesByTable[table]=(counts.writesByTable[table]??0)+(r.meta?.rows_written??0); }
      return r;
    };
    const db = { prepare(sql) { const s=raw.prepare(sql); return {sql, s, bind(...args){this.s=this.s.bind(...args);return this;},
      async all(){return measured(sql,await this.s.all());},async run(){return measured(sql,await this.s.run());} }; },
      async batch(ss){const rr=await raw.batch(ss.map(s=>s.s));return rr.map((r,j)=>measured(ss[j].sql,r));} };
    let store = new PersonalStore(db);
    const at = new Date('2026-11-12T08:59:00+03:00');
    const today = await sampleSchedule(), tomorrow = await sampleSchedule('8Са','2026-11-13');
    if(name==='new-multipart') { today.timeline.find(e=>e.number===1).variants[0].subject = today.lessons[0].variants[0].subject = '<&>'.repeat(800); today.hash='b'.repeat(64); }
    await installSchedules(store,[today]); await installSchedules(store,[tomorrow],{id:'c'.repeat(64)});
    await store.run("INSERT INTO users(user_id,group_id,pin_message_id,pin_date,next_due) VALUES(100,?,88,?,?)",today.canonicalGroup,today.date,Date.parse('2026-11-12T09:00:00+03:00'));
    const user=await store.user(100);
    if(name.startsWith('new-')) await store.run('UPDATE users SET pin_message_id=NULL,pin_date=NULL WHERE user_id=100');
    if (!name.startsWith('new-') && name!=='idle') {
      for(const s of [today,tomorrow]) {
        const before=structuredClone(s);
        if(name==='subject-change' && s===today) { before.hash='d'.repeat(64); before.lessons[0].variants[0].subject=before.timeline.find(e=>e.number===1).variants[0].subject='OLD'; }
        if(name==='metadata-only' && s===today) before.hash='e'.repeat(64);
        const rendered=renderPersonal(before,user,{now:at});
        const parts=rendered.parts.map((text,j)=>({id:(s===today?88:99)+j,hash:createHash('sha256').update(JSON.stringify([text,j?{inline_keyboard:[]}:rendered.keyboard])).digest('hex')}));
        await store.run('INSERT INTO cards(user_id,group_id,date,parts,schedule_hash,schedule_payload) VALUES(?,?,?,?,?,?)',100,s.canonicalGroup,s.date,JSON.stringify(parts),before.hash,JSON.stringify(before));
      }
    }
    const now = name==='lesson-end-with-tomorrow' ? new Date('2026-11-12T09:00:00+03:00') : at;
    if(name!=='idle' && name!=='lesson-end-with-tomorrow') await store.enqueue(user,'card',today.date,{due:now.getTime()});
    measuring=true;
    const invoke = async (time, action, router=false) => { counts.invocations++; store=new PersonalStore(db); await store.budget(new Date(time),1,{router,userWork:!router});
      const realNow=Date.now; Date.now=()=>time;
      try { await action(store); } finally { Date.now=realNow; }
      await store.flushBudget(new Date(time)); };
    if(name==='idle') await invoke(now.getTime(),s=>s.first("SELECT 1 FROM jobs WHERE status='pending' AND due<=? LIMIT 1",now.getTime()),true);
    if(name==='lesson-end-with-tomorrow') await invoke(now.getTime(),s=>enqueueDue(s,now.getTime()),true);
    let time=now.getTime(),turns=0;
    const client={async call(method,body){counts.telegram.push(method);return method==='sendMessage'?{message_id:1000+counts.telegram.length}:true;}};
    while(true) {
      const job=await raw.prepare("SELECT due FROM jobs WHERE status='pending' ORDER BY due LIMIT 1").first();
      if(!job) break;
      time=Math.max(time+2000,job.due);
      await invoke(time,s=>deliverUser(s,client,100,{now:new Date(time)}));
      if(++turns>40) throw Error('Queue did not converge: '+name);
    }
    output.push({scenario:name,...counts});
  }
  console.log(JSON.stringify(output,null,2));
  if(process.argv[2]) await writeFile(process.argv[2],JSON.stringify(output,null,2)+'\n');
} finally {await mf.dispose();}
