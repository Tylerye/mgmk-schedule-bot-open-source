import { PersonalStore } from "../src/personal/store.js";
import { enqueuePersonalUpdate, processPersonalInbox } from "../src/personal/inbox.js";
import { beginDataset, stageSchedules, finishDataset, fanoutBatch, mergeCatalogObservations, MAX_STAGE_BYTES, MAX_STAGE_SCHEDULES } from "../src/personal/ingest.js";
import { deliverUser, diagnosticText } from "../src/personal/delivery.js";
import { TelegramClient } from "../src/telegram.js";
import { activateWeeklyPlan, weeklySourceStatus } from "../src/personal/weekly-plan.js";
import { readJson, InputError } from "../cloudflare/request-json.js";
import { pilotAllowed } from "../cloudflare/personal-relay.js";
import { dateInTimezone } from "../src/dates.js";
import { manualJobsOnly } from '../src/personal/quota.js';
import { backgroundPolicy } from '../src/background-policy.js';
import { deliveryHealth } from '../src/personal/delivery.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const logger = { info() {}, warn() {}, error() {} }; // Do not log user payloads.
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function internal(env, path) {
  const r = await env.SELF.fetch(`https://personal.internal${path}`, { method: "POST", headers: { authorization: `Bearer ${env.PERSONAL_SHARED_SECRET}` }, body: "{}" });
  if (!r.ok) throw new Error(`Personal lane failed: ${r.status}`);
  return r.json();
}
async function kick(env, { inbox = true, delivery = true, due = false, fanout = false } = {}) {
  // Bounded orchestration: each inbox/user runs in a separate HTTP invocation
  // with its own CPU budget. A minute Cron resumes after isolate termination.
  const deadline = Date.now() + 24000;
  let calls = 0;
  const failedLanes = new Set();
  const run = async path => {
    calls++;
    try {
      const result = await internal(env, path);
      failedLanes.delete(path);
      return result;
    } catch {
      const retry = !failedLanes.has(path);
      if (retry) console.warn(JSON.stringify({ event: "personal_pump_lane_error", lane: path }));
      failedLanes.add(path);
      return { pending: retry };
    }
  };
  // At most four router calls per wave. Preserve the previous 48-call bound
  // but allow more delivery-only waves after fanout/due work has finished.
  while (calls <= 44 && Date.now() < deadline) {
    let nextDue = null;
    let dueAdvanced = false;
    if (fanout) { fanout = Boolean((await run('/fanout')).pending); delivery = true; }
    if (due) {
      const wave = await run('/tick/due');
      due = Boolean(wave.pending);
      dueAdvanced = due && wave.advanced;
      delivery = true;
    }
    if (inbox) inbox = Boolean((await run("/tick/inbox")).pending);
    if (delivery) {
      const result = await run("/tick/delivery");
      delivery = Boolean(result.pending); nextDue = result.nextDue ?? null;
    }
    if (!inbox && !delivery && !due && !fanout) break;
    // Inbox commands may have created delivery work in this wave.
    delivery = true;
    if (nextDue !== null) await wait(Math.max(100, Math.min(1100, nextDue - Date.now())));
    else if (!dueAdvanced) await wait(1100);
  }
}

async function runUserLanes(env, users, path, startedAt) {
  // Keep independent CPU invocations. Pipeline D1/Telegram I/O across
  // recipients while spacing starts and enforcing the durable rate gate.
  const inFlight = new Set();
  let lastStart = 0;
  let failed = 0;
  for (const { user_id: id } of users) {
    if (inFlight.size >= 4) await Promise.race(inFlight);
    if (lastStart && Date.now() - startedAt >= 2200) break;
    if (lastStart) await wait(Math.max(0, 105 - (Date.now() - lastStart)));
    lastStart = Date.now();
    const lane = internal(env, path(id))
      .catch(() => { failed++; }).finally(() => inFlight.delete(lane));
    inFlight.add(lane);
  }
  await Promise.all(inFlight);
  if (failed) console.warn(JSON.stringify({ event: "personal_delivery_lane_error", failed }));
}

async function deliverInteractive(env, id) {
  // Keep CPU-isolated delivery invocations, but service the person who tapped
  // immediately instead of putting them behind four other users and a Cron.
  for (let round = 0; round < 6; round++) {
    const result = await internal(env, `/delivery/${id}`);
    if (!result.pending || result.stopped || result.paused) return;
    const delay = Math.max(100, (result.nextDue ?? Date.now()) - Date.now());
    // Long Telegram retry_after and held leases belong to the durable retry.
    if (delay > 1500 || result.busy) return;
    await wait(delay);
  }
}

async function processInboxRow(store, env, row, now) {
  const acquired = await processPersonalInbox(store, row, now, {
    ownerId: env.ADMIN_USER_ID,
    widgetEnabled: env.PERSONAL_WIDGET_ENABLED === "true",
    brandedMenu: env.PERSONAL_BRANDED_MENU === "true",
  });
  if (acquired?.earlier != null) return { ok:true, busy:true, earlier:acquired.earlier };
  const delivery = acquired !== false && Boolean(await store.first("SELECT 1 FROM jobs WHERE user_id=? AND status='pending' AND json_extract(payload,'$.manual')=1 LIMIT 1", row.user_id));
  return { ok: true, busy: acquired === false, delivery };
}

export default {
  async fetch(request, env, context) {
    if (!env.PERSONAL_SHARED_SECRET || request.headers.get("authorization") !== `Bearer ${env.PERSONAL_SHARED_SECRET}`) return json({ ok: false }, 403);
    if (request.method !== "POST") return json({ ok: false }, 405);
    const url = new URL(request.url);
    const path = url.pathname;
    const paused = env.PERSONAL_DELIVERY_ENABLED === "false";
    if (paused && (path.startsWith("/tick") || path.startsWith("/delivery/") || path.startsWith('/due/') || /^\/inbox\/\d+$/u.test(path))) {
      return json({ ok: true, paused: true, pending: false });
    }
    const store = new PersonalStore(env.DB, env);
    const now = new Date();
    let started = false;
    try {
      if (path === "/week-source-status") return json(await weeklySourceStatus(store));
      const source = ['/source-status', '/catalog', '/begin', '/stage', '/finish', '/source-error', '/week-source', '/tick/recover'].includes(path);
      if (path === "/tick" && await store.accountIdleTick(now))
        return json({ ok: true, inbox: 0, fanout: 0, due: 0, delivery: 0, recover: false });
      const budget = await store.budget(now, path === "/tick" ? 2 : 1, {
        service: path === "/health",
        router: ["/tick", "/tick/inbox", "/tick/delivery", "/tick/due", "/tick/fanout"].includes(path),
        userWork: /^\/(inbox|delivery|due)\/\d+$/u.test(path),
        lane: path === '/health' ? 'service' : (['/tick/fanout', '/tick/due', '/fanout'].includes(path) || path.startsWith('/due/')) ? 'background'
          : source ? 'source' : 'interactive',
      }); started = true;
      if (budget.mode === "stopped") {
        // Uploaders must not mistake an uncommitted source for a successful
        // activation. A bounded Actions retry/recovery will resume it later.
        return json({ok:!source,stopped:true,pending:false}, source ? 503 : 200);
      }

      if (path === "/tick") {
        const work = await store.first("SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM inbox WHERE status='pending' LIMIT 1)) inbox,"
          + "(SELECT COUNT(*) FROM (SELECT 1 FROM fanout f JOIN datasets d ON d.id=f.dataset_id WHERE f.status='pending' AND d.status='ready' LIMIT 1)) fanout,"
          + "(SELECT COUNT(*) FROM (SELECT 1 FROM users WHERE paused=0 AND blocked=0 AND next_due<=? LIMIT 1)) due,"
          + "(SELECT COUNT(*) FROM (SELECT 1 FROM jobs WHERE status='pending' AND due<=?" + manualJobsOnly(budget.mode) + " LIMIT 1)) delivery", now.getTime(), now.getTime());
        if (budget.mode !== 'normal') { work.due = 0; work.fanout = 0; }
        const error = await store.setting("source-error");
        const staging = await store.first("SELECT 1 FROM datasets WHERE status='staging' AND generation<? AND date>=? LIMIT 1", now.getTime() - 300000, dateInTimezone(now, "Europe/Minsk"));
        const recovery = await store.setting("recovery", {});
        const recover = Boolean(budget.rows_written + 200 < store.quota.source && env.LEGACY && (error || staging) && (recovery.day !== now.toISOString().slice(0, 10) || recovery.count < 3)
          && (!recovery.at || now.getTime() - recovery.at >= 20 * 60000));
        return json({ ok: true, ...work, recover });
      }
      if (path === "/health") {
        const counts = await store.first("SELECT (SELECT COUNT(*) FROM catalog) groups,(SELECT COUNT(*) FROM active_versions) days,(SELECT COUNT(*) FROM users) users");
        const deliveryStopped = budget.rows_written + 200 >= store.quota.written - 100 || budget.rows_read + 2000 >= 948000 || budget.requests + 2 >= 27900;
        const delivery = await deliveryHealth(store, now);
        const backgroundPaused = budget.mode !== 'normal';
        return json({ ok: !paused, paused, deliveryStopped, backgroundPaused,
          degraded: backgroundPaused || delivery.late, ...delivery,
          background: backgroundPolicy(now), quota: store.quota, sourceError: Boolean(await store.setting("source-error")), ...counts, budget, diagnostics: await diagnosticText(store, now, delivery) });
      }
      if (path === "/inbox") {
        if (budget.mode === "stopped") return json({ ok: true, limited: true });
        const update = await readJson(request, 4096);
        if (!Number.isSafeInteger(update.update_id) || update.update_id < 0 || !Number.isSafeInteger(update.userId) || update.userId <= 0
          || !pilotAllowed(env, update.userId) || typeof update.action !== "string" || update.action.length > 100) return json({ ok: false }, 400);
        // Revalidate the sanitized schema; this endpoint is private and also
        // authenticated independently from the main webhook/parser secret.
        const admitted = await enqueuePersonalUpdate(store, update);
        if (!admitted) return json({ ok: true, queued: false });
        if (!paused) {
          // A settings screen is bounded; heavier actions keep their own CPU lane.
          let processed = update.action === 'settings' && update.acknowledged === true
            ? await processInboxRow(store, env, { update_id: update.update_id, user_id: update.userId, payload: JSON.stringify(update) }, now)
            : await internal(env, `/inbox/${update.update_id}`);
          for (let i=0; processed.earlier != null && i<4; i++) {
            const older = await internal(env, `/inbox/${processed.earlier}`);
            if (older.busy || older.stopped) break;
            processed = await internal(env, `/inbox/${update.update_id}`);
          }
          if (!processed.busy && !processed.stopped && processed.delivery !== false)
            context.waitUntil(deliverInteractive(env, update.userId).catch(() => {}));
        }
      } else if (path === "/week-source") {
        return json(await activateWeeklyPlan(store, await readJson(request, 320_000)));
      } else if (path === "/source-status") {
        const body = await readJson(request, 4096);
        return json({ enabled: true, known: await store.setting(`source:${String(body.id).slice(0, 100)}`) });
      } else if (path === "/catalog") {
        const body = await readJson(request, 8192);
        await mergeCatalogObservations(store, body.observations, body.seedVersion);
      } else if (path === "/begin") {
        const body = await readJson(request, 32768);
        await beginDataset(store, body);
        return json({ ok: true, maxStageSchedules: MAX_STAGE_SCHEDULES,
          catalogSeedKnown: Boolean(body.seedVersion) && await store.setting("catalog-seed-version") === body.seedVersion });
      } else if (path === "/stage") {
        const body = await readJson(request, MAX_STAGE_BYTES); await stageSchedules(store, body.id, body.schedules);
      } else if (path === "/finish") {
        const body = await readJson(request, 4096);
        const activated = await finishDataset(store, body.id);
        await store.setSetting("source-error", null);
        // Start delivery as soon as a new source is durable. Cron still recovers
        // interrupted pumps; repeated finish calls never replay a publication.
        if (activated && !paused && budget.mode === 'normal')
          context.waitUntil(kick(env, { inbox: false, delivery: true, fanout: true }).catch(() => {}));
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
        if (row && pilotAllowed(env, row.user_id)) {
          return json(await processInboxRow(store, env, row, now));
        }
      } else if (path === "/tick/fanout") {
        // One batch spans groups while fitting the existing D1 reservation.
        return json(await internal(env, '/fanout'));
      } else if (path === '/fanout') {
        if (budget.mode === 'normal' && !paused) await fanoutBatch(store);
        return json({ok:true,pending:Boolean(await store.first("SELECT 1 FROM fanout f JOIN datasets d ON d.id=f.dataset_id WHERE f.status='pending' AND d.status='ready' LIMIT 1"))});
      }
      else if (path === "/tick/due") {
        const users = await store.all("SELECT user_id FROM users WHERE paused=0 AND blocked=0 AND next_due<=? ORDER BY next_due,user_id LIMIT 8", now.getTime());
        await runUserLanes(env, users, id => `/due/${id}`, now.getTime());
        const next = await store.first("SELECT user_id FROM users WHERE paused=0 AND blocked=0 AND next_due<=? ORDER BY next_due,user_id LIMIT 1", now.getTime());
        return json({ok:true,pending:Boolean(next),advanced:Boolean(next && users.length && next.user_id !== users[0].user_id)});
      } else if (/^\/due\/\d+$/u.test(path)) {
        const id = Number(path.split('/')[2]);
        if (budget.mode === 'normal' && pilotAllowed(env, id)) {
          await deliverUser(store, new TelegramClient({ token: env.BOT_TOKEN, logger, timeoutMs: 8000 }), id,
            { now, mode: budget.mode, ownerId: env.ADMIN_USER_ID, supportDetails: env.PERSONAL_SUPPORT_DETAILS,
              clock: Date.now, catchUp: true, widgetEnabled: env.PERSONAL_WIDGET_ENABLED === "true", brandedMenu: env.PERSONAL_BRANDED_MENU === "true" });
        }
      }
      else if (path === "/tick/delivery") {
        const rows = await store.all("SELECT j.user_id FROM (SELECT user_id,priority,due FROM jobs WHERE status='pending' AND due<=?" + manualJobsOnly(budget.mode) + " ORDER BY priority,due LIMIT 128) j JOIN users u ON u.user_id=j.user_id WHERE u.blocked=0 AND u.last_api_at<=? GROUP BY j.user_id ORDER BY MIN(j.priority),MIN(j.due),MIN(u.last_api_at) LIMIT 8", now.getTime(), now.getTime() - 1050);
        await runUserLanes(env, rows, id => `/delivery/${id}?background=1`, now.getTime());
        // Skip still-cooling users without allocating their locks, intents and
        // HTTP lanes. Other subscribers can advance immediately; only a wave
        // with no eligible recipient waits for the earliest durable deadline.
        const clock = Date.now();
        const next = await store.first("SELECT CASE WHEN EXISTS(SELECT 1 FROM jobs j JOIN users u ON u.user_id=j.user_id "
          + "WHERE j.status='pending' AND j.due<=? AND u.blocked=0 AND u.last_api_at<=?" + manualJobsOnly(budget.mode) + " LIMIT 1) THEN ? "
          + "ELSE (SELECT MIN(MAX(j.due,u.last_api_at+1050)) FROM jobs j JOIN users u ON u.user_id=j.user_id "
          + "WHERE j.status='pending' AND j.due<=? AND u.blocked=0" + manualJobsOnly(budget.mode) + ") END due",
          clock, clock - 1050, clock, clock + 1200);
        return json({ ok: true, pending: next?.due != null && next.due <= Date.now() + 1200, nextDue: next?.due ?? null });
      } else if (/^\/delivery\/\d+$/u.test(path)) {
        const id = Number(path.split("/")[2]);
        if (pilotAllowed(env, id)) {
          const background = url.searchParams.get("background") === "1";
          const acquired = await deliverUser(store, new TelegramClient({ token: env.BOT_TOKEN, logger, timeoutMs: 8000 }), id,
            { now, mode: budget.mode, ownerId: env.ADMIN_USER_ID, supportDetails: env.PERSONAL_SUPPORT_DETAILS,
              clock: background ? Date.now : undefined, widgetEnabled: env.PERSONAL_WIDGET_ENABLED === "true", brandedMenu: env.PERSONAL_BRANDED_MENU === "true" });
          if (background) return json({ ok: true });
          const next = await store.first("SELECT MIN(due) due FROM jobs WHERE user_id=? AND status='pending'" + manualJobsOnly(budget.mode), id);
          return json({ ok: true, busy: acquired === false, pending: next?.due != null, nextDue: next?.due ?? null });
        }
      } else return json({ ok: false }, 404);
      return json({ ok: true });
    } catch (error) {
      return json({ ok: false, error: error instanceof InputError ? error.message : "Personal operation failed" }, error instanceof InputError ? error.status : 400);
    } finally { if (started) await store.flushBudget(now); }
  },
  async scheduled(controller, env, context) {
    if (!backgroundPolicy(new Date(controller.scheduledTime ?? Date.now())).run) return;
    context.waitUntil(internal(env, "/tick").then(async work => {
      if (work.recover) await internal(env, "/tick/recover").catch(() => {
        console.warn(JSON.stringify({ event: "personal_source_recovery_lane_error" }));
      });
      if (work.inbox || work.delivery || work.due || work.fanout) await kick(env, { inbox: Boolean(work.inbox), delivery: true, due: Boolean(work.due), fanout: Boolean(work.fanout) });
    }).catch(() => {}));
  },
};
