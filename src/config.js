import { readFile } from "node:fs/promises";
import { minutesFromTime } from "./dates.js";

function integer(name, fallback, { min = 0 } = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return value;
}

export async function loadConfig({ dryRun = false } = {}) {
  const bellsUrl = new URL("../config/bells.json", import.meta.url);
  const bells = JSON.parse(await readFile(bellsUrl, "utf8"));
  const config = {
    botToken: process.env.BOT_TOKEN?.trim() || null,
    adminUserId: process.env.ADMIN_USER_ID?.trim() || null,
    driveFolderId: process.env.DRIVE_FOLDER_ID?.trim() || "REPLACE_WITH_YOUR_PUBLIC_FOLDER_ID",
    groupName: process.env.GROUP_NAME?.trim() || "8Са",
    displayGroup: process.env.DISPLAY_GROUP_NAME?.trim() || "8-Сба",
    timezone: process.env.TIMEZONE?.trim() || "Europe/Minsk",
    statePath: process.env.STATE_PATH?.trim() || "./data/state.json",
    pollIntervalMs: integer("SCHEDULE_POLL_SECONDS", 60, { min: 10 }) * 1_000,
    pinSwitchTime: process.env.PIN_SWITCH_TIME?.trim() || "16:00",
    healthPort: integer("HEALTH_PORT", 8080, { min: 1 }),
    healthHost: process.env.HEALTH_HOST?.trim() || "127.0.0.1",
    lookaheadDays: integer("LOOKAHEAD_DAYS", 5, { min: 1 }),
    httpTimeoutMs: integer("HTTP_TIMEOUT_MS", 30_000, { min: 1_000 }),
    httpRetries: integer("HTTP_RETRIES", 3, { min: 1 }),
    logLevel: process.env.LOG_LEVEL?.trim() || "info",
    bells,
    dryRun,
  };

  new Intl.DateTimeFormat("ru-RU", { timeZone: config.timezone }).format(new Date());
  minutesFromTime(config.pinSwitchTime);
  if (!dryRun && !config.botToken) throw new Error("BOT_TOKEN is required outside dry-run mode");
  if (!dryRun && !config.adminUserId) throw new Error("ADMIN_USER_ID is required outside dry-run mode");
  return config;
}
