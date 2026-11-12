import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { AttentionStore, authorizedAnnouncer, collectAttentionUpdate } from "../src/attention.js";
import { sqliteAdapter } from "../src/attention-local.js";
import { announcementLink, openPrivatePages, processPrivatePage } from "../src/private-pages.js";

const now = Date.now(), chatId = "-100900000003", config = { curatorUserId:"900000002", adminUserId: "42" };
async function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(await readFile("migrations/0004_attention.sql", "utf8"));
  const store = new AttentionStore(sqliteAdapter(db));
  const calls = [], answers = [];
  const client = { async call(method, body) { calls.push({ method, body }); return method === "sendMessage" ? { ephemeral_message_id: 77 } : true; },
    async answerCallbackQuery(...args) { answers.push(args); } };
  const publicCallback = { id: "open", from: { id: 42 }, message: { message_id: 10, chat: { id: Number(chatId), type: "supergroup" } } };
  let dataVersion = 0;
  const renderer = async ({ page }) => { page = Math.min(page, 2); return { text: `Page ${page + 1}/3 · version ${dataVersion}`, page, pages: 3 }; };
  const open = () => openPrivatePages({ store, client, callback: publicCallback, kind: "ack", entityId: "entity", chatId, renderer, now });
  const session = async () => JSON.parse(await store.setting(`private-session:${await store.setting("private-view:ack:entity:42")}`));
  const flip = async (page, overrides = {}, time = now) => {
    const s = await session();
    const callback = { id: `page${page}`, from: { id: 42 }, data: `private:${s.id}:${page}`,
      message: { chat: publicCallback.message.chat, ephemeral_message_id: s.messageId, receiver_user: { id: 42 } }, ...overrides };
    await processPrivatePage({ store, client, callback, config, chatId, now: time, authorized: authorizedAnnouncer, renderers: { ack: renderer } });
  };
  return { db, store, client, calls, answers, open, session, flip, publicCallback, renderer, change() { dataVersion++; } };
}

test("arrows edit one ephemeral message, clamp pages, refresh data and reopen without another send", async () => {
  const f = await fixture(); await f.open();
  assert.deepEqual(f.calls[0].body.reply_markup.inline_keyboard[0].map(b => b.text), ["1/3", "➡️"]);
  await f.flip(1); f.change(); await f.flip(2); await f.flip(0); await f.flip(999);
  const edits = f.calls.filter(c => c.method === "editEphemeralMessageText");
  assert.equal(edits.length, 4);
  assert.ok(edits.every(c => c.body.ephemeral_message_id === 77 && c.body.receiver_user_id === 42));
  assert.deepEqual(edits[0].body.reply_markup.inline_keyboard[0].map(b => b.text), ["⬅️", "2/3", "➡️"]);
  assert.match(edits[1].body.text, /version 1/);
  assert.deepEqual(edits.at(-1).body.reply_markup.inline_keyboard[0].map(b => b.text), ["⬅️", "3/3"]);
  await f.open();
  assert.equal(f.calls.filter(c => c.method === "sendMessage").length, 1);
  assert.match(f.calls.at(-1).body.text, /Page 1\/3/);
  assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM attention_settings").all()).includes("version 1"));
});

test("session ownership, receiver, ephemeral ID, group and expiry are checked before editing", async () => {
  const f = await fixture(); await f.open(); const s = await f.session();
  await f.flip(1, { from: { id: 43 } });
  await f.flip(1, { from: { id: 900000002 } });
  await f.flip(1, { message: { ephemeral_message_id: 88, receiver_user: { id: 42 } } });
  await f.flip(1, { message: { message_id: 77 } });
  await f.flip(1, { message: { ephemeral_message_id: 77, receiver_user: { id: 43 } } });
  await f.flip(1, {}, now + 1_800_001);
  await processPrivatePage({ store: f.store, client: f.client, callback: { id: "foreign", from: { id: 42 }, data: `private:${s.id}:1`, message: { ephemeral_message_id: 77 } },
    config, chatId: "-1009", now, authorized: authorizedAnnouncer, renderers: { ack: f.renderer } });
  assert.equal(f.calls.length, 1);
});

test("simultaneous open or edit uses a single reservation and has no public fallback", async () => {
  const f = await fixture(); await Promise.all([f.open(), f.open()]);
  assert.equal(f.calls.length, 1);
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const original = f.client.call;
  f.client.call = async (...args) => { await blocked; return original(...args); };
  const first = f.flip(1);
  await new Promise(resolve => setTimeout(resolve, 10));
  await f.flip(2);
  unblock(); await first;
  assert.equal(f.calls.filter(c => c.method === "editEphemeralMessageText").length, 1);
  assert.equal(f.calls.filter(c => c.method === "sendMessage").length, 1);
});

test("expired Telegram view is not recreated while paging; explicit reopen creates a new private view", async () => {
  const f = await fixture(); await f.open();
  const original = f.client.call;
  f.client.call = async (method, body) => { if (method === "editEphemeralMessageText") throw Object.assign(new Error("gone"), { errorCode: 400, description: "ephemeral message not found" }); return original(method, body); };
  await f.flip(1);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.session()).status, "gone");
  await f.open();
  assert.equal(f.calls.filter(c => c.method === "sendMessage").length, 2);
  assert.ok(f.calls.every(c => c.method !== "sendMessage" || c.body.ephemeral_message_parameters?.receiver_user_id === 42));
});

test("uncertain first send is durable and never blindly duplicated", async () => {
  const f = await fixture(); let attempts = 0;
  f.client.call = async () => { attempts++; throw new Error("network timeout"); };
  await f.open(); await f.open();
  assert.equal(attempts, 1);
  assert.equal((await f.session()).status, "uncertain");
});

test("collector preserves only ephemeral metadata for page callbacks and rejects malformed data", async () => {
  const f = await fixture(); await f.open(); const s = await f.session();
  const raw = { update_id: 5, callback_query: { id: "page", from: { id: 42 }, data: `private:${s.id}:1`,
    message: { message_id: 0, ephemeral_message_id: 77, receiver_user: { id: 42 }, chat: f.publicCallback.message.chat, text: "SECRET REPORT NAMES" } } };
  const clean = await collectAttentionUpdate({ update: raw, chatId, store: f.store, config, now });
  assert.equal(clean.callback_query.message.ephemeral_message_id, 77);
  assert.equal(clean.callback_query.message.receiver_user.id, 42);
  assert.ok(!JSON.stringify(clean).includes("SECRET"));
  for (const data of ["private:bad:1", `private:${s.id}:-1`, `private:${s.id}:1:evil`]) {
    assert.equal(await collectAttentionUpdate({ update: { ...raw, callback_query: { ...raw.callback_query, data } }, chatId, store: f.store, config, now }), null);
  }
});

test("announcement link points at original message and is unavailable for basic groups or invalid IDs", () => {
  assert.equal(announcementLink(chatId, 123), "https://t.me/c/900000003/123");
  for (const [chat, message] of [["-42", 123], ["42", 123], [chatId, 0], [chatId, "123"], ["-100bad", 123]]) assert.equal(announcementLink(chat, message), null);
});
