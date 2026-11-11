import test from "node:test";
import assert from "node:assert/strict";
import bells from "../config/bells.json" with { type: "json" };
import { buildScheduleTimeline } from "../src/schedule/timeline.js";
import { scheduleViewTimeline } from "../src/schedule/view-timeline.js";
import { formatScheduleMessage } from "../src/schedule/format.js";
import { formatDaySummary } from "../src/schedule/day.js";
import { formatNextMessage } from "../src/schedule/next.js";

function schedule(date, day) {
  return { date, hash: "unchanged", timeline: buildScheduleTimeline([1, 2, 3, 4, 5, 6].map(number => ({
    number, subject: "Предмет", rooms: ["209"], teachers: [],
  })), bells[day]) };
}

for (const [date, day, lunch, long] of [
  ["2026-10-02", "friday", "10:50–11:10", "13:00–13:40"],
  ["2026-10-01", "thursday", "11:20–11:40", "13:30–14:10"],
  ["2026-09-28", "monday", "10:50–11:10", "13:00–13:40"],
]) {
  test(`${day} has one real lunch and underlined long breaks in active and completed views`, () => {
    const value = schedule(date, day);
    const original = structuredClone(value);
    const timeline = scheduleViewTimeline(value);
    assert.equal(timeline.filter(event => event.type === "lunch").length, 1);
    assert.equal(timeline.filter(event => event.type === "large_break").length, 2);
    for (const completed of [false, true]) {
      const text = formatScheduleMessage(value, { mode: "full", completed, now: completed ? new Date(`${date}T20:00:00Z`) : null });
      assert.equal((text.match(/ОБЕД/g) ?? []).length, 1);
      assert.ok(text.includes(`<u>🍽 ОБЕД · 20 минут · ${lunch}</u>`));
      assert.ok(text.includes("<u>☕ Перемена · 10 минут · 09:55–10:05</u>"));
      assert.ok(text.includes(`<u>🌿 Большая перемена · 40 минут · ${long}</u>`));
      assert.doesNotMatch(text, /<u>🚪|✅ 🌿|✅ 🍽|<i>/);
      if (completed) assert.match(text, /<b>✅ 3 урок/);
    }
    const summary = formatDaySummary(value);
    assert.equal((summary.match(/🍽 Обед/g) ?? []).length, 1);
    assert.equal((summary.match(/Большая перемена/g) ?? []).length, 2);
    assert.equal((summary.match(/<b>/g) ?? []).length, 1);
    assert.deepEqual(value, original);
  });
}

test("next uses the same lunch and long break labels without changing lesson times", () => {
  const value = schedule("2026-10-02", "friday");
  for (const [time, label] of [["10:55", "🍽 Обед"], ["12:00", "🌿 Большая перемена"], ["13:10", "🌿 Большая перемена"]]) {
    assert.ok(formatNextMessage(value, { now: new Date(`2026-10-02T${time}:00+03:00`) }).startsWith(label));
  }
});
