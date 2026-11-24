import { createHash } from "node:crypto";
import { dateInTimezone, timeInTimezone } from "../dates.js";
import { eventDuration } from "./timeline.js";
import { scheduleViewTimeline } from "./view-timeline.js";
import { heading, lessonHeading, themedButton, themeIcon } from "../chat-theme.js";

export const GROUP_SCHEDULE_STYLE = "group-card-v3";

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

function formatEvent(event, completed, branded) {
  let block;
  if (event.type === "lesson") {
    if (branded) {
      const marker = completed ? "  " + themeIcon("completed", true) : "";
      const lines = [
        lessonHeading(event) + marker,
        "<b>" + joinValues([event.subject, ...(event.subjectVariants ?? [])]) + "</b>",
      ];
      const details = [event.rooms?.length ? "Каб. " + joinValues(event.rooms) : "", joinValues(event.teachers)].filter(Boolean);
      if (details.length) lines.push("<i>" + details.join(" · ") + "</i>");
      return lines.join("\n");
    }
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
  if (event.type === "break") {
    const label = `Перемена · ${eventDuration(event)} минут · ${event.start}–${event.end}`;
    block = branded ? `${themeIcon("break", true)} <u><i>${label}</i></u>` : `<u>☕ ${label}</u>`;
  }
  else if (event.type === "large_break") block = `<u>${branded ? themeIcon("large_break", true) : "🌿"} Большая перемена · ${eventDuration(event)} минут · ${event.start}–${event.end}</u>`;
  else if (event.type === "lunch") {
    const lunch = `${branded ? themeIcon("lunch", true) : "🍽"} ОБЕД · ${eventDuration(event)} минут · ${event.start}–${event.end}`;
    block = `<u>${lunch}</u>`;
  }
  else if (event.type === "curator_hour" || event.type === "information_hour") {
    const name = event.type === "curator_hour" ? "кураторский час" : "информационный час";
    const icon = event.type === "curator_hour" ? "🎓" : "ℹ️";
    const rooms = event.rooms?.length ? joinValues(event.rooms) : escapeHtml(event.room ?? "329");
    const location = event.rooms?.length || event.room
      ? `Кабинет: ${rooms}`
      : "Кабинет: 329 (если куратор не сообщил про актовый зал)";
    if (branded) {
      const label = `Дополнительное занятие — ${name}`;
      const marker = completed ? "  " + themeIcon("completed", true) : "";
      return `${heading("view", label, true)} · ${event.start}–${event.end}${marker}\n<i>${location}</i>`;
    }
    const title = `${icon} Дополнительное занятие — ${name} · ${event.start}–${event.end}`;
    return completed
      ? `<b>✅ ${title}</b>\n🚪 ${location}`
      : `${title}\n🚪 ${location}`;
  }
  else throw new Error(`Unsupported schedule event type: ${event.type}`);
  return block;
}

export function scheduleKeyboard(date, mode, { completed = false, branded = false } = {}) {
  const full = mode === "full";
  if (branded) return { inline_keyboard: [[themedButton(full ? "Только актуальное" : completed ? "Показать всё" : "Прошедшие уроки",
    { callback_data: `schedule:${date}:${full ? "compact" : "full"}` }, full ? "back" : "view", { branded, style: "success" })]] };
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
  branded = false,
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
  const titleLine = branded ? heading("schedule", title.slice("📚 ".length), true) : title;
  blocks.push(`${titleLine}\n${themeIcon("today", branded)} ${dateTitle(schedule.date)}`);

  const timeline = scheduleViewTimeline(schedule);
  const today = now ? dateInTimezone(now, timezone) : null;
  const currentTime = now ? timeInTimezone(now, timezone) : null;
  const eventStates = timeline.map((event) => ({
    event,
    completed: Boolean(now && event.end && (schedule.date < today
      || (schedule.date === today && event.end <= currentTime))),
  }));
  const visible = mode === "compact" ? eventStates.filter(({ completed }) => !completed) : eventStates;
  if (mode === "compact" && (completed || visible.length === 0)) {
    blocks.push(branded ? heading("completed", "Учебный день завершён", true) : "✅ Учебный день завершён");
  }
  else {
    blocks.push(...visible.map(({ event, completed }) => formatEvent(event, mode === "full" && completed, branded)));
  }
  return blocks.join("\n\n");
}

export function renderSchedule(schedule, options = {}) {
  const branded = options.branded ?? true;
  const text = formatScheduleMessage(schedule, { ...options, branded });
  const replyMarkup = options.withKeyboard
    ? scheduleKeyboard(schedule.date, options.mode ?? "compact", { completed: options.completed, branded })
    : { inline_keyboard: [] };
  const hash = createHash("sha256").update(JSON.stringify({ text, replyMarkup })).digest("hex");
  return { text, replyMarkup, hash };
}
