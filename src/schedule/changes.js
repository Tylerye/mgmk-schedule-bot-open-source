function lessonsByNumber(schedule) {
  const timedLessons = (schedule?.timeline ?? []).filter((event) => event.type === "lesson");
  const lessons = timedLessons.length ? timedLessons : (schedule?.lessons ?? []);
  return new Map(lessons.map((lesson) => [Number(lesson.number), lesson]));
}

function display(value) {
  const text = Array.isArray(value) ? value.filter(Boolean).join(" / ") : String(value ?? "");
  const trimmed = text.trim();
  const characters = Array.from(trimmed);
  return trimmed ? `${characters.slice(0, 80).join("")}${characters.length > 80 ? "…" : ""}` : "—";
}

function subject(lesson) {
  return [lesson.subject, ...(lesson.subjectVariants ?? [])].filter(Boolean);
}

export function describeScheduleChanges(previous, current) {
  if (!previous || !current) return [];
  const before = lessonsByNumber(previous);
  const after = lessonsByNumber(current);
  const numbers = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left - right);
  const changes = [];

  for (const number of numbers) {
    const oldLesson = before.get(number);
    const newLesson = after.get(number);
    if (!oldLesson) {
      changes.push(`${number} урок добавлен: ${display(subject(newLesson))}`);
      continue;
    }
    if (!newLesson) {
      changes.push(`${number} урок убран: ${display(subject(oldLesson))}`);
      continue;
    }
    const from = display(subject(oldLesson));
    const to = display(subject(newLesson));
    if (from !== to) changes.push(`${number} урок: ${from} → ${to}`);
  }

  return changes;
}
