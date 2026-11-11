export const GROUP_COMMANDS = [
  { command: "next", description: "Какой урок сейчас или следующий и куда идти" },
  { command: "day", description: "Завтра: во сколько приходить и уходить, обеды" },
  { command: "today", description: "Расписание на сегодня" },
  { command: "tomorrow", description: "Расписание на завтра" },
  { command: "latest", description: "Последнее загруженное расписание" },
];

export async function configureGroupCommands(client, chatId, adminUserId, curatorUserId = null) {
  if (!/^-\d+$/.test(String(chatId))) throw new Error("A negative group chat ID is required");
  if (!/^\d+$/.test(String(adminUserId))) throw new Error("A numeric admin user ID is required");
  const definitions = [
    { scope: { type: "chat", chat_id: String(chatId) }, commands: GROUP_COMMANDS },
    { scope: { type: "chat_member", chat_id: String(chatId), user_id: Number(adminUserId) },
      commands: [...ANNOUNCEMENT_COMMANDS, ...GROUP_COMMANDS, { command: "status", description: "Состояние бота — только для владельца" }] },
  ];
  if (curatorUserId && String(curatorUserId) !== String(adminUserId)) {
    if (!/^\d+$/.test(String(curatorUserId))) throw new Error("A numeric curator user ID is required");
    definitions.push({ scope: { type: "chat_member", chat_id: String(chatId), user_id: Number(curatorUserId) },
      commands: [...ANNOUNCEMENT_COMMANDS, ...GROUP_COMMANDS] });
  }
  for (const { scope, commands } of definitions) {
    for (const language_code of ["", "ru"]) {
      await client.call("setMyCommands", { scope, language_code, commands });
      const actual = await client.call("getMyCommands", { scope, language_code });
      if (JSON.stringify(actual) !== JSON.stringify(commands)) throw new Error("Telegram command menu verification failed");
    }
  }
}

export const ANNOUNCEMENT_COMMANDS = [
  { command: "all", description: "📣 Оповестить группу" },
  { command: "all_test", description: "Проверить оповещение — только для себя" },
  { command: "need", description: "🙋 Набрать добровольцев — ответь на задачу" },
  { command: "remind", description: "🔔 Напомнить позже — ответь на объявление" },
];
