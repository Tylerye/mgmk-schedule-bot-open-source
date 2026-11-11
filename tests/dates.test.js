import test from "node:test";
import assert from "node:assert/strict";
import { addDays, cutoffReached, dateInTimezone, eventHasEnded, parseScheduleDate, timeInTimezone } from "../src/dates.js";

test("Minsk fixed-offset path agrees with IANA across historical transition and seasonal boundaries", () => {
  const reference = new Intl.DateTimeFormat("en", { timeZone: "Europe/Minsk", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (const utc of ["2011-03-26T23:59:00Z", "2011-03-27T00:00:00Z", "2011-10-30T00:00:00Z",
    "2026-03-29T00:59:00Z", "2026-10-25T01:01:00Z", "2026-12-31T21:00:00Z"]) {
    const now = new Date(utc);
    const parts = Object.fromEntries(reference.formatToParts(now).map(p => [p.type, p.value]));
    assert.equal(dateInTimezone(now, "Europe/Minsk"), `${parts.year}-${parts.month}-${parts.day}`);
    assert.equal(timeInTimezone(now, "Europe/Minsk"), `${parts.hour}:${parts.minute}`);
  }
});

test("production local-time conversion avoids cold ICU construction", () => {
  const original = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function () { throw new Error("cold ICU on production minute path"); };
  try {
    const now = new Date("2026-10-13T21:01:00Z");
    assert.equal(dateInTimezone(now, "Europe/Minsk"), "2026-10-14");
    assert.equal(timeInTimezone(now, "Europe/Minsk"), "00:01");
  } finally { Intl.DateTimeFormat = original; }
});

test("cached local minute follows midnight, backwards time and distinct zones", () => {
  for (const [utc, date, time] of [
    ["2026-12-31T20:59:59Z", "2026-12-31", "23:59"],
    ["2026-12-31T21:00:00Z", "2027-01-01", "00:00"],
    ["2026-12-31T20:59:00Z", "2026-12-31", "23:59"],
  ]) {
    assert.equal(dateInTimezone(new Date(utc), "Europe/Minsk"), date);
    assert.equal(timeInTimezone(new Date(utc), "Europe/Minsk"), time);
    assert.equal(timeInTimezone(new Date(utc), "UTC"), utc.slice(11, 16));
  }
});

test("extracts and validates schedule dates", () => {
  assert.equal(parseScheduleDate("15.09.26 по учащимся.pdf"), "2026-09-15");
  assert.equal(parseScheduleDate("РАСПИСАНИЕ 15.09.2026г."), "2026-09-15");
  assert.equal(parseScheduleDate("31.02.26.pdf"), null);
});
test("time comparisons use the configured IANA timezone and full schedule date", () => {
  const now = new Date("2026-09-15T13:01:00Z");
  assert.equal(dateInTimezone(now, "Europe/Minsk"), "2026-09-15");
  assert.equal(timeInTimezone(now, "Europe/Minsk"), "16:01");
  assert.equal(cutoffReached(now, "Europe/Minsk", "16:00"), true);
  assert.equal(eventHasEnded("2026-09-15", "16:00", now, "Europe/Minsk"), true);
  assert.equal(eventHasEnded("2026-09-16", "09:00", now, "Europe/Minsk"), false);
});
test("date helpers use configured timezone and cross weekends", () => {
  assert.equal(dateInTimezone(new Date("2026-09-13T21:30:00Z"), "Europe/Minsk"), "2026-09-14");
  assert.equal(addDays("2026-09-18", 3), "2026-09-21");
});
