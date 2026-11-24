const themeEmoji = {
  homework: "5197713793202829678",
  completed: "5195043813898370122",
  live: "5195090654811697547",
  github: "5195296753112363722",
  lunch: "5197633344170405759",
  large_break: "5195319567978637499",
  break: "5202158723576934145",
  today: "5197680953882883689",
  tomorrow: "5197618530828202500",
  settings: "5197388333466041903",
  next: "5195169072324589074",
  schedule: "5195345685674768707",
  help: "5194981468153098754",
  support: "5195026432165724121",
  feedback: "5195418511140237268",
  privacy: "5195285569017523087",
  updates: "5197289295815159555",
  menu: "5195147176581313146",
  table: "5197713793202829678",
  view: "5195052549861848434",
  group: "5197402489678243789",
  language: "5195156775833218565",
  sound: "5195066426901183518",
  changes: "5195143336880550013",
  paused: "5194911670639570898",
  auto_pin: "5197244563730772418",
  back: "5195318936618449178",
};

const fallback = {
  homework: "📝",
  completed: "✅", live: "🟠",
  github: "💻", lunch: "🍴", large_break: "☕", break: "⏳",
  today: "📅", tomorrow: "🗓", next: "⏭", schedule: "📚", settings: "⚙️",
  help: "💡", support: "💛", feedback: "💬", privacy: "ℹ️", updates: "✨",
  menu: "🏠", table: "📋", view: "🕘", group: "👥", language: "🌐",
  sound: "🔊", changes: "🔔", paused: "⏸", auto_pin: "📌", back: "↩️",
};

export function themeIcon(key, branded) {
  const alt = fallback[key];
  const id = branded && themeEmoji[key];
  return id ? '<tg-emoji emoji-id="' + id + '">' + alt + '</tg-emoji>' : alt;
}

export const heading = (key, title, branded) => themeIcon(key, branded) + " <b>" + title + "</b>";

export function lessonHeading({ number, start, end }, english = false) {
  const label = english ? number + " lesson" : number + "-й урок";
  return "<b>" + label + "</b>" + (start && end ? " · " + start + "–" + end : "");
}

export function themedButton(text, target, key, { branded = false, style, plain = false } = {}) {
  const id = branded && themeEmoji[key];
  const label = !id && !plain && fallback[key] ? fallback[key] + " " + text : text;
  return { text: label, ...target, ...(style && { style }), ...(id && { icon_custom_emoji_id: id }) };
}

const fallbackById = Object.fromEntries(Object.entries(themeEmoji).map(([key,id])=>[id,fallback[key]]));
function plainKeyboard(markup, textOnly = false) {
  if (!markup?.inline_keyboard?.some(row => row.some(item => item.icon_custom_emoji_id))) return markup;
  return { inline_keyboard: markup.inline_keyboard.map(row => row.map(item => {
    const { icon_custom_emoji_id: id, ...plain } = item;
    return !textOnly && id && fallbackById[id] ? { ...plain, text: fallbackById[id] + " " + plain.text } : plain;
  })) };
}

// Retry only after a definitive format rejection. A timeout may already
// have delivered the original message, so it must go to the caller unchanged.
const formatRejected = error => error.apiRejected && error.errorCode === 400
  && /emoji|entities|reply markup|button.type.invalid/iu.test(error.description ?? "");
export async function sendWithThemeFallback(send, text, keyboard, { customEmojiOnly = false } = {}) {
  try { return await send(text, keyboard); }
  catch (error) {
    if (!formatRejected(error)) throw error;
    const withoutTimer = text?.replace(/<tg-time unix="\d+" format="r">([^<]*)<\/tg-time>/gu, "$1");
    if (withoutTimer !== text && !/button/iu.test(error.description ?? "")) {
      try {
        return await send(withoutTimer, keyboard);
      } catch (retry) {
        if (!formatRejected(retry) || !withoutTimer.includes("<tg-emoji") && plainKeyboard(keyboard, customEmojiOnly) === keyboard) throw retry;
        error = retry;
      }
    }
    const plain = withoutTimer?.replace(/<tg-emoji emoji-id="\d+">([^<]*)<\/tg-emoji> ?/gu, customEmojiOnly ? "" : "$1");
    const markup = plainKeyboard(keyboard, customEmojiOnly);
    if (customEmojiOnly && plain !== text && markup !== keyboard) {
      const buttonRejected = /button[^\n]*emoji/iu.test(error.description ?? "");
      try {
        return buttonRejected ? await send(text, markup) : await send(plain, keyboard);
      } catch (retry) {
        if (!formatRejected(retry)) throw retry;
      }
    }
    if (plain === text && markup === keyboard) throw error;
    return send(plain, markup);
  }
}
