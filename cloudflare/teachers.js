import { lessonHeading, themeIcon, themedButton } from "../src/chat-theme.js";
import { TEACHERS, escapeHtml } from "../src/teachers.js";
import { dateTitle } from "../src/schedule/format.js";
import { addDays, dateInTimezone, timeInTimezone } from "../src/dates.js";
import { withStateLock } from "./d1-store.js";
import { createHash } from "node:crypto";
import { TelegramClient, isMessageNotModified, isMessageUneditable } from "../src/telegram.js";

// The owner's preview has its own seat and delivery state. It reads the real
// teacher's schedule without claiming that teacher's enrollment or pins.
export const TEACHER_ACCOUNTS = [...TEACHERS, {
  id: "preview-teacher-one", sourceTeacherId: "teacher-one", name: "Примеров А. А.",

}];
function sourceTeacherId(id) { return TEACHER_ACCOUNTS.find(t => t.id === id)?.sourceTeacherId ?? id; }

const commands = new Map([["/start", "next"], ["/today", "today"], ["/tomorrow", "tomorrow"], ["/latest", "next"], ["/previous", "previous"], ["/stop", "pause"]]);
const teacherIcon = (key, branded) => branded ? themeIcon(key, true) + " " : "";
const teacherHeading = (key, title, branded) => teacherIcon(key, branded) + "<b>" + title + "</b>";
const actions = new Set(["today", "tomorrow", "next", "previous", "full", "compact", "pause", "resume"]);
function clientFor(env, logger) { return new TelegramClient({ token: env.BOT_TOKEN, logger, timeoutMs: 8000, abortSignal: AbortSignal.timeout(25000) }); }

export async function collectTeacherUpdate(database, update, config = {}) {
  let bindings; try { bindings = JSON.parse(config.TEACHER_USER_IDS || "{}"); } catch { bindings = {}; }
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) bindings = {};
  const numeric = value => /^[1-9]\d*$/.test(String(value ?? "")) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const ids = Object.values(bindings).map(numeric);
  if (ids.some(id => id === null) || new Set(ids).size !== ids.length) bindings = {};
  const accounts = TEACHER_ACCOUNTS.map(t => ({...t, userId: t.sourceTeacherId ? (config.OWNER_PREVIEW_ENABLED === "true" ? numeric(config.ADMIN_USER_ID) : null) : numeric(bindings[t.id])}));
  const callback = update.callback_query, message = update.message ?? callback?.message;
  const from = callback?.from ?? message?.from;
  if (message?.chat?.type !== "private" || from?.is_bot || !Number.isSafeInteger(from?.id) || from.id <= 0 || message.chat.id !== from.id) return null;
  const route = callback && /^teacher:(today|tomorrow|next|previous|full|compact|pause|resume|list)(?::(\d{4}-\d{2}-\d{2}))?(?::([a-z]+))?$/u.exec(callback.data ?? "");
  const command = String(message.text ?? "").trim().split(/\s/u)[0].split("@")[0].toLowerCase();
  const usernameSeat = !callback && from.id !== numeric(config.ADMIN_USER_ID) && accounts.find(t =>
    t.allowUsernameEnrollment && !t.userId && t.username === from.username?.toLowerCase()
    && (!t.enrollmentUserId || t.enrollmentUserId === from.id));
  const action = callback ? route?.[1] : commands.get(command) ?? (usernameSeat && "next");
  const target = route?.[3];
  if (target && ["pause", "resume", "list"].includes(action)) return null;
  if ((!actions.has(action) && action !== "list") || (target && !TEACHERS.some(teacher => teacher.id === target))) return null;
  if ((target || action === "list") && (config.OWNER_PREVIEW_ENABLED !== "true"
    || numeric(config.ADMIN_USER_ID) !== from.id)) return null;

  // Persisted numeric enrollment survives username changes and absent optional configuration.
  const enrolled = await database.prepare("SELECT * FROM teacher_users WHERE user_id=?").bind(from.id).first();
  if (enrolled && !callback && !commands.has(command)) return null;
  let teacher = enrolled && accounts.find(t => t.id === enrolled.teacher_id);
  let enrolledByUsername = false;
  if (!teacher) {
    const numericSeat = accounts.find(t => t.userId === from.id);
    teacher = numericSeat ?? usernameSeat;
    if (!teacher || callback || (numericSeat && command !== "/start")) return null;
    enrolledByUsername = !numericSeat;
    if (teacher.enrollmentUserId && teacher.enrollmentUserId !== from.id) return null;
    await database.prepare("INSERT OR IGNORE INTO teacher_users(teacher_id,user_id,enrolled_at) VALUES(?,?,?)")
      .bind(teacher.id, from.id, new Date().toISOString()).run();
    const seat = await database.prepare("SELECT * FROM teacher_users WHERE teacher_id=?").bind(teacher.id).first();
    if (seat?.user_id !== from.id) return null;
  }
  if ((target || action === "list") && !teacher.sourceTeacherId) return null;
  if (teacher.sourceTeacherId && (!teacher.userId || teacher.userId !== from.id)) return null;
  if (teacher.userId && teacher.userId !== from.id) return null;
  if (teacher.enrollmentUserId && teacher.enrollmentUserId !== from.id) return null;
  return { update_id: update.update_id, teacherId: teacher.id, action, userId: from.id,
    ...(!callback && (command === "/start" || enrolledByUsername) ? { welcome: true } : {}),
    ...(callback ? { callbackId: String(callback.id).slice(0, 256), messageId: message.message_id, date: route[2] ?? null, ...(target ? { target } : {}) } : {}) };
}

export async function enqueueTeacherUpdate(database, update) {
  await database.prepare("INSERT OR IGNORE INTO teacher_inbox(update_id,teacher_id,payload) VALUES(?,?,?)")
    .bind(update.update_id, update.teacherId, JSON.stringify(update)).run();
}

export function teacherKeyboard(user, date, full = false, target) {
  const branded = user.branded;
  const key = (label, action, icon, style) => themedButton(label, { callback_data: "teacher:" + action + (target ? ":" + target : "") }, icon, { branded, style, plain: true });
  const suffix = date ? ":" + date : "";
  return { inline_keyboard: [
    [key("Сегодня", "today", "today", "success"), key("Завтра", "tomorrow", "tomorrow", "success")],
    [key("Раньше", "previous" + suffix, "back"), key("Ближайший день", "next", "next", "success")],
    [key(full ? "Оставшиеся пары" : "Показать все пары", (full ? "compact" : "full") + suffix, "view", "primary")],
    ...(user.ownerPreview ? [[themedButton("Выбрать преподавателя", { callback_data: "teacher:list" }, "group", { branded, style: "success", plain: true })]] : []),
    user.previewManual
      ? [themedButton("Личное расписание", { callback_data: "personal:menu" }, "menu", { branded, style: "success", plain: true })]
      : [key("Автообновления: " + (user.notifications ? "вкл" : "выкл"), user.notifications ? "pause" : "resume",
        "changes", user.notifications ? "success" : "danger")],
  ] };
}

export function formatTeacherSchedule(schedule, teacher, { now = new Date(), full = false, timezone = "Europe/Minsk", corrected = false, branded = false } = {}) {
  const today = dateInTimezone(now, timezone), time = timeInTimezone(now, timezone);
  const lines = [teacherHeading("schedule", "Расписание · " + escapeHtml(teacher.name), branded), dateTitle(schedule.date)];
  if (teacher.sourceTeacherId) lines.push("<i>Тестовый кабинет</i>");
  if (corrected) lines.push("", teacherHeading("changes", "В расписании есть правки", branded));
  if (schedule.status) lines.push("", escapeHtml(schedule.status));
  const ended = lesson => schedule.date < today || (schedule.date === today && lesson.end <= time);
  const lessons = full ? schedule.lessons : schedule.lessons.filter(lesson => !ended(lesson));
  if (schedule.lessons.length && !lessons.length) {
    lines.push("", "<i>На сегодня все</i>", "Чтобы посмотреть прошедшие, нажмите «Показать все пары»");
  }
  let showedPast = false, showedRemaining = false;
  for (const lesson of lessons) {
    const completed = ended(lesson);
    if (completed && !showedPast) {
      lines.push("", "<b>Прошедшие пары</b>");
      showedPast = true;
    } else if (!completed && showedPast && !showedRemaining) {
      lines.push("", "<b>Оставшиеся пары</b>");
      showedRemaining = true;
    }
    const active = schedule.date === today && lesson.start <= time && lesson.end > time;
    const marker = completed ? (branded ? "  " + themeIcon("completed", true) : "") : active ? " · Сейчас" : "";
    lines.push("", lessonHeading(lesson) + marker, "<b>Группа " + escapeHtml(lesson.group) + "</b>");
  }
  return lines.join("\n");
}

const showTeacherMessage = (client, userId, messageId, text, replyMarkup) => {
  const options = { replyMarkup, customEmojiOnly: true };
  return messageId ? client.editMessage(userId, messageId, text, options)
    : client.sendMessage(userId, text, options);
};

// A pin advances through teaching days. Midnight and missing/empty days must
// never make it fall back to an older card or rotate through non-teaching days.
export function chooseTeacherPin(publications, schedules, pinnedMessageId, today, time, switchTime) {
  const eligible = publications.filter(p => {
    const row = schedules.find(s => s.date === p.date);
    if (!row || p.date < today) return false;
    const schedule = JSON.parse(row.payload);
    return schedule.lessons.some(l => p.date > today || l.end > time);
  });
  const current = publications.find(p => p.message_id === pinnedMessageId);
  const todayCard = eligible.find(p => p.date === today);
  const nextCard = eligible.find(p => p.date > today);
  const desired = time >= switchTime ? nextCard ?? todayCard : todayCard ?? (!pinnedMessageId ? nextCard : undefined);
  if (!desired || (current && desired.date < current.date)) return undefined;
  return desired;
}

export async function storeTeacherResult(database, job, payload) {
  const schedules = payload?.teacherSchedules;
  if (payload?.document?.id !== job.source_id || !Array.isArray(schedules) || schedules.length > TEACHERS.length
    || schedules.some(s => !TEACHERS.some(t => t.id === s?.teacherId))
    || TEACHERS.some(t => {
      const count = schedules.filter(s => s.teacherId === t.id).length;
      return count > 1 || (!t.optionalSourceRow && count === 0);
    })
    || schedules.some(s => s.date !== job.schedule_date || !/^[a-f0-9]{64}$/.test(s.hash ?? "") || typeof s.status !== "string" || s.status.length > 500
      || !Array.isArray(s.lessons) || s.lessons.length > 24 || s.lessons.some(l => !Number.isInteger(l.number) || l.number < 1 || l.number > 24
        || typeof l.group !== "string" || l.group.length > 50 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(l.start) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(l.end) || l.start >= l.end))) return false;
  const statements = schedules.map(s => database.prepare(
    "INSERT INTO teacher_schedules(teacher_id,date,hash,payload,source_created_at) VALUES(?,?,?,?,?) "
    + "ON CONFLICT(teacher_id,date) DO UPDATE SET hash=excluded.hash,payload=excluded.payload,source_created_at=excluded.source_created_at "
    + "WHERE teacher_schedules.source_created_at <= excluded.source_created_at "
    + "AND (teacher_schedules.source_created_at IS NOT excluded.source_created_at "
    + "OR teacher_schedules.hash IS NOT excluded.hash OR teacher_schedules.payload IS NOT excluded.payload)",
  ).bind(s.teacherId, s.date, s.hash, JSON.stringify(s), job.created_at));
  statements.push(database.prepare("INSERT INTO teacher_documents(source_id,fingerprint,source_created_at) VALUES(?,?,?) "
    + "ON CONFLICT(source_id) DO UPDATE SET fingerprint=excluded.fingerprint,source_created_at=excluded.source_created_at "
    + "WHERE teacher_documents.source_created_at<=excluded.source_created_at")
    .bind(job.source_id, job.fingerprint, job.created_at));
  statements.push(database.prepare("UPDATE parse_jobs SET status='complete',completed_at=?,updated_at=?,error=NULL WHERE id=?")
    .bind(new Date().toISOString(), new Date().toISOString(), job.id));
  await database.batch(statements);
  return true;
}

async function rowsFor(database, teacherId, fromDate = "") {
  return (await database.prepare("SELECT * FROM teacher_schedules WHERE teacher_id=? AND date>=? ORDER BY date")
    .bind(sourceTeacherId(teacherId), fromDate).all()).results;
}

export function chooseTeacherDate(rows, action, today, reference) {
  if (action === "today") return rows.find(r => r.date === today);
  if (action === "tomorrow") return rows.find(r => r.date === addDays(today, 1));
  if (["full", "compact"].includes(action)) return rows.find(r => r.date === (reference ?? today));
  if (action === "previous") return rows.filter(r => r.date < (reference ?? today)).at(-1);
  if (action === "next") {
    const upcoming = rows.filter(row => row.date >= today);
    return upcoming.find(row => !row.payload || JSON.parse(row.payload).lessons.length > 0) ?? upcoming[0];
  }
  return rows.find(r => r.date >= today) ?? rows.at(-1);
}

async function commandSchedule(database, teacherId, action, today, reference) {
  if (action === "next") return chooseTeacherDate(await rowsFor(database, teacherId, today), action, today, reference);
  const source = sourceTeacherId(teacherId);
  const base = "SELECT * FROM teacher_schedules WHERE teacher_id=?";
  if (action === "previous") return database.prepare(base + " AND date<? ORDER BY date DESC LIMIT 1").bind(source, reference ?? today).first();
  if (["today", "tomorrow", "full", "compact"].includes(action)) {
    const date = action === "tomorrow" ? addDays(today, 1) : action === "today" ? today : reference ?? today;
    return database.prepare(base + " AND date=?").bind(source, date).first();
  }
  return await database.prepare(base + " AND date>=? ORDER BY date LIMIT 1").bind(source, today).first()
    ?? await database.prepare(base + " ORDER BY date DESC LIMIT 1").bind(source).first();
}

async function drainTeacherInbox({ database, client, teacher, user, config, now }) {
  const rows = (await database.prepare("SELECT * FROM teacher_inbox WHERE teacher_id=? AND status='pending' AND retry_at<=? ORDER BY update_id LIMIT 3").bind(teacher.id, now.getTime()).all()).results;
  for (const row of rows) {
    const action = JSON.parse(row.payload);
    if (action.userId !== user.user_id || action.teacherId !== teacher.id) continue;
    if (action.welcome && client.call) await client.call("setMyCommands", { scope: { type: "chat", chat_id: user.user_id }, commands: [
      { command: "start", description: "Личный кабинет преподавателя" },
      { command: "today", description: "Мое расписание на сегодня" },
      { command: "tomorrow", description: "Мое расписание на завтра" },
      { command: "latest", description: "Ближайшее опубликованное расписание" },
      { command: "previous", description: "Предыдущее расписание" },
      { command: "stop", description: "Приостановить автообновления" },
    ] });
    if (action.action === "pause" || action.action === "resume") {
      user.notifications = action.action === "resume" ? 1 : 0;
      await database.prepare("UPDATE teacher_users SET notifications=? WHERE teacher_id=? AND user_id=?").bind(user.notifications, teacher.id, user.user_id).run();
    }
    const ownerPreview = Boolean(teacher.sourceTeacherId) && user.ownerPreview;
    if ((action.target || action.action === "list") && !ownerPreview) continue;
    const target = ownerPreview && TEACHERS.find(item => item.id === action.target);
    const shownTeacher = target ? { ...target, sourceTeacherId: target.id } : teacher;
    const list = action.action === "list";
    const today = dateInTimezone(now, config.timezone);
    const selected = list ? null : await commandSchedule(database, target?.id ?? teacher.id, action.action, today, action.date);
    const full = action.action === "full" || (action.action !== "compact" && selected?.date < today);
    const formatted = selected && formatTeacherSchedule(JSON.parse(selected.payload), shownTeacher, {
      now, timezone: config.timezone, full, branded: user.branded,
    });
    const text = list ? teacherHeading("group", "Выберите преподавателя", user.branded) : action.welcome
      ? teacherHeading("menu", "Здравствуйте! Это ваш кабинет МГМК", user.branded) + "\n\nВыберите день, чтобы посмотреть уроки\nНовое расписание и правки придут сюда"
      : ["pause", "resume"].includes(action.action)
        ? (formatted || teacherHeading("settings", "Настройки", user.branded)) + (user.notifications
          ? "\n\nБуду присылать новое расписание и правки"
          : "\n\nАвтообновления на паузе\nУроки можно посмотреть кнопками")
        : formatted || teacherHeading("view", action.action === "previous" ? "Предыдущего расписания пока нет" : "Расписания на этот день пока нет", user.branded);
    const replyMarkup = list ? { inline_keyboard: TEACHERS.map(item => [themedButton(item.name,
      { callback_data: "teacher:next:" + item.id }, "group", { branded: user.branded, style: "success", plain: true })]) }
      : teacherKeyboard(user, selected?.date, full, target?.id);
    if (action.callbackId && selected && !target && !["pause", "resume"].includes(action.action)) {
      await database.prepare("INSERT INTO teacher_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(`view:${teacher.id}:${action.messageId}`, JSON.stringify({ date: selected.date, full })).run();
    }
    // Persist intent before a potentially ambiguous send. Edits are safe to retry.
    if (!action.callbackId) await database.prepare("UPDATE teacher_inbox SET status='sending' WHERE update_id=?").bind(row.update_id).run();
    try {
      if (action.callbackId) await client.answerCallbackQuery(action.callbackId);
      await showTeacherMessage(client, user.user_id, action.callbackId ? action.messageId : null, text, replyMarkup);
      await database.prepare("UPDATE teacher_inbox SET status='done' WHERE update_id=?").bind(row.update_id).run();
    } catch (error) {
      if (isMessageNotModified(error) || (action.callbackId && isMessageUneditable(error))) {
        await database.prepare("UPDATE teacher_inbox SET status='done' WHERE update_id=?").bind(row.update_id).run();
      } else if (error.errorCode === 403) {
        await database.prepare("UPDATE teacher_users SET notifications=0 WHERE teacher_id=?").bind(teacher.id).run();
        await database.prepare("UPDATE teacher_inbox SET status='done' WHERE update_id=?").bind(row.update_id).run();
      } else if (error.errorCode === 429 && error.apiRejected) {
        await database.prepare("UPDATE teacher_inbox SET status='pending',retry_at=? WHERE update_id=?")
          .bind(now.getTime() + Math.max(60, Number(error.parameters?.retry_after) || 60) * 1000, row.update_id).run();
        throw error;
      } else throw error;
    }
  }
}

async function publishTeacherDate({ database, client, teacher, user, row, now, config }) {
  await database.prepare("INSERT OR IGNORE INTO teacher_publications(teacher_id,date) VALUES(?,?)").bind(teacher.id, row.date).run();
  const publication = await database.prepare("SELECT * FROM teacher_publications WHERE teacher_id=? AND date=?").bind(teacher.id, row.date).first();
  if (publication.retry_at > now.getTime() || (!publication.message_id && ["sending", "uncertain", "failed"].includes(publication.status))) return;
  const viewRow = publication.message_id && await database.prepare("SELECT value FROM teacher_settings WHERE key=?").bind(`view:${teacher.id}:${publication.message_id}`).first();
  const view = viewRow ? JSON.parse(viewRow.value) : {};
  const selected = view.date && view.date !== row.date
    ? await database.prepare("SELECT payload FROM teacher_schedules WHERE teacher_id=? AND date=?").bind(sourceTeacherId(teacher.id), view.date).first() : null;
  const schedule = JSON.parse(selected?.payload ?? row.payload);
  const text = formatTeacherSchedule(schedule, teacher, { now, timezone: config.timezone, full: view.full, branded: user.branded,
    corrected: !selected && Boolean(publication.hash && publication.hash !== row.hash) });
  const replyMarkup = teacherKeyboard(user, schedule.date, view.full);
  const renderHash = JSON.stringify([text, replyMarkup]);
  // Render text changes only at lesson boundaries or when the source changes.
  const cached = await database.prepare("SELECT value FROM teacher_settings WHERE key=?").bind(`render:${teacher.id}:${row.date}`).first();
  if (publication.message_id && publication.hash === row.hash && cached?.value === renderHash) return;
  let messageId = publication.message_id;
  const correction = publication.hash && publication.hash !== row.hash;
  const revision = publication.revision + (correction ? 1 : 0);
  if (correction) await database.prepare("INSERT INTO teacher_notices(teacher_id,date,revision,hash) VALUES(?,?,?,?) "
    + "ON CONFLICT(teacher_id,date,revision) DO UPDATE SET hash=excluded.hash WHERE teacher_notices.status='pending'")
    .bind(teacher.id, row.date, revision, row.hash).run();
  if (!messageId) await database.prepare("UPDATE teacher_publications SET status='sending' WHERE teacher_id=? AND date=?").bind(teacher.id, row.date).run();
  try {
    if (messageId) {
      try { await showTeacherMessage(client, user.user_id, messageId, text, replyMarkup); }
      catch (error) {
        if (!isMessageNotModified(error)) {
          if (isMessageUneditable(error)) {
            // A deleted message can be replaced safely after an explicit rejection.
            await database.prepare("UPDATE teacher_publications SET message_id=NULL,status='pending' WHERE teacher_id=? AND date=?").bind(teacher.id, row.date).run();
            return;
          }
          throw error;
        }
      }
    } else messageId = (await showTeacherMessage(client, user.user_id, null, text, replyMarkup)).message_id;
    await database.prepare("UPDATE teacher_publications SET message_id=?,hash=?,revision=?,status='sent',retry_at=0 WHERE teacher_id=? AND date=?")
      .bind(messageId, row.hash, revision, teacher.id, row.date).run();
    await database.prepare("INSERT INTO teacher_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(`render:${teacher.id}:${row.date}`, renderHash).run();
  } catch (error) {
    if (error.errorCode === 403) {
      user.notifications = 0;
      await database.prepare("UPDATE teacher_users SET notifications=0 WHERE teacher_id=?").bind(teacher.id).run();
    }
    if (!messageId) {
      const rateLimited = error.errorCode === 429 && error.apiRejected;
      await database.prepare("UPDATE teacher_publications SET status=?,retry_at=? WHERE teacher_id=? AND date=?")
        .bind(rateLimited ? "pending" : error.apiRejected ? "failed" : "uncertain", rateLimited ? now.getTime() + Math.max(60, Number(error.parameters?.retry_after) || 60) * 1000 : 0, teacher.id, row.date).run();
    }
    throw error;
  }
}

async function drainTeacherNotices({ database, client, teacher, user, now }) {
  const rows = (await database.prepare("SELECT n.* FROM teacher_notices n JOIN teacher_publications p ON p.teacher_id=n.teacher_id AND p.date=n.date "
    + "WHERE n.teacher_id=? AND n.status='pending' AND n.retry_at<=? AND p.hash=n.hash AND p.revision=n.revision LIMIT 2")
    .bind(teacher.id, now.getTime()).all()).results;
  for (const row of rows) {
    await database.prepare("UPDATE teacher_notices SET status='sending' WHERE teacher_id=? AND date=? AND revision=?")
      .bind(teacher.id, row.date, row.revision).run();
    try {
      const date = row.date.split("-").reverse().join(".");
      const text = teacherHeading("changes", "На " + date + " есть правки", user.branded) + "\n\nОткройте карточку — там уже новое расписание";
      await showTeacherMessage(client, user.user_id, null, text, teacherKeyboard(user, row.date));
      await database.prepare("UPDATE teacher_notices SET status='sent' WHERE teacher_id=? AND date=? AND revision=?")
        .bind(teacher.id, row.date, row.revision).run();
    } catch (error) {
      const rateLimited = error.errorCode === 429 && error.apiRejected;
      await database.prepare("UPDATE teacher_notices SET status=?,retry_at=? WHERE teacher_id=? AND date=? AND revision=?")
        .bind(rateLimited ? "pending" : error.apiRejected ? "failed" : "uncertain",
          rateLimited ? now.getTime() + Math.max(60, Number(error.parameters?.retry_after) || 60) * 1000 : 0,
          teacher.id, row.date, row.revision).run();
      if (error.errorCode === 403) await database.prepare("UPDATE teacher_users SET notifications=0 WHERE teacher_id=?").bind(teacher.id).run();
      throw error;
    }
  }
}

export async function writeTeacherStatus(database, key, value, now = new Date()) {
  await database.prepare("INSERT INTO teacher_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value "
    + "WHERE COALESCE(json_extract(teacher_settings.value,'$.at'),'')<=? OR json_remove(teacher_settings.value,'$.at') IS NOT json_remove(excluded.value,'$.at')")
    .bind(key, JSON.stringify({ ...value, at: now.toISOString() }), new Date(now.getTime() - 180000).toISOString()).run();
}

async function teacherCheck(env, config, teacher, now, withPayload = false) {
  const user = await env.DB.prepare("SELECT * FROM teacher_users WHERE teacher_id=?").bind(teacher.id).first();
  if (user && teacher.enrollmentUserId && user.user_id !== teacher.enrollmentUserId) return { user: null, inboxDue: null };
  const inbox = await env.DB.prepare("SELECT MIN(retry_at) due FROM teacher_inbox WHERE teacher_id=? AND status='pending'").bind(teacher.id).first();
  if (!withPayload && !user && inbox?.due == null) return { user, inboxDue: null };
  const from = dateInTimezone(now, config.timezone);
  const schedules = withPayload ? await rowsFor(env.DB, teacher.id, from)
    : (await env.DB.prepare("SELECT date,hash FROM teacher_schedules WHERE teacher_id=? AND date>=? ORDER BY date")
      .bind(sourceTeacherId(teacher.id), from).all()).results;
  const signature = createHash("sha256").update(JSON.stringify([user, schedules.map(s => [s.date,s.hash]), config.timezone, config.pinSwitchTime,
    env.CF_VERSION_METADATA?.id, env.TEACHER_BRANDED_MENU, env.PERSONAL_ENABLED, env.OWNER_PREVIEW_ENABLED, env.ADMIN_USER_ID])).digest("hex");
  return { user, inboxDue: inbox?.due ?? null, schedules, signature };
}
async function saveTeacherCheck(env, config, teacher, now, processedSchedules) {
  const state = await teacherCheck(env, config, teacher, now, true);
  const today = dateInTimezone(now, config.timezone);
  const dates = [Date.parse(`${addDays(today,1)}T00:00:00+03:00`), Date.parse(`${today}T${config.pinSwitchTime}:00+03:00`)];
  for (const row of state.schedules) for (const lesson of JSON.parse(row.payload).lessons)
    for (const time of [lesson.start, lesson.end]) dates.push(Date.parse(`${row.date}T${time}:00+03:00`));
  let next = Math.min(...dates.filter(ms => ms > now.getTime()));
  if (processedSchedules && JSON.stringify(processedSchedules.map(s=>[s.date,s.hash])) !== JSON.stringify(state.schedules.map(s=>[s.date,s.hash]))) next = now.getTime();
  if (state.inboxDue !== null) next = Math.min(next, state.inboxDue);
  if (state.user?.notifications && !(teacher.sourceTeacherId && env.PERSONAL_ENABLED === "true")) {
    const rows = state.schedules.filter(s=>s.date>=today).slice(0,3);
    for (const row of rows) {
      const p = await env.DB.prepare("SELECT message_id,status,retry_at FROM teacher_publications WHERE teacher_id=? AND date=?").bind(teacher.id,row.date).first();
      if (!p || (!p.message_id && !["sending","uncertain","failed"].includes(p.status))) next = Math.min(next, p?.retry_at ?? now.getTime());
    }
    const notice = await env.DB.prepare("SELECT MIN(n.retry_at) due FROM teacher_notices n JOIN teacher_publications p ON p.teacher_id=n.teacher_id AND p.date=n.date WHERE n.teacher_id=? AND n.status='pending' AND p.hash=n.hash AND p.revision=n.revision").bind(teacher.id).first();
    if (notice?.due !== null && notice?.due !== undefined) next = Math.min(next, notice.due);
  }
  await env.DB.prepare("INSERT INTO teacher_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE teacher_settings.value IS NOT excluded.value")
    .bind(`maintenance:${teacher.id}`,JSON.stringify({signature:state.signature,next})).run();
}

export async function teacherMaintenance(env, config, logger, teacherId, now = new Date(), suppliedClient = null, interval = null) {
  const teacher = TEACHER_ACCOUNTS.find(t => t.id === teacherId);
  if (!teacher) throw new Error("Unknown teacher lane");
  if (teacher.sourceTeacherId && env.OWNER_PREVIEW_ENABLED !== "true") return { acquired: false };
  // Read-only probe before the write lease. Every minute still detects commands
  // and source revisions; the durable deadline includes starts, ends and pins.
  const probe = await teacherCheck(env, config, teacher, now);
  if (!probe.user && probe.inboxDue === null) return { checked: true, idle: true };
  const cached = await env.DB.prepare("SELECT value FROM teacher_settings WHERE key=?").bind(`maintenance:${teacher.id}`).first();
  if (config.timezone === "Europe/Minsk" && probe.inboxDue !== 0 && (probe.inboxDue === null || probe.inboxDue > now.getTime()) && cached) {
    const saved = JSON.parse(cached.value);
    if (saved.signature === probe.signature && saved.next > now.getTime()) return { checked: true, idle: true };
  }
  const result = await withStateLock(env.DB, async () => {
    const user = await env.DB.prepare("SELECT * FROM teacher_users WHERE teacher_id=?").bind(teacher.id).first();
    if (!user) return;
    if (teacher.enrollmentUserId && teacher.enrollmentUserId !== user.user_id) return;
    if (teacher.sourceTeacherId && String(user.user_id) !== String(env.ADMIN_USER_ID)) throw new Error("Preview account identity mismatch");
    if (teacher.userId && teacher.userId !== user.user_id) throw new Error("Preview account identity mismatch");
    user.ownerPreview = Boolean(teacher.sourceTeacherId);
    user.previewManual = env.PERSONAL_ENABLED === "true" && Boolean(teacher.sourceTeacherId);
    user.branded = env.TEACHER_BRANDED_MENU === "true";
    const client = suppliedClient ?? clientFor(env, logger);
    const context = { database: env.DB, client, teacher, user, config, now };
    await drainTeacherInbox(context);
    if (!user.notifications || user.previewManual) { await saveTeacherCheck(env,config,teacher,now); return; }
    const today = dateInTimezone(now, config.timezone);
    const schedules = await rowsFor(env.DB, teacher.id, today);
    // Bound work per invocation; subsequent ticks publish remaining dates.
    for (const row of schedules.slice(0, 3)) await publishTeacherDate({ ...context, row });
    await drainTeacherNotices(context);
    // An earlier pin cannot veto a candidate dated today or later.
    const publications = (await env.DB.prepare("SELECT date,message_id FROM teacher_publications WHERE teacher_id=? AND date>=? AND message_id IS NOT NULL ORDER BY date")
      .bind(teacher.id, today).all()).results;
    const desired = chooseTeacherPin(publications, schedules, user.pinned_message_id,
      today, timeInTimezone(now, config.timezone), config.pinSwitchTime);
    if (desired && desired.message_id !== user.pinned_message_id) {
      await client.pinMessage(user.user_id, desired.message_id);
      if (user.pinned_message_id) {
        try { await client.unpinOwnMessage(user.user_id, user.pinned_message_id); }
        catch (error) { if (![400, 403].includes(error.errorCode)) throw error; }
      }
      await env.DB.prepare("UPDATE teacher_users SET pinned_message_id=? WHERE teacher_id=? AND user_id=?").bind(desired.message_id, teacher.id, user.user_id).run();
    }
    await saveTeacherCheck(env,config,teacher,now,schedules);
  }, { name: `teacher:${teacherId}`, leaseMs: 60000, interval });
  if (!result.acquired && interval !== null) return { ...result, duplicate: true };
  return result;
}
