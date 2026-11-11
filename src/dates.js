const DATE_PATTERN = /(?:^|\D)(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})(?=\D|$)/;
const dateFormatters = new Map();
// Rendering a timetable asks for the same local minute dozens of times.
// Keep one result per zone, rather than repeatedly invoking ICU formatToParts.
const localMinutes = new Map();

function localMinute(now, timezone) {
  const minute = Math.floor(now.getTime() / 60_000);
  const cached = localMinutes.get(timezone);
  if (cached?.minute === minute) return cached;
  // tzdb Europe/Minsk has been fixed at UTC+03 since 2011-03-27.
  // Creating an ICU formatter on a cold isolate can alone exceed Workers Free's
  // CPU budget. Keep historical dates/other zones on the general IANA path.
  // Source: https://github.com/eggert/tz/blob/main/europe (Europe/Minsk).
  if (timezone === "UTC" || (timezone === "Europe/Minsk" && now.getTime() >= Date.UTC(2011, 2, 27))) {
    const iso = new Date(now.getTime() + (timezone === "Europe/Minsk" ? 10_800_000 : 0)).toISOString();
    const value = { minute, date: iso.slice(0, 10), time: iso.slice(11, 16) };
    localMinutes.set(timezone, value);
    return value;
  }
  if (!dateFormatters.has(timezone)) dateFormatters.set(timezone, new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }));
  const parts = Object.fromEntries(dateFormatters.get(timezone).formatToParts(now).map(part => [part.type, part.value]));
  const value = { minute, date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  localMinutes.set(timezone, value);
  return value;
}

export function parseScheduleDate(value) {
  const match = String(value).match(DATE_PATTERN);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}
export function dateInTimezone(now, timezone) {
  return localMinute(now, timezone).date;
}

export function timeInTimezone(now, timezone) {
  return localMinute(now, timezone).time;
}

export function minutesFromTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`Invalid time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function eventHasEnded(scheduleDate, endTime, now, timezone) {
  const today = dateInTimezone(now, timezone);
  if (scheduleDate !== today) return scheduleDate < today;
  return minutesFromTime(endTime) <= minutesFromTime(timeInTimezone(now, timezone));
}

export function cutoffReached(now, timezone, cutoff) {
  return minutesFromTime(timeInTimezone(now, timezone)) >= minutesFromTime(cutoff);
}

export function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function dayKey(isoDate) {
  return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][
    new Date(`${isoDate}T12:00:00Z`).getUTCDay()
  ];
}
