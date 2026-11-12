// Per-isolate memo for the read-mostly half of the personal data: published
// schedule snapshots, rendered cards, the group catalog and a few settings.
//
// Why: one tap used to cost a dozen D1 round trips just to re-read the schedule
// that changes once a day. Anything that can change per action (jobs,
// operations, users, rate gate, budgets) is deliberately NOT cached here.
//
// Every write that goes through the store invalidates the namespaces it touches
// (see invalidateForWrite), so a stale entry can only survive for its TTL, and
// only in the isolate that missed an out-of-band write.
// Keyed by the database object: two stores bound to different databases (as in
// tests, or a second personal database) never share entries.
const stores = new WeakMap();
const MAX_ENTRIES = 512;

function entriesFor(db) {
  let entries = stores.get(db);
  if (!entries) { entries = new Map(); stores.set(db, entries); }
  return entries;
}

export async function cached(db, key, ttlMs, loader) {
  const entries = entriesFor(db);
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const value = Promise.resolve().then(loader);
  entries.set(key, { at: Date.now(), ttl: ttlMs, value });
  if (entries.size > MAX_ENTRIES) {
    // Map keeps insertion order: drop the oldest key, never the newest entry.
    for (const oldest of entries.keys()) { entries.delete(oldest); break; }
  }
  try {
    return await value;
  } catch (error) {
    if (entries.get(key)?.value === value) entries.delete(key);
    throw error;
  }
}

export function invalidate(db, prefix) {
  const entries = stores.get(db);
  if (!entries) return;
  for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
}

// Map a single write statement to the cached namespaces it makes stale.
export function invalidateForWrite(db, sql, args = []) {
  const text = String(sql);
  if (!/^\s*(INSERT|UPDATE|DELETE|REPLACE)/iu.test(text)) return;
  if (/\bcards\b/iu.test(text)) { invalidate(db, "cards:"); invalidate(db, "usercards:"); }
  if (/\bcatalog\b/iu.test(text)) invalidate(db, "catalog");
  if (/\b(snapshots|active_versions|datasets)\b/iu.test(text)) invalidate(db, "sched:");
  if (/\bsettings\b/iu.test(text)) {
    const key = args[0];
    if (typeof key === "string") invalidate(db, `setting:${key}`);
    else invalidate(db, "setting:");
  }
}

export function cacheSize(db) { return stores.get(db)?.size ?? 0; }
