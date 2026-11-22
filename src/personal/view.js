import { heading, themedButton } from "../chat-theme.js";
import { createHash } from "node:crypto";
import { dateInTimezone, timeInTimezone, addDays } from "../dates.js";
import { escapeHtml, dateTitle } from "../schedule/format.js";
import { scheduleViewTimeline } from "../schedule/view-timeline.js";
import { hasLessonSummary, lessonSummary } from "./lesson-summary.js";

// Public contact only, never used to grant access to the bot
export const AUTHOR_USERNAME = "your_username";

export const words = {
  ru: { menu: "<b>Привет! Это расписание МГМК</b>\n\nЖми «Сегодня» или «Завтра», чтобы глянуть пары\nКак только колледж выложит новое расписание или замены, я напишу сюда", updates: "Обновления", table: "Таблица", textView: "Обычный текст", main: "Главное меню", schedule: "Расписание", today: "Сегодня", tomorrow: "Завтра", next: "Ближайший день",
    settings: "Настройки", help: "Как пользоваться", support: "Поддержать автора", group: "Группа", language: "Язык",
    feedback: "Обратная связь", privacy: "О боте и данных", contact: "Написать автору",
    feedbackText: "<b>Есть идея или что-то не работает?</b>\n\nНапиши @{contact}\nЕсли дело в расписании, скинь группу и дату — так проще найти, что случилось",
    privacyText: "<b>О боте и данных</b>\n\nЯ беру расписание из PDF колледжа\nС 20:00 до 06:30 по Минску проверяю его раз в 15 минут\nСамо расписание можно открыть в любое время\n\nЕсли пару перенесли или отменили, лучше свериться с куратором — в PDF правка может появиться позже\n\n<blockquote expandable><b>Что я запоминаю</b>\nТвой Telegram ID, группу, язык, настройки и отметки о доставке\nЕсли поставишь оценку, она сохранится один раз\nИсторию переписки и юзернейм я не храню\n\nБот работает в Telegram и Cloudflare, PDF обрабатывает GitHub Actions\nЕсли хочешь удалить свои данные, напиши @{contact}</blockquote>",
    sound: "Звук", changes: "Замены", auto_pin: "Закреп", pin: "Сообщение о закрепе", pause: "Автообновления",
    resume: "Возобновить автообновления", back: "Назад", more: "Далее", choose: "<b>В какой ты группе?</b>\n\nНайди свою в списке или просто напиши ее название сюда",
    missing: "<b>Пока не вижу расписание на этот день</b>\n\nЕсли есть пары или замены, пришлю их сюда, как только появится расписание",
    full: "Весь день", compact: "Оставшиеся пары", ended: "На сегодня все", lesson: "урок", room: "Кабинет",
    break: "Перемена", large_break: "Большая перемена", lunch: "Обед", curator_hour: "Кураторский час", information_hour: "Информационный час",
    supportText: "<b>Хочешь поддержать бота?</b>\n\nРасписание бесплатное для всех\nЕсли хочешь помочь с развитием, реквизиты ниже",
    channel: "ТГК автора", donate: "Реквизиты", later: "Позже", details: "<b>Реквизитов пока нет</b>", closed: "<b>Привет! Это расписание МГМК</b>\n\nКакой день посмотрим?",
    helpText: "<b>Как пользоваться</b>\n\n<b>Нужны пары на сегодня или завтра?</b>\nЖми «Сегодня» или «Завтра»\nЕсли впереди выходные, жми «Ближайший день»\n\n<b>Хочешь посмотреть весь день?</b>\nЖми «Весь день» — там будут и прошедшие пары\nСтрелками можно листать дни\n\n<blockquote expandable><b>Как работают замены и закреп</b>\nКогда в PDF что-то поменяется, я напишу сюда\nПосле 16:30 по Минску могу закрепить следующий учебный день\nЕсли пара идет после 16:30, она видна до конца\n\nЧтобы выключить закреп или уведомления, зайди в настройки</blockquote>",
    settingsText: "<b>Настройки</b>\n\nСмотри на значок рядом с подписью\n🟢 вкл · 🔴 выкл\n\n<blockquote expandable><b>Что тут можно поменять</b>\nЗакреп — расписание будет сверху чата\nЗвук — новое расписание придет со звуком\nЗамены — я напишу отдельно, если пара поменяется\nАвтообновления — выключи, если пока не нужны новые карточки\nКнопками дни можно смотреть всегда</blockquote>",
    changed: "Изменения в расписании", added: "добавлен", removed: "отменен", on: "вкл", off: "выкл", saving: "Автообновления пока на паузе\nРасписание можно открыть кнопками",
    part: "часть", emptyPart: "Остальное расписание теперь в предыдущих сообщениях", pinned: "Закреплено расписание", pilot: "Этот экран пока открыт для участников теста" },
  en: { settingsText: "<b>Settings</b>\n\nLook for the dot next to the label\n🟢 on · 🔴 off\n\n<blockquote expandable><b>What each switch does</b>\nPin keeps the timetable at the top\nSound alerts you when a new card arrives\nChanges sends a separate alert when a class changes\nTurn off Auto-updates to pause new cards\nThe day buttons still work</blockquote>", menu: "<b>Hey! This is the МГМК timetable</b>\n\nTap Today or Tomorrow to see your classes\nI’ll post here when there’s a new timetable or a change", updates: "What’s new", table: "Table", textView: "Plain text", main: "Main menu", schedule: "Timetable", today: "Today", tomorrow: "Tomorrow", next: "Next school day",
    settings: "Settings", help: "How to use", support: "Support the author", group: "Group", language: "Language",
    feedback: "Feedback", privacy: "About and privacy", contact: "Message the author",
    feedbackText: "<b>Got an idea or spotted a problem?</b>\n\nMessage @{contact}\nIf it’s about the timetable, include your group and the date",
    privacyText: "<b>About the bot and your data</b>\n\nI get the timetable from the college PDFs\nFrom 20:00 to 06:30 Minsk time, I check every 15 minutes\nYou can open the timetable anytime\n\nIf a class moves or is cancelled, check with your tutor — the PDF might change later\n\n<blockquote expandable><b>What I remember</b>\nYour Telegram ID, group, language, settings and delivery records\nI keep your rating once if you leave one\nI don’t keep chat history or usernames\n\nThe bot runs on Telegram and Cloudflare, and GitHub Actions handles the PDFs\nTo delete your data, message @{contact}</blockquote>",
    sound: "Sound", changes: "Change alerts", auto_pin: "Pin", pin: "Pin announcement", pause: "Auto-updates",
    resume: "Resume automatic updates", back: "Back", more: "Next", choose: "<b>Which group are you in?</b>\n\nPick yours below or type its name here",
    missing: "<b>I don’t have the timetable for that day yet</b>\n\nI’ll post it here when it’s ready",
    full: "Full day", compact: "Remaining classes", ended: "All done for today", lesson: "lesson", room: "Room",
    break: "Break", large_break: "Long break", lunch: "Lunch", curator_hour: "Tutor period", information_hour: "Information period",
    supportText: "<b>Want to support the bot?</b>\n\nThe timetable is free for everyone\nIf you’d like to help, the payment details are below",
    channel: "Author's channel", donate: "Payment details", later: "Later", details: "<b>Payment details aren’t available yet</b>", closed: "<b>Hey! This is the МГМК timetable</b>\n\nWhich day do you want to see?",
    helpText: "<b>How to use the bot</b>\n\n<b>Need today’s or tomorrow’s classes?</b>\nTap Today or Tomorrow\nFor the next published day, tap Next school day\n\n<b>Want the whole day?</b>\nTap Full day to include finished classes\nUse the arrows to browse dates\n\n<blockquote expandable><b>How changes and pins work</b>\nI’ll post here when the PDF changes\nAfter 16:30 Minsk time I can pin the next school day\nLater classes stay visible until they finish\n\nOpen Settings to switch pins or alerts off</blockquote>",
    changed: "Timetable changes", added: "added", removed: "cancelled", on: "on", off: "off", saving: "Auto-updates are on hold for now\nYou can still open the timetable",
    part: "part", emptyPart: "The timetable now fits in the earlier messages", pinned: "Pinned timetable", pilot: "This screen is open to testers for now" },
};
export const t = user => words[user?.language === "en" ? "en" : "ru"];
// Cohorts share immutable rendering in a warm isolate. This bounded cache is
// optional: correctness never depends on which isolate serves the next user.
const cohortRenders = new Map();
export const widgetGroup = "8СА";
export const widgetLabel = user => user.language === "en" ? "Day by lesson · HTML" : "День по урокам · HTML";


export function button(text, action, options = {}) {
  const [kind, option] = action.split(":");
  const icon = kind === "toggle" ? (option === "pin" ? "auto_pin" : option)
    : ({ groups: "group", lang: "language", donate: "support", preview: "view", later: "back" })[kind] ?? kind;
  return themedButton(text, { callback_data: "personal:" + action }, options.icon ?? icon, options);
}

export function screenText(key, text, branded) {
  const end = text.indexOf("</b>");
  if (!text.startsWith("<b>") || end === -1) return text;
  return heading(key, text.slice(3, end), branded) + text.slice(end + 4);
}

export function menu(user, widgetEnabled = false, branded = false) {
  const w = t(user);
  const item = (label, action) => button(label, action, { branded, style: "success" });
  return { inline_keyboard: [
    [item(w.today, "today"), item(w.tomorrow, "tomorrow")],
    [item(w.schedule, "schedule"), item(w.next, "next")],
    ...(widgetEnabled && user.group_id === widgetGroup ? [[item(widgetLabel(user), "widget")]] : []),
    [item(w.settings, "settings"), item(w.help, "help")],
    [item(w.updates, "updates:0")],
    [item(w.feedback, "feedback"), item(w.privacy, "privacy")],
    [item(w.support, "support")],
  ] };
}

export const backToMenu = (user, branded) => ({ inline_keyboard: [[button(t(user).main, "menu", { branded })]] });
export const informationText = (user, action) => t(user)[`${action}Text`].replaceAll('{contact}', escapeHtml(AUTHOR_USERNAME));
export const informationKeyboard = (user, branded) => ({ inline_keyboard: [
  [themedButton(t(user).contact, { url: `https://t.me/${AUTHOR_USERNAME}` }, "feedback", { branded, style: "primary" })],
  ...backToMenu(user, branded).inline_keyboard,
] });
export const supportKeyboard = (user, branded) => ({ inline_keyboard: [
  [button(t(user).donate, "donate", { branded, style: "primary" })],
  [{ text: t(user).channel, url: "https://example.com" }],
  ...backToMenu(user, branded).inline_keyboard,
] });
export function supportDetailsText(user, binding) {
  const w = t(user);
  let details;
  try { details = JSON.parse(binding); } catch { return w.details; }
  const { mtbankContract, mtbankCard, belarusbankCard } = details ?? {};
  if (![mtbankContract, mtbankCard, belarusbankCard].every(value => typeof value === "string")
    || !/^\d{8}$/u.test(mtbankContract) || !/^\d{16}$/u.test(mtbankCard)
    || !/^\d{16}$/u.test(belarusbankCard)) return w.details;
  const card = value => `<code>${value.match(/\d{4}/gu).join(" ")}</code>`;
  const erip = "ЕРИП → Банковские, финансовые услуги → Банки, НКФО";
  const english = user.language === "en";
  return [
    w.supportText,
    `<blockquote expandable><b>МТБанк · ЕРИП и карта</b>\n${erip} → МТБанк → Пополнение карты\n${english ? "Contract number" : "Номер договора"} <code>${mtbankContract}</code>\n${english ? "Card transfer" : "Перевод на карту"} ${card(mtbankCard)}</blockquote>`,
    `<blockquote expandable><b>Беларусбанк · ${english ? "Card" : "Карта"}</b>\n${english ? "Card transfer" : "Перевод на карту"} ${card(belarusbankCard)}</blockquote>`,
    english ? "<i>Thanks for your support!</i>" : "<i>Спасибо, что поддерживаешь!</i>",
  ].join("\n\n");
}
export function settingsKeyboard(user, branded) {
  const w = t(user);
  const toggle = (label, key, enabled) => button(
    label + ": " + (enabled ? "🟢 " + w.on : "🔴 " + w.off),
    "toggle:" + key, { branded, style: enabled ? "success" : "danger" },
  );
  return { inline_keyboard: [
    [button(w.group, "groups:0", { branded, style: "primary" }), button(w.language, "language", { branded, style: "primary" })],
    ...["auto_pin", "sound", "changes"].map(key => [toggle(w[key], key, user[key])]),
    [toggle(w.pause, "paused", !user.paused)],
    ...backToMenu(user, branded).inline_keyboard,
  ] };
}
export function groupsKeyboard(groups, user, page = 0, branded) {
  const pages = Math.max(1, Math.ceil(groups.length / 10));
  page = Math.max(0, Math.min(pages - 1, page));
  const items = groups.slice(page * 10, (page + 1) * 10);
  const rows = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2).map(g => button(g.displayName, `group:${g.id}`, { branded, style: g.id === user.group_id ? "primary" : undefined })));
  rows.push([...(page ? [button(t(user).back, `groups:${page - 1}`, { branded, icon: "back" })] : []), button(`${page + 1}/${pages}`, `groups:${page}`, { branded, icon: "table" }),
    ...(page + 1 < pages ? [button(t(user).more, `groups:${page + 1}`, { branded, icon: "next" })] : [])]);
  rows.push(...backToMenu(user, branded).inline_keyboard);
  return { inline_keyboard: rows };
}

// Pick pins from known OWN publications, keep the current pin if no future
// lesson is published, and never backtrack at midnight or over missing dates.
export function choosePersonalPin(cards, current, now = new Date()) {
  const today = dateInTimezone(now, "Europe/Minsk"), time = timeInTimezone(now, "Europe/Minsk");
  const eligible = cards.filter(c => c.hasLessons && c.messageId && c.date >= today).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const todayCard = eligible.find(c => c.date === today);
  const future = eligible.find(c => c.date > today);
  const desired = time >= "16:30" ? future ?? (!current?.messageId ? todayCard : undefined)
    : todayCard ?? (!current?.messageId ? future : undefined);
  return desired && (!current?.date || desired.date >= current.date) && desired.messageId !== current?.messageId ? desired : null;
}
export function initialDates(schedules, now = new Date()) {
  const today = dateInTimezone(now, "Europe/Minsk");
  return [schedules.find(s => s.date === today), schedules.filter(s => s.date > today).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)[0]].filter(Boolean);
}
export function selectedDate(schedules, action, now = new Date()) {
  const today = dateInTimezone(now, "Europe/Minsk");
  if (action === "today") return today;
  if (action === "tomorrow") return addDays(today, 1);
  const rows = schedules.filter(s => s.date >= today).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return (action === "next" ? rows.find(s => s.date > today) ?? rows[0] : rows[0])?.date ?? today;
}

export function subjectChanges(before, after, language = "ru") {
  if (!before) return [];
  const w = words[language];
  const subjects = l => [...new Set(l.variants.map(v => v.subject))].sort().join(" / ");
  const a = new Map(before.lessons.map(l => [l.number, subjects(l)]));
  const b = new Map(after.lessons.map(l => [l.number, subjects(l)]));
  return [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y).flatMap(n => {
    if (a.get(n) === b.get(n)) return [];
    return [`${n} ${w.lesson}: ${!a.has(n) ? `${w.added} — ${b.get(n)}` : !b.has(n) ? `${w.removed} — ${a.get(n)}` : `${a.get(n)} → ${b.get(n)}`}`];
  });
}

// Split raw text BEFORE HTML escaping, so neither entities nor formatting tags
// are cut. Never truncate a subject, a subgroup tuple, or a note.
function textLines(raw) {
  const chars = Array.from(String(raw));
  const chunks = [];
  for (let i = 0; i < chars.length; i += 400) chunks.push(escapeHtml(chars.slice(i, i + 400).join("")));
  return chunks.length ? chunks : [""];
}
export function noticeParts(title, lines) {
  const parts = []; let body = "";
  for (const line of lines.flatMap(textLines)) {
    if (body.length + line.length > 3200) { parts.push(`<b>${escapeHtml(title)}</b>\n${body}`); body = ""; }
    body += `${body ? "\n" : ""}${line}`;
  }
  if (body) parts.push(`<b>${escapeHtml(title)}</b>\n${body}`);
  return parts;
}
export function personalDateLabel(schedule, user) {
  const day = new Date(`${schedule.date}T12:00:00Z`);
  return user.language === "en" ? `${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day.getUTCDay()]}, ${day.getUTCDate()} ${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][day.getUTCMonth()]}` : dateTitle(schedule.date);
}

export function renderPersonal(schedule, user, { mode = "compact", now = new Date(), lessonChanges, branded = false } = {}) {
  const w = t(user), today = dateInTimezone(now, "Europe/Minsk"), time = timeInTimezone(now, "Europe/Minsk");
  const timeline = scheduleViewTimeline(schedule);
  const ended = e => schedule.date < today || (schedule.date === today && e.end && e.end <= time);
  const summary = hasLessonSummary(schedule) && schedule.date === today ? lessonSummary(timeline, time, user.language === "en") : [];
  const changes = lessonChanges?.filter(change => schedule.date >= today && !timeline.some(e => e.type === "lesson" && e.number === change.number && ended(e)));
  const cacheKey = JSON.stringify([schedule.hash, schedule.displayGroup, user.language === "en" ? "en" : "ru", mode, branded, timeline.map(ended), summary, changes]);
  if (cohortRenders.has(cacheKey)) return cohortRenders.get(cacheKey);
  const title = heading("schedule", w.schedule + " · " + escapeHtml(schedule.displayGroup), branded) + "\n" + personalDateLabel(schedule, user);
  const lines = summary.map(line => {
    const chars = Array.from(line);
    return `<b>${escapeHtml(chars.length > 150 ? chars.slice(0, 149).join("") + "…" : line)}</b>`;
  });
  if (changes?.length) {
    lines.push("", `<b>${w.changed}</b>`);
    for (const { number, room, time } of changes) {
      const details = [room && `${w.room} ${room.join(" → ")}`, time && time.join(" → ")].filter(Boolean);
      lines.push(...textLines(`${number} ${w.lesson} · ${details.join(" · ")}`));
    }
  }
  let visible = 0;
  for (const e of timeline) {
    const completed = ended(e);
    if (mode === "compact" && completed) continue;
    visible++;
    if (e.type === "lesson") {
      lines.push("", `<b>${e.start}–${e.end}</b>  ·  ${e.number} ${w.lesson}${completed ? "  ✓" : ""}`);
      for (const v of e.variants) {
        lines.push(...textLines(v.subject).map(line => `<b>${line}</b>`));
        const metadata = [v.room && `${w.room} ${v.room}`, v.teacher].filter(Boolean).join(" · ");
        if (metadata) lines.push(...textLines(metadata).map(line => `<i>${line}</i>`));
      }
      for (const n of e.notes) lines.push(...textLines(n.text).map(line => `<i>${line}</i>`));
    } else {
      // The shared bell grid is reused. There is deliberately no room-329
      // fallback in the personal formatter.
      const label = `${w[e.type]} · ${e.start}–${e.end}`;
      if (e.type === "break") lines.push(`<i>${label}</i>`);
      else lines.push("", heading(e.type === "lunch" ? "lunch" : e.type === "large_break" ? "large_break" : "view", label, branded));
    }
  }
  for (const n of [...schedule.statuses, ...schedule.notes]) lines.push("", ...textLines(n.text));
  if (!visible && schedule.lessons.length) lines.push("", `<i>${w.ended}</i>`);
  const bodies = []; let body = "";
  for (const line of lines) {
    if (body.length + line.length + 1 > 3300) { bodies.push(body); body = ""; }
    body += `${body ? "\n" : ""}${line}`;
  }
  bodies.push(body);
  const parts = bodies.map((body, index) => `${title}${bodies.length > 1 ? ` · ${w.part} ${index + 1}/${bodies.length}` : ""}\n\n${body}`);
  const keyboard = { inline_keyboard: [
    [button(mode === "full" ? w.compact : w.full, `view:${schedule.date}:${mode === "full" ? "compact" : "full"}`, { plain: true, style: "primary" })],
    [button(w.main, "menu", { plain: true })],
  ] };
  const hashes = parts.map((text, i) => createHash("sha256").update(JSON.stringify([text, i ? null : keyboard])).digest("hex"));
  const result = { parts, keyboard, hashes };
  if (cohortRenders.size >= 64) cohortRenders.delete(cohortRenders.keys().next().value);
  cohortRenders.set(cacheKey, result);
  return result;
}

export function nextRenderAt(schedule, now = new Date(), { mode = "compact" } = {}) {
  // The pilot also renders lesson starts. Pin deadlines remain independent.
  const timeline = scheduleViewTimeline(schedule);
  const boundaries = timeline.filter(e => e.end && (mode !== "full" || e.type === "lesson"))
    .map(e => Date.parse(`${schedule.date}T${e.end}:00+03:00`)).filter(ms => ms > now.getTime());
  const midnight = Date.parse(`${addDays(schedule.date, 1)}T00:00:00+03:00`);
  if (hasLessonSummary(schedule)) {
    const lessons = timeline.filter(e => e.type === "lesson" && e.start && e.end);
    if (lessons.length) {
      boundaries.push(...[`00:00`, ...lessons.map(e => e.start)]
        .map(time => Date.parse(`${schedule.date}T${time}:00+03:00`)).filter(ms => ms > now.getTime()));
    }
  }
  if (midnight > now.getTime() && timeline.some(e => !e.end && (mode !== "full" || e.type === "lesson"))) boundaries.push(midnight);
  // Coalesce deadlines into three-minute windows.
  return boundaries.length ? Math.ceil(Math.min(...boundaries) / 180000) * 180000 : null;
}

export function nextPersonalPinAt(cards, current, now = new Date()) {
  // Evaluate actual candidates with the same monotonic rule as delivery.
  const boundaries = cards.filter(c => c.hasLessons && c.messageId).flatMap(c => [
    Date.parse(`${c.date}T00:00:00+03:00`), Date.parse(`${c.date}T16:30:00+03:00`),
  ]).filter(ms => ms > now.getTime()).sort((a,b) => a-b);
  return boundaries.find(ms => choosePersonalPin(cards, current, new Date(ms))) ?? null;
}
