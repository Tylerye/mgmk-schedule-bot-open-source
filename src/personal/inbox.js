import { findGroups } from "./catalog.js";
import { screenHash, isTimetableMessage } from './screen-state.js';
import { hasLessonSummary, lessonDetailsChanges } from "./lesson-summary.js";
import { t, menu, button, supportKeyboard, settingsKeyboard, groupsKeyboard, initialDates, selectedDate, renderPersonal, informationText, informationKeyboard, widgetGroup, widgetLabel } from "./view.js";

export { collectPersonalUpdate } from "./update.js";

export async function enqueuePersonalUpdate(store, update, now = Date.now()) {
  if (await store.first("SELECT 1 FROM inbox WHERE update_id=?", update.update_id)) return false;
  const count=await store.first("SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM inbox WHERE status='pending' LIMIT 500)) total,(SELECT COUNT(*) FROM (SELECT 1 FROM inbox WHERE status='pending' AND user_id=? LIMIT 5)) own,(SELECT rows FROM security_storage_counts WHERE name='inbox') records",update.userId);
  if(count.total>=500 || count.own>=5 || count.records>=100000) return false;
  const inserted = await store.run("INSERT OR IGNORE INTO inbox(update_id,user_id,payload,received_at) VALUES(?,?,?,?)", update.update_id, update.userId, JSON.stringify(update), now);
  // D1 includes the storage-counter trigger in changes (normally 2).
  // A duplicate changes no rows; trigger writes must not defer a new tap.
  return Number(inserted.meta?.changes ?? 0) > 0;
}

export async function processPersonalInbox(store, row, now = new Date(), { ownerId, widgetEnabled = false, brandedMenu = false } = {}) {
  const update = JSON.parse(row.payload);
  const job = (user, kind, date, options = {}) => store.jobStatement(user, kind, date, { due: now.getTime(), ...options });
  let earlier = null;
  const acquired = await store.lock(row.user_id, now.getTime(), async () => {
    const first = await store.first("SELECT update_id FROM inbox WHERE user_id=? AND status='pending' AND update_id<=? ORDER BY update_id LIMIT 1",row.user_id,row.update_id);
    if (!first) return;
    if (first.update_id !== row.update_id) { earlier = first.update_id; return; }
    let user = await store.user(row.user_id);
    if (!user) {
      await store.run("INSERT OR IGNORE INTO users(user_id) VALUES(?)", row.user_id);
      user = await store.user(row.user_id);
    }
    if (/^rating:(?:[1-5]|later)$/u.test(update.action)) {
      const choice = update.action.slice(7);
      const key = "rating-20261120-v1";
      const voteKey = key + ":" + row.user_id;
      const receipt = await store.first(
        "SELECT 1 FROM operations WHERE id GLOB ? AND method='sendMessage' AND status='succeeded' AND json_extract(result,'$.message_id')=? LIMIT 1",
        row.user_id + ":alert:" + key + ":*", update.messageId,
      );
      const statements = [];
      if (receipt && await store.setting(voteKey) === null) {
        const later = choice === "later";
        const en = user.language === "en";
        const low = Number(choice) <= 2;
        const text = en
          ? (low ? "💛 Thanks for being honest\n\nTell me what would make the bot better" : choice === "3" ? "🙌 Thanks for rating the bot\n\nI'll keep improving it" : "💛 Thanks for the support\n\nGlad the bot helps")
          : (low ? "💛 Спасибо за честную оценку\n\nЕсли есть идея, напиши мне, что можно улучшить" : choice === "3" ? "🙌 Спасибо за оценку\n\nБуду дальше улучшать бота" : "💛 Спасибо за поддержку\n\nРад, что бот помогает");
        statements.push(["INSERT INTO settings(key,value) VALUES(?,?)", voteKey, JSON.stringify(later ? choice : Number(choice))]);
        statements.push(job(user, "rating-response", String(update.messageId), { priority: -2, payload: {
          manual: true, messageId: update.messageId, remove: later, text,
          keyboard: { inline_keyboard: low ? [informationKeyboard(user).inline_keyboard[0]] : [] },
        } }));
      }
      await store.batch([...statements,
        ["UPDATE inbox SET status='done',payload='{}',completed_at=COALESCE(completed_at,unixepoch()*1000) WHERE update_id=?", row.update_id]]);
      return;
    }
    const original = { ...user };
    let catalog;
    const groups = async () => catalog ??= (await store.groups()).sort((a, b) =>
      Number.parseInt(a.id, 10) - Number.parseInt(b.id, 10) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const jobs = [], replies = [];
    const mainMenu = () => menu(user, widgetEnabled, brandedMenu);
    const reply = (text, keyboard = mainMenu(), editId = update.messageId ?? null) => replies.push({ text, keyboard, editId });
    let action = update.action;
    // Only the latest navigation request should survive rapid taps
    jobs.push(["UPDATE jobs SET status='superseded',completed_at=COALESCE(completed_at,unixepoch()*1000) WHERE user_id=? AND status='pending' AND kind IN ('reply','callback','commands')", user.user_id]);
    if (action === "start") action = user.group_id ? "menu" : "language";
    if (action === "language") {
      reply("Русский / English", { inline_keyboard: [[button("Русский", "lang:ru"), button("English", "lang:en")]] });
    } else if (action.startsWith("lang:")) {
      user.language = action.split(":")[1];
      if (user.language !== original.language) user.epoch++;
      user.screen = user.group_id ? "menu" : "groups";
      reply(user.group_id ? t(user).menu : t(user).choose, user.group_id ? mainMenu() : groupsKeyboard(await groups(), user));
      if (user.group_id) for (const s of initialDates(await store.schedules(user.group_id), now)) jobs.push(job(user, "card", s.date, { priority: 0, payload: { manual: true } }));
    } else if (action.startsWith("groups:") || action.startsWith("search:")) {
      user.screen = "groups";
      const catalog = await groups();
      const matches = action.startsWith("search:") ? findGroups(catalog, action.slice(7)) : catalog;
      reply(t(user).choose, groupsKeyboard(matches, user, action.startsWith("groups:") ? Number(action.split(":")[1]) : 0));
    } else if (action.startsWith("group:")) {
      const group = (await groups()).find(g => g.id === action.slice(6));
      if (!group) reply(t(user).choose, groupsKeyboard(await groups(), user));
      else {
        if (user.group_id !== group.id) { user.group_id = group.id; user.epoch++; user.pin_date = null; }
        user.screen = "menu";
        reply(`${t(user).group}: ${group.displayName}`);
        if (!user.support_seen) { reply(t(user).supportText, supportKeyboard(user)); user.support_seen = 1; }
        const schedules = initialDates(await store.schedules(user.group_id), now);
        if (!schedules.length) reply(t(user).missing);
        for (const s of schedules) jobs.push(job(user, "card", s.date, { priority: 0, payload: { manual: true } }));
      }
    } else if (action === "pause") { user.paused = 1; user.next_due = null; reply(t(user).settingsText, settingsKeyboard(user));
    } else if (action.startsWith("toggle:")) {
      const key = action.split(":")[1]; user[key] = user[key] ? 0 : 1;
      if (key === 'auto_pin') {
        jobs.push(["INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", 'auto-pin:'+user.user_id, JSON.stringify(Boolean(user.auto_pin))]);
        if (!user.auto_pin && user.pin_message_id) {
          jobs.push(job(user,'unpin',String(user.pin_message_id),{priority:0,payload:{messageId:user.pin_message_id,manual:true}}));
          jobs.push(["UPDATE users SET pin_message_id=NULL,pin_date=NULL WHERE user_id=?",user.user_id]);
          user.pin_date=null;
        } else if(user.auto_pin) { jobs.push(["UPDATE jobs SET status='superseded' WHERE user_id=? AND kind='unpin' AND status='pending'",user.user_id]); jobs.push(job(user,'pin','',{priority:1,payload:{manual:true}})); }
      }
      if (key === "paused") {
        user.epoch++; user.next_due = null;
        if (!user.paused && user.group_id) for (const s of initialDates(await store.schedules(user.group_id), now)) jobs.push(job(user, "card", s.date, { priority: 0, payload: { manual: true } }));
      }
      reply(t(user).settings, settingsKeyboard(user));
    } else if (action === "settings") reply(t(user).settings, settingsKeyboard(user));
    else if (action === "help") reply(t(user).helpText);
    else if (action === "feedback" || action === "privacy") reply(informationText(user, action), informationKeyboard(user));
    else if (action === "support") reply(t(user).supportText, supportKeyboard(user));
    else if (action === "donate") replies.push({
      supportDetails: true, keyboard: { inline_keyboard: [[button(t(user).back, "support")]] }, editId: update.messageId ?? null,
    });
    else if (action === "later") reply(t(user).closed, mainMenu(), update.messageId);
    else if (action === "diagnostics") {
      // Owner-only route is also checked by the Worker. Aggregates, no users.
      jobs.push(job(user, "diagnostics", String(row.update_id), { priority: 0, payload: { manual: true } }));
    } else if (action === "widget" || action.startsWith("widget:")) {
      if (user.group_id === widgetGroup) {
        const w = t(user);
        if (!widgetEnabled) {
          reply(user.language === "en"
            ? "Telegram has paused HTML widgets for regular bots. You can still open the text timetable below."
            : "Telegram приостановил HTML-виджеты для обычных ботов. Расписание можно открыть кнопками ниже.");
        } else if (action === "widget") {
          reply(widgetLabel(user), { inline_keyboard: [
            [button(w.today, "widget:today"), button(w.tomorrow, "widget:tomorrow")],
            [button(w.next, "widget:next")], [button(w.back, "menu")],
          ] });
        } else {
          const target = action.slice("widget:".length);
          const schedules = await store.schedules(widgetGroup);
          const date = /^\d{4}-\d{2}-\d{2}$/u.test(target) ? target : selectedDate(schedules, target, now);
          replies.push({ widgetDate: date, widgetSchedule: schedules.find(schedule => schedule.date === date) ?? null, editId: null });
        }
      }
    } else if (action.startsWith("view:")) {
      const [, date, mode] = action.split(":");
      const card = user.group_id && await store.card(user, date);
      if (card?.parts[0]?.id === update.messageId) {
        jobs.push(["UPDATE cards SET mode=? WHERE user_id=? AND group_id=? AND date=?", mode, user.user_id, user.group_id, date]);
        jobs.push(job(user, "card", date, { priority: 0, payload: { manual: true, history: true } }));
      }
    } else if (["today", "tomorrow", "next", "schedule"].includes(action) || action.startsWith("preview:") || action.startsWith("widget-text:")) {
      if (!user.group_id) reply(t(user).choose, groupsKeyboard(await groups(), user));
      else {
        const fromWidget = action.startsWith("widget-text:");
        if (fromWidget) action = `preview:${action.slice("widget-text:".length)}:full`;
        const schedules = await store.schedules(user.group_id);
        const date = action.startsWith("preview:") ? action.split(":")[1] : selectedDate(schedules, action, now);
        if (!schedules.some(s => s.date === date)) reply(t(user).missing, mainMenu(), fromWidget ? null : update.messageId);
        else {
          const schedule = schedules.find(s => s.date === date);
          const card = hasLessonSummary(schedule) ? await store.card(user, date) : null;
          const rendered = renderPersonal(schedule, user, { now, lessonChanges: lessonDetailsChanges(schedule, card),
            mode: action.startsWith("preview:") ? action.split(":")[2] : "compact" });
          const keyboard = structuredClone(rendered.keyboard);
          for (const row of keyboard.inline_keyboard) for (const b of row) b.callback_data = b.callback_data.replace('personal:view:', 'personal:preview:');
          if (widgetEnabled && user.group_id === widgetGroup) keyboard.inline_keyboard.splice(-1, 0, [button(widgetLabel(user), `widget:${date}`)]);
          // A preview is one navigable screen, independent of automatic cards.
          // Paging needs no extra sends, receipts or persisted message IDs.
          const page = Math.max(0, Math.min(Number(action.split(":")[3]) || 0, rendered.parts.length - 1));
          if (rendered.parts.length > 1) {
            const mode = action.startsWith("preview:") ? action.split(":")[2] : "compact";
            const pages = [];
            if (page > 0) pages.push(button("◀️", `preview:${date}:${mode}:${page - 1}`));
            if (page + 1 < rendered.parts.length) pages.push(button("▶️", `preview:${date}:${mode}:${page + 1}`));
            keyboard.inline_keyboard.unshift(pages);
          }
          reply(rendered.parts[page], keyboard, fromWidget ? null : update.messageId);
        }
      }
    } else reply(t(user).menu);
    // Returning from a block re-enables delivery, but pause remains a choice.
    user.blocked = 0;
    if (update.action.startsWith("lang:")) {
      for (const languageCode of ["", "ru", "en"]) {
        if (await store.setting(`commands-v1:${user.user_id}:${languageCode}`) !== user.language)
          jobs.push(job(user, "commands", languageCode, { priority: 5, payload: { manual: true } }));
      }
    }
    if (update.action === "start" && user.group_id) {
      for (const s of initialDates(await store.schedules(user.group_id), now)) {
        // An explicit /start can repair a deleted pin or a card overwritten by
        // an older bot version, even when the saved render hash still matches.
        const verifyMessageId = user.pin_date === s.date ? user.pin_message_id : null;
        if (!verifyMessageId && !original.blocked && original.next_due > now.getTime()) {
          const card = await store.card(user, s.date);
          if (card?.schedule_hash === s.hash && card.schedule_payload === JSON.stringify(s)) {
            const rendered = renderPersonal(s, user, { now, mode: card.mode, lessonChanges: lessonDetailsChanges(s, card) });
            const count = Math.max(rendered.parts.length, card.parts.length);
            const current = Array.from({ length: count }, (_, index) => card.parts[index]?.id
              && card.parts[index].hash === screenHash(rendered.parts[index] ?? t(user).emptyPart, index ? undefined : rendered.keyboard));
            if (current.every(Boolean)) continue;
          }
        }
        jobs.push(job(user, "card", s.date, { priority: 0, payload: { manual: true, verifyMessageId } }));
      }
    }
    const keys = ["language", "group_id", "epoch", "screen", "sound", "changes", "pin", "paused", "blocked", "support_seen", "pin_date", "next_due"];
    const changed = keys.filter(key => user[key] !== original[key]);
    // Only skip a proven standalone screen, using its durable successful receipt.
    // User/card/source state is freshly read under the same lock as delivery.
    // Supersede older navigation even when this latest tap needs no new job.
    const only = replies.length === 1 ? replies[0] : null;
    const unchanged = only && !only.supportDetails && update.acknowledged && !changed.length && jobs.length === 1
      && only.editId && String(user.user_id) !== String(ownerId) && !await isTimetableMessage(store, user, only.editId)
      && await store.setting(`screen-v1:${user.user_id}:${only.editId}`) === screenHash(only.text, only.keyboard);
    if (!unchanged) for (const [index, payload] of replies.entries()) jobs.push(job(user, "reply", payload.editId ? "screen" : `${row.update_id}:${index}`, { priority: -2, payload: { ...payload, manual: true } }));
    // Insert after superseding older navigation jobs. Keep the visible reply
    // first; the transient acknowledgement must not delay the screen edit.
    if (update.callbackId && !update.acknowledged) jobs.push(job(user, "callback", String(row.update_id), { priority: -1, payload: { callbackId: update.callbackId, manual: true } }));
    await store.batch([...(changed.length ? [[`UPDATE users SET ${changed.map(k => `${k}=?`).join(",")} WHERE user_id=?`, ...changed.map(k => user[k]), user.user_id]] : []), ...jobs,
      ["UPDATE inbox SET status='done',payload='{}',completed_at=COALESCE(completed_at,unixepoch()*1000) WHERE update_id=?", row.update_id]]);
  });
  return earlier === null ? acquired : { earlier };
}
