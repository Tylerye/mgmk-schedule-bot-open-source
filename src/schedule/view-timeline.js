import bells from "../../config/bells.json" with { type: "json" };
import { dayKey } from "../dates.js";

// The college table calls several gaps meals. For this group only the first
// designated meal (after lesson 3 / Thursday information hour) is lunch.
// Relabel views, not persisted parser hashes or historical lesson times.
export function scheduleViewTimeline(schedule) {
  const timeline = schedule.timeline ?? (schedule.lessons ?? []).map(lesson => ({
    type: "lesson", ...lesson, start: lesson.time?.[0] ?? null, end: lesson.time?.[1] ?? null,
  }));
  const table = bells.effectiveFrom && schedule.date < bells.effectiveFrom ? bells.previous : bells;
  const meal = (table?.[dayKey(schedule.date)] ?? []).find(event => event.type === "lunch");
  return timeline.map(event => event.type === "lunch" && !(event.start === meal?.start && event.end === meal?.end)
    ? { ...event, type: "large_break" } : event);
}
