import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { D1StateStore, withStateLock } from "../cloudflare/d1-store.js";

test("D1 lease excludes overlap, recovers expired owners and skips unchanged state writes", async () => {
  const sqlite = new DatabaseSync(":memory:");
  let writes = 0;
  const db = { prepare(sql) {
    const statement = sqlite.prepare(sql);
    let params = [];
    return { bind(...values) { params = values; return this; },
      async run() { writes++; return { meta: statement.run(...params) }; },
      async first() { return statement.get(...params) ?? null; } };
  } };
  try {
    sqlite.exec(await readFile("migrations/0001_initial.sql", "utf8"));
    const first = await withStateLock(db, async () => {
      assert.equal((await withStateLock(db, () => assert.fail("overlap"))).acquired, false);
    });
    assert.equal(first.acquired, true);
    sqlite.exec("UPDATE runtime_locks SET owner='interrupted', locked_until=1");
    assert.equal((await withStateLock(db, async () => {})).acquired, true);
    const store = new D1StateStore(db);
    await store.load();
    store.state.chatId = "-1001";
    await store.save();
    const savedWrites = writes;
    await store.save();
    assert.equal(writes, savedWrites);
    assert.equal((await new D1StateStore(db).load()).chatId, "-1001");
  } finally { sqlite.close(); }
});

test("webhook commands bypass busy state lease without duplicate replies or overwriting state; callbacks stay serialized", async () => {
  const bundle = await build({ entryPoints: ["cloudflare/worker.js"], bundle: true, write: false, format: "esm", platform: "node", external: ["node:crypto"] });
  const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  const sqlite = new DatabaseSync(":memory:");
  const db = { prepare(sql) {
    const statement = sqlite.prepare(sql);
    let params = [];
    return { bind(...values) { params = values; return this; },
      async run() { return { meta: statement.run(...params) }; },
      async first() { return statement.get(...params) ?? null; },
      async all() { return { results: statement.all(...params) }; } };
  } };
  const pending = [];
  const telegramCalls = [];
  const originalFetch = globalThis.fetch;
  try {
    for (const file of ["0001_initial.sql", "0002_webhook_inbox.sql", "0004_attention.sql", "0005_acknowledgements.sql", "0006_recruitments.sql", "0007_event_reminders.sql"]) {
      for (const sql of (await readFile(`migrations/${file}`, "utf8")).split(";").filter(s => s.trim())) await db.prepare(sql).run();
    }
    const store = new D1StateStore(db);
    await store.load();
    store.state.chatId = "-300";
    store.state.schedules["2026-09-15"] = {
      messageId: 55,
      viewMode: "compact",
      schedule: { date: "2026-09-15", displayGroup: "8-Сба", lessons: [], timeline: [
        { type: "lesson", number: 1, start: "08:15", end: "09:00", subject: "Предмет", rooms: [], teachers: [] },
      ] },
    };
    await store.save();
    globalThis.fetch = async (url) => {
      telegramCalls.push(String(url).split("/").at(-1));
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    };
    await db.prepare("INSERT INTO runtime_locks VALUES ('state', 'other', ?)").bind(Date.now() + 60000).run();
    const send = (secret, update) => worker.fetch(new Request("http://localhost/telegram/webhook", {
      method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(update),
    }), { DB: db, BOT_TOKEN: "test", ADMIN_USER_ID: "42", TELEGRAM_WEBHOOK_SECRET: "test-secret" }, { waitUntil(promise) { pending.push(promise); } });
    assert.equal((await send("bad", { update_id: 7 })).status, 403);
    assert.equal((await send("test-secret", {})).status, 400);
    assert.deepEqual(await (await send("test-secret", { update_id: 6, message: { text: "обычный разговор" } })).json(), { ok: true, ignored: true });
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM telegram_inbox").first()).n, 0);
    const update = { update_id: 7, callback_query: {
      id: "callback-7", data: "schedule:2026-09-15:full",
      message: { message_id: 55, chat: { id: -300, type: "supergroup" } },
    } };
    for (let n = 0; n < 3; n++) assert.equal((await send("test-secret", update)).status, 200);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM telegram_inbox").first()).n, 1);
    await Promise.all(pending);
    assert.ok(telegramCalls.includes("answerCallbackQuery"), "callback must be acknowledged even while state lock is busy");
    assert.ok(!telegramCalls.includes("editMessageText"), "message edit must wait for the lock");
    const beforeState = (await db.prepare("SELECT json FROM app_state WHERE id=1").first()).json;
    const commands = ["/status", "/latest", "/today", "/tomorrow", "/next", "/day"];
    for (let index = 0; index < commands.length; index++) {
      const commandUpdate = { update_id: 8 + index, message: {
        text: `${commands[index]}@mgmk_8cba_schedule_bot`, from: { id: 42 }, chat: { id: -300, type: "supergroup" },
      } };
      // Multiple webhook deliveries may race. Only the command's lease owner
      // sends; the occupied global state lease must not delay the reply.
      await Promise.all([send("test-secret", commandUpdate), send("test-secret", commandUpdate)]);
      await Promise.all(pending);
      assert.ok(await db.prepare("SELECT 1 FROM telegram_updates WHERE update_id=?").bind(commandUpdate.update_id).first());
      assert.equal((await db.prepare("SELECT json FROM app_state WHERE id=1").first()).json, beforeState);
      assert.equal((await (await send("test-secret", commandUpdate)).json()).duplicate, true);
    }
    assert.equal(telegramCalls.filter(method => method === "sendMessage").length, commands.length);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM runtime_locks WHERE name LIKE 'command:%'").first()).n, 0);
    assert.ok((await db.prepare("SELECT locked_until FROM runtime_locks WHERE name='state'").first()).locked_until > Date.now());
    await db.prepare("UPDATE runtime_locks SET locked_until=0").run();
    await send("test-secret", update);
    await Promise.all(pending);
    assert.ok(telegramCalls.includes("editMessageText"), "durable callback must eventually edit the message");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM telegram_inbox").first()).n, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM telegram_updates").first()).n, commands.length + 1);
    assert.equal((await (await send("test-secret", update)).json()).duplicate, true);
  } finally { await Promise.all(pending); globalThis.fetch = originalFetch; sqlite.close(); }
});
