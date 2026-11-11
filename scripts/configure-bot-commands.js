import { TelegramClient } from "../src/telegram.js";
import { configureGroupCommands } from "../src/bot-commands.js";
import { CURATOR_USER_ID } from "../src/attention.js";

if (!process.env.BOT_TOKEN) throw new Error("BOT_TOKEN is required");
await configureGroupCommands(new TelegramClient({ token: process.env.BOT_TOKEN }), process.env.GROUP_CHAT_ID, process.env.ADMIN_USER_ID, CURATOR_USER_ID);
console.log(JSON.stringify({ event: "group_command_menu_verified", ok: true }));
