import { themedButton } from "../chat-theme.js";
import { backToMenu, button, screenText, t } from "./view.js";

// Add new releases at the top. Keep the version IDs stable for old buttons.
const releases = [
  {
    version: "V1.3", date: "23.11.2026",
    ru: ["Вся неделя под рукой", [
      "В «На неделю» можно глянуть базовый план своей группы и свежие дневные PDF",
      "Расписание собрано в одном сообщении с пометкой, что пары могут поменяться",
    ]],
    en: ["The week at a glance", [
      "This week combines your group’s weekly plan and the latest daily PDFs",
      "The whole plan opens in one message and is marked as tentative",
    ]],
  },
  {
    version: "V1.2", date: "23.11.2026",
    ru: ["В расписании проще ориентироваться", [
      "Перемены и обед отделены от пар",
      "Прошедшие пары отмечены галочкой и собраны под своим заголовком",
      "Для 8-Сба в личке можно посмотреть, сколько осталось до конца текущей пары",
    ]],
    en: ["An easier timetable to scan", [
      "Breaks and lunch stand out between classes",
      "Finished classes have a check mark and their own heading",
      "The 8-Сба personal timetable can show how long the current class has left",
    ]],
  },
  {
    version: "V1.1", date: "22.11.2026",
    ru: ["Бот стал проще", [
      "Все пары теперь в одном формате — время видно сразу",
      "Добавили фирменные эмодзи в сообщения и кнопки",
      "В настройках зеленое значит «включено», красное — «выключено»",
      "Обновили личку и кабинет преподавателя",
    ]],
    en: ["A simpler bot", [
      "Every class uses the same layout with the time up front",
      "Custom emoji now appear in messages and buttons",
      "In Settings, green means on and red means off",
      "Updated the personal chat and teacher view",
    ]],
  },
  {
    version: "V1.0", date: "22.11.2026",
    ru: ["Единый стиль МГМК", [
      "Расписание, настройки и справка оформлены в одном стиле МГМК",
      "В таблице можно листать опубликованные дни. Прошедшие уроки раскрываются отдельно",
      "В меню появились цветные кнопки, фирменные иконки и история версий",
    ]],
    en: ["The МГМК redesign", [
      "The timetable, settings and help share a single МГМК style",
      "Browse published days in the table and expand completed lessons when needed",
      "The menu has colored buttons, animated icons and a release history",
    ]],
  },
  {
    version: "V0.8", date: "21.11.2026",
    ru: ["Сейчас и дальше", ["Для 8-Сба добавили пилот: карточка показывает текущий и следующий урок. Правки времени и кабинета видны в той же карточке"]],
    en: ["Now and next", ["The 8-Сба pilot adds the current and next lesson to the card. Time and room changes appear there too"]],
  },
  {
    version: "V0.7", date: "20.11.2026",
    ru: ["Оценка бота и пилот виджета", ["Появилась возможность оценить бота", "HTML-виджет попробовали на 8-Сба и приостановили после ограничения Telegram. Расписание осталось доступно в чате"]],
    en: ["Ratings and widget pilot", ["Users could now rate the bot", "The 8-Сба HTML widget pilot was paused after a Telegram restriction. Timetables stayed available in chat"]],
  },
  {
    version: "V0.6", date: "19.11.2026",
    ru: ["Тихие часы и отдельный закреп", ["Фоновые проверки перешли на 15-минутный интервал с 20:00 до 06:30 по Минску. Кнопки по-прежнему работают сразу", "Главное меню открывается отдельно от закреплённого расписания"]],
    en: ["Quiet hours and separate navigation", ["Background checks switched to a 15-minute interval from 20:00 to 06:30 Minsk time. Buttons still respond immediately", "The main menu opens separately from the pinned timetable"]],
  },
  {
    version: "V0.5", date: "16–18.11.2026",
    ru: ["Быстрее новые расписания", ["16.11 · Ускорили постановку личных карточек после выхода нового PDF", "17.11 · Добавили добровольную поддержку автора", "18.11 · Личные карточки стали обрабатываться параллельно, чтобы задержка одного запроса не тормозила остальных"]],
    en: ["Faster timetable delivery", ["16 November · Personal cards were queued faster after a new PDF arrived", "17 November · Added voluntary support for the author", "18 November · Personal deliveries began running concurrently so one slow request would not hold up others"]],
  },
  {
    version: "V0.4", date: "15.11.2026",
    ru: ["Листание и возврат закрепа", ["Длинное расписание стало листаться в одном сообщении. Исправили возобновление автообновлений и восстановление удалённого закрепа"]],
    en: ["Paging and pin recovery", ["Long timetables gained paging in one message. Resuming updates and recovering a deleted pin were fixed"]],
  },
  {
    version: "V0.3", date: "13.11.2026",
    ru: ["Кнопки отвечают быстрее", ["Личные нажатия стали обрабатываться сразу. Для ручных запросов выделили резерв, чтобы просмотр оставался доступен при высокой фоновой нагрузке"]],
    en: ["Faster button replies", ["Personal button taps began running immediately. Manual requests received reserved capacity when background load was high"]],
  },
  {
    version: "V0.2", date: "12.11.2026",
    ru: ["Обратная связь", ["Появились экраны «Обратная связь» и «О боте и данных» с контактом автора и пояснениями об источнике расписания"]],
    en: ["Feedback and privacy", ["Added Feedback and About and privacy screens with the author’s contact and an explanation of the timetable source"]],
  },
  {
    version: "V0.1", date: "11.11.2026",
    ru: ["Первый открытый выпуск", ["Опубликовали исходники бота под лицензией MIT. В открытый репозиторий вошли инструкция и примеры конфигурации"]],
    en: ["First open-source release", ["The bot source was published under the MIT license with instructions and example configuration"]],
  },
];

const actionFor = release => `updates:${release.version.toLowerCase()}`;
const repository = "https://github.com/Tylerye/mgmk-schedule-bot-open-source";

export function releasePage(user, target, branded) {
  const language = user.language === "en" ? "en" : "ru";
  const en = language === "en";
  const w = t(user);
  const main = backToMenu(user, branded).inline_keyboard;
  const archiveLabel = en ? "Release timeline" : "Хронология";
  const archiveExplanation = en ? "We numbered the early milestones when we made this archive"
    : "V0.x — номера, которые мы добавили для архива";

  if (target === "history") {
    const chronological = releases.toReversed();
    const timeline = chronological.map((release, index) => {
      const end = index === chronological.length - 1;
      return `${end ? "◆" : "│"} <b>${release.version}</b> · <i>${release.date}</i>\n${end ? " " : "│"}  ${release[language][0]}`;
    }).join("\n");
    const buttons = chronological.map(release => button(release.version, actionFor(release), { branded,
      style: release === releases[0] ? "primary" : undefined,
    }));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
    return {
      text: screenText("updates", `<b>${archiveLabel} · МГМК</b>\n<i>${en ? "From the first open-source release" : "С первого открытого выпуска"}</i>\n\n${timeline}\n\n<i>${archiveExplanation}</i>`, branded),
      keyboard: { inline_keyboard: [...rows, [themedButton("GitHub", { url: repository }, "github", { branded, style: "primary" })], ...main] },
    };
  }

  const page = Math.max(0, releases.findIndex(release => release.version.toLowerCase() === target));
  const release = releases[page];
  const [title, notes] = release[language];
  const status = page === 0 ? (en ? "Stable release" : "Свежая версия") : (en ? "Archive milestone" : "Из архива");
  const navigation = [];
  if (page > 0) navigation.push(button("← " + releases[page - 1].version, actionFor(releases[page - 1]), { branded }));
  if (page + 1 < releases.length) navigation.push(button(releases[page + 1].version + " →", actionFor(releases[page + 1]), { branded }));
  return {
    text: screenText("updates", `<b>${w.updates} · ${release.version}</b>\n<i>${status} · ${release.date}</i>\n\n<b>${title}</b>\n\n${notes.map(note => "• " + note).join("\n\n")}`, branded),
    keyboard: { inline_keyboard: [
      ...(navigation.length ? [navigation] : []),
      [button(archiveLabel, "updates:history", { branded, style: "primary" })],
      ...main,
    ] },
  };
}
