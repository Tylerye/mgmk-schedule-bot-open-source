import { boundedBytes, boundedText } from "./bounded.js";
import { fetchWithRetry } from "../http.js";
import { addDays, dateInTimezone } from "../dates.js";
import { parsePublicFolderHtml, inspectDriveFile } from "./drive.js";

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
export function parseDriveFolders(html) {
  const folders = [];
  for (const row of html.matchAll(/<tr\b[^>]*data-id="([A-Za-z0-9_-]+)"[\s\S]*?<\/tr>/gu)) {
    const name = /data-tooltip="([^"]+)"/u.exec(row[0])?.[1];
    if (name && !/\.pdf(?: PDF)?$/iu.test(name)) folders.push({ id: row[1], name: name.replace(/(?: Shared folder| Папка с общим доступом| Папка| Folder)$/iu, "") });
  }
  return folders;
}

export function monthFolderName(date) {
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(2, 4)}`;
}

async function folderHtml(id, config) {
  const response = await fetchWithRetry(`https://drive.google.com/drive/folders/${encodeURIComponent(id)}`, {}, config);
  if (!response.ok) throw new Error(`Teacher Drive folder HTTP ${response.status}`);
  return boundedText(response);
}

export async function discoverTeacherFiles({ config, database, now = new Date() }) {
  const today = dateInTimezone(now, config.timezone);
  const oldest = addDays(today, -7), end = addDays(today, config.lookaheadDays);
  const root = await folderHtml(config.driveFolderId, config);
  let files = parsePublicFolderHtml(root);
  const months = [...new Set([oldest, today, end].map(monthFolderName))];
  for (const month of months) {
    const key = `month:${month}`;
    const saved = await database.prepare("SELECT value FROM teacher_settings WHERE key=?").bind(key).first();
    let monthId = saved?.value;
    if (!monthId) {
      const archive = parseDriveFolders(root).find(f => f.name.toUpperCase() === "АРХИВ");
      if (!archive) throw new Error("Teacher archive folder missing");
      const year = Number((month === monthFolderName(oldest) ? oldest : month === monthFolderName(end) ? end : today).slice(0, 4));
      const monthIndex = MONTHS.indexOf(month.split(" ")[0]);
      const startYear = monthIndex >= 8 ? year : year - 1;
      const academic = parseDriveFolders(await folderHtml(archive.id, config)).find(f => f.name === `${startYear}-${startYear + 1}`);
      if (!academic) continue;
      const found = parseDriveFolders(await folderHtml(academic.id, config)).find(f => f.name.toLowerCase() === month);
      if (!found) continue; // The next month's folder may not exist yet.
      monthId = found.id;
      await database.prepare("INSERT INTO teacher_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(key, monthId).run();
    }
    files.push(...parsePublicFolderHtml(await folderHtml(monthId, config)));
  }
  files = [...new Map(files.filter(f => f.audience === "teachers" && f.scheduleDate >= oldest && f.scheduleDate <= end).map(f => [f.id, f])).values()];
  const results = await Promise.allSettled(files.map(file => inspectDriveFile(file, config)));
  const inspected = results.filter(r => r.status === "fulfilled").map(r => r.value);
  if (files.length && !inspected.length) throw new Error("All teacher PDF metadata checks failed");
  const newest = new Map();
  for (const file of inspected) if (!newest.has(file.scheduleDate) || Date.parse(file.lastModified ?? 0) > Date.parse(newest.get(file.scheduleDate).lastModified ?? 0)) newest.set(file.scheduleDate, file);
  return [...newest.values()].sort((a, b) => a.scheduleDate > b.scheduleDate ? -1 : a.scheduleDate < b.scheduleDate ? 1 : 0);
}
