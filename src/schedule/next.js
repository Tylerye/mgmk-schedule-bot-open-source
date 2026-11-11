import { dateInTimezone, timeInTimezone, minutesFromTime } from "../dates.js";
import { escapeHtml } from "./format.js";
import { scheduleViewTimeline } from "./view-timeline.js";

const CLASSES = new Set(["lesson", "information_hour", "curator_hour"]);
const BREAKS = { break: "☕ Перемена", large_break: "🌿 Большая перемена", lunch: "🍽 Обед" };
const validTime = (value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value ?? "");

export function selectNextEvent(schedule, now, timezone = "Europe/Minsk") {
  if (!schedule || schedule.date !== dateInTimezone(now, timezone)) return { status: "missing" };
  const timeline = scheduleViewTimeline(schedule);
  const classes = timeline.filter((event) => CLASSES.has(event.type));
  if (!classes.length) return { status: "empty" };
  if (classes.some((event) => !validTime(event.start) || !validTime(event.end) || event.start >= event.end)) {
    return { status: "unknown" };
  }
  const time = timeInTimezone(now, timezone);
  const ordered = [...classes].sort((a, b) => a.start.localeCompare(b.start));
  const current = ordered.find((event) => event.start <= time && time < event.end);
  if (current) return { status: "current", event: current, minutes: minutesFromTime(current.end) - minutesFromTime(time) };
  const next = ordered.find((event) => time < event.start);
  if (!next) return { status: "finished" };
  const pause = timeline.find((event) => BREAKS[event.type] && validTime(event.start) && validTime(event.end)
    && event.start <= time && time < event.end);
  return { status: "next", event: next, pause, minutes: minutesFromTime(next.start) - minutesFromTime(time) };
}

export function formatNextMessage(schedule, { now = new Date(), timezone = "Europe/Minsk" } = {}) {
  const result = selectNextEvent(schedule, now, timezone);
  if (result.status === "missing") return "Расписание на сегодня ещё не найдено.";
  if (result.status === "empty") return "В расписании на сегодня занятий нет.";
  if (result.status === "unknown") return "Время занятий в расписании неизвестно — не могу точно определить текущий или следующий урок.";
  if (result.status === "finished") return "На сегодняшний день занятия окончены\n\nНовое расписание появится здесь, когда колледж его опубликует";
  const { event, minutes } = result;
  const current = result.status === "current";
  const name = event.type === "lesson" ? `${event.number} урок`
    : `Дополнительное занятие — ${event.type === "curator_hour" ? "кураторский час" : "информационный час"}`;
  const lines = [];
  if (result.pause) lines.push(BREAKS[result.pause.type]);
  lines.push(`<b>${current ? "📍 Сейчас" : "⏭ Следующий"} — ${escapeHtml(name)} · ${event.start}–${event.end}</b>`);
  if (event.type === "lesson") {
    const subjects = [event.subject, ...(event.subjectVariants ?? [])].filter(Boolean);
    lines.push(`📖 ${subjects.length ? subjects.map(escapeHtml).join(" / ") : "Предмет не указан"}`);
  }
  const rooms = event.rooms?.length ? event.rooms.map(escapeHtml).join(" / ") : event.room ? escapeHtml(event.room) : null;
  lines.push(rooms ? `🚪 Кабинет: ${rooms}` : event.type === "lesson" ? "🚪 Кабинет не указан"
    : "🚪 Кабинет: 329 (если куратор не сообщил про актовый зал)");
  lines.push(`${current ? "До конца" : "До начала"}: ${minutes} мин`);
  return lines.join("\n");
}
