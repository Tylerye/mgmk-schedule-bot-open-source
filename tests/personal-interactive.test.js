import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { sampleSchedule } from './helpers/personal-fixture.js';
import { addDays, dateInTimezone, dayKey } from '../src/dates.js';
import { weekRange } from '../src/personal/week.js';
import { relayPersonalUpdate } from '../cloudflare/personal-relay.js';

test('a real D1 trigger admits a tap and delivers its timetable without Cron or other users', async () => {
  const script = (await build({entryPoints:['personal/worker.js'],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:crypto']})).outputFiles[0].text;
  const lanes=[], calls=[];
  let rejectEmoji = false, rejectRich = false;
  const mf=new Miniflare(convertV4MiniflareOptions({name:'personal',modules:true,script,compatibilityDate:'2026-09-14',compatibilityFlags:['nodejs_compat'],
    d1Databases:{DB:'interactive'},bindings:{PERSONAL_SHARED_SECRET:'local-test',ADMIN_USER_ID:'100',BOT_TOKEN:'fake',PERSONAL_PUBLIC:'true',PERSONAL_BRANDED_MENU:'true',
      PERSONAL_DAILY_WRITES:'45000',PERSONAL_BACKGROUND_WRITES:'30000',PERSONAL_SOURCE_WRITES:'35000'},
    serviceBindings:{SELF:async(request,runtime)=>{lanes.push(new URL(request.url).pathname);return (await runtime.getWorker('personal')).fetch(request);}},
    outboundService:async request=>{calls.push({method:new URL(request.url).pathname.split('/').at(-1),body:await request.json()});
      if (rejectRich && calls.at(-1).body.rich_message) return Response.json({ok:false,error_code:400,description:"Bad Request: RICH_MESSAGE_INVALID"},{status:400});
      if (rejectEmoji && calls.at(-1).body.reply_markup?.inline_keyboard.flat().some(button => button.icon_custom_emoji_id)) {
        return Response.json({ok:false,error_code:400,description:'Bad Request: BUTTON_CUSTOM_EMOJI_INVALID'},{status:400});
      }
      return new Response(JSON.stringify({ok:true,result:{message_id:700}}),{headers:{'content-type':'application/json'}});}}));
  try {
    const db=await mf.getD1Database('DB');
    for(const file of (await readdir('personal/migrations')).filter(f=>f.endsWith('.sql')).sort())
      for(const sql of (await readFile('personal/migrations/'+file,'utf8')).replace(/--[^\n]*/gu,'').replace(/;\s*END;/gi,'__TRIGGER_END__;').split(';').map(s=>s.replaceAll('__TRIGGER_END__','; END;')).filter(s=>s.trim())) await db.prepare(sql).run();
    const date=dateInTimezone(new Date(),'Europe/Minsk'), schedule=await sampleSchedule('8Са',date);
    await db.prepare("INSERT INTO users(user_id,group_id,sound) VALUES(100,'8СА',0),(200,'8СА',1)").run();
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
    // Either fixture lesson can be the remaining one at the runner's real
    // Minsk time; finishing lesson 1 must not make this test fail at 09:00.
    assert.match(calls[0].body.text,/МАТЕМАТИКА|ФИЗИКА|На сегодня все/u);
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
    rejectEmoji = true;
    const menuTap = {update_id:3,userId:100,action:'menu',messageId:77};
    assert.equal((await post(menuTap)).status,200);
    for(let i=0;i<20 && calls.length<6;i++) {await new Promise(resolve=>setTimeout(resolve,100));await route('/tick/delivery');}
    assert.deepEqual(calls.slice(4).map(call=>[call.method,call.body.message_id]),[
      ['editMessageText',77], ['editMessageText',77],
    ]);
    const [branded, fallback] = calls.slice(4).map(call=>call.body.reply_markup.inline_keyboard[0]);
    assert.deepEqual(branded.map(button=>button.style), ['success','success']);
    assert.deepEqual(branded.map(button=>button.callback_data), ['personal:today','personal:tomorrow']);
    assert.ok(branded.every(button=>/^\d+$/.test(button.icon_custom_emoji_id)));
    assert.deepEqual(fallback.map(button=>button.text), ['Сегодня','Завтра']);
    assert.deepEqual(fallback.map(button=>button.style), ['success','success']);
    assert.ok(fallback.every(button=>!Object.hasOwn(button,'icon_custom_emoji_id')));
    assert.match(calls[4].body.text,/<tg-emoji/u);
    assert.equal(calls[5].body.text,calls[4].body.text);
    assert.match(calls[5].body.text,/Привет!/u);
    const menu = calls[4].body.reply_markup.inline_keyboard.flat();
    assert.ok(menu.some(button => button.callback_data === 'personal:updates:0'));
    assert.ok(menu.every(button => button.style === 'success'));

    rejectEmoji = false;
    async function tap(action, update_id, expectedCalls) {
      const response = await relayPersonalUpdate({PERSONAL_ENABLED:'true',ADMIN_USER_ID:'100',PERSONAL_SHARED_SECRET:'local-test',
        PERSONAL:{fetch:(url,options)=>mf.dispatchFetch('http://localhost/inbox',options)}},
        {update_id,callback_query:{id:'tap'+update_id,from:{id:100},data:'personal:'+action,
          message:{message_id:77,chat:{type:'private',id:100}}}});
      assert.deepEqual(await response.json(),{method:'answerCallbackQuery',callback_query_id:'tap'+update_id});
      for(let i=0;i<25 && calls.length<expectedCalls;i++) {
        await new Promise(resolve=>setTimeout(resolve,100));
        await route('/tick/delivery');
      }
      assert.equal(calls.length,expectedCalls);
    }
    await tap('updates:0',4,7);
    assert.match(calls[6].body.text,/V1\.4.*<\/b>/u);
    assert.match(calls[6].body.text,/Мое ДЗ/u);
    assert.equal(calls[6].body.message_id,77);
    await tap('updates:history',5,8);
    assert.match(calls[7].body.text,/V0\.1[\s\S]*11\.11\.2026[\s\S]*V1\.4/u);
    await tap('updates:v0.1',6,9);
    assert.match(calls[8].body.text,/Первый открытый выпуск/u);
    await tap('table:'+date,7,10);
    assert.equal(calls[9].method,'editMessageText');
    assert.equal(calls[9].body.message_id,77);
    assert.match(calls[9].body.text,/МАТЕМАТИКА/u);
    assert.match(calls[9].body.text,/<b>1-й урок<\/b> · 08:15–09:00/u);
    assert.equal(calls[9].body.rich_message,undefined);
    await tap('settings',8,11);
    const switches = calls[10].body.reply_markup.inline_keyboard.flat();
    assert.equal(switches.find(button=>button.callback_data==='personal:toggle:auto_pin').style,'success');
    assert.equal(switches.find(button=>button.callback_data==='personal:toggle:sound').style,'danger');
    assert.match(switches.find(button=>button.callback_data==='personal:toggle:auto_pin').text,/🟢 вкл/u);
    assert.match(switches.find(button=>button.callback_data==='personal:toggle:sound').text,/🔴 выкл/u);
    const monday = weekRange(new Date()).start;
    const planDate = date === monday ? addDays(monday, 1) : monday;
    const baseline = { effectiveFrom:'2020-01-01', fingerprint:'a'.repeat(64), previous:null,
      groups:{'8СА':{label:'8-Сба',days:{
        [dayKey(date)]:{lessons:[[1,'УСТАРЕВШИЙ ПРЕДМЕТ','111']],hours:[]},
        [dayKey(planDate)]:{lessons:[[1,'ПРАКТИКА / Петров И И','321'],[2,'ФИЗИКА','112']],hours:[]},
      }}} };
    const publish = body => mf.dispatchFetch('http://localhost/week-source',{
      method:'POST',headers:{authorization:'Bearer local-test'},body:JSON.stringify(body),
    });
    assert.deepEqual(await (await publish(baseline)).json(),{fingerprint:baseline.fingerprint,groups:1});
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM catalog WHERE id='8СА'").first()).n,1);
    const beforeStatus = await db.prepare('SELECT * FROM budgets').all();
    assert.deepEqual(await (await route('/week-source-status')).json(),{fingerprint:baseline.fingerprint,groups:1});
    assert.deepEqual((await db.prepare('SELECT * FROM budgets').all()).results,beforeStatus.results);
    assert.equal((await publish({...baseline,fingerprint:'b'.repeat(64)})).status,409);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM fanout').first()).n,0);
    await tap('week',9,12);
    const week = calls[11].body;
    assert.equal(calls[11].method,'editMessageText');
    assert.equal(week.message_id,77);
    assert.match(week.rich_message.html,/раз в 3–4 дня/u);
    assert.match(week.rich_message.html,/Дневной PDF/u);
    assert.match(week.rich_message.html,/По плану/u);
    assert.match(week.rich_message.html,/<p><b>1-й урок<\/b> · 08:15–09:00<br><b>ПРАКТИКА<\/b><br><i>Кабинет 321 · Петров И И<\/i><\/p>/u);
    assert.match(week.rich_message.html,/<p><u><i>Перемена · 09:00–09:10<\/i><\/u><\/p>/u);
    assert.match(week.rich_message.html,/<h2><tg-emoji/u);
    assert.doesNotMatch(week.rich_message.html,/УСТАРЕВШИЙ ПРЕДМЕТ/u);
    assert.match(week.rich_message.html,/<details open><summary>/u);
    assert.match(week.rich_message.html,/МАТЕМАТИКА/u);
    assert.match(week.rich_message.html,/Кабинет 245/u);
    assert.match(week.rich_message.html,/Пока нет расписания/u);
    assert.deepEqual(week.reply_markup.inline_keyboard.flat().map(button=>button.callback_data),['personal:menu']);
    await tap('week:'+planDate,10,13);
    const focused = calls[12].body;
    assert.equal(focused.message_id,77);
    assert.match(focused.rich_message.html,/ПРАКТИКА<\/b><br><i>Кабинет 321 · Петров И И/u);
    assert.deepEqual(focused.reply_markup.inline_keyboard[0][0],{
      text:'Назад',callback_data:'personal:week',icon_custom_emoji_id:'5195318936618449178',
    });
    rejectRich = true;
    await tap('week',11,15);
    assert.equal(calls[14].body.message_id,77);
    assert.match(calls[14].body.text,/МАТЕМАТИКА/u);
    assert.match(calls[14].body.text,/<\/b>\n<i>Кабинет 245/u);
    assert.match(calls[14].body.text,/Пока нет расписания/u);
    assert.equal(calls[14].body.rich_message,undefined);
    const homeworkCallback = (call, prefix) => call.body.reply_markup.inline_keyboard.flat()
      .find(button => button.callback_data.startsWith("personal:hw:" + prefix)).callback_data.slice(9);
    await tap("hw:pick:0", 12, 16);
    const practice = calls.at(-1).body.reply_markup.inline_keyboard.flat().find(button => /ПРАКТИКА/u.test(button.text));
    await tap(practice.callback_data.slice(9), 13, 17);
    const prompt = calls.at(-1).body;
    assert.equal(prompt.reply_markup.force_reply, undefined);
    assert.ok(prompt.reply_markup.inline_keyboard.flat().some(button => button.text === "Отмена"));
    assert.match(prompt.text, /^Запиши ДЗ · ПРАКТИКА/u);
    const submitted = await relayPersonalUpdate({
      BOT_TOKEN: "42:fixture", PERSONAL_ENABLED: "true", ADMIN_USER_ID: "100", PERSONAL_SHARED_SECRET: "local-test",
      PERSONAL: { fetch: (url, options) => mf.dispatchFetch("http://localhost/inbox", options) },
    }, { update_id: 14, message: { message_id: 701, chat: { type: "private", id: 100 }, from: { id: 100 },
      text: "§ 8 https://example.org", reply_to_message: { message_id: 700, from: { id: 42, is_bot: true }, text: prompt.text } } });
    assert.deepEqual(await submitted.json(), { ok: true, queued: true });
    for (let i = 0; i < 25 && calls.length < 18; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.match(calls.at(-1).body.text, /К какому уроку/u);
    const dateAction = homeworkCallback(calls.at(-1), "save:");
    await tap(dateAction, 15, 19);
    assert.match(calls.at(-1).body.text, /Сохранено/u);
    const saved = await db.prepare("SELECT value FROM settings WHERE key='homework:100'").first("value");
    assert.equal(JSON.parse(saved).items[0].text, "§ 8 https://example.org");
    assert.equal(JSON.parse(saved).items[0].date, dateAction.slice(-10));
    assert.equal(JSON.parse(saved).draft, null);
    await db.prepare('UPDATE budgets SET rows_written=36000').run();
    assert.equal((await route('/source-status')).status,503,'uncommitted upload cannot be acknowledged as successful');
  } finally {await mf.dispose();}
});
