import test from "node:test";
import assert from "node:assert/strict";
import { personalFixture, sampleSchedule, installSchedules } from "./helpers/personal-fixture.js";
import { beginDataset, stageSchedules, finishDataset, fanoutBatch } from "../src/personal/ingest.js";
import { collectPersonalUpdate, enqueuePersonalUpdate, processPersonalInbox } from "../src/personal/inbox.js";
import { deliverUser, telegramOperation } from "../src/personal/delivery.js";
import { relayPersonalUpdate, pilotAllowed } from "../cloudflare/personal-relay.js";

const now = new Date("2026-11-12T07:00:00+03:00");
const message = (id, text, update_id = 1) => ({ update_id, message: { from: { id }, chat: { id, type: "private" }, text } });
const callback = (id, action, update_id) => ({ update_id, callback_query: { id: `cb${update_id}`, from: { id }, data: `personal:${action}`, message: { message_id: 1, chat: { id, type: "private" } } } });

test("staging is atomic, older generations cannot replace newer; one group's data stays isolated", async t => {
  const f = await personalFixture(); t.after(() => f.close());
  const a = await sampleSchedule(), b = await sampleSchedule("8ТС");
  const input = { id: "b".repeat(64), date: a.date, generation: 2, observations: [{ group: a.group, date: a.date }, { group: b.group, date: b.date }],
    manifest: { [a.canonicalGroup]: a.hash, [b.canonicalGroup]: b.hash } };
  await beginDataset(f.store, input);
  await stageSchedules(f.store, input.id, [a]);
  assert.deepEqual(await f.store.schedules(a.canonicalGroup), []);
  await assert.rejects(finishDataset(f.store, input.id), /Incomplete/u);
  assert.equal((await f.store.all("SELECT * FROM jobs")).length, 0);
  await stageSchedules(f.store, input.id, [b]); await finishDataset(f.store, input.id);
  const older = structuredClone(a); older.hash = "f".repeat(64); older.lessons[0].variants[0].subject = "УСТАРЕВШЕЕ";
  older.timeline.find(e => e.number === 1).variants[0].subject = "УСТАРЕВШЕЕ";
  await installSchedules(f.store, [older], { generation: 1 });
  assert.equal((await f.store.schedules(a.canonicalGroup))[0].hash, a.hash);
  assert.equal((await f.store.schedules(b.canonicalGroup))[0].canonicalGroup, "8ТС");
});

test("onboarding, duplicate webhook, repeat start, language/group change, support once and pause", async t => {
  const f = await personalFixture(); t.after(() => f.close());
  await installSchedules(f.store, [await sampleSchedule(), await sampleSchedule("8ТС")]);
  let n = 0;
  async function input(raw) {
    const u = collectPersonalUpdate(raw); assert.ok(u); await enqueuePersonalUpdate(f.store, u, now.getTime());
    const row = await f.store.first("SELECT * FROM inbox WHERE update_id=?", u.update_id); await processPersonalInbox(f.store, row, now); return u;
  }
  const start = message(100, "/start", ++n); await input(start); await input(start);
  assert.equal((await f.store.all("SELECT * FROM inbox")).length, 1);
  await input(callback(100, "lang:en", ++n)); await input(callback(100, "group:8СА", ++n));
  const user = await f.store.user(100); assert.equal(user.language, "en"); assert.equal(user.group_id, "8СА"); assert.equal(user.support_seen, 1);
  const epoch = user.epoch;
  await input(message(100, "/start", ++n)); assert.equal((await f.store.user(100)).epoch, epoch);
  await input(callback(100, "group:8ТС", ++n)); assert.equal((await f.store.user(100)).epoch, epoch + 1);
  assert.equal((await f.store.user(100)).support_seen, 1);
  await input(callback(100, "toggle:paused", ++n));
  assert.equal((await f.store.user(100)).paused, 1);
  const oldJobs = await f.store.all("SELECT * FROM jobs WHERE kind='card'"); assert.ok(oldJobs.some(j => j.epoch < epoch + 2));
  const client = { call() { throw new Error("Should not send stale jobs"); } };
  // Cancelled jobs do not reach Telegram after changing subscriptions.
  await f.store.run("UPDATE jobs SET status='done' WHERE kind<>'card'");
  for (let i = 0; i < 3; i++) await deliverUser(f.store, client, 100, { now });
  assert.equal((await f.store.all("SELECT * FROM operations")).length, 0);
  assert.equal(collectPersonalUpdate(message(100, "private conversation")), null);
});

test("durable send intent: timeout/restart is uncertain, 429 waits, 403 blocks, safe edit retry", async t => {
  const f = await personalFixture(); t.after(() => f.close()); await f.store.run("INSERT INTO users(user_id) VALUES(100)");
  const user = await f.store.user(100); let calls = 0;
  const timeout = { async call() { calls++; throw new Error("network timeout"); } };
  assert.equal((await telegramOperation(f.store, timeout, user, "send", "sendMessage", { text: "x" }, now.getTime())).uncertain, true);
  assert.equal((await telegramOperation(f.store, timeout, user, "send", "sendMessage", { text: "x" }, now.getTime() + 2000)).uncertain, true);
  assert.equal(calls, 1);
  const limited = { async call() { throw Object.assign(new Error(), { errorCode: 429, apiRejected: true, parameters: { retry_after: 25 } }); } };
  const result = await telegramOperation(f.store, limited, user, "limited", "sendMessage", { text: "x" }, now.getTime() + 3000);
  assert.equal(result.retryAt, now.getTime() + 28000);
  const blocked = { async call() { throw Object.assign(new Error(), { errorCode: 403, apiRejected: true }); } };
  assert.equal((await telegramOperation(f.store, blocked, user, "blocked", "sendMessage", { text: "x" }, now.getTime() + 29000)).blocked, true);
  assert.equal((await f.store.user(100)).blocked, 1);
  const ok = { async call() { calls++; return true; } };
  const retry = await telegramOperation(f.store, timeout, user, "edit", "editMessageText", {}, now.getTime() + 31000);
  assert.ok(retry.retryAt);
  assert.equal((await telegramOperation(f.store, ok, user, "edit", "editMessageText", {}, now.getTime() + 37000)).done, true);
});

test("delivery edits the same card across repeated history toggles without changing pins", async t => {
  const f = await personalFixture(); t.after(() => f.close());
  const s = await sampleSchedule(); await installSchedules(f.store, [s]);
  await f.store.run("INSERT INTO users(user_id,group_id) VALUES(100,'8СА')");
  const user = await f.store.user(100); await f.store.enqueue(user, "card", s.date, { payload: { manual: true, history: true }, due: now.getTime() });
  const calls = [], client = { async call(method, body) { calls.push([method, body]); return method === "sendMessage" ? { message_id: 88 } : true; } };
  let ms = now.getTime();
  async function drain() { for (let i = 0; i < 5; i++) { ms += 2000; await deliverUser(f.store, client, 100, { now: new Date(ms) }); } }
  await drain();
  for (const mode of ["full", "compact", "full"]) {
    await f.store.run("UPDATE cards SET mode=? WHERE user_id=100", mode); await f.store.enqueue(user, "card", s.date, { payload: { manual: true, history: true }, due: ms }); await drain();
  }
  assert.equal(calls.filter(([method]) => method === "sendMessage").length, 1);
  assert.equal(calls.filter(([method]) => method === "editMessageText").length, 3);
  assert.ok(calls.every(([, body]) => !body.message_id || body.message_id === 88));
  assert.equal((await f.store.user(100)).pin_message_id, null);
});

test("pilot routing respects teacher reservations, group updates, owner ID and disabled flag", async () => {
  const routed = [], env = { PERSONAL_ENABLED: "true", PERSONAL_SHARED_SECRET: "test", ADMIN_USER_ID: "100", PERSONAL_PILOT_IDS: "200,300", DB: { prepare() { return { bind() { return this; }, async first() { return { reserved: true }; } }; } },
    PERSONAL: { async fetch(url, options) { routed.push(JSON.parse(options.body)); return new Response("{}"); } } };
  assert.ok(pilotAllowed(env, 100)); assert.ok(!pilotAllowed(env, 999));
  assert.ok(await relayPersonalUpdate(env, message(100, "/student")));
  assert.equal(await relayPersonalUpdate({ ...env, TEACHERS_ENABLED: "true" }, message(200, "/start")), null);
  assert.equal(await relayPersonalUpdate(env, message(999, "/start")), null);
  const group = message(100, "/student"); group.message.chat.type = "group"; assert.equal(await relayPersonalUpdate(env, group), null);
  assert.equal(await relayPersonalUpdate({ ...env, PERSONAL_ENABLED: "false" }, message(100, "/student")), null);
  assert.equal(routed.length, 1); assert.equal(routed[0].action, "start");
});

for (const count of [100, 300, 1500]) test(`mock load ${count}: fanout targets only the changed group; latest subscription wins`, { skip: process.env.RUN_PERSONAL_LOAD_TESTS !== "true" }, async t => {
  const f = await personalFixture(); t.after(() => f.close()); const s = await sampleSchedule(); await installSchedules(f.store, [s]);
  const insert = f.sqlite.prepare("INSERT INTO users(user_id,group_id) VALUES(?,?)");
  f.sqlite.exec("BEGIN"); for (let id = 1; id <= count; id++) insert.run(id, id % 2 ? "8СА" : "8ТС"); f.sqlite.exec("COMMIT");
  for (let i = 0; i < Math.ceil(count / 24) + 1; i++) await fanoutBatch(f.store, now.getTime());
  const jobs = await f.store.all("SELECT * FROM jobs"); assert.equal(jobs.length, Math.ceil(count / 2)); assert.ok(jobs.every(j => j.user_id % 2));
  // Replace outdated work without generating an additional job per user.
  await f.store.enqueue(await f.store.user(1), "card", s.date, { due: now.getTime() });
  assert.equal((await f.store.all("SELECT * FROM jobs")).length, jobs.length);
  const calls = [], client = { async call(method, body) { calls.push({ method, body }); return method === "sendMessage" ? { message_id: 10000 + calls.length } : true; } };
  let ms = now.getTime(), turns = 0;
  while (true) {
    const job = await f.store.first("SELECT * FROM jobs WHERE status='pending' ORDER BY priority,due,id LIMIT 1");
    if (!job) break;
    ms = Math.max(ms + 84, job.due);
    await deliverUser(f.store, client, job.user_id, { now: new Date(ms) });
    assert.ok(++turns < count * 12, "queue must converge");
  }
  const sends = calls.filter(c => c.method === "sendMessage"), pins = calls.filter(c => c.method === "pinChatMessage");
  assert.equal(sends.length, Math.ceil(count / 2)); assert.equal(pins.length, sends.length);
  assert.ok(calls.every(c => c.body.chat_id % 2));
  assert.equal(new Set(sends.map(c => c.body.chat_id)).size, sends.length);
  assert.equal((await f.store.all("SELECT * FROM cards")).length, sends.length);
});

test("quota degradation stops manual work too", async t => {
  const f = await personalFixture(); t.after(() => f.close());
  assert.equal((await f.store.budget(now)).mode, "normal");
  await f.store.run("UPDATE budgets SET rows_written=23000"); assert.equal((await f.store.budget(now)).mode, "saving");
  await f.store.run("UPDATE budgets SET rows_written=29000"); assert.equal((await f.store.budget(now)).mode, "stopped");
  await f.store.run("INSERT INTO users(user_id) VALUES(100)"); const u = await f.store.user(100);
  await f.store.enqueue(u, "reply", "manual", { due: now.getTime(), priority: 0, payload: { manual: true, text: "status" } });
  const calls = []; await deliverUser(f.store, { async call(method) { calls.push(method); return { message_id: 1 }; } }, 100, { mode: "stopped", now });
  assert.deepEqual(calls, []);
});

test("empty catalog groups do not delay the subscribed group, and a returning blocked user catches up", async t => {
  const f = await personalFixture(); t.after(() => f.close());
  const a = await sampleSchedule("1А"), b = await sampleSchedule("2Б"), c = await sampleSchedule("8Са");
  await installSchedules(f.store, [a, b, c]);
  await f.store.run("INSERT INTO users(user_id,group_id) VALUES(100,'8СА')");
  await fanoutBatch(f.store, now.getTime());
  assert.equal((await f.store.all("SELECT * FROM jobs WHERE user_id=100")).length, 1);
  assert.equal((await f.store.first("SELECT count(*) n FROM fanout WHERE status='pending'")).n, 0);
  await f.store.run("UPDATE users SET blocked=1,next_due=NULL WHERE user_id=100");
  await f.store.run("UPDATE jobs SET status='blocked'");
  const u = collectPersonalUpdate(message(100, "/start", 900)); await enqueuePersonalUpdate(f.store, u);
  await processPersonalInbox(f.store, await f.store.first("SELECT * FROM inbox WHERE update_id=900"), now);
  assert.equal((await f.store.user(100)).blocked, 0);
  assert.equal((await f.store.first("SELECT count(*) n FROM jobs WHERE kind='card' AND status='pending'")).n, 1);
});

test("finished manual work cannot permanently promote later background jobs or retain an old deadline", async t => {
  const f = await personalFixture(); t.after(() => f.close()); await f.store.run("INSERT INTO users(user_id) VALUES(100)");
  const user = await f.store.user(100);
  await f.store.enqueue(user, "card", "2026-11-12", { priority: 0, due: 1000, payload: { manual: true } });
  await f.store.run("UPDATE jobs SET status='done'");
  await f.store.enqueue(user, "card", "2026-11-12", { priority: 3, due: 5000 });
  const job = await f.store.first("SELECT * FROM jobs"); assert.equal(job.priority, 3); assert.equal(job.due, 5000);
});
