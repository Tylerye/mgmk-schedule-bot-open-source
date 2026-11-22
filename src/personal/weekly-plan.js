import { groupKey, isGroupLabel } from "./catalog.js";
import { InputError } from "../../cloudflare/request-json.js";

const KEY = "weekly:manifest";
const fingerprint = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const weekdays = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
const hours = new Set(["curator_hour", "information_hour"]);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const text = (value, max) => typeof value === "string" && value.length <= max;
const invalid = () => { throw new InputError(400, "invalid weekly plan"); };

export async function weeklySourceStatus(store) {
  const manifest = await store.setting(KEY);
  return { fingerprint: manifest?.fingerprint ?? null, groups: manifest?.groups.length ?? 0 };
}

export async function activateWeeklyPlan(store, { effectiveFrom, fingerprint: hash, previous, groups }) {
  if (!fingerprint(hash) || (previous !== null && !fingerprint(previous))
    || !/^\d{4}-\d{2}-\d{2}$/u.test(effectiveFrom) || !object(groups)) invalid();
  const entries = Object.entries(groups);
  if (!entries.length || entries.length > 75) invalid();
  const statements = [];
  const unchangedSinceCheck = "(SELECT json_extract(value,'$.fingerprint') FROM settings WHERE key='weekly:manifest') IS ?";
  const upsert = "INSERT INTO settings(key,value) SELECT ?,? WHERE " + unchangedSinceCheck
    + " ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE excluded.value IS NOT settings.value";
  for (const [id, group] of entries) {
    if (!isGroupLabel(id) || groupKey(id) !== id || !object(group)
      || !text(group.label, 24) || !object(group.days)) invalid();
    for (const [weekday, day] of Object.entries(group.days)) {
      if (!weekdays.has(weekday) || !object(day) || !Array.isArray(day.lessons) || day.lessons.length > 20
        || !Array.isArray(day.hours) || day.hours.length > 2 || day.hours.some(hour => !hours.has(hour))) invalid();
      for (const lesson of day.lessons) {
        if (!Array.isArray(lesson) || lesson.length !== 3 || !Number.isInteger(lesson[0])
          || lesson[0] < 1 || lesson[0] > 20 || !text(lesson[1], 900) || !text(lesson[2], 200)) invalid();
      }
    }
    statements.push([upsert, "weekly:" + id, JSON.stringify(group), previous]);
  }
  const manifest = { effectiveFrom, fingerprint: hash, groups: entries.map(([id]) => id) };
  // Make groups that exist only in the semester plan selectable as well.
  // Daily observations retain their existing dates and labels.
  const catalog = entries.map(([id, group]) => ({ id, label: group.label, displayName: group.label, sourceLabels: [], dates: [] }));
  statements.push(["INSERT OR IGNORE INTO catalog(id,payload) SELECT json_extract(value,'$.id'), value "
    + "FROM json_each(?) WHERE " + unchangedSinceCheck, JSON.stringify(catalog), previous]);
  statements.push([upsert, KEY, JSON.stringify(manifest), previous]);
  const results = await store.batch(statements);
  if (!results.at(-1)?.meta?.changes) {
    const status = await weeklySourceStatus(store);
    if (status.fingerprint !== hash) throw new InputError(409, "weekly source changed during sync");
    return status;
  }
  return { fingerprint: hash, groups: entries.length };
}
