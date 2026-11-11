import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import fs from "node:fs";
import { EMPTY_STATE } from "../src/state-shape.js";
import { dateInTimezone, addDays } from "../src/dates.js";
import { monthFolderName } from "../src/source/teacher-drive.js";

test("workerd runs nine isolated lanes, durable teacher enrollment and publication without changing group pin", async () => {
  const bundle = await build({ stdin: { contents: `import worker from './cloudflare/worker.js';export default {async fetch(request,env,ctx){if(new URL(request.url).pathname!=='/tick')return worker.fetch(request,env,ctx);const p=[];await worker.scheduled({cron:'* * * * *'},env,{waitUntil(t){p.push(t)}});await Promise.all(p);return new Response('ok')}}`, resolveDir: process.cwd() },
    bundle: true, write: false, format: "esm", platform: "neutral", external: ["node:crypto"] });
  const paths = [], calls = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "teacher-bot", modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-09-14", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"], d1Databases: ["DB"],
    bindings: { TEACHERS_ENABLED: "true", BOT_TOKEN: "123456789:fake", PARSER_SHARED_SECRET: "private", TELEGRAM_WEBHOOK_SECRET: "webhook", LOG_LEVEL: "error",
      DRIVE_FOLDER_ID: "folder", TIMEZONE: "Europe/Minsk", PIN_SWITCH_TIME: "16:00" }, outboundService: async request => {
      const url = new URL(request.url); paths.push(url.pathname);
      if (url.pathname.startsWith("/internal/maintenance/")) return mf.dispatchFetch(request.url, { method: request.method, headers: request.headers });
      if (url.hostname === "api.telegram.org") {
        const body = await request.json(); calls.push({ method: url.pathname.split("/").at(-1), body });
        return new Response(JSON.stringify({ ok: true, result: url.pathname.endsWith("getChatMember") ? { status: "administrator", can_pin_messages: true } : { message_id: 100 + calls.length } }));
      }
      if (url.hostname === "drive.google.com") return new Response('data-id="abcdefghijklmnopqrstuv" data-tooltip="01.01.20 учащихся.pdf PDF"');
      throw Error("Unexpected outbound " + url.hostname);
    } }] }));
  try {
    const db = await mf.getD1Database("DB");
    for (const file of fs.readdirSync("migrations").filter(f => f.endsWith(".sql"))) {
      for (const sql of fs.readFileSync(`migrations/${file}`, "utf8").replace(/--[^\n]*/g, "").split(";").filter(s => s.trim())) await db.prepare(sql).run();
    }
    const state = structuredClone(EMPTY_STATE); state.chatId = "-300";
    await db.prepare("INSERT INTO app_state VALUES(1,?,?)").bind(JSON.stringify(state), new Date().toISOString()).run();
    await db.prepare("INSERT INTO attention_settings(key,value) VALUES('setup:v1:-300','done')").run();
    const today = dateInTimezone(new Date(), "Europe/Minsk");
    for (const month of new Set([addDays(today, -7), today, addDays(today, 5)].map(monthFolderName)))
      await db.prepare("INSERT INTO teacher_settings(key,value) VALUES(?,'month')").bind(`month:${month}`).run();
    assert.equal((await mf.dispatchFetch("http://localhost/tick")).status, 200);
    assert.equal(paths.filter(p => p.startsWith("/internal/maintenance/")).length, 9);
    const health = await (await mf.dispatchFetch("http://localhost/healthz")).json();
    assert.equal(health.ok, true); assert.equal(health.teachers.stale, false);
    const schedule = { teacherId: "teacher-three", date: addDays(today, 1), hash: "a".repeat(64), lessons: [{ number: 2, group: "26Д", start: "09:10", end: "09:55" }], status: "" };
    await db.prepare("INSERT INTO teacher_schedules VALUES(?,?,?,?,?)").bind("teacher-three", schedule.date, schedule.hash, JSON.stringify(schedule), new Date().toISOString()).run();
    const before = JSON.parse((await db.prepare("SELECT json FROM app_state").first()).json).pinnedSchedule;
    const post = update => mf.dispatchFetch("http://localhost/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "webhook" }, body: JSON.stringify(update) });
    const start = { update_id: 1, message: { message_id: 1, text: "/start", chat: { id: 42, type: "private" }, from: { id: 42, username: "example_teacher_three" } } };
    assert.equal((await post(start)).status, 200);
    await mf.dispatchFetch("http://localhost/tick");
    assert.equal((await db.prepare("SELECT user_id FROM teacher_users WHERE teacher_id='teacher-three'").first()).user_id, 42);
    assert.equal(calls.filter(c => c.method === "sendMessage" && c.body.chat_id === 42).length, 2);
    await post(start); await mf.dispatchFetch("http://localhost/tick");
    assert.equal(calls.filter(c => c.method === "sendMessage" && c.body.chat_id === 42).length, 2);
    const random = structuredClone(start); random.update_id = 2; random.message.from = { id: 43, username: "random" }; random.message.chat.id = 43;
    assert.equal((await (await post(random)).json()).ignored, true);
    assert.equal(calls.filter(c => c.body.chat_id === 43).length, 0);
    assert.deepEqual(JSON.parse((await db.prepare("SELECT json FROM app_state").first()).json).pinnedSchedule, before);
  } finally { await mf.dispose(); }
});
