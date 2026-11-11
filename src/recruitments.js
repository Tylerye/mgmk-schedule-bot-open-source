import { authorizedAnnouncer } from "./attention.js";
import { escapeHtml } from "./schedule/format.js";
import { openPrivatePages } from "./private-pages.js";

export const RECRUITMENT_CALLBACK = /^need:(join|leave|list|close):([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const changed = r => (r.meta?.changes ?? 0) > 0;
const isActive = m => ["member", "administrator", "creator"].includes(m?.status) || m?.status === "restricted" && m.is_member === true;
const opened = (r, now) => r?.status === "open" && r.expires_at > now;
const count = (store, id) => store.first("SELECT COUNT(*) AS n FROM recruitment_members WHERE recruitment_id=? AND active=1", id);

export function recruitmentView(r, total, now) {
  const closed = !opened(r, now);
  const full = total >= r.capacity;
  return {
    text: `<b>Нужны ${r.capacity} человек · Записались ${total}/${r.capacity}</b>\n`
      + (closed ? "Набор закрыт" : full ? "Все места заняты — отмена записи снова освободит место" : "Первые нажавшие занимают места — если передумал, нажми «Не смогу»"),
    replyMarkup: { inline_keyboard: closed
      ? [[{ text: "📋 Список", callback_data: `need:list:${r.id}` }]]
      : [[{ text: "🙋 Я пойду", callback_data: `need:join:${r.id}` }, { text: "Не смогу", callback_data: `need:leave:${r.id}` }],
        [{ text: "📋 Список", callback_data: `need:list:${r.id}` }, { text: "Закрыть набор", callback_data: `need:close:${r.id}` }]] },
  };
}

export async function releaseDepartedRecruitments({ store, chatId, now }) {
  // Only open rosters change on departures; a manually closed roster stays final.
  await store.db.batch([
    store.db.prepare("UPDATE recruitments SET version=version+1 WHERE chat_id=? AND status='open' AND expires_at>? AND EXISTS "
      + "(SELECT 1 FROM recruitment_members v JOIN attention_members m ON m.chat_id=recruitments.chat_id AND m.user_id=v.user_id WHERE v.recruitment_id=recruitments.id AND v.active=1 AND m.active=0)").bind(String(chatId), now),
    store.db.prepare("UPDATE recruitment_members SET active=0 WHERE active=1 AND EXISTS(SELECT 1 FROM recruitments r JOIN attention_members m "
      + "ON m.chat_id=r.chat_id AND m.user_id=recruitment_members.user_id WHERE r.id=recruitment_members.recruitment_id AND r.chat_id=? AND r.status='open' AND r.expires_at>? AND m.active=0)").bind(String(chatId), now),
  ]);
}

export async function refreshRecruitment({ store, client, id, now = Date.now(), force = false, drain = true }) {
  const token = crypto.randomUUID();
  if (!changed(await store.run("UPDATE recruitments SET render_owner=?,render_until=? WHERE id=? AND message_id IS NOT NULL AND render_until<=? "
    + (force ? "" : "AND version!=rendered_version AND next_render_at<=?"), token, now + 60_000, id, now, ...(force ? [] : [now])))) return;
  try {
    const r = await store.first("SELECT * FROM recruitments WHERE id=?", id);
    const view = recruitmentView(r, (await count(store, id)).n, now);
    try { await client.editMessage(r.chat_id, r.message_id, view.text, { replyMarkup: view.replyMarkup }); }
    catch (error) { if (!/message is not modified/iu.test(error.description ?? "")) throw error; }
    await store.run("UPDATE recruitments SET rendered_version=?,next_render_at=? WHERE id=? AND render_owner=?", r.version, now + 800, id, token);
  } catch (error) {
    const delay = error.errorCode === 429 ? Math.max(1, error.parameters?.retry_after ?? 1) * 1000 : 5000;
    await store.run("UPDATE recruitments SET next_render_at=? WHERE id=? AND render_owner=?", now + delay, id, token);
    client.logger?.warn("recruitment_edit_failed", { id, code: error.errorCode });
  } finally { await store.run("UPDATE recruitments SET render_owner=NULL,render_until=0 WHERE id=? AND render_owner=?", id, token); }
  if (drain && await store.first("SELECT 1 FROM recruitments WHERE id=? AND version!=rendered_version AND next_render_at<=?", id, now + 800)) {
    await new Promise(resolve => setTimeout(resolve, 800));
    await refreshRecruitment({ store, client, id, now: Math.max(now + 800, Date.now()), drain: false });
  }
}

export async function deliverRecruitment({ store, client, id, now = Date.now() }) {
  const r = await store.first("SELECT * FROM recruitments WHERE id=?", id);
  if (!r || r.status !== "ready" || r.retry_at > now) return;
  if (!changed(await store.run("UPDATE recruitments SET status='sending',updated_at=? WHERE id=? AND status='ready' AND retry_at<=?", now, id, now))) return;
  try {
    const view = recruitmentView({ ...r, status: "open", expires_at: now + 86_400_000 }, 0, now);
    const sent = await client.sendMessage(r.chat_id, view.text, { replyToMessageId: r.target_id, replyMarkup: view.replyMarkup });
    await store.run("UPDATE recruitments SET status='open',message_id=?,opened_at=?,expires_at=?,updated_at=?,rendered_version=version WHERE id=? AND status='sending'",
      sent.message_id, now, now + 86_400_000, now, id);
  } catch (error) {
    const retry = error.errorCode === 429 && Number.isFinite(error.parameters?.retry_after);
    const status = retry ? "ready" : !error.errorCode || error.errorCode >= 500 ? "uncertain" : "failed";
    await store.run("UPDATE recruitments SET status=?,retry_at=?,updated_at=? WHERE id=? AND status='sending'", status,
      retry ? now + Math.max(1, error.parameters.retry_after) * 1000 : 0, now, id);
    client.logger?.warn("recruitment_send_stopped", { id, status, code: error.errorCode });
  }
}

export async function createRecruitment({ store, client, message, chatId, now }) {
  const capacity = message.need_count;
  const targetId = message.reply_to_message?.message_id;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 30 || !Number.isSafeInteger(targetId) || targetId <= 0) {
    await client.sendMessage(chatId, "Ответь на сообщение с задачей командой /need 5\nМожно указать от 1 до 30 человек; /need без числа означает пять"); return;
  }
  const id = crypto.randomUUID();
  const inserted = await store.run("INSERT OR IGNORE INTO recruitments(id,chat_id,target_id,actor_id,capacity,status,updated_at) VALUES (?,?,?,?,?,'ready',?)",
    id, String(chatId), targetId, String(message.from.id), capacity, now);
  if (!changed(inserted)) return;
  await deliverRecruitment({ store, client, id, now });
}

export async function recruitmentReport({ store, id, chatId, page }) {
  const r = await store.first("SELECT * FROM recruitments WHERE id=?", id);
  if (!r || String(r.chat_id) !== String(chatId)) return null;
  const members = await store.all("SELECT name FROM recruitment_members WHERE recruitment_id=? AND active=1 ORDER BY sequence,user_id", r.id);
  const pages = Math.max(1, Math.ceil(members.length / 6));
  page = Math.max(0, Math.min(page, pages - 1));
  const text = [`<b>Записались ${members.length}/${r.capacity}</b>`, ...members.slice(page * 6, page * 6 + 6).map((m, i) => `${page * 6 + i + 1}) ${escapeHtml(m.name)}`),
    ...(!members.length ? ["Пока никто не записался"] : []), `Страница ${page + 1}/${pages}`].join("\n");
  return { text, page, pages };
}

export async function processRecruitment({ store, client, config, callback, chatId, now }) {
  const match = RECRUITMENT_CALLBACK.exec(callback.data);
  if (!match) return;
  const [, action, id] = match;
  const r = await store.first("SELECT * FROM recruitments WHERE id=?", id);
  if (!r || String(r.chat_id) !== String(chatId) || r.message_id !== callback.message.message_id) {
    await client.answerCallbackQuery(callback.id, "Это не кнопка действующего набора"); return;
  }
  if (["list", "close"].includes(action) && !authorizedAnnouncer(callback.from.id, config)) {
    await client.answerCallbackQuery(callback.id, "Доступно только автору бота и куратору"); return;
  }
  if (action === "list") {
    await openPrivatePages({ store, client, callback, kind: "need", entityId: r.id, chatId, renderer: recruitmentReport, now }); return;
  }
  if (!opened(r, now)) { await client.answerCallbackQuery(callback.id, "Набор закрыт"); await refreshRecruitment({ store, client, id, now, force: true }); return; }
  if (action === "close") {
    await store.run("UPDATE recruitments SET status='closed',version=version+1,updated_at=? WHERE id=? AND status='open'", now, id);
    await client.answerCallbackQuery(callback.id, "Набор закрыт");
    await refreshRecruitment({ store, client, id, now, force: true }); return;
  }
  if (action === "join") {
    const member = await client.call("getChatMember", { chat_id: chatId, user_id: Number(callback.from.id) });
    if (!isActive(member) || member.user?.is_bot) { await client.answerCallbackQuery(callback.id, "Записываться могут только участники группы"); return; }
    await store.observe(chatId, { ...callback.from, ...(member.user ?? {}) }, true, now, true);
    await releaseDepartedRecruitments({ store, chatId, now });
    // One SQLite statement reserves the seat and checks capacity; D1 batches are atomic.
    await store.db.batch([
      store.db.prepare("INSERT INTO recruitment_members(recruitment_id,user_id,name,active,sequence,joined_at) "
        + "SELECT r.id,m.user_id,m.name,1,COALESCE((SELECT MAX(sequence) FROM recruitment_members WHERE recruitment_id=r.id),0)+1,? "
        + "FROM recruitments r JOIN attention_members m ON m.chat_id=r.chat_id AND m.user_id=? AND m.active=1 "
        + "WHERE r.id=? AND r.status='open' AND r.expires_at>? AND (SELECT COUNT(*) FROM recruitment_members WHERE recruitment_id=r.id AND active=1)<r.capacity "
        + "AND NOT EXISTS(SELECT 1 FROM recruitment_members WHERE recruitment_id=r.id AND user_id=m.user_id AND active=1) "
        + "ON CONFLICT(recruitment_id,user_id) DO UPDATE SET active=1,name=excluded.name,sequence=excluded.sequence,joined_at=excluded.joined_at")
        .bind(now, String(callback.from.id), id, now),
      store.db.prepare("UPDATE recruitments SET version=version+1 WHERE id=? AND changes()>0").bind(id),
    ]);
    const enrolled = await store.first("SELECT active FROM recruitment_members WHERE recruitment_id=? AND user_id=?", id, String(callback.from.id));
    await client.answerCallbackQuery(callback.id, enrolled?.active ? "🙋 Ты в списке" : "Все места заняты или набор уже закрыт");
  } else {
    await store.db.batch([
      store.db.prepare("UPDATE recruitment_members SET active=0 WHERE recruitment_id=? AND user_id=? AND active=1 "
        + "AND EXISTS(SELECT 1 FROM recruitments r WHERE r.id=recruitment_members.recruitment_id AND r.status='open' AND r.expires_at>?)").bind(id, String(callback.from.id), now),
      store.db.prepare("UPDATE recruitments SET version=version+1 WHERE id=? AND changes()>0").bind(id),
    ]);
    const retained = await store.first("SELECT active FROM recruitment_members WHERE recruitment_id=? AND user_id=?", id, String(callback.from.id));
    await client.answerCallbackQuery(callback.id, retained?.active ? "Набор уже закрыт — запись сохранена" : "Ты не записан — место свободно");
  }
  await new Promise(resolve => setTimeout(resolve, 850));
  await refreshRecruitment({ store, client, id, now: Math.max(now + 850, Date.now()) });
}

export async function recoverRecruitments({ store, client, chatId, now = Date.now() }) {
  await releaseDepartedRecruitments({ store, chatId, now });
  await store.run("UPDATE recruitments SET status='closed',version=version+1,updated_at=? WHERE chat_id=? AND status='open' AND expires_at<=?", now, String(chatId), now);
  const abandoned = await store.run("UPDATE recruitments SET status='uncertain',updated_at=? WHERE chat_id=? AND status='sending' AND updated_at<?", now, String(chatId), now - 180_000);
  if (changed(abandoned)) client.logger?.warn("recruitment_abandoned_send_uncertain");
  const ready = await store.all("SELECT id FROM recruitments WHERE chat_id=? AND status='ready' AND retry_at<=? LIMIT 10", String(chatId), now);
  for (const r of ready) await deliverRecruitment({ store, client, id: r.id, now });
  const dirty = await store.all("SELECT id FROM recruitments WHERE chat_id=? AND message_id IS NOT NULL AND version!=rendered_version AND next_render_at<=? LIMIT 30", String(chatId), now);
  for (const r of dirty) await refreshRecruitment({ store, client, id: r.id, now });
}
