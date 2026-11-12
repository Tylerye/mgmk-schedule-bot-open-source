import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { PersonalStore } from "../../src/personal/store.js";
import { beginDataset, stageSchedules, finishDataset, compactSchedule } from "../../src/personal/ingest.js";
import { parseAllGroupSchedules } from "../../src/personal/parse.js";

export async function personalFixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(await readFile(new URL("../../personal/migrations/0001_personal.sql", import.meta.url), "utf8"));
  for (const file of ["0002_security_limits.sql", "0003_security_accounting.sql"]) {
    sqlite.exec(await readFile(new URL("../../personal/migrations/" + file, import.meta.url), "utf8"));
  }
  const db = { prepare(sql) {
    const s = sqlite.prepare(sql); let params = [];
    return { bind(...args) { params = args; return this; },
      async all() { const results = s.all(...params); return { results, meta: { rows_read: results.length, rows_written: /^\s*(?:INSERT|UPDATE)/iu.test(sql) ? 1 : 0 } }; },
      isRead: /^\s*(?:SELECT|PRAGMA|WITH)/iu.test(sql),
      async run() { const result = s.run(...params); return { meta: { ...result, rows_written: Number(result.changes), rows_read: 1 } }; } };
  }, async batch(statements) { sqlite.exec("BEGIN"); try { const r = []; for (const s of statements) r.push(s.isRead ? await s.all() : await s.run()); sqlite.exec("COMMIT"); return r; }
    catch (e) { sqlite.exec("ROLLBACK"); throw e; } } };
  return { sqlite, db, store: new PersonalStore(db), close() { sqlite.close(); } };
}

export async function sampleSchedule(group = "8Са", date = "2026-11-12") {
  const bells = JSON.parse(await readFile(new URL("../../config/bells.json", import.meta.url)));
  const human = date.split("-").reverse().join(".");
  const rows = ["РАСПИСАНИЕ НА", `ЧЕТВЕРГ ${human}`, "¦гр.¦ур¦Предмет¦Ауд¦Преподаватель¦", `¦${group}¦1¦МАТЕМАТИКА¦245¦Иванов А А¦`,
    "¦¦8¦ФИЗИКА¦210¦Петров Б Б¦", "Зам. директора по УР________"].map(line => ({ line }));
  return compactSchedule(parseAllGroupSchedules({ source: { id: "fixture", name: `${human}.pdf` }, text: human, pageCount: 1, pages: [{ pageNumber: 1, rows }] }, { bells }).schedules[0]);
}
export async function installSchedules(store, schedules, { id = "a".repeat(64), generation = 1 } = {}) {
  await beginDataset(store, { id, date: schedules[0].date, generation, manifest: Object.fromEntries(schedules.map(s => [s.canonicalGroup, s.hash])),
    observations: schedules.map(s => ({ group: s.group, date: s.date })) });
  for (let i = 0; i < schedules.length; i += 3) await stageSchedules(store, id, schedules.slice(i, i + 3));
  await finishDataset(store, id);
}
