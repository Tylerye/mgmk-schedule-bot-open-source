import { createHash } from "node:crypto";
import { renderPersonal, t, subjectChanges, choosePersonalPin, nextRenderAt, nextPersonalPinAt, noticeParts } from "./view.js";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// One Telegram operation per user invocation. Every send has a durable intent
// first. A process dying between intent and receipt leaves it uncertain.
export async function telegramOperation(store, client, user, key, method, body, now = Date.now()) {
  const id = `${user.user_id}:${key}`;
  const old = await store.first("SELECT * FROM operations WHERE id=?", id);
  if (old?.status === "succeeded") return { done: true, result: JSON.parse(old.result) };
  if (old?.status === "uncertain" || (old?.status === "started" && method === "sendMessage")) {
    await store.run("UPDATE operations SET status='uncertain' WHERE id=?", id);
    return { uncertain: true };
  }
  if (old?.status === "failed") return { failed: true, ...(old.result ? JSON.parse(old.result) : {}) };
  const interval = ["editMessageText", "answerCallbackQuery"].includes(method) ? 120 : 1050;
  if (user.last_api_at + interval > now) return { retryAt: user.last_api_at + interval };
  const slot = await store.first("INSERT INTO rate_gate(key,next_at) VALUES('telegram',?) ON CONFLICT(key) DO UPDATE SET next_at=excluded.next_at "
    + "WHERE rate_gate.next_at<=? RETURNING next_at", now + 84, now);
  if (!slot) return { retryAt: Math.max(now + 84, (await store.first("SELECT next_at FROM rate_gate WHERE key='telegram'")).next_at) };
  await store.batch([
    ["INSERT INTO operations(id,user_id,method,status,started_at) VALUES(?,?,?,'started',?) ON CONFLICT(id) DO UPDATE SET status='started',started_at=excluded.started_at", id, user.user_id, method, now],
    ["UPDATE users SET last_api_at=? WHERE user_id=?", now, user.user_id],
  ]);
  try {
    const result = await client.call(method, body);
    const stable = method === "sendMessage" ? { message_id: result?.message_id, content_hash: digest([body.text, body.reply_markup ?? { inline_keyboard: [] }]) } : true;
    if (method === "sendMessage" && !Number.isSafeInteger(stable.message_id)) throw new Error("Missing Telegram receipt");
    await store.run("UPDATE operations SET status='succeeded',result=? WHERE id=?", JSON.stringify(stable), id);
    return { done: true, result: stable };
  } catch (error) {
    if (method === "editMessageText" && /message is not modified/iu.test(error.description ?? "")) {
      await store.run("UPDATE operations SET status='succeeded',result='true' WHERE id=?", id);
      return { done: true, result: true };
    }
    const ambiguous = method === "sendMessage" && !error.apiRejected;
    if (ambiguous) {
      await store.run("UPDATE operations SET status='uncertain' WHERE id=?", id);
      return { uncertain: true };
    }
    if (error.errorCode === 403 && error.apiRejected) {
      await store.batch([["UPDATE users SET blocked=1,next_due=NULL WHERE user_id=?", user.user_id], ["UPDATE operations SET status='retry' WHERE id=?", id]]);
      return { blocked: true };
    }
    if (error.errorCode === 429) {
      const retryAt = now + Math.max(1, Number(error.parameters?.retry_after) || 30) * 1000;
      await store.batch([["UPDATE rate_gate SET next_at=MAX(next_at,?) WHERE key='telegram'", retryAt], ["UPDATE operations SET status='retry' WHERE id=?", id]]);
      const count = await store.setting("429", 0);
      await store.setSetting("429", count + 1);
      return { retryAt };
    }
    const permanent = error.apiRejected && error.errorCode >= 400 && error.errorCode < 500;
    const replaceable = method === 'editMessageText' && /message to edit not found|message can't be edited|message can not be edited/iu.test(error.description ?? '');
    await store.run("UPDATE operations SET status=?,result=? WHERE id=?", permanent ? "failed" : "retry", JSON.stringify({replaceable}), id);
    return permanent ? { failed: true, replaceable } : { retryAt: now + 5000 };
  }
}

async function finishJob(store, job, status = "done") {
  await store.run("UPDATE jobs SET status=? WHERE id=? AND revision=?", status, job.id, job.revision);
}
async function applyOutcome(store, job, outcome) {
  if (outcome.done) return true;
  if (outcome.retryAt) await store.run("UPDATE jobs SET due=? WHERE id=? AND revision=?", outcome.retryAt, job.id, job.revision);
  else await finishJob(store, job, outcome.uncertain ? "uncertain" : outcome.blocked ? "blocked" : "failed");
  return false;
}

const pinCards = cards => cards.map(c => ({ date: c.date, messageId: c.parts[0]?.id, hasLessons: Boolean(c.schedule?.lessons.length) }));
const currentPin = user => ({ messageId: user.pin_message_id, date: user.pin_date });
async function loadCards(store, user) {
  return (await store.all("SELECT * FROM cards WHERE user_id=? AND group_id=? ORDER BY date", user.user_id, user.group_id))
    .map(c => ({ ...c, parts: JSON.parse(c.parts), schedule: c.schedule_payload ? JSON.parse(c.schedule_payload) : null }));
}
function nextDue(user, schedules, cards, now) {
  const deadlines = schedules.filter(s => cards.some(c => c.date === s.date))
    .map(s => nextRenderAt(s, now, { mode: cards.find(c => c.date === s.date).mode ?? "compact" }));
  if (user.auto_pin) deadlines.push(nextPersonalPinAt(pinCards(cards), currentPin(user), now));
  const values = deadlines.filter(n => n !== null);
  return values.length ? Math.min(...values) : null;
}
function dueStatement(user, value) {
  return ["UPDATE users SET next_due=? WHERE user_id=? AND next_due IS NOT ?", value, user.user_id, value];
}
async function pinStatement(store, user, cards, now) {
  if (!user.auto_pin || user.paused || !choosePersonalPin(pinCards(cards), currentPin(user), now)) return [];
  // A pending check reads current cards; replacing it would only bump revisions.
  const pending = await store.first("SELECT 1 FROM jobs WHERE user_id=? AND kind='pin' AND status='pending' AND epoch=? LIMIT 1", user.user_id, user.epoch);
  return pending ? [] : [store.jobStatement(user, "pin", "", { priority: 1, due: now.getTime() })];
}

export async function deliverUser(store, client, id, { now = new Date(), mode = "normal", ownerId } = {}) {
  return store.lock(id, now.getTime(), async () => {
    const user = await store.user(id);
    if (!user || user.blocked) return;
    const job = await store.first("SELECT * FROM jobs WHERE user_id=? AND status='pending' AND due<=? ORDER BY priority,due,id LIMIT 1", id, now.getTime());
    if (!job) return;
    const payload = JSON.parse(job.payload);
    if (job.epoch !== user.epoch || (user.paused && !payload.manual)) { await finishJob(store, job, "cancelled"); return; }
    if (mode === "stopped" || (mode !== "normal" && !payload.manual && job.priority > 1)) {
      await store.run("UPDATE jobs SET due=? WHERE id=? AND revision=?", now.getTime() + 15 * 60000, job.id, job.revision);
      return;
    }
    const op = (key, method, body) => telegramOperation(store, client, user, key, method, body, now.getTime());
    const sendBody = (text, keyboard, silent = true) => ({ chat_id: id, text, parse_mode: "HTML", disable_web_page_preview: true,
      disable_notification: silent, ...(keyboard ? { reply_markup: keyboard } : {}) });
    if (job.kind === "commands") {
      const w = t(user);
      const commands = [{ command: "start", description: user.language === "en" ? "Personal timetable" : "Личное расписание" }, { command: "today", description: w.today }, { command: "tomorrow", description: w.tomorrow },
        { command: "next", description: w.next }, { command: "stop", description: w.pause },
        ...(String(id) === String(ownerId) ? [{ command: "teacher", description: user.language === "en" ? "Teacher timetable preview" : "Просмотр расписания преподавателя" }] : [])];
      const result = await op(`commands:${job.date}:${job.revision}:${user.language}`, "setMyCommands", { scope: { type: "chat", chat_id: id }, language_code: job.date, commands });
      if (await applyOutcome(store, job, result)) await finishJob(store, job);
    } else if (job.kind === "callback") {
      const result = await op(`callback:${job.date}`, "answerCallbackQuery", { callback_query_id: payload.callbackId });
      if (await applyOutcome(store, job, result)) await finishJob(store, job);
    } else if (job.kind === "reply" || job.kind === "alert" || job.kind === "diagnostics") {
      if (job.kind === "alert" && payload.scheduleHash) {
        const latest = (await store.schedules(user.group_id)).find(s => s.date === payload.date);
        if (latest?.hash !== payload.scheduleHash) { await finishJob(store, job, "superseded"); return; }
      }
      if (job.kind === "alert" && payload.pinMessageId) { await finishJob(store, job, "superseded"); return; }
      const partIndex = payload.partIndex ?? 0;
      let text = payload.texts?.[partIndex] ?? payload.text;
      if (job.kind === "diagnostics") {
        if (String(id) !== String(ownerId)) { await finishJob(store, job, "cancelled"); return; }
        text = await diagnosticText(store, now);
      }
      const method = payload.editId ? "editMessageText" : "sendMessage";
      const body = { ...sendBody(text, payload.keyboard, job.kind !== "alert" || !user.sound), ...(payload.editId ? { message_id: payload.editId } : {}) };
      const result = await op(`${job.kind}:${job.date}:${job.revision}:${partIndex}:${digest(body)}`, method, body);
      if (result.failed && payload.editId) {
        // The user may have cleared the chat: create one replacement screen
        await store.run("UPDATE jobs SET payload=?,status='pending' WHERE id=? AND revision=?", JSON.stringify({...payload,editId:null}),job.id,job.revision);
        return;
      }
      if (await applyOutcome(store, job, result)) {
        if (payload.texts && partIndex + 1 < payload.texts.length) await store.run("UPDATE jobs SET payload=? WHERE id=? AND revision=?", JSON.stringify({ ...payload, partIndex: partIndex + 1 }), job.id, job.revision);
        else await finishJob(store, job);
      }
    } else if (job.kind === "unpin") {
      const result = await op(`unpin:${user.epoch}:${payload.messageId}`, "unpinChatMessage", { chat_id: id, message_id: payload.messageId });
      if (await applyOutcome(store, job, result)) await finishJob(store, job);
    } else if (job.kind === "pin") {
      if (user.paused || user.auto_pin === false || user.auto_pin === 0) { await finishJob(store, job, "cancelled"); return; }
      const cards = await store.all("SELECT date,parts,mode,schedule_payload FROM cards WHERE user_id=? AND group_id=? ORDER BY date", id, user.group_id);
      const eligible = cards.map(c => ({ date: c.date, messageId: JSON.parse(c.parts)[0]?.id, hasLessons: Boolean(c.schedule_payload && JSON.parse(c.schedule_payload).lessons.length) }));
      const desired = choosePersonalPin(eligible, { messageId: user.pin_message_id, date: user.pin_date }, now);
      if (!desired) { await finishJob(store, job); return; }
      const result = await op(`pin:${user.epoch}:${job.revision}:${desired.messageId}`, "pinChatMessage", { chat_id: id, message_id: desired.messageId, disable_notification: true });
      if (await applyOutcome(store, job, result)) {
        const statements = [["UPDATE users SET pin_message_id=?,pin_date=? WHERE user_id=?", desired.messageId, desired.date, id]];
        if (user.pin_message_id && user.pin_message_id !== desired.messageId) statements.push(store.jobStatement(user, "unpin", String(user.pin_message_id), { priority: 1, due: now.getTime(), payload: { messageId: user.pin_message_id } }));
        // Pin announcements removed: the automatic pin itself is sufficient
        const decoded = cards.map(c => ({ ...c, parts: JSON.parse(c.parts), schedule: c.schedule_payload ? JSON.parse(c.schedule_payload) : null }));
        const next = nextDue({ ...user, pin_message_id: desired.messageId, pin_date: desired.date }, await store.schedules(user.group_id), decoded, now);
        if (user.next_due !== next) statements.push(dueStatement(user, next));
        statements.push(["UPDATE jobs SET status='done' WHERE id=? AND revision=?", job.id, job.revision]);
        await store.batch(statements);
      }
    } else if (job.kind === "card") {
      const schedules = await store.schedules(user.group_id);
      const schedule = schedules.find(s => s.date === job.date);
      if (!schedule) { await finishJob(store, job, "cancelled"); return; }
      const card = await store.card(user, job.date) ?? { parts: [], mode: "compact", schedule: null };
      const rendered = renderPersonal(schedule, user, { mode: card.mode, now });
      const parts = [...card.parts];
      const count = Math.max(parts.length, rendered.parts.length);
      let changed = false;
      for (let index = 0; index < count; index++) {
        const text = rendered.parts[index] ?? t(user).emptyPart;
        const keyboard = index === 0 ? rendered.keyboard : { inline_keyboard: [] };
        const hash = digest([text, keyboard]);
        if (parts[index]?.hash === hash) continue;
        if (changed) {
          // One API operation per lane; persist progress before continuing.
          await store.run("INSERT INTO cards(user_id,group_id,date,parts) VALUES(?,?,?,?) ON CONFLICT(user_id,group_id,date) DO UPDATE SET parts=excluded.parts WHERE cards.parts IS NOT excluded.parts",
            id, user.group_id, job.date, JSON.stringify(parts));
          return;
        }
        const method = parts[index]?.id ? "editMessageText" : "sendMessage";
        const body = { ...sendBody(text, keyboard, !user.sound), ...(parts[index]?.id ? { message_id: parts[index].id } : {}) };
        const key = method === "sendMessage" ? `send-card:${user.group_id}:${job.date}:${index}${parts[index]?.replacementFor ? ":replace:"+parts[index].replacementFor : ""}`
          : `edit-card:${user.epoch}:${job.revision}:${user.group_id}:${job.date}:${index}:${parts[index].id}:${hash}`;
        const result = await op(key, method, body);
        if (result.failed && result.replaceable && parts[index]?.id) {
          parts[index]={id:null,hash:null,replacementFor:parts[index].id};
          await store.run("UPDATE cards SET parts=? WHERE user_id=? AND group_id=? AND date=?", JSON.stringify(parts),id,user.group_id,job.date);
          return;
        }
        if (await applyOutcome(store, job, result)) {
          parts[index] = { id: parts[index]?.id ?? result.result.message_id, hash: method === "sendMessage" ? result.result.content_hash : hash };
          if (parts[index].hash !== hash) {
            // A recovered receipt may contain an older render. Keep its ID and
            // let the next lane edit it before completing schedule metadata.
            await store.run("INSERT INTO cards(user_id,group_id,date,parts) VALUES(?,?,?,?) ON CONFLICT(user_id,group_id,date) DO UPDATE SET parts=excluded.parts WHERE cards.parts IS NOT excluded.parts",
              id, user.group_id, job.date, JSON.stringify(parts));
            return;
          }
          changed = true;
        } else return;
      }
      const changes = subjectChanges(card.schedule, schedule, user.language);
      const statements = [];
      const serialized = JSON.stringify(schedule);
      if (changed || card.schedule_hash !== schedule.hash || card.schedule_payload !== serialized) {
        statements.push(["INSERT INTO cards(user_id,group_id,date,parts,schedule_hash,schedule_payload) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,group_id,date) DO UPDATE SET parts=excluded.parts,schedule_hash=excluded.schedule_hash,schedule_payload=excluded.schedule_payload WHERE cards.parts IS NOT excluded.parts OR cards.schedule_hash IS NOT excluded.schedule_hash OR cards.schedule_payload IS NOT excluded.schedule_payload",
          id, user.group_id, job.date, JSON.stringify(parts), schedule.hash, serialized]);
      }
      if (card.schedule && card.schedule.hash !== schedule.hash && changes.length && user.changes && !user.paused) {
        // An alert is coalesced by date. A restart never replays intermediate
        // versions; the latest text replaces a still-pending alert.
        statements.push(store.jobStatement(user, "alert", `change:${job.date}`, { priority: 1, due: now.getTime(),
          payload: { texts: noticeParts(`${t(user).changed} · ${job.date}`, changes), scheduleHash: schedule.hash, date: job.date } }));
      }
      if (!user.paused && !payload.history) {
        const cards = (await loadCards(store, user)).filter(c => c.date !== job.date);
        cards.push({ ...card, date: job.date, parts, schedule });
        statements.push(...await pinStatement(store, user, cards, now));
        const next = nextDue(user, schedules, cards, now);
        if (user.next_due !== next) statements.push(dueStatement(user, next));
      }
      statements.push(["UPDATE jobs SET status='done' WHERE id=? AND revision=?", job.id, job.revision]);
      await store.batch(statements);
    } else await finishJob(store, job, "cancelled");
  });
}

export async function enqueueDue(store, now = Date.now()) {
  const users = await store.all("SELECT * FROM users WHERE paused=0 AND blocked=0 AND next_due IS NOT NULL AND next_due<=? ORDER BY next_due LIMIT 4", now);
  for (const user of users) {
    await store.lock(user.user_id, now, async () => {
      const fresh = await store.user(user.user_id);
      if (!fresh || fresh.paused || fresh.blocked || fresh.next_due === null || fresh.next_due > now) return;
      const date = new Date(now), schedules = await store.schedules(fresh.group_id), cards = await loadCards(store, fresh);
      const statements = [];
      for (const schedule of schedules) {
        const card = cards.find(c => c.date === schedule.date);
        // New publications are queued by durable fanout, never by a clock tick.
        if (!card) continue;
        const rendered = renderPersonal(schedule, fresh, { mode: card.mode, now: date });
        const count = Math.max(card.parts.length, rendered.parts.length);
        if (!Array.from({ length: count }, (_, i) => card.parts[i]?.hash === digest([rendered.parts[i] ?? t(fresh).emptyPart, i ? { inline_keyboard: [] } : rendered.keyboard])).every(Boolean)) {
          const pending = await store.first("SELECT 1 FROM jobs WHERE id=? AND status='pending' AND epoch=?", `${fresh.user_id}:card:${schedule.date}`, fresh.epoch);
          if (!pending) statements.push(store.jobStatement(fresh, "card", schedule.date, { priority: 3, due: now }));
        }
      }
      statements.push(...await pinStatement(store, fresh, cards, date));
      const next = nextDue(fresh, schedules, cards, date);
      if (fresh.next_due !== next) statements.push(dueStatement(fresh, next));
      await store.batch(statements);
    });
  }
}
export async function diagnosticText(store, now = new Date()) {
  const queue = await store.first("SELECT COUNT(*) count,MIN(due) oldest FROM jobs WHERE status='pending'");
  const uncertain = await store.first("SELECT COUNT(*) count FROM operations WHERE status='uncertain' OR (status='started' AND method='sendMessage')");
  const failed = await store.first("SELECT COUNT(*) count FROM jobs WHERE status='failed'");
  const source = await store.setting("source-error", null);
  const budget = await store.first("SELECT * FROM budgets WHERE day=?", now.toISOString().slice(0, 10));
  return `Personal pilot\nQueue: ${queue.count}; lag: ${queue.oldest ? Math.max(0, Math.round((now.getTime() - queue.oldest) / 1000)) : 0}s\nUncertain: ${uncertain.count}\nFailed: ${failed.count}\n429: ${await store.setting("429", 0)}\nParser: ${source ? `error (last good version retained); groups: ${source.groups?.length ?? "unknown"}; structure: ${source.structuralErrors ?? "unknown"}` : "ok"}\nQuota (measured D1 meta + accounting reserve): ${JSON.stringify(budget)}\nMode: ${await store.setting("budget-mode", "normal")}\nMass launch: disabled`;
}
