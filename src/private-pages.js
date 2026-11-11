// Only session identifiers are persisted, never the names or rendered report text.
export const PRIVATE_PAGE_CALLBACK = /^private:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):(\d{1,7})$/;
const changed = result => (result.meta?.changes ?? 0) > 0;
const sessionKey = id => `private-session:${id}`;
const validId = id => Number.isSafeInteger(id) && id >= 0;
async function read(store, id) {
  const raw = await store.setting(sessionKey(id));
  if (!raw) return null;
  try { return { raw, value: JSON.parse(raw) }; } catch { return null; }
}
function markup(id, page, pages) {
  const buttons = [];
  if (page > 0) buttons.push({ text: "⬅️", callback_data: `private:${id}:${page - 1}` });
  buttons.push({ text: `${page + 1}/${pages}`, callback_data: `private:${id}:${page}` });
  if (page + 1 < pages) buttons.push({ text: "➡️", callback_data: `private:${id}:${page + 1}` });
  return { inline_keyboard: [buttons] };
}

async function edit({ store, client, callback, session, renderer, page, now }) {
  const s = session.value;
  if (s.lockedUntil > now) { await client.answerCallbackQuery(callback.id, "Страница обновляется"); return; }
  const locked = JSON.stringify({ ...s, lockedUntil: now + 60_000 });
  if (!changed(await store.run("UPDATE attention_settings SET value=? WHERE key=? AND value=?", locked, sessionKey(s.id), session.raw))) return;
  let status = s.status;
  try {
    const view = await renderer({ store, id: s.entityId, chatId: s.chatId, page, now });
    if (!view) throw new Error("private view source missing");
    try {
      await client.call("editEphemeralMessageText", { chat_id: s.chatId, receiver_user_id: Number(s.ownerId), ephemeral_message_id: s.messageId,
        text: view.text, parse_mode: "HTML", reply_markup: markup(s.id, view.page, view.pages) });
    } catch (error) {
      if (!/message is not modified/iu.test(error.description ?? "")) throw error;
    }
    await client.answerCallbackQuery(callback.id);
  } catch (error) {
    if ([400, 404].includes(error.errorCode) && /not found|expired|invalid.*ephemeral/iu.test(error.description ?? "")) status = "gone";
    client.logger?.warn("private_page_edit_unavailable", { sessionId: s.id, code: error.errorCode });
    await client.answerCallbackQuery(callback.id, "Не удалось обновить персональную страницу — нажми «Сводка» или «Список» заново");
  } finally {
    await store.run("UPDATE attention_settings SET value=? WHERE key=? AND value=?", JSON.stringify({ ...s, status, lockedUntil: 0 }), sessionKey(s.id), locked);
  }
}

export async function openPrivatePages({ store, client, callback, kind, entityId, chatId, renderer, now }) {
  const pointer = `private-view:${kind}:${entityId}:${callback.from.id}`;
  const previous = await store.setting(pointer);
  const existing = previous ? await read(store, previous) : null;
  if (existing?.value.expiresAt > now && existing.value.status !== "gone") {
    if (existing.value.status === "active" && validId(existing.value.messageId)) {
      await edit({ store, client, callback, session: existing, renderer, page: 0, now });
    } else await client.answerCallbackQuery(callback.id, "Предыдущая персональная отправка ещё обрабатывается или её результат неизвестен");
    return;
  }
  const id = crypto.randomUUID();
  const s = { id, kind, entityId, chatId: String(chatId), ownerId: String(callback.from.id), status: "sending", expiresAt: now + 1_800_000, lockedUntil: 0 };
  const reserve = previous == null
    ? store.db.prepare("INSERT OR IGNORE INTO attention_settings(key,value) VALUES (?,?)").bind(pointer, id)
    : store.db.prepare("UPDATE attention_settings SET value=? WHERE key=? AND value=?").bind(id, pointer, previous);
  const [reserved] = await store.db.batch([reserve,
    store.db.prepare("INSERT INTO attention_settings(key,value) SELECT ?,? WHERE changes()>0").bind(sessionKey(id), JSON.stringify(s))]);
  if (!changed(reserved)) { await client.answerCallbackQuery(callback.id, "Персональная сводка уже открывается"); return; }
  try {
    const view = await renderer({ store, id: entityId, chatId, page: 0, now });
    if (!view) throw new Error("private view source missing");
    const sent = await client.call("sendMessage", { chat_id: String(chatId), text: view.text, parse_mode: "HTML",
      reply_markup: markup(id, view.page, view.pages), ephemeral_message_parameters: { receiver_user_id: Number(callback.from.id), callback_query_id: callback.id } });
    if (!validId(sent?.ephemeral_message_id)) throw new Error("missing ephemeral message identifier");
    await store.setSetting(sessionKey(id), JSON.stringify({ ...s, status: "active", messageId: sent.ephemeral_message_id }));
    await client.answerCallbackQuery(callback.id, "Персональная сводка открыта — листай стрелками");
  } catch (error) {
    const status = error.errorCode >= 400 && error.errorCode < 500 ? "gone" : "uncertain";
    await store.setSetting(sessionKey(id), JSON.stringify({ ...s, status }));
    client.logger?.warn("private_page_send_unavailable", { sessionId: id, code: error.errorCode });
    await client.answerCallbackQuery(callback.id, "Персональная сводка недоступна — имена в группу не публикую");
  }
}

export async function processPrivatePage({ store, client, callback, config, chatId, now, authorized, renderers }) {
  const match = PRIVATE_PAGE_CALLBACK.exec(callback.data);
  const session = match ? await read(store, match[1]) : null;
  const s = session?.value;
  if (!s || s.status !== "active" || s.expiresAt <= now || !authorized(callback.from.id, config)
    || String(callback.from.id) !== s.ownerId || String(chatId) !== s.chatId
    || callback.message.ephemeral_message_id !== s.messageId
    || (callback.message.receiver_user && String(callback.message.receiver_user.id) !== s.ownerId)) {
    await client.answerCallbackQuery(callback.id, "Эта персональная страница недоступна — открой свою сводку"); return;
  }
  const renderer = renderers[s.kind];
  if (!renderer) return;
  await edit({ store, client, callback, session, renderer, page: Number(match[2]), now });
}

export function announcementLink(chatId, messageId) {
  const chat = /^-100([1-9]\d*)$/.exec(String(chatId));
  return chat && Number.isSafeInteger(messageId) && messageId > 0 ? `https://t.me/c/${chat[1]}/${messageId}` : null;
}
