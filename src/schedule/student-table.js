// A missing divider can leave the room in the subject cell. Only identify the
// final cell as a teacher when it looks like a name with two initials.
export function hasMergedStudentRoom(cells) {
  return cells.length === 6
    && /^\d{1,2}$/u.test(cells[2])
    && /^[\p{L}][\p{L}'’-]*(?: [\p{L}][\p{L}'’-]*)* [А-ЯЁA-Z]\.?\s*[А-ЯЁA-Z]\.?$/u.test(cells[4]);
}
