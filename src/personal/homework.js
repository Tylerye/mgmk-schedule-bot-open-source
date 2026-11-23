import { createHash } from "node:crypto";
import { addDays, dateInTimezone, timeInTimezone } from "../dates.js";
import { escapeHtml } from "../schedule/format.js";
import { plannedDay } from "./week.js";
import { button, personalDateLabel, screenText, t } from "./view.js";
import { homeworkTextLimit } from "./update.js";

const zone = "Europe/Minsk";
const limit = 100;
const pageSize = 6;
const homeworkKey = id => "homework:" + id;
const short = (value, max) => Array.from(value).slice(0, max).join("");
const subjectName = name => short(name.replace(/\s+/gu, " ").trim(), 150);
const subjectKey = name => createHash("sha256").update(subjectName(name).normalize("NFKC").toLowerCase().replaceAll("ё", "е")).digest("hex").slice(0, 16);
const subjectsOf = schedule => (schedule?.lessons ?? []).flatMap(lesson => lesson.variants.map(variant => subjectName(variant.subject)).filter(Boolean));

export async function homeworkTimetable(store, group, now) {
  const today = dateInTimezone(now, zone), rangeEnd = addDays(today, 28);
  const { schedules, plan } = await store.weekSchedules(group, addDays(today, -6), rangeEnd);
  const published = new Map(schedules.map(schedule => [schedule.date, schedule]));
  return { today, rangeEnd, plan, published };
}

function listSubjects({ today, plan, published }) {
  const names = new Map();
  const days = [...published.values(), ...Array.from({ length: 7 }, (_, i) => plannedDay(plan, addDays(today, i)))];
  for (const day of days) for (const name of subjectsOf(day)) names.set(subjectKey(name), name);
  return [...names].sort((a, b) => a[1].localeCompare(b[1], "ru"));
}

export function homeworkDates({ today, rangeEnd, plan, published }, key, now) {
  const time = timeInTimezone(now, zone), matches = [];
  for (let date = today; date <= rangeEnd && matches.length < 2; date = addDays(date, 1)) {
    const schedule = published.get(date) ?? plannedDay(plan, date);
    const lessons = date === today ? schedule?.timeline?.filter(lesson => lesson.type === "lesson" && lesson.start > time)
      : schedule?.lessons;
    if (subjectsOf({ lessons }).some(name => subjectKey(name) === key)) matches.push({ date, preliminary: Boolean(schedule.preliminary) });
  }
  return matches;
}

export const readHomework = (store, id) => store.setting(homeworkKey(id), { items: [], draft: null });
export const readCardHomework = (store, user) => user.has_homework ? readHomework(store, user.user_id) : null;

export async function homeworkScreen(store, user, update, now, branded, statements) {
  const en = user.language === "en", tr = (ru, english) => en ? english : ru;
  const itemButton = (label, action, options = {}) => button(label, action, { branded, ...options });
  const back = itemButton(t(user).back, "hw", { icon: "back" });
  const header = screenText("table", "<b>" + tr("Моё ДЗ", "My homework") + "</b>", branded);
  const screen = (text, rows = []) => ({ text: header + "\n\n" + text, keyboard: { inline_keyboard: [...rows, [back]] } });
  const [_, action = "list", arg, value] = update.action.split(":");
  const state = await readHomework(store, user.user_id);
  const { items } = state;
  const draft = state.draft?.until > now.getTime() && state.draft?.group === user.group_id ? state.draft : null;
  const entry = items.find(item => String(item.id) === arg);
  const persist = nextDraft => statements.push(["INSERT INTO settings(key,value) VALUES(?,?) "
    + "ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value IS NOT excluded.value",
  homeworkKey(user.user_id), JSON.stringify({ items, draft: nextDraft })]);
  const timetable = () => homeworkTimetable(store, user.group_id, now);
  const expired = () => screen(tr("Этот шаг устарел. Открой «Моё ДЗ» и попробуй ещё раз.", "This step has expired. Open My homework and try again."));
  const dateLabel = date => personalDateLabel({ date }, user);
  const buttons = (count, page, prefix) => {
    const last = Math.max(0, Math.ceil(count / pageSize) - 1);
    return [page > 0 && itemButton("‹", prefix + (page - 1), { plain: true }),
      page < last && itemButton("›", prefix + (page + 1), { plain: true })].filter(Boolean);
  };
  const dateChoices = async (key, callback) => (await homeworkDates(await timetable(), key, now)).map((day, i) => [
    itemButton(tr(i === 0 ? "Ближайший" : "Следующий после него", i === 0 ? "Next class" : "One after that")
      + " · " + dateLabel(day.date) + (day.preliminary ? tr(" (по плану)", " (planned)") : ""), callback(day.date), { plain: true }),
  ]);
  const askText = (subject, editing, date) => {
    const first = tr(editing ? "Замени текст ДЗ" : "Запиши ДЗ", editing ? "Replace homework text" : "Write homework")
      + " · " + subject + (date ? " · " + dateLabel(date) : "");
    return { first, view: { text: escapeHtml(first) + "\n\n" + tr("Ответь на это сообщение. Можно добавить ссылку, до 1 000 символов.", "Reply to this message. Links are welcome, up to 1,000 characters."),
      keyboard: { force_reply: true }, editId: null } };
  };
  const detail = async (item, notice = "") => {
    const label = item.done ? tr("Выполнено", "Done") : tr("К сроку", "Due");
    const current = item.group === user.group_id && !item.done && item.date >= dateInTimezone(now, zone)
      ? await store.schedule(item.group, item.date) : null;
    const moved = current && !subjectsOf(current).some(name => subjectKey(name) === item.key);
    return screen([notice, "<b>" + escapeHtml(item.subject) + "</b> · " + label + " " + dateLabel(item.date), escapeHtml(item.text),
      moved && tr("В новом расписании на эту дату предмета нет. Можно выбрать другой срок.", "The updated timetable has no class on this date. You can move the due date.")].filter(Boolean).join("\n\n"), [
      [itemButton(tr(item.done ? "Вернуть в список" : "Выполнено", item.done ? "Reopen" : "Mark done"),
        "hw:" + (item.done ? "reopen:" : "done:") + item.id, { style: "success", icon: "completed" })],
      [itemButton(tr("Изменить текст", "Edit text"), "hw:edit:" + item.id, { icon: "table" }),
        ...(item.group === user.group_id && !item.done ? [itemButton(tr("Перенести", "Move"), "hw:move:" + item.id, { plain: true })] : [])],
      [itemButton(tr("Удалить", "Delete"), "hw:remove:" + item.id, { style: "danger", plain: true })],
    ]);
  };

  if (action === "list" || action === "day") {
    const all = items.filter(item => action === "list" || (item.date === arg && item.group === user.group_id))
      .sort((a, b) => Number(a.done) - Number(b.done) || a.date.localeCompare(b.date));
    const page = action === "day" ? 0 : Math.min(Number(arg ?? 0), Math.max(0, Math.ceil(all.length / pageSize) - 1));
    const shown = action === "day" ? all.slice(0, pageSize) : all.slice(page * pageSize, (page + 1) * pageSize);
    const rows = shown.map(item => [itemButton((item.done ? "✓ " : "") + dateLabel(item.date) + " · " + short(item.subject, 45), "hw:show:" + item.id, { plain: true })]);
    if (action === "list" && all.length > pageSize) rows.push(buttons(all.length, page, "hw:list:"));
    if (user.group_id) rows.push([itemButton(tr("Записать ДЗ", "Add homework"), "hw:pick:0", { style: "success", icon: "table" })]);
    if (action === "list" && state.draft) rows.push([itemButton(tr("Отменить черновик", "Discard draft"),
      "hw:cancel:" + state.draft.promptUpdate, { plain: true })]);
    rows.push([itemButton(t(user).main, "menu")]);
    return { text: header + "\n\n" + (all.length ? tr("Выбери задание.", "Choose an assignment.") : tr("Здесь пока пусто.", "No assignments here yet."))
      + (action === "day" && all.length > pageSize ? "\n" + tr("Остальные задания доступны в общем списке.", "More assignments are in the full list.") : ""),
    keyboard: { inline_keyboard: action === "day" ? [...rows, [back]] : rows } };
  }
  if (action === "cancel") {
    if (!state.draft || String(state.draft.promptUpdate) !== arg) return expired();
    persist(null);
    return screen(tr("Черновик отменён.", "Draft discarded."));
  }
  if (action === "pick" || action === "subject") {
    if (!user.group_id) return expired();
    if (items.length >= limit) return screen(tr("У тебя уже 100 заданий. Удали одно старое, чтобы добавить новое.", "You have 100 assignments. Delete an old one before adding another."));
    const subjects = listSubjects(await timetable());
    if (action === "pick") {
      if (!subjects.length) return screen(tr("Пока нет списка предметов для твоей группы.", "There are no subjects for your group yet."));
      const page = Math.min(Number(arg), Math.ceil(subjects.length / pageSize) - 1);
      const rows = subjects.slice(page * pageSize, (page + 1) * pageSize)
        .map(([key, name]) => [itemButton(short(name, 58), "hw:subject:" + key, { plain: true })]);
      if (subjects.length > pageSize) rows.push(buttons(subjects.length, page, "hw:pick:"));
      return screen(tr("По какому предмету ДЗ?", "Which subject?"), rows);
    }
    const subject = subjects.find(([key]) => key === arg)?.[1];
    if (!subject) return expired();
    const prompt = askText(subject);
    persist({ group: user.group_id, key: arg, subject, prompt: prompt.first, promptUpdate: update.update_id, until: now.getTime() + 86_400_000 });
    return prompt.view;
  }
  if (action === "edit") {
    if (!entry || !user.group_id) return expired();
    const prompt = askText(entry.subject, true, entry.date);
    persist({ group: user.group_id, edit: entry.id, subject: entry.subject, date: entry.date, prompt: prompt.first,
      promptUpdate: update.update_id, until: now.getTime() + 86_400_000 });
    return prompt.view;
  }
  if (action === "text") {
    if (!draft || draft.prompt !== update.homeworkPrompt) return expired();
    const prefix = user.user_id + ":reply:" + draft.promptUpdate + ":0:";
    const prompt = await store.first("SELECT 1 FROM operations WHERE id>=? AND id<? AND method='sendMessage' AND +status='succeeded' "
      + "AND json_extract(result,'$.message_id')=? LIMIT 1", prefix, prefix.slice(0, -1) + ";", update.homeworkPromptId);
    if (!prompt) return expired();
    const content = update.homeworkText.trim();
    if (!content) return screen(tr("Ответь на первоначальный запрос текстом до 1 000 символов.", "Reply to the original prompt with text up to 1,000 characters."));
    const id = update.update_id;
    persist({ ...draft, id, text: content });
    const rows = draft.edit !== undefined ? [[itemButton(tr("Сохранить", "Save"), "hw:save:" + id, { style: "success", icon: "completed" })]]
      : await dateChoices(draft.key, date => "hw:date:" + id + ":" + date);
    return screen(escapeHtml(content) + "\n\n" + (draft.edit !== undefined ? tr("Сохранить новый текст?", "Save the new text?")
      : rows.length ? tr("К какому уроку?", "Which class is it due for?") : tr("Ближайших уроков пока не видно. Отправь текст ещё раз, когда появится расписание.", "No upcoming classes are listed. Reply again when the timetable is available.")), rows);
  }
  if (action === "date" || action === "save") {
    if (!draft?.text || String(draft.id) !== arg) return expired();
    if (draft.edit !== undefined) {
      const edited = items.find(item => item.id === draft.edit);
      if (!edited || action !== "save" || value !== undefined) return expired();
      edited.text = draft.text;
      persist(null);
      return detail(edited, tr("Сохранено", "Saved"));
    }
    if (items.length >= limit || !value) return expired();
    const dates = homeworkDates(await timetable(), draft.key, now);
    if (!dates.some(day => day.date === value)) return screen(tr("Дата изменилась. Выбери актуальный урок.", "This date has changed. Pick an available class."),
      dates.map(day => [itemButton(dateLabel(day.date), "hw:date:" + arg + ":" + day.date, { plain: true })]));
    if (action === "date") return screen("<b>" + escapeHtml(draft.subject) + "</b> · " + dateLabel(value) + "\n\n" + escapeHtml(draft.text), [
      [itemButton(tr("Сохранить", "Save"), "hw:save:" + arg + ":" + value, { style: "success", icon: "completed" })],
    ]);
    const saved = { id: draft.id, group: draft.group, subject: draft.subject, key: draft.key, date: value, text: draft.text, done: false };
    items.push(saved);
    persist(null);
    return detail(saved, tr("Сохранено", "Saved"));
  }
  if (!entry) return expired();
  if (action === "show") return detail(entry);
  if (action === "done" || action === "reopen") {
    const done = action === "done";
    if (entry.done !== done) { entry.done = done; persist(state.draft); }
    return detail(entry);
  }
  if (action === "remove") return screen(tr("Удалить это задание?", "Delete this assignment?"), [
    [itemButton(tr("Да, удалить", "Yes, delete"), "hw:delete:" + entry.id, { style: "danger", plain: true })],
    [itemButton(tr("Отмена", "Cancel"), "hw:show:" + entry.id, { icon: "back" })],
  ]);
  if (action === "delete") {
    items.splice(items.indexOf(entry), 1);
    persist(state.draft?.edit === entry.id ? null : state.draft);
    return screen(tr("Задание удалено.", "Assignment deleted."));
  }
  if (action === "move" && !entry.done && entry.group === user.group_id) {
    if (!value) return screen(tr("Выбери новый срок.", "Choose a new due date."),
      await dateChoices(entry.key, date => "hw:move:" + entry.id + ":" + date));
    const matches = homeworkDates(await timetable(), entry.key, now);
    if (!matches.some(day => day.date === value)) return expired();
    if (entry.date !== value) { entry.date = value; persist(state.draft); }
    return detail(entry, tr("Срок обновлён", "Due date updated"));
  }
  return expired();
}

export function homeworkOnCard(rendered, schedule, user, state) {
  if (!state?.items.length) return rendered;
  const keys = new Set(subjectsOf(schedule).map(subjectKey));
  const tasks = state.items.filter(item => !item.done && item.group === user.group_id && item.date === schedule.date && keys.has(item.key));
  if (!tasks.length) return rendered;
  const en = user.language === "en";
  const lines = tasks.slice(0, 3).map(item => "<b>" + escapeHtml(short(item.subject, 45)) + "</b> · "
    + escapeHtml(short(item.text.replace(/\s+/gu, " "), 100)));
  const summary = "\n\n<b>" + (en ? "Homework" : "Домашнее задание") + "</b>\n" + lines.join("\n");
  const [first, ...rest] = rendered.parts;
  return { ...rendered, parts: [first.length + summary.length <= 4000 ? first + summary : first, ...rest], keyboard: {
    inline_keyboard: [...rendered.keyboard.inline_keyboard.slice(0, -1),
      [button(en ? "Homework" : "ДЗ к этому дню", "hw:day:" + schedule.date, { icon: "table" })],
      ...rendered.keyboard.inline_keyboard.slice(-1)],
  } };
}
