import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { EMPTY_STATE } from "../src/state-shape.js";
import { sampleSchedule } from "./helpers/personal-fixture.js";

test("workerd isolates D1 and authenticated service bindings; staged data is invisible until activation", async () => {
  const bundle = async path => (await build({ entryPoints: [path], bundle: true, write: false, format: "esm", platform: "neutral", external: ["node:crypto"] })).outputFiles[0].text;
  const [legacy, personal] = await Promise.all([bundle("cloudflare/worker.js"), bundle("personal/worker.js")]);
  const base = { modules: true, compatibilityDate: "2026-09-14", compatibilityFlags: ["nodejs_compat"] };
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { ...base, name: "legacy", script: legacy, d1Databases: { DB: "legacy-db" }, serviceBindings: { PERSONAL: "personal" },
      bindings: { PERSONAL_ENABLED: "true", PERSONAL_SHARED_SECRET: "personal-key", PARSER_SHARED_SECRET: "parser-key", TELEGRAM_WEBHOOK_SECRET: "hook", ADMIN_USER_ID: "100", LOG_LEVEL: "error" } },
    { ...base, name: "personal", script: personal, d1Databases: { DB: "personal-db" }, serviceBindings: { SELF: "personal", LEGACY: "legacy" },
      bindings: { PERSONAL_SHARED_SECRET: "personal-key", ADMIN_USER_ID: "100", PERSONAL_DELIVERY_ENABLED: "false" } },
  ] }));
  try {
    const oldDb = await mf.getD1Database("DB", "legacy"), newDb = await mf.getD1Database("DB", "personal");
    for (const file of await readdir("migrations")) {
      if (!file.endsWith(".sql")) continue;
      for (const sql of (await readFile(`migrations/${file}`, "utf8")).replace(/--[^\n]*/gu, "").split(";").filter(s => s.trim())) await oldDb.prepare(sql).run();
    }
    for (const sql of (await readFile("personal/migrations/0001_personal.sql", "utf8")).replace(/--[^\n]*/gu, "").split(";").filter(s => s.trim())) await newDb.prepare(sql).run();
    const original = structuredClone(EMPTY_STATE); original.chatId = "-300"; original.pinnedSchedule = { date: "2026-11-12", messageId: 999, chatId: "-300" };
    const snapshot = JSON.stringify(original);
    await oldDb.prepare("INSERT INTO app_state VALUES(1,?,?)").bind(snapshot, new Date().toISOString()).run();
    const post = (path, body, secret = "parser-key") => mf.dispatchFetch(`http://localhost/internal/personal/${path}`, { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
    assert.equal((await post("health", {}, "bad")).status, 403);
    const s = await sampleSchedule();
    assert.equal((await post("catalog", { observations: [{ group: s.group, date: s.date }] })).status, 200);
    const input = { id: "a".repeat(64), date: s.date, generation: Date.now(), observations: [], manifest: { [s.canonicalGroup]: s.hash } };
    assert.equal((await post("begin", input)).status, 200);
    assert.equal((await post("stage", { id: input.id, schedules: [s] })).status, 200);
    assert.equal((await newDb.prepare("SELECT COUNT(*) count FROM active_versions").first()).count, 0);
    assert.equal((await post("finish", { id: input.id })).status, 200);
    const health = await (await post("health", {})).json();
    assert.equal(health.groups, 1); assert.equal(health.days, 1); assert.equal(health.users, 0);
    const received = await mf.dispatchFetch("http://localhost/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "hook" },
      body: JSON.stringify({ update_id: 99, message: { text: "/start", chat: { id: 100, type: "private" }, from: { id: 100 } } }) });
    assert.equal(received.status, 200);
    assert.equal((await newDb.prepare("SELECT COUNT(*) count FROM inbox WHERE status='pending'").first()).count, 1);
    assert.equal((await newDb.prepare("SELECT COUNT(*) count FROM users").first()).count, 0);
    assert.equal((await oldDb.prepare("SELECT json FROM app_state").first()).json, snapshot);
    assert.equal((await oldDb.prepare("SELECT COUNT(*) count FROM teacher_users").first()).count, 0);
    assert.ok(!(await oldDb.prepare("SELECT 1 FROM sqlite_master WHERE name='datasets'").first()));
  } finally { await mf.dispose(); }
});
