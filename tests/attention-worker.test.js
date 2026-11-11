import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { sqliteAdapter } from "../src/attention-local.js";
import { D1StateStore } from "../cloudflare/d1-store.js";
import { attentionMaintenance } from "../cloudflare/attention-runtime.js";

async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["0001_initial.sql", "0002_webhook_inbox.sql", "0004_attention.sql", "0005_acknowledgements.sql", "0006_recruitments.sql", "0007_event_reminders.sql"])
    sqlite.exec(await readFile(`migrations/${file}`, "utf8"));
  const DB = sqliteAdapter(sqlite);
  const state = new D1StateStore(DB);
  await state.load(); state.state.chatId = "-1001"; await state.save();
  return { sqlite, DB, env: { DB, BOT_TOKEN: "fake", ADMIN_USER_ID: "42", TELEGRAM_WEBHOOK_SECRET: "fake" } };
}

test("attention webhook bypasses schedule lock, persists no conversation, confirms exactly once", async () => {
  const bundle = await build({ entryPoints: ["cloudflare/worker.js"], bundle: true, write: false, format: "esm", platform: "node", external: ["node:crypto"] });
  const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  const f = await fixture(); const pending = [], calls = []; const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const method = String(url).split("/").at(-1), body = JSON.parse(options.body); calls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: 100 + calls.length,
      ...(body.ephemeral_message_parameters ? { ephemeral_message_id: 500 + calls.length } : {}) } : true }));
  };
  const chat = { id: -1001, type: "supergroup" };
  const post = update => worker.fetch(new Request("https://worker.test/telegram/webhook", {
    method: "POST", headers: { "x-telegram-bot-api-secret-token": "fake" }, body: JSON.stringify(update),
  }), f.env, { waitUntil(promise) { pending.push(promise); } });
  try {
    await f.DB.prepare("INSERT INTO runtime_locks VALUES ('state','busy',?)").bind(Date.now() + 60_000).run();
    const stateBefore = (await f.DB.prepare("SELECT json FROM app_state").first()).json;
    await post({ update_id: 1, message: { message_id: 1, chat, from: { id: 43, first_name: "Student" }, text: "PRIVATE CHAT TEXT" } });
    assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM telegram_inbox").first()).n, 0);
    const update = { update_id: 2, message: { message_id: 2, chat, from: { id: 42, first_name: "Owner" }, caption: "!важно PRIVATE ANNOUNCEMENT" } };
    await Promise.all([post(update), post(update)]); await Promise.all(pending);
    const r = await f.DB.prepare("SELECT * FROM attention_requests").first();
    assert.equal(r.status, "pending");
    assert.equal(calls.filter(call => call.method === "sendMessage").length, 1);
    const confirmation = { update_id: 3, callback_query: { id: "callback", data: `attention:confirm:${r.id}`,
      from: { id: 42 }, message: { message_id: r.prompt_id, chat } } };
    await Promise.all([post(confirmation), post(confirmation)]); await Promise.all(pending);
    assert.equal(calls.filter(call => call.method === "sendMessage").length, 2);
    assert.match(calls.find(call => call.body.text?.includes("tg://user")).body.text, /id=43/);
    assert.equal((await f.DB.prepare("SELECT json FROM app_state").first()).json, stateBefore);
    assert.ok(calls.every(call => !call.method.includes("pin")));
    assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM telegram_inbox").first()).n, 0);
    assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM attention_members").first()).n, 2);
    const part = await f.DB.prepare("SELECT message_id FROM attention_parts WHERE request_id=? AND part=0").bind(r.id).first();
    const reads = { update_id: 5, callback_query: { id: "read", data: `ack:read:${r.id}`,
      from: { id: 43 }, message: { message_id: part.message_id, chat } } };
    await Promise.all([post(reads), post(reads)]); await Promise.all(pending);
    assert.equal((await f.DB.prepare("SELECT COUNT(confirmed_at) AS n FROM announcement_audience").first()).n, 1);
    assert.equal(calls.filter(call => call.method === "sendMessage").length, 2);
    assert.equal((await f.DB.prepare("SELECT json FROM app_state").first()).json, stateBefore);
    assert.match(calls.filter(call => call.method === "editMessageReplyMarkup").at(-1).body.reply_markup.inline_keyboard[0][0].text, /1\/1/);
    for (const bad of [
      { update_id: 10, message: { text: "/next PRIVATE TEXT", chat: { id: 42, type: "private" }, from: { id: 42 } } },
      { update_id: 11, message: { text: "/next PRIVATE TEXT", chat: { id: -999, type: "supergroup" }, from: { id: 42 } } },
      { update_id: 12, _attention: true, message: { text: "ordinary PRIVATE TEXT", chat, from: { id: 42 } } },
      { update_id: 13, message: { text: "/unknown PRIVATE TEXT", chat, from: { id: 42 } } },
      { update_id: 14, callback_query: { id: "malformed", data: "attention:join:fake", message: { message_id: 1, chat }, from: { id: 43 } } },
    ]) assert.equal((await (await post(bad)).json()).ignored, true);
    assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM telegram_inbox").first()).n, 0);
    assert.equal(calls.filter(call => call.method === "sendMessage").length, 2);
    const malformed = await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST", headers: { "x-telegram-bot-api-secret-token": "fake" }, body: "{bad JSON",
    }), f.env, { waitUntil(promise) { pending.push(promise); } });
    assert.equal(malformed.status, 400);
    await post({ update_id: 20, callback_query: { id: "report", from: { id: 42 }, data: `ack:report:${r.id}`, message: { message_id: part.message_id, chat } } });
    await Promise.all(pending);
    const privateMessage = calls.filter(c => c.method === "sendMessage").at(-1).body;
    const data = privateMessage.reply_markup.inline_keyboard[0][0].callback_data;
    const session = JSON.parse((await f.DB.prepare("SELECT value FROM attention_settings WHERE key=?").bind(`private-session:${data.split(":")[1]}`).first()).value);
    const page = { update_id: 21, callback_query: { id: "page", from: { id: 42 }, data,
      message: { message_id: 0, ephemeral_message_id: session.messageId, receiver_user: { id: 42 }, chat, text: "PRIVATE REPORT" } } };
    await Promise.all([post(page), post(page)]); await Promise.all(pending);
    assert.equal(calls.filter(c => c.method === "editEphemeralMessageText").length, 1);
    assert.equal(calls.filter(c => c.method === "sendMessage").length, 3);
    assert.equal(calls.filter(c => c.method === "editEphemeralMessageText")[0].body.receiver_user_id, 42);
    assert.equal((await f.DB.prepare("SELECT json FROM app_state").first()).json, stateBefore);
    assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM telegram_inbox").first()).n, 0);
  } finally { await Promise.all(pending); globalThis.fetch = original; f.sqlite.close(); }
});

test("recruitment uses independent durable webhook lane without changing schedule or publishing names", async () => {
  const bundle = await build({ entryPoints: ["cloudflare/worker.js"], bundle: true, write: false, format: "esm", platform: "node", external: ["node:crypto"] });
  const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  const f = await fixture(); const original = globalThis.fetch; const pending = [], calls = [];
  globalThis.fetch = async (url, options) => {
    const method = String(url).split("/").at(-1), body = JSON.parse(options.body); calls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: 999 } : method === "getChatMember" ? { status: "member", user: { id: body.user_id, first_name: "Student" } } : true }));
  };
  const chat = { id: -1001, type: "supergroup" };
  const post = update => worker.fetch(new Request("https://worker.test/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "fake" }, body: JSON.stringify(update) }), f.env, { waitUntil(p) { pending.push(p); } });
  try {
    await f.DB.prepare("INSERT INTO runtime_locks VALUES ('state','busy',?)").bind(Date.now() + 60_000).run();
    const state = (await f.DB.prepare("SELECT json FROM app_state").first()).json;
    const raw = { update_id: 1, message: { message_id: 10, chat, from: { id: 42 }, text: "/need 1", reply_to_message: { message_id: 9, text: "PRIVATE TASK" } } };
    await Promise.all([post(raw), post(raw)]); await Promise.all(pending);
    const r = await f.DB.prepare("SELECT * FROM recruitments").first();
    assert.equal(r.capacity, 1);
    assert.equal(calls.filter(c => c.method === "sendMessage").length, 1);
    await Promise.all([43, 44].map(id => post({ update_id: id, callback_query: { id: `cb${id}`, data: `need:join:${r.id}`, from: { id }, message: { message_id: r.message_id, chat } } }))); await Promise.all(pending);
    assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM recruitment_members WHERE active=1").first()).n, 1);
    assert.equal(calls.filter(c => c.method === "sendMessage").length, 1);
    assert.equal((await f.DB.prepare("SELECT json FROM app_state").first()).json, state);
    assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM telegram_inbox").first()).n, 0);
    assert.ok(calls.every(c => !c.method.includes("pin") && !c.body.text?.includes("PRIVATE TASK")));
  } finally { await Promise.all(pending); globalThis.fetch = original; f.sqlite.close(); }
});

test("reminder webhook and maintenance bypass schedule lock, deduplicate and preserve announcement privacy", async () => {
  const bundle = await build({ entryPoints: ["cloudflare/worker.js"], bundle: true, write: false, format: "esm", platform: "node", external: ["node:crypto"] });
  const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  const f = await fixture(); const original = globalThis.fetch; const pending = [], calls = [];
  globalThis.fetch = async (url, options) => {
    const method = String(url).split("/").at(-1), body = JSON.parse(options.body); calls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: 100 + calls.length } : true }));
  };
  const chat = { id: -1001, type: "supergroup" };
  const post = update => worker.fetch(new Request("https://worker.test/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "fake" }, body: JSON.stringify(update) }), f.env, { waitUntil(p) { pending.push(p); } });
  try {
    await f.DB.prepare("INSERT INTO runtime_locks VALUES ('state','busy',?)").bind(Date.now() + 60_000).run();
    await f.DB.prepare("INSERT INTO attention_settings VALUES ('setup:v1:-1001','done')").run();
    const state = (await f.DB.prepare("SELECT json FROM app_state").first()).json;
    const raw = { update_id: 1, message: { message_id: 10, chat, from: { id: 42 }, text: "/remind завтра 08:00", reply_to_message: { message_id: 9, text: "SECRET ANNOUNCEMENT" } } };
    await Promise.all([post(raw), post(raw)]); await Promise.all(pending);
    assert.equal(calls.filter(c => c.method === "sendMessage").length, 1);
    assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM event_reminders").first()).n, 1);
    await f.DB.prepare("UPDATE event_reminders SET due_at=?").bind(Date.now() - 1000).run();
    await attentionMaintenance(f.env, { adminUserId: "42" }, { info() {}, warn() {} });
    await attentionMaintenance(f.env, { adminUserId: "42" }, { info() {}, warn() {} });
    assert.equal(calls.filter(c => c.method === "sendMessage").length, 2);
    const reminder = calls.filter(c => c.method === "sendMessage")[1].body;
    assert.equal(reminder.reply_parameters.message_id, 9);
    assert.equal(reminder.reply_parameters.allow_sending_without_reply, false);
    assert.equal(reminder.reply_markup.inline_keyboard[0][0].url, "https://t.me/c/1/9");
    assert.equal((await f.DB.prepare("SELECT status FROM event_reminders").first()).status, "sent");
    assert.equal((await f.DB.prepare("SELECT json FROM app_state").first()).json, state);
    assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM telegram_inbox").first()).n, 0);
    assert.ok(calls.every(c => !/pin/i.test(c.method) && !JSON.stringify(c.body).includes("SECRET")));
  } finally { await Promise.all(pending); globalThis.fetch = original; f.sqlite.close(); }
});

test("bootstrap keeps webhook secret and pending updates, configures private menus, posts registration once", async () => {
  const f = await fixture(); const original = globalThis.fetch; const calls = []; const menus = new Map();
  globalThis.fetch = async (url, options) => {
    const method = String(url).split("/").at(-1), body = JSON.parse(options.body); calls.push({ method, body });
    let result = true;
    if (method === "getMe") result = { id: 7, username: "schedule_bot" };
    if (method === "getChatMember") result = { user: { id: body.user_id, first_name: "Member" }, status: "administrator", can_pin_messages: true };
    if (method === "getWebhookInfo") result = { url: "https://existing.test/telegram/webhook", max_connections: 20, allowed_updates: ["message", "callback_query"] };
    const key = JSON.stringify([body.scope, body.language_code]);
    if (method === "setMyCommands") menus.set(key, body.commands);
    if (method === "getMyCommands") result = menus.get(key);
    if (method === "sendMessage") result = { message_id: 555 };
    return new Response(JSON.stringify({ ok: true, result }));
  };
  const logger = { info() {}, warn() {} };
  try {
    await attentionMaintenance(f.env, { adminUserId: "42" }, logger);
    await attentionMaintenance(f.env, { adminUserId: "42" }, logger);
    const webhook = calls.find(call => call.method === "setWebhook").body;
    assert.equal(webhook.url, "https://existing.test/telegram/webhook");
    assert.equal(webhook.secret_token, "fake");
    assert.equal(webhook.drop_pending_updates, false);
    assert.ok(webhook.allowed_updates.includes("chat_member"));
    assert.equal(calls.filter(call => call.method === "sendMessage").length, 1);
    assert.equal(calls.filter(call => call.method === "setMyCommands").length, 6);
    assert.ok(calls.every(call => !call.method.includes("pin")));
  } finally { globalThis.fetch = original; f.sqlite.close(); }
});
