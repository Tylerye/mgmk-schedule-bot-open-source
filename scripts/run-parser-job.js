import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extractPdf } from "../src/pdf/extract.js";
import { parseGroupSchedule } from "../src/schedule/parse.js";
import { parseTeacherSchedules } from "../src/schedule/teachers-parse.js";
import { downloadDriveFile } from "../src/source/drive.js";
import { createWorkerRequester } from "./worker-request.js";
import { parseAllGroupSchedules } from "../src/personal/parse.js";
import { personalFingerprint, uploadPersonalResult } from "./personal-upload.js";

const workerBaseUrl = process.env.WORKER_BASE_URL?.replace(/\/$/u, "");
const sharedSecret = process.env.PARSER_SHARED_SECRET;
const jobId = process.env.JOB_ID;
if (!workerBaseUrl || !sharedSecret || !jobId) throw new Error("WORKER_BASE_URL, PARSER_SHARED_SECRET, and JOB_ID are required");

const request = createWorkerRequester({ baseUrl: workerBaseUrl, sharedSecret });
let personalUpload = null;

async function run() {
  const job = await request(`/internal/jobs/${encodeURIComponent(jobId)}`, {}, { retryBusy: true });
  const personalEnabled = job.personalEnabled && job.source.audience === "students";
  const generation = Date.parse(job.createdAt);
  if (job.status === "complete") {
    console.log(JSON.stringify({ event: "parse_job_already_complete", jobId }));
    if (!personalEnabled) return;
    const { known, activeGeneration } = await request("/internal/personal/source-status", {
      method: "POST", body: JSON.stringify({ id: job.source.id, date: job.source.scheduleDate }),
    }, { retryBusy: true });
    if (known?.fingerprint === personalFingerprint(job.source) || (activeGeneration ?? known?.generation) > generation) return;
  }
  const bells = JSON.parse(await readFile(new URL("../config/bells.json", import.meta.url), "utf8"));
  const raw = await downloadDriveFile(job.source, { httpTimeoutMs: 30_000, httpRetries: 3 });
  const parsedPdf = await extractPdf(raw);
  const contentHash = createHash("sha256").update(raw.bytes).digest("hex");
  if (personalEnabled) {
    // Both destinations use the same extraction and have independent queues.
    // In particular, a retry on the group endpoint must not hold up Personal.
    personalUpload = Promise.resolve().then(() => uploadPersonalResult({
      result: parseAllGroupSchedules(parsedPdf, { expectedDate: job.source.scheduleDate, bells }),
      source: job.source, contentHash, generation, request,
    })).then(result => {
      console.log(JSON.stringify({ event: "personal_source_ready", groups: result.groups }));
    }).catch(async () => {
      console.warn(`::warning::Personal source deferred for ${job.source.scheduleDate}`);
      await request("/internal/personal/source-error", {
        method: "POST", body: JSON.stringify({ date: job.source.scheduleDate, generation }),
      }, { retryBusy: true }).catch(() => {});
    });
  }
  if (job.status === "complete") return;
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
    contentHash,
    detectedAt: nowIso,
    checkedAt: nowIso,
  };
  const result = await request(`/internal/jobs/${encodeURIComponent(jobId)}/result`, {
    method: "POST",
    body: JSON.stringify(teacherSchedules ? { teacherSchedules, document } : { schedule, document }),
  }, { retryBusy: true });
  console.log(JSON.stringify({ event: result.queued ? "parse_job_result_stored" : "parse_job_complete", jobId,
    date: schedule?.date ?? job.source.scheduleDate, lessons: schedule?.lessons.length, teachers: teacherSchedules?.length }));
}

try {
  await run();
} catch (error) {
  try {
    await request(`/internal/jobs/${encodeURIComponent(jobId)}/failure`, {
      method: "POST",
      body: JSON.stringify({ error: error.message }),
    });
  } catch {}
  throw error;
} finally {
  await personalUpload;
}
