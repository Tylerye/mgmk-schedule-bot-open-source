import test from "node:test";
import assert from "node:assert/strict";
import { describeScheduleChanges } from "../src/schedule/changes.js";

const lesson = (number, subject, rooms = [], teachers = []) => ({ number, subject, rooms, teachers, start: "09:10", end: "09:55" });

test("describes only subject, added and removed lesson changes", () => {
  const before = { lessons: [lesson(1, "Математика", ["328"], ["Иванова"]), lesson(2, "История")] };
  const after = { lessons: [lesson(1, "Физика", ["329"], ["Петров"]), lesson(3, "Белорусский язык")] };
  assert.deepEqual(describeScheduleChanges(before, after), [
    "1 урок: Математика → Физика",
    "2 урок убран: История",
    "3 урок добавлен: Белорусский язык",
  ]);
});

test("ignores room, teacher and bell changes", () => {
  const before = { lessons: [lesson(1, "А", ["1"], ["А"])] };
  const after = { lessons: [lesson(1, "Б", ["2"], ["Б"])] };
  assert.deepEqual(describeScheduleChanges(before, after), ["1 урок: А → Б"]);
  assert.deepEqual(describeScheduleChanges(before, before), []);
});

test("compares lesson time from the published timeline when raw lessons have no bell times", () => {
  const raw = [{ number: 1, subject: "Физика", rooms: ["329"], teachers: [] }];
  const before = { lessons: raw, timeline: [{ type: "lesson", ...raw[0], start: "09:10", end: "09:55" }] };
  const after = { lessons: raw, timeline: [{ type: "lesson", ...raw[0], start: "09:20", end: "10:05" }] };
  assert.deepEqual(describeScheduleChanges(before, after), []);
});
