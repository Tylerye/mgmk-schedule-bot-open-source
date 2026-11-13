import { maintenanceHeaders } from "../cloudflare/maintenance-auth.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { D1StateStore, patchHealth } from "../cloudflare/d1-store.js";
import { addDays, dateInTimezone } from "../src/dates.js";

const bundle = await build({ entryPoints: ["cloudflare/worker.js"], bundle: true, write: false,
  format: "esm", platform: "node", external: ["node:crypto"] });
const { default: worker, discoverCandidates, dispatchMaintenance, nextLiveReconcileAt } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const today = dateInTimezone(new Date(), "Europe/Minsk");
const tomorrow = addDays(today, 1);
const fileId = "abcdefghijklmnopqrstuv";
const filename = date => `${date.slice(8)}.${date.slice(5, 7)}.${date.slice(2, 4)} учащихся.pdf`;
const logger = { info() {}, warn() {}, error() {} };

async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["0001_initial.sql", "0002_webhook_inbox.sql", "0003_parser_results.sql"]) {
    sqlite.exec(await readFile(`migrations/${file}`, "utf8"));
  }
  const db = { prepare(sql) {
    const statement = sqlite.prepare(sql);
    let params = [];
    return { bind(...values) { params = values; return this; },
      async run() { return { meta: statement.run(...params) }; },
      async first() { return statement.get(...params) ?? null; },
      async all() { return { results: statement.all(...params) }; } };
  } };
  const store = new D1StateStore(db);
  await store.load();
  store.state.chatId = "-300";
  store.state.schedules[today] = { messageId: 55, messageChatId: "-300", viewMode: "compact",
    publishedScheduleHash: "current", renderHash: "stale", scheduleHash: "current",
    schedule: { date: today, hash: "current", displayGroup: "8-Сба", lessons: [], timeline: [
      { type: "lesson", number: 5, start: "00:00", end: "00:01", subject: "Предмет", rooms: [], teachers: [] },
    ] } };
  store.state.pinnedSchedule = { chatId: "-300", date: today, messageId: 55 };
  await store.save();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
    if (String(url).includes("api.telegram.org")) {
      const result = String(url).endsWith("getChatMember")
        ? { status: "administrator", can_pin_messages: true } : { id: 1, message_id: 99 };
      return new Response(JSON.stringify({ ok: true, result }));
    }
    if (String(url).includes("/drive/folders/")) {
      return new Response(`data-id="${fileId}" data-tooltip="${filename(tomorrow)} PDF"`);
    }
    if (options?.method === "HEAD") return new Response(null, { headers: { "content-length": "123" } });
    assert.ok(String(url).includes("api.github.com"));
    return new Response(null, { status: 204 });
  };
  return { sqlite, db, store, calls,
    env: { DB: db, BOT_TOKEN: "test", DRIVE_FOLDER_ID: "folder", GITHUB_REPOSITORY: "owner/repo", LOG_LEVEL: "error" },
    async lane(lane) {
      const pending = [];
      await db.prepare("DELETE FROM runtime_locks WHERE name LIKE 'maintenance-admission:%'").run();
      const response = await worker.fetch(new Request(`https://worker.audit-fixture.net/internal/maintenance/${lane}`, {
        method: "POST", headers: await maintenanceHeaders({WORKER_PUBLIC_ORIGIN:"https://worker.audit-fixture.net",MAINTENANCE_SIGNING_SECRET:"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"},`/internal/maintenance/${lane}`),
      }), { ...this.env, WORKER_PUBLIC_ORIGIN:"https://worker.audit-fixture.net", MAINTENANCE_SIGNING_SECRET:"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", PARSER_SHARED_SECRET: "test-secret" }, { waitUntil(p) { pending.push(p); } });
      await Promise.all(pending);
      return response;
    },
    async cron(cron) {
      const pending = [];
      await worker.scheduled(cron ? { cron, scheduledTime: Date.parse("2026-11-13T09:00:00+03:00") } : {}, this.env, { waitUntil(p) { pending.push(p); } });
      return Promise.allSettled(pending);
    },
    cleanup() { globalThis.fetch = originalFetch; sqlite.close(); },
  };
}

test("a permanently rejected callback cannot block live edits or tomorrow's discovery", async () => {
  const f = await fixture();
  const successfulFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => String(url).endsWith("answerCallbackQuery")
    ? new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: invalid callback" }), { status: 400 })
    : successfulFetch(url, options);
  try {
    const update = { update_id: 100, callback_query: { id: "bad", data: `schedule:${today}:full`,
      message: { message_id: 55, chat: { id: -300, type: "supergroup" } } } };
    await f.db.prepare("INSERT INTO telegram_inbox VALUES (?, ?, ?)")
      .bind(100, JSON.stringify(update), new Date().toISOString()).run();
    await f.cron();
    assert.ok(f.calls.some(call => call.url.endsWith("editMessageText")), "live view must update");
    assert.equal((await f.db.prepare("SELECT status FROM parse_jobs").first())?.status, "dispatched");
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM telegram_inbox").first()).n, 0);
    assert.ok((await new D1StateStore(f.db).load()).health.lastReconcileSuccessAt);
  } finally { f.cleanup(); }
});

test("a busy Telegram state lease cannot delay source discovery and GitHub dispatch", async () => {
  const f = await fixture();
  try {
    await f.db.prepare("INSERT INTO runtime_locks VALUES ('state', 'interrupted', ?)").bind(Date.now() + 60_000).run();
    await f.cron();
    assert.equal((await f.db.prepare("SELECT status FROM parse_jobs").first())?.status, "dispatched");
    assert.equal(f.calls.some(call => call.url.includes("api.telegram.org")), false);
    assert.equal((await f.db.prepare("SELECT owner FROM runtime_locks WHERE name='state'").first()).owner, "interrupted");
    assert.equal((await new D1StateStore(f.db).load()).schedules[today].messageId, 55);
  } finally { f.cleanup(); }
});

test("a corrupt parser result cannot prevent the remaining minute phases", async () => {
  const f = await fixture();
  try {
    await f.db.prepare("INSERT INTO parse_jobs (id,source_id,schedule_date,fingerprint,source_json,status,created_at,updated_at) VALUES ('bad','bad',?,'bad','{}','dispatched',?,?)")
      .bind(today, new Date().toISOString(), new Date().toISOString()).run();
    await f.db.prepare("INSERT INTO parser_results VALUES ('bad', '{broken', ?)").bind(new Date().toISOString()).run();
    const result = await f.cron();
    assert.equal(result[0].status, "rejected", "the phase failure must remain visible");
    assert.ok(f.calls.some(call => call.url.endsWith("editMessageText")));
    assert.equal((await f.db.prepare("SELECT status FROM parse_jobs WHERE source_id=?").bind(fileId).first())?.status, "dispatched");
    assert.equal((await new D1StateStore(f.db).load()).health.lastError.event, "parser_results");
  } finally { f.cleanup(); }
});

test("one inaccessible PDF cannot suppress a different day's new PDF", async () => {
  const f = await fixture();
  try {
    globalThis.fetch = async (url, options) => {
      if (options?.method === "HEAD") {
        if (String(url).includes("oldoldoldoldoldoldoldold")) throw new Error("old PDF unavailable");
        return new Response(null);
      }
      return new Response(`data-id="oldoldoldoldoldoldoldold" data-tooltip="${filename(today)} PDF" `
        + `data-id="${fileId}" data-tooltip="${filename(tomorrow)} PDF"`);
    };
    const candidates = await discoverCandidates({ driveFolderId: "folder", timezone: "Europe/Minsk", lookaheadDays: 5,
      httpRetries: 1 }, new Date(), logger);
    assert.deepEqual(candidates.map(file => file.scheduleDate), [tomorrow]);
  } finally { f.cleanup(); }
});

test("health patches and a concurrent Telegram snapshot preserve each other's changes", async () => {
  const f = await fixture();
  try {
    const snapshot = new D1StateStore(f.db);
    await snapshot.load();
    await patchHealth(f.db, { lastSourcePollSuccessAt: "2026-10-08T11:00:00Z", lastError: null });
    snapshot.state.schedules[today].viewMode = "full";
    snapshot.state.health.lastReconcileSuccessAt = "2026-10-08T11:01:00Z";
    await snapshot.save();
    const state = await new D1StateStore(f.db).load();
    assert.equal(state.health.lastSourcePollSuccessAt, "2026-10-08T11:00:00Z");
    assert.equal(state.health.lastReconcileSuccessAt, "2026-10-08T11:01:00Z");
    assert.equal(state.schedules[today].viewMode, "full");
    assert.equal(state.schedules[today].messageId, 55);
  } finally { f.cleanup(); }
});

test("health reports stalled live updates even after a successful getMe and source check", async () => {
  const f = await fixture();
  try {
    await patchHealth(f.db, { lastSourcePollSuccessAt: new Date().toISOString(), lastTelegramSuccessAt: new Date().toISOString(),
      lastReconcileSuccessAt: new Date(Date.now() - 10 * 60_000).toISOString(), lastError: null,
      lastQueuesSuccessAt: new Date().toISOString(), lastAttentionSuccessAt: new Date().toISOString() });
    const health = await (await worker.fetch(new Request("https://worker.audit-fixture.net/internal/health", {headers:{authorization:"Bearer health-test"}}), {...f.env,HEALTH_READ_SECRET:"health-test"}, {})).json();
    assert.equal(health.ok, false);
    assert.equal(health.stale, true);
    await patchHealth(f.db, { lastReconcileSuccessAt: new Date().toISOString() });
    assert.equal((await (await worker.fetch(new Request("https://worker.audit-fixture.net/internal/health", {headers:{authorization:"Bearer health-test"}}), {...f.env,HEALTH_READ_SECRET:"health-test"}, {})).json()).ok, true);
  } finally { f.cleanup(); }
});

test("authenticated maintenance requests isolate live rendering from discovery and queues", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.lane("live")).status, 200);
    assert.ok(f.calls.some(call => call.url.endsWith("editMessageText")));
    assert.equal(f.calls.some(call => call.url.includes("drive.google.com")), false);
    assert.equal(f.calls.some(call => call.url.includes("api.github.com")), false);
    f.calls.length = 0;
    assert.equal((await f.lane("source")).status, 200);
    assert.equal(f.calls.some(call => call.url.includes("api.telegram.org")), false);
    assert.equal((await f.db.prepare("SELECT status FROM parse_jobs").first())?.status, "dispatched");
    const config = JSON.parse(await readFile("wrangler.example.jsonc", "utf8"));
    assert.deepEqual(config.triggers.crons, ["* * * * *"]);
    assert.ok(config.compatibility_flags.includes("global_fetch_strictly_public"));
  } finally { f.cleanup(); }
});

test("minute schedule jobs do not initialize locale collation", async () => {
  const f = await fixture();
  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = function () { throw new Error("ICU collation must not run on the minute path"); };
  try {
    for (const lane of ["live", "source"]) {
      assert.equal((await f.lane(lane)).status, 200);
    }
  } finally { String.prototype.localeCompare = original; f.cleanup(); }
});

test("successful source lane does not clear a live lane error", async () => {
  const f = await fixture();
  try {
    await patchHealth(f.db, { liveError: { at: new Date().toISOString(), event: "reconcile", message: "private details" },
      lastReconcileSuccessAt: new Date().toISOString() });
    await f.lane("source");
    const health = await (await worker.fetch(new Request("https://worker.audit-fixture.net/internal/health", {headers:{authorization:"Bearer health-test"}}), {...f.env,HEALTH_READ_SECRET:"health-test"}, {})).json();
    assert.equal(health.ok, false);
    assert.equal(health.lastError.event, "reconcile");
    assert.equal(JSON.stringify(health).includes("private details"), false);
  } finally { f.cleanup(); }
});

test("minute dispatcher starts every bounded lane without database work or blind retries", async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ path: new URL(url).pathname, options });
    return new Response("{}", { status: String(url).endsWith("source") ? 503 : 200 });
  };
  try {
    await assert.rejects(dispatchMaintenance({ WORKER_PUBLIC_ORIGIN:"https://worker.audit-fixture.net", MAINTENANCE_SIGNING_SECRET:"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", PARSER_SHARED_SECRET: "private", LOG_LEVEL: "error",
      DB: { prepare() { assert.fail("dispatcher must not load state"); } } }));
    assert.deepEqual(calls.map(c => c.path).sort(), ["live", "source", "queues", "attention"].map(l => `/internal/maintenance/${l}`).sort());
    assert.ok(calls.every(c => c.options.method === "POST" && c.options.redirect === "manual"
      && !c.options.headers.authorization && !!c.options.headers["x-maintenance-signature"] && c.options.signal));
    calls.length = 0;
    await assert.rejects(dispatchMaintenance({}), /origin/);
    assert.equal(calls.length, 0);
  } finally { globalThis.fetch = original; }
});

test("health-only writes preserve a concurrently changed timetable without shipping the snapshot", async () => {
  const f = await fixture();
  try {
    const snapshot = new D1StateStore(f.db); await snapshot.load();
    f.store.state.schedules[today].viewMode = "full"; await f.store.save();
    snapshot.state.health.lastReconcileSuccessAt = new Date().toISOString(); await snapshot.save();
    const state = await new D1StateStore(f.db).load();
    assert.equal(state.schedules[today].viewMode, "full");
    assert.equal(state.health.lastReconcileSuccessAt, snapshot.state.health.lastReconcileSuccessAt);
  } finally { f.cleanup(); }
});

test("live deadline includes exact lesson ends, Minsk midnight, pin rotation and permission expiry", () => {
  const state = { schedules: { "2026-10-12": { schedule: { date: "2026-10-12", timeline: [
    { end: "09:00" }, { end: "09:10" }, { end: "09:55" },
  ] } } }, pinCapability: { checkedAt: "2026-10-12T05:59:59Z" } };
  const config = { curatorUserId: "900000002", timezone: "Europe/Minsk", pinSwitchTime: "16:00" };
  assert.equal(nextLiveReconcileAt(state, config, new Date("2026-10-12T05:59:59Z")), Date.parse("2026-10-12T06:00:00Z"));
  assert.equal(nextLiveReconcileAt(state, config, new Date("2026-10-12T06:00:00Z")), Date.parse("2026-10-12T06:04:59Z"));
  state.pinCapability.checkedAt = "2026-10-12T12:59:30Z";
  assert.equal(nextLiveReconcileAt(state, config, new Date("2026-10-12T12:59:30Z")), Date.parse("2026-10-12T13:00:00Z"));
  state.pinCapability.checkedAt = "2026-10-12T20:59:30Z";
  assert.equal(nextLiveReconcileAt(state, config, new Date("2026-10-12T20:59:30Z")), Date.parse("2026-10-12T21:00:00Z"));
});

test("quiet live ticks use persisted deadlines but new versions and invalidation force reconciliation", async () => {
  const f = await fixture();
  try {
    await f.lane("live"); f.calls.length = 0;
    await f.lane("live"); assert.equal(f.calls.length, 0);
    f.env.CF_VERSION_METADATA = { id: "new-deployment" };
    await f.lane("live"); assert.ok(f.calls.some(c => c.url.endsWith("getMe")));
    f.calls.length = 0;
    await patchHealth(f.db, { nextLiveReconcileAt: 0 });
    await f.lane("live"); assert.ok(f.calls.some(c => c.url.endsWith("getMe")));
  } finally { f.cleanup(); }
});
