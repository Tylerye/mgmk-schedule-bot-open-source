import test from "node:test";
import assert from "node:assert/strict";
import { acknowledgeScheduleCallbacks, isReadOnlyTelegramUpdate, isPinPermissionError, processTelegramUpdates, TelegramApiError, TelegramClient } from "../src/telegram.js";

test("fast command lane excludes setup, callbacks and unknown commands", () => {
  for (const text of ["/next", "/day@bot", "/status", "/latest", "/today", "/tomorrow"]) {
    assert.equal(isReadOnlyTelegramUpdate({ message: { text } }), true);
  }
  for (const text of ["/setup", "/unknown", "hello"]) {
    assert.equal(isReadOnlyTelegramUpdate({ message: { text } }), false);
  }
  assert.equal(isReadOnlyTelegramUpdate({ callback_query: {}, message: { text: "/day" } }), false);
});

test("Telegram errors retain authenticated group migration parameters", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error_code: 400,
    description: "group upgraded", parameters: { migrate_to_chat_id: -100123 } }), { status: 400 });
  try {
    const client = new TelegramClient({ token: "test-token" });
    await assert.rejects(client.sendMessage(-123, "test"), error => error.parameters.migrate_to_chat_id === -100123);
  } finally { globalThis.fetch = original; }
});

test("expired callback acknowledgement does not prevent a durable view update", async () => {
  const client = new TelegramClient({ token: "test-token" });
  client.call = async () => { throw new TelegramApiError("answerCallbackQuery", "query is too old", 400); };
  await client.answerCallbackQuery("expired");
  client.call = async () => { throw new TelegramApiError("answerCallbackQuery", "network request failed"); };
  await assert.rejects(client.answerCallbackQuery("retry"));
});

test("Telegram requests use HTML, callbacks, and notified pins", async () => {
  const client = new TelegramClient({ token: "test-token", logger: null });
  const requests = [];
  client.call = async (method, body) => {
    requests.push({ method, body });
    return method === "sendMessage" ? { message_id: 1 } : [];
  };
  await client.sendMessage("123", "<b>урок</b>", { replyMarkup: { inline_keyboard: [] } });
  await client.pinMessage("123", 1);
  await client.getUpdates(7);
  assert.equal(requests[0].body.parse_mode, "HTML");
  assert.deepEqual(requests[0].body.reply_markup, { inline_keyboard: [] });
  assert.equal(requests[1].body.disable_notification, false);
  assert.deepEqual(requests[2].body.allowed_updates, ["message", "callback_query", "chat_member"]);
});

test("getChatMember reports the bot pin capability", async () => {
  const client = new TelegramClient({ token: "test-token", logger: null });
  const requests = [];
  client.call = async (method, body) => {
    requests.push({ method, body });
    if (method === "getMe") return { id: 777, username: "schedule_bot" };
    return { status: "administrator", can_pin_messages: true };
  };
  await client.getMe();
  assert.deepEqual(await client.getPinCapability("-1001"), { canPin: true, status: "administrator" });
  assert.deepEqual(requests[1], { method: "getChatMember", body: { chat_id: "-1001", user_id: 777 } });
});

test("only Telegram pin permission failures use the nonfatal fallback", () => {
  assert.equal(isPinPermissionError(new TelegramApiError("pinChatMessage", "Bad Request: not enough rights to manage pinned messages in the chat", 400)), true);
  assert.equal(isPinPermissionError(new TelegramApiError("sendMessage", "network request failed")), false);
});

function policyFixture() {
  const calls = [];
  const state = {
    chatId: null,
    updateOffset: 0,
    schedules: {},
    pinnedSchedule: null,
    health: {},
  };
  const client = {
    logger: { info() {} },
    async sendMessage(...args) { calls.push(["send", ...args]); return { message_id: 1 }; },
    async editMessage(...args) { calls.push(["edit", ...args]); },
    async answerCallbackQuery(...args) { calls.push(["answer", ...args]); },
  };
  const store = {
    state,
    configureChat(chatId) { state.chatId = String(chatId); return true; },
    async save() { calls.push(["save"]); },
  };
  const config = { curatorUserId: "900000002", adminUserId: "42", displayGroup: "8-Сба", timezone: "Europe/Minsk" };
  return { calls, client, store, config };
}

test("all private messages are silently acknowledged without a reply", async () => {
  const context = policyFixture();
  const texts = ["/start", "/today", "/tomorrow", "/latest", "/status", "готово"];
  const updates = texts.map((text, index) => ({
    update_id: index + 1,
    message: { text, from: { id: 42 }, chat: { id: 42, type: "private" } },
  }));
  await processTelegramUpdates({ ...context, updates });
  assert.equal(context.calls.some(([method]) => method === "send"), false);
  assert.equal(context.store.state.updateOffset, texts.length + 1);
});

test("commands in an unknown group and non-admin setup are silent", async () => {
  const context = policyFixture();
  await processTelegramUpdates({
    ...context,
    updates: [
      { update_id: 1, message: { text: "/today", from: { id: 42 }, chat: { id: -200, type: "supergroup" } } },
      { update_id: 2, message: { text: "/setup", from: { id: 99 }, chat: { id: -200, type: "supergroup" } } },
    ],
  });
  assert.equal(context.calls.some(([method]) => method === "send"), false);
  assert.equal(context.store.state.chatId, null);
});

test("ADMIN_USER_ID can configure a group and trigger initial reconciliation", async () => {
  const context = policyFixture();
  let reconciled = 0;
  await processTelegramUpdates({
    ...context,
    updates: [{ update_id: 1, message: { text: "/setup", from: { id: 42 }, chat: { id: -300, type: "supergroup" } } }],
    reconcile: async () => { reconciled += 1; },
  });
  assert.equal(context.store.state.chatId, "-300");
  assert.equal(context.calls.filter(([method]) => method === "send").length, 1);
  assert.equal(reconciled, 1);
});

test("active callback acknowledges then edits only its message without reconciliation", async () => {
  const context = policyFixture();
  context.store.state.chatId = "-300";
  context.store.state.schedules["2026-09-15"] = {
    messageId: 55,
    viewMode: "compact",
    schedule: { date: "2026-09-15", lessons: [], timeline: [{ type: "lesson", number: 1, start: "08:15", end: "09:00", subject: "Материал", rooms: [], teachers: [] }] },
  };
  context.store.state.pinnedSchedule = { chatId: "-300", date: "2026-09-15", messageId: 55 };
  await processTelegramUpdates({
    ...context,
    updates: [{
      update_id: 1,
      callback_query: {
        id: "callback-1",
        data: "schedule:2026-09-15:full",
        message: { message_id: 55, chat: { id: -300, type: "supergroup" } },
      },
    }],
    now: new Date("2026-09-15T04:00:00.000Z"),
    reconcile: async () => { context.calls.push(["reconcile"]); },
  });
  assert.equal(context.store.state.schedules["2026-09-15"].viewMode, "full");
  assert.ok(context.calls.findIndex(([method]) => method === "answer") < context.calls.findIndex(([method]) => method === "edit"));
  assert.equal(context.calls.some(([method]) => method === "reconcile"), false);
  assert.equal(context.calls.filter(([method]) => method === "edit").length, 1);
});

test("completed schedule callback edits its historical message after its pin rotates to tomorrow", async () => {
  const context = policyFixture();
  context.store.state.chatId = "-300";
  const record = context.store.state.schedules["2026-09-15"] = {
    messageId: 55,
    viewMode: "compact",
    schedule: {
      date: "2026-09-15",
      lessons: [],
      timeline: [{ type: "lesson", number: 1, start: "08:15", end: "09:00", subject: "Материал", rooms: [], teachers: [] }],
    },
  };
  context.store.state.pinnedSchedule = { chatId: "-300", date: "2026-09-16", messageId: 56 };
  let reconciled = 0;

  await processTelegramUpdates({
    ...context,
    updates: [{
      update_id: 2,
      callback_query: {
        id: "completed-card",
        data: "schedule:2026-09-15:full",
        message: { message_id: 55, chat: { id: -300, type: "supergroup" } },
      },
    }],
    now: new Date("2026-09-16T06:00:00.000Z"),
    reconcile: async () => { reconciled += 1; },
  });

  assert.equal(record.viewMode, "full");
  assert.equal(reconciled, 0);
  assert.ok(context.calls.some(([method]) => method === "answer"));
  const edit = context.calls.find(([method]) => method === "edit");
  assert.ok(edit, "callback should directly edit the historical Telegram message");
  assert.equal(String(edit[1]), "-300");
  assert.equal(edit[2], 55);
  assert.match(edit[3], /✅ 1 урок/);
  assert.deepEqual(edit[4].replyMarkup.inline_keyboard[0][0].text, "↩️ Только актуальное");
  assert.equal(typeof record.renderHash, "string");
});

test("runtime can acknowledge a valid schedule callback before entering the state lock", async () => {
  const context = policyFixture();
  context.store.state.chatId = "-300";
  context.store.state.schedules["2026-09-15"] = { messageId: 55 };
  const updates = [{ callback_query: { id: "fast-1", data: "schedule:2026-09-15:full", message: { message_id: 55, chat: { id: -300 } } } }];
  const acknowledged = await acknowledgeScheduleCallbacks({ client: context.client, state: context.store.state, updates });
  assert.deepEqual([...acknowledged], ["fast-1"]);
  assert.deepEqual(context.calls[0], ["answer", "fast-1"]);
});

test("fast acknowledgement ignores callbacks for messages no longer owned by the bot", async () => {
  const context = policyFixture();
  context.store.state.chatId = "-300";
  context.store.state.schedules["2026-09-15"] = { messageId: 55 };
  const updates = [{ callback_query: { id: "stale-1", data: "schedule:2026-09-15:full", message: { message_id: 54, chat: { id: -300 } } } }];
  assert.equal((await acknowledgeScheduleCallbacks({ client: context.client, state: context.store.state, updates })).size, 0);
  assert.equal(context.calls.length, 0);
});
