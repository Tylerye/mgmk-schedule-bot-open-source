import test from "node:test";
import assert from "node:assert/strict";
import { prepareChangeNotification, deliverChangeNotifications } from "../src/schedule/notifications.js";

function fixture() {
  const record = { schedule: { date: "2026-10-02" }, scheduleHash: "B", publishedScheduleHash: "A" };
  const calls = [];
  const store = { state: { chatId: "-1001" }, async save() { calls.push("save"); } };
  const logger = { info() {}, warn() {} };
  const client = { async sendMessage() { calls.push("send"); return { message_id: 42 }; } };
  return { record, calls, store, logger, client, now: new Date("2026-10-01T09:00:00Z"), timezone: "Europe/Minsk" };
}

test("durable notification is stored before send, replay is silent, and interrupted sending is uncertain", async () => {
  const context = fixture();
  await prepareChangeNotification({ ...context, changes: ["1 урок: A → B"], targetHash: "B" });
  await deliverChangeNotifications(context);
  assert.deepEqual(context.calls, ["save"]);
  context.record.publishedScheduleHash = "B";
  await deliverChangeNotifications(context);
  assert.deepEqual(context.calls, ["save", "save", "send", "save"]);
  await deliverChangeNotifications(context);
  assert.equal(context.calls.filter(call => call === "send").length, 1);
  context.record.changeNotifications[0].status = "sending";
  await deliverChangeNotifications(context);
  assert.equal(context.record.changeNotifications[0].status, "uncertain");
  assert.equal(context.calls.filter(call => call === "send").length, 1);
});

test("past dates and old destinations suppress queued notifications", async () => {
  for (const stale of ["date", "chat", "version"]) {
    const context = fixture();
    await prepareChangeNotification({ ...context, changes: ["1 урок: A → B"], targetHash: "B" });
    context.record.publishedScheduleHash = "B";
    if (stale === "date") context.now = new Date("2026-10-03T09:00:00Z");
    if (stale === "chat") context.store.state.chatId = "-2002";
    if (stale === "version") { context.record.publishedScheduleHash = "C"; context.record.scheduleHash = "C"; }
    await deliverChangeNotifications(context);
    assert.equal(context.record.changeNotifications[0].status, "superseded");
    assert.equal(context.calls.includes("send"), false);
  }
});

test("past corrections and no subject changes do not enqueue alerts", async () => {
  const context = fixture();
  await prepareChangeNotification({ ...context, changes: [], targetHash: "B" });
  await prepareChangeNotification({ ...context, now: new Date("2026-10-03T09:00:00Z"), changes: ["1 урок: A → B"], targetHash: "B" });
  assert.equal(context.record.changeNotifications, undefined);
});

test("a cancelled pending change does not suppress the same real replacement later", async () => {
  const context = fixture();
  await prepareChangeNotification({ ...context, changes: ["1 урок: A → B"], targetHash: "B" });
  context.record.scheduleHash = "A";
  await deliverChangeNotifications(context);
  assert.equal(context.record.changeNotifications[0].status, "superseded");
  context.record.scheduleHash = "B";
  await prepareChangeNotification({ ...context, changes: ["1 урок: A → B"], targetHash: "B" });
  context.record.publishedScheduleHash = "B";
  await deliverChangeNotifications(context);
  assert.equal(context.calls.filter(call => call === "send").length, 1);
  assert.equal(context.record.changeNotifications[1].id, "2026-10-02:2");
});

test("a confirmed permanent Telegram rejection is recorded and not repeatedly sent", async () => {
  const context = fixture();
  await prepareChangeNotification({ ...context, changes: ["1 урок: A → B"], targetHash: "B" });
  context.record.publishedScheduleHash = "B";
  let attempts = 0;
  context.client.sendMessage = async () => { attempts++; throw Object.assign(new Error("Forbidden"), { errorCode: 403 }); };
  await deliverChangeNotifications(context);
  await deliverChangeNotifications(context);
  assert.equal(attempts, 1);
  assert.equal(context.record.changeNotifications[0].status, "failed");
});
