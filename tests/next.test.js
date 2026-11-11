import test from "node:test";
import assert from "node:assert/strict";
import { selectNextEvent, formatNextMessage } from "../src/schedule/next.js";
import { processTelegramUpdates } from "../src/telegram.js";

const date = "2026-10-01";
const at = (time) => new Date(`${date}T${time}:00+03:00`);
const lesson = (number, start, end) => ({ type: "lesson", number, start, end, subject: "Математика <&>", rooms: ["328", "329" ] });
const schedule = { date, timeline: [lesson(1, "08:15", "09:00"),
  { type: "break", start: "09:00", end: "09:10" }, lesson(2, "09:10", "09:55"),
  { type: "lunch", start: "09:55", end: "10:15" }, lesson(3, "10:15", "11:00"),
  { type: "lunch", start: "11:00", end: "11:40" },
  { type: "information_hour", start: "11:40", end: "12:00" },
  { type: "large_break", start: "12:00", end: "12:10" },
  { type: "curator_hour", start: "12:10", end: "12:30", room: "Актовый зал" }] };

for (const [time, status, minutes] of [["08:00", "next", 15], ["08:15", "current", 45],
  ["08:59", "current", 1], ["09:00", "next", 10], ["09:10", "current", 45],
  ["09:55", "next", 20], ["11:00", "next", 40], ["11:40", "current", 20],
  ["12:00", "next", 10], ["12:10", "current", 20], ["12:30", "finished", undefined]]) {
  test(`next event boundary ${time}`, () => {
    const result = selectNextEvent(schedule, at(time));
    assert.equal(result.status, status);
    assert.equal(result.minutes, minutes);
  });
}
test("next formatting escapes subjects and displays multiple rooms without mutating timeline", () => {
  const before = structuredClone(schedule);
  const text = formatNextMessage(schedule, { now: at("08:15") });
  assert.match(text, /Математика &lt;&amp;&gt;/);
  assert.match(text, /328 \/ 329/);
  assert.match(text, /До конца: 45 мин/);
  assert.deepEqual(schedule, before);
});
test("finished next reply has no trailing period", () => {
  assert.equal(formatNextMessage(schedule, { now: at("12:30") }), "На сегодняшний день занятия окончены\n\nНовое расписание появится здесь, когда колледж его опубликует");
});
test("next formats pauses and additional class locations", () => {
  assert.match(formatNextMessage(schedule, { now: at("09:00") }), /Перемена/);
  for (const time of ["09:55", "11:00"]) assert.match(formatNextMessage(schedule, { now: at(time) }), /Большая перемена/);
  assert.match(formatNextMessage(schedule, { now: at("12:00") }), /Большая перемена/);
  assert.match(formatNextMessage(schedule, { now: at("11:40") }), /329 \(если куратор/);
  assert.match(formatNextMessage(schedule, { now: at("12:10") }), /Актовый зал/);
});
test("missing date, empty schedule, unknown times and rooms remain honest", () => {
  assert.equal(selectNextEvent(undefined, at("08:00")).status, "missing");
  assert.equal(selectNextEvent(schedule, new Date("2026-10-01T21:00:00Z")).status, "missing");
  assert.equal(selectNextEvent({ date, timeline: [] }, at("08:00")).status, "empty");
  for (const start of [null, "25:00", "09:10"]) {
    assert.equal(selectNextEvent({ date, timeline: [lesson(1, start, "09:00")] }, at("08:00")).status, "unknown");
  }
  const fallback = { date, lessons: [{ number: 1, subject: "Тест", time: ["08:15", "09:00"] }] };
  assert.match(formatNextMessage(fallback, { now: at("08:15") }), /Кабинет не указан/);
});
test("next command replies once to configured group including mention, ignores other chats and advances offset", async () => {
  for (const text of ["/next", "/next@mgmk_8cba_schedule_bot"]) {
    const calls = [];
    const store = { state: { chatId: "-300", updateOffset: 0, schedules: { [date]: { schedule } } }, async save() {} };
    const before = structuredClone(store.state.schedules);
    const client = { async sendMessage(...args) { calls.push(args); } };
    const updates = [
      { update_id: 1, message: { text, from: { id: 99 }, chat: { id: 99, type: "private" } } },
      { update_id: 2, message: { text, from: { id: 99 }, chat: { id: -999, type: "supergroup" } } },
      { update_id: 3, message: { text, from: { id: 99 }, chat: { id: -300, type: "supergroup" } } },
    ];
    await processTelegramUpdates({ updates, store, client, config: { timezone: "Europe/Minsk" }, now: at("08:00"),
      reconcile: () => { throw new Error("next must not reconcile"); } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "-300");
    assert.equal(calls[0].length, 2);
    assert.equal(store.state.updateOffset, 4);
    assert.deepEqual(store.state.schedules, before);
  }
});
