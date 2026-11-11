import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { D1StateStore } from "../cloudflare/d1-store.js";
import { drainParserResults, queueParserResult } from "../cloudflare/parser-results.js";
import { dateInTimezone } from "../src/dates.js";

test("parser HTTP result is durable during lock contention, applies once and rejects stale overwrite", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = { prepare(sql) {
    const statement = sqlite.prepare(sql);
    let params = [];
    return {
      bind(...values) { params = values; return this; },
      async run() { return { meta: statement.run(...params) }; },
      async first() { return statement.get(...params) ?? null; },
      async all() { return { results: statement.all(...params) }; },
    };
  } };
  const pending = [];
  try {
    for (const file of ["0001_initial.sql", "0002_webhook_inbox.sql", "0003_parser_results.sql"]) {
      sqlite.exec(await readFile(`migrations/${file}`, "utf8"));
    }
    const bundle = await build({ entryPoints: ["cloudflare/worker.js"], bundle: true, write: false, format: "esm", platform: "node", external: ["node:crypto"] });
    const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
    for (const [id, created] of [["old", "2026-10-01T08:00:00Z"], ["new", "2026-10-01T09:00:00Z"]]) {
      await db.prepare("INSERT INTO parse_jobs (id,source_id,schedule_date,fingerprint,source_json,status,created_at,updated_at) VALUES (?, 'source', '2026-10-02', ?, '{}', 'dispatched', ?, ?)")
        .bind(id, id, created, created).run();
    }
    const store = new D1StateStore(db);
    await store.load();
    store.state.schedules["2026-10-02"] = { messageId: 55, messageChatId: "-1001" };
    await store.save();
    await db.prepare("INSERT INTO runtime_locks VALUES ('state', 'other', ?)").bind(Date.now() + 60000).run();
    const payload = { document: { id: "source" }, schedule: { date: "2026-10-02", hash: "new-hash", lessons: [] } };
    const post = (body) => worker.fetch(new Request("https://worker.example/internal/jobs/new/result", {
      method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify(body),
    }), { DB: db, PARSER_SHARED_SECRET: "secret" }, { waitUntil(promise) { pending.push(promise); } });
    assert.equal((await post({ ...payload, document: { id: "wrong" } })).status, 400);
    for (let i = 0; i < 2; i++) {
      const response = await post(payload);
      assert.equal(response.status, 202);
      assert.equal((await response.json()).queued, true);
    }
    await Promise.all(pending);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM parser_results").first()).n, 1);
    assert.equal((await drainParserResults(db)).acquired, false);
    await db.prepare("UPDATE runtime_locks SET locked_until=0").run();
    assert.equal((await drainParserResults(db)).value, 1);
    const state = await new D1StateStore(db).load();
    assert.equal(state.schedules["2026-10-02"].scheduleHash, "new-hash");
    assert.equal(state.schedules["2026-10-02"].messageId, 55);
    assert.equal((await db.prepare("SELECT status FROM parse_jobs WHERE id='new'").first()).status, "complete");
    assert.equal((await post(payload)).status, 200);
    assert.equal((await drainParserResults(db)).value, 0);
    const oldJob = await db.prepare("SELECT * FROM parse_jobs WHERE id='old'").first();
    await queueParserResult(db, oldJob, { ...payload, schedule: { ...payload.schedule, hash: "old-hash" } });
    await drainParserResults(db);
    assert.equal((await new D1StateStore(db).load()).schedules["2026-10-02"].scheduleHash, "new-hash");
  } finally { await Promise.all(pending); sqlite.close(); }
});

test("minute cron reconciles Telegram before source polling and dispatches without the state lock", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = { prepare(sql) {
    const statement = sqlite.prepare(sql);
    let params = [];
    return { bind(...values) { params = values; return this; },
      async run() { return { meta: statement.run(...params) }; },
      async first() { return statement.get(...params) ?? null; },
      async all() { return { results: statement.all(...params) }; } };
  } };
  const originalFetch = globalThis.fetch;
  const pending = [];
  try {
    for (const file of ["0001_initial.sql", "0002_webhook_inbox.sql", "0003_parser_results.sql"]) sqlite.exec(await readFile(`migrations/${file}`, "utf8"));
    const bundle = await build({ entryPoints: ["cloudflare/worker.js"], bundle: true, write: false, format: "esm", platform: "node", external: ["node:crypto"] });
    const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
    const [year, month, day] = dateInTimezone(new Date(), "Europe/Minsk").split("-");
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push(String(url));
      if (String(url).includes("api.telegram.org")) return new Response(JSON.stringify({ ok: true, result: { id: 1 } }));
      if (String(url).includes("/drive/folders/")) {
        assert.ok(calls[0].includes("getMe"));
        return new Response(`data-id="abcdefghijklmnopqrstuv" data-tooltip="${day}.${month}.${year.slice(-2)} учащихся.pdf PDF"`);
      }
      if (options?.method === "HEAD") return new Response(null, { headers: { "content-length": "123", "last-modified": "Thu, 01 Oct 2026 08:00:00 GMT" } });
      assert.ok(String(url).includes("api.github.com"));
      assert.equal((await db.prepare("SELECT locked_until FROM runtime_locks WHERE name='state'").first()).locked_until, 0);
      return new Response(null, { status: 204 });
    };
    await worker.scheduled({}, { DB: db, BOT_TOKEN: "test", DRIVE_FOLDER_ID: "folder", GITHUB_REPOSITORY: "owner/repo" }, { waitUntil(p) { pending.push(p); } });
    await Promise.all(pending);
    assert.equal((await db.prepare("SELECT status FROM parse_jobs").first()).status, "dispatched");
    assert.ok((await new D1StateStore(db).load()).health.lastSourcePollSuccessAt);
  } finally { await Promise.all(pending); globalThis.fetch = originalFetch; sqlite.close(); }
});
