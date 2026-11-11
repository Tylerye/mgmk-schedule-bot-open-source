import test from "node:test";
import assert from "node:assert/strict";
import { formatScheduleMessage, scheduleKeyboard } from "../src/schedule/format.js";

const schedule = {
  displayGroup: "8-Сба",
  date: "2026-09-15",
  lessons: [],
  timeline: [
    { type: "lesson", number: 1, start: "08:15", end: "09:00", subject: "Первый", subjectVariants: [], rooms: ["1"], teachers: ["А.А."] },
    { type: "break", start: "09:00", end: "09:10" },
    { type: "lesson", number: 2, start: "09:10", end: "09:55", subject: "Второй", subjectVariants: [], rooms: ["2"], teachers: ["Б.Б."] },
    { type: "lesson", number: 3, start: "10:05", end: "10:50", subject: "Третий", subjectVariants: [], rooms: [], teachers: [] },
    { type: "lunch", start: "10:50", end: "11:10" },
    { type: "lesson", number: 5, start: "12:15", end: "13:00", subject: "Пятый", subjectVariants: [], rooms: [], teachers: [] },
    { type: "large_break", start: "13:00", end: "13:30" },
    { type: "lesson", number: 8, start: "15:30", end: "16:15", subject: "Восьмой", subjectVariants: [], rooms: [], teachers: [] },
    { type: "information_hour", start: "14:20", end: "14:40" },
    { type: "curator_hour", start: "14:45", end: "15:05", rooms: ["Актовый зал"] },
  ],
};

const atMinsk = (time) => new Date(`2026-09-15T${String(Number(time.slice(0, 2)) - 3).padStart(2, "0")}${time.slice(2)}:00Z`);

test("compact live view keeps current and future events at injected times", () => {
  const at0830 = formatScheduleMessage(schedule, { mode: "compact", now: atMinsk("08:30"), timezone: "Europe/Minsk" });
  assert.match(at0830, /1 урок/);

  const at0905 = formatScheduleMessage(schedule, { mode: "compact", now: atMinsk("09:05"), timezone: "Europe/Minsk" });
  assert.doesNotMatch(at0905, /1 урок/);
  assert.match(at0905, /☕ Перемена · 10 минут · 09:00–09:10/);

  const at1055 = formatScheduleMessage(schedule, { mode: "compact", now: atMinsk("10:55"), timezone: "Europe/Minsk" });
  assert.match(at1055, /🍽 ОБЕД · 20 минут · 10:50–11:10/);

  const at1310 = formatScheduleMessage(schedule, { mode: "compact", now: atMinsk("13:10"), timezone: "Europe/Minsk" });
  assert.match(at1310, /🌿 Большая перемена · 30 минут · 13:00–13:30/);

  const at1559 = formatScheduleMessage(schedule, { mode: "compact", now: atMinsk("15:59"), timezone: "Europe/Minsk" });
  assert.match(at1559, /8 урок/);
});

test("full mode marks completed lessons without italics and compact mode has a completion fallback", () => {
  const full = formatScheduleMessage(schedule, { mode: "full", now: atMinsk("09:05"), timezone: "Europe/Minsk" });
  assert.match(full, /<b>✅ 1 урок · 08:15–09:00<\/b>/);
  assert.doesNotMatch(full, /<i>|<\/i>/);
  assert.match(full, /<b>2 урок · 09:10–09:55<\/b>/);

  const finished = formatScheduleMessage(schedule, { mode: "compact", now: atMinsk("16:16"), timezone: "Europe/Minsk" });
  assert.match(finished, /✅ Учебный день завершён/);
  assert.deepEqual(scheduleKeyboard(schedule.date, "compact").inline_keyboard[0][0], {
    text: "🕘 Прошедшие уроки",
    callback_data: "schedule:2026-09-15:full",
  });
});

test("completed show-all view emphasizes lesson lines, keeps breaks unmarked, and labels extra lessons", () => {
  const full = formatScheduleMessage(schedule, {
    mode: "full",
    now: atMinsk("16:30"),
    timezone: "Europe/Minsk",
    completed: true,
  });
  assert.match(full, /📚 Прошедшие уроки — 8-Сба\n📅 Вторник, 15 сентября/);
  assert.match(full, /<b>✅ 1 урок · 08:15–09:00<\/b>/);
  assert.match(full, /☕ Перемена · 10 минут · 09:00–09:10/);
  assert.doesNotMatch(full, /✅ ☕ Перемена|✅ 🌿 Большая перемена|✅ 🍽 ОБЕД/);
  assert.match(full, /🍽 ОБЕД · 20 минут · 10:50–11:10/);
  assert.match(full, /<b>✅ ℹ️ Дополнительное занятие — информационный час · 14:20–14:40<\/b>\n🚪 Кабинет: 329 \(если куратор не сообщил про актовый зал\)/);
  assert.match(full, /<b>✅ 🎓 Дополнительное занятие — кураторский час · 14:45–15:05<\/b>\n🚪 Кабинет: Актовый зал/);
  assert.doesNotMatch(full, /Учебный день завершён/);
  assert.doesNotMatch(full, /<i>|<\/i>/);
  assert.deepEqual(scheduleKeyboard(schedule.date, "full", { completed: true }).inline_keyboard[0][0], {
    text: "↩️ Только актуальное",
    callback_data: "schedule:2026-09-15:compact",
  });
});

test("active information and curator hours are labeled as extra lessons with their location", () => {
  const message = formatScheduleMessage(schedule, { mode: "full" });
  assert.match(message, /ℹ️ Дополнительное занятие — информационный час · 14:20–14:40\n🚪 Кабинет: 329/);
  assert.match(message, /🎓 Дополнительное занятие — кураторский час · 14:45–15:05\n🚪 Кабинет: Актовый зал/);
});

test("a future-date schedule is never filtered by today's HH:mm", () => {
  const future = { ...schedule, date: "2026-09-16" };
  const message = formatScheduleMessage(future, { mode: "compact", now: atMinsk("16:16"), timezone: "Europe/Minsk" });
  assert.match(message, /1 урок/);
  assert.match(message, /8 урок/);
  assert.doesNotMatch(message, /Учебный день завершён/);
});
