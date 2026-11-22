import { scheduleViewTimeline } from "../schedule/view-timeline.js";

const pilotGroup = "8СА";
export const hasLessonSummary = schedule => schedule.canonicalGroup === pilotGroup;
const subjects = lesson => JSON.stringify([...new Set(lesson.variants.map(v => v.subject))].sort());
const rooms = lesson => [...new Set(lesson.variants.map(v => v.room).filter(Boolean))].sort().join(" / ");

export function lessonDetailsChanges(schedule, card) {
  if (!hasLessonSummary(schedule) || !card?.schedule) return undefined;
  if (card.schedule.hash === schedule.hash) return card.parts[0]?.lessonChanges;

  const previous = new Map(scheduleViewTimeline(card.schedule).filter(e => e.type === "lesson").map(e => [e.number, e]));
  const changes = [];
  for (const lesson of scheduleViewTimeline(schedule)) {
    const old = lesson.type === "lesson" && previous.get(lesson.number);
    if (!old) continue;
    if (subjects(old) !== subjects(lesson)) continue;
    const beforeRooms = rooms(old), afterRooms = rooms(lesson);
    const beforeTime = old.start && old.end && `${old.start}–${old.end}`;
    const afterTime = lesson.start && lesson.end && `${lesson.start}–${lesson.end}`;
    const room = beforeRooms && afterRooms && beforeRooms !== afterRooms ? [beforeRooms, afterRooms] : null;
    const time = beforeTime && afterTime && beforeTime !== afterTime ? [beforeTime, afterTime] : null;
    if (room || time) changes.push({ number: lesson.number, room, time });
  }
  return changes.length ? changes : undefined;
}

export const currentLesson = (timeline, time) => timeline.find(e => e.type === "lesson" && e.start && e.end && e.start <= time && time < e.end);

export function lessonSummary(timeline, time, english) {
  const lessons = timeline.filter(e => e.type === "lesson" && e.start && e.end);
  const current = currentLesson(lessons, time);
  const next = lessons.find(e => e.start > time);
  const line = (lesson, label, timing) => {
    const places = [...new Set(lesson.variants.map(v => v.room ? `${v.subject} · ${english ? "room" : "каб."} ${v.room}` : v.subject))];
    return `${label} · ${timing} · ${places.join(" / ")}`;
  };
  return [
    ...(current ? [line(current, english ? "Now" : "Сейчас", (english ? "until " : "до ") + current.end)] : []),
    ...(next ? [line(next, english ? "Next" : "Дальше", next.start)] : []),
  ];
}
