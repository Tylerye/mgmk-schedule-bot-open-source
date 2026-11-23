import { weekPage, weekRange } from "./week.js";
import { publishedDayButtons } from "./timetable-table.js";
import { releasePage } from "./releases.js";
import { findGroups } from "./catalog.js";
import { screenHash, isTimetableMessage, richScreen } from './screen-state.js';
import { hasLessonSummary, lessonDetailsChanges } from "./lesson-summary.js";
import { discardHomeworkDraft, homeworkOnCard, homeworkScreen, readCardHomework } from "./homework.js";
import { t, menu, button, backToMenu, screenText, supportKeyboard, settingsKeyboard, groupsKeyboard, initialDates, selectedDate, renderPersonal, informationText, informationKeyboard, widgetGroup, widgetLabel } from "./view.js";

export { collectPersonalUpdate } from "./update.js";

function titledUpdate(user, branded) {
  return screenText("updates", user.language === "en"
    ? "<b>Thanks for rating the update</b>\n\nSend /start to open the new menu"
    : "<b>Спасибо за оценку обновления</b>\n\nНажмите /start, чтобы открыть новое меню", branded);
}

export async function enqueuePersonalUpdate(store, update, now = Date.now()) {
  const inserted = await store.run("INSERT OR IGNORE INTO inbox(update_id,user_id,payload,received_at) SELECT ?,?,?,? "
    + "WHERE NOT EXISTS(SELECT 1 FROM inbox WHERE update_id=?) "
    + "AND NOT EXISTS(SELECT 1 FROM inbox WHERE status='pending' LIMIT 1 OFFSET 499) "
    + "AND NOT EXISTS(SELECT 1 FROM inbox WHERE user_id=? AND status='pending' LIMIT 1 OFFSET 4) "
    + "AND (SELECT rows FROM security_storage_counts WHERE name='inbox')<100000",
  update.update_id, update.userId, JSON.stringify(update), now, update.update_id, update.userId);
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
    const rating = /^rating:(?:(update-20261123):)?([1-5]|later)$/u.exec(update.action);
    if (rating && !(rating[1] && rating[2] === "later")) {
      const [, campaign, choice] = rating;
      const key = campaign ? "rating-update-20261123-v1" : "rating-20261120-v1";
      const voteKey = key + ":" + row.user_id;
      const receipt = update.messageId != null && await store.setting(voteKey) === null
        && await store.campaignReceipt(row.user_id, key, update.messageId);
      const statements = [];
      if (receipt) {
        const later = choice === "later";
        const en = user.language === "en";
        const low = Number(choice) <= 2;
        const text = campaign
          ? titledUpdate(user, brandedMenu)
          : en
          ? (low ? "💛 Thanks for being honest\n\nTell me what would make the bot better" : choice === "3" ? "🙌 Thanks for rating the bot\n\nI'll keep improving it" : "💛 Thanks for the support\n\nGlad the bot helps")
          : (low ? "💛 Спасибо за честную оценку\n\nЕсли есть идея, напиши мне, что можно улучшить" : choice === "3" ? "🙌 Спасибо за оценку\n\nБуду дальше улучшать бота" : "💛 Спасибо за поддержку\n\nРад, что бот помогает");
        statements.push(["INSERT INTO settings(key,value) VALUES(?,?)", voteKey, JSON.stringify(later ? choice : Number(choice))]);
        statements.push(job(user, "rating-response", String(update.messageId), { priority: -2, payload: {
          manual: true, messageId: update.messageId, remove: later, text,
          keyboard: { inline_keyboard: !campaign && low ? [informationKeyboard(user, brandedMenu).inline_keyboard[0]] : [] },
        } }));
      }
      await store.batch([...statements,
        ["UPDATE inbox SET status='done',payload='{}',completed_at=COALESCE(completed_at,unixepoch()*1000) WHERE update_id=?", row.update_id]]);
      return;
    }
    const original = { ...user };
    const today = selectedDate([], "today", now);
    const upcoming = group => store.upcomingSchedules(group, today);
    const initial = async group => initialDates(await upcoming(group), now);
    let catalog;
    const groups = async () => catalog ??= (await store.groups()).sort((a, b) =>
      Number.parseInt(a.id, 10) - Number.parseInt(b.id, 10) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const jobs = [], replies = [];
    const mainMenu = () => menu(user, widgetEnabled, brandedMenu);
    const reply = (text, keyboard = mainMenu(), editId = update.messageId ?? null) => replies.push({ text, keyboard, editId });
    const titled = (icon, text) => screenText(icon, text, brandedMenu);
    const menuText = () => titled("menu", t(user).menu);
    const groupText = () => titled("group", t(user).choose);
    const missingText = () => titled("view", t(user).missing);
    let initialCards = [];
    let homework;
    const cardHomework = async () => homework === undefined ? (homework = await readCardHomework(store, user)) : homework;
    let repeatedSelection = false;
    let action = update.action;
    if (action.startsWith("table:")) action = "preview:" + action.slice("table:".length) + ":full";
    // Only the latest navigation request should survive rapid taps
    const supersedeNavigation = ["UPDATE jobs SET status='superseded',completed_at=COALESCE(completed_at,unixepoch()*1000),"
      + "payload=CASE WHEN json_extract(payload,'$.homework')=1 THEN '{}' ELSE payload END "
      + "WHERE user_id=? AND status='pending' AND kind IN ('reply','callback','commands')", user.user_id];
    jobs.push(supersedeNavigation);
    if (action === "start") action = user.group_id ? "menu" : "language";
    if ((action === "menu" || update.action === "start") && user.has_homework) jobs.push(discardHomeworkDraft(user.user_id));
    if (action === "hw" || action.startsWith("hw:")) {
      const view = await homeworkScreen(store, user, update, now, brandedMenu, jobs);
      reply(view.text, view.keyboard, view.editId);
    } else if (action === "language") {
      const en = user.language === "en";
      reply(titled("language", en ? "<b>Pick a language</b>" : "<b>На каком языке будем общаться?</b>"), {
        inline_keyboard: [[button(en ? "Русский" : "Русский ✓", "lang:ru", { branded: brandedMenu, style: "primary" }),
          button(en ? "English ✓" : "English", "lang:en", { branded: brandedMenu, style: "primary" })],
          ...(user.group_id ? backToMenu(user, brandedMenu).inline_keyboard : [])],
      });
    } else if (action.startsWith("lang:")) {
      user.language = action.split(":")[1];
      if (user.language !== original.language) user.epoch++;
      user.screen = user.group_id ? "menu" : "groups";
      reply(user.group_id ? menuText() : groupText(), user.group_id ? mainMenu() : groupsKeyboard(await groups(), user, 0, brandedMenu));
      if (user.group_id) initialCards = await initial(user.group_id);
      repeatedSelection = user.language === original.language;
    } else if (action.startsWith("groups:") || action.startsWith("search:")) {
      user.screen = "groups";
      const catalog = await groups();
      const matches = action.startsWith("search:") ? findGroups(catalog, action.slice(7)) : catalog;
      reply(groupText(), groupsKeyboard(matches, user, action.startsWith("groups:") ? Number(action.split(":")[1]) : 0, brandedMenu));
    } else if (action.startsWith("group:")) {
      const group = await store.first("SELECT id FROM catalog WHERE id=?", action.slice(6));
      if (!group) reply(groupText(), groupsKeyboard(await groups(), user, 0, brandedMenu));
      else {
        if (user.group_id !== group.id) { user.group_id = group.id; user.epoch++; user.pin_date = null; }
        user.screen = "menu";
        reply(menuText());
        if (!user.support_seen) { reply(titled("support", t(user).supportText), supportKeyboard(user, brandedMenu)); user.support_seen = 1; }
        initialCards = await initial(user.group_id);
        if (!initialCards.length) reply(missingText());
        repeatedSelection = group.id === original.group_id;
      }
    } else if (action === "pause") { user.paused = 1; user.next_due = null; reply(titled("settings", t(user).settingsText), settingsKeyboard(user, brandedMenu));
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
        if (!user.paused && user.group_id) for (const s of await initial(user.group_id)) jobs.push(job(user, "card", s.date, { priority: 0, payload: { manual: true } }));
      }
      reply(titled("settings", t(user).settingsText), settingsKeyboard(user, brandedMenu));
    } else if (action === "settings") reply(titled("settings", t(user).settingsText), settingsKeyboard(user, brandedMenu));
    else if (action === "help") reply(titled("help", t(user).helpText), backToMenu(user, brandedMenu));
    else if (action === "feedback" || action === "privacy") reply(titled(action, informationText(user, action)), informationKeyboard(user, brandedMenu));
    else if (action.startsWith("updates:")) {
      const page = releasePage(user, action.slice("updates:".length), brandedMenu);
      reply(page.text, page.keyboard);
    } else if (action === "support") reply(titled("support", t(user).supportText), supportKeyboard(user, brandedMenu));
    else if (action === "donate") replies.push({
      supportDetails: true, branded: brandedMenu, keyboard: { inline_keyboard: [[button(t(user).back, "support", { branded: brandedMenu })]] }, editId: update.messageId ?? null,
    });
    else if (action === "later") reply(titled("menu", t(user).closed), mainMenu(), update.messageId);
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
          const date = /^\d{4}-\d{2}-\d{2}$/u.test(target) ? target
            : selectedDate(target === "next" ? await upcoming(widgetGroup) : [], target, now);
          replies.push({ widgetDate: date, widgetSchedule: await store.schedule(widgetGroup, date), editId: null });
        }
      }
    } else if (action.startsWith("view:")) {
      const [, date, mode] = action.split(":");
      const card = user.group_id && await store.card(user, date);
      if (card?.parts[0]?.id === update.messageId) {
        if (card.mode !== mode) jobs.push(["UPDATE cards SET mode=? WHERE user_id=? AND group_id=? AND date=?", mode, user.user_id, user.group_id, date]);
        jobs.push(job(user, "card", date, { priority: 0, payload: { manual: true, history: true } }));
      }
    } else if (action === "week" || action.startsWith("week:")) {
      if (!user.group_id) reply(groupText(), groupsKeyboard(await groups(), user, 0, brandedMenu));
      else {
        const range = weekRange(now);
        const week = await store.weekSchedules(user.group_id, range.start, range.end);
        replies.push({ ...weekPage(week, user, range, brandedMenu, action.split(":")[1]), editId: update.messageId ?? null });
      }
    } else if (["today", "tomorrow", "next", "schedule"].includes(action) || action.startsWith("preview:") || action.startsWith("widget-text:")) {
      if (!user.group_id) reply(groupText(), groupsKeyboard(await groups(), user, 0, brandedMenu));
      else {
        const fromWidget = action.startsWith("widget-text:");
        if (fromWidget) action = `preview:${action.slice("widget-text:".length)}:full`;
        const fixedDate = action.startsWith("preview:") ? action.split(":")[1]
          : ["today", "tomorrow"].includes(action) ? selectedDate([], action, now) : null;
        const date = fixedDate ?? selectedDate(await upcoming(user.group_id), action, now);
        const schedules = await store.previewSchedules(user.group_id, date);
        if (!schedules.some(s => s.date === date)) reply(missingText(), mainMenu(), fromWidget ? null : update.messageId);
        else {
          const schedule = schedules.find(s => s.date === date);
          const card = hasLessonSummary(schedule) ? await store.card(user, date) : null;
          const base = renderPersonal(schedule, user, { now, branded: brandedMenu, previewTimer: true, lessonChanges: lessonDetailsChanges(schedule, card),
            mode: action.startsWith("preview:") ? action.split(":")[2] : "compact" });
          const rendered = homeworkOnCard(base, schedule, user, await cardHomework(), brandedMenu);
          const keyboard = structuredClone(rendered.keyboard);
          for (const row of keyboard.inline_keyboard) for (const item of row) {
            const target = item.callback_data.slice("personal:".length).replace(/^view:/u, "preview:");
            Object.assign(item, button(item.text, target, { branded: brandedMenu, style: item.style }));
          }
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
          const days = publishedDayButtons(schedules, date, user, brandedMenu);
          if (days.length) keyboard.inline_keyboard.splice(-1, 0, days);
          reply(rendered.parts[page], keyboard, fromWidget ? null : update.messageId);
          if (rendered !== base) replies.at(-1).homework = true;
        }
      }
    } else reply(menuText());
    // Returning from a block re-enables delivery, but pause remains a choice.
    user.blocked = 0;
    if (update.action.startsWith("lang:")) {
      for (const languageCode of ["", "ru", "en"]) {
        if (await store.setting(`commands-v1:${user.user_id}:${languageCode}`) !== user.language)
          jobs.push(job(user, "commands", languageCode, { priority: 5, payload: { manual: true } }));
      }
    }
    const starting = update.action === "start" && user.group_id;
    if (starting) initialCards = await initial(user.group_id);
    if (initialCards.length) {
      for (const s of initialCards) {
        // An explicit /start can repair a deleted pin or a card overwritten by
        // an older bot version, even when the saved render hash still matches.
        const verifyMessageId = starting && user.pin_date === s.date ? user.pin_message_id : null;
        // Keep the first selected card on the normal path to reconcile pins and deadlines.
        const canSkip = starting || (repeatedSelection && s !== initialCards[0]);
        if (canSkip && !verifyMessageId && !original.blocked && original.next_due > now.getTime()) {
          const card = await store.card(user, s.date);
          if (card?.schedule_hash === s.hash && card.schedule_payload === JSON.stringify(s)) {
            const base = renderPersonal(s, user, { now, branded: brandedMenu, mode: card.mode, lessonChanges: lessonDetailsChanges(s, card) });
            const rendered = homeworkOnCard(base, s, user, await cardHomework(), brandedMenu);
            const count = Math.max(rendered.parts.length, card.parts.length);
            const current = Array.from({ length: count }, (_, index) => card.parts[index]?.id
              && card.parts[index].hash === screenHash(rendered.parts[index] ?? t(user).emptyPart, index ? undefined : rendered.keyboard));
            if (current.every(Boolean) && (starting || !await store.first(
              "SELECT 1 FROM jobs WHERE id=? AND status='pending'", `${user.user_id}:card:${s.date}`
            ))) continue;
          }
        }
        jobs.push(job(user, "card", s.date, { priority: 0, payload: starting ? { manual: true, verifyMessageId } : { manual: true } }));
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
      && await store.setting(`screen-v1:${user.user_id}:${only.editId}`) === screenHash(richScreen(only.richHtml) ?? only.text, only.keyboard);
    if (!unchanged) {
      const screenId = `${user.user_id}:reply:screen`;
      if (replies.some(payload => payload.editId)) {
        // Replace the screen in one write instead of closing and reopening it.
        supersedeNavigation[0] += " AND id<>?";
        supersedeNavigation.push(screenId);
      }
      for (const [index, payload] of replies.entries()) jobs.push(job(user, "reply", payload.editId ? "screen" : `${row.update_id}:${index}`, {
        priority: -2, replacePending: Boolean(payload.editId),
        payload: { ...payload, manual: true, ...(action === "hw" || action.startsWith("hw:") ? { homework: true } : {}) },
      }));
    }
    // Insert after superseding older navigation jobs. Keep the visible reply
    // first; the transient acknowledgement must not delay the screen edit.
    if (update.callbackId && !update.acknowledged) jobs.push(job(user, "callback", String(row.update_id), { priority: -1, payload: { callbackId: update.callbackId, manual: true } }));
    await store.batch([...(changed.length ? [[`UPDATE users SET ${changed.map(k => `${k}=?`).join(",")} WHERE user_id=?`, ...changed.map(k => user[k]), user.user_id]] : []), ...jobs,
      ["UPDATE inbox SET status='done',payload='{}',completed_at=COALESCE(completed_at,unixepoch()*1000) WHERE update_id=?", row.update_id]]);
  });
  return earlier === null ? acquired : { earlier };
}
