import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { AttentionStore, collectAttentionUpdate, processAttentionUpdate, recoverAttention, mentionChunks, authorizedAnnouncer } from "../src/attention.js";
const CURATOR_USER_ID="900000002";
import { sqliteAdapter } from "../src/attention-local.js";

const config = { curatorUserId: "900000002", adminUserId: "42" };
const chat = { id: -1001, type: "supergroup" };
const owner = { id: 42, first_name: "Owner", is_bot: false };
const now = Date.now();
async function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(await readFile(new URL("../migrations/0004_attention.sql", import.meta.url), "utf8"));
  db.exec(await readFile(new URL("../migrations/0005_acknowledgements.sql", import.meta.url), "utf8"));
  db.exec(await readFile(new URL("../migrations/0006_recruitments.sql", import.meta.url), "utf8"));
  const store = new AttentionStore(sqliteAdapter(db));
  const sent = [], edited = [], answered = [];
  const client = {
    async sendMessage(chatId, text, options) { const result = { message_id: 100 + sent.length }; sent.push({ chatId, text, options }); return result; },
    async editMessage(...args) { edited.push(args); },
    async answerCallbackQuery(...args) { answered.push(args); },
    async getMe() { return { username: "schedule_bot" }; },
    async call() { return { status: "member" }; },
  };
  await store.observe(chat.id, owner, true, now);
  await store.observe(chat.id, { id: 43, first_name: "<Студент & друг>" }, true, now);
  const collect = update => collectAttentionUpdate({ update, chatId: chat.id, store, config, now });
  const process = update => processAttentionUpdate({ update, chatId: chat.id, store, client, config, now });
  return { db, store, sent, edited, answered, client, collect, process };
}
function message(text = "!важно private announcement", extra = {}) {
  return { update_id: 1, message: { message_id: 1, date: now / 1000, chat, from: owner, text, ...extra } };
}
async function confirm(f, request, from = owner, action = "confirm") {
  const raw = { update_id: 2, callback_query: { id: "callback", data: `attention:${action}:${request.id}`, from,
    message: { message_id: request.prompt_id, chat } } };
  await f.process(await f.collect(raw));
}
async function request(f, input = message()) {
  await f.process(await f.collect(input));
  return f.store.first("SELECT * FROM attention_requests ORDER BY rowid DESC LIMIT 1");
}

test("prefix makes confirmation only; announcement text is never persisted", async () => {
  const f = await fixture();
  const sanitized = await f.collect(message());
  assert.ok(!JSON.stringify(sanitized).includes("private announcement"));
  await f.process(sanitized);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /1 человек/);
  assert.equal(f.sent[0].options.replyToMessageId, 1);
  const r = await f.store.first("SELECT * FROM attention_requests");
  await confirm(f, r);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].text, /tg:\/\/user\?id=43/);
  assert.match(f.sent[1].text, /&lt;Студент &amp; друг&gt;/);
  assert.ok(!f.sent[1].text.includes("id=42"));
  assert.equal((await f.store.first("SELECT status FROM attention_requests")).status, "sent");
  assert.equal(f.edited.length, 1);
  await confirm(f, r);
  await f.process(sanitized);
  assert.equal(f.sent.length, 2);
});

test("caption, command mention, reply target and curator work", async () => {
  const f = await fixture();
  const photo = message(undefined, { text: undefined, caption: "!важно Прикреплённое фото", media_group_id: "album1" });
  const r = await request(f, photo);
  assert.equal(r.origin_key, "album:album1");
  await f.process(await f.collect(message(undefined, { text: undefined, caption: "!важно Ещё фото", media_group_id: "album1", message_id: 2 })));
  assert.equal(f.sent.length, 1);
  const g = await fixture();
  const curator = { id: Number(CURATOR_USER_ID), first_name: "Куратор" };
  const next = await request(g, message("/all@schedule_bot", { from: curator, reply_to_message: { message_id: 9, text: "private" } }));
  assert.equal(next.actor_id, CURATOR_USER_ID);
  assert.equal(next.target_id, 9);
  await confirm(g, next, curator);
  assert.equal(g.sent[1].options.replyToMessageId, 9);
});

test("unauthorized, anonymous, private and other group calls are ignored", async () => {
  const f = await fixture();
  for (const raw of [message("!важно hello", { from: { id: 43, first_name: "Student" } }),
    message("!важно hello", { sender_chat: chat }), message("!важно hello", { chat: { id: 42, type: "private" } }),
    message("!важно hello", { chat: { id: -999, type: "supergroup" } })]) assert.equal(await f.collect(raw), null);
  await f.process(await f.collect(message("/all@other_bot", { reply_to_message: { message_id: 2 } })));
  assert.equal(f.sent.length, 0);
});

test("only requesting author can confirm; cancel and expiry do not send mentions", async () => {
  const f = await fixture();
  const r = await request(f);
  await confirm(f, r, { id: Number(CURATOR_USER_ID) });
  await confirm(f, r, { id: 43 });
  assert.equal(f.sent.length, 1);
  await confirm(f, r, owner, "cancel");
  assert.equal((await f.store.first("SELECT status FROM attention_requests")).status, "cancelled");
  const g = await fixture();
  const expired = await request(g);
  await recoverAttention({ store: g.store, client: g.client, chatId: chat.id, now: now + 300_001 });
  assert.equal((await g.store.first("SELECT status FROM attention_requests")).status, "expired");
  await confirm(g, expired);
  assert.equal(g.sent.length, 1);
});

test("test mentions self only, while real announcements are limited once per minute", async () => {
  const f = await fixture();
  const first = await request(f);
  await confirm(f, first);
  const second = await request(f, message("/all", { message_id: 2, reply_to_message: { message_id: 2 } }));
  await confirm(f, second);
  assert.equal(f.sent.length, 3); // two prompts and one real announcement
  const trial = await request(f, message("/all_test", { message_id: 3, reply_to_message: { message_id: 3 } }));
  await confirm(f, trial);
  assert.match(f.sent.at(-1).text, /id=42/);
  assert.ok(!f.sent.at(-1).text.includes("id=43"));
});

test("member metadata, joins, exits and registration; no ordinary text stored", async () => {
  const f = await fixture();
  assert.equal(await f.collect(message("a secret conversation", { from: { id: 45, first_name: "New" } })), null);
  await f.collect({ update_id: 2, chat_member: { chat, date: now / 1000, new_chat_member: { user: { id: 45, first_name: "New" }, status: "left" } } });
  await f.collect(message("old message", { from: { id: 45, first_name: "New" } }));
  assert.equal((await f.store.first("SELECT active FROM attention_members WHERE user_id='45'")).active, 0);
  const join = { update_id: 3, callback_query: { id: "join", data: "attention:join", from: { id: 45, first_name: "New" }, message: { chat, message_id: 88 } } };
  await f.process(await f.collect(join));
  assert.equal((await f.store.first("SELECT active FROM attention_members WHERE user_id='45'")).active, 1);
  assert.equal(f.sent.length, 0);
  assert.equal(f.answered.length, 1);
});

test("restart resumes preparation; uncertain send never retries", async () => {
  const f = await fixture();
  const r = await request(f);
  await f.store.run("UPDATE attention_requests SET status='preparing',confirmed_at=? WHERE id=?", now, r.id);
  f.client.sendMessage = async () => { throw new Error("network timeout"); };
  await recoverAttention({ store: f.store, client: f.client, chatId: chat.id, now });
  assert.equal((await f.store.first("SELECT status FROM attention_requests")).status, "uncertain");
  f.client.sendMessage = async () => assert.fail("must not replay uncertain delivery");
  await recoverAttention({ store: f.store, client: f.client, chatId: chat.id, now: now + 400_000 });
});

test("explicit rate limit retries after wait, crashed in-flight part becomes uncertain", async () => {
  const f = await fixture();
  const r = await request(f);
  let calls = 0;
  f.client.sendMessage = async () => { calls++; if (calls === 1) throw Object.assign(new Error("429"), { errorCode: 429, parameters: { retry_after: 10 } }); return { message_id: 777 }; };
  await confirm(f, r);
  await recoverAttention({ store: f.store, client: f.client, chatId: chat.id, now: now + 5000 });
  assert.equal(calls, 1);
  await recoverAttention({ store: f.store, client: f.client, chatId: chat.id, now: now + 10_001 });
  assert.equal(calls, 2);
  const g = await fixture(); const other = await request(g);
  await g.store.run("UPDATE attention_requests SET status='sending' WHERE id=?", other.id);
  await g.store.run("INSERT INTO attention_parts (request_id,part,text,status,updated_at) VALUES (?,0,'test','sending',?)", other.id, now - 200_000);
  await recoverAttention({ store: g.store, client: g.client, chatId: chat.id, now });
  assert.equal((await g.store.first("SELECT status FROM attention_requests")).status, "uncertain");
  assert.equal(g.sent.length, 1);
});

test("long roster splits safely and each link is real visible text", () => {
  const members = Array.from({ length: 120 }, (_, i) => ({ user_id: String(i + 1), name: "&<>".repeat(25) }));
  const chunks = mentionChunks(members);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(text => text.length <= 3500));
  assert.equal(chunks.join("").match(/tg:\/\/user/g).length, 120);
});

test("announcer permissions fail closed with missing config and malformed IDs", () => {
  for (const id of [undefined, null, "undefined", "", 0, -42, NaN, 1.5, "4e1", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(authorizedAnnouncer(id, {}), false);
  }
  assert.equal(authorizedAnnouncer("42", config), true);
  assert.equal(authorizedAnnouncer(CURATOR_USER_ID, {curatorUserId:CURATOR_USER_ID}), true);
});

test("registration is bound to original button and malformed callback data is ignored", async () => {
  const f = await fixture();
  await f.store.setSetting(`registration:${chat.id}`, "88");
  const raw = { update_id: 3, callback_query: { id: "join", data: "attention:join", from: { id: 45, first_name: "New" }, message: { chat, message_id: 99 } } };
  let checks = 0;
  f.client.call = async () => { checks++; return { status: "member" }; };
  await f.process(await f.collect(raw));
  assert.equal(checks, 0);
  assert.equal(await f.store.first("SELECT 1 FROM attention_members WHERE user_id='45'"), null);
  for (const data of ["attention:join:fake", "attention:confirm:abcd", "attention:cancel:", "attention:confirm:../secret"]) {
    assert.equal(await f.collect({ ...raw, callback_query: { ...raw.callback_query, data } }), null);
  }
  assert.equal(f.sent.length, 0);
});

test("confirmation on a different message cannot trigger mentions", async () => {
  const f = await fixture(); const r = await request(f);
  await confirm(f, { ...r, prompt_id: 999 });
  assert.equal(f.sent.length, 1);
  assert.equal((await f.store.first("SELECT status FROM attention_requests")).status, "pending");
});
