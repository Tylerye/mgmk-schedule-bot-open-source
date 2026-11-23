import assert from "node:assert/strict";
import test from "node:test";
import { personalFixture, sampleSchedule, installSchedules } from "./helpers/personal-fixture.js";
import { collectPersonalUpdate, enqueuePersonalUpdate, processPersonalInbox } from "../src/personal/inbox.js";
import { deliverUser } from "../src/personal/delivery.js";
import { readHomework } from "../src/personal/homework.js";

test("private homework follows its dated lesson, stays scoped to the owner, and is saved once", async t => {
  const f = await personalFixture();
  t.after(() => f.close());
  const tomorrow = await sampleSchedule("8Са", "2026-11-24");
  const later = await sampleSchedule("8Са", "2026-12-01");
  tomorrow.lessons[0].variants[0].subject = "БЕЛ.ЛИТ-РА";
  tomorrow.timeline.find(lesson => lesson.type === "lesson").variants[0].subject = "БЕЛ.ЛИТ-РА";
  const plan = { effectiveFrom: "2026-11-23", groups: ["8СА"] };
  await f.store.setSetting("weekly:manifest", plan);
  await f.store.setSetting("weekly:8СА", { days: { tuesday: { lessons: [
    [1, "Физика/Иванов", "210"], [2, "Белорусская литература/Иванов", "210"],
    [3, "Белорусский язык", ""], [4, "Химия", ""], [5, "Электротехника", ""],
    [6, "Информатика", ""], [7, "Основы технологии машиностроения", ""],
  ], hours: [] } } });
  await installSchedules(f.store, [tomorrow]);
  await installSchedules(f.store, [later], { id: "b".repeat(64) });
  await f.store.run("INSERT INTO users(user_id,group_id) VALUES (100,'8СА'),(200,'8СА')");
  let ms = Date.parse("2026-11-23T14:00:00+03:00");
  let updateId = 1;
  const calls = [];
  const client = { async call(method, body) {
    calls.push({ method, body });
    return method === "sendMessage" ? { message_id: 700 + calls.length } : true;
  } };
  const update = async (raw, id) => {
    const clean = collectPersonalUpdate({ update_id: updateId++, ...raw }, 42);
    assert.ok(clean);
    if (clean.callbackId) clean.acknowledged = true;
    assert.equal(await enqueuePersonalUpdate(f.store, clean, ms), true);
    const row = await f.store.first("SELECT * FROM inbox WHERE update_id=?", clean.update_id);
    await processPersonalInbox(f.store, row, new Date(ms));
    ms += 2000;
    await deliverUser(f.store, client, id, { now: new Date(ms) });
    ms += 2000;
    return calls.at(-1);
  };
  const tap = (action, id = 100, message_id = 77) => update({ callback_query: {
    id: "click", data: "personal:" + action, from: { id }, message: { message_id, chat: { type: "private", id } },
  } }, id);
  const buttons = call => call.body.reply_markup.inline_keyboard.flat();
  await tap("hw");
  const list = await tap("hw:pick:0");
  assert.deepEqual(buttons(list).filter(button => /лит/iu.test(button.text)).map(button => button.text), ["БЕЛ.ЛИТ-РА"]);
  assert.ok(buttons(list).some(button => button.text === "Техмаш"));
  assert.ok(buttons(list).filter(button => button.callback_data.startsWith("personal:hw:subject:")).length > 6);
  assert.ok(!buttons(list).some(button => button.callback_data.startsWith("personal:hw:pick:")));
  const physics = buttons(list).filter(button => /физика/iu.test(button.text));
  assert.equal(physics.length, 1, "plan and PDF subject aliases deduplicate");
  const prompt = await tap(physics[0].callback_data.slice(9));
  assert.equal(prompt.method, "sendMessage");
  assert.equal(prompt.body.reply_markup.force_reply, undefined);
  assert.ok(buttons(prompt).some(button => button.text === "Отмена"));
  const promptId = 700 + calls.length;
  const text = '§ 12 и <пример> https://example.org';
  const answer = (message_id, content, id = 100) => ({ message: {
    message_id: 800, from: { id }, chat: { type: "private", id }, text: content,
    reply_to_message: { message_id, from: { id: 42, is_bot: true }, text: prompt.body.text },
  } });
  assert.equal(collectPersonalUpdate({ update_id: 89, ...answer(promptId, text) }, 41), null);
  assert.match((await update(answer(promptId + 1, "old prompt"), 100)).body.text, /устарел/u);
  const dates = await update(answer(promptId, text), 100);
  assert.match(dates.body.text, /&lt;пример&gt; https:\/\/example.org/u);
  assert.deepEqual(buttons(dates).filter(b => b.callback_data.startsWith("personal:hw:save:")).map(b => b.callback_data.slice(-10)),
    ["2026-11-24", "2026-12-01"]);
  const save = buttons(dates).find(b => b.callback_data.endsWith("2026-11-24")).callback_data.slice(9);
  assert.match((await tap(save)).body.text, /Сохранено/u);
  assert.match((await tap(save)).body.text, /устарел/u);
  const saved = await readHomework(f.store, 100);
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].text, text);
  assert.equal(saved.draft, null);
  assert.match((await tap("hw:show:" + saved.items[0].id, 200)).body.text, /устарел/u);
  assert.doesNotMatch((await tap("tomorrow", 200)).body.text, /§ 12/u);
  assert.match((await tap("tomorrow")).body.text, /§ 12/u);
  assert.equal((await f.store.first("SELECT COUNT(*) n FROM jobs WHERE payload LIKE '%example.org%'")).n, 0);
  const user = await f.store.user(100);
  await f.store.enqueue(user, "card", tomorrow.date, { due: ms });
  await deliverUser(f.store, client, 100, { now: new Date(ms += 2000) });
  assert.match(calls.at(-1).body.text, /Домашнее задание[\s\S]*§ 12/u);
  assert.ok(buttons(calls.at(-1)).some(b => b.callback_data === "personal:hw:day:2026-11-24"));
  assert.match((await tap("hw:done:" + saved.items[0].id)).body.text, /Выполнено/u);
  assert.doesNotMatch((await tap("tomorrow")).body.text, /§ 12/u);
  const abandoned = await tap(physics[0].callback_data.slice(9));
  const abandonedId = 700 + calls.length;
  await tap("menu");
  assert.equal((await readHomework(f.store, 100)).draft, null);
  const stale = answer(abandonedId, "personal message");
  stale.message.reply_to_message.text = abandoned.body.text;
  assert.match((await update(stale, 100)).body.text, /устарел/u);
});
