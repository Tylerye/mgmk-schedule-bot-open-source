import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extractPdf } from "../src/pdf/extract.js";
import { parseGroupSchedule } from "../src/schedule/parse.js";
import { parseTeacherSchedules } from "../src/schedule/teachers-parse.js";
import { downloadDriveFile } from "../src/source/drive.js";
import { createWorkerRequester } from "./worker-request.js";
import { parseAllGroupSchedules } from "../src/personal/parse.js";
import { uploadPersonalResult } from "./personal-upload.js";

const workerBaseUrl = process.env.WORKER_BASE_URL?.replace(/\/$/u, "");
const sharedSecret = process.env.PARSER_SHARED_SECRET;
const jobId = process.env.JOB_ID;
if (!workerBaseUrl || !sharedSecret || !jobId) throw new Error("WORKER_BASE_URL, PARSER_SHARED_SECRET, and JOB_ID are required");

const request = createWorkerRequester({ baseUrl: workerBaseUrl, sharedSecret });
let personalUpload = null;

try {
  const job = await request(`/internal/jobs/${encodeURIComponent(jobId)}`, {}, { retryBusy: true });
  if (job.status === "complete") {
    console.log(JSON.stringify({ event: "parse_job_already_complete", jobId }));
    process.exit(0);
  }
  const bells = JSON.parse(await readFile(new URL("../config/bells.json", import.meta.url), "utf8"));
  const raw = await downloadDriveFile(job.source, { httpTimeoutMs: 30_000, httpRetries: 3 });
  const parsedPdf = await extractPdf(raw);
  if (job.personalEnabled && job.source.audience === "students") {
    // Reuse the SAME download and extraction. A new-parser failure cannot
    // change the legacy group's publication or mark its successful job failed.
    personalUpload = async () => uploadPersonalResult({ result: parseAllGroupSchedules(parsedPdf, { expectedDate: job.source.scheduleDate, bells }),
      source: job.source, contentHash: createHash("sha256").update(raw.bytes).digest("hex"), generation: Date.parse(job.createdAt), request });
  }
  const teacherSchedules = job.source.audience === "teachers" ? parseTeacherSchedules(parsedPdf, {
    expectedDate: job.source.scheduleDate, bells,
  }) : null;
  const schedule = teacherSchedules ? null : parseGroupSchedule(parsedPdf, {
    targetGroup: process.env.GROUP_NAME || "8Са",
    displayGroup: process.env.DISPLAY_GROUP_NAME || "8-Сба",
    expectedDate: job.source.scheduleDate,
    bells,
  });
  const nowIso = new Date().toISOString();
  const document = {
    id: job.source.id,
    name: job.source.name,
    scheduleDate: job.source.scheduleDate,
    lastModified: job.source.lastModified,
    contentLength: job.source.contentLength,
    etag: job.source.etag,
    contentHash: createHash("sha256").update(raw.bytes).digest("hex"),
    detectedAt: nowIso,
    checkedAt: nowIso,
  };
  const result = await request(`/internal/jobs/${encodeURIComponent(jobId)}/result`, {
    method: "POST",
    body: JSON.stringify(teacherSchedules ? { teacherSchedules, document } : { schedule, document }),
  }, { retryBusy: true });
  console.log(JSON.stringify({ event: result.queued ? "parse_job_result_stored" : "parse_job_complete", jobId,
    date: schedule?.date ?? job.source.scheduleDate, lessons: schedule?.lessons.length, teachers: teacherSchedules?.length }));
} catch (error) {
  try {
    await request(`/internal/jobs/${encodeURIComponent(jobId)}/failure`, {
      method: "POST",
      body: JSON.stringify({ error: error.message }),
    });
  } catch {}
  throw error;
} finally {
  if (personalUpload) {
    try { const result = await personalUpload(); console.log(JSON.stringify({ event: "personal_source_ready", groups: result.groups })); }
    catch {
      console.warn(JSON.stringify({ event: "personal_source_deferred", recovery: "sync-personal workflow" }));
      try { await request("/internal/personal/source-error", { method: "POST", body: "{}" }); } catch {}
    }
  }
}
