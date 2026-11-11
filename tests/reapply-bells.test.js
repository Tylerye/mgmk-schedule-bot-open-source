import test from "node:test";
import assert from "node:assert/strict";
import bells from "../config/bells.json" with { type: "json" };
import { reapplyFutureBellSchedule } from "../src/schedule/reapply-bells.js";

function schedule(date) {
  return {
    date,
    group: "8Са",
    canonicalGroup: "8CA",
    lessons: [
      { number: 7, subject: "Предмет 7", subjectVariants: [], rooms: [], teachers: [] },
      { number: 8, subject: "Предмет 8", subjectVariants: [], rooms: [], teachers: [] },
    ],
  };
}

test("bell revision survives reload and invalidates on new parser result or configuration", () => {
  let state = { schedules: { day: { schedule: schedule("2026-10-05") } } };
  reapplyFutureBellSchedule(state, { bells, displayGroup: "8-Сба" });
  state = JSON.parse(JSON.stringify(state));
  const record = state.schedules.day;
  const previous = record.schedule;
  assert.equal(reapplyFutureBellSchedule(state, { bells, displayGroup: "8-Сба" }), 0);
  assert.equal(record.schedule, previous);
  record.scheduleHash = "new-parser-hash";
  assert.equal(reapplyFutureBellSchedule(state, { bells, displayGroup: "8-Сба" }), 1);
  const revision = record.bellRevision;
  reapplyFutureBellSchedule(state, { bells: { ...bells, effectiveFrom: "2026-09-27" }, displayGroup: "8-Сба" });
  assert.notEqual(record.bellRevision, revision);
});

test("reapplies new bells to future records and keeps the published version for change notes", () => {
  const before = schedule("2026-09-28");
  const record = {
    schedule: { ...before, hash: "old-hash", timeline: [
      { type: "lesson", ...before.lessons[0], start: "15:15", end: "16:00" },
      { type: "lesson", ...before.lessons[1], start: "16:10", end: "16:55" },
    ] },
    scheduleHash: "old-hash",
    messageId: 244,
    messageChatId: "-1001",
    publishedScheduleHash: "old-hash",
  };
  const state = { schedules: { [before.date]: record } };

  assert.equal(reapplyFutureBellSchedule(state, { bells, displayGroup: "8-Сба" }), 1);
  assert.equal(record.schedule.timeline.find((event) => event.number === 8).end, "17:10");
  assert.equal(record.publishedSchedule.timeline.find((event) => event.number === 8).end, "16:55");
  assert.notEqual(record.scheduleHash, record.publishedScheduleHash);
});

test("does not rewrite schedules before the new table effective date", () => {
  const previous = schedule("2026-09-25");
  const record = { schedule: previous, scheduleHash: "existing-hash" };
  const state = { schedules: { [previous.date]: record } };

  assert.equal(reapplyFutureBellSchedule(state, { bells, displayGroup: "8-Сба" }), 0);
  assert.equal(record.schedule, previous);
  assert.equal(record.scheduleHash, "existing-hash");
});

test("unchanged bells survive reload without rebuilding, while a new parsed schedule invalidates the cache", () => {
  const record = { schedule: schedule("2026-10-08"), scheduleHash: "old" };
  const state = { schedules: { "2026-10-08": record } };
  reapplyFutureBellSchedule(state, { bells, displayGroup: "8-Сба" });
  const reloaded = JSON.parse(JSON.stringify(state));
  const unchanged = reloaded.schedules["2026-10-08"].schedule;
  assert.equal(reapplyFutureBellSchedule(reloaded, { bells, displayGroup: "8-Сба" }), 0);
  assert.equal(reloaded.schedules["2026-10-08"].schedule, unchanged);
  const next = reloaded.schedules["2026-10-08"];
  next.schedule.lessons.push({ number: 6, subject: "Новый урок", rooms: [], teachers: [] });
  next.scheduleHash = "new-parser-result";
  assert.equal(reapplyFutureBellSchedule(reloaded, { bells, displayGroup: "8-Сба" }), 1);
  assert.ok(next.schedule.timeline.some(event => event.number === 6));
});
