import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseAllGroupSchedules } from "../src/personal/parse.js";
const bells = JSON.parse(await readFile(new URL("../config/bells.json", import.meta.url)));
function synthetic(lines, date = "12.11.26") {
  return { source: { name: `${date}.pdf` }, text: `РАСПИСАНИЕ ${date}`, pageCount: 1,
    pages: [{ pageNumber: 1, rows: ["РАСПИСАНИЕ НА", `ЧЕТВЕРГ ${date}`, "¦гр.¦ур¦Предмет¦Ауд¦Преподаватель¦", ...lines,
      "Зам. директора по УР________"].map(line => ({ line })) }] };
}

test("text statuses, wrapped cells, and subgroup notes retain all source text", () => {
  const result = parseAllGroupSchedules(synthetic(["¦1А¦¦ПРАКТИКА¦", "¦2Б¦1¦Физика¦210¦Иванов А А¦", "¦¦¦¦¦продолжение¦",
    "¦¦¦вся группа¦¦¦"]), { bells });
  assert.equal(result.publishable, true);
  assert.equal(result.schedules[0].statuses[0].text, "ПРАКТИКА");
  const l = result.schedules[1].lessons[0];
  assert.equal(l.variants[0].teacher, "Иванов А.А. продолжение");
  assert.equal(l.notes[0].text, "вся группа");
});

test("date, missing envelope, orphan rows and malformed columns block the entire publication", () => {
  const valid = ["¦1А¦1¦Физика¦210¦Иванов А А¦"];
  const pdf = synthetic(valid);
  assert.throws(() => parseAllGroupSchedules({ ...pdf, text: "13.11.26" }, { bells }), /mismatch/u);
  assert.throws(() => parseAllGroupSchedules({ ...pdf, source: { ...pdf.source, scheduleDate: "2026-11-13" } }, { bells }), /mismatch/u);
  for (const lines of [["¦¦1¦Физика¦210¦Иванов А А¦", ...valid], ["¦1А¦1¦Физика¦210¦Иванов А А¦EXTRA¦"]]) {
    const result = parseAllGroupSchedules(synthetic(lines), { bells });
    assert.equal(result.publishable, false);
    assert.ok(result.structuralErrors.length);
  }
  pdf.pages[0].rows.pop();
  assert.equal(parseAllGroupSchedules(pdf, { bells }).publishable, false);
});
