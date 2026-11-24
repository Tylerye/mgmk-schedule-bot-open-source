import assert from "node:assert/strict";
import test from "node:test";
import { personalFixture, sampleSchedule, installSchedules } from "./helpers/personal-fixture.js";
import { collectPersonalUpdate, enqueuePersonalUpdate, processPersonalInbox } from "../src/personal/inbox.js";
import { deliverUser } from "../src/personal/delivery.js";
import { homeworkScreen, readHomework } from "../src/personal/homework.js";
import { sendWithThemeFallback } from "../src/chat-theme.js";
import { personalEventLines } from "../src/personal/view.js";

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
  const plain = (content, id = 100) => ({ message: { message_id: 800, from: { id }, chat: { type: "private", id }, text: content } });
  assert.equal(await enqueuePersonalUpdate(f.store, collectPersonalUpdate({ update_id: 999, ...plain("чужой текст", 200) }, 42), ms), false);
  const dates = await update(plain(text), 100);
  assert.equal(await enqueuePersonalUpdate(f.store, collectPersonalUpdate({ update_id: 998, ...plain("лишнее сообщение") }, 42), ms), false);
  assert.equal(await enqueuePersonalUpdate(f.store, collectPersonalUpdate({ update_id: 997, ...answer(promptId, "лишний ответ") }, 42), ms), false);
  assert.equal((await readHomework(f.store, 100)).draft.text, text);
  assert.match(dates.body.text, /&lt;пример&gt; https:\/\/example.org/u);
  assert.deepEqual(buttons(dates).filter(b => b.callback_data.startsWith("personal:hw:save:")).map(b => b.callback_data.slice(-10)),
    ["2026-11-24", "2026-12-01"]);
  const save = buttons(dates).find(b => b.callback_data.endsWith("2026-11-24")).callback_data.slice(9);
  const savedScreen = await tap(save);
  assert.match(savedScreen.body.text, /Сохранено/u);
  assert.deepEqual(savedScreen.body.reply_markup.inline_keyboard.at(-1).map(button => button.callback_data), ["personal:hw", "personal:menu"]);
  assert.match((await tap(save)).body.text, /устарел/u);
  const saved = await readHomework(f.store, 100);
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].text, text);
  assert.equal(saved.draft, null);
  assert.match((await tap("hw:show:" + saved.items[0].id, 200)).body.text, /устарел/u);
  assert.doesNotMatch((await tap("tomorrow", 200)).body.text, /§ 12/u);
  await f.store.setSetting("homework:100", { ...saved, items: [...saved.items,
    { id: 10001, group: "8СА", subject: "Белорусская литература", key: "legacy", date: tomorrow.date, text: "Прочитать рассказ", done: false },
    { id: 10002, group: "8СА", subject: "Физика", key: "legacy", date: later.date, text: "Другая дата", done: false },
  ] });
  assert.match((await tap("tomorrow")).body.text, /\n\n\n📝 <b><u>Домашнее задание<\/u><\/b>\n\n[\s\S]*1-й урок[\s\S]*:<\/b>\nПрочитать рассказ\n\n[\s\S]*8-й урок[\s\S]*:<\/b>\n§ 12/u);
  const day = await tap("hw:day:" + tomorrow.date);
  assert.match(day.body.text, /1-й урок[\s\S]*Прочитать рассказ\n\n[\s\S]*8-й урок[\s\S]*§ 12 и &lt;пример&gt;/u);
  assert.doesNotMatch(day.body.text, /Другая дата|Мое ДЗ/u);
  assert.deepEqual(buttons(day).map(button => button.callback_data), ["personal:hw", "personal:preview:" + tomorrow.date + ":compact", "personal:menu"]);
  assert.equal((await f.store.first("SELECT COUNT(*) n FROM jobs WHERE payload LIKE '%example.org%'")).n, 0);
  const user = await f.store.user(100);
  await f.store.enqueue(user, "card", tomorrow.date, { due: ms });
  await deliverUser(f.store, client, 100, { now: new Date(ms += 2000) });
  assert.match(calls.at(-1).body.text, /<b><u>Домашнее задание<\/u><\/b>[\s\S]*§ 12/u);
  assert.ok(buttons(calls.at(-1)).some(b => b.callback_data === "personal:hw:day:2026-11-24"));
  assert.match((await tap("hw:done:" + saved.items[0].id)).body.text, /Выполнено/u);
  assert.doesNotMatch((await tap("tomorrow")).body.text, /§ 12/u);
  const abandoned = await tap(physics[0].callback_data.slice(9));
  const abandonedId = 700 + calls.length;
  await tap("menu");
  assert.equal((await readHomework(f.store, 100)).draft, null);
  const stale = answer(abandonedId, "personal message");
  stale.message.reply_to_message.text = abandoned.body.text;
  assert.equal(await enqueuePersonalUpdate(f.store, collectPersonalUpdate({ update_id: 996, ...stale }, 42), ms), false);
  const edit = await tap("hw:edit:" + saved.items[0].id);
  assert.equal(edit.body.reply_markup.force_reply, undefined);
  assert.match(edit.body.text, /^Замени текст ДЗ/u);
  const editId = 700 + calls.length;
  const legacy = answer(editId, "6-6-6");
  legacy.message.reply_to_message.text = "Замени текст ДЗ · ФИЗИКА\n\nОтветь на это сообщение. Можно добавить ссылку";
  assert.equal(collectPersonalUpdate({ update_id: 1000, ...legacy }, 42), null);
  const editAnswer = answer(editId, "Новый текст");
  editAnswer.message.reply_to_message.text = edit.body.text;
  assert.match((await update(editAnswer, 100)).body.text, /Сохранить новый текст/u);
});

test("saving during a lesson edits the pinned card and both dated views follow the daily PDF", async t => {
  const f = await personalFixture();
  t.after(() => f.close());
  const day = await sampleSchedule("8Са", "2026-11-25");
  const next = await sampleSchedule("8Са", "2026-12-02");
  await f.store.setSetting("weekly:manifest", { effectiveFrom: "2026-11-23", groups: ["8СА"] });
  await f.store.setSetting("weekly:8СА", { days: { wednesday: { lessons: [[8, "Электротехника", "210"]], hours: [] } } });
  next.lessons[1].variants[0].subject = "ЭЛТЕХНИКА";
  next.timeline.find(event => event.type === "lesson" && event.number === 8).variants[0].subject = "ЭЛТЕХНИКА";
  await installSchedules(f.store, [day]);
  await installSchedules(f.store, [next], { id: "b".repeat(64) });
  await f.store.run("INSERT INTO users(user_id,group_id) VALUES(100,'8СА')");
  const item = { id: 900, group: "8СА", subject: "Электротехника", date: day.date, text: "Закон Ома", done: false };
  await f.store.setSetting("homework:100", { items: [item], draft: null });
  const lesson = day.timeline.find(event => event.type === "lesson" && event.number === 1);
  let ms = Date.parse(day.date + "T" + lesson.start + ":30+03:00");
  const calls = [];
  const client = { async call(method, body) { calls.push({ method, body }); return { message_id: 500 + calls.length }; } };
  const deliver = () => deliverUser(f.store, client, 100, { now: new Date(ms += 2000), brandedMenu: true, mode: "saving" });
  await f.store.enqueue(await f.store.user(100), "card", day.date, { due: ms, payload: { manual: true, history: true } });
  await deliver();
  const pinned = (await f.store.card(await f.store.user(100), day.date)).parts[0].id;
  await f.store.run("UPDATE users SET pin_message_id=?,pin_date=? WHERE user_id=100", pinned, day.date);
  assert.doesNotMatch(calls[0].body.text, /Закон Ома/u);
  assert.match(calls[0].body.text, /<tg-emoji/u);

  let id = 1;
  const tap = async action => {
    const update = { update_id: id++, userId: 100, action, messageId: 42, acknowledged: true };
    assert.equal(await enqueuePersonalUpdate(f.store, update, ms), true);
    const row = await f.store.first("SELECT * FROM inbox WHERE update_id=?", update.update_id);
    await processPersonalInbox(f.store, row, new Date(ms), { brandedMenu: true });
    await deliver();
    return calls.at(-1);
  };
  await f.store.setSetting("homework:100", { items: [item], draft: {
    group: "8СА", subject: "Математика", id: 901, text: "Решить пример", until: ms + 60_000,
  } });
  assert.match((await tap("hw:save:901:" + day.date)).body.text, /Сохранено/u);
  await deliver();
  const edited = calls.at(-1);
  assert.equal(edited.method, "editMessageText");
  assert.equal(edited.body.message_id, pinned);
  assert.match(edited.body.text, /<tg-emoji[\s\S]*Решить пример/u);
  assert.ok(edited.body.reply_markup.inline_keyboard.every(row => row.every(button => button.icon_custom_emoji_id)));
  assert.equal((await f.store.user(100)).pin_message_id, pinned);
  assert.doesNotMatch(edited.body.text, /Закон Ома/u);
  assert.doesNotMatch((await tap("hw:day:" + day.date)).body.text, /Закон Ома/u);
  assert.match((await tap("hw:day:" + next.date)).body.text, /Закон Ома/u);
  assert.match((await tap("preview:" + next.date + ":compact")).body.text, /Закон Ома/u);
  await tap("hw:done:901");
  await deliver();
  assert.equal(calls.at(-1).body.message_id, pinned);
  assert.doesNotMatch(calls.at(-1).body.text, /Решить пример/u);
  await f.store.run("UPDATE cards SET parts=json_set(parts,'$[0].hash','previous-theme') WHERE user_id=100 AND date=?", day.date);
  await tap("today");
  await deliver();
  assert.equal(calls.at(-1).method, "editMessageText");
  assert.equal(calls.at(-1).body.message_id, pinned, "opening the day refreshes the old pin without a mode toggle");
  assert.equal((await f.store.card(await f.store.user(100), day.date)).mode, "compact");
  await tap("today");
  const count = calls.length;
  await deliver();
  assert.equal(calls.length, count, "no further edit when the pin already matches");

  ms = Date.parse(day.date + "T" + lesson.end + ":15+03:00");
  const saved = await readHomework(f.store, 100);
  await f.store.setSetting("homework:100", { items: saved.items, draft: { group: "8СА", subject: "Математика", id: 902, text: "Поздно", until: ms + 60_000 } });
  assert.match((await tap("hw:save:902:" + day.date)).body.text, /Дата поменялась/u);
  assert.ok(!(await readHomework(f.store, 100)).items.some(entry => entry.id === 902));
});

test("Telegram timer rejection preserves the timetable's custom emoji", async () => {
  const calls = [];
  const send = async (text, keyboard) => {
    calls.push({ text, keyboard });
    if (text.includes("<tg-time")) throw Object.assign(new Error("format"), {
      apiRejected: true, errorCode: 400, description: "Bad Request: can't parse entities",
    });
  };
  const emoji = '<tg-emoji emoji-id="123">📚</tg-emoji>';
  const keyboard = { inline_keyboard: [[{ text: "Меню", icon_custom_emoji_id: "123" }]] };
  await sendWithThemeFallback(send, emoji + ' <tg-time unix="12" format="r">08:00</tg-time>', keyboard, { customEmojiOnly: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { text: emoji + " 08:00", keyboard });
});

test("only ordinary breaks get the hourglass emoji", () => {
  const render = type => personalEventLines({ type, start: "09:00", end: "09:10" }, { language: "ru" }, { branded: true })[0];
  assert.match(render("break"), /<tg-emoji emoji-id="5202158723576934145">⏳<\/tg-emoji> <u><i>Перемена/u);
  assert.match(render("lunch"), /<tg-emoji emoji-id="5197633344170405759">🍴<\/tg-emoji> <b><u>Обед/u);
  assert.match(render("large_break"), /<tg-emoji emoji-id="5195319567978637499">☕<\/tg-emoji> <b><u>Большая перемена/u);
});

test("a weekly forecast stores the selected occurrence and recalculates it from daily publications", async t => {
  const f = await personalFixture();
  t.after(() => f.close());
  const group = "8СА", monday = new Date("2026-11-23T19:00:00+03:00");
  await f.store.run("INSERT INTO users(user_id,group_id) VALUES(100,?)", group);
  await f.store.setSetting("weekly:manifest", { effectiveFrom: "2026-11-23", groups: [group] });
  await f.store.setSetting("weekly:" + group, { days: { wednesday: { lessons: [[1, "Математика", "210"]], hours: [] } } });
  await f.store.setSetting("homework:100", { items: [], draft: { group, subject: "Математика", id: 1, text: "Второе занятие", until: +monday + 60000 } });
  const show = async action => {
    const statements = [];
    const screen = await homeworkScreen(f.store, await f.store.user(100), { action }, monday, true, statements);
    await f.store.batch(statements);
    return screen;
  };
  assert.match((await show("hw:save:1:2026-12-02")).text, /Урок после ближайшего/u);
  assert.equal((await readHomework(f.store, 100)).items[0].relative.number, 2);
  await installSchedules(f.store, [await sampleSchedule("8Са", "2026-11-24")]);
  await installSchedules(f.store, [await sampleSchedule("8Са", "2026-11-25")], { id: "b".repeat(64) });
  assert.doesNotMatch((await show("hw:day:2026-11-24")).text, /Второе занятие/u);
  assert.match((await show("hw:day:2026-11-25")).text, /Второе занятие/u);
  assert.match((await show("hw:show:1")).text, /25 ноября/u);
});
