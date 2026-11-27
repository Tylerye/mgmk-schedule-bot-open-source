const teacherWithInitials = /^[\p{L}][\p{L}'’-]*(?: [\p{L}][\p{L}'’-]*)* [А-ЯЁA-Z]\.?\s*[А-ЯЁA-Z]\.?$/u;

export function mergedStudentRoom(cells) {
  if (cells.length !== 6 || !/^\d{1,2}$/u.test(cells[2])) return null;
  // With room and subject merged, keep the entire original subject cell.
  const trailing = cells[4];
  if (teacherWithInitials.test(trailing)) return { room: "", teacher: trailing };
  // Another real layout merges a numeric room directly with the teacher.
  const combined = trailing.match(/^(\d{2,4})\s*(\p{L}.*)$/u);
  return combined && teacherWithInitials.test(combined[2])
    ? { room: combined[1], teacher: combined[2] }
    : null;
}
