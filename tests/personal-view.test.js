import test from "node:test";
import assert from "node:assert/strict";
import { choosePersonalPin, renderPersonal, subjectChanges, groupsKeyboard, nextRenderAt } from "../src/personal/view.js";
import { sampleSchedule } from "./helpers/personal-fixture.js";
import { mergeCatalog } from "../src/personal/catalog.js";

test("personal pins: 16:29, 16:30, midnight, weekend, missing future and late PDF", () => {
  const cards = [{ date: "2026-11-13", messageId: 10, hasLessons: true }, { date: "2026-11-16", messageId: 20, hasLessons: true }];
  const current = { date: "2026-11-13", messageId: 10 };
  const local = (date, time) => new Date(`${date}T${time}:00+03:00`);
  assert.equal(choosePersonalPin(cards, current, local("2026-11-13", "16:29")), null);
  assert.equal(choosePersonalPin(cards, current, local("2026-11-13", "16:30")).messageId, 20);
  for (const date of ["2026-11-14", "2026-11-15", "2026-11-16"]) assert.equal(choosePersonalPin(cards, cards[1], local(date, "00:00")), null);
  assert.equal(choosePersonalPin(cards.slice(0, 1), current, local("2026-11-13", "18:00")), null);
  assert.equal(choosePersonalPin(cards, current, local("2026-11-13", "18:00")).messageId, 20);
  assert.equal(choosePersonalPin([{ ...cards[1], hasLessons: false }], current, local("2026-11-13", "18:00")), null);
});

test("RU/EN labels preserve PDF names, linked subgroups and notes; classes continue past 16:30", async () => {
  const schedule = await sampleSchedule();
  schedule.lessons[1].variants.push({ subject: "ХИМИЯ", room: "311", teacher: "Сидоров В.В." });
  schedule.timeline.find(e => e.number === 8).variants = schedule.lessons[1].variants;
  schedule.timeline.find(e => e.number === 8).notes.push({ text: "подгруппа 2" });
  schedule.timeline.splice(2, 0, { type: "lunch", start: "11:20", end: "11:40" });
  schedule.hash = "test-linked-subgroups";
  const ru = renderPersonal(schedule, { language: "ru" }, { now: new Date("2026-11-12T16:31:00+03:00") });
  assert.ok(ru.parts[0].includes("8 урок"));
  assert.ok(ru.parts[0].includes("ФИЗИКА\n🚪 Кабинет: 210\n👤 Петров Б.Б."));
  assert.ok(ru.parts[0].includes("подгруппа 2"));
  const en = renderPersonal(schedule, { language: "en" }, { mode: "full", now: new Date("2026-11-12T16:31:00+03:00") });
  assert.match(en.parts[0], /Thursday, 12 November/u);
  assert.match(en.parts[0], /✅ 1 lesson/u);
  assert.match(en.parts[0], /МАТЕМАТИКА/u);
  assert.ok(!en.parts[0].includes("329"));
  assert.match(en.parts[0], /Information period/u);
  assert.match(en.parts[0], /<u>.*LUNCH/u);
});

test("long cards split without losing source text or breaking HTML", async () => {
  const schedule = await sampleSchedule();
  const text = "<&>".repeat(800);
  schedule.timeline[0].variants = [{ subject: text, room: "1", teacher: "Преподаватель" }];
  schedule.hash = "test-long-card";
  const r = renderPersonal(schedule, { language: "ru" }, { now: new Date("2026-11-12T07:00:00+03:00") });
  assert.ok(r.parts.length > 2);
  assert.ok(r.parts.every(p => p.length < 4096));
  const combined = r.parts.join("");
  assert.equal((combined.match(/&lt;/gu) ?? []).length, 800);
  assert.equal((combined.match(/&amp;/gu) ?? []).length, 800);
  assert.equal((combined.match(/&gt;/gu) ?? []).length, 800);
  assert.ok(r.parts.every(p => (p.match(/<b>/gu) ?? []).length === (p.match(/<\/b>/gu) ?? []).length));
});

test("only subject additions/cancellations/changes alert, not room/teacher/time", async () => {
  const s = await sampleSchedule(), n = structuredClone(s);
  n.lessons[0].variants[0].room = "999"; n.lessons[0].variants[0].teacher = "Другой";
  assert.deepEqual(subjectChanges(s, n), []);
  n.lessons[0].variants[0].subject = "ХИМИЯ";
  assert.equal(subjectChanges(s, n).length, 1);
  n.lessons.pop(); assert.equal(subjectChanges(s, n).length, 2);
  assert.equal(nextRenderAt(s, new Date("2026-11-12T08:16:00+03:00")), Date.parse("2026-11-12T09:00:00+03:00"));
});

test("group selector has ten buttons per page in two columns and bounded callback data", () => {
  const groups = Array.from({ length: 51 }, (_, i) => ({ id: `${i + 1}А`, displayName: `${i + 1}А` }));
  const keyboard = groupsKeyboard(groups, { language: "en" }, 0).inline_keyboard;
  assert.equal(keyboard.slice(0, 5).flat().length, 10);
  assert.ok(keyboard.slice(0, 5).every(row => row.length === 2));
  assert.ok(keyboard.flat().every(b => Buffer.byteLength(b.callback_data) <= 64));
});

test("cold personal rendering and catalog ordering avoid ICU collation on Workers Free", async () => {
  const s = await sampleSchedule();
  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = () => { throw Error("ICU collation is not needed"); };
  try {
    const groups = mergeCatalog([], [{ group: "8Са", date: s.date }, { group: "8ТС", date: s.date }, { group: "2ТМ", date: s.date }]);
    assert.deepEqual(groups.map(g => g.id), ["2ТМ", "8СА", "8ТС"]);
    assert.ok(renderPersonal(s, { language: "en" }, { now: new Date("2026-11-12T07:00:00+03:00") }).parts.length);
    assert.ok(choosePersonalPin([{ date: s.date, messageId: 1, hasLessons: true }], null, new Date("2026-11-12T07:00:00+03:00")));
  } finally { String.prototype.localeCompare = original; }
});

test("same group/language/mode cohort shares a render, while lesson end and language invalidate it", async () => {
  const s = await sampleSchedule(), at = new Date("2026-11-12T08:59:00+03:00");
  const first = renderPersonal(s, { language: "ru", sound: 1 }, { now: at });
  assert.equal(renderPersonal(s, { language: "ru", sound: 0 }, { now: at }), first);
  assert.notEqual(renderPersonal(s, { language: "en" }, { now: at }), first);
  assert.notEqual(renderPersonal(s, { language: "ru" }, { now: new Date("2026-11-12T09:00:00+03:00") }), first);
});
