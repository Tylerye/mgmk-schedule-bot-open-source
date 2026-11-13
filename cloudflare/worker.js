import { admitInteractive } from "./ingress-admission.js";
import { credentialOrigin } from "../src/credential-origin.js";
import { maintenanceHeaders, verifyMaintenance } from "./maintenance-auth.js";
import bells from "../config/bells.json" with { type: "json" };
import { addDays, dateInTimezone } from "../src/dates.js";
import { createLogger } from "../src/logger.js";
import { ensureDesiredState } from "../src/reconcile.js";
import { reapplyFutureBellSchedule } from "../src/schedule/reapply-bells.js";
import { hasSourceChanged, inspectDriveFile, listDriveFiles } from "../src/source/drive.js";
import { acknowledgeScheduleCallbacks, isReadOnlyTelegramUpdate, processTelegramUpdates, TelegramClient } from "../src/telegram.js";
import { D1StateStore, patchHealth, withStateLock } from "./d1-store.js";
import { drainParserResults, queueParserResult } from "./parser-results.js";
import { AttentionStore, collectAttentionUpdate } from "../src/attention.js";
import { attentionMaintenance, configuredChat, drainAttentionInbox } from "./attention-runtime.js";
import { readJson, InputError } from "./request-json.js";
import { collectTeacherUpdate, enqueueTeacherUpdate, teacherMaintenance, storeTeacherResult, TEACHER_ACCOUNTS, writeTeacherStatus } from "./teachers.js";
import { discoverTeacherFiles } from "../src/source/teacher-drive.js";
import { relayPersonalUpdate, relayPersonalSource } from "./personal-relay.js";

import { backgroundPolicy } from '../src/background-policy.js';

const healthReadWindows = new WeakMap();

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function configFromEnv(env) {
  return {
    botToken: env.BOT_TOKEN,
    adminUserId: env.ADMIN_USER_ID,
    curatorUserId: env.CURATOR_USER_ID,
    driveFolderId: env.DRIVE_FOLDER_ID,
    groupName: env.GROUP_NAME || "8Са",
    displayGroup: env.DISPLAY_GROUP_NAME || "8-Сба",
    timezone: env.TIMEZONE || "Europe/Minsk",
    pinSwitchTime: env.PIN_SWITCH_TIME || "16:00",
    lookaheadDays: Number(env.LOOKAHEAD_DAYS || 5),
    httpTimeoutMs: 30_000,
    httpRetries: 2,
    bells,
  };
}

function authorized(request, secret) {
  const value = request.headers.get("authorization");
  return Boolean(secret && value === `Bearer ${secret}`);
}

async function discoverCandidates(config, now, logger = createLogger("info")) {
  const today = dateInTimezone(now, config.timezone);
  const end = addDays(today, config.lookaheadDays);
  const listed = (await listDriveFiles(config)).filter(
    (file) => file.audience === "students" && file.scheduleDate >= today && file.scheduleDate <= end,
  );
  const results = await Promise.allSettled(listed.map((file) => inspectDriveFile(file, config)));
  const inspected = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") inspected.push(result.value);
    else logger.warn("source_file_inspection_failed", { sourceId: listed[index].id, error: result.reason.message });
  }
  if (listed.length && !inspected.length) throw new Error("All Drive file inspections failed");
  const byDate = new Map();
  for (const file of inspected) {
    const current = byDate.get(file.scheduleDate);
    if (!current || Date.parse(file.lastModified ?? 0) >= Date.parse(current.lastModified ?? 0)) byDate.set(file.scheduleDate, file);
  }
  return [...byDate.values()].sort((a, b) => a.scheduleDate < b.scheduleDate ? -1 : a.scheduleDate > b.scheduleDate ? 1 : 0);
}

function sourceFingerprint(source) {
  return JSON.stringify([source.id, source.lastModified, source.contentLength, source.etag]);
}

function pruneState(state, config, now) {
  const oldest = addDays(dateInTimezone(now, config.timezone), -14);
  for (const [date] of Object.entries(state.schedules)) {
    if (date < oldest) delete state.schedules[date];
  }
  for (const [id, document] of Object.entries(state.documents)) {
    if (document.scheduleDate && document.scheduleDate < oldest) delete state.documents[id];
  }
}

async function ensureParseJob(database, source, nowIso) {
  const fingerprint = sourceFingerprint(source);
  const id = crypto.randomUUID();
  await database.prepare(
    "INSERT OR IGNORE INTO parse_jobs "
    + "(id, source_id, schedule_date, fingerprint, source_json, status, attempts, created_at, updated_at) "
    + "VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
  ).bind(id, source.id, source.scheduleDate, fingerprint, JSON.stringify(source), nowIso, nowIso).run();
  return database.prepare(
    "SELECT * FROM parse_jobs WHERE source_id = ? AND fingerprint = ?",
  ).bind(source.id, fingerprint).first();
}

async function dispatchJob(env, job) {
  const nowIso = new Date().toISOString();
  const claimed = await env.DB.prepare(
    "UPDATE parse_jobs SET status = 'dispatched', attempts = attempts + 1, dispatched_at = ?, updated_at = ?, error = NULL "
    + "WHERE id = ? AND status = ? AND updated_at = ?",
  ).bind(nowIso, nowIso, job.id, job.status, job.updated_at).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/parse-schedule.yml/dispatches`,
      {
        method: "POST", redirect:"manual",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
          "content-type": "application/json",
          "user-agent": "mgmk-schedule-worker",
          "x-github-api-version": "2026-03-10",
        },
        body: JSON.stringify({ ref: env.GITHUB_REF || "main", inputs: { job_id: job.id } }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (![200, 204].includes(response.status)) throw new Error(`GitHub workflow dispatch failed: HTTP ${response.status}`);
  } catch (error) {
    await env.DB.prepare(
      "UPDATE parse_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'dispatched' AND dispatched_at = ?",
    ).bind(error.message, new Date().toISOString(), job.id, nowIso).run();
    throw error;
  }
}

async function pollSourceAndDispatch(env, store, config, logger, now, candidates) {
  const nowIso = now.toISOString();
  const ready = [];
  const health = { lastSourcePollAt: nowIso, nextSourcePollAt: new Date(now.getTime() + 60_000).toISOString() };
  for (const candidate of candidates) {
    if (!hasSourceChanged(store.state.documents[candidate.id], candidate) && store.state.schedules[candidate.scheduleDate]) continue;
    health.lastSourceChangeAt = nowIso;
    const job = await ensureParseJob(env.DB, candidate, nowIso);
    if (await env.DB.prepare("SELECT 1 FROM parser_results WHERE job_id = ?").bind(job.id).first()) continue;
    const stale = !job.dispatched_at || Date.parse(job.dispatched_at) < now.getTime() - 20 * 60_000;
    const failedRetry = job.status === "failed" && Date.parse(job.updated_at) < now.getTime() - 5 * 60_000;
    if ((job.status === "pending" || (job.status === "dispatched" && stale) || failedRetry) && job.attempts < 5) {
      ready.push(job);
    }
  }
  health.lastSourcePollSuccessAt = new Date().toISOString();
  return { ready, health };
}

function telegramClient(env, logger, budgetMs = 25_000) {
  const client = new TelegramClient({ token: env.BOT_TOKEN, logger, timeoutMs: 8_000,
    abortSignal: AbortSignal.timeout(budgetMs) });
  // A BotFather token's numeric prefix identifies this bot. Calls still verify
  // permissions with getChatMember; no need for an extra getMe every minute.
  const id = /^([1-9]\d*):/.exec(env.BOT_TOKEN ?? "")?.[1];
  if (id && Number.isSafeInteger(Number(id))) client.botId = Number(id);
  return client;
}

function isPermanentTelegramFailure(error) {
  return error.errorCode >= 400 && error.errorCode < 500 && ![408, 429].includes(error.errorCode);
}

async function reconcile(env, store, config, logger, now = new Date()) {
  const client = telegramClient(env, logger);
  if (!client.botId) await client.getMe();
  let result;
  try {
    result = await ensureDesiredState({ client, store, config, logger, now });
  } catch (error) {
    const migrated = error.parameters?.migrate_to_chat_id;
    if (!Number.isSafeInteger(migrated) || migrated >= 0) throw error;
    // Telegram itself authenticates the replacement group. Preserve historical
    // message references: migrated history may have different message IDs.
    store.state.chatId = String(migrated);
    store.state.pinCapability = null;
    await store.save();
    result = await ensureDesiredState({ client, store, config, logger, now });
  }
  store.state.health.lastTelegramSuccessAt = new Date().toISOString();
  store.state.health.lastReconcileSuccessAt = new Date().toISOString();
  await store.save();
  return result;
}

async function handleWebhook(request, env, config, logger, context) {
  if (typeof env.TELEGRAM_WEBHOOK_SECRET !== "string" || !env.TELEGRAM_WEBHOOK_SECRET
    || request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return json({ ok: false }, 403);
  let update = await readJson(request, 256 * 1024);
  if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return json({ ok: false }, 400);
  // This marker is internal routing metadata, never accepted from the network.
  delete update._attention;
  const actor = update.callback_query?.from ?? update.message?.from;
  if (Number.isSafeInteger(actor?.id) && actor.id>0 && !update.message?.new_chat_members && !update.message?.left_chat_member && !await admitInteractive(env, actor.id)) return json({ ok: true, limited: true });
  const ownerPersonal = env.PERSONAL_ENABLED === "true" && String(actor?.id) === String(config.adminUserId);
  if (ownerPersonal) {
    const personal = await relayPersonalUpdate(env, update, TEACHER_ACCOUNTS);
    if (personal) return personal;
  }
  if (env.TEACHERS_ENABLED === "true") {
    const teacherEntry = ownerPersonal && /^\/teacher(?:@\w+)?(?:\s|$)/iu.test(update.message?.text ?? "");
    const teacherInput = teacherEntry ? { ...update, message: { ...update.message, text: "/start" } } : update;
    const teacherUpdate = await collectTeacherUpdate(env.DB, teacherInput, env);
    if (teacherUpdate) {
      if (teacherEntry) teacherUpdate.welcome = false;
      await enqueueTeacherUpdate(env.DB, teacherUpdate);
      context.waitUntil(teacherMaintenance(env, config, logger, teacherUpdate.teacherId)
        .catch(error => logger.warn("teacher_update_deferred", { error: error.message })));
      return json({ ok: true, queued: true });
    }
  }
  if ((update.message?.chat ?? update.callback_query?.message?.chat)?.type === "private") {
    const personal = ownerPersonal ? null : await relayPersonalUpdate(env, update, TEACHER_ACCOUNTS);
    return personal ?? json({ ok: true, ignored: true });
  }
  const chatId = await configuredChat(env.DB);
  const attention = await collectAttentionUpdate({ update, chatId,
    store: new AttentionStore(env.DB), config });
  if (attention) update = attention;
  if (!update._attention) {
    const message = update.message;
    const callback = update.callback_query;
    const chat = message?.chat ?? callback?.message?.chat;
    if (!["group", "supergroup"].includes(chat?.type)) return json({ ok: true, ignored: true });
    const command = String(message?.text ?? "").trim().split(/\s+/, 1)[0];
    const commandName = command.split("@", 1)[0].toLowerCase();
    const ownerSetup = commandName === "/setup" && String(message.from?.id) === String(config.adminUserId)
      && Number.isSafeInteger(message.from?.id) && message.from.id > 0 && !message.sender_chat && !message.from.is_bot;
    if (!ownerSetup && (!chatId || String(chat.id) !== String(chatId))) return json({ ok: true, ignored: true });
    if (callback && /^schedule:\d{4}-\d{2}-\d{2}:(compact|full)$/.test(callback.data ?? "")) {
      update = { update_id: update.update_id, callback_query: { id: callback.id, data: callback.data,
        from: callback.from ? { id: callback.from.id } : undefined,
        message: { message_id: callback.message.message_id, chat: { id: chat.id, type: chat.type } } } };
    } else if (message && (ownerSetup || ["/next", "/day", "/today", "/tomorrow", "/latest", "/status"].includes(commandName))) {
      update = { update_id: update.update_id, message: { text: command, message_id: message.message_id,
        from: message.from ? { id: message.from.id } : undefined, chat: { id: chat.id, type: chat.type } } };
    } else return json({ ok: true, ignored: true });
  }
  const duplicate = await env.DB.prepare("SELECT 1 FROM telegram_updates WHERE update_id = ?").bind(update.update_id).first();
  if (duplicate) return json({ ok: true, duplicate: true });
  await env.DB.prepare("INSERT OR IGNORE INTO telegram_inbox (update_id, payload, received_at) VALUES (?, ?, ?)")
    .bind(update.update_id, JSON.stringify(update), new Date().toISOString()).run();
  // Acknowledge only after durable storage, independently of the state lock.
  // Cron retries pending work if this short-lived background task is interrupted.
  context.waitUntil((async () => {
    if (update._attention) {
      await drainAttentionInbox(env, config, logger, update.update_id);
      return;
    }
    if (isReadOnlyTelegramUpdate(update)) {
      await drainReadOnlyInbox(env, config, logger, update.update_id);
      return;
    }
    let acknowledgedCallbacks = new Set();
    try {
      const store = new D1StateStore(env.DB);
      await store.load();
      const client = telegramClient(env, logger);
      acknowledgedCallbacks = await acknowledgeScheduleCallbacks({ client, state: store.state, updates: [update] });
    } catch (error) {
      logger.warn("callback_ack_deferred", { error: error.message });
    }
    await drainInbox(env, config, logger, acknowledgedCallbacks);
  })().catch((error) => logger.warn("inbox_deferred", { error: error.message })));
  return json({ ok: true, queued: true });
}

async function drainReadOnlyInbox(env, config, logger, updateId = null) {
  const rows = updateId === null
    ? await env.DB.prepare("SELECT update_id, payload, received_at FROM telegram_inbox ORDER BY update_id LIMIT 10").all()
    : await env.DB.prepare("SELECT update_id, payload, received_at FROM telegram_inbox WHERE update_id = ?").bind(updateId).all();
  await Promise.all(rows.results.filter(row => isReadOnlyTelegramUpdate(JSON.parse(row.payload))).map(async row => {
    await withStateLock(env.DB, async () => {
      if (await env.DB.prepare("SELECT 1 FROM telegram_updates WHERE update_id = ?").bind(row.update_id).first()) {
        await env.DB.prepare("DELETE FROM telegram_inbox WHERE update_id = ?").bind(row.update_id).run();
        return;
      }
      const store = new D1StateStore(env.DB);
      await store.load();
      // These commands only read a snapshot. Never save it over concurrent Cron
      // or callback changes; webhook delivery is tracked separately in D1.
      await processTelegramUpdates({
        client: telegramClient(env, logger),
        store: { state: store.state, async save() {} }, config,
        updates: [JSON.parse(row.payload)],
        reconcile: async () => { throw new Error("Read-only command cannot reconcile"); },
      });
      await env.DB.prepare("INSERT OR IGNORE INTO telegram_updates (update_id, processed_at) VALUES (?, ?)")
        .bind(row.update_id, new Date().toISOString()).run();
      await env.DB.prepare("DELETE FROM telegram_inbox WHERE update_id = ?").bind(row.update_id).run();
      logger.info("telegram_command_processed", { updateId: row.update_id, latencyMs: Date.now() - Date.parse(row.received_at) });
    }, { name: `command:${row.update_id}` }).catch(async error => {
      logger.warn("telegram_command_deferred", { updateId: row.update_id, error: error.message });
      if (isPermanentTelegramFailure(error)) {
        await env.DB.prepare("INSERT OR IGNORE INTO telegram_updates (update_id, processed_at) VALUES (?, ?)")
          .bind(row.update_id, new Date().toISOString()).run();
        await env.DB.prepare("DELETE FROM telegram_inbox WHERE update_id = ?").bind(row.update_id).run();
      }
    });
  }));
}

async function drainInbox(env, config, logger, acknowledgedCallbacks = new Set()) {
  await drainReadOnlyInbox(env, config, logger);
  // Most minute ticks have no updates. Avoid acquiring a write lock for nothing.
  if (!await env.DB.prepare("SELECT 1 FROM telegram_inbox LIMIT 1").first()) return;
  const result = await withStateLock(env.DB, async () => {
    const deadline = Date.now() + 20_000;
    const rows = await env.DB.prepare(
      "SELECT update_id, payload FROM telegram_inbox "
      + "ORDER BY CASE WHEN json_type(payload, '$.callback_query') IS NOT NULL THEN 0 ELSE 1 END, update_id LIMIT 4",
    ).all();
    for (const row of rows.results) {
      if (Date.now() >= deadline) break;
      const update = JSON.parse(row.payload);
      // An independently running command owns its own update lease, not state.
      if (update._attention || isReadOnlyTelegramUpdate(update)) continue;
      const duplicate = await env.DB.prepare("SELECT 1 FROM telegram_updates WHERE update_id = ?").bind(update.update_id).first();
      if (duplicate) {
        await env.DB.prepare("DELETE FROM telegram_inbox WHERE update_id = ?").bind(update.update_id).run();
        continue;
      }
      const store = new D1StateStore(env.DB);
      await store.load();
      const client = telegramClient(env, logger, Math.max(1, deadline - Date.now()));
      try {
        await processTelegramUpdates({
          client,
          store,
          config,
          updates: [update],
          reconcile: (now) => reconcile(env, store, config, logger, now),
          acknowledgedCallbacks,
        });
      } catch (error) {
        // A failed update cannot poison every future minute tick. Keep transient
        // work durable, but discard explicit permanent Telegram rejections.
        logger.warn("telegram_update_failed", { updateId: update.update_id, error: error.message });
        if (!isPermanentTelegramFailure(error)) continue;
      }
      await env.DB.prepare("INSERT OR IGNORE INTO telegram_updates (update_id, processed_at) VALUES (?, ?)")
        .bind(update.update_id, new Date().toISOString()).run();
      await env.DB.prepare("DELETE FROM telegram_inbox WHERE update_id = ?").bind(update.update_id).run();
    }
  });
  return result;
}

async function handleJobRequest(request, env, pathname, context) {
  if (!authorized(request, env.PARSER_SHARED_SECRET)) return json({ ok: false }, 403);
  const match = /^\/internal\/jobs\/([^/]+)(?:\/(result|failure))?$/.exec(pathname);
  if (!match) return json({ ok: false }, 404);
  const job = await env.DB.prepare("SELECT * FROM parse_jobs WHERE id = ?").bind(match[1]).first();
  if (!job) return json({ ok: false, error: "job not found" }, 404);
  if (request.method === "GET" && !match[2]) {
    return json({ id: job.id, status: job.status, createdAt: job.created_at, personalEnabled: env.PERSONAL_ENABLED === "true", source: JSON.parse(job.source_json) });
  }
  if (request.method !== "POST") return json({ ok: false }, 405);
  if (match[2] === "failure") {
    const body = await readJson(request, 16 * 1024);
    await env.DB.prepare("UPDATE parse_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status != 'complete' AND NOT EXISTS (SELECT 1 FROM parser_results WHERE job_id = parse_jobs.id)")
      .bind(String(body.error ?? "parser failed").slice(0, 500), new Date().toISOString(), job.id).run();
    return json({ ok: true });
  }
  if (match[2] !== "result") return json({ ok: false }, 404);
  if (job.status === "complete") return json({ ok: true, duplicate: true });
  const payload = await readJson(request, 256 * 1024);
  if (JSON.parse(job.source_json).audience === "teachers") {
    if (env.TEACHERS_ENABLED !== "true") return json({ ok: false }, 403);
    if (!await storeTeacherResult(env.DB, job, payload)) return json({ ok: false, error: "teacher result does not match job" }, 400);
    return json({ ok: true });
  }
  if (!await queueParserResult(env.DB, job, payload)) {
    return json({ ok: false, error: "result does not match job" }, 400);
  }
  context.waitUntil((async () => {
    await drainParserResults(env.DB);
    await withStateLock(env.DB, async () => {
      const store = new D1StateStore(env.DB);
      await store.load();
      await reconcile(env, store, configFromEnv(env), createLogger(env.LOG_LEVEL || "info"));
      await store.save();
    });
  })().catch((error) => createLogger(env.LOG_LEVEL || "info").warn("parser_result_deferred", { error: error.message })));
  return json({ ok: true, queued: true }, 202);
}

// One lightweight Cron fans out to independent authenticated HTTP invocations.
const MAINTENANCE_LANES = ["live", "source", "queues", "attention"];
function maintenanceLanes(env) {
  return env.TEACHERS_ENABLED === "true" ? [...MAINTENANCE_LANES, "teacher-source", ...TEACHER_ACCOUNTS.map(t => `teacher-${t.id}`)] : MAINTENANCE_LANES;
}

async function dispatchMaintenance(env) {
  const maintenanceOrigin = credentialOrigin(env.WORKER_PUBLIC_ORIGIN);
  const logger = createLogger(env.LOG_LEVEL || "info");
  // Public HTTP creates independent invocations/CPU budgets. Equivalent Cron
  // expressions were accepted by the API but did not fire independently.
  const lanes = maintenanceLanes(env);
  const results = await Promise.allSettled(lanes.map(async lane => {
    const response = await fetch(`${maintenanceOrigin}/internal/maintenance/${lane}`, {
      method: "POST", headers: await maintenanceHeaders(env, `/internal/maintenance/${lane}`),
      signal: AbortSignal.timeout(55_000), redirect: "manual",
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Maintenance ${lane}: HTTP ${response.status}`);
  }));
  for (const [index, result] of results.entries()) if (result.status === "rejected") {
    logger.error("maintenance_dispatch_failed", { lane: lanes[index], error: result.reason.message });
  }
  logger.info("maintenance_dispatched", { ok: results.every(r => r.status === "fulfilled") });
  if (results.some(r => r.status === "rejected")) throw new Error("One or more maintenance lanes failed");
}

async function handleMaintenance(request, env, pathname, context) {
  if (!await verifyMaintenance(request, env)) return json({ ok: false }, 403);
  const lane = pathname.slice("/internal/maintenance/".length);
  if (!maintenanceLanes(env).includes(lane)) return json({ ok: false }, 404);
  if (request.method !== "POST") return json({ ok: false }, 405);
  const interval = Math.floor(Number(request.headers.get("x-maintenance-time")) / 60000);
  const claimed = await env.DB.prepare("INSERT INTO runtime_locks(name,owner,locked_until) VALUES(?,'maintenance',?) ON CONFLICT(name) DO UPDATE SET locked_until=excluded.locked_until WHERE runtime_locks.locked_until<excluded.locked_until").bind(`maintenance-admission:${lane}`, interval).run();
  if (claimed.meta?.changes !== 1) return json({ ok: true, duplicate: true });
  const task = lane === "teacher-source" ? pollTeacherSource(env, configFromEnv(env), createLogger(env.LOG_LEVEL || "info"))
    : lane.startsWith("teacher-") ? teacherMaintenance(env, configFromEnv(env), createLogger(env.LOG_LEVEL || "info"), lane.slice(8))
    : lane === "attention"
    ? attentionMaintenance(env, configFromEnv(env), createLogger(env.LOG_LEVEL || "info")).then(() =>
      patchHealth(env.DB, { lastAttentionSuccessAt: new Date().toISOString(), attentionError: null }, { heartbeatKey: "lastAttentionSuccessAt" }))
    : scheduled(env, lane);
  // Keep the claimed work alive if the caller disconnects. Never retry an
  // ambiguous dispatch inside the same tick; durable queues resume next minute.
  context.waitUntil(task.catch(() => {}));
  try {
    const result = await task;
    if (lane.startsWith("teacher-") && (result?.acquired || result?.checked)) await writeTeacherStatus(env.DB, `health:${lane}`, { error: false });
    return json({ ok: true });
  }
  catch (error) {
    if (lane.startsWith("teacher-")) await writeTeacherStatus(env.DB, `health:${lane}`, { error: true });
    if (lane === "attention") await patchHealth(env.DB, { attentionError: { at: new Date().toISOString(), event: "attention" } });
    createLogger(env.LOG_LEVEL || "info").error("maintenance_failed", { lane, error: error.message });
    return json({ ok: false }, 503);
  }
}

async function pollTeacherSource(env, config, logger) {
  return withStateLock(env.DB, async () => {
    const files = await discoverTeacherFiles({ config, database: env.DB });
    let dispatched = 0;
    for (const file of files) {
      const document = await env.DB.prepare("SELECT fingerprint FROM teacher_documents WHERE source_id=?").bind(file.id).first();
      if (document?.fingerprint === sourceFingerprint(file)) continue;
      const job = await ensureParseJob(env.DB, file, new Date().toISOString());
      const retryAt = Date.parse(job.updated_at) + (job.status === "failed" ? 300000 : 1200000);
      if ((job.status === "pending" || (["failed", "dispatched"].includes(job.status) && retryAt < Date.now())) && job.attempts < 5 && dispatched < 2) {
        await dispatchJob(env, job);
        dispatched++;
      }
    }
    await writeTeacherStatus(env.DB, "source-health", { files: files.length, dispatched });
    logger.info("teacher_source_complete", { files: files.length, dispatched });
  }, { name: "teacher-source", leaseMs: 180000 });
}

async function scheduled(env, lane = "all") {
  const config = configFromEnv(env);
  const now = new Date();
  const cacheKey = JSON.stringify([env.CF_VERSION_METADATA?.id ?? "local", config.bells, config.pinSwitchTime, config.timezone, config.displayGroup]);
  if (lane === "live") {
    const row = await env.DB.prepare("SELECT json_object('chatId',json_extract(json,'$.chatId'),'health',json_extract(json,'$.health')) AS json FROM app_state WHERE id=1").first();
    const state = row?.json ? JSON.parse(row.json) : null;
    if (state?.chatId && state.health?.liveCacheKey === cacheKey && state.health?.nextLiveReconcileAt > now.getTime()
      && !state.health?.liveError) {
      await patchHealth(env.DB, { lastReconcileSuccessAt: now.toISOString(), lastCronCompletedAt: now.toISOString(), liveError: null }, { heartbeatKey: "lastReconcileSuccessAt", now });
      return;
    }
  }
  const logger = createLogger(env.LOG_LEVEL || "info");
  const errors = [];
  let sourceHealth = {};
  const phase = async (event, task) => {
    try { return await task(); }
    catch (error) {
      errors.push({ event, error });
      logger.error("error", { operation: event, error: error.message });
    }
  };
  // Recovery, Telegram and discovery must all get a turn even when one queue
  // contains a failing update or a malformed parser result.
  if (lane === "live" || lane === "all") {
  if (lane === "all") await phase("parser_results", () => drainParserResults(env.DB));
  const telegram = await phase("reconcile", () => withStateLock(env.DB, async () => {
    const store = new D1StateStore(env.DB);
    await store.load();
    pruneState(store.state, config, new Date());
    reapplyFutureBellSchedule(store.state, config);
    try {
      const renderedAt = new Date();
      await reconcile(env, store, config, logger, renderedAt);
      if (lane === "live") {
        store.state.health.liveCacheKey = cacheKey;
        // If an API call straddles a lesson boundary, leave an expired deadline
        // so the next tick catches up; never skip that boundary until the next.
        store.state.health.nextLiveReconcileAt = nextLiveReconcileAt(store.state, config, renderedAt);
      }
    }
    finally { await store.save(); }
  }));
  if (telegram && !telegram.acquired) logger.warn("reconcile_deferred", { reason: "state_lock_busy" });
  if (lane === "all") await phase("telegram_inbox", () => drainInbox(env, config, logger));
  }
  if (lane === "queues") {
    await phase("parser_results", () => drainParserResults(env.DB));
    await phase("telegram_inbox", () => drainInbox(env, config, logger));
  }

  // The source lease is independent of Telegram's state lease. Discovery and
  // GitHub dispatch continue during a busy or interrupted Telegram invocation.
  if (lane === "source" || lane === "all") {
  const source = await phase("source_poll", () => withStateLock(env.DB, async () => {
    const candidates = await discoverCandidates(config, new Date(), logger);
    // Discovery needs document fingerprints and the existence of dates, not
    // the complete lesson bodies and their published copies.
    const row = await env.DB.prepare("SELECT json_object('documents',json_extract(json,'$.documents'),'dates',"
      + "(SELECT json_group_array(key) FROM json_each(app_state.json,'$.schedules'))) AS json FROM app_state WHERE id=1").first();
    const snapshot = row?.json ? JSON.parse(row.json) : {};
    const store = { state: { documents: snapshot.documents ?? {}, schedules: Object.fromEntries((snapshot.dates ?? []).map(date => [date, true])) } };
    const { ready, health } = await pollSourceAndDispatch(env, store, config, logger, new Date(), candidates);
    for (const job of ready) {
      await phase("github_dispatch", async () => {
        await dispatchJob(env, job);
        logger.info("parse_job_dispatched", { jobId: job.id, date: job.schedule_date, attempt: job.attempts + 1 });
      });
    }
    return health;
  }, { name: "source", leaseMs: 180_000 }));
  if (source?.acquired) sourceHealth = source.value;
  if (source && !source.acquired) logger.warn("source_poll_deferred", { reason: "source_lock_busy" });
  }
  const latest = errors.at(-1);
  const failure = latest ? { at: new Date().toISOString(), event: latest.event, message: latest.error.message } : null;
  await patchHealth(env.DB, {
    ...sourceHealth,
    lastCronCompletedAt: new Date().toISOString(),
    ...(lane === "queues" && !failure ? { lastQueuesSuccessAt: new Date().toISOString() } : {}),
    // One successful lane must not erase another lane's unresolved failure.
    ...(lane === "all" ? { lastError: failure } : { [`${lane}Error`]: failure }),
  }, { heartbeatKey: lane === "source" ? "lastSourcePollSuccessAt" : lane === "queues" ? "lastQueuesSuccessAt" : undefined });
  logger.info("cron_cycle_complete", { lane, ok: errors.length === 0 });
  if (errors.length > 0) throw errors[0].error;
}

function nextLiveReconcileAt(state, config, now) {
  if (config.timezone !== "Europe/Minsk") return now.getTime() + 60_000;
  const today = dateInTimezone(now, config.timezone);
  const deadlines = [Date.parse(`${addDays(today, 1)}T00:00:00+03:00`),
    Date.parse(`${today}T${config.pinSwitchTime}:00+03:00`),
    state.pinCapability?.checkedAt ? Date.parse(state.pinCapability.checkedAt) + 5 * 60_000 : now.getTime() + 60_000];
  for (const record of Object.values(state.schedules)) if (record.schedule.date === today) {
    for (const event of record.schedule.timeline ?? record.schedule.lessons.map(l => ({ end: l.time?.[1] }))) {
      if (event.end) deadlines.push(Date.parse(`${today}T${event.end}:00+03:00`));
    }
  }
  return Math.min(...deadlines.filter(t => Number.isFinite(t) && t > now.getTime()));
}

export default {
  async fetch(request, env, context) {
    try {
    const url = new URL(request.url);
    const config = configFromEnv(env);
    const logger = createLogger(env.LOG_LEVEL || "info");
    if (url.pathname === "/internal/state/import") return json({ ok: false }, 404);
    if (request.method === "GET" && url.pathname === "/healthz") return json({ alive: true });
    if (request.method === "GET" && url.pathname === "/internal/health") {
      if (!authorized(request, env.HEALTH_READ_SECRET)) return json({ ok: false }, 403);
      const now = Date.now();
      const window = healthReadWindows.get(env);
      if (window && now - window.start < 60000 && window.count >= 6) return json({ ok: false }, 429);
      healthReadWindows.set(env, !window || now - window.start >= 60000 ? { start: now, count: 1 } : { ...window, count: window.count + 1 });
      const state = await new D1StateStore(env.DB).load();
      const background = backgroundPolicy(new Date(now));
      const failure = state.health.liveError ?? state.health.sourceError ?? state.health.queuesError ?? state.health.attentionError ?? state.health.lastError;
      const stale = Boolean(state.chatId) && [state.health.lastSourcePollSuccessAt, state.health.lastReconcileSuccessAt,
        state.health.lastQueuesSuccessAt, state.health.lastAttentionSuccessAt]
        .some(value => !value || !Number.isFinite(Date.parse(value)) || now - Date.parse(value) > background.staleAfterMs);
      let teachers;
      if (env.TEACHERS_ENABLED === "true") {
        const rows = (await env.DB.prepare("SELECT key,value FROM teacher_settings WHERE key LIKE 'health:teacher-%'").all()).results;
        const health = Object.fromEntries(rows.map(r => [r.key.slice(7), JSON.parse(r.value)]));
        const lanes = maintenanceLanes(env).filter(l => l.startsWith("teacher-"));
        teachers = { enabled: true, stale: lanes.some(l => !health[l]?.at || health[l]?.error || now - Date.parse(health[l].at) > background.staleAfterMs) };
      }
      let personal;
      if (env.PERSONAL_ENABLED === "true") {
        personal = { enabled: true, ok: false };
        try {
          if (env.PERSONAL && env.PERSONAL_SHARED_SECRET) {
            const response = await env.PERSONAL.fetch("https://personal.internal/health", {
              method: "POST", headers: { authorization: `Bearer ${env.PERSONAL_SHARED_SECRET}` },
            });
            const health = await response.json();
            personal.ok = response.ok && health.ok === true && !health.stopped && !health.deliveryStopped && !health.paused && !health.sourceError;
            personal.degraded = health.degraded === true || health.backgroundPaused === true;
            personal.backgroundPaused = health.backgroundPaused === true;
            personal.dueUsers = health.dueUsers ?? null;
            personal.dueLagSeconds = health.dueLagSeconds ?? null;
            personal.jobLagSeconds = health.jobLagSeconds ?? null;
          }
        } catch { /* Readiness fails without exposing credentials or service errors. */ }
      }
      return json({
        ok: !failure && !stale && !teachers?.stale && personal?.ok !== false && !personal?.degraded,
        degraded: personal?.degraded === true,
        background,
        ...(teachers ? { teachers } : {}),
        ...(personal ? { personal } : {}),
        stale,
        configured: Boolean(state.chatId),
        lastCronCompletedAt: state.health.lastCronCompletedAt,
        lastReconcileSuccessAt: state.health.lastReconcileSuccessAt,
        lastSourcePollSuccessAt: state.health.lastSourcePollSuccessAt,
        lastQueuesSuccessAt: state.health.lastQueuesSuccessAt,
        lastAttentionSuccessAt: state.health.lastAttentionSuccessAt,
        lastParserSuccessAt: state.health.lastParserSuccessAt,
        lastTelegramSuccessAt: state.health.lastTelegramSuccessAt,
        lastError: failure ? { at: failure.at, event: failure.event } : null,
      }, failure || stale || teachers?.stale || personal?.ok === false || personal?.degraded ? 503 : 200);
    }
    if (request.method === "POST" && url.pathname === "/telegram/webhook") return await handleWebhook(request, env, config, logger, context);
    if (url.pathname.startsWith("/internal/personal/")) return await relayPersonalSource(request, env, url.pathname);
    if (url.pathname.startsWith("/internal/maintenance/")) return await handleMaintenance(request, env, url.pathname, context);
    if (url.pathname.startsWith("/internal/jobs/")) return await handleJobRequest(request, env, url.pathname, context);
    return json({ ok: false }, 404);
    } catch (error) {
      if (error instanceof InputError) return json({ ok: false, error: error.message }, error.status);
      throw error;
    }
  },
  async scheduled(controller, env, context) {
    if (controller.cron === "* * * * *") {
      if (backgroundPolicy(new Date(controller.scheduledTime ?? Date.now())).run) context.waitUntil(dispatchMaintenance(env));
      return;
    }
    // Legacy/local explicit invocation; production has exactly one Cron.
    context.waitUntil(scheduled(env, "all"));
    const logger = createLogger(env.LOG_LEVEL || "info");
    context.waitUntil(attentionMaintenance(env, configFromEnv(env), logger)
      .catch(error => logger.warn("attention_maintenance_deferred", { error: error.message })));
  },
};

export { configFromEnv, discoverCandidates, sourceFingerprint, dispatchMaintenance, nextLiveReconcileAt };
