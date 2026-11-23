const homeworkAction = /^hw(?::(?:list|pick):\d{1,2}|:subject:[a-f0-9]{16}|:(?:show|edit|done|reopen|remove|delete|move|cancel):\d{1,16}|:save:\d{1,16}(?::\d{4}-\d{2}-\d{2})?|:(?:date|move):\d{1,16}:\d{4}-\d{2}-\d{2}|:day:\d{4}-\d{2}-\d{2})?$/u;
const homeworkPrompt = /^(?:Запиши ДЗ|Замени текст ДЗ|Write homework|Replace homework text) · .+\n/u;
export const homeworkTextLimit = 1000;

export function validHomeworkUpdate(update) {
  if (update.action === "hw:text") return typeof update.homeworkText === "string" && update.homeworkText.length <= homeworkTextLimit
    && typeof update.homeworkPrompt === "string" && update.homeworkPrompt.length <= 220
    && /^[^\r\n]+$/u.test(update.homeworkPrompt) && Number.isSafeInteger(update.homeworkPromptId) && update.homeworkPromptId > 0;
  return (!update.action.startsWith("hw:") || homeworkAction.test(update.action))
    && !Object.hasOwn(update, "homeworkText") && !Object.hasOwn(update, "homeworkPrompt") && !Object.hasOwn(update, "homeworkPromptId");
}

export function collectPersonalUpdate(update, botId) {
  const callback = update.callback_query, message = update.message ?? callback?.message;
  const from = callback?.from ?? message?.from;
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0 || !Number.isSafeInteger(from?.id) || from.id <= 0 || from.is_bot
    || message?.chat?.type !== "private" || message.chat.id !== from.id) return null;
  const data = callback?.data;
  const callbackFields = () => ({ callbackId: String(callback.id).slice(0, 256), messageId: message.message_id });
  if (typeof data === "string" && data.startsWith("personal:") && homeworkAction.test(data.slice(9))) {
    return { update_id: update.update_id, userId: from.id, action: data.slice(9), ...callbackFields() };
  }
  const command = String(message.text ?? "").trim().split(/\s/u)[0].split("@")[0].toLowerCase();
  let action;
  if (callback) {
    if (typeof data !== "string" || !/^personal:(?:menu|schedule|today|tomorrow|next|week(?::\d{4}-\d{2}-\d{2})?|settings|help|feedback|privacy|support|donate|later|language|lang:(?:ru|en)|groups:\d{1,3}|group:\d{1,3}[\p{L}]{1,6}|toggle:(?:sound|changes|pin|paused|auto_pin)|view:\d{4}-\d{2}-\d{2}:(?:full|compact)|preview:\d{4}-\d{2}-\d{2}:(?:full|compact)(?::\d{1,3})?|widget(?::(?:today|tomorrow|next|\d{4}-\d{2}-\d{2}))?|widget-text:\d{4}-\d{2}-\d{2}|table:\d{4}-\d{2}-\d{2}|updates:(?:0|history|v\d{1,3}\.\d{1,3})|rating:(?:update-20261123:)?[1-5]|rating:later|diagnostics)$/u.test(data)) return null;
    action = data.slice("personal:".length);
  } else {
    const prompt = message.reply_to_message;
    if (!command.startsWith("/") && Number.isSafeInteger(botId) && prompt?.from?.id === botId && prompt.from.is_bot
      && Number.isSafeInteger(prompt.message_id) && prompt.message_id > 0 && homeworkPrompt.test(prompt.text ?? "")) {
      const title = prompt.text.split("\n", 1)[0];
      if (title.length > 220) return null;
      const content = typeof message.text === "string" ? message.text.trim() : "";
      return { update_id: update.update_id, userId: from.id, action: "hw:text",
        homeworkPrompt: title, homeworkPromptId: prompt.message_id, homeworkText: content.length <= homeworkTextLimit ? content : "" };
    }
    action = ({ "/student": "start", "/start": "start", "/today": "today", "/day": "today", "/tomorrow": "tomorrow", "/next": "next", "/latest": "schedule", "/stop": "pause", "/status": "diagnostics" })[command];
    if (!action && /^[\d\p{L}\s._-]{1,30}$/u.test(String(message.text ?? "")) && /\d/u.test(message.text)) action = `search:${message.text.trim()}`;
  }
  if (!action) return null;
  // No username, chat history, arbitrary messages, or forwarded content.
  return { update_id: update.update_id, userId: from.id, action,
    ...(callback ? callbackFields() : {}) };
}
