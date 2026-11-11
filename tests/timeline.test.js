import test from "node:test";
import assert from "node:assert/strict";
import bells from "../config/bells.json" with { type: "json" };
import { applyBellSchedule } from "../src/schedule/parse.js";
import { buildScheduleTimeline } from "../src/schedule/timeline.js";

function lessons(...numbers) {
  return numbers.map((number) => ({ number, subject: `Предмет ${number}`, subjectVariants: [], rooms: [], teachers: [] }));
}

test("the new bell table shows two short meal breaks and one 40-minute meal on weekdays", () => {
  for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday"]) {
    const events = bells[day];
    const lunches = events.filter((event) => event.type === "lunch");
    assert.deepEqual(lunches.map(({ start, end }) => [start, end]), day === "thursday"
      ? [["11:20", "11:40"], ["12:25", "12:45"], ["13:30", "14:10"]]
      : [["10:50", "11:10"], ["11:55", "12:15"], ["13:00", "13:40"]]);
  }
  assert.equal(bells.saturday.filter((event) => event.type === "lunch").length, 0);
});

test("uses the new Tuesday meal breaks and 8th lesson end time", () => {
  const timeline = buildScheduleTimeline(lessons(1, 2, 3, 4, 5, 6, 7, 8), bells.tuesday);
  assert.ok(timeline.some((event) => event.type === "break" && event.start === "09:00" && event.end === "09:10"));
  assert.equal(timeline.filter((event) => event.type === "lunch").length, 3);
  assert.ok(timeline.some((event) => event.type === "lunch" && event.start === "13:00" && event.end === "13:40"));
  assert.equal(timeline.find((event) => event.type === "lesson" && event.number === 8).end, "16:15");
});

test("adds Monday curator hour without renumbering lesson 7", () => {
  const timeline = buildScheduleTimeline(lessons(6, 7), bells.monday);
  assert.deepEqual(timeline.map(({ type, number, start, end }) => ({ type, number, start, end })), [
    { type: "lesson", number: 6, start: "13:40", end: "14:25" },
    { type: "break", number: undefined, start: "14:25", end: "14:35" },
    { type: "curator_hour", number: undefined, start: "14:35", end: "15:20" },
    { type: "break", number: undefined, start: "15:20", end: "15:30" },
    { type: "lesson", number: 7, start: "15:30", end: "16:15" },
  ]);
});

test("adds Thursday information hour without renumbering lesson 7", () => {
  const timeline = buildScheduleTimeline(lessons(6, 7), bells.thursday);
  assert.ok(timeline.some((event) => event.type === "information_hour" && event.start === "11:00" && event.end === "11:20"));
  assert.equal(timeline.find((event) => event.type === "lesson" && event.number === 7).start, "15:05");
});

test("switches bell tables on Monday while preserving times on older schedules", () => {
  const oldSchedule = applyBellSchedule({ date: "2026-09-21", canonicalGroup: "8CA", lessons: lessons(7, 8) }, { bells });
  const newSchedule = applyBellSchedule({ date: "2026-09-28", canonicalGroup: "8CA", lessons: lessons(7, 8) }, { bells });
  assert.equal(oldSchedule.timeline.find((event) => event.number === 8).end, "16:55");
  assert.equal(newSchedule.timeline.find((event) => event.number === 8).end, "17:10");
  assert.equal(newSchedule.timeline.find((event) => event.type === "curator_hour").start, "14:35");
});

test("does not invent a missing lesson or orphaned long-gap events", () => {
  const timeline = buildScheduleTimeline(lessons(1, 3), bells.tuesday);
  assert.deepEqual(timeline.filter((event) => event.type === "lesson").map((event) => event.number), [1, 3]);
  assert.equal(timeline.some((event) => event.type === "lesson" && event.number === 2), false);
  assert.equal(timeline.some((event) => event.type === "lunch"), false);
  assert.equal(timeline.at(-1).type, "lesson");
});
