import { dateTitle, escapeHtml } from "./format.js";
import { scheduleViewTimeline } from "./view-timeline.js";

const validTime = (value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value ?? "");
const validInterval = (event) => validTime(event.start) && validTime(event.end) && event.start < event.end;
const extras = { information_hour: "информационный час", curator_hour: "кураторский час" };

export function formatDaySummary(schedule, { date } = {}) {
  if (!schedule || (date && schedule.date !== date)) return "Расписание на завтра ещё не опубликовано";
  const timeline = scheduleViewTimeline(schedule);
  const classes = timeline.filter((event) => event.type === "lesson" || extras[event.type]);
  const lines = [dateTitle(schedule.date)];
  if (!classes.length) return `<b>${escapeHtml(lines[0])}</b>\nЗанятий нет`;
  const timed = classes.every(validInterval);
  const ordered = timed ? [...classes].sort((a, b) => a.start.localeCompare(b.start)) : [];
  if (timed) {
    const first = ordered[0];
    lines.push(first.type === "lesson" ? `Начало: ${Number(first.number) === 2 ? "со" : "с"} ${first.number} урока в ${first.start}`
      : `Начало: в ${first.start} — ${extras[first.type]}`);
    lines.push(`Окончание: в ${ordered.reduce((latest, event) => event.end > latest ? event.end : latest, "00:00")}`);
  } else lines.push("Время начала и окончания занятий неизвестно");
  const count = classes.filter((event) => event.type === "lesson").length;
  const word = count % 100 >= 11 && count % 100 <= 14 ? "уроков"
    : count % 10 === 1 ? "урок" : count % 10 >= 2 && count % 10 <= 4 ? "урока" : "уроков";
  const extraNames = classes.filter((event) => extras[event.type]).map((event) => extras[event.type]);
  lines.push(`Всего ${count} ${word}${extraNames.length ? ` + ${extraNames.join(" + ")}` : ""}`);
  if (timed) {
    const start = ordered[0].start;
    const end = ordered.reduce((latest, event) => event.end > latest ? event.end : latest, "00:00");
    for (const lunch of timeline.filter((event) => ["lunch", "large_break"].includes(event.type) && validInterval(event)
      && event.start >= start && event.end <= end)) {
      lines.push(`${lunch.type === "lunch" ? "🍽 Обед" : "🌿 Большая перемена"} ${lunch.start}–${lunch.end}`);
    }
  }
  return lines.map((line, index) => index === 0 ? `<b>${escapeHtml(line)}</b>` : escapeHtml(line)).join("\n");
}
