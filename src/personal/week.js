import bells from "../../config/bells.json" with { type: "json" };
import { addDays, dateInTimezone, dayKey } from "../dates.js";
import { escapeHtml } from "../schedule/format.js";
import { buildScheduleTimeline } from "../schedule/timeline.js";
import { scheduleViewTimeline } from "../schedule/view-timeline.js";
import { backToMenu, button, personalDateLabel, personalEventLines, screenText, t } from "./view.js";

export function weekRange(now) {
  const today = dateInTimezone(now, "Europe/Minsk");
  const weekday = new Date(today + "T12:00:00Z").getUTCDay();
  const start = addDays(today, -((weekday + 6) % 7));
  return { today, start, end: addDays(start, 6) };
}

export function plannedDay(plan, date) {
  const day = date >= plan?.effectiveFrom ? plan.days[dayKey(date)] : null;
  if (!day) return null;
  const lessons = day.lessons.map(([number, entry, room]) => {
    const separator = entry.indexOf("/");
    const subject = separator < 0 ? entry : entry.slice(0, separator).trim();
    const teacher = separator < 0 ? "" : entry.slice(separator + 1).trim();
    return { number, variants: [{ subject, teacher, room }], notes: [] };
  });
  const table = bells.effectiveFrom && date < bells.effectiveFrom ? bells.previous : bells;
  const events = (table?.[dayKey(date)] ?? []).filter(event =>
    !["curator_hour", "information_hour"].includes(event.type) || day.hours.includes(event.type));
  return { date, lessons, timeline: buildScheduleTimeline(lessons, events), notes: [], statuses: [], preliminary: true };
}

function dayBlocks(schedule, user, branded) {
  const en = user.language === "en";
  if (!schedule) return [[en ? "No timetable yet" : "Пока нет расписания"]];
  const blocks = scheduleViewTimeline(schedule).map(event => personalEventLines(event, user, { branded }));
  blocks.push(...[...schedule.statuses, ...schedule.notes].map(note => [escapeHtml(note.text)]));
  return blocks.length ? blocks : [[en ? "No classes listed" : "Пары не указаны"]];
}

// Telegram applies the text limit after parsing the HTML entities. Leaving
// escaped entities in the count keeps the fallback slightly conservative.
const textLength = html => html.replace(/<[^>]*>/gu, "").length;
const richDay = day => day.blocks.map(block => "<p>" + block.join("<br>") + "</p>").join("");

export function weekPage({ schedules, plan }, user, range, branded, focus) {
  const en = user.language === "en";
  const w = t(user);
  const byDate = new Map(schedules.map(schedule => [schedule.date, schedule]));
  const heading = w.week + " · " + escapeHtml(schedules[0]?.displayGroup ?? plan?.label ?? user.group_id);
  const shortDate = date => date.slice(5).split("-").reverse().join(".");
  const span = shortDate(range.start) + "–" + shortDate(range.end);
  const intro = en
    ? ["The weekly plan is checked every 3–4 days and can change",
      "The latest daily PDF takes priority · For important plans, double-check on the college site"]
    : ["План на неделю ориентировочный, проверяю его раз в 3–4 дня",
      "Дневной PDF всегда в приоритете · Если строишь планы, сверься с сайтом колледжа"];
  const alert = en ? "The bot can still tell you about changes if alerts are on"
    : "Если включены «Замены», бот напишет, когда поменяются пары";
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(range.start, index);
    const schedule = byDate.get(date) ?? plannedDay(plan, date);
    const label = personalDateLabel({ date }, user);
    const origin = schedule?.preliminary ? (en ? "Weekly plan" : "По плану")
      : schedule ? (en ? "Daily PDF" : "Дневной PDF") : "";
    return { date, label, origin, schedule, blocks: dayBlocks(schedule, user, branded) };
  });
  const dayTitle = day => "<b>" + day.label + "</b>" + (day.origin ? " · " + day.origin : "");
  const dayText = day => dayTitle(day) + "\n\n" + day.blocks.map(block => block.join("\n")).join("\n\n");
  const title = screenText("schedule", "<b>" + heading + "</b>", branded);
  const summary = title + "\n" + span + "\n" + intro.join("\n") + "\n" + alert;
  const keyboard = backToMenu(user, branded);
  const focusedDay = days.find(day => day.date === focus);
  if (focusedDay) {
    keyboard.inline_keyboard.unshift([button(w.back, "week", { branded, icon: "back" })]);
    const dayHeading = screenText("schedule", "<b>" + focusedDay.label + "</b>", branded);
    const origin = focusedDay.origin ? "<i>" + focusedDay.origin + "</i>" : "";
    const richHtml = "<h2>" + dayHeading + "</h2>" + (origin ? "<p>" + origin + "</p>" : "") + richDay(focusedDay);
    let text = [dayHeading, origin].filter(Boolean).join("\n");
    for (const block of focusedDay.blocks) {
      const next = text + "\n\n" + block.join("\n");
      if (textLength(next) > 3895) { text += "\n…"; break; }
      text = next;
    }
    return { text, richHtml, keyboard };
  }
  const full = summary + "\n\n" + days.map(dayText).join("\n\n");
  const rows = days.reduce((count, day) => count + day.blocks.length + 1, 0);
  const richHtml = "<h2>" + title + "</h2><p>" + span + "</p><p>" + [...intro, alert].join("<br>") + "</p>"
    + days.map(day => day.schedule
      ? "<details" + (day.date === range.today ? " open" : "") + "><summary>" + day.label + " · " + day.origin + "</summary>"
        + richDay(day) + "</details>"
      : "<p>" + dayTitle(day) + "<br>" + day.blocks[0][0] + "</p>").join("");
  const available = days.filter(day => day.schedule);
  const brief = days.map(day => dayTitle(day) + "\n" + (day.schedule
    ? (en ? "Classes: " : "Пар: ") + day.schedule.lessons.length
    : day.blocks[0][0])).join("\n\n");
  const fallback = summary + "\n\n" + brief;
  const fitsInText = textLength(full) <= 3900;
  if (!fitsInText) {
    for (let i = 0; i < available.length; i += 3) {
      keyboard.inline_keyboard.splice(-1, 0, available.slice(i, i + 3)
        .map(day => button(shortDate(day.date), "week:" + day.date, { plain: true })));
    }
  }
  return {
    text: fitsInText ? full : fallback,
    ...(available.length && rows < 400 && richHtml.length < 28_000 && { richHtml }),
    keyboard,
  };
}
