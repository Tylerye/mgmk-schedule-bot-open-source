import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {sqliteAdapter} from '../src/attention-local.js';
import {patchHealth,withStateLock} from '../cloudflare/d1-store.js';
import {teacherMaintenance,writeTeacherStatus} from '../cloudflare/teachers.js';
import {TEACHERS} from '../src/teachers.js';
import {EMPTY_STATE} from '../src/state-shape.js';
import {personalFixture} from './helpers/personal-fixture.js';
import {enqueuePersonalUpdate,processPersonalInbox} from '../src/personal/inbox.js';
import {deliverUser} from '../src/personal/delivery.js';

async function mainFixture(t){const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());for(const f of(await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(await readFile('migrations/'+f,'utf8'));const DB=sqliteAdapter(sqlite);await DB.prepare('INSERT INTO app_state VALUES(1,?,?)').bind(JSON.stringify(EMPTY_STATE),'2026-11-12T04:00:00Z').run();return{sqlite,DB};}
const at=time=>new Date(`2026-11-12T${time}:00+03:00`);
test('heartbeats coalesce per lane, preserve immediate failures/recovery and become stale without new checks',async t=>{
 const {DB}=await mainFixture(t);
 const save=async(time,error=null)=>patchHealth(DB,{lastSourcePollSuccessAt:at(time).toISOString(),lastCronCompletedAt:at(time).toISOString(),sourceError:error},{heartbeatKey:'lastSourcePollSuccessAt',now:at(time)});
 await save('07:00');await save('07:01');
 let state=JSON.parse((await DB.prepare('SELECT json FROM app_state').first()).json);assert.equal(state.health.lastSourcePollSuccessAt,at('07:00').toISOString());
 await patchHealth(DB,{lastQueuesSuccessAt:at('07:01').toISOString(),queuesError:null},{heartbeatKey:'lastQueuesSuccessAt',now:at('07:01')});
 const error={event:'source',at:at('07:01').toISOString()};await save('07:01',error);
 state=JSON.parse((await DB.prepare('SELECT json FROM app_state').first()).json);assert.deepEqual(state.health.sourceError,error);assert.equal(state.health.lastQueuesSuccessAt,at('07:01').toISOString());
 await save('07:02');state=JSON.parse((await DB.prepare('SELECT json FROM app_state').first()).json);assert.equal(state.health.sourceError,undefined);assert.equal(state.health.lastSourcePollSuccessAt,at('07:02').toISOString());
 await save('07:05');state=JSON.parse((await DB.prepare('SELECT json FROM app_state').first()).json);assert.equal(state.health.lastSourcePollSuccessAt,at('07:05').toISOString());
 assert.ok(at('07:11').getTime()-Date.parse(state.health.lastSourcePollSuccessAt)>300000);
 await writeTeacherStatus(DB,'health:teacher-test',{error:false},at('07:00'));await writeTeacherStatus(DB,'health:teacher-test',{error:false},at('07:01'));
 assert.equal(JSON.parse((await DB.prepare("SELECT value FROM teacher_settings WHERE key='health:teacher-test'").first()).value).at,at('07:00').toISOString());
 await writeTeacherStatus(DB,'health:teacher-test',{error:true},at('07:01'));assert.equal(JSON.parse((await DB.prepare("SELECT value FROM teacher_settings WHERE key='health:teacher-test'").first()).value).error,true);
});
test('persistent fixed-name leases exclude overlap and old owners cannot release a new owner',async t=>{
 const {DB}=await mainFixture(t);let ran=false;
 await withStateLock(DB,async()=>{assert.equal((await withStateLock(DB,async()=>{ran=true},{name:'teacher:test'})).acquired,false);},{name:'teacher:test'});
 assert.equal(ran,false);assert.equal((await DB.prepare("SELECT locked_until FROM runtime_locks WHERE name='teacher:test'").first()).locked_until,0);
 await withStateLock(DB,async()=>{await DB.prepare("UPDATE runtime_locks SET owner='new-owner',locked_until=? WHERE name='teacher:test'").bind(Date.now()+60000).run();},{name:'teacher:test'});
 assert.equal((await DB.prepare("SELECT owner FROM runtime_locks WHERE name='teacher:test'").first()).owner,'new-owner');
});
test('teacher deadlines skip idle writes but wake on commands, source corrections, lesson starts/ends and pin boundary',async t=>{
 const {DB,sqlite}=await mainFixture(t);const env={DB,ADMIN_USER_ID:'100',OWNER_PREVIEW_ENABLED:'true',PERSONAL_ENABLED:'true'};
 const teacherId=TEACHERS[0].id;
 const config={timezone:'Europe/Minsk',pinSwitchTime:'16:00'},calls=[],logger={info(){},warn(){}};
 let sequence=88;
 const client={async sendMessage(){calls.push('send');return{message_id:sequence++}},async editMessage(){calls.push('edit')},async pinMessage(){calls.push('pin')},async unpinOwnMessage(){calls.push('unpin')},async answerCallbackQuery(){calls.push('ack')}};
 await DB.prepare("INSERT INTO teacher_users(teacher_id,user_id,enrolled_at) VALUES(?,101,'local')").bind(teacherId).run();
 const schedule={teacherId,date:'2026-11-12',hash:'a'.repeat(64),status:'',lessons:[{number:1,start:'08:15',end:'09:00',group:'1А'}]};
 const seed=async s=>DB.prepare('INSERT OR REPLACE INTO teacher_schedules VALUES(?,?,?,?,?)').bind(s.teacherId,s.date,s.hash,JSON.stringify(s),'local').run();await seed(schedule);
 let claims=0,allowed=true;
 const admit=async()=>{claims++;return allowed;};
 const tick=time=>teacherMaintenance(env,config,logger,teacherId,at(time),client,admit);
 await tick('07:00');calls.length=0;assert.equal(claims,1);
 sqlite.exec('CREATE TABLE lease_writes(n INTEGER); CREATE TRIGGER watch_lease AFTER UPDATE ON runtime_locks BEGIN INSERT INTO lease_writes VALUES(1); END;');
 assert.equal((await tick('07:01')).idle,true);assert.equal(claims,1,'idle probe does not write minute admission');assert.equal((await DB.prepare('SELECT COUNT(*) n FROM lease_writes').first()).n,0);
 allowed=false;assert.equal((await tick('08:15')).duplicate,true);assert.equal(calls.length,0,'rejected admission cannot execute live edits');
 allowed=true;await tick('08:15');assert.ok(calls.includes('edit'));calls.length=0;await tick('09:00');assert.ok(calls.includes('edit'));
 await seed({...schedule,hash:'b'.repeat(64),lessons:[{...schedule.lessons[0],group:'2Б'}]});calls.length=0;await tick('09:01');assert.ok(calls.includes('edit'));
 await DB.prepare("INSERT INTO teacher_inbox(update_id,teacher_id,payload) VALUES(1,?,?)").bind(teacherId,JSON.stringify({teacherId,userId:101,action:'today',callbackId:'cb',messageId:88})).run();calls.length=0;await tick('09:02');assert.ok(calls.includes('ack'));
 await seed({...schedule,date:'2026-11-13',hash:'c'.repeat(64)});await tick('09:03');calls.length=0;await tick('16:00');assert.ok(calls.includes('pin'));
});
test('repeated language choice preserves epoch and only completed command scopes are deduplicated',async t=>{
 const f=await personalFixture();t.after(()=>f.close());await f.store.run("INSERT INTO users(user_id,language,epoch) VALUES(100,'ru',4)");
 for(const code of ['','ru','en'])await f.store.setSetting(`commands-v1:100:${code}`,'ru');
 await enqueuePersonalUpdate(f.store,{update_id:1,userId:100,action:'lang:ru',messageId:77,acknowledged:true});await processPersonalInbox(f.store,await f.store.first('SELECT * FROM inbox WHERE update_id=1'),at('07:00'));
 assert.equal((await f.store.user(100)).epoch,4);assert.equal((await f.store.first("SELECT COUNT(*) n FROM jobs WHERE kind='commands' AND status='pending'")).n,0);
 await enqueuePersonalUpdate(f.store,{update_id:2,userId:100,action:'lang:en',messageId:77,acknowledged:true});await processPersonalInbox(f.store,await f.store.first('SELECT * FROM inbox WHERE update_id=2'),at('07:01'));
 assert.equal((await f.store.user(100)).epoch,5);assert.equal((await f.store.first("SELECT COUNT(*) n FROM jobs WHERE kind='commands' AND status='pending'")).n,3);
});
test('standalone repeated screens skip edits while cards remain outside the screen cache',async t=>{
 const f=await personalFixture();t.after(()=>f.close());await f.store.run('INSERT INTO users(user_id) VALUES(100)');const user=await f.store.user(100),calls=[],client={async call(method){calls.push(method);return true}};
 for(let i=0;i<2;i++){await f.store.enqueue(user,'reply','screen',{due:at('07:00').getTime(),payload:{text:'same',editId:77,manual:true}});await deliverUser(f.store,client,100,{now:new Date(at('07:00').getTime()+i*2000)});}
 assert.deepEqual(calls,['editMessageText']);
 await f.store.run("INSERT INTO cards(user_id,group_id,date,parts) VALUES(100,'1А','2026-11-12',?)",JSON.stringify([{id:77,hash:'other'}]));
 await f.store.enqueue(user,'reply','screen',{due:at('07:00').getTime(),payload:{text:'same',editId:77,manual:true}});await deliverUser(f.store,client,100,{now:at('07:01')});assert.equal(calls.length,2);
});
test('a callback acknowledgement survives superseding older jobs and follows the immediate screen reply',async t=>{
 const f=await personalFixture();t.after(()=>f.close());await f.store.run('INSERT INTO users(user_id) VALUES(100)');
 await enqueuePersonalUpdate(f.store,{update_id:1,userId:100,action:'settings',messageId:77,callbackId:'cb'});
 await processPersonalInbox(f.store,await f.store.first('SELECT * FROM inbox WHERE update_id=1'),at('07:00'));
 assert.equal((await f.store.first("SELECT status FROM jobs WHERE kind='callback'")).status,'pending');
 const calls=[],client={async call(method){calls.push(method);return true}};
 await deliverUser(f.store,client,100,{now:at('07:01')});await deliverUser(f.store,client,100,{now:at('07:02')});
 assert.deepEqual(calls,['editMessageText','answerCallbackQuery']);
});
