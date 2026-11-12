import { PersonalStore } from "../src/personal/store.js";
import { enqueuePersonalUpdate, processPersonalInbox } from "../src/personal/inbox.js";
import { beginDataset, stageSchedules, finishDataset, fanoutBatch, mergeCatalogObservations } from "../src/personal/ingest.js";
import { deliverUser, drainUser, enqueueDue, diagnosticText } from "../src/personal/delivery.js";
import { TelegramClient } from "../src/telegram.js";
import { readJson, InputError } from "../cloudflare/request-json.js";
import { pilotAllowed } from "../cloudflare/personal-relay.js";
import { dateInTimezone } from "../src/dates.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
// Structured, payload-free logging: user text, names, ids and tokens never
// appear here, only event names, paths and timings.
const logger = {
  info(event, data) { console.log(JSON.stringify({ time: new Date().toISOString(), level: "info", event, ...(data ?? {}) })); },
  warn(event, data) { console.log(JSON.stringify({ time: new Date().toISOString(), level: "warn", event, ...(data ?? {}) })); },
  error(event, data) { console.log(JSON.stringify({ time: new Date().toISOString(), level: "error", event, ...(data ?? {}) })); },
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// Last budget mode written to D1: comparing in memory saves a write per request.
let lastBudgetMode = null;

async function internal(env, path) {
  const started = Date.now();
  try {
    const r = await env.SELF.fetch(`https://personal.internal${path}`, { method: "POST", headers: { authorization: `Bearer ${env.PERSONAL_SHARED_SECRET}` }, body: "{}" });
    if (!r.ok) throw new Error(`Personal lane failed: ${r.status}`);
    const body = await r.json();
    // Lane timings are the first thing to look at when a personal reply feels slow.
    logger.info("personal_lane", { path, ms: Date.now() - started });
    return body;
  } catch (error) {
    logger.warn("personal_lane_failed", { path, ms: Date.now() - started, error: error.message });
    throw error;
  }
}
async function kick(env, { inbox = true, delivery = true } = {}) {
  // Bounded orchestration: each inbox/user runs in a separate HTTP invocation
  // with its own CPU budget. A minute Cron resumes after isolate termination.
  // A minute Cron is the coarsest trigger the platform offers, so each run keeps
  // checking once a second while work remains, instead of leaving it to the next
  // minute. The loop exits on the first empty wave.
  for (let wave = 0; wave < 20; wave++) {
    if (inbox) inbox = Boolean((await internal(env, "/tick/inbox")).pending);
    if (delivery) delivery = Boolean((await internal(env, "/tick/delivery")).pending);
    if (!inbox && !delivery) break;
    // Inbox commands may have created delivery work in this wave. The pause is
    // only here to stay under the shared Telegram rate gate, not to pace users.
    delivery = true;
    await wait(1100);
  }
}

export default {
  async fetch(request, env, context) {
    if (!env.PERSONAL_SHARED_SECRET || request.headers.get("authorization") !== `Bearer ${env.PERSONAL_SHARED_SECRET}`) return json({ ok: false }, 403);
    if (request.method !== "POST") return json({ ok: false }, 405);
    const path = new URL(request.url).pathname;
    const paused = env.PERSONAL_DELIVERY_ENABLED === "false";
    if (paused && (path.startsWith("/tick") || path.startsWith("/delivery/") || /^\/inbox\/\d+$/u.test(path))) {
      return json({ ok: true, paused: true, pending: false });
    }
    const store = new PersonalStore(env.DB);
    const now = new Date();
    let started = false;
    try {
      const budget = await store.budget(now, path === "/tick" ? 2 : 1, {
        service: path === "/health",
        router: ["/tick", "/tick/inbox", "/tick/delivery"].includes(path),
        userWork: /^\/(inbox|delivery)\/\d+$/u.test(path),
      }); started = true;
      if (budget.mode === "stopped") return json({ok:true,stopped:true,pending:false});
      if (lastBudgetMode !== budget.mode) {
        const stored = await store.setting("budget-mode");
        if (stored !== budget.mode) await store.setSetting("budget-mode", budget.mode);
        lastBudgetMode = budget.mode;
      }
      if (path === "/tick") {
        const work = await store.first("SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM inbox WHERE status='pending' LIMIT 1)) inbox,"
          + "(SELECT COUNT(*) FROM (SELECT 1 FROM fanout f JOIN datasets d ON d.id=f.dataset_id WHERE f.status='pending' AND d.status='ready' LIMIT 1)) fanout,"
          + "(SELECT COUNT(*) FROM (SELECT 1 FROM users WHERE paused=0 AND blocked=0 AND next_due<=? LIMIT 1)) due,"
          + "(SELECT COUNT(*) FROM (SELECT 1 FROM jobs WHERE status='pending' AND due<=? LIMIT 1)) delivery", now.getTime(), now.getTime());
        const error = await store.setting("source-error");
        const staging = await store.first("SELECT 1 FROM datasets WHERE status='staging' AND generation<? AND date>=? LIMIT 1", now.getTime() - 300000, dateInTimezone(now, "Europe/Minsk"));
        const recovery = await store.setting("recovery", {});
        const recover = Boolean(env.LEGACY && (error || staging) && (recovery.day !== now.toISOString().slice(0, 10) || recovery.count < 3)
          && (!recovery.at || now.getTime() - recovery.at >= 20 * 60000));
        return json({ ok: true, ...work, recover });
      }
      if (path === "/health") {
        const counts = await store.first("SELECT (SELECT COUNT(*) FROM catalog) groups,(SELECT COUNT(*) FROM active_versions) days,(SELECT COUNT(*) FROM users) users");
        const deliveryStopped = budget.rows_written + 100 >= 27900 || budget.rows_read + 2000 >= 948000 || budget.requests + 2 >= 27900;
        return json({ ok: !paused, paused, deliveryStopped, sourceError: Boolean(await store.setting("source-error")), ...counts, budget, diagnostics: await diagnosticText(store, now) });
      }
      if (path === "/inbox") {
        if (budget.mode === "stopped") return json({ ok: true, limited: true });
        const update = await readJson(request, 4096);
        if (!Number.isSafeInteger(update.update_id) || update.update_id < 0 || !Number.isSafeInteger(update.userId) || update.userId <= 0
          || !pilotAllowed(env, update.userId) || typeof update.action !== "string" || update.action.length > 100) return json({ ok: false }, 400);
        // Revalidate the sanitized schema; this endpoint is private and also
        // authenticated independently from the main webhook/parser secret.
        const admitted = await enqueuePersonalUpdate(store, update);
        logger.info("personal_inbox", { updateId: update.update_id, action: update.action, admitted, paused, mode: budget.mode });
        if (!admitted) return json({ ok: true, queued: false });
        if (!paused) {
          // A tap is interactive: handle it and answer inside this request. The
          // durable inbox row and the job stay as the retry path for a refused
          // Telegram call, but nothing waits for a lane or a Cron tick.
          const client = new TelegramClient({ token: env.BOT_TOKEN, logger, timeoutMs: 8000 });
          const actorId = update.callback_query?.from?.id ?? update.message?.from?.id ?? null;
          // Clearing the button spinner is a courtesy, not content: it runs
          // alongside the screen and never sits on the critical path.
          const ack = typeof update.callbackId === "string" && Number.isSafeInteger(actorId) && actorId > 0
            ? client.call("answerCallbackQuery", { callback_query_id: update.callbackId })
                .then(() => store.run("UPDATE jobs SET status='done' WHERE id=? AND status='pending'", `${actorId}:callback:${update.update_id}`))
                .catch(error => logger.warn("personal_ack_skipped", { error: String(error?.description ?? error?.message ?? "unknown").slice(0, 80) }))
            : null;
          const row = await store.first("SELECT * FROM inbox WHERE update_id=? AND status='pending'", update.update_id);
          logger.info("personal_inbox_row", { updateId: update.update_id, found: Boolean(row), actorId });
          if (row && pilotAllowed(env, row.user_id)) await processPersonalInbox(store, row, new Date());
          if (Number.isSafeInteger(actorId) && actorId > 0) {
            await drainUser(store, client, actorId, { mode: budget.mode, ownerId: env.ADMIN_USER_ID, rounds: 3 });
          }
          if (ack) context.waitUntil(ack);
          logger.info("personal_tap", { q: store.queries, ms: store.queryMs, rows: store.read + store.written });
        }
      } else if (path === "/source-status") {
        const body = await readJson(request, 4096);
        return json({ enabled: true, known: await store.setting(`source:${String(body.id).slice(0, 100)}`) });
      } else if (path === "/catalog") await mergeCatalogObservations(store, (await readJson(request, 8192)).observations);
      else if (path === "/begin") await beginDataset(store, await readJson(request, 32768));
      else if (path === "/stage") {
        const body = await readJson(request, 196608); await stageSchedules(store, body.id, body.schedules);
      } else if (path === "/finish") {
        const body = await readJson(request, 4096); await finishDataset(store, body.id); await store.setSetting("source-error", null);
      } else if (path === "/source-error") {
        const body = await readJson(request, 4096);
        const previous = await store.setting("source-error", {});
        await store.setSetting("source-error", { ...(previous ?? {}), at: now.toISOString(),
          ...(body.date && /^\d{4}-\d{2}-\d{2}$/u.test(body.date) ? { date: body.date } : {}),
          ...(Array.isArray(body.groups) ? { groups: body.groups.filter(g => /^\d{1,3}[\p{L}]{1,6}$/u.test(g)).slice(0, 200) } : {}),
          ...(Number.isSafeInteger(body.structuralErrors) ? { structuralErrors: body.structuralErrors } : {}) });
      } else if (path === "/tick/recover") {
        const old = await store.setting("recovery", {}), day = now.toISOString().slice(0, 10);
        if (env.LEGACY && (old.day !== day || old.count < 3) && (!old.at || now.getTime() - old.at >= 20 * 60000)) {
          await store.setSetting("recovery", { day, count: old.day === day ? old.count + 1 : 1, at: now.getTime() });
          await env.LEGACY.fetch("https://legacy.internal/internal/personal/recover", { method: "POST", headers: { authorization: `Bearer ${env.PERSONAL_SHARED_SECRET}` } });
        }
      } else if (path === "/tick/inbox") {
        const row = await store.first("SELECT * FROM inbox WHERE status='pending' ORDER BY update_id LIMIT 1");
        if (row) await internal(env, `/inbox/${row.update_id}`);
        return json({ ok: true, pending: Boolean(row && await store.first("SELECT 1 FROM inbox WHERE status='pending' LIMIT 1")) });
      } else if (/^\/inbox\/\d+$/u.test(path)) {
        const row = await store.first("SELECT * FROM inbox WHERE update_id=? AND status='pending'", Number(path.split("/")[2]));
        if (row && pilotAllowed(env, row.user_id)) await processPersonalInbox(store, row, now);
      } else if (path === "/tick/fanout") { if (budget.mode !== "stopped") await fanoutBatch(store); }
      else if (path === "/tick/due") { if (budget.mode === "normal") await enqueueDue(store); }
      else if (path === "/tick/delivery") {
        const rows = await store.all("SELECT j.user_id FROM (SELECT user_id,priority,due FROM jobs WHERE status='pending' AND due<=? ORDER BY priority,due LIMIT 128) j JOIN users u ON u.user_id=j.user_id WHERE u.blocked=0 GROUP BY j.user_id ORDER BY MIN(u.last_api_at),MIN(j.priority),MIN(j.due) LIMIT 4", now.getTime());
        const users = [...new Set(rows.map(r => r.user_id))].slice(0, 4);
        const results = await Promise.all(users.map(async (id, index) => {
          // Keep independent CPU lanes, but avoid launching all four against
          // the same 84ms Telegram slot. The first user still starts immediately.
          if (index) await wait(index * 100);
          return internal(env, `/delivery/${id}`);
        }));
        const pending = Boolean(await store.first("SELECT 1 FROM jobs WHERE status='pending' AND due<=? LIMIT 1", now.getTime() + 1200));
        return json({ ok: true, pending });
      } else if (/^\/delivery\/\d+$/u.test(path)) {
        const id = Number(path.split("/")[2]);
        if (pilotAllowed(env, id)) {
          const acquired = await deliverUser(store, new TelegramClient({ token: env.BOT_TOKEN, logger, timeoutMs: 8000 }), id,
            { now, mode: budget.mode, ownerId: env.ADMIN_USER_ID });
          logger.info("personal_lane_store", { path, q: store.queries, ms: store.queryMs, rows: store.read + store.written });
          // Report whether this user still has ready work: the tap chain uses it
          // to keep going instead of leaving the next reply to the minute tick.
          const remaining = Boolean(await store.first("SELECT 1 FROM jobs WHERE user_id=? AND status='pending' AND due<=? LIMIT 1", id, Date.now() + 1200));
          if (acquired === false) return json({ ok: true, busy: true, pending: remaining });
          return json({ ok: true, pending: remaining });
        }
      } else return json({ ok: false }, 404);
      return json({ ok: true });
    } catch (error) {
      return json({ ok: false, error: error instanceof InputError ? error.message : "Personal operation failed" }, error instanceof InputError ? error.status : 400);
    } finally {
      // A reservation is already written by `budget()`; flushing only when this
      // invocation did real work keeps a pointless write off the tap path.
      if (started && (store.queries >= 6 || path === "/tick" || path === "/health")) await store.flushBudget(now);
    }
  },
  async scheduled(controller, env, context) {
    context.waitUntil(internal(env, "/tick").then(async work => {
      if (work.recover) await internal(env, "/tick/recover");
      if (work.fanout) await internal(env, "/tick/fanout");
      if (work.due) await internal(env, "/tick/due");
      if (work.inbox || work.delivery || work.due || work.fanout) await kick(env, { inbox: Boolean(work.inbox), delivery: true });
    }).catch(() => {}));
  },
};
