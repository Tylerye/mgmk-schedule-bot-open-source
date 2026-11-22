import { createHash } from "node:crypto";
import { dateInTimezone, timeInTimezone, addDays } from "../dates.js";
import { escapeHtml, dateTitle } from "../schedule/format.js";
import { scheduleViewTimeline } from "../schedule/view-timeline.js";
import { hasLessonSummary, lessonSummary } from "./lesson-summary.js";

// Public contact only, never used to grant access to the bot
export const AUTHOR_USERNAME = "your_username";

export const words = {
  ru: { menu: "<b>МГМК · Расписание</b>\n\nВыбери день. Новое расписание и замены придут сюда автоматически.", updates: "Обновления", table: "Таблица", textView: "Обычный текст", main: "Главное меню", schedule: "Расписание", today: "Сегодня", tomorrow: "Завтра", next: "Ближайший день",
    settings: "Настройки", help: "Как пользоваться", support: "Поддержать автора", group: "Группа", language: "Язык",
    feedback: "Обратная связь", privacy: "О боте и данных", contact: "Написать автору",
    feedbackText: "<b>Обратная связь</b>\n\nЕсть идея или нашли ошибку? Напиши @{contact}.\n\nЕсли вопрос о расписании, укажи группу и дату. Скриншот поможет разобраться.",
    privacyText: "<b>О боте и данных</b>\n\nБот читает PDF колледжа из Google Диска. С 20:00 до 06:30 по Минску автообновления идут раз в 15 минут. Открыть расписание вручную можно в любое время.\n\nВажные изменения сверяй с куратором или преподавателем: их сообщения могут появиться раньше PDF. Не полагайся только на бота при отмене или переносе пары.\n\n<blockquote expandable><b>Какие данные сохраняются?</b>\nTelegram ID, группа, язык, настройки и технические записи доставки. Если оставишь оценку, бот сохранит её один раз. Переписка и юзернейм в личном кабинете не сохраняются.\n\nБот работает в Telegram и Cloudflare, публичные PDF обрабатываются через GitHub Actions. Вопросы и удаление данных: @{contact}.</blockquote>",
    sound: "Звук новых карточек", changes: "Уведомления о заменах", auto_pin: "Автоматический закреп", pin: "Сообщение о закрепе", pause: "Пауза автообновлений",
    resume: "Возобновить автообновления", back: "Назад", more: "Далее", choose: "<b>Выбери группу</b>\n\nНайди свою группу в списке или отправь её обозначение сообщением.",
    missing: "Расписание пока не опубликовано или ещё не прочитано. Это не означает, что занятий нет.",
    full: "Прошедшие уроки", compact: "Только актуальное", ended: "Учебный день завершён", lesson: "урок", room: "Кабинет",
    break: "Перемена", large_break: "Большая перемена", lunch: "ОБЕД", curator_hour: "Кураторский час", information_hour: "Информационный час",
    supportText: "<b>Поддержать автора</b>\n\nРасписание доступно бесплатно. Если бот экономит тебе время, можешь добровольно поддержать его работу.",
    channel: "ТГК автора", donate: "Реквизиты", later: "Позже", details: "Реквизиты сейчас недоступны.", closed: "Ты в меню расписания.",
    helpText: "<b>Как пользоваться</b>\n\n<b>Открыть расписание</b>\n«Сегодня» и «Завтра» открывают нужный день. «Ближайший день» найдёт следующее опубликованное расписание.\n\n<b>Посмотреть весь день</b>\n«Таблица» показывает время, предметы и кабинеты. Между опубликованными днями можно переключаться стрелками.\n\n<blockquote expandable><b>Автообновления и закреп</b>\nЗамены приходят автоматически. С 16:30 по Минску закреп выбирает ближайший опубликованный будущий день. Занятия после 16:30 видны до окончания.\n\nЗакреп, звук, уведомления о заменах и паузу можно настроить. Ручные кнопки работают и на паузе.</blockquote>",
    settingsText: "<b>Настройки</b>\n\nЗдесь можно сменить группу и язык, настроить закреп и уведомления.\n\n<blockquote expandable><b>Что меняют переключатели?</b>\nЗвук относится к новым карточкам, а уведомления о заменах приходят отдельно. Автоматический закреп включён по умолчанию. На паузе кнопки расписания продолжают работать.</blockquote>",
    changed: "Изменения в расписании", added: "добавлен", removed: "отменён", on: "вкл", off: "выкл", saving: "Автообновления временно отложены для сохранения бесплатного лимита. Расписание можно открыть вручную.",
    part: "часть", emptyPart: "Расписание теперь помещается в предыдущих частях.", pinned: "Закреплено расписание", pilot: "Пилот пока доступен ограниченной аудитории." },
  en: { settingsText: "<b>Settings</b>\n\nChoose your group, language, pin and notifications.\n\n<blockquote expandable><b>How the switches work</b>\nSound applies to new cards. Lesson changes arrive as separate alerts. Automatic pinning is on by default. Pausing leaves manual navigation available.</blockquote>", menu: "<b>МГМК · Timetable</b>\n\nChoose a day. New timetables and lesson changes arrive here automatically.", updates: "What’s new", table: "Table", textView: "Plain text", main: "Main menu", schedule: "Timetable", today: "Today", tomorrow: "Tomorrow", next: "Next school day",
    settings: "Settings", help: "How to use", support: "Support the author", group: "Group", language: "Language",
    feedback: "Feedback", privacy: "About and privacy", contact: "Message the author",
    feedbackText: "<b>Feedback</b>\n\nHave an idea or found a problem? Message @{contact}.\n\nFor timetable issues, include your group and date. A screenshot helps.",
    privacyText: "<b>About and privacy</b>\n\nThe bot reads the college PDFs from Google Drive. From 20:00 to 06:30 Minsk time, it checks for updates every 15 minutes. Manual navigation works anytime.\n\nCheck important changes with your tutor or teacher. Their notices may appear before an updated PDF. A timetable entry does not confirm a cancellation or a move.\n\n<blockquote expandable><b>What is stored?</b>\nYour Telegram ID, group, language, preferences and technical delivery records. A rating is stored once if you leave one. Private chat history and usernames are not stored by the personal service.\n\nThe bot runs on Telegram and Cloudflare. GitHub Actions processes public PDFs. Questions or deletion requests: @{contact}.</blockquote>",
    sound: "Sound for new timetables", changes: "Lesson change alerts", auto_pin: "Automatic pin", pin: "Pin announcement", pause: "Pause automatic updates",
    resume: "Resume automatic updates", back: "Back", more: "Next", choose: "<b>Choose your group</b>\n\nPick it from the list or send the group name.",
    missing: "The timetable has not been published or read yet. This does not mean there are no lessons.",
    full: "Past lessons", compact: "Current lessons only", ended: "The school day is over", lesson: "lesson", room: "Room",
    break: "Break", large_break: "Long break", lunch: "LUNCH", curator_hour: "Tutor period", information_hour: "Information period",
    supportText: "<b>Support the author</b>\n\nThe timetable is free. If the bot saves you time, you can make a voluntary contribution.",
    channel: "Author's channel", donate: "Payment details", later: "Later", details: "Payment details are currently unavailable.", closed: "You are back at the timetable menu.",
    helpText: "<b>How to use the timetable</b>\n\n<b>Find a day</b>\nToday and Tomorrow open those dates. Next school day finds the next published timetable.\n\n<b>See the whole day</b>\nTable shows times, subjects and rooms. Use the arrows to browse published days.\n\n<blockquote expandable><b>Automatic updates and pinning</b>\nLesson changes arrive automatically. From 16:30 Minsk time, the pin moves to the next published future day. Later classes stay visible until they finish.\n\nOpen Settings to change pinning, sound, change alerts or pause. You can still open the timetable while paused.</blockquote>",
    changed: "Timetable changes", added: "added", removed: "cancelled", on: "on", off: "off", saving: "Automatic updates are temporarily delayed to stay within the free quota. You can view your timetable manually.",
    part: "part", emptyPart: "The updated timetable fits in the preceding parts.", pinned: "Pinned timetable", pilot: "The pilot is currently available to a limited audience." },
};
for (const language of Object.values(words)) for (const key of Object.keys(language)) language[key] = language[key].replace(/[—–]/gu,'-').replace(/;/gu,',');
export const t = user => words[user?.language === "en" ? "en" : "ru"];
// Cohorts share immutable rendering in a warm isolate. This bounded cache is
// optional: correctness never depends on which isolate serves the next user.
const cohortRenders = new Map();
const icons = {back:"↩️",updates:"✨",table:"📋",view:"🕘",preview:"🕘",feedback:'💬',privacy:'ℹ️',schedule:'📚',today:'📅',tomorrow:'🗓',next:'⏭',settings:'⚙️',help:'💡',support:'💛',group:'👥',groups:'👥',language:'🌐',lang:'🌐',menu:'🏠',sound:'🔊',changes:'🔔',auto_pin:'📌',pin:'📌',paused:'⏸',donate:'💛',later:'👌'};
export const widgetGroup = "8СА";
export const widgetLabel = user => user.language === "en" ? "Day by lesson · HTML" : "День по урокам · HTML";
const menuEmoji = {
  today: "5197680953882883689",
  tomorrow: "5197618530828202500",
  settings: "5197388333466041903",
  next: "5195169072324589074",
  schedule: "5195345685674768707",
  help: "5194981468153098754",
  support: "5195026432165724121",
  feedback: "5195418511140237268",
  privacy: "5195285569017523087",
  updates: "5197289295815159555",
  menu: "5195147176581313146",
  table: "5197713793202829678",
  view: "5195052549861848434",
  group: "5197402489678243789",
  language: "5195156775833218565",
  sound: "5195066426901183518",
  changes: "5195143336880550013",
  paused: "5194911670639570898",
  auto_pin: "5197244563730772418",
  back: "5195318936618449178",
};

export function button(text, action, { branded = false, plain = false, style } = {}) {
  const [kind, option] = action.split(":");
  const icon = kind === "toggle" ? (option === "pin" ? "auto_pin" : option)
    : ({ groups: "group", lang: "language", donate: "support", preview: "view", later: "back" })[kind] ?? kind;
  const emoji = branded && kind !== "group" && menuEmoji[icon];
  const label = !emoji && !plain && kind !== "group" && icons[icon] ? `${icons[icon]} ${text}` : text;
  return { text: label, callback_data: `personal:${action}`, ...(style && { style }), ...(emoji && { icon_custom_emoji_id: emoji }) };
}

export function withoutMenuEmoji(keyboard) {
  const rows = keyboard?.inline_keyboard;
  if (!rows?.some(row => row.some(item => item.icon_custom_emoji_id))) return null;
  return { inline_keyboard: rows.map(row => row.map(item => {
    const { icon_custom_emoji_id: emoji, ...fallback } = item;
    if (!emoji) return item;
    const action = fallback.callback_data.slice("personal:".length);
    return { ...fallback, text: button(fallback.text, action).text };
  })) };
}

export function menu(user, widgetEnabled = false, branded = false) {
  const w = t(user);
  return { inline_keyboard: [
    [button(w.today, "today", { branded, style: "primary" }), button(w.tomorrow, "tomorrow", { branded, style: "success" })],
    [button(w.schedule, "schedule", { branded, style: "primary" }), button(w.next, "next", { branded, style: "success" })],
    ...(widgetEnabled && user.group_id === widgetGroup ? [[button(widgetLabel(user), "widget")]] : []),
    [button(w.settings, "settings", { branded }), button(w.help, "help", { branded })],
    [button(w.updates, "updates:0", { branded, style: "primary" })],
    [button(w.feedback, "feedback", { branded }), button(w.privacy, "privacy", { branded })],
    [button(w.support, "support", { branded, style: "success" })],
  ] };
}

export const backToMenu = (user, branded) => ({ inline_keyboard: [[button(t(user).main, "menu", { branded })]] });
export const informationText = (user, action) => t(user)[`${action}Text`].replaceAll('{contact}', escapeHtml(AUTHOR_USERNAME));
export const informationKeyboard = (user, branded) => ({ inline_keyboard: [
  [{ text: t(user).contact, url: `https://t.me/${AUTHOR_USERNAME}`, style: "primary" }],
  ...backToMenu(user, branded).inline_keyboard,
] });
export const supportKeyboard = (user, branded) => ({ inline_keyboard: [
  [button(t(user).donate, "donate", { branded, style: "success" })],
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
    english ? "<i>Thank you for your support.</i>" : "<i>Спасибо за поддержку.</i>",
  ].join("\n\n");
}
export function settingsKeyboard(user, branded) {
  const w = t(user);
  return { inline_keyboard: [[button(w.group, "groups:0", { branded }), button(w.language, "language", { branded })],
    ...["auto_pin", "sound", "changes"].map(key => [button(`${w[key]}: ${user[key] ? w.on : w.off}`, `toggle:${key}`, { branded, style: user[key] ? "success" : undefined })]),
    [button(user.paused ? w.resume : w.pause, "toggle:paused", { branded, style: user.paused ? "success" : undefined })], ...backToMenu(user, branded).inline_keyboard] };
}
export function groupsKeyboard(groups, user, page = 0, branded) {
  const pages = Math.max(1, Math.ceil(groups.length / 10));
  page = Math.max(0, Math.min(pages - 1, page));
  const items = groups.slice(page * 10, (page + 1) * 10);
  const rows = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2).map(g => button(g.displayName, `group:${g.id}`)));
  rows.push([...(page ? [button(t(user).back, `groups:${page - 1}`)] : []), button(`${page + 1}/${pages}`, `groups:${page}`),
    ...(page + 1 < pages ? [button(t(user).more, `groups:${page + 1}`)] : [])]);
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

export function renderPersonal(schedule, user, { mode = "compact", now = new Date(), lessonChanges } = {}) {
  const w = t(user), today = dateInTimezone(now, "Europe/Minsk"), time = timeInTimezone(now, "Europe/Minsk");
  const timeline = scheduleViewTimeline(schedule);
  const ended = e => schedule.date < today || (schedule.date === today && e.end && e.end <= time);
  const summary = hasLessonSummary(schedule) && schedule.date === today ? lessonSummary(timeline, time, user.language === "en") : [];
  const changes = lessonChanges?.filter(change => schedule.date >= today && !timeline.some(e => e.type === "lesson" && e.number === change.number && ended(e)));
  const cacheKey = JSON.stringify([schedule.hash, schedule.displayGroup, user.language === "en" ? "en" : "ru", mode, timeline.map(ended), summary, changes]);
  if (cohortRenders.has(cacheKey)) return cohortRenders.get(cacheKey);
  const heading = `<b>${w.schedule} · ${escapeHtml(schedule.displayGroup)}</b>\n<i>${personalDateLabel(schedule, user)}</i>`;
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
      lines.push("", `<b>${e.number} ${w.lesson}</b>  ·  <code>${e.start}–${e.end}</code>${completed ? "  ✓" : ""}`);
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
      lines.push("", ["break", "large_break", "lunch"].includes(e.type) ? `<i>${label}</i>` : `<b>${label}</b>`);
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
  const parts = bodies.map((body, index) => `${heading}${bodies.length > 1 ? ` · ${w.part} ${index + 1}/${bodies.length}` : ""}\n\n${body}`);
  const keyboard = { inline_keyboard: [
    [button(mode === "full" ? w.compact : w.full, `view:${schedule.date}:${mode === "full" ? "compact" : "full"}`, { plain: true }),
      button(w.table, `table:${schedule.date}`, { plain: true, style: "primary" })],
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
