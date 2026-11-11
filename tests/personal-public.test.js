import test from 'node:test';
import assert from 'node:assert/strict';
import {pilotAllowed,relayPersonalUpdate} from '../cloudflare/personal-relay.js';
import {renderPersonal,words,settingsKeyboard} from '../src/personal/view.js';
import {sampleSchedule} from './helpers/personal-fixture.js';
test('public access is explicit, accepts valid IDs and still reserves teacher accounts',async()=>{
 assert.equal(pilotAllowed({ADMIN_USER_ID:'1'},22),false);
 assert.equal(pilotAllowed({PERSONAL_PUBLIC:'true'},22),true);
 assert.equal(pilotAllowed({PERSONAL_PUBLIC:'true'},-22),false);
 const env={PERSONAL_PUBLIC:'true',PERSONAL_ENABLED:'true',PERSONAL_SHARED_SECRET:'test',PERSONAL:{fetch(){throw Error('teacher must not be relayed')}}};
 assert.equal(await relayPersonalUpdate(env,{update_id:1,message:{from:{id:22,username:'teacher'},chat:{id:22,type:'private'},text:'/start'}},[{userId:22,username:'teacher'}]),null);
});
test('header has a blank line and service copy has no long dashes or pin announcement control',async()=>{
 const s=await sampleSchedule();const r=renderPersonal(s,{language:'ru'},{now:new Date('2026-11-12T07:00:00+03:00')});
 assert.match(r.parts[0],/ноября\n\n<b>/u);
 assert.ok(Object.values(words.ru).every(text=>!/[—–;]/u.test(text)));
 assert.ok(!settingsKeyboard({auto_pin:true}).inline_keyboard.flat().some(b=>b.callback_data==='personal:toggle:pin'));
});
