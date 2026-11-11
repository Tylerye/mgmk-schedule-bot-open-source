import test from 'node:test';
import assert from 'node:assert/strict';
import {personalFixture,sampleSchedule,installSchedules} from './helpers/personal-fixture.js';
import {enqueuePersonalUpdate,processPersonalInbox,collectPersonalUpdate} from '../src/personal/inbox.js';
import {AUTHOR_USERNAME} from '../src/personal/view.js';
import {deliverUser} from '../src/personal/delivery.js';
test('settings, pagination and timetable buttons edit the pressed screen, including unchanged published schedules',async t=>{
 const f=await personalFixture();t.after(()=>f.close());const s=await sampleSchedule();await installSchedules(f.store,[s]);
 await f.store.run("INSERT INTO users(user_id,group_id) VALUES(100,'8СА')");
 const calls=[],client={async call(method,body){calls.push({method,body});return true;}};
 let id=1,ms=Date.parse('2026-11-12T07:00:00+03:00');
 for(const action of ['settings','toggle:pin','groups:0','groups:1','tomorrow','today','preview:2026-11-12:full','menu','help','feedback','privacy']){
  const u={update_id:id++,userId:100,action,messageId:77,acknowledged:true};
  await enqueuePersonalUpdate(f.store,u);await processPersonalInbox(f.store,await f.store.first('SELECT * FROM inbox WHERE update_id=?',u.update_id),new Date(ms));
  ms+=2000;await deliverUser(f.store,client,100,{now:new Date(ms)});
 }
 assert.equal(calls.length,11);assert.ok(calls.every(c=>c.method==='editMessageText'&&c.body.message_id===77));
 assert.match(calls[5].body.text,/МАТЕМАТИКА/);assert.match(calls[6].body.text,/МАТЕМАТИКА/);
 assert.equal((await f.store.user(100)).pin_message_id,null);
 for(const [index,action] of [[9,'feedback'],[10,'privacy']]){
  const update=collectPersonalUpdate({update_id:index,callback_query:{id:'click',data:`personal:${action}`,from:{id:100},message:{message_id:77,chat:{type:'private',id:100}}}});
  assert.equal(update.action,action);
  assert.ok(calls[index].body.text.includes(`@${AUTHOR_USERNAME}`));
  assert.equal(calls[index].body.reply_markup.inline_keyboard[0][0].url,`https://t.me/${AUTHOR_USERNAME}`);
  assert.equal(calls[index].body.reply_markup.inline_keyboard[1][0].callback_data,'personal:menu');
 }
 assert.match(calls[10].body.text,/Не полагайся только на бота/);
 assert.equal((await f.store.user(100)).group_id,'8СА');
});
test('automatic pin defaults on and can be disabled independently of pin announcements',async t=>{
 const f=await personalFixture();t.after(()=>f.close());await f.store.run('INSERT INTO users(user_id,pin_message_id) VALUES(100,88)');
 assert.equal((await f.store.user(100)).auto_pin,true);
 await enqueuePersonalUpdate(f.store,{update_id:1,userId:100,action:'toggle:auto_pin',messageId:77,acknowledged:true});
 await processPersonalInbox(f.store,await f.store.first('SELECT * FROM inbox WHERE update_id=1'));
 assert.equal((await f.store.user(100)).auto_pin,false);
 assert.equal((await f.store.user(100)).pin_message_id,null);
 assert.ok(await f.store.first("SELECT 1 FROM jobs WHERE kind='unpin'"));
});
