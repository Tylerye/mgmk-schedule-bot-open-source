// Independent recovery for the new subsystem. PDF parsing stays in Actions;
// the original group's source jobs and their delivery status are untouched.
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { listDriveFiles, inspectDriveFile, downloadDriveFile } from "../src/source/drive.js";
import { extractPdf } from "../src/pdf/extract.js";
import { parseAllGroupSchedules } from "../src/personal/parse.js";
import { createWorkerRequester } from "./worker-request.js";
import { personalFingerprint, uploadPersonalResult } from "./personal-upload.js";
import { dateInTimezone, addDays } from "../src/dates.js";

const config = await loadConfig({ dryRun: true });
const request = createWorkerRequester({ baseUrl: process.env.WORKER_BASE_URL, sharedSecret: process.env.PARSER_SHARED_SECRET });
const today = dateInTimezone(new Date(), "Europe/Minsk");
const sources = (await listDriveFiles(config)).filter(f => f.audience === "students" && f.scheduleDate >= today && f.scheduleDate <= addDays(today, 5));
for (const file of sources) {
  const source = await inspectDriveFile(file, config);
  const status = await request("/internal/personal/source-status", { method: "POST", body: JSON.stringify({ id: source.id }) });
  if (status.known?.fingerprint === personalFingerprint(source)) { console.log(JSON.stringify({ event: "personal_source_unchanged", date: source.scheduleDate })); continue; }
  const generation = Date.now();
  const raw = await downloadDriveFile(source, config);
  const result = parseAllGroupSchedules(await extractPdf(raw), { expectedDate: source.scheduleDate, bells: config.bells });
  const uploaded = await uploadPersonalResult({ result, source, generation, contentHash: createHash("sha256").update(raw.bytes).digest("hex"), request });
  console.log(JSON.stringify({ event: "personal_source_ready", date: result.date, groups: uploaded.groups }));
}
