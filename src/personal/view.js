import { createHash } from "node:crypto";
import { dateInTimezone, timeInTimezone, addDays } from "../dates.js";
import { escapeHtml, dateTitle } from "../schedule/format.js";
import { scheduleViewTimeline } from "../schedule/view-timeline.js";

// Public contact only, never used to grant access to the bot
export const AUTHOR_USERNAME = "your_username";

export const words = {
  ru: { menu: "🏠 Твоё расписание МГМК\n\nВыбирай нужный день кнопками ниже\nНовые расписания и замены придут автоматически\n\n📌 Расписание закрепляется само\nЕсли закреп не нужен, отключи его в настройках", schedule: "Расписание", today: "Сегодня", tomorrow: "Завтра", next: "Ближайший день",
    settings: "Настройки", help: "Как пользоваться", support: "Поддержать автора", group: "Группа", language: "Язык",
    feedback: "Обратная связь", privacy: "О боте и данных", contact: "Написать автору",
    feedbackText: "💬 Есть идея или что-то работает не так?\n\nНапиши автору - @{contact}\nМожно предложить улучшение, сообщить об ошибке или просто задать вопрос\n\nЕсли проблема с расписанием, укажи группу и дату и по возможности приложи скриншот\nТак будет проще разобраться 👇",
    privacyText: "ℹ️ Откуда берётся расписание\n\nБот читает PDF из Google Диска колледжа и обновляет карточки при изменениях источника\nПо времени Минска прошедшие уроки скрываются в актуальном виде, а закреп переключается автоматически\n\n⚠️ Расписание может измениться\n\nПравки от куратора или преподавателя могут появиться в чате раньше, чем в PDF, или вообще не попасть в него\nВозможны задержки обновления и ошибки разбора\n\nСверяй важные изменения с сообщениями куратора и преподавателей\nНе полагайся только на бота - запись в нём не подтверждает отмену или перенос занятия\n\n🔐 Что сохраняется\n\nДля работы нужны твой Telegram ID, выбранная группа, язык, настройки и технические записи доставки\nПереписка и юзернейм в личном кабинете не сохраняются\nБот использует Telegram и Cloudflare, публичные PDF обрабатываются через GitHub Actions\n\nВопросы или просьба удалить данные - @{contact}",
    sound: "Звук новых карточек", changes: "Уведомления о заменах", auto_pin: "Автоматический закреп", pin: "Сообщение о закрепе", pause: "Пауза автообновлений",
    resume: "Возобновить автообновления", back: "Назад", more: "Далее", choose: "👥 Какая у тебя группа?\n\nВыбери её ниже или отправь обозначение сообщением",
    missing: "Расписание пока не опубликовано или ещё не прочитано. Это не означает, что занятий нет.",
    full: "Прошедшие уроки", compact: "Только актуальное", ended: "Учебный день завершён", lesson: "урок", room: "Кабинет",
    break: "Перемена", large_break: "Большая перемена", lunch: "ОБЕД", curator_hour: "Кураторский час", information_hour: "Информационный час",
    supportText: "💛 Бот помогает не теряться в расписании и заменах\n\nЕсли он тебе пригодился — загляни в канал автора или поддержи развитие\nЭто по желанию, расписание всегда доступно бесплатно",
    channel: "ТГК автора", donate: "Поддержать развитие", later: "Позже", details: "Реквизиты скоро появятся", closed: "👌 Хорошо, возвращаемся к расписанию",
    helpText: "👋 Привет, это твоё расписание МГМК\n\n👥 Выбери свою группу — дальше бот сам пришлёт новые расписания и предупредит о заменах\n\n📅 Сегодня и Завтра открывают нужный день\n⏭ Ближайший день поможет заглянуть вперёд, даже если впереди выходные\n🕘 Прошедшие уроки можно вернуть кнопкой под карточкой\n\n📌 До 16:30 в закрепе остаётся сегодняшний день, а потом — ближайший опубликованный будущий\nЗанятия после 16:30 продолжают отображаться до своего окончания\n\n⚙️ В настройках можно сменить группу и язык, отключить звук или поставить автообновления на паузу\nНа паузе расписание по кнопкам всё равно доступно\n\n📌 Автоматический закреп уже включён\nЕсли он тебе не нужен, отключи его в настройках",
    settingsText: "⚙️ Настроим под тебя\n\n👥 Группу и язык можно поменять в любой момент\n🔊 Звук — для новых карточек\n🔔 Замены — отдельные сообщения об изменении предметов\n📌 Автоматический закреп включён\nЕсли он не нужен, отключи его кнопкой ниже\n⏸ Пауза останавливает автоматические обновления, но кнопки расписания продолжают работать",
    changed: "Изменения в расписании", added: "добавлен", removed: "отменён", on: "вкл", off: "выкл", saving: "Автообновления временно отложены для сохранения бесплатного лимита. Расписание можно открыть вручную.",
    part: "часть", emptyPart: "Расписание теперь помещается в предыдущих частях.", pinned: "Закреплено расписание", pilot: "Пилот пока доступен ограниченной аудитории." },
  en: { settingsText: "⚙️ Make it yours\n\nChange your group and language below\nSound applies to new cards, change alerts report lesson replacements\nAutomatic pinning is on by default - turn it off below if you do not need it\nPause stops automatic updates, manual viewing remains available", menu: "Personal timetable", schedule: "Timetable", today: "Today", tomorrow: "Tomorrow", next: "Next school day",
    settings: "Settings", help: "How to use", support: "Support the author", group: "Group", language: "Language",
    feedback: "Feedback", privacy: "About and privacy", contact: "Message the author",
    feedbackText: "💬 Have an idea or noticed something wrong?\n\nMessage the author - @{contact}\nSuggest an improvement, report a bug or ask a question\n\nFor timetable issues, include your group, date and a screenshot if possible\nThis helps us look into it 👇",
    privacyText: "ℹ️ Where the timetable comes from\n\nThe bot reads PDFs from the college Google Drive and updates cards when the source changes\nCompleted lessons are hidden in the current view using Minsk time and pins switch automatically\n\n⚠️ Timetables can change\n\nYour tutor or teacher may post changes before the PDF is updated, or those changes may never reach the PDF\nUpdates can be delayed and parsing errors are possible\n\nCheck important changes with your tutor and teachers\nDo not rely only on the bot - its timetable does not confirm that a lesson was cancelled or moved\n\n🔐 Stored data\n\nThe bot stores your Telegram ID, selected group, language, preferences and technical delivery records\nPrivate chat history and usernames are not stored in the personal service\nThe bot uses Telegram and Cloudflare, public PDFs are processed through GitHub Actions\n\nQuestions or data deletion requests - @{contact}",
    sound: "Sound for new timetables", changes: "Lesson change alerts", auto_pin: "Automatic pin", pin: "Pin announcement", pause: "Pause automatic updates",
    resume: "Resume automatic updates", back: "Back", more: "Next", choose: "Choose a group or enter its name:",
    missing: "The timetable has not been published or read yet. This does not mean there are no lessons.",
    full: "Past lessons", compact: "Current lessons only", ended: "The school day is over", lesson: "lesson", room: "Room",
    break: "Break", large_break: "Long break", lunch: "LUNCH", curator_hour: "Tutor period", information_hour: "Information period",
    supportText: "Timetables are free. You can support the bot's development or visit the author's channel.",
    channel: "Author's channel", donate: "Support development", later: "Later", details: "Donation details coming soon", closed: "Offer closed. Your timetable is available from the menu.",
    helpText: "Choose one group. New timetables and lesson changes arrive automatically. Future timetables may arrive early; pins switch from 16:30 Minsk time. Pause stops automatic sends, edits and pins; manual viewing still works. Subjects, names and group labels stay as written in the PDF.",
    changed: "Timetable changes", added: "added", removed: "cancelled", on: "on", off: "off", saving: "Automatic updates are temporarily delayed to stay within the free quota. You can view your timetable manually.",
    part: "part", emptyPart: "The updated timetable fits in the preceding parts.", pinned: "Pinned timetable", pilot: "The pilot is currently available to a limited audience." },
};
for (const language of Object.values(words)) for (const key of Object.keys(language)) language[key] = language[key].replace(/[—–]/gu,'-').replace(/;/gu,',');
export const t = user => words[user?.language === "en" ? "en" : "ru"];
// Cohorts share immutable rendering in a warm isolate. This bounded cache is
// optional: correctness never depends on which isolate serves the next user.
const cohortRenders = new Map();
const icons = {feedback:'💬',privacy:'ℹ️',schedule:'📚',today:'📅',tomorrow:'🗓',next:'⏭',settings:'⚙️',help:'💡',support:'💛',group:'👥',groups:'👥',language:'🌐',lang:'🌐',back:'◀️',menu:'🏠',sound:'🔊',changes:'🔔',auto_pin:'📌',pin:'📌',paused:'⏸',donate:'💛',later:'👌'};
export const button = (text, action) => ({ text: (icons[action.split(':')[0]] ? icons[action.split(':')[0]]+' ' : action.startsWith('toggle:') ? (icons[action.split(':')[1]]??'')+' ' : '')+text, callback_data: `personal:${action}` });
export const menu = user => ({ inline_keyboard: [
  [button(t(user).schedule, "schedule")], [button(t(user).today, "today"), button(t(user).tomorrow, "tomorrow")],
  [button(t(user).next, "next"), button(t(user).settings, "settings")], [button(t(user).help, "help"), button(t(user).support, "support")],
  [button(t(user).feedback, "feedback"), button(t(user).privacy, "privacy")],
] });
export const informationText = (user, action) => t(user)[`${action}Text`].replaceAll('{contact}', escapeHtml(AUTHOR_USERNAME));
export const informationKeyboard = user => ({ inline_keyboard: [
  [{ text: `✉️ ${t(user).contact}`, url: `https://t.me/${AUTHOR_USERNAME}` }],
  [button(t(user).back, "menu")],
] });
export const supportKeyboard = user => ({ inline_keyboard: [
  [{ text: t(user).channel, url: "https://example.com" }], [button(t(user).donate, "donate"), button(t(user).later, "later")],
] });
export function settingsKeyboard(user) {
  const w = t(user);
  return { inline_keyboard: [[button(w.group, "groups:0"), button(w.language, "language")],
    ...["auto_pin", "sound", "changes"].map(key => [button(`${w[key]}: ${user[key] ? w.on : w.off}`, `toggle:${key}`)]),
    [button(user.paused ? w.resume : w.pause, "toggle:paused")], [button(w.back, "menu")]] };
}
export function groupsKeyboard(groups, user, page = 0) {
  const pages = Math.max(1, Math.ceil(groups.length / 10));
  page = Math.max(0, Math.min(pages - 1, page));
  const items = groups.slice(page * 10, (page + 1) * 10);
  const rows = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2).map(g => button(g.displayName, `group:${g.id}`)));
  rows.push([...(page ? [button(t(user).back, `groups:${page - 1}`)] : []), button(`${page + 1}/${pages}`, `groups:${page}`),
    ...(page + 1 < pages ? [button(t(user).more, `groups:${page + 1}`)] : [])]);
  rows.push([button(t(user).back, "menu")]);
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
export function renderPersonal(schedule, user, { mode = "compact", now = new Date() } = {}) {
  const w = t(user), today = dateInTimezone(now, "Europe/Minsk"), time = timeInTimezone(now, "Europe/Minsk");
  const timeline = scheduleViewTimeline(schedule);
  const ended = e => schedule.date < today || (schedule.date === today && e.end && e.end <= time);
  const cacheKey = JSON.stringify([schedule.hash, schedule.displayGroup, user.language === "en" ? "en" : "ru", mode, timeline.map(ended)]);
  if (cohortRenders.has(cacheKey)) return cohortRenders.get(cacheKey);
  const day = new Date(`${schedule.date}T12:00:00Z`);
  const dateLabel = user.language === "en" ? `${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day.getUTCDay()]}, ${day.getUTCDate()} ${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][day.getUTCMonth()]}` : dateTitle(schedule.date);
  const heading = `<b>📚 ${w.schedule} - ${escapeHtml(schedule.displayGroup)}</b>\n📅 ${dateLabel}`;
  const lines = [];
  let visible = 0;
  for (const e of timeline) {
    const completed = ended(e);
    if (mode === "compact" && completed) continue;
    visible++;
    if (e.type === "lesson") {
      lines.push("", `<b>${completed ? "✅ " : ""}${e.number} ${w.lesson} · ${e.start}-${e.end}</b>`);
      for (const v of e.variants) {
        lines.push(...textLines(`📖 ${v.subject}`));
        if (v.room) lines.push(...textLines(`🚪 ${w.room}: ${v.room}`));
        if (v.teacher) lines.push(...textLines(`👤 ${v.teacher}`));
      }
      for (const n of e.notes) lines.push(...textLines(`ℹ️ ${n.text}`));
    } else {
      // The shared bell grid is reused. There is deliberately no room-329
      // fallback in the personal formatter.
      const label = `${w[e.type]} · ${e.start}–${e.end}`;
      lines.push("", ["break", "large_break", "lunch"].includes(e.type) ? `<u>${label}</u>` : label);
    }
  }
  for (const n of [...schedule.statuses, ...schedule.notes]) lines.push("", ...textLines(n.text));
  if (!visible && schedule.lessons.length) lines.push("", `✅ ${w.ended}`);
  const bodies = []; let body = "";
  for (const line of lines) {
    if (body.length + line.length + 1 > 3300) { bodies.push(body); body = ""; }
    body += `${body ? "\n" : ""}${line}`;
  }
  bodies.push(body);
  const parts = bodies.map((body, index) => `${heading}${bodies.length > 1 ? ` · ${w.part} ${index + 1}/${bodies.length}` : ""}\n\n${body}`);
  const keyboard = { inline_keyboard: [[button(mode === "full" ? w.compact : w.full, `view:${schedule.date}:${mode === "full" ? "compact" : "full"}`)],
    [button(user.language === "en" ? "Menu" : "Главное меню", "menu")]] };
  const hashes = parts.map((text, i) => createHash("sha256").update(JSON.stringify([text, i ? null : keyboard])).digest("hex"));
  const result = { parts, keyboard, hashes };
  if (cohortRenders.size >= 64) cohortRenders.delete(cohortRenders.keys().next().value);
  cohortRenders.set(cacheKey, result);
  return result;
}

export function nextRenderAt(schedule, now = new Date()) {
  const today = dateInTimezone(now, "Europe/Minsk");
  const boundaries = schedule.timeline.flatMap(e => [e.start, e.end]).filter(Boolean)
    .map(time => Date.parse(`${schedule.date}T${time}:00+03:00`)).filter(ms => ms > now.getTime());
  const pin = Date.parse(`${today}T16:30:00+03:00`);
  if (pin > now.getTime()) boundaries.push(pin);
  // Coalesce deadlines into three-minute windows.
  return boundaries.length ? Math.ceil(Math.min(...boundaries) / 180000) * 180000 : null;
}
