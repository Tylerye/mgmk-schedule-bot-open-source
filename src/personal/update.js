export function collectPersonalUpdate(update) {
  const callback = update.callback_query, message = update.message ?? callback?.message;
  const from = callback?.from ?? message?.from;
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0 || !Number.isSafeInteger(from?.id) || from.id <= 0 || from.is_bot
    || message?.chat?.type !== "private" || message.chat.id !== from.id) return null;
  const data = callback?.data;
  const command = String(message.text ?? "").trim().split(/\s/u)[0].split("@")[0].toLowerCase();
  let action;
  if (callback) {
    if (typeof data !== "string" || !/^personal:(?:menu|schedule|today|tomorrow|next|settings|help|support|donate|later|language|lang:(?:ru|en)|groups:\d{1,3}|group:\d{1,3}[\p{L}]{1,6}|toggle:(?:sound|changes|pin|paused|auto_pin)|(?:view|preview):\d{4}-\d{2}-\d{2}:(?:full|compact)|diagnostics)$/u.test(data)) return null;
    action = data.slice("personal:".length);
  } else {
    action = ({ "/student": "start", "/start": "start", "/today": "today", "/day": "today", "/tomorrow": "tomorrow", "/next": "next", "/latest": "schedule", "/stop": "pause", "/status": "diagnostics" })[command];
    if (!action && /^[\d\p{L}\s._-]{1,30}$/u.test(String(message.text ?? "")) && /\d/u.test(message.text)) action = `search:${message.text.trim()}`;
  }
  if (!action) return null;
  // No username, chat history, arbitrary messages, or forwarded content.
  return { update_id: update.update_id, userId: from.id, action,
    ...(callback ? { callbackId: String(callback.id).slice(0, 256), messageId: message.message_id } : {}) };
}
