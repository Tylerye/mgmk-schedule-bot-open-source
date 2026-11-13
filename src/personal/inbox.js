import { findGroups } from "./catalog.js";
import { t, menu, button, supportKeyboard, settingsKeyboard, groupsKeyboard, initialDates, selectedDate, renderPersonal, informationText, informationKeyboard } from "./view.js";

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

export async function processPersonalInbox(store, row, now = new Date()) {
  const update = JSON.parse(row.payload);
  const job = (user, kind, date, options = {}) => store.jobStatement(user, kind, date, { due: now.getTime(), ...options });
  return store.lock(row.user_id, now.getTime(), async () => {
    const fresh = await store.first("SELECT status FROM inbox WHERE update_id=?", row.update_id);
    if (fresh?.status !== "pending") return;
    await store.run("INSERT OR IGNORE INTO users(user_id) VALUES(?)", row.user_id);
    const user = await store.user(row.user_id);
    const original = { ...user };
    const groups = (await store.groups()).sort((a, b) => Number.parseInt(a.id, 10) - Number.parseInt(b.id, 10) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const jobs = [], replies = [];
    const reply = (text, keyboard = menu(user), editId = update.messageId ?? null) => replies.push({ text, keyboard, editId });
    let action = update.action;
    // Only the latest navigation request should survive rapid taps
    jobs.push(["UPDATE jobs SET status='superseded' WHERE user_id=? AND status='pending' AND kind IN ('reply','callback','commands')", user.user_id]);
    if (action === "start") action = user.group_id ? "menu" : "language";
    if (action === "language") {
      reply("Русский / English", { inline_keyboard: [[button("Русский", "lang:ru"), button("English", "lang:en")]] });
    } else if (action.startsWith("lang:")) {
      user.language = action.split(":")[1];
      if (user.language !== original.language) user.epoch++;
      user.screen = user.group_id ? "menu" : "groups";
      reply(user.group_id ? t(user).menu : t(user).choose, user.group_id ? menu(user) : groupsKeyboard(groups, user));
      if (user.group_id) for (const s of initialDates(await store.schedules(user.group_id), now)) jobs.push(job(user, "card", s.date, { priority: 0, payload: { manual: true } }));
    } else if (action.startsWith("groups:") || action.startsWith("search:")) {
      user.screen = "groups";
      const matches = action.startsWith("search:") ? findGroups(groups, action.slice(7)) : groups;
      reply(t(user).choose, groupsKeyboard(matches, user, action.startsWith("groups:") ? Number(action.split(":")[1]) : 0));
    } else if (action.startsWith("group:")) {
      const group = groups.find(g => g.id === action.slice(6));
      if (!group) reply(t(user).choose, groupsKeyboard(groups, user));
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
        } else if(user.auto_pin) { jobs.push(["UPDATE jobs SET status='superseded' WHERE user_id=? AND kind='unpin' AND status='pending'",user.user_id]); jobs.push(job(user,'pin','',{priority:1})); }
      }
      if (key === "paused") {
        user.epoch++; user.next_due = null;
        if (!user.paused && user.group_id) for (const s of initialDates(await store.schedules(user.group_id), now)) jobs.push(job(user, "card", s.date));
      }
      reply(t(user).settings, settingsKeyboard(user));
    } else if (action === "settings") reply(t(user).settings, settingsKeyboard(user));
    else if (action === "help") reply(t(user).helpText);
    else if (action === "feedback" || action === "privacy") reply(informationText(user, action), informationKeyboard(user));
    else if (action === "support") reply(t(user).supportText, supportKeyboard(user));
    else if (action === "donate") reply(t(user).details, supportKeyboard(user), update.messageId);
    else if (action === "later") reply(t(user).closed, menu(user), update.messageId);
    else if (action === "diagnostics") {
      // Owner-only route is also checked by the Worker. Aggregates, no users.
      jobs.push(job(user, "diagnostics", String(row.update_id), { priority: 0, payload: { manual: true } }));
    } else if (action.startsWith("view:")) {
      const [, date, mode] = action.split(":");
      const card = user.group_id && await store.card(user, date);
      if (card?.parts[0]?.id === update.messageId) {
        jobs.push(["UPDATE cards SET mode=? WHERE user_id=? AND group_id=? AND date=?", mode, user.user_id, user.group_id, date]);
        jobs.push(job(user, "card", date, { priority: 0, payload: { manual: true, history: true } }));
      }
    } else if (["today", "tomorrow", "next", "schedule"].includes(action) || action.startsWith("preview:")) {
      if (!user.group_id) reply(t(user).choose, groupsKeyboard(groups, user));
      else {
        const schedules = await store.schedules(user.group_id);
        const date = action.startsWith("preview:") ? action.split(":")[1] : selectedDate(schedules, action, now);
        if (!schedules.some(s => s.date === date)) reply(t(user).missing);
        else {
          const rendered = renderPersonal(schedules.find(s => s.date === date), user, { now, mode: action.startsWith("preview:") ? action.split(":")[2] : "compact" });
          const keyboard = structuredClone(rendered.keyboard);
          for (const row of keyboard.inline_keyboard) for (const b of row) b.callback_data = b.callback_data.replace('personal:view:', 'personal:preview:');
          rendered.parts.forEach((text, i) => reply(text, i ? {inline_keyboard:[]} : keyboard, i ? null : update.messageId ?? null));
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
      for (const s of initialDates(await store.schedules(user.group_id), now)) jobs.push(job(user, "card", s.date, { priority: 0, payload: { manual: true } }));
    }
    for (const [index, payload] of replies.entries()) jobs.push(job(user, "reply", payload.editId ? "screen" : `${row.update_id}:${index}`, { priority: -2, payload: { ...payload, manual: true } }));
    // Insert after superseding older navigation jobs. Keep the visible reply
    // first; the transient acknowledgement must not delay the screen edit.
    if (update.callbackId && !update.acknowledged) jobs.push(job(user, "callback", String(row.update_id), { priority: -1, payload: { callbackId: update.callbackId, manual: true } }));
    const keys = ["language", "group_id", "epoch", "screen", "sound", "changes", "pin", "paused", "blocked", "support_seen", "pin_date", "next_due"];
    const changed = keys.filter(key => user[key] !== original[key]);
    await store.batch([...(changed.length ? [[`UPDATE users SET ${changed.map(k => `${k}=?`).join(",")} WHERE user_id=?`, ...changed.map(k => user[k]), user.user_id]] : []), ...jobs,
      ["UPDATE inbox SET status='done',payload='{}' WHERE update_id=?", row.update_id]]);
  });
}
