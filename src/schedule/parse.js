import { createHash } from "node:crypto";
import { dayKey, parseScheduleDate } from "../dates.js";
import { isExactGroup, looksLikeGroup, normalizeGroupName } from "../group.js";
import { buildScheduleTimeline } from "./timeline.js";

function cleanCell(value) {
  return String(value ?? "").replace(/[|¦]/g, "").replace(/\s+/g, " ").trim();
}

function parseTableLine(line) {
  if (!/[|¦]/.test(line)) return null;
  const cells = line.split(/[|¦]/).map(cleanCell);
  if (cells.length < 6) return null;
  return {
    group: cells[1] ?? "",
    lesson: cells[2] ?? "",
    subject: cells[3] ?? "",
    room: cells[4] ?? "",
    teacher: cells.slice(5).join(" ").trim(),
    rawLine: line,
  };
}

function formatTeacher(value) {
  const cleaned = cleanCell(value);
  const match = cleaned.match(/^(.+?)\s+([А-ЯЁA-Z])\s+([А-ЯЁA-Z])$/u);
  return match ? `${match[1]} ${match[2]}.${match[3]}.` : cleaned;
}

function appendContinuation(entry, row) {
  if (!entry) return;
  const subject = cleanCell(row.subject);
  const room = cleanCell(row.room);
  const teacher = formatTeacher(row.teacher);
  if (subject && subject !== entry.subject) entry.subjectVariants.push(subject);
  if (room && !entry.rooms.includes(room)) entry.rooms.push(room);
  if (teacher && !entry.teachers.includes(teacher)) entry.teachers.push(teacher);
}

export function applyBellSchedule(schedule, { bells, displayGroup = "8-Сба" }) {
  const scheduleSet = bells.previous && schedule.date < bells.effectiveFrom ? bells.previous : bells;
  const dayEvents = scheduleSet[dayKey(schedule.date)] ?? [];
  const timeline = buildScheduleTimeline(schedule.lessons, dayEvents);
  const result = {
    ...schedule,
    displayGroup,
    lessons: timeline.filter((event) => event.type === "lesson"),
    timeline,
  };
  result.hash = createHash("sha256")
    .update(JSON.stringify({ date: result.date, group: result.canonicalGroup, lessons: result.lessons, timeline: result.timeline }))
    .digest("hex");
  return result;
}

export function parseGroupSchedule(parsedPdf, { targetGroup, expectedDate, bells, displayGroup = "8-Сба" }) {
  const filenameDate = parsedPdf.source.scheduleDate ?? parseScheduleDate(parsedPdf.source.name);
  const documentDate = parseScheduleDate(parsedPdf.text);
  if (!filenameDate) throw new Error(`No schedule date in filename ${parsedPdf.source.name}`);
  if (!documentDate) throw new Error("No schedule date found inside PDF");
  if (filenameDate !== documentDate) throw new Error(`Filename/PDF date mismatch: ${filenameDate} vs ${documentDate}`);
  if (expectedDate && filenameDate !== expectedDate) throw new Error(`Unexpected schedule date: ${filenameDate}, expected ${expectedDate}`);

  let insideTarget = false;
  let foundTarget = false;
  const lessons = [];

  outer: for (const page of parsedPdf.pages) {
    for (const pdfRow of page.rows) {
      const row = parseTableLine(pdfRow.line);
      if (!row) {
        if (insideTarget && /[|¦]/.test(pdfRow.line)) {
          throw new Error(`Malformed table row in ${targetGroup}: ${pdfRow.line}`);
        }
        continue;
      }
      const groupCell = cleanCell(row.group);
      if (groupCell && looksLikeGroup(groupCell)) {
        if (isExactGroup(groupCell, targetGroup)) {
          insideTarget = true;
          foundTarget = true;
        } else if (insideTarget) {
          break outer;
        }
      }
      if (!insideTarget) continue;

      if (pdfRow.line.split(/[|¦]/).length !== 7) {
        throw new Error(`Malformed table columns in ${targetGroup}: ${pdfRow.line}`);
      }

      const numberMatch = cleanCell(row.lesson).match(/^(\d{1,2})/);
      if (!numberMatch) {
        if (cleanCell(row.lesson)) throw new Error(`Invalid lesson number in ${targetGroup}: ${row.lesson}`);
        if (!groupCell) appendContinuation(lessons.at(-1), row);
        continue;
      }
      const number = Number(numberMatch[1]);
      const subject = cleanCell(row.subject);
      if (!subject) throw new Error(`Missing subject for lesson ${number} in ${targetGroup}`);
      const room = cleanCell(row.room).replace(/\s*-\s*$/u, "");
      const teacher = formatTeacher(row.teacher);
      lessons.push({
        number,
        subject,
        subjectVariants: [],
        rooms: room ? [room] : [],
        teachers: teacher ? [teacher] : [],
        page: page.pageNumber,
      });
    }
  }

  if (!foundTarget) throw new Error(`Exact group ${targetGroup} was not found`);
  if (lessons.length === 0) throw new Error(`Group ${targetGroup} has no parseable lessons`);
  if (new Set(lessons.map((lesson) => lesson.number)).size !== lessons.length) {
    throw new Error(`Duplicate lesson numbers found for ${targetGroup}`);
  }

  const schedule = {
    date: filenameDate,
    group: targetGroup,
    canonicalGroup: normalizeGroupName(targetGroup),
    lessons,
    source: {
      id: parsedPdf.source.id,
      name: parsedPdf.source.name,
      url: parsedPdf.source.downloadUrl,
      pageCount: parsedPdf.pageCount,
    },
  };
  return applyBellSchedule(schedule, { bells, displayGroup });
}
