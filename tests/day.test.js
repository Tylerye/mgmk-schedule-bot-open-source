import test from "node:test";
import assert from "node:assert/strict";
import { formatDaySummary } from "../src/schedule/day.js";
import { processTelegramUpdates } from "../src/telegram.js";

const date = "2026-10-02";
const lesson = (number, start, end) => ({ type: "lesson", number, start, end });
const schedule = { date, timeline: [lesson(2, "09:10", "09:55"),
  { type: "lunch", start: "09:55", end: "10:15" }, lesson(3, "10:15", "11:00"),
  { type: "break", start: "11:00", end: "11:10" }, lesson(4, "11:10", "11:55"),
  { type: "lunch", start: "11:55", end: "12:35" },
  { type: "curator_hour", start: "12:35", end: "13:20" },
  { type: "lunch", start: "13:20", end: "13:40" }] };

test("day summary uses actual first and final class and only meals within the teaching day", () => {
  const before = structuredClone(schedule);
  const text = formatDaySummary(schedule, { date });
  assert.match(text, /Пятница, 2 октября/);
  assert.match(text, /^<b>Пятница, 2 октября<\/b>/);
  assert.doesNotMatch(text, /📅/);
  assert.match(text, /Начало: со 2 урока в 09:10/);
  assert.match(text, /Окончание: в 13:20/);
  assert.match(text, /Всего 3 урока \+ кураторский час/);
  assert.match(text, /Большая перемена 09:55–10:15/);
  assert.match(text, /Большая перемена 11:55–12:35/);
  assert.doesNotMatch(text, /13:20–13:40|Перемена/);
  assert.equal(text.split("\n").some(line => line.endsWith(".")), false);
  assert.deepEqual(schedule, before);
});
test("day summary handles missing dates, empty days and unknown times honestly", () => {
  assert.equal(formatDaySummary(undefined, { date }), "Расписание на завтра ещё не опубликовано");
  assert.equal(formatDaySummary(schedule, { date: "2026-10-03" }), "Расписание на завтра ещё не опубликовано");
  assert.match(formatDaySummary({ date, timeline: [] }), /Занятий нет/);
  assert.match(formatDaySummary({ date, lessons: [{ number: 1 }] }), /Время начала и окончания занятий неизвестно/);
  assert.match(formatDaySummary({ date, timeline: [lesson(1, "25:00", "26:00")] }), /неизвестно/);
});
test("day summary can start with an information hour and counts nonconsecutive lessons", () => {
  const text = formatDaySummary({ date, timeline: [{ type: "information_hour", start: "08:00", end: "08:20" },
    lesson(6, "09:00", "09:45")] });
  assert.match(text, /Начало: в 08:00 — информационный час/);
  assert.match(text, /Всего 1 урок \+ информационный час/);
});
test("day command uses tomorrow in Minsk, replies once, ignores other chats and leaves schedules intact", async () => {
  for (const text of ["/day", "/day@mgmk_8cba_schedule_bot"]) {
    const calls = [];
    const store = { state: { chatId: "-300", updateOffset: 0, schedules: { [date]: { schedule } } }, async save() {} };
    const before = structuredClone(store.state.schedules);
    const updates = [
      { update_id: 1, message: { text, from: { id: 99 }, chat: { id: 99, type: "private" } } },
      { update_id: 2, message: { text, from: { id: 99 }, chat: { id: -999, type: "supergroup" } } },
      { update_id: 3, message: { text, from: { id: 99 }, chat: { id: -300, type: "supergroup" } } },
    ];
    await processTelegramUpdates({ updates, store, client: { async sendMessage(...args) { calls.push(args); } },
      config: { timezone: "Europe/Minsk" }, now: new Date("2026-10-01T20:59:00Z"),
      reconcile() { throw new Error("day must not reconcile"); } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 2);
    assert.match(calls[0][1], /Пятница, 2 октября/);
    assert.deepEqual(store.state.schedules, before);
    calls.length = 0;
    await processTelegramUpdates({ updates: [updates[2]], store, client: { async sendMessage(...args) { calls.push(args); } },
      config: { timezone: "Europe/Minsk" }, now: new Date("2026-10-01T21:00:00Z") });
    assert.equal(calls[0][1], "Расписание на завтра ещё не опубликовано");
  }
});
