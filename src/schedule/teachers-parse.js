import { createHash } from "node:crypto";
import { parseScheduleDate, dayKey } from "../dates.js";
import { TEACHERS, teacherNameKey } from "../teachers.js";

// The teacher PDF uses a different font pitch from the student PDF. Rebuild
// from actual item widths, preserving blank columns and merged status cells.
export function teacherRowText(row) {
  const chars = [];
  const pitch = row.items.find(i => i.text === "¦" || i.text === "|")?.width
    ?? row.items[0].width / row.items[0].text.length;
  const left = Math.min(...row.items.map(i => i.x));
  for (const item of row.items) {
    const start = Math.round((item.x - left) / pitch);
    for (let i = 0; i < item.text.length; i++) chars[start + i] = item.text[i];
  }
  return Array.from({ length: chars.length }, (_, i) => chars[i] ?? " ").join("");
}

export function parseTeacherSchedules(pdf, { expectedDate, bells }) {
  const date = pdf.source.scheduleDate ?? parseScheduleDate(pdf.source.name);
  if (!date || date !== parseScheduleDate(pdf.text) || (expectedDate && date !== expectedDate))
    throw new Error("Teacher filename/PDF date mismatch");
  const result = [];
  const bellSet = bells.previous && date < bells.effectiveFrom ? bells.previous : bells;
  const times = (bellSet[dayKey(date)] ?? []).filter(e => e.type === "lesson");
  for (const teacher of TEACHERS) {
    const matches = pdf.pages.flatMap(page => page.rows.map(row => ({ row, page: page.pageNumber })))
      .filter(({ row }) => teacherNameKey(teacherRowText(row).split(/[¦|]/)[1]) === teacherNameKey(teacher.name));
    if (matches.length !== 1) throw new Error(`Expected one exact teacher row: ${teacher.name}, got ${matches.length}`);
    const { row, page } = matches[0];
    const cells = teacherRowText(row).split(/[¦|]/).slice(2, -1).map(v => v.trim());
    const notes = cells.filter(v => v && !/^\d+\s*[А-ЯA-Zа-яa-z]+$/u.test(v));
    const lessons = [];
    // Groups occupy fixed four-character cells even when text extraction joins
    // several cells into one item. Derive their coordinates from the header.
    const header = pdf.pages.flatMap(p => p.rows).find(r => /¦\s*1\s*¦\s*2\s*¦/.test(r.items.map(i => i.text).join("")));
    if (!header) throw new Error("Teacher lesson header is missing");
    const headerText = teacherRowText(header);
    const boundaries = [...headerText.matchAll(/[¦|]/g)].map(m => m.index).slice(1);
    const text = teacherRowText(row);
    for (let index = 0; index < boundaries.length - 1; index++) {
      const value = text.slice(boundaries[index] + 1, boundaries[index + 1]).trim();
      if (!value || !/^\d+\s*[А-ЯA-Zа-яa-z]+$/u.test(value)) continue;
      const number = index + 1;
      const time = times.find(e => e.number === number);
      if (!time) throw new Error(`Missing bell time for teacher lesson ${number}`);
      lessons.push({ number, group: value, start: time.start, end: time.end });
    }
    const schedule = { teacherId: teacher.id, date, lessons, status: notes.join("; ") || (lessons.length ? "" : "Занятия не указаны"),
      source: { id: pdf.source.id, name: pdf.source.name, page } };
    schedule.hash = createHash("sha256").update(JSON.stringify({ date, lessons, status: schedule.status })).digest("hex");
    result.push(schedule);
  }
  return result;
}
