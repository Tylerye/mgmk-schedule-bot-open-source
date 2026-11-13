import { createHash } from "node:crypto";
import { parseScheduleDate, dayKey } from "../dates.js";
import { buildScheduleTimeline } from "../schedule/timeline.js";
import { groupKey, displayGroup, isGroupLabel, mergeCatalog } from "./catalog.js";

const clean = value => String(value ?? "").replace(/\s+/gu, " ").trim();
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const border = line => /^[-+L└─┌┐┘┬┴┼]/u.test(line);
const heading = line => /^(?:РАСПИСАНИЕ|с уч[её]том|ПОНЕДЕЛЬНИК|ВТОРНИК|СРЕД[АУ]|ЧЕТВЕРГ|ПЯТНИЦ[АУ]|СУББОТ[АУ]|ВОСКРЕСЕНЬЕ)/iu.test(line);
const footer = line => /^Зам\.\s*директора/iu.test(line);
const noteText = text => /^(?:вся группа|подгрупп[аы]|примечание|\*|для |сбор |занятия |начало )/iu.test(text);

function dateOf(pdf, expectedDate) {
  const nameDate = parseScheduleDate(pdf.source.name);
  const bodyDate = parseScheduleDate(pdf.text);
  if (!nameDate || nameDate !== bodyDate || (pdf.source.scheduleDate && pdf.source.scheduleDate !== nameDate)
    || (expectedDate && expectedDate !== nameDate)) throw new Error("Student filename/PDF date mismatch");
  return nameDate;
}

function teacherName(value) {
  return clean(value).replace(/^(.+?)\s+([А-ЯЁA-Z])\s+([А-ЯЁA-Z])$/u, "$1 $2.$3.");
}

// The extractor runs once per PDF. A single traversal discovers EVERY group,
// retains every data row and its provenance, and keeps subgroup tuples linked.
// No calls to the old single-group parser and no catch-and-filter catalog.
export function parseAllGroupSchedules(pdf, { expectedDate, bells, previousCatalog = [] } = {}) {
  const date = dateOf(pdf, expectedDate);
  const groups = new Map();
  let current = null;
  let tableSeen = false;
  let footerSeen = false;
  let dataRows = 0;
  let accountedRows = 0;
  const structuralErrors = [];

  function error(message, ref) {
    if (current) current.errors.push({ message, ...ref });
    else structuralErrors.push({ message, ...ref });
  }
  function note(text, ref) {
    const entry = { text, ...ref };
    const last = current.lessons.at(-1);
    if (last) last.notes.push(entry);
    else current.notes.push(entry);
  }

  for (const page of pdf.pages) for (const [rowIndex, pdfRow] of page.rows.entries()) {
    const line = clean(pdfRow.line);
    const ref = { page: page.pageNumber, row: rowIndex + 1, raw: pdfRow.line };
    if (border(line)) continue;
    if (heading(line)) continue;
    if (footer(line)) { footerSeen = true; continue; }
    if (!/[¦|]/u.test(line)) {
      if (!line) continue;
      if (current && !footerSeen) {
        current.rows.push(ref); dataRows++; accountedRows++;
        // Unruled notes are real content in the September PDF, not decoration.
        note(line, ref);
      } else structuralErrors.push({ message: "Unrecognized text outside table", ...ref });
      continue;
    }
    if (footerSeen) { structuralErrors.push({ message: "Table data after footer", ...ref }); continue; }
    const cells = line.split(/[¦|]/u).map(clean);
    if (/^(?:No|гр\.)$/iu.test(cells[1]) || cells[3] === "Предмет") { tableSeen = true; continue; }
    if (cells.every(cell => !cell)) continue;
    const label = cells[1];
    if (label && isGroupLabel(label)) {
      const id = groupKey(label);
      if (groups.has(id) && current?.id !== id) {
        structuralErrors.push({ message: "Non-contiguous repeated group block", group: label, ...ref });
      }
      current = groups.get(id) ?? { id, group: label, date, lessons: [], notes: [], statuses: [], rows: [], errors: [] };
      groups.set(id, current);
    } else if (label && !(current && /^п\/г$/iu.test(label))) {
      structuralErrors.push({ message: "Unrecognized group column", ...ref });
      continue;
    }
    dataRows++;
    if (!current) { structuralErrors.push({ message: "Orphan table row", ...ref }); continue; }
    current.rows.push(ref);
    // Normal 5-column rows, or explicitly merged subject/room/teacher cells.
    if (![5, 7].includes(cells.length) || cells[0] || cells.at(-1)) {
      structuralErrors.push({ message: "Malformed table columns", ...ref });
      error("Malformed table columns", ref);
      continue;
    }
    const numberText = cells[2];
    const subject = cells[3];
    const room = cells.length === 7 ? cells[4] : "";
    const teacher = cells.length === 7 ? teacherName(cells[5]) : "";
    accountedRows++;
    if (!numberText) {
      if (!subject && !room && !teacher) continue;
      if (noteText(subject) && !room && !teacher) {
        note(subject, ref);
      } else if (!current.lessons.length) {
        // A text-only block can represent practice, holidays, or another status.
        current.statuses.push({ text: [subject, room, teacher].filter(Boolean).join(" — "), ...ref });
      } else if (cells.length === 5) {
        note(subject, ref);
      } else if (!subject) {
        const variant = current.lessons.at(-1).variants.at(-1);
        // Preserve a wrapped cell with the SAME tuple instead of shifting it to
        // a separate parallel array or guessing a subgroup identity.
        if (room) variant.room = clean(`${variant.room} ${room}`);
        if (teacher) variant.teacher = clean(`${variant.teacher} ${teacher}`);
        variant.continuations.push(ref);
      } else {
        current.lessons.at(-1).variants.push({ subject, room, teacher, ...ref, continuations: [] });
      }
      continue;
    }
    if (!/^\d{1,2}$/u.test(numberText) || Number(numberText) < 1) { error("Invalid lesson number", ref); continue; }
    const number = Number(numberText);
    if (!subject) { error("Missing subject", ref); continue; }
    let lesson = current.lessons.at(-1);
    if (lesson && number < lesson.number) { error("Out-of-order lesson number", ref); continue; }
    if (!lesson || lesson.number !== number) {
      lesson = { number, variants: [], notes: [] };
      current.lessons.push(lesson);
    }
    lesson.variants.push({ subject, room, teacher, ...ref, continuations: [] });
    if (/^п\/г$/iu.test(label)) lesson.notes.push({ text: label, ...ref });
  }
  if (!tableSeen || !groups.size || !footerSeen) structuralErrors.push({ message: "Incomplete student table envelope" });
  const scheduleSet = bells?.previous && date < bells.effectiveFrom ? bells.previous : bells;
  const dayEvents = scheduleSet?.[dayKey(date)] ?? [];
  const schedules = [];
  const errors = [];
  for (const group of groups.values()) {
    if (!group.lessons.length && !group.statuses.length && !group.notes.length) group.errors.push({ message: "Empty group block" });
    for (const lesson of group.lessons) if (!dayEvents.some(e => e.type === "lesson" && e.number === lesson.number)) {
      group.errors.push({ message: `Missing bell time for lesson ${lesson.number}` });
    }
    if (group.errors.length) { errors.push({ group: group.group, id: group.id, errors: group.errors }); continue; }
    const schedule = { date, group: group.group, canonicalGroup: group.id, displayGroup: displayGroup(group.group),
      lessons: group.lessons, notes: group.notes, statuses: group.statuses,
      timeline: group.lessons.length ? buildScheduleTimeline(group.lessons, dayEvents) : [],
      source: { id: pdf.source.id, name: pdf.source.name, url: pdf.source.downloadUrl, pageCount: pdf.pageCount }, rows: group.rows };
    // Source coordinates do not trigger correction notifications on PDF reflow.
    schedule.hash = hash({ date, group: group.id, lessons: group.lessons.map(l => ({ number: l.number,
      variants: l.variants.map(v => ({ subject: v.subject, room: v.room, teacher: v.teacher })), notes: l.notes.map(n => n.text) })),
      statuses: group.statuses.map(s => s.text), notes: group.notes.map(n => n.text),
      times: schedule.timeline.map(e => [e.type, e.number, e.start, e.end]) });
    schedules.push(schedule);
  }
  const observations = [...groups.values()].map(({ group }) => ({ group, date }));
  return { schemaVersion: 1, date, catalog: mergeCatalog(previousCatalog, observations), observations, schedules, errors, structuralErrors,
    coverage: { discovered: groups.size, parsed: schedules.length, dataRows, accountedRows },
    // Partial staging is inspectable but MUST NOT fan out to any subscribers.
    publishable: structuralErrors.length === 0 && errors.length === 0 && dataRows === accountedRows };
}
