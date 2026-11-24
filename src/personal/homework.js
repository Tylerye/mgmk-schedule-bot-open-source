import { createHash } from "node:crypto";
import { addDays, dateInTimezone, timeInTimezone } from "../dates.js";
import { escapeHtml } from "../schedule/format.js";
import { plannedDay } from "./week.js";
import { lessonHeading } from "../chat-theme.js";
import { button, personalDateLabel, screenText, t } from "./view.js";
import { homeworkTextLimit } from "./update.js";

const zone = "Europe/Minsk";
const limit = 100;
const pageSize = 6;
const homeworkKey = id => "homework:" + id;
const short = (value, max) => Array.from(value).slice(0, max).join("");
const subjectName = name => short(name.replace(/\s+/gu, " ").trim(), 150);
const foldName = name => subjectName(name).normalize("NFKC").toLowerCase().replaceAll("ё", "е").replaceAll("і", "и");
const subjectToken = name => foldName(name).replace(/[^\p{L}\p{N}]/gu, "");
const aliases = new Map([
  ["Белорусская литература", "Бел.лит-ра", "Белолитра"],
  ["Белорусский язык", "Бел.язык", "Беляз"],
  ["Русская литература", "Русск.лит-ра"],
  ["Русский язык", "Русск.язык"],
  ["Иностранный язык", "Ин.язык", "Иняз"],
  ["История Беларуси в контексте всемирной истории", "История Беларуси", "История Бел"],
  ["Допуски, посадки и технические измерения", "Допуски и пос.", "Допуски и посадки"],
  ["Общий курс слесарного дела", "Слесарное дело", "Слесарка"],
  ["Физическая культура и здоровье", "Физкультура", "Физическая культура"],
  ["Электротехника", "Элтехника", "Эл.техн."],
  ["Производственное обучение", "Произв.обуч", "Произв. обучение"],
  ["Устройство транспортных средств", "Уст-во тр/сред"],
  ["Специальная технология", "Спецтехнология"],
  ["Основы технологии машиностроения", "Техмаш"],
].flatMap(([full, ...variants]) => variants.map(variant => [subjectToken(variant), subjectToken(full)])));
const hash = value => createHash("sha256").update(value).digest("hex").slice(0, 16);
const subjectKey = name => {
  const token = subjectToken(name);
  return hash(aliases.get(token) ?? token);
};
const techmach = subjectKey("Техмаш");
const legacyKey = name => hash(subjectName(name).normalize("NFKC").toLowerCase().replaceAll("ё", "е"));
const subjectsOf = schedule => (schedule?.lessons ?? []).flatMap(lesson => lesson.variants.map(variant => subjectName(variant.subject)).filter(Boolean));

export async function homeworkTimetable(store, group, now, from) {
  const today = dateInTimezone(now, zone), rangeEnd = addDays(today, 28);
  const { schedules, plan, publishedDates } = await store.weekSchedules(group, from && from < today ? from : today, rangeEnd);
  const published = new Map(schedules.map(schedule => [schedule.date, schedule]));
  for (const date of publishedDates) if (!published.has(date)) published.set(date, null);
  return { today, rangeEnd, plan, published };
}

const daySchedule = ({ published, plan }, date) => published.has(date) ? published.get(date) : plannedDay(plan, date);
const hasSubject = (schedule, key) => subjectsOf(schedule).some(name => subjectKey(name) === key);
const lessonStillAhead = (lesson, time) => lesson.end ? lesson.end > time : lesson.start > time;
const earliestDate = item => item.relative?.from ?? item.date;
function lessonsMatching(schedule, key, after) {
  if (!after) return hasSubject(schedule, key);
  return subjectsOf({ lessons: schedule?.timeline?.filter(lesson => lesson.type === "lesson" && lessonStillAhead(lesson, after)) })
    .some(name => subjectKey(name) === key);
}

function earliestHomework(items, group, now) {
  const earliest = addDays(dateInTimezone(now, zone), -28);
  return items.reduce((from, item) => {
    const date = earliestDate(item);
    return !item.done && item.group === group && date >= earliest && (from === undefined || date < from) ? date : from;
  }, undefined);
}

// A forecast stores the chosen occurrence, counted from when the user saved
// it. Older dated entries keep their original date as an anchor.
function resolveHomework(item, timetable) {
  if (item.done) return item;
  const { today, rangeEnd, published } = timetable;
  const anchor = earliestDate(item);
  if (anchor < addDays(today, -28) || anchor > rangeEnd) return item;
  const key = subjectKey(item.subject);
  if (!item.relative && (!published.has(item.date) || hasSubject(published.get(item.date), key)))
    return { ...item, preliminary: !published.has(item.date) && item.preliminary };
  const lastDate = addDays(anchor, 28);
  let remaining = item.relative?.number ?? 1;
  for (let date = item.relative ? anchor : addDays(anchor, 1); date <= lastDate && date <= rangeEnd; date = addDays(date, 1)) {
    if (date < today && !published.has(date)) continue;
    const after = date === anchor ? item.relative?.after : null;
    if (lessonsMatching(daySchedule(timetable, date), key, after) && --remaining === 0)
      return { ...item, date, preliminary: !published.has(date) };
  }
  return { ...item, date: null };
}

function projectHomework(state, user, timetable) {
  return { ...state, items: state.items.map(item => item.group === user.group_id ? resolveHomework(item, timetable) : item) };
}

function listSubjects({ today, plan, published }) {
  const names = new Map();
  const planned = Array.from({ length: 7 }, (_, i) => plannedDay(plan, addDays(today, i)));
  const addNames = (days, fromPlan) => {
    for (const day of days) for (const name of subjectsOf(day)) {
      const key = subjectKey(name);
      const entry = names.get(key) ?? { key, legacy: new Set() };
      entry.label = fromPlan && key === techmach ? "Техмаш" : name;
      entry.legacy.add(legacyKey(name));
      names.set(key, entry);
    }
  };
  addNames(planned, true);
  addNames(published.values(), false);
  return [...names.values()].sort((a, b) => a.label.localeCompare(b.label, "ru"));
}

export function homeworkDates({ today, rangeEnd, plan, published }, key, now) {
  const time = timeInTimezone(now, zone), matches = [];
  for (let date = today; date <= rangeEnd && matches.length < 2; date = addDays(date, 1)) {
    const schedule = daySchedule({ published, plan }, date);
    if (lessonsMatching(schedule, key, date === today ? time : null)) matches.push({ date, preliminary: Boolean(schedule.preliminary) });
  }
  return matches;
}

export const readHomework = (store, id) => store.setting(homeworkKey(id), { items: [], draft: null });
export async function readCardHomework(store, user, now, through) {
  if (!user.has_homework) return null;
  const state = await readHomework(store, user.user_id);
  // Same-day items are already checked against the card's published schedule.
  const earliest = earliestHomework(state.items, user.group_id, now);
  if (!earliest || earliest > through || (earliest === through && !state.items.some(item => !item.done && item.group === user.group_id && item.relative?.from === through))) return state;
  return projectHomework(state, user, await homeworkTimetable(store, user.group_id, now, earliest));
}

export async function affectedHomeworkCards(store, user, now, sourceDate, oldSchedule, cards) {
  if (!user.has_homework || !cards.length) return [];
  const state = await readHomework(store, user.user_id);
  const earliest = earliestHomework(state.items, user.group_id, now);
  if (!earliest || earliest > sourceDate) return [];
  const calendar = await homeworkTimetable(store, user.group_id, now, earliest);
  const available = new Set(cards.filter(card => card.parts[0]?.id && card.date >= calendar.today).map(card => card.date));
  if (!available.size) return [];
  const previous = { ...calendar, published: new Map(calendar.published) };
  if (oldSchedule) previous.published.set(sourceDate, oldSchedule);
  else previous.published.delete(sourceDate);
  const dates = new Set();
  for (const item of state.items) {
    if (item.done || item.group !== user.group_id || earliestDate(item) > sourceDate) continue;
    const before = resolveHomework(item, previous).date, after = resolveHomework(item, calendar).date;
    if (before === after) continue;
    if (available.has(before)) dates.add(before);
    if (available.has(after)) dates.add(after);
  }
  return [...dates];
}
export const discardHomeworkDraft = id => ["UPDATE settings SET value=json_set(value,'$.draft',NULL) "
  + "WHERE key=? AND json_type(value,'$.draft')='object'", homeworkKey(id)];

function orderedHomework(items, schedule, group, date) {
  const due = items.filter(item => !item.done && item.group === group && item.date === date);
  if (!due.length) return [];
  const lessonNumbers = new Map();
  for (const lesson of schedule?.lessons ?? []) for (const { subject } of lesson.variants) {
    const key = subjectKey(subject);
    lessonNumbers.set(key, Math.min(lesson.number, lessonNumbers.get(key) ?? Infinity));
  }
  return due.map(item => ({ item, number: lessonNumbers.get(subjectKey(item.subject)) }))
    .filter(task => task.number !== undefined)
    .sort((a, b) => (a.number ?? 99) - (b.number ?? 99) || a.item.id - b.item.id);
}

function homeworkBlock({ item, number }, en, preview = false) {
  const text = preview ? item.text.replace(/\s+/gu, " ") : item.text;
  const excerpt = preview && text.length > 160 ? short(text, 160) + "…" : text;
  const title = number ? lessonHeading({ number }, en) + " · " : "";
  return title + "<b>" + escapeHtml(item.subject) + (preview ? ":" : "") + "</b>\n" + escapeHtml(excerpt);
}

function homeworkHeading(en, branded) {
  return screenText("homework", "<b>" + (en ? "Homework" : "ДЗ") + "</b>", branded);
}

export async function homeworkScreen(store, user, update, now, branded, statements, savedState, refreshDates) {
  const en = user.language === "en", tr = (ru, english) => en ? english : ru;
  const itemButton = (label, action, options = {}) => button(label, action, { branded, ...options });
  const back = itemButton(t(user).back, "hw", { icon: "back" });
  const main = itemButton(t(user).main, "menu");
  const header = screenText("homework", "<b>" + tr("Мое ДЗ", "My homework") + "</b>", branded);
  const screen = (text, rows = [], withMenu = false) => ({
    text: header + "\n\n" + text, keyboard: { inline_keyboard: [...rows, withMenu ? [back, main] : [back]] },
  });
  const [_, action = "list", arg, value] = update.action.split(":");
  const state = savedState ?? await readHomework(store, user.user_id);
  const { items } = state;
  const draft = state.draft?.until > now.getTime() && state.draft?.group === user.group_id ? state.draft : null;
  const entry = items.find(item => String(item.id) === arg);
  const persist = nextDraft => statements.push(["INSERT INTO settings(key,value) VALUES(?,?) "
    + "ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value IS NOT excluded.value",
  homeworkKey(user.user_id), JSON.stringify({ items, draft: nextDraft })]);
  let calendar;
  const timetable = () => calendar ??= homeworkTimetable(store, user.group_id, now, earliestHomework(items, user.group_id, now));
  const resolve = async item => item.group === user.group_id && !item.done ? resolveHomework(item, await timetable()) : item;
  const refresh = date => { if (date && date >= dateInTimezone(now, zone)) refreshDates?.add(date); };
  const expired = () => screen(tr("Этот шаг устарел\nОткрой «Мое ДЗ» и попробуй еще раз", "Open My homework and try again"));
  const dateLabel = date => date ? personalDateLabel({ date }, user) : tr("Ближайший урок · ждём расписание", "Next class · awaiting the timetable");
  const targetLabel = item => item.date && item.preliminary
    ? (item.relative?.number === 2 ? tr("Урок после ближайшего", "Class after the next one") : tr("Ближайший урок", "Next class"))
      + " · " + dateLabel(item.date) + tr(" (по плану)", " (planned)")
    : dateLabel(item.date);
  const dueFields = (selected, matches) => ({
    date: selected.date, preliminary: selected.preliminary,
    relative: selected.preliminary ? { from: dateInTimezone(now, zone), after: timeInTimezone(now, zone), number: matches.indexOf(selected) + 1 } : undefined,
  });
  const buttons = (count, page, prefix) => {
    const last = Math.max(0, Math.ceil(count / pageSize) - 1);
    return [page > 0 && itemButton("‹", prefix + (page - 1), { plain: true }),
      page < last && itemButton("›", prefix + (page + 1), { plain: true })].filter(Boolean);
  };
  const dateRows = (dates, callback, saving = false) => dates.map((day, i) => [
    itemButton((saving ? (day.preliminary ? tr(i === 0 ? "Ближайший урок" : "Следующий после него", i === 0 ? "Next class" : "One after that") + " · " : tr("Сохранить на ", "Save for ")) + dateLabel(day.date)
      : tr(i === 0 ? "Ближайший" : "Следующий после него", i === 0 ? "Next class" : "One after that") + " · " + dateLabel(day.date))
      + (day.preliminary ? tr(" (по плану)", " (planned)") : ""), callback(day.date), { plain: true }),
  ]);
  const askText = (subject, editing, date) => {
    const first = tr(editing ? "Замени текст ДЗ" : "Запиши ДЗ", editing ? "Replace homework text" : "Write homework")
      + " · " + subject + (date ? " · " + dateLabel(date) : "");
    return { first, view: { text: escapeHtml(first) + "\n\n<b>" + tr("Напиши здесь в чате или ответь на это сообщение (смахни влево или выбери «Ответить»).", "Type in this chat or reply to this message (swipe or choose Reply).")
      + "</b>\n" + tr("Текст или ссылка · до 1 000 символов", "Text or a link · up to 1,000 characters"),
      keyboard: { inline_keyboard: [[itemButton(tr("Отмена", "Cancel"), "hw:cancel:" + update.update_id, { plain: true })],
        [main]] }, editId: null } };
  };
  const detail = async (item, notice = "") => {
    const target = await resolve(item);
    const label = item.done ? tr("Выполнено", "Done") : tr("К сроку", "Due");
    return screen([notice, "<b>" + escapeHtml(item.subject) + "</b> · " + label + " " + targetLabel(target), escapeHtml(item.text)].filter(Boolean).join("\n\n"), [
      [itemButton(tr(item.done ? "Вернуть в список" : "Выполнено", item.done ? "Reopen" : "Mark done"),
        "hw:" + (item.done ? "reopen:" : "done:") + item.id, { style: "success", icon: "completed" })],
      [itemButton(tr("Изменить текст", "Edit text"), "hw:edit:" + item.id, { icon: "table" }),
        ...(item.group === user.group_id && !item.done ? [itemButton(tr("Перенести", "Move"), "hw:move:" + item.id, { plain: true })] : [])],
      [itemButton(tr("Удалить", "Delete"), "hw:remove:" + item.id, { style: "danger", plain: true })],
    ], true);
  };

  if (action === "day") {
    const source = user.group_id && items.some(item => !item.done && item.group === user.group_id && earliestDate(item) <= arg) ? await timetable() : null;
    const schedule = source && (source.published.has(arg) ? source.published.get(arg) : await store.schedule(user.group_id, arg));
    const tasks = orderedHomework(source ? projectHomework(state, user, source).items : items, schedule, user.group_id, arg);
    const pages = [[]];
    let length = 0;
    for (const task of tasks) {
      const size = task.item.text.length + task.item.subject.length + 40;
      if (length + size > 3500) { pages.push([]); length = 0; }
      pages.at(-1).push(homeworkBlock(task, en));
      length += size;
    }
    const page = Math.min(Number(value ?? 0), pages.length - 1);
    const rows = pages.length > 1 ? [[
      page > 0 && itemButton("‹", "hw:day:" + arg + ":" + (page - 1), { plain: true }),
      page + 1 < pages.length && itemButton("›", "hw:day:" + arg + ":" + (page + 1), { plain: true }),
    ].filter(Boolean)] : [];
    rows.push([itemButton(tr("Все ДЗ", "All homework"), "hw", { icon: "homework" }),
      itemButton(tr("К расписанию", "Back to timetable"), "preview:" + arg + ":compact", { icon: "back" })],
    [main]);
    const title = homeworkHeading(en, branded) + " · " + dateLabel(arg) + (pages.length > 1 ? " · " + (page + 1) + "/" + pages.length : "");
    return { text: title + "\n\n" + (pages[page].join("\n\n") || tr("На этот день ДЗ нет", "No homework on this date")),
      keyboard: { inline_keyboard: rows } };
  }
  if (action === "list") {
    const projected = items.some(item => !item.done && item.group === user.group_id) ? projectHomework(state, user, await timetable()).items : items;
    const all = [...projected].sort((a, b) => Number(a.done) - Number(b.done) || (a.date ?? "9999").localeCompare(b.date ?? "9999"));
    const page = Math.min(Number(arg ?? 0), Math.max(0, Math.ceil(all.length / pageSize) - 1));
    const shown = all.slice(page * pageSize, (page + 1) * pageSize);
    const rows = shown.map(item => [itemButton((item.done ? "✓ " : "") + targetLabel(item) + " · " + short(item.subject, 45), "hw:show:" + item.id, { plain: true })]);
    if (all.length > pageSize) rows.push(buttons(all.length, page, "hw:list:"));
    if (user.group_id) rows.push([itemButton(tr("Записать ДЗ", "Add homework"), "hw:pick:0", { style: "success", icon: "table" })]);
    if (state.draft) rows.push([itemButton(tr("Отменить черновик", "Discard draft"),
      "hw:cancel:" + state.draft.promptUpdate, { plain: true })]);
    rows.push([main]);
    const hint = !all.length ? tr("Здесь пока пусто", "No assignments yet") : "";
    return { text: header + (hint ? "\n\n" + hint : ""),
    keyboard: { inline_keyboard: rows } };
  }
  if (action === "cancel") {
    if (!state.draft || String(state.draft.promptUpdate) !== arg) return expired();
    persist(null);
    return screen(tr("Черновик отменен", "Draft discarded"));
  }
  if (action === "pick" || action === "subject") {
    if (!user.group_id) return expired();
    if (items.length >= limit) return screen(tr("У тебя уже 100 заданий\nУдали одно старое, чтобы добавить новое", "You have 100 assignments\nDelete an old one to add another"));
    const subjects = listSubjects(await timetable());
    if (action === "pick") {
      if (!subjects.length) return screen(tr("Пока нет списка предметов для твоей группы", "There are no subjects for your group yet"));
      const rows = [];
      for (const { key, label } of subjects) {
        const choice = itemButton(short(label, 58), "hw:subject:" + key, { plain: true });
        const row = rows.at(-1);
        if (row?.length === 1 && row[0].text.length <= 20 && choice.text.length <= 20) row.push(choice);
        else rows.push([choice]);
      }
      return screen(tr("Выбери предмет", "Choose a subject"), rows);
    }
    const selected = subjects.find(({ key, legacy }) => key === arg || legacy.has(arg));
    if (!selected) return expired();
    const { label: subject, key } = selected;
    const prompt = askText(subject);
    persist({ group: user.group_id, key, subject, prompt: prompt.first, promptUpdate: update.update_id, until: now.getTime() + 86_400_000, plainUntil: now.getTime() + 600_000 });
    return prompt.view;
  }
  if (action === "edit") {
    if (!entry || !user.group_id) return expired();
    const prompt = askText(entry.subject, true, (await resolve(entry)).date);
    persist({ group: user.group_id, edit: entry.id, subject: entry.subject, date: entry.date, prompt: prompt.first,
      promptUpdate: update.update_id, until: now.getTime() + 86_400_000, plainUntil: now.getTime() + 600_000 });
    return prompt.view;
  }
  if (action === "text" || action === "plain") {
    if (!draft || draft.text || (action === "text" && draft.prompt !== update.homeworkPrompt)) return expired();
    const prefix = user.user_id + ":reply:" + draft.promptUpdate + ":0:";
    const prompt = await store.first("SELECT 1 FROM operations WHERE id>=? AND id<? AND method='sendMessage' AND +status='succeeded' "
      + (action === "text" ? "AND json_extract(result,'$.message_id')=? " : "") + "LIMIT 1",
      prefix, prefix.slice(0, -1) + ";", ...(action === "text" ? [update.homeworkPromptId] : []));
    if (!prompt) return expired();
    const content = update.homeworkText.trim();
    if (!content) return screen(tr("Напиши в чат или ответь на приглашение текстом до 1 000 символов", "Type in chat or reply to the prompt with up to 1,000 characters"));
    const id = update.update_id;
    const rows = draft.edit !== undefined ? [[itemButton(tr("Сохранить", "Save"), "hw:save:" + id, { style: "success", icon: "completed" })]]
      : dateRows(homeworkDates(await timetable(), subjectKey(draft.subject), now), date => "hw:save:" + id + ":" + date, true);
    if (!rows.length) return screen(tr("Этой пары пока нет в расписании. Попробуй снова, когда появится дата.", "No upcoming classes yet. Try again when a date is available."));
    persist({ ...draft, id, text: content });
    return screen("<b>" + escapeHtml(draft.subject) + "</b>\n" + escapeHtml(content) + "\n\n" + (draft.edit !== undefined ? tr("Сохранить новый текст?", "Save the new text?")
      : tr("К какому уроку?", "Which class is it due for?")), rows);
  }
  if (action === "date" || action === "save") {
    if (!draft?.text || String(draft.id) !== arg) return expired();
    if (draft.edit !== undefined) {
      const edited = items.find(item => item.id === draft.edit);
      if (!edited || action !== "save" || value !== undefined) return expired();
      if (edited.text !== draft.text) {
        edited.text = draft.text;
        refresh((await resolve(edited)).date);
      }
      persist(null);
      return detail(edited, tr("Сохранено", "Saved"));
    }
    if (items.length >= limit || !value) return expired();
    const key = subjectKey(draft.subject);
    const dates = homeworkDates(await timetable(), key, now);
    const selected = dates.find(day => day.date === value);
    if (!selected) return screen(tr("Дата поменялась\nВыбери урок из нового расписания", "The date has changed\nPick a class from the updated timetable"),
      dateRows(dates, date => "hw:save:" + arg + ":" + date, true));
    if (action === "date") return screen("<b>" + escapeHtml(draft.subject) + "</b> · " + dateLabel(value) + "\n\n" + escapeHtml(draft.text), [
      [itemButton(tr("Сохранить", "Save"), "hw:save:" + arg + ":" + value, { style: "success", icon: "completed" })],
    ]);
    const saved = { id: draft.id, group: draft.group, subject: draft.subject, key, ...dueFields(selected, dates), text: draft.text, done: false };
    items.push(saved);
    refresh(value);
    persist(null);
    return detail(saved, tr("Сохранено", "Saved"));
  }
  if (!entry) return expired();
  if (action === "show") return detail(entry);
  if (action === "done" || action === "reopen") {
    const done = action === "done";
    if (entry.done !== done) {
      const target = await resolve({ ...entry, done: false });
      refresh(target.date);
      if (done && target.date) Object.assign(entry, { date: target.date, preliminary: target.preliminary, relative: undefined });
      entry.done = done;
      persist(state.draft);
    }
    return detail(entry);
  }
  if (action === "remove") return screen(tr("Удалить это задание?", "Delete this assignment?"), [
    [itemButton(tr("Да, удалить", "Yes, delete"), "hw:delete:" + entry.id, { style: "danger", plain: true })],
    [itemButton(tr("Отмена", "Cancel"), "hw:show:" + entry.id, { icon: "back" })],
  ]);
  if (action === "delete") {
    if (!entry.done) refresh((await resolve(entry)).date);
    items.splice(items.indexOf(entry), 1);
    persist(state.draft?.edit === entry.id ? null : state.draft);
    return screen(tr("Задание удалено", "Assignment deleted"));
  }
  if (action === "move" && !entry.done && entry.group === user.group_id) {
    if (!value) return screen(tr("Выбери новую дату", "Choose a new date"),
      dateRows(homeworkDates(await timetable(), subjectKey(entry.subject), now), date => "hw:move:" + entry.id + ":" + date));
    const matches = homeworkDates(await timetable(), subjectKey(entry.subject), now);
    const selected = matches.find(day => day.date === value);
    if (!selected) return expired();
    if (entry.date !== value || entry.preliminary !== selected.preliminary) {
      refresh((await resolve(entry)).date);
      refresh(value);
      Object.assign(entry, dueFields(selected, matches));
      persist(state.draft);
    }
    return detail(entry, tr("Срок обновлён", "Due date updated"));
  }
  return expired();
}

export function homeworkOnCard(rendered, schedule, user, state, branded) {
  if (!state?.items.length) return rendered;
  const tasks = orderedHomework(state.items, schedule, user.group_id, schedule.date);
  if (!tasks.length) return rendered;
  const en = user.language === "en";
  const parts = [...rendered.parts];
  const last = parts.length - 1;
  const heading = "\n\n\n" + screenText("homework", "<b><u>" + (en ? "Homework" : "Домашнее задание") + "</u></b>", branded);
  let summary = "";
  for (const task of tasks) {
    const block = "\n\n" + homeworkBlock(task, en, true);
    if (parts[last].length + heading.length + summary.length + block.length > 4000) break;
    summary += block;
  }
  if (summary) parts[last] += heading + summary;
  return { ...rendered, parts, keyboard: {
    inline_keyboard: [...rendered.keyboard.inline_keyboard.slice(0, -1),
      [button(en ? "Homework for this date" : "ДЗ к этому дню", "hw:day:" + schedule.date, { branded, icon: "homework" })],
      ...rendered.keyboard.inline_keyboard.slice(-1)],
  } };
}
