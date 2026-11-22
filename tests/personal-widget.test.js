import test from "node:test";
import assert from "node:assert/strict";
import { personalFixture, sampleSchedule, installSchedules } from "./helpers/personal-fixture.js";
import { collectPersonalUpdate, enqueuePersonalUpdate, processPersonalInbox } from "../src/personal/inbox.js";
import { deliverUser } from "../src/personal/delivery.js";
import { menu, widgetGroup } from "../src/personal/view.js";

test("8-Сба can request the widget alongside text; definite rejection falls back and uncertain sends never repeat", async t => {
  const fixture = await personalFixture();
  t.after(() => fixture.close());
  const { store } = fixture;
  const schedule = await sampleSchedule();
  await installSchedules(store, [schedule]);
  await store.run("INSERT INTO users(user_id,group_id) VALUES(100,?),(200,'8ТС')", widgetGroup);
  const hasWidget = keyboard => keyboard.inline_keyboard.flat().some(button => button.callback_data.startsWith("personal:widget"));
  assert.ok(hasWidget(menu({ group_id: widgetGroup }, true)));
  assert.ok(!hasWidget(menu({ group_id: widgetGroup })));
  assert.ok(!hasWidget(menu({ group_id: "8ТС" }, true)));

  const calls = [];
  let error;
  const client = { async call(method, body) {
    calls.push({ method, body });
    if (method === "sendWidget" && error) throw error;
    return { message_id: 99 };
  } };
  let id = 0;
  let now = Date.parse(schedule.date + "T08:03:00+03:00");
  const tap = async (userId, action, widgetEnabled = true) => {
    now += 2000;
    const update = collectPersonalUpdate({ update_id: ++id, callback_query: { id: "tap",
      data: "personal:" + action, from: { id: userId }, message: { message_id: 77, chat: { type: "private", id: userId } } } });
    assert.ok(update);
    await enqueuePersonalUpdate(store, { ...update, acknowledged: true }, now);
    await processPersonalInbox(store, await store.first("SELECT * FROM inbox WHERE update_id=?", id), new Date(now), { widgetEnabled });
    await deliverUser(store, client, userId, { now: new Date(now), widgetEnabled });
  };
  await tap(200, "widget:today");
  assert.equal(calls.length, 0);
  await tap(100, "widget:today", false);
  assert.equal(calls.at(-1).method, "editMessageText");
  assert.match(calls.at(-1).body.text, /Telegram приостановил/u);
  assert.ok(!hasWidget(calls.at(-1).body.reply_markup));
  await tap(100, "today");
  assert.equal(calls.at(-1).method, "editMessageText");
  await tap(100, "widget:today");
  assert.equal(calls.at(-1).method, "sendWidget");
  assert.match(calls.at(-1).body.html, /МАТЕМАТИКА/u);
  assert.match(calls.at(-1).body.caption, /245/u);
  await tap(100, "widget-text:" + schedule.date);
  assert.equal(calls.at(-1).method, "sendMessage");
  await tap(100, "widget:tomorrow");
  assert.match(calls.at(-1).body.text, /Пока не вижу расписание/u);

  error = Object.assign(new Error("Method unavailable"), { apiRejected: true, errorCode: 404 });
  await tap(100, "widget:today");
  await deliverUser(store, client, 100, { now: new Date(now + 2000), widgetEnabled: true });
  assert.deepEqual(calls.slice(-2).map(call => call.method), ["sendWidget", "sendMessage"]);
  assert.match(calls.at(-1).body.text, /HTML-виджет недоступен/u);
  error = new Error("Connection closed");
  now += 2000;
  await tap(100, "widget:today");
  assert.equal(calls.at(-1).method, "sendWidget");
  const count = calls.length;
  await deliverUser(store, client, 100, { now: new Date(now + 5000) });
  assert.equal(calls.length, count);
  assert.ok(await store.first("SELECT 1 FROM operations WHERE method='sendWidget' AND status='uncertain'"));
});
