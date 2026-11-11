import { createHash } from "node:crypto";
import { dateInTimezone, timeInTimezone } from "../dates.js";
import { eventDuration } from "./timeline.js";
import { scheduleViewTimeline } from "./view-timeline.js";

const WEEKDAYS = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

export function dateTitle(isoDate) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  return `${WEEKDAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function joinValues(values = []) {
  return escapeHtml(values.filter(Boolean).join(" / "));
}

function formatEvent(event, completed = false) {
  let block;
  if (event.type === "lesson") {
    const time = event.start && event.end ? ` · ${event.start}–${event.end}` : "";
    if (completed) {
      const lines = [
        `<b>✅ ${event.number} урок${time}</b>`,
        `📖 ${joinValues([event.subject, ...(event.subjectVariants ?? [])])}`,
      ];
      if (event.rooms?.length) lines.push(`🚪 Кабинет: ${joinValues(event.rooms)}`);
      if (event.teachers?.length) lines.push(`👤 ${joinValues(event.teachers)}`);
      return lines.join("\n");
    }
    const lines = [
      `<b>${event.number} урок${time}</b>`,
      `📖 ${joinValues([event.subject, ...(event.subjectVariants ?? [])])}`,
    ];
    if (event.rooms?.length) lines.push(`🚪 Кабинет: ${joinValues(event.rooms)}`);
    if (event.teachers?.length) lines.push(`👤 ${joinValues(event.teachers)}`);
    return lines.join("\n");
  }
  if (event.type === "break") block = `<u>☕ Перемена · ${eventDuration(event)} минут · ${event.start}–${event.end}</u>`;
  else if (event.type === "large_break") block = `<u>🌿 Большая перемена · ${eventDuration(event)} минут · ${event.start}–${event.end}</u>`;
  else if (event.type === "lunch") {
    const lunch = `🍽 ОБЕД · ${eventDuration(event)} минут · ${event.start}–${event.end}`;
    block = `<u>${lunch}</u>`;
  }
  else if (event.type === "curator_hour" || event.type === "information_hour") {
    const name = event.type === "curator_hour" ? "кураторский час" : "информационный час";
    const icon = event.type === "curator_hour" ? "🎓" : "ℹ️";
    const rooms = event.rooms?.length ? joinValues(event.rooms) : escapeHtml(event.room ?? "329");
    const location = event.rooms?.length || event.room
      ? `Кабинет: ${rooms}`
      : "Кабинет: 329 (если куратор не сообщил про актовый зал)";
    const title = `${icon} Дополнительное занятие — ${name} · ${event.start}–${event.end}`;
    return completed
      ? `<b>✅ ${title}</b>\n🚪 ${location}`
      : `${title}\n🚪 ${location}`;
  }
  else throw new Error(`Unsupported schedule event type: ${event.type}`);
  return block;
}

export function scheduleKeyboard(date, mode, { completed = false } = {}) {
  const full = mode === "full";
  return {
    inline_keyboard: [[{
      text: full ? "↩️ Только актуальное" : completed ? "📋 Показать всё" : "🕘 Прошедшие уроки",
      callback_data: `schedule:${date}:${full ? "compact" : "full"}`,
    }]],
  };
}

function subjectChangesOnly(lines) {
  return lines.flatMap((line) => {
    const subject = /^(\d+ урок), предмет: (.+)$/.exec(line);
    if (subject) return [`${subject[1]}: ${subject[2]}`];
    return /^(\d+ урок)(?::| добавлен:| убран:)/.test(line) ? [line] : [];
  });
}

export function formatScheduleMessage(schedule, {
  updated = false,
  changeSummary = [],
  mode = "full",
  now = null,
  timezone = "Europe/Minsk",
  completed = false,
} = {}) {
  const blocks = [];
  if (updated && !completed) {
    const subjectChanges = subjectChangesOnly(changeSummary);
    const details = subjectChanges.length
      ? `\nЧто изменилось:\n${subjectChanges.map((line) => `• ${escapeHtml(line)}`).join("\n")}`
      : "";
    blocks.push(`<b>Расписание обновлено${details}</b>`);
  }
  const group = escapeHtml(schedule.displayGroup ?? "8-Сба");
  const title = completed && mode === "full" ? `📚 Прошедшие уроки — ${group}` : `📚 Расписание — ${group}`;
  blocks.push(`${title}\n📅 ${dateTitle(schedule.date)}`);

  const timeline = scheduleViewTimeline(schedule);
  const today = now ? dateInTimezone(now, timezone) : null;
  const currentTime = now ? timeInTimezone(now, timezone) : null;
  const eventStates = timeline.map((event) => ({
    event,
    completed: Boolean(now && event.end && (schedule.date < today
      || (schedule.date === today && event.end <= currentTime))),
  }));
  const visible = mode === "compact" ? eventStates.filter(({ completed }) => !completed) : eventStates;
  if (completed && mode === "compact") blocks.push("✅ Учебный день завершён");
  else if (visible.length === 0 && mode === "compact") blocks.push("✅ Учебный день завершён");
  else {
    blocks.push(...visible.map(({ event, completed }) => formatEvent(event, mode === "full" && completed)));
  }
  return blocks.join("\n\n");
}

export function renderSchedule(schedule, options = {}) {
  const text = formatScheduleMessage(schedule, options);
  const replyMarkup = options.withKeyboard
    ? scheduleKeyboard(schedule.date, options.mode ?? "compact", { completed: options.completed })
    : { inline_keyboard: [] };
  const hash = createHash("sha256").update(JSON.stringify({ text, replyMarkup })).digest("hex");
  return { text, replyMarkup, hash };
}
