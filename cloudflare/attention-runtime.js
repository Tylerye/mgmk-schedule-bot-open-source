import { AttentionStore, ATTENTION_UPDATES, CURATOR_USER_ID, processAttentionUpdate, recoverAttention } from "../src/attention.js";
import { configureGroupCommands } from "../src/bot-commands.js";
import { TelegramClient } from "../src/telegram.js";
import { withStateLock } from "./d1-store.js";
import { recoverEventReminders } from "../src/event-reminders.js";

export async function configuredChat(database) {
  return (await database.prepare("SELECT json_extract(json,'$.chatId') AS chat_id FROM app_state WHERE id=1").first())?.chat_id;
}

export async function drainAttentionInbox(env, config, logger, updateId = null) {
  const query = "SELECT update_id,payload FROM telegram_inbox WHERE json_extract(payload,'$._attention')=1"
    + (updateId === null ? " ORDER BY update_id LIMIT 30" : " AND update_id=?");
  const statement = env.DB.prepare(query);
  const rows = await (updateId === null ? statement : statement.bind(updateId)).all();
  const chatId = await configuredChat(env.DB);
  const store = new AttentionStore(env.DB);
  const client = new TelegramClient({ token: env.BOT_TOKEN, logger });
  for (const row of rows.results) {
    await withStateLock(env.DB, async () => {
      if (!await env.DB.prepare("SELECT 1 FROM telegram_updates WHERE update_id=?").bind(row.update_id).first()) {
        await processAttentionUpdate({ update: JSON.parse(row.payload), chatId, store, config, client });
        await env.DB.prepare("INSERT OR IGNORE INTO telegram_updates (update_id,processed_at) VALUES (?,?)")
          .bind(row.update_id, new Date().toISOString()).run();
      }
      await env.DB.prepare("DELETE FROM telegram_inbox WHERE update_id=?").bind(row.update_id).run();
    }, { name: `attention-update:${row.update_id}` });
  }
}

export async function attentionMaintenance(env, config, logger) {
  const chatId = await configuredChat(env.DB);
  if (!chatId) return;
  const now = Date.now();
  // One tiny read replaces dozens of empty recovery queries on quiet ticks.
  // Keep the conditions in sync with the recovery routines below: this only
  // skips an idle pass, never claims or sends work.
  const due = await env.DB.prepare(`SELECT
    EXISTS(SELECT 1 FROM telegram_inbox WHERE json_extract(payload,'$._attention')=1) AS inbox,
    COALESCE((SELECT value FROM attention_settings WHERE key=?),'')!='done' AS setup,
    EXISTS(SELECT 1 FROM event_reminders WHERE chat_id=? AND (
      (status='pending' AND (due_at<=? OR (prompt_status='pending' AND prompt_retry_at<=?)))
      OR (status='sending' AND updated_at<?) OR (prompt_status='sending' AND prompt_updated_at<?)
      OR (prompt_id IS NOT NULL AND status!=rendered_status))) AS reminders,
    (EXISTS(SELECT 1 FROM attention_requests WHERE chat_id=? AND (
      status IN ('preparing','sending') OR (status='pending' AND expires_at<=?) OR (status='prompting' AND updated_at<?)))
    OR EXISTS(SELECT 1 FROM attention_parts WHERE status='sending' AND updated_at<?)
    OR EXISTS(SELECT 1 FROM announcement_ack k JOIN attention_requests r ON r.id=k.request_id WHERE r.chat_id=? AND
      ((k.closed_at IS NULL AND k.expires_at<=?) OR (k.opened_at IS NOT NULL AND k.version!=k.rendered_version AND k.next_render_at<=? AND k.render_until<=?)))
    OR EXISTS(SELECT 1 FROM announcement_reminders n JOIN attention_requests r ON r.id=n.request_id WHERE r.chat_id=? AND
      (n.status IN ('preparing','sending') OR (n.status='pending' AND n.expires_at<=?) OR (n.status='prompting' AND n.updated_at<?)))
    OR EXISTS(SELECT 1 FROM announcement_reminder_parts WHERE status='sending' AND updated_at<?)
    OR EXISTS(SELECT 1 FROM recruitments WHERE chat_id=? AND (
      (status='open' AND expires_at<=?) OR (status='sending' AND updated_at<?) OR (status='ready' AND retry_at<=?)
      OR (message_id IS NOT NULL AND version!=rendered_version AND next_render_at<=?)))
    OR EXISTS(SELECT 1 FROM recruitment_members m JOIN recruitments r ON r.id=m.recruitment_id
      JOIN attention_members a ON a.chat_id=r.chat_id AND a.user_id=m.user_id
      WHERE r.chat_id=? AND r.status='open' AND r.expires_at>? AND m.active=1 AND a.active=0)) AS maintenance`)
    .bind(`setup:v1:${chatId}`, String(chatId), now, now, now - 180_000, now - 180_000,
      String(chatId), now, now - 180_000, now - 180_000, String(chatId), now, now, now,
      String(chatId), now, now - 180_000, now - 180_000, String(chatId), now, now - 180_000, now, now,
      String(chatId), now).first();
  if (!due.setup && !due.inbox && !due.reminders && !due.maintenance) return;
  const store = new AttentionStore(env.DB);
  const client = new TelegramClient({ token: env.BOT_TOKEN, logger });
  // Time-sensitive reminders use atomic row claims, never the schedule/attention lock.
  try { if (due.reminders) await recoverEventReminders({ store, client, chatId }); }
  catch (error) { logger.warn("event_reminder_maintenance_failed", { error: error.message }); }
  if (due.inbox) await drainAttentionInbox(env, config, logger);
  if (!due.setup && !due.maintenance) return;
  await withStateLock(env.DB, async () => {
    if (due.maintenance) await recoverAttention({ store, client, chatId });
    const key = `setup:v1:${chatId}`;
    if (await store.setting(key) === "done") return;
    // Recheck the previously verified numeric curator identity before rollout.
    const curator = await client.call("getChatMember", { chat_id: chatId, user_id: Number(CURATOR_USER_ID) });
    if (!["creator", "administrator", "member"].includes(curator.status)) throw new Error("Configured curator is not a group member");
    await client.getMe();
    const capability = await client.getPinCapability(chatId);
    if (!["creator", "administrator"].includes(capability.status)) throw new Error("Member tracking requires bot administrator rights");
    const webhook = await client.call("getWebhookInfo");
    if (webhook.url && !ATTENTION_UPDATES.every(type => webhook.allowed_updates?.includes(type))) {
      await client.call("setWebhook", { url: webhook.url, secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ATTENTION_UPDATES, drop_pending_updates: false, max_connections: webhook.max_connections ?? 40 });
    }
    await configureGroupCommands(client, chatId, config.adminUserId, CURATOR_USER_ID);
    await store.observe(chatId, curator.user, true, Date.now(), true);
    const owner = await client.call("getChatMember", { chat_id: chatId, user_id: Number(config.adminUserId) });
    if (["creator", "administrator", "member"].includes(owner.status)) await store.observe(chatId, owner.user, true, Date.now(), true);
    // Reserve BEFORE sending: ambiguous network failures must not post duplicates.
    const reserved = await store.run("INSERT OR IGNORE INTO attention_settings (key,value) VALUES (?, 'sending')", `registration:${chatId}`);
    if ((reserved.meta?.changes ?? 0) === 1) {
      try {
        const message = await client.sendMessage(chatId, "<b>Важные объявления куратора</b>\n\nНажми «Я в группе», чтобы бот мог упоминать тебя в важных объявлениях\nТекст переписки не сохраняется, закреп расписания не меняется", {
          replyMarkup: { inline_keyboard: [[{ text: "Я в группе", callback_data: "attention:join" }]] },
        });
        await store.setSetting(`registration:${chatId}`, String(message.message_id));
      } catch (error) {
        await store.setSetting(`registration:${chatId}`, "uncertain");
        logger.warn("attention_registration_uncertain", { code: error.errorCode });
      }
    }
    await store.setSetting(key, "done");
    logger.info("attention_setup_complete", { chatId });
  }, { name: "attention-maintenance" });
}
