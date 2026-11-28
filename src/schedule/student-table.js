const teacherWithInitials = /^[\p{L}][\p{L}'’-]*(?: [\p{L}][\p{L}'’-]*)* [А-ЯЁA-Z]\.?\s*[А-ЯЁA-Z]\.?$/u;

// The extractor projects each row onto its own monospace grid. Restore a
// missing subject/room border only between matching, aligned table rows.
export function studentTableLine(rows, index) {
  const row = rows[index];
  const line = row.line;
  if (!/^[¦|][^¦|]*[¦|]\s*\d{1,2}\s*[¦|]/u.test(line) || line.split(/[¦|]/u).length !== 6) return line;
  const above = rows[index - 1], below = rows[index + 1];
  const origin = row.items?.[0];
  if (!origin || ![above, below].every(other => other?.items?.[0]?.x === origin.x)) return line;
  const pitch = origin.width / origin.text.length;
  if (!(pitch > 0) || ![above, row, below].every(r => r.items.every(item =>
    Math.abs(item.width / item.text.length - pitch) < 0.02))) return line;
  const borders = text => Array.from(text.matchAll(/[¦|]/gu), match => match.index);
  const grid = borders(above.line);
  if (grid.length !== 6 || String(grid) !== String(borders(below.line))) return line;
  const split = grid[3];
  if (String(borders(line)) !== String(grid.filter((_, column) => column !== 3)) || line[split] !== " ") return line;
  const roomStart = split + 1 + line.slice(split + 1).search(/\S/u);
  if (!row.items.some(item => /^\d/u.test(item.text) &&
    Math.abs((item.x - origin.x) / pitch - roomStart) < 0.1)) return line;
  if (!/^\s*\d{2,4}\s*$/u.test(line.slice(split + 1, grid[4])) ||
      !teacherWithInitials.test(line.slice(grid[4] + 1, grid[5]).trim())) return line;
  return line.slice(0, split) + "¦" + line.slice(split + 1);
}

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
