import { backToMenu, button, t } from "./view.js";

// Add new stable releases at the top. Older pages remain available in Telegram.
const releases = [
  {
    version: "V1.0",
    date: { ru: "22 ноября 2026", en: "22 November 2026" },
    notes: {
      ru: [
        "Расписание, настройки и справка оформлены в одном стиле МГМК.",
        "В таблице можно листать опубликованные дни. Прошедшие уроки раскрываются отдельно.",
        "В меню появились цветные кнопки и фирменные анимированные иконки.",
      ],
      en: [
        "The timetable, settings and help share a single МГМК style.",
        "Browse published days in the table. Expand completed lessons when you need them.",
        "The menu has colored buttons and custom animated icons.",
      ],
    },
  },
];

export function releasePage(user, requested, branded) {
  const language = user.language === "en" ? "en" : "ru";
  const w = t(user);
  const page = Math.max(0, Math.min(requested, releases.length - 1));
  const release = releases[page];
  const stable = language === "en" ? "Stable release" : "Стабильный выпуск";
  const navigation = [];
  if (page > 0) navigation.push(button(language === "en" ? "← Newer" : "← Новее", `updates:${page - 1}`));
  if (page + 1 < releases.length) navigation.push(button(language === "en" ? "Older →" : "Старее →", `updates:${page + 1}`));
  return {
    text: `<b>${w.updates} · ${release.version}</b>\n<i>${stable} · ${release.date[language]}</i>\n\n${release.notes[language].map(note => "• " + note).join("\n\n")}`,
    keyboard: { inline_keyboard: [...(navigation.length ? [navigation] : []), ...backToMenu(user, branded).inline_keyboard] },
  };
}
