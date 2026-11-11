import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { AttentionStore, collectAttentionUpdate, processAttentionUpdate } from "../src/attention.js";
import { sqliteAdapter } from "../src/attention-local.js";
import { recoverRecruitments, refreshRecruitment } from "../src/recruitments.js";

const now = Date.now(), chat = { id: -1001, type: "supergroup" }, config = { adminUserId: "42" };
const owner = { id: 42, first_name: "Owner" };
async function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const name of ["0004_attention.sql", "0005_acknowledgements.sql", "0006_recruitments.sql"]) db.exec(await readFile(`migrations/${name}`, "utf8"));
  const store = new AttentionStore(sqliteAdapter(db));
  const sent = [], edits = [], calls = [], answers = [];
  const client = {
    async sendMessage(chatId, text, options) { const message_id = 100 + sent.length; sent.push({ chatId, text, options, message_id }); return { message_id }; },
    async editMessage(...args) { edits.push(args); },
    async answerCallbackQuery(...args) { answers.push(args); },
    async getMe() { return { username: "schedule_bot" }; },
    async call(method, body) { calls.push({ method, body }); return method === "getChatMember" ? { status: "member", user: { id: body.user_id, first_name: `<User & ${body.user_id}>` } } : method === "sendMessage" ? { ephemeral_message_id: 500 + calls.length } : true; },
  };
  let seq = 1;
  const process = async (raw, time = now) => {
    const clean = await collectAttentionUpdate({ update: raw, chatId: chat.id, store, config, now: time });
    if (clean) await processAttentionUpdate({ update: clean, chatId: chat.id, store, config, client, now: time });
    return clean;
  };
  const command = (text = "/need 5", extra = {}, time = now) => process({ update_id: seq++, message: {
    message_id: seq, from: owner, chat, text, reply_to_message: { message_id: 5, text: "SECRET TASK" }, ...extra,
  } }, time);
  const click = (r, action, user = 43, time = now, messageId = r.message_id) => process({ update_id: seq++, callback_query: {
    id: `cb${seq}`, from: { id: user, first_name: `User ${user}` }, data: `need:${action}:${r.id}`, message: { message_id: messageId, chat },
  } }, time);
  const latest = () => store.first("SELECT * FROM recruitments ORDER BY rowid DESC LIMIT 1");
  const members = id => store.all("SELECT * FROM recruitment_members WHERE recruitment_id=? AND active=1 ORDER BY sequence", id);
  return { db, store, client, sent, edits, calls, answers, process, command, click, latest, members };
}

test("default five, reply/photo, command suffix, duplicate creation and no task text persisted", async () => {
  const f = await fixture();
  const clean = await f.command("/need@schedule_bot");
  assert.equal(clean.message.need_count, 5);
  assert.ok(!JSON.stringify(clean).includes("SECRET"));
  const r = await f.latest();
  assert.equal(r.capacity, 5);
  assert.equal(f.sent[0].options.replyToMessageId, 5);
  assert.match(f.sent[0].text, /0\/5/);
  assert.ok(f.sent[0].options.replyMarkup.inline_keyboard.flat().every(b => Buffer.byteLength(b.callback_data) <= 64));
  await f.command("/need 3");
  assert.equal(f.sent.length, 1);
  await f.command("/need@another_bot 4", { reply_to_message: { message_id: 8 } });
  assert.equal(f.sent.length, 1);
  await f.command("/need 2", { reply_to_message: { message_id: 9, photo: [{}] }, from: { id: 900000002 } });
  assert.equal(f.sent.length, 2);
  assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM recruitments").all()).includes("SECRET"));
});

test("reject invalid counts and missing reply; only owner and curator can create", async () => {
  const f = await fixture();
  for (const arg of ["0", "31", "-1", "5.5", "05", "5 extra", "oops"]) await f.command(`/need ${arg}`);
  await f.command("/need", { reply_to_message: undefined });
  assert.equal(await f.latest(), null);
  for (const extra of [{ from: { id: 43 } }, { sender_chat: chat }, { from: { id: 42, is_bot: true } },
    { chat: { id: 42, type: "private" } }, { chat: { id: -999, type: "supergroup" } }]) assert.equal(await f.command("/need 5", extra), null);
  await f.command("/need 30");
  assert.equal((await f.latest()).capacity, 30);
});

test("concurrent last-seat joins never exceed capacity; repeats do not reorder", async () => {
  const f = await fixture(); await f.command(); const r = await f.latest();
  await Promise.all(Array.from({ length: 8 }, (_, i) => f.click(r, "join", 43 + i)));
  assert.equal((await f.members(r.id)).length, 5);
  const before = (await f.members(r.id)).map(m => [m.user_id, m.sequence]);
  await Promise.all([f.click(r, "join", Number(before[0][0])), f.click(r, "join", Number(before[0][0]))]);
  assert.deepEqual((await f.members(r.id)).map(m => [m.user_id, m.sequence]), before);
  assert.match(f.edits.at(-1)[2], /5\/5/);
  assert.equal(f.sent.length, 1);
});

test("self-cancellation frees a full roster and rejoin is at the end", async () => {
  const f = await fixture(); await f.command("/need 2"); const r = await f.latest();
  await f.click(r, "join", 43); await f.click(r, "join", 44);
  await f.click(r, "leave", 43); await f.click(r, "leave", 43);
  assert.equal((await f.members(r.id)).length, 1);
  await f.click(r, "join", 45);
  assert.deepEqual((await f.members(r.id)).map(m => m.user_id), ["44", "45"]);
  await f.click(r, "leave", 45); await f.click(r, "join", 43);
  assert.deepEqual((await f.members(r.id)).map(m => m.user_id), ["44", "43"]);
});

test("departure frees seat immediately, late messages do not re-enroll, closed roster stays final", async () => {
  const f = await fixture(); await f.command("/need 1"); const r = await f.latest();
  await f.click(r, "join", 43);
  await f.process({ update_id: 80, chat_member: { chat, date: (now + 1000) / 1000, new_chat_member: { user: { id: 43, first_name: "Left" }, status: "left" } } }, now + 1000);
  assert.equal((await f.members(r.id)).length, 0);
  await f.process({ update_id: 81, message: { message_id: 9, chat, from: { id: 43 }, text: "old message", date: now / 1000 } }, now + 1001);
  await f.click(r, "join", 44, now + 1002);
  await f.click(r, "close", 42, now + 1003);
  await f.process({ update_id: 82, message: { message_id: 10, chat, from: owner, left_chat_member: { id: 44 }, date: (now + 1004) / 1000 } }, now + 1004);
  assert.equal((await f.members(r.id)).length, 1);
});

test("member verification, forged buttons, foreign chat and admin-only operations", async () => {
  const f = await fixture(); await f.command(); const r = await f.latest();
  const original = f.client.call;
  f.client.call = async (method, body) => method === "getChatMember" && body.user_id === 99 ? { status: "left" } : original(method, body);
  await f.click(r, "join", 99);
  await f.click(r, "join", 43, now, 999);
  await f.click(r, "close", 43); await f.click(r, "list", 43);
  assert.equal((await f.latest()).status, "open");
  assert.equal((await f.members(r.id)).length, 0);
  assert.equal(f.calls.filter(c => c.method === "sendMessage").length, 0);
  assert.equal(await f.process({ update_id: 90, callback_query: { id: "foreign", from: owner, data: `need:close:${r.id}`, message: { message_id: r.message_id, chat: { id: -999, type: "supergroup" } } } }), null);
});

test("private list escapes names, paginates and never falls back publicly", async () => {
  const f = await fixture(); await f.command("/need 10"); const r = await f.latest();
  await Promise.all(Array.from({ length: 8 }, (_, i) => f.click(r, "join", 43 + i)));
  await f.click(r, "list", 42); await f.click(r, "list", 900000002); await f.click(r, "list", 42);
  const lists = f.calls.filter(c => c.method === "sendMessage");
  assert.equal(lists[0].body.ephemeral_message_parameters.receiver_user_id, 42);
  assert.equal(lists[1].body.ephemeral_message_parameters.receiver_user_id, 900000002);
  assert.match(lists[0].body.text, /&lt;User &amp;/);
  assert.equal(lists.length, 2);
  const data = lists[0].body.reply_markup.inline_keyboard[0].at(-1).callback_data;
  const session = JSON.parse(await f.store.setting(`private-session:${data.split(":")[1]}`));
  await f.process({ update_id: 100, callback_query: { id: "page", data, from: owner,
    message: { chat, ephemeral_message_id: session.messageId, receiver_user: owner } } });
  assert.match(f.calls.filter(c => c.method === "editEphemeralMessageText").at(-1).body.text, /Страница 2\/2/);
  assert.equal(f.calls.filter(c => c.method === "sendMessage").length, 2);
  f.client.call = async () => { throw Object.assign(new Error("unsupported"), { errorCode: 400 }); };
  await f.click(r, "list", 42);
  assert.equal(f.sent.length, 1);
  assert.match(f.answers.at(-1)[1], /Не удалось обновить персональную страницу/);
});

test("manual closing and 24-hour expiry block joining and cancellation, preserving final roster", async () => {
  const f = await fixture(); await f.command(); const r = await f.latest();
  await f.click(r, "join", 43); await f.click(r, "close", 900000002);
  await f.click(r, "leave", 43); await f.click(r, "join", 44);
  assert.equal((await f.members(r.id)).length, 1);
  assert.match(f.edits.at(-1)[2], /Набор закрыт/);
  assert.equal(f.edits.at(-1)[3].replyMarkup.inline_keyboard.flat().length, 1);
  const g = await fixture(); await g.command(); const expired = await g.latest();
  await g.click(expired, "join", 43, now + 86_400_001);
  await recoverRecruitments({ store: g.store, client: g.client, chatId: chat.id, now: now + 86_400_001 });
  assert.equal((await g.latest()).status, "closed");
  assert.equal((await g.members(expired.id)).length, 0);
});

test("creation outbox: explicit 429 retries, ambiguous timeout and abandoned send never replay", async () => {
  const f = await fixture(); let attempts = 0;
  f.client.sendMessage = async () => { assert.equal((await f.latest()).status, "sending"); if (++attempts === 1) throw Object.assign(new Error("rate"), { errorCode: 429, parameters: { retry_after: 5 } }); return { message_id: 999 }; };
  await f.command();
  await recoverRecruitments({ store: f.store, client: f.client, chatId: chat.id, now: now + 4000 }); assert.equal(attempts, 1);
  await recoverRecruitments({ store: f.store, client: f.client, chatId: chat.id, now: now + 5001 }); assert.equal(attempts, 2);
  const g = await fixture(); g.client.sendMessage = async () => { throw new Error("timeout"); };
  await g.command(); assert.equal((await g.latest()).status, "uncertain");
  g.client.sendMessage = async () => assert.fail("must not replay");
  await recoverRecruitments({ store: g.store, client: g.client, chatId: chat.id, now: now + 400_000 });
  await g.store.run("UPDATE recruitments SET status='sending',updated_at=?", now);
  await recoverRecruitments({ store: g.store, client: g.client, chatId: chat.id, now: now + 400_000 });
  assert.equal((await g.latest()).status, "uncertain");
});

test("restart repairs dirty counters and a click during edit is drained", async () => {
  const f = await fixture(); await f.command(); const r = await f.latest();
  await f.click(r, "join", 43);
  const recoveryTime = Date.now() + 5000;
  await f.store.run("UPDATE recruitments SET rendered_version=-1,render_until=?", now + 1000);
  await recoverRecruitments({ store: f.store, client: f.client, chatId: chat.id, now: recoveryTime });
  assert.equal((await f.latest()).version, (await f.latest()).rendered_version);
  let injected = false;
  const original = f.client.editMessage;
  f.client.editMessage = async (...args) => {
    await original(...args);
    if (!injected) { injected = true; await f.store.run("UPDATE recruitment_members SET active=0"); await f.store.run("UPDATE recruitments SET version=version+1"); }
  };
  await refreshRecruitment({ store: f.store, client: f.client, id: r.id, now: recoveryTime + 2000, force: true });
  assert.match(f.edits.at(-1)[2], /0\/5/);
  assert.equal((await f.latest()).version, (await f.latest()).rendered_version);
});
