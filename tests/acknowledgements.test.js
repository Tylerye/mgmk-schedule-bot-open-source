import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { sqliteAdapter } from "../src/attention-local.js";
import { AttentionStore, collectAttentionUpdate, processAttentionUpdate, recoverAttention } from "../src/attention.js";
import { acknowledgementReport, recoverAcknowledgements, refreshAcknowledgement, deliverReminder } from "../src/acknowledgements.js";

const chat = { id: -1001, type: "supergroup" };
const owner = { id: 42, first_name: "Owner" };
const config = { adminUserId: "42" };
const now = Date.now();
test("a deleted acknowledgement card is not retried every minute", async () => {
  const f = await fixture();
  try {
    await f.store.run("UPDATE announcement_ack SET version=version+1,next_render_at=0 WHERE request_id=?", f.request.id);
    let attempts = 0;
    f.client.call = async () => { attempts++; const error = new Error("deleted"); error.errorCode = 400; error.description = "Bad Request: message to edit not found"; throw error; };
    await refreshAcknowledgement({ store: f.store, client: f.client, requestId: f.request.id, now });
    await recoverAcknowledgements({ store: f.store, client: f.client, chatId: chat.id, now: now + 60_000 });
    assert.equal(attempts, 1);
    const policy = await f.store.first("SELECT version,rendered_version FROM announcement_ack WHERE request_id=?", f.request.id);
    assert.equal(policy.version, policy.rendered_version);
  } finally { f.db.close(); }
});
async function fixture(count = 3, trial = false) {
  const db = new DatabaseSync(":memory:");
  for (const name of ["0004_attention.sql", "0005_acknowledgements.sql", "0006_recruitments.sql"]) db.exec(await readFile(`migrations/${name}`, "utf8"));
  const store = new AttentionStore(sqliteAdapter(db));
  const calls = [], sent = [], answers = [];
  let sequence = 100;
  const client = {
    async sendMessage(chatId, text, options) { const message_id = ++sequence; sent.push({ chatId, text, options, message_id }); return { message_id }; },
    async editMessage(...args) { calls.push({ method: "editMessage", args }); },
    async answerCallbackQuery(...args) { answers.push(args); },
    async call(method, body) { calls.push({ method, body }); return method === "sendMessage" ? { ephemeral_message_id: 500 + calls.length } : true; },
  };
  await store.observe(chat.id, owner, true, now);
  for (let i = 0; i < count; i++) await store.observe(chat.id, { id: 43 + i, first_name: `<Student & ${i}>` }, true, now);
  const process = async (raw, time = now) => {
    const update = await collectAttentionUpdate({ update: raw, chatId: chat.id, store, config, now: time });
    if (update) await processAttentionUpdate({ update, chatId: chat.id, store, config, client, now: time });
  };
  await process({ update_id: 1, message: { message_id: 5, chat, from: owner,
    text: trial ? "/all_test" : "!важно SECRET ANNOUNCEMENT", ...(trial ? { reply_to_message: { message_id: 5 } } : {}) } });
  const request = await store.first("SELECT * FROM attention_requests");
  await process({ update_id: 2, callback_query: { id: "confirm", from: owner, data: `attention:confirm:${request.id}`, message: { chat, message_id: request.prompt_id } } });
  const control = await store.first("SELECT message_id FROM attention_parts WHERE request_id=? AND part=0", request.id);
  let updateId = 10;
  const click = async (action, userId = 42, time = now, id = request.id, messageId = control.message_id) => process({
    update_id: updateId++, callback_query: { id: `click${updateId}`, from: { id: userId }, data: `ack:${action}:${id}`, message: { chat, message_id: messageId } },
  }, time);
  return { db, store, calls, sent, answers, client, process, click, request, control };
}

test("frozen delivered roster, unique concurrent acknowledgements and coalesced counter", async () => {
  const f = await fixture();
  assert.match(f.sent[1].options.replyMarkup.inline_keyboard[0][0].text, /0\/3/);
  assert.equal(f.sent[1].options.replyToMessageId, 5);
  assert.ok(f.sent[1].options.replyMarkup.inline_keyboard.flat().every(b => !b.callback_data || Buffer.byteLength(b.callback_data) <= 64));
  assert.equal(f.sent[1].options.replyMarkup.inline_keyboard.at(-1)[0].url, "https://t.me/c/1/5");
  await f.store.observe(chat.id, { id: 99, first_name: "Late join" }, true, now + 1);
  await Promise.all([f.click("read", 43), f.click("read", 43), f.click("read", 44), f.click("read", 99)]);
  assert.equal((await f.store.first("SELECT COUNT(confirmed_at) AS n FROM announcement_audience")).n, 2);
  assert.equal((await f.store.first("SELECT COUNT(*) AS n FROM announcement_audience")).n, 3);
  const edits = f.calls.filter(c => c.method === "editMessageReplyMarkup");
  assert.match(edits.at(-1).body.reply_markup.inline_keyboard[0][0].text, /2\/3/);
  assert.ok(edits.length <= 3);
  assert.equal(f.sent.length, 2); // no chat messages for read clicks
  assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM announcement_audience").all()).includes("SECRET"));
});

test("private report puts confirmed recipients first across pages, also after closing", async () => {
  const f = await fixture(14);
  const confirmed = [44, 46, 48, 50, 51, 53, 55, 56];
  for (const userId of confirmed) {
    await f.store.run("UPDATE announcement_audience SET confirmed_at=? WHERE request_id=? AND user_id=?", now, f.request.id, String(userId));
  }
  for (const closed of [false, true]) {
    if (closed) await f.store.run("UPDATE announcement_ack SET closed_at=? WHERE request_id=?", now, f.request.id);
    const lines = [];
    for (let page = 0; page < 3; page++) {
      const report = await acknowledgementReport({ store: f.store, id: f.request.id, chatId: chat.id, now, page });
      assert.equal(report.pages, 3);
      assert.match(report.text, /Ознакомились: 8\/14/);
      assert.ok(report.text.includes(closed ? "Подтверждения закрыты" : "Подтверждения открыты"));
      lines.push(...report.text.split("\n").filter(line => /^[✅⏳]/u.test(line)));
    }
    const pending = Array.from({ length: 14 }, (_, i) => 43 + i).filter(id => !confirmed.includes(id));
    assert.deepEqual(lines, [
      ...confirmed.map(id => `✅ &lt;Student &amp; ${id - 43}&gt;`),
      ...pending.map(id => `⏳ &lt;Student &amp; ${id - 43}&gt;`),
    ]);
  }
});

test("forged buttons, foreign chat and admin actions by participants are rejected", async () => {
  const f = await fixture();
  for (const action of ["read", "close", "report", "remind"]) await f.click(action, 43, now, f.request.id, 999);
  for (const action of ["close", "report", "remind"]) await f.click(action, 43);
  await f.process({ update_id: 99, callback_query: { id: "foreign", from: owner, data: `ack:close:${f.request.id}`, message: { message_id: f.control.message_id, chat: { id: -999, type: "supergroup" } } } });
  assert.equal((await f.store.first("SELECT closed_at FROM announcement_ack")).closed_at, null);
  assert.equal((await f.store.first("SELECT COUNT(confirmed_at) AS n FROM announcement_audience")).n, 0);
  assert.equal(f.calls.filter(c => c.method === "sendMessage").length, 0);
});

test("private report only, escaped names and no public fallback on unsupported API", async () => {
  const f = await fixture(15);
  await f.click("report");
  await f.click("report");
  const reports = f.calls.filter(c => c.method === "sendMessage");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].body.ephemeral_message_parameters.receiver_user_id, 42);
  assert.ok(reports[0].body.ephemeral_message_parameters.callback_query_id);
  assert.match(reports[0].body.text, /&lt;Student &amp;/);
  assert.match(reports[0].body.text, /Страница 1\/3/);
  const data = reports[0].body.reply_markup.inline_keyboard[0].at(-1).callback_data;
  const sessionId = data.split(":")[1];
  const session = JSON.parse(await f.store.setting(`private-session:${sessionId}`));
  await f.process({ update_id: 99, callback_query: { id: "page", data, from: owner,
    message: { chat, ephemeral_message_id: session.messageId, receiver_user: owner } } });
  assert.match(f.calls.filter(c => c.method === "editEphemeralMessageText").at(-1).body.text, /Страница 2\/3/);
  assert.equal(f.calls.filter(c => c.method === "sendMessage").length, 1);
  assert.ok(reports.every(r => r.body.text.length < 3500));
  f.client.call = async method => { if (["sendMessage", "editEphemeralMessageText"].includes(method)) throw Object.assign(new Error("unsupported"), { errorCode: 400 }); };
  await f.click("report");
  assert.equal(f.sent.length, 2);
  assert.match(f.answers.at(-1)[1], /Не удалось обновить персональную страницу/);
});

test("manual close and 24-hour expiry retain final counter and forbid new reads", async () => {
  const f = await fixture();
  await f.click("read", 43);
  await f.click("close");
  await f.click("read", 44, now + 1000);
  assert.equal((await f.store.first("SELECT COUNT(confirmed_at) AS n FROM announcement_audience")).n, 1);
  assert.match(f.calls.filter(c => c.method === "editMessageReplyMarkup").at(-1).body.reply_markup.inline_keyboard[0][0].text, /Итог · 1\/3/);
  const g = await fixture();
  await recoverAcknowledgements({ store: g.store, client: g.client, chatId: chat.id, now: now + 86_400_001 });
  await g.click("read", 43, now + 86_400_002);
  assert.equal((await g.store.first("SELECT COUNT(confirmed_at) AS n FROM announcement_audience")).n, 0);
  assert.ok((await g.store.first("SELECT closed_at FROM announcement_ack")).closed_at);
});

test("reminder waits ten minutes, confirms once, excludes fresh reads and departures", async () => {
  const f = await fixture();
  await f.click("remind", 42, now + 599_999);
  assert.equal(await f.store.first("SELECT * FROM announcement_reminders"), null);
  await f.click("remind", 42, now + 600_000);
  const reminder = await f.store.first("SELECT * FROM announcement_reminders");
  assert.match(f.sent.at(-1).text, /3/);
  await f.click("read", 43, now + 600_001);
  await f.store.observe(chat.id, { id: 44, first_name: "Departed" }, false, now + 600_002, true);
  await Promise.all([f.click("send", 42, now + 600_003, reminder.id, reminder.prompt_id), f.click("send", 42, now + 600_003, reminder.id, reminder.prompt_id)]);
  const last = f.sent.at(-1);
  assert.match(last.text, /Пожалуйста, подтвердите ознакомление/);
  assert.match(last.text, /id=45/);
  assert.ok(!last.text.includes("id=43") && !last.text.includes("id=44"));
  assert.equal(last.options.replyToMessageId, 5);
  assert.equal((await f.store.first("SELECT status FROM announcement_reminders")).status, "sent");
  const sentCount = f.sent.length;
  await f.click("remind", 42, now + 700_000);
  assert.equal(f.sent.length, sentCount);
});

test("reminder cancellation, author binding, expiry and empty fresh audience", async () => {
  const f = await fixture(1);
  await f.click("remind", 42, now + 600_000);
  let reminder = await f.store.first("SELECT * FROM announcement_reminders");
  await f.click("send", 900000002, now + 600_001, reminder.id, reminder.prompt_id);
  assert.equal((await f.store.first("SELECT status FROM announcement_reminders")).status, "pending");
  await f.click("cancel", 42, now + 600_002, reminder.id, reminder.prompt_id);
  await f.click("remind", 42, now + 600_003);
  reminder = await f.store.first("SELECT * FROM announcement_reminders");
  await recoverAcknowledgements({ store: f.store, client: f.client, chatId: chat.id, now: now + 900_004 });
  assert.equal((await f.store.first("SELECT status FROM announcement_reminders")).status, "expired");
  await f.click("remind", 42, now + 900_005);
  reminder = await f.store.first("SELECT * FROM announcement_reminders");
  await f.click("read", 43, now + 900_006);
  const sentCount = f.sent.length;
  await f.click("send", 42, now + 900_007, reminder.id, reminder.prompt_id);
  assert.equal(f.sent.length, sentCount);
  assert.equal((await f.store.first("SELECT status FROM announcement_reminders")).status, "empty");
});

test("uncertain reminder persists before send and never retries; dirty view repairs on restart", async () => {
  const f = await fixture();
  await f.click("remind", 42, now + 600_000);
  const reminder = await f.store.first("SELECT * FROM announcement_reminders");
  f.client.sendMessage = async () => {
    assert.equal((await f.store.first("SELECT status FROM announcement_reminder_parts")).status, "sending");
    throw new Error("ambiguous timeout");
  };
  await f.click("send", 42, now + 600_001, reminder.id, reminder.prompt_id);
  assert.equal((await f.store.first("SELECT status FROM announcement_reminders")).status, "uncertain");
  f.client.sendMessage = async () => assert.fail("must not resend");
  await f.store.run("UPDATE announcement_ack SET version=version+1");
  await recoverAcknowledgements({ store: f.store, client: f.client, chatId: chat.id, now: now + 800_000 });
  const policy = await f.store.first("SELECT * FROM announcement_ack");
  assert.equal(policy.rendered_version, policy.version);
});

test("partial initial delivery counts only successful parts; legacy requests untouched", async () => {
  const f = await fixture(60);
  assert.equal((await f.store.first("SELECT COUNT(*) AS n FROM attention_parts")).n, 2);
  // Simulate second part's ambiguous send: its audience must not be eligible or counted.
  await f.store.run("UPDATE attention_parts SET status='uncertain' WHERE part=1");
  await refreshAcknowledgement({ store: f.store, client: f.client, requestId: f.request.id, now: now + 1000, force: true });
  assert.match(f.calls.filter(c => c.method === "editMessageReplyMarkup").at(-1).body.reply_markup.inline_keyboard[0][0].text, /0\/50/);
  await f.click("read", 99, now + 2000);
  assert.equal((await f.store.first("SELECT COUNT(confirmed_at) AS n FROM announcement_audience")).n, 0);
  await f.store.run("DELETE FROM announcement_ack WHERE request_id=?", f.request.id);
  const editCount = f.calls.length;
  await recoverAttention({ store: f.store, client: f.client, chatId: chat.id, now: now + 3000 });
  assert.equal(f.calls.length, editCount);
});

test("test announcement isolates full acknowledgement/reminder flow to caller", async () => {
  const f = await fixture(3, true);
  assert.equal((await f.store.first("SELECT COUNT(*) AS n FROM announcement_audience")).n, 1);
  assert.equal((await f.store.first("SELECT user_id FROM announcement_audience")).user_id, "42");
  await f.click("remind", 42, now + 600_000);
  const reminder = await f.store.first("SELECT * FROM announcement_reminders");
  await f.click("send", 42, now + 600_001, reminder.id, reminder.prompt_id);
  assert.match(f.sent.at(-1).text, /id=42/);
  assert.ok(!f.sent.at(-1).text.includes("id=43"));
  await f.click("read", 42, now + 600_002);
  assert.equal((await f.store.first("SELECT COUNT(confirmed_at) AS n FROM announcement_audience")).n, 1);
});

test("shared throttle, explicit 429 recovery and abandoned in-flight reminder", async () => {
  const f = await fixture();
  await f.click("remind", 42, now + 600_000);
  const reminder = await f.store.first("SELECT * FROM announcement_reminders");
  await f.store.run("UPDATE attention_requests SET confirmed_at=? WHERE id=?", now + 599_000, f.request.id);
  await f.click("send", 42, now + 600_001, reminder.id, reminder.prompt_id);
  assert.equal((await f.store.first("SELECT status FROM announcement_reminders")).status, "pending");
  let attempts = 0;
  f.client.sendMessage = async () => { if (++attempts === 1) throw Object.assign(new Error("rate"), { errorCode: 429, parameters: { retry_after: 5 } }); return { message_id: 999 }; };
  await f.click("send", 42, now + 660_001, reminder.id, reminder.prompt_id);
  await deliverReminder({ store: f.store, client: f.client, reminderId: reminder.id, now: now + 664_000 });
  assert.equal(attempts, 1);
  await deliverReminder({ store: f.store, client: f.client, reminderId: reminder.id, now: now + 665_002 });
  assert.equal(attempts, 2);
  await f.store.run("UPDATE announcement_reminders SET status='sending'");
  await f.store.run("UPDATE announcement_reminder_parts SET status='sending',updated_at=?", now);
  await recoverAcknowledgements({ store: f.store, client: f.client, chatId: chat.id, now: now + 900_000 });
  assert.equal(attempts, 2);
  assert.equal((await f.store.first("SELECT status FROM announcement_reminders")).status, "uncertain");
});

test("reminder claim also blocks a fresh real /all in the shared minute", async () => {
  const f = await fixture();
  await f.click("remind", 42, now + 600_000);
  const reminder = await f.store.first("SELECT * FROM announcement_reminders");
  await f.click("send", 42, now + 600_001, reminder.id, reminder.prompt_id);
  await f.process({ update_id: 70, message: { message_id: 6, chat, from: owner, text: "!важно second" } }, now + 600_002);
  const second = await f.store.first("SELECT * FROM attention_requests WHERE target_id=6");
  const sentCount = f.sent.length;
  await f.process({ update_id: 71, callback_query: { id: "second", from: owner, data: `attention:confirm:${second.id}`, message: { chat, message_id: second.prompt_id } } }, now + 600_003);
  assert.equal(f.sent.length, sentCount);
  assert.equal((await f.store.first("SELECT status FROM attention_requests WHERE id=?", second.id)).status, "pending");
});

test("real partial delivery failure and restart retain only successful audience", async () => {
  const f = await fixture(60);
  // Prepare another announcement; first part succeeds and the second times out.
  await f.process({ update_id: 80, message: { message_id: 6, chat, from: owner, text: "!важно second" } }, now + 60_001);
  const r = await f.store.first("SELECT * FROM attention_requests WHERE target_id=6");
  let attempts = 0;
  f.client.sendMessage = async () => {
    const state = await f.store.first("SELECT status FROM attention_parts WHERE request_id=? AND part=?", r.id, attempts);
    assert.equal(state.status, "sending");
    if (++attempts === 2) throw new Error("ambiguous timeout");
    return { message_id: 999 };
  };
  await f.process({ update_id: 81, callback_query: { id: "partial", from: owner, data: `attention:confirm:${r.id}`, message: { chat, message_id: r.prompt_id } } }, now + 60_002);
  assert.equal((await f.store.first("SELECT status FROM attention_requests WHERE id=?", r.id)).status, "uncertain");
  const mark = f.calls.filter(c => c.method === "editMessageReplyMarkup" && c.body.message_id === 999).at(-1);
  assert.match(mark.body.reply_markup.inline_keyboard[0][0].text, /0\/50/);
  await recoverAttention({ store: f.store, client: f.client, chatId: chat.id, now: now + 300_000 });
  assert.equal(attempts, 2);
});

test("a read arriving during a counter edit is drained without waiting for Cron", async () => {
  const f = await fixture();
  let injected = false;
  const original = f.client.call;
  f.client.call = async (method, body) => {
    await original(method, body);
    if (method === "editMessageReplyMarkup" && !injected) {
      injected = true;
      await f.store.run("UPDATE announcement_audience SET confirmed_at=? WHERE user_id='43'", now);
      await f.store.run("UPDATE announcement_ack SET version=version+1");
    }
    return true;
  };
  await refreshAcknowledgement({ store: f.store, client: f.client, requestId: f.request.id, now: now + 1000, force: true });
  assert.match(f.calls.filter(c => c.method === "editMessageReplyMarkup").at(-1).body.reply_markup.inline_keyboard[0][0].text, /1\/3/);
  const policy = await f.store.first("SELECT * FROM announcement_ack");
  assert.equal(policy.version, policy.rendered_version);
});
