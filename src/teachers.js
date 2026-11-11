// Only these pilot accounts may enroll. Enrollment is permanently bound to a
// Telegram numeric ID; a recycled username cannot take over an enrolled seat.
export const TEACHERS = [
  { id: "teacher-one", name: "Примеров А. А.", username: "example_teacher_one" },
  { id: "teacher-two", name: "Учебный Б. Б.", username: "example_teacher_two" },
  { id: "teacher-three", name: "Тестовый В. В.", username: "example_teacher_three" },
];

export function teacherNameKey(value) {
  return String(value).normalize("NFKC").toUpperCase().replace(/Ё/g, "Е").replace(/[^А-ЯA-Z]/g, "");
}

export function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
