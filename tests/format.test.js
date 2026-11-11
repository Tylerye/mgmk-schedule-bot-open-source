import test from "node:test";
import assert from "node:assert/strict";
import { formatScheduleMessage } from "../src/schedule/format.js";

const schedule = {
  displayGroup: "8-Сба",
  date: "2026-09-15",
  lessons: [],
  timeline: [
    { type: "lesson", number: 1, start: "08:15", end: "09:00", subject: "МАТЕМАТИКА", subjectVariants: [], rooms: ["245"], teachers: ["Чуприс А.В."] },
    { type: "break", start: "09:00", end: "09:10" },
    { type: "lunch", start: "10:50", end: "11:10" },
    { type: "large_break", start: "11:55", end: "12:15" },
    { type: "large_break", start: "13:00", end: "13:30" },
    { type: "break", start: "14:15", end: "14:20" },
  ],
};

test("formats Telegram HTML with the production header and explicit interval types", () => {
  const message = formatScheduleMessage(schedule);
  assert.match(message, /^📚 Расписание — 8-Сба$/m);
  assert.match(message, /📅 Вторник, 15 сентября/);
  assert.match(message, /<b>1 урок · 08:15–09:00<\/b>/);
  assert.match(message, /🚪 Кабинет: 245/);
  assert.doesNotMatch(message, /<u>🚪/);
  assert.match(message, /☕ Перемена · 10 минут · 09:00–09:10/);
  assert.match(message, /<u>🍽 ОБЕД · 20 минут · 10:50–11:10<\/u>/);
  assert.match(message, /🌿 Большая перемена · 20 минут · 11:55–12:15/);
  assert.match(message, /🌿 Большая перемена · 30 минут · 13:00–13:30/);
  assert.match(message, /☕ Перемена · 5 минут · 14:15–14:20/);
  assert.equal((message.match(/ОБЕД/gu) ?? []).length, 1);
  assert.doesNotMatch(message, /undefined|null/);
});

test("escapes parsed data without escaping formatter markup", () => {
  const unsafe = structuredClone(schedule);
  unsafe.timeline = [{
    type: "lesson", number: 1, start: "08:15", end: "09:00",
    subject: "A&B <основы>", subjectVariants: [], rooms: ["<101>"], teachers: ["Иванов & Петров"],
  }];
  const message = formatScheduleMessage(unsafe);
  assert.match(message, /📖 A&amp;B &lt;основы&gt;/);
  assert.match(message, /🚪 Кабинет: &lt;101&gt;/);
  assert.doesNotMatch(message, /<u>🚪/);
  assert.match(message, /👤 Иванов &amp; Петров/);
  assert.doesNotMatch(message, /<основы>|<101>/);
});

test("marks a corrected schedule", () => {
  assert.match(formatScheduleMessage(schedule, { updated: true }), /^<b>Расписание обновлено<\/b>/);
  const detail = formatScheduleMessage(schedule, { updated: true, changeSummary: [
    "1 урок, предмет: Биология → Математика",
    "1 урок, кабинет: <328> → 329",
    "1 урок, преподаватель: Иванова → Петров",
  ] });
  assert.match(detail, /^<b>Расписание обновлено\nЧто изменилось:\n• 1 урок: Биология → Математика<\/b>/);
  assert.doesNotMatch(detail, /кабинет: &lt;328&gt;|преподаватель: Иванова|🔄/);
  const onlyRoom = formatScheduleMessage(schedule, { updated: true, changeSummary: ["1 урок, кабинет: 328 → 329"] });
  assert.doesNotMatch(onlyRoom, /Что изменилось|кабинет: 328 → 329/);
  const escaped = formatScheduleMessage(schedule, { updated: true, changeSummary: ["1 урок: Биология → <Математика>"] });
  assert.match(escaped, /Биология → &lt;Математика&gt;/);
});
