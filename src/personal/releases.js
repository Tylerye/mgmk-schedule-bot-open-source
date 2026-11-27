import { themedButton } from "../chat-theme.js";
import { backToMenu, button, screenText, t } from "./view.js";

// Add new releases at the top. Keep the version IDs stable for old buttons.
const releases = [
  {
    version: "V1.6", date: "27.11.2026",
    ru: ["Быстрее меню, надежнее расписание", [
      "«Главное меню» открывается отдельно от фоновых обновлений расписания",
      "Расписание для группы и лички обновляется параллельно. Если колледж заменит PDF, бот продолжит отправку тем, кто еще ждет",
      "Поправили разбор PDF, где номер кабинета сливался с предметом или фамилией преподавателя",
    ]],
    en: ["Faster menu, more reliable timetables", [
      "The main menu opens independently of background timetable updates",
      "Group and personal timetables update in parallel. If the college replaces a PDF, delivery continues for people still waiting",
      "Fixed PDFs where a room number was merged with the subject or the teacher’s name",
    ]],
  },
  {
    version: "V1.5", date: "25.11.2026",
    ru: ["ДЗ, закреп и расписание на неделю", [
      "После выбора предмета можно написать ДЗ прямо в чат или ответить на подсказку",
      "Домашнее задание появляется в опубликованной карточке и сверяется с уроками из дневного PDF",
      "При открытии закреплённого дня бот обновляет старую карточку на месте",
      "В расписании на неделю все дни свёрнуты, воскресенье убрано",
      "У коротких перемен появился свой значок",
    ]],
    en: ["Homework, pins and the weekly timetable", [
      "After choosing a subject, type in the chat or reply to the prompt",
      "Homework appears on the published card and follows the lessons in the daily PDF",
      "Opening the pinned day refreshes its existing card",
      "Weekdays and Saturday start collapsed, and Sunday is omitted",
      "Short breaks have their own icon",
    ]],
  },
  {
    version: "V1.4", date: "23.11.2026",
    ru: ["Мое ДЗ", [
      "Открой «Мое ДЗ» в меню, выбери предмет и ответь боту текстом или ссылкой",
      "Нажми дату, чтобы сохранить ДЗ",
      "В расписании задания идут под парами, по порядку уроков",
      "Жми «ДЗ к этому дню», чтобы посмотреть все задания на день",
      "В кабинете преподавателя обновили расписание и закреп",
    ]],
    en: ["My homework", [
      "Open My homework in the main menu, choose a subject, reply with text or a link, and tap a date to save",
      "Assignments appear in lesson order. Tap Homework for this date to open a private summary for that day",
      "Updated the timetable card and pin in the teacher view",
    ]],
  },
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
    ru: ["Сейчас и дальше", ["Для 8-Сба карточка показывает текущую и следующую пару", "Если поменяется время или кабинет, это будет видно в той же карточке"]],
    en: ["Now and next", ["The 8-Сба pilot adds the current and next lesson to the card. Time and room changes appear there too"]],
  },
  {
    version: "V0.7", date: "20.11.2026",
    ru: ["Оценка бота и пробный виджет", ["Добавили оценку бота", "На 8-Сба попробовали виджет, потом убрали его из-за ограничения Telegram", "Расписание осталось в чате"]],
    en: ["Ratings and widget pilot", ["Users could now rate the bot", "The 8-Сба HTML widget pilot was paused after a Telegram restriction. Timetables stayed available in chat"]],
  },
  {
    version: "V0.6", date: "19.11.2026",
    ru: ["Тихие часы и отдельный закреп", ["С 20:00 до 06:30 по Минску бот проверяет расписание раз в 15 минут", "Кнопки работают сразу, а главное меню открывается отдельно от закрепа"]],
    en: ["Quiet hours and separate navigation", ["Background checks switched to a 15-minute interval from 20:00 to 06:30 Minsk time. Buttons still respond immediately", "The main menu opens separately from the pinned timetable"]],
  },
  {
    version: "V0.5", date: "16–18.11.2026",
    ru: ["Новое расписание приходит быстрее", ["16.11 · Личные карточки стали быстрее приходить после нового PDF", "17.11 · Добавили кнопку поддержки автора", "18.11 · Карточки в личку приходят параллельно"]],
    en: ["Faster timetable delivery", ["16 November · Personal cards were queued faster after a new PDF arrived", "17 November · Added voluntary support for the author", "18 November · Personal deliveries began running concurrently so one slow request would not hold up others"]],
  },
  {
    version: "V0.4", date: "15.11.2026",
    ru: ["Листание и возврат закрепа", ["Длинное расписание можно листать в одном сообщении", "Исправили включение автообновлений и возврат удаленного закрепа"]],
    en: ["Paging and pin recovery", ["Long timetables gained paging in one message. Resuming updates and recovering a deleted pin were fixed"]],
  },
  {
    version: "V0.3", date: "13.11.2026",
    ru: ["Кнопки отвечают быстрее", ["Кнопки в личке работают сразу, даже когда бот обновляет много карточек"]],
    en: ["Faster button replies", ["Personal button taps began running immediately. Manual requests received reserved capacity when background load was high"]],
  },
  {
    version: "V0.2", date: "12.11.2026",
    ru: ["Обратная связь", ["В «Обратной связи» можно написать автору", "В «О боте и данных» рассказали, откуда берется расписание"]],
    en: ["Feedback and privacy", ["Added Feedback and About and privacy screens with the author’s contact and an explanation of the timetable source"]],
  },
  {
    version: "V0.1", date: "11.11.2026",
    ru: ["Первый открытый выпуск", ["Выложили код бота на GitHub под лицензией MIT", "Там же лежат инструкция и примеры настроек"]],
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
