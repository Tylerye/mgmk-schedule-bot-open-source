const validTime = value => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const text = (value, max = 3000) => typeof value === "string" && value.length <= max;
const strings = value => Array.isArray(value) && value.length <= 32 && value.every(item => text(item));
function bounded(value, depth = 0) {
  if (depth > 12) return false;
  if (typeof value === "string") return text(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (value === null || typeof value === "boolean" || value === undefined) return true;
  if (Array.isArray(value)) return value.length <= 128 && value.every(item => bounded(item, depth + 1));
  return typeof value === "object" && Object.keys(value).length <= 64 && Object.entries(value).every(([key, item]) =>
    !["__proto__", "constructor", "prototype"].includes(key) && bounded(item, depth + 1));
}
function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
}
function lesson(value) {
  return value && Number.isInteger(value.number) && value.number >= 1 && value.number <= 24
    && text(value.subject) && value.subject.trim().length > 0
    && (value.subjectVariants === undefined || strings(value.subjectVariants))
    && (value.rooms === undefined || strings(value.rooms)) && (value.teachers === undefined || strings(value.teachers))
    && (value.start === undefined || validTime(value.start)) && (value.end === undefined || validTime(value.end))
    && (value.start === undefined || value.end === undefined || value.start < value.end);
}
export function validGroupResult(schedule) {
  if (!schedule || !bounded(schedule) || !validDate(schedule.date) || typeof schedule.hash !== "string"
    || !/^[a-f0-9]{64}$/.test(schedule.hash) || !Array.isArray(schedule.lessons) || schedule.lessons.length > 64
    || schedule.lessons.some(item => !lesson(item)) || new Set(schedule.lessons.map(item => item.number)).size !== schedule.lessons.length) return false;
  if (schedule.timeline !== undefined) {
    if (!Array.isArray(schedule.timeline) || schedule.timeline.some(event => !event || !validTime(event.start) || !validTime(event.end)
      || event.start >= event.end || !["lesson", "break", "large_break", "lunch", "curator_hour", "information_hour"].includes(event.type)
      || event.type === "lesson" && !lesson(event))) return false;
    const events = schedule.timeline.filter(event => event.type === "lesson");
    if (events.length !== schedule.lessons.length || schedule.lessons.some(item => !events.some(event => event.number === item.number
      && event.subject === item.subject && event.start === item.start && event.end === item.end))) return false;
  }
  return true;
}
