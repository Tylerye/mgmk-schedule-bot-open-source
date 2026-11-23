const caches = new WeakMap();
const tableCount = "(SELECT COUNT(*) FROM runtime_locks)";
const durableCount = "COALESCE((SELECT rows FROM security_storage_counts WHERE name='runtime_locks')," + tableCount + ")";

function incrementAdmission(database, count, name, slot, limit) {
  return database.prepare("INSERT INTO runtime_locks(name,owner,locked_until) SELECT ?, '1', ? WHERE " + count + "<100000 "
    + "ON CONFLICT(name) DO UPDATE SET owner=CASE WHEN runtime_locks.locked_until=excluded.locked_until "
    + "THEN CAST(CAST(runtime_locks.owner AS INTEGER)+1 AS TEXT) ELSE '1' END,locked_until=excluded.locked_until "
    + "WHERE runtime_locks.locked_until<excluded.locked_until OR "
    + "(runtime_locks.locked_until=excluded.locked_until AND CAST(runtime_locks.owner AS INTEGER)<?)")
    .bind(name, slot, limit).run();
}

function positive(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid ingress limit");
  return number;
}

export async function admitInteractive(env, id, now = Date.now()) {
  let cache = caches.get(env.DB);
  if (!cache) {
    cache = new Map();
    caches.set(env.DB, cache);
  }
  const user = String(id);
  if (cache.get(user) > now) return false;
  for (const binding of ["INTERACTIVE_BURST", "INTERACTIVE_USER", "INTERACTIVE_TOTAL"]) {
    if (!env[binding]) continue;
    const subject = binding === "INTERACTIVE_TOTAL" ? "all" : user;
    const admission = await env[binding].limit({ key: `${env.WORKER_PUBLIC_ORIGIN ?? "instance"}:${subject}` });
    if (!admission.success) return false;
  }
  const rules = [
    ["all", 60, positive(env.INTERACTIVE_TOTAL_LIMIT, 120)],
    [user, 60, positive(env.INTERACTIVE_USER_LIMIT, 30)],
    [user, 10, positive(env.INTERACTIVE_BURST_LIMIT, 10)],
  ];
  let count = durableCount;
  for (const [subject, period, limit] of rules) {
    const slot = Math.floor(now / (period * 1000));
    const name = `ingress:${subject}:${period}`;
    let result;
    try {
      result = await incrementAdmission(env.DB, count, name, slot, limit);
    } catch (error) {
      // The oldest supported local databases predate the accounting table.
      const missingTable = [error?.message, error?.cause?.message].some(
        message => /no such table: (?:main\.)?security_storage_counts\b/u.test(message ?? ""),
      );
      if (count === tableCount || !missingTable) throw error;
      count = tableCount;
      result = await incrementAdmission(env.DB, count, name, slot, limit);
    }
    if (!(result.meta?.changes > 0)) {
      if (cache.size >= 4096) cache.delete(cache.keys().next().value);
      cache.set(user, (slot + 1) * period * 1000);
      return false;
    }
  }
  return true;
}
