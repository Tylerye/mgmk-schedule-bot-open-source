import test from "node:test";
import assert from "node:assert/strict";
import { ensureDesiredState } from "../src/reconcile.js";
import { TelegramApiError } from "../src/telegram.js";

const config = { timezone: "Europe/Minsk", pinSwitchTime: "16:00" };
const beforeCutoff = new Date("2026-09-15T09:00:00Z");
const afterCutoff = new Date("2026-09-15T13:01:00Z");

function schedule(date, hash = `hash-${date}`) {
  return {
    date,
    hash,
    displayGroup: "8-Сба",
    lessons: [],
    timeline: [{ type: "lesson", number: 1, start: "08:15", end: "09:00", subject: "Урок", subjectVariants: [], rooms: [], teachers: [] }],
  };
}

function record(date, hash) {
  const value = schedule(date, hash);
  return { schedule: value, scheduleHash: value.hash };
}

function fixture(dates = ["2026-09-15", "2026-09-16"]) {
  const calls = [];
  let nextMessageId = 100;
  const client = {
    async sendMessage(chatId, text, options) {
      const message_id = ++nextMessageId;
      calls.push({ method: "send", chatId, text, options, messageId: message_id });
      return { message_id };
    },
    async editMessage(chatId, messageId, text, options) { calls.push({ method: "edit", chatId, messageId, text, options }); },
    async pinMessage(chatId, messageId) { calls.push({ method: "pin", chatId, messageId }); },
    async unpinOwnMessage(chatId, messageId) { calls.push({ method: "unpin", chatId, messageId }); },
  };
  const store = {
    state: {
      chatId: "-1001",
      schedules: Object.fromEntries(dates.map((date) => [date, record(date)])),
      pinnedSchedule: null,
      pendingUnpinMessageIds: [],
    },
    async save() {},
  };
  const logger = { info() {}, warn() {}, error() {} };
  return { calls, client, store, logger };
}

test("a failing historical message cannot block today's live view or tomorrow's publication", async () => {
  const context = fixture(["2026-09-14", "2026-09-15", "2026-09-16"]);
  const old = context.store.state.schedules["2026-09-14"];
  Object.assign(old, { messageId: 11, messageChatId: "-1001", viewMode: "full", publishedScheduleHash: old.scheduleHash });
  const edit = context.client.editMessage;
  context.client.editMessage = async (chatId, messageId, ...args) => {
    if (messageId === 11) throw new TelegramApiError("editMessageText", "Bad Request: invalid message", 400);
    return edit(chatId, messageId, ...args);
  };
  await assert.rejects(ensureDesiredState({ ...context, config, now: beforeCutoff }), /invalid message/);
  assert.ok(context.store.state.schedules["2026-09-15"].messageId);
  assert.ok(context.store.state.schedules["2026-09-16"].messageId);
  assert.equal(context.store.state.pinnedSchedule.date, "2026-09-15");
});

test("cached renders still hide lessons at their exact end after a state reload", async () => {
  const context = fixture(["2026-09-15"]);
  await ensureDesiredState({ ...context, config, now: new Date("2026-09-15T05:59:59Z") });
  context.store.state = JSON.parse(JSON.stringify(context.store.state));
  context.calls.length = 0;
  await ensureDesiredState({ ...context, config, now: new Date("2026-09-15T05:59:59Z") });
  assert.equal(context.calls.length, 0);
  await ensureDesiredState({ ...context, config, now: new Date("2026-09-15T06:00:00Z") });
  const edits = context.calls.filter(call => call.method === "edit");
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /Учебный день завершён/);
  assert.doesNotMatch(edits[0].text, /1 урок/);
});

test("publishes a future schedule immediately but keeps today's pin before 16:00", async () => {
  const context = fixture();
  const now = new Date("2026-09-15T05:00:00Z");
  await ensureDesiredState({ ...context, config, now });
  const today = context.store.state.schedules["2026-09-15"];
  const tomorrow = context.store.state.schedules["2026-09-16"];
  assert.ok(today.messageId);
  assert.ok(tomorrow.messageId);
  assert.equal(context.store.state.pinnedSchedule.date, "2026-09-15");
  assert.equal(context.store.state.pinnedSchedule.messageId, today.messageId);
  assert.deepEqual(context.calls.filter(({ method }) => method === "pin").map(({ messageId }) => messageId), [today.messageId]);
  assert.equal(context.calls.filter(({ method }) => method === "send").length, 2);

  context.calls.length = 0;
  await ensureDesiredState({ ...context, config, now });
  assert.deepEqual(context.calls, []);
});

test("at 16:00 rotates to the existing future message without sending a duplicate", async () => {
  const context = fixture();
  await ensureDesiredState({ ...context, config, now: new Date("2026-09-15T05:00:00Z") });
  const oldMessageId = context.store.state.schedules["2026-09-15"].messageId;
  const futureMessageId = context.store.state.schedules["2026-09-16"].messageId;
  context.calls.length = 0;

  await ensureDesiredState({ ...context, config, now: afterCutoff });
  assert.equal(context.calls.filter(({ method }) => method === "send").length, 0);
  assert.deepEqual(context.calls.filter(({ method }) => ["pin", "unpin"].includes(method)), [
    { method: "pin", chatId: "-1001", messageId: futureMessageId },
    { method: "unpin", chatId: "-1001", messageId: oldMessageId },
  ]);
  assert.equal(context.store.state.pinnedSchedule.date, "2026-09-16");
});

test("next published teaching day crosses a weekend and switches exactly at Minsk 16:00", async () => {
  const context = fixture(["2026-09-18", "2026-09-21"]);
  await ensureDesiredState({ ...context, config, now: new Date("2026-09-18T12:59:59Z") });
  assert.equal(context.store.state.pinnedSchedule.date, "2026-09-18");
  context.calls.length = 0;
  await ensureDesiredState({ ...context, config, now: new Date("2026-09-18T13:00:00Z") });
  assert.equal(context.store.state.pinnedSchedule.date, "2026-09-21");
  assert.equal(context.calls.some(({ method }) => method === "send"), false);
});

test("migration does not edit historical message IDs in the new chat", async () => {
  const context = fixture();
  const old = context.store.state.schedules["2026-09-15"];
  Object.assign(old, { messageId: 22, messageChatId: "-old", renderHash: "old" });
  context.store.state.pinnedSchedule = { chatId: "-old", date: "2026-09-15", messageId: 22 };
  await ensureDesiredState({ ...context, config, now: new Date("2026-09-16T01:00:00Z") });
  assert.equal(context.calls.some(call => call.method === "edit" && call.messageId === 22), false);
});

test("does not remove the current pin at 16:00 when tomorrow is unavailable", async () => {
  const context = fixture(["2026-09-15"]);
  await ensureDesiredState({ ...context, config, now: beforeCutoff });
  context.calls.length = 0;
  await ensureDesiredState({ ...context, config, now: afterCutoff });
  assert.equal(context.store.state.pinnedSchedule.date, "2026-09-15");
  assert.equal(context.calls.some(({ method }) => method === "unpin"), false);
});

test("a schedule discovered after 16:00 is posted and immediately becomes the pin", async () => {
  const context = fixture(["2026-09-15"]);
  await ensureDesiredState({ ...context, config, now: beforeCutoff });
  const oldMessageId = context.store.state.pinnedSchedule.messageId;
  context.store.state.schedules["2026-09-16"] = record("2026-09-16");
  context.calls.length = 0;

  await ensureDesiredState({ ...context, config, now: afterCutoff });
  assert.equal(context.calls.filter(({ method }) => method === "send").length, 1);
  assert.equal(context.store.state.pinnedSchedule.date, "2026-09-16");
  assert.deepEqual(context.calls.find(({ method }) => method === "unpin"), { method: "unpin", chatId: "-1001", messageId: oldMessageId });
});

test("restart reconciliation catches up after a missed 16:00 boundary", async () => {
  const context = fixture();
  const today = context.store.state.schedules["2026-09-15"];
  const tomorrow = context.store.state.schedules["2026-09-16"];
  Object.assign(today, { messageId: 51, messageChatId: "-1001", publishedScheduleHash: today.scheduleHash, renderHash: "old", viewMode: "compact" });
  Object.assign(tomorrow, { messageId: 52, messageChatId: "-1001", publishedScheduleHash: tomorrow.scheduleHash, renderHash: "old" });
  context.store.state.pinnedSchedule = { chatId: "-1001", date: "2026-09-15", messageId: 51 };

  await ensureDesiredState({ ...context, config, now: afterCutoff });
  assert.equal(context.calls.filter(({ method }) => method === "send").length, 0);
  assert.equal(context.store.state.pinnedSchedule.messageId, 52);
  assert.ok(context.calls.some(({ method, messageId }) => method === "unpin" && messageId === 51));
});

test("a corrected schedule edits its existing Telegram message", async () => {
  const context = fixture(["2026-09-15"]);
  const current = context.store.state.schedules["2026-09-15"];
  Object.assign(current, { messageId: 61, messageChatId: "-1001", publishedScheduleHash: "old-hash", renderHash: "old", viewMode: "compact" });
  context.store.state.pinnedSchedule = { chatId: "-1001", date: "2026-09-15", messageId: 61 };

  await ensureDesiredState({ ...context, config, now: new Date("2026-09-15T05:00:00Z") });
  assert.equal(context.calls.filter(({ method }) => method === "edit").length, 1);
  assert.equal(context.calls.filter(({ method }) => method === "send").length, 0);
  assert.equal(current.corrected, true);
  assert.equal(current.publishedScheduleHash, current.scheduleHash);
  assert.match(context.calls.find(({ method }) => method === "edit").text, /^<b>Расписание обновлено/);
});

test("a corrected PDF shows the actual lesson changes in the same message", async () => {
  const context = fixture(["2026-09-15"]);
  const current = context.store.state.schedules["2026-09-15"];
  const previous = structuredClone(current.schedule);
  previous.timeline[0].subject = "Математика";
  previous.timeline[0].rooms = ["328"];
  current.schedule.timeline[0].subject = "Физика";
  current.schedule.timeline[0].rooms = ["329"];
  Object.assign(current, {
    messageId: 61, messageChatId: "-1001", publishedScheduleHash: "old-hash",
    publishedSchedule: previous, renderHash: "old", viewMode: "compact",
  });
  context.store.state.pinnedSchedule = { chatId: "-1001", date: "2026-09-15", messageId: 61 };

  const now = new Date("2026-09-15T05:00:00Z");
  await ensureDesiredState({ ...context, config, now });
  const edit = context.calls.find(({ method }) => method === "edit");
  assert.match(edit.text, /Что изменилось:/);
  assert.match(edit.text, /<b>Расписание обновлено\nЧто изменилось:\n• 1 урок: Математика → Физика<\/b>/);
  assert.doesNotMatch(edit.text, /1 урок, кабинет: 328 → 329/);
  const alerts = context.calls.filter(({ method }) => method === "send");
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /^<b>Расписание обновлено — вторник, 15 сентября<\/b>\n1 урок: Математика → Физика$/);
  assert.equal(alerts[0].options, undefined);
  assert.equal(context.calls.some(call => call.method === "pin" && call.messageId === alerts[0].messageId), false);
  assert.equal(current.publishedSchedule.timeline[0].rooms[0], "329");

  context.calls.length = 0;
  await ensureDesiredState({ ...context, config, now });
  assert.equal(context.calls.filter(({ method }) => method === "edit").length, 0);
  assert.equal(context.calls.filter(({ method }) => method === "send").length, 0);
});

async function correctionFixture() {
  const context = fixture(["2026-09-16"]);
  await ensureDesiredState({ ...context, config, now: beforeCutoff });
  context.calls.length = 0;
  const current = context.store.state.schedules["2026-09-16"];
  return { context, current };
}

test("one correction alert combines replacement, addition and cancellation; returning subjects are new transitions", async () => {
  const { context, current } = await correctionFixture();
  const old = structuredClone(current.schedule);
  current.schedule.timeline[0].subject = "Физика <&>";
  current.schedule.timeline.push({ ...current.schedule.timeline[0], number: 2 });
  current.scheduleHash = "B";
  await ensureDesiredState({ ...context, config, now: beforeCutoff });
  let alerts = context.calls.filter(call => call.method === "send");
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /1 урок: Урок → Физика &lt;&amp;&gt;/);
  assert.match(alerts[0].text, /2 урок добавлен:/);
  context.calls.length = 0;
  current.schedule = old;
  current.scheduleHash = old.hash;
  await ensureDesiredState({ ...context, config, now: beforeCutoff });
  assert.match(context.calls.find(call => call.method === "send").text, /2 урок отменён:/);
  context.calls.length = 0;
  current.schedule.timeline[0].subject = "Физика <&>";
  current.scheduleHash = "B";
  await ensureDesiredState({ ...context, config, now: beforeCutoff });
  assert.equal(context.calls.filter(call => call.method === "send").length, 1);
  assert.equal(current.changeNotifications.length, 3);
});

test("room, teacher and time corrections edit the schedule without alerts", async () => {
  const { context, current } = await correctionFixture();
  Object.assign(current.schedule.timeline[0], { rooms: ["329"], teachers: ["Тест"], start: "08:20" });
  current.scheduleHash = "room-time";
  await ensureDesiredState({ ...context, config, now: beforeCutoff });
  assert.ok(context.calls.some(call => call.method === "edit"));
  assert.equal(context.calls.filter(call => call.method === "send").length, 0);
});

test("alert intent survives edit failure and restart and is delivered only after the publication is updated", async () => {
  const { context, current } = await correctionFixture();
  current.schedule.timeline[0].subject = "Физика";
  current.scheduleHash = "B";
  const edit = context.client.editMessage;
  context.client.editMessage = async () => { throw new TelegramApiError("editMessageText", "network request failed"); };
  await assert.rejects(ensureDesiredState({ ...context, config, now: beforeCutoff }));
  assert.equal(current.changeNotifications[0].status, "pending");
  assert.equal(context.calls.length, 0);
  context.store.state = structuredClone(context.store.state);
  context.client.editMessage = edit;
  await ensureDesiredState({ ...context, config, now: beforeCutoff });
  assert.equal(context.store.state.schedules["2026-09-16"].changeNotifications.length, 1);
  assert.equal(context.calls.filter(call => call.method === "send").length, 1);
  assert.equal(context.calls[0].method, "edit");
});

test("send timeout is recorded as uncertain and never blindly retried", async () => {
  const { context, current } = await correctionFixture();
  current.schedule.timeline[0].subject = "Физика";
  current.scheduleHash = "B";
  let attempts = 0;
  context.client.sendMessage = async () => { attempts++; throw new TelegramApiError("sendMessage", "network request failed"); };
  await ensureDesiredState({ ...context, config, now: beforeCutoff });
  assert.equal(current.changeNotifications[0].status, "uncertain");
  context.store.state = structuredClone(context.store.state);
  await ensureDesiredState({ ...context, config, now: beforeCutoff });
  assert.equal(attempts, 1);
});

test("known Telegram rate limiting retries after its delay without blocking reconcile", async () => {
  const { context, current } = await correctionFixture();
  current.schedule.timeline[0].subject = "Физика";
  current.scheduleHash = "B";
  const send = context.client.sendMessage;
  let attempts = 0;
  context.client.sendMessage = async (...args) => {
    if (++attempts === 1) throw new TelegramApiError("sendMessage", "Too Many Requests", 429, { retry_after: 120 });
    return send(...args);
  };
  await ensureDesiredState({ ...context, config, now: beforeCutoff });
  await ensureDesiredState({ ...context, config, now: beforeCutoff });
  assert.equal(attempts, 1);
  await ensureDesiredState({ ...context, config, now: new Date(beforeCutoff.getTime() + 120000) });
  assert.equal(attempts, 2);
  assert.equal(current.changeNotifications[0].status, "sent");
});

test("existing publications gain a comparison snapshot without an extra Telegram edit", async () => {
  const context = fixture(["2026-09-15"]);
  const now = new Date("2026-09-15T05:00:00Z");
  await ensureDesiredState({ ...context, config, now });
  const record = context.store.state.schedules["2026-09-15"];
  delete record.publishedSchedule;
  context.calls.length = 0;

  await ensureDesiredState({ ...context, config, now });

  assert.deepEqual(record.publishedSchedule, record.schedule);
  assert.equal(context.calls.length, 0);
});

test("after the final lesson, today's unpinned message is a completion card with a show-all button", async () => {
  const context = fixture();
  const today = context.store.state.schedules["2026-09-15"];
  const nextDay = context.store.state.schedules["2026-09-16"];
  Object.assign(today, { messageId: 91, messageChatId: "-1001", publishedScheduleHash: today.scheduleHash, renderHash: "old", viewMode: "compact" });
  Object.assign(nextDay, { messageId: 92, messageChatId: "-1001", publishedScheduleHash: nextDay.scheduleHash, renderHash: "old", viewMode: "compact" });
  context.store.state.pinnedSchedule = { chatId: "-1001", date: "2026-09-15", messageId: 91 };

  await ensureDesiredState({ ...context, config, now: afterCutoff });

  const edit = context.calls.find((call) => call.method === "edit" && call.messageId === 91);
  assert.ok(edit);
  assert.match(edit.text, /Вторник, 15 сентября/);
  assert.match(edit.text, /Учебный день завершён/);
  assert.doesNotMatch(edit.text, /Расписание обновлено/);
  assert.equal(edit.options.replyMarkup.inline_keyboard[0][0].text, "📋 Показать всё");
  assert.equal(context.calls.filter(({ method }) => method === "send").length, 0);
  assert.equal(context.store.state.pinnedSchedule.date, "2026-09-16");
});

test("user can expand a completed schedule after the next day's pin rotation", async () => {
  const context = fixture();
  const today = context.store.state.schedules["2026-09-15"];
  const nextDay = context.store.state.schedules["2026-09-16"];
  Object.assign(today, { messageId: 93, messageChatId: "-1001", publishedScheduleHash: today.scheduleHash, renderHash: "old", viewMode: "compact" });
  Object.assign(nextDay, { messageId: 94, messageChatId: "-1001", publishedScheduleHash: nextDay.scheduleHash, renderHash: "old", viewMode: "compact" });
  context.store.state.pinnedSchedule = { chatId: "-1001", date: "2026-09-15", messageId: 93 };

  await ensureDesiredState({ ...context, config, now: afterCutoff });
  assert.equal(today.viewMode, "compact");
  assert.equal(today.completionViewInitialized, true);
  assert.equal(context.store.state.pinnedSchedule.date, "2026-09-16");

  today.viewMode = "full";
  context.calls.length = 0;
  await ensureDesiredState({ ...context, config, now: afterCutoff });
  assert.equal(today.viewMode, "full");
  const edit = context.calls.find((call) => call.method === "edit" && call.messageId === 93);
  assert.ok(edit);
  assert.match(edit.text, /1 урок/);
  assert.equal(edit.options.replyMarkup.inline_keyboard[0][0].text, "↩️ Только актуальное");
});

test("reconcile refreshes an already expanded historical schedule without reposting it", async () => {
  const context = fixture(["2026-09-24", "2026-09-25"]);
  const past = context.store.state.schedules["2026-09-24"];
  const today = context.store.state.schedules["2026-09-25"];
  Object.assign(past, { messageId: 222, messageChatId: "-1001", publishedScheduleHash: past.scheduleHash, renderHash: "old", viewMode: "full" });
  Object.assign(today, { messageId: 223, messageChatId: "-1001", publishedScheduleHash: today.scheduleHash, renderHash: "current", viewMode: "compact" });
  context.store.state.pinnedSchedule = { chatId: "-1001", date: "2026-09-25", messageId: 223 };
  context.calls.length = 0;

  await ensureDesiredState({ ...context, config, now: new Date("2026-09-25T09:00:00Z") });

  const edit = context.calls.find((call) => call.method === "edit" && call.messageId === 222);
  assert.ok(edit);
  assert.match(edit.text, /Прошедшие уроки — 8-Сба/);
  assert.doesNotMatch(edit.text, /Учебный день завершён/);
  assert.equal(context.calls.filter(({ method }) => method === "send").length, 0);
  assert.equal(context.calls.filter(({ method }) => ["pin", "unpin"].includes(method)).length, 0);
});

test("an uneditable corrected message is replaced only as a fallback", async () => {
  const context = fixture(["2026-09-15"]);
  const current = context.store.state.schedules["2026-09-15"];
  Object.assign(current, { messageId: 71, messageChatId: "-1001", publishedScheduleHash: "old-hash", renderHash: "old", viewMode: "compact" });
  context.store.state.pinnedSchedule = { chatId: "-1001", date: "2026-09-15", messageId: 71 };
  context.client.editMessage = async (...args) => {
    context.calls.push({ method: "edit", args });
    if (context.calls.filter(({ method }) => method === "edit").length === 1) {
      throw new TelegramApiError("editMessageText", "message can't be edited", 400);
    }
  };

  await ensureDesiredState({ ...context, config, now: beforeCutoff });
  assert.equal(context.calls.filter(({ method }) => method === "send").length, 1);
  assert.notEqual(current.messageId, 71);
  assert.ok(context.calls.some(({ method, messageId }) => method === "unpin" && messageId === 71));
});

test("message is not modified is accepted as an idempotent edit", async () => {
  const context = fixture(["2026-09-15"]);
  const current = context.store.state.schedules["2026-09-15"];
  Object.assign(current, { messageId: 81, messageChatId: "-1001", publishedScheduleHash: current.scheduleHash, renderHash: "stale", viewMode: "compact" });
  context.store.state.pinnedSchedule = { chatId: "-1001", date: "2026-09-15", messageId: 81 };
  context.client.editMessage = async () => { throw new TelegramApiError("editMessageText", "message is not modified", 400); };
  await ensureDesiredState({ ...context, config, now: beforeCutoff });
  assert.notEqual(current.renderHash, "stale");
});

test("missing pin permission is nonfatal, cached, and does not duplicate the schedule", async () => {
  const context = fixture(["2026-09-15"]);
  let capabilityChecks = 0;
  context.client.getPinCapability = async () => {
    capabilityChecks += 1;
    return { canPin: false, status: "member" };
  };

  const first = await ensureDesiredState({ ...context, config, now: beforeCutoff });
  assert.equal(first.canPin, false);
  assert.equal(context.calls.filter(({ method }) => method === "send").length, 1);
  assert.equal(context.calls.filter(({ method }) => method === "pin").length, 0);
  assert.equal(context.store.state.schedules["2026-09-15"].messageId, 101);
  assert.equal(context.store.state.pinnedSchedule, null);
  assert.equal(capabilityChecks, 1);

  context.calls.length = 0;
  await ensureDesiredState({ ...context, config, now: new Date(beforeCutoff.getTime() + 60_000) });
  assert.equal(context.calls.filter(({ method }) => ["send", "edit", "pin"].includes(method)).length, 0);
  assert.equal(capabilityChecks, 1);
});

test("pinning starts automatically after permission becomes available", async () => {
  const context = fixture(["2026-09-15"]);
  let canPin = false;
  context.client.getPinCapability = async () => ({ canPin, status: canPin ? "administrator" : "member" });

  await ensureDesiredState({ ...context, config, now: beforeCutoff });
  const messageId = context.store.state.schedules["2026-09-15"].messageId;
  canPin = true;
  context.calls.length = 0;
  await ensureDesiredState({ ...context, config, now: new Date(beforeCutoff.getTime() + 6 * 60_000) });

  assert.deepEqual(context.calls.find(({ method }) => method === "pin"), { method: "pin", chatId: "-1001", messageId });
  assert.equal(context.store.state.pinnedSchedule.messageId, messageId);
  assert.equal(context.calls.some(({ method }) => method === "send"), false);
});

test("pinChatMessage permission errors are warnings rather than reconciliation failures", async () => {
  const context = fixture(["2026-09-15"]);
  context.client.getPinCapability = async () => ({ canPin: true, status: "administrator" });
  context.client.pinMessage = async () => {
    throw new TelegramApiError("pinChatMessage", "Bad Request: not enough rights to manage pinned messages in the chat", 400);
  };

  const result = await ensureDesiredState({ ...context, config, now: beforeCutoff });
  assert.equal(result.canPin, false);
  assert.equal(context.store.state.pinCapability.status, "permission-denied");
  assert.equal(context.store.state.pinnedSchedule, null);
  assert.equal(context.calls.filter(({ method }) => method === "send").length, 1);
});
