import { sendWithThemeFallback, themeIcon } from "../chat-theme.js";
import { createHash } from "node:crypto";
import { renderPersonal, t, button, subjectChanges, choosePersonalPin, nextRenderAt, nextPersonalPinAt, noticeParts, supportDetailsText, widgetGroup, screenText } from "./view.js";
import { buildScheduleWidget } from "./widget.js";
import { lessonDetailsChanges } from "./lesson-summary.js";
import { escapeHtml } from "../schedule/format.js";
import { manualJobsOnly } from './quota.js';
import { backgroundPolicy } from '../background-policy.js';
import { isTimetableMessage, screenHash as hashScreen, richScreen } from './screen-state.js';
import { affectedHomeworkCards, homeworkOnCard, readCardHomework } from "./homework.js";

const updateSurvey = "rating-update-20261123-v1";
const surveyFormatJob = "format-" + updateSurvey;
const homeworkCampaign = "updates-20261124-v14";
const homeworkThemeJob = "theme-" + homeworkCampaign;
const homeworkIcon = themeIcon("homework", true);
const homeworkEmojiId = /^<tg-emoji emoji-id="(\d+)"/u.exec(homeworkIcon)?.[1];
const brandHomeworkNotice = text => text.replace(/<tg-emoji emoji-id="\d+">📝<\/tg-emoji>|📝/gu, match => match === "📝" ? homeworkIcon : match);

function formatUpdateSurvey(text) {
  // The D1 console stripped newlines from the original campaign payload.
  return text.replace(/<\/b>(?=Переделал|I’ve|Поставьте|Pick)/gu, "</b>\n\n")
    .replace(/(?:на неделю|a weekly view)(?=Нажмите|Send)/gu, "$&\n\n")
    .replace(/(?:новое меню|the new menu)(?=<b>)/gu, "$&\n\n")
    .replace(/<\/b>\n\n(?=Поставьте|Pick)/gu, "</b>\n");
}

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// One Telegram operation per user invocation. Every send has a durable intent
// first. A process dying between intent and receipt leaves it uncertain.
export async function telegramOperation(store, client, user, key, method, body, now = Date.now(), { queuedEdit = false, strictTheme = false, clock } = {}) {
  const id = `${user.user_id}:${key}`;
  const sendsMessage = ["sendMessage", "sendRichMessage", "sendWidget"].includes(method);
  // For queued cards and manual screens the job is already durable intent.
  // An interrupted edit repeats on the same message under the user lock;
  // completion (and card/screen hash) is the receipt. Sends still need a journal.
  const journal = !(queuedEdit && method === 'editMessageText');
  const old = journal ? await store.first("SELECT * FROM operations WHERE id=?", id) : null;
  if (old?.status === "succeeded") return { done: true, result: JSON.parse(old.result) };
  if (old?.status === "uncertain" || (old?.status === "started" && sendsMessage)) {
    if (old.status === "started") await store.run("UPDATE operations SET status='uncertain' WHERE id=?", id);
    return { uncertain: true };
  }
  if (old?.status === "failed") return { failed: true, ...(old.result ? JSON.parse(old.result) : {}) };
  const interval = ["editMessageText", "answerCallbackQuery"].includes(method) ? 120 : 1050;
  const claimSql = "INSERT INTO rate_gate(key,next_at) VALUES('telegram',?) ON CONFLICT(key) DO UPDATE SET next_at=excluded.next_at "
    + "WHERE rate_gate.next_at<=? RETURNING next_at";
  let claimedAt;
  for (let attempt = 0; ; attempt++) {
    claimedAt = clock?.() ?? now;
    if (user.last_api_at + interval > claimedAt) return { retryAt: user.last_api_at + interval };
    if (await store.first(claimSql, claimedAt + 84, claimedAt)) break;
    const retryAt = Math.max(claimedAt + 84, (await store.first("SELECT next_at FROM rate_gate WHERE key='telegram'")).next_at);
    const delay = retryAt - (clock?.() ?? now);
    // A neighboring lane can win the same short slot while D1 is busy.
    // Wait inside this invocation instead of rewriting the job and relaunching it.
    if (!clock || attempt >= 2 || delay > 170) return { retryAt };
    await new Promise(resolve => setTimeout(resolve, Math.max(1, delay)));
  }
  await store.batch([
    ...(journal ? [["INSERT INTO operations(id,user_id,method,status,started_at) VALUES(?,?,?,'started',?) ON CONFLICT(id) DO UPDATE SET status='started',started_at=excluded.started_at", id, user.user_id, method, claimedAt]] : []),
    ["UPDATE users SET last_api_at=? WHERE user_id=?", claimedAt, user.user_id],
  ]);
  try {
    const result = body.text === undefined || strictTheme ? await client.call(method, body)
      : await sendWithThemeFallback((text, markup) => client.call(method, {
        ...body, text, ...(markup ? { reply_markup: markup } : {}),
      }), body.text, body.reply_markup, { customEmojiOnly: true });
    const themedReceipt = strictTheme && {
      custom_emoji: Boolean(result?.entities?.some(entity => entity.type === "custom_emoji" && entity.custom_emoji_id === homeworkEmojiId)),
    };
    const stable = sendsMessage ? { message_id: result?.message_id, ...themedReceipt } : themedReceipt || true;
    if (sendsMessage && !Number.isSafeInteger(stable.message_id)) throw new Error("Missing Telegram receipt");
    if (method === "sendMessage") stable.content_hash = digest([body.text, body.reply_markup ?? { inline_keyboard: [] }]);
    if (journal) await store.run("UPDATE operations SET status='succeeded',result=? WHERE id=?", JSON.stringify(stable), id);
    return { done: true, result: stable };
  } catch (error) {
    if (method === "editMessageText" && /message is not modified/iu.test(error.description ?? "")) {
      if (journal) await store.run("UPDATE operations SET status='succeeded',result='true' WHERE id=?", id);
      return { done: true, result: true };
    }
    const ambiguous = sendsMessage && !error.apiRejected;
    if (ambiguous) {
      await store.run("UPDATE operations SET status='uncertain' WHERE id=?", id);
      return { uncertain: true };
    }
    if (error.errorCode === 403 && error.apiRejected) {
      await store.batch([["UPDATE users SET blocked=1,next_due=NULL WHERE user_id=?", user.user_id], ...(journal ? [["UPDATE operations SET status='retry' WHERE id=?", id]] : [])]);
      return { blocked: true };
    }
    if (error.errorCode === 429) {
      const retryAt = (clock?.() ?? now) + Math.max(1, Number(error.parameters?.retry_after) || 30) * 1000;
      await store.batch([["UPDATE rate_gate SET next_at=MAX(next_at,?) WHERE key='telegram'", retryAt], ...(journal ? [["UPDATE operations SET status='retry' WHERE id=?", id]] : [])]);
      const count = await store.setting("429", 0);
      await store.setSetting("429", count + 1);
      return { retryAt };
    }
    const permanent = error.apiRejected && error.errorCode >= 400 && error.errorCode < 500;
    const replaceable = permanent && method === 'editMessageText' && /message to edit not found/iu.test(error.description ?? '');
    const missingPin = permanent && method === 'pinChatMessage' && /message to pin not found/iu.test(error.description ?? '');
    const failure = { replaceable, ...(missingPin ? { missingPin: true } : {}) };
    if (journal) await store.run("UPDATE operations SET status=?,result=? WHERE id=?", permanent ? "failed" : "retry", JSON.stringify(failure), id);
    return permanent ? { failed: true, ...failure } : { retryAt: now + 5000 };
  }
}

async function finishJob(store, job, status = "done") {
  const complete = ['done','superseded','cancelled'].includes(status) ? ',completed_at=COALESCE(completed_at,unixepoch()*1000)' : '';
  const clearHomework = job.kind === "reply"
    ? ",payload=CASE WHEN json_extract(payload,'$.homework')=1 THEN '{}' ELSE payload END" : "";
  await store.run("UPDATE jobs SET status=?" + complete + clearHomework + " WHERE id=? AND revision=?", status, job.id, job.revision);
}
const doneJob = job => ["UPDATE jobs SET status='done',completed_at=COALESCE(completed_at,unixepoch()*1000) WHERE id=? AND revision=?", job.id, job.revision];
async function applyOutcome(store, job, outcome) {
  if (outcome.done) return true;
  if (outcome.retryAt) await store.run("UPDATE jobs SET due=? WHERE id=? AND revision=?", outcome.retryAt, job.id, job.revision);
  else await finishJob(store, job, outcome.uncertain ? "uncertain" : outcome.blocked ? "blocked" : "failed");
  return false;
}

const pinCards = cards => cards.map(c => ({ date: c.date, messageId: c.parts[0]?.id, hasLessons: Boolean(c.schedule?.lessons.length) }));
const currentPin = user => ({ messageId: user.pin_message_id, date: user.pin_date });
async function loadCards(store, user, excludeDate = "") {
  const rows = await store.all("SELECT c.*,s.payload AS active_payload FROM cards c LEFT JOIN active_versions a ON a.date=c.date "
    + "LEFT JOIN snapshots s ON s.dataset_id=a.dataset_id AND s.group_id=c.group_id "
    + "WHERE c.user_id=? AND c.group_id=? AND c.date<>? ORDER BY c.date", user.user_id, user.group_id, excludeDate);
  const schedules = [];
  const cards = rows.map(({ active_payload, ...card }) => {
    if (active_payload) schedules.push(JSON.parse(active_payload));
    return { ...card, parts: JSON.parse(card.parts), schedule: card.schedule_payload ? JSON.parse(card.schedule_payload) : null };
  });
  return { cards, schedules };
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
async function pinStatement(store, user, cards, now, manual = false) {
  if (!user.auto_pin || user.paused || !choosePersonalPin(pinCards(cards), currentPin(user), now)) return [];
  // A pending check reads current cards; replacing it would only bump revisions.
  const pending = await store.first("SELECT id, json_extract(payload,'$.manual') AS manual FROM jobs WHERE id=? AND status='pending' AND epoch=?",
    `${user.user_id}:pin:`, user.epoch);
  if (pending) {
    if (!manual || pending.manual) return [];
    // Keep the same revision and retry deadline, including a Telegram cooldown.
    return [["UPDATE jobs SET payload=json_set(payload,'$.manual',json('true')) WHERE id=?", pending.id]];
  }
  return [store.jobStatement(user, "pin", "", { priority: 1, due: now.getTime(), ...(manual ? { payload: { manual: true } } : {}) })];
}

export async function deliverUser(store, client, id, { now = new Date(), mode = "normal", ownerId, supportDetails, clock, catchUp = false, interactive = false, widgetEnabled = false, brandedMenu = false } = {}) {
  return store.lock(id, now.getTime(), async token => {
    const user = await store.user(id);
    if (!user || user.blocked) return;
    if (catchUp) {
      if (mode !== "normal" || user.paused || user.next_due === null || user.next_due > now.getTime()) return;
      const due = await enqueueDueLocked(store, user, now, brandedMenu, { client, clock, token });
      if (due.handled) return;
      user.next_due = due.next;
      // Preserve the worker's existing per-user delivery cooldown. The job
      // remains durable if another pass must deliver it after the cooldown.
      if (user.last_api_at > now.getTime() - 1050) return;
    }
    const job = await store.first("SELECT * FROM jobs WHERE user_id=? AND status='pending' AND due<=?" + manualJobsOnly(interactive ? "saving" : mode) + " ORDER BY priority,due,id LIMIT 1", id, now.getTime());
    if (!job) return;
    const payload = JSON.parse(job.payload);
    const homeworkNotice = job.kind === "alert" && payload.manual === true && [homeworkCampaign, homeworkThemeJob].includes(job.date);
    if ((job.epoch !== user.epoch && job.kind !== "rating-response" && !homeworkNotice && !(job.kind === "alert" && ["rating-20261120-v1", updateSurvey, surveyFormatJob].includes(job.date))) || (user.paused && !payload.manual)) { await finishJob(store, job, "cancelled"); return; }
    if (mode === "stopped" || (mode !== "normal" && !payload.manual)) return;
    const op = (key, method, body) => telegramOperation(store, client, user, key, method, body, now.getTime(), { queuedEdit: job.kind === 'card' || job.kind === 'reply' || job.kind === 'rating-response' || job.date === surveyFormatJob, strictTheme: homeworkNotice, clock });
    const sendBody = (text, keyboard, silent = true) => ({ chat_id: id, text, parse_mode: "HTML", disable_web_page_preview: true,
      disable_notification: silent, ...(keyboard ? { reply_markup: keyboard } : {}) });
    if (job.kind === "commands") {
      const w = t(user);
      const commands = [{ command: "start", description: user.language === "en" ? "Personal timetable" : "Личное расписание" }, { command: "today", description: w.today }, { command: "tomorrow", description: w.tomorrow },
        { command: "next", description: w.next }, { command: "stop", description: w.pause },
        ...(String(id) === String(ownerId) ? [{ command: "teacher", description: user.language === "en" ? "Teacher timetable preview" : "Просмотр расписания преподавателя" }] : [])];
      const result = await op(`commands:${job.date}:${job.revision}:${user.language}`, "setMyCommands", { scope: { type: "chat", chat_id: id }, language_code: job.date, commands });
      if (await applyOutcome(store, job, result)) {
        await store.batch([["INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value IS NOT excluded.value", `commands-v1:${id}:${job.date}`, JSON.stringify(user.language)],
          doneJob(job)]);
      }
    } else if (job.kind === "callback") {
      const result = await op(`callback:${job.date}`, "answerCallbackQuery", { callback_query_id: payload.callbackId });
      if (await applyOutcome(store, job, result)) await finishJob(store, job);
    } else if (job.kind === "alert" && job.date === surveyFormatJob) {
      // Voting and message edits share the user lock. Never reopen a voted survey.
      if (await store.setting(`${updateSurvey}:${id}`) !== null) { await finishJob(store, job); return; }
      const original = await store.first("SELECT payload FROM jobs WHERE id=?", `${id}:alert:${updateSurvey}`);
      const receipt = await store.campaignReceipt(id, updateSurvey);
      if (!original || !receipt) { await finishJob(store, job, "cancelled"); return; }
      const survey = JSON.parse(original.payload);
      const accepted = JSON.parse(receipt.result);
      const text = formatUpdateSurvey(survey.text);
      if (accepted.content_hash === hashScreen(text, survey.keyboard)) { await finishJob(store, job); return; }
      const result = await op(surveyFormatJob, "editMessageText", {
        ...sendBody(text, survey.keyboard), message_id: accepted.message_id,
      });
      if (result.replaceable || await applyOutcome(store, job, result)) await finishJob(store, job);
    } else if (homeworkNotice && job.date === homeworkThemeJob) {
      const original = await store.first("SELECT payload FROM jobs WHERE id=? AND status='done'", `${id}:alert:${homeworkCampaign}`);
      const receipt = original && await store.campaignReceipt(id, homeworkCampaign);
      const messageId = receipt && JSON.parse(receipt.result).message_id;
      if (!Number.isSafeInteger(messageId)) { await finishJob(store, job, "cancelled"); return; }
      const notice = JSON.parse(original.payload);
      const text = brandHomeworkNotice(notice.text);
      if (JSON.parse(receipt.result).content_hash === hashScreen(text, notice.keyboard)) { await finishJob(store, job); return; }
      const result = await op(homeworkThemeJob + ":v2", "editMessageText", {
        ...sendBody(text, notice.keyboard), message_id: messageId,
      });
      if (await applyOutcome(store, job, result)) await finishJob(store, job);
    } else if (job.kind === "rating-response") {
      const target = { chat_id: id, message_id: payload.messageId };
      const result = await op("rating-response:" + job.date, payload.remove ? "deleteMessage" : "editMessageText",
        payload.remove ? target : { ...sendBody(payload.text, payload.keyboard), ...target });
      if (await applyOutcome(store, job, result)) await finishJob(store, job);
    } else if (job.kind === "reply" && payload.widgetDate) {
      if (!widgetEnabled || user.group_id !== widgetGroup) { await finishJob(store, job, "cancelled"); return; }
      const schedule = payload.widgetSchedule;
      const w = t(user);
      const textKeyboard = { inline_keyboard: [[button(w.schedule, `widget-text:${payload.widgetDate}`)]] };
      const key = `schedule-widget:${job.date}:${job.revision}`;
      const widget = schedule && buildScheduleWidget(schedule, user);
      // Telegram enforces the compressed limit. A definite rejection uses
      // the text path below, so the Worker does not need to compress the HTML.
      if (widget && new TextEncoder().encode(widget.html).byteLength <= 32768) {
        const result = await op(key, "sendWidget", { chat_id: id, html: widget.html, caption: widget.caption,
          disable_notification: true, reply_markup: textKeyboard });
        if (!result.failed) {
          if (await applyOutcome(store, job, result)) await finishJob(store, job);
          return;
        }
      }
      const unavailable = user.language === "en" ? "HTML widget unavailable. Text timetable:" : "HTML-виджет недоступен. Расписание текстом:";
      const result = await op(key + ":text", "sendMessage", sendBody(widget ? escapeHtml(unavailable + "\n\n" + widget.caption) : w.missing, schedule ? textKeyboard : undefined));
      if (await applyOutcome(store, job, result)) await finishJob(store, job);
    } else if (job.kind === "reply" || job.kind === "alert" || job.kind === "diagnostics") {
      if (job.kind === "alert" && payload.scheduleHash) {
        const latest = await store.first("SELECT s.hash FROM active_versions a JOIN snapshots s ON s.dataset_id=a.dataset_id WHERE a.date=? AND s.group_id=?", payload.date, user.group_id);
        if (latest?.hash !== payload.scheduleHash) { await finishJob(store, job, "superseded"); return; }
      }
      if (job.kind === "alert" && payload.pinMessageId) { await finishJob(store, job, "superseded"); return; }
      const partIndex = payload.partIndex ?? 0;
      let text = payload.texts?.[partIndex] ?? payload.text;
      const details = job.kind === "reply" && payload.supportDetails === true;
      if (details) text = screenText("support", supportDetailsText(user, supportDetails), payload.branded);
      if (job.kind === "diagnostics") {
        if (String(id) !== String(ownerId)) { await finishJob(store, job, "cancelled"); return; }
        text = await diagnosticText(store, now, null, { showUpdateRating: true });
      }
      // Old queued replies also pass here. Never let navigation edit a
      // timetable or the current pin, even if the target changed since enqueue.
      const protectedMessage = job.kind === "reply" && await isTimetableMessage(store, user, payload.editId);
      const editId = protectedMessage ? null : payload.editId;
      const rich = job.kind === "reply" ? richScreen(payload.richHtml) : null;
      const method = editId ? "editMessageText" : rich ? "sendRichMessage" : "sendMessage";
      const content = rich
        ? { chat_id: id, rich_message: rich, reply_markup: payload.keyboard, ...(editId ? {} : { disable_notification: true }) }
        : sendBody(text, payload.keyboard, job.kind !== "alert" || !user.sound);
      const body = { ...content, ...(editId ? { message_id: editId } : {}) };
      // Only standalone screens are cached: automatic cards and the owner's
      // teacher preview can be edited by other delivery paths.
      const screenKey = `screen-v1:${id}:${editId}`;
      const standalone = job.kind === "reply" && Boolean(editId) && String(id) !== String(ownerId);
      const screenHash = hashScreen(rich ?? text, payload.keyboard);
      const unchanged = standalone && await store.setting(screenKey) === screenHash;
      // Keep the original operation key for any send attempted before the format fix.
      const outgoing = job.kind === "alert" && job.date === updateSurvey ? { ...body, text: formatUpdateSurvey(body.text) }
        : homeworkNotice && job.date === homeworkCampaign ? { ...body, text: brandHomeworkNotice(body.text) } : body;
      const result = unchanged ? { done: true } : await op(`${job.kind}:${job.date}:${job.revision}:${partIndex}:${details ? "support-details" : digest(body)}`, method, outgoing);
      if (rich && result.failed && !result.replaceable) {
        // A definitive Rich Message rejection can fall back to text at the
        // same target. An ambiguous send remains uncertain in its journal.
        await store.run("UPDATE jobs SET payload=? WHERE id=? AND revision=?",
          JSON.stringify({ ...payload, richHtml: null }), job.id, job.revision);
        return;
      }
      if (result.failed && editId) {
        // The user may have cleared the chat: create one replacement screen
        await store.run("UPDATE jobs SET payload=?,status='pending' WHERE id=? AND revision=?", JSON.stringify({...payload,editId:null}),job.id,job.revision);
        return;
      }
      if (await applyOutcome(store, job, result)) {
        if (standalone && !unchanged) await store.setSetting(screenKey, screenHash);
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
      const desired = choosePersonalPin(eligible, currentPin(user), now, payload.verify === true);
      if (!desired) { await finishJob(store, job); return; }
      const samePin = desired.messageId === user.pin_message_id && desired.date === user.pin_date;
      if (samePin && payload.verify) {
        let chat;
        try {
          chat = await client.call("getChat", { chat_id: id });
        } catch (error) {
          if (!error.apiRejected || error.errorCode === 429) {
            await applyOutcome(store, job, { retryAt: now.getTime() + Math.max(5, Number(error.parameters?.retry_after) || 0) * 1000 });
          } else await finishJob(store, job, "failed");
          return;
        }
        if (chat?.pinned_message?.message_id === desired.messageId) { await finishJob(store, job); return; }
      }
      const result = await op(`pin:${user.epoch}:${job.revision}:${desired.messageId}`, "pinChatMessage", { chat_id: id, message_id: desired.messageId, disable_notification: true });
      if (result.missingPin) {
        // Only a definite missing-message response permits replacement. Preserve
        // the old ID in the send key so a crash/timeout cannot duplicate it.
        const card = cards.find(c => c.date === desired.date);
        const parts = JSON.parse(card.parts);
        parts[0] = { ...parts[0], id: null, hash: null, replacementFor: desired.messageId };
        await store.batch([
          ["UPDATE cards SET parts=? WHERE user_id=? AND group_id=? AND date=?", JSON.stringify(parts), id, user.group_id, desired.date],
          store.jobStatement(user, "card", desired.date, { priority: 0, due: now.getTime(), payload: payload.manual ? { manual: true } : {} }),
          doneJob(job),
        ]);
        return;
      }
      if (await applyOutcome(store, job, result)) {
        // Pin announcements removed: the automatic pin itself is sufficient
        if (samePin) { await finishJob(store, job); return; }
        const decoded = cards.map(c => ({ ...c, parts: JSON.parse(c.parts), schedule: c.schedule_payload ? JSON.parse(c.schedule_payload) : null }));
        const schedules = await store.schedulesForDates(user.group_id, cards.map(c => c.date));
        const next = nextDue({ ...user, pin_message_id: desired.messageId, pin_date: desired.date }, schedules, decoded, now);
        // Persist the new pin and its deadline in one row update. Leave the
        // indexed deadline out of the statement when it is already current.
        const pin = user.next_due === next
          ? ["UPDATE users SET pin_message_id=?,pin_date=? WHERE user_id=?", desired.messageId, desired.date, id]
          : ["UPDATE users SET pin_message_id=?,pin_date=?,next_due=? WHERE user_id=?", desired.messageId, desired.date, next, id];
        const statements = [pin];
        if (user.pin_message_id && user.pin_message_id !== desired.messageId) statements.push(store.jobStatement(user, "unpin", String(user.pin_message_id), { priority: 1, due: now.getTime(), payload: {
          messageId: user.pin_message_id, ...(payload.manual ? { manual: true } : {}),
        } }));
        statements.push(doneJob(job));
        await store.batch(statements);
      }
    } else if (job.kind === "card") {
      const schedule = await store.schedule(user.group_id, job.date);
      if (!schedule) { await finishJob(store, job, "cancelled"); return; }
      const card = await store.card(user, job.date) ?? { parts: [], mode: "compact", schedule: null };
      const lessonChanges = lessonDetailsChanges(schedule, card);
      const base = renderPersonal(schedule, user, { mode: card.mode, now, branded: brandedMenu, lessonChanges });
      const rendered = homeworkOnCard(base, schedule, user, await readCardHomework(store, user, now, schedule.date), brandedMenu);
      const parts = [...card.parts];
      const count = Math.max(parts.length, rendered.parts.length);
      let changed = false;
      for (let index = 0; index < count; index++) {
        const text = rendered.parts[index] ?? t(user).emptyPart;
        const keyboard = index === 0 ? rendered.keyboard : { inline_keyboard: [] };
        const hash = digest([text, keyboard]);
        const verify = index === 0 && Boolean(payload.verifyMessageId) && parts[index]?.id === payload.verifyMessageId;
        if (parts[index]?.hash === hash && !verify) continue;
        if (payload.existingOnly && !parts[index]?.id) { await finishJob(store, job, "cancelled"); return; }
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
        if (result.failed && result.replaceable && parts[index]?.id && !payload.existingOnly) {
          parts[index]={...parts[index],id:null,hash:null,replacementFor:parts[index].id};
          await store.run("UPDATE cards SET parts=? WHERE user_id=? AND group_id=? AND date=?", JSON.stringify(parts),id,user.group_id,job.date);
          return;
        }
        if (await applyOutcome(store, job, result)) {
          const metadata = index === 0 && lessonChanges ? { lessonChanges } : {};
          parts[index] = { ...metadata, id: parts[index]?.id ?? result.result.message_id, hash: method === "sendMessage" ? result.result.content_hash : hash };
          if (parts[index].hash !== hash) {
            // A recovered receipt may contain an older render. Keep its ID and
            // let the next lane edit it before completing schedule metadata.
            await store.run("INSERT INTO cards(user_id,group_id,date,parts) VALUES(?,?,?,?) ON CONFLICT(user_id,group_id,date) DO UPDATE SET parts=excluded.parts WHERE cards.parts IS NOT excluded.parts",
              id, user.group_id, job.date, JSON.stringify(parts));
            return;
          }
          changed = true;
          if (verify && count > 1) {
            await store.run("UPDATE jobs SET payload=? WHERE id=? AND revision=?", JSON.stringify({ ...payload, verifyMessageId: null }), job.id, job.revision);
          }
        } else return;
      }
      const changes = subjectChanges(card.schedule, schedule, user.language);
      if (parts[0]?.lessonChanges !== lessonChanges) {
        if (lessonChanges) parts[0].lessonChanges = lessonChanges;
        else delete parts[0].lessonChanges;
        changed = true;
      }
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
      if (!user.paused && !payload.history && !payload.existingOnly) {
        const { cards, schedules } = await loadCards(store, user, job.date);
        if (card.schedule_hash !== schedule.hash) {
          for (const date of await affectedHomeworkCards(store, user, now, schedule.date, card.schedule, cards)) {
            if (!await store.first("SELECT 1 FROM jobs WHERE id=? AND status='pending' AND epoch=?", `${id}:card:${date}`, user.epoch))
              statements.push(store.jobStatement(user, "card", date, { priority: 3, due: now.getTime(), payload: { existingOnly: true } }));
          }
        }
        cards.push({ ...card, date: job.date, parts, schedule });
        statements.push(...await pinStatement(store, user, cards, now, payload.manual === true));
        schedules.push(schedule);
        const next = nextDue(user, schedules, cards, now);
        if (user.next_due !== next) statements.push(dueStatement(user, next));
      }
      statements.push(doneJob(job));
      await store.batch(statements);
    } else await finishJob(store, job, "cancelled");
  });
}

// The overdue deadline survives a crash. Invalidate the old Telegram hash
// before editing: a new publication could otherwise render the old text and
// mistake an interrupted edit for an already-correct message.
async function editDueCard(store, user, candidate, next, date, { client, clock, token }) {
  const { card, rendered, hash } = candidate;
  const id = user.user_id, group = user.group_id, day = card.date;
  const original = JSON.stringify(card.parts);
  const pending = JSON.stringify([{ ...card.parts[0], hash: null }]);
  const guard = " AND EXISTS(SELECT 1 FROM locks WHERE user_id=? AND token=?)"
    + " AND EXISTS(SELECT 1 FROM users WHERE user_id=? AND group_id=? AND epoch=? AND paused=0 AND blocked=0 AND next_due=?)"
    + " AND EXISTS(SELECT 1 FROM active_versions a JOIN snapshots s ON a.dataset_id=s.dataset_id WHERE a.date=? AND s.group_id=? AND s.hash=?)";
  const args = [id, token, id, group, user.epoch, user.next_due, day, group, card.schedule_hash];
  const update = "UPDATE cards SET parts=? WHERE user_id=? AND group_id=? AND date=? AND parts=?" + guard;
  const marked = await store.run(update + " AND NOT EXISTS(SELECT 1 FROM jobs WHERE user_id=? AND status='pending')"
    + " AND NOT EXISTS(SELECT 1 FROM inbox WHERE user_id=? AND status='pending')",
    pending, id, group, day, original, ...args, id, id);
  if (!marked.meta.changes) return false;
  const part = card.parts[0];
  const result = await telegramOperation(store, client, user, "", "editMessageText", {
    chat_id: id, message_id: part.id, text: rendered.parts[0], parse_mode: "HTML",
    disable_web_page_preview: true, disable_notification: !user.sound, reply_markup: rendered.keyboard,
  }, date.getTime(), { queuedEdit: true, clock });
  if (result.blocked) return true; // telegramOperation already disabled the recipient.
  const statements = [];
  let expectedParts = pending;
  if (result.done || result.replaceable) {
    const parts = result.done ? [{ ...part, hash }] : [{ ...part, id: null, hash: null, replacementFor: part.id }];
    expectedParts = JSON.stringify(parts);
    statements.push([update, expectedParts, id, group, day, pending, ...args]);
  }
  const cardGuard = " AND EXISTS(SELECT 1 FROM cards WHERE user_id=? AND group_id=? AND date=? AND parts=?)";
  const cardArgs = [id, group, day, expectedParts];
  if (!result.done) {
    // Recheck ownership in the same transaction as the fallback enqueue.
    const job = store.jobStatement(user, 'card', day, { priority: 3, due: result.retryAt ?? date.getTime() });
    job[0] = job[0].replace("VALUES(?,?,?,?,?,?,?,?)", "SELECT * FROM (VALUES(?,?,?,?,?,?,?,?)) WHERE 1=1" + guard + cardGuard)
      + " WHERE jobs.status<>'pending'";
    job.push(...args, ...cardArgs);
    statements.push(job);
    if (result.failed && !result.replaceable)
      statements.push(["UPDATE jobs SET status='failed' WHERE id=? AND revision=(SELECT value FROM job_revision_sequence WHERE id=1)", job[1]]);
  }
  statements.push(["UPDATE users SET next_due=? WHERE user_id=?" + guard + cardGuard, next, id, ...args, ...cardArgs]);
  await store.batch(statements);
  return true;
}

async function enqueueDueLocked(store, fresh, date, brandedMenu, direct) {
  const now = date.getTime(), { schedules, cards } = await loadCards(store, fresh);
  const through = schedules.at(-1)?.date;
  const homework = through ? await readCardHomework(store, fresh, date, through) : null;
  const statements = [];
  let candidate;
  for (const schedule of schedules) {
    const card = cards.find(c => c.date === schedule.date);
    // New publications are queued by durable fanout, never by a clock tick.
    if (!card) continue;
    const base = renderPersonal(schedule, fresh, { mode: card.mode, now: date, branded: brandedMenu, lessonChanges: lessonDetailsChanges(schedule, card) });
    const rendered = homeworkOnCard(base, schedule, fresh, homework, brandedMenu);
    const count = Math.max(card.parts.length, rendered.parts.length);
    if (!Array.from({ length: count }, (_, i) => card.parts[i]?.hash === digest([rendered.parts[i] ?? t(fresh).emptyPart, i ? { inline_keyboard: [] } : rendered.keyboard])).every(Boolean)) {
      const pending = await store.first("SELECT 1 FROM jobs WHERE id=? AND status='pending' AND epoch=?", `${fresh.user_id}:card:${schedule.date}`, fresh.epoch);
      if (!pending) {
        statements.push(store.jobStatement(fresh, "card", schedule.date, { priority: 3, due: now }));
        if (direct && count === 1 && card.parts[0]?.id && rendered.parts.length === 1
          && card.schedule_hash === schedule.hash && card.schedule_payload === JSON.stringify(schedule))
          candidate = { card, rendered, hash: digest([rendered.parts[0], rendered.keyboard]) };
      }
    }
  }
  statements.push(...await pinStatement(store, fresh, cards, date));
  const next = nextDue(fresh, schedules, cards, date);
  if (candidate && statements.length === 1 && fresh.last_api_at <= now - 1050
    && await editDueCard(store, fresh, candidate, next, date, direct)) return { handled: true };
  if (fresh.next_due !== next) statements.push(dueStatement(fresh, next));
  await store.batch(statements);
  return { next };
}

export async function enqueueDue(store, now = Date.now(), userId = null, brandedMenu = false) {
  const users = userId === null
    ? await store.all("SELECT * FROM users WHERE paused=0 AND blocked=0 AND next_due IS NOT NULL AND next_due<=? ORDER BY next_due LIMIT 4", now)
    : await store.all("SELECT * FROM users WHERE user_id=? AND paused=0 AND blocked=0 AND next_due<=?", userId, now);
  for (const user of users) {
    await store.lock(user.user_id, now, async () => {
      const fresh = await store.user(user.user_id);
      if (!fresh || fresh.paused || fresh.blocked || fresh.next_due === null || fresh.next_due > now) return;
      await enqueueDueLocked(store, fresh, new Date(now), brandedMenu);
    });
  }
}
export async function deliveryHealth(store, now = new Date()) {
  const due = await store.first("SELECT COUNT(*) count,MIN(next_due) oldest FROM users WHERE paused=0 AND blocked=0 AND next_due<=?", now.getTime());
  const jobs = await store.first("SELECT COUNT(*) count,MIN(due) oldest FROM jobs WHERE status='pending' AND due<=? AND user_id IN (SELECT user_id FROM users WHERE blocked=0)", now.getTime());
  const lag = value => value == null ? 0 : Math.max(0, Math.floor((now.getTime()-value)/1000));
  const dueLagSeconds = lag(due.oldest), jobLagSeconds = lag(jobs.oldest);
  const late = Math.max(dueLagSeconds, jobLagSeconds) > (backgroundPolicy(now).staleAfterMs / 1000);
  return { dueUsers: due.count, dueLagSeconds, pendingJobs: jobs.count, jobLagSeconds, late };
}
export async function diagnosticText(store, now = new Date(), delivery = null, { showUpdateRating = false } = {}) {
  delivery ??= await deliveryHealth(store, now);
  const queue = await store.first("SELECT COUNT(*) count,MIN(due) oldest FROM jobs WHERE status='pending'");
  const uncertain = await store.first("SELECT COUNT(*) count FROM operations WHERE status='uncertain' OR (status='started' AND method IN ('sendMessage','sendRichMessage','sendWidget'))");
  const failed = await store.first("SELECT COUNT(*) count FROM jobs WHERE status='failed'");
  const source = await store.setting("source-error", null);
  const budget = await store.first("SELECT * FROM budgets WHERE day=?", now.toISOString().slice(0, 10));
  const policy = backgroundPolicy(now);
  const updateRating = showUpdateRating ? await store.first(
    "SELECT COUNT(*) count,ROUND(AVG(value),2) average,SUM(value='1') one,SUM(value='2') two,SUM(value='3') three,SUM(value='4') four,SUM(value='5') five "
    + "FROM settings WHERE key GLOB 'rating-update-20261123-v1:*' AND value IN ('1','2','3','4','5')",
  ) : null;
  const updateRatingText = updateRating ? `\n\n⭐ Оценка обновления · ${updateRating.average ?? "—"} / 5 · голосов ${updateRating.count}\n1 ★ — ${updateRating.one ?? 0} · 2 ★ — ${updateRating.two ?? 0} · 3 ★ — ${updateRating.three ?? 0}\n4 ★ — ${updateRating.four ?? 0} · 5 ★ — ${updateRating.five ?? 0}` : "";
  const mode = budget && store.backgroundPaused(budget) ? 'saving' : 'normal';
  return `Personal timetable\nQueue: ${queue.count}; lag: ${delivery.jobLagSeconds}s\nDue users: ${delivery.dueUsers}; lag: ${delivery.dueLagSeconds}s\nDelivery: ${delivery.late ? 'delayed' : 'on time'}\nBackground: ${policy.night ? 'night (15 min)' : 'day (1 min)'}\nUncertain: ${uncertain.count}\nFailed: ${failed.count}\n429: ${await store.setting("429", 0)}\nParser: ${source ? 'error (last good version retained)' : 'ok'}\nQuota (D1 meta + accounting reserve): ${JSON.stringify(budget)}\nMode: ${mode}${updateRatingText}`;
}
