const CONFUSABLES = new Map([
  ["А", "A"], ["A", "A"],
  ["С", "C"], ["C", "C"],
  ["Б", "B"], ["B", "B"],
  ["S", "C"],
]);

export function normalizeGroupName(value) {
  return String(value)
    .normalize("NFKC")
    .toLocaleUpperCase("ru-RU")
    .replace(/[\s._-]+/g, "")
    .split("")
    .map((character) => CONFUSABLES.get(character) ?? character)
    .join("");
}
export function isExactGroup(value, target) {
  return normalizeGroupName(value) === normalizeGroupName(target);
}

export function looksLikeGroup(value) {
  const normalized = String(value).normalize("NFKC").replace(/\s+/g, "");
  return /^\d{1,2}[\p{L}]{1,4}$/u.test(normalized);
}
