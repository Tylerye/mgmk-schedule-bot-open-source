function timeToMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value));
  if (!match) throw new Error(`Invalid bell time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function eventDuration(event) {
  return timeToMinutes(event.end) - timeToMinutes(event.start);
}

function configuredBridge(events, previous, next) {
  return events.find((event) =>
    (event.type === "break" || event.type === "large_break" || event.type === "lunch")
    && event.start === previous.end
    && event.end === next.start,
  );
}

export function buildScheduleTimeline(lessons, dayEvents = []) {
  const lessonEvents = new Map(
    dayEvents.filter((event) => event.type === "lesson").map((event) => [event.number, event]),
  );
  const coreEvents = lessons.map((lesson) => {
    const bell = lessonEvents.get(lesson.number);
    return {
      type: "lesson",
      ...lesson,
      start: bell?.start ?? null,
      end: bell?.end ?? null,
      time: bell ? [bell.start, bell.end] : null,
    };
  });

  for (const event of dayEvents) {
    if (event.type === "curator_hour" || event.type === "information_hour") coreEvents.push({ ...event });
  }
  coreEvents.sort((left, right) => {
    const a = left.start ?? "99:99", b = right.start ?? "99:99";
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const timeline = [];
  for (const event of coreEvents) {
    const previous = timeline.at(-1);
    if (previous?.end && event.start && previous.end < event.start) {
      const configured = configuredBridge(dayEvents, previous, event);
      if (configured) {
        timeline.push({ ...configured });
      } else {
        const gap = timeToMinutes(event.start) - timeToMinutes(previous.end);
        if (gap > 0 && gap <= 30) timeline.push({ type: "break", start: previous.end, end: event.start });
      }
    }
    timeline.push(event);
  }
  return timeline;
}
