import { applyBellSchedule } from "./parse.js";
import { createHash } from "node:crypto";

const revisions = new WeakMap();

export function reapplyFutureBellSchedule(state, { bells, displayGroup }) {
  if (!bells.effectiveFrom) return 0;
  let revision = revisions.get(bells);
  if (!revision) {
    revision = createHash("sha256").update(JSON.stringify(bells)).digest("hex");
    revisions.set(bells, revision);
  }
  revision += `:${displayGroup}`;
  let changed = 0;

  for (const record of Object.values(state.schedules ?? {})) {
    if (!record.schedule || record.schedule.date < bells.effectiveFrom) continue;
    const currentHash = record.scheduleHash ?? record.schedule.hash ?? record.hash;
    if (record.bellRevision === revision && record.bellScheduleHash === currentHash) continue;
    const updated = applyBellSchedule(record.schedule, { bells, displayGroup });
    record.bellRevision = revision;
    record.bellScheduleHash = updated.hash;
    if (updated.hash === currentHash) continue;

    if (record.messageId && !record.publishedSchedule && record.publishedScheduleHash === currentHash) {
      record.publishedSchedule = structuredClone(record.schedule);
    }
    record.schedule = updated;
    record.scheduleHash = updated.hash;
    changed += 1;
  }
  return changed;
}
