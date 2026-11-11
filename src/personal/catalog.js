// Keep this catalog independent of parsing success. Only explicitly documented
// aliases change display names; legacy fuzzy matching must not merge groups.
const VISUAL = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У" };

export function groupKey(value) {
  return String(value).normalize("NFKC").toUpperCase().replace(/[\s._-]+/gu, "")
    .replace(/[ABCEHKMOPTXY]/gu, ch => VISUAL[ch]);
}

export function isGroupLabel(value) {
  return /^\d{1,3}[\p{L}]{1,6}$/u.test(String(value).replace(/\s+/gu, ""));
}

export function displayGroup(value) {
  return groupKey(value) === "8СА" ? "8-Сба" : String(value).trim();
}

export function mergeCatalog(previous = [], observations = []) {
  const groups = new Map(previous.map(group => [group.id, structuredClone(group)]));
  for (const item of observations) {
    const id = groupKey(item.group);
    if (!isGroupLabel(item.group)) throw new Error("Invalid catalog group label");
    const group = groups.get(id) ?? { id, label: item.group, displayName: displayGroup(item.group), sourceLabels: [], dates: [] };
    group.sourceLabels = [...new Set([...group.sourceLabels, item.group])];
    group.dates = [...new Set([...group.dates, item.date])].sort();
    // An error or absence in a subsequent document never removes the entry.
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => Number.parseInt(a.id, 10) - Number.parseInt(b.id, 10)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function findGroups(catalog, query) {
  const key = groupKey(query);
  return catalog.filter(g => [g.id, g.label, g.displayName, ...g.sourceLabels].some(v => groupKey(v).includes(key)));
}
