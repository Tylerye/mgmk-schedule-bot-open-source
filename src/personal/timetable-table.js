import { dateInTimezone, timeInTimezone } from "../dates.js";
import { escapeHtml } from "../schedule/format.js";
import { scheduleViewTimeline } from "../schedule/view-timeline.js";
import { backToMenu, button, personalDateLabel, renderPersonal, t } from "./view.js";

export function timetableTable(schedule, schedules, user, now, branded) {
  const w = t(user);
  const en = user.language === "en";
  const today = dateInTimezone(now, "Europe/Minsk");
  const time = timeInTimezone(now, "Europe/Minsk");
  const timeline = scheduleViewTimeline(schedule);
  const ended = event => schedule.date < today || (schedule.date === today && event.end && event.end <= time);

  function table(events) {
    const rows = events.map(event => {
      const clock = `<code>${escapeHtml([event.start, event.end].filter(Boolean).join("–"))}</code>`;
      if (event.type !== "lesson") return `<tr><td>${clock}</td><td><i>${w[event.type]}</i></td></tr>`;
      const variants = event.variants.map(variant => {
        const details = [variant.room && `${w.room} ${variant.room}`, variant.teacher].filter(Boolean).join(" · ");
        return `<b>${escapeHtml(variant.subject)}</b>${details ? `<br><i>${escapeHtml(details)}</i>` : ""}`;
      });
      return `<tr><td>${event.number}<br>${clock}</td><td>${[...variants, ...event.notes.map(note => escapeHtml(note.text))].join("<br>")}</td></tr>`;
    });
    return `<table bordered striped compact><tr><th>${en ? "Time" : "Время"}</th><th>${en ? "Class / room" : "Пара и кабинет"}</th></tr>${rows.join("")}</table>`;
  }

  const upcoming = timeline.filter(event => !ended(event));
  const past = timeline.filter(ended);
  const notes = [...schedule.statuses, ...schedule.notes];
  const richHtml = [
    `<h2>${w.schedule} · ${escapeHtml(schedule.displayGroup)}</h2>`,
    `<p><i>${personalDateLabel(schedule, user)}</i></p>`,
    upcoming.length ? table(upcoming) : "",
    past.length ? `<details><summary>${w.full} · ${past.filter(event => event.type === "lesson").length}</summary>${table(past)}</details>` : "",
    ...notes.map(note => `<p>${escapeHtml(note.text)}</p>`),
    !timeline.length && !notes.length ? `<p>${en ? "No lessons in this timetable." : "В расписании на этот день нет уроков."}</p>` : "",
  ].join("");

  const dates = [...new Set(schedules.map(item => item.date))].sort();
  const index = dates.indexOf(schedule.date);
  const navigation = [];
  if (index > 0) navigation.push(button(en ? "← Earlier" : "← Раньше", `table:${dates[index - 1]}`));
  if (index + 1 < dates.length) navigation.push(button(en ? "Later →" : "Дальше →", `table:${dates[index + 1]}`));
  const text = renderPersonal(schedule, user, { now, mode: "full" }).parts[0];
  return {
    text,
    // Telegram enforces both the character and the block limits. Keep a
    // conservative bound and leave the complete day accessible in text pages.
    ...(timeline.length + notes.length < 180 && richHtml.length < 28000 && { richHtml }),
    keyboard: { inline_keyboard: [
      ...(navigation.length ? [navigation] : []),
      [button(w.textView, `preview:${schedule.date}:full`, { branded })],
      ...backToMenu(user, branded).inline_keyboard,
    ] },
  };
}
