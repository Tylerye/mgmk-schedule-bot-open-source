import { boundedBytes, boundedText } from "./bounded.js";
import { parseScheduleDate } from "../dates.js";
import { fetchWithRetry } from "../http.js";

const FOLDER_BASE = "https://drive.google.com/drive/folders/";
const DOWNLOAD_BASE = "https://drive.usercontent.google.com/download";

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}
export function parsePublicFolderHtml(html) {
  const files = [];
  const seen = new Set();
  const pattern = /data-id="([A-Za-z0-9_-]{20,})"[\s\S]{0,1800}?data-tooltip="([^"]+?\.pdf) PDF"/giu;
  for (const match of html.matchAll(pattern)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const name = decodeHtml(match[2]).trim();
    files.push({
      source: "google-drive-public-folder",
      id,
      name,
      mimeType: "application/pdf",
      scheduleDate: parseScheduleDate(name),
      audience: /учащ/iu.test(name) ? "students" : /преподав/iu.test(name) ? "teachers" : "unknown",
      downloadUrl: `${DOWNLOAD_BASE}?id=${encodeURIComponent(id)}&export=download&confirm=t`,
    });
  }
  return files;
}

export async function listDriveFiles(config) {
  const response = await fetchWithRetry(`${FOLDER_BASE}${encodeURIComponent(config.driveFolderId)}`, {}, config);
  if (!response.ok) throw new Error(`Drive folder listing failed: HTTP ${response.status}`);
  const html = await boundedText(response);
  const files = parsePublicFolderHtml(html);
  if (files.length === 0) throw new Error("Drive listing returned no PDF files; page structure may have changed");
  return files;
}

export async function inspectDriveFile(file, config) {
  const response = await fetchWithRetry(file.downloadUrl, { method: "HEAD" }, config);
  if (!response.ok) throw new Error(`Drive HEAD failed for ${file.id}: HTTP ${response.status}`);
  return {
    ...file,
    contentLength: Number(response.headers.get("content-length")) || null,
    lastModified: response.headers.get("last-modified"),
    etag: response.headers.get("etag"),
    contentType: response.headers.get("content-type"),
  };
}

export function newestDriveFilesByDate(files) {
  const byDate = new Map();
  const modified = file => {
    const time = Date.parse(file.lastModified ?? "");
    return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
  };
  for (const file of files) {
    const current = byDate.get(file.scheduleDate);
    if (!current || modified(file) > modified(current)
      || (modified(file) === modified(current) && file.id > current.id)) {
      byDate.set(file.scheduleDate, file);
    }
  }
  return [...byDate.values()].sort((a, b) => a.scheduleDate < b.scheduleDate ? -1 : a.scheduleDate > b.scheduleDate ? 1 : 0);
}

export async function inspectNewestDriveFiles(files, config) {
  const results = await Promise.allSettled(files.map(file => inspectDriveFile(file, config)));
  const inspected = [];
  const failures = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") inspected.push(result.value);
    else failures.push({ file: files[index], error: result.reason });
  }
  // Failed metadata may belong to the newest PDF for its date.
  const deferredDates = new Set(failures.map(({ file }) => file.scheduleDate));
  return { sources: newestDriveFilesByDate(inspected.filter(file => !deferredDates.has(file.scheduleDate))), failures };
}

export async function downloadDriveFile(file, config) {
  const response = await fetchWithRetry(file.downloadUrl, {}, config);
  if (!response.ok) throw new Error(`Drive download failed for ${file.id}: HTTP ${response.status}`);
  const bytes = await boundedBytes(response, 20 * 1024 * 1024);
  const magic = new TextDecoder("ascii").decode(bytes.subarray(0, 5));
  if (magic !== "%PDF-") throw new Error(`File ${file.id} is not a PDF (magic ${JSON.stringify(magic)})`);
  return {
    source: file,
    bytes,
    receivedAt: new Date().toISOString(),
  };
}

export function hasSourceChanged(previous, current) {
  if (!previous) return true;
  return previous.lastModified !== current.lastModified
    || previous.contentLength !== current.contentLength
    || previous.etag !== current.etag;
}
