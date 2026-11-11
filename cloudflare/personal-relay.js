import { collectPersonalUpdate } from "../src/personal/update.js";

export function pilotAllowed(env, id) {
  if (env.PERSONAL_PUBLIC === "true" && Number.isSafeInteger(Number(id)) && Number(id)>0) return true;
  return [String(env.ADMIN_USER_ID), ...String(env.PERSONAL_PILOT_IDS ?? "").split(",").map(s => s.trim())].includes(String(id));
}
export async function relayPersonalUpdate(env, update, teacherAccounts = []) {
  if (env.PERSONAL_ENABLED !== "true" || !env.PERSONAL || !env.PERSONAL_SHARED_SECRET) return null;
  const collected = collectPersonalUpdate(update);
  if (!collected || !pilotAllowed(env, collected.userId)) return null;
  const from = update.callback_query?.from ?? update.message?.from;
  // The owner's existing teacher-preview /start is routed before this relay.
  // Explicit /student and personal: buttons provide an independent owner entry.
  if (String(collected.userId) !== String(env.ADMIN_USER_ID)) {
    const reserved = teacherAccounts.some(t => String(t.userId ?? "") === String(from.id)
      || (t.username && t.username.toLowerCase() === String(from.username ?? "").toLowerCase()));
    if (reserved || (env.TEACHERS_ENABLED === "true" && await env.DB.prepare("SELECT 1 FROM teacher_users WHERE user_id=?").bind(from.id).first())) return null;
  }
  const response = await env.PERSONAL.fetch("https://personal.internal/inbox", {
    method: "POST", headers: { authorization: `Bearer ${env.PERSONAL_SHARED_SECRET}`, "content-type": "application/json" }, body: JSON.stringify(collected),
  });
  if (!response.ok) return new Response(JSON.stringify({ ok: false, error: "personal inbox unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ ok: true, queued: true }), { headers: { "content-type": "application/json" } });
}

export async function relayPersonalSource(request, env, pathname) {
  if (pathname === "/internal/personal/recover") {
    if (request.method !== "POST" || env.PERSONAL_ENABLED !== "true" || !env.PERSONAL_SHARED_SECRET
      || request.headers.get("authorization") !== `Bearer ${env.PERSONAL_SHARED_SECRET}`) return new Response(null, { status: 403 });
    const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/sync-personal.yml/dispatches`, {
      method: "POST", headers: { authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "mgmk-personal-recovery" },
      body: JSON.stringify({ ref: env.GITHUB_REF || "main" }), signal: AbortSignal.timeout(10000),
    });
    return new Response(JSON.stringify({ ok: response.status === 204 }), { status: response.status === 204 ? 200 : 503 });
  }
  if (request.method !== "POST" || !env.PARSER_SHARED_SECRET || request.headers.get("authorization") !== `Bearer ${env.PARSER_SHARED_SECRET}`) return new Response(null, { status: 403 });
  if (!/^\/internal\/personal\/(catalog|begin|stage|finish|source-error|source-status|health)$/u.test(pathname)) return new Response(null, { status: 404 });
  if (env.PERSONAL_ENABLED !== "true" || !env.PERSONAL || !env.PERSONAL_SHARED_SECRET) return new Response(JSON.stringify({ enabled: false }), { status: 503 });
  return env.PERSONAL.fetch(`https://personal.internal/${pathname.split("/").at(-1)}`, {
    method: "POST", headers: { authorization: `Bearer ${env.PERSONAL_SHARED_SECRET}`, "content-type": "application/json" }, body: request.body,
  });
}
